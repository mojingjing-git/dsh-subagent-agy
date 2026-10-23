/**
 * Real-agy end-to-end checks: the plugin driving the actual `agy.exe`.
 *
 * The offline suite proves the plugin against a simulated CLI. This script
 * proves the same paths against the installed binary, using the same harness
 * (only `command` is swapped to the real executable), and covers the four
 * scenarios the plan requires: a simple reply, a same-conversation follow-up,
 * a small task in a temp directory, and a cancel while running.
 *
 * It is deliberately separate from `run.mjs`: it needs a logged-in agy, spends
 * real quota, and takes minutes.
 */
import { bootPlugin, readIfExists } from './harness.mjs'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const AGY = process.env.AGY_BIN ?? 'C:\\Users\\wrz20\\AppData\\Local\\agy\\bin\\agy.exe'
// `agy models` on this machine: gemini-3.8-flash-high|medium|low.
const MODEL = process.env.AGY_TEST_MODEL ?? 'gemini-3.8-flash-high'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

/** Is the installed agy able to run at all? */
function agyVersion() {
  try {
    return execFileSync(AGY, ['--version'], { encoding: 'utf8' }).trim()
  } catch (error) {
    return `unavailable (${String(error)})`
  }
}

console.log(`\n== plugin end-to-end suite (real agy) ==\n`)
console.log(`  agy: ${AGY}`)
console.log(`  version: ${agyVersion()}`)
console.log(`  model: ${MODEL}\n`)

/** Boot one plugin instance against the real binary. */
async function boot(overrides = {}, options = {}) {
  return bootPlugin(
    {
      command: AGY,
      model: MODEL,
      printTimeoutMs: 240_000,
      backgroundTimeoutMs: 600_000,
      ...overrides,
    },
    options,
  )
}

/** Joined text of a tool result's canonical content blocks. */
const textOf = (blocks) =>
  (blocks ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')

/** A temp directory for one scenario. */
function scratchDir(tag) {
  const dir = join(process.env.TEMP ?? '.', `agy-e2e-${tag}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Resolve a run's transcript file through the plugin's own index. */
function transcriptFileFor(ctl, task) {
  const raw = readIfExists(join(ctl.transcriptDir(), 'index.json'))
  if (raw === undefined) return undefined
  try {
    const index = JSON.parse(raw)
    return Array.isArray(index) ? index.find((entry) => entry?.task === task)?.file : undefined
  } catch {
    return undefined
  }
}

// ── 1. A simple reply, then a same-conversation follow-up ───────────────────
{
  const ctl = await boot({}, { workdir: scratchDir('simple') })
  try {
    const started = Date.now()
    const value = await ctl.callTool('antigravity', {
      description: 'real: simple reply',
      prompt: 'Reply with exactly: AGY-OK. Do not use any tools.',
    })
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    const text = textOf(value.output)
    check('simple reply returns a foreground result', value.kind === 'foreground', JSON.stringify(value).slice(0, 300))
    check('simple reply carries the expected token', /AGY-OK/.test(text), text.slice(0, 300))
    check('simple reply yields a task key', typeof value.task === 'string' && value.task.length > 0, value.task)
    check('simple reply exposes the conversation id', typeof value.conversationId === 'string' && value.conversationId.length > 0, JSON.stringify(value.conversationId))
    const file = transcriptFileFor(ctl, value.task)
    check(`simple reply recorded a transcript (${elapsed}s)`, file !== undefined && readFileSync(file, 'utf8').includes('AGY-OK'), String(file))

    const follow = await ctl.callTool('antigravity_followup', {
      description: 'real: follow-up',
      prompt: 'Now reply with exactly: SECOND-TURN. Do not use any tools.',
      task: value.task,
    })
    const followText = textOf(follow.output)
    check('follow-up returns a foreground result', follow.kind === 'foreground', JSON.stringify(follow).slice(0, 300))
    check('follow-up answers the second turn', /SECOND-TURN/.test(followText), followText.slice(0, 300))
    check('follow-up keeps the same conversation', follow.conversationId === value.conversationId, `${follow.conversationId} vs ${value.conversationId}`)
  } finally {
    ctl.dispose()
    ctl.cleanup()
  }
}

// ── 2. A small file task in a temp directory ────────────────────────────────
{
  const workdir = scratchDir('file')
  const ctl = await boot({}, { workdir, sessionCwd: workdir })
  try {
    const value = await ctl.callTool('antigravity', {
      description: 'real: write a file',
      prompt: 'Create a file named real-probe.txt in the current working directory whose only content is the word PROBE. Then reply with exactly: WROTE.',
    })
    const text = textOf(value.output)
    const path = join(workdir, 'real-probe.txt')
    check('file task reports completion', value.kind === 'foreground', JSON.stringify(value).slice(0, 300))
    check('file task really created the file', existsSync(path), path)
    check('file task wrote the expected content', existsSync(path) && readFileSync(path, 'utf8').trim() === 'PROBE', String(readIfExists(path)))
    check('file task answered', /WROTE/.test(text), text.slice(0, 300))
  } finally {
    ctl.dispose()
    ctl.cleanup()
  }
}

// ── 3. Cancel while running ──────────────────────────────────────────────────
{
  const ctl = await boot({}, { workdir: scratchDir('cancel') })
  try {
    const controller = new AbortController()
    const pending = ctl.callTool(
      'antigravity',
      {
        description: 'real: cancel',
        prompt: 'Count slowly from 1 to 100, writing each number on its own line with a short comment. Do not use any tools.',
      },
      { signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 6000))
    controller.abort()
    let settled
    try {
      settled = await pending
    } catch (error) {
      settled = { threw: String(error) }
    }
    const stopped = settled?.threw !== undefined || settled?.kind === undefined
    check('cancelled run settles instead of hanging', stopped, JSON.stringify(settled).slice(0, 300))
  } finally {
    ctl.dispose()
    ctl.cleanup()
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`)
if (failed.length > 0) {
  console.log('\nfailures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ''}`)
  process.exitCode = 1
}
