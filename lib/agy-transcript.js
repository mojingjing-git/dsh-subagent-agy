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
 * The two sources line up one to one: the transcript's `step_index` is the
 * SQLite `steps.idx` of the same step. That is what lets the panel merge them.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : null;
}
function asString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/**
 * Undo the second round of JSON encoding.
 *
 * agy serialised the arguments of a tool call, and then serialised every
 * value inside them once more: the command line arrives as `"\"dir /a\""`.
 * Decoding it once gives the string the user would recognise. A value that is
 * not JSON is kept as it is.
 */
function decodeArgument(value) {
    if (typeof value !== 'string')
        return value;
    const text = value.trim();
    if (text.length === 0)
        return value;
    const looksJson = text.startsWith('"') || text.startsWith('{') || text.startsWith('[')
        || /^-?\d+(\.\d+)?$/.test(text) || text === 'true' || text === 'false' || text === 'null';
    if (!looksJson)
        return value;
    try {
        return JSON.parse(text);
    }
    catch {
        return value;
    }
}
function parseToolCalls(value) {
    if (!Array.isArray(value))
        return [];
    const calls = [];
    for (const entry of value) {
        const record = asRecord(entry);
        if (record === null)
            continue;
        const name = asString(record.name);
        if (name === null)
            continue;
        const rawArgs = asRecord(record.args) ?? asRecord(record.arguments) ?? asRecord(record.parameters);
        const parameters = {};
        for (const [key, item] of Object.entries(rawArgs ?? {})) {
            parameters[key] = decodeArgument(item);
        }
        calls.push({ name, parameters });
    }
    return calls;
}
/**
 * Parse the transcript.
 *
 * A line that is not valid JSON is skipped: agy may be writing the file right
 * now, and half a line is not worth failing the whole timeline over.
 */
export function parseTranscript(text) {
    const rows = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        let record;
        try {
            record = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const row = asRecord(record);
        if (row === null)
            continue;
        const index = asNumber(row.step_index);
        if (index === null)
            continue;
        rows.push({
            index,
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
                ? row.truncated_fields.filter((item) => typeof item === 'string')
                : [],
        });
    }
    return rows;
}
/** Where agy keeps the transcript of one conversation. */
export function transcriptPath(brainDir, conversationId) {
    return join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}
/**
 * Read the transcript of one conversation.
 *
 * Returns `null` when agy keeps no transcript for it — the caller then falls
 * back to the database. A transcript that exists but is empty is an empty
 * list, not `null`.
 */
export async function readTranscript(conversationId, brainDir) {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(conversationId))
        return null;
    let text;
    try {
        text = await readFile(transcriptPath(brainDir, conversationId), 'utf8');
    }
    catch {
        return null;
    }
    return parseTranscript(text);
}
/** The step type a transcript row stands for. */
function stepTypeOf(row) {
    switch (row.type) {
        case 'USER_INPUT':
            return 'user_input';
        case 'PLANNER_RESPONSE':
            return 'agent_response';
        case 'GENERIC':
            return 'tool';
        case 'SYSTEM_MESSAGE':
            return 'system_message';
        default:
            return `type_${row.type.toLowerCase()}`;
    }
}
function usageOf(row) {
    if (row.inputTokens === null && row.outputTokens === null && row.cacheReadTokens === null) {
        return null;
    }
    const usage = {};
    if (row.inputTokens !== null)
        usage.input_tokens = row.inputTokens;
    if (row.outputTokens !== null)
        usage.output_tokens = row.outputTokens;
    if (row.cacheReadTokens !== null)
        usage.cache_read_tokens = row.cacheReadTokens;
    return usage;
}
function timestampOf(row) {
    if (row.createdAt === null)
        return undefined;
    const parsed = Date.parse(row.createdAt);
    return Number.isFinite(parsed) ? parsed : undefined;
}
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
export function transcriptToSteps(rows) {
    const steps = [];
    let pendingCall = null;
    for (const row of rows) {
        const type = stepTypeOf(row);
        const at = timestampOf(row);
        const usage = usageOf(row);
        const truncated = row.truncated.length > 0 ? row.truncated : undefined;
        if (type === 'agent_response') {
            // A tool call that never got a `GENERIC` row of its own would be lost,
            // so it stays with the step that asked for it.
            const orphan = pendingCall;
            pendingCall = row.toolCalls[0] ?? null;
            const tool = orphan === null
                ? null
                : { name: orphan.name, parameters: orphan.parameters, error: null };
            steps.push({
                index: row.index,
                state: row.status,
                type,
                text: row.content ?? row.thinking ?? '',
                tool,
                durationSeconds: null,
                usage,
                at,
                thinking: row.thinking ?? undefined,
                truncated,
            });
            continue;
        }
        if (type === 'tool') {
            const call = pendingCall;
            pendingCall = null;
            const tool = call === null
                ? null
                : { name: call.name, parameters: call.parameters, error: null };
            steps.push({
                index: row.index,
                state: row.status,
                type,
                text: row.content ?? '',
                tool,
                durationSeconds: null,
                usage: null,
                at,
                truncated,
            });
            continue;
        }
        steps.push({
            index: row.index,
            state: row.status,
            type,
            text: row.content ?? '',
            tool: null,
            durationSeconds: null,
            usage: null,
            at,
            truncated,
        });
    }
    return steps;
}
/** The token counters of a conversation, summed over its steps. */
export function sumUsage(steps) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    for (const step of steps) {
        const usage = step.usage;
        if (usage === null)
            continue;
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cacheReadTokens += usage.cache_read_tokens ?? 0;
    }
    return { inputTokens, outputTokens, cacheReadTokens };
}
//# sourceMappingURL=agy-transcript.js.map