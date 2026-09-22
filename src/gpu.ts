/**
 * GPU monitor: parses `nvidia-smi --query-gpu=...` CSV output. Zero npm
 * native deps — nvidia-smi ships with the driver on every NVIDIA platform
 * (Windows: System32, Linux: /usr/bin or driver path). A single query is
 * ~50ms; the sampler's busy flag drops ticks that would overlap.
 *
 * Two separate queries per tick:
 *  1. GPU-level utilization / memory / power / temp / clocks
 *  2. compute-app processes (显存占用进程，供 tool 展示；5s 节流)
 *
 * 失败恢复（自动重试，不锁死）：
 *  单次 nvidia-smi 失败不会永久置 unavailable（旧行为首败即永久锁死，
 *  驱动更新 / GPU 瞬态异常后底栏一直显示「GPU 不可用」，必须重启 DSH）。
 *  失败后进入冷却期再自动重试：
 *   - 瞬态失败（驱动瞬态、GPU 复位、超时）→ 5s 后重试；
 *   - nvidia-smi 二进制完全缺失（无 NVIDIA 驱动 / 非 NVIDIA 机器）→ 5min 后重试，
 *     避免对不存在的可执行文件高频 spawn；
 *   - 采样再次成功即清除 unavailable 并打印恢复日志。
 *
 * @module dsh-system-monitor-xg/gpu
 */

import { execFile } from 'node:child_process'
import type { GpuMetrics } from './types.ts'

const QUERY_FIELDS = [
  'index',
  'name',
  'utilization.gpu',
  'utilization.memory',
  'memory.used',
  'memory.total',
  'power.draw',
  'power.limit',
  'temperature.gpu',
  'temperature.memory',
  'clocks.sm',
  'clocks.max.sm',
  'clocks.mem',
  'clocks.max.mem',
].join(',')

const CSV_ARGS = [`--query-gpu=${QUERY_FIELDS}`, '--format=csv,noheader,nounits']
const PROCESS_ARGS = ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']

export type GpuProcess = {
  pid: number
  name: string
  usedMb: number
}

const NVSMI_CANDIDATES: readonly string[] = [
  process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\nvidia-smi.exe` : 'nvidia-smi',
  'nvidia-smi',
  '/usr/bin/nvidia-smi',
]

/** 瞬态失败（驱动异常/GPU 复位/超时/空输出）后的重试冷却。 */
export const RETRY_COOLDOWN_MS = 5_000
/** nvidia-smi 二进制完全缺失（无驱动/非 NVIDIA 机器）后的重试冷却：避免高频无谓 spawn。 */
export const MISSING_COOLDOWN_MS = 5 * 60_000

/** 失败后应用的冷却期：二进制完全缺失 → 长冷却；其余（瞬态故障）→ 短冷却。 */
export function failureCooldownMs(allMissing: boolean): number {
  return allMissing ? MISSING_COOLDOWN_MS : RETRY_COOLDOWN_MS
}

/** 是否允许发起 nvidia-smi 调用：未失败恒允许；失败状态需冷却期结束（自动重试，瞬态故障自动恢复）。 */
export function canAttemptNvidiaSmi(now: number, unavailable: boolean, lastFailAt: number, cooldownMs: number): boolean {
  if (!unavailable) return true
  return now - lastFailAt >= cooldownMs
}

interface SmiError extends Error {
  /** 所有候选路径均 ENOENT（二进制不存在，区别于驱动层失败）。 */
  allMissing?: boolean
}

function runNvidiaSmi(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const errors: string[] = []
    let attempts = 0
    let missing = 0
    const tryNext = (index: number): void => {
      if (index >= NVSMI_CANDIDATES.length) {
        const err = new Error(`nvidia-smi unavailable: ${errors.join('; ') || 'no candidate'}`) as SmiError
        err.allMissing = attempts > 0 && missing === attempts
        reject(err)
        return
      }
      attempts++
      const bin = NVSMI_CANDIDATES[index]
      execFile(bin, args, { timeout: 3000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          if (error.code === 'ENOENT') missing++
          errors.push(`${bin}: ${stderr?.trim() || error.message}`)
          tryNext(index + 1)
          return
        }
        resolve(stdout)
      })
    }
    tryNext(0)
  })
}

/**
 * Parse one "0, NVIDIA GeForce RTX 4090, 45, 88, 12480, 24564, ..." CSV row.
 *
 * `temperature.memory`（显存温度）部分驱动不暴露，nvidia-smi 回 `N/A` ——
 * 解析为 null，下游（诊断 / 展示）须容忍缺失。核心温度 `temperature.gpu`
 * 缺失按 0 处理（与既有字段一致）。
 */
function parseGpuRow(line: string, index: number): GpuMetrics {
  const cols = line.split(',').map(c => c.trim())
  const num = (i: number): number => {
    const v = Number.parseFloat(cols[i] ?? '')
    return Number.isFinite(v) ? v : 0
  }
  const tempOrNull = (i: number): number | null => {
    const v = Number.parseFloat(cols[i] ?? '')
    return Number.isFinite(v) ? v : null
  }
  return {
    index: index,
    name: cols[1] ?? `GPU ${index}`,
    smPercent: num(2),
    memBandwidthPercent: num(3),
    vramUsedMb: num(4),
    vramTotalMb: num(5),
    powerDrawW: num(6),
    powerLimitW: num(7),
    tempC: num(8),
    memTempC: tempOrNull(9),
    smClockMhz: num(10),
    smClockMaxMhz: num(11),
    memClockMhz: num(12),
    memClockMaxMhz: num(13),
  }
}

export class GpuMonitor {
  private busy = false
  private unavailable = false
  private lastFailAt = 0
  private cooldownMs = RETRY_COOLDOWN_MS
  private lastErrorMsg = ''
  private cachedProcesses: GpuProcess[] = []
  private lastProcessFetch = 0

  get isUnavailable(): boolean {
    return this.unavailable
  }

  /** 最近一次失败原因（健康时为 ''）；供 system_metrics 工具展示，免去翻日志。 */
  get lastError(): string {
    return this.lastErrorMsg
  }

  /** 冷却期内不发起 nvidia-smi 调用；冷却结束自动重试（瞬态故障自动恢复）。 */
  private canAttempt(now: number): boolean {
    return canAttemptNvidiaSmi(now, this.unavailable, this.lastFailAt, this.cooldownMs)
  }

  private noteFailure(error: unknown, now: number): void {
    this.cooldownMs = failureCooldownMs((error as SmiError | null)?.allMissing === true)
    this.lastErrorMsg = String(error)
    if (!this.unavailable) {
      // 只在 正常→不可用 转变时打日志（冷却期内的连续重试不刷屏）
      console.warn(`[dsh-system-monitor-xg] nvidia-smi 失败，${this.cooldownMs}ms 后自动重试: ${this.lastErrorMsg}`)
    }
    this.unavailable = true
    this.lastFailAt = now
  }

  private noteSuccess(): void {
    if (this.unavailable) console.log('[dsh-system-monitor-xg] nvidia-smi 已恢复')
    this.unavailable = false
    this.lastErrorMsg = ''
  }

  /** Current per-GPU metrics. Resolves [] when nvidia-smi is unavailable (冷却期内 / 重试未成功). */
  async sample(): Promise<GpuMetrics[]> {
    if (this.busy || !this.canAttempt(Date.now())) return []
    this.busy = true
    try {
      const out = await runNvidiaSmi(CSV_ARGS)
      const rows = out.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
      if (rows.length === 0) {
        // 有驱动的 nvidia-smi 至少回一行；空输出按缺失处理（无 GPU 机器 5min 重试，不再每秒 spawn）
        const err = new Error('nvidia-smi 空输出（无 GPU 或驱动异常）') as SmiError
        err.allMissing = true
        throw err
      }
      this.noteSuccess()
      return rows.map((row, i) => parseGpuRow(row, i))
    } catch (error) {
      this.noteFailure(error, Date.now())
      return []
    } finally {
      this.busy = false
    }
  }

  /** Compute-app processes (显存占用进程); throttled to once per 5s. 空进程列表是合法状态（无 compute 进程），不视为失败。 */
  async processes(): Promise<GpuProcess[]> {
    const now = Date.now()
    if (!this.canAttempt(now)) return this.cachedProcesses
    if (now - this.lastProcessFetch < 5000 && this.cachedProcesses.length > 0) return this.cachedProcesses
    this.lastProcessFetch = now
    try {
      const out = await runNvidiaSmi(PROCESS_ARGS)
      this.cachedProcesses = out.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0).map(line => {
        const [pid, name, used] = line.split(',').map(c => c.trim())
        return { pid: Number.parseInt(pid, 10) || 0, name: name ?? 'unknown', usedMb: Number.parseFloat(used ?? '0') || 0 }
      })
      this.noteSuccess()
    } catch (error) {
      this.noteFailure(error, now)
      this.cachedProcesses = []
    }
    return this.cachedProcesses
  }
}
