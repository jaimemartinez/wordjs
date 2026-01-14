/**
 * WordJS - Email Model
 * Interacts with the separate email database.
 */

const { emailDb } = require('../config/email-database');

class Email {
    static async create(data) {
        const { messageId, fromAddress, fromName, toAddress, subject, bodyText, bodyHtml, rawContent, isSent = 0, parentId = 0, threadId = 0 } = data;

        const result = emailDb.prepare(`
            INSERT INTO received_emails (message_id, from_address, from_name, to_address, subject, body_text, body_html, raw_content, is_sent, parent_id, thread_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(messageId, fromAddress, fromName, toAddress, subject, bodyText, bodyHtml, rawContent, isSent, parentId, threadId);

        return this.findById(result.lastInsertRowid);
    }

    static findById(id) {
        return emailDb.prepare('SELECT * FROM received_emails WHERE id = ?').get(id);
    }

    static findByThreadId(threadId) {
        return emailDb.prepare('SELECT * FROM received_emails WHERE thread_id = ? OR id = ? ORDER BY date_received ASC').all(threadId, threadId);
    }

    static findAllByUser(email, folder = 'inbox', limit = 50, offset = 0) {
        const isSent = folder === 'sent' ? 1 : 0;
        const addressField = folder === 'sent' ? 'from_address' : 'to_address';

        // Group by thread_id (if exists) or id (if standalone)
        // We select MAX(id) to ensure we get the latest message logic in the group
        return emailDb.prepare(`
            SELECT *, COUNT(*) as thread_count 
            FROM received_emails 
            WHERE ${addressField} = ? AND is_sent = ? 
            GROUP BY CASE WHEN thread_id > 0 THEN thread_id ELSE id END
            ORDER BY MAX(date_received) DESC 
            LIMIT ? OFFSET ?
        `).all(email, isSent, limit, offset);
    }

    static countByUser(email, folder = 'inbox') {
        const isSent = folder === 'sent' ? 1 : 0;
        const addressField = folder === 'sent' ? 'from_address' : 'to_address';

        const row = emailDb.prepare(`
            SELECT COUNT(*) as count FROM received_emails 
            WHERE ${addressField} = ? AND is_sent = ?
        `).get(email, isSent);
        return row ? row.count : 0;
    }

    static markAsRead(id) {
        return emailDb.prepare('UPDATE received_emails SET is_read = 1 WHERE id = ?').run(id);
    }

    static delete(id) {
        return emailDb.prepare('DELETE FROM received_emails WHERE id = ?').run(id);
    }
}

module.exports = Email;
