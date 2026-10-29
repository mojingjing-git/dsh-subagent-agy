/**
 * Quota snapshots — the other half of "how big is a month, actually".
 *
 * `/usage` answers in percent ("Weekly Limit Remaining 80%"), the transcript
 * log answers in tokens. Neither alone says how much a plan allows; together
 * they do: tokens burned between two snapshots ÷ percentage points lost is what
 * one point costs, and ×100 is the window's capacity.
 *
 * Two rules keep the number honest:
 *
 * 1. Only snapshots inside one **reset window** are comparable. A reset sends
 *    the percentage back up and a delta across it is meaningless.
 * 2. The span must be long enough to be signal. Percentages are integers, so a
 *    one-point move over twenty minutes is rounding noise — an early version
 *    divided a whole day's tokens by that point and reported 19B per month.
 *    Two hours is the floor; a week of history is the good case.
 *
 * Snapshots are appended to a JSONL file beside the plugin. Only changes are
 * written (same percent + same reset time is not news), so five-minute polling
 * adds a handful of lines per row a day rather than hundreds.
 *
 * The token figure is the whole account's spend inside the span: attributing it
 * per model family would mean reading every conversation's model, and a wrong
 * split would inflate the estimate silently.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
const DEDUPE_MS = 30 * 60 * 1000;
const HOUR = 3_600_000;
/** Append a snapshot per quota row, but only when it says something new. */
export function appendQuotaSnapshot(path, report, now, previous) {
    const rows = [];
    for (const row of report.rows ?? []) {
        if (typeof row.percent !== 'number' || !Number.isFinite(row.percent))
            continue;
        const key = `${row.family}|${row.window}`;
        const last = previous.get(key);
        const changed = last === undefined || last.percent !== row.percent || last.resetAt !== row.resetAt;
        const stale = last !== undefined && now - last.t > DEDUPE_MS;
        if (!changed && !stale)
            continue;
        const snapshot = { t: now, family: row.family, window: row.window, percent: row.percent, resetAt: row.resetAt };
        rows.push(snapshot);
        previous.set(key, snapshot);
    }
    if (rows.length === 0)
        return;
    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    }
    catch {
        // A read-only profile must not turn a quota poll into an error.
    }
}
/** Read the snapshot log; a missing or damaged file reads as "no history yet". */
export function readQuotaLog(path) {
    if (!existsSync(path))
        return [];
    let text = '';
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
        if (line.length === 0 || line[0] !== '{')
            continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed.t !== 'number' || typeof parsed.percent !== 'number')
                continue;
            if (typeof parsed.family !== 'string' || typeof parsed.window !== 'string')
                continue;
            rows.push({ t: parsed.t, family: parsed.family, window: parsed.window, percent: parsed.percent, resetAt: parsed.resetAt });
        }
        catch {
            // Skip the half-written line a crash can leave behind.
        }
    }
    return rows;
}
/**
 * Tokens per percentage point, per quota row.
 *
 * `rows` are the token steps themselves (millisecond stamps), not day buckets:
 * bucketing by day is fine for "what did today cost" and badly wrong for "what
 * did these twenty minutes cost", which is exactly the span a fresh log has.
 */
export function estimateQuota(snapshots, rows, now, options = {}) {
    const maxAgeMs = options.maxAgeMs ?? 30 * 86_400_000;
    const minSpanMs = options.minSpanMs ?? 2 * HOUR;
    const byKey = new Map();
    for (const snapshot of snapshots) {
        if (now - snapshot.t > maxAgeMs)
            continue;
        const key = `${snapshot.family}|${snapshot.window}`;
        const list = byKey.get(key) ?? [];
        list.push(snapshot);
        byKey.set(key, list);
    }
    const estimates = [];
    for (const [key, list] of byKey) {
        list.sort((left, right) => left.t - right.t);
        const last = list[list.length - 1];
        if (list.length < 2) {
            const [family, window] = splitKey(key);
            estimates.push(blank(family, window, last, list.length, 'few-samples'));
            continue;
        }
        // Walk back to the earliest snapshot in the same reset window.
        const sameReset = list.filter((snapshot) => snapshot.resetAt === last.resetAt);
        const first = sameReset[0];
        const spanMs = last.t - first.t;
        const usedPoints = first.percent - last.percent;
        const base = {
            family: last.family,
            window: last.window,
            usedPoints: Math.max(0, usedPoints),
            tokens: tokensBetween(rows, first.t, last.t),
            from: first.t,
            to: last.t,
            spanMs,
            samples: sameReset.length,
        };
        if (sameReset.length < 2) {
            estimates.push({ ...base, tokensPerPoint: null, capacity: null, reason: 'few-samples' });
            continue;
        }
        if (spanMs < minSpanMs) {
            estimates.push({ ...base, tokensPerPoint: null, capacity: null, reason: 'short-span' });
            continue;
        }
        if (base.usedPoints <= 0 || base.tokens <= 0) {
            estimates.push({ ...base, tokensPerPoint: null, capacity: null, reason: 'no-spend' });
            continue;
        }
        const tokensPerPoint = base.tokens / base.usedPoints;
        estimates.push({ ...base, tokensPerPoint, capacity: Math.round(tokensPerPoint * 100), reason: null });
    }
    return estimates;
}
function blank(family, window, last, samples, reason) {
    return {
        family,
        window,
        usedPoints: 0,
        tokens: 0,
        tokensPerPoint: null,
        capacity: null,
        from: last.t,
        to: last.t,
        spanMs: 0,
        samples,
        reason,
    };
}
function splitKey(key) {
    const index = key.indexOf('|');
    return [key.slice(0, index), key.slice(index + 1)];
}
/** Whole-account tokens whose own timestamp lands inside the span. */
function tokensBetween(rows, from, to) {
    let total = 0;
    for (const row of rows) {
        if (row.t >= from && row.t <= to)
            total += row.input + row.output + row.cacheRead;
    }
    return total;
}
//# sourceMappingURL=agy-quota-log.js.map