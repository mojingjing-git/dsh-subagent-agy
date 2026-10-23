# Patches applied on top of upstream

Upstream: [`ZEM17/dsh-subagent-agy`](https://github.com/ZEM17/dsh-subagent-agy) →
`@dsh-external/dsh-subagent-antigravity@0.2.0` (published 2026-08-16).
This fork (`mojingjing-git/dsh-subagent-agy`) carries the patches below.

The patches now live in **TypeScript source** (`src/index.ts`), not hand-edited
into the compiled bundle: the fork ships the source, a `tsc` build
(`npm run build`), an offline suite (`test/run.mjs`, 73 assertions against a
simulated agy) and an end-to-end suite (`test/e2e-real.mjs`, 13 assertions
against the installed `agy`).

The package name (`@dsh-external/dsh-subagent-antigravity`) and the Cordis mount
id (`dsh-subagent-antigravity`) never change, so this build drops in where the
upstream release was. Version: `0.2.0-patched.5`.

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
- `--input-format stream-json` (persistent-process mode, multi-turn without a
  new process) — deliberately deferred; one process per turn is the shipped
  model.
