/**
 * The source-mode (ts-node) worker never stands in for the compiled build on a production server.
 *
 * The supervisor (server.js) used to fall back to ts-node whenever dist/ was missing, and the launcher
 * then exempted the source-mode Windows worker from AppContainer. A production update whose build failed
 * therefore started plugins without the native sandbox. Now the supervisor refuses to run the sources
 * without an explicit development opt-in, and the exemption needs one too.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const isolate = require('../core/plugin-isolate');

test('server.js runs the compiled build, and the sources only on an explicit non-production opt-in', () => {
    const sup = require('../../server.js');
    assert.strictEqual(sup.chooseEntry(true, {}), 'compiled');
    assert.strictEqual(sup.chooseEntry(false, {}), 'refuse', 'a missing dist/ is never a silent ts-node fallback');
    assert.strictEqual(sup.chooseEntry(false, { NODE_ENV: 'development' }), 'refuse', 'NODE_ENV alone is not the opt-in');
    assert.strictEqual(sup.chooseEntry(false, { WORDJS_ALLOW_SOURCE: '1' }), 'source');
    assert.strictEqual(sup.chooseEntry(false, { WORDJS_ALLOW_SOURCE: '1', NODE_ENV: 'production' }), 'refuse');
});

test('monolith prod refuses to load the backend sources when dist/ is missing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'monolith.js'), 'utf8');
    assert.match(src, /else if \(!dev\) \{[\s\S]{0,400}throw new Error\('backend\/dist\/index\.js is missing/);
});

test('the Windows source-worker exemption needs a development or test opt-in and never applies in production', () => {
    const base = { configured: true, platform: 'win32', tsNode: true };
    assert.strictEqual(isolate.__nativeSandboxRequired({ ...base, env: {} }), true, 'running the sources is not an opt-in');
    assert.strictEqual(isolate.__nativeSandboxRequired({ ...base, env: { WORDJS_DEV_SANDBOX_EXEMPT: '1' } }), false);
    assert.strictEqual(isolate.__nativeSandboxRequired({ ...base, env: { NODE_TEST_CONTEXT: 'child-v8' } }), false);
    assert.strictEqual(isolate.__nativeSandboxRequired({ ...base, env: { WORDJS_DEV_SANDBOX_EXEMPT: '1', NODE_ENV: 'production' } }), true, 'the dev opt-in is never honoured in production');
    assert.strictEqual(isolate.__nativeSandboxRequired({ ...base, tsNode: false, env: { WORDJS_DEV_SANDBOX_EXEMPT: '1' } }), true, 'compiled code has no exemption');
    const decide = isolate.__platformLaunchDecision;
    assert.strictEqual(decide({ platform: 'win32', state: 'active', netGranted: false, tsNode: true, env: {} }).use, true,
        'without the opt-in a certified AppContainer is applied to the source worker as well');
    assert.strictEqual(decide({ platform: 'win32', state: 'active', netGranted: false, tsNode: true, env: { NODE_ENV: 'production', WORDJS_DEV_SANDBOX_EXEMPT: '1' } }).use, true);
});

test('npm run dev and the dev monolith are where the opt-in comes from', () => {
    const devEnv = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'dev-env.js'), 'utf8');
    assert.match(devEnv, /WORDJS_DEV_SANDBOX_EXEMPT = '1'/);
    const mono = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'monolith.js'), 'utf8');
    assert.match(mono, /process\.env\.WORDJS_DEV_SANDBOX_EXEMPT = '1'/);
});
