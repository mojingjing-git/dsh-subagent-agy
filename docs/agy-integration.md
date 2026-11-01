# agy Integration

How the plugin drives the local `agy` binary. Everything here belongs to
`src/index.ts`; the other modules only read artifacts agy leaves on disk (see
[agy-data-sources.md](agy-data-sources.md)).

## Locating the binary

`resolveCommandPath` tries the shared subprocess service first, then falls back
to well-known install locations in order:

1. `$AGY_BIN` (or the resolved `command` when it is absolute)
2. `%LOCALAPPDATA%\agy\bin` (Windows installer puts it there, often off `PATH`)
3. `~/.local/bin`
4. `~/.gemini/bin`
5. `~/go/bin`

Set `AGY_BIN` when agy lives anywhere else.

## Capability probing

agy's flag set varies by version, and passing a flag a build does not define
makes the process exit immediately. The provider therefore probes once per
instance and caches the answer.

Two probes run:

- **`agy help`** reveals whether the build knows `--output-format`,
  `--conversation`, `--sandbox`, `--add-dir`, `--prompt-file`, `stream-json`.
  The exit code is unreliable (`--help` itself is an unrecognised flag on some
  builds), so the usage dump is parsed regardless of how the process exited.
- **`--print-timeout` syntax** is discovered by trying both candidate forms.
  Current builds parse durations with Go's `time.ParseDuration` and reject a
  bare millisecond count with `missing unit in duration`; older builds accept it.

**The cache key is the binary's identity** (`path@size:mtime`), not the plugin
version. agy updates itself in place; an answer recorded yesterday about a build
that has since been replaced would let the plugin emit a flag the new binary
rejects, failing at spawn time — strictly worse than assuming no support. To
force a re-probe, delete `~/.dsh/agy-flag-cache.json` (or set `flagCachePath`
to `''` to disable caching).

When a probe cannot run at all (agy absent, help unparseable) the provider
assumes the standard flags exist and never invents `--prompt-file`.

## Building one run

`spawnPlan` produces argv, env, and cwd once; both executors consume the result.

**argv** is assembled in a fixed order:

```
<exe>  -p <prompt> | --prompt-file <tmp>
       --print-timeout <n ms|<n>>
       [--model <slug>]  [--effort <level>]  [--agent <name>]
       [--dangerously-skip-permissions]  [--sandbox]
       [--add-dir <dir>]...  [--conversation <id>]
       <extraArgs...>
```

A flag is emitted only when it is non-empty *and*, where relevant, the probe
confirmed support. `--conversation` is appended for a resumed run, which is the
mechanism behind continuation.

**Prompt transport.** Windows `CreateProcess` caps the whole command line near
32 767 characters. A prompt above 30 000 characters is written to a temp file
and passed via `--prompt-file` when the build supports it; otherwise the run is
refused with actionable guidance rather than silently truncated. The temp file
is always released. **Overriding `-p` entirely:** writing the prompt to a file
under the *session workspace* and referencing it from a short prompt also works
and is more portable across agy versions.

**Guidance suffixes.** Two config flags append an environment note to every
prompt, because agy's own behaviour cannot be intercepted from outside:

- `avoidBrowser` — headless `browser_*` tools can hang indefinitely, freezing
  the whole run with no output. Default on.
- `avoidLargeReads` — agy's file-read tool fails above its 4 MB cap. Directs agy
  to use grep/sed/python instead. Default on.

These are advisory; the plugin cannot intercept agy's internal tool calls.

**Environment.** `{...scrubbedParentEnv(), ...config.env}` plus proxy variables
(upper- and lower-case `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and `NO_PROXY`).
Credential scrubbing is the subprocess seam's job, not the plugin's. A proxy is
required in regions Google rejects with `User location is not supported`; it can
come from `proxy`, `AGY_PROXY`, or the first line of `~/.dsh/agy-proxy.txt`
(re-read every call, so it can be changed without a restart).

**Working directory** resolves from an explicit override, else the delegating
session's cwd, else the plugin's own process cwd.

## Wire formats and settlement

Two output formats are used, both chosen from probe results:

- **`json`** — replies carry `conversation_id`, `status`, `response`,
  `denied_actions`, `usage`. This is why `json` is the default for foreground
  runs: it is the only reliable way to obtain the conversation id, and it does
  not suffer agy's non-TTY stdout drop.
- **`stream-json`** — NDJSON events (`init`, `step_update`, `result`). Used for
  background runs so incremental text and tool activity can be surfaced while
  the agent works.

`resolveStreamMode` is the single authority for which to use: **stream only when
the probe explicitly confirmed support**. One installed build must get one
protocol regardless of which executor picked it up.

`tryParseJsonOutput` handles both shapes. In stream-json the result is nested
one level deeper (`{"event":"result","result":{...}}`), so a naive line scan
would return the `init` event — which has no `status` — and report a run as
successfully finished when it was not. The `result` event is located first.

### Settlement does not lie

This is the most important rule in the integration. Headless agy cannot show a
permission prompt, so **a denied action surfaces as `status: SUCCESS` with an
empty response**. Taking that at face value would hand the caller a clean-looking
success with nothing in it.

The provider therefore treats **`SUCCESS` with no answer text as a failure** and
explains why: which action was denied, how to allow it, and where the raw stream
is (`explainEmptyResult`). This applies even when tool steps ran — the caller
still has no conclusion to act on. The step summary travels with the error so
the caller can see what the child actually did.

Successful runs get a compact one-line footer (`formatRunSummary`):

```
[agy] 7 steps · 2m 14s · 12.3k in / 1.1k out · 2 files changed: src/a.ts, src/b.ts
```

The changed-file list is derived from agy's own write-tool steps against an
explicit tool-name allowlist — not from git, so it works in a dirty worktree.

## Prompts are self-contained

A child process sees none of the delegating conversation. Prompts must carry the
files, paths, acceptance criteria, and the expected return shape.

## Authentication

No API key exists for this path. agy authenticates through the user's cached
Antigravity login, established by the interactive browser OAuth flow.

When a run fails with an authentication error and `autoLoginWindow` is enabled,
the plugin launches agy's interactive login window once (subject to a cooldown)
and says so in the error detail. The launcher uses PowerShell `Start-Process` and
is implemented for Windows only; elsewhere it tells the user to open a terminal
and run `agy`.

## Failure handling summary

| Situation | Result |
|---|---|
| `SUCCESS` with empty response | `error`, explained by `explainEmptyResult` |
| Exit 0 with no stdout (plain-text mode) | `error` naming the known non-TTY drop bug |
| Exit 0, unparseable stdout | `error` with exit code or stderr |
| Runner exceeded ceiling + margin | `error`; the local watchdog killed the tree |
| Cancelled | `aborted`, with whatever partial output there was |
| Unknown `--output-format` on an unprobed build | one retry in text mode, then `error` |

`result` never rejects: settlement always produces a result object.
