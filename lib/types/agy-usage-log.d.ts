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
    /** Reuse an earlier scan (the quota estimate already needed the raw rows). */
    preScanned?: TokenScan;
}
/** Scan both stores and return the rolling window plus the local total. */
export declare function readTokenUsage(options: TokenUsageOptions): TokenUsageReport;
export interface TokenScan {
    /** Every token-bearing step across both stores, with millisecond stamps. */
    rows: TokenRow[];
    conversations: number;
    reused: number;
}
/**
 * The raw scan behind `readTokenUsage`. Exposed because the quota estimate needs
 * the steps' own timestamps: a day bucket is fine for "what did today cost", and
 * badly wrong for "what did these twenty minutes cost".
 */
export declare function scanTokenRows(options: TokenUsageOptions): TokenScan;
