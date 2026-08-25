/**
 * F6 certification — PROCESS FAILURE DURING A TRANSACTION, on every certified SQL engine.
 *
 * `f0-content-mutation-failures.test.ts` injects five THROWN failures into the content mutation and
 * proves each one rolls back. This is its harder sibling: the process is KILLED mid-mutation instead.
 * The difference is not cosmetic. A thrown error still unwinds inside the process — the transaction
 * helper's `catch` runs, `ROLLBACK` is issued, `finally` blocks fire, the after-commit queue is
 * discarded. SIGKILL gives none of that: no catch, no finally, no atexit, no flush. Everything the
 * mutation had written is left to the ENGINE to undo, and every guarantee F0/F3 state ("no post
 * without its meta, its terms and its initial revision") has to survive without a single line of
 * WordJS code running. That is the case a thrown-error suite structurally cannot reach.
 *
 * HOW IT WORKS. A child process boots the real backend, authenticates, and issues the real
 * `POST /api/v1/posts` — the route whose single `runContentMutation` spans post → terms → metadata →
 * initial revision (routes/posts.ts). One stage is replaced with a SIGKILL of the child's own pid.
 * The parent then reopens the database and asserts the post, its terms, its metadata, its revision
 * and its outbox event are ALL absent.
 *
 * THE DEFECT EACH INJECTION POINT IS AIMED AT:
 *   · `meta`     — the kill lands after the post row and its term relationships are written. A row
 *                  visible without the taxonomy the request asked for is the "post without its terms"
 *                  half-state; a categorised post with no metadata is the other half.
 *   · `revision` — the kill lands after post, terms AND metadata, i.e. at the moment of MAXIMUM
 *                  partial state, one statement short of COMMIT. If the boundary is not really one
 *                  transaction, this is where a complete-looking post with no history survives.
 *
 * TWO ANTI-VACUITY GUARDS, because "assert nothing was written" is the easiest test in the world to
 * pass for the wrong reason — a child that died during `npm` resolution, a typo'd table name, an
 * engine that was never reachable would all produce a serene green:
 *   1. A CONTROL run performs the same request with NO kill and asserts the post, its term
 *      relationship, its metadata AND its initial revision all DO exist. The harness has to be able
 *      to produce the state before its absence means anything.
 *   2. Every crash run requires the child to have written a marker file from inside the injected
 *      stage. No marker ⇒ the child never reached the mutation ⇒ the test FAILS instead of passing.
 *
 * SKIP POLICY is the repository's existing one: a graceful skip locally, a HARD FAILURE under
 * WORDJS_CI_DB=1, where the service containers are wired precisely so the engine IS exercised.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-f6-crash-${STAMP}-`));
const TMP_DB = path.join(TMP_DIR, 'f6-crash.db');
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const { dbAsync } = database;

/**
 * F6_CERTIFIED_ENGINES — must be IDENTICAL to the array in f6-outbox-idempotence.test.ts.
 * `.github/workflows/f6-certification.yml` greps both files and refuses to run if they disagree or if
 * an engine named here has no service container. See that workflow's "engine matrix" gate.
 */
const F6_CERTIFIED_ENGINES = ['sqlite-native', 'postgres', 'mysql'];

/** Dedicated certification database — never the shared `wordjs` one other suites mutate. */
const CERT_DB = 'wordjs_f6cert';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const CHILD_SCRIPT = path.join(TMP_DIR, 'f6-crash-child.js');

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${++sequence}`;

const withTimeout = (promise: Promise<any>, ms: number) => {
    let timer: any;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(`F6 certification cannot skip in CI: ${reason}`);
    return t.skip(reason);
}

function engineCoordinates(engine: string): Record<string, any> {
    if (engine === 'postgres') {
        return {
            host: process.env.PGHOST || '127.0.0.1',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD ?? 'password',
            name: process.env.PGDATABASE || 'wordjs',
        };
    }
    return {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
        name: process.env.MYSQL_DB || 'wordjs',
    };
}

async function bringUpEngine(engine: string): Promise<string | null> {
    if (engine === 'sqlite-native') {
        try { require('../drivers/sqlite-native-async').dbPath = TMP_DB; }
        catch (error: any) { return `better-sqlite3 not loadable: ${error && error.message}`; }
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        return null;
    }

    let driver: any;
    try { driver = require(`../drivers/${engine}`); }
    catch (error: any) { return `${engine} driver not loadable: ${error && error.message}`; }

    const base = engineCoordinates(engine);
    driver.config = { ...base };
    try { await withTimeout(driver.connect(), 8000); }
    catch (error: any) { return `no reachable ${engine}: ${error && error.message}`; }
    try {
        if (engine === 'postgres') {
            const present = await driver.get('SELECT 1 AS present FROM pg_database WHERE datname = ?', [CERT_DB]);
            if (!present) await driver.exec(`CREATE DATABASE ${CERT_DB}`);
        } else {
            await driver.exec(`CREATE DATABASE IF NOT EXISTS \`${CERT_DB}\``);
        }
    } catch (error: any) {
        try { await driver.close(); } catch { /* best effort */ }
        return `cannot provision the ${engine} certification database: ${error && error.message}`;
    }
    try { await driver.close(); } catch { /* best effort */ }

    driver.config = { ...base, name: CERT_DB };
    await database.init({ driver: engine });
    await database.initializeDatabase();
    return null;
}

/**
 * The child. Plain JS on purpose — it is loaded by `node -r ts-node/register`, so its `require`s of
 * the backend's .ts modules compile on the fly while the entry file itself needs no build step.
 *
 * Ordering is load-bearing: `core/revisions` must be patched BEFORE `routes` is required, because
 * routes/posts.ts destructures `saveRevision` at module load (the same ordering constraint
 * f0-content-mutation-failures.test.ts documents). `Post.setTerms`/`Post.updateMeta` are called as
 * properties, so those can be patched at any time.
 *
 * The kill marker is written with writeFileSync, never console output: SIGKILL discards whatever is
 * still sitting in the stdout pipe, so a buffered marker would be lost exactly when it matters.
 */
const CHILD_SOURCE = [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const BACKEND = process.env.F6_BACKEND_ROOT;",
    "const ENGINE = process.env.F6_ENGINE;",
    "const STAGE = process.env.F6_STAGE;",
    "const TITLE = process.env.F6_TITLE;",
    "const MARKER = process.env.F6_MARKER;",
    "const OUTCOME = process.env.F6_OUTCOME;",
    "const CATEGORY = Number(process.env.F6_CATEGORY_ID);",
    "const mod = (rel) => require(path.join(BACKEND, 'src', rel));",
    "// The script itself is written to a temp directory, so bare package names would resolve against",
    "// that directory's (non-existent) node_modules. Resolve them from the backend package instead.",
    "const dep = (name) => require(require.resolve(name, { paths: [BACKEND] }));",
    "",
    "const config = mod('config/app');",
    "if (ENGINE === 'sqlite-native') {",
    "    config.dbPath = process.env.F6_DB_PATH;",
    "    config.dbDriver = 'sqlite-native';",
    "    mod('drivers/sqlite-native-async').dbPath = process.env.F6_DB_PATH;",
    "} else {",
    "    mod('drivers/' + ENGINE).config = {",
    "        host: process.env.F6_DB_HOST,",
    "        port: Number(process.env.F6_DB_PORT),",
    "        user: process.env.F6_DB_USER,",
    "        password: process.env.F6_DB_PASSWORD,",
    "        name: process.env.F6_DB_NAME,",
    "    };",
    "}",
    "",
    "function crash(stage) {",
    "    fs.writeFileSync(MARKER, stage);",
    "    process.kill(process.pid, 'SIGKILL');",
    "    return new Promise(function () { /* the pid is already gone */ });",
    "}",
    "",
    "const revisions = mod('core/revisions');",
    "const realSaveRevision = revisions.saveRevision;",
    "revisions.saveRevision = function () {",
    "    if (STAGE === 'revision') return crash('revision');",
    "    return realSaveRevision.apply(revisions, arguments);",
    "};",
    "",
    "const Post = mod('models/Post');",
    "const realUpdateMeta = Post.updateMeta;",
    "Post.updateMeta = function () {",
    "    if (STAGE === 'meta') return crash('meta');",
    "    return realUpdateMeta.apply(Post, arguments);",
    "};",
    "",
    "(async function () {",
    "    const database = mod('config/database');",
    "    await database.init({ driver: ENGINE });",
    "    const dbAsync = database.getDbAsync();",
    "    await mod('core/post-types').initPostTypes();",
    "    await mod('core/roles').loadRoles();",
    "",
    "    const user = await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['f6admin']);",
    "    if (!user) throw new Error('the parent did not seed the f6admin user');",
    "",
    "    const express = dep('express');",
    "    const request = dep('supertest');",
    "    const jwt = dep('jsonwebtoken');",
    "    const app = express();",
    "    app.use(express.json());",
    "    app.use('/api/v1', mod('routes'));",
    "    app.use(mod('middleware/errorHandler').errorHandler);",
    "    const token = jwt.sign(",
    "        { userId: user.id, username: 'f6admin' },",
    "        config.jwt.secret,",
    "        { algorithm: 'HS256', expiresIn: '1h' }",
    "    );",
    "",
    "    const response = await request(app)",
    "        .post('/api/v1/posts')",
    "        .set('Authorization', 'Bearer ' + token)",
    "        .send({ title: TITLE, content: 'f6 crash body', categories: [CATEGORY], meta: { f6_probe: 'partial' } });",
    "    fs.writeFileSync(OUTCOME, String(response.status));",
    "    process.exit(0);",
    "})().catch(function (error) {",
    "    try { fs.writeFileSync(OUTCOME, 'ERROR ' + ((error && error.stack) || error)); } catch (e) { /* best effort */ }",
    "    process.exit(3);",
    "});",
    "",
].join('\n');

type ChildResult = { status: number | null; signal: string | null; marker: string | null; outcome: string | null };

/** Run one real content mutation in a separate OS process, optionally killing it mid-transaction. */
function runChild(engine: string, stage: 'none' | 'meta' | 'revision', title: string, categoryId: number): ChildResult {
    const marker = path.join(TMP_DIR, `marker-${++sequence}.txt`);
    const outcome = path.join(TMP_DIR, `outcome-${sequence}.txt`);
    const coordinates = engine === 'sqlite-native' ? null : engineCoordinates(engine);

    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', CHILD_SCRIPT], {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
        // Five minutes is far past the observed ~10s child boot; it exists so a hung child fails the
        // suite instead of inheriting the runner's own timeout, for the same reason every job in this
        // repository carries a measured timeout-minutes.
        timeout: 300_000,
        env: {
            ...process.env,
            TS_NODE_TRANSPILE_ONLY: '1',
            F6_BACKEND_ROOT: BACKEND_ROOT,
            F6_ENGINE: engine,
            F6_STAGE: stage,
            F6_TITLE: title,
            F6_MARKER: marker,
            F6_OUTCOME: outcome,
            F6_CATEGORY_ID: String(categoryId),
            F6_DB_PATH: TMP_DB,
            ...(coordinates
                ? {
                    F6_DB_HOST: String(coordinates.host),
                    F6_DB_PORT: String(coordinates.port),
                    F6_DB_USER: String(coordinates.user),
                    F6_DB_PASSWORD: String(coordinates.password),
                    F6_DB_NAME: CERT_DB,
                }
                : {}),
        },
    });

    const readIfPresent = (file: string) => {
        try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; }
        catch { return null; }
    };
    return {
        status: result.status,
        signal: result.signal,
        marker: readIfPresent(marker),
        outcome: readIfPresent(outcome),
    };
}

async function scalar(sql: string, params: any[] = []): Promise<number> {
    const row = await dbAsync.get(sql, params);
    if (!row) return 0;
    const value = row.c ?? row.C ?? Object.values(row)[0];
    return Number(value) || 0;
}

// One cleanup for the whole file: every engine leg spawns the same child script out of TMP_DIR, so the
// directory has to outlive the first leg's after() hook.
after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

for (const engine of F6_CERTIFIED_ENGINES) {
    describe(`F6 crash consistency on ${engine}`, () => {
        let unavailable: string | null = 'engine not brought up';
        let categoryId = 0;
        let categoryTaxonomyId = 0;

        before(async () => {
            try { unavailable = await bringUpEngine(engine); }
            catch (error: any) { unavailable = `${engine} bootstrap failed: ${error && error.message}`; }
            if (unavailable) return;

            fs.writeFileSync(CHILD_SCRIPT, CHILD_SOURCE);

            const existing = await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['f6admin']);
            if (!existing) {
                const inserted = await dbAsync.run(
                    `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
                    ['f6admin', 'f6admin@example.com', 'F6 Admin']
                );
                await dbAsync.run(
                    `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
                    [inserted.lastID]
                );
            }

            const term = await dbAsync.get('SELECT term_id FROM terms WHERE slug = ?', ['f6-certification']);
            if (term) {
                categoryId = Number(term.term_id);
            } else {
                const insertedTerm = await dbAsync.run(
                    'INSERT INTO terms (name, slug) VALUES (?, ?) RETURNING term_id',
                    ['F6 Certification', 'f6-certification']
                );
                categoryId = Number(insertedTerm.lastID);
            }
            const taxonomy = await dbAsync.get(
                'SELECT term_taxonomy_id FROM term_taxonomy WHERE term_id = ? AND taxonomy = ?',
                [categoryId, 'category']
            );
            if (taxonomy) {
                categoryTaxonomyId = Number(taxonomy.term_taxonomy_id);
            } else {
                const insertedTaxonomy = await dbAsync.run(
                    `INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count)
                     VALUES (?, 'category', '', 0, 0) RETURNING term_taxonomy_id`,
                    [categoryId]
                );
                categoryTaxonomyId = Number(insertedTaxonomy.lastID);
            }
        });

        after(async () => {
            // Close the SQLite file so the temp directory can be removed at the end of the FILE — not
            // here. TMP_DIR also holds the child script every later engine still needs to spawn, and
            // deleting it per-engine broke the Postgres and MySQL legs the moment they were reachable
            // (ENOENT inside before()) while looking perfectly healthy on a laptop with neither engine
            // installed. That asymmetry — cleanup that only misfires where the coverage actually runs —
            // is the certification-suite version of a gate that is green because it never executes.
            // Closing on EVERY engine also matters for a clean exit: a live Postgres/MySQL pool keeps
            // the event loop alive, and --test-force-exit then hard-kills the subprocess mid-IPC — the
            // intermittent deserialization failure driver-conformance.test.ts documents.
            try { await database.closeDatabase(); } catch { /* best effort */ }
        });

        /**
         * ANTI-VACUITY CONTROL. Without this, every "nothing was written" assertion below would pass
         * just as happily against a child that died before it ever opened a transaction.
         */
        test('control: an uninterrupted child writes the post, its terms, its meta and its initial revision', async (t: any) => {
            if (unavailable) return skipOrFail(t, unavailable);
            const title = unique('f6-crash-control');
            const child = runChild(engine, 'none', title, categoryId);

            assert.strictEqual(child.status, 0, `the control child must exit cleanly, got status=${child.status} signal=${child.signal} outcome=${child.outcome}`);
            assert.strictEqual(child.outcome, '201', 'the control request must be a successful creation');
            assert.strictEqual(child.marker, null, 'no stage was injected, so no kill marker may exist');

            const post = await dbAsync.get('SELECT id FROM posts WHERE post_title = ? AND post_type <> ?', [title, 'revision']);
            assert.ok(post, 'the control post exists');
            assert.strictEqual(
                await scalar('SELECT COUNT(*) AS c FROM term_relationships WHERE object_id = ? AND term_taxonomy_id = ?', [post.id, categoryTaxonomyId]),
                1,
                'the control post carries the category the request asked for'
            );
            assert.strictEqual(
                await scalar(`SELECT COUNT(*) AS c FROM post_meta WHERE post_id = ? AND meta_key = 'f6_probe'`, [post.id]),
                1,
                'the control post carries its metadata'
            );
            assert.strictEqual(
                await scalar(`SELECT COUNT(*) AS c FROM posts WHERE post_parent = ? AND post_type = 'revision'`, [post.id]),
                1,
                'the control post carries its initial revision'
            );
            assert.strictEqual(
                await scalar('SELECT COUNT(*) AS c FROM content_outbox WHERE aggregate_id = ?', [post.id]),
                1,
                'the control mutation persisted exactly one content event'
            );
        });

        for (const stage of ['meta', 'revision'] as const) {
            test(`SIGKILL at the ${stage} stage leaves no post, no terms, no meta, no revision and no event`, async (t: any) => {
                if (unavailable) return skipOrFail(t, unavailable);
                const title = unique(`f6-crash-${stage}`);
                const outboxBefore = await scalar('SELECT COUNT(*) AS c FROM content_outbox', []);
                const relationshipsBefore = await scalar(
                    'SELECT COUNT(*) AS c FROM term_relationships WHERE term_taxonomy_id = ?',
                    [categoryTaxonomyId]
                );
                const revisionsBefore = await scalar(`SELECT COUNT(*) AS c FROM posts WHERE post_type = 'revision'`, []);

                const child = runChild(engine, stage, title, categoryId);

                // GUARD 1: the child really reached the injected stage. A child that failed to boot,
                // failed to authenticate or hit a 400 would otherwise leave the database untouched and
                // make every assertion below true for a reason that has nothing to do with atomicity.
                assert.strictEqual(
                    child.marker,
                    stage,
                    `the child never reached the ${stage} stage (status=${child.status} signal=${child.signal} outcome=${child.outcome})`
                );
                // GUARD 2: it really died there rather than completing the request.
                assert.notStrictEqual(child.status, 0, 'a SIGKILLed process cannot report a clean exit');
                assert.strictEqual(child.outcome, null, 'a killed child cannot have written a response status');

                // The killed connection is torn down by the OS; give a networked engine a moment to
                // reap the backend that held the open transaction before reading across it.
                await new Promise((resolve) => setTimeout(resolve, 250));

                assert.strictEqual(
                    await dbAsync.get('SELECT id FROM posts WHERE post_title = ? AND post_type <> ?', [title, 'revision']),
                    undefined,
                    'the post row did not survive the kill'
                );
                assert.strictEqual(
                    await scalar(`SELECT COUNT(*) AS c FROM post_meta WHERE meta_key = 'f6_probe' AND meta_value = 'partial' AND post_id NOT IN (SELECT id FROM posts)`, []),
                    0,
                    'no orphaned metadata was left behind'
                );
                assert.strictEqual(
                    await scalar('SELECT COUNT(*) AS c FROM term_relationships WHERE term_taxonomy_id = ?', [categoryTaxonomyId]),
                    relationshipsBefore,
                    'no term relationship survived the kill'
                );
                assert.strictEqual(
                    await scalar(`SELECT COUNT(*) AS c FROM posts WHERE post_type = 'revision'`, []),
                    revisionsBefore,
                    'no initial revision survived the kill'
                );
                assert.strictEqual(
                    await scalar('SELECT COUNT(*) AS c FROM content_outbox', []),
                    outboxBefore,
                    'the not-yet-visible content event died with its transaction — nothing to dispatch after a crash'
                );
            });
        }
    });
}
