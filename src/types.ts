/**
 * Shared wire types for dsh-system-monitor.
 *
 * A sample point is the host-side unit of observation: one tick of the
 * sampler with CPU / memory / GPU metrics and the generation stage it
 * belonged to. Everything served over REST or the tool is plain JSON of
 * these shapes. Types are `type` aliases (not interfaces) so they satisfy
 * DSH's JsonValue structural constraint (implicit index signature).
 *
 * @module dsh-system-monitor/types
 */

/** Which phase of a model generation the sample fell into. */
export type Stage = 'idle' | 'prefill' | 'decode' | 'other'

export type CpuMetrics = {
  /** Overall utilization percent (0..100), averaged over cores. */
  percent: number
  /** Per-core utilization percent. */
  perCore: number[]
  cores: number
}

export type MemoryMetrics = {
  usedGb: number
  totalGb: number
  percent: number
}

/**
 * One GPU's metrics from nvidia-smi. The two orthogonal utilization numbers
 * are the core of the bottleneck diagnosis:
 *
 * - `smPercent` (`utilization.gpu`)  — SM 算力利用率（计算单元活跃占比）
 * - `memBandwidthPercent` (`utilization.memory`) — 显存带宽控制器利用率
 *   （近似显存带宽占用，NOT 显存占用！）
 *
 * 高 SM 利用率并不等于算力打满：decode 阶段 SM 大量时间在等显存返回数据，
 * 此时带宽利用率高而算力并未真正饱和 —— 这正是「GPU 占用高但算力没跑满」
 * 的可观测来源。
 */
export type GpuMetrics = {
  index: number
  name: string
  smPercent: number
  memBandwidthPercent: number
  vramUsedMb: number
  vramTotalMb: number
  /** 功耗（W）；驱动未上报时为 0 */
  powerDrawW: number
  /** 功耗上限（W）；驱动未上报时为 0 */
  powerLimitW: number
  tempC: number
  smClockMhz: number
  smClockMaxMhz: number
  memClockMhz: number
  memClockMaxMhz: number
}

export type BottleneckKind =
  | 'idle'       // 空闲
  | 'compute'    // 算力受限（SM 饱和、带宽充裕）
  | 'bandwidth'  // 带宽受限（带宽饱和、SM 等待显存）
  | 'power'      // 功耗受限（功耗接近上限）
  | 'thermal'    // 热限制（高温 + 降频）
  | 'vram'       // 显存容量瓶颈（占用接近上限）
  | 'mixed'      // 均衡 / 双高

export type Bottleneck = {
  kind: BottleneckKind
  /** 短标签（中文，供底栏徽标） */
  label: string
  /** 依据说明（中文，供 tool / 展开面板） */
  detail: string
  /** 依据：SM / 带宽 / 显存 / 功耗 / 温度 的原始读数 */
  evidence: {
    smPercent: number
    memBandwidthPercent: number
    vramUsedMb: number
    vramTotalMb: number
    powerDrawW: number
    powerLimitW: number
    tempC: number
    smClockMhz: number
    smClockMaxMhz: number
  }
}

/** One sampler tick, tagged with the generation stage it belonged to. */
export type SamplePoint = {
  ts: number
  stage: Stage
  /** 采样时进行中的生成 id（idle/other 时为 null） */
  generationId: number | null
  /** 首采样（CPU 无前值）时为 null */
  cpu: CpuMetrics | null
  memory: MemoryMetrics | null
  gpus: GpuMetrics[]
  /** nvidia-smi 不可用（无 NVIDIA 驱动/未找到） */
  gpuUnavailable: boolean
  /** 基于最活跃 GPU 的瓶颈诊断；无 GPU 数据时为 null */
  bottleneck: Bottleneck | null
}

/** One phase's aggregated stats over its samples. */
export type PhaseStats = {
  samples: number
  cpuAvg: number
  smAvg: number
  bwAvg: number
  vramUsedAvgMb: number
  powerAvgW: number
  maxSm: number
  maxBw: number
}

/**
 * One finished generation: from the model request header (prefill window)
 * through the first chunk (decode begins) to the final assistant message.
 */
export type GenerationSummary = {
  id: number
  /** 请求事件携带的 turn/step；缺失时为 null */
  turn: number | null
  step: number | null
  startedAt: number
  endedAt: number
  prefillMs: number
  decodeMs: number
  prefill: PhaseStats | null
  decode: PhaseStats | null
}

export type SnapshotResponse = {
  now: SamplePoint | null
  history: SamplePoint[]
  generations: GenerationSummary[]
}

export type Config = {
  intervalMs: number
  historySize: number
  persist: boolean
}
