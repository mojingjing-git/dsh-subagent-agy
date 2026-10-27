/**
 * Turns the plugin's own task registry into the panel's conversation list.
 *
 * The registry (`~/.dsh/agy-conversations.json`) holds one entry per agy run the
 * plugin started: `conversationId`, `cwd`, `label`, `createdAt`. That is exactly
 * the four fields the panel shows, so no sqlite reader is needed.
 *
 * Two wrinkles this module exists for:
 *
 *   1. The registry also collects scratch entries from the offline test suite
 *      (`test-session::…` keys pointing at `fake-conversation-0001`). Filtering
 *      on the key prefix would be fragile, so the admission test is "does
 *      `conversations/<id>.db` actually exist" — a fake id cannot pass it.
 *   2. The model used by old entries was never recorded. The `.db` file does
 *      contain it, but the *most frequent* id is not the right one (a cheap
 *      helper model shows up more often than the model the user picked), so we
 *      take the last occurrence instead.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRecord } from './index.js'
import type { ConversationSummary } from './agy-summaries.js'

/** One row the panel renders. */
export interface ConversationItem {
  /** Registry key, kept for diagnostics only. */
  key: string
  conversationId: string
  label: string
  cwd: string
  createdAt: number
  model: string | null
  /** False when the project directory is gone (unmounted drive, deleted folder). */
  cwdExists: boolean
  /** When agy saw the conversation change last — falls back to `createdAt`. */
  lastActivityAt: number
  /** agy's own state, e.g. `CASCADE_RUN_STATUS_IDLE`. */
  status: string | null
  /** How many steps the conversation has, when agy counted them. */
  stepCount: number
  /** One line of the conversation's last exchange. */
  preview: string | null
}

export interface ListConversationsOptions {
  records: Record<string, TaskRecord>
  /** `~/.gemini/antigravity-cli/conversations` */
  conversationsDir: string
  /** `~/.gemini/antigravity-cli/annotations` */
  annotationsDir: string
  /** Conversation ids (or registry keys) the user hid from the panel. */
  hidden?: readonly string[]
  /** What agy knows about the conversations, keyed by conversation id. */
  summaries?: ReadonlyMap<string, ConversationSummary>
  limit?: number
}

const MODEL_RE = /gemini-[0-9][\w.-]*/g
const MODEL_CACHE = new Map<string, { mtimeMs: number; model: string | null }>()

/**
 * Conversation ids reach `join(dir, `${id}.db`)` below. Registry entries and
 * summaries are data, not trusted paths — accept only the id shape agy writes
 * (hex + dashes, as in the UUIDs history.ts already enforces) so `../x` can
 * never climb out of the data directory.
 */
export function isSafeConversationId(id: string): boolean {
  return /^[0-9a-fA-F-]{8,64}$/.test(id)
}

/** Last `gemini-*` id appearing in the conversation database. */
export function lastModelIn(buffer: Buffer): string | null {
  let last: string | null = null
  for (const match of buffer.toString('latin1').matchAll(MODEL_RE)) last = match[0]
  if (last === null) return null
  return last.replace(/[.-]+$/, '')
}

/** Model id recorded inside `<conversationId>.db`, cached by mtime. */
export function modelFromDb(conversationsDir: string, conversationId: string): string | null {
  if (!isSafeConversationId(conversationId)) return null
  const file = join(conversationsDir, `${conversationId}.db`)
  try {
    const mtimeMs = statSync(file).mtimeMs
    const cached = MODEL_CACHE.get(file)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.model
    const model = lastModelIn(readFileSync(file))
    MODEL_CACHE.set(file, { mtimeMs, model })
    return model
  } catch {
    return null
  }
}

/** `title:"…"` from the per-conversation annotation file, if any. */
export function titleFromAnnotations(annotationsDir: string, conversationId: string): string | null {
  if (!isSafeConversationId(conversationId)) return null
  try {
    const text = readFileSync(join(annotationsDir, `${conversationId}.pbtxt`), 'utf8')
    const match = /title\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
    if (match === null) return null
    const title = match[1].replace(/\\(["\\])/g, '$1').trim()
    return title.length > 0 ? title : null
  } catch {
    return null
  }
}

/**
 * Registry → sorted, de-duplicated, real conversations only.
 *
 * De-duplication is by `conversationId`: resuming a conversation writes a second
 * registry entry under a new key, and the panel should show the conversation
 * once, at its latest activity.
 */
export function listConversations(options: ListConversationsOptions): ConversationItem[] {
  const hidden = new Set(options.hidden ?? [])
  const summaries = options.summaries
  const byConversation = new Map<string, ConversationItem>()

  for (const [key, record] of Object.entries(options.records)) {
    const conversationId = record.conversationId
    if (hidden.has(key) || hidden.has(conversationId)) continue
    if (!isSafeConversationId(conversationId)) continue
    // Admission test: a real agy conversation has a database on disk.
    if (!existsSync(join(options.conversationsDir, `${conversationId}.db`))) continue

    const summary = summaries?.get(conversationId)
    const label = record.label.trim().length > 0
      ? record.label.trim()
      : titleFromAnnotations(options.annotationsDir, conversationId)
        ?? summary?.title
        ?? `agy · ${conversationId.slice(0, 8)}`
    const model = record.model ?? modelFromDb(options.conversationsDir, conversationId)

    const item: ConversationItem = {
      key,
      conversationId,
      label,
      cwd: record.cwd,
      createdAt: record.createdAt,
      model,
      cwdExists: record.cwd.length > 0 && existsSync(record.cwd),
      lastActivityAt: summary?.lastModifiedAt ?? record.createdAt,
      status: summary?.status ?? null,
      stepCount: summary?.stepCount ?? 0,
      preview: summary?.preview ?? null,
    }

    const previous = byConversation.get(conversationId)
    if (previous === undefined || item.createdAt > previous.createdAt) {
      byConversation.set(conversationId, item)
    } else {
      if (previous.model === null && item.model !== null) previous.model = item.model
      if (item.lastActivityAt > previous.lastActivityAt) previous.lastActivityAt = item.lastActivityAt
      if (previous.status === null && item.status !== null) previous.status = item.status
      if (previous.stepCount === 0 && item.stepCount > 0) previous.stepCount = item.stepCount
      if (previous.preview === null && item.preview !== null) previous.preview = item.preview
    }
  }

  const items = [...byConversation.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const limit = options.limit ?? 100
  return limit > 0 ? items.slice(0, limit) : items
}
