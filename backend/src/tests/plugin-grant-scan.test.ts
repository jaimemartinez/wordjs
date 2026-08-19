/**
 * WordJS — WHERE A REVOKED `filesystem` CAPABILITY IS ACTUALLY REFUSED.
 *
 * ── WHAT WENT WRONG WITH THE PREVIOUS VERSION OF THIS FILE ──────────────────────────────────────────
 *
 * It claimed to close the class "does this code reach fs?" by generating 864 cases from a product of
 * three tables (SOURCES × CARRIERS × CALLS) and asserting the AST scanner in core/plugins.ts refused
 * every one of them. Twenty-seven tests, all green — while twelve trivial spellings walked straight
 * past the scanner with zero permissions declared: a class field, a static field, a private field, a
 * captured method on a class field, `this.x = require('fs')` in a constructor, an object getter, a
 * default parameter, and friends. The reason is not that somebody forgot a row. It is that the ROWS
 * WERE HAND-WRITTEN. The real population is "every JavaScript expression that can hold a value", and
 * no literal in a test file can enumerate it — so the table could only ever describe the shapes the
 * implementation already handled. A test whose member list is written by hand is not a gate; it is
 * documentation that happens to execute.
 *
 * ── THE FIX IS NOT MORE ROWS ────────────────────────────────────────────────────────────────────────
 *
 * "Does this code reach fs?" is a DATA-FLOW question. An AST scanner answers it by recognising SYNTAX,
 * so each audit round teaches it one more spelling and the next one still walks past. The decision
 * therefore moved to the only place that cannot be out-spelled: THE MOMENT OF THE CALL. By then the
 * module object has been obtained and the syntax that carried it no longer exists.
 *
 *   · core/io-guard.ts `fsCapabilityRevoked` + `isPathSafe` — the raw-fs surface (io-guard patches the
 *     real fs methods, so this catches code that never went through the require proxy at all).
 *   · core/secure-require.ts `guardFsCall` — the plugin-facing fs / fs.promises proxies.
 *
 * The rule both enforce: a capability the plugin DECLARED and the administrator DID NOT GRANT is
 * refused on every path, INCLUDING the plugin's own directory — which used to be authorized by
 * geography alone and was the one region where the AST scanner was the only thing standing in the way.
 * A capability the plugin NEVER DECLARED is not "revoked": its own directory stays private storage, as
 * it has always been for every zero-permission plugin (that half is asserted below as a control, so a
 * gate that simply denied everything could not pass this file).
 *
 * ── WHAT EACH PART OF THIS FILE IS, HONESTLY ────────────────────────────────────────────────────────
 *
 * 1. THE RUNTIME GATE (derived population). The set of fs entry points is read LIVE from
 *    core/secure-require's own classification arrays and from Node's own `fs` surface — not restated
 *    here. Adding a method to those arrays, or Node growing a new one, is covered without editing this
 *    file. The twelve spellings that defeated the scanner are executed FOR REAL against this gate,
 *    where being out-spelled cannot matter, and they are all refused.
 * 2. THE SCANNER'S EXEMPTIONS (derived population). core/plugins.ts exports the two tables that weaken
 *    its fail-closed residue pass. This file enumerates THEM and demands a justification + a
 *    complementary probe per entry, so adding a weakening turns this file red.
 * 3. THE SCANNER'S SHAPE MATRIX (population NOT derived — stated plainly at the matrix). It is kept as
 *    a regression net for shapes we already know, and for the operator-facing message. It is NOT
 *    evidence that the scanner is complete, and nothing in the product depends on it being complete.
 * 4. The install/activation cases, which pin the two scan MODES ('declaration' at install so the
 *    approval screen can be built; 'grant' at activation).
 *
 * Everything here drives the REAL producers: the real installPluginFromZip pipeline, the real
 * `plugin_grants` option through the real setGrants, the real activatePlugin, and the real fs proxy.
 *
 * The last case covers the read-modify-write of `active_plugins` in the same file: the dist-lock is a
 * deliberate no-op on SQLite and the "atomic UPSERT" only makes the WRITE atomic, so two concurrent
 * deactivations in ONE process used to interleave and lose one.
 *
 * Temp-DB isolation: repoint config.dbPath BEFORE requiring ../config/database (see api.test.ts).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-plugin-grant-scan-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

const SLUG = `grantscan${process.pid}`;

describe('plugin AST scan: grants, not declarations', () => {
    let core: any, routes: any, perms: any;
    let PLUGINS_DIR: string;
    let updateOption: any;

    const pluginDir = () => path.join(PLUGINS_DIR, SLUG);
    const installTmps: Array<{ dispose: () => void }> = [];

    // The probe plugin: it DECLARES filesystem:write and its code writes a file into its own directory —
    // the exact exfiltration primitive of audit #3 (io-guard leaves a plugin's own dir writable, and the
    // written file was then readable over HTTP). `const fs = require('fs')` is the form the scanner's
    // fs special case anchors on, so this is the code path the grant now has to authorize.
    const PROBE_CODE = [
        "'use strict';",
        "const fs = require('fs');",
        "module.exports.register = function () {};",
        "module.exports.leak = function () { fs.writeFileSync(__dirname + '/leak.txt', 'exfiltrated'); };",
        '',
    ].join('\n');

    const manifestObj = () => ({
        name: 'Grant Scan Probe',
        isolated: true,
        version: '1.0.0',
        permissions: [{ scope: 'filesystem', access: 'write' }],
    });

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        core = require('../core/plugins');
        routes = require('../routes/plugins');
        perms = require('../core/plugin-permissions');
        PLUGINS_DIR = core.PLUGINS_DIR;
        ({ updateOption } = require('../core/options'));
    });

    after(async () => {
        cleanup();
        for (const t of installTmps) { try { t.dispose(); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    });

    beforeEach(async () => {
        cleanup();
        await updateOption('plugin_grants', {});
        await updateOption('active_plugins', []);
        await perms.loadGrants();
    });

    function cleanup() {
        try { fs.rmSync(pluginDir(), { recursive: true, force: true }); } catch { /* */ }
    }

    function newZipPath(): string {
        const t = routes.createInstallTmp();
        installTmps.push(t);
        return t.zipPath;
    }

    /** Run the REAL install pipeline for the probe plugin. Returns installPluginFromZip's {ok,status,body}. */
    async function installProbe() {
        const zip = new AdmZip();
        zip.addFile(`${SLUG}/manifest.json`, Buffer.from(JSON.stringify(manifestObj())));
        zip.addFile(`${SLUG}/index.js`, Buffer.from(PROBE_CODE));
        const p = newZipPath();
        zip.writeZip(p);
        return await routes.installPluginFromZip(p, `${SLUG}.zip`);
    }

    it('INSTALL still succeeds with zero grants — the declaration pass is what feeds the approval screen', async () => {
        const r = await installProbe();
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        assert.strictEqual(r.body.slug, SLUG);
        // And the code really is on disk, so the later cases scan a file the installer wrote.
        assert.ok(fs.existsSync(path.join(pluginDir(), 'index.js')));
        assert.deepStrictEqual(perms.getGrants(SLUG), [], 'install must not grant anything by itself');
    });

    it('ACTIVATION is REFUSED when the admin denied the declared permission (the toggle was inert)', async () => {
        const r = await installProbe();
        assert.strictEqual(r.ok, true, r.body && r.body.error);

        // The administrator denies filesystem:write through the real grant store (this is precisely what
        // POST /plugins/:slug/permissions with an empty `granted` list writes).
        await perms.setGrants(SLUG, []);

        let thrown: any = null;
        try { await core.activatePlugin(SLUG); } catch (e: any) { thrown = e; }

        assert.ok(thrown, 'activation must not succeed while the capability its code needs is denied');
        assert.strictEqual(thrown.code, 'PLUGIN_VALIDATION_FAILED', `unexpected error: ${thrown && thrown.message}`);
        const missing = (thrown.missingPermissions || []).join(' | ');
        assert.match(missing, /Filesystem Write/i, `missingPermissions did not name the capability: ${missing}`);
        // The message must distinguish "you forgot to declare it" from "the admin said no" — otherwise the
        // operator edits manifest.json forever while the actual fix is a switch in /admin/plugins.
        assert.match(missing, /NOT granted by the administrator/i, missing);

        // Fail CLOSED: a refused activation leaves nothing in active_plugins.
        assert.deepStrictEqual(await core.getActivePlugins(), []);
    });

    it('the SAME code passes the grant-mode scan once the admin grants it — the refusal was the grant, not the code', async () => {
        const r = await installProbe();
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8'));

        await perms.setGrants(SLUG, []);
        assert.throws(
            () => core.validatePluginPermissions(SLUG, pluginDir(), manifest, { mode: 'grant' }),
            /Filesystem Write/i,
        );

        await perms.setGrants(SLUG, ['filesystem:write']);
        assert.doesNotThrow(() => core.validatePluginPermissions(SLUG, pluginDir(), manifest, { mode: 'grant' }));
    });

    it("a `filesystem:admin` grant satisfies a declared filesystem:write (one definition of what a token implies)", async () => {
        const r = await installProbe();
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8'));

        await perms.setGrants(SLUG, ['filesystem:admin']);
        assert.doesNotThrow(() => core.validatePluginPermissions(SLUG, pluginDir(), manifest, { mode: 'grant' }));
    });

    it('grant mode is strictly NARROWER: granting an UNDECLARED scope authorizes nothing', async () => {
        const r = await installProbe();
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        // Manifest declares filesystem:write only. Grant a different scope + a read (not write) on this one.
        await perms.setGrants(SLUG, ['database:write', 'filesystem:read']);
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8'));
        assert.throws(
            () => core.validatePluginPermissions(SLUG, pluginDir(), manifest, { mode: 'grant' }),
            /Filesystem Write/i,
        );
    });

    // ── THE SCANNER'S SHAPE MATRIX — A REGRESSION NET, NOT A GATE ─────────────────────────────────────
    //
    // ⚠ THE POPULATION BELOW IS NOT DERIVED FROM ANYTHING. SOURCES, CARRIERS and CALLS are object
    // literals written by hand. Their product is 864 real cases against the real scanner over real
    // files, which is a useful regression net — but it is NOT a gate on the class, and it must never be
    // read as one: the class is "every expression that can hold a value", these are the ones somebody
    // thought of, and the whole reason this file was rewritten is that 27/27 green here coexisted with
    // twelve trivial spellings scanning clean. The twelve are re-checked against the SCANNER in
    // `KNOWN_SPELLINGS` below (so we notice a regression) and against the RUNTIME gate (where the
    // spelling is irrelevant by construction, and where the actual denial lives).
    //
    // What this matrix genuinely pins: that the scanner's resolver classifies a read as a read, does not
    // blanket-refuse (which would make every plugin undeployable and get the gate routed around), and
    // fails CLOSED on the flows it cannot follow.
    //
    //   SOURCES  — ways the module value enters a file;
    //   CARRIERS — ways a value travels from there to the call site;
    //   CALLS    — ways the method is finally invoked.
    //
    // Drives the REAL scanner over REAL files on disk, one throwaway plugin dir per combination.
    describe('the fs gate follows the VALUE, not the spelling', () => {
        const scanDir = path.join(os.tmpdir(), `wordjs-fsforms-${process.pid}`);
        const writeCase = (name: string, code: string): string => {
            const d = path.join(scanDir, name);
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, 'index.js'), code);
            return d;
        };
        const scan = (name: string, code: string, permissions: any[] = [], mode?: 'grant') => {
            const d = writeCase(name, code);
            return () => core.validatePluginPermissions(name, d, { name, permissions }, mode ? { mode } : {});
        };
        after(() => { try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch { /* */ } });

        // How the fs module VALUE enters the file.
        const SOURCES: Record<string, { pre: string; expr: string }> = {
            require:         { pre: '', expr: "require('fs')" },
            requireNode:     { pre: '', expr: "require('node:fs')" },
            requirePromises: { pre: '', expr: "require('fs/promises')" },
            awaitImport:     { pre: '', expr: "(await import('fs'))" },
            promisesOf:      { pre: "const __b = require('fs');", expr: '__b.promises' },
            importNamespace: { pre: "import * as __i from 'fs';", expr: '__i' },
        };
        // How that value TRAVELS to the call site (%S% = the source expression, obj = the expression that
        // ends up holding the module).
        const CARRIERS: Record<string, { pre?: string; obj: string; post?: string }> = {
            direct:              { obj: '%S%' },
            constAlias:          { pre: 'const c1 = %S%;', obj: 'c1' },
            aliasOfAlias:        { pre: 'const c1 = %S%; const c2 = c1;', obj: 'c2' },
            aliasChain:          { pre: 'const c1 = %S%; const c2 = c1; const c3 = c2;', obj: 'c3' },
            assignment:          { pre: 'let c1; c1 = %S%;', obj: 'c1' },
            memberAssignment:    { pre: 'const holder = {}; holder.f = %S%;', obj: 'holder.f' },
            objectLiteral:       { pre: 'const holder = { f: %S% };', obj: 'holder.f' },
            nestedObjectLiteral: { pre: 'const holder = { a: { b: %S% } };', obj: 'holder.a.b' },
            fnReturn:            { pre: 'async function g() { return %S%; }', obj: '(await g())' },
            fnReturnHoisted:     { obj: '(await gLater())', post: 'async function gLater() { return %S%; }' },
            arrowReturn:         { pre: 'const g2 = async () => %S%;', obj: '(await g2())' },
            arrowBlockReturn:    { pre: 'const g3 = async () => { return %S%; };', obj: '(await g3())' },
            objectMethodReturn:  { pre: 'const holder = { async g() { return %S%; } };', obj: '(await holder.g())' },
            fnAlias:             { pre: 'async function g4() { return %S%; } const g5 = g4;', obj: '(await g5())' },
            ternary:             { pre: 'const c1 = Date.now() ? %S% : null;', obj: 'c1' },
            logical:             { pre: 'const c1 = null || %S%;', obj: 'c1' },
            sequence:            { pre: 'const c1 = (0, %S%);', obj: 'c1' },
            declaredAfterUse:    { obj: 'cLate', post: 'const cLate = %S%;' },
        };
        // How the method is finally INVOKED (%V% = the carrier expression).
        const CALLS: Record<string, string> = {
            memberCall:       '%V%.writeFileSync("a", "b");',
            capturedMethod:   'const w = %V%.writeFileSync; w("a", "b");',
            capturedTwice:    'const w0 = %V%.writeFileSync; const w1 = w0; w1("a", "b");',
            destructuredCall: 'const { writeFileSync: wd } = %V%; wd("a", "b");',
            methodOnProperty: 'const box = { m: %V%.writeFileSync }; box.m("a", "b");',
            methodEscapes:    'const w = %V%.writeFileSync; helper(w);',   // handed off ⇒ must fail CLOSED
            moduleEscapes:    'helper(%V%);',                             // ditto, the module itself
            promisesHop:      '%V%.promises.writeFile("a", "b");',
        };

        const build = (src: string, carrier: string, call: string, method = 'writeFileSync'): string => {
            const S = SOURCES[src];
            const C = CARRIERS[carrier];
            const sub = (t: string) => t.replace(/%V%/g, C.obj).replace(/%S%/g, S.expr).replace(/writeFileSync/g, method);
            const body = [sub(C.pre || ''), sub(CALLS[call]), sub(C.post || '')].filter(Boolean).join('\n');
            return `'use strict';\nfunction helper(x) { return x; }\n${S.pre}\nmodule.exports.run = async function () {\n${body}\n};\n`;
        };

        const COMBOS: Array<{ id: string; code: string }> = [];
        for (const src of Object.keys(SOURCES)) {
            for (const carrier of Object.keys(CARRIERS)) {
                for (const call of Object.keys(CALLS)) {
                    COMBOS.push({ id: `${src}.${carrier}.${call}`, code: build(src, carrier, call) });
                }
            }
        }

        it(`demands filesystem:write for ALL ${COMBOS.length} generated shapes (nothing declared ⇒ refused)`, () => {
            const escaped: string[] = [];
            COMBOS.forEach((c, i) => {
                try {
                    scan(`fsform-${i}`, c.code)();
                    escaped.push(c.id);
                } catch (e: any) {
                    const missing = (e.missingPermissions || []).join(' ');
                    if (e.code !== 'PLUGIN_VALIDATION_FAILED' || !/Filesystem Write/i.test(missing)) escaped.push(`${c.id} (${missing || e.message})`);
                }
            });
            assert.deepStrictEqual(escaped, [], `these shapes reached fs with a clean scan:\n${escaped.join('\n')}`);
        });

        it('…and every one of them is REFUSED in grant mode when the admin denied it', async () => {
            // One slug, rewritten per case: the difference under test is the CODE SHAPE, and re-granting
            // per case would only exercise the grant store. Declared in the manifest, denied by the admin.
            const name = 'fsgrant-matrix';
            const declared = [{ scope: 'filesystem', access: 'write' }];
            const d = path.join(scanDir, name);
            fs.mkdirSync(d, { recursive: true });
            await perms.setGrants(name, []);
            const slipped: string[] = [];
            for (const c of COMBOS) {
                fs.writeFileSync(path.join(d, 'index.js'), c.code);
                try {
                    core.validatePluginPermissions(name, d, { name, permissions: declared }, { mode: 'grant' });
                    slipped.push(c.id);
                } catch { /* refused, as it must be */ }
            }
            assert.deepStrictEqual(slipped, [], `the revocation toggle is inert for:\n${slipped.join('\n')}`);
        });

        it('…and every one of them PASSES once the admin grants it (the toggle is the only difference)', async () => {
            const name = 'fsgrant-matrix';
            const declared = [{ scope: 'filesystem', access: 'write' }];
            const d = path.join(scanDir, name);
            fs.mkdirSync(d, { recursive: true });
            await perms.setGrants(name, ['filesystem:write']);
            const overBlocked: string[] = [];
            // `fs/promises` is a HARD block (a dangerousCall, not a missing grant), so its combinations
            // belong to the terminal-refusal case below, not to this one: no grant can ever clear them.
            for (const c of COMBOS.filter((x) => !x.id.startsWith('requirePromises.'))) {
                fs.writeFileSync(path.join(d, 'index.js'), c.code);
                try { core.validatePluginPermissions(name, d, { name, permissions: declared }, { mode: 'grant' }); }
                catch (e: any) { overBlocked.push(`${c.id}: ${(e.missingPermissions || []).join(' ')}`); }
            }
            assert.deepStrictEqual(overBlocked, [], `granted, yet still refused:\n${overBlocked.join('\n')}`);
        });

        it('classifies a READ as a read through the SAME carrier table (fail-closed is not a synonym for write)', () => {
            // A gate that answered "write" to everything would pass the matrix above while making every
            // read-only plugin undeployable. The classification is asserted over the same shapes.
            const wrong: string[] = [];
            Object.keys(CARRIERS).forEach((carrier, i) => {
                const code = build('require', carrier, 'memberCall', 'readFileSync');
                try {
                    scan(`fsread-${i}`, code)();
                    wrong.push(`${carrier}: not flagged at all`);
                } catch (e: any) {
                    const missing = (e.missingPermissions || []).join(' ');
                    if (!/Filesystem Read/i.test(missing) || /Filesystem Write/i.test(missing)) wrong.push(`${carrier}: ${missing}`);
                }
            });
            assert.deepStrictEqual(wrong, [], `reads misclassified:\n${wrong.join('\n')}`);
        });

        // THE OTHER HALF OF THE CLASS: shapes the resolver deliberately does NOT follow must fail CLOSED.
        // A static analysis is never complete; what makes this one honest is that everything it cannot
        // follow costs the permission at the point the value escapes. These are the flows that end
        // somewhere the scan cannot see — including the two-file re-export, which is two individually
        // clean scans that add up to an ungranted write.
        const ESCAPES: Record<string, string> = {
            handedToAFunction:   "const q = require('fs');\nhelper(q);\nfunction helper(x) { return x; }\n",
            handedAsCallbackArg: "const q = require('fs');\nsetTimeout(function (f) { f.writeFileSync('a', 'b'); }, 0, q);\n",
            cjsReexportModule:   "module.exports = require('fs');\n",
            cjsReexportProperty: "exports.fsx = require('fs');\n",
            cjsReexportMethod:   "module.exports.w = require('fs').writeFileSync;\n",
            esmExportConst:      "export const q = require('fs');\n",
            esmExportSpecifier:  "const q = require('fs');\nexport { q };\n",
            esmExportDefault:    "export default require('fs');\n",
            computedMethod:      "const q = require('fs');\nq['write' + 'FileSync']('a', 'b');\n",
            storedInAnArray:     "const box = [require('fs')];\nmodule.exports.b = box;\n",
        };
        for (const [name, code] of Object.entries(ESCAPES)) {
            it(`fails CLOSED when the value escapes the resolver: ${name}`, () => {
                assert.throws(scan(`fsescape-${name}`, code), (e: any) =>
                    e.code === 'PLUGIN_VALIDATION_FAILED'
                    && /Filesystem/i.test(((e.missingPermissions || []).concat(e.dangerousCalls || [])).join(' ')),
                    `${name} handed fs somewhere the scanner cannot follow and scanned clean`);
            });
        }

        it("require('fs/promises') is HARD-blocked, and its calls are still attributed to the fs gate", () => {
            // 'fs/promises' is on SENSITIVE_MODULES and, unlike bare 'fs', is not exempted — so it is a
            // dangerousCall (terminal, not fixable by a grant). The binding must ALSO be resolved, so the
            // operator is told about the capability rather than only about the import.
            assert.throws(scan('fsform-fsp', "const fp = require('fs/promises');\nfp.writeFile('a', 'b');\n"),
                (e: any) => /require\('fs\/promises'\)/.test((e.dangerousCalls || []).join(' '))
                    && /Filesystem Write/i.test((e.missingPermissions || []).join(' ')));
        });

        // The other half of a real gate: shapes that only LOOK like fs must stay clean, or the scanner
        // becomes a blanket refusal and plugin authors route around it.
        const BENIGN: Record<string, string> = {
            sameNamedMethod:   "const store = { writeFileSync(x) { return x; } };\nstore.writeFileSync('a');\nmodule.exports = store;\n",
            sameNamedBinding:  "const { writeFileSync } = require('./util');\nwriteFileSync('a');\n",
            unrelatedModule:   "const p = require('path');\nmodule.exports.j = (a, b) => p.join(a, b);\n",
            localNamedLikeFs:  "module.exports.run = function (fsLike) { return fsLike.size; };\n",
            objectWithFsName:  "const cfg = { fsMode: true };\nmodule.exports.m = () => cfg.fsMode;\n",
        };
        for (const [name, code] of Object.entries(BENIGN)) {
            it(`no false positive: ${name}`, () => {
                assert.doesNotThrow(scan(`fsbenign-${name}`, code));
            });
        }

        // The twelve spellings that walked past the scanner while this file reported 27/27. They are
        // ALSO run against the runtime gate further down — there they are guaranteed by construction,
        // here they are only a regression net for the resolver + the operator-facing message. Hand
        // written, and that is exactly why they are not the thing the product depends on.
        const KNOWN_SPELLINGS: Record<string, string> = {
            classField:            "class Box { fsx = require('fs'); }\nnew Box().fsx.writeFileSync('a','b');\n",
            classStaticField:      "class Box { static fsx = require('fs'); }\nBox.fsx.writeFileSync('a','b');\n",
            classFieldMethod:      "class Box { w = require('fs').writeFileSync; }\nnew Box().w('a','b');\n",
            classFieldPromises:    "class Box { p = require('fs').promises; }\nnew Box().p.writeFile('a','b');\n",
            privateClassField:     "class Box { #fsx = require('fs'); go(){ this.#fsx.writeFileSync('a','b'); } }\nnew Box().go();\n",
            classFieldArrowReturn: "class Box { g = () => require('fs'); }\nnew Box().g().writeFileSync('a','b');\n",
            classFieldAliasedOut:  "class Box { fsx = require('fs'); }\nconst alias = new Box().fsx;\nalias.writeFileSync('a','b');\n",
            classFieldThisMember:  "class Box { fsx = require('fs'); go(){ this.fsx.writeFileSync('a','b'); } }\nnew Box().go();\n",
            thisAssignInCtor:      "class Box { constructor(){ this.fsx = require('fs'); } go(){ this.fsx.writeFileSync('a','b'); } }\nnew Box().go();\n",
            objectGetter:          "const holder = { get f(){ return require('fs'); } };\nholder.f.writeFileSync('a','b');\n",
            objectGetterMethod:    "const holder = { get w(){ return require('fs').writeFileSync; } };\nholder.w('a','b');\n",
            defaultParam:          "function run(m = require('fs')) { m.writeFileSync('a','b'); }\nmodule.exports.run = run;\n",
            defaultParamMethod:    "function run(w = require('fs').writeFileSync) { w('a','b'); }\nmodule.exports.run = run;\n",
        };
        it('the spellings that defeated three rounds of this scanner now cost the permission', () => {
            const clean: string[] = [];
            for (const [name, code] of Object.entries(KNOWN_SPELLINGS)) {
                try {
                    scan(`fsknown-${name}`, `'use strict';\n${code}`)();
                    clean.push(name);
                } catch (e: any) {
                    const said = ((e.missingPermissions || []).concat(e.dangerousCalls || [])).join(' ');
                    if (!/Filesystem Write/i.test(said)) clean.push(`${name} (${said || e.message})`);
                }
            }
            assert.deepStrictEqual(clean, [], `these reached fs with a clean scan:\n${clean.join('\n')}`);
        });
    });

    // ══ THE SCANNER'S EXEMPTIONS, ENUMERATED FROM THE SCANNER ═════════════════════════════════════════
    //
    // The residue pass is the only fail-closed part of the AST scan: an fs value the resolver did not
    // consume is CHARGED the permission. Every entry in core/plugins.ts' two exemption tables is
    // therefore a WEAKENING of it — and one of those entries is precisely how the class stayed open:
    // 'PropertyDefinition', 'MethodDefinition' and 'AssignmentPattern' were listed as whole NODE TYPES
    // that are "not a use of the value", which is true of a class field's NAME and false of its
    // INITIALIZER. A type is not a position.
    //
    // THIS IS A DERIVED GATE. The population is read live from the module's exported tables, so it is
    // not a list anybody has to remember to update. Two properties are demanded of every entry:
    //   (a) it must be POSITIONAL — a predicate that inspects WHICH SLOT the node occupies — unless it
    //       is on the small, explicitly-argued BLANKET list below; and
    //   (b) it must carry a probe proving the complementary slot of the SAME parent type is still
    //       charged (for blanket entries, a probe proving the exemption itself is not a false positive).
    // Add an exemption to core/plugins.ts and this test fails until both are supplied. Widen an existing
    // positional exemption to a blanket one and it fails too.
    describe('the residue pass: every exemption is positional and justified', () => {
        const scanDir = path.join(os.tmpdir(), `wordjs-residue-${process.pid}`);
        after(() => { try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch { /* */ } });
        const scanCode = (name: string, code: string) => {
            const d = path.join(scanDir, name);
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, 'index.js'), `'use strict';\n${code}`);
            return () => core.validatePluginPermissions(name, d, { name, permissions: [] }, {});
        };

        // A parent type where the node can NEVER be a value, whichever slot it sits in — so a predicate
        // over slots would be noise. Each needs an argument, written here, and a no-false-positive probe.
        const BLANKET_ALLOWED: Record<string, string> = {
            ObjectPattern: 'every identifier inside a destructuring pattern is a name being introduced',
            ArrayPattern: 'same as ObjectPattern',
            RestElement: 'the rest target is a name being introduced',
            ImportSpecifier: 'both `imported` and `local` are names, never values',
            ImportDefaultSpecifier: 'the local binding name',
            ImportNamespaceSpecifier: 'the local binding name',
            AwaitExpression: 'the awaited expression is itself evaluated by evalFs one node up',
            ExpressionStatement: 'a bare statement wrapper; its expression is judged',
            ConditionalExpression: 'evalFs folds both branches',
            LogicalExpression: 'evalFs folds both sides',
            SequenceExpression: 'evalFs takes the last expression',
        };

        // For each exemption, code in which an fs value sits under the SAME parent type but in a slot the
        // exemption must NOT cover. `charged: false` marks the blanket ones, where the probe instead
        // proves the exemption is not a false positive.
        const PROBES: Record<string, { code: string; charged: boolean }> = {
            VariableDeclarator:      { code: "const writeFileSync = 1;\nconst q = require('fs');\nhelperX(q);\nfunction helperX(x){return x;}\n", charged: true },
            AssignmentExpression:    { code: "let z;\nz = require('fs');\nhelperX(z);\nfunction helperX(x){return x;}\n", charged: true },
            AssignmentPattern:       { code: "function run(m = require('fs')) { return m; }\nmodule.exports.run = run;\n", charged: true },
            MemberExpression:        { code: "const q = require('fs');\nhelperX(q.writeFileSync);\nfunction helperX(x){return x;}\n", charged: true },
            Property:                { code: "const o = { pick: require('fs') };\nhelperX(o.pick);\nfunction helperX(x){return x;}\n", charged: true },
            PropertyDefinition:      { code: "class Box { fsx = require('fs'); }\nmodule.exports.B = Box;\n", charged: true },
            MethodDefinition:        { code: "class Box { go(){ return require('fs'); } }\nmodule.exports.B = Box;\n", charged: true },
            FunctionDeclaration:     { code: "function g(){ return require('fs'); }\nhelperX(g());\nfunction helperX(x){return x;}\n", charged: true },
            FunctionExpression:      { code: "const g = function(){ return require('fs'); };\nhelperX(g());\nfunction helperX(x){return x;}\n", charged: true },
            ArrowFunctionExpression: { code: "helperX(() => require('fs'));\nfunction helperX(x){return x;}\n", charged: true },
            ClassDeclaration:        { code: "class Box { constructor(){ this.q = require('fs'); } }\nmodule.exports.B = Box;\n", charged: true },
            ClassExpression:         { code: "const Box = class { constructor(){ this.q = require('fs'); } };\nmodule.exports.B = Box;\n", charged: true },
            CatchClause:             { code: "try { null(); } catch (e) { helperX(require('fs')); }\nfunction helperX(x){return x;}\n", charged: true },
            LabeledStatement:        { code: "outer: { helperX(require('fs')); }\nfunction helperX(x){return x;}\n", charged: true },
            BreakStatement:          { code: "outer: while (true) { helperX(require('fs')); break outer; }\nfunction helperX(x){return x;}\n", charged: true },
            ContinueStatement:       { code: "outer: while (true) { helperX(require('fs')); continue outer; }\nfunction helperX(x){return x;}\n", charged: true },
            CallExpression:          { code: "const q = require('fs');\nhelperX(q);\nfunction helperX(x){return x;}\n", charged: true },
            // Blanket entries: prove the exemption itself does not manufacture a false positive.
            ObjectPattern:           { code: "const { join } = require('path');\nmodule.exports.j = join;\n", charged: false },
            ArrayPattern:            { code: "const [a, b] = [1, 2];\nmodule.exports.s = a + b;\n", charged: false },
            RestElement:             { code: "function f(...rest) { return rest.length; }\nmodule.exports.f = f;\n", charged: false },
            ImportSpecifier:         { code: "import { join as fsJoin } from 'path';\nexport const j = fsJoin;\n", charged: false },
            ImportDefaultSpecifier:  { code: "import p from 'path';\nexport const j = p.sep;\n", charged: false },
            ImportNamespaceSpecifier:{ code: "import * as p from 'path';\nexport const j = p.sep;\n", charged: false },
            AwaitExpression:         { code: "module.exports.r = async () => (await Promise.resolve(1)) + 1;\n", charged: false },
            ExpressionStatement:     { code: "let n = 0;\nn = n + 1;\nmodule.exports.n = () => n;\n", charged: false },
            ConditionalExpression:   { code: "module.exports.c = (x) => x ? 1 : 2;\n", charged: false },
            LogicalExpression:       { code: "module.exports.l = (x) => x || 2;\n", charged: false },
            SequenceExpression:      { code: "module.exports.s = (x) => (x, x + 1);\n", charged: false },
        };

        const allExemptions = (): Array<[string, (p: any, n: any) => boolean]> => ([] as any[]).concat(
            Object.entries(core.RESIDUE_NOT_A_USE),
            Object.entries(core.RESIDUE_JUDGED_ELSEWHERE),
        );

        it('every exemption core/plugins.ts declares is either POSITIONAL or an argued blanket', () => {
            const offenders: string[] = [];
            for (const [type, pred] of allExemptions()) {
                // A predicate that ignores its arguments answers true for a fresh, unrelated node — that
                // is what "blanket" means, and it is detectable rather than asserted.
                const isBlanket = (() => { try { return pred({}, { type: '__probe__' }) === true; } catch { return true; } })();
                if (isBlanket && !Object.prototype.hasOwnProperty.call(BLANKET_ALLOWED, type)) {
                    offenders.push(`${type}: exempts the WHOLE node type; every slot of it now hides an fs value. `
                        + 'Make it positional, or add it to BLANKET_ALLOWED with the argument for why no slot can hold a value.');
                }
            }
            assert.deepStrictEqual(offenders, [], offenders.join('\n'));
        });

        it('every exemption carries a probe (adding one without proving it turns this red)', () => {
            const missing = allExemptions().map(([t]) => t).filter((t) => !Object.prototype.hasOwnProperty.call(PROBES, t));
            assert.deepStrictEqual(missing, [],
                `core/plugins.ts exempts these parent types with nothing proving the exemption is safe: ${missing.join(', ')}`);
        });

        for (const [type, probe] of Object.entries(PROBES)) {
            it(`${type}: ${probe.charged ? 'the complementary slot is still CHARGED' : 'the exemption is not a false positive'}`, () => {
                // Only run probes for exemptions that still exist — a removed exemption is a strengthening.
                const live = Object.prototype.hasOwnProperty.call(core.RESIDUE_NOT_A_USE, type)
                    || Object.prototype.hasOwnProperty.call(core.RESIDUE_JUDGED_ELSEWHERE, type);
                if (!live) return;
                const run = scanCode(`residue-${type}`, probe.code);
                if (probe.charged) {
                    assert.throws(run, (e: any) => e.code === 'PLUGIN_VALIDATION_FAILED'
                        && /Filesystem/i.test(((e.missingPermissions || []).concat(e.dangerousCalls || [])).join(' ')),
                        `an fs value under a ${type} slot the exemption must not cover scanned CLEAN`);
                } else {
                    assert.doesNotThrow(run, `the ${type} exemption is refusing code that holds no fs value`);
                }
            });
        }
    });

    it('declaration mode is unchanged: the same manifest+code passes with no grants at all', async () => {
        const r = await installProbe();
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8'));
        await perms.setGrants(SLUG, []);
        // No `mode` ⇒ 'declaration' — the install-time / theme-engine pass.
        assert.doesNotThrow(() => core.validatePluginPermissions(SLUG, pluginDir(), manifest));
    });

    // ══ THE RUNTIME GATE — WHERE THE DENIAL ACTUALLY LIVES ════════════════════════════════════════════
    //
    // Everything above is a static scan of source text, and no amount of it can be complete. THIS is the
    // gate: the effective permission is consulted at the moment of the call, when the module object is
    // already in hand and the syntax that carried it is gone.
    //
    // POPULATION, DERIVED — read live, never restated here:
    //   · core/secure-require's own FS_READ_METHODS / FS_WRITE_METHODS / FS_LINK_DENIED — the exact
    //     names its proxy routes through guardFsCall. Add a name there and it is covered here with no
    //     edit to this file; classify one wrongly and this file says so.
    //   · Node's own `fs` surface (Object.getOwnPropertyNames), for the deny-by-default half: for a
    //     plugin whose filesystem capability the admin refused there must be NO function on `fs` that
    //     does anything, whether or not secure-require has ever heard of it.
    //   · The twelve spellings that defeated the scanner, EXECUTED — not scanned. At this layer they
    //     cannot differ, and demonstrating that is the point.
    //
    // NOT DERIVED, said plainly: the two path LOCATIONS (inside the own dir / outside it) and the
    // handful of positive-control operations are written by hand. They are the axis of the *rule*, not
    // of the population, and there are exactly two of them.
    describe('the runtime refuses a REVOKED capability whatever the code looks like', () => {
        const DENIED = `rtdenied${process.pid}`;   // declares filesystem read+write, admin granted nothing
        const NEVER = `rtnever${process.pid}`;     // declares nothing — private storage, must keep working
        const GRANTED = `rtgrant${process.pid}`;   // declares and was granted — must keep working
        let secureFs: any, runWithContext: any, io: any, secureRequire: any;
        const dirOf = (slug: string) => path.join(PLUGINS_DIR, slug);

        const seed = async (slug: string, permissions: any[], grants: string[]) => {
            const d = dirOf(slug);
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', permissions }));
            io.forgetDeclaredPermissions(slug);   // the manifest cache outlives an install that rewrites it
            await perms.setGrants(slug, grants);
            return d;
        };

        before(async () => {
            secureRequire = require('../core/secure-require');
            io = require('../core/io-guard');
            ({ runWithContext } = require('../core/plugin-context'));
            secureFs = secureRequire.createSecureFs();
            const FS_RW = [{ scope: 'filesystem', access: 'read' }, { scope: 'filesystem', access: 'write' }];
            await seed(DENIED, FS_RW, []);
            await seed(NEVER, [], []);
            await seed(GRANTED, FS_RW, ['filesystem:read', 'filesystem:write']);
        });
        // The suite-wide beforeEach wipes `plugin_grants` between cases, so re-apply this group's grants
        // here (this hook runs after the parent's). Without it the GRANTED control would silently become
        // a second DENIED case and the controls would stop controlling anything.
        beforeEach(async () => {
            await perms.setGrants(DENIED, []);
            await perms.setGrants(NEVER, []);
            await perms.setGrants(GRANTED, ['filesystem:read', 'filesystem:write']);
        });
        after(() => {
            for (const s of [DENIED, NEVER, GRANTED]) { try { fs.rmSync(dirOf(s), { recursive: true, force: true }); } catch { /* */ } }
        });

        /** Call `name` on the plugin-facing fs proxy as `slug`; returns the thrown error, or null. */
        const callAs = (slug: string, name: string, args: any[]): any =>
            runWithContext(slug, () => {
                try { (secureFs as any)[name](...args); return null; } catch (e: any) { return e; }
            });

        it('every fs entry point secure-require classifies is refused inside the plugin OWN dir', () => {
            // The population is secure-require's classification, read live. Two path args are always
            // passed so the two-path ops (copyFile/rename/cp) get a destination to judge; the guard
            // throws before the underlying call, so no file is ever touched.
            const names: string[] = ([] as string[]).concat(
                secureRequire.FS_READ_METHODS, secureRequire.FS_WRITE_METHODS, secureRequire.FS_LINK_DENIED,
            ).filter((n, i, a) => a.indexOf(n) === i);
            assert.ok(names.length >= 40, `the derived population collapsed to ${names.length} names — check the exports`);

            const a = path.join(dirOf(DENIED), 'note.txt');
            const b = path.join(dirOf(DENIED), 'note2.txt');
            const escaped: string[] = [];
            const notOnFs: string[] = [];
            for (const name of names) {
                if (typeof (fs as any)[name] !== 'function') { notOnFs.push(name); continue; }
                const e = callAs(DENIED, name, [a, b]);
                if (!e) escaped.push(`${name}: no error at all`);
                else if (!/RUNTIME SECURITY BLOCK/.test(String(e.message))) escaped.push(`${name}: ${String(e.message).slice(0, 90)}`);
            }
            assert.deepStrictEqual(escaped, [], `the revocation is inert at runtime for:\n${escaped.join('\n')}`);
            // A name in the classification that Node does not have is dead weight, not a hole (it would
            // fall to deny-by-default) — but it means the list and the platform have drifted.
            assert.deepStrictEqual(notOnFs, [], `classified as fs entry points but absent from this Node's fs: ${notOnFs.join(', ')}`);
        });

        it('…and there is NO function on this Node\'s fs that a revoked plugin can still run', async () => {
            // Population from Node itself: whatever secure-require has or has not heard of, the
            // deny-by-default arm of the proxy must cover it. A new fs API in a future Node is included
            // here the day the runtime ships it, with no edit to this file.
            //
            // ROUND-4 FINDING (verify4 #36): "no function on this Node's fs" used to mean
            // `getOwnPropertyNames(fs).filter(n => typeof fs[n] === 'function')`, which is FIRST-LEVEL
            // FUNCTIONS ONLY. `fs.promises` is an object, so the filter threw the whole promise API — ~30
            // entry points, and the one this project's own history records as a BLOCKER ("fs.promises
            // bypass", plugin-sandbox-remediation) — out of the population by construction, leaving it
            // covered by one hand-written example further down. `fs.realpath.native` and
            // `fs.realpathSync.native` are functions hanging off functions and were dropped the same way.
            // All three levels are enumerated here now, and each is asserted to be non-empty so the
            // population cannot silently collapse back.
            const isFn = (o: any, n: string) => { try { return typeof o[n] === 'function'; } catch { return false; } };
            const surface = Object.getOwnPropertyNames(fs).filter((n) => isFn(fs, n));
            const promiseSurface = Object.getOwnPropertyNames((fs as any).promises).filter((n) => isFn((fs as any).promises, n));
            const nativeSurface = surface.filter((n) => isFn((fs as any)[n], 'native'));
            assert.ok(surface.length > 50, `fs surface came back as ${surface.length} names — the enumeration is wrong`);
            assert.ok(promiseSurface.length > 20, `fs.promises surface came back as ${promiseSurface.length} names — the enumeration is wrong`);
            assert.ok(nativeSurface.length >= 2, `expected realpath.native + realpathSync.native, found ${nativeSurface.length}`);

            const a = path.join(dirOf(DENIED), 'note.txt');
            const ran = surface.filter((n) => callAs(DENIED, n, [a, a]) === null);
            const ranNative = nativeSurface.filter((n) => runWithContext(DENIED, () => {
                try { (secureFs as any)[n].native(a); return null; } catch (e: any) { return e; }
            }) === null);

            // The promise proxy REJECTS instead of throwing, so a rejection is the equivalent of a throw
            // and "returned something that never settles" is neither — it is reported on its own terms
            // rather than counted as a refusal.
            const ranPromise: string[] = [];
            for (const n of promiseSurface) {
                const outcome = await runWithContext(DENIED, async () => {
                    try {
                        const r = (secureFs as any).promises[n](a, a);
                        if (!r || typeof r.then !== 'function') return 'ran';
                        return await Promise.race([
                            r.then(() => 'ran', (e: any) => (/RUNTIME SECURITY BLOCK/.test(String(e && e.message)) ? 'refused' : `other: ${String(e && e.message).slice(0, 60)}`)),
                            new Promise((res) => setTimeout(() => res('never settled'), 3000)),
                        ]);
                    } catch (e: any) {
                        return /RUNTIME SECURITY BLOCK/.test(String(e && e.message)) ? 'refused' : `other: ${String(e && e.message).slice(0, 60)}`;
                    }
                });
                if (outcome !== 'refused') ranPromise.push(`promises.${n}: ${outcome}`);
            }

            assert.deepStrictEqual(ran, [], `these fs functions still ran for a plugin whose capability was refused:\n${ran.join('\n')}`);
            assert.deepStrictEqual(ranNative, [], `these fs *.native functions still ran for a revoked plugin:\n${ranNative.join('\n')}`);
            assert.deepStrictEqual(ranPromise, [], `these fs.promises entry points did not refuse a revoked plugin:\n${ranPromise.join('\n')}`);
        });

        // THE CONTROL THAT MAKES THE ABOVE MEAN SOMETHING: a gate that refused everything would pass
        // every assertion so far while making every plugin undeployable — and would then be routed
        // around. A plugin that never asked for the capability keeps its private storage, and a plugin
        // the admin GRANTED keeps working.
        it('a plugin that never declared filesystem keeps its own private storage (control)', () => {
            const f = path.join(dirOf(NEVER), 'cache.txt');
            assert.strictEqual(callAs(NEVER, 'writeFileSync', [f, 'hello']), null);
            assert.strictEqual(String(fs.readFileSync(f, 'utf8')), 'hello');
        });

        it('a plugin the administrator GRANTED writes normally (control)', () => {
            const f = path.join(dirOf(GRANTED), 'cache.txt');
            assert.strictEqual(callAs(GRANTED, 'writeFileSync', [f, 'hello']), null);
            assert.strictEqual(String(fs.readFileSync(f, 'utf8')), 'hello');
        });

        it('flipping the switch takes effect on the NEXT CALL — no reload, no re-scan', async () => {
            const f = path.join(dirOf(GRANTED), 'live.txt');
            assert.strictEqual(callAs(GRANTED, 'writeFileSync', [f, 'before']), null, 'granted plugin must be able to write');
            await perms.setGrants(GRANTED, []);           // exactly what POST /plugins/:slug/permissions writes
            const e = callAs(GRANTED, 'writeFileSync', [f, 'after']);
            assert.ok(e && /RUNTIME SECURITY BLOCK/.test(String(e.message)), 'the revocation did not take effect at the next call');
            assert.strictEqual(String(fs.readFileSync(f, 'utf8')), 'before', 'the write went through anyway');
            await perms.setGrants(GRANTED, ['filesystem:read', 'filesystem:write']);
        });

        // ── THE TWELVE SPELLINGS, EXECUTED ────────────────────────────────────────────────────────────
        // Each entry is real code that OBTAINS the fs value in the shape named and then writes with it.
        // At this layer the shape cannot matter — that is the whole claim — so this is the demonstration
        // that moving the decision to the call site is what closed the class, not another table row.
        const RUNTIME_SPELLINGS: Record<string, (m: any, p: string) => void> = {
            plainConst:        (m, p) => { const q = m; q.writeFileSync(p, 'x'); },
            classField:        (m, p) => { class Box { fsx = m; } new Box().fsx.writeFileSync(p, 'x'); },
            classStaticField:  (m, p) => { class Box { static fsx = m; } (Box as any).fsx.writeFileSync(p, 'x'); },
            privateClassField: (m, p) => { class Box { #fsx = m; go() { this.#fsx.writeFileSync(p, 'x'); } } new Box().go(); },
            classFieldMethod:  (m, p) => { class Box { w = m.writeFileSync; } new Box().w(p, 'x'); },
            thisAssignInCtor:  (m, p) => { class Box { fsx: any; constructor() { this.fsx = m; } } new Box().fsx.writeFileSync(p, 'x'); },
            objectGetter:      (m, p) => { const h = { get f() { return m; } }; h.f.writeFileSync(p, 'x'); },
            objectGetterMethod:(m, p) => { const h = { get w() { return m.writeFileSync; } }; h.w(p, 'x'); },
            defaultParam:      (m, p) => { (function (q: any = m) { q.writeFileSync(p, 'x'); })(); },
            defaultParamMethod:(m, p) => { (function (w: any = m.writeFileSync) { w(p, 'x'); })(); },
            arrowReturn:       (m, p) => { const g = () => m; g().writeFileSync(p, 'x'); },
            handedToAHelper:   (m, p) => { const h = (x: any) => x; h(m).writeFileSync(p, 'x'); },
        };
        it('all of them are refused for the revoked plugin, and the spelling is irrelevant', () => {
            const slipped: string[] = [];
            const target = path.join(dirOf(DENIED), 'spelled.txt');
            for (const [name, run] of Object.entries(RUNTIME_SPELLINGS)) {
                const e = runWithContext(DENIED, () => {
                    try { run(secureFs, target); return null; } catch (err: any) { return err; }
                });
                if (!e || !/RUNTIME SECURITY BLOCK/.test(String(e.message))) slipped.push(`${name}: ${e ? String(e.message).slice(0, 80) : 'no error'}`);
            }
            assert.deepStrictEqual(slipped, [], `spellings that still reached fs:\n${slipped.join('\n')}`);
            assert.ok(!fs.existsSync(target), 'a refused write still created the file');
        });

        it('the fs.promises surface refuses it as well (it rejects rather than throws)', async () => {
            // Separate case because the promises proxy REJECTS: folded into the synchronous table above
            // it would have been recorded as "no error" while the refusal surfaced later as an
            // unhandledRejection — a test that reports green on a working gate for the wrong reason.
            const target = path.join(dirOf(DENIED), 'promised.txt');
            const p = runWithContext(DENIED, () => (secureFs as any).promises.writeFile(target, 'x'));
            await assert.rejects(() => p, /RUNTIME SECURITY BLOCK/);
            assert.ok(!fs.existsSync(target));
        });

        it('the RAW fs module (io-guard\'s patches) refuses it too — not only the require proxy', () => {
            // A plugin that never went through require('fs') at all — code loaded from a directory the
            // AST scan never opens (dist/, a hidden dir, an extensionless file) still executes against
            // the process-wide fs that io-guard patched. That surface must reach the same verdict.
            const f = path.join(dirOf(DENIED), 'raw.txt');
            const e = runWithContext(DENIED, () => {
                try { fs.writeFileSync(f, 'x'); return null; } catch (err: any) { return err; }
            });
            assert.ok(e && e.code === 'EACCES', `raw fs was not confined: ${e && e.message}`);
            assert.ok(!fs.existsSync(f));
        });
    });

    // ── active_plugins: the read-modify-write cycle, not just the write ────────────────────────────────
    it('two concurrent deactivations in ONE process do not lose an update', async () => {
        const a = `${SLUG}a`;
        const b = `${SLUG}b`;
        await updateOption('active_plugins', [a, b]);

        // The REAL producer. prune:false keeps npm out of a unit test; the option mutation — the part that
        // raced — is identical either way. Neither slug is a loaded isolate, so nothing is spawned.
        await Promise.all([
            core.deactivatePlugin(a, { prune: false }),
            core.deactivatePlugin(b, { prune: false }),
        ]);

        // Before serialising the cycle, both calls read [a, b] and the second write clobbered the first,
        // leaving exactly one slug still "active" — a plugin the admin had just turned off.
        assert.deepStrictEqual(await core.getActivePlugins(), []);
    });
});
