import type { UsageReport } from './agy-usage.js';
import type { TokenDay } from './agy-usage-log.js';
/** One quota reading. `percent` is what is *left*, as agy prints it. */
export interface QuotaSnapshot {
    t: number;
    family: string;
    window: string;
    percent: number;
    resetAt?: string;
}
export interface QuotaEstimate {
    family: string;
    window: string;
    /** Percentage points consumed between the first and last snapshot. */
    usedPoints: number;
    /** Tokens spent in the same span (whole account, hence "approximate"). */
    tokens: number;
    /** Tokens per percentage point, or null when the span is too thin. */
    tokensPerPoint: number | null;
    /** tokensPerPoint × 100 — the window's estimated capacity. */
    capacity: number | null;
    from: number;
    to: number;
    samples: number;
}
/** Append a snapshot per quota row, but only when it says something new. */
export declare function appendQuotaSnapshot(path: string, report: UsageReport, now: number, previous: Map<string, QuotaSnapshot>): void;
/** Read the snapshot log; a missing or damaged file reads as "no history yet". */
export declare function readQuotaLog(path: string): QuotaSnapshot[];
/**
 * Tokens per percentage point, per quota row. Only pairs inside one reset
 * window are usable: a reset makes the percentage jump back up and the delta
 * meaningless.
 */
export declare function estimateQuota(snapshots: readonly QuotaSnapshot[], days: readonly TokenDay[], now: number, maxAgeMs?: number): QuotaEstimate[];
