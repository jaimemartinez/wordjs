/**
 * Server-administration data for the mail server: aliases / distribution lists, per-mailbox quotas,
 * storage usage, traffic statistics and the outbound queue.
 *
 * Kept apart from email-store.js on purpose: that file is the OWNERSHIP boundary of user mail (every
 * read composes the ownership predicate). Everything here is either admin-only (the routes are
 * registered `admin: true`) or an aggregate that returns no message content (usage of ONE user, read
 * by that user). The few row listings below (queue, recent activity) carry headers only — never a
 * body — and are only reachable by administrators.
 *
 * Every table is prefixed wjp_mail_server_ and every index NAME carries the prefix too: the host SQL
 * guard rejects a CREATE INDEX whose name does not, and _createIndex swallowing that error is how the
 * plugin once ran for months with no indexes at all.
 */
'use strict';

const T_EMAILS = 'wjp_mail_server_received_emails';
const T_ATTACH = 'wjp_mail_server_email_attachments';
const T_ALIASES = 'wjp_mail_server_aliases';
const T_MAILBOXES = 'wjp_mail_server_mailboxes';

const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const MAX_DESTINATIONS = 50;

function normalizeLocalPart(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return LOCAL_PART_RE.test(s) && !s.includes('..') ? s : '';
}

function normalizeDestinations(v) {
    const raw = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
    const out = [];
    for (const t of raw) {
        const a = String(t || '').trim().toLowerCase();
        if (!a) continue;
        if (a.length > 254 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(a)) {
            const err = new Error(`Invalid destination address: ${a.slice(0, 80)}`);
            err.code = 'mail_alias_bad_destination';
            throw err;
        }
        if (!out.includes(a)) out.push(a);
        if (out.length >= MAX_DESTINATIONS) break;
    }
    return out;
}

// A SQL datetime literal both SQLite (string compare) and Postgres/MySQL (cast) accept.
function sqlDate(d) {
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = function createAdminStore(db) {
    const store = {
        async initSchema() {
            await db.createTable(T_ALIASES, [
                'id INT_PK',
                'local_part TEXT',
                'destinations TEXT',
                'description TEXT',
                'enabled INT DEFAULT 1',
                'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            ]);
            await db.createTable(T_MAILBOXES, [
                'id INT_PK',
                'user_id INT DEFAULT 0',
                // -1 = inherit the site default (mail_quota_default_mb); 0 = unlimited.
                'quota_mb INT DEFAULT -1',
                'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP'
            ]);
            await this._index('wjp_mail_server_idx_alias_local', T_ALIASES, 'local_part');
            await this._index('wjp_mail_server_idx_mbx_user', T_MAILBOXES, 'user_id');
        },

        async _index(name, table, cols) {
            if (!name.startsWith('wjp_mail_server_')) throw new Error(`index name must carry the plugin prefix: ${name}`);
            try { await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`); }
            catch (e) {
                // Some drivers lack IF NOT EXISTS for indexes; a duplicate error IS the idempotency check.
                try { await db.run(`CREATE INDEX ${name} ON ${table} (${cols})`); } catch (e2) { /* exists */ }
            }
        },

        // --- Aliases / distribution lists ------------------------------------------------------

        async listAliases() {
            const rows = await db.all(`SELECT * FROM ${T_ALIASES} ORDER BY local_part ASC`);
            return rows.map(r => ({ ...r, enabled: Number(r.enabled) ? 1 : 0, destinations: String(r.destinations || '').split(',').filter(Boolean) }));
        },

        async findAliasByLocalPart(localPart) {
            const lp = normalizeLocalPart(localPart);
            if (!lp) return null;
            const r = await db.get(`SELECT * FROM ${T_ALIASES} WHERE local_part = ? AND enabled = 1`, [lp]);
            return r ? { ...r, destinations: String(r.destinations || '').split(',').filter(Boolean) } : null;
        },

        async saveAlias(id, data) {
            const localPart = normalizeLocalPart(data.localPart);
            if (!localPart) {
                const err = new Error('The alias name may only contain letters, digits, dots, dashes, underscores and +.');
                err.code = 'mail_alias_bad_name';
                throw err;
            }
            const destinations = normalizeDestinations(data.destinations);
            if (destinations.length === 0) {
                const err = new Error('Add at least one destination address.');
                err.code = 'mail_alias_no_destination';
                throw err;
            }
            const description = String(data.description || '').trim().slice(0, 200);
            const enabled = data.enabled === false || data.enabled === 0 ? 0 : 1;
            const clash = await db.get(`SELECT id FROM ${T_ALIASES} WHERE local_part = ?`, [localPart]);
            if (clash && (!id || Number(clash.id) !== Number(id))) {
                const err = new Error('An alias with that name already exists.');
                err.code = 'mail_alias_exists';
                throw err;
            }
            if (id) {
                await db.run(`UPDATE ${T_ALIASES} SET local_part = ?, destinations = ?, description = ?, enabled = ? WHERE id = ?`,
                    [localPart, destinations.join(','), description, enabled, parseInt(id, 10) || 0]);
                return await db.get(`SELECT * FROM ${T_ALIASES} WHERE id = ?`, [parseInt(id, 10) || 0]);
            }
            const r = await db.run(`INSERT INTO ${T_ALIASES} (local_part, destinations, description, enabled) VALUES (?, ?, ?, ?)`,
                [localPart, destinations.join(','), description, enabled]);
            return await db.get(`SELECT * FROM ${T_ALIASES} WHERE id = ?`, [r.lastID]);
        },

        async deleteAlias(id) {
            await db.run(`DELETE FROM ${T_ALIASES} WHERE id = ?`, [parseInt(id, 10) || 0]);
        },

        // --- Quotas + usage --------------------------------------------------------------------

        async getQuotaOverride(userId) {
            const r = await db.get(`SELECT quota_mb FROM ${T_MAILBOXES} WHERE user_id = ?`, [parseInt(userId, 10) || 0]);
            return r ? Number(r.quota_mb) : -1;
        },

        async listQuotaOverrides() {
            const rows = await db.all(`SELECT user_id, quota_mb FROM ${T_MAILBOXES}`);
            const map = {};
            for (const r of rows) map[r.user_id] = Number(r.quota_mb);
            return map;
        },

        async setQuotaOverride(userId, quotaMb) {
            const uid = parseInt(userId, 10) || 0;
            if (!(uid > 0)) throw new Error('Invalid user');
            let q = parseInt(quotaMb, 10);
            if (!Number.isFinite(q) || q < -1) q = -1;
            q = Math.min(q, 1024 * 1024);
            const existing = await db.get(`SELECT id FROM ${T_MAILBOXES} WHERE user_id = ?`, [uid]);
            if (existing) await db.run(`UPDATE ${T_MAILBOXES} SET quota_mb = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [q, uid]);
            else await db.run(`INSERT INTO ${T_MAILBOXES} (user_id, quota_mb) VALUES (?, ?)`, [uid, q]);
            return q;
        },

        /** Bytes + message counts of ONE mailbox (aggregates only — no content). */
        async usageOf(userId) {
            const uid = parseInt(userId, 10) || 0;
            if (!(uid > 0)) return { bytes: 0, messages: 0 };
            const [m, a] = await Promise.all([
                db.get(`
                    SELECT COUNT(*) AS messages,
                           COALESCE(SUM(COALESCE(LENGTH(body_text), 0) + COALESCE(LENGTH(body_html), 0) + COALESCE(LENGTH(raw_content), 0)), 0) AS bytes
                    FROM ${T_EMAILS} WHERE user_id = ?`, [uid]),
                db.get(`
                    SELECT COALESCE(SUM(a.size), 0) AS bytes
                    FROM ${T_ATTACH} a JOIN ${T_EMAILS} e ON e.id = a.email_id
                    WHERE e.user_id = ?`, [uid])
            ]);
            return {
                bytes: (Number(m && m.bytes) || 0) + (Number(a && a.bytes) || 0),
                messages: Number(m && m.messages) || 0,
            };
        },

        /** Per-mailbox aggregates for the admin "Mailboxes" table, keyed by user_id. */
        async usageByUser() {
            const [rows, att] = await Promise.all([
                db.all(`
                    SELECT user_id,
                           COUNT(*) AS messages,
                           COALESCE(SUM(CASE WHEN is_sent = 0 AND is_draft = 0 AND is_trash = 0 AND is_spam = 0 AND is_read = 0 THEN 1 ELSE 0 END), 0) AS unread,
                           COALESCE(SUM(CASE WHEN is_sent = 1 THEN 1 ELSE 0 END), 0) AS sent,
                           COALESCE(SUM(CASE WHEN is_spam = 1 AND is_trash = 0 THEN 1 ELSE 0 END), 0) AS spam,
                           COALESCE(SUM(COALESCE(LENGTH(body_text), 0) + COALESCE(LENGTH(body_html), 0) + COALESCE(LENGTH(raw_content), 0)), 0) AS bytes,
                           MAX(date_received) AS last_activity
                    FROM ${T_EMAILS}
                    WHERE user_id > 0
                    GROUP BY user_id`),
                db.all(`
                    SELECT e.user_id, COALESCE(SUM(a.size), 0) AS bytes
                    FROM ${T_ATTACH} a JOIN ${T_EMAILS} e ON e.id = a.email_id
                    WHERE e.user_id > 0
                    GROUP BY e.user_id`)
            ]);
            const map = {};
            for (const r of rows) {
                map[r.user_id] = {
                    messages: Number(r.messages) || 0, unread: Number(r.unread) || 0, sent: Number(r.sent) || 0,
                    spam: Number(r.spam) || 0, bytes: Number(r.bytes) || 0, lastActivity: r.last_activity || null,
                };
            }
            for (const a of att) {
                if (!map[a.user_id]) map[a.user_id] = { messages: 0, unread: 0, sent: 0, spam: 0, bytes: 0, lastActivity: null };
                map[a.user_id].bytes += Number(a.bytes) || 0;
            }
            return map;
        },

        // --- Statistics ------------------------------------------------------------------------

        async overview(days = 14) {
            const since = new Date(Date.now() - days * 86400000);
            since.setUTCHours(0, 0, 0, 0);
            const [totals, recentRows, att] = await Promise.all([
                db.get(`
                    SELECT COUNT(*) AS messages,
                           COALESCE(SUM(CASE WHEN is_sent = 1 THEN 1 ELSE 0 END), 0) AS sent,
                           COALESCE(SUM(CASE WHEN is_sent = 0 AND is_draft = 0 THEN 1 ELSE 0 END), 0) AS received,
                           COALESCE(SUM(CASE WHEN is_spam = 1 AND is_trash = 0 THEN 1 ELSE 0 END), 0) AS spam,
                           COALESCE(SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                           COALESCE(SUM(CASE WHEN delivery_status = 'retry' THEN 1 ELSE 0 END), 0) AS retrying,
                           COALESCE(SUM(CASE WHEN is_sent = 0 AND is_draft = 0 AND is_trash = 0 AND scheduled_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS scheduled,
                           COALESCE(SUM(COALESCE(LENGTH(body_text), 0) + COALESCE(LENGTH(body_html), 0) + COALESCE(LENGTH(raw_content), 0)), 0) AS bytes
                    FROM ${T_EMAILS}`),
                // Bucketed in JS: date functions differ per driver, a plain range scan does not.
                db.all(`
                    SELECT date_received, is_sent, is_draft, is_spam, delivery_status
                    FROM ${T_EMAILS}
                    WHERE date_received >= ?
                    ORDER BY date_received DESC
                    LIMIT 50000`, [sqlDate(since)]),
                db.get(`SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS files FROM ${T_ATTACH}`)
            ]);
            const series = [];
            const index = {};
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(Date.now() - i * 86400000);
                const key = d.toISOString().slice(0, 10);
                index[key] = series.length;
                series.push({ date: key, received: 0, sent: 0, spam: 0, failed: 0 });
            }
            for (const r of recentRows) {
                const t = Date.parse(String(r.date_received).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(r.date_received)) ? '' : 'Z'));
                if (!Number.isFinite(t)) continue;
                const key = new Date(t).toISOString().slice(0, 10);
                const i = index[key];
                if (i === undefined) continue;
                if (Number(r.is_draft)) continue;
                if (Number(r.is_sent)) series[i].sent++;
                else if (Number(r.is_spam)) series[i].spam++;
                else series[i].received++;
                if (r.delivery_status === 'failed') series[i].failed++;
            }
            return {
                totals: {
                    messages: Number(totals && totals.messages) || 0,
                    sent: Number(totals && totals.sent) || 0,
                    received: Number(totals && totals.received) || 0,
                    spam: Number(totals && totals.spam) || 0,
                    failed: Number(totals && totals.failed) || 0,
                    retrying: Number(totals && totals.retrying) || 0,
                    scheduled: Number(totals && totals.scheduled) || 0,
                    bytes: (Number(totals && totals.bytes) || 0) + (Number(att && att.bytes) || 0),
                    attachments: Number(att && att.files) || 0,
                },
                series,
            };
        },

        /**
         * Latest traffic, headers only (admin dashboard). The inbox copies internal mail fans out to
         * (message_id '<local-…>') are left out: the Sent copy already stands for that message.
         */
        async recentActivity(limit = 25) {
            return await db.all(`
                SELECT id, user_id, from_address, from_name, to_address, subject, date_received,
                       is_sent, is_spam, delivery_status, last_error
                FROM ${T_EMAILS}
                WHERE is_draft = 0
                  AND NOT (is_sent = 0 AND message_id LIKE '<local-%')
                ORDER BY id DESC
                LIMIT ?`, [Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100)]);
        },

        // --- Outbound queue --------------------------------------------------------------------

        /** Everything not yet delivered: undo-window/scheduled sends, retries and final failures. */
        async listQueue(limit = 200) {
            return await db.all(`
                SELECT id, user_id, from_address, from_name, to_address, cc_address, subject, date_received,
                       scheduled_at, is_sent, delivery_status, delivery_attempts, next_attempt_at, last_error
                FROM ${T_EMAILS}
                WHERE is_trash = 0 AND (
                    delivery_status IN ('retry', 'failed')
                    OR (is_sent = 0 AND is_draft = 0 AND scheduled_at IS NOT NULL)
                )
                ORDER BY id DESC
                LIMIT ?`, [Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500)]);
        },

        async getQueueItem(id) {
            return await db.get(`
                SELECT id, user_id, is_sent, is_draft, scheduled_at, delivery_status
                FROM ${T_EMAILS} WHERE id = ?`, [parseInt(id, 10) || 0]);
        },

        /** Stop a retrying message for good (an administrator decided it will never be delivered). */
        async abandonRetry(id, note) {
            await db.run(`
                UPDATE ${T_EMAILS}
                SET delivery_status = 'failed', next_attempt_at = NULL,
                    last_error = ?
                WHERE id = ? AND delivery_status = 'retry'`,
                [String(note || 'Cancelled by an administrator').slice(0, 1000), parseInt(id, 10) || 0]);
        },
    };
    return store;
};

module.exports.normalizeLocalPart = normalizeLocalPart;
module.exports.normalizeDestinations = normalizeDestinations;
