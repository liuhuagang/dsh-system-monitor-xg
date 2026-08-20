/**
 * Unit tests for the pure logic layer (bottleneck diagnosis + phase stats),
 * runnable without any cordis machinery: `node --test tests/logic.spec.mjs`.
 * The modules under test are pure functions over plain JSON, matching the
 * host's JSONL wire shapes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, diagnoseMostActive } from '../lib/bottleneck.js'

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
