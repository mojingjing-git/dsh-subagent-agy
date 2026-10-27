#!/usr/bin/env node
/**
 * A stand-in for `agy` used by the offline test suite.
 *
 * The provider resolves its executable through `AGY_BIN`, so pointing that at
 * this script exercises every spawn, stream, settlement and transcript path of
 * the plugin without touching a real Antigravity install, login or quota.
 *
 * Usage: fake-agy.mjs <scenario> [--output-format <fmt>] [--conversation <id>]
 *                     [--print-timeout <n>s] [--effort <lvl>] ...
 * The scenario comes from FAKE_AGY_SCENARIO, else the first bare argument,
 * else `success`. `help` always prints a usage dump mirroring agy 1.4.6.
 */
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)

/** Collect `--flag value` pairs plus positionals, the way agy would see them. */
function parse(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i += 1
      } else {
        flags[name] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

const { flags } = parse(argv)

// `--print-timeout` validation, faithful to real agy 1.4.6: the value goes
// through Go's time.ParseDuration, so a bare number is rejected with
// "time: missing unit in duration" *before* any work starts. The plugin probes
// this once to choose a spelling, so modelling it keeps that probe honest.
// FAKE_AGY_BARE_TIMEOUT=1 models a pre-1.4 build that took a bare millisecond
// count instead — the downgrade path the plugin must still support.
const timeoutFlagIndex = argv.indexOf('--print-timeout')
if (timeoutFlagIndex !== -1 && argv[timeoutFlagIndex + 1] !== undefined) {
  const raw = argv[timeoutFlagIndex + 1]
  const bareOk = process.env.FAKE_AGY_BARE_TIMEOUT === '1'
  const unitOk = /^\d+(ms|s|m|h)$/.test(raw)
  const ok = bareOk ? /^\d+$/.test(raw) : unitOk
  if (!ok) {
    process.stderr.write(
      `invalid value "${raw}" for flag -print-timeout: time: ${/^\d+$/.test(raw) ? 'missing unit in duration' : 'invalid duration'} "${raw}"\nUsage of agy.exe:\n`,
    )
    process.exit(2)
  }
}

// `agy help`: the usage dump the capability probe parses. Kept faithful to the
// real 1.4.6 output for every flag the plugin cares about.
if (argv.includes('help')) {
  // FAKE_AGY_MINIMAL_HELP=1 models an old build whose help never mentions
  // --print/--conversation/stream-json: the probe parses the usage but cannot
  // confirm those capabilities (probed=false, streamJson=false).
  if (process.env.FAKE_AGY_MINIMAL_HELP === '1') {
    process.stdout.write(`Antigravity CLI 1.0.0 (fake)

Usage: agy [flags]
  --print-timeout                 Optional time limit for print mode (default 0s)
  --model                         Model for the current CLI session
  -h, --help                      help for agy
`)
    process.exit(0)
  }
  process.stdout.write(`Antigravity CLI 1.4.6 (fake)

Usage: agy [flags]
  -p, --print                     Run a single prompt non-interactively
  --print-timeout                 Optional time limit for print mode (default 0s)
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  --input-format                  Input format for print mode (text, stream-json) (default text)
  --conversation                  Resume a previous conversation by ID
  --continue                      Continue the most recent conversation
  --model                         Model for the current CLI session
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --agent                         Agent for the current CLI session
  --mode                          Set the agent execution mode (accept-edits, auto, plan)
  --sandbox                       Run in a sandbox with terminal restrictions enabled
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --json-schema                   Optional JSON schema string to enforce structured output
  --log-file                      Override CLI log file path
  --project                       Project ID or project name for the current CLI session
  -h, --help                      help for agy

Available Commands:
  agent           List available agents
  models          List available models
`)
  process.exit(0)
}

// `agy models`: the catalogue behind `model: auto`. The real call is a ~10.7 s
// network round trip; the fake answers immediately so tests stay fast.
// FAKE_AGY_MODELS can replace the payload to model an empty or renamed catalogue.
if (argv.includes('models')) {
  const payload =
    process.env.FAKE_AGY_MODELS ??
    [
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\n')
  if (payload.length > 0) process.stdout.write(`${payload}\n`)
  process.exit(0)
}

const scenario = process.env.FAKE_AGY_SCENARIO ?? 'success'
const format = typeof flags['output-format'] === 'string' ? flags['output-format'] : 'text'
const conversation = typeof flags.conversation === 'string' ? flags.conversation : undefined
const conv = conversation ?? 'fake-conversation-0001'
const sessionCwd = process.cwd()

/** Write one NDJSON event. */
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

const initEvent = {
  event: 'init',
  conversation_id: conv,
  init: { cwd: sessionCwd, tools: ['write_file', 'read_file', 'run_command'] },
}

const stepDone = (index, type, extra = {}) => ({
  event: 'step_update',
  step_update: { step_index: index, state: 'DONE', step_type: type, ...extra },
})

const resultEvent = (response, usage = {}) => ({
  event: 'result',
  result: {
    conversation_id: conv,
    status: 'SUCCESS',
    response,
    duration_seconds: 1.5,
    num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, total_tokens: 125, ...usage },
  },
})

/** A short "the model thought, called a tool, then answered" stream. */
const happyStream = () => {
  emit(initEvent)
  emit(stepDone(0, 'user_input'))
  emit({
    event: 'step_update',
    step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello ' },
  })
  emit({
    event: 'step_update',
    step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'from agy.' },
  })
  emit(stepDone(1, 'agent_response', { duration_seconds: 1.1, usage: { input_tokens: 100, output_tokens: 20 } }))
  emit({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'write_file',
      tool_info: { name: 'write_file', parameters: { Path: 'probe.txt' } },
    },
  })
  emit(stepDone(2, 'tool', { duration_seconds: 0.2 }))
  emit(resultEvent('Hello from agy.'))
}

switch (scenario) {
  case 'success': {
    // The plugin prefers stream-json whenever the probe says the build
    // supports it, so the plain success path has to answer in stream-json too
    // — and answer the same PONG that the `json`/`text` branches do, so the
    // assertions hold whichever format the plugin picks.
    if (format === 'stream-json') {
      emit(initEvent)
      emit(stepDone(0, 'user_input'))
      emit({
        event: 'step_update',
        step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'PONG' },
      })
      emit(stepDone(1, 'agent_response', { duration_seconds: 1, usage: { input_tokens: 10, output_tokens: 1 } }))
      emit(resultEvent('PONG'))
    } else if (format === 'json') {
      process.stdout.write(
        `${JSON.stringify({
          conversation_id: conv,
          status: 'SUCCESS',
          response: 'PONG',
          duration_seconds: 1,
          num_turns: 1,
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        })}\n`,
      )
    } else {
      process.stdout.write('PONG\n')
    }
    break
  }

  case 'tool-then-answer': {
    happyStream()
    break
  }

  case 'split-chunk': {
    // One JSON line delivered in two writes, with a multi-byte character
    // straddling the boundary: the plugin must buffer bytes, not strings.
    const line = `${JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '中文分块测试' },
    })}\n`
    const bytes = Buffer.from(line, 'utf8')
    const cut = bytes.indexOf(Buffer.from('分')) + 1 // mid-character
    emit(initEvent)
    process.stdout.write(bytes.subarray(0, cut))
    setTimeout(() => {
      process.stdout.write(bytes.subarray(cut))
      emit(resultEvent('中文分块测试'))
      process.exit(0)
    }, 120)
    await new Promise(() => {}) // keep the process alive until the timer fires
    break
  }

  case 'no-trailing-newline': {
    emit(initEvent)
    // Final event written WITHOUT a newline: the tail must still be consumed.
    process.stdout.write(
      JSON.stringify(resultEvent('no trailing newline')).slice(0, -1) + JSON.stringify(resultEvent('no trailing newline')).slice(-1),
    )
    break
  }

  case 'unknown-event': {
    emit(initEvent)
    emit({ event: 'something_new', payload: { a: 1 } })
    emit(stepDone(0, 'user_input'))
    emit(resultEvent('survived an unknown event'))
    break
  }

  case 'no-result': {
    emit(initEvent)
    emit(stepDone(0, 'user_input'))
    emit(stepDone(1, 'agent_response', { duration_seconds: 0.5 }))
    process.exit(0)
    break
  }

  case 'exit-1': {
    process.stderr.write('boom: simulated failure\n')
    process.exit(1)
    break
  }

  case 'auth-error': {
    if (format === 'json' || format === 'stream-json') {
      process.stdout.write(
        `${JSON.stringify({ conversation_id: conv, status: 'FAILED', error: 'authentication required', response: '' })}\n`,
      )
    } else {
      process.stderr.write('authentication required\n')
      process.exitCode = 2
    }
    break
  }

  case 'hang': {
    emit(initEvent)
    // Never finishes: the watchdog must terminate the tree.
    setInterval(() => {}, 1000)
    await new Promise(() => {})
    break
  }

  case 'slow-stream': {
    // Streams a delta every 150 ms for 1.5 s: a cancel must leave no orphan.
    emit(initEvent)
    let i = 0
    const timer = setInterval(() => {
      i += 1
      emit({
        event: 'step_update',
        step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: `chunk${i} ` },
      })
      if (i >= 10) {
        clearInterval(timer)
        emit(resultEvent('slow stream finished'))
        process.exit(0)
      }
    }, 150)
    process.on('SIGTERM', () => {
      clearInterval(timer)
      process.exit(143)
    })
    await new Promise(() => {})
    break
  }

  case 'writes-file': {
    // Proves the child really ran in the cwd the plugin chose.
    writeFileSync('agy-cwd-probe.txt', `${sessionCwd}\n`, 'utf8')
    if (format === 'stream-json') {
      happyStream()
    } else {
      process.stdout.write(`${JSON.stringify({ conversation_id: conv, status: 'SUCCESS', response: sessionCwd })}\n`)
    }
    break
  }

  case 'echo-argv': {
    // Inspect exactly which flags the plugin produced.
    process.stdout.write(`ARGV=${JSON.stringify(argv)}\n`)
    break
  }

  default: {
    process.stderr.write(`fake-agy: unknown scenario "${scenario}"\n`)
    process.exit(64)
  }
}
