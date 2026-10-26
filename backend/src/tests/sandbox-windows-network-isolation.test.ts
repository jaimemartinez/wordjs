/**
 * Windows, on the real kernel: with the private network ranges for apps set, a network-granted plugin's
 * container cannot reach a private destination, and one with an approved private destination can.
 *
 * The target is the cloud metadata service (169.254.169.254:80), which the CI runner exposes and which is
 * the classic private destination a plugin must not reach. The test needs an administrator (it sets the
 * machine policy, and restores it) and opts in with WORDJS_TEST_APPCONTAINER=1; the Sandbox parity
 * workflow's Windows runner is both. Without a reachable target it skips, explicitly.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execFileSync } from 'child_process';

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

describe('the Windows private network ranges for apps', { skip: SKIP }, () => {
    const PROFILE = `WordJSPluginSandbox.test-netiso-${process.pid}`;
    const KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\NetworkIsolation';
    let previous: string | null = null;
    let sid: string | null = null;
    const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-netiso-'));

    after(async () => {
        try {
            if (previous === null) spawnSync('reg', ['delete', KEY, '/v', 'DomainSubnets', '/f'], { stdio: 'ignore' });
            else spawnSync('reg', ['add', KEY, '/v', 'DomainSubnets', '/t', 'REG_SZ', '/d', previous, '/f'], { stdio: 'ignore' });
            spawnSync('gpupdate', ['/target:computer', '/force'], { stdio: 'ignore', timeout: 120000 });
        } catch { /* */ }
        try { if (sid) await sw.revokeAppContainerAccess(sid, [zone, path.dirname(sw.getAppContainerRuntimePath())]); } catch { /* */ }
        try { await sw.deleteAppContainerProfile(PROFILE); } catch { /* */ }
        try { fs.rmSync(zone, { recursive: true, force: true }); } catch { /* */ }
    });

    async function containedConnect(allowPrivateNetwork: boolean): Promise<string> {
        const exe = await sw.ensureAppContainerRuntime(sid as string);
        const out = path.join(zone, `net-${Date.now()}-${allowPrivateNetwork ? 'p' : 'i'}.txt`);
        const launched = await sw.launchInAppContainer({
            sid, exe, cwd: zone, allowNetwork: true, allowPrivateNetwork,
            args: ['-e', `var fs=require('fs');var done=function(c){fs.writeFileSync(process.env.WJS_OUT,c);process.exit(0)};var s=require('net').connect(${TARGET.port},'${TARGET.host}');s.on('connect',function(){done('CONNECTED')});s.on('error',function(e){done((e&&e.code)||'THROW')});setTimeout(function(){done('TIMEOUT')},6000)`],
            env: { SystemRoot: process.env.SystemRoot as string, windir: process.env.windir as string, PATH: process.env.PATH as string, TEMP: zone, TMP: zone, WJS_OUT: out },
        });
        await new Promise((resolve) => { let d = false; const f = () => { if (!d) { d = true; resolve(null); } }; launched.child.on('exit', f); setTimeout(f, 20000); });
        try { launched.child.kill(); } catch { /* */ }
        return fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'NO-RESULT';
    }

    test('internetClient alone is kept from the private ranges; privateNetworkClientServer reaches them', async () => {
        const q = spawnSync('reg', ['query', KEY, '/v', 'DomainSubnets'], { encoding: 'utf8' });
        const m = /DomainSubnets\s+REG_SZ\s+(.*)$/m.exec(String(q.stdout || ''));
        previous = m ? m[1].trim() : null;
        sid = await sw.ensureAppContainerProfile(PROFILE);
        assert.ok(sid);
        await sw.grantAppContainerAccess(sid as string, [zone], 'full');

        const before = await containedConnect(false);
        // Apply exactly what the panel applies (the runner is already elevated, so no prompt is involved).
        execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(sw.networkIsolationScript(), 'utf16le').toString('base64')], { stdio: 'ignore', timeout: 180000 });
        assert.strictEqual(sw.readNetworkIsolationPolicy().configured, true, 'the policy reads back as configured');
        const blocked = await containedConnect(false);
        const approved = await containedConnect(true);
        assert.ok(blocked === 'EACCES' || blocked === 'EPERM' || blocked === 'TIMEOUT',
            `with the ranges set, a container with only internetClient must not reach ${TARGET.host} (got ${blocked}; before the policy: ${before})`);
        assert.strictEqual(approved, 'CONNECTED', 'an approved private destination (privateNetworkClientServer) still connects');
    });
});
