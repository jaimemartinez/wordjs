/**
 * WordJS - Universal Notification Service
 * Handles notification registration, persistence, and real-time broadcasting.
 * Designed to be modular and agnostic of specific plugin code.
 */

const { dbAsync } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { hooks } = require('./hooks');
const { verifyPermission } = require('./plugin-context');

// Unique per process — tags bus messages so a node skips re-broadcasting its OWN published echo.
const NODE_ID = require('crypto').randomBytes(8).toString('hex');

class NotificationService {
    transports: Map<string, { handler: Function; pluginSlug: string | null }>;
    clients: Set<any>;

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

        this.registerTransport('sse', async (notification) => {
            // ALWAYS deliver to THIS node's own SSE clients immediately — never depend on the bus
            // round-trip for local delivery (the subscriber may be mid-(re)subscribe, and a 0-receiver
            // publish still "succeeds"). Then, in multi-node, ALSO publish for OTHER nodes, tagged with
            // this node's id so our own echo is skipped on receipt (no double delivery). The 'db'
            // transport persists regardless, so a remote node that's briefly unsubscribed recovers on reload.
            this.broadcast(notification);
            const cache = require('./cache');
            if (cache.pubsubAvailable()) {
                await cache.publish('wordjs:notify', { o: NODE_ID, n: notification });
            }
        });
    }

    /**
     * Subscribe to the cluster notification bus so a notification produced on ANOTHER node is
     * delivered to THIS node's local SSE clients. Call once at boot. No-op without Redis (single node).
     */
    initClusterBus() {
        const cache = require('./cache');
        cache.subscribe('wordjs:notify', (msg) => {
            try {
                const parsed = JSON.parse(msg);
                if (parsed && parsed.o === NODE_ID) return; // our own echo — already delivered locally
                this.broadcast(parsed && parsed.n ? parsed.n : parsed);
            } catch (e: any) { console.warn('[SSE] cluster bus parse error:', e && e.message); }
        });
    }

    /**
     * Register a custom transport (e.g., mail, slack, push)
     * @param {string} name - Transport identifier
     * @param {Function} handler - Function to call when sending a notification
     */
    registerTransport(name, handler) {
        // Capture the registering plugin (if any) so its handler runs in its sandbox context
        // when fired later by core's notify loop (otherwise it would run detached = trusted).
        const { getCurrentPlugin } = require('./plugin-context');
        this.transports.set(name, { handler, pluginSlug: getCurrentPlugin() });
        console.log(`📦 Notification Transport Registered: ${name}`);
    }

    /**
     * Drop every transport a plugin registered. Called when an isolated plugin is unloaded
     * or reloaded, so a dispatched notification is never routed to a dead worker.
     */
    unregisterPluginTransports(slug) {
        for (const [name, t] of this.transports) {
            if (t.pluginSlug === slug) {
                this.transports.delete(name);
                console.log(`🗑️  Notification Transport Unregistered: ${name} (plugin ${slug})`);
            }
        }
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
        const promises: Promise<any>[] = [];
        for (const name of targetTransports) {
            const entry = this.transports.get(name);
            if (entry) {
                const { handler, pluginSlug } = entry;
                const invoke = pluginSlug
                    ? () => require('./plugin-context').runWithContext(pluginSlug, () => handler(notification))
                    : () => handler(notification);
                promises.push(Promise.resolve(invoke()));
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
     * Mark notification as read. Scoped to the owning user so a caller can only act on their OWN
     * notification (the uuid is not a capability — an attacker who learns another user's uuid must not
     * be able to mutate it). Returns true only when a row the user owns was actually updated.
     */
    async markAsRead(uuid, userId) {
        const now = new Date().toISOString();
        // Owner-scoped (uuid is not a capability), BUT user_id=0 is a BROADCAST (sent to all via SSE) and
        // any user may dismiss it — without OR user_id=0 the IDOR fix made broadcasts permanently
        // unactionable (REG-1). A real per-user notification (user_id=X) still can't be touched by others.
        const result = await dbAsync.run(
            'UPDATE notifications SET is_read = 1, read_at = ? WHERE uuid = ? AND (user_id = ? OR user_id = 0)',
            [now, uuid, userId]
        );
        return !!(result && result.changes);
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
     * Delete a notification. Scoped to the owning user (see markAsRead) so a caller can only delete
     * their OWN notification. Returns true only when a row the user owns was actually deleted.
     */
    async deleteNotification(uuid, userId) {
        // Owner-scoped + broadcast (user_id=0) dismissable by any user — see markAsRead (REG-1).
        const result = await dbAsync.run('DELETE FROM notifications WHERE uuid = ? AND (user_id = ? OR user_id = 0)', [uuid, userId]);
        return !!(result && result.changes);
    }

    /**
     * Get notifications for a user
     */
    async getNotifications(userId, limit = 50) {
        const unread = await dbAsync.all(
            'SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT ?',
            [userId, limit]
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
