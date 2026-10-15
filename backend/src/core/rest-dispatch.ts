/**
 * WordJS — in-process REST dispatch for AI agents (the MCP server's only way to touch content).
 *
 * WHY THE MCP TOOLS DO NOT CALL THE MODELS. The REST content routes are where every rule about content
 * lives: the type-aware capability family, the publish gate, parent/attachment ownership, the content
 * contract, sanitizing, revisions, the outbox, hooks, webhooks and the audit rows. A second set of tool
 * handlers calling Post.create directly would be a twin of all of it, and twins drift (the history of this
 * repo is a list of exactly that). So a tool builds a REST request and runs it through the SAME router the
 * HTTP API mounts, in this process, with no socket and no network hop. Whatever REST refuses, the agent is
 * refused; whatever REST records, the agent's call records.
 *
 * WHO THE DISPATCHED REQUEST IS. It carries no credential. The identity travels in a WeakMap keyed by the
 * request object (DISPATCH below) that only this module writes; middleware/auth reads it at the top of
 * authenticate/optionalAuth/authenticateAllowQuery and attaches the NARROWED user (core/agent-capabilities
 * narrowUser) plus the headless mark. A header cannot forge that entry — there is no header — and an
 * ordinary HTTP request can never be a key in the map, because the map only ever holds objects this module
 * created a moment earlier.
 *
 * What it is not: a general proxy. core/mcp-server calls it with fixed method/path templates per tool;
 * no tool forwards an agent-chosen path.
 */

import type { Request } from 'express';

const http = require('http');
const net = require('net');
const express = require('express');
const config = require('../config/app');

interface DispatchContext {
    /** The bound user, already narrowed by the agent's grant. */
    user: any;
    agent: { id: number; name: string; grants: string[] };
    /** Coarse REST scopes implied by the grant — enforced as a second fence (scopesForGrants). */
    scopes: string[];
}

interface DispatchResult {
    status: number;
    body: any;
    headers: Record<string, any>;
}

interface MultipartFile {
    field: string;
    filename: string;
    contentType: string;
    data: Buffer;
}

const DISPATCH = new WeakMap<object, DispatchContext>();

/** The agent identity of a request this module created, or undefined for every other request. */
function dispatchContextOf(req: Request | object | null | undefined): DispatchContext | undefined {
    return req ? DISPATCH.get(req) : undefined;
}

let dispatchApp: any = null;
/**
 * A tiny express app that mounts the SAME router instance as the HTTP API (routes/index.ts is a module
 * singleton), followed by the same 404 and error handlers, so an escaped error answers with the API's own
 * scrubbed body instead of finalhandler's HTML.
 */
function app(): any {
    if (dispatchApp) return dispatchApp;
    const a = express();
    a.disable('x-powered-by');
    a.set('etag', false);
    a.use(config.api.prefix, require('../routes'));
    const { notFound, errorHandler } = require('../middleware/errorHandler');
    a.use(notFound);
    a.use(errorHandler);
    dispatchApp = a;
    return a;
}

function multipartBody(file: MultipartFile, fields: Record<string, string>): { boundary: string; body: Buffer } {
    const boundary = `----wordjs-agent-${require('crypto').randomBytes(12).toString('hex')}`;
    const safe = (s: string) => String(s).replace(/["\r\n]/g, '_');
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(k)}"\r\n\r\n${String(v)}\r\n`));
    }
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safe(file.field)}"; filename="${safe(file.filename)}"\r\n` +
        `Content-Type: ${safe(file.contentType)}\r\n\r\n`
    ));
    parts.push(file.data);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return { boundary, body: Buffer.concat(parts) };
}

const DISPATCH_TIMEOUT_MS = 30_000;

/**
 * Run one REST request as the agent. `path` is relative to the API prefix (e.g. '/posts/12'). JSON bodies
 * are handed over already parsed (the router sits behind the app-level body parser on the HTTP path, so
 * it expects `req.body`); a multipart upload is streamed as real bytes so multer parses it exactly as it
 * parses a browser upload.
 */
function dispatchRest(ctx: DispatchContext, opts: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: any;
    file?: MultipartFile;
    fields?: Record<string, string>;
    /** The outer request — its host and client address carry over, so host-aware code sees the same site. */
    origin?: Request;
}): Promise<DispatchResult> {
    return new Promise<DispatchResult>((resolve, reject) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query || {})) {
            if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
        }
        const url = `${config.api.prefix}${opts.path}${qs.toString() ? `?${qs}` : ''}`;

        const socket = new net.Socket();
        const remote = (opts.origin && opts.origin.socket && opts.origin.socket.remoteAddress) || '127.0.0.1';
        Object.defineProperty(socket, 'remoteAddress', { value: remote });
        const req = new http.IncomingMessage(socket);
        req.method = String(opts.method).toUpperCase();
        req.url = url;
        req.httpVersion = '1.1';
        req.httpVersionMajor = 1;
        req.httpVersionMinor = 1;
        const headers: Record<string, string> = {
            accept: 'application/json',
            'user-agent': 'wordjs-mcp-agent',
        };
        const host = opts.origin && opts.origin.headers && opts.origin.headers.host;
        if (host) headers.host = String(host);

        if (opts.file) {
            const { boundary, body } = multipartBody(opts.file, opts.fields || {});
            headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
            headers['content-length'] = String(body.length);
            req.headers = headers;
            req.push(body);
            req.push(null);
        } else {
            req.headers = headers;
            if (opts.body !== undefined) {
                headers['content-type'] = 'application/json';
                (req as any).body = opts.body;
                (req as any)._body = true; // tell any body parser on the way that it is already parsed
            } else {
                (req as any).body = {};
            }
            req.push(null);
        }
        // The whole body is already in the stream. Without this, Node treats the request as cut short when
        // the stream auto-destroys after 'end' and emits 'aborted' — which multer reports as a failed upload.
        (req as any).complete = true;

        const res = new http.ServerResponse(req);
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const raw = Buffer.concat(chunks).toString('utf8');
            const type = String(res.getHeader('content-type') || '');
            let body: any = raw;
            if (type.includes('json') && raw) {
                try { body = JSON.parse(raw); } catch { body = raw; }
            }
            resolve({ status: res.statusCode, body, headers: res.getHeaders() });
        };
        res.write = function write(chunk: any, enc?: any, cb?: any) {
            if (chunk != null && typeof chunk !== 'function') {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), (typeof enc === 'string' ? enc : 'utf8') as BufferEncoding));
            }
            const done = typeof enc === 'function' ? enc : cb;
            if (typeof done === 'function') done();
            return true;
        } as any;
        res.end = function end(chunk?: any, enc?: any, cb?: any) {
            if (chunk != null && typeof chunk !== 'function') res.write(chunk, enc);
            if (!res.headersSent) res.writeHead(res.statusCode);
            (res as any).finished = true;
            finish();
            const done = typeof chunk === 'function' ? chunk : typeof enc === 'function' ? enc : cb;
            if (typeof done === 'function') done();
            res.emit('finish');
            return res;
        } as any;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('The site took too long to answer this request.'));
        }, DISPATCH_TIMEOUT_MS);

        DISPATCH.set(req, ctx);
        try {
            app().handle(req, res, (err: any) => {
                if (settled) return;
                if (err) { settled = true; clearTimeout(timer); reject(err); return; }
                res.statusCode = 404;
                res.end();
            });
        } catch (e) {
            settled = true;
            clearTimeout(timer);
            reject(e);
        }
    });
}

module.exports = { dispatchRest, dispatchContextOf };
