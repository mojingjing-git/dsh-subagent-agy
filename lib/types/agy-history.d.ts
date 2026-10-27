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
import type { StepEvent } from './agy-steps.js';
/** Steps kept per conversation — the same window the live timeline uses. */
export declare const MAX_HISTORY_STEPS = 200;
/** One conversation's timeline, as far as the database can tell it. */
export interface ConversationHistory {
    conversationId: string;
    steps: StepEvent[];
    /** How many steps the conversation really has — may exceed `steps.length`. */
    stepCount: number;
    /** Where the timeline came from. */
    source: 'database' | 'missing' | 'unreadable';
    /** Why the timeline is empty, when it is. */
    error?: string;
}
/**
 * Is this only the name of the model that answered?
 *
 * agy does not keep the reply body of every conversation. Where the body is
 * missing, the step carries nothing but the model name, and showing that as
 * if it were the answer would be a lie.
 */
export declare function looksLikeModelName(text: string): boolean;
/**
 * Read a conversation's step timeline from agy's database.
 *
 * Never throws: a missing or locked database yields an empty timeline with a
 * reason, because the panel must still render the conversation list.
 */
export declare function readConversationHistory(conversationId: string, conversationsDir: string): Promise<ConversationHistory>;
