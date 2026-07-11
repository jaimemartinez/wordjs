/**
 * Port-conflict detection + consensual liberation (core/port-conflicts).
 * Covers: the ss parser (fixture = real `ss -Htlnp` output from a Proxmox LXC where the distro's
 * preinstalled Postfix squatted 25), every canFree gate (platform / root / known-MTA / self), and
 * the free flow (systemctl disable --now + wait-until-released), all via injected deps — no root
 * Linux box needed.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { detectPortConflict, freeClaimedPort, parseSsListeners, isLoopbackAddr } = require('../core/port-conflicts');

// Real-world shape: Postfix ("master") on loopback 25 (v4+v6), WordJS node on 2525/3000.
const SS_POSTFIX_LOOPBACK = [
    'LISTEN 0      100        127.0.0.1:25        0.0.0.0:*    users:(("master",pid=435,fd=13))',
    'LISTEN 0      100            [::1]:25           [::]:*    users:(("master",pid=435,fd=14))',
    'LISTEN 0      511                *:2525            *:*    users:(("node",pid=10608,fd=27))',
    'LISTEN 0      511                *:3000            *:*    users:(("node",pid=10586,fd=34))',
].join('\n');

const SS_POSTFIX_PUBLIC = 'LISTEN 0 100 0.0.0.0:25 0.0.0.0:* users:(("master",pid=435,fd=13))';
const SS_UNKNOWN_PROC = 'LISTEN 0 100 127.0.0.1:25 0.0.0.0:* users:(("my-custom-mta",pid=999,fd=4))';
const SS_EMPTY = '';

const linuxRoot = (stdout: string) => ({
    platform: 'linux',
    getuid: () => 0,
    execFileAsync: async () => ({ stdout }),
    sleepMs: 0,
});

test('parseSsListeners extracts only the requested port, with proc, pids and v6-bracket addrs', () => {
    const on25 = parseSsListeners(SS_POSTFIX_LOOPBACK, 25);
    assert.strictEqual(on25.length, 2);
    assert.deepStrictEqual(on25.map((l: any) => l.addr).sort(), ['127.0.0.1', '::1']);
    assert.strictEqual(on25[0].proc, 'master');
    assert.deepStrictEqual(on25[0].pids, [435]);
    assert.strictEqual(parseSsListeners(SS_POSTFIX_LOOPBACK, 2525).length, 1);
    assert.strictEqual(parseSsListeners(SS_EMPTY, 25).length, 0);
});

test('isLoopbackAddr: loopback vs wildcard/public', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) assert.ok(isLoopbackAddr(a), a);
    for (const a of ['0.0.0.0', '*', '::', '192.168.1.10']) assert.ok(!isLoopbackAddr(a), a);
});

test('detect: non-Linux platform → never freeable, flagged uninspectable (NOT "free")', async () => {
    const r = await detectPortConflict(25, { platform: 'win32' });
    assert.strictEqual(r.canFree, false);
    assert.strictEqual(r.uninspectable, true);
    assert.match(r.reason, /Linux/);
});

test('detect: free port → inUse false', async () => {
    const r = await detectPortConflict(25, linuxRoot(SS_EMPTY));
    assert.strictEqual(r.inUse, false);
    assert.strictEqual(r.canFree, false);
});

test('detect: known MTA (postfix master) on loopback as root → canFree with service mapping', async () => {
    const r = await detectPortConflict(25, linuxRoot(SS_POSTFIX_LOOPBACK));
    assert.strictEqual(r.inUse, true);
    assert.strictEqual(r.canFree, true);
    assert.strictEqual(r.occupant.service, 'postfix');
    assert.strictEqual(r.occupant.label, 'Postfix');
    assert.strictEqual(r.occupant.loopbackOnly, true);
});

test('detect: known MTA but NOT root → not freeable, reason carries the manual command', async () => {
    const r = await detectPortConflict(25, { ...linuxRoot(SS_POSTFIX_LOOPBACK), getuid: () => 1000 });
    assert.strictEqual(r.canFree, false);
    assert.match(r.reason, /systemctl disable --now postfix/);
});

test('detect: unknown occupant → reported but never freeable', async () => {
    const r = await detectPortConflict(25, linuxRoot(SS_UNKNOWN_PROC));
    assert.strictEqual(r.inUse, true);
    assert.strictEqual(r.canFree, false);
    assert.match(r.reason, /my-custom-mta/);
});

test('detect: public-bound known MTA stays freeable but flags loopbackOnly=false (UI warns harder)', async () => {
    const r = await detectPortConflict(25, linuxRoot(SS_POSTFIX_PUBLIC));
    assert.strictEqual(r.canFree, true);
    assert.strictEqual(r.occupant.loopbackOnly, false);
});

test('detect: ss unavailable → honest reason + uninspectable, no crash', async () => {
    const r = await detectPortConflict(25, { platform: 'linux', getuid: () => 0, execFileAsync: async () => { throw new Error('ENOENT'); } });
    assert.strictEqual(r.canFree, false);
    assert.strictEqual(r.uninspectable, true);
    assert.match(r.reason, /ss unavailable/);
});

test('detect: WordJS\'s own isolate child holding the port → "held by WordJS itself", not a foreign squatter', async () => {
    // The mail listener binds inside the fork()ed plugin child, so its pid is NOT process.pid.
    const ssSelf = 'LISTEN 0 511 *:25 *:* users:(("node",pid=10608,fd=27))';
    const r = await detectPortConflict(25, { ...linuxRoot(ssSelf), selfPids: [process.pid, 10608] });
    assert.strictEqual(r.inUse, true);
    assert.strictEqual(r.canFree, false);
    assert.match(r.reason, /WordJS itself/);
});

test('freeClaimedPort WITHOUT allowDisable → CONSENT_REQUIRED carrying the fresh conflict, nothing executed', async () => {
    // Server-side consent gate (TOCTOU): a request lacking the modal confirmation must never disable.
    const calls: string[][] = [];
    const deps = { ...linuxRoot(SS_POSTFIX_LOOPBACK), execFileAsync: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: SS_POSTFIX_LOOPBACK }; } };
    await assert.rejects(() => freeClaimedPort(25, deps), (e: any) => e.code === 'CONSENT_REQUIRED' && e.conflict && e.conflict.occupant.label === 'Postfix');
    assert.ok(!calls.some(c => c[0] === 'systemctl'));
});

test('freeClaimedPort on an uninspectable host → PORT_NOT_FREEABLE, never a fake alreadyFree success', async () => {
    await assert.rejects(
        () => freeClaimedPort(25, { platform: 'win32', allowDisable: true }),
        (e: any) => e.code === 'PORT_NOT_FREEABLE' && /Linux/.test(e.message)
    );
});

test('freeClaimedPort: disables the mapped unit, waits for release, reports what it did', async () => {
    const calls: string[][] = [];
    let disabled = false;
    const deps = {
        platform: 'linux',
        getuid: () => 0,
        sleepMs: 0,
        allowDisable: true,
        execFileAsync: async (cmd: string, args: string[]) => {
            calls.push([cmd, ...args]);
            if (cmd === 'systemctl') { disabled = true; return { stdout: '' }; }
            return { stdout: disabled ? SS_EMPTY : SS_POSTFIX_LOOPBACK };
        },
    };
    const r = await freeClaimedPort(25, deps);
    assert.strictEqual(r.freed, true);
    assert.strictEqual(r.service, 'postfix');
    // Permanent: disable --now (not a plain stop), unit from OUR allowlist map.
    assert.ok(calls.some(c => c.join(' ') === 'systemctl disable --now postfix'), JSON.stringify(calls));
});

test('freeClaimedPort: already free → no systemctl call at all', async () => {
    const calls: string[][] = [];
    const deps = { ...linuxRoot(SS_EMPTY), execFileAsync: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: SS_EMPTY }; } };
    const r = await freeClaimedPort(25, deps);
    assert.strictEqual(r.freed, false);
    assert.strictEqual(r.alreadyFree, true);
    assert.ok(!calls.some(c => c[0] === 'systemctl'));
});

test('freeClaimedPort: unknown occupant → PORT_NOT_FREEABLE, nothing executed', async () => {
    const calls: string[][] = [];
    const deps = { ...linuxRoot(SS_UNKNOWN_PROC), allowDisable: true, execFileAsync: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: SS_UNKNOWN_PROC }; } };
    await assert.rejects(() => freeClaimedPort(25, deps), (e: any) => e.code === 'PORT_NOT_FREEABLE');
    assert.ok(!calls.some(c => c[0] === 'systemctl'));
});

test('freeClaimedPort: port never released → PORT_STILL_IN_USE after bounded polling', async () => {
    const deps = { ...linuxRoot(SS_POSTFIX_LOOPBACK), allowDisable: true, execFileAsync: async (cmd: string) => (cmd === 'systemctl' ? { stdout: '' } : { stdout: SS_POSTFIX_LOOPBACK }) };
    await assert.rejects(() => freeClaimedPort(25, deps), (e: any) => e.code === 'PORT_STILL_IN_USE');
});
