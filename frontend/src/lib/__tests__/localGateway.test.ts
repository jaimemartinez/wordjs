/**
 * local-gateway.js — reaching the gateway on this machine without leaving it, and listening only where
 * that gateway can reach us.
 *
 * In a local split install the SSR reads went to `gatewayUrl`, the site's PUBLIC address: behind nginx
 * every read left the server, crossed the proxy and came back. And the frontend listened on every
 * interface (`*:3001`) and registered the site's public name with the gateway, although only the gateway
 * next door ever talks to it.
 *
 * MUTATION PROOF: return null from localGatewayOrigin and the server-api candidate test fails (SSR goes to
 * the public address again); return null from frontendListenHost and the loopback-bind cases fail.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { localGatewayOrigin, frontendListenHost } = require('../../../local-gateway.js');

const roots: string[] = [];
/** A site root with backend/ (where the frontend reads its config on one machine) and maybe gateway/. */
function site(gateway: object | null, files: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-local-gw-'));
    roots.push(root);
    for (const d of ['backend', 'frontend', 'gateway']) fs.mkdirSync(path.join(root, d), { recursive: true });
    if (gateway) fs.writeFileSync(path.join(root, 'gateway', 'gateway-config.json'), JSON.stringify(gateway));
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
    return path.join(root, 'backend');
}
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A self-signed certificate for `names` (DNS) / `ips`, via the selfsigned package the gateway uses. */
async function cert(cn: string, altNames: object[]): Promise<string> {
    const rootRequire = createRequire(path.resolve(__dirname, '../../../../package.json'));
    const selfsigned = rootRequire('selfsigned');
    const pems = await selfsigned.generate([{ name: 'commonName', value: cn }], { days: 1, extensions: [{ name: 'subjectAltName', altNames }] });
    return pems.cert;
}

describe('localGatewayOrigin', () => {
    it('no gateway next to this frontend (separate mode): null — SSR keeps the configured address', () => {
        expect(localGatewayOrigin(site(null), {})).toBeNull();
    });

    it('a gateway on another host in this frontend\'s config: null, whatever is on disk', () => {
        expect(localGatewayOrigin(site({ ssl: false }), { gatewayHost: '10.0.0.5' })).toBeNull();
    });

    it('plain HTTP gateway (behind nginx): http over loopback on its port', () => {
        expect(localGatewayOrigin(site({ ssl: false, gatewayPort: 3080 }), {})).toBe('http://127.0.0.1:3080');
        expect(localGatewayOrigin(site({ ssl: { enabled: false } }), { gatewayHost: 'localhost' })).toBe('http://127.0.0.1:3000');
    });

    it('the default self-signed HTTPS (ssl-auto.crt carries IP:127.0.0.1): https over loopback', () => {
        expect(localGatewayOrigin(site({ ssl: true }), {})).toBe('https://127.0.0.1:3000');
        expect(localGatewayOrigin(site({ ssl: { enabled: true }, gatewayPort: 8443 }), {})).toBe('https://127.0.0.1:8443');
    });

    it('an operator certificate: loopback only by a name it covers, else null', async () => {
        const ip = await cert('site.example', [{ type: 2, value: 'site.example' }, { type: 7, ip: '127.0.0.1' }]);
        const local = await cert('site.example', [{ type: 2, value: 'site.example' }, { type: 2, value: 'localhost' }]);
        const publicOnly = await cert('site.example', [{ type: 2, value: 'site.example' }]);
        const ssl = { enabled: true, key: 'k.pem', cert: 'c.pem' };
        expect(localGatewayOrigin(site({ ssl }, { 'gateway/c.pem': ip }), {})).toBe('https://127.0.0.1:3000');
        expect(localGatewayOrigin(site({ ssl }, { 'gateway/c.pem': local }), {})).toBe('https://localhost:3000');
        expect(localGatewayOrigin(site({ ssl }, { 'gateway/c.pem': publicOnly }), {})).toBeNull();
        expect(localGatewayOrigin(site({ ssl }), {}), 'missing certificate file').toBeNull();
    });
});

describe('frontendListenHost', () => {
    it('loopback when the gateway is on this machine — whatever the public frontendUrl says', () => {
        expect(frontendListenHost(site({ ssl: true }), { frontendUrl: 'https://site.example:3001' }, {})).toBe('127.0.0.1');
    });

    it('every interface (null) without a local gateway, with a remote one, or with a routable advertiseHost', () => {
        expect(frontendListenHost(site(null), {}, {})).toBeNull();
        expect(frontendListenHost(site({ ssl: true }), { gatewayHost: '10.0.0.5' }, {})).toBeNull();
        expect(frontendListenHost(site({ ssl: true }), { advertiseHost: '10.0.0.9' }, {})).toBeNull();
        expect(frontendListenHost(site({ ssl: true }), { advertiseHost: '127.0.0.1' }, {})).toBe('127.0.0.1');
    });

    it('WORDJS_FRONTEND_BIND decides when set', () => {
        expect(frontendListenHost(site(null), {}, { WORDJS_FRONTEND_BIND: '0.0.0.0' })).toBe('0.0.0.0');
        expect(frontendListenHost(site({ ssl: true }), {}, { WORDJS_FRONTEND_BIND: '::' })).toBe('::');
    });
});

describe('server-api: the SSR base of a local split install', () => {
    const saved = { cwd: process.cwd(), INTERNAL_API_URL: process.env.INTERNAL_API_URL, WORDJS_MODE: process.env.WORDJS_MODE };
    afterEach(() => {
        process.chdir(saved.cwd);
        for (const k of ['INTERNAL_API_URL', 'WORDJS_MODE'] as const) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
    });

    /** An installed one-machine site: backend config + certificate, optionally the gateway next to it. */
    async function resolveIn(gateway: object | null) {
        const backend = site(gateway, {
            'backend/wordjs-config.json': JSON.stringify({ gatewayUrl: 'https://site.example', siteUrl: 'https://site.example', port: 4000 }),
        });
        fs.mkdirSync(path.join(backend, 'certs'), { recursive: true });
        fs.writeFileSync(path.join(backend, 'certs', 'backend.crt'), 'x');
        delete process.env.INTERNAL_API_URL;
        delete process.env.WORDJS_MODE;
        process.chdir(path.join(backend, '..', 'frontend'));
        vi.resetModules();
        const { resolveServerBase } = await import('@/lib/server-api');
        return resolveServerBase();
    }

    it('goes to the gateway next door over loopback, not out through the public address', async () => {
        expect(await resolveIn({ ssl: true, gatewayPort: 3000 })).toBe('https://127.0.0.1:3000/api/v1');
        expect(await resolveIn({ ssl: false, gatewayPort: 3080 })).toBe('http://127.0.0.1:3080/api/v1');
    });

    it('keeps the public address when there is no gateway on this machine', async () => {
        expect(await resolveIn(null)).toBe('https://site.example/api/v1');
    });
});
