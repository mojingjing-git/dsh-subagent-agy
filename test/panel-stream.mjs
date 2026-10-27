#!/usr/bin/env node
/**
 * S3 checks: the panel's resume path actually streams and records.
 *
 *   node test/panel-stream.mjs
 *
 * Drives `provider.startPanelRun()` (the entry the route calls) against the
 * fake agy CLI: proves the argv carries `--conversation`, that text arrives
 * through the same parser the background path uses, that the tool name surfaces,
 * and that the task registry now records the model.
 */
import assert from 'node:assert/strict'
import { bootPlugin } from './harness.mjs'

process.env.FAKE_AGY_SCENARIO = 'tool-then-answer'

const boot = await bootPlugin({ model: 'gemini-3.8-flash-high' }, {})
try {
  const provider = boot.provider()
  assert.ok(provider, 'provider registered')
  assert.equal(typeof provider.startPanelRun, 'function', 'startPanelRun exists')

  const handle = await provider.startPanelRun({
    sessionId: 'panel:agy',
    baseCwd: boot.workdir,
    label: '面板续跑',
    prompt: 'continue please',
    conversationId: 'fake-conversation-0001',
    cwd: boot.workdir,
  })

  let text = ''
  const pump = setInterval(() => { text += handle.readOutput() }, 40)
  const outcome = await handle.done
  clearInterval(pump)
  text += handle.readOutput()

  const spawn = boot.subprocess.spawned.filter((h) => h.argv.includes('--conversation')).pop()
  assert.ok(spawn, 'a --conversation spawn happened')
  assert.ok(spawn.argv.includes('fake-conversation-0001'), `argv: ${spawn.argv.join(' ')}`)
  assert.ok(spawn.argv.includes('--output-format') && spawn.argv.includes('stream-json'), 'stream-json requested')

  assert.equal(outcome.status, 'completed', JSON.stringify(outcome))
  assert.match(text, /Hello from agy\./, `streamed text: ${text.slice(0, 300)}`)
  assert.equal(handle.tool?.(), 'write_file', 'tool name surfaces for the panel')

  // The run must be visible to the tasks tool while it is live; here it has
  // already settled, so the assertion is that it is no longer listed.
  assert.equal(provider.listActive().length, 0, 'settled run is released')

  const records = boot.taskRegistry()
  const record = Object.values(records)[0]
  assert.ok(record, 'a task record was written')
  assert.equal(record.conversationId, 'fake-conversation-0001')
  assert.equal(record.model, 'gemini-3.8-flash-high', 'model is recorded for the panel list')

  console.log('  ok  startPanelRun resumes with --conversation + stream-json')
  console.log('  ok  text streams through the shared parser')
  console.log(`  ok  model recorded in the task registry`)
  console.log('\n4 checks passed')
} finally {
  boot.dispose()
  boot.cleanup()
}
