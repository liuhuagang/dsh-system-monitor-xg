/**
 * dsh-system-monitor-xg client entry: installs stylesheet and locale, then
 * registers the system bar on `conversation.composer.dock` (id
 * 'system-monitor', order 1 — next to the built-in stats line at order 0).
 *
 * @module dsh-system-monitor-xg/client
 */

import { en, NS, zh } from './locales.ts'
import { SystemBar } from './SystemBar.tsx'
// Type-only: 拉入 ui-conversation 的 SlotMap 合并（composer.dock 槽位声明）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Structural slots face (register/inject) — matches the runtime SlotRegistry. */
type SlotsService = {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

type ClientContext = {
  slots: SlotsService
  locale: {
    register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): void
    bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  }
  effect(fn: () => void | (() => void), label: string): void
}

/** Bar + panel styles. Class names prefixed `dsm-` to stay collision-free. */
const STYLES = `
.dsm-wrap {
  display: block;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 780px);
  margin: 0 auto;
  box-sizing: border-box;
  /* 新 host 的 composer.dock 是横向 flex 条（内置统计 pill + 槽位条目 +
     上下文百分比排同一行）。flex 0 0 100% 让底栏在条内独占一整行，margin
     auto 保持居中；旧 host 的块级/纵向布局里 flex 被忽略，行为不变。 */
  flex: 0 0 100%;
}
/* host 的 .dock 是 nowrap：basis 100% 的项不会换行，而是整行横向溢出
   （底栏内容被挤到侧栏/视口外）。给容器补 flex-wrap: wrap。槽位渲染点带
   一层 div[data-slot] 锚点（display:contents，布局透明；其子才是 flex
   项）——.dsm-wrap 的直接父是锚点而非 .dock，容器须经锚点反查：“以
   composer.dock 锚点为直接子元素的 div”即 host 的 .dock（锚点是契约化的
   可寻址接缝）。首位选择器兜底宿主去掉锚点的形态（条目直接为 .dock 子
   元素），两者命中同一目标、互不冲突。特异性 (0,1,2)/(0,1,1) 均高于
   host 的 .dock 类 (0,1,0)。 */
div:has(> div[data-slot='conversation.composer.dock']),
div:has(> .dsm-wrap) {
  flex-wrap: wrap;
}
/* wrap 生效后，dock 的末个子元素（内置 ContextMeter）会独自占一行：
   order -1 把它拉回第 1 行，与统计 pill 组成居中的首行条带；:not 守卫
   保证槽位锚点/兄弟监控条不会被误拉。 */
div:has(> div[data-slot='conversation.composer.dock'])
  > :last-child:not(div[data-slot='conversation.composer.dock']),
div:has(> .dsm-wrap) > :last-child:not(.dsm-wrap):not(.dsg-wrap) {
  order: -1;
}
.dsm-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  column-gap: 10px;
  row-gap: 2px;
  width: 100%;
  margin: 0;
  padding: 4px 0 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  text-align: center;
}
.dsm-bar:hover {
  color: var(--dsw-alias-label-secondary, #c8ccd4);
}
.dsm-seg {
  display: inline-block;
  white-space: nowrap;
}
/* 固定段宽：数字位数变化（1% ↔ 100%）不引起整条伸缩 */
.dsm-fixed-cpu,
.dsm-fixed-mem {
  min-width: 5.6em;
}
.dsm-cputemp {
  /* CPU 温度最宽 99℃；平台无传感器/权限不足时不渲染，出现后不再伸缩 */
  min-width: 2.6em;
}
.dsm-fixed-gpu {
  min-width: 14em;
}
.dsm-fixed-vram {
  /* 22.00/24.00 两位小数，中英文标签最宽约 8.6em */
  min-width: 8.8em;
}
.dsm-fixed-pwr {
  min-width: 3em;
}
.dsm-fixed-temp {
  /* 核心/显存双温度，最宽 99/99℃（约 4.5em）；仅核心温度时不引起伸缩 */
  min-width: 5em;
}
.dsm-sep {
  color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.25));
}
.dsm-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-weight: 600;
  /* 固定宽：中英文本长度差异大（空闲 ↔ bandwidth-bound），
     状态切换不引起整条伸缩 */
  min-width: 8.8em;
}
.dsm-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 12%, transparent);
}
.dsm-panel {
  margin: 4px auto 0;
  max-width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #1a1d24);
  color-scheme: light dark;
}
.dsm-panel-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #5b6472);
}
.dsm-panel-empty {
  padding: 6px 0;
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
}
.dsm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.dsm-table th,
.dsm-table td {
  padding: 4px 10px;
  text-align: left;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  white-space: nowrap;
}
.dsm-table th {
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
}
.dsm-table .dsm-num {
  text-align: right;
}
.dsm-close {
  margin-top: 8px;
  padding: 4px 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b6472);
  font-size: 12px;
  cursor: pointer;
}
.dsm-close:hover {
  border-color: var(--dsw-alias-label-secondary, #5b6472);
}
`

function installStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-system-monitor-xg'
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Client services required by this plugin. */
export const inject = ['slots', 'locale']

/** Register the system bar on the composer dock (next to the stats line). */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-system-monitor-xg: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-system-monitor-xg: locale')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'system-monitor',
    order: 1,
    locale: NS,
  }, SystemBar))
}
