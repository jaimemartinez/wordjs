/**
 * THE PATHS backend/src/index.ts RESOLVES MUST NOT DEPEND ON HOW THE PROCESS WAS LAUNCHED.
 *
 * THE CLASS (round-2 re-verify of #27 and of #3): a path that two modules must agree on was COMPUTED
 * TWICE — once against `__dirname` (the installation) and once against `process.cwd()` — so the
 * answer changed with the working directory, and it changed SILENTLY. Two members had already bitten:
 *
 *   · the cluster mTLS material. index.ts did `path.resolve(config.mtls.key)` while
 *     core/frontend-purge's clusterCertPaths() anchored the SAME config key to the installation, where
 *     core/certManager writes it. Launched from anywhere but `backend/` (a systemd unit with
 *     WorkingDirectory at the repo root, a container with another layout, `node backend/server.js`),
 *     index.ts found no certificates: the backend listened in PLAIN HTTP, advertised itself as
 *     http://, and registered with the gateway over the PUBLIC port with `rejectUnauthorized: false`
 *     — while the purge transport, reading the same key, did full mTLS.
 *   · the published roots. index.ts mounted `path.resolve('./themes' | './plugins' | './public')`
 *     while core/io-guard derives SERVED_ROOTS from its own location. When they disagree, the tree the
 *     server publishes is one `servedRootOf()` does not recognise, and the "published ∩ plugin-writable"
 *     channel that #3 closed reopens under a different directory.
 *
 * These tests are stated over the SET, not over the two paths that were reported, and they read the
 * REAL producers: the source of index.ts for what it mounts, io-guard's exported SERVED_ROOTS for what
 * the write guard believes, and clusterCertPaths() for the certificates. A NEW mount, or a new
 * relative path resolved without the anchor, fails here.
 *
 * MUTATION PROOF: put back `path.resolve('./themes')` and "every served root is anchored…" fails;
 * put back `path.resolve(config.mtls.ca)` and "the certificate paths come from the one resolver"
 * fails; add `app.use('/exports', express.static(installPath('exports')))` without declaring it in
 * io-guard and "every served root index.ts mounts is one io-guard knows about" fails.
 *
 * FOLLOW-UP (not in this file's reach): `config.uploads.dir` is still resolved against the cwd by
 * index.ts, io-guard's configuredUploadsRoot(), core/backup.ts, routes/media.ts and models/Media.ts.
 * They agree with each other, so nothing is broken today; aligning the whole set on the installation
 * root is one change per call site and removes the last member of this class.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const INDEX_TS = path.resolve(__dirname, '..', 'index.ts');
const SRC = fs.readFileSync(INDEX_TS, 'utf8');
/** Comments explain the defect by quoting it — the assertions are about CODE. */
// Order matters: JSDoc blocks first, then whole-line `//` comments (several of which contain a `/*`
// inside a URL glob — stripping blocks first swallowed hundreds of real lines), then any single-line
// block comment left over. Nothing multi-line is removed after that.
const CODE = SRC
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    .replace(/\/\*[^\n]*?\*\//g, '');

const { SERVED_ROOTS, servedRootOf } = require('../core/io-guard');
const { clusterCertPaths, BACKEND_ROOT } = require('../core/frontend-purge');
const config = require('../config/app');

/** The anchor index.ts uses, computed the way index.ts computes it. */
const INSTALL_ROOT = path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE MOUNTS ARE DERIVED FROM THE SYNTAX TREE, NOT RECOGNISED BY A REGEX.
//
// ROUND-3 FINDING (verify3 #41): the previous version of this file CLAIMED to derive the mounts
// ("add a mount and it appears in this list by itself") and did not. It ran two regexes:
// `express.static\(\s*([A-Za-z_$][\w$.]*\([^()]*\))` — which only ever matched an argument that is
// itself a CALL — and `const (THEMES_ROOT|PLUGINS_ROOT)\s*=`, a two-name table sitting next to the
// code. Measured against the five plausible shapes of a new mount, four were invisible, including
// `express.static('./exports')`, which is literally the cwd-relative resolution this class exists to
// forbid. The gate reported green while the hole it guards was open.
//
// The extractor below walks the TypeScript AST (typescript is already a backend dependency), so the
// SHAPE of the argument stops mattering: a string literal, an identifier, a call, a member expression
// and `res.sendFile(rel, { root })` are all collected. What the gate then refuses is an argument it
// cannot RESOLVE — assert.fail with the offending text — so an unknown form fails LOUDLY instead of
// disappearing. Identifiers are resolved through the file's own const declarations, which is what
// retires the THEMES_ROOT/PLUGINS_ROOT name list.
//
// The extractor is a pure function of source text; "THE GATE IS FALSIFIABLE" below feeds it five
// mutated copies of the real source and requires every one of them to fail. That test is the mutation
// proof, run on every CI run rather than once by whoever wrote the fix.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ts = require('typescript');

interface MountScan {
    roots: Array<{ where: string; expr: string }>;
    consts: Map<string, string>;
    astStaticCalls: number;
}

/** Every root a source text PUBLISHES: the express.static mounts plus every res.sendFile `root`. */
function scanMounts(src: string): MountScan {
    const sf = ts.createSourceFile('index.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const consts = new Map<string, string>();
    const roots: Array<{ where: string; expr: string }> = [];
    let astStaticCalls = 0;

    const lineOf = (node: any) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const visit = (node: any): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            // Last writer wins is fine: a name declared twice at file scope is already a bug, and the
            // resolver below fails loudly on anything it cannot evaluate either way.
            consts.set(node.name.text, node.initializer.getText(sf));
        }
        if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(sf);
            if (callee === 'express.static') {
                astStaticCalls++;
                const arg = node.arguments[0];
                roots.push({
                    where: `express.static at index.ts:${lineOf(node)}`,
                    expr: arg ? arg.getText(sf) : '<no argument>',
                });
            }
            if (/(^|\.)sendFile$/.test(callee)) {
                // res.sendFile(relative, { root, … }) publishes `root` exactly as a static mount does —
                // it is how /themes and /plugins are served, and the old regex only saw it because the
                // two constants happened to be named in it.
                const opts = node.arguments[1];
                if (opts && ts.isObjectLiteralExpression(opts)) {
                    for (const p of opts.properties) {
                        if (ts.isPropertyAssignment(p) && p.name && p.name.getText(sf) === 'root') {
                            roots.push({
                                where: `${callee} root at index.ts:${lineOf(node)}`,
                                expr: p.initializer.getText(sf),
                            });
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { roots, consts, astStaticCalls };
}

/**
 * Resolve a source expression to the absolute path it produces at runtime.
 *
 * `consts` lets an IDENTIFIER argument be followed to its declaration, so `express.static(EXPORTS_ROOT)`
 * is resolved rather than ignored. Anything else is a hard failure with the text quoted: this gate must
 * never answer "I did not recognise that, so there is nothing here".
 */
function evaluateRootExpression(expr: string, consts: Map<string, string>, seen = new Set<string>()): string {
    const anchored = expr.match(/^installPath\(\s*'([^']+)'\s*\)$/);
    if (anchored) return path.resolve(INSTALL_ROOT, anchored[1]);
    // The one deliberate exception, documented at the call site: the operator-configured uploads dir,
    // resolved exactly as every writer and io-guard's configuredUploadsRoot() resolve it.
    if (expr === 'path.resolve(config.uploads.dir)') return path.resolve(config.uploads.dir);
    // An identifier: follow it to its own declaration in this file (cycles fail through to assert.fail).
    if (/^[A-Za-z_$][\w$]*$/.test(expr) && consts.has(expr) && !seen.has(expr)) {
        seen.add(expr);
        return evaluateRootExpression(consts.get(expr)!, consts, seen);
    }
    assert.fail(
        `backend/src/index.ts serves a root through an expression this gate does not know: \`${expr}\`. ` +
        'Resolve it with installPath() (the installation anchor) and declare the root in core/io-guard SERVED_ROOTS, ' +
        'or teach this test how it resolves — an undeclared served root is a plugin-writable published directory.'
    );
}

/** The whole check, as a function of source text so it can be driven with a MUTATED index.ts. */
function assertEveryMountIsDeclared(src: string): number {
    const { roots, consts, astStaticCalls } = scanMounts(src);
    // ANTI-BLINDNESS: the AST must account for every `express.static(` the code contains. If the two
    // ever disagree the walk is missing calls, and a gate that silently sees fewer mounts than exist is
    // the exact failure this rewrite is about.
    const code = src
        .replace(/\/\*\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
        .replace(/\/\*[^\n]*?\*\//g, '');
    const textualStaticCalls = (code.match(/express\.static\s*\(/g) || []).length;
    assert.strictEqual(astStaticCalls, textualStaticCalls,
        `the AST walk found ${astStaticCalls} express.static call(s) but the text contains ${textualStaticCalls} — the walk is blind to one`);

    for (const { where, expr } of roots) {
        const resolved = evaluateRootExpression(expr, consts);
        assert.notStrictEqual(
            servedRootOf(resolved), null,
            `${where}: index.ts publishes ${resolved}, which core/io-guard does not recognise as a served root — ` +
            'so a plugin may write into it (the published ∩ writable channel of #3)'
        );
    }
    return roots.length;
}

describe('the installation anchor (class: cwd-resolved paths)', () => {
    it('every relative path in index.ts is resolved against the installation, never the cwd', () => {
        // The shape of the defect: `path.resolve('<relative literal>')` with no anchor argument.
        const offenders = [...CODE.matchAll(/path\.resolve\(\s*'(?!\/)([^']*)'\s*\)/g)].map((m) => m[0]);
        assert.deepStrictEqual(
            offenders, [],
            'these resolve against the working directory — use installPath(), or the shared resolver of ' +
            'whichever module owns the file (configManager.CONFIG_FILE, frontend-purge.clusterCertPaths)'
        );
        assert.match(CODE, /const INSTALL_ROOT[\s\S]{0,200}path\.resolve\(__dirname, '\.\.'\)/, 'the anchor itself must come from __dirname');
    });

    it('every served root index.ts mounts is a root core/io-guard already knows about', () => {
        const found = assertEveryMountIsDeclared(SRC);
        assert.ok(found >= 4, `expected the uploads/themes/plugins/public surfaces, found ${found}`);
    });

    it('THE GATE IS FALSIFIABLE: a mount added in ANY shape turns this red', () => {
        // A GATE IS ONLY REAL IF ADDING A MEMBER TURNS IT RED. The previous version of this file was
        // green for four of these five; they are the shapes a new mount is actually written in. Each one
        // is appended to the REAL source and driven through the REAL check, so this is the mutation
        // proof itself rather than a description of one.
        const mutations: Array<[string, string]> = [
            ['a bare relative literal (the cwd resolution this class forbids)',
                "app.use('/exports', express.static('./exports'));"],
            ['a constant, the shape index.ts already uses for THEMES_ROOT/PLUGINS_ROOT',
                "const EXPORTS_ROOT = path.resolve('./exports');\napp.use('/exports', express.static(EXPORTS_ROOT));"],
            ['a cwd-anchored join',
                "app.use('/exports', express.static(path.join(process.cwd(), 'exports')));"],
            ['a member expression',
                "app.use('/exports', express.static(config.exports.dir));"],
            ['correctly anchored but NOT declared in io-guard SERVED_ROOTS',
                "app.use('/exports', express.static(installPath('exports')));"],
            ['a res.sendFile root, the way /themes and /plugins are published',
                "const EXPORTS_ROOT = installPath('exports');\nres.sendFile(rel, { root: EXPORTS_ROOT, dotfiles: 'deny' }, cb);"],
        ];
        for (const [label, mutation] of mutations) {
            assert.throws(
                () => assertEveryMountIsDeclared(`${SRC}\n${mutation}\n`),
                (err: any) => err instanceof assert.AssertionError,
                `MUTATION SURVIVED — "${label}" was added to index.ts and this gate stayed green. ` +
                'That is the defect: an undeclared served root is a plugin-writable published directory.'
            );
        }
        // …and the control: the UNMUTATED source passes, so the assertion above is not failing for an
        // unrelated reason (which is how a mutation test quietly becomes decoration).
        assert.doesNotThrow(() => assertEveryMountIsDeclared(SRC));
    });

    it('the served roots agree with io-guard from ANY working directory', () => {
        const original = process.cwd();
        try {
            process.chdir(os.tmpdir());               // a systemd unit / container / supervisor
            const { roots, consts } = scanMounts(SRC);
            for (const { where, expr } of roots) {
                if (expr.includes('config.uploads.dir')) continue;   // see the follow-up note at the top
                const resolved = evaluateRootExpression(expr, consts);
                assert.ok(
                    SERVED_ROOTS.some((r: string) => resolved === r || resolved.startsWith(r + path.sep)),
                    `${where} resolves to ${resolved} from a foreign cwd — outside every SERVED_ROOT`
                );
            }
        } finally {
            process.chdir(original);
        }
    });

    it('the certificate paths come from the ONE resolver, and land where certManager writes them', () => {
        assert.ok(
            !/path\.resolve\(config\.mtls\./.test(CODE),
            'index.ts must not recompute the cluster cert paths — it consumes clusterCertPaths(config)'
        );
        assert.match(CODE, /clusterCertPaths\(config\)/, 'the listener/registration leg reads the shared resolver');

        // certManager writes to path.resolve(__dirname, '../../certs') from core/ — i.e. <install>/certs.
        const certManagerDir = path.resolve(__dirname, '..', 'core', '..', '..', 'certs');
        const original = process.cwd();
        try {
            process.chdir(os.tmpdir());
            // Iterate the whole key set: a fourth mtls key added later is covered by the same sentence.
            const relative = { mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' } };
            const resolved = clusterCertPaths(relative);
            for (const key of Object.keys(relative.mtls) as Array<'ca' | 'key' | 'cert'>) {
                assert.strictEqual(
                    path.dirname(resolved[key]), certManagerDir,
                    `mtls.${key} must resolve into the installation's certs dir regardless of the cwd`
                );
                assert.strictEqual(resolved[key], path.resolve(BACKEND_ROOT, relative.mtls[key].slice(2)));
            }
            // An ABSOLUTE configured path is still returned untouched — operators who set one keep it.
            const abs = path.join(os.tmpdir(), 'my-ca.crt');
            assert.strictEqual(clusterCertPaths({ mtls: { ca: abs } }).ca, abs);
        } finally {
            process.chdir(original);
        }
    });

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // AND THE SAME SENTENCE OVER THE WHOLE TREE, NOT OVER ONE FILE.
    //
    // ROUND-3 FINDING (verify3 #40, #42): "index.ts must not recompute the cluster cert paths" was
    // asserted about index.ts ALONE, so the class was declared closed while three other modules kept
    // their own arithmetic — and each of them is a live consequence:
    //   · core/system-health.ts checkMtls() does `path.resolve(config.mtls.cert)`, so /health/details
    //     reports NOT_CONFIGURED from any cwd but backend/ while the node is doing full mTLS.
    //   · core/cert-manager.ts CONCATENATES (`path.resolve(__dirname,'../../' + cfg.mtls.key)`), which
    //     changes the answer for an ABSOLUTE configured path: cert upload dies with "key not found"
    //     while registration and purge work.
    // The scan below is over every non-test file in backend/src. New offenders fail. The known ones are
    // listed with their finding, and the list is checked in BOTH directions — an entry that no longer
    // matches fails too, so a fix forces the entry out instead of leaving a scar.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    const MTLS_RECOMPUTE_SHAPES: Array<[string, RegExp]> = [
        ['path.resolve(<cfg>.mtls.<k>) — resolved against the cwd', /path\.resolve\(\s*[A-Za-z_$][\w$.?]*\.mtls[.?[][^)]*\)/],
        ['path.resolve(__dirname, \'…\' + <cfg>.mtls.<k>) — concatenated, so an absolute path moves',
            /path\.resolve\([^;]*__dirname[^;]*\+\s*[A-Za-z_$][\w$.?]*\.mtls\b/],
    ];
    /** file → the finding that owns it. Not this group's files to fix; this gate stops the set growing. */
    const KNOWN_MTLS_RECOMPUTERS: Record<string, string> = {
        'core/system-health.ts': 'verify3 #40 — /health/details reports NOT_CONFIGURED while the node does mTLS',
        'core/cert-manager.ts': 'verify3 #42 — concatenation relocates an absolute configured path',
    };

    function backendSources(dir: string, acc: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'tests' || entry.name === 'tests-integration' || entry.name === 'node_modules') continue;
                backendSources(full, acc);
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                acc.push(full);
            }
        }
        return acc;
    }

    it('NO module in backend/src recomputes the cluster cert paths — the resolver is one function', () => {
        const SRC_ROOT = path.resolve(__dirname, '..');
        const offenders: Record<string, string[]> = {};
        for (const file of backendSources(SRC_ROOT)) {
            const body = fs.readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
            for (const [label, re] of MTLS_RECOMPUTE_SHAPES) {
                if (re.test(body)) {
                    const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
                    (offenders[rel] ||= []).push(label);
                }
            }
        }

        const unexpected = Object.keys(offenders).filter((f) => !(f in KNOWN_MTLS_RECOMPUTERS)).sort();
        assert.deepStrictEqual(unexpected, [],
            'a module recomputes the cluster mTLS paths instead of consuming clusterCertPaths(config). Two ' +
            'answers for one config key is how this site ended up doing mTLS on one leg and cleartext on ' +
            `another with no message: ${JSON.stringify(offenders)}`);

        const stale = Object.keys(KNOWN_MTLS_RECOMPUTERS).filter((f) => !(f in offenders)).sort();
        assert.deepStrictEqual(stale, [],
            `these are listed as known recomputers but no longer match — the finding is fixed, so delete the ` +
            `entry (a stale exemption is a hole waiting to be re-used): ${stale.join(', ')}`);

        // index.ts specifically must be clean — it is the one this class was first found in.
        assert.ok(!('index.ts' in offenders), 'index.ts must consume clusterCertPaths(config)');
    });

    it('the boot fallback restores the config file the process actually reads', () => {
        const { CONFIG_FILE } = require('../core/configManager');
        assert.match(CODE, /CONFIG_FILE: configFile/, 'the fallback must reuse configManager\'s declaration');
        assert.ok(!/path\.resolve\('wordjs-config/.test(CODE), 'a second declaration of the config path is a fallback that restores nothing');
        assert.ok(path.isAbsolute(CONFIG_FILE));
    });
});

describe('a peer answer may not rewrite this site\'s identity unauthenticated', () => {
    it('the gateway /info sync only runs over the mTLS channel', () => {
        // THE CLASS again, on the other side: a decision taken from data a PEER supplied while a
        // verified attribute (its cluster certificate) is available. Without mTLS the /info request
        // goes to the gateway's PUBLIC port with rejectUnauthorized:false, and its `siteUrl` used to be
        // written straight into the options table — every admin link and password-reset mail with it.
        const sync = CODE.slice(CODE.indexOf('const syncFromGateway'), CODE.indexOf('const registerAll'));
        assert.ok(sync.length > 100, 'syncFromGateway not found — update this gate');
        assert.match(sync, /if \(!useMtls\) return;/, 'the sync must refuse to run on the unauthenticated bootstrap leg');
        assert.ok(!/useMtls \? https : http/.test(sync), 'no cleartext variant may remain on this leg');
    });
});

describe('permanent purge faults: an ambiguous signal is not a verdict', () => {
    const { isHandshakeFailure, clusterTlsOptions, purgeFailureState } = require('../core/frontend-purge');

    it('NO error code is a handshake failure once the handshake demonstrably completed', () => {
        // The verified attribute (the socket negotiated TLS) beats the ambiguous label (the code).
        // ECONNRESET is the signature of BOTH a refused client certificate and a peer restarting —
        // and a rolling frontend restart coincides with purges by construction, because publishing is
        // what triggers them. Stated over the whole code table so a code added later is covered.
        const codes = ['ECONNRESET', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_SSL_WRONG_VERSION_NUMBER'];
        for (const code of codes) {
            assert.strictEqual(isHandshakeFailure({ code, message: code }, true, false), true, `${code} before the handshake`);
            assert.strictEqual(isHandshakeFailure({ code, message: code }, true, true), false, `${code} AFTER the handshake completed`);
        }
    });

    it('and the transport actually OBSERVES the handshake — a classifier nobody feeds is decoration', () => {
        const purgeSrc = fs.readFileSync(path.resolve(__dirname, '..', 'core', 'frontend-purge.ts'), 'utf8');
        assert.match(purgeSrc, /req\.on\('socket'[\s\S]{0,300}secureConnect/, 'send() must watch the socket to know whether TLS came up');
        assert.match(purgeSrc, /isHandshakeFailure\(e, overTls, handshakeCompleted\)/, 'the observation must reach the classifier');
    });

    it('a recorded fault expires if it is never re-observed — the panel must not keep a scar', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-purge-ttl-'));
        // REAL producer: unreadable cluster material is what records a permanent fault.
        assert.strictEqual(clusterTlsOptions({ mtls: { ca: path.join(dir, 'nope.crt'), key: path.join(dir, 'nope.key'), cert: path.join(dir, 'nope.crt') } }), null);
        assert.ok(purgeFailureState().length, 'precondition: the fault was recorded');

        const realNow = Date.now;
        try {
            Date.now = () => realNow() + 31 * 60 * 1000;   // half an hour later, no purge attempted
            assert.deepStrictEqual(purgeFailureState(), [], 'an unconfirmed fault must not be asserted forever');
        } finally {
            Date.now = realNow;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
