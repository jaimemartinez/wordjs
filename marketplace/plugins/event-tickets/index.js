/**
 * WordJS Plugin: Event Tickets — ISOLATED, sandboxed.
 *
 * Ticket types for events with quantity caps. Public purchase generates unique ticket CODES
 * (free orders: instantly; paid orders: after an admin confirms the manual payment), emails them,
 * and offers an attendee list with check-in by code.
 *
 * Standalone: an "event" here is just title + datetime + venue grouping the ticket types — it does
 * NOT depend on any calendar plugin.
 *
 * Money: ALL amounts are stored as INTEGER CENTS. The client renders (cents / 100) with the
 * configured currency symbol. The server NEVER trusts client-sent prices — checkout receives
 * ticket-type ids + quantities only, and totals are recomputed from the DB.
 *
 * Race safety: the db bridge has no transactions, so capacity is claimed with a SINGLE-STATEMENT
 * conditional UPDATE (sold = sold + qty WHERE sold + qty <= capacity); a failed claim rolls back
 * the claims made earlier in the same order. The per-email free-seat quota is claimed the same way,
 * on a counter row per (event, email). Route handlers run concurrently in the isolate, so no limit
 * may be "check now, count after the INSERT": every in-memory window is claimed in one synchronous
 * step and refunded if the order is not created.
 *
 * Abuse limits: per EMAIL, a durable quota of free seats per event; per CLIENT (req.clientKey, an
 * HMAC of the caller's IP), only rolling in-memory windows. A clientKey is not a person: behind a
 * shared NAT or a proxy that is not in trustProxy, many visitors share one key, so a durable
 * per-client cap would become a permanent cap for all of them. One client takes at most
 * MAX_FREE_SEATS_PER_CLIENT_WINDOW free seats per event per window, whatever mailboxes it uses.
 *
 * Randomness: tokens/codes come from the host CSPRNG (wordjs.crypto.randomToken), NOT Math.random —
 * order tokens are 32 chars and check-in codes are backed by rate-limited, admin-only verification;
 * a CSPRNG (not a reconstructable PRNG) is what makes one buyer's token non-derivable from others'.
 */

exports.metadata = {
    name: 'Event Tickets',
    version: '1.0.1',
    description: 'Ticket types with capacity caps, unique ticket codes by email, attendee list and check-in.',
    author: 'WordJS',
};

const OPT_CONFIG = 'event_tickets_config';

const MAX_QTY_PER_TYPE = 10;    // per spec: qty 1..10 per ticket type
const MAX_TICKETS_PER_ORDER = 20;
const MIN_FORM_ELAPSED_MS = 2500; // anti-bot: a human takes longer than this to fill the form
const ORDER_WINDOW_MS = 10 * 60 * 1000;
const ORDER_MAX_PER_EMAIL = 5;  // orders per email per window
const ORDER_MAX_PER_CLIENT = 5; // orders per client (host clientKey = HMAC of the IP) per window
const ORDER_MAX_GLOBAL = 60;    // orders overall per window (counts created orders only)
// Free tickets cost nothing to claim, so the per-email window alone let one visitor rotate
// addresses and take the whole capacity. Free seats are capped per order, per email per event
// (durable quota), and per client per event per ORDER_WINDOW_MS (rolling window, see the header).
const MAX_FREE_TICKETS_PER_ORDER = 4;
const MAX_FREE_SEATS_PER_EMAIL = 4;
const MAX_FREE_SEATS_PER_CLIENT_WINDOW = 4;
const RATE_MAX_KEYS = 10000;    // bound on the in-memory window map

const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
// Readable code alphabet: no O/0/I/1 confusables — these get read out loud at the door.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail } = wordjs;

    console.log('[event-tickets] initializing…');

    // Per-plugin table namespace enforced by the host: 'event-tickets' -> 'wjp_event_tickets_'.
    const P = db.tablePrefix;
    const T = {
        events: `${P}events`,
        types: `${P}ticket_types`,
        orders: `${P}orders`,
        tickets: `${P}tickets`,
        freeSeats: `${P}free_seats`,
    };

    // ── schema (idempotent; full column set on CREATE, later columns via ALTER ADD COLUMN) ────────
    async function initSchema() {
        await db.createTable(T.events, [
            'id INT_PK',
            'title TEXT NOT NULL',
            'starts_at TEXT NOT NULL',
            'venue TEXT',
            'description TEXT',
            'is_published INT DEFAULT 1',
            'created_at TEXT',
        ]);
        await db.createTable(T.types, [
            'id INT_PK',
            'event_id INT NOT NULL',
            'name TEXT NOT NULL',
            'price_cents INT DEFAULT 0',
            'capacity INT NOT NULL DEFAULT 100',
            'sold INT DEFAULT 0',
            "sales_end TEXT DEFAULT ''",
            'is_active INT DEFAULT 1',
        ]);
        await db.createTable(T.orders, [
            'id INT_PK',
            'token TEXT',
            'event_id INT',
            'buyer_name TEXT NOT NULL',
            'buyer_email TEXT NOT NULL',
            'items TEXT',
            'total_cents INT',
            "payment_status TEXT DEFAULT 'pending'",
            'created_at TEXT',
        ]);
        // Free seats claimed per (event, buyer email): one counter row each, so the quota is a
        // single conditional UPDATE (seats + n <= cap) — atomic on every engine, unlike a
        // count-then-insert. VARCHAR so the unique index below is valid on MySQL.
        await db.createTable(T.freeSeats, [
            'id INT_PK',
            'event_id INT NOT NULL',
            'buyer_email VARCHAR(200) NOT NULL',
            'seats INT NOT NULL DEFAULT 0',
        ]);
        try {
            await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_free_seats_buyer ON ${T.freeSeats} (event_id, buyer_email)`);
        } catch (e) { console.error('[event-tickets] could not create the free-seat index:', e.message); }
        await db.createTable(T.tickets, [
            'id INT_PK',
            'order_id INT NOT NULL',
            'event_id INT',
            'ticket_type_id INT',
            'code TEXT NOT NULL',
            'attendee_name TEXT',
            'checked_in_at TEXT',
            'created_at TEXT',
        ]);

        // Indexes for the hot lookups; names AND targets must carry the plugin prefix.
        const createIndex = async (name, table, cols) => {
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) { /* already exists / unsupported — fine */ }
        };
        await createIndex(`${P}idx_types_event`, T.types, 'event_id');
        await createIndex(`${P}idx_orders_token`, T.orders, 'token');
        await createIndex(`${P}idx_orders_event`, T.orders, 'event_id');
        await createIndex(`${P}idx_tickets_order`, T.tickets, 'order_id');
        await createIndex(`${P}idx_tickets_event`, T.tickets, 'event_id');
        await createIndex(`${P}idx_tickets_code`, T.tickets, 'code');
    }
    await initSchema();

    // ── shared helpers ────────────────────────────────────────────────────────────────────────────
    const nowIso = () => new Date().toISOString();

    // CSPRNG via the host bridge (audit HIGH: Math.random is xorshift128+, its state reconstructable from
    // a few observed order tokens → every OTHER buyer's token/ticket-code derivable). Async (RPC).
    async function genToken(len) {
        return (await wordjs.crypto.randomToken(Math.ceil(len / 2))).slice(0, len);
    }
    async function genCode() {
        return (await wordjs.crypto.randomToken(6)).slice(0, 10).toUpperCase();
    }
    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    /** Unique-ish ticket code: retry on the (astronomically unlikely) collision. */
    async function genUniqueCode() {
        for (let attempt = 0; attempt < 8; attempt++) {
            const code = await genCode();
            const clash = await db.get(`SELECT id FROM ${T.tickets} WHERE code = ?`, [code]);
            if (!clash) return code;
        }
        throw new Error('No se pudo generar un código único, intenta de nuevo.');
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    async function getConfig() {
        const cfg = (await options.get(OPT_CONFIG, null)) || {};
        return {
            currencySymbol: (typeof cfg.currencySymbol === 'string' && cfg.currencySymbol) ? cfg.currencySymbol : '$',
            manualInstructions: String(cfg.manualInstructions || ''),
            notifyEmail: String(cfg.notifyEmail || ''),
        };
    }

    const fmtMoney = (cents, symbol) => {
        const n = Number(cents) || 0;
        return symbol + (n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2));
    };

    /** Mail wrapper: features degrade instead of failing the whole request. */
    async function tryMail(msg) {
        try {
            await mail(msg);
            return true;
        } catch (e) {
            console.warn('[event-tickets] correo no enviado:', e && e.message ? e.message : e);
            return false;
        }
    }

    /** Accept '' (empty = open until the event) or a parseable date; throw otherwise. */
    function normSalesEnd(v) {
        if (v === undefined || v === null || v === '') return '';
        const s = String(v);
        if (isNaN(new Date(s).getTime())) throw new Error('Fecha de fin de venta inválida.');
        return s;
    }

    const salesOpen = (type) => {
        if (!type.sales_end) return true;
        const t = new Date(type.sales_end).getTime();
        return isNaN(t) ? true : t > Date.now();
    };

    function parseItems(json) {
        try {
            const arr = JSON.parse(json || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    // Lazy expiry: release seats held by UNPAID pending orders older than the TTL, so an attacker rotating
    // buyer_email to place pending orders they never pay can't hold a small venue's inventory hostage
    // indefinitely (audit LOW). Runs opportunistically at order time. Seats are released only by the
    // request whose conditional pending -> expired flip wins: the admin's pending -> paid confirm and a
    // cancellation flip the same row, so whichever lands first owns the seats. Releasing before the flip
    // let two overlapping sweeps release one order twice, and released the seats of an order the admin
    // had just confirmed: in both cases more tickets than the capacity could then be sold.
    const PENDING_TTL_MS = 30 * 60 * 1000;
    async function releaseStalePending(eventId) {
        const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
        const stale = await db.all(`SELECT id, items FROM ${T.orders} WHERE event_id = ? AND payment_status = 'pending' AND created_at < ?`, [eventId, cutoff]);
        for (const o of stale) {
            const flip = await db.run(`UPDATE ${T.orders} SET payment_status = 'expired' WHERE id = ? AND payment_status = 'pending'`, [o.id]);
            if (!flip || flip.changes !== 1) continue; // paid, cancelled or expired meanwhile: not ours to release
            for (const it of parseItems(o.items)) {
                await db.run(`UPDATE ${T.types} SET sold = sold - ? WHERE id = ? AND sold >= ?`, [it.qty, it.ticket_type_id, it.qty]);
            }
        }
    }

    /** Generate one ticket per seat of an order. Returns [{code, type_name}]. */
    async function generateTickets(order, items) {
        const out = [];
        for (const it of items) {
            for (let i = 0; i < it.qty; i++) {
                const code = await genUniqueCode();
                await db.run(
                    `INSERT INTO ${T.tickets} (order_id, event_id, ticket_type_id, code, attendee_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                    [order.id, order.event_id, it.ticket_type_id, code, order.buyer_name, nowIso()]
                );
                out.push({ code, type_name: it.name });
            }
        }
        return out;
    }

    function ticketsEmailHtml(eventRow, tickets, buyerName) {
        const rows = tickets.map((t) =>
            `<tr><td style="padding:8px 14px;border:1px solid #e5e7eb;font-family:monospace;font-size:18px;letter-spacing:2px;"><strong>${t.code}</strong></td>` +
            `<td style="padding:8px 14px;border:1px solid #e5e7eb;">${escapeHtml(t.type_name)}</td></tr>`
        ).join('');
        const when = eventRow && eventRow.starts_at ? new Date(eventRow.starts_at).toLocaleString('es') : '';
        return `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
                <h2 style="color:#111827;">Tus entradas — ${escapeHtml(eventRow ? eventRow.title : '')}</h2>
                <p>Hola ${escapeHtml(buyerName)}, aquí están tus códigos de entrada:</p>
                <table style="border-collapse:collapse;width:100%;">${rows}</table>
                <p style="color:#6b7280;font-size:13px;">
                    ${when ? `Fecha: ${when}.` : ''} ${eventRow && eventRow.venue ? `Lugar: ${escapeHtml(eventRow.venue)}.` : ''}<br/>
                    Presenta el código en la entrada para el registro.
                </p>
            </div>`;
    }

    // ── anti-spam / rate limiting (in-memory rolling windows; one isolate process) ────────────────
    // Keys: 'g' (site-wide orders), 'e:<email>' and 'c:<clientKey>' (orders), 'f:<clientKey>:<event>'
    // (free seats). A window is CLAIMED — checked and counted in the same synchronous step — and
    // refunded when the request ends without an order. The previous check-first, count-after-INSERT
    // shape let a burst of concurrent requests from ONE client all pass the check before any of them
    // was counted: every per-client and per-email cap was bypassed and the site-wide window filled.
    const rateWindows = new Map(); // key -> { count, first }

    function pruneWindows(now) {
        if (rateWindows.size <= RATE_MAX_KEYS) return;
        for (const [k, v] of rateWindows) if (now - v.first >= ORDER_WINDOW_MS) rateWindows.delete(k);
        // Still over the bound with every window live: evict the oldest (Map keeps insertion order),
        // never the site-wide window — key churn must not be a way to reset it.
        let excess = rateWindows.size - RATE_MAX_KEYS;
        for (const k of rateWindows.keys()) {
            if (excess <= 0) break;
            if (k === 'g') continue;
            rateWindows.delete(k);
            excess--;
        }
    }

    /**
     * Claim `amount` units on every [key, max, amount] spec, all or nothing. Returns a release()
     * that refunds the claim (idempotent), or null when any window is already full.
     */
    function claimWindows(specs) {
        const now = Date.now();
        const live = [];
        for (const [key, max, amount] of specs) {
            const r = rateWindows.get(key);
            const cur = r && now - r.first < ORDER_WINDOW_MS ? r : null;
            if ((cur ? cur.count : 0) + amount > max) return null;
            live.push([key, cur, amount]);
        }
        const held = live.map(([key, cur, amount]) => {
            const r = cur || { count: 0, first: now };
            if (!cur) rateWindows.set(key, r);
            r.count += amount;
            return [r, amount];
        });
        pruneWindows(now);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const [r, amount] of held) r.count = Math.max(0, r.count - amount);
        };
    }

    /** Order budget for one request: site-wide, per email and per client windows. */
    function claimOrderWindows(email, clientKey) {
        const specs = [['g', ORDER_MAX_GLOBAL, 1], ['e:' + email, ORDER_MAX_PER_EMAIL, 1]];
        if (clientKey) specs.push(['c:' + clientKey, ORDER_MAX_PER_CLIENT, 1]);
        return claimWindows(specs);
    }

    // ── per-email free-seat quota (durable, one counter row per event + email) ──────────────────
    const seatsOf = (items) => parseItems(items).reduce((n, it) => n + (Number(it && it.qty) || 0), 0);

    /**
     * Claim `n` free seats of `email`'s quota for `eventId`. The row is created on first use, seeded
     * with the free seats the address already holds in orders placed before the counter existed (a
     * concurrent first use loses the unique index and is ignored). The claim itself is ONE conditional
     * UPDATE, so concurrent requests can never take more than the quota between them.
     */
    async function claimFreeSeats(eventId, email, n) {
        const row = await db.get(`SELECT seats FROM ${T.freeSeats} WHERE event_id = ? AND buyer_email = ?`, [eventId, email]);
        if (!row) {
            const prior = await db.all(
                `SELECT items FROM ${T.orders} WHERE event_id = ? AND buyer_email = ? AND total_cents = 0 AND payment_status = 'paid'`,
                [eventId, email]
            );
            const seeded = prior.reduce((s, o) => s + seatsOf(o.items), 0);
            try {
                await db.run(`INSERT INTO ${T.freeSeats} (event_id, buyer_email, seats) VALUES (?, ?, ?)`, [eventId, email, seeded]);
            } catch (e) { /* created concurrently — the UPDATE below decides */ }
        }
        const r = await db.run(
            `UPDATE ${T.freeSeats} SET seats = seats + ? WHERE event_id = ? AND buyer_email = ? AND seats + ? <= ?`,
            [n, eventId, email, n, MAX_FREE_SEATS_PER_EMAIL]
        );
        return !!(r && r.changes > 0);
    }
    async function refundFreeSeats(eventId, email, n) {
        try {
            await db.run(
                `UPDATE ${T.freeSeats} SET seats = seats - ? WHERE event_id = ? AND buyer_email = ? AND seats >= ?`,
                [n, eventId, email, n]
            );
        } catch (e) { /* best effort */ }
    }

    // ═══════════════════════════════ PUBLIC ROUTES ════════════════════════════════════════════════

    /**
     * Published upcoming events, each with its ACTIVE ticket types (remaining seats + whether the
     * sales window is still open). The Puck block consumes this from the editor iframe AND the
     * public page.
     */
    http.route('get', '/public/events', async (req, res) => {
        try {
            const cfg = await getConfig();
            const all = await db.all(`SELECT * FROM ${T.events} WHERE is_published = 1 ORDER BY starts_at ASC`);
            // "Upcoming" with a 6h grace so an event doesn't vanish the second it starts.
            const cutoff = Date.now() - 6 * 60 * 60 * 1000;
            const upcoming = all.filter((e) => {
                const t = new Date(e.starts_at).getTime();
                return isNaN(t) ? true : t >= cutoff;
            });
            const ids = upcoming.map((e) => e.id);
            let typesByEvent = new Map();
            if (ids.length) {
                const marks = ids.map(() => '?').join(',');
                const types = await db.all(
                    `SELECT * FROM ${T.types} WHERE is_active = 1 AND event_id IN (${marks}) ORDER BY id`, ids
                );
                for (const t of types) {
                    if (!typesByEvent.has(t.event_id)) typesByEvent.set(t.event_id, []);
                    typesByEvent.get(t.event_id).push({
                        id: t.id,
                        name: t.name,
                        price_cents: Number(t.price_cents) || 0,
                        remaining: Math.max(0, (Number(t.capacity) || 0) - (Number(t.sold) || 0)),
                        sales_end: t.sales_end || '',
                        sales_open: salesOpen(t),
                    });
                }
            }
            res.json({
                currencySymbol: cfg.currencySymbol,
                events: upcoming.map((e) => ({
                    id: e.id,
                    title: e.title,
                    starts_at: e.starts_at,
                    venue: e.venue || '',
                    description: e.description || '',
                    ticket_types: typesByEvent.get(e.id) || [],
                })),
            });
        } catch (e) {
            res.status(500).json({ error: 'No se pudieron cargar los eventos.' });
        }
    });

    /**
     * Public order. Receives ticket-type ids + quantities ONLY — prices and totals are recomputed
     * from the DB. Capacity is claimed per type with a single conditional UPDATE; earlier claims
     * are rolled back if a later one fails.
     */
    http.route('post', '/public/order', async (req, res) => {
        const body = req.body || {};
        // Claimed limits are refunded in `finally` unless an order row was created.
        let releaseWindows = null;
        let releaseFreeWindow = null;
        let freeClaim = null; // { eventId, email, n } once the durable quota is claimed
        let created = false;
        try {
            // Anti-spam: honeypot must be empty and the form must have taken a human amount of time.
            if (String(body.hp || '').trim() !== '') {
                return res.status(400).json({ error: 'Solicitud inválida.' });
            }
            const elapsed = Number(body.elapsed);
            if (!Number.isFinite(elapsed) || elapsed < MIN_FORM_ELAPSED_MS) {
                return res.status(429).json({ error: 'Formulario enviado demasiado rápido, inténtalo de nuevo.' });
            }

            const buyerName = String(body.buyer_name || '').trim().slice(0, 120);
            const buyerEmail = String(body.buyer_email || '').trim().toLowerCase().slice(0, 200);
            if (!buyerName) return res.status(400).json({ error: 'El nombre es obligatorio.' });
            if (!EMAIL_RE.test(buyerEmail)) return res.status(400).json({ error: 'El correo no es válido.' });

            const clientKey = String(req.clientKey || '').slice(0, 64);
            releaseWindows = claimOrderWindows(buyerEmail, clientKey);
            if (!releaseWindows) {
                return res.status(429).json({ error: 'Demasiados pedidos en poco tiempo. Espera unos minutos e inténtalo de nuevo.' });
            }

            const eventId = Number(body.event_id);
            if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'Evento inválido.' });
            const eventRow = await db.get(`SELECT * FROM ${T.events} WHERE id = ? AND is_published = 1`, [eventId]);
            if (!eventRow) return res.status(404).json({ error: 'Evento no encontrado.' });

            // Validate the requested items (ids + qty only).
            const rawItems = Array.isArray(body.items) ? body.items : [];
            if (!rawItems.length) return res.status(400).json({ error: 'Selecciona al menos una entrada.' });
            if (rawItems.length > 10) return res.status(400).json({ error: 'Demasiados tipos de entrada en un solo pedido.' });

            const seen = new Set();
            let totalSeats = 0;
            const wanted = [];
            for (const it of rawItems) {
                const typeId = Number(it && it.ticket_type_id);
                const qty = Number(it && it.qty);
                if (!Number.isInteger(typeId) || typeId <= 0) return res.status(400).json({ error: 'Tipo de entrada inválido.' });
                if (seen.has(typeId)) return res.status(400).json({ error: 'Tipo de entrada repetido en el pedido.' });
                seen.add(typeId);
                if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_TYPE) {
                    return res.status(400).json({ error: `La cantidad debe estar entre 1 y ${MAX_QTY_PER_TYPE}.` });
                }
                totalSeats += qty;
                wanted.push({ typeId, qty });
            }
            if (totalSeats > MAX_TICKETS_PER_ORDER) {
                return res.status(400).json({ error: `Máximo ${MAX_TICKETS_PER_ORDER} entradas por pedido.` });
            }

            // Re-read every type from the DB: price, activity and sales window come from HERE.
            const items = [];
            for (const w of wanted) {
                const t = await db.get(`SELECT * FROM ${T.types} WHERE id = ? AND event_id = ?`, [w.typeId, eventId]);
                if (!t || !Number(t.is_active)) return res.status(400).json({ error: 'Una de las entradas ya no está disponible.' });
                if (!salesOpen(t)) return res.status(400).json({ error: `La venta de "${t.name}" ya cerró.` });
                items.push({ ticket_type_id: t.id, name: t.name, price_cents: Number(t.price_cents) || 0, qty: w.qty });
            }

            // Free tickets: per-order cap, then the client's rolling window for this event, then the
            // email's durable quota for this event (rotating addresses from one client does not reset
            // the window; rotating clients does not reset the quota).
            const wouldBeFree = items.every((it) => it.price_cents === 0);
            if (wouldBeFree) {
                if (totalSeats > MAX_FREE_TICKETS_PER_ORDER) {
                    return res.status(400).json({ error: `Máximo ${MAX_FREE_TICKETS_PER_ORDER} entradas gratuitas por pedido.` });
                }
                const freeLimited = () => res.status(429).json({ error: `Máximo ${MAX_FREE_SEATS_PER_EMAIL} entradas gratuitas por persona para este evento.` });
                if (clientKey) {
                    releaseFreeWindow = claimWindows([['f:' + clientKey + ':' + eventId, MAX_FREE_SEATS_PER_CLIENT_WINDOW, totalSeats]]);
                    if (!releaseFreeWindow) return freeLimited();
                }
                if (!(await claimFreeSeats(eventId, buyerEmail, totalSeats))) return freeLimited();
                freeClaim = { eventId, email: buyerEmail, n: totalSeats };
            }

            // Free up seats held by long-unpaid pending orders before claiming (bounds inventory DoS).
            try { await releaseStalePending(eventId); } catch (e) { /* best effort */ }

            // Claim capacity per type — single-statement, race-safe. Roll back earlier claims on failure.
            const claimed = [];
            const rollback = async () => {
                for (const c of claimed) {
                    try {
                        await db.run(`UPDATE ${T.types} SET sold = sold - ? WHERE id = ?`, [c.qty, c.ticket_type_id]);
                    } catch (e) { /* best effort */ }
                }
            };
            for (const it of items) {
                const r = await db.run(
                    `UPDATE ${T.types} SET sold = sold + ? WHERE id = ? AND is_active = 1 AND sold + ? <= capacity`,
                    [it.qty, it.ticket_type_id, it.qty]
                );
                if (!r || r.changes !== 1) {
                    await rollback();
                    return res.status(409).json({ error: `Entradas agotadas para ${it.name}.` });
                }
                claimed.push(it);
            }

            const cfg = await getConfig();
            const totalCents = items.reduce((sum, it) => sum + it.price_cents * it.qty, 0);
            const token = await genToken(32);
            const isFree = totalCents === 0;

            let orderId;
            try {
                const result = await db.run(
                    `INSERT INTO ${T.orders} (token, event_id, buyer_name, buyer_email, items, total_cents, payment_status, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [token, eventId, buyerName, buyerEmail, JSON.stringify(items), totalCents, isFree ? 'paid' : 'pending', nowIso()]
                );
                orderId = result.lastID;
            } catch (e) {
                await rollback();
                return res.status(500).json({ error: 'No se pudo crear el pedido, inténtalo de nuevo.' });
            }
            // The order exists: every claimed window and the free-seat quota stay spent.
            created = true;

            // Notify the site owner (best effort).
            if (cfg.notifyEmail && EMAIL_RE.test(cfg.notifyEmail)) {
                tryMail({
                    to: cfg.notifyEmail,
                    subject: `Nuevo pedido de entradas — ${eventRow.title}`,
                    text: `Pedido de ${buyerName} <${buyerEmail}> por ${totalSeats} entrada(s), total ${fmtMoney(totalCents, cfg.currencySymbol)}. Estado: ${isFree ? 'pagado (gratis)' : 'pendiente de pago'}.`,
                });
            }

            if (isFree) {
                // Free order → tickets NOW.
                let tickets;
                try {
                    tickets = await generateTickets({ id: orderId, event_id: eventId, buyer_name: buyerName }, items);
                } catch (e) {
                    return res.status(500).json({ error: 'El pedido se creó pero falló la generación de códigos. Contacta al organizador.', token });
                }
                const emailSent = await tryMail({
                    to: buyerEmail,
                    subject: `Tus entradas — ${eventRow.title}`,
                    html: ticketsEmailHtml(eventRow, tickets, buyerName),
                    text: `Tus códigos de entrada para ${eventRow.title}: ${tickets.map((t) => t.code).join(', ')}`,
                });
                return res.json({ success: true, status: 'paid', token, total_cents: 0, tickets, emailSent });
            }

            // Paid order → pending until the admin confirms the manual payment.
            const emailSent = await tryMail({
                to: buyerEmail,
                subject: `Pedido recibido — ${eventRow.title}`,
                html: `
                    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
                        <h2 style="color:#111827;">Pedido recibido</h2>
                        <p>Hola ${escapeHtml(buyerName)}, recibimos tu pedido de ${totalSeats} entrada(s) para <strong>${escapeHtml(eventRow.title)}</strong>
                        por un total de <strong>${fmtMoney(totalCents, cfg.currencySymbol)}</strong>.</p>
                        ${cfg.manualInstructions ? `<p style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;">${cfg.manualInstructions}</p>` : ''}
                        <p>Cuando confirmemos tu pago te enviaremos los códigos de entrada a este correo.</p>
                        <p style="color:#6b7280;font-size:13px;">Referencia de tu pedido: <strong>${token}</strong></p>
                    </div>`,
                text: `Recibimos tu pedido para ${eventRow.title} por ${fmtMoney(totalCents, cfg.currencySymbol)}. ${cfg.manualInstructions || ''} Referencia: ${token}`,
            });

            res.json({
                success: true,
                status: 'pending',
                token,
                total_cents: totalCents,
                manualInstructions: cfg.manualInstructions,
                emailSent,
            });
        } catch (e) {
            res.status(500).json({ error: 'Error al procesar el pedido.' });
        } finally {
            if (!created) {
                if (releaseWindows) releaseWindows();
                if (releaseFreeWindow) releaseFreeWindow();
                if (freeClaim) await refundFreeSeats(freeClaim.eventId, freeClaim.email, freeClaim.n);
            }
        }
    });

    /** Public order lookup by random token (never by sequential id). */
    http.route('get', '/public/order', async (req, res) => {
        try {
            const token = String((req.query && req.query.token) || '').trim().toLowerCase();
            if (!token || token.length !== 32) return res.status(400).json({ error: 'Referencia inválida.' });
            const order = await db.get(
                `SELECT o.*, e.title AS event_title, e.starts_at AS event_starts_at, e.venue AS event_venue
                 FROM ${T.orders} o LEFT JOIN ${T.events} e ON o.event_id = e.id
                 WHERE o.token = ?`, [token]
            );
            if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
            const cfg = await getConfig();
            const payload = {
                status: order.payment_status,
                buyer_name: order.buyer_name,
                total_cents: Number(order.total_cents) || 0,
                items: parseItems(order.items),
                event_title: order.event_title || '',
                event_starts_at: order.event_starts_at || '',
                event_venue: order.event_venue || '',
                currencySymbol: cfg.currencySymbol,
            };
            if (order.payment_status === 'paid') {
                const tks = await db.all(
                    `SELECT t.code, tt.name AS type_name FROM ${T.tickets} t
                     LEFT JOIN ${T.types} tt ON t.ticket_type_id = tt.id
                     WHERE t.order_id = ? ORDER BY t.id`, [order.id]
                );
                payload.tickets = tks;
            } else if (order.payment_status === 'pending') {
                payload.manualInstructions = cfg.manualInstructions;
            }
            res.json(payload);
        } catch (e) {
            res.status(500).json({ error: 'Error al consultar el pedido.' });
        }
    });

    // ═══════════════════════════════ ADMIN: EVENTS CRUD ═══════════════════════════════════════════

    http.route('get', '/events', { auth: true, admin: true }, async (req, res) => {
        try {
            const events = await db.all(`SELECT * FROM ${T.events} ORDER BY starts_at DESC`);
            const types = await db.all(`SELECT * FROM ${T.types} ORDER BY id`);
            const byEvent = new Map();
            for (const t of types) {
                if (!byEvent.has(t.event_id)) byEvent.set(t.event_id, []);
                byEvent.get(t.event_id).push(t);
            }
            res.json({ events: events.map((e) => ({ ...e, types: byEvent.get(e.id) || [] })) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/events', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        try {
            const title = String(body.title || '').trim();
            if (!title) return res.status(400).json({ error: 'El título es obligatorio.' });
            const startsAt = String(body.starts_at || '').trim();
            if (!startsAt || isNaN(new Date(startsAt).getTime())) return res.status(400).json({ error: 'La fecha del evento es obligatoria y debe ser válida.' });
            const result = await db.run(
                `INSERT INTO ${T.events} (title, starts_at, venue, description, is_published, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [title, startsAt, String(body.venue || '').trim(), String(body.description || '').trim(), body.is_published === 0 || body.is_published === false ? 0 : 1, nowIso()]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/events/:id', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        try {
            const row = await db.get(`SELECT * FROM ${T.events} WHERE id = ?`, [req.params.id]);
            if (!row) return res.status(404).json({ error: 'Evento no encontrado.' });
            const sets = [], params = [];
            if (body.title !== undefined) {
                const v = String(body.title).trim();
                if (!v) return res.status(400).json({ error: 'El título es obligatorio.' });
                sets.push('title = ?'); params.push(v);
            }
            if (body.starts_at !== undefined) {
                const v = String(body.starts_at).trim();
                if (!v || isNaN(new Date(v).getTime())) return res.status(400).json({ error: 'Fecha inválida.' });
                sets.push('starts_at = ?'); params.push(v);
            }
            if (body.venue !== undefined) { sets.push('venue = ?'); params.push(String(body.venue).trim()); }
            if (body.description !== undefined) { sets.push('description = ?'); params.push(String(body.description).trim()); }
            if (body.is_published !== undefined) { sets.push('is_published = ?'); params.push(body.is_published ? 1 : 0); }
            if (!sets.length) return res.json({ success: true });
            params.push(req.params.id);
            await db.run(`UPDATE ${T.events} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Full cascade: the admin UI asks for confirmation before calling this.
    http.route('delete', '/events/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = req.params.id;
            await db.run(`DELETE FROM ${T.tickets} WHERE event_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.orders} WHERE event_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.freeSeats} WHERE event_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.types} WHERE event_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.events} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════ ADMIN: TICKET TYPES CRUD ═════════════════════════════════════

    http.route('post', '/events/:id/types', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        try {
            const eventRow = await db.get(`SELECT id FROM ${T.events} WHERE id = ?`, [req.params.id]);
            if (!eventRow) return res.status(404).json({ error: 'Evento no encontrado.' });
            const name = String(body.name || '').trim();
            if (!name) return res.status(400).json({ error: 'El nombre del tipo es obligatorio.' });
            const priceCents = Number(body.price_cents);
            if (!Number.isInteger(priceCents) || priceCents < 0) return res.status(400).json({ error: 'Precio inválido.' });
            const capacity = Number(body.capacity);
            if (!Number.isInteger(capacity) || capacity < 1) return res.status(400).json({ error: 'La capacidad debe ser al menos 1.' });
            const salesEnd = normSalesEnd(body.sales_end);
            const result = await db.run(
                `INSERT INTO ${T.types} (event_id, name, price_cents, capacity, sold, sales_end, is_active) VALUES (?, ?, ?, ?, 0, ?, ?)`,
                [eventRow.id, name, priceCents, capacity, salesEnd, body.is_active === 0 || body.is_active === false ? 0 : 1]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    http.route('put', '/types/:id', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        try {
            const row = await db.get(`SELECT * FROM ${T.types} WHERE id = ?`, [req.params.id]);
            if (!row) return res.status(404).json({ error: 'Tipo de entrada no encontrado.' });
            const sets = [], params = [];
            if (body.name !== undefined) {
                const v = String(body.name).trim();
                if (!v) return res.status(400).json({ error: 'El nombre es obligatorio.' });
                sets.push('name = ?'); params.push(v);
            }
            if (body.price_cents !== undefined) {
                const v = Number(body.price_cents);
                if (!Number.isInteger(v) || v < 0) return res.status(400).json({ error: 'Precio inválido.' });
                sets.push('price_cents = ?'); params.push(v);
            }
            let capacity = null;
            if (body.capacity !== undefined) {
                const v = Number(body.capacity);
                if (!Number.isInteger(v) || v < 1) return res.status(400).json({ error: 'La capacidad debe ser al menos 1.' });
                const sold = Number(row.sold) || 0;
                if (v < sold) return res.status(400).json({ error: `La capacidad no puede ser menor que las entradas ya vendidas (${sold}).` });
                sets.push('capacity = ?'); params.push(v);
                capacity = v;
            }
            if (body.sales_end !== undefined) { sets.push('sales_end = ?'); params.push(normSalesEnd(body.sales_end)); }
            if (body.is_active !== undefined) { sets.push('is_active = ?'); params.push(body.is_active ? 1 : 0); }
            if (!sets.length) return res.json({ success: true });
            params.push(req.params.id);
            // A new capacity lands only while it still covers the seats sold: an order claims seats with
            // `sold + n <= capacity`, so one landing between the check above and this write would
            // otherwise leave more seats sold than the capacity just set.
            let where = 'id = ?';
            if (capacity !== null) { where += ' AND COALESCE(sold, 0) <= ?'; params.push(capacity); }
            const result = await db.run(`UPDATE ${T.types} SET ${sets.join(', ')} WHERE ${where}`, params);
            if (!result || result.changes !== 1) {
                const now = await db.get(`SELECT sold FROM ${T.types} WHERE id = ?`, [req.params.id]);
                if (!now) return res.status(404).json({ error: 'Tipo de entrada no encontrado.' });
                return res.status(400).json({ error: `La capacidad no puede ser menor que las entradas ya vendidas (${Number(now.sold) || 0}).` });
            }
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    http.route('delete', '/types/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const row = await db.get(`SELECT * FROM ${T.types} WHERE id = ?`, [req.params.id]);
            if (!row) return res.status(404).json({ error: 'Tipo de entrada no encontrado.' });
            if ((Number(row.sold) || 0) > 0) {
                return res.status(409).json({ error: 'No se puede eliminar un tipo con entradas vendidas — desactívalo en su lugar.' });
            }
            await db.run(`DELETE FROM ${T.types} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════ ADMIN: ORDERS ════════════════════════════════════════════════

    http.route('get', '/orders', { auth: true, admin: true }, async (req, res) => {
        try {
            const q = req.query || {};
            let sql = `SELECT o.*, e.title AS event_title FROM ${T.orders} o LEFT JOIN ${T.events} e ON o.event_id = e.id WHERE 1=1`;
            const params = [];
            if (q.event_id) { sql += ' AND o.event_id = ?'; params.push(Number(q.event_id)); }
            if (q.status) { sql += ' AND o.payment_status = ?'; params.push(String(q.status)); }
            sql += ' ORDER BY o.id DESC LIMIT 500';
            const rows = await db.all(sql, params);
            const pending = await db.get(`SELECT COUNT(*) AS c FROM ${T.orders} WHERE payment_status = 'pending'`);
            res.json({
                orders: rows.map((o) => ({ ...o, items: parseItems(o.items) })),
                pendingTotal: pending ? Number(pending.c) || 0 : 0,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Confirm a manual payment. The 'pending' → 'paid' transition is claimed with a conditional
     * UPDATE so two concurrent confirms can't double-generate codes (idempotent).
     */
    http.route('post', '/orders/:id/paid', { auth: true, admin: true }, async (req, res) => {
        try {
            const order = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [req.params.id]);
            if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
            if (order.payment_status === 'cancelled') return res.status(409).json({ error: 'El pedido está cancelado.' });

            const claim = await db.run(
                `UPDATE ${T.orders} SET payment_status = 'paid' WHERE id = ? AND payment_status = 'pending'`,
                [order.id]
            );
            if (!claim || claim.changes !== 1) {
                // The order left 'pending' before this flip: say what it is now. Only a paid one has
                // tickets; one that expired (its seats released) or was cancelled meanwhile was
                // answered "already paid" with no tickets, so the buyer never got any.
                const now = await db.get(`SELECT payment_status FROM ${T.orders} WHERE id = ?`, [order.id]);
                if (!now) return res.status(404).json({ error: 'Pedido no encontrado.' });
                if (now.payment_status === 'cancelled') return res.status(409).json({ error: 'El pedido está cancelado.' });
                if (now.payment_status !== 'paid') {
                    return res.status(409).json({ error: 'El pedido caducó sin pagarse y sus entradas se liberaron. Pide al comprador que haga un pedido nuevo.' });
                }
                // Already paid — return the existing tickets instead of duplicating them.
                const existing = await db.all(
                    `SELECT t.code, tt.name AS type_name FROM ${T.tickets} t
                     LEFT JOIN ${T.types} tt ON t.ticket_type_id = tt.id WHERE t.order_id = ? ORDER BY t.id`, [order.id]
                );
                return res.json({ already: true, tickets: existing });
            }

            const items = parseItems(order.items);
            const tickets = await generateTickets(order, items);
            const eventRow = await db.get(`SELECT * FROM ${T.events} WHERE id = ?`, [order.event_id]);
            const emailSent = await tryMail({
                to: order.buyer_email,
                subject: `Tus entradas — ${eventRow ? eventRow.title : 'evento'}`,
                html: ticketsEmailHtml(eventRow, tickets, order.buyer_name),
                text: `Pago confirmado. Tus códigos de entrada: ${tickets.map((t) => t.code).join(', ')}`,
            });
            res.json({ success: true, tickets, emailSent });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Cancel an order: restore the capacity it holds and void any generated tickets. Only a pending or
     * paid order holds seats — an expired one gave them back when it expired — and the flip to
     * 'cancelled' is conditional on the status read, so the seats are released by exactly the state
     * that held them. The flip used to accept any status but 'cancelled': cancelling an expired order
     * (the admin list shows it with a "Cancelar" button), or a pending one the sweep expired between
     * the read and the flip, released its seats a second time and the type could then sell more
     * tickets than its capacity.
     */
    http.route('post', '/orders/:id/cancel', { auth: true, admin: true }, async (req, res) => {
        try {
            for (let attempt = 1; attempt <= 3; attempt++) {
                const order = await db.get(`SELECT * FROM ${T.orders} WHERE id = ?`, [req.params.id]);
                if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
                if (order.payment_status === 'cancelled') return res.status(409).json({ error: 'El pedido ya está cancelado.' });
                const holdsSeats = order.payment_status === 'pending' || order.payment_status === 'paid';
                const claim = order.payment_status == null
                    ? await db.run(`UPDATE ${T.orders} SET payment_status = 'cancelled' WHERE id = ? AND payment_status IS NULL`, [order.id])
                    : await db.run(`UPDATE ${T.orders} SET payment_status = 'cancelled' WHERE id = ? AND payment_status = ?`, [order.id, order.payment_status]);
                if (!claim || claim.changes !== 1) continue; // paid, expired or cancelled meanwhile: decide again
                if (holdsSeats) {
                    for (const it of parseItems(order.items)) {
                        const qty = Number(it.qty) || 0;
                        if (qty > 0 && it.ticket_type_id) {
                            await db.run(`UPDATE ${T.types} SET sold = sold - ? WHERE id = ?`, [qty, it.ticket_type_id]);
                        }
                    }
                }
                // A cancelled free order gives its seats back to the buyer's free-seat quota.
                if (Number(order.total_cents) === 0 && order.payment_status === 'paid') {
                    await refundFreeSeats(order.event_id, order.buyer_email, seatsOf(order.items));
                }
                await db.run(`DELETE FROM ${T.tickets} WHERE order_id = ?`, [order.id]);
                return res.json({ success: true });
            }
            res.status(409).json({ error: 'El pedido cambió mientras se cancelaba. Inténtalo de nuevo.' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════ ADMIN: ATTENDEES + CHECK-IN ══════════════════════════════════

    async function queryAttendees(q, limit) {
        let sql = `
            SELECT t.id, t.code, t.attendee_name, t.checked_in_at, t.created_at, t.event_id,
                   o.buyer_name, o.buyer_email,
                   tt.name AS type_name, e.title AS event_title
            FROM ${T.tickets} t
            JOIN ${T.orders} o ON t.order_id = o.id
            LEFT JOIN ${T.types} tt ON t.ticket_type_id = tt.id
            LEFT JOIN ${T.events} e ON t.event_id = e.id
            WHERE 1=1`;
        const params = [];
        if (q.event_id) { sql += ' AND t.event_id = ?'; params.push(Number(q.event_id)); }
        if (q.search) {
            const term = String(q.search).trim().toLowerCase();
            if (term) {
                sql += ' AND (LOWER(t.code) LIKE ? OR LOWER(o.buyer_name) LIKE ? OR LOWER(o.buyer_email) LIKE ?)';
                const like = `%${term}%`;
                params.push(like, like, like);
            }
        }
        sql += ` ORDER BY t.id DESC LIMIT ${limit}`;
        return db.all(sql, params);
    }

    http.route('get', '/attendees', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json({ attendees: await queryAttendees(req.query || {}, 1000) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Check-in by code (case-insensitive). Race-safe: the claim requires checked_in_at IS NULL. */
    http.route('post', '/checkin', { auth: true, admin: true }, async (req, res) => {
        try {
            const code = String((req.body && req.body.code) || '').trim().toUpperCase();
            if (!code) return res.status(400).json({ error: 'Escribe un código.' });
            const t = await db.get(
                `SELECT t.*, o.buyer_name, o.payment_status, tt.name AS type_name, e.title AS event_title
                 FROM ${T.tickets} t
                 JOIN ${T.orders} o ON t.order_id = o.id
                 LEFT JOIN ${T.types} tt ON t.ticket_type_id = tt.id
                 LEFT JOIN ${T.events} e ON t.event_id = e.id
                 WHERE UPPER(t.code) = ?`, [code]
            );
            if (!t || t.payment_status !== 'paid') return res.status(404).json({ error: 'Código no válido.' });
            const attendee = t.attendee_name || t.buyer_name || '';
            if (t.checked_in_at) {
                return res.json({ already: true, at: t.checked_in_at, attendee, type: t.type_name || '', event: t.event_title || '' });
            }
            const now = nowIso();
            const claim = await db.run(
                `UPDATE ${T.tickets} SET checked_in_at = ? WHERE id = ? AND checked_in_at IS NULL`,
                [now, t.id]
            );
            if (!claim || claim.changes !== 1) {
                const again = await db.get(`SELECT checked_in_at FROM ${T.tickets} WHERE id = ?`, [t.id]);
                return res.json({ already: true, at: (again && again.checked_in_at) || now, attendee, type: t.type_name || '', event: t.event_title || '' });
            }
            res.json({ success: true, attendee, type: t.type_name || '', event: t.event_title || '', at: now });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/tickets/:id/undo-checkin', { auth: true, admin: true }, async (req, res) => {
        try {
            const row = await db.get(`SELECT id FROM ${T.tickets} WHERE id = ?`, [req.params.id]);
            if (!row) return res.status(404).json({ error: 'Entrada no encontrada.' });
            await db.run(`UPDATE ${T.tickets} SET checked_in_at = NULL WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** CSV export — the isolate JSON-encodes string bodies, so the CSV travels inside JSON. */
    http.route('get', '/attendees/export', { auth: true, admin: true }, async (req, res) => {
        try {
            const rows = await queryAttendees(req.query || {}, 5000);
            // Quote everything AND neutralize spreadsheet formula injection — buyer names come
            // from the public form.
            const esc = (v) => {
                let s = String(v == null ? '' : v);
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return '"' + s.split('"').join('""') + '"';
            };
            const lines = [
                ['Código', 'Asistente', 'Email', 'Tipo', 'Evento', 'Registrado', 'Fecha check-in'].map(esc).join(','),
            ];
            for (const r of rows) {
                lines.push([
                    r.code,
                    r.attendee_name || r.buyer_name || '',
                    r.buyer_email || '',
                    r.type_name || '',
                    r.event_title || '',
                    r.checked_in_at ? 'Sí' : 'No',
                    r.checked_in_at || '',
                ].map(esc).join(','));
            }
            const stamp = new Date().toISOString().slice(0, 10);
            res.json({ csv: lines.join('\r\n'), filename: `asistentes-${stamp}.csv` });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════ ADMIN: CONFIG ════════════════════════════════════════════════

    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        res.json(await getConfig());
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        try {
            const notifyEmail = String(body.notifyEmail || '').trim();
            if (notifyEmail && !EMAIL_RE.test(notifyEmail)) {
                return res.status(400).json({ error: 'El correo de notificaciones no es válido.' });
            }
            await options.set(OPT_CONFIG, {
                currencySymbol: String(body.currencySymbol || '$').slice(0, 8) || '$',
                manualInstructions: String(body.manualInstructions || '').slice(0, 4000),
                notifyEmail,
            });
            res.json(await getConfig());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── admin sidebar ─────────────────────────────────────────────────────────────────────────────
    adminMenu.add({
        href: '/admin/plugin/tickets',
        label: 'Entradas',
        icon: 'fa-ticket',
        order: 77,
        cap: 'manage_options',
    });

    console.log('[event-tickets] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers or servers; rate-limit windows die with the child process.
};
