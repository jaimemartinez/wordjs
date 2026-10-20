/**
 * WordJS - GraphQL → REST internal dispatch
 *
 * THE RULE THIS FILE EXISTS FOR: a GraphQL read is authorized EXACTLY like the REST read it mirrors,
 * because it IS that REST read. Every resolver asks the core API router for a path (`/posts?per_page=10`,
 * `/media/42`) and gets back the status, headers and JSON body the REST endpoint would have sent to the
 * same caller — the same optionalAuth, the same capability checks (status / author / read_private /
 * password protection / attachment-parent visibility), the same serializer, the same FTS search. There is
 * no second data-access layer and no second copy of the authorization rules to drift out of sync; this
 * is the shape of WordPress's own `rest_do_request()`.
 *
 * HOW. The sub-request is a prototype-child of the real incoming request: it inherits the headers,
 * cookies, socket and app (so the caller's credentials, client IP and host are the real ones) and
 * overrides only what describes the route — method, url, originalUrl, query, params. `originalUrl`
 * carries the API prefix so path-derived checks (an API token's resource scope, apiResourceOf) see
 * `/api/v1/posts`, exactly as for a direct REST call. The response is captured by a minimal in-memory
 * stand-in for express's `res`; a thrown/forwarded error is rendered by the real errorHandler, so even
 * a 400 body is the REST one.
 *
 * WHAT IT DOES NOT RE-RUN. The app-level middleware in front of the API router (host gate, CORS, CSRF,
 * the install funnel, the MFA compliance gate, the API rate limiter) already ran ONCE for the GraphQL
 * request itself, under the same identity; the sub-requests only re-enter the router.
 *
 * Only GET is dispatched: phase 1 of the GraphQL API is read-only.
 */

import type { Request } from 'express';

export interface RestResult {
    status: number;
    body: any;
    headers: Record<string, string>;
}

export type RestQuery = Record<string, string | number | boolean | undefined | null>;

const API_PREFIX: string = (() => {
    try { return String(require('../../config/app').api.prefix || '/api/v1'); } catch { return '/api/v1'; }
})();

/** Build `path?query`, dropping undefined/null/'' values. Order is stable (insertion order). */
export function buildUrl(path: string, query?: RestQuery): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
        if (v === undefined || v === null || v === '') continue;
        params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
}

/** A just-enough express `res` that records what the route sends. */
class CapturedResponse {
    statusCode = 200;
    headersSent = false;
    finished = false;
    locals: Record<string, any> = Object.create(null);
    body: any = undefined;
    req: any;
    private readonly headerMap = new Map<string, string>();
    private readonly onFinish: () => void;

    constructor(req: any, onFinish: () => void) {
        this.req = req;
        this.onFinish = onFinish;
    }

    status(code: number) { this.statusCode = code; return this; }
    sendStatus(code: number) { this.statusCode = code; return this.finish(); }
    set(field: any, value?: any) {
        if (field && typeof field === 'object') {
            for (const [k, v] of Object.entries(field)) this.headerMap.set(k.toLowerCase(), String(v));
        } else {
            this.headerMap.set(String(field).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
        }
        return this;
    }
    header(field: any, value?: any) { return this.set(field, value); }
    setHeader(field: string, value: any) { this.set(field, value); return this; }
    append(field: string, value: any) {
        const prev = this.headerMap.get(field.toLowerCase());
        return this.set(field, prev ? `${prev}, ${value}` : value);
    }
    get(field: string) { return this.headerMap.get(String(field).toLowerCase()); }
    getHeader(field: string) { return this.get(field); }
    hasHeader(field: string) { return this.headerMap.has(String(field).toLowerCase()); }
    removeHeader(field: string) { this.headerMap.delete(String(field).toLowerCase()); }
    getHeaders() { return Object.fromEntries(this.headerMap); }
    type() { return this; }
    contentType() { return this; }
    vary() { return this; }
    // A read route never sets a cookie; if one ever does, it must not leak into the GraphQL response.
    cookie() { return this; }
    clearCookie() { return this; }
    json(body: any) { this.body = body; return this.finish(); }
    send(body?: any) {
        if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return this.json(body);
        this.body = body;
        return this.finish();
    }
    end(body?: any) {
        if (body !== undefined && this.body === undefined) this.body = body;
        return this.finish();
    }
    redirect(...args: any[]) {
        this.statusCode = typeof args[0] === 'number' ? args[0] : 302;
        return this.finish();
    }
    private finish() {
        if (!this.finished) {
            this.finished = true;
            this.headersSent = true;
            this.onFinish();
        }
        return this;
    }
    headersObject(): Record<string, string> { return Object.fromEntries(this.headerMap); }
}

const NO_ROUTE = { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } };

let apiRouter: any = null;
function getApiRouter(): any {
    // Lazy: routes/index mounts routes/graphql, which reaches this module — requiring it at load time
    // would be a cycle. By the time a query runs, the router is fully built.
    if (!apiRouter) apiRouter = require('../../routes');
    return apiRouter;
}

/** Test seam: dispatch to a different router (the unit tests mount a reduced one). */
export function setDispatchRouter(router: any): void {
    apiRouter = router;
}

/**
 * GET `path` (API-relative, e.g. `/posts/12`) through the core API router AS the caller of `req`.
 * Never throws for an HTTP-level failure: the status and REST body come back for the caller to map.
 */
export function restGet(req: Request, path: string, query?: RestQuery): Promise<RestResult> {
    return routerGet(getApiRouter(), API_PREFIX, req, path, query);
}

/**
 * GET `path` through `router` (mounted at `mountPrefix`) AS the caller of `req` — restGet over any router.
 * core/graphql/plugin-bridge uses it with a plugin's own GET routes, so a plugin field is authorized by the
 * plugin route's own middleware, for the same caller.
 */
export function routerGet(router: any, mountPrefix: string, req: Request, path: string, query?: RestQuery): Promise<RestResult> {
    // Callers interpolate only integers and encodeURIComponent()-ed strings, which can contain neither `/`
    // nor `?`; a literal dot segment is the one thing that could still re-aim the path, so refuse it.
    if (!path.startsWith('/') || path.includes('?') || path.split('/').some(seg => seg === '.' || seg === '..')) {
        // Answer what the router answers for a path it does not serve, so `slug: ".."` resolves to null.
        return Promise.resolve({ status: 404, body: NO_ROUTE, headers: {} });
    }
    const url = buildUrl(path, query);
    const queryObject: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(url.split('?')[1] || '')) queryObject[k] = v;

    return new Promise<RestResult>((resolve) => {
        const sub: any = Object.create(req as any);
        // Own properties shadow the parent request's; everything else (headers, cookies, socket, app, ip)
        // is inherited, so the sub-request is authenticated and attributed exactly like the real one.
        Object.assign(sub, {
            method: 'GET',
            url,
            originalUrl: `${mountPrefix}${url}`,
            baseUrl: '',
            query: queryObject,
            params: {},
            body: undefined,
            route: undefined,
            user: undefined,
            apiToken: undefined,
            isHeadless: undefined,
            _parsedUrl: undefined,
            _parsedOriginalUrl: undefined,
        });

        let settled = false;
        const settle = (res: CapturedResponse) => {
            if (settled) return;
            settled = true;
            resolve({ status: res.statusCode, body: res.body, headers: res.headersObject() });
        };
        const res: CapturedResponse = new CapturedResponse(sub, () => settle(res));
        sub.res = res;

        const done = (err?: any) => {
            if (settled) return;
            if (err) {
                // Render through the REAL error handler so the body is the one REST would send.
                const { errorHandler } = require('../../middleware/errorHandler');
                try {
                    errorHandler(err, sub, res as any, () => undefined);
                } catch {
                    res.status(500).json({ code: 'rest_internal_error', message: 'The server encountered an internal error.', data: { status: 500 } });
                }
                if (!settled) settle(res.status(500));
                return;
            }
            // Fell through every route: the same answer the API's notFound handler gives.
            res.status(404).json(NO_ROUTE);
        };

        try {
            router.handle(sub, res, done);
        } catch (err) {
            done(err);
        }
    });
}

/**
 * Per-GraphQL-request memo over restGet: the same path asked twice in one query (two posts with the
 * same parent, an author's archive referenced from several places) is dispatched once.
 */
export function createRestClient(req: Request) {
    const memo = new Map<string, Promise<RestResult>>();
    let dispatched = 0;
    return {
        get(path: string, query?: RestQuery): Promise<RestResult> {
            const key = buildUrl(path, query);
            let hit = memo.get(key);
            if (!hit) {
                dispatched++;
                hit = restGet(req, path, query);
                memo.set(key, hit);
            }
            return hit;
        },
        /** How many distinct REST reads this GraphQL request has made (exposed for tests/metrics). */
        get dispatched() { return dispatched; },
    };
}

export type RestClient = ReturnType<typeof createRestClient>;
