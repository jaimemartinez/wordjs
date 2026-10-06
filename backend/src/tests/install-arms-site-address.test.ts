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

    test('the start is not awaited and its failure is only logged (the install already succeeded)', () => {
        const body = installHandler();
        assert.match(body, /^[ \t]*require\('\.\.\/core\/site-address'\)\.ensureStarted\(\)\.catch\(/m);
        assert.doesNotMatch(body, /await require\('\.\.\/core\/site-address'\)\.ensureStarted\(\)/);
    });
});
