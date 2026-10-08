/**
 * The privilege the BACKEND PROCESS ITSELF holds: the boot warning and GET /health/details
 * `sandbox.hostPrivilege` (core/host-privilege.ts).
 *
 * THE INCIDENT. A site ran WordJS as an unprivileged user with systemd
 * `AmbientCapabilities=CAP_NET_BIND_SERVICE`. Nothing reported it, and it is what broke the plugin
 * sandbox there (the shim mistook the capability for root). The shim is fixed; this surface makes the
 * condition itself visible, names where it came from, and says how to remove it.
 *
 * The status texts below are the kernel's own /proc/self/status lines, captured on a 7.0 kernel for each
 * shape (setpriv built them: ambient, file capability via setcap, root). The diagnosis is a pure function
 * of that text plus the sandbox's measured state, so every row runs on every host - and the rows that
 * matter most are the ones about what may be CLAIMED: "the sandbox drops this for plugins" only when the
 * probe is active, and "this is the cause" of a degraded sandbox only when the probe's shim line names a
 * privilege-drop step.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');

const hp = require('../core/host-privilege');

const status = (o: { uid?: number; ruid?: number; uids?: number[]; inh?: string; prm?: string; eff?: string; bnd?: string; amb?: string | null }) => [
    'Name:\tnode',
    'Umask:\t0022',
    'State:\tR (running)',
    `Uid:\t${(o.uids || [o.ruid ?? o.uid ?? 999, o.uid ?? 999, o.uid ?? 999, o.uid ?? 999]).join('\t')}`,
    'Gid:\t990\t990\t990\t990',
    `CapInh:\t${o.inh ?? '0000000000000000'}`,
    `CapPrm:\t${o.prm ?? '0000000000000000'}`,
    `CapEff:\t${o.eff ?? '0000000000000000'}`,
    `CapBnd:\t${o.bnd ?? '000001ffffffffff'}`,
    ...(o.amb === null ? [] : [`CapAmb:\t${o.amb ?? '0000000000000000'}`]),
    'NoNewPrivs:\t0',
    '',
].join('\n');

// The incident's credentials, as the kernel reported them for `setpriv --reuid=wjscap
// --inh-caps=+net_bind_service --ambient-caps=+net_bind_service`.
const INCIDENT = status({ inh: '0000000000000400', prm: '0000000000000400', eff: '0000000000000400', amb: '0000000000000400' });
const FILE_CAPS = status({ prm: '0000000000000400', eff: '0000000000000400' });
const ROOT = status({ uid: 0, prm: '000001ffffffffff', eff: '000001ffffffffff' });
const NONE = status({});
// Root with a cut bounding set, as the kernel reported them on 7.0: `systemd-run -p
// CapabilityBoundingSet=CAP_NET_BIND_SERVICE` (Kubernetes "drop ALL, add NET_BIND_SERVICE" is the same
// shape) and `setpriv --bounding-set=-all` (Docker --cap-drop=ALL).
const ROOT_NET_BIND_ONLY = status({ uid: 0, prm: '0000000000000400', eff: '0000000000000400', bnd: '0000000000000400' });
const ROOT_NO_CAPS = status({ uid: 0, bnd: '0000000000000000' });
// A setuid-root wrapper / seteuid() from a root start: `setpriv --ruid=0 --euid=999` gave exactly this.
const SETUID_WRAPPER = status({ uids: [0, 999, 999, 999], prm: '000001ffffffffff' });
const PRIV_DROP_FAILURE = 'SHIM-FAIL: setgroups(clear): Operation not permitted';

describe('the capability table and the parser', () => {
    test('bit names match `capsh --decode=000001ffffffffff` on a 7.0 kernel, in bit order', () => {
        const capsh = 'cap_chown,cap_dac_override,cap_dac_read_search,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,cap_setpcap,cap_linux_immutable,cap_net_bind_service,cap_net_broadcast,cap_net_admin,cap_net_raw,cap_ipc_lock,cap_ipc_owner,cap_sys_module,cap_sys_rawio,cap_sys_chroot,cap_sys_ptrace,cap_sys_pacct,cap_sys_admin,cap_sys_boot,cap_sys_nice,cap_sys_resource,cap_sys_time,cap_sys_tty_config,cap_mknod,cap_lease,cap_audit_write,cap_audit_control,cap_setfcap,cap_mac_override,cap_mac_admin,cap_syslog,cap_wake_alarm,cap_block_suspend,cap_audit_read,cap_perfmon,cap_bpf,cap_checkpoint_restore';
        assert.deepStrictEqual(hp.capabilityNames(BigInt('0x000001ffffffffff')), capsh.toUpperCase().split(','));
    });
    test('a bit newer than the table is named by number, never dropped', () => {
        assert.deepStrictEqual(hp.capabilityNames((BigInt(1) << BigInt(45)) | BigInt(0x400)), ['CAP_NET_BIND_SERVICE', 'CAP_45']);
    });
    test('the parser needs the three mandatory sets; CapAmb and CapBnd are optional', () => {
        const p = hp.parseProcStatus(INCIDENT);
        assert.strictEqual(p.ambient, BigInt(0x400));
        assert.deepStrictEqual(p.uids, [999, 999, 999, 999]);
        assert.strictEqual(hp.parseProcStatus(status({ amb: null })).ambient, null);
        assert.strictEqual(hp.parseProcStatus('Name:\tnode\nCapPrm:\t0\n'), null);
        assert.strictEqual(hp.parseProcStatus(undefined), null);
    });
});

describe('diagnoseHostPrivilege — cause, what the sandbox does, and the fix', () => {
    const d = (statusText: string | null, more: Record<string, any> = {}) =>
        hp.diagnoseHostPrivilege({ platform: 'linux', statusText, sandboxState: 'active', requireHardening: true, ...more });

    test('THE INCIDENT: an ambient CAP_NET_BIND_SERVICE is EXCESS, named, sourced and fixable', () => {
        const r = d(INCIDENT);
        assert.strictEqual(r.status, 'EXCESS');
        assert.strictEqual(r.source, 'ambient');
        assert.strictEqual(r.root, false);
        assert.strictEqual(r.uid, 999);
        assert.deepStrictEqual(r.capabilities, ['CAP_NET_BIND_SERVICE']);
        assert.deepStrictEqual(r.ambient, ['CAP_NET_BIND_SERVICE']);
        assert.match(r.cause, /AmbientCapabilities=/);
        assert.match(r.fix, /remove AmbientCapabilities=/);
        assert.match(r.fix, /net\.ipv4\.ip_unprivileged_port_start=80 in a file under \/etc\/sysctl\.d\//);
        assert.match(r.fix, /reverse proxy/);
        assert.strictEqual(r.message, `${r.cause} ${r.sandbox} ${r.fix}`);
    });

    test('ACTIVE sandbox: says plugins are protected — because the probe measured it — and that the core has too much', () => {
        const r = d(INCIDENT, { sandboxState: 'active' });
        assert.match(r.sandbox, /probe verified that isolated plugin processes start with empty capability sets/);
        assert.match(r.sandbox, /core process itself, however, runs with more privilege than it needs/);
    });

    test('DEGRADED by a privilege-drop failure: the failed STEP is named, and what avoids it', () => {
        // Not "this privilege is the likely cause": the same step fails for a root service that LACKS
        // CAP_SETGID, where the cause is a missing capability. True either way: a service that holds
        // nothing never runs the step.
        for (const text of [INCIDENT, ROOT_NET_BIND_ONLY]) {
            const r = d(text, { sandboxState: 'degraded', shimFailure: PRIV_DROP_FAILURE });
            assert.match(r.sandbox, /DEGRADED: its probe failed in the step that sheds the service's own privilege \(SHIM-FAIL: setgroups\(clear\): Operation not permitted\)/);
            assert.match(r.sandbox, /unprivileged user holding no capabilities never runs that step/);
            assert.ok(!/likely cause/.test(r.sandbox));
            assert.match(r.sandbox, /refused until the sandbox is active again/);
        }
    });

    test('DEGRADED for any OTHER reason: the capability is explicitly NOT blamed — a guess would be believed', () => {
        for (const shimFailure of [null, 'SHIM-FAIL: cannot grant the writable zone <path>']) {
            const r = d(INCIDENT, { sandboxState: 'degraded', shimFailure });
            assert.match(r.sandbox, /not the identified cause/);
            assert.ok(!/likely cause/.test(r.sandbox));
        }
    });

    test('with sandbox.requireHardening off and no sandbox, plugins INHERIT it — and the diagnosis says so', () => {
        for (const sandboxState of ['degraded', 'unsupported', 'disabled']) {
            const r = d(INCIDENT, { sandboxState, requireHardening: false });
            assert.match(r.sandbox, /start WITHOUT the sandbox and inherit/, sandboxState);
        }
        assert.match(d(INCIDENT, { sandboxState: 'unsupported' }).sandbox, /no active kernel sandbox on this host \(state 'unsupported'\)[\s\S]*refused/);
    });

    test('a probe that has not run yet is not claimed to have verified anything', () => {
        const r = d(INCIDENT, { sandboxState: 'unknown' });
        assert.match(r.sandbox, /has not been probed yet/);
        assert.ok(!/verified/.test(r.sandbox));
    });

    test('FILE capabilities (setcap on node): permitted without ambient is attributed to setcap', () => {
        const r = d(FILE_CAPS);
        assert.strictEqual(r.status, 'EXCESS');
        assert.strictEqual(r.source, 'file-capabilities');
        assert.match(r.cause, /FILE capabilities on the node binary/);
        assert.match(r.fix, /setcap -r/);
    });

    test('ROOT is EXCESS with its own fix', () => {
        const r = d(ROOT);
        assert.strictEqual(r.status, 'EXCESS');
        assert.strictEqual(r.source, 'root');
        assert.strictEqual(r.root, true);
        assert.match(r.fix, /dedicated unprivileged user/);
        assert.strictEqual(r.capabilities.length, 41);
        assert.match(r.cause, /holds every capability the system allows/);
    });

    test('ROOT with a cut bounding set is still root — and is not said to hold "every capability"', () => {
        const k8s = d(ROOT_NET_BIND_ONLY);
        assert.strictEqual(k8s.status, 'EXCESS');
        assert.strictEqual(k8s.source, 'root');
        assert.deepStrictEqual(k8s.capabilities, ['CAP_NET_BIND_SERVICE']);
        assert.ok(!/every capability/.test(k8s.cause), k8s.cause);
        assert.match(k8s.cause, /reduced capability set \(CAP_NET_BIND_SERVICE\)/);
        assert.match(k8s.cause, /still uid 0/);
        const none = d(ROOT_NO_CAPS);
        assert.strictEqual(none.status, 'EXCESS', 'uid 0 with no capability is still root identity');
        assert.match(none.cause, /reduced capability set \(none at all\)/);
    });

    test('ROOT with an active sandbox: capabilities are removed, the uid is NOT — and the text says so', () => {
        // The shim keeps uid 0 for root (root-owned application trees must stay usable), so a plugin keeps
        // the OWNER's access to root-owned files it can reach. "Drops this for plugins" would overclaim.
        const r = d(ROOT, { sandboxState: 'active' });
        assert.match(r.sandbox, /removes every capability from plugins/);
        assert.match(r.sandbox, /plugins still run as uid 0/);
        assert.ok(!/drops this for plugins/.test(r.sandbox));
    });

    test('a uid 0 LEFT BEHIND (setuid-root wrapper, seteuid from root) is its own source — never "file capabilities"', () => {
        const r = d(SETUID_WRAPPER);
        assert.strictEqual(r.status, 'EXCESS');
        assert.strictEqual(r.source, 'real-uid-root');
        assert.strictEqual(r.root, false);
        assert.match(r.cause, /real\/saved\/filesystem uids are 0\/999\/999/);
        assert.ok(!/setcap|getcap/.test(`${r.cause} ${r.fix}`), 'node carries no file capability here; the advice must not send the operator after one');
        assert.match(r.fix, /Start the service directly as the unprivileged user/);
        assert.match(r.sandbox, /collapses the real, saved and filesystem uids onto the effective one/);
        // The same with the uid 0 only in the saved and filesystem slots, and with EMPTY sets: still
        // root identity, which the shim itself treats as privileged.
        for (const uids of [[0, 999, 0, 999], [0, 999, 0, 0], [999, 999, 0, 999], [999, 999, 999, 0]]) {
            const e = d(status({ uids }));
            assert.strictEqual(e.status, 'EXCESS', uids.join(' '));
            assert.strictEqual(e.source, 'real-uid-root', uids.join(' '));
        }
    });

    test('nothing held is OK; an inheritable-only set is reported but not warned about', () => {
        const ok = d(NONE);
        assert.strictEqual(ok.status, 'OK');
        assert.deepStrictEqual(ok.capabilities, []);
        assert.strictEqual(ok.message, undefined);
        const inh = d(status({ inh: '0000000000000400' }));
        assert.strictEqual(inh.status, 'OK');
        assert.strictEqual(inh.source, 'inheritable-only');
        assert.match(inh.cause, /grants nothing by itself/);
    });

    test('unreadable credentials are UNKNOWN, and other platforms are NOT_APPLICABLE', () => {
        assert.strictEqual(d(null).status, 'UNKNOWN');
        assert.strictEqual(d('garbage').status, 'UNKNOWN');
        for (const platform of ['win32', 'darwin']) {
            assert.deepStrictEqual(hp.diagnoseHostPrivilege({ platform, statusText: INCIDENT }), { status: 'NOT_APPLICABLE' });
        }
    });
});

describe('the live surfaces', () => {
    test('GET /health/details carries sandbox.hostPrivilege for this host', () => {
        const SystemHealth = require('../core/system-health');
        const out = SystemHealth.checkSandbox();
        assert.ok(out.hostPrivilege && typeof out.hostPrivilege.status === 'string', JSON.stringify(out.hostPrivilege));
        if (process.platform === 'linux') assert.ok(['OK', 'EXCESS', 'UNKNOWN'].includes(out.hostPrivilege.status));
        else assert.strictEqual(out.hostPrivilege.status, 'NOT_APPLICABLE');
    });

    test('the boot warning is silent when nothing is held, and names the cause when something is', () => {
        const lines: string[] = [];
        const r = hp.warnHostPrivilegeAtBoot({ warn: (...a: any[]) => lines.push(a.join(' ')) });
        if (r.status !== 'EXCESS') assert.deepStrictEqual(lines, []);
        else assert.ok(lines.some((l) => l.includes(r.cause)) && lines.some((l) => l.includes('sandbox.hostPrivilege')));
    });

    // The leg above takes its silent branch on Windows, macOS and every unprivileged CI runner, so the
    // EXCESS block it prints would never be exercised. Here the diagnosis is injected.
    test('the boot warning block for an EXCESS diagnosis: cause, sandbox, fix and where to look, on every host', () => {
        for (const [text, sandboxState] of [[INCIDENT, 'degraded'], [ROOT, 'active'], [SETUID_WRAPPER, 'active']] as const) {
            const diag = hp.diagnoseHostPrivilege({ platform: 'linux', statusText: text, sandboxState, shimFailure: PRIV_DROP_FAILURE, requireHardening: true });
            assert.strictEqual(diag.status, 'EXCESS');
            const lines: string[] = [];
            const r = hp.warnHostPrivilegeAtBoot({ warn: (...a: any[]) => lines.push(a.join(' ')) }, () => diag);
            assert.strictEqual(r, diag);
            assert.match(lines[1], /holds Linux privilege it does not need/);
            assert.deepStrictEqual(lines.slice(2, 5), [`   ${diag.cause}`, `   ${diag.sandbox}`, `   ${diag.fix}`]);
            assert.match(lines[5], /GET \/api\/v1\/health\/details \(sandbox\.hostPrivilege\)/);
            assert.strictEqual(lines.length, 7);
        }
        const quiet: string[] = [];
        hp.warnHostPrivilegeAtBoot({ warn: (...a: any[]) => quiet.push(a.join(' ')) }, () => ({ status: 'OK' }));
        assert.deepStrictEqual(quiet, []);
    });
});
