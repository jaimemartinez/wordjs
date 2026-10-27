/**
 * Windows: a plugin's AppContainer authority is taken back completely, and only ever applies to it.
 *
 *   · Retirement revokes EVERY candidate zone that exists, not only those a cache marker proves; a revoke
 *     that fails keeps its markers (the next retirement finds the ACE again); the generation is forgotten,
 *     so the next install of the slug gets a NEW package SID that no leftover ACE names.
 *   · The profile name comes from the install root as the kernel names it (junction, subst and 8.3 all
 *     resolve to one name), plus that per-install generation.
 *   · A launch revokes the zones its policy no longer includes (a withdrawn filesystem grant, a code folder
 *     that became read-only) before it grants the current ones.
 *   · A write zone is granted ONE shape (full), not rx and then full on every launch.
 *   · A timed-out ACL batch kills icacls with powershell, and every batch reads the ACL back.
 *   · OWNER RIGHTS on the writable trees: owning a file never lets anyone rewrite its DACL.
 * The profile API is replaced at sandbox-windows' own seam, so this runs on every platform; the last test
 * touches real ACLs and runs on Windows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sw = require('../core/sandbox-windows');
const sp = require('../core/sandbox-paths');
const isolate = require('../core/plugin-isolate');
const CORE = path.resolve(__dirname, '..', 'core');

async function withStubs<T>(target: any, stubs: Record<string, any>, fn: () => Promise<T>): Promise<T> {
    const saved: Record<string, any> = {};
    for (const k of Object.keys(stubs)) { saved[k] = target[k]; target[k] = stubs[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(saved)) target[k] = saved[k]; }
}

function recorder(o: { generation?: string | null; cached?: (sid: string, dir: string, mode: string) => boolean; revokeOk?: boolean } = {}) {
    const calls = { derived: [] as string[], deleted: [] as string[], revoked: [] as Array<{ sid: string; dirs: string[] }>, forgotGeneration: [] as string[] };
    const sids = new Map<string, string>();
    return {
        calls,
        api: {
            platform: () => 'win32',
            deriveSid: async (name: string) => { calls.derived.push(name); if (!sids.has(name)) sids.set(name, `S-1-15-2-${sids.size + 1}`); return sids.get(name); },
            deleteProfile: async (name: string) => { calls.deleted.push(name); return true; },
            revoke: async (sid: string, dirs: string[]) => { calls.revoked.push({ sid, dirs }); return o.revokeOk !== false; },
            revokeDeep: async () => true,
            grantIsCached: (sid: string, dir: string, mode: string) => (o.cached ? o.cached(sid, dir, mode) : false),
            legacyDeepGrant: () => false,
            forgetGrants: () => { /* */ },
            exists: () => true,
            generation: () => (o.generation === undefined ? 'a1b2c3d4e5f60718293a4b5c6d7e8f90' : o.generation),
            forgetGeneration: (_root: string, key: string) => { calls.forgotGeneration.push(key); },
        },
    };
}

describe('retirement', () => {
    const ROOT = path.join(os.tmpdir(), 'wjs-retire-sb09');

    test('revokes every existing candidate zone even with NO marker, deletes the profile and forgets the generation', async () => {
        const r = recorder({ cached: () => false });
        const ok = await withStubs(sw.__profileApi, r.api, () => sw.retireAppContainerPlugin(ROOT, 'alpha', 1));
        assert.strictEqual(ok, true);
        const current = sw.appContainerProfileNameForPlugin(ROOT, 'alpha', 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
        assert.deepStrictEqual(r.calls.deleted, [current], 'only the current profile: the legacy names hold no grant here');
        const revoked = r.calls.revoked[0].dirs.map((d) => path.resolve(d).toLowerCase());
        const p = sp.sandboxPaths(ROOT, 'alpha', CORE, 1);
        for (const d of [p.own, p.ownData, ...p.storage]) assert.ok(revoked.includes(path.resolve(d).toLowerCase()), `revoked ${d}`);
        assert.deepStrictEqual(r.calls.forgotGeneration, ['alpha'], 'a reinstall gets a new SID');
    });

    test('a failed revoke reports failure (and keeps the generation for the next attempt only via markers)', async () => {
        const r = recorder({ revokeOk: false });
        assert.strictEqual(await withStubs(sw.__profileApi, r.api, () => sw.retireAppContainerPlugin(ROOT, 'alpha', 1)), false);
    });

    test('a profile from before generations is retired when a grant of it is on record', async () => {
        const legacy = sw.legacyProfileNameForPlugin(ROOT, 'beta');
        let legacySid = '';
        const r = recorder({ generation: null, cached: (sid) => sid === legacySid });
        const api = { ...r.api, deriveSid: async (name: string) => { const sid = await r.api.deriveSid(name); if (name === legacy) legacySid = sid as string; return sid; } };
        await withStubs(sw.__profileApi, api, () => sw.retireAppContainerPlugin(ROOT, 'beta', 1));
        assert.ok(r.calls.deleted.includes(legacy), 'the legacy profile is deleted');
    });

    test('the batch script keeps the markers of a directory whose revoke did not land, and reads every ACL back', () => {
        const revoke = sw.__buildIcaclsScript('revoke');
        assert.match(revoke, /Write-Output \('FAILDIR ' \+ \[Convert\]::ToBase64String/);
        assert.match(revoke, /GetAccessRules\(\$true, \$true, \[System\.Security\.Principal\.SecurityIdentifier\]\)/);
        assert.match(revoke, /Where-Object \{ -not \$_\.IsInherited \}/, 'a revoke is confirmed only when no EXPLICIT entry of the SID is left');
        assert.match(sw.__buildIcaclsScript('rx'), /if \(\$rules\.Count -eq 0\) \{ \$fail\+\+ \}/, 'a grant is confirmed only when the entry is there');
        const src = fs.readFileSync(path.join(CORE, 'sandbox-windows.ts'), 'utf8');
        assert.match(src, /const revoked = list\.filter\(\(dir\) => !failedDirs\.has\(dir\.toLowerCase\(\)\)\);/);
        assert.match(src, /if \(!m\) \{\s+for \(const d of pending\) failedDirs\.add\(d\.toLowerCase\(\)\);/, 'a batch that never reported fails every directory');
    });

    test('a v3 marker (path-only key, recursive grant) is a legacy deep grant', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-v3-'));
        const sid = 'S-1-15-2-424242';
        const marker = sw.__v3MarkerPath(sid, dir, 'rx');
        try {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, dir);
            assert.strictEqual(sw.__profileApi.legacyDeepGrant(sid, dir), true);
        } finally {
            fs.rmSync(marker, { force: true });
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('profile names', () => {
    test('a generation gives the same slug a different SID, and the root is named as the kernel resolves it', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-name-'));
        const link = `${root}-link`;
        try {
            const a = sw.appContainerProfileNameForPlugin(root, 'alpha', '00112233445566778899aabbccddeeff');
            const b = sw.appContainerProfileNameForPlugin(root, 'alpha', 'ffeeddccbbaa99887766554433221100');
            assert.notStrictEqual(a, b, 'a reinstall (new generation) is a new profile');
            fs.symlinkSync(root, link, 'junction');
            assert.strictEqual(sw.appContainerProfileNameForPlugin(link, 'alpha', 'x'.repeat(0) || 'aa'.repeat(16)), sw.appContainerProfileNameForPlugin(root, 'alpha', 'aa'.repeat(16)),
                'a junction (or symlink) to the install is the same install');
        } finally {
            try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* */ } }
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('the launch name records a generation once, and retires the pre-generation profile first', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-gen-'));
        try {
            const legacy = sw.legacyProfileNameForPlugin(root, 'gamma');
            let legacySid = '';
            const r = recorder();
            const api = {
                ...r.api,
                generation: undefined,
                deriveSid: async (name: string) => { const sid = await r.api.deriveSid(name); if (name === legacy) legacySid = sid as string; return sid; },
                grantIsCached: (sid: string) => sid === legacySid,
            };
            delete (api as any).generation;
            const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
            Object.defineProperty(process, 'platform', { value: 'win32' });
            let first = '', second = '';
            try {
                first = await withStubs(sw.__profileApi, api, () => sw.launchProfileNameFor(root, 'gamma', 1));
                second = await withStubs(sw.__profileApi, api, () => sw.launchProfileNameFor(root, 'gamma', 1));
            } finally { Object.defineProperty(process, 'platform', realPlatform); }
            assert.strictEqual(first, second, 'the generation is recorded and reused');
            assert.notStrictEqual(first, legacy);
            assert.ok(r.calls.deleted.includes(legacy), 'the legacy profile was retired before the switch');
            assert.deepStrictEqual(sw.listProfileGenerations(root), ['gamma']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('launch', () => {
    const ROOT = path.join(os.tmpdir(), 'wjs-launch-sb10');

    test('zones the policy no longer includes are revoked before the grants', async () => {
        const p = sp.sandboxPaths(ROOT, 'delta', CORE, 1);
        // On record: the own code folder granted writable (an earlier release) and the private storage
        // granted writable (a filesystem grant since withdrawn).
        const onRecord = new Set([`full|${p.own}`, `full|${p.storage[0]}`, `rx|${p.own}`].map((k) => k.toLowerCase()));
        const r = recorder({ cached: (_sid, dir, mode) => onRecord.has(`${mode}|${dir}`.toLowerCase()) });
        const current = { traverse: p.traverse, readExec: p.readOnly, write: [p.ownData] };
        const stale: string[] = await withStubs(sw.__profileApi, r.api, () => sw.revokeZonesOutsidePolicy('S-1-15-2-9', ROOT, 'delta', 1, current));
        const revoked = (r.calls.revoked[0] || { dirs: [] }).dirs.map((d) => path.resolve(d).toLowerCase());
        assert.ok(revoked.includes(path.resolve(p.own).toLowerCase()), 'the code folder loses its writable ACE');
        assert.ok(revoked.includes(path.resolve(p.storage[0]).toLowerCase()), 'the withdrawn storage is revoked');
        assert.strictEqual(stale.length, 2);
        const none = recorder({ cached: () => false });
        assert.deepStrictEqual(await withStubs(sw.__profileApi, none.api, () => sw.revokeZonesOutsidePolicy('S-1-15-2-9', ROOT, 'delta', 1, current)), []);
        assert.deepStrictEqual(none.calls.revoked, [], 'nothing on record, nothing to revoke');
    });

    test('a write zone is granted one shape: never rx AND full', () => {
        const z = isolate.__appContainerLaunchZones({ traverse: ['/t'], readExec: ['/core', '/own', '/data/x'], write: ['/data/x'] });
        assert.deepStrictEqual(z.readExec, ['/core', '/own']);
        assert.deepStrictEqual(z.write, ['/data/x']);
        const src = fs.readFileSync(path.join(CORE, 'plugin-isolate.ts'), 'utf8');
        assert.match(src, /const zones = appContainerLaunchZones\(io\.zones\);\s+\/\/[^\n]*\n[^\n]*\n\s+await win\.revokeZonesOutsidePolicy\(sid, appRoot, slug, siteId, zones\);/);
    });

    test('a timed-out ACL batch kills the whole process tree', () => {
        const src = fs.readFileSync(path.join(CORE, 'sandbox-windows.ts'), 'utf8');
        assert.match(src, /killProcessTree\(ps && ps\.pid\);\s+try \{ ps\.kill\(\); \}/);
        assert.match(src, /spawnSync\('taskkill\.exe', \['\/PID', String\(pid\), '\/T', '\/F'\]/);
    });

    test('writable trees carry OWNER RIGHTS, so owning a file never grants WRITE_DAC', () => {
        assert.match(sw.__buildIcaclsScript('full'), /\/grant "\*S-1-3-4:\(OI\)\(CI\)\(IO\)\(M\)"/);
        assert.doesNotMatch(sw.__buildIcaclsScript('rx'), /S-1-3-4/, 'only writable trees');
    });
});

const LIVE = process.platform === 'win32';
describe('OWNER RIGHTS on a real writable zone (Windows)', { skip: !LIVE && 'needs real Windows ACLs' }, () => {
    test('files created below a writable zone inherit OWNER RIGHTS without WRITE_DAC', async () => {
        const zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-owner-rights-'));
        const sid = 'S-1-15-2-1111111111-2222222222-3333333333-4444444444-555555555-666666666-777777777';
        try {
            assert.strictEqual(await sw.grantAppContainerAccess(sid, [zone], 'full'), true);
            fs.writeFileSync(path.join(zone, 'child.txt'), 'x');
            const out = require('child_process').execFileSync('icacls', [path.join(zone, 'child.txt')], { encoding: 'utf8' });
            const line = out.split(/\r?\n/).find((l: string) => /OWNER RIGHTS|S-1-3-4|DERECHOS DE PROPIETARIO|PROPRI/i.test(l)) || '';
            assert.ok(line, `OWNER RIGHTS is inherited: ${out}`);
            assert.ok(/\(I\)\(M\)|\(I\)\(OI\)\(CI\)\(M\)|\(M\)/.test(line), `with Modify only: ${line}`);
        } finally {
            try { await sw.revokeAppContainerAccess(sid, [zone]); } catch { /* */ }
            fs.rmSync(zone, { recursive: true, force: true });
        }
    });
});
