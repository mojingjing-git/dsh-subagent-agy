# Security

What this plugin can do on your behalf, and where the boundaries are.

## The short version

Every delegated task runs **`agy` with `--dangerously-skip-permissions` by
default**, in the delegating session's working directory, as the current user.
Treat a delegation exactly as you would treat running an agent yourself in that
directory.

There is no sandbox on this plugin's side, and no isolation between the caller
and the child. What it offers instead is **honesty**: reports accurately
describe what happened rather than hiding things behind a clean-looking result.

## Permissions

Headless agy cannot display an approval prompt, so it asks permission and gets
silently refused. That is why `skipPermissions` defaults to `true`: without it,
any real work — file edits, shell commands — would be denied.

This has a consequence worth internalising: **a denied action does not surface as
an error.** agy reports `status: SUCCESS` with an empty response. Taking that at
face value would hand the caller a success with nothing in it, so the plugin
classifies it as a failure and explains which action was denied and how to allow
it. See [agy-integration.md](agy-integration.md#settlement-does-not-lie).

To restrict actions, use agy's own mechanisms (`sandbox`, an allowlist) rather
than expecting this plugin to mediate.

## Credentials

**No API key is involved.** agy authenticates with the user's cached Antigravity
login, established by the interactive browser OAuth flow. Nothing in this
repository stores or forwards a secret.

The child process environment is `{...scrubbedParentEnv(), ...config.env}`.
Scrubbing is performed by the shared subprocess seam, not duplicated here, so the
plugin inherits whatever guarantees the host provides. The `env` overlay is
merged **after** scrubbing.

## Trust boundaries

### The panel is its own boundary

DSH's web server routes by path and applies no authentication or CSRF protection
of its own. Every handler behind the sidebar panel can start an agy process. Any
web page the user visits could therefore, in principle, POST to those routes.

The panel therefore refuses requests where:

- `Host` is not a loopback hostname — blocks DNS rebinding, where an attacker's
  hostname resolves to `127.0.0.1`
- `Origin` is cross-site or `null` — blocks browser-borne CSRF

Requests without an `Origin` are allowed, since a browser always attaches one to
a cross-site POST; its absence means no browser is involved. See
[sidebar-panel.md](sidebar-panel.md#trust-boundary).

### Panel-initiated runs cannot be aimed anywhere

The "continue" route refuses to accept a working directory from the caller and
takes it from the plugin's own registry instead. This is what stops the panel
from being a way to run agy against an arbitrary directory — the strongest
guard in this area.

### Path traversal

Conversation ids arrive as data from registries and databases, and several
modules turn them into file paths. All of them are validated against the id
shape agy actually writes (hex and dashes) before being joined onto a data
directory, so `../` cannot escape.

## Data the plugin reads

Files read on your behalf:

| Source | Purpose |
|---|---|
| `~/.gemini/antigravity-cli/conversations/*.db` | Step timeline of past conversations |
| `~/.gemini/antigravity-cli/conversation_summaries.db` | Titles and activity times |
| `~/.gemini/antigravity-cli/brain/**/transcript.jsonl` | Timestamps and per-step token counts |
| `~/.gemini/antigravity/brain/**` | The same, for the Antigravity IDE's own sessions |
| `~/.gemini/antigravity-cli/annotations/*.pbtxt` | Conversation titles |

All of these are opened **read-only**. When agy holds a write lock on a
conversation database, the reader copies it (with its `-wal`/`-shm` sidecars) to a
temp directory and reads the copy, cleaning up afterwards — it never waits on or
contends for agy's lock.

Nothing here leaves the machine.

For what each is used for, see [agy-data-sources.md](agy-data-sources.md).

## Files the plugin writes

Everything is written under the plugin base directory (`$DSH_HOME`, else
`~/.dsh`). See [architecture.md](architecture.md#persistent-state) for the list.

Two properties hold across all of them:

- **Atomic writes.** Content goes to a temp file that is renamed into place, so a
  crash mid-write cannot leave a truncated file.
- **Self-healing reads.** A corrupt registry is backed up once (`*.corrupt`) and
  reset rather than being silently overwritten. Malformed entries are dropped
  with a warning. Task history is never quietly discarded.

Both matter because the registry is the only durable record that makes a
conversation resumable.

## Where the security model is thin

Being explicit beats being reassuring:

- There is **no isolation** between delegating session and child process — same
  user, same filesystem, working directory inherited.
- The **prompt suffixes are advisory.** `avoidBrowser` and `avoidLargeReads` shape
  the prompt; the plugin cannot intercept agy's internal tool calls, so a
  determined prompt can still reach those tools.
- Background runs remain **visible to `job_output`** for anyone able to act as
  the owning agent.
- The auto-login window opens agy **interactively** on auth failure. Disable
  `autoLoginWindow` in headless deployments.
