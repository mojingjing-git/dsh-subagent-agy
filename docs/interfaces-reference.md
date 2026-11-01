# Interfaces Reference

Complete reference for the interfaces this plugin exposes to models, with all
parameters and return values. All tools are declared concurrency-safe. For usage
examples see the [English guide](../README.md) or [中文说明](../README.zh.md).

---

## 1. `antigravity` — delegate a task (primary tool)

The tool description reads, in full:

```
Delegate a self-contained task to Google Antigravity CLI (agy) — a separate Gemini-powered coding agent on this machine, signed in with your Antigravity account (no API key). It works in this workspace but does not see this conversation, so send a complete, standalone prompt (files, paths, acceptance criteria, what to return). Use it to dispatch or hand off work ("派个 agent" / "委托给别的模型"), to get a second model on the same problem, or to run a long job in the background. It returns the final answer plus a `task` key; resume it with `antigravity(task: ...)`. With `background: true` the call returns a jobId and you are notified when it settles — do not poll. This is a tool, not a skill.
```

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `description` | string | For a new task;<br>optional when resuming via `task` | A short (3-5 word) description of the delegated task, for display. |
| `prompt` | string | ✅ **Always required** | The complete, self-contained task content. agy cannot see this conversation, so all file paths, acceptance criteria, and expected return format must be included. Keep it under 30,000 characters. **When resuming, enter the follow-up instruction here — do NOT repeat the original task.** |
| `task` | string | No | Resume a previous task. Pass the `task` key returned by the previous call, or the `[task: ...]` line extracted from the output. Once passed, agy retains the full context of that conversation. |
| `model` | string | No | Override the model for this call only, e.g. `gemini-3.8-flash-high`, `claude-sonnet-4-6`, `gpt-oss-120b-medium`. `auto` = newest Gemini Flash at highest thinking level. Omitted = inherit plugin config. The `--model` flag is emitted only when the resolved model string is non-empty. |
| `effort` | string | No | Override reasoning level for this call only: `low \| medium \| high \| xhigh \| max`. Unrecognized values warn but are still passed through to agy. Omitted = inherit config. |
| `dirs` | array of string | No | Extra absolute paths to add to the agy workspace. **Required for targets outside the session workspace** — headless agy cannot answer the interactive "add directory to workspace?" prompt and would hang until timeout. Maps to repeated `--add-dir` flags. |
| `background` | boolean | No | Run in background: returns a `jobId` immediately; you are notified when it settles. Ceiling uses `backgroundTimeoutMs` (default 1 hour) instead of `printTimeoutMs` (default 5 minutes). |

### Return value

**Foreground mode:**

```ts
{
  kind: 'foreground',
  runId: string,          // same value as task
  task: string,           // task key for resuming
  conversationId?: string, // agy conversation id, included when available
  label?: string,         // human-readable label from the registry
  output: string          // final answer + [agy] summary line
}
```

**Background mode:**

```ts
{
  kind: 'background',
  jobId: string,          // use with job_output / job_kill
  task: string            // task key for resuming after settlement
}
```

> **Why the owner is a session id**: the background job's `owner` field must be
> the **string** session id, never the `Agent` object. The jobs runtime resolves
> ownership through its live-agent registry, so anything else fails to resolve
> and every background run fails. The test harness reproduces this deliberately.

---

## 2. `antigravity_followup` — resume a conversation (alias)

Kept as an alias of `antigravity(task: ...)`. **All three parameters are required.**

| Name | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✅ | A short (3-5 word) description of this follow-up, for display. |
| `task` | string | ✅ | The task key returned by the earlier `antigravity` call. Looked up in the registry to restore `conversationId` and `cwd`. |
| `prompt` | string | ✅ | The follow-up instruction. The child remembers everything it did previously — state only what is new. |

Internally delegates to the same handler as `antigravity`; returns the same foreground/background shape. **Recommended instead: use `antigravity(task: ..., prompt: ...)` directly.**

### Resumption gate

Follow-ups to **the same conversation id** are serialized: a second prompt waits for the first to finish, preventing two processes from interleaving writes into one agy conversation file.

---

## 3. `antigravity_tasks` — list tasks

### Parameters

| Name | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `limit` | number | No | `20` | Max `50` (values above are clamped) |

### Return value

```ts
{
  running: ActiveRunInfo[],  // in-flight runs
  recent: RecentRunInfo[]    // durable history from the registry, newest first
}
```

```ts
interface ActiveRunInfo {
  task: string       // task key
  label: string
  cwd: string
  background: boolean
  startedAt: number  // epoch ms
}
```

- **`running`** comes from `provider.listActive()` — an in-memory window (cap 64 entries).
- **`recent`** comes from `~/.dsh/agy-conversations.json` — survives DSH restarts. Throws when the registry is unreadable (the registry self-heals only at load time).

Task keys look like `<session-id>::agy::<sequence>`, e.g. `0a1b::agy::3`.

---

## 4. `antigravity_cancel` — stop a running task

Terminates by **process tree** via `ctx.subprocess`.

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `task` | string | ✅ | Task key from `antigravity_tasks` (either `running` or `recent` list). |

### Return value

```ts
{
  cancelled: boolean,  // true only if a live run was actually stopped
  task: string,        // echoed task key
  message: string      // human-readable result
}
```

### Termination semantics

1. Sends `SIGTERM` to the whole process tree.
2. After `disposeGraceMs` (default 5 s), escalates to `SIGKILL`.
3. After termination, `waitForExit()` races the grace period to reap zombies.

> **Windows note**: a killed child reports only exit code 1 with no signal marker.
> The plugin therefore tracks an explicit `cancelledByRequest` flag to distinguish
> user cancellation from a genuine failure.

The final `[task: ...]` line is still appended after cancellation, so the
conversation remains resumable. Active runs are also terminated automatically on
plugin dispose.

---

## 5. `antigravity_login` — open the login window

No parameters. Returns `{ message: string }`.

Opens a new console window running interactive `agy` to start the Google sign-in flow so the user can authenticate on the spot. Also triggered **automatically** on an authentication failure (when `autoLoginWindow` is enabled, with a 15-second cooldown).

### Cross-platform behavior

The launcher uses PowerShell's `Start-Process` and is implemented for **Windows
only**. It respects `loginWindowMinimized` (default `true` → minimized to
taskbar).

On every other platform the tool returns a message asking the user to open a
terminal and run `agy` themselves — no window is opened.

An automatic launch also happens on an authentication failure when
`autoLoginWindow` is enabled, subject to a cooldown so one failure cannot open a
flood of windows.

---

## Tool declaration registry

```ts
export const inject = ['subagents', 'subprocess', 'tools']
```

All five tools are registered in `apply()` (src/index.ts:2552 onward) via `ctx.tools.register(defineTool({...}))`. Example effective names when configured:

| Tool | Default name |
|---|---|
| `antigravity` | `antigravity` |
| `antigravity_followup` | `antigravity_followup` |
| `antigravity_tasks` | `antigravity_tasks` |
| `antigravity_cancel` | `antigravity_cancel` |
| `antigravity_login` | `antigravity_login` |

> Every tool result declares `additionalProperties: false` in its output schema. **A field added to a result without a matching declaration is silently dropped by the DSH harness**, and the entire tool call fails. When extending any return value, the schema must be extended in the same change (`schema/every-tool-result-satisfies-its-schema` guards this).

---

## Foreground vs background comparison

| | Foreground | Background |
|---|---|---|
| Wire protocol | JSON, or stream-JSON when the probe confirmed support | stream-JSON when the probe confirmed support, else JSON |
| Returns | Final answer text | `jobId` (inspect with `job_output`) |
| Cancellation | Abort signal | `job_kill` / `antigravity_cancel` |
| Local watchdog | `printTimeoutMs` + `watchdogMarginMs` | `backgroundTimeoutMs` + `watchdogMarginMs` |
| Peeking progress | Not available | `job_output` returns incremental output |
| Settlement | Result never rejects | Job settles and wakes the owner agent |

---

## See also

- README.md / README.zh.md — usage guide for these tools
- architecture.md — module responsibilities
- sidebar-panel.md — panel HTTP routes
