/**
 * CAPABILITY CONFINEMENT ON EVERY PLATFORM (Node's permission model).
 *
 * Node's permission model is the portable capability floor beneath the JS guards. Landlock+seccomp,
 * AppContainer+Job Objects and Seatbelt add the native platform boundary, but the common Node layer keeps
 * the denied runtime surface aligned across operating systems. Node's permission model is enforced in C++ below
 * JavaScript with the same flags everywhere, and there is no API to re-grant from inside the process,
 * so it is the one layer that closes that asymmetry.
 *
 * This test does NOT trust the flag: it spawns real children with the exact argv plugin-isolate builds
 * and checks what they can actually do. A build can accept `--permission` without enforcing it, and a
 * confinement that is reported but absent is worse than none — it is the "looks secure but isn't" state
 * the rest of this sandbox is explicitly designed to avoid.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isolate = require('../core/plugin-isolate');

/** Run `src` in a child with `flags`, return its single line of stdout. */
function runChild(flags: string[], src: string): Promise<string> {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [...flags, '-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (d: any) => { out += String(d); });
        p.on('error', () => resolve('SPAWN_ERROR'));
        p.on('close', () => resolve(out.trim()));
        setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve('TIMEOUT'); }, 10000).unref?.();
    });
}

// Probe one capability and report DENIED / OK / the failing code, so a refusal for an unrelated reason
// can never be mistaken for confinement.
const probe = (body: string) =>
    `try{${body};console.log("OK")}catch(e){console.log(e&&e.code==="ERR_ACCESS_DENIED"?"DENIED":"OTHER:"+(e&&e.code))}`;

describe('permission model — the probe reports only what it verified', () => {
    test('probePermissionModel resolves a flag or null, and the state agrees', async () => {
        const flag = await isolate.probePermissionModel();
        const state = isolate.getPermissionModelState();
        if (flag) {
            assert.ok(flag === '--permission' || flag === '--experimental-permission', `unexpected flag ${flag}`);
            assert.strictEqual(state, 'active');
        } else {
            assert.ok(['unsupported', 'disabled'].includes(state), `state should explain the absence, got ${state}`);
        }
    });

    test('the probe refuses to report ACTIVE unless a read is genuinely denied', async () => {
        const flag = await isolate.probePermissionModel();
        if (!flag) return;  // nothing to verify on a Node without the model
        // The probe's own criterion, re-run here: grant one directory, read outside it.
        const verdict = await runChild([flag, `--allow-fs-read=${__dirname}`],
            probe('require("fs").readFileSync(process.execPath)'));
        assert.strictEqual(verdict, 'DENIED', 'the model accepted the flag but did not enforce it');
    });
});

describe('permission model — the policy plugin-isolate actually ships', () => {
    let flag: string | null = null;
    let zone = '';
    let outside = '';

    before(async () => {
        flag = await isolate.probePermissionModel();
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-perm-'));
        zone = path.join(base, 'plugin-zone');
        outside = path.join(base, 'outside.txt');
        fs.mkdirSync(path.join(zone, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(zone, 'nested', 'own.txt'), 'plugin data');
        fs.writeFileSync(outside, 'host secret');
    });

    // Mirrors one argv root built in plugin-isolate: reads/writes scoped to a granted zone, and no grant
    // at all for the capabilities a plugin must never hold. Production repeats the read flag per narrow root.
    const shipped = () => [flag as string, `--allow-fs-read=${zone}`, `--allow-fs-write=${zone}`];

    test('a plugin keeps working: it reads and writes inside its own zone, including nested paths', async () => {
        if (!flag) return;
        assert.strictEqual(await runChild(shipped(), probe(`require("fs").readFileSync(${JSON.stringify(path.join(zone, 'nested', 'own.txt'))})`)), 'OK');
        assert.strictEqual(await runChild(shipped(), probe(`require("fs").writeFileSync(${JSON.stringify(path.join(zone, 'nested', 'written.txt'))},"x")`)), 'OK');
    });

    test('it cannot read a host file outside its zone', async () => {
        if (!flag) return;
        assert.strictEqual(await runChild(shipped(), probe(`require("fs").readFileSync(${JSON.stringify(outside)})`)), 'DENIED');
    });

    test('it cannot write outside its zone', async () => {
        if (!flag) return;
        assert.strictEqual(await runChild(shipped(), probe(`require("fs").writeFileSync(${JSON.stringify(outside + '.pwned')},"x")`)), 'DENIED');
    });

    test('command execution is denied in C++, not by a JS proxy', async () => {
        if (!flag) return;
        assert.strictEqual(await runChild(shipped(), probe('require("child_process").execSync("echo x")')), 'DENIED');
    });

    test('native addon loading is denied', async () => {
        if (!flag) return;
        const v = await runChild(shipped(), probe('process.dlopen({exports:{}}, process.execPath)'));
        assert.ok(v === 'DENIED' || v === 'OTHER:ERR_DLOPEN_DISABLED', `addons must be refused, got ${v}`);
    });

    test('WASI — one of the escapes the by-name denylist had to learn — is denied without being named', async () => {
        if (!flag) return;
        const v = await runChild(shipped(), probe(`new (require("wasi").WASI)({version:"preview1",preopens:{"/":${JSON.stringify(zone)}}})`));
        assert.ok(v === 'DENIED' || String(v).startsWith('OTHER:'), `WASI must be refused, got ${v}`);
    });

    test('process.loadEnvFile — a C++ read that never reaches io-guard — is denied', async () => {
        if (!flag) return;
        const v = await runChild(shipped(), probe(`process.loadEnvFile(${JSON.stringify(outside)})`));
        assert.ok(v === 'DENIED' || String(v).startsWith('OTHER:'), `loadEnvFile must be refused, got ${v}`);
    });

    test('raw native bindings are denied', async () => {
        if (!flag) return;
        assert.strictEqual(await runChild(shipped(), probe('process.binding("fs")')), 'DENIED');
    });

    // The honest half: what this layer does NOT cover, asserted so nobody mistakes it for total.
    test('KNOWN GAP: node:sqlite still reaches the filesystem through it (why the module stays denylisted)', async () => {
        if (!flag) return;
        const dbPath = path.join(zone, '..', 'sqlite-escape.db');   // deliberately OUTSIDE the write zone
        const v = await runChild(shipped(), probe(`const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(dbPath)});d.exec("CREATE TABLE t(a)");d.close()`));
        if (v === 'OK') {
            assert.ok(fs.existsSync(dbPath),
                'sqlite reported success without writing — re-check this gap, it may have been fixed upstream');
        }
        // Either outcome is acceptable as a fact about Node; what must NEVER change is that the module
        // is unreachable for plugins in the first place.
        const { installSecureRequire } = require('../core/secure-require');
        const { runWithContext } = require('../core/plugin-context');
        installSecureRequire();
        runWithContext('perm-gap-probe', () => {
            // NB: the blocked proxy answers every property with a thrower FUNCTION — reading
            // `.DatabaseSync` does not throw, calling it does. Asserting on the access alone would pass
            // against a completely open module.
            const mod = (process as any).getBuiltinModule('sqlite');
            assert.throws(() => new mod.DatabaseSync(':memory:'), /not permitted|blocked|sandbox|Security/i,
                'node:sqlite must stay blocked by name — the permission model does not stop it');
        });
    });
});
