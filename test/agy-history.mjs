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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { readConversationHistory, looksLikeModelName } = await import('../lib/agy-history.js')

let passed = 0
const check = (name, fn) => {
  fn()
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

  check('the conversation comes back with its steps', () => {
    assert.equal(history.source, 'database')
    assert.equal(history.stepCount, 3)
    assert.equal(history.steps.length, 3)
  })

  check('the prompt is the text of the user_input step', () => {
    assert.equal(history.steps[0].type, 'user_input')
    assert.equal(history.steps[0].text, 'Please clean up the leftovers.')
  })

  check('the reply body comes from the step payload, not from gen_metadata', () => {
    assert.equal(history.steps[1].type, 'agent_response')
    assert.equal(
      history.steps[1].text,
      'Begin by identifying the first task: edit the configuration file.',
    )
    assert.ok(!looksLikeModelName(history.steps[1].text))
  })

  check('a tool step keeps its name, arguments and summary', () => {
    const step = history.steps[2]
    assert.equal(step.type, 'tool')
    assert.equal(step.state, 'DONE')
    assert.equal(step.tool.parameters.toolSummary, 'Inspect file start and line endings')
  })

  check('a missing conversation yields an empty timeline instead of an error', async () => {
    const missing = await readConversationHistory('99999999-8888-7777-6666-555555555555', dir)
    assert.equal(missing.source, 'missing')
    assert.deepEqual(missing.steps, [])
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

check('looksLikeModelName recognises a model name and leaves prose alone', () => {
  assert.equal(looksLikeModelName('Gemini 3.8 Flash (High)'), true)
  assert.equal(looksLikeModelName('claude sonnet 4'), true)
  assert.equal(looksLikeModelName(''), true)
  assert.equal(looksLikeModelName('The file is three lines long.'), false)
})

console.log(`\n${passed} checks passed`)
