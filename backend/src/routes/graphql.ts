/**
 * WordJS - GraphQL endpoint: queries, mutations and (over SSE) subscriptions.
 *
 * Mounted at /api/v1/graphql by routes/index, i.e. behind every app-level control the REST API has: host
 * gate, CORS, the API rate limiter, CSRF (a cookie-authenticated POST needs X-CSRF-Token exactly like any
 * REST write; GET is a safe method), the install funnel and the MFA compliance gate. It works unchanged in
 * monolith, split and separate modes because the gateway routes every /api/* path to the backend.
 *
 *  · POST/GET /graphql  — graphql-http (the GraphQL-over-HTTP reference implementation). Queries over GET
 *    or POST; MUTATIONS ONLY OVER POST (graphql-http answers 405 to a mutation over GET, and every mutation
 *    resolver re-checks the method — core/graphql/mutations assertWriteTransport). That is the CSRF rule
 *    for a cookie-authenticated browser: a write needs a POST, and a POST needs a same-origin Origin and the
 *    X-CSRF-Token double-submit header, which a cross-site page can neither send nor read.
 *  · POST /graphql as multipart/form-data — the GraphQL multipart request spec (`operations`, `map`, file
 *    parts) for `uploadMedia`. The file is re-streamed to POST /media, whose multer, file filter, magic-byte
 *    check and quota run as for a direct upload. Behind the upload limiter (index.ts).
 *  · GET/POST /graphql/stream — subscriptions, as GraphQL over SSE (core/graphql/subscriptions).
 *
 * Authorization lives in the resolvers' REST sub-requests (core/graphql/dispatch) — nothing here decides
 * who may see or change what.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

const express = require('express');
const multer = require('multer');
const { createHandler } = require('graphql-http/lib/use/express');
const { specifiedRules, GraphQLError, validate, getOperationAST, subscribe } = require('graphql');
const graphql = require('../core/graphql');
const config = require('../config/app');
const { sameOriginRequest, SESSION_COOKIE, optionalAuth } = require('../middleware/auth');
const log = require('../core/module-logger').moduleLogger('routes/graphql');

const router = express.Router();

// The caller, resolved once at the door (middleware/auth optionalAuth): a Bearer header that resolves to
// nobody is refused here (401 rest_token_invalid, as on REST) — every field is dispatched to REST as this
// caller, where the same header degraded `viewer` to null and the reads to the anonymous answer with a
// 200 — and the stream cap below counts streams per signed-in USER.
router.use(optionalAuth);

/** A resolver crash is a bug, not a contract: its message (or stack) never reaches the client. */
function formatError(err: any) {
    // GraphQLErrors raised on purpose (REST refusals, bad input, limits) keep their message/extensions.
    if (err && err.originalError && !(err.originalError instanceof GraphQLError)) {
        log.error({ err: err.originalError }, '[graphql] resolver error');
        return new GraphQLError('Internal server error.', {
            nodes: err.nodes, path: err.path, extensions: { code: 'INTERNAL_SERVER_ERROR' },
        });
    }
    return err;
}

function contextFor(req: Request, res?: Response, extra: Record<string, any> = {}) {
    return {
        req,
        rest: graphql.createRestClient(req, res),
        maxPageSize: graphql.MAX_PAGE_SIZE,
        ...extra,
    };
}

const handler = createHandler({
    schema: () => graphql.getSchema(),
    parse: graphql.parseWithLimits,
    validationRules: async () => [...specifiedRules, ...(await graphql.extraValidationRules())],
    context: (req: { raw: Request; context: { res: Response } }) => contextFor(req.raw, req.context && req.context.res),
    formatError,
});

// ─── Multipart (the GraphQL multipart request spec) ─────────────────────────────────────────────────

const multipart = multer({
    storage: multer.memoryStorage(),
    // UTF-8 file names, as POST /media reads them (busboy's default is latin1).
    defParamCharset: 'utf8',
    limits: {
        // The REST upload limit: a file POST /media would refuse is refused before it is buffered whole.
        fileSize: config.uploads.maxFileSize,
        // One file per mutation at most, and a document holds at most maxMutations of them.
        files: (config.api.graphql && config.api.graphql.maxMutations) || 10,
        fields: 2,
        fieldSize: 1024 * 1024,
    },
});

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function badRequest(res: Response, message: string, code = 'BAD_REQUEST') {
    return res.status(400).json({ errors: [{ message, extensions: { code } }] });
}

/**
 * Turn `operations` + `map` + file parts into the JSON request graphql-http expects, with each mapped
 * variable replaced by a GraphQLUploadFile. Returns an error message, or null when `req.body` is ready.
 */
function applyMultipart(req: Request): string | null {
    let operations: any;
    let map: any;
    try {
        operations = JSON.parse(String(req.body && req.body.operations));
        map = JSON.parse(String(req.body && req.body.map));
    } catch {
        return 'A multipart GraphQL request needs JSON "operations" and "map" fields.';
    }
    if (!operations || typeof operations !== 'object' || Array.isArray(operations)) return 'Batched operations are not supported.';
    if (!map || typeof map !== 'object' || Array.isArray(map)) return '"map" must be an object.';
    const uploaded = (req as Request & { files?: unknown }).files;
    const files: any[] = Array.isArray(uploaded) ? uploaded : [];
    const byField = new Map<string, any>(files.map((f) => [String(f.fieldname), f]));
    for (const [field, paths] of Object.entries(map)) {
        const file = byField.get(field);
        if (!file) return `"map" names a file part "${field}" that was not sent.`;
        if (!Array.isArray(paths) || paths.length !== 1) return `"map.${field}" must name exactly one variable path.`;
        const segs = String(paths[0]).split('.');
        if (segs[0] !== 'variables' || segs.length < 2 || segs.some((s) => !s || FORBIDDEN_SEGMENTS.has(s))) {
            return `"map.${field}" must point inside "variables".`;
        }
        let target: any = operations;
        for (let i = 0; i < segs.length - 1; i++) {
            if (target[segs[i]] === null || typeof target[segs[i]] !== 'object') return `"map.${field}" points at a variable that does not exist.`;
            target = target[segs[i]];
        }
        const last = segs[segs.length - 1];
        if (!Object.prototype.hasOwnProperty.call(target, last) || target[last] !== null) {
            return `"map.${field}" must point at a variable whose value is null.`;
        }
        target[last] = new graphql.GraphQLUploadFile(String(file.originalname || 'upload'), String(file.mimetype || 'application/octet-stream'), file.buffer);
        byField.delete(field);
    }
    if (byField.size) return 'Every file part must be named in "map".';
    req.body = operations;
    return null;
}

function isMultipart(req: Request): boolean {
    return /^multipart\/form-data/i.test(String(req.headers['content-type'] || ''));
}

/**
 * @swagger
 * /graphql:
 *   get:
 *     summary: GraphQL — query over GET
 *     description: Executes a GraphQL query passed as the `query` parameter (plus optional `variables` JSON and `operationName`). Every field is resolved through the corresponding REST read for the SAME caller, so visibility is identical to the REST API. Mutations are refused over GET (405). Depth, cost, token and page-size limits apply; introspection is off in production unless the graphql_introspection setting enables it. See documentation/graphql.md.
 *     tags: [GraphQL]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: variables
 *         schema:
 *           type: string
 *       - in: query
 *         name: operationName
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A GraphQL response ({ data, errors })
 *       400:
 *         description: Malformed request, or a document refused by validation (including the depth/cost limits)
 *       405:
 *         description: A mutation sent over GET (mutations are POST only)
 *   post:
 *     summary: GraphQL — queries and mutations over POST
 *     description: Same as GET, with a JSON body { query, variables, operationName }, and the only way to run a mutation. Every mutation is the REST write it names, dispatched as the same caller (capabilities, ownership, publish gate, protected meta, sudo re-authentication, API-token write scope, audit and webhooks are the REST ones); a refusal carries the REST code and status in the error's extensions. At most WORDJS_GRAPHQL_MAX_MUTATIONS (default 10) mutation fields per document, and each costs 25 more in the cost limit than the same selection as a query. A cookie-authenticated POST needs a same-origin Origin and the X-CSRF-Token header, as every REST write does. multipart/form-data follows the GraphQL multipart request spec (operations, map, file parts) for uploadMedia.
 *     tags: [GraphQL]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *               variables:
 *                 type: object
 *               operationName:
 *                 type: string
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [operations, map]
 *             properties:
 *               operations:
 *                 type: string
 *                 description: The JSON request, with null where each file goes.
 *               map:
 *                 type: string
 *                 description: JSON object from file part name to the one variable path it fills.
 *     responses:
 *       200:
 *         description: A GraphQL response ({ data, errors })
 *       400:
 *         description: Malformed request, or a document refused by validation (including the depth, cost and mutation limits)
 *       403:
 *         description: A cross-site POST, or a cookie-authenticated POST without X-CSRF-Token (rest_csrf_invalid / rest_csrf_token)
 */
router.all('/', (req: Request, res: Response, next: NextFunction) => {
    // Responses depend on the caller's identity and are never shared-cacheable.
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && isMultipart(req)) {
        return multipart.any()(req, res, (err: any) => {
            if (err) {
                const tooBig = err.code === 'LIMIT_FILE_SIZE';
                return res.status(tooBig ? 413 : 400).json({ errors: [{ message: tooBig ? 'The file is larger than the upload limit.' : 'Malformed multipart GraphQL request.', extensions: { code: tooBig ? 'rest_upload_too_large' : 'BAD_REQUEST' } }] });
            }
            const problem = applyMultipart(req);
            if (problem) return badRequest(res, problem);
            // graphql-http reads JSON requests only; the parsed operations ARE that request now. The sub-requests
            // the resolvers dispatch describe their own bodies (core/graphql/dispatch), so this header is the
            // GraphQL request's alone.
            req.headers['content-type'] = 'application/json; charset=utf-8';
            delete req.headers['content-length'];
            Promise.resolve(handler(req, res)).catch(next);
        });
    }
    Promise.resolve(handler(req, res)).catch(next);
});

// ─── Subscriptions: GraphQL over SSE ────────────────────────────────────────────────────────────────

let openStreams = 0;
const streamsByClient = new Map<string, number>();
const KEEPALIVE_MS = 15_000;
const MAX_STREAM_MS = 60 * 60 * 1000;

/** Test seam. */
const streamTuning = { keepaliveMs: KEEPALIVE_MS, maxStreamMs: MAX_STREAM_MS };

function clientKey(req: Request): string {
    // Per signed-in user: every session and token carries its own id (core/session-revocation), so a
    // key made of the raw credential let one account open five streams per token it held.
    const userId = req.user && Number(req.user.id);
    if (userId) return `u:${userId}`;
    const auth = String(req.headers.authorization || '');
    const cookie = req.cookies && typeof req.cookies[SESSION_COOKIE] === 'string' ? req.cookies[SESSION_COOKIE] : '';
    const credential = auth.startsWith('Bearer ') ? auth : cookie;
    if (credential) return `c:${createHash('sha256').update(credential).digest('hex').slice(0, 32)}`;
    return `ip:${req.ip}`;
}

function streamParams(req: Request): { query?: string; variables?: any; operationName?: string } | string {
    if (req.method === 'GET') {
        const q = req.query || {};
        if (typeof q.query !== 'string') return 'The "query" parameter is required.';
        let variables: any;
        if (typeof q.variables === 'string' && q.variables) {
            try { variables = JSON.parse(q.variables); } catch { return '"variables" must be JSON.'; }
        }
        return { query: q.query, variables, operationName: typeof q.operationName === 'string' ? q.operationName : undefined };
    }
    const b = req.body;
    if (!b || typeof b !== 'object' || typeof b.query !== 'string') return 'A JSON body with "query" is required.';
    return { query: b.query, variables: b.variables, operationName: typeof b.operationName === 'string' ? b.operationName : undefined };
}

/**
 * @swagger
 * /graphql/stream:
 *   get:
 *     summary: GraphQL subscriptions over Server-Sent Events
 *     description: >-
 *       Runs one `subscription` operation (contentChanged, commentAdded) and streams its results as
 *       text/event-stream in the GraphQL over SSE distinct-connections format - `next` events carrying a JSON
 *       result ({ data } or { errors }) and the resume cursor as the SSE id, then a final `complete` event. Every event is re-authorized as the subscriber with the REST read it mirrors (GET /posts/:id, GET /comments/:id) before it is sent, so a subscriber only hears about entries it could read at that moment. Send `Last-Event-ID` to resume after a cursor. Queries and mutations are refused here. A cookie-authenticated GET must be same-origin. Streams per process and per caller are capped (WORDJS_GRAPHQL_MAX_STREAMS, WORDJS_GRAPHQL_MAX_STREAMS_PER_CLIENT) and end after an hour; reconnect with Last-Event-ID.
 *     tags: [GraphQL]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: variables
 *         schema:
 *           type: string
 *       - in: query
 *         name: operationName
 *         schema:
 *           type: string
 *       - in: header
 *         name: Last-Event-ID
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The event stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400:
 *         description: Not a subscription, or a document refused by validation
 *       403:
 *         description: A cross-site cookie-authenticated request (rest_csrf_invalid)
 *       429:
 *         description: Too many open streams (graphql_stream_limit)
 *   post:
 *     summary: GraphQL subscriptions over Server-Sent Events (JSON body)
 *     description: Same as GET with a JSON body { query, variables, operationName }. The usual CSRF rules for a POST apply.
 *     tags: [GraphQL]
 *     security:
 *       - bearerAuth: []
 *       - {}
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *               variables:
 *                 type: object
 *               operationName:
 *                 type: string
 *     responses:
 *       200:
 *         description: The event stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400:
 *         description: Not a subscription, or a document refused by validation
 *       429:
 *         description: Too many open streams (graphql_stream_limit)
 */
router.all('/stream', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    serveStream(req, res).catch(next);
});

async function serveStream(req: Request, res: Response): Promise<any> {
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ errors: [{ message: 'Use GET or POST.', extensions: { code: 'METHOD_NOT_ALLOWED' } }] });
    }
    // GET is outside the global CSRF gate. A browser's session cookie must not open a stream for a page of
    // another origin: the same rule as the collaboration stream (middleware/auth sameOriginRequest).
    const hasSessionCookie = !!(req.cookies && req.cookies[SESSION_COOKIE]);
    if (req.method === 'GET' && hasSessionCookie && !sameOriginRequest(req)) {
        return res.status(403).json({ code: 'rest_csrf_invalid', message: 'Cross-site request blocked.', data: { status: 403 } });
    }
    const params = streamParams(req);
    if (typeof params === 'string') return badRequest(res, params);

    const schema = graphql.getSchema();
    let document: any;
    try { document = graphql.parseWithLimits(params.query); }
    catch (e: any) { return res.status(400).json({ errors: [formatError(e instanceof GraphQLError ? e : new GraphQLError(String(e && e.message)))] }); }
    const errors = validate(schema, document, [...specifiedRules, ...(await graphql.extraValidationRules())]);
    if (errors.length) return res.status(400).json({ errors: errors.map(formatError) });
    const op = getOperationAST(document, params.operationName);
    if (!op || op.operation !== 'subscription') {
        return badRequest(res, 'Only subscription operations are served on /graphql/stream; send queries and mutations to /graphql.', 'GRAPHQL_NOT_A_SUBSCRIPTION');
    }

    const g = config.api.graphql || {};
    const key = clientKey(req);
    if (openStreams >= (g.maxStreams || 500) || (streamsByClient.get(key) || 0) >= (g.maxStreamsPerClient || 5)) {
        return res.status(429).json({ errors: [{ message: 'Too many open subscription streams.', extensions: { code: 'graphql_stream_limit' } }] });
    }

    const lastEventId = req.get('Last-Event-ID') || undefined;
    const contextValue: any = contextFor(req, undefined, { lastEventId });
    const result = await subscribe({
        schema,
        document,
        contextValue,
        variableValues: params.variables,
        operationName: params.operationName,
    });
    if (!result || typeof result[Symbol.asyncIterator] !== 'function') {
        // A subscribe-time error (bad arguments, a refusal): an ordinary GraphQL response, no stream.
        return res.status(400).json({ ...result, errors: (result && result.errors ? result.errors : []).map(formatError) });
    }

    openStreams++;
    streamsByClient.set(key, (streamsByClient.get(key) || 0) + 1);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();
    res.write(': connected\n\n');

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        clearInterval(keepalive);
        clearTimeout(lifetime);
        openStreams--;
        const left = (streamsByClient.get(key) || 1) - 1;
        if (left > 0) streamsByClient.set(key, left); else streamsByClient.delete(key);
        try { if (typeof result.return === 'function') result.return(); } catch { /* already closed */ }
    };
    const keepalive = setInterval(() => { if (!done) res.write(':\n\n'); }, streamTuning.keepaliveMs);
    const lifetime = setTimeout(() => { finish(); endStream(res); }, streamTuning.maxStreamMs);
    if (keepalive.unref) keepalive.unref();
    if (lifetime.unref) lifetime.unref();
    req.on('close', finish);
    res.on('close', finish);

    try {
        for await (const value of result) {
            if (done) break;
            const cursor = typeof contextValue.lastCursor === 'string' ? contextValue.lastCursor : null;
            const payload = { ...value, errors: value.errors ? value.errors.map(formatError) : undefined };
            res.write(`${cursor ? `id: ${cursor}\n` : ''}event: next\ndata: ${JSON.stringify(payload)}\n\n`);
        }
    } catch (err: any) {
        if (!done) {
            const e = err instanceof GraphQLError ? err : formatError(new GraphQLError(String(err && err.message), { originalError: err }));
            res.write(`event: next\ndata: ${JSON.stringify({ errors: [e] })}\n\n`);
        }
    } finally {
        const wasDone = done;
        finish();
        if (!wasDone) endStream(res);
    }
}

function endStream(res: Response): void {
    try {
        if (!res.writableEnded) {
            res.write('event: complete\ndata:\n\n');
            res.end();
        }
    } catch { /* the client already went away */ }
}

module.exports = router;
module.exports.streamTuning = streamTuning;
module.exports.openStreamCount = () => openStreams;
