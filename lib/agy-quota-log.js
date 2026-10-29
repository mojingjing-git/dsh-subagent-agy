/**
 * Quota snapshots — the other half of "how big is a month, actually".
 *
 * `/usage` answers in percent ("Weekly Limit Remaining 80%"), the transcript
 * log answers in tokens. Neither alone says how much a plan allows; together
 * they do: tokens burned between two snapshots ÷ percentage points lost is what
 * one point costs, and ×100 is the window's capacity.
 *
 * Snapshots are appended to a JSONL file beside the plugin. Only changes are
 * written (same percent + same reset time is not news), so a day of five-minute
 * polling adds a handful of lines per row rather than hundreds.
 *
 * The estimate is deliberately labelled approximate: tokens cannot be attributed
 * per model family without reading every conversation's model, so the token
 * figure is the whole account's spend inside the snapshot span. When a family's
 * quota moves and another family's work dominates, the number is an upper bound
 * — which is the safe direction for "how much do I get per month".
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
const DEDUPE_MS = 30 * 60 * 1000;
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
 * Tokens per percentage point, per quota row. Only pairs inside one reset
 * window are usable: a reset makes the percentage jump back up and the delta
 * meaningless.
 */
export function estimateQuota(snapshots, days, now, maxAgeMs = 30 * 86_400_000) {
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
            estimates.push({ family, window, usedPoints: 0, tokens: 0, tokensPerPoint: null, capacity: null, from: last.t, to: last.t, samples: list.length });
            continue;
        }
        // Walk back to the earliest snapshot in the same reset window.
        const sameReset = list.filter((snapshot) => snapshot.resetAt === last.resetAt);
        const first = sameReset[0];
        const usedPoints = first.percent - last.percent;
        const tokens = tokensBetween(days, first.t, last.t);
        const tokensPerPoint = usedPoints > 0 && tokens > 0 ? tokens / usedPoints : null;
        estimates.push({
            family: last.family,
            window: last.window,
            usedPoints: Math.max(0, usedPoints),
            tokens,
            tokensPerPoint,
            capacity: tokensPerPoint === null ? null : Math.round(tokensPerPoint * 100),
            from: first.t,
            to: last.t,
            samples: sameReset.length,
        });
    }
    return estimates;
}
function splitKey(key) {
    const index = key.indexOf('|');
    return [key.slice(0, index), key.slice(index + 1)];
}
/** Whole-account tokens whose local day falls inside the span (day granularity). */
function tokensBetween(days, from, to) {
    let total = 0;
    for (const day of days) {
        const start = Date.parse(`${day.day}T00:00:00`);
        if (Number.isNaN(start))
            continue;
        const end = start + 86_400_000;
        if (end > from && start <= to)
            total += day.total;
    }
    return total;
}
//# sourceMappingURL=agy-quota-log.js.map