/**
 * THE FRONTEND ADVERTISES THE PORT IT LISTENS ON.
 *
 * `src/instrumentation.ts` registers this node with the gateway as `https://<host>:<port>`, and the
 * gateway proxies every page there. The port was taken from `frontendUrl` — but `frontendUrl` is the
 * site's PUBLIC origin: the install wizard stores the address visitors use, which on a single host is
 * the gateway itself (`http://localhost:3000`). After the first restart of a split install made through
 * the wizard, the frontend registered as `https://localhost:3000` and the gateway proxied every page to
 * itself (502 "Upstream Error", EPROTO) until its health check evicted the target ~90 s later — and the
 * gateway's cache purge, which fans out to the registered frontends, had none.
 *
 * MUTATION PROOF: put back `if (url.port) port = url.port;` in register() and the source assertion
 * fails; make advertisedPort prefer frontendPort over PORT and the first case fails.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { advertisedPort, advertisedUrl } from '@/instrumentation';

describe('instrumentation: the port this node registers with the gateway', () => {
    it('is the port the server listens on (PORT, set by scripts/start-frontend.js)', () => {
        expect(advertisedPort('3001', 3005)).toBe('3001');
        expect(advertisedPort('4321', undefined)).toBe('4321');
    });

    it('falls back to frontendPort, then 3001, for a server started without PORT', () => {
        expect(advertisedPort(undefined, 3005)).toBe('3005');
        expect(advertisedPort(undefined, '3006')).toBe('3006');
        expect(advertisedPort(undefined, undefined)).toBe('3001');
        expect(advertisedPort('', 'not-a-port')).toBe('3001');
        expect(advertisedPort('3001; rm -rf', undefined)).toBe('3001');
    });

    it('never comes from frontendUrl, the public origin', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'instrumentation.ts'), 'utf8');
        const register = source.slice(source.indexOf('const readRegistrationContext'));
        expect(register).toMatch(/const port = advertisedPort\(process\.env\.PORT, frontendPort\);/);
        expect(register).not.toMatch(/url\.port/);
        expect(register).toMatch(/url: advertisedUrl\(process\.env\.WORDJS_FRONTEND_LISTENER, hostname, port\)/);
    });
});

/**
 * A SPLIT INSTALL REGISTERS ITS FRONTEND WITHOUT A RESTART.
 *
 * Split mode starts the frontend before the wizard has written any config or certificate. The loop read
 * both ONCE, at boot, so it kept POSTing `/register` to the gateway's PUBLIC port with no identity (a 405
 * every 5 s, for the life of the process) and the frontend never registered — every cache purge after the
 * install was dropped ("no frontend node registered") until the frontend was restarted. And once it could
 * register, advertising `https://` would have pointed the gateway's TLS at a socket still listening in
 * plain HTTP.
 *
 * MUTATION PROOF: hoist `readRegistrationContext()` out of `attempt` and the per-attempt assertion fails;
 * restore the plain-HTTP POST to `gatewayPort` and the no-identity assertion fails; make advertisedUrl
 * ignore the listener, or advertise the configured host over plain HTTP, and the first case fails; drop
 * the env assignment in server.js, or move it into `app.prepare().then`, and the last case fails.
 */
describe('instrumentation: registering after the install wrote the certificates', () => {
    it('advertises the scheme the server listens with, and plain HTTP only on loopback', () => {
        expect(advertisedUrl('https', 'example.org', '3001')).toBe('https://example.org:3001');
        expect(advertisedUrl(undefined, 'localhost', '3001')).toBe('https://localhost:3001');
        expect(advertisedUrl('http', 'example.org', '3001')).toBe('http://127.0.0.1:3001');
        expect(advertisedUrl('http', '10.0.0.5', '4321')).toBe('http://127.0.0.1:4321');
    });

    it('reads config and certificates on every attempt, and sends nothing without an identity', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'instrumentation.ts'), 'utf8');
        const attempt = source.slice(source.indexOf('const attempt = () =>'), source.indexOf('gatewayReq.write(data)'));
        expect(attempt).toMatch(/= readRegistrationContext\(\);/);
        expect(attempt).toMatch(/if \(Object\.keys\(clientOpts\)\.length === 0\) \{[\s\S]*?retry\(\);\s*return;/);
        expect(source).not.toMatch(/gatewayPort/);
        expect(source).not.toMatch(/await import\('http'\)/);
    });

    it('server.js publishes its listener choice before Next starts', () => {
        const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
        const set = server.indexOf("process.env.WORDJS_FRONTEND_LISTENER = hasIdentity ? 'https' : 'http';");
        expect(set).toBeGreaterThan(-1);
        expect(set).toBeLessThan(server.indexOf('app.prepare()'));
        expect(server).toMatch(/if \(hasIdentity\) \{/);
    });
});
