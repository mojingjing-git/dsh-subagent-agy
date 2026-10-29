/**
 * agy's own transcript of a conversation.
 *
 * agy writes every step of every conversation to
 * `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
 * — one JSON object per step. Unlike the SQLite database next to it, the
 * transcript is plain text: it carries the token counters, a real timestamp,
 * the tool calls with their arguments, the model's reasoning and the reply
 * itself.
 *
 * The two sources describe the same steps, but they do not number them the
 * same way: agy restarts `step_index` at zero on every run of a conversation
 * and keeps the whole history in one file, while the SQLite database numbers
 * the steps of the conversation continuously. So the transcript is numbered by
 * its own position in the file, and the two are only lined up step for step
 * when a conversation was run once.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { StepEvent, StepTool } from './agy-steps.js'

/** One tool call as agy recorded it. */
export interface TranscriptToolCall {
  name: string
  parameters: Record<string, unknown>
}

/** One step of a conversation, as agy recorded it. */
export interface TranscriptRow {
  /** The step number inside its own run — agy restarts it on every run. */
  index: number
  /**
   * The position of the row in the transcript.
   *
   * agy restarts `step_index` at zero on every run, so the same number can
   * appear twice in one conversation. The position in the file does not
   * repeat, and that is what the panel numbers its steps by.
   */
  seq: number
  /** Which run of the conversation the row belongs to, counted from zero. */
  round: number
  source: string
  type: string
  status: string
  createdAt: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  /** The model's reasoning. Never the reply itself. */
  thinking: string | null
  /** What the model said — or, for a tool step, what the tool printed. */
  content: string | null
  toolCalls: TranscriptToolCall[]
  /** Fields agy had to cut short. */
  truncated: string[]
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

/**
 * Undo the second round of JSON encoding.
 *
 * agy serialised the arguments of a tool call, and then serialised every
 * value inside them once more: the command line arrives as `"\"dir /a\""`.
 * Decoding it once gives the string the user would recognise. A value that is
 * not JSON is kept as it is.
 */
function decodeArgument(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (text.length === 0) return value
  const looksJson = text.startsWith('"') || text.startsWith('{') || text.startsWith('[')
    || /^-?\d+(\.\d+)?$/.test(text) || text === 'true' || text === 'false' || text === 'null'
  if (!looksJson) return value
  try {
    return JSON.parse(text) as unknown
  } catch {
    return value
  }
}

function parseToolCalls(value: unknown): TranscriptToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: TranscriptToolCall[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === null) continue
    const name = asString(record.name)
    if (name === null) continue
    const rawArgs = asRecord(record.args) ?? asRecord(record.arguments) ?? asRecord(record.parameters)
    const parameters: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(rawArgs ?? {})) {
      parameters[key] = decodeArgument(item)
    }
    calls.push({ name, parameters })
  }
  return calls
}

/**
 * Parse the transcript.
 *
 * A line that is not valid JSON is skipped: agy may be writing the file right
 * now, and half a line is not worth failing the whole timeline over.
 */
export function parseTranscript(text: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let previousIndex: number | null = null
  let round = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    const row = asRecord(record)
    if (row === null) continue
    const index = asNumber(row.step_index)
    if (index === null) continue
    // A step number that goes back down means agy started another run of the
    // same conversation; the file keeps both, the numbers restart at zero.
    if (previousIndex !== null && index < previousIndex) round += 1
    previousIndex = index
    rows.push({
      index,
      seq: rows.length,
      round,
      source: typeof row.source === 'string' ? row.source : 'UNKNOWN',
      type: typeof row.type === 'string' ? row.type : 'UNKNOWN',
      status: typeof row.status === 'string' ? row.status : 'DONE',
      createdAt: asString(row.created_at),
      inputTokens: asNumber(row.input_tokens),
      outputTokens: asNumber(row.output_tokens),
      cacheReadTokens: asNumber(row.cache_read_tokens),
      thinking: asString(row.thinking),
      content: asString(row.content),
      toolCalls: parseToolCalls(row.tool_calls),
      truncated: Array.isArray(row.truncated_fields)
        ? row.truncated_fields.filter((item): item is string => typeof item === 'string')
        : [],
    })
  }
  return rows
}

/** Where agy keeps the transcript of one conversation. */
export function transcriptPath(brainDir: string, conversationId: string): string {
  return join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl')
}

/**
 * Read the transcript of one conversation.
 *
 * Returns `null` when agy keeps no transcript for it — the caller then falls
 * back to the database. A transcript that exists but is empty is an empty
 * list, not `null`.
 */
export async function readTranscript(
  conversationId: string,
  brainDir: string,
): Promise<TranscriptRow[] | null> {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(conversationId)) return null
  let text: string
  try {
    text = await readFile(transcriptPath(brainDir, conversationId), 'utf8')
  } catch {
    return null
  }
  return parseTranscript(text)
}

/** The step type a transcript row stands for. */
function stepTypeOf(row: TranscriptRow): string {
  switch (row.type) {
    case 'USER_INPUT':
      return 'user_input'
    case 'PLANNER_RESPONSE':
      return 'agent_response'
    case 'GENERIC':
      return 'tool'
    case 'SYSTEM_MESSAGE':
      return 'system_message'
    default:
      return `type_${row.type.toLowerCase()}`
  }
}

function usageOf(row: TranscriptRow): Record<string, number> | null {
  if (row.inputTokens === null && row.outputTokens === null && row.cacheReadTokens === null) {
    return null
  }
  const usage: Record<string, number> = {}
  if (row.inputTokens !== null) usage.input_tokens = row.inputTokens
  if (row.outputTokens !== null) usage.output_tokens = row.outputTokens
  if (row.cacheReadTokens !== null) usage.cache_read_tokens = row.cacheReadTokens
  return usage
}

function timestampOf(row: TranscriptRow): number | undefined {
  if (row.createdAt === null) return undefined
  const parsed = Date.parse(row.createdAt)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The steps of a conversation, as the transcript describes them.
 *
 * One transcript row is one step, numbered by its position in the file — agy
 * restarts its own `step_index` on every run, so that number would repeat.
 * The mapping between agy's types and the panel's is deliberately one to one:
 *
 * - `PLANNER_RESPONSE` is the model; its `content` is the reply, `thinking`
 *   is the reasoning. The reply wins when both are there.
 * - `GENERIC` is the tool step: the output is its `content`, the tool and its
 *   arguments come from the `tool_calls` of the `PLANNER_RESPONSE` above it.
 */
export function transcriptToSteps(rows: readonly TranscriptRow[]): StepEvent[] {
  const steps: StepEvent[] = []
  let pendingCall: TranscriptToolCall | null = null

  for (const row of rows) {
    const type = stepTypeOf(row)
    const at = timestampOf(row)
    const usage = usageOf(row)
    const truncated = row.truncated.length > 0 ? row.truncated : undefined

    if (type === 'agent_response') {
      // A tool call that never got a `GENERIC` row of its own would be lost,
      // so it stays with the step that asked for it.
      const orphan = pendingCall
      pendingCall = row.toolCalls[0] ?? null
      const tool: StepTool | null = orphan === null
        ? null
        : { name: orphan.name, parameters: orphan.parameters, error: null }
      steps.push({
        index: row.seq,
        round: row.round,
        state: row.status,
        type,
        text: row.content ?? row.thinking ?? '',
        tool,
        durationSeconds: null,
        usage,
        at,
        thinking: row.thinking ?? undefined,
        truncated,
      })
      continue
    }

    if (type === 'tool') {
      const call = pendingCall
      pendingCall = null
      const tool: StepTool | null = call === null
        ? null
        : { name: call.name, parameters: call.parameters, error: null }
      steps.push({
        index: row.seq,
        round: row.round,
        state: row.status,
        type,
        text: row.content ?? '',
        tool,
        durationSeconds: null,
        usage: null,
        at,
        truncated,
      })
      continue
    }

    steps.push({
      index: row.seq,
      round: row.round,
      state: row.status,
      type,
      text: row.content ?? '',
      tool: null,
      durationSeconds: null,
      usage: null,
      at,
      truncated,
    })
  }

  return steps
}

/** The token counters of a conversation, summed over its steps. */
export function sumUsage(steps: readonly StepEvent[]): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
} {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  for (const step of steps) {
    const usage = step.usage
    if (usage === null) continue
    inputTokens += usage.input_tokens ?? 0
    outputTokens += usage.output_tokens ?? 0
    cacheReadTokens += usage.cache_read_tokens ?? 0
  }
  return { inputTokens, outputTokens, cacheReadTokens }
}
