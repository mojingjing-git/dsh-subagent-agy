/**
 * Reading the step timeline of a *finished* conversation.
 *
 * The live protocol (`step_update` events) only covers what happens during a
 * run this plugin starts. A conversation that ran earlier — or one that ran
 * outside of DSH — has no live stream, so the panel would show nothing but its
 * title. agy keeps those conversations in SQLite databases, one per
 * conversation:
 *
 *   ~/.gemini/antigravity-cli/conversations/<conversation-id>.db
 *
 * with two tables that matter:
 *
 *   steps(idx, step_type, status, metadata, step_payload, render_info, …)
 *     — the ordered timeline: user input, tool calls, model replies.
 *   gen_metadata(idx, data, size)
 *     — the body of each model reply, in the order the replies happened.
 *
 * The columns are protobuf blobs, not text. Decoding them means walking the
 * wire format: field 1 is a varint, field 2 a length-delimited blob, and
 * nested messages simply repeat the pattern. The decoder below is
 * deliberately generic — it does not need to know agy's schema, only to find
 * the readable strings inside a blob.
 *
 * What can be recovered:
 *   - user_input  → the prompt text (inside `step_payload`)
 *   - agent_response → the reply text (inside `gen_metadata`)
 *   - tool        → the tool name and its arguments (inside `step_payload`)
 *
 * What cannot: exact timestamps (the schema has no time column) and any text
 * that agy itself never wrote down.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StepEvent, StepTool } from './agy-steps.js'

/** agy's numeric step types as seen in the conversation database. */
const STEP_TYPES: Record<number, string> = {
  14: 'user_input',
  15: 'agent_response',
  101: 'system_message',
  132: 'tool',
}

/**
 * agy's numeric step states.
 *
 * `3` is the normal end of a step and by far the most common one; `6` and
 * `7` only ever occur on steps that failed (a rejected tool call, a failed
 * command), so both are reported as `ERROR`.
 */
const STEP_STATES: Record<number, string> = {
  1: 'ACTIVE',
  3: 'DONE',
  6: 'ERROR',
  7: 'ERROR',
}

/** Steps kept per conversation — the same window the live timeline uses. */
export const MAX_HISTORY_STEPS = 200
/** Characters kept per step text. */
const MAX_HISTORY_TEXT = 4096

/** One conversation's timeline, as far as the database can tell it. */
export interface ConversationHistory {
  conversationId: string
  steps: StepEvent[]
  /** How many steps the conversation really has — may exceed `steps.length`. */
  stepCount: number
  /** Where the timeline came from. */
  source: 'database' | 'missing' | 'unreadable'
  /** Why the timeline is empty, when it is. */
  error?: string
}

// ── protobuf decoding ───────────────────────────────────────────────────────

function toBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') {
    const text = value.trim()
    // Some columns come back as a comma separated list of byte values.
    if (/^\d+(,\d+)*$/.test(text)) {
      return Uint8Array.from(text.split(',').map((n) => Number(n)))
    }
    return new TextEncoder().encode(text)
  }
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array(0)
}

interface ProtoField {
  number: number
  wire: number
  value: number | Uint8Array
}

/** Walk the fields of a protobuf message. */
function* readFields(bytes: Uint8Array, start = 0, end = bytes.length): Generator<ProtoField> {
  let i = start
  while (i < end) {
    let key = 0
    let shift = 0
    while (i < end) {
      const byte = bytes[i++]
      key |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
      if (shift > 63) return
    }
    const number = key >>> 3
    const wire = key & 7
    if (number === 0) return
    if (wire === 0) {
      let value = 0
      let s = 0
      while (i < end) {
        const byte = bytes[i++]
        value += (byte & 0x7f) * 2 ** s
        if ((byte & 0x80) === 0) break
        s += 7
      }
      yield { number, wire, value }
    } else if (wire === 1) {
      yield { number, wire, value: bytes.subarray(i, i + 8) }
      i += 8
    } else if (wire === 2) {
      let length = 0
      let s = 0
      while (i < end) {
        const byte = bytes[i++]
        length += (byte & 0x7f) * 2 ** s
        if ((byte & 0x80) === 0) break
        s += 7
      }
      yield { number, wire, value: bytes.subarray(i, i + length) }
      i += length
    } else if (wire === 5) {
      yield { number, wire, value: bytes.subarray(i, i + 4) }
      i += 4
    } else {
      return
    }
  }
}

/** A blob that is (mostly) readable text rather than binary. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null
  let printable = 0
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++
    else if (byte >= 0xc3) printable++
  }
  if (printable / bytes.length < 0.98) return null
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!/[\p{L}\p{N}]/u.test(text)) return null
  return text
}

/** Every readable string inside a blob, nested messages included. */
function collectStrings(bytes: Uint8Array, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out
  for (const field of readFields(bytes)) {
    if (field.wire !== 2) continue
    const blob = field.value as Uint8Array
    const text = asText(blob)
    if (text !== null && text.trim().length > 0) {
      // The whole blob reads as text — take it as it is instead of digging
      // into it, which would split a sentence into its protobuf parts.
      out.push(text.trim())
    } else if (blob.length > 1) {
      collectStrings(blob, depth + 1, out)
    }
  }
  return out
}

// ── picking the meaningful parts ────────────────────────────────────────────

/** Control characters that mean the string is a fragment, not a sentence. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

/**
 * Drop the control characters protobuf leaves inside a string.
 *
 * A length prefix or a field tag sits right in front of the text it belongs
 * to; removing them keeps the sentence intact instead of dropping it.
 */
function cleanText(text: string): string {
  return text.replace(CONTROL_CHARS, '').trim()
}

/** Is this string a sentence a human would read? */
function isProse(text: string): boolean {
  const clean = cleanText(text)
  if (clean.length < 8) return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) return false
  if (/^[A-Za-z]:[\\/]/.test(clean)) return false
  if (!/\s/.test(clean)) return false
  if (clean.startsWith('{') || clean.startsWith('[')) return false
  return true
}

/**
 * Does this string belong to what the model was *given* rather than to what
 * it *said*?
 *
 * A conversation blob carries the whole model input — the system prompt, the
 * tool catalogue, the environment — next to the answer. Those parts are long
 * and would win any "longest text" comparison, so they are recognised and
 * left out.
 */
function isModelInput(text: string): boolean {
  // `<identity>…`, `<system>…` and friends.
  if (text.startsWith('<')) return true
  // `read_file(C:/…)`, `command(Get-ChildItem …)` — a tool call, not prose.
  if (/^\s*[a-z_][a-z0-9_]*\s*\(/.test(text)) return true
  // The system prompt in full.
  if (text.length > 20_000) return true
  return false
}

/**
 * A stray length byte in front of a sentence.
 *
 * The payload nests a string inside a message, and the byte that holds the
 * length can end up in front of the text it describes. A single capital
 * right before another capital is that artefact, not a word.
 */
function stripLeadingArtefact(text: string): string {
  return text
    // Leading punctuation and replacement characters.
    .replace(/^[^\p{L}\p{N}]+/u, '')
    // A length byte in front of a tool call: `Fread_file(…)`.
    .replace(/^[A-Z](?=[a-z_][a-z0-9_]*\s*\()/, '')
    // A length byte in front of a sentence: `HList the files…`.
    .replace(/^[A-Z](?=[A-Z][a-z])/, '')
}

/** The most sentence-like string of a blob — the reply, or the prompt. */
function pickProse(texts: readonly string[]): string {
  let best = ''
  for (const raw of texts) {
    if (!isProse(raw)) continue
    const clean = stripLeadingArtefact(cleanText(raw))
    if (clean.length === 0 || isModelInput(clean)) continue
    if (clean.length > best.length) best = clean
  }
  return best
}

/** The tool arguments of a tool step, as agy serialised them. */
function pickToolParameters(texts: readonly string[]): Record<string, unknown> | null {
  for (const text of texts) {
    if (!text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON after all — keep looking.
    }
  }
  return null
}

/**
 * The name of the tool a step called.
 *
 * agy writes the name as a bare word next to the call id (`call_3554809`),
 * so the first bare lower-case word that is not a call id wins.
 */
function pickToolName(texts: readonly string[]): string | null {
  for (const text of texts) {
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(text)) continue
    if (text.startsWith('call_')) continue
    if (text === 'self' || text === 'research' || text === 'browser') continue
    return text
  }
  return null
}

/** A short summary of a tool call, when agy wrote one. */
function pickToolSummary(texts: readonly string[], parameters: Record<string, unknown> | null): string {
  const summary = parameters?.toolSummary
  if (typeof summary === 'string' && summary.length > 0) return summary
  const command = parameters?.CommandLine
  if (typeof command === 'string' && command.length > 0) return command
  return ''
}

function clip(text: string, max = MAX_HISTORY_TEXT): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…(+${text.length - max} chars)`
}

// ── reading the database ────────────────────────────────────────────────────

interface StepRow {
  idx: number
  step_type: number
  status: number
  metadata: unknown
  error_details: unknown
  render_info: unknown
  step_payload: unknown
}

interface GenRow {
  idx: number
  data: unknown
}

type SqliteDatabase = {
  prepare: (sql: string) => { all: () => unknown[] }
  close: () => void
}

async function openDatabase(path: string): Promise<{ db: SqliteDatabase; cleanup: () => void } | null> {
  let sqlite: { DatabaseSync: new (path: string, options?: Record<string, unknown>) => SqliteDatabase }
  try {
    sqlite = await import('node:sqlite') as unknown as typeof sqlite
  } catch {
    return null
  }
  // 1. Read in place — the common case, when agy is not holding the file.
  try {
    const db = new sqlite.DatabaseSync(path, { readOnly: true })
    return { db, cleanup: () => { try { db.close() } catch { /* already closed */ } } }
  } catch {
    // 2. agy is running and holds a write lock — work on a copy instead.
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'agy-history-'))
    const copy = join(dir, 'conversation.db')
    copyFileSync(path, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix)
    }
    const db = new sqlite.DatabaseSync(copy)
    return {
      db,
      cleanup: () => {
        try { db.close() } catch { /* already closed */ }
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
      },
    }
  } catch {
    return null
  }
}

function decodeStep(row: StepRow, replyBody: string | null): StepEvent {
  const type = STEP_TYPES[row.step_type] ?? `type_${row.step_type}`
  const state = STEP_STATES[row.status] ?? 'DONE'
  const payload = collectStrings(toBytes(row.step_payload))
  const metadata = collectStrings(toBytes(row.metadata))
  const renderInfo = collectStrings(toBytes(row.render_info))
  const errors = collectStrings(toBytes(row.error_details))
  const texts = [...payload, ...metadata, ...renderInfo]

  let text = ''
  let tool: StepTool | null = null
  if (type === 'agent_response') {
    text = replyBody ?? pickProse(texts)
  } else if (type === 'user_input') {
    text = pickProse(texts)
  } else if (type === 'tool') {
    const parameters = pickToolParameters(texts)
    const name = pickToolName(texts) ?? ''
    const summary = pickToolSummary(texts, parameters)
    tool = { name, parameters, error: errors.length > 0 ? pickProse(errors) : null }
    text = summary
  } else {
    text = pickProse(texts)
  }

  return {
    index: row.idx,
    state,
    type,
    text: clip(text),
    tool,
    durationSeconds: null,
    usage: null,
  }
}

/**
 * Read a conversation's step timeline from agy's database.
 *
 * Never throws: a missing or locked database yields an empty timeline with a
 * reason, because the panel must still render the conversation list.
 */
export async function readConversationHistory(
  conversationId: string,
  conversationsDir: string,
): Promise<ConversationHistory> {
  const empty: ConversationHistory = { conversationId, steps: [], stepCount: 0, source: 'missing' }
  if (!/^[0-9a-fA-F-]{8,64}$/.test(conversationId)) {
    return { ...empty, source: 'unreadable', error: 'invalid conversation id' }
  }
  const path = join(conversationsDir, `${conversationId}.db`)
  if (!existsSync(path)) return empty

  const opened = await openDatabase(path)
  if (opened === null) {
    return { ...empty, source: 'unreadable', error: 'conversation database could not be opened' }
  }
  try {
    const stepRows = opened.db
      .prepare('select idx, step_type, status, metadata, error_details, render_info, step_payload from steps order by idx')
      .all() as StepRow[]
    let genRows: GenRow[] = []
    try {
      genRows = opened.db.prepare('select idx, data from gen_metadata order by idx').all() as GenRow[]
    } catch {
      genRows = []
    }

    // The reply bodies are stored in the order the replies happened, which is
    // the order of the agent_response steps.
    const replyBodies = genRows.map((row) => {
      const texts = collectStrings(toBytes(row.data))
      return pickProse(texts)
    })
    let replyIndex = 0

    const steps: StepEvent[] = []
    for (const row of stepRows) {
      const type = STEP_TYPES[row.step_type]
      let replyBody: string | null = null
      if (type === 'agent_response') {
        replyBody = replyBodies[replyIndex] ?? null
        replyIndex += 1
      }
      steps.push(decodeStep(row, replyBody))
    }

    const window = steps.length > MAX_HISTORY_STEPS ? steps.slice(steps.length - MAX_HISTORY_STEPS) : steps
    return {
      conversationId,
      steps: window,
      stepCount: steps.length,
      source: 'database',
    }
  } catch (error) {
    return {
      ...empty,
      source: 'unreadable',
      error: error instanceof Error ? error.message : 'conversation database could not be read',
    }
  } finally {
    opened.cleanup()
  }
}
