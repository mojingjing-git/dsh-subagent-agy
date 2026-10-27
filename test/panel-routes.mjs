#!/usr/bin/env node
/**
 * S2 checks: the panel's six JSON routes, driven through a fake web server.
 *
 *   node test/panel-routes.mjs
 *
 * No DSH and no agy: the routes only ever see the injected deps, so this proves
 * the HTTP contract (status codes, envelopes, streaming cursor, cancel) in
 * isolation. The real agy path is exercised by S3 against the CLI.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { registerAgyPanel } from '../lib/agy-panel.js'
import { UsageReader, GEMINI_FAMILY } from '../lib/agy-usage.js'

const scratch = mkdtempSync(join(tmpdir(), 'agy-routes-'))
const projectDir = join(scratch, 'project')
mkdirSync(projectDir, { recursive: true })

const conversationId = '73833e31-1111-2222-3333-444444444444'
mkdirSync(join(scratch, 'conversations'), { recursive: true })
writeFileSync(join(scratch, 'conversations', `${conversationId}.db`), '{"model":"gemini-3.8-flash-high"}', 'latin1')

const SAMPLES = [
  'Gemini Models\tWeekly Limit Remaining\t80%\t2026-10-29T10:17:27Z',
  'Gemini Models\tFive Hour Limit Remaining\t95%\t2026-10-27T06:12:16Z',
  'Claude and GPT models\tWeekly Limit Remaining\t82%\t2026-10-30T18:06:16Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-27T07:03:17Z',
].join('\n')

const routes = new Map()
const warnings = []
const fakeCtx = {
  logger: { warn: (message) => warnings.push(message) },
  inject(names, callback) {
    assert.deepEqual(names, ['webServer'])
    callback({ webServer: { register: (route) => routes.set(route.path, route) } })
  },
}

const usageReader = new UsageReader({
  runner: async () => SAMPLES,
  cachePath: join(scratch, 'usage.json'),
  badgeFamily: GEMINI_FAMILY,
})

let running = false
let cancelled = false
let pendingText = ''
let toolName = null
let resolveDone
const done = new Promise((resolve) => { resolveDone = resolve })
const handle = {
  cancel: () => { cancelled = true },
  done,
  readOutput: () => { const t = pendingText; pendingText = ''; return t },
  tool: () => toolName,
}

const deps = {
  sessionId: 'panel:agy',
  baseCwd: projectDir,
  conversationsDir: join(scratch, 'conversations'),
  annotationsDir: join(scratch, 'annotations'),
  prefsPath: join(scratch, 'panel.json'),
  loadRecords: () => ({
    'test-session::agy::1': { conversationId: 'fake-conversation-0001', cwd: projectDir, label: 'fake', createdAt: 1 },
    'session-a::agy::1': { conversationId, cwd: projectDir, label: '独立审核执行计划', createdAt: 1000, model: 'gemini-3.8-flash-high' },
  }),
  listActive: () => (running ? [{ task: 'panel-1', label: 'x', cwd: projectDir, background: true, startedAt: Date.now() }] : []),
  peekUsage: () => usageReader.peek(),
  readUsage: (force) => usageReader.read(force),
  startRun: async (input) => {
    assert.equal(input.conversationId, conversationId)
    assert.equal(input.cwd, projectDir)
    running = true
    return handle
  },
}

registerAgyPanel(fakeCtx, deps)
assert.deepEqual([...routes.keys()].sort(), [
  '/api-agy/cancel',
  '/api-agy/continue',
  '/api-agy/conversations',
  '/api-agy/prefs',
  '/api-agy/run',
  '/api-agy/running',
  '/api-agy/usage',
])
for (const route of routes.values()) assert.equal(route.kind, 'exact')

async function call(path, body) {
  const route = routes.get(path)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    end(text) { this.body = text },
  }
  await route.handler(req, res)
  return { status: res.status, json: JSON.parse(res.body) }
}

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

try {
  await check('usage answers instantly with a loading placeholder, then the snapshot', async () => {
    const first = await call('/api-agy/usage', {})
    assert.equal(first.status, 200)
    assert.equal(first.json.ok, true)
    assert.equal(first.json.loading, true)
    await usageReader.read()
    const second = await call('/api-agy/usage', {})
    assert.equal(second.json.loading, false)
    assert.equal(second.json.rows.length, 4)
    assert.equal(second.json.badge.percent, 95)
  })

  await check('GET is rejected', async () => {
    const route = routes.get('/api-agy/usage')
    const req = Readable.from([])
    req.method = 'GET'
    const res = { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true }, end(t) { this.body = t } }
    await route.handler(req, res)
    assert.equal(res.status, 405)
  })

  await check('conversations drop fake rows and carry model + cwd state', async () => {
    const { status, json } = await call('/api-agy/conversations', {})
    assert.equal(status, 200)
    assert.equal(json.items.length, 1)
    assert.equal(json.items[0].conversationId, conversationId)
    assert.equal(json.items[0].label, '独立审核执行计划')
    assert.equal(json.items[0].model, 'gemini-3.8-flash-high')
    assert.equal(json.items[0].cwdExists, true)
  })

  await check('continue rejects an unknown conversation', async () => {
    const { status, json } = await call('/api-agy/continue', { conversationId: 'nope', prompt: 'hi' })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
  })

  await check('continue rejects an empty prompt', async () => {
    const { status } = await call('/api-agy/continue', { conversationId, prompt: '   ' })
    assert.equal(status, 400)
  })

  let firstRunId = ''

  await check('continue starts a run and run streams text with a cursor', async () => {
    const started = await call('/api-agy/continue', { conversationId, prompt: '继续' })
    assert.equal(started.status, 200)
    assert.equal(started.json.ok, true)
    const { runId } = started.json
    assert.match(runId, /^panel-/)
    firstRunId = runId

    pendingText = '第一段\n'
    toolName = 'read_file'
    await new Promise((resolve) => setTimeout(resolve, 350))
    const first = await call('/api-agy/run', { runId, since: 0 })
    assert.equal(first.json.status, 'running')
    assert.equal(first.json.text, '第一段\n')
    assert.equal(first.json.tool, 'read_file')
    assert.equal(first.json.cursor, '第一段\n'.length)

    pendingText = '第二段\n'
    await new Promise((resolve) => setTimeout(resolve, 350))
    const second = await call('/api-agy/run', { runId, since: first.json.cursor })
    assert.equal(second.json.text, '第二段\n')
    assert.equal(second.json.cursor, first.json.cursor + '第二段\n'.length)

    const dup = await call('/api-agy/continue', { conversationId, prompt: 'again' })
    assert.equal(dup.status, 409)
  })

  await check('an out-of-range cursor asks the client to reset', async () => {
    const { json } = await call('/api-agy/run', { runId: firstRunId, since: 999_999 })
    assert.equal(json.reset, true)
    assert.equal(json.text, '第一段\n第二段\n')
    assert.equal(json.cursor, '第一段\n第二段\n'.length)
  })

  await check('cancel flips the run to cancelled and calls the handle', async () => {
    const cancelledRes = await call('/api-agy/cancel', { runId: firstRunId })
    assert.equal(cancelledRes.json.ok, true)
    assert.equal(cancelled, true)
    const after = await call('/api-agy/run', { runId: firstRunId, since: 0 })
    assert.equal(after.json.status, 'cancelled')
    // Once it is not running, the conversation can be resumed again.
    const again = await call('/api-agy/continue', { conversationId, prompt: '再来' })
    assert.equal(again.status, 200)
  })

  await check('done settles the run and drops it from the running list', async () => {
    running = false
    resolveDone({ status: 'completed', detail: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const runningList = await call('/api-agy/running', {})
    assert.equal(runningList.json.count, 0)
  })

  await check('prefs hide removes a row', async () => {
    const hidden = await call('/api-agy/prefs', { hide: conversationId })
    assert.deepEqual(hidden.json.hidden, [conversationId])
    const listed = await call('/api-agy/conversations', {})
    assert.equal(listed.json.items.length, 0)
    const shown = await call('/api-agy/prefs', { show: conversationId })
    assert.deepEqual(shown.json.hidden, [])
    assert.equal(JSON.parse(readFileSync(join(scratch, 'panel.json'), 'utf8')).hidden.length, 0)
  })
} finally {
  resolveDone?.({ status: 'completed', detail: 'completed' })
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed`)
