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
 * @module dsh-system-monitor/gpu
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

function runNvidiaSmi(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const errors: string[] = []
    const tryNext = (index: number): void => {
      if (index >= NVSMI_CANDIDATES.length) {
        reject(new Error(`nvidia-smi unavailable: ${errors.join('; ') || 'no candidate'}`))
        return
      }
      const bin = NVSMI_CANDIDATES[index]
      execFile(bin, args, { timeout: 3000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
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

/** Parse one "12, NVIDIA GeForce RTX 4090, 45, 88, 12480, 24564, ..." CSV row. */
function parseGpuRow(line: string, index: number): GpuMetrics {
  const cols = line.split(',').map(c => c.trim())
  const num = (i: number): number => {
    const v = Number.parseFloat(cols[i] ?? '')
    return Number.isFinite(v) ? v : 0
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
    smClockMhz: num(9),
    smClockMaxMhz: num(10),
    memClockMhz: num(11),
    memClockMaxMhz: num(12),
  }
}

export class GpuMonitor {
  private busy = false
  private unavailable = false
  private cachedProcesses: GpuProcess[] = []
  private lastProcessFetch = 0

  get isUnavailable(): boolean {
    return this.unavailable
  }

  /** Current per-GPU metrics. Resolves [] when nvidia-smi is unavailable. */
  async sample(): Promise<GpuMetrics[]> {
    if (this.busy || this.unavailable) return []
    this.busy = true
    try {
      const out = await runNvidiaSmi(CSV_ARGS)
      const rows = out.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
      return rows.map((row, i) => parseGpuRow(row, i))
    } catch {
      this.unavailable = true
      return []
    } finally {
      this.busy = false
    }
  }

  /** Compute-app processes (显存占用进程); throttled to once per 5s. */
  async processes(): Promise<GpuProcess[]> {
    const now = Date.now()
    if (this.unavailable) return []
    if (now - this.lastProcessFetch < 5000 && this.cachedProcesses.length > 0) return this.cachedProcesses
    this.lastProcessFetch = now
    try {
      const out = await runNvidiaSmi(PROCESS_ARGS)
      this.cachedProcesses = out.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0).map(line => {
        const [pid, name, used] = line.split(',').map(c => c.trim())
        return { pid: Number.parseInt(pid, 10) || 0, name: name ?? 'unknown', usedMb: Number.parseFloat(used ?? '0') || 0 }
      })
    } catch {
      this.cachedProcesses = []
    }
    return this.cachedProcesses
  }
}
