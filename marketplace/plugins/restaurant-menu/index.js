/**
 * WordJS Plugin: Restaurant Menu v2 — ISOLATED, sandboxed. "Restaurante completo".
 *
 * v1: menu sections + dishes (INTEGER CENTS, photos, diet tags) → Puck block, optional online
 * ordering with client cart (server recomputes every price) and WhatsApp handoff + order board.
 *
 * v2 adds (Plugin Completeness Program — see documentation/restaurant-menu-v2-spec.md):
 *  - Dish modifiers: reusable groups (min/max select) with priced options; per-line validation.
 *  - Opening hours (per-weekday ranges, overnight supported, IANA timezone) gating order intake.
 *  - Table QR ordering: tables with random tokens; ?rm_table= orders land straight on the board.
 *  - Native table reservations (pending → confirmed → completed…), emails both ways.
 *  - Online payment: Stripe Checkout mirroring online-store (write-only key in own settings
 *    table, session metadata token, verify-on-return leg — no webhooks in the sandbox).
 *  - Live kitchen: /kitchen board + zero-PII SSE broadcasts through the core notification bus.
 *  - Menu i18n es/en + EU-14 allergens + per-dish prep minutes (additive *_meta tables).
 *  - Reports: sales by day, top dishes, peak hours, payment/source split + CSV.
 *
 * Sandbox constraints honored:
 *  - NO ALTER TABLE: v1 tables are frozen; every v2 fact lives in a NEW prefixed table.
 *  - No transactions on the db bridge: multi-row writes are ordered so a crash leaves harmless
 *    orphans (order_meta written after orders; readers LEFT-join defensively).
 *  - Upserts are UPDATE-then-INSERT (the SQL guard rejects ON CONFLICT).
 *  - res.json for EVERY response; no globalThis; tokens come from the wordjs.crypto CSPRNG bridge.
 *  - Dialect-safe SQL only (no strftime/date functions) — report math happens in JS.
 */

exports.metadata = {
    name: 'Restaurant Menu',
    version: '2.0.0',
    description: 'Menú con modificadores, horarios, pedidos en mesa por QR, reservas, pago en línea (Stripe), cocina en vivo e informes.',
    author: 'WordJS',
};

const OPT_CONFIG = 'restaurant_menu_config';

const DEFAULT_HOURS = { 0: [['12:00', '22:00']], 1: [['12:00', '22:00']], 2: [['12:00', '22:00']], 3: [['12:00', '22:00']], 4: [['12:00', '22:00']], 5: [['12:00', '22:00']], 6: [['12:00', '22:00']] };

const DEFAULT_CONFIG = {
    currencySymbol: '$',
    currencyCode: 'usd',            // ISO 4217 lowercase — what Stripe charges in
    orderingEnabled: false,
    whatsappNumber: '',             // digits with country code, e.g. 573001234567
    deliveryCents: 0,
    pickupLabel: 'Recoger en local',
    deliveryLabel: 'Domicilio',
    notifyEmail: '',
    // v2
    timezone: '',                   // IANA, '' = server local time
    hoursEnabled: false,
    weekHours: DEFAULT_HOURS,       // {'0'..'6' (Sun..Sat): [["HH:MM","HH:MM"], …] } max 3 ranges/day
    closedMessage: '',
    prepMinutesDefault: 30,
    tableOrderingEnabled: false,
    menuPageUrl: '',                // public page hosting the menu block — QR links point here
    reservationsEnabled: false,
    reservationPartyMax: 10,
    payOnlineEnabled: false,
    i18nEnabled: false,
};

const VALID_TAGS = ['vegano', 'picante', 'sin-gluten', 'nuevo', 'popular'];
// EU-14 standard allergen keys (labels are rendered client-side in es/en).
const ALLERGENS = ['gluten', 'crustaceos', 'huevo', 'pescado', 'cacahuetes', 'soja', 'lacteos', 'frutos-secos', 'apio', 'mostaza', 'sesamo', 'sulfitos', 'altramuces', 'moluscos'];
const ORDER_STATUSES = ['new', 'preparing', 'ready', 'delivered', 'cancelled'];
const RES_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const PAY_METHODS = ['whatsapp', 'cash', 'stripe'];
const DAY_NAMES_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const MAX_ORDER_LINES = 50;
const MAX_QTY = 99;
const MAX_OPTION_IDS = 20;
const MAX_NOTE_CHARS = 200;
const MAX_NAME_CHARS = 120;
const MAX_PHONE_CHARS = 30;
const MAX_ADDRESS_CHARS = 300;
const MAX_ORDER_NOTES_CHARS = 500;
const TOKEN_RE = /^[a-z0-9]{16,64}$/;

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail, crypto, site, notify } = wordjs;

    console.log('[restaurant-menu] initializing v2…');

    // Per-plugin table namespace: 'restaurant-menu' -> 'wjp_restaurant_menu_'.
    const P = db.tablePrefix;
    const T = {
        sections: `${P}sections`,
        items: `${P}items`,
        orders: `${P}orders`,
        // v2 (additive — the sandbox has no ALTER, so v1 tables stay frozen)
        settings: `${P}settings`,
        modGroups: `${P}modifier_groups`,
        modOptions: `${P}modifier_options`,
        itemMods: `${P}item_modifier_groups`,
        itemMeta: `${P}item_meta`,
        sectionMeta: `${P}section_meta`,
        tables: `${P}tables`,
        reservations: `${P}reservations`,
        orderMeta: `${P}order_meta`,
    };

    // ---- schema (idempotent; each table's column set is final from day 1) -----------------------
    async function initSchema() {
        await db.createTable(T.sections, [
            'id INT_PK',
            'name TEXT NOT NULL',
            'sort_order INT DEFAULT 0',
            'is_active INT DEFAULT 1',
        ]);

        await db.createTable(T.items, [
            'id INT_PK',
            'section_id INT NOT NULL',
            'name TEXT NOT NULL',
            'description TEXT',
            'price_cents INT NOT NULL DEFAULT 0',
            'image_url TEXT',
            "tags TEXT DEFAULT ''",
            'is_available INT DEFAULT 1',
            'sort_order INT DEFAULT 0',
        ]);

        await db.createTable(T.orders, [
            'id INT_PK',
            'token TEXT',
            'customer_name TEXT NOT NULL',
            'customer_phone TEXT NOT NULL',
            'customer_address TEXT',
            'delivery_type TEXT',
            'items TEXT NOT NULL',
            'subtotal_cents INT',
            'delivery_cents INT DEFAULT 0',
            'total_cents INT',
            'notes TEXT',
            "status TEXT DEFAULT 'new'",
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        ]);

        // v2 tables ------------------------------------------------------------------------------
        await db.createTable(T.settings, [
            'name TEXT PRIMARY KEY',
            'value TEXT',
        ]);

        await db.createTable(T.modGroups, [
            'id INT_PK',
            'name TEXT NOT NULL',
            "name_en TEXT DEFAULT ''",
            'min_select INT DEFAULT 0',
            'max_select INT DEFAULT 1',
            'is_active INT DEFAULT 1',
            'sort_order INT DEFAULT 0',
        ]);

        await db.createTable(T.modOptions, [
            'id INT_PK',
            'group_id INT NOT NULL',
            'name TEXT NOT NULL',
            "name_en TEXT DEFAULT ''",
            'price_delta_cents INT DEFAULT 0',
            'is_available INT DEFAULT 1',
            'sort_order INT DEFAULT 0',
        ]);

        await db.createTable(T.itemMods, [
            'id INT_PK',
            'item_id INT NOT NULL',
            'group_id INT NOT NULL',
            'sort_order INT DEFAULT 0',
        ]);

        await db.createTable(T.itemMeta, [
            'id INT_PK',
            'item_id INT NOT NULL',
            "name_en TEXT DEFAULT ''",
            "description_en TEXT DEFAULT ''",
            "allergens TEXT DEFAULT ''",
            'prep_minutes INT DEFAULT 0',
        ]);

        await db.createTable(T.sectionMeta, [
            'id INT_PK',
            'section_id INT NOT NULL',
            "name_en TEXT DEFAULT ''",
        ]);

        await db.createTable(T.tables, [
            'id INT_PK',
            'label TEXT NOT NULL',
            'token TEXT NOT NULL',
            'is_active INT DEFAULT 1',
            'sort_order INT DEFAULT 0',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        ]);

        await db.createTable(T.reservations, [
            'id INT_PK',
            'token TEXT',
            'customer_name TEXT NOT NULL',
            'customer_phone TEXT NOT NULL',
            "customer_email TEXT DEFAULT ''",
            'party_size INT NOT NULL DEFAULT 2',
            'reserved_date TEXT NOT NULL',
            'reserved_time TEXT NOT NULL',
            "notes TEXT DEFAULT ''",
            "status TEXT DEFAULT 'pending'",
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        ]);

        await db.createTable(T.orderMeta, [
            'id INT_PK',
            'order_id INT NOT NULL',
            'table_id INT DEFAULT 0',
            "table_label TEXT DEFAULT ''",
            "payment_method TEXT DEFAULT 'whatsapp'",
            "payment_status TEXT DEFAULT 'none'",
            "stripe_session_id TEXT DEFAULT ''",
            'paid_at DATETIME',
            "source TEXT DEFAULT 'web'",
            'eta_minutes INT DEFAULT 0',
        ]);

        const createIndex = async (name, table, cols) => {
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) {
                // Index already exists or dialect quirk — non-fatal.
            }
        };
        await createIndex(`${P}idx_items_section`, T.items, 'section_id');
        await createIndex(`${P}idx_orders_status`, T.orders, 'status');
        await createIndex(`${P}idx_orders_token`, T.orders, 'token');
        await createIndex(`${P}idx_modopts_group`, T.modOptions, 'group_id');
        await createIndex(`${P}idx_itemmods_item`, T.itemMods, 'item_id');
        await createIndex(`${P}idx_itemmeta_item`, T.itemMeta, 'item_id');
        await createIndex(`${P}idx_secmeta_section`, T.sectionMeta, 'section_id');
        await createIndex(`${P}idx_tables_token`, T.tables, 'token');
        await createIndex(`${P}idx_res_date`, T.reservations, 'reserved_date');
        await createIndex(`${P}idx_res_token`, T.reservations, 'token');
        await createIndex(`${P}idx_ometa_order`, T.orderMeta, 'order_id');
    }

    await initSchema();

    // ---- plugin-private settings (Stripe secret key — write-only) -------------------------------
    const getSetting = async (name) => {
        const row = await db.get(`SELECT value FROM ${T.settings} WHERE name = ?`, [name]);
        return row ? row.value : '';
    };
    // Guard-safe upsert: UPDATE-then-INSERT (ON CONFLICT trips the host SQL guard). Admin-only path.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes === 0) {
            await db.run(`INSERT INTO ${T.settings} (name, value) VALUES (?, ?)`, [name, v]);
        }
    };

    // ---- config helpers --------------------------------------------------------------------------
    const HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

    function cleanWeekHours(input) {
        const out = {};
        for (let d = 0; d <= 6; d++) {
            const key = String(d);
            const src = input && Array.isArray(input[key]) ? input[key] : [];
            const ranges = [];
            for (const r of src.slice(0, 3)) {
                if (!Array.isArray(r) || r.length < 2) continue;
                const o = String(r[0] || '').trim();
                const c = String(r[1] || '').trim();
                if (!HM_RE.test(o) || !HM_RE.test(c) || o === c) continue; // zero-length = ignored
                ranges.push([o.padStart(5, '0'), c.padStart(5, '0')]);
            }
            // Sorted by opening time — nextOpenText scans ranges in order and would otherwise
            // announce the wrong "next opening" for out-of-order admin input.
            ranges.sort((a, b) => (hmToMin(a[0]) || 0) - (hmToMin(b[0]) || 0));
            out[key] = ranges;
        }
        return out;
    }

    async function getConfig() {
        const stored = (await options.get(OPT_CONFIG, null)) || {};
        const cfg = { ...DEFAULT_CONFIG, ...stored };
        cfg.weekHours = cleanWeekHours(cfg.weekHours && typeof cfg.weekHours === 'object' ? cfg.weekHours : DEFAULT_HOURS);
        return cfg;
    }

    // ---- time / opening-hours helpers ------------------------------------------------------------

    function hmToMin(hm) {
        // String.match (not RegExp.exec) — the host AST scanner blocks `exec` on non-literals.
        const m = String(hm || '').match(HM_RE);
        if (!m) return null;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    /** Weekday (0=Sun) + minutes-of-day + local YYYY-MM-DD for a Date in the restaurant timezone. */
    function tzParts(date, tz) {
        try {
            const fmt = new Intl.DateTimeFormat('en-GB', {
                timeZone: tz || undefined, hourCycle: 'h23',
                weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit',
            });
            const parts = {};
            for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
            const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
            return {
                weekday: wd === undefined ? date.getDay() : wd,
                minutes: (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10),
                date: `${parts.year}-${parts.month}-${parts.day}`,
                hour: parseInt(parts.hour, 10) % 24,
            };
        } catch (e) {
            // Bad/unsupported timezone — fall back to server-local time.
            const pad = (n) => String(n).padStart(2, '0');
            return {
                weekday: date.getDay(),
                minutes: date.getHours() * 60 + date.getMinutes(),
                date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
                hour: date.getHours(),
            };
        }
    }

    /** Is a minutes-of-day inside a day's ranges? Overnight ranges (close < open) spill past midnight. */
    function minutesInRanges(minutes, ranges, spillover) {
        for (const r of ranges || []) {
            const o = hmToMin(r[0]);
            const c = hmToMin(r[1]);
            if (o === null || c === null) continue;
            if (!spillover) {
                if (c > o && minutes >= o && minutes < c) return true;
                if (c < o && minutes >= o) return true; // overnight — before midnight leg
            } else if (c < o && minutes < c) {
                return true; // previous day's overnight — after midnight leg
            }
        }
        return false;
    }

    function isOpenNow(cfg) {
        if (!cfg.hoursEnabled) return true;
        const now = tzParts(new Date(), cfg.timezone);
        return minutesInRanges(now.minutes, cfg.weekHours[String(now.weekday)], false)
            || minutesInRanges(now.minutes, cfg.weekHours[String((now.weekday + 6) % 7)], true);
    }

    /** "Abrimos hoy a las 18:00" / "Abrimos el viernes a las 12:00" / '' when no hours at all. */
    function nextOpenText(cfg) {
        if (!cfg.hoursEnabled) return '';
        const now = tzParts(new Date(), cfg.timezone);
        for (let ahead = 0; ahead <= 7; ahead++) {
            const day = (now.weekday + ahead) % 7;
            const ranges = cfg.weekHours[String(day)] || [];
            for (const r of ranges) {
                const o = hmToMin(r[0]);
                if (o === null) continue;
                if (ahead === 0 && o <= now.minutes) continue; // already past today
                return ahead === 0
                    ? `Abrimos hoy a las ${r[0]}`
                    : ahead === 1 ? `Abrimos mañana a las ${r[0]}` : `Abrimos el ${DAY_NAMES_ES[day]} a las ${r[0]}`;
            }
        }
        return '';
    }

    /** Whether a HH:MM on a calendar date (YYYY-MM-DD) falls inside that weekday's ranges. */
    function timeInsideHours(cfg, dateStr, timeStr) {
        if (!cfg.hoursEnabled) return true;
        const d = new Date(`${dateStr}T00:00:00Z`);
        if (isNaN(d.getTime())) return false;
        const weekday = d.getUTCDay(); // calendar weekday of that date
        const minutes = hmToMin(timeStr);
        if (minutes === null) return false;
        return minutesInRanges(minutes, cfg.weekHours[String(weekday)], false)
            || minutesInRanges(minutes, cfg.weekHours[String((weekday + 6) % 7)], true);
    }

    // ---- misc helpers ----------------------------------------------------------------------------

    /** Random lowercase-hex token via the host CSPRNG bridge (v1's Math.random is retired).
     *  ASYNC: in the isolate crypto.randomToken is an RPC — forgetting the await would hand a
     *  Promise to the SQL layer and wedge the worker. */
    async function genToken() {
        return await crypto.randomToken(16); // 32 hex chars — matches TOKEN_RE
    }

    /** 'YYYY-MM-DD HH:MM:SS' in UTC — written explicitly on INSERT/UPDATE instead of relying on
     *  CURRENT_TIMESTAMP, whose timezone is server-local on MySQL (UTC math would drift). */
    function nowUtcSql() {
        return new Date().toISOString().slice(0, 19).replace('T', ' ');
    }

    /** Normalize a tags value (array or comma string) to a clean comma string of known tags. */
    function cleanTags(input) {
        const list = Array.isArray(input) ? input : String(input || '').split(',');
        const seen = [];
        for (const raw of list) {
            const t = String(raw || '').trim().toLowerCase();
            if (VALID_TAGS.includes(t) && !seen.includes(t)) seen.push(t);
        }
        return seen.join(',');
    }

    /** Normalize an allergens value to a clean comma string of EU-14 keys. */
    function cleanAllergens(input) {
        const list = Array.isArray(input) ? input : String(input || '').split(',');
        const seen = [];
        for (const raw of list) {
            const a = String(raw || '').trim().toLowerCase();
            if (ALLERGENS.includes(a) && !seen.includes(a)) seen.push(a);
        }
        return seen.join(',');
    }

    /** Money formatting for the WhatsApp/mail text (client formats its own UI). */
    function fmtMoney(cents, symbol) {
        return `${symbol}${(Math.round(cents) / 100).toFixed(2)}`;
    }

    /** Non-negative integer cents from arbitrary input, or null when invalid. */
    function toCents(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        const c = Math.round(n);
        if (c < 0 || c > 100000000) return null; // cap at 1,000,000.00 — sanity bound
        return c;
    }

    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** created_at values arrive as strings (SQLite 'YYYY-MM-DD HH:MM:SS' UTC) or Dates (MySQL/PG). */
    function parseCreatedAt(v) {
        if (v instanceof Date) return v;
        const s = String(v || '');
        const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
        return isNaN(d.getTime()) ? new Date() : d;
    }

    // Named rolling-window rate limits (no req.ip in the isolate — global caps per endpoint).
    const rlBuckets = new Map();
    function rateLimited(name, max, windowMs) {
        const now = Date.now();
        let arr = rlBuckets.get(name) || [];
        arr = arr.filter((t) => now - t < windowMs);
        if (arr.length >= max) {
            rlBuckets.set(name, arr);
            return true;
        }
        arr.push(now);
        rlBuckets.set(name, arr);
        return false;
    }

    /** Zero-data broadcast on the core SSE bus — the kitchen tab listens and re-fetches. The frame
     *  reaches EVERY logged-in SSE client (user_id 0 fans out site-wide), so it carries no order
     *  ids, amounts, dates or names — just "something changed". */
    async function ssePing(type, message) {
        try {
            await notify({
                user_id: 0, type, title: 'Restaurante', message,
                icon: 'fa-utensils', transports: ['sse'], data: { plugin: 'restaurant-menu' },
            });
        } catch (e) {
            // notifications:send not granted or bus down — real-time is optional, polling covers it.
        }
    }

    /** Swap-based reorder for admin lists: renumber all rows, then swap the moved one. */
    async function moveRow(table, whereSql, whereParams, id, dir) {
        const rows = await db.all(
            `SELECT id FROM ${table} ${whereSql} ORDER BY sort_order ASC, id ASC`,
            whereParams
        );
        const ids = rows.map((r) => r.id);
        const idx = ids.indexOf(id);
        if (idx === -1) return false;
        const target = dir === 'up' ? idx - 1 : idx + 1;
        if (target < 0 || target >= ids.length) return false;
        const tmp = ids[idx];
        ids[idx] = ids[target];
        ids[target] = tmp;
        for (let i = 0; i < ids.length; i++) {
            await db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [i, ids[i]]);
        }
        return true;
    }

    /** SELECT … WHERE col IN (ids) — returns [] for an empty id list without touching the DB. */
    async function fetchIn(table, col, ids, extraSql) {
        if (!ids.length) return [];
        const ph = ids.map(() => '?').join(',');
        return db.all(`SELECT * FROM ${table} WHERE ${col} IN (${ph})${extraSql || ''}`, ids);
    }

    /** Upsert one meta row keyed by a column (UPDATE-then-INSERT — no ON CONFLICT in the sandbox). */
    async function upsertByKey(table, keyCol, keyVal, fields) {
        const cols = Object.keys(fields);
        if (!cols.length) return;
        const sets = cols.map((c) => `${c} = ?`).join(', ');
        const r = await db.run(
            `UPDATE ${table} SET ${sets} WHERE ${keyCol} = ?`,
            [...cols.map((c) => fields[c]), keyVal]
        );
        if (!r || r.changes === 0) {
            await db.run(
                `INSERT INTO ${table} (${keyCol}, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)})`,
                [keyVal, ...cols.map((c) => fields[c])]
            );
        }
    }

    // ================================================================================================
    // MENU DATA ASSEMBLY (shared by /public/menu and /admin/menu)
    // ================================================================================================

    /** Load modifier groups (+options) attached per item. Returns { byItem: Map<itemId, group[]> }. */
    async function loadModifiers(onlyActive) {
        const attach = await db.all(`SELECT item_id, group_id, sort_order, id FROM ${T.itemMods} ORDER BY sort_order ASC, id ASC`);
        const groups = await db.all(`SELECT * FROM ${T.modGroups}${onlyActive ? ' WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`);
        const opts = await db.all(`SELECT * FROM ${T.modOptions}${onlyActive ? ' WHERE is_available = 1' : ''} ORDER BY sort_order ASC, id ASC`);
        const optsByGroup = new Map();
        for (const o of opts) {
            if (!optsByGroup.has(o.group_id)) optsByGroup.set(o.group_id, []);
            optsByGroup.get(o.group_id).push(o);
        }
        const groupById = new Map(groups.map((g) => [g.id, g]));
        const byItem = new Map();
        for (const a of attach) {
            const g = groupById.get(a.group_id);
            if (!g) continue;
            if (!byItem.has(a.item_id)) byItem.set(a.item_id, []);
            byItem.get(a.item_id).push({ group: g, options: optsByGroup.get(g.id) || [] });
        }
        return { byItem, groups, optsByGroup };
    }

    async function loadMetaMaps() {
        const itemMetas = await db.all(`SELECT * FROM ${T.itemMeta}`);
        const sectionMetas = await db.all(`SELECT * FROM ${T.sectionMeta}`);
        return {
            itemMeta: new Map(itemMetas.map((m) => [m.item_id, m])),
            sectionMeta: new Map(sectionMetas.map((m) => [m.section_id, m])),
        };
    }

    // ================================================================================================
    // PUBLIC ROUTES (consumed by the Puck block from the editor iframe AND the public page)
    // ================================================================================================

    // Active sections in order, items with tags/allergens/prep + orderable modifiers. ?lang=en swaps
    // in the EN name/description where a translation exists (menu i18n).
    http.route('get', '/public/menu', async (req, res) => {
        try {
            const cfg = await getConfig();
            const lang = String((req.query && req.query.lang) || 'es') === 'en' && cfg.i18nEnabled ? 'en' : 'es';
            const sections = await db.all(
                `SELECT id, name FROM ${T.sections} WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
            );
            const items = await db.all(
                `SELECT id, section_id, name, description, price_cents, image_url, tags
                 FROM ${T.items} WHERE is_available = 1 ORDER BY sort_order ASC, id ASC`
            );
            const { byItem } = await loadModifiers(true);
            const meta = await loadMetaMaps();

            const trans = (base, en) => (lang === 'en' && en ? en : base);
            const bySection = new Map();
            for (const s of sections) {
                const sm = meta.sectionMeta.get(s.id);
                bySection.set(s.id, { id: s.id, name: trans(s.name, sm && sm.name_en), items: [] });
            }
            for (const it of items) {
                const bucket = bySection.get(it.section_id);
                if (!bucket) continue;
                const im = meta.itemMeta.get(it.id);
                const mods = (byItem.get(it.id) || []).map(({ group, options }) => ({
                    id: group.id,
                    name: trans(group.name, group.name_en),
                    min_select: group.min_select,
                    max_select: group.max_select,
                    options: options.map((o) => ({
                        id: o.id,
                        name: trans(o.name, o.name_en),
                        price_delta_cents: o.price_delta_cents,
                    })),
                })).filter((g) => g.options.length > 0);
                bucket.items.push({
                    id: it.id,
                    name: trans(it.name, im && im.name_en),
                    description: trans(it.description || '', im && im.description_en) || '',
                    price_cents: it.price_cents,
                    image_url: it.image_url || '',
                    tags: String(it.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
                    allergens: String((im && im.allergens) || '').split(',').map((a) => a.trim()).filter(Boolean),
                    prep_minutes: (im && im.prep_minutes) || 0,
                    modifiers: mods,
                });
            }
            res.json({ sections: Array.from(bySection.values()), lang });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cargar el menú.' });
        }
    });

    // Public slice of the config — only what the block needs to render/order/reserve/pay.
    http.route('get', '/public/config', async (req, res) => {
        try {
            const cfg = await getConfig();
            const open = isOpenNow(cfg);
            const hasStripe = cfg.payOnlineEnabled ? !!(await getSetting('stripe_sk')) : false;
            res.json({
                currencySymbol: cfg.currencySymbol,
                currencyCode: cfg.currencyCode,
                orderingEnabled: !!cfg.orderingEnabled,
                whatsappNumber: cfg.whatsappNumber,
                deliveryCents: cfg.deliveryCents,
                pickupLabel: cfg.pickupLabel,
                deliveryLabel: cfg.deliveryLabel,
                hoursEnabled: !!cfg.hoursEnabled,
                isOpen: open,
                weekHours: cfg.weekHours,
                timezone: cfg.timezone,
                closedMessage: cfg.closedMessage || (open ? '' : `En este momento estamos cerrados. ${nextOpenText(cfg)}`.trim()),
                nextOpen: open ? '' : nextOpenText(cfg),
                prepMinutesDefault: cfg.prepMinutesDefault,
                tableOrderingEnabled: !!cfg.tableOrderingEnabled,
                reservationsEnabled: !!cfg.reservationsEnabled,
                reservationPartyMax: cfg.reservationPartyMax,
                payOnline: hasStripe,
                i18nEnabled: !!cfg.i18nEnabled,
            });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cargar la configuración.' });
        }
    });

    // Table lookup for QR mode — label only, valid active tokens only.
    http.route('get', '/public/table', async (req, res) => {
        try {
            if (rateLimited('table-lookup', 60, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiadas consultas.' });
            }
            const cfg = await getConfig();
            if (!cfg.tableOrderingEnabled) return res.status(404).json({ error: 'Pedidos en mesa no habilitados.' });
            const token = String((req.query && req.query.token) || '').trim();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Mesa no válida.' });
            const t = await db.get(`SELECT label FROM ${T.tables} WHERE token = ? AND is_active = 1`, [token]);
            if (!t) return res.status(404).json({ error: 'Mesa no encontrada.' });
            res.json({ table: { label: t.label } });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo validar la mesa.' });
        }
    });

    // Create an order. The client sends item ids + qty + option ids ONLY — prices, deltas, subtotal,
    // delivery fee and total are all recomputed server-side from the DB and the stored config.
    http.route('post', '/public/order', async (req, res) => {
        try {
            const cfg = await getConfig();
            if (!cfg.orderingEnabled) {
                return res.status(403).json({ error: 'Los pedidos en línea no están habilitados.' });
            }
            if (cfg.hoursEnabled && !isOpenNow(cfg)) {
                return res.status(403).json({
                    error: cfg.closedMessage || `En este momento estamos cerrados. ${nextOpenText(cfg)}`.trim(),
                    closed: true,
                });
            }
            const body = req.body || {};
            const customerName = String(body.customer_name || '').trim();
            const customerPhone = String(body.customer_phone || '').trim();
            const customerAddress = String(body.customer_address || '').trim();
            const orderNotes = String(body.notes || '').trim();

            // --- table mode: a valid table token replaces the delivery legs entirely -------------
            let tableRow = null;
            const tableToken = String(body.table_token || '').trim();
            if (tableToken) {
                if (!cfg.tableOrderingEnabled) {
                    return res.status(400).json({ error: 'Los pedidos en mesa no están habilitados.' });
                }
                if (!TOKEN_RE.test(tableToken)) return res.status(400).json({ error: 'Mesa no válida.' });
                tableRow = await db.get(`SELECT id, label FROM ${T.tables} WHERE token = ? AND is_active = 1`, [tableToken]);
                if (!tableRow) return res.status(400).json({ error: 'Mesa no válida. Escanea de nuevo el código QR.' });
            }
            const deliveryType = tableRow ? 'table' : String(body.delivery_type || '').trim();

            if (!customerName || customerName.length > MAX_NAME_CHARS) {
                return res.status(400).json({ error: 'El nombre es obligatorio (máx. 120 caracteres).' });
            }
            if (!tableRow) {
                if (!customerPhone || customerPhone.length > MAX_PHONE_CHARS || !/^[+\d\s()-]+$/.test(customerPhone)) {
                    return res.status(400).json({ error: 'El teléfono es obligatorio y debe ser válido.' });
                }
                if (deliveryType !== 'pickup' && deliveryType !== 'delivery') {
                    return res.status(400).json({ error: 'Tipo de entrega inválido.' });
                }
                if (deliveryType === 'delivery' && !customerAddress) {
                    return res.status(400).json({ error: 'La dirección es obligatoria para domicilio.' });
                }
            } else if (customerPhone && (customerPhone.length > MAX_PHONE_CHARS || !/^[+\d\s()-]+$/.test(customerPhone))) {
                return res.status(400).json({ error: 'El teléfono no es válido.' });
            }
            if (customerAddress.length > MAX_ADDRESS_CHARS) {
                return res.status(400).json({ error: 'La dirección es demasiado larga.' });
            }
            if (orderNotes.length > MAX_ORDER_NOTES_CHARS) {
                return res.status(400).json({ error: 'Las notas son demasiado largas.' });
            }

            const rawItems = Array.isArray(body.items) ? body.items : [];
            if (rawItems.length === 0) {
                return res.status(400).json({ error: 'El pedido está vacío.' });
            }
            if (rawItems.length > MAX_ORDER_LINES) {
                return res.status(400).json({ error: 'Demasiados productos en el pedido.' });
            }

            // Merge duplicate lines (same dish + same option set) and validate shapes BEFORE the DB.
            const merged = new Map(); // mergeKey -> { itemId, qty, note, optionIds }
            for (const line of rawItems) {
                const itemId = parseInt(line && line.item_id, 10);
                const qty = parseInt(line && line.qty, 10);
                if (!Number.isInteger(itemId) || itemId <= 0) {
                    return res.status(400).json({ error: 'Producto inválido en el pedido.' });
                }
                if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
                    return res.status(400).json({ error: 'Cantidad inválida en el pedido (1–99).' });
                }
                const rawOpts = Array.isArray(line && line.option_ids) ? line.option_ids : [];
                if (rawOpts.length > MAX_OPTION_IDS) {
                    return res.status(400).json({ error: 'Demasiadas opciones en un producto.' });
                }
                const optionIds = [];
                for (const ro of rawOpts) {
                    const oid = parseInt(ro, 10);
                    if (!Number.isInteger(oid) || oid <= 0) {
                        return res.status(400).json({ error: 'Opción inválida en el pedido.' });
                    }
                    if (!optionIds.includes(oid)) optionIds.push(oid);
                }
                optionIds.sort((a, b) => a - b);
                const note = String((line && line.note) || '').trim().slice(0, MAX_NOTE_CHARS);
                const key = `${itemId}:${optionIds.join('.')}`;
                const prev = merged.get(key);
                if (prev) {
                    prev.qty = Math.min(MAX_QTY, prev.qty + qty);
                    if (note) prev.note = prev.note ? `${prev.note}; ${note}`.slice(0, MAX_NOTE_CHARS) : note;
                } else {
                    merged.set(key, { itemId, qty, note, optionIds });
                }
            }
            if (merged.size > MAX_ORDER_LINES) {
                return res.status(400).json({ error: 'Demasiados productos en el pedido.' });
            }

            // Re-read prices + validate modifiers from the DB; only orderable rows count.
            const { byItem } = await loadModifiers(true);
            const snapshot = [];
            let subtotalCents = 0;
            let maxPrep = 0;
            const metaMaps = await loadMetaMaps();
            for (const line of merged.values()) {
                const row = await db.get(
                    `SELECT i.id, i.name, i.price_cents
                     FROM ${T.items} i
                     JOIN ${T.sections} s ON s.id = i.section_id
                     WHERE i.id = ? AND i.is_available = 1 AND s.is_active = 1`,
                    [line.itemId]
                );
                if (!row) {
                    return res.status(400).json({ error: 'Un producto del pedido ya no está disponible. Actualiza la página.' });
                }

                // Modifier validation: every option must belong to a group attached to THIS item,
                // and each group's picked count must respect its min/max.
                const groups = byItem.get(row.id) || [];
                const pickedByGroup = new Map();
                const chosen = [];
                for (const oid of line.optionIds) {
                    let found = null;
                    let foundGroup = null;
                    for (const { group, options } of groups) {
                        const o = options.find((x) => x.id === oid);
                        if (o) { found = o; foundGroup = group; break; }
                    }
                    if (!found) {
                        return res.status(400).json({ error: `Una opción de "${row.name}" ya no está disponible. Actualiza la página.` });
                    }
                    pickedByGroup.set(foundGroup.id, (pickedByGroup.get(foundGroup.id) || 0) + 1);
                    chosen.push({ id: found.id, name: found.name, price_delta_cents: found.price_delta_cents });
                }
                for (const { group, options } of groups) {
                    // A group with zero available options is hidden from the public menu — enforcing
                    // its minimum here would make the dish silently un-orderable.
                    if (options.length === 0) continue;
                    const n = pickedByGroup.get(group.id) || 0;
                    const min = Math.max(0, group.min_select | 0);
                    const max = Math.max(min, group.max_select | 0);
                    if (n < min) {
                        return res.status(400).json({ error: `"${row.name}": elige al menos ${min} en "${group.name}".` });
                    }
                    if (n > max) {
                        return res.status(400).json({ error: `"${row.name}": máximo ${max} en "${group.name}".` });
                    }
                }

                const unitCents = row.price_cents + chosen.reduce((s, o) => s + (o.price_delta_cents | 0), 0);
                if (unitCents < 0) {
                    return res.status(400).json({ error: 'Precio inválido en el pedido.' });
                }
                const im = metaMaps.itemMeta.get(row.id);
                if (im && im.prep_minutes > maxPrep) maxPrep = im.prep_minutes;
                snapshot.push({
                    item_id: row.id,
                    name: row.name,
                    price_cents: row.price_cents,
                    options: chosen,
                    unit_cents: unitCents,
                    qty: line.qty,
                    note: line.note,
                    line_cents: unitCents * line.qty,
                });
                subtotalCents += unitCents * line.qty;
            }

            const deliveryCents = deliveryType === 'delivery' ? (toCents(cfg.deliveryCents) || 0) : 0;
            const totalCents = subtotalCents + deliveryCents;
            // Consume the (global — no req.ip in the isolate) rate budget only for orders that passed
            // validation, so garbage POSTs can't starve real customers; sized for a busy lunch rush.
            if (rateLimited('order', 30, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiados pedidos en este momento. Intenta de nuevo en un minuto.' });
            }

            const prepDefault = Number.isInteger(cfg.prepMinutesDefault) ? Math.min(600, Math.max(0, cfg.prepMinutesDefault)) : 30;
            const etaMinutes = Math.max(maxPrep, prepDefault); // an explicit 0 means "no ETA shown"
            const token = await genToken();

            // Payment method: stripe only when enabled + key present; table orders default to cash.
            const stripeKey = cfg.payOnlineEnabled ? await getSetting('stripe_sk') : '';
            const wantsStripe = String(body.payment_method || '') === 'stripe';
            const defaultMethod = tableRow ? 'cash' : 'whatsapp';
            let method = (wantsStripe && stripeKey) ? 'stripe' : defaultMethod;

            await db.run(
                `INSERT INTO ${T.orders}
                    (token, customer_name, customer_phone, customer_address, delivery_type, items,
                     subtotal_cents, delivery_cents, total_cents, notes, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
                [
                    token, customerName, customerPhone || '',
                    deliveryType === 'delivery' ? customerAddress : '',
                    deliveryType, JSON.stringify(snapshot),
                    subtotalCents, deliveryCents, totalCents, orderNotes,
                    nowUtcSql(), // explicit UTC — CURRENT_TIMESTAMP is server-local on MySQL
                ]
            );
            const inserted = await db.get(`SELECT id FROM ${T.orders} WHERE token = ?`, [token]);
            const orderId = inserted ? inserted.id : 0;

            // v2 order facts (no transactions — written right after; readers LEFT-join defensively).
            await db.run(
                `INSERT INTO ${T.orderMeta}
                    (order_id, table_id, table_label, payment_method, payment_status, stripe_session_id, source, eta_minutes)
                 VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
                [
                    orderId,
                    tableRow ? tableRow.id : 0,
                    tableRow ? tableRow.label : '',
                    method,
                    method === 'stripe' ? 'pending' : 'none',
                    tableRow ? 'table' : 'web',
                    etaMinutes,
                ]
            );

            // Prebuilt WhatsApp summary — the client opens wa.me with this text URL-encoded.
            const sym = String(cfg.currencySymbol || '$');
            const typeLabel = tableRow
                ? `Mesa: ${tableRow.label}`
                : deliveryType === 'delivery'
                    ? `${cfg.deliveryLabel || 'Domicilio'}: ${customerAddress}`
                    : (cfg.pickupLabel || 'Recoger en local');
            const lines = [];
            lines.push('🍽️ *Nuevo pedido*');
            lines.push(`👤 ${customerName}`);
            if (customerPhone) lines.push(`📞 ${customerPhone}`);
            lines.push(`📍 ${typeLabel}`);
            lines.push('──────────');
            for (const it of snapshot) {
                lines.push(`${it.qty}x ${it.name} — ${fmtMoney(it.line_cents, sym)}`);
                for (const o of it.options) {
                    lines.push(`   • ${o.name}${o.price_delta_cents ? ` (+${fmtMoney(o.price_delta_cents, sym)})` : ''}`);
                }
                if (it.note) lines.push(`   ▸ ${it.note}`);
            }
            lines.push('──────────');
            lines.push(`Subtotal: ${fmtMoney(subtotalCents, sym)}`);
            if (deliveryCents > 0) lines.push(`Envío: ${fmtMoney(deliveryCents, sym)}`);
            lines.push(`*TOTAL: ${fmtMoney(totalCents, sym)}*`);
            if (method === 'stripe') lines.push('💳 Pago en línea: pendiente');
            if (orderNotes) lines.push(`📝 Notas: ${orderNotes}`);
            lines.push(`Ref: ${token}`);
            const waText = lines.join('\n');

            // Stripe leg — mirror online-store: Checkout Session with the order token in metadata;
            // on ANY failure the order survives as a cash/whatsapp order (never lost).
            let checkoutUrl = '';
            let warning = '';
            if (method === 'stripe') {
                try {
                    let pageUrl = String(body.page_url || '').trim().slice(0, 1000);
                    if (!/^https?:\/\//i.test(pageUrl)) pageUrl = await site.url();
                    const sep = pageUrl.includes('?') ? '&' : '?';
                    const form = new URLSearchParams();
                    form.set('mode', 'payment');
                    form.set('line_items[0][price_data][currency]', cfg.currencyCode);
                    form.set('line_items[0][price_data][product_data][name]', `Pedido restaurante #${orderId}`);
                    form.set('line_items[0][price_data][unit_amount]', String(totalCents));
                    form.set('line_items[0][quantity]', '1');
                    form.set('success_url', `${pageUrl}${sep}rm_order=${token}&rm_session={CHECKOUT_SESSION_ID}`);
                    form.set('cancel_url', pageUrl);
                    form.set('metadata[rm_token]', token);
                    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
                        method: 'POST',
                        headers: {
                            Authorization: 'Bearer ' + stripeKey,
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: form.toString(),
                    });
                    const session = await resp.json().catch(() => ({}));
                    if (!resp.ok || !session.url) {
                        const msg = (session && session.error && session.error.message) ? session.error.message : `HTTP ${resp.status}`;
                        throw new Error(msg);
                    }
                    await db.run(
                        `UPDATE ${T.orderMeta} SET stripe_session_id = ? WHERE order_id = ?`,
                        [String(session.id || ''), orderId]
                    );
                    checkoutUrl = String(session.url);
                } catch (e) {
                    method = defaultMethod;
                    warning = `No se pudo iniciar el pago con tarjeta (${e.message || e}). Tu pedido quedó registrado para pagar ${tableRow ? 'en la mesa' : 'al recibir'}.`;
                    try {
                        await db.run(
                            `UPDATE ${T.orderMeta} SET payment_method = ?, payment_status = 'none' WHERE order_id = ?`,
                            [method, orderId]
                        );
                    } catch (e2) { /* keep going */ }
                }
            }

            // Optional email notification — the order exists regardless of mail success.
            let mailNote = '';
            if (cfg.notifyEmail) {
                try {
                    await mail({
                        to: cfg.notifyEmail,
                        subject: `Nuevo pedido de ${customerName} — ${fmtMoney(totalCents, sym)}`,
                        text: waText.replace(/\*/g, ''),
                        html: `<pre style="font-family:inherit;white-space:pre-wrap">${escHtml(waText).replace(/\*/g, '')}</pre>`,
                    });
                } catch (e) {
                    mailNote = 'correo no enviado';
                    console.warn('[restaurant-menu] order mail failed:', e.message);
                }
            }

            // Kitchen live tick (zero PII — the board re-fetches details itself).
            await ssePing('restaurant_order', 'Nuevo pedido en cocina');

            // Public response carries the random token only — never the sequential order id.
            res.json({
                success: true,
                token,
                waText: method === 'stripe' ? '' : waText,
                checkoutUrl,
                warning,
                mailNote,
                etaMinutes,
                paymentMethod: method,
                table: tableRow ? tableRow.label : '',
            });
        } catch (e) {
            console.error('[restaurant-menu] order failed:', e.message);
            res.status(500).json({ error: 'No se pudo registrar el pedido. Intenta de nuevo.' });
        }
    });

    // Stripe return leg: verify the session AGAINST STRIPE with the secret key (no webhooks —
    // signatures can't be verified in the sandbox). Idempotent.
    http.route('get', '/public/confirm-stripe', async (req, res) => {
        try {
            if (rateLimited('confirm-stripe', 30, 60 * 1000)) {
                return res.status(429).json({ paid: false, error: 'Demasiadas solicitudes, intenta en un minuto.' });
            }
            const q = req.query || {};
            const token = String(q.token || '').trim();
            const sessionId = String(q.session_id || '').trim().slice(0, 255);
            if (!TOKEN_RE.test(token) || !sessionId) return res.status(400).json({ paid: false, error: 'Parámetros no válidos.' });
            const o = await db.get(`SELECT id, status FROM ${T.orders} WHERE token = ?`, [token]);
            if (!o) return res.status(404).json({ paid: false, error: 'Pedido no encontrado.' });
            const m = await db.get(`SELECT * FROM ${T.orderMeta} WHERE order_id = ?`, [o.id]);
            if (!m) return res.json({ paid: false });
            if (m.payment_status === 'paid') return res.json({ paid: true }); // idempotent
            if (m.payment_method !== 'stripe' || !m.stripe_session_id || m.stripe_session_id !== sessionId) {
                return res.json({ paid: false });
            }
            const key = await getSetting('stripe_sk');
            if (!key) return res.json({ paid: false, error: 'Stripe no está configurado.' });
            const resp = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
                headers: { Authorization: 'Bearer ' + key },
            });
            const session = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                const msg = (session && session.error && session.error.message) ? session.error.message : `HTTP ${resp.status}`;
                return res.status(502).json({ paid: false, error: `No se pudo verificar el pago: ${msg}` });
            }
            const metaToken = session && session.metadata && session.metadata.rm_token;
            if (metaToken === token && session.payment_status === 'paid' && o.status !== 'cancelled') {
                await db.run(
                    `UPDATE ${T.orderMeta} SET payment_status = 'paid', paid_at = ? WHERE order_id = ?`,
                    [nowUtcSql(), o.id]
                );
                await ssePing('restaurant_order', 'Pago en línea confirmado');
                return res.json({ paid: true });
            }
            return res.json({ paid: false });
        } catch (e) {
            return res.status(502).json({ paid: false, error: `No se pudo verificar el pago con Stripe: ${e.message || e}` });
        }
    });

    // Customer-facing order progress by random token (table mode shows live status).
    http.route('get', '/public/order-status', async (req, res) => {
        try {
            if (rateLimited('order-status', 60, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiadas consultas, intenta en un minuto.' });
            }
            const token = String((req.query && req.query.token) || '').trim();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Referencia no válida.' });
            const o = await db.get(`SELECT * FROM ${T.orders} WHERE token = ?`, [token]);
            if (!o) return res.status(404).json({ error: 'Pedido no encontrado.' });
            const m = await db.get(`SELECT * FROM ${T.orderMeta} WHERE order_id = ?`, [o.id]);
            let items = [];
            try { items = JSON.parse(o.items); } catch (e) { items = []; }
            res.json({
                status: o.status,
                created_at: o.created_at,
                delivery_type: o.delivery_type,
                items: items.map((it) => ({ name: it.name, qty: it.qty, options: (it.options || []).map((x) => x.name) })),
                subtotal_cents: o.subtotal_cents,
                delivery_cents: o.delivery_cents,
                total_cents: o.total_cents,
                payment_method: m ? m.payment_method : 'whatsapp',
                payment_status: m ? m.payment_status : 'none',
                table_label: m ? m.table_label : '',
                eta_minutes: m ? m.eta_minutes : 0,
            });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo consultar el pedido.' });
        }
    });

    // Create a reservation (native — no bookings-plugin dependency).
    http.route('post', '/public/reservation', async (req, res) => {
        try {
            const cfg = await getConfig();
            if (!cfg.reservationsEnabled) {
                return res.status(403).json({ error: 'Las reservas en línea no están habilitadas.' });
            }
            const body = req.body || {};
            const name = String(body.customer_name || '').trim();
            const phone = String(body.customer_phone || '').trim();
            const email = String(body.customer_email || '').trim();
            const notes = String(body.notes || '').trim();
            const dateStr = String(body.date || '').trim();
            const timeStr = String(body.time || '').trim();
            const party = parseInt(body.party_size, 10);

            if (!name || name.length > MAX_NAME_CHARS) {
                return res.status(400).json({ error: 'El nombre es obligatorio (máx. 120 caracteres).' });
            }
            if (!phone || phone.length > MAX_PHONE_CHARS || !/^[+\d\s()-]+$/.test(phone)) {
                return res.status(400).json({ error: 'El teléfono es obligatorio y debe ser válido.' });
            }
            if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
                return res.status(400).json({ error: 'El email no es válido.' });
            }
            if (notes.length > MAX_ORDER_NOTES_CHARS) {
                return res.status(400).json({ error: 'Las notas son demasiado largas.' });
            }
            const maxParty = Math.max(1, parseInt(cfg.reservationPartyMax, 10) || 10);
            if (!Number.isInteger(party) || party < 1 || party > maxParty) {
                return res.status(400).json({ error: `Número de personas inválido (1–${maxParty}).` });
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(new Date(`${dateStr}T00:00:00Z`).getTime())) {
                return res.status(400).json({ error: 'Fecha inválida.' });
            }
            if (!HM_RE.test(timeStr)) {
                return res.status(400).json({ error: 'Hora inválida.' });
            }
            const today = tzParts(new Date(), cfg.timezone);
            if (dateStr < today.date || (dateStr === today.date && hmToMin(timeStr) <= today.minutes)) {
                return res.status(400).json({ error: 'La fecha y hora deben ser futuras.' });
            }
            const horizon = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
            if (dateStr > tzParts(horizon, cfg.timezone).date) {
                return res.status(400).json({ error: 'La fecha está demasiado lejos (máx. 180 días).' });
            }
            if (!timeInsideHours(cfg, dateStr, timeStr)) {
                return res.status(400).json({ error: 'Esa hora está fuera de nuestro horario de atención.' });
            }
            // Consumed post-validation so invalid spam can't starve real bookings (global bucket).
            if (rateLimited('reservation', 15, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiadas reservas en este momento. Intenta en un minuto.' });
            }

            const token = await genToken();
            await db.run(
                `INSERT INTO ${T.reservations}
                    (token, customer_name, customer_phone, customer_email, party_size, reserved_date, reserved_time, notes, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                [token, name, phone, email, party, dateStr, timeStr, notes, nowUtcSql()]
            );

            if (cfg.notifyEmail) {
                try {
                    const txt = `Nueva reserva\n${name} — ${phone}${email ? ` — ${email}` : ''}\n${dateStr} ${timeStr} · ${party} personas${notes ? `\nNotas: ${notes}` : ''}\nRef: ${token}`;
                    await mail({
                        to: cfg.notifyEmail,
                        subject: `Nueva reserva: ${dateStr} ${timeStr} · ${party}p · ${name}`,
                        text: txt,
                        html: `<pre style="font-family:inherit;white-space:pre-wrap">${escHtml(txt)}</pre>`,
                    });
                } catch (e) {
                    console.warn('[restaurant-menu] reservation mail failed:', e.message);
                }
            }
            await ssePing('restaurant_reservation', 'Nueva reserva recibida');

            res.json({
                success: true,
                token,
                status: 'pending',
                message: 'Reserva recibida. Te confirmaremos por teléfono' + (email ? ' o correo' : '') + '.',
            });
        } catch (e) {
            console.error('[restaurant-menu] reservation failed:', e.message);
            res.status(500).json({ error: 'No se pudo registrar la reserva. Intenta de nuevo.' });
        }
    });

    // Reservation status lookup by token.
    http.route('get', '/public/reservation', async (req, res) => {
        try {
            if (rateLimited('reservation-lookup', 60, 60 * 1000)) {
                return res.status(429).json({ error: 'Demasiadas consultas.' });
            }
            const token = String((req.query && req.query.token) || '').trim();
            if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Referencia no válida.' });
            const r = await db.get(`SELECT * FROM ${T.reservations} WHERE token = ?`, [token]);
            if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
            res.json({
                status: r.status,
                reserved_date: r.reserved_date,
                reserved_time: r.reserved_time,
                party_size: r.party_size,
                customer_name: r.customer_name,
            });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo consultar la reserva.' });
        }
    });

    // ================================================================================================
    // ADMIN ROUTES
    // ================================================================================================

    // Full menu for the admin (includes inactive/unavailable + i18n meta + attached modifier groups).
    http.route('get', '/admin/menu', { auth: true, admin: true }, async (req, res) => {
        try {
            const sections = await db.all(
                `SELECT id, name, sort_order, is_active FROM ${T.sections} ORDER BY sort_order ASC, id ASC`
            );
            const items = await db.all(
                `SELECT id, section_id, name, description, price_cents, image_url, tags, is_available, sort_order
                 FROM ${T.items} ORDER BY sort_order ASC, id ASC`
            );
            const meta = await loadMetaMaps();
            const attach = await db.all(`SELECT item_id, group_id FROM ${T.itemMods} ORDER BY sort_order ASC, id ASC`);
            const attachByItem = new Map();
            for (const a of attach) {
                if (!attachByItem.has(a.item_id)) attachByItem.set(a.item_id, []);
                attachByItem.get(a.item_id).push(a.group_id);
            }
            const out = sections.map((s) => {
                const sm = meta.sectionMeta.get(s.id);
                return { ...s, name_en: (sm && sm.name_en) || '', items: [] };
            });
            const byId = new Map(out.map((s) => [s.id, s]));
            for (const it of items) {
                const bucket = byId.get(it.section_id);
                if (!bucket) continue;
                const im = meta.itemMeta.get(it.id);
                bucket.items.push({
                    ...it,
                    name_en: (im && im.name_en) || '',
                    description_en: (im && im.description_en) || '',
                    allergens: (im && im.allergens) || '',
                    prep_minutes: (im && im.prep_minutes) || 0,
                    modifier_group_ids: attachByItem.get(it.id) || [],
                });
            }
            res.json({ sections: out });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- sections CRUD + reorder -----------------------------------------------------------------

    http.route('post', '/sections', { auth: true, admin: true }, async (req, res) => {
        try {
            const name = String((req.body && req.body.name) || '').trim();
            if (!name || name.length > 120) return res.status(400).json({ error: 'El nombre de la sección es obligatorio (máx. 120).' });
            const max = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${T.sections}`);
            const result = await db.run(
                `INSERT INTO ${T.sections} (name, sort_order, is_active) VALUES (?, ?, 1)`,
                [name, (max ? max.m : -1) + 1]
            );
            const nameEn = String((req.body && req.body.name_en) || '').trim().slice(0, 120);
            if (nameEn && result && result.lastID) {
                await upsertByKey(T.sectionMeta, 'section_id', result.lastID, { name_en: nameEn });
            }
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/sections/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const existing = await db.get(`SELECT id FROM ${T.sections} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Sección no encontrada.' });
            const body = req.body || {};
            if (typeof body.name === 'string') {
                const name = body.name.trim();
                if (!name || name.length > 120) return res.status(400).json({ error: 'Nombre inválido.' });
                await db.run(`UPDATE ${T.sections} SET name = ? WHERE id = ?`, [name, id]);
            }
            if (body.is_active !== undefined) {
                await db.run(`UPDATE ${T.sections} SET is_active = ? WHERE id = ?`, [body.is_active ? 1 : 0, id]);
            }
            if (typeof body.name_en === 'string') {
                await upsertByKey(T.sectionMeta, 'section_id', id, { name_en: body.name_en.trim().slice(0, 120) });
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/sections/:id/move', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const dir = (req.body && req.body.dir) === 'up' ? 'up' : 'down';
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const moved = await moveRow(T.sections, '', [], id, dir);
            res.json({ success: true, moved });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/sections/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const items = await db.all(`SELECT id FROM ${T.items} WHERE section_id = ?`, [id]);
            const itemIds = items.map((r) => r.id);
            if (itemIds.length) {
                const ph = itemIds.map(() => '?').join(',');
                await db.run(`DELETE FROM ${T.itemMeta} WHERE item_id IN (${ph})`, itemIds);
                await db.run(`DELETE FROM ${T.itemMods} WHERE item_id IN (${ph})`, itemIds);
            }
            await db.run(`DELETE FROM ${T.items} WHERE section_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.sectionMeta} WHERE section_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.sections} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- items CRUD + reorder + availability -----------------------------------------------------

    /** Validate + normalize an item payload. Returns { error } or the clean fields. */
    async function cleanItemPayload(body, requireAll) {
        const out = {};
        if (requireAll || body.name !== undefined) {
            const name = String(body.name || '').trim();
            if (!name || name.length > 160) return { error: 'El nombre del plato es obligatorio (máx. 160).' };
            out.name = name;
        }
        if (requireAll || body.description !== undefined) {
            const description = String(body.description || '').trim();
            if (description.length > 1000) return { error: 'La descripción es demasiado larga.' };
            out.description = description;
        }
        if (requireAll || body.price_cents !== undefined) {
            const cents = toCents(body.price_cents);
            if (cents === null) return { error: 'Precio inválido.' };
            out.price_cents = cents;
        }
        if (requireAll || body.image_url !== undefined) {
            const imageUrl = String(body.image_url || '').trim();
            if (imageUrl.length > 600) return { error: 'La URL de la imagen es demasiado larga.' };
            if (imageUrl && !/^(https?:\/\/|\/)/i.test(imageUrl)) return { error: 'La imagen debe ser una URL http(s) o una ruta del sitio.' };
            out.image_url = imageUrl;
        }
        if (requireAll || body.tags !== undefined) {
            out.tags = cleanTags(body.tags);
        }
        return out;
    }

    /** v2 side-fields (i18n/allergens/prep) → item_meta upsert. Returns {error} or clean fields. */
    function cleanItemMeta(body) {
        const out = {};
        if (body.name_en !== undefined) {
            const v = String(body.name_en || '').trim();
            if (v.length > 160) return { error: 'El nombre en inglés es demasiado largo.' };
            out.name_en = v;
        }
        if (body.description_en !== undefined) {
            const v = String(body.description_en || '').trim();
            if (v.length > 1000) return { error: 'La descripción en inglés es demasiado larga.' };
            out.description_en = v;
        }
        if (body.allergens !== undefined) {
            out.allergens = cleanAllergens(body.allergens);
        }
        if (body.prep_minutes !== undefined) {
            const n = parseInt(body.prep_minutes, 10);
            if (!Number.isInteger(n) || n < 0 || n > 600) return { error: 'Minutos de preparación inválidos (0–600).' };
            out.prep_minutes = n;
        }
        return out;
    }

    http.route('post', '/items', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const sectionId = parseInt(body.section_id, 10);
            if (!Number.isInteger(sectionId)) return res.status(400).json({ error: 'Sección inválida.' });
            const section = await db.get(`SELECT id FROM ${T.sections} WHERE id = ?`, [sectionId]);
            if (!section) return res.status(404).json({ error: 'Sección no encontrada.' });

            const clean = await cleanItemPayload(body, true);
            if (clean.error) return res.status(400).json({ error: clean.error });
            const metaClean = cleanItemMeta(body);
            if (metaClean.error) return res.status(400).json({ error: metaClean.error });

            const max = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${T.items} WHERE section_id = ?`, [sectionId]);
            const result = await db.run(
                `INSERT INTO ${T.items} (section_id, name, description, price_cents, image_url, tags, is_available, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
                [sectionId, clean.name, clean.description, clean.price_cents, clean.image_url, clean.tags, (max ? max.m : -1) + 1]
            );
            if (result && result.lastID && Object.keys(metaClean).length) {
                await upsertByKey(T.itemMeta, 'item_id', result.lastID, metaClean);
            }
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/items/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const existing = await db.get(`SELECT id, section_id FROM ${T.items} WHERE id = ?`, [id]);
            if (!existing) return res.status(404).json({ error: 'Plato no encontrado.' });

            const body = req.body || {};
            const clean = await cleanItemPayload(body, false);
            if (clean.error) return res.status(400).json({ error: clean.error });
            const metaClean = cleanItemMeta(body);
            if (metaClean.error) return res.status(400).json({ error: metaClean.error });

            const sets = [];
            const params = [];
            for (const key of ['name', 'description', 'price_cents', 'image_url', 'tags']) {
                if (clean[key] !== undefined) {
                    sets.push(`${key} = ?`);
                    params.push(clean[key]);
                }
            }
            if (body.is_available !== undefined) {
                sets.push('is_available = ?');
                params.push(body.is_available ? 1 : 0);
            }
            if (body.section_id !== undefined) {
                const sectionId = parseInt(body.section_id, 10);
                if (!Number.isInteger(sectionId)) return res.status(400).json({ error: 'Sección inválida.' });
                const section = await db.get(`SELECT id FROM ${T.sections} WHERE id = ?`, [sectionId]);
                if (!section) return res.status(404).json({ error: 'Sección no encontrada.' });
                sets.push('section_id = ?');
                params.push(sectionId);
            }
            if (sets.length > 0) {
                params.push(id);
                await db.run(`UPDATE ${T.items} SET ${sets.join(', ')} WHERE id = ?`, params);
            }
            if (Object.keys(metaClean).length) {
                await upsertByKey(T.itemMeta, 'item_id', id, metaClean);
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Replace the set of modifier groups attached to a dish.
    http.route('put', '/items/:id/modifier-groups', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const item = await db.get(`SELECT id FROM ${T.items} WHERE id = ?`, [id]);
            if (!item) return res.status(404).json({ error: 'Plato no encontrado.' });
            const raw = Array.isArray(req.body && req.body.group_ids) ? req.body.group_ids : [];
            if (raw.length > 20) return res.status(400).json({ error: 'Demasiados grupos.' });
            const ids = [];
            for (const r of raw) {
                const gid = parseInt(r, 10);
                if (!Number.isInteger(gid) || gid <= 0) return res.status(400).json({ error: 'Grupo inválido.' });
                if (!ids.includes(gid)) ids.push(gid);
            }
            if (ids.length) {
                const found = await fetchIn(T.modGroups, 'id', ids);
                if (found.length !== ids.length) return res.status(404).json({ error: 'Algún grupo no existe.' });
            }
            await db.run(`DELETE FROM ${T.itemMods} WHERE item_id = ?`, [id]);
            for (let i = 0; i < ids.length; i++) {
                await db.run(
                    `INSERT INTO ${T.itemMods} (item_id, group_id, sort_order) VALUES (?, ?, ?)`,
                    [id, ids[i], i]
                );
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/items/:id/move', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const dir = (req.body && req.body.dir) === 'up' ? 'up' : 'down';
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const item = await db.get(`SELECT id, section_id FROM ${T.items} WHERE id = ?`, [id]);
            if (!item) return res.status(404).json({ error: 'Plato no encontrado.' });
            const moved = await moveRow(T.items, 'WHERE section_id = ?', [item.section_id], id, dir);
            res.json({ success: true, moved });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/items/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            await db.run(`DELETE FROM ${T.itemMeta} WHERE item_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.itemMods} WHERE item_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.items} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- modifier groups + options CRUD ----------------------------------------------------------

    http.route('get', '/modifier-groups', { auth: true, admin: true }, async (req, res) => {
        try {
            const groups = await db.all(`SELECT * FROM ${T.modGroups} ORDER BY sort_order ASC, id ASC`);
            const opts = await db.all(`SELECT * FROM ${T.modOptions} ORDER BY sort_order ASC, id ASC`);
            const counts = await db.all(`SELECT group_id, COUNT(*) AS n FROM ${T.itemMods} GROUP BY group_id`);
            const countBy = new Map(counts.map((c) => [c.group_id, c.n]));
            const byGroup = new Map();
            for (const o of opts) {
                if (!byGroup.has(o.group_id)) byGroup.set(o.group_id, []);
                byGroup.get(o.group_id).push(o);
            }
            res.json({
                groups: groups.map((g) => ({
                    ...g,
                    options: byGroup.get(g.id) || [],
                    attached_items: countBy.get(g.id) || 0,
                })),
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    function cleanGroupPayload(body, requireAll) {
        const out = {};
        if (requireAll || body.name !== undefined) {
            const name = String(body.name || '').trim();
            if (!name || name.length > 120) return { error: 'El nombre del grupo es obligatorio (máx. 120).' };
            out.name = name;
        }
        if (body.name_en !== undefined) {
            const v = String(body.name_en || '').trim();
            if (v.length > 120) return { error: 'Nombre en inglés demasiado largo.' };
            out.name_en = v;
        }
        if (requireAll || body.min_select !== undefined) {
            const n = parseInt(body.min_select, 10);
            if (!Number.isInteger(n) || n < 0 || n > 20) return { error: 'Mínimo inválido (0–20).' };
            out.min_select = n;
        }
        if (requireAll || body.max_select !== undefined) {
            const n = parseInt(body.max_select, 10);
            if (!Number.isInteger(n) || n < 1 || n > 20) return { error: 'Máximo inválido (1–20).' };
            out.max_select = n;
        }
        return out;
    }

    http.route('post', '/modifier-groups', { auth: true, admin: true }, async (req, res) => {
        try {
            const clean = cleanGroupPayload(req.body || {}, true);
            if (clean.error) return res.status(400).json({ error: clean.error });
            if ((clean.min_select | 0) > (clean.max_select | 0)) {
                return res.status(400).json({ error: 'El mínimo no puede superar el máximo.' });
            }
            const max = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${T.modGroups}`);
            const result = await db.run(
                `INSERT INTO ${T.modGroups} (name, name_en, min_select, max_select, is_active, sort_order)
                 VALUES (?, ?, ?, ?, 1, ?)`,
                [clean.name, clean.name_en || '', clean.min_select, clean.max_select, (max ? max.m : -1) + 1]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/modifier-groups/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const g = await db.get(`SELECT * FROM ${T.modGroups} WHERE id = ?`, [id]);
            if (!g) return res.status(404).json({ error: 'Grupo no encontrado.' });
            const body = req.body || {};
            const clean = cleanGroupPayload(body, false);
            if (clean.error) return res.status(400).json({ error: clean.error });
            const min = clean.min_select !== undefined ? clean.min_select : g.min_select;
            const maxSel = clean.max_select !== undefined ? clean.max_select : g.max_select;
            if (min > maxSel) return res.status(400).json({ error: 'El mínimo no puede superar el máximo.' });
            const sets = [];
            const params = [];
            for (const key of ['name', 'name_en', 'min_select', 'max_select']) {
                if (clean[key] !== undefined) { sets.push(`${key} = ?`); params.push(clean[key]); }
            }
            if (body.is_active !== undefined) { sets.push('is_active = ?'); params.push(body.is_active ? 1 : 0); }
            if (sets.length === 0) return res.json({ success: true });
            params.push(id);
            await db.run(`UPDATE ${T.modGroups} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/modifier-groups/:id/move', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const dir = (req.body && req.body.dir) === 'up' ? 'up' : 'down';
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const moved = await moveRow(T.modGroups, '', [], id, dir);
            res.json({ success: true, moved });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/modifier-groups/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            await db.run(`DELETE FROM ${T.modOptions} WHERE group_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.itemMods} WHERE group_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.modGroups} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    function cleanOptionPayload(body, requireAll) {
        const out = {};
        if (requireAll || body.name !== undefined) {
            const name = String(body.name || '').trim();
            if (!name || name.length > 120) return { error: 'El nombre de la opción es obligatorio (máx. 120).' };
            out.name = name;
        }
        if (body.name_en !== undefined) {
            const v = String(body.name_en || '').trim();
            if (v.length > 120) return { error: 'Nombre en inglés demasiado largo.' };
            out.name_en = v;
        }
        if (requireAll || body.price_delta_cents !== undefined) {
            const n = Number(body.price_delta_cents);
            const c = Math.round(n);
            // Deltas may be negative (e.g. "sin proteína −$2), bounded to ±100000.00.
            if (!Number.isFinite(n) || c < -10000000 || c > 10000000) return { error: 'Precio adicional inválido.' };
            out.price_delta_cents = c;
        }
        return out;
    }

    http.route('post', '/modifier-options', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const groupId = parseInt(body.group_id, 10);
            if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Grupo inválido.' });
            const g = await db.get(`SELECT id FROM ${T.modGroups} WHERE id = ?`, [groupId]);
            if (!g) return res.status(404).json({ error: 'Grupo no encontrado.' });
            const clean = cleanOptionPayload(body, true);
            if (clean.error) return res.status(400).json({ error: clean.error });
            const max = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${T.modOptions} WHERE group_id = ?`, [groupId]);
            const result = await db.run(
                `INSERT INTO ${T.modOptions} (group_id, name, name_en, price_delta_cents, is_available, sort_order)
                 VALUES (?, ?, ?, ?, 1, ?)`,
                [groupId, clean.name, clean.name_en || '', clean.price_delta_cents || 0, (max ? max.m : -1) + 1]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/modifier-options/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const o = await db.get(`SELECT id FROM ${T.modOptions} WHERE id = ?`, [id]);
            if (!o) return res.status(404).json({ error: 'Opción no encontrada.' });
            const body = req.body || {};
            const clean = cleanOptionPayload(body, false);
            if (clean.error) return res.status(400).json({ error: clean.error });
            const sets = [];
            const params = [];
            for (const key of ['name', 'name_en', 'price_delta_cents']) {
                if (clean[key] !== undefined) { sets.push(`${key} = ?`); params.push(clean[key]); }
            }
            if (body.is_available !== undefined) { sets.push('is_available = ?'); params.push(body.is_available ? 1 : 0); }
            if (sets.length === 0) return res.json({ success: true });
            params.push(id);
            await db.run(`UPDATE ${T.modOptions} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/modifier-options/:id/move', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const dir = (req.body && req.body.dir) === 'up' ? 'up' : 'down';
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const o = await db.get(`SELECT id, group_id FROM ${T.modOptions} WHERE id = ?`, [id]);
            if (!o) return res.status(404).json({ error: 'Opción no encontrada.' });
            const moved = await moveRow(T.modOptions, 'WHERE group_id = ?', [o.group_id], id, dir);
            res.json({ success: true, moved });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/modifier-options/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            await db.run(`DELETE FROM ${T.modOptions} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- tables (QR) -----------------------------------------------------------------------------

    http.route('get', '/tables', { auth: true, admin: true }, async (req, res) => {
        try {
            const rows = await db.all(`SELECT * FROM ${T.tables} ORDER BY sort_order ASC, id ASC`);
            const cfg = await getConfig();
            res.json({ tables: rows, menuPageUrl: cfg.menuPageUrl });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/tables', { auth: true, admin: true }, async (req, res) => {
        try {
            const label = String((req.body && req.body.label) || '').trim();
            if (!label || label.length > 60) return res.status(400).json({ error: 'La etiqueta de la mesa es obligatoria (máx. 60).' });
            const max = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${T.tables}`);
            const token = await genToken();
            const result = await db.run(
                `INSERT INTO ${T.tables} (label, token, is_active, sort_order, created_at) VALUES (?, ?, 1, ?, ?)`,
                [label, token, (max ? max.m : -1) + 1, nowUtcSql()]
            );
            res.json({ success: true, id: result.lastID, token });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('put', '/tables/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const t = await db.get(`SELECT id FROM ${T.tables} WHERE id = ?`, [id]);
            if (!t) return res.status(404).json({ error: 'Mesa no encontrada.' });
            const body = req.body || {};
            if (typeof body.label === 'string') {
                const label = body.label.trim();
                if (!label || label.length > 60) return res.status(400).json({ error: 'Etiqueta inválida.' });
                await db.run(`UPDATE ${T.tables} SET label = ? WHERE id = ?`, [label, id]);
            }
            if (body.is_active !== undefined) {
                await db.run(`UPDATE ${T.tables} SET is_active = ? WHERE id = ?`, [body.is_active ? 1 : 0, id]);
            }
            if (body.regenerate_token) {
                await db.run(`UPDATE ${T.tables} SET token = ? WHERE id = ?`, [await genToken(), id]);
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/tables/:id/move', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const dir = (req.body && req.body.dir) === 'up' ? 'up' : 'down';
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const moved = await moveRow(T.tables, '', [], id, dir);
            res.json({ success: true, moved });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/tables/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            await db.run(`DELETE FROM ${T.tables} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- reservations (admin) --------------------------------------------------------------------

    // ?date=YYYY-MM-DD exact day, ?all=1 everything; default upcoming. ?status= filter on top.
    http.route('get', '/reservations', { auth: true, admin: true }, async (req, res) => {
        try {
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const date = String(q.date || '').trim();
            const today = tzParts(new Date(), (await getConfig()).timezone).date;
            const where = [];
            const params = [];
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                where.push('reserved_date = ?');
                params.push(date);
            } else if (String(q.all || '') !== '1') {
                where.push('reserved_date >= ?');
                params.push(today);
            }
            if (status && RES_STATUSES.includes(status)) {
                where.push('status = ?');
                params.push(status);
            }
            const sql = `SELECT * FROM ${T.reservations}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY reserved_date ASC, reserved_time ASC, id ASC LIMIT 500`;
            const rows = await db.all(sql, params);
            const countRows = await db.all(`SELECT status, COUNT(*) AS n FROM ${T.reservations} WHERE reserved_date >= ? GROUP BY status`, [today]);
            const counts = {};
            for (const s of RES_STATUSES) counts[s] = 0;
            for (const row of countRows) {
                if (counts[row.status] !== undefined) counts[row.status] = row.n;
            }
            res.json({ reservations: rows, counts, today });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Manual reservation (phone bookings) — defaults to confirmed.
    http.route('post', '/reservations', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const name = String(body.customer_name || '').trim();
            const phone = String(body.customer_phone || '').trim();
            const email = String(body.customer_email || '').trim();
            const notes = String(body.notes || '').trim().slice(0, MAX_ORDER_NOTES_CHARS);
            const dateStr = String(body.date || '').trim();
            const timeStr = String(body.time || '').trim();
            const party = parseInt(body.party_size, 10);
            if (!name || name.length > MAX_NAME_CHARS) return res.status(400).json({ error: 'Nombre inválido.' });
            if (phone.length > MAX_PHONE_CHARS) return res.status(400).json({ error: 'Teléfono demasiado largo.' });
            if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
                return res.status(400).json({ error: 'Email inválido.' });
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(new Date(`${dateStr}T00:00:00Z`).getTime())) {
                return res.status(400).json({ error: 'Fecha inválida.' });
            }
            if (!HM_RE.test(timeStr)) return res.status(400).json({ error: 'Hora inválida.' });
            if (!Number.isInteger(party) || party < 1 || party > 200) return res.status(400).json({ error: 'Número de personas inválido.' });
            const status = RES_STATUSES.includes(String(body.status || '')) ? String(body.status) : 'confirmed';
            const token = await genToken();
            const result = await db.run(
                `INSERT INTO ${T.reservations}
                    (token, customer_name, customer_phone, customer_email, party_size, reserved_date, reserved_time, notes, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [token, name, phone, email, party, dateStr, timeStr, notes, status, nowUtcSql()]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/reservations/:id/status', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const status = String((req.body && req.body.status) || '').trim();
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            if (!RES_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
            const r = await db.get(`SELECT * FROM ${T.reservations} WHERE id = ?`, [id]);
            if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
            await db.run(`UPDATE ${T.reservations} SET status = ? WHERE id = ?`, [status, id]);

            // Confirmation email to the customer (best effort) when moving to confirmed.
            let mailNote = '';
            if (status === 'confirmed' && r.customer_email && r.status !== 'confirmed') {
                try {
                    const txt = `¡Tu reserva está confirmada!\n${r.reserved_date} a las ${r.reserved_time} · ${r.party_size} personas\nA nombre de: ${r.customer_name}\nReferencia: ${r.token}`;
                    await mail({
                        to: r.customer_email,
                        subject: `Reserva confirmada — ${r.reserved_date} ${r.reserved_time}`,
                        text: txt,
                        html: `<pre style="font-family:inherit;white-space:pre-wrap">${escHtml(txt)}</pre>`,
                    });
                } catch (e) {
                    mailNote = 'correo no enviado';
                    console.warn('[restaurant-menu] reservation confirm mail failed:', e.message);
                }
            }
            res.json({ success: true, mailNote });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/reservations/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            await db.run(`DELETE FROM ${T.reservations} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- orders ------------------------------------------------------------------------------------

    /** Merge order_meta facts onto a list of order rows (LEFT-join semantics, orphan-safe). */
    async function attachOrderMeta(orders) {
        const ids = orders.map((o) => o.id);
        const metas = await fetchIn(T.orderMeta, 'order_id', ids);
        const byOrder = new Map(metas.map((m) => [m.order_id, m]));
        for (const o of orders) {
            const m = byOrder.get(o.id);
            o.table_label = m ? m.table_label : '';
            o.payment_method = m ? m.payment_method : 'whatsapp';
            o.payment_status = m ? m.payment_status : 'none';
            o.source = m ? m.source : 'web';
            o.eta_minutes = m ? m.eta_minutes : 0;
        }
        return orders;
    }

    // ?status= filter; always returns per-status counts for the badges.
    http.route('get', '/orders', { auth: true, admin: true }, async (req, res) => {
        try {
            const status = String((req.query && req.query.status) || '').trim();
            let orders;
            if (status && ORDER_STATUSES.includes(status)) {
                orders = await db.all(`SELECT * FROM ${T.orders} WHERE status = ? ORDER BY id DESC LIMIT 300`, [status]);
            } else {
                orders = await db.all(`SELECT * FROM ${T.orders} ORDER BY id DESC LIMIT 300`);
            }
            for (const o of orders) {
                try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; }
            }
            await attachOrderMeta(orders);
            const countRows = await db.all(`SELECT status, COUNT(*) AS n FROM ${T.orders} GROUP BY status`);
            const counts = {};
            for (const s of ORDER_STATUSES) counts[s] = 0;
            for (const row of countRows) {
                if (counts[row.status] !== undefined) counts[row.status] = row.n;
            }
            res.json({ orders, counts });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Kitchen board: active orders only, with age + table + payment badges.
    http.route('get', '/kitchen', { auth: true, admin: true }, async (req, res) => {
        try {
            const orders = await db.all(
                `SELECT * FROM ${T.orders} WHERE status IN ('new', 'preparing', 'ready') ORDER BY id ASC`
            );
            for (const o of orders) {
                try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; }
                o.age_seconds = Math.max(0, Math.round((Date.now() - parseCreatedAt(o.created_at).getTime()) / 1000));
            }
            await attachOrderMeta(orders);
            res.json({ orders });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/orders/:id/status', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const status = String((req.body && req.body.status) || '').trim();
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
            const result = await db.run(`UPDATE ${T.orders} SET status = ? WHERE id = ?`, [status, id]);
            if (!result || result.changes === 0) return res.status(404).json({ error: 'Pedido no encontrado.' });
            await ssePing('restaurant_order', 'Pedido actualizado');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Manual payment mark (cash collected / refund correction).
    http.route('post', '/orders/:id/paid', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            const o = await db.get(`SELECT id FROM ${T.orders} WHERE id = ?`, [id]);
            if (!o) return res.status(404).json({ error: 'Pedido no encontrado.' });
            const paid = !!(req.body && req.body.paid);
            const existing = await db.get(`SELECT id FROM ${T.orderMeta} WHERE order_id = ?`, [id]);
            if (existing) {
                if (paid) {
                    await db.run(`UPDATE ${T.orderMeta} SET payment_status = 'paid', paid_at = ? WHERE order_id = ?`, [nowUtcSql(), id]);
                } else {
                    await db.run(`UPDATE ${T.orderMeta} SET payment_status = 'none' WHERE order_id = ?`, [id]);
                }
            } else {
                await db.run(
                    `INSERT INTO ${T.orderMeta} (order_id, payment_method, payment_status, source) VALUES (?, 'cash', ?, 'web')`,
                    [id, paid ? 'paid' : 'none']
                );
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/orders/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            await db.run(`DELETE FROM ${T.orderMeta} WHERE order_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.orders} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- reports -----------------------------------------------------------------------------------

    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    /** Shared loader: orders within [from..to] (restaurant-tz calendar days), meta attached. */
    async function loadReportOrders(cfg, from, to) {
        // Pull a padded UTC window, then bucket precisely per-order in the restaurant timezone
        // (created_at is stored in UTC; no dialect-safe SQL date math exists across drivers).
        const fromPad = new Date(new Date(`${from}T00:00:00Z`).getTime() - 36 * 3600 * 1000);
        const toPad = new Date(new Date(`${to}T00:00:00Z`).getTime() + 60 * 3600 * 1000);
        const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
        const rows = await db.all(
            `SELECT * FROM ${T.orders} WHERE created_at >= ? AND created_at <= ? ORDER BY id ASC`,
            [iso(fromPad), iso(toPad)]
        );
        await attachOrderMeta(rows);
        const out = [];
        for (const o of rows) {
            const local = tzParts(parseCreatedAt(o.created_at), cfg.timezone);
            if (local.date < from || local.date > to) continue;
            try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; }
            o._localDate = local.date;
            o._localHour = local.hour;
            out.push(o);
        }
        return out;
    }

    function normalizeRange(q, cfg) {
        const today = tzParts(new Date(), cfg.timezone).date;
        // A pseudo-date like 2026-99-99 matches the regex but yields Invalid Date downstream —
        // require real calendar dates, else fall back to the defaults.
        const validDate = (s) => DATE_RE.test(s) && !isNaN(new Date(`${s}T00:00:00Z`).getTime());
        let from = String((q && q.from) || '').trim();
        let to = String((q && q.to) || '').trim();
        if (!validDate(to)) to = today;
        if (!validDate(from)) {
            const d = new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 24 * 3600 * 1000);
            from = d.toISOString().slice(0, 10);
        }
        if (from > to) { const t = from; from = to; to = t; }
        // Cap the window at 366 days so a hostile range can't make the JS pass unbounded.
        const spanDays = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000;
        if (spanDays > 366) {
            const d = new Date(new Date(`${to}T00:00:00Z`).getTime() - 366 * 24 * 3600 * 1000);
            from = d.toISOString().slice(0, 10);
        }
        return { from, to };
    }

    http.route('get', '/reports', { auth: true, admin: true }, async (req, res) => {
        try {
            const cfg = await getConfig();
            const { from, to } = normalizeRange(req.query, cfg);
            const orders = await loadReportOrders(cfg, from, to);

            const sold = orders.filter((o) => o.status !== 'cancelled');
            const revenue = sold.reduce((s, o) => s + (o.total_cents | 0), 0);
            const byDay = new Map();
            const peak = new Array(24).fill(0);
            const dishes = new Map(); // name -> {qty, revenue}
            const byPayment = { whatsapp: 0, cash: 0, stripe: 0 };
            const bySource = { web: 0, table: 0 };
            const byType = { pickup: 0, delivery: 0, table: 0 };
            let paidOnlineCents = 0;

            for (const o of sold) {
                const day = byDay.get(o._localDate) || { date: o._localDate, orders: 0, revenue_cents: 0 };
                day.orders += 1;
                day.revenue_cents += o.total_cents | 0;
                byDay.set(o._localDate, day);
                peak[o._localHour] += 1;
                if (byPayment[o.payment_method] !== undefined) byPayment[o.payment_method] += 1;
                if (bySource[o.source] !== undefined) bySource[o.source] += 1;
                if (byType[o.delivery_type] !== undefined) byType[o.delivery_type] += 1;
                if (o.payment_status === 'paid' && o.payment_method === 'stripe') paidOnlineCents += o.total_cents | 0;
                for (const it of (Array.isArray(o.items) ? o.items : [])) {
                    const key = String(it.name || '¿?');
                    const d = dishes.get(key) || { name: key, qty: 0, revenue_cents: 0 };
                    d.qty += it.qty | 0;
                    d.revenue_cents += Number.isFinite(it.line_cents) ? (it.line_cents | 0) : ((it.price_cents | 0) * (it.qty | 0));
                    dishes.set(key, d);
                }
            }
            const topDishes = Array.from(dishes.values()).sort((a, b) => b.qty - a.qty).slice(0, 15);
            const series = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? -1 : 1));

            const resRows = await db.all(
                `SELECT status, COUNT(*) AS n FROM ${T.reservations} WHERE reserved_date >= ? AND reserved_date <= ? GROUP BY status`,
                [from, to]
            );
            const reservations = {};
            for (const s of RES_STATUSES) reservations[s] = 0;
            for (const r of resRows) {
                if (reservations[r.status] !== undefined) reservations[r.status] = r.n;
            }

            res.json({
                from, to,
                totals: {
                    orders: sold.length,
                    cancelled: orders.length - sold.length,
                    revenue_cents: revenue,
                    avg_ticket_cents: sold.length ? Math.round(revenue / sold.length) : 0,
                    paid_online_cents: paidOnlineCents,
                },
                byDay: series,
                peakHours: peak,
                topDishes,
                byPayment,
                bySource,
                byType,
                reservations,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Flat CSV of the range's orders — returned as {csv} (res.send would JSON-encode the string).
    http.route('get', '/reports/csv', { auth: true, admin: true }, async (req, res) => {
        try {
            const cfg = await getConfig();
            const { from, to } = normalizeRange(req.query, cfg);
            const orders = await loadReportOrders(cfg, from, to);
            const esc = (v) => {
                let s = String(v == null ? '' : v);
                // Neutralize spreadsheet formula injection: customer-controlled text must never open
                // with =, +, -, @ (Excel would evaluate it on open).
                if (/^[=+\-@]/.test(s)) s = `'${s}`;
                return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const money = (c) => ((c | 0) / 100).toFixed(2);
            const head = ['id', 'fecha', 'hora', 'cliente', 'tipo', 'mesa', 'pago', 'estado_pago', 'estado', 'subtotal', 'domicilio', 'total', 'productos'];
            const rows = [head.join(',')];
            for (const o of orders) {
                const items = (Array.isArray(o.items) ? o.items : [])
                    .map((it) => `${it.qty}x ${it.name}${(it.options || []).length ? ` (${it.options.map((x) => x.name).join(', ')})` : ''}`)
                    .join(' | ');
                rows.push([
                    o.id, o._localDate, `${String(o._localHour).padStart(2, '0')}:00`,
                    esc(o.customer_name), o.delivery_type, esc(o.table_label),
                    o.payment_method, o.payment_status, o.status,
                    money(o.subtotal_cents), money(o.delivery_cents), money(o.total_cents),
                    esc(items),
                ].join(','));
            }
            res.json({ csv: rows.join('\n'), filename: `restaurante-pedidos-${from}-a-${to}.csv` });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- Stripe key (write-only, mirrors online-store) --------------------------------------------

    http.route('get', '/stripe-status', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json({ hasKey: !!(await getSetting('stripe_sk')) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('post', '/stripe-key', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            if (typeof body.key === 'string') await setSetting('stripe_sk', body.key.trim().slice(0, 200));
            res.json({ hasKey: !!(await getSetting('stripe_sk')) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- config ------------------------------------------------------------------------------------

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
            const current = await getConfig();
            const next = { ...current };

            if (body.currencySymbol !== undefined) {
                const sym = String(body.currencySymbol || '').trim().slice(0, 5);
                next.currencySymbol = sym || '$';
            }
            if (body.currencyCode !== undefined) {
                const code = String(body.currencyCode || '').trim().toLowerCase();
                if (code && !/^[a-z]{3}$/.test(code)) {
                    return res.status(400).json({ error: 'El código de moneda debe ser ISO de 3 letras (ej. usd, eur, cop).' });
                }
                next.currencyCode = code || 'usd';
            }
            if (body.orderingEnabled !== undefined) {
                next.orderingEnabled = !!body.orderingEnabled;
            }
            if (body.whatsappNumber !== undefined) {
                const digits = String(body.whatsappNumber || '').replace(/\D/g, '');
                if (digits && (digits.length < 8 || digits.length > 15)) {
                    return res.status(400).json({ error: 'El número de WhatsApp debe tener entre 8 y 15 dígitos (con código de país).' });
                }
                next.whatsappNumber = digits;
            }
            if (body.deliveryCents !== undefined) {
                const cents = toCents(body.deliveryCents);
                if (cents === null) return res.status(400).json({ error: 'Costo de domicilio inválido.' });
                next.deliveryCents = cents;
            }
            if (body.pickupLabel !== undefined) {
                next.pickupLabel = String(body.pickupLabel || '').trim().slice(0, 60) || DEFAULT_CONFIG.pickupLabel;
            }
            if (body.deliveryLabel !== undefined) {
                next.deliveryLabel = String(body.deliveryLabel || '').trim().slice(0, 60) || DEFAULT_CONFIG.deliveryLabel;
            }
            if (body.notifyEmail !== undefined) {
                const email = String(body.notifyEmail || '').trim();
                if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    return res.status(400).json({ error: 'Email de notificación inválido.' });
                }
                next.notifyEmail = email;
            }

            // ---- v2 fields --------------------------------------------------------------------
            if (body.timezone !== undefined) {
                const tz = String(body.timezone || '').trim().slice(0, 60);
                if (tz) {
                    try {
                        new Intl.DateTimeFormat('en-GB', { timeZone: tz });
                    } catch (e) {
                        return res.status(400).json({ error: `Zona horaria inválida: ${tz}` });
                    }
                }
                next.timezone = tz;
            }
            if (body.hoursEnabled !== undefined) next.hoursEnabled = !!body.hoursEnabled;
            if (body.weekHours !== undefined) {
                if (typeof body.weekHours !== 'object' || body.weekHours === null) {
                    return res.status(400).json({ error: 'Horario inválido.' });
                }
                next.weekHours = cleanWeekHours(body.weekHours);
            }
            if (body.closedMessage !== undefined) {
                next.closedMessage = String(body.closedMessage || '').trim().slice(0, 300);
            }
            if (body.prepMinutesDefault !== undefined) {
                const n = parseInt(body.prepMinutesDefault, 10);
                if (!Number.isInteger(n) || n < 0 || n > 600) return res.status(400).json({ error: 'Minutos de preparación inválidos (0–600).' });
                next.prepMinutesDefault = n;
            }
            if (body.tableOrderingEnabled !== undefined) next.tableOrderingEnabled = !!body.tableOrderingEnabled;
            if (body.menuPageUrl !== undefined) {
                const url = String(body.menuPageUrl || '').trim().slice(0, 600);
                if (url && !/^(https?:\/\/|\/)/i.test(url)) {
                    return res.status(400).json({ error: 'La URL del menú debe ser http(s) o una ruta del sitio (ej. /menu).' });
                }
                next.menuPageUrl = url;
            }
            if (body.reservationsEnabled !== undefined) next.reservationsEnabled = !!body.reservationsEnabled;
            if (body.reservationPartyMax !== undefined) {
                const n = parseInt(body.reservationPartyMax, 10);
                if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Máximo de personas inválido (1–100).' });
                next.reservationPartyMax = n;
            }
            if (body.payOnlineEnabled !== undefined) next.payOnlineEnabled = !!body.payOnlineEnabled;
            if (body.i18nEnabled !== undefined) next.i18nEnabled = !!body.i18nEnabled;

            await options.set(OPT_CONFIG, next);
            res.json(next);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- sidebar ----------------------------------------------------------------------------------
    adminMenu.add({
        href: '/admin/plugin/restaurant',
        label: 'Restaurante',
        icon: 'fa-utensils',
        order: 76,
        cap: 'manage_options',
    });

    console.log('[restaurant-menu] plugin initialized (v2)');
};

exports.deactivate = function () {
    // No timers or servers to tear down.
};
