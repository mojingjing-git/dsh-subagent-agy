/**
 * @dsh-external/dsh-subagent-antigravity
 *
 * Product subagent provider for Google Antigravity CLI (agy), following the
 * official `dsh-subagent-codex` / `dsh-subagent-claude-code` pattern:
 * one trusted provider on `ctx.subagents` (name: `antigravity`) plus two
 * model-facing tools (`antigravity` for new tasks, `antigravity_followup`
 * for continuing a previous task).
 *
 * Every delegation spawns a fresh `agy -p <task>` process in the parent
 * session's workspace, waits for the final answer (bounded by
 * `--print-timeout` plus a local watchdog), and returns only the final text.
 * No Gemini API key is involved: agy authenticates through the user's cached
 * Antigravity login (system keyring / Google Sign-In).
 *
 * Continuation: runs use `--output-format json`, whose reply carries the
 * agy `conversation_id`; the provider records it (in-memory bridge plus a
 * durable `~/.dsh/agy-conversations.json` registry), and follow-ups spawn
 * `agy -p <prompt> --conversation <id>` so the agent's full context carries
 * over. This is agy-side session resume — it is NOT the DSH continuable
 * subagent machinery (which requires an in-process DSH child session), so
 * the follow-up is its own tool rather than `send_message`/`interrupt_agent`.
 *
 * Background mode (`background: true`): the run registers with the generic
 * `ctx.jobs` runtime and returns a job id immediately. It spawns agy with
 * `--output-format stream-json` (probe-gated) and streams the incremental
 * `text_delta` chunks through the job's `readOutput`, so `job_output`
 * returns live progress and `job_kill` stops it; the final read carries a
 * `[task: ...]` line so the conversation can still be followed up.
 *
 * Robustness notes:
 * - Supported agy flags are probed once per provider instance (`agy help`),
 *   so `--output-format` / `--conversation` / `--sandbox` / `--add-dir` /
 *   `stream-json` are only emitted when the installed build understands them.
 * - A local watchdog (printTimeoutMs + watchdogMarginMs) terminates a hung
 *   agy tree instead of waiting forever.
 * - The follow-up registry is written atomically (tmp + rename) and all
 *   writes are serialized through a module-level queue, so concurrent tool
 *   calls cannot clobber each other.
 * - The registry self-heals: a corrupt or wrongly-shaped file is backed up
 *   once (`*.corrupt`, mtime-guarded) and reset instead of being silently
 *   overwritten by the next save; malformed entries are dropped with a
 *   warning; and the read-modify-write cycles themselves are serialized, so
 *   concurrent runs cannot lose each other's records.
 * - A tasks/cancel layer (`antigravity_tasks` / `antigravity_cancel`) lists
 *   in-flight runs plus durable history (restart-safe) and can stop a
 *   running agy; all in-flight runs are terminated on plugin stop/update.
 * - Follow-ups to the SAME conversation are serialized per conversation id,
 *   so two concurrent prompts cannot corrupt one agy conversation file.
 * - Prompts are capped at MAX_ARGV_PROMPT_CHARS for argv safety.
 *
 * Process lifecycle is owned by the shared `ctx.subprocess` seam (credential
 * scrubbing, tree-scoped SIGTERM→SIGKILL escalation, whole-tree exit), and
 * result settlement follows the out-of-process subagent contract
 * (`settleRunResult` + `subprocessRunHandle`): `result` never rejects.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type JsonValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { dirname, isAbsolute, join } from 'node:path'
import { mergeStepInto, parseStepUpdate, snapshotSteps, type StepEvent } from './agy-steps.js'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { familyOfModel, spawnUsage, UsageReader } from './agy-usage.js'
import {
  MODEL_CACHE_TTL_MS,
  parseModels,
  pickDeepestFlash,
  readModelCatalog,
  type ModelCatalog,
  writeModelCatalog,
} from './agy-models.js'
import { registerAgyPanel } from './agy-panel.js'

// ── DSH 0.2.1 compatibility shims (v1) ──────────────────────────────────────
// Upstream imported `resolveChildCwd` and `validateConfiguredCwd` from
// @deepseek-ai/dsh-subagent. DSH 0.2.1-rc.2 exports neither, so the plugin died
// with an ESM link error before its first line ran. Both are small,
// self-contained path policies; these local copies reproduce the upstream
// behaviour instead of dropping the checks. They are pure functions over the
// same inputs, so they stay correct if a future DSH restores the originals.
function resolveChildCwd(parentCwd: string | undefined, configuredCwd: string): string {
  const base = configuredCwd.trim()
  if (base.length === 0) return parentCwd ?? process.cwd()
  return isAbsolute(base) ? base : join(parentCwd ?? process.cwd(), base)
}

function validateConfiguredCwd(cwd: string, field: string = 'cwd'): void {
  if (typeof cwd !== 'string') throw new TypeError(`${field} must be a string`)
  if (cwd.includes('\u0000')) throw new Error(`${field} must not contain a NUL byte`)
}

export const name = '@dsh-external/dsh-subagent-antigravity'
export const inject = ['subagents', 'subprocess', 'tools']

/** Register the `antigravity` job kind with the generic jobs registry (id prefix: `antigravity-N`). */
// v5 — `SubagentResult` is a sealed interface upstream (`output`, `structured?`,
// `diagnostic?`, `stopReason`), so this plugin's added `transcript` field cannot
// be returned as an object literal in a contextually-typed position. Declaring
// the field by interface merging is the mechanism DSH uses itself for
// `SubagentStopReasonMap` ("widens automatically as backends merge in variants"):
// it keeps the extra field fully typed without widening the upstream seam.
//
// Wrapped in a module augmentation that TypeScript skips when the peer ships no
// declarations at all (DSH 0.2.1-rc.2 sets `types` to a file it does not publish,
// which makes the whole module `any` — see tsconfig.local.json). Augmenting an
// `any` module is an error ("not a module"), hence the guard.
declare module '@deepseek-ai/dsh-subagent' {
  interface SubagentResult {
    /** Absolute path of the NDJSON event stream this run recorded, when one was written. */
    readonly transcript?: string
  }
}

// The `dsh-jobs` import below is load-bearing for the augmentation: a
// `declare module` for a specifier this file never imports declares a NEW
// ambient module instead of merging into the real one, so `JobKindMap` would be
// a fresh interface and the real `JobKind` union would stay `'bash' | 'subagent'`
// — `jobs.start({ kind: 'antigravity' })` then fails to typecheck. Importing the
// type first makes the declaration an augmentation, which is the same shape
// `dsh-jobs` itself uses for `Context.jobs`.
import type { JobKindMap as _JobsKindMap } from '@deepseek-ai/dsh-jobs'
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    antigravity: 'antigravity'
  }
}
// Keep the imported binding referenced so `noUnusedLocals` stays satisfied.
export type { _JobsKindMap }

const PREFIX = 'subagent-antigravity'
/** In-memory stdout tail cap (1 MiB); overflow spills to a file (64 MiB). */
const MAX_STDOUT_BYTES = 1 << 20
const MAX_STDOUT_SPILL_BYTES = 64 << 20
/** stderr stays a bounded diagnostic tail. */
const MAX_STDERR_BYTES = 64 << 10
/** Background live-output window cap (8 MiB): old deltas drop so a long run cannot grow memory unboundedly. */
const MAX_VISIBLE_BYTES = 8 << 20
/** Durable follow-up registry cap. */
const MAX_TASK_RECORDS = 50
/** In-memory run bridge cap. */
const MAX_RUN_RECORDS = 64
/**
 * Prompts longer than this are NOT passed as one argv element. Windows
 * `CreateProcess` caps the whole command line near 32767 chars; keep a
 * margin for the generated flags. agy has no `--prompt-file` today, so the
 * provider refuses oversized prompts with guidance instead of a silent
 * truncation (if a future agy adds the flag, the probe auto-enables it).
 */
const MAX_ARGV_PROMPT_CHARS = 30_000
/** Bound for the one-time `agy help` flag probe. */
const PROBE_TIMEOUT_MS = 10_000
/**
 * Bound for `agy models`. It is a network call, not a local usage dump: agy
 * 1.4.7 takes ~10.7 s here, so the flag probe's 10 s ceiling would abort a
 * healthy run halfway through.
 */
const MODEL_PROBE_TIMEOUT_MS = 30_000
/** `--effort` values agy 1.4.6 documents (v5; an unknown value is warned, not rejected). */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
/**
 * Appended to every prompt when `avoidBrowser` is on: agy's headless
 * `browser_*` tools can hang indefinitely (browser launch / page load never
 * completing) and freeze the run with no output.
 */
const AVOID_BROWSER_SUFFIX =
  '\n\n(Environment note: headless browser tools are unreliable in this environment and can hang the run indefinitely. Do NOT use browser_* tools, do NOT open URLs in a browser, and do NOT wait on page loads. Verify pages and UI by reading the source files and running commands instead.)'
/**
 * Appended to every prompt when `avoidLargeReads` is on: agy's file-read
 * tool fails above its 4 MB cap, so large files must be inspected through
 * targeted commands instead of being read whole.
 */
const AVOID_LARGE_READ_SUFFIX =
  '\n\n(Environment note: files larger than 1 MB must NOT be read with your file-read tool — it fails above 4 MB, which large files like single-file components with embedded assets easily exceed. Inspect large files with grep, sed, head, tail, or python via run_command instead: first probe structure with head/grep, then extract only the slices you need. Never read a file whole when it is larger than 1 MB.)'

export const Config = z.object({
  /** Registry name on `ctx.subagents`. */
  providerName: z.string().default('antigravity'),
  /** New-task tool name. */
  toolName: z.string().default('antigravity'),
  /** Follow-up tool name. */
  followupToolName: z.string().default('antigravity_followup'),
  /** Executable to resolve (bare name on PATH or absolute path). */
  command: z.string().default('agy'),
  /**
   * `--model <slug>`. Empty omits the flag (agy's default model). The special
   * value `auto` asks the plugin for the newest Gemini Flash at its highest
   * thinking level, discovered from `agy models` and cached for a day; until
   * the first probe finishes — or when it fails — `auto` also omits the flag.
   */
  model: z.string().default(''),
  /** `--effort`; one of low | medium | high | xhigh | max; empty omits the flag. */
  effort: z.string().default(''),
  /** `--agent <name>`; empty omits the flag. */
  agent: z.string().default(''),
  /** Ceiling for one headless run (`--print-timeout`); agy's own default is 5m. */
  printTimeoutMs: z.number().step(1).min(1000).max(3_600_000).default(5 * 60 * 1000),
  /**
   * Local watchdog margin on top of the active ceiling (foreground
   * `printTimeoutMs`, background `backgroundTimeoutMs`). If agy neither
   * finishes nor honors its own `--print-timeout` (network hang, auth
   * stall), the plugin terminates the process tree after ceiling + margin.
   */
  watchdogMarginMs: z.number().step(1).min(5_000).max(600_000).default(60_000),
  /**
   * Ceiling for BACKGROUND runs (`--print-timeout`); the foreground ceiling
   * stays `printTimeoutMs`. Long tasks belong in the background, where the
   * DSH wakes the owning agent when the job settles (no polling needed), so
   * this ceiling can be generous; the watchdog margin applies on top and
   * `job_kill` stops a run at any time.
   */
  backgroundTimeoutMs: z.number().step(1).min(1000).max(3_600_000).default(3_600_000),
  /**
   * `--dangerously-skip-permissions`: auto-approve all agy tool calls.
   * Headless agy cannot prompt for approval, so unattended real work
   * (file edits, commands) needs this on.
   */
  skipPermissions: z.boolean().default(true),
  /** `--sandbox`: run with agy's terminal sandbox restrictions. */
  sandbox: z.boolean().default(false),
  /**
   * Append a browser-avoidance instruction to every agy prompt. agy's
   * headless `browser_*` tools can hang indefinitely in this environment
   * (browser launch / page load never completing), which freezes the whole
   * run with no output. Default true: agy verifies pages by reading files
   * and running commands instead. Set false only for tasks that genuinely
   * need a browser preview.
   */
  avoidBrowser: z.boolean().default(true),
  /**
   * Append a large-file reading strategy instruction to every agy prompt:
   * files above 1 MB must NOT be read with agy's file-read tool (it fails
   * above its 4 MB cap — e.g. single-file components with embedded assets);
   * they must be inspected via grep/sed/head/tail/python through
   * run_command instead. Guidance, not enforcement: the plugin cannot
   * intercept agy's internal tool calls.
   */
  avoidLargeReads: z.boolean().default(true),
  /**
   * When a run fails with an authentication error, automatically pop up
   * agy's interactive login window (a new console running `agy`, which
   * opens the Google sign-in flow) so the user can authenticate on the
   * spot; the error message notes that a window was opened. Windows only
   * (other platforms get instructions). Disable for headless deployments.
   */
  autoLoginWindow: z.boolean().default(true),
  /** Model-facing tool name for the manual login-window opener. */
  loginToolName: z.string().default('antigravity_login'),
  /**
   * Launch the interactive login window minimized (taskbar icon only, no
   * full black console) instead of a normal window. The TUI still works —
   * click the taskbar icon to open it when the browser flow needs input.
   */
  loginWindowMinimized: z.boolean().default(true),
  /** Model-facing tool name for listing tasks (running + recent registry history). */
  tasksToolName: z.string().default('antigravity_tasks'),
  /** Model-facing tool name for stopping a running task by its task key. */
  cancelToolName: z.string().default('antigravity_cancel'),
  /**
   * Wire output format for foreground runs. `json` is preferred: it returns
   * the agy `conversation_id` (required for follow-ups) plus a
   * machine-readable status/response, and it does not suffer the non-TTY
   * stdout drop. Background runs automatically prefer `stream-json` (live
   * progress) when the installed build supports it. If the installed agy
   * build rejects the flag (detected by a one-time probe), the provider
   * automatically falls back to text mode.
   */
  outputFormat: z.union([z.const('json'), z.const('text')]).default('json'),
  /** Raw extra argv appended after every generated flag (advanced). */
  extraArgs: z.array(z.string()).default([]),
  /** Working-directory override; empty uses the delegating session's cwd. */
  cwd: z.string().default(''),
  /**
   * Extra directories to add to the agy workspace (`--add-dir`, repeatable).
   * Use absolute paths to targets OUTSIDE the session workspace: headless agy
   * cannot answer the interactive "add directory to workspace?" prompt, so
   * without this flag a task touching such a directory hangs until
   * `--print-timeout` fires.
   */
  addDirs: z.array(z.string()).default([]),
  /** Explicit environment overlay for the agy process (merged after the harness scrub). */
  env: z.dict(z.string()).default({}),
  /**
   * Proxy URL for the agy child (e.g. `http://127.0.0.1:7897`). Empty falls
   * back to the `AGY_PROXY` host env var, then to the first line of
   * `~/.dsh/agy-proxy.txt` (re-read on every call — write it to change the
   * proxy without a rebuild or restart). Google rejects Antigravity API
   * requests from unsupported regions with `User location is not supported`,
   * so a supported-region egress is required there.
   */
  proxy: z.string().default(''),
  /** Durable follow-up registry path; empty derives `~/.dsh/agy-conversations.json`. */
  registryPath: z.string().default(''),
  /**
   * Persist each run's raw agy event stream as NDJSON (v2). The stream carries
   * the agent's text, every tool call with its parameters, and the final
   * result, so a transcript is the only way to see what a delegated task
   * actually did. `transcriptDir` defaults to `~/.dsh/agy-transcripts`, one file
   * per task key plus an `index.json`.
   */
  /**
   * Where the probed agy flag support is cached. Omit it for the default
   * (`~/.dsh/agy-flag-cache.json`); pass `''` to disable the cache. It is keyed
   * by the executable's identity, so an agy self-update invalidates it on its
   * own; delete the file to force a re-probe.
   */
  flagCachePath: z.string(),
  transcript: z.boolean().default(true),
  /** Transcript directory override; empty derives `~/.dsh/agy-transcripts`. */
  transcriptDir: z.string().default(''),
  /** Grace period for tree-scoped termination (SIGTERM→SIGKILL escalation). */
  disposeGraceMs: z.number().step(1).min(100).max(120_000).default(5_000),
})

/** Runtime config after schemastery defaults. */
export interface Config {
  providerName: string
  toolName: string
  followupToolName: string
  command: string
  model: string
  effort: string
  agent: string
  printTimeoutMs: number
  watchdogMarginMs: number
  backgroundTimeoutMs: number
  skipPermissions: boolean
  sandbox: boolean
  avoidBrowser: boolean
  avoidLargeReads: boolean
  autoLoginWindow: boolean
  loginToolName: string
  loginWindowMinimized: boolean
  tasksToolName: string
  cancelToolName: string
  outputFormat: 'json' | 'text'
  transcript: boolean
  transcriptDir: string
  flagCachePath: string | undefined
  extraArgs: string[]
  cwd: string
  addDirs: string[]
  env: Record<string, string>
  proxy: string
  registryPath: string
  disposeGraceMs: number
}

/** One durable task entry: the agy conversation a follow-up resumes. */
export interface TaskRecord {
  conversationId: string
  cwd: string
  label: string
  createdAt: number
  /** Model this run used — written by the panel-era builds; older entries lack it. */
  model?: string
}

/** Minimal logger shape for registry persistence (ctx.logger is assignable). */
export interface RegistryLogger {
  warn(message: string): void
}

/** Base directory for plugin-owned files: DSH_HOME, else `~/.dsh`. */
function pluginBaseDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return home !== undefined ? join(home, '.dsh') : ''
}

/**
 * Identity of one agy build: path + size + mtime. agy updates itself, so the
 * flag answers for 1.4.6 must not be reused for 1.4.7 — a stale "supported"
 * is worse than a stale "unsupported", because it fails at spawn time instead
 * of at probe time.
 * @param exe - absolute path to the agy executable.
 * @returns a stable cache key (falls back to the bare path when stat fails).
 */
function statStamp(exe: string): string {
  try {
    const info = statSync(exe)
    return `${info.size}:${Math.round(info.mtimeMs)}`
  } catch {
    return 'unknown'
  }
}

/**
 * Where probed flag support is cached across restarts.
 * @param config - the plugin configuration (`flagCachePath` overrides the default).
 * @returns the cache file path, or '' when no location is available.
 */
function flagCachePath(config: Config): string {
  // `undefined` (not configured) derives the default; `''` disables the cache,
  // which is how tests stay out of the developer's real DSH home.
  if (config.flagCachePath !== undefined) return config.flagCachePath
  const base = pluginBaseDir()
  return base.length > 0 ? join(base, 'agy-flag-cache.json') : ''
}

/**
 * Read cached flag support for one agy build.
 * @param identity - the `exe@size:mtime` key from `statStamp`.
 * @returns the cached support, or undefined when absent/unreadable.
 */
function readFlagCache(config: Config, identity: string): AgyFlagSupport | undefined {
  try {
    const path = flagCachePath(config)
    if (path.length === 0) return undefined
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const entry = (parsed as Record<string, unknown>)[identity]
    if (entry === null || typeof entry !== 'object') return undefined
    const candidate = entry as Partial<AgyFlagSupport>
    if (typeof candidate.outputFormat !== 'boolean' || typeof candidate.probed !== 'boolean') return undefined
    return { ...UNKNOWN_FLAG_SUPPORT, ...candidate } as AgyFlagSupport
  } catch {
    return undefined
  }
}

/**
 * Persist flag support for one agy build. Best effort: keeps the 8 most recent
 * builds and never throws, because a cache write must not fail a run.
 * @param identity - the `exe@size:mtime` key.
 * @param support - the resolved flag support.
 */
function writeFlagCache(config: Config, identity: string, support: AgyFlagSupport): void {
  try {
    const path = flagCachePath(config)
    if (path.length === 0) return
    let table: Record<string, AgyFlagSupport> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') table = parsed as Record<string, AgyFlagSupport>
    } catch {
      // corrupt cache: start over rather than inheriting stale flags
    }
    table[identity] = support
    const keys = Object.keys(table)
    for (const stale of keys.slice(0, Math.max(0, keys.length - 8))) delete table[stale]
    writeFileSync(path, JSON.stringify(table, null, 2), 'utf8')
  } catch {
    // best effort
  }
}

/** Resolve the proxy URL for the agy child: config → AGY_PROXY env → ~/.dsh/agy-proxy.txt. */
function resolveProxyUrl(config: Config): string {
  if (config.proxy.length > 0) return config.proxy
  const envProxy = process.env.AGY_PROXY
  if (envProxy !== undefined && envProxy.length > 0) return envProxy
  try {
    const base = pluginBaseDir()
    if (base.length === 0) return ''
    const text = readFileSync(join(base, 'agy-proxy.txt'), 'utf8').trim()
    return text.length > 0 ? text : ''
  } catch {
    return ''
  }
}

/** Apply the resolved proxy to a child environment (upper+lower variants, Go/npm convention). */
function applyProxyEnv(env: Record<string, string>, proxy: string): void {
  if (proxy.length === 0) return
  env.HTTP_PROXY = proxy
  env.HTTPS_PROXY = proxy
  env.ALL_PROXY = proxy
  env.http_proxy = proxy
  env.https_proxy = proxy
  env.all_proxy = proxy
  if (env.NO_PROXY === undefined && env.no_proxy === undefined) {
    env.NO_PROXY = 'localhost,127.0.0.1,::1'
  }
}

/** Durable follow-up registry (task key = the DSH run id). */
export function registryFilePath(config: Config): string {
  if (config.registryPath.length > 0) return config.registryPath
  return join(pluginBaseDir(), 'agy-conversations.json')
}

function registryDir(base: string): string {
  const dir = dirname(base)
  return dir.length === 0 ? '.' : dir
}

/** Back up a corrupt registry file once per corruption event (mtime guard), then reset. */
function backupCorruptRegistry(file: string, rawText: string, warn: (message: string) => void): void {
  if (rawText.trim().length === 0) return
  const backup = `${file}.corrupt`
  try {
    const backupStat = statSync(backup)
    const fileStat = statSync(file)
    if (backupStat.mtimeMs >= fileStat.mtimeMs) {
      warn(
        `${PREFIX}: task registry ${file} is corrupt (${rawText.length} bytes) — the previous content is preserved at ${backup}; the registry restarts fresh`,
      )
      return
    }
  } catch {
    // no backup yet — write one below
  }
  try {
    writeFileSync(backup, rawText, 'utf8')
    warn(`${PREFIX}: task registry ${file} is corrupt (${rawText.length} bytes) — original backed up to ${backup}; the registry restarts fresh`)
  } catch (error) {
    warn(`${PREFIX}: task registry ${file} is corrupt (${rawText.length} bytes) and could not be backed up: ${String(error)}`)
  }
}

/**
 * Load the durable follow-up registry, self-healing on damage: a missing
 * file is a normal fresh state; a corrupt or wrongly-shaped file is backed
 * up once (`.corrupt`, guarded by mtime) instead of being silently
 * overwritten by the next save; malformed entries are dropped with a
 * warning. A crash or hand-edit can never silently wipe the history.
 */
export function loadTaskRegistry(config: Config, logger?: RegistryLogger): Record<string, TaskRecord> {
  const file = registryFilePath(config)
  const warn = logger?.warn ?? ((message: string) => console.warn(message))
  let rawText: string
  try {
    rawText = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    backupCorruptRegistry(file, rawText, warn)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    backupCorruptRegistry(file, rawText, warn)
    return {}
  }
  const records: Record<string, TaskRecord> = {}
  let dropped = 0
  for (const [key, value] of Object.entries(parsed)) {
    const entry = value as Partial<TaskRecord> | null | undefined
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.conversationId === 'string' &&
      entry.conversationId.length > 0 &&
      typeof entry.cwd === 'string' &&
      typeof entry.createdAt === 'number' &&
      Number.isFinite(entry.createdAt)
    ) {
      records[key] = {
        conversationId: entry.conversationId,
        cwd: entry.cwd,
        label: typeof entry.label === 'string' ? entry.label : '',
        createdAt: entry.createdAt,
        ...(typeof entry.model === 'string' && entry.model.length > 0 ? { model: entry.model } : {}),
      }
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) warn(`${PREFIX}: dropped ${dropped} malformed entry(ies) from task registry ${file}`)
  return records
}

/**
 * Replace `filePath` with `data` in one atomic step: write a unique sibling
 * temp file, then rename it over the target. A crash mid-write leaves the old
 * file intact (the temp is discarded), so readers never observe a torn file —
 * the transcript index resolves every lookup, so a torn index would take all
 * of them down at once. The temp name embeds the pid and a random suffix, so
 * concurrent writers (same or another process) never collide on the temp path.
 */
export function writeJsonAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, filePath)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** Trim to the newest MAX_TASK_RECORDS entries and write atomically (tmp + rename). */
function doSaveRegistry(config: Config, records: Record<string, TaskRecord>): void {
  const entries = Object.entries(records)
    .sort((a, b) => (b[1]?.createdAt ?? 0) - (a[1]?.createdAt ?? 0))
    .slice(0, MAX_TASK_RECORDS)
  const trimmed: Record<string, TaskRecord> = {}
  for (const [key, record] of entries) trimmed[key] = record
  const base = registryFilePath(config)
  const dir = registryDir(base)
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(base, JSON.stringify(trimmed, null, 2))
}

/**
 * Serialize every registry write through one module-level queue so
 * concurrent tool calls cannot read-modify-write over each other. The write
 * itself is atomic (tmp + rename), so a crash mid-write never corrupts the
 * registry. Persistence is best-effort: a failed write only loses future
 * follow-ups.
 */
let registryTail: Promise<void> = Promise.resolve()
export function saveTaskRegistry(config: Config, records: Record<string, TaskRecord>, logger?: RegistryLogger): Promise<void> {
  const run = registryTail.then(() => {
    try {
      doSaveRegistry(config, records)
    } catch (error) {
      const warn = logger?.warn ?? ((message: string) => console.warn(message))
      warn(`${PREFIX}: failed to persist task registry: ${String(error)}`)
    }
  })
  registryTail = run
  return run
}

/**
 * Atomically read-modify-write the durable registry through the same
 * serialization queue as {@link saveTaskRegistry}: concurrent tool calls
 * (e.g. a foreground and a background run finishing at the same time) can
 * no longer lose each other's records to a stale read-modify-write race.
 * The write itself is atomic (tmp + rename) and failures are contained
 * (best-effort persistence, like saveTaskRegistry).
 */
export function updateTaskRegistry(
  config: Config,
  mutate: (records: Record<string, TaskRecord>) => void,
  logger?: RegistryLogger,
): Promise<void> {
  const run = registryTail.then(() => {
    try {
      const records = loadTaskRegistry(config, logger)
      mutate(records)
      doSaveRegistry(config, records)
    } catch (error) {
      const warn = logger?.warn ?? ((message: string) => console.warn(message))
      warn(`${PREFIX}: failed to persist task registry: ${String(error)}`)
    }
  })
  registryTail = run
  return run
}

/** Extract the joined text of a prompt's text blocks. */
function textOfPrompt(prompt: readonly { type: string; text?: string }[]): string {
  return prompt
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/** Wrap text as one canonical text ContentBlock, or [] when empty. */
function textBlocks(text: string): { type: 'text'; text: string }[] {
  return text.length === 0 ? [] : [{ type: 'text', text }]
}

/** agy `--output-format json` replies, or undefined when stdout is not JSON. */
interface AgyJsonReply {
  conversation_id?: string
  status?: string
  response?: string
  error?: string
}

/** Parse one candidate JSON object if it looks like an agy reply. */
function parseJsonObject(text: string): AgyJsonReply | undefined {
  try {
    const obj = JSON.parse(text) as unknown
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      const reply = obj as AgyJsonReply
      if ('status' in reply || 'conversation_id' in reply || 'response' in reply) return reply
    }
  } catch {
    // not JSON
  }
  return undefined
}

/**
 * Find the agy JSON reply in stdout: try the whole trimmed output first,
 * then scan line by line so a preamble (progress/status line before the
 * JSON object) cannot hide the `conversation_id`.
 *
 * v3 — `stream-json` support. In stream-json mode agy emits NDJSON in which the
 * terminal object is `{"event":"result","result":{status,response,...}}`. The
 * reply is nested one level deeper than the plain `json` mode, so the generic
 * scan below used to return the *first* object it saw (the `init` event, which
 * has no `status`/`response`) and the caller reported a successful run as
 * `agy exited with code 0`. Look for the `result` event explicitly first.
 */
function tryParseJsonOutput(stdout: string): AgyJsonReply | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const candidate = line.trim()
    if (candidate.length === 0 || candidate[0] !== '{') continue
    try {
      const obj = JSON.parse(candidate) as unknown
      if (obj !== null && typeof obj === 'object' && (obj as { event?: unknown }).event === 'result') {
        const inner = (obj as { result?: unknown }).result
        if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
          return inner as AgyJsonReply
        }
      }
    } catch {
      // not JSON on this line
    }
  }
  const trimmed = stdout.trim()
  if (trimmed.length > 0 && trimmed[0] === '{') {
    const whole = parseJsonObject(trimmed)
    if (whole !== undefined) return whole
  }
  for (const line of stdout.split(/\r?\n/)) {
    const candidate = line.trim()
    if (candidate.length === 0 || candidate[0] !== '{') continue
    const parsed = parseJsonObject(candidate)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** True when agy rejected the *syntax* of `--print-timeout` (it wants a unit). */
const TIME_UNIT_ERROR_RE = /missing unit in duration|invalid duration/i

/** True when agy rejected a flag it does not define (older builds). */
function isUnknownFlagError(stderr: string): boolean {
  return /flag provided but not defined|unknown flag|not defined: -output-format/i.test(stderr)
}

// ── Per-run transcripts (v2, v4) ────────────────────────────────────────────
// The agy event stream is the only complete record of a delegated task: the
// final `response` alone hides which tools ran and with what arguments.

/**
 * First transcript line: the prompt the caller asked (v4). The agy event stream
 * itself does not carry the prompt, so without this the transcript would start
 * mid-flight and the reader could not tell what agy was asked to do.
 * @param plan - the run plan.
 * @returns one NDJSON line, or '' when the header cannot be serialized.
 */
function transcriptHeader(plan: SpawnPlan, status?: 'cancelled' | 'timeout'): string {
  try {
    return (
      JSON.stringify({
        event: 'prompt',
        task: plan.id,
        label: plan.label,
        cwd: plan.childCwd,
        model: plan.model,
        prompt: plan.prompt,
        ...(status !== undefined ? { status } : {}),
      }) + '\n'
    )
  } catch {
    return ''
  }
}

/**
 * Directory where per-run transcripts are written.
 * @param config - the plugin configuration.
 * @returns the transcript directory.
 */
function resolveTranscriptDir(config: Config): string {
  if (typeof config.transcriptDir === 'string' && config.transcriptDir.length > 0) return config.transcriptDir
  return join(homedir(), '.dsh', 'agy-transcripts')
}

/**
 * Persist the raw agy event stream of one run and index it.
 *
 * Best effort by design: a transcript failure must never fail the run that
 * produced it, so every error collapses to `undefined`.
 * @param config - the plugin configuration.
 * @param id - the run id (the task key the tools hand out).
 * @param text - the raw NDJSON stream.
 * @returns the transcript path, or undefined when writing failed.
 */
function writeTranscript(config: Config, id: string, text: string): string | undefined {
  try {
    const dir = resolveTranscriptDir(config)
    mkdirSync(dir, { recursive: true })
    // Run ids look like `<session>::agy::<seq>`; `:` is not portable in a
    // filename, so the same sanitizer is applied here and nowhere else — the
    // reader (agy-transcript.mjs) resolves files through index.json.
    const safe = String(id).replace(/[^A-Za-z0-9._-]+/g, '_')
    const path = join(dir, `${safe}.ndjson`)
    writeFileSync(path, text, 'utf8')
    const indexPath = join(dir, 'index.json')
    let index: { task: string; file: string; at: string }[] = []
    try {
      const raw = readFileSync(indexPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) index = parsed as { task: string; file: string; at: string }[]
    } catch {
      index = []
    }
    index = index.filter((entry) => entry && entry.task !== id)
    index.push({ task: id, file: path, at: new Date().toISOString() })
    index = index.slice(-100)
    writeJsonAtomic(indexPath, JSON.stringify(index, null, 2))
    return path
  } catch {
    return undefined
  }
}

/** True when the detail smells like a missing/expired login. */
function isAuthError(detail: string): boolean {
  return /authentication required|not logged in|please (log|sign) in|login required|unauthenticated/i.test(detail)
}

/**
 * One stream-mode rule for both executors: stream only when the probe
 * CONFIRMED stream-json, otherwise plain json. The background path used a
 * looser `streamJson || !probed` guess, so one installed build could get two
 * different protocols depending on which executor picked it; the background
 * parser already falls back to a bare json reply, so strict is safe there too.
 */
function resolveStreamMode(support: AgyFlagSupport): 'stream-json' | 'json' {
  return support.streamJson === true ? 'stream-json' : 'json'
}

/** Append an actionable authentication hint when the detail smells like a missing login. */
function authHintFor(detail: string): string {
  if (!isAuthError(detail)) return detail
  return `${detail}\nHint: authenticate once by running \`agy\` interactively (agy → login), or set ANTIGRAVITY_API_KEY.`
}

/** Cooldown between automatic login-window launches (avoid popup storms). */
const LOGIN_LAUNCH_COOLDOWN_MS = 15_000
let lastLoginLaunchAt = 0

/** Result of the one-time `agy help` flag probe. `probed` false = probe failed, assume standard flags. */
interface AgyFlagSupport {
  outputFormat: boolean
  conversation: boolean
  sandbox: boolean
  addDir: boolean
  promptFile: boolean
  streamJson: boolean
  /** `--print-timeout` wants an explicit unit (`300s`), not a bare millisecond count. */
  durationTimeout: boolean
  /** `--print-timeout` accepted a bare millisecond count (pre-1.4 builds). */
  bareTimeout: boolean
  probed: boolean
}

/** Probe failed (agy absent/help not parseable): keep the historic behavior for real flags, never invent --prompt-file. */
const UNKNOWN_FLAG_SUPPORT: AgyFlagSupport = {
  outputFormat: true,
  conversation: true,
  sandbox: true,
  addDir: true,
  promptFile: false,
  streamJson: true,
  // unknown builds: agy 1.4.x wants a unit; the old bare-number form is the
  // riskier assumption, so prefer the unit and let the probe decide.
  durationTimeout: true,
  bareTimeout: false,
  probed: false,
}

/** Parse flag support out of `agy help` usage text (exit code is unreliable: `--help` itself is an unknown flag). */
function parseFlagSupport(text: string): AgyFlagSupport {
  const has = (flag: string): boolean => new RegExp(`--${flag}(?:\\s|=)`).test(text)
  return {
    outputFormat: has('output-format'),
    conversation: has('conversation'),
    sandbox: has('sandbox'),
    addDir: has('add-dir'),
    promptFile: has('prompt-file'),
    // `stream-json` is a VALUE of `--output-format` (not a flag), so match the bare word.
    streamJson: /\bstream-json\b/.test(text),
    // The usage line documents the flag but not its accepted syntax. agy 1.4.x
    // parses it with Go's time.ParseDuration (`time: missing unit in duration`),
    // so an explicit unit is the safe default; the runtime fallback in
    // probePrintTimeout() flips to `bareTimeout` if that ever regresses.
    durationTimeout: has('print-timeout'),
    bareTimeout: false,
    probed: has('print') || has('conversation'),
  }
}

/**
 * Validate `--add-dir` entries: absolute, existing, real directories. Fail
 * BEFORE the spawn — a wrong path would otherwise cost agy a full
 * `--print-timeout` hang instead of an immediate clear error.
 */
function validateAddDirs(prefix: string, dirs: readonly string[], source: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of dirs) {
    const dir = raw.trim()
    if (dir.length === 0) continue
    if (!isAbsolute(dir)) {
      throw new Error(`${prefix}: addDirs[${source}] must be an absolute path (got "${dir}")`)
    }
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(dir)
    } catch {
      throw new Error(`${prefix}: addDirs[${source}] does not exist: ${dir}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`${prefix}: addDirs[${source}] is not a directory: ${dir}`)
    }
    if (!seen.has(dir)) {
      seen.add(dir)
      out.push(dir)
    }
  }
  return out
}

/** The seam request shape the follow-up tool hands to the provider directly. */
export interface FollowupRequest {
  label?: string
  prompt: ContentBlock[]
  parent: Agent
  signal: AbortSignal
}

/** Hooks shape registered with `ctx.jobs` for a background agy run (mirrors dsh-tool-pwsh's background adaptation). */
export interface AntigravityBackgroundHandle {
  /** Stop the run (job_kill). */
  cancel: (reason?: string) => void
  /** Settles with the generic task-outcome vocabulary. */
  done: Promise<{ status: 'killed' | 'completed' | 'failed'; detail: string }>
  /** Incremental output delta since the previous read. */
  readOutput: () => string
  /** Last tool name agy reported for this run, when the stream carries one. */
  tool?: () => string | null
  /**
   * The structured step timeline of this run: what agy did, in order, with
   * which arguments and with which failure. Optional, so handles without a
   * step stream (older builds, the offline test harness) keep working.
   */
  steps?: () => StepEvent[]
}

/** One in-flight run tracked for the tasks/cancel tool layer (foreground or background). */
export interface ActiveRunInfo {
  label: string
  cwd: string
  startedAt: number
  background: boolean
  cancel: () => void
}

/** What the sidebar panel hands to the provider to resume one conversation. */
export interface PanelRunInput {
  /** Synthetic session id: only used for run ids and task records. */
  sessionId: string
  /** Session cwd `spawnPlan` inherits from; the run's own cwd comes from the registry. */
  baseCwd: string
  label: string
  prompt: string
  conversationId: string
  /** Registry-recorded project directory of the original run. */
  cwd: string
}

/** Everything both the foreground and the background path need before spawning. */
interface SpawnPlan {
  childCwd: string
  env: Record<string, string>
  exe: string
  support: AgyFlagSupport
  /** Foreground JSON mode (conversation_id capture). */
  jsonMode: boolean
  /** Background stream-json mode (live text deltas + conversation_id). */
  streamMode: boolean
  baseArgv: string[]
  promptFilePath: string | undefined
  releasePromptFile: () => void
  id: SessionId
  label: string
  /** Resolved model flag (for the transcript header; '' means agy's default). */
  model: string
  /** The prompt text actually sent (transcript header; v4). */
  prompt: string
}

class AntigravitySubagentProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly name: string

  /** Ephemeral runId → agy conversation bridge for the tool layer. */
  private readonly runRecords = new Map<string, TaskRecord>()
  /** Per-conversation gates: follow-ups to one agy conversation run strictly one at a time. */
  private readonly followupGates = new Map<string, Promise<void>>()
  /** Cached result of the one-time flag probe (`agy help` + `--print-timeout` syntax). */
  private flagSupport: AgyFlagSupport | undefined
  /** The agy build identity `flagSupport` was resolved for; a new build invalidates it. */
  private flagProbeIdentity: string | undefined
  /** Per-provider run id sequence (module-level state would reset on HMR reloads). */
  private runSeq = 0
  /** Live in-flight runs (foreground + background), for the tasks/cancel tools. */
  private readonly activeRuns = new Map<string, ActiveRunInfo>()
  /** Model catalogue behind `model: auto`; undefined until the cache or probe lands. */
  private modelCatalog: ModelCatalog | undefined
  /** Single-flight guard: startup, panel and the first run must share one probe. */
  private modelCatalogLoading: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly configuredCwd: string | undefined,
  ) {
    this.name = config.providerName
  }

  /** The bridge record for one finished run (for persistence), if captured. */
  recordOf(runId: string): TaskRecord | undefined {
    return this.runRecords.get(runId)
  }

  /** Register one in-flight run; released automatically when `settled` resolves or rejects. */
  private trackActive(task: string, info: ActiveRunInfo, settled: Promise<unknown>): void {
    this.activeRuns.set(task, info)
    const release = (): void => {
      if (this.activeRuns.get(task) === info) this.activeRuns.delete(task)
    }
    void settled.then(release, release)
  }

  /** Snapshot of every in-flight run (foreground + background), newest first. */
  listActive(): { task: string; label: string; cwd: string; background: boolean; startedAt: number }[] {
    return [...this.activeRuns.entries()]
      .sort((a, b) => b[1].startedAt - a[1].startedAt)
      .map(([task, info]) => ({
        task,
        label: info.label,
        cwd: info.cwd,
        background: info.background,
        startedAt: info.startedAt,
      }))
  }

  /** Request cancellation of one in-flight run by its task key; false when it is not tracked. */
  cancelActive(task: string): boolean {
    const info = this.activeRuns.get(task)
    if (info === undefined) return false
    info.cancel()
    return true
  }

  /**
   * Everything a side probe needs to launch agy exactly like a run would:
   * the resolved binary plus the scrubbed/proxied environment. The panel's
   * usage probe uses this so it never depends on the host process PATH.
   */
  async probeEnvironment(): Promise<{ exe: string; env: Record<string, string>; cwd: string }> {
    const { config } = this
    const env = { ...scrubbedParentEnv(), ...config.env }
    applyProxyEnv(env, resolveProxyUrl(config))
    const exe = await this.resolveCommandPath(env, new AbortController().signal)
    return { exe, env, cwd: this.configuredCwd ?? process.cwd() }
  }

  /**
   * Load and (when stale) refresh the `agy models` catalogue used by
   * `model: auto`. Called once from `apply()` without awaiting: the probe is a
   * ~11 s network call and DSH boot must not wait for it. Concurrent callers
   * share one probe.
   */
  async warmModelCatalog(): Promise<void> {
    if (this.modelCatalogLoading !== undefined) return this.modelCatalogLoading
    this.modelCatalogLoading = this.loadModelCatalog()
    try {
      await this.modelCatalogLoading
    } finally {
      this.modelCatalogLoading = undefined
    }
  }

  /**
   * The model flag this run should use. `auto` resolves through the catalogue;
   * everything else is passed through verbatim, and an empty catalogue leaves
   * the flag off (agy's own default) rather than guessing.
   */
  private resolvedModel(): string {
    const configured = this.config.model.trim()
    if (configured.toLowerCase() !== 'auto') return configured
    return this.modelCatalog?.chosen ?? ''
  }

  private modelCacheFile(): string {
    return join(pluginBaseDir(), 'agy-models.json')
  }

  private async loadModelCatalog(): Promise<void> {
    const file = this.modelCacheFile()
    const cached = readModelCatalog(file)
    if (cached !== undefined) this.modelCatalog = cached
    if (cached !== undefined && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) return
    try {
      const { exe, env, cwd } = await this.probeEnvironment()
      const text = await this.captureModels(exe, env, cwd)
      const models = parseModels(text)
      if (models.length === 0) {
        this.ctx.logger.warn(
          `${PREFIX}: \`agy models\` listed no models; keeping ${cached === undefined ? 'agy default model selection' : 'the cached catalogue'}`,
        )
        return
      }
      const chosen = pickDeepestFlash(models)
      const catalog: ModelCatalog = { fetchedAt: Date.now(), chosen, models }
      this.modelCatalog = catalog
      writeModelCatalog(file, catalog)
      this.ctx.logger.info(
        `${PREFIX}: model catalogue refreshed (${models.length} models, auto → ${chosen.length > 0 ? chosen : 'agy default'})`,
      )
    } catch (error) {
      this.ctx.logger.warn(
        `${PREFIX}: \`agy models\` probe failed (${error instanceof Error ? error.message : String(error)}); ${cached === undefined ? 'model: auto will omit --model' : 'using the cached catalogue'}`,
      )
    }
  }

  /** Run `agy models` and return its combined output, bounded by a watchdog. */
  private async captureModels(exe: string, env: Record<string, string>, cwd: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODEL_PROBE_TIMEOUT_MS)
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [exe, 'models'],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 << 10 },
          stderr: { maxBytes: 32 << 10 },
        },
        graceMs: this.config.disposeGraceMs,
        signal: controller.signal,
        env,
      })
      await handle.done
      return (
        (handle.collected?.stdout?.readFrom(0).text ?? '') + (handle.collected?.stderr?.readFrom(0).text ?? '')
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /** Terminate every in-flight run (plugin stop/update): returns how many were cancelled. */
  terminateAllActive(): number {
    let count = 0
    for (const info of this.activeRuns.values()) {
      info.cancel()
      count += 1
    }
    return count
  }

  private nextRunId(): string {
    this.runSeq += 1
    return `${Date.now().toString(36)}-${this.runSeq.toString(36)}`
  }

  private remember(
    runId: string,
    conversationId: string | undefined,
    cwd: string,
    label: string,
    model: string,
  ): void {
    if (conversationId === undefined || conversationId.length === 0) return
    this.runRecords.set(runId, {
      conversationId,
      cwd,
      label,
      createdAt: Date.now(),
      ...(model.length > 0 ? { model } : {}),
    })
    if (this.runRecords.size > MAX_RUN_RECORDS) {
      const oldest = [...this.runRecords.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (oldest !== undefined) this.runRecords.delete(oldest[0])
    }
  }

  /**
   * Resolve the configured command through the subprocess seam (PATH lookup),
   * falling back to well-known install locations and the AGY_BIN override when
   * PATH misses it — the official Windows installer drops the binary into
   * `%LOCALAPPDATA%\agy\bin`, which is rarely on any process PATH.
   */
  private async resolveCommandPath(env: Record<string, string>, signal: AbortSignal): Promise<string> {
    const { ctx, config } = this
    let pathError: unknown
    try {
      return await ctx.subprocess.resolveExecutable(config.command, env, signal)
    } catch (error) {
      pathError = error
    }
    const exeName = process.platform === 'win32' ? 'agy.exe' : 'agy'
    const candidates: string[] = []
    if (process.env.AGY_BIN !== undefined && process.env.AGY_BIN.length > 0) candidates.push(process.env.AGY_BIN)
    if (process.env.LOCALAPPDATA !== undefined) candidates.push(join(process.env.LOCALAPPDATA, 'agy', 'bin', exeName))
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (home !== undefined) {
      candidates.push(join(home, '.local', 'bin', exeName))
      candidates.push(join(home, '.gemini', 'bin', exeName))
      candidates.push(join(home, 'go', 'bin', exeName))
    }
    for (const candidate of candidates) {
      try {
        const resolved = await ctx.subprocess.resolveExecutable(candidate, env, signal)
        ctx.logger.warn(`${PREFIX}: "${config.command}" not found on PATH, using fallback ${resolved}`)
        return resolved
      } catch {
        // try the next candidate
      }
    }
    throw pathError instanceof Error ? pathError : new Error(`${PREFIX}: cannot resolve "${config.command}"`)
  }

  private async resolveExecutable(request: ResolvedSubagentStartRequest, env: Record<string, string>): Promise<string> {
    return this.resolveCommandPath(env, request.signal)
  }

  /**
   * Open agy's interactive login in a new console window (Windows) so the
   * user can authenticate on the spot; other platforms get instructions.
   * Fire-and-forget: the window is the user's to close.
   */
  async launchLogin(): Promise<string> {
    const { ctx, config } = this
    const env = { ...scrubbedParentEnv(), ...config.env }
    applyProxyEnv(env, resolveProxyUrl(config))
    const controller = new AbortController()
    const exe = await this.resolveCommandPath(env, controller.signal)
    if (process.platform === 'win32') {
      try {
        // PowerShell Start-Process opens the console app in its own window.
        // Single-quoted path avoids the cmd `start` title/command quoting
        // hell (which previously mangled the command into a bogus "loginy").
        const psPath = exe.replace(/'/g, "''")
        const style = config.loginWindowMinimized ? ' -WindowStyle Minimized' : ''
        ctx.subprocess.spawn({
          argv: ['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath '${psPath}'${style}`],
          cwd: process.cwd(),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4 << 10 },
            stderr: { maxBytes: 4 << 10 },
          },
          graceMs: config.disposeGraceMs,
        })
        lastLoginLaunchAt = Date.now()
        return `Opened the interactive Antigravity login window (${exe}). Complete the sign-in in the new window (a browser may open for Google sign-in), close it, then retry the antigravity tool.`
      } catch (error) {
        return `Could not open a login window automatically (${error instanceof Error ? error.message : String(error)}). Please open a terminal, run \`agy\` and complete the sign-in, then retry.`
      }
    }
    return 'On this platform the plugin cannot open an interactive terminal automatically. Please open a terminal, run `agy` and complete the sign-in, then retry.'
  }

  /**
   * Enrich an auth-error detail: append the manual hint, and when
   * `autoLoginWindow` is on, pop the interactive login window once (with a
   * cooldown) and say so.
   */
  private maybeAutoLogin(detail: string): string {
    const hinted = authHintFor(detail)
    if (!isAuthError(detail) || !this.config.autoLoginWindow) return hinted
    const now = Date.now()
    if (now - lastLoginLaunchAt < LOGIN_LAUNCH_COOLDOWN_MS) return hinted
    lastLoginLaunchAt = now
    void this.launchLogin().then(
      (message) => this.ctx.logger.info(`${PREFIX}: ${message}`),
      (error) => this.ctx.logger.warn(`${PREFIX}: could not open login window: ${String(error)}`),
    )
    return `${hinted}\n(A login window has been opened on the machine — complete the sign-in there, then retry.)`
  }

  /**
   * Probe which flags the installed agy build understands. Runs once per
   * provider instance (cached), cheap (~100 ms), and never requires a login.
   * `agy --help` itself is an unknown flag on some builds, so the probe uses
   * `help` and accepts the usage dump regardless of the exit code.
   */
  private async probeFlags(exe: string, env: Record<string, string>, cwd: string): Promise<AgyFlagSupport> {
    let support = UNKNOWN_FLAG_SUPPORT
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [exe, 'help'],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 << 10 },
          stderr: { maxBytes: 64 << 10 },
        },
        graceMs: this.config.disposeGraceMs,
        signal: controller.signal,
        env,
      })
      await handle.done
      const text =
        (handle.collected?.stdout?.readFrom(0).text ?? '') + (handle.collected?.stderr?.readFrom(0).text ?? '')
      support = parseFlagSupport(text)
    } catch (error) {
      this.ctx.logger.warn(
        `${PREFIX}: flag probe failed (${error instanceof Error ? error.message : String(error)}); assuming standard flags`,
      )
    } finally {
      clearTimeout(timer)
    }
    this.ctx.logger.info(`${PREFIX}: agy flag support: ${JSON.stringify(support)}`)
    return support
  }

  /**
   * Flag support for this exact agy build.
   *
   * Keyed by the executable's identity (path + size + mtime), not by provider
   * instance: agy ships updates on its own, and a cache that outlives the
   * binary silently applies yesterday's answers to today's CLI. Everything the
   * spawn path depends on is resolved once here — including the
   * `--print-timeout` spelling — so a later run cannot fail on a stale guess.
   */
  private async resolveFlagSupport(
    exe: string,
    env: Record<string, string>,
    cwd: string,
  ): Promise<AgyFlagSupport> {
    const identity = `${exe}@${statStamp(exe)}`
    if (this.flagSupport !== undefined && this.flagProbeIdentity === identity) return this.flagSupport
    const cached = readFlagCache(this.config, identity)
    if (cached !== undefined) {
      this.flagSupport = cached
      this.flagProbeIdentity = identity
      this.ctx.logger.info(`${PREFIX}: agy flag support (cached for ${identity}): ${JSON.stringify(cached)}`)
      return cached
    }
    let support = await this.probeFlags(exe, env, cwd)
    support = await this.probePrintTimeout(support, exe, env, cwd, this.ctx.logger)
    this.flagSupport = support
    this.flagProbeIdentity = identity
    writeFlagCache(this.config, identity, support)
    return support
  }

  /**
   * Confirm how this build wants `--print-timeout` spelled.
   *
   * `agy help` documents the flag but not its syntax, and the accepted form
   * changed under us: 1.4.x parses it with Go's time.ParseDuration and rejects
   * a bare millisecond count ("time: missing unit in duration"), while earlier
   * builds took the bare number. One ultra-short probe settles it, costs ~50 ms,
   * and — unlike guessing — cannot turn every later run into a hard failure.
   * Nothing is spawned when the initial guess already works.
   */
  private async probePrintTimeout(
    support: AgyFlagSupport,
    exe: string,
    env: Record<string, string>,
    cwd: string,
    log: { info(message: string): void; warn(message: string): void },
  ): Promise<AgyFlagSupport> {
    const run = async (value: string): Promise<string | undefined> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      try {
        const handle = this.ctx.subprocess.spawn({
          argv: [exe, '--print', 'x', '--print-timeout', value],
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 8 << 10 },
            stderr: { maxBytes: 8 << 10 },
          },
          graceMs: this.config.disposeGraceMs,
          signal: controller.signal,
          env,
        })
        await handle.done
        return (handle.collected?.stderr?.readFrom(0).text ?? '') + (handle.collected?.stdout?.readFrom(0).text ?? '')
      } catch (error) {
        log.warn(`${PREFIX}: --print-timeout probe (${value}) failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }
    // A rejected duration is reported before any work starts, so agy exits fast
    // and says "missing unit"/"invalid duration". Anything else (a login prompt,
    // a model error) means the flag itself parsed fine.
    const rejected = (text: string | undefined): boolean => text !== undefined && TIME_UNIT_ERROR_RE.test(text)
    const order = support.bareTimeout ? ['bare', 'duration'] : ['duration', 'bare']
    for (const candidate of order) {
      const value = candidate === 'bare' ? '1' : '1ms'
      const text = await run(value)
      if (text === undefined) return support // probe unusable: keep the guess
      if (!rejected(text)) {
        if (support.durationTimeout !== (candidate === 'duration') || support.bareTimeout !== (candidate === 'bare')) {
          log.info(`${PREFIX}: --print-timeout syntax confirmed as ${candidate}`)
        }
        return { ...support, durationTimeout: candidate === 'duration', bareTimeout: candidate === 'bare' }
      }
    }
    log.warn(`${PREFIX}: this agy build rejected both --print-timeout spellings; relying on the local watchdog alone`)
    return { ...support, durationTimeout: false, bareTimeout: false }
  }

  /**
   * Shared pre-spawn planning for both the foreground and the background
   * path: env/cwd/exe resolution, the flag probe, prompt validation and the
   * argv-safe prompt-file path, and the full base argv (minus the wire
   * format and conversation flags, which each caller appends).
   */
  private async spawnPlan(
    request: ResolvedSubagentStartRequest,
    conversationId: string | undefined,
    cwdOverride: string | undefined,
    dirs: readonly string[],
    timeoutMs: number,
  ): Promise<SpawnPlan> {
    const { ctx, config } = this
    const addDirs = validateAddDirs(PREFIX, dirs, 'config/tool')
    const inheritedCwd = request.parent.session.header.cwd ?? ''
    const childCwd = cwdOverride ?? resolveChildCwd(inheritedCwd, this.configuredCwd ?? '')
    const env = { ...scrubbedParentEnv(), ...config.env }
    applyProxyEnv(env, resolveProxyUrl(config))
    const exe = await this.resolveExecutable(request, env)
    const promptText = textOfPrompt(request.prompt)
    if (promptText.trim().length === 0) throw new Error(`${PREFIX}: request prompt contains no text`)
    let effectivePrompt = promptText
    if (config.avoidBrowser) effectivePrompt += AVOID_BROWSER_SUFFIX
    if (config.avoidLargeReads) effectivePrompt += AVOID_LARGE_READ_SUFFIX

    const support = await this.resolveFlagSupport(exe, env, childCwd)
    if (conversationId !== undefined && !support.conversation) {
      throw new Error(
        `${PREFIX}: this agy build does not support --conversation — cannot resume task "${conversationId}". Upgrade agy or start a new task.`,
      )
    }
    const jsonMode = config.outputFormat === 'json' && (support.outputFormat || !support.probed)
    if (config.outputFormat === 'json' && support.probed && !support.outputFormat) {
      ctx.logger.warn(
        `${PREFIX}: this agy build lacks --output-format; running in text mode (no conversation_id, follow-ups will not record)`,
      )
    }
    if (config.sandbox && support.probed && !support.sandbox) {
      ctx.logger.warn(`${PREFIX}: this agy build lacks --sandbox; skipping the flag`)
    }
    if (addDirs.length > 0 && support.probed && !support.addDir) {
      throw new Error(
        `${PREFIX}: this agy build does not support --add-dir — cannot add ${addDirs.join(', ')}. Upgrade agy, or move the target inside the session workspace.`,
      )
    }

    // argv safety: never pass a giant prompt as one argument. agy has no
    // --prompt-file today; if a future build adds it, the probe enables it
    // automatically and the prompt is handed over via a temp file instead.
    let promptFilePath: string | undefined
    let promptArgv: string[]
    if (effectivePrompt.length > MAX_ARGV_PROMPT_CHARS) {
      if (!support.promptFile) {
        throw new Error(
          `${PREFIX}: prompt is ${effectivePrompt.length} chars, exceeding the ${MAX_ARGV_PROMPT_CHARS}-char argv limit, and this agy build does not support --prompt-file. Split the task into smaller steps, or write the bulky context into files in the workspace and reference them from a short prompt.`,
        )
      }
      promptFilePath = join(tmpdir(), `${PREFIX}-${this.nextRunId()}-prompt.txt`)
      try {
        writeFileSync(promptFilePath, effectivePrompt, 'utf8')
      } catch (error) {
        rmSync(promptFilePath, { force: true })
        throw error
      }
      promptArgv = ['--prompt-file', promptFilePath]
    } else {
      promptArgv = ['-p', effectivePrompt]
    }

    // agy parses `--print-timeout` with Go's time.ParseDuration, so a bare
    // millisecond count like "600000" is rejected outright ("time: missing unit
    // in duration"). Earlier builds tolerated the bare number; ago 1.4.x does
    // not. Always hand over an explicit unit, and degrade for builds whose
    // duration parser predates the "ms" suffix.
    const printTimeout = support.bareTimeout ? String(Math.max(1, Math.round(timeoutMs))) : `${Math.max(1, Math.round(timeoutMs))}ms`
    if (!support.durationTimeout && !support.bareTimeout) {
      ctx.logger.warn(`${PREFIX}: this agy build rejected both "<n>ms" and "<n>" for --print-timeout; relying on the local watchdog only`)
    }
    const baseArgv: string[] = [exe, ...promptArgv]
    if (support.durationTimeout || support.bareTimeout) baseArgv.push('--print-timeout', printTimeout)
    const model = this.resolvedModel()
    if (model.length > 0) baseArgv.push('--model', model)
    if (config.effort.length > 0) {
      // v5 — agy 1.4.6 accepts low | medium | high | xhigh | max. The old
      // three-value whitelist rejected `xhigh`/`max` outright, which made two
      // documented reasoning levels unusable. Warn on an unrecognized value but
      // still pass it through: agy is the authority on its own flag, and a
      // future build may add levels this plugin cannot know about.
      if (!EFFORT_LEVELS.includes(config.effort)) {
        ctx.logger.warn(`${PREFIX}: effort "${config.effort}" is not one of ${EFFORT_LEVELS.join(' | ')}; passing it to agy anyway`)
      }
      baseArgv.push('--effort', config.effort)
    }
    if (config.agent.length > 0) baseArgv.push('--agent', config.agent)
    if (config.skipPermissions) baseArgv.push('--dangerously-skip-permissions')
    if (config.sandbox && support.sandbox) baseArgv.push('--sandbox')
    for (const dir of addDirs) baseArgv.push('--add-dir', dir)
    baseArgv.push(...config.extraArgs)

    const releasePromptFile = (): void => {
      if (promptFilePath !== undefined) {
        try {
          rmSync(promptFilePath, { force: true })
        } catch {
          // best-effort temp cleanup
        }
      }
    }

    return {
      childCwd,
      env,
      exe,
      support,
      jsonMode,
      streamMode: jsonMode && resolveStreamMode(support) === 'stream-json',
      baseArgv,
      promptFilePath,
      releasePromptFile,
      id: `${request.parent.session.id}::agy::${this.nextRunId()}` as unknown as SessionId,
      label: request.label ?? 'antigravity task',
      model,
      prompt: promptText,
    }
  }

  /** One-shot seam entry: fresh conversation. */
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    return this.runOnce(request, undefined, undefined, this.config.addDirs, this.config.printTimeoutMs)
  }

  /** Tool-layer entry: new task plus extra workspace dirs (config.addDirs ∪ tool dirs). */
  startWithDirs(request: SubagentStartRequest, extraDirs: readonly string[]): Promise<SubagentRun> {
    return this.runOnce(request as ResolvedSubagentStartRequest, undefined, undefined, [...this.config.addDirs, ...extraDirs], this.config.printTimeoutMs)
  }

  /**
   * Follow-up entry: resume an existing agy conversation in its recorded
   * cwd. Same-conversation follow-ups are serialized per conversation id, so
   * concurrent prompts cannot corrupt one agy conversation file.
   */
  followup(request: FollowupRequest, conversationId: string, cwd: string): Promise<SubagentRun> {
    return this.followupSerialized(conversationId, () => this.runOnce(request as ResolvedSubagentStartRequest, conversationId, cwd, this.config.addDirs, this.config.printTimeoutMs))
  }

  private followupSerialized(conversationId: string, task: () => Promise<SubagentRun>): Promise<SubagentRun> {
    const prev = this.followupGates.get(conversationId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.followupGates.set(conversationId, gate)
    const settleGate = (): void => {
      release()
      // Drop the gate only when nobody chained onto it after us.
      if (this.followupGates.get(conversationId) === gate) this.followupGates.delete(conversationId)
    }
    return prev.then(task).then(
      async (run) => {
        try {
          // Hold the gate until the run's result settles, not just until the handle exists.
          await run.result
        } finally {
          settleGate()
        }
        return run
      },
      (error: unknown) => {
        settleGate()
        throw error
      },
    )
  }

  private async runOnce(
    request: ResolvedSubagentStartRequest,
    conversationId: string | undefined,
    cwdOverride: string | undefined,
    dirs: readonly string[],
    timeoutMs: number,
  ): Promise<SubagentRun> {
    const { ctx, config } = this
    const plan = await this.spawnPlan(request, conversationId, cwdOverride, dirs, timeoutMs)

    // Local cancellation state: dispose() may settle teardown without the
    // request signal firing, so a killed agy must still land on 'aborted'.
    let cancelled = false
    // Watchdog: agy's own --print-timeout can be ignored when it hangs
    // (network stall, auth wait); a local timer terminates the tree.
    let timedOut = false
    let watchdog: NodeJS.Timeout | undefined
    let current: { handle: SubprocessHandle } | undefined
    // v5 — declared here, not at the write site. The aborted and timed-out
    // branches below reference it, and those branches can run *before* the
    // process produces any stdout; a `const` declared next to the write would
    // throw `Cannot access 'transcriptPath' before initialization` and turn a
    // cancelled or timed-out run into an unhandled rejection.
    let transcriptPath: string | undefined
    const ensureTerminated = (): void => {
      current?.handle.terminate()
    }
    const onAbort = (): void => {
      cancelled = true
      ensureTerminated()
    }
    const armWatchdog = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        ctx.logger.warn(
          `${PREFIX}: agy run exceeded ${timeoutMs + config.watchdogMarginMs}ms watchdog (ceiling ${timeoutMs}ms + margin ${config.watchdogMarginMs}ms), terminating the process tree`,
        )
        ensureTerminated()
      }, timeoutMs + config.watchdogMarginMs)
    }
    const disarmWatchdog = (): void => {
      clearTimeout(watchdog)
    }

    const spawnOnce = (jsonModeArg: boolean) => {
      const argv = [...plan.baseArgv]
      // v5 — `stream-json` when the probe confirmed it, `json` otherwise. The
      // foreground path used to hard-code `json`, which returns only the final
      // response and hides every intermediate step; stream-json is what makes a
      // complete transcript possible. The strict `=== true` keeps an unprobed
      // build on the format upstream has always used.
      if (jsonModeArg) argv.push('--output-format', resolveStreamMode(plan.support))
      if (conversationId !== undefined) argv.push('--conversation', conversationId)
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: plan.childCwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_STDOUT_BYTES, spill: { maxBytes: MAX_STDOUT_SPILL_BYTES } },
          stderr: { maxBytes: MAX_STDERR_BYTES },
        },
        graceMs: config.disposeGraceMs,
        signal: request.signal,
        env: plan.env,
      })
      current = { handle }
      return handle
    }

    const readStdout = (handle: { collected?: import('@deepseek-ai/dsh-subprocess').SubprocessCollectedOutputs }): string =>
      handle.collected?.stdout?.readFrom(0).text ?? ''
    const readStderr = (handle: { collected?: import('@deepseek-ai/dsh-subprocess').SubprocessCollectedOutputs }): string =>
      handle.collected?.stderr?.readFrom(0).text ?? ''

    const snapshot = (): { type: 'text'; text: string }[] => {
      const handle = current?.handle
      if (handle === undefined) return []
      const stdout = readStdout(handle)
      const stderr = readStderr(handle)
      return textBlocks(stderr.length > 0 ? `${stdout}\n${stderr}` : stdout)
    }

    const attempt = async (): Promise<SubagentResult> => {
      try {
        // A cancellation that arrived before the spawn must not spawn at all.
        if (cancelled || request.signal.aborted) return { output: [], stopReason: 'aborted' }
        let handle = spawnOnce(plan.jsonMode)
        armWatchdog()
        let outcome = await handle.done
        let stdout = readStdout(handle)
        let stderr = readStderr(handle)
        // Only when the probe failed and we assumed --output-format support:
        // a build that actually rejects the flag gets one retry in text mode.
        if (
          !cancelled &&
          !request.signal.aborted &&
          plan.jsonMode &&
          !plan.support.probed &&
          outcome.exitCode !== 0 &&
          isUnknownFlagError(stderr)
        ) {
          handle.terminate()
          handle = spawnOnce(false)
          armWatchdog()
          outcome = await handle.done
          stdout = readStdout(handle)
          stderr = readStderr(handle)
        }
        if (cancelled || request.signal.aborted) return { output: textBlocks(stdout), stopReason: 'aborted', transcript: transcriptPath }
        if (timedOut) {
          return {
            output: textBlocks(
              authHintFor(
                `agy did not finish within ${timeoutMs + config.watchdogMarginMs}ms (ceiling ${timeoutMs}ms + watchdog margin); the process tree was terminated.${
                  stderr.trim().length > 0 ? `\n${stderr.trim()}` : ''
                }`,
              ),
            ),
            stopReason: 'error',
            transcript: transcriptPath,
          }
        }

        // v2/v4 — persist the raw stream before parsing it, so a parse failure
        // still leaves the evidence on disk. The header carries the prompt,
        // which the agy event stream itself never includes.
        transcriptPath = config.transcript === false ? undefined : writeTranscript(config, plan.id, transcriptHeader(plan) + stdout)

        const parsed = tryParseJsonOutput(stdout)
        if (parsed !== undefined) {
          const conversation = parsed.conversation_id
          if (parsed.status === 'SUCCESS' && typeof parsed.response === 'string') {
            this.remember(plan.id, conversation, plan.childCwd, plan.label, plan.model)
            return { output: textBlocks(parsed.response), stopReason: 'completed', transcript: transcriptPath }
          }
          const detail = this.maybeAutoLogin(
            typeof parsed.error === 'string' && parsed.error.length > 0
              ? parsed.error
              : stderr.trim() || `agy exited with code ${String(outcome.exitCode)}`,
          )
          this.remember(plan.id, conversation, plan.childCwd, plan.label, plan.model)
          return { output: textBlocks(detail), stopReason: 'error', transcript: transcriptPath }
        }

        // Plain-text path (text mode or non-JSON stdout).
        if (outcome.exitCode === 0) {
          if (stdout.trim().length === 0) {
            return {
              output: textBlocks(
                `agy exited 0 but produced no stdout (stderr: ${stderr.trim() || '(empty)'}) — known Antigravity CLI behavior: \`agy -p\` can drop output under a non-TTY pipe on some builds. Verify with an interactive \`agy\` run once, then retry, or upgrade agy.`,
              ),
              stopReason: 'error',
              transcript: transcriptPath,
            }
          }
          return { output: textBlocks(stdout), stopReason: 'completed', transcript: transcriptPath }
        }
        const detail = this.maybeAutoLogin(stderr.trim().length > 0 ? stderr.trim() : `agy exited with code ${String(outcome.exitCode)}`)
        return { output: textBlocks(detail), stopReason: 'error', transcript: transcriptPath }
      } finally {
        disarmWatchdog()
        plan.releasePromptFile()
      }
    }

    const settled = settleRunResult({
      attempt,
      collectOutput: snapshot,
      cancelled: () => cancelled || request.signal.aborted,
      signal: request.signal,
      onAbort,
      onError: (error: Error, stopReason: string) =>
        ctx.logger.warn(`${PREFIX}: agy run failed (${stopReason}): ${error.message}`),
    })
    // `settleRunResult` synthesises `{ output, stopReason }` on the aborted and
    // error paths instead of returning what `attempt` produced, so any extra
    // field on the attempt's result is dropped exactly when it is most useful:
    // a cancelled or failed run is when you want the transcript path. Re-attach
    // it here (best effort — a run that never wrote one stays undefined).
    const result = settled.then((value) => {
      const terminal = value.stopReason === 'aborted' || value.stopReason === 'error'
      if (transcriptPath === undefined && terminal && config.transcript !== false) {
        // A cancelled or timed-out run can reject `attempt` itself (a killed
        // stream rejects handle.done before attempt reaches its own checks),
        // skipping any write inside attempt — persist what was collected here
        // so these runs leave the same evidence a failed run does. Nothing
        // streamed (cancelled before the spawn) → nothing worth persisting.
        const raw = readStdout(current?.handle ?? {})
        if (raw.length > 0) {
          const status = value.stopReason === 'aborted' ? 'cancelled' : timedOut ? 'timeout' : undefined
          transcriptPath = writeTranscript(config, plan.id, transcriptHeader(plan, status) + raw)
        }
      }
      return transcriptPath === undefined ? value : { ...value, transcript: transcriptPath }
    })
    // Track for the tasks/cancel tools; released when the result settles.
    this.trackActive(
      plan.id,
      {
        label: plan.label,
        cwd: plan.childCwd,
        startedAt: Date.now(),
        background: false,
        cancel: () => {
          cancelled = true
          ensureTerminated()
        },
      },
      result,
    )
    return subprocessRunHandle({
      id: plan.id,
      result,
      signal: request.signal,
      onAbort,
      requestCancel: () => {
        cancelled = true
        ensureTerminated()
      },
      teardown: async () => {
        ensureTerminated()
        let settle: (() => void) | undefined
        const guard = new Promise<void>((resolve) => {
          settle = resolve
        })
        const timer = setTimeout(() => settle?.(), config.disposeGraceMs)
        try {
          await Promise.race([current?.handle.waitForExit() ?? Promise.resolve(true), guard])
        } finally {
          clearTimeout(timer)
        }
      },
    })
  }

  /**
   * Background run for `ctx.jobs` registration: spawns agy immediately with
   * `--output-format stream-json` (falling back to json, then text), streams
   * the incremental `text_delta` chunks through `readOutput`, captures the
   * `conversation_id` from the init event, and persists the task record when
   * done. The final read carries a `[task: ...]` line for follow-ups.
   */
  async startBackground(request: SubagentStartRequest, extraDirs: readonly string[]): Promise<AntigravityBackgroundHandle> {
    const { config } = this
    const plan = await this.spawnPlan(request as ResolvedSubagentStartRequest, undefined, undefined, extraDirs, config.backgroundTimeoutMs)
    return this.runBackgroundPlan(plan, config.backgroundTimeoutMs)
  }

  /**
   * Panel entry point: resume one agy conversation with no Agent and no job
   * around it. A sidebar click has no model-facing tool call to hang a request
   * off, so this synthesises the two fields `spawnPlan` reads (`session.id` and
   * `session.header.cwd`). The caller never supplies a cwd — the route takes it
   * from the registry — so this cannot be used to run agy in an arbitrary
   * directory.
   */
  async startPanelRun(input: PanelRunInput): Promise<AntigravityBackgroundHandle> {
    const { config } = this
    const abort = new AbortController()
    const parent = {
      session: { id: input.sessionId as SessionId, header: { cwd: input.baseCwd } },
    } as unknown as Agent
    const request = {
      label: input.label,
      prompt: [{ type: 'text' as const, text: input.prompt }],
      parent,
      signal: abort.signal,
    } as ResolvedSubagentStartRequest
    // The signal is only borrowed by spawnPlan's executable probe.
    const plan = await this.spawnPlan(request, input.conversationId, input.cwd, [], config.backgroundTimeoutMs)
      .finally(() => abort.abort())
    // spawnPlan validates --conversation support but only the foreground path
    // appends the flag itself; the background argv is plan.baseArgv verbatim.
    plan.baseArgv.push('--conversation', input.conversationId)
    return this.runBackgroundPlan(plan, config.backgroundTimeoutMs)
  }

  private runBackgroundPlan(plan: SpawnPlan, ceiling: number): AntigravityBackgroundHandle {
    const { ctx, config } = this
    const id = plan.id
    const label = plan.label

    let timedOut = false
    let visible = ''
    let readOffset = 0
    let sawDelta = false
    let conversationId: string | undefined
    let finalStatus: string | undefined
    let finalResponse: string | undefined
    let finalError: string | undefined
    let taskLine = ''
    let taskLineEmitted = false
    let handle: SubprocessHandle | undefined
    let watchdog: NodeJS.Timeout | undefined
    let cancelledByRequest = false
    /** Last tool agy announced — the panel's "running tool" line. */
    let lastTool: string | null = null
    /**
     * The structured step timeline of this run, collected beside the visible
     * text. The visible text stays byte-identical to what the plugin has
     * always shown; these steps are a second view of the same events.
     */
    let steps: StepEvent[] = []
    const controller = new AbortController()

    /** Append to the live-output window, dropping the oldest bytes past MAX_VISIBLE_BYTES. */
    const appendVisible = (chunk: string): void => {
      if (chunk.length === 0) return
      visible += chunk
      if (visible.length > MAX_VISIBLE_BYTES) {
        const drop = visible.length - MAX_VISIBLE_BYTES
        visible = visible.slice(drop)
        readOffset = Math.max(0, readOffset - drop)
      }
    }

    const terminate = (): void => {
      handle?.terminate()
    }
    const armWatchdog = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        ctx.logger.warn(
          `${PREFIX}: background agy run exceeded ${ceiling + config.watchdogMarginMs}ms watchdog (ceiling ${ceiling}ms + margin ${config.watchdogMarginMs}ms), terminating the process tree`,
        )
        terminate()
      }, ceiling + config.watchdogMarginMs)
    }
    const disarmWatchdog = (): void => {
      clearTimeout(watchdog)
    }

    /** Consume one NDJSON line of the stream-json protocol (or a bare json reply in fallback mode). */
    const consumeLine = (line: string): void => {
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        return
      }
      if (obj === null || typeof obj !== 'object') return
      const event = (obj as { event?: unknown }).event
      if (event === 'init') {
        const cid = (obj as { conversation_id?: unknown }).conversation_id
        if (typeof cid === 'string' && cid.length > 0) conversationId = cid
        return
      }
      if (event === 'step_update') {
        const payload = (obj as { step_update?: unknown }).step_update
        if (payload !== null && typeof payload === 'object') {
          // Side channel: collect the structured timeline without touching the
          // visible output below, which must stay exactly as it always was.
          const parsedStep = parseStepUpdate(payload)
          if (parsedStep !== undefined) steps = mergeStepInto(steps, parsedStep)
          const p = payload as { text_delta?: unknown; state?: unknown; step_type?: unknown; tool_name?: unknown }
          if (typeof p.tool_name === 'string' && p.tool_name.length > 0) lastTool = p.tool_name
          const delta = p.text_delta
          if (typeof delta === 'string' && delta.length > 0) {
            sawDelta = true
            appendVisible(delta)
          }
          // Compact progress marker for every non-text step (tool calls,
          // checkpoints...), so a job_output poll shows what agy is doing.
          const stepType = typeof p.step_type === 'string' ? p.step_type : ''
          if (p.state === 'DONE' && stepType.length > 0 && stepType !== 'agent_response' && stepType !== 'user_input' && stepType !== 'unknown') {
            appendVisible(`\n[agy: ${stepType} step done]\n`)
          }
        }
        return
      }
      if (event === 'result') {
        const payload = (obj as { result?: unknown }).result
        if (payload !== null && typeof payload === 'object') {
          const p = payload as { status?: unknown; response?: unknown; error?: unknown }
          if (typeof p.status === 'string') finalStatus = p.status
          if (typeof p.response === 'string') finalResponse = p.response
          if (typeof p.error === 'string') finalError = p.error
        }
        return
      }
      // Bare `--output-format json` reply (fallback when stream-json is
      // unavailable): the whole object is the final result.
      const p = obj as { conversation_id?: unknown; status?: unknown; response?: unknown; error?: unknown }
      if (typeof p.conversation_id === 'string' && p.conversation_id.length > 0) conversationId = p.conversation_id
      if (typeof p.status === 'string') finalStatus = p.status
      if (typeof p.response === 'string') finalResponse = p.response
      if (typeof p.error === 'string') finalError = p.error
    }

    const spawnOnce = (): void => {
      const argv = [...plan.baseArgv]
      if (plan.streamMode) argv.push('--output-format', 'stream-json')
      else if (plan.jsonMode) argv.push('--output-format', 'json')
      handle = ctx.subprocess.spawn({
        argv,
        cwd: plan.childCwd,
        stdio: {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: { maxBytes: MAX_STDERR_BYTES },
        },
        graceMs: config.disposeGraceMs,
        signal: controller.signal,
        env: plan.env,
      })
      armWatchdog()
      let buffer = ''
      handle.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line.length > 0) consumeLine(line)
        }
      })
      handle.stdout?.on('end', () => {
        const tail = buffer.trim()
        if (tail.length > 0) consumeLine(tail)
      })
    }

    const done = (async (): Promise<{ status: 'killed' | 'completed' | 'failed'; detail: string }> => {
      let status: 'killed' | 'completed' | 'failed'
      let detail: string
      try {
        spawnOnce()
        const outcome = await handle!.done
        const stderr = handle!.collected?.stderr?.readFrom(0).text ?? ''
        if (timedOut) {
          status = 'killed'
          detail = `agy did not finish within ${ceiling + config.watchdogMarginMs}ms (ceiling ${ceiling}ms + watchdog margin); the process tree was terminated`
        } else if (outcome.signal !== null || cancelledByRequest) {
          status = 'killed'
          // Windows reports a terminated child as exit code 1 without a
          // signal marker, so an explicit cancellation is tracked directly.
          detail = cancelledByRequest ? 'cancelled by request' : `signal: ${outcome.signal}`
        } else if (finalStatus === 'SUCCESS') {
          status = 'completed'
          detail = 'completed'
        } else {
          status = 'completed'
          detail = this.maybeAutoLogin(
            (finalError !== undefined && finalError.length > 0 ? finalError : stderr.trim()) || `agy exited with code ${String(outcome.exitCode)}`,
          )
        }
      } catch (error) {
        // A spawn failure (ENOENT/cwd/...) must settle the job as failed —
        // `done` is the jobs contract and must never reject.
        status = 'failed'
        detail = `agy background run failed: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        disarmWatchdog()
        plan.releasePromptFile()
      }
      this.remember(id, conversationId, plan.childCwd, label, plan.model)
      if (conversationId !== undefined && this.runRecords.has(id)) {
        const record = this.runRecords.get(id) as TaskRecord
        await updateTaskRegistry(config, (records) => {
          records[id] = record
        }, ctx.logger)
        taskLine = `\n[task: ${id}]`
      } else {
        taskLine = '\n[task: (none — this agy build did not provide a conversation_id)]'
      }
      // A stream-json build always streams the response text; only patch in
      // the final response when the fallback (json/text) mode delivered none.
      if (finalResponse !== undefined && finalResponse.length > 0 && !sawDelta) {
        appendVisible(finalResponse)
      }
      return { status, detail }
    })()

    const readOutput = (): string => {
      const delta = visible.slice(readOffset)
      readOffset = visible.length
      let text = delta
      if (taskLine.length > 0 && !taskLineEmitted) {
        taskLineEmitted = true
        text += (text.length > 0 && !text.endsWith('\n') ? '\n' : '') + taskLine
      }
      return text
    }

    const cancel = (): void => {
      cancelledByRequest = true
      controller.abort()
      terminate()
    }

    // Track for the tasks/cancel tools; released when the job settles.
    this.trackActive(id, { label, cwd: plan.childCwd, startedAt: Date.now(), background: true, cancel }, done)
    return { cancel, done, readOutput, tool: () => lastTool, steps: () => snapshotSteps(steps) }
  }
}

// ── Model-facing tools ──────────────────────────────────────────────────────

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: unknown[]): string {
  return values
    .filter(
      (value) =>
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (value as { type?: unknown }).type === 'text' && typeof (value as { text?: unknown }).text === 'string',
    )
    .map((value) => (value as { text: string }).text)
    .join('')
}

/** Render a millisecond duration compactly for model-facing text ("1 h", "5 min", "60 s"). */
function formatMs(ms: number): string {
  if (Number.isInteger(ms) && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
  if (Number.isInteger(ms) && ms % 60_000 === 0) return `${ms / 60_000} min`
  if (Number.isInteger(ms) && ms % 1000 === 0) return `${ms / 1000} s`
  return `${ms} ms`
}

/** Render an epoch-ms stamp as a compact UTC ISO string for model-facing lists. */
function formatStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'antigravity run was cancelled'
    case 'error':
      return 'antigravity run failed'
    case 'max-tokens':
      return 'antigravity run hit its token limit before finishing'
    case 'refusal':
      return 'antigravity declined the task'
    default:
      return `antigravity run ended abnormally (${String(result.stopReason)})`
  }
}

/** Append the child's preserved partial answer to a stop-reason error. */
function withPartialText(error: string, output: readonly { type: string; text?: string }[]): string {
  const text = output.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
async function settleForegroundRun(
  run: SubagentRun,
): Promise<{ kind: 'foreground'; runId: string; output: JsonValue[] }> {
  const [execution] = await Promise.allSettled([
    run.result.then((result: SubagentResult) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground' as const,
        runId: run.id,
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason], `antigravity run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`)
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

export function apply(ctx: Context, config: Config): void {
  /** Validate then return the configured cwd (the shim itself returns void). */
  const validatedCwd = (cwd: string): string => {
    validateConfiguredCwd(cwd)
    return cwd
  }
  const assertFinite = assertPositiveFinite as (prefix: string, key: string, value: number) => void
  assertFinite(PREFIX, 'disposeGraceMs', config.disposeGraceMs)
  assertFinite(PREFIX, 'watchdogMarginMs', config.watchdogMarginMs)
  assertFinite(PREFIX, 'backgroundTimeoutMs', config.backgroundTimeoutMs)
  const configuredCwd = config.cwd.length > 0 ? validatedCwd(config.cwd) : undefined

  // Provider registration (effect-scoped: stop/update/unload removes it).
  const provider = new AntigravitySubagentProvider(ctx, config, configuredCwd)
  ctx.effect(
    () => ctx.subagents.registerProvider(provider),
    `${PREFIX}: provider ${config.providerName}`,
  )

  // `model: auto` needs `agy models`, which is a ~11 s network call. Warm it in
  // the background so boot never waits; until it lands (or if it fails) `auto`
  // simply omits `--model` and agy's own default applies.
  void provider.warmModelCatalog().catch((error: unknown) => {
    ctx.logger.warn(
      `${PREFIX}: model catalogue warm-up failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })

  // Terminate every in-flight agy process when the plugin stops or updates —
  // they would otherwise leak as orphans no other provider can manage.
  ctx.effect(
    () => () => {
      try {
        const terminated = provider.terminateAllActive()
        if (terminated > 0) ctx.logger.warn(`${PREFIX}: terminated ${terminated} active agy run(s) on plugin stop`)
      } catch (error) {
        console.warn(`${PREFIX}: error terminating active runs on plugin stop: ${String(error)}`)
      }
    },
    `${PREFIX}: terminate active runs on dispose`,
  )

  // ── Sidebar panel: quotas + conversation list + resume ────────────────────
  // Routes attach through ctx.inject because `webServer` is an optional service
  // that mounts after the plugin; a direct ctx.get here would be undefined.
  const usageReader = new UsageReader({
    badgeFamily: familyOfModel(config.model),
    cachePath: join(pluginBaseDir(), 'agy-usage-cache.json'),
    runner: async () => {
      const probe = await provider.probeEnvironment()
      return await spawnUsage(probe.exe, { env: probe.env, cwd: probe.cwd })
    },
  })
  const antigravityHome = join(homedir(), '.gemini', 'antigravity-cli')
  registerAgyPanel(ctx, {
    sessionId: 'panel:agy',
    baseCwd: configuredCwd ?? process.cwd(),
    conversationsDir: join(antigravityHome, 'conversations'),
    annotationsDir: join(antigravityHome, 'annotations'),
    summariesDbPath: join(antigravityHome, 'conversation_summaries.db'),
    prefsPath: join(pluginBaseDir(), 'agy-panel.json'),
    loadRecords: () => loadTaskRegistry(config, ctx.logger),
    listActive: () => provider.listActive(),
    peekUsage: () => usageReader.peek(),
    readUsage: (force) => usageReader.read(force),
    startRun: (input) => provider.startPanelRun(input),
  })

  // New-task tool (effect-scoped like the provider).
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.toolName,
          description:
            'Create a delegated sub-agent task: delegate to Google Antigravity CLI (agy) — a separate Gemini-powered coding agent on this machine, authenticated with your Antigravity account (no API key). \n\nUse this whenever the user asks to dispatch / delegate / launch / spin up / hand off work to another agent, or wants a second agent to do a self-contained job ("派个 agent" / "委托给别的模型" / "让 agy 干"). This plugin is `@dsh-external/dsh-subagent-antigravity` (mount id `dsh-subagent-antigravity`); it registers the tools `antigravity`, `antigravity_followup`, `antigravity_tasks`, `antigravity_cancel`, `antigravity_login`. It is a TOOL, not a skill: do not look for it in the skills list. The user often calls this \"subagent\", \"agy\", \"antigravity\", \"AGY CLI\", \"Google Antigravity\", \"dsh-subagent-agy\", or \"dsh-subagent-antigravity\". \n\nHow it differs from the built-in `subagent` / `subagent_fork` tools: those run a local child agent in this same DSH process and inherit this conversation; this one runs an independent external agent over the agy CLI, does not see this conversation (hence the standalone prompt), and can be resumed later with `antigravity_followup` via the returned `task` key. It works in the parent session\'s workspace and returns its final answer; give it a complete, standalone prompt because it does not see this conversation. The result carries a `task` key: pass it to antigravity_followup to continue this conversation later. If the task targets files OUTSIDE the session workspace (e.g. another project), pass their absolute directory paths in `dirs` — without it, headless agy cannot reach them and will hang until its timeout. Every prompt gets appended environment notes telling agy NOT to use its headless browser tools (they can hang; config `avoidBrowser`, default true) and NOT to read files larger than 1 MB with its read tool (it fails above 4 MB; config `avoidLargeReads`, default true — agy should use grep/sed/run_command instead). When a task genuinely needs a browser preview, say so and have the user set avoidBrowser: false. If a run fails with "authentication required", a login window opens automatically on the machine (config autoLoginWindow, default true) — tell the user to complete the sign-in, or call ' + config.loginToolName + ' to open it manually. Foreground runs are cut off at a ' + formatMs(config.printTimeoutMs) + ' ceiling (agy --print-timeout; configurable via printTimeoutMs) and force-killed ' + formatMs(config.watchdogMarginMs) + ' later if hung. For long tasks use `background: true`: you are woken in-session when the job settles, so start it, then keep working on independent steps instead of polling (see the background parameter). Poll job_output only when you are genuinely blocked on the result, and report agy\'s live progress when you do. Do not duplicate the running job\'s work or end the turn silently. List running/recent tasks with ' + config.tasksToolName + ', and stop a running one with ' + config.cancelToolName + '.',
          parameters: {
            description: {
              type: 'string',
              required: true,
              description: 'A short (3-5 word) description of the delegated task, for display.',
            },
            prompt: {
              type: 'string',
              required: true,
              description:
                'The complete, self-contained task for Antigravity. It does not share this conversation\'s context, so include everything it needs (files, paths, acceptance criteria, and what to return). Keep it under 30000 characters.',
            },
            dirs: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional absolute paths of directories to add to the agy workspace (--add-dir), for targets OUTSIDE the session workspace. Headless agy cannot answer the interactive "add directory to workspace?" prompt, so without this it hangs until its print timeout. Pass [] when not needed.',
            },
            background: {
              type: 'boolean',
              description:
                'Optional. Set true to run in the background: the call returns a job id immediately; you are notified when it settles; read live output with job_output and stop with job_kill. The final output includes a [task: ...] line for antigravity_followup. Background runs use the generous ' + formatMs(config.backgroundTimeoutMs) + ' ceiling (backgroundTimeoutMs) instead of the ' + formatMs(config.printTimeoutMs) + ' foreground ceiling. IMPORTANT — do NOT busy-poll. This job wakes you in-session (a completion notice is injected, or opens a new turn on an idle agent) as soon as it settles, so after starting it go do independent work and read the result when you are notified. Use job_output with wait: true only when you are genuinely blocked; a single wait on a short job (under ~2 minutes) is fine. Each poll costs tokens, so keep reads and progress updates brief, and do not duplicate the running job\'s work.',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                runId: { type: 'string' },
                task: { type: 'string' },
                jobId: { type: 'string' },
                // Declared, not decorative: the schema is `additionalProperties:
                // false`, so an undeclared field is silently stripped.
                conversationId: { type: 'string' },
                label: { type: 'string' },
                output: { type: 'array', items: { type: 'json' } },
              },
            },
            render: (_args: unknown, value: { kind?: string; jobId?: string; output?: unknown[] }) => {
              if (value.kind === 'background') {
                return [{ type: 'text', text: `started background job ${value.jobId ?? '(unknown)'} — you will be notified when it settles; read output with job_output, stop with job_kill` }]
              }
              return [{ type: 'text', text: outputValueText(value.output ?? []) }]
            },
          },
          isConcurrencySafe: () => true,
          async execute(args: { description: string; prompt: string; dirs?: string[]; background?: boolean }, exec: ToolRunContext) {
            const parent = exec.agent
            if (!parent) throw new Error(`${PREFIX}: antigravity tool requires a calling agent (exec.agent was undefined)`)
            const provider = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(provider instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            if (args.background === true) {
              const jobs = ctx.get('jobs')
              if (jobs === undefined) {
                throw new Error(`${PREFIX}: background jobs unavailable — load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`)
              }
              const bg = await provider.startBackground(
                {
                  label: args.description,
                  prompt: [{ type: 'text' as const, text: args.prompt }],
                  parent,
                  signal: exec.signal,
                },
                args.dirs ?? [],
              )
              let jobId: string
              try {
                jobId = jobs.start({
                  kind: 'antigravity',
                  label: args.description,
                  // `owner` is a SessionId, not the Agent object: dsh-jobs-local
                  // resolves it with `agents.get(session)` and throws
                  // `session "[object Object]" has no live agent` when handed an
                  // Agent. That throw also made every `background: true` call
                  // fail, which is why callers stopped using the tool.
                  owner: parent.session.id,
                  run: () => bg,
                })
              } catch (error) {
                bg.cancel()
                throw error
              }
              return { kind: 'background', jobId }
            }
            const settled = await settleForegroundRun(
              await provider.startWithDirs(
                {
                  label: args.description,
                  prompt: [{ type: 'text' as const, text: args.prompt }],
                  parent,
                  signal: exec.signal,
                },
                args.dirs ?? [],
              ),
            )
            const record = provider.recordOf(settled.runId)
            if (record !== undefined) {
              await updateTaskRegistry(config, (records) => {
                records[settled.runId] = record
              }, ctx.logger)
            }
            // v5 — surface the agy conversation id (and label) alongside the
            // task key. The DSH output schema is strict: an undeclared field is
            // dropped and the caller then cannot correlate a task with the agy
            // conversation it maps to, so the field must be both returned and
            // declared in `output.schema`.
            return {
              ...settled,
              task: settled.runId,
              ...(record?.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
              ...(record !== undefined ? { label: record.label } : {}),
            }
          },
        }),
      ),
    `${PREFIX}: tool ${config.toolName}`,
  )

  // Follow-up tool: resume an agy conversation by its recorded task key.
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.followupToolName,
          description:
            'Continue a previously created delegated sub-agent task (Antigravity / agy) in the same conversation: the child agent resumes with its full prior context. Use this when the user wants to follow up with, ask more of, or redirect an agent that was already dispatched — it is the only way to reach that agent again (the built-in `subagent` tools cannot resume an agy task). Use the `task` key returned by the antigravity tool (foreground result or the [task: ...] line of a background job), or list recorded keys with ' + config.tasksToolName + ' (they survive DSH restarts). Each follow-up is one new prompt in that conversation; the response is the agent\'s final text for this turn. This call blocks until agy answers — it is a normal tool call, not a background job, so the call itself is the wait. Same ' + formatMs(config.printTimeoutMs) + ' run ceiling as the antigravity tool; keep prompts under 30000 characters.',
          parameters: {
            description: {
              type: 'string',
              required: true,
              description: 'A short (3-5 word) description of this follow-up, for display.',
            },
            task: {
              type: 'string',
              required: true,
              description: 'The `task` key returned by a previous antigravity call.',
            },
            prompt: {
              type: 'string',
              required: true,
              description: 'The follow-up instruction. The agent already remembers the whole prior task and its work; state only what is new.',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                runId: { type: 'string', required: true },
                task: { type: 'string', required: true },
                // Declared for the same reason as the antigravity tool: the
                // schema strips undeclared fields.
                conversationId: { type: 'string' },
                output: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
            render: (_args: unknown, value: { output: unknown[] }) => [{ type: 'text', text: outputValueText(value.output) }],
          },
          isConcurrencySafe: () => true,
          async execute(args: { description: string; task: string; prompt: string }, exec: ToolRunContext) {
            const parent = exec.agent
            if (!parent) throw new Error(`${PREFIX}: antigravity_followup tool requires a calling agent (exec.agent was undefined)`)
            const provider = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(provider instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            const records = loadTaskRegistry(config)
            const record = records[args.task]
            if (record === undefined) {
              throw new Error(
                `${PREFIX}: no such task "${args.task}" — run the antigravity tool first (task keys survive DSH restarts via ~/.dsh/agy-conversations.json)`,
              )
            }
            const settled = await settleForegroundRun(
              await provider.followup(
                {
                  label: args.description,
                  prompt: [{ type: 'text' as const, text: args.prompt }],
                  parent,
                  signal: exec.signal,
                },
                record.conversationId,
                record.cwd,
              ),
            )
            const refreshed = provider.recordOf(settled.runId)
            await updateTaskRegistry(config, (records) => {
              records[args.task] = { ...record, createdAt: Date.now(), ...(refreshed !== undefined ? { conversationId: refreshed.conversationId } : {}) }
            }, ctx.logger)
            return {
              ...settled,
              task: args.task,
              ...(refreshed?.conversationId !== undefined
                ? { conversationId: refreshed.conversationId }
                : record.conversationId !== undefined
                  ? { conversationId: record.conversationId }
                  : {}),
            }
          },
        }),
      ),
    `${PREFIX}: tool ${config.followupToolName}`,
  )

  // Login-window tool: pop agy's interactive login on demand (also happens
  // automatically on auth failures when `autoLoginWindow` is on).
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.loginToolName,
          description:
            'Open the interactive Antigravity (agy) login window so the user can authenticate on the spot (Google sign-in; Windows opens a new console running agy). Call this when an antigravity run failed with "authentication required" and no window opened automatically.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                message: { type: 'string', required: true },
              },
            },
            render: (_args: unknown, value: { message: string }) => [{ type: 'text', text: value.message }],
          },
          isConcurrencySafe: () => true,
          async execute() {
            const provider = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(provider instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            return { message: await provider.launchLogin() }
          },
        }),
      ),
    `${PREFIX}: tool ${config.loginToolName}`,
  )

  // Tasks tool: list in-flight runs plus durable registry history. This is
  // the only restart-safe way to recover a `task` key for the follow-up tool.
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.tasksToolName,
          description:
            'List Antigravity (agy) tasks: currently running tasks (foreground and background) plus recently finished tasks from the durable registry (~/.dsh/agy-conversations.json, or registryPath). Task keys survive DSH restarts — use a `task` key with ' +
            config.followupToolName +
            ' to resume that conversation, or pass one to ' +
            config.cancelToolName +
            ' to stop a running task.',
          parameters: {
            limit: {
              type: 'number',
              description: 'How many recently finished tasks to include, newest first (default 20, max 50).',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                running: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      task: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                      cwd: { type: 'string', required: true },
                      background: { type: 'boolean', required: true },
                      startedAt: { type: 'number', required: true },
                    },
                  },
                },
                recent: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      task: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                      cwd: { type: 'string', required: true },
                      createdAt: { type: 'number', required: true },
                    },
                  },
                },
              },
            },
            render: (_args: unknown, value: { running?: unknown[]; recent?: unknown[] }) => {
              const lines: string[] = []
              const running = value.running ?? []
              const recent = value.recent ?? []
              if (running.length === 0) {
                lines.push('No running tasks.')
              } else {
                lines.push(`Running (${running.length}):`)
                for (const entry of running) {
                  const item = entry as { task?: unknown; label?: unknown; background?: unknown; startedAt?: unknown }
                  lines.push(
                    `  task: ${String(item.task ?? '?')}  label: ${String(item.label ?? '')}  mode: ${item.background === true ? 'background' : 'foreground'}  started: ${formatStamp(typeof item.startedAt === 'number' ? item.startedAt : 0)}`,
                  )
                }
              }
              if (recent.length === 0) {
                lines.push('No recent finished tasks in the registry.')
              } else {
                lines.push(`Recent finished (${recent.length}):`)
                for (const entry of recent) {
                  const item = entry as { task?: unknown; label?: unknown; createdAt?: unknown }
                  lines.push(
                    `  task: ${String(item.task ?? '?')}  label: ${String(item.label ?? '')}  created: ${formatStamp(typeof item.createdAt === 'number' ? item.createdAt : 0)}`,
                  )
                }
              }
              return [{ type: 'text', text: lines.join('\n') }]
            },
          },
          isConcurrencySafe: () => true,
          async execute(args: { limit?: number }) {
            const current = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(current instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            const running = current.listActive()
            const records = loadTaskRegistry(config, ctx.logger)
            const limit = Math.max(0, Math.min(50, Math.floor(args.limit ?? 20)))
            const recent = Object.entries(records)
              .sort((a, b) => b[1].createdAt - a[1].createdAt)
              .slice(0, limit)
              .map(([task, record]) => ({ task, label: record.label, cwd: record.cwd, createdAt: record.createdAt }))
            return { running, recent }
          },
        }),
      ),
    `${PREFIX}: tool ${config.tasksToolName}`,
  )

  // Cancel tool: stop a running task by its task key; the agy process tree
  // is terminated and the run settles as cancelled (its conversation record,
  // if any, stays in the registry for later follow-up).
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: config.cancelToolName,
          description:
            'Stop a running Antigravity (agy) task by its task key. Get running task keys from ' +
            config.tasksToolName +
            ' (or the `task` field of an in-flight antigravity call). The agy process tree is terminated and the run settles as cancelled; its conversation record (if any) is kept for follow-up.',
          parameters: {
            task: {
              type: 'string',
              required: true,
              description: 'The task key of a RUNNING task (see ' + config.tasksToolName + ').',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cancelled: { type: 'boolean', required: true },
                task: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
            render: (_args: unknown, value: { message: string }) => [{ type: 'text', text: value.message }],
          },
          isConcurrencySafe: () => true,
          async execute(args: { task: string }) {
            const current = ctx.subagents.getProvider(config.providerName) as AntigravitySubagentProvider | undefined
            if (!(current instanceof AntigravitySubagentProvider)) {
              throw new Error(`${PREFIX}: provider "${config.providerName}" is not the antigravity provider`)
            }
            const cancelled = current.cancelActive(args.task)
            if (!cancelled) {
              throw new Error(
                `${PREFIX}: no running task "${args.task}" — running tasks are listed by ${config.tasksToolName}; finished tasks cannot be cancelled (their conversations resume via ${config.followupToolName})`,
              )
            }
            return {
              cancelled: true,
              task: args.task,
              message: `Cancellation requested for task ${args.task} — its run settles as cancelled.`,
            }
          },
        }),
      ),
    `${PREFIX}: tool ${config.cancelToolName}`,
  )

  ctx.logger.info(
    `${PREFIX}: provider "${config.providerName}" + tools "${config.toolName}" / "${config.followupToolName}" / "${config.tasksToolName}" / "${config.cancelToolName}" ready (command: ${config.command}${config.model ? `, model: ${config.model}` : ''})`,
  )
}
