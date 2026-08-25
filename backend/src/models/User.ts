/**
 * WordJS - User Model
 * Equivalent to wp-includes/class-wp-user.php and wp-includes/user.php
 */

const { db, dbAsync } = require('../config/database');
const bcrypt = require('bcryptjs');
const config = require('../config/app');
const { sanitizeTitle, currentTimeGMT } = require('../core/formatting');
const { getRoles } = require('../core/roles');
// One unique-violation predicate for all three drivers. This file used to carry its own, which knew
// only SQLite and Postgres — see core/db-errors.ts for what that cost on MySQL.
const { isUniqueViolation } = require('../core/db-errors');
// The ACTIVE CORPORATE MAILBOX fact + the one address-shape rule. See core/mailbox.ts.
const {
    MAILBOX_META_KEY, EMAIL_FORMAT_RE, normalizeAddress, hasProfessionalMailbox, mailboxFlagValue
} = require('../core/mailbox');

const SALT_ROUNDS = 12;

/**
 * Validate a role string against the known roles allow-list before it is written to user_meta.
 * Mass-assigning an arbitrary role is dangerous: getCapabilities()/can() short-circuit to ['*'] for
 * the literal 'administrator', and an unknown role silently strips all capabilities. Reject anything
 * not present in the seeded roles map (single choke point used by create() and update()).
 */
function assertValidRole(role: string): void {
    if (role === undefined || role === null) return;
    const roles = getRoles() || {};
    if (!Object.prototype.hasOwnProperty.call(roles, role)) {
        throw new Error(`Invalid role: ${role}`);
    }
}

/**
 * Canonicalize an email for storage and comparison.
 *
 * The DB unique index is on SQLite/Postgres LOWER(user_email), but SQLite's LOWER() folds ASCII A-Z
 * ONLY — so confusable case variants like 'Ä@x.com' / 'ä@x.com' (or the Turkish dotless-i, ß, etc.)
 * are treated as DISTINCT and both can be stored, defeating email-as-identity uniqueness. JS
 * String.prototype.toLowerCase() performs a FULL Unicode case fold, so we normalize at the app layer
 * (NFC to also collapse equivalent composed/decomposed forms) before every store and lookup. With the
 * stored value already fully lowercased, the LOWER()-based index/queries then only have ASCII left to
 * fold and uniqueness holds across engines and scripts.
 *
 * Delegates to core/mailbox.normalizeAddress so the fold used for STORAGE here and the fold used for
 * the corporate-mailbox domain comparison there are literally the same function — a second copy would
 * eventually disagree about some address and silently split "the same" identity in two.
 */
function normalizeEmail(email: any): string {
    return normalizeAddress(email);
}

class User {
    id?: number;
    userLogin?: string;
    userEmail?: string;
    userNicename?: string;
    userUrl?: string;
    userRegistered?: string;
    displayName?: string;
    userStatus?: number;
    meta?: { [key: string]: any };
    role?: string;
    /**
     * ACTIVE CORPORATE MAILBOX — the admin-owned fact, materialized from user_meta by loadMeta() so
     * every projection of this user (plugin bridge, isolate req.user, toJSON) carries the SAME answer
     * instead of each one re-deriving it. Never write this directly: it is set from
     * user_meta.professional_mailbox, which only an `edit_users` caller can change.
     */
    hasProfessionalMailbox?: boolean;

    constructor(data: any) {
        this.id = data.id;
        this.userLogin = data.user_login;
        this.userEmail = data.user_email;
        this.userNicename = data.user_nicename;
        this.userUrl = data.user_url;
        this.userRegistered = data.user_registered;
        this.displayName = data.display_name;
        this.userStatus = data.user_status;
    }

    async getMeta(key: string, single = true) {
        if (single) {
            const row = await dbAsync.get('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ? LIMIT 1', [this.id, key]);
            if (!row) return null;
            try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
        } else {
            const rows = await dbAsync.all('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [this.id, key]);
            return rows.map((row: any) => {
                try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
            });
        }
    }

    getRole() { return this.role || (this.meta && this.meta.role) || 'subscriber'; }

    getCapabilities() {
        const role = this.getRole();
        // Administrators implicitly hold every capability ('*' wildcard / WP superadmin). The
        // role→capabilities map is seeded from the wordjs_user_roles option and can be EMPTY on a
        // fresh or imported install — which previously left an administrator with ZERO capabilities
        // (403 on every can() gate, and an empty capabilities list sent to the frontend).
        if (role === 'administrator') return ['*'];
        const roles = getRoles();
        return roles[role]?.capabilities || [];
    }

    can(capability: string) {
        // Administrators bypass the capability lookup entirely (safety net, independent of whether
        // the role→cap map got seeded).
        if (this.getRole() === 'administrator') return true;
        const caps = this.getCapabilities();
        if (caps.includes('*')) return true;
        return caps.includes(capability);
    }

    // Static Methods

    static async create(data: any) {
        const { username, email, password, displayName, role = 'subscriber' } = data;

        // Validation
        if (!username || !email || !password) {
            throw new Error('Username, email, and password are required');
        }

        // Reject any role not in the known roles allow-list (prevents role mass-assignment / bogus role).
        assertValidRole(role);

        // Canonicalize the email (full-Unicode lowercase + NFC) so confusable-case variants collide
        // and uniqueness holds even where the DB's ASCII-only LOWER() would not. Store the canonical form.
        const normalizedEmail = normalizeEmail(email);

        // Validate the SHAPE here, not only in update(). create() used to accept anything non-empty, so
        // POST /api/v1/users (admin) could store 'a@gmail.com@acme.example' — an address whose domain two
        // readers can legitimately disagree about (first '@' vs last '@'). One rule, both entry points:
        // exactly one '@' (the character class forbids a second), a non-empty local part and a dotted
        // domain. Rejecting it at the model covers every caller — REST, self-registration, both importers.
        if (!EMAIL_FORMAT_RE.test(normalizedEmail)) throw new Error('Invalid email format');

        // Check if exists
        const existingUser = await User.findByLogin(username);
        if (existingUser) throw new Error('Username already exists');

        const existingEmail = await User.findByEmail(normalizedEmail);
        if (existingEmail) throw new Error('Email already exists');

        // Hash password
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        // Insert User. The findByLogin/findByEmail checks above leave a TOCTOU window — two concurrent
        // signups can both pass the check and reach here. The unique indexes (idx_users_login /
        // idx_users_email) make the DB reject the loser; translate that into the SAME "already exists"
        // error as the pre-check so callers see consistent behavior instead of a raw DB error.
        let result;
        try {
            result = await dbAsync.run(`
                INSERT INTO users (user_login, user_pass, user_email, display_name, user_registered)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id
            `, [username, hashedPassword, normalizedEmail, displayName || username]);
        } catch (e: any) {
            if (isUniqueViolation(e)) {
                throw new Error('Username or email already exists', { cause: e });
            }
            throw e;
        }

        const userId = result.lastID;

        // Insert Role Meta
        await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [userId, 'role', role]);

        // Optional personal/recovery email (coexists with the primary/professional email; used for
        // password recovery + external notifications). Stored as meta because a user has ONE primary
        // email column; update() already forwards data.meta, but create() must persist it here.
        const personalEmail = data.personalEmail || (data.meta && data.meta.personal_email);
        if (personalEmail) {
            await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
                [userId, 'personal_email', String(personalEmail).trim().toLowerCase()]);
        }

        // ACTIVE CORPORATE MAILBOX. Written ONLY from the explicit `professionalMailbox` argument (the
        // admin user form's toggle) — never derived from the email address, which the account itself can
        // write. The caller is responsible for proving `edit_users`; routes/users.ts POST / is admin-only
        // and /auth/register never passes it, so a self-registration can never arrive here with it set.
        if (data.professionalMailbox !== undefined && mailboxFlagValue(data.professionalMailbox) === '1') {
            await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
                [userId, MAILBOX_META_KEY, '1']);
        }

        return await User.findById(userId);
    }

    static async findById(id: number) {
        // Hot path: EVERY authenticated request resolves the user (gate + route auth). Cached with
        // the same invalidation-complete model as options: update/delete/updateMeta/deleteMeta/
        // compareAndSetMeta all del() this key, so role changes, session revocation
        // (token_valid_after) and disables take effect on the very next request in-process; the L1
        // multi-node bound is the same 30s the roles cache already accepts. user_pass is NEVER
        // cached (the constructor doesn't carry it either).
        const cache = require('../core/cache');
        const cacheKey = `user:${id}`;
        const cached = await cache.get(cacheKey);
        if (cached && cached.v && cached.v.row) {
            const user = new User(cached.v.row);
            user._applyMeta(cached.v.meta || {});
            return user;
        }

        // Core user data
        const row = await dbAsync.get('SELECT * FROM users WHERE id = ?', [id]);
        if (!row) return null;

        const user = new User(row);

        // Fetch Meta
        await user.loadMeta();

        const { user_pass, ...safeRow } = row;
        void user_pass;
        await cache.set(cacheKey, { v: { row: safeRow, meta: user.meta || {} } }, 60);
        return user;
    }

    static async findByLogin(login: string) {
        const row = await dbAsync.get('SELECT * FROM users WHERE user_login = ?', [login]);
        if (!row) return null;

        const user = new User(row);
        await user.loadMeta();
        return user;
    }

    static async findByEmail(email: any) {
        // Compare against the JS-canonicalized form (full Unicode fold) — the bound value is already
        // lowercased, so the column's LOWER() only has to ASCII-fold legacy mixed-case rows. This
        // matches non-ASCII confusable variants that SQLite's ASCII-only LOWER() alone would miss.
        const normalized = normalizeEmail(email);
        const row = await dbAsync.get('SELECT * FROM users WHERE LOWER(user_email) = ?', [normalized]);
        if (!row) return null;

        const user = new User(row);
        await user.loadMeta();
        return user;
    }

    static async authenticate(login: string, password: string) {
        let user = await User.findByLogin(login);
        if (!user) user = await User.findByEmail(login);

        // Mitigation for Timing Attacks (Username Enumeration)
        // Always perform a hash comparison, even if user doesn't exist
        // We use a dummy hash to burn CPU time similar to a real login
        if (!user) {
            // Constant-time defense against username enumeration: compare against a REAL bcrypt hash
            // at the SAME cost (12) as live passwords, so the no-user path burns the same ~CPU as a
            // wrong-password path. The previous dummy was a malformed/truncated hash that bcrypt
            // rejected in ~0ms, leaking user existence via a ~16000x timing gap.
            const dummy = '$2a$12$r/WI9u0Eop2pwQ1nYgGWnOyH7eYYMRCEp0ATWSigC8ZNONV4KUm66';
            await bcrypt.compare(password, dummy);
            throw new Error('Invalid credentials');
        }

        const row = await dbAsync.get('SELECT user_pass FROM users WHERE id = ?', [user.id]);
        const valid = await bcrypt.compare(password, row.user_pass);

        if (!valid) throw new Error('Invalid credentials');

        return user;
    }

    static async update(id: number, data: any) {
        const updates: string[] = [];
        const values: any[] = [];
        let passwordChanged = false;

        if (data.email) {
            // Validate + enforce uniqueness on update (create already does this; update did not, so a
            // user could set their email to collide with another account → identity confusion/takeover).
            const email = String(data.email).trim();
            // Length cap BEFORE the regex: the pattern is polynomial (quadratic backtracking), so an
            // unbounded value is a ReDoS. 254 = RFC 5321 max — no real address is rejected. Model-level
            // backstop so every caller (routes + importers) is protected regardless of upstream checks.
            if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email format');
            // Canonicalize (full-Unicode lowercase + NFC) so confusable-case variants collide and we
            // store/compare the same form everywhere; the unique index then holds for non-ASCII too.
            const normalizedEmail = normalizeEmail(email);
            const existing = await User.findByEmail(normalizedEmail);
            if (existing && String(existing.id) !== String(id)) throw new Error('Email already in use');
            updates.push('user_email = ?'); values.push(normalizedEmail);
        }
        if (data.displayName) { updates.push('display_name = ?'); values.push(data.displayName); }
        if (data.url !== undefined) {
            // SECURITY: user_url is later rendered as a clickable link (profile + comment-author href in
            // the admin moderation UI and the public post page). Persist ONLY an http(s) absolute URL so a
            // self-service `PUT /users/me {url:"javascript:..."}` (or data:/mailto:) can never become a
            // stored XSS payload reaching an href sink. Anything else (bad scheme / not absolute) clears it.
            let safeUrl = '';
            const rawUrl = String(data.url).trim();
            if (rawUrl) {
                try { const proto = new URL(rawUrl).protocol; if (proto === 'http:' || proto === 'https:') safeUrl = rawUrl; } catch { /* invalid → cleared */ }
            }
            updates.push('user_url = ?'); values.push(safeUrl);
        }
        if (data.password) {
            const hashedPassword = await bcrypt.hash(data.password, SALT_ROUNDS);
            updates.push('user_pass = ?');
            values.push(hashedPassword);
            passwordChanged = true;
        }

        if (updates.length > 0) {
            values.push(id);
            // The findByEmail pre-check above leaves a TOCTOU window — two concurrent email updates to the
            // same address can both pass it, then the loser hits idx_users_email and the driver throws a
            // raw constraint error. Translate that into the SAME clean message create() uses (preserving
            // the unique index's integrity guarantee) instead of surfacing a driver-internal 500.
            try {
                await dbAsync.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
            } catch (e: any) {
                if (isUniqueViolation(e)) {
                    throw new Error('Email already in use', { cause: e });
                }
                throw e;
            }
        }

        // Revoke all existing JWTs on password change — stateless tokens carry no server state, so we
        // stamp a security epoch the auth middleware checks against the token's iat. See auth.ts.
        if (passwordChanged) {
            await User.updateMeta(id, 'token_valid_after', String(Math.floor(Date.now() / 1000)));
            // Also hard-revoke the user's scoped API tokens. token_valid_after only gates the JWT path, so
            // without this a stolen `wjt_` token would survive a password reset — the compromise-recovery
            // action — contradicting the "revokes every session" guarantee. Done on password change/reset,
            // NOT on logout (which stamps the epoch separately): logging out of a browser must not kill a
            // user's headless CI tokens.
            try { await require('./ApiToken').revokeAllForUser(id); } catch { /* best-effort; the JWT epoch still applies */ }
        }

        // Update meta if provided
        if (data.role) {
            // Reject any role not in the known roles allow-list (prevents role mass-assignment).
            assertValidRole(data.role);
            await User.updateMeta(id, 'role', data.role);
        }

        // ACTIVE CORPORATE MAILBOX — its own guarded branch, exactly like `role`, so it can only be
        // written by a caller that passed the explicit `professionalMailbox` field. routes/users.ts is
        // what proves the caller holds `edit_users`; the PROTECTED_META entry below is what stops any
        // route from reaching the same key through the generic `data.meta` bag.
        if (data.professionalMailbox !== undefined) {
            await User.updateMeta(id, MAILBOX_META_KEY, mailboxFlagValue(data.professionalMailbox));
        }

        if (data.meta) {
            // Protected keys must NEVER be set through the generic meta path: 'role' has a dedicated
            // assertValidRole-guarded branch above (mass-assigning meta.role would bypass the allow-list
            // → privilege escalation, since getRole() reads meta.role and administrators short-circuit
            // to '*'), 'token_valid_after' is the JWT revocation epoch, and MAILBOX_META_KEY is the
            // ACTIVE CORPORATE MAILBOX grant (mass-assigning it through a route that forwards req.body.meta
            // would restore exactly the self-grant this whole change removes). Skip them here so a future
            // route forwarding req.body.meta into update() can't escalate or tamper with auth state.
            //
            // The same reasoning covers three FAMILIES of keys, matched by prefix rather than spelled out
            // one by one — a list of names protects the keys that existed the day it was written, and the
            // next member of the family arrives unprotected:
            //   • `mfa_*` — the TOTP secret, the pending enrollment secret, the backup-code hashes, the
            //     enabled flag and the anti-replay step counter. Reaching those through the generic bag
            //     would enroll or disable a second factor without any of the proof /auth/mfa/* demands
            //     (and rewinding mfa_totp_last_step would re-enable a already-used TOTP step).
            //   • `password_reset_*` / `email_verification_*` — single-use credential material. Writing a
            //     hash of a token you chose is a password reset for that account.
            // No route forwards req.body.meta into update() today; that is precisely why the guard must be
            // here, before one does.
            const PROTECTED_META = new Set(['role', 'token_valid_after', MAILBOX_META_KEY]);
            const PROTECTED_META_PREFIXES = ['mfa_', 'password_reset_', 'email_verification_'];
            const isProtectedMeta = (k: string) =>
                PROTECTED_META.has(k) || PROTECTED_META_PREFIXES.some((p) => k.startsWith(p));
            for (const [key, value] of Object.entries(data.meta)) {
                if (isProtectedMeta(key)) continue;
                await User.updateMeta(id, key, value);
            }
        }

        // Invalidate BEFORE the read-back: the direct `UPDATE users` column writes above don't go
        // through updateMeta, and a stale cache entry here would make this findById return (and
        // re-serve) the pre-update row.
        await require('../core/cache').del(`user:${id}`);
        return await User.findById(id);
    }

    static async delete(id: number) {
        await dbAsync.run('DELETE FROM user_meta WHERE user_id = ?', [id]);
        await dbAsync.run('DELETE FROM users WHERE id = ?', [id]);
        await require('../core/cache').del(`user:${id}`);
        return true;
    }

    // Shared filter builder for findAll + count so their WHERE/JOIN can never drift — which is exactly
    // what made count() ignore the search/role filter (wrong X-WP-Total pagination). All values are bound.
    static _buildFilter(args: any = {}) {
        const { role, search } = args;
        let join = '';
        const where: string[] = [];
        const params: any[] = [];
        if (role) {
            join = ' JOIN user_meta um ON u.id = um.user_id';
            where.push("um.meta_key = 'role' AND um.meta_value = ?");
            params.push(role);
        }
        if (search) {
            where.push('(u.user_login LIKE ? OR u.display_name LIKE ? OR u.user_email LIKE ?)');
            const s = `%${search}%`;
            params.push(s, s, s);
        }
        const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
        return { join, whereSql, params };
    }

    static async findAll(args: any = {}) {
        const { limit = 10, offset = 0, orderBy, order } = args;
        const { join, whereSql, params } = User._buildFilter(args);

        // Whitelist the ORDER BY column + direction (defense-in-depth — the route already whitelists, but
        // findAll must never interpolate an arbitrary column). Previously findAll had NO ORDER BY, so the
        // whitelisted orderBy/order the route passed were silently ignored (the admin user-list sort was a
        // no-op, rows came back in undefined engine order). A trailing id tiebreak keeps pagination stable.
        const ALLOWED_ORDER = ['id', 'user_login', 'display_name', 'user_email', 'user_registered'];
        const col = ALLOWED_ORDER.includes(orderBy) ? orderBy : 'id';
        const dir = String(order).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        const orderSql = ` ORDER BY u.${col} ${dir}${col !== 'id' ? ', u.id ASC' : ''}`;

        // SELECT DISTINCT so a user with duplicate role meta (a non-atomic updateMeta race or a WXR
        // import can leave two meta_key='role' rows) can't appear twice via the role JOIN — keeping this
        // in lockstep with count()'s COUNT(DISTINCT u.id). The ORDER BY columns are all within u.* so
        // DISTINCT is valid on Postgres too.
        const sql = `SELECT DISTINCT u.* FROM users u${join}${whereSql}${orderSql} LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`;

        const rows = await dbAsync.all(sql, params);

        const users = rows.map((row: any) => new User(row));

        // Batch-load meta in ONE query instead of loadMeta() per row (N+1).
        const ids = users.map((u: any) => u.id).filter((id: any) => id != null);
        if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            const metaRows = await dbAsync.all(
                `SELECT user_id, meta_key, meta_value FROM user_meta WHERE user_id IN (${placeholders})`,
                ids
            );

            // Group meta by user_id (mirrors loadMeta()'s per-user shape).
            const metaByUser: { [id: string]: { [key: string]: any } } = {};
            for (const mr of metaRows) {
                if (!metaByUser[mr.user_id]) metaByUser[mr.user_id] = {};
                metaByUser[mr.user_id][mr.meta_key] = mr.meta_value;
            }

            for (const u of users) {
                const meta = metaByUser[u.id] || {};
                u.meta = meta;
                if (meta.role) u.role = meta.role;
            }
        } else {
            for (const u of users) {
                u.meta = {};
            }
        }

        return users;
    }

    static async count(args: any = {}) {
        const { join, whereSql, params } = User._buildFilter(args);
        // COUNT(DISTINCT u.id): the role filter JOINs user_meta, so DISTINCT keeps this equal to the
        // number of distinct users findAll returns — otherwise pagination totals wouldn't match the list.
        const row = await dbAsync.get(`SELECT COUNT(DISTINCT u.id) as count FROM users u${join}${whereSql}`, params);
        return row.count;
    }

    // Meta Methods

    // Single source for every meta-derived field (role, mailbox fact): loadMeta AND the findById
    // cache rehydration both go through here, so the derivations can never drift apart.
    _applyMeta(meta: { [key: string]: any }) {
        this.meta = meta;
        if (meta.role) this.role = meta.role;
        // Materialize the ACTIVE CORPORATE MAILBOX fact ONCE, here, so every downstream projection
        // (plugin bridge, isolate req.user, toJSON) reports the same answer without re-deriving it.
        this.hasProfessionalMailbox = hasProfessionalMailbox(meta);
    }

    async loadMeta() {
        const rows = await dbAsync.all('SELECT meta_key, meta_value FROM user_meta WHERE user_id = ?', [this.id]);
        const meta: { [key: string]: any } = {};
        rows.forEach((row: any) => {
            meta[row.meta_key] = row.meta_value;
        });
        this._applyMeta(meta);
    }

    static async getMeta(userId: number, key: string) {
        const row = await dbAsync.get('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [userId, key]);
        return row ? row.meta_value : null;
    }

    static async updateMeta(userId: number, key: string, value: any) {
        // Simple upsert logic
        // Check if exists
        const existing = await User.getMeta(userId, key);

        if (existing !== null) {
            await dbAsync.run('UPDATE user_meta SET meta_value = ? WHERE user_id = ? AND meta_key = ?', [String(value), userId, key]);
        } else {
            await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [userId, key, String(value)]);
        }
        // role / token_valid_after / mailbox live here — the cached user must die with every write
        await require('../core/cache').del(`user:${userId}`);
    }

    static async deleteMeta(userId: number, key: string) {
        await dbAsync.run('DELETE FROM user_meta WHERE user_id = ? AND meta_key = ?', [userId, key]);
        await require('../core/cache').del(`user:${userId}`);
        return true;
    }

    /**
     * Atomic compare-and-set on a meta value: set `key` to `next` only if it currently equals `expected`.
     * A single guarded UPDATE (the SQL WHERE re-checks under the row lock), so two concurrent callers can
     * never both win. Returns true iff THIS call made the change. The row must already exist. Used to close
     * TOCTOU races on single-use consumption (backup codes) and the monotonic TOTP last-step counter.
     */
    static async compareAndSetMeta(userId: number, key: string, expected: string, next: string): Promise<boolean> {
        const result = await dbAsync.run(
            'UPDATE user_meta SET meta_value = ? WHERE user_id = ? AND meta_key = ? AND meta_value = ?',
            [String(next), userId, key, String(expected)]);
        const won = !!(result && (result.changes > 0 || result.rowCount > 0));
        if (won) await require('../core/cache').del(`user:${userId}`);
        return won;
    }

    toJSON() {
        // Essential for frontend (camelCase)
        // AND legacy backend compatibility (snake_case)
        // Never blanket-dump user_meta: a plugin or core flow may stash secrets there (API keys,
        // tokens, 2FA seeds, the token_valid_after epoch). Strip sensitive-looking keys before serializing.
        const SENSITIVE_META = /secret|token|pass|pwd|priv(ate)?|[_-]?key$|^key|api[_-]?key|credential|salt|hash|2fa|otp|recovery|seed/i;
        const safeMeta: { [k: string]: any } = {};
        for (const [k, v] of Object.entries(this.meta || {})) {
            if (!SENSITIVE_META.test(k)) safeMeta[k] = v;
        }

        return {
            id: this.id,
            username: this.userLogin,     // Frontend expectation
            user_login: this.userLogin,   // Legacy expectation
            email: this.userEmail,        // Frontend expectation
            user_email: this.userEmail,   // Legacy expectation
            displayName: this.displayName, // Frontend expectation
            display_name: this.displayName, // Legacy expectation
            role: this.role || 'subscriber',
            capabilities: this.getCapabilities(),
            // Personal / recovery email (coexists with the primary/professional email). Surfaced as a
            // top-level field for the user form; also present in `meta.personal_email`. It is deliberately
            // NON-sensitive (a mere contact address) so it is not stripped by SENSITIVE_META above.
            personalEmail: (this.meta && this.meta.personal_email) || null,
            // ACTIVE CORPORATE MAILBOX, as a first-class boolean so the admin user form can render the
            // "Professional Mail Account" toggle in its true state and send it straight back.
            professionalMailbox: hasProfessionalMailbox(this),
            meta: safeMeta
        };
    }
}

module.exports = User;
