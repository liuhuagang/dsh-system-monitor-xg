/**
 * The system monitor bar: a `conversation.composer.dock` entry (id
 * 'system-monitor', order 1 — sits right of the built-in stats line) that
 * polls the host's light snapshot once per second and renders CPU / memory /
 * GPU (SM 算力 · 显存带宽 · 显存 · 功耗 · 温度) plus the bottleneck badge.
 *
 * Clicking the bar expands the generation phase comparison (prefill vs
 * decode). 瓶颈徽标颜色：算力=蓝、带宽=琥珀、功耗=橙、热/显存=红、均衡=灰。
 *
 * @module dsh-system-monitor-xg/client/SystemBar
 */

import { memo, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchGenerationsSync, fetchSnapshotSync, type GenerationSummary, type SamplePoint } from './fetch.ts'
import { NS, type zh } from './locales.ts'

type T = (key: keyof typeof zh) => string

const KIND_COLORS: Record<string, string> = {
  idle: '#9aa0aa',
  mixed: '#9aa0aa',
  compute: '#5b8def',
  bandwidth: '#e8b339',
  power: '#e8871e',
  thermal: '#e5484d',
  vram: '#e5484d',
}

/** 瓶颈标签走 locale 字典（t('bottleneck.<kind>')），随 DSH 当前语言切换。 */
function kindLabel(kind: string | undefined, t: T): string {
  if (kind === undefined) return ''
  return t(`bottleneck.${kind}` as keyof typeof zh)
}

function fmtGb(mb: number): string {
  return (mb / 1024).toFixed(0)
}

function Segment({ text, title, className }: { text: string; title?: string; className?: string }) {
  return <span className={className !== undefined ? `dsm-seg ${className}` : 'dsm-seg'} title={title}>{text}</span>
}

function PhaseCell(stats: GenerationSummary['prefill'] | null, t: T): string {
  if (stats === null) return t('phase.noData')
  return `SM ${stats.smAvg.toFixed(0)}% 带宽 ${stats.bwAvg.toFixed(0)}%`
}

export const SystemBar = memo(function SystemBar(props: PropsRuntime<'conversation.composer.dock'> & PropsLocale<typeof NS>) {
  const { t } = props
  const [point, setPoint] = useState<SamplePoint | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [generations, setGenerations] = useState<GenerationSummary[]>([])

  // 1s 轮询最新采样（同步 XHR，见 fetch.ts 的社区踩坑说明）。
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      if (!alive) return
      const next = fetchSnapshotSync()
      if (next !== null) setPoint(next)
      window.setTimeout(poll, 1000)
    }
    poll()
    return () => { alive = false }
  }, [])

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next) setGenerations(fetchGenerationsSync(10))
  }

  const gpu = point?.gpus[0]
  const bottleneck = point?.bottleneck
  const badgeColor = bottleneck ? KIND_COLORS[bottleneck.kind] ?? '#9aa0aa' : undefined

  return (
    <div className="dsm-wrap">
      <button
        type="button"
        className="dsm-bar"
        onClick={toggle}
        aria-expanded={expanded}
        title={`${t('clickHint')} · ${bottleneck?.detail ?? ''}`}
      >
        {point === null ? (
          <Segment text={t('waiting')} />
        ) : (
          <>
            <Segment
              className="dsm-fixed-cpu"
              text={`${t('cpu')} ${point.cpu ? `${point.cpu.percent.toFixed(0)}%` : '…'}`}
              title={point.cpu ? `CPU ${point.cpu.percent.toFixed(1)}% (${point.cpu.perCore.map(p => p.toFixed(0)).join('/')}%)` : undefined}
            />
            <Segment
              className="dsm-fixed-mem"
              text={`${t('memory')} ${point.memory ? `${point.memory.percent.toFixed(0)}%` : '…'}`}
              title={point.memory ? `内存 ${point.memory.usedGb.toFixed(1)}/${point.memory.totalGb.toFixed(0)}G` : undefined}
            />
            <span className="dsm-sep" aria-hidden>│</span>
            {point.gpuUnavailable || gpu === undefined ? (
              <Segment className="dsm-fixed-gpu" text={`${t('gpu')} ${t('unavailable')}`} title={t('unavailable')} />
            ) : (
              <>
                <Segment
                  className="dsm-fixed-gpu"
                  text={`${t('gpu')}${gpu.index} SM ${gpu.smPercent.toFixed(0)}% 带宽 ${gpu.memBandwidthPercent.toFixed(0)}%`}
                  title={`${t('sm')} ${gpu.smPercent.toFixed(1)}% · ${t('bw')} ${gpu.memBandwidthPercent.toFixed(1)}%（显存带宽控制器利用率）`}
                />
                <Segment
                  className="dsm-fixed-vram"
                  text={`${t('vram')} ${fmtGb(gpu.vramUsedMb)}/${fmtGb(gpu.vramTotalMb)}G`}
                  title={`VRAM ${(gpu.vramUsedMb / 1024).toFixed(1)}/${(gpu.vramTotalMb / 1024).toFixed(0)} GiB`}
                />
                <Segment className="dsm-fixed-pwr" text={`${gpu.powerDrawW.toFixed(0)}W`} title={`功耗 ${gpu.powerDrawW.toFixed(0)}W${gpu.powerLimitW > 0 ? `/${gpu.powerLimitW.toFixed(0)}W` : ''}`} />
                <Segment className="dsm-fixed-temp" text={`${gpu.tempC.toFixed(0)}℃`} title={`温度 ${gpu.tempC.toFixed(0)}℃ · SM 时钟 ${gpu.smClockMhz.toFixed(0)}/${gpu.smClockMaxMhz.toFixed(0)} MHz`} />
              </>
            )}
            {bottleneck != null && (
              <span className="dsm-badge" style={{ color: badgeColor }}>
                <span className="dsm-dot" style={{ backgroundColor: badgeColor }} aria-hidden />
                {kindLabel(bottleneck.kind, t)}
              </span>
            )}
          </>
        )}
      </button>
      {expanded && (
        <div className="dsm-panel">
          <div className="dsm-panel-title">{t('generationsTitle')}</div>
          {generations.length === 0 ? (
            <div className="dsm-panel-empty">{t('noGeneration')}</div>
          ) : (
            <table className="dsm-table">
              <thead>
                <tr>
                  <th className="dsm-num">#</th>
                  <th className="dsm-num">{t('prefill')}</th>
                  <th className="dsm-num">{t('prefill')} SM/BW</th>
                  <th className="dsm-num">{t('decode')}</th>
                  <th className="dsm-num">{t('decode')} SM/BW</th>
                </tr>
              </thead>
              <tbody>
                {generations.map(g => (
                  <tr key={g.id}>
                    <td className="dsm-num">{g.id}</td>
                    <td className="dsm-num">{g.prefillMs.toFixed(0)}ms</td>
                    <td className="dsm-num">{PhaseCell(g.prefill, t)}</td>
                    <td className="dsm-num">{g.decodeMs.toFixed(0)}ms</td>
                    <td className="dsm-num">{PhaseCell(g.decode, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" className="dsm-close" onClick={() => setExpanded(false)}>{t('close')}</button>
        </div>
      )}
    </div>
  )
})
