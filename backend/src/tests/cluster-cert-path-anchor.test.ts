/**
 * WHERE THE CLUSTER mTLS MATERIAL IS — ONE RESOLVER, AND THE POPULATION IS EVERY READER
 *
 * CLASS: "one declaration" of a path that is really two values computed differently. Wave 4 closed it for
 * backend/src/index.ts and stated the rule — relative `mtls.*` paths are relative to the INSTALLATION
 * (BACKEND_ROOT), which is where certManager writes them, not to whatever directory the process happened
 * to be started in. But the class was drawn as "the calculations of index.ts", so every OTHER reader of
 * the same config key was outside it, and the most expensive one was left behind:
 *
 *   routes/setup.ts decided whether this node is CLUSTER-ENROLLED with `fs.existsSync(path.resolve(
 *   cfg.mtls.cert))`. Started anywhere but backend/, that file does not exist, so the installer treated an
 *   enrolled node as a fresh single-host box: it re-minted a DIFFERENT cluster CA over the certificates
 *   the gateway had issued, dropped the CA private key onto this node, rotated gatewaySecret away from the
 *   gateway's, and re-bound the listener to localhost. scripts/separate-mode-gate.mjs models exactly that
 *   as its 'install-identity' sabotage, and core/frontend-purge's own comment claims to use "the same
 *   predicate as the installer" — two sides the code declares must agree, quietly disagreeing.
 *
 * THIS GATE DERIVES ITS POPULATION: every non-test source file that mentions `mtls`. A new reader that
 * resolves those paths against the cwd is red without anyone remembering to add a row. The one file that
 * is still wrong today is declared BY NAME, and that declaration fails if it ever stops being true.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Resolving a configured mTLS path against the CURRENT WORKING DIRECTORY. The defect, as a pattern. */
const CWD_ANCHORED = /path\.resolve\(\s*[A-Za-z_$][\w$]*(?:\?)?\.mtls(?:\?)?\.[A-Za-z]+\s*\)/;

/**
 * KNOWN-UNFIXED, declared so the debt is visible instead of filtered away.
 *
 * core/system-health.ts:147-148 resolves `config.mtls.cert` and `config.mtls.ca` against the cwd to
 * answer /health/details. It is a REPORTING surface (it can only misreport, not re-mint anything), it is
 * outside this change's scope, and it is reported as residual risk. If it is fixed, this entry must go —
 * the assertion at the end of this test makes sure nobody can forget.
 */
const KNOWN_CWD_ANCHORED = ['core/system-health.ts'];

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'tests' || entry.name === 'tests-integration' || entry.name === 'node_modules') continue;
            sourceFiles(full, out);
        } else if (entry.name.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

test('no reader of config.mtls.* resolves it against the current working directory', () => {
    const offenders: string[] = [];
    const seenKnown = new Set<string>();

    for (const file of sourceFiles(ROOT)) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes('mtls')) continue;
        const hits: string[] = [];
        String(text).split('\n').forEach((line: string, i: number) => {
            const code = line.split('//')[0];
            if (line.trim().startsWith('*')) return;
            if (CWD_ANCHORED.test(code)) hits.push(`${rel}:${i + 1} ${line.trim()}`);
        });
        if (!hits.length) continue;
        if (KNOWN_CWD_ANCHORED.includes(rel)) { seenKnown.add(rel); continue; }
        offenders.push(...hits);
    }

    assert.deepStrictEqual(offenders, [],
        'a configured mTLS path is being resolved against the cwd. Consume the ONE resolver — ' +
        "require('../core/frontend-purge').clusterCertPaths(cfg) — which anchors to BACKEND_ROOT:\n  " +
        offenders.join('\n  '));

    for (const rel of KNOWN_CWD_ANCHORED) {
        assert.ok(seenKnown.has(rel),
            `${rel} is declared as a known cwd-anchored reader but no longer is — remove it from ` +
            'KNOWN_CWD_ANCHORED instead of leaving a stale claim of debt.');
    }
});

test('the installer asks the shared resolver whether this node is enrolled', () => {
    // The half a pattern scan cannot state: the enrolment predicate must be FED by clusterCertPaths, not
    // merely be free of the old expression. Read positively off the source, next to the call it guards.
    const setup = fs.readFileSync(path.join(ROOT, 'routes/setup.ts'), 'utf8');
    // The CALL, not the declaration: `= isEnrolledConfig(` is the assignment inside the install handler.
    const call = setup.indexOf('= isEnrolledConfig(');
    assert.ok(call > 0, 'routes/setup.ts must still decide enrolment with isEnrolledConfig()');
    const window = setup.slice(Math.max(0, call - 1200), call + 400);
    assert.ok(/clusterCertPaths\(/.test(window),
        'the installer must decide "is this node enrolled?" with clusterCertPaths(), the resolver ' +
        'core/frontend-purge declares to be the only one for this config key. Anything else re-mints the ' +
        'cluster CA over an enrolled node when the process is started outside backend/.');
});

test('clusterCertPaths does not move when the process does', () => {
    const { clusterCertPaths } = require('../core/frontend-purge');
    const cfg = { mtls: { ca: 'certs/cluster-ca.crt', key: 'certs/backend.key', cert: 'certs/backend.crt' } };
    const before = clusterCertPaths(cfg);
    const cwd = process.cwd();
    try {
        process.chdir(os.tmpdir());
        const after = clusterCertPaths(cfg);
        assert.deepStrictEqual(after, before,
            'the cluster certificate paths changed when the working directory did — that is the defect');
    } finally {
        process.chdir(cwd);
    }
    // …and an ABSOLUTE configured path still wins untouched, which is what makes the anchor safe to add.
    const absolute = path.join(os.tmpdir(), 'somewhere', 'backend.crt');
    assert.strictEqual(clusterCertPaths({ mtls: { ...cfg.mtls, cert: absolute } }).cert, absolute);
});
