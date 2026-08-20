#!/usr/bin/env bash
# dsh-system-monitor 构建脚本（POSIX 版；Windows 开发者用 scripts/build.ps1）。
#
# 1. 定位 DSH checkout（DSH_CHECKOUT 环境变量，或常见路径探测）
# 2. 符号链接类型依赖到 node_modules（host: cordis/tools/webserver/session；
#    client: runtime/ui-slots/ui-conversation/locale + react 类型）
# 3. tsdown 打包 client bundle → lib/client.js（tsdown 默认 clean，先跑）
# 4. tsc 编译 host src → lib/（含声明 lib/types/）
# 5. tsc --noEmit 类型检查 client；tsc 生成 client 声明 lib/types/client/
# 6. 验证 host 产物可加载
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  for cand in \
    "$HOME/deepseek-harness" \
    "$HOME/Documents/deepseek-harness" \
    "$HOME/dsh" \
    "/opt/deepseek-harness"; do
    if [ -d "$cand/packages" ]; then CHECKOUT="$cand"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the DSH checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi
echo "=== Checkout: $CHECKOUT ==="

TSC="$CHECKOUT/node_modules/.bin/tsc"
TSDOWN="$CHECKOUT/node_modules/.bin/tsdown"
if [ ! -x "$TSC" ]; then echo "build: tsc not found at $TSC" >&2; exit 1; fi
if [ ! -x "$TSDOWN" ]; then echo "build: tsdown not found at $TSDOWN" >&2; exit 1; fi

NM="$ROOT/node_modules"
mkdir -p "$NM/@deepseek-ai" "$NM/@types"

link_dir() {
  local link="$1" target="$2"
  if [ -e "$link" ]; then return 0; fi
  if [ ! -e "$target" ]; then echo "build: dependency target missing: $target" >&2; return 1; fi
  mkdir -p "$(dirname "$link")"
  ln -s "$target" "$link"
  echo "  link $link"
}

# host 类型依赖
link_dir "$NM/@deepseek-ai/cordis" "$CHECKOUT/vendor/cordis"
link_dir "$NM/@deepseek-ai/dsh-tools" "$CHECKOUT/packages/core/tools"
link_dir "$NM/@deepseek-ai/dsh-host-webserver" "$CHECKOUT/packages/host/webserver"
link_dir "$NM/@deepseek-ai/dsh-session" "$CHECKOUT/packages/core/session"
link_dir "$NM/@deepseek-ai/dsh-scope" "$CHECKOUT/packages/core/scope"
link_dir "$NM/@deepseek-ai/dsh-llm" "$CHECKOUT/packages/llm/llm"

# client 类型依赖
link_dir "$NM/@deepseek-ai/dsh-client-runtime" "$CHECKOUT/packages/client/runtime"
link_dir "$NM/@deepseek-ai/dsh-client-ui-slots" "$CHECKOUT/packages/client/ui-slots"
link_dir "$NM/@deepseek-ai/dsh-client-ui-conversation" "$CHECKOUT/packages/client/ui-conversation"
link_dir "$NM/@deepseek-ai/dsh-client-locale" "$CHECKOUT/packages/client/locale"
link_dir "$NM/@deepseek-ai/dsh-client-ui-primitives" "$CHECKOUT/packages/client/ui-primitives"

# react（checkout 的 pnpm 嵌套）
link_dir "$NM/react" "$CHECKOUT/packages/client/ui-primitives/node_modules/react"
link_dir "$NM/react-dom" "$CHECKOUT/packages/client/ui-primitives/node_modules/react-dom"

# @types（pnpm store）
link_pnpm_types() {
  local filter="$1" sub="$2" hit
  hit="$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -name "$filter" 2>/dev/null | head -1)"
  if [ -n "$hit" ]; then link_dir "$NM/$sub" "$hit/node_modules/$sub"; fi
}
link_pnpm_types '@types+node@*' '@types/node'
link_pnpm_types '@types+react@*' '@types/react'
link_pnpm_types '@types+react-dom@*' '@types/react-dom'

echo "=== 1/4 client: tsdown bundle ==="
"$TSDOWN"

echo "=== 2/4 host: tsc ==="
"$TSC" -p tsconfig.json

echo "=== 3/4 client: tsc --noEmit ==="
"$TSC" -p tsconfig.client.json --noEmit

echo "=== 4/4 client: tsc declarations ==="
"$TSC" -p tsconfig.client-dts.json

echo "=== verify ==="
node --input-type=module -e "import('file://$ROOT/lib/index.js').then(m => console.log('host name:', m.name))"
[ -f "$ROOT/lib/client.js" ] || { echo "lib/client.js missing" >&2; exit 1; }
[ -f "$ROOT/lib/types/client/index.d.ts" ] || { echo "lib/types/client/index.d.ts missing" >&2; exit 1; }
echo "=== build complete ==="
