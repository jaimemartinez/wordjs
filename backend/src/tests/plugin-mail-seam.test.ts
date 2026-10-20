/**
 * THE GENERIC MAIL SEAM — any plugin can send through whichever mail-PROVIDER plugin is active.
 *
 * Moving the mailbox grant out of the core (core/account-capabilities.ts) must not touch this seam: a
 * provider registers the site's sender with `wordjs.provideMail()` (grant `email:provider`, core/
 * mail-provider.ts), and every other plugin sends with `wordjs.mail()` (grant `email:admin`) without
 * knowing which provider that is. Pinned through the REAL bridge (core/plugin-api.ts createPluginApi) and
 * the real grant check, with fixture plugins declared on disk:
 *
 *   1. a consumer's message reaches the active provider, unchanged — and follows a provider swap;
 *   2. with no provider active, the consumer gets a clear error, not a silent success;
 *   3. both grants are enforced: no email:admin → no send, no email:provider → no takeover.
 *
 * The same consumer path with the REAL mail-server as provider is pinned in mail-server-mailbox-gate.test.ts.
 */
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const perms = require('../core/plugin-permissions');
const { runWithContext } = require('../core/plugin-context');
const { createPluginApi } = require('../core/plugin-api');
const mailProvider = require('../core/mail-provider');

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');
const CONSUMER = `wjs-mailseam-consumer-${process.pid}`;
const PROVIDER_A = `wjs-mailseam-provider-a-${process.pid}`;
const PROVIDER_B = `wjs-mailseam-provider-b-${process.pid}`;
const NO_GRANT = `wjs-mailseam-nogrant-${process.pid}`;
const created: string[] = [];

function declare(slug: string, permissions: Array<{ scope: string; access: string }>) {
    const dir = path.join(PLUGINS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: slug, name: slug, version: '1.0.0', isolated: true,
        permissions: permissions.map((p) => ({ ...p, reason: 'test' })),
    }));
    created.push(dir);
}
const as = (slug: string, fn: (api: any) => any) => runWithContext(slug, () => fn(createPluginApi(slug)));

before(() => {
    declare(CONSUMER, [{ scope: 'email', access: 'admin' }]);
    declare(PROVIDER_A, [{ scope: 'email', access: 'provider' }]);
    declare(PROVIDER_B, [{ scope: 'email', access: 'provider' }]);
    declare(NO_GRANT, [{ scope: 'email', access: 'admin' }, { scope: 'email', access: 'provider' }]);
    perms._setGrantsInMemory(CONSUMER, ['email:admin']);
    perms._setGrantsInMemory(PROVIDER_A, ['email:provider']);
    perms._setGrantsInMemory(PROVIDER_B, ['email:provider']);
    perms._setGrantsInMemory(NO_GRANT, []);           // declared, never granted
});

afterEach(() => mailProvider.clearMailProvider());

after(() => {
    for (const dir of created) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
});

test('a consumer plugin sends through the active provider, and follows a provider swap', async () => {
    const seenA: any[] = [];
    const seenB: any[] = [];
    await as(PROVIDER_A, (api) => api.provideMail(async (msg: any) => { seenA.push(msg); return { ok: 'A' }; }));
    assert.equal(mailProvider.currentProviderSlug(), PROVIDER_A);

    const msg = { to: 'someone@example.com', subject: 'Contact form', text: 'Hello' };
    assert.deepEqual(await as(CONSUMER, (api) => api.mail({ ...msg })), { ok: 'A' }, 'the provider\'s answer comes back');
    assert.equal(seenA.length, 1);
    assert.deepEqual(seenA[0], msg, 'the message reaches the provider unchanged');

    // Another provider plugin takes over: the consumer's code does not change, its mail follows.
    await as(PROVIDER_B, (api) => api.provideMail(async (m: any) => { seenB.push(m); return { ok: 'B' }; }));
    assert.equal(mailProvider.currentProviderSlug(), PROVIDER_B);
    assert.deepEqual(await as(CONSUMER, (api) => api.mail({ ...msg })), { ok: 'B' });
    assert.equal(seenA.length, 1, 'the replaced provider receives nothing more');
    assert.equal(seenB.length, 1);
});

test('with NO provider active, the consumer gets a clear error rather than a silent success', async () => {
    assert.equal(mailProvider.isEmailProviderAvailable(), false);
    await assert.rejects(
        () => as(CONSUMER, (api) => api.mail({ to: 'someone@example.com', subject: 'x', text: 'y' })),
        /Mail server not available/);
});

test('both grants are enforced: email:admin to send, email:provider to become the sender', async () => {
    const seen: any[] = [];
    await as(PROVIDER_A, (api) => api.provideMail(async (m: any) => { seen.push(m); }));
    await assert.rejects(() => as(NO_GRANT, (api) => api.mail({ to: 'a@example.com', subject: 's', text: 't' })),
        /Security Block/, 'a declared-but-ungranted email:admin cannot send');
    assert.equal(seen.length, 0);
    assert.throws(() => as(NO_GRANT, (api) => api.provideMail(() => undefined)),
        /Security Block/, 'nor take over the site\'s outbound mail without email:provider');
    assert.equal(mailProvider.currentProviderSlug(), PROVIDER_A, 'the active provider is untouched');
});
