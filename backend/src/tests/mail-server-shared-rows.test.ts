/**
 * ROUND 4 — A SHARED ROW IS UNTOUCHABLE IN ITS CONTENT AND IN ITS IDENTITY, NOT ONLY IN ITS
 * MEMBERSHIP.
 *
 * WHAT WAVE 5 SHIPPED, AND WHAT IT LEFT. It declared "shared = readable by all, destroyable by none"
 * for pre-v2.1 rows (user_id = 0 with several local parties) and enforced it on ONE axis: update()
 * refused a rewrite that dropped a party from the address columns. Round 4 walked through the other
 * two axes without ever touching that guard:
 *
 *   1. CONTENT. Keep BOTH names on the row and rewrite subject / body / raw_content / is_draft /
 *      is_sent / scheduled_at instead. No token is lost, so the guard says yes — and the other
 *      party's message is gone from every folder, with nothing in their trash. Reproduced below,
 *      through the composer route a real user reaches (POST /drafts).
 *   2. IDENTITY. `from_address` is the one address column update() cannot write, so it SURVIVES —
 *      and it was exactly the value the send queue used as `fromEmail`. POST /send on such a row
 *      made the queue emit a DKIM-signed message whose From was a COLLEAGUE'S address, and the local
 *      copies were stored with it too, so the colleague's own mailbox showed mail "from the boss".
 *      sendMail never checked that the From it was handed belonged to whoever asked for the send.
 *
 * Both are one shape: WHEN YOU CHANGE WHO READS A PIECE OF SHARED STATE, ACCOUNT FOR EVERY WRITER,
 * AND VICE VERSA. The row's address columns had a guarded writer and an unguarded one (content); the
 * From header had a reader (the queue) whose writer (the row) nobody re-examined.
 *
 * WHAT IS DERIVED HERE RATHER THAN LISTED. Two populations come out of the shipped source, so a new
 * member fails without anyone editing this file:
 *   · every column update() can write — each must be refused on a shared row;
 *   · every sendMail() call site in the plugin — none may pass an address as its From, and any
 *     identity it does pass must be MINTED from an account (the requester, or the row's OWNER
 *     resolved from user_id).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { makeDb, PREFIX } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const STORE_PATH = path.join(PLUGIN_DIR, 'lib/email-store.js');
const INDEX_SRC = fs.readFileSync(PLUGIN_SRC, 'utf8');
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');
// Comment lines are stripped: an assertion about the CODE must never be satisfiable by prose that
// quotes the rule (every string below also appears in the explanatory comments).
const INDEX_CODE = INDEX_SRC.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const STORE_CODE = STORE_SRC.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const createEmailStore = require(STORE_PATH);

const T = PREFIX + 'received_emails';
const MAIL_DOMAIN = 'acme.example';
// The site's own identity. `admin_email` is a host-protected option the plugin serves from the site
// bridge, so this is what the fixture's site.adminEmail() answers — deliberately an address that
// belongs to NO account here, so "the site sent it" is never confusable with "a user sent it".
const SITE_FROM = `postmaster@${MAIL_DOMAIN}`;

const ANA = { id: 101, role: 'editor', userEmail: `ana@${MAIL_DOMAIN}`, userLogin: 'ana', displayName: 'Ana', hasProfessionalMailbox: true };
const MARIA = { id: 102, role: 'editor', userEmail: `mariana@${MAIL_DOMAIN}`, userLogin: 'mariana', displayName: 'Mariana', hasProfessionalMailbox: true };
const JEFE = { id: 103, role: 'administrator', userEmail: `jefe@${MAIL_DOMAIN}`, userLogin: 'jefe', displayName: 'Jefe', hasProfessionalMailbox: true };
const PEOPLE = [ANA, MARIA, JEFE];
const DIRECTORY: Record<string, number> = { [ANA.userEmail]: ANA.id, [MARIA.userEmail]: MARIA.id, [JEFE.userEmail]: JEFE.id };

// ================================================================================================
// A. THE STORE, DIRECTLY — the guard and the population of columns it has to cover
// ================================================================================================

function directoryResolver(onResolve?: (a: string) => void) {
    return {
        resolveUserIdByAddress: async (a: string) => {
            const key = String(a || '').trim().toLowerCase();
            if (onResolve) onResolve(key);
            return DIRECTORY[key] || 0;
        }
    };
}

async function makeStore(hooks: any = directoryResolver()) {
    const db = makeDb();
    const Email = createEmailStore(db, hooks);
    await Email.initSchema();
    return { db, Email };
}

/** A pre-v2.1 row: written before user_id existed, so it carries the legacy sentinel 0. */
async function insertLegacy(
    db: any,
    opts: { to: string; cc?: string; from?: string; subject?: string; body?: string; flags?: Record<string, number> }
): Promise<number> {
    const f: Record<string, number> = Object.assign(
        { is_sent: 0, is_draft: 0, is_trash: 0, is_spam: 0, is_archived: 0, is_starred: 0, is_read: 0 }, opts.flags || {});
    const res = await db.run(
        `INSERT INTO ${T} (from_address, to_address, cc_address, bcc_address, subject, body_text, user_id, ` +
        `is_sent, is_draft, is_trash, is_spam, is_archived, is_starred, is_read, date_received) ` +
        `VALUES (?, ?, ?, '', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, '2020-01-01 00:00:00')`,
        [opts.from || 'ext@other.com', opts.to, opts.cc || '', opts.subject || 's', opts.body || 'x',
            f.is_sent, f.is_draft, f.is_trash, f.is_spam, f.is_archived, f.is_starred, f.is_read]
    );
    return res.lastID;
}

test('CRITICAL (round 4): a party of a shared legacy row cannot destroy the other party\'s message content', async () => {
    const { db, Email } = await makeStore();
    const shared = await insertLegacy(db, {
        from: JEFE.userEmail,
        to: `${ANA.userEmail}, ${MARIA.userEmail}`,
        subject: 'nomina de julio',
        body: 'importe confidencial'
    });

    // Before: Mariana holds it, and it is her ONLY copy.
    assert.deepEqual(
        (await Email.findAllByUser(MARIA.id, MARIA.userEmail, 'inbox')).map((r: any) => r.subject),
        ['nomina de julio']
    );

    // THE ATTACK, verbatim from the round-4 probe: keep BOTH parties — so the wave-5 party-set guard
    // has nothing to complain about — and overwrite everything else.
    await assert.rejects(
        () => Email.update(shared, {
            toAddress: `${ANA.userEmail}, ${MARIA.userEmail}`,
            ccAddress: '', bccAddress: '',
            subject: 'hola', bodyText: 'texto de ana',
            isDraft: 0, isSent: 0, scheduledAt: new Date().toISOString()
        }),
        (e: any) => e && e.code === 'mail_shared_row_immutable',
        'a rewrite that keeps every party is still a destruction of the other party\'s message'
    );

    const after = await Email.findById(shared);
    assert.equal(after.subject, 'nomina de julio', 'the subject is intact');
    assert.equal(after.body_text, 'importe confidencial', 'and so is the body');
    assert.equal(after.is_draft, 0);
    assert.equal(after.scheduled_at, null, 'and it was never pushed into the outbox');
    assert.deepEqual(
        (await Email.findAllByUser(MARIA.id, MARIA.userEmail, 'inbox')).map((r: any) => r.id), [shared],
        'Mariana still has it, in the same folder'
    );
});

test('GATE (derived): EVERY column update() can write is refused on a shared row', async () => {
    // POPULATION FROM THE SHIPPED FUNCTION, not from a list written here. It is derived as EVERY
    // INPUT update() READS — the names it destructures out of `data`, plus any `data.<key>` it
    // consults directly — rather than from the columns of its SET builder. That distinction is the
    // whole point: a regression does not usually add a row to the SET builder (which sits inside the
    // guard by construction), it adds a SECOND statement that reads one more key and writes one more
    // column. Deriving from the inputs makes that statement a member of this population the moment
    // it is written.
    const updateBody = STORE_CODE.slice(
        STORE_CODE.indexOf('async update(id, data)'),
        STORE_CODE.indexOf('async findById(id)')
    );
    assert.ok(updateBody.length > 1000, 'update() must be located in the shipped store');
    const inputs = new Set<string>(
        (updateBody.slice(updateBody.indexOf('const {') + 'const {'.length, updateBody.indexOf('} = data;')) || '')
            .replace(/\s/g, '').split(',').filter(Boolean)
    );
    for (const m of updateBody.matchAll(/(?:^|[^\w.])data\.([A-Za-z_]\w*)/g)) inputs.add(m[1]);
    assert.ok(inputs.size >= 13, `expected update()'s inputs to be derived; got ${[...inputs]}`);

    // Cross-check in the other direction: every column the SET builder writes must come from one of
    // those inputs, so a column fed from somewhere this gate cannot reach is named here.
    const toKey = (col: string) => col.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    const columns = [...updateBody.matchAll(/fields\.push\("([a-z_]+) = \?/g)].map(m => m[1]);
    assert.ok(columns.length >= 13, `expected update()'s writable columns to be derived; got ${columns}`);
    const unmapped = columns.filter(c => !inputs.has(toKey(c)));
    assert.deepEqual(
        unmapped, [],
        'these columns are written by update() but no input of the same name feeds them, so this gate ' +
        'cannot probe them. Name the input after the column, or say here why it cannot be.'
    );

    const { db, Email } = await makeStore();
    const shared = await insertLegacy(db, {
        from: JEFE.userEmail, to: `${ANA.userEmail}, ${MARIA.userEmail}`, subject: 'original', body: 'original'
    });

    // The BEFORE image of every column, so the check below is "nothing about this row changed",
    // not "the columns I remembered to name did not change". A regression that adds a SECOND write
    // inside update() — a fast-path flag update after the guard, say — is invisible to a
    // column-by-column assertion and visible to this one.
    const before = db._raw.prepare(`SELECT * FROM ${T} WHERE id = ?`).get(shared);

    const accepted: string[] = [];
    for (const key of inputs) {
        // Any DEFINED value: the guard fires on the write existing at all, never on what it is.
        const value = /^is[A-Z]/.test(key) ? 1 : 'x';
        let threw = false;
        try {
            await Email.update(shared, { [key]: value });
        } catch (e: any) {
            threw = true;
            assert.ok(
                e && (e.code === 'mail_shared_row_immutable' || e.code === 'mail_shared_row_party_narrowed'),
                `update({${key}}) failed for the wrong reason: ${e && e.message}`
            );
        }
        // An input update() reads but writes nothing for is fine — as long as it wrote NOTHING.
        const now = db._raw.prepare(`SELECT * FROM ${T} WHERE id = ?`).get(shared);
        if (!threw && JSON.stringify(now) !== JSON.stringify(before)) accepted.push(key);
    }
    assert.deepEqual(
        accepted, [],
        'these inputs rewrote a column of a SHARED pre-v2.1 row in place. Every one of them is the ' +
        'other party\'s only copy of that message: subject and body are its content, the folder flags ' +
        'are where they find it, and scheduled_at hands it to the send queue. Refuse the write and ' +
        'let the caller save a new message instead.'
    );

    // …and one probe carrying EVERY key at once, which is the shape the composer routes actually
    // send (POST /drafts builds a full data object, never a single field).
    const everything: Record<string, any> = {};
    for (const key of inputs) everything[key] = /^is[A-Z]/.test(key) ? 1 : 'x';
    await assert.rejects(
        () => Email.update(shared, everything),
        (e: any) => e && (e.code === 'mail_shared_row_immutable' || e.code === 'mail_shared_row_party_narrowed')
    );

    // NOTHING about the row changed — every column, compared as a whole.
    const after = db._raw.prepare(`SELECT * FROM ${T} WHERE id = ?`).get(shared);
    assert.deepEqual(
        after, before,
        'a refused update still changed the row. Every write update() performs has to sit behind the ' +
        'shared-row guard — including one added as a second statement after it.'
    );
});

test('a legacy row with ONE local party is still an ordinary row, and an unresolvable one is not', async () => {
    // The rule may not be "no legacy row is ever editable" — that would break the composer on every
    // degraded install for rows nobody else can lose. One local party (plus any number of external
    // correspondents) is not shared.
    const { db, Email } = await makeStore();
    const solo = await insertLegacy(db, { from: 'cliente@fuera.com', to: `${ANA.userEmail}, otro@fuera.com`, subject: 'presupuesto' });
    const edited = await Email.update(solo, { subject: 'presupuesto v2' });
    assert.equal(edited.subject, 'presupuesto v2');

    // …but "we could not ask" is not "nobody else is here". Same doctrine as _mayDestroyRow: an
    // unresolvable identity fails CLOSED, because that is exactly the install (no users:read) whose
    // rows are all still un-attributed.
    const { db: db2, Email: E2 } = await makeStore({ resolveUserIdByAddress: async () => { throw new Error('no users:read'); } });
    const blind = await insertLegacy(db2, { from: 'cliente@fuera.com', to: `${ANA.userEmail}, otro@fuera.com`, subject: 'presupuesto' });
    await assert.rejects(
        () => E2.update(blind, { subject: 'presupuesto v2' }),
        (e: any) => e && e.code === 'mail_shared_row_immutable',
        'an identity the server cannot resolve is not an absent one'
    );
});

test('REGRESSION (round 4): one permanent delete does not resolve the identity of the whole legacy population', async () => {
    // The redesign moved the per-row check INSIDE the predicate but computed the predicate over the
    // actor's entire un-attributed set (up to LEGACY_ID_CAP = 2000 ids), each one a bridge RPC into
    // the host's users table — to delete a single message. 1:N amplification of a normal request.
    const resolved: string[] = [];
    const { db, Email } = await makeStore(directoryResolver(a => resolved.push(a)));
    for (let i = 0; i < 60; i++) {
        await insertLegacy(db, { from: 'ext@other.com', to: ANA.userEmail, subject: `ruido ${i}`, flags: { is_trash: 1 } });
    }
    const mine = await Email.create({
        messageId: '<m@t>', fromAddress: 'ext@other.com', toAddress: ANA.userEmail,
        subject: 'mia', bodyText: 'x', userId: ANA.id, isTrash: 1
    });

    resolved.length = 0;
    assert.equal(await Email.deletePermanently(mine.id, { userId: ANA.id, userEmail: ANA.userEmail }), 1);
    assert.deepEqual(
        resolved, [],
        'deleting one ATTRIBUTED row resolved identities for un-attributed rows the caller never named. ' +
        'Intersect the caller\'s ids with the legacy set BEFORE resolving anybody.'
    );

    // And "Empty trash", which legitimately does span the legacy set, pays for each address ONCE —
    // it asks for the destroy verdict twice (to decide whether it may run, and inside the sink).
    resolved.length = 0;
    const deleted = await Email.emptyTrash(ANA.id, ANA.userEmail);
    assert.equal(deleted, 60, 'her own legacy trash is hers to empty');
    const counts = new Map<string, number>();
    for (const a of resolved) counts.set(a, (counts.get(a) || 0) + 1);
    for (const [addr, n] of counts) {
        assert.ok(n <= 1, `emptyTrash resolved ${addr} ${n} times — the destroy verdict is not memoized`);
    }
});

// ================================================================================================
// B. THE REAL PLUGIN, BOOTED — the routes a user reaches, and the identity that leaves the building
// ================================================================================================

class FakeSMTPServer {
    options: any;
    constructor(options: any) { this.options = options; }
    on() { return this; }
    listen() { /* never binds */ }
    close() { /* no-op */ }
}

/** A FRESH instance of the real plugin module (it keeps module-scoped state). */
function loadPluginModule(): any {
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'smtp-server') return { SMTPServer: FakeSMTPServer };
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec);
    };
    const wrapper: any = vm.runInThisContext(
        `(function (exports, require, module, __filename, __dirname) {${INDEX_SRC}\n})`,
        { filename: PLUGIN_SRC }
    );
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    return moduleObj.exports;
}

type Boot = {
    routes: Map<string, (req: any, res: any) => any>;
    db: any;
    Email: any;
    /** The plugin's OWN sendMail, exactly as it hands it to the host (wordjs.provideMail). */
    sendMail: (data: any) => Promise<any>;
};

async function boot(extraOptions: Record<string, string> = {}): Promise<Boot> {
    const db = makeDb();
    const routes = new Map<string, (req: any, res: any) => any>();
    const options: Record<string, string> = { smtp_listen_port: '2525', ...extraOptions };
    const find = (pred: (u: any) => boolean) => PEOPLE.find(pred) || null;
    let provided: any = null;

    const bridge: any = {
        db,
        options: {
            async get(key: string, def: any) {
                return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def;
            },
            async set(key: string, value: any) { options[key] = String(value); return true; }
        },
        site: {
            async url() { return `https://${MAIL_DOMAIN}`; },
            async domain() { return MAIL_DOMAIN; },
            async adminEmail() { return SITE_FROM; }
        },
        users: {
            async findByEmail(email: string) { return find(u => u.userEmail.toLowerCase() === String(email || '').toLowerCase()); },
            async findByLogin(login: string) { return find(u => u.userLogin.toLowerCase() === String(login || '').toLowerCase()); },
            async findById(id: number) { return find(u => u.id === Number(id)); },
            async search() { return []; }
        },
        http: { route(method: string, sub: string, _opts: any, handler: any) { routes.set(`${method} ${sub}`, handler); } },
        adminMenu: { add() { } },
        provideMail(fn: any) { provided = fn; },
        notify: Object.assign(async () => { }, { registerTransport() { } }),
        dns: {
            resolveMx: async () => { throw new Error('queryMx ENOTFOUND'); },
            resolveTxt: async () => { throw new Error('queryTxt ENOTFOUND'); },
            resolve4: async () => { throw new Error('queryA ENOTFOUND'); },
            resolve6: async () => { throw new Error('queryAaaa ENOTFOUND'); },
            resolve: async () => { throw new Error('query ENOTFOUND'); }
        }
    };

    const plugin = loadPluginModule();
    await plugin.init(bridge);
    // The queue timer would otherwise keep firing across tests; every assertion here drives the
    // delivery path directly, so stop it as soon as the routes are registered.
    plugin.deactivate();
    assert.ok(typeof provided === 'function', 'the plugin must hand its sendMail to the host');
    return { routes, db, Email: createEmailStore(db, directoryResolver()), sendMail: provided };
}

function makeRes() {
    const out: { status: number; body: any } = { status: 200, body: undefined };
    const res: any = {
        status(s: number) { out.status = s; return res; },
        set() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        json(b: any) { out.body = b; return res; },
        send(b: any) { out.body = b; return res; },
        end() { return res; }
    };
    return { res, out };
}

async function call(b: Boot, key: string, user: any, req: any = {}) {
    const handler = b.routes.get(key);
    assert.ok(handler, `route '${key}' is not registered by the plugin`);
    const { res, out } = makeRes();
    await handler!({ query: {}, params: {}, body: {}, cookies: {}, ...req, user }, res);
    return out;
}

const rowsOf = (b: Boot) => b.db._raw.prepare(`SELECT * FROM ${T} ORDER BY id ASC`).all();

test('CRITICAL (round 4): POST /drafts on a shared legacy row saves a NEW message instead of overwriting the colleague\'s', async () => {
    const b = await boot();
    const shared = await insertLegacy(b.db, {
        from: JEFE.userEmail, to: `${ANA.userEmail}, ${MARIA.userEmail}`,
        subject: 'nomina de julio', body: 'importe confidencial'
    });

    const out = await call(b, 'post /drafts', ANA, {
        body: { id: shared, to: ANA.userEmail, subject: 'hola', body: 'texto de ana' }
    });
    assert.equal(out.status, 200, `the author is not punished for a shared row: ${JSON.stringify(out.body)}`);
    assert.ok(out.body.id && out.body.id !== shared, 'the draft was saved as a NEW row, with its own id');

    // The colleague's row is exactly as it was, in every column the attack aimed at.
    const original = rowsOf(b).find((r: any) => r.id === shared)!;
    assert.equal(original.subject, 'nomina de julio');
    assert.equal(original.body_text, 'importe confidencial');
    assert.equal(original.user_id, 0);
    assert.equal(original.is_draft, 0);
    assert.deepEqual(
        (await b.Email.findAllByUser(MARIA.id, MARIA.userEmail, 'inbox')).map((r: any) => r.subject),
        ['nomina de julio'],
        'Mariana never lost it'
    );

    // …and the new row is Ana's own, so her NEXT autosave is an ordinary in-place update.
    const mineRow = rowsOf(b).find((r: any) => r.id === out.body.id)!;
    assert.equal(mineRow.user_id, ANA.id);
    assert.equal(mineRow.from_address, ANA.userEmail, 'her draft carries HER address, not the row\'s');
    const again = await call(b, 'post /drafts', ANA, {
        body: { id: out.body.id, to: ANA.userEmail, subject: 'hola v2', body: 'texto de ana' }
    });
    assert.equal(again.body.id, out.body.id, 'the second save updates the row she now owns');
    assert.equal(rowsOf(b).length, 2, 'and does not pile up a row per keystroke');
});

test('CRITICAL (round 4): POST /send on a shared legacy row never puts a COLLEAGUE\'S address on the wire', async () => {
    // Undo window off, so delivery is synchronous and observable in this test rather than in a timer.
    const b = await boot({ mail_undo_send_seconds: '0' });
    const shared = await insertLegacy(b.db, {
        from: JEFE.userEmail, to: `${ANA.userEmail}, ${MARIA.userEmail}`,
        subject: 'nomina de julio', body: 'importe confidencial'
    });

    const out = await call(b, 'post /send', ANA, {
        body: { id: shared, to: MARIA.userEmail, subject: 'hola', body: 'texto de ana', isHtml: false }
    });
    assert.ok(out.status === 200 || out.status === 207, `send refused: ${JSON.stringify(out.body)}`);

    const all = rowsOf(b);
    const original = all.find((r: any) => r.id === shared)!;
    assert.equal(original.subject, 'nomina de julio', 'the shared row was not promoted into the outbox');
    assert.equal(original.is_sent, 0);
    assert.equal(original.user_id, 0);

    // The Sent copy and the copy that landed in Mariana's inbox both carry ANA, never jefe@.
    const written = all.filter((r: any) => r.id !== shared);
    assert.ok(written.length >= 1, 'the send produced its own records');
    for (const r of written) {
        assert.equal(
            String(r.from_address).toLowerCase(), ANA.userEmail,
            `a message left with from_address='${r.from_address}' — the sending identity must be the ` +
            'requester\'s, never a value carried on the row'
        );
    }
    const sent = written.find((r: any) => r.is_sent === 1);
    assert.ok(sent, 'Ana has a Sent copy of her own');
    assert.equal(sent.user_id, ANA.id);
});

test('CRITICAL (round 4): a From handed to sendMail as a plain string is NOT an identity', async () => {
    // The queue's exact shape, and the forgery it used to perform: a row's from_address passed
    // straight through as `fromEmail`. A string cannot carry provenance, so sendMail no longer reads
    // one — the identity has to be minted from an account (see SENDING_IDENTITY in the plugin).
    const b = await boot({ mail_undo_send_seconds: '0' });
    await b.sendMail({
        to: [MARIA.userEmail],
        subject: 'pago urgente',
        text: 'transfiere hoy',
        fromEmail: JEFE.userEmail,
        fromName: 'Jefe',
        userId: 0
    });

    const written = rowsOf(b);
    assert.ok(written.length >= 1, 'the message was stored');
    for (const r of written) {
        assert.notEqual(
            String(r.from_address).toLowerCase(), JEFE.userEmail,
            'a raw fromEmail string reached the From header — that is the impersonation this closes'
        );
        assert.equal(String(r.from_address).toLowerCase(), SITE_FROM, 'unowned mail goes out as the SITE');
    }
});

test('the identity minted from the REQUESTER is the one that is delivered', async () => {
    const b = await boot({ mail_undo_send_seconds: '0' });
    const out = await call(b, 'post /send', ANA, {
        body: { to: MARIA.userEmail, subject: 'hola', body: 'texto', isHtml: false }
    });
    assert.ok(out.status === 200 || out.status === 207, JSON.stringify(out.body));
    const inbox = rowsOf(b).filter((r: any) => r.user_id === MARIA.id);
    assert.equal(inbox.length, 1, 'Mariana got exactly one copy');
    assert.equal(String(inbox[0].from_address).toLowerCase(), ANA.userEmail);
});

test('GATE (derived): EVERY sendMail call site takes its identity from an ACCOUNT, never from a row', () => {
    // POPULATION FROM THE SOURCE: every direct `sendMail({ … })` in the plugin (nodemailer's
    // `transport.sendMail`/`relay.sendMail` are method calls and are excluded by the boundary). The
    // three that reproduced the finding — the scheduled queue, the retry queue and POST
    // /emails/:id/retry — all read `email.from_address`, and each was one line away from the next.
    const sites: Array<{ index: number; args: string }> = [];
    const re = /(^|[^.\w])sendMail\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(INDEX_CODE)) !== null) {
        const open = INDEX_CODE.indexOf('{', m.index);
        let depth = 0, end = open;
        for (let i = open; i < INDEX_CODE.length; i++) {
            const c = INDEX_CODE[i];
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        sites.push({ index: m.index, args: INDEX_CODE.slice(open, end + 1) });
    }
    assert.ok(sites.length >= 5, `expected the plugin's sendMail call sites; got ${sites.length}`);

    const lineOf = (i: number) => INDEX_CODE.slice(0, i).split('\n').length;

    // 1. No call site may pass an ADDRESS as its From. This is the member-add tripwire: a new queue
    //    that spells `fromEmail: email.from_address` fails here the moment it is written.
    const withAddress = sites
        .filter(s => /\bfrom(Email|Name)\s*:/.test(s.args))
        .map(s => `line ~${lineOf(s.index)}: ${s.args.replace(/\s+/g, ' ').slice(0, 110)}`);
    assert.deepEqual(
        withAddress, [],
        'these sendMail calls pass an address as the sending identity. A string carries no proof of ' +
        'whose address it is — and on a shared pre-v2.1 row it is a COLLEAGUE\'S, because from_address ' +
        'is the one address column update() cannot clear. Mint the identity from an account instead: ' +
        'sendingIdentityOf(req.user) for a request, sendingIdentityOfOwner(row.user_id) for a stored row.'
    );

    // 2. Any identity a call site DOES pass must come from one of the two minting functions.
    const MINT = /identity:\s*(await\s+)?sendingIdentityOf(Owner)?\(/;
    const forged = sites
        .filter(s => /\bidentity\s*:/.test(s.args) && !MINT.test(s.args))
        .map(s => `line ~${lineOf(s.index)}: ${s.args.replace(/\s+/g, ' ').slice(0, 110)}`);
    assert.deepEqual(forged, [], 'these sendMail calls build an identity by hand instead of minting one from an account');

    // 3. And a stored row's identity is resolved from user_id — the ownership verdict — not from any
    //    column of the row itself.
    assert.match(
        INDEX_CODE,
        /async function sendingIdentityOfOwner\(userId\)[\s\S]{0,600}User\.findById\(uid\)/,
        'the owner identity must be resolved through the users table from user_id'
    );
    assert.ok(
        !/sendingIdentityOfOwner\((?!\s*(email|row)\.user_id|\s*userId)/.test(INDEX_CODE),
        'sendingIdentityOfOwner must be called with a row\'s user_id, never with anything else'
    );

    // 4. The minted token is the ONLY From input sendMail honours: the caller-supplied fields are
    //    dropped before any reader of them runs.
    assert.match(
        INDEX_CODE,
        /delete data\.fromEmail;\s*delete data\.fromName;\s*const identity = \(data\.identity && data\.identity\[SENDING_IDENTITY\]\)/,
        'sendMail must discard a caller-supplied From before resolving the identity token'
    );
});
