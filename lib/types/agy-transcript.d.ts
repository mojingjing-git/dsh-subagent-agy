import type { StepEvent } from './agy-steps.js';
/** One tool call as agy recorded it. */
export interface TranscriptToolCall {
    name: string;
    parameters: Record<string, unknown>;
}
/** One step of a conversation, as agy recorded it. */
export interface TranscriptRow {
    /** The step number — the same number the SQLite database uses. */
    index: number;
    source: string;
    type: string;
    status: string;
    createdAt: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    /** The model's reasoning. Never the reply itself. */
    thinking: string | null;
    /** What the model said — or, for a tool step, what the tool printed. */
    content: string | null;
    toolCalls: TranscriptToolCall[];
    /** Fields agy had to cut short. */
    truncated: string[];
}
/**
 * Parse the transcript.
 *
 * A line that is not valid JSON is skipped: agy may be writing the file right
 * now, and half a line is not worth failing the whole timeline over.
 */
export declare function parseTranscript(text: string): TranscriptRow[];
/** Where agy keeps the transcript of one conversation. */
export declare function transcriptPath(brainDir: string, conversationId: string): string;
/**
 * Read the transcript of one conversation.
 *
 * Returns `null` when agy keeps no transcript for it — the caller then falls
 * back to the database. A transcript that exists but is empty is an empty
 * list, not `null`.
 */
export declare function readTranscript(conversationId: string, brainDir: string): Promise<TranscriptRow[] | null>;
/**
 * The steps of a conversation, as the transcript describes them.
 *
 * One transcript row is one step — the same step the database knows. The
 * mapping is deliberately one to one, so the two sources can be merged by
 * index:
 *
 * - `PLANNER_RESPONSE` is the model; its `content` is the reply, `thinking`
 *   is the reasoning. The reply wins when both are there.
 * - `GENERIC` is the tool step: the output is its `content`, the tool and its
 *   arguments come from the `tool_calls` of the `PLANNER_RESPONSE` above it.
 */
export declare function transcriptToSteps(rows: readonly TranscriptRow[]): StepEvent[];
/** The token counters of a conversation, summed over its steps. */
export declare function sumUsage(steps: readonly StepEvent[]): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
};
