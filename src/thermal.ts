/**
 * CPU temperature monitor: reads the platform's ACPI / sysfs thermal zones.
 * A slow channel decoupled from the 1s sampler (its own 5s tick + busy flag),
 * latest value cached and attached to every sample point by the Sampler.
 *
 * Sources:
 *  - Windows: WMI `root/wmi:MSAcpi_ThermalZoneTemperature`（CurrentReading 为
 *    0.1℃ 单位），取全部热区均值；经 `powershell -NoProfile` 启动查询
 *    （启动开销约 0.5s，故 5s 节流）。`root/wmi` 命名空间常被机器策略限制
 *    为仅管理员可读：拒绝访问（退出码 3）按环境问题处理，5min 冷却，
 *    DSH 以管理员运行后自动恢复。
 *  - Linux: /sys/class/thermal 下 thermal_zone* 的 {type, temp}（毫摄氏度），
 *    优先选 type 含 cpu/pkg/soc 的热区，否则取最热区（WSL2 下只有 acpitz
 *    通用热区时回退到最热区）。
 *  - 其他平台（macOS 等）：无可用传感器，latest() 恒为 null，不产生任何 spawn。
 *
 * 失败语义与 GpuMonitor 一致：缓存最后一次成功值；失败进冷却
 * （瞬态 5s / 环境 5min）；仅正常→不可用转变时打日志。
 *
 * @module dsh-system-monitor-xg/thermal
 */

import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** CPU 温度轮询间隔（慢通道；WMI 查询含 powershell 启动约 0.5s，1s 会占掉半个核）。 */
export const CPU_TEMP_POLL_MS = 5_000
/** 瞬态失败（WMI 查询出错 / 超时）后的重试冷却。 */
export const THERMAL_RETRY_MS = 5_000
/** 环境性失败（无热区 / WMI 拒绝访问 / powershell 缺失）后的重试冷却。 */
export const THERMAL_UNAVAILABLE_COOLDOWN_MS = 5 * 60_000

/**
 * PowerShell 查询脚本（Windows PowerShell 5.1，-Command 整串执行）：
 * 输出 MSAcpi_ThermalZoneTemperature 全部热区 CurrentReading 的均值（℃，1 位小数）。
 * 退出码契约：0 = 成功（stdout 为温度）/ 1 = 瞬态 WMI 错误 /
 * 2 = 无热区 / 3 = root/wmi 拒绝访问。
 * 拒绝访问的判定不用 HResult 常量（PS 5.1 的 Get-CimInstance 把命名空间拒绝
 * 包装成 CimException 0x80131501，与经典 0x80041003 不一致）：改看错误类别
 * PermissionDenied（本地化无关），再兜底 FullyQualifiedErrorId 里的 HRESULT。
 */
const WMI_TEMP_SCRIPT = [
  'try {',
  '  $z = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop)',
  '  if ($z.Count -eq 0) { exit 2 }',
  '  Write-Output ([math]::Round((($z | Measure-Object -Property CurrentReading -Average).Average) / 10, 1))',
  '  exit 0',
  '} catch {',
  '  $denied = ($null -ne $_.CategoryInfo -and $_.CategoryInfo.Category -eq \'PermissionDenied\')',
  '  if (-not $denied -and $_.FullyQualifiedErrorId -match \'0x80131501|0x80041003\') { $denied = $true }',
  '  if ($denied) { exit 3 }',
  '  exit 1',
  '}',
].join('\n')

const POWERSHELL_CANDIDATES: readonly string[] = [
  process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell',
  'powershell',
]

type ProbeResult = {
  /** 0 成功；1/2/3 脚本退出码；4 = powershell 缺失（模拟 ENOENT）；null = 超时/其他 spawn 错误 */
  exitCode: number | null
  stdout: string
}

/** 逐个候选路径启动 powershell（与 gpu.ts 的 nvidia-smi 候选逻辑一致）。 */
function runPowerShell(script: string): Promise<ProbeResult> {
  return new Promise(resolve => {
    let attempts = 0
    let missing = 0
    const tryNext = (index: number): void => {
      if (index >= POWERSHELL_CANDIDATES.length) {
        resolve({ exitCode: attempts > 0 && missing === attempts ? 4 : null, stdout: '' })
        return
      }
      attempts++
      const bin = POWERSHELL_CANDIDATES[index]
      execFile(bin, ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        if (error) {
          const code = (error as { code?: unknown }).code
          if (code === 'ENOENT') {
            missing++
            tryNext(index + 1)
            return
          }
          resolve({ exitCode: typeof code === 'number' ? code : null, stdout: '' })
          return
        }
        resolve({ exitCode: 0, stdout: String(stdout) })
      })
    }
    tryNext(0)
  })
}

/** 解析 PowerShell 成功时输出的温度（℃）；空 / 非数值 → null。 */
export function parseThermalStdout(stdout: string): number | null {
  const v = Number.parseFloat(stdout.trim())
  return Number.isFinite(v) ? v : null
}

/**
 * 失败后应用的冷却期：exit 2（无热区）/ 3（拒绝访问）/ 4（powershell 缺失）
 * 是环境性问题，短期重试不会恢复 → 长冷却；exit 1 / null（超时/瞬态）→ 短冷却。
 */
export function thermalFailureCooldown(exitCode: number | null): number {
  if (exitCode === 2 || exitCode === 3 || exitCode === 4) return THERMAL_UNAVAILABLE_COOLDOWN_MS
  return THERMAL_RETRY_MS
}

/** sysfs 原始读数换算：>1000 视为毫摄氏度（x86_pkg_temp 等常见驱动），否则已是摄氏度。 */
export function zoneTempC(raw: number): number {
  return raw > 1000 ? raw / 1000 : raw
}

/** 优先选 CPU 热区（type 含 cpu/pkg/soc，忽略大小写），否则取最热区；空列表 → null。 */
export function selectCpuZone(zones: Array<{ type: string; tempC: number }>): number | null {
  if (zones.length === 0) return null
  const hit = zones.find(z => /cpu|pkg|soc/i.test(z.type))
  return hit !== undefined ? hit.tempC : Math.max(...zones.map(z => z.tempC))
}

export class CpuThermalMonitor {
  private tempC: number | null = null
  private busy = false
  private unavailable = false
  private lastFailAt = 0
  private cooldownMs = THERMAL_RETRY_MS
  private lastErrorMsg = ''
  private timer: NodeJS.Timeout | null = null
  private readonly unsupported = process.platform !== 'win32' && process.platform !== 'linux'

  get isUnavailable(): boolean {
    return this.unavailable
  }

  /** 最近一次失败原因（健康时为 ''）；供 system_metrics 工具回答「为什么没有 CPU 温度」。 */
  get lastError(): string {
    return this.lastErrorMsg
  }

  /** 最新已知温度（℃）；null = 平台无传感器 / 尚未成功采样。 */
  latest(): number | null {
    return this.tempC
  }

  /** 启动 5s 轮询（立即首采）；不支持的平台打一行日志后返回。随插件 fiber dispose 一并停止。 */
  start(intervalMs: number): void {
    if (this.unsupported) {
      console.log(`[dsh-system-monitor-xg] CPU 温度：平台 ${process.platform} 无可用传感器，跳过采样`)
      return
    }
    const poll = (): void => { void this.poll() }
    this.timer = setInterval(poll, intervalMs)
    poll()
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** 冷却期内不发起查询；冷却结束自动重试（瞬态故障自动恢复）。 */
  private canAttempt(now: number): boolean {
    if (!this.unavailable) return true
    return now - this.lastFailAt >= this.cooldownMs
  }

  private noteSuccess(value: number): void {
    if (this.unavailable) console.log(`[dsh-system-monitor-xg] CPU 温度已恢复: ${value.toFixed(1)}℃`)
    this.unavailable = false
    this.lastErrorMsg = ''
    this.tempC = value
  }

  private noteFailure(message: string, now: number, exitCode: number | null): void {
    this.cooldownMs = thermalFailureCooldown(exitCode)
    this.lastErrorMsg = message
    if (!this.unavailable) {
      // 只在 正常→不可用 转变时打日志（冷却期内的连续重试不刷屏）
      console.warn(`[dsh-system-monitor-xg] CPU 温度不可用（${this.cooldownMs}ms 后自动重试）: ${message}`)
    }
    this.unavailable = true
    this.lastFailAt = now
  }

  private async poll(): Promise<void> {
    if (this.busy || !this.canAttempt(Date.now())) return
    this.busy = true
    try {
      if (process.platform === 'win32') {
        const { exitCode, stdout } = await runPowerShell(WMI_TEMP_SCRIPT)
        const now = Date.now()
        if (exitCode === 0) {
          const v = parseThermalStdout(stdout)
          if (v !== null) {
            this.noteSuccess(v)
            return
          }
          this.noteFailure('WMI 查询成功但温度输出为空', now, 1)
          return
        }
        const reason = exitCode === 3
          ? 'WMI root/wmi 拒绝访问（需以管理员权限运行 DSH，或放宽机器 WMI 命名空间策略）'
          : exitCode === 2
            ? '无 ACPI 热区（MSAcpi_ThermalZoneTemperature 为空）'
            : exitCode === 4
              ? 'powershell.exe 缺失'
              : 'WMI 查询失败（瞬态错误或超时）'
        this.noteFailure(reason, now, exitCode)
        return
      }
      this.pollLinux()
    } finally {
      this.busy = false
    }
  }

  private pollLinux(): void {
    let dirs: string[]
    try {
      dirs = readdirSync('/sys/class/thermal').filter(d => d.startsWith('thermal_zone'))
    } catch {
      this.noteFailure('/sys/class/thermal 不可读（容器或无热管理子系统）', Date.now(), 2)
      return
    }
    const zones: Array<{ type: string; tempC: number }> = []
    for (const dir of dirs) {
      let type = ''
      let raw = NaN
      try { type = readFileSync(join('/sys/class/thermal', dir, 'type'), 'utf8').trim() } catch { /* 部分热区无 type */ }
      try { raw = Number.parseInt(readFileSync(join('/sys/class/thermal', dir, 'temp'), 'utf8').trim(), 10) } catch { /* 跳过无 temp 的热区 */ }
      if (Number.isFinite(raw)) zones.push({ type, tempC: zoneTempC(raw) })
    }
    const v = selectCpuZone(zones)
    if (v !== null) {
      this.noteSuccess(v)
    } else {
      this.noteFailure('/sys/class/thermal 下无可读 thermal_zone*/temp', Date.now(), 2)
    }
  }
}
