/**
 * WordJS - core/sandbox-windows.ts (Windows AppContainer confinement)
 *
 * Two halves, deliberately:
 *
 *  · PURE tests run EVERYWHERE (including Linux CI). They cover the things that break silently and are
 *    invisible in a green build: the generated PowerShell must be pure ASCII (PS 5.1 parses script text
 *    as ANSI and a single non-ASCII byte fails the parser in a way that surfaces as an unexplained launch
 *    failure), the icacls principal must actually expand (the `${sid}` vs `$sid:` trap -- the second form
 *    parses as a scope qualifier and grants NOTHING while reporting success), the argv quoting must
 *    survive round-tripping, and the two --preserve-symlinks flags must be present.
 *
 *  · LIVE tests run ONLY on Windows and only when the operator opts in with
 *    WORDJS_TEST_APPCONTAINER=1, because they MUTATE the host: they register an AppContainer profile and
 *    add DACL entries. Everything they create is torn down in the same test, including the ACEs -- an
 *    earlier hand-run of this experiment left a stray ACE on a real machine, so the revoke path is not a
 *    nicety here, it is the thing under test.
 *
 * The live half also carries the evidence for the two findings the design rests on: that a
 * zero-capability AppContainer refuses the network (EACCES) and the out-of-zone read (EPERM) while the
 * fork IPC channel still round-trips, and that killing the relay kills the contained child.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sw = require('../core/sandbox-windows');

const IS_WIN = process.platform === 'win32';
const LIVE = IS_WIN && process.env.WORDJS_TEST_APPCONTAINER === '1';
const PROFILE = 'WordJSPluginSandboxTest';

// A code-point scan, not a regex: a character class covering tab/CR/LF puts literal control characters in
// the source, which the repo lint rejects (no-control-regex).
function isAscii(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13) continue;
        if (c < 0x20 || c > 0x7E) return false;
    }
    return true;
}

describe('sandbox-windows: generated script hygiene (all platforms)', () => {
    test('every generated PowerShell script is pure ASCII', () => {
        // PS 5.1 reads script text as ANSI. A smart quote or an accented character anywhere in these
        // builders breaks the parser, and the symptom is a launch that fails with no useful message.
        assert.ok(isAscii(sw.__buildRelayScript()), 'relay script must be ASCII');
        assert.ok(isAscii(sw.__buildJobCapsScript()), 'job caps script must be ASCII');
        assert.ok(isAscii(sw.__buildProfileScript('X', 'ensure')), 'profile script must be ASCII');
        assert.ok(isAscii(sw.__buildIcaclsScript('rx')), 'icacls script must be ASCII');
        // And the guard itself must actually catch a violation, or it is decoration.
        assert.strictEqual(isAscii('ok'), true);
        assert.strictEqual(isAscii('café'), false);
    });

    test('no caller input is ever interpolated into script text', () => {
        // Every input travels through the launcher environment (base64 where it is a list or a command
        // line), so a plugin slug or an operator-chosen profile name can never become PowerShell source.
        const hostile = 'evil"; Remove-Item C:\\ -Recurse; "';
        const s = sw.__buildProfileScript(hostile, 'ensure');
        assert.ok(!s.includes('Remove-Item'), 'profile name must not reach the script body');
        assert.ok(s.includes('$env:WJS_AC_NAME'), 'profile name must be read from the environment');
        const i = sw.__buildIcaclsScript('full');
        assert.ok(i.includes('$env:WJS_AC_SID') && i.includes('$env:WJS_AC_DIRS_B64'), 'icacls inputs must come from the environment');
    });

    test('the icacls principal uses ${sid}, not the $sid: scope-qualifier form', () => {
        // `"*$sid:(OI)(CI)(F)"` looks right and is wrong: PowerShell parses `$sid:` as a scope/drive
        // qualifier (the same syntax as $env:PATH), so the SID never expands, icacls is handed a malformed
        // principal, and the grant silently does nothing. This is the single highest-value assertion here.
        for (const mode of ['rx', 'full', 'revoke'] as const) {
            const s = sw.__buildIcaclsScript(mode);
            assert.ok(s.includes('${sid}'), `${mode}: must use the braced form`);
            assert.ok(!/\$sid:/.test(s), `${mode}: must never use the $sid: form`);
        }
    });

    test('rx and full map to the intended ACE, and revoke removes rather than grants', () => {
        assert.match(sw.__buildIcaclsScript('rx'), /\/grant .*\(OI\)\(CI\)\(RX\)/);
        assert.match(sw.__buildIcaclsScript('full'), /\/grant .*\(OI\)\(CI\)\(F\)/);
        const rev = sw.__buildIcaclsScript('revoke');
        assert.match(rev, /\/remove:g/);
        assert.ok(!rev.includes('/grant'), 'revoke must never grant');
    });

    test('the child argv carries BOTH preserve-symlinks flags', () => {
        // With neither, the child dies resolving its MAIN module (lstat "C:\" EPERM). With only
        // --preserve-symlinks-main, main loads and the first relative require() dies the same way.
        assert.deepStrictEqual(sw.APPCONTAINER_NODE_FLAGS, ['--preserve-symlinks-main', '--preserve-symlinks']);
    });

    test('Windows argv quoting round-trips paths with spaces and embedded quotes', () => {
        assert.strictEqual(sw.__quoteWinArg('plain'), 'plain');
        assert.strictEqual(sw.__quoteWinArg('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
        // A backslash run only doubles when it precedes a quote -- the CommandLineToArgvW rule. Getting
        // this wrong mangles the worker path or the JSON config that rides in argv[2].
        assert.strictEqual(sw.__quoteWinArg('a\\\\b'), 'a\\\\b');
        assert.strictEqual(sw.__quoteWinArg('say "hi"'), '"say \\"hi\\""');
        const cl = sw.__buildCommandLine('C:\\Program Files\\nodejs\\node.exe', ['-e', 'console.log("x")']);
        assert.ok(cl.startsWith('"C:\\Program Files\\nodejs\\node.exe" '));
        assert.ok(cl.includes('\\"x\\"'));
    });

    test('the probe demands BOTH refusals and treats a mere failure to connect as NOT confinement', () => {
        // The probe child reports connect/read/write; the verdict logic lives in probeAppContainer. This
        // asserts the child actually gathers all three, so a future edit cannot quietly drop one leg.
        const src = sw.__probeChildSource;
        assert.ok(src.includes("connect(80,'1.1.1.1')"), 'must attempt a raw-IP socket, not a hostname (a DNS failure is not confinement)');
        assert.ok(src.includes('readdirSync'), 'must attempt an out-of-zone read');
        assert.ok(src.includes('writeFileSync'), 'must attempt an in-zone write (a container no plugin can run in is not "active")');
        assert.ok(src.includes('process.send'), 'must report over the fork channel, proving the IPC relay works');
    });

    test('the relay script republishes the inherited IPC handle at fd 3 with FOPEN|FPIPE', () => {
        const s = sw.__buildRelayScript();
        assert.ok(s.includes('GetStartupInfoW'), 'must read its own STARTUPINFO to find the handle Node passed');
        assert.ok(s.includes('0x01, 0x01, 0x01, 0x09'), 'fd 3 must be flagged FOPEN|FPIPE (0x09) or the CRT will not expose it');
        assert.ok(s.includes('0x00020009'), 'must set PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES');
        assert.ok(s.includes('CapCount = 0'), 'the container must have ZERO capabilities -- internetClient would defeat the whole layer');
        assert.ok(s.includes('0x00002000'), 'must set JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so the contained child dies with the relay');
        assert.ok(s.includes('0x00000004'), 'must CREATE_SUSPENDED so the caps bind before the first instruction runs');
        assert.ok(s.includes('LOCALAPPDATA missing'), 'must explain error 203 rather than leaving the operator to bisect it again');
    });

    test('the extended Job Object caps set the fork-bomb and CPU-rate limits', () => {
        const s = sw.__buildJobCapsScript();
        assert.ok(s.includes('0x00000008'), 'JOB_OBJECT_LIMIT_ACTIVE_PROCESS (fork-bomb cap)');
        assert.ok(s.includes('0x00000100'), 'JOB_OBJECT_LIMIT_PROCESS_MEMORY');
        assert.ok(s.includes('SetInformationJobObject(j, 15'), 'JobObjectCpuRateControlInformation');
        assert.ok(s.includes('0x1 | 0x4'), 'CPU rate must be a HARD cap, not a scheduling weight');
        // The one-shot helper must NOT use KILL_ON_JOB_CLOSE: it exits immediately, and the job survives
        // only because a running assigned process keeps it alive. KILL_ON_JOB_CLOSE would kill the plugin.
        assert.ok(!s.includes('0x00002000'), 'the one-shot helper must not set KILL_ON_JOB_CLOSE');
    });

    test('the write zones mirror io-guard SAFE_WRITE_DIRS + the plugin own dir', () => {
        const zones = sw.appContainerZones('C:\\app', 'my-plugin');
        assert.ok(zones.write.includes(path.join('C:\\app', 'plugins', 'my-plugin')));
        for (const d of ['uploads', 'data', 'logs', 'os-tmp', 'themes']) {
            assert.ok(zones.write.includes(path.join('C:\\app', d)), `${d} must be writable`);
        }
        assert.ok(zones.readExec.includes('C:\\app'));
        const t = sw.appContainerZones('C:\\app', 'theme:aurora');
        assert.ok(t.write.includes(path.join('C:\\app', 'themes', 'aurora')), 'a theme isolate owns themes/<name>, not plugins/theme:<name>');
    });

    test('non-Windows callers get a clean refusal, never a half-applied grant', async () => {
        if (IS_WIN) return; // asserted on the platform where it matters below
        assert.strictEqual(await sw.probeAppContainer(), 'unsupported');
        assert.strictEqual(await sw.ensureAppContainerProfile(), null);
        assert.strictEqual(await sw.grantAppContainerAccess('S-1-15-2-1-2-3', ['/tmp'], 'rx'), false);
        assert.strictEqual(await sw.applyWindowsJobCaps(1234), false);
    });

    test('a non-AppContainer SID is refused outright', async () => {
        // Only ever an S-1-15-2-* package SID: handing icacls an arbitrary principal from a config file
        // would let a misconfiguration grant a real user full control of the app root.
        assert.strictEqual(await sw.grantAppContainerAccess('S-1-5-32-544', [os.tmpdir()], 'full'), false);
        assert.strictEqual(await sw.grantAppContainerAccess('', [os.tmpdir()], 'full'), false);
    });
});

// ── LIVE (Windows + explicit opt-in: these MUTATE the host) ──────────────────────────────────────

describe('sandbox-windows: live AppContainer on this host', { skip: !LIVE ? 'set WORDJS_TEST_APPCONTAINER=1 on Windows (this test registers an AppContainer profile and edits ACLs)' : false }, () => {
    let sid: string | null = null;
    const zones: string[] = [];

    after(async () => {
        // Leave NOTHING behind. Revoke first (while the paths still exist), then delete. The Node runtime
        // directory is revoked too: on an elevated host the grant below SUCCEEDS, and a test that adds a
        // permanent ACE to C:\Program Files\nodejs and walks away is exactly the trap this module exists
        // not to set.
        try { if (sid) await sw.revokeAppContainerAccess(sid, [path.dirname(process.execPath)]); } catch { /* */ }
        try { if (sid && zones.length) await sw.revokeAppContainerAccess(sid, zones); } catch { /* */ }
        for (const z of zones) { try { fs.rmSync(z, { recursive: true, force: true }); } catch { /* */ } }
        try { await sw.deleteAppContainerProfile(PROFILE); } catch { /* */ }
    });

    test('ensureAppContainerProfile is idempotent and returns a package SID', async () => {
        sid = await sw.ensureAppContainerProfile(PROFILE);
        assert.ok(sid, 'profile creation must succeed on Windows 11');
        assert.match(sid as string, /^S-1-15-2-[0-9-]+$/);
        // Second call takes the DERIVE path (CreateAppContainerProfile returns ERROR_ALREADY_EXISTS) and
        // must produce the identical SID -- otherwise every restart would orphan the previous grants.
        const again = await sw.ensureAppContainerProfile(PROFILE);
        assert.strictEqual(again, sid);
    });

    test('grant is idempotent and revoke actually removes the ACE', async () => {
        assert.ok(sid);
        const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-actest-'));
        zones.push(zone);
        fs.writeFileSync(path.join(zone, 'f.txt'), 'x');

        const hasAce = () => {
            const { execFileSync } = require('child_process');
            try { return String(execFileSync('icacls', [zone], { encoding: 'utf8' })).includes(sid as string); }
            catch { return false; }
        };

        assert.ok(!hasAce(), 'a fresh temp dir must not already name the SID');
        assert.strictEqual(await sw.grantAppContainerAccess(sid as string, [zone], 'full'), true);
        assert.ok(hasAce(), 'grant must add an ACE naming the package SID');
        // Idempotent: granting twice is not an error and does not accumulate.
        assert.strictEqual(await sw.grantAppContainerAccess(sid as string, [zone], 'full'), true);

        assert.strictEqual(await sw.revokeAppContainerAccess(sid as string, [zone]), true);
        assert.ok(!hasAce(), 'revoke must remove the ACE -- this is the stray-ACE trap the module exists not to leave');
        // Revoking again must also be clean, so a partial grant can always be undone.
        assert.strictEqual(await sw.revokeAppContainerAccess(sid as string, [zone]), true);
    });

    test('a missing directory is skipped, not fatal (the --bind-try tolerance)', async () => {
        assert.ok(sid);
        const missing = path.join(os.tmpdir(), 'wjs-ac-does-not-exist-' + process.pid);
        assert.strictEqual(await sw.grantAppContainerAccess(sid as string, [missing], 'rx'), true);
    });

    test('the contained child is refused the network AND the out-of-zone read, and still speaks fork IPC', async () => {
        assert.ok(sid);
        const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-aclive-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-acout-'));
        zones.push(zone, outside);
        fs.writeFileSync(path.join(outside, 'canary.txt'), 'canary');

        // NOTE: on a non-elevated account this grant FAILS (C:\Program Files\nodejs is owned by
        // TrustedInstaller) and the launch below still works, because CreateProcessW opens the image in
        // the LAUNCHER's context. The assertions after the launch are what decide, not this call.
        await sw.grantAppContainerAccess(sid as string, [path.dirname(process.execPath)], 'rx');
        await sw.grantAppContainerAccess(sid as string, [zone], 'full');

        const launched = await sw.launchInAppContainer({
            sid,
            exe: process.execPath,
            args: ['-e', sw.__probeChildSource],
            cwd: zone,
            env: {
                SystemRoot: process.env.SystemRoot as string,
                windir: process.env.windir as string,
                PATH: process.env.PATH as string,
                TEMP: zone, TMP: zone,
                WJS_PROBE_OUTSIDE: outside,
            },
            memoryBytes: 256 * 1024 * 1024,
            activeProcessLimit: 64,
        });

        const verdict: any = await new Promise((resolve) => {
            let got: any = null, done = false;
            const fin = () => { if (done) return; done = true; try { launched.child.kill(); } catch { /* */ } resolve(got); };
            launched.child.on('message', (m: any) => { got = m; fin(); });
            launched.child.on('exit', () => setTimeout(fin, 100));
            const t = setTimeout(fin, 40000); if ((t as any).unref) (t as any).unref();
        });
        try { if (launched.pidFileDir) fs.rmSync(launched.pidFileDir, { recursive: true, force: true }); } catch { /* */ }

        assert.ok(verdict, 'the contained child must reach the host over the relayed fork channel');
        assert.strictEqual(verdict.ipc, true, 'process.send must exist inside the container -- no protocol change was needed');
        // A PERMISSION error, not merely "did not connect": ENOTFOUND/ETIMEDOUT is what an offline box
        // produces, and accepting it would let a machine with no internet look like a confined one.
        assert.ok(['EACCES', 'EPERM'].includes(verdict.connect), `outbound socket must be refused by the kernel, got ${verdict.connect}`);
        assert.ok(['EPERM', 'EACCES'].includes(verdict.read), `out-of-zone read must be refused, got ${verdict.read}`);
        assert.strictEqual(verdict.write, 'OK', 'the granted zone must stay writable or no plugin could run');
        assert.ok(launched.containedPid && launched.containedPid > 0, 'the contained pid must be reported (child.pid is the relay)');
        assert.notStrictEqual(launched.containedPid, launched.relayPid, 'contained pid and relay pid are different processes');
    });

    test('killing the relay kills the contained child (the --die-with-parent equivalent)', async () => {
        assert.ok(sid);
        const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-ackill-'));
        zones.push(zone);
        await sw.grantAppContainerAccess(sid as string, [zone], 'full');

        const launched = await sw.launchInAppContainer({
            sid,
            exe: process.execPath,
            args: ['-e', 'if(process.send)process.send("up");setInterval(function(){},1e9)'],
            cwd: zone,
            env: { SystemRoot: process.env.SystemRoot as string, windir: process.env.windir as string, PATH: process.env.PATH as string, TEMP: zone, TMP: zone },
        });
        await new Promise((r) => { launched.child.on('message', r); setTimeout(r, 20000); });
        const pid = launched.containedPid;
        assert.ok(pid && pid > 0, 'need the contained pid to observe its death');

        launched.child.kill();
        // The kernel closes the relay's last job handle, KILL_ON_JOB_CLOSE fires, the contained node dies.
        let alive = true;
        for (let i = 0; i < 80 && alive; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try { process.kill(pid as number, 0); } catch { alive = false; }
        }
        try { if (launched.pidFileDir) fs.rmSync(launched.pidFileDir, { recursive: true, force: true }); } catch { /* */ }
        assert.strictEqual(alive, false, 'the contained child must not outlive the relay -- an orphan keeps the plugin registered against a dead isolate');
    });

    test('extended Job Object caps apply to a real process on this host', async () => {
        const { spawn } = require('child_process');
        const p = spawn(process.execPath, ['-e', 'setTimeout(function(){},25000)'], { windowsHide: true, stdio: 'ignore' });
        try {
            const ok = await sw.applyWindowsJobCaps(p.pid, { memoryBytes: 256 * 1024 * 1024, activeProcessLimit: 64, cpuPercent: 50 });
            assert.strictEqual(ok, true, 'memory + fork-bomb + CPU caps must all apply in one job');
        } finally { try { p.kill(); } catch { /* */ } }
    });
});
