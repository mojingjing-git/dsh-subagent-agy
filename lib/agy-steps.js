/**
 * Step events from agy's `stream-json` protocol.
 *
 * The protocol reports one `step_update` per state change of one step:
 *
 *   {"event":"step_update","step_update":{
 *      "step_index":2,"state":"ACTIVE","step_type":"tool",
 *      "tool_name":"run_command",
 *      "tool_info":{"name":"run_command","parameters":{"CommandLine":"…"}},
 *      "text_delta":"…","duration_seconds":0.11,
 *      "usage":{"input_tokens":1,"output_tokens":2}}}
 *
 * A step arrives more than once: `ACTIVE` first, then `DONE` or `ERROR`, and
 * every event carries only the fields that changed. `text_delta` is
 * incremental, so one step's text grows across its events.
 *
 * The panel needs the whole timeline — what agy did, in which order, with
 * which arguments and with which failure — so these events are collected
 * beside the visible text. The visible text itself is left byte-identical to
 * what the plugin has always shown; the steps are a second, structured view
 * of the same run.
 */
/** How a step ended, in the order the states can advance to. */
const STATE_RANK = {
    ACTIVE: 0,
    DONE: 1,
    ERROR: 2,
};
/**
 * Bounds for the step timeline.
 *
 * A long run can produce thousands of steps, and a single tool call can carry
 * a whole command output. The panel shows the tail of the timeline, so the
 * plugin keeps a bounded window instead of growing without limit.
 */
export const MAX_STEPS = 200;
/** Characters of step text kept per step. */
export const MAX_STEP_TEXT = 4096;
/** Characters of a tool's arguments kept per step. */
export const MAX_TOOL_PARAM_TEXT = 2048;
function truncate(text, max) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}
/** Keep one step within the bounds above. */
function normalizeStep(step) {
    const parameters = step.tool?.parameters ?? null;
    let tool = step.tool;
    if (tool !== null && parameters !== null) {
        const serialized = JSON.stringify(parameters);
        if (serialized.length > MAX_TOOL_PARAM_TEXT) {
            tool = {
                ...tool,
                parameters: {
                    truncated: true,
                    preview: truncate(serialized, MAX_TOOL_PARAM_TEXT),
                },
            };
        }
    }
    return { ...step, text: truncate(step.text, MAX_STEP_TEXT), tool };
}
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
function readTool(payload) {
    const info = asRecord(payload.tool_info);
    const name = asString(payload.tool_name) ?? asString(info?.name);
    if (name === null && info === null)
        return null;
    const parameters = asRecord(info?.parameters);
    const rawError = info?.error;
    let error = null;
    if (typeof rawError === 'string') {
        error = rawError;
    }
    else {
        const errorRecord = asRecord(rawError);
        error = asString(errorRecord?.message) ?? asString(errorRecord?.type);
    }
    return { name: name ?? '', parameters, error };
}
function readUsage(payload) {
    const usage = asRecord(payload.usage);
    if (usage === null)
        return null;
    const out = {};
    for (const [key, value] of Object.entries(usage)) {
        const n = asNumber(value);
        if (n !== null)
            out[key] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
}
/**
 * One `step_update` payload → a step.
 *
 * Returns `undefined` for anything that is not a usable step: the protocol
 * also emits `user_input` markers and, on other builds, payloads without a
 * step index. A malformed event must never break the run.
 */
export function parseStepUpdate(payload) {
    const record = asRecord(payload);
    if (record === null)
        return undefined;
    const index = asNumber(record.step_index);
    if (index === null)
        return undefined;
    const text = typeof record.text_delta === 'string' ? record.text_delta : '';
    return {
        index,
        state: asString(record.state) ?? 'ACTIVE',
        type: asString(record.step_type) ?? 'unknown',
        text,
        tool: readTool(record),
        durationSeconds: asNumber(record.duration_seconds),
        usage: readUsage(record),
    };
}
/**
 * Merge an incoming event into the step it belongs to.
 *
 * The state only ever moves forward (`ACTIVE` → `DONE`/`ERROR`), text is
 * appended, and every other field is filled in by whichever event carries it.
 */
export function mergeStep(existing, incoming) {
    const existingRank = STATE_RANK[existing.state] ?? 0;
    const incomingRank = STATE_RANK[incoming.state] ?? 0;
    const tool = existing.tool === null
        ? incoming.tool
        : incoming.tool === null
            ? existing.tool
            : {
                name: incoming.tool.name.length > 0 ? incoming.tool.name : existing.tool.name,
                parameters: incoming.tool.parameters ?? existing.tool.parameters,
                error: incoming.tool.error ?? existing.tool.error,
            };
    return {
        index: existing.index,
        state: incomingRank > existingRank ? incoming.state : existing.state,
        type: existing.type !== 'unknown' ? existing.type : incoming.type,
        text: existing.text + incoming.text,
        tool,
        durationSeconds: incoming.durationSeconds ?? existing.durationSeconds,
        usage: incoming.usage ?? existing.usage,
    };
}
/**
 * Fold one event into an ordered step list.
 *
 * Steps keep the order agy gave them (by index), and a repeated index
 * updates the step in place instead of appending a second one.
 */
export function mergeStepInto(steps, incoming) {
    const existing = steps.find((step) => step.index === incoming.index);
    if (existing === undefined) {
        return [...steps, normalizeStep(incoming)].sort((a, b) => a.index - b.index);
    }
    return steps.map((step) => (step.index === incoming.index ? normalizeStep(mergeStep(step, incoming)) : step));
}
/**
 * A bounded copy of the timeline, newest steps last.
 *
 * The window keeps the most recent {@link MAX_STEPS} steps so a long run
 * cannot grow the payload without limit; every step inside it is already
 * normalized.
 */
export function snapshotSteps(steps) {
    const window = steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps;
    return window.map((step) => normalizeStep(step));
}
//# sourceMappingURL=agy-steps.js.map