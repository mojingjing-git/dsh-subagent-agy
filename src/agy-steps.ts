/**
 * Step events from agy's `stream-json` protocol.
 *
 * The protocol reports one `step_update` per state change of one step:
 *
 *   {"event":"step_update","step_update":{
 *      "step_index":2,"state":"ACTIVE","step_type":"tool",
 *      "tool_name":"run_command",
 *      "tool_info":{"name":"run_command","parameters":{"CommandLine":"…"}},
 *      "text_delta":"…","duration_seconds":0.11,
 *      "usage":{"input_tokens":1,"output_tokens":2}}}
 *
 * A step arrives more than once: `ACTIVE` first, then `DONE` or `ERROR`, and
 * every event carries only the fields that changed. `text_delta` is
 * incremental, so one step's text grows across its events.
 *
 * The panel needs the whole timeline — what agy did, in which order, with
 * which arguments and with which failure — so these events are collected
 * beside the visible text. The visible text itself is left byte-identical to
 * what the plugin has always shown; the steps are a second, structured view
 * of the same run.
 */

/** How a step ended, in the order the states can advance to. */
const STATE_RANK: Record<string, number> = {
  ACTIVE: 0,
  DONE: 1,
  ERROR: 2,
}

/**
 * Bounds for the step timeline.
 *
 * A long run can produce thousands of steps, and a single tool call can carry
 * a whole command output. The panel shows the tail of the timeline, so the
 * plugin keeps a bounded window instead of growing without limit.
 */
export const MAX_STEPS = 200
/** Characters of step text kept per step. */
export const MAX_STEP_TEXT = 4096
/** Characters of a tool's arguments kept per step. */
export const MAX_TOOL_PARAM_TEXT = 2048

const TRUNCATED_MARKER = /…\(\+\d+ chars\)$/

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  // A text that already carries its truncation receipt is final: re-truncating
  // would rewrite the marker into a bogus one (e.g. '…(+13 chars)' →
  // '…(+12 chars)'), and the marker is what the panel shows.
  if (TRUNCATED_MARKER.test(text)) return text
  return `${text.slice(0, max)}…(+${text.length - max} chars)`
}

/** Keep one step within the bounds above. */
function normalizeStep(step: StepEvent): StepEvent {
  const parameters = step.tool?.parameters ?? null
  let tool = step.tool
  if (tool !== null && parameters !== null) {
    const serialized = JSON.stringify(parameters)
    if (serialized.length > MAX_TOOL_PARAM_TEXT) {
      tool = {
        ...tool,
        parameters: {
          truncated: true,
          preview: truncate(serialized, MAX_TOOL_PARAM_TEXT),
        },
      }
    }
  }
  return { ...step, text: truncate(step.text, MAX_STEP_TEXT), tool }
}

/** The tool a step called, with its arguments and its failure, when known. */
export interface StepTool {
  name: string
  /** Raw tool arguments; agy sends them as a JSON object. */
  parameters: Record<string, unknown> | null
  /** The tool's own error message, when the call failed. */
  error: string | null
}

/** One step of one run. */
export interface StepEvent {
  /**
   * The step's number.
   *
   * In the live timeline this is agy's `step_index` — the stable identity of
   * the step inside its run. In a transcript read back from disk it is the
   * position of the step in the file, because agy restarts `step_index` on
   * every run of the same conversation.
   */
  index: number
  /**
   * Which run of the conversation the step belongs to, counted from zero.
   *
   * Only the transcript knows it: agy keeps one file per conversation and
   * appends every run to it.
   */
  round?: number
  /** `ACTIVE` while it runs, then `DONE` or `ERROR`. */
  state: string
  /** `user_input`, `agent_response`, `tool`, … — agy's own vocabulary. */
  type: string
  /** Text the model produced for this step, accumulated across events. */
  text: string
  tool: StepTool | null
  durationSeconds: number | null
  usage: Record<string, number> | null
  /**
   * When the plugin saw this step (epoch milliseconds).
   *
   * agy's protocol carries no timestamp, so this is the moment the event
   * arrived — the only clock available for the live timeline. Steps read back
   * from a finished conversation have no time at all.
   */
  at?: number
  /**
   * The model's reasoning, when agy kept it.
   *
   * It is never the reply itself: a step carries its reply in `text`.
   */
  thinking?: string
  /** Fields agy had to cut short, e.g. `['content']`. */
  truncated?: string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readTool(payload: Record<string, unknown>): StepTool | null {
  const info = asRecord(payload.tool_info)
  const name = asString(payload.tool_name) ?? asString(info?.name)
  if (name === null && info === null) return null
  const parameters = asRecord(info?.parameters)
  const rawError = info?.error
  let error: string | null = null
  if (typeof rawError === 'string') {
    error = rawError
  } else {
    const errorRecord = asRecord(rawError)
    error = asString(errorRecord?.message) ?? asString(errorRecord?.type)
  }
  return { name: name ?? '', parameters, error }
}

function readUsage(payload: Record<string, unknown>): Record<string, number> | null {
  const usage = asRecord(payload.usage)
  if (usage === null) return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(usage)) {
    const n = asNumber(value)
    if (n !== null) out[key] = n
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * One `step_update` payload → a step.
 *
 * Returns `undefined` for anything that is not a usable step: the protocol
 * also emits `user_input` markers and, on other builds, payloads without a
 * step index. A malformed event must never break the run.
 */
export function parseStepUpdate(payload: unknown): StepEvent | undefined {
  const record = asRecord(payload)
  if (record === null) return undefined
  const index = asNumber(record.step_index)
  if (index === null) return undefined
  const text = typeof record.text_delta === 'string' ? record.text_delta : ''
  return {
    index,
    state: asString(record.state) ?? 'ACTIVE',
    type: asString(record.step_type) ?? 'unknown',
    text,
    tool: readTool(record),
    durationSeconds: asNumber(record.duration_seconds),
    usage: readUsage(record),
  }
}

/**
 * Merge an incoming event into the step it belongs to.
 *
 * The state only ever moves forward (`ACTIVE` → `DONE`/`ERROR`), text is
 * appended, and every other field is filled in by whichever event carries it.
 */
export function mergeStep(existing: StepEvent, incoming: StepEvent): StepEvent {
  const existingRank = STATE_RANK[existing.state] ?? 0
  const incomingRank = STATE_RANK[incoming.state] ?? 0
  const tool = existing.tool === null
    ? incoming.tool
    : incoming.tool === null
      ? existing.tool
      : {
        name: incoming.tool.name.length > 0 ? incoming.tool.name : existing.tool.name,
        parameters: incoming.tool.parameters ?? existing.tool.parameters,
        error: incoming.tool.error ?? existing.tool.error,
      }
  return {
    index: existing.index,
    state: incomingRank > existingRank ? incoming.state : existing.state,
    type: existing.type !== 'unknown' ? existing.type : incoming.type,
    text: existing.text + incoming.text,
    tool,
    durationSeconds: incoming.durationSeconds ?? existing.durationSeconds,
    usage: incoming.usage ?? existing.usage,
  }
}

/**
 * Fold one event into an ordered step list.
 *
 * Steps keep the order agy gave them (by index), and a repeated index
 * updates the step in place instead of appending a second one. The fold is
 * the module's only state sink, so the bounded window lives here, not in the
 * snapshot: without it a long run grows the array (and every payload built
 * from it) without limit.
 */
export function mergeStepInto(steps: readonly StepEvent[], incoming: StepEvent): StepEvent[] {
  // Anti-resurrection: once the bounded window is full, a repeat of an index
  // below the oldest kept step was evicted — re-appending it would oscillate
  // around the window edge. A window that is not full still accepts
  // out-of-order arrivals: agy can legitimately emit step 2 before step 0.
  const oldest = steps[0]
  if (steps.length >= MAX_STEPS && oldest !== undefined && incoming.index < oldest.index) return [...steps]
  const existing = steps.find((step) => step.index === incoming.index)
  if (existing === undefined) {
    const appended = [...steps, normalizeStep(incoming)].sort((a, b) => a.index - b.index)
    return appended.length > MAX_STEPS ? appended.slice(appended.length - MAX_STEPS) : appended
  }
  return steps.map((step) => (step.index === incoming.index ? normalizeStep(mergeStep(step, incoming)) : step))
}

/**
 * A bounded copy of the timeline, newest steps last.
 *
 * The window keeps the most recent {@link MAX_STEPS} steps so a long run
 * cannot grow the payload without limit. Every step in the timeline was
 * normalized when it entered the fold, so the snapshot copies — it must not
 * re-normalize: a second pass rewrites each step's own truncation receipt
 * (and allocates a fresh timeline) on every 250 ms panel poll.
 */
export function snapshotSteps(steps: readonly StepEvent[]): StepEvent[] {
  const window = steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps
  return [...window]
}
