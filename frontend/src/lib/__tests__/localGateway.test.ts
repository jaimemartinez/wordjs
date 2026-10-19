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

// Self-signed certificates for site.example, generated once (selfsigned): one with IP:127.0.0.1, one with
// DNS:localhost, one with the public name only. Only their names are read; validity is never checked.
const CERT_IP = `-----BEGIN CERTIFICATE-----
MIIC0jCCAbqgAwIBAgIJCVkfQs4EI+GpMA0GCSqGSIb3DQEBBQUAMBcxFTATBgNV
BAMTDHNpdGUuZXhhbXBsZTAeFw0yNjEwMTcxNDM2MTRaFw0yNzEwMTcxNDM2MTRa
MBcxFTATBgNVBAMTDHNpdGUuZXhhbXBsZTCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAMK1PfgeQB2L0B9zgM7m79BNuWshu/hU98/Bz9HjN2EjGj4/sAFE
HO0OmyTL4vJkfHCEjkTnHlkHVmht+aSTQOYsCjclQDq/XbHV1B99cEkNl7MFWvqt
lulTEmhlj8eZSXpy4Jeq5xt9wLiOY1q3lZniVDJOgEufJwd1qLglA0I+SPW3oqFh
fr1IIlbzZCPaYaC84f5bWsqP1xKHX7ejaGQIU5ewCbJMM6aYR5AMT8R0+nVsf/wH
vap4tZiC5sTmRTSj7vEtC/9mzEK9E1l9MoqWDLYanjDMk+uuIDUp3w7owxuKQq/R
wNqnuHMcZXw5mdjYKFdnzhZE4+8DtbKYG28CAwEAAaMhMB8wHQYDVR0RBBYwFIIM
c2l0ZS5leGFtcGxlhwR/AAABMA0GCSqGSIb3DQEBBQUAA4IBAQBp2lbT3lbElM/M
ZaSDN7mBNiAz+y5hlCM5WaHIXPcwkIA0Gdo9rU+T7iGde0rwUuLtIJjg7ZTEgFF9
j0E23K1DmInNAE19sxZX0lC5M9xMIJe3Ku1HsOKira15LAvB9wADS/e3xa1SEQGH
4kjiQV6iVweLKp0KlKtRVmzLurBGXiG+x0FgPLpw4y4saXokXK76TK1EV1YFs4ri
aAKoOObkTpQG3gkUFE/3XaArf8PPOfIU4yUhMfHPflhwY+tkXC85uWErQykvOs9b
FvhHtO2+H/SdVg4w2asAHbJp2SJQCTsV+KeS9QMRkjI+t2vugPp38N77yfani2V6
4tjkyJLv
-----END CERTIFICATE-----
`;
const CERT_LOCALHOST = `-----BEGIN CERTIFICATE-----
MIIC1zCCAb+gAwIBAgIJbPvgmVuvC3IgMA0GCSqGSIb3DQEBBQUAMBcxFTATBgNV
BAMTDHNpdGUuZXhhbXBsZTAeFw0yNjEwMTcxNDM2MTRaFw0yNzEwMTcxNDM2MTRa
MBcxFTATBgNVBAMTDHNpdGUuZXhhbXBsZTCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAMvAJIHHXXqc5Ts0GH/wxaDnuQwsnklG503z2FbwVuHPE2DXbWAn
on9dJycaB4vJ4idTYVmOvoaeJ2tBlzkXEBO+6ddde90fakUU1bSxlj9g9VuESPk7
NOAVa/rjtVNYYZQrYFH9+Bquj3UZBv1RsQ0ot0r1oLaOT3aO8Ck26+U7lpExYXFS
5PCXDhLHiyQy6lVjCHKHxxo6SBijwRs1xC+dMF3+Q6muMxegyGZWljE7SPGiSrT4
tVX9HZajsVkvZKazB6QM2g9qcOPiAuM4OMwWH1yDY77cBfHWjtUkkNVvXS7zUX9J
xXYyq1BXTKk4lqP52pDpwrlq6LlVRy7g1rkCAwEAAaMmMCQwIgYDVR0RBBswGYIM
c2l0ZS5leGFtcGxlgglsb2NhbGhvc3QwDQYJKoZIhvcNAQEFBQADggEBABc4lGGV
0ZGJtmUdUxelsHS50vPZ/LkuHzFJ8JzIdFZE/kio5r7uUjx5MZEzJL0J8YgnElSO
7IagBVTG0DRpJskATiAFokcXkIdZ0CZ2sWOYB8uO9tBuWHuBjGpJBBVXryrDuXpP
4L/nRQw+k/sayQwJv5KbHIr5+hndI8x0xRgwP1vGxAmnItJE7cUOCT7hk9eZ3y/g
/x/4PtAeAGd+bs7CWsQteLwdFqz6NhkqPjp8Myct5JgSHn60SNcBYQoxhQ1656kK
6HKbQt1kv5MQrDEDu+NAp4F1ozCsXW7iOJdOcOnCTq1c0aKldMrl9FajaHfcnLzt
zY0nxKidtKlxe2s=
-----END CERTIFICATE-----
`;
const CERT_PUBLIC_ONLY = `-----BEGIN CERTIFICATE-----
MIICzDCCAbSgAwIBAgIJHPWhdwJhNwgwMA0GCSqGSIb3DQEBBQUAMBcxFTATBgNV
BAMTDHNpdGUuZXhhbXBsZTAeFw0yNjEwMTcxNDM2MTVaFw0yNzEwMTcxNDM2MTVa
MBcxFTATBgNVBAMTDHNpdGUuZXhhbXBsZTCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAM/kdyyoZ15/jGeZR90N9HPCnU4T0Ihn/hu0hFtgPtkjPcswV/3S
l8LoRNvNfR9HqjvlVzDWiYm2Yw9x4OX2uQ7hy5I68Yow2fuxhOdW/r/aW10UDkYc
IKE/EN0etF15fPYkAgZfu2cl2adpURxUKGQEIO5CDq0Vw+Rkv3/jgf7UJwX71C+4
4d3hRXqNwmgojPYnZ4xkYTCQuy9NzYPdLNfYb8hqKjxEUmomdk7urUUKJMlNHibi
lwuBa2rw1DkQPqWWRDlMP71wujoe1I3W50TrDE7Kv59pPNVYwY15ThV+Pm3w2ju0
M7h9n3LEJy4YUVxtqapDlx04nHd7CTtbkh8CAwEAAaMbMBkwFwYDVR0RBBAwDoIM
c2l0ZS5leGFtcGxlMA0GCSqGSIb3DQEBBQUAA4IBAQALD7GFTT9UaRlzURyXDMjJ
mO8MKtsCgkiXjp/OdOuUH7mI6NoOtIdoLMddSCWPHrN1H0CH7uCk6yMeFM7xMza7
NfK4Zr3Yz1SvceW05acRIrtmXtuZDYjiA9RoeS/wG2U8y/EYWp3AfeTGMfUkXP4m
0BHJOng0fZg8B+bslYjo+5zn7jqutti4B46n+oRtf0ueG7UX0Pe0y+EmX0a1yKeM
D+ixmVUoItOS4VYAUrhY2JN5mbZJzNw04bG07k3MUXVTbDTh2AaOoLtyuJR36l2T
gsGpHc5eK6jIH9N5Y7mrENeRkt6bbLIPv3dfKujTSnP+PCWhz4aYXX14qzATncSF
-----END CERTIFICATE-----
`;

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

    it('an operator certificate: loopback only by a name it covers, else null', () => {
        const [ip, local, publicOnly] = [CERT_IP, CERT_LOCALHOST, CERT_PUBLIC_ONLY];
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

describe('no bundled file imports local-gateway.js (lib/api.ts runs in the browser, where fs does not exist)', () => {
    it('server-api.ts and api.ts read the env, not the module', () => {
        for (const f of ['server-api.ts', 'api.ts']) {
            const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            expect(src, f).not.toMatch(/(?:from|require\()\s*['"][^'"]*local-gateway/);
            expect(src, f).toMatch(/WORDJS_LOCAL_GATEWAY_ORIGIN/);
        }
    });
});

describe('server-api: the SSR base of a local split install', () => {
    const saved = { cwd: process.cwd(), INTERNAL_API_URL: process.env.INTERNAL_API_URL, WORDJS_MODE: process.env.WORDJS_MODE, WORDJS_LOCAL_GATEWAY_ORIGIN: process.env.WORDJS_LOCAL_GATEWAY_ORIGIN };
    afterEach(() => {
        process.chdir(saved.cwd);
        for (const k of ['INTERNAL_API_URL', 'WORDJS_MODE', 'WORDJS_LOCAL_GATEWAY_ORIGIN'] as const) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
    });

    /**
     * An installed one-machine site: backend config + certificate, optionally the gateway next to it. The
     * origin is handed over as scripts/start-frontend.js hands it (WORDJS_LOCAL_GATEWAY_ORIGIN): server-api
     * must not import local-gateway.js, whose `fs` the browser bundle of lib/api.ts cannot resolve.
     */
    async function resolveIn(gateway: object | null) {
        const backend = site(gateway, {
            'backend/wordjs-config.json': JSON.stringify({ gatewayUrl: 'https://site.example', siteUrl: 'https://site.example', port: 4000 }),
        });
        fs.mkdirSync(path.join(backend, 'certs'), { recursive: true });
        fs.writeFileSync(path.join(backend, 'certs', 'backend.crt'), 'x');
        delete process.env.INTERNAL_API_URL;
        delete process.env.WORDJS_MODE;
        const cfg = JSON.parse(fs.readFileSync(path.join(backend, 'wordjs-config.json'), 'utf8'));
        const origin = localGatewayOrigin(backend, cfg);
        if (origin) process.env.WORDJS_LOCAL_GATEWAY_ORIGIN = origin; else delete process.env.WORDJS_LOCAL_GATEWAY_ORIGIN;
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
