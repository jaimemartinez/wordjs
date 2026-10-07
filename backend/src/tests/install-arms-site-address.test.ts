/**
 * WordJS — a fresh install starts the site-address machinery in the same process.
 *
 * A backend that boots UNINSTALLED never runs site-address's boot reconcile (it is gated on isInstalled()).
 * Without a start after POST /setup/install, the gateway sync waits forever on whenReconciled(), so the
 * gateway's host edge (split / separate mode) stays unarmed — no 421 page, no redirects, no R4 — until the
 * backend restarts. The install handler must therefore call siteAddress.ensureStarted() before it answers.
 *
 * A source assertion, not an end-to-end install: the install path needs a real database, mTLS material and
 * the wizard's full body; what matters here is that the call exists, on the success path, before res.json.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SETUP = fs.readFileSync(path.join(__dirname, '..', 'routes', 'setup.ts'), 'utf8');

/** The body of router.post('/install', …) up to the next route registration. */
function installHandler(): string {
    const start = SETUP.indexOf("router.post('/install'");
    assert.ok(start >= 0, 'the install route exists');
    const next = SETUP.indexOf('\nrouter.', start + 10);
    return SETUP.slice(start, next < 0 ? undefined : next);
}

describe('POST /setup/install starts site-address in-process', () => {
    test('ensureStarted() is called on the success path, before the success answer', () => {
        const body = installHandler();
        // A real statement (line start), not the text inside a comment.
        const call = body.search(/^[ \t]*require\('\.\.\/core\/site-address'\)\.ensureStarted\(\)\.catch\(/m);
        const answer = body.search(/res\.json\(\{\s*success: true/);
        assert.ok(call >= 0, 'the install handler starts site-address (arms the gateway edge, releases whenReconciled)');
        assert.ok(answer >= 0, 'the success answer is found');
        assert.ok(call < answer, 'it is started before the success answer, so the wizard\'s next request already meets an armed edge');
    });

    test('the config is born at site-address revision 1 as the INSTALLER\'s, and the database mirror with it (lab M-03)', () => {
        // Without both, the reconcile ensureStarted() runs next took the new site for a legacy install and
        // recorded `lastChange: { kind: 'repair', via: 'upgrade' }` for good. The record itself (installRecord)
        // and the reconcile it meets are exercised in site-address-reconcile.test.ts.
        const body = installHandler();
        const config = body.slice(body.indexOf('const newConfig'), body.indexOf('if (saveConfig(newConfig))'));
        assert.match(config, /^\s*siteAddress: require\('\.\.\/core\/site-address'\)\.installRecord\(Date\.now\(\)\),$/m,
            'newConfig carries the install record');
        const mirror = body.search(/^\s*await updateOption\('site_address_rev', newConfig\.siteAddress\.rev\);$/m);
        const home = body.search(/^\s*await updateOption\('home', /m);
        const start = body.search(/^[ \t]*require\('\.\.\/core\/site-address'\)\.ensureStarted\(\)\.catch\(/m);
        assert.ok(home > 0 && mirror > home, 'site_address_rev is written with siteurl and home');
        assert.ok(mirror < start, 'before the reconcile that would otherwise "upgrade" the new site');
        const siteAddress = require('../core/site-address');
        assert.deepStrictEqual(siteAddress.installRecord(Date.parse('2026-10-06T00:00:00Z')),
            { rev: 1, lastChange: { kind: 'install', via: 'install', by: null, at: '2026-10-06T00:00:00.000Z', rev: 1 } });
    });

    test('the auto-login asks every refusal of the one door first, so the door never ends the install early (review R3S-7)', () => {
        // issueSessionCookie answers (and the handler returns) when it refuses: the install token would
        // stay on disk and site-address would not start until a restart. So each of its refusals is asked
        // in advance and turned into autoLoginSkipped: the sign-in rule, and a retiring address.
        const body = installHandler();
        const door = body.search(/^[ \t]*if \(issueSessionCookie\(req, res, token, sessionCookieOptions\(req\)\)\) return;$/m);
        const rule = body.search(/^[ \t]*if \(signInRefusal\(req\)\) autoLoginSkipped = 'sign-in-refused';$/m);
        const retiring = body.search(/^[ \t]*else if \(signInRetiring\(req\)\) autoLoginSkipped = 'address-retiring';$/m);
        assert.ok(door > 0, 'the one door is found');
        assert.ok(rule > 0 && rule < door, 'the sign-in rule is asked before the door');
        assert.ok(retiring > rule && retiring < door, 'and so is the retiring address');
        assert.match(SETUP, /enum: \[address-not-accepted, sign-in-refused, address-retiring\]/, 'documented in the install answer');
    });

    test('the start is not awaited and its failure is only logged (the install already succeeded)', () => {
        const body = installHandler();
        assert.match(body, /^[ \t]*require\('\.\.\/core\/site-address'\)\.ensureStarted\(\)\.catch\(/m);
        assert.doesNotMatch(body, /await require\('\.\.\/core\/site-address'\)\.ensureStarted\(\)/);
    });
});
