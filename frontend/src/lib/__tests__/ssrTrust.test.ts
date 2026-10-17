/**
 * scripts/ssr-trust.js — what the frontend's server-side fetches trust.
 *
 * After a split install the SSR reads go through the gateway's public origin. On one machine that
 * origin serves the gateway's own auto-generated self-signed certificate (or an operator's), which does
 * not chain to the cluster CA; trusting the CA alone made every SSR read fail with
 * DEPTH_ZERO_SELF_SIGNED_CERT and content pages answer 404. The bundle must add exactly the gateway's
 * served certificate, and nothing before the install issued certificates.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildSsrTrust, gatewayPublicCert, waitForGatewayAutoCert, writeTrustBundle } = require('../../../scripts/ssr-trust.js');

const roots: string[] = [];
function site(opts: { ca?: 'frontend' | 'backend' | null; gateway?: object | null; auto?: boolean; operatorCert?: string }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-ssr-trust-'));
    roots.push(root);
    for (const d of ['frontend/certs', 'backend/certs', 'gateway']) fs.mkdirSync(path.join(root, d), { recursive: true });
    if (opts.ca === 'frontend') fs.writeFileSync(path.join(root, 'frontend/certs/cluster-ca.crt'), '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n');
    if (opts.ca === 'backend') fs.writeFileSync(path.join(root, 'backend/certs/cluster-ca.crt'), '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n');
    if (opts.gateway) fs.writeFileSync(path.join(root, 'gateway/gateway-config.json'), JSON.stringify(opts.gateway));
    if (opts.auto) fs.writeFileSync(path.join(root, 'gateway/ssl-auto.crt'), '-----BEGIN CERTIFICATE-----\nAUTO\n-----END CERTIFICATE-----\n');
    if (opts.operatorCert) fs.writeFileSync(path.join(root, 'gateway', opts.operatorCert), '-----BEGIN CERTIFICATE-----\nOPERATOR\n-----END CERTIFICATE-----\n');
    return path.join(root, 'frontend');
}
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

describe('buildSsrTrust', () => {
    it("before the install: the local gateway's own certificate only (the frontend is not restarted after the wizard)", () => {
        const files = buildSsrTrust({ cwd: site({ ca: null, gateway: { ssl: true }, auto: true }) });
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/gateway[\\/]ssl-auto\.crt$/);
        expect(buildSsrTrust({ cwd: site({ ca: null, gateway: { ssl: false }, auto: true }) })).toEqual([]);
    });

    it('waitForGatewayAutoCert waits only for an auto-generated certificate', () => {
        expect(waitForGatewayAutoCert({ cwd: site({ ca: null, gateway: { ssl: true }, auto: true }), timeoutMs: 50 })).toBe(true);
        const t0 = Date.now();
        expect(waitForGatewayAutoCert({ cwd: site({ ca: null, gateway: { ssl: true } }), timeoutMs: 300 })).toBe(false);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
        expect(waitForGatewayAutoCert({ cwd: site({ ca: null, gateway: { ssl: false } }), timeoutMs: 5000 })).toBe(false);
        expect(waitForGatewayAutoCert({ cwd: site({ ca: null, gateway: null }), timeoutMs: 5000 })).toBe(false);
    });

    it('local split with the default self-signed gateway: cluster CA + gateway/ssl-auto.crt', () => {
        const cwd = site({ ca: 'backend', gateway: { ssl: true }, auto: true });
        const files = buildSsrTrust({ cwd });
        expect(files).toHaveLength(2);
        expect(files[0]).toMatch(/backend[\\/]certs[\\/]cluster-ca\.crt$/);
        expect(files[1]).toMatch(/gateway[\\/]ssl-auto\.crt$/);
    });

    it('an operator certificate in gateway-config.json wins over ssl-auto', () => {
        const cwd = site({ ca: 'frontend', gateway: { ssl: { enabled: true, key: 'my.key', cert: 'my.crt' } }, auto: true, operatorCert: 'my.crt' });
        const files = buildSsrTrust({ cwd });
        expect(files[1]).toMatch(/gateway[\\/]my\.crt$/);
    });

    it('a gateway serving plain HTTP (ssl off) adds nothing', () => {
        expect(buildSsrTrust({ cwd: site({ ca: 'frontend', gateway: { ssl: false }, auto: true }) })).toHaveLength(1);
        expect(buildSsrTrust({ cwd: site({ ca: 'frontend', gateway: { ssl: { enabled: false } }, auto: true }) })).toHaveLength(1);
    });

    it('no gateway on this machine (separate mode): cluster CA only', () => {
        expect(buildSsrTrust({ cwd: site({ ca: 'frontend', gateway: null }) })).toHaveLength(1);
        expect(gatewayPublicCert('/definitely/not/here')).toBeNull();
    });
});

describe('writeTrustBundle', () => {
    it('concatenates several files into one PEM bundle, and passes a single file through', () => {
        const cwd = site({ ca: 'backend', gateway: { ssl: true }, auto: true });
        const files = buildSsrTrust({ cwd });
        const out = path.join(cwd, '.next', 'ssr-trust.pem');
        expect(writeTrustBundle(files, out)).toBe(out);
        const pem = fs.readFileSync(out, 'utf8');
        expect(pem).toContain('CA');
        expect(pem).toContain('AUTO');
        expect(writeTrustBundle([files[0]], out)).toBe(files[0]);
        expect(writeTrustBundle([], out)).toBeNull();
    });
});
