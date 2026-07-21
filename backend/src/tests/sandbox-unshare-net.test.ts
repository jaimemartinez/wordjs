/**
 * Sandbox --unshare-net (network-namespace isolation for NON-network plugins).
 *
 * Kernel-level proof that a non-network plugin literally cannot reach the network needs a real Linux
 * bwrap + unprivileged-userns host and is a PROXMOX validation item (per the always-3-modes + browser-verify
 * rule). What IS deterministically checkable cross-platform is the argv builder's CONTRACT: --unshare-net is
 * emitted ONLY when denyNetwork is true, and the default (denyNetwork=false / omitted) is byte-identical to
 * the pre-feature profile — the guard against an accidental always-on network cut that would break every
 * network-granted plugin. Plus: the state getter is present and returns a valid enum.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const isolate = require('../core/plugin-isolate');
const bwrapProfile = isolate.__bwrapProfile;

test('bwrapProfile: --unshare-net is emitted ONLY when denyNetwork is true', () => {
    const denied = bwrapProfile(['/srv/app/plugins/x'], true);
    const allowed = bwrapProfile(['/srv/app/plugins/x'], false);
    const defaulted = bwrapProfile(['/srv/app/plugins/x']);

    assert.ok(denied.includes('--unshare-net'), 'denyNetwork=true MUST add --unshare-net');
    assert.ok(!allowed.includes('--unshare-net'), 'denyNetwork=false MUST NOT add --unshare-net (granted plugins keep egress)');
    assert.ok(!defaulted.includes('--unshare-net'), 'the DEFAULT (omitted arg) MUST NOT add --unshare-net');
    assert.strictEqual(denied.filter((a: string) => a === '--unshare-net').length, 1, 'exactly one --unshare-net');
});

test('bwrapProfile: default profile is byte-identical to the pre-feature profile (zero regression)', () => {
    // The ONLY difference between denyNetwork=false and true must be the single --unshare-net token; the
    // default and the explicit-false forms must be exactly equal (no other drift in the argv).
    assert.deepStrictEqual(bwrapProfile(['/a', '/b']), bwrapProfile(['/a', '/b'], false),
        'omitting denyNetwork must equal denyNetwork=false');
    const allowed = bwrapProfile(['/a'], false);
    const denied = bwrapProfile(['/a'], true);
    // Removing --unshare-net from `denied` must reproduce `allowed` exactly.
    assert.deepStrictEqual(denied.filter((a: string) => a !== '--unshare-net'), allowed,
        'denied minus --unshare-net must equal the allowed profile — no collateral argv change');
});

test('bwrapProfile: --unshare-net sits inside the unshare group, before uid/mounts and the writable binds', () => {
    const argv = bwrapProfile(['/srv/app/plugins/x'], true);
    const netIdx = argv.indexOf('--unshare-net');
    const uidIdx = argv.indexOf('--uid');
    const bindIdx = argv.indexOf('--bind-try');
    assert.ok(netIdx > argv.indexOf('--unshare-user'), '--unshare-net after --unshare-user');
    assert.ok(netIdx < uidIdx, '--unshare-net before --uid (namespace flags precede the uid/gid drop)');
    assert.ok(netIdx < bindIdx, '--unshare-net before the writable binds');
});

test('bwrapProfile: writable binds still present + no other --unshare regression', () => {
    const argv = bwrapProfile(['/srv/app/plugins/x', '/srv/app/uploads'], true);
    // Each writable dir keeps its --bind-try d d triple.
    for (const d of ['/srv/app/plugins/x', '/srv/app/uploads']) {
        const i = argv.indexOf(d);
        assert.ok(i > 0 && argv[i - 1] === '--bind-try' && argv[i + 1] === d, `writable bind preserved for ${d}`);
    }
    // The existing namespace flags are all still there.
    for (const f of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--new-session']) {
        assert.ok(argv.includes(f), `${f} preserved`);
    }
});

test('getSandboxNetnsState: exported and returns a valid state enum', () => {
    assert.strictEqual(typeof isolate.getSandboxNetnsState, 'function', 'getSandboxNetnsState is exported');
    const s = isolate.getSandboxNetnsState();
    assert.ok(['unknown', 'unsupported', 'disabled', 'active', 'degraded'].includes(s), `valid netns state, got ${s}`);
});
