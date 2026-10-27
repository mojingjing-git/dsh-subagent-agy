/**
 * The sidebar panel's host half: six JSON routes over the plugin's own data.
 *
 * Everything here is deliberately POST + JSON. `webServer.register` only takes
 * `exact` or `prefix` routes (no `:param` segments), and a JSON content type is
 * what keeps a cross-site form POST from reaching these handlers: the browser
 * must preflight it, and the preflight fails.
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
import type { UsageReport } from './agy-usage.js'

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
  tool: string | null
  startedAt: number
  endedAt: number | null
  error?: string
  handle: AntigravityBackgroundHandle
  timer?: NodeJS.Timeout
}

const MAX_RUN_TEXT = 400 * 1024
const MAX_RUNS = 20
const POLL_MS = 250

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
      tool: null,
      startedAt: Date.now(),
      endedAt: null,
      handle,
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
    const reset = !Number.isFinite(since) || since < 0 || since > run.text.length
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
        if (run.text.length > MAX_RUN_TEXT) run.text = run.text.slice(run.text.length - MAX_RUN_TEXT)
      }
      run.tool = run.handle.tool?.() ?? run.tool
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
  const temp = `${path}.tmp`
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

    jsonRoute('/api-agy/conversations', () => {
      const prefs = readPrefs(deps.prefsPath)
      let items: ConversationItem[] = []
      try {
        items = listConversations({
          records: deps.loadRecords(),
          conversationsDir: deps.conversationsDir,
          annotationsDir: deps.annotationsDir,
          hidden: prefs.hidden,
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
