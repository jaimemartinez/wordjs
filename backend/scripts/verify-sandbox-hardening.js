#!/usr/bin/env node
/**
 * WordJS — sandbox kernel-hardening verification probe (LINUX ONLY).
 *
 * READ-ONLY: this changes NOTHING on the system. Run it inside the SAME kind of host you will enable
 * hardening on (it self-validates per host), never on production.
 *
 *   sudo apt-get install -y bubblewrap   # once
 *   node backend/scripts/verify-sandbox-hardening.js
 *
 * It validates the EXACT bubblewrap (bwrap) launch WordJS's opt-in kernel-hardening layer
 * (config.sandbox.useKernelHardening) uses for each isolated plugin child:
 *   - drop to an UNPRIVILEGED uid (nobody, 65534) in a rootless user namespace
 *   - drop ALL Linux capabilities + no-new-privs
 *   - PID / IPC / UTS namespaces (can't see or signal host processes)
 *   - filesystem READ-ONLY except a writable data dir + /tmp; NETWORK preserved (egress-guarded elsewhere)
 *   - a seccomp-bpf syscall DENYLIST (ptrace, mount, kexec, *_module, bpf, keyctl, userfaultfd, setns,
 *     process_vm_readv/writev, pivot_root, reboot, … -> EPERM), assembled in pure JS, applied via bwrap --seccomp
 * AND — the make-or-break "won't break plugins" check — that a Node child's fork-style IPC channel
 * (serialization:'advanced') still works THROUGH the full sandbox (incl. seccomp). If any critical check
 * fails the feature must NOT ship enabled (and the runtime probe gates exactly that).
 *
 * Exit code 0 only if every CRITICAL check passes. Paste the full output back.
 * (Landlock's filesystem-confinement goal is already met by the read-only mount namespace above; the
 * Landlock LSM itself would need a native dependency, so it is intentionally not used.)
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
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
    console.log('\nThis probe only applies to Linux (seccomp/uid-drop/namespaces are Linux-kernel features).');
    console.log('On Windows/macOS the hardening layer is a no-op by design. Run this inside a Linux box.');
    process.exit(2);
}
const ver = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
if (ver.error) {
    console.log('\n❌ bubblewrap (bwrap) is not installed.  Install:  sudo apt-get install -y bubblewrap');
    process.exit(2);
}
console.log(`bwrap: ${(ver.stdout || '').trim()}`);

// ---- seccomp cBPF denylist (must mirror plugin-isolate.ts buildSeccompBpf) -----------------------
const SECCOMP_ARCHES = {
    x64: { audit: 0xC000003E, x32: true, nr: [101, 246, 320, 175, 313, 176, 174, 177, 178, 321, 298, 323, 310, 311, 312, 248, 249, 250, 165, 166, 155, 167, 168, 169, 308, 304, 303, 180, 156] },
    arm64: { audit: 0xC00000B7, nr: [117, 104, 294, 105, 273, 106, 280, 241, 282, 270, 271, 272, 217, 218, 219, 40, 39, 41, 224, 225, 142, 268, 265, 264] },
};
function buildSeccompBpf(archKey) {
    const a = SECCOMP_ARCHES[archKey];
    if (!a) return null;
    const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06, KILL = 0x80000000, EPERM = 0x00050001, ALLOW = 0x7FFF0000;
    const X32 = 0x40000000; // x86_64 x32-ABI bit: deny the whole x32 range (native syscalls are all below it, so Node is unaffected)
    const ins = (code, jt, jf, k) => { const b = Buffer.alloc(8); b.writeUInt16LE(code, 0); b.writeUInt8(jt, 2); b.writeUInt8(jf, 3); b.writeUInt32LE(k >>> 0, 4); return b; };
    const blocked = a.nr.slice().sort((x, y) => x - y);
    const bodyLen = (a.x32 ? 1 : 0) + blocked.length, E = 4 + bodyLen + 1;
    const out = [ins(LD, 0, 0, 4), ins(JEQ, 1, 0, a.audit), ins(RET, 0, 0, KILL), ins(LD, 0, 0, 0)];
    if (a.x32) out.push(ins(JGE, E - (out.length + 1), 0, X32));
    blocked.forEach((nr) => out.push(ins(JEQ, E - (out.length + 1), 0, nr)));
    out.push(ins(RET, 0, 0, ALLOW)); out.push(ins(RET, 0, 0, EPERM));
    return Buffer.concat(out);
}

const DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-hard-'));
process.on('exit', () => { try { fs.rmSync(DATADIR, { recursive: true, force: true }); } catch { /* */ } });
const PROFILE = [
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--uid', '65534', '--gid', '65534',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--bind', DATADIR, DATADIR, '--die-with-parent', '--new-session',
];

const bpf = buildSeccompBpf(process.arch);
let BPF_FILE = null;
if (bpf) {
    BPF_FILE = path.join(DATADIR, 'filter.bpf');
    fs.writeFileSync(BPF_FILE, bpf);
    ok(`seccomp filter assembled for ${process.arch}: ${bpf.length / 8} BPF instructions, ${SECCOMP_ARCHES[process.arch].nr.length} syscalls denied (EPERM)`);
} else {
    info(`arch ${process.arch} not in the seccomp table (x64/arm64) — hardening would apply WITHOUT seccomp here`);
}

// run bwrap with the full profile + seccomp (fd at child index 3 for sync, 4 when IPC present)
function runSync(argv) {
    const fd = BPF_FILE ? fs.openSync(BPF_FILE, 'r') : -1;
    const stdio = fd >= 0 ? ['ignore', 'pipe', 'pipe', fd] : ['ignore', 'pipe', 'pipe'];
    const sec = fd >= 0 ? ['--seccomp', '3'] : [];
    const r = spawnSync('bwrap', [...sec, ...PROFILE, '--', ...argv], { stdio, encoding: 'utf8', timeout: 15000 });
    if (fd >= 0) try { fs.closeSync(fd); } catch { /* */ }
    return r;
}

console.log('\n-- checks --');
const status = runSync(['cat', '/proc/self/status']);
if (status.status !== 0 || !status.stdout) {
    no('profile failed to run: ' + ((status.stderr || '').trim() || `exit ${status.status}`));
    info('common cause: unprivileged user namespaces disabled. fix (root): sudo sysctl -w kernel.unprivileged_userns_clone=1');
    console.log(`\nRESULT: FAIL  (${pass} passed, ${fail} failed, ${crit} critical)`); process.exit(1);
}
ok('profile launches');
const field = (n) => { const m = status.stdout.match(new RegExp('^' + n + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : undefined; };
field('NoNewPrivs') === '1' ? ok('NoNewPrivs = 1') : no(`NoNewPrivs = ${field('NoNewPrivs')} (expected 1)`);
field('CapEff') === '0000000000000000' ? ok('CapEff = 0 (all capabilities dropped)') : no(`CapEff = ${field('CapEff')} (expected all-zero)`);
(runSync(['id', '-u']).stdout || '').trim() === '65534' ? ok('uid inside = 65534 (nobody)') : no('uid inside != 65534');
if (BPF_FILE) field('Seccomp') === '2' ? ok('seccomp filter ACTIVE (/proc/self/status Seccomp=2 = filter mode)') : no(`Seccomp = ${field('Seccomp')} (expected 2)`);
const nproc = parseInt((runSync(['sh', '-c', 'ls /proc | grep -c "^[0-9]"']).stdout || '0').trim(), 10);
(nproc > 0 && nproc <= 4) ? ok(`PID namespace active (sees ${nproc} procs)`) : no(`PID ns: sees ${nproc} procs (expected 1-4)`);
runSync(['sh', '-c', `echo x > ${DATADIR}/w`]).status === 0 ? ok('data dir writable (plugin storage works)') : no('data dir not writable');
runSync(['sh', '-c', 'echo x > /etc/wjs-no']).status !== 0 ? ok('/ read-only outside the data dir') : no('/etc writable — fs not confined!');

(async () => {
    const ipcSrc = "if(!process.send){process.exit(3)}process.send('ok',function(){process.exit(0)});setTimeout(function(){process.exit(4)},6000)";
    const runIpc = (extraArgs) => new Promise((res) => {
        const fd = BPF_FILE ? fs.openSync(BPF_FILE, 'r') : -1;
        const stdio = fd >= 0 ? ['ignore', 'inherit', 'pipe', 'ipc', fd] : ['ignore', 'inherit', 'pipe', 'ipc'];
        const sec = fd >= 0 ? ['--seccomp', '4'] : [];
        let got = false, done = false; const fin = (v) => { if (!done) { done = true; try { if (fd >= 0) fs.closeSync(fd); } catch { } res(v); } };
        let c; try { c = spawn('bwrap', [...sec, ...PROFILE, '--', ...extraArgs], { stdio, serialization: 'advanced', timeout: 15000 }); } catch { return fin(false); }
        c.on('message', (m) => { if (m === 'ok') got = true; });
        c.on('error', () => fin(false)); c.on('exit', (code) => fin(got && code === 0));
    });
    (await runIpc([process.execPath, '-e', ipcSrc]))
        ? ok("Node fork-style IPC SURVIVES the full sandbox (incl. seccomp) — plugins won't break")
        : no('Node IPC did NOT survive — feature must NOT ship enabled until fixed');

    const netOk = await new Promise((res) => {
        const fd = BPF_FILE ? fs.openSync(BPF_FILE, 'r') : -1;
        const stdio = fd >= 0 ? ['ignore', 'ignore', 'ignore', fd] : 'ignore';
        const sec = fd >= 0 ? ['--seccomp', '3'] : [];
        let c; try { c = spawn('bwrap', [...sec, ...PROFILE, '--', process.execPath, '-e', "require('dns').lookup('example.com',e=>process.exit(e?5:0))"], { stdio, timeout: 10000 }); }
        catch { return res(false); }
        c.on('error', () => res(false)); c.on('exit', (code) => { try { if (fd >= 0) fs.closeSync(fd); } catch { } res(code === 0); });
    });
    netOk ? ok('network/DNS works inside the sandbox (socket syscalls allowed under seccomp)') : info('network/DNS test did not pass (offline box?) — non-critical');

    console.log(`\nRESULT: ${crit === 0 ? 'PASS ✅' : 'FAIL ❌'}  (${pass} passed, ${fail} failed, ${crit} critical)`);
    console.log(crit === 0
        ? 'The full hardening profile (uid-drop + caps + no-new-privs + namespaces + RO-fs + seccomp) works on\nthis kernel and does not break Node. Safe to enable config.sandbox.useKernelHardening here.'
        : 'A CRITICAL check failed — do NOT enable hardening on this host until resolved; paste the output.');
    process.exit(crit === 0 ? 0 : 1);
})();
