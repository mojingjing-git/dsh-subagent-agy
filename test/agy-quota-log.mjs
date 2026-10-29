#!/usr/bin/env node
/**
 * Quota-log checks:
 *
 *   node test/agy-quota-log.mjs
 *
 * The conversion arithmetic is the part that has to be right: it is what turns
 * "80% left" into "a month is roughly this many tokens".
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { appendQuotaSnapshot, estimateQuota, readQuotaLog } = await import('../lib/agy-quota-log.js')

let passed = 0
const check = (name, fn) => {
  const out = fn()
  if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
    throw new Error(`async assertion passed to sync check() (unawaited): ${name}`)
  }
  passed += 1
  console.log(`  ok  ${name}`)
}

const report = (rows) => ({ rows, badge: null, badgeFamily: '', fetchedAt: 0, stale: false })
const DAY = 86_400_000
const at = (iso) => new Date(iso).getTime()

check('unchanged readings are not appended twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-'))
  try {
    const path = join(dir, 'log.jsonl')
    const seen = new Map()
    const rows = [{ family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 80, resetAt: '2026-11-01T00:00:00Z' }]
    appendQuotaSnapshot(path, report(rows), at('2026-10-29T10:00:00Z'), seen)
    appendQuotaSnapshot(path, report(rows), at('2026-10-29T10:05:00Z'), seen)
    assert.equal(readQuotaLog(path).length, 1)
    appendQuotaSnapshot(path, report([{ ...rows[0], percent: 79 }]), at('2026-10-29T10:10:00Z'), seen)
    assert.equal(readQuotaLog(path).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a damaged line is skipped instead of failing the read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-'))
  try {
    const path = join(dir, 'log.jsonl')
    appendQuotaSnapshot(path, report([{ family: 'Gemini Models', window: 'Five Hour Limit Remaining', percent: 95 }]), at('2026-10-29T10:00:00Z'), new Map())
    appendFileSync(path, '{"t": 1, "fam') // a crash mid-write
    assert.equal(readQuotaLog(path).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('tokens per percentage point and the 100% projection', () => {
  const now = at('2026-10-29T12:00:00Z')
  const snapshots = [
    { t: now - 2 * DAY, family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 90, resetAt: 'R1' },
    { t: now - 1 * DAY, family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 80, resetAt: 'R1' },
    { t: now, family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 74, resetAt: 'R1' },
  ]
  const rows = [
    { t: now - 45 * 3600_000, input: 1000, output: 100, cacheRead: 5000 },
    { t: now - 20 * 3600_000, input: 1000, output: 100, cacheRead: 5000 },
    { t: now - 2 * 3600_000, input: 1000, output: 100, cacheRead: 5000 },
    // Outside the span: must not be counted.
    { t: now - 3 * DAY, input: 999_999, output: 0, cacheRead: 0 },
  ]
  const [estimate] = estimateQuota(snapshots, rows, now)
  assert.equal(estimate.usedPoints, 16)
  assert.equal(estimate.tokens, 6100 * 3)
  assert.equal(estimate.tokensPerPoint, (6100 * 3) / 16)
  assert.equal(estimate.capacity, Math.round(((6100 * 3) / 16) * 100))
  assert.equal(estimate.samples, 3)
  assert.equal(estimate.reason, null)
})

check('a span too short to beat rounding is refused, not extrapolated', () => {
  const now = at('2026-10-29T12:00:00Z')
  const snapshots = [
    { t: now - 20 * 60_000, family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 50, resetAt: 'R1' },
    { t: now, family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 49, resetAt: 'R1' },
  ]
  // The regression: a whole day of tokens divided by one noisy point reported
  // ~19B per month.
  const rows = [{ t: now - 10 * 60_000, input: 150_000_000, output: 10_000_000, cacheRead: 30_000_000 }]
  const [estimate] = estimateQuota(snapshots, rows, now)
  assert.equal(estimate.tokensPerPoint, null)
  assert.equal(estimate.capacity, null)
  assert.equal(estimate.reason, 'short-span')
})

check('a reset starts a new window instead of a negative delta', () => {
  const now = at('2026-10-29T12:00:00Z')
  const snapshots = [
    { t: now - DAY, family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 5, resetAt: 'R1' },
    { t: now - 1000, family: 'Gemini Models', window: 'Weekly Limit Remaining', percent: 98, resetAt: 'R2' },
  ]
  const [estimate] = estimateQuota(snapshots, [], now)
  assert.equal(estimate.usedPoints, 0)
  assert.equal(estimate.tokensPerPoint, null)
  assert.equal(estimate.samples, 1)
})

check('one sample is not an estimate', () => {
  const now = at('2026-10-29T12:00:00Z')
  const [estimate] = estimateQuota([{ t: now, family: 'Claude and GPT models', window: 'Weekly Limit Remaining', percent: 82 }], [], now)
  assert.equal(estimate.tokensPerPoint, null)
  assert.equal(estimate.capacity, null)
  assert.equal(estimate.samples, 1)
})

console.log(`\n${passed} checks passed`)
