/**
 * Windows: no AppContainer reads the install's secrets through ALL APPLICATION PACKAGES.
 *
 * Every AppContainer token carries S-1-15-2-1 (ALL APPLICATION PACKAGES) and S-1-15-2-2 (ALL RESTRICTED
 * APPLICATION PACKAGES). Installed under C:\Program Files - or in any tree whose ACL names either group -
 * every plugin's container could read wordjs-config.json, the database, the logs and every other plugin's
 * storage, whatever its package SID was granted. The probe now checks the secret paths, puts an explicit
 * deny for both groups on any it finds readable, and plants a canary under the install root that every
 * contained child must be refused.
 *
 * The live part makes a real contained child read a secret before and after the protection: it can before
 * (the control - the exposure is real), and cannot after. It registers a profile and edits ACLs, so it
 * runs only on Windows with WORDJS_TEST_APPCONTAINER=1 (the Sandbox parity workflow sets it).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const sw = require('../core/sandbox-windows');

test('the secret paths are the configuration, the data, logs and every plugin/theme tree that exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-secrets-'));
    try {
        for (const d of ['data', 'logs', 'plugins', 'node_modules', 'dist']) fs.mkdirSync(path.join(root, d));
        fs.writeFileSync(path.join(root, 'wordjs-config.json'), '{}');
        const got = sw.secretPathsFor(root).map((p: string) => path.basename(p)).sort();
        assert.deepStrictEqual(got, ['data', 'logs', 'plugins', 'wordjs-config.json']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the probe protects the secrets first and requires an install-root canary to be refused', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'sandbox-windows.ts'), 'utf8');
    // Protection runs in the profiles' round, which completes before either contained shape launches.
    const probe = src.slice(src.indexOf('function probeAppContainer('));
    const protect = probe.indexOf('protectSecretsFromAllAppContainers(appRoot)');
    assert.ok(protect > 0 && protect < probe.indexOf('const [sid, siblingSid] = await Promise.all([') + 400);
    assert.ok(protect < probe.indexOf('launchInAppContainer({'), 'the secrets are protected before any contained launch');
    assert.match(src, /const secretDenied = !secretCanary \|\| verdict\.secret === 'EPERM' \|\| verdict\.secret === 'EACCES';/);
    assert.match(src, /if \(!netDenied \|\| !readDenied \|\| !execDenied \|\| !canWork \|\| !secretDenied\)/);
    assert.match(src, /" {4}\$null = & icacls \$p \/inheritance:d \/C \/Q",\s+" {4}\$null = & icacls \$p \/remove:g \*S-1-15-2-1 \*S-1-15-2-2 \/C \/Q",/,
        'the two groups\' entries are removed: a deny entry for them is not honoured by the AppContainer check');
    assert.doesNotMatch(src, /\/deny \\"\*S-1-15-2-1/, 'and no deny entry is relied on');
    assert.match(String(sw.__probeChildSource), /WJS_PROBE_SECRET/);
});

const LIVE = process.platform === 'win32' && process.env.WORDJS_TEST_APPCONTAINER === '1';
describe('a contained child and a secret readable by ALL APPLICATION PACKAGES', { skip: !LIVE ? 'set WORDJS_TEST_APPCONTAINER=1 on Windows' : false }, () => {
    const PROFILE = `WordJSPluginSandbox.test-aap-${process.pid}`;
    let sid: string | null = null;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-aap-root-'));
    const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-aap-zone-'));
    after(async () => {
        try { if (sid) await sw.revokeAppContainerAccess(sid, [zone, path.dirname(sw.getAppContainerRuntimePath())]); } catch { /* */ }
        try { await sw.deleteAppContainerProfile(PROFILE); } catch { /* */ }
        for (const d of [root, zone]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    });

    async function containedRead(file: string): Promise<string> {
        const runtimeExe = await sw.ensureAppContainerRuntime(sid as string);
        const out = path.join(zone, `read-${Date.now()}.txt`);
        const launched = await sw.launchInAppContainer({
            sid, exe: runtimeExe, cwd: zone,
            args: ['-e', "var fs=require('fs');var r;try{fs.readFileSync(process.env.WJS_SECRET);r='OPEN'}catch(e){r=(e&&e.code)||'THROW'}fs.writeFileSync(process.env.WJS_OUT,r);process.exit(0)"],
            env: { SystemRoot: process.env.SystemRoot as string, windir: process.env.windir as string, PATH: process.env.PATH as string, TEMP: zone, TMP: zone, WJS_SECRET: file, WJS_OUT: out },
        });
        await new Promise((resolve) => { let d = false; const f = () => { if (!d) { d = true; resolve(null); } }; launched.child.on('exit', f); setTimeout(f, 15000); });
        try { launched.child.kill(); } catch { /* */ }
        return fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'NO-RESULT';
    }

    test('readable before the protection (control), refused after it', async () => {
        sid = await sw.ensureAppContainerProfile(PROFILE);
        assert.ok(sid);
        await sw.grantAppContainerAccess(sid as string, [zone], 'full');
        fs.mkdirSync(path.join(root, 'data'));
        const secret = path.join(root, 'data', 'secret.txt');
        fs.writeFileSync(secret, 'host-secret');
        // The deployment shape: the install tree inherits an ACE that lets every AppContainer read it.
        // (Measured while building this: a DENY entry for the group placed before that allow did NOT stop the
        // read - which is why the protection removes the group's entries instead.)
        execFileSync('icacls', [root, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)'], { stdio: 'ignore' });
        const before = await containedRead(secret);
        assert.strictEqual(before, 'OPEN', `control: with the inherited ACE a contained child DOES read it (got ${before})`);

        const r = await sw.protectSecretsFromAllAppContainers(root);
        assert.ok(r.protectedPaths.map((p: string) => path.basename(p)).includes('data'), JSON.stringify(r));
        assert.deepStrictEqual(r.exposed, []);
        const after = await containedRead(secret);
        assert.ok(after === 'EPERM' || after === 'EACCES', `after the protection the read is refused (got ${after})`);
        // The host itself is in neither group: it still reads its own data.
        assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'host-secret');
        // A plugin's own explicit zone under that tree still works (explicit allow outranks the inherited deny).
        const ownZone = path.join(root, 'data', 'plugin-own', 'p');
        fs.mkdirSync(ownZone, { recursive: true });
        fs.writeFileSync(path.join(ownZone, 'mine.txt'), 'mine');
        await sw.grantAppContainerAccess(sid as string, [ownZone], 'full');
        assert.strictEqual(await containedRead(path.join(ownZone, 'mine.txt')), 'OPEN', 'its own zone stays readable');
        await sw.revokeAppContainerAccess(sid as string, [ownZone]);
    });
});
