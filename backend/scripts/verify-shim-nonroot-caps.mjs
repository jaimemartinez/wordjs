#!/usr/bin/env node
/**
 * Certify, on a REAL Linux kernel, that the Landlock/seccomp shim confines a process holding privilege
 * it may not have the AUTHORITY to shed in full - the shapes that took production sites down.
 *
 * THE INCIDENT. WordJS ran as an unprivileged user with systemd `AmbientCapabilities=CAP_NET_BIND_SERVICE`
 * so Node could listen on 443. The shim treated "holds any capability" as "is root" and ran root's
 * privilege drop - setgroups(), SECUREBITS, CAPBSET_DROP - which need CAP_SETGID/CAP_SETPCAP that such a
 * process does not have: `SHIM-FAIL: setgroups(clear): Operation not permitted`, exit 79, the probe went
 * 'degraded' and the fail-closed policy refused every plugin. Reproduced with setpriv, which builds that
 * exact credential shape:
 *
 *     setpriv --reuid=<user> --regid=<user> --clear-groups \
 *       --inh-caps=+net_bind_service --ambient-caps=+net_bind_service -- perl shim.pl <zone> 1 -- <child>
 *
 * THE SAME FAILURE FROM THE OTHER SIDE: ROOT without CAP_SETGID or CAP_SETPCAP (a root unit with
 * CapabilityBoundingSet=, a container with --cap-drop=ALL plus NET_BIND_SERVICE, SecureBits=
 * keep-caps-locked) died the same way while the shim chose root's steps from the uid. The shim now runs
 * each defence-in-depth step only when the process holds the capability for it.
 *
 * WHAT THIS RUNS, per case, each against a CONTROL:
 *   . control  - the same setpriv launch WITHOUT the shim. Its child must show the shape (the capability
 *                held, the uid, the cut bounding set...). Without that the confined leg would prove
 *                nothing: a setpriv that silently failed to build the shape would make the old shim pass.
 *   . confined - through the shim. It must exit 0 with no SHIM-FAIL, report the expected `privdrop=` path
 *                on its SHIM: line, and the child must see CapInh/CapPrm/CapEff/CapAmb all zero, the
 *                expected uid in every slot, NoNewPrivs 1 and Seccomp 2 (filter mode) - plus an empty
 *                bounding set and no supplementary groups wherever the shape had the authority to clear
 *                them.
 * Cases: the ambient capability (the incident); a setuid-root wrapper (real uid 0, effective uid
 * unprivileged); root with the bounding set cut to CAP_NET_BIND_SERVICE; root without CAP_SETPCAP; root
 * with SecureBits=keep-caps-locked; and a non-root service that DOES hold CAP_SETGID/CAP_SETPCAP, whose
 * groups and bounding set must still be cleared. Every case except the last exits 79 on the shim before
 * this fix; the last kept its groups on the intermediate version of it.
 *
 * PRIVILEGE. Building those shapes needs root. As root this drops to uid/gid 65534; as a normal user it
 * needs --sudo (passwordless `sudo -n`, as GitHub runners have) and drops back to the caller's own uid.
 * Nothing persistent is changed; the only files are a private temp dir, removed on exit.
 *
 * Exit codes: 0 certified, 1 a check failed, 2 cannot run here (not Linux, no perl/setpriv, no root and
 * no --sudo) - the reason is printed, so a caller can SKIP rather than pass.
 *
 * Usage: node backend/scripts/verify-shim-nonroot-caps.mjs [--sudo] [--shim=<path>] [--json=<path>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const useSudo = process.argv.includes('--sudo');
const shimSource = path.resolve(arg('shim') || path.join(scriptDir, 'landlock-seccomp-shim.pl'));
const jsonOut = arg('json');
const PERL = '/usr/bin/perl';
const CAP_NET_BIND_SERVICE = 10;

function cannotRun(reason) {
    console.log(`SKIP: ${reason}`);
    process.exit(2);
}

function which(cmd) {
    for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
        const p = path.join(dir, cmd);
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
    }
    return null;
}

if (process.platform !== 'linux') cannotRun(`this certifies Linux kernel behaviour; platform is ${process.platform}`);
if (!fs.existsSync(PERL)) cannotRun(`${PERL} is absent`);
const SETPRIV = which('setpriv');
if (!SETPRIV) cannotRun('setpriv (util-linux) is absent');
const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;
if (!isRoot && !useSudo) cannotRun('building a capability-holding non-root process needs root; run as root or pass --sudo');
if (!isRoot) {
    const probe = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' });
    if (probe.status !== 0) cannotRun(`--sudo was given but passwordless sudo is unavailable (${String(probe.stderr || probe.error || '').trim().slice(0, 160)})`);
}
if (!fs.existsSync(shimSource)) cannotRun(`no shim at ${shimSource}`);

// The identity the service runs as. As root: the conventional unprivileged 65534. Through sudo: the
// caller's own uid, which is exactly what a systemd User= service with AmbientCapabilities= looks like.
const uid = isRoot ? 65534 : process.getuid();
const gid = isRoot ? 65534 : process.getgid();

// A private, world-traversable temp dir: the shim (copied, byte-identical) must be readable and every
// ancestor of the zone searchable by `uid`, or the shim fails on realpath() for a reason unrelated to
// what is being certified.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-shim-caps-'));
const cleanup = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', cleanup);
fs.chmodSync(root, 0o755);
const shim = path.join(root, 'landlock-seccomp-shim.pl');
fs.copyFileSync(shimSource, shim);
fs.chmodSync(shim, 0o644);
const zone = path.join(root, 'zone');
fs.mkdirSync(zone);
fs.chmodSync(zone, 0o755);

// The child is the shell, using builtins only, so the one executable it needs is granted with
// --exec-root and nothing else on the system has to be readable for it to report.
const sh = fs.realpathSync('/bin/sh');
const CHILD = 'while read -r l; do case "$l" in Cap*|Uid*|Groups*|NoNewPrivs*|Seccomp:*) echo "$l";; esac; done < /proc/self/status';
const ZERO = '0000000000000000';
const CAP_SETGID = 6;
const CAP_SETPCAP = 8;

// Each case: the credential shape (setpriv flags), what its CONTROL must show for the shape to be real,
// and what the confined child must show. `privdrop` is the path the shim must report; `uidAfter` the uid
// every slot must hold; `bounding` whether CapBnd must be empty ('zero') or may stay ('kept' - only where
// the shape has no CAP_SETPCAP to empty it with); `groups` whether supplementary groups must be gone.
const CASES = [
    {
        name: 'non-root + ambient CAP_NET_BIND_SERVICE (systemd AmbientCapabilities=)',
        setpriv: [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--inh-caps=+net_bind_service', '--ambient-caps=+net_bind_service'],
        controlHolds: (s) => bitSet(s.CapAmb, CAP_NET_BIND_SERVICE) && s.uids[1] !== 0,
        controlWhat: 'CapAmb must carry CAP_NET_BIND_SERVICE and the euid must be non-zero',
        expect: { privdrop: 'caps', uidAfter: uid, bounding: 'kept' },
    },
    {
        name: 'setuid-root wrapper (real uid 0, effective uid unprivileged, full permitted set)',
        setpriv: ['--ruid=0', `--euid=${uid}`, `--regid=${gid}`, '--clear-groups'],
        // The control's child is the SHELL, and a shell whose real and effective uids differ resets
        // its euid to the real one - it is the shim's own view that matters, so the control reads the
        // shape through perl instead (see controlArgv below).
        controlHolds: (s) => s.uids[0] === 0 && s.uids[1] !== 0 && s.CapPrm !== ZERO,
        controlWhat: 'the real uid must be 0, the effective uid non-zero and CapPrm non-empty',
        controlViaPerl: true,
        expect: { privdrop: 'caps', uidAfter: uid, bounding: 'kept' },
    },
    {
        // The same EPERM as the incident, from the other side: root, but without the authority for the
        // defence-in-depth steps. Kubernetes "drop ALL, add NET_BIND_SERVICE", systemd
        // CapabilityBoundingSet=CAP_NET_BIND_SERVICE on a root unit.
        name: 'root with the bounding set cut to CAP_NET_BIND_SERVICE (no CAP_SETGID, no CAP_SETPCAP)',
        setpriv: ['--bounding-set=-all,+net_bind_service'],
        controlHolds: (s) => s.uids[1] === 0 && s.CapBnd === '0000000000000400' && !bitSet(s.CapEff, CAP_SETGID) && !bitSet(s.CapEff, CAP_SETPCAP),
        controlWhat: 'euid 0 with CapBnd exactly CAP_NET_BIND_SERVICE',
        expect: { privdrop: 'root-partial', uidAfter: 0, bounding: 'kept' },
    },
    {
        name: 'root without CAP_SETPCAP only (groups cleared, bounding set kept)',
        setpriv: ['--bounding-set=-setpcap', '--groups=0,4'],
        controlHolds: (s) => s.uids[1] === 0 && bitSet(s.CapEff, CAP_SETGID) && !bitSet(s.CapEff, CAP_SETPCAP) && s.groups.length > 0,
        controlWhat: 'euid 0 holding CAP_SETGID but not CAP_SETPCAP, with supplementary groups',
        expect: { privdrop: 'root-partial', uidAfter: 0, bounding: 'kept', groups: 'empty' },
    },
    {
        // systemd SecureBits=keep-caps-locked: a lock the shim's own request used to try to clear.
        name: 'root with SecureBits=keep-caps-locked',
        setpriv: ['--securebits=+keep_caps_locked', '--groups=0,4'],
        controlHolds: (s) => s.uids[1] === 0 && bitSet(s.CapEff, CAP_SETPCAP),
        controlWhat: 'euid 0 holding CAP_SETPCAP',
        expect: { privdrop: 'root', uidAfter: 0, bounding: 'zero', groups: 'empty' },
    },
    {
        // A non-root service that DOES hold CAP_SETGID/CAP_SETPCAP must still shed its groups and its
        // bounding set, as the shim always did for it.
        name: 'non-root holding CAP_SETGID + CAP_SETPCAP with supplementary groups',
        setpriv: [`--reuid=${uid}`, `--regid=${gid}`, `--groups=${gid},0`,
            '--inh-caps=+setgid,+setpcap,+net_bind_service', '--ambient-caps=+setgid,+setpcap,+net_bind_service'],
        controlHolds: (s) => s.uids[1] !== 0 && bitSet(s.CapAmb, CAP_SETGID) && bitSet(s.CapAmb, CAP_SETPCAP) && s.groups.includes(0),
        controlWhat: 'a non-zero euid holding CAP_SETGID and CAP_SETPCAP, in group 0',
        expect: { privdrop: 'caps', uidAfter: uid, bounding: 'zero', groups: 'empty' },
    },
];

function bitSet(hex, bit) {
    try { return ((BigInt(`0x${hex}`) >> BigInt(bit)) & 1n) === 1n; } catch { return false; }
}

function parseStatus(text) {
    const out = { uids: [], groups: [] };
    for (const line of String(text).split('\n')) {
        const m = /^(Cap\w+|NoNewPrivs|Seccomp):\s*(\S+)/.exec(line);
        if (m) out[m[1]] = m[2];
        const u = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
        if (u) out.uids = u.slice(1).map(Number);
        const g = /^Groups:(.*)$/.exec(line);
        if (g) out.groups = g[1].trim().split(/\s+/).filter(Boolean).map(Number);
    }
    return out;
}

function run(argv) {
    const [cmd, ...rest] = isRoot ? argv : ['sudo', '-n', ...argv];
    const r = spawnSync(cmd, rest, { encoding: 'utf8', timeout: 30000 });
    return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: r.error ? String(r.error.message || r.error) : null };
}

const report = { kernel: os.release(), arch: process.arch, shim: shimSource, uid, gid, viaSudo: !isRoot, cases: [] };
let failed = 0;
for (const c of CASES) {
    const controlArgv = c.controlViaPerl
        ? [SETPRIV, ...c.setpriv, '--', PERL, '-e', 'open my $f, "<", "/proc/self/status" or die; print grep { /^(Cap|Uid|Groups)/ } <$f>']
        : [SETPRIV, ...c.setpriv, '--', '/bin/sh', '-c', CHILD];
    const control = run(controlArgv);
    const confined = run([SETPRIV, ...c.setpriv, '--', PERL, shim, `--exec-root=${sh}`, zone, '1', '--', '/bin/sh', '-c', CHILD]);
    const cs = parseStatus(control.stdout);
    const s = parseStatus(confined.stdout);
    const e = c.expect;
    const problems = [];
    if (!c.controlHolds(cs)) problems.push(`CONTROL did not reproduce the shape (${c.controlWhat}); nothing below would be meaningful`);
    if (confined.status !== 0) problems.push(`the shim exited ${confined.status}`);
    if (/SHIM-FAIL/.test(confined.stderr)) problems.push('the shim printed SHIM-FAIL');
    if (!new RegExp(`^SHIM: .* privdrop=${e.privdrop}$`, 'm').test(confined.stderr)) problems.push(`the SHIM: line does not report privdrop=${e.privdrop}`);
    for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
        if (s[k] !== ZERO) problems.push(`${k} in the confined child is ${s[k] || 'missing'}`);
    }
    if (e.bounding === 'zero' && s.CapBnd !== ZERO) problems.push(`CapBnd in the confined child is ${s.CapBnd || 'missing'}, expected empty`);
    if (e.groups === 'empty' && s.groups.length) problems.push(`the confined child kept the supplementary groups ${s.groups.join(' ')}`);
    if (s.uids.length !== 4 || s.uids.some((x) => x !== e.uidAfter)) problems.push(`the confined child's uids are ${s.uids.join(' ') || 'missing'}, expected all ${e.uidAfter}`);
    if (s.NoNewPrivs !== '1') problems.push(`NoNewPrivs is ${s.NoNewPrivs || 'missing'}`);
    if (s.Seccomp !== '2') problems.push(`Seccomp is ${s.Seccomp || 'missing'} (2 = filter)`);
    if (problems.length) failed++;
    report.cases.push({ name: c.name, ok: problems.length === 0, problems, control, confined });
    console.log(`${problems.length ? 'FAIL' : 'OK  '} ${c.name}`);
    for (const p of problems) console.log(`     - ${p}`);
    console.log(`     control  stdout: ${control.stdout.trim().replace(/\n/g, ' | ')}`);
    console.log(`     confined stderr: ${confined.stderr.trim().replace(/\n/g, ' | ')}`);
    console.log(`     confined stdout: ${confined.stdout.trim().replace(/\n/g, ' | ')}`);
}
if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
