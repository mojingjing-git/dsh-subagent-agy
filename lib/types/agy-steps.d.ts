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
/**
 * Bounds for the step timeline.
 *
 * A long run can produce thousands of steps, and a single tool call can carry
 * a whole command output. The panel shows the tail of the timeline, so the
 * plugin keeps a bounded window instead of growing without limit.
 */
export declare const MAX_STEPS = 200;
/** Characters of step text kept per step. */
export declare const MAX_STEP_TEXT = 4096;
/** Characters of a tool's arguments kept per step. */
export declare const MAX_TOOL_PARAM_TEXT = 2048;
/** The tool a step called, with its arguments and its failure, when known. */
export interface StepTool {
    name: string;
    /** Raw tool arguments; agy sends them as a JSON object. */
    parameters: Record<string, unknown> | null;
    /** The tool's own error message, when the call failed. */
    error: string | null;
}
/** One step of one run. */
export interface StepEvent {
    /** agy's `step_index` — the stable identity of the step inside its run. */
    index: number;
    /** `ACTIVE` while it runs, then `DONE` or `ERROR`. */
    state: string;
    /** `user_input`, `agent_response`, `tool`, … — agy's own vocabulary. */
    type: string;
    /** Text the model produced for this step, accumulated across events. */
    text: string;
    tool: StepTool | null;
    durationSeconds: number | null;
    usage: Record<string, number> | null;
    /**
     * When the plugin saw this step (epoch milliseconds).
     *
     * agy's protocol carries no timestamp, so this is the moment the event
     * arrived — the only clock available for the live timeline. Steps read back
     * from a finished conversation have no time at all.
     */
    at?: number;
}
/**
 * One `step_update` payload → a step.
 *
 * Returns `undefined` for anything that is not a usable step: the protocol
 * also emits `user_input` markers and, on other builds, payloads without a
 * step index. A malformed event must never break the run.
 */
export declare function parseStepUpdate(payload: unknown): StepEvent | undefined;
/**
 * Merge an incoming event into the step it belongs to.
 *
 * The state only ever moves forward (`ACTIVE` → `DONE`/`ERROR`), text is
 * appended, and every other field is filled in by whichever event carries it.
 */
export declare function mergeStep(existing: StepEvent, incoming: StepEvent): StepEvent;
/**
 * Fold one event into an ordered step list.
 *
 * Steps keep the order agy gave them (by index), and a repeated index
 * updates the step in place instead of appending a second one. The fold is
 * the module's only state sink, so the bounded window lives here, not in the
 * snapshot: without it a long run grows the array (and every payload built
 * from it) without limit.
 */
export declare function mergeStepInto(steps: readonly StepEvent[], incoming: StepEvent): StepEvent[];
/**
 * A bounded copy of the timeline, newest steps last.
 *
 * The window keeps the most recent {@link MAX_STEPS} steps so a long run
 * cannot grow the payload without limit; every step inside it is already
 * normalized.
 */
export declare function snapshotSteps(steps: readonly StepEvent[]): StepEvent[];
