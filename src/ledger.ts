/**
 * JSONL ledger: persists every sample point and generation summary to
 * `~/.dsh/dsh-system-monitor/` (or `$DSH_HOME/dsh-system-monitor/`), one
 * JSON object per line, rotated daily. Disk failures only warn — the ledger
 * must never take the sampler down (the exporter 兜底 lesson applies to any
 * host-side persistence).
 *
 * @module dsh-system-monitor/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GenerationSummary, SamplePoint } from './types.ts'

export function dataDir(): string {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-system-monitor')
}

function dayStamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export class Ledger {
  private dir: string
  private ready: Promise<unknown> | null = null
  private disabled = false

  constructor(dir: string = dataDir()) {
    this.dir = dir
  }

  private ensureReady(): Promise<unknown> {
    if (this.ready === null) {
      this.ready = mkdir(this.dir, { recursive: true }).catch(error => {
        this.disabled = true
        console.warn(`[dsh-system-monitor] ledger dir unavailable (${this.dir}): ${String(error)}`)
      })
    }
    return this.ready
  }

  private async append(name: string, row: unknown): Promise<void> {
    if (this.disabled) return
    try {
      await this.ensureReady()
      const file = join(this.dir, `${name}-${dayStamp(Date.now())}.jsonl`)
      await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' })
    } catch (error) {
      console.warn(`[dsh-system-monitor] ledger append failed: ${String(error)}`)
    }
  }

  recordPoint(point: SamplePoint): void {
    void this.append('metrics', point)
  }

  recordGeneration(summary: GenerationSummary): void {
    void this.append('generations', summary)
  }
}
