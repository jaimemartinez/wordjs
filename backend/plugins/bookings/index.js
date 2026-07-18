/**
 * WordJS Plugin: Bookings — ISOLATED, sandboxed.
 *
 * Appointment bookings (Amelia / Bookly parity, v1 scope):
 *  - Services with weekly availability (per-weekday time windows, split shifts supported).
 *  - Public slot picker: slots are generated server-side every `duration_min` inside each window,
 *    minus past times, minus the configured minimum notice, minus already-booked slots.
 *  - RACE-SAFE reservation: the sandbox db bridge has NO transactions, so the slot claim is a
 *    single INSERT ... SELECT ... WHERE NOT EXISTS statement — changes === 0 means someone else
 *    took the slot between render and submit.
 *  - Email confirmation to the customer + optional admin notification (both degrade gracefully:
 *    the booking is still created when mail fails).
 *  - Public status lookup / cancellation via a random 32-char token (never sequential ids).
 *
 * v1 limits by design: one staff calendar (no multi-employee), slot length = service duration,
 * no payments (price is informative only, stored as INTEGER CENTS).
 *
 * Sandbox notes: no crypto API exists in the child — tokens come from a Math.random loop and the
 * real defense is the in-memory rate cap on the public endpoints. All tables live under the
 * plugin's own prefix (db.tablePrefix) so they pass the host's default-deny SQL check.
 */

exports.metadata = {
    name: 'Bookings',
    version: '1.0.0',
    description: 'Services with weekly availability, public slot picker, race-safe reservations, email confirmation, admin agenda.',
    author: 'WordJS',
};

const OPT_CONFIG = 'bookings_config';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date.getDay() order
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-z0-9]{32}$/;
const STATUSES = ['confirmed', 'cancelled', 'completed'];
const MAX_DAYS_AHEAD = 90;
const CANCEL_NOTICE_MS = 24 * 60 * 60 * 1000; // public self-cancel allowed until 24h before

exports.init = async function (wordjs) {
    const { db, http, adminMenu, options } = wordjs;

    const P = db.tablePrefix; // 'wjp_bookings_'
    const T = {
        services: `${P}services`,
        bookings: `${P}bookings`,
    };

    // ── schema (idempotent; full column set from day 1 — ALTER is denied in the sandbox) ─────────
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
        ]);
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

    /** Validate 'YYYY-MM-DD' is a REAL calendar date (rejects 2026-02-31 rollovers). */
    const parseDateStr = (s) => {
        if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
        const d = new Date(`${s}T00:00:00`);
        if (isNaN(d.getTime()) || localDateStr(d) !== s) return null;
        return d;
    };

    /** No crypto in the sandbox — Math.random token; brute force is bounded by the rate caps. */
    const genToken = () => {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let out = '';
        for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
        return out;
    };

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
            `SELECT time FROM ${T.bookings} WHERE service_id = ? AND date = ? AND status != 'cancelled'`,
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

    // In-memory rolling-window rate limiters (single child process; req.ip is unavailable in the
    // sandbox, so caps are global per endpoint — the real anti-abuse defense here).
    const makeLimiter = (max, windowMs) => {
        let count = 0;
        let windowStart = 0;
        return () => {
            const now = Date.now();
            if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
            count++;
            return count <= max;
        };
    };
    const allowBook = makeLimiter(10, 60000);    // spec: 10 reservations/min
    const allowLookup = makeLimiter(120, 60000); // token lookups / cancellations / slot queries

    // CSV field escaping + formula-injection guard (Excel executes leading = + - @).
    const csvCell = (v) => {
        let s = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
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
            if (!allowLookup()) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
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
            if (!allowBook()) {
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
            if (!EMAIL_RE.test(customerEmail) || customerEmail.length > 200) {
                return res.status(400).json({ error: 'El email no es válido.' });
            }

            const customerPhone = String(body.customer_phone || '').trim().slice(0, 40);
            const notes = String(body.notes || '').trim().slice(0, 1000);

            const service = await db.get(`SELECT * FROM ${T.services} WHERE id = ? AND is_active = 1`, [serviceId]);
            if (!service) return res.status(404).json({ error: 'Servicio no encontrado.' });

            // The requested time must be one of the currently generatable slots — this enforces the
            // availability windows, the duration grid, the minimum notice, and "not already booked".
            const cfg = await getConfig();
            const slots = await generateSlots(service, dateStr, cfg);
            if (!slots.includes(time)) {
                return res.status(409).json({ error: 'Ese horario ya no está disponible. Elige otro.' });
            }

            // RACE-SAFE claim: no transactions in the sandbox — a single INSERT ... SELECT ...
            // WHERE NOT EXISTS is atomic per statement. changes === 0 → someone won the race.
            const token = genToken();
            const result = await db.run(
                `INSERT INTO ${T.bookings}
                    (service_id, date, time, customer_name, customer_email, customer_phone, notes, status, token)
                 SELECT ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?
                 WHERE NOT EXISTS (
                     SELECT 1 FROM ${T.bookings}
                     WHERE service_id = ? AND date = ? AND time = ? AND status != 'cancelled'
                 )`,
                [serviceId, dateStr, time, customerName, customerEmail, customerPhone, notes, token,
                    serviceId, dateStr, time]
            );
            if (!result || !result.changes) {
                return res.status(409).json({ error: 'Ese horario acaba de ocuparse. Elige otro horario.' });
            }

            // Emails degrade gracefully — the reservation already exists either way.
            let emailSent = false;
            const priceLine = service.price_cents > 0
                ? `<p style="margin:4px 0">Precio: ${(service.price_cents / 100).toFixed(2)}</p>` : '';
            // Visitor-controlled fields must be HTML-escaped before interpolation into email
            // bodies — otherwise a bot can inject markup into the owner's inbox.
            const escHtml = (v) => String(v == null ? '' : v)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const safeName = escHtml(customerName);
            const safeEmail = escHtml(customerEmail);
            const safePhone = escHtml(customerPhone);
            const safeNotes = escHtml(notes);
            try {
                await wordjs.mail({
                    to: customerEmail,
                    subject: `Reserva confirmada: ${service.name} — ${dateStr} ${time}`,
                    html: `
                        <h2 style="margin:0 0 12px">¡Reserva confirmada!</h2>
                        <p style="margin:4px 0">Hola ${safeName},</p>
                        <p style="margin:4px 0">Tu reserva quedó registrada:</p>
                        <p style="margin:4px 0"><strong>${service.name}</strong></p>
                        <p style="margin:4px 0">Fecha: <strong>${dateStr}</strong> a las <strong>${time}</strong> (${service.duration_min} min)</p>
                        ${priceLine}
                        <p style="margin:16px 0 4px">Código de tu reserva (guárdalo para consultar o cancelar):</p>
                        <p style="font-size:20px;letter-spacing:2px;font-family:monospace;margin:4px 0"><strong>${token}</strong></p>
                        <p style="margin:16px 0 4px;color:#666;font-size:13px">Puedes cancelar hasta 24 horas antes de la cita desde la página de reservas.</p>
                    `,
                    text: `Reserva confirmada: ${service.name} el ${dateStr} a las ${time} (${service.duration_min} min). Código: ${token}. Puedes cancelar hasta 24 horas antes desde la página de reservas.`,
                });
                emailSent = true;
            } catch (e) {
                console.warn('[bookings] confirmation email failed:', e.message);
            }
            try {
                if (cfg.notifyEmail && EMAIL_RE.test(cfg.notifyEmail)) {
                    await wordjs.mail({
                        to: cfg.notifyEmail,
                        subject: `Nueva reserva: ${service.name} — ${dateStr} ${time}`,
                        html: `
                            <h2 style="margin:0 0 12px">Nueva reserva</h2>
                            <p style="margin:4px 0">Servicio: <strong>${service.name}</strong></p>
                            <p style="margin:4px 0">Fecha: <strong>${dateStr}</strong> a las <strong>${time}</strong></p>
                            <p style="margin:4px 0">Cliente: ${safeName} — ${safeEmail}${customerPhone ? ' — ' + safePhone : ''}</p>
                            ${notes ? `<p style="margin:4px 0">Notas: ${safeNotes}</p>` : ''}
                        `,
                        text: `Nueva reserva: ${service.name} el ${dateStr} a las ${time}. Cliente: ${customerName} (${customerEmail}${customerPhone ? ', ' + customerPhone : ''}).${notes ? ' Notas: ' + notes : ''}`,
                    });
                }
            } catch (e) {
                console.warn('[bookings] admin notification email failed:', e.message);
            }

            res.json({
                success: true,
                token,
                emailSent,
                message: emailSent ? 'Reserva confirmada. Te enviamos un correo con los detalles.' : 'Reserva confirmada (correo no enviado).',
            });
        } catch (e) {
            console.error('[bookings] book failed:', e.message);
            res.status(500).json({ error: 'No se pudo crear la reserva. Intenta de nuevo.' });
        }
    });

    // Public status view by token.
    http.route('get', '/public/booking', async (req, res) => {
        try {
            if (!allowLookup()) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
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
            if (!allowLookup()) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
            const token = String((req.body || {}).token || '').trim().toLowerCase();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Código inválido.' });

            const b = await db.get(`SELECT id, date, time, status FROM ${T.bookings} WHERE token = ?`, [token]);
            if (!b) return res.status(404).json({ error: 'No se encontró ninguna reserva con ese código.' });
            if (b.status === 'cancelled') return res.json({ success: true, status: 'cancelled' });
            if (b.status === 'completed') return res.status(400).json({ error: 'La reserva ya fue completada.' });

            const slotMs = new Date(`${b.date}T${b.time}:00`).getTime();
            if (!Number.isFinite(slotMs) || slotMs - Date.now() < CANCEL_NOTICE_MS) {
                return res.status(400).json({ error: 'Cancelación no disponible (se requieren al menos 24 horas de antelación).' });
            }

            await db.run(`UPDATE ${T.bookings} SET status = 'cancelled' WHERE token = ? AND status != 'cancelled'`, [token]);
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
                `SELECT COUNT(*) AS n FROM ${T.bookings} WHERE service_id = ? AND date >= ? AND status != 'cancelled'`,
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
            if (!STATUSES.includes(String(q.status))) return { error: 'Estado inválido.' };
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
            const result = await db.run(`UPDATE ${T.bookings} SET status = ? WHERE id = ?`, [status, id]);
            if (!result || !result.changes) return res.status(404).json({ error: 'Reserva no encontrada.' });
            res.json({ success: true });
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
