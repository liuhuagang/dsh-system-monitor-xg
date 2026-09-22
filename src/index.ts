/**
 * dsh-system-monitor-xg host entry: sampler lifecycle + REST API + the
 * `system_metrics` tool.
 *
 * Host side provides everything the browser cannot:
 *  1. 定时采样 CPU（含 ACPI 热区温度，5s 慢通道）/ 内存 / GPU（算力 · 显存带宽 · 显存 · 功耗 · 核心/显存温度 · 时钟）
 *  2. 瓶颈诊断（算力受限 / 带宽受限 / 功耗受限 / 热限制 / 显存容量）
 *  3. 生成阶段跟踪：prefill（计算密集）vs decode（带宽密集）两阶段负载对比
 *  4. REST API（底栏 1s 轮询）：/system-monitor/api/snapshot · /generations
 *  5. JSONL 落盘（~/.dsh/dsh-system-monitor-xg/）
 *  6. system_metrics 工具：agent 会话内随时查询负载与瓶颈（评测归因）
 *
 * @module dsh-system-monitor-xg
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ServerResponse } from 'node:http'
// Type-only: 拉入 webServer 服务的模块增强（ctx.webServer 类型）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CpuMonitor } from './cpu.ts'
import { GpuMonitor } from './gpu.ts'
import { Ledger } from './ledger.ts'
import { Sampler } from './sampler.ts'
import { CpuThermalMonitor, CPU_TEMP_POLL_MS } from './thermal.ts'
import { KIND_LABELS } from './bottleneck.ts'
import type { Config, SnapshotResponse } from './types.ts'

export const name = 'dsh-system-monitor-xg'
export const inject = ['webServer', 'tools']

const API_PREFIX = '/system-monitor/api'

export interface HostConfig {
  intervalMs?: number
  historySize?: number
  persist?: boolean
}

function resolveConfig(raw: HostConfig | undefined): Config {
  return {
    intervalMs: Math.max(250, Math.min(10_000, raw?.intervalMs ?? 1000)),
    historySize: Math.max(60, Math.min(86_400, raw?.historySize ?? 3600)),
    persist: raw?.persist ?? true,
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  // Connection: close —— 每次响应独立连接，避免 webserver 5s keep-alive
  // 留下半开 socket 导致浏览器池化请求挂死（dsh-status-bar 社区踩坑结论）。
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'close',
  })
  res.end(text)
}

export function apply(ctx: Context, rawConfig?: HostConfig): void {
  const config = resolveConfig(rawConfig)
  const cpu = new CpuMonitor()
  const gpu = new GpuMonitor()
  const thermal = new CpuThermalMonitor()
  const ledger = config.persist ? new Ledger() : null
  const sampler = new Sampler(cpu, gpu, thermal, {
    intervalMs: config.intervalMs,
    historySize: config.historySize,
    onPoint: point => { ledger?.recordPoint(point) },
    onGeneration: summary => { ledger?.recordGeneration(summary) },
  })

  ctx.effect(() => {
    sampler.start(ctx)
    thermal.start(CPU_TEMP_POLL_MS)
    console.log(`[dsh-system-monitor-xg] sampler started (interval ${config.intervalMs}ms, history ${config.historySize}, persist ${config.persist}, cpu-thermal ${CPU_TEMP_POLL_MS}ms)`)
    return () => {
      sampler.dispose()
      thermal.dispose()
    }
  }, 'dsh-system-monitor-xg: sampler')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      if (path === `${API_PREFIX}/snapshot`) {
        const light = url.searchParams.get('light') === '1'
        const now = sampler.latest()
        if (now === null) {
          json(res, 200, { now: null })
          return
        }
        // light 模式只回最新采样（底栏 1s 轮询用），避免每次搬运历史窗口
        const body: SnapshotResponse = light
          ? { now, history: [], generations: [] }
          : {
              now,
              history: sampler.historySlice(60),
              generations: sampler.recentGenerations(10),
            }
        json(res, 200, body)
        return
      }
      if (path === `${API_PREFIX}/generations`) {
        const raw = Number(url.searchParams.get('limit') ?? '20')
        const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 20
        json(res, 200, { generations: sampler.recentGenerations(limit) })
        return
      }
      if (path === `${API_PREFIX}/history`) {
        const raw = Number(url.searchParams.get('window') ?? '120')
        const window = Number.isInteger(raw) && raw > 0 ? Math.min(raw, config.historySize) : 120
        json(res, 200, { history: sampler.historySlice(window) })
        return
      }
      if (path === `${API_PREFIX}/processes`) {
        json(res, 200, { processes: await gpu.processes(), gpuUnavailable: gpu.isUnavailable })
        return
      }
      json(res, 404, { error: 'not-found' })
    },
  }), 'dsh-system-monitor-xg: rest api')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'system_metrics',
    description: '查询宿主机当前负载与推理瓶颈诊断：CPU 占用与 CPU 温度（ACPI 热区）、内存占用、每张 GPU 的算力利用率（SM）、显存带宽利用率、显存占用、功耗、核心/显存温度、时钟频率，以及瓶颈推断（算力受限/带宽受限/功耗受限/热限制/显存容量）。' +
      '注意：GPU 占用高不等于算力打满——decode 阶段算力常在等显存带宽，请对比 SM 与带宽利用率。' +
      '另可返回最近生成（prefill/decode 两阶段）的负载均值对比与负载进程列表。用于评测环境观测与性能归因。',
    parameters: {
      history: { type: 'number', description: '返回最近 N 条采样点（默认 1，最大 60）' },
      generations: { type: 'number', description: '返回最近 N 次生成的 prefill/decode 阶段负载统计（默认 5，最大 50）' },
      processes: { type: 'boolean', description: '是否附带显存占用进程列表（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ts: { type: 'number' },
          stage: { type: 'string', description: '当前生成阶段：idle/prefill/decode/other' },
          cpu: { type: 'json', description: 'CPU 占用：{percent, perCore, cores, tempC} 或 null（tempC 为 CPU 温度 ℃，平台无传感器或权限不足时为 null）' },
          memory: { type: 'json', description: '内存占用：{usedGb, totalGb, percent} 或 null' },
          gpus: { type: 'array', description: '每张 GPU 的指标数组' },
          gpuUnavailable: { type: 'boolean' },
          lastGpuError: { type: 'string', description: '最近一次 nvidia-smi 失败原因（健康时为空串；冷却期自动重试中）' },
          lastCpuThermalError: { type: 'string', description: '最近一次 CPU 温度采样失败原因（健康时为空串；如 WMI root/wmi 拒绝访问；冷却期自动重试中）' },
          bottleneck: { type: 'json', description: `瓶颈诊断：{kind, label, detail}，kind ∈ {idle, compute, bandwidth, power, thermal, vram, mixed}` },
          history: { type: 'array' },
          generations: { type: 'array' },
          processes: { type: 'array' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatForModel(value) }],
    },
    async execute(args) {
      const now = sampler.latest()
      const history = sampler.historySlice(Math.min(args.history ?? 1, 60))
      const generations = sampler.recentGenerations(Math.min(args.generations ?? 5, 50))
      const processes = args.processes ?? true ? await gpu.processes() : []
      return {
        ts: now?.ts ?? Date.now(),
        stage: now?.stage ?? 'idle',
        cpu: now?.cpu ?? null,
        memory: now?.memory ?? null,
        gpus: now?.gpus ?? [],
        gpuUnavailable: now?.gpuUnavailable ?? gpu.isUnavailable,
        lastGpuError: gpu.lastError,
        lastCpuThermalError: thermal.lastError,
        bottleneck: now?.bottleneck ?? null,
        history,
        generations,
        processes,
      }
    },
  })), 'dsh-system-monitor-xg: system_metrics tool')
}

/** 模型可读的纯文本渲染（tool 的 Native 内容）。 */
function formatForModel(value: Record<string, unknown>): string {
  const lines: string[] = []
  const cpu = value.cpu as { percent?: number; tempC?: number | null } | null
  const memory = value.memory as { percent?: number; usedGb?: number; totalGb?: number } | null
  const cpuTemp = typeof cpu?.tempC === 'number' ? `（温度 ${cpu.tempC.toFixed(0)}℃）` : ''
  lines.push(`时间 ${new Date(value.ts as number).toISOString()}，阶段 ${String(value.stage)}`)
  lines.push(`CPU ${cpu?.percent !== undefined ? `${cpu.percent.toFixed(1)}%` : 'N/A'}${cpuTemp}，内存 ${memory?.percent !== undefined ? `${memory.percent.toFixed(1)}%（${memory.usedGb?.toFixed(1)}/${memory.totalGb?.toFixed(1)}G）` : 'N/A'}`)
  const cpuThermalError = String(value.lastCpuThermalError ?? '').trim()
  if (cpuThermalError !== '') lines.push(`CPU 温度：不可用（${cpuThermalError}）`)
  const gpus = value.gpus as Array<Record<string, unknown>>
  if (gpus.length > 0) {
    for (const g of gpus) {
      const memTemp = g.memTempC !== null && g.memTempC !== undefined ? ` / 显存 ${Number(g.memTempC).toFixed(0)}℃` : ''
      lines.push(`GPU${String(g.index)} ${String(g.name)}：SM 算力 ${Number(g.smPercent).toFixed(0)}% / 带宽 ${Number(g.memBandwidthPercent).toFixed(0)}%，显存 ${(Number(g.vramUsedMb) / 1024).toFixed(1)}/${(Number(g.vramTotalMb) / 1024).toFixed(0)}G，功耗 ${Number(g.powerDrawW).toFixed(0)}W，温度 ${Number(g.tempC).toFixed(0)}℃${memTemp}，SM 时钟 ${Number(g.smClockMhz).toFixed(0)}/${Number(g.smClockMaxMhz).toFixed(0)}MHz`)
    }
  } else if (value.gpuUnavailable) {
    const lastError = String(value.lastGpuError ?? '').trim()
    lines.push(lastError !== '' ? `GPU：nvidia-smi 不可用（${lastError}）` : 'GPU：nvidia-smi 不可用')
  }
  const bottleneck = value.bottleneck as { label?: string; detail?: string } | null
  if (bottleneck) lines.push(`瓶颈：${bottleneck.label}（${bottleneck.detail}）`)
  const generations = value.generations as Array<Record<string, unknown>>
  if (generations.length > 0) {
    lines.push('最近生成阶段对比：')
    for (const g of generations.slice(-5)) {
      const p = g.prefill as Record<string, unknown> | null
      const d = g.decode as Record<string, unknown> | null
      const pStr = p ? `SM ${Number(p.smAvg).toFixed(0)}% 带宽 ${Number(p.bwAvg).toFixed(0)}% (${Number(g.prefillMs).toFixed(0)}ms)` : '无采样'
      const dStr = d ? `SM ${Number(d.smAvg).toFixed(0)}% 带宽 ${Number(d.bwAvg).toFixed(0)}% (${Number(g.decodeMs).toFixed(0)}ms)` : '无采样'
      lines.push(`  #${String(g.id)} prefill: ${pStr} → decode: ${dStr}`)
    }
  }
  const processes = value.processes as Array<{ pid?: number; name?: string; usedMb?: number }> | null
  if (processes && processes.length > 0) {
    lines.push('显存占用进程：')
    for (const p of processes.slice(0, 10)) lines.push(`  ${p.name} (pid ${p.pid}) ${((p.usedMb ?? 0) / 1024).toFixed(1)}G`)
  }
  return lines.join('\n')
}
