/** One token-bearing step. `t` is a Unix epoch in milliseconds. */
export interface TokenRow {
    t: number;
    input: number;
    output: number;
    cacheRead: number;
}
export interface TokenBucket {
    input: number;
    output: number;
    cacheRead: number;
    /** input + output + cacheRead — what the account actually moved. */
    total: number;
    steps: number;
}
export interface TokenDay extends TokenBucket {
    /** Local calendar day, `YYYY-MM-DD`. */
    day: string;
}
export interface TokenUsageReport {
    scannedAt: number;
    /** Rolling window length in days (the last N local days, including today). */
    windowDays: number;
    days: TokenDay[];
    window: TokenBucket;
    allTime: TokenBucket & {
        from: string | null;
        to: string | null;
        conversations: number;
    };
    /** Transcript files read, and how many were reused from the cache. */
    files: number;
    reused: number;
    error?: string;
}
/** Local calendar day of an epoch, as `YYYY-MM-DD`. */
export declare function dayKeyOf(ms: number): string;
/**
 * Aggregate rows into `windowDays` zero-filled local days ending today, plus an
 * all-time total. Pure: no I/O, so the window arithmetic is testable.
 */
export declare function summarize(rows: readonly TokenRow[], now: number, windowDays: number): Pick<TokenUsageReport, 'days' | 'window' | 'allTime' | 'windowDays'>;
/** Parse one transcript file into token rows. Unparsable lines are skipped. */
export declare function parseTranscript(text: string): TokenRow[];
export interface TokenUsageOptions {
    /** Absolute `brain` directories to scan. */
    roots: readonly string[];
    /** Where the (mtime, size) index lives; the file is optional. */
    cachePath: string;
    now?: number;
    windowDays?: number;
}
/** Scan both stores and return the rolling window plus the local total. */
export declare function readTokenUsage(options: TokenUsageOptions): TokenUsageReport;
