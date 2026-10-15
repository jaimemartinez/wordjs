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

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
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

// THE NETWORK, which the permission model covers differently by Node release: not at all before Node 25,
// and from Node 25 by denying every socket unless `--allow-net` is passed. A network-GRANTED plugin must
// keep its network under every release (on Node 25 it lost it: `getaddrinfo ERR_ACCESS_DENIED`), a plugin
// WITHOUT the grant must never be handed `--allow-net`, and the egress guard must stay the authority on
// which hosts a granted plugin reaches — the flag takes no host list.
describe('permission model — the network follows the grant', () => {
    let flag: string | null = null;
    let netFlags: string[] | null = null;
    let zone = '';
    let server: any = null;
    let port = 0;
    let accepted = 0;

    before(async () => {
        flag = await isolate.probePermissionModel();
        netFlags = await isolate.probeNetPermission();
        zone = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-perm-net-'));
        // The child loads the REAL egress guard from inside its own read zone, as plain JS.
        const ts = require('typescript');
        const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'egress-guard.ts'), 'utf8');
        const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        fs.writeFileSync(path.join(zone, 'egress-guard.js'), js);
        server = net.createServer((c: any) => { accepted++; c.on('error', () => { /* client gone */ }); c.end(); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });
    after(() => { try { if (server) server.close(); } catch { /* closed */ } });

    // Exactly what plugin-isolate ships for one plugin, network flags included or not by its grant.
    const shippedFor = (netGranted: boolean) =>
        isolate.__permissionModelArgv({ permFlag: flag, readable: [zone], writable: [zone], netGranted, netFlags });

    // DENIED (the permission model), EGRESS (the JS egress guard), OK, or the failing code — so a refusal
    // by one layer can never be mistaken for the other.
    const classify = 'const cls=e=>e&&e.code==="ERR_ACCESS_DENIED"?"DENIED":' +
        '/\\[sandbox\\] network egress/.test(String(e&&e.message))?"EGRESS":"OTHER:"+(e&&(e.code||e.message));';
    const collect = (keys: string[]) => `const out={};const fin=()=>{if(${JSON.stringify(keys)}.every(k=>k in out)){console.log(JSON.stringify(out));process.exit(0)}};` +
        'const put=(k,v)=>{if(!(k in out)){out[k]=v;fin()}};';
    // A refused listen surfaces as an uncaught exception on Node 25, not as the server's 'error' event.
    const lookup = (key: string, host: string) => `try{require("dns").lookup(${JSON.stringify(host)},e=>put("${key}",e?cls(e):"OK"))}catch(e){put("${key}",cls(e))}`;
    const connect = (key: string, host: string) => `try{const s=require("net").connect({host:${JSON.stringify(host)},port:${port}});` +
        `s.on("connect",()=>{s.destroy();put("${key}","OK")});s.on("error",e=>put("${key}",cls(e)))}catch(e){put("${key}",cls(e))}`;
    const listen = (key: string, host: string) => `process.on("uncaughtException",e=>put("${key}",cls(e)));` +
        `try{const sv=require("net").createServer();sv.on("error",e=>put("${key}",cls(e)));sv.listen(0,${JSON.stringify(host)},()=>{sv.close();put("${key}","OK")})}catch(e){put("${key}",cls(e))}`;
    const parse = (out: string) => { try { return JSON.parse(out); } catch { return { raw: out }; } };

    test('the argv carries the network flags for a network-granted plugin, and never for one without the grant', () => {
        const flags = ['--allow-net', '--disable-warning=ExperimentalWarning'];
        const base = { permFlag: '--permission', readable: ['/r1', '/r2'], writable: ['/w'] };
        assert.deepStrictEqual(isolate.__permissionModelArgv({ ...base, netGranted: true, netFlags: flags }),
            ['--permission', '--allow-fs-read=/r1', '--allow-fs-read=/r2', '--allow-fs-write=/w', ...flags]);
        const ungranted = isolate.__permissionModelArgv({ ...base, netGranted: false, netFlags: flags });
        assert.deepStrictEqual(ungranted, ['--permission', '--allow-fs-read=/r1', '--allow-fs-read=/r2', '--allow-fs-write=/w']);
        assert.ok(!ungranted.some((a: string) => a.startsWith('--allow-net')), 'a plugin without the grant must never get --allow-net');
        // A Node whose model does not gate the network (or rejects the flag) gets nothing extra, grant or not.
        assert.deepStrictEqual(isolate.__permissionModelArgv({ ...base, netGranted: true, netFlags: null }),
            ['--permission', '--allow-fs-read=/r1', '--allow-fs-read=/r2', '--allow-fs-write=/w']);
    });

    test('the network probe reports only what a child verified on this Node', async () => {
        const state = isolate.getNetPermissionState();
        if (!flag) {
            assert.strictEqual(netFlags, null);
            assert.strictEqual(state, 'not-gated');
            return;
        }
        const probeSrc = classify + collect(['lookup']) + lookup('lookup', 'localhost');
        const without = parse(await runChild([flag, `--allow-fs-read=${zone}`], probeSrc));
        if (netFlags) {
            assert.strictEqual(state, 'gated');
            assert.strictEqual(netFlags[0], '--allow-net');
            assert.strictEqual(without.lookup, 'DENIED', 'reported gated, but the model let a lookup through without the flag');
            const withFlags = parse(await runChild([flag, `--allow-fs-read=${zone}`, ...netFlags], probeSrc));
            assert.strictEqual(withFlags.lookup, 'OK', 'the selected flags did not restore the network');
        } else {
            assert.ok(state === 'not-gated' || state === 'unrestorable', `unexpected state ${state}`);
            if (state === 'not-gated') assert.notStrictEqual(without.lookup, 'DENIED', 'reported not-gated, but the model denied a lookup');
        }
    });

    test('a network-granted plugin can resolve, connect and listen under the shipped argv', async () => {
        if (!flag) return;
        const seen = accepted;
        const r = parse(await runChild(shippedFor(true), classify + collect(['lookup', 'connect', 'listen']) +
            lookup('lookup', 'localhost') + connect('connect', '127.0.0.1') + listen('listen', '127.0.0.1')));
        assert.deepStrictEqual(r, { lookup: 'OK', connect: 'OK', listen: 'OK' }, `network-granted plugin lost its network: ${JSON.stringify(r)}`);
        assert.ok(accepted > seen, 'the test server never saw the granted connection');
    });

    test('a plugin without the grant gets no network from the permission model where it gates the network', async (t: any) => {
        if (!flag || isolate.getNetPermissionState() !== 'gated') {
            t.skip(`this Node (${process.version}) does not gate the network in its permission model; the egress guard and the native sandbox deny it`);
            return;
        }
        const seen = accepted;
        const r = parse(await runChild(shippedFor(false), classify + collect(['lookup', 'connect']) +
            lookup('lookup', 'localhost') + connect('connect', '127.0.0.1')));
        assert.deepStrictEqual(r, { lookup: 'DENIED', connect: 'DENIED' }, `an ungranted plugin reached the network: ${JSON.stringify(r)}`);
        assert.strictEqual(accepted, seen, 'an ungranted plugin opened a connection');
    });

    test('the egress guard, not --allow-net, decides which hosts a granted plugin reaches', async () => {
        if (!flag) return;
        const seen = accepted;
        // The child installs the guards the way plugin-worker.js does for a network-granted plugin, with an
        // allowlist naming only `localhost`.
        const guard = `const eg=require(${JSON.stringify(path.join(zone, 'egress-guard.js'))});` +
            'eg.setAllowedHosts(["localhost"]);eg.installChildNetGuard();eg.installChildDgramGuard();eg.installChildResolverGate();';
        const r = parse(await runChild(shippedFor(true), classify + collect(['listed', 'unlisted', 'listen', 'connectUnlisted', 'connectLoopback']) + guard +
            lookup('listed', 'localhost') + lookup('unlisted', 'blocked.invalid') + listen('listen', 'localhost') +
            connect('connectUnlisted', 'blocked.invalid') + connect('connectLoopback', 'localhost')));
        // The allowlisted name resolves and a server binds to it: the permission model no longer stands in the way.
        assert.strictEqual(r.listed, 'OK', `allowlisted host did not resolve: ${JSON.stringify(r)}`);
        assert.strictEqual(r.listen, 'OK', `allowlisted host could not be listened on: ${JSON.stringify(r)}`);
        // A name off the allowlist is refused by the guard before it is ever queried or connected to.
        assert.strictEqual(r.unlisted, 'EGRESS', `unlisted host was not refused by the egress guard: ${JSON.stringify(r)}`);
        assert.strictEqual(r.connectUnlisted, 'EGRESS', `unlisted host was not refused by the egress guard: ${JSON.stringify(r)}`);
        // And --allow-net does not open loopback: an allowlisted name that resolves there is still refused.
        assert.strictEqual(r.connectLoopback, 'EGRESS', `loopback was reachable through --allow-net: ${JSON.stringify(r)}`);
        assert.strictEqual(accepted, seen, 'the guard let a connection reach the loopback test server');
    });
});
