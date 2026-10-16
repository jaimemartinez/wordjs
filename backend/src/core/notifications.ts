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

/**
 * Every log line of this module goes to STDERR, never stdout. Transports register and notifications
 * fan out from asynchronous callbacks, and under `node --test` a child's stdout is the runner's own
 * report pipe: an asynchronous stdout write (Windows pipes are asynchronous) can land INSIDE one of the
 * runner's serialized frames and kill the whole test file with "Unable to deserialize cloned data" —
 * the same defect core/cache.ts fixed the same way. sandbox-escape-e2e failed exactly so on the Windows
 * sandbox-parity runner, right after "Notification Transport Registered".
 */
const log = (...args: any[]): void => { process.stderr.write(`${require('util').format(...args)}\n`); };

/** Multisite: the site the current work belongs to (site 1 outside any context, as the boot is). */
const siteContext = require('./site-context');
function siteOf(): number {
    return siteContext.currentSiteIdOrNull() ?? siteContext.PRIMARY_SITE_ID;
}

class NotificationService {
    transports: Map<string, { handler: (...args: any[]) => any; pluginSlug: string | null }>;
    // Plugin transports, per site: in a multisite network each site runs its own worker of a plugin, and a
    // transport registered by site A's worker only ever receives site A's notifications. Site 1 / single
    // site: one table, as before.
    siteTransports: Map<number, Map<string, { handler: (...args: any[]) => any; pluginSlug: string | null }>>;
    clients: Set<any>;

    // SSE concurrency caps (DoS backstop — see addClient).
    static readonly MAX_CLIENTS_PER_USER = 8;
    static readonly MAX_TOTAL_CLIENTS = 1000;

    constructor() {
        this.transports = new Map();
        this.siteTransports = new Map();
        this.clients = new Set();

        // Register core transports
        this.registerTransport('db', async (notification: any) => {
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
                log('❌ Notification DB Transport Error:', e.message);
            }
        });

        this.registerTransport('sse', async (notification: any) => {
            // ALWAYS deliver to THIS node's own SSE clients immediately — never depend on the bus
            // round-trip for local delivery (the subscriber may be mid-(re)subscribe, and a 0-receiver
            // publish still "succeeds"). Then, in multi-node, ALSO publish for OTHER nodes, tagged with
            // this node's id so our own echo is skipped on receipt (no double delivery). The 'db'
            // transport persists regardless, so a remote node that's briefly unsubscribed recovers on reload.
            this.broadcast(notification);
            const cache = require('./cache');
            // SAME RULE AS core/collab-rooms.ts#broadcast: the question is "is a cluster leg
            // EXPECTED here?" (configuration), not "is it up right now?". `pubsubAvailable()` is
            // `redisConfigured() && redisAvailable`, so a CONFIGURED-but-DOWN Redis took the
            // single-node branch and the live cross-node delivery was skipped WITHOUT A TRACE.
            // Asking about configuration routes an outage into `publish()`, which logs the
            // degradation. Nothing is lost either way (the 'db' transport persisted it and a remote
            // node picks it up on reload) — but the operator now learns that realtime is degraded
            // instead of the drop being silent.
            if (cache.redisConfigured()) {
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
        cache.subscribe('wordjs:notify', (msg: any) => {
            try {
                const parsed = JSON.parse(msg);
                if (parsed && parsed.o === NODE_ID) return; // our own echo — already delivered locally
                this.broadcast(parsed && parsed.n ? parsed.n : parsed);
            } catch (e: any) { log('[SSE] cluster bus parse error:', e && e.message); }
        });
    }

    /**
     * Register a custom transport (e.g., mail, slack, push)
     * @param {string} name - Transport identifier
     * @param {Function} handler - Function to call when sending a notification
     */
    registerTransport(name: string, handler: (...args: any[]) => any) {
        // Capture the registering plugin (if any) so its handler runs in its sandbox context
        // when fired later by core's notify loop (otherwise it would run detached = trusted).
        const { getCurrentPlugin } = require('./plugin-context');
        const pluginSlug = getCurrentPlugin();
        if (pluginSlug) {
            const id = siteOf();
            let table = this.siteTransports.get(id);
            if (!table) { table = new Map(); this.siteTransports.set(id, table); }
            table.set(name, { handler, pluginSlug });
        } else {
            this.transports.set(name, { handler, pluginSlug: null });
        }
        log(`📦 Notification Transport Registered: ${name}`);
    }

    /**
     * Drop every transport a plugin registered. Called when an isolated plugin is unloaded
     * or reloaded, so a dispatched notification is never routed to a dead worker.
     */
    unregisterPluginTransports(slug: any) {
        const table = this.siteTransports.get(siteOf());
        if (!table) return;
        for (const [name, t] of table) {
            if (t.pluginSlug === slug) {
                table.delete(name);
                log(`🗑️  Notification Transport Unregistered: ${name} (plugin ${slug})`);
            }
        }
    }

    /**
     * Register a web client (for SSE)
     */
    addClient(res: any, userId: any) {
        // DoS backstop: cap concurrent SSE streams per user AND globally. Each stream pins a socket plus a
        // keepalive setInterval and lives in this.clients until close, with no prior limit — so a single
        // low-priv account could open thousands of streams to exhaust FDs/timers/memory on the one shared
        // process. Refuse (and close) a connection past the cap instead of tracking it. Returns false so
        // the caller can stop; existing streams are untouched so legitimate reconnects still work.
        // Multisite: user ids repeat across sites, so a stream belongs to (site, user) and only ever
        // receives its own site's notifications (see broadcast). Site 1 / single site: siteId 1.
        const siteId = siteContext.currentSiteIdOrNull();
        let perUser = 0;
        for (const c of this.clients) { if (c._wordjs_user_id === userId && c._wordjs_site_id === siteId) perUser++; }
        if (this.clients.size >= NotificationService.MAX_TOTAL_CLIENTS || perUser >= NotificationService.MAX_CLIENTS_PER_USER) {
            log(`[SSE] ⛔ Stream refused for user ${userId} (per-user ${perUser}/${NotificationService.MAX_CLIENTS_PER_USER}, total ${this.clients.size}/${NotificationService.MAX_TOTAL_CLIENTS})`);
            try { res.write(`event: error\ndata: ${JSON.stringify({ error: 'too_many_streams' })}\n\n`); } catch { /* best-effort */ }
            try { res.end(); } catch { /* best-effort */ }
            return false;
        }
        res._wordjs_user_id = userId;
        res._wordjs_site_id = siteId;
        this.clients.add(res);
        log(`[SSE] 🔌 Client Connected. User: ${userId}. Total Active Clients: ${this.clients.size}`);

        // Self-cleanup if not handled externally
        // We attach this just in case, but safe to call removeClient manually too
        res.on('close', () => {
            this.removeClient(userId, res);
        });
        return true;
    }

    /**
     * Remove a client manually
     */
    removeClient(userId: any, res: any) {
        if (this.clients.has(res)) {
            this.clients.delete(res);
            log(`[SSE] 🔌 Client Disconnected. User: ${userId}. Remaining Active Clients: ${this.clients.size}`);
        }
    }

    /**
     * Send a notification through all (or specific) transports
     * @param {Object} data - { user_id, type, title, message, data, icon, color, transports }
     */
    async send(data: any) {
        log(`📡 Service.send() from current context. Target User: ${data.user_id}, Type: ${data.type}`);
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
        const siteTable = this.siteTransports.get(siteOf());
        const targetTransports = data.transports
            || Array.from(new Set([...this.transports.keys(), ...(siteTable ? siteTable.keys() : [])]));

        // Execute all relevant transports
        const promises: Promise<any>[] = [];
        for (const name of targetTransports) {
            // This site's plugin transport shadows a core one of the same name (registration used to
            // be last-writer-wins on one table); another site's plugin transports are not visible here.
            const entry = (siteTable && siteTable.get(name)) || this.transports.get(name);
            if (entry) {
                const { handler, pluginSlug } = entry;
                const invoke = pluginSlug
                    ? () => require('./plugin-context').runWithContext(pluginSlug, () => handler(notification))
                    : () => handler(notification);
                promises.push(Promise.resolve(invoke()));
            }
        }

        await Promise.allSettled(promises);

        // Execute Hooks (for other plugins to intercept). The hook payload is REDACTED at the source,
        // like options.ts does for `updated_option` (audit F-02): it fans out to sandboxed plugins, and a
        // notification may carry a reset / verification code, a token in `data`, or a signed link. The
        // delivery transports above received the real notification; listeners get the redacted copy
        // (and plugins additionally need the notifications:read grant — see core/hook-access).
        hooks.doAction('notification_sent', require('./hook-access').redactNotificationForHook(notification));

        return notification;
    }

    broadcast(notification: any) {
        log(`📢 Broadcasting: ID=${notification.uuid}, TargetUser=${notification.user_id}, ActiveClients=${this.clients.size}`);
        const payload = `data: ${JSON.stringify(notification)}\n\n`;
        let sentCount = 0;
        // The site this notification belongs to: the site it is being delivered for (a peer's copy is
        // handled as the site it was published for — core/cache's site envelope).
        const siteId = siteContext.currentSiteIdOrNull();
        this.clients.forEach(client => {
            if (client._wordjs_site_id !== siteId) return;
            // Use loose comparison to avoid Number vs String issues
            if (notification.user_id == 0 || client._wordjs_user_id == notification.user_id) {
                client.write(payload);
                sentCount++;
                log(`   ✅ Sent to client (TargetUser Matches ClientUser ${client._wordjs_user_id})`);
            }
        });
        log(`✅ Broadcast finished. Sent to ${sentCount} matching clients.`);
    }

    /**
     * Mark notification as read. Scoped to the owning user so a caller can only act on their OWN
     * notification (the uuid is not a capability — an attacker who learns another user's uuid must not
     * be able to mutate it). Returns true only when a row the user owns was actually updated.
     */
    async markAsRead(uuid: any, userId: any) {
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
    async markAllAsRead(userId: any) {
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
    async deleteNotification(uuid: any, userId: any) {
        // Owner-scoped + broadcast (user_id=0) dismissable by any user — see markAsRead (REG-1).
        const result = await dbAsync.run('DELETE FROM notifications WHERE uuid = ? AND (user_id = ? OR user_id = 0)', [uuid, userId]);
        return !!(result && result.changes);
    }

    /**
     * Get notifications for a user
     */
    async getNotifications(userId: any, limit = 50) {
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
