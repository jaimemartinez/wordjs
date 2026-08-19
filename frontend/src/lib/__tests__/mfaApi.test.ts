/**
 * The client half of the two-factor surface, pinned against the REAL `mfaApi` (no hand-built request
 * object: the wire is what the backend routers read).
 *
 * Why it exists: enrolment became sudo-gated on the backend — POST /auth/mfa/setup hands out the TOTP
 * secret and POST /auth/mfa/enable locks the account, so both demand `currentPassword` — while the
 * client still posted `{}` and `{ code }`. Enabling 2FA from the admin panel answered
 * 403 `rest_bad_current_password`, i.e. the feature was unreachable, which is the failure mode a wire
 * test catches and a type-check does not.
 *
 * The second half is the escape hatch: POST /users/:id/mfa/reset shipped with no client at all, so a
 * user locked out of their authenticator could only be recovered by deleting the account.
 *
 * Node environment (see vitest.config.mts): `fetch` is substituted per test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mfaApi } from '../api';

type Recorded = { url: string; method: string; body?: string };

let calls: Recorded[];
const realFetch = globalThis.fetch;

const stubFetch = (status = 200, payload: unknown = {}) => {
    globalThis.fetch = (async (input: any, init: any = {}) => {
        calls.push({ url: String(input), method: init.method || 'GET', body: init.body });
        const raw = JSON.stringify(payload);
        return {
            ok: status < 400,
            status,
            statusText: 'OK',
            headers: { get: () => null },
            json: async () => JSON.parse(raw),
            text: async () => raw,
        };
    }) as unknown as typeof fetch;
};

/** Everything after the API base, i.e. what the backend router actually matches on. */
const pathOf = (url: string) => url.slice(url.indexOf('/api/v1') + '/api/v1'.length);
const bodyOf = (c: Recorded) => JSON.parse(c.body as string);

beforeEach(() => {
    calls = [];
    stubFetch(200, { secret: 's', otpauthUri: 'otpauth://x', enabled: true, backupCodes: [], reset: true, id: 7 });
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('mfaApi enrolment carries the re-auth the backend demands', () => {
    it('sends currentPassword on /auth/mfa/setup — the call that DISCLOSES the secret', async () => {
        await mfaApi.setup('hunter2');
        expect(calls).toHaveLength(1);
        expect(`${calls[0].method} ${pathOf(calls[0].url)}`).toBe('POST /auth/mfa/setup');
        expect(bodyOf(calls[0])).toEqual({ currentPassword: 'hunter2' });
    });

    it('sends BOTH the code and currentPassword on /auth/mfa/enable — the call that locks the account', async () => {
        await mfaApi.enable('123456', 'hunter2');
        expect(`${calls[0].method} ${pathOf(calls[0].url)}`).toBe('POST /auth/mfa/enable');
        // Field names as routes/auth.ts destructures them: req.body.code and req.body.currentPassword.
        expect(bodyOf(calls[0])).toEqual({ code: '123456', currentPassword: 'hunter2' });
    });

    it('refuses a blank password BEFORE the network, because a failed proof burns a login attempt', async () => {
        // requireSudoPassword proves the password through the SAME per-account lockout bucket as
        // /auth/login: a screen that fired these with an empty field would record failures against the
        // user and could throttle them out of signing in at all.
        await expect(mfaApi.setup('')).rejects.toThrow(/current password/i);
        await expect(mfaApi.enable('123456', '')).rejects.toThrow(/current password/i);
        expect(calls).toHaveLength(0);
    });

    it('leaves the code-proved doors alone — they are gated by a TOTP/backup code, not the password', async () => {
        await mfaApi.disable('123456');
        await mfaApi.regenerateBackupCodes('123456');
        expect(calls.map((c) => `${c.method} ${pathOf(c.url)}`)).toEqual([
            'POST /auth/mfa/disable',
            'POST /auth/mfa/backup-codes',
        ]);
        expect(bodyOf(calls[0])).toEqual({ code: '123456' });
        expect(bodyOf(calls[1])).toEqual({ code: '123456' });
    });
});

describe('mfaApi.resetForUser — the administrative escape hatch', () => {
    it('posts to the users router, not to /auth/mfa/*', async () => {
        const res = await mfaApi.resetForUser(7);
        expect(`${calls[0].method} ${pathOf(calls[0].url)}`).toBe('POST /users/7/mfa/reset');
        // No body fields: the route identifies the target by :id and takes nothing else.
        expect(bodyOf(calls[0])).toEqual({});
        expect(res).toEqual(expect.objectContaining({ reset: true, id: 7 }));
    });

    it('surfaces the backend refusal code so the UI can tell one 403 from another', async () => {
        stubFetch(403, { code: 'rest_forbidden', message: 'Only an administrator can reset two-factor authentication on a privileged account.', data: { status: 403 } });
        await expect(mfaApi.resetForUser(7)).rejects.toMatchObject({
            code: 'rest_forbidden',
            status: 403,
            message: expect.stringContaining('administrator'),
        });
    });
});
