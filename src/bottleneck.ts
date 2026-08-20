/**
 * Bottleneck diagnosis: pure function over one GPU sample.
 *
 * 核心思想：`smPercent`（算力）与 `memBandwidthPercent`（显存带宽）是两个
 * 正交的利用率轴。GPU 占用高 ≠ 算力打满 —— decode 阶段 SM 大量时间停在
 * 等待显存返回数据，表现为带宽利用率高而算力并未真正饱和。诊断顺序：
 *
 *   idle → 显存容量 → 热限制 → 功耗墙 → 带宽受限 → 算力受限 → 均衡
 *
 * 判据（阈值可后续做成配置）：
 *   - 空闲：SM 与带宽都 < 15%
 *   - 显存瓶颈：显存占用 > 95%
 *   - 热限制：温度 ≥ 88℃，或 ≥ 80℃ 且 SM 时钟掉到 < 92% max
 *   - 功耗受限：功耗 ≥ 98% 上限
 *   - 带宽受限：带宽 ≥ 80%（SM 较低 = 典型 decode 等待；SM 双高 = 逼近极限）
 *   - 算力受限：SM ≥ 80% 且带宽 < 60%（典型 prefill）
 *
 * @module dsh-system-monitor-xg/bottleneck
 */

import type { Bottleneck, GpuMetrics } from './types.ts'

export const KIND_LABELS: Record<string, string> = {
  idle: '空闲',
  compute: '算力受限',
  bandwidth: '带宽受限',
  power: '功耗受限',
  thermal: '热限制',
  vram: '显存瓶颈',
  mixed: '均衡负载',
}

function evidence(g: GpuMetrics): Bottleneck['evidence'] {
  return {
    smPercent: g.smPercent,
    memBandwidthPercent: g.memBandwidthPercent,
    vramUsedMb: g.vramUsedMb,
    vramTotalMb: g.vramTotalMb,
    powerDrawW: g.powerDrawW,
    powerLimitW: g.powerLimitW,
    tempC: g.tempC,
    smClockMhz: g.smClockMhz,
    smClockMaxMhz: g.smClockMaxMhz,
  }
}

/** Diagnose one GPU sample. */
export function diagnose(g: GpuMetrics): Bottleneck {
  const ev = evidence(g)
  const sm = g.smPercent
  const bw = g.memBandwidthPercent
  const vramRatio = g.vramTotalMb > 0 ? g.vramUsedMb / g.vramTotalMb : 0
  const powerRatio = g.powerLimitW > 0 ? g.powerDrawW / g.powerLimitW : 0
  const clockRatio = g.smClockMaxMhz > 0 ? g.smClockMhz / g.smClockMaxMhz : 1

  if (sm < 20 && bw < 15) {
    return { kind: 'idle', label: KIND_LABELS.idle, detail: `SM ${sm.toFixed(0)}% · 带宽 ${bw.toFixed(0)}%，GPU 空闲`, evidence: ev }
  }
  if (vramRatio > 0.95) {
    return {
      kind: 'vram', label: KIND_LABELS.vram,
      detail: `显存 ${(g.vramUsedMb / 1024).toFixed(1)}G/${(g.vramTotalMb / 1024).toFixed(0)}G（${(vramRatio * 100).toFixed(0)}%）接近上限，上下文/批大小受限`,
      evidence: ev,
    }
  }
  if (g.tempC >= 88 || (g.tempC >= 80 && clockRatio < 0.92)) {
    return {
      kind: 'thermal', label: KIND_LABELS.thermal,
      detail: `温度 ${g.tempC.toFixed(0)}℃ · SM 时钟 ${g.smClockMhz.toFixed(0)}/${g.smClockMaxMhz.toFixed(0)} MHz，已降频`,
      evidence: ev,
    }
  }
  if (powerRatio >= 0.98) {
    return {
      kind: 'power', label: KIND_LABELS.power,
      detail: `功耗 ${g.powerDrawW.toFixed(0)}W/${g.powerLimitW.toFixed(0)}W，撞功耗墙`,
      evidence: ev,
    }
  }
  if (bw >= 80 && sm < 60) {
    return {
      kind: 'bandwidth', label: KIND_LABELS.bandwidth,
      detail: `带宽 ${bw.toFixed(0)}% · SM ${sm.toFixed(0)}%：算力在等显存数据，典型 decode 阶段`,
      evidence: ev,
    }
  }
  if (bw >= 75 && sm >= 60) {
    return {
      kind: 'bandwidth', label: KIND_LABELS.bandwidth,
      detail: `SM ${sm.toFixed(0)}% × 带宽 ${bw.toFixed(0)}% 双高，接近带宽/算力极限`,
      evidence: ev,
    }
  }
  if (sm >= 80 && bw < 60) {
    return {
      kind: 'compute', label: KIND_LABELS.compute,
      detail: `SM ${sm.toFixed(0)}% · 带宽 ${bw.toFixed(0)}%：计算单元饱和，典型 prefill 阶段`,
      evidence: ev,
    }
  }
  return {
    kind: 'mixed', label: KIND_LABELS.mixed,
    detail: `SM ${sm.toFixed(0)}% · 带宽 ${bw.toFixed(0)}%，负载均衡`,
    evidence: ev,
  }
}

/** Pick the most active GPU (max SM + bandwidth) for the bar diagnosis. */
export function diagnoseMostActive(gpus: readonly GpuMetrics[]): Bottleneck | null {
  if (gpus.length === 0) return null
  let best = gpus[0]
  let bestScore = -1
  for (const g of gpus) {
    const score = g.smPercent + g.memBandwidthPercent
    if (score > bestScore) {
      bestScore = score
      best = g
    }
  }
  return diagnose(best)
}
