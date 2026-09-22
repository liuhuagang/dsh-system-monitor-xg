/**
 * Unit tests for the pure logic layer (bottleneck diagnosis + phase stats +
 * CPU 温度判据), runnable without any cordis machinery:
 * `node --test tests/logic.spec.mjs`.
 * The modules under test are pure functions over plain JSON, matching the
 * host's JSONL wire shapes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, diagnoseMostActive } from '../lib/bottleneck.js'
import {
  RETRY_COOLDOWN_MS,
  MISSING_COOLDOWN_MS,
  failureCooldownMs,
  canAttemptNvidiaSmi,
} from '../lib/gpu.js'
import {
  THERMAL_RETRY_MS,
  THERMAL_UNAVAILABLE_COOLDOWN_MS,
  parseThermalStdout,
  thermalFailureCooldown,
  zoneTempC,
  selectCpuZone,
} from '../lib/thermal.js'

/** A busy-enough 4090-like sample. */
function gpu(over = {}) {
  return {
    index: 0,
    name: 'NVIDIA GeForce RTX 4090',
    smPercent: 45,
    memBandwidthPercent: 40,
    vramUsedMb: 12000,
    vramTotalMb: 24564,
    powerDrawW: 120,
    powerLimitW: 450,
    tempC: 50,
    memTempC: 45,
    smClockMhz: 2500,
    smClockMaxMhz: 3105,
    memClockMhz: 10000,
    memClockMaxMhz: 10501,
    ...over,
  }
}

test('idle: low SM and low bandwidth', () => {
  const d = diagnose(gpu({ smPercent: 5, memBandwidthPercent: 3 }))
  assert.equal(d.kind, 'idle')
})

test('compute-bound: SM saturated, bandwidth low (typical prefill)', () => {
  const d = diagnose(gpu({ smPercent: 95, memBandwidthPercent: 40 }))
  assert.equal(d.kind, 'compute')
  assert.ok(d.detail.includes('prefill'))
})

test('bandwidth-bound: bandwidth saturated, SM waiting (typical decode)', () => {
  const d = diagnose(gpu({ smPercent: 50, memBandwidthPercent: 92 }))
  assert.equal(d.kind, 'bandwidth')
  assert.ok(d.detail.includes('decode'))
})

test('bandwidth-bound double-high: SM and bandwidth both saturated', () => {
  const d = diagnose(gpu({ smPercent: 88, memBandwidthPercent: 90 }))
  assert.equal(d.kind, 'bandwidth')
})

test('power wall: draw near the limit', () => {
  const d = diagnose(gpu({ smPercent: 80, memBandwidthPercent: 70, powerDrawW: 448, powerLimitW: 450 }))
  assert.equal(d.kind, 'power')
})

test('thermal: high temp with clock drop', () => {
  const d = diagnose(gpu({ smPercent: 70, memBandwidthPercent: 60, tempC: 84, smClockMhz: 2300, smClockMaxMhz: 3105 }))
  assert.equal(d.kind, 'thermal')
})

test('thermal: memory temperature alone (GDDR hot, core still cool)', () => {
  const d = diagnose(gpu({ smPercent: 70, memBandwidthPercent: 60, tempC: 62, memTempC: 97 }))
  assert.equal(d.kind, 'thermal')
  assert.ok(d.detail.includes('显存'))
  assert.equal(d.evidence.memTempC, 97)
})

test('thermal: core hot with memory temp present shows both in detail', () => {
  const d = diagnose(gpu({ smPercent: 70, memBandwidthPercent: 60, tempC: 90, memTempC: 84 }))
  assert.equal(d.kind, 'thermal')
  assert.ok(d.detail.includes('90℃'))
  assert.ok(d.detail.includes('显存 84℃'))
})

test('memory temp null (driver N/A) does not trigger thermal and is not in detail', () => {
  const d = diagnose(gpu({ smPercent: 55, memBandwidthPercent: 50, tempC: 60, memTempC: null }))
  assert.equal(d.kind, 'mixed')
  assert.equal(d.evidence.memTempC, null)
  assert.ok(!d.detail.includes('显存'))
})

test('memory temp just below threshold stays non-thermal', () => {
  const d = diagnose(gpu({ smPercent: 55, memBandwidthPercent: 50, tempC: 60, memTempC: 94 }))
  assert.equal(d.kind, 'mixed')
})

test('vram capacity: usage near the limit', () => {
  const d = diagnose(gpu({ vramUsedMb: 24000, vramTotalMb: 24564 }))
  assert.equal(d.kind, 'vram')
})

test('balanced: mid SM and mid bandwidth', () => {
  const d = diagnose(gpu({ smPercent: 55, memBandwidthPercent: 50 }))
  assert.equal(d.kind, 'mixed')
})

test('diagnoseMostActive picks the busiest GPU', () => {
  const d = diagnoseMostActive([
    gpu({ index: 0, smPercent: 20, memBandwidthPercent: 10 }),
    gpu({ index: 1, smPercent: 90, memBandwidthPercent: 95 }),
  ])
  assert.ok(d !== null)
  assert.ok(d.evidence.smPercent === 90 && d.evidence.memBandwidthPercent === 95)
})

test('diagnoseMostActive returns null with no GPUs', () => {
  assert.equal(diagnoseMostActive([]), null)
})

// ---- nvidia-smi 失败恢复（冷却期自动重试，不永久锁死）----

test('failureCooldownMs: 瞬态失败用短冷却', () => {
  assert.equal(failureCooldownMs(false), RETRY_COOLDOWN_MS)
})

test('failureCooldownMs: 二进制全部缺失用长冷却（避免高频无谓 spawn）', () => {
  assert.equal(failureCooldownMs(true), MISSING_COOLDOWN_MS)
})

test('canAttemptNvidiaSmi: 健康态恒允许调用', () => {
  assert.equal(canAttemptNvidiaSmi(1_000, false, 999_999, RETRY_COOLDOWN_MS), true)
})

test('canAttemptNvidiaSmi: 冷却期内不允许调用', () => {
  assert.equal(canAttemptNvidiaSmi(4_999, true, 0, RETRY_COOLDOWN_MS), false)
  assert.equal(canAttemptNvidiaSmi(299_999, true, 0, MISSING_COOLDOWN_MS), false)
})

test('canAttemptNvidiaSmi: 冷却期结束允许调用（自动重试）', () => {
  assert.equal(canAttemptNvidiaSmi(5_000, true, 0, RETRY_COOLDOWN_MS), true)
  assert.equal(canAttemptNvidiaSmi(300_001, true, 1, MISSING_COOLDOWN_MS), true)
})

// ---- CPU 温度（ACPI 热区解析与失败冷却判据）----

test('parseThermalStdout: 数值 / 带空白 / 空 / 非法', () => {
  assert.equal(parseThermalStdout('52.3'), 52.3)
  assert.equal(parseThermalStdout('  52\r\n'), 52)
  assert.equal(parseThermalStdout(''), null)
  assert.equal(parseThermalStdout('abc'), null)
})

test('thermalFailureCooldown: 瞬态错误（WMI 失败/超时）用短冷却', () => {
  assert.equal(thermalFailureCooldown(1), THERMAL_RETRY_MS)
  assert.equal(thermalFailureCooldown(null), THERMAL_RETRY_MS)
})

test('thermalFailureCooldown: 环境问题（无热区/拒绝访问/powershell 缺失）用长冷却', () => {
  assert.equal(thermalFailureCooldown(2), THERMAL_UNAVAILABLE_COOLDOWN_MS)
  assert.equal(thermalFailureCooldown(3), THERMAL_UNAVAILABLE_COOLDOWN_MS)
  assert.equal(thermalFailureCooldown(4), THERMAL_UNAVAILABLE_COOLDOWN_MS)
})

test('zoneTempC: 毫摄氏度与摄氏度两种驱动口径', () => {
  assert.equal(zoneTempC(52300), 52.3)
  assert.equal(zoneTempC(52), 52)
  assert.equal(zoneTempC(0), 0)
})

test('selectCpuZone: 优先选 CPU 类型热区', () => {
  assert.equal(selectCpuZone([{ type: 'acpitz', tempC: 42 }, { type: 'x86_pkg_temp', tempC: 35 }]), 35)
  assert.equal(selectCpuZone([{ type: 'acpitz', tempC: 42 }, { type: 'soc_thermal', tempC: 55 }]), 55)
})

test('selectCpuZone: 无 CPU 类型时取最热区', () => {
  assert.equal(selectCpuZone([{ type: 'acpitz', tempC: 42 }, { type: 'battery', tempC: 55 }]), 55)
})

test('selectCpuZone: 空列表 → null', () => {
  assert.equal(selectCpuZone([]), null)
})
