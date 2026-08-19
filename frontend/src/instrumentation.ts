
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
 * NO `checkServerIdentity` override here, deliberately — ordinary hostname verification is the
 * stronger check and it is what the rest of the cluster already does on this exact leg:
 *   - `lib/revalidateSecret.ts` (`clusterSecretRequestOptions`) dials the SAME host and the SAME
 *     internal port from THIS process, seconds later — `recoverPurgeSecret()` below fires it as soon
 *     as registration succeeds — with `rejectUnauthorized: true` and no override.
 *   - the backend's gateway leg (`core/frontend-purge.ts` → `gatewayPurgeOptions`) does the same, and
 *     says in as many words why it passes no CN allowlist: it dials the gateway by the very host its
 *     certificate is issued for.
 * Every issuer of the gateway-internal cert puts `localhost` + `127.0.0.1` in the SANs on top of the
 * advertise host (`gateway/src/cluster-ca.js` → `signPublicKey`, `backend/src/core/certManager.ts` →
 * `generateServiceCert`), so the default `gatewayHost` verifies too. A CN allowlist is only needed
 * where the dialled name cannot appear in a SAN — the backend's DIRECT purge leg to localhost — and
 * inventing a second, weaker policy for this leg would just re-open what it closes.
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
    };
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
    // register with. Without this guard the no-cert fallback targets gatewayPort's default
    // (3000 = the monolith itself), and the retry loop POSTs /register at ourselves every 5s.
    if (process.env.WORDJS_MODE === 'mono') return;
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const http = await import('http');
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

        const registerWithGateway = () => {
            // Advertised host/port the gateway proxies to. Defaults to loopback (co-located), but a
            // frontend on a SEPARATE machine must advertise its routable address via config.advertiseHost
            // (or the host of config.frontendUrl) — otherwise the gateway records 127.0.0.1 and proxies
            // '/' back to its own loopback instead of the real frontend node.
            let hostname = '127.0.0.1';
            let port = '3001';

            // Try to read config
            let gatewaySecret = null;
            let gatewayHost = 'localhost';
            let gatewayInternalPort = 3100;
            let gatewayPort = 3000;

            try {
                // Priority: Local (Distributed) -> Backend (Monolith)
                let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
                if (!fs.existsSync(configPath)) {
                    configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
                }

                if (fs.existsSync(configPath)) {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    gatewaySecret = config.gatewaySecret;
                    if (config.gatewayHost) gatewayHost = config.gatewayHost;
                    if (config.gatewayInternalPort) gatewayInternalPort = config.gatewayInternalPort;
                    if (config.gatewayPort) gatewayPort = config.gatewayPort;

                    if (config.frontendUrl) {
                        try {
                            const url = new URL(config.frontendUrl);
                            if (url.port) port = url.port;
                            if (url.hostname) hostname = url.hostname;
                        } catch (e: any) {
                            console.warn('[Frontend Instrumentation] Failed to parse frontendUrl:', e.message);
                        }
                    }
                    // advertiseHost (explicit) wins over the frontendUrl host — this is the routable
                    // address the gateway on another machine uses to reach this frontend.
                    if (config.advertiseHost) hostname = config.advertiseHost;
                }
            } catch (e: any) {
                console.warn('[Frontend Instrumentation] Failed to load/parse wordjs-config.json:', e.message);
            }

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
                url: `https://${hostname}:${port}`, // Now using HTTPS custom server
                routes: ['/', '/admin', '/login', '/install', '/migration', '/portal', '/_next']
            });

            // exponential backoff: quick retries while the gateway is coming up, 5s steady-state
            let attemptN = 0;
            let handshakeReported = false;
            const retry = () => {
                attemptN++;
                setTimeout(attempt, Math.min(5000, [250, 1000, 2000][attemptN - 1] ?? 5000));
            };
            const attempt = () => {
                const useMtls = Object.keys(clientOpts).length > 0;
                const targetPort = useMtls ? gatewayInternalPort : gatewayPort;
                const targetProtocol = useMtls ? require('https') : http;

                const gatewayReq = targetProtocol.request({
                    hostname: gatewayHost,
                    port: targetPort,
                    path: '/register',
                    method: 'POST',
                    ...clientOpts,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        'x-gateway-secret': gatewaySecret || 'secure-your-gateway-secret'
                    }
                }, (res: any) => {
                    if (res.statusCode === 200) {
                        // console.log('✅ Frontend registered with Gateway via ' + (useMtls ? 'mTLS' : 'HTTP'));
                        // Registration proving out means the gateway is up AND this node's cluster
                        // certificate is accepted — the exact moment the missing purge secret can be
                        // asked for. A cluster enrolled before that secret existed has everything but
                        // it, so every purge is refused with 403 forever unless someone remembers to
                        // re-enroll the node. Repair it here instead. See lib/revalidateSecret.ts.
                        void recoverPurgeSecret();
                    } else {
                        retry();
                    }
                });

                gatewayReq.on('error', (e: any) => {
                    // A refused handshake is configuration, not weather: it will fail identically for
                    // ever, so retrying it in total silence (the old behaviour) hides a node that never
                    // registers. Said ONCE per process, at error level, naming what to check.
                    // `useMtls` guards it: without cluster certs this leg is plain HTTP, where an
                    // ECONNRESET means the gateway is down, not that a certificate was refused.
                    if (useMtls && !handshakeReported && isRegisterHandshakeFailure(e)) {
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
