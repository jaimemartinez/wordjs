/**
 * Regression suite for the mail-server ownership predicate (audit findings #5 and #6).
 *
 * WHY IT LIVES HERE. It was first written under marketplace/plugins/mail-server/lib/, where
 * backend/package.json's `npm test` glob (src/tests/*.test.ts) never reached it. A regression guard
 * that CI does not execute proves nothing — which is the exact class of defect the audit found — so
 * the file moved into the glob and its private copy of the SQL-guard tripwire was replaced by the
 * single shared definition in ./fixtures/mail-server-db.
 *
 * THE DEFECT. Until v2.2 the store authorized folder listings, search, the sidebar counters and
 * "Empty trash" with a second WHERE arm that tested mailbox membership by SUBSTRING:
 *
 *     user_id = 0 AND (to_address LIKE '%ana@empresa.com%' OR ...)
 *
 * so every row addressed to mariana@empresa.com matched ana@empresa.com. Reading it leaked subject,
 * every recipient field and a 180-char body snippet (and `search` turned that into a full-text
 * oracle over the other mailbox's BODIES); emptying the trash destroyed the other mailbox's mail
 * permanently, attachments included. The identical bug had already been fixed in findByThreadId and
 * the fix never reached the queries that return COLLECTIONS.
 *
 * WHAT THIS ASSERTS. Two real mailboxes whose addresses are substrings of one another, over the REAL
 * store (marketplace/plugins/mail-server/lib/email-store.js) and REAL SQL on an in-memory
 * better-sqlite3 database. Nothing here hand-builds the object under test: the rows go in through
 * the store's own create()/raw legacy INSERT and come back out through findAllByUser / search /
 * getCounts / countByUser / emptyTrash.
 *
 * WAVE 2 — WHAT THE REMEDIATION ITSELF BROKE. The adversarial pass over the fix above found that it
 * had re-opened both findings from the other side, and the tests below pin each one:
 *   - the ownership BACKFILL resolved DELIVERY PERMISSION instead of identity and dumped everything
 *     it could not resolve on the site administrator, so on the exact upgrade #5 was about the admin
 *     inherited every mailbox and the real owners lost theirs irreversibly;
 *   - it also handed a multi-recipient legacy row to ONE recipient, deleting it for the others;
 *   - #6 was closed for "Empty trash" only: DELETE /emails/:id and POST /emails/bulk still
 *     authorized by ADDRESS, and under the ownership model each party's copy names every recipient,
 *     so permanent cross-user destruction stayed live through them;
 *   - findByThreadId was the last address-authorized read and did not exclude drafts, so another
 *     user's UNSENT reply came back with the conversation;
 *   - and the legacy id CAP was applied before the exact check, so a noisy neighbour mailbox could
 *     blank out the legitimate one.
 * Where the defect lives in index.js (the routes and the injected hooks, neither of which can be
 * booted from a unit test — the plugin runs in an OS-isolated child process behind a bridge), the
 * assertion is STRUCTURAL over the real source file, the same technique mail-server-mailbox-gate
 * uses. Everything else is behavioural over the real store.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { PREFIX, makeDb } from './fixtures/mail-server-db';

const createEmailStore = require(path.resolve(__dirname, '../../../marketplace/plugins/mail-server/lib/email-store.js'));

const T = PREFIX + 'received_emails';

// The two colliding mailboxes the audit names. ANA.email is a strict substring of MARIA.email, which
// is what the old `LIKE '%ana@empresa.com%'` matched on.
const ANA = { id: 101, email: 'ana@empresa.com' };
const MARIA = { id: 102, email: 'mariana@empresa.com' };
assert.ok(MARIA.email.includes(ANA.email), 'the fixture must actually collide, or it proves nothing');

/**
 * The identity hook the host really injects: "which site account IS this address". Tests that
 * exercise DESTRUCTION need it, because the destruction gate now REFUSES on an identity it cannot
 * resolve (a store built with no resolver at all cannot rule out a second party to an un-attributed
 * row, and guessing there is what let one mailbox annihilate another's copy).
 */
const DIRECTORY: Record<string, number> = { [ANA.email]: ANA.id, [MARIA.email]: MARIA.id };
function directoryResolver() {
    return { resolveUserIdByAddress: async (a: string) => DIRECTORY[String(a || '').trim().toLowerCase()] || 0 };
}

async function makeStore(hooks?: any) {
    const db = makeDb();
    const Email = createEmailStore(db, hooks);
    await Email.initSchema();
    return { db, Email };
}

// A pre-v2.1 row: written before the user_id column existed, so it carries the legacy sentinel 0.
// This is the ONLY shape the substring arm ever applied to, so every test seeds it this way.
async function insertLegacy(
    db: ReturnType<typeof makeDb>,
    opts: { to: string; from?: string; subject: string; body: string; flags?: Record<string, number> }
): Promise<number> {
    const f: Record<string, number> = Object.assign(
        { is_sent: 0, is_draft: 0, is_archived: 0, is_starred: 0, is_trash: 0, is_spam: 0, is_read: 0 },
        opts.flags || {}
    );
    const res = await db.run(
        `INSERT INTO ${T} (from_address, to_address, cc_address, bcc_address, subject, body_text, user_id, ` +
        `is_sent, is_draft, is_archived, is_starred, is_trash, is_spam, is_read) ` +
        `VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [opts.from || 'ext@other.com', opts.to, '', '', opts.subject, opts.body,
            f.is_sent, f.is_draft, f.is_archived, f.is_starred, f.is_trash, f.is_spam, f.is_read]
    );
    return res.lastID;
}

test('#5 listing: a legacy row addressed to mariana@ never appears in ana@ inbox', async () => {
    const { db, Email } = await makeStore();
    const hers = await insertLegacy(db, { to: MARIA.email, subject: 'Nomina de Mariana', body: 'confidencial' });
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'Nomina de Ana', body: 'la mia' });

    const anaInbox = await Email.findAllByUser(ANA.id, ANA.email, 'inbox');
    assert.deepEqual(anaInbox.map((r: any) => r.id), [mine], 'ana sees exactly her own legacy row');

    // The reverse direction still works: mariana@ is NOT a substring of ana@, so this arm was never
    // broken — asserting it pins that the fix did not simply hide legacy mail from everyone.
    const mariaInbox = await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox');
    assert.deepEqual(mariaInbox.map((r: any) => r.id), [hers], 'mariana still sees her own legacy row');
});

test('#5 search: ana cannot use the body-text operator as an oracle over mariana mail', async () => {
    const { db, Email } = await makeStore();
    await insertLegacy(db, { to: MARIA.email, subject: 'Privado', body: 'el importe de la nomina es 4200 euros' });
    await insertLegacy(db, { to: ANA.email, subject: 'Mio', body: 'nomina propia' });

    const anaHits = await Email.search(ANA.id, ANA.email, { text: 'nomina' });
    assert.equal(anaHits.length, 1, 'only ana own message matches');
    assert.equal(anaHits[0].subject, 'Mio');
    // The snippet column is what actually leaked, so assert on the payload and not just the count.
    assert.ok(!anaHits.some((r: any) => String(r.snippet || '').includes('4200')), 'no snippet from the other mailbox');

    // A term that exists ONLY in mariana body must return nothing — that is the oracle test.
    assert.equal((await Email.search(ANA.id, ANA.email, { text: '4200' })).length, 0);
});

test('#5 counters: unread badges are computed over the same exact row set as the listing', async () => {
    const { db, Email } = await makeStore();
    await insertLegacy(db, { to: MARIA.email, subject: 'a', body: 'x' });
    await insertLegacy(db, { to: MARIA.email, subject: 'b', body: 'x' });
    await insertLegacy(db, { to: MARIA.email, subject: 'spam de mariana', body: 'x', flags: { is_spam: 1 } });
    await insertLegacy(db, { to: ANA.email, subject: 'c', body: 'x' });

    const anaCounts = await Email.getCounts(ANA.id, ANA.email);
    assert.equal(anaCounts.inbox_unread, 1, 'ana badge counts only her own unread mail');
    assert.equal(anaCounts.spam_unread, 0, 'mariana spam does not reach ana spam badge');
    assert.equal(await Email.countByUser(ANA.id, ANA.email, 'inbox'), 1, 'pagination total agrees with the listing');

    const mariaCounts = await Email.getCounts(MARIA.id, MARIA.email);
    assert.equal(mariaCounts.inbox_unread, 2);
    assert.equal(mariaCounts.spam_unread, 1);
});

test('#6 empty trash: ana pressing the button cannot destroy mariana trashed mail', async () => {
    // WITH the identity resolver the host injects: ext@other.com resolves to "no account here", so
    // Ana is the only party who could lose her own legacy row and the button works normally.
    const { db, Email } = await makeStore(directoryResolver());
    const hers = await insertLegacy(db, { to: MARIA.email, subject: 'de mariana', body: 'x', flags: { is_trash: 1 } });
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'de ana', body: 'x', flags: { is_trash: 1 } });

    const deleted = await Email.emptyTrash(ANA.id, ANA.email);
    assert.equal(deleted, 1, 'exactly one message destroyed');
    assert.equal(await Email.findById(mine), undefined, 'ana own trash is gone');
    assert.ok(await Email.findById(hers), 'mariana trash SURVIVES — this is the irreversible half');

    // And mariana can still empty her own.
    assert.equal(await Email.emptyTrash(MARIA.id, MARIA.email), 1);
    assert.equal(await Email.findById(hers), undefined);
});

test('empty trash REFUSES, loudly, when the identity of another party cannot be resolved', async () => {
    // The other half of the doctrine above, and the round-3 finding it closes: without an identity
    // source the store CANNOT know whether ext@other.com is a colleague's mailbox, and the previous
    // version resolved that doubt in favour of destroying. It now refuses the whole press with a code
    // the route turns into a 503 — "Empty trash" that half-empties and reports a number is the lie
    // this suite exists to prevent.
    const { db, Email } = await makeStore(); // no resolver at all
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'de ana', body: 'x', flags: { is_trash: 1 } });
    await assert.rejects(
        () => Email.emptyTrash(ANA.id, ANA.email),
        (e: any) => e && e.code === 'mail_identity_unavailable'
    );
    assert.ok(await Email.findById(mine), 'and nothing was destroyed on the way to the refusal');

    // A resolver that THROWS (the users:read grant revoked at runtime) must behave the same as none:
    // the failure mode of a broken bridge is not "everybody is a stranger".
    const { db: db2, Email: E2 } = await makeStore({
        resolveUserIdByAddress: async () => { throw new Error('no users:read grant'); }
    });
    const alsoMine = await insertLegacy(db2, { to: ANA.email, subject: 'de ana', body: 'x', flags: { is_trash: 1 } });
    await assert.rejects(
        () => E2.emptyTrash(ANA.id, ANA.email),
        (e: any) => e && e.code === 'mail_identity_unavailable'
    );
    assert.ok(await E2.findById(alsoMine));
});

test('a zero/unknown user id matches nothing instead of every un-migrated row', async () => {
    const { db, Email } = await makeStore();
    await insertLegacy(db, { to: MARIA.email, subject: 'x', body: 'x' });
    await insertLegacy(db, { to: ANA.email, subject: 'y', body: 'y' });
    // user_id = 0 is the LEGACY SENTINEL, so binding a missing id into the owner arm used to select
    // the whole un-migrated table.
    assert.deepEqual(await Email.findAllByUser(0, '', 'inbox'), []);
    assert.equal((await Email.getCounts(0, '')).inbox_unread, 0);
    assert.equal(await Email.emptyTrash(0, ''), 0);
});

test('modern rows: each party sees only their own copy, sender copy included', async () => {
    const { Email } = await makeStore();
    // Exactly what index.js sendMail writes: one Sent copy for the sender, one delivered copy per
    // recipient, every copy naming BOTH recipients in to_address.
    const both = `${ANA.email}, ${MARIA.email}`;
    await Email.create({ messageId: '<s@t>', fromAddress: 'jefe@empresa.com', toAddress: both, subject: 'reunion', bodyText: 'x', isSent: 1, userId: 7 });
    await Email.create({ messageId: '<a@t>', fromAddress: 'jefe@empresa.com', toAddress: both, subject: 'reunion', bodyText: 'x', isSent: 0, userId: ANA.id });
    await Email.create({ messageId: '<m@t>', fromAddress: 'jefe@empresa.com', toAddress: both, subject: 'reunion', bodyText: 'x', isSent: 0, userId: MARIA.id });

    assert.equal((await Email.findAllByUser(ANA.id, ANA.email, 'inbox')).length, 1);
    assert.equal((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).length, 1);
    // Ana's address is in mariana's copy too; ownership — not address membership — decides.
    const anaIds = (await Email.findAllByUser(ANA.id, ANA.email, 'inbox')).map((r: any) => r.user_id);
    assert.deepEqual(anaIds, [ANA.id]);
});

test('backfill attributes pre-v2.1 rows and collapses the clause to a single user_id probe', async () => {
    const db = makeDb();
    // Identity resolver in the shape index.js injects it (host users:read bridge).
    const directory: Record<string, number> = { [ANA.email]: ANA.id, [MARIA.email]: MARIA.id };
    const asked: string[] = [];
    const Email = createEmailStore(db, {
        resolveUserIdByAddress: async (addr: string) => { asked.push(addr); return directory[String(addr).toLowerCase()] || 0; },
        // An OLD host that still injects a catch-all owner. The store must IGNORE it: a row nobody
        // claims is not the administrator's, and handing it over is irreversible.
        fallbackOwnerId: async () => 999
    });
    await Email.initSchema();

    // Seed BEFORE the backfill runs, then re-run initSchema: the backfill is idempotent and
    // self-healing, it is gated on a COUNT of user_id = 0 rows rather than a marker row.
    const anaRow = await insertLegacy(db, { to: ANA.email, subject: 'para ana', body: 'x' });
    const mariaRow = await insertLegacy(db, { to: MARIA.email, subject: 'para mariana', body: 'x' });
    const orphan = await insertLegacy(db, { to: 'nadie@empresa.com', subject: 'catch-all', body: 'x' });
    const sent = await insertLegacy(db, { from: ANA.email, to: 'cliente@fuera.com', subject: 'enviado', body: 'x', flags: { is_sent: 1 } });

    await Email.initSchema();

    const owners = db._raw.prepare(`SELECT id, user_id FROM ${T} ORDER BY id`).all();
    assert.deepEqual(owners, [
        { id: anaRow, user_id: ANA.id },
        { id: mariaRow, user_id: MARIA.id },
        { id: orphan, user_id: 0 },     // nobody claims it -> it stays nobody's, NOT the admin's
        { id: sent, user_id: ANA.id }   // a Sent copy belongs to its sender
    ]);

    // With the legacy set drained the ownership clause is the single indexed probe again: no id list,
    // and therefore no LIKE anywhere in the authorization path.
    const clause = await Email._ownerClause(ANA.id, ANA.email);
    assert.equal(clause.clause, '(m.user_id = ?)');
    assert.deepEqual(clause.params, [ANA.id]);

    // Visibility is preserved end to end by the backfill, not by an address match.
    assert.deepEqual((await Email.findAllByUser(ANA.id, ANA.email, 'inbox')).map((r: any) => r.id), [anaRow]);
    assert.deepEqual((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).map((r: any) => r.id), [mariaRow]);
    assert.ok(asked.length > 0, 'the resolver really was consulted');
});

test('without an identity resolver the legacy rows stay reachable — and still only by their real owner', async () => {
    // A host that never injects the hooks (older bridge / missing users:read) must not lose mail.
    const { db, Email } = await makeStore(undefined);
    const hers = await insertLegacy(db, { to: MARIA.email, subject: 'suya', body: 'x' });
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'mia', body: 'x' });

    assert.deepEqual((await Email.findAllByUser(ANA.id, ANA.email, 'inbox')).map((r: any) => r.id), [mine]);
    assert.deepEqual((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).map((r: any) => r.id), [hers]);
    // The clause carries an explicit id list in this state — a LIKE pre-filter that has already been
    // narrowed by the exact-token check, never a substring authorization.
    const clause = await Email._ownerClause(ANA.id, ANA.email);
    assert.match(clause.clause, /m\.id IN \(\?\)/);
    assert.deepEqual(clause.params, [ANA.id, mine]);
});

test('cc/bcc-only legacy recipients keep access, and a substring of them does not', async () => {
    const { db, Email } = await makeStore();
    const res = await db.run(
        `INSERT INTO ${T} (from_address, to_address, cc_address, bcc_address, subject, body_text, user_id, ` +
        `is_sent, is_draft, is_archived, is_starred, is_trash, is_spam, is_read) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
        ['ext@other.com', 'jefe@empresa.com', `otro@empresa.com, ${MARIA.email}`, '', 'con copia', 'x']
    );
    const id = res.lastID;
    assert.deepEqual((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).map((r: any) => r.id), [id], 'a cc recipient reads their mail');
    assert.deepEqual(await Email.findAllByUser(ANA.id, ANA.email, 'inbox'), [], 'a substring of a cc recipient does not');
});

// =====================================================================================
// WAVE 2 — the defects the REMEDIATION introduced or left open. Each test below fails if
// its fix is reverted; see the file header for the shape of each one.
// =====================================================================================

const ADMIN = { id: 999, email: 'admin@empresa.com' };

// Bulk legacy seeding for the id-budget tests (2000+ rows: one prepared statement, one transaction).
function insertLegacyBulk(db: ReturnType<typeof makeDb>, to: string, count: number) {
    const stmt = (db as any)._raw.prepare(
        `INSERT INTO ${T} (from_address, to_address, cc_address, bcc_address, subject, body_text, user_id, ` +
        `is_sent, is_draft, is_archived, is_starred, is_trash, is_spam, is_read) ` +
        `VALUES ('ext@other.com', ?, '', '', ?, 'x', 0, 0, 0, 0, 0, 0, 0, 0)`
    );
    (db as any)._raw.transaction(() => {
        for (let i = 0; i < count; i++) stmt.run(to, `ruido ${i}`);
    })();
}

test('#5 REGRESSION: an unresolvable backfill leaves the mail where it is — it never becomes the administrator\'s', async () => {
    const db = makeDb();
    // THE UPGRADE SCENARIO OF #5, replayed with the resolver the remediation actually injected: it
    // answered DELIVERY PERMISSION (mailboxAddressOf → the admin-granted professional-mailbox flag),
    // and host migration 0006 leaves that flag OFF for every account that is not an administrator, so
    // it answered 0 for ana and mariana alike and everything fell through to the catch-all owner.
    const Email = createEmailStore(db, {
        resolveUserIdByAddress: async () => 0,
        fallbackOwnerId: async () => ADMIN.id // an OLD host still offering one: the store must ignore it
    });
    await Email.initSchema();

    const hers = await insertLegacy(db, { to: MARIA.email, subject: 'nomina mariana', body: 'confidencial maria' });
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'nomina de ana', body: 'confidencial de ana' });
    const trashed = await insertLegacy(db, { to: ANA.email, subject: 'papelera de ana', body: 'x', flags: { is_trash: 1 } });

    await Email.initSchema(); // re-run: the backfill is idempotent, gated on a COUNT of user_id = 0

    assert.deepEqual(
        (db as any)._raw.prepare(`SELECT user_id FROM ${T} ORDER BY id`).all(),
        [{ user_id: 0 }, { user_id: 0 }, { user_id: 0 }],
        'a row nobody claims stays at the legacy sentinel; re-owning it is irreversible'
    );

    // The real owners keep their mail — the half of the regression that DESTROYS.
    assert.deepEqual((await Email.findAllByUser(ANA.id, ANA.email, 'inbox')).map((r: any) => r.id), [mine]);
    assert.deepEqual((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).map((r: any) => r.id), [hers]);
    assert.equal((await Email.getCounts(ANA.id, ANA.email)).inbox_unread, 1);

    // And the administrator's mailbox stays empty — the half that LEAKS. These rows had never
    // appeared in any listing; the listing carries subject, every recipient field and a snippet.
    assert.deepEqual(await Email.findAllByUser(ADMIN.id, ADMIN.email, 'inbox'), []);
    assert.deepEqual(await Email.search(ADMIN.id, ADMIN.email, { text: 'confidencial' }), []);
    assert.deepEqual(await Email.getCounts(ADMIN.id, ADMIN.email), { inbox_unread: 0, spam_unread: 0, drafts: 0 });

    // …including the irreversible half of #6, re-aimed: the admin pressing "Empty trash".
    assert.equal(await Email.emptyTrash(ADMIN.id, ADMIN.email), 0);
    assert.ok(await Email.findById(trashed), 'ana trashed message survives the administrator emptying theirs');
});

test('#5 REGRESSION: a legacy row with several recipients stays shared instead of going to the first one', async () => {
    const db = makeDb();
    const directory: Record<string, number> = { [ANA.email]: ANA.id, [MARIA.email]: MARIA.id };
    const Email = createEmailStore(db, {
        resolveUserIdByAddress: async (addr: string) => directory[String(addr).trim().toLowerCase()] || 0
    });
    await Email.initSchema();

    // to/cc/bcc are COMMA-JOINED lists and a legacy row was written by a version whose fan-out we do
    // not know — the whole reason a backfill exists. One owner = the message vanishes for the others.
    const shared = await insertLegacy(db, { to: `${ANA.email}, ${MARIA.email}`, subject: 'reunion', body: 'a las 10' });
    const onlyAna = await insertLegacy(db, { to: ANA.email, subject: 'solo ana', body: 'x' });

    await Email.initSchema();

    assert.deepEqual(
        (db as any)._raw.prepare(`SELECT id, user_id FROM ${T} ORDER BY id`).all(),
        [{ id: shared, user_id: 0 }, { id: onlyAna, user_id: ANA.id }],
        'unambiguous rows are attributed; a shared one is not'
    );
    assert.deepEqual((await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox')).map((r: any) => r.id), [shared],
        'the co-recipient still has the message');
    assert.deepEqual(
        (await Email.findAllByUser(ANA.id, ANA.email, 'inbox')).map((r: any) => r.id).sort((a: number, b: number) => a - b),
        [shared, onlyAna].sort((a, b) => a - b)
    );
});

test('#6 BYPASS: a row OWNED by someone else is not mine, however my address appears in it', async () => {
    const { Email } = await makeStore();
    // Exactly what sendMail/POST /drafts write when Mariana mails Ana: Mariana's Sent copy, an unsent
    // draft reply of hers, and Ana's delivered copy. All three name BOTH addresses.
    const mariaSent = await Email.create({ messageId: '<s@t>', fromAddress: MARIA.email, toAddress: ANA.email, subject: 'presupuesto', bodyText: 'x', isSent: 1, userId: MARIA.id });
    const mariaDraft = await Email.create({ messageId: '<d@t>', fromAddress: MARIA.email, toAddress: ANA.email, subject: 'RE: presupuesto', bodyText: 'NO SE LO DIGAS A ANA', isDraft: 1, userId: MARIA.id });
    const anaCopy = await Email.create({ messageId: '<i@t>', fromAddress: MARIA.email, toAddress: ANA.email, subject: 'presupuesto', bodyText: 'x', userId: ANA.id });

    // _ownsRow IS the predicate index.js canAccessEmail is built on, and therefore what DELETE
    // /emails/:id and POST /emails/bulk {action:'delete'} — both of which reach
    // deleteManyPermanently — now enforce. canUserAccess is the OLD rule, kept only for the legacy arm.
    for (const row of [mariaSent, mariaDraft]) {
        assert.equal(Email.canUserAccess(row, ANA.email), true, 'the address rule says yes — that is the bug');
        assert.equal(Email._ownsRow(row, ANA.id, ANA.email), false, 'ownership says no');
    }
    assert.equal(Email._ownsRow(anaCopy, ANA.id, ANA.email), true, 'her own copy is hers');
    assert.equal(Email._ownsRow(anaCopy, MARIA.id, MARIA.email), false, 'and not the sender\'s');

    // A legacy row (user_id = 0) is still reached by its exact parties — the fallback must survive.
    const { db, Email: E2 } = await makeStore();
    const legacy = await insertLegacy(db, { to: ANA.email, subject: 'vieja', body: 'x' });
    assert.equal(E2._ownsRow(await E2.findById(legacy), ANA.id, ANA.email), true);
    assert.equal(E2._ownsRow(await E2.findById(legacy), MARIA.id, MARIA.email), false);
});

test('#6 BYPASS: the conversation view returns neither another mailbox copy nor its UNSENT draft', async () => {
    const { Email } = await makeStore();
    const root = await Email.create({ messageId: '<r@t>', fromAddress: MARIA.email, toAddress: ANA.email, subject: 'presupuesto', bodyText: 'son 4000', isSent: 1, userId: MARIA.id });
    const anaCopy = await Email.create({ messageId: '<a@t>', fromAddress: MARIA.email, toAddress: ANA.email, subject: 'presupuesto', bodyText: 'son 4000', userId: ANA.id, threadId: root.id });
    const mariaDraft = await Email.create({ messageId: '<d@t>', fromAddress: MARIA.email, toAddress: ANA.email, subject: 'RE: presupuesto', bodyText: 'NO SE LO DIGAS A ANA TODAVIA: bajamos a 3000', isDraft: 1, userId: MARIA.id, threadId: root.id });

    // GET /emails/:id opens the thread. Ana is a party to the conversation by address, which is
    // exactly what the old filter tested — and it returned FULL ROWS, bodies included.
    const anaThread = await Email.findByThreadId(root.id, ANA.id, ANA.email);
    assert.deepEqual(anaThread.map((r: any) => r.id), [anaCopy.id], 'only her own copy');
    assert.ok(!JSON.stringify(anaThread).includes('bajamos a 3000'), 'an unsent draft body never leaves its author');

    // The author does not get the draft back through the conversation either (it lives in Drafts),
    // and never sees the recipient's copy.
    assert.deepEqual((await Email.findByThreadId(root.id, MARIA.id, MARIA.email)).map((r: any) => r.id), [root.id]);
    assert.ok(mariaDraft.id > 0);

    // No requester, no conversation. And an OLD positional call (threadId, userEmail) is recognized
    // as an address rather than parsed into userId = 0 with no address left — which would have handed
    // the whole thread to every caller. Recognized, it can still only prove ownership of un-backfilled
    // rows, so it answers with nothing here: fail closed, never fail open.
    assert.deepEqual(await Email.findByThreadId(root.id), [], 'fails closed without a requester');
    assert.deepEqual(await Email.findByThreadId(root.id, ANA.email as any), [], 'an address alone cannot own a modern row');

    // Un-backfilled rows still reach their exact parties through the same call.
    const { db, Email: E2 } = await makeStore();
    const legacy = await insertLegacy(db, { to: ANA.email, subject: 'vieja', body: 'x' });
    assert.deepEqual((await E2.findByThreadId(legacy, ANA.id, ANA.email)).map((r: any) => r.id), [legacy]);
    assert.deepEqual(await E2.findByThreadId(legacy, MARIA.id, MARIA.email), []);
});

test('the legacy id budget belongs to the mailbox that OWNS the rows, not to a noisy neighbour', async () => {
    const { db, Email } = await makeStore();
    // Ana's single un-backfilled row is the OLDEST, and 2001 newer rows are addressed to a mailbox
    // whose address CONTAINS hers. The cap used to be applied to the substring pre-filter, so the
    // newest 2000 foreign rows consumed it and Ana's id list came back EMPTY: blank inbox, zero
    // counters, an "Empty trash" that silently deleted nothing — while Mariana noticed nothing.
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'la unica de ana', body: 'x' });
    insertLegacyBulk(db, MARIA.email, 2001);

    assert.deepEqual(await Email._legacyOwnedIds(ANA.email), [mine]);
    assert.deepEqual((await Email.findAllByUser(ANA.id, ANA.email, 'inbox')).map((r: any) => r.id), [mine]);
    assert.equal((await Email.getCounts(ANA.id, ANA.email)).inbox_unread, 1);
});

test('…and also when the neighbour survives the pre-filter, which a LIKE wildcard in the address lets it do', async () => {
    // '_' is a single-character wildcard in LIKE, so an anchored token pattern for a_a@empresa.com
    // still matches axa@empresa.com. Over-selecting is harmless BY DESIGN — canUserAccess decides —
    // but only because the cap is now applied to the EXACT-matched set and the scan is paginated.
    const VICTIM = { id: 201, email: 'a_a@empresa.com' };
    const NOISY = 'axa@empresa.com';
    const { db, Email } = await makeStore();
    const mine = await insertLegacy(db, { to: VICTIM.email, subject: 'la unica', body: 'x' });
    insertLegacyBulk(db, NOISY, 2001);

    assert.deepEqual(await Email._legacyOwnedIds(VICTIM.email), [mine]);
    assert.deepEqual((await Email.findAllByUser(VICTIM.id, VICTIM.email, 'inbox')).map((r: any) => r.id), [mine]);
});

test('recipient autocomplete sees un-backfilled correspondence — and only the user\'s own', async () => {
    const { db, Email } = await makeStore();
    await insertLegacy(db, { from: 'carla@ext.com', to: ANA.email, subject: 'hola', body: 'x' });
    await insertLegacy(db, { from: 'carlos@ext.com', to: MARIA.email, subject: 'hola', body: 'x' });

    // It filtered on a hand-written `m.user_id = ?` with no legacy arm, so while un-backfilled rows
    // existed the autocomplete offered no historic contact at all — a second, private ownership rule
    // growing back next to the one the store is supposed to have.
    assert.deepEqual((await Email.suggestContacts(ANA.id, ANA.email, 'carl', 8)).map((h: any) => h.email), ['carla@ext.com']);
    assert.deepEqual((await Email.suggestContacts(MARIA.id, MARIA.email, 'carl', 8)).map((h: any) => h.email), ['carlos@ext.com']);
});

// --- index.js: the routes and the injected hooks ------------------------------------
//
// The plugin runs in an OS-isolated child process behind a capability bridge, so these two live
// where no unit test can boot them. They are asserted STRUCTURALLY over the REAL source file — the
// same technique mail-server-mailbox-gate.test.ts uses for the delivery paths. Comment lines are
// stripped first, so an assertion about the CODE can never be satisfied (or broken) by prose that
// merely quotes the old rule.
const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js'), 'utf8');
const INDEX_CODE = INDEX_SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('#5 REGRESSION: the injected backfill hook asks WHO an address is, not who may receive at it', () => {
    const hook = INDEX_CODE.match(/resolveUserIdByAddress:\s*async \(address\) => \{([\s\S]*?)\n {8}\}/);
    assert.ok(hook, 'the store is constructed with a resolveUserIdByAddress hook');
    assert.match(hook![1], /User\.findByEmail\(/, 'identity comes from the user directory');
    for (const permission of ['mailboxAddressOf', 'hasCorporateMailbox', 'hasProfessionalMailbox', 'getMailDomain']) {
        assert.ok(
            !hook![1].includes(permission),
            `the backfill must not resolve identity through ${permission}(): that is DELIVERY PERMISSION, ` +
            'and host migration 0006 leaves it off for every non-administrator — so it answers 0 for the ' +
            'whole site and every historic row falls through to a catch-all owner'
        );
    }
    assert.ok(
        !INDEX_CODE.includes('fallbackOwnerId'),
        'there must be no catch-all owner hook: a row nobody claims stays at user_id = 0 rather than ' +
        'becoming the administrator\'s, which cannot be undone'
    );
});

test('#6 BYPASS: every per-id route authorizes by OWNERSHIP — the address rule is gone from the code', () => {
    const def = INDEX_CODE.match(/const canAccessEmail = \(email, user\) =>([\s\S]*?);/);
    assert.ok(def, 'canAccessEmail is defined exactly once');
    assert.match(def![1], /Email\._ownsRow\(email, user\.id, user\.userEmail\)/, 'and it is the store ownership predicate');

    assert.deepEqual(
        INDEX_CODE.match(/Email\.canUserAccess\(/g) || [], [],
        'no route may authorize a row by address membership: each party holds their OWN copy and every ' +
        'copy names every recipient, so the address rule authorizes one mailbox over another — and ' +
        'DELETE /emails/:id and POST /emails/bulk reach Email.deleteManyPermanently'
    );
    assert.deepEqual(
        INDEX_CODE.match(/from_address[^\n]*req\.user\.userEmail/g) || [], [],
        'nor by "the from_address is mine": the RECIPIENT\'s copy of anything I sent them carries my ' +
        'address, and POST /drafts + POST /send overwrite the row they accept'
    );
    assert.match(
        INDEX_CODE, /const mine = rows\.filter\(r => canAccessEmail\(r, req\.user\)\);/,
        '/emails/bulk must filter with the one predicate before it deletes'
    );
    assert.match(
        INDEX_CODE, /Email\.findByThreadId\(\s*threadIdToSearch,\s*req\.user\.id,\s*req\.user\.userEmail/,
        'the conversation read must pass the requester ID — an address alone cannot decide ownership'
    );
});
