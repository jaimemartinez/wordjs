/**
 * Boarding and bus notices (conference-manager 2.27.0): the transport team tells a bus's passengers that their
 * bus is BOARDING, that it LEFT, or sends them a free MESSAGE — and each passenger who opened «Mi inscripción»
 * on their phone and turned the notices on gets it as a real browser notification (Web Push), even with the
 * page closed. Everyone with the page open sees the same on it (it polls), so nothing depends on push alone.
 *
 * STATE. A bus carries `boarding_status` (null = scheduled | 'boarding' | 'departed') and when each step
 * happened (`boarding_s`, `departed_s`, epoch seconds). Every notice — the two steps and each message — is a
 * row of bus_notices (what the passengers' page lists), with how many phones it reached.
 *
 * SUBSCRIPTIONS. A phone's push subscription belongs to a «Mi inscripción» SESSION (selfpage.js): it is
 * dropped when the person leaves, when the session expires, and when the push service answers it is gone
 * (404 / 410). Only push services' own hosts are accepted as endpoints (FCM, Mozilla, Apple, Windows), so the
 * plugin never POSTs to an address a client chose.
 *
 * WEB PUSH, by hand (no library in the sandbox): the payload is encrypted per RFC 8291 (aes128gcm: ECDH P-256
 * with the phone's key + HKDF-SHA256 + AES-128-GCM) and the request signed per RFC 8292 (VAPID: an ES256 JWT
 * over the push service's origin). The site's VAPID key pair is generated once and kept in push_keys. Sending
 * needs the «network» permission; without it the notices still reach every open page, and the admin is told.
 *
 * SQL: own prefixed tables, a space before a closing parenthesis after a table name, no `$`, portable.
 */
'use strict';

const crypto = require('crypto');

const STATUSES = new Set(['boarding', 'departed']);
const KINDS = new Set(['boarding', 'departed', 'message', 'reset']);
const MAX_TEXT = 240;
const MAX_SUBS_PER_PERSON = 5;
const SEND_CONCURRENCY = 10;
const SEND_TIMEOUT_MS = 10000;
const TTL_S = 2 * 3600;
// The push services of the browsers in use: Chrome / Edge-Chromium / Samsung / Opera / Brave (FCM), Firefox,
// Safari (iOS 16.4+ home-screen apps, macOS), legacy Edge (WNS).
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;

const nowS = () => Math.floor(Date.now() / 1000);
const isoOf = (s) => (s == null || !Number(s) ? null : new Date(Number(s) * 1000).toISOString());
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** A push endpoint the plugin may POST to: https, a push service's host, a sane length. Returns the URL or null. */
function pushEndpoint(v) {
    if (typeof v !== 'string' || v.length > 1024) return null;
    let u;
    try { u = new URL(v); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    return PUSH_HOSTS.test(u.hostname) ? u : null;
}

/** The phone's keys: p256dh = an uncompressed P-256 point (65 bytes), auth = 16 bytes. null when malformed. */
function pushKeys(keys) {
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
    if (keys.p256dh.length > 120 || keys.auth.length > 40) return null;
    const p = unb64u(keys.p256dh), a = unb64u(keys.auth);
    if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return null;
    return { p256dh: b64u(p), auth: b64u(a) };
}

/**
 * RFC 8291 aes128gcm body for `payload` to the phone keys { p256dh, auth } (base64url). One record (payload ≤ 3 KB).
 * `opts.salt` / `opts.ecdh` exist for the tests (fixed vectors); production uses fresh random ones.
 */
function encryptPayload(payload, keys, opts = {}) {
    const uaPublic = unb64u(keys.p256dh);
    const authSecret = unb64u(keys.auth);
    const ecdh = opts.ecdh || crypto.createECDH('prime256v1');
    if (!opts.ecdh) ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(uaPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
    const salt = opts.salt || crypto.randomBytes(16);
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    // 0x02 = the last (only) record's padding delimiter.
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096, 0);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** RFC 8292 VAPID Authorization header for `endpoint` (a URL), signed with the site key { publicKey, privateJwk }. */
function vapidHeader(endpoint, key, subject) {
    const aud = `${endpoint.protocol}//${endpoint.host}`;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud, exp: nowS() + 12 * 3600, sub: subject }));
    const pk = crypto.createPrivateKey({ key: key.privateJwk, format: 'jwk' });
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: pk, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${key.publicKey}`;
}

/** A fresh VAPID key pair: the public key as the browser wants it (uncompressed point, base64url) + the private JWK. */
function newVapidKey() {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
    return { publicKey, privateJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** The global fetch when the plugin holds «network», else null (the sandbox's getter throws without it). */
function netFetch() {
    try { return typeof fetch === 'function' ? fetch : null; } catch (e) { return null; }
}

function createPush(base) {
    const { db, T, P, addColumnIfMissing, createIndex, createUniqueIndex } = base;
    T.pushSubs = `${P}push_subs`;
    T.pushKeys = `${P}push_keys`;
    T.busNotices = `${P}bus_notices`;
    let D = null;
    let ready = false;
    let keyCache = null;

    async function migrate() {
        await addColumnIfMissing(T.buses, 'boarding_status', 'TEXT');
        await addColumnIfMissing(T.buses, 'boarding_s', 'INT');
        await addColumnIfMissing(T.buses, 'departed_s', 'INT');
        await db.createTable(T.pushKeys, [
            'id INT_PK',
            'public_key TEXT NOT NULL',
            'private_jwk TEXT NOT NULL',
            'created_s INT',
        ]);
        await db.createTable(T.pushSubs, [
            'id INT_PK',
            'session_id INT NOT NULL',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'endpoint TEXT NOT NULL',
            'endpoint_hash VARCHAR(64) NOT NULL',
            'p256dh VARCHAR(100) NOT NULL',
            'auth VARCHAR(40) NOT NULL',
            'origin TEXT',
            'created_s INT',
            'fails INT DEFAULT 0',
            `FOREIGN KEY (session_id) REFERENCES ${T.selfSessions}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_push_subs_endpoint`, T.pushSubs, 'endpoint_hash');
        await createIndex(`${P}idx_push_subs_ins`, T.pushSubs, 'inscription_id');
        await createIndex(`${P}idx_push_subs_session`, T.pushSubs, 'session_id');
        // 2.36.5: the phone's language (es / en / pt), so a meal call reaches it in that language.
        await addColumnIfMissing(T.pushSubs, 'lang', 'VARCHAR(8)');
        await db.createTable(T.busNotices, [
            'id INT_PK',
            'bus_id INT NOT NULL',
            'conference_id INT NOT NULL',
            'kind VARCHAR(20) NOT NULL',
            'text TEXT',
            'created_s INT NOT NULL',
            'created_by TEXT',
            'recipients INT DEFAULT 0',
            'sent INT DEFAULT 0',
            'failed INT DEFAULT 0',
            `FOREIGN KEY (bus_id) REFERENCES ${T.buses}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_bus_notices_bus`, T.busNotices, 'bus_id');
        // Subscriptions of sessions already gone (a database without enforced foreign keys keeps them).
        try { await db.run(`DELETE FROM ${T.pushSubs} WHERE session_id NOT IN (SELECT id FROM ${T.selfSessions} )`); } catch (e) { /* best effort */ }
        ready = true;
    }
    const ensureReady = async () => {
        if (ready) return true;
        try { await migrate(); } catch (e) { console.warn('[conference-manager] bus notices schema:', e && e.message); }
        return ready;
    };

    /** The site's VAPID key pair, made on first use. */
    async function siteKey() {
        if (keyCache) return keyCache;
        let row = await db.get(`SELECT public_key, private_jwk FROM ${T.pushKeys} ORDER BY id ASC LIMIT 1`);
        if (!row) {
            const k = newVapidKey();
            await db.run(`INSERT INTO ${T.pushKeys} (public_key, private_jwk, created_s) VALUES (?, ?, ?)`, [k.publicKey, JSON.stringify(k.privateJwk), nowS()]);
            // Two processes racing: both keep the FIRST row.
            row = await db.get(`SELECT public_key, private_jwk FROM ${T.pushKeys} ORDER BY id ASC LIMIT 1`);
        }
        keyCache = { publicKey: row.public_key, privateJwk: JSON.parse(row.private_jwk) };
        return keyCache;
    }

    // ── what a passenger sees ──
    const busState = (b) => ({
        status: STATUSES.has(b.boarding_status) ? b.boarding_status : 'scheduled',
        boarding_at: isoOf(b.boarding_s),
        departed_at: isoOf(b.departed_s),
    });
    /** The buses this inscription travels on, with their state and their last notices (newest first). */
    async function transportOf(ins) {
        if (!await ensureReady()) return [];
        const buses = await db.all(
            `SELECT b.id, b.name, b.origin, b.destination, b.departure, b.boarding_status, b.boarding_s, b.departed_s FROM ${T.tickets} t JOIN ${T.buses} b ON b.id = t.bus_id`
            + ' WHERE t.inscription_id = ? AND b.conference_id = ? ORDER BY b.departure, b.name', [ins.id, ins.conference_id]);
        const out = [];
        for (const b of buses) {
            const notices = await db.all(`SELECT kind, text, created_s FROM ${T.busNotices} WHERE bus_id = ? ORDER BY created_s DESC, id DESC LIMIT 5`, [b.id]);
            out.push({
                id: b.id, name: b.name, origin: b.origin || null, destination: b.destination || null, departure: b.departure || null,
                ...busState(b),
                notices: notices.map(n => ({ kind: n.kind, text: n.text || null, at: isoOf(n.created_s) })),
            });
        }
        return out;
    }

    // ── sending ──
    let subjectCache = null;
    async function subjectOf(sub) {
        const site = D && D.siteLinkBase ? await D.siteLinkBase() : null;
        if (site && /^https:\/\//i.test(site)) return site;
        if (sub.origin && /^https:\/\/[^\s/]+$/i.test(sub.origin)) return sub.origin;
        return subjectCache || (subjectCache = 'mailto:webpush@wordjs.invalid');
    }
    async function sendOne(f, sub, body, key) {
        const endpoint = pushEndpoint(sub.endpoint);
        if (!endpoint) { await db.run(`DELETE FROM ${T.pushSubs} WHERE id = ?`, [sub.id]); return 'gone'; }
        let status = 0;
        try {
            const res = await f(endpoint.href, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Encoding': 'aes128gcm',
                    TTL: String(TTL_S),
                    Urgency: 'high',
                    Authorization: vapidHeader(endpoint, key, await subjectOf(sub)),
                },
                body: encryptPayload(body, sub),
                redirect: 'error',
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
            status = res.status;
            if (status < 200 || status >= 300) {
                let why = '';
                try { why = String(await res.text()).replace(/\s+/g, ' ').slice(0, 160); } catch (e) { /* none */ }
                console.warn(`[conference-manager] push to ${endpoint.host} answered ${status}${why ? `: ${why}` : ''}`);
            } else {
                try { await res.arrayBuffer(); } catch (e) { /* body not needed */ }
            }
        } catch (e) {
            status = 0;
            console.warn(`[conference-manager] push to ${endpoint.host} failed: ${e && e.message ? e.message : e}`);
        }
        if (status >= 200 && status < 300) {
            if (Number(sub.fails)) await db.run(`UPDATE ${T.pushSubs} SET fails = 0 WHERE id = ?`, [sub.id]);
            return 'sent';
        }
        // Gone for good (unsubscribed / expired), or the keys no longer fit it.
        if (status === 404 || status === 410) { await db.run(`DELETE FROM ${T.pushSubs} WHERE id = ?`, [sub.id]); return 'gone'; }
        await db.run(`UPDATE ${T.pushSubs} SET fails = fails + 1 WHERE id = ?`, [sub.id]);
        await db.run(`DELETE FROM ${T.pushSubs} WHERE id = ? AND fails >= 20`, [sub.id]);
        return 'failed';
    }
    /** Push `payload` to every phone of this bus's passengers. → { subscribers, sent, failed, network }. */
    async function pushToBus(bus, payload) {
        await db.run(`DELETE FROM ${T.pushSubs} WHERE session_id IN (SELECT id FROM ${T.selfSessions} WHERE expires_s < ? )`, [nowS()]);
        const subs = await db.all(
            `SELECT s.* FROM ${T.pushSubs} s JOIN ${T.tickets} t ON t.inscription_id = s.inscription_id JOIN ${T.inscriptions} i ON i.id = s.inscription_id`
            + ' WHERE t.bus_id = ? AND i.status <> ? ORDER BY s.id', [bus.id, 'cancelled']);
        const out = { subscribers: subs.length, sent: 0, failed: 0, network: true };
        if (!subs.length) return out;
        const f = netFetch();
        if (!f) { out.network = false; out.failed = subs.length; return out; }
        const key = await siteKey();
        const body = JSON.stringify(payload);
        for (let i = 0; i < subs.length; i += SEND_CONCURRENCY) {
            const results = await Promise.all(subs.slice(i, i + SEND_CONCURRENCY).map(s => sendOne(f, s, body, key).catch(() => 'failed')));
            for (const r of results) { if (r === 'sent') out.sent++; else out.failed++; }
        }
        return out;
    }

    /**
     * Push to the phones of these people (2.36.5: a meal group called). `payloadFor(lang)` builds the notice in each
     * phone's language. → { subscribers, sent, failed, network }.
     */
    async function pushToPeople(ids, payloadFor) {
        const out = { subscribers: 0, sent: 0, failed: 0, network: true };
        const list = [...new Set((ids || []).map(Number).filter(Boolean))];
        if (!list.length) return out;
        if (!await ensureReady()) return out;
        await db.run(`DELETE FROM ${T.pushSubs} WHERE session_id IN (SELECT id FROM ${T.selfSessions} WHERE expires_s < ? )`, [nowS()]);
        const subs = [];
        for (let i = 0; i < list.length; i += 500) {
            const chunk = list.slice(i, i + 500);
            subs.push(...await db.all(`SELECT * FROM ${T.pushSubs} WHERE inscription_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY id`, chunk));
        }
        out.subscribers = subs.length;
        if (!subs.length) return out;
        const f = netFetch();
        if (!f) { out.network = false; out.failed = subs.length; return out; }
        const key = await siteKey();
        const bodies = new Map();
        const bodyOf = (lang) => { const l = ['es', 'en', 'pt'].includes(lang) ? lang : 'es'; if (!bodies.has(l)) bodies.set(l, JSON.stringify(payloadFor(l))); return bodies.get(l); };
        for (let i = 0; i < subs.length; i += SEND_CONCURRENCY) {
            const results = await Promise.all(subs.slice(i, i + SEND_CONCURRENCY).map(s => sendOne(f, s, bodyOf(s.lang), key).catch(() => 'failed')));
            for (const r of results) { if (r === 'sent') out.sent++; else out.failed++; }
        }
        return out;
    }

    const routeOf = (b) => [b.origin, b.destination].filter(Boolean).join(' → ');
    function payloadOf(kind, bus, text) {
        const route = routeOf(bus);
        const tag = `cm-bus-${bus.id}`;
        if (kind === 'boarding') return { kind, tag, title: `Tu bus está embarcando: ${bus.name}`, body: `${route ? `${route}. ` : ''}Acércate al punto de salida con tu escarapela.` };
        if (kind === 'departed') return { kind, tag, title: `Tu bus salió: ${bus.name}`, body: route ? `${route}.` : 'El bus ya salió.' };
        return { kind, tag: `${tag}-m${Date.now()}`, title: `Mensaje de tu bus: ${bus.name}`, body: text };
    }

    // ── routes ──
    function install(deps) {
        D = deps;
        const { http, allow, positiveInt, sendError, actorOf } = deps;
        const MSG = deps.selfMessages || {};

        // POST /buses/:id/notice { kind: boarding | departed | message | reset, text? } — transport:manage.
        // Steps move the bus's state and notify; a message only notifies; reset puts the bus back to scheduled
        // (no notice). → { success, bus: { status, boarding_at, departed_at }, delivery? }.
        http.route('post', '/buses/:id/notice', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            if (!await ensureReady()) return res.status(503).json({ error: 'Los avisos del bus no están disponibles todavía.' });
            try {
                const id = positiveInt(req.params.id);
                const bus = id ? await db.get(`SELECT * FROM ${T.buses} WHERE id = ?`, [id]) : null;
                if (!bus) return res.status(404).json({ error: 'Bus no encontrado.' });
                const body = req.body || {};
                const kind = String(body.kind || '');
                if (!KINDS.has(kind)) return res.status(400).json({ error: 'Aviso no válido.' });
                const text = kind === 'message' ? String(body.text == null ? '' : body.text).replace(/\s+/g, ' ').trim() : '';
                if (kind === 'message' && !text) return res.status(400).json({ error: 'Escribe el mensaje.' });
                if (text.length > MAX_TEXT) return res.status(400).json({ error: `El mensaje admite hasta ${MAX_TEXT} caracteres.` });
                const t = nowS();
                if (kind === 'reset') {
                    await db.run(`UPDATE ${T.buses} SET boarding_status = NULL, boarding_s = NULL, departed_s = NULL WHERE id = ?`, [id]);
                } else if (kind === 'boarding') {
                    await db.run(`UPDATE ${T.buses} SET boarding_status = ?, boarding_s = ?, departed_s = NULL WHERE id = ?`, ['boarding', t, id]);
                } else if (kind === 'departed') {
                    await db.run(`UPDATE ${T.buses} SET boarding_status = ?, boarding_s = COALESCE(boarding_s, ?), departed_s = ? WHERE id = ?`, ['departed', t, t, id]);
                }
                const fresh = await db.get(`SELECT * FROM ${T.buses} WHERE id = ?`, [id]);
                if (kind === 'reset') return res.json({ success: true, bus: busState(fresh) });
                const actor = actorOf ? actorOf(req) : null;
                const r = await db.run(`INSERT INTO ${T.busNotices} (bus_id, conference_id, kind, text, created_s, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
                    [id, bus.conference_id, kind, text || null, t, actor]);
                const delivery = await pushToBus(fresh, payloadOf(kind, fresh, text));
                await db.run(`UPDATE ${T.busNotices} SET recipients = ?, sent = ?, failed = ? WHERE id = ?`, [delivery.subscribers, delivery.sent, delivery.failed, r.lastID]);
                res.json({ success: true, bus: busState(fresh), delivery });
            } catch (e) { sendError(res, e); }
        });

        // GET /buses/:id/notices → the bus's notices, newest first (transport:view).
        http.route('get', '/buses/:id/notices', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'view')) return;
            if (!await ensureReady()) return res.json([]);
            try {
                const id = positiveInt(req.params.id);
                const rows = id ? await db.all(`SELECT id, kind, text, created_s, recipients, sent, failed FROM ${T.busNotices} WHERE bus_id = ? ORDER BY created_s DESC, id DESC LIMIT 50`, [id]) : [];
                res.json(rows.map(n => ({ id: n.id, kind: n.kind, text: n.text || null, at: isoOf(n.created_s), recipients: Number(n.recipients) || 0, sent: Number(n.sent) || 0, failed: Number(n.failed) || 0 })));
            } catch (e) { sendError(res, e); }
        });

        // ── the passenger's side («Mi inscripción» session) ──
        const refuse = (res, code) => res.status(code === 'session' ? 401 : 410).json({ error: MSG[code] || 'No disponible.', code });
        const withSession = async (req, res) => {
            if (!await ensureReady() || !await D.selfPage.ensureReady()) { res.status(503).json({ error: 'No disponible todavía.', code: 'unavailable' }); return null; }
            const s = await D.selfPage.sessionOf((req.body || {}).session);
            if (!s) { refuse(res, 'session'); return null; }
            if (s.st.code) { refuse(res, s.st.code); return null; }
            return s;
        };

        // POST /public/me/transport { session } → { transport, push_key } — what the page polls.
        http.route('post', '/public/me/transport', async (req, res) => {
            try {
                const s = await withSession(req, res);
                if (!s) return;
                res.json({ transport: await transportOf(s.st.ins), push_key: (await siteKey()).publicKey });
            } catch (e) { sendError(res, e); }
        });

        // POST /public/me/push/subscribe { session, subscription: { endpoint, keys: { p256dh, auth } } } → { success }.
        http.route('post', '/public/me/push/subscribe', async (req, res) => {
            try {
                const s = await withSession(req, res);
                if (!s) return;
                const sub = (req.body || {}).subscription || {};
                const endpoint = pushEndpoint(sub.endpoint);
                const keys = pushKeys(sub.keys);
                if (!endpoint || !keys) return res.status(400).json({ error: 'Este navegador no ofrece avisos compatibles.', code: 'subscription' });
                const hash = sha256(endpoint.href);
                const origin = req.headers && typeof req.headers.origin === 'string' ? req.headers.origin.slice(0, 200) : null;
                const ins = s.st.ins;
                await db.run(`DELETE FROM ${T.pushSubs} WHERE endpoint_hash = ?`, [hash]);
                // 2.36.5: the phone's language (es / en / pt) for the notices that have one; anything else = Spanish.
                const lang = ['es', 'en', 'pt'].includes(String((req.body || {}).lang || '').slice(0, 2).toLowerCase()) ? String(req.body.lang).slice(0, 2).toLowerCase() : null;
                await db.run(`INSERT INTO ${T.pushSubs} (session_id, conference_id, inscription_id, endpoint, endpoint_hash, p256dh, auth, origin, created_s, fails, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
                    [s.session.id, ins.conference_id, ins.id, endpoint.href, hash, keys.p256dh, keys.auth, origin, nowS(), lang]);
                // A few phones per person at most: the oldest go.
                const mine = await db.all(`SELECT id FROM ${T.pushSubs} WHERE inscription_id = ? ORDER BY created_s DESC, id DESC`, [ins.id]);
                for (const old of mine.slice(MAX_SUBS_PER_PERSON)) await db.run(`DELETE FROM ${T.pushSubs} WHERE id = ?`, [old.id]);
                res.json({ success: true });
            } catch (e) { sendError(res, e); }
        });

        // POST /public/me/push/unsubscribe { session, endpoint } → { success } (never refused once the session is valid).
        http.route('post', '/public/me/push/unsubscribe', async (req, res) => {
            try {
                const s = await withSession(req, res);
                if (!s) return;
                const endpoint = pushEndpoint((req.body || {}).endpoint);
                if (endpoint) await db.run(`DELETE FROM ${T.pushSubs} WHERE endpoint_hash = ? AND inscription_id = ?`, [sha256(endpoint.href), s.st.ins.id]);
                res.json({ success: true });
            } catch (e) { sendError(res, e); }
        });
    }

    /** Per bus of a conference: { alerts: passengers with notices on, ...state } (GET /buses). */
    async function busSummaries(cid) {
        const out = new Map();
        if (!await ensureReady()) return out;
        const rows = await db.all(
            `SELECT t.bus_id, COUNT(DISTINCT s.inscription_id) AS n FROM ${T.pushSubs} s JOIN ${T.tickets} t ON t.inscription_id = s.inscription_id JOIN ${T.selfSessions} x ON x.id = s.session_id`
            + ' WHERE s.conference_id = ? AND x.expires_s >= ? GROUP BY t.bus_id', [cid, nowS()]);
        for (const r of rows) out.set(Number(r.bus_id), Number(r.n) || 0);
        return out;
    }
    /** Drop the phones of one session (the person left «Mi inscripción»). */
    async function dropSession(sessionId) {
        if (!await ensureReady()) return;
        await db.run(`DELETE FROM ${T.pushSubs} WHERE session_id = ?`, [sessionId]);
    }

    return { migrate, ensureReady, install, transportOf, busState, busSummaries, dropSession, siteKey, pushToPeople };
}

module.exports = { createPush, encryptPayload, vapidHeader, newVapidKey, pushEndpoint, pushKeys };
