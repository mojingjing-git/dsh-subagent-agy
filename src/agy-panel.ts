/**
 * The sidebar panel's host half: six JSON routes over the plugin's own data.
 *
 * Everything here is deliberately POST + JSON. `webServer.register` only takes
 * `exact` or `prefix` routes (no `:param` segments). POST + JSON alone does NOT
 * keep cross-site requests out — the host web server matches routes by path and
 * applies no auth or Origin check of its own — so every handler also rejects a
 * non-loopback Host (DNS rebinding), a cross-site Origin, and any request that
 * is not `application/json`. See `crossSiteBlock`.
 *
 * Streaming: `AntigravityBackgroundHandle.readOutput()` is a destructive cursor
 * (one consumer only), so the store owns exactly one reader — a 250 ms timer —
 * and the client polls `{runId, since}` against the accumulated buffer. That
 * keeps multiple panes, reconnects and re-renders from stealing each other's
 * text.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AntigravityBackgroundHandle, PanelRunInput, TaskRecord } from './index.js'
import { listConversations, type ConversationItem } from './agy-conversations.js'
import { readConversationHistory } from './agy-history.js'
import { readConversationSummaries } from './agy-summaries.js'
import type { UsageReport } from './agy-usage.js'
import type { StepEvent } from './agy-steps.js'

/** The slice of `@deepseek-ai/dsh-host-webserver` this module needs. */
interface WebServerLike {
  register(route: unknown): unknown
}

/** `ctx.inject` with the service set this module waits for. */
interface InjectingContext {
  inject(names: string[], callback: (ctx: { webServer: WebServerLike }) => void): void
  logger: { warn(message: string): void }
}

/** One active run as reported by the provider's task layer. */
export interface ActiveRunInfo {
  task: string
  label: string
  cwd: string
  background: boolean
  startedAt: number
}

export interface AgyPanelDeps {
  /** Synthetic session id used for panel-started runs. */
  sessionId: string
  /** cwd the synthetic session pretends to have; the run's real cwd is per-record. */
  baseCwd: string
  conversationsDir: string
  annotationsDir: string
  /**
   * `~/.gemini/antigravity-cli/brain` — agy's own transcript of every
   * conversation. It carries the token counters and the timestamps that the
   * conversation database does not have.
   */
  brainDir: string
  /** `~/.gemini/antigravity-cli/conversation_summaries.db` */
  summariesDbPath: string
  /** Where the panel keeps hidden conversation ids. */
  prefsPath: string
  loadRecords(): Record<string, TaskRecord>
  listActive(): ActiveRunInfo[]
  peekUsage(): UsageReport | null
  readUsage(force?: boolean): Promise<UsageReport>
  startRun(input: PanelRunInput): Promise<AntigravityBackgroundHandle>
}

/** One panel-initiated run. `text` grows; `cursor` is an index into it. */
interface PanelRun {
  id: string
  conversationId: string
  label: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  text: string
  /**
   * Set by `drain()` when `text` was truncated to the cap. The client's cursor
   * then points at dropped text — without this flag every later poll would
   * compute an empty slice and the run would look frozen forever.
   */
  resetPending: boolean
  tool: string | null
  startedAt: number
  endedAt: number | null
  error?: string
  handle: AntigravityBackgroundHandle
  /**
   * The structured step timeline of this run — what agy did, in order.
   *
   * Steps are updated data, not an append-only text stream: the same step
   * arrives again when it advances from `ACTIVE` to `DONE`/`ERROR`. They are
   * therefore never expressed as a cursor delta; the client replaces the
   * whole list whenever {@link PanelRun.stepsVersion} changes.
   */
  steps: StepEvent[]
  /** Changes whenever `steps` did; the client uses it to decide to replace. */
  stepsVersion: string
  timer?: NodeJS.Timeout
}

const MAX_RUN_TEXT = 400 * 1024
const MAX_RUNS = 20
const POLL_MS = 250

/** A cheap fingerprint of a step list, used to detect that it changed. */
function stepsVersion(steps: readonly StepEvent[]): string {
  let chars = 0
  for (const step of steps) chars += step.text.length
  const last = steps.length > 0 ? steps[steps.length - 1] : undefined
  return `${steps.length}:${chars}:${last?.index ?? -1}:${last?.state ?? ''}`
}

/** In-memory run table with exactly one consumer of the handle's output cursor. */
class RunStore {
  private readonly runs = new Map<string, PanelRun>()
  private seq = 0

  start(conversationId: string, label: string, handle: AntigravityBackgroundHandle): string {
    this.seq += 1
    const id = `panel-${Date.now().toString(36)}-${this.seq.toString(36)}`
    const run: PanelRun = {
      id,
      conversationId,
      label,
      status: 'running',
      text: '',
      resetPending: false,
      tool: null,
      startedAt: Date.now(),
      endedAt: null,
      handle,
      steps: [],
      stepsVersion: '0',
    }
    this.runs.set(id, run)
    run.timer = setInterval(() => this.drain(run), POLL_MS)
    run.timer.unref?.()
    void handle.done.then(
      (outcome) => {
        this.drain(run)
        run.status = outcome.status === 'completed' ? 'done' : outcome.status === 'killed' ? 'cancelled' : 'failed'
        run.endedAt = Date.now()
        if (outcome.status !== 'completed') run.error = outcome.detail
        this.stopTimer(run)
        this.prune()
      },
      (error: unknown) => {
        this.drain(run)
        run.status = 'failed'
        run.endedAt = Date.now()
        run.error = error instanceof Error ? error.message : String(error)
        this.stopTimer(run)
        this.prune()
      },
    )
    this.prune()
    return id
  }

  /** True while a run for this conversation is still going. */
  isRunning(conversationId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId && run.status === 'running') return true
    }
    return false
  }

  read(id: string, since: number): { found: true; run: PanelRun; cursor: number; reset: boolean } | { found: false } {
    const run = this.runs.get(id)
    if (run === undefined) return { found: false }
    const reset = !Number.isFinite(since) || since < 0 || since > run.text.length || run.resetPending
    if (reset) run.resetPending = false
    // On reset the slice origin is 0: the client asked for (or needs) the whole
    // buffer. The payload still reports run.text.length as the resume point, so
    // the client re-bases on the full text and continues incrementally.
    const cursor = reset ? 0 : since
    return { found: true, run, cursor, reset }
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id)
    if (run === undefined || run.status !== 'running') return false
    run.status = 'cancelled'
    run.endedAt = Date.now()
    this.stopTimer(run)
    run.handle.cancel()
    return true
  }

  private drain(run: PanelRun): void {
    try {
      const delta = run.handle.readOutput()
      if (delta.length > 0) {
        run.text += delta
        if (run.text.length > MAX_RUN_TEXT) {
          run.text = run.text.slice(run.text.length - MAX_RUN_TEXT)
          run.resetPending = true
        }
      }
      run.tool = run.handle.tool?.() ?? run.tool
      const steps = run.handle.steps?.()
      if (steps !== undefined) {
        const version = stepsVersion(steps)
        if (version !== run.stepsVersion) {
          run.steps = steps
          run.stepsVersion = version
        }
      }
    } catch {
      // A dead handle must not stop the timer from settling the run.
    }
  }

  private stopTimer(run: PanelRun): void {
    if (run.timer !== undefined) {
      clearInterval(run.timer)
      run.timer = undefined
    }
  }

  private prune(): void {
    if (this.runs.size <= MAX_RUNS) return
    const finished = [...this.runs.values()]
      .filter((run) => run.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const run of finished) {
      if (this.runs.size <= MAX_RUNS) break
      this.stopTimer(run)
      this.runs.delete(run.id)
    }
  }
}

interface RouteRequest {
  body: unknown
}

type Handler = (request: RouteRequest) => Promise<[number, unknown]> | [number, unknown]

/** Hostnames only this machine can resolve to. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * The host web server routes by path with no auth, no Origin check and no CSRF
 * token of its own — and every handler behind this panel can start an agy
 * process with `--dangerously-skip-permissions`. So the panel guards itself: a
 * Host that is not this machine's loopback (DNS rebinding) and a cross-site
 * Origin (browser-borne CSRF) are refused outright. A request with no Origin at
 * all (curl, same-server tooling) passes — a browser always attaches Origin to
 * a cross-site POST, so absence means no browser is involved. The port is
 * whatever the request carries; nothing is hardcoded.
 */
function crossSiteBlock(req: IncomingMessage): string | null {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return 'missing Host header'
  const hostname = host.startsWith('[')
    ? host.slice(1, Math.max(host.indexOf(']'), 1))
    : (host.split(':')[0] ?? '')
  if (!isLoopbackHostname(hostname)) return `refusing non-loopback Host header: ${host}`
  const origin = req.headers.origin
  if (origin === undefined) return null
  if (origin === 'null') return 'refusing sandboxed cross-site Origin: null'
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return `refusing malformed Origin header: ${origin}`
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== host) {
    return `refusing cross-site Origin: ${origin}`
  }
  return null
}

/** `application/json`, with or without parameters (`charset=…`, …). */
function isJsonContentType(value: string | string[] | undefined): boolean {
  const media = (Array.isArray(value) ? value[0] : value) ?? ''
  return media.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

/** The `jsonRoute` shape `@deepseek-ai/dsh-host-webserver` accepts. */
function jsonRoute(path: string, handler: Handler): unknown {
  return {
    kind: 'exact',
    path,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const crossSite = crossSiteBlock(req)
        if (crossSite !== null) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: crossSite }))
          return
        }
        if (!isJsonContentType(req.headers['content-type'])) {
          res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'content-type must be application/json' }))
          return
        }
        const body = await readJsonBody(req)
        const [status, payload] = await handler({ body })
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(payload))
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        }
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  return JSON.parse(text)
}

const ok = (payload: Record<string, unknown>): [number, unknown] => [200, { ok: true, ...payload }]
const bad = (error: string): [number, unknown] => [400, { ok: false, error }]

function readPrefs(path: string): { hidden: string[] } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      const hidden = (parsed as { hidden?: unknown }).hidden
      if (Array.isArray(hidden)) return { hidden: hidden.filter((id): id is string => typeof id === 'string') }
    }
  } catch {
    // Missing or corrupt prefs simply mean "nothing hidden".
  }
  return { hidden: [] }
}

function writePrefs(path: string, prefs: { hidden: string[] }): void {
  mkdirSync(dirname(path), { recursive: true })
  // A per-process temp name: two writers sharing one `${path}.tmp` would
  // interleave (A writes, B overwrites, A renames B's bytes into place).
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(prefs), 'utf8')
  renameSync(temp, path)
}

/** Register the panel's JSON routes once the optional web server exists. */
export function registerAgyPanel(ctx: Context, deps: AgyPanelDeps): void {
  const store = new RunStore()
  const logger = (ctx as unknown as Partial<InjectingContext>).logger ?? { warn: (message: string) => console.warn(message) }

  const routes: unknown[] = [
    jsonRoute('/api-agy/usage', ({ body }) => {
      const force = (body as { force?: unknown } | null)?.force === true
      const peeked = deps.peekUsage()
      if (peeked === null || peeked.stale || force) {
        // Never block the first paint on a 9–12 s probe: answer with the cached
        // snapshot (or a loading placeholder) and let the next poll pick it up.
        void deps.readUsage(force).catch((error: unknown) => {
          logger.warn(`dsh-subagent-antigravity: usage probe failed: ${String(error)}`)
        })
      }
      const report = peeked ?? {
        rows: [],
        badge: null,
        badgeFamily: '',
        fetchedAt: 0,
        stale: true,
        loading: true,
      }
      return ok({ ...report, loading: peeked === null })
    }),

    jsonRoute('/api-agy/conversations', async () => {
      const prefs = readPrefs(deps.prefsPath)
      let items: ConversationItem[] = []
      try {
        // The summary table knows when a conversation changed last; the
        // registry does not. It is optional — without it the list still shows.
        const summaries = await readConversationSummaries(deps.summariesDbPath)
        items = listConversations({
          records: deps.loadRecords(),
          conversationsDir: deps.conversationsDir,
          annotationsDir: deps.annotationsDir,
          hidden: prefs.hidden,
          summaries,
        })
      } catch (error) {
        logger.warn(`dsh-subagent-antigravity: conversation list failed: ${String(error)}`)
      }
      return ok({ items })
    }),

    jsonRoute('/api-agy/running', () => {
      const runs = deps.listActive()
      return ok({ count: runs.length, runs })
    }),

    // The step timeline of a conversation that is not running any more — read
    // back from agy's own transcript, with the database filling the gaps.
    jsonRoute('/api-agy/history', async ({ body }) => {
      const input = body as { conversationId?: unknown } | null
      const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : ''
      if (conversationId.length === 0) return bad('conversationId is required')
      const history = await readConversationHistory(conversationId, deps.conversationsDir, deps.brainDir)
      return ok({ ...history })
    }),

    jsonRoute('/api-agy/continue', async ({ body }) => {
      const input = body as { conversationId?: unknown; prompt?: unknown } | null
      const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : ''
      const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
      if (conversationId.length === 0) return bad('conversationId is required')
      if (prompt.trim().length === 0) return bad('prompt is empty')
      if (prompt.length > 30_000) return bad('prompt is too long (max 30000 characters)')
      if (store.isRunning(conversationId)) return [409, { ok: false, error: 'this conversation is already running' }]

      const record = Object.values(deps.loadRecords()).find((entry) => entry.conversationId === conversationId)
      if (record === undefined) return bad('unknown conversation: not started by this plugin')
      if (!existsSync(record.cwd)) return bad(`project directory is gone: ${record.cwd}`)

      try {
        const handle = await deps.startRun({
          sessionId: deps.sessionId,
          baseCwd: deps.baseCwd,
          label: record.label.trim().length > 0 ? record.label : 'AGY 接着跑',
          prompt,
          conversationId,
          cwd: record.cwd,
        })
        const runId = store.start(conversationId, record.label, handle)
        return ok({ runId })
      } catch (error) {
        return bad(error instanceof Error ? error.message : String(error))
      }
    }),

    jsonRoute('/api-agy/run', ({ body }) => {
      const input = body as { runId?: unknown; since?: unknown } | null
      const runId = typeof input?.runId === 'string' ? input.runId : ''
      const since = typeof input?.since === 'number' && Number.isFinite(input.since) ? input.since : 0
      if (runId.length === 0) return bad('runId is required')
      const result = store.read(runId, since)
      if (!result.found) return bad('unknown run (it may have expired)')
      const { run, cursor, reset } = result
      return ok({
        status: run.status,
        text: run.text.slice(cursor),
        cursor: run.text.length,
        reset,
        tool: run.tool,
        // The step timeline is sent whole; `stepsVersion` says whether it
        // changed since the last poll.
        steps: run.steps,
        stepsVersion: run.stepsVersion,
        elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt,
        ...(run.error !== undefined ? { error: run.error } : {}),
      })
    }),

    jsonRoute('/api-agy/cancel', ({ body }) => {
      const input = body as { runId?: unknown } | null
      const runId = typeof input?.runId === 'string' ? input.runId : ''
      if (runId.length === 0) return bad('runId is required')
      return store.cancel(runId) ? ok({}) : bad('run is not running')
    }),

    jsonRoute('/api-agy/prefs', ({ body }) => {
      const input = body as { hide?: unknown; show?: unknown } | null
      const prefs = readPrefs(deps.prefsPath)
      const hidden = new Set(prefs.hidden)
      if (typeof input?.hide === 'string' && input.hide.length > 0) hidden.add(input.hide)
      if (typeof input?.show === 'string' && input.show.length > 0) hidden.delete(input.show)
      const next = { hidden: [...hidden] }
      writePrefs(deps.prefsPath, next)
      return ok({ hidden: next.hidden })
    }),
  ]

  const injection = ctx as unknown as Partial<InjectingContext>
  if (typeof injection.inject !== 'function') {
    // Minimal hosts (the offline test harness) have no service registry; the
    // tools must still boot there.
    logger?.warn('dsh-subagent-antigravity: ctx.inject is unavailable; panel routes not registered')
    return
  }
  injection.inject(['webServer'], (webCtx) => {
    for (const route of routes) {
      try {
        webCtx.webServer.register(route)
      } catch (error) {
        // A duplicate path means a second plugin instance; report it instead of
        // failing the whole apply (which would take the tools down too).
        logger?.warn(`dsh-subagent-antigravity: failed to register panel route: ${String(error)}`)
      }
    }
  })
}
