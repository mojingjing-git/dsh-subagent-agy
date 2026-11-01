# Sidebar Panel

A management view for delegated agy work: quota, token spend, the conversation
list, and a live step timeline. It has two halves that share nothing but the
HTTP contract described here.

```
src/client.js  ──POST /api-agy/*──>  src/agy-panel.ts  ──> provider + data sources
 (hand-written React)                 (routes + RunStore)
```

## Why every route is POST + JSON

`webServer.register` accepts only `exact` or `prefix` routes — no `:param`
segments, no method-specific helpers. All nine routes therefore take their input
from a JSON request body over POST.

## Trust boundary

The host web server matches routes by path and applies **no authentication, no
Origin check, and no CSRF token of its own**. Every handler behind this panel can
start an agy process with `--dangerously-skip-permissions`. The panel is its own
trust boundary:

| Check | Refusal |
|---|---|
| Non-POST method | 405 |
| `Host` not a loopback hostname (DNS rebinding) | 403 |
| `Origin` cross-site or `null` (browser-borne CSRF) | 403 |
| `content-type` not `application/json` | 415 |
| Body larger than 1 MB | 413-class error |

A request with **no** `Origin` is allowed: a browser always attaches `Origin` to
a cross-site POST, so its absence means no browser is involved. Nothing about the
port is hardcoded — whatever the request carries is what is validated against.

See [security.md](security.md) for the wider picture.

## Routes

| Route | Input | Purpose |
|---|---|---|
| `/usage` | `{force?}` | Quota rows (Gemini / Claude+GPT × 5-hour / weekly) |
| `/token-usage` | — | Rolling token totals plus a quota conversion estimate |
| `/conversations` | — | The conversation list, newest activity first |
| `/running` | — | Currently active runs |
| `/history` | `{conversationId}` | Step timeline of a finished conversation |
| `/continue` | `{conversationId, prompt}` | Start a resumed run; returns `{runId}` |
| `/run` | `{runId, since}` | Incremental output and current status |
| `/cancel` | `{runId}` | Stop a running panel-initiated run |
| `/prefs` | `{hide?, show?}` | Hide/unhide a conversation from the list |

All responses are `{ok: true, …}` or `{ok: false, error}` with
`cache-control: no-store`.

`/continue` refuses to start a second run for a conversation that already has one
(409), rejects an empty or over-long prompt, requires the conversation to be one
this plugin started, and refuses when the recorded project directory no longer
exists.

### Streaming is buffered server-side

There is no SSE. `readOutput()` on a run handle is a **destructive cursor** — one
consumer only — so a second reader would steal text from the first. The store
owns exactly one reader per run: a 250 ms timer that drains the handle into the
run's buffer. The client then polls `{runId, since}` against that buffer, so
multiple panes, reconnects, and re-renders cannot interfere with each other.

Two details make this robust:

- **Text:** the client sends its cursor and receives only the slice after it, or
  the whole buffer when `reset` is true.
- **Steps:** they are *updated data*, not an append-only stream — the same step
  arrives again when it advances from active to done. They therefore travel as a
  whole list with a `stepsVersion` fingerprint; the client replaces the list when
  the version changes rather than trying to delta it.

The buffer is capped (400 KB). When it overflows, the store flags `resetPending`,
because the client's cursor would otherwise point at dropped text forever and the
run would look frozen.

## Panel-initiated runs

A sidebar click has no model-facing tool call to hang a request off, so the route
synthesises the minimal parent and relies on the registry for the real cwd. The
caller **cannot** supply a cwd, which is what keeps this from being a way to run
agy in an arbitrary directory. The resume flag is appended to the plan here
because the background argv is otherwise the plan verbatim.

## The client

Hand-written plain JS in the shape DSH's web loader expects
(`window.__ModuleLoader__.load({id, factory})`, React obtained via `require`). It
is *not* compiled — the build copies it verbatim.

It declares a tab type and injects two components through `ctx.slots`:

- `sidebar.footer.action` — a button showing the running count and quota badge
- `sidebar.right.pane.tab` — the panel itself, keyed by the tab type

Injection matters: a bare `slots.register` races the shell's own slot declaration
and can leave the renderer blank. The panel is deliberately opened only from its
footer button.

The client polls each route on its own cadence (conversations 20 s, quota 30 s,
tokens 60 s, running 5 s, active run 400 ms). All intervals are cleared on
unmount. The client bundle must survive being evaluated as a classic script, with
no CommonJS globals — see [development.md](development.md#the-client-load-guard).
