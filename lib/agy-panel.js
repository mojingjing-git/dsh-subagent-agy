import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { listConversations } from './agy-conversations.js';
import { readConversationHistory } from './agy-history.js';
import { readConversationSummaries } from './agy-summaries.js';
const MAX_RUN_TEXT = 400 * 1024;
const MAX_RUNS = 20;
const POLL_MS = 250;
/** A cheap fingerprint of a step list, used to detect that it changed. */
function stepsVersion(steps) {
    let chars = 0;
    for (const step of steps)
        chars += step.text.length;
    const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
    return `${steps.length}:${chars}:${last?.index ?? -1}:${last?.state ?? ''}`;
}
/** In-memory run table with exactly one consumer of the handle's output cursor. */
class RunStore {
    runs = new Map();
    seq = 0;
    start(conversationId, label, handle) {
        this.seq += 1;
        const id = `panel-${Date.now().toString(36)}-${this.seq.toString(36)}`;
        const run = {
            id,
            conversationId,
            label,
            status: 'running',
            text: '',
            tool: null,
            startedAt: Date.now(),
            endedAt: null,
            handle,
            steps: [],
            stepsVersion: '0',
        };
        this.runs.set(id, run);
        run.timer = setInterval(() => this.drain(run), POLL_MS);
        run.timer.unref?.();
        void handle.done.then((outcome) => {
            this.drain(run);
            run.status = outcome.status === 'completed' ? 'done' : outcome.status === 'killed' ? 'cancelled' : 'failed';
            run.endedAt = Date.now();
            if (outcome.status !== 'completed')
                run.error = outcome.detail;
            this.stopTimer(run);
            this.prune();
        }, (error) => {
            this.drain(run);
            run.status = 'failed';
            run.endedAt = Date.now();
            run.error = error instanceof Error ? error.message : String(error);
            this.stopTimer(run);
            this.prune();
        });
        this.prune();
        return id;
    }
    /** True while a run for this conversation is still going. */
    isRunning(conversationId) {
        for (const run of this.runs.values()) {
            if (run.conversationId === conversationId && run.status === 'running')
                return true;
        }
        return false;
    }
    read(id, since) {
        const run = this.runs.get(id);
        if (run === undefined)
            return { found: false };
        const reset = !Number.isFinite(since) || since < 0 || since > run.text.length;
        const cursor = reset ? 0 : since;
        return { found: true, run, cursor, reset };
    }
    cancel(id) {
        const run = this.runs.get(id);
        if (run === undefined || run.status !== 'running')
            return false;
        run.status = 'cancelled';
        run.endedAt = Date.now();
        this.stopTimer(run);
        run.handle.cancel();
        return true;
    }
    drain(run) {
        try {
            const delta = run.handle.readOutput();
            if (delta.length > 0) {
                run.text += delta;
                if (run.text.length > MAX_RUN_TEXT)
                    run.text = run.text.slice(run.text.length - MAX_RUN_TEXT);
            }
            run.tool = run.handle.tool?.() ?? run.tool;
            const steps = run.handle.steps?.();
            if (steps !== undefined) {
                const version = stepsVersion(steps);
                if (version !== run.stepsVersion) {
                    run.steps = steps;
                    run.stepsVersion = version;
                }
            }
        }
        catch {
            // A dead handle must not stop the timer from settling the run.
        }
    }
    stopTimer(run) {
        if (run.timer !== undefined) {
            clearInterval(run.timer);
            run.timer = undefined;
        }
    }
    prune() {
        if (this.runs.size <= MAX_RUNS)
            return;
        const finished = [...this.runs.values()]
            .filter((run) => run.status !== 'running')
            .sort((a, b) => a.startedAt - b.startedAt);
        for (const run of finished) {
            if (this.runs.size <= MAX_RUNS)
                break;
            this.stopTimer(run);
            this.runs.delete(run.id);
        }
    }
}
/** The `jsonRoute` shape `@deepseek-ai/dsh-host-webserver` accepts. */
function jsonRoute(path, handler) {
    return {
        kind: 'exact',
        path,
        handler: async (req, res) => {
            try {
                if (req.method !== 'POST') {
                    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
                    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
                    return;
                }
                const body = await readJsonBody(req);
                const [status, payload] = await handler({ body });
                res.writeHead(status, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify(payload));
            }
            catch (error) {
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                }
                res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            }
        },
    };
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1024 * 1024)
            throw new Error('request body too large');
        chunks.push(buffer);
    }
    if (chunks.length === 0)
        return {};
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text.length === 0)
        return {};
    return JSON.parse(text);
}
const ok = (payload) => [200, { ok: true, ...payload }];
const bad = (error) => [400, { ok: false, error }];
function readPrefs(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed !== null && typeof parsed === 'object') {
            const hidden = parsed.hidden;
            if (Array.isArray(hidden))
                return { hidden: hidden.filter((id) => typeof id === 'string') };
        }
    }
    catch {
        // Missing or corrupt prefs simply mean "nothing hidden".
    }
    return { hidden: [] };
}
function writePrefs(path, prefs) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(prefs), 'utf8');
    renameSync(temp, path);
}
/** Register the panel's JSON routes once the optional web server exists. */
export function registerAgyPanel(ctx, deps) {
    const store = new RunStore();
    const logger = ctx.logger ?? { warn: (message) => console.warn(message) };
    const routes = [
        jsonRoute('/api-agy/usage', ({ body }) => {
            const force = body?.force === true;
            const peeked = deps.peekUsage();
            if (peeked === null || peeked.stale || force) {
                // Never block the first paint on a 9–12 s probe: answer with the cached
                // snapshot (or a loading placeholder) and let the next poll pick it up.
                void deps.readUsage(force).catch((error) => {
                    logger.warn(`dsh-subagent-antigravity: usage probe failed: ${String(error)}`);
                });
            }
            const report = peeked ?? {
                rows: [],
                badge: null,
                badgeFamily: '',
                fetchedAt: 0,
                stale: true,
                loading: true,
            };
            return ok({ ...report, loading: peeked === null });
        }),
        jsonRoute('/api-agy/conversations', async () => {
            const prefs = readPrefs(deps.prefsPath);
            let items = [];
            try {
                // The summary table knows when a conversation changed last; the
                // registry does not. It is optional — without it the list still shows.
                const summaries = await readConversationSummaries(deps.summariesDbPath);
                items = listConversations({
                    records: deps.loadRecords(),
                    conversationsDir: deps.conversationsDir,
                    annotationsDir: deps.annotationsDir,
                    hidden: prefs.hidden,
                    summaries,
                });
            }
            catch (error) {
                logger.warn(`dsh-subagent-antigravity: conversation list failed: ${String(error)}`);
            }
            return ok({ items });
        }),
        jsonRoute('/api-agy/running', () => {
            const runs = deps.listActive();
            return ok({ count: runs.length, runs });
        }),
        // The step timeline of a conversation that is not running any more — read
        // back from agy's own database.
        jsonRoute('/api-agy/history', async ({ body }) => {
            const input = body;
            const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : '';
            if (conversationId.length === 0)
                return bad('conversationId is required');
            const history = await readConversationHistory(conversationId, deps.conversationsDir);
            return ok({ ...history });
        }),
        jsonRoute('/api-agy/continue', async ({ body }) => {
            const input = body;
            const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : '';
            const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
            if (conversationId.length === 0)
                return bad('conversationId is required');
            if (prompt.trim().length === 0)
                return bad('prompt is empty');
            if (prompt.length > 30_000)
                return bad('prompt is too long (max 30000 characters)');
            if (store.isRunning(conversationId))
                return [409, { ok: false, error: 'this conversation is already running' }];
            const record = Object.values(deps.loadRecords()).find((entry) => entry.conversationId === conversationId);
            if (record === undefined)
                return bad('unknown conversation: not started by this plugin');
            if (!existsSync(record.cwd))
                return bad(`project directory is gone: ${record.cwd}`);
            try {
                const handle = await deps.startRun({
                    sessionId: deps.sessionId,
                    baseCwd: deps.baseCwd,
                    label: record.label.trim().length > 0 ? record.label : 'AGY 接着跑',
                    prompt,
                    conversationId,
                    cwd: record.cwd,
                });
                const runId = store.start(conversationId, record.label, handle);
                return ok({ runId });
            }
            catch (error) {
                return bad(error instanceof Error ? error.message : String(error));
            }
        }),
        jsonRoute('/api-agy/run', ({ body }) => {
            const input = body;
            const runId = typeof input?.runId === 'string' ? input.runId : '';
            const since = typeof input?.since === 'number' && Number.isFinite(input.since) ? input.since : 0;
            if (runId.length === 0)
                return bad('runId is required');
            const result = store.read(runId, since);
            if (!result.found)
                return bad('unknown run (it may have expired)');
            const { run, cursor, reset } = result;
            return ok({
                status: run.status,
                text: run.text.slice(cursor),
                cursor: run.text.length,
                reset,
                tool: run.tool,
                // The step timeline is sent whole; `stepsVersion` says whether it
                // changed since the last poll.
                steps: run.steps,
                stepsVersion: run.stepsVersion,
                elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt,
                ...(run.error !== undefined ? { error: run.error } : {}),
            });
        }),
        jsonRoute('/api-agy/cancel', ({ body }) => {
            const input = body;
            const runId = typeof input?.runId === 'string' ? input.runId : '';
            if (runId.length === 0)
                return bad('runId is required');
            return store.cancel(runId) ? ok({}) : bad('run is not running');
        }),
        jsonRoute('/api-agy/prefs', ({ body }) => {
            const input = body;
            const prefs = readPrefs(deps.prefsPath);
            const hidden = new Set(prefs.hidden);
            if (typeof input?.hide === 'string' && input.hide.length > 0)
                hidden.add(input.hide);
            if (typeof input?.show === 'string' && input.show.length > 0)
                hidden.delete(input.show);
            const next = { hidden: [...hidden] };
            writePrefs(deps.prefsPath, next);
            return ok({ hidden: next.hidden });
        }),
    ];
    const injection = ctx;
    if (typeof injection.inject !== 'function') {
        // Minimal hosts (the offline test harness) have no service registry; the
        // tools must still boot there.
        logger?.warn('dsh-subagent-antigravity: ctx.inject is unavailable; panel routes not registered');
        return;
    }
    injection.inject(['webServer'], (webCtx) => {
        for (const route of routes) {
            try {
                webCtx.webServer.register(route);
            }
            catch (error) {
                // A duplicate path means a second plugin instance; report it instead of
                // failing the whole apply (which would take the tools down too).
                logger?.warn(`dsh-subagent-antigravity: failed to register panel route: ${String(error)}`);
            }
        }
    });
}
//# sourceMappingURL=agy-panel.js.map