/**
 * On-demand frontend cache purge (Fase 1 of the performance program).
 *
 * The public frontend serves HTML from Next's Full-Route Cache and JSON from its Data Cache, both
 * tagged (see frontend/src/lib/server-api.ts: 'settings', 'posts', 'post:<slug>', 'menus', …) and
 * bounded by a 60s revalidate. This module makes changes INSTANT instead of eventually-consistent:
 * content hooks enqueue the affected tags/paths, and a debounced flush POSTs them to the
 * frontend's /api/revalidate route, authenticated with a shared secret.
 *
 * Delivery has two shapes, picked by purgeTransport():
 *  - DIRECT (monolith, and a split whose frontend sits on this same host): POST straight at the
 *    frontend's own origin. Shortest path, unchanged.
 *  - VIA THE GATEWAY (separate mode): a cluster-enrolled backend has no idea where the frontend nodes
 *    live — its `frontendUrl` is the gateway's PUBLIC origin, whose /api prefix routes right back here,
 *    and there may be N frontend replicas. So it asks the gateway over the internal mTLS channel it
 *    already uses for /register (POST /purge), and the gateway fans the purge out to every frontend in
 *    its registry. The backend guesses nothing and no new secret or discovery mechanism is introduced.
 *
 * Security model:
 *  - The secret lives in wordjs-config.json (`revalidateSecret`) — the file is already the trust anchor
 *    for jwtSecret and is never readable by plugins (io-guard) or served. On a single host this module
 *    generates it on first use; in a cluster the GATEWAY owns it and enrollment writes the same value
 *    into every node's config (so the frontend can verify a purge from its own disk).
 *  - The purge endpoint can only INVALIDATE caches (forcing a re-render) — it can never inject
 *    content — so the blast radius of a leaked secret is extra renders, not integrity loss.
 *  - Both TLS legs go through ONE builder (clusterTlsOptions): the cluster CA, this node's CN=backend
 *    key+cert, and rejectUnauthorized:true — never false, anywhere. The direct leg additionally
 *    allowlists the peer CN (it dials the frontend as localhost, which no SAN covers); the gateway leg
 *    keeps hostname verification. The client certificate is not optional decoration on either: the
 *    frontend listens with requestCert+rejectUnauthorized from its first boot after installation, and
 *    a leg without it dies in the handshake — which is precisely how this transport spent months
 *    delivering nothing (audit #27).
 *  - Purging is fire-and-forget and debounced (1.5s): a WXR import touching 500 posts produces one
 *    coalesced purge, not 500 — and a frontend that is down just means TTL freshness, never errors
 *    in the write path.
 */

import * as fs from 'fs';
import * as path from 'path';

const crypto = require('crypto');
const { getConfig, saveConfig } = require('./configManager');
const { addAction } = require('./hooks');

const FLUSH_DELAY_MS = 1500;
const PURGE_TIMEOUT_MS = 3000;

let pendingTags = new Set<string>();
let pendingPaths = new Set<string>();
let flushTimer: any = null;
let lastFailureLog = 0;
/**
 * Permanent misconfigurations currently in force, keyed by WHAT is broken (transport + peer + kind of
 * fault) rather than by the message text.
 *
 * Two reasons for the key. First, this state is what /health/details reports, and a state that is
 * only ever added to lies as soon as the operator fixes the problem: the TLS options are rebuilt on
 * every purge, so repairing the certificates or re-enrolling the node makes purging work again while
 * the panel kept saying BROKEN — with a note explaining that it would not recover on its own — until
 * someone restarted the process. A key that a SUCCESS can clear is what makes the field a signal
 * instead of a scar. Second, the old key was the full message including `e.code` and `e.message`, so
 * a peer producing varying text turned "once per process" into a drip and the set grew without bound.
 */
const permanentFailures = new Map<string, { message: string; at: number }>();

/**
 * How long a recorded permanent fault stays asserted WITHOUT being re-observed.
 *
 * A fault here is a statement about the last delivery attempt, and every attempt re-evaluates it
 * (the TLS options are rebuilt per purge, and a peer that answers clears its keys). Round 1 closed
 * "the panel never recovers by success"; this closes the other half — the panel must not keep
 * asserting a fault it has had no chance to re-confirm. On a low-traffic site the next purge can be
 * days away, so without an expiry a single ambiguous ECONNRESET (a frontend rolling restart happening
 * to coincide with a publish — and publishing is exactly what triggers a purge) pinned /health/details
 * to BROKEN, with a note insisting it would not recover on its own, until someone published again.
 */
const PERMANENT_TTL_MS = 30 * 60 * 1000;

/** Where this installation lives on disk — NOT the process's cwd.
 *
 *  The certificates are written by core/certManager, which resolves them as
 *  `path.resolve(__dirname, '../../certs')`; config/app.ts derives its root the same way. Reading them
 *  back relative to the cwd only agrees with that while the backend is started from `backend/`, which
 *  is a convention nothing enforces: a systemd unit with WorkingDirectory at the repo root, a
 *  container with another layout or a supervisor running `node backend/server.js` all break it — and
 *  they break it SILENTLY (frontendServesTls() answers "no certificates", the purge goes out in the
 *  clear against a TLS socket, and the failure does not always look like a handshake). Anchor to the
 *  installation instead, and the answer stops depending on how the process was launched.
 *
 *  WORDJS_BACKEND_ROOT overrides it for a test that stages a whole installation in a temp directory
 *  (and for an unusual deployment that really does split the tree). */
const BACKEND_ROOT = process.env.WORDJS_BACKEND_ROOT
    ? path.resolve(String(process.env.WORDJS_BACKEND_ROOT))
    : path.resolve(__dirname, '..', '..');

/** The shared secret, generating + persisting it on first use. Null until the site is installed. */
function ensureSecret(): string | null {
    const cfg = getConfig();
    if (!cfg) return null;
    if (cfg.revalidateSecret) return String(cfg.revalidateSecret);
    const secret = crypto.randomBytes(32).toString('hex');
    return saveConfig({ revalidateSecret: secret }) ? secret : null;
}

type PurgeTransport =
    | { mode: 'direct'; origin: string }
    | { mode: 'gateway'; host: string; port: number };

/**
 * Is the direct target the monolith's OWN in-process Next server (rather than a co-located frontend
 * process)? One predicate, because two places need the same answer: purgeTransport picks the origin
 * from it, and deliverDirect must NOT second-guess the scheme of a listener this very process owns.
 */
function isMonolithTarget(env: any = process.env): boolean {
    return env.WORDJS_MODE === 'mono' && !!env.PORT;
}

/**
 * Where does a purge from THIS node go?
 *
 * Exported for tests — the caller supplies the config, the environment and the certificate-existence
 * check, so the decision can be exercised without a cluster on disk.
 */
function purgeTransport(
    cfg: any,
    env: any = process.env,
    certExists: (p: string) => boolean = fs.existsSync
): PurgeTransport {
    // Monolith serves Next itself on its public port (monolith.js exports it as PORT) — the
    // config's frontendUrl is the SPLIT-mode frontend (3001) and would be a dead target here.
    if (isMonolithTarget(env)) {
        return { mode: 'direct', origin: `http://127.0.0.1:${env.PORT}` };
    }
    const c = cfg || {};
    // Cluster-enrolled node (scripts/node-join.js) — same predicate the installer uses to decide that
    // enrollment, not single-host defaults, is authoritative (routes/setup.ts isEnrolledConfig). Here it
    // means: the frontend is on ANOTHER machine, so this node must not try to guess its address. The
    // gateway holds the registry; ask it.
    // The certificate existence check goes through the SAME resolver as every other read of this
    // config key (clusterCertPaths → BACKEND_ROOT). It used to be `path.resolve(c.mtls.cert)`, i.e.
    // the cwd — the very defect wave 3 fixed one function below, in the same file: launched from
    // anywhere but `backend/` an enrolled node decided it was NOT enrolled and sent its purges at
    // `frontendUrl` (the gateway's public origin, whose /api routes straight back here) instead of
    // asking the gateway to fan them out. Purging was dead and nothing said so.
    if (c.advertiseHost && c.mtls && c.mtls.cert && c.gatewayHost && certExists(clusterCertPaths(c).cert)) {
        return { mode: 'gateway', host: String(c.gatewayHost), port: Number(c.gatewayInternalPort) || 3100 };
    }
    return { mode: 'direct', origin: String(c.frontendUrl || 'http://localhost:3000').replace(/\/+$/, '') };
}

/** Log a delivery failure at most once an hour — a purge that cannot be delivered is a TTL fallback,
 *  not an error, but it must never fail SILENTLY. */
function warnOnce(message: string) {
    if (Date.now() - lastFailureLog > 3600_000) {
        lastFailureLog = Date.now();
        console.warn(`[Purge] ${message} (content stays TTL-fresh)`);
    }
}

/**
 * A purge that fails for a PERMANENT reason — a TLS handshake the peer will refuse identically
 * forever, unreadable cluster material — is not the same event as "the frontend happens to be down",
 * and it must not share the once-an-hour channel with it.
 *
 * That sharing is what hid audit #27 for so long: the direct transport attached neither `key` nor
 * `cert`, so every purge in split mode died in the handshake — and the single line saying so could be
 * swallowed by any unrelated warning that had already used the hour's budget. Here each distinct
 * misconfiguration is reported ONCE per process, at error level, naming the fix.
 */
function failPermanent(key: string, message: string) {
    const known = permanentFailures.get(key);
    // Re-observing the SAME fault refreshes its clock (it is still true) without repeating the line.
    permanentFailures.set(key, { message, at: Date.now() });
    if (known) return;
    console.error(`[Purge] MISCONFIGURED — on-demand purging is DEAD until this is fixed: ${message}`);
}

/**
 * That fault is gone: the very thing that could not work just worked.
 *
 * Called when the cluster material reads back cleanly and when a peer actually ANSWERS a purge — a
 * reply means the handshake completed, which is exactly what the recorded fault said was impossible.
 * Without this the health field never returns to OK and the operator learns to ignore it.
 */
function clearPermanent(key: string) {
    if (permanentFailures.delete(key)) {
        console.log(`[Purge] recovered — the reported fault is gone (${key}); on-demand purging works again.`);
    }
}

/** What has permanently broken purging in this process. Exported for /health surfaces and tests. */
function purgeFailureState(): string[] {
    const cutoff = Date.now() - PERMANENT_TTL_MS;
    for (const [key, fault] of permanentFailures) {
        if (fault.at < cutoff) {
            permanentFailures.delete(key);
            console.log(`[Purge] retiring an unconfirmed fault (${key}): it has not been observed for ` +
                `${Math.round(PERMANENT_TTL_MS / 60000)} min. The next purge re-reports it if it is still true.`);
        }
    }
    return [...permanentFailures.values()].map((f) => f.message);
}

/** Where this node's cluster mTLS material lives: the enrolled/installed paths, or the defaults the
 *  installer writes (routes/setup.ts writes exactly these into `mtls` for a non-enrolled install). */
function clusterCertPaths(cfg: any): { ca: string; key: string; cert: string } {
    const m = (cfg && cfg.mtls) || {};
    // Relative paths are relative to the INSTALLATION (BACKEND_ROOT), which is where certManager
    // writes them, not to whatever directory the process happens to have been started in. An absolute
    // configured path still wins — path.resolve returns it untouched.
    return {
        ca: path.resolve(BACKEND_ROOT, String(m.ca || 'certs/cluster-ca.crt')),
        key: path.resolve(BACKEND_ROOT, String(m.key || 'certs/backend.key')),
        cert: path.resolve(BACKEND_ROOT, String(m.cert || 'certs/backend.crt')),
    };
}

/**
 * THE cluster TLS options — ca + key + cert, in ONE place, for every leg that talks TLS inside the
 * cluster.
 *
 * This function exists because the two transports built them separately and one of them built them
 * HALF-WAY: the gateway leg passed ca+key+cert, while the direct leg loaded the CA and defined
 * checkServerIdentity and attached NEITHER key NOR cert. The frontend starts with
 * `requestCert: true, rejectUnauthorized: true` as soon as the certificates the installer itself
 * generates exist — i.e. on every boot after installation (frontend/server.js) — so it demanded a
 * client certificate, got none, and aborted the handshake. On-demand purging was dead in split mode:
 * every publish, edit and settings change stayed invisible until the ISR window expired.
 *
 * A half-built version can no longer exist: either all three files are readable and you get complete
 * options, or you get null and the caller must say so out loud.
 *
 * @param allowedCns when given, the peer is authorized by its certificate CN instead of by hostname.
 *        The direct leg needs this (it addresses the frontend as localhost/127.0.0.1, which no SAN
 *        covers); the gateway leg deliberately does NOT pass it, because it dials the gateway by the
 *        very host its certificate is issued for and default verification is the stronger check.
 */
function clusterTlsOptions(cfg: any, allowedCns?: string[]): any | null {
    const paths = clusterCertPaths(cfg);
    try {
        const options: any = {
            ca: fs.readFileSync(paths.ca),
            key: fs.readFileSync(paths.key),
            cert: fs.readFileSync(paths.cert),
            rejectUnauthorized: true,
        };
        if (allowedCns) {
            options.checkServerIdentity = (_h: string, peer: any) => {
                const cn = peer && peer.subject && peer.subject.CN;
                return allowedCns.includes(cn) ? undefined
                    : new Error(`purge: unexpected upstream CN '${cn}'`);
            };
        }
        // The material reads: whatever was wrong with it is not wrong any more.
        clearPermanent(FAULT_MATERIAL);
        return options;
    } catch (e: any) {
        failPermanent(
            FAULT_MATERIAL,
            `cluster mTLS material unreadable (${e && e.message}) — expected ${paths.ca}, ${paths.key} and ` +
            `${paths.cert}. Re-run the installer or re-enroll this node.`
        );
        return null;
    }
}

/**
 * Does the co-located frontend actually speak TLS?
 *
 * Derived from the REAL listener, not from the stored `frontendUrl`. frontend/server.js decides
 * exactly like this — its own certs directory if `frontend.crt` is there, otherwise the backend's —
 * and serves HTTPS when all three files exist. The stored URL is a separate, older decision and the
 * two disagree routinely: with the gateway configured `ssl: false` the installer leaves
 * `frontendUrl` as `http://localhost:3001` while the frontend is already enforcing mTLS, so the purge
 * went out in the clear against a TLS socket and died just as thoroughly as the missing-cert case.
 *
 * Paths are anchored to BACKEND_ROOT — the installation, derived from this file's own location —
 * rather than to the process's cwd. Resolving them against the cwd made the answer depend on how the
 * service was launched: from anywhere but `backend/` this returned false without a word, and a purge
 * then went out in the clear at a TLS socket, which is the variant of #27 this predicate exists to
 * close.
 */
function frontendServesTls(certExists: (p: string) => boolean = fs.existsSync): boolean {
    const frontendCerts = path.resolve(BACKEND_ROOT, '..', 'frontend', 'certs');
    const backendCerts = path.resolve(BACKEND_ROOT, 'certs');
    const dir = certExists(path.join(frontendCerts, 'frontend.crt')) ? frontendCerts : backendCerts;
    return ['cluster-ca.crt', 'frontend.key', 'frontend.crt']
        .every((f) => certExists(path.join(dir, f)));
}

/** The two things that can be permanently wrong, as stable keys (see permanentFailures). The peer
 *  key carries host:port so a cluster with several peers reports each one, and so a repaired peer
 *  clears exactly its own entry. */
const FAULT_MATERIAL = 'cluster-mtls-material';
const faultPeer = (kind: string, hostname: any, port: any) => `${kind}:${hostname}:${port}`;

/**
 * Did this request die in the TLS handshake? Then it is configuration, not weather.
 *
 * ECONNRESET counts on a TLS leg: when a peer with `requestCert: true, rejectUnauthorized: true`
 * refuses our (missing or untrusted) client certificate, Node most often surfaces it as a bare
 * "socket hang up" rather than an alert — that is the exact signature of the bug this file was
 * fixed for, and treating it as a transient outage is how it stayed invisible.
 */
function isHandshakeFailure(e: any, overTls: boolean, handshakeCompleted: boolean = false): boolean {
    if (!overTls) return false;
    // THE VERIFIED ATTRIBUTE BEATS THE AMBIGUOUS LABEL. `ECONNRESET` on a TLS leg is both signatures
    // at once: a peer refusing our (missing/untrusted) client certificate, AND a peer that was
    // restarting — a rolling deploy, a `next build` rotating the process, a proxy dropping an idle
    // socket. The error code cannot tell them apart, but the SOCKET can: if `secureConnect` already
    // fired, the TLS session was established and negotiation succeeded, so whatever killed the
    // connection afterwards is weather and belongs on the once-an-hour channel — never on the health
    // field that tells the operator their configuration is broken.
    if (handshakeCompleted) return false;
    const code = String((e && e.code) || '');
    if (/^(ERR_TLS|ERR_SSL|EPROTO|ECONNRESET|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|CERT_)/.test(code)) return true;
    return /alert|handshake|certificate|self.signed|unable to verify|wrong version number|ssl|tls/i
        .test(String((e && e.message) || ''));
}

/**
 * The MIRROR failure: we spoke cleartext HTTP and the peer answered TLS.
 *
 * That is the other half of #27 variant 2 — `frontendUrl` says http:// while the frontend enforces
 * mTLS — and it does NOT look like a handshake error, because on our side nothing negotiates: the
 * client parses the server's TLS record as an HTTP response and gives up with an HPE_* parse error
 * (or an ERR_HTTP one). Left on the once-an-hour channel it reads as "the frontend is flaky", which
 * is how this bug lived for months. A peer that answers with a protocol we did not speak is a
 * configuration fault, and it is reported as one.
 */
function isCleartextAgainstTls(e: any, overTls: boolean): boolean {
    if (overTls) return false;
    const code = String((e && e.code) || '');
    if (/^(HPE_|ERR_HTTP_)/.test(code)) return true;
    return /parse error|invalid constant|invalid header/i.test(String((e && e.message) || ''));
}

/**
 * The one safe protocol-recovery case for a direct, co-located purge: certificates appeared after
 * frontend/server.js had already committed to its HTTP fallback listener for this process lifetime.
 *
 * Do not broaden this to generic TLS failures. A rejected/untrusted certificate must stay a hard mTLS
 * failure, never become a cleartext retry. OpenSSL's `wrong version number` means the peer answered
 * cleartext HTTP to our TLS ClientHello; and deliverDirect only uses this result when frontendUrl itself
 * explicitly declares http://. The retry therefore follows the configured transport during the narrow
 * first-install transition, while a configured https:// origin can never downgrade.
 */
function isTlsAgainstCleartext(e: any, overTls: boolean): boolean {
    if (!overTls || String((e && e.code) || '') !== 'EPROTO') return false;
    return /wrong version number|unknown protocol|packet length too long|http request/i
        .test(String((e && e.message) || ''));
}

/**
 * Fire one purge request. Never throws, never rejects: the write path must not depend on it.
 * The (small) response body is collected — the gateway answers with a per-node delivery report and
 * silently discarding it would hide a cluster that accepted the purge but could not deliver it.
 */
function send(
    options: any,
    body: string,
    onDone: (res: any, text: string) => void,
    onError?: (error: any) => boolean,
) {
    try {
        const overTls = options.protocol !== 'http:';
        const mod = overTls ? require('https') : require('http');
        // Did TLS actually come up on this request? (See isHandshakeFailure.) A reused keep-alive
        // socket is already authorized when it is assigned, so read that too — otherwise a reset on a
        // pooled connection would look like a failed handshake that never happened on it.
        let handshakeCompleted = false;
        const req = mod.request(options, (res: any) => {
            // The peer ANSWERED: the transport works, whatever it was reported to be. Both faults a
            // delivery can have are about not being able to talk to this peer at all, so a reply
            // retires them — this is what makes the health field recover without a restart.
            clearPermanent(faultPeer('tls', options.hostname, options.port));
            clearPermanent(faultPeer('cleartext', options.hostname, options.port));
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { if (text.length < 4096) text += c; });
            res.on('end', () => onDone(res, text));
        });
        req.on('socket', (socket: any) => {
            if (!overTls) return;
            if (socket.encrypted && socket.authorized) handshakeCompleted = true;
            else socket.on('secureConnect', () => { handshakeCompleted = true; });
        });
        req.on('timeout', () => req.destroy());
        req.on('error', (e: any) => {
            // A caller may recover only a transport-specific error it can prove safe. Returning true
            // means it took ownership (normally by retrying); every other error keeps the common
            // permanent-vs-transient classification below.
            if (onError && onError(e)) return;
            // A refused/aborted handshake is permanent misconfiguration and gets the loud channel;
            // ECONNREFUSED/ETIMEDOUT/ENOTFOUND are "the peer is down or moved" and stay on the
            // once-an-hour one.
            if (isHandshakeFailure(e, overTls, handshakeCompleted)) {
                failPermanent(
                    faultPeer('tls', options.hostname, options.port),
                    `TLS handshake with ${options.hostname}:${options.port} failed (${(e && e.code) || ''} ${e && e.message}). ` +
                    'The peer enforces mTLS; this node must present its cluster certificate. Check the mtls paths in wordjs-config.json.'
                );
                return;
            }
            if (isCleartextAgainstTls(e, overTls)) {
                failPermanent(
                    faultPeer('cleartext', options.hostname, options.port),
                    `${options.hostname}:${options.port} answered something that is not HTTP (${(e && e.code) || ''} ${e && e.message}) ` +
                    'to a cleartext purge — the peer is almost certainly serving TLS. Point frontendUrl at https://, ' +
                    'or make this node\'s certificates visible so the transport can detect it.'
                );
                return;
            }
            warnOnce(`delivery failed: ${e && e.message}`);
        });
        req.write(body);
        req.end();
    } catch { /* never let a purge failure touch the write path */ }
}

/**
 * DIRECT delivery to a co-located frontend (monolith / single-host split).
 *
 * @param cfg     the site config, for the cluster mTLS material
 * @param isMono  true when the target is this very process's Next server: then the origin's scheme is
 *                a fact about a listener we own, and nothing about the frontend's certs applies.
 */
function deliverDirect(origin: string, body: string, secret: string, cfg: any, isMono: boolean) {
    let url: URL;
    try { url = new URL(origin + '/api/revalidate'); } catch { return; }

    // frontendServesTls() describes how the frontend will boot from the material currently on disk.
    // Usually that is also the live listener. There is one real transition where it is not: during a
    // first install, server.js already chose HTTP before setup generated the certificates. Prefer mTLS
    // whenever either source says TLS, then recover below only from OpenSSL's exact "TLS client spoke to
    // cleartext HTTP" signature and only when the configured origin explicitly says http://.
    const configuredHttps = url.protocol === 'https:';
    const inferredHttps = !isMono && !configuredHttps && frontendServesTls();
    const isHttps = configuredHttps || inferredHttps;
    const requestOptions = (overTls: boolean): any => ({
        protocol: overTls ? 'https:' : 'http:',
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (overTls ? 443 : 80),
        path: url.pathname,
        timeout: PURGE_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-revalidate-secret': secret,
        },
    });
    const options = requestOptions(isHttps);
    if (isHttps) {
        // The frontend serves the cluster-CA cert with a service CN (not an IP SAN) AND demands a
        // client certificate back (requestCert + rejectUnauthorized). Same builder as the gateway leg,
        // so this side can never again be assembled half-way.
        const tls = clusterTlsOptions(cfg, ['frontend', 'gateway']);
        if (!tls) return; // failPermanent already said what is missing; sending in the clear is futile
        Object.assign(options, tls);
    }
    const onDone = (res: any, _text: string) => {
        if (res.statusCode !== 200) warnOnce(`frontend /api/revalidate answered ${res.statusCode}`);
    };
    send(options, body, onDone, inferredHttps ? (e: any) => {
        if (!isTlsAgainstCleartext(e, true)) return false;
        // No TLS attributes are copied. This is the origin's explicitly configured HTTP transport,
        // used only until the co-located frontend restarts and consumes its new certificates.
        send(requestOptions(false), body, onDone);
        return true;
    } : undefined);
}

/**
 * The mTLS request options for asking the gateway to fan a purge out (separate mode).
 *
 * Same channel, same client identity and the same verification the /register call uses (index.ts): the
 * cluster CA plus this node's CN=backend certificate. Returns null when the material is unreadable, so
 * the caller can degrade to TTL instead of throwing. Exported for tests.
 */
function gatewayPurgeOptions(cfg: any, target: { host: string; port: number }, byteLength: number): any {
    // Same builder as the direct leg (clusterTlsOptions) — no CN allowlist here on purpose: this leg
    // dials the gateway by the very host its certificate is issued for, so Node's default hostname
    // verification is the stronger check.
    const tls = clusterTlsOptions(cfg);
    if (!tls) return null;
    return {
        protocol: 'https:',
        method: 'POST',
        hostname: target.host,
        port: target.port,
        path: '/purge',
        timeout: PURGE_TIMEOUT_MS,
        ...tls,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': byteLength,
        },
    };
}

/** VIA THE GATEWAY: it owns the registry of frontend nodes and the shared secret, so it delivers. */
function deliverViaGateway(cfg: any, target: { host: string; port: number }, body: string) {
    const options = gatewayPurgeOptions(cfg, target, Buffer.byteLength(body));
    if (!options) {
        warnOnce('cluster mTLS material unreadable — cannot ask the gateway to purge');
        return;
    }
    send(options, body, (res: any, text: string) => {
        if (res.statusCode !== 200) {
            warnOnce(`gateway /purge answered ${res.statusCode}`);
            return;
        }
        // A 200 only means the gateway ACCEPTED the purge. Its report says how many frontend nodes it
        // actually reached — a cluster with no registered frontend, or one whose node refused the shared
        // secret, is still a TTL fallback and must not pass as success.
        try {
            const report = JSON.parse(text);
            if (!report.targets) warnOnce('gateway has no frontend node registered');
            else if (report.failed) warnOnce(`gateway reached ${report.delivered}/${report.targets} frontend node(s)`);
        } catch { /* unparseable report — the gateway logs the detail on its side */ }
    });
}

function flush() {
    flushTimer = null;
    const tags = [...pendingTags];
    const paths = [...pendingPaths];
    pendingTags = new Set();
    pendingPaths = new Set();
    if (!tags.length && !paths.length) return;

    const cfg = getConfig();
    if (!cfg) return; // not installed yet — nothing to purge

    const body = JSON.stringify({ tags, paths });
    const target = purgeTransport(cfg);
    if (target.mode === 'gateway') {
        // The gateway holds the shared secret and presents it to each frontend it fans out to; this
        // node's certificate is the authorization, so no secret travels on this leg.
        deliverViaGateway(cfg, target, body);
        return;
    }
    const secret = ensureSecret();
    if (!secret) return;
    deliverDirect(target.origin, body, secret, cfg, isMonolithTarget());
}

/** Queue tags/paths for the next debounced flush. */
function purgeFrontend(tags: string[] = [], paths: string[] = []) {
    for (const t of tags) if (t) pendingTags.add(String(t));
    for (const p of paths) if (p && String(p).startsWith('/')) pendingPaths.add(String(p));
    if (!flushTimer) {
        flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
        if (flushTimer.unref) flushTimer.unref();
    }
}

/**
 * The public URL path(s) one post is actually served at, read off the frontend's REAL route map
 * (frontend/src/app/(public)):
 *
 *   (public)/[slug]        → `/<slug>`         — posts and every custom post type
 *   (public)/pages/[slug]  → `/pages/<slug>`   — pages; the URL the admin's menu builder emits
 *
 * A PAGE is live at both: `/pages/<slug>` is what the site links to, and the catch-all `/<slug>`
 * resolves it too (the backend's /posts/slug/:slug is not type-filtered) — which is also the
 * canonical the page's own <head> declares. Both are real, so both are purged.
 *
 * This used to be one hardcoded `/<postName>` for EVERY type. Right for a post, wrong for a page:
 * `/about` was purged and `/pages/about` — the URL the menu points at — was not. Nothing looked
 * broken because the `post:<slug>` TAG covers every route that rendered the post (Next invalidates
 * by tag across routes), so the path was pure decoration: a claim in the purge logs that matched no
 * route. Derive it from the route map instead of assuming, and it stays true when routes move.
 *
 * Exported for tests.
 */
function publicPathsForPost(post: { postName?: string; postType?: string } | null | undefined): string[] {
    const slug = post && post.postName ? String(post.postName) : '';
    if (!slug) return [];
    if (String(post && post.postType) === 'page') return [`/pages/${slug}`, `/${slug}`];
    return [`/${slug}`];
}

/** Tags/paths affected by a change to one post. Falls back to the broad 'posts' tag on any gap. */
async function purgeForPost(postId: any) {
    const tags = ['posts'];
    const paths = ['/'];
    try {
        const Post = require('../models/Post');
        const post = await Post.findById(postId);
        if (post) {
            if (post.postName) {
                tags.push(`post:${post.postName}`);
                paths.push(...publicPathsForPost(post));
            }
            tags.push(`post:${post.id}`, `posts:${post.postType}`);
        }
    } catch { /* deleted or unreadable — the broad tags above still purge lists */ }
    purgeFrontend(tags, paths);
}

// Options whose change alters the public chrome/canvas — anything else (cron bookkeeping, plugin
// state) must NOT purge, or background jobs would evict the cache constantly.
// NOT here, deliberately: `active_theme_version` (public settings payload) is DERIVED from the
// active theme's theme.json, not an option row, so no updated_option hook can ever carry it. It
// moves on activation (covered by 'template'/'stylesheet') and on an in-place theme rebuild, where
// PUT /api/v1/themes/:slug purges 'settings' explicitly — the same pattern DELETE /chrome/:part uses.
const SETTINGS_OPTIONS = new Set([
    'blogname', 'blogdescription', 'siteurl', 'home', 'homepage_id', 'posts_per_page',
    'template', 'stylesheet', 'active_theme_layout', 'active_theme_mods', 'theme_mods',
    'site_logo', 'site_icon', 'permalink_structure', 'default_category',
    'site_chrome_header', 'site_chrome_footer', 'site_chrome_announcement',
    // These two land on <html> itself, so a change repaints every cached page — and being absent here
    // is worse than it sounds: switching a site to Arabic would have left every already-rendered page
    // announcing lang="en" and laying out LTR until the ISR window happened to expire.
    'WPLANG', 'site_text_direction',
    // Interaction presets (F9): a block stores only the preset's ID, so editing one changes NOTHING
    // in `_puck_data` — the whole point of the design. The propagation therefore rides entirely on
    // this purge: every page that references the preset recompiles its interaction CSS (with a new
    // content hash, so the browser cannot serve the old sheet) on its next navigation. Without this
    // entry the edit would be invisible until each page's ISR window happened to expire.
    'wjs_ix_presets',
    // Transiciones entre páginas (C1): su CSS lo emite el LAYOUT público en el servidor, así que un
    // cambio solo se ve cuando la página se vuelve a renderizar. Y la variante entre documentos
    // necesita la regla en los DOS documentos: sin esta purga, encenderla dejaría medio sitio con
    // la regla y medio sin ella — es decir, sin transición y sin explicación.
    'wjs_view_transitions',
    'wjs_motion',
]);

/** Wire the content hooks. Call ONCE from initialize() after the hook system is up. */
function initFrontendPurge() {
    addAction('wp_insert_post', async (postId: any) => { await purgeForPost(postId); });
    addAction('post_updated', async (postId: any) => { await purgeForPost(postId); });
    addAction('deleted_post', async (postId: any) => {
        // row is gone — slug unknown; the broad tags cover every list/detail that could show it
        purgeFrontend(['posts'], ['/']);
        void postId;
    });
    addAction('updated_option', async (name: any) => {
        if (SETTINGS_OPTIONS.has(String(name))) purgeFrontend(['settings'], ['/']);
        // nav_menu_locations is deliberately NOT in SETTINGS_OPTIONS: it is not part of the public
        // settings payload, so purging 'settings' would be the wrong tag. Re-wiring which menu a
        // location serves must invalidate the MENU caches instead — the broad 'menus' tag covers
        // every menu:<ref> entry because both frontend fetches declare it (server-api.ts). The
        // /menus routes also purge directly; this hook covers non-route writers (Menu.setLocation
        // from the importer, plugins) so the option can never change silently under a cached nav.
        if (String(name) === 'nav_menu_locations') purgeFrontend(['menus']);
    });
}

module.exports = {
    initFrontendPurge, purgeFrontend, purgeForPost, publicPathsForPost, purgeTransport, gatewayPurgeOptions,
    // Exported for tests and for a future /health/details counter: a purge channel that is permanently
    // broken must be observable, not inferable from a log line an hour old.
    clusterTlsOptions, frontendServesTls, purgeFailureState,
    // The installation root every certificate path is resolved against, and the resolver itself:
    // exported so a test can prove they do not depend on the process's cwd.
    clusterCertPaths, BACKEND_ROOT,
    // The two halves of "is this configuration or weather?" — the decision that routes a failure to
    // the health field instead of to a log line nobody reads.
    isHandshakeFailure, isCleartextAgainstTls, isTlsAgainstCleartext,
};
