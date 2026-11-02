# @mojingjing-git/dsh-subagent-antigravity

[![ci](https://github.com/mojingjing-git/dsh-subagent-agy/actions/workflows/ci.yml/badge.svg)](https://github.com/mojingjing-git/dsh-subagent-agy/actions/workflows/ci.yml)

Delegate tasks to **Google Antigravity CLI (`agy`)** — a separate
Gemini-powered coding agent on your machine — straight from DeepSeekRuntime.
**No Gemini API key is involved**: agy authenticates through your Antigravity
login (system keyring / Google Sign-In).

> 中文版见 [README.zh.md](README.zh.md) · Source: [github.com/mojingjing-git/dsh-subagent-agy](https://github.com/mojingjing-git/dsh-subagent-agy)
>
> **This is a fork.** Upstream is [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy)
> by ZEM17 (`@dsh-external/dsh-subagent-antigravity@0.2.0`, MIT). This fork adds
> DSH 0.2.1 compatibility, per-run transcripts, current agy support, the sidebar
> panel, and the test suites described below. The mount id is unchanged, so this
> is a drop-in replacement for upstream.

Maintenance documentation lives in [docs/](docs/README.md).

---

## Installation

### Requirements

1. **`agy` installed**: `irm https://antigravity.google/cli/install.ps1 | iex`
   (Windows). The plugin locates it automatically (PATH → `AGY_BIN` →
   `%LOCALAPPDATA%\agy\bin` → `~/.local/bin` → `~/.gemini/bin` → `~/go/bin`).
2. **`agy` logged in once**: run `agy` in a terminal and complete the
   sign-in. If a run hits "authentication required", the plugin pops the
   interactive login window automatically.
3. **DeepSeekRuntime** with the standard web profile (it ships
   `dsh-subagent`, `dsh-subprocess`, `dsh-tools`, `dsh-jobs`).

### Install the plugin

**From GitHub** (recommended):

```bash
dsh plugin --profile web add github:mojingjing-git/dsh-subagent-agy
```

**From a tarball**: download a
`dsh-external-dsh-subagent-antigravity-<version>.tgz` from the
[releases page](https://github.com/mojingjing-git/dsh-subagent-agy/releases), then:

```bash
dsh plugin --profile web add /path/to/dsh-external-dsh-subagent-antigravity-<version>.tgz
```

Substitute the version you downloaded — see
[`package.json`](package.json) for the current one.

The tools work right away — the model in any session can use the `antigravity`
series. **The sidebar panel is a web-client extension and needs one DSH
restart**; upgrading the package needs the same restart, because the old client
bundle is already loaded in the open page.

---

## Usage

The model calls the tools automatically when you ask for it; you can also
prompt it explicitly:

| Surface | Name | What it does |
|---|---|---|
| task / follow-up | `antigravity` | pass `prompt` for a fresh conversation, or `task` to continue one (full context carries over); both work with `background: true` |
| follow-up (foreground) | `antigravity_followup` | foreground-only shortcut for `antigravity({ task, prompt })`; use the latter for `background` / `model` / `effort` / `dirs` |
| list | `antigravity_tasks` | list running tasks + recent finished tasks; `task` keys survive DSH restarts |
| cancel | `antigravity_cancel` | stop a running task by its `task` key (agy process tree terminated) |
| login | `antigravity_login` | pop the interactive agy login window (also opens automatically on auth failures) |

Any call may also override `model` (e.g. `claude-sonnet-4-6`) and `effort`
(`low` / `medium` / `high` / `xhigh` / `max`) for that run only, without
touching the global configuration.

Example prompts:

> "Use agy to rewrite the README of `D:\projects\my-project` and list the changes."
>
> "Let antigravity rework this project's landing page — use claude-sonnet-4-6 at max effort."
>
> "用 antigravity 优化这个项目的页面" *(in a Chinese session)*

### Image analysis

agy's model is multimodal — put an image path in the prompt and it will
describe or analyze the image:

> "Use agy to describe this image: `C:\projects\design\mockup.png`"
>
> "用 antigravity 识别这张图片：`C:\projects\screenshots\ui.png`"

Images inside the session workspace work directly; images elsewhere need the
directory in the tool's `dirs` parameter (or the `addDirs` config).

- Tasks targeting files **outside** the session workspace need the target
  directory: the tool takes a `dirs` parameter (the model passes it when you
  give it the path).
- **Long tasks**: the model uses `background: true` for long jobs — it keeps
  you posted on live progress and reports the final result when done.
- **Continue a task**: tell the model to continue using the `task` key from a
  previous call.
- **Find a task again**: `antigravity_tasks` lists running and recent
  finished tasks — task keys are recorded in
  `~/.dsh/agy-conversations.json` and survive DSH restarts, so a key can
  always be recovered for follow-up.
- **Stop a task**: `antigravity_cancel` with the running task's key stops it
  (also possible via `job_kill` for background jobs).

### Sidebar panel

The sidebar footer carries an **Antigravity Manager** button: `●N` is the number of running jobs
and the percentage is the five-hour quota left for the **model family of the
configured model** (hover for the reset time). Clicking it opens the
**Antigravity Manager** tab in the right sidebar:

- **Four quota cards**, taken straight from `agy --print "/usage"`: Gemini
  Models / Claude and GPT models × five-hour / weekly, each with its reset time.
  One probe takes ~10 seconds, so the result is cached briefly
  (single-flight — many open panes still spawn one agy); the card's refresh
  button forces a new probe, and the cards say **when** the numbers were read —
  the probe is slow, and stale numbers should be obvious at a glance.
- **Token spend card**, for estimating what a Pro plan actually gives you: it
  adds up every agy conversation on the machine, not just the ones this plugin
  ran — the Antigravity IDE's store
  (`~/.gemini/antigravity/brain`) spends the same account quota, and leaving it
  out under-counts a normal day by roughly 4x. The headline is the **total
  including cache reads**, broken down into input / output / cache on the next
  line, with seven daily bars below it (rolling window, bucketed by local
  calendar day, zero-filled) and a **local all-time total** with its start date
  at the bottom.
  On the numbers: transcript counters are **per-step increments** (input climbs,
  then drops to a few thousand with the rest recorded as cache reads once the
  prefix is cached), so summing is correct; cache reads are billed at a
  discount but are most of the volume, so they count towards the total and are
  listed separately. The history on disk is bounded by agy's own retention,
  so the all-time line is "what is readable locally", not the
  account's lifetime. The scan is read-only with an (mtime, size) index: a cold
  150-conversation scan takes a few hundred ms, later refreshes only read new
  files.
- **Conversation list**: only conversations **this plugin** ran
  (`~/.dsh/agy-conversations.json`), with title, time, working directory, model
  and run state.
- **Continue**: click "接着跑" on a row, type the next instruction inline and
  send. Output appears in a **separate area at the bottom of the panel** (it does
  not squeeze the list) and streams token by token; stop it at any time.
  Continuations of one conversation are serialised, so two instructions never
  land in the same agy conversation at once.
- **Step timeline**: opening a conversation shows **what the model actually did**
  above the list — who said what, which tool ran with which arguments, which step
  failed. The timeline comes from agy's own
  `~/.gemini/antigravity-cli/conversations/<id>.db`, so **finished**
  conversations show their steps too, not only the running ones. agy does not
  keep the reply body for every conversation: tool calls and prompts are always
  there, reply bodies only for some of them, and the timeline says so instead
  of showing an empty bubble.
- **Time and tokens per step**: every step shows the **time it happened** on the
  left and the **tokens it cost** (in / out) on the right; the top of the
  timeline carries the **totals** for the conversation. Time comes from agy's
  own transcript
  (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`),
  because the database's step table has no time column — a conversation without
  a transcript shows its steps without times or tokens rather than fake zeros.
  A conversation agy ran more than once keeps every run in the transcript and
  restarts its step numbers for each of them, so each step carries the run it
  belongs to and the timeline draws a **divider labelled with the run** where a
  new one starts — the third step of two different runs never becomes one step.

The panel reads the local registry, so past conversations remain resumable after
a DSH restart; when agy is missing or logged out the quota area shows an empty
state instead of an error.

---

## Configuration

All fields are optional; the defaults below are what the plugin ships with.
Configure through the plugin's settings section (e.g. `$DSH_HOME/settings.yaml`):

```yaml
dsh-subagent-antigravity:
  model: auto                  # auto = newest Gemini Flash, highest thinking level; empty = agy default
  effort: high                 # low | medium | high | xhigh | max
  printTimeoutMs: 300000       # foreground ceiling (5 min)
  backgroundTimeoutMs: 3600000 # background ceiling (1 h)
  skipPermissions: true        # auto-approve agy tool calls (headless needs it)
  addDirs: []                  # absolute dirs added to the agy workspace (--add-dir)
  proxy: ""                    # proxy URL; falls back to AGY_PROXY, then ~/.dsh/agy-proxy.txt
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `antigravity` | registry name on `ctx.subagents` |
| `toolName` | `antigravity` | new-task tool name |
| `followupToolName` | `antigravity_followup` | follow-up tool name |
| `loginToolName` | `antigravity_login` | login-window tool name |
| `tasksToolName` | `antigravity_tasks` | tasks-listing tool name |
| `cancelToolName` | `antigravity_cancel` | cancel-running-task tool name |
| `command` | `agy` | executable (PATH name or absolute path) |
| `model` | `''` | `--model <slug>` (see `agy models`); `auto` = probe `agy models` and take the newest Gemini Flash at its highest thinking level (24 h cache); empty = agy default |
| `effort` | `''` | `--effort low\|medium\|high\|xhigh\|max`; empty = omit |
| `agent` | `''` | `--agent <name>`; empty = omit |
| `printTimeoutMs` | `300000` | foreground run ceiling (`--print-timeout`; the plugin probes whether this build wants a unit) |
| `backgroundTimeoutMs` | `3600000` | background run ceiling (1 h) |
| `watchdogMarginMs` | `60000` | force-kill margin after the ceiling if agy hangs |
| `skipPermissions` | `true` | `--dangerously-skip-permissions` (auto-approve agy tool calls) |
| `sandbox` | `false` | `--sandbox` (agy terminal-sandbox restrictions) |
| `avoidBrowser` | `true` | append a note telling agy NOT to use headless browser tools (they can hang on some machines) |
| `avoidLargeReads` | `true` | append a note telling agy to inspect files > 1 MB via grep/sed instead of its read tool (4 MB cap) |
| `transcript` | `true` | write each run's full agy event stream (prompt + every tool call + final result) under `transcriptDir` |
| `transcriptDir` | `''` | transcript directory; empty = `~/.dsh/agy-transcripts` |
| `flagCachePath` | `''` | where probed `agy help` support is cached; unset = `~/.dsh/agy-flag-cache.json`, an explicit empty string disables caching |
| `outputFormat` | `json` | wire format (`json` or `text`); background prefers `stream-json` automatically |
| `extraArgs` | `[]` | raw extra argv appended after generated flags |
| `cwd` | `''` | working-directory override; empty = the session workspace |
| `addDirs` | `[]` | absolute dirs added to the agy workspace (`--add-dir`) — required for targets outside the session workspace |
| `env` | `{}` | environment overlay merged after the harness credential scrub |
| `proxy` | `''` | proxy URL; falls back to `AGY_PROXY` env, then `~/.dsh/agy-proxy.txt` (re-read per call) |
| `registryPath` | `''` | follow-up registry file; empty = `~/.dsh/agy-conversations.json` |
| `disposeGraceMs` | `5000` | tree-termination grace (SIGTERM → SIGKILL) |
| `autoLoginWindow` | `true` | on auth failure, pop the interactive login window automatically |
| `loginWindowMinimized` | `true` | launch the login window minimized (taskbar icon only) |

Every field is described in [docs/configuration.md](docs/configuration.md).

---

## How it works (short version)

Each task spawns a fresh `agy -p <task>` process in the session workspace
and returns the final answer. Runs use `--output-format json`, whose reply
carries agy's `conversation_id`; the plugin records it in a durable registry
(`~/.dsh/agy-conversations.json`), and `antigravity({ task })` resumes the
same conversation via `--conversation <id>`. Background runs use
`stream-json` for live progress and register with DSH's jobs system
(`job_output` / `job_kill`). The job's owner is the calling session, so a
settled job **wakes** it — the model is told not to poll. A local watchdog terminates hung runs, and all
timeouts interrupt: nothing ever waits forever.

### Settlement does not lie

In headless mode agy cannot show its permission prompt, so a **denied action
still ends in `status: SUCCESS` with an empty answer**. The plugin treats
"SUCCESS with no text" as a failure and says which action was denied and how
to allow it (`skipPermissions` or an allowlist), instead of returning an empty
bubble. Successful runs end with a delivery summary:

```
[agy] 7 steps · 2m 14s · 12.3k in / 1.1k out · 2 files changed: src/a.ts, src/b.ts
```

The file list comes from the write-style tool calls agy reports
(`write_to_file` / `replace_file_content` / `multi_replace_file_content` /
`sed_file`, …), so it does not depend on a clean git worktree.

`antigravity_tasks` surfaces the durable registry (restart-safe) plus live
in-flight runs, and `antigravity_cancel` stops a running one. The registry
self-heals: a corrupted file is backed up once (`*.corrupt`) and reset
instead of being silently overwritten, and all registry writes are
serialized, so concurrent runs never lose each other's records.

The sidebar panel is two halves: the host registers `/api-agy/*` JSON routes
(usage, tokens, conversations, running, history, continue, run, cancel, prefs),
and the client is a separate `lib/client.js` declared through
`exports["./client"]`. "Continue" reuses the background pipeline:
`--output-format stream-json` events are parsed once on the host and the pane
polls a cursor, so closing the panel or reloading the page loses no output — the
agy process keeps running on the host either way.

Details: [docs/architecture.md](docs/architecture.md) ·
[docs/agy-integration.md](docs/agy-integration.md) ·
[docs/sidebar-panel.md](docs/sidebar-panel.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `authentication required` | complete the sign-in in the popped login window (or call `antigravity_login`), then retry |
| `User location is not supported` | set a proxy (`proxy` config or `~/.dsh/agy-proxy.txt`) |
| `SUCCESS but produced no answer` / `produced no answer text` | agy claimed success without a word: usually an action was blocked by headless permissions (see `denied_actions` in the message). Enable `skipPermissions` or allowlist it and retry; the attached `[agy] N steps …` line shows what it actually did |
| `timeout waiting for response` | raise `printTimeoutMs` / `backgroundTimeoutMs`, or use `background: true` |
| `agy exited 0 but produced no stdout` | known agy non-TTY bug; `--output-format json` avoids it (default) — upgrade agy if it persists |
| `cannot resolve "agy"` | set `AGY_BIN` to the agy executable |
| task hangs on a browser tool | `avoidBrowser` (default on) prevents it; set `false` only when a browser preview is genuinely needed |
| `file size (…) exceeds limit` | agy's read tool caps at 4 MB; `avoidLargeReads` (default on) tells agy to use grep/sed instead — or slim the file |
| registry corrupted | the plugin backs the damaged file up once to `*.corrupt` and restarts the registry fresh — history is never silently overwritten |
| no **Antigravity Manager** button in the sidebar | client extensions load at startup: restart DSH; if it persists check the installed package contains `lib/client.js` |
| quota stuck on "reading" | the first `agy /usage` probe takes ~10 s; past 30 s check that `agy` runs and is logged in |
| conversation list is empty | it only lists runs of this plugin — run one `antigravity` task first (registry: `~/.dsh/agy-conversations.json`) |

---

## Development

```bash
npm run build        # tsc src/ → lib/, then copy and verify the client bundle
npm test             # offline suite against a simulated agy
npm run test:panel   # panel suites: data sources, host routes, streaming, client contract
npm run test:e2e     # live round trip and follow-up (needs an agy login)
npm run pack         # tarball for `dsh plugin add`
```

See [docs/development.md](docs/development.md) for what each one covers and why
the packaging is deterministic. Each suite prints its own tally.

Dev workflow on a local DSH (super-injector): `dev_build_plugin` (build +
pack) → `dev_inject_plugin` (runtime injection, no restart); iterate with
`dev_build_plugin` → `dev_reload_package`.
