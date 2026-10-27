#!/usr/bin/env node
/**
 * S1 checks: the panel's two data sources.
 *
 *   node test/panel-sources.mjs
 *
 * Pure-parser checks plus a real scratch filesystem for the conversation list,
 * so the "fake registry rows must not show up" rule is exercised for real.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageReader, parseUsage, familyOfModel, pickBadge, GEMINI_FAMILY, FIVE_HOUR } from '../lib/agy-usage.js'
import { listConversations, lastModelIn, titleFromAnnotations } from '../lib/agy-conversations.js'

const SAMPLES = [
  'Gemini Models\tWeekly Limit Remaining\t80%\t2026-10-29T10:17:27Z',
  'Gemini Models\tFive Hour Limit Remaining\t95%\t2026-10-27T06:12:16Z',
  'Claude and GPT models\tWeekly Limit Remaining\t82%\t2026-10-30T18:06:16Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-27T07:03:17Z',
].join('\r\n')

let passed = 0
const check = (name, fn) => {
  try {
    const out = fn()
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
      throw new Error(`async assertion passed to sync check() (unawaited): ${name}`)
    }
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

console.log('parseUsage')
check('four rows, TSV, trailing CRLF tolerated', () => {
  const rows = parseUsage(`${SAMPLES}\r\n`)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0], {
    family: 'Gemini Models',
    window: 'Weekly Limit Remaining',
    percent: 80,
    resetAt: '2026-10-29T10:17:27Z',
  })
  assert.equal(rows[1].percent, 95)
})
check('ignores a banner line without a percentage', () => {
  const rows = parseUsage(`Fetching usage…\n${SAMPLES}`)
  assert.equal(rows.length, 4)
})
check('falls back to runs of spaces when tabs are lost', () => {
  const rows = parseUsage('Gemini Models    Five Hour Limit Remaining    91%    2026-10-27T06:12:16Z')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].percent, 91)
})
check('empty output → no rows', () => {
  assert.deepEqual(parseUsage(''), [])
})

console.log('badge')
check('gemini-3.8-flash-high belongs to the Gemini family', () => {
  assert.equal(familyOfModel('gemini-3.8-flash-high'), GEMINI_FAMILY)
  assert.equal(familyOfModel('claude-sonnet-4'), 'Claude and GPT models')
})
check('badge is the five-hour row of the configured family', () => {
  const badge = pickBadge(parseUsage(SAMPLES), familyOfModel('gemini-3.8-flash-high'))
  assert.ok(badge)
  assert.equal(badge.window, FIVE_HOUR)
  assert.equal(badge.percent, 95)
})
check('unknown family falls back to any five-hour row', () => {
  const badge = pickBadge(parseUsage(SAMPLES), 'Qwen')
  assert.ok(badge)
  assert.equal(badge.window, FIVE_HOUR)
})

console.log('UsageReader')
const scratch = mkdtempSync(join(tmpdir(), 'agy-sources-'))
try {
  await checkAsync('concurrent reads share one probe', async () => {
    let calls = 0
    const reader = new UsageReader({
      runner: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
        return SAMPLES
      },
      cachePath: join(scratch, 'usage.json'),
      badgeFamily: GEMINI_FAMILY,
    })
    const [a, b, c] = await Promise.all([reader.read(), reader.read(), reader.read()])
    assert.equal(calls, 1)
    assert.equal(a.rows.length, 4)
    assert.equal(b.badge.percent, 95)
    assert.equal(c.badge.percent, 95)
    // Second read inside the TTL must not spawn again.
    await reader.read()
    assert.equal(calls, 1)
  })

  await checkAsync('a failing probe degrades to the last snapshot', async () => {
    let calls = 0
    const reader = new UsageReader({
      runner: async () => {
        calls += 1
        if (calls === 1) return SAMPLES
        throw new Error('agy exploded')
      },
      cachePath: join(scratch, 'usage-stale.json'),
      badgeFamily: GEMINI_FAMILY,
    })
    await reader.read()
    const stale = await reader.read(true)
    assert.equal(stale.stale, true)
    assert.equal(stale.error, 'agy exploded')
    assert.equal(stale.badge?.percent, 95)
  })

  await checkAsync('a fresh process picks the snapshot up from disk without probing', async () => {
    const cachePath = join(scratch, 'usage-disk.json')
    let calls = 0
    const first = new UsageReader({
      runner: async () => {
        calls += 1
        return SAMPLES
      },
      cachePath,
      badgeFamily: GEMINI_FAMILY,
    })
    await first.read()
    const second = new UsageReader({
      runner: async () => {
        throw new Error('must not probe')
      },
      cachePath,
      badgeFamily: GEMINI_FAMILY,
    })
    const peeked = second.peek()
    assert.ok(peeked)
    assert.equal(peeked.badge?.percent, 95)
    assert.equal(peeked.stale, false)
    assert.equal(calls, 1)
  })

  console.log('listConversations')
  const geminiDir = join(scratch, 'gemini')
  const conversationsDir = join(geminiDir, 'conversations')
  const annotationsDir = join(geminiDir, 'annotations')
  mkdirSync(conversationsDir, { recursive: true })
  mkdirSync(annotationsDir, { recursive: true })
  const projectDir = join(scratch, 'project')
  mkdirSync(projectDir, { recursive: true })

  const realId = '73833e31-aaaa-bbbb-cccc-000000000001'
  writeFileSync(join(conversationsDir, `${realId}.db`), [
    'meta', '{"model":"gemini-3.8-flash-n"}', 'x', '{"model":"gemini-3.8-flash-high"}',
  ].join('\n'), 'latin1')
  writeFileSync(join(annotationsDir, `${realId}.pbtxt`), 'title:"注释标题"\n')

  const olderId = '73833e31-aaaa-bbbb-cccc-000000000002'
  writeFileSync(join(conversationsDir, `${olderId}.db`), '{"model":"gemini-3.8-flash-high"}', 'latin1')

  check('last occurrence wins over the frequent helper model', () => {
    assert.equal(lastModelIn(Buffer.from('gemini-3.8-flash-n '.repeat(5) + 'gemini-3.8-flash-high')), 'gemini-3.8-flash-high')
  })
  check('annotation title is unescaped', () => {
    assert.equal(titleFromAnnotations(annotationsDir, realId), '注释标题')
  })

  check('fake registry rows are dropped, real ones de-duplicated', () => {
    const items = listConversations({
      records: {
        // Test-suite pollution: no .db on disk → must not appear.
        'test-session::agy::1': { conversationId: 'fake-conversation-0001', cwd: projectDir, label: 'unknown event', createdAt: 1 },
        // Same real conversation twice (a resume): one row, newest wins.
        [`session-a::agy::1`]: { conversationId: realId, cwd: projectDir, label: '旧标题', createdAt: 1000 },
        [`session-a::agy::2`]: { conversationId: realId, cwd: projectDir, label: '新标题', createdAt: 2000, model: 'gemini-3.8-flash-high' },
        [`session-b::agy::1`]: { conversationId: olderId, cwd: join(scratch, 'gone'), label: '', createdAt: 500 },
      },
      conversationsDir,
      annotationsDir,
    })
    assert.equal(items.length, 2)
    assert.equal(items[0].conversationId, realId)
    assert.equal(items[0].label, '新标题')
    assert.equal(items[0].createdAt, 2000)
    assert.equal(items[0].model, 'gemini-3.8-flash-high')
    assert.equal(items[0].cwdExists, true)
    assert.equal(items[1].conversationId, olderId)
    // Empty label falls back to the annotation, then to a short id.
    assert.equal(items[1].label, 'agy · 73833e31')
    assert.equal(items[1].model, 'gemini-3.8-flash-high')
    assert.equal(items[1].cwdExists, false)
  })

  check('hidden conversations stay hidden', () => {
    const items = listConversations({
      records: {
        [`session-a::agy::2`]: { conversationId: realId, cwd: projectDir, label: 'x', createdAt: 2000 },
      },
      conversationsDir,
      annotationsDir,
      hidden: [realId],
    })
    assert.equal(items.length, 0)
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed`)
