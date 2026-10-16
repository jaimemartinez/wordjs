/**
 * Payment provider: Stripe (Checkout in `subscription` mode). TEST KEYS ONLY in this version.
 *
 * Unchanged behaviour from memberships 1.0/1.1, moved behind the provider interface (./index.js):
 *  · checkout — a Checkout Session for the tier's price (a Stripe product per tier, created on first use);
 *  · return leg — `?ms_session=<id>`: the session is retrieved server-side and must be this account's;
 *  · webhook — `Stripe-Signature` (HMAC-SHA256 over `${t}.${rawBody}`, 5-minute tolerance), each event once;
 *  · change tier — the subscription item moves to the new price, prorated; cancel / resume —
 *    `cancel_at_period_end`; admin revoke — the subscription is deleted at once.
 */

const WEBHOOK_TOLERANCE_S = 300;

const keyMode = (key) => {
    const k = String(key || '');
    if (/^(sk|rk)_test_/.test(k)) return 'test';
    if (/^(sk|rk)_live_/.test(k)) return 'live';
    return '';
};

/** Form-encode a nested object the way Stripe expects (a[b][c]=v). */
function formEncode(obj) {
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
}

const statusFromStripe = (s) => {
    if (s === 'active' || s === 'trialing') return 'active';
    if (s === 'past_due' || s === 'unpaid') return 'past_due';
    if (s === 'incomplete') return 'incomplete';
    return 'canceled'; // canceled, incomplete_expired, paused, anything new
};

function createStripeProvider(ctx) {
    const { wordjs, db, T, getSetting, tierById, upsertProviderMember, memberBySubscription, toInt, isoFromUnix, recordEvent, seenEvent, providerError } = ctx;

    const secretKey = async () => {
        const k = await getSetting('stripe_sk');
        return keyMode(k) === 'test' ? k : '';
    };

    const request = async (method, path, body) => {
        const key = await secretKey();
        if (!key) throw providerError(400, 'El pago con tarjeta no está configurado.');
        const res = await fetch('https://api.stripe.com' + path, {
            method,
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body ? formEncode(body).toString() : undefined,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const e = new Error(json && json.error && json.error.message ? json.error.message : ('HTTP ' + res.status));
            e.code = 'provider_http';
            throw e;
        }
        return json;
    };

    /** The Stripe product a tier bills under (created on first use, then reused). */
    const ensureProduct = async (tier) => {
        if (tier.stripe_product_id) return tier.stripe_product_id;
        const product = await request('POST', '/v1/products', { name: tier.name, metadata: { wordjs_tier_id: tier.id } });
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

    /** Apply a Stripe subscription object to the membership it belongs to (by id, else by metadata). */
    const applySubscription = async (sub) => {
        if (!sub || !sub.id) return null;
        const member = await memberBySubscription('stripe', String(sub.id));
        const metaUser = sub.metadata ? toInt(sub.metadata.wordjs_user_id) : NaN;
        if (!member && !Number.isInteger(metaUser)) return null; // not one of ours
        const userId = member ? member.user_id : metaUser;
        const metaTier = sub.metadata ? toInt(sub.metadata.wordjs_tier_id) : NaN;
        const tierId = Number.isInteger(metaTier) && (await tierById(metaTier)) ? metaTier : undefined;
        return upsertProviderMember(userId, 'stripe', {
            tier_id: tierId,
            status: statusFromStripe(sub.status),
            customer_id: sub.customer ? String(sub.customer) : undefined,
            subscription_id: String(sub.id),
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
        await upsertProviderMember(userId, 'stripe', {
            tier_id: tierId,
            status: sub ? statusFromStripe(sub.status) : (session.payment_status === 'paid' || session.payment_status === 'no_payment_required' ? 'active' : 'incomplete'),
            customer_id: session.customer ? String(typeof session.customer === 'object' ? session.customer.id : session.customer) : undefined,
            subscription_id: session.subscription ? String(sub ? sub.id : session.subscription) : undefined,
            current_period_end: sub ? periodEndOf(sub) : undefined,
            cancel_at_period_end: sub ? !!sub.cancel_at_period_end : undefined,
        });
        if (session.id) await db.run(`UPDATE ${T.checkouts} SET status = 'complete' WHERE session_id = ?`, [String(session.id)]);
        return { ok: true, userId };
    };

    /** `t=<unix>,v1=<hex>[,v1=…]` over the raw body, every v1 compared in constant time, within tolerance. */
    const verifySignature = async (header, rawBody, secret, nowSec = Math.floor(Date.now() / 1000)) => {
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
        for (const s of sigs) if (await wordjs.crypto.timingSafeEqual(s, expected)) match = true;
        return match;
    };

    return {
        id: 'stripe',
        label: 'Stripe',
        credentials: [
            { key: 'secretKey', setting: 'stripe_sk', label: 'Clave secreta (sk_test_…)', pattern: /^(sk|rk)_test_[A-Za-z0-9]+$/, error: 'Esta versión solo acepta claves de PRUEBA de Stripe (sk_test_… o rk_test_…).' },
            { key: 'webhookSecret', setting: 'stripe_whsec', label: 'Secreto de firma del webhook (whsec_…)', pattern: /^whsec_[A-Za-z0-9]+$/, error: 'El secreto de firma del webhook empieza por whsec_.' },
        ],
        webhookPath: '/stripe/webhook',
        mode: async () => keyMode(await getSetting('stripe_sk')),
        isReady: async () => !!(await secretKey()),
        // Stripe handles every currency the account supports; the tier price is in the currency's minor unit.
        currencies: null,

        manages: (member) => !!(member && member.source === 'stripe' && member.provider_subscription_id),

        async startCheckout({ userId, email, tier, member, backUrl, cfg }) {
            const success = new URL(backUrl.toString());
            success.searchParams.set('ms_session', '{CHECKOUT_SESSION_ID}');
            const cancel = new URL(backUrl.toString());
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
            if (member && member.source === 'stripe' && member.provider_customer_id) params.customer = member.provider_customer_id;
            else if (email) params.customer_email = email;
            const session = await request('POST', '/v1/checkout/sessions', params);
            if (!session || !session.url || !session.id) throw providerError(502, 'Stripe no devolvió una URL de pago.');
            await db.run(`INSERT INTO ${T.checkouts} (user_id, tier_id, provider, session_id, amount_cents, currency) VALUES (?, ?, 'stripe', ?, ?, ?)`,
                [userId, tier.id, String(session.id).slice(0, 200), tier.price_cents, String(cfg.currencyCode || '').toLowerCase()]);
            return { url: session.url };
        },

        async confirmReturn({ userId, query }) {
            const sessionId = String((query && query.session_id) || '').trim();
            if (!sessionId) return { handled: false };
            if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) throw providerError(400, 'Sesión de pago inválida.');
            const ours = await db.get(`SELECT * FROM ${T.checkouts} WHERE session_id = ? AND user_id = ? AND provider = 'stripe'`, [sessionId, userId]);
            if (!ours) throw providerError(404, 'Esa sesión de pago no es de tu cuenta.');
            const session = await request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, null);
            const r = await applyCompletedSession(session, userId);
            return { handled: true, applied: r.ok };
        },

        async changeTier(member, tier, cfg) {
            const current = await request('GET', `/v1/subscriptions/${encodeURIComponent(member.provider_subscription_id)}`, null);
            const item = current && current.items && Array.isArray(current.items.data) ? current.items.data[0] : null;
            if (!item) throw new Error('subscription has no item');
            const sub = await request('POST', `/v1/subscriptions/${encodeURIComponent(member.provider_subscription_id)}`, {
                items: [{ id: item.id, price_data: await priceData(tier, cfg) }],
                proration_behavior: 'create_prorations',
                cancel_at_period_end: 'false',
                metadata: { wordjs_user_id: member.user_id, wordjs_tier_id: tier.id },
            });
            await applySubscription(sub);
            return { effective: 'now' };
        },

        async setCancelAtPeriodEnd(member, flag) {
            const sub = await request('POST', `/v1/subscriptions/${encodeURIComponent(member.provider_subscription_id)}`, {
                cancel_at_period_end: flag ? 'true' : 'false',
            });
            await applySubscription(sub);
        },

        async cancelNow(member) {
            await request('DELETE', `/v1/subscriptions/${encodeURIComponent(member.provider_subscription_id)}`, null);
        },

        async webhook(req) {
            const secret = await getSetting('stripe_whsec');
            const signature = req.headers && req.headers['stripe-signature'];
            if (!secret) return { status: 400, body: { error: 'webhook signing secret not configured' } };
            if (!(await verifySignature(signature, req.rawBody, secret))) return { status: 400, body: { error: 'invalid signature' } };
            let event;
            try { event = JSON.parse(req.rawBody); } catch (e) { return { status: 400, body: { error: 'invalid payload' } }; }
            if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return { status: 400, body: { error: 'invalid event' } };
            if (event.livemode === true) return { status: 400, body: { error: 'live events are not accepted by this version' } };
            const key = 'stripe:' + event.id;
            if (await seenEvent(key)) return { status: 200, body: { received: true, duplicate: true } };
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
                    const m = subId ? await memberBySubscription('stripe', String(subId)) : null;
                    if (m) await ctx.setMemberStatus(m, event.type === 'invoice.paid' ? 'active' : 'past_due');
                    break;
                }
                default:
                    break; // acknowledged so Stripe stops retrying
            }
            // Recorded AFTER it was applied: a failure above answers 500 and Stripe retries it.
            await recordEvent(key, event.type);
            return { status: 200, body: { received: true } };
        },
    };
}

module.exports = { createStripeProvider, stripeKeyMode: keyMode };
