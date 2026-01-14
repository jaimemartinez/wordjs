/**
 * WordJS - User Model
 * Equivalent to wp-includes/class-wp-user.php and wp-includes/user.php
 */

const { db } = require('../config/database');
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

    getMeta(key, single = true) {
        if (single) {
            const stmt = db.prepare('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ? LIMIT 1');
            const row = stmt.get(this.id, key);
            if (!row) return null;
            try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
        } else {
            const stmt = db.prepare('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?');
            return stmt.all(this.id, key).map(row => {
                try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
            });
        }
    }

    getRole() { return this.getMeta('role') || 'subscriber'; }

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
            username: this.userLogin,
            email: this.userEmail,
            nicename: this.userNicename,
            url: this.userUrl,
            registered: this.userRegistered,
            displayName: this.displayName,
            role: this.getRole(),
            capabilities: this.getCapabilities(),
            avatarUrl: this.getAvatarUrl()
        };
    }

    getAvatarUrl(size = 96) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(this.userEmail.toLowerCase().trim()).digest('hex');
        return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mm`;
    }

    static async create(data) {
        const { username, email, password, displayName, role = 'subscriber', url = '' } = data;

        if (!username || !email || !password) {
            throw new Error('Username, email, and password are required');
        }

        const existingLogin = db.prepare('SELECT id FROM users WHERE user_login = ?').get(username);
        if (existingLogin) throw new Error('Username already exists');

        const existingEmail = db.prepare('SELECT id FROM users WHERE user_email = ?').get(email);
        if (existingEmail) throw new Error('Email already exists');

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const nicename = sanitizeTitle(username);

        const stmt = db.prepare(`
      INSERT INTO users (user_login, user_pass, user_nicename, user_email, user_url, user_registered, display_name, user_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);

        const result = stmt.run(username, hashedPassword, nicename, email, url, currentTimeGMT(), displayName || username);
        const userId = result.lastInsertRowid;

        User.updateMeta(userId, 'role', role);
        return User.findById(userId);
    }

    static findById(id) {
        const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
        const row = stmt.get(id);
        return row ? new User(row) : null;
    }

    static findByLogin(login) {
        const stmt = db.prepare('SELECT * FROM users WHERE user_login = ?');
        const row = stmt.get(login);
        return row ? new User(row) : null;
    }

    static findByEmail(email) {
        const stmt = db.prepare('SELECT * FROM users WHERE user_email = ?');
        const row = stmt.get(email);
        return row ? new User(row) : null;
    }

    static async authenticate(login, password) {
        let user = User.findByLogin(login);
        if (!user) user = User.findByEmail(login);
        if (!user) throw new Error('Invalid username or email');

        const stmt = db.prepare('SELECT user_pass FROM users WHERE id = ?');
        const row = stmt.get(user.id);

        const valid = await bcrypt.compare(password, row.user_pass);
        if (!valid) throw new Error('Invalid password');

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
            const stmt = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`);
            stmt.run(...values);
        }

        if (data.role) User.updateMeta(id, 'role', data.role);
        return User.findById(id);
    }

    static delete(id) {
        db.prepare('DELETE FROM user_meta WHERE user_id = ?').run(id);
        const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return result.changes > 0;
    }

    static findAll(options = {}) {
        const { role, search, limit = 20, offset = 0, orderBy = 'id', order = 'ASC' } = options;

        let sql = 'SELECT * FROM users';
        const conditions = [];
        const params = [];

        if (search) {
            conditions.push('(user_login LIKE ? OR user_email LIKE ? OR display_name LIKE ?)');
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');

        const allowedOrderBy = ['id', 'user_login', 'user_email', 'user_registered', 'display_name'];
        const safeOrderBy = allowedOrderBy.includes(orderBy) ? orderBy : 'id';
        const safeOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        sql += ` ORDER BY ${safeOrderBy} ${safeOrder} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const stmt = db.prepare(sql);
        const rows = stmt.all(...params);

        let users = rows.map(row => new User(row));
        if (role) users = users.filter(u => u.getRole() === role);
        return users;
    }

    static count(options = {}) {
        const { search } = options;

        let sql = 'SELECT COUNT(*) as count FROM users';
        const params = [];

        if (search) {
            sql += ' WHERE user_login LIKE ? OR user_email LIKE ? OR display_name LIKE ?';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        const stmt = db.prepare(sql);
        const row = stmt.get(...params);
        return row.count;
    }

    static updateMeta(userId, key, value) {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        const existing = db.prepare('SELECT umeta_id FROM user_meta WHERE user_id = ? AND meta_key = ?').get(userId, key);

        if (existing) {
            db.prepare('UPDATE user_meta SET meta_value = ? WHERE user_id = ? AND meta_key = ?').run(serialized, userId, key);
        } else {
            db.prepare('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)').run(userId, key, serialized);
        }
    }

    static getMeta(userId, key, single = true) {
        if (single) {
            const stmt = db.prepare('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ? LIMIT 1');
            const row = stmt.get(userId, key);
            if (!row) return null;
            try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
        } else {
            const stmt = db.prepare('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?');
            return stmt.all(userId, key).map(row => {
                try { return JSON.parse(row.meta_value); } catch { return row.meta_value; }
            });
        }
    }

    static deleteMeta(userId, key) {
        const result = db.prepare('DELETE FROM user_meta WHERE user_id = ? AND meta_key = ?').run(userId, key);
        return result.changes > 0;
    }
}

module.exports = User;
