/**
 * mail-server plugin email-store regression suite (v2.1 ownership model).
 *
 * Runs the REAL plugin store (marketplace/plugins/mail-server/lib/email-store.js) against an
 * in-memory better-sqlite3 database through a minimal adapter that mimics the wordjs.db bridge.
 *
 * The adapter also acts as a GUARD TRIPWIRE: every SQL string the store emits is checked against
 * the structural rules of the host's assertSqlAllowed text guard (no '$' / backslash / '[' ']' /
 * '/*!' / RETURNING / multi-statement, and every referenced table under the wjp_mail_server_
 * prefix). A query that would be denied by the sandbox at runtime fails HERE, in CI — this class
 * of bug once broke 14 plugins at once (the CREATE TABLE IF NOT EXISTS tokenizer incident).
 *
 * The adapter + tripwire live in ./fixtures/mail-server-db so the mailbox-gate suite runs the store
 * through the SAME rules instead of a second, drifting copy.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { PREFIX, makeDb } from './fixtures/mail-server-db';

const createEmailStore = require(path.resolve(__dirname, '../../../marketplace/plugins/mail-server/lib/email-store.js'));

async function makeStore() {
    const db = makeDb();
    const Email = createEmailStore(db);
    await Email.initSchema();
    return { db, Email };
}

// Convenience: a normal delivered message pair (sender's Sent copy + recipient's inbox copy),
// mirroring exactly what index.js sendMail writes.
async function deliver(Email: any, opts: { fromId: number; from: string; toId: number; to: string; subject?: string; body?: string; threadId?: number }) {
    const subject = opts.subject || 'Hola';
    const body = opts.body || 'Cuerpo del mensaje';
    const sent = await Email.create({
        messageId: `<m${Date.now()}-${Math.random()}@test>`,
        fromAddress: opts.from, fromName: 'Sender', toAddress: opts.to,
        subject, bodyText: body, bodyHtml: `<p>${body}</p>`, rawContent: body,
        isSent: 1, userId: opts.fromId, threadId: opts.threadId || 0
    });
    const inbox = await Email.create({
        messageId: `<local-${Date.now()}-${Math.random()}@test>`,
        fromAddress: opts.from, fromName: 'Sender', toAddress: opts.to,
        subject, bodyText: body, bodyHtml: `<p>${body}</p>`, rawContent: body,
        isSent: 0, userId: opts.toId, threadId: opts.threadId || 0
    });
    return { sent, inbox };
}

test('initSchema is idempotent and upgrades a pre-v2.1 table (ALTER adds user_id/is_spam)', async () => {
    const db = makeDb();
    // Simulate an OLD install: table exists WITHOUT the new columns.
    db._raw.exec(`CREATE TABLE ${PREFIX}received_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, from_address TEXT, from_name TEXT,
        to_address TEXT, cc_address TEXT, bcc_address TEXT, subject TEXT, body_text TEXT, body_html TEXT,
        date_received DATETIME DEFAULT CURRENT_TIMESTAMP, is_read INT DEFAULT 0, is_sent INT DEFAULT 0,
        is_draft INT DEFAULT 0, is_archived INT DEFAULT 0, is_starred INT DEFAULT 0, is_trash INT DEFAULT 0,
        raw_content TEXT, parent_id INT DEFAULT 0, thread_id INT DEFAULT 0, scheduled_at DATETIME,
        delivery_status TEXT, delivery_attempts INT DEFAULT 0, next_attempt_at TEXT, last_error TEXT
    )`);
    db._raw.exec(`INSERT INTO ${PREFIX}received_emails (from_address, to_address, subject, body_text) VALUES ('a@x.com','b@x.com','legacy','old row')`);

    const Email = createEmailStore(db);
    await Email.initSchema();
    await Email.initSchema(); // second run must not throw (duplicate ALTER/INDEX swallowed)

    const row = await db.get(`SELECT user_id, is_spam FROM ${PREFIX}received_emails WHERE subject = ?`, ['legacy']);
    assert.deepEqual({ user_id: row.user_id, is_spam: row.is_spam }, { user_id: 0, is_spam: 0 }, 'legacy row got default ownership columns');

    // Indexes MUST actually be created (their names carry the plugin prefix so the host guard admits
    // them). The ownership fast path depends on the user_id index; a silently-rejected name would make
    // every folder listing a full scan.
    const idxNames = (db._raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[])
        .map(r => r.name);
    assert.ok(idxNames.includes('wjp_mail_server_idx_owner'), 'ownership index created');
    assert.ok(idxNames.includes('wjp_mail_server_idx_msgid'), 'message-id index created');
    assert.ok(idxNames.every((n: string) => !n.startsWith('idx_wjp_mail_server')), 'no wrongly-prefixed index names');
});

test('create() binds userId/isSpam and coerces mailparser false/undefined to strings', async () => {
    const { Email } = await makeStore();
    const rec = await Email.create({
        messageId: undefined, fromAddress: 'x@y.com', fromName: false, toAddress: 'a@site.com',
        subject: undefined, bodyText: false, bodyHtml: false, rawContent: undefined,
        userId: 7, isSpam: 1
    });
    assert.equal(rec.user_id, 7);
    assert.equal(rec.is_spam, 1);
    assert.equal(rec.from_name, '');
    assert.equal(rec.subject, '');
});

test('received_spf: the SPF verdict is persisted on a fresh install and survives findById', async () => {
    const { db, Email } = await makeStore();
    const HEADER = 'Received-SPF: permerror (mx.site.com: permanent error in processing domain of evil.test: '
        + 'unevaluable SPF record) client-ip=203.0.113.9; envelope-from=<spoof@evil.test>; '
        + 'helo=relay.evil.test; receiver=mx.site.com; identity=mailfrom;';

    const rec = await Email.create({
        messageId: '<spf1@t>', fromAddress: 'spoof@evil.test', toAddress: 'a@site.com',
        subject: 'unevaluable', bodyText: 'x', userId: 1, receivedSpf: HEADER
    });
    assert.equal(rec.received_spf, HEADER, 'create() returns the row with the header stored');
    const again = await Email.findById(rec.id);
    assert.equal(again.received_spf, HEADER, 'findById (the reading pane) carries the verdict');

    // A message we never SPF-checked (outbound copy, loopback/trusted session, check disabled) must
    // store an EMPTY string. better-sqlite3 refuses to bind `undefined`, so an unset field would throw
    // at end-of-DATA and drop the whole inbound message (the INBOUND-BIND class of bug).
    const plain = await Email.create({
        messageId: '<spf2@t>', fromAddress: 'a@site.com', toAddress: 'b@site.com',
        subject: 'sent copy', bodyText: 'x', isSent: 1, userId: 1
    });
    assert.equal(plain.received_spf, '', 'omitted receivedSpf stores "" (bindable), not NULL/undefined');

    // The listing projection must NOT ship it — listings are deliberately body-free and this is one
    // more per-row string across the isolate RPC bridge for a UI that shows a 2-line preview.
    const list = await Email.findAllByUser(1, 'a@site.com', 'inbox');
    assert.ok(list.length >= 1, 'inbox listing returned the message');
    assert.ok(!('received_spf' in list[0]), 'list projection stays lean (verdict is a reading-pane field)');

    // The column really is a column (not silently swallowed by a driver quirk).
    const cols = (db._raw.prepare(`PRAGMA table_info(${PREFIX}received_emails)`).all() as any[]).map(c => c.name);
    assert.ok(cols.includes('received_spf'), 'received_spf exists on a freshly created table');
});

test('received_spf: an EXISTING pre-v2.1.4 table is upgraded and still accepts inserts', async () => {
    const db = makeDb();
    // An install created before the column existed — exactly the shape initSchema() must repair.
    db._raw.exec(`CREATE TABLE ${PREFIX}received_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, from_address TEXT, from_name TEXT,
        to_address TEXT, cc_address TEXT, bcc_address TEXT, subject TEXT, body_text TEXT, body_html TEXT,
        date_received DATETIME DEFAULT CURRENT_TIMESTAMP, is_read INT DEFAULT 0, is_sent INT DEFAULT 0,
        is_draft INT DEFAULT 0, is_archived INT DEFAULT 0, is_starred INT DEFAULT 0, is_trash INT DEFAULT 0,
        is_spam INT DEFAULT 0, user_id INT DEFAULT 0,
        raw_content TEXT, parent_id INT DEFAULT 0, thread_id INT DEFAULT 0, scheduled_at DATETIME,
        delivery_status TEXT, delivery_attempts INT DEFAULT 0, next_attempt_at TEXT, last_error TEXT
    )`);
    db._raw.exec(`INSERT INTO ${PREFIX}received_emails (from_address, to_address, subject, body_text, user_id) VALUES ('a@x.com','b@x.com','pre-upgrade','old row', 4)`);

    const Email = createEmailStore(db);
    await Email.initSchema();
    await Email.initSchema(); // the duplicate-column ALTER must stay swallowed

    const cols = (db._raw.prepare(`PRAGMA table_info(${PREFIX}received_emails)`).all() as any[]).map(c => c.name);
    assert.ok(cols.includes('received_spf'), 'ALTER added received_spf to the existing table');

    // THE regression this guards: the INSERT names a column that only exists after the ALTER. If the
    // upgrade path were missing, every inbound message on an upgraded install would fail here.
    const rec = await Email.create({
        messageId: '<up1@t>', fromAddress: 'c@x.com', toAddress: 'b@x.com', subject: 'post-upgrade',
        bodyText: 'x', userId: 4, receivedSpf: 'Received-SPF: fail (mx: nope) client-ip=1.2.3.4;'
    });
    assert.equal(rec.received_spf, 'Received-SPF: fail (mx: nope) client-ip=1.2.3.4;');

    const legacy = await db.get(`SELECT received_spf FROM ${PREFIX}received_emails WHERE subject = ?`, ['pre-upgrade']);
    assert.equal(legacy.received_spf, null, 'rows written before the column keep NULL (no backfill needed)');
});

test('ownership: each recipient sees exactly their copy — no multi-recipient duplicates', async () => {
    const { Email } = await makeStore();
    const A = { id: 1, email: 'a@site.com' };
    const B = { id: 2, email: 'b@site.com' };
    const C = { id: 3, email: 'c@site.com' };

    // A sends ONE message to B and C → Sent copy (A) + one inbox copy per recipient, each copy
    // listing BOTH recipients in to_address (context preserved) — the old LIKE matching showed
    // B's copy to C and vice versa (duplicates).
    const toBoth = `${B.email}, ${C.email}`;
    await Email.create({ messageId: '<s1@t>', fromAddress: A.email, toAddress: toBoth, subject: 'multi', bodyText: 'x', isSent: 1, userId: A.id });
    await Email.create({ messageId: '<i1@t>', fromAddress: A.email, toAddress: toBoth, subject: 'multi', bodyText: 'x', isSent: 0, userId: B.id });
    await Email.create({ messageId: '<i2@t>', fromAddress: A.email, toAddress: toBoth, subject: 'multi', bodyText: 'x', isSent: 0, userId: C.id });

    const bInbox = await Email.findAllByUser(B.id, B.email, 'inbox');
    const cInbox = await Email.findAllByUser(C.id, C.email, 'inbox');
    const aInbox = await Email.findAllByUser(A.id, A.email, 'inbox');
    const aSent = await Email.findAllByUser(A.id, A.email, 'sent');
    assert.equal(bInbox.length, 1, 'B sees exactly one copy');
    assert.equal(cInbox.length, 1, 'C sees exactly one copy');
    assert.equal(aInbox.length, 0, 'sender inbox stays empty');
    assert.equal(aSent.length, 1, 'sender has one Sent thread');
    assert.equal(await Email.countByUser(B.id, B.email, 'inbox'), 1);
});

test('legacy rows (user_id = 0) stay visible through the address-match arm', async () => {
    const { Email, db } = await makeStore();
    // Legacy inbound row written before the ownership column existed.
    await db.run(
        `INSERT INTO ${PREFIX}received_emails (from_address, to_address, subject, body_text, is_sent, user_id) VALUES (?, ?, ?, ?, 0, 0)`,
        ['ext@other.com', 'a@site.com', 'legacy inbound', 'old', ]
    );
    const rows = await Email.findAllByUser(1, 'a@site.com', 'inbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, 'legacy inbound');
    // …and a different user does NOT see it.
    const other = await Email.findAllByUser(2, 'b@site.com', 'inbox');
    assert.equal(other.length, 0);
});

test('spam lives in its own folder, not inbox/trash, and counts are right', async () => {
    const { Email } = await makeStore();
    const U = { id: 5, email: 'u@site.com' };
    await Email.create({ messageId: '<ok@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'ham', bodyText: 'good', userId: U.id });
    await Email.create({ messageId: '<sp@t>', fromAddress: 'spam@bad.com', toAddress: U.email, subject: 'viagra', bodyText: 'bad', userId: U.id, isSpam: 1 });

    const inbox = await Email.findAllByUser(U.id, U.email, 'inbox');
    const spam = await Email.findAllByUser(U.id, U.email, 'spam');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].subject, 'ham');
    assert.equal(spam.length, 1);
    assert.equal(spam[0].subject, 'viagra');

    const counts = await Email.getCounts(U.id, U.email);
    assert.equal(counts.inbox_unread, 1);
    assert.equal(counts.spam_unread, 1);
    assert.equal(counts.drafts, 0);

    // Not-spam moves it back.
    await Email.setSpam(spam[0].id, false);
    assert.equal((await Email.findAllByUser(U.id, U.email, 'inbox')).length, 2);
});

test('listing returns snippets, has_attachment and thread collapse — but NEVER full bodies', async () => {
    const { Email } = await makeStore();
    const U = { id: 9, email: 'n@site.com' };
    const longBody = 'palabra '.repeat(200);
    const root = await Email.create({ messageId: '<r@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'thread', bodyText: longBody, bodyHtml: `<p>${longBody}</p>`, userId: U.id });
    await Email.create({ messageId: '<r2@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'Re: thread', bodyText: 'reply', userId: U.id, threadId: root.id });

    const rows = await Email.findAllByUser(U.id, U.email, 'inbox');
    assert.equal(rows.length, 1, 'thread collapsed to one row');
    assert.equal(rows[0].thread_count, 2);
    assert.equal(rows[0].subject, 'Re: thread', 'representative is the newest message');
    assert.ok(rows[0].snippet.length <= 180, 'snippet capped');
    assert.ok(!('body_html' in rows[0]), 'no body_html in list payload');
    assert.ok(!('raw_content' in rows[0]), 'no raw_content in list payload');
    assert.equal(rows[0].has_attachment, 0);
    assert.equal(await Email.countByUser(U.id, U.email, 'inbox'), 1, 'count matches collapsed unit');
});

test('labels: CRUD, apply, folder listing, batch fetch, delete cascade', async () => {
    const { Email } = await makeStore();
    const U = { id: 4, email: 'l@site.com' };
    const label = await Email.createLabel(U.id, 'Clientes', '#2563eb');
    assert.ok(label.id > 0);
    // Same-name create is a no-op returning the existing one.
    const dup = await Email.createLabel(U.id, 'clientes', '#000000');
    assert.equal(dup.id, label.id);

    const m1 = await Email.create({ messageId: '<l1@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'uno', bodyText: 'a', userId: U.id });
    const m2 = await Email.create({ messageId: '<l2@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'dos', bodyText: 'b', userId: U.id });
    await Email.addLabelToEmails([m1.id, m2.id], label.id);
    await Email.addLabelToEmails([m1.id], label.id); // idempotent

    const map = await Email.getLabelsForEmails([m1.id, m2.id], U.id);
    assert.equal(map[m1.id].length, 1);
    assert.equal(map[m1.id][0].name, 'Clientes');
    // A label is PRIVATE to the user who made it. Two accounts can be parties to the same row (any
    // un-backfilled row is), so this join must be scoped or one mailbox renders the other's label
    // names — and an absent user id returns nothing, never everything.
    assert.deepEqual(await Email.getLabelsForEmails([m1.id, m2.id], 999), {}, 'another user sees no labels of mine');
    assert.deepEqual(await Email.getLabelsForEmails([m1.id, m2.id], 0), {}, 'no user id, no labels');

    const listed = await Email.findAllByUser(U.id, U.email, 'label', 50, 0, label.id);
    assert.equal(listed.length, 2);

    const labels = await Email.listLabels(U.id);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].email_count, 2);

    // Another user must not see or resolve this label.
    assert.equal(await Email.findLabel(label.id, 999), undefined);

    await Email.removeLabelFromEmails([m2.id], label.id);
    assert.equal((await Email.findAllByUser(U.id, U.email, 'label', 50, 0, label.id)).length, 1);

    assert.equal(await Email.deleteLabel(label.id, U.id), true);
    assert.deepEqual(await Email.getLabelsForEmails([m1.id], U.id), {}, 'junction rows cascaded');
});

test('bulk flag updates apply to the whole id set', async () => {
    const { Email } = await makeStore();
    const U = { id: 6, email: 'bulk@site.com' };
    const a = await Email.create({ messageId: '<b1@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'b1', bodyText: 'x', userId: U.id });
    const b = await Email.create({ messageId: '<b2@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'b2', bodyText: 'x', userId: U.id });
    await Email.bulkSetFlags([a.id, b.id], { isRead: 1, isArchived: 1 });
    const archived = await Email.findAllByUser(U.id, U.email, 'archive');
    assert.equal(archived.length, 2);
    assert.equal((await Email.getCounts(U.id, U.email)).inbox_unread, 0);
    await Email.bulkSetFlags([a.id], { isTrash: 1 });
    assert.equal((await Email.findAllByUser(U.id, U.email, 'trash')).length, 1);
});

test('search: free text, from:, has:attachment, is:unread, folder scoping', async () => {
    const { Email, db } = await makeStore();
    const U = { id: 8, email: 's@site.com' };
    const m1 = await Email.create({ messageId: '<s1@t>', fromAddress: 'ana@ext.com', fromName: 'Ana', toAddress: U.email, subject: 'Factura enero', bodyText: 'adjunto la factura', userId: U.id });
    await Email.create({ messageId: '<s2@t>', fromAddress: 'luis@ext.com', fromName: 'Luis', toAddress: U.email, subject: 'Reunión', bodyText: 'agenda para mañana', userId: U.id, isSpam: 1 });
    await Email.create({ messageId: '<s3@t>', fromAddress: U.email, toAddress: 'ana@ext.com', subject: 'Re: Factura enero', bodyText: 'recibida, gracias', isSent: 1, userId: U.id });
    // Attachment row for m1 (DB only — no fs involved).
    await db.run(`INSERT INTO ${PREFIX}email_attachments (email_id, filename, content_type, size, storage_path) VALUES (?, ?, ?, ?, ?)`,
        [m1.id, 'factura.pdf', 'application/pdf', 100, 'deadbeef.bin']);

    assert.equal((await Email.search(U.id, U.email, { text: 'factura' })).length, 2, 'text search spans inbox+sent, excludes spam');
    assert.equal((await Email.search(U.id, U.email, { from: 'ana' })).length, 1);
    assert.equal((await Email.search(U.id, U.email, { hasAttachment: true })).length, 1);
    assert.equal((await Email.search(U.id, U.email, { text: 'agenda', folder: 'spam' })).length, 1, 'in:spam finds spam');
    assert.equal((await Email.search(U.id, U.email, { text: 'factura', folder: 'sent' })).length, 1);
    await Email.markAsRead(m1.id);
    assert.equal((await Email.search(U.id, U.email, { isUnread: true, folder: 'inbox' })).length, 0);
});

test("emptyTrash deletes only the requester's trash; purgeOldSpam only stale spam", async () => {
    const { Email, db } = await makeStore();
    const U = { id: 11, email: 'clean@site.com' };
    const V = { id: 12, email: 'other@site.com' };
    const mine = await Email.create({ messageId: '<t1@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'trash me', bodyText: 'x', userId: U.id, isTrash: 1 });
    const theirs = await Email.create({ messageId: '<t2@t>', fromAddress: 'x@y.com', toAddress: V.email, subject: 'keep', bodyText: 'x', userId: V.id, isTrash: 1 });
    await Email.emptyTrash(U.id, U.email);
    assert.equal(await Email.findById(mine.id), undefined);
    assert.ok(await Email.findById(theirs.id), 'other user trash untouched');

    const oldSpam = await Email.create({ messageId: '<os@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'old spam', bodyText: 'x', userId: U.id, isSpam: 1 });
    const newSpam = await Email.create({ messageId: '<ns@t>', fromAddress: 'x@y.com', toAddress: U.email, subject: 'new spam', bodyText: 'x', userId: U.id, isSpam: 1 });
    await db.run(`UPDATE ${PREFIX}received_emails SET date_received = ? WHERE id = ?`, ['2020-01-01 00:00:00', oldSpam.id]);
    const purged = await Email.purgeOldSpam(30);
    assert.equal(purged, 1);
    assert.equal(await Email.findById(oldSpam.id), undefined);
    assert.ok(await Email.findById(newSpam.id));
});

test('cancelScheduled (undo send) reverts an outbox row but never an already-sent one', async () => {
    const { Email } = await makeStore();
    const U = { id: 13, email: 'undo@site.com' };
    const future = new Date(Date.now() + 10000).toISOString();
    const queued = await Email.create({
        messageId: '<q@t>', fromAddress: U.email, toAddress: 'dest@ext.com', subject: 'queued',
        bodyText: 'x', isSent: 0, isDraft: 0, userId: U.id, scheduledAt: future
    });
    // Outbox rows show up in the drafts folder ("Sending…" chip).
    assert.equal((await Email.findAllByUser(U.id, U.email, 'drafts')).length, 1);

    const reverted = await Email.cancelScheduled(queued.id);
    assert.equal(reverted.is_draft, 1);
    assert.equal(reverted.scheduled_at, null);

    // Dispatch it (simulate the queue) → cancel must be a no-op.
    await Email.update(queued.id, { isSent: 1, isDraft: 0 });
    const after = await Email.cancelScheduled(queued.id);
    assert.equal(after.is_sent, 1, 'sent message stays sent');
    assert.equal(after.is_draft, 0);
});

test('suggestContacts returns correspondents from received and sent mail', async () => {
    const { Email } = await makeStore();
    const U = { id: 14, email: 'me@site.com' };
    await Email.create({ messageId: '<c1@t>', fromAddress: 'carla@ext.com', fromName: 'Carla', toAddress: U.email, subject: 'hola', bodyText: 'x', userId: U.id });
    await Email.create({ messageId: '<c2@t>', fromAddress: U.email, toAddress: 'carlos@dest.com, otra@dest.com', subject: 're', bodyText: 'x', isSent: 1, userId: U.id });
    // The address is now required: suggestContacts scopes itself with the ONE ownership predicate
    // (which needs it for the un-backfilled arm), not a private copy of `m.user_id = ?`.
    const hits = await Email.suggestContacts(U.id, U.email, 'carl', 8);
    const emails = hits.map((h: any) => h.email).sort();
    assert.deepEqual(emails, ['carla@ext.com', 'carlos@dest.com']);
});

test('per-user prefs round-trip (signature + vacation)', async () => {
    const { Email } = await makeStore();
    const saved = await Email.setPrefs(21, { signature: 'Firma\nLínea 2', vacation: { enabled: true, message: 'Fuera' } });
    assert.equal(saved.signature, 'Firma\nLínea 2');
    assert.equal(saved.vacation.enabled, true);
    const again = await Email.setPrefs(21, { signature: 'Nueva' });
    assert.equal(again.signature, 'Nueva');
    assert.deepEqual(await Email.getPrefs(999), {}, 'unknown user has empty prefs');
});
