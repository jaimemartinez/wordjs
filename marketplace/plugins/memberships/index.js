/**
 * WordJS Plugin: Memberships — members-only content, free and paid tiers, Stripe subscriptions
 * (isolated, sandbox-native).
 *
 * HOW IT PLUGS INTO CORE. Gating itself is core's (backend/src/core/content-access): an entry stores the
 * level it requires in the `_wjs_access` post meta, and every read surface — REST, feeds, search, the
 * comments of the entry — serves a viewer who does not hold that level the entry's TEASER. This plugin
 * is a level PROVIDER:
 *   · `content_access_levels` — the levels the post editor offers: `members` (any member, free or paid),
 *     `paid` (any paid tier) and `tier:<slug>` (that tier or a dearer one);
 *   · `content_access_grants` — the levels a signed-in account holds right now.
 * and it ships the Verso blocks: the PAYWALL (an access break: its defaultProps carry
 * `contentAccessBreak: true`, so core cuts the teaser there, and it draws the call-to-action) and the
 * member ACCOUNT box (plan, change tier, cancel / resume).
 *
 * MEMBERS ARE THE SITE'S OWN USER ACCOUNTS. Signing up is core's /register (with its e-mail verification,
 * rate limits and MFA); signing in is core's session. A sandboxed plugin cannot hash passwords (no crypto
 * module) and a second auth stack would duplicate every hardening the core one carries. With free
 * sign-up on (the default), every signed-in account is a free member; paid and complimentary memberships
 * are rows in this plugin's table, keyed by user id.
 *
 * PAYMENTS: Stripe Checkout in `subscription` mode, TEST MODE ONLY in this version (a live key is refused
 * until the live flow has been verified end to end). Two paths reach the same idempotent activation:
 *   · the return leg (GET /me/confirm): the success URL carries the Checkout session id; the session is
 *     retrieved server-side with the secret key and must belong to the signed-in account;
 *   · the webhook (POST /stripe/webhook, a core `{ webhook: true }` route): the Stripe-Signature header is
 *     verified with HMAC-SHA256 over the raw body (wordjs.crypto.hmac) within a 5-minute tolerance, and
 *     each event id is processed once. Subscription updates, cancellations and failed payments arrive only
 *     this way.
 * Secrets (secret key, webhook signing secret) live in the plugin's OWN settings table, write-only from
 * the admin (absent = keep, '' = clear, value = replace) and are never echoed back.
 *
 * Money is integer cents throughout; prices come from the tier rows, never from the client.
 * Newsletter sending is out of scope (see the docs' follow-ups).
 */

exports.metadata = {
    name: 'Memberships',
    version: '1.0.0',
    description: 'Members-only content: free and paid tiers, paywall block, Stripe subscriptions, complimentary memberships.',
    author: 'WordJS',
};

const OPT_CONFIG = 'memberships_config';
const CONFIG_DEFAULTS = {
    currencyCode: 'usd',
    currencySymbol: '$',
    // Every signed-in account counts as a free member (holds the `members` level).
    freeSignup: true,
};

const LEVEL_MEMBERS = 'members';
const LEVEL_PAID = 'paid';
const TIER_LEVEL_PREFIX = 'tier:';

const MIN_PRICE_CENTS = 100;            // 1.00 — Stripe's floor for most currencies
const MAX_PRICE_CENTS = 100000000;      // 1,000,000.00
const INTERVALS = ['month', 'year'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A paid membership whose period ended this long ago without a renewal webhook stops granting access
// (a missed `customer.subscription.deleted` must not leave a lapsed account reading paid content forever).
const PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
// Stripe's own default tolerance for the signature timestamp.
const WEBHOOK_TOLERANCE_S = 300;
// Rate caps on the endpoints that call Stripe on a member's behalf.
const STRIPE_CALLS_PER_USER = 10;
const STRIPE_CALLS_WINDOW_MS = 60 * 1000;
const LIMITER_MAX_KEYS = 10000;

// Member states. `active`/`past_due` grant access (Stripe retries a failed renewal for days), the rest do not.
const ACCESS_STATUSES = ['active', 'past_due'];

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, hooks } = wordjs;

    const P = db.tablePrefix;
    const T = {
        tiers: P + 'tiers',
        members: P + 'members',
        checkouts: P + 'checkouts',
        events: P + 'events',
        settings: P + 'settings',
    };

    // ---- schema (idempotent; full column set from day 1 — no ALTER in the sandbox) ------------------
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.tiers} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        benefits TEXT,
        price_cents INTEGER NOT NULL,
        billing_interval TEXT NOT NULL DEFAULT 'month',
        is_active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        stripe_product_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.members} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE NOT NULL,
        tier_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'stripe',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER DEFAULT 0,
        comped_until TEXT,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.checkouts} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        tier_id INTEGER NOT NULL,
        session_id TEXT,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.events} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_event_id TEXT UNIQUE NOT NULL,
        type TEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.settings} (name TEXT PRIMARY KEY, value TEXT)`);
    try {
        await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_members_sub ON ${T.members} (stripe_subscription_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_checkouts_session ON ${T.checkouts} (session_id)`);
    } catch (e) { /* index exists / unsupported — non-fatal */ }

    // ---- plugin-private settings (Stripe secrets) ------------------------------------------------------
    const getSetting = async (name) => {
        const row = await db.get(`SELECT value FROM ${T.settings} WHERE name = ?`, [name]);
        return row ? row.value : '';
    };
    // Guard-safe upsert (the host SQL guard rejects ON CONFLICT ... DO UPDATE): UPDATE, then INSERT.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes === 0) await db.run(`INSERT INTO ${T.settings} (name, value) VALUES (?, ?)`, [name, v]);
    };

    const getConfig = async () => ({ ...CONFIG_DEFAULTS, ...((await options.get(OPT_CONFIG, null)) || {}) });

    // ---- helpers ----------------------------------------------------------------------------------------
    const nowIso = () => new Date().toISOString();
    const toInt = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : NaN; };
    const isoFromUnix = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

    // Public callers never see a driver's error text (it names tables and constraints).
    const quietly = (what, handler) => async (req, res) => {
        try { await handler(req, res); } catch (e) {
            console.error(`[memberships] ${what} failed:`, e && e.message ? e.message : e);
            res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
        }
    };

    const makeLimiter = (max, windowMs) => {
        const buckets = new Map();
        return (key) => {
            const k = String(key || 'anon').slice(0, 64);
            const now = Date.now();
            if (!buckets.has(k) && buckets.size >= LIMITER_MAX_KEYS) {
                for (const [bk, ts] of buckets) if (!ts.length || now - ts[ts.length - 1] > windowMs) buckets.delete(bk);
                while (buckets.size >= LIMITER_MAX_KEYS) buckets.delete(buckets.keys().next().value);
            }
            const hits = (buckets.get(k) || []).filter((t) => now - t <= windowMs);
            if (hits.length >= max) { buckets.set(k, hits); return false; }
            hits.push(now);
            buckets.set(k, hits);
            return true;
        };
    };
    const stripeCallAllowed = makeLimiter(STRIPE_CALLS_PER_USER, STRIPE_CALLS_WINDOW_MS);

    const parseBenefits = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20);

    const publicTier = (t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description || '',
        benefits: parseBenefits(t.benefits),
        price_cents: t.price_cents,
        interval: t.billing_interval,
    });

    const activeTiers = () => db.all(`SELECT * FROM ${T.tiers} WHERE is_active = 1 ORDER BY price_cents ASC, sort_order ASC, id ASC`);
    const tierById = (id) => db.get(`SELECT * FROM ${T.tiers} WHERE id = ?`, [id]);
    const memberByUser = (userId) => db.get(`SELECT * FROM ${T.members} WHERE user_id = ?`, [userId]);

    /** Does this membership row grant access right now? */
    const memberHasAccess = (m, now = Date.now()) => {
        if (!m || !ACCESS_STATUSES.includes(m.status)) return false;
        if (m.source === 'comped') return !m.comped_until || Date.parse(m.comped_until) > now;
        if (m.current_period_end) {
            const end = Date.parse(m.current_period_end);
            if (Number.isFinite(end) && end + PERIOD_GRACE_MS < now) return false;
        }
        return true;
    };

    /**
     * The levels an account holds. `members` for every signed-in account when free sign-up is on (and
     * for anyone with a live membership regardless); a paid tier adds `paid` and `tier:<slug>` for that
     * tier and every cheaper one, so content for "Silver and above" is open to Gold.
     */
    const grantsForUser = async (userId) => {
        const cfg = await getConfig();
        const levels = new Set();
        if (cfg.freeSignup) levels.add(LEVEL_MEMBERS);
        const m = await memberByUser(userId);
        if (memberHasAccess(m)) {
            levels.add(LEVEL_MEMBERS);
            const tier = m.tier_id ? await tierById(m.tier_id) : null;
            if (tier && tier.price_cents > 0) {
                levels.add(LEVEL_PAID);
                const tiers = await db.all(`SELECT slug FROM ${T.tiers} WHERE price_cents <= ?`, [tier.price_cents]);
                for (const t of tiers) levels.add(TIER_LEVEL_PREFIX + t.slug);
            }
        }
        return Array.from(levels);
    };

    // ---- core content-access provider ----------------------------------------------------------------
    hooks.addFilter('content_access_grants', async (value, ctx) => {
        const base = Array.isArray(value) ? value : [];
        const userId = ctx && Number(ctx.userId);
        if (!Number.isInteger(userId) || userId < 1) return base;
        try {
            return Array.from(new Set([...base, ...(await grantsForUser(userId))]));
        } catch (e) {
            console.warn('[memberships] grants lookup failed:', e && e.message ? e.message : e);
            return base;
        }
    });

    hooks.addFilter('content_access_levels', async (value) => {
        const base = Array.isArray(value) ? value : [];
        const tiers = await db.all(`SELECT slug, name FROM ${T.tiers} ORDER BY price_cents ASC, id ASC`);
        return [
            ...base,
            { value: LEVEL_MEMBERS, label: 'Miembros (gratis y de pago)' },
            { value: LEVEL_PAID, label: 'Miembros de pago (cualquier plan)' },
            ...tiers.map((t) => ({ value: TIER_LEVEL_PREFIX + t.slug, label: `Plan «${t.name}» o superior` })),
        ];
    });

    // ---- Stripe --------------------------------------------------------------------------------------
    /** Test-mode keys only in this version (see the header). */
    const keyMode = (key) => {
        const k = String(key || '');
        if (/^(sk|rk)_test_/.test(k)) return 'test';
        if (/^(sk|rk)_live_/.test(k)) return 'live';
        return '';
    };
    const stripeKey = async () => {
        const k = await getSetting('stripe_sk');
        return keyMode(k) === 'test' ? k : '';
    };

    /** Form-encode a nested object the way Stripe expects (a[b][c]=v). */
    const formEncode = (obj) => {
        const params = new URLSearchParams();
        const walk = (prefix, v) => {
            if (v === undefined || v === null) return;
            if (typeof v === 'object' && !Array.isArray(v)) {
                for (const [k, sub] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, sub);
            } else if (Array.isArray(v)) {
                v.forEach((sub, i) => walk(`${prefix}[${i}]`, sub));
            } else {
                params.append(prefix, String(v));
            }
        };
        walk('', obj);
        return params;
    };

    const stripeRequest = async (method, path, body) => {
        const key = await stripeKey();
        if (!key) { const e = new Error('Stripe is not configured'); e.code = 'no_stripe'; throw e; }
        const res = await fetch('https://api.stripe.com' + path, {
            method,
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body ? formEncode(body).toString() : undefined,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = json && json.error && json.error.message ? json.error.message : ('HTTP ' + res.status);
            const e = new Error(msg);
            e.code = 'stripe_error';
            throw e;
        }
        return json;
    };

    /** The Stripe product a tier bills under (created on first use, then reused). */
    const ensureProduct = async (tier) => {
        if (tier.stripe_product_id) return tier.stripe_product_id;
        const product = await stripeRequest('POST', '/v1/products', {
            name: tier.name,
            metadata: { wordjs_tier_id: tier.id },
        });
        await db.run(`UPDATE ${T.tiers} SET stripe_product_id = ? WHERE id = ?`, [String(product.id).slice(0, 200), tier.id]);
        return product.id;
    };

    const priceData = async (tier, cfg) => ({
        currency: String(cfg.currencyCode || 'usd').toLowerCase(),
        product: await ensureProduct(tier),
        unit_amount: tier.price_cents,
        recurring: { interval: tier.billing_interval },
    });

    /** A subscription's period end, wherever this API version puts it (top level or per item). */
    const periodEndOf = (sub) => {
        if (!sub) return null;
        if (sub.current_period_end) return isoFromUnix(sub.current_period_end);
        const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
        return item && item.current_period_end ? isoFromUnix(item.current_period_end) : null;
    };

    const statusFromStripe = (s) => {
        if (s === 'active' || s === 'trialing') return 'active';
        if (s === 'past_due' || s === 'unpaid') return 'past_due';
        if (s === 'incomplete') return 'incomplete';
        return 'canceled'; // canceled, incomplete_expired, paused, anything new
    };

    /**
     * Record (create or update) the paid membership of `userId` from a Stripe subscription — the one
     * writer both the return leg and the webhook use, so they cannot disagree.
     */
    const upsertStripeMember = async (userId, fields) => {
        const existing = await memberByUser(userId);
        const row = {
            tier_id: fields.tier_id !== undefined ? fields.tier_id : (existing ? existing.tier_id : null),
            status: fields.status || (existing ? existing.status : 'active'),
            stripe_customer_id: fields.stripe_customer_id !== undefined ? fields.stripe_customer_id : (existing ? existing.stripe_customer_id : null),
            stripe_subscription_id: fields.stripe_subscription_id !== undefined ? fields.stripe_subscription_id : (existing ? existing.stripe_subscription_id : null),
            current_period_end: fields.current_period_end !== undefined ? fields.current_period_end : (existing ? existing.current_period_end : null),
            cancel_at_period_end: fields.cancel_at_period_end !== undefined ? (fields.cancel_at_period_end ? 1 : 0) : (existing ? existing.cancel_at_period_end : 0),
        };
        if (existing) {
            await db.run(
                `UPDATE ${T.members} SET tier_id = ?, status = ?, source = 'stripe', stripe_customer_id = ?, stripe_subscription_id = ?,
                 current_period_end = ?, cancel_at_period_end = ?, comped_until = NULL, updated_at = ? WHERE id = ?`,
                [row.tier_id, row.status, row.stripe_customer_id, row.stripe_subscription_id, row.current_period_end, row.cancel_at_period_end, nowIso(), existing.id]
            );
        } else {
            await db.run(
                `INSERT INTO ${T.members} (user_id, tier_id, status, source, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, updated_at)
                 VALUES (?, ?, ?, 'stripe', ?, ?, ?, ?, ?)`,
                [userId, row.tier_id, row.status, row.stripe_customer_id, row.stripe_subscription_id, row.current_period_end, row.cancel_at_period_end, nowIso()]
            );
        }
        return memberByUser(userId);
    };

    /** Apply a Stripe subscription object to the membership it belongs to (by id, else by metadata). */
    const applySubscription = async (sub) => {
        if (!sub || !sub.id) return null;
        let member = await db.get(`SELECT * FROM ${T.members} WHERE stripe_subscription_id = ?`, [String(sub.id)]);
        const metaUser = sub.metadata ? toInt(sub.metadata.wordjs_user_id) : NaN;
        if (!member && !Number.isInteger(metaUser)) return null; // not one of ours
        const userId = member ? member.user_id : metaUser;
        const metaTier = sub.metadata ? toInt(sub.metadata.wordjs_tier_id) : NaN;
        const tierId = Number.isInteger(metaTier) && (await tierById(metaTier)) ? metaTier : undefined;
        return upsertStripeMember(userId, {
            tier_id: tierId,
            status: statusFromStripe(sub.status),
            stripe_customer_id: sub.customer ? String(sub.customer) : undefined,
            stripe_subscription_id: String(sub.id),
            current_period_end: periodEndOf(sub),
            cancel_at_period_end: !!sub.cancel_at_period_end,
        });
    };

    /** Activate from a completed Checkout session (shared by the return leg and the webhook). */
    const applyCompletedSession = async (session, expectedUserId) => {
        if (!session || session.mode !== 'subscription') return { ok: false, reason: 'not a subscription session' };
        const meta = session.metadata || {};
        const userId = toInt(meta.wordjs_user_id);
        const tierId = toInt(meta.wordjs_tier_id);
        if (!Number.isInteger(userId) || !Number.isInteger(tierId)) return { ok: false, reason: 'not one of ours' };
        if (expectedUserId !== undefined && userId !== expectedUserId) return { ok: false, reason: 'session belongs to another account' };
        if (session.status !== 'complete') return { ok: false, reason: 'checkout not complete' };
        if (!(await tierById(tierId))) return { ok: false, reason: 'unknown tier' };
        const sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
        await upsertStripeMember(userId, {
            tier_id: tierId,
            status: sub ? statusFromStripe(sub.status) : (session.payment_status === 'paid' || session.payment_status === 'no_payment_required' ? 'active' : 'incomplete'),
            stripe_customer_id: session.customer ? String(typeof session.customer === 'object' ? session.customer.id : session.customer) : undefined,
            stripe_subscription_id: session.subscription ? String(sub ? sub.id : session.subscription) : undefined,
            current_period_end: sub ? periodEndOf(sub) : undefined,
            cancel_at_period_end: sub ? !!sub.cancel_at_period_end : undefined,
        });
        if (session.id) await db.run(`UPDATE ${T.checkouts} SET status = 'complete' WHERE session_id = ?`, [String(session.id)]);
        return { ok: true, userId };
    };

    /**
     * Verify a Stripe-Signature header (`t=<unix>,v1=<hex>[,v1=…]`) over the raw body: HMAC-SHA256 of
     * `${t}.${rawBody}` under the endpoint's signing secret, compared in constant time against every v1,
     * and the timestamp within the tolerance (a captured request cannot be replayed later).
     */
    const verifyStripeSignature = async (header, rawBody, secret, nowSec = Math.floor(Date.now() / 1000)) => {
        if (!secret || typeof header !== 'string' || typeof rawBody !== 'string') return false;
        let t = null;
        const sigs = [];
        for (const part of header.split(',')) {
            const i = part.indexOf('=');
            if (i < 1) continue;
            const k = part.slice(0, i).trim();
            const v = part.slice(i + 1).trim();
            if (k === 't') t = v;
            else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
        }
        const ts = Number(t);
        if (!t || !Number.isInteger(ts) || !sigs.length) return false;
        if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_S) return false;
        const expected = await wordjs.crypto.hmac('sha256', secret, `${t}.${rawBody}`, 'hex');
        let match = false;
        for (const s of sigs) {
            // Every candidate is compared (no early exit on the first match).
            if (await wordjs.crypto.timingSafeEqual(s, expected)) match = true;
        }
        return match;
    };

    /** The page to return to, on THIS site: only the path and query of `pageUrl` are kept. */
    const returnUrl = async (pageUrl) => {
        const site = new URL(await wordjs.site.url());
        let path = '/';
        try {
            const u = new URL(String(pageUrl || ''), site);
            u.searchParams.delete('ms_session');
            u.searchParams.delete('ms_cancel');
            path = u.pathname + (u.search || '');
        } catch (e) { /* keep '/' */ }
        return new URL(path, site.origin);
    };

    // ================================================================================================
    // PUBLIC ROUTES
    // ================================================================================================

    http.route('get', '/public/tiers', quietly('tier list', async (req, res) => {
        const cfg = await getConfig();
        const tiers = await activeTiers();
        res.json({
            tiers: tiers.map(publicTier),
            currencyCode: cfg.currencyCode,
            currencySymbol: cfg.currencySymbol,
            freeSignup: !!cfg.freeSignup,
            stripeEnabled: !!(await stripeKey()),
        });
    }));

    // The signed-in account's own membership (the blocks ask; 401 = signed out).
    http.route('get', '/me', { auth: true }, quietly('account', async (req, res) => {
        const userId = Number(req.user && req.user.id);
        const m = await memberByUser(userId);
        const tier = m && m.tier_id ? await tierById(m.tier_id) : null;
        res.json({
            signedIn: true,
            member: m ? {
                status: m.status,
                source: m.source,
                active: memberHasAccess(m),
                tier: tier ? publicTier(tier) : null,
                currentPeriodEnd: m.current_period_end || null,
                cancelAtPeriodEnd: !!m.cancel_at_period_end,
                compedUntil: m.comped_until || null,
                canManageBilling: m.source === 'stripe' && !!m.stripe_subscription_id && memberHasAccess(m),
            } : null,
            levels: await grantsForUser(userId),
        });
    }));

    // Start a Stripe Checkout for a paid tier. The price is the tier row's; the client names a tier.
    http.route('post', '/checkout', { auth: true }, quietly('checkout', async (req, res) => {
        const userId = Number(req.user && req.user.id);
        if (!stripeCallAllowed('u' + userId)) return res.status(429).json({ error: 'Demasiados intentos — espera un minuto.' });
        const tierId = toInt(req.body && req.body.tier_id);
        const tier = Number.isInteger(tierId) ? await tierById(tierId) : null;
        if (!tier || !tier.is_active) return res.status(404).json({ error: 'Ese plan no existe o no está disponible.' });
        if (!(await stripeKey())) return res.status(400).json({ error: 'El pago con tarjeta no está configurado.' });
        const existing = await memberByUser(userId);
        if (existing && existing.source === 'stripe' && existing.stripe_subscription_id && memberHasAccess(existing)) {
            return res.status(409).json({ error: 'Ya tienes una suscripción activa — cambia de plan desde tu cuenta.' });
        }
        const cfg = await getConfig();
        const back = await returnUrl(req.body && req.body.page_url);
        const success = new URL(back.toString());
        success.searchParams.set('ms_session', '{CHECKOUT_SESSION_ID}');
        const cancel = new URL(back.toString());
        cancel.searchParams.set('ms_cancel', '1');
        const params = {
            mode: 'subscription',
            line_items: [{ price_data: await priceData(tier, cfg), quantity: 1 }],
            // `{CHECKOUT_SESSION_ID}` must reach Stripe unencoded.
            success_url: success.toString().replace(encodeURIComponent('{CHECKOUT_SESSION_ID}'), '{CHECKOUT_SESSION_ID}'),
            cancel_url: cancel.toString(),
            client_reference_id: String(userId),
            metadata: { wordjs_user_id: userId, wordjs_tier_id: tier.id },
            subscription_data: { metadata: { wordjs_user_id: userId, wordjs_tier_id: tier.id } },
        };
        if (existing && existing.stripe_customer_id) params.customer = existing.stripe_customer_id;
        else if (req.user && req.user.userEmail && EMAIL_RE.test(req.user.userEmail)) params.customer_email = req.user.userEmail;
        let session;
        try {
            session = await stripeRequest('POST', '/v1/checkout/sessions', params);
        } catch (e) {
            console.warn('[memberships] Stripe checkout failed:', e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo iniciar el pago — inténtalo de nuevo.' });
        }
        if (!session || !session.url || !session.id) return res.status(502).json({ error: 'Stripe no devolvió una URL de pago.' });
        await db.run(`INSERT INTO ${T.checkouts} (user_id, tier_id, session_id) VALUES (?, ?, ?)`, [userId, tier.id, String(session.id).slice(0, 200)]);
        res.json({ checkoutUrl: session.url });
    }));

    // Stripe return leg: retrieve the session server-side; it must be this account's (idempotent).
    http.route('get', '/me/confirm', { auth: true }, quietly('checkout confirmation', async (req, res) => {
        const userId = Number(req.user && req.user.id);
        const sessionId = String((req.query && req.query.session_id) || '').trim();
        if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) return res.status(400).json({ error: 'Sesión de pago inválida.' });
        if (!stripeCallAllowed('u' + userId)) return res.status(429).json({ error: 'Demasiados intentos — espera un minuto.' });
        const ours = await db.get(`SELECT * FROM ${T.checkouts} WHERE session_id = ? AND user_id = ?`, [sessionId, userId]);
        if (!ours) return res.status(404).json({ error: 'Esa sesión de pago no es de tu cuenta.' });
        let session;
        try {
            session = await stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, null);
        } catch (e) {
            console.warn('[memberships] Stripe session lookup failed:', e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo verificar el pago — inténtalo en unos minutos.' });
        }
        const r = await applyCompletedSession(session, userId);
        if (!r.ok) return res.json({ active: false });
        const m = await memberByUser(userId);
        res.json({ active: memberHasAccess(m) });
    }));

    /** The account's live Stripe membership, or a reply explaining why there is none. */
    const billingMember = async (req, res) => {
        const userId = Number(req.user && req.user.id);
        const m = await memberByUser(userId);
        if (!m || m.source !== 'stripe' || !m.stripe_subscription_id || !memberHasAccess(m)) {
            res.status(404).json({ error: 'No tienes una suscripción activa.' });
            return null;
        }
        if (!stripeCallAllowed('u' + userId)) { res.status(429).json({ error: 'Demasiados intentos — espera un minuto.' }); return null; }
        return m;
    };

    // Change to another paid tier: the subscription's single item moves to the new tier's price, prorated.
    http.route('post', '/me/change-tier', { auth: true }, quietly('tier change', async (req, res) => {
        const m = await billingMember(req, res);
        if (!m) return;
        const tierId = toInt(req.body && req.body.tier_id);
        const tier = Number.isInteger(tierId) ? await tierById(tierId) : null;
        if (!tier || !tier.is_active) return res.status(404).json({ error: 'Ese plan no existe o no está disponible.' });
        if (tier.id === m.tier_id) return res.status(400).json({ error: 'Ya estás en ese plan.' });
        const cfg = await getConfig();
        let sub;
        try {
            const current = await stripeRequest('GET', `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`, null);
            const item = current && current.items && Array.isArray(current.items.data) ? current.items.data[0] : null;
            if (!item) throw new Error('subscription has no item');
            sub = await stripeRequest('POST', `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`, {
                items: [{ id: item.id, price_data: await priceData(tier, cfg) }],
                proration_behavior: 'create_prorations',
                cancel_at_period_end: 'false',
                metadata: { wordjs_user_id: m.user_id, wordjs_tier_id: tier.id },
            });
        } catch (e) {
            console.warn('[memberships] Stripe tier change failed:', e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo cambiar de plan — inténtalo de nuevo.' });
        }
        await applySubscription(sub);
        res.json({ ok: true, tier: publicTier(tier) });
    }));

    // Cancel at the end of the paid period (access continues until then), or undo that.
    const setCancelAtPeriodEnd = (flag) => quietly(flag ? 'cancel' : 'resume', async (req, res) => {
        const m = await billingMember(req, res);
        if (!m) return;
        let sub;
        try {
            sub = await stripeRequest('POST', `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`, {
                cancel_at_period_end: flag ? 'true' : 'false',
            });
        } catch (e) {
            console.warn('[memberships] Stripe cancel/resume failed:', e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo actualizar la suscripción — inténtalo de nuevo.' });
        }
        await applySubscription(sub);
        res.json({ ok: true, cancelAtPeriodEnd: flag });
    });
    http.route('post', '/me/cancel', { auth: true }, setCancelAtPeriodEnd(true));
    http.route('post', '/me/resume', { auth: true }, setCancelAtPeriodEnd(false));

    // ---- the Stripe webhook (core `{ webhook: true }`: raw body, no identity, CSRF-exempt) ------------
    http.route('post', '/stripe/webhook', { webhook: true }, async (req, res) => {
        try {
            const secret = await getSetting('stripe_whsec');
            const signature = req.headers && req.headers['stripe-signature'];
            if (!secret) return res.status(400).json({ error: 'webhook signing secret not configured' });
            if (!(await verifyStripeSignature(signature, req.rawBody, secret))) {
                return res.status(400).json({ error: 'invalid signature' });
            }
            let event;
            try { event = JSON.parse(req.rawBody); } catch (e) { return res.status(400).json({ error: 'invalid payload' }); }
            if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return res.status(400).json({ error: 'invalid event' });
            if (event.livemode === true) return res.status(400).json({ error: 'live events are not accepted by this version' });
            // Each event once: Stripe retries until it gets a 2xx, and may deliver an event twice.
            const seen = await db.get(`SELECT id FROM ${T.events} WHERE stripe_event_id = ?`, [event.id]);
            if (seen) return res.json({ received: true, duplicate: true });
            const obj = event.data && event.data.object;
            switch (event.type) {
                case 'checkout.session.completed':
                    await applyCompletedSession(obj, undefined);
                    break;
                case 'customer.subscription.created':
                case 'customer.subscription.updated':
                case 'customer.subscription.deleted':
                    await applySubscription(obj);
                    break;
                case 'invoice.payment_failed':
                case 'invoice.paid': {
                    const subId = obj && (obj.subscription
                        || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription));
                    if (subId) {
                        const m = await db.get(`SELECT * FROM ${T.members} WHERE stripe_subscription_id = ?`, [String(subId)]);
                        if (m) {
                            const status = event.type === 'invoice.paid' ? 'active' : 'past_due';
                            await db.run(`UPDATE ${T.members} SET status = ?, updated_at = ? WHERE id = ? AND status != 'canceled'`, [status, nowIso(), m.id]);
                        }
                    }
                    break;
                }
                default:
                    break; // not an event this plugin acts on — acknowledged so Stripe stops retrying
            }
            // Recorded AFTER it was applied: a failure above answers 500 and Stripe retries it.
            try {
                await db.run(`INSERT INTO ${T.events} (stripe_event_id, type) VALUES (?, ?)`, [event.id.slice(0, 200), event.type.slice(0, 100)]);
            } catch (e) { /* a concurrent delivery recorded it first — the work is idempotent */ }
            res.json({ received: true });
        } catch (e) {
            console.error('[memberships] webhook failed:', e && e.message ? e.message : e);
            res.status(500).json({ error: 'webhook processing failed' });
        }
    });

    // ================================================================================================
    // ADMIN ROUTES
    // ================================================================================================

    const cleanTier = (body, existing) => {
        const src = body || {};
        const prev = existing || {};
        const name = String(src.name !== undefined ? src.name : (prev.name || '')).trim().slice(0, 120);
        if (!name) throw new Error('El nombre es obligatorio.');
        let slug = String(src.slug !== undefined ? src.slug : (prev.slug || '')).trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        if (!slug) slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        if (!SLUG_RE.test(slug)) throw new Error('El identificador solo admite minúsculas, números y guiones.');
        const price = src.price_cents !== undefined ? Number(src.price_cents) : prev.price_cents;
        if (!Number.isInteger(price) || price < MIN_PRICE_CENTS || price > MAX_PRICE_CENTS) {
            throw new Error('El precio debe ser al menos 1.00 (los planes gratis no hacen falta: el registro ya es gratis).');
        }
        const interval = String(src.interval !== undefined ? src.interval : (prev.billing_interval || 'month'));
        if (!INTERVALS.includes(interval)) throw new Error('La periodicidad debe ser mensual o anual.');
        const description = String(src.description !== undefined ? src.description : (prev.description || '')).trim().slice(0, 2000);
        const benefits = String(src.benefits !== undefined ? (Array.isArray(src.benefits) ? src.benefits.join('\n') : src.benefits) : (prev.benefits || '')).slice(0, 4000);
        const isActive = src.is_active !== undefined ? (src.is_active ? 1 : 0) : (prev.is_active !== undefined ? prev.is_active : 1);
        const sortOrder = src.sort_order !== undefined ? (toInt(src.sort_order) || 0) : (prev.sort_order || 0);
        return { name, slug, price_cents: price, billing_interval: interval, description, benefits, is_active: isActive, sort_order: sortOrder };
    };

    http.route('get', '/tiers', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(
            `SELECT t.*, (SELECT COUNT(*) FROM ${T.members} m WHERE m.tier_id = t.id AND m.status IN ('active', 'past_due')) AS member_count
             FROM ${T.tiers} t ORDER BY t.price_cents ASC, t.id ASC`
        );
        res.json({ tiers: rows.map((t) => ({ ...publicTier(t), is_active: !!t.is_active, sort_order: t.sort_order, member_count: t.member_count || 0, benefits_text: t.benefits || '' })) });
    });

    http.route('post', '/tiers', { auth: true, admin: true }, async (req, res) => {
        let t;
        try { t = cleanTier(req.body, null); } catch (e) { return res.status(400).json({ error: e.message }); }
        if (await db.get(`SELECT id FROM ${T.tiers} WHERE slug = ?`, [t.slug])) return res.status(409).json({ error: 'Ya existe un plan con ese identificador.' });
        const r = await db.run(
            `INSERT INTO ${T.tiers} (slug, name, description, benefits, price_cents, billing_interval, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [t.slug, t.name, t.description, t.benefits, t.price_cents, t.billing_interval, t.is_active, t.sort_order]
        );
        res.json({ tier: publicTier(await tierById(r.lastID)) });
    });

    http.route('put', '/tiers/:id', { auth: true, admin: true }, async (req, res) => {
        const id = toInt(req.params.id);
        const existing = Number.isInteger(id) ? await tierById(id) : null;
        if (!existing) return res.status(404).json({ error: 'Plan no encontrado.' });
        let t;
        try { t = cleanTier(req.body, existing); } catch (e) { return res.status(400).json({ error: e.message }); }
        if (t.slug !== existing.slug) {
            // The slug is part of the `tier:<slug>` level posts store: renaming it would silently lock
            // every post that requires it (fail-closed, but surprising). Refuse instead.
            return res.status(400).json({ error: 'El identificador no se puede cambiar: las entradas que exigen este plan lo usan.' });
        }
        // A price/interval change applies to new checkouts and tier changes; the product name follows the tier.
        const productReset = t.name !== existing.name ? null : existing.stripe_product_id;
        await db.run(
            `UPDATE ${T.tiers} SET name = ?, description = ?, benefits = ?, price_cents = ?, billing_interval = ?, is_active = ?, sort_order = ?, stripe_product_id = ? WHERE id = ?`,
            [t.name, t.description, t.benefits, t.price_cents, t.billing_interval, t.is_active, t.sort_order, productReset, id]
        );
        res.json({ tier: publicTier(await tierById(id)) });
    });

    http.route('delete', '/tiers/:id', { auth: true, admin: true }, async (req, res) => {
        const id = toInt(req.params.id);
        const existing = Number.isInteger(id) ? await tierById(id) : null;
        if (!existing) return res.status(404).json({ error: 'Plan no encontrado.' });
        const used = await db.get(`SELECT COUNT(*) AS n FROM ${T.members} WHERE tier_id = ?`, [id]);
        if (used && used.n > 0) return res.status(409).json({ error: 'Este plan tiene miembros: desactívalo en lugar de borrarlo.' });
        await db.run(`DELETE FROM ${T.tiers} WHERE id = ?`, [id]);
        res.json({ success: true });
    });

    const adminMemberShape = async (m) => {
        const user = await wordjs.users.findById(m.user_id).catch(() => null);
        const tier = m.tier_id ? await tierById(m.tier_id) : null;
        return {
            id: m.id,
            user_id: m.user_id,
            user: user ? { login: user.userLogin, email: user.userEmail, name: user.displayName } : null,
            tier: tier ? { id: tier.id, name: tier.name, slug: tier.slug } : null,
            status: m.status,
            source: m.source,
            active: memberHasAccess(m),
            current_period_end: m.current_period_end,
            cancel_at_period_end: !!m.cancel_at_period_end,
            comped_until: m.comped_until,
            note: m.note || '',
            created_at: m.created_at,
            updated_at: m.updated_at,
        };
    };

    http.route('get', '/members', { auth: true, admin: true }, async (req, res) => {
        const rows = await db.all(`SELECT * FROM ${T.members} ORDER BY updated_at DESC, id DESC LIMIT 500`);
        const members = [];
        for (const m of rows) members.push(await adminMemberShape(m));
        res.json({ members });
    });

    // Grant a complimentary ("comped") membership: no payment, optional end date.
    http.route('post', '/members/comp', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const who = String(body.user || '').trim().slice(0, 254);
        if (!who) return res.status(400).json({ error: 'Indica el correo o el usuario de la cuenta.' });
        const user = EMAIL_RE.test(who) ? await wordjs.users.findByEmail(who) : await wordjs.users.findByLogin(who);
        if (!user) return res.status(404).json({ error: 'No hay ninguna cuenta con ese correo o usuario (la persona debe registrarse primero).' });
        const tierId = toInt(body.tier_id);
        const tier = Number.isInteger(tierId) ? await tierById(tierId) : null;
        if (!tier) return res.status(400).json({ error: 'Elige un plan.' });
        let until = null;
        if (body.until) {
            const d = Date.parse(String(body.until));
            if (!Number.isFinite(d) || d <= Date.now()) return res.status(400).json({ error: 'La fecha de fin debe ser futura.' });
            until = new Date(d).toISOString();
        }
        const note = String(body.note || '').trim().slice(0, 500);
        const existing = await memberByUser(Number(user.id));
        if (existing && existing.source === 'stripe' && existing.stripe_subscription_id && memberHasAccess(existing)) {
            return res.status(409).json({ error: 'Esta cuenta ya paga una suscripción: cancélala antes de regalarle un plan.' });
        }
        if (existing) {
            await db.run(
                `UPDATE ${T.members} SET tier_id = ?, status = 'active', source = 'comped', comped_until = ?, note = ?, cancel_at_period_end = 0, updated_at = ? WHERE id = ?`,
                [tier.id, until, note, nowIso(), existing.id]
            );
        } else {
            await db.run(
                `INSERT INTO ${T.members} (user_id, tier_id, status, source, comped_until, note, updated_at) VALUES (?, ?, 'active', 'comped', ?, ?, ?)`,
                [Number(user.id), tier.id, until, note, nowIso()]
            );
        }
        res.json({ member: await adminMemberShape(await memberByUser(Number(user.id))) });
    });

    // Revoke: a comped membership ends now; a paid one is cancelled at Stripe immediately.
    http.route('post', '/members/:id/revoke', { auth: true, admin: true }, async (req, res) => {
        const id = toInt(req.params.id);
        const m = Number.isInteger(id) ? await db.get(`SELECT * FROM ${T.members} WHERE id = ?`, [id]) : null;
        if (!m) return res.status(404).json({ error: 'Miembro no encontrado.' });
        if (m.source === 'stripe' && m.stripe_subscription_id && ACCESS_STATUSES.includes(m.status)) {
            try {
                await stripeRequest('DELETE', `/v1/subscriptions/${encodeURIComponent(m.stripe_subscription_id)}`, null);
            } catch (e) {
                console.warn('[memberships] Stripe cancellation failed:', e && e.message ? e.message : e);
                return res.status(502).json({ error: 'Stripe no canceló la suscripción — revisa la clave o inténtalo de nuevo.' });
            }
        }
        await db.run(`UPDATE ${T.members} SET status = 'canceled', cancel_at_period_end = 0, updated_at = ? WHERE id = ?`, [nowIso(), id]);
        res.json({ member: await adminMemberShape(await db.get(`SELECT * FROM ${T.members} WHERE id = ?`, [id])) });
    });

    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        const cfg = await getConfig();
        const sk = await getSetting('stripe_sk');
        const site = await wordjs.site.url();
        res.json({
            ...cfg,
            hasStripeKey: !!sk,
            stripeMode: keyMode(sk),
            hasWebhookSecret: !!(await getSetting('stripe_whsec')),
            webhookUrl: String(site).replace(/\/+$/, '') + '/api/v1/plugin/memberships/stripe/webhook',
        });
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const next = { ...(await getConfig()) };
        if (typeof body.currencyCode === 'string') {
            const code = body.currencyCode.trim().toLowerCase();
            if (!/^[a-z]{3}$/.test(code)) return res.status(400).json({ error: 'El código de moneda debe tener 3 letras (usd, eur, mxn…).' });
            next.currencyCode = code;
        }
        if (typeof body.currencySymbol === 'string') next.currencySymbol = body.currencySymbol.trim().slice(0, 8) || '$';
        if (typeof body.freeSignup === 'boolean') next.freeSignup = body.freeSignup;
        if (typeof body.stripeKey === 'string') {
            const k = body.stripeKey.trim();
            if (k && keyMode(k) !== 'test') {
                return res.status(400).json({ error: 'Esta versión solo acepta claves de PRUEBA de Stripe (sk_test_… o rk_test_…).' });
            }
        }
        if (typeof body.webhookSecret === 'string') {
            const w = body.webhookSecret.trim();
            if (w && !/^whsec_[A-Za-z0-9]+$/.test(w)) return res.status(400).json({ error: 'El secreto de firma del webhook empieza por whsec_.' });
        }
        await options.set(OPT_CONFIG, next);
        // Secrets: absent = keep, '' = clear, value = replace. Never echoed back.
        if (typeof body.stripeKey === 'string') await setSetting('stripe_sk', body.stripeKey.trim());
        if (typeof body.webhookSecret === 'string') await setSetting('stripe_whsec', body.webhookSecret.trim());
        const sk = await getSetting('stripe_sk');
        res.json({ ...next, hasStripeKey: !!sk, stripeMode: keyMode(sk), hasWebhookSecret: !!(await getSetting('stripe_whsec')) });
    });

    adminMenu.add({
        href: '/admin/plugin/memberships',
        label: 'Membresías',
        icon: 'fa-id-card',
        order: 73,
        cap: 'manage_options',
    });

    console.log('[memberships] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down: no timers, no servers. Core keeps gated posts gated (fail closed) while the
    // plugin is inactive; editors still read them in full.
};
