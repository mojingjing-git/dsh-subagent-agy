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
import { existsSync } from 'node:fs';
/**
 * agy writes Go's zero time for "never"; it is not a usable date.
 *
 * The zero time is year 1, so anything before the epoch is rejected as well.
 */
function parseTime(value) {
    if (typeof value !== 'string' || value.length === 0)
        return null;
    const normalized = value.replace(' ', 'T');
    const at = new Date(normalized);
    const time = at.getTime();
    if (Number.isNaN(time))
        return null;
    if (time < 0)
        return null;
    return time;
}
function text(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function count(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}
/**
 * Read every summary row, keyed by conversation id.
 *
 * Never throws: a missing or locked database yields an empty map, because the
 * conversation list must still render without it.
 */
export async function readConversationSummaries(dbPath) {
    const summaries = new Map();
    if (!existsSync(dbPath))
        return summaries;
    let sqlite;
    try {
        sqlite = await import('node:sqlite');
    }
    catch {
        return summaries;
    }
    let db = null;
    try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        const rows = db
            .prepare('select conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, status from conversation_summaries')
            .all();
        for (const row of rows) {
            const conversationId = text(row.conversation_id);
            if (conversationId === null)
                continue;
            summaries.set(conversationId, {
                conversationId,
                title: text(row.title),
                preview: text(row.preview),
                stepCount: count(row.step_count),
                lastModifiedAt: parseTime(row.last_modified_time),
                lastUserInputAt: parseTime(row.last_user_input_time),
                status: text(row.status),
            });
        }
    }
    catch {
        // A broken summary file must not take the panel down.
    }
    finally {
        try {
            db?.close();
        }
        catch {
            /* already closed */
        }
    }
    return summaries;
}
//# sourceMappingURL=agy-summaries.js.map