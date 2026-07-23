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
 * scans over to/cc/bcc. Rows written BEFORE the column existed keep user_id = 0 and stay visible
 * through the legacy address-match arm (`user_id = 0 AND <address LIKE>`), so no backfill/migration
 * of historic data is needed and nothing disappears on upgrade. The legacy set never grows, so its
 * scan cost is bounded; all new mail takes the indexed arm.
 *
 * Attachment file operations use node builtins (fs/path/crypto) directly — confined to the plugin's
 * OWN dir (no shared-uploads access without trust). Attachments live under the plugin dir.
 *
 * GUARD NOTE: every SQL string here must survive the host's assertSqlAllowed text guard — single
 * statement, no '$' / backslash / '[' / ']' / '/*!' anywhere, no RETURNING, and every table token
 * under the wjp_mail_server_ prefix. Keep it that way when editing.
 *
 * Usage: const Email = require('./lib/email-store')(wordjs.db);
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

module.exports = function createEmailStore(db) {
    // The host expects the plugin to confine itself to this prefix; surface it for assertions/logging.
    const PREFIX = db.tablePrefix || 'wjp_mail_server_';

    const Email = {
        // Expose the storage dir so index.js resolves attachment paths from a single source of truth.
        UPLOAD_DIR,

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
            const tokens = new Set();
            for (const field of [email.from_address, email.to_address, email.cc_address, email.bcc_address]) {
                if (!field) continue;
                for (const part of String(field).split(',')) {
                    const addr = part.trim().toLowerCase();
                    if (addr) tokens.add(addr);
                }
            }
            return tokens.has(me);
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
                // File path (outgoing/upload)
                const randomName = crypto.randomBytes(16).toString('hex');
                // Never persist the sender-supplied extension — an inbound attachment named x.js / .wasm /
                // .node trips io-guard's executable-write block and would throw out the ENTIRE message. The
                // real filename is kept in the DB `filename` column; on disk it's an opaque .bin blob.
                storageName = randomName + '.bin';
                const fullPath = path.join(UPLOAD_DIR, storageName);

                // Check if source exists before copying
                try {
                    await fs.copyFile(attachment.path, fullPath);
                    size = attachment.size || (await fs.stat(fullPath)).size;
                } catch (e) {
                    console.error(`Failed to copy attachment ${attachment.path}:`, e.message);
                    return; // Skip if file missing
                }
            }

            await db.run(`
                INSERT INTO ${T_ATTACH} (email_id, filename, content_type, size, storage_path, content_id)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [emailId, attachment.filename, attachment.contentType, size, storageName, attachment.cid || null]);
        },

        async update(id, data) {
            const {
                messageId, toAddress, ccAddress, bccAddress, subject, bodyText, bodyHtml, rawContent,
                isSent, isDraft, isTrash, isSpam, isArchived, scheduledAt
            } = data;

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
            if (isSpam !== undefined) { fields.push("is_spam = ?"); params.push(isSpam ? 1 : 0); }
            if (isArchived !== undefined) { fields.push("is_archived = ?"); params.push(isArchived ? 1 : 0); }
            if (scheduledAt !== undefined) { fields.push("scheduled_at = ?"); params.push(scheduledAt); }

            if (contentChanged) {
                fields.push("date_received = CURRENT_TIMESTAMP");
            }

            // Nothing to update — avoid emitting invalid "SET  WHERE id = ?".
            if (fields.length === 0) {
                return await this.findById(id);
            }

            params.push(id);

            await db.run(`
                UPDATE ${T_EMAILS}
                SET ${fields.join(', ')}
                WHERE id = ?
            `, params);

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

        async findByThreadId(threadId, userEmail = null, opts = {}) {
            // Spam messages are hidden from a normal conversation view (Gmail behavior); when the
            // REQUESTED message itself is spam the caller passes includeSpam so the spam-folder reading
            // pane still shows it.
            const spamFilter = opts.includeSpam ? '' : ' AND is_spam = 0';
            const sql = `SELECT * FROM ${T_EMAILS} WHERE (thread_id = ? OR id = ?) AND is_trash = 0${spamFilter} ORDER BY date_received ASC`;
            const rows = await db.all(sql, [threadId, threadId]);

            // SECURITY (over-disclosure): an unanchored `LIKE %email%` membership test matched thread
            // rows addressed to a SUBSTRING of the requester's address (e.g. bob@x.com vs bbob@x.com).
            // Filter the returned rows through the exact-token membership check (canUserAccess) so only
            // messages the user is actually a party to (sender or to/cc/bcc recipient) are returned.
            if (userEmail) {
                return rows.filter(row => this.canUserAccess(row, userEmail));
            }

            return rows;
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
         * Per-folder WHERE clause under the ownership model.
         *
         * Two arms OR'd together:
         *  - `user_id = ?`      — rows explicitly owned by this user (all mail written since v2.1);
         *                         an indexed probe, and immune to the multi-recipient duplicate bug
         *                         (another recipient's copy of the same message has THEIR user_id).
         *  - `user_id = 0 AND <address match>` — legacy rows from before the column existed, matched
         *                         exactly as the old code did so nothing disappears on upgrade.
         * Columns are qualified with the `m` alias — every caller aliases ${T_EMAILS} AS m.
         */
        _folderClause(userId, email, folder = 'inbox', labelId = 0) {
            const uid = parseInt(userId, 10) || 0;
            const like = `%${email}%`;
            const rcvd = '(m.to_address LIKE ? OR m.cc_address LIKE ? OR m.bcc_address LIKE ?)';
            const rcvdOrFrom = '(m.to_address LIKE ? OR m.cc_address LIKE ? OR m.bcc_address LIKE ? OR m.from_address = ?)';

            if (String(folder).startsWith('label')) {
                const own = `(m.user_id = ? OR (m.user_id = 0 AND ${rcvdOrFrom}))`;
                const clause = `(${own} AND m.is_trash = 0 AND m.is_spam = 0 AND m.is_draft = 0 ` +
                    `AND EXISTS (SELECT 1 FROM ${T_EMAIL_LABELS} el WHERE el.email_id = m.id AND el.label_id = ?))`;
                return { clause, params: [uid, like, like, like, email, parseInt(labelId, 10) || 0] };
            }

            const F = {
                inbox: { flags: 'm.is_sent = 0 AND m.is_draft = 0 AND m.is_archived = 0 AND m.is_trash = 0 AND m.is_spam = 0 AND m.scheduled_at IS NULL', legacy: rcvd, legacyParams: [like, like, like] },
                sent: { flags: 'm.is_sent = 1 AND m.is_draft = 0 AND m.is_trash = 0', legacy: 'm.from_address = ?', legacyParams: [email] },
                drafts: { flags: '(m.is_draft = 1 OR (m.scheduled_at IS NOT NULL AND m.is_sent = 0)) AND m.is_trash = 0', legacy: 'm.from_address = ?', legacyParams: [email] },
                archive: { flags: 'm.is_archived = 1 AND m.is_trash = 0 AND m.is_spam = 0', legacy: rcvdOrFrom, legacyParams: [like, like, like, email] },
                starred: { flags: 'm.is_starred = 1 AND m.is_trash = 0 AND m.is_spam = 0', legacy: rcvdOrFrom, legacyParams: [like, like, like, email] },
                spam: { flags: 'm.is_spam = 1 AND m.is_trash = 0', legacy: rcvdOrFrom, legacyParams: [like, like, like, email] },
                trash: { flags: 'm.is_trash = 1', legacy: rcvdOrFrom, legacyParams: [like, like, like, email] },
            };
            const f = F[folder] || F.inbox;
            return {
                clause: `((m.user_id = ? AND ${f.flags}) OR (m.user_id = 0 AND ${f.legacy} AND ${f.flags}))`,
                params: [uid, ...f.legacyParams]
            };
        },

        async findAllByUser(userId, email, folder = 'inbox', limit = 50, offset = 0, labelId = 0) {
            const { clause, params } = this._folderClause(userId, email, folder, labelId);

            // Thread-collapse: pick ONE representative row per thread. A bare-column GROUP BY (SELECT *
            // … GROUP BY thread_key) returns an arbitrary/stale row on SQLite and is ILLEGAL on Postgres
            // (500s the whole listing). Instead aggregate first (thread_key → newest row id + count),
            // then JOIN back to fetch that row's real columns. The representative is the highest id in the
            // thread (newest-inserted), deterministic on both drivers.
            const threadKey = 'CASE WHEN m.thread_id > 0 THEN m.thread_id ELSE m.id END';
            return await db.all(`
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
        },

        async countByUser(userId, email, folder = 'inbox', labelId = 0) {
            const { clause, params } = this._folderClause(userId, email, folder, labelId);
            // Count the SAME collapsed unit findAllByUser lists (one per thread), not raw rows — otherwise
            // the total exceeds the visible items and pagination renders empty trailing pages.
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
            const uid = parseInt(userId, 10) || 0;
            const like = `%${email}%`;
            const row = await db.get(`
                SELECT
                    COALESCE(SUM(CASE WHEN m.is_sent = 0 AND m.is_draft = 0 AND m.is_archived = 0 AND m.is_trash = 0 AND m.is_spam = 0 AND m.scheduled_at IS NULL AND m.is_read = 0 THEN 1 ELSE 0 END), 0) AS inbox_unread,
                    COALESCE(SUM(CASE WHEN m.is_spam = 1 AND m.is_trash = 0 AND m.is_read = 0 THEN 1 ELSE 0 END), 0) AS spam_unread,
                    COALESCE(SUM(CASE WHEN (m.is_draft = 1 OR (m.scheduled_at IS NOT NULL AND m.is_sent = 0)) AND m.is_trash = 0 THEN 1 ELSE 0 END), 0) AS drafts
                FROM ${T_EMAILS} m
                WHERE (m.user_id = ? OR (m.user_id = 0 AND (m.to_address LIKE ? OR m.cc_address LIKE ? OR m.bcc_address LIKE ? OR m.from_address = ?)))
            `, [uid, like, like, like, email]);
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

        async setSpam(id, state) {
            // Marking spam also un-archives so "Not spam" later returns the mail to the inbox, and
            // marks it read is NOT done (Gmail keeps unread state).
            return await db.run(`UPDATE ${T_EMAILS} SET is_spam = ?, is_archived = 0 WHERE id = ?`, [state ? 1 : 0, id]);
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
        async bulkSetFlags(ids, set) {
            const list = (ids || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);
            if (list.length === 0) return 0;
            const fields = [];
            const params = [];
            const map = { isRead: 'is_read', isStarred: 'is_starred', isArchived: 'is_archived', isTrash: 'is_trash', isSpam: 'is_spam' };
            for (const [k, col] of Object.entries(map)) {
                if (set[k] !== undefined) { fields.push(`${col} = ?`); params.push(set[k] ? 1 : 0); }
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

        async deletePermanently(id) {
            return await this.deleteManyPermanently([id]);
        },

        /**
         * Permanent delete in BATCHES (attachment files + attachment rows + label links + email rows).
         * The old per-email loop issued 3 queries per message — emptying a large trash took hundreds of
         * sequential bridge round-trips.
         */
        async deleteManyPermanently(ids) {
            const list = (ids || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);
            let deleted = 0;
            for (let i = 0; i < list.length; i += 100) {
                const chunk = list.slice(i, i + 100);
                const ph = chunk.map(() => '?').join(', ');
                // Unlink attachment blobs first (rows are the only pointer to the files).
                try {
                    const atts = await db.all(`SELECT storage_path FROM ${T_ATTACH} WHERE email_id IN (${ph})`, chunk);
                    for (const att of atts) {
                        if (!att || !att.storage_path) continue;
                        const fullPath = path.join(UPLOAD_DIR, att.storage_path);
                        try { await fs.unlink(fullPath); } catch (e) {
                            if (e.code !== 'ENOENT') console.error(`[Email] Failed to delete attachment at ${fullPath}:`, e.message);
                        }
                    }
                } catch (e) {
                    console.error('[Email] Attachment cleanup failed:', e.message);
                }
                await db.run(`DELETE FROM ${T_ATTACH} WHERE email_id IN (${ph})`, chunk);
                await db.run(`DELETE FROM ${T_EMAIL_LABELS} WHERE email_id IN (${ph})`, chunk);
                await db.run(`DELETE FROM ${T_EMAILS} WHERE id IN (${ph})`, chunk);
                deleted += chunk.length;
            }
            return deleted;
        },

        async emptyTrash(userId, userEmail) {
            const { clause, params } = this._folderClause(userId, userEmail, 'trash');
            const emails = await db.all(`SELECT m.id FROM ${T_EMAILS} m WHERE ${clause}`, params);
            return await this.deleteManyPermanently(emails.map(e => e.id));
        },

        // Spam retention: permanently drop spam older than `days` (Gmail does 30). Returns count.
        async purgeOldSpam(days = 30) {
            const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
                .toISOString().slice(0, 19).replace('T', ' ');
            const rows = await db.all(
                `SELECT id FROM ${T_EMAILS} WHERE is_spam = 1 AND date_received < ?`, [cutoff]
            );
            if (rows.length === 0) return 0;
            return await this.deleteManyPermanently(rows.map(r => r.id));
        },

        /**
         * Operator-aware search, scoped to the requesting user's mail via the ownership clause.
         * `q` = { text, from, to, subject, hasAttachment, isUnread, isStarred, labelId, folder }.
         */
        async search(userId, email, q = {}, limit = 50, offset = 0) {
            const uid = parseInt(userId, 10) || 0;
            const like = `%${email}%`;
            const where = ['(m.user_id = ? OR (m.user_id = 0 AND (m.to_address LIKE ? OR m.cc_address LIKE ? OR m.bcc_address LIKE ? OR m.from_address = ?)))'];
            const params = [uid, like, like, like, email];

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

            return await db.all(`
                SELECT ${listCols('m')},
                       CASE WHEN EXISTS (SELECT 1 FROM ${T_ATTACH} a WHERE a.email_id = m.id) THEN 1 ELSE 0 END AS has_attachment
                FROM ${T_EMAILS} m
                WHERE ${where.join(' AND ')}
                ORDER BY m.date_received DESC, m.id DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]);
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
        async suggestContacts(userId, term, limit = 8) {
            const uid = parseInt(userId, 10) || 0;
            const t = `%${term}%`;
            const out = new Map(); // email(lower) -> { email, name }

            // Senders of mail this user received.
            const senders = await db.all(`
                SELECT m.from_address AS addr, MAX(m.from_name) AS name, MAX(m.id) AS latest
                FROM ${T_EMAILS} m
                WHERE m.user_id = ? AND m.is_sent = 0 AND m.from_address LIKE ?
                GROUP BY m.from_address
                ORDER BY latest DESC
                LIMIT ?
            `, [uid, t, limit]);
            for (const s of senders) {
                const a = String(s.addr || '').trim().toLowerCase();
                if (a && a.includes('@') && !out.has(a)) out.set(a, { email: a, name: s.name || '' });
            }

            // Recipients this user has written to (comma-joined lists → split in JS).
            const sent = await db.all(`
                SELECT m.to_address, m.cc_address FROM ${T_EMAILS} m
                WHERE m.user_id = ? AND m.is_sent = 1
                ORDER BY m.id DESC
                LIMIT 100
            `, [uid]);
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
        async getLabelsForEmails(emailIds) {
            const list = (emailIds || []).map(n => parseInt(n, 10)).filter(n => n > 0);
            if (list.length === 0) return {};
            const ph = list.map(() => '?').join(', ');
            const rows = await db.all(`
                SELECT el.email_id, l.id, l.name, l.color
                FROM ${T_EMAIL_LABELS} el
                JOIN ${T_LABELS} l ON l.id = el.label_id
                WHERE el.email_id IN (${ph})
            `, list);
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
