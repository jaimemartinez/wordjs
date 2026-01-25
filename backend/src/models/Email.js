/**
 * WordJS - Email Model
 * Interacts with the central database.
 */

const { db, dbAsync, createPluginTable, getDbType } = require('../config/database');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Ensure attachments directory exists
const UPLOAD_DIR = path.join(__dirname, '../../uploads/mail-attachments');
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(err => console.error("Failed to create attachment dir:", err));

class Email {
    static async initSchema() {
        await createPluginTable('received_emails', [
            'id INT_PK',
            'message_id TEXT',
            'from_address TEXT',
            'from_name TEXT',
            'to_address TEXT',
            'cc_address TEXT',  // New: CC support
            'bcc_address TEXT', // New: BCC support
            'subject TEXT',
            'body_text TEXT',
            'body_html TEXT',
            'date_received DATETIME DEFAULT CURRENT_TIMESTAMP',
            'is_read INT DEFAULT 0',
            'is_sent INT DEFAULT 0',
            'is_draft INT DEFAULT 0',
            'is_archived INT DEFAULT 0',
            'is_starred INT DEFAULT 0',
            'is_trash INT DEFAULT 0', // New: Trash support
            'raw_content TEXT',
            'parent_id INT DEFAULT 0',
            'thread_id INT DEFAULT 0',
            'scheduled_at DATETIME' // New: Scheduled Send
        ]);

        await createPluginTable('email_attachments', [
            'id INT_PK',
            'email_id INT',
            'filename TEXT',
            'content_type TEXT',
            'size INT',
            'storage_path TEXT',
            'content_id TEXT',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
        ]);

        // Helper: Check if column exists to avoid "duplicate column" errors
        const columnExists = async (table, col) => {
            const { isPostgres } = getDbType();
            try {
                if (isPostgres) {
                    const res = await dbAsync.get(
                        "SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                        [table, col]
                    );
                    return !!res;
                } else {
                    const cols = await dbAsync.all(`PRAGMA table_info(${table})`);
                    return cols.some(c => c.name === col);
                }
            } catch (e) {
                return false;
            }
        };

        // Add columns if they don't exist (Migration)
        const migrate = async (col, type) => {
            if (!(await columnExists('received_emails', col))) {
                try {
                    await dbAsync.run(`ALTER TABLE received_emails ADD COLUMN ${col} ${type}`);
                    console.log(`[MailServer] Migrated: Added ${col} to received_emails`);
                } catch (e) {
                    // Ignore if race condition or still fails
                }
            }
        };

        await migrate('cc_address', 'TEXT');
        await migrate('bcc_address', 'TEXT');
        await migrate('is_trash', 'INT DEFAULT 0');
        await migrate('scheduled_at', 'DATETIME');
    }

    static async create(data) {
        const {
            messageId, fromAddress, fromName, toAddress, ccAddress = '', bccAddress = '', subject, bodyText, bodyHtml, rawContent,
            isSent = 0, isDraft = 0, isArchived = 0, isStarred = 0, isTrash = 0,
            parentId = 0, threadId = 0, scheduledAt = null
        } = data;

        const result = await dbAsync.run(`
            INSERT INTO received_emails (
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
    }

    static async saveAttachment(emailId, attachment) {
        let storageName = '';
        let size = 0;

        if (attachment.content) {
            // Buffer (incoming)
            const crypto = require('crypto');
            const randomName = crypto.randomBytes(16).toString('hex');
            const ext = path.extname(attachment.filename || '') || '.bin';
            storageName = randomName + ext;
            const fullPath = path.join(UPLOAD_DIR, storageName);

            await fs.writeFile(fullPath, attachment.content);
            size = attachment.content.length;
        } else if (attachment.path) {
            // File path (outgoing/upload)
            const crypto = require('crypto');
            const randomName = crypto.randomBytes(16).toString('hex');
            const ext = path.extname(attachment.filename || '') || '.bin';
            storageName = randomName + ext;
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

        await dbAsync.run(`
            INSERT INTO email_attachments (email_id, filename, content_type, size, storage_path, content_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [emailId, attachment.filename, attachment.contentType, size, storageName, attachment.cid || null]);
    }

    static async update(id, data) {
        const {
            toAddress, ccAddress, bccAddress, subject, bodyText, bodyHtml, rawContent,
            isSent, isDraft
        } = data;

        // Build dynamic query
        let fields = [];
        let params = [];

        if (toAddress !== undefined) { fields.push("to_address = ?"); params.push(toAddress); }
        if (ccAddress !== undefined) { fields.push("cc_address = ?"); params.push(ccAddress); }
        if (bccAddress !== undefined) { fields.push("bcc_address = ?"); params.push(bccAddress); }
        if (subject !== undefined) { fields.push("subject = ?"); params.push(subject); }
        if (bodyText !== undefined) { fields.push("body_text = ?"); params.push(bodyText); }
        if (bodyHtml !== undefined) { fields.push("body_html = ?"); params.push(bodyHtml); }
        if (rawContent !== undefined) { fields.push("raw_content = ?"); params.push(rawContent); }
        if (isSent !== undefined) { fields.push("is_sent = ?"); params.push(isSent); }
        if (isDraft !== undefined) { fields.push("is_draft = ?"); params.push(isDraft); }

        fields.push("date_received = CURRENT_TIMESTAMP");

        params.push(id);

        await dbAsync.run(`
            UPDATE received_emails 
            SET ${fields.join(', ')}
            WHERE id = ?
        `, params);

        return await this.findById(id);
    }

    static async findById(id) {
        return await dbAsync.get('SELECT * FROM received_emails WHERE id = ?', [id]);
    }

    static async findByThreadId(threadId, userEmail = null) {
        let sql = 'SELECT * FROM received_emails WHERE (thread_id = ? OR id = ?) AND is_trash = 0';
        const params = [threadId, threadId];

        if (userEmail) {
            sql += ' AND ((to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) OR (from_address = ? AND is_sent = 1))';
            const likeEmail = `%${userEmail}%`;
            params.push(likeEmail, likeEmail, likeEmail, userEmail, userEmail);
        }

        sql += ' ORDER BY date_received ASC';

        return await dbAsync.all(sql, params);
    }

    static async findAllByUser(email, folder = 'inbox', limit = 50, offset = 0) {
        let whereClause = "";
        let params = [];
        const likeEmail = `%${email}%`;

        // Common excluded check
        const baseExclude = "AND is_trash = 0";

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

        return await dbAsync.all(`
            SELECT *, COUNT(*) as thread_count 
            FROM received_emails 
            WHERE ${whereClause}
            GROUP BY CASE WHEN thread_id > 0 THEN thread_id ELSE id END
            ORDER BY MAX(date_received) DESC 
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
    }

    static async countByUser(email, folder = 'inbox') {
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

        const row = await dbAsync.get(`
            SELECT COUNT(*) as count FROM received_emails 
            WHERE ${whereClause}
        `, params);
        return row ? row.count : 0;
    }

    static async countUnreadInbox(email) {
        const likeEmail = `%${email}%`;
        // Inbox logic: Received, Not Sent, Not Draft, Not Trash, Not Archived, Not Scheduled, Not Read
        const row = await dbAsync.get(`
            SELECT COUNT(*) as count FROM received_emails 
            WHERE (to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ?) 
            AND is_sent = 0 AND is_draft = 0 AND is_trash = 0 AND is_archived = 0 AND scheduled_at IS NULL AND is_read = 0
        `, [likeEmail, likeEmail, likeEmail]);
        return row ? row.count : 0;
    }

    static async markAsRead(id) {
        return await dbAsync.run('UPDATE received_emails SET is_read = 1 WHERE id = ?', [id]);
    }

    static async setStarred(id, state) {
        return await dbAsync.run('UPDATE received_emails SET is_starred = ? WHERE id = ?', [state ? 1 : 0, id]);
    }

    static async setArchived(id, state) {
        return await dbAsync.run('UPDATE received_emails SET is_archived = ? WHERE id = ?', [state ? 1 : 0, id]);
    }

    static async moveToTrash(id) {
        return await dbAsync.run('UPDATE received_emails SET is_trash = 1 WHERE id = ?', [id]);
    }

    static async restoreFromTrash(id) {
        return await dbAsync.run('UPDATE received_emails SET is_trash = 0 WHERE id = ?', [id]);
    }

    static async deletePermanently(id) {
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
        await dbAsync.run('DELETE FROM email_attachments WHERE email_id = ?', [id]);
        return await dbAsync.run('DELETE FROM received_emails WHERE id = ?', [id]);
    }

    static async emptyTrash(userEmail) {
        // Find all trash emails for user to delete attachments
        const limitDate = new Date();
        limitDate.setDate(limitDate.getDate() - 30); // 30 days retention policy could be added later

        // For now, empty everything in trash for this user
        const emails = await dbAsync.all(`
            SELECT id FROM received_emails 
            WHERE (to_address LIKE ? OR from_address = ?) AND is_trash = 1
        `, [`%${userEmail}%`, userEmail]);

        for (const e of emails) {
            await this.deletePermanently(e.id);
        }
    }

    static async searchByUser(email, query, limit = 50) {
        const term = `%${query}%`;
        const likeEmail = `%${email}%`;
        return await dbAsync.all(`
            SELECT * FROM received_emails 
            WHERE (to_address LIKE ? OR cc_address LIKE ? OR bcc_address LIKE ? OR from_address = ?) 
            AND (subject LIKE ? OR body_text LIKE ? OR from_name LIKE ?) AND is_trash = 0
            ORDER BY date_received DESC
            LIMIT ?
        `, [likeEmail, likeEmail, likeEmail, email, term, term, term, limit]);
    }

    static async getPendingScheduled() {
        // Get emails that are NOT sent, NOT drafts, NOT trash, but have a scheduled time <= NOW
        return await dbAsync.all(`
            SELECT * FROM received_emails 
            WHERE is_sent = 0 AND is_draft = 0 AND is_trash = 0 
            AND scheduled_at IS NOT NULL AND scheduled_at <= DATETIME('now', 'localtime')
        `);
    }

    static async getAttachments(emailId) {
        return await dbAsync.all('SELECT * FROM email_attachments WHERE email_id = ?', [emailId]);
    }
}

module.exports = Email;


