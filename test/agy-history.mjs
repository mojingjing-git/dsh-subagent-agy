#!/usr/bin/env node
/**
 * History checks:
 *
 *   node test/agy-history.mjs
 *
 * 一个用内存 sqlite 造出来的假会话库，钉死"回复正文来自 step_payload，
 * 而不是 gen_metadata 里的模型名"这条规则 —— agy 的库长这样，不造一个
 * 就只能靠真实数据碰运气。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { readConversationHistory, looksLikeModelName } = await import('../lib/agy-history.js')

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** One protobuf string field — what agy writes into its blobs. */
function encodeString(text) {
  const bytes = new TextEncoder().encode(text)
  const head = [0x0a]
  let length = bytes.length
  while (length > 127) {
    head.push((length & 0x7f) | 0x80)
    length >>>= 7
  }
  head.push(length)
  return Uint8Array.from([...head, ...bytes])
}

const dir = mkdtempSync(join(tmpdir(), 'agy-history-test-'))
const conversationId = '11111111-2222-3333-4444-555555555555'

try {
  const db = new DatabaseSync(join(dir, `${conversationId}.db`))
  db.exec(`
    create table steps (
      idx integer primary key,
      step_type integer,
      status integer,
      metadata blob,
      error_details blob,
      render_info blob,
      step_payload blob
    );
    create table gen_metadata (idx integer primary key, data blob);
  `)
  const insertStep = db.prepare(
    'insert into steps (idx, step_type, status, metadata, error_details, render_info, step_payload) values (?, ?, ?, ?, ?, ?, ?)',
  )
  // 0: the prompt, 1: the reply, 2: the tool call.
  insertStep.run(0, 14, 3, null, null, null, encodeString('Please clean up the leftovers.'))
  insertStep.run(
    1,
    15,
    3,
    null,
    null,
    null,
    encodeString('Begin by identifying the first task: edit the configuration file.'),
  )
  insertStep.run(
    2,
    132,
    3,
    null,
    null,
    encodeString('Inspect file start and line endings'),
    encodeString('{"toolSummary":"Inspect file start and line endings"}'),
  )
  db.prepare('insert into gen_metadata (idx, data) values (?, ?)').run(
    0,
    encodeString('Gemini 3.8 Flash (High)'),
  )
  db.close()

  const history = await readConversationHistory(conversationId, dir)

  await check('the conversation comes back with its steps', () => {
    assert.equal(history.source, 'database')
    assert.equal(history.stepCount, 3)
    assert.equal(history.steps.length, 3)
  })

  await check('the prompt is the text of the user_input step', () => {
    assert.equal(history.steps[0].type, 'user_input')
    assert.equal(history.steps[0].text, 'Please clean up the leftovers.')
  })

  await check('the reply body comes from the step payload, not from gen_metadata', () => {
    assert.equal(history.steps[1].type, 'agent_response')
    assert.equal(
      history.steps[1].text,
      'Begin by identifying the first task: edit the configuration file.',
    )
    assert.ok(!looksLikeModelName(history.steps[1].text))
  })

  await check('a tool step keeps its name, arguments and summary', () => {
    const step = history.steps[2]
    assert.equal(step.type, 'tool')
    assert.equal(step.state, 'DONE')
    assert.equal(step.tool.parameters.toolSummary, 'Inspect file start and line endings')
  })

  await check('a missing conversation yields an empty timeline instead of an error', async () => {
    const missing = await readConversationHistory('99999999-8888-7777-6666-555555555555', dir)
    assert.equal(missing.source, 'missing')
    assert.deepEqual(missing.steps, [])
  })

  // A conversation agy ran twice keeps both runs in one transcript file and
  // restarts its step numbers, while the database numbers the whole
  // conversation continuously. The two cannot be lined up, and a reply next
  // to the wrong step is worse than no reply at all.
  await check('a conversation that was run twice is shown from the transcript alone', async () => {
    const brain = join(dir, 'brain')
    const logs = join(brain, conversationId, '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    const line = (stepIndex, type, content, extra = {}) => JSON.stringify({
      step_index: stepIndex,
      source: 'MODEL',
      type,
      status: 'DONE',
      created_at: '2026-10-29T01:16:00Z',
      content,
      ...extra,
    })
    writeFileSync(
      join(logs, 'transcript.jsonl'),
      [
        line(0, 'USER_INPUT', 'first run'),
        line(1, 'PLANNER_RESPONSE', 'first answer', { input_tokens: 100, output_tokens: 20 }),
        line(0, 'USER_INPUT', 'second run'),
        line(1, 'PLANNER_RESPONSE', 'second answer', { input_tokens: 300, output_tokens: 40 }),
      ].join('\n'),
      'utf8',
    )

    const withTranscript = await readConversationHistory(conversationId, dir, brain)
    assert.equal(withTranscript.source, 'transcript')
    assert.equal(withTranscript.steps.length, 4)
    assert.deepEqual(withTranscript.steps.map((step) => step.index), [0, 1, 2, 3])
    assert.deepEqual(withTranscript.steps.map((step) => step.round), [0, 0, 1, 1])
    assert.equal(withTranscript.steps[0].text, 'first run')
    assert.equal(withTranscript.steps[3].text, 'second answer')
    assert.deepEqual(withTranscript.totals, {
      inputTokens: 400,
      outputTokens: 60,
      cacheReadTokens: 0,
    })
  })

  // A copy that dies between "temp dir created" and "database opened" must
  // clean up after itself — the temp dir lives in the user's real tmpdir and
  // every leaked copy is 1–3 MB of conversation database nobody will free.
  await check('a failed database copy leaves no temp dir behind', async () => {
    const leaked = () => readdirSync(tmpdir()).filter((name) => name.startsWith('agy-history-'))
    const before = leaked()
    const blockedId = 'aaaaaaaa-0000-4000-8000-00000000000a'
    mkdirSync(join(dir, `${blockedId}.db`)) // a directory: readOnly open fails, the copy dies on EISDIR
    const result = await readConversationHistory(blockedId, dir)
    assert.equal(result.source, 'unreadable')
    const after = leaked()
    assert.deepEqual(after, before, JSON.stringify(after.filter((name) => !before.includes(name))))
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

await check('looksLikeModelName recognises a model name and leaves prose alone', () => {
  assert.equal(looksLikeModelName('Gemini 3.8 Flash (High)'), true)
  assert.equal(looksLikeModelName('claude sonnet 4'), true)
  assert.equal(looksLikeModelName(''), true)
  assert.equal(looksLikeModelName('The file is three lines long.'), false)
})

console.log(`\n${passed} checks passed`)
