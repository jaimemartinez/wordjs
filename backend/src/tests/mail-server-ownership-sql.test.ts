/**
 * WAVE 5 — OWNERSHIP IS ONE SQL PREDICATE, AND THE QUERIES COMPOSE IT.
 *
 * WHAT ROUND 3 PROVED. Wave 4 put the ownership check inside the one destruction sink and the round
 * that followed walked around it TWICE without ever touching it:
 *
 *   1. SITE-WIDE RETENTION reached the sink through a branch that skipped the per-row question
 *      entirely, and its selection criterion (`is_spam = 1`) is a flag every READER of a row may
 *      write — so "mark someone else's message as spam and wait" destroyed rows the gate refuses to
 *      destroy. A pre-v2.1 row is already older than the retention window: there was nothing to wait
 *      for.
 *   2. POST /drafts rewrote to/cc/bcc on an un-attributed row — the columns the verdict is COMPUTED
 *      FROM. The gate answered correctly both times; the second time it was answering about a
 *      different row. One request turned "shared, destroyable by nobody" into "mine, destroy at will".
 *   3. And the identity resolver the gate consults FAILED OPEN: a missing users:read grant or one
 *      timed-out lookup read as "no other site account is a party to this row".
 *
 * None of the three is a coverage gap; all three are the same design fault — a predicate that is a
 * FUNCTION CALLERS MAKE rather than a WHERE CLAUSE QUERIES CONTAIN. So the store now answers "whose
 * row is this" in one place (_scopeClause) with two modes, reads compose the READ mode into their
 * WHERE, the single DELETE composes the DESTROY mode into its own, and retention is a MODE of that
 * predicate instead of an exemption from it.
 *
 * WHAT IS DERIVED HERE, AND WHAT IS NOT. The row shapes below are FIXTURES (inputs chosen to cover
 * the branches). The POPULATIONS these gates iterate are derived mechanically from the plugin source:
 *   · every statement in the store that writes `is_spam` (must write the flagger in the same one);
 *   · every column `update()` can write that the ownership verdict reads (must be inside the guard);
 *   · every method that consults the identity resolver (must handle "could not answer").
 * Add a member to any of those three and the test goes red without anyone editing a list.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { PREFIX, makeDb } from './fixtures/mail-server-db';

const STORE_PATH = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/lib/email-store.js');
const createEmailStore = require(STORE_PATH);
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');
// Comment lines stripped: an assertion about the CODE must never be satisfied by prose describing it.
const STORE_CODE = STORE_SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const T = PREFIX + 'received_emails';

const ANA = { id: 101, email: 'ana@empresa.com' };
const MARIA = { id: 102, email: 'mariana@empresa.com' };
const JEFE = { id: 103, email: 'jefe@empresa.com' };
const ADMIN = { id: 999, email: 'admin@empresa.com' };
const DIRECTORY: Record<string, number> = {
    [ANA.email]: ANA.id, [MARIA.email]: MARIA.id, [JEFE.email]: JEFE.id, [ADMIN.email]: ADMIN.id
};
const directoryResolver = () => ({
    resolveUserIdByAddress: async (a: string) => DIRECTORY[String(a || '').trim().toLowerCase()] || 0
});

async function makeStore(hooks?: any) {
    const db = makeDb();
    const Email = createEmailStore(db, hooks === undefined ? directoryResolver() : hooks);
    await Email.initSchema();
    return { db, Email };
}

/** A pre-v2.1 row: written before the user_id column existed, so it carries the legacy sentinel 0. */
async function insertLegacy(
    db: any,
    opts: { to: string; cc?: string; from?: string; subject?: string; flags?: Record<string, number> }
): Promise<number> {
    const f: Record<string, number> = Object.assign(
        { is_sent: 0, is_draft: 0, is_trash: 0, is_spam: 0 }, opts.flags || {});
    const res = await db.run(
        `INSERT INTO ${T} (from_address, to_address, cc_address, bcc_address, subject, body_text, user_id, ` +
        `is_sent, is_draft, is_trash, is_spam, date_received) ` +
        `VALUES (?, ?, ?, '', ?, 'x', 0, ?, ?, ?, ?, '2020-01-01 00:00:00')`,
        [opts.from || 'ext@other.com', opts.to, opts.cc || '', opts.subject || 's',
            f.is_sent, f.is_draft, f.is_trash, f.is_spam]
    );
    return res.lastID;
}

// =====================================================================================
// 1. RETENTION IS A MODE OF THE PREDICATE — NOT AN EXEMPTION FROM IT
// =====================================================================================

test('CRITICAL (round 3): flagging spam on a row you may not destroy does not hand it to the reaper', async () => {
    const { db, Email } = await makeStore();
    // The shape the finding used: a legacy fan-out copy naming two site mailboxes. Both may READ it,
    // NEITHER may destroy it — the store already said so, and kept saying so while retention deleted it.
    const shared = await insertLegacy(db, { to: `${MARIA.email}, ${JEFE.email}`, subject: 'el importe' });

    assert.equal(Email._ownsRow(await Email.findById(shared), JEFE.id, JEFE.email), true, 'jefe may read it');
    assert.equal(
        await Email._mayDestroyRow(await Email.findById(shared), JEFE.id, JEFE.email, new Map()), false,
        'and may NOT destroy it — this is the verdict the whole finding is about'
    );
    assert.equal(await Email.deletePermanently(shared, { userId: JEFE.id, userEmail: JEFE.email }), 0);

    // The bypass, verbatim: jefe presses "spam" (a READ-level action), the 6-hourly sweep runs, and a
    // legacy row is by definition older than the 30-day window.
    await Email.setSpam(shared, true, JEFE.id);
    assert.equal(await Email.purgeOldSpam(30), 0, 'retention destroyed a row the destruction gate refuses');
    assert.ok(await Email.findById(shared), 'MARIANA STILL HAS THE MESSAGE — the irreversible half');

    // …and it is still readable by both, i.e. the fix did not "protect" it by hiding it.
    for (const u of [MARIA, JEFE]) {
        assert.deepEqual(
            (await Email.search(u.id, u.email, { text: 'importe', folder: 'spam' })).map((r: any) => r.id),
            [shared], `${u.email} can still find it`
        );
    }
});

test('CRITICAL (round 3, second variant): an ADMINISTRATOR flagging another mailbox\'s row cannot reap it either', async () => {
    const { db, Email } = await makeStore();
    // A MODERN, attributed row: canAccessEmail grants every administrator READ over it while
    // _mayDestroyRow has no administrator branch at all — the file's own gate says no.
    const hers = await Email.create({
        messageId: '<m@t>', fromAddress: 'ext@other.com', toAddress: MARIA.email,
        subject: 'nomina', bodyText: 'x', userId: MARIA.id
    });
    await db.run(`UPDATE ${T} SET date_received = ? WHERE id = ?`, ['2020-01-01 00:00:00', hers.id]);
    assert.equal(await Email.deletePermanently(hers.id, { userId: ADMIN.id, userEmail: ADMIN.email }), 0,
        'the sink refuses the admin, as it always did');

    await Email.setSpam(hers.id, true, ADMIN.id);
    assert.equal(await Email.purgeOldSpam(30), 0, 'the flag of a non-owner is not retention material');
    assert.ok(await Email.findById(hers.id), 'mariana keeps her message');

    // The owner's OWN spam still ages out, and so does what the delivery classifier flagged: the
    // journey retention exists for is untouched.
    await Email.setSpam(hers.id, true, MARIA.id);
    assert.equal(await Email.purgeOldSpam(30), 1, 'her own spam ages out normally');
    assert.equal(await Email.findById(hers.id), undefined);

    const auto = await Email.create({
        messageId: '<a@t>', fromAddress: 'spammer@bad.example', toAddress: ANA.email,
        subject: 'viagra', bodyText: 'x', userId: ANA.id, isSpam: 1
    });
    await db.run(`UPDATE ${T} SET date_received = ? WHERE id = ?`, ['2020-01-01 00:00:00', auto.id]);
    assert.equal(await Email.purgeOldSpam(30), 1, 'delivery-time classification is still reaped');
});

test('CRITICAL (round 3): an un-attributed row is nobody\'s retention material, whoever flagged it', async () => {
    const { db, Email } = await makeStore();
    // Even the SOLE party of a legacy row: retention deletes rows that BELONG to somebody, and a
    // user_id = 0 row belongs to no one — that is the definition of the sentinel. The owner can still
    // empty their own trash; the reaper simply has no business there.
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'spam viejo', flags: { is_spam: 1 } });
    assert.equal(await Email.purgeOldSpam(30), 0);
    assert.ok(await Email.findById(mine));
    assert.equal(await Email.deletePermanently(mine, { userId: ANA.id, userEmail: ANA.email }), 1,
        'and its only party can still destroy it deliberately');
});

test('GATE (derived): every statement that writes is_spam writes the flagger in the SAME statement', () => {
    // POPULATION FROM THE SOURCE: every SQL fragment in the store that assigns is_spam. A new flag
    // writer that forgets spam_flagged_by fails here — the column is an INPUT TO A DESTRUCTION
    // PREDICATE, so a stale/absent flagger is not a cosmetic omission.
    const writers = [...STORE_CODE.matchAll(/[^\n]*is_spam\s*=\s*\?[^\n]*/g)].map(m => m[0]);
    assert.ok(writers.length >= 2, `expected the store's is_spam writers to be found; got ${writers.length}`);
    const naked = writers.filter(w => !/spam_flagged_by/.test(w));
    assert.deepEqual(
        naked, [],
        'these statements set is_spam without setting spam_flagged_by in the same statement. Site-wide ' +
        'retention decides what to destroy from those two columns together; writing one without the ' +
        'other is how "mark someone else\'s mail as spam" became a delete primitive.'
    );
    // The two-column rule also has to be true of the INSERT path's default (0 = the classifier).
    assert.match(STORE_CODE, /'spam_flagged_by INT DEFAULT 0'/, 'the column must exist on new installs');
    assert.match(STORE_CODE, /_ensureColumn\(T_EMAILS, 'spam_flagged_by'/, '…and be added on upgrade');
});

test('GATE: an is_spam write that names no actor makes the row UNREAPABLE, not reapable', async () => {
    const { db, Email } = await makeStore();
    const row = await Email.create({
        messageId: '<u@t>', fromAddress: 'x@y.com', toAddress: ANA.email, subject: 's', bodyText: 'x', userId: ANA.id
    });
    await db.run(`UPDATE ${T} SET date_received = ? WHERE id = ?`, ['2020-01-01 00:00:00', row.id]);
    // A call site that forgot to say who pressed the button. The failure mode of forgetting must be
    // mail that lives too long, never mail that is destroyed too early.
    await Email.setSpam(row.id, true);
    assert.equal(await Email.purgeOldSpam(30), 0);
    assert.ok(await Email.findById(row.id));
    await Email.bulkSetFlags([row.id], { isSpam: 1 });
    assert.equal(await Email.purgeOldSpam(30), 0, 'the bulk writer fails closed the same way');
    assert.ok(await Email.findById(row.id));
});

test('GATE (derived): every spam-flag call in index.js names the actor that pressed it', () => {
    // The store fails CLOSED when a flag writer forgets the actor (the row becomes unreapable), but
    // "unreapable" is a silent behaviour change for retention, so the ROUTES are enumerated too:
    // every Email.setSpam( / Email.bulkSetFlags( call site in the plugin must pass a third argument.
    // Population from the source, not a list written here — a new spam route with two arguments fails.
    const INDEX_PATH = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js');
    const INDEX_CODE = fs.readFileSync(INDEX_PATH, 'utf8')
        .split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(' ');
    const calls = [...INDEX_CODE.matchAll(/Email\.(setSpam|bulkSetFlags)\(([^;]*?)\);/g)];
    assert.ok(calls.length >= 4, `expected the plugin's flag-writer call sites; got ${calls.length}`);
    const anonymous = calls.filter(c => !/req\.user\.id/.test(c[2])).map(c => c[0].slice(0, 90));
    assert.deepEqual(
        anonymous, [],
        'these spam-flag calls do not say WHO pressed the button. The flag is an input to the ' +
        'retention predicate, so an anonymous flag either destroys somebody else\'s mail (before this ' +
        'wave) or quietly makes the row immortal (after it) — neither is what the call site means.'
    );
});

// =====================================================================================
// 2. THE VERDICT'S INPUTS ARE NOT ORDINARY COLUMNS
// =====================================================================================

test('CRITICAL (round 3): one POST /drafts cannot turn "shared with mariana" into "mine to destroy"', async () => {
    const { db, Email } = await makeStore();
    const shared = await insertLegacy(db, { to: `${MARIA.email}, ${JEFE.email}`, subject: 'el importe' });

    // The invariant wave 4 shipped, still true before the attack.
    assert.equal((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).length, 1);
    assert.equal(await Email._mayDestroyRow(await Email.findById(shared), JEFE.id, JEFE.email, new Map()), false);

    // THE ATTACK: jefe passes the route's _ownsRow gate (he IS a party) and rewrites the row to
    // himself. Nothing here touches user_id or from_address — it does not need to.
    await assert.rejects(
        () => Email.update(shared, { toAddress: JEFE.email, ccAddress: '', bccAddress: '', subject: 'borrador', bodyText: '' }),
        (e: any) => e && e.code === 'mail_shared_row_party_narrowed',
        'rewriting the address columns of an un-attributed row is a change of its OWNERSHIP VERDICT'
    );

    // Nothing moved: mariana still sees it, and jefe still cannot destroy it.
    const after = await Email.findById(shared);
    assert.equal(after.to_address, `${MARIA.email}, ${JEFE.email}`, 'the recipient list is intact');
    assert.equal(after.subject, 'el importe', 'and so are subject and body — the update was refused whole');
    assert.deepEqual((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).map((r: any) => r.id), [shared]);
    assert.equal((await Email.getCounts(MARIA.id, MARIA.email)).inbox_unread, 1);
    assert.equal(await Email._mayDestroyRow(after, JEFE.id, JEFE.email, new Map()), false);
    assert.equal(await Email.deleteManyPermanently([shared], { userId: JEFE.id, userEmail: JEFE.email }), 0);
    assert.ok(await Email.findById(shared), 'the row survives the whole sequence');
});

test('…while the rows that belong to ONE mailbox are still ordinary rows', async () => {
    const { db, Email } = await makeStore();

    // ROUND 4 CORRECTION. This test used to assert the opposite of its two first cases: that a party
    // could GROW the party set of a shared row, and that "content-only edits of a shared row are
    // untouched by the rule". Both were the defect, not the contract — growing it hands a third
    // mailbox somebody else's message, and rewriting subject/body destroys the copy the other party
    // has. What survives here is the part that was always true: a row only ONE mailbox holds is
    // ordinary, and an attributed row is its owner's to rewrite.
    const shared = await insertLegacy(db, { to: `${MARIA.email}, ${JEFE.email}`, subject: 'el importe' });
    await assert.rejects(
        () => Email.update(shared, { toAddress: `${MARIA.email}, ${JEFE.email}, ${ANA.email}` }),
        (e: any) => e && e.code === 'mail_shared_row_immutable',
        'adding a party to a shared row hands a third mailbox a message that is not theirs'
    );
    await assert.rejects(
        () => Email.update(shared, { subject: 'corregido', bodyText: 'nuevo cuerpo' }),
        (e: any) => e && e.code === 'mail_shared_row_immutable',
        'overwriting the content of a shared row destroys the other party\'s copy'
    );

    // A LEGACY row with exactly one local party is not shared: the only mailbox that could lose
    // anything is the one the route already proved the caller to be a party of.
    const solo = await insertLegacy(db, { from: 'ext@other.com', to: `${ANA.email}, cliente@fuera.com`, subject: 'presupuesto' });
    const edited = await Email.update(solo, { subject: 'corregido', bodyText: 'nuevo cuerpo' });
    assert.equal(edited.subject, 'corregido', 'a legacy row nobody else holds is an ordinary row');

    // And an ATTRIBUTED row's addresses are ordinary columns again: its verdict is user_id, so the
    // owner may rewrite the recipient list of their own copy freely (this is what composing a reply
    // into an existing draft does on every modern install).
    const mine = await Email.create({
        messageId: '<d@t>', fromAddress: ANA.email, toAddress: `${MARIA.email}, ${JEFE.email}`,
        subject: 'borrador', bodyText: 'x', userId: ANA.id, isDraft: 1
    });
    const narrowed = await Email.update(mine.id, { toAddress: JEFE.email });
    assert.equal(narrowed.to_address, JEFE.email, 'an owned draft is the owner\'s to rewrite');
    assert.equal(Email._ownsRow(narrowed, ANA.id, ANA.email), true);
});

test('GATE (derived): every column update() can write that the VERDICT reads is inside the party-set guard', () => {
    // Population 1 — the columns the ownership verdict is computed from, taken from every address
    // tuple the store parses (_tokensOf call sites), not from a list written here.
    const verdictCols = new Set<string>();
    for (const m of STORE_CODE.matchAll(/_tokensOf\([^,]+,\s*\[([^\]]+)\]/g)) {
        for (const q of m[1].matchAll(/'([a-z_]+)'/g)) verdictCols.add(q[1]);
    }
    assert.ok(verdictCols.size >= 4, `expected the verdict's address columns to be derived; got ${[...verdictCols]}`);

    // Population 2 — the columns update() can write, taken from its own SET builder.
    const updateBody = STORE_CODE.slice(STORE_CODE.indexOf('async update(id, data)'));
    const writable = new Set([...updateBody.slice(0, 3000).matchAll(/fields\.push\("([a-z_]+) = \?"\)/g)].map(m => m[1]));
    assert.ok(writable.size > 5, `expected update()'s writable columns to be derived; got ${[...writable]}`);

    // The guard block: the object update() builds to compare the party set before and after.
    const guard = updateBody.slice(0, updateBody.indexOf('mail_shared_row_party_narrowed'));
    assert.ok(guard.includes('const before = this._tokensOf(existing'), 'the guard must compare the party set');

    const unguarded = [...writable].filter(c => verdictCols.has(c) && !guard.includes(`${c}:`));
    assert.deepEqual(
        unguarded, [],
        'these columns are writable by update() AND are read by the ownership verdict, but the ' +
        'party-set guard does not include them in the "after" row it computes. A column that decides ' +
        'who owns an un-attributed row cannot be rewritten as if it were content.'
    );
});

// =====================================================================================
// 3. THE IDENTITY ANSWER FAILS CLOSED — AT BOOT AND AT REQUEST TIME ALIKE
// =====================================================================================

test('CRITICAL (round 3): one timed-out lookup does not turn a refusal into a destruction', async () => {
    // A TRANSIENT failure on a SINGLE address — the whole finding: the memo is per batch, so a
    // network hiccup while resolving mariana@ decided an irreversible delete.
    const { db, Email } = await makeStore({
        resolveUserIdByAddress: async (a: string) => {
            if (String(a).toLowerCase() === MARIA.email) throw new Error('ETIMEDOUT');
            return DIRECTORY[String(a).trim().toLowerCase()] || 0;
        }
    });
    const shared = await insertLegacy(db, { to: `${MARIA.email}, ${JEFE.email}`, subject: 'el importe', flags: { is_trash: 1 } });
    assert.equal(
        await Email._mayDestroyRow(await Email.findById(shared), JEFE.id, JEFE.email, new Map()), false,
        'an address whose identity is UNKNOWN is not an address that belongs to nobody'
    );
    await assert.rejects(() => Email.emptyTrash(JEFE.id, JEFE.email), (e: any) => e.code === 'mail_identity_unavailable');
    assert.ok(await Email.findById(shared));
});

test('CRITICAL (round 3): boot and request time answer the identity question the SAME way', async () => {
    // THE ASYMMETRY the finding named: given a bridge that throws, the backfill failed CLOSED (left
    // the row at user_id = 0) while the destruction gate failed OPEN (destroyed it). Both must refuse.
    const db = makeDb();
    const Email = createEmailStore(db, {
        resolveUserIdByAddress: async () => { throw new Error('no users:read grant'); }
    });
    await Email.initSchema();
    const shared = await insertLegacy(db, { to: `${MARIA.email}, ${JEFE.email}`, subject: 'el importe', flags: { is_trash: 1 } });
    await Email.initSchema(); // re-run: the backfill is idempotent and gated on a COUNT

    assert.equal((db as any)._raw.prepare(`SELECT user_id FROM ${T} WHERE id = ?`).get(shared).user_id, 0,
        'the backfill refuses to attribute on an unanswerable identity — it always did');
    assert.equal(
        await Email._mayDestroyRow(await Email.findById(shared), JEFE.id, JEFE.email, new Map()), false,
        'and now the request-time gate refuses on the SAME input, which is what "one answer" means'
    );
    await assert.rejects(() => Email.emptyTrash(JEFE.id, JEFE.email), (e: any) => e.code === 'mail_identity_unavailable');
    assert.ok(await Email.findById(shared), 'mariana keeps the message on an install without the grant');
});

test('GATE (derived): every method that consults the identity resolver handles "could not answer"', () => {
    // Population from the source: the methods whose bodies reach _resolveAddressId. Each must name
    // UNKNOWN_IDENTITY, i.e. must distinguish "no such account" from "no answer". A new consumer that
    // treats the resolver's output as a plain user id fails here.
    const bounds = [...STORE_CODE.matchAll(/\n {8}(?:async )?(_?[A-Za-z]\w*)\(/g)];
    assert.ok(bounds.length > 30, `expected to find the store's methods; got ${bounds.length}`);
    const methods = bounds.map((m, i) => ({
        name: m[1],
        body: STORE_CODE.slice(m.index!, i + 1 < bounds.length ? bounds[i + 1].index! : STORE_CODE.length)
    }));
    const consumers = methods.filter(m => /_resolveAddressId\(/.test(m.body) && m.name !== '_resolveAddressId');
    assert.ok(consumers.length >= 2,
        `expected the identity consumers to be found; got ${consumers.map(c => c.name).join(', ')}`);
    const failOpen = consumers.filter(m => !/UNKNOWN_IDENTITY/.test(m.body)).map(m => m.name);
    assert.deepEqual(
        failOpen, [],
        'these methods ask the identity resolver and never mention UNKNOWN_IDENTITY, so they cannot be ' +
        'distinguishing "that address is nobody here" from "the lookup failed". The second one is not ' +
        'a licence to destroy anything.'
    );
    // …and the resolver itself must return the sentinel rather than swallowing failures into a zero.
    const resolver = methods.find(m => m.name === '_resolveAddressId')!;
    assert.match(resolver.body, /catch \(e\) \{[\s\S]{0,120}UNKNOWN_IDENTITY/,
        '_resolveAddressId must report a failed lookup as UNKNOWN_IDENTITY, never as 0');
    assert.match(resolver.body, /if \(!resolveUserIdByAddress\) return UNKNOWN_IDENTITY/,
        'no resolver at all is also "no answer" — asking whether the FUNCTION EXISTS was the bug');
});

// =====================================================================================
// 4. THE SQL TWIN AND THE JS TWIN CANNOT DISAGREE — IN EITHER MODE
// =====================================================================================

test('CLASS: for every viewer, the DESTROY clause selects a strict subset of the READ clause — in SQL', async () => {
    const { db, Email } = await makeStore();
    // Fixtures covering each branch of the predicate (the POPULATION being iterated here is the
    // viewers × the two modes; these rows are the inputs that make the branches reachable).
    const ids = {
        sharedFanout: await insertLegacy(db, { to: `${MARIA.email}, ${JEFE.email}` }),
        sharedCc: await insertLegacy(db, { to: JEFE.email, cc: `${MARIA.email}, fuera@otro.com` }),
        soleLocal: await insertLegacy(db, { to: ANA.email }),
        sentExternal: await insertLegacy(db, { from: ANA.email, to: 'cliente@fuera.com', flags: { is_sent: 1 } }),
        sentLocal: await insertLegacy(db, { from: ANA.email, to: MARIA.email, flags: { is_sent: 1 } }),
    };
    const modern = await Email.create({
        messageId: '<x@t>', fromAddress: JEFE.email, toAddress: `${ANA.email}, ${MARIA.email}`,
        subject: 's', bodyText: 'x', userId: ANA.id
    });

    for (const viewer of [ANA, MARIA, JEFE, ADMIN]) {
        const read = await Email._scopeClause({ userId: viewer.id, userEmail: viewer.email }, 'read', 'm');
        const destroy = await Email._scopeClause({ userId: viewer.id, userEmail: viewer.email }, 'destroy', 'm');
        const sel = async (c: any) =>
            (await db.all(`SELECT m.id FROM ${T} m WHERE ${c.clause} ORDER BY m.id`, c.params)).map((r: any) => r.id);
        const readable = await sel(read);
        const destroyable = await sel(destroy);

        for (const id of destroyable) {
            assert.ok(readable.includes(id),
                `${viewer.email} may DESTROY row ${id} in SQL but may not READ it — the modes have diverged`);
        }
        // …and each SQL answer agrees with the JS predicate row by row, which is the only way the
        // clause and the row check can stay one predicate rather than two that happen to match today.
        for (const id of [...Object.values(ids), modern.id]) {
            const row = await Email.findById(id);
            assert.equal(readable.includes(id), Email._ownsRow(row, viewer.id, viewer.email),
                `READ: SQL and _ownsRow disagree about row ${id} for ${viewer.email}`);
            assert.equal(
                destroyable.includes(id),
                await Email._mayDestroyRow(row, viewer.id, viewer.email, new Map()),
                `DESTROY: SQL and _mayDestroyRow disagree about row ${id} for ${viewer.email}`
            );
        }
    }

    // The shape that matters most, spelled out: the shared fan-out copy is in EVERY party's read set
    // and in NOBODY's destroy set.
    for (const viewer of [MARIA, JEFE]) {
        const read = await Email._scopeClause({ userId: viewer.id, userEmail: viewer.email }, 'read', 'm');
        const destroy = await Email._scopeClause({ userId: viewer.id, userEmail: viewer.email }, 'destroy', 'm');
        const inRead = await db.all(`SELECT m.id FROM ${T} m WHERE ${read.clause} AND m.id = ?`, [...read.params, ids.sharedFanout]);
        const inDestroy = await db.all(`SELECT m.id FROM ${T} m WHERE ${destroy.clause} AND m.id = ?`, [...destroy.params, ids.sharedFanout]);
        assert.equal(inRead.length, 1, `${viewer.email} must keep reading the shared row`);
        assert.equal(inDestroy.length, 0, `${viewer.email} must not be able to destroy the shared row`);
    }
});

test('CLASS: a scope mode that does not exist is a THROW, never a permissive default', async () => {
    const { Email } = await makeStore();
    await assert.rejects(
        () => Email._scopeClause({ userId: ANA.id, userEmail: ANA.email }, 'delete-everything', 'm'),
        /Unknown ownership scope mode/,
        'an unrecognized mode must fail loudly — a typo that silently means "read" would widen a delete'
    );
    await assert.rejects(
        () => Email._scopeClause(Email.SYSTEM_RETENTION, 'read', 'm'),
        /never scopes a read/,
        'the retention actor owns nothing, so it can never be used to scope a listing'
    );
});
