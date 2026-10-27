/** One quota cell: a model family, a window, and when it resets. */
export interface UsageRow {
    family: string;
    window: string;
    percent: number;
    resetAt: string;
}
/** The whole picture the panel renders: four rows plus the footer badge. */
export interface UsageReport {
    rows: UsageRow[];
    badge: UsageRow | null;
    badgeFamily: string;
    fetchedAt: number;
    stale: boolean;
    loading?: boolean;
    error?: string;
}
export declare const GEMINI_FAMILY = "Gemini Models";
export declare const CLAUDE_FAMILY = "Claude and GPT models";
export declare const FIVE_HOUR = "Five Hour Limit Remaining";
export declare const WEEKLY = "Weekly Limit Remaining";
/** Parse the TSV printed by `agy --print "/usage"`. Unparseable lines are skipped. */
export declare function parseUsage(stdout: string): UsageRow[];
/** Which model family a configured model id belongs to. */
export declare function familyOfModel(model: string): string;
/** Pick the badge row: this plugin's model family, five-hour window, then anything usable. */
export declare function pickBadge(rows: readonly UsageRow[], family: string): UsageRow | null;
/** True when the row's window is a short ("five hour") window rather than weekly. */
export declare function isShortWindow(row: UsageRow): boolean;
export interface UsageReaderOptions {
    /** Spawns one probe and returns stdout. Injected so tests never call agy. */
    runner: () => Promise<string>;
    /** Where the last good snapshot is kept across restarts. */
    cachePath: string;
    /** How long a snapshot stays fresh. */
    ttlMs?: number;
    /** Model family the footer badge should come from. */
    badgeFamily: string;
}
/**
 * TTL + single-flight cache around one usage probe.
 *
 * `peek()` never spawns: it serves memory or the on-disk snapshot, which is what
 * a freshly opened panel should render instantly. `read()` refreshes and is
 * what the background poll calls.
 */
export declare class UsageReader {
    private readonly ttlMs;
    private last;
    private inflight;
    private readonly cachePath;
    private readonly runner;
    private readonly badgeFamily;
    constructor(options: UsageReaderOptions);
    /** Last known snapshot (memory, then disk). Never spawns. */
    peek(): UsageReport | null;
    /** Fresh snapshot when the TTL allows, otherwise a refresh (single-flight). */
    read(force?: boolean): Promise<UsageReport>;
    private buildReport;
    private probe;
    private readCache;
    private writeCache;
}
/**
 * Run one `agy --print "/usage"` probe and return stdout.
 *
 * Kept here (not in index.ts) so the only shelling-out code the panel owns is
 * next to the parser it feeds. A non-zero exit is an error: an empty report is
 * more honest than a half-parsed one.
 */
export declare function spawnUsage(exe: string, options: {
    env: Record<string, string>;
    cwd: string;
    timeoutMs?: number;
}): Promise<string>;
