/**
 * WordJS - User Model
 * Equivalent to wp-includes/class-wp-user.php and wp-includes/user.php
 */

const { db, dbAsync } = require('../config/database');
const bcrypt = require('bcryptjs');
const config = require('../config/app');
const { sanitizeTitle, currentTimeGMT } = require('../core/formatting');
const { getRoles } = require('../core/roles');

const SALT_ROUNDS = 10;

class User {
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
        const roles = getRoles();
        return roles[role]?.capabilities || [];
    }

    can(capability) {
        const caps = this.getCapabilities();
        if (caps.includes('*')) return true;
        return caps.includes(capability);
    }
    toJSON() {
        return {
            id: this.id,
            username: this.userLogin, // Use userLogin as username
            email: this.userEmail,   // Use userEmail as email
            displayName: this.displayName,
            role: this.role,
            meta: this.meta
        };
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

        // Insert User
        const result = await dbAsync.run(`
            INSERT INTO users (user_login, user_pass, user_email, display_name, user_registered)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id
        `, [username, hashedPassword, email, displayName || username]);

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
            // Dummy hash (bcrypt/cost=10)
            const dummy = '$2a$10$abcdefghijklmnopqrstuv';
            await bcrypt.compare(password, dummy);
            throw new Error('Invalid credentials');
        }

        const row = await dbAsync.get('SELECT user_pass FROM users WHERE id = ?', [user.id]);
        const valid = await bcrypt.compare(password, row.user_pass);

        if (!valid) throw new Error('Invalid credentials');

        return user;
    }

    static async update(id, data) {
        const updates = [];
        const values = [];

        if (data.email) { updates.push('user_email = ?'); values.push(data.email); }
        if (data.displayName) { updates.push('display_name = ?'); values.push(data.displayName); }
        if (data.url !== undefined) { updates.push('user_url = ?'); values.push(data.url); }
        if (data.password) {
            const hashedPassword = await bcrypt.hash(data.password, SALT_ROUNDS);
            updates.push('user_pass = ?');
            values.push(hashedPassword);
        }

        if (updates.length > 0) {
            values.push(id);
            await dbAsync.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
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

    static async findAll(args = {}) {
        const { role, search, limit = 10, offset = 0 } = args;

        let sql = 'SELECT u.* FROM users u';
        const params = [];
        const where = [];

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

        const users = await Promise.all(rows.map(async row => {
            const u = new User(row);
            await u.loadMeta();
            return u;
        }));

        return users;
    }

    static async count() {
        const row = await dbAsync.get('SELECT COUNT(*) as count FROM users');
        return row.count;
    }

    // Meta Methods

    async loadMeta() {
        const rows = await dbAsync.all('SELECT meta_key, meta_value FROM user_meta WHERE user_id = ?', [this.id]);
        this.meta = {};
        rows.forEach(row => {
            this.meta[row.meta_key] = row.meta_value;
        });

        if (this.meta.role) this.role = this.meta.role;
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
        const { getRoles } = require('../core/roles');
        const roles = getRoles();
        const roleObj = roles[this.role];

        return {
            id: this.id,
            username: this.userLogin,     // Frontend expectation
            user_login: this.userLogin,   // Legacy expectation
            email: this.userEmail,        // Frontend expectation
            user_email: this.userEmail,   // Legacy expectation
            displayName: this.displayName, // Frontend expectation
            display_name: this.displayName, // Legacy expectation
            role: this.role || 'subscriber',
            capabilities: roleObj ? roleObj.capabilities : [],
            meta: this.meta || {}
        };
    }
}

module.exports = User;
