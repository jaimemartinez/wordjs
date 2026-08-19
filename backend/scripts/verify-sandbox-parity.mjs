#!/usr/bin/env node
/**
 * WordJS — cross-platform sandbox PARITY probe (Linux + macOS + Windows).
 *
 * READ-ONLY with respect to the operator's configuration: it changes nothing persistent except two
 * things it creates and removes itself — throwaway temp directories, and (Windows only) an AppContainer
 * profile named `WordJSSandboxParityProbe`, which is deleted again on the way out.
 *
 *   node backend/scripts/verify-sandbox-parity.mjs [--json=<path>]
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * backend/scripts/verify-sandbox-hardening.js certifies the LINUX floor (bwrap + seccomp + namespaces)
 * and exits 2 everywhere else, because until now there was nothing else to certify: on Windows and macOS
 * an isolated plugin got OS process separation, Node's permission model and the JS guards, and NOTHING at
 * the kernel level. This probe is the peer of that script for the platforms that gained a kernel floor:
 *
 *   linux   bubblewrap  — uid drop, dropped caps, no-new-privs, PID/IPC/UTS ns, read-only root,
 *                         seccomp-bpf denylist, and an EMPTY network namespace for non-network plugins.
 *   darwin  Seatbelt    — `sandbox-exec` with a deny-by-default profile: reads allowed, WRITES confined
 *                         to the plugin's own zones, network denied outright.
 *   win32   AppContainer— CreateProcessW + PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES carrying an
 *                         AppContainer SID with ZERO capabilities (no `internetClient`), so the child can
 *                         only touch objects whose ACL names its SID and cannot open a socket at all.
 *
 * THE DISCIPLINE (copied from backend/src/core/plugin-isolate.ts, deliberately)
 * ---------------------------------------------------------------------------
 * NOTHING here is inferred from `process.platform`, from a binary being on PATH, or from a flag being
 * accepted. Every layer is PROBE-GATED: a REAL child is launched under the REAL confinement and the layer
 * is reported ACTIVE only when that child is ACTUALLY REFUSED something it must be refused. Reporting
 * confinement that is not there is the "looks secure but isn't" state, which is strictly worse than
 * reporting none — see the comment above `sandboxHardeningState` in plugin-isolate.ts.
 *
 * Every refusal additionally carries a VACUITY CONTROL: the same child probe is run WITHOUT the
 * confinement and must get a DIFFERENT answer. A probe that "passes" because node is broken, because the
 * runner has no egress, or because the path did not exist proves nothing, and this file refuses to count
 * it. (That control is why the network check demands a denial code from the confined run AND the absence
 * of one from the unconfined run, rather than merely "the connection failed".)
 *
 * MIRROR CONTRACT
 * ---------------
 * Like verify-sandbox-hardening.js, this script re-implements the launch rather than importing core: it
 * must be runnable on a bare checkout, without ts-node, without config, before anything boots. That buys
 * independence and costs a drift risk — a probe can certify a primitive the product does not actually
 * use. `checkCoreWiring()` closes exactly that hole: it requires backend/src/core/ to reference the
 * primitive this platform just certified. Certifying AppContainer while core never creates one would be
 * the same "guard validates something other than what is used" defect this codebase has shipped before.
 *
 * EXIT CODES
 *   0  every layer REQUIRED on this platform is ACTIVE (and its control is non-vacuous)
 *   1  a required layer is missing, degraded, or could only be "proven" vacuously  -> this is the gate
 *   2  this platform is outside the probe's scope (not linux/darwin/win32) — nothing was certified
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const CORE_DIR = path.join(REPO_ROOT, 'backend', 'src', 'core');

// ── reporting vocabulary (same as verify-sandbox-hardening.js, so both scripts read alike) ──────────
let pass = 0, fail = 0, crit = 0;
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const ok = (m) => { say('  OK    ' + m); pass++; };
const no = (m, critical = true) => { say((critical ? '  FAIL  ' : '  warn  ') + m); fail++; if (critical) crit++; };
const info = (m) => say('  info  ' + m);

/** Layer ledger — what this host was asked to prove, and what it actually proved. */
const layers = [];
function layer(id, title, required) {
    const l = { id, title, required, status: 'not-probed', why: [] };
    layers.push(l);
    return {
        active: (why) => { l.status = 'active'; if (why) l.why.push(why); },
        absent: (why) => { l.status = 'absent'; if (why) l.why.push(why); },
        skipped: (why) => { l.status = 'skipped'; if (why) l.why.push(why); },
        note: (why) => l.why.push(why),
    };
}

// ── temp scaffolding ────────────────────────────────────────────────────────────────────────────────
// GRANT   — the one directory the confined child is ALLOWED to write (the analogue of a plugin's own
//           data zone). Also holds the child probe script and the JSON it writes back.
// OUTSIDE — a directory the child must NOT be able to write. Deliberately under the user's HOME and not
//           under the system temp dir: on Linux `--tmpfs /tmp` would make an out-of-zone /tmp path simply
//           not exist, and ENOENT is not a refusal — it is an absence, and counting it would be exactly
//           the vacuous pass this file exists to reject.
const cleanups = [];
function mkTemp(where, prefix) {
    const d = fs.mkdtempSync(path.join(where, prefix));
    cleanups.push(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } });
    return d;
}
process.on('exit', () => { for (const c of cleanups.reverse()) c(); });

/**
 * The ONE child probe, shared by all three platforms — which is what makes the parity claim structurally
 * comparable rather than three unrelated stories. It reports through its EXIT CODE (100 + bitmask) because
 * on Windows the AppContainer launch goes through CreateProcessW with handle inheritance OFF, so stdout is
 * not available; it also drops a result.json into the granted dir for human diagnostics.
 *
 *   bit 1  outbound TCP was REFUSED with a denial errno (not merely unreachable/timed out)
 *   bit 2  reading the user's home directory was refused
 *   bit 4  writing INSIDE the granted zone worked  (the "we did not break plugins" half)
 *   bit 8  writing OUTSIDE the granted zone was refused
 *
 * TIMEOUT / CONNECTED are deliberately NOT denial codes: an offline runner must not be able to fake a
 * network-confinement pass.
 */
const CHILD_PROBE_SRC = `'use strict';
const fs = require('fs'); const os = require('os'); const net = require('net'); const path = require('path');
const grant = process.argv[2]; const outside = process.argv[3];
const DENIED = ['EACCES', 'EPERM', 'EROFS', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EAFNOSUPPORT'];
const r = { node: process.version, platform: process.platform, pid: process.pid };
// Reported on every platform, ASSERTED only on Linux: an empty network namespace leaves the child with
// loopback and nothing else. Unlike the connect() below it needs no egress to be meaningful, so it proves
// the netns even on a runner that cannot reach the internet at all.
try { r.ifs = Object.keys(os.networkInterfaces()).sort(); } catch (e) { r.ifs = null; }
let mask = 0;
try { fs.writeFileSync(path.join(grant, 'inside.txt'), 'x'); r.writeInside = 'OK'; mask |= 4; }
catch (e) { r.writeInside = e.code || String(e && e.message); }
try { fs.writeFileSync(path.join(outside, 'outside.txt'), 'x'); r.writeOutside = 'OK'; }
catch (e) { r.writeOutside = e.code || String(e && e.message); if (DENIED.indexOf(r.writeOutside) >= 0) mask |= 8; }
try { fs.readdirSync(os.homedir()); r.readHome = 'OK'; }
catch (e) { r.readHome = e.code || String(e && e.message); if (DENIED.indexOf(r.readHome) >= 0) mask |= 2; }
let settled = false;
function fin(v) {
  if (settled) return; settled = true;
  r.net = v; if (DENIED.indexOf(v) >= 0) mask |= 1;
  r.mask = mask;
  try { fs.writeFileSync(path.join(grant, 'result.json'), JSON.stringify(r)); } catch (e) { /* granted zone may itself be denied */ }
  try { process.stdout.write('WJSPROBE ' + JSON.stringify(r) + '\\n'); } catch (e) { /* */ }
  process.exit(100 + mask);
}
let s = null;
try { s = net.connect(80, '1.1.1.1'); } catch (e) { return fin(e.code || 'THROW'); }
s.on('error', function (e) { try { s.destroy(); } catch (x) {} fin(e.code || 'ERR'); });
s.on('connect', function () { try { s.destroy(); } catch (x) {} fin('CONNECTED'); });
// Deliberately NOT unref'd: this timer is the only thing guaranteeing the child reaches fin() and exits
// with a mask. An unref'd timer would let the child exit 0 on an idle loop, and exit 0 decodes to "no mask
// -> nothing proven" — a self-inflicted vacuous result.
setTimeout(function () { try { s.destroy(); } catch (x) {} fin('TIMEOUT'); }, 6000);
`;

const MASK = { NET_DENIED: 1, HOME_DENIED: 2, WRITE_IN_OK: 4, WRITE_OUT_DENIED: 8 };
function decodeMask(m) {
    if (m === null) return 'no mask (the child never completed)';
    const on = [];
    if (m & MASK.NET_DENIED) on.push('net-refused');
    if (m & MASK.HOME_DENIED) on.push('home-unreadable');
    if (m & MASK.WRITE_IN_OK) on.push('in-zone-write-ok');
    if (m & MASK.WRITE_OUT_DENIED) on.push('out-of-zone-write-refused');
    return `mask=${m} [${on.join(' ') || 'nothing refused'}]`;
}
/** Turn a child exit code into the probe mask, or null when the child never reached its own exit path. */
function maskFromExit(code) {
    return (typeof code === 'number' && code >= 100 && code <= 115) ? code - 100 : null;
}
function readResultJson(grantDir) {
    try { return JSON.parse(fs.readFileSync(path.join(grantDir, 'result.json'), 'utf8')); } catch { return null; }
}

// ── VACUITY CONTROL — the same probe with NO confinement at all ─────────────────────────────────────
// Everything below compares against this. If the unconfined child is ALSO refused, the refusal says
// nothing about the sandbox and the corresponding check is failed as vacuous rather than passed.
function runControl(grantDir, outsideDir, probeJs) {
    const r = spawnSync(process.execPath, [probeJs, grantDir, outsideDir], { encoding: 'utf8', timeout: 30000 });
    return { mask: maskFromExit(r.status), status: r.status, json: readResultJson(grantDir), stderr: (r.stderr || '').trim() };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Node's permission model — the ONE layer that is supposed to exist on all three platforms, so it is the
// baseline the parity claim is measured against. Mirrors probePermissionModel() in plugin-isolate.ts:
// the flag name is PROBED (it was --experimental-permission on 20/22 before becoming --permission on
// 23.5+) and a build can ACCEPT a flag without ENFORCING it, so only an actually-refused read counts.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
function probePermissionModel() {
    const L = layer('permission-model', "Node permission model (C++-enforced, below JS)", true);
    const src = 'try{require("fs").readFileSync(process.execPath);console.log("OPEN")}'
        + 'catch(e){console.log(e&&e.code==="ERR_ACCESS_DENIED"?"DENIED":"OTHER:"+(e&&e.code))}';
    // Control first: without the flag the very same read must SUCCEED, or "DENIED" would prove nothing.
    const control = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 20000 });
    const controlOut = (control.stdout || '').trim();
    if (controlOut !== 'OPEN') {
        no(`permission model: control run could not read ${process.execPath} even UNCONFINED (got "${controlOut}") — the probe cannot distinguish enforcement from breakage`);
        L.absent('vacuous control: the unconfined read did not succeed');
        return;
    }
    for (const flag of ['--permission', '--experimental-permission']) {
        const r = spawnSync(process.execPath, [flag, `--allow-fs-read=${SCRIPT_DIR}`, '-e', src], { encoding: 'utf8', timeout: 20000 });
        const out = (r.stdout || '').trim();
        if (out === 'DENIED') {
            ok(`permission model ACTIVE via ${flag} (an ungranted read is refused with ERR_ACCESS_DENIED; the same read succeeds unconfined)`);
            L.active(`${flag}: ungranted read -> ERR_ACCESS_DENIED, control -> OPEN`);
            return;
        }
        info(`${flag}: child reported "${out || '(nothing)'}"${r.status === null ? ' (no exit status — killed?)' : ''}`);
    }
    no(`permission model NOT enforced by this Node (${process.version}) — neither --permission nor --experimental-permission refused an ungranted read`);
    L.absent('no flag produced ERR_ACCESS_DENIED');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// LINUX — bubblewrap + seccomp + network namespace.
// The seccomp program and the bwrap profile below MIRROR buildSeccompBpf()/bwrapProfile() in
// plugin-isolate.ts (and verify-sandbox-hardening.js, which is the deeper Linux-only probe). This leg is
// deliberately not a re-run of that script: it asserts the three things the PARITY story rests on —
// the confinement launches, seccomp is really in filter mode, and a non-network plugin really loses the
// network at the KERNEL level — in the same shape the macOS and Windows legs use.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const SECCOMP_ARCHES = {
    x64: { audit: 0xC000003E, x32: true, nr: [101, 246, 320, 175, 313, 176, 174, 177, 178, 321, 298, 323, 310, 311, 312, 248, 249, 250, 165, 166, 155, 167, 168, 169, 308, 304, 303, 180, 156, 425, 426, 427, 428, 429, 430, 431, 432, 433] },
    arm64: { audit: 0xC00000B7, nr: [117, 104, 294, 105, 273, 106, 280, 241, 282, 270, 271, 272, 217, 218, 219, 40, 39, 41, 224, 225, 142, 268, 265, 264, 425, 426, 427, 428, 429, 430, 431, 432, 433] },
};
function buildSeccompBpf(archKey) {
    const a = SECCOMP_ARCHES[archKey];
    if (!a) return null;
    const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06, KILL = 0x80000000, EPERM = 0x00050001, ALLOW = 0x7FFF0000;
    const X32 = 0x40000000; // x86_64 x32-ABI bit: deny the whole x32 range (native syscall nrs are all below it)
    const ins = (code, jt, jf, k) => { const b = Buffer.alloc(8); b.writeUInt16LE(code, 0); b.writeUInt8(jt, 2); b.writeUInt8(jf, 3); b.writeUInt32LE(k >>> 0, 4); return b; };
    const blocked = a.nr.slice().sort((x, y) => x - y);
    const bodyLen = (a.x32 ? 1 : 0) + blocked.length, E = 4 + bodyLen + 1;
    const out = [ins(LD, 0, 0, 4), ins(JEQ, 1, 0, a.audit), ins(RET, 0, 0, KILL), ins(LD, 0, 0, 0)];
    if (a.x32) out.push(ins(JGE, E - (out.length + 1), 0, X32));
    blocked.forEach((nr) => out.push(ins(JEQ, E - (out.length + 1), 0, nr)));
    out.push(ins(RET, 0, 0, ALLOW)); out.push(ins(RET, 0, 0, EPERM));
    return Buffer.concat(out);
}
function bwrapProfile(grantDir, denyNetwork) {
    return [
        '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
        ...(denyNetwork ? ['--unshare-net'] : []),
        '--uid', '65534', '--gid', '65534',
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
        '--bind', grantDir, grantDir,
        '--die-with-parent', '--new-session',
    ];
}

function probeLinux(grantDir, outsideDir, probeJs, control) {
    const base = layer('bwrap-hardening', 'bubblewrap confinement (uid drop, caps, no-new-privs, PID/IPC/UTS ns, read-only root)', true);
    const sec = layer('seccomp', 'seccomp-bpf syscall denylist', true);
    const netns = layer('netns', 'empty network namespace for a non-network plugin (--unshare-net)', true);

    const ver = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
    if (ver.error) {
        no('bubblewrap (bwrap) is not installed — install with `sudo apt-get install -y bubblewrap`');
        base.absent('bwrap binary missing'); sec.absent('bwrap binary missing'); netns.absent('bwrap binary missing');
        return;
    }
    info(`bwrap: ${(ver.stdout || '').trim()}`);

    const bpf = buildSeccompBpf(process.arch);
    let bpfFile = null;
    if (bpf) {
        bpfFile = path.join(grantDir, 'filter.bpf');
        fs.writeFileSync(bpfFile, bpf);
        info(`seccomp filter assembled for ${process.arch}: ${bpf.length / 8} BPF instructions, ${SECCOMP_ARCHES[process.arch].nr.length} syscalls denied (EPERM)`);
    } else {
        info(`arch ${process.arch} is not in the seccomp table (x64/arm64) — the seccomp layer cannot apply here`);
    }

    const runSync = (argv, denyNetwork = false) => {
        const fd = bpfFile ? fs.openSync(bpfFile, 'r') : -1;
        const stdio = fd >= 0 ? ['ignore', 'pipe', 'pipe', fd] : ['ignore', 'pipe', 'pipe'];
        const secArgs = fd >= 0 ? ['--seccomp', '3'] : [];
        const r = spawnSync('bwrap', [...secArgs, ...bwrapProfile(grantDir, denyNetwork), '--', ...argv], { stdio, encoding: 'utf8', timeout: 40000 });
        if (fd >= 0) { try { fs.closeSync(fd); } catch { /* */ } }
        return r;
    };

    const status = runSync(['cat', '/proc/self/status']);
    if (status.status !== 0 || !status.stdout) {
        no('the bwrap profile failed to launch: ' + ((status.stderr || '').trim() || `exit ${status.status}`));
        info('common cause: unprivileged user namespaces are disabled — `sudo sysctl -w kernel.unprivileged_userns_clone=1`');
        base.absent('profile did not launch'); sec.absent('profile did not launch'); netns.absent('profile did not launch');
        return;
    }
    const field = (n) => { const m = status.stdout.match(new RegExp('^' + n + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : undefined; };
    let baseOk = true;
    const req = (cond, good, bad) => { if (cond) ok(good); else { no(bad); baseOk = false; } };
    req(field('NoNewPrivs') === '1', 'NoNewPrivs = 1', `NoNewPrivs = ${field('NoNewPrivs')} (expected 1)`);
    req(field('CapEff') === '0000000000000000', 'CapEff = 0 (all Linux capabilities dropped)', `CapEff = ${field('CapEff')} (expected all-zero)`);
    req((runSync(['id', '-u']).stdout || '').trim() === '65534', 'uid inside the sandbox = 65534 (nobody)', 'uid inside the sandbox is not 65534 — the uid drop did not take');
    const nproc = parseInt((runSync(['sh', '-c', 'ls /proc | grep -c "^[0-9]"']).stdout || '0').trim(), 10);
    req(nproc > 0 && nproc <= 4, `PID namespace active (the child sees ${nproc} processes, not the host's table)`, `PID namespace: the child sees ${nproc} processes (expected 1-4)`);
    base[baseOk ? 'active' : 'absent'](`NoNewPrivs=${field('NoNewPrivs')} CapEff=${field('CapEff')} procs=${nproc}`);

    if (bpfFile) {
        if (field('Seccomp') === '2') { ok('seccomp filter ACTIVE (/proc/self/status Seccomp=2 = filter mode)'); sec.active('Seccomp=2'); }
        else { no(`seccomp = ${field('Seccomp')} (expected 2 = filter mode)`); sec.absent(`Seccomp=${field('Seccomp')}`); }
    } else {
        no(`seccomp cannot apply on arch ${process.arch} — hardening would run WITHOUT the syscall denylist`);
        sec.absent(`arch ${process.arch} has no BPF table`);
    }

    // --- the netns leg: the child probe, run through the SAME profile PLUS --unshare-net -------------
    const r = runSync([process.execPath, probeJs, grantDir, outsideDir], true);
    const mask = maskFromExit(r.status);
    const json = readResultJson(grantDir);
    info(`confined child (bwrap + seccomp + --unshare-net): exit=${r.status} ${decodeMask(mask)}`);
    if (json) info(`confined child detail: ${JSON.stringify(json)}`);
    if ((r.stderr || '').trim()) info(`confined child stderr: ${(r.stderr || '').trim().slice(0, 400)}`);
    assertConfinement({
        L: netns,
        name: 'bwrap --unshare-net',
        mask, control,
        require: ['net', 'writeIn', 'writeOut'],
        json,
    });

    // SECOND, INDEPENDENT proof of the same netns — and the one that still works on a host with no egress.
    // An empty network namespace leaves exactly one interface behind, so this distinguishes "the kernel
    // took the network away" from "the connection happened to fail", which a connect() alone cannot do.
    const confinedIfs = json && Array.isArray(json.ifs) ? json.ifs : null;
    const controlIfs = control.json && Array.isArray(control.json.ifs) ? control.json.ifs : null;
    if (!confinedIfs || !controlIfs) {
        no('bwrap --unshare-net: could not read the interface list from one of the children, so the netns could not be confirmed independently of the connect() result');
        netns.absent('interface list unavailable');
    } else if (confinedIfs.length === 1 && confinedIfs[0] === 'lo' && controlIfs.length > 1) {
        ok(`bwrap --unshare-net: the child sees ONLY loopback (${JSON.stringify(confinedIfs)}) while the unconfined control sees ${JSON.stringify(controlIfs)} — an empty network namespace, proven without needing any egress`);
        netns.note('confined interfaces = [lo]');
    } else {
        no(`bwrap --unshare-net: interfaces inside = ${JSON.stringify(confinedIfs)}, control = ${JSON.stringify(controlIfs)} (expected exactly ["lo"] inside and more outside)`);
        netns.absent(`interfaces inside = ${JSON.stringify(confinedIfs)}`);
    }
}

/**
 * The shared verdict step for a confined run. Kept in one place so the three platforms cannot drift into
 * three different standards of proof.
 *
 *   net       the confined child was refused outbound TCP AND the unconfined control was NOT
 *   writeIn   the confined child could still write its own zone (otherwise the layer breaks plugins)
 *   writeOut  the confined child was refused a write outside its zone AND the control was NOT
 *   home      the confined child was refused a read of the user's home AND the control was NOT
 */
function assertConfinement({ L, name, mask, control, require: want, json }) {
    if (mask === null) {
        no(`${name}: the confined child never reached its own exit path — nothing was proven`);
        L.absent('confined child did not complete');
        return;
    }
    let good = true;
    const c = control.mask === null ? 0 : control.mask;
    const check = (bit, label, detail) => {
        const confined = (mask & bit) !== 0;
        const unconfined = (c & bit) !== 0;
        if (confined && !unconfined) { ok(`${name}: ${label} (${detail})`); L.note(label); return; }
        if (confined && unconfined) { no(`${name}: ${label} — but the UNCONFINED control was refused too, so this proves nothing about the sandbox (vacuous)`); good = false; return; }
        no(`${name}: ${label} did NOT happen (${detail})`);
        good = false;
    };
    if (want.includes('net')) check(MASK.NET_DENIED, 'outbound TCP refused at the kernel level', `confined net=${json ? json.net : '?'} / control net=${control.json ? control.json.net : '?'}`);
    if (want.includes('writeOut')) check(MASK.WRITE_OUT_DENIED, 'a write OUTSIDE the granted zone refused', `confined=${json ? json.writeOutside : '?'} / control=${control.json ? control.json.writeOutside : '?'}`);
    if (want.includes('home')) check(MASK.HOME_DENIED, "a read of the user's home directory refused", `confined=${json ? json.readHome : '?'} / control=${control.json ? control.json.readHome : '?'}`);
    if (want.includes('writeIn')) {
        if (mask & MASK.WRITE_IN_OK) { ok(`${name}: writing INSIDE the granted zone still works — the layer does not break plugin storage`); L.note('in-zone write ok'); }
        else { no(`${name}: writing inside the granted zone FAILED (${json ? json.writeInside : '?'}) — this layer would break every plugin that stores anything`); good = false; }
    }
    L[good ? 'active' : 'absent'](decodeMask(mask) + ' vs control ' + decodeMask(control.mask));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// macOS — Seatbelt via `sandbox-exec`.
//
// The profile MIRRORS the shape of the Linux bwrap profile on purpose, because that is what makes this a
// parity layer rather than a different product: the root filesystem stays READABLE, writes are confined
// to the plugin's own zone, and the network is denied outright (the `--unshare-net` analogue). SBPL is
// last-match-wins, so the closing `(deny network*)` is the authority even though `(deny default)` already
// covers it — it is written explicitly so a reader never has to work that out.
//
// What this profile does NOT claim: read confinement. `(allow file-read*)` is deliberate and matches
// `--ro-bind / /` on Linux; the probe therefore does not assert that the home directory is unreadable on
// macOS, and the report says so rather than quietly counting a bit it never earned.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
function seatbeltProfile(grantDir) {
    return [
        '(version 1)',
        '(deny default)',
        '(allow process-fork)',
        '(allow process-exec)',
        '(allow sysctl-read)',
        '(allow mach-lookup)',
        '(allow ipc-posix-shm)',
        '(allow signal (target self))',
        '(allow pseudo-tty)',
        '(allow system-socket)', // AF_ROUTE/AF_SYSTEM: interface enumeration, NOT internet egress
        '(allow file-read*)',
        `(allow file-write* (subpath "${grantDir}"))`,
        '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
        '(allow file-ioctl (literal "/dev/dtracehelper") (literal "/dev/tty"))',
        '(deny network*)',
    ].join('\n') + '\n';
}

function probeMacos(grantDir, outsideDir, probeJs, control) {
    const L = layer('seatbelt', 'Seatbelt profile via sandbox-exec (writes confined to the plugin zone, network denied)', true);

    const which = spawnSync('/usr/bin/sandbox-exec', ['-h'], { encoding: 'utf8' });
    if (which.error && which.error.code === 'ENOENT') {
        no('/usr/bin/sandbox-exec is not present on this macOS — the Seatbelt layer cannot apply');
        L.absent('sandbox-exec missing');
        return;
    }
    // Seatbelt matches on the REAL path: /var and /tmp are symlinks into /private on macOS, and a profile
    // written against the symlinked path grants nothing. This one line is the difference between a working
    // write-zone and a layer that silently breaks every plugin's storage.
    let realGrant = grantDir;
    try { realGrant = fs.realpathSync(grantDir); } catch { /* */ }
    const profile = seatbeltProfile(realGrant);
    const profilePath = path.join(grantDir, 'wordjs-parity.sb');
    fs.writeFileSync(profilePath, profile);
    info('Seatbelt profile under test:\n' + profile.split('\n').map((l) => '        ' + l).join('\n').trimEnd());

    const r = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, probeJs, realGrant, outsideDir], { encoding: 'utf8', timeout: 60000 });
    const mask = maskFromExit(r.status);
    const json = readResultJson(grantDir);
    info(`confined child (sandbox-exec): exit=${r.status} ${decodeMask(mask)}`);
    if (json) info(`confined child detail: ${JSON.stringify(json)}`);
    if ((r.stderr || '').trim()) info(`confined child stderr: ${(r.stderr || '').trim().slice(0, 600)}`);
    if (mask === null) {
        info('a null mask here almost always means node could not BOOT under the profile — widen the allow rules above (start by comparing with `sandbox-exec -f <profile> /usr/bin/true`) rather than loosening the deny.');
    }
    // Reads are NOT confined by this profile, by design; say so instead of leaving a silent gap.
    info('this profile intentionally does NOT confine READS (the analogue of --ro-bind / / on Linux), so the home-directory read is reported but not required');
    assertConfinement({ L, name: 'Seatbelt', mask, control, require: ['net', 'writeIn', 'writeOut'], json });

    // The make-or-break plugin-compatibility check, same as verify-sandbox-hardening.js: a plugin child
    // talks to the host over a fork-style IPC channel in 'advanced' serialization mode. A confinement layer
    // that survives everything except that channel is a layer that cannot ship.
    return new Promise((resolve) => {
        const src = "if(!process.send){process.exit(3)}process.send('ok',function(){process.exit(0)});setTimeout(function(){process.exit(4)},6000)";
        let got = false, done = false;
        const fin = (v) => {
            if (done) return; done = true;
            if (v) { ok('Seatbelt: Node fork-style IPC survives the profile — the plugin bridge still works'); L.note('fork IPC survives'); }
            else { no('Seatbelt: Node fork-style IPC did NOT survive the profile — the plugin bridge would break, so this layer must not ship'); L.absent('fork IPC broken under the profile'); }
            resolve();
        };
        let c;
        try {
            c = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, '-e', src],
                { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', timeout: 30000 });
        } catch { return fin(false); }
        c.on('message', (m) => { if (m === 'ok') got = true; });
        c.on('error', () => fin(false));
        c.on('exit', (code) => fin(got && code === 0));
    });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WINDOWS — AppContainer with ZERO capabilities.
//
// A child launched with CreateProcessW + EXTENDED_STARTUPINFO_PRESENT carrying
// PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES (0x00020009) and a SECURITY_CAPABILITIES whose
// CapabilityCount is 0 gets NO `internetClient` capability, so every outbound socket is refused by the
// kernel (EACCES) — the closest Windows has to `--unshare-net` — and it can only touch objects whose ACL
// names its AppContainer SID, which is why the granted zone is opened with `icacls /grant *<SID>`.
//
// PowerShell 5.1 cannot marshal these structures itself, so — exactly like the Job Object helper in
// plugin-isolate.ts — the whole CreateProcess dance lives inside Add-Type C# behind ONE method, and the
// script text is kept ASCII-only (PS 5.1 reads script text as ANSI; a stray non-ASCII byte breaks the
// parser). It is handed over as -EncodedCommand (UTF-16LE base64) so quoting never enters the picture.
//
// LAUNCH DETAIL THAT COSTS AN AFTERNOON IF MISSED: running a .js file makes Node resolve the main
// module's realpath, which lstats every ancestor up to the drive root and fails inside an AppContainer
// with `EPERM: operation not permitted, lstat 'C:\'`. `--preserve-symlinks-main` skips that resolution
// and the child boots. The alternative — granting the AppContainer SID traverse rights on C:\, C:\Users,
// ... — also works and is deliberately NOT taken: it is a persistent, invasive change to the operator's
// machine, and a probe must not reshape the host it is measuring.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const AC_PROFILE_NAME = 'WordJSSandboxParityProbe';

function psRun(script, timeoutMs = 120000) {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
        { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
}
/**
 * Everything PowerShell said, minus the noise that would bury the signal.
 *
 * A non-interactive powershell.exe serializes its PROGRESS stream onto stderr as a `#< CLIXML` blob
 * ("Preparing modules for first use…" while Add-Type JITs). On a localized host that blob is also the only
 * non-ASCII text in the transcript. It is not an error and it is not a result — it is several hundred
 * characters of XML that pushed the actual `EXIT=`/`LASTERR=` line off the end of the diagnostic. Dropped
 * here rather than at the call sites so no future caller has to remember.
 */
function psText(r) {
    const raw = ((r.stdout || '') + '\n' + (r.stderr || ''));
    return raw.split(/\r?\n/).filter((l) => !l.startsWith('#< CLIXML') && !l.includes('<Objs Version=')).join('\n').trim();
}
/** Single-quoted PowerShell literal (no expansion); '' escapes a quote. Paths only — never plugin input. */
const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/**
 * Substitute one placeholder in a PowerShell template.
 *
 * The replacement is passed as a FUNCTION on purpose: String.replace treats `$&`, `$'` and `` $` `` inside
 * a replacement STRING as capture references, and these replacements are filesystem paths — a user whose
 * account is `C:\Users\me$'x` would otherwise get a silently mangled command line.
 */
const psFill = (tpl, placeholder, value) => tpl.replace(placeholder, () => value);

const PS_ENSURE_PROFILE = `$ErrorActionPreference='Stop'
try {
$sig=@'
using System;
using System.Runtime.InteropServices;
public static class WJSACProf {
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint capCount, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
  public static string Ensure(string name) {
    IntPtr sid = IntPtr.Zero;
    int hr = CreateAppContainerProfile(name, name, "WordJS sandbox parity probe", IntPtr.Zero, 0, out sid);
    if (hr != 0) {
      int hr2 = DeriveAppContainerSidFromAppContainerName(name, out sid);
      if (hr2 != 0) return "ERR:create=0x" + hr.ToString("X8") + " derive=0x" + hr2.ToString("X8");
    }
    IntPtr str = IntPtr.Zero;
    if (!ConvertSidToStringSidW(sid, out str)) return "ERR:ConvertSidToStringSid=" + Marshal.GetLastWin32Error();
    string s = Marshal.PtrToStringUni(str);
    LocalFree(str);
    return s;
  }
}
'@
Add-Type -TypeDefinition $sig
Write-Output ('SID=' + [WJSACProf]::Ensure(NAME_PLACEHOLDER))
exit 0
} catch { Write-Output ('ERR=' + $_.Exception.Message); exit 1 }
`;

const PS_LAUNCH = `$ErrorActionPreference='Stop'
try {
$sig=@'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WJSACRun {
  public static int LastError = 0;
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO { public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr lp, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr lp, uint flags, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeleteProcThreadAttributeList(IntPtr lp);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  public static int Launch(string sidStr, string exe, string cmdline, string cwd, uint waitMs) {
    LastError = 0;
    IntPtr sid = IntPtr.Zero; IntPtr attrList = IntPtr.Zero; IntPtr capsPtr = IntPtr.Zero; IntPtr size = IntPtr.Zero;
    if (!ConvertStringSidToSidW(sidStr, out sid)) { LastError = Marshal.GetLastWin32Error(); return -101; }
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attrList = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size)) { LastError = Marshal.GetLastWin32Error(); return -102; }
      SECURITY_CAPABILITIES sc = new SECURITY_CAPABILITIES();
      sc.AppContainerSid = sid; sc.Capabilities = IntPtr.Zero; sc.CapabilityCount = 0; sc.Reserved = 0;
      capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc));
      Marshal.StructureToPtr(sc, capsPtr, false);
      if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)0x00020009, capsPtr, (IntPtr)Marshal.SizeOf(sc), IntPtr.Zero, IntPtr.Zero)) { LastError = Marshal.GetLastWin32Error(); return -103; }
      STARTUPINFOEX si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.lpAttributeList = attrList;
      PROCESS_INFORMATION pi;
      StringBuilder cmd = new StringBuilder(cmdline);
      if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x08000000, IntPtr.Zero, cwd, ref si, out pi)) { LastError = Marshal.GetLastWin32Error(); return -104; }
      WaitForSingleObject(pi.hProcess, waitMs);
      uint code = 0; GetExitCodeProcess(pi.hProcess, out code);
      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
      return (int)code;
    } finally {
      if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); }
      if (capsPtr != IntPtr.Zero) { Marshal.FreeHGlobal(capsPtr); }
      if (sid != IntPtr.Zero) { LocalFree(sid); }
    }
  }
}
'@
Add-Type -TypeDefinition $sig
$r=[WJSACRun]::Launch(SID_PLACEHOLDER, EXE_PLACEHOLDER, CMD_PLACEHOLDER, CWD_PLACEHOLDER, 90000)
Write-Output ('EXIT=' + $r)
Write-Output ('LASTERR=' + [WJSACRun]::LastError)
exit 0
} catch { Write-Output ('ERR=' + $_.Exception.Message); exit 1 }
`;

const PS_DELETE_PROFILE = `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WJSACDel { [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeleteAppContainerProfile(string name); }
'@
[WJSACDel]::DeleteAppContainerProfile(NAME_PLACEHOLDER) | Out-Null
exit 0
`;

function probeWindows(grantDir, outsideDir, probeJs, control) {
    const L = layer('appcontainer', 'AppContainer with ZERO capabilities (no internetClient; ACL-scoped filesystem)', true);

    // 1. Ensure the AppContainer profile exists and learn its SID.
    const ensure = psRun(psFill(PS_ENSURE_PROFILE, 'NAME_PLACEHOLDER', psStr(AC_PROFILE_NAME)));
    const out1 = psText(ensure);
    const m = out1.match(/SID=(S-1-15-2-[0-9-]+)/);
    if (!m) {
        no('could not create or derive the AppContainer SID via CreateAppContainerProfile / DeriveAppContainerSidFromAppContainerName');
        info('PowerShell said: ' + (out1.slice(0, 800) || '(nothing)'));
        L.absent('no AppContainer SID');
        return;
    }
    const sid = m[1];
    cleanups.push(() => { try { psRun(psFill(PS_DELETE_PROFILE, 'NAME_PLACEHOLDER', psStr(AC_PROFILE_NAME)), 60000); } catch { /* */ } });
    ok(`AppContainer SID derived: ${sid} (profile "${AC_PROFILE_NAME}", deleted again when this probe exits)`);

    // 2. Open ONLY the granted zone to that SID. Everything else stays closed, which is the whole point:
    //    an AppContainer reaches exactly the objects whose ACL names its SID.
    const icacls = spawnSync('icacls', [grantDir, '/grant', `*${sid}:(OI)(CI)(F)`], { encoding: 'utf8', timeout: 60000 });
    if (icacls.status !== 0) {
        no(`icacls could not grant the AppContainer SID access to the write zone (exit ${icacls.status})`);
        info('icacls said: ' + ((icacls.stdout || '') + (icacls.stderr || '')).trim().slice(0, 600).replace(/\s+/g, ' '));
        L.absent('icacls grant failed');
        return;
    }
    info(`granted ${sid} full control of the write zone via icacls`);

    // 3. Launch the child INSIDE the container. --preserve-symlinks-main is load-bearing (see the header
    //    comment): without it Node lstats every ancestor of the main module up to C:\ and dies EPERM.
    const cmdline = `"${process.execPath}" --preserve-symlinks-main "${probeJs}" "${grantDir}" "${outsideDir}"`;
    let launchScript = PS_LAUNCH;
    launchScript = psFill(launchScript, 'SID_PLACEHOLDER', psStr(sid));
    launchScript = psFill(launchScript, 'EXE_PLACEHOLDER', psStr(process.execPath));
    launchScript = psFill(launchScript, 'CMD_PLACEHOLDER', psStr(cmdline));
    launchScript = psFill(launchScript, 'CWD_PLACEHOLDER', psStr(grantDir));
    const launch = psRun(launchScript);
    const out2 = psText(launch);
    info('AppContainer launch reported: ' + (out2.replace(/\s+/g, ' ').slice(0, 400) || '(nothing)'));
    const em = out2.match(/EXIT=(-?\d+)/);
    const lerr = (out2.match(/LASTERR=(\d+)/) || [])[1];
    const exitCode = em ? parseInt(em[1], 10) : null;

    if (exitCode !== null && exitCode < 0) {
        const stage = { '-101': 'ConvertStringSidToSid', '-102': 'InitializeProcThreadAttributeList', '-103': 'UpdateProcThreadAttribute(SECURITY_CAPABILITIES)', '-104': 'CreateProcessW' }[String(exitCode)] || 'unknown';
        no(`the AppContainer launch failed at ${stage} (Win32 error ${lerr || '?'})`);
        if (String(lerr) === '5') {
            info(`Win32 error 5 is ACCESS_DENIED. The usual cause is that node.exe itself is not readable/executable by the AppContainer SID:`);
            info(`  ${process.execPath}`);
            info('  An AppContainer can only reach objects whose ACL names its SID (or ALL APPLICATION PACKAGES). This probe deliberately does NOT widen that ACL for you — a probe must not reshape the host it is measuring, and a persistent grant on a Node install is exactly the kind of invasive change an operator should make knowingly, not discover.');
            info(`  To grant it by hand:  icacls "${path.dirname(process.execPath)}" /grant *${sid}:(OI)(CI)(RX)`);
        }
        L.absent(`launch failed at ${stage}, Win32 error ${lerr || '?'}`);
        return;
    }
    const mask = maskFromExit(exitCode);
    const json = readResultJson(grantDir);
    info(`confined child (AppContainer, CapabilityCount=0): exit=${exitCode} ${decodeMask(mask)}`);
    if (json) info(`confined child detail: ${JSON.stringify(json)}`);
    if (mask === null) {
        info('a mask outside 100..115 means the child never reached its own exit path — it did not boot. Check the exit code against Node/NTSTATUS values (0xC0000022 = STATUS_ACCESS_DENIED) and re-read the --preserve-symlinks-main note above.');
    }
    // On Windows the AppContainer confines READS as well (measured: readdir of the user profile -> EPERM),
    // so unlike the macOS profile this leg does assert it.
    assertConfinement({ L, name: 'AppContainer', mask, control, require: ['net', 'home', 'writeIn', 'writeOut'], json });
    info('NOT certified by this leg: fork-style IPC through the AppContainer. CreateProcessW is invoked here with handle inheritance OFF, so no IPC channel is passed; the plugin bridge must be certified by the launch path in backend/src/core/ itself, and this probe does not claim it.');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// DRIFT GUARD — is the primitive we just certified the one the PRODUCT actually uses?
//
// This script mirrors the launch instead of importing core (so it runs on a bare checkout). The cost of
// mirroring is drift: a green probe could certify a kernel primitive that backend/src/core/ never invokes,
// which is the same defect class as a guard that validates something other than what is used. So the
// markers below are looked for in core. This is a WIRING check, not a behaviour check — it says the
// product reaches for this primitive, not that it reaches for it correctly.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const CORE_MARKERS = {
    linux: [['--unshare-net'], ['--seccomp'], ['bwrap']],
    darwin: [['sandbox-exec'], ['(deny default)', 'deny default']],
    win32: [['AppContainerSid'], ['0x00020009', 'PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES'], ['--preserve-symlinks-main']],
};
function checkCoreWiring() {
    const L = layer('core-wiring', 'backend/src/core/ actually reaches for this platform\'s primitive', true);
    const wanted = CORE_MARKERS[process.platform];
    if (!wanted) { L.skipped('no marker set for this platform'); return; }
    let blob = '';
    // RECURSIVE on purpose: a platform module is as likely to land in core/sandbox/<os>.ts as directly in
    // core/, and a guard that only reads the top level would go green on an absence it simply never looked at.
    const slurp = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') slurp(p); continue; }
            if (!/\.(ts|js|mjs|cjs)$/.test(e.name)) continue;
            try { blob += fs.readFileSync(p, 'utf8') + '\n'; } catch { /* */ }
        }
    };
    try {
        slurp(CORE_DIR);
    } catch {
        no(`could not read ${CORE_DIR} — the drift guard cannot run, so nothing certified here can be tied to the product`);
        L.absent('core directory unreadable');
        return;
    }
    const missing = [];
    for (const alts of wanted) {
        if (!alts.some((a) => blob.includes(a))) missing.push(alts.join(' | '));
    }
    if (missing.length === 0) {
        ok(`core wiring present: backend/src/core/ references ${wanted.map((a) => a[0]).join(', ')}`);
        L.active(wanted.map((a) => a[0]).join(', '));
    } else {
        no(`core wiring MISSING: nothing in backend/src/core/ references ${missing.join(' / ')} — this probe may have certified a kernel primitive the product never uses`);
        L.absent('missing markers: ' + missing.join(' / '));
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// SELF-TEST (`--self-test`) — does the verdict function actually go RED?
//
// assertConfinement() is the single place where "the child was refused" becomes "the layer is ACTIVE", so
// it is also the single place where a mistake turns this whole gate into a status page that always says
// yes. A gate nobody has ever seen fail is not known to be a gate. This drives it with synthetic
// mask/control pairs and requires each one to land on the expected verdict — no host state, no children,
// milliseconds, and it runs on every platform leg before the real probes.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
function selfTest() {
    const CASES = [
        { name: 'fully confined vs open control', mask: 15, ctl: 0, want: 'active' },
        { name: 'nothing was refused at all', mask: 4, ctl: 0, want: 'absent' },
        { name: 'refused, but the CONTROL was refused too (vacuous)', mask: 15, ctl: 15, want: 'absent' },
        { name: 'network refused but in-zone write broken (would break plugins)', mask: 11, ctl: 0, want: 'absent' },
        { name: 'confined child never completed', mask: null, ctl: 0, want: 'absent' },
        { name: 'net refused only in the control (backwards)', mask: 14, ctl: 1, want: 'absent' },
    ];
    let bad = 0;
    console.log('== verdict self-test (no host state is touched) ==');
    for (const c of CASES) {
        const before = { pass, fail, crit, len: lines.length, layers: layers.length };
        const L = layer(`selftest-${c.name}`, 'synthetic', false);
        assertConfinement({
            L, name: 'selftest', mask: c.mask,
            control: { mask: c.ctl, json: {}, status: c.ctl === null ? null : 100 + c.ctl },
            require: ['net', 'home', 'writeIn', 'writeOut'], json: {},
        });
        const got = layers[layers.length - 1].status;
        // Roll the ledger back: the self-test must leave no trace in the real report.
        pass = before.pass; fail = before.fail; crit = before.crit;
        lines.length = before.len; layers.length = before.layers;
        if (got === c.want) console.log(`  OK    ${c.name} -> ${got}`);
        else { console.log(`  FAIL  ${c.name} -> ${got} (expected ${c.want})`); bad++; }
    }
    console.log(bad === 0
        ? '\nRESULT: PASS  the verdict function goes red on every way a layer can be absent, vacuous or plugin-breaking.'
        : `\nRESULT: FAIL  ${bad} case(s) did not reach the expected verdict — this gate cannot be trusted until fixed.`);
    process.exit(bad === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
    if (process.argv.includes('--self-test')) return selfTest();
    say('== WordJS sandbox PARITY probe ==');
    say(`platform: ${process.platform}   release: ${os.release()}   arch: ${process.arch}   node: ${process.version}`);
    say(`repo: ${REPO_ROOT}`);

    if (!['linux', 'darwin', 'win32'].includes(process.platform)) {
        say('\nThis probe covers linux, darwin and win32. Nothing was certified on this platform.');
        process.exit(2);
    }

    const GRANT = mkTemp(os.tmpdir(), 'wjs-parity-grant-');
    // OUTSIDE lives under HOME on purpose — see the note next to mkTemp().
    let outsideBase = os.homedir();
    try { fs.accessSync(outsideBase, fs.constants.W_OK); } catch { outsideBase = os.tmpdir(); info(`home is not writable; the out-of-zone directory falls back to ${outsideBase} (on Linux this weakens the out-of-zone check, because --tmpfs /tmp makes such a path merely ABSENT rather than refused)`); }
    const OUTSIDE = mkTemp(outsideBase, 'wjs-parity-outside-');
    const PROBE_JS = path.join(GRANT, 'child-probe.js');
    fs.writeFileSync(PROBE_JS, CHILD_PROBE_SRC);
    say(`\ngranted zone : ${GRANT}`);
    say(`out-of-zone  : ${OUTSIDE}`);

    say('\n-- vacuity control (the same child, NO confinement) --');
    const control = runControl(GRANT, OUTSIDE, PROBE_JS);
    info(`control child: exit=${control.status} ${decodeMask(control.mask)}`);
    if (control.json) info(`control detail: ${JSON.stringify(control.json)}`);
    if (control.stderr) info(`control stderr: ${control.stderr.slice(0, 400)}`);
    if (control.mask === null) {
        no('the UNCONFINED control child did not complete — every refusal measured below would be indistinguishable from breakage, so nothing can be certified on this host');
        report();
        return;
    }
    // Clear the artefacts the control left behind so the confined run starts from the same state.
    try { fs.rmSync(path.join(GRANT, 'result.json'), { force: true }); } catch { /* */ }
    try { fs.rmSync(path.join(OUTSIDE, 'outside.txt'), { force: true }); } catch { /* */ }

    say('\n-- cross-platform layer: Node permission model --');
    probePermissionModel();

    say(`\n-- kernel layer for ${process.platform} --`);
    if (process.platform === 'linux') probeLinux(GRANT, OUTSIDE, PROBE_JS, control);
    else if (process.platform === 'darwin') await probeMacos(GRANT, OUTSIDE, PROBE_JS, control);
    else await probeWindows(GRANT, OUTSIDE, PROBE_JS, control);

    say('\n-- drift guard --');
    checkCoreWiring();

    report();
})().catch((e) => {
    console.error('\nThe parity probe itself threw — that is a bug in this script, not a verdict about the host:');
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
});

function report() {
    say('\n-- layers --');
    for (const l of layers) {
        const tag = l.status === 'active' ? 'ACTIVE  ' : l.status === 'skipped' ? 'SKIPPED ' : 'MISSING ';
        const gate = l.required ? '(required here)' : '(optional)';
        say(`  ${tag} ${l.id.padEnd(18)} ${gate}  ${l.title}`);
        for (const w of l.why) say(`             - ${w}`);
    }
    const missingRequired = layers.filter((l) => l.required && l.status !== 'active');
    const verdict = (crit === 0 && missingRequired.length === 0) ? 'PASS' : 'FAIL';
    say(`\nRESULT: ${verdict}  (${pass} passed, ${fail} failed, ${crit} critical)`);
    if (verdict === 'PASS') {
        say(`Every confinement layer required on ${process.platform} was proven ACTIVE by a real child that was`);
        say('actually refused, and each refusal was checked against an unconfined control so none of them is vacuous.');
    } else {
        say(`NOT certified on ${process.platform}. Missing/degraded: ${missingRequired.map((l) => l.id).join(', ') || '(see the failures above)'}.`);
        say('Until a layer\'s probe passes on a host, WordJS must not claim that layer is present on that host —');
        say('a reported-but-absent floor is the "looks secure but isn\'t" state this whole design exists to avoid.');
    }
    // On a GitHub runner, put the WHOLE transcript on the job summary page. The point of this gate is the
    // REASONING, not the boolean: a red leg has to tell a human which child was launched, what it was
    // refused, and what the unconfined control got — without them expanding a log group to find out.
    if (process.env.GITHUB_STEP_SUMMARY) {
        try {
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
                `\n### Sandbox parity — ${process.platform}/${process.arch}: ${verdict}\n\n`
                + '```\n' + lines.join('\n').replace(/```/g, "'''") + '\n```\n');
        } catch { /* the summary is a courtesy, never a failure mode */ }
    }
    const jsonArg = process.argv.find((a) => a.startsWith('--json='));
    if (jsonArg) {
        const p = path.resolve(jsonArg.slice('--json='.length));
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify({
                platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
                verdict, pass, fail, critical: crit, layers, transcript: lines,
            }, null, 2));
            console.log(`\n(report written to ${p})`);
        } catch (e) { console.log(`\n(could not write the report to ${p}: ${e && e.message})`); }
    }
    process.exit(verdict === 'PASS' ? 0 : 1);
}
