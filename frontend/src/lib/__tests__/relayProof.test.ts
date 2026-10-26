/**
 * MULTISITE RELAY PROOF ON SSR READS.
 *
 * The gateway believes the X-Forwarded-Host of a frontend node's server-side reads (which site of the
 * network to render) only next to the node's relay proof — an HMAC of a fixed label under the cluster's
 * revalidate secret (gateway/src/host-edge.js relayProof). The two sides must derive the SAME value:
 * the vector below is pinned in gateway/test/host-edge.test.js too.
 *
 * MUTATION PROOF: drop the `x-wordjs-relay` header from serverResponse and the second case fails.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { relayProofFor, serverFetch } from '../server-api';

describe('the frontend relay proof', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('is the same derivation the gateway checks, and none without a usable secret', () => {
        expect(relayProofFor('0123456789abcdef0123456789abcdef')).toBe('911d1e14f9ad1f0abba7beecceefa28ba4a508bbe4110430fc3658a4baf1ca6b');
        expect(relayProofFor('')).toBeNull();
        expect(relayProofFor('short')).toBeNull();
        expect(relayProofFor(undefined)).toBeNull();
    });

    it('rides along with the forwarded host of a public read', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-relay-'));
        const secret = 'c'.repeat(64);
        fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({ siteUrl: 'https://example.com', revalidateSecret: secret }));
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        let sent: Record<string, string> = {};
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            sent = init.headers as Record<string, string>;
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        });
        try {
            await serverFetch('/settings');
            expect(sent['x-forwarded-host']).toBe('example.com');
            expect(sent['x-wordjs-relay']).toBe(relayProofFor(secret));
            expect(sent['x-wordjs-relay']).not.toBe(secret);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
