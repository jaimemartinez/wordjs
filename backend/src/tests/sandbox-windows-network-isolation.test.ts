/**
 * Windows, on the real kernel: with its private-network firewall rule in place, a network-granted plugin's
 * container cannot reach a private destination, and one with an approved private destination can.
 *
 * The target is the cloud metadata service (169.254.169.254:80), which the CI runner exposes and which is
 * the classic private destination a plugin must not reach. The test needs an administrator (it adds a
 * firewall rule for its own throwaway package SID, and removes it) and opts in with
 * WORDJS_TEST_APPCONTAINER=1; the Sandbox parity workflow's Windows runner is both. Without a reachable
 * target it skips, explicitly.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const sw = require('../core/sandbox-windows');
const TARGET = { host: '169.254.169.254', port: 80 };

function isAdmin(): boolean {
    if (process.platform !== 'win32') return false;
    return spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
}
function hostReaches(): boolean {
    const r = spawnSync(process.execPath, ['-e', `var s=require('net').connect(${TARGET.port},'${TARGET.host}');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(2));setTimeout(()=>process.exit(3),4000)`], { timeout: 8000 });
    return r.status === 0;
}

const ELIGIBLE = process.platform === 'win32' && process.env.WORDJS_TEST_APPCONTAINER === '1' && isAdmin();
const SKIP = !ELIGIBLE ? 'needs Windows, an administrator and WORDJS_TEST_APPCONTAINER=1' : (!hostReaches() ? `this host cannot reach ${TARGET.host}:${TARGET.port}` : false);

describe('the Windows private-network firewall rule for plugins', { skip: SKIP }, () => {
    const PROFILE = `WordJSPluginSandbox.test-netiso-${process.pid}`;
    let sid: string | null = null;
    const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-netiso-'));
    // A throwaway install root: the rules WordJS records for it never touch a real install.
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-netiso-root-'));

    after(async () => {
        // Only this test's own rule, by name: never the rules a real install on this host may hold.
        try { if (sid) spawnSync('powershell.exe', ['-NoProfile', '-Command', `Remove-NetFirewallRule -Name 'wjs-private-${sid}' -ErrorAction SilentlyContinue`], { stdio: 'ignore', timeout: 60000 }); } catch { /* */ }
        try { if (sid) await sw.revokeAppContainerAccess(sid, [zone, path.dirname(sw.getAppContainerRuntimePath())]); } catch { /* */ }
        try { await sw.deleteAppContainerProfile(PROFILE); } catch { /* */ }
        try { fs.rmSync(zone, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(appRoot, { recursive: true, force: true }); } catch { /* */ }
    });

    async function containedConnect(allowPrivateNetwork: boolean): Promise<string> {
        const exe = await sw.ensureAppContainerRuntime(sid as string);
        const out = path.join(zone, `net-${Date.now()}-${allowPrivateNetwork ? 'p' : 'i'}.txt`);
        const launched = await sw.launchInAppContainer({
            sid, exe, cwd: zone, allowNetwork: true, allowPrivateNetwork,
            args: ['-e', `var fs=require('fs');var done=function(c){fs.writeFileSync(process.env.WJS_OUT,c);process.exit(0)};var s=require('net').connect(${TARGET.port},'${TARGET.host}');s.on('connect',function(){done('CONNECTED')});s.on('error',function(e){done((e&&e.code)||'THROW')});setTimeout(function(){done('TIMEOUT')},6000)`],
            env: { SystemRoot: process.env.SystemRoot as string, windir: process.env.windir as string, PATH: process.env.PATH as string, TEMP: zone, TMP: zone, WJS_OUT: out },
        });
        await new Promise((resolve) => { let d = false; const f = () => { if (!d) { d = true; resolve(null); } }; launched.child.on('exit', f); setTimeout(f, 30000); });
        try { launched.child.kill(); } catch { /* */ }
        return fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'NO-RESULT';
    }

    test('internetClient alone is kept from the private ranges; privateNetworkClientServer reaches them', async () => {
        sid = await sw.ensureAppContainerProfile(PROFILE);
        assert.ok(sid);
        await sw.grantAppContainerAccess(sid as string, [zone], 'full');

        const before = await containedConnect(false);
        // Exactly what a launch does (the runner is elevated, so the rule goes in without a prompt).
        assert.strictEqual(sw.ensurePrivateRangeRule(appRoot, sid, []), true, 'the rule is in place');
        assert.ok(!sw.readNetworkIsolationPolicy(appRoot).missing.includes(sid), 'and reads back as present');
        const blocked = await containedConnect(false);
        // An approved destination: cut out of the rule, and privateNetworkClientServer for the container.
        assert.strictEqual(sw.ensurePrivateRangeRule(appRoot, sid, [TARGET.host]), true);
        const approved = await containedConnect(true);
        assert.ok(blocked === 'EACCES' || blocked === 'EPERM' || blocked === 'TIMEOUT',
            `with its rule in place, a container with only internetClient must not reach ${TARGET.host} (got ${blocked}; before the rule: ${before})`);
        assert.strictEqual(approved, 'CONNECTED', 'an approved private destination (privateNetworkClientServer) still connects');
    });
});
