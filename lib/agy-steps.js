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
const TRUNCATED_MARKER = /…\(\+\d+ chars\)$/;
function truncate(text, max) {
    if (text.length <= max)
        return text;
    // A text that already carries its truncation receipt is final: re-truncating
    // would rewrite the marker into a bogus one (e.g. '…(+13 chars)' →
    // '…(+12 chars)'), and the marker is what the panel shows.
    if (TRUNCATED_MARKER.test(text))
        return text;
    return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}
/**
 * Keys agy's write/edit tools have used for their target path.
 *
 * Declared above `normalizeStep` on purpose: that function reads them, and a
 * `const` referenced across 240 lines of hoisting is a TDZ waiting to happen.
 */
const TARGET_PATH_KEYS = ['TargetFile', 'target_file', 'AbsolutePath', 'absolute_path', 'file_path', 'filePath', 'path', 'Path'];
/** The path a write/edit tool aimed at, when the step carries one. */
function targetPath(parameters) {
    if (parameters === null)
        return null;
    for (const key of TARGET_PATH_KEYS) {
        const value = parameters[key];
        if (typeof value === 'string' && value.trim().length > 0)
            return value.trim();
    }
    // A build that renames its arguments: fall back to the first value that looks
    // like a file path (a separator plus a short extension).
    for (const value of Object.values(parameters)) {
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (/[\\/]/.test(trimmed) && /\.[A-Za-z0-9]{1,8}$/.test(trimmed) && !trimmed.includes('\n'))
            return trimmed;
    }
    return null;
}
/** Keep one step within the bounds above. */
function normalizeStep(step) {
    const parameters = step.tool?.parameters ?? null;
    let tool = step.tool;
    // Already normalized: re-wrapping the preview in a second preview would grow
    // the payload past the cap again and change a preview the panel already shows.
    const alreadyTruncated = parameters !== null && parameters.truncated === true;
    if (tool !== null && parameters !== null && !alreadyTruncated) {
        // Capture the target path BEFORE the truncation below replaces the whole
        // parameters object: a write tool's `file_path` lives in exactly the object
        // that gets dropped, and the `[agy] N files changed` summary is built from
        // it. Without this, every non-trivial edit reports zero files.
        const target = targetPath(parameters);
        const withTarget = target !== null ? { ...tool, targetPath: target } : tool;
        const serialized = JSON.stringify(parameters);
        tool =
            serialized.length > MAX_TOOL_PARAM_TEXT
                ? {
                    ...withTarget,
                    parameters: {
                        truncated: true,
                        preview: truncate(serialized, MAX_TOOL_PARAM_TEXT),
                    },
                }
                : withTarget;
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
    const mergedTarget = incoming.tool?.targetPath ?? existing.tool?.targetPath;
    const tool = existing.tool === null
        ? incoming.tool
        : incoming.tool === null
            ? existing.tool
            : {
                name: incoming.tool.name.length > 0 ? incoming.tool.name : existing.tool.name,
                parameters: incoming.tool.parameters ?? existing.tool.parameters,
                error: incoming.tool.error ?? existing.tool.error,
                // A write tool reports ACTIVE with its arguments and DONE without them;
                // dropping the captured path here would lose it on the second event.
                ...(mergedTarget !== undefined ? { targetPath: mergedTarget } : {}),
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
 * updates the step in place instead of appending a second one. The fold is
 * the module's only state sink, so the bounded window lives here, not in the
 * snapshot: without it a long run grows the array (and every payload built
 * from it) without limit.
 */
export function mergeStepInto(steps, incoming) {
    // Anti-resurrection: once the bounded window is full, a repeat of an index
    // below the oldest kept step was evicted — re-appending it would oscillate
    // around the window edge. A window that is not full still accepts
    // out-of-order arrivals: agy can legitimately emit step 2 before step 0.
    const oldest = steps[0];
    if (steps.length >= MAX_STEPS && oldest !== undefined && incoming.index < oldest.index)
        return [...steps];
    const existing = steps.find((step) => step.index === incoming.index);
    if (existing === undefined) {
        const appended = [...steps, normalizeStep(incoming)].sort((a, b) => a.index - b.index);
        return appended.length > MAX_STEPS ? appended.slice(appended.length - MAX_STEPS) : appended;
    }
    return steps.map((step) => (step.index === incoming.index ? normalizeStep(mergeStep(step, incoming)) : step));
}
/**
 * A bounded copy of the timeline, newest steps last.
 *
 * The window keeps the most recent {@link MAX_STEPS} steps so a long run
 * cannot grow the payload without limit. Every step in the timeline was
 * normalized when it entered the fold, so the snapshot copies — it must not
 * re-normalize: a second pass rewrites each step's own truncation receipt
 * (and allocates a fresh timeline) on every 250 ms panel poll.
 */
export function snapshotSteps(steps) {
    const window = steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps;
    return [...window];
}
/**
 * The agy tools that change files, by the name the CLI reports them under.
 *
 * Kept as an explicit allowlist rather than a `/write|edit/` pattern: `view_file`
 * and `read_url_content` mention files too, and counting a read as a change is
 * worse than missing a tool a future build adds.
 */
const FILE_WRITE_TOOLS = new Set([
    // Names agy 1.4.x reports.
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'sed_file',
    'notebook_edit',
    // Short aliases older builds / the offline harness use.
    'write_file',
    'edit_file',
]);
/**
 * The files a run changed, in the order agy touched them, de-duplicated.
 *
 * Derived from the tool steps instead of `git diff`: the child may run in a
 * non-git directory, and a repo can carry edits that predate the run.
 */
export function filesTouched(steps) {
    const seen = new Set();
    const out = [];
    for (const step of steps) {
        if (step.tool === null || !FILE_WRITE_TOOLS.has(step.tool.name))
            continue;
        // Prefer the path captured before truncation: once the parameters were
        // replaced by `{truncated, preview}`, none of the keys below exist any more.
        const path = step.tool.targetPath ?? targetPath(step.tool.parameters);
        if (path === null)
            continue;
        const key = path.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(path);
    }
    return out;
}
//# sourceMappingURL=agy-steps.js.map