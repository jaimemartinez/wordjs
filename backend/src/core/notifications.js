/**
 * WordJS - Universal Notification Service
 * Handles notification registration, persistence, and real-time broadcasting.
 * Designed to be modular and agnostic of specific plugin code.
 */

const { dbAsync } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { hooks } = require('./hooks');
const { verifyPermission } = require('./plugin-context');

class NotificationService {
    constructor() {
        this.transports = new Map();
        this.clients = new Set();

        // Register core transports
        this.registerTransport('db', async (notification) => {
            try {
                await dbAsync.run(
                    'INSERT INTO notifications (uuid, user_id, type, title, message, data, created_at, icon, color, action_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        notification.uuid,
                        notification.user_id,
                        notification.type,
                        notification.title,
                        notification.message,
                        notification.data ? JSON.stringify(notification.data) : null,
                        notification.created_at,
                        notification.icon,
                        notification.color,
                        notification.action_url
                    ]
                );
            } catch (e) {
                console.error('❌ Notification DB Transport Error:', e.message);
            }
        });

        this.registerTransport('sse', (notification) => {
            this.broadcast(notification);
        });
    }

    /**
     * Register a custom transport (e.g., mail, slack, push)
     * @param {string} name - Transport identifier
     * @param {Function} handler - Function to call when sending a notification
     */
    registerTransport(name, handler) {
        this.transports.set(name, handler);
        console.log(`📦 Notification Transport Registered: ${name}`);
    }

    /**
     * Register a web client (for SSE)
     */
    addClient(res, userId) {
        res._wordjs_user_id = userId;
        this.clients.add(res);
        console.log(`[SSE] 🔌 Client Connected. User: ${userId}. Total Active Clients: ${this.clients.size}`);

        // Self-cleanup if not handled externally
        // We attach this just in case, but safe to call removeClient manually too
        res.on('close', () => {
            this.removeClient(userId, res);
        });
    }

    /**
     * Remove a client manually
     */
    removeClient(userId, res) {
        if (this.clients.has(res)) {
            this.clients.delete(res);
            console.log(`[SSE] 🔌 Client Disconnected. User: ${userId}. Remaining Active Clients: ${this.clients.size}`);
        }
    }

    /**
     * Send a notification through all (or specific) transports
     * @param {Object} data - { user_id, type, title, message, data, icon, color, transports }
     */
    async send(data) {
        console.log(`📡 Service.send() from current context. Target User: ${data.user_id}, Type: ${data.type}`);
        // Enforce plugin security
        verifyPermission('notifications', 'send');

        const notification = {
            uuid: uuidv4(),
            user_id: data.user_id || 0,
            type: data.type || 'info',
            title: data.title || '',
            message: data.message || '',
            data: data.data || {},
            created_at: new Date().toISOString(),
            // Modern UI support
            icon: data.icon || null, // e.g. 'fa-envelope'
            color: data.color || null, // e.g. 'blue'
            action_url: data.action_url || null
        };

        // Determine which transports to use
        const targetTransports = data.transports || Array.from(this.transports.keys());

        // Execute all relevant transports
        const promises = [];
        for (const name of targetTransports) {
            const handler = this.transports.get(name);
            if (handler) {
                promises.push(Promise.resolve(handler(notification)));
            }
        }

        await Promise.allSettled(promises);

        // Execute Hooks (for other plugins to intercept)
        hooks.doAction('notification_sent', notification);

        return notification;
    }

    broadcast(notification) {
        console.log(`📢 Broadcasting: ID=${notification.uuid}, TargetUser=${notification.user_id}, ActiveClients=${this.clients.size}`);
        const payload = `data: ${JSON.stringify(notification)}\n\n`;
        let sentCount = 0;
        this.clients.forEach(client => {
            // Use loose comparison to avoid Number vs String issues
            // eslint-disable-next-line eqeqeq
            if (notification.user_id == 0 || client._wordjs_user_id == notification.user_id) {
                client.write(payload);
                sentCount++;
                console.log(`   ✅ Sent to client (TargetUser Matches ClientUser ${client._wordjs_user_id})`);
            }
        });
        console.log(`✅ Broadcast finished. Sent to ${sentCount} matching clients.`);
    }

    /**
     * Mark notification as read
     */
    async markAsRead(uuid) {
        const now = new Date().toISOString();
        await dbAsync.run(
            'UPDATE notifications SET is_read = 1, read_at = ? WHERE uuid = ?',
            [now, uuid]
        );
        return true;
    }

    /**
     * Mark all notifications as read for a user
     */
    async markAllAsRead(userId) {
        const now = new Date().toISOString();
        await dbAsync.run(
            'UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0',
            [now, userId]
        );
        return true;
    }

    /**
     * Delete a notification
     */
    async deleteNotification(uuid) {
        await dbAsync.run('DELETE FROM notifications WHERE uuid = ?', [uuid]);
        return true;
    }

    /**
     * Get notifications for a user
     */
    async getNotifications(userId, limit = 50) {
        const unread = await dbAsync.all(
            'SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC',
            [userId]
        );

        const read = await dbAsync.all(
            'SELECT * FROM notifications WHERE user_id = ? AND is_read = 1 ORDER BY created_at DESC LIMIT 5',
            [userId]
        );

        return [...unread, ...read];
    }
}

const notificationService = new NotificationService();

module.exports = notificationService;
