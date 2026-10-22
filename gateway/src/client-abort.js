'use strict';
/**
 * WordJS — a client that walks away must never take the process with it.
 *
 * When a browser cancels a request (a navigation away while a page loads, a cancelled prefetch, a reload
 * during a dev compile), Node destroys the request stream with `Error: aborted` (code ECONNRESET). It
 * emits that error ONLY if the stream has an 'error' listener at the moment it checks — and it emits it
 * one tick LATER. Any library that registered a listener and removes it in between (cleanup queued from
 * the response's 'close', which fires in the same socket close) leaves Node emitting an error nobody
 * listens to: an uncaught exception, and the crash guard exits. The monolith, the backend, the frontend
 * server and the gateway workers all died this way.
 *
 * The fix is structural: every incoming request gets a permanent listener of its own, registered before
 * any handler runs, so Node always has someone to deliver the abort to. A request stream's errors are
 * the client's (the connection it came on), so there is nothing to do with them but drop them.
 *
 * `isClientAbort` lets the last-resort uncaughtException handlers recognise the same error should it
 * still escape, and keep serving. It does escape: Next's development server replaces the emitter state
 * of a request to a route it is still compiling (the backend's own cache purge to /api/revalidate gives
 * up first, so every fresh dev install died right after setup), and no per-request guard survives that.
 *
 * ONE FILE, THREE COPIES: backend/src/core/client-abort.js is the source; gateway/src/client-abort.js and
 * frontend/client-abort.js are byte-identical copies (each service installs alone on its own machine in
 * separate mode). Node built-ins only. backend/src/tests/client-abort.test.ts holds them identical.
 */

const GUARDED = Symbol.for('wordjs.clientAbortGuarded');

/** Node's own "the client went away" error on a request stream. */
function isClientAbort(err) {
    return !!err && typeof err === 'object' && err.code === 'ECONNRESET' && err.message === 'aborted';
}

function dropClientStreamError() { /* the client is gone; nothing to answer */ }

/**
 * Give this request a permanent 'error' listener (idempotent) — and, because code can still rebuild a
 * request's listener list without going through removeListener, its own emit drops a client abort that
 * nobody is left to hear.
 */
function guardRequest(req) {
    if (!req || typeof req.on !== 'function' || req[GUARDED]) return;
    Object.defineProperty(req, GUARDED, { value: true });
    req.on('error', dropClientStreamError);
    const emit = req.emit;
    req.emit = function emitGuarded(type, err) {
        if (type === 'error' && isClientAbort(err) && this.listenerCount('error') === 0) return false;
        return emit.apply(this, arguments);
    };
}

/** Guard every request `server` receives, before any other 'request' listener runs. */
function installClientAbortGuard(server) {
    if (!server || typeof server.prependListener !== 'function' || server[GUARDED]) return server;
    Object.defineProperty(server, GUARDED, { value: true });
    server.prependListener('request', (req) => guardRequest(req));
    return server;
}

module.exports = { isClientAbort, guardRequest, installClientAbortGuard };
