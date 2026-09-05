/**
 * WordJS — Prometheus metrics.
 *
 * Exposes default Node/process metrics (CPU, RSS/heap, event-loop lag, GC, handles) plus app-level
 * series, in Prometheus text format. Served at GET /metrics, which is DISABLED unless a
 * scrape token is configured (config.metrics.token) — so metrics are never leaked publicly by default.
 *
 * WHAT `wordjs_process_*` IS. It is NOT hand-rolled here: prom-client's collectDefaultMetrics already
 * reads process.cpuUsage()/memoryUsage() and emits `wordjs_process_cpu_seconds_total`,
 * `wordjs_process_resident_memory_bytes`, `wordjs_process_heap_bytes` and the event-loop/GC/handle
 * families under the same prefix. Re-deriving them here would produce a SECOND set of numbers for the
 * same facts, which is how a dashboard ends up disagreeing with itself.
 *
 * CARDINALITY IS THE ONE THING THAT CAN BREAK A METRICS ENDPOINT, and the HTTP series are the place it
 * breaks: a `route` label taken from the request PATH turns every id, slug and cache-buster into its
 * own time series and eventually OOMs the scraper. So `route` is the Express ROUTE PATTERN
 * (`/api/v1/posts/:id`), never the URL; a request that matched no route is `unmatched`, one label
 * value for the whole 404 surface; and the number of distinct patterns is capped, with the overflow
 * collapsing into `other` rather than growing without bound.
 */

import type { Request, Response, NextFunction } from 'express';

const client = require('prom-client');
const { getRequestContext } = require('./logger');

const register = new client.Registry();
register.setDefaultLabels({ app: 'wordjs' });
client.collectDefaultMetrics({ register, prefix: 'wordjs_' });

// App-level gauges, refreshed at scrape time.
const sseClients = new client.Gauge({ name: 'wordjs_sse_clients', help: 'Active SSE clients connected to this node', registers: [register] });
const ready = new client.Gauge({ name: 'wordjs_ready', help: '1 when the app is installed, booted and serving; else 0', registers: [register] });

// ─── HTTP ────────────────────────────────────────────────────────────────────────────────────────

const httpRequests = new client.Counter({
    name: 'wordjs_http_requests_total',
    help: 'HTTP requests served, by method, matched route pattern and status code',
    labelNames: ['method', 'route', 'status'],
    registers: [register],
});

const httpDuration = new client.Histogram({
    name: 'wordjs_http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method and matched route pattern',
    labelNames: ['method', 'route'],
    // 5ms to 10s. The bottom of the range is where a cached public page lives and the top is where a
    // WXR import or an engine-switch migration lives; a histogram that cannot see both ends cannot
    // tell "the site is slow" from "one endpoint is pathological".
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
});

const httpErrors = new client.Counter({
    name: 'wordjs_http_errors_total',
    help: 'HTTP responses with a 4xx or 5xx status, by status code',
    labelNames: ['status'],
    registers: [register],
});

// ─── Database pool ───────────────────────────────────────────────────────────────────────────────

const dbPool = new client.Gauge({
    name: 'wordjs_db_pool',
    help: 'Database connection pool size by state (postgres/mysql only; SQLite has no pool)',
    labelNames: ['state'],
    registers: [register],
});

// ─── Sandbox ─────────────────────────────────────────────────────────────────────────────────────

/** Every state core/plugin-isolate's ConfinementState can hold. All are emitted, so `degraded` is a
 *  value the dashboard can alert on rather than a series that appears only once things are wrong. */
const SANDBOX_STATES = ['unknown', 'unsupported', 'disabled', 'active', 'degraded'];

const sandboxState = new client.Gauge({
    name: 'wordjs_sandbox_state',
    help: "1 for this host's current plugin-sandbox platform confinement state; 0 for the others",
    labelNames: ['status'],
    registers: [register],
});

// ─── Label discipline ────────────────────────────────────────────────────────────────────────────

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const UNMATCHED = 'unmatched';
const OVERFLOW = 'other';
/** A generous ceiling: the app declares ~230 endpoint patterns, so this is reached only by a bug. */
const MAX_ROUTE_LABELS = 400;
const knownRoutes = new Set<string>([UNMATCHED, OVERFLOW]);

function methodLabel(method: string): string {
    const upper = String(method || '').toUpperCase();
    return METHODS.has(upper) ? upper : 'OTHER';
}

/** `/api/v1` + `/:id` → `/api/v1/:id`; duplicate and trailing slashes collapsed, length capped. */
function joinRoute(base: string, route: string): string {
    const joined = `${base || ''}${route || ''}`.replace(/\/{2,}/g, '/').slice(0, 200);
    return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

/** Turn a captured pattern into a label, enforcing the cardinality ceiling. */
function routeLabel(matched: string | null): string {
    if (!matched) return UNMATCHED;
    if (knownRoutes.has(matched)) return matched;
    if (knownRoutes.size >= MAX_ROUTE_LABELS) return OVERFLOW;
    knownRoutes.add(matched);
    return matched;
}

/**
 * Records one request when its response ends — whether it finished or was aborted. Mounted next to
 * middleware/request-context in index.ts and reads that middleware's `startedAt`, so the duration in
 * the metric and the `durationMs` in the access log line are the SAME measurement — two clocks for one
 * request is how a latency graph and a log search end up telling an operator different stories.
 *
 * WHY THE ROUTE IS CAPTURED ON ASSIGNMENT AND NOT READ AT `finish`. `req.route` survives the request,
 * but `req.baseUrl` does NOT: Express sets it on the way INTO a mounted router and restores it on the
 * way out, so by the time `finish` fires it is back to ''. Reading the pair then produced `/:id` for
 * `/api/v1/posts/:id` — and the same `/:id` for categories, media, users and every other router with
 * an id route, silently merging unrelated endpoints into one time series and one latency histogram.
 * Measured, not assumed. So the pattern is snapshotted at the instant Express assigns `req.route`
 * (inside Route.dispatch, where baseUrl is still the mount path), through an accessor scoped to this
 * request. A route that hands off with next() overwrites the snapshot, so the label is the route that
 * actually produced the response.
 */
function httpMetrics(req: Request, res: Response, next: NextFunction): void {
    const ctx = getRequestContext();
    const startedAt = ctx && typeof ctx.startedAt === 'number' ? ctx.startedAt : Date.now();

    let matched: string | null = null;
    let routeValue: any = req.route;
    try {
        Object.defineProperty(req, 'route', {
            configurable: true,
            enumerable: true,
            get: (): any => routeValue,
            set: (value: any): void => {
                routeValue = value;
                if (value && typeof value.path === 'string') {
                    matched = joinRoute(typeof req.baseUrl === 'string' ? req.baseUrl : '', value.path);
                }
            },
        });
    } catch {
        /* a request object that refuses the accessor still gets counted, as `unmatched` */
    }

    // ON BOTH `finish` AND `close`, once — same reason as the access line in middleware/request-context,
    // and it has to be the same reason in both places or the log and the metric disagree about which
    // requests existed. `finish` never fires for a request whose socket dies before the handler
    // responds, so hooking it alone makes an endpoint that has started timing out ALL of its callers
    // look like one with a falling request rate and a healthy p95: only the fast survivors are sampled.
    // It also means `wordjs_http_requests_total` is not a count of requests received, so it cannot be
    // the denominator of an error ratio.
    //
    // An abort is labelled `499` (nginx's "client closed request"), not `res.statusCode` — an
    // unanswered response still reports its default 200 and would silently inflate the success bucket.
    let recorded = false;
    const record = (aborted: boolean): void => {
        if (recorded) return;
        recorded = true;
        const status = aborted ? 499 : res.statusCode;
        const method = methodLabel(req.method);
        const route = routeLabel(matched);
        httpRequests.inc({ method, route, status: String(status) });
        httpDuration.observe({ method, route }, Math.max(0, Date.now() - startedAt) / 1000);
        if (status >= 400) httpErrors.inc({ status: String(status) });
    };
    res.on('finish', () => record(false));
    res.on('close', () => record(true));
    next();
}

// ─── Scrape-time refresh ─────────────────────────────────────────────────────────────────────────

/** Denque (mysql2) exposes `.length`; a plain array does too. Anything else is not a queue we know. */
function queueSize(value: any): number | null {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value.length === 'number') return value.length;
    if (value && typeof value.size === 'function') return Number(value.size());
    return null;
}

/**
 * Pool stats, when the ACTIVE driver has a pool. `pg` exposes totalCount/idleCount/waitingCount as
 * public properties; mysql2 does not expose anything public, so its private queues are read
 * defensively and the gauge is simply absent when the shape is not what we expect — a metric that
 * guesses is worse than a metric that is missing. SQLite (the default driver) has no pool at all.
 */
function refreshDbPool(): void {
    dbPool.reset();
    try {
        const database = require('../config/database');
        const driver = database.getDbAsync();
        const pool = driver && driver.pool;
        if (!pool) return;

        if (typeof pool.totalCount === 'number') { // pg.Pool
            dbPool.set({ state: 'total' }, pool.totalCount);
            dbPool.set({ state: 'idle' }, Number(pool.idleCount) || 0);
            dbPool.set({ state: 'waiting' }, Number(pool.waitingCount) || 0);
            return;
        }

        const raw = pool.pool || pool; // mysql2's promise wrapper holds the callback pool on `.pool`
        const total = queueSize(raw && raw._allConnections);
        const free = queueSize(raw && raw._freeConnections);
        const waiting = queueSize(raw && raw._connectionQueue);
        if (total === null) return;
        dbPool.set({ state: 'total' }, total);
        if (free !== null) dbPool.set({ state: 'idle' }, free);
        if (waiting !== null) dbPool.set({ state: 'waiting' }, waiting);
    } catch {
        /* the database module may not be initialised yet (pre-install boot) — no pool to report */
    }
}

function refreshSandboxState(): void {
    try {
        // Read-only, and ONLY if the isolate layer is already loaded. Requiring a module the size of
        // core/plugin-isolate for the sake of a gauge would run its module-level initialisation from
        // inside a scrape, which is not something an observability endpoint gets to do.
        const resolved = require.resolve('./plugin-isolate');
        if (!require.cache[resolved]) return;
        const isolate = require('./plugin-isolate');
        if (typeof isolate.getSandboxPlatformState !== 'function') return;
        const current = String(isolate.getSandboxPlatformState() || 'unknown');
        for (const state of SANDBOX_STATES) sandboxState.set({ status: state }, state === current ? 1 : 0);
    } catch {
        /* the isolate layer is optional at runtime — leave the gauge unset rather than failing the scrape */
    }
}

/** Render the current metrics as Prometheus text (refreshing app gauges first). */
async function metricsText(): Promise<string> {
    try {
        const notifications = require('./notifications');
        sseClients.set(notifications && notifications.clients ? notifications.clients.size : 0);
    } catch { /* notifications not loaded — leave gauge as-is */ }
    refreshDbPool();
    refreshSandboxState();
    // NO CACHE HIT/MISS SERIES, deliberately. core/cache.ts keeps no hit/miss counters (it exposes
    // get/set/del, an L1 size introspection hook and the cluster bus, nothing countable), and that
    // module belongs to another change. Adding counters to it from here would be a metrics module
    // reaching into a cache module to invent the numbers it wants to report. When cache.ts grows
    // them, `wordjs_cache_hits_total` / `wordjs_cache_misses_total` are two lines in this file.
    return register.metrics();
}

module.exports = { register, metricsText, contentType: register.contentType, readyGauge: ready, httpMetrics };
