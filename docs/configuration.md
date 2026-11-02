# Configuration

The plugin's full configuration surface. Every field has a default, so a profile
can enable it with nothing specified — [`cordis.patch.yml`](../cordis.patch.yml)
mounts it under its `dsh-subagent-antigravity` id.

Defaults are chosen so the plugin works out of the box for unattended headless
delegation; the ones you may actually want to change are marked below.

## Identity and naming

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `antigravity` | Registry name on `ctx.subagents` |
| `toolName` | `antigravity` | Tool for new tasks **and** resuming by `task` key |
| `followupToolName` | `antigravity_followup` | Alias tool for continuation |
| `tasksToolName` | `antigravity_tasks` | Tool listing running + recent tasks |
| `cancelToolName` | `antigravity_cancel` | Tool stopping a running task |
| `loginToolName` | `antigravity_login` | Tool opening the interactive login window |

Rename the tools only when another plugin already claims one of these names —
the tools cross-reference each other by configured name, so renaming is safe.

## Finding and invoking agy

| Key | Default | Meaning |
|---|---|---|
| `command` | `agy` | Bare name on `PATH` or an absolute path |
| `extraArgs` | `[]` | Extra argv appended after all generated flags |
| `env` | `{}` | Environment overlay, merged after credential scrubbing |
| `cwd` | `''` | Working-directory override; empty uses the delegating session's cwd |
| `addDirs` | `[]` | Extra workspace directories (`--add-dir`, repeatable) |
| `proxy` | `''` | Proxy for the agy child |
| `flagCachePath` | *(default path)* | Where probed flag support is cached; `''` disables it |

When agy cannot be resolved from `PATH`, the plugin also checks the standard
install locations, and honours `AGY_BIN`. See
[agy-integration.md](agy-integration.md#locating-the-binary).

`proxy` falls back to `AGY_PROXY`, then to the first line of
`~/.dsh/agy-proxy.txt` — re-read on every call, so the proxy can be changed
without a restart. It is required in regions Google rejects with
`User location is not supported`.

## Targets outside the session workspace

**Use absolute paths for `addDirs` when the task touches anything outside the
session workspace.** Headless agy cannot answer the interactive "add directory to
workspace?" prompt and will hang until its timeout fires.

## Model and effort

| Key | Default | Meaning |
|---|---|---|
| `model` | `''` | `--model <slug>`; empty omits the flag |
| `effort` | `''` | `--effort` = `low\|medium\|high\|xhigh\|max`; empty omits |
| `agent` | `''` | `--agent <name>`; empty omits |

`model: auto` asks the plugin for the newest Gemini Flash at its highest thinking
level, discovered from `agy models` and cached for a day. Until the first probe
lands — or if it fails — `auto` omits the flag and agy picks its own default.

Per-call `model` / `effort` arguments override these values for a single run.

## Timeouts

| Key | Default | Meaning |
|---|---|---|
| `printTimeoutMs` | 5 min | Foreground ceiling (`--print-timeout`) |
| `foregroundPromoteMs` | 1 min | Hand a still-running foreground call to the jobs runtime; `0` disables |
| `backgroundTimeoutMs` | 1 h | Background ceiling |
| `watchdogMarginMs` | 1 min | Local margin on top of whichever ceiling applies |
| `disposeGraceMs` | 5 s | SIGTERM→SIGKILL escalation grace |

Two independent mechanisms bound every run: agy's own `--print-timeout`, and a
local watchdog that terminates the process tree at *ceiling + margin*. The
watchdog covers the case where agy stalls in a way its own timer does not
interrupt.

### Auto-promote (foreground → background)

A foreground call blocks the turn until agy answers, and the model has no way to
know in advance how long a task will take — so a call it expected to be quick
can hold the session for minutes with nothing on screen.

`foregroundPromoteMs` (default 1 min) bounds that wait. Past the delay the
**still-running process is handed to `ctx.jobs` unchanged** — nothing is
restarted — and the tool returns a job id plus a `note` explaining the move. The
caller gets control back immediately and is woken when the job settles, exactly
like an explicit `background: true` call.

Short runs never reach the delay and behave exactly as before. Set it to `0` to
disable the promotion entirely.

**Long tasks still belong in the background.** The jobs runtime wakes the owning
agent when it settles, so there is no polling cost and `job_kill` can stop it at
any time — hence the much larger default ceiling there.

## Permissions and guard rails

| Key | Default | Meaning |
|---|---|---|
| `skipPermissions` | **`true`** | `--dangerously-skip-permissions` |
| `sandbox` | `false` | `--sandbox` |
| `avoidBrowser` | **`true`** | Append a "do not use browser tools" note to prompts |
| `avoidLargeReads` | **`true`** | Append a "how to inspect large files" note to prompts |

`skipPermissions` is on by default because **headless agy cannot prompt for
approval**, so any real work (file edits, commands) would otherwise be denied.

The two suffix flags are *advisory*: they shape the prompt, not agy's behaviour,
because the plugin cannot intercept agy's internal tool calls. They exist because
headless `browser_*` tools can hang indefinitely and agy's file-read tool fails
above its 4 MB cap. See
[agy-integration.md](agy-integration.md#building-one-run).

## Wire format and evidence

| Key | Default | Meaning |
|---|---|---|
| `outputFormat` | `json` | Wire format for foreground runs: `json` or `text` |
| `transcript` | `true` | Persist each run's raw event stream as NDJSON |
| `transcriptDir` | `''` | Override; empty derives `~/.dsh/agy-transcripts` |

`json` is preferred because it carries the conversation id that makes continuation
possible, and it does not suffer agy's non-TTY stdout drop. If the installed build
rejects the flag — discovered by the one-time probe — the provider falls back to
text mode automatically.

A transcript is the only record of what a delegated task actually did: the
agent's text, every tool call with its parameters, and the final result. Writing
is best-effort; a transcript failure never fails the run.

## Authentication and registry

| Key | Default | Meaning |
|---|---|---|
| `autoLoginWindow` | **`true`** | Pop the login window on an auth failure |
| `loginWindowMinimized` | **`true`** | Start that window minimized |
| `registryPath` | `''` | Override; empty derives `~/.dsh/agy-conversations.json` |

The automatic login window is **Windows only** (it uses PowerShell's
`Start-Process`); elsewhere the error carries manual instructions. A cooldown
prevents one failing loop from opening a storm of windows. See
[security.md](security.md).
