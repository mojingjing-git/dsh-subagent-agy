# Changelog

All notable changes to this fork are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Upstream baseline: `@dsh-external/dsh-subagent-antigravity@0.2.0`
([ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy), MIT).

## [0.2.0-patched.13]

Audit-driven hardening release: every finding of the v2 code audit
(`AUDIT-report.md`) that mattered is fixed with a failing-test-first commit.

### Fixed

- **Panel routes guard against cross-site and rebinding requests.** Every
  `/api-agy/*` route now rejects a non-`application/json` content type (415),
  a non-loopback `Host` header and a cross-site or `null` `Origin` (403), and
  fails closed on malformed headers — the host web server dispatches purely by
  path and performs no checks of its own, so the panel is its own trust
  boundary. Same-origin fetches (including the bundled `client.js`) are
  unaffected; `GET` requests stay 405 as before.
- **A truncated panel run resyncs instead of freezing.** Once a run's output
  passes the 400 KB buffer cap, the next poll returns a full reset snapshot;
  previously every later poll computed an empty delta and the client never saw
  new output again.
- **Conversation ids are validated before they touch a path.** `modelFromDb`,
  `titleFromAnnotations` and `listConversations` refuse ids outside the
  UUID-shaped whitelist without hitting the filesystem.
- **Cancelled and timed-out runs leave the same transcript evidence as
  failures.** The transcript header now carries `status: cancelled|timeout`
  and the partial output is captured when a run dies mid-stream.
- **The transcript index is replaced atomically**, like the registry:
  `writeJsonAtomic` (pid-unique tmp + rename, temp removed on failure).
- **Foreground and background agree on the stream protocol.** One strict
  `resolveStreamMode` decides `stream-json` vs `json` for both executors, so a
  build whose flag probe is inconclusive no longer runs two different
  protocols depending on executor.
- **The step fold keeps a bounded window.** `mergeStepInto` caps the timeline
  at 200 steps, evicted indexes stay evicted, and a snapshot can no longer
  resurrect them.
- **Steps are normalized once, at the fold.** Snapshots no longer re-normalize
  (which re-wrote each step's own `…(+N chars)` receipt — and reallocated the
  timeline — on every 250 ms poll), and `truncate` is idempotent.
- **Per-process temp names for the usage cache and panel prefs**, matching the
  model catalogue: two writers sharing one `${path}.tmp` could interleave.
- **`resolveChildCwd` anchors empty and relative parents.** A session header
  without a cwd (arriving as `''`) can no longer hand the child an unanchored
  relative cwd.
- **A failed history database copy removes its temp dir** instead of
  stranding a conversation-sized copy in the user's tmpdir.
- **The authentication hint names a flow that exists**: real agy has no
  `login` subcommand and no API-key mechanism; the hint now points at the
  browser sign-in any interactive agy command starts.
- **Bare `node scripts/pack.mjs` packs to `dist/`** instead of exiting with a
  usage error; explicit arguments still work and produce a byte-identical
  tarball.
- **`rebuild.ps1` rejects a stub-sized `lib/types/index.d.ts`**, so a
  shim-only build cannot ship an empty declaration.

### Changed

- `pretest` / `pretest:panel` run the build first, so `npm test` can never
  test stale `lib/` output — the class of false green the fork has hit before.
- `test/run.mjs`: an async assertion that is never awaited is recorded as a
  permanent failure instead of vanishing, and a filter that matches no case
  exits 1 instead of reporting `0/0` with exit code 0.
- CI builds and then fails if committed `lib/` disagrees with `src/`, and runs
  the panel suites; `rebuild.ps1` always rebuilds instead of comparing
  mtimes; `scripts/build.mjs` cleans `lib/` before compiling; selftest treats
  `--output-format` / `--sandbox` / `--prompt-file` as optional flags (the
  plugin probes and adapts); `engines` requires `node >=22.5.0`; tsconfig pins
  `newLine: lf`.

## [0.2.0-patched.12]

### Fixed

- **The step timeline shows the model's answer, not its name.** agy keeps the
  reply body in the step payload; `gen_metadata` only holds the model name,
  and preferring it shadowed every real body with `Gemini 3.8 Flash (High)`.
  Where no body was kept, the timeline now says so explicitly.

## [0.2.0-patched.11]

### Added

- **`model: auto`.** The plugin probes `agy models` once at startup (cached for
  24 h in `$DSH_HOME/agy-models.json`) and passes the newest Gemini Flash slug
  at its highest thinking level — today `gemini-3.8-flash-high`. A retired or
  renamed model therefore heals itself instead of failing every run with
  `invalid model selection`; when the catalogue is empty or unreachable the
  `--model` flag is omitted and agy's own default applies.
- `test/agy-models.mjs` — parsing, numeric version ranking, cache corruption and
  an end-to-end `model: auto` run (panel suite now 39 assertions).

### Changed

- The sidebar footer button and the right-hand tab are titled
  **Antigravity Manager** instead of `AGY`.

## [0.2.0-patched.10]

### Fixed

- **White screen on DSH boot after installing patched.9.** The web loader
  evaluates plugin client bundles as classic scripts, so `module` does not exist;
  the factory threw `ReferenceError: module is not defined` and the whole web
  entry failed to activate (`web boot: 1 entry did not activate`). `lib/client.js`
  now installs the same `module`/`exports` shell the official client plugins use
  before returning its exports.

## [0.2.0-patched.9]

### Added

- **Sidebar panel.** An `AGY` button in the sidebar footer (`●N` running jobs +
  the configured model family's five-hour quota) opens an AGY tab in the right
  sidebar: four quota cards from `agy /usage` (five-minute TTL cache,
  single-flight), the list of conversations this plugin ran (title, time,
  directory, model, state) and an inline "continue" box whose output streams
  into a separate area at the bottom of the panel.
- Seven host JSON routes (`/api-agy/usage|conversations|running|continue|run|
  cancel|prefs`) registered through the optional `webServer` service.
- `npm run test:panel` — 33 assertions over the data sources, host routes,
  fake-agy streaming and the client-bundle contract.

### Changed

- Client extension packaging: `exports["./client"]`, `dsh.client`, peer React and
  a build step that copies and verifies `lib/client.js`.

### Fixed

- Continuing from the panel passes `--conversation` after the shared argv is
  assembled (previously the flag could be dropped and the run started a new
  conversation).
- Registry listing drops `test-session::` / fake-conversation rows and
  de-duplicates real ones.

## [0.2.0-patched.5]

The first release of this fork. Upstream 0.2.0 could not load on DSH 0.2.1-rc.2
and hid everything agy did. Every change below is documented with its rationale
in [PATCH.md](PATCH.md).

### Added

- **Per-run transcripts.** Every run — foreground and background — writes agy's
  complete NDJSON event stream to `~/.dsh/agy-transcripts/<task key>.ndjson`
  plus an `index.json`. The stream records each agent response delta, every tool
  call with its parameters, per-step durations and token usage, and the final
  result. The first line carries the prompt that was actually sent, which the
  agy stream itself never includes. Config: `transcript` (default `true`),
  `transcriptDir`.
- **`conversationId` in tool results.** `antigravity` and
  `antigravity_followup` now return the agy conversation id alongside `task`.
- **Two test suites.** `test/run.mjs` — 73 assertions against a simulated agy
  (`npm test`). `test/e2e-real.mjs` — 13 assertions against the installed `agy`
  (`npm run test:e2e`). The offline suite validates every tool result against
  that tool's declared output schema, the way the real runtime does.
- **`rebuild.ps1`** — Windows one-shot: typecheck → offline suite → package →
  tarball content check, with `-IncludeReal` for the real-agy suite.
- **`scripts/pack.mjs`** — deterministic tarball build (standard `package/`
  layout, `node_modules/` excluded).
- **Persistent flag-probe cache** (`agy-flag-cache.json`, 8 builds retained),
  keyed by the executable's own identity so an updated agy re-probes.

### Fixed

- **The plugin could not load on DSH 0.2.1-rc.2.** Upstream imports
  `resolveChildCwd` and `validateConfiguredCwd` from `@deepseek-ai/dsh-subagent`;
  both exports were removed, so the bundle died with
  `SyntaxError: ... does not provide an export named 'resolveChildCwd'`. They are
  now local, byte-faithful shims re-based on the still-exported `assertUsableCwd`.
- **Successful stream-json runs were reported as failures.** The parser accepted
  only objects with a top-level `status`/`conversation_id`/`response`, but in the
  stream-json protocol those live under `result`, so the terminal event was
  filtered out and the run ended with a spurious
  `agy exited with code 0`.
- **A cancelled or timed-out run threw instead of settling.** `transcriptPath`
  was declared inside the attempt body but read from the earlier `aborted` and
  `timedOut` paths, raising `Cannot access 'transcriptPath' before
  initialization` exactly when the real outcome mattered most.
- **`--effort` rejected values agy accepts.** The whitelist was
  `low | medium | high`; agy 1.4.5+ also accepts `xhigh` and `max`. The list is
  now `EFFORT_LEVELS`, and an unrecognized value warns instead of throwing, so a
  future agy release does not require a rebuild.
- **The capability probe could go permanently stale.** It was cached in provider
  memory keyed by nothing; agy updates itself in place. A stale *positive* answer
  is worse than none — the plugin would keep sending flags a new build dropped.

### Changed

- Foreground runs use `--output-format stream-json` when the probe confirms
  support (previously hard-coded to `json`, which returns only the final
  response), and fall back to `json` otherwise.
- `package.json` now lists `PATCH.md`, both READMEs and `LICENSE` in `files`, so
  the published tarball is self-describing.
- The README no longer recommends `model: gemini-3.1-pro-high`, which does not
  exist on current builds. The default stays empty — "let agy choose" is always
  valid.

### Known limitations

- Background runs stay on the DSH jobs path rather than going through
  `startActivation`: an external run handle is a single promise with no streaming
  window, so routing background work through the manager would lose the live
  `job_output` progress. Foreground runs do go through the manager.
- Follow-ups are not separate catalogue children. An external provider is
  execute-once by contract, so `antigravity_followup` continues the same agy
  conversation under the same task key via `--conversation <id>`.
- `--input-format stream-json` (persistent process, multi-turn without a new
  process per turn) is deliberately deferred; one process per turn is the shipped
  model.

[0.2.0-patched.5]: https://github.com/mojingjing-git/dsh-subagent-agy/releases/tag/v0.2.0-patched.5
