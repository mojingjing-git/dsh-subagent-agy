/**
 * Boots the real plugin against a fake cordis context so the offline suite can
 * drive apply() and the model-facing tools exactly as DSH would.
 *
 * Everything the plugin depends on is real except the service seams the plugin
 * actually calls:
 *   - ctx.subprocess -> ./subprocess-shim.mjs (real child processes)
 *   - ctx.subagents -> a registry that records the provider and can invoke
 *     it, mirroring what dsh-subagent's manager does for delivery: 'parent'
 *   - ctx.get('jobs') -> a minimal jobs service (start/readOutput/kill)
 * The tool registry, logger, effect scope and config validation are native.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSubprocessShim, readIfExists } from './subprocess-shim.mjs'
import { writeFakeAgyWrapper } from './fake-agy-wrapper.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_ENTRY = resolve(HERE, '..', 'lib', 'index.js')
const FAKE_AGY = resolve(HERE, 'fake-agy.mjs')
const NODE_BIN = process.execPath

/** Build an isolated scratch dir for one test case. */
export function scratch(prefix = 'agy-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Remove a scratch dir, ignoring Windows file locks from a slow child. */
export function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** Transcript dir the plugin resolves to when transcriptDir is unset. */
export function homeTranscriptDir() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return join(home, '.dsh', 'agy-transcripts')
}

/**
 * Resolve the plugin's Config schema against overrides. Config is a
 * schemastery schema, so Config(value) yields the validated/defaulted object
 * the way cordis does when applying a plugin.
 */
function buildConfig(mod, overrides) {
  const base = {
    printTimeoutMs: 20_000,
    backgroundTimeoutMs: 30_000,
    watchdogMarginMs: 5_000,
    disposeGraceMs: 2_000,
    ...overrides,
  }
  return mod.Config(base)
}

/**
 * Create one isolated plugin instance.
 * @returns a controller with the tools map, logger lines, subprocess shim and
 *          a dispose() that runs the registered effect disposers.
 */
export async function bootPlugin(overrides = {}, options = {}) {
  const mod = await import(`${pathToFileURL(PLUGIN_ENTRY).href}?t=${Date.now()}`)
  const workdir = options.workdir ?? scratch()
  // `command` must be one executable, so the fake CLI ships as a wrapper.
  const command = overrides.command ?? writeFakeAgyWrapper(workdir, FAKE_AGY, NODE_BIN)
  // Each case gets its own durable registry: the default derives
  // ~/.dsh/agy-conversations.json, which would leak task keys between cases
  // (and into the developer's real DSH home).
  const registryPath = overrides.registryPath ?? join(workdir, 'agy-conversations.json')
  // Pin the probe cache inside the case's scratch dir. The default lives in
  // DSH_HOME, so each case's throwaway wrapper would add a permanent entry
  // (the cache would fill with dead temp paths and evict real builds).
  // `flagCachePath: null` disables the cache entirely, for probe-path tests.
  const flagCachePath =
    overrides.flagCachePath === undefined ? join(workdir, 'agy-flag-cache.json') : overrides.flagCachePath
  const config = buildConfig(mod, { ...overrides, command, registryPath, flagCachePath })
  const tools = new Map()
  const log = []
  const disposers = []
  const providers = new Map()
  const subprocess = createSubprocessShim()

  const pushLog = (level) => (message) => log.push({ level, message: String(message) })

  // A faithful stand-in for @deepseek-ai/dsh-jobs-local, mirroring the contract
  // in that package's lib/index.js:
  //   - `start(spec)` builds a producer handle { id, append, updateProgress },
  //     calls `spec.run(handle)` and keeps the returned hooks { cancel, done }
  //   - ids are `${kind}-${16 lowercase hex}`
  //   - `done` resolves to { status, detail } and drives the record's status
  //     through running → completed | killed | failed (first settlement wins)
  //   - `kill` calls the hooks' cancel, moves to 'stopping', and records the
  //     reason; the producer's own settlement then turns it 'killed'
  //   - `read`/`readAt` expose the ring at an absolute byte offset
  //   - `remove` refuses a job that has not settled
  const jobs = new Map()
  // Every `owner` a producer registered, oldest first. `dsh-tool-jobs` only
  // wakes an agent when `event.job.owner` is set — `start()` records `spec.owner`
  // on the record and the `settled` event carries it. A producer that omits
  // `owner` still runs, but its completion is silently dropped.
  const jobOwners = []
  // Session ids that currently have a live Agent, as `ctx.get('agents').get()`
  // would see them. `jobs-local.resolveOwner()` consults this registry, so a
  // registration whose owner is not in here is rejected before the job exists.
  const knownOwners = new Set()
  // Mirror of `ctx.get('agents')`: `get()` takes a session id and returns the
  // live Agent, or undefined. `dsh-jobs-local.resolveOwner()` is the only real
  // consumer, and it is what turns a wrong owner type into a hard throw.
  const liveAgents = new Map()
  const agentsService = {
    get(session) {
      return typeof session === 'string' ? liveAgents.get(session) : undefined
    },
  }
  const jobsService = {
    events: {
      // Mirrors `ctx.jobs.events.subscribe({ owners: 'scope' }, fn)`: the
      // harness never replays events, it only needs the seam to exist.
      subscribe() {
        return { dispose() {} }
      },
    },
    start(spec) {
      if (typeof spec.kind !== 'string' || spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string')
      if (typeof spec.label !== 'string' || spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
      // Real `dsh-jobs-local.start()` runs `spec.owner` through
      // `resolveOwner()`, which resolves it as a *session id*:
      //   `agents.get(session)` -> throw `session "[object Object]" has no live agent`
      // when handed an Agent object. This stub used to accept anything, so the
      // plugin's `owner: parent` shipped green offline and failed on the first
      // real `background: true` call. Reproduce the real check here.
      if (spec.owner !== undefined) {
        if (typeof spec.owner !== 'string') {
          throw new Error(
            `session "${String(spec.owner)}" has no live agent (background job owner must be live)`,
          )
        }
        if (!knownOwners.has(spec.owner)) {
          throw new Error(
            `session "${spec.owner}" has no live agent (background job owner must be live)`,
          )
        }
      }
      jobOwners.push(spec.owner)
      let id
      do id = `${spec.kind}-${randomUUID().replaceAll('-', '').slice(0, 16)}`
      while (jobs.has(id))

      // `append`/`updateProgress` must be usable from inside spec.run() to
      // stage output before the record exists, so the record is late-bound.
      const state = { job: undefined }
      let ring = ''
      const handle = {
        id,
        append(text) {
          if (jobsService.isTerminal(state.job?.status)) return
          ring += String(text)
        },
        updateProgress(line) {
          if (jobsService.isTerminal(state.job?.status)) return
          if (state.job !== undefined) state.job.progress = String(line)
        },
      }

      const hooks = spec.run(handle)
      if (hooks === undefined || typeof hooks.cancel !== 'function' || hooks.done === undefined) {
        throw new Error(`job ${id} producer violated the contract: run() must return { cancel, done }`)
      }

      const job = {
        id,
        kind: spec.kind,
        label: spec.label,
        owner: spec.owner,
        cancel: hooks.cancel.bind(hooks),
        status: 'running',
        detail: undefined,
        progress: undefined,
        killReason: undefined,
        ring: () => ring,
        readOffset: 0,
      }
      state.job = job
      jobs.set(id, job)

      void hooks.done.then(
        (outcome) => {
          if (jobsService.isTerminal(job.status)) return
          // Real dsh-jobs-local drains the producer's remaining window into the
          // ring when the producer settles, so `readOutput` after `wait` returns
          // everything the producer buffered. Without this drain the buffered
          // text never reaches the ring and post-settlement reads come back
          // empty — the failure mode this stub used to exhibit.
          if (typeof hooks.readOutput === 'function') {
            try {
              const rest = hooks.readOutput()
              if (typeof rest === 'string' && rest.length > 0) ring += rest
            } catch {
              // a throwing readOutput must not mask the outcome
            }
          }
          const status = outcome?.status ?? 'failed'
          job.status = status
          const detail = outcome?.detail
          if (status === 'killed' && job.killReason !== undefined) {
            job.detail = detail !== undefined ? `${detail}; ${job.killReason}` : job.killReason
          } else if (detail !== undefined) {
            job.detail = detail
          }
        },
        (error) => {
          if (jobsService.isTerminal(job.status)) return
          job.status = 'failed'
          job.detail = `producer done promise rejected (producer contract violation): ${String(error)}`
        },
      )
      return id
    },
    isTerminal(status) {
      return status === 'completed' || status === 'killed' || status === 'failed'
    },
    view(id) {
      const job = jobs.get(id)
      if (job === undefined) return undefined
      // `owner` is the owner *session id* in the projection (`job.owner?.id`),
      // while the record keeps the live Agent. `dsh-tool-jobs` looks the id up
      // through `ctx.get('agents').get(event.job.owner)`.
      const ownerId = job.owner?.id
      return {
        id: job.id,
        kind: job.kind,
        label: job.label,
        ...(ownerId !== undefined ? { owner: ownerId } : {}),
        status: job.status,
        ...(job.detail !== undefined ? { detail: job.detail } : {}),
        ...(job.progress !== undefined ? { progress: job.progress } : {}),
        output: { total: Buffer.byteLength(job.ring(), 'utf8'), earliest: 0 },
      }
    },
    get(id) {
      return jobsService.view(id)
    },
    list() {
      return [...jobs.keys()].map((id) => jobsService.view(id))
    },
    /** Offset-based, non-consuming read of the whole ring (like `readAt`). */
    readAt(id, from = 0) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`unknown job ${id}`)
      const bytes = Buffer.from(job.ring(), 'utf8')
      const slice = bytes.subarray(Math.max(0, Math.min(from, bytes.length)))
      return { text: slice.toString('utf8'), next: bytes.length, chunks: [], lossy: false }
    },
    /** Model-cursor read: consumes what it returns (like `read`). */
    read(id) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`unknown job ${id}`)
      const chunk = jobsService.readAt(id, job.readOffset)
      job.readOffset = chunk.next
      return { chunks: chunk.text.length > 0 ? [{ at: 0, text: chunk.text }] : [], lossy: false, job: jobsService.view(id) }
    },
    /** Convenience for assertions: the full output regardless of cursor. */
    readOutput(id) {
      return jobsService.readAt(id, 0).text
    },
    kill(id, _caller, reason) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`unknown job ${id}`)
      if (jobsService.isTerminal(job.status)) return 'already-finished'
      job.cancel(reason)
      job.status = 'stopping'
      if (reason !== undefined) job.killReason = reason
      return 'requested'
    },
    async wait(id, timeoutMs = 10_000) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`unknown job ${id}`)
      const deadline = Date.now() + timeoutMs
      while (!jobsService.isTerminal(job.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      return jobsService.view(id)
    },
    remove(id) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`unknown job ${id}`)
      if (!jobsService.isTerminal(job.status)) throw new Error(`job ${id} is still ${job.status}; kill it and wait for settlement before removing it`)
      jobs.delete(id)
    },
  }

  const ctx = {
    config,
    logger: {
      info: pushLog('info'),
      warn: pushLog('warn'),
      error: pushLog('error'),
      debug: pushLog('debug'),
    },
    effect(register, label) {
      disposers.push({ label, fn: register() })
    },
    get(name) {
      if (name === 'jobs') return jobsService
      if (name === 'agents') return agentsService
      return undefined
    },
    subprocess,
    subagents: {
      registerProvider(provider) {
        providers.set(provider.name, provider)
        return () => providers.delete(provider.name)
      },
      getProvider(name) {
        return providers.get(name)
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  }

  mod.apply(ctx, config)

  // A stand-in for exec.agent: the plugin resolves the child cwd from
  // `request.parent.session.header.cwd`, and identifies the parent by `id`.
  // `id` + `ctx.effect` are what `jobs-local.resolveOwner()` /
  // `ensureOwnerCleanup()` touch on the live owner, so the stand-in carries them.
  const agent = {
    id: options.sessionId ?? 'test-session',
    ctx: {
      effect(register) {
        disposers.push({ label: 'agent effect', fn: register() })
        return () => {}
      },
    },
    session: {
      id: options.sessionId ?? 'test-session',
      header: { cwd: options.sessionCwd ?? workdir },
    },
  }
  // Publish the stand-in as the one live agent for this session, so the
  // owner check in `jobs.start()` behaves like the real registry.
  knownOwners.add(agent.id)
  liveAgents.set(agent.id, agent)

  /**
   * Assert a value satisfies a tool's declared output schema, the way the real
   * tool runtime does. Every declared schema is a CLOSED object
   * (`additionalProperties: false`), so returning an undeclared field makes the
   * harness discard an otherwise successful result — a failure that is
   * invisible to a test that only calls `execute()`.
   */
  function assertOutputSchema(tool, value) {
    const schema = tool?.output?.schema
    if (schema === undefined) return
    const walk = (spec, val, path) => {
      if (spec === undefined || spec === true) return
      const type = spec.type ?? (spec.properties !== undefined ? 'object' : undefined)
      if (type === 'object') {
        if (val === null || typeof val !== 'object' || Array.isArray(val)) {
          throw new Error(`output${path} must be an object (got ${Array.isArray(val) ? 'array' : typeof val})`)
        }
        const declared = spec.properties ?? {}
        for (const [key, sub] of Object.entries(declared)) {
          if (sub?.required === true && val[key] === undefined) {
            throw new Error(`output${path}.${key} is required but missing`)
          }
          if (sub?.const !== undefined && val[key] !== undefined && val[key] !== sub.const) {
            throw new Error(`output${path}.${key} must be ${JSON.stringify(sub.const)} (got ${JSON.stringify(val[key])})`)
          }
          if (val[key] !== undefined) walk(sub, val[key], `${path}.${key}`)
        }
        if (spec.additionalProperties === false) {
          for (const key of Object.keys(val)) {
            if (!(key in declared)) {
              throw new Error(`output${path}.${key} is not a declared property (additionalProperties: false)`)
            }
          }
        }
        return
      }
      if (type === 'array') {
        if (!Array.isArray(val)) throw new Error(`output${path} must be an array (got ${typeof val})`)
        val.forEach((item, index) => walk(spec.items, item, `${path}[${index}]`))
        return
      }
      if (type === 'json') return
      if (type === 'string' && typeof val !== 'string') throw new Error(`output${path} must be a string (got ${typeof val})`)
      if (type === 'boolean' && typeof val !== 'boolean') throw new Error(`output${path} must be a boolean (got ${typeof val})`)
      if (type === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) throw new Error(`output${path} must be a finite number (got ${String(val)})`)
    }
    walk(schema, value, '')
  }

  /** Invoke a tool the way the tool runtime would. */
  let lastToolAgent
  async function callTool(name, args, execOverrides = {}) {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered (have: ${[...tools.keys()].join(', ')})`)
    const exec = {
      agent,
      signal: execOverrides.signal ?? new AbortController().signal,
      ...execOverrides,
    }
    lastToolAgent = exec.agent
    const value = await tool.execute(args, exec)
    // Match the real runtime: a result that violates the declared output
    // schema would be rejected before the model ever sees it.
    assertOutputSchema(tool, value)
    return value
  }

  /** Render a tool result the way the UI would, for text assertions. */
  function render(name, args, value) {
    const tool = tools.get(name)
    return tool?.output?.render?.(args, value) ?? []
  }

  const transcriptDir = () => (config.transcriptDir.length > 0 ? config.transcriptDir : homeTranscriptDir())

  return {
    mod,
    config,
    ctx,
    workdir,
    tools,
    log,
    jobs,
    jobsService,
    tools,
    subprocess,
    providers,
    agent,
    callTool,
    render,
    jobOwners,
    liveAgents,
    /** The exec.agent the most recent callTool used (what the plugin saw). */
    get lastToolAgent() {
      return lastToolAgent
    },
    transcriptDir,
    registryPath,
    provider: () => providers.get(config.providerName),
    transcriptIndex: () => readIfExists(join(transcriptDir(), 'index.json')),
    taskRegistry: () => {
      const raw = readIfExists(registryPath)
      if (raw === undefined) return {}
      try {
        return JSON.parse(raw)
      } catch {
        return {}
      }
    },
    dispose() {
      // LIFO, like a cordis effect scope.
      for (const entry of disposers.splice(0).reverse()) {
        try {
          entry.fn?.()
        } catch {
          /* keep disposing */
        }
      }
    },
    cleanup: () => cleanup(workdir),
  }
}

export { FAKE_AGY, NODE_BIN, PLUGIN_ENTRY, readIfExists }
