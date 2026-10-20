/**
 * Payment provider: Mercado Pago — Subscriptions without an associated plan (`/preapproval`).
 *
 * RECURRING MODEL: native. Mercado Pago charges the member every month (or every 12 months for a yearly
 * tier) on its own schedule; we create one preapproval per membership and follow its status.
 *  · checkout — POST /preapproval with `status: pending`, the tier's amount in the site currency (COP for a
 *    Colombian account; `transaction_amount` is in whole units, the tier stores minor units), the member's
 *    e-mail as `payer_email`, and `external_reference` naming the account and tier. The member authorises
 *    it on Mercado Pago's page (`init_point`), which returns to `back_url?preapproval_id=…`.
 *  · return leg and webhooks never trust the request: both RE-READ the preapproval from the API with the
 *    access token and apply what it says. Our own checkout row must exist for that preapproval, so a
 *    foreign subscription cannot be attached to an account.
 *  · webhook — `x-signature: ts=…,v1=…` is HMAC-SHA256 (webhook secret) of
 *    `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (a missing part is left out; an alphanumeric
 *    data.id is lower-cased), compared in constant time; `ts` must be within the tolerance below. Each
 *    notification (x-request-id) is processed once. Topics: `subscription_preapproval` (status changes) and
 *    `subscription_authorized_payment` (each charge; a rejected one marks the membership past due).
 *  · statuses — authorized → active (next_payment_date is the period end); paused → active until the
 *    period end, then expired (our "cancel at period end"); cancelled → canceled; pending → incomplete.
 *  · cancel / resume — PUT status `paused` / `authorized` (a `cancelled` preapproval cannot be resumed, so
 *    the member's own cancel pauses it); admin revoke — PUT `cancelled`.
 *  · change tier — PUT the new `transaction_amount` (Mercado Pago does not prorate: the new amount is
 *    charged from the next payment); the new tier is granted when that payment is approved, not before
 *    (an upgrade is never read before it is paid for).
 *  · amounts — the preapproval must carry the amount and currency this plugin created (or last set) it
 *    with, or it opens nothing. Tiers store integer cents (units × 100); currencies Mercado Pago takes as
 *    whole units (CLP, COP, PYG, …) are sent as integers.
 *  · one subscription being paid at a time — starting a checkout cancels the account's earlier
 *    preapprovals that were never authorised, so two of them cannot both start charging.
 * Credentials: an access token (`TEST-…` sandbox credentials, or `APP_USR-…` of a Mercado Pago TEST USER —
 * the way Mercado Pago recommends testing subscriptions) and the webhook secret. Live-mode notifications
 * (`live_mode: true`) are refused by this version.
 */

const API = 'https://api.mercadopago.com';
// Mercado Pago retries a notification every 15 minutes; a captured notification older than this is
// refused. Replays inside the window are harmless: the state is always re-read from the API.
const WEBHOOK_TOLERANCE_MS = 60 * 60 * 1000;

// Currencies charged in whole units (no cents) — Mercado Pago refuses decimals for them.
const WHOLE_UNIT_CURRENCIES = new Set(['clp', 'cop', 'pyg', 'jpy', 'krw', 'vnd', 'xaf', 'xof']);

const tokenMode = (t) => {
    const s = String(t || '');
    if (/^TEST-/.test(s)) return 'test';
    if (/^APP_USR-/.test(s)) return 'test-user';
    return '';
};

const statusFromMp = (s) => {
    if (s === 'authorized') return 'active';
    if (s === 'paused') return 'active';
    if (s === 'pending') return 'incomplete';
    return 'canceled'; // cancelled, anything new
};

function createMercadoPagoProvider(ctx) {
    const { wordjs, db, T, getSetting, tierById, upsertProviderMember, memberBySubscription, toInt, recordEvent, seenEvent, providerError, getConfig } = ctx;

    const accessToken = async () => {
        const t = await getSetting('mp_access_token');
        return tokenMode(t) ? t : '';
    };

    const request = async (method, path, body) => {
        const token = await accessToken();
        if (!token) throw providerError(400, 'Mercado Pago no está configurado.');
        const res = await fetch(API + path, {
            method,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const e = new Error((json && (json.message || json.error)) || ('HTTP ' + res.status));
            e.code = 'provider_http';
            throw e;
        }
        return json;
    };

    /** Integer cents → the amount Mercado Pago charges in `currency` (whole units where it has no cents). */
    const amountFromCents = (cents, currency) => (WHOLE_UNIT_CURRENCIES.has(String(currency || '').toLowerCase())
        ? Math.round((Number(cents) || 0) / 100)
        : Math.round(Number(cents) || 0) / 100);
    const amountOf = (tier, cfg) => amountFromCents(tier.price_cents, (cfg && cfg.currencyCode) || 'cop');
    const autoRecurring = (tier, cfg) => ({
        frequency: tier.billing_interval === 'year' ? 12 : 1,
        frequency_type: 'months',
        transaction_amount: amountOf(tier, cfg),
        currency_id: String(cfg.currencyCode || 'cop').toUpperCase(),
    });
    /** Does the preapproval charge what we created (or last set) it to charge, in that currency? */
    const chargesWhatWeSet = (pre, checkout) => {
        if (!checkout) return true;
        const ar = pre && pre.auto_recurring;
        if (!ar) return false;
        const currency = String(checkout.currency || '').toLowerCase();
        return Number(ar.transaction_amount) === amountFromCents(checkout.amount_cents, currency)
            && String(ar.currency_id || '').toLowerCase() === currency;
    };

    /** Apply a preapproval read from the API. Only one we created (a checkout row) is ever applied. */
    const applyPreapproval = async (pre, expectedUserId) => {
        if (!pre || !pre.id) return { ok: false, reason: 'no preapproval' };
        const checkout = await db.get(`SELECT * FROM ${T.checkouts} WHERE provider = 'mercadopago' AND session_id = ?`, [String(pre.id)]);
        const member = await memberBySubscription('mercadopago', String(pre.id));
        if (!checkout && !member) return { ok: false, reason: 'not one of ours' };
        const userId = member ? member.user_id : checkout.user_id;
        if (expectedUserId !== undefined && userId !== expectedUserId) return { ok: false, reason: 'belongs to another account' };
        // The tier: the member's current one, else the checkout's (a tier change waits in pending_tier_id
        // for its first approved charge).
        const tierId = member && member.tier_id ? member.tier_id : (checkout ? checkout.tier_id : null);
        // A preapproval that does not charge what this plugin set opens nothing.
        const status = chargesWhatWeSet(pre, checkout) ? statusFromMp(pre.status) : 'incomplete';
        await upsertProviderMember(userId, 'mercadopago', {
            tier_id: tierId && (await tierById(tierId)) ? tierId : undefined,
            status,
            customer_id: pre.payer_id ? String(pre.payer_id) : undefined,
            subscription_id: String(pre.id),
            current_period_end: pre.next_payment_date ? new Date(pre.next_payment_date).toISOString() : undefined,
            cancel_at_period_end: pre.status === 'paused',
        });
        if (checkout) await db.run(`UPDATE ${T.checkouts} SET status = ? WHERE id = ?`, [pre.status === 'authorized' ? 'complete' : String(pre.status || 'open').slice(0, 20), checkout.id]);
        return { ok: true, userId };
    };

    /** x-signature `ts=…,v1=…` over `id:…;request-id:…;ts:…;` (HMAC-SHA256, hex), within the tolerance. */
    const verifySignature = async (headers, dataId, secret, nowMs = Date.now()) => {
        const header = headers && headers['x-signature'];
        if (!secret || typeof header !== 'string') return false;
        let ts = '';
        let v1 = '';
        for (const part of header.split(',')) {
            const i = part.indexOf('=');
            if (i < 1) continue;
            const k = part.slice(0, i).trim();
            const v = part.slice(i + 1).trim();
            if (k === 'ts') ts = v;
            else if (k === 'v1') v1 = v.toLowerCase();
        }
        if (!/^\d{1,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(v1)) return false;
        // ts is in milliseconds in current notifications; accept seconds too.
        const tsMs = ts.length > 11 ? Number(ts) : Number(ts) * 1000;
        if (Math.abs(nowMs - tsMs) > WEBHOOK_TOLERANCE_MS) return false;
        const requestId = typeof headers['x-request-id'] === 'string' ? headers['x-request-id'] : '';
        const id = /^[A-Za-z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
        let manifest = '';
        if (id) manifest += `id:${id};`;
        if (requestId) manifest += `request-id:${requestId};`;
        manifest += `ts:${ts};`;
        const expected = await wordjs.crypto.hmac('sha256', secret, manifest, 'hex');
        return wordjs.crypto.timingSafeEqual(v1, expected);
    };

    return {
        id: 'mercadopago',
        label: 'Mercado Pago',
        credentials: [
            { key: 'accessToken', setting: 'mp_access_token', label: 'Access token de prueba (TEST-… o APP_USR-… de un usuario de prueba)', pattern: /^(TEST|APP_USR)-[A-Za-z0-9-]+$/, error: 'El access token de Mercado Pago empieza por TEST- (o APP_USR- de un usuario de prueba).' },
            { key: 'webhookSecret', setting: 'mp_webhook_secret', label: 'Clave secreta de las notificaciones (Webhooks)', pattern: /^[A-Za-z0-9]{16,128}$/, error: 'La clave secreta de los webhooks de Mercado Pago son 16–128 letras y números.' },
        ],
        webhookPath: '/mercadopago/webhook',
        mode: async () => tokenMode(await getSetting('mp_access_token')),
        isReady: async () => !!(await accessToken()),
        currencies: null, // the account's own currency (COP in Colombia, ARS, MXN, BRL…)

        /**
         * APP_USR- is also the format of PRODUCTION tokens: one is only accepted when Mercado Pago says it
         * belongs to a test user (`/users/me` → tags includes "test_user").
         */
        async validateCredentials(values) {
            const token = typeof values.accessToken === 'string' ? values.accessToken.trim() : '';
            if (!/^APP_USR-/.test(token)) return;
            let me = null;
            try {
                const res = await fetch(API + '/users/me', { method: 'GET', headers: { Authorization: 'Bearer ' + token } });
                me = res.ok ? await res.json().catch(() => null) : null;
            } catch (e) { me = null; }
            if (!me) throw providerError(400, 'No se pudo comprobar el access token con Mercado Pago — revísalo e inténtalo de nuevo.');
            if (!Array.isArray(me.tags) || !me.tags.includes('test_user')) {
                throw providerError(400, 'Ese access token no es de un usuario de prueba: esta versión solo acepta credenciales de prueba.');
            }
        },

        manages: (member) => !!(member && member.source === 'mercadopago' && member.provider_subscription_id),

        async startCheckout({ userId, email, tier, backUrl, cfg }) {
            if (!email) throw providerError(400, 'Tu cuenta necesita un correo para pagar con Mercado Pago.');
            const back = new URL(backUrl.toString());
            back.searchParams.set('ms_provider', 'mercadopago');
            // Earlier preapprovals of this account that were never authorised are cancelled first.
            const stale = await db.all(`SELECT id, session_id FROM ${T.checkouts} WHERE user_id = ? AND provider = 'mercadopago' AND status IN ('open', 'pending') AND session_id IS NOT NULL`, [userId]);
            for (const row of stale) {
                try { await request('PUT', `/preapproval/${encodeURIComponent(row.session_id)}`, { status: 'cancelled' }); } catch (e) { /* already authorised or gone: the webhook applies it */ }
                await db.run(`UPDATE ${T.checkouts} SET status = 'cancelled' WHERE id = ? AND status IN ('open', 'pending')`, [row.id]);
            }
            const nonce = await wordjs.crypto.randomToken(6);
            const reference = `wjm:${userId}:${tier.id}:${nonce}`;
            const pre = await request('POST', '/preapproval', {
                reason: String(tier.name).slice(0, 120),
                external_reference: reference,
                payer_email: email,
                auto_recurring: autoRecurring(tier, cfg),
                back_url: back.toString(),
                status: 'pending',
            });
            if (!pre || !pre.id || !pre.init_point) throw providerError(502, 'Mercado Pago no devolvió una URL de pago.');
            await db.run(`INSERT INTO ${T.checkouts} (user_id, tier_id, provider, session_id, reference, amount_cents, currency) VALUES (?, ?, 'mercadopago', ?, ?, ?, ?)`,
                [userId, tier.id, String(pre.id).slice(0, 200), reference, tier.price_cents, String(cfg.currencyCode || '').toLowerCase()]);
            return { url: pre.init_point };
        },

        async confirmReturn({ userId, query }) {
            const id = String((query && query.preapproval_id) || '').trim();
            if (!id) return { handled: false };
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw providerError(400, 'Suscripción inválida.');
            const ours = await db.get(`SELECT id FROM ${T.checkouts} WHERE provider = 'mercadopago' AND session_id = ? AND user_id = ?`, [id, userId]);
            if (!ours) throw providerError(404, 'Esa suscripción no es de tu cuenta.');
            const pre = await request('GET', `/preapproval/${encodeURIComponent(id)}`, null);
            const r = await applyPreapproval(pre, userId);
            return { handled: true, applied: r.ok };
        },

        async changeTier(member, tier, cfg) {
            const currency = String(cfg.currencyCode || 'cop').toLowerCase();
            const pre = await request('PUT', `/preapproval/${encodeURIComponent(member.provider_subscription_id)}`, {
                reason: String(tier.name).slice(0, 120),
                auto_recurring: { transaction_amount: amountOf(tier, cfg), currency_id: currency.toUpperCase() },
            });
            // What the preapproval charges now, for chargesWhatWeSet; the tier itself waits for that charge.
            await db.run(`UPDATE ${T.checkouts} SET amount_cents = ?, currency = ? WHERE provider = 'mercadopago' AND session_id = ?`,
                [tier.price_cents, currency, String(member.provider_subscription_id)]);
            await upsertProviderMember(member.user_id, 'mercadopago', { pending_tier_id: tier.id });
            await applyPreapproval(pre, member.user_id);
            return { effective: 'next-charge' };
        },

        async setCancelAtPeriodEnd(member, flag) {
            const pre = await request('PUT', `/preapproval/${encodeURIComponent(member.provider_subscription_id)}`, { status: flag ? 'paused' : 'authorized' });
            await applyPreapproval(pre, member.user_id);
        },

        async cancelNow(member) {
            await request('PUT', `/preapproval/${encodeURIComponent(member.provider_subscription_id)}`, { status: 'cancelled' });
        },

        async webhook(req) {
            const secret = await getSetting('mp_webhook_secret');
            if (!secret) return { status: 400, body: { error: 'webhook secret not configured' } };
            let body = req.body;
            if ((!body || typeof body !== 'object') && typeof req.rawBody === 'string') {
                try { body = JSON.parse(req.rawBody); } catch (e) { body = {}; }
            }
            body = body || {};
            const q = req.query || {};
            const dataId = String(q['data.id'] || (body.data && body.data.id) || '').trim();
            if (!(await verifySignature(req.headers || {}, dataId, secret))) return { status: 401, body: { error: 'invalid signature' } };
            if (body.live_mode === true) return { status: 400, body: { error: 'live notifications are not accepted by this version' } };
            const type = String(q.type || q.topic || body.type || '').trim();
            const requestId = String((req.headers && req.headers['x-request-id']) || '');
            const key = `mercadopago:${requestId || `${type}:${dataId}:${body.date_created || ''}`}`;
            if (await seenEvent(key)) return { status: 200, body: { received: true, duplicate: true } };
            if (!dataId || !/^[A-Za-z0-9_-]{1,64}$/.test(dataId)) return { status: 400, body: { error: 'invalid notification' } };
            if (type === 'subscription_preapproval') {
                await applyPreapproval(await request('GET', `/preapproval/${encodeURIComponent(dataId)}`, null), undefined);
            } else if (type === 'subscription_authorized_payment') {
                const charge = await request('GET', `/authorized_payments/${encodeURIComponent(dataId)}`, null);
                const preId = charge && charge.preapproval_id ? String(charge.preapproval_id) : '';
                if (preId) {
                    await applyPreapproval(await request('GET', `/preapproval/${encodeURIComponent(preId)}`, null), undefined);
                    const paymentStatus = charge.payment && charge.payment.status;
                    const m = await memberBySubscription('mercadopago', preId);
                    if (m && (paymentStatus === 'rejected' || charge.status === 'recycling')) await ctx.setMemberStatus(m, 'past_due');
                    else if (m && paymentStatus === 'approved') {
                        await ctx.setMemberStatus(m, 'active');
                        // A tier change takes effect with the first charge approved at its price.
                        if (m.pending_tier_id && (await tierById(m.pending_tier_id))) {
                            await upsertProviderMember(m.user_id, 'mercadopago', { tier_id: m.pending_tier_id, pending_tier_id: null });
                        }
                    }
                }
            }
            await recordEvent(key, type || 'unknown');
            return { status: 200, body: { received: true } };
        },
    };
}

module.exports = { createMercadoPagoProvider, mpTokenMode: tokenMode };
