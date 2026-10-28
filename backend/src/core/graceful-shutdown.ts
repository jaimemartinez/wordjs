/**
 * WordJS — stopping the process without dropping the requests it is serving.
 *
 * SIGTERM used to flush the database and call process.exit(0) at once: every request in flight was cut,
 * and a load balancer or Kubernetes Service kept sending new ones to the process until it vanished, so
 * every deploy, scale-down or node drain answered 5xx. Now a termination signal:
 *
 *   1. marks the process DRAINING: /readyz answers 503 `draining` from that moment (core/readiness),
 *      so the orchestrator takes this instance out of rotation;
 *   2. waits WORDJS_SHUTDOWN_DRAIN_DELAY_MS for that to happen (5 s under Kubernetes, where endpoint
 *      removal lags the signal; 0 elsewhere, so Ctrl+C in a terminal stays immediate);
 *   3. stops every tracked server from accepting connections and lets the requests already running
 *      finish (responses carry `Connection: close`, idle keep-alive sockets are closed, and open
 *      `text/event-stream` responses are ended and upgraded WebSocket connections closed — they never
 *      finish by themselves);
 *   4. after WORDJS_SHUTDOWN_TIMEOUT_MS (10 s) closes whatever is still open, so a stuck request
 *      cannot hold the process past the orchestrator's grace period (Kubernetes: 30 s by default);
 *   5. flushes the database and exits 0.
 *
 * A second signal while draining exits at once (the operator pressing Ctrl+C twice). Servers register
 * themselves with trackServer(): the backend's own listener in split mode, and the monolith's public
 * and loopback listeners (monolith.js), which share this process and this module.
 */

import type { Server } from 'http';

const log = require('./module-logger').moduleLogger('core/graceful-shutdown');

const servers = new Set<Server>();
// Closed only after the others are done: the monolith's loopback API, which the pages still rendering
// on the public listener call while they finish.
const lastServers = new Set<Server>();
let draining = false;
let started: Promise<void> | null = null;

/** Clamp an env value in ms to [min, max]; `fallback` when unset or not a number. */
function msFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/** How long /readyz reports `draining` before the listeners stop accepting. */
export function drainDelayMs(env: NodeJS.ProcessEnv = process.env): number {
    return msFromEnv(env.WORDJS_SHUTDOWN_DRAIN_DELAY_MS, env.KUBERNETES_SERVICE_HOST ? 5000 : 0, 0, 60000);
}

/** The longest the requests in flight are waited for once the listeners are closed. */
export function shutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    return msFromEnv(env.WORDJS_SHUTDOWN_TIMEOUT_MS, 10000, 0, 120000);
}

/** Is this process on its way out? /readyz answers 503 while it is. */
export function isDraining(): boolean {
    return draining;
}

/**
 * Follow a server so a shutdown closes it. While draining, every response it sends says
 * `Connection: close`, so a keep-alive client does not reuse the socket for a request that would be cut.
 */
export function trackServer<T extends Server>(server: T, opts: { closeLast?: boolean } = {}): T {
    const set = opts.closeLast ? lastServers : servers;
    set.add(server);
    server.on('close', () => set.delete(server));
    // Every socket, so a drain can find the upgraded ones (WebSockets) that close() waits on forever.
    // A 'connection' listener, not an 'upgrade' one: the monolith's public server allows only its own.
    server.on('connection', (socket: any) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.on('request', (_req: unknown, res: any) => {
        open.add(res);
        res.on('close', () => open.delete(res));
        // A response whose keep-alive head went out before the drain leaves its socket idle when it
        // finishes; close() only closed the sockets idle at the moment it ran.
        res.on('finish', () => {
            if (draining) setImmediate(() => { try { (server as any).closeIdleConnections?.(); } catch { /* closed */ } });
        });
        if (draining && !res.headersSent) {
            try { res.setHeader('Connection', 'close'); } catch { /* headers already out */ }
        }
    });
    return server;
}

// Responses still being written, so a drain can end the ones that never finish on their own.
const open = new Set<any>();
const sockets = new Set<any>();

/**
 * Close upgraded connections (a WebSocket: in dev, Next's HMR channel). Once upgraded a socket has
 * neither an HTTP parser nor a response, so neither close() nor closeIdleConnections() ends it, and
 * it held every drain until the timeout. A WebSocket client reconnects on its own.
 */
function closeUpgradedSockets(): number {
    let closed = 0;
    for (const socket of sockets) {
        if (!socket.parser && !socket._httpMessage && !socket.destroyed) {
            try { socket.destroy(); closed++; } catch { /* already gone */ }
        }
    }
    return closed;
}

/**
 * End every open event stream (notifications, collaboration, hooks, MCP, GraphQL subscriptions). A
 * stream never completes by itself, so without this each one held the drain until the timeout; an
 * EventSource reconnects on its own, to an instance that is still in rotation.
 */
function endEventStreams(): number {
    let ended = 0;
    for (const res of open) {
        let type = '';
        try { type = String(res.getHeader('content-type') || ''); } catch { /* not an http response */ }
        // writeHead(status, {…}) sends headers getHeader() never sees: read the head already written.
        const sent = typeof res._header === 'string' && /^content-type:\s*text\/event-stream/im.test(res._header);
        if (type.toLowerCase().startsWith('text/event-stream') || sent) {
            try { res.end(); ended++; } catch { /* already gone */ }
        }
    }
    return ended;
}

/** Close one server, waiting for its requests until `deadline`; then cut what is left. */
function closeServer(server: Server, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
            log.warn(`requests still open after ${timeoutMs} ms: closing them.`);
            try { (server as any).closeAllConnections?.(); } catch { /* already closed */ }
            finish();
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        try {
            server.close(() => finish());
            // close() stops accepting; idle keep-alive sockets would otherwise wait for their own timeout.
            (server as any).closeIdleConnections?.();
        } catch {
            finish(); // not listening
        }
    });
}

export interface ShutdownOptions {
    /** Persist what an in-memory driver holds. */
    flush?: () => void;
    /** How the process ends; tests replace it. */
    exit?: (code: number) => void;
    env?: NodeJS.ProcessEnv;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Drain and stop. Idempotent: a second call returns the shutdown already running. The returned promise
 * resolves after `exit` was called.
 */
export function shutdown(signal: string, opts: ShutdownOptions = {}): Promise<void> {
    if (started) return started;
    const env = opts.env || process.env;
    const exit = opts.exit || ((code: number) => process.exit(code));
    const sleep = opts.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    draining = true;
    started = (async () => {
        const delay = drainDelayMs(env);
        const timeout = shutdownTimeoutMs(env);
        log.info(`${signal} received: draining (${servers.size + lastServers.size} listener(s), delay ${delay} ms, timeout ${timeout} ms).`);
        if (delay > 0) await sleep(delay);
        // One deadline for both phases, so the whole drain stays within the timeout.
        const deadline = Date.now() + timeout;
        const closing = Promise.all([...servers].map((s) => closeServer(s, timeout)));
        const streams = endEventStreams();
        if (streams) log.info(`ended ${streams} event stream(s); their clients reconnect elsewhere.`);
        const upgraded = closeUpgradedSockets();
        if (upgraded) log.info(`closed ${upgraded} upgraded connection(s) (WebSocket).`);
        await closing;
        await Promise.all([...lastServers].map((s) => closeServer(s, Math.max(0, deadline - Date.now()))));
        try { if (opts.flush) opts.flush(); } catch (e: any) { log.warn(`could not flush the database: ${(e && e.message) || String(e)}`); }
        log.info('Shutdown complete.');
        exit(0);
    })();
    return started;
}

/**
 * Install the SIGTERM/SIGINT handlers once. A second signal during the drain exits immediately.
 */
export function installSignalHandlers(opts: ShutdownOptions = {}): void {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.on(sig, () => {
            if (draining) {
                log.warn(`${sig} received again while draining: exiting now.`);
                try { if (opts.flush) opts.flush(); } catch { /* best effort */ }
                (opts.exit || ((code: number) => process.exit(code)))(0);
                return;
            }
            void shutdown(sig, opts);
        });
    }
}

/** Tests only: forget the servers and the drain. */
export function resetForTests(): void {
    servers.clear();
    lastServers.clear();
    open.clear();
    sockets.clear();
    draining = false;
    started = null;
}
