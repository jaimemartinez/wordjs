/**
 * WordJS - User Model
 * Equivalent to wp-includes/class-wp-user.php and wp-includes/user.php
 */

const { db, dbAsync } = require('../config/database');
const bcrypt = require('bcryptjs');
const config = require('../config/app');
const { sanitizeTitle, currentTimeGMT } = require('../core/formatting');
const { getRoles } = require('../core/roles');

const SALT_ROUNDS = 12;

/**
 * True when a DB error is a UNIQUE-constraint violation, across drivers:
 *   - SQLite (better-sqlite3 / sql.js): code 'SQLITE_CONSTRAINT_UNIQUE' or message
 *     'UNIQUE constraint failed: ...'
 *   - Postgres (pg): SQLSTATE '23505' (unique_violation)
 */
function isUniqueViolation(err: any): boolean {
    if (!err) return false;
    const code = err.code;
    if (code === '23505') return true; // Postgres unique_violation
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
    const msg = String(err.message || '');
    return /UNIQUE constraint failed/i.test(msg) || /duplicate key value/i.test(msg);
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

    constructor(data) {
        this.id = data.id;
        this.userLogin = data.user_login;
        this.userEmail = data.user_email;
        this.userNicename = data.user_nicename;
        this.userUrl = data.user_url;
        this.userRegistered = data.user_registered;
        this.displayName = data.display_name;
        this.userStatus = data.user_status;
    }

    async getMeta(key, single = true) {
        if (single) {
            const row = await dbAsync.get('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ? LIMIT 1', [this.id, key]);
            if (!row) return null;
            try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
        } else {
            const rows = await dbAsync.all('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [this.id, key]);
            return rows.map(row => {
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

    can(capability) {
        // Administrators bypass the capability lookup entirely (safety net, independent of whether
        // the role→cap map got seeded).
        if (this.getRole() === 'administrator') return true;
        const caps = this.getCapabilities();
        if (caps.includes('*')) return true;
        return caps.includes(capability);
    }

    // Static Methods

    static async create(data) {
        const { username, email, password, displayName, role = 'subscriber' } = data;

        // Validation
        if (!username || !email || !password) {
            throw new Error('Username, email, and password are required');
        }

        // Check if exists
        const existingUser = await User.findByLogin(username);
        if (existingUser) throw new Error('Username already exists');

        const existingEmail = await User.findByEmail(email);
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
            `, [username, hashedPassword, email, displayName || username]);
        } catch (e: any) {
            if (isUniqueViolation(e)) {
                throw new Error('Username or email already exists');
            }
            throw e;
        }

        const userId = result.lastID;

        // Insert Role Meta
        await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [userId, 'role', role]);

        // Insert Capabilities (based on role)
        // ... handled by roles system usually, but store primitive role here

        return await User.findById(userId);
    }

    static async findById(id) {
        // Core user data
        const row = await dbAsync.get('SELECT * FROM users WHERE id = ?', [id]);
        if (!row) return null;

        const user = new User(row);

        // Fetch Meta
        await user.loadMeta();
        return user;
    }

    static async findByLogin(login) {
        const row = await dbAsync.get('SELECT * FROM users WHERE user_login = ?', [login]);
        if (!row) return null;

        const user = new User(row);
        await user.loadMeta();
        return user;
    }

    static async findByEmail(email) {
        const row = await dbAsync.get('SELECT * FROM users WHERE LOWER(user_email) = LOWER(?)', [email]);
        if (!row) return null;

        const user = new User(row);
        await user.loadMeta();
        return user;
    }

    static async authenticate(login, password) {
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

    static async update(id, data) {
        const updates: string[] = [];
        const values: any[] = [];
        let passwordChanged = false;

        if (data.email) {
            // Validate + enforce uniqueness on update (create already does this; update did not, so a
            // user could set their email to collide with another account → identity confusion/takeover).
            const email = String(data.email).trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email format');
            const existing = await User.findByEmail(email);
            if (existing && String(existing.id) !== String(id)) throw new Error('Email already in use');
            updates.push('user_email = ?'); values.push(email);
        }
        if (data.displayName) { updates.push('display_name = ?'); values.push(data.displayName); }
        if (data.url !== undefined) { updates.push('user_url = ?'); values.push(data.url); }
        if (data.password) {
            const hashedPassword = await bcrypt.hash(data.password, SALT_ROUNDS);
            updates.push('user_pass = ?');
            values.push(hashedPassword);
            passwordChanged = true;
        }

        if (updates.length > 0) {
            values.push(id);
            await dbAsync.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
        }

        // Revoke all existing JWTs on password change — stateless tokens carry no server state, so we
        // stamp a security epoch the auth middleware checks against the token's iat. See auth.ts.
        if (passwordChanged) {
            await User.updateMeta(id, 'token_valid_after', String(Math.floor(Date.now() / 1000)));
        }

        // Update meta if provided
        if (data.role) {
            await User.updateMeta(id, 'role', data.role);
        }

        if (data.meta) {
            for (const [key, value] of Object.entries(data.meta)) {
                await User.updateMeta(id, key, value);
            }
        }

        return await User.findById(id);
    }

    static async delete(id) {
        await dbAsync.run('DELETE FROM user_meta WHERE user_id = ?', [id]);
        await dbAsync.run('DELETE FROM users WHERE id = ?', [id]);
        return true;
    }

    static async findAll(args: any = {}) {
        const { role, search, limit = 10, offset = 0 } = args;

        let sql = 'SELECT u.* FROM users u';
        const params: any[] = [];
        const where: string[] = [];

        if (role) {
            sql += ' JOIN user_meta um ON u.id = um.user_id';
            where.push("um.meta_key = 'role' AND um.meta_value = ?");
            params.push(role);
        }

        if (search) {
            where.push('(u.user_login LIKE ? OR u.display_name LIKE ? OR u.user_email LIKE ?)');
            const s = `%${search}%`;
            params.push(s, s, s);
        }

        if (where.length > 0) {
            sql += ' WHERE ' + where.join(' AND ');
        }

        sql += ` LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`;

        const rows = await dbAsync.all(sql, params);

        const users = rows.map(row => new User(row));

        // Batch-load meta in ONE query instead of loadMeta() per row (N+1).
        const ids = users.map(u => u.id).filter(id => id != null);
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

    static async count() {
        const row = await dbAsync.get('SELECT COUNT(*) as count FROM users');
        return row.count;
    }

    // Meta Methods

    async loadMeta() {
        const rows = await dbAsync.all('SELECT meta_key, meta_value FROM user_meta WHERE user_id = ?', [this.id]);
        const meta: { [key: string]: any } = {};
        rows.forEach(row => {
            meta[row.meta_key] = row.meta_value;
        });
        this.meta = meta;

        if (meta.role) this.role = meta.role;
    }

    static async getMeta(userId, key) {
        const row = await dbAsync.get('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [userId, key]);
        return row ? row.meta_value : null;
    }

    static async updateMeta(userId, key, value) {
        // Simple upsert logic
        // Check if exists
        const existing = await User.getMeta(userId, key);

        if (existing !== null) {
            await dbAsync.run('UPDATE user_meta SET meta_value = ? WHERE user_id = ? AND meta_key = ?', [String(value), userId, key]);
        } else {
            await dbAsync.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [userId, key, String(value)]);
        }
    }

    static async deleteMeta(userId, key) {
        await dbAsync.run('DELETE FROM user_meta WHERE user_id = ? AND meta_key = ?', [userId, key]);
        return true;
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
            meta: safeMeta
        };
    }
}

module.exports = User;
