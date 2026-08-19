/**
 * The purge's certificate paths are anchored to the INSTALLATION, not to the process's cwd
 * (adversarial re-verify of #27, variant 2).
 *
 * `frontendServesTls()` decides whether a purge goes out over TLS by looking for the certificates the
 * installer wrote. It used to look for them with `path.resolve('certs')` and
 * `path.resolve('..','frontend','certs')` — relative to the CURRENT WORKING DIRECTORY — on the stated
 * assumption that the backend always runs from `backend/`. Nothing enforces that: a systemd unit with
 * `WorkingDirectory` at the repo root, a container with another layout, or a supervisor invoking
 * `node backend/server.js` all break it, and they break it SILENTLY — the predicate answers "there
 * are no certificates", the purge is posted in the clear at a socket that speaks TLS, and the failure
 * does not necessarily arrive through isHandshakeFailure, so it can end up on the once-an-hour
 * channel. A silent open failure resting on an unverified convention.
 *
 * The writer of those files never had this problem: core/certManager resolves
 * `path.resolve(__dirname, '../../certs')`, and config/app.ts derives its root the same way. The
 * reader now agrees with the writer.
 *
 * MUTATION PROOF: put `path.resolve('certs')` back and every test here fails — each one runs the real
 * predicate from a cwd that is NOT the backend directory, which is exactly the deployment the fix is
 * about.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No override: this must exercise the production default, the one derived from the module's own
// location. (The staged-installation tests set WORDJS_BACKEND_ROOT; here its absence is the point.)
delete process.env.WORDJS_BACKEND_ROOT;

const purge = require('../core/frontend-purge');

/** backend/ — the same root certManager writes into, derived independently of the module under test. */
const EXPECTED_ROOT = path.resolve(__dirname, '..', '..');

/**
 * A directory that is not the installation and — this is the load-bearing half — CANNOT CONTAIN it.
 *
 * This used to be `os.tmpdir()` itself, and the negative control below read
 * `!p.startsWith(os.tmpdir())`. That only expresses "not under the cwd" while the installation happens
 * to sit outside the temp directory: true on a developer's checkout, false the moment the tree lives
 * inside one — a clean `git archive` extraction, a CI workspace under TMP, a container that builds in
 * /tmp. There the control fired on the CORRECT answer: every lookup was properly anchored at the
 * installation, and the installation's own absolute path started with the temp prefix. A gate that
 * goes red on the behaviour it defends is as untrustworthy as one that goes green on the behaviour it
 * forbids. A freshly created unique directory is a prefix nothing else can be under, so the control
 * states what it means wherever the tree happens to be checked out.
 */
const ELSEWHERE = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-purge-cwd-'));
after(() => { try { fs.rmSync(ELSEWHERE, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Run `fn` as a process launched from somewhere that is NOT the backend directory. */
function fromAnotherCwd<T>(fn: () => T): T {
    return fromCwd(ELSEWHERE, fn);
}

function fromCwd<T>(dir: string, fn: () => T): T {
    const original = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(original); }
}

/** The exact list of paths the predicate consults, when it is run from `dir`. */
function askedFrom(dir: string): string[] {
    const asked: string[] = [];
    fromCwd(dir, () => purge.frontendServesTls((p: string) => { asked.push(p); return false; }));
    return asked;
}

test('the root is the installation the file belongs to', () => {
    assert.strictEqual(purge.BACKEND_ROOT, EXPECTED_ROOT);
});

test('frontendServesTls looks under the installation, whatever directory the service was started in', () => {
    const asked: string[] = [];
    const answer = fromAnotherCwd(() => purge.frontendServesTls((p: string) => { asked.push(p); return false; }));

    assert.strictEqual(answer, false, 'no certificates staged here — but the ANSWER is not what is on trial');
    assert.ok(asked.length > 0, 'it must have looked somewhere');
    for (const p of asked) {
        assert.ok(
            p.startsWith(EXPECTED_ROOT) || p.startsWith(path.resolve(EXPECTED_ROOT, '..', 'frontend')),
            `every lookup must be anchored to the installation, got ${p}`
        );
        assert.ok(!p.startsWith(ELSEWHERE + path.sep), `and never to the cwd, got ${p}`);
    }
    // The two locations frontend/server.js itself chooses between, in that order.
    assert.strictEqual(asked[0], path.join(EXPECTED_ROOT, '..', 'frontend', 'certs', 'frontend.crt'));
    assert.ok(asked.slice(1).every((p: string) => p.startsWith(path.join(EXPECTED_ROOT, 'certs'))));
});

/**
 * The same property said WITHOUT prefix arithmetic, because prefix arithmetic is what made the gate
 * above fragile: "the answer must not depend on how the process was launched" is exactly a statement
 * that the list is INVARIANT under chdir, and an invariant compares two runs instead of a path against
 * a substring. It cannot be confused by where the tree is checked out, and the mutation that motivated
 * this file — `path.resolve('certs')`, i.e. resolving against the cwd — moves the list by construction.
 */
test('the lookups are the same list whatever directory the service was started in', () => {
    const fromElsewhere = askedFrom(ELSEWHERE);
    assert.ok(fromElsewhere.length > 0, 'it must have looked somewhere');
    for (const dir of [EXPECTED_ROOT, path.resolve(EXPECTED_ROOT, '..'), os.tmpdir()]) {
        assert.deepStrictEqual(askedFrom(dir), fromElsewhere,
            `the certificate lookups moved with the cwd (${dir}) — they are being resolved against ` +
            'process.cwd() instead of the installation the module belongs to');
    }
});

test('the mTLS material is resolved the same way — defaults AND configured relative paths', () => {
    const defaults = fromAnotherCwd(() => purge.clusterCertPaths({}));
    assert.deepStrictEqual(defaults, {
        ca: path.join(EXPECTED_ROOT, 'certs', 'cluster-ca.crt'),
        key: path.join(EXPECTED_ROOT, 'certs', 'backend.key'),
        cert: path.join(EXPECTED_ROOT, 'certs', 'backend.crt'),
    });

    // What the installer writes into wordjs-config.json is relative: it means "inside the install".
    const configured = fromAnotherCwd(() => purge.clusterCertPaths({
        mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
    }));
    assert.deepStrictEqual(configured, defaults, 'a relative mtls path is relative to the install, not the cwd');

    // An operator who writes an absolute path still gets exactly that path.
    const abs = path.join(ELSEWHERE, 'somewhere', 'ca.crt');
    const explicit = fromAnotherCwd(() => purge.clusterCertPaths({ mtls: { ca: abs } }));
    assert.strictEqual(explicit.ca, abs);
});
