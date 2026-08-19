/**
 * WAVE 4 — THE OWNERSHIP CLASS, not the ownership example.
 *
 * THE CLASS: "who owns this row" was answered in five places that could disagree — a JS row
 * predicate (_ownsRow), a SQL clause (_ownerClause), a LIKE pre-filter (_legacyOwnedIds), the
 * backfill's attribution rule (_resolveLegacyOwner) and the route check in index.js (canAccessEmail)
 * — and every disagreement between them was a defect: mail visible to one predicate and invisible to
 * another (silent loss), readable by one and DESTROYABLE by another (irreversible cross-user
 * destruction), attributed by one and lost by another. Three waves fixed the EXAMPLE each round
 * produced and left its siblings live.
 *
 * So this suite does not test a case. It ITERATES:
 *   1. every FUNCTION the store exposes — each must be classified as ownership-scoped, id-addressed
 *      (and then gated in its route), or not row access at all. A new method with no classification
 *      FAILS HERE rather than shipping ungated;
 *   2. every row shape × every viewer, asserting the destroy verdict is a strict subset of the read
 *      verdict and that no party of a shared row can annihilate it;
 *   3. every spelling of a comma-joined address list, asserting the SQL pre-filter is never NARROWER
 *      than the exact decider (the "the guard inspects a different value than the decider" shape);
 *   4. every sink that turns a client string into a file read.
 * The budget tests derive their fixtures from the EXPORTED constants, so bumping a cap cannot leave a
 * test calibrated to pass against a limit that is no longer in force.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PREFIX, makeDb } from './fixtures/mail-server-db';

const STORE_PATH = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/lib/email-store.js');
const INDEX_PATH = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js');
const createEmailStore = require(STORE_PATH);

const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8');
// Comment lines stripped: an assertion about the CODE must never be satisfiable by prose quoting the
// old rule (several of the strings below appear verbatim in the explanatory comments).
const INDEX_CODE = INDEX_SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const STORE_CODE = STORE_SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const T = PREFIX + 'received_emails';
const T_ATT = PREFIX + 'email_attachments';

const ANA = { id: 101, email: 'ana@empresa.com' };
const MARIA = { id: 102, email: 'mariana@empresa.com' };
const JEFE = { id: 103, email: 'jefe@empresa.com' };
const DIRECTORY: Record<string, number> = { [ANA.email]: ANA.id, [MARIA.email]: MARIA.id, [JEFE.email]: JEFE.id };

function directoryResolver() {
    return { resolveUserIdByAddress: async (a: string) => DIRECTORY[String(a || '').trim().toLowerCase()] || 0 };
}

/**
 * THE PREDICATE'S CONFIGURATIONS — the axis round 3 found the matrix was not iterating.
 *
 * _mayDestroyRow does not depend only on the ROW and the VIEWER: it depends on what the identity
 * service can answer, and that is a THIRD dimension with genuinely different branches. The wave-4
 * matrix ran every row shape against every viewer with ONE configuration (a working directory), so
 * the branch that actually deletes — the one taken when identity is unavailable — was never
 * executed, and in it the verdict for "legacy sent copy to a LOCAL colleague" was INVERTED: the
 * recipient annihilated the only copy the sender had.
 *
 * These are the configurations that exist in the field, and the invariant asserted over them is that
 * the DESTROY verdict never WIDENS: any answer other than a resolved directory may only destroy
 * fewer rows, never more.
 */
const RESOLVER_CONFIGS: Array<{ name: string; hooks: any }> = [
    { name: 'directory resolver — what the host injects when users:read is granted', hooks: directoryResolver() },
    { name: 'NO resolver injected at all (an embedder that passes no hooks)', hooks: undefined },
    {
        name: 'resolver present but THROWING (users:read revoked / bridge down)',
        hooks: { resolveUserIdByAddress: async () => { throw new Error('no users:read grant'); } }
    },
];

async function makeStore(hooks?: any) {
    const db = makeDb();
    const Email = createEmailStore(db, hooks);
    await Email.initSchema();
    return { db, Email };
}

/** A pre-v2.1 row: written before the user_id column existed, so it carries the legacy sentinel 0. */
async function insertLegacy(
    db: any,
    opts: { to: string; cc?: string; bcc?: string; from?: string; subject?: string; body?: string; flags?: Record<string, number> }
): Promise<number> {
    const f: Record<string, number> = Object.assign(
        { is_sent: 0, is_draft: 0, is_archived: 0, is_starred: 0, is_trash: 0, is_spam: 0, is_read: 0 },
        opts.flags || {}
    );
    const res = await db.run(
        `INSERT INTO ${T} (from_address, to_address, cc_address, bcc_address, subject, body_text, user_id, ` +
        `is_sent, is_draft, is_archived, is_starred, is_trash, is_spam, is_read) ` +
        `VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [opts.from || 'ext@other.com', opts.to, opts.cc || '', opts.bcc || '', opts.subject || 's', opts.body || 'x',
            f.is_sent, f.is_draft, f.is_archived, f.is_starred, f.is_trash, f.is_spam, f.is_read]
    );
    return res.lastID;
}

function insertLegacyBulk(db: any, to: string, count: number) {
    const stmt = db._raw.prepare(
        `INSERT INTO ${T} (from_address, to_address, cc_address, bcc_address, subject, body_text, user_id, ` +
        `is_sent, is_draft, is_archived, is_starred, is_trash, is_spam, is_read) ` +
        `VALUES ('ext@other.com', ?, '', '', ?, 'x', 0, 0, 0, 0, 0, 1, 0, 0)`
    );
    db._raw.transaction(() => {
        for (let i = 0; i < count; i++) stmt.run(to, `ruido ${i}`);
    })();
}

// =====================================================================================
// 1. EVERY STORE METHOD IS CLASSIFIED, AND EVERY CLASS IS ENFORCED
// =====================================================================================

// Methods that take (userId, email, …) and MUST filter to that user through _ownerClause. Each entry
// carries a live probe so the classification is exercised, never merely declared.
const OWNERSHIP_SCOPED: Record<string, (E: any, u: { id: number; email: string }) => Promise<any>> = {
    findAllByUser: (E, u) => E.findAllByUser(u.id, u.email, 'inbox'),
    countByUser: (E, u) => E.countByUser(u.id, u.email, 'inbox'),
    getCounts: (E, u) => E.getCounts(u.id, u.email),
    countUnreadInbox: (E, u) => E.countUnreadInbox(u.id, u.email),
    search: (E, u) => E.search(u.id, u.email, { text: 'secreto' }),
    searchByUser: (E, u) => E.searchByUser(u.id, u.email, 'secreto'),
    suggestContacts: (E, u) => E.suggestContacts(u.id, u.email, 'ext', 8),
    findByThreadId: (E, u) => E.findByThreadId(1, u.id, u.email),
    emptyTrash: (E, u) => E.emptyTrash(u.id, u.email),
    _ownerClause: (E, u) => E._ownerClause(u.id, u.email),
    _folderClause: (E, u) => E._folderClause(u.id, u.email, 'inbox'),
    _legacyOwnership: (E, u) => E._legacyOwnership(u.email),
    _legacyOwnedIds: (E, u) => E._legacyOwnedIds(u.email),
    _legacyScan: (E, u) => E._legacyScan(u.email),
};

// Methods addressed by ROW ID. The store cannot authorize these — it is not told who is asking — so
// the invariant is enforced one layer up: every index.js route that calls one must gate the row with
// canAccessEmail()/Email._ownsRow() first, which the structural test below checks call by call.
const ID_ADDRESSED = new Set([
    'findById', 'findByIds', 'update', 'markAsRead', 'setRead', 'setStarred', 'setArchived', 'setSpam',
    'moveToTrash', 'restoreFromTrash', 'bulkSetFlags', 'cancelScheduled', 'deletePermanently',
    'deleteManyPermanently', 'addLabelToEmails', 'removeLabelFromEmails', 'getLabelsForEmails',
    'getAttachments', 'getAttachmentsForEmails', 'getAttachmentById', 'saveAttachment', 'markRetry',
    'markFailed', 'markSent', 'findByMessageId',
]);

// Not row access at all: schema/infra/secrets/per-user label+pref CRUD (those key on user_id
// directly and hold no message content), and the ownership primitives themselves.
const NOT_ROW_ACCESS = new Set([
    'initSchema', '_backfillOwnership', '_resolveLegacyOwner', '_createIndex', '_ensureColumn',
    '_migrateLegacyTables', 'getSecret', 'setSecret', 'create', 'canUserAccess', '_tokensOf',
    '_ownershipOf', '_ownsRow', '_mayDestroyRow', '_resolveAddressId', '_assertOwned',
    // "is this row the only copy more than one mailbox here has" — the CONTENT half of the same
    // verdict (see _isSharedRow), consulted by update() and by the two composer routes. It answers
    // the ownership question; it does not ask it of anybody.
    '_isSharedRow',
    // Drops both ownership memos in ONE place so they cannot disagree about which write invalidated
    // them. Pure cache management: it reads no row and returns no row.
    '_forgetOwnershipMemos',
    // THE predicate itself and the one place its DESTROY mode narrows its READ mode. They answer the
    // ownership question; they do not ask it of anybody.
    '_scopeClause', '_destroyableLegacyIds',
    'listLabels', 'findLabel', 'createLabel', 'updateLabel', 'deleteLabel', 'findLabelByName',
    'getPrefs', 'setPrefs', 'getPendingScheduled', 'getPendingRetries',
    'purgeOldSpam', // site-wide retention: no user, and the ONLY SYSTEM_RETENTION caller
    'allowAttachmentRoot', 'resolveAttachmentSource',
]);

test('CLASS: every function the store exposes is classified — a new one fails here, not in production', async () => {
    const { Email } = await makeStore(directoryResolver());
    const methods = Object.keys(Email).filter(k => typeof Email[k] === 'function');
    assert.ok(methods.length > 40, 'the store still exposes its API');

    const unclassified = methods.filter(m =>
        !(m in OWNERSHIP_SCOPED) && !ID_ADDRESSED.has(m) && !NOT_ROW_ACCESS.has(m));
    assert.deepEqual(
        unclassified, [],
        'these store methods are new and nothing here says how they answer "who owns this row". Add each ' +
        'to OWNERSHIP_SCOPED (with a probe), to ID_ADDRESSED (and gate its route), or to NOT_ROW_ACCESS ' +
        'with a reason. Silence is how three waves of fixes each covered one surface and missed its twin.'
    );
    // …and the classification cannot rot in the other direction either.
    for (const name of [...Object.keys(OWNERSHIP_SCOPED), ...ID_ADDRESSED, ...NOT_ROW_ACCESS]) {
        assert.ok(methods.includes(name), `${name} is classified here but the store no longer exposes it`);
    }
});

test('CLASS: every ownership-scoped method answers over ONE user, for legacy AND modern rows', async () => {
    const { db, Email } = await makeStore(directoryResolver());
    // Mariana's mail in both shapes: an attributed row and an un-attributed (user_id = 0) one. Ana's
    // address is a strict SUBSTRING of Mariana's, which is what every substring rule matched on.
    await Email.create({ messageId: '<m@t>', fromAddress: 'ext@other.com', toAddress: MARIA.email, subject: 'secreto de mariana', bodyText: 'secreto 4200', userId: MARIA.id, threadId: 1 });
    await insertLegacy(db, { to: MARIA.email, subject: 'secreto viejo', body: 'secreto 4200', flags: { is_trash: 1 } });

    for (const [name, probe] of Object.entries(OWNERSHIP_SCOPED)) {
        const result = await probe(Email, ANA);
        const blob = JSON.stringify(result === undefined ? null : result);
        assert.ok(!blob.includes('secreto'), `${name} leaked another mailbox's content to ana@`);
        assert.ok(!blob.includes('4200'), `${name} leaked another mailbox's body to ana@`);
        if (name === 'getCounts') assert.equal((result as any).inbox_unread, 0, 'getCounts counted a foreign row');
        if (name === 'countByUser' || name === 'countUnreadInbox') assert.equal(result, 0, `${name} counted a foreign row`);
        if (name === 'emptyTrash') assert.equal(result, 0, 'emptyTrash destroyed a foreign trashed row');
    }
    // And the legacy row is still there — the destructive probe above ran for real.
    assert.equal(
        (db as any)._raw.prepare(`SELECT COUNT(*) AS c FROM ${T}`).get().c, 2,
        'no row was destroyed by another mailbox running every scoped method against it'
    );
});

test('CLASS: EVERY id-addressed store call in index.js — not only the ones inside a route — is gated', () => {
    // WHY THIS ENUMERATES INSTEAD OF INSPECTING. The previous version walked the `route(` blocks and
    // asserted that any block naming an id-addressed method also contained the gate. That is a
    // property of the code it LOOKED AT, not of the population: eleven calls (the retry queue, the
    // inbound threading probe, sendMail's own draft rewrite) live outside every route block and were
    // never examined — and moving a call out of a route into a helper removed it from the assertion
    // in silence. So the population is now every `Email.<idAddressed>(` in the file, and a call is
    // acceptable only if it is inside a gated route block, its route is exempt WITH a reason, or it
    // carries a `NOT-A-USER-PATH:` marker in the comment immediately above it. A new call with none
    // of the three fails by default.
    const lines = INDEX_SRC.split('\n');
    // Comment lines are BLANKED rather than dropped, so indices still address the real file.
    const code = lines.map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l));

    // Route blocks: `    route(...` … up to the closing `    });` at the same indent.
    const blocks: Array<{ from: number; to: number; head: string; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^ {4}route\(/.test(lines[i])) continue;
        let j = i + 1;
        while (j < lines.length && !/^ {4}\}\);\s*$/.test(lines[j])) j++;
        blocks.push({ from: i, to: j, head: lines[i].trim(), text: code.slice(i, j + 1).join('\n') });
    }
    assert.ok(blocks.length > 25, `expected the plugin's route blocks to be found; got ${blocks.length}`);

    // The exemption is per CALL SITE, never per method name: exempting `findById` globally would let
    // ANY future route read any row ungated, which is the same "name one surface, leave the siblings
    // open" shape this whole wave exists to close. A route block is exempt only if its own signature
    // is listed here WITH the reason its calls need no per-row gate.
    const ROUTE_EXEMPT = new Map<string, string>([
        ["route('get', '/emails/search'",
            'decorates rows Email.search already filtered through the ownership clause; the ids never come from the request'],
        ["route('get', '/emails'",
            'decorates rows Email.findAllByUser already filtered through the ownership clause; the ids never come from the request'],
    ]);
    const GATE = /canAccessEmail\(|Email\._ownsRow\(/;
    const MARKER = /NOT-A-USER-PATH:/;

    // THE POPULATION, derived from the source: every id-addressed call in the whole file.
    const population: Array<{ line: number; method: string }> = [];
    for (let i = 0; i < code.length; i++) {
        for (const m of ID_ADDRESSED) {
            if (code[i].includes(`Email.${m}(`)) population.push({ line: i, method: m });
        }
    }
    assert.ok(population.length > 30,
        `expected to find the plugin's id-addressed call sites; got ${population.length}`);

    /** The contiguous comment block immediately above `i` (plus the call's own line). */
    const noteAbove = (i: number) => {
        const parts = [lines[i]];
        for (let k = i - 1; k >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[k]); k--) parts.push(lines[k]);
        return parts.join('\n');
    };

    const ungated: string[] = [];
    const unusedExemptions = new Set(ROUTE_EXEMPT.keys());
    for (const call of population) {
        const block = blocks.find(b => call.line >= b.from && call.line <= b.to);
        if (block) {
            const exemption = [...ROUTE_EXEMPT.keys()].find(k => block.head.startsWith(k));
            if (exemption) { unusedExemptions.delete(exemption); continue; }
            if (GATE.test(block.text)) continue;
        }
        if (MARKER.test(noteAbove(call.line))) continue;
        ungated.push(`line ${call.line + 1}: Email.${call.method}( — ${lines[call.line].trim().slice(0, 90)}`);
    }
    assert.deepEqual(
        ungated, [],
        'these calls reach an id-addressed store method without the row having passed the one ownership ' +
        'predicate (canAccessEmail / Email._ownsRow). Put the call behind the gate, or write a ' +
        '`// NOT-A-USER-PATH: <reason>` comment immediately above it saying why no user chose this id ' +
        '(delivery, retry queue, a continuation of a route that already checked).'
    );
    assert.deepEqual([...unusedExemptions], [],
        'these ROUTE_EXEMPT entries no longer match any route — the exemption list has gone stale');

    // A marker is a claim about a call site, so it may not be left behind on a line that no longer
    // makes one: every NOT-A-USER-PATH marker must sit above (or on) an id-addressed call.
    const markedLines = new Set(population.map(c => c.line));
    const stale: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!MARKER.test(lines[i])) continue;
        let k = i;
        while (k < lines.length && /^\s*(\/\/|\*|\/\*)/.test(lines[k])) k++;
        if (!markedLines.has(k)) stale.push(`line ${i + 1}: ${lines[i].trim().slice(0, 80)}`);
    }
    assert.deepEqual(stale, [], 'these NOT-A-USER-PATH markers no longer sit above an id-addressed call');
});

// =====================================================================================
// 2. THE DESTRUCTION CHOKEPOINT
// =====================================================================================

test('CLASS: permanent destruction has ONE sink, and no caller reaches it without an actor', () => {
    // The row DELETE lives in exactly one function, so the predicate can live in that statement.
    const deleteSites = [...STORE_CODE.matchAll(/DELETE FROM \$\{T_EMAILS\}[^`]*/g)].map(m => m[0]);
    assert.equal(deleteSites.length, 1, 'only deleteManyPermanently may DELETE a message row');
    // THE ACCEPTANCE TEST OF THE WHOLE REDESIGN: the statement that destroys rows CONTAINS the
    // ownership predicate. Not "the function calls a checker first" — round 3 walked around that
    // twice without touching the checker — but a WHERE the ids are intersected with.
    assert.match(
        deleteSites[0],
        /WHERE id IN \(\$\{ph\}\) AND \$\{scope\.clause\}/,
        'the one DELETE must compose the ownership clause into its own WHERE: ids from a caller are an ' +
        'INTERSECTION, never an authorization'
    );
    assert.match(
        STORE_CODE,
        /async deleteManyPermanently\(ids, actor\)[\s\S]{0,1600}_scopeClause\(actor, SCOPE\.DESTROY/,
        'the sink must derive its clause from the ONE predicate, in DESTROY mode, from the actor it was given'
    );
    // …and the same predicate, in the same mode, is what site-wide retention selects with — the
    // branch that used to skip the gate entirely.
    assert.match(
        STORE_CODE,
        /async purgeOldSpam\(days = 30\)[\s\S]{0,600}_scopeClause\(SYSTEM_RETENTION, SCOPE\.DESTROY/,
        'retention must compose the predicate too — "site-wide" is a MODE of it, not an exemption from it'
    );
    // Every caller, in the store AND in the plugin routes, passes a second argument.
    for (const [src, label] of [[STORE_CODE, 'email-store.js'], [INDEX_CODE, 'index.js']] as const) {
        const calls = [...src.matchAll(/Email\.deleteManyPermanently\s*\(|Email\.deletePermanently\s*\(|this\.deleteManyPermanently\s*\(|await this\.deleteManyPermanently\s*\(/g)];
        for (const c of calls) {
            const tail = src.slice(c.index!, c.index! + 400);
            assert.ok(
                /SYSTEM_RETENTION/.test(tail) || /userId\s*:/.test(tail) || /\{\s*userId/.test(tail),
                `a permanent-delete call in ${label} passes no actor:\n    ${tail.split('\n').slice(0, 4).join('\n    ')}`
            );
        }
    }
    // The route wiring, spelled out: both destructive routes hand the requester down.
    assert.match(INDEX_CODE, /Email\.deletePermanently\(req\.params\.id, \{\s*\n?\s*userId: req\.user\.id, userEmail: req\.user\.userEmail\s*\n?\s*\}\)/,
        'DELETE /emails/:id must pass the requester as the destruction actor');
    assert.match(INDEX_CODE, /Email\.deleteManyPermanently\(\s*\n?[\s\S]{0,200}\{ userId: req\.user\.id, userEmail: req\.user\.userEmail \}/,
        'POST /emails/bulk {action:delete} must pass the requester as the destruction actor');
});

test('CLASS: an un-actored permanent delete destroys NOTHING — and the retention actor is not a skeleton key', async () => {
    const { db, Email } = await makeStore(directoryResolver());
    const row = await Email.create({ messageId: '<x@t>', fromAddress: 'ext@other.com', toAddress: ANA.email, subject: 's', bodyText: 'x', userId: ANA.id, isTrash: 1 });
    assert.equal(await Email.deleteManyPermanently([row.id]), 0, 'no actor, no destruction');
    assert.equal(await Email.deleteManyPermanently([row.id], {}), 0, 'an empty actor is not an actor');
    assert.equal(await Email.deleteManyPermanently([row.id], { userId: 0, userEmail: '' }), 0, 'user 0 is not an actor');
    assert.ok(await Email.findById(row.id), 'the row survives every un-actored call');

    // THE RETENTION ACTOR IS A MODE OF THE PREDICATE, NOT A BYPASS. Handed a row that is not
    // retention material it destroys nothing, because its clause is in the DELETE like everyone
    // else's. Round 3's critical was exactly this: reaching the sink with SYSTEM_RETENTION skipped
    // the per-row question entirely, so anything a reader could flag as spam could be reaped.
    assert.equal(
        await Email.deleteManyPermanently([row.id], Email.SYSTEM_RETENTION), 0,
        'a trashed, non-spam message is not retention material — the symbol alone destroys nothing'
    );
    assert.ok(await Email.findById(row.id), 'and it is still there');

    // Its own material — spam of an attributed owner, flagged by nobody (the delivery classifier) —
    // is reaped, so the retention journey still works.
    const spam = await Email.create({ messageId: '<s@t>', fromAddress: 'ext@other.com', toAddress: ANA.email, subject: 's', bodyText: 'x', userId: ANA.id, isSpam: 1 });
    assert.equal(await Email.deleteManyPermanently([spam.id], Email.SYSTEM_RETENTION), 1);

    assert.equal(typeof Email.SYSTEM_RETENTION, 'symbol', 'the retention actor must not be forgeable from request data');
    assert.deepEqual(INDEX_CODE.match(/SYSTEM_RETENTION/g) || [], [],
        'no route may borrow the retention actor to skip the gate');
    void db;
});

// The destruction/read matrix. Every row shape × every viewer, in ONE table, so a new shape is added
// here rather than discovered by a round-3 report.
const ROW_SHAPES: Array<{ name: string; row: any; readers: string[]; destroyers: string[] }> = [
    {
        name: 'modern: ana owns her delivered copy, which names every recipient',
        row: { user_id: ANA.id, from_address: JEFE.email, to_address: `${ANA.email}, ${MARIA.email}` },
        readers: [ANA.email], destroyers: [ANA.email],
    },
    {
        name: 'modern: mariana owns HER copy of the same message',
        row: { user_id: MARIA.id, from_address: JEFE.email, to_address: `${ANA.email}, ${MARIA.email}` },
        readers: [MARIA.email], destroyers: [MARIA.email],
    },
    {
        name: 'legacy fan-out copy: several site accounts are parties — readable by both, destroyable by neither',
        row: { user_id: 0, from_address: JEFE.email, to_address: `${ANA.email}, ${MARIA.email}` },
        readers: [ANA.email, MARIA.email, JEFE.email], destroyers: [],
    },
    {
        name: 'legacy: a cc party is a party too',
        row: { user_id: 0, from_address: 'ext@other.com', to_address: JEFE.email, cc_address: `otro@fuera.com, ${MARIA.email}` },
        readers: [MARIA.email, JEFE.email], destroyers: [],
    },
    {
        name: 'legacy: bcc counts, and a bcc recipient alongside a local To does not get to destroy',
        row: { user_id: 0, from_address: 'ext@other.com', to_address: JEFE.email, bcc_address: ANA.email },
        readers: [ANA.email, JEFE.email], destroyers: [],
    },
    {
        name: 'legacy: sole local recipient of external mail — hers to destroy',
        row: { user_id: 0, from_address: 'ext@other.com', to_address: ANA.email },
        readers: [ANA.email], destroyers: [ANA.email],
    },
    {
        name: 'legacy sent copy to an EXTERNAL client: only the sender can lose it',
        row: { user_id: 0, is_sent: 1, from_address: ANA.email, to_address: 'cliente@fuera.com' },
        readers: [ANA.email], destroyers: [ANA.email],
    },
    {
        name: 'legacy sent copy to a LOCAL colleague: the recipient would lose it too (finding #26, sibling branch)',
        row: { user_id: 0, is_sent: 1, from_address: ANA.email, to_address: MARIA.email },
        readers: [ANA.email, MARIA.email], destroyers: [],
    },
    {
        name: 'substring neighbour: ana@ is inside mariana@ and owns nothing here',
        row: { user_id: 0, from_address: 'ext@other.com', to_address: MARIA.email },
        readers: [MARIA.email], destroyers: [MARIA.email],
    },
];

test('CLASS: every row shape × every viewer × every PREDICATE CONFIGURATION — destroy never widens', async () => {
    const viewers = [ANA, MARIA, JEFE, { id: 999, email: 'admin@empresa.com' }];
    // The reference answers come from the resolved directory (config 0) and are the table above.
    for (const [i, config] of RESOLVER_CONFIGS.entries()) {
        const { Email } = await makeStore(config.hooks);
        for (const shape of ROW_SHAPES) {
            for (const v of viewers) {
                const canRead = Email._ownsRow(shape.row, v.id, v.email);
                const canDestroy = await Email._mayDestroyRow(shape.row, v.id, v.email, new Map());
                // READ does not consult identity at all, so it must be the SAME in every configuration.
                assert.equal(canRead, shape.readers.includes(v.email),
                    `[${config.name}] ${shape.name}: read verdict for ${v.email}`);
                assert.ok(!canDestroy || canRead,
                    `[${config.name}] ${shape.name}: ${v.email} may destroy what they may not read`);
                if (i === 0) {
                    assert.equal(canDestroy, shape.destroyers.includes(v.email),
                        `${shape.name}: destroy verdict for ${v.email}`);
                } else if (canDestroy) {
                    // THE INVARIANT ACROSS CONFIGURATIONS. Losing the identity service may only make
                    // the destroy set SMALLER. A configuration that destroys something the resolved
                    // one refuses is the finding: an unavailable answer read as "nobody else here".
                    assert.ok(
                        shape.destroyers.includes(v.email),
                        `[${config.name}] ${shape.name}: ${v.email} may destroy this row here but NOT with a ` +
                        'working identity resolver. Degrading the identity service must never widen the ' +
                        'destroy verdict — that is the whole shape of the finding.'
                    );
                }
            }
        }
    }
});

test('CLASS: a resolver that ANSWERS ZERO for everyone is indistinguishable from the truth — so the host may not do it', async () => {
    // THE LIMIT OF THE MATRIX ABOVE, stated instead of implied. A hook that returns 0 is asserting a
    // FACT ("that address is nobody here"); the store has no way to tell a confident wrong answer
    // from a right one, and with it the sent-to-a-colleague row becomes destroyable by the recipient.
    // It is measured here so the exposure is on the record, and then closed where it CAN be closed:
    // in the host hook, which must THROW on a failed lookup rather than answering zero.
    const { Email } = await makeStore({ resolveUserIdByAddress: async () => 0 });
    const sentToColleague = ROW_SHAPES.find(s => s.name.includes('LOCAL colleague'))!;
    assert.equal(sentToColleague.destroyers.length, 0, 'the fixture is the shape whose verdict inverts');
    assert.equal(
        await Email._mayDestroyRow(sentToColleague.row, MARIA.id, MARIA.email, new Map()), true,
        'documented exposure: a resolver that lies "no such account" hands the row to the recipient'
    );

    // …so the injected hook must never turn a failure into that answer. This is the load-bearing half.
    const hook = INDEX_CODE.match(/resolveUserIdByAddress: async \(address\) => \{[\s\S]*?\n {8}\}/);
    assert.ok(hook, 'the identity hook must still be recognizable in index.js');
    assert.ok(
        /catch \(e\) \{[\s\S]*?throw /.test(hook![0]),
        'the identity hook must THROW when the lookup fails. `return 0` there means "this address is ' +
        'not a site account", which the destruction gate acts on — it is how a missing users:read ' +
        'grant became permission to destroy a shared row.'
    );
    assert.ok(
        !/catch \(e\) \{\s*\n?\s*return 0/.test(hook![0]),
        'the identity hook still swallows its failure into a zero'
    );
});

test('#6 STILL LIVE (round 2): a party of a shared legacy row cannot annihilate it — by any route', async () => {
    const { db, Email } = await makeStore(directoryResolver());
    // THE EXACT SHAPE index.js sendMail fabricates, written the way the version whose `user_id:`
    // spelling the store dropped wrote it: a Sent copy plus one copy PER LOCAL RECIPIENT, every copy
    // naming ALL recipients — all of them at user_id = 0.
    const both = `${MARIA.email}, ${JEFE.email}`;
    const sent = await insertLegacy(db, { from: ANA.email, to: both, subject: 'reunion', body: 'a las 10', flags: { is_sent: 1 } });
    const forMaria = await insertLegacy(db, { from: ANA.email, to: both, subject: 'reunion', body: 'a las 10' });
    const forJefe = await insertLegacy(db, { from: ANA.email, to: both, subject: 'reunion', body: 'a las 10' });

    // Jefe trashes Mariana's copy (he can SEE it — that is the shared arm working as designed) and
    // presses "Empty trash". Round 2's finding: `destroyed 1`, the row gone, the attachment unlinked.
    await Email.moveToTrash(forMaria);
    assert.equal(await Email.emptyTrash(JEFE.id, JEFE.email), 0, 'no row of a shared message may be destroyed');
    assert.ok(await Email.findById(forMaria), 'MARIANA\'S COPY SURVIVES — this is the irreversible half');

    // …and neither of the two other routes that reach the same sink can do it either.
    assert.equal(await Email.deletePermanently(forMaria, { userId: JEFE.id, userEmail: JEFE.email }), 0);
    assert.equal(await Email.deleteManyPermanently([forMaria, forJefe, sent], { userId: JEFE.id, userEmail: JEFE.email }), 0);
    assert.equal((db as any)._raw.prepare(`SELECT COUNT(*) AS c FROM ${T}`).get().c, 3, 'every row is still there');
});

test('an attachment blob shared by two rows is not unlinked while one of them survives', async () => {
    const { db, Email } = await makeStore(directoryResolver());
    const a = await Email.create({ messageId: '<a@t>', fromAddress: 'ext@other.com', toAddress: ANA.email, subject: 's', bodyText: 'x', userId: ANA.id, isTrash: 1 });
    const b = await Email.create({ messageId: '<b@t>', fromAddress: 'ext@other.com', toAddress: MARIA.email, subject: 's', bodyText: 'x', userId: MARIA.id });
    const blob = 'shared-blob.bin';
    const full = path.join(Email.UPLOAD_DIR, blob);
    await fsp.mkdir(Email.UPLOAD_DIR, { recursive: true });
    await fsp.writeFile(full, 'payload');
    for (const id of [a.id, b.id]) {
        await db.run(`INSERT INTO ${T_ATT} (email_id, filename, content_type, size, storage_path, content_id) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, 'doc.pdf', 'application/pdf', 7, blob, null]);
    }
    assert.equal(await Email.deleteManyPermanently([a.id], { userId: ANA.id, userEmail: ANA.email }), 1);
    assert.ok(fs.existsSync(full), 'the surviving row still points at this blob — it must not be unlinked');
    assert.equal(await Email.deleteManyPermanently([b.id], { userId: MARIA.id, userEmail: MARIA.email }), 1);
    assert.ok(!fs.existsSync(full), 'the last reference gone, the blob is cleaned up');
});

// =====================================================================================
// 3. THE PRE-FILTER MAY NEVER BE NARROWER THAN THE DECIDER
// =====================================================================================

// Every spelling a comma-joined recipient list can arrive in. The wave-3 pre-filter hard-coded ', '
// while canUserAccess trims, so the middle rows below were readable by _ownsRow and INVISIBLE to
// every SQL query — mail that exists for one predicate and not for the other.
const LIST_SPELLINGS: Array<{ label: string; field: string; member: boolean }> = [
    { label: 'exact, alone', field: 'ana@empresa.com', member: true },
    { label: 'canonical ", " separator', field: 'jefe@empresa.com, ana@empresa.com', member: true },
    { label: 'no space after comma', field: 'jefe@empresa.com,ana@empresa.com', member: true },
    { label: 'TWO spaces after comma', field: 'jefe@empresa.com,  ana@empresa.com', member: true },
    { label: 'space BEFORE the comma', field: 'jefe@empresa.com ,ana@empresa.com', member: true },
    { label: 'leading space on the whole field', field: ' ana@empresa.com', member: true },
    { label: 'trailing space on the whole field', field: 'ana@empresa.com ', member: true },
    { label: 'tab after the comma', field: 'jefe@empresa.com,\tana@empresa.com', member: true },
    { label: 'newline after the comma (folded header)', field: 'jefe@empresa.com,\nana@empresa.com', member: true },
    { label: 'head of the list', field: 'ana@empresa.com, jefe@empresa.com', member: true },
    { label: 'middle of a three-way list', field: 'jefe@empresa.com, ana@empresa.com, otro@empresa.com', member: true },
    { label: 'UPPER CASE', field: 'JEFE@EMPRESA.COM, ANA@EMPRESA.COM', member: true },
    { label: 'trailing comma', field: 'ana@empresa.com,', member: true },
    // Non-members: the substring neighbour and the separator this store does not accept.
    { label: 'substring neighbour only', field: 'mariana@empresa.com', member: false },
    { label: 'substring neighbour in a list', field: 'jefe@empresa.com, mariana@empresa.com', member: false },
    // ';' IS a separator, because index.js has always split on it: a legacy row spelled that way had
    // one party set for the composer and another for the ownership predicate — nobody was a party to
    // it, so it was invisible to both its recipients. One parser, one answer (Email._tokensOf, which
    // index.js's splitAddresses now IS).
    { label: 'semicolon separator, the OTHER spelling index.js accepts', field: 'jefe@empresa.com;ana@empresa.com', member: true },
    { label: 'a longer local part that contains ours', field: 'juliana@empresa.com', member: false },
];

test('CLASS: the SQL pre-filter agrees with the exact decider for EVERY list spelling', async () => {
    const { db, Email } = await makeStore(); // no resolver: the exact-filtered legacy path, on purpose
    const ids: Record<string, number> = {};
    for (const s of LIST_SPELLINGS) ids[s.label] = await insertLegacy(db, { to: s.field, subject: s.label });

    const found = new Set(await Email._legacyOwnedIds(ANA.email));
    for (const s of LIST_SPELLINGS) {
        const row = await Email.findById(ids[s.label]);
        const decider = Email.canUserAccess(row, ANA.email);
        assert.equal(decider, s.member, `canUserAccess disagrees with the table for: ${s.label}`);
        assert.equal(
            found.has(ids[s.label]), s.member,
            `THE PRE-FILTER AND THE DECIDER DISAGREE for "${s.label}" (${JSON.stringify(s.field)}). The SQL ` +
            'pre-filter may over-select all it likes — canUserAccess decides — but it may NEVER be ' +
            'narrower, or the row exists for _ownsRow and not for any listing, counter or search.'
        );
    }
    // End to end, through the surfaces a user actually touches.
    const inbox = await Email.findAllByUser(ANA.id, ANA.email, 'inbox');
    assert.equal(inbox.length, LIST_SPELLINGS.filter(s => s.member).length, 'every member spelling reaches the inbox');
    assert.equal((await Email.getCounts(ANA.id, ANA.email)).inbox_unread, LIST_SPELLINGS.filter(s => s.member).length);
});

test('CLASS: from_address goes through the same pre-filter as to/cc/bcc', async () => {
    const { db, Email } = await makeStore();
    // `LOWER(from_address) = ?` was a THIRD, narrower answer: canUserAccess tokenizes from_address, so
    // a leading space there hid the row from every query while _ownsRow still said yes.
    const padded = await insertLegacy(db, { from: ` ${ANA.email}`, to: 'cliente@fuera.com', flags: { is_sent: 1 } });
    const plain = await insertLegacy(db, { from: ANA.email, to: 'otro@fuera.com', flags: { is_sent: 1 } });
    const ids = new Set(await Email._legacyOwnedIds(ANA.email));
    assert.ok(ids.has(padded), 'a padded from_address is still this user\'s mail');
    assert.ok(ids.has(plain));
    assert.deepEqual((await Email.findAllByUser(ANA.id, ANA.email, 'sent')).map((r: any) => r.id).sort(), [padded, plain].sort());
});

test('a LIKE wildcard inside an address cannot pre-select a neighbour\'s mail', async () => {
    const VICTIM = { id: 201, email: 'a_a@empresa.com' };
    const { db, Email } = await makeStore();
    const mine = await insertLegacy(db, { to: VICTIM.email, subject: 'la unica' });
    for (let i = 0; i < 50; i++) await insertLegacy(db, { to: 'axa@empresa.com', subject: `ruido ${i}` });
    assert.deepEqual(await Email._legacyOwnedIds(VICTIM.email), [mine]);
    // The point is not just the result — it is that the neighbour never entered the scan at all.
    const scan = await Email._legacyScan(VICTIM.email);
    assert.deepEqual(scan, { ids: [mine], complete: true }, '_ scan must not burn budget on axa@');
});

// =====================================================================================
// 4. THE BUDGET IS HONEST — derived from the constants in force, not from a literal
// =====================================================================================

test('CLASS: a scan that could not be completed is reported, never served as the whole truth', async () => {
    const { db, Email } = await makeStore();
    assert.ok(Email.LEGACY_SCAN_CAP > 0, 'the store exports the cap this fixture is built from');
    // The victim's row is the OLDEST; the noise is a mailbox whose address CONTAINS hers, so the
    // substring pre-filter selects all of it and the keyset scan (id DESC) runs out before reaching
    // her. Seeded from the EXPORTED constant: bumping the cap can no longer leave this test
    // calibrated to pass. (Round 2 found it pinned at 2001 against a cap of 20000.)
    const mine = await insertLegacy(db, { to: ANA.email, subject: 'la unica de ana', flags: { is_trash: 1 } });
    insertLegacyBulk(db, MARIA.email, Email.LEGACY_SCAN_CAP + 1);

    const scan = await Email._legacyScan(ANA.email);
    assert.equal(scan.complete, false, 'the scan gave up — and must SAY so');

    // The lie this replaces: "Trash emptied (0 message(s) deleted)" over mail that is still there.
    await assert.rejects(
        () => Email.emptyTrash(ANA.id, ANA.email),
        (e: any) => e && e.code === 'mail_legacy_scan_incomplete',
        'emptyTrash must REFUSE on a partial view instead of reporting a successful no-op'
    );
    assert.ok(await Email.findById(mine), 'and the message is still there, which is why the refusal matters');
});

test('CLASS: the id cap is honest too, and an exhausted scan is complete', async () => {
    const { db, Email } = await makeStore();
    insertLegacyBulk(db, ANA.email, Email.LEGACY_ID_CAP + 1);
    const capped = await Email._legacyScan(ANA.email);
    assert.equal(capped.ids.length, Email.LEGACY_ID_CAP);
    assert.equal(capped.complete, false, 'a truncated id list is not a complete answer');
    await assert.rejects(() => Email.emptyTrash(ANA.id, ANA.email), (e: any) => e.code === 'mail_legacy_scan_incomplete');

    // WITH the identity resolver: the destruction gate can now rule out ext@other.com as a second
    // mailbox, which is what "Empty trash" over legacy rows requires (without it the store refuses —
    // see mail-server-ownership.test.ts, 'empty trash REFUSES, loudly').
    const { db: db2, Email: E2 } = await makeStore(directoryResolver());
    insertLegacyBulk(db2, ANA.email, 3);
    const ok = await E2._legacyScan(ANA.email);
    assert.equal(ok.complete, true);
    assert.equal(await E2.emptyTrash(ANA.id, ANA.email), 3, 'the ordinary journey still works end to end');
});

test('one folder poll costs ONE legacy scan, not three', async () => {
    const { db, Email } = await makeStore();
    await insertLegacy(db, { to: ANA.email, subject: 'x' });
    let scans = 0;
    const real = Email._legacyScan.bind(Email);
    Email._legacyScan = async (k: string) => { scans++; return await real(k); };
    // Exactly what index.js GET /emails does: three ownership-scoped queries in one Promise.all. The
    // result-only memo was written AFTER the await, so all three missed it.
    await Promise.all([
        Email.findAllByUser(ANA.id, ANA.email, 'inbox'),
        Email.countByUser(ANA.id, ANA.email, 'inbox'),
        Email.getCounts(ANA.id, ANA.email),
    ]);
    assert.equal(scans, 1, 'the in-flight promise must be shared, not the finished result');
});

// =====================================================================================
// 5. THE BACKFILL: one rule for both branches, and a fan-out that already happened
// =====================================================================================

test('REGRESSION: a fan-out already performed gives each party ONE copy, not N', async () => {
    const db = makeDb();
    const Email = createEmailStore(db, directoryResolver());
    await Email.initSchema();

    // The rows the plugin's own fan-out writes: a Sent copy for the author plus ONE COPY PER LOCAL
    // RECIPIENT, every copy naming BOTH recipients. Judged by address alone all three look "shared",
    // which left them at user_id = 0 — and the ownership clause then handed BOTH inbox copies to BOTH
    // people: two rows each, `inbox_unread: 2` for one message, and read/star flags living on the row
    // so marking one read left its twin unread forever.
    const both = `${MARIA.email}, ${JEFE.email}`;
    await insertLegacy(db, { from: ANA.email, to: both, subject: 'reunion', body: 'a las 10', flags: { is_sent: 1 } });
    const c1 = await insertLegacy(db, { from: ANA.email, to: both, subject: 'reunion', body: 'a las 10' });
    const c2 = await insertLegacy(db, { from: ANA.email, to: both, subject: 'reunion', body: 'a las 10' });

    await Email.initSchema(); // the backfill is idempotent and gated on a COUNT of user_id = 0 rows

    for (const u of [MARIA, JEFE]) {
        const inbox = await Email.findAllByUser(u.id, u.email, 'inbox');
        assert.equal(inbox.length, 1, `${u.email} must see the message ONCE`);
        assert.equal((await Email.getCounts(u.id, u.email)).inbox_unread, 1, `${u.email}'s badge counts one message`);
        assert.equal(await Email.countByUser(u.id, u.email, 'inbox'), 1, 'pagination agrees with the listing');
    }
    // Distinct rows: one each, not the same row shown twice.
    const mariaRow = (await Email.findAllByUser(MARIA.id, MARIA.email, 'inbox'))[0].id;
    const jefeRow = (await Email.findAllByUser(JEFE.id, JEFE.email, 'inbox'))[0].id;
    assert.notEqual(mariaRow, jefeRow, 'each party owns their OWN copy');
    assert.deepEqual([mariaRow, jefeRow].sort(), [c1, c2].sort());

    // …and the flags no longer cross: marking one read leaves the other alone.
    await Email.setRead(mariaRow, true);
    assert.equal((await Email.getCounts(JEFE.id, JEFE.email)).inbox_unread, 1, 'reading mine did not read yours');
    assert.equal((await Email.getCounts(MARIA.id, MARIA.email)).inbox_unread, 0);
    // Each of them may now destroy their own copy — and only their own.
    assert.equal(await Email.deleteManyPermanently([mariaRow, jefeRow], { userId: MARIA.id, userEmail: MARIA.email }), 1);
    assert.ok(await Email.findById(jefeRow), 'the neighbour\'s copy survives');
});

test('REGRESSION: a genuinely shared single row is still shared, and still shown ONCE', async () => {
    const db = makeDb();
    const Email = createEmailStore(db, directoryResolver());
    await Email.initSchema();
    const shared = await insertLegacy(db, { from: 'ext@other.com', to: `${MARIA.email}, ${JEFE.email}`, subject: 'una sola fila' });
    await Email.initSchema();
    assert.equal((db as any)._raw.prepare(`SELECT user_id FROM ${T} WHERE id = ?`).get(shared).user_id, 0,
        'one row, two claimants, no fan-out to infer: nobody may own it');
    for (const u of [MARIA, JEFE]) {
        assert.deepEqual((await Email.findAllByUser(u.id, u.email, 'inbox')).map((r: any) => r.id), [shared]);
        assert.equal((await Email.getCounts(u.id, u.email)).inbox_unread, 1);
    }
});

test('#26 SIBLING BRANCH: the outbound rule is the SAME rule — a sent copy with a local recipient stays shared', async () => {
    const db = makeDb();
    const Email = createEmailStore(db, directoryResolver());
    await Email.initSchema();
    // The branch the wave-3 fix skipped: `is_sent = 1` returned the sender WITHOUT looking at to/cc/bcc,
    // on the grounds that "a Sent copy has exactly one owner by construction" — an assertion about the
    // fan-out of the very version the backfill exists because we do not know.
    const toLocal = await insertLegacy(db, { from: ANA.email, to: MARIA.email, subject: 'local', flags: { is_sent: 1 } });
    const toExternal = await insertLegacy(db, { from: ANA.email, to: 'cliente@fuera.com', subject: 'externo', flags: { is_sent: 1 } });
    const draftLocal = await insertLegacy(db, { from: ANA.email, to: JEFE.email, subject: 'borrador', flags: { is_draft: 1 } });
    await Email.initSchema();

    const owners = Object.fromEntries(
        (db as any)._raw.prepare(`SELECT id, user_id FROM ${T}`).all().map((r: any) => [r.id, r.user_id]));
    assert.equal(owners[toLocal], 0, 'a local recipient is a second claimant — attributing it loses her copy forever');
    assert.equal(owners[draftLocal], 0, 'and the draft branch obeys the same rule');
    assert.equal(owners[toExternal], ANA.id, 'an external recipient claims nothing: the sender owns it');

    // Mariana keeps the message she would otherwise have lost from every listing, counter and search.
    assert.deepEqual((await Email.findAllByUser(MARIA.id, MARIA.email, 'sent')).map((r: any) => r.id), [toLocal]);
    assert.deepEqual((await Email.findAllByUser(ANA.id, ANA.email, 'sent')).map((r: any) => r.id).sort(), [toLocal, toExternal].sort());
});

// =====================================================================================
// 6. THE CLIENT STRING THAT NAMES A FILE
// =====================================================================================

test('CLASS: every sink that reads a client-named file goes through the ONE resolver', () => {
    // Sink 1 — the store copies the file into an attachment row the poster can download back.
    assert.match(
        STORE_CODE,
        /const source = await resolveAttachmentSource\(attachment\.path\);[\s\S]{0,1500}fs\.copyFile\(source,/,
        'saveAttachment must resolve the client path before fs.copyFile — and copy the RESOLVED path'
    );
    assert.deepEqual(
        STORE_CODE.match(/fs\.copyFile\(attachment\.path/g) || [], [],
        'the raw client string must never reach fs.copyFile'
    );
    // Sink 2 — nodemailer opens the file and ships the bytes OUT over SMTP. A guard on sink 1 alone
    // leaves this one wide open, which is precisely the "fixed the example, not the class" shape.
    assert.match(
        INDEX_CODE,
        /await Email\.resolveAttachmentSource\(a && a\.path\)/,
        'the outbound mail builder must resolve every attachment path through the same resolver'
    );
    assert.deepEqual(
        INDEX_CODE.match(/\.map\(a => \(\{ filename: a\.filename, path: a\.path \}\)\)/g) || [], [],
        'the outbound builder must not pass the client path through untouched'
    );
    // …and the only way a directory becomes acceptable is the host's own multipart staging dir.
    assert.match(INDEX_CODE, /Email\.allowAttachmentRoot\(stagingRoot\)/);
    assert.match(INDEX_CODE, /const stagingRoot = path\.dirname\(req\.file\.path\)/,
        'the root must come from req.file.path (host multer), never from the request body');
});

test('CLASS: every shape of a hostile attachment path is refused, and the real journey still works', async () => {
    const { db, Email } = await makeStore(directoryResolver());
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'wjs-mail-staging-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'wjs-mail-outside-'));
    await fsp.writeFile(path.join(staging, 'upload-abc123'), 'the file the user picked');
    await fsp.writeFile(path.join(outside, 'loot.txt'), 'SECRET');
    Email.allowAttachmentRoot(staging);

    const repoFile = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js');
    const HOSTILE: Array<[string, string]> = [
        ['relative traversal out of the staging dir', path.join(staging, '..', path.basename(outside), 'loot.txt')],
        ['traversal spelled with forward slashes', `${staging}/../${path.basename(outside)}/loot.txt`],
        ['absolute path to the server source', repoFile],
        ['absolute path to another temp dir', path.join(outside, 'loot.txt')],
        ['a nested path under a permitted root', path.join(staging, 'sub', 'file.txt')],
        ['the root directory itself', staging],
        ['empty string', ''],
        ['a bare filename resolved against the cwd', 'package.json'],
    ];
    for (const [label, p] of HOSTILE) {
        assert.equal(await Email.resolveAttachmentSource(p), null, `resolver accepted: ${label}`);
        const created = await Email.create({
            messageId: `<h@t>`, fromAddress: ANA.email, toAddress: 'x@fuera.com', subject: label, bodyText: 'x',
            userId: ANA.id, attachments: [{ filename: 'innocent.pdf', path: p }]
        });
        assert.deepEqual(
            await db.all(`SELECT id FROM ${T_ATT} WHERE email_id = ?`, [created.id]), [],
            `an attachment row was created from a hostile path: ${label}`
        );
    }

    // THE JOURNEY: a file the host's own upload handler staged is accepted, copied under an opaque
    // name, and readable back. A containment fix that breaks composing with an attachment is not a fix.
    const legit = await Email.create({
        messageId: '<ok@t>', fromAddress: ANA.email, toAddress: 'x@fuera.com', subject: 'con adjunto', bodyText: 'x',
        userId: ANA.id, attachments: [{ filename: 'informe.pdf', path: path.join(staging, 'upload-abc123'), contentType: 'application/pdf' }]
    });
    const rows = await db.all(`SELECT * FROM ${T_ATT} WHERE email_id = ?`, [legit.id]);
    assert.equal(rows.length, 1, 'the legitimate upload still becomes an attachment');
    assert.equal(rows[0].filename, 'informe.pdf');
    assert.match(rows[0].storage_path, /^[0-9a-f]{32}\.bin$/, 'stored under an opaque name, never the client one');
    assert.equal(
        await fsp.readFile(path.join(Email.UPLOAD_DIR, rows[0].storage_path), 'utf8'), 'the file the user picked');
    // And the plugin's OWN storage dir is a permitted root, which is what the queue and the manual
    // retry build their paths from.
    assert.ok(await Email.resolveAttachmentSource(path.join(Email.UPLOAD_DIR, rows[0].storage_path)));

    await fsp.rm(path.join(Email.UPLOAD_DIR, rows[0].storage_path), { force: true });
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
});
