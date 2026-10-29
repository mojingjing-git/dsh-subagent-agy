import type { Context } from '@deepseek-ai/cordis';
import type { AntigravityBackgroundHandle, PanelRunInput, TaskRecord } from './index.js';
import type { UsageReport } from './agy-usage.js';
/** One active run as reported by the provider's task layer. */
export interface ActiveRunInfo {
    task: string;
    label: string;
    cwd: string;
    background: boolean;
    startedAt: number;
}
export interface AgyPanelDeps {
    /** Synthetic session id used for panel-started runs. */
    sessionId: string;
    /** cwd the synthetic session pretends to have; the run's real cwd is per-record. */
    baseCwd: string;
    conversationsDir: string;
    annotationsDir: string;
    /**
     * `~/.gemini/antigravity-cli/brain` — agy's own transcript of every
     * conversation. It carries the token counters and the timestamps that the
     * conversation database does not have.
     */
    brainDir: string;
    /** `~/.gemini/antigravity-cli/conversation_summaries.db` */
    summariesDbPath: string;
    /** Where the panel keeps hidden conversation ids. */
    prefsPath: string;
    loadRecords(): Record<string, TaskRecord>;
    listActive(): ActiveRunInfo[];
    peekUsage(): UsageReport | null;
    readUsage(force?: boolean): Promise<UsageReport>;
    startRun(input: PanelRunInput): Promise<AntigravityBackgroundHandle>;
}
/** Register the panel's JSON routes once the optional web server exists. */
export declare function registerAgyPanel(ctx: Context, deps: AgyPanelDeps): void;
