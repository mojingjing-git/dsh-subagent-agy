import type { UsageReport } from './agy-usage.js';
import type { TokenRow } from './agy-usage-log.js';
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
    /** Tokens spent between those two snapshots, to the millisecond. */
    tokens: number;
    /** Tokens per percentage point, or null when the sample is unusable. */
    tokensPerPoint: number | null;
    /** tokensPerPoint × 100 — the window's estimated capacity. */
    capacity: number | null;
    from: number;
    to: number;
    /** Wall-clock length of the measurement. */
    spanMs: number;
    samples: number;
    /** Why there is no number yet; null once the estimate is usable. */
    reason: 'few-samples' | 'short-span' | 'no-spend' | null;
}
/** Append a snapshot per quota row, but only when it says something new. */
export declare function appendQuotaSnapshot(path: string, report: UsageReport, now: number, previous: Map<string, QuotaSnapshot>): void;
/** Read the snapshot log; a missing or damaged file reads as "no history yet". */
export declare function readQuotaLog(path: string): QuotaSnapshot[];
/**
 * Tokens per percentage point, per quota row.
 *
 * `rows` are the token steps themselves (millisecond stamps), not day buckets:
 * bucketing by day is fine for "what did today cost" and badly wrong for "what
 * did these twenty minutes cost", which is exactly the span a fresh log has.
 */
export declare function estimateQuota(snapshots: readonly QuotaSnapshot[], rows: readonly TokenRow[], now: number, options?: {
    maxAgeMs?: number;
    minSpanMs?: number;
}): QuotaEstimate[];
