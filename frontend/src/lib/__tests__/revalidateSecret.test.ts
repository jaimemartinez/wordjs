import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
    resolveRevalidateSecret,
    readClusterIdentity,
    clusterSecretRequestOptions,
    recoverRevalidateSecret,
} from '../revalidateSecret';

/**
 * CROSS-MACHINE CACHE PURGE — where a frontend node finds the secret that authenticates a purge.
 *
 * The purge route used to look for ONE config file: local first, and `../backend/wordjs-config.json`
 * only if the local one did not exist. A separate-mode frontend always HAS a local config (enrollment
 * writes its ports, gateway wiring and mTLS paths), so that check found it, saw no `revalidateSecret`
 * inside — the secret lived in the backend's config, on a different machine — and returned null. The
 * route then answered 503 to every purge, so even a purge that was delivered correctly did nothing.
 *
 * The fix is that the fallback is per-KEY, not per-FILE, and that enrollment now writes the
 * gateway-minted secret into the frontend's own config.
 *
 * MUTATION PROOF: restore the old `if (!exists(local)) local = backend` file-level check and
 * "local config WITHOUT the secret" below fails (null instead of the backend's value).
 */

let dir: string;
let frontendDir: string;
let backendDir: string;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-reval-'));
    frontendDir = path.join(dir, 'frontend');
    backendDir = path.join(dir, 'backend');
    fs.mkdirSync(frontendDir);
    fs.mkdirSync(backendDir);
});

afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const writeFrontend = (cfg: unknown) =>
    fs.writeFileSync(path.join(frontendDir, 'wordjs-config.json'), JSON.stringify(cfg));
const writeBackend = (cfg: unknown) =>
    fs.writeFileSync(path.join(backendDir, 'wordjs-config.json'), JSON.stringify(cfg));
const rmFrontend = () => fs.rmSync(path.join(frontendDir, 'wordjs-config.json'), { force: true });
const rmBackend = () => fs.rmSync(path.join(backendDir, 'wordjs-config.json'), { force: true });

describe('resolveRevalidateSecret', () => {
    it('separate mode: reads the secret enrollment wrote into THIS node\'s own config', () => {
        // No backend config at all — the backend is on another machine.
        rmBackend();
        writeFrontend({ port: 3001, advertiseHost: '10.0.0.7', revalidateSecret: 'from-enrollment' });
        expect(resolveRevalidateSecret(frontendDir)).toBe('from-enrollment');
    });

    it('separate mode BEFORE the fix: a local config that lacks the key must not end the search', () => {
        // This is the exact cluster shape that broke: local config present (ports, gateway wiring,
        // mTLS paths) but no revalidateSecret. Falling back per-KEY is what keeps a co-located
        // backend's secret reachable instead of answering 503.
        writeFrontend({ port: 3001, advertiseHost: '10.0.0.7', mtls: { cert: './certs/frontend.crt' } });
        writeBackend({ revalidateSecret: 'from-backend-disk' });
        expect(resolveRevalidateSecret(frontendDir)).toBe('from-backend-disk');
    });

    it('single-host split: no local config at all still finds the backend\'s secret', () => {
        rmFrontend();
        writeBackend({ revalidateSecret: 'from-backend-disk' });
        expect(resolveRevalidateSecret(frontendDir)).toBe('from-backend-disk');
    });

    it('the LOCAL secret wins when both exist (the cluster value is authoritative)', () => {
        writeFrontend({ revalidateSecret: 'local-wins' });
        writeBackend({ revalidateSecret: 'from-backend-disk' });
        expect(resolveRevalidateSecret(frontendDir)).toBe('local-wins');
    });

    it('fails CLOSED: nothing configured anywhere yields null (the route answers 503)', () => {
        rmFrontend();
        rmBackend();
        expect(resolveRevalidateSecret(frontendDir)).toBeNull();
    });

    it('a malformed local config does not hide a valid backend one', () => {
        fs.writeFileSync(path.join(frontendDir, 'wordjs-config.json'), '{ this is not json');
        writeBackend({ revalidateSecret: 'from-backend-disk' });
        expect(resolveRevalidateSecret(frontendDir)).toBe('from-backend-disk');
    });

    it('an empty-string secret is not a secret', () => {
        writeFrontend({ revalidateSecret: '' });
        rmBackend();
        expect(resolveRevalidateSecret(frontendDir)).toBeNull();
    });
});

/**
 * SELF-REPAIR — a cluster node that has the identity but not the secret must not stay broken.
 *
 * The secret rides enrollment, so a cluster enrolled BEFORE the secret existed has certificates,
 * gateway wiring and mTLS paths but no `revalidateSecret`. Every purge the gateway delivers is then
 * refused with 403 — logged on both sides, and permanent: the only cure on record was for an operator
 * to remember to re-enroll the node. A node holding a CN=frontend cluster certificate can simply ask
 * the gateway over the mTLS channel it already uses to register.
 *
 * These drive the REAL function over a real HTTP server, including the write-back to the node's own
 * config, and then assert the thing that actually matters: `resolveRevalidateSecret` — the lookup the
 * /api/revalidate route performs on every request — flips from null (503) to the secret (200) with no
 * restart and no human involved.
 *
 * MUTATION PROOF: against the pre-fix module none of `readClusterIdentity`,
 * `clusterSecretRequestOptions` or `recoverRevalidateSecret` exist and every test here fails at
 * import. Drop the write-back and the "flips from 503 to 200" assertion fails; remove the
 * already-configured short-circuit and the "never overwrites" test fails; return the body without the
 * plausibility check and the "refuses a junk reply" test fails.
 */
describe('recoverRevalidateSecret — a secretless cluster node repairs itself', () => {
    let nodeDir: string;
    let certsDir: string;
    let gateway: { server: http.Server; port: number; seen: string[]; status: number; body: string };

    const CLUSTER_CONFIG = {
        port: 3001,
        gatewayHost: '10.0.0.5',
        gatewayInternalPort: 3100,
        gatewaySecret: 'deadbeef',
        siteUrl: 'https://10.0.0.5:3000',
        frontendUrl: 'https://10.0.0.7:3001',
        advertiseHost: '10.0.0.7',
        mtls: { ca: './certs/cluster-ca.crt', key: './certs/frontend.key', cert: './certs/frontend.crt' },
    };

    const readNodeConfig = () => JSON.parse(fs.readFileSync(path.join(nodeDir, 'wordjs-config.json'), 'utf-8'));
    const writeNodeConfig = (cfg: unknown) =>
        fs.writeFileSync(path.join(nodeDir, 'wordjs-config.json'), JSON.stringify(cfg, null, 2));

    // Stand in for https.request: records the options the module built, then performs the SAME request
    // against a local plain-HTTP gateway stub. The transport is swapped; the logic is not.
    const capturedOptions: Record<string, unknown>[] = [];
    const request = ((options: Record<string, unknown>, cb: (res: http.IncomingMessage) => void) => {
        capturedOptions.push(options);
        return http.request(
            { method: 'GET', hostname: '127.0.0.1', port: gateway.port, path: String(options.path), timeout: 2000 },
            cb as never,
        );
    }) as never;

    beforeAll(async () => {
        const seen: string[] = [];
        const server = http.createServer((req, res) => {
            seen.push(String(req.url));
            res.writeHead(gateway.status, { 'Content-Type': 'application/json' });
            res.end(gateway.body);
        });
        const port: number = await new Promise((resolve) =>
            server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
        gateway = { server, port, seen, status: 200, body: JSON.stringify({ revalidateSecret: 'a'.repeat(64) }) };
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    });

    beforeEach(() => {
        nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-selfrepair-'));
        certsDir = path.join(nodeDir, 'certs');
        fs.mkdirSync(certsDir);
        fs.writeFileSync(path.join(certsDir, 'cluster-ca.crt'), '--CA--');
        fs.writeFileSync(path.join(certsDir, 'frontend.key'), '--KEY--');
        fs.writeFileSync(path.join(certsDir, 'frontend.crt'), '--CRT--');
        writeNodeConfig(CLUSTER_CONFIG);
        gateway.status = 200;
        gateway.body = JSON.stringify({ revalidateSecret: 'a'.repeat(64) });
        gateway.seen.length = 0;
        capturedOptions.length = 0;
    });

    it('recognises cluster identity — and only when the mTLS material is really on disk', () => {
        const id = readClusterIdentity(nodeDir);
        expect(id).not.toBeNull();
        expect(id!.gatewayHost).toBe('10.0.0.5');
        expect(id!.gatewayInternalPort).toBe(3100);
        expect(id!.configPath).toBe(path.resolve(nodeDir, 'wordjs-config.json'));

        // Enrollment wiring in the config but no certificate on disk is NOT a cluster node: asking the
        // gateway would fail the handshake anyway, and this is the same predicate the backend uses to
        // decide a purge goes through the gateway. They must not disagree.
        fs.rmSync(path.join(certsDir, 'frontend.crt'));
        expect(readClusterIdentity(nodeDir)).toBeNull();
    });

    it('a monolith / single-host split is not a cluster node and is never touched', async () => {
        writeNodeConfig({ port: 3001, frontendUrl: 'http://localhost:3001' });
        expect(readClusterIdentity(nodeDir)).toBeNull();

        const before = fs.readFileSync(path.join(nodeDir, 'wordjs-config.json'), 'utf-8');
        const out = await recoverRevalidateSecret(nodeDir, { request, log: () => {} });
        expect(out.status).toBe('not-a-cluster-node');
        expect(gateway.seen).toEqual([]);                                                    // no network
        expect(fs.readFileSync(path.join(nodeDir, 'wordjs-config.json'), 'utf-8')).toBe(before); // no disk
    });

    it('asks over mTLS with THIS node\'s certificate, verifying the gateway against the cluster CA', () => {
        const opts = clusterSecretRequestOptions(readClusterIdentity(nodeDir)!);
        expect(opts.hostname).toBe('10.0.0.5');
        expect(opts.port).toBe(3100);
        expect(opts.path).toBe('/revalidate-secret');
        expect(opts.protocol).toBe('https:');
        // The certificate IS the authorization, so it must be the node's own material — not defaults,
        // and not verification turned off to make a handshake succeed.
        expect(String(opts.ca)).toBe('--CA--');
        expect(String(opts.key)).toBe('--KEY--');
        expect(String(opts.cert)).toBe('--CRT--');
        expect(opts.rejectUnauthorized).toBe(true);
    });

    it('THE FIX: a secretless cluster node goes from 503 to authenticating purges, unattended', async () => {
        // Exactly the state a cluster enrolled before the secret existed boots in.
        expect(resolveRevalidateSecret(nodeDir)).toBeNull();

        const said: string[] = [];
        const out = await recoverRevalidateSecret(nodeDir, { request, log: (m) => said.push(m) });

        expect(out.status).toBe('recovered');
        expect(gateway.seen).toEqual(['/revalidate-secret']);
        // The route's own lookup now succeeds — no restart, no re-enrollment, no operator.
        expect(resolveRevalidateSecret(nodeDir)).toBe('a'.repeat(64));
        // Persisted, so it survives a restart, and the rest of the config survived the write.
        const cfg = readNodeConfig();
        expect(cfg.revalidateSecret).toBe('a'.repeat(64));
        expect(cfg.mtls).toEqual(CLUSTER_CONFIG.mtls);
        expect(cfg.gatewayHost).toBe('10.0.0.5');
        expect(said.join(' ')).toMatch(/recovered the missing revalidateSecret/);
    });

    it('never overwrites a secret it already has — a reachable gateway cannot rewrite working config', async () => {
        writeNodeConfig({ ...CLUSTER_CONFIG, revalidateSecret: 'already-mine' });
        const out = await recoverRevalidateSecret(nodeDir, { request, log: () => {} });
        expect(out.status).toBe('already-configured');
        expect(gateway.seen).toEqual([]);
        expect(readNodeConfig().revalidateSecret).toBe('already-mine');
    });

    it('FAILS SAFE when the gateway refuses: unchanged config, and it says so', async () => {
        gateway.status = 403;
        gateway.body = JSON.stringify({ error: 'Access Forbidden' });

        const said: string[] = [];
        const out = await recoverRevalidateSecret(nodeDir, { request, log: (m) => said.push(m) });

        expect(out.status).toBe('failed');
        expect(resolveRevalidateSecret(nodeDir)).toBeNull();          // still TTL freshness, never open
        expect(readNodeConfig().revalidateSecret).toBeUndefined();
        expect(said.join(' ')).toMatch(/403/);
        expect(said.join(' ')).toMatch(/TTL-fresh/);
    });

    it('FAILS SAFE when the gateway is unreachable', async () => {
        const dead = ((options: Record<string, unknown>, cb: never) =>
            http.request({ method: 'GET', hostname: '127.0.0.1', port: 1, path: String(options.path), timeout: 500 }, cb)) as never;

        const said: string[] = [];
        const out = await recoverRevalidateSecret(nodeDir, { request: dead, log: (m) => said.push(m) });

        expect(out.status).toBe('failed');
        expect(readNodeConfig().revalidateSecret).toBeUndefined();
        expect(said.join(' ')).toMatch(/could not supply one/);
    });

    it('refuses a junk reply instead of writing it into the config', async () => {
        gateway.body = '<html>gateway error page</html>';
        expect((await recoverRevalidateSecret(nodeDir, { request, log: () => {} })).status).toBe('failed');
        expect(readNodeConfig().revalidateSecret).toBeUndefined();

        gateway.body = JSON.stringify({ revalidateSecret: 'short' });   // implausible: too short
        expect((await recoverRevalidateSecret(nodeDir, { request, log: () => {} })).status).toBe('failed');
        expect(readNodeConfig().revalidateSecret).toBeUndefined();
    });
});
