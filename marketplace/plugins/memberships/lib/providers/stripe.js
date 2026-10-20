/**
 * Payment provider: Stripe (Checkout in `subscription` mode). TEST KEYS ONLY in this version.
 *
 * Unchanged behaviour from memberships 1.0/1.1, moved behind the provider interface (./index.js):
 *  · checkout — a Checkout Session for the tier's price (a Stripe product per tier, created on first use);
 *  · return leg — `?ms_session=<id>`: the session is retrieved server-side and must be this account's;
 *  · webhook — `Stripe-Signature` (HMAC-SHA256 over `${t}.${rawBody}`, 5-minute tolerance), each event once;
 *  · change tier — the subscription item moves to the new price, prorated; cancel / resume —
 *    `cancel_at_period_end`; admin revoke — the subscription is deleted at once;
 *  · ORDER — Stripe does not deliver events in order and retries for days: an event older than the newest
 *    one applied to the membership changes nothing, a canceled subscription never comes back, and an event
 *    about a subscription the account no longer pays with never touches the one it pays with now;
 *  · refunds — a FULL refund or a dispute of a charge ends that customer's membership at once (its
 *    subscription is deleted at Stripe, so it is not charged again).
 * Amounts: tiers store integer cents (units × 100, like every WordJS plugin); Stripe takes the currency's
 * own minor unit, so zero-decimal currencies (JPY, CLP, …) are divided by 100 and three-decimal ones
 * (KWD, BHD, …) multiplied by 10.
 */

const WEBHOOK_TOLERANCE_S = 300;

// https://docs.stripe.com/currencies#zero-decimal and #three-decimal
const STRIPE_ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const STRIPE_THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
/** Integer cents (units × 100) → the amount Stripe expects for `currency`. */
const toStripeAmount = (cents, currency) => {
    const c = String(currency || '').toLowerCase();
    const n = Math.round(Number(cents) || 0);
    if (STRIPE_ZERO_DECIMAL.has(c)) return Math.round(n / 100);
    if (STRIPE_THREE_DECIMAL.has(c)) return n * 10;
    return n;
};

const ACCESS_STATUSES = ['active', 'past_due'];

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
    // Stripe is still retrying the renewal: access for the grace window only (index.js memberHasAccess).
    if (s === 'past_due') return 'past_due';
    // Retries exhausted (unpaid), awaiting the first payment, or paused: no access, but not over either.
    if (s === 'incomplete' || s === 'unpaid' || s === 'paused') return 'incomplete';
    return 'canceled'; // canceled, incomplete_expired, anything new
};

function createStripeProvider(ctx) {
    const { wordjs, db, T, getSetting, tierById, upsertProviderMember, memberBySubscription, memberByUser, toInt, isoFromUnix, recordEvent, seenEvent, providerError } = ctx;

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
        unit_amount: toStripeAmount(tier.price_cents, cfg.currencyCode || 'usd'),
        recurring: { interval: tier.billing_interval },
    });

    /** A subscription's period end, wherever this API version puts it (top level or per item). */
    const periodEndOf = (sub) => {
        if (!sub) return null;
        if (sub.current_period_end) return isoFromUnix(sub.current_period_end);
        const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
        return item && item.current_period_end ? isoFromUnix(item.current_period_end) : null;
    };

    /** Is this event older than the newest one applied to `member`? (`eventAt`: Stripe's `created`, seconds) */
    const staleFor = (member, eventAt) =>
        !!(member && Number.isInteger(eventAt) && Number(member.provider_event_at || 0) > eventAt);

    /**
     * Apply a Stripe subscription object to the membership it belongs to (by id, else by metadata).
     * `eventAt` is the event's `created` when it comes from a webhook (undefined: read from the API now).
     */
    const applySubscription = async (sub, eventAt) => {
        if (!sub || !sub.id) return null;
        const member = await memberBySubscription('stripe', String(sub.id));
        const metaUser = sub.metadata ? toInt(sub.metadata.wordjs_user_id) : NaN;
        if (!member && !Number.isInteger(metaUser)) return null; // not one of ours
        if (member) {
            if (staleFor(member, eventAt)) return member;
            // A canceled subscription stays canceled: a late "active" update must not revive it.
            if (member.status === 'canceled' && statusFromStripe(sub.status) !== 'canceled') return member;
        } else {
            // An event about a subscription the account no longer pays with (it re-subscribed since) must
            // not overwrite the live one.
            const current = await memberByUser(metaUser);
            if (current && current.provider_subscription_id && String(current.provider_subscription_id) !== String(sub.id)
                && ACCESS_STATUSES.includes(current.status)) return null;
        }
        const userId = member ? member.user_id : metaUser;
        // The tier is the one whose Stripe product the subscription bills now (a tier change that waits for
        // its payment moves the item only once paid); the metadata is the fallback (renamed tiers).
        const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
        const product = item && item.price ? (typeof item.price.product === 'object' && item.price.product ? item.price.product.id : item.price.product) : null;
        const byProduct = product ? await db.get(`SELECT id FROM ${T.tiers} WHERE stripe_product_id = ?`, [String(product)]) : null;
        const metaTier = sub.metadata ? toInt(sub.metadata.wordjs_tier_id) : NaN;
        const tierId = byProduct ? byProduct.id : (Number.isInteger(metaTier) && (await tierById(metaTier)) ? metaTier : undefined);
        return upsertProviderMember(userId, 'stripe', {
            tier_id: tierId,
            status: statusFromStripe(sub.status),
            customer_id: sub.customer ? String(sub.customer) : undefined,
            subscription_id: String(sub.id),
            current_period_end: periodEndOf(sub),
            cancel_at_period_end: !!sub.cancel_at_period_end,
            // A tier change waiting for its payment shows as `pending_update`; once it is paid (the item moved)
            // or has lapsed unpaid, nothing is pending any more.
            pending_tier_id: sub.pending_update ? undefined : null,
            event_at: Number.isInteger(eventAt) ? eventAt : undefined,
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
        let sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
        // The period end comes from the subscription: without it the membership would never lapse.
        if (!sub && typeof session.subscription === 'string' && session.subscription) {
            sub = await request('GET', `/v1/subscriptions/${encodeURIComponent(session.subscription)}`, null);
        }
        // A second subscription completed while the account already pays with another one (two tabs): the
        // new one stays, the old one is deleted at once and prorated — the unused part becomes a credit on
        // the customer that the new subscription's next invoice uses (the same customer is reused).
        const current = await memberByUser(userId);
        if (sub && current && current.source === 'stripe' && current.provider_subscription_id
            && String(current.provider_subscription_id) !== String(sub.id) && ACCESS_STATUSES.includes(current.status)) {
            await request('DELETE', `/v1/subscriptions/${encodeURIComponent(current.provider_subscription_id)}?prorate=true`, null);
        }
        await upsertProviderMember(userId, 'stripe', {
            tier_id: tierId,
            status: sub ? statusFromStripe(sub.status) : (session.payment_status === 'paid' || session.payment_status === 'no_payment_required' ? 'active' : 'incomplete'),
            customer_id: session.customer ? String(typeof session.customer === 'object' ? session.customer.id : session.customer) : undefined,
            subscription_id: session.subscription ? String(sub ? sub.id : session.subscription) : undefined,
            current_period_end: sub ? periodEndOf(sub) : undefined,
            cancel_at_period_end: sub ? !!sub.cancel_at_period_end : undefined,
            pending_tier_id: null,
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
            // One open checkout per account: the ones started before (another tab, a double click) are
            // expired at Stripe, so two subscriptions cannot both be paid for and both keep billing.
            const open = await db.all(`SELECT id, session_id FROM ${T.checkouts} WHERE user_id = ? AND provider = 'stripe' AND status = 'open' AND session_id IS NOT NULL`, [userId]);
            for (const row of open) {
                try { await request('POST', `/v1/checkout/sessions/${encodeURIComponent(row.session_id)}/expire`, null); } catch (e) { /* already completed or expired */ }
                await db.run(`UPDATE ${T.checkouts} SET status = 'expired' WHERE id = ? AND status = 'open'`, [row.id]);
            }
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
            // The difference is invoiced NOW and the item moves only once that invoice is paid
            // (pending_if_incomplete): an upgrade is never read before it is paid for. A downgrade's unused
            // part becomes a credit.
            const moved = await request('POST', `/v1/subscriptions/${encodeURIComponent(member.provider_subscription_id)}`, {
                items: [{ id: item.id, price_data: await priceData(tier, cfg) }],
                proration_behavior: 'always_invoice',
                payment_behavior: 'pending_if_incomplete',
            });
            if (moved && moved.pending_update) {
                await upsertProviderMember(member.user_id, 'stripe', { pending_tier_id: tier.id });
                return { effective: 'pending-payment' };
            }
            const sub = await request('POST', `/v1/subscriptions/${encodeURIComponent(member.provider_subscription_id)}`, {
                cancel_at_period_end: 'false',
                metadata: { wordjs_user_id: member.user_id, wordjs_tier_id: tier.id },
            });
            await upsertProviderMember(member.user_id, 'stripe', { pending_tier_id: null });
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
            const eventAt = Number.isInteger(event.created) ? event.created : undefined;
            const idOf = (v) => (v && typeof v === 'object' ? v.id : v);
            // The event names WHAT changed; the state applied is always re-read from the API, so a late or
            // replayed event can only ever apply the current state.
            const refreshSubscription = async (subId) => {
                if (!subId || !/^sub_[A-Za-z0-9]{1,200}$/.test(String(subId))) return;
                await applySubscription(await request('GET', `/v1/subscriptions/${encodeURIComponent(String(subId))}`, null), eventAt);
            };
            switch (event.type) {
                case 'checkout.session.completed': {
                    const id = obj && typeof obj.id === 'string' && /^cs_[A-Za-z0-9_]{1,200}$/.test(obj.id) ? obj.id : null;
                    if (id && obj.metadata && obj.metadata.wordjs_user_id) {
                        await applyCompletedSession(await request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription`, null), undefined);
                    }
                    break;
                }
                case 'customer.subscription.created':
                case 'customer.subscription.updated':
                case 'customer.subscription.deleted':
                    if (obj && ((obj.metadata && obj.metadata.wordjs_user_id) || (obj.id && await memberBySubscription('stripe', String(obj.id))))) {
                        await refreshSubscription(obj.id);
                    }
                    break;
                case 'invoice.payment_failed':
                case 'invoice.paid': {
                    const subId = obj && idOf(obj.subscription
                        || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription));
                    if (subId && await memberBySubscription('stripe', String(subId))) await refreshSubscription(subId);
                    break;
                }
                // A full refund or a dispute ends the membership of the customer who paid: the subscription is
                // deleted at Stripe (no further charge) and access stops now.
                case 'charge.refunded':
                case 'charge.dispute.created': {
                    let charge = obj;
                    if (event.type === 'charge.dispute.created') {
                        const chargeId = obj && idOf(obj.charge);
                        charge = chargeId && /^(ch|py)_[A-Za-z0-9]{1,200}$/.test(String(chargeId))
                            ? await request('GET', `/v1/charges/${encodeURIComponent(String(chargeId))}`, null) : null;
                    } else if (!(obj && obj.refunded === true)) {
                        break; // a partial refund leaves the membership as it is
                    }
                    const customer = charge && idOf(charge.customer);
                    const m = customer ? await db.get(`SELECT * FROM ${T.members} WHERE source = 'stripe' AND provider_customer_id = ?`, [String(customer)]) : null;
                    if (m && ACCESS_STATUSES.includes(m.status)) {
                        if (m.provider_subscription_id) {
                            await request('DELETE', `/v1/subscriptions/${encodeURIComponent(m.provider_subscription_id)}`, null).catch((e) => {
                                // Already gone at Stripe is fine; anything else answers 500 and Stripe retries.
                                if (!/No such subscription|canceled/i.test(String(e && e.message))) throw e;
                            });
                        }
                        await db.run(`UPDATE ${T.members} SET status = 'canceled', cancel_at_period_end = 0, pending_tier_id = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), m.id]);
                    }
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
