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
  const now = new Date('2026-10-29T12:00:00+08:00').getTime()
  const rows = [
    { t: new Date('2026-10-29T09:00:00+08:00').getTime(), input: 1000, output: 100, cacheRead: 5000 },
    { t: new Date('2026-10-24T09:00:00+08:00').getTime(), input: 200, output: 20, cacheRead: 0 },
    // Nine days back: outside the 7-day window, still counted in allTime.
    { t: new Date('2026-10-20T09:00:00+08:00').getTime(), input: 7, output: 1, cacheRead: 0 },
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
  const now = new Date('2026-10-29T12:00:00+08:00').getTime()
  const midnight = new Date('2026-10-29T00:30:00+08:00').getTime()
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
  writeTranscript(cli, 'conv-a', [line('2026-10-29T06:00:00Z', 100, 10, 0)])
  writeTranscript(ide, 'conv-b', [line('2026-10-29T07:00:00Z', 200, 20, 300)])
  const cachePath = join(scratch, 'cache.json')

  check('readTokenUsage scans every root and counts both stores', () => {
    const report = readTokenUsage({ roots: [cli, ide], cachePath, now: new Date('2026-10-29T12:00:00+08:00').getTime() })
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
      line('2026-10-29T06:00:00Z', 100, 10, 0),
      line('2026-10-29T06:10:00Z', 50, 5, 1000),
    ])
    utimesSync(path, new Date(), new Date(Date.now() + 1000))
    const report = readTokenUsage({ roots: [cli, ide], cachePath, now: new Date('2026-10-29T12:00:00+08:00').getTime() })
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
