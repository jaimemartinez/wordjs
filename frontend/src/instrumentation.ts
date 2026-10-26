import { checkGatewayIdentity } from './lib/gatewayIdentity';


/**
 * The cluster mTLS options for the leg that REGISTERS this node with the gateway.
 *
 * `rejectUnauthorized` is TRUE, and that is the whole point of this function existing: it used to be
 * `false` with a "dev override" comment, so this node handed its `x-gateway-secret` — and the routes
 * it is willing to serve — to whatever answered on `gatewayHost:gatewayInternalPort`, accepting ANY
 * certificate. The three files were already loaded; the peer was simply never verified. A process
 * that port-steals the internal port, or anything on the path in a multi-machine cluster, collected
 * the cluster secret and could answer as the gateway.
 *
 * The peer check is ordinary hostname verification AND the gateway's identity
 * (`lib/gatewayIdentity.ts` → `checkGatewayIdentity`): every cluster certificate — a backend's or a
 * frontend's too — carries `localhost` + `127.0.0.1` in its SANs, so the hostname alone would accept
 * another node answering on the gateway's internal port. The sibling legs to the same port
 * (`lib/revalidateSecret.ts`, `lib/edgeSync.ts`) and the backend's (`core/frontend-purge.ts` →
 * `gatewayPurgeOptions`) use the same check, never a CN check INSTEAD of the hostname.
 *
 * `fsMod` is injected because this module is loaded in every Next runtime: `fs` may only be imported
 * inside the `NEXT_RUNTIME === 'nodejs'` branch (see below), and a test needs to drive it anyway.
 * Returns `{}` when this node has no cluster identity — the caller reads that as "no mTLS" and falls
 * back to plain HTTP on the public port, exactly as before.
 */
export function gatewayClientOptions(
    fsMod: { existsSync: (p: string) => boolean; readFileSync: (p: string) => any },
    paths: { ca: string; key: string; cert: string },
): Record<string, any> {
    if (!(fsMod.existsSync(paths.ca) && fsMod.existsSync(paths.key) && fsMod.existsSync(paths.cert))) return {};
    return {
        ca: fsMod.readFileSync(paths.ca),
        key: fsMod.readFileSync(paths.key),
        cert: fsMod.readFileSync(paths.cert),
        rejectUnauthorized: true,
        checkServerIdentity: checkGatewayIdentity,
    };
}

/**
 * The port this node tells the gateway to proxy to: the one its server LISTENS on.
 *
 * `scripts/start-frontend.js` chooses that port and hands it to `server.js` as `PORT`, so `PORT` is the
 * answer; `frontendPort` (then 3001) only covers a server started some other way. It is never the port
 * of `frontendUrl`: that is the site's PUBLIC origin — the install wizard stores there the address
 * visitors use, which on a single host is the gateway itself (:3000). Advertising that port made the
 * gateway proxy every page to itself (502) after each restart of a split install made through the
 * wizard, until a health check evicted the target about 90 s later.
 */
export function advertisedPort(listenPort: string | undefined, frontendPort: unknown): string {
    if (listenPort && /^\d+$/.test(listenPort)) return listenPort;
    const configured = Number(frontendPort);
    return Number.isInteger(configured) && configured > 0 ? String(configured) : '3001';
}

/** Is the address server.js listens on a loopback one (WORDJS_FRONTEND_LISTEN_HOST)? */
export function isLoopbackListen(host: string | undefined): boolean {
    const h = String(host || '').trim().toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * The URL this node tells the gateway to proxy to, in the scheme its server ACTUALLY speaks.
 *
 * `server.js` picks HTTPS-with-mTLS or plain HTTP once, at boot, from whether this node's certificate
 * is on disk, and records the choice in `WORDJS_FRONTEND_LISTENER` before Next starts. A split install
 * writes the certificates while the frontend is already listening on plain HTTP, so registering then as
 * `https://` would send the gateway's TLS into a plain socket (ECONNRESET on every page) until the next
 * restart. Unset — a server started some other way — keeps the historical `https://`.
 *
 * A plain-HTTP listener is advertised on loopback only. It exists solely on a single-host install that
 * booted before setup (a separate-mode node is enrolled before it starts, so it always listens with
 * mTLS), where the gateway is on the same machine — and the gateway sends the cache-purge secret to the
 * registered URL, which must never cross a network in clear text. Every issuer puts 127.0.0.1 in the
 * service certificate's SANs, so the gateway's certCoversHost check accepts it.
 */
export function advertisedUrl(listener: string | undefined, hostname: string, port: string): string {
    return listener === 'http' ? `http://127.0.0.1:${port}` : `https://${hostname}:${port}`;
}

/**
 * Is this registration failure PERMANENT misconfiguration rather than "the gateway is still booting"?
 *
 * The retry loop below swallows every error and retries forever in silence, which is right for a
 * gateway that has not come up yet and wrong for a handshake the peer will refuse identically for
 * ever. Same distinction, same reasoning as `core/frontend-purge.ts` → `isHandshakeFailure`:
 * ECONNRESET counts here, because a peer refusing our certificate usually surfaces as a bare socket
 * hang up rather than a TLS alert.
 */
export function isRegisterHandshakeFailure(e: any): boolean {
    const code = String((e && e.code) || '');
    if (/^(ERR_TLS|ERR_SSL|EPROTO|ECONNRESET|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|CERT_)/.test(code)) return true;
    return /alert|handshake|certificate|self.signed|unable to verify|wrong version number/i
        .test(String((e && e.message) || ''));
}

export async function register() {
    // Monolith mode: frontend and backend share one process/port and there is no gateway to
    // register with. Without this guard an installed monolith (it holds the service certificates)
    // would dial a gateway that does not exist every 5s for the life of the process.
    if (process.env.WORDJS_MODE === 'mono') return;
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const fs = await import('fs');
        const path = await import('path');

        /**
         * Ask the gateway for the cache-purge secret if this node has cluster identity but no secret.
         * Runs at most once per process, never throws, and says what happened either way — a node it
         * cannot repair simply keeps serving TTL-fresh content, exactly as it does today.
         */
        let purgeSecretChecked = false;
        const recoverPurgeSecret = async () => {
            if (purgeSecretChecked) return;
            purgeSecretChecked = true;
            try {
                const { recoverRevalidateSecret } = await import('@/lib/revalidateSecret');
                const outcome = await recoverRevalidateSecret();
                if (outcome.status === 'recovered') console.log('[Frontend Instrumentation] cache-purge secret recovered from the gateway');
            } catch (e: any) {
                console.warn('[Frontend Instrumentation] purge-secret self-repair failed:', e?.message);
            }
        };

        /**
         * A node on another machine follows the gateway's site address and TLS switch (lib/edgeSync.ts):
         * once when registration proves the channel, then every 30 s, so a change made from the panel
         * reaches this node's wordjs-config.json without anyone editing it. A single-host node has no
         * cluster identity of its own and the sync does nothing there. Started once per process.
         */
        let edgeSyncStarted = false;
        const startEdgeSync = () => {
            if (edgeSyncStarted) return;
            edgeSyncStarted = true;
            let failureReported = false;
            const run = async () => {
                try {
                    const { syncEdgeConfig } = await import('@/lib/edgeSync');
                    const outcome = await syncEdgeConfig();
                    if (outcome.status === 'not-a-cluster-node') { clearInterval(timer); return; }
                    if (outcome.status === 'failed' && !failureReported) {
                        failureReported = true;
                        console.warn(`[Frontend Instrumentation] could not read the gateway's edge settings (${outcome.reason}); retrying every 30 s`);
                    } else if (outcome.status !== 'failed') {
                        failureReported = false;
                    }
                } catch (e: any) {
                    console.warn('[Frontend Instrumentation] edge sync failed:', e?.message);
                }
            };
            const timer = setInterval(run, 30_000);
            timer.unref?.();
            void run();
        };

        // Everything the next attempt needs, read from disk AT THAT ATTEMPT. A split install starts the
        // frontend before the wizard has written any config or certificate; reading them once, at boot,
        // left this loop dialling the gateway's public port without an identity for the life of the
        // process — every attempt a 405, and the node never registered, so every cache purge after the
        // install was dropped ("no frontend node registered") until someone restarted the frontend.
        const readRegistrationContext = () => {
            // Advertised host the gateway proxies to. Defaults to loopback (co-located), but a
            // frontend on a SEPARATE machine must advertise its routable address via config.advertiseHost
            // (or the host of config.frontendUrl) — otherwise the gateway records 127.0.0.1 and proxies
            // '/' back to its own loopback instead of the real frontend node. The port: advertisedPort.
            let hostname = '127.0.0.1';
            let frontendPort: unknown;

            // Try to read config
            let gatewayHost = 'localhost';
            let gatewayInternalPort = 3100;

            try {
                // Priority: Local (Distributed) -> Backend (Monolith)
                let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
                if (!fs.existsSync(configPath)) {
                    configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
                }

                if (fs.existsSync(configPath)) {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    if (config.gatewayHost) gatewayHost = config.gatewayHost;
                    if (config.gatewayInternalPort) gatewayInternalPort = config.gatewayInternalPort;
                    frontendPort = config.frontendPort;

                    if (config.frontendUrl) {
                        try {
                            const url = new URL(config.frontendUrl);
                            if (url.hostname) hostname = url.hostname;
                        } catch (e: any) {
                            console.warn('[Frontend Instrumentation] Failed to parse frontendUrl:', e.message);
                        }
                    }
                    // advertiseHost (explicit) wins over the frontendUrl host — this is the routable
                    // address the gateway on another machine uses to reach this frontend.
                    if (config.advertiseHost) hostname = config.advertiseHost;
                }
                // server.js listens on loopback when the gateway runs on this machine (local-gateway.js), and
                // then loopback is the only address that reaches it: the site's public name would send the
                // gateway's hop out of the box and back, onto an interface nothing listens on any more.
                if (isLoopbackListen(process.env.WORDJS_FRONTEND_LISTEN_HOST)) hostname = '127.0.0.1';
            } catch (e: any) {
                console.warn('[Frontend Instrumentation] Failed to load/parse wordjs-config.json:', e.message);
            }
            const port = advertisedPort(process.env.PORT, frontendPort);

            // mTLS Certs Load
            const certDir = fs.existsSync(path.resolve(process.cwd(), 'certs')) ? path.resolve(process.cwd(), 'certs') : path.resolve(process.cwd(), '../backend/certs');

            const caPath = path.join(certDir, 'cluster-ca.crt');
            const keyPath = path.join(certDir, 'frontend.key');
            const crtPath = path.join(certDir, 'frontend.crt');

            // Built by gatewayClientOptions (above) so the verification decision lives in ONE place
            // that a test can drive, instead of in a literal nobody re-reads.
            const clientOpts: Record<string, any> = gatewayClientOptions(fs, { ca: caPath, key: keyPath, cert: crtPath });

            const data = JSON.stringify({
                name: 'frontend',
                url: advertisedUrl(process.env.WORDJS_FRONTEND_LISTENER, hostname, port),
                routes: ['/', '/admin', '/login', '/install', '/migration', '/portal', '/_next']
            });
            return { clientOpts, data, gatewayHost, gatewayInternalPort };
        };

        const registerWithGateway = () => {
            // exponential backoff: quick retries while the gateway is coming up, 5s steady-state
            let attemptN = 0;
            let handshakeReported = false;
            let waitingReported = false;
            const retry = () => {
                attemptN++;
                setTimeout(attempt, Math.min(5000, [250, 1000, 2000][attemptN - 1] ?? 5000));
            };
            const attempt = () => {
                const { clientOpts, data, gatewayHost, gatewayInternalPort } = readRegistrationContext();
                // `/register` exists only on the gateway's internal mTLS listener and requires a cluster
                // identity, so without one there is nothing to send: wait for the install (or node-join)
                // to write the certificates, and register on the first attempt that finds them.
                if (Object.keys(clientOpts).length === 0) {
                    if (!waitingReported) {
                        waitingReported = true;
                        console.log('[Frontend Instrumentation] no cluster certificate yet — registering with the gateway once setup issues one');
                    }
                    retry();
                    return;
                }
                const targetPort = gatewayInternalPort;

                const gatewayReq = require('https').request({
                    hostname: gatewayHost,
                    port: targetPort,
                    path: '/register',
                    method: 'POST',
                    ...clientOpts,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    }
                }, (res: any) => {
                    if (res.statusCode === 200) {
                        // Registration proving out means the gateway is up AND this node's cluster
                        // certificate is accepted — the exact moment the missing purge secret can be
                        // asked for. A cluster enrolled before that secret existed has everything but
                        // it, so every purge is refused with 403 forever unless someone remembers to
                        // re-enroll the node. Repair it here instead. See lib/revalidateSecret.ts.
                        void recoverPurgeSecret();
                        startEdgeSync();
                    } else {
                        retry();
                    }
                });

                gatewayReq.on('error', (e: any) => {
                    // A refused handshake is configuration, not weather: it will fail identically for
                    // ever, so retrying it in total silence (the old behaviour) hides a node that never
                    // registers. Said ONCE per process, at error level, naming what to check.
                    if (!handshakeReported && isRegisterHandshakeFailure(e)) {
                        handshakeReported = true;
                        console.error(
                            `[Frontend Instrumentation] TLS handshake with the gateway at ${gatewayHost}:${targetPort} ` +
                            `failed (${(e && e.code) || ''} ${e && e.message}). This node will NEVER register until it is ` +
                            'fixed: check that certs/cluster-ca.crt is the gateway\'s CA and that gatewayHost matches a ' +
                            'SAN of the gateway-internal certificate.'
                        );
                    }
                    retry();
                });

                gatewayReq.write(data);
                gatewayReq.end();
            };

            attempt();
        };

        // Start registration loop
        registerWithGateway();
    }
}
