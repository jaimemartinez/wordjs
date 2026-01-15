/**
 * WordJS - Email Model
 * Interacts with the central database.
 */

const { db, dbAsync } = require('../config/database');

class Email {
    static async initSchema() {
        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS received_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT,
                from_address TEXT,
                from_name TEXT,
                to_address TEXT,
                subject TEXT,
                body_text TEXT,
                body_html TEXT,
                date_received TEXT DEFAULT CURRENT_TIMESTAMP,
                is_read INTEGER DEFAULT 0,
                is_sent INTEGER DEFAULT 0,
                raw_content TEXT,
                parent_id INTEGER DEFAULT 0,
                thread_id INTEGER DEFAULT 0
            )
        `);
    }

    static async create(data) {
        const { messageId, fromAddress, fromName, toAddress, subject, bodyText, bodyHtml, rawContent, isSent = 0, parentId = 0, threadId = 0 } = data;

        const result = await dbAsync.run(`
            INSERT INTO received_emails (message_id, from_address, from_name, to_address, subject, body_text, body_html, raw_content, is_sent, parent_id, thread_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [messageId, fromAddress, fromName, toAddress, subject, bodyText, bodyHtml, rawContent, isSent, parentId, threadId]);

        return await this.findById(result.lastID);
    }

    static async findById(id) {
        return await dbAsync.get('SELECT * FROM received_emails WHERE id = ?', [id]);
    }

    static async findByThreadId(threadId) {
        return await dbAsync.all('SELECT * FROM received_emails WHERE thread_id = ? OR id = ? ORDER BY date_received ASC', [threadId, threadId]);
    }

    static async findAllByUser(email, folder = 'inbox', limit = 50, offset = 0) {
        const isSent = folder === 'sent' ? 1 : 0;
        const addressField = folder === 'sent' ? 'from_address' : 'to_address';

        // Group by thread_id (if exists) or id (if standalone)
        return await dbAsync.all(`
            SELECT *, COUNT(*) as thread_count 
            FROM received_emails 
            WHERE ${addressField} = ? AND is_sent = ? 
            GROUP BY CASE WHEN thread_id > 0 THEN thread_id ELSE id END
            ORDER BY MAX(date_received) DESC 
            LIMIT ? OFFSET ?
        `, [email, isSent, limit, offset]);
    }

    static async countByUser(email, folder = 'inbox') {
        const isSent = folder === 'sent' ? 1 : 0;
        const addressField = folder === 'sent' ? 'from_address' : 'to_address';

        const row = await dbAsync.get(`
            SELECT COUNT(*) as count FROM received_emails 
            WHERE ${addressField} = ? AND is_sent = ?
        `, [email, isSent]);
        return row ? row.count : 0;
    }

    static async markAsRead(id) {
        return await dbAsync.run('UPDATE received_emails SET is_read = 1 WHERE id = ?', [id]);
    }

    static async delete(id) {
        return await dbAsync.run('DELETE FROM received_emails WHERE id = ?', [id]);
    }
}

module.exports = Email;
