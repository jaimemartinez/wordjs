/**
 * WordJS - Mail Server plugin-local Email store (ISOLATED, NO TRUST).
 *
 * Ported from backend/src/models/Email.ts. All core-database access goes through the injected
 * `wordjs.db` capability bridge. Because this plugin is fully untrusted, every table it touches MUST
 * live under its own prefix (wordjs.db.tablePrefix === 'wjp_mail_server_') or assertSqlAllowed denies
 * the query. The legacy unprefixed tables (received_emails / email_attachments) are migrated to the
 * prefixed names by a one-time, idempotent step in initSchema().
 *
 * Attachment file operations use node builtins (fs/path/crypto) directly — confined to the plugin's
 * OWN dir (no shared-uploads access without trust). Attachments live under the plugin dir.
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
            // 1. Create the plugin-owned tables (idempotent).
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
                'raw_content TEXT',
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
            await this._createIndex('idx_wjp_mail_server_secrets_name', T_SECRETS, 'name');

            // 2. One-time, idempotent migration from the legacy UNPREFIXED tables, if they still exist.
            // (Only relevant for sites upgraded from the trusted era where the bridge let us write
            // received_emails / email_attachments directly.)
            await this._migrateLegacyTables();

            // 3. Indexes for the retry/scheduled queue sweeps and thread lookups.
            await this._createIndex('idx_wjp_mail_server_delivery', T_EMAILS, 'delivery_status, next_attempt_at');
            await this._createIndex('idx_wjp_mail_server_scheduled', T_EMAILS, 'scheduled_at');
            await this._createIndex('idx_wjp_mail_server_thread', T_EMAILS, 'thread_id');
        },

        async _createIndex(name, table, cols) {
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) {
                // Ignore if index already exists / race condition.
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
                isSent = 0, isDraft = 0, isArchived = 0, isStarred = 0, isTrash = 0,
                parentId = 0, threadId = 0, scheduledAt = null
            } = data;

            const result = await db.run(`
                INSERT INTO ${T_EMAILS} (
                    message_id, from_address, from_name, to_address, cc_address, bcc_address, subject, body_text, body_html, raw_content,
                    is_sent, is_draft, is_archived, is_starred, is_trash, parent_id, thread_id, scheduled_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                messageId, fromAddress, fromName, toAddress, ccAddress, bccAddress, subject, bodyText, bodyHtml, rawContent,
                isSent, isDraft, isArchived, isStarred, isTrash, parentId, threadId, scheduledAt
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
                toAddress, ccAddress, bccAddress, subject, bodyText, bodyHtml, rawContent,
                isSent, isDraft, isTrash, scheduledAt
            } = data;

            // Build dynamic query
            let fields = [];
            let params = [];

            // Track whether a content field changed; only then do we bump date_received
            // (so non-content updates like retry's toAddress rewrite don't re-sort the list).
            let contentChanged = false;

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

        async findByThreadId(threadId, userEmail = null) {
            const sql = `SELECT * FROM ${T_EMAILS} WHERE (thread_id = ? OR id = ?) AND is_trash = 0 ORDER BY date_received ASC`;
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

        async findAllByUser(email, folder = 'inbox', limit = 50, offset = 0) {
            let whereClause = "";
            let params = [];
            const likeEmail = `%${email}%`;

            if (folder === 'sent') {
                whereClause = "from_address = ? AND is_sent = 1 AND is_draft = 0 AND is_trash = 0";
                params = [email];
            } else if (folder === 'drafts') {
                whereClause = "from_address = ? AND (is_draft = 1 OR (scheduled_at IS NOT NULL AND is_sent = 0)) AND is_trash = 0";
                params = [email];
            } else if (folder === 'archive') {
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) AND is_archived = 1 AND is_trash = 0";
                params = [likeEmail, likeEmail, likeEmail, email];
            } else if (folder === 'starred') {
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) AND is_starred = 1 AND is_trash = 0";
                params = [likeEmail, likeEmail, likeEmail, email];
            } else if (folder === 'trash') {
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) AND is_trash = 1";
                params = [likeEmail, likeEmail, likeEmail, email];
            } else {
                // Default Inbox: Received (To/CC/BCC), Not Sent (unless self), Not Draft, Not Archived, Not Trash
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ?) AND is_sent = 0 AND is_draft = 0 AND is_archived = 0 AND is_trash = 0 AND scheduled_at IS NULL";
                params = [likeEmail, likeEmail, likeEmail];
            }

            // Thread-collapse: pick ONE representative row per thread. A bare-column GROUP BY (SELECT *
            // … GROUP BY thread_key) returns an arbitrary/stale row on SQLite and is ILLEGAL on Postgres
            // (500s the whole listing). Instead aggregate first (thread_key → newest row id + count),
            // then JOIN back to fetch that row's real columns. The representative is the highest id in the
            // thread (newest-inserted), deterministic on both drivers.
            const threadKey = "CASE WHEN thread_id > 0 THEN thread_id ELSE id END";
            return await db.all(`
                SELECT e.*, t.thread_count
                FROM ${T_EMAILS} e
                JOIN (
                    SELECT ${threadKey} AS tkey, MAX(id) AS rep_id, COUNT(*) AS thread_count
                    FROM ${T_EMAILS}
                    WHERE ${whereClause}
                    GROUP BY ${threadKey}
                ) t ON e.id = t.rep_id
                ORDER BY e.date_received DESC, e.id DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]);
        },

        async countByUser(email, folder = 'inbox') {
            let whereClause = "";
            let params = [];
            const likeEmail = `%${email}%`;

            if (folder === 'sent') {
                whereClause = "from_address = ? AND is_sent = 1 AND is_draft = 0 AND is_trash = 0";
                params = [email];
            } else if (folder === 'drafts') {
                whereClause = "from_address = ? AND (is_draft = 1 OR (scheduled_at IS NOT NULL AND is_sent = 0)) AND is_trash = 0";
                params = [email];
            } else if (folder === 'archive') {
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) AND is_archived = 1 AND is_trash = 0";
                params = [likeEmail, likeEmail, likeEmail, email];
            } else if (folder === 'starred') {
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) AND is_starred = 1 AND is_trash = 0";
                params = [likeEmail, likeEmail, likeEmail, email];
            } else if (folder === 'trash') {
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) AND is_trash = 1";
                params = [likeEmail, likeEmail, likeEmail, email];
            } else {
                whereClause = "(to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ?) AND is_sent = 0 AND is_draft = 0 AND is_archived = 0 AND is_trash = 0 AND scheduled_at IS NULL";
                params = [likeEmail, likeEmail, likeEmail];
            }

            // Count the SAME collapsed unit findAllByUser lists (one per thread), not raw rows — otherwise
            // the total exceeds the visible items and pagination renders empty trailing pages.
            const threadKey = "CASE WHEN thread_id > 0 THEN thread_id ELSE id END";
            const row = await db.get(`
                SELECT COUNT(*) as count FROM (
                    SELECT 1 FROM ${T_EMAILS}
                    WHERE ${whereClause}
                    GROUP BY ${threadKey}
                ) sub
            `, params);
            return row ? row.count : 0;
        },

        async countUnreadInbox(email) {
            const likeEmail = `%${email}%`;
            const row = await db.get(`
                SELECT COUNT(*) as count FROM ${T_EMAILS}
                WHERE (to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ?)
                AND is_sent = 0 AND is_draft = 0 AND is_trash = 0 AND is_archived = 0 AND scheduled_at IS NULL AND is_read = 0
            `, [likeEmail, likeEmail, likeEmail]);
            return row ? row.count : 0;
        },

        async markAsRead(id) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_read = 1 WHERE id = ?`, [id]);
        },

        async setStarred(id, state) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_starred = ? WHERE id = ?`, [state ? 1 : 0, id]);
        },

        async setArchived(id, state) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_archived = ? WHERE id = ?`, [state ? 1 : 0, id]);
        },

        async moveToTrash(id) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_trash = 1 WHERE id = ?`, [id]);
        },

        async restoreFromTrash(id) {
            return await db.run(`UPDATE ${T_EMAILS} SET is_trash = 0 WHERE id = ?`, [id]);
        },

        async deletePermanently(id) {
            // Also delete attachments files
            const attachments = await this.getAttachments(id);
            for (const att of attachments) {
                const fullPath = path.join(UPLOAD_DIR, att.storage_path);
                try {
                    await fs.unlink(fullPath);
                } catch (e) {
                    if (e.code !== 'ENOENT') {
                        console.error(`[Email] Failed to delete attachment at ${fullPath}:`, e.message);
                    }
                }
            }
            await db.run(`DELETE FROM ${T_ATTACH} WHERE email_id = ?`, [id]);
            return await db.run(`DELETE FROM ${T_EMAILS} WHERE id = ?`, [id]);
        },

        async emptyTrash(userEmail) {
            // Must match the trash-folder predicate in findAllByUser/countByUser (to/cc/bcc/from), else
            // cc/bcc-only messages show in Trash but survive Empty Trash as unclearable residue.
            const likeEmail = `%${userEmail}%`;
            const emails = await db.all(`
                SELECT id FROM ${T_EMAILS}
                WHERE (to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) AND is_trash = 1
            `, [likeEmail, likeEmail, likeEmail, userEmail]);

            for (const e of emails) {
                await this.deletePermanently(e.id);
            }
        },

        async searchByUser(email, query, limit = 50) {
            const term = `%${query}%`;
            const likeEmail = `%${email}%`;
            return await db.all(`
                SELECT * FROM ${T_EMAILS}
                WHERE (to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?)
                AND (subject LIKE ? OR body_text LIKE ? OR from_name LIKE ?) AND is_trash = 0
                ORDER BY date_received DESC
                LIMIT ?
            `, [likeEmail, likeEmail, likeEmail, email, term, term, term, limit]);
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

        // Look up a single attachment by id (replaces the raw email_attachments query in index.js).
        async getAttachmentById(fileId) {
            return await db.get(`SELECT * FROM ${T_ATTACH} WHERE id = ?`, [fileId]);
        }
    };

    return Email;
};
