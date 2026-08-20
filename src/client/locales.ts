/**
 * Locale dictionaries for the client half. zh is the key-set source of
 * truth; en is checked complete against it. The namespace merges into
 * LocaleNamespaceMap so the framework synthesizes the typed `t` seat for
 * registered entries.
 *
 * @module dsh-system-monitor-xg/client/locales
 */

export const NS = 'system-monitor'

const zh = {
  cpu: 'CPU',
  memory: '内存',
  gpu: 'GPU',
  vram: '显存',
  sm: 'SM',
  bw: '带宽',
  unavailable: '不可用',
  waiting: '采样中…',
  clickHint: '点击查看生成阶段对比',
  generationsTitle: '最近生成阶段对比（prefill 算力密集 vs decode 带宽密集）',
  genId: '生成',
  prefill: 'prefill',
  decode: 'decode',
  noGeneration: '暂无生成记录',
  close: '收起',
  'bottleneck.idle': '空闲',
  'bottleneck.compute': '算力受限',
  'bottleneck.bandwidth': '带宽受限',
  'bottleneck.power': '功耗受限',
  'bottleneck.thermal': '热限制',
  'bottleneck.vram': '显存瓶颈',
  'bottleneck.mixed': '均衡负载',
  'phase.noData': '无采样',
}

const en: Record<keyof typeof zh, string> = {
  cpu: 'CPU',
  memory: 'MEM',
  gpu: 'GPU',
  vram: 'VRAM',
  sm: 'SM',
  bw: 'BW',
  unavailable: 'n/a',
  waiting: 'sampling…',
  clickHint: 'click for generation phases',
  generationsTitle: 'Recent generations: prefill (compute-bound) vs decode (bandwidth-bound)',
  genId: 'gen',
  prefill: 'prefill',
  decode: 'decode',
  noGeneration: 'no generations yet',
  close: 'close',
  'bottleneck.idle': 'idle',
  'bottleneck.compute': 'compute-bound',
  'bottleneck.bandwidth': 'bandwidth-bound',
  'bottleneck.power': 'power-limited',
  'bottleneck.thermal': 'thermal',
  'bottleneck.vram': 'vram-limited',
  'bottleneck.mixed': 'balanced',
  'phase.noData': 'no data',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-system-monitor-xg dictionary namespace. */
    'system-monitor': keyof typeof zh
  }
}

export { zh, en }
