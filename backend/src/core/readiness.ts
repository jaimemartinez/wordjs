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
    checkDatabase: () => Promise<{ status: string }>;
    onError?: (err: unknown) => void;
    ttlMs?: number;
    now?: () => number;
}

export function createReadinessProbe(deps: ReadinessDeps): () => Promise<ReadinessResult> {
    const ttlMs = deps.ttlMs ?? 1000;
    const now = deps.now ?? Date.now;
    let cached: { at: number; result: ReadinessResult } | null = null;
    let inflight: Promise<ReadinessResult> | null = null;

    async function evaluate(): Promise<ReadinessResult> {
        const checks: Record<string, unknown> = { installed: false, booted: deps.isBooted(), db: 'unknown' };
        try {
            checks.installed = deps.isInstalled();
            if (!checks.installed) return { statusCode: 503, body: { status: 'setup_required', checks } };
            if (!checks.booted) return { statusCode: 503, body: { status: 'starting', checks } };
            const db = await deps.checkDatabase();
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
