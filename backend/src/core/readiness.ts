/**
 * WordJS — the /readyz verdict, computed at most once per TTL.
 *
 * /readyz is unauthenticated and exempt from the rate limiters (an orchestrator's probe must never be
 * throttled into a restart), but each evaluation reads the config file synchronously and runs a
 * database query. Without a cache every request to it was that work, at whatever rate a client chose
 * to send it. The verdict is therefore cached for a short TTL (1 s by default) and concurrent callers
 * share one in-flight evaluation, so the probe's cost is bounded by time, not by request rate. One
 * second is well under any probe interval, so a real state change is still reported promptly.
 *
 * The database check has a DEADLINE (3 s by default, WORDJS_READINESS_TIMEOUT_MS). A query that never
 * settles — a database that accepts the connection and then stops answering, a dropped network path —
 * used to keep the shared in-flight evaluation pending forever, so every later /readyz waited on it
 * and the instance never reported anything again. Past the deadline the probe answers 503 `not_ready`
 * (`db: 'timeout'`) and the next request evaluates afresh. While the stalled query is still pending, no
 * second one is started: the probe answers the timeout verdict straight away instead of piling a new
 * stuck query onto the pool every second. The check it runs also carries the deadline as a server-side
 * statement timeout where the driver supports one (core/system-health.ts checkDatabase).
 *
 * A failure's detail goes to the log; the response only says the check failed — an exception message
 * can name hosts, paths or driver internals and the endpoint is public.
 */

export interface ReadinessResult {
    statusCode: number;
    body: Record<string, unknown>;
}

export interface ReadinessDeps {
    isInstalled: () => boolean;
    isBooted: () => boolean;
    checkDatabase: (opts: { timeoutMs: number }) => Promise<{ status: string }>;
    onError?: (err: unknown) => void;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
}

export const DEFAULT_READINESS_TIMEOUT_MS = 3000;

/** The database-check deadline: WORDJS_READINESS_TIMEOUT_MS (100–60000 ms), else 3 s. */
export function readinessTimeoutMs(env: Record<string, string | undefined> = process.env): number {
    const n = Number(env.WORDJS_READINESS_TIMEOUT_MS);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_READINESS_TIMEOUT_MS;
    return Math.min(60000, Math.max(100, Math.floor(n)));
}

const TIMED_OUT = Symbol('readiness-timeout');

export function createReadinessProbe(deps: ReadinessDeps): () => Promise<ReadinessResult> {
    const ttlMs = deps.ttlMs ?? 1000;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const now = deps.now ?? Date.now;
    let cached: { at: number; result: ReadinessResult } | null = null;
    let inflight: Promise<ReadinessResult> | null = null;
    // The database check that outlived its deadline, until it settles.
    let stalled: Promise<void> | null = null;

    function withDeadline<T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
        });
        return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
    }

    async function evaluate(): Promise<ReadinessResult> {
        const checks: Record<string, unknown> = { installed: false, booted: deps.isBooted(), db: 'unknown' };
        const timedOut = (): ReadinessResult => {
            checks.db = 'timeout';
            return { statusCode: 503, body: { status: 'not_ready', checks, error: 'Readiness check timed out.' } };
        };
        try {
            checks.installed = deps.isInstalled();
            if (!checks.installed) return { statusCode: 503, body: { status: 'setup_required', checks } };
            if (!checks.booted) return { statusCode: 503, body: { status: 'starting', checks } };
            if (stalled) return timedOut();
            const check = Promise.resolve().then(() => deps.checkDatabase({ timeoutMs }));
            const db = await withDeadline(check);
            if (db === TIMED_OUT) {
                const settled: Promise<void> = check.then(() => undefined, () => undefined).then(() => {
                    if (stalled === settled) stalled = null;
                });
                stalled = settled;
                if (deps.onError) deps.onError(new Error(`readiness: the database check did not answer within ${timeoutMs} ms`));
                return timedOut();
            }
            checks.db = db && db.status === 'OK' ? 'ok' : 'error';
            if (checks.db !== 'ok') return { statusCode: 503, body: { status: 'not_ready', checks } };
            return { statusCode: 200, body: { status: 'ready', checks } };
        } catch (e) {
            if (deps.onError) deps.onError(e);
            checks.db = 'error';
            return { statusCode: 503, body: { status: 'not_ready', checks, error: 'Readiness check failed.' } };
        }
    }

    return async function readiness(): Promise<ReadinessResult> {
        if (cached && now() - cached.at < ttlMs) return cached.result;
        if (inflight) return inflight;
        inflight = evaluate().then((result) => {
            cached = { at: now(), result };
            return result;
        }).finally(() => { inflight = null; });
        return inflight;
    };
}

/**
 * The database half of the probe, for /health: the same TTL cache, shared in-flight check and deadline,
 * without the install/boot gates (/health answered before installation and during boot, and still does).
 * Resolves 'ok', 'error' or 'timeout'.
 */
export function createHealthProbe(deps: Pick<ReadinessDeps, 'checkDatabase' | 'onError' | 'ttlMs' | 'timeoutMs' | 'now'>): () => Promise<string> {
    const probe = createReadinessProbe({ ...deps, isInstalled: () => true, isBooted: () => true });
    return async () => {
        const { body } = await probe();
        const checks = body.checks as { db?: unknown } | undefined;
        return checks && typeof checks.db === 'string' ? checks.db : 'error';
    };
}

let sharedHealth: (() => Promise<string>) | null = null;

/**
 * The one database health verdict the public health routes answer from (root /health and GET
 * /api/v1/health): a cached probe with the readiness deadline, so neither route's cost follows the rate
 * at which it is asked.
 */
export function databaseHealth(): Promise<string> {
    if (!sharedHealth) {
        sharedHealth = createHealthProbe({
            checkDatabase: (opts) => require('./system-health').checkDatabase(opts),
            timeoutMs: readinessTimeoutMs(process.env),
            onError: (err) => require('./module-logger').moduleLogger('core/readiness').warn({ err }, 'health: database check failed'),
        });
    }
    return sharedHealth();
}
