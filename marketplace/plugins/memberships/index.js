/**
 * WordJS Plugin: Memberships — members-only content, free and paid tiers, paid memberships through a
 * payment provider (Stripe, Mercado Pago or Wompi), complimentary memberships and newsletters
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
 * member ACCOUNT box (plan, change tier, cancel / resume, automatic renewal, newsletters).
 *
 * MEMBERS ARE THE SITE'S OWN USER ACCOUNTS. Signing up is core's /register (with its e-mail verification,
 * rate limits and MFA); signing in is core's session. A sandboxed plugin cannot hash passwords (no crypto
 * module) and a second auth stack would duplicate every hardening the core one carries. With free
 * sign-up on (the default), every signed-in account is a free member; paid and complimentary memberships
 * are rows in this plugin's table, keyed by user id.
 *
 * PAYMENTS go through ONE provider interface (lib/providers/index.js); the admin picks the provider.
 * SANDBOX / TEST CREDENTIALS ONLY in this version. Each provider verifies its own webhooks (Stripe:
 * Stripe-Signature HMAC; Mercado Pago: x-signature HMAC; Wompi: events-secret checksum), processes each
 * event once, and writes memberships through upsertProviderMember below. Recurring models differ — see
 * each provider file and documentation/memberships.md. Credentials live in the plugin's OWN settings
 * table, write-only from the admin (absent = keep, '' = clear, value = replace), never echoed back.
 *
 * Money is integer minor units throughout (cents; COP 20.000 = 2000000); prices come from the tier rows,
 * never from the client. Newsletters live in lib/newsletter.js.
 */

const { initNewsletter } = require('./lib/newsletter');
const { createProviders, PROVIDER_IDS } = require('./lib/providers');
let newsletter = null;
let renewTimer = null;

exports.metadata = {
    name: 'Memberships',
    version: '1.2.0',
    description: 'Members-only content: free and paid tiers, paywall block, Stripe / Mercado Pago / Wompi payments, complimentary memberships, newsletters.',
    author: 'WordJS',
};

const OPT_CONFIG = 'memberships_config';
const CONFIG_DEFAULTS = {
    currencyCode: 'usd',
    currencySymbol: '$',
    // Every signed-in account counts as a free member (holds the `members` level).
    freeSignup: true,
    // Which provider takes the money ('' = none). Existing installs keep Stripe.
    paymentProvider: 'stripe',
    // Newsletters (lib/newsletter.js): the editor field and the publish trigger, and the send rate.
    newsletterEnabled: true,
    newsletterRate: 60, // mails per minute
};

const LEVEL_MEMBERS = 'members';
const LEVEL_PAID = 'paid';
const TIER_LEVEL_PREFIX = 'tier:';

const MIN_PRICE_CENTS = 100;            // 1.00 in the site currency
const MAX_PRICE_CENTS = 100000000000;   // 1,000,000,000.00 (COP prices are large numbers)
const INTERVALS = ['month', 'year'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A paid membership whose period ended this long ago without a renewal stops granting access (a missed
// cancellation webhook must not leave a lapsed account reading paid content forever).
const PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
// Rate caps on the endpoints that call a provider on a member's behalf.
const PROVIDER_CALLS_PER_USER = 10;
const PROVIDER_CALLS_WINDOW_MS = 60 * 1000;
const LIMITER_MAX_KEYS = 10000;
const RENEW_TICK_MS = 10 * 60 * 1000;

// Member states. `active`/`past_due` grant access (the provider is still retrying a failed renewal), the
// rest (incomplete, canceled, expired) do not.
const ACCESS_STATUSES = ['active', 'past_due'];
const PAID_SOURCES = ['stripe', 'mercadopago', 'wompi'];

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
        pending_tier_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'stripe',
        provider_customer_id TEXT,
        provider_subscription_id TEXT,
        provider_payment_source TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER DEFAULT 0,
        renew_attempts INTEGER DEFAULT 0,
        comped_until TEXT,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.checkouts} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        tier_id INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT 'stripe',
        kind TEXT NOT NULL DEFAULT 'subscription',
        session_id TEXT,
        reference TEXT,
        amount_cents INTEGER,
        currency TEXT,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.events} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT UNIQUE NOT NULL,
        type TEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS ${T.settings} (name TEXT PRIMARY KEY, value TEXT)`);
    try {
        await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_members_sub ON ${T.members} (provider_subscription_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_checkouts_session ON ${T.checkouts} (session_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_checkouts_reference ON ${T.checkouts} (reference)`);
    } catch (e) { /* index exists / unsupported — non-fatal */ }

    // ---- plugin-private settings (provider credentials) -------------------------------------------------
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
            if (e && e.publicMessage) return res.status(e.status || 400).json({ error: e.publicMessage });
            console.error(`[memberships] ${what} failed:`, e && e.message ? e.message : e);
            res.status(e && e.code === 'provider_http' ? 502 : 500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
        }
    };
    const providerError = (status, publicMessage) => {
        const e = new Error(publicMessage);
        e.status = status;
        e.publicMessage = publicMessage;
        return e;
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
    const providerCallAllowed = makeLimiter(PROVIDER_CALLS_PER_USER, PROVIDER_CALLS_WINDOW_MS);

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
    const memberBySubscription = (provider, subId) =>
        db.get(`SELECT * FROM ${T.members} WHERE source = ? AND provider_subscription_id = ?`, [provider, String(subId)]);

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

    // ---- the ONE writer of paid memberships (every provider uses it) ------------------------------------
    const FIELD_COLUMNS = {
        tier_id: 'tier_id', pending_tier_id: 'pending_tier_id', status: 'status',
        customer_id: 'provider_customer_id', subscription_id: 'provider_subscription_id', payment_source: 'provider_payment_source',
        current_period_end: 'current_period_end', cancel_at_period_end: 'cancel_at_period_end', renew_attempts: 'renew_attempts',
    };
    /** Create or update the paid membership of `userId` from `provider` (undefined fields keep their value). */
    const upsertProviderMember = async (userId, provider, fields) => {
        const existing = await memberByUser(userId);
        const sets = [];
        const vals = [];
        for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
            if (fields[field] === undefined) continue;
            let v = fields[field];
            if (field === 'cancel_at_period_end') v = v ? 1 : 0;
            sets.push(`${column} = ?`);
            vals.push(v);
        }
        if (existing) {
            // Switching a membership to a provider clears what belonged to another one.
            const switching = existing.source !== provider;
            const extra = switching
                ? `, comped_until = NULL${fields.customer_id === undefined ? ', provider_customer_id = NULL' : ''}${fields.subscription_id === undefined ? ', provider_subscription_id = NULL' : ''}${fields.payment_source === undefined ? ', provider_payment_source = NULL' : ''}`
                : '';
            await db.run(`UPDATE ${T.members} SET source = ?${sets.length ? ', ' + sets.join(', ') : ''}${extra}, updated_at = ? WHERE id = ?`,
                [provider, ...vals, nowIso(), existing.id]);
        } else {
            const cols = ['user_id', 'source', ...Object.entries(FIELD_COLUMNS).filter(([f]) => fields[f] !== undefined).map(([, c]) => c), 'updated_at'];
            if (fields.status === undefined) { cols.splice(2, 0, 'status'); vals.unshift('active'); }
            await db.run(`INSERT INTO ${T.members} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                [userId, provider, ...vals, nowIso()]);
        }
        return memberByUser(userId);
    };
    /** A provider-reported state change, never reviving a canceled membership. */
    const setMemberStatus = (member, status) =>
        db.run(`UPDATE ${T.members} SET status = ?, updated_at = ? WHERE id = ? AND status != 'canceled'`, [status, nowIso(), member.id]);

    // Each provider event once (Stripe event id, Mercado Pago request id, Wompi transaction + status).
    const seenEvent = async (key) => !!(await db.get(`SELECT id FROM ${T.events} WHERE event_key = ?`, [String(key).slice(0, 250)]));
    const recordEvent = async (key, type) => {
        try { await db.run(`INSERT INTO ${T.events} (event_key, type) VALUES (?, ?)`, [String(key).slice(0, 250), String(type || '').slice(0, 100)]); }
        catch (e) { /* a concurrent delivery recorded it first — the work is idempotent */ }
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

    // ---- payment providers ------------------------------------------------------------------------------
    const providers = createProviders({
        wordjs, db, T, getSetting, setSetting, getConfig, tierById, memberByUser, memberBySubscription,
        upsertProviderMember, setMemberStatus, toInt, nowIso, isoFromUnix, recordEvent, seenEvent, providerError,
    });
    /** The provider the admin chose, when it is ready (credentials present, test mode) and fits the currency. */
    const activeProvider = async () => {
        const cfg = await getConfig();
        const p = providers.get(cfg.paymentProvider);
        if (!p || !(await p.isReady())) return null;
        if (p.currencies && !p.currencies.includes(String(cfg.currencyCode || '').toLowerCase())) return null;
        return p;
    };

    /** The page to return to, on THIS site: only the path and query of `pageUrl` are kept. */
    const returnUrl = async (pageUrl) => {
        const site = new URL(await wordjs.site.url());
        let path = '/';
        try {
            const u = new URL(String(pageUrl || ''), site);
            for (const k of ['ms_session', 'ms_cancel', 'ms_provider', 'preapproval_id', 'id', 'env']) u.searchParams.delete(k);
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
        const p = await activeProvider();
        res.json({
            tiers: tiers.map(publicTier),
            currencyCode: cfg.currencyCode,
            currencySymbol: cfg.currencySymbol,
            freeSignup: !!cfg.freeSignup,
            paymentsEnabled: !!p,
            provider: p ? p.id : null,
            providerLabel: p ? p.label : null,
            // Kept for blocks built against 1.0/1.1.
            stripeEnabled: !!p,
        });
    }));

    // The signed-in account's own membership (the blocks ask; 401 = signed out).
    http.route('get', '/me', { auth: true }, quietly('account', async (req, res) => {
        const userId = Number(req.user && req.user.id);
        const m = await memberByUser(userId);
        const tier = m && m.tier_id ? await tierById(m.tier_id) : null;
        const pending = m && m.pending_tier_id ? await tierById(m.pending_tier_id) : null;
        const provider = m ? providers.get(m.source) : null;
        let autoRenew = null;
        if (provider && provider.autoRenewStatus && memberHasAccess(m)) autoRenew = await provider.autoRenewStatus(m).catch(() => null);
        res.json({
            signedIn: true,
            member: m ? {
                status: m.status,
                source: m.source,
                provider: PAID_SOURCES.includes(m.source) ? m.source : null,
                active: memberHasAccess(m),
                tier: tier ? publicTier(tier) : null,
                pendingTier: pending ? publicTier(pending) : null,
                currentPeriodEnd: m.current_period_end || null,
                cancelAtPeriodEnd: !!m.cancel_at_period_end,
                compedUntil: m.comped_until || null,
                canManageBilling: !!(provider && provider.manages(m) && memberHasAccess(m)),
                canRenewNow: !!(provider && provider.allowsRepurchase && memberHasAccess(m)),
                autoRenew,
            } : null,
            levels: await grantsForUser(userId),
        });
    }));

    // Start paying for a tier with the active provider. The price is the tier row's; the client names a tier.
    http.route('post', '/checkout', { auth: true }, quietly('checkout', async (req, res) => {
        const userId = Number(req.user && req.user.id);
        if (!providerCallAllowed('u' + userId)) return res.status(429).json({ error: 'Demasiados intentos — espera un minuto.' });
        const tierId = toInt(req.body && req.body.tier_id);
        const tier = Number.isInteger(tierId) ? await tierById(tierId) : null;
        if (!tier || !tier.is_active) return res.status(404).json({ error: 'Ese plan no existe o no está disponible.' });
        const provider = await activeProvider();
        if (!provider) return res.status(400).json({ error: 'El pago en línea no está configurado.' });
        const existing = await memberByUser(userId);
        const existingProvider = existing ? providers.get(existing.source) : null;
        // One live paid membership at a time: a second one (or one with another provider) would charge twice.
        // Only a provider whose payments are prepaid periods (Wompi) takes another payment: the next period.
        if (existing && existingProvider && existingProvider.manages(existing) && memberHasAccess(existing)
            && !(existingProvider === provider && provider.allowsRepurchase)) {
            return res.status(409).json({ error: 'Ya tienes una suscripción activa — cambia de plan desde tu cuenta.' });
        }
        const cfg = await getConfig();
        const email = req.user && req.user.userEmail && EMAIL_RE.test(req.user.userEmail) ? req.user.userEmail : '';
        let out;
        try {
            out = await provider.startCheckout({ userId, email, tier, member: existing, backUrl: await returnUrl(req.body && req.body.page_url), cfg });
        } catch (e) {
            if (e && e.publicMessage) throw e;
            console.warn(`[memberships] ${provider.id} checkout failed:`, e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo iniciar el pago — inténtalo de nuevo.' });
        }
        res.json({ checkoutUrl: out.url, provider: provider.id });
    }));

    // The return leg: the provider re-reads the payment server-side; it must be this account's (idempotent).
    http.route('get', '/me/confirm', { auth: true }, quietly('checkout confirmation', async (req, res) => {
        const userId = Number(req.user && req.user.id);
        const q = req.query || {};
        const id = String(q.provider || (q.session_id ? 'stripe' : '') || '');
        const provider = providers.get(id);
        if (!provider) return res.status(400).json({ error: 'Pago inválido.' });
        if (!providerCallAllowed('u' + userId)) return res.status(429).json({ error: 'Demasiados intentos — espera un minuto.' });
        let r;
        try {
            r = await provider.confirmReturn({ userId, query: q });
        } catch (e) {
            if (e && e.publicMessage) throw e;
            console.warn(`[memberships] ${provider.id} confirmation failed:`, e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo verificar el pago — inténtalo en unos minutos.' });
        }
        if (!r.handled) return res.status(400).json({ error: 'Pago inválido.' });
        const m = await memberByUser(userId);
        res.json({ active: !!(r.applied && memberHasAccess(m)) });
    }));

    /** The account's live paid membership and its provider, or a reply explaining why there is none. */
    const billingMember = async (req, res) => {
        const userId = Number(req.user && req.user.id);
        const m = await memberByUser(userId);
        const provider = m ? providers.get(m.source) : null;
        if (!m || !provider || !provider.manages(m) || !memberHasAccess(m)) {
            res.status(404).json({ error: 'No tienes una suscripción activa.' });
            return null;
        }
        if (!providerCallAllowed('u' + userId)) { res.status(429).json({ error: 'Demasiados intentos — espera un minuto.' }); return null; }
        return { m, provider };
    };

    http.route('post', '/me/change-tier', { auth: true }, quietly('tier change', async (req, res) => {
        const b = await billingMember(req, res);
        if (!b) return;
        const tierId = toInt(req.body && req.body.tier_id);
        const tier = Number.isInteger(tierId) ? await tierById(tierId) : null;
        if (!tier || !tier.is_active) return res.status(404).json({ error: 'Ese plan no existe o no está disponible.' });
        if (tier.id === b.m.tier_id) return res.status(400).json({ error: 'Ya estás en ese plan.' });
        let r;
        try {
            r = await b.provider.changeTier(b.m, tier, await getConfig());
        } catch (e) {
            if (e && e.publicMessage) throw e;
            console.warn(`[memberships] ${b.provider.id} tier change failed:`, e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo cambiar de plan — inténtalo de nuevo.' });
        }
        res.json({ ok: true, tier: publicTier(tier), effective: (r && r.effective) || 'now' });
    }));

    // Cancel at the end of the paid period (access continues until then), or undo that.
    const setCancelAtPeriodEnd = (flag) => quietly(flag ? 'cancel' : 'resume', async (req, res) => {
        const b = await billingMember(req, res);
        if (!b) return;
        try {
            await b.provider.setCancelAtPeriodEnd(b.m, flag);
        } catch (e) {
            if (e && e.publicMessage) throw e;
            console.warn(`[memberships] ${b.provider.id} cancel/resume failed:`, e && e.message ? e.message : e);
            return res.status(502).json({ error: 'No se pudo actualizar la suscripción — inténtalo de nuevo.' });
        }
        res.json({ ok: true, cancelAtPeriodEnd: flag });
    });
    http.route('post', '/me/cancel', { auth: true }, setCancelAtPeriodEnd(true));
    http.route('post', '/me/resume', { auth: true }, setCancelAtPeriodEnd(false));

    // Wompi automatic renewal with Nequi (the member approves in the Nequi app).
    http.route('post', '/me/auto-renew/nequi', { auth: true }, quietly('nequi auto-renew', async (req, res) => {
        const b = await billingMember(req, res);
        if (!b) return;
        if (!b.provider.startNequi) return res.status(400).json({ error: 'La renovación automática con Nequi es de Wompi.' });
        res.json(await b.provider.startNequi(b.m, String((req.body && req.body.phone) || '').replace(/\D/g, '')));
    }));
    http.route('post', '/me/auto-renew/stop', { auth: true }, quietly('auto-renew stop', async (req, res) => {
        const b = await billingMember(req, res);
        if (!b) return;
        if (!b.provider.stopAutoRenew) return res.status(400).json({ error: 'Este proveedor renueva solo.' });
        await b.provider.stopAutoRenew(b.m);
        res.json({ ok: true });
    }));

    // ---- provider webhooks (core `{ webhook: true }`: raw body, no identity, CSRF-exempt) --------------
    for (const p of providers.list) {
        http.route('post', p.webhookPath, { webhook: true }, async (req, res) => {
            try {
                const out = await p.webhook(req);
                res.status(out.status).json(out.body);
            } catch (e) {
                // A failure here answers 5xx: the provider retries and the (unrecorded) event is applied then.
                console.error(`[memberships] ${p.id} webhook failed:`, e && e.message ? e.message : e);
                res.status(500).json({ error: 'webhook processing failed' });
            }
        });
    }

    // ---- merchant-scheduled renewals (Wompi) and expiry ------------------------------------------------
    const processPayments = async () => {
        const out = { renewed: 0, expired: 0 };
        for (const p of providers.list) {
            if (p.renewDue) {
                const r = await p.renewDue();
                out.renewed += (r && r.charged) || 0;
            }
        }
        // A paid membership whose period (plus grace) is over and that nothing renewed is expired.
        const rows = await db.all(`SELECT * FROM ${T.members} WHERE status IN ('active', 'past_due') AND source != 'comped' AND current_period_end IS NOT NULL`);
        for (const m of rows) {
            if (!memberHasAccess(m)) {
                await db.run(`UPDATE ${T.members} SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('active', 'past_due')`, [nowIso(), m.id]);
                out.expired++;
            }
        }
        return out;
    };
    renewTimer = setInterval(() => { processPayments().catch((e) => console.warn('[memberships] payments job:', e && e.message ? e.message : e)); }, RENEW_TICK_MS);
    if (renewTimer && typeof renewTimer.unref === 'function') renewTimer.unref();

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
            auto_renew: !!(m.provider_payment_source && String(m.provider_payment_source).startsWith('source:')),
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
        const existingProvider = existing ? providers.get(existing.source) : null;
        if (existing && existingProvider && existingProvider.manages(existing) && memberHasAccess(existing)) {
            return res.status(409).json({ error: 'Esta cuenta ya paga una suscripción: cancélala antes de regalarle un plan.' });
        }
        if (existing) {
            await db.run(
                `UPDATE ${T.members} SET tier_id = ?, pending_tier_id = NULL, status = 'active', source = 'comped', comped_until = ?, note = ?, cancel_at_period_end = 0,
                 provider_subscription_id = NULL, provider_payment_source = NULL, updated_at = ? WHERE id = ?`,
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

    // Revoke: a comped membership ends now; a paid one is cancelled at its provider immediately.
    http.route('post', '/members/:id/revoke', { auth: true, admin: true }, async (req, res) => {
        const id = toInt(req.params.id);
        const m = Number.isInteger(id) ? await db.get(`SELECT * FROM ${T.members} WHERE id = ?`, [id]) : null;
        if (!m) return res.status(404).json({ error: 'Miembro no encontrado.' });
        const provider = providers.get(m.source);
        if (provider && provider.manages(m) && ACCESS_STATUSES.includes(m.status)) {
            try {
                await provider.cancelNow(m);
            } catch (e) {
                console.warn(`[memberships] ${provider.id} cancellation failed:`, e && e.message ? e.message : e);
                return res.status(502).json({ error: `${provider.label} no canceló la suscripción — revisa las credenciales o inténtalo de nuevo.` });
            }
        }
        await db.run(`UPDATE ${T.members} SET status = 'canceled', cancel_at_period_end = 0, updated_at = ? WHERE id = ?`, [nowIso(), id]);
        res.json({ member: await adminMemberShape(await db.get(`SELECT * FROM ${T.members} WHERE id = ?`, [id])) });
    });

    // Run renewals and expiry now (the job does it every few minutes).
    http.route('post', '/payments/process', { auth: true, admin: true }, async (req, res) => {
        res.json(await processPayments());
    });

    /** Provider settings for the admin: which credentials are set (never their values) and the webhook URL. */
    const providerSettings = async () => {
        const site = String(await wordjs.site.url()).replace(/\/+$/, '');
        const out = [];
        for (const p of providers.list) {
            const creds = [];
            for (const c of p.credentials) {
                const v = await getSetting(c.setting);
                // Masked: only whether it is set — never the value or any part of it.
                creds.push({ key: c.key, label: c.label, set: !!v });
            }
            out.push({
                id: p.id, label: p.label, ready: await p.isReady(), mode: await p.mode(),
                currencies: p.currencies, credentials: creds, webhookUrl: site + '/api/v1/plugin/memberships' + p.webhookPath,
            });
        }
        return out;
    };

    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        const cfg = await getConfig();
        const site = await wordjs.site.url();
        const stripe = providers.get('stripe');
        res.json({
            ...cfg,
            providers: await providerSettings(),
            // Kept for admin screens built against 1.0/1.1.
            hasStripeKey: !!(await getSetting('stripe_sk')),
            stripeMode: await stripe.mode(),
            hasWebhookSecret: !!(await getSetting('stripe_whsec')),
            webhookUrl: String(site).replace(/\/+$/, '') + '/api/v1/plugin/memberships/stripe/webhook',
        });
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        const next = { ...(await getConfig()) };
        if (typeof body.currencyCode === 'string') {
            const code = body.currencyCode.trim().toLowerCase();
            if (!/^[a-z]{3}$/.test(code)) return res.status(400).json({ error: 'El código de moneda debe tener 3 letras (cop, usd, eur…).' });
            next.currencyCode = code;
        }
        if (typeof body.currencySymbol === 'string') next.currencySymbol = body.currencySymbol.trim().slice(0, 8) || '$';
        if (typeof body.freeSignup === 'boolean') next.freeSignup = body.freeSignup;
        if (typeof body.newsletterEnabled === 'boolean') next.newsletterEnabled = body.newsletterEnabled;
        if (body.newsletterRate !== undefined) {
            const rate = toInt(body.newsletterRate);
            if (!Number.isInteger(rate) || rate < 1 || rate > 600) return res.status(400).json({ error: 'El ritmo de envío debe estar entre 1 y 600 correos por minuto.' });
            next.newsletterRate = rate;
        }
        if (body.paymentProvider !== undefined) {
            const id = String(body.paymentProvider || '');
            if (id && !PROVIDER_IDS.includes(id)) return res.status(400).json({ error: 'Proveedor de pagos desconocido.' });
            next.paymentProvider = id;
        }
        const chosen = providers.get(next.paymentProvider);
        if (chosen && chosen.currencies && !chosen.currencies.includes(String(next.currencyCode).toLowerCase())) {
            return res.status(400).json({ error: `${chosen.label} solo cobra en ${chosen.currencies.join(', ').toUpperCase()}: cambia la moneda del sitio.` });
        }
        // Credentials: { credentials: { <provider>: { <key>: value } } }, plus the 1.0/1.1 Stripe aliases.
        const writes = [];
        const incoming = body.credentials && typeof body.credentials === 'object' ? { ...body.credentials } : {};
        if (typeof body.stripeKey === 'string') incoming.stripe = { ...(incoming.stripe || {}), secretKey: body.stripeKey };
        if (typeof body.webhookSecret === 'string') incoming.stripe = { ...(incoming.stripe || {}), webhookSecret: body.webhookSecret };
        for (const [pid, values] of Object.entries(incoming)) {
            const p = providers.get(pid);
            if (!p || !values || typeof values !== 'object') continue;
            for (const c of p.credentials) {
                if (typeof values[c.key] !== 'string') continue;   // absent = keep
                const v = values[c.key].trim();
                if (v && !c.pattern.test(v)) return res.status(400).json({ error: c.error });
                writes.push([c.setting, v]);                         // '' = clear, value = replace
            }
            // A provider whose test and live credentials share a format checks with the provider itself.
            if (p.validateCredentials) {
                try { await p.validateCredentials(values); } catch (e) {
                    return res.status((e && e.status) || 400).json({ error: (e && e.publicMessage) || 'Credenciales no válidas.' });
                }
            }
        }
        await options.set(OPT_CONFIG, next);
        for (const [name, v] of writes) await setSetting(name, v);
        const stripe = providers.get('stripe');
        res.json({
            ...next,
            providers: await providerSettings(),
            hasStripeKey: !!(await getSetting('stripe_sk')),
            stripeMode: await stripe.mode(),
            hasWebhookSecret: !!(await getSetting('stripe_whsec')),
        });
    });

    // ---- newsletters ------------------------------------------------------------------------------
    newsletter = await initNewsletter({
        wordjs, db, P, getConfig, grantsForUser, getSetting, setSetting,
        quietly: (what, handler) => quietly(what, handler),
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
    // The newsletter queue and the payments job are the only timers; queued work stays in the tables and
    // resumes on the next activation. Core keeps gated posts gated (fail closed) while the plugin is inactive.
    if (newsletter) { newsletter.stop(); newsletter = null; }
    if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
};
