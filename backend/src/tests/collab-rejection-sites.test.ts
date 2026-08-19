/**
 * COLLAB — THE POPULATION OF THIS CLASS IS THE REJECTION *SITES*, NOT THE SYMPTOMS
 *
 * CLASS D was stated as "the deadline is computed by the exhausted resource, and a rejection does not
 * spend another bucket". Wave 4 fixed the site the report brought — the FAST path of `resync`, where the
 * read-budget check now runs before `rateGate`. Round 3 showed the class was drawn around that one site
 * while `materializeRoom` has two more, both reachable and neither visited by the existing test:
 *
 *   · INSIDE THE TURN (collab-rooms.ts, the check that MANDATES). With `READ_CONCURRENCY_PER_USER = 1`
 *     the reads of one user serialise, so two tabs resuming together — the normal case after a
 *     `room_reset`, which the client turns into an immediate `resync` — mean the second one entered with
 *     credit, was CHARGED 10 op tokens and 16 KB by `rateGate`, and was then refused for READ budget.
 *   · THE QUEUE IS FULL. That branch answered `readRetryMs(userId) || CONFIG.RATE_RETRY_MS`, and with
 *     credit `readRetryMs` is 0 — so it advertised 900 ms, the window of the CONNECTION bucket, for a
 *     resource that is neither. The client has `maxRetries = 6` before it declares the session dead.
 *
 * So this file iterates the SITES. The source half derives them from the function bodies, which is what
 * makes a site added later red instead of merely untested; the live half drives the real module.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-collab-sites-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const collab = require('../core/collab-rooms');

const SOURCE_PATH = path.resolve(__dirname, '../core/collab-rooms.ts');

/**
 * The module's own source, WITH THE LINE ENDINGS NORMALISED.
 *
 * The population of this class is derived from the file on disk, so it has to be derived from the SAME
 * file in every checkout. It was not: `core.autocrlf` is on by default on Git for Windows and nothing
 * pins an `eol` attribute on `*.ts`, so one commit materialises as LF on Linux and as CRLF on a Windows
 * checkout. The delimiters below look for a `}` at column 0 preceded by a newline; on a CRLF checkout
 * `\n}` never matches and the body could not be delimited at all. That is state git deliberately does
 * not carry, so it must not decide what this gate measures — normalise once, here, and every reader
 * below works on one canonical text.
 */
function readSource(p: string): string {
    return fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
}

const SOURCE = readSource(SOURCE_PATH);

let dbAsync: any;
let POST_ID = 0;

/**
 * The body of a top-level function, delimited by the first `\n}` at column 0 after its header, WITH THE
 * COMMENTS REMOVED. This module documents its own defects in prose, so a scan over the raw text finds
 * `rateGate(` and `CONFIG.RATE_RETRY_MS` in the paragraphs that explain why they are wrong — a gate that
 * reads a comment as code is measuring the documentation, not the behaviour.
 */
function functionBody(name: string): string {
    const start = SOURCE.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `core/collab-rooms.ts no longer declares ${name}() — this gate reads the wrong thing`);
    // The closing brace of a top-level declaration: a `}` at column 0, followed by another line or by
    // the end of the file. Anchored on the normalised text, so it reads the same on every checkout.
    const closer = /\n\}(?=\n|$)/g;
    closer.lastIndex = start;
    const hit = closer.exec(SOURCE);
    const end = hit ? hit.index : -1;
    assert.ok(end > start,
        `could not delimit the body of ${name}(): no '}' at column 0 after its header. This gate derives ` +
        'its population from the source text, so it has stopped measuring anything — fix the reader, do ' +
        'not weaken the assertion.');
    let inBlock = false;
    return SOURCE.slice(start, end).split('\n').map((raw: string) => {
        let line = raw;
        if (inBlock) {
            const close = line.indexOf('*/');
            if (close < 0) return '';
            line = line.slice(close + 2);
            inBlock = false;
        }
        const open = line.indexOf('/*');
        if (open >= 0) {
            const close = line.indexOf('*/', open + 2);
            if (close < 0) { inBlock = true; line = line.slice(0, open); }
            else line = line.slice(0, open) + line.slice(close + 2);
        }
        const lineComment = line.indexOf('//');
        return lineComment >= 0 ? line.slice(0, lineComment) : line;
    }).join('\n');
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    const Post = require('../models/Post');
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('sala', 'x', 'sala@example.com', 'Sala')`);
    POST_ID = (await Post.create({ authorId: r.lastID, title: 'Sala de pruebas', type: 'post', status: 'draft' })).id;
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

// ─── The SITES, derived from the source ───────────────────────────────────────────────────────────

test('every rejection site of materializeRoom computes its wait from the resource that ran out', () => {
    const body = functionBody('materializeRoom');

    // Each `return { ok: false, … }` is one rejection SITE. The population is however many the function
    // has today — not the two the report named.
    const sites = body.split('\n').filter((l) => /return\s*\{\s*ok:\s*false/.test(l));
    assert.ok(sites.length >= 3,
        `materializeRoom must still refuse in more than one way; found ${sites.length} sites. If the shape ` +
        'of those returns changed, this gate has stopped reading the population.');

    for (const site of sites) {
        assert.ok(/readRetryMs\(|queueRetryMs\(/.test(site),
            `a rejection site of materializeRoom advertises a wait that no exhausted resource computed:\n  ${site.trim()}`);
    }

    // …and specifically not the connection bucket's window, which is the constant this class is about.
    assert.ok(!/CONFIG\.RATE_RETRY_MS/.test(body),
        'materializeRoom must never advertise CONFIG.RATE_RETRY_MS: that is the refill window of the ' +
        'CONNECTION byte bucket, and neither the read budget nor the read queue is that resource.');
});

test('a read-budget rejection in resync gives back what rateGate charged', () => {
    const body = functionBody('resync');
    const gate = body.indexOf('rateGate(');
    assert.ok(gate > 0, 'resync must still charge the connection bucket through rateGate()');

    // Every read-budget refusal AFTER the charge must be preceded by a refund. Before the charge there is
    // nothing to give back, which is why the fast path (the site wave 4 fixed) is deliberately exempt.
    const afterCharge = body.slice(gate);
    const refusals = afterCharge.split('readBudgetFailure(').length - 1;
    assert.ok(refusals >= 1,
        'resync no longer refuses for read budget after charging — if the order changed, re-derive this gate');
    const refunds = afterCharge.split('refundRate(').length - 1;
    assert.ok(refunds >= refusals,
        `resync has ${refusals} read-budget refusal(s) after the rateGate charge but only ${refunds} refund(s). ` +
        'A rejection of one resource must not spend another: call refundRate(conn, CONFIG.RESYNC_OP_COST, ' +
        'minBytes) on every read refusal that happens after the charge.');
});

test('the room materialiser is the only thing this module publishes for reading a room', () => {
    // CLASE A, widened: `ensureDoc` copies base_doc into the heap and re-reads _puck_data to hash it, and
    // it used to be on module.exports — so the guarantee "the only path is materializeRoom" held only
    // INSIDE this file while the sink was callable from anywhere in the repo. The gate that watched a
    // single file could not see a preview/export/reader-mode written elsewhere.
    assert.strictEqual(typeof collab.ensureDoc, 'undefined',
        'ensureDoc must not be exported: it is the amplifier, and materializeRoom is the path that CHARGES');
    assert.strictEqual(typeof collab.loadOps, 'undefined', 'loadOps must not be exported either');
    assert.strictEqual(typeof collab.materializeRoom, 'function',
        'materializeRoom is the public way to materialise a room, and it is the one that pays');
});

// ─── The same sites, driven live ──────────────────────────────────────────────────────────────────

test('an overdrawn read budget is quoted the READ bucket\'s recovery time, not another bucket\'s window', async () => {
    const userId = 7001;
    collab._readBuckets.set(userId, { tokens: -collab.CONFIG.USER_READ_BURST, last: Date.now() });

    const refused = await collab.materializeRoom(userId, POST_ID, { reseed: false });
    assert.strictEqual(refused.ok, false, 'an overdrawn user must be refused');

    // The read bucket refills at USER_READ_BYTES_PER_SEC, so climbing out of a full-burst overdraft is
    // tens of seconds — nothing like the 900 ms window of the connection bucket. Derived from the real
    // constants rather than pinned to a magic number.
    const esperado = (collab.CONFIG.USER_READ_BURST / collab.CONFIG.USER_READ_BYTES_PER_SEC) * 1000;
    assert.ok(refused.retryAfterMs > esperado * 0.5,
        `the refusal advertises ${refused.retryAfterMs} ms while the read bucket needs about ${Math.round(esperado)} ms ` +
        '— that is another resource\'s deadline');
    assert.notStrictEqual(refused.retryAfterMs, collab.CONFIG.RATE_RETRY_MS);

    collab._readBuckets.delete(userId);
});

test('a full read queue quotes a wait of its own, with the read budget still in credit', async () => {
    const userId = 7002;
    collab._readBuckets.set(userId, { tokens: collab.CONFIG.USER_READ_BURST, last: Date.now() });

    // More concurrent reads than the queue holds. With READ_CONCURRENCY_PER_USER = 1 the rest queue up
    // and the overflow is refused by the QUEUE, not by the budget — the site that used to answer 900 ms.
    const n = collab.CONFIG.MAX_QUEUED_READS_PER_USER + 6;
    const results = await Promise.all(
        Array.from({ length: n }, () => collab.materializeRoom(userId, POST_ID, { reseed: false })));

    const rechazos = results.filter((r: any) => !r.ok);
    assert.ok(rechazos.length > 0, `the queue cap (${collab.CONFIG.MAX_QUEUED_READS_PER_USER}) must refuse the overflow`);

    for (const r of rechazos) {
        // The read bucket has credit, so IT would say "retry now". A queue-full refusal that repeats that
        // is a busy loop; one that repeats CONFIG.RATE_RETRY_MS is the wait of a bucket nobody exhausted.
        assert.ok(r.retryAfterMs > 0,
            'a queue-full refusal must carry a real wait — the read bucket has credit and would say 0');
        assert.notStrictEqual(r.retryAfterMs, collab.CONFIG.RATE_RETRY_MS,
            'the queue must not borrow the connection bucket\'s window as its deadline');
    }

    collab._readBuckets.delete(userId);
});
