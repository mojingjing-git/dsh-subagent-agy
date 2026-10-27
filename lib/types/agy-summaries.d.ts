/**
 * The summary table agy keeps next to the conversations.
 *
 * `~/.gemini/antigravity-cli/conversation_summaries.db` holds one row per
 * conversation with the metadata the panel wants but the task registry does
 * not have: the real title, the preview of the last exchange, the step count,
 * the last time the conversation changed and the state agy left it in.
 *
 * The registry (`~/.dsh/agy-conversations.json`) only knows what *this plugin*
 * started, so it has no idea when the conversation was last touched. The
 * summary table does — and it covers conversations that did not run through
 * DSH at all, which is why it is worth a second reader.
 */
/** One row of `conversation_summaries`. */
export interface ConversationSummary {
    conversationId: string;
    title: string | null;
    preview: string | null;
    stepCount: number;
    /** Epoch milliseconds of the last change, when agy wrote a usable time. */
    lastModifiedAt: number | null;
    /** Epoch milliseconds of the last user prompt. */
    lastUserInputAt: number | null;
    /** agy's own state, e.g. `CASCADE_RUN_STATUS_IDLE`. */
    status: string | null;
}
/**
 * Read every summary row, keyed by conversation id.
 *
 * Never throws: a missing or locked database yields an empty map, because the
 * conversation list must still render without it.
 */
export declare function readConversationSummaries(dbPath: string): Promise<Map<string, ConversationSummary>>;
