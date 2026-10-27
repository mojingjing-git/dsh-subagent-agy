/**
 * Reads the four agy quota lines and turns them into the panel's badge.
 *
 * `agy --print "/usage"` prints TSV, one quota per line:
 *
 *   Gemini Models            Weekly Limit Remaining       80%   2026-10-29T10:17:27Z
 *   Gemini Models            Five Hour Limit Remaining    95%   2026-10-27T06:12:16Z
 *   Claude and GPT models    Weekly Limit Remaining       82%   2026-10-30T18:06:16Z
 *   Claude and GPT models    Five Hour Limit Remaining   100%   2026-10-27T07:03:17Z
 *
 * One probe costs 9–12 seconds and starts a real agy process, so every read
 * goes through a TTL cache with single-flight: ten concurrent panes must still
 * start exactly one probe. A failed probe degrades to the last known snapshot
 * instead of blanking the badge.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const GEMINI_FAMILY = 'Gemini Models';
export const CLAUDE_FAMILY = 'Claude and GPT models';
export const FIVE_HOUR = 'Five Hour Limit Remaining';
export const WEEKLY = 'Weekly Limit Remaining';
/** Parse the TSV printed by `agy --print "/usage"`. Unparseable lines are skipped. */
export function parseUsage(stdout) {
    const rows = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0)
            continue;
        // TSV is the real format; tolerate runs of spaces from a wrapped terminal.
        const cells = (line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/))
            .map((cell) => cell.trim())
            .filter((cell) => cell.length > 0);
        if (cells.length < 3)
            continue;
        const percent = Number.parseInt(cells[2].replace(/%$/, ''), 10);
        if (!Number.isFinite(percent))
            continue;
        const family = cells[0];
        if (family.length === 0)
            continue;
        rows.push({
            family,
            window: cells[1],
            percent,
            resetAt: cells[3] ?? '',
        });
    }
    return rows;
}
/** Which model family a configured model id belongs to. */
export function familyOfModel(model) {
    const lower = model.toLowerCase();
    if (lower.includes('gemini'))
        return GEMINI_FAMILY;
    if (lower.includes('claude') || lower.includes('gpt'))
        return CLAUDE_FAMILY;
    return GEMINI_FAMILY; // the plugin's default provider is Gemini
}
/** Pick the badge row: this plugin's model family, five-hour window, then anything usable. */
export function pickBadge(rows, family) {
    const sameFamily = rows.filter((row) => row.family === family);
    return (sameFamily.find((row) => row.window === FIVE_HOUR) ??
        sameFamily.find((row) => row.window.toLowerCase().includes('five')) ??
        sameFamily[0] ??
        rows.find((row) => row.window === FIVE_HOUR) ??
        rows[0] ??
        null);
}
/** True when the row's window is a short ("five hour") window rather than weekly. */
export function isShortWindow(row) {
    return row.window !== WEEKLY;
}
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/**
 * TTL + single-flight cache around one usage probe.
 *
 * `peek()` never spawns: it serves memory or the on-disk snapshot, which is what
 * a freshly opened panel should render instantly. `read()` refreshes and is
 * what the background poll calls.
 */
export class UsageReader {
    ttlMs;
    last = null;
    inflight = null;
    cachePath;
    runner;
    badgeFamily;
    constructor(options) {
        this.cachePath = options.cachePath;
        this.runner = options.runner;
        this.badgeFamily = options.badgeFamily;
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    }
    /** Last known snapshot (memory, then disk). Never spawns. */
    peek() {
        if (this.last !== null)
            return this.last;
        const cached = this.readCache();
        if (cached === null)
            return null;
        this.last = this.buildReport(cached.rows, cached.fetchedAt, Date.now() - cached.fetchedAt > this.ttlMs);
        return this.last;
    }
    /** Fresh snapshot when the TTL allows, otherwise a refresh (single-flight). */
    async read(force = false) {
        const current = this.peek();
        if (!force && current !== null && !current.stale)
            return current;
        if (this.inflight !== null)
            return this.inflight;
        const pending = this.probe(current).finally(() => {
            if (this.inflight === pending)
                this.inflight = null;
        });
        this.inflight = pending;
        return pending;
    }
    buildReport(rows, fetchedAt, stale) {
        return {
            rows,
            badge: pickBadge(rows, this.badgeFamily),
            badgeFamily: this.badgeFamily,
            fetchedAt,
            stale,
        };
    }
    async probe(previous) {
        try {
            const stdout = await this.runner();
            const rows = parseUsage(stdout);
            if (rows.length === 0)
                throw new Error('usage output contained no quota rows');
            const report = this.buildReport(rows, Date.now(), false);
            this.last = report;
            this.writeCache(report);
            return report;
        }
        catch (error) {
            const fallback = previous ?? this.readCache();
            if (fallback !== null) {
                const stale = this.buildReport(fallback.rows, fallback.fetchedAt, true);
                stale.error = error instanceof Error ? error.message : String(error);
                this.last = stale;
                return stale;
            }
            return {
                rows: [],
                badge: null,
                badgeFamily: this.badgeFamily,
                fetchedAt: 0,
                stale: true,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    readCache() {
        try {
            const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8'));
            if (parsed === null || typeof parsed !== 'object')
                return null;
            const snapshot = parsed;
            if (!Array.isArray(snapshot.rows) || typeof snapshot.fetchedAt !== 'number')
                return null;
            const rows = snapshot.rows.filter(isUsageRow);
            if (rows.length === 0)
                return null;
            return { rows, fetchedAt: snapshot.fetchedAt };
        }
        catch {
            return null;
        }
    }
    writeCache(report) {
        try {
            mkdirSync(dirname(this.cachePath), { recursive: true });
            // A per-process temp name: two writers sharing one `${path}.tmp` would
            // interleave (A writes, B overwrites, A renames B's bytes into place).
            const temp = `${this.cachePath}.${process.pid}.tmp`;
            const snapshot = { rows: report.rows, fetchedAt: report.fetchedAt };
            writeFileSync(temp, JSON.stringify(snapshot), 'utf8');
            renameSync(temp, this.cachePath);
        }
        catch {
            // A read-only home dir must not break the panel; memory cache still works.
        }
    }
}
function isUsageRow(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const row = value;
    return typeof row.family === 'string' && typeof row.window === 'string' && typeof row.percent === 'number';
}
/**
 * Run one `agy --print "/usage"` probe and return stdout.
 *
 * Kept here (not in index.ts) so the only shelling-out code the panel owns is
 * next to the parser it feeds. A non-zero exit is an error: an empty report is
 * more honest than a half-parsed one.
 */
export async function spawnUsage(exe, options) {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve, reject) => {
        execFile(exe, ['--print', '/usage'], {
            env: options.env,
            cwd: options.cwd,
            timeout: options.timeoutMs ?? 60_000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        }, (error, stdout) => {
            if (error !== null) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}
//# sourceMappingURL=agy-usage.js.map