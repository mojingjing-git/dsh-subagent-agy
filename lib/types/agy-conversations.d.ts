import type { TaskRecord } from './index.js';
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
}
export interface ListConversationsOptions {
    records: Record<string, TaskRecord>;
    /** `~/.gemini/antigravity-cli/conversations` */
    conversationsDir: string;
    /** `~/.gemini/antigravity-cli/annotations` */
    annotationsDir: string;
    /** Conversation ids (or registry keys) the user hid from the panel. */
    hidden?: readonly string[];
    limit?: number;
}
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
