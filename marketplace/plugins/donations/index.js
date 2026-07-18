/**
 * WordJS Plugin: Donations — GiveWP-style donation campaigns (isolated, sandbox-native).
 *
 * Features:
 *  - Campaigns with a goal thermometer (goal_cents / raised_cents; raised is denormalized and
 *    recomputed with a SINGLE UPDATE statement so concurrent status changes can't lose updates —
 *    the db bridge exposes no transactions).
 *  - Public donation flow: preset/custom amounts, manual payment instructions ALWAYS available,
 *    optional Stripe Checkout when the admin configures a secret key.
 *  - Stripe WITHOUT webhooks (the sandbox has no HMAC, so signatures can't be verified): the
 *    success_url carries the Checkout session id + our random donation token; /public/confirm-stripe
 *    retrieves the session server-side with the secret key and only marks the donation paid when
 *    payment_status === 'paid' AND the session metadata carries our token (idempotent).
 *  - Money is ALWAYS integer cents. The server never trusts client amounts beyond validating the
 *    donated amount itself (a donation has no server-side price list — the amount IS the donation),
 *    with strict integer bounds.
 *  - Secrets: the Stripe secret key lives in the plugin's OWN wjp_ settings table, write-only from
 *    the admin (absent = keep, '' = clear, value = replace) and is NEVER echoed back.
 *  - Anti-spam on the public form: honeypot field, minimum fill time, and in-memory rolling-window
 *    rate caps (global + per email; there is no req.ip in the sandbox).
 */

exports.metadata = {
    name: 'Donations',
    version: '1.0.0',
    description: 'Donation campaigns with goal thermometer, manual payment + optional Stripe Checkout, donor management and CSV export.',
    author: 'WordJS',
};

const OPT_CONFIG = 'donations_config';

const CONFIG_DEFAULTS = {
    currencySymbol: '$',
    currencyCode: 'usd',
    manualInstructions: '',
    notifyEmail: '',
    presets: '10,25,50,100', // comma-separated amounts in WHOLE units (not cents)
};

// Donation amount bounds (integer cents): 1.00 .. 1,000,000.00
const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 100000000;

// Anti-spam knobs for the public form
const MIN_ELAPSED_MS = 1800;                 // faster than this = bot
const DONATE_GLOBAL_MAX = 15;                // donations per rolling minute, instance-wide
const DONATE_GLOBAL_WINDOW_MS = 60 * 1000;
const EMAIL_MAX = 5;                         // donations per email per rolling window
const EMAIL_WINDOW_MS = 10 * 60 * 1000;
const CONFIRM_GLOBAL_MAX = 60;               // confirm-stripe calls per rolling minute (each hits Stripe)
const CONFIRM_GLOBAL_WINDOW_MS = 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu } = wordjs;

    // Per-plugin table namespace (host-enforced): 'donations' -> 'wjp_donations_'.
    const P = db.tablePrefix;
    const T = {
        campaigns: P + 'campaigns',
        donations: P + 'donations',
        settings: P + 'settings',
    };

    // ---- schema (idempotent; full column set from day 1 — no ALTER in the sandbox) --------------
    async function initSchema() {
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.campaigns} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            slug TEXT UNIQUE,
            description TEXT,
            goal_cents INTEGER DEFAULT 0,
            raised_cents INTEGER DEFAULT 0,
            image_url TEXT,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.donations} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER NOT NULL,
            token TEXT,
            donor_name TEXT,
            donor_email TEXT,
            amount_cents INTEGER NOT NULL,
            message TEXT,
            is_anonymous INTEGER DEFAULT 0,
            payment_method TEXT,
            payment_status TEXT DEFAULT 'pending',
            stripe_session_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${T.settings} (name TEXT PRIMARY KEY, value TEXT)`);
        // Indexes for the hot lookups (names must carry the plugin prefix too).
        try {
            await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_donations_campaign ON ${T.donations} (campaign_id)`);
            await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_donations_token ON ${T.donations} (token)`);
        } catch (e) { /* index already exists / unsupported — non-fatal */ }
    }
    await initSchema();

    // ---- plugin-private settings (Stripe secret key) ---------------------------------------------
    const getSetting = async (name) => {
        const row = await db.get(`SELECT value FROM ${T.settings} WHERE name = ?`, [name]);
        return row ? row.value : '';
    };
    // NOTE: `ON CONFLICT ... DO UPDATE SET` trips the host SQL guard (it reads the token after
    // `UPDATE` as a table name), so the upsert is a guard-safe UPDATE-then-INSERT. Admin-only
    // path, not race-sensitive.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes === 0) {
            await db.run(`INSERT INTO ${T.settings} (name, value) VALUES (?, ?)`, [name, v]);
        }
    };

    // ---- shared helpers ----------------------------------------------------------------------------
    const getConfig = async () => {
        const stored = (await options.get(OPT_CONFIG, null)) || {};
        return { ...CONFIG_DEFAULTS, ...stored };
    };

    const parsePresets = (str) => String(str || '')
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 1000000)
        .slice(0, 8);

    // Random 32-char lookup token. No CSPRNG exists in the sandbox (the static validator blocks
    // every path to webcrypto); brute force is bounded by the rate caps below, and the token only
    // gates a donation's OWN status — never other donors' data.
    const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const genToken = () => {
        let out = '';
        for (let i = 0; i < 32; i++) out += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
        return out;
    };

    /**
     * Recompute a campaign's denormalized raised_cents from PAID donations in one statement —
     * race-free without transactions.
     */
    const recomputeRaised = (campaignId) => db.run(
        `UPDATE ${T.campaigns}
         SET raised_cents = (SELECT COALESCE(SUM(amount_cents), 0) FROM ${T.donations} WHERE campaign_id = ? AND payment_status = 'paid')
         WHERE id = ?`,
        [campaignId, campaignId]
    );

    const escHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const fmtAmount = (cents, cfg) => `${cfg.currencySymbol || '$'}${(Math.round(cents) / 100).toFixed(2)}`;

    // Mail must NEVER break the donation flow — degrade quietly.
    const tryMail = async (msg) => {
        try {
            await wordjs.mail(msg);
            return true;
        } catch (e) {
            console.warn('[donations] correo no enviado:', e && e.message ? e.message : e);
            return false;
        }
    };

    const sendReceiptMail = async (donation, campaign, cfg) => {
        if (!donation.donor_email) return;
        const amount = fmtAmount(donation.amount_cents, cfg);
        await tryMail({
            to: donation.donor_email,
            subject: `Recibo de tu donación — ${campaign.title}`,
            text: `¡Gracias por tu donación de ${amount} a "${campaign.title}"! Referencia: ${donation.token}. Este correo confirma que tu pago fue recibido.`,
            html: `<div style="font-family:sans-serif;max-width:560px">
                <h2>¡Gracias por tu donación!</h2>
                <p>Confirmamos el pago de tu donación a <strong>${escHtml(campaign.title)}</strong>.</p>
                <p style="font-size:22px;font-weight:bold">${escHtml(amount)}</p>
                <p>Referencia: <code>${escHtml(donation.token)}</code></p>
                <p style="color:#6b7280;font-size:12px">Guarda este correo como comprobante.</p>
            </div>`,
        });
    };

    const sendAdminNotify = async (donation, campaign, cfg, statusLabel) => {
        if (!cfg.notifyEmail || !EMAIL_RE.test(cfg.notifyEmail)) return;
        const amount = fmtAmount(donation.amount_cents, cfg);
        const donor = donation.donor_name || '(sin nombre)';
        await tryMail({
            to: cfg.notifyEmail,
            subject: `Donación ${statusLabel} — ${campaign.title} (${amount})`,
            text: `Donación ${statusLabel} en "${campaign.title}": ${amount} de ${donor} <${donation.donor_email || 'sin email'}> vía ${donation.payment_method}. Mensaje: ${donation.message || '—'}`,
            html: `<div style="font-family:sans-serif;max-width:560px">
                <h3>Donación ${escHtml(statusLabel)}</h3>
                <p>Campaña: <strong>${escHtml(campaign.title)}</strong></p>
                <p>Monto: <strong>${escHtml(amount)}</strong> · Método: ${escHtml(donation.payment_method || '')}</p>
                <p>Donante: ${escHtml(donor)} &lt;${escHtml(donation.donor_email || 'sin email')}&gt;${donation.is_anonymous ? ' (anónimo en público)' : ''}</p>
                ${donation.message ? `<p>Mensaje: ${escHtml(donation.message)}</p>` : ''}
                <p>Referencia: <code>${escHtml(donation.token)}</code></p>
            </div>`,
        });
    };

    // ---- in-memory rate limiting (single child process; no req.ip exists in the sandbox) --------
    const makeWindowLimiter = (max, windowMs) => {
        const hits = [];
        return () => {
            const now = Date.now();
            while (hits.length && now - hits[0] > windowMs) hits.shift();
            if (hits.length >= max) return false;
            hits.push(now);
            return true;
        };
    };
    const donateAllowed = makeWindowLimiter(DONATE_GLOBAL_MAX, DONATE_GLOBAL_WINDOW_MS);
    const confirmAllowed = makeWindowLimiter(CONFIRM_GLOBAL_MAX, CONFIRM_GLOBAL_WINDOW_MS);

    const emailHits = new Map(); // email -> { count, first }
    const emailAllowed = (email) => {
        const now = Date.now();
        if (emailHits.size > 1000) {
            for (const [k, v] of emailHits) { if (now - v.first > EMAIL_WINDOW_MS) emailHits.delete(k); }
        }
        const rec = emailHits.get(email);
        if (!rec || now - rec.first > EMAIL_WINDOW_MS) { emailHits.set(email, { count: 1, first: now }); return true; }
        if (rec.count >= EMAIL_MAX) return false;
        rec.count++;
        return true;
    };

    // ---- Stripe (optional — everything works manually without a key) -----------------------------
    const stripeRequest = async (method, path, key, params) => {
        const res = await fetch('https://api.stripe.com' + path, {
            method,
            headers: {
                Authorization: 'Bearer ' + key,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params ? params.toString() : undefined,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = body && body.error && body.error.message ? body.error.message : ('HTTP ' + res.status);
            throw new Error(msg);
        }
        return body;
    };

    /** Resolve the page the donor came from into a safe absolute http(s) URL (fallback: site url). */
    const resolvePageUrl = async (pageUrl) => {
        const raw = String(pageUrl || '').slice(0, 2000);
        try {
            const u = new URL(raw);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
                u.searchParams.delete('session_id');
                u.searchParams.delete('donation');
                u.hash = '';
                return u;
            }
        } catch (e) { /* not a URL — fall through */ }
        return new URL(await wordjs.site.url());
    };

    const publicCampaignShape = (c) => ({
        id: c.id,
        title: c.title,
        slug: c.slug,
        description: c.description || '',
        goal_cents: c.goal_cents || 0,
        raised_cents: c.raised_cents || 0,
        image_url: c.image_url || '',
        pct: (c.goal_cents || 0) > 0 ? Math.min(100, Math.round(((c.raised_cents || 0) * 100) / c.goal_cents)) : null,
    });

    // ================================================================================================
    // PUBLIC ROUTES (consumed by the Puck block from the editor iframe AND the public page)
    // ================================================================================================

    // Active campaigns with progress.
    http.route('get', '/public/campaigns', async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.campaigns} WHERE is_active = 1 ORDER BY id ASC`);
        res.json({ campaigns: rows.map(publicCampaignShape) });
    });

    // One active campaign by slug — no slug means "the first active one".
    http.route('get', '/public/campaign', async (req, res) => {
        const slug = String((req.query && req.query.slug) || '').trim().slice(0, 200);
        const row = slug
            ? await db.get(`SELECT * FROM ${T.campaigns} WHERE slug = ? AND is_active = 1`, [slug])
            : await db.get(`SELECT * FROM ${T.campaigns} WHERE is_active = 1 ORDER BY id ASC LIMIT 1`);
        if (!row) return res.status(404).json({ error: 'No hay campañas de donación activas.' });
        res.json({ campaign: publicCampaignShape(row) });
    });

    // Non-secret display config for the block (currency, presets, whether Stripe is available).
    http.route('get', '/public/donations-config', async (req, res) => {
        const cfg = await getConfig();
        const stripeKey = await getSetting('stripe_sk');
        res.json({
            currencySymbol: cfg.currencySymbol || '$',
            currencyCode: cfg.currencyCode || 'usd',
            presets: parsePresets(cfg.presets),
            stripeEnabled: !!stripeKey,
        });
    });

    // Create a donation (pending). Manual -> instructions; Stripe -> Checkout session URL.
    http.route('post', '/public/donate', async (req, res) => {
        const body = req.body || {};

        // -- anti-spam ------------------------------------------------------------------------------
        if (String(body.hp || '').trim() !== '') {
            return res.status(400).json({ error: 'Solicitud rechazada.' });
        }
        const elapsed = Number(body.elapsed);
        if (!Number.isFinite(elapsed) || elapsed < MIN_ELAPSED_MS) {
            return res.status(429).json({ error: 'Formulario enviado demasiado rápido — espera un momento e inténtalo de nuevo.' });
        }
        if (!donateAllowed()) {
            return res.status(429).json({ error: 'Demasiadas donaciones en este momento — inténtalo de nuevo en un minuto.' });
        }

        // -- validation (money = integer cents, hard bounds) ----------------------------------------
        const campaignId = parseInt(body.campaign_id, 10);
        if (!Number.isInteger(campaignId) || campaignId < 1) {
            return res.status(400).json({ error: 'Campaña inválida.' });
        }
        const amountCents = Number(body.amount_cents);
        if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
            return res.status(400).json({ error: 'Monto inválido — el mínimo es 1.00 y el máximo 1,000,000.00.' });
        }
        const donorName = String(body.donor_name || '').trim().slice(0, 200);
        if (!donorName) return res.status(400).json({ error: 'El nombre es obligatorio.' });
        const donorEmail = String(body.donor_email || '').trim().slice(0, 254);
        if (!EMAIL_RE.test(donorEmail)) return res.status(400).json({ error: 'Ingresa un correo electrónico válido.' });
        const message = String(body.message || '').trim().slice(0, 2000);
        const isAnonymous = body.is_anonymous ? 1 : 0;
        const paymentMethod = body.payment_method === 'stripe' ? 'stripe' : 'manual';

        if (!emailAllowed(donorEmail.toLowerCase())) {
            return res.status(429).json({ error: 'Has alcanzado el límite de donaciones por ahora — inténtalo más tarde.' });
        }

        const campaign = await db.get(`SELECT * FROM ${T.campaigns} WHERE id = ? AND is_active = 1`, [campaignId]);
        if (!campaign) return res.status(404).json({ error: 'La campaña no existe o no está activa.' });

        const cfg = await getConfig();
        const stripeKey = paymentMethod === 'stripe' ? await getSetting('stripe_sk') : '';
        if (paymentMethod === 'stripe' && !stripeKey) {
            return res.status(400).json({ error: 'El pago con tarjeta no está disponible — usa las instrucciones de pago manual.' });
        }

        const token = genToken();
        const insert = await db.run(
            `INSERT INTO ${T.donations} (campaign_id, token, donor_name, donor_email, amount_cents, message, is_anonymous, payment_method, payment_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [campaignId, token, donorName, donorEmail, amountCents, message, isAnonymous, paymentMethod]
        );
        const donationId = insert.lastID;
        const donation = {
            id: donationId, campaign_id: campaignId, token, donor_name: donorName, donor_email: donorEmail,
            amount_cents: amountCents, message, is_anonymous: isAnonymous, payment_method: paymentMethod,
        };

        if (paymentMethod === 'stripe') {
            // Create the Checkout Session server-side; the client only receives a redirect URL.
            try {
                const base = await resolvePageUrl(body.page_url);
                const cancelUrl = base.toString();
                const successUrl = cancelUrl + (base.search ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}&donation=' + token;
                const params = new URLSearchParams();
                params.set('mode', 'payment');
                params.set('line_items[0][price_data][currency]', String(cfg.currencyCode || 'usd').toLowerCase());
                params.set('line_items[0][price_data][product_data][name]', 'Donación: ' + campaign.title);
                params.set('line_items[0][price_data][unit_amount]', String(amountCents));
                params.set('line_items[0][quantity]', '1');
                params.set('success_url', successUrl);
                params.set('cancel_url', cancelUrl);
                params.set('metadata[donation_token]', token);
                if (donorEmail) params.set('customer_email', donorEmail);
                const session = await stripeRequest('POST', '/v1/checkout/sessions', stripeKey, params);
                if (!session || !session.url || !session.id) throw new Error('Stripe no devolvió una URL de pago.');
                await db.run(`UPDATE ${T.donations} SET stripe_session_id = ? WHERE id = ?`, [String(session.id).slice(0, 200), donationId]);
                await sendAdminNotify(donation, campaign, cfg, 'iniciada (tarjeta, pendiente)');
                return res.json({ checkoutUrl: session.url, token });
            } catch (e) {
                // The session never reached the donor — remove the orphan pending row.
                await db.run(`DELETE FROM ${T.donations} WHERE id = ?`, [donationId]).catch(() => {});
                console.warn('[donations] Stripe checkout falló:', e && e.message ? e.message : e);
                return res.status(502).json({ error: 'No se pudo iniciar el pago con tarjeta — inténtalo de nuevo o usa el pago manual.' });
            }
        }

        // Manual: thank the donor (with the payment instructions) + notify the admin. Mail failures
        // never break the flow — the donation is already recorded.
        const amount = fmtAmount(amountCents, cfg);
        await tryMail({
            to: donorEmail,
            subject: `¡Gracias por tu donación! — ${campaign.title}`,
            text: `Gracias ${donorName} por tu donación de ${amount} a "${campaign.title}". Referencia: ${token}. Instrucciones de pago: ${cfg.manualInstructions || 'El administrador se pondrá en contacto contigo.'}`,
            html: `<div style="font-family:sans-serif;max-width:560px">
                <h2>¡Gracias por tu donación!</h2>
                <p>Hola ${escHtml(donorName)}, registramos tu donación de <strong>${escHtml(amount)}</strong> a <strong>${escHtml(campaign.title)}</strong>.</p>
                <p>Referencia: <code>${escHtml(token)}</code></p>
                <h3>Instrucciones de pago</h3>
                <p style="white-space:pre-wrap">${escHtml(cfg.manualInstructions || 'El administrador se pondrá en contacto contigo.')}</p>
            </div>`,
        });
        await sendAdminNotify(donation, campaign, cfg, 'recibida (manual, pendiente)');
        res.json({ token, manualInstructions: cfg.manualInstructions || '' });
    });

    // Stripe return leg: verify the session server-side and mark the donation paid (idempotent).
    http.route('get', '/public/confirm-stripe', async (req, res) => {
        const sessionId = String((req.query && req.query.session_id) || '').trim().slice(0, 200);
        const token = String((req.query && req.query.token) || '').trim().slice(0, 64);
        if (!sessionId || !token) return res.status(400).json({ error: 'Parámetros incompletos.' });
        if (!confirmAllowed()) {
            return res.status(429).json({ error: 'Demasiadas verificaciones en este momento — inténtalo de nuevo en un minuto.' });
        }

        const donation = await db.get(`SELECT * FROM ${T.donations} WHERE token = ?`, [token]);
        if (!donation) return res.status(404).json({ error: 'Donación no encontrada.' });
        if (donation.payment_status === 'paid') return res.json({ paid: true }); // idempotent
        if (donation.stripe_session_id && donation.stripe_session_id !== sessionId) {
            return res.status(400).json({ error: 'La sesión de pago no corresponde a esta donación.' });
        }

        const stripeKey = await getSetting('stripe_sk');
        if (!stripeKey) return res.status(400).json({ error: 'El pago con tarjeta no está configurado.' });

        let session;
        try {
            session = await stripeRequest('GET', '/v1/checkout/sessions/' + encodeURIComponent(sessionId), stripeKey, null);
        } catch (e) {
            console.warn('[donations] verificación Stripe falló:', e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo verificar el pago — inténtalo de nuevo en unos minutos.' });
        }

        const metaToken = session && session.metadata && session.metadata.donation_token;
        if (session && session.payment_status === 'paid' && metaToken === token) {
            // Single-statement idempotent transition; only the request that flips it sends the receipt.
            const result = await db.run(
                `UPDATE ${T.donations} SET payment_status = 'paid' WHERE id = ? AND payment_status != 'paid'`,
                [donation.id]
            );
            await recomputeRaised(donation.campaign_id);
            if (result && result.changes === 1) {
                const campaign = await db.get(`SELECT * FROM ${T.campaigns} WHERE id = ?`, [donation.campaign_id]);
                const cfg = await getConfig();
                if (campaign) {
                    await sendReceiptMail({ ...donation, payment_status: 'paid' }, campaign, cfg);
                    await sendAdminNotify(donation, campaign, cfg, 'pagada (tarjeta)');
                }
            }
            return res.json({ paid: true });
        }
        res.json({ paid: false });
    });

    // Last paid donations of a campaign — public wall. NEVER exposes emails; honors is_anonymous.
    http.route('get', '/public/recent', async (req, res) => {
        const campaignId = parseInt((req.query && req.query.campaign_id) || '', 10);
        if (!Number.isInteger(campaignId) || campaignId < 1) {
            return res.status(400).json({ error: 'Campaña inválida.' });
        }
        let limit = parseInt((req.query && req.query.limit) || '5', 10);
        if (!Number.isFinite(limit) || limit < 1) limit = 5;
        limit = Math.min(limit, 20);
        const rows = await db.all(
            `SELECT donor_name, is_anonymous, amount_cents, message, created_at
             FROM ${T.donations} WHERE campaign_id = ? AND payment_status = 'paid'
             ORDER BY id DESC LIMIT ?`,
            [campaignId, limit]
        );
        res.json({
            donations: rows.map((r) => ({
                name: r.is_anonymous ? 'Anónimo' : (r.donor_name || 'Anónimo'),
                amount_cents: r.amount_cents,
                message: r.message || '',
                created_at: r.created_at,
            })),
        });
    });

    // ================================================================================================
    // ADMIN ROUTES
    // ================================================================================================

    const sanitizeSlug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);

    /** Validate/normalize a campaign payload; `existing` supplies fallbacks on partial updates. */
    const cleanCampaignBody = (body, existing) => {
        const src = body || {};
        const prev = existing || {};
        const title = String(src.title !== undefined ? src.title : (prev.title || '')).trim().slice(0, 300);
        if (!title) throw new Error('El título es obligatorio.');
        let slug = sanitizeSlug(src.slug !== undefined ? src.slug : prev.slug);
        if (!slug) slug = sanitizeSlug(title);
        if (!slug) slug = 'campana-' + Date.now().toString(36);
        const goalRaw = src.goal_cents !== undefined ? Number(src.goal_cents) : (prev.goal_cents || 0);
        if (!Number.isInteger(goalRaw) || goalRaw < 0 || goalRaw > 1000000000000) {
            throw new Error('La meta debe ser un monto válido (0 = sin meta).');
        }
        const description = String(src.description !== undefined ? src.description : (prev.description || '')).trim().slice(0, 5000);
        const imageUrl = String(src.image_url !== undefined ? src.image_url : (prev.image_url || '')).trim().slice(0, 1000);
        const isActive = src.is_active !== undefined ? (src.is_active ? 1 : 0) : (prev.is_active !== undefined ? (prev.is_active ? 1 : 0) : 1);
        return { title, slug, description, goal_cents: goalRaw, image_url: imageUrl, is_active: isActive };
    };

    http.route('get', '/campaigns', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(
            `SELECT c.*,
                (SELECT COUNT(*) FROM ${T.donations} d WHERE d.campaign_id = c.id) AS donation_count,
                (SELECT COUNT(*) FROM ${T.donations} d WHERE d.campaign_id = c.id AND d.payment_status = 'paid') AS paid_count
             FROM ${T.campaigns} c ORDER BY c.id DESC`
        );
        res.json({ campaigns: rows });
    });

    http.route('post', '/campaigns', { auth: true, admin: true }, async (req, res) => {
        try {
            const c = cleanCampaignBody(req.body, null);
            const exists = await db.get(`SELECT id FROM ${T.campaigns} WHERE slug = ?`, [c.slug]);
            if (exists) return res.status(409).json({ error: 'Ya existe una campaña con ese slug.' });
            const result = await db.run(
                `INSERT INTO ${T.campaigns} (title, slug, description, goal_cents, image_url, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
                [c.title, c.slug, c.description, c.goal_cents, c.image_url, c.is_active]
            );
            const row = await db.get(`SELECT * FROM ${T.campaigns} WHERE id = ?`, [result.lastID]);
            res.json({ campaign: row });
        } catch (e) {
            res.status(400).json({ error: e.message || 'Datos inválidos.' });
        }
    });

    http.route('put', '/campaigns/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido.' });
        const existing = await db.get(`SELECT * FROM ${T.campaigns} WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Campaña no encontrada.' });
        try {
            const c = cleanCampaignBody(req.body, existing);
            const clash = await db.get(`SELECT id FROM ${T.campaigns} WHERE slug = ? AND id != ?`, [c.slug, id]);
            if (clash) return res.status(409).json({ error: 'Ya existe otra campaña con ese slug.' });
            await db.run(
                `UPDATE ${T.campaigns} SET title = ?, slug = ?, description = ?, goal_cents = ?, image_url = ?, is_active = ? WHERE id = ?`,
                [c.title, c.slug, c.description, c.goal_cents, c.image_url, c.is_active, id]
            );
            const row = await db.get(`SELECT * FROM ${T.campaigns} WHERE id = ?`, [id]);
            res.json({ campaign: row });
        } catch (e) {
            res.status(400).json({ error: e.message || 'Datos inválidos.' });
        }
    });

    http.route('delete', '/campaigns/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido.' });
        const existing = await db.get(`SELECT id FROM ${T.campaigns} WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Campaña no encontrada.' });
        // No FK cascade in the sandbox (PRAGMA is unreachable) — delete children explicitly.
        await db.run(`DELETE FROM ${T.donations} WHERE campaign_id = ?`, [id]);
        await db.run(`DELETE FROM ${T.campaigns} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    const VALID_STATUSES = ['pending', 'paid', 'cancelled'];

    /** Shared WHERE builder for the donations list/export filters. */
    const donationFilters = (query) => {
        const where = [];
        const params = [];
        const campaignId = parseInt((query && query.campaign_id) || '', 10);
        if (Number.isInteger(campaignId) && campaignId > 0) { where.push('d.campaign_id = ?'); params.push(campaignId); }
        const status = String((query && query.status) || '').trim();
        if (VALID_STATUSES.includes(status)) { where.push('d.payment_status = ?'); params.push(status); }
        return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
    };

    http.route('get', '/donations', { auth: true, admin: true }, async (req, res) => {
        const { clause, params } = donationFilters(req.query);
        const rows = await db.all(
            `SELECT d.*, c.title AS campaign_title
             FROM ${T.donations} d LEFT JOIN ${T.campaigns} c ON c.id = d.campaign_id
             ${clause} ORDER BY d.id DESC LIMIT 500`,
            params
        );
        const totals = await db.get(
            `SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN d.payment_status = 'paid' THEN d.amount_cents ELSE 0 END), 0) AS paid_cents,
                COALESCE(SUM(CASE WHEN d.payment_status = 'pending' THEN d.amount_cents ELSE 0 END), 0) AS pending_cents
             FROM ${T.donations} d ${clause}`,
            params
        );
        res.json({ donations: rows, totals: totals || { count: 0, paid_cents: 0, pending_cents: 0 } });
    });

    http.route('post', '/donations/:id/payment', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido.' });
        const status = String((req.body && req.body.payment_status) || '').trim();
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Estado inválido — usa pending, paid o cancelled.' });
        }
        const donation = await db.get(`SELECT * FROM ${T.donations} WHERE id = ?`, [id]);
        if (!donation) return res.status(404).json({ error: 'Donación no encontrada.' });
        const wasPaid = donation.payment_status === 'paid';
        await db.run(`UPDATE ${T.donations} SET payment_status = ? WHERE id = ?`, [status, id]);
        await recomputeRaised(donation.campaign_id);
        if (status === 'paid' && !wasPaid) {
            const campaign = await db.get(`SELECT * FROM ${T.campaigns} WHERE id = ?`, [donation.campaign_id]);
            if (campaign) {
                const cfg = await getConfig();
                await sendReceiptMail({ ...donation, payment_status: 'paid' }, campaign, cfg);
            }
        }
        const row = await db.get(`SELECT * FROM ${T.donations} WHERE id = ?`, [id]);
        res.json({ donation: row });
    });

    http.route('delete', '/donations/:id', { auth: true, admin: true }, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido.' });
        const donation = await db.get(`SELECT * FROM ${T.donations} WHERE id = ?`, [id]);
        if (!donation) return res.status(404).json({ error: 'Donación no encontrada.' });
        await db.run(`DELETE FROM ${T.donations} WHERE id = ?`, [id]);
        await recomputeRaised(donation.campaign_id);
        res.json({ success: true });
    });

    // CSV export. res.send(string) is FORBIDDEN in the isolate (it JSON-encodes string bodies) —
    // return { csv, filename } and let the admin client build a Blob download.
    http.route('get', '/donations/export', { auth: true, admin: true }, async (req, res) => {
        const { clause, params } = donationFilters(req.query);
        const rows = await db.all(
            `SELECT d.*, c.title AS campaign_title
             FROM ${T.donations} d LEFT JOIN ${T.campaigns} c ON c.id = d.campaign_id
             ${clause} ORDER BY d.id DESC`,
            params
        );
        const cfg = await getConfig();
        const csvCell = (v) => {
            let s = String(v == null ? '' : v);
            // Neutralize spreadsheet formula injection — donor fields come from the public form.
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return /[",\n\r;']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const header = ['id', 'fecha', 'campana', 'donante', 'email', 'monto', 'moneda', 'metodo', 'estado', 'anonimo', 'mensaje', 'referencia'];
        const lines = [header.join(',')];
        for (const d of rows) {
            lines.push([
                d.id,
                d.created_at || '',
                d.campaign_title || d.campaign_id,
                d.donor_name || '',
                d.donor_email || '',
                (Math.round(d.amount_cents) / 100).toFixed(2),
                String(cfg.currencyCode || 'usd').toUpperCase(),
                d.payment_method || '',
                d.payment_status || '',
                d.is_anonymous ? 'si' : 'no',
                d.message || '',
                d.token || '',
            ].map(csvCell).join(','));
        }
        const stamp = new Date().toISOString().slice(0, 10);
        res.json({ csv: lines.join('\n'), filename: `donaciones-${stamp}.csv` });
    });

    // ---- configuration (non-secrets in options; Stripe key write-only in the own settings table) --
    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        const cfg = await getConfig();
        const stripeKey = await getSetting('stripe_sk');
        res.json({ ...cfg, hasStripeKey: !!stripeKey });
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const cfg = await getConfig();
        const next = { ...cfg };
        if (typeof body.currencySymbol === 'string') next.currencySymbol = body.currencySymbol.trim().slice(0, 8) || '$';
        if (typeof body.currencyCode === 'string') {
            const code = body.currencyCode.trim().toLowerCase();
            if (!/^[a-z]{3}$/.test(code)) return res.status(400).json({ error: 'El código de moneda debe tener 3 letras (p. ej. usd, eur, mxn).' });
            next.currencyCode = code;
        }
        if (typeof body.presets === 'string') {
            const parsed = parsePresets(body.presets);
            if (parsed.length === 0) return res.status(400).json({ error: 'Los montos sugeridos deben ser números separados por comas (p. ej. 10,25,50,100).' });
            next.presets = parsed.join(',');
        }
        if (typeof body.manualInstructions === 'string') next.manualInstructions = body.manualInstructions.trim().slice(0, 5000);
        if (typeof body.notifyEmail === 'string') {
            const email = body.notifyEmail.trim().slice(0, 254);
            if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'El correo de notificaciones no es válido.' });
            next.notifyEmail = email;
        }
        await options.set(OPT_CONFIG, next);
        // Key semantics: absent = keep current, '' = clear, value = replace. Never echoed back.
        if (typeof body.stripeKey === 'string') await setSetting('stripe_sk', body.stripeKey.trim());
        const stripeKey = await getSetting('stripe_sk');
        res.json({ ...next, hasStripeKey: !!stripeKey });
    });

    adminMenu.add({
        href: '/admin/plugin/donations',
        label: 'Donaciones',
        icon: 'fa-hand-holding-heart',
        order: 72,
        cap: 'manage_options',
    });

    console.log('[donations] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers or servers; rate-limit maps die with the child process.
};
