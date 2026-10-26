/**
 * analytics-tag DECLARES the host its loader injects a tag from.
 *
 * The public pages' Content-Security-Policy no longer allows every https host: only the origins the
 * active plugins' public scripts declare (`origins` on wordjs.assets.enqueueScript; frontend
 * lib/contentSecurityPolicy.ts). The analytics loader injects GA4, Plausible or an admin-entered Matomo,
 * so the plugin must declare that provider's origin — at boot from the stored configuration and again
 * on every save — and nothing while tracking is off.
 *
 * MUTATION PROOF: drop the enqueueLoader call from the POST /config handler and the switch below keeps
 * declaring the previous provider; drop `origins` from the enqueue and every case fails.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin } from './fixtures/marketplace-plugin-harness';

const ADMIN = { id: 1, role: 'administrator' };
const lastOrigins = (enqueued: any[]) => {
    const loader = enqueued.filter((e) => e.kind === 'script' && e.handle === 'analytics-tag-loader');
    assert.ok(loader.length, 'the loader was enqueued');
    return loader[loader.length - 1].origins;
};

test('analytics-tag declares exactly the configured provider origin, and follows every save', async () => {
    const p = await bootPlugin('analytics-tag');
    try {
        assert.deepStrictEqual(lastOrigins(p.enqueued), [], 'off by default: no third-party origin');
        const save = async (body: any) => {
            const r = await p.call('post', '/config', { body, user: ADMIN });
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            return lastOrigins(p.enqueued);
        };
        assert.deepStrictEqual(await save({ enabled: true, provider: 'ga4', ga4Id: 'G-ABC123' }), ['https://www.googletagmanager.com']);
        assert.deepStrictEqual(await save({ provider: 'plausible', plausibleDomain: 'example.com' }), ['https://plausible.io']);
        assert.deepStrictEqual(await save({ provider: 'matomo', matomoUrl: 'https://stats.example.com/matomo/', matomoSiteId: '3' }), ['https://stats.example.com']);
        assert.deepStrictEqual(await save({ enabled: false }), [], 'tracking off: nothing third-party is allowed');
    } finally {
        p.close();
    }
});

test('originsFor: the provider origin of a stored configuration, nothing for a broken one', async () => {
    const p = await bootPlugin('analytics-tag');
    try {
        await p.call('post', '/config', { body: { enabled: true, provider: 'plausible', plausibleDomain: 'example.com' }, user: ADMIN });
        const plugin = require('../../../marketplace/plugins/analytics-tag/index.js');
        assert.deepStrictEqual(plugin.originsFor(p.options.get('analytics_tag_config')), ['https://plausible.io']);
        assert.deepStrictEqual(plugin.originsFor({ enabled: true, provider: 'matomo', matomoUrl: 'not a url' }), []);
        assert.deepStrictEqual(plugin.originsFor(null), []);
    } finally {
        p.close();
    }
});
