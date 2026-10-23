# Changelog

All notable changes to this fork are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Upstream baseline: `@dsh-external/dsh-subagent-antigravity@0.2.0`
([ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy), MIT).

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
