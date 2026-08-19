/**
 * WordJS - Mail Server plugin-local Email store (ISOLATED, NO TRUST).
 *
 * Ported from backend/src/models/Email.ts. All core-database access goes through the injected
 * `wordjs.db` capability bridge. Because this plugin is fully untrusted, every table it touches MUST
 * live under its own prefix (wordjs.db.tablePrefix === 'wjp_mail_server_') or assertSqlAllowed denies
 * the query. The legacy unprefixed tables (received_emails / email_attachments) are migrated to the
 * prefixed names by a one-time, idempotent step in initSchema().
 *
 * OWNERSHIP MODEL (v2.1 — the performance fix): every mailbox row is owned by exactly ONE user via
 * the `user_id` column (the sender for sent/draft copies, the recipient for inbox copies), so folder
 * listings are a single indexed `user_id = ?` probe instead of the old `LIKE '%email%'` full-table
 * scans over to/cc/bcc.
 *
 * v2.2 — THE UNANCHORED-LIKE AUTHORIZATION ARM IS GONE. v2.1 kept a second arm,
 * `user_id = 0 AND (to_address LIKE '%me%' OR ...)`, to keep pre-v2.1 rows visible without a
 * backfill. That arm was an AUTHORIZATION predicate written as a SUBSTRING test, so
 * `ana@empresa.com` matched every row addressed to `mariana@empresa.com`: the folder listing, the
 * search endpoint (a full-text oracle over another mailbox's bodies) and the sidebar counters all
 * answered over someone else's mail, and "Empty trash" DESTROYED it. The exact same defect had
 * already been found and fixed in findByThreadId — see its comment — but the fix never reached the
 * queries that return COLLECTIONS.
 *
 * There is now exactly ONE ownership predicate in this store, `_ownerClause()`. It is built from
 * `user_id` alone plus, while un-backfilled rows still exist, an EXPLICIT id list produced by
 * `_legacyOwnedIds()` — the only place a LIKE survives, and there it is a pure index PRE-FILTER
 * whose output is immediately narrowed by the exact-token membership test (`canUserAccess`). No
 * caller can accidentally re-derive the substring rule, because no caller writes an ownership
 * clause any more.
 *
 * v2.3 — ONE ANSWER TO "WHO OWNS THIS ROW". Three waves in a row shipped a fix that named ONE
 * surface and left its siblings open, because ownership was answered in five places that could
 * disagree: a JS row predicate, a SQL clause, a LIKE pre-filter, the backfill's attribution rule and
 * the route check in index.js. The answers DID disagree, and each disagreement was a defect —
 *   · the pre-filter was NARROWER than the decider (it hard-coded ', ' spacing while canUserAccess
 *     trims), so mail existed for _ownsRow and did not exist for the SQL: invisible in every
 *     listing, counter and search, with "Empty trash" reporting success over it;
 *   · the backfill refused to attribute a multi-party row (right) and the READ predicate then let
 *     every party PERMANENTLY DESTROY it (wrong) — findings #6 and #26 cancelling each other out;
 *   · the backfill's outbound branch skipped the multi-party check its own doctrine demanded.
 * So: `_ownershipOf` is the single verdict, `_ownsRow` (may read) and `_mayDestroyRow` (may destroy)
 * are DERIVED from it, `_ownerClause` is its SQL twin, and `deleteManyPermanently` — the one sink
 * for permanent destruction — applies `_mayDestroyRow` ITSELF so no route can bypass it. Adding a
 * sixth answer means editing `_ownershipOf`; adding a guard NEXT TO it is the bug this file has now
 * paid for three times.
 *
 * `_backfillOwnership()` (initSchema step 5) drains the legacy set: every user_id = 0 row is
 * attributed to a real owner, so in the steady state `_legacyOwnedIds()` returns [] and the
 * predicate collapses to the single indexed `m.user_id = ?`.
 *
 * Attachment file operations use node builtins (fs/path/crypto) directly — confined to the plugin's
 * OWN dir (no shared-uploads access without trust). Attachments live under the plugin dir.
 *
 * GUARD NOTE: every SQL string here must survive the host's assertSqlAllowed text guard — single
 * statement, no '$' / backslash / '[' / ']' / '/*!' anywhere, no RETURNING, and every table token
 * under the wjp_mail_server_ prefix. Keep it that way when editing.
 *
 * Usage: const Email = require('./lib/email-store')(wordjs.db, hooks);
 *   hooks.resolveUserIdByAddress(address) -> Promise<number>  (0 = nobody; host users:read bridge)
 * The hook answers IDENTITY ("which site account IS this address"), never delivery permission, and it
 * is OPTIONAL: without it the one-time ownership backfill is skipped and the legacy rows keep being
 * reached through the exact-filtered id list instead. Nothing is ever hidden or leaked because a hook
 * is missing.
 *
 * NOTHING IS EVER ATTRIBUTED TO A CATCH-ALL OWNER. A legacy row whose addresses resolve to nobody —
 * or to MORE THAN ONE account, because one row can carry several recipients — stays at user_id = 0,
 * where the exact-filtered path serves it correctly to every party. The first version of this
 * backfill handed those rows to the site administrator, which turned "we do not know whose this is"
 * into "it is the admin's" IRREVERSIBLY: the real owner lost the mail from every listing, counter and
 * search (once the row is no longer user_id = 0 the exact path can never find it again), the admin's
 * listing gained subject + snippet for mail that had never appeared in one, and the admin's "Empty
 * trash" then destroyed it. That is findings #5 and #6 re-opened by their own remediation.
 */
'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

// Plugin-OWNED attachment storage. Untrusted plugins may only write inside their own dir, so keep
// attachments under backend/plugins/mail-server/data/attachments (this file lives in .../lib).
const UPLOAD_DIR = path.join(__dirname, '../data/attachments');
const DATA_DIR = path.join(__dirname, '../data');

// Ensure attachments directory exists (confined fs write within the plugin's own dir).
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(err => console.error("Failed to create attachment dir:", err));

// === CLASS: a CLIENT-SUPPLIED STRING that names a FILE ON DISK ==========================
// The composer posts `attachments: [{ filename, path, ... }]` and that `path` reaches TWO sinks that
// read the named file: fs.copyFile in saveAttachment below (the bytes land in an attachment row the
// poster can then download back) and nodemailer in index.js sendMail (the bytes leave the building
// over SMTP). Neither sink is a place to fix it — a check at one sink leaves the other open, which is
// the shape this repo has now paid for three times. There is ONE resolver, resolveAttachmentSource,
// and BOTH sinks call it; a third sink must call it too or it is reading whatever the client typed.
//
// Containment, not enumeration: the path must land inside a REGISTERED ROOT, and the roots are only
// (a) this plugin's own attachment dir — where the scheduled-send queue and the manual retry build
// their paths from storage_path — and (b) the staging dir the HOST's multipart handler wrote to,
// which index.js registers from req.file.path (a value no client controls) and which is remembered
// across restarts in the plugin's own secrets row. realpath() runs BEFORE the containment test, so a
// symlink dropped inside a root cannot point out of it, and only a BASENAME is accepted (both roots
// are flat), so no traversal segment survives.
const ATTACH_ROOTS = new Set([path.resolve(UPLOAD_DIR)]);

function registerAttachmentRoot(dir) {
    if (!dir) return false;
    try {
        const resolved = path.resolve(String(dir));
        if (!resolved || resolved === path.parse(resolved).root) return false;
        // Bounded: in practice there is the plugin's own dir plus one multer staging dir. A registry
        // that could grow without limit would be a slow way to widen the accepted surface.
        if (ATTACH_ROOTS.size >= 8 && !ATTACH_ROOTS.has(resolved)) {
            console.error('[MailServer] Refusing to register another attachment root; already at the limit.');
            return false;
        }
        ATTACH_ROOTS.add(resolved);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * The ONE answer to "may this plugin read the file this string names?".
 * @returns {Promise<string|null>} the real absolute path, or null (never throws, never guesses).
 */
async function resolveAttachmentSource(candidate) {
    const raw = String(candidate == null ? '' : candidate);
    if (!raw) return null;
    let real;
    try {
        real = await fs.realpath(path.resolve(raw));
    } catch (e) {
        return null; // missing file, or a dangling/looping symlink — either way, nothing to read
    }
    for (const root of ATTACH_ROOTS) {
        let realRoot = root;
        try { realRoot = await fs.realpath(root); } catch (e) { /* root not created yet */ }
        const rel = path.relative(realRoot, real);
        // Non-empty, not an escape, and a BARE BASENAME: both roots are flat upload dirs.
        if (rel && !path.isAbsolute(rel) && !rel.startsWith('..') && !rel.includes(path.sep) && !rel.includes('/')) {
            return real;
        }
    }
    return null;
}

// === Secret-at-rest encryption (M3) ====================================================
// DKIM private keys and relay SMTP passwords are stored in this plugin's OWN wjp_mail_server_secrets
// table. They MUST NOT sit there in plaintext: anyone with read access to the DB file (backups,
// db-admin tooling, a SQL-injection elsewhere) would otherwise lift the signing key / relay creds.
// We encrypt with AES-256-GCM.
//
// KEY DERIVATION — why a plugin-local key file, not the host jwtSecret:
//   This plugin runs inside an OS-isolated child process. The isolate deliberately (a) sets
//   global.__WORDJS_ISOLATED__ so backend/src/config/app.ts SKIPS loading wordjs-config.json, (b)
//   strips JWT_SECRET / DB creds from the child's process.env via a secret-free allowlist, and (c)
//   exposes only a fixed allowlist of bridge methods — none of which yields the host jwtSecret. So the
//   plugin CANNOT read the host secret. Instead we generate a 32-byte random key ONCE and persist it in
//   the plugin's own data dir (the io-guard permits read+write inside plugins/<slug>). It survives
//   restarts (read back from disk) and is HKDF-stretched to the per-use AES key. The key file name
//   avoids the io-guard's blocked substrings ('secret'/'private'/'key.pem'/'cert.pem'/'credential').
const ENC_PREFIX = 'enc:v1:';
const KEY_FILE = path.join(DATA_DIR, '.mailenc'); // 32 bytes of random root key material (hex)
let _rootKey = null; // Buffer(32), lazily loaded/created

function loadRootKey() {
    if (_rootKey) return _rootKey;
    try { fsSync.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* best-effort */ }
    try {
        if (fsSync.existsSync(KEY_FILE)) {
            const hex = fsSync.readFileSync(KEY_FILE, 'utf8').trim();
            const buf = Buffer.from(hex, 'hex');
            if (buf.length === 32) { _rootKey = buf; return _rootKey; }
            // Corrupt/short key file — fall through and regenerate (existing ciphertext would be
            // undecryptable anyway; better than throwing on every secret access).
        }
    } catch (e) {
        console.error('[MailServer] Failed to read encryption key file:', e.message);
    }
    // Generate + persist a fresh root key (0600 where the OS honors mode).
    const key = crypto.randomBytes(32);
    try {
        fsSync.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
        // writeFileSync's `mode` is IGNORED when the file already exists, so enforce 0600 explicitly
        // (mirrors cert-manager.ts / gateway / cert-upload). No-op / throws on Windows → swallowed.
        try { fsSync.chmodSync(KEY_FILE, 0o600); } catch (e) { /* unsupported on some FS / Windows */ }
    } catch (e) {
        console.error('[MailServer] Failed to persist encryption key file:', e.message);
    }
    _rootKey = key;
    return _rootKey;
}

// Derive a 32-byte AES key from the root key, domain-separated for this plugin's secrets store.
function deriveAesKey() {
    return Buffer.from(crypto.hkdfSync('sha256', loadRootKey(), Buffer.alloc(0), 'wordjs-mail-server-secrets-v1', 32));
}

function encryptSecret(plaintext) {
    if (plaintext === null || plaintext === undefined) return plaintext;
    const str = String(plaintext);
    // Never double-encrypt an already-marked value.
    if (str.startsWith(ENC_PREFIX)) return str;
    const iv = crypto.randomBytes(12); // 96-bit nonce (GCM standard)
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveAesKey(), iv);
    const ct = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // enc:v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
    return ENC_PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

function decryptSecret(stored) {
    if (stored === null || stored === undefined) return stored;
    const str = String(stored);
    // Backward compatibility: pre-encryption rows are plaintext — return as-is.
    if (!str.startsWith(ENC_PREFIX)) return str;
    try {
        const parts = str.slice(ENC_PREFIX.length).split(':');
        if (parts.length !== 3) throw new Error('malformed ciphertext');
        const iv = Buffer.from(parts[0], 'base64');
        const tag = Buffer.from(parts[1], 'base64');
        const ct = Buffer.from(parts[2], 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveAesKey(), iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString('utf8');
    } catch (e) {
        // The value carried the enc:v1: marker (so it WAS encrypted by this plugin) but GCM auth-tag
        // verification failed. The overwhelmingly common cause is a lost/rotated/regenerated
        // .mailenc root key (the file was not included in a backup, or was deleted and a fresh key
        // regenerated) — NOT tampering. The plaintext is unrecoverable; the operator must RE-ENTER the
        // secret (DKIM private key / relay credentials). Surface a clear, actionable error instead of a
        // generic line so silent degradation (unsigned mail, disabled relay) isn't a mystery. We still
        // return '' so ciphertext is never leaked to callers and downstream logic treats it as unset.
        console.error(
            '[MailServer] Could not decrypt a stored secret (enc:v1) — the encryption root key in ' +
            'backend/plugins/mail-server/data/.mailenc does not match the data. This usually means the ' +
            'key file was lost, rotated, or regenerated (e.g. a DB restore that omitted it). The ' +
            'affected DKIM key / relay credential must be RE-ENTERED in the mail server settings. ' +
            'Underlying error:', e.message
        );
        return '';
    }
}

// Prefixed table names (must match wordjs.db.tablePrefix for slug 'mail-server').
const T_EMAILS = 'wjp_mail_server_received_emails';
const T_ATTACH = 'wjp_mail_server_email_attachments';
const T_SECRETS = 'wjp_mail_server_secrets';
const T_LABELS = 'wjp_mail_server_labels';
const T_EMAIL_LABELS = 'wjp_mail_server_email_labels';
const T_PREFS = 'wjp_mail_server_user_prefs';

// The light column set every LIST endpoint returns (parameterized by table alias). The old
// `SELECT *` shipped body_text + body_html + raw_content for every row — megabytes of JSON per
// mailbox page serialized across the isolate RPC bridge and then over HTTP, for a UI that renders a
// 2-line preview. Full bodies are only fetched by findById/findByThreadId (the reading pane).
const listCols = (a) =>
    `${a}.id, ${a}.message_id, ${a}.from_address, ${a}.from_name, ${a}.to_address, ${a}.cc_address, ${a}.bcc_address, ` +
    `${a}.subject, SUBSTR(COALESCE(${a}.body_text, ''), 1, 180) AS snippet, ` +
    `${a}.date_received, ${a}.is_read, ${a}.is_sent, ${a}.is_draft, ${a}.is_archived, ${a}.is_starred, ${a}.is_trash, ` +
    `${a}.is_spam, ${a}.user_id, ${a}.parent_id, ${a}.thread_id, ${a}.scheduled_at, ` +
    `${a}.delivery_status, ${a}.delivery_attempts, ${a}.last_error`;
const LIST_COLS = listCols('e');

// Columns needed to AUTHORIZE a row (exact-token membership) without pulling any body.
const AUTH_COLS = 'm.id, m.user_id, m.from_address, m.to_address, m.cc_address, m.bcc_address';

// Ceiling on the number of un-backfilled (user_id = 0) rows a single mailbox may pull into the
// `m.id IN (...)` arm. It exists only to keep the bound-parameter count inside every driver's limit
// (SQLite's default is 32766, MySQL/Postgres are higher). A mailbox that exceeds it means the
// backfill never ran, which is logged as an error rather than silently truncated in the dark.
const LEGACY_ID_CAP = 2000;
// The pre-filter is a SUBSTRING test, so a mailbox whose address is a substring of a busier one
// (ana@ inside mariana@) over-selects; the KEYSET SCAN that fills the cap above is therefore bounded
// too: at most LEGACY_SCAN_CAP rows examined, in pages of LEGACY_SCAN_PAGE. The cap belongs to the
// EXACT-matched ids — see _legacyOwnedIds for why applying it to the pre-filter starved the mailbox
// next door — and hitting EITHER cap now yields an INCOMPLETE verdict that the destructive paths
// refuse to act on, instead of a truncated list that reads as "you have no mail".
const LEGACY_SCAN_PAGE = 500;
const LEGACY_SCAN_CAP = 20000;
// LIKE wildcards inside the address being searched for. '_' matches any single character, so
// a_a@empresa.com pre-selected every axa@empresa.com row and burned this mailbox's scan budget on a
// neighbour's mail. Escaped with '!' (the escape char is escaped first, and backslash is forbidden
// by the host SQL guard) so the pre-filter over-selects for exactly ONE reason — a genuine address
// substring — and never for a punctuation accident.
const LIKE_ESCAPE = '!';
const escapeLike = (s) => String(s).replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');

// The ONLY actor that may reach deleteManyPermanently without a per-row ownership gate: site-wide
// retention (purgeOldSpam), which deletes by AGE across every mailbox and takes no user. A symbol,
// not a string/boolean flag, so it cannot be produced by request data reaching a call site.
const SYSTEM_RETENTION = Symbol('mail-server:system-retention');

// === THE PREDICATE, AND ITS TWO MODES ==================================================
// Ownership is ONE SQL predicate (_scopeClause) with two modes. Every read composes SCOPE.READ
// into its WHERE and every permanent delete composes SCOPE.DESTROY into its DELETE ... WHERE, so
// there is no query that can forget the check: the check IS the query. The JS row predicates
// (_ownsRow / _mayDestroyRow) are still the definition of each mode, but they are now COMPILED
// into that clause rather than being something a caller has to remember to call.
const SCOPE = Object.freeze({ READ: 'read', DESTROY: 'destroy' });

// "The identity resolver could not answer" — DISTINCT from 0, "this address is not a site account".
// The destruction gate used to read a failed lookup as "nobody else is here", so a missing
// users:read grant (exactly the install the backfill exists for) or one timed-out probe became
// permission to annihilate a row shared with another mailbox.
const UNKNOWN_IDENTITY = -1;

// spam_flagged_by for "somebody pressed spam but the call site did not say who". It matches neither
// arm of the retention predicate, so a flag-writer that forgets to name its actor makes the row
// UNREAPABLE rather than reapable: the failure mode of forgetting is mail that lives too long.
const UNIDENTIFIED_FLAGGER = -1;

/**
 * THE address-list parser for the whole plugin, exported on the factory so index.js's
 * splitAddresses() IS this function. Two parsers meant a ';'-joined legacy list had two different
 * party sets: index.js split on [,;] while the ownership predicate split on ',' alone, so such a
 * row was addressed to nobody, readable by neither of its recipients and destroyable by all of
 * them ("none" for every party is only safe until one of those answers changes).
 */
function splitAddressList(value) {
    if (Array.isArray(value)) return value.flatMap(v => splitAddressList(v));
    return String(value === undefined || value === null ? '' : value)
        .split(/[,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
}
// One folder listing calls findAllByUser + countByUser + getCounts, i.e. it asks for the same legacy
// id list three times. Memoize it for a couple of seconds so a poll costs ONE extra probe, not three,
// while staying short enough that a backfill/delete is picked up on the next poll.
const LEGACY_ID_TTL_MS = 2000;

module.exports = function createEmailStore(db, hooks = {}) {
    // The host expects the plugin to confine itself to this prefix; surface it for assertions/logging.
    const PREFIX = db.tablePrefix || 'wjp_mail_server_';

    // Host-mediated IDENTITY lookup used ONLY by the one-time ownership backfill (see
    // _backfillOwnership). The store itself never talks to the users table — it cannot, the SQL guard
    // denies any table outside its prefix — so index.js injects this over the users:read bridge.
    // There is deliberately no second "catch-all owner" hook: see _resolveLegacyOwner.
    const resolveUserIdByAddress = typeof hooks.resolveUserIdByAddress === 'function' ? hooks.resolveUserIdByAddress : null;

    const Email = {
        // Expose the storage dir so index.js resolves attachment paths from a single source of truth.
        UPLOAD_DIR,

        // The site-wide-retention actor (see deleteManyPermanently) — never a user.
        SYSTEM_RETENTION,

        // Budget constants, exported so the regression suite derives its fixtures from the LIMIT that
        // is actually in force instead of hard-coding a number that a later bump silently invalidates.
        LEGACY_ID_CAP,
        LEGACY_SCAN_CAP,

        // The one client-path resolver and the registry of roots it accepts — see the CLASS note at
        // the top of this file. index.js calls BOTH: allowAttachmentRoot() from /upload/attachment,
        // resolveAttachmentSource() before it hands any path to nodemailer.
        allowAttachmentRoot: registerAttachmentRoot,
        resolveAttachmentSource,

        // address(lower) -> { at, ids }: short-lived memo for _legacyOwnedIds (see LEGACY_ID_TTL_MS).
        _legacyIdCache: new Map(),

        // `${uid}|${email}|${ids}` -> { at, value }: short-lived memo for _destroyableLegacyIds, whose
        // every miss is a round of identity RPCs across the plugin bridge.
        _destroyableCache: new Map(),

        /**
         * THE ONE PLACE EITHER OWNERSHIP MEMO IS DROPPED, so the two can never disagree about which
         * write invalidated them. Both are derived from the same three inputs — the address columns,
         * user_id, and the identity service's answers — so anything that changes one changes both,
         * and a caller that remembered to clear only the id list would leave a DESTROY verdict alive
         * for a row whose party set had just moved underneath it.
         */
        _forgetOwnershipMemos() {
            this._legacyIdCache.clear();
            this._destroyableCache.clear();
        },

        /**
         * SECURITY: authoritative recipient/ownership check for a single email record.
         *
         * to_address/cc_address/bcc_address are stored as COMMA-JOINED recipient lists, so a naive
         * `email.to_address === userEmail` (a) denies legitimate multi-recipient To members and (b)
         * ignores cc/bcc recipients entirely (they could neither read their own mail nor be matched).
         * This parses every recipient field into exact, case-insensitive address tokens and checks
         * membership across to + cc + bcc, plus the sender (from_address). Exact-token matching also
         * avoids the substring false-positives a `LIKE %email%` membership test would have.
         *
         * @param {object} email   a row from findById (to_address/cc_address/bcc_address/from_address)
         * @param {string} userEmail the requesting user's address
         * @returns {boolean} true if the user is the sender or any (to/cc/bcc) recipient
         */
        canUserAccess(email, userEmail) {
            if (!email || !userEmail) return false;
            const me = String(userEmail).trim().toLowerCase();
            if (!me) return false;
            return this._tokensOf(email, ['from_address', 'to_address', 'cc_address', 'bcc_address']).has(me);
        },

        /**
         * The comma-joined address lists of `row`, parsed into exact lower-case tokens. ONE parser:
         * canUserAccess, the destruction gate and the backfill all read a row's parties through it, so
         * "which addresses are on this row" cannot be answered two ways.
         */
        _tokensOf(row, fields) {
            const tokens = new Set();
            if (!row) return tokens;
            for (const field of fields) {
                const value = row[field];
                if (!value) continue;
                // ONE parser (splitAddressList), shared with index.js. It accepts ';' as well as ','
                // because a legacy row was written by a version whose list spelling we do not know and
                // index.js has always split on both — a token set that is a strict SUPERSET of the old
                // one can only ever ADD parties, i.e. make a row readable by its recipients and
                // destroyable by fewer people.
                for (const part of splitAddressList(value)) tokens.add(part.toLowerCase());
            }
            return tokens;
        },

        async initSchema() {
            // 1. Create the plugin-owned tables (idempotent). New installs get the full column set here.
            await db.createTable(T_EMAILS, [
                'id INT_PK',
                'message_id TEXT',
                'from_address TEXT',
                'from_name TEXT',
                'to_address TEXT',
                'cc_address TEXT',
                'bcc_address TEXT',
                'subject TEXT',
                'body_text TEXT',
                'body_html TEXT',
                'date_received DATETIME DEFAULT CURRENT_TIMESTAMP',
                'is_read INT DEFAULT 0',
                'is_sent INT DEFAULT 0',
                'is_draft INT DEFAULT 0',
                'is_archived INT DEFAULT 0',
                'is_starred INT DEFAULT 0',
                'is_trash INT DEFAULT 0',
                'is_spam INT DEFAULT 0',
                // WHO put this row in the spam folder. 0 = the delivery-time classifier (nobody
                // pressed anything); a user id = that account pressed "spam". Site-wide RETENTION
                // composes it into its predicate, because "is_spam = 1" is a flag ANY reader of the
                // row can set and retention DESTROYS PERMANENTLY: without this column, marking
                // somebody else's message as spam handed it to the 30-day reaper.
                'spam_flagged_by INT DEFAULT 0',
                // Owner of this mailbox copy (sender for sent/drafts, recipient for inbox copies).
                // 0 = legacy row from before the ownership model (matched by address instead).
                'user_id INT DEFAULT 0',
                'raw_content TEXT',
                // RFC 7208 §9.1 Received-SPF header for the inbound transaction that delivered this
                // message ('' for outbound/local copies, or when SPF was skipped/disabled). Without a
                // column the SPF verdict had nowhere to live: onMailFrom computed it and threw it away,
                // so accepting a 'permerror' left no trace anywhere that it had been unevaluable.
                'received_spf TEXT',
                'parent_id INT DEFAULT 0',
                'thread_id INT DEFAULT 0',
                'scheduled_at DATETIME',
                // Retry-queue columns are created up-front on the new table (no post-hoc ALTER needed).
                'delivery_status TEXT',
                'delivery_attempts INT DEFAULT 0',
                'next_attempt_at TEXT',
                'last_error TEXT'
            ]);

            await db.createTable(T_ATTACH, [
                'id INT_PK',
                'email_id INT',
                'filename TEXT',
                'content_type TEXT',
                'size INT',
                'storage_path TEXT',
                'content_id TEXT',
                'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            ]);

            // Secrets/config store (DKIM private key, relay credentials, etc.). NOT a protected option —
            // untrusted plugins can't read/write the core `options` table, so keep secrets in our own
            // prefixed table. Access is host-gated by the database:read/write grant.
            await db.createTable(T_SECRETS, [
                'name TEXT',
                'value TEXT',
                'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            ]);
            await this._createIndex('wjp_mail_server_idx_secrets_name', T_SECRETS, 'name');

            // Gmail-style user labels (per-user) + the email↔label junction.
            await db.createTable(T_LABELS, [
                'id INT_PK',
                'user_id INT DEFAULT 0',
                'name TEXT',
                'color TEXT',
                'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            ]);
            await db.createTable(T_EMAIL_LABELS, [
                'id INT_PK',
                'email_id INT',
                'label_id INT'
            ]);

            // Per-user preferences (signature, vacation auto-responder) as a JSON blob.
            await db.createTable(T_PREFS, [
                'id INT_PK',
                'user_id INT DEFAULT 0',
                'prefs TEXT',
                'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            ]);

            // 2. Upgrade path for tables created before v2.1: add the ownership + spam columns.
            // ALTER ... ADD COLUMN fails with a "duplicate column" error when it already exists — on
            // every engine — so a swallowed error IS the idempotency check (same pattern as _createIndex).
            await this._ensureColumn(T_EMAILS, 'user_id', 'INT DEFAULT 0');
            await this._ensureColumn(T_EMAILS, 'is_spam', 'INT DEFAULT 0');
            await this._ensureColumn(T_EMAILS, 'spam_flagged_by', 'INT DEFAULT 0');
            // v2.1.4: persisted SPF verdict. Added as VARCHAR(1024) rather than TEXT because MySQL
            // rejects an ALTER that widens a row past its limit with many TEXT columns, and this one is
            // a single bounded header line (same reasoning as the online-store v1→v2 ADD COLUMN).
            await this._ensureColumn(T_EMAILS, 'received_spf', 'VARCHAR(1024)');

            // 3. One-time, idempotent migration from the legacy UNPREFIXED tables, if they still exist.
            // (Only relevant for sites upgraded from the trusted era where the bridge let us write
            // received_emails / email_attachments directly.)
            await this._migrateLegacyTables();

            // 4. Indexes. idx_..._owner is the one that makes every mailbox listing an index probe;
            // idx_..._msgid makes inbound In-Reply-To threading O(log n) instead of a full scan.
            await this._createIndex('wjp_mail_server_idx_owner', T_EMAILS, 'user_id');
            await this._createIndex('wjp_mail_server_idx_msgid', T_EMAILS, 'message_id');
            await this._createIndex('wjp_mail_server_idx_date', T_EMAILS, 'date_received');
            await this._createIndex('wjp_mail_server_idx_delivery', T_EMAILS, 'delivery_status, next_attempt_at');
            await this._createIndex('wjp_mail_server_idx_scheduled', T_EMAILS, 'scheduled_at');
            await this._createIndex('wjp_mail_server_idx_thread', T_EMAILS, 'thread_id');
            await this._createIndex('wjp_mail_server_idx_att_email', T_ATTACH, 'email_id');
            await this._createIndex('wjp_mail_server_idx_lbl_user', T_LABELS, 'user_id');
            await this._createIndex('wjp_mail_server_idx_el_email', T_EMAIL_LABELS, 'email_id');
            await this._createIndex('wjp_mail_server_idx_el_label', T_EMAIL_LABELS, 'label_id');
            await this._createIndex('wjp_mail_server_idx_prefs_user', T_PREFS, 'user_id');

            // 5. Re-arm the attachment staging root discovered by a previous run of the process. The
            //    root is learned from req.file.path (a value the HOST's multipart handler chooses, not
            //    the client), and remembering it keeps compose-with-attachment working after a restart
            //    instead of silently dropping every file the composer still holds a path for.
            try {
                const savedRoot = await this.getSecret('_attach_staging_root', '');
                if (savedRoot) registerAttachmentRoot(savedRoot);
            } catch (e) { /* best effort: an unknown root only costs a re-upload */ }

            // 6. Drain the legacy (user_id = 0) set. Runs AFTER idx_owner exists so the probe below is
            //    an index seek, and after the legacy-table import so imported rows are covered too.
            await this._backfillOwnership();
        },

        /**
         * One-time, idempotent, SELF-HEALING backfill of the ownership column.
         *
         * WHY IT EXISTS: v2.1 chose "no backfill" and kept a second authorization arm,
         * `user_id = 0 AND to_address LIKE '%me%'`, for pre-v2.1 rows. Because that arm was an
         * unanchored substring test, ana@empresa.com was authorized over mariana@empresa.com's mail.
         * Attributing the rows is what lets the store keep ONE ownership predicate; while a single
         * un-attributed row survives, _legacyOwnedIds has to keep exact-filtering it by address.
         *
         * NO MARKER ROW, deliberately (unlike _migrateLegacyTables): the gate is a COUNT of
         * user_id = 0 rows. A marker would go stale — create() still writes user_id = 0 when inbound
         * catch-all cannot resolve a site admin — so a marker-gated backfill would skip exactly the
         * rows that appeared after it ran. The COUNT is an index probe that returns nothing in the
         * steady state, and it re-attributes any new orphan on the next boot.
         */
        async _backfillOwnership() {
            let remaining = 0;
            try {
                const row = await db.get(`SELECT COUNT(*) AS c FROM ${T_EMAILS} WHERE user_id = 0`);
                remaining = row ? Number(row.c) || 0 : 0;
            } catch (e) {
                console.error('[MailServer] Ownership backfill probe failed:', e && e.message);
                return;
            }
            if (remaining === 0) return; // fresh install, or already drained — the common case

            if (!resolveUserIdByAddress) {
                // Not fatal and NOT silent: the rows stay reachable through the exact-filtered id list,
                // they just keep costing a pre-filter probe per query.
                console.warn(
                    `[MailServer] ${remaining} message(s) predate the ownership column and no identity ` +
                    'resolver was injected, so they cannot be attributed. They remain readable by their ' +
                    'exact recipients only.'
                );
                return;
            }

            const cache = new Map(); // address(lower) -> user id (0 = nobody)
            let cursor = 0;
            let attributed = 0;
            let unclaimed = 0; // no address on the row belongs to any site account
            let shared = 0;    // several accounts are parties to it — nobody may own it alone
            let unresolved = 0; // the identity of at least one party could not be looked up AT ALL
            let fannedOut = 0; // rows paired 1:1 with the recipients of an already-performed fan-out
            let failed = 0;    // the UPDATE itself failed
            // Keyset pagination on id: an un-attributable row stays at user_id = 0, so a plain
            // "SELECT ... WHERE user_id = 0 LIMIT 200" loop would re-read it forever.
            // === THE FAN-OUT RUN =============================================================
            // A version that wrote user_id = 0 still delivered ONE COPY PER LOCAL RECIPIENT (index.js
            // sendMail does exactly that today), and every copy names EVERY recipient in to_address.
            // Judging such a copy by its address list therefore sees N site accounts and calls it
            // 'shared' — leaving all N copies at user_id = 0, where the ownership clause hands ALL of
            // them to EACH party: two people, one message, two rows each, a badge that says 2 unread,
            // and read/star flags that live on the row so marking one read leaves its twin unread
            // forever and marking the other one writes into the neighbour's mailbox.
            //
            // The fan-out is a FACT ABOUT THE DATA, not an assumption about an unknown version: K
            // ADJACENT, byte-equivalent delivered copies (same from/to/cc/bcc/subject/body, is_sent =
            // 0, is_draft = 0 — they are written back-to-back by one loop, so they are adjacent in id)
            // together with exactly K resolvable site-account recipients can only be a fan-out that
            // already happened. Pair them 1:1 (rows by id asc ↔ owners by id asc) and each party ends
            // up with exactly ONE copy. When K ≠ R we do NOT guess: the rows fall back to the
            // single-row rule, which leaves a genuinely shared row at 0 for everyone to read.
            let run = [];      // pending adjacent equivalence class
            let runKey = null;

            const flushRun = async () => {
                if (run.length === 0) return;
                const rows = run;
                run = [];
                runKey = null;
                if (rows.length > 1) {
                    const owners = new Set();
                    let unknownParty = false;
                    for (const addr of this._tokensOf(rows[0], ['to_address', 'cc_address', 'bcc_address'])) {
                        const id = await this._resolveAddressId(addr, cache);
                        if (id === UNKNOWN_IDENTITY) unknownParty = true;
                        else if (id > 0) owners.add(id);
                    }
                    // An unresolvable party means we do not know how many claimants this fan-out has,
                    // and pairing rows 1:1 against a short list hands somebody else's copy away.
                    if (!unknownParty && owners.size === rows.length) {
                        const byId = [...owners].sort((a, b) => a - b);
                        const ordered = rows.slice().sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
                        for (let i = 0; i < ordered.length; i++) {
                            try {
                                await db.run(`UPDATE ${T_EMAILS} SET user_id = ? WHERE id = ?`, [byId[i], ordered[i].id]);
                                attributed++;
                                fannedOut++;
                            } catch (e) {
                                failed++;
                            }
                        }
                        return;
                    }
                }
                for (const r of rows) {
                    const verdict = await this._resolveLegacyOwner(r, cache);
                    if (verdict.reason === 'unknown') { unresolved++; continue; }
                    if (verdict.reason === 'shared') { shared++; continue; }
                    if (!(verdict.userId > 0)) { unclaimed++; continue; }
                    try {
                        await db.run(`UPDATE ${T_EMAILS} SET user_id = ? WHERE id = ?`, [verdict.userId, r.id]);
                        attributed++;
                    } catch (e) {
                        failed++;
                    }
                }
            };

            for (let page = 0; page < 2000; page++) {
                let rows;
                try {
                    rows = await db.all(
                        `SELECT id, from_address, to_address, cc_address, bcc_address, is_sent, is_draft, ` +
                        `subject, SUBSTR(COALESCE(body_text, ''), 1, 400) AS body_key ` +
                        `FROM ${T_EMAILS} WHERE user_id = 0 AND id > ? ORDER BY id ASC LIMIT 200`,
                        [cursor]
                    );
                } catch (e) {
                    console.error('[MailServer] Ownership backfill read failed:', e && e.message);
                    break;
                }
                if (!rows || rows.length === 0) break;
                for (const r of rows) {
                    cursor = parseInt(r.id, 10) || cursor;
                    // Only DELIVERED copies fan out; a Sent/Draft row is its author's single copy and
                    // must never be paired away to a recipient.
                    const delivered = Number(r.is_sent) !== 1 && Number(r.is_draft) !== 1;
                    const key = delivered ? JSON.stringify([
                        r.from_address || '', r.to_address || '', r.cc_address || '',
                        r.bcc_address || '', r.subject || '', r.body_key || ''
                    ]) : null;
                    if (key === null || key !== runKey) {
                        await flushRun();
                        runKey = key;
                    }
                    if (key === null) {
                        // Not fan-out material: resolve it on its own, immediately.
                        run = [r];
                        await flushRun();
                    } else {
                        run.push(r);
                    }
                }
            }
            await flushRun(); // a run may end at the last page boundary

            this._forgetOwnershipMemos();
            // Report the three outcomes SEPARATELY. The first version logged one cheerful "attributed
            // N message(s)" line that counted a row dumped on the catch-all owner exactly like a row
            // handed to its real recipient, so the worst possible outcome looked like a success.
            if (attributed > 0) {
                console.log(`[MailServer] Ownership backfill: attributed ${attributed} pre-v2.1 message(s) to their own recipient or sender.`);
            }
            if (fannedOut > 0) {
                console.log(
                    `[MailServer] Ownership backfill paired ${fannedOut} pre-v2.1 message(s) with the ` +
                    'recipients of an already-performed fan-out, one copy each — they were otherwise ' +
                    'shown N times to N people, with the unread badge counting every copy.'
                );
            }
            if (shared > 0) {
                console.log(
                    `[MailServer] Ownership backfill left ${shared} pre-v2.1 message(s) at user_id = 0 ` +
                    'because more than one site account is a party to them; a single owner would have ' +
                    'deleted the message from every other party. They stay READABLE by all of them — ' +
                    'and DESTROYABLE by none: see _mayDestroyRow.'
                );
            }
            if (unresolved > 0) {
                console.error(
                    `[MailServer] Ownership backfill could not resolve the identity of a party to ` +
                    `${unresolved} message(s) — the users:read bridge failed rather than answering "no ` +
                    'such account". They stay at user_id = 0, readable by their exact recipients and ' +
                    'destroyable by nobody, until the grant is restored and the plugin restarts.'
                );
            }
            if (unclaimed > 0) {
                console.warn(
                    `[MailServer] Ownership backfill left ${unclaimed} message(s) unattributed (no site ` +
                    'user owns any of their addresses). They stay readable by their exact recipients, ' +
                    'but every mailbox query keeps paying an extra pre-filter probe until they are ' +
                    'attributed or deleted. They are NOT given to the administrator.'
                );
            }
            if (failed > 0) {
                console.error(`[MailServer] Ownership backfill could not write an owner for ${failed} message(s).`);
            }
        },

        /**
         * Which user owns a pre-v2.1 row — by IDENTITY, and only when the answer is UNAMBIGUOUS.
         *
         *   - a Sent/Draft copy belongs to its SENDER (index.js sendMail writes userId = sender);
         *   - a delivered copy belongs to its RECIPIENT — but a legacy row was written by a version
         *     whose fan-out behaviour we do NOT know (that is the whole reason a backfill exists), and
         *     to/cc/bcc are COMMA-JOINED LISTS, so one row can genuinely belong to SEVERAL accounts.
         *     When more than one distinct account is a party to it, NOBODY may be handed it: writing
         *     the first candidate's id deletes the message from every other party's mailbox, silently
         *     and irreversibly. It stays at user_id = 0, where the exact-filtered path keeps serving
         *     it to all of them;
         *   - a row no site account claims ALSO stays at user_id = 0. It is NOT the administrator's.
         *     "We do not know whose this is" and "it is the admin's" are different facts, and only the
         *     first one is true — see the module header for what conflating them cost.
         *
         * `resolveUserIdByAddress` must answer "which account IS this address" (User.findByEmail),
         * never "may this account receive here". The delivery predicate (index.js mailboxAddressOf)
         * additionally demands the admin-granted professional-mailbox flag, which host migration 0006
         * leaves OFF for every non-administrator — so a permission-shaped resolver answers 0 for all of
         * them on exactly the upgrade this backfill is for. Identity is safe to trust because the host
         * refuses self-service assignment of an address on the mail domain
         * (core/mailbox.refuseSelfServiceEmailChange, enforced on PUT /users/me, PUT /users/:id and
         * POST /auth/register), so an account cannot be holding a corporate address it was not given.
         *
         * @returns {{userId: number, reason: 'sender'|'recipient'|'shared'|'unclaimed'}}
         */
        async _resolveLegacyOwner(row, cache) {
            const resolve = (addr) => this._resolveAddressId(addr, cache);

            // ONE RULE FOR BOTH BRANCHES. The previous version resolved the SENDER and RETURNED for
            // any is_sent/is_draft row, justified as "a Sent/Draft copy has exactly one owner by
            // construction" — which is an assertion about the fan-out of a version whose fan-out the
            // paragraph above explicitly refuses to assume. A single legacy row `is_sent = 1,
            // from = ana@, to = mariana@` was therefore handed to Ana, and Mariana lost it from every
            // listing, counter and search IRREVERSIBLY (once user_id ≠ 0 the exact-filtered path can
            // never find it again). The recipients branch had been fixed; its twin stayed open. So:
            // count EVERY site account party to the row, sender included, and attribute only when the
            // answer is unambiguous.
            const outbound = Number(row.is_sent) === 1 || Number(row.is_draft) === 1;
            const sender = await resolve(row.from_address);
            let unknown = sender === UNKNOWN_IDENTITY;

            const recipients = new Set();
            for (const field of [row.to_address, row.cc_address, row.bcc_address]) {
                if (!field) continue;
                for (const part of splitAddressList(field)) {
                    const id = await resolve(part);
                    if (id === UNKNOWN_IDENTITY) unknown = true;
                    else if (id > 0) recipients.add(id);
                }
            }

            // FAIL CLOSED, LIKE THE DESTRUCTION GATE. "The lookup failed" is not "no such account":
            // attributing on a partial answer hands the row to one claimant and deletes it from every
            // other party's mailbox irreversibly. Boot time and request time now refuse on the same
            // input, which is what "one answer to the identity question" has to mean.
            if (unknown) return { userId: 0, reason: 'unknown', parties: [] };

            if (outbound && sender > 0) {
                const others = [...recipients].filter(id => id !== sender);
                if (others.length > 0) return { userId: 0, reason: 'shared', parties: [sender, ...others] };
                return { userId: sender, reason: 'sender', parties: [sender] };
            }
            if (recipients.size > 1) return { userId: 0, reason: 'shared', parties: [...recipients] };
            if (recipients.size === 1) return { userId: [...recipients][0], reason: 'recipient', parties: [...recipients] };
            if (sender > 0) return { userId: sender, reason: 'sender', parties: [sender] };
            return { userId: 0, reason: 'unclaimed', parties: [] };
        },

        async _createIndex(name, table, cols) {
            // The host guard (plugin-api.ts assertSqlAllowed) requires the INDEX NAME itself to start
            // with the plugin's table prefix — not just the target table. So names are wjp_mail_server_idx_*,
            // NOT idx_wjp_mail_server_* (which the guard rejected, silently costing us EVERY index —
            // and with them the ownership-model fast path — until it was caught on a live DB).
            if (!String(name).startsWith(PREFIX)) {
                console.error(`[MailServer] Refusing to create index '${name}': name must start with '${PREFIX}'.`);
                return;
            }
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) {
                // Ignore if index already exists / race condition.
            }
        },

        async _ensureColumn(table, name, ddl) {
            try {
                await db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
            } catch (e) {
                // Duplicate-column error = column already there (fresh install or already upgraded).
            }
        },

        /**
         * Copy rows from the legacy unprefixed tables into the prefixed ones, exactly once.
         *
         * We CANNOT reference the legacy tables through wordjs.db (assertSqlAllowed denies any table
         * outside the wjp_mail_server_ prefix), and we can't query the schema catalog either. So the
         * migration is gated on a marker row in our own secrets table; the actual cross-table copy is
         * performed by the HOST via a dedicated, host-mediated migration helper if available. When that
         * helper is absent (clean install or already migrated), this is a no-op. This keeps the plugin
         * sandbox-clean: it never issues SQL touching a table it does not own.
         */
        async _migrateLegacyTables() {
            try {
                const done = await this.getSecret('_legacy_migrated');
                if (done === '1') return;

                // Host-mediated legacy import: the bridge MAY expose a one-shot migrator that runs with
                // host privileges to move received_emails/email_attachments → the prefixed tables. If the
                // bridge does not provide it (default), we simply mark migration complete so a clean
                // install never reattempts. No plugin-issued cross-table SQL is involved.
                if (db.migrateLegacy && typeof db.migrateLegacy === 'function') {
                    try {
                        await db.migrateLegacy([
                            { from: 'received_emails', to: T_EMAILS },
                            { from: 'email_attachments', to: T_ATTACH }
                        ]);
                    } catch (e) {
                        console.warn('[MailServer] Legacy table migration skipped:', e && e.message);
                    }
                }
                await this.setSecret('_legacy_migrated', '1');
            } catch (e) {
                // Non-fatal: a fresh install has nothing to migrate.
            }
        },

        // --- Secret/config store (own prefixed table; replaces protected options) ---------------

        async getSecret(name, def = '') {
            try {
                const row = await db.get(`SELECT value FROM ${T_SECRETS} WHERE name = ?`, [name]);
                // Transparently decrypt enc:v1: values; legacy plaintext rows pass through unchanged.
                return row ? decryptSecret(row.value) : def;
            } catch (e) {
                return def;
            }
        },

        async setSecret(name, value) {
            // Encrypt at rest (AES-256-GCM) so DKIM private keys / relay creds never sit in the DB in
            // plaintext. getSecret decrypts transparently; legacy plaintext rows remain readable.
            const stored = encryptSecret(value);
            // Upsert without RETURNING (denied for untrusted plugins) and without relying on a UNIQUE
            // constraint dialect: update first, insert if nothing was updated.
            const existing = await db.get(`SELECT name FROM ${T_SECRETS} WHERE name = ?`, [name]);
            if (existing) {
                await db.run(`UPDATE ${T_SECRETS} SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`, [stored, name]);
            } else {
                await db.run(`INSERT INTO ${T_SECRETS} (name, value) VALUES (?, ?)`, [name, stored]);
            }
        },

        async create(data) {
            const {
                messageId, fromAddress, fromName, toAddress, ccAddress = '', bccAddress = '', subject, bodyText, bodyHtml, rawContent,
                receivedSpf = '',
                isSent = 0, isDraft = 0, isArchived = 0, isStarred = 0, isTrash = 0, isSpam = 0,
                parentId = 0, threadId = 0, scheduledAt = null
            } = data;

            // Owner of this copy. Accept either `userId` or the legacy `user_id` spelling callers used
            // (which the old destructuring silently DROPPED — ownership is the point of v2.1).
            const ownerId = parseInt(data.userId !== undefined ? data.userId : data.user_id, 10) || 0;

            // better-sqlite3 (and the pg driver) only bind numbers/strings/bigints/buffers/null — never
            // undefined, boolean, Date or object. mailparser yields `false` for a missing text/html part
            // and may omit messageId/subject entirely, so a raw bind of a received message throws
            // "SQLite3 can only bind ..." at end-of-DATA and the whole inbound message is dropped with a
            // 450 (INBOUND-BIND). Normalize every free-text column to a bindable string first.
            const str = (v) => (v === undefined || v === null || v === false) ? '' : (typeof v === 'string' ? v : String(v));

            const result = await db.run(`
                INSERT INTO ${T_EMAILS} (
                    message_id, from_address, from_name, to_address, cc_address, bcc_address, subject, body_text, body_html, raw_content,
                    received_spf,
                    is_sent, is_draft, is_archived, is_starred, is_trash, is_spam, user_id, parent_id, thread_id, scheduled_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                str(messageId), str(fromAddress), str(fromName), str(toAddress), str(ccAddress), str(bccAddress), str(subject), str(bodyText), str(bodyHtml), str(rawContent),
                str(receivedSpf).slice(0, 1024),
                isSent, isDraft, isArchived, isStarred, isTrash, isSpam ? 1 : 0, ownerId, parentId, threadId, scheduledAt
            ]);

            const emailId = result.lastID;

            // A new un-attributed row joins the legacy set the memo describes, so the memo is stale
            // the moment it is written (inbound catch-all with no resolvable admin writes user_id = 0).
            if (ownerId === 0) this._forgetOwnershipMemos();

            // Process Attachments if any
            if (data.attachments && Array.isArray(data.attachments)) {
                for (const att of data.attachments) {
                    await this.saveAttachment(emailId, att);
                }
            }

            return await this.findById(emailId);
        },

        async saveAttachment(emailId, attachment) {
            let storageName = '';
            let size = 0;

            if (attachment.content) {
                // Buffer (incoming)
                const randomName = crypto.randomBytes(16).toString('hex');
                // Never persist the sender-supplied extension — an inbound attachment named x.js / .wasm /
                // .node trips io-guard's executable-write block and would throw out the ENTIRE message. The
                // real filename is kept in the DB `filename` column; on disk it's an opaque .bin blob.
                storageName = randomName + '.bin';
                const fullPath = path.join(UPLOAD_DIR, storageName);

                await fs.writeFile(fullPath, attachment.content);
                size = attachment.content.length;
            } else if (attachment.path) {
                // File path (outgoing/upload) — a CLIENT-SUPPLIED STRING THAT NAMES A FILE ON DISK.
                // POST /drafts and POST /send take `attachments` verbatim from req.body, so this string
                // is whatever the composer typed: '../../src/index.ts' copied the server's own source
                // into a row the poster then downloads back through GET /attachments/:fileId. Contain it
                // through THE resolver (see the CLASS note at the top of this file) before any read.
                const source = await resolveAttachmentSource(attachment.path);
                if (!source) {
                    console.error(
                        `[MailServer] Refusing attachment source outside the permitted upload roots: ` +
                        `${String(attachment.path).slice(0, 200)}`
                    );
                    return; // no row, no copy — the message keeps its other attachments
                }
                const randomName = crypto.randomBytes(16).toString('hex');
                // Never persist the sender-supplied extension — an inbound attachment named x.js / .wasm /
                // .node trips io-guard's executable-write block and would throw out the ENTIRE message. The
                // real filename is kept in the DB `filename` column; on disk it's an opaque .bin blob.
                storageName = randomName + '.bin';
                const fullPath = path.join(UPLOAD_DIR, storageName);

                // Check if source exists before copying
                try {
                    await fs.copyFile(source, fullPath);
                    size = attachment.size || (await fs.stat(fullPath)).size;
                } catch (e) {
                    console.error(`Failed to copy attachment ${source}:`, e.message);
                    return; // Skip if file missing
                }
            }

            // NO BYTES, NO ROW. An entry with neither `content` nor a resolvable `path` used to fall
            // through both branches and still INSERT, producing an attachment whose storage_path is the
            // empty string — which GET /attachments/:fileId then resolves to the upload DIRECTORY. Same
            // class as the path above: a client-supplied attachment entry that names no readable file
            // must not become a row.
            if (!storageName) {
                console.error('[MailServer] Skipping attachment with no content and no usable path.');
                return;
            }

            await db.run(`
                INSERT INTO ${T_ATTACH} (email_id, filename, content_type, size, storage_path, content_id)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [emailId, attachment.filename, attachment.contentType, size, storageName, attachment.cid || null]);
        },

        /**
         * SECURITY: the address columns of an UN-ATTRIBUTED row are not ordinary content — they ARE
         * the ownership verdict. For user_id = 0, _ownershipOf answers purely out of
         * from/to/cc/bcc, so an UPDATE that drops a name from those lists does not edit a message:
         * it decides who owns one. Round 3 walked the whole chokepoint that way with a single
         * POST /drafts — gate passed (the caller IS a party), Email.update rewrote to_address to the
         * caller alone, and the very next call to the SAME unchanged destruction gate said yes,
         * because the row it was asked about was no longer the row it had refused. The other party
         * lost the message from every listing, counter and search first, and off the disk second.
         *
         * THE RULE, enforced here and not at the routes: on a row nobody owns yet, the party set may
         * GROW but never SHRINK. Removing a party from a shared row is destruction of their copy —
         * with the row surviving — so it is refused with a code the routes turn into a 409, rather
         * than silently dropping the address fields (which would be a lie about what was saved).
         * Attributed rows (user_id > 0) are unaffected: their verdict is the column, not the lists.
         *
         * AND THE SECOND AXIS, which the rule above does not cover and round 4 walked straight
         * through: keeping both names on the row while overwriting SUBJECT, BODY and the folder flags
         * destroys the other party's message just as completely, and every membership check still
         * says yes. So a row _isSharedRow() calls shared refuses EVERY column — see the guard below
         * the SET builder, which is where it sits so that a column added later is covered by
         * existing.
         */
        async update(id, data) {
            const {
                messageId, toAddress, ccAddress, bccAddress, subject, bodyText, bodyHtml, rawContent,
                isSent, isDraft, isTrash, isSpam, isArchived, scheduledAt
            } = data;

            const existing = await this.findById(id);
            if (!existing) return undefined;
            const rewritesAddresses = toAddress !== undefined || ccAddress !== undefined || bccAddress !== undefined;
            const unattributed = (parseInt(existing.user_id, 10) || 0) === 0;
            if (unattributed && rewritesAddresses) {
                const FIELDS = ['from_address', 'to_address', 'cc_address', 'bcc_address'];
                const before = this._tokensOf(existing, FIELDS);
                const after = this._tokensOf({
                    from_address: existing.from_address,
                    to_address: toAddress !== undefined ? toAddress : existing.to_address,
                    cc_address: ccAddress !== undefined ? ccAddress : existing.cc_address,
                    bcc_address: bccAddress !== undefined ? bccAddress : existing.bcc_address
                }, FIELDS);
                const lost = [...before].filter(t => !after.has(t));
                if (lost.length > 0) {
                    const err = new Error(
                        'This message predates the ownership upgrade and is shared with another mailbox ' +
                        `(${lost.join(', ')}). Removing a recipient from it would take it away from them, ` +
                        'so it cannot be rewritten in place — save it as a new message instead.'
                    );
                    err.code = 'mail_shared_row_party_narrowed';
                    throw err;
                }
            }

            // Build dynamic query
            let fields = [];
            let params = [];

            // Track whether a content field changed; only then do we bump date_received
            // (so non-content updates like retry's toAddress rewrite don't re-sort the list).
            let contentChanged = false;

            if (messageId !== undefined) { fields.push("message_id = ?"); params.push(messageId); }
            if (toAddress !== undefined) { fields.push("to_address = ?"); params.push(toAddress); }
            if (ccAddress !== undefined) { fields.push("cc_address = ?"); params.push(ccAddress); contentChanged = true; }
            if (bccAddress !== undefined) { fields.push("bcc_address = ?"); params.push(bccAddress); contentChanged = true; }
            if (subject !== undefined) { fields.push("subject = ?"); params.push(subject); contentChanged = true; }
            if (bodyText !== undefined) { fields.push("body_text = ?"); params.push(bodyText); contentChanged = true; }
            if (bodyHtml !== undefined) { fields.push("body_html = ?"); params.push(bodyHtml); contentChanged = true; }
            if (rawContent !== undefined) { fields.push("raw_content = ?"); params.push(rawContent); contentChanged = true; }
            if (isSent !== undefined) { fields.push("is_sent = ?"); params.push(isSent); }
            if (isDraft !== undefined) { fields.push("is_draft = ?"); params.push(isDraft); }
            if (isTrash !== undefined) { fields.push("is_trash = ?"); params.push(isTrash); }
            // is_spam NEVER travels without its flagger — see setSpam. update() is not told who is
            // asking, so a spam flag set through it is UNIDENTIFIED and therefore not retention
            // material: the two columns are written in one statement so no path can set one alone.
            if (isSpam !== undefined) {
                fields.push("is_spam = ?, spam_flagged_by = ?");
                params.push(isSpam ? 1 : 0, isSpam ? UNIDENTIFIED_FLAGGER : 0);
            }
            if (isArchived !== undefined) { fields.push("is_archived = ?"); params.push(isArchived ? 1 : 0); }
            if (scheduledAt !== undefined) { fields.push("scheduled_at = ?"); params.push(scheduledAt); }

            if (contentChanged) {
                fields.push("date_received = CURRENT_TIMESTAMP");
            }

            // Nothing to update — avoid emitting invalid "SET  WHERE id = ?".
            if (fields.length === 0) {
                return await this.findById(id);
            }

            // === A SHARED ROW IS NOT REWRITABLE — IN ANY COLUMN ==============================
            // Placed HERE, after the SET builder and before the only write, ON PURPOSE: the columns
            // it protects are the ones the builder actually emits, so a column added to update()
            // tomorrow is inside this guard the moment it exists. The party-set rule above answers
            // one axis (who is named on the row); this answers the other (what the row SAYS), and
            // both had to be true for "shared = readable by all, destroyable by none" to mean
            // anything. See _isSharedRow for the round-4 reproduction this closes.
            if (unattributed && await this._isSharedRow(existing)) {
                const err = new Error(
                    'This message predates the ownership upgrade and is the only copy more than one ' +
                    'mailbox on this site has, so it cannot be changed in place — changing it would ' +
                    'destroy the other party\'s copy. Save it as a new message instead.'
                );
                err.code = 'mail_shared_row_immutable';
                throw err;
            }

            params.push(id);

            await db.run(`
                UPDATE ${T_EMAILS}
                SET ${fields.join(', ')}
                WHERE id = ?
            `, params);

            // The legacy id memo is a list of rows whose membership was computed FROM the address
            // columns, so a write that touches them (or any write to an un-attributed row) invalidates
            // it. Without this the memo kept serving ids for up to LEGACY_ID_TTL_MS that _ownsRow had
            // already stopped accepting — which made _assertOwned, the tripwire that exists to announce
            // a GENUINE divergence between the SQL clause and the row predicate, cry wolf.
            if (unattributed || rewritesAddresses) this._forgetOwnershipMemos();

            return await this.findById(id);
        },

        async findById(id) {
            return await db.get(`SELECT * FROM ${T_EMAILS} WHERE id = ?`, [id]);
        },

        // Fetch a batch of full rows by id (bulk-action authorization). Bounded by the caller.
        async findByIds(ids) {
            const list = (ids || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);
            if (list.length === 0) return [];
            const ph = list.map(() => '?').join(', ');
            return await db.all(`SELECT * FROM ${T_EMAILS} WHERE id IN (${ph})`, list);
        },

        /**
         * The conversation a message belongs to, as the reading pane shows it.
         *
         * SECURITY: this returns FULL ROWS — body, attachments' parent ids, every recipient field — so
         * it is the highest-disclosure read in the store, and it was the LAST one still authorizing by
         * ADDRESS. Two consequences, both live:
         *   - under the ownership model every party holds their OWN copy of a message and every copy
         *     names every recipient, so address membership handed Ana the rows OWNED by Mariana. It now
         *     goes through _ownsRow, the same predicate as every collection and every per-id route;
         *   - the WHERE excluded trash and (optionally) spam but NOT DRAFTS, and POST /drafts inherits
         *     the parent's thread_id — so a reply Mariana had NOT SENT was returned to Ana, body and
         *     all, by simply opening the message. A draft is nobody else's conversation: exclude it in
         *     SQL as well, so the disclosure cannot come back through a future caller that passes no
         *     user (which is why the userId/userEmail arguments stay REQUIRED for any filtering to
         *     happen at all).
         */
        async findByThreadId(threadId, userId = 0, userEmail = null, opts = {}) {
            // The signature grew a userId in front of the address. A caller still using the old
            // positional shape (threadId, userEmail, opts) would otherwise put an ADDRESS in the userId
            // slot, where parseInt makes it 0 and leaves userEmail null — i.e. the guard would inspect a
            // different value than the one it was handed and return the WHOLE thread to everyone.
            // Recognize that shape instead of failing open on it.
            if (typeof userId === 'string' && userId.includes('@')) {
                if (userEmail && typeof userEmail === 'object') opts = userEmail;
                userEmail = userId;
                userId = 0;
            }
            const uid = parseInt(userId, 10) || 0;
            // FAIL CLOSED: no requester, no conversation. Every caller has one, and an internal caller
            // that ever needs the raw thread must ask for it explicitly rather than by omission.
            if (uid <= 0 && !userEmail) return [];

            // Spam messages are hidden from a normal conversation view (Gmail behavior); when the
            // REQUESTED message itself is spam the caller passes includeSpam so the spam-folder reading
            // pane still shows it.
            const spamFilter = opts.includeSpam ? '' : ' AND is_spam = 0';
            const sql = `SELECT * FROM ${T_EMAILS} WHERE (thread_id = ? OR id = ?) AND is_trash = 0 AND is_draft = 0${spamFilter} ORDER BY date_received ASC`;
            const rows = await db.all(sql, [threadId, threadId]);

            return rows.filter(row => this._ownsRow(row, uid, userEmail));
        },

        // Look up a message by its RFC Message-ID header value. Used to thread an inbound reply back
        // into its conversation (the reply's In-Reply-To/References echo the original's Message-ID).
        async findByMessageId(messageId) {
            if (!messageId) return null;
            return await db.get(
                `SELECT * FROM ${T_EMAILS} WHERE message_id = ? ORDER BY id ASC LIMIT 1`,
                [String(messageId).trim()]
            );
        },

        /**
         * === THE ONE ANSWER TO "WHO OWNS THIS ROW" ==========================================
         *
         * THE CLASS this function exists to kill: ownership was answered in SEVERAL places — a JS
         * per-row predicate, a SQL clause, an anchored LIKE pre-filter, the backfill's attribution
         * rule and index.js's route check — and the answers DISAGREED. Every disagreement was a
         * defect: one predicate read a row another predicate said was not yours (leak), one predicate
         * DESTROYED a row another predicate said belonged to somebody else too (irreversible), and
         * one predicate could not find a row the other could (silent mail loss).
         *
         * There are now exactly THREE derived questions and they all start HERE:
         *   _ownershipOf   — the verdict ('owner' | 'party' | 'none');
         *   _ownsRow       — MAY READ / MAY FLAG        := verdict !== 'none';
         *   _mayDestroyRow — MAY PERMANENTLY DESTROY    := verdict === 'owner', or the caller is the
         *                    only site account party to an un-attributed row (resolved by the SAME
         *                    _resolveLegacyOwner the backfill uses).
         * _ownerClause is the SQL twin of _ownsRow and nothing else; deleteManyPermanently is the one
         * sink and it calls _mayDestroyRow itself, so no route can reach destruction past this file.
         *
         * WHY READ AND DESTROY MUST DIFFER. A row at user_id = 0 is one NOBODY owns yet: pre-v2.1
         * data, or a row the backfill refused to attribute because SEVERAL site accounts are parties
         * to it. Letting every party READ it is right — the alternative is losing their mail. Letting
         * every party DESTROY it is the cross-user annihilation finding #6 named: the deletion is
         * permanent, it unlinks the attachment blob from disk, and the ids arrive in the destroyer's
         * own listing because they can see the row. "Shared" means readable by all of them; it has
         * never meant destroyable by any of them.
         *
         * A row owned by SOMEONE ELSE is never yours even when your address appears in it: under the
         * ownership model each party holds their OWN copy and every copy names every recipient.
         */
        _ownershipOf(row, userId, userEmail) {
            if (!row) return 'none';
            const uid = parseInt(userId, 10) || 0;
            const owner = parseInt(row.user_id, 10) || 0;
            if (owner > 0) return (uid > 0 && owner === uid) ? 'owner' : 'none';
            // user_id = 0 — the legacy sentinel. EXACT-token membership, never a substring test:
            // the substring rule is what let ana@empresa.com read and permanently delete
            // mariana@empresa.com's mail through the listing, the search endpoint and "Empty trash".
            return this.canUserAccess(row, userEmail) ? 'party' : 'none';
        },

        /** MAY READ / MAY FLAG. Derived — see _ownershipOf. */
        _ownsRow(row, userId, userEmail) {
            return this._ownershipOf(row, userId, userEmail) !== 'none';
        },

        /**
         * MAY PERMANENTLY DESTROY. Strictly narrower than _ownsRow, and DERIVED from it (it starts
         * from the same verdict), so it can never widen by accident.
         *
         * For an OWNED row the two questions have the same answer: each party holds their own copy and
         * destroying yours costs nobody else anything.
         *
         * For an UN-ATTRIBUTED row (user_id = 0) there is exactly one further question — COULD ANOTHER
         * SITE ACCOUNT LOSE THIS ROW? — and it is answered with the same address parser and the same
         * identity resolver the backfill uses:
         *   · nobody else is named on the row      → destroy;
         *   · every other address is KNOWN not to be a site account → destroy (an external
         *     correspondent loses nothing when you empty your trash);
         *   · any other address IS a site account   → refuse;
         *   · any other address CANNOT BE RESOLVED (no resolver, no users:read grant, a lookup that
         *     threw) → REFUSE. An unknown identity is not an absent one. The previous version fell
         *     back here to a "structural" rule (destroy when the caller is the only recipient), which
         *     INVERTED the verdict for the one shape that matters most: a legacy Sent copy
         *     `from ana@ to mariana@` made MARIANA the sole recipient, so she annihilated the only
         *     copy Ana had of what she sent. Worse, the fallback was justified as the degradation for
         *     "no resolver" while the host ALWAYS injects one whose catch returns 0 — so the branch
         *     was dead in production and the live branch read every failure as "nobody else here".
         *     The cost of refusing is a trash that keeps N shared rows until the backfill completes;
         *     the cost of the fallback was another mailbox's mail, permanently.
         *
         * Async purely because the resolver is.
         */
        async _mayDestroyRow(row, userId, userEmail, cache, notes) {
            const verdict = this._ownershipOf(row, userId, userEmail);
            if (verdict === 'owner') return true;
            if (verdict !== 'party') return false;
            const uid = parseInt(userId, 10) || 0;
            if (!(uid > 0)) return false;
            const me = String(userEmail || '').trim().toLowerCase();

            const parties = this._tokensOf(row, ['from_address', 'to_address', 'cc_address', 'bcc_address']);
            parties.delete(me);
            if (parties.size === 0) return true;

            const memo = cache || new Map();
            for (const addr of parties) {
                const id = await this._resolveAddressId(addr, memo);
                if (id > 0) return false;                   // another site account is a party
                if (id === UNKNOWN_IDENTITY) {              // we do not know — so we do not destroy
                    // Tell the caller WHY, so "Empty trash" can refuse the whole press instead of
                    // silently deleting a subset (the caller cannot re-derive this: an absent resolver
                    // never even reaches the memo).
                    const first = !notes || !notes.identityUnknown;
                    if (notes) notes.identityUnknown = true;
                    // ONE line per batch, not one per row: an un-backfilled mailbox can hold
                    // LEGACY_ID_CAP rows, and a thousand identical warnings is how a real signal
                    // gets filtered out of a log.
                    if (first) {
                        console.warn(
                            '[MailServer] Refusing to permanently destroy an un-attributed message: the ' +
                            `identity of ${addr} could not be resolved, so it cannot be ruled out as another ` +
                            'mailbox on this site. Check the plugin\'s users:read grant and restart it so the ' +
                            'ownership backfill can finish.'
                        );
                    }
                    return false;
                }
            }
            return true;
        },

        /**
         * IS THIS ROW SHARED — i.e. is it the ONLY copy that more than one mailbox on this site has?
         *
         * THE CLASS THIS ANSWERS, and the half wave 5 shipped without. "Shared = readable by all,
         * destroyable by none" was made true for MEMBERSHIP only: update() refused a rewrite that
         * dropped a party from an un-attributed row, and treated subject / body / raw_content /
         * is_draft / is_sent / scheduled_at as ordinary content. They are not ordinary content on a
         * row several mailboxes hold as their only copy — overwriting them DESTROYS the other party's
         * message just as surely as a DELETE, and it does it while every membership check still says
         * yes, because both names are still on the row. Round 4 reproduced exactly that: the shared
         * row survived, `to_address` kept both parties, and the colleague's message content was gone
         * from their folders with nothing in their trash.
         *
         * So destruction of CONTENT is answered here with the same inputs as destruction of the ROW —
         * the same address parser, the same identity resolver, the same UNKNOWN-is-not-absent rule —
         * and update() refuses every column on a row this returns true for. The remedy for the caller
         * is to SAVE A NEW MESSAGE (the routes do), which costs one row and destroys nothing.
         *
         * WHY A COUNT AND NOT "the caller". update() is not told who is asking (it never has been),
         * and a rule that needs an identity it does not have is a rule that will be forgotten by the
         * next caller. Two site accounts on the row is already enough to make ANY in-place rewrite a
         * loss for one of them, whoever asked; one site account means the only mailbox that could
         * lose anything is the one the route already proved the caller to be a party of.
         *
         * FAILS CLOSED, like its twin: an address the identity service cannot resolve is one we
         * cannot rule out as another mailbox here, so it counts as shared. The cost of being wrong
         * that way is a message saved as a new row; the cost of the other way is somebody's mail.
         */
        async _isSharedRow(row, cache) {
            if (!row) return false;
            // An ATTRIBUTED row has exactly one owner and every other party holds their own copy, so
            // rewriting it costs nobody else anything. Its verdict is the column, not the lists.
            if ((parseInt(row.user_id, 10) || 0) > 0) return false;
            const parties = this._tokensOf(row, ['from_address', 'to_address', 'cc_address', 'bcc_address']);
            const memo = cache || new Map();
            let local = 0;
            for (const addr of parties) {
                const id = await this._resolveAddressId(addr, memo);
                if (id === UNKNOWN_IDENTITY) return true; // unknown identity is not an absent one
                if (id > 0 && ++local > 1) return true;
            }
            return false;
        },

        /**
         * "Which site account IS this address" — ONE implementation, memoized per batch. The backfill
         * (_resolveLegacyOwner) and the request-time destruction gate (_mayDestroyRow) both go through
         * it, so boot time and request time can never answer the identity question differently.
         */
        async _resolveAddressId(addr, cache) {
            const key = String(addr == null ? '' : addr).trim().toLowerCase();
            if (!key) return 0; // an empty token names nobody — that IS an answer
            // NO RESOLVER = NO ANSWER, not "no account". The `if (resolveUserIdByAddress)` shape this
            // replaces asked whether the FUNCTION EXISTS, never whether it could ANSWER, and both the
            // host bridge and this catch turned every failure into the string 0 — indistinguishable
            // from "that address belongs to no user here".
            if (!resolveUserIdByAddress) return UNKNOWN_IDENTITY;
            if (!cache.has(key)) {
                let id = UNKNOWN_IDENTITY;
                try {
                    const answer = parseInt(await resolveUserIdByAddress(key), 10);
                    id = Number.isFinite(answer) && answer > 0 ? answer : 0;
                } catch (e) {
                    id = UNKNOWN_IDENTITY;
                }
                cache.set(key, id);
            }
            const v = cache.get(key);
            return Number.isFinite(v) ? v : UNKNOWN_IDENTITY;
        },

        /**
         * THE LAST GATE every COLLECTION passes before it is returned or DELETED.
         *
         * It is a TRIPWIRE, not a filter. _ownerClause is already exact (an indexed `user_id = ?` plus
         * an explicit id list that _legacyOwnedIds has itself run through canUserAccess), so a dropped
         * row means the SQL and the JS predicate have DIVERGED. That has to be LOUD rather than
         * silent, because findAllByUser applies it AFTER LIMIT/OFFSET while countByUser counts in SQL:
         * a quiet drop would render short pages under a total that does not add up, which reads as a
         * pagination bug and hides an authorization one. It never fires today.
         */
        _assertOwned(rows, userId, userEmail, where) {
            const all = rows || [];
            const mine = all.filter(r => this._ownsRow(r, userId, userEmail));
            if (mine.length !== all.length) {
                console.error(
                    `[MailServer] ${all.length - mine.length} row(s) selected by ${where} failed the ownership ` +
                    'check and were dropped: the SQL ownership clause and _ownsRow have diverged. Listing ' +
                    'totals will not match the page until that is fixed.'
                );
            }
            return mine;
        },

        /**
         * Un-backfilled (user_id = 0) row ids this user is genuinely a party to.
         *
         * THE ONLY SURVIVING `LIKE` IN THE STORE, and it is not an authorization test: it is an index
         * pre-filter that may over-select, and every row it returns is then put through canUserAccess
         * (exact, case-insensitive address tokens across from/to/cc/bcc). The caller receives ids, so
         * the SQL that consumes them cannot re-introduce the substring rule.
         *
         * TWO THINGS THE FIRST VERSION GOT WRONG, both of which turn a NEIGHBOUR's mailbox into an
         * outage for this one:
         *   - the pattern was `%address%`, so every row addressed to mariana@empresa.com was
         *     pre-selected for ana@empresa.com. The patterns are now ANCHORED to comma-list token
         *     boundaries — the same rule canUserAccess applies — so the pre-filter selects very nearly
         *     the rows that will actually survive it;
         *   - the CAP was applied to the pre-filter output BEFORE the exact check, so 2000 rows
         *     addressed to a superstring neighbour starved the legitimate mailbox down to ZERO ids: an
         *     empty inbox, zero counters, and an "Empty trash" that silently deleted nothing. The cap
         *     now bounds the EXACT-MATCHED set — pages are pulled by keyset (id DESC) until CAP ids are
         *     collected or the pre-filter is exhausted. This matters because un-backfilled rows are
         *     ATTACKER-CREATABLE (create() writes user_id = 0 whenever inbound catch-all cannot resolve
         *     an admin), so the budget must belong to the mailbox that owns the rows, never to whoever
         *     floods the table.
         *
         * Both sides compare LOWER(...): the pre-filter and the exact check must test the SAME value,
         * or a case-sensitive collation (Postgres/MySQL) would hide mail canUserAccess would accept.
         *
         * In the steady state _backfillOwnership() has drained the legacy set and this returns [] off
         * an empty index probe, which is why the ownership clause collapses to `m.user_id = ?`.
         */
        async _legacyOwnership(email) {
            const key = String(email || '').trim().toLowerCase();
            if (!key) return { ids: [], complete: true };
            const now = Date.now();
            const hit = this._legacyIdCache.get(key);
            // Memoize the IN-FLIGHT PROMISE, not its result: one folder poll fires findAllByUser +
            // countByUser + getCounts inside a single Promise.all, and a result-only memo (written
            // AFTER the await) missed on all three, so every poll paid the whole scan three times.
            if (hit && (now - hit.at) < LEGACY_ID_TTL_MS) return await hit.promise;

            const promise = this._legacyScan(key).catch(e => {
                this._legacyIdCache.delete(key);
                throw e;
            });
            if (this._legacyIdCache.size > 64) this._forgetOwnershipMemos();
            this._legacyIdCache.set(key, { at: now, promise });
            return await promise;
        },

        /** Back-compat/read-side accessor: the ids alone. Use _legacyOwnership when completeness matters. */
        async _legacyOwnedIds(email) {
            return (await this._legacyOwnership(email)).ids;
        },

        async _legacyScan(key) {
            // ONE pattern per column, DELIBERATELY UNANCHORED. The previous version anchored the
            // pattern on comma-and-optional-single-space token boundaries to make the pre-filter
            // "very nearly" the exact set — and thereby made it NARROWER THAN THE DECIDER, because
            // canUserAccess splits on ',' and trim()s, i.e. accepts ANY whitespace run around a
            // token. 'jefe@x.com,  ana@x.com' and ' ana@x.com' passed canUserAccess and _ownsRow but
            // were invisible to the SQL, so the rows vanished from every listing, counter and search
            // while "Empty trash" reported success over them. That is this repo's recurring shape:
            // THE GUARD INSPECTS A DIFFERENT VALUE THAN THE DECIDER.
            //
            // There is no portable LIKE expression that reproduces `split(',').map(trim)` (LIKE has no
            // character classes and no bounded repetition), so we stop trying to have two values: a
            // SUBSTRING test is TRIVIALLY A SUPERSET of any token match, on every engine and every
            // collation, and canUserAccess below is the only thing that decides. Over-selection is
            // harmless BY DESIGN and bounded — see LEGACY_SCAN_CAP — and LIKE's own wildcards are
            // escaped so the only reason to over-select is a genuine address substring (ana@ ⊂
            // mariana@), never a '_' in someone's address.
            //
            // from_address goes through the SAME contains test rather than `LOWER(from) = ?`:
            // canUserAccess tokenizes from_address too, so an equality test there was a second, third
            // and narrower answer to the same question.
            const pattern = `%${escapeLike(key)}%`;
            const cols = ['to_address', 'cc_address', 'bcc_address', 'from_address'];
            const likeSql = cols.map(c => `LOWER(m.${c}) LIKE ? ESCAPE '${LIKE_ESCAPE}'`).join(' OR ');
            const likeParams = cols.map(() => pattern);
            const sql =
                `SELECT ${AUTH_COLS} FROM ${T_EMAILS} m ` +
                `WHERE m.user_id = 0 AND m.id < ? AND (${likeSql}) ` +
                `ORDER BY m.id DESC LIMIT ?`;

            const ids = [];
            let cursor = Number.MAX_SAFE_INTEGER; // keyset on id, descending
            let scanned = 0;
            let exhausted = false;
            let capped = false;
            while (scanned < LEGACY_SCAN_CAP) {
                let rows;
                try {
                    rows = await db.all(sql, [cursor, ...likeParams, LEGACY_SCAN_PAGE]);
                } catch (e) {
                    // Fail CLOSED, and say so: an unreadable pre-filter must never widen the ownership
                    // clause, and must never be reported as a complete answer either.
                    console.error('[MailServer] Legacy ownership pre-filter failed:', e && e.message);
                    return { ids: [], complete: false };
                }
                if (!rows || rows.length === 0) { exhausted = true; break; }
                scanned += rows.length;
                cursor = parseInt(rows[rows.length - 1].id, 10) || 0;
                for (const r of rows) {
                    if (!this.canUserAccess(r, key)) continue;
                    if (ids.length >= LEGACY_ID_CAP) { capped = true; break; }
                    ids.push(r.id);
                }
                if (capped) break;
                if (rows.length < LEGACY_SCAN_PAGE) { exhausted = true; break; }
            }
            // COMPLETE means "this list is every un-attributed row of theirs", and only an exhausted
            // pre-filter proves it. Hitting either cap used to be logged and then handed back as if it
            // were the whole truth, which is how a starved mailbox showed an EMPTY inbox, zero
            // counters and an "Empty trash" that destroyed nothing while answering "Trash emptied".
            // The verdict now travels with the ids so the destructive paths can refuse.
            const complete = exhausted && !capped;
            if (capped) {
                console.error(
                    `[MailServer] More than ${LEGACY_ID_CAP} un-migrated messages (user_id = 0) belong to ` +
                    `${key}; only the newest ${LEGACY_ID_CAP} are reachable. The ownership backfill has ` +
                    'not completed — check that the plugin has the users:read grant and restart it.'
                );
            } else if (!complete) {
                console.error(
                    `[MailServer] Gave up scanning un-migrated messages (user_id = 0) for ${key} after ` +
                    `${scanned} rows; some of their mail may be missing from listings until the ownership ` +
                    'backfill completes — check that the plugin has the users:read grant and restart it.'
                );
            }
            return { ids, complete };
        },

        /**
         * === THE ONE PREDICATE, COMPILED INTO SQL =========================================
         *
         * `mode` picks WHICH question — SCOPE.READ ("may this actor see it") or SCOPE.DESTROY ("may
         * this actor permanently destroy it") — and the answer comes back as a WHERE fragment that
         * the caller COMPOSES INTO ITS OWN QUERY. That is the whole point: three waves put an
         * ownership check at call sites and every wave forgot one, so the check is now something a
         * query CANNOT be written without. A read selects rows the predicate yields; a delete deletes
         * rows the predicate yields, in the DELETE statement itself.
         *
         * The two modes share their owner arm exactly (`user_id = <actor>`) and differ only in the
         * legacy arm: an un-attributed (user_id = 0) row is READABLE by every party and DESTROYABLE
         * only by the parties _mayDestroyRow admits, so the destroy id list is computed FROM the read
         * id list by that one row predicate. Destroy is therefore a subset of read by construction,
         * not by a test that happens to agree.
         *
         * `complete` travels with the clause: when the legacy pre-filter could not be exhausted the
         * answer is a PARTIAL view of the mailbox, which reads may serve (a short page) but
         * destruction must refuse (deleting "the part we found" is irreversible).
         *
         * SITE-WIDE RETENTION is a mode of the same predicate, not an exemption from it. It owns no
         * row, so it cannot be expressed as `user_id = ?`; it is expressed as the rows a retention
         * policy may legitimately reap: ATTRIBUTED spam whose spam flag was set by nobody (the
         * delivery-time classifier) or by the row's OWN owner. Marking someone else's message as
         * spam — which every reader of a row may do, and every administrator may do to anyone —
         * therefore no longer feeds it to the reaper.
         *
         * `requested` NARROWS THE WORK, NEVER THE ANSWER. The DESTROY mode has to resolve the IDENTITY
         * of every other party to each un-attributed row it considers, and each resolution is an RPC
         * across the plugin bridge into the host's users table. Computing it over the caller's WHOLE
         * legacy population (up to LEGACY_ID_CAP = 2000 rows) to delete ONE message turned a normal
         * authenticated request into 1:2000 amplification — and the population that feeds it is
         * precisely the degraded install this redesign exists for. When the caller already knows which
         * ids it is asking about, it passes them and only their intersection with the legacy set is
         * resolved. The clause is identical either way: ids outside `requested` could not have been
         * deleted by that statement anyway, because the caller's own id list is the other half of
         * every DELETE's WHERE.
         *
         * @param {object|symbol} actor { userId, userEmail } or SYSTEM_RETENTION
         * @param {string} mode SCOPE.READ | SCOPE.DESTROY
         * @param {string} alias table alias the caller uses ('' for a bare DELETE)
         * @param {number[]|null} requested ids the caller will act on, when it knows them
         * @returns {{clause: string, params: any[], complete: boolean}}
         */
        async _scopeClause(actor, mode, alias = 'm', requested = null) {
            const p = alias ? `${alias}.` : '';
            if (mode !== SCOPE.READ && mode !== SCOPE.DESTROY) {
                throw new Error(`Unknown ownership scope mode: ${String(mode)}`);
            }
            if (actor === SYSTEM_RETENTION) {
                if (mode !== SCOPE.DESTROY) {
                    throw new Error('SYSTEM_RETENTION is a destruction actor: it never scopes a read.');
                }
                return {
                    clause: `(${p}user_id > 0 AND ${p}is_spam = 1 AND (${p}spam_flagged_by = 0 OR ${p}spam_flagged_by = ${p}user_id))`,
                    params: [],
                    complete: true
                };
            }
            const uid = parseInt(actor && actor.userId, 10) || 0;
            const email = actor && actor.userEmail;
            // A missing/zero user id must match NOTHING. `user_id = 0` is the legacy sentinel, so
            // binding 0 into the owner arm would hand the caller EVERY un-backfilled row in the table.
            const ownArm = uid > 0 ? `${p}user_id = ?` : `${p}user_id = -1`;
            const params = uid > 0 ? [uid] : [];
            const { ids, complete } = await this._legacyOwnership(email);
            let legacy = ids;
            let identityUnknown = false;
            if (mode === SCOPE.DESTROY) {
                // INTERSECT BEFORE RESOLVING, never after: the expensive step is the identity lookup
                // per row, so an id the caller is not acting on must never reach it.
                let considered = ids;
                if (requested) {
                    const want = new Set(requested.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n)));
                    considered = ids.filter(rowId => want.has(parseInt(rowId, 10)));
                }
                const narrowed = await this._destroyableLegacyIds(considered, uid, email);
                legacy = narrowed.ids;
                identityUnknown = narrowed.identityUnknown;
            }
            if (legacy.length === 0) return { clause: `(${ownArm})`, params, complete, identityUnknown };
            const ph = legacy.map(() => '?').join(', ');
            return {
                clause: `(${ownArm} OR ${p}id IN (${ph}))`,
                params: [...params, ...legacy],
                complete,
                identityUnknown
            };
        },

        /**
         * The un-attributed rows this actor may DESTROY: the party ids the read mode yields, put
         * through _mayDestroyRow one by one. This is the single place where the destroy mode narrows
         * the read mode, so "destroy ⊆ read" cannot drift.
         */
        async _destroyableLegacyIds(ids, userId, userEmail) {
            const uid = parseInt(userId, 10) || 0;
            if (!(uid > 0) || !ids || ids.length === 0) return { ids: [], identityUnknown: false };
            // MEMOIZED FOR THE SAME SHORT WINDOW AS THE LEGACY ID LIST. "Empty trash" asks for this
            // verdict twice over the very same ids — once to decide whether it may run at all
            // (identityUnknown) and once inside the destruction sink — and each ask is a full round of
            // identity RPCs. The key is the actor plus the exact id list, so a different question is
            // never answered from another question's memo.
            const key = `${uid}|${String(userEmail || '').trim().toLowerCase()}|${ids.join(',')}`;
            const now = Date.now();
            const hit = this._destroyableCache.get(key);
            if (hit && (now - hit.at) < LEGACY_ID_TTL_MS) return hit.value;
            const memo = new Map(); // address -> user id, shared across the whole batch
            // Set by _mayDestroyRow when it held a row back because the identity of another party
            // could not be resolved — a different fact from "it is not yours", and one the user is
            // entitled to hear instead of a silently short delete.
            const notes = { identityUnknown: false };
            const out = [];
            for (let i = 0; i < ids.length; i += 100) {
                const chunk = ids.slice(i, i + 100);
                const ph = chunk.map(() => '?').join(', ');
                const rows = await db.all(`SELECT ${AUTH_COLS} FROM ${T_EMAILS} m WHERE m.id IN (${ph})`, chunk);
                for (const row of rows) {
                    if (await this._mayDestroyRow(row, uid, userEmail, memo, notes)) out.push(row.id);
                }
            }
            const value = { ids: out, identityUnknown: notes.identityUnknown };
            if (this._destroyableCache.size > 64) this._destroyableCache.clear();
            this._destroyableCache.set(key, { at: now, value });
            return value;
        },

        /**
         * THE READ mode of the predicate, under the name every listing/counter/search already uses.
         * Columns are qualified with the `m` alias — every caller aliases ${T_EMAILS} AS m.
         */
        async _ownerClause(userId, email) {
            return await this._scopeClause({ userId, userEmail: email }, SCOPE.READ);
        },

        /** Per-folder WHERE clause: the ownership predicate AND the folder's flag mask. */
        async _folderClause(userId, email, folder = 'inbox', labelId = 0) {
            const own = await this._ownerClause(userId, email);

            if (String(folder).startsWith('label')) {
                const clause = `(${own.clause} AND m.is_trash = 0 AND m.is_spam = 0 AND m.is_draft = 0 ` +
                    `AND EXISTS (SELECT 1 FROM ${T_EMAIL_LABELS} el WHERE el.email_id = m.id AND el.label_id = ?))`;
                return { clause, params: [...own.params, parseInt(labelId, 10) || 0], complete: own.complete };
            }

            const FLAGS = {
                inbox: 'm.is_sent = 0 AND m.is_draft = 0 AND m.is_archived = 0 AND m.is_trash = 0 AND m.is_spam = 0 AND m.scheduled_at IS NULL',
                sent: 'm.is_sent = 1 AND m.is_draft = 0 AND m.is_trash = 0',
                drafts: '(m.is_draft = 1 OR (m.scheduled_at IS NOT NULL AND m.is_sent = 0)) AND m.is_trash = 0',
                archive: 'm.is_archived = 1 AND m.is_trash = 0 AND m.is_spam = 0',
                starred: 'm.is_starred = 1 AND m.is_trash = 0 AND m.is_spam = 0',
                spam: 'm.is_spam = 1 AND m.is_trash = 0',
                trash: 'm.is_trash = 1',
            };
            const flags = FLAGS[folder] || FLAGS.inbox;
            return { clause: `(${own.clause} AND ${flags})`, params: own.params, complete: own.complete };
        },

        async findAllByUser(userId, email, folder = 'inbox', limit = 50, offset = 0, labelId = 0) {
            const { clause, params } = await this._folderClause(userId, email, folder, labelId);

            // Thread-collapse: pick ONE representative row per thread. A bare-column GROUP BY (SELECT *
            // … GROUP BY thread_key) returns an arbitrary/stale row on SQLite and is ILLEGAL on Postgres
            // (500s the whole listing). Instead aggregate first (thread_key → newest row id + count),
            // then JOIN back to fetch that row's real columns. The representative is the highest id in the
            // thread (newest-inserted), deterministic on both drivers.
            const threadKey = 'CASE WHEN m.thread_id > 0 THEN m.thread_id ELSE m.id END';
            const rows = await db.all(`
                SELECT ${LIST_COLS},
                       t.thread_count,
                       CASE WHEN EXISTS (SELECT 1 FROM ${T_ATTACH} a WHERE a.email_id = e.id) THEN 1 ELSE 0 END AS has_attachment
                FROM ${T_EMAILS} e
                JOIN (
                    SELECT ${threadKey} AS tkey, MAX(m.id) AS rep_id, COUNT(*) AS thread_count
                    FROM ${T_EMAILS} m
                    WHERE ${clause}
                    GROUP BY ${threadKey}
                ) t ON e.id = t.rep_id
                ORDER BY e.date_received DESC, e.id DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]);
            // Belt to the ownership clause's braces: a listing row carries subject, every recipient
            // field and a 180-char body snippet, so it is exactly what leaked while the clause
            // authorized by substring. Re-checking here (over one page, in memory) means a future
            // edit to the SQL above cannot put another mailbox on screen.
            return this._assertOwned(rows, userId, email, 'the folder listing');
        },

        async countByUser(userId, email, folder = 'inbox', labelId = 0) {
            const { clause, params } = await this._folderClause(userId, email, folder, labelId);
            // Count the SAME collapsed unit findAllByUser lists (one per thread), not raw rows — otherwise
            // the total exceeds the visible items and pagination renders empty trailing pages.
            // This counts in SQL while findAllByUser also runs _assertOwned over the returned page. The
            // two agree because that check is a tripwire the exact clause can never trip; if it ever
            // does it logs an error naming this divergence rather than quietly shortening the page.
            const threadKey = 'CASE WHEN m.thread_id > 0 THEN m.thread_id ELSE m.id END';
            const row = await db.get(`
                SELECT COUNT(*) as count FROM (
                    SELECT 1 FROM ${T_EMAILS} m
                    WHERE ${clause}
                    GROUP BY ${threadKey}
                ) sub
            `, params);
            return row ? row.count : 0;
        },

        /**
         * All sidebar badge counters in ONE indexed pass over the user's rows (the old UI issued a
         * separate /stats scan per poll on top of the listing).
         */
        async getCounts(userId, email) {
            // The counters used to run SUM(CASE ...) over the substring arm, so they confirmed the
            // unread state of ANOTHER mailbox. They now aggregate over _ownerClause — the same
            // already-exact row set the listing shows — so a badge can never count a message the user
            // is not allowed to open.
            const { clause, params } = await this._ownerClause(userId, email);
            const row = await db.get(`
                SELECT
                    COALESCE(SUM(CASE WHEN m.is_sent = 0 AND m.is_draft = 0 AND m.is_archived = 0 AND m.is_trash = 0 AND m.is_spam = 0 AND m.scheduled_at IS NULL AND m.is_read = 0 THEN 1 ELSE 0 END), 0) AS inbox_unread,
                    COALESCE(SUM(CASE WHEN m.is_spam = 1 AND m.is_trash = 0 AND m.is_read = 0 THEN 1 ELSE 0 END), 0) AS spam_unread,
                    COALESCE(SUM(CASE WHEN (m.is_draft = 1 OR (m.scheduled_at IS NOT NULL AND m.is_sent = 0)) AND m.is_trash = 0 THEN 1 ELSE 0 END), 0) AS drafts
                FROM ${T_EMAILS} m
                WHERE ${clause}
            `, params);
            return {
                inbox_unread: row ? Number(row.inbox_unread) || 0 : 0,
                spam_unread: row ? Number(row.spam_unread) || 0 : 0,
                drafts: row ? Number(row.drafts) || 0 : 0
            };
        },

        async countUnreadInbox(userId, email) {
            const c = await this.getCounts(userId, email);
            return c.inbox_unread;
        },

        async markAsRead(id) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_read = 1 WHERE id = ?`, [id]);
        },

        async setRead(id, state) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_read = ? WHERE id = ?`, [state ? 1 : 0, id]);
        },

        async setStarred(id, state) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_starred = ? WHERE id = ?`, [state ? 1 : 0, id]);
        },

        async setArchived(id, state) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_archived = ? WHERE id = ?`, [state ? 1 : 0, id]);
        },

        /**
         * Mark/unmark spam. `actorId` is WHO pressed it, and it is written to the row, because the
         * spam flag is an INPUT TO A DESTRUCTION PREDICATE (see purgeOldSpam/_scopeClause): a flag
         * anybody who can read the row may set decides what site-wide retention reaps. A call site
         * that names no actor writes UNIDENTIFIED_FLAGGER, which retention never matches.
         */
        async setSpam(id, state, actorId) {
            const uid = parseInt(actorId, 10) || 0;
            const flagger = state ? (uid > 0 ? uid : UNIDENTIFIED_FLAGGER) : 0;
            // Marking spam also un-archives so "Not spam" later returns the mail to the inbox, and
            // marks it read is NOT done (Gmail keeps unread state).
            return await db.run(
                `UPDATE ${T_EMAILS} SET is_spam = ?, is_archived = 0, spam_flagged_by = ? WHERE id = ?`,
                [state ? 1 : 0, flagger, id]
            );
        },

        async moveToTrash(id) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_trash = 1 WHERE id = ?`, [id]);
        },

        async restoreFromTrash(id) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_trash = 0 WHERE id = ?`, [id]);
        },

        /**
         * Bulk flag update over an ALREADY-AUTHORIZED id list (the route filters ownership first).
         * `set` accepts: isRead, isStarred, isArchived, isTrash, isSpam (0/1 each).
         */
        async bulkSetFlags(ids, set, actorId) {
            const list = (ids || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);
            if (list.length === 0) return 0;
            const fields = [];
            const params = [];
            const map = { isRead: 'is_read', isStarred: 'is_starred', isArchived: 'is_archived', isTrash: 'is_trash', isSpam: 'is_spam' };
            for (const [k, col] of Object.entries(map)) {
                if (set[k] !== undefined) { fields.push(`${col} = ?`); params.push(set[k] ? 1 : 0); }
            }
            // Same rule as setSpam: the spam flag feeds the retention predicate, so it never travels
            // without saying who set it. Written in the SAME statement as is_spam, so the two cannot
            // be updated apart.
            if (set.isSpam !== undefined) {
                const uid = parseInt(actorId, 10) || 0;
                fields.push('spam_flagged_by = ?');
                params.push(set.isSpam ? (uid > 0 ? uid : UNIDENTIFIED_FLAGGER) : 0);
            }
            if (fields.length === 0) return 0;
            const ph = list.map(() => '?').join(', ');
            await db.run(`UPDATE ${T_EMAILS} SET ${fields.join(', ')} WHERE id IN (${ph})`, [...params, ...list]);
            return list.length;
        },

        // Cancel an undo-window/scheduled send: back to a draft, atomically guarded on is_sent = 0 so
        // it can never "unsend" a message the queue already dispatched (the dispatch flips is_sent=1).
        async cancelScheduled(id) {
            await db.run(`
                UPDATE ${T_EMAILS}
                SET is_draft = 1, scheduled_at = NULL, delivery_status = NULL
                WHERE id = ? AND is_sent = 0 AND is_trash = 0
            `, [id]);
            return await this.findById(id);
        },

        async deletePermanently(id, actor) {
            return await this.deleteManyPermanently([id], actor);
        },

        /**
         * Permanent delete in BATCHES (attachment files + attachment rows + label links + email rows).
         * The old per-email loop issued 3 queries per message — emptying a large trash took hundreds of
         * sequential bridge round-trips.
         *
         * === THE DESTRUCTION CHOKEPOINT ====================================================
         * `actor` is MANDATORY and is either a user — { userId, userEmail } — or the SYSTEM_RETENTION
         * sentinel. It is turned into the DESTROY mode of the ownership predicate (_scopeClause) and
         * that clause is COMPOSED INTO THE DELETE STATEMENT ITSELF: the ids the caller handed in are
         * an INTERSECTION, never an authorization. There is no code path here that deletes a row the
         * predicate did not yield, because there is no DELETE here without the predicate in its WHERE.
         *
         * WHY. Three waves put the check at the CALL SITES: wave 2 tightened emptyTrash, and
         * DELETE /emails/:id plus POST /emails/bulk kept deleting by address and reached this very
         * function; wave 3 tightened those two, and the same wave's backfill fix re-created the row
         * category where the surviving predicate was still by ADDRESS. Wave 4 moved the check inside
         * this function — and round 3 then walked around it TWICE without touching it: site-wide
         * retention skipped the branch entirely, and POST /drafts rewrote the address columns the
         * verdict is COMPUTED FROM, so the same gate returned a different answer one request later.
         * A check the query does not contain is a check something can be routed around.
         *
         * SITE-WIDE RETENTION is not an exemption any more: SYSTEM_RETENTION selects a MODE of the
         * predicate (see _scopeClause) that yields attributed, owner-or-classifier-flagged spam only.
         */
        async deleteManyPermanently(ids, actor) {
            const requested = (ids || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);

            if (actor !== SYSTEM_RETENTION && !(parseInt(actor && actor.userId, 10) > 0)) {
                // FAIL CLOSED and LOUD. An un-actored permanent delete is a programming error, and
                // the failure mode it replaces (deleting whatever ids it was handed) is irreversible.
                console.error(
                    '[MailServer] Refusing a permanent delete with no actor: deleteManyPermanently(ids, ' +
                    '{ userId, userEmail }) is required, or Email.SYSTEM_RETENTION for site-wide retention.'
                );
                return 0;
            }

            // Nothing asked for, nothing to authorize — and nothing to spend a round of identity
            // lookups on either (see `requested` in _scopeClause).
            if (requested.length === 0) return 0;

            let scope;
            try {
                scope = await this._scopeClause(actor, SCOPE.DESTROY, '', requested);
            } catch (e) {
                console.error('[MailServer] Refusing a permanent delete:', e && e.message);
                return 0;
            }
            if (!scope.complete) {
                // The legacy pre-filter could not be exhausted, so we do not know the full destroy set.
                // Reads may serve a partial view; destruction may not act on one.
                console.error(
                    '[MailServer] Refusing a permanent delete: this mailbox still has messages from ' +
                    'before the ownership upgrade that could not all be listed, so the destruction ' +
                    'predicate is only partly known. Restart the plugin so the backfill can finish.'
                );
                return 0;
            }

            let deleted = 0;
            let refused = 0;
            for (let i = 0; i < requested.length; i += 100) {
                const asked = requested.slice(i, i + 100);
                const aph = asked.map(() => '?').join(', ');
                // WHICH of these rows the predicate yields — asked of the DATABASE, with the same
                // clause the DELETE below carries, so the children cleaned up below and the rows
                // deleted are the same set by construction.
                const doomedRows = await db.all(
                    `SELECT id FROM ${T_EMAILS} WHERE id IN (${aph}) AND ${scope.clause}`,
                    [...asked, ...scope.params]
                );
                const chunk = doomedRows.map(r => parseInt(r.id, 10)).filter(n => Number.isFinite(n) && n > 0);
                refused += asked.length - chunk.length;
                if (chunk.length === 0) continue;
                const ph = chunk.map(() => '?').join(', ');
                await db.run(`DELETE FROM ${T_EMAIL_LABELS} WHERE email_id IN (${ph})`, chunk);
                // Attachment ROWS first, then unlink only the blobs NOTHING still points at. A legacy
                // fan-out clone shares its storage_path with the sibling copy it was cloned from, so an
                // unconditional unlink would delete the other party's attachment off disk while their
                // row survives — the same cross-user destruction, one indirection down.
                let names = [];
                try {
                    const atts = await db.all(`SELECT storage_path FROM ${T_ATTACH} WHERE email_id IN (${ph})`, chunk);
                    names = [...new Set(atts.map(a => a && a.storage_path).filter(Boolean))];
                } catch (e) {
                    console.error('[Email] Attachment lookup failed:', e.message);
                }
                await db.run(`DELETE FROM ${T_ATTACH} WHERE email_id IN (${ph})`, chunk);
                try {
                    if (names.length > 0) {
                        const nph = names.map(() => '?').join(', ');
                        const survivors = await db.all(
                            `SELECT storage_path FROM ${T_ATTACH} WHERE storage_path IN (${nph})`, names
                        );
                        const stillReferenced = new Set(survivors.map(s => s.storage_path));
                        for (const name of names) {
                            if (stillReferenced.has(name)) continue;
                            const fullPath = path.join(UPLOAD_DIR, name);
                            try { await fs.unlink(fullPath); } catch (e) {
                                if (e.code !== 'ENOENT') console.error(`[Email] Failed to delete attachment at ${fullPath}:`, e.message);
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Email] Attachment cleanup failed:', e.message);
                }
                // THE PREDICATE IS IN THE DELETE. Not a filter that ran earlier and produced this
                // list — the statement that destroys the rows carries the ownership clause itself, so
                // an id that reaches here without passing it deletes nothing.
                const res = await db.run(
                    `DELETE FROM ${T_EMAILS} WHERE id IN (${ph}) AND ${scope.clause}`,
                    [...chunk, ...scope.params]
                );
                deleted += (res && Number.isFinite(res.changes)) ? res.changes : chunk.length;
            }
            if (refused > 0) {
                console.warn(
                    `[MailServer] Permanent delete: ${refused} of ${requested.length} message(s) are not ` +
                    'this actor\'s to destroy and were left untouched.'
                );
            }
            // Ids just deleted must not survive in the legacy memo: harmless in SQL (they match
            // nothing) but a stale list is exactly the kind of thing a later reader trusts.
            if (deleted > 0) this._forgetOwnershipMemos();
            return deleted;
        },

        /**
         * SECURITY (irreversible cross-user destruction): this is the "Empty trash" button. It used to
         * hand _folderClause's substring arm straight to deleteManyPermanently, so ana@empresa.com
         * emptying her trash permanently destroyed mariana@empresa.com's trashed mail — attachments
         * unlinked from disk included — with no manipulated request and no record of who did it.
         *
         * RULE: nothing that deletes ON BEHALF OF A USER may reach deleteManyPermanently without
         * passing _ownsRow first. So the rows are materialized and checked before a single id is
         * deleted. The per-id routes and /emails/bulk now use the SAME predicate (index.js
         * canAccessEmail === _ownsRow + the administrator override); tightening only this function was
         * how permanent cross-user destruction survived the first fix — DELETE /emails/:id and
         * /emails/bulk kept authorizing by ADDRESS and reached this very same deleteManyPermanently.
         *
         * The rule is about USER-INITIATED deletes, and there is exactly ONE thing it does not cover:
         * purgeOldSpam below, which is site-wide RETENTION and belongs to no user. That exception is
         * stated at its own definition instead of being left to contradict an invariant written here.
         */
        async emptyTrash(userId, userEmail) {
            const { clause, params, complete } = await this._folderClause(userId, userEmail, 'trash');
            if (!complete) {
                // The legacy pre-filter could not be exhausted, so this user's trash is only PARTLY
                // known. Deleting the part we found and answering "Trash emptied (N deleted)" is the
                // lie finding #25 described from the other side; refuse loudly instead.
                const err = new Error(
                    'Your mailbox still contains messages from before the ownership upgrade and they ' +
                    'could not all be listed, so "Empty trash" would delete only part of it. Restart the ' +
                    'mail-server plugin so the ownership backfill can finish, then try again.'
                );
                err.code = 'mail_legacy_scan_incomplete';
                throw err;
            }
            const rows = await db.all(`SELECT ${AUTH_COLS} FROM ${T_EMAILS} m WHERE ${clause}`, params);
            const mine = this._assertOwned(rows, userId, userEmail, 'empty trash');
            const ids = mine.map(r => r.id);

            // Same doctrine as `complete` above, for the other half of the answer: if the identity
            // service could not tell us who the other parties to an un-attributed row are, we do not
            // know what this button is allowed to destroy. Refuse the whole press and say why — a
            // partial empty that reports a number is the lie this store keeps being caught in.
            //
            // Asked over THE TRASHED IDS, not over the whole legacy population: this button empties a
            // folder, and resolving the identity of every un-attributed row the user has ever been a
            // party to in order to delete the handful in their trash was 1:2000 amplification of one
            // click. The verdict is memoized for the same short window, so the sink below re-uses this
            // answer instead of paying for it a second time.
            const destroyScope = await this._scopeClause({ userId, userEmail }, SCOPE.DESTROY, 'm', ids);
            if (destroyScope.identityUnknown) {
                const err = new Error(
                    'Some of your messages predate the ownership upgrade and the server could not check ' +
                    'whether they are shared with another mailbox, so "Empty trash" would risk deleting ' +
                    'somebody else\'s copy. Restore the plugin\'s users:read grant and restart it, then ' +
                    'try again.'
                );
                err.code = 'mail_identity_unavailable';
                throw err;
            }
            // The per-row destruction gate lives in deleteManyPermanently — _assertOwned above is the
            // READ tripwire and is deliberately NOT the delete rule (it passes 'shared' rows).
            return await this.deleteManyPermanently(ids, { userId, userEmail });
        },

        /**
         * Spam retention: permanently drop spam older than `days` (Gmail does 30). Returns count.
         *
         * SITE-WIDE BY DESIGN — it reaps by AGE across every mailbox and takes no user — but NOT
         * un-predicated. It composes the RETENTION mode of the one ownership predicate, and it must,
         * because its selection criterion (`is_spam = 1`) is a flag that ANY reader of a row can
         * write: PUT /emails/:id/spam, POST /emails/bulk {action:'spam'} and POST /classification/train
         * all set it after a READ-level check, and administrators pass that check on everybody's mail.
         * So "mark as spam and wait" was a way to destroy a message the destruction gate refuses to
         * destroy, with no manipulated request at all — and a pre-v2.1 row is by definition already
         * older than the retention window, so there was nothing to wait for.
         *
         * The predicate keeps this to rows that ARE somebody's (user_id > 0 — an un-attributed row is
         * nobody's retention material) and whose spam flag was set by the delivery classifier or by
         * that same owner. See _scopeClause.
         */
        async purgeOldSpam(days = 30) {
            const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
                .toISOString().slice(0, 19).replace('T', ' ');
            const scope = await this._scopeClause(SYSTEM_RETENTION, SCOPE.DESTROY, '');
            const rows = await db.all(
                `SELECT id FROM ${T_EMAILS} WHERE date_received < ? AND ${scope.clause}`,
                [cutoff, ...scope.params]
            );
            if (rows.length === 0) return 0;
            return await this.deleteManyPermanently(rows.map(r => r.id), SYSTEM_RETENTION);
        },

        /**
         * Operator-aware search, scoped to the requesting user's mail via the ownership clause.
         * `q` = { text, from, to, subject, hasAttachment, isUnread, isStarred, labelId, folder }.
         */
        async search(userId, email, q = {}, limit = 50, offset = 0) {
            // The scope clause was a copy of the substring arm, and `q.text` runs `body_text LIKE ?`
            // over whatever it selects — which turned this endpoint into a full-text oracle over
            // another user's message BODIES. It is now the single ownership predicate.
            const own = await this._ownerClause(userId, email);
            const where = [own.clause];
            const params = [...own.params];

            const folder = q.folder || 'anywhere';
            if (folder === 'trash') {
                where.push('m.is_trash = 1');
            } else if (folder === 'spam') {
                where.push('m.is_spam = 1 AND m.is_trash = 0');
            } else {
                where.push('m.is_trash = 0 AND m.is_spam = 0');
                if (folder === 'inbox') where.push('m.is_sent = 0 AND m.is_draft = 0 AND m.is_archived = 0 AND m.scheduled_at IS NULL');
                else if (folder === 'sent') where.push('m.is_sent = 1 AND m.is_draft = 0');
                else if (folder === 'drafts') where.push('(m.is_draft = 1 OR (m.scheduled_at IS NOT NULL AND m.is_sent = 0))');
                else if (folder === 'archive') where.push('m.is_archived = 1');
                else if (folder === 'starred') where.push('m.is_starred = 1');
            }

            if (q.text) {
                const t = `%${q.text}%`;
                where.push('(m.subject LIKE ? OR m.body_text LIKE ? OR m.from_name LIKE ? OR m.from_address LIKE ? OR m.to_address LIKE ?)');
                params.push(t, t, t, t, t);
            }
            if (q.from) { const t = `%${q.from}%`; where.push('(m.from_address LIKE ? OR m.from_name LIKE ?)'); params.push(t, t); }
            if (q.to) { const t = `%${q.to}%`; where.push('(m.to_address LIKE ? OR m.cc_address LIKE ? OR m.bcc_address LIKE ?)'); params.push(t, t, t); }
            if (q.subject) { where.push('m.subject LIKE ?'); params.push(`%${q.subject}%`); }
            if (q.hasAttachment) where.push(`EXISTS (SELECT 1 FROM ${T_ATTACH} a WHERE a.email_id = m.id)`);
            if (q.isUnread) where.push('m.is_read = 0');
            if (q.isStarred) where.push('m.is_starred = 1');
            if (q.labelId) {
                where.push(`EXISTS (SELECT 1 FROM ${T_EMAIL_LABELS} el WHERE el.email_id = m.id AND el.label_id = ?)`);
                params.push(parseInt(q.labelId, 10) || 0);
            }

            const rows = await db.all(`
                SELECT ${listCols('m')},
                       CASE WHEN EXISTS (SELECT 1 FROM ${T_ATTACH} a WHERE a.email_id = m.id) THEN 1 ELSE 0 END AS has_attachment
                FROM ${T_EMAILS} m
                WHERE ${where.join(' AND ')}
                ORDER BY m.date_received DESC, m.id DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]);
            // Same belt as findAllByUser: search results carry the snippet, so they must never outlive
            // the exact ownership check even if the WHERE above is edited later.
            return this._assertOwned(rows, userId, email, 'search');
        },

        // Back-compat shim for the pre-operator search signature.
        async searchByUser(userId, email, query, limit = 50) {
            return await this.search(userId, email, { text: query }, limit, 0);
        },

        /**
         * Recipient autocomplete: distinct correspondents from the user's OWN mail (senders they've
         * received from + recipients they've written to), most recent first. Merged with the site
         * user directory in the route.
         */
        async suggestContacts(userId, userEmail, term, limit = 8) {
            // Through the ONE ownership predicate, not a hand-written `m.user_id = ?`: that copy had no
            // legacy arm, so on an install that still holds un-backfilled rows the autocomplete saw no
            // historic correspondent at all — a silent functional regression, and one more place where
            // a second, private ownership rule had started to grow back.
            const own = await this._ownerClause(userId, userEmail);
            const t = `%${term}%`;
            const out = new Map(); // email(lower) -> { email, name }

            // Senders of mail this user received.
            const senders = await db.all(`
                SELECT m.from_address AS addr, MAX(m.from_name) AS name, MAX(m.id) AS latest
                FROM ${T_EMAILS} m
                WHERE ${own.clause} AND m.is_sent = 0 AND m.from_address LIKE ?
                GROUP BY m.from_address
                ORDER BY latest DESC
                LIMIT ?
            `, [...own.params, t, limit]);
            for (const s of senders) {
                const a = String(s.addr || '').trim().toLowerCase();
                if (a && a.includes('@') && !out.has(a)) out.set(a, { email: a, name: s.name || '' });
            }

            // Recipients this user has written to (comma-joined lists → split in JS).
            const sent = await db.all(`
                SELECT m.to_address, m.cc_address FROM ${T_EMAILS} m
                WHERE ${own.clause} AND m.is_sent = 1
                ORDER BY m.id DESC
                LIMIT 100
            `, [...own.params]);
            const needle = String(term || '').toLowerCase();
            for (const row of sent) {
                for (const field of [row.to_address, row.cc_address]) {
                    if (!field) continue;
                    for (const part of String(field).split(',')) {
                        const a = part.trim().toLowerCase();
                        if (!a || !a.includes('@')) continue;
                        if (needle && !a.includes(needle)) continue;
                        if (!out.has(a)) out.set(a, { email: a, name: '' });
                    }
                }
                if (out.size >= limit * 2) break;
            }
            return [...out.values()].slice(0, limit);
        },

        // --- Labels (Gmail-style, per user) ------------------------------------

        async listLabels(userId) {
            const uid = parseInt(userId, 10) || 0;
            return await db.all(`
                SELECT l.id, l.user_id, l.name, l.color,
                       (SELECT COUNT(*) FROM ${T_EMAIL_LABELS} el
                        JOIN ${T_EMAILS} e ON e.id = el.email_id
                        WHERE el.label_id = l.id AND e.is_trash = 0 AND e.is_spam = 0) AS email_count
                FROM ${T_LABELS} l
                WHERE l.user_id = ?
                ORDER BY l.name ASC
            `, [uid]);
        },

        async findLabel(id, userId) {
            return await db.get(`SELECT * FROM ${T_LABELS} WHERE id = ? AND user_id = ?`, [parseInt(id, 10) || 0, parseInt(userId, 10) || 0]);
        },

        async createLabel(userId, name, color) {
            const uid = parseInt(userId, 10) || 0;
            const clean = String(name || '').trim().slice(0, 40);
            if (!clean) throw new Error('Label name is required');
            const existing = await db.get(
                `SELECT * FROM ${T_LABELS} WHERE user_id = ? AND LOWER(name) = LOWER(?)`, [uid, clean]
            );
            if (existing) return existing;
            const res = await db.run(
                `INSERT INTO ${T_LABELS} (user_id, name, color) VALUES (?, ?, ?)`,
                [uid, clean, String(color || '#7c3aed').slice(0, 16)]
            );
            return await db.get(`SELECT * FROM ${T_LABELS} WHERE id = ?`, [res.lastID]);
        },

        async updateLabel(id, userId, { name, color }) {
            const label = await this.findLabel(id, userId);
            if (!label) return null;
            const fields = [];
            const params = [];
            if (name !== undefined) { fields.push('name = ?'); params.push(String(name).trim().slice(0, 40)); }
            if (color !== undefined) { fields.push('color = ?'); params.push(String(color).slice(0, 16)); }
            if (fields.length === 0) return label;
            params.push(label.id);
            await db.run(`UPDATE ${T_LABELS} SET ${fields.join(', ')} WHERE id = ?`, params);
            return await db.get(`SELECT * FROM ${T_LABELS} WHERE id = ?`, [label.id]);
        },

        async deleteLabel(id, userId) {
            const label = await this.findLabel(id, userId);
            if (!label) return false;
            await db.run(`DELETE FROM ${T_EMAIL_LABELS} WHERE label_id = ?`, [label.id]);
            await db.run(`DELETE FROM ${T_LABELS} WHERE id = ?`, [label.id]);
            return true;
        },

        async findLabelByName(userId, name) {
            return await db.get(
                `SELECT * FROM ${T_LABELS} WHERE user_id = ? AND LOWER(name) = LOWER(?)`,
                [parseInt(userId, 10) || 0, String(name || '').trim()]
            );
        },

        async addLabelToEmails(emailIds, labelId) {
            const lid = parseInt(labelId, 10) || 0;
            for (const raw of emailIds || []) {
                const eid = parseInt(raw, 10) || 0;
                if (!eid || !lid) continue;
                const existing = await db.get(
                    `SELECT id FROM ${T_EMAIL_LABELS} WHERE email_id = ? AND label_id = ?`, [eid, lid]
                );
                if (!existing) {
                    await db.run(`INSERT INTO ${T_EMAIL_LABELS} (email_id, label_id) VALUES (?, ?)`, [eid, lid]);
                }
            }
        },

        async removeLabelFromEmails(emailIds, labelId) {
            const list = (emailIds || []).map(n => parseInt(n, 10)).filter(n => n > 0);
            const lid = parseInt(labelId, 10) || 0;
            if (list.length === 0 || !lid) return;
            const ph = list.map(() => '?').join(', ');
            await db.run(`DELETE FROM ${T_EMAIL_LABELS} WHERE label_id = ? AND email_id IN (${ph})`, [lid, ...list]);
        },

        // { emailId: [ {id, name, color} ] } for a page of listed messages — ONE query, not N.
        /**
         * Labels to decorate a page of messages with — THIS user's labels only.
         *
         * A label is per-user (T_LABELS.user_id) but the junction is per-message, and two accounts can
         * legitimately be parties to the SAME row: every un-backfilled (user_id = 0) row is served to
         * all of them. Without a user predicate this join therefore rendered another account's private
         * label NAMES ("Abogado", "Ofertas de trabajo") in this one's listing. userId is REQUIRED — a
         * missing one returns nothing rather than everything.
         */
        async getLabelsForEmails(emailIds, userId) {
            const uid = parseInt(userId, 10) || 0;
            if (uid <= 0) return {};
            const list = (emailIds || []).map(n => parseInt(n, 10)).filter(n => n > 0);
            if (list.length === 0) return {};
            const ph = list.map(() => '?').join(', ');
            const rows = await db.all(`
                SELECT el.email_id, l.id, l.name, l.color
                FROM ${T_EMAIL_LABELS} el
                JOIN ${T_LABELS} l ON l.id = el.label_id
                WHERE el.email_id IN (${ph}) AND l.user_id = ?
            `, [...list, uid]);
            const map = {};
            for (const r of rows) {
                if (!map[r.email_id]) map[r.email_id] = [];
                map[r.email_id].push({ id: r.id, name: r.name, color: r.color });
            }
            return map;
        },

        // --- Per-user preferences (signature, vacation auto-reply) --------------

        async getPrefs(userId) {
            const uid = parseInt(userId, 10) || 0;
            try {
                const row = await db.get(`SELECT prefs FROM ${T_PREFS} WHERE user_id = ?`, [uid]);
                if (!row || !row.prefs) return {};
                const parsed = JSON.parse(row.prefs);
                return (parsed && typeof parsed === 'object') ? parsed : {};
            } catch (e) {
                return {};
            }
        },

        async setPrefs(userId, prefsObj) {
            const uid = parseInt(userId, 10) || 0;
            const json = JSON.stringify(prefsObj || {});
            const existing = await db.get(`SELECT id FROM ${T_PREFS} WHERE user_id = ?`, [uid]);
            if (existing) {
                await db.run(`UPDATE ${T_PREFS} SET prefs = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [json, uid]);
            } else {
                await db.run(`INSERT INTO ${T_PREFS} (user_id, prefs) VALUES (?, ?)`, [uid, json]);
            }
            return await this.getPrefs(uid);
        },

        async getPendingScheduled() {
            return await db.all(`
                SELECT * FROM ${T_EMAILS}
                WHERE is_sent = 0 AND is_draft = 0 AND is_trash = 0
                AND scheduled_at IS NOT NULL AND scheduled_at <= ?
            `, [new Date().toISOString()]);
        },

        // --- Outbound retry queue ---------------------------------------------

        async getPendingRetries() {
            return await db.all(`
                SELECT * FROM ${T_EMAILS}
                WHERE delivery_status = 'retry'
                AND next_attempt_at IS NOT NULL
                AND next_attempt_at <= ?
            `, [new Date().toISOString()]);
        },

        async markRetry(id, attempts, nextAttemptAt, lastError) {
            return await db.run(`
                UPDATE ${T_EMAILS}
                SET delivery_status = 'retry', delivery_attempts = ?, next_attempt_at = ?, last_error = ?
                WHERE id = ?
            `, [attempts, nextAttemptAt, lastError ? String(lastError).slice(0, 1000) : null, id]);
        },

        async markFailed(id, attempts, lastError) {
            return await db.run(`
                UPDATE ${T_EMAILS}
                SET delivery_status = 'failed', delivery_attempts = ?, next_attempt_at = NULL, last_error = ?
                WHERE id = ?
            `, [attempts, lastError ? String(lastError).slice(0, 1000) : null, id]);
        },

        async markSent(id) {
            return await db.run(`
                UPDATE ${T_EMAILS}
                SET delivery_status = 'sent', next_attempt_at = NULL, last_error = NULL
                WHERE id = ?
            `, [id]);
        },

        async getAttachments(emailId) {
            return await db.all(`SELECT * FROM ${T_ATTACH} WHERE email_id = ?`, [emailId]);
        },

        // { emailId: [attachment rows] } for a whole thread in ONE query (the reading pane previously
        // only ever saw the representative message's attachments).
        async getAttachmentsForEmails(emailIds) {
            const list = (emailIds || []).map(n => parseInt(n, 10)).filter(n => n > 0);
            if (list.length === 0) return {};
            const ph = list.map(() => '?').join(', ');
            const rows = await db.all(`SELECT * FROM ${T_ATTACH} WHERE email_id IN (${ph})`, list);
            const map = {};
            for (const r of rows) {
                if (!map[r.email_id]) map[r.email_id] = [];
                map[r.email_id].push(r);
            }
            return map;
        },

        // Look up a single attachment by id (replaces the raw email_attachments query in index.js).
        async getAttachmentById(fileId) {
            return await db.get(`SELECT * FROM ${T_ATTACH} WHERE id = ?`, [fileId]);
        }
    };

    return Email;
};

// THE address-list parser, exported on the factory so index.js does not have to grow a second one.
module.exports.splitAddressList = splitAddressList;
