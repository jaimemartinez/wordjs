import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveRevalidateSecret } from '../revalidateSecret';

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
