# Architecture

The plugin is one Cordis service (`src/index.ts`) plus a set of small modules,
each owning exactly one external data source or one concern. It has three
halves that meet only through injected dependencies:

```
        model-facing tools              agy CLI (child process)
                │                              │
        src/index.ts  ─────────────────────────┘
        (provider + tools + persistence)
                │
                ├── src/agy-panel.ts ── HTTP /api-agy/* ── src/client.js ── sidebar
                │        │
                │        └── data-source modules (read agy's own disk state)
                └── persistence (task registry, transcripts, caches)
```

## 1. The provider

`AntigravitySubagentProvider` is the only stateful object. It is registered on
`ctx.subagents` under `providerName` and owns:

- **Process spawning** — building argv, env, and cwd for one agy run
  (`spawnPlan`), and executing it in the foreground or background.
- **Capability probing** — what the *installed* agy binary supports, cached by
  binary identity. See [agy-integration.md](agy-integration.md#capability-probing).
- **Task bookkeeping** — an in-memory window of recent runs plus a durable
  registry so a conversation can be resumed after DSH restarts.
- **Serialization** — one gate per conversation id, so two concurrent prompts
  cannot interleave writes into the same agy conversation.

`apply()` registers the provider, warms the model catalogue without blocking
startup, arranges for active runs to be terminated on dispose, mounts the panel
routes, and registers the five tools.

### Foreground vs background

| | Foreground | Background |
|---|---|---|
| Wire format | `json` (or `stream-json` when probed) | `stream-json` when supported |
| Returns | final text | a `ctx.jobs` job id |
| Cancellation | caller abort signal | `job_kill` / `antigravity_cancel` |
| Settlement | `result` never rejects | the job settles and wakes its owner |

Background runs are registered with the generic jobs runtime. The job's `owner`
**must** be the calling session's id string, not the session object — the jobs
runtime resolves the owner through `agents.get(sessionId)`. This constraint is
reproduced in the test harness so it cannot regress silently.

The owning agent is woken when the job settles; background work needs no polling.

## 2. Persistence

All writes are atomic (temp file + rename) and most go through a serialized
queue, because several concurrent runs write to the same files.

| File | Contents |
|---|---|
| `~/.dsh/agy-conversations.json` | Task registry: task key → conversation id, cwd, model, label |
| `~/.dsh/agy-transcripts/<task>.ndjson` | Raw agy event stream of one run, plus `index.json` |
| `~/.dsh/agy-flag-cache.json` | Probed CLI capabilities, keyed by binary identity |
| `~/.dsh/agy-models.json` | Model catalogue for `model: auto` |
| `~/.dsh/agy-usage-cache.json`, `agy-token-cache.json`, `agy-quota-log.jsonl` | Panel caches and the quota time series |
| `~/.dsh/agy-panel.json` | Panel preferences (hidden conversations) |

`pluginBaseDir()` resolves to `$DSH_HOME` when set, otherwise `~/.dsh`.

The registry self-heals: a corrupt file is backed up once as `*.corrupt` and
reset rather than silently overwritten, and malformed entries are dropped with a
warning instead of taking the whole registry down.

## 3. The panel

Two independent halves that share nothing but the HTTP contract:

- **Host half** (`src/agy-panel.ts`) — nine JSON routes over the plugin's own
  data, plus a `RunStore` that owns the single consumer of each run's output
  cursor. It is handed every read/write it needs through `AgyPanelDeps`, so it
  never reaches back into the provider.
- **Client half** (`src/client.js`) — hand-written React, evaluated by DSH's web
  loader as a classic script. It polls the routes; there is no SSE.

See [sidebar-panel.md](sidebar-panel.md).

## 4. Data-source modules

Each reads one artifact agy itself writes to disk, and none of them depend on
the provider. See [agy-data-sources.md](agy-data-sources.md).

| Module | Reads |
|---|---|
| `agy-conversations.ts` | The plugin's own registry + agy's conversation database and annotations |
| `agy-summaries.ts` | `conversation_summaries.db` |
| `agy-history.ts` | One conversation database + its transcript, fused into a step timeline |
| `agy-transcript.ts` | `transcript.jsonl` (timestamps and token counters) |
| `agy-steps.ts` | Live `step_update` events from a running process (pure model, no I/O) |
| `agy-usage.ts` | `agy --print "/usage"` (quota) |
| `agy-usage-log.ts` | Token spend across *both* agy brain directories |
| `agy-quota-log.ts` | The recorded quota time series, to convert percentages into tokens |
| `agy-models.ts` | `agy models` (model catalogue) |

## 5. Compatibility shims and type seams

Two pieces exist purely because of the shape of the DSH seam:

- `resolveChildCwd` / `validateConfiguredCwd` are local reimplementations of path
  policies the plugin needs. They are pure functions over their inputs.
- `src/peers.d.ts` supplies ambient declarations for installs where the
  `@deepseek-ai/*` peers ship no usable `.d.ts`. The build picks whether to
  include it by probing; see [development.md](development.md#why-two-tsconfigs).

## 6. Lifecycle

```
apply()
  ├─ validate numeric config
  ├─ register provider on ctx.subagents
  ├─ warm model catalogue (not awaited)
  ├─ register dispose effect → terminate all active runs
  ├─ register panel routes (requires webServer; warns and skips when absent)
  └─ register the five tools
```

Nothing in `apply()` blocks on the network or on agy. A failing optional piece
(missing `ctx.inject`, duplicate route) warns and lets the rest come up — only
the tools themselves are mandatory.
