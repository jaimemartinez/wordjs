/**
 * `npm run media -- …` on a network of sites. Every read of site data needs a site context there, and a
 * CLI process starts with none, so `status` used to fail with "No site context". The command manages the
 * main site's media library: its work runs as site 1.
 *
 * MUTATION PROOF: call the async body directly instead of through runAsMainSite and the first case fails.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../../scripts/media-storage.js');

describe('media CLI on a network of sites', () => {
    it('runs its whole body as the main site', () => {
        const src = fs.readFileSync(SCRIPT, 'utf8');
        assert.match(src, /site\.runWithSite\(site\.PRIMARY_SITE_ID, fn\)/);
        assert.match(src, /\nrunAsMainSite\(async \(\) => \{/, 'the command body is not wrapped');
        assert.ok(!/\n\(async \(\) => \{/.test(src), 'an unwrapped async body is left');
    });

    it('runWithSite(PRIMARY_SITE_ID) gives currentSiteId() a site with multisite on', () => {
        const config = require('../config/app');
        const site = require('../core/site-context');
        const before = config.multisite;
        config.multisite = { enabled: true };
        try {
            assert.throws(() => site.currentSiteId(), /No site context/);
            assert.strictEqual(site.runWithSite(site.PRIMARY_SITE_ID, () => site.currentSiteId()), 1);
        } finally {
            config.multisite = before;
        }
    });
});
