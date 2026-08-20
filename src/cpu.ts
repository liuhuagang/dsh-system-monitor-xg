/**
 * CPU utilization monitor: pure Node, no native deps. Overall + per-core
 * utilization is derived from the delta of `os.cpus()` tick counters between
 * two samples (the same technique psutil uses). The first call returns null
 * (no previous ticks to diff against).
 *
 * @module dsh-system-monitor/cpu
 */

import { cpus } from 'node:os'
import type { CpuMetrics } from './types.ts'

interface Tick {
  idle: number
  total: number
}

export class CpuMonitor {
  private prev: Tick[] | null = null

  /** Sample utilization since the last call. First call returns null. */
  sample(): CpuMetrics | null {
    const now = cpus().map(cpu => {
      const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
      return { idle: cpu.times.idle, total }
    })
    const prev = this.prev
    this.prev = now
    if (prev === null || prev.length !== now.length) return null
    const perCore = now.map((c, i) => {
      const totalDelta = c.total - prev[i].total
      const idleDelta = c.idle - prev[i].idle
      if (totalDelta <= 0) return 0
      const busy = 1 - idleDelta / totalDelta
      return Math.max(0, Math.min(100, busy * 100))
    })
    const percent = perCore.reduce((a, b) => a + b, 0) / perCore.length
    return { percent, perCore, cores: perCore.length }
  }
}
