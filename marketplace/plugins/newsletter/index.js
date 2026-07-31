/**
 * WordJS Plugin: Newsletter — ISOLATED, sandboxed.
 *
 * WordPress parity: Mailchimp for WP / The Newsletter Plugin.
 * Visitors subscribe through the Puck "Newsletter" block; the plugin tries double opt-in
 * (confirmation email with a tokenized link back to the subscribing page). When mail is not
 * available (no provider configured / no email:admin grant) it degrades to single opt-in:
 * the subscriber is confirmed immediately and the visitor is told so.
 *
 * Admins manage subscribers (filter/search/delete/CSV export) and compose HTML campaigns that
 * are sent sequentially to every CONFIRMED subscriber with a per-subscriber unsubscribe footer.
 *
 * Sandbox notes:
 *  - All tables live under the enforced prefix (db.tablePrefix -> 'wjp_newsletter_').
 *  - No crypto API exists in the sandbox: tokens come from a Math.random loop. That is acceptable
 *    here because the tokens gate low-value actions (confirm/unsubscribe) and the public
 *    subscribe endpoint is rate limited, which is the real defense.
 *  - The db bridge has no transactions; every state change is a single statement.
 *  - res.send(string) would be JSON-encoded by the isolate, so EVERYTHING (including the CSV
 *    export) is returned via res.json; the admin client builds the download Blob itself.
 */

exports.metadata = {
    name: 'Newsletter',
    version: '1.0.0',
    description: 'Newsletter subscriptions (double opt-in) + HTML campaigns with unsubscribe links',
    author: 'WordJS',
};

exports.init = async function (wordjs) {
    const { db, http, adminMenu, mail } = wordjs;

    console.log('[newsletter] initializing plugin...');

    // Per-plugin table namespace enforced by the host. slug 'newsletter' -> 'wjp_newsletter_'.
    const P = db.tablePrefix;
    const T = {
        subscribers: P + 'subscribers',
        campaigns: P + 'campaigns',
    };

    // ── schema (idempotent, full column set up-front — no ALTER TABLE in the sandbox) ────────────
    async function initSchema() {
        await db.run(
            'CREATE TABLE IF NOT EXISTS ' + T.subscribers + ' (' +
            'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
            'email TEXT NOT NULL UNIQUE, ' +
            'name TEXT, ' +
            "status TEXT NOT NULL DEFAULT 'pending', " +          // 'pending' | 'confirmed' | 'unsubscribed'
            'token TEXT NOT NULL, ' +
            'source_url TEXT, ' +
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP, ' +
            'confirmed_at DATETIME' +
            ')'
        );
        await db.run(
            'CREATE TABLE IF NOT EXISTS ' + T.campaigns + ' (' +
            'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
            'subject TEXT NOT NULL, ' +
            'body_html TEXT NOT NULL, ' +
            "status TEXT DEFAULT 'draft', " +                     // 'draft' | 'sent'
            'sent_count INTEGER DEFAULT 0, ' +
            'fail_count INTEGER DEFAULT 0, ' +
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP, ' +
            'sent_at DATETIME' +
            ')'
        );
        // Lookup indexes for the public token endpoints and the admin status filter.
        try {
            await db.run('CREATE INDEX IF NOT EXISTS ' + P + 'idx_subscribers_token ON ' + T.subscribers + ' (token)');
            await db.run('CREATE INDEX IF NOT EXISTS ' + P + 'idx_subscribers_status ON ' + T.subscribers + ' (status)');
        } catch (e) {
            // Index creation is best-effort; the tables work without them.
        }
    }
    await initSchema();

    // ── helpers ───────────────────────────────────────────────────────────────────────────────────

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    /**
     * 32-hex-char token for the confirm/unsubscribe links. The "no crypto API in the sandbox" note was
     * FALSE — the host CSPRNG is bridged as `wordjs.crypto.randomToken` (many plugins use it). The gated
     * actions are low-value (double opt-in confirm / unsubscribe) and the read path is an exact token
     * match, but Math.random is V8 xorshift128+ (predictable), so a CSPRNG token is the correct default.
     * Async (RPC to the host).
     */
    async function genToken() {
        return wordjs.crypto.randomToken(16); // 32 hex chars
    }

    /** Escape a value for interpolation into email HTML. */
    function escapeHtml(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Sanitize the page URL the visitor subscribed from: must parse as http(s), keep only
     * origin + pathname (drops query/hash/credentials), capped at 500 chars. Returns '' when invalid.
     */
    function sanitizePageUrl(raw) {
        try {
            const u = new URL(String(raw || ''));
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            return (u.origin + u.pathname).slice(0, 500);
        } catch (e) {
            return '';
        }
    }

    // Global in-memory rate limit for the public subscribe endpoint (handlers get no req.ip in the
    // sandbox, so per-IP limiting is impossible — a global cap still stops bulk abuse).
    const SUB_MAX = 20;                 // max subscribes...
    const SUB_WINDOW_MS = 60 * 1000;    // ...per rolling minute
    let subWindow = { count: 0, first: 0 };
    function subscribeThrottled() {
        const now = Date.now();
        if (now - subWindow.first >= SUB_WINDOW_MS) subWindow = { count: 0, first: now };
        subWindow.count++;
        return subWindow.count > SUB_MAX;
    }

    /** Spec footer appended to every campaign email, personalized per subscriber. */
    function buildUnsubFooter(unsubUrl) {
        return '<hr><p style="font-size:12px;color:#888">Si no deseas recibir más correos, ' +
            '<a href="' + unsubUrl + '">cancela tu suscripción aquí</a>.</p>';
    }

    /** Confirmation (double opt-in) email body. */
    function buildConfirmEmail(name, confirmUrl) {
        const hello = name ? 'Hola ' + escapeHtml(name) + ',' : 'Hola,';
        const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111">' +
            '<h2 style="margin:0 0 12px">Confirma tu suscripción</h2>' +
            '<p>' + hello + ' gracias por suscribirte a nuestro boletín. Haz clic en el botón para confirmar tu correo:</p>' +
            '<p style="margin:24px 0"><a href="' + confirmUrl + '" style="background:#111;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Confirmar suscripción</a></p>' +
            '<p style="font-size:12px;color:#888">Si el botón no funciona, copia y pega este enlace en tu navegador:<br>' + confirmUrl + '</p>' +
            '<p style="font-size:12px;color:#888">Si no solicitaste esta suscripción, puedes ignorar este correo.</p>' +
            '</div>';
        const text = 'Gracias por suscribirte a nuestro boletin. Confirma tu correo abriendo este enlace: ' + confirmUrl +
            ' -- Si no solicitaste esta suscripcion, ignora este correo.';
        return { html, text };
    }

    // ── PUBLIC routes (consumed by the Puck block; no auth) ──────────────────────────────────────

    // Subscribe (upsert by email) + double opt-in attempt with single opt-in fallback.
    http.route('post', '/public/subscribe', async (req, res) => {
        try {
            if (subscribeThrottled()) {
                return res.status(429).json({ error: 'Demasiadas solicitudes. Inténtalo de nuevo en un minuto.' });
            }
            const body = req.body || {};
            const email = String(body.email || '').trim().toLowerCase();
            if (!EMAIL_RE.test(email) || email.length > 200) {
                return res.status(400).json({ error: 'El correo no es válido.' });
            }
            const name = String(body.name || '').trim().slice(0, 120);
            const pageUrl = sanitizePageUrl(body.page_url);

            const existing = await db.get('SELECT * FROM ' + T.subscribers + ' WHERE email = ?', [email]);
            if (existing && existing.status === 'confirmed') {
                // Already confirmed: do NOTHING (don't reset their status), and return the SAME generic
                // response as any other subscribe so the reply can't enumerate who is subscribed (audit LOW).
                return res.json({ success: true, message: 'Si el correo es válido, revisa tu bandeja para confirmar la suscripción.' });
            }

            const token = await genToken();
            if (existing) {
                // Re-subscribe / retry: regenerate the token, go back to pending, refresh metadata.
                await db.run(
                    'UPDATE ' + T.subscribers + " SET token = ?, status = 'pending', name = ?, source_url = ? WHERE id = ?",
                    [token, name || existing.name || '', pageUrl || existing.source_url || '', existing.id]
                );
            } else {
                await db.run(
                    'INSERT INTO ' + T.subscribers + " (email, name, status, token, source_url) VALUES (?, ?, 'pending', ?, ?)",
                    [email, name, token, pageUrl]
                );
            }

            // Double opt-in. SECURITY (audit LOW): the confirm link MUST point to our backend confirm
            // route on the SITE's own origin. Building it from the client-supplied page_url let an
            // attacker relay a DKIM-signed mail whose "Confirmar" button pointed at their phishing site.
            let needsConfirm = false;
            try {
                const siteBase = String((await wordjs.site.url()) || '').replace(/\/+$/, '');
                if (!siteBase) throw new Error('no site url');
                const confirmUrl = `${siteBase}/api/v1/plugin/newsletter/public/confirm?token=${token}`;
                const msg = buildConfirmEmail(name, confirmUrl);
                await mail({ to: email, subject: 'Confirma tu suscripción al boletín', html: msg.html, text: msg.text });
                needsConfirm = true;
            } catch (e) {
                // No provider / no grant / no site url / transient failure -> single opt-in fallback below.
                needsConfirm = false;
            }
            if (!needsConfirm) {
                await db.run(
                    'UPDATE ' + T.subscribers + " SET status = 'confirmed', confirmed_at = datetime('now') WHERE email = ?",
                    [email]
                );
            }
            // Uniform response — IDENTICAL shape to the already-confirmed branch (no membership-revealing
            // field like `already`/`needsConfirm`), so the reply can't be used to enumerate subscribers.
            res.json({ success: true, message: 'Si el correo es válido, revisa tu bandeja para confirmar la suscripción.' });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo procesar la suscripción.' });
        }
    });

    // Confirm a pending subscription (double opt-in link target). Idempotent for already-confirmed.
    http.route('get', '/public/confirm', async (req, res) => {
        try {
            const token = String((req.query && req.query.token) || '').trim();
            if (!token) return res.status(404).json({ error: 'Enlace inválido.' });
            const sub = await db.get('SELECT * FROM ' + T.subscribers + ' WHERE token = ?', [token]);
            if (!sub || sub.status === 'unsubscribed') {
                return res.status(404).json({ error: 'El enlace de confirmación no es válido o ya caducó.' });
            }
            if (sub.status === 'pending') {
                await db.run(
                    'UPDATE ' + T.subscribers + " SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ? AND status = 'pending'",
                    [sub.id]
                );
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo confirmar la suscripción.' });
        }
    });

    // Unsubscribe (campaign footer link target). Idempotent.
    http.route('get', '/public/unsubscribe', async (req, res) => {
        try {
            const token = String((req.query && req.query.token) || '').trim();
            if (!token) return res.status(404).json({ error: 'Enlace inválido.' });
            const sub = await db.get('SELECT id FROM ' + T.subscribers + ' WHERE token = ?', [token]);
            if (!sub) return res.status(404).json({ error: 'El enlace no es válido o ya caducó.' });
            await db.run('UPDATE ' + T.subscribers + " SET status = 'unsubscribed' WHERE id = ?", [sub.id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cancelar la suscripción.' });
        }
    });

    // ── ADMIN routes ─────────────────────────────────────────────────────────────────────────────

    // Subscriber list (newest first) + aggregate stats for the dashboard cards.
    http.route('get', '/subscribers', { auth: true, admin: true }, async (req, res) => {
        try {
            const status = String((req.query && req.query.status) || '').trim();
            const search = String((req.query && req.query.search) || '').trim();
            let sql = 'SELECT id, email, name, status, source_url, created_at, confirmed_at FROM ' + T.subscribers;
            const where = [];
            const params = [];
            if (status === 'pending' || status === 'confirmed' || status === 'unsubscribed') {
                where.push('status = ?');
                params.push(status);
            }
            if (search) {
                where.push('(email LIKE ? OR name LIKE ?)');
                const like = '%' + search + '%';
                params.push(like, like);
            }
            if (where.length) sql += ' WHERE ' + where.join(' AND ');
            sql += ' ORDER BY id DESC LIMIT 2000';
            const subscribers = await db.all(sql, params);
            const stats = await db.get(
                'SELECT COUNT(*) as total, ' +
                "SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed, " +
                "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending, " +
                "SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END) as unsubscribed " +
                'FROM ' + T.subscribers
            );
            res.json({
                subscribers,
                stats: {
                    total: (stats && stats.total) || 0,
                    confirmed: (stats && stats.confirmed) || 0,
                    pending: (stats && stats.pending) || 0,
                    unsubscribed: (stats && stats.unsubscribed) || 0,
                },
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/subscribers/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Identificador inválido.' });
            const row = await db.get('SELECT id FROM ' + T.subscribers + ' WHERE id = ?', [id]);
            if (!row) return res.status(404).json({ error: 'Suscriptor no encontrado.' });
            await db.run('DELETE FROM ' + T.subscribers + ' WHERE id = ?', [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // CSV export. The isolate JSON-encodes string bodies (res.send would corrupt the file), so the
    // CSV travels inside a JSON field and the admin client builds the Blob download.
    http.route('get', '/subscribers/export', { auth: true, admin: true }, async (req, res) => {
        try {
            const rows = await db.all(
                'SELECT email, name, status, created_at FROM ' + T.subscribers + ' ORDER BY id DESC'
            );
            const esc = (v) => {
                let s = v === null || v === undefined ? '' : String(v);
                // Neutralize spreadsheet formula injection — names/emails come from the public form.
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return /[",\r\n']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            };
            const statusLabel = (s) => {
                if (s === 'confirmed') return 'Confirmado';
                if (s === 'unsubscribed') return 'Cancelado';
                return 'Pendiente';
            };
            const header = 'Email,Nombre,Estado,Fecha';
            const lines = rows.map((r) => [esc(r.email), esc(r.name), esc(statusLabel(r.status)), esc(r.created_at)].join(','));
            const csv = '﻿' + header + '\r\n' + lines.join('\r\n'); // BOM so Excel reads UTF-8
            res.json({ csv, filename: 'suscriptores-' + new Date().toISOString().slice(0, 10) + '.csv', count: rows.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('get', '/campaigns', { auth: true, admin: true }, async (req, res) => {
        try {
            const campaigns = await db.all('SELECT * FROM ' + T.campaigns + ' ORDER BY id DESC LIMIT 500');
            res.json(campaigns);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Create a draft, or update an existing draft when body.id is present.
    http.route('post', '/campaigns', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const subject = String(body.subject || '').trim();
            const bodyHtml = String(body.body_html || '').trim();
            if (!subject) return res.status(400).json({ error: 'El asunto es obligatorio.' });
            if (subject.length > 300) return res.status(400).json({ error: 'El asunto es demasiado largo (máx. 300).' });
            if (!bodyHtml) return res.status(400).json({ error: 'El contenido del correo es obligatorio.' });
            if (bodyHtml.length > 500000) return res.status(400).json({ error: 'El contenido es demasiado largo.' });

            if (body.id) {
                const id = parseInt(body.id, 10);
                if (!Number.isFinite(id)) return res.status(400).json({ error: 'Identificador inválido.' });
                const camp = await db.get('SELECT * FROM ' + T.campaigns + ' WHERE id = ?', [id]);
                if (!camp) return res.status(404).json({ error: 'Campaña no encontrada.' });
                if (camp.status !== 'draft') return res.status(409).json({ error: 'No se puede editar una campaña ya enviada.' });
                await db.run('UPDATE ' + T.campaigns + ' SET subject = ?, body_html = ? WHERE id = ?', [subject, bodyHtml, id]);
                const updated = await db.get('SELECT * FROM ' + T.campaigns + ' WHERE id = ?', [id]);
                return res.json(updated);
            }

            const result = await db.run(
                'INSERT INTO ' + T.campaigns + " (subject, body_html, status) VALUES (?, ?, 'draft')",
                [subject, bodyHtml]
            );
            const created = await db.get('SELECT * FROM ' + T.campaigns + ' WHERE id = ?', [result.lastID]);
            res.json(created);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/campaigns/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Identificador inválido.' });
            const camp = await db.get('SELECT id FROM ' + T.campaigns + ' WHERE id = ?', [id]);
            if (!camp) return res.status(404).json({ error: 'Campaña no encontrada.' });
            await db.run('DELETE FROM ' + T.campaigns + ' WHERE id = ?', [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Send a single test email (does NOT change campaign status or counters).
    http.route('post', '/campaigns/:id/test', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Identificador inválido.' });
            const to = String((req.body && req.body.to) || '').trim().toLowerCase();
            if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'El correo de prueba no es válido.' });
            const camp = await db.get('SELECT * FROM ' + T.campaigns + ' WHERE id = ?', [id]);
            if (!camp) return res.status(404).json({ error: 'Campaña no encontrada.' });
            try {
                await mail({ to, subject: '[Prueba] ' + camp.subject, html: camp.body_html });
            } catch (e) {
                return res.status(502).json({ error: 'El servidor de correo no está disponible.' });
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Send a draft to every CONFIRMED subscriber, sequentially, with a personalized unsubscribe
    // footer. Aborts early (and leaves the draft intact) when mail is entirely unavailable.
    const sendingCampaigns = new Set(); // in-memory double-click guard (single child process)
    http.route('post', '/campaigns/:id/send', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Identificador inválido.' });
        if (sendingCampaigns.has(id)) {
            return res.status(409).json({ error: 'Esta campaña ya se está enviando.' });
        }
        sendingCampaigns.add(id);
        try {
            const camp = await db.get('SELECT * FROM ' + T.campaigns + ' WHERE id = ?', [id]);
            if (!camp) return res.status(404).json({ error: 'Campaña no encontrada.' });
            if (camp.status !== 'draft') return res.status(409).json({ error: 'Esta campaña ya fue enviada.' });

            const subs = await db.all(
                "SELECT id, email, name, token, source_url FROM " + T.subscribers + " WHERE status = 'confirmed' ORDER BY id ASC"
            );
            if (!subs.length) return res.status(400).json({ error: 'No hay suscriptores confirmados.' });

            // Unsubscribe-link base fallback: the origin of the first subscriber that recorded a
            // source page, else a root-relative '/'.
            let fallbackBase = '/';
            for (let i = 0; i < subs.length; i++) {
                if (subs[i].source_url) {
                    try {
                        fallbackBase = new URL(subs[i].source_url).origin;
                    } catch (e) {
                        // keep '/'
                    }
                    break;
                }
            }

            let sent = 0;
            let failed = 0;
            for (let i = 0; i < subs.length; i++) {
                const sub = subs[i];
                const base = sub.source_url || fallbackBase;
                const unsubUrl = base + '?nl=unsubscribe&nl_token=' + sub.token;
                try {
                    await mail({
                        to: sub.email,
                        subject: camp.subject,
                        html: camp.body_html + buildUnsubFooter(unsubUrl),
                    });
                    sent++;
                } catch (e) {
                    failed++;
                }
                // Mail entirely unavailable (first attempts all throw): abort, keep the draft.
                if (sent === 0 && failed >= 3) {
                    return res.status(502).json({ error: 'El servidor de correo no está disponible.', sent, failed });
                }
            }
            if (sent === 0) {
                // 1-2 subscribers, all failed — mail is unavailable too; keep the draft.
                return res.status(502).json({ error: 'El servidor de correo no está disponible.', sent, failed });
            }

            await db.run(
                'UPDATE ' + T.campaigns + " SET status = 'sent', sent_count = ?, fail_count = ?, sent_at = datetime('now') WHERE id = ? AND status = 'draft'",
                [sent, failed, id]
            );
            res.json({ sent, failed });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            sendingCampaigns.delete(id);
        }
    });

    adminMenu.add({
        href: '/admin/plugin/newsletter',
        label: 'Newsletter',
        icon: 'fa-envelope-open-text',
        order: 57,
        cap: 'manage_options',
    });

    console.log('[newsletter] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down.
};
