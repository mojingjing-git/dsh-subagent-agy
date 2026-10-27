#!/usr/bin/env node
/**
 * Step-event checks:
 *
 *   node test/agy-steps.mjs
 *
 * 步骤解析是纯函数，不碰磁盘也不起 agy，所以这里可以逐字段钉死。
 */
import assert from 'node:assert/strict'

const { parseStepUpdate, mergeStep, mergeStepInto } = await import('../lib/agy-steps.js')

let passed = 0
const check = (name, fn) => {
  const out = fn()
  if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
    throw new Error(`async assertion passed to sync check() (unawaited): ${name}`)
  }
  passed += 1
  console.log(`  ok  ${name}`)
}

check('parseStepUpdate reads index, state, tool info, duration and usage', () => {
  const step = parseStepUpdate({
    step_index: 3,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'read_file',
    tool_info: { name: 'read_file', parameters: { Path: 'probe.txt' } },
    duration_seconds: 1.25,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
  assert.equal(step.index, 3)
  assert.equal(step.state, 'DONE')
  assert.equal(step.type, 'tool')
  assert.equal(step.tool.name, 'read_file')
  assert.deepEqual(step.tool.parameters, { Path: 'probe.txt' })
  assert.equal(step.durationSeconds, 1.25)
  assert.deepEqual(step.usage, { input_tokens: 10, output_tokens: 5 })
})

check('parseStepUpdate ignores a payload without a step index', () => {
  assert.equal(parseStepUpdate({ state: 'DONE', step_type: 'tool' }), undefined)
  assert.equal(parseStepUpdate(null), undefined)
  assert.equal(parseStepUpdate('nonsense'), undefined)
  assert.equal(parseStepUpdate({ step_index: 'x' }), undefined)
})

check('parseStepUpdate keeps an agent response text as it arrives', () => {
  const step = parseStepUpdate({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'OK' })
  assert.equal(step.text, 'OK')
  assert.equal(step.tool, null)
  assert.equal(step.durationSeconds, null)
  assert.equal(step.usage, null)
})

check('a DONE tool step keeps its error field', () => {
  const step = parseStepUpdate({
    step_index: 2,
    state: 'ERROR',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'ls' },
      error: { type: 'TOOL_ERROR', message: 'permission check failed' },
    },
  })
  assert.equal(step.state, 'ERROR')
  assert.equal(step.tool.error, 'permission check failed')
})

check('mergeStep keeps one entry per index and upgrades ACTIVE to DONE', () => {
  const active = parseStepUpdate({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' })
  const done = parseStepUpdate({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.5 })
  const merged = mergeStep(active, done)
  assert.equal(merged.state, 'DONE')
  assert.equal(merged.durationSeconds, 0.5)
  assert.equal(merged.index, 2)
})

check('mergeStep never moves a state backwards', () => {
  const done = parseStepUpdate({ step_index: 2, state: 'DONE', step_type: 'tool' })
  const late = parseStepUpdate({ step_index: 2, state: 'ACTIVE', step_type: 'tool' })
  assert.equal(mergeStep(done, late).state, 'DONE')
})

check('mergeStep appends the incremental text of one step', () => {
  const first = parseStepUpdate({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'O' })
  const second = parseStepUpdate({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'K' })
  assert.equal(mergeStep(first, second).text, 'OK')
})

check('mergeStepInto appends new steps and keeps them ordered by index', () => {
  let steps = []
  steps = mergeStepInto(steps, parseStepUpdate({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command' }))
  steps = mergeStepInto(steps, parseStepUpdate({ step_index: 0, state: 'DONE', step_type: 'user_input' }))
  assert.deepEqual(steps.map((s) => s.index), [0, 2])
  steps = mergeStepInto(steps, parseStepUpdate({ step_index: 2, state: 'ACTIVE', step_type: 'tool' }))
  assert.equal(steps.length, 2)
  assert.equal(steps.find((s) => s.index === 2).state, 'DONE')
})

check('steps survive a malformed payload', () => {
  assert.doesNotThrow(() => parseStepUpdate(undefined))
  assert.doesNotThrow(() => parseStepUpdate({ step_index: 1, usage: 'not-a-number' }))
  assert.doesNotThrow(() => parseStepUpdate({ step_index: 1, tool_info: 'not-an-object' }))
})

console.log(`\n${passed} checks passed`)
