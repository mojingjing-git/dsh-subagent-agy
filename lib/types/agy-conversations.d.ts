import type { TaskRecord } from './index.js';
import type { ConversationSummary } from './agy-summaries.js';
/** One row the panel renders. */
export interface ConversationItem {
    /** Registry key, kept for diagnostics only. */
    key: string;
    conversationId: string;
    label: string;
    cwd: string;
    createdAt: number;
    model: string | null;
    /** False when the project directory is gone (unmounted drive, deleted folder). */
    cwdExists: boolean;
    /** When agy saw the conversation change last — falls back to `createdAt`. */
    lastActivityAt: number;
    /** agy's own state, e.g. `CASCADE_RUN_STATUS_IDLE`. */
    status: string | null;
    /** How many steps the conversation has, when agy counted them. */
    stepCount: number;
    /** One line of the conversation's last exchange. */
    preview: string | null;
}
export interface ListConversationsOptions {
    records: Record<string, TaskRecord>;
    /** `~/.gemini/antigravity-cli/conversations` */
    conversationsDir: string;
    /** `~/.gemini/antigravity-cli/annotations` */
    annotationsDir: string;
    /** Conversation ids (or registry keys) the user hid from the panel. */
    hidden?: readonly string[];
    /** What agy knows about the conversations, keyed by conversation id. */
    summaries?: ReadonlyMap<string, ConversationSummary>;
    limit?: number;
}
/**
 * Conversation ids reach `join(dir, `${id}.db`)` below. Registry entries and
 * summaries are data, not trusted paths — accept only the id shape agy writes
 * (hex + dashes, as in the UUIDs history.ts already enforces) so `../x` can
 * never climb out of the data directory.
 */
export declare function isSafeConversationId(id: string): boolean;
/** Last `gemini-*` id appearing in the conversation database. */
export declare function lastModelIn(buffer: Buffer): string | null;
/** Model id recorded inside `<conversationId>.db`, cached by mtime. */
export declare function modelFromDb(conversationsDir: string, conversationId: string): string | null;
/** `title:"…"` from the per-conversation annotation file, if any. */
export declare function titleFromAnnotations(annotationsDir: string, conversationId: string): string | null;
/**
 * Registry → sorted, de-duplicated, real conversations only.
 *
 * De-duplication is by `conversationId`: resuming a conversation writes a second
 * registry entry under a new key, and the panel should show the conversation
 * once, at its latest activity.
 */
export declare function listConversations(options: ListConversationsOptions): ConversationItem[];
