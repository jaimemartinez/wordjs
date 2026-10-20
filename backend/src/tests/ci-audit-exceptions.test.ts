/**
 * scripts/ci-audit.mjs — the per-advisory exceptions of the CI audit gate.
 *
 * The gate blocks every pull request while a production dependency carries a high/critical advisory.
 * scripts/audit-exceptions.json lets ONE advisory of ONE package through when no fixed release exists,
 * for at most 60 days. These tests pin the narrowness of that door: anything else on the same package,
 * any other package, an expired entry or a malformed file must still block. The fixtures model the
 * node-forge advisory (1240912) the gate once excepted; node-forge itself is no longer installed
 * anywhere, and the last block below keeps it that way.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>;
const gate = () => dynamicImport(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'ci-audit.mjs')).href);

const FORGE_ADVISORY = {
    source: 1240912, name: 'node-forge', dependency: 'node-forge', severity: 'high', range: '<=1.4.0',
    title: 'node-forge RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements',
    url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
};
const EXCEPTION = {
    package: 'node-forge', advisory: 1240912, added: '2026-10-06', expires: '2026-11-05', url: FORGE_ADVISORY.url,
    reason: 'No fixed release; WordJS never verifies a signature with node-forge (see the gate file).',
};
const TODAY = '2026-10-10';

/** An `npm audit --json` result with these vulnerabilities; metadata counts are derived from them. */
function auditRun(vulns: Record<string, any>) {
    const meta: any = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const v of Object.values(vulns)) meta[v.severity] += 1;
    meta.total = Object.keys(vulns).length;
    const named: Record<string, any> = {};
    for (const [name, v] of Object.entries(vulns)) named[name] = { name, ...v };
    return { code: meta.high + meta.critical ? 1 : 0, err: '', out: JSON.stringify({ vulnerabilities: named, metadata: { vulnerabilities: meta } }) };
}
const forgeOnly = () => auditRun({ 'node-forge': { severity: 'high', via: [FORGE_ADVISORY], isDirect: true } });

describe('ci-audit exceptions — what gets through', () => {
    it('blocks the node-forge advisory when there is no exception (unchanged behaviour)', async () => {
        const { classify } = await gate();
        const c = classify(forgeOnly(), { today: TODAY });
        assert.strictEqual(c.kind, 'vulnerable');
        assert.match(c.detail, /node-forge \(high\)/);
        // The one-argument form used before exceptions existed still blocks.
        assert.strictEqual(classify(forgeOnly()).kind, 'vulnerable');
    });

    it('lets the excepted advisory through while the exception is active, and reports it', async () => {
        const { classify } = await gate();
        const c = classify(forgeOnly(), { exceptions: [EXCEPTION], today: TODAY });
        assert.strictEqual(c.kind, 'clean');
        assert.deepStrictEqual(c.excepted.map((e: any) => e.advisory), [1240912]);
        // Still active on its last day.
        assert.strictEqual(classify(forgeOnly(), { exceptions: [EXCEPTION], today: '2026-11-05' }).kind, 'clean');
    });

    it('clears a package that is high ONLY through an excepted dependency (acme-client via node-forge)', async () => {
        const { classify } = await gate();
        const run = auditRun({
            'node-forge': { severity: 'high', via: [FORGE_ADVISORY], isDirect: true },
            'acme-client': { severity: 'high', via: ['node-forge'], isDirect: true },
        });
        assert.strictEqual(classify(run, { exceptions: [EXCEPTION], today: TODAY }).kind, 'clean');
    });

    it('moderate advisories beside the excepted one do not matter (they never blocked)', async () => {
        const { classify } = await gate();
        const run = auditRun({
            'node-forge': { severity: 'high', via: [FORGE_ADVISORY, { source: 999, name: 'node-forge', severity: 'moderate', title: 'x' }] },
            'qs': { severity: 'moderate', via: [{ source: 998, name: 'qs', severity: 'moderate', title: 'y' }] },
        });
        assert.strictEqual(classify(run, { exceptions: [EXCEPTION], today: TODAY }).kind, 'clean');
    });
});

describe('ci-audit exceptions — what still blocks', () => {
    it('any OTHER high/critical package blocks, and only it is named', async () => {
        const { classify } = await gate();
        const run = auditRun({
            'node-forge': { severity: 'high', via: [FORGE_ADVISORY] },
            'next': { severity: 'critical', via: [{ source: 1240609, name: 'next', severity: 'critical', title: 'RCE' }] },
        });
        const c = classify(run, { exceptions: [EXCEPTION], today: TODAY });
        assert.strictEqual(c.kind, 'vulnerable');
        assert.match(c.detail, /next \(critical\)/);
        assert.doesNotMatch(c.detail, /node-forge/);
    });

    it('a SECOND high advisory on the excepted package blocks', async () => {
        const { classify } = await gate();
        const run = auditRun({
            'node-forge': { severity: 'high', via: [FORGE_ADVISORY, { source: 1300000, name: 'node-forge', severity: 'high', title: 'another flaw' }] },
        });
        assert.strictEqual(classify(run, { exceptions: [EXCEPTION], today: TODAY }).kind, 'vulnerable');
    });

    it('a dependent that is ALSO vulnerable on its own blocks even though its dependency is excepted', async () => {
        const { classify } = await gate();
        const run = auditRun({
            'node-forge': { severity: 'high', via: [FORGE_ADVISORY] },
            'acme-client': { severity: 'high', via: ['node-forge', { source: 1300001, name: 'acme-client', severity: 'high', title: 'own flaw' }] },
        });
        const c = classify(run, { exceptions: [EXCEPTION], today: TODAY });
        assert.strictEqual(c.kind, 'vulnerable');
        assert.match(c.detail, /acme-client/);
    });

    it('the advisory id must match: the same package with a different advisory blocks', async () => {
        const { classify } = await gate();
        const other = { ...FORGE_ADVISORY, source: 1240913 };
        const run = auditRun({ 'node-forge': { severity: 'high', via: [other] } });
        assert.strictEqual(classify(run, { exceptions: [EXCEPTION], today: TODAY }).kind, 'vulnerable');
    });

    it('the package must match: the same advisory id on another package blocks', async () => {
        const { classify } = await gate();
        const run = auditRun({ 'forge-fork': { severity: 'high', via: [{ ...FORGE_ADVISORY, name: 'forge-fork', dependency: 'forge-fork' }] } });
        assert.strictEqual(classify(run, { exceptions: [EXCEPTION], today: TODAY }).kind, 'vulnerable');
    });

    it('an EXPIRED exception blocks again and says so', async () => {
        const { classify } = await gate();
        const c = classify(forgeOnly(), { exceptions: [EXCEPTION], today: '2026-11-06' });
        assert.strictEqual(c.kind, 'vulnerable');
        assert.match(c.detail, /exception expired: node-forge advisory 1240912 expired 2026-11-05/);
    });

    it('a dependency cycle or a cause of an unknown shape blocks (nothing is cleared by default)', async () => {
        const { classify } = await gate();
        const cycle = auditRun({
            'a': { severity: 'high', via: ['b'] },
            'b': { severity: 'high', via: ['a'] },
        });
        assert.strictEqual(classify(cycle, { exceptions: [EXCEPTION], today: TODAY }).kind, 'vulnerable');
        const odd = auditRun({ 'node-forge': { severity: 'high', via: [FORGE_ADVISORY, 42] } });
        assert.strictEqual(classify(odd, { exceptions: [EXCEPTION], today: TODAY }).kind, 'vulnerable');
        const noCause = auditRun({ 'node-forge': { severity: 'high', via: [] } });
        assert.strictEqual(classify(noCause, { exceptions: [EXCEPTION], today: TODAY }).kind, 'vulnerable');
    });
});

describe('ci-audit exceptions — the file', () => {
    it('rejects malformed entries instead of widening the gate', async () => {
        const { loadExceptions } = await gate();
        const ok = { ...EXCEPTION };
        assert.strictEqual(loadExceptions(JSON.stringify({ exceptions: [ok] })).length, 1);
        const bad: Array<[string, any]> = [
            ['not a list', { exceptions: {} }],
            ['no package', { exceptions: [{ ...ok, package: '' }] }],
            ['advisory as a string', { exceptions: [{ ...ok, advisory: '1240912' }] }],
            ['GHSA instead of the npm id', { exceptions: [{ ...ok, advisory: 'GHSA-86w9-cpqp-85rv' }] }],
            ['impossible date', { exceptions: [{ ...ok, expires: '2026-02-30' }] }],
            ['longer than 60 days', { exceptions: [{ ...ok, expires: '2026-12-06' }] }],
            ['expires before added', { exceptions: [{ ...ok, expires: '2026-10-01' }] }],
            ['no reasoning', { exceptions: [{ ...ok, reason: 'no fix yet' }] }],
        ];
        for (const [label, doc] of bad) assert.throws(() => loadExceptions(JSON.stringify(doc)), Error, label);
        assert.throws(() => loadExceptions('{ not json'), Error);
    });

    it('the committed exceptions file is valid', async () => {
        const { loadExceptions, EXCEPTIONS_FILE } = await gate();
        const list = loadExceptions(fs.readFileSync(EXCEPTIONS_FILE, 'utf8'));
        for (const e of list) assert.ok(e.url.startsWith('https://github.com/advisories/'), `${e.package}: link the advisory`);
    });

    it('a malformed exceptions file makes the gate FAIL, not pass', async () => {
        // Run the real gate against a temporary copy of the script whose exceptions file is broken, from a
        // directory with no lockfile: the file is read before npm audit runs, so it must exit 1 at once.
        const os = require('os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-audit-'));
        try {
            fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'ci-audit.mjs'), path.join(dir, 'ci-audit.mjs'));
            fs.writeFileSync(path.join(dir, 'audit-exceptions.json'), '{ "exceptions": [ { "package": "node-forge" } ] }');
            let code = 0;
            let stderr = '';
            try { execFileSync(process.execPath, [path.join(dir, 'ci-audit.mjs')], { cwd: dir, stdio: 'pipe', timeout: 20000 }); }
            catch (e: any) { code = e.status; stderr = String(e.stderr || ''); }
            assert.strictEqual(code, 1);
            assert.match(stderr, /audit-exceptions\.json exceptions\[0\]/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('node-forge is gone and stays gone', () => {
    // node-forge has unfixed advisories and no maintained release. Certificates, CSRs and the ACME client
    // are built on Node's crypto (backend/src/core/x509.js, gateway/src/x509.js, setup/x509.js,
    // backend/src/core/acme-client.ts); nothing may load it again, and no lockfile may install it, as a
    // direct or a transitive dependency.
    it('no tracked source or test loads node-forge', () => {
        const files = execFileSync('git', ['ls-files', '--', 'gateway', 'setup', 'backend/src', 'backend/scripts', 'frontend/src', 'scripts', 'monolith.js'],
            { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter((f: string) => /\.(c?js|mjs|ts|tsx)$/.test(f));
        const offenders = files.filter((f: string) => {
            const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
            return /require\(\s*['"]node-forge['"]\s*\)|from\s+['"]node-forge['"]|\(\s*['"]node-forge['"]\s*\)/.test(src);
        });
        assert.ok(files.length > 100, `expected to scan the tracked sources, found ${files.length}`);
        assert.deepStrictEqual(offenders, []);
    });

    it('no package manifest or lockfile installs node-forge or acme-client', () => {
        for (const dir of ['.', 'backend', 'frontend', 'gateway', 'setup']) {
            for (const file of ['package.json', 'package-lock.json']) {
                const p = path.join(REPO_ROOT, dir, file);
                if (!fs.existsSync(p)) continue;
                const text = fs.readFileSync(p, 'utf8');
                assert.doesNotMatch(text, /"(node_modules\/)?node-forge"/, `${dir}/${file} installs node-forge`);
                assert.doesNotMatch(text, /"(node_modules\/)?acme-client"/, `${dir}/${file} installs acme-client (it depends on node-forge)`);
            }
        }
    });
});
