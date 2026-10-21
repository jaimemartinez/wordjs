/**
 * lib/edgeSync.ts — a frontend node on another machine follows the gateway's site address and TLS switch.
 *
 * QA X3-04 / X2-15: changing the main address or the gateway's TLS from the panel left the node's
 * wordjs-config.json with the old `siteUrl`, `gatewaySsl` and `internalApiUrl` (https:// into a gateway
 * that now spoke HTTP), so every public page answered 500 until somebody edited three machines by hand.
 *
 * MUTATION PROOF: drop the gatewayHost branch in reconcileEdgeConfig — the lab case keeps https://; drop
 * the `https !== null` guard — a reloading gateway ('mixed') flips the scheme; rewrite internalApiUrl
 * unconditionally — the operator's own backend address is lost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileEdgeConfig, syncEdgeConfig, type EdgeInfo } from '../edgeSync';

// The separate-mode lab as enrolled: gateway reached by IP, main address = that IP over https.
const ENROLLED = {
    gatewayHost: '192.0.2.157',
    gatewayInternalPort: 3100,
    gatewayPort: 3000,
    gatewaySsl: { enabled: true },
    siteUrl: 'https://192.0.2.157:3000',
    advertiseHost: '192.0.2.184',
    internalApiUrl: 'https://192.0.2.157:3000/api/v1',
    mtls: { ca: './certs/cluster-ca.crt', key: './certs/frontend.key', cert: './certs/frontend.crt' },
    revalidateSecret: 'x'.repeat(32),
};

const edge = (over: Partial<EdgeInfo>): EdgeInfo => ({ siteUrl: 'https://192.0.2.157:3000', gatewayPort: 3000, sslEnabled: true, serving: 'https', ...over });

describe('reconcileEdgeConfig', () => {
    it('nothing to do when the node already matches', () => {
        expect(reconcileEdgeConfig(ENROLLED, edge({}))).toBeNull();
    });

    it('the lab case: main address moved to a tunnel name and the gateway now serves HTTP', () => {
        const r = reconcileEdgeConfig(ENROLLED, edge({ siteUrl: 'http://sep.example.test:3303', serving: 'http', sslEnabled: false }));
        expect(r).not.toBeNull();
        expect(r!.next.siteUrl).toBe('http://sep.example.test:3303');
        expect(r!.next.gatewaySsl).toEqual({ enabled: false });
        // SSR keeps dialling the gateway by IP (the tunnel name means nothing on this machine), over HTTP now.
        expect(r!.next.internalApiUrl).toBe('http://192.0.2.157:3000/api/v1');
        // Every other key is kept.
        expect(r!.next.mtls).toEqual(ENROLLED.mtls);
        expect(r!.next.revalidateSecret).toBe(ENROLLED.revalidateSecret);
    });

    it('the gateway port moves with it when SSR dialled the old one', () => {
        const r = reconcileEdgeConfig(ENROLLED, edge({ gatewayPort: 8443 }));
        expect(r!.next.gatewayPort).toBe(8443);
        expect(r!.next.internalApiUrl).toBe('https://192.0.2.157:8443/api/v1');
    });

    it('while the gateway reloads (mixed / not reported) the protocol is left alone', () => {
        expect(reconcileEdgeConfig(ENROLLED, edge({ serving: 'mixed' }))).toBeNull();
        expect(reconcileEdgeConfig(ENROLLED, edge({ serving: null }))).toBeNull();
        const r = reconcileEdgeConfig(ENROLLED, edge({ serving: null, siteUrl: 'https://www.example.test' }));
        expect(r!.next.siteUrl).toBe('https://www.example.test');
        expect(r!.next.internalApiUrl).toBe(ENROLLED.internalApiUrl);
        expect(r!.next.gatewaySsl).toEqual({ enabled: true });
    });

    it('an internalApiUrl enrolled from a domain name follows the new main address', () => {
        const cfg = { ...ENROLLED, siteUrl: 'https://old.example.test', internalApiUrl: 'https://old.example.test/api/v1' };
        const r = reconcileEdgeConfig(cfg, edge({ siteUrl: 'https://new.example.test' }));
        expect(r!.next.internalApiUrl).toBe('https://new.example.test/api/v1');
    });

    it("an internalApiUrl the operator pointed elsewhere is never touched", () => {
        const cfg = { ...ENROLLED, internalApiUrl: 'https://10.0.0.9:4000/api/v1' };
        const r = reconcileEdgeConfig(cfg, edge({ serving: 'http', siteUrl: 'http://sep.example.test:3303' }));
        expect(r!.next.internalApiUrl).toBe('https://10.0.0.9:4000/api/v1');
        expect(r!.next.gatewaySsl).toEqual({ enabled: false });
    });

    it('a malformed address from the gateway is ignored', () => {
        expect(reconcileEdgeConfig(ENROLLED, edge({ siteUrl: 'javascript:alert(1)' }))).toBeNull();
        expect(reconcileEdgeConfig(ENROLLED, edge({ siteUrl: null }))).toBeNull();
    });
});

// ─── syncEdgeConfig against a fake mTLS request ─────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function node(cfg: object) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-edge-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'certs'));
    for (const f of ['cluster-ca.crt', 'frontend.key', 'frontend.crt']) fs.writeFileSync(path.join(dir, 'certs', f), 'pem');
    fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify(cfg, null, 2));
    return dir;
}

function fakeRequest(status: number, body: unknown, seen: any[] = []) {
    return ((options: any, cb: any) => {
        seen.push(options);
        const req = new EventEmitter() as any;
        req.end = () => {
            const res = new EventEmitter() as any;
            res.statusCode = status;
            res.setEncoding = () => {};
            cb(res);
            res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
            res.emit('end');
        };
        req.destroy = () => {};
        return req;
    }) as any;
}

describe('syncEdgeConfig', () => {
    it('rewrites the node config over the mTLS channel it registers on', async () => {
        const dir = node(ENROLLED);
        const seen: any[] = [];
        const logs: string[] = [];
        const out = await syncEdgeConfig(dir, {
            request: fakeRequest(200, { siteUrl: 'http://sep.example.test:3303', gatewayPort: 3000, sslEnabled: false, serving: 'http' }, seen),
            log: (m) => logs.push(m),
        });
        expect(out.status).toBe('updated');
        expect(seen[0]).toMatchObject({ hostname: '192.0.2.157', port: 3100, path: '/edge-info', rejectUnauthorized: true });
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'wordjs-config.json'), 'utf8'));
        expect(saved.internalApiUrl).toBe('http://192.0.2.157:3000/api/v1');
        expect(saved.siteUrl).toBe('http://sep.example.test:3303');
        expect(saved.gatewaySsl.enabled).toBe(false);
        expect(logs.join('\n')).toMatch(/followed the gateway/);
        // A second run with the same answer changes nothing.
        const again = await syncEdgeConfig(dir, { request: fakeRequest(200, { siteUrl: 'http://sep.example.test:3303', gatewayPort: 3000, serving: 'http' }) });
        expect(again.status).toBe('unchanged');
    });

    it('a gateway from before /edge-info (404) or an unreachable one changes nothing', async () => {
        const dir = node(ENROLLED);
        const before = fs.readFileSync(path.join(dir, 'wordjs-config.json'), 'utf8');
        expect((await syncEdgeConfig(dir, { request: fakeRequest(404, 'Not Found') })).status).toBe('failed');
        expect((await syncEdgeConfig(dir, { request: fakeRequest(200, '<html>') })).status).toBe('failed');
        expect(fs.readFileSync(path.join(dir, 'wordjs-config.json'), 'utf8')).toBe(before);
    });

    it('a node without cluster identity does nothing', async () => {
        const dir = node({ port: 3001 });
        const seen: any[] = [];
        expect((await syncEdgeConfig(dir, { request: fakeRequest(200, {}, seen) })).status).toBe('not-a-cluster-node');
        expect(seen).toHaveLength(0);
    });
});
