/**
 * Synchronous XHR fetch helpers.
 *
 * 社区踩坑结论（dsh-status-bar ChartCard）：DSH web 的浏览器环境会随机
 * stall 异步 fetch/XHR 响应（webserver 5s keep-alive 留下半开 socket 时，
 * 池化请求会无限挂起），因此高频轮询必须用同步 XHR + cache-busting。
 * 本地回环响应 <10ms，同步阻塞可忽略。
 *
 * @module dsh-system-monitor-xg/client/fetch
 */

export interface CpuMetrics { percent: number; perCore: number[]; cores: number }
export interface MemoryMetrics { usedGb: number; totalGb: number; percent: number }
export interface GpuMetrics {
  index: number
  name: string
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
export interface Bottleneck {
  kind: 'idle' | 'compute' | 'bandwidth' | 'power' | 'thermal' | 'vram' | 'mixed'
  label: string
  detail: string
}
export interface SamplePoint {
  ts: number
  stage: 'idle' | 'prefill' | 'decode' | 'other'
  generationId: number | null
  cpu: CpuMetrics | null
  memory: MemoryMetrics | null
  gpus: GpuMetrics[]
  gpuUnavailable: boolean
  bottleneck: Bottleneck | null
}
export interface PhaseStats {
  samples: number
  cpuAvg: number
  smAvg: number
  bwAvg: number
  vramUsedAvgMb: number
  powerAvgW: number
  maxSm: number
  maxBw: number
}
export interface GenerationSummary {
  id: number
  startedAt: number
  endedAt: number
  prefillMs: number
  decodeMs: number
  prefill: PhaseStats | null
  decode: PhaseStats | null
}

export interface SnapshotResponse {
  now: SamplePoint | null
  history: SamplePoint[]
  generations: GenerationSummary[]
}

function getSync(path: string): unknown {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', `${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`, false)
  xhr.send(null)
  if (xhr.status !== 200) return null
  return JSON.parse(xhr.responseText) as unknown
}

/** Latest sample only (the 1s bar poll). */
export function fetchSnapshotSync(): SamplePoint | null {
  try {
    const body = getSync('/system-monitor/api/snapshot?light=1') as SnapshotResponse | null
    return body?.now ?? null
  } catch {
    return null
  }
}

/** Generation phase summaries (expanded panel). */
export function fetchGenerationsSync(limit = 10): GenerationSummary[] {
  try {
    const body = getSync(`/system-monitor/api/generations?limit=${limit}`) as { generations: GenerationSummary[] } | null
    return body?.generations ?? []
  } catch {
    return []
  }
}
