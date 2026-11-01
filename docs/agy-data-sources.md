# agy Data Sources

Everything the sidebar shows beyond live runs is read back from **agy's own
storage**. This plugin owns none of these formats — it reverse-engineers them, so
every reader has to survive agy changing underneath it.

Nothing here is ever written to. All reads go through validation described in
[security.md](security.md#path-traversal).

```
~/.gemini/antigravity-cli/          ← the agy CLI's own home
  conversations/<id>.db             SQLite; every step as protobuf blobs
  conversation_summaries.db         SQLite; titles and activity times
  annotations/<id>.pbtxt            Conversation titles
  brain/<id>/.system_generated/logs/transcript.jsonl   timestamps + tokens
~/.gemini/antigravity/              ← the Antigravity IDE's home
  brain/<id>/.../transcript.jsonl   the same format, different sessions
```

| Module | Reads | Produces |
|---|---|---|
| `agy-history` | `conversations/<id>.db` + transcript | Step timeline of a finished conversation |
| `agy-transcript` | `transcript.jsonl` | Steps with timestamps and token usage |
| `agy-usage-log` | **both** brain trees | Machine-wide token totals |
| `agy-summaries` | `conversation_summaries.db` | Titles, previews, activity times |
| `agy-conversations` | this plugin's registry + the above | The panel's conversation list |
| `agy-usage` | `agy --print "/usage"` (subprocess) | Live quota rows |
| `agy-quota-log` | snapshots it appends itself | "How many tokens cost one percent?" |
| `agy-models` | `agy models` (subprocess) | `model: auto` resolution |

## Two views of "step count"

The single most important thing to understand about this data.

- The **database** numbers steps continuously across a conversation's whole life.
- The **transcript** restarts its numbering every time the conversation is run.

So a conversation that was delegated twice has one sequence in the database and
two sequences in the transcript. They cannot be zipped positionally without
matching a reply to the wrong step. The reader therefore fuses them **only when
the two sources have exactly the same number of steps** — i.e. the conversation
ran once. Otherwise the transcript alone is shown, because it carries timestamps,
tokens, and tool arguments that the database lacks.

The database's `steps` table has no timestamp column at all. Timing comes from
the transcript; structure comes from the database.

## Protobuf blobs

Step payloads inside `<id>.db` are length-delimited protobuf, not SQL columns. A
hand-written field walker reads them, and strings are harvested recursively —
depth-limited, then filtered for printable-ASCII density, since arbitrary bytes
would otherwise render as garbage.

Step types and states come from integer enumerations (`user_input`,
`agent_response`, `system_message`, `tool`, …) mapped to readable names.

**Consequence:** text recovered this way is a reconstruction, not a first-class
field. Where the transcript has real text, it wins and the database only fills
gaps. One specific filter matters: `gen_metadata` frequently contains nothing but
a model name, which would otherwise be displayed as if the agent had said it.

## Token accounting

Each model step carries `created_at`, `input_tokens`, `output_tokens`, and
`cache_read_tokens`. **These are per-step increments, not running totals.**

Reading the raw numbers naively looks wrong: a conversation's input count climbs
into the hundreds of thousands, then drops to a few thousand. Nothing is being
lost — once agy's prefix cache warms up, the re-sent context is recorded as
`cache_read` instead of `input`. So:

- summing the increments is correct, and
- **`cache_read` must be counted too** — it is the bulk of the volume.

`total = input + output + cacheRead`. The panel reports all three columns rather
than collapsing them, because "input dropped" without that context looks like a
bug. Steps whose three counters are all zero carry no information and are dropped.

## Both brain trees

Token scanning covers the CLI's brain **and the IDE's**. The IDE's sessions never
appear in this plugin's conversation list, but they draw on the same account
quota — omitting them under-counts a normal day substantially.

Files are cached by `(mtime, size)`, so a refresh re-reads only what changed.

Days are **local calendar days**, not 24-hour slices: subtracting a fixed number
of milliseconds across a DST boundary yields a 23- or 25-hour day.

## Reading a locked database

agy holds a write lock on the conversation it is currently driving. The reader
tries `readOnly` in place first; on failure it assumes a live writer, copies the
database *and its `-wal`/`-shm` sidecars* to a temp directory, and reads the
copy. Copying without the sidecars would read a stale snapshot.

The temp directory is always cleaned up, including when the copy itself fails —
otherwise a failed read would strand a full copy in the user's temp dir.

## Quota conversion

Quota snapshots are appended to a log the plugin owns. Dividing tokens spent by
percentage points consumed estimates "how much does one percent buy", and from
that the window's total capacity.

This estimate is only produced under conditions that make it meaningful:

- at least two samples **inside the same reset window** — across a reset, the
  percentage jumps up and a naive delta goes negative
- a span above a minimum duration — dividing a 20-minute observation extrapolates
  wildly
- non-zero both consumed points and tokens

Otherwise the row reports why it declined (`few-samples`, `short-span`,
`no-spend`) rather than inventing a number. Taking the estimate for granted and
extrapolating from a short window is the easiest way to be confidently wrong.

Taking the estimate for granted and extrapolating from a short window is the
easiest way to be confidently wrong.

This pass uses **millisecond** timestamps, not day buckets: "what did twenty
minutes cost" and "what did today cost" are different questions, and bucketing
cannot answer the first.

## Degradation is the norm

Every reader is best-effort by design. A missing file, an unreadable database, or
an unsupported table yields an empty result with a reason attached — never a
throw. The panel must render even when half these sources are unavailable, which
is also why route handlers return a body carrying the error rather than failing
the request.
