#!/usr/bin/env node
/**
 * WordJS — sandbox kernel-hardening verification probe (LINUX ONLY).
 *
 * READ-ONLY: this changes NOTHING on the system. Run it inside a DISPOSABLE Linux box
 * (a throwaway VM / WSL2 / LXC), never on production.
 *
 *   sudo apt-get install -y bubblewrap   # once
 *   node backend/scripts/verify-sandbox-hardening.js
 *
 * It validates the EXACT bubblewrap (bwrap) profile that WordJS's opt-in kernel-hardening
 * layer (config.sandbox.useKernelHardening) will use to launch each isolated plugin child:
 *   - drop to an UNPRIVILEGED uid (nobody, 65534) via a rootless user namespace
 *   - drop ALL Linux capabilities
 *   - no-new-privs (cannot regain privileges via setuid binaries)
 *   - PID / IPC / UTS namespaces (can't see or signal host processes)
 *   - filesystem READ-ONLY everywhere except the plugin's own writable data dir + /tmp
 *   - NETWORK PRESERVED (network-granted plugins keep working; egress is still bounded
 *     by egress-guard at the socket layer)
 * AND — the make-or-break "won't break plugins" check — that a Node child's fork-style
 * IPC channel still works THROUGH the sandbox (serialization:'advanced', the same shape
 * plugin-isolate.ts uses). If the IPC fd doesn't survive bwrap, the feature must NOT ship
 * enabled — this probe is exactly what gates that.
 *
 * Exit code 0 only if every CRITICAL check passes. Paste the full output back.
 *
 * NOTE: a seccomp-bpf syscall denylist and Landlock path rules are a documented PHASE 2
 * (they need an arch-specific compiled BPF / kernel >=5.13); this probe verifies the v1
 * profile above, which already removes privileges/capabilities/visibility by construction.
 */
'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0, crit = 0;
const ok = (m) => { console.log('  ✅ ' + m); pass++; };
const no = (m, critical = true) => { console.log('  ❌ ' + m); fail++; if (critical) crit++; };
const info = (m) => console.log('  ℹ️  ' + m);

console.log('== WordJS sandbox kernel-hardening probe ==');
console.log(`platform: ${process.platform}   kernel: ${os.release()}   arch: ${process.arch}   node: ${process.version}`);

if (process.platform !== 'linux') {
    console.log('\nThis probe only applies to Linux (seccomp/landlock/uid-drop are Linux-kernel features).');
    console.log('On Windows/macOS the hardening layer is a no-op by design. Run this inside a Linux box.');
    process.exit(2);
}

// bwrap present?
const ver = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
if (ver.error) {
    console.log('\n❌ bubblewrap (bwrap) is not installed.');
    console.log('   Install it:  sudo apt-get install -y bubblewrap   (Debian/Ubuntu)');
    process.exit(2);
}
console.log(`bwrap: ${(ver.stdout || '').trim()}`);
try {
    const uns = fs.readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim();
    console.log(`unprivileged_userns_clone: ${uns}` + (uns === '0' ? '  (⚠ disabled — rootless userns may fail on this kernel)' : ''));
} catch { /* not all kernels expose this knob; absence is fine on modern kernels */ }

const DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-hard-'));
process.on('exit', () => { try { fs.rmSync(DATADIR, { recursive: true, force: true }); } catch { /* */ } });

// THE candidate v1 profile (keep in sync with plugin-isolate.ts when integrated).
const PROFILE = [
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--uid', '65534', '--gid', '65534',
    '--ro-bind', '/', '/',
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--bind', DATADIR, DATADIR,
    '--die-with-parent', '--new-session',
];
const run = (argv) => spawnSync('bwrap', [...PROFILE, '--', ...argv], { encoding: 'utf8' });

console.log('\n-- profile --');
console.log('  bwrap ' + PROFILE.join(' ') + ' -- <node>');

console.log('\n-- checks --');

// 1. Does the profile even launch?
const status = run(['cat', '/proc/self/status']);
if (status.status !== 0 || !status.stdout) {
    no('profile failed to run: ' + ((status.stderr || '').trim() || `exit ${status.status}`));
    info('most common cause: unprivileged user namespaces are disabled on this kernel.');
    info('fix (root):  sudo sysctl -w kernel.unprivileged_userns_clone=1   — or test on a kernel/VM that allows it.');
    console.log(`\nRESULT: FAIL  (${pass} passed, ${fail} failed, ${crit} critical)`);
    process.exit(1);
}
ok('profile launches');
const field = (name) => { const m = status.stdout.match(new RegExp('^' + name + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : undefined; };
const nnp = field('NoNewPrivs');
const capeff = field('CapEff');
const seccomp = field('Seccomp');
nnp === '1' ? ok('NoNewPrivs = 1 (cannot gain privileges via setuid)') : no(`NoNewPrivs = ${nnp} (expected 1)`);
capeff === '0000000000000000' ? ok('CapEff = 0 (all capabilities dropped)') : no(`CapEff = ${capeff} (expected all-zero)`);
const uidIn = (run(['id', '-u']).stdout || '').trim();
uidIn === '65534' ? ok('uid inside sandbox = 65534 (dropped to nobody)') : no(`uid inside = ${uidIn} (expected 65534)`);
info(`Seccomp field = ${seccomp || '0'} (0 = no BPF filter yet; the syscall denylist is phase 2)`);

// 2. PID namespace — should see almost no processes (not the host's).
const nproc = parseInt((run(['sh', '-c', 'ls /proc | grep -c "^[0-9]"']).stdout || '0').trim(), 10);
(nproc > 0 && nproc <= 4) ? ok(`PID namespace active (sees ${nproc} procs, not the host's)`) : no(`PID namespace: sees ${nproc} procs (expected 1-4)`);

// 3. Filesystem confinement: writable ONLY in the data dir.
run(['sh', '-c', `echo ok > ${DATADIR}/w`]).status === 0
    ? ok('data dir is writable (plugin storage works)')
    : no('data dir not writable (would break plugin storage)');
run(['sh', '-c', 'echo x > /etc/wjs-should-not-write']).status !== 0
    ? ok('/ is read-only outside the data dir (escape surface reduced)')
    : no('/etc is writable — filesystem NOT confined!');

// 4. CRITICAL: a Node child's fork-style IPC must survive the sandbox (else plugins break).
const childSrc = "if(!process.send){process.exit(3)}process.send('ok',function(){process.exit(0)});setTimeout(function(){process.exit(4)},6000)";
const ipcOk = (() => new Promise((resolve) => {
    let got = false, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
        child = spawn('bwrap', [...PROFILE, '--', process.execPath, '-e', childSrc],
            { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', timeout: 15000 });
    } catch (e) { return finish(false); }
    child.on('message', (m) => { if (m === 'ok') got = true; });
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(got && code === 0));
}))();

// 5. Network preserved (best-effort; only meaningful with internet). Non-critical.
const netOk = (() => new Promise((resolve) => {
    const src = "const d=require('dns');d.lookup('example.com',function(e){process.exit(e?5:0)})";
    let child, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try { child = spawn('bwrap', [...PROFILE, '--', process.execPath, '-e', src], { stdio: 'ignore', timeout: 10000 }); }
    catch { return finish(false); }
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
}))();

(async () => {
    (await ipcOk)
        ? ok("Node fork-style IPC SURVIVES the sandbox (serialization:'advanced') — plugins won't break")
        : no("Node IPC did NOT survive bwrap — the IPC fd was lost; feature must NOT ship enabled until fixed");
    (await netOk)
        ? ok('network works inside the sandbox (DNS resolves — network-granted plugins keep working)')
        : info('network/DNS test did not pass (offline box? non-critical — the profile keeps network by design)');

    console.log(`\nRESULT: ${crit === 0 ? 'PASS ✅' : 'FAIL ❌'}  (${pass} passed, ${fail} failed, ${crit} critical)`);
    console.log(crit === 0
        ? 'The v1 hardening profile works on this kernel. Paste this output back and I will wire it into\nplugin-isolate.ts as the opt-in, probe-gated, default-OFF layer.'
        : 'A CRITICAL check failed — paste the full output so I can adjust the profile before integrating.');
    process.exit(crit === 0 ? 0 : 1);
})();
