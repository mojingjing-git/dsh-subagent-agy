#!/usr/bin/env node
/**
 * Token-log checks:
 *
 *   node test/agy-usage-log.mjs
 *
 * Pure parsing + window arithmetic against fabricated transcripts, then one
 * end-to-end scan over a temp tree to prove the (mtime, size) cache reuses
 * unchanged files and re-reads the ones agy appended to.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { dayKeyOf, parseTranscript, readTokenUsage, summarize } = await import('../lib/agy-usage-log.js')

let passed = 0
const check = (name, fn) => {
  const out = fn()
  if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
    throw new Error(`async assertion passed to sync check() (unawaited): ${name}`)
  }
  passed += 1
  console.log(`  ok  ${name}`)
}

const line = (createdAt, input, output, cache) => JSON.stringify({
  step_index: 1,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  created_at: createdAt,
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: cache,
})

check('parseTranscript keeps token-bearing model steps and skips the rest', () => {
  const text = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-10-29T06:00:00Z' }),
    line('2026-10-29T06:00:05Z', 100, 10, 0),
    'not json at all',
    '',
    line('2026-10-29T06:00:09Z', 20, 3, 900),
  ].join('\n')
  const rows = parseTranscript(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].input, 100)
  assert.equal(rows[1].cacheRead, 900)
})

check('summarize zero-fills the window and total includes cache reads', () => {
  // Local-time construction on purpose: summarize/dayKeyOf bucket by the LOCAL
  // calendar day, so a literal "+08:00" timestamp asserts this machine's zone
  // rather than the function (CI runs in UTC and would land on the day before).
  const at = (day, hour) => new Date(2026, 9, day, hour, 0).getTime()
  const now = at(29, 12)
  const rows = [
    { t: at(29, 9), input: 1000, output: 100, cacheRead: 5000 },
    { t: at(24, 9), input: 200, output: 20, cacheRead: 0 },
    // Nine days back: outside the 7-day window, still counted in allTime.
    { t: at(20, 9), input: 7, output: 1, cacheRead: 0 },
  ]
  const report = summarize(rows, now, 7)
  assert.equal(report.days.length, 7)
  assert.equal(report.days[6].day, '2026-10-29')
  assert.equal(report.days[0].day, '2026-10-23')
  assert.equal(report.window.total, 1000 + 100 + 5000 + 200 + 20)
  assert.equal(report.window.cacheRead, 5000)
  assert.equal(report.allTime.total, 6328)
  assert.equal(report.allTime.from, '2026-10-20')
  assert.equal(report.allTime.to, '2026-10-29')
})

check('summarize buckets by the local calendar day, not by UTC', () => {
  // 00:30 local: still today locally, while a UTC-based bucket would file it
  // under the previous day for any zone east of Greenwich.
  const midnight = new Date(2026, 9, 29, 0, 30).getTime()
  const now = new Date(2026, 9, 29, 12, 0).getTime()
  assert.equal(dayKeyOf(midnight), '2026-10-29')
  const report = summarize([{ t: midnight, input: 5, output: 1, cacheRead: 0 }], now, 7)
  assert.equal(report.days[6].total, 6, 'the 00:30 local row belongs to today')
})

const scratch = mkdtempSync(join(tmpdir(), 'agy-token-'))
try {
  const writeTranscript = (root, id, lines) => {
    const dir = join(root, id, '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'transcript.jsonl')
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    return path
  }
  const cli = join(scratch, 'cli')
  const ide = join(scratch, 'ide')
  // Relative to now, not a literal date: the rows must land inside the 7-day
  // window AND before `now` in every time zone. A fixed "+08:00" pair put the
  // second store hours in the future for any zone west of Greenwich, which
  // dropped it from the window.
  const scanNow = Date.now()
  const hoursAgo = (hours) => new Date(scanNow - hours * 3_600_000).toISOString()
  writeTranscript(cli, 'conv-a', [line(hoursAgo(2), 100, 10, 0)])
  writeTranscript(ide, 'conv-b', [line(hoursAgo(1), 200, 20, 300)])
  const cachePath = join(scratch, 'cache.json')

  check('readTokenUsage scans every root and counts both stores', () => {
    const report = readTokenUsage({ roots: [cli, ide], cachePath, now: scanNow })
    assert.equal(report.files, 2)
    assert.equal(report.reused, 0)
    assert.equal(report.window.total, 100 + 10 + 200 + 20 + 300)
    assert.equal(report.allTime.conversations, 2)
  })

  check('a second scan reuses unchanged transcripts', () => {
    const report = readTokenUsage({ roots: [cli, ide], cachePath })
    assert.equal(report.reused, 2)
    assert.equal(report.files, 2)
  })

  check('an appended transcript is re-read, not double counted', () => {
    const path = writeTranscript(cli, 'conv-a', [
      line(hoursAgo(2), 100, 10, 0),
      line(hoursAgo(1), 50, 5, 1000),
    ])
    utimesSync(path, new Date(), new Date(Date.now() + 1000))
    const report = readTokenUsage({ roots: [cli, ide], cachePath, now: scanNow })
    assert.equal(report.reused, 1)
    assert.equal(report.window.total, 100 + 10 + 200 + 20 + 300 + 50 + 5 + 1000)
  })

  check('a missing root is not an error', () => {
    const report = readTokenUsage({ roots: [join(scratch, 'nope')], cachePath: join(scratch, 'cache2.json') })
    assert.equal(report.files, 0)
    assert.equal(report.window.total, 0)
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed`)
