# Patches applied on top of upstream

Upstream: [`ZEM17/dsh-subagent-agy`](https://github.com/ZEM17/dsh-subagent-agy) →
`@dsh-external/dsh-subagent-antigravity@0.2.0` (published 2026-08-16).
This fork (`mojingjing-git/dsh-subagent-agy`) carries the patches below.

The patches now live in **TypeScript source** (`src/index.ts`), not hand-edited
into the compiled bundle: the fork ships the source, a `tsc` build
(`npm run build`), an offline suite (`test/run.mjs`, 93 assertions against a
simulated agy), five panel suites (`npm run test:panel`, 39 assertions) and an
end-to-end suite (`test/e2e-real.mjs`, 13 assertions against the installed `agy`).

The package name (`@dsh-external/dsh-subagent-antigravity`) and the Cordis mount
id (`dsh-subagent-antigravity`) never change, so this build drops in where the
upstream release was. Version: `0.2.0-patched.11`.

## v11 — `model: auto`: the deepest current model, resolved at startup

The configured model was the one thing that could break every run silently: a
slug retired by Google makes agy answer `invalid model selection`, and the fix
had to be a config edit plus a DSH restart. It also put the choice to the wrong
party — the user asked for "the highest thinking depth", not a slug they must
track.

`model: auto` resolves it from the CLI itself:

- `agy models` (a ~10.7 s network call) is probed once at plugin start, off the
  boot path, and cached for 24 h in `$DSH_HOME/agy-models.json`.
- The rule is `gemini-<version>-flash-<depth>`: newest dotted version first
  (`3.10` > `3.9`, `4.0` > `3.8`), then `high` > `medium` > `low` inside one
  version. Today that is `gemini-3.8-flash-high`.
- Empty/unreachable catalogue or a failed probe → `--model` is omitted and agy's
  own default applies. A stale cache beats guessing; a corrupt cache reads as
  missing.
- The resolved slug is what `--model`, the task registry and the panel's model
  column use, so `auto` never shows up as a literal model name.

There is no LLM-facing hint: a prompt cannot change the model agy was spawned
with, and a text note telling the DSH model to "choose the highest depth" had no
lever to pull. The resolution happens in the plugin.

The sidebar button and tab title also became **Antigravity Manager** (the tab
id stays `agy`).

## v10 — the client bundle's missing CommonJS shell (white screen on boot)

patched.9 shipped the first web client entry. DSH's web loader evaluates plugin
bundles as **classic scripts**, so there is no ambient `module`; the factory's
trailing `return module.exports` threw `ReferenceError: module is not defined`,
the entry failed to activate, and the whole GUI booted blank
(`web boot: 1 entry did not activate`).

`lib/client.js` now opens with the same three-line shell the official client
plugins use:

```js
var module = { exports: {} }
var exports = module.exports
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
```

`test/panel-client.mjs` previously injected `module`/`exports` into the factory
with `new Function`, which is exactly why the suite stayed green through the
break. It now evaluates the bundle in a `node:vm` context with no `module`,
`exports` or `require`, matching the real loader; `scripts/build.mjs` runs the
same check before it copies the file.

## v9 — sidebar panel: quotas, past runs, and "continue" from the UI

The plugin had four tools and no face. This release adds one: an `AGY` button in
the sidebar footer (`●N` running jobs + the configured model's five-hour quota)
that opens an **AGY** tab in the right sidebar — four quota cards, the list of
conversations the plugin has run, and an inline box to continue any of them with
streamed output in a separate area at the bottom of the panel.

Three facts shaped the design, all verified against the real machine before
writing code:

1. **`agy --print "/usage"` is TSV, and it takes ~12 seconds.** Four rows =
   two model families × two windows:
   `Gemini Models` / `Claude and GPT models` × `Five Hour` / `Weekly`, each with
   a percentage and an ISO reset time. Twelve seconds is far too slow for a
   footer badge, so `src/agy-usage.ts` wraps the probe in a **5-minute TTL cache
   with single-flight** and a cache file under `$DSH_HOME`; ten open panes still
   produce one agy process, and a failed refresh serves the last good snapshot
   (marked stale) instead of an empty panel.
2. **`webServer.register` accepts only `exact` or `prefix` routes** — there is no
   `:param` matching. The panel therefore uses `/api-agy/run` (with the run id in
   the body) rather than `/api-agy/runs/:id`, and `jsonRoute` (the same shape
   `dsh-chat-import` uses) replies with a JSON content type instead of an HTML
   error page.
3. **`~/.dsh/agy-conversations.json` is the only honest list source.** It holds
   exactly what the plugin ran — `label`, `createdAt`, `cwd`,
   `conversationId` — and no other session's history. It also holds test junk
   (`test-session::…` keys with `fake-conversation-0001`), so
   `src/agy-conversations.ts` drops fake rows, de-duplicates real ones and keeps
   hidden entries hidden. Model names are not in the registry: they are recovered
   from the conversation's `.db` with a byte-level `gemini-[…]` scan, and a
   failed read degrades that one row to `—` instead of failing the list.

The host half (`src/agy-panel.ts`) registers seven JSON routes once the optional
`webServer` service appears (`ctx.inject(['webServer'], …)`): `usage`,
`conversations`, `running`, `continue`, `run`, `cancel`, `prefs`.

The "continue" path deliberately does **not** grow a second stream parser. The
existing background runner already had a complete `stream-json` consumer
(`init` → `conversation_id`, `step_update` → `text_delta`, `result` → status),
so it was split into a reusable `runBackgroundPlan()` and given a
`startPanelRun()` entry that returns a handle with a cursor-based
`readOutput()`. Two fixes fell out of that refactor:

- the panel path must pass `--conversation <id>` **after** the shared argv is
  built, or the CLI resumes nothing (caught by `test/panel-stream.mjs`, which
  runs a fake agy and asserts the argv);
- `runRecords` now carries the model, so a conversation continued from the panel
  records its model like any tool-started run.

### Packaging contract (this is what makes the panel appear)

A client extension is not a normal dependency. All of the following are
required, and all four are now in `package.json` / `scripts/build.mjs`:

- `exports["./client"]` → `./lib/client.js` (a hand-written UMD bundle that
  registers through `window.__ModuleLoader__`; there is no bundler in this repo);
- `dsh.client = { inject: ["@deepseek-ai/dsh-client-locale"], platform: "web" }`;
- `@deepseek-ai/dsh`, `@deepseek-ai/dsh-client-locale` and `react` as peer
  dependencies — the client bundle `require`s them from the host;
- `scripts/build.mjs` copies `src/client.js` into `lib/` and verifies it, so
  `npm pack` cannot silently ship a host-only package.

The tab is registered through `ctx.effect(() => tabs.register(...))` and both
slots through `ctx.slots.inject(...)`. A bare `slots.register` at apply time
throws in the advanced shell — that is the white-screen failure mode the plan
called out, and `test/panel-client.mjs` now asserts that every slot goes through
`inject` and that every endpoint the client calls exists on the host.

Upgrading an installed profile needs a **DSH restart**: the host routes load with
the plugin, but the already-open page keeps the old client bundle.

## v8 — `background: true` was broken: `owner` was an Agent, not a SessionId

Reported symptom: across several models, the tool was never used. Session
recordings from the reporter's own project settled it — 7 sessions, 102 jobs
registered, **zero of them `antigravity`**, including one where the user named
the tool explicitly. The model was not being shy; the call could not succeed.

Root cause, in `dsh-jobs-local`:

```js
resolveOwner(session) {
  const owner = agents.get(session)                       // session id -> Agent
  if (owner === undefined) throw new Error(
    `session "${session}" has no live agent (background job owner must be live)`)
}
```

`start()` passes `spec.owner` through that. The plugin passed the **Agent
object**:

```js
...(parent !== undefined ? { owner: parent } : {}),   // parent = exec.agent
```

`agents.get(<Agent>)` never resolves, so every `background: true` call threw
`session "[object Object]" has no live agent` — the `[object Object]` is the
stringified Agent. Foreground calls were unaffected, which is why the tool
appeared to work in every demo and failed in every real handout.

Fixed: `owner: parent.session.id`.

### Why the suites missed it

`test/harness.mjs` accepted any `spec.owner` and its `view()` read
`job.owner?.id`, so an Agent object looked fine. The assertion in
`wake/owner-is-exec-agent` even asserted the object shape — the stub and the test
were wrong together. The stub now enforces the real contract: `owner` must be a
string that `ctx.get('agents').get()` resolves, or `start()` throws the same
message `dsh-jobs-local` throws. Reverting the one-line fix now fails three
cases with the production error verbatim (80/83 instead of 93/93).

`test/e2e-real.mjs` had no background case at all. That gap is why a real
regression reached a release; background coverage is the next addition.

## v7 — the tool descriptions say "sub-agent", not just "antigravity"

Reported symptom: asked to create an agent, or to dispatch work to another
agent, the model did not think of this plugin. The cause is discoverability, not
behaviour — the tool name `antigravity` is a noun with no literal link to the
action "create a sub-agent", and the only other candidates in view are the
built-in `subagent` / `subagent_fork`, so the plugin was skipped.

The descriptions now open with the action (`Create a delegated sub-agent
task`), list the phrasings users actually use (dispatch / delegate / launch /
spin up / hand off / 派个 agent / 委托给别的模型 / 让 agy 干), name the package and
the mount id so a search for either one hits, say plainly that this is a tool
and not a skill, and spell out how it differs from the built-in `subagent`
(a local child in this same process that inherits the conversation) and from
`antigravity_followup` (the only way back to an already-dispatched agy task).

Only `description` text changed — no tool name, no parameter, no return shape.

## v1 — DSH compatibility (required)

Upstream imports `resolveChildCwd` and `validateConfiguredCwd` from
`@deepseek-ai/dsh-subagent`. Both exports were **removed** in DSH `0.2.1-rc.2`, so
the upstream bundle fails to load with
`SyntaxError: ... does not provide an export named 'resolveChildCwd'`.

This patch drops the two dead imports, imports the still-exported
`assertUsableCwd`, and re-adds `resolveChildCwd` / `validateConfiguredCwd` as
local functions — byte-faithful copies of the originals from
`@deepseek-ai/dsh-subagent@0.1.7-rc.2`, re-based on `assertUsableCwd`.

## v2 — per-run transcripts (feature)

Foreground runs now use agy's `--output-format stream-json` when the installed
build supports it, and **every** run (foreground and background) writes its
complete event stream to a transcript file:

    ~/.dsh/agy-transcripts/<sanitized task key>.ndjson
    ~/.dsh/agy-transcripts/index.json

The NDJSON stream contains everything agy did: the user input step, every agent
response with its streaming `text_delta` chunks, every tool call with its name
and parameters, per-step durations and token usage, and the final result.
`tryParseJsonOutput` now understands the `result` event, so the final answer is
still extracted exactly as before.

New config fields: `transcript` (bool, default true) and `transcriptDir`
(string, default empty = `~/.dsh/agy-transcripts`).

## v3 — fix the result-event extraction (required by v2)

`parseJsonObject` only accepts objects that carry a top-level `status`,
`conversation_id`, or `response`. In the stream-json protocol those fields are
nested under `result`, so the final `result` event was filtered out and the
parser fell back to the `init` event — the run was then reported as a failure
("agy exited with code 0") even though agy had succeeded.

v3 scans the stream for a `result` event with a raw `JSON.parse` first, and only
then falls back to the original plain-json behaviour.

## v4 — the prompt in the transcript

The agy event stream does not carry the prompt the harness sent, so a transcript
started mid-flight. v4 writes a `prompt` event as the first line of every
transcript (task key, label, cwd, and the full prompt text), for both foreground
and background runs.

## v5 — unified run core, agy 1.4.6 compatibility, honest lifecycle

### Fixed: a cancelled or timed-out run threw instead of settling

`transcriptPath` was declared with `const` *inside* the attempt body but
referenced from the `aborted` and `timedOut` return paths, which run earlier.
Any cancellation or watchdog timeout therefore raised
`Cannot access 'transcriptPath' before initialization` — masking the real
outcome exactly when the user most needs it. It is now declared once, before the
attempt.

### Fixed: `--effort` rejected values agy accepts

The plugin validated `effort` against `low | medium | high`, but agy 1.4.5+
accepts `low | medium | high | xhigh | max`. Passing `xhigh` or `max` threw a
configuration error. The list is now `EFFORT_LEVELS`; an unknown value logs a
warning and is still forwarded, so a future agy release does not need a rebuild.

### Fixed: the flag probe could go permanently stale

The `agy help` capability probe cached its result in provider memory only, keyed
by nothing. agy updates itself in place (1.4.5 → 1.4.6 happened during this
work), and a stale *positive* cache is worse than a missing one: the plugin
would keep sending flags the new build dropped.

The cache is now keyed by the executable's own identity —
`<path>@<size>:<mtime>` — so a replaced binary re-probes automatically. Results
also persist to `agy-flag-cache.json` beside the plugin (8 builds retained), so
restarts do not re-probe. A failed or aborted probe writes nothing, so the
plugin can never inherit an error as a permanent capability claim.

### Fixed: the foreground result now exposes the conversation id

`antigravity` and `antigravity_followup` return `conversationId` alongside
`task`. A model that just ran a task can chain a follow-up without reading the
registry first, and a caller can record the agy conversation for audit. This is
additive — nothing is removed.

**The field must also be declared in the tool's output schema.** Every tool in
this plugin declares a *closed* output object (`additionalProperties: false`), so
the first cut of this change returned a field the schema did not list, and DSH
discarded the result of a perfectly successful run before the model ever saw it.
Both `antigravity` and `antigravity_followup` now declare
`conversationId: { type: 'string' }`. Found by the real-agy end-to-end suite, not
by the offline one — see *Testing*.

### Fixed: `--effort`/`--model` were silently coupled to the README

The upstream README suggests `model: gemini-3.1-pro-high`, which does not exist
on current builds; `agy models` on the reference machine reports
`gemini-3.8-flash-high|medium|low`, `claude-sonnet-4-6`,
`claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. The default remains *empty*
(deliberate: empty means "let agy choose", which is always valid), and the
README now says so explicitly instead of naming a model that may not exist.

### Testing

The offline suite (`test/run.mjs`) drives the real plugin against a simulated
agy: 73 assertions covering the output protocol (chunked lines, multi-byte
characters split across chunks, a missing final newline, unknown events, a
missing result event), the lifecycle (start failure, cancel, timeout, unload,
double cleanup), persistence (concurrent registry writes, corrupt records,
backwards compatibility, transcript write failure), DSH integration (the jobs
contract, identity mapping, capacity release) and the compatibility shims.

The suite's `callTool` now validates every result against the tool's declared
output schema, the way the real tool runtime does. Without that, a result with an
undeclared field passes offline and fails live — exactly what happened with
`conversationId`. Two cases guard it: one asserts every tool's real result
satisfies its schema, the other shrinks a schema on purpose and asserts the
validator rejects the result (so the guard itself cannot silently rot).

The end-to-end suite (`test/e2e-real.mjs`) drives the same plugin against the
installed `agy`: 13 assertions over a simple reply, a same-conversation
follow-up, a file task in a temp directory, and a cancel while running.
`rebuild.ps1` runs the offline suite on every build and the real one with
`-IncludeReal`.

Three bugs in this patch series were found by these suites, not by reading: the
`conversationId` schema omission (real suite), the earlier `result`-event filter,
and the `transcriptPath` TDZ throw on cancel/timeout (offline suite).

### Not in this release

- **Native catalogue entries.** The provider is registered on `ctx.subagents`
  and works through `startActivation()`, which is what makes agy runs visible as
  DSH children with capacity accounting and completion notices. It reports
  `NO_START_CAPABILITIES` (`agentOptions`/`agentPreset`/`outputSchema`/
  `depthLimit` all false) because an out-of-process backend cannot honour those
  parent-enforced features. Requests needing them are rejected before a run
  starts rather than accepted and ignored.
- **Background runs stay on the jobs path.** `backgroundTimeoutMs` runs are
  driven by `ctx.get('jobs').start(...)` so the model keeps reading live
  progress with `job_output` and can stop them with `job_kill`. A DSH
  `startExternal` handle returns one promise and has no streaming window, so
  routing background work through the manager would lose that. Foreground runs
  do go through the manager.
- **Follow-ups are not separate catalogue children.** An external provider is
  execute-once by contract (`prepareContinuable` is local-only), so
  `antigravity_followup` continues the *same* agy conversation under the same
  task key with `--conversation <id>`. Follow-ups to one conversation are
  serialized.
- **Completion wakes the agent instead of being polled.** `background: true`
  passes the *exec* agent as the job `owner`. `dsh-tool-jobs` then resolves
  that id through `ctx.get('agents')` and wakes it when the job settles, so a
  completion notice lands in the session (or opens a new turn on an idle
  agent) with no polling. Two details make it work: the owner must be the exec
  agent — the provider's own `providerAgent` is a non-session stub, so a wake
  aimed at it is silently dropped — and `owner` must be set at all, or the job
  still runs but completion is discarded. The tool descriptions now say "you
  are woken in-session when the job settles" instead of the earlier "poll
  `job_output` roughly every 60 seconds", which is what produced the polling
  loop.
- **`--print-timeout` is spelled the way THIS agy build wants.** agy 1.4.x
  parses the flag with Go's `time.ParseDuration` and rejects a bare millisecond
  count (`invalid value "600000" ... time: missing unit in duration`) before any
  work starts. Earlier builds took the bare number, and `agy help` documents the
  flag without its syntax, so the two are indistinguishable from `help` alone.
  The plugin probes once (`--print x --print-timeout 1ms`) and, if that is
  rejected, retries the bare form; the answer is cached, and if neither
  spelling parses it warns and relies on the local watchdog. `flagCachePath`
  controls that cache (`~/.dsh/agy-flag-cache.json` by default, `''` disables
  it).
- **Probe results are keyed by the executable's identity**, not by provider
  instance: path + size + mtime. agy updates itself — this machine moved from
  1.4.5 to 1.4.6 between two runs — and a cache that outlived the binary would
  apply yesterday's answers to today's CLI. A new build re-probes on its own.
- `--input-format stream-json` (persistent-process mode, multi-turn without a
  new process) — deliberately deferred; one process per turn is the shipped
  model.
