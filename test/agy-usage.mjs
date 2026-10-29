#!/usr/bin/env node
/**
 * Usage-reader checks:
 *
 *   node test/agy-usage.mjs
 *
 * 额度探测要十秒，所以刷新必须是后台的、而且必须真的会刷新：早先
 * `peek()` 直接把内存快照原样返回，`stale` 永远停在第一次的 false，
 * 于是自动刷新分支再也进不去，面板上的百分比几十分钟不动。这里把
 * 那条规则钉死。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { UsageReader } = await import('../lib/agy-usage.js')

let passed = 0
// The checks run one after another: several of them wait for a probe, and a
// later check must not read the reader while an earlier one is still running.
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const USAGE_OUTPUT = [
  'Gemini Models\tWeekly Limit Remaining\t63%\t2026-10-29T10:17:27Z',
  'Gemini Models\tFive Hour Limit Remaining\t67%\t2026-10-29T02:38:40Z',
  'Claude and GPT models\tWeekly Limit Remaining\t82%\t2026-10-30T18:06:16Z',
  '',
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'agy-usage-test-'))

try {
  let probes = 0
  const reader = new UsageReader({
    cachePath: join(dir, 'usage-cache.json'),
    runner: async () => {
      probes += 1
      return USAGE_OUTPUT
    },
    badgeFamily: 'Gemini Models',
    ttlMs: 60_000,
  })

  await check('an empty cache reads as nothing', () => {
    assert.equal(reader.peek(), null)
    assert.equal(probes, 0)
  })

  await check('the first read asks agy and returns the quotas', async () => {
    const report = await reader.read()
    assert.equal(probes, 1)
    assert.equal(report.rows.length, 3)
    assert.equal(report.stale, false)
    assert.equal(report.badge.percent, 67)
    assert.equal(report.badge.window, 'Five Hour Limit Remaining')
  })

  await check('a fresh snapshot is not stale', () => {
    const report = reader.peek()
    assert.equal(report.stale, false)
  })

  await check('a read inside the TTL does not ask agy again', async () => {
    await reader.read()
    assert.equal(probes, 1)
  })

  await check('a snapshot that grew old turns stale on its own', async () => {
    const aging = new UsageReader({
      cachePath: join(dir, 'usage-cache-2.json'),
      runner: async () => USAGE_OUTPUT,
      badgeFamily: 'Gemini Models',
      ttlMs: 200,
    })
    await aging.read()
    assert.equal(aging.peek().stale, false)
    await new Promise((resolve) => setTimeout(resolve, 260))
    assert.equal(aging.peek().stale, true)
  })

  await check('an old snapshot makes the next read ask agy again', async () => {
    let calls = 0
    const aging = new UsageReader({
      cachePath: join(dir, 'usage-cache-3.json'),
      runner: async () => {
        calls += 1
        return USAGE_OUTPUT
      },
      badgeFamily: 'Gemini Models',
      ttlMs: 200,
    })
    await aging.read()
    await new Promise((resolve) => setTimeout(resolve, 260))
    await aging.read()
    assert.equal(calls, 2)
  })

  await check('a forced read asks agy even when the snapshot is fresh', async () => {
    const before = probes
    await reader.read(true)
    assert.equal(probes, before + 1)
  })

  await check('a failing probe keeps the last snapshot and marks it stale', async () => {
    const failing = new UsageReader({
      cachePath: join(dir, 'usage-cache-4.json'),
      runner: async () => {
        throw new Error('agy is not logged in')
      },
      badgeFamily: 'Gemini Models',
      ttlMs: 60_000,
    })
    await failing.read()
    assert.equal(failing.peek().rows.length, 0)
    assert.equal(failing.peek().stale, true)
    assert.match(failing.peek().error, /not logged in/)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed`)
