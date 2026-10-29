#!/usr/bin/env node
/**
 * Transcript checks:
 *
 *   node test/agy-transcript.mjs
 *
 * agy 自己的 transcript 是明文 JSONL，这里用一份假的会话目录把映射规则
 * 钉死：哪一行变成哪种步骤、工具参数怎么解、token 算在哪一步。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { parseTranscript, readTranscript, transcriptToSteps, sumUsage } = await import('../lib/agy-transcript.js')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const LINES = [
  JSON.stringify({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-10-24T23:13:51Z',
    content: '请清理一下残留文件。',
  }),
  JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-10-24T23:13:52Z',
    input_tokens: 8415,
    cache_read_tokens: 1024,
    output_tokens: 567,
    thinking: '先看看目录里有什么。',
    tool_calls: [
      {
        name: 'run_command',
        args: { CommandLine: '"dir /a"', WaitMsBeforeAsync: '5000', toolSummary: '"List directory contents"' },
      },
    ],
  }),
  JSON.stringify({
    step_index: 2,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-10-24T23:13:57Z',
    content: 'Command exited with code 0.\n\nDirectory listing …',
  }),
  JSON.stringify({
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-10-24T23:14:10Z',
    input_tokens: 9000,
    cache_read_tokens: 0,
    output_tokens: 1200,
    content: '已经清理完毕，共删除 3 个文件。',
  }),
]

const dir = mkdtempSync(join(tmpdir(), 'agy-transcript-test-'))
const brain = join(dir, 'brain')
const logDir = join(brain, CONVERSATION, '.system_generated', 'logs')
mkdirSync(logDir, { recursive: true })
writeFileSync(join(logDir, 'transcript.jsonl'), `${LINES.join('\n')}\n`, 'utf8')

try {
  const rows = parseTranscript(LINES.join('\n'))

  check('every line becomes one row with its own index', () => {
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map((row) => row.index), [0, 1, 2, 3])
    assert.equal(rows[0].type, 'USER_INPUT')
    assert.equal(rows[1].type, 'PLANNER_RESPONSE')
  })

  check('a broken line is skipped, the rest survives', () => {
    const parsed = parseTranscript(`${LINES[0]}\n{not json\n${LINES[1]}`)
    assert.equal(parsed.length, 2)
  })

  check('the token counters and the timestamp are read', () => {
    assert.equal(rows[1].inputTokens, 8415)
    assert.equal(rows[1].outputTokens, 567)
    assert.equal(rows[1].cacheReadTokens, 1024)
    assert.equal(rows[1].createdAt, '2026-10-24T23:13:52Z')
    assert.equal(rows[0].inputTokens, null)
  })

  check('the tool arguments are decoded one level of JSON', () => {
    const call = rows[1].toolCalls[0]
    assert.equal(call.name, 'run_command')
    assert.equal(call.parameters.CommandLine, 'dir /a')
    assert.equal(call.parameters.toolSummary, 'List directory contents')
    assert.equal(call.parameters.WaitMsBeforeAsync, 5000)
  })

  const steps = transcriptToSteps(rows)

  check('one row is one step, and the types are agy’s own', () => {
    assert.equal(steps.length, 4)
    assert.deepEqual(steps.map((step) => step.type), ['user_input', 'agent_response', 'tool', 'agent_response'])
    assert.deepEqual(steps.map((step) => step.index), [0, 1, 2, 3])
  })

  check('the prompt is the text of the user step', () => {
    assert.equal(steps[0].text, '请清理一下残留文件。')
  })

  check('the reply wins over the reasoning', () => {
    assert.equal(steps[3].text, '已经清理完毕，共删除 3 个文件。')
    assert.equal(steps[1].text, '先看看目录里有什么。')
    assert.equal(steps[1].thinking, '先看看目录里有什么。')
  })

  check('the tool step borrows the call from the step above', () => {
    assert.equal(steps[2].tool.name, 'run_command')
    assert.equal(steps[2].tool.parameters.CommandLine, 'dir /a')
    assert.match(steps[2].text, /Directory listing/)
  })

  check('the tokens sit on the step that produced them', () => {
    assert.equal(steps[1].usage.input_tokens, 8415)
    assert.equal(steps[1].usage.cache_read_tokens, 1024)
    assert.equal(steps[2].usage, null)
  })

  check('the timestamp becomes the time of the step', () => {
    assert.equal(steps[0].at, Date.parse('2026-10-24T23:13:51Z'))
    assert.equal(steps[3].at, Date.parse('2026-10-24T23:14:10Z'))
  })

  check('the totals sum the counters up', () => {
    const totals = sumUsage(steps)
    assert.equal(totals.inputTokens, 8415 + 9000)
    assert.equal(totals.outputTokens, 567 + 1200)
    assert.equal(totals.cacheReadTokens, 1024)
  })

  check('a conversation without a transcript reads as null', async () => {
    assert.equal(await readTranscript('99999999-8888-7777-6666-555555555555', brain), null)
    assert.equal(await readTranscript('not-a-conversation-id', brain), null)
  })

  check('a conversation with a transcript reads back', async () => {
    const read = await readTranscript(CONVERSATION, brain)
    assert.equal(read.length, 4)
    assert.equal(read[0].content, '请清理一下残留文件。')
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed`)
