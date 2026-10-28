/**
 * THE REGISTRATION LEG VERIFIES THE GATEWAY.
 *
 * `src/instrumentation.ts` POSTs `/register` to the gateway's internal mTLS port carrying this node's
 * `x-gateway-secret` and the list of routes it is willing to serve. It loaded `ca` + `key` + `cert`
 * and then passed `rejectUnauthorized: false` ("Dev override"), so it never checked WHO it was talking
 * to: anything answering on `gatewayHost:gatewayInternalPort` — a co-resident process that port-steals
 * the internal port, anything on the path in a multi-machine cluster — collected the cluster secret and
 * could answer as the gateway. The material was there; the check was not.
 *
 * These tests drive `gatewayClientOptions`, the function `register()` actually builds its request
 * options with (it is spread straight into `https.request`), plus a source assertion so the literal
 * cannot come back the way it came the first time.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gatewayClientOptions, isRegisterHandshakeFailure } from '@/instrumentation';
import { checkGatewayIdentity } from '@/lib/gatewayIdentity';
import { clusterSecretRequestOptions } from '@/lib/revalidateSecret';
import { edgeInfoRequestOptions } from '@/lib/edgeSync';

/** The peer check of the two sibling legs (purge-secret repair, edge sync), built from real files. */
function clusterSecretRequestOptionsCheck() {
    const p = certDir(FULL);
    const id = { gatewayHost: 'localhost', gatewayInternalPort: 3100, ca: p.ca, key: p.key, cert: p.cert } as any;
    const a = clusterSecretRequestOptions(id).checkServerIdentity;
    expect(edgeInfoRequestOptions(id).checkServerIdentity).toBe(a);
    return a;
}

/** A cert directory with real files on disk — readFileSync must actually succeed. */
function certDir(files: Record<string, string>): { ca: string; key: string; cert: string; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-instr-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return {
        dir,
        ca: path.join(dir, 'cluster-ca.crt'),
        key: path.join(dir, 'frontend.key'),
        cert: path.join(dir, 'frontend.crt'),
    };
}

const FULL = {
    'cluster-ca.crt': 'CA-PEM',
    'frontend.key': 'KEY-PEM',
    'frontend.crt': 'CERT-PEM',
};

describe('instrumentation: the gateway registration leg', () => {
    it('VERIFIES the peer — rejectUnauthorized is true, never false', () => {
        const p = certDir(FULL);
        const opts = gatewayClientOptions(fs, p);

        expect(opts.rejectUnauthorized).toBe(true);
        // The client identity still travels: mTLS proves who WE are, verification proves who THEY are.
        // Both halves, or the leg is only half a control.
        expect(String(opts.ca)).toBe('CA-PEM');
        expect(String(opts.key)).toBe('KEY-PEM');
        expect(String(opts.cert)).toBe('CERT-PEM');
    });

    it('checks the hostname AND that the certificate names the gateway', () => {
        // Every cluster certificate — a backend's and a frontend's too — carries localhost + 127.0.0.1
        // SANs, so hostname verification alone accepts another node answering on the gateway's internal
        // port. The check keeps the hostname verification (never a CN check INSTEAD of it) and adds the
        // gateway's identity. The sibling legs to the same port use the same function.
        const opts = gatewayClientOptions(fs, certDir(FULL));
        expect(opts.checkServerIdentity).toBe(checkGatewayIdentity);
        expect(clusterSecretRequestOptionsCheck()).toBe(checkGatewayIdentity);
        const leaf = (cn: string) => ({ subject: { CN: cn }, subjectaltname: 'DNS:localhost, IP Address:127.0.0.1' });
        expect(checkGatewayIdentity('localhost', leaf('gateway-internal'))).toBeUndefined();
        expect(checkGatewayIdentity('127.0.0.1', leaf('gateway'))).toBeUndefined();
        for (const cn of ['backend', 'frontend', 'evil']) {
            expect(checkGatewayIdentity('localhost', leaf(cn)), cn).toBeInstanceOf(Error);
        }
        // …and the hostname still has to match: the gateway's own certificate for another host is refused.
        expect(checkGatewayIdentity('gw.example', leaf('gateway-internal'))).toBeInstanceOf(Error);
    });

    it('reports NO cluster identity when any of the three files is missing', () => {
        // The caller reads `{}` as "no mTLS" and falls back to plain HTTP on the PUBLIC gateway port —
        // the pre-enrolment bootstrap. Losing one file must not produce half-built TLS options (the
        // exact shape audit #27 found on the backend's purge leg).
        for (const missing of ['cluster-ca.crt', 'frontend.key', 'frontend.crt']) {
            const partial = { ...FULL } as Record<string, string>;
            delete partial[missing];
            expect(gatewayClientOptions(fs, certDir(partial)), `missing ${missing}`).toEqual({});
        }
    });

    it('the "Dev override" literal is gone from the module', () => {
        // Source-level, on purpose: the defect was a literal in an options object, and a literal is what
        // must never reappear. gateway/test/dispatcher-parity.test.js pins a cross-file fact the same way.
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'instrumentation.ts'), 'utf8');
        expect(src).not.toMatch(/rejectUnauthorized:\s*false/);
    });
});

describe('instrumentation: a refused handshake is not "the gateway is still booting"', () => {
    it('classifies handshake failures as permanent', () => {
        // ECONNRESET is included deliberately: a peer refusing our certificate most often surfaces as a
        // bare socket hang up rather than a TLS alert — the signature that kept audit #27 invisible.
        for (const e of [
            { code: 'ECONNRESET', message: 'socket hang up' },
            { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: "Hostname/IP does not match certificate's altnames" },
            { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' },
            { code: '', message: 'self signed certificate in certificate chain' },
        ]) {
            expect(isRegisterHandshakeFailure(e), e.code || e.message).toBe(true);
        }
    });

    it('leaves a gateway that is merely down on the silent retry path', () => {
        // Retrying these forever without a word is correct — every boot starts here.
        for (const e of [
            { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3100' },
            { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND gateway.internal' },
            { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' },
        ]) {
            expect(isRegisterHandshakeFailure(e), e.code).toBe(false);
        }
    });
});
