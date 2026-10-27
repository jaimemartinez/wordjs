/**
 * WordJS — the Redis server the object cache and the cluster bus connect to, from the panel (zero config,
 * QA M2-09): Settings → Performance. It used to be settable only in wordjs-config.json or the REDIS_*
 * environment variables, and the cache switch then said «Redis is active» whether or not a server answered.
 *
 *   GET  /system/redis        what the file says, what is in force, and whether the connection is up
 *   POST /system/redis/test   try a connection (PING) without saving anything
 *   PUT  /system/redis        save it (re-authenticates: currentPassword), audited; the backend restarts itself
 *
 * The connection is opened when the process starts (the cache, the cluster bus, the shared rate-limit store
 * all hold one), so saving restarts the backend, as Security → Server does. The password is never sent back:
 * the screen only learns whether one is stored, and leaving the field empty keeps it. Main site only,
 * network administrators on a network (routes/index.ts).
 */
import type { Request, Response } from 'express';

const express = require('express');
const net = require('net');
const router = express.Router();
const { authenticate, sessionOnly, accountAuthorityOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword, requireSudoConfirmation } = require('./users');
const { recordAudit } = require('../core/audit');

router.use(authenticate, isAdmin);

const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

interface RedisTarget { host: string; port: number; db: number; password?: string }

/** The connection fields of a request, or the field that is wrong. `password` undefined = keep the stored one. */
function checkedTarget(b: any): { ok: true; value: RedisTarget } | { ok: false; param: string; message: string } {
    const host = typeof b.host === 'string' ? b.host.trim() : '';
    if (!host || !(net.isIP(host) || HOSTNAME_RE.test(host))) return { ok: false, param: 'host', message: 'The host is a name (redis.internal) or an IP address.' };
    const port = b.port === undefined || b.port === '' ? 6379 : Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, param: 'port', message: 'The port is a number from 1 to 65535.' };
    const db = b.db === undefined || b.db === '' ? 0 : Number(b.db);
    if (!Number.isInteger(db) || db < 0 || db > 255) return { ok: false, param: 'db', message: 'The database number is from 0 to 255.' };
    let password: string | undefined;
    if (b.password !== undefined && b.password !== null) {
        if (typeof b.password !== 'string' || b.password.length > 512) return { ok: false, param: 'password', message: 'The password is text of at most 512 characters.' };
        password = b.password;
    }
    return { ok: true, value: { host, port, db, password } };
}

function fileRedis(): any {
    const file = require('../core/configManager').getConfig() || {};
    return file.redis && typeof file.redis === 'object' ? file.redis : null;
}

function current() {
    const config = require('../config/app');
    const file = fileRedis();
    const state = require('../core/cache').connectionState();
    return {
        enabled: !!(file && file.enabled === true),
        host: file && typeof file.host === 'string' ? file.host : '127.0.0.1',
        port: file && Number(file.port) ? Number(file.port) : 6379,
        db: file && Number.isInteger(Number(file.db)) ? Number(file.db) : 0,
        passwordSet: !!(file && file.password),
        // Nothing in the file, and REDIS_* in the environment decide it instead: the screen says so.
        fromEnvironment: !file && (process.env.REDIS_ENABLED === 'true' || !!process.env.REDIS_HOST),
        inForce: {
            configured: state.configured,
            connected: state.connected,
            host: state.configured ? String(config.redis.host) : null,
            port: state.configured ? Number(config.redis.port) : null,
        },
        restart: require('../core/restart').restartInfo(),
    };
}

/** One short-lived connection: PING, then close. Never throws; the reason is one of a few words. */
async function tryConnection(t: RedisTarget): Promise<{ ok: boolean; reason?: 'refused' | 'timeout' | 'auth' | 'notfound' | 'failed' }> {
    const Redis = require('ioredis');
    const client = new Redis({
        host: t.host, port: t.port, db: t.db, password: t.password || undefined,
        lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 0, enableOfflineQueue: false,
        retryStrategy: () => null,
    });
    // The socket's own error (ECONNREFUSED, ENOTFOUND…) arrives here; connect() itself then only rejects
    // with «Connection is closed».
    let socketError: any = null;
    client.on('error', (err: any) => { socketError = socketError || err; });
    try {
        await client.connect();
        await client.ping();
        return { ok: true };
    } catch (err: any) {
        const text = [err, socketError].map((e: any) => `${e && e.code ? e.code : ''} ${e && e.message ? e.message : ''}`).join(' ');
        if (/NOAUTH|WRONGPASS|invalid password|AUTH/i.test(text)) return { ok: false, reason: 'auth' };
        if (/ECONNREFUSED/.test(text)) return { ok: false, reason: 'refused' };
        if (/ENOTFOUND|EAI_AGAIN/.test(text)) return { ok: false, reason: 'notfound' };
        if (/ETIMEDOUT|timeout/i.test(text)) return { ok: false, reason: 'timeout' };
        return { ok: false, reason: 'failed' };
    } finally {
        try { client.disconnect(); } catch { /* already closed */ }
    }
}

/**
 * @swagger
 * /system/redis:
 *   get:
 *     summary: The Redis server of the object cache and the cluster bus (Settings → Performance)
 *     description: What wordjs-config.json says (never the password - only whether one is stored), what is in force, and whether this server is connected. Administrators of the main site (network administrators on a network).
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ enabled, host, port, db, passwordSet, fromEnvironment, inForce: { configured, connected, host, port }, restart }"
 *       403:
 *         description: Not an administrator
 *   put:
 *     summary: Save the Redis server, then restart
 *     description: Writes the redis section of wordjs-config.json. An omitted password keeps the stored one; an empty one removes it. Re-authenticates with currentPassword; an interactive session at the main address only; audited (system.redis.update, without the password); the backend then restarts itself to connect.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled, currentPassword]
 *             properties:
 *               enabled:
 *                 type: boolean
 *               host:
 *                 type: string
 *               port:
 *                 type: integer
 *               db:
 *                 type: integer
 *               password:
 *                 type: string
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ ...the new state, restart } — restart is supervisor, watch or service, or manual (restart it by hand)"
 *       400:
 *         description: An invalid value (rest_invalid_param, params names the field)
 *       403:
 *         description: Not an administrator, a wrong currentPassword, an API token or a session from another address
 */
router.get('/', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json(current());
});

/**
 * @swagger
 * /system/redis/test:
 *   post:
 *     summary: Try a connection to a Redis server without saving it
 *     description: Opens one connection, sends PING and closes it (3 s at most). An omitted password uses the stored one - for another host, port or database than the stored ones only with the administrator's currentPassword (403 rest_sudo_required without it). Answers which of refused, timeout, auth, notfound or failed went wrong - never the server's own error text.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               host:
 *                 type: string
 *               port:
 *                 type: integer
 *               db:
 *                 type: integer
 *               password:
 *                 type: string
 *               currentPassword:
 *                 type: string
 *                 description: The administrator's own password; needed only to test another server with the stored password.
 *     responses:
 *       200:
 *         description: "{ ok, reason? }"
 *       400:
 *         description: An invalid value (rest_invalid_param)
 *       403:
 *         description: Not an administrator, an API token or a session from another address
 */
router.post('/test', sessionOnly, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    const t = checkedTarget(req.body || {});
    if (!t.ok) return res.status(400).json({ code: 'rest_invalid_param', message: t.message, data: { status: 400, params: [t.param] } });
    const target = { ...t.value };
    if (target.password === undefined) {
        const file = fileRedis();
        if (file && file.password) {
            // The stored password is reused only for the server it belongs to. Testing ANOTHER host, port
            // or database with it would send the stored secret wherever the form points, so that needs the
            // administrator's own password first (or the password typed into the form).
            const sameServer = String(file.host || '127.0.0.1') === target.host
                && (Number(file.port) || 6379) === target.port && (Number(file.db) || 0) === target.db;
            if (!sameServer && await requireSudoConfirmation(req, res)) return;
            target.password = String(file.password);
        }
    }
    res.set('Cache-Control', 'no-store');
    res.json(await tryConnection(target));
}));

router.put('/', sessionOnly, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    const enabled = b.enabled === true || b.enabled === 'true' || b.enabled === 1 || b.enabled === '1';
    if (b.enabled === undefined) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'enabled is required.', data: { status: 400, params: ['enabled'] } });
    }
    const t = checkedTarget(b);
    if (!t.ok) return res.status(400).json({ code: 'rest_invalid_param', message: t.message, data: { status: 400, params: [t.param] } });
    if (await requireSudoPassword(req, res, b.currentPassword)) return;

    // What the file already says (with the defaults it implies): an unchanged save restarts nothing.
    const prev = fileRedis() || {};
    const same = (prev.enabled === true) === enabled && String(prev.host || '127.0.0.1') === t.value.host
        && (Number(prev.port) || 6379) === t.value.port && (Number(prev.db) || 0) === t.value.db
        && (t.value.password === undefined || String(prev.password || '') === t.value.password);
    if (same) return res.json({ ...current(), restart: null });

    const r = require('../core/configManager').updateConfig((c: any) => {
        const prev = c.redis && typeof c.redis === 'object' ? c.redis : {};
        const redis: any = { ...prev, enabled, host: t.value.host, port: t.value.port, db: t.value.db };
        if (t.value.password !== undefined) {
            if (t.value.password === '') delete redis.password;
            else redis.password = t.value.password;
        }
        return { ...c, redis };
    }, { reload: false });
    if (!r.ok) return res.status(500).json({ code: 'rest_config_unwritable', message: 'wordjs-config.json could not be written.', data: { status: 500 } });
    await recordAudit(req.user && req.user.id, 'system.redis.update', 'config', '', {
        enabled, host: t.value.host, port: t.value.port, db: t.value.db, password: t.value.password === undefined ? 'kept' : (t.value.password ? 'changed' : 'removed'),
    });
    // The cache, the bus and the rate-limit store open their connections when the process starts.
    const mode = require('../core/restart').scheduleRestart('Redis settings changed in the panel');
    res.json({ ...current(), restart: mode });
}));

module.exports = router;
module.exports.checkedTarget = checkedTarget;
