/**
 * @dsh-external/dsh-subagent-antigravity
 *
 * Product subagent provider for Google Antigravity CLI (agy), following the
 * official `dsh-subagent-codex` / `dsh-subagent-claude-code` pattern:
 * one trusted provider on `ctx.subagents` (name: `antigravity`) plus two
 * model-facing tools (`antigravity` for new tasks, `antigravity_followup`
 * for continuing a previous task).
 *
 * Every delegation spawns a fresh `agy -p <task>` process in the parent
 * session's workspace, waits for the final answer (bounded by
 * `--print-timeout` plus a local watchdog), and returns only the final text.
 * No Gemini API key is involved: agy authenticates through the user's cached
 * Antigravity login (system keyring / Google Sign-In).
 *
 * Continuation: runs use `--output-format json`, whose reply carries the
 * agy `conversation_id`; the provider records it (in-memory bridge plus a
 * durable `~/.dsh/agy-conversations.json` registry), and follow-ups spawn
 * `agy -p <prompt> --conversation <id>` so the agent's full context carries
 * over. This is agy-side session resume — it is NOT the DSH continuable
 * subagent machinery (which requires an in-process DSH child session), so
 * the follow-up is its own tool rather than `send_message`/`interrupt_agent`.
 *
 * Background mode (`background: true`): the run registers with the generic
 * `ctx.jobs` runtime and returns a job id immediately. It spawns agy with
 * `--output-format stream-json` (probe-gated) and streams the incremental
 * `text_delta` chunks through the job's `readOutput`, so `job_output`
 * returns live progress and `job_kill` stops it; the final read carries a
 * `[task: ...]` line so the conversation can still be followed up.
 *
 * Robustness notes:
 * - Supported agy flags are probed once per provider instance (`agy help`),
 *   so `--output-format` / `--conversation` / `--sandbox` / `--add-dir` /
 *   `stream-json` are only emitted when the installed build understands them.
 * - A local watchdog (printTimeoutMs + watchdogMarginMs) terminates a hung
 *   agy tree instead of waiting forever.
 * - The follow-up registry is written atomically (tmp + rename) and all
 *   writes are serialized through a module-level queue, so concurrent tool
 *   calls cannot clobber each other.
 * - The registry self-heals: a corrupt or wrongly-shaped file is backed up
 *   once (`*.corrupt`, mtime-guarded) and reset instead of being silently
 *   overwritten by the next save; malformed entries are dropped with a
 *   warning; and the read-modify-write cycles themselves are serialized, so
 *   concurrent runs cannot lose each other's records.
 * - A tasks/cancel layer (`antigravity_tasks` / `antigravity_cancel`) lists
 *   in-flight runs plus durable history (restart-safe) and can stop a
 *   running agy; all in-flight runs are terminated on plugin stop/update.
 * - Follow-ups to the SAME conversation are serialized per conversation id,
 *   so two concurrent prompts cannot corrupt one agy conversation file.
 * - Prompts are capped at MAX_ARGV_PROMPT_CHARS for argv safety.
 *
 * Process lifecycle is owned by the shared `ctx.subprocess` seam (credential
 * scrubbing, tree-scoped SIGTERM→SIGKILL escalation, whole-tree exit), and
 * result settlement follows the out-of-process subagent contract
 * (`settleRunResult` + `subprocessRunHandle`): `result` never rejects.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
export declare const name = "@dsh-external/dsh-subagent-antigravity";
export declare const inject: string[];
/** Register the `antigravity` job kind with the generic jobs registry (id prefix: `antigravity-N`). */
declare module '@deepseek-ai/dsh-subagent' {
    interface SubagentResult {
        /** Absolute path of the NDJSON event stream this run recorded, when one was written. */
        readonly transcript?: string;
    }
}
import type { JobKindMap as _JobsKindMap } from '@deepseek-ai/dsh-jobs';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        antigravity: 'antigravity';
    }
}
export type { _JobsKindMap };
export declare const Config: any;
/** Runtime config after schemastery defaults. */
export interface Config {
    providerName: string;
    toolName: string;
    followupToolName: string;
    command: string;
    model: string;
    effort: string;
    agent: string;
    printTimeoutMs: number;
    watchdogMarginMs: number;
    backgroundTimeoutMs: number;
    skipPermissions: boolean;
    sandbox: boolean;
    avoidBrowser: boolean;
    avoidLargeReads: boolean;
    autoLoginWindow: boolean;
    loginToolName: string;
    loginWindowMinimized: boolean;
    tasksToolName: string;
    cancelToolName: string;
    outputFormat: 'json' | 'text';
    transcript: boolean;
    transcriptDir: string;
    flagCachePath: string | undefined;
    extraArgs: string[];
    cwd: string;
    addDirs: string[];
    env: Record<string, string>;
    proxy: string;
    registryPath: string;
    disposeGraceMs: number;
}
/** One durable task entry: the agy conversation a follow-up resumes. */
export interface TaskRecord {
    conversationId: string;
    cwd: string;
    label: string;
    createdAt: number;
}
/** Minimal logger shape for registry persistence (ctx.logger is assignable). */
export interface RegistryLogger {
    warn(message: string): void;
}
/** Durable follow-up registry (task key = the DSH run id). */
export declare function registryFilePath(config: Config): string;
/**
 * Load the durable follow-up registry, self-healing on damage: a missing
 * file is a normal fresh state; a corrupt or wrongly-shaped file is backed
 * up once (`.corrupt`, guarded by mtime) instead of being silently
 * overwritten by the next save; malformed entries are dropped with a
 * warning. A crash or hand-edit can never silently wipe the history.
 */
export declare function loadTaskRegistry(config: Config, logger?: RegistryLogger): Record<string, TaskRecord>;
export declare function saveTaskRegistry(config: Config, records: Record<string, TaskRecord>, logger?: RegistryLogger): Promise<void>;
/**
 * Atomically read-modify-write the durable registry through the same
 * serialization queue as {@link saveTaskRegistry}: concurrent tool calls
 * (e.g. a foreground and a background run finishing at the same time) can
 * no longer lose each other's records to a stale read-modify-write race.
 * The write itself is atomic (tmp + rename) and failures are contained
 * (best-effort persistence, like saveTaskRegistry).
 */
export declare function updateTaskRegistry(config: Config, mutate: (records: Record<string, TaskRecord>) => void, logger?: RegistryLogger): Promise<void>;
/** The seam request shape the follow-up tool hands to the provider directly. */
export interface FollowupRequest {
    label?: string;
    prompt: ContentBlock[];
    parent: Agent;
    signal: AbortSignal;
}
/** Hooks shape registered with `ctx.jobs` for a background agy run (mirrors dsh-tool-pwsh's background adaptation). */
export interface AntigravityBackgroundHandle {
    /** Stop the run (job_kill). */
    cancel: (reason?: string) => void;
    /** Settles with the generic task-outcome vocabulary. */
    done: Promise<{
        status: 'killed' | 'completed' | 'failed';
        detail: string;
    }>;
    /** Incremental output delta since the previous read. */
    readOutput: () => string;
}
/** One in-flight run tracked for the tasks/cancel tool layer (foreground or background). */
export interface ActiveRunInfo {
    label: string;
    cwd: string;
    startedAt: number;
    background: boolean;
    cancel: () => void;
}
export declare function apply(ctx: Context, config: Config): void;
