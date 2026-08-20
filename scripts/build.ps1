# dsh-system-monitor-xg 构建脚本（Windows / PowerShell）
#
# 1. 定位 DSH checkout（DSH_CHECKOUT 环境变量或默认 D:\deepseek-harness）
# 2. junction 类型依赖到 node_modules（host: cordis/tools/webserver/session；
#    client: runtime/ui-slots/ui-conversation/locale + react 类型）
# 3. tsc 编译 host src → lib/（含声明 lib/types/）
# 4. tsc --noEmit 类型检查 client
# 5. tsc 生成 client 声明 lib/types/client/
# 6. tsdown 打包 client bundle → lib/client.js
# 7. 验证 host 产物可加载
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1

param(
    [string]$DSH_CHECKOUT = $env:DSH_CHECKOUT
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $DSH_CHECKOUT) { $DSH_CHECKOUT = 'D:\deepseek-harness' }
if (-not (Test-Path "$DSH_CHECKOUT\packages")) {
    throw "DSH checkout not found: $DSH_CHECKOUT (set DSH_CHECKOUT env or param)"
}
Write-Host "=== Checkout: $DSH_CHECKOUT" -ForegroundColor Cyan

$nm = Join-Path $root 'node_modules'
New-Item -ItemType Directory -Force -Path "$nm\@deepseek-ai" | Out-Null
New-Item -ItemType Directory -Force -Path "$nm\@types" | Out-Null

function Ensure-Junction {
    param([string]$Link, [string]$Target)
    if (Test-Path $Link) { return }
    if (-not (Test-Path $Target)) { Write-Warning "target missing, skip: $Target"; return }
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
    Write-Host "  junction $Link" -ForegroundColor DarkGray
}

# --- host 类型依赖 ---
Ensure-Junction "$nm\@deepseek-ai\cordis" "$DSH_CHECKOUT\vendor\cordis"
Ensure-Junction "$nm\@deepseek-ai\dsh-tools" "$DSH_CHECKOUT\packages\core\tools"
Ensure-Junction "$nm\@deepseek-ai\dsh-host-webserver" "$DSH_CHECKOUT\packages\host\webserver"
Ensure-Junction "$nm\@deepseek-ai\dsh-session" "$DSH_CHECKOUT\packages\core\session"
Ensure-Junction "$nm\@deepseek-ai\dsh-scope" "$DSH_CHECKOUT\packages\core\scope"
Ensure-Junction "$nm\@deepseek-ai\dsh-llm" "$DSH_CHECKOUT\packages\llm\llm"

# --- client 类型依赖 ---
Ensure-Junction "$nm\@deepseek-ai\dsh-client-runtime" "$DSH_CHECKOUT\packages\client\runtime"
Ensure-Junction "$nm\@deepseek-ai\dsh-client-ui-slots" "$DSH_CHECKOUT\packages\client\ui-slots"
Ensure-Junction "$nm\@deepseek-ai\dsh-client-ui-conversation" "$DSH_CHECKOUT\packages\client\ui-conversation"
Ensure-Junction "$nm\@deepseek-ai\dsh-client-locale" "$DSH_CHECKOUT\packages\client\locale"
Ensure-Junction "$nm\@deepseek-ai\dsh-client-ui-primitives" "$DSH_CHECKOUT\packages\client\ui-primitives"

# --- react（从 checkout 的 ui-primitives 解析 pnpm 嵌套） ---
$reactSrc = "$DSH_CHECKOUT\packages\client\ui-primitives\node_modules\react"
$reactDomSrc = "$DSH_CHECKOUT\packages\client\ui-primitives\node_modules\react-dom"
Ensure-Junction "$nm\react" $reactSrc
Ensure-Junction "$nm\react-dom" $reactDomSrc

# --- @types（pnpm store） ---
$pnpmDir = "$DSH_CHECKOUT\node_modules\.pnpm"
function Link-PnpmTypes {
    param([string]$Filter, [string]$Sub)
    $hit = Get-ChildItem $pnpmDir -Directory -Filter $Filter -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { Ensure-Junction "$nm\$Sub" (Join-Path (Join-Path $hit.FullName 'node_modules') $Sub) }
}
Link-PnpmTypes '@types+node@*' '@types\node'
Link-PnpmTypes '@types+react@*' '@types\react'
Link-PnpmTypes '@types+react-dom@*' '@types\react-dom'

# --- 编译 ---
$tsc = "$DSH_CHECKOUT\node_modules\.bin\tsc.cmd"
$tsdown = "$DSH_CHECKOUT\node_modules\.bin\tsdown.cmd"
if (-not (Test-Path $tsc)) { throw "tsc not found: $tsc" }
if (-not (Test-Path $tsdown)) { throw "tsdown not found: $tsdown" }

Push-Location $root
try {
    # tsdown 默认 clean（清空 lib/），因此先打包 client，再跑 tsc 写产物
    Write-Host '=== 1/4 client: tsdown bundle' -ForegroundColor Cyan
    & $tsdown
    if ($LASTEXITCODE -ne 0) { throw 'tsdown failed' }

    Write-Host '=== 2/4 host: tsc -p tsconfig.json' -ForegroundColor Cyan
    & $tsc -p tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw 'host compile failed' }

    Write-Host '=== 3/4 client: tsc --noEmit (typecheck)' -ForegroundColor Cyan
    & $tsc -p tsconfig.client.json --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'client typecheck failed' }

    Write-Host '=== 4/4 client: tsc declarations' -ForegroundColor Cyan
    & $tsc -p tsconfig.client-dts.json
    if ($LASTEXITCODE -ne 0) { throw 'client dts failed' }

    Write-Host '=== verify' -ForegroundColor Cyan
    $url = 'file:///' + ($root -replace '\\', '/') + '/lib/index.js'
    node --input-type=module -e "import('$url').then(m => console.log('host name:', m.name)).catch(e => { console.error(e); process.exit(1) })"
    if (-not (Test-Path "$root\lib\client.js")) { throw 'lib/client.js missing' }
    if (-not (Test-Path "$root\lib\types\client\index.d.ts")) { throw 'lib/types/client/index.d.ts missing' }
    Write-Host '=== build complete' -ForegroundColor Green
}
finally {
    Pop-Location
}
