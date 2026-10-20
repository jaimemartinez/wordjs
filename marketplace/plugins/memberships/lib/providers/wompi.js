/**
 * Payment provider: Wompi (Bancolombia, Colombia). SANDBOX KEYS ONLY in this version.
 *
 * RECURRING MODEL. Wompi has NO native subscriptions: every charge is a transaction the merchant creates.
 * So a membership is a sequence of PAID PERIODS (one month, or twelve for a yearly tier):
 *  · Pay a period — Wompi Web Checkout (https://checkout.wompi.co/p/), where the member pays with card,
 *    PSE, Nequi or Bancolombia. The redirect carries an INTEGRITY signature
 *    SHA256(reference + amount_in_cents + currency + integrity secret). An approved transaction (return
 *    leg, re-read from the API, or the `transaction.updated` event) extends the membership by one period
 *    from max(now, current period end). Without automatic renewal the membership simply ends at the period
 *    end and the member pays the next one the same way (the account block offers it).
 *  · Automatic renewal — with a NEQUI payment source: the member enters their Nequi phone, approves the
 *    subscription in the Nequi app, and we create a Wompi payment source (acceptance tokens from
 *    /merchants/{public key}). Our renewal job (cron) then charges that source with a new transaction when
 *    the period is about to end; the result arrives as `transaction.updated`. A declined renewal marks the
 *    membership past due and is retried daily, three times at most, then the membership is canceled.
 *    EACH CHARGE IS CLAIMED BEFORE IT IS MADE: its reference names the account, the period and the attempt
 *    (unique in the checkouts table), so two runs — the timer and the admin's button, or two servers —
 *    cannot both charge the same period. A charge whose result has not arrived is ASKED about
 *    (GET /transactions/{id}, or by reference if its id was never stored), never charged again.
 *    Card payment sources are not offered in this version: tokenizing a card has to happen in the browser
 *    against Wompi's API, which the site's content security policy does not allow and which would put the
 *    site in PCI scope; cards still pay each period through Web Checkout.
 *  · Events — `signature.properties` (paths into `data`) are concatenated in order, then `timestamp`, then
 *    the EVENTS secret; SHA256 hex must equal `signature.checksum` (and `X-Event-Checksum` when sent),
 *    compared in constant time. `environment` must be `test`. The signed properties must include the
 *    transaction's id, status and amount (what Wompi signs), and the transaction applied is RE-READ from
 *    the API by that id — never taken from the event body, whose other fields are not signed. An event
 *    older than WEBHOOK_TOLERANCE_S is refused (Wompi retries a failed delivery for up to 24 hours, with
 *    the original timestamp). Each (transaction id, status) is applied once, and only for a reference this
 *    plugin created, with the amount and currency it recorded.
 *  · A VOIDED transaction that had opened a period takes that period back.
 *  · Cancel / resume — stop or restart automatic renewal (access continues to the end of the paid period).
 *    Change tier — takes effect at the next period (renewal or payment).
 * Currency: COP only (Wompi's only currency). Amounts are integer cents (COP 20.000 = 2000000).
 */

const SANDBOX_API = 'https://sandbox.wompi.co/v1';
const CHECKOUT_URL = 'https://checkout.wompi.co/p/';
const WEBHOOK_TOLERANCE_S = 26 * 60 * 60;
const RENEW_LEAD_MS = 24 * 60 * 60 * 1000;      // charge the source a day before the period ends
const RENEW_RETRY_MS = 24 * 60 * 60 * 1000;     // retry a declined renewal daily
const RENEW_MAX_ATTEMPTS = 3;
const AUTO_RENEW_STATUS_TTL_MS = 30 * 1000;     // how long the account block's Nequi status answer is reused
// What a transaction event must sign, at least (Wompi signs these for `transaction.updated`).
const REQUIRED_TXN_PROPS = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
const REQUIRED_NEQUI_PROPS = ['nequi_token.id', 'nequi_token.status'];

const keyKind = (k) => {
    const s = String(k || '');
    if (/^pub_test_/.test(s)) return 'public';
    if (/^prv_test_/.test(s)) return 'private';
    if (/^test_events_/.test(s)) return 'events';
    if (/^test_integrity_/.test(s)) return 'integrity';
    return '';
};

/** Add one billing period (1 or 12 months) to `fromMs`, calendar-aware. */
function addPeriod(fromMs, interval, sign = 1) {
    const d = new Date(fromMs);
    d.setUTCMonth(d.getUTCMonth() + sign * (interval === 'year' ? 12 : 1));
    return d.getTime();
}

/** A DATETIME column (`YYYY-MM-DD HH:MM:SS`, UTC) as epoch ms. */
const dbTime = (v) => {
    const t = Date.parse(String(v || '').includes('T') ? String(v) : String(v || '').replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : 0;
};

/** The value at `path` ("transaction.id") inside `data`. */
function pathValue(data, path) {
    let cur = data;
    for (const k of String(path).split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[k];
    }
    return cur;
}

function createWompiProvider(ctx) {
    const { wordjs, db, T, getSetting, tierById, memberByUser, upsertProviderMember, toInt, nowIso, recordEvent, seenEvent, providerError, getConfig, setMemberStatus } = ctx;

    const keys = async () => ({
        pub: await getSetting('wompi_public_key'),
        prv: await getSetting('wompi_private_key'),
        events: await getSetting('wompi_events_secret'),
        integrity: await getSetting('wompi_integrity_secret'),
    });
    // The EVENTS secret is required too: without it no result of a charge could be verified, and the
    // renewal job would have nothing but polling to learn that a period was paid.
    const ready = async () => {
        const k = await keys();
        return keyKind(k.pub) === 'public' && keyKind(k.prv) === 'private' && keyKind(k.integrity) === 'integrity'
            && keyKind(k.events) === 'events';
    };

    const request = async (method, path, body, auth = 'private') => {
        const k = await keys();
        const key = auth === 'public' ? k.pub : k.prv;
        if (!key) throw providerError(400, 'Wompi no está configurado.');
        const res = await fetch(SANDBOX_API + path, {
            method,
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const reason = json && json.error && (json.error.reason || json.error.type || JSON.stringify(json.error.messages || ''));
            const e = new Error(reason || ('HTTP ' + res.status));
            e.code = 'provider_http';
            throw e;
        }
        return json && json.data !== undefined ? json.data : json;
    };

    const integrityOf = async (reference, amountInCents, currency) =>
        wordjs.crypto.hash('sha256', `${reference}${amountInCents}${currency}${(await keys()).integrity}`, 'hex');

    const newReference = async (kind, userId, tierId) => `wjm_${kind}_${userId}_${tierId}_${await wordjs.crypto.randomToken(6)}`;

    /** Extend the membership of the checkout's account by one period of its tier (idempotent per checkout). */
    const activatePeriod = async (checkout, txn) => {
        const flipped = await db.run(`UPDATE ${T.checkouts} SET status = 'complete', session_id = ? WHERE id = ? AND status != 'complete'`,
            [String(txn.id || '').slice(0, 200), checkout.id]);
        if (!flipped || flipped.changes !== 1) return { ok: true, duplicate: true };
        const tier = await tierById(checkout.tier_id);
        if (!tier) return { ok: false, reason: 'unknown tier' };
        const member = await memberByUser(checkout.user_id);
        const live = member && member.source === 'wompi' && ['active', 'past_due'].includes(member.status);
        const currentEnd = live && member.current_period_end ? Date.parse(member.current_period_end) : 0;
        const from = Math.max(Date.now(), Number.isFinite(currentEnd) ? currentEnd : 0);
        await upsertProviderMember(checkout.user_id, 'wompi', {
            tier_id: tier.id,
            pending_tier_id: null,
            status: 'active',
            subscription_id: `wompi-${checkout.user_id}`,
            customer_id: txn.customer_email ? String(txn.customer_email).slice(0, 254) : undefined,
            current_period_end: new Date(addPeriod(from, tier.billing_interval)).toISOString(),
            renew_attempts: 0,
        });
        return { ok: true };
    };

    /** Apply a transaction (from the API or a verified event) to the checkout it belongs to. */
    const applyTransaction = async (txn, expectedUserId) => {
        if (!txn || !txn.reference) return { ok: false, reason: 'no transaction' };
        const checkout = await db.get(`SELECT * FROM ${T.checkouts} WHERE provider = 'wompi' AND reference = ?`, [String(txn.reference)]);
        if (!checkout) return { ok: false, reason: 'not one of ours' };
        if (expectedUserId !== undefined && checkout.user_id !== expectedUserId) return { ok: false, reason: 'belongs to another account' };
        if (Number(txn.amount_in_cents) !== Number(checkout.amount_cents) || String(txn.currency || '').toUpperCase() !== 'COP') {
            return { ok: false, reason: 'amount or currency mismatch' };
        }
        if (txn.status === 'APPROVED') return activatePeriod(checkout, txn);
        // A payment voided after it opened a period takes that period back (and access with it, when the
        // period it leaves has already ended).
        if (txn.status === 'VOIDED' && checkout.status === 'complete') {
            const flipped = await db.run(`UPDATE ${T.checkouts} SET status = 'voided' WHERE id = ? AND status = 'complete'`, [checkout.id]);
            if (!flipped || flipped.changes !== 1) return { ok: true, duplicate: true };
            const m = await memberByUser(checkout.user_id);
            const tier = await tierById(checkout.tier_id);
            const end = m && m.source === 'wompi' && m.current_period_end ? Date.parse(m.current_period_end) : NaN;
            if (Number.isFinite(end)) {
                const back = addPeriod(end, tier ? tier.billing_interval : 'month', -1);
                await upsertProviderMember(m.user_id, 'wompi', {
                    current_period_end: new Date(back).toISOString(),
                    ...(back <= Date.now() ? { status: 'expired' } : {}),
                });
            }
            return { ok: true, voided: true };
        }
        if (['DECLINED', 'ERROR', 'VOIDED'].includes(txn.status)) {
            await db.run(`UPDATE ${T.checkouts} SET status = ? WHERE id = ? AND status != 'complete'`, [String(txn.status).toLowerCase(), checkout.id]);
            if (checkout.kind === 'renewal') {
                const m = await memberByUser(checkout.user_id);
                if (m && m.source === 'wompi') {
                    const attempts = (m.renew_attempts || 0) + 1;
                    await upsertProviderMember(m.user_id, 'wompi', { renew_attempts: attempts });
                    await setMemberStatus(m, attempts >= RENEW_MAX_ATTEMPTS ? 'canceled' : 'past_due');
                }
            }
        }
        return { ok: true, status: txn.status };
    };

    /** Wompi event checksum (constant-time), environment and age; `required` properties must be signed. */
    const verifyEvent = async (event, headerChecksum, required = [], nowSec = Math.floor(Date.now() / 1000)) => {
        const secret = (await keys()).events;
        if (keyKind(secret) !== 'events' || !event || typeof event !== 'object') return false;
        const sig = event.signature || {};
        const props = Array.isArray(sig.properties) ? sig.properties : null;
        const checksum = String(sig.checksum || '').toLowerCase();
        const ts = Number(event.timestamp);
        if (!props || !props.length || props.length > 20 || !/^[0-9a-f]{64}$/.test(checksum) || !Number.isInteger(ts)) return false;
        if (!required.every((p) => props.includes(p))) return false;
        if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_S) return false;
        let concat = '';
        for (const p of props) {
            if (typeof p !== 'string' || !/^[a-z_]+(\.[a-z_]+){0,4}$/.test(p)) return false;
            const v = pathValue(event.data, p);
            concat += v == null ? '' : String(v);
        }
        const expected = await wordjs.crypto.hash('sha256', `${concat}${ts}${secret}`, 'hex');
        if (!(await wordjs.crypto.timingSafeEqual(checksum, expected))) return false;
        if (headerChecksum && !(await wordjs.crypto.timingSafeEqual(String(headerChecksum).toLowerCase(), expected))) return false;
        return true;
    };

    // ---- Nequi payment source (automatic renewal) ----------------------------------------------------
    const acceptanceTokens = async () => {
        const merchant = await request('GET', `/merchants/${encodeURIComponent((await keys()).pub)}`, null, 'public');
        return {
            acceptance: merchant && merchant.presigned_acceptance && merchant.presigned_acceptance.acceptance_token,
            personal: merchant && merchant.presigned_personal_data_auth && merchant.presigned_personal_data_auth.acceptance_token,
        };
    };

    /** A Nequi token APPROVED by the member becomes the membership's payment source. */
    const attachNequiSource = async (member, token, email) => {
        const t = await acceptanceTokens();
        if (!t.acceptance) throw new Error('no acceptance token');
        const source = await request('POST', '/payment_sources', {
            type: 'NEQUI', token, customer_email: email, acceptance_token: t.acceptance,
            ...(t.personal ? { accept_personal_auth: t.personal } : {}),
        });
        if (!source || !source.id) throw new Error('payment source not created');
        await upsertProviderMember(member.user_id, 'wompi', { payment_source: `source:${source.id}`, cancel_at_period_end: false });
        return source.id;
    };

    /** A pending Nequi approval, asked at Wompi: approved → becomes the payment source; declined → dropped. */
    const nequiStatusCache = new Map();
    const nequiTokenStatus = async (member, src) => {
        const tok = await request('GET', `/tokens/nequi/${encodeURIComponent(src.slice(6))}`, null, 'public').catch(() => null);
        if (tok && tok.status === 'APPROVED') {
            const user = await wordjs.users.findById(member.user_id).catch(() => null);
            await attachNequiSource(member, tok.id, user && user.userEmail);
            return { method: 'nequi', state: 'active' };
        }
        if (tok && tok.status === 'DECLINED') {
            await upsertProviderMember(member.user_id, 'wompi', { payment_source: null });
            return { method: 'nequi', state: 'declined' };
        }
        return { method: 'nequi', state: 'pending' };
    };

    /** Charge every due payment source once (the renewal job). */
    const renewDue = async () => {
        if (!(await ready())) return { charged: 0 };
        const cfg = await getConfig();
        const now = Date.now();
        const rows = await db.all(
            `SELECT * FROM ${T.members} WHERE source = 'wompi' AND status IN ('active', 'past_due') AND cancel_at_period_end = 0
             AND provider_payment_source LIKE 'source:%' AND current_period_end IS NOT NULL`
        );
        let charged = 0;
        for (const m of rows) {
            const end = Date.parse(m.current_period_end);
            if (!Number.isFinite(end) || end - RENEW_LEAD_MS > now) continue;
            const last = await db.get(`SELECT * FROM ${T.checkouts} WHERE provider = 'wompi' AND user_id = ? AND kind = 'renewal' ORDER BY id DESC LIMIT 1`, [m.user_id]);
            // A charge whose result has not arrived is ASKED about, never made again.
            if (last && last.status === 'pending') {
                let txn = null;
                if (last.session_id) {
                    txn = await request('GET', `/transactions/${encodeURIComponent(last.session_id)}`, null).catch(() => null);
                } else {
                    // Claimed, but the id was never stored (the run stopped mid-way): look it up by reference.
                    const found = await request('GET', `/transactions?reference=${encodeURIComponent(last.reference)}`, null).catch(() => null);
                    txn = Array.isArray(found) ? found[0] || null : null;
                    if (txn && txn.id) await db.run(`UPDATE ${T.checkouts} SET session_id = ? WHERE id = ?`, [String(txn.id).slice(0, 200), last.id]);
                    else if (!txn && now - dbTime(last.created_at) > RENEW_RETRY_MS) {
                        // Nothing reached Wompi in a day: the claim is released and the next attempt may charge.
                        await db.run(`UPDATE ${T.checkouts} SET status = 'error' WHERE id = ? AND status = 'pending'`, [last.id]);
                        await upsertProviderMember(m.user_id, 'wompi', { renew_attempts: (m.renew_attempts || 0) + 1 });
                    }
                }
                if (txn && txn.status && txn.status !== 'PENDING') await applyTransaction(txn, undefined);
                continue;
            }
            // A declined charge is retried a day later. (An approved one moved current_period_end, so the
            // due check above skips it.)
            if (last && last.status !== 'complete' && now - dbTime(last.created_at) < RENEW_RETRY_MS) continue;
            const tier = await tierById(m.pending_tier_id || m.tier_id);
            if (!tier) continue;
            const user = await wordjs.users.findById(m.user_id).catch(() => null);
            const email = user && user.userEmail;
            if (!email) continue;
            // THE CLAIM: one reference per (account, period, attempt), unique in the table. Another run that
            // got here first owns this charge.
            const reference = `wjm_renewal_${m.user_id}_${Math.floor(end / 1000)}_${m.renew_attempts || 0}`;
            let r;
            try {
                r = await db.run(`INSERT INTO ${T.checkouts} (user_id, tier_id, provider, kind, reference, amount_cents, currency, status) VALUES (?, ?, 'wompi', 'renewal', ?, ?, 'cop', 'pending')`,
                    [m.user_id, tier.id, reference, tier.price_cents]);
            } catch (e) {
                continue; // claimed by another run
            }
            try {
                const txn = await request('POST', '/transactions', {
                    amount_in_cents: tier.price_cents,
                    currency: 'COP',
                    signature: await integrityOf(reference, tier.price_cents, 'COP'),
                    customer_email: email,
                    reference,
                    payment_source_id: Number(String(m.provider_payment_source).slice('source:'.length)),
                });
                charged++;
                if (txn && txn.id) await db.run(`UPDATE ${T.checkouts} SET session_id = ? WHERE id = ?`, [String(txn.id).slice(0, 200), r.lastID]);
                if (txn && txn.status && txn.status !== 'PENDING') await applyTransaction(txn, undefined);
            } catch (e) {
                await db.run(`UPDATE ${T.checkouts} SET status = 'error' WHERE id = ?`, [r.lastID]);
                const attempts = (m.renew_attempts || 0) + 1;
                await upsertProviderMember(m.user_id, 'wompi', { renew_attempts: attempts });
                await setMemberStatus(m, attempts >= RENEW_MAX_ATTEMPTS ? 'canceled' : 'past_due');
                console.warn('[memberships] Wompi renewal failed:', e && e.message ? e.message : e);
            }
        }
        return { charged, currency: cfg.currencyCode };
    };

    return {
        id: 'wompi',
        label: 'Wompi (Bancolombia)',
        credentials: [
            { key: 'publicKey', setting: 'wompi_public_key', label: 'Llave pública (pub_test_…)', pattern: /^pub_test_[A-Za-z0-9_]+$/, error: 'Esta versión solo acepta llaves de SANDBOX de Wompi (pub_test_…).' },
            { key: 'privateKey', setting: 'wompi_private_key', label: 'Llave privada (prv_test_…)', pattern: /^prv_test_[A-Za-z0-9_]+$/, error: 'Esta versión solo acepta llaves de SANDBOX de Wompi (prv_test_…).' },
            { key: 'eventsSecret', setting: 'wompi_events_secret', label: 'Secreto de eventos (test_events_…)', pattern: /^test_events_[A-Za-z0-9_]+$/, error: 'El secreto de eventos de sandbox empieza por test_events_.' },
            { key: 'integritySecret', setting: 'wompi_integrity_secret', label: 'Secreto de integridad (test_integrity_…)', pattern: /^test_integrity_[A-Za-z0-9_]+$/, error: 'El secreto de integridad de sandbox empieza por test_integrity_.' },
        ],
        webhookPath: '/wompi/webhook',
        mode: async () => ((await ready()) ? 'test' : ''),
        isReady: ready,
        currencies: ['cop'],
        // A Wompi membership is managed here while it holds a paid period, with or without a source.
        manages: (member) => !!(member && member.source === 'wompi'),
        // Paying again while a period is running prepays the next period.
        allowsRepurchase: true,

        async startCheckout({ userId, email, tier, backUrl }) {
            const k = await keys();
            const reference = await newReference('period', userId, tier.id);
            const back = new URL(backUrl.toString());
            back.searchParams.set('ms_provider', 'wompi');
            await db.run(`INSERT INTO ${T.checkouts} (user_id, tier_id, provider, kind, reference, amount_cents, currency) VALUES (?, ?, 'wompi', 'period', ?, ?, 'cop')`,
                [userId, tier.id, reference, tier.price_cents]);
            const params = new URLSearchParams();
            params.set('public-key', k.pub);
            params.set('currency', 'COP');
            params.set('amount-in-cents', String(tier.price_cents));
            params.set('reference', reference);
            params.set('signature:integrity', await integrityOf(reference, tier.price_cents, 'COP'));
            params.set('redirect-url', back.toString());
            if (email) params.set('customer-data:email', email);
            return { url: `${CHECKOUT_URL}?${params.toString()}` };
        },

        async confirmReturn({ userId, query }) {
            const id = String((query && query.id) || '').trim();
            if (!id) return { handled: false };
            if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw providerError(400, 'Transacción inválida.');
            const txn = await request('GET', `/transactions/${encodeURIComponent(id)}`, null);
            const r = await applyTransaction(txn, userId);
            if (!r.ok && r.reason === 'belongs to another account') throw providerError(404, 'Esa transacción no es de tu cuenta.');
            return { handled: true, applied: r.ok, status: txn && txn.status };
        },

        async changeTier(member, tier) {
            // Applies from the next paid period (renewal or payment).
            await upsertProviderMember(member.user_id, 'wompi', { pending_tier_id: tier.id });
            return { effective: 'next-period' };
        },

        async setCancelAtPeriodEnd(member, flag) {
            await upsertProviderMember(member.user_id, 'wompi', { cancel_at_period_end: !!flag });
        },

        async cancelNow(member) {
            await upsertProviderMember(member.user_id, 'wompi', { payment_source: null });
        },

        async webhook(req) {
            let event = req.body;
            if ((!event || typeof event !== 'object') && typeof req.rawBody === 'string') {
                try { event = JSON.parse(req.rawBody); } catch (e) { event = null; }
            }
            if (!event || typeof event !== 'object') return { status: 400, body: { error: 'invalid payload' } };
            const header = req.headers && req.headers['x-event-checksum'];
            const required = event.event === 'transaction.updated' ? REQUIRED_TXN_PROPS : event.event === 'nequi_token.updated' ? REQUIRED_NEQUI_PROPS : [];
            if (!(await verifyEvent(event, header, required))) return { status: 400, body: { error: 'invalid signature' } };
            if (event.environment !== 'test') return { status: 400, body: { error: 'only sandbox events are accepted by this version' } };
            const data = event.data || {};
            if (event.event === 'transaction.updated' && data.transaction) {
                const id = String(data.transaction.id || '');
                if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) return { status: 400, body: { error: 'invalid transaction' } };
                // The transaction as Wompi has it now — reference, amount, currency and status are not all
                // signed in the event, so none of them is taken from it.
                const txn = await request('GET', `/transactions/${encodeURIComponent(id)}`, null);
                const key = `wompi:${txn && txn.id}:${txn && txn.status}`;
                if (await seenEvent(key)) return { status: 200, body: { received: true, duplicate: true } };
                await applyTransaction(txn, undefined);
                await recordEvent(key, event.event);
            } else if (event.event === 'nequi_token.updated' && data.nequi_token) {
                const tokId = String(data.nequi_token.id || '');
                if (!/^[0-9A-Za-z_-]{1,100}$/.test(tokId)) return { status: 400, body: { error: 'invalid token' } };
                const tok = (await request('GET', `/tokens/nequi/${encodeURIComponent(tokId)}`, null, 'public')) || {};
                const key = `wompi:nequi:${tok.id}:${tok.status}`;
                if (await seenEvent(key)) return { status: 200, body: { received: true, duplicate: true } };
                const m = await db.get(`SELECT * FROM ${T.members} WHERE source = 'wompi' AND provider_payment_source = ?`, [`nequi:${tok.id}`]);
                if (m && tok.status === 'APPROVED') {
                    const user = await wordjs.users.findById(m.user_id).catch(() => null);
                    await attachNequiSource(m, tok.id, user && user.userEmail);
                } else if (m && tok.status === 'DECLINED') {
                    await upsertProviderMember(m.user_id, 'wompi', { payment_source: null });
                }
                await recordEvent(key, event.event);
            }
            return { status: 200, body: { received: true } };
        },

        renewDue,

        /** The member's automatic-renewal state and the actions on it (account block). */
        async autoRenewStatus(member) {
            const src = member && member.provider_payment_source ? String(member.provider_payment_source) : '';
            if (src.startsWith('nequi:')) {
                // Asked on every account-block load while the member has not approved yet: the answer is
                // reused for a few seconds instead of calling Wompi on each one.
                const cached = nequiStatusCache.get(src);
                if (cached && Date.now() - cached.at < AUTO_RENEW_STATUS_TTL_MS) return cached.value;
                if (nequiStatusCache.size > 1000) nequiStatusCache.clear();
                const value = await nequiTokenStatus(member, src);
                nequiStatusCache.set(src, { at: Date.now(), value });
                return value;
            }
            if (src.startsWith('source:')) return { method: 'nequi', state: member.cancel_at_period_end ? 'paused' : 'active' };
            return { method: null, state: 'off' };
        },

        /** Start automatic renewal with Nequi: the member approves the request in the Nequi app. */
        async startNequi(member, phone) {
            if (!/^3\d{9}$/.test(String(phone || ''))) throw providerError(400, 'Escribe tu celular Nequi (10 dígitos, empieza por 3).');
            const tok = await request('POST', '/tokens/nequi', { phone_number: String(phone) }, 'public');
            if (!tok || !tok.id) throw providerError(502, 'Wompi no devolvió el token de Nequi.');
            await upsertProviderMember(member.user_id, 'wompi', { payment_source: `nequi:${tok.id}` });
            return { state: 'pending' };
        },

        async stopAutoRenew(member) {
            await upsertProviderMember(member.user_id, 'wompi', { payment_source: null });
        },
    };
}

module.exports = { createWompiProvider, wompiKeyKind: keyKind, addPeriod };
