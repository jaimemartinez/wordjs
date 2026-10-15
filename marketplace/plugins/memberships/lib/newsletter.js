/**
 * Memberships — newsletters: email a published post to members, Ghost-style.
 *
 * FLOW
 *  1. The author picks «Enviar por correo» in the post editor (a core editor field this plugin declares
 *     through `post_editor_fields`; the value is the post meta `newsletter_audience`: all | free | paid).
 *  2. When the post becomes PUBLISHED (the `wp_insert_post` / `post_updated` hooks), a TRIGGER row is
 *     written — nothing else happens in the publish request.
 *  3. The queue worker (a timer in this isolate, also runnable from the admin) reads the post through the
 *     posts bridge, decides whether it may be sent (author role, audience, not sent before), builds the
 *     recipient list and then sends at most `newsletterRate` mails per minute through `wordjs.mail` — the
 *     site's own mail path (the mail provider plugin), never a transport of its own. Failures retry with
 *     backoff (1, 2, 4 minutes), then count as failed.
 *
 * WHAT EACH RECIPIENT GETS — the leak rule. A post that requires an access level (core content access)
 * goes out in FULL only to members who hold that level; everyone else gets the TEASER (the body before the
 * access break; the author's own excerpt when there is no teaser — never an excerpt derived from the body)
 * and a link to read it on the site. The decision is per recipient, from the same grants the site uses.
 *
 * WHO MAY SEND. Any author can set a meta value, so the meta alone never mails the whole membership: a
 * post written by an administrator or an editor is queued at once; any other author's request waits in
 * the admin's send log for approval.
 *
 * UNSUBSCRIBE. Every mail carries a one-click link to the plugin's portal page
 * (/portal/memberships?u=<id>&t=<token>); the token is an HMAC of the account id under a per-install
 * secret, so it needs no table and cannot be guessed for another account. Members also switch newsletters
 * on and off from the account block. Preferences live in this plugin's table; the default is subscribed.
 */

const AUDIENCES = ['all', 'free', 'paid'];
const META_KEY = 'newsletter_audience';
const ACCESS_BREAK_RE = /<hr\b[^>]*\bclass\s*=\s*["'][^"']*\bwjs-access-break\b[^"']*["'][^>]*>/i;
const AUTO_SEND_ROLES = ['administrator', 'editor'];
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 60 * 1000;
const TRIGGER_DELAY_MS = 3000;       // let the publish request finish writing the post's meta
const TICK_MS = 5000;
const USERS_PAGE = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The body before the access break ('' when the body has none). */
function teaserOf(html) {
    const s = String(html || '');
    const m = s.match(ACCESS_BREAK_RE);
    return m ? s.slice(0, m.index) : '';
}

/** Mail-ready HTML: shortcodes dropped, site-relative URLs made absolute. */
function mailHtml(html, base) {
    return String(html || '')
        .replace(/\[(\/?)[a-z][a-z0-9_-]*(\s[^\]]*)?\]/gi, '')
        .replace(/\b(src|href)\s*=\s*"\/(?!\/)/gi, `$1="${base}/`)
        .replace(/\b(src|href)\s*=\s*'\/(?!\/)/gi, `$1='${base}/`);
}

const textOf = (html) => String(html || '')
    .replace(/<\s*(br|\/p|\/h[1-6]|\/li|\/div)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * @param ctx { wordjs, db, P, getConfig, grantsForUser, getSetting, setSetting, quietly }
 */
async function initNewsletter(ctx) {
    const { wordjs, db, P, getConfig, grantsForUser, getSetting, setSetting, quietly } = ctx;
    const { http, hooks } = wordjs;
    const T = {
        sends: P + 'nl_sends',
        deliveries: P + 'nl_deliveries',
        prefs: P + 'nl_prefs',
        triggers: P + 'nl_triggers',
    };

    await db.run(`CREATE TABLE IF NOT EXISTS ${T.sends} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        audience TEXT NOT NULL,
        is_test INTEGER DEFAULT 0,
        test_variant TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        subject TEXT,
        post_url TEXT,
        requested_by INTEGER,
        total INTEGER DEFAULT 0,
        delivered INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.deliveries} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        send_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        email TEXT NOT NULL,
        variant TEXT NOT NULL DEFAULT 'full',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        next_attempt_at INTEGER DEFAULT 0,
        last_error TEXT,
        sent_at TEXT
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.prefs} (user_id INTEGER PRIMARY KEY, subscribed INTEGER NOT NULL DEFAULT 1, updated_at TEXT)`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.triggers} (post_id INTEGER PRIMARY KEY, due_at INTEGER NOT NULL)`);
    try {
        await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}idx_nl_delivery_unique ON ${T.deliveries} (send_id, email)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_nl_delivery_queue ON ${T.deliveries} (status, next_attempt_at)`);
    } catch (e) { /* exists / unsupported — non-fatal */ }

    const now = () => Date.now();
    const nowIso = () => new Date().toISOString();
    const toInt = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : NaN; };

    // ---- unsubscribe tokens -----------------------------------------------------------------------
    let secret = await getSetting('nl_secret');
    if (!secret) {
        secret = await wordjs.crypto.randomToken(32);
        await setSetting('nl_secret', secret);
    }
    const tokenFor = async (userId) => (await wordjs.crypto.hmac('sha256', secret, `unsubscribe:${Number(userId)}`, 'hex')).slice(0, 32);
    const tokenValid = async (userId, token) => {
        if (!Number.isInteger(userId) || userId < 1 || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return false;
        return wordjs.crypto.timingSafeEqual(token, await tokenFor(userId));
    };

    const isSubscribed = async (userId) => {
        const row = await db.get(`SELECT subscribed FROM ${T.prefs} WHERE user_id = ?`, [userId]);
        return row ? !!row.subscribed : true;
    };
    const setSubscribed = async (userId, subscribed) => {
        const v = subscribed ? 1 : 0;
        const r = await db.run(`UPDATE ${T.prefs} SET subscribed = ?, updated_at = ? WHERE user_id = ?`, [v, nowIso(), userId]);
        if (!r || r.changes === 0) await db.run(`INSERT INTO ${T.prefs} (user_id, subscribed, updated_at) VALUES (?, ?, ?)`, [userId, v, nowIso()]);
    };

    const siteBase = async () => String(await wordjs.site.url()).replace(/\/+$/, '');
    const portalLink = async (userId) => {
        const base = await siteBase();
        if (!userId) return `${base}/portal/memberships`;
        return `${base}/portal/memberships?u=${Number(userId)}&t=${await tokenFor(userId)}`;
    };

    // ---- the editor field ------------------------------------------------------------------------
    hooks.addFilter('post_editor_fields', async (value) => {
        const base = Array.isArray(value) ? value : [];
        const cfg = await getConfig();
        if (cfg.newsletterEnabled === false) return base;
        return [...base, {
            metaKey: META_KEY,
            label: 'Enviar por correo al publicar',
            help: 'a los miembros suscritos; lo reservado solo va completo a quien tiene acceso',
            type: 'select',
            postTypes: ['post'],
            options: [
                { value: '', label: 'No enviar' },
                { value: 'all', label: 'Todos los miembros' },
                { value: 'free', label: 'Solo miembros gratuitos' },
                { value: 'paid', label: 'Solo miembros de pago' },
            ],
        }];
    });

    // ---- publish triggers (the publish request only writes a row) ------------------------------------
    const trigger = async (postId) => {
        const id = toInt(postId);
        if (!Number.isInteger(id) || id < 1) return;
        const due = now() + TRIGGER_DELAY_MS;
        const r = await db.run(`UPDATE ${T.triggers} SET due_at = ? WHERE post_id = ?`, [due, id]);
        if (!r || r.changes === 0) {
            try { await db.run(`INSERT INTO ${T.triggers} (post_id, due_at) VALUES (?, ?)`, [id, due]); } catch (e) { /* raced: already there */ }
        }
    };
    hooks.addAction('wp_insert_post', async (postId, data) => {
        if (data && data.status === 'publish') await trigger(postId);
    });
    hooks.addAction('post_updated', async (postId, data, previousStatus) => {
        if (data && data.status === 'publish' && previousStatus !== 'publish') await trigger(postId);
    });

    /** Turn a published post into a send (or nothing). Returns the send row or a reason. */
    const considerPost = async (postId, opts = {}) => {
        const post = await wordjs.posts.get(postId);
        if (!post) return { reason: 'not a published public post' };
        const audience = opts.audience || String((post.meta && post.meta[META_KEY]) || '').trim();
        if (!AUDIENCES.includes(audience)) return { reason: 'no newsletter requested' };
        const existing = await db.get(`SELECT id FROM ${T.sends} WHERE post_id = ? AND is_test = 0 AND status != 'discarded'`, [post.id]);
        if (existing) return { reason: 'already sent', sendId: existing.id };
        let status = 'queued';
        if (!opts.requestedBy) {
            const author = await wordjs.users.findById(post.authorId).catch(() => null);
            if (!author || !AUTO_SEND_ROLES.includes(author.role)) status = 'pending_approval';
        }
        const r = await db.run(
            `INSERT INTO ${T.sends} (post_id, audience, status, subject, post_url, requested_by) VALUES (?, ?, ?, ?, ?, ?)`,
            [post.id, audience, status, String(post.title || '').slice(0, 300), String(post.url || ''), opts.requestedBy || null]
        );
        return { send: await db.get(`SELECT * FROM ${T.sends} WHERE id = ?`, [r.lastID]) };
    };

    // ---- recipients ----------------------------------------------------------------------------------
    const wantsAudience = (audience, levels) => {
        const member = levels.includes('members');
        const paid = levels.includes('paid');
        if (audience === 'paid') return paid;
        if (audience === 'free') return member && !paid;
        return member || paid;
    };

    /** Every account that is a member in `audience`, subscribed, with an address; and its variant. */
    const buildRecipients = async (send, post) => {
        const out = [];
        const seen = new Set();
        const consider = async (user) => {
            if (!user || seen.has(Number(user.id))) return;
            seen.add(Number(user.id));
            const email = String(user.userEmail || '').trim();
            if (!EMAIL_RE.test(email)) return;
            const levels = await grantsForUser(Number(user.id));
            if (!wantsAudience(send.audience, levels)) return;
            if (!(await isSubscribed(Number(user.id)))) return;
            const variant = post.accessLevel && !levels.includes(post.accessLevel) ? 'teaser' : 'full';
            out.push({ userId: Number(user.id), email, variant });
        };
        // Every account (free members are accounts) …
        for (let offset = 0; offset < 1000000; offset += USERS_PAGE) {
            const page = await wordjs.users.search('', USERS_PAGE, offset);
            if (!Array.isArray(page) || !page.length) break;
            for (const u of page) await consider(u);
            if (page.length < USERS_PAGE) break;
        }
        return out;
    };

    // ---- rendering -----------------------------------------------------------------------------------
    const renderMail = async (post, variant, userId) => {
        const base = await siteBase();
        const link = post.url || `${base}${post.path || '/'}`;
        const unsubscribe = await portalLink(userId);
        let bodyHtml;
        let notice = '';
        if (variant === 'full') {
            // The full body, without the access-break rule itself (a marker, not content).
            bodyHtml = mailHtml(String(post.content || '').replace(ACCESS_BREAK_RE, ''), base);
        } else {
            const teaser = teaserOf(post.content);
            bodyHtml = teaser ? mailHtml(teaser, base) : (post.excerpt ? `<p>${escHtml(post.excerpt)}</p>` : '');
            notice = `<div style="margin:24px 0;padding:16px 18px;border-radius:12px;background:#f5f3ff;border:1px solid #ddd6fe">
                <strong>El resto de esta entrada es para miembros con acceso.</strong><br>
                <a href="${escHtml(link)}" style="color:#4f46e5;font-weight:700">Leer en el sitio →</a></div>`;
        }
        const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111827;line-height:1.6">
            <h1 style="font-size:26px;line-height:1.25;margin:0 0 16px"><a href="${escHtml(link)}" style="color:#111827;text-decoration:none">${escHtml(post.title)}</a></h1>
            ${bodyHtml}
            ${notice}
            <p style="margin-top:28px"><a href="${escHtml(link)}" style="color:#4f46e5">Ver en el sitio</a></p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 12px">
            <p style="font-size:12px;color:#6b7280">Recibes este correo porque eres miembro de ${escHtml(base.replace(/^https?:\/\//, ''))}.
            <a href="${escHtml(unsubscribe)}" style="color:#6b7280">Darte de baja con un clic</a> · puedes volver a suscribirte desde la misma página o desde tu cuenta.</p>
        </div>`;
        const text = `${post.title}\n\n${textOf(bodyHtml)}${variant === 'full' ? '' : '\n\nEl resto de esta entrada es para miembros con acceso. Léela en el sitio:'}\n${link}\n\n—\nDarte de baja: ${unsubscribe}`;
        return { subject: String(post.title || '').slice(0, 300), html, text };
    };

    // ---- the queue worker ----------------------------------------------------------------------------
    const sentAt = []; // timestamps of the last minute's sends (rate limit, process-wide)
    let running = false;

    const finishIfDone = async (sendId) => {
        const left = await db.get(`SELECT COUNT(*) AS n FROM ${T.deliveries} WHERE send_id = ? AND status = 'pending'`, [sendId]);
        if (left && left.n > 0) return;
        const c = await db.get(
            `SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS ko FROM ${T.deliveries} WHERE send_id = ?`,
            [sendId]
        );
        const ok = (c && c.ok) || 0;
        const ko = (c && c.ko) || 0;
        await db.run(`UPDATE ${T.sends} SET status = ?, delivered = ?, failed = ?, finished_at = ? WHERE id = ? AND status = 'sending'`,
            [ok === 0 && ko > 0 ? 'failed' : 'done', ok, ko, nowIso(), sendId]);
    };

    /** One pass: due triggers → sends; queued sends → recipients; pending deliveries → mail (rate-capped). */
    const processQueue = async (opts = {}) => {
        if (running) return { busy: true };
        running = true;
        const summary = { triggered: 0, built: 0, sent: 0, failed: 0, retried: 0 };
        try {
            const t = now();
            const cfg = await getConfig();
            // 1. due publish triggers
            const due = await db.all(`SELECT post_id FROM ${T.triggers} WHERE due_at <= ? ORDER BY due_at ASC LIMIT 20`, [opts.ignoreDelay ? Number.MAX_SAFE_INTEGER : t]);
            for (const row of due) {
                await db.run(`DELETE FROM ${T.triggers} WHERE post_id = ?`, [row.post_id]);
                if (cfg.newsletterEnabled === false) continue;
                const r = await considerPost(row.post_id);
                if (r && r.send) summary.triggered++;
            }
            // 2. queued sends → recipient list
            const queued = await db.all(`SELECT * FROM ${T.sends} WHERE status = 'queued' ORDER BY id ASC LIMIT 5`);
            for (const send of queued) {
                const post = await wordjs.posts.get(send.post_id);
                if (!post) {
                    await db.run(`UPDATE ${T.sends} SET status = 'failed', note = ?, finished_at = ? WHERE id = ?`, ['La entrada ya no está publicada.', nowIso(), send.id]);
                    continue;
                }
                const recipients = send.is_test ? [] : await buildRecipients(send, post);
                for (const r of recipients) {
                    try {
                        await db.run(`INSERT INTO ${T.deliveries} (send_id, user_id, email, variant) VALUES (?, ?, ?, ?)`, [send.id, r.userId, r.email, r.variant]);
                    } catch (e) { /* unique (send, email): already queued */ }
                }
                const total = await db.get(`SELECT COUNT(*) AS n FROM ${T.deliveries} WHERE send_id = ?`, [send.id]);
                await db.run(`UPDATE ${T.sends} SET status = 'sending', total = ? WHERE id = ?`, [(total && total.n) || 0, send.id]);
                summary.built++;
                await finishIfDone(send.id);
            }
            // 3. pending deliveries, within the per-minute budget
            const rate = Math.max(1, Math.min(600, toInt(cfg.newsletterRate) || 60));
            while (sentAt.length && t - sentAt[0] > 60000) sentAt.shift();
            const budget = Math.max(0, rate - sentAt.length);
            const batch = budget ? await db.all(
                `SELECT d.*, s.post_id AS post_id FROM ${T.deliveries} d JOIN ${T.sends} s ON s.id = d.send_id
                 WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND s.status = 'sending' ORDER BY d.id ASC LIMIT ?`,
                [t, budget]
            ) : [];
            const posts = new Map();
            const touched = new Set();
            for (const d of batch) {
                touched.add(d.send_id);
                if (!posts.has(d.post_id)) posts.set(d.post_id, await wordjs.posts.get(d.post_id));
                const post = posts.get(d.post_id);
                if (!post) {
                    await db.run(`UPDATE ${T.deliveries} SET status = 'failed', last_error = ? WHERE id = ?`, ['post no longer published', d.id]);
                    summary.failed++;
                    continue;
                }
                const mail = await renderMail(post, d.variant === 'full' ? 'full' : 'teaser', d.user_id);
                sentAt.push(now());
                try {
                    const result = await wordjs.mail({ to: d.email, subject: mail.subject, html: mail.html, text: mail.text });
                    // The provider's verdict for THIS recipient (mail-server answers { delivered, failed }): a
                    // permanent rejection is final; a transient one is already in the provider's own SMTP retry
                    // queue, so it counts as handed over, with the note kept for the log.
                    const verdict = result && Array.isArray(result.failed)
                        ? result.failed.find((f) => f && String(f.recipient || '').toLowerCase() === d.email.toLowerCase())
                        : null;
                    if (verdict && verdict.permanent) {
                        await db.run(`UPDATE ${T.deliveries} SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
                            [String(verdict.error || 'rejected').slice(0, 300), d.id]);
                        summary.failed++;
                        continue;
                    }
                    await db.run(`UPDATE ${T.deliveries} SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = ? WHERE id = ?`,
                        [nowIso(), verdict ? `En reintento del servidor de correo: ${String(verdict.error || '').slice(0, 250)}` : null, d.id]);
                    summary.sent++;
                } catch (e) {
                    const attempts = (d.attempts || 0) + 1;
                    const msg = String((e && e.message) || e).slice(0, 300);
                    if (attempts >= MAX_ATTEMPTS) {
                        await db.run(`UPDATE ${T.deliveries} SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`, [attempts, msg, d.id]);
                        summary.failed++;
                    } else {
                        await db.run(`UPDATE ${T.deliveries} SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`,
                            [attempts, msg, now() + RETRY_BASE_MS * Math.pow(2, attempts - 1), d.id]);
                        summary.retried++;
                    }
                }
            }
            for (const id of touched) {
                const c = await db.get(
                    `SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS ko FROM ${T.deliveries} WHERE send_id = ?`, [id]);
                await db.run(`UPDATE ${T.sends} SET delivered = ?, failed = ? WHERE id = ?`, [(c && c.ok) || 0, (c && c.ko) || 0, id]);
                await finishIfDone(id);
            }
        } finally {
            running = false;
        }
        return summary;
    };

    const timer = setInterval(() => { processQueue().catch((e) => console.warn('[memberships] newsletter queue:', e && e.message ? e.message : e)); }, TICK_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();

    // ---- public: one-click unsubscribe (portal page) ---------------------------------------------------
    http.route('get', '/public/newsletter', quietly('newsletter status', async (req, res) => {
        const u = toInt(req.query && req.query.u);
        const t = String((req.query && req.query.t) || '');
        if (!(await tokenValid(u, t))) return res.status(400).json({ error: 'Este enlace no es válido.' });
        res.json({ subscribed: await isSubscribed(u) });
    }));
    http.route('post', '/public/newsletter', quietly('newsletter preference', async (req, res) => {
        const body = req.body || {};
        const u = toInt(body.u);
        if (!(await tokenValid(u, String(body.t || '')))) return res.status(400).json({ error: 'Este enlace no es válido.' });
        const subscribed = body.subscribed === true;
        await setSubscribed(u, subscribed);
        res.json({ subscribed });
    }));

    // ---- the member's own preference ---------------------------------------------------------------
    http.route('get', '/me/newsletter', { auth: true }, quietly('newsletter preference', async (req, res) => {
        res.json({ subscribed: await isSubscribed(Number(req.user && req.user.id)), enabled: (await getConfig()).newsletterEnabled !== false });
    }));
    http.route('post', '/me/newsletter', { auth: true }, quietly('newsletter preference', async (req, res) => {
        const subscribed = !!(req.body && req.body.subscribed === true);
        await setSubscribed(Number(req.user && req.user.id), subscribed);
        res.json({ subscribed });
    }));

    // ---- admin -----------------------------------------------------------------------------------------
    const ADMIN = { auth: true, admin: true };
    const sendShape = (s) => ({
        id: s.id, post_id: s.post_id, subject: s.subject, post_url: s.post_url, audience: s.audience,
        is_test: !!s.is_test, status: s.status, total: s.total || 0, delivered: s.delivered || 0, failed: s.failed || 0,
        note: s.note || '', created_at: s.created_at, finished_at: s.finished_at,
    });

    http.route('get', '/newsletter/sends', ADMIN, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.sends} ORDER BY id DESC LIMIT 100`);
        const pending = await db.get(`SELECT COUNT(*) AS n FROM ${T.deliveries} WHERE status = 'pending'`);
        res.json({ sends: rows.map(sendShape), pendingDeliveries: (pending && pending.n) || 0 });
    });

    http.route('get', '/newsletter/sends/:id/deliveries', ADMIN, async (req, res) => {
        const id = toInt(req.params.id);
        const status = ['pending', 'sent', 'failed'].includes(String(req.query && req.query.status)) ? String(req.query.status) : null;
        const rows = await db.all(
            `SELECT id, user_id, email, variant, status, attempts, last_error, sent_at FROM ${T.deliveries} WHERE send_id = ?${status ? ' AND status = ?' : ''} ORDER BY id ASC LIMIT 500`,
            status ? [id, status] : [id]
        );
        res.json({ deliveries: rows });
    });

    // Send a published post now (a resend is refused: one newsletter per post).
    http.route('post', '/newsletter/send', ADMIN, async (req, res) => {
        const postId = toInt(req.body && req.body.post_id);
        const audience = String((req.body && req.body.audience) || '');
        if (!AUDIENCES.includes(audience)) return res.status(400).json({ error: 'Elige a quién enviarlo: todos, gratuitos o de pago.' });
        const r = await considerPost(postId, { audience, requestedBy: Number(req.user && req.user.id) || 1 });
        if (!r.send) return res.status(r.reason === 'already sent' ? 409 : 400).json({ error: r.reason === 'already sent' ? 'Esta entrada ya se envió por correo.' : 'La entrada no está publicada o no es pública.' });
        res.json({ send: sendShape(r.send) });
    });

    // Test send: one mail to one address, as a member with or without access would see it.
    http.route('post', '/newsletter/test', ADMIN, async (req, res) => {
        const body = req.body || {};
        const postId = toInt(body.post_id);
        const email = String(body.email || '').trim().slice(0, 254);
        const variant = body.variant === 'teaser' ? 'teaser' : 'full';
        if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Escribe una dirección de correo válida.' });
        const post = Number.isInteger(postId) ? await wordjs.posts.get(postId) : null;
        if (!post) return res.status(404).json({ error: 'La entrada no está publicada o no es pública.' });
        const r = await db.run(
            `INSERT INTO ${T.sends} (post_id, audience, is_test, test_variant, status, subject, post_url, requested_by, total) VALUES (?, 'test', 1, ?, 'sending', ?, ?, ?, 1)`,
            [post.id, variant, `[Prueba] ${String(post.title || '').slice(0, 280)}`, String(post.url || ''), Number(req.user && req.user.id) || null]
        );
        await db.run(`INSERT INTO ${T.deliveries} (send_id, user_id, email, variant) VALUES (?, 0, ?, ?)`, [r.lastID, email, variant]);
        res.json({ send: sendShape(await db.get(`SELECT * FROM ${T.sends} WHERE id = ?`, [r.lastID])) });
    });

    const setSendStatus = (from, to) => async (req, res) => {
        const id = toInt(req.params.id);
        const r = await db.run(`UPDATE ${T.sends} SET status = ? WHERE id = ? AND status = ?`, [to, id, from]);
        if (!r || r.changes === 0) return res.status(409).json({ error: 'Ese envío ya no está pendiente de aprobación.' });
        res.json({ send: sendShape(await db.get(`SELECT * FROM ${T.sends} WHERE id = ?`, [id])) });
    };
    http.route('post', '/newsletter/sends/:id/approve', ADMIN, setSendStatus('pending_approval', 'queued'));
    http.route('post', '/newsletter/sends/:id/discard', ADMIN, setSendStatus('pending_approval', 'discarded'));

    // Retry the failed deliveries of a send.
    http.route('post', '/newsletter/sends/:id/retry', ADMIN, async (req, res) => {
        const id = toInt(req.params.id);
        const r = await db.run(`UPDATE ${T.deliveries} SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE send_id = ? AND status = 'failed'`, [id]);
        if (r && r.changes > 0) await db.run(`UPDATE ${T.sends} SET status = 'sending', finished_at = NULL WHERE id = ?`, [id]);
        res.json({ requeued: (r && r.changes) || 0 });
    });

    // Run the queue now (the timer does this every few seconds anyway).
    http.route('post', '/newsletter/process', ADMIN, async (req, res) => {
        res.json(await processQueue({ ignoreDelay: !!(req.body && req.body.ignoreDelay) }));
    });

    return {
        processQueue, considerPost, tokenFor, isSubscribed, setSubscribed, renderMail, teaserOf,
        stop() { clearInterval(timer); },
    };
}

module.exports = { initNewsletter, teaserOf, AUDIENCES, META_KEY };
