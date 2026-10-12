/**
 * WordJS Plugin: Bookings — ISOLATED, sandboxed.
 *
 * Appointment bookings (Amelia / Bookly parity, v1 scope):
 *  - Services with weekly availability (per-weekday time windows, split shifts supported).
 *  - Public slot picker: slots are generated server-side every `duration_min` inside each window,
 *    minus past times, minus the configured minimum notice, minus already-booked slots.
 *  - RACE-SAFE reservation: the sandbox db bridge has NO transactions, so the slot and both caps
 *    below are claimed by the INSERT that creates the booking, through UNIQUE indexes on three claim
 *    columns (see "Atomic claims" in the code). A guard in the same INSERT (... WHERE NOT EXISTS
 *    and the cap counts) is not enough on its own: on Postgres each statement runs under READ
 *    COMMITTED on its own connection and reads a snapshot that concurrent INSERTs are not in yet.
 *  - Email verification: a public booking starts 'pending' (holding its slot for PENDING_TTL_MS)
 *    and is confirmed through the link mailed to the customer; unconfirmed bookings expire. It
 *    degrades to confirmed immediately ONLY when the site has no mail transport at all (no provider
 *    registered, or this plugin not granted email:admin). When a transport exists and the send
 *    fails, the booking is never confirmed: it is released and the visitor asked to retry.
 *  - Abuse bounds: per-client rate limits (req.clientKey), a cap on active future bookings per
 *    email, and a cap on UNVERIFIED bookings per client. A clientKey is an HMAC of the caller's IP,
 *    and many visitors share one behind a NAT or a proxy that is not in trustProxy, so the
 *    per-client cap only counts what verification has not vouched for and what recovers by itself:
 *    pending holds (gone within PENDING_TTL_MS) and, without mail, bookings created in the last
 *    UNVERIFIED_WINDOW_MS. A booking confirmed through its mailed link stops counting (its
 *    client_key is cleared) and is bound by the per-email cap instead; every attempt is bound by the
 *    per-client rate limit.
 *  - The slot claim and both caps are enforced by unique indexes (created at boot; a failure is
 *    logged) that the creating INSERT fills, so a burst of concurrent public requests cannot pass
 *    them together on SQLite, MySQL or Postgres. A staff re-open takes its slot claim and its email
 *    claim the same way, and is refused while another active booking holds the slot or the address
 *    is at its cap; a staff status change is written only while the booking is still in the state it
 *    was read in. When the booking changed in between (an expiry, a cancellation) the route reads it
 *    again and decides from what it finds: a confirm of a booking that stopped counting is a re-open,
 *    with the re-open's slot and cap checks. An address that held more active bookings than
 *    the cap before 1.0.1 keeps them, and gets no new booking until it is back under the cap.
 *  - Public status lookup / cancellation via a random 32-char token (never sequential ids).
 *
 * v1 limits by design: one staff calendar (no multi-employee), slot length = service duration,
 * no payments (price is informative only, stored as INTEGER CENTS).
 *
 * Sandbox notes: tokens come from the host CSPRNG (wordjs.crypto.randomToken), NOT Math.random — the
 * in-memory per-client rate caps on the public endpoints are defense-in-depth, not the sole defense. All tables live under the
 * plugin's own prefix (db.tablePrefix) so they pass the host's default-deny SQL check.
 */

exports.metadata = {
    name: 'Bookings',
    version: '1.0.1',
    description: 'Services with weekly availability, public slot picker, race-safe reservations, email confirmation, admin agenda.',
    author: 'WordJS',
};

const OPT_CONFIG = 'bookings_config';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date.getDay() order
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-z0-9]{32}$/;
// Admin-settable statuses. 'pending' (awaiting the customer's email confirmation) and 'expired'
// (never confirmed within PENDING_TTL_MS) are set only by the public flow; both are filterable.
const STATUSES = ['confirmed', 'cancelled', 'completed'];
const FILTER_STATUSES = STATUSES.concat(['pending', 'expired']);
// Statuses that do NOT hold a slot. Kept as an SQL fragment so every occupancy check agrees.
const FREE_STATUSES_SQL = "('cancelled', 'expired')";
const PENDING_TTL_MS = 60 * 60 * 1000;        // an unconfirmed reservation holds its slot for 1 h
const MAX_ACTIVE_PER_EMAIL = 3;                // future pending/confirmed bookings per customer email
const MAX_UNVERIFIED_PER_CLIENT = 5;           // unverified active bookings per client (host clientKey = HMAC of the IP)...
const UNVERIFIED_WINDOW_MS = 24 * 60 * 60 * 1000; // ...created within this window (see the header)
// The host's own refusals when this site cannot send mail at all: no provider plugin registered
// (core/plugin-api.ts mail()), or this plugin lacks the email:admin grant (plugin-context
// verifyPermission). Anything else — the provider rejecting the address, a timeout, bridge
// back-pressure — is a failed send on a site that HAS mail, and must never confirm a booking.
const NO_MAIL_TRANSPORT_RE = [/^Mail server not available$/, /tried to access 'email' \(admin\) without permission/];
// A request that loses a claim race picks fresh claims and retries this many times at most.
const CLAIM_ATTEMPTS = 6;
const MAX_DAYS_AHEAD = 90;
const CANCEL_NOTICE_MS = 24 * 60 * 60 * 1000; // public self-cancel allowed until 24h before

exports.init = async function (wordjs) {
    const { db, http, adminMenu, options } = wordjs;

    const P = db.tablePrefix; // 'wjp_bookings_'
    const T = {
        services: `${P}services`,
        bookings: `${P}bookings`,
    };

    // ── schema (idempotent; CREATE has the full column set, later columns are added by ALTER ADD COLUMN) ─
    async function initSchema() {
        await db.createTable(T.services, [
            'id INT_PK',
            'name TEXT NOT NULL',
            'description TEXT',
            'duration_min INT NOT NULL DEFAULT 60',
            'price_cents INT DEFAULT 0',
            "color TEXT DEFAULT '#3b82f6'",
            "availability TEXT NOT NULL DEFAULT '{}'",
            'is_active INT DEFAULT 1',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        ]);
        await db.createTable(T.bookings, [
            'id INT_PK',
            'service_id INT NOT NULL',
            'date TEXT NOT NULL',
            'time TEXT NOT NULL',
            'customer_name TEXT NOT NULL',
            'customer_email TEXT NOT NULL',
            'customer_phone TEXT',
            'notes TEXT',
            "status TEXT DEFAULT 'confirmed'",
            'token TEXT',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'client_key TEXT',
            'slot_claim VARCHAR(80)',
            'email_claim VARCHAR(255)',
            'client_claim VARCHAR(80)',
        ]);
        // 1.0.0 -> 1.0.1: client_key (per-client cap). Probe, then ALTER ADD COLUMN on our own table
        // (VARCHAR, not TEXT, so a literal DEFAULT is valid on MySQL too).
        let hasClientKey = true;
        try { await db.get(`SELECT client_key FROM ${T.bookings} LIMIT 1`); } catch (e) { hasClientKey = false; }
        if (!hasClientKey) {
            try { await db.run(`ALTER TABLE ${T.bookings} ADD COLUMN client_key VARCHAR(64) DEFAULT ''`); }
            catch (e) { console.error('[bookings] could not add client_key column:', e.message); }
        }
        // 1.0.1: the claim columns behind the atomic slot/cap claims (NULL = no claim held; a unique
        // index admits any number of NULLs on SQLite, MySQL and Postgres). Rows from 1.0.0 hold no
        // claim and are accounted for by the claim picker (see "Atomic claims").
        for (const [col, type] of [['slot_claim', 'VARCHAR(80)'], ['email_claim', 'VARCHAR(255)'], ['client_claim', 'VARCHAR(80)']]) {
            let has = true;
            try { await db.get(`SELECT ${col} FROM ${T.bookings} LIMIT 1`); } catch (e) { has = false; }
            if (has) continue;
            try { await db.run(`ALTER TABLE ${T.bookings} ADD COLUMN ${col} ${type}`); }
            catch (e) { console.error(`[bookings] could not add ${col} column:`, e.message); }
        }
        for (const col of ['slot_claim', 'email_claim', 'client_claim']) {
            try {
                await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_bookings_${col} ON ${T.bookings} (${col})`);
            } catch (e) {
                // The index is what makes this claim atomic on every engine: the operator is told here
                // when it cannot be created.
                console.error(`[bookings] could not create the unique ${col} index — concurrent bookings are not atomic on every engine:`, e.message);
            }
        }
        // Index names AND targets must carry the plugin prefix (host-enforced).
        const createIndex = async (name, table, cols) => {
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) {
                // Already exists / unsupported — non-fatal.
            }
        };
        await createIndex(`${P}idx_bookings_slot`, T.bookings, 'service_id, date, time');
        await createIndex(`${P}idx_bookings_date`, T.bookings, 'date');
        await createIndex(`${P}idx_bookings_token`, T.bookings, 'token');
    }
    await initSchema();

    // ── small helpers ─────────────────────────────────────────────────────────────────────────────
    const pad2 = (n) => String(n).padStart(2, '0');
    const hmToMin = (hm) => {
        const parts = String(hm).split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
    };
    const minToHm = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
    const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

    /**
     * A customer address the confirmation mail can actually be sent to. EMAIL_RE alone accepted
     * IP-literal and ':'-bearing domains (a@1.2.3.4, c@a:b.cd) that the mail provider refuses on
     * every send; control characters are refused too.
     */
    const isBookableEmail = (email) => {
        if (!EMAIL_RE.test(email) || email.length > 200 || /[\u0000-\u001f\u007f]/.test(email)) return false;
        const domain = email.slice(email.lastIndexOf('@') + 1);
        return !/[:[\]]/.test(domain) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(domain);
    };
    const isNoMailTransport = (e) => {
        const msg = String((e && e.message) || e || '');
        return NO_MAIL_TRANSPORT_RE.some((re) => re.test(msg));
    };

    /** Validate 'YYYY-MM-DD' is a REAL calendar date (rejects 2026-02-31 rollovers). */
    const parseDateStr = (s) => {
        if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
        const d = new Date(`${s}T00:00:00`);
        if (isNaN(d.getTime()) || localDateStr(d) !== s) return null;
        return d;
    };

    /**
     * SECURITY (audit HIGH): the public token is the SOLE gate on viewing/cancelling a booking, so it
     * MUST be unguessable. The old "no crypto in the sandbox" premise was FALSE — the host CSPRNG is
     * bridged as `wordjs.crypto.randomToken` (event-tickets/online-store already use it). Math.random is
     * V8 xorshift128+ whose state is reconstructable from a few observed tokens (one legitimate booking
     * returns its own token), letting an attacker predict every OTHER customer's token and read/cancel
     * their reservations — the rate caps bound brute force but NOT prediction. randomToken(16) is 32 hex
     * chars, which satisfies TOKEN_RE (/^[a-z0-9]{32}$/). Async (RPC to the host).
     */
    const genToken = async () => wordjs.crypto.randomToken(16);

    /** Read + normalize the plugin config from options (never trust the stored shape). */
    const getConfig = async () => {
        const raw = await options.get(OPT_CONFIG, null);
        const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const notice = Number(cfg.minNoticeHours);
        return {
            notifyEmail: typeof cfg.notifyEmail === 'string' ? cfg.notifyEmail.trim() : '',
            minNoticeHours: Number.isFinite(notice) && notice >= 0 ? Math.min(720, notice) : 0,
        };
    };

    /**
     * Normalize an availability payload ({mon:[{start,end}], ...}) coming from the admin UI.
     * Returns the clean object, or null when anything is malformed (unknown shapes, bad HH:mm,
     * start >= end). Unknown day keys are dropped; empty days are omitted.
     */
    const cleanAvailability = (input) => {
        let av = input;
        if (typeof av === 'string') {
            try { av = JSON.parse(av); } catch (e) { return null; }
        }
        if (!av || typeof av !== 'object' || Array.isArray(av)) return null;
        const out = {};
        for (const day of DAY_KEYS) {
            const ranges = av[day];
            if (ranges === undefined || ranges === null) continue;
            if (!Array.isArray(ranges)) return null;
            const clean = [];
            for (const r of ranges) {
                if (!r || typeof r !== 'object') return null;
                const start = String(r.start || '');
                const end = String(r.end || '');
                if (!HM_RE.test(start) || !HM_RE.test(end)) return null;
                if (hmToMin(start) >= hmToMin(end)) return null;
                clean.push({ start, end });
            }
            if (clean.length) out[day] = clean.sort((a, b) => hmToMin(a.start) - hmToMin(b.start));
        }
        return out;
    };

    /**
     * Shared slot generator for service+date. Weekday windows → starts every duration_min while
     * start+duration <= end; drops slots earlier than now + minNoticeHours (which also covers
     * "past times today"); drops slots already booked (status != 'cancelled').
     */
    const generateSlots = async (service, dateStr, cfg) => {
        let avail = {};
        try {
            const parsed = JSON.parse(service.availability || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) avail = parsed;
        } catch (e) { avail = {}; }

        const day = parseDateStr(dateStr);
        if (!day) return [];
        const windows = avail[DAY_KEYS[day.getDay()]];
        if (!Array.isArray(windows) || windows.length === 0) return [];

        const dur = Math.max(5, parseInt(service.duration_min, 10) || 60);
        const starts = new Set();
        for (const w of windows) {
            if (!w || !HM_RE.test(String(w.start || '')) || !HM_RE.test(String(w.end || ''))) continue;
            const s = hmToMin(w.start);
            const e = hmToMin(w.end);
            for (let t = s; t + dur <= e; t += dur) starts.add(t);
        }
        if (starts.size === 0) return [];

        const bookedRows = await db.all(
            `SELECT time FROM ${T.bookings} WHERE service_id = ? AND date = ? AND status NOT IN ${FREE_STATUSES_SQL}`,
            [service.id, dateStr]
        );
        const booked = new Set(bookedRows.map((r) => String(r.time)));

        const cutoffMs = Date.now() + Math.max(0, cfg.minNoticeHours) * 3600000;
        const out = [];
        for (const t of [...starts].sort((a, b) => a - b)) {
            const hm = minToHm(t);
            if (booked.has(hm)) continue;
            const slotMs = new Date(`${dateStr}T${hm}:00`).getTime();
            if (!Number.isFinite(slotMs) || slotMs < cutoffMs) continue;
            out.push(hm);
        }
        return out;
    };

    /** Validate a service payload from the admin UI. Returns { error } or { values }. */
    const cleanServicePayload = (body) => {
        const name = String(body.name || '').trim();
        if (!name) return { error: 'El nombre del servicio es obligatorio.' };
        if (name.length > 120) return { error: 'El nombre es demasiado largo (máximo 120 caracteres).' };

        const description = String(body.description || '').trim().slice(0, 2000);

        const duration = parseInt(body.duration_min, 10);
        if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
            return { error: 'La duración debe estar entre 5 y 480 minutos.' };
        }

        const price = parseInt(body.price_cents, 10);
        const priceCents = Number.isFinite(price) && price >= 0 ? Math.min(price, 99999999) : 0;
        if (Number.isFinite(price) && price < 0) return { error: 'El precio no puede ser negativo.' };

        let color = String(body.color || '').trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#3b82f6';

        const availability = cleanAvailability(body.availability === undefined ? {} : body.availability);
        if (availability === null) return { error: 'Disponibilidad inválida: revisa los rangos de horario (HH:mm, inicio antes de fin).' };

        const isActive = body.is_active === 0 || body.is_active === false ? 0 : 1;

        return {
            values: {
                name,
                description,
                duration_min: duration,
                price_cents: priceCents,
                color,
                availability: JSON.stringify(availability),
                is_active: isActive,
            },
        };
    };

    // In-memory rolling-window rate limiters, keyed PER CLIENT (the host forwards req.clientKey, an
    // HMAC of the caller's IP). A site-wide bucket would let one client 429 every other visitor.
    // The map is bounded so key churn cannot grow it without limit.
    const makeLimiter = (max, windowMs) => {
        const buckets = new Map(); // clientKey -> { count, start }
        return (req) => {
            const key = String((req && req.clientKey) || 'anon').slice(0, 64);
            const now = Date.now();
            let b = buckets.get(key);
            if (!b || now - b.start >= windowMs) {
                if (buckets.size >= 10000) {
                    for (const [k, v] of buckets) if (now - v.start >= windowMs) buckets.delete(k);
                    if (buckets.size >= 10000) buckets.delete(buckets.keys().next().value);
                }
                b = { count: 0, start: now };
                buckets.set(key, b);
            }
            b.count++;
            return b.count <= max;
        };
    };
    const allowBook = makeLimiter(5, 60000);     // reservation attempts per client per minute
    const allowLookup = makeLimiter(60, 60000);  // token lookups / cancellations / confirmations / slot queries per client

    // A status change that frees the slot frees every claim in the same UPDATE.
    const RELEASE_CLAIMS_SQL = 'slot_claim = NULL, email_claim = NULL, client_claim = NULL';

    /** UTC 'YYYY-MM-DD HH:MM:SS' — the format created_at is written in, so string comparison works. */
    const sqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

    /** Unconfirmed reservations past their TTL stop holding the slot (and every claim). Single guarded UPDATE. */
    const expireStalePending = () => db.run(
        `UPDATE ${T.bookings} SET status = 'expired', ${RELEASE_CLAIMS_SQL} WHERE status = 'pending' AND created_at < ?`,
        [sqlUtc(Date.now() - PENDING_TTL_MS)]
    );

    // The two booking caps as SQL: a guard inside the creating INSERT, which decides on its own when
    // requests do not overlap. A verified booking has client_key = '' and never matches the
    // per-client count.
    const PER_EMAIL_SQL = `SELECT COUNT(*) AS n FROM ${T.bookings} WHERE customer_email = ? AND date >= ? AND status IN ('pending', 'confirmed')`;
    const PER_CLIENT_SQL = `SELECT COUNT(*) AS n FROM ${T.bookings} WHERE client_key = ? AND created_at >= ? AND status IN ('pending', 'confirmed')`;
    const capContext = (email, clientKey) => ({
        email,
        clientKey,
        today: localDateStr(new Date()),
        since: sqlUtc(Date.now() - UNVERIFIED_WINDOW_MS),
    });
    const capGuard = (c) => ({
        sql: ` AND (${PER_EMAIL_SQL}) < ?` + (c.clientKey ? ` AND (${PER_CLIENT_SQL}) < ?` : ''),
        params: [c.email, c.today, MAX_ACTIVE_PER_EMAIL].concat(c.clientKey ? [c.clientKey, c.since, MAX_UNVERIFIED_PER_CLIENT] : []),
    });
    // ── Atomic claims ────────────────────────────────────────────────────────────────────────────
    // The slot and both caps are enforced by UNIQUE indexes on three claim columns of the booking
    // row, filled by the same INSERT that creates it:
    //   slot_claim    '<service>|<date>|<time>'  while the booking holds its slot;
    //   email_claim   '<n>|<email>', n = 1..MAX_ACTIVE_PER_EMAIL, while it counts toward the email cap;
    //   client_claim  '<n>|<clientKey>', n = 1..MAX_UNVERIFIED_PER_CLIENT, while it counts toward the
    //                 client cap.
    // A claim is set to NULL once its booking stops counting — by the status change itself
    // (RELEASE_CLAIMS_SQL, confirmation, staff) or, for time passing, by the sweep in pickCapClaim.
    // Why: the db bridge has no transactions and, on Postgres, each statement autocommits on its own
    // connection under READ COMMITTED, so the INSERT's NOT EXISTS / COUNT guard reads a snapshot that
    // concurrent INSERTs are not in yet, and a burst passes it together. A unique index is checked
    // against every row, committed or in flight, on SQLite, MySQL and Postgres alike: of two requests
    // that pick the same claim, exactly one inserts. Rows that count but hold no claim (bookings made
    // before 1.0.1) leave fewer claim numbers on offer (see pickCapClaim), so the caps still hold.
    const ACTIVE_SQL = "COALESCE(status, '') IN ('pending', 'confirmed')";
    const EMAIL_CAP_MSG = `Ya tienes ${MAX_ACTIVE_PER_EMAIL} reservas activas. Cancela alguna antes de reservar otra.`;
    const CLIENT_CAP_MSG = 'Has alcanzado el máximo de reservas activas sin verificar desde esta conexión. Confirma las pendientes desde tu correo o inténtalo más tarde.';
    const BUSY_MSG = 'No pudimos completar la reserva en este momento. Inténtalo de nuevo.';
    const slotClaimOf = (serviceId, dateStr, time) => `${serviceId}|${dateStr}|${time}`;
    const capValues = (key, max) => Array.from({ length: max }, (_, i) => `${i + 1}|${key}`);
    // A write that lost to a concurrent one: a unique index refusing a claim (SQLite "UNIQUE constraint
    // failed", Postgres "duplicate key value violates unique constraint", MySQL "Duplicate entry") or a
    // MySQL deadlock victim. The bridge relays the driver's message.
    const isConflict = (e) => /unique|duplicate|deadlock/i.test(String((e && e.message) || e || ''));

    /**
     * The claim NUMBERS of `values` that the unique index already holds, read through the column
     * itself: on MySQL a case- and accent-insensitive collation (utf8mb4_unicode_ci) makes
     * '1|josé@x.io' and '1|jose@x.io' one key, and only the database's own comparison sees that.
     * Comparing the strings here offered '1|josé@x.io' as free while the index refused it, until the
     * retries ran out. The number before '|' is written by this plugin (ASCII digits) and names the claim.
     */
    const heldClaimNumbers = async (column, values) => {
        const rows = await db.all(
            `SELECT ${column} AS claim FROM ${T.bookings} WHERE ${column} IN (${values.map(() => '?').join(', ')})`,
            values
        );
        return new Set(rows.map((r) => parseInt(String(r.claim), 10)).filter((n) => Number.isInteger(n)));
    };

    /**
     * A free claim value for one cap ('<n>|<key>'), or null when the cap is full. First frees the
     * claims of rows that no longer count (idempotent: it never touches a row that counts).
     *
     * Only the `room` LOWEST free numbers are offered, room = max − rows that count (claimed or not).
     * Offering the free numbers below `max − unclaimed` instead assumed every held claim sat in that
     * range, which fails once a row starts counting without a claim while the other claims stay where
     * they are (a staff re-open did that before re-opens took a claim; a row edited outside the plugin
     * still can): with claim 3 held plus one unclaimed row, 1 and 2 were both offered with room for
     * one, and a burst took both. Offering the lowest `room` free numbers, the requests of a burst
     * compete for the same values and the unique index lets at most `room` of them in. When the rows
     * that count already reach `max` (or pass it: an address that held more before 1.0.1), nothing is
     * offered.
     */
    const pickCapClaim = async (column, key, max, countingSql, countingParams) => {
        const values = capValues(key, max);
        await db.run(
            `UPDATE ${T.bookings} SET ${column} = NULL WHERE ${column} IN (${values.map(() => '?').join(', ')}) AND NOT (${countingSql})`,
            [...values, ...countingParams]
        );
        const counting = await db.get(`SELECT COUNT(*) AS n FROM ${T.bookings} WHERE ${countingSql}`, countingParams);
        const room = max - Number((counting && counting.n) || 0);
        if (room <= 0) return null;
        const held = await heldClaimNumbers(column, values);
        const free = values.filter((_, i) => !held.has(i + 1)).slice(0, room);
        // Random among the free values, so concurrent requests mostly pick different ones.
        return free.length ? free[Math.floor(Math.random() * free.length)] : null;
    };

    /**
     * Staff re-opens a booking that no longer counts (completed, cancelled or expired, dated today or
     * later) as confirmed. It holds its slot again, so it takes the slot claim, and it counts toward its
     * address's cap again, so it takes an email claim — both in the same UPDATE, exactly like a public
     * booking. `b` is the row as read (service_id, date, time, customer_email). Returns 'ok', 'taken'
     * (another active booking holds the slot), 'full' (the address already holds MAX_ACTIVE_PER_EMAIL
     * active bookings), 'busy' (claims kept colliding) or 'changed' (the row is no longer re-openable —
     * re-opened or deleted meanwhile).
     * Re-opening used to add a counting row with no claim: a burst could then pass the cap (see
     * pickCapClaim), and staff could hold an address above it. It did not look at the slot either: a
     * staff confirm of a booking that expired (or was cancelled by its customer) after the agenda showed
     * it — or between the route's read and its write — re-opened it next to the booking another visitor
     * had made in the freed slot, two active bookings at one time on one calendar.
     */
    const reopenWithinCap = async (id, b) => {
        const email = String(b.customer_email || '');
        const today = localDateStr(new Date());
        const slotClaim = slotClaimOf(b.service_id, b.date, b.time);
        for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
            // A slot claim left on a booking that no longer holds the slot must not block it. Then the
            // slot is checked for active bookings with or without a claim (rows from before 1.0.1); the
            // claim taken by the UPDATE settles a booking made at the same moment.
            await db.run(
                `UPDATE ${T.bookings} SET slot_claim = NULL WHERE slot_claim = ? AND status IN ${FREE_STATUSES_SQL}`,
                [slotClaim]
            );
            if (await slotHeld(b.service_id, b.date, b.time, id)) return 'taken';
            const claim = await pickCapClaim('email_claim', email, MAX_ACTIVE_PER_EMAIL,
                `customer_email = ? AND date >= ? AND ${ACTIVE_SQL}`, [email, today]);
            if (!claim) return 'full';
            try {
                const r = await db.run(
                    `UPDATE ${T.bookings} SET status = 'confirmed', client_key = '', client_claim = NULL, email_claim = ?, slot_claim = ?
                     WHERE id = ? AND NOT (${ACTIVE_SQL})`,
                    [claim, slotClaim, id]
                );
                return r && r.changes ? 'ok' : 'changed';
            } catch (e) {
                // Another booking took the slot (answered as 'taken' on the next pass) or the email
                // claim (pick again) meanwhile.
                if (!isConflict(e)) throw e;
            }
        }
        return 'busy';
    };

    /**
     * The WHERE that pins a booking row to the state it was read in — its status and the slot and
     * email claims, NULL-safe — so a staff UPDATE decided from that read lands only while nothing
     * changed them. (client_claim is left out: the staff UPDATE clears it whatever its value, and a
     * confirmed booking's client claim is released by time alone.)
     */
    const sameStateSql = (b) => {
        const parts = [];
        const params = [];
        for (const col of ['status', 'slot_claim', 'email_claim']) {
            if (b[col] === null || b[col] === undefined) parts.push(`${col} IS NULL`);
            else { parts.push(`${col} = ?`); params.push(b[col]); }
        }
        return { sql: parts.join(' AND '), params };
    };

    /** Claims for both caps, or { error } with the message for the first cap that is full. */
    const prepareClaims = async (c) => {
        const email = await pickCapClaim('email_claim', c.email, MAX_ACTIVE_PER_EMAIL,
            `customer_email = ? AND date >= ? AND ${ACTIVE_SQL}`, [c.email, c.today]);
        if (!email) return { error: EMAIL_CAP_MSG };
        let client = null;
        if (c.clientKey) {
            client = await pickCapClaim('client_claim', c.clientKey, MAX_UNVERIFIED_PER_CLIENT,
                `client_key = ? AND created_at >= ? AND ${ACTIVE_SQL}`, [c.clientKey, c.since]);
            if (!client) return { error: CLIENT_CAP_MSG };
        }
        return { email, client };
    };

    /** True when an active booking (other than `exceptId`) holds the slot, claimed or not. */
    const slotHeld = async (serviceId, dateStr, time, exceptId = 0) => !!(await db.get(
        `SELECT id FROM ${T.bookings} WHERE service_id = ? AND date = ? AND time = ? AND status NOT IN ${FREE_STATUSES_SQL} AND id != ? LIMIT 1`,
        [serviceId, dateStr, time, exceptId]
    ));

    /** Absolute page URL for the confirmation link: the visitor's page only when it is on this site. */
    const confirmBaseUrl = async (pageUrl) => {
        let site = '';
        try { site = String(await wordjs.site.url() || '').replace(/\/+$/, ''); } catch (e) { site = ''; }
        const p = String(pageUrl || '').trim().slice(0, 1000);
        if (site && /^https?:\/\//i.test(p) && (p === site || p.startsWith(site + '/') || p.startsWith(site + '?'))) {
            return p.split('#')[0];
        }
        return site || '';
    };

    // CSV field escaping + formula-injection guard (Excel executes leading = + - @).
    const csvCell = (v) => {
        let s = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
    };

    // Visitor-controlled fields must be HTML-escaped before interpolation into email bodies —
    // otherwise a bot can inject markup into the owner's inbox.
    const escHtml = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    /** Owner notification — sent only for CONFIRMED bookings, so unverified requests never reach the inbox. */
    const notifyOwner = async (service, b, cfg) => {
        try {
            if (cfg.notifyEmail && EMAIL_RE.test(cfg.notifyEmail)) {
                await wordjs.mail({
                    to: cfg.notifyEmail,
                    subject: `Nueva reserva: ${service.name} — ${b.date} ${b.time}`,
                    html: `
                        <h2 style="margin:0 0 12px">Nueva reserva</h2>
                        <p style="margin:4px 0">Servicio: <strong>${escHtml(service.name)}</strong></p>
                        <p style="margin:4px 0">Fecha: <strong>${b.date}</strong> a las <strong>${b.time}</strong></p>
                        <p style="margin:4px 0">Cliente: ${escHtml(b.customer_name)} — ${escHtml(b.customer_email)}${b.customer_phone ? ' — ' + escHtml(b.customer_phone) : ''}</p>
                        ${b.notes ? `<p style="margin:4px 0">Notas: ${escHtml(b.notes)}</p>` : ''}
                    `,
                    text: `Nueva reserva: ${service.name} el ${b.date} a las ${b.time}. Cliente: ${b.customer_name} (${b.customer_email}${b.customer_phone ? ', ' + b.customer_phone : ''}).${b.notes ? ' Notas: ' + b.notes : ''}`,
                });
            }
        } catch (e) {
            console.warn('[bookings] admin notification email failed:', e.message);
        }
    };

    // ══════════════════════════════════ PUBLIC ROUTES ══════════════════════════════════

    // Active services for the Puck block (public projection only — no availability JSON dump).
    http.route('get', '/public/services', async (req, res) => {
        try {
            const rows = await db.all(
                `SELECT id, name, description, duration_min, price_cents, color
                 FROM ${T.services} WHERE is_active = 1 ORDER BY name`
            );
            res.json({ services: rows });
        } catch (e) {
            res.status(500).json({ error: 'No se pudieron cargar los servicios.' });
        }
    });

    // Available slots for service+date.
    http.route('get', '/public/slots', async (req, res) => {
        try {
            if (!allowLookup(req)) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
            const serviceId = parseInt((req.query || {}).service_id, 10);
            const dateStr = String((req.query || {}).date || '');
            if (!Number.isFinite(serviceId) || serviceId < 1) return res.status(400).json({ error: 'Servicio inválido.' });
            const day = parseDateStr(dateStr);
            if (!day) return res.status(400).json({ error: 'Fecha inválida (usa AAAA-MM-DD).' });

            const today = parseDateStr(localDateStr(new Date()));
            if (day.getTime() < today.getTime()) return res.status(400).json({ error: 'La fecha ya pasó.' });
            if (day.getTime() > today.getTime() + MAX_DAYS_AHEAD * 86400000) {
                return res.status(400).json({ error: `Solo se puede reservar con hasta ${MAX_DAYS_AHEAD} días de antelación.` });
            }

            const service = await db.get(`SELECT * FROM ${T.services} WHERE id = ? AND is_active = 1`, [serviceId]);
            if (!service) return res.status(404).json({ error: 'Servicio no encontrado.' });

            const cfg = await getConfig();
            await expireStalePending();
            const slots = await generateSlots(service, dateStr, cfg);
            res.json({ slots });
        } catch (e) {
            res.status(500).json({ error: 'No se pudieron calcular los horarios.' });
        }
    });

    // Create a reservation — anti-spam + validation + RACE-SAFE single-statement slot claim.
    http.route('post', '/public/book', async (req, res) => {
        try {
            const body = req.body || {};

            // Anti-spam: honeypot field must be empty, and the form must have been on screen a
            // human-plausible amount of time. Generic message on purpose.
            const elapsed = Number(body.elapsed);
            if (String(body.hp || '').trim() !== '' || !Number.isFinite(elapsed) || elapsed < 2500) {
                return res.status(400).json({ error: 'No se pudo procesar la solicitud. Intenta de nuevo.' });
            }
            if (!allowBook(req)) {
                return res.status(429).json({ error: 'Hay demasiadas reservas en este momento. Intenta de nuevo en un minuto.' });
            }

            const serviceId = parseInt(body.service_id, 10);
            if (!Number.isFinite(serviceId) || serviceId < 1) return res.status(400).json({ error: 'Servicio inválido.' });

            const dateStr = String(body.date || '');
            const day = parseDateStr(dateStr);
            if (!day) return res.status(400).json({ error: 'Fecha inválida.' });
            const today = parseDateStr(localDateStr(new Date()));
            if (day.getTime() < today.getTime()) return res.status(400).json({ error: 'La fecha ya pasó.' });
            if (day.getTime() > today.getTime() + MAX_DAYS_AHEAD * 86400000) {
                return res.status(400).json({ error: `Solo se puede reservar con hasta ${MAX_DAYS_AHEAD} días de antelación.` });
            }

            const time = String(body.time || '');
            if (!HM_RE.test(time)) return res.status(400).json({ error: 'Horario inválido.' });

            const customerName = String(body.customer_name || '').trim();
            if (!customerName) return res.status(400).json({ error: 'El nombre es obligatorio.' });
            if (customerName.length > 120) return res.status(400).json({ error: 'El nombre es demasiado largo.' });

            const customerEmail = String(body.customer_email || '').trim().toLowerCase();
            if (!isBookableEmail(customerEmail)) {
                return res.status(400).json({ error: 'El email no es válido.' });
            }

            const customerPhone = String(body.customer_phone || '').trim().slice(0, 40);
            const notes = String(body.notes || '').trim().slice(0, 1000);

            const service = await db.get(`SELECT * FROM ${T.services} WHERE id = ? AND is_active = 1`, [serviceId]);
            if (!service) return res.status(404).json({ error: 'Servicio no encontrado.' });

            // Free the slots of reservations nobody confirmed, then cap how many future bookings one
            // email address may hold (pending + confirmed) and how many UNVERIFIED bookings one client
            // may hold (see the header), so a single visitor cannot fill the calendar. Picking the
            // claims answers "cap full" precisely; the INSERT below enforces the caps atomically.
            await expireStalePending();
            const clientKey = String(req.clientKey || '').slice(0, 64);
            const caps = capContext(customerEmail, clientKey);
            let claims = await prepareClaims(caps);
            if (claims.error) return res.status(429).json({ error: claims.error });

            // The requested time must be one of the currently generatable slots — this enforces the
            // availability windows, the duration grid, the minimum notice, and "not already booked".
            const cfg = await getConfig();
            const slots = await generateSlots(service, dateStr, cfg);
            if (!slots.includes(time)) {
                return res.status(409).json({ error: 'Ese horario ya no está disponible. Elige otro.' });
            }

            // RACE-SAFE claim (see "Atomic claims"): one INSERT creates the booking AND its slot,
            // email and client claims; the unique indexes let exactly one of two overlapping requests
            // win any claim, on every engine. The guard in the same statement (slot free, caps not
            // full) answers requests that do not overlap. A request that loses a race says why (slot
            // taken → 409, cap full → 429) or picks fresh claims and tries again.
            // The reservation starts 'pending': it holds the slot for PENDING_TTL_MS and becomes
            // 'confirmed' only through the link mailed to the customer (the token is the secret and
            // is NOT returned in this response while the booking is pending). With no mail transport
            // at all it is confirmed right away (the pre-1.0.1 behaviour), still under the caps.
            const token = await genToken();
            const guard = capGuard(caps);
            const slotClaim = slotClaimOf(serviceId, dateStr, time);
            for (let attempt = 1; ; attempt++) {
                // A slot claim left on a booking that no longer holds the slot must not block it.
                await db.run(
                    `UPDATE ${T.bookings} SET slot_claim = NULL WHERE slot_claim = ? AND status IN ${FREE_STATUSES_SQL}`,
                    [slotClaim]
                );
                let result = null;
                let failure = null;
                try {
                    result = await db.run(
                        `INSERT INTO ${T.bookings}
                            (service_id, date, time, customer_name, customer_email, customer_phone, notes, status, token, created_at, client_key,
                             slot_claim, email_claim, client_claim)
                         SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?
                         WHERE NOT EXISTS (
                             SELECT 1 FROM ${T.bookings}
                             WHERE service_id = ? AND date = ? AND time = ? AND status NOT IN ${FREE_STATUSES_SQL}
                         )${guard.sql}`,
                        [serviceId, dateStr, time, customerName, customerEmail, customerPhone, notes, token, sqlUtc(Date.now()), clientKey,
                            slotClaim, claims.email, claims.client,
                            serviceId, dateStr, time, ...guard.params]
                    );
                } catch (e) {
                    failure = e; // a unique claim taken meanwhile (or, on MySQL, a deadlock victim)
                }
                if (result && result.changes) break;
                if (await slotHeld(serviceId, dateStr, time)) {
                    return res.status(409).json({ error: 'Ese horario acaba de ocuparse. Elige otro horario.' });
                }
                claims = await prepareClaims(caps);
                if (claims.error) return res.status(429).json({ error: claims.error });
                if (attempt >= CLAIM_ATTEMPTS) {
                    // Out of attempts while the claims kept colliding: a conflict the visitor can
                    // retry, never a 500. Any other failure is a real error.
                    if (failure && !isConflict(failure)) throw failure;
                    if (failure) console.warn('[bookings] gave up after repeated claim conflicts:', failure.message);
                    return res.status(409).json({ error: failure ? BUSY_MSG : 'Ese horario acaba de ocuparse. Elige otro horario.' });
                }
            }

            const booking = { date: dateStr, time, token, customer_name: customerName, customer_email: customerEmail, customer_phone: customerPhone, notes };
            let mailed = false;
            let noTransport = false;
            try {
                const base = await confirmBaseUrl(body.page_url);
                const link = base ? `${base}${base.includes('?') ? '&' : '?'}booking=${token}&confirm=1` : '';
                await wordjs.mail({
                    to: customerEmail,
                    subject: `Confirma tu reserva: ${service.name} — ${dateStr} ${time}`,
                    html: `
                        <h2 style="margin:0 0 12px">Confirma tu reserva</h2>
                        <p style="margin:4px 0">Hola ${escHtml(customerName)},</p>
                        <p style="margin:4px 0">Recibimos una solicitud de reserva con este correo:</p>
                        <p style="margin:4px 0"><strong>${escHtml(service.name)}</strong></p>
                        <p style="margin:4px 0">Fecha: <strong>${dateStr}</strong> a las <strong>${time}</strong> (${service.duration_min} min)</p>
                        ${link ? `<p style="margin:16px 0"><a href="${escHtml(link)}">Confirmar la reserva</a></p>` : ''}
                        <p style="margin:16px 0 4px">Código de tu reserva (guárdalo para confirmar, consultar o cancelar):</p>
                        <p style="font-size:20px;letter-spacing:2px;font-family:monospace;margin:4px 0"><strong>${token}</strong></p>
                        <p style="margin:16px 0 4px;color:#666;font-size:13px">Si no confirmas en los próximos ${Math.round(PENDING_TTL_MS / 60000)} minutos, el horario se liberará. Si no hiciste esta reserva, ignora este correo.</p>
                    `,
                    text: `Confirma tu reserva: ${service.name} el ${dateStr} a las ${time} (${service.duration_min} min).${link ? ' Confirmar: ' + link : ''} Código: ${token}. Si no confirmas en ${Math.round(PENDING_TTL_MS / 60000)} minutos, el horario se liberará.`,
                });
                mailed = true;
            } catch (e) {
                noTransport = isNoMailTransport(e);
                console.warn('[bookings] confirmation email failed:', e && e.message);
            }

            if (mailed) {
                return res.json({
                    success: true,
                    pending: true,
                    emailSent: true,
                    message: 'Te enviamos un correo: abre el enlace para confirmar la reserva.',
                });
            }

            if (!noTransport) {
                // The site HAS mail and this send failed (the provider refused the address, a
                // timeout, back-pressure...). Fail closed: never confirm an address nobody could
                // verify. The token never left the server, so the booking can no longer be
                // confirmed; release its slot now rather than at the TTL, so a mistyped address does
                // not keep the visitor's own slot taken for an hour. If this UPDATE fails, the
                // booking still expires with the TTL.
                // 422, not a 5xx: a CDN or proxy in front of the site may replace a 5xx body with its own
                // error page, and the visitor needs this message to fix the address.
                try {
                    await db.run(`UPDATE ${T.bookings} SET status = 'expired', ${RELEASE_CLAIMS_SQL} WHERE token = ? AND status = 'pending'`, [token]);
                } catch (e) { /* expires with the TTL */ }
                return res.status(422).json({
                    error: 'No pudimos enviar el correo de confirmación a esa dirección. Revisa el email e inténtalo de nuevo.',
                });
            }

            // No mail transport on this site at all: confirm immediately (there is no other channel
            // to verify the address) and hand the token back so the customer can manage the booking.
            // client_key is kept: this booking counts toward the per-client unverified cap.
            await db.run(`UPDATE ${T.bookings} SET status = 'confirmed' WHERE token = ? AND status = 'pending'`, [token]);
            await notifyOwner(service, booking, cfg);
            res.json({
                success: true,
                token,
                emailSent: false,
                message: 'Reserva confirmada (correo no enviado).',
            });
        } catch (e) {
            console.error('[bookings] book failed:', e.message);
            res.status(500).json({ error: 'No se pudo crear la reserva. Intenta de nuevo.' });
        }
    });

    // Email confirmation: the token only reaches the customer through the mailed link, so a
    // successful confirm proves control of the address. Single guarded UPDATE (pending -> confirmed
    // while still inside the TTL); idempotent for an already-confirmed booking. The verified booking
    // drops its client_key: from here on the per-email cap bounds it, not the requester's IP.
    http.route('post', '/public/confirm', async (req, res) => {
        try {
            if (!allowLookup(req)) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
            const token = String((req.body || {}).token || '').trim().toLowerCase();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Código inválido.' });
            await expireStalePending();
            const r = await db.run(`UPDATE ${T.bookings} SET status = 'confirmed', client_key = '', client_claim = NULL WHERE token = ? AND status = 'pending'`, [token]);
            const b = await db.get(`SELECT * FROM ${T.bookings} WHERE token = ?`, [token]);
            if (!b) return res.status(404).json({ error: 'No se encontró ninguna reserva con ese código.' });
            if (b.status === 'expired') return res.status(410).json({ error: 'El enlace de confirmación caducó y el horario se liberó. Haz una nueva reserva.' });
            if (b.status !== 'confirmed' && b.status !== 'completed') return res.status(409).json({ error: 'La reserva no se puede confirmar.' });
            if (r && r.changes === 1) {
                const service = (await db.get(`SELECT * FROM ${T.services} WHERE id = ?`, [b.service_id])) || { name: 'Servicio' };
                await notifyOwner(service, b, await getConfig());
            }
            res.json({ success: true, status: 'confirmed' });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo confirmar la reserva.' });
        }
    });

    // Public status view by token.
    http.route('get', '/public/booking', async (req, res) => {
        try {
            if (!allowLookup(req)) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
            const token = String((req.query || {}).token || '').trim().toLowerCase();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Código inválido.' });

            const b = await db.get(
                `SELECT b.date, b.time, b.status, b.customer_name,
                        s.name AS service_name, s.duration_min, s.price_cents, s.color
                 FROM ${T.bookings} b
                 LEFT JOIN ${T.services} s ON s.id = b.service_id
                 WHERE b.token = ?`,
                [token]
            );
            if (!b) return res.status(404).json({ error: 'No se encontró ninguna reserva con ese código.' });

            const slotMs = new Date(`${b.date}T${b.time}:00`).getTime();
            const canCancel = b.status === 'confirmed' && Number.isFinite(slotMs) && slotMs - Date.now() >= CANCEL_NOTICE_MS;
            res.json({
                booking: {
                    service_name: b.service_name || 'Servicio',
                    color: b.color || '#3b82f6',
                    duration_min: b.duration_min || null,
                    price_cents: b.price_cents || 0,
                    date: b.date,
                    time: b.time,
                    status: b.status,
                    customer_name: b.customer_name,
                    canCancel,
                },
            });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo consultar la reserva.' });
        }
    });

    // Public cancellation by token (allowed until 24h before the appointment).
    http.route('post', '/public/cancel', async (req, res) => {
        try {
            if (!allowLookup(req)) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
            const token = String((req.body || {}).token || '').trim().toLowerCase();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Código inválido.' });

            const b = await db.get(`SELECT id, date, time, status FROM ${T.bookings} WHERE token = ?`, [token]);
            if (!b) return res.status(404).json({ error: 'No se encontró ninguna reserva con ese código.' });
            if (b.status === 'cancelled') return res.json({ success: true, status: 'cancelled' });
            if (b.status === 'completed') return res.status(400).json({ error: 'La reserva ya fue completada.' });
            if (b.status === 'expired') return res.json({ success: true, status: 'expired' });

            const slotMs = new Date(`${b.date}T${b.time}:00`).getTime();
            if (!Number.isFinite(slotMs) || slotMs - Date.now() < CANCEL_NOTICE_MS) {
                return res.status(400).json({ error: 'Cancelación no disponible (se requieren al menos 24 horas de antelación).' });
            }

            await db.run(`UPDATE ${T.bookings} SET status = 'cancelled', ${RELEASE_CLAIMS_SQL} WHERE token = ? AND status != 'cancelled'`, [token]);
            res.json({ success: true, status: 'cancelled' });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cancelar la reserva.' });
        }
    });

    // ══════════════════════════════════ ADMIN ROUTES ══════════════════════════════════

    // ---- services CRUD ----
    http.route('get', '/services', { auth: true, admin: true }, async (req, res) => {
        try {
            const rows = await db.all(`SELECT * FROM ${T.services} ORDER BY name`);
            for (const r of rows) {
                try { r.availability = JSON.parse(r.availability || '{}'); } catch (e) { r.availability = {}; }
            }
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/services', { auth: true, admin: true }, async (req, res) => {
        try {
            const { error, values } = cleanServicePayload(req.body || {});
            if (error) return res.status(400).json({ error });
            const result = await db.run(
                `INSERT INTO ${T.services} (name, description, duration_min, price_cents, color, availability, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [values.name, values.description, values.duration_min, values.price_cents, values.color, values.availability, values.is_active]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/services/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido.' });
            const existing = await db.get(`SELECT id FROM ${T.services} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Servicio no encontrado.' });

            const { error, values } = cleanServicePayload(req.body || {});
            if (error) return res.status(400).json({ error });
            await db.run(
                `UPDATE ${T.services}
                 SET name = ?, description = ?, duration_min = ?, price_cents = ?, color = ?, availability = ?, is_active = ?
                 WHERE id = ?`,
                [values.name, values.description, values.duration_min, values.price_cents, values.color, values.availability, values.is_active, id]
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/services/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido.' });
            // Refuse to delete a service with upcoming non-cancelled bookings — deactivate instead.
            const today = localDateStr(new Date());
            const upcoming = await db.get(
                `SELECT COUNT(*) AS n FROM ${T.bookings} WHERE service_id = ? AND date >= ? AND status NOT IN ${FREE_STATUSES_SQL}`,
                [id, today]
            );
            if (upcoming && upcoming.n > 0) {
                return res.status(409).json({ error: `El servicio tiene ${upcoming.n} reserva(s) futura(s). Cancélalas o desactiva el servicio en su lugar.` });
            }
            await db.run(`DELETE FROM ${T.services} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- agenda ----

    /** Shared WHERE builder for the agenda list + CSV export (all filters optional). */
    const buildBookingFilters = (query) => {
        const where = [];
        const params = [];
        const q = query || {};
        if (q.date) {
            if (!parseDateStr(String(q.date))) return { error: 'Fecha inválida.' };
            where.push('b.date = ?');
            params.push(String(q.date));
        } else {
            if (q.from) {
                if (!parseDateStr(String(q.from))) return { error: 'Fecha "desde" inválida.' };
                where.push('b.date >= ?');
                params.push(String(q.from));
            }
            if (q.to) {
                if (!parseDateStr(String(q.to))) return { error: 'Fecha "hasta" inválida.' };
                where.push('b.date <= ?');
                params.push(String(q.to));
            }
        }
        if (q.status) {
            if (!FILTER_STATUSES.includes(String(q.status))) return { error: 'Estado inválido.' };
            where.push('b.status = ?');
            params.push(String(q.status));
        }
        if (q.service_id) {
            const sid = parseInt(q.service_id, 10);
            if (!Number.isFinite(sid)) return { error: 'Servicio inválido.' };
            where.push('b.service_id = ?');
            params.push(sid);
        }
        return { where, params };
    };

    http.route('get', '/bookings', { auth: true, admin: true }, async (req, res) => {
        try {
            const f = buildBookingFilters(req.query);
            if (f.error) return res.status(400).json({ error: f.error });
            const rows = await db.all(
                `SELECT b.*, s.name AS service_name, s.color AS service_color, s.duration_min
                 FROM ${T.bookings} b
                 LEFT JOIN ${T.services} s ON s.id = b.service_id
                 ${f.where.length ? 'WHERE ' + f.where.join(' AND ') : ''}
                 ORDER BY b.date, b.time, b.id
                 LIMIT 2000`,
                f.params
            );
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/bookings/:id/status', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido.' });
            const status = String((req.body || {}).status || '');
            if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
            // Staff has vouched for the booking: it no longer counts against the requester's client.
            // A cancelled booking frees its slot and its email claim; a completed one stops counting
            // toward the email cap. Re-opening one that no longer counts (dated today or later) as
            // confirmed puts it back in its slot and under the email cap: it takes the slot claim and an
            // email claim like a public booking, and is refused while another active booking holds the
            // slot or the address already holds MAX_ACTIVE_PER_EMAIL active bookings.
            // The path is chosen from the row as read, so the write lands only on that state: the
            // UPDATE is conditional on the status and claims read. A booking read as pending can
            // expire (or be cancelled by its customer) before the write; an unconditional UPDATE then
            // confirmed it with no claim, one over the address's cap once the freed claim was taken
            // again. A write that finds the row changed reads it again and decides from the new state —
            // a booking that stopped counting meanwhile is a re-open, with the re-open's checks.
            const release = status === 'cancelled' ? ', slot_claim = NULL, email_claim = NULL'
                : status === 'completed' ? ', email_claim = NULL' : '';
            for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
                const b = await db.get(`SELECT customer_email, date, status, slot_claim, email_claim, service_id, time FROM ${T.bookings} WHERE id = ?`, [id]);
                if (!b) return res.status(404).json({ error: 'Reserva no encontrada.' });
                const counts = ['pending', 'confirmed'].includes(String(b.status || ''));
                if (status === 'confirmed' && !counts && String(b.date) >= localDateStr(new Date())) {
                    const outcome = await reopenWithinCap(id, b);
                    if (outcome === 'ok') return res.json({ success: true });
                    if (outcome === 'taken') {
                        return res.status(409).json({ error: 'Ese horario ya lo tiene otra reserva activa: esta reserva no se puede reabrir. Cambia o cancela la otra antes.' });
                    }
                    if (outcome === 'full') {
                        return res.status(409).json({ error: `Este cliente ya tiene ${MAX_ACTIVE_PER_EMAIL} reservas activas. Cancela o completa otra antes de reabrir esta.` });
                    }
                    if (outcome === 'busy') return res.status(409).json({ error: 'La reserva cambió mientras se reabría. Inténtalo de nuevo.' });
                    continue; // 'changed': re-opened or deleted meanwhile — read it again
                }
                const asRead = sameStateSql(b);
                const result = await db.run(
                    `UPDATE ${T.bookings} SET status = ?, client_key = '', client_claim = NULL${release} WHERE id = ? AND ${asRead.sql}`,
                    [status, id, ...asRead.params]
                );
                if (result && result.changes) return res.json({ success: true });
            }
            res.status(409).json({ error: 'La reserva cambió mientras se actualizaba. Inténtalo de nuevo.' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/bookings/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido.' });
            await db.run(`DELETE FROM ${T.bookings} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // CSV export — the isolate JSON-encodes string bodies, so we return {csv, filename} and the
    // admin page builds the Blob client-side.
    http.route('get', '/bookings/export', { auth: true, admin: true }, async (req, res) => {
        try {
            const f = buildBookingFilters(req.query);
            if (f.error) return res.status(400).json({ error: f.error });
            const rows = await db.all(
                `SELECT b.id, s.name AS service_name, b.date, b.time, b.status,
                        b.customer_name, b.customer_email, b.customer_phone, b.notes, b.created_at
                 FROM ${T.bookings} b
                 LEFT JOIN ${T.services} s ON s.id = b.service_id
                 ${f.where.length ? 'WHERE ' + f.where.join(' AND ') : ''}
                 ORDER BY b.date, b.time, b.id`,
                f.params
            );
            const header = ['Id', 'Servicio', 'Fecha', 'Hora', 'Estado', 'Cliente', 'Email', 'Teléfono', 'Notas', 'Creada'];
            const lines = [header.map(csvCell).join(',')];
            for (const r of rows) {
                lines.push([
                    r.id, r.service_name || '', r.date, r.time, r.status,
                    r.customer_name, r.customer_email, r.customer_phone || '', r.notes || '', r.created_at || '',
                ].map(csvCell).join(','));
            }
            res.json({ csv: lines.join('\r\n'), filename: `reservas-${localDateStr(new Date())}.csv` });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- config ----
    http.route('get', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json(await getConfig());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/config', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const notifyEmail = String(body.notifyEmail || '').trim();
            if (notifyEmail && !EMAIL_RE.test(notifyEmail)) {
                return res.status(400).json({ error: 'El email de notificaciones no es válido.' });
            }
            const notice = Number(body.minNoticeHours);
            if (!Number.isFinite(notice) || notice < 0 || notice > 720) {
                return res.status(400).json({ error: 'La antelación mínima debe estar entre 0 y 720 horas.' });
            }
            await options.set(OPT_CONFIG, { notifyEmail, minNoticeHours: notice });
            res.json(await getConfig());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    adminMenu.add({
        href: '/admin/plugin/bookings',
        label: 'Reservas',
        icon: 'fa-calendar-check',
        order: 71,
        cap: 'manage_options',
    });

    console.log('[bookings] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — everything is per-request.
};
