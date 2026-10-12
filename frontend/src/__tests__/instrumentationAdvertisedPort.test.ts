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
import { advertisedPort } from '@/instrumentation';

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
        const register = source.slice(source.indexOf('const registerWithGateway'));
        expect(register).toMatch(/const port = advertisedPort\(process\.env\.PORT, frontendPort\);/);
        expect(register).not.toMatch(/url\.port/);
        expect(register).toMatch(/url: `https:\/\/\$\{hostname\}:\$\{port\}`/);
    });
});
