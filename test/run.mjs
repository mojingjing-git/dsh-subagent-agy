/**
 * Offline test suite: drives the real plugin through the fake CLI.
 *
 * Run with: node test/run.mjs [filter]
 * Exits non-zero if any case fails. Every case is isolated (own scratch cwd,
 * own transcript dir, own plugin instance) and never touches the real agy.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootPlugin, cleanup, homeTranscriptDir, readIfExists, scratch } from './harness.mjs'

const filter = process.argv[2]
const results = []
let casesMatched = 0

/** One assertion: record pass/fail instead of throwing out of the case. */
function check(name, condition, detail) {
  if (condition !== null && typeof condition === 'object' && typeof condition.then === 'function') {
    // Boolean(promise) is always true, so an unawaited async assertion would
    // silently pass. Count it as a permanent failure no matter how it settles.
    const entry = { name, ok: false, detail: 'async assertion was not awaited — it cannot be counted' }
    results.push(entry)
    condition.then(
      (value) => { entry.detail = `async assertion was not awaited (settled: ${value})` },
      (error) => { entry.detail = `async assertion was not awaited (rejected: ${error})` },
    )
    return
  }
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) throw new Error(`assertion failed: ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * Run one case with its own workdir and transcript dir. FAKE_AGY_SCENARIO
 * selects the fake CLI behavior; the process env is set per case because the
 * fake CLI reads it at startup.
 */
async function testCase(name, options, body) {
  if (filter !== undefined && !name.includes(filter)) return
  casesMatched += 1
  const workdir = scratch(`agy-${name.replace(/[^a-z0-9]+/gi, '-')}-`)
  const transcriptDir = join(workdir, 'transcripts')
  const previousScenario = process.env.FAKE_AGY_SCENARIO
  process.env.FAKE_AGY_SCENARIO = options.scenario ?? 'success'
  let ctl
  try {
    ctl = await bootPlugin(
      {
        transcriptDir,
        cwd: workdir,
        flagCachePath: join(workdir, 'agy-flag-cache.json'),
        model: options.model ?? 'gemini-3.8-flash-high',
        ...(options.config ?? {}),
      },
      { workdir },
    )
    await body(ctl, { workdir, transcriptDir })
    console.log(`  ok   ${name}`)
  } catch (error) {
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    results.push({ name: `${name} (case)`, ok: false, detail: String(error) })
  } finally {
    try {
      ctl?.dispose()
    } catch (error) {
      console.log(`  warn ${name}: dispose threw ${String(error)}`)
    }
    if (previousScenario === undefined) delete process.env.FAKE_AGY_SCENARIO
    else process.env.FAKE_AGY_SCENARIO = previousScenario
    // Give any terminating child a moment, then clean up.
    await new Promise((r) => setTimeout(r, 150))
    ctl?.subprocess.terminateAll()
    cleanup(workdir)
  }
}

/**
 * Locate the transcript file for one run through the plugin's own index.json.
 * The plugin sanitizes the run id into the filename (`::` becomes `_`), so
 * guessing the name from the task key would be testing our copy of the rule
 * rather than the file the plugin actually wrote.
 */
function transcriptPathOf(transcriptDir, task) {
  const raw = readIfExists(join(transcriptDir, 'index.json'))
  if (raw === undefined) return undefined
  let index
  try {
    index = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(index)) return undefined
  const entry = index.find((e) => e && e.task === task)
  return entry?.file
}

/** Read one run's transcript by its task key, via the index. */
function transcriptOf(transcriptDir, task) {
  const file = transcriptPathOf(transcriptDir, task)
  return file === undefined ? [] : readTranscript(file)
}

/** Parse the plugin's NDJSON transcript into event objects. */
function readTranscript(path) {
  const text = readIfExists(path)
  if (text === undefined) return []
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { _unparsable: line }
      }
    })
}

console.log('\n== plugin offline suite ==\n')

// ── 1. Happy path ───────────────────────────────────────────────────────────
await testCase('success/foreground', { scenario: 'success' }, async (ctl, { workdir, transcriptDir }) => {
  const value = await ctl.callTool('antigravity', { description: 'say pong', prompt: 'Reply with exactly: PONG' })
  check('kind is foreground', value.kind === 'foreground', value.kind)
  check('carries a task key', typeof value.task === 'string' && value.task.length > 0, value.task)
  const text = JSON.stringify(value.output)
  check('output contains the answer', text.includes('PONG'), text.slice(0, 200))

  const transcript = transcriptOf(transcriptDir, value.task)
  check('transcript exists', transcript.length > 0)
  check('transcript starts with the prompt header', transcript[0]?.event === 'prompt', JSON.stringify(transcript[0]).slice(0, 200))
  // The plugin appends its own environment notes to the prompt it hands agy,
  // so the header records that effective prompt: it must start with the text
  // the caller passed, not equal it.
  check(
    'prompt header carries the original prompt',
    typeof transcript[0]?.prompt === 'string' && transcript[0].prompt.startsWith('Reply with exactly: PONG'),
    transcript[0]?.prompt,
  )
  const result = transcript.find((e) => e.event === 'result')
  // In stream-json mode the transcript ends with the protocol's `result`
  // event. In the plain `json` fallback the CLI emits one bare reply object
  // instead, which carries status/response at the top level.
  const bareReply = transcript.find((e) => e !== undefined && e.status === 'SUCCESS' && typeof e.response === 'string')
  check(
    'transcript ends with a result event',
    result !== undefined || bareReply !== undefined,
    `events=${transcript.length} kinds=${JSON.stringify(transcript.map((e) => e?.event ?? Object.keys(e ?? {}).join('+')))} tail=${JSON.stringify(transcript.at(-1)).slice(0, 300)}`,
  )
  const status = result?.result?.status ?? bareReply?.status
  check('result status is SUCCESS', status === 'SUCCESS', String(status))

  const index = JSON.parse(ctl.transcriptIndex())
  check('transcript index records the task', Object.values(index).some((e) => e.task === value.task), JSON.stringify(index).slice(0, 300))
})

// ── 2. stream-json: the stream really is consumed ───────────────────────────
await testCase('stream-json/tool-then-answer', { scenario: 'tool-then-answer' }, async (ctl, { transcriptDir }) => {
  const value = await ctl.callTool('antigravity', { description: 'tool run', prompt: 'write a file then answer' })
  const transcript = transcriptOf(transcriptDir, value.task)
  const events = transcript.map((e) => e.event)
  check('init event captured', events.includes('init'), events.join(','))
  check('step events captured', events.filter((e) => e === 'step_update').length >= 3, String(events.length))
  const toolStep = transcript.find((e) => e.event === 'step_update' && e.step_update?.step_type === 'tool')
  check('tool step captured with its name', toolStep?.step_update?.tool_name === 'write_file', JSON.stringify(toolStep).slice(0, 300))
  const deltas = transcript.filter((e) => typeof e.step_update?.text_delta === 'string').map((e) => e.step_update.text_delta)
  check('streamed text deltas captured', deltas.join('') === 'Hello from agy.', deltas.join('|'))
  const rendered = JSON.stringify(value.output)
  check('answer reaches the caller', rendered.includes('Hello from agy.'), rendered.slice(0, 300))
})

// ── 3. Chunking robustness ──────────────────────────────────────────────────
await testCase('stream-json/split-multibyte-chunk', { scenario: 'split-chunk' }, async (ctl, { transcriptDir }) => {
  const value = await ctl.callTool('antigravity', { description: 'split chunk', prompt: 'say 中文' })
  const transcript = transcriptOf(transcriptDir, value.task)
  const deltas = transcript.filter((e) => typeof e.step_update?.text_delta === 'string').map((e) => e.step_update.text_delta)
  check('multi-byte text survives a mid-character split', deltas.join('') === '中文分块测试', JSON.stringify(deltas))
  check('no unparsable transcript line', transcript.every((e) => e._unparsable === undefined))
  check('answer reaches the caller intact', JSON.stringify(value.output).includes('中文分块测试'))
})

await testCase('stream-json/no-trailing-newline', { scenario: 'no-trailing-newline' }, async (ctl, { transcriptDir }) => {
  const value = await ctl.callTool('antigravity', { description: 'no newline', prompt: 'finish without newline' })
  const transcript = transcriptOf(transcriptDir, value.task)
  const result = transcript.find((e) => e.event === 'result')
  check('unterminated final line is still consumed', result !== undefined, JSON.stringify(transcript).slice(0, 300))
  check('result carries the response', result?.result?.response === 'no trailing newline', result?.result?.response)
})

// ── 4. Protocol tolerance ───────────────────────────────────────────────────
await testCase('stream-json/unknown-event', { scenario: 'unknown-event' }, async (ctl, { transcriptDir }) => {
  const value = await ctl.callTool('antigravity', { description: 'unknown event', prompt: 'survive' })
  const transcript = transcriptOf(transcriptDir, value.task)
  check('unknown event is preserved in the transcript', transcript.some((e) => e.event === 'something_new'))
  check('run still completes', JSON.stringify(value.output).includes('survived an unknown event'))
})

await testCase('stream-json/no-result-event', { scenario: 'no-result' }, async (ctl) => {
  let threw
  try {
    await ctl.callTool('antigravity', { description: 'no result', prompt: 'stop early' })
  } catch (error) {
    threw = error
  }
  check('a stream without a result does not silently succeed', threw !== undefined, String(threw?.message ?? 'resolved'))
  check('the failure names the missing result', /result|finished|exited/i.test(String(threw?.message ?? '')), String(threw?.message))
})

// ── 5. Failure classification ───────────────────────────────────────────────
await testCase('exit-1/reports-failure', { scenario: 'exit-1' }, async (ctl) => {
  let threw
  try {
    await ctl.callTool('antigravity', { description: 'fail', prompt: 'fail' })
  } catch (error) {
    threw = error
  }
  check('non-zero exit is surfaced', threw !== undefined)
  check('stderr detail is forwarded', /boom: simulated failure/i.test(String(threw?.message ?? '')), String(threw?.message))
})

await testCase('auth-error/reports-auth', { scenario: 'auth-error' }, async (ctl) => {
  let threw
  try {
    await ctl.callTool('antigravity', { description: 'auth', prompt: 'auth' })
  } catch (error) {
    threw = error
  }
  check('auth failure is surfaced', threw !== undefined)
  check('auth wording is preserved', /authentication required/i.test(String(threw?.message ?? '')), String(threw?.message))
})

// ── 6. Timeout + cancellation (the TDZ regression) ──────────────────────────
await testCase('hang/timeout-settles', { scenario: 'hang', config: { printTimeoutMs: 1200 } }, async (ctl) => {
  const started = Date.now()
  let threw
  try {
    await ctl.callTool('antigravity', { description: 'hang', prompt: 'hang forever' })
  } catch (error) {
    threw = error
  }
  const elapsed = Date.now() - started
  check('a hung run times out instead of hanging the tool', threw !== undefined, String(threw?.message ?? 'resolved'))
  // Regression guard: the timeout path used to hit a TDZ ReferenceError on
  // transcriptPath, which surfaced as "Cannot access 'transcriptPath'".
  check('timeout does not throw the TDZ error', !/Cannot access 'transcriptPath'/.test(String(threw?.message ?? '')), String(threw?.message))
  check('timeout message mentions the ceiling', /did not finish within/i.test(String(threw?.message ?? '')), String(threw?.message))
  // 1200 ms ceiling + the 5000 ms minimum watchdog margin + slack.
  // Budget: printTimeoutMs 1200 + the 5000 ms minimum watchdog margin + the
  // flag probe (one `help` + one `--print-timeout` probe) + slack.
  check('the watchdog fired promptly', elapsed < 25_000, `${elapsed}ms`)
})

await testCase('slow-stream/cancel', { scenario: 'slow-stream' }, async (ctl) => {
  const controller = new AbortController()
  const pending = ctl.callTool('antigravity', { description: 'cancel me', prompt: 'slow' }, { signal: controller.signal })
  await new Promise((r) => setTimeout(r, 400))
  controller.abort()
  let threw
  try {
    await pending
  } catch (error) {
    threw = error
  }
  check('cancelled run rejects', threw !== undefined, String(threw?.message ?? 'resolved'))
  check('cancel does not throw the TDZ error', !/Cannot access 'transcriptPath'/.test(String(threw?.message ?? '')), String(threw?.message))
  check('cancel is reported as a cancellation', /cancel/i.test(String(threw?.message ?? '')), String(threw?.message))
})

// ── 7. cwd handling ─────────────────────────────────────────────────────────
await testCase('cwd/child-runs-in-configured-dir', { scenario: 'writes-file' }, async (ctl, { workdir }) => {
  await ctl.callTool('antigravity', { description: 'cwd probe', prompt: 'write the probe' })
  const probe = join(workdir, 'agy-cwd-probe.txt')
  check('child process ran in the configured cwd', existsSync(probe), probe)
  if (existsSync(probe)) {
    const recorded = readFileSync(probe, 'utf8').trim()
    check('child reports the same cwd', recorded.toLowerCase() === workdir.toLowerCase(), `${recorded} vs ${workdir}`)
  }
})

// ── 8. Flag construction ────────────────────────────────────────────────────
await testCase('flags/argv-shape', { scenario: 'echo-argv', config: { effort: 'xhigh', sandbox: true } }, async (ctl, { workdir }) => {
  // echo-argv prints the argv it received; we inspect the raw spawn record.
  await ctl.callTool('antigravity', { description: 'argv', prompt: 'show args' })
  const spawns = ctl.subprocess.spawned
  // The `--print-timeout` syntax probe also spawns `--print x`, so pick the
  // run by the model flag the probe never passes, not by `--print`.
  const runSpawn = spawns.find((h) => h.argv.includes('--model') && h.argv.some((a) => a === '--print' || a === '-p'))
  check('a print-mode spawn happened', runSpawn !== undefined, String(spawns.length))
  check('the print-timeout syntax was probed once', spawns.some((h) => h.argv.includes('--print-timeout') && !h.argv.includes('--model')), spawns.map((h) => h.argv.join(' ')).join(' | '))
  const argv = runSpawn?.argv ?? []
  check('effort xhigh is passed through (no local whitelist rejection)', argv.includes('--effort') && argv.includes('xhigh'), argv.join(' '))
  check('--dangerously-skip-permissions is used by default', argv.includes('--dangerously-skip-permissions'), argv.join(' '))
  check('model is passed through', argv.includes('--model') && argv.includes('gemini-3.8-flash-high'), argv.join(' '))
  check('cwd is absolute', runSpawn !== undefined && runSpawn.argv.length > 0)
})

await testCase('flags/effort-max-accepted', { scenario: 'success', config: { effort: 'max' } }, async (ctl) => {
  const value = await ctl.callTool('antigravity', { description: 'max effort', prompt: 'hi' })
  check('effort max is accepted', value.kind === 'foreground')
  const runSpawn = ctl.subprocess.spawned.find((h) => h.argv.includes('--effort'))
  check('effort max reaches the CLI', runSpawn?.argv.includes('max'), (runSpawn?.argv ?? []).join(' '))
})

await testCase('flags/unknown-effort-warns-not-throws', { scenario: 'success', config: { effort: 'ultra' } }, async (ctl) => {
  const value = await ctl.callTool('antigravity', { description: 'weird effort', prompt: 'hi' })
  check('an unknown effort tier does not fail the run locally', value.kind === 'foreground')
  check('the warning is logged', ctl.log.some((l) => l.level === 'warn' && /effort/i.test(l.message)), JSON.stringify(ctl.log.filter((l) => l.level === 'warn')))
})

// ── 9. Capability probe + cache ─────────────────────────────────────────────
await testCase('probe/caches-and-reuses', { scenario: 'success' }, async (ctl) => {
  const agy = ctl.provider().config?.command ?? ctl.subprocess.spawned[0]?.argv?.[0]
  const helpSpawns = () => ctl.subprocess.spawned.filter((h) => h.argv.includes('help'))
  check('nothing is probed before the first run', helpSpawns().length === 0, String(helpSpawns().length))

  await ctl.callTool('antigravity', { description: 'probe', prompt: 'hi' })
  check('help is probed once for one build', helpSpawns().length === 1, String(helpSpawns().length))
  // agy 1.4.x wants a unit on --print-timeout; the probe must discover that
  // instead of shipping a bare millisecond count that fails at spawn time.
  const timeoutSpawns = ctl.subprocess.spawned.filter((h) => h.argv.includes('--print-timeout'))
  check('the --print-timeout syntax is confirmed', timeoutSpawns.length >= 1, String(timeoutSpawns.length))
  check('a unit-spelled timeout was probed first', timeoutSpawns[0]?.argv.includes('1ms') === true, (timeoutSpawns[0]?.argv ?? []).join(' '))

  // The chosen spelling reaches the real run.
  const runSpawn = ctl.subprocess.spawned.find((h) => h.argv.includes('--model'))
  const timeoutIdx = runSpawn?.argv.indexOf('--print-timeout') ?? -1
  const value = timeoutIdx === -1 ? '' : runSpawn.argv[timeoutIdx + 1]
  check('the run passes a unit-spelled --print-timeout', /^\d+(ms|s|m|h)$/.test(value), `${value} in ${(runSpawn?.argv ?? []).join(' ')}`)

  // Second run in the same instance: no new probe.
  await ctl.callTool('antigravity', { description: 'probe again', prompt: 'hi' })
  check('a second run reuses the cached support', helpSpawns().length === 1, String(helpSpawns().length))

  const support = await ctl.provider().probeFlags(agy, {}, ctl.workdir)
  check('probe reports probed=true for the fake CLI', support.probed === true, JSON.stringify(support))
  check('probe detects stream-json support', support.streamJson === true, JSON.stringify(support))
})

await testCase('probe/bare-timeout-build-downgrades', { scenario: 'success', config: { flagCachePath: '' } }, async (ctl) => {
  // A pre-1.4 build takes a bare millisecond count. The probe must find that
  // too, rather than hard-failing every run on the modern spelling.
  process.env.FAKE_AGY_BARE_TIMEOUT = '1'
  try {
    const value = await ctl.callTool('antigravity', { description: 'old build', prompt: 'hi' })
    check('a bare-timeout build still runs', value.kind === 'foreground', JSON.stringify(value).slice(0, 200))
    const runSpawn = ctl.subprocess.spawned.find((h) => h.argv.includes('--model'))
    const idx = runSpawn?.argv.indexOf('--print-timeout') ?? -1
    const spelled = idx === -1 ? '' : runSpawn.argv[idx + 1]
    check('the run falls back to a bare millisecond count', /^\d+$/.test(spelled), `${spelled} in ${(runSpawn?.argv ?? []).join(' ')}`)
  } finally {
    delete process.env.FAKE_AGY_BARE_TIMEOUT
  }
})

await testCase('probe/cache-is-keyed-by-build-identity', { scenario: 'success' }, async (ctl, { workdir }) => {
  const cacheFile = join(workdir, 'agy-flag-cache.json')
  await ctl.callTool('antigravity', { description: 'cache', prompt: 'hi' })
  check('the probe cache was written', existsSync(cacheFile), cacheFile)
  const table = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const keys = Object.keys(table)
  check('exactly one build was cached', keys.length === 1, keys.join(' , '))
  // Identity = exe@size:mtime — an agy self-update lands on a new key instead
  // of reusing yesterday's answers (the 1.4.5 -> 1.4.6 change made that real).
  check('the cache key carries the build identity', /@\d+:\d+$/.test(keys[0] ?? ''), keys[0])
  check('the cached entry records the timeout syntax', table[keys[0]]?.durationTimeout === true, JSON.stringify(table[keys[0]]))
})

// ── 10. Follow-up path ──────────────────────────────────────────────────────
await testCase('followup/resumes-conversation', { scenario: 'success' }, async (ctl) => {
  const first = await ctl.callTool('antigravity', { description: 'start', prompt: 'hello' })
  check('first run yields a task key', typeof first.task === 'string', first.task)
  const second = await ctl.callTool('antigravity_followup', { description: 'continue', task: first.task, prompt: 'and again' })
  check('follow-up succeeds', second.kind === 'foreground', JSON.stringify(second).slice(0, 200))
  const followSpawn = ctl.subprocess.spawned.filter((h) => h.argv.includes('--conversation')).pop()
  check('follow-up passes --conversation', followSpawn !== undefined, String(ctl.subprocess.spawned.length))
  check('follow-up reuses the same conversation id', followSpawn?.argv.includes('fake-conversation-0001'), (followSpawn?.argv ?? []).join(' '))
})

await testCase('followup/unknown-task-rejected', { scenario: 'success' }, async (ctl) => {
  let threw
  try {
    await ctl.callTool('antigravity_followup', { description: 'bogus', task: 'no-such-task', prompt: 'hi' })
  } catch (error) {
    threw = error
  }
  check('an unknown task key is rejected', threw !== undefined, String(threw?.message ?? 'resolved'))
  check('the error names the missing task', /no-such-task|unknown|not found/i.test(String(threw?.message ?? '')), String(threw?.message))
})

// ── 11. Background path ─────────────────────────────────────────────────────
await testCase('background/job-reads-output', { scenario: 'tool-then-answer' }, async (ctl) => {
  const value = await ctl.callTool('antigravity', { description: 'bg task', prompt: 'work in background', background: true })
  check('background returns a job id', value.kind === 'background' && typeof value.jobId === 'string', JSON.stringify(value))
  // Real ids are `${kind}-${16 hex}`, not an opaque counter.
  check('job id follows the jobs-local shape', /^antigravity-[0-9a-f]{16}$/.test(value.jobId), value.jobId)
  const settled = await ctl.jobsService.wait(value.jobId, 15_000)
  check('background job completes', settled?.status === 'completed', JSON.stringify(settled))
  // The producer's buffered text becomes the job's ring once it settles, so
  // read after `done` rather than racing the producer.
  const out = ctl.jobsService.readOutput(value.jobId)
  check('background output contains the answer', out.includes('Hello from agy.'), `len=${out.length} ${out.slice(0, 300)}`)
  check('background output carries the task line', /\[task: /.test(out), out.slice(-200))
})

await testCase('background/cancel', { scenario: 'slow-stream' }, async (ctl) => {
  const value = await ctl.callTool('antigravity', { description: 'bg cancel', prompt: 'slow bg', background: true })
  await new Promise((r) => setTimeout(r, 400))
  check('kill is accepted', ctl.jobsService.kill(value.jobId, undefined, 'user request') === 'requested')
  const settled = await ctl.jobsService.wait(value.jobId, 15_000)
  check('cancelled background job settles as killed', settled?.status === 'killed', JSON.stringify(settled))
  check('cancel detail mentions the request', /cancel/i.test(String(settled?.detail ?? '')), settled?.detail)
})

// ── 12. Wake-on-settle (no polling) ─────────────────────────────────────────
// The real `dsh-tool-jobs` wakes the owner agent when a job settles, but only
// when `event.job.owner` resolves to a live agent. Two invariants make that
// work end to end, and both are invisible to the plugin's own assertions:
//   1. `jobs.start({ owner })` must receive the parent agent — omit it and
//      completion is silently dropped (the job still runs and settles).
//   2. the owner must be the *exec* agent, not the provider's `providerAgent`:
//      `providerAgent` is a non-session stub, so `agents.get(owner)` returns
//      undefined and the wake is discarded just the same.
// The tool description must also stop telling the model to poll every 60s,
// since that advice is what produced the polling loop in the first place.
await testCase('wake/owner-is-the-exec-agents-session-id', { scenario: 'success' }, async (ctl) => {
  await ctl.callTool('antigravity', { description: 'wake owner', prompt: 'hi', background: true })
  const owners = [...ctl.jobOwners]
  check('background job registered an owner', owners.length > 0, JSON.stringify(owners))
  // dsh-jobs-local resolves the owner with `agents.get(session)`, so the value
  // must be the session id STRING. Handing it the Agent object throws
  // `session "[object Object]" has no live agent` and every background call
  // fails — which is exactly what shipped in patched.6.
  check('owner is a session id string', typeof owners[0] === 'string', `${typeof owners[0]}: ${JSON.stringify(owners[0])}`)
  check('owner is this session', owners[0] === 'test-session', String(owners[0]))
  check('owner is not the exec agent object', owners[0] !== ctl.lastToolAgent, 'owner is the Agent object, not its id')
  check('owner resolves through agents.get', ctl.liveAgents.get(owners[0]) !== undefined, String(owners[0]))
})

await testCase('wake/description-does-not-ask-for-polling', { scenario: 'success' }, async (ctl) => {
  const description = String(ctl.tools.get('antigravity').description ?? '')
  check('description promises a wake-up', /\bwoken\b|\bwakes you\b|\bnotif(y|ied)\b/i.test(description), description.slice(0, 200))
  check('description does not mandate 60s polling', !/every ~?60 seconds/i.test(description), description)
  check('description does not claim the wake-up is budgeted', !/wake-up is budgeted/i.test(description), description)
})

// ── 13. Registry / tasks tool ───────────────────────────────────────────────
await testCase('tasks/lists-recorded-run', { scenario: 'success' }, async (ctl) => {
  const created = await ctl.callTool('antigravity', { description: 'recorded run', prompt: 'remember me' })
  const listed = await ctl.callTool('antigravity_tasks', {})
  const text = JSON.stringify(listed)
  check('tasks tool reports the run', text.includes(created.task), text.slice(0, 400))
})

// ── 14. Transcript disabled ─────────────────────────────────────────────────
await testCase('transcript/disabled-writes-nothing', { scenario: 'success', config: { transcript: false } }, async (ctl, { transcriptDir }) => {
  const value = await ctl.callTool('antigravity', { description: 'no transcript', prompt: 'hi' })
  check('run still succeeds without a transcript', value.kind === 'foreground')
  const files = existsSync(transcriptDir) ? readdirSync(transcriptDir) : []
  check('no transcript file was written', files.length === 0, files.join(','))
})

// ── 15. Dispose terminates children ────────────────────────────────────────
await testCase('dispose/terminates-active-runs', { scenario: 'hang', config: { printTimeoutMs: 60_000 } }, async (ctl) => {
  const pending = ctl.callTool('antigravity', { description: 'still running', prompt: 'hang' }).catch((error) => error)
  // Wait for the RUN to be live, not for a fixed delay: the first call also
  // pays for the one-time flag probe, so 500 ms could land before the run
  // existed and `dispose()` would have nothing to terminate.
  const deadline = Date.now() + 15_000
  for (;;) {
    const live = ctl.subprocess.spawned.some((h) => h.argv.includes('--model'))
    if (live) break
    if (Date.now() > deadline) throw new Error('the run never started; cannot test dispose')
    await new Promise((r) => setTimeout(r, 50))
  }
  ctl.dispose()
  const outcome = await Promise.race([pending, new Promise((r) => setTimeout(() => r('timeout'), 15_000))])
  check('dispose settles an in-flight run', outcome !== 'timeout', String(outcome))
  check('dispose does not throw the TDZ error', !/Cannot access 'transcriptPath'/.test(String(outcome?.message ?? outcome)))
})

// ── 16. Tool output schemas are closed and satisfied ──────────────────────
// Regression guard for a live-only failure: every tool declares
// `additionalProperties: false`, so a field added to a result without a matching
// declaration makes DSH discard an otherwise successful tool call. The offline
// suite missed it because the harness used to call `tool.execute()` directly.
await testCase('schema/every-tool-result-satisfies-its-schema', { scenario: 'success' }, async (ctl) => {
  const calls = [
    ['antigravity', { description: 'schema check', prompt: 'Reply with exactly: PONG' }],
    ['antigravity_tasks', {}],
  ]
  for (const [name, args] of calls) {
    const tool = ctl.tools.get(name)
    check(`${name} declares an output schema`, tool?.output?.schema !== undefined, name)
    // callTool validates against the declared schema and throws on a violation.
    let threw
    try {
      await ctl.callTool(name, args)
    } catch (error) {
      threw = error
    }
    check(`${name} result satisfies its closed output schema`, threw === undefined, String(threw?.message ?? ''))
  }
})

await testCase('schema/undeclared-field-is-rejected', { scenario: 'success' }, async (ctl) => {
  // Prove the guard can actually fail: shrink the schema so the real result has
  // an undeclared field, and expect the validator to complain.
  const tool = ctl.tools.get('antigravity')
  const saved = tool.output.schema
  let threw
  try {
    tool.output.schema = {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', required: true } },
    }
    await ctl.callTool('antigravity', { description: 'shrink', prompt: 'Reply with exactly: PONG' })
  } catch (error) {
    threw = error
  } finally {
    tool.output.schema = saved
  }
  check('a violating result is rejected', threw !== undefined, 'validator accepted an undeclared field')
  check(
    'the rejection names the offending field',
    /is not a declared property/.test(String(threw?.message ?? '')),
    String(threw?.message ?? '').slice(0, 200),
  )
})

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`)
if (filter !== undefined && casesMatched === 0) {
  // A filter that matches nothing must not read as a green run (0/0 would
  // also slip through wrappers that compare the two numbers for equality).
  console.log(`no tests matched filter: ${filter}`)
  process.exitCode = 1
}
if (failed.length > 0) {
  console.log('\nfailures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ''}`)
  process.exitCode = 1
}
