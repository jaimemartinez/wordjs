/**
 * Conference Manager Plugin for WordJS — ISOLATED, NO TRUST TIER.
 *
 * Runs in the child_process sandbox like every other plugin. It uses ONLY the injected `wordjs`
 * capability bridge (no direct require of express/core/dbAsync) and is granted Android-style
 * permissions (database:read, database:write, express:register_route, admin_menu:register, users:read,
 * roles:declare) by the admin. There is NO trusted bypass:
 *   - All tables live under the plugin's own prefix `wjp_conference_manager_` so they pass
 *     assertSqlAllowed's default-deny prefix check. Table names are built from wordjs.db.tablePrefix.
 *   - No PRAGMA / information_schema (denied for plugins). Schema is created idempotently with
 *     createTable and extended with ALTER TABLE … ADD COLUMN on our OWN prefixed tables (permitted;
 *     see addColumnIfMissing).
 *   - Routes are namespaced under /api/v1/plugin/conference-manager/* (no `absolute` paths). The
 *     options object only carries { auth, admin } which the host honors with real middleware. Admin-panel
 *     routes are { auth: true } and gate themselves per section through the conference TEAM (2.15.0:
 *     staff roles, see allow()); team management itself is { auth: true, admin: true }.
 *   - The portal cookie is host-namespaced; we read the namespaced cookie OR the x-portal-token header.
 *
 * Plugin SQL rules (host guard, assertSqlAllowed): no backslashes, no `$`, no `[ ]`, no `;` — so a
 * LIKE with user text escapes its wildcards with `!` (LIKE … ESCAPE '!'), never with a backslash.
 */

// «Pagos de cuotas» (2.18.0): split fee payments — schema, money readers, writes and their routes.
const { createFeePayments } = require('./server/fee-payments');
const { createBadges } = require('./server/badges');
// «Mi inscripción» (2.23.0): the registrant's own page behind their badge's QR; hotel positions.
const { createSelfPage } = require('./server/selfpage');
const { parseGeo, GEO_MESSAGES } = require('./server/geo');
// Transport packages (2.26.0): what is sold is a package of buses, never a single bus ticket.
const { createPackages } = require('./server/transport-packages');
const { createPush } = require('./server/transport-push');
// Room packing (2.20.0): the fewest rooms and empty beds — the engine's and «Sugerir reparto»'s arithmetic.
const pack = require('./server/lodging-pack');
// «Condiciones de salud» and «Turnos de comida» (2.32.0).
const healthMod = require('./server/health');
const mailTplMod = require('./server/mail-templates');

/**
 * Route groups (2.36.11): each group is ONE registered route, `method base` with a `:act` segment, that dispatches
 * to the handler each member registered as if it had its own route — same URL, same options, same checks inside.
 * A member whose options (auth, admin…) differ from its group's refuses to load: grouping never changes who may
 * call an action. An unknown `:act` answers 404 like a missing route.
 */
/** A locality's coordinator data (2.36.12): column → the name the audit («encargado editado») records. */
const COORDINATOR_FIELDS = [['responsible_name', 'name'], ['responsible_phone', 'phone'], ['responsible_email', 'email']];
const COORDINATOR_EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
/**
 * The coordinator fields present in `body`, checked and cleaned: the name (one line, 120 characters at most), the
 * phone in E.164 (the conference's «Indicativo por defecto» for a national number — the same rule as every phone
 * field) and the e-mail. `values` holds only what was sent ('' = cleared); `error` is a 400 body naming the field.
 */
function coordinatorInput(body, conf) {
    const values = {};
    const b = body || {};
    if (b.responsible_name !== undefined) {
        const v = String(b.responsible_name == null ? '' : b.responsible_name).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (v.length > 120) return { error: { error: 'El nombre del encargado es demasiado largo (120 caracteres como máximo).', field: 'responsible_name' } };
        values.responsible_name = v;
    }
    if (b.responsible_phone !== undefined) {
        const raw = String(b.responsible_phone == null ? '' : b.responsible_phone).trim();
        const country = conf && phoneMod.isCountry(conf.phone_country) ? String(conf.phone_country).toUpperCase() : phoneMod.DEFAULT_COUNTRY;
        const e164 = raw ? phoneMod.toE164(raw, country) : '';
        if (raw && !e164) return { error: { error: 'El teléfono del encargado no es válido: escoge el país y escribe el número.', field: 'responsible_phone' } };
        values.responsible_phone = e164;
    }
    if (b.responsible_email !== undefined) {
        const v = String(b.responsible_email == null ? '' : b.responsible_email).trim();
        if (v && (v.length > 254 || !COORDINATOR_EMAIL_RE.test(v))) return { error: { error: 'El correo del encargado no es válido.', field: 'responsible_email' } };
        values.responsible_email = v;
    }
    return { values };
}

const ROUTE_GROUPS = [
    { method: 'post', base: '/public/me/:act', members: ['logout', 'start', 'ticket', 'transport', 'verify', 'view'] },
    { method: 'post', base: '/public/me/push/:act', members: ['subscribe', 'unsubscribe'] },
    { method: 'post', base: '/public/consent/:act', members: ['code', 'confirm', 'open'] },
    { method: 'post', base: '/consent/:act', members: ['purge', 'revoke', 'send', 'share', 'paper'] },
    { method: 'post', base: '/fee-payments/:id/:act', members: ['reject', 'return', 'validate'] },
    { method: 'post', base: '/payments/:id/:act', members: ['reject', 'validate'] },
    { method: 'post', base: '/meals/priority/:act', members: ['call', 'freeze'] },
    { method: 'post', base: '/locations/:id/lodging/:act', members: ['reopen', 'return', 'validate'] },
    { method: 'post', base: '/mail-templates/:id/:act', members: ['save', 'restore', 'preview', 'test'] },
    // 2.36.13: «Enviar por correo» from the admin's badge actions shares the route of «Regenerar enlace».
    { method: 'post', base: '/badges/links/:iid/:act', members: ['rotate', 'email'] },
];
function groupRoutes(host, groups) {
    const memberOf = new Map();
    for (const g of groups) for (const act of g.members) memberOf.set(`${g.method} ${g.base.replace(':act', act)}`, { g, act });
    const registered = new Map();
    const out = Object.create(host);
    out.route = (...args) => {
        const [method, path] = args;
        const hit = memberOf.get(`${String(method).toLowerCase()} ${path}`);
        if (!hit) return host.route(...args);
        // route(method, path, handler) — a public route — or route(method, path, opts, handler).
        const hasOpts = typeof args[2] !== 'function';
        const opts = hasOpts ? args[2] : undefined;
        const handler = hasOpts ? args[3] : args[2];
        const key = hasOpts ? JSON.stringify(opts || {}) : '(none)';
        let group = registered.get(hit.g);
        if (!group) {
            group = { key, handlers: new Map() };
            registered.set(hit.g, group);
            const handlers = group.handlers;
            const dispatch = (req, res) => {
                const h = handlers.get(String((req.params && req.params.act) || ''));
                if (!h) return res.status(404).json({ error: 'Not found' });
                return h(req, res);
            };
            if (hasOpts) host.route(method, hit.g.base, opts, dispatch);
            else host.route(method, hit.g.base, dispatch);
        } else if (group.key !== key) {
            throw new Error(`[conference-manager] route ${method.toUpperCase()} ${path}: its options differ from its group ${hit.g.base}`);
        }
        group.handlers.set(hit.act, handler);
        return undefined;
    };
    return out;
}
const { createMealPriority } = require('./server/meal-priority');
// «Autorización de datos» (2.33.0): each person's consent, signed with a code sent to their e-mail.
const { createConsent, emailFieldIn, maskEmail } = require('./server/consent');
const { docFieldsOf: selfDocFieldsOf } = require('./server/selfpage');
// Phone numbers with their country (2.33.2): E.164 on write, the conference's default country for national numbers.
const phoneMod = require('./server/phone');

exports.metadata = {
    name: 'Conference Manager',
    version: '2.36.15',
    description: 'Manage multiple conference inscriptions, payments, and lodging assignments.',
    author: 'WordJS'
};

exports.init = async function (wordjs) {
    const { db, http: hostHttp, adminMenu } = wordjs;
    // 2.36.11: the host lets a plugin register at most 200 routes (core/plugin-isolate.ts MAX_ROUTES). Sibling
    // actions on the same resource share ONE route here — «POST /fee-payments/:id/:act» answers /reject, /return
    // and /validate — so every URL stays exactly as it was while the count stays well under the cap.
    const http = groupRoutes(hostHttp, ROUTE_GROUPS);

    console.log('Initializing Conference Manager Plugin (Multi-Event, sandboxed)...');

    // Per-plugin table namespace enforced by the host (assertSqlAllowed default-deny). Every table
    // this plugin touches MUST start with this prefix. slug 'conference-manager' -> 'wjp_conference_manager_'.
    const P = db.tablePrefix; // 'wjp_conference_manager_'
    const T = {
        conferences: `${P}conferences`,
        locations: `${P}locations`,
        hotels: `${P}hotels`,
        rooms: `${P}rooms`,
        // Beds of a room SHARED between locations (2.18.0): room_id, location_id, beds. See sharesByRoom.
        roomBeds: `${P}room_beds`,
        lodgingResets: `${P}lodging_resets`,
        withdrawals: `${P}inscription_withdrawals`,
        // 2.36.10: «Historial» — who registered a person and how, and every edit (which fields, never the values).
        history: `${P}inscription_history`,
        // 2.36.11: every welcome e-mail sent to a locality's coordinator (who, when, to whom, whether it went).
        locationMails: `${P}location_mails`,
        // 2.36.12: «Encargado editado» — who changed a locality's coordinator data and when (which fields, never the values).
        locationLog: `${P}location_log`,
        inscriptions: `${P}inscriptions`,
        // Fee payments (2.18.0): a payment is one receipt (`payment_transfers`, the header) split into
        // parts — rows of `payments` linked by transfer_id. See server/fee-payments.js.
        payments: `${P}payments`,
        transfers: `${P}payment_transfers`,
        transferEvents: `${P}payment_transfer_events`,
        rules: `${P}assignment_rules`,
        fields: `${P}fields`,
        feeRules: `${P}fee_rules`,
        buses: `${P}buses`,
        tickets: `${P}transport_tickets`,
        transportPayments: `${P}transport_payments`,
        ledger: `${P}ledger_entries`,
        mealServices: `${P}meal_services`,
        mealPlan: `${P}meal_location_plan`,
        mealOverrides: `${P}meal_overrides`,
        mealDeliveries: `${P}meal_deliveries`,
        // Team & permissions (2.15.0)
        staffRoles: `${P}staff_roles`,
        staffMembers: `${P}staff_members`,
        // Portal sessions (2.17.1)
        portalSessions: `${P}portal_sessions`,
    };

    // Schema-follows-form: the registration FORM is the source of truth. Every form field owns a real
    // column in the inscriptions table, added on demand with `ALTER TABLE ... ADD COLUMN`. A plugin
    // MAY alter its OWN wjp_-prefixed tables (plugin-api.ts allows the `alter` write verb, scoped by
    // the table-attribution guard). PRAGMA / information_schema ARE denied (read verbs are select/with
    // only), so we can't introspect columns first — instead ADD COLUMN runs idempotently by swallowing
    // the "duplicate column" error (SQLite has no ADD COLUMN IF NOT EXISTS).
    //
    // Field TEMPLATES (2.16.0). A new conference starts with NO field: the admin builds the whole form.
    // These are the base fields other features look up by column NAME or by ROLE — the display name
    // (role first_name / last_name), the lodging gender hints and the gender report (column `gender`), the
    // portal's family groups (is_group) — and POST /fields { template } creates one with exactly this
    // definition (only the label may be given). Every field, templated or not, can be edited and deleted
    // while the form is unpublished; every feature copes with a base field that is absent. The location is
    // NOT a field: it is the operational `location_id`, set by the coordinator's portal login or picked in
    // the admin's inscription form from the conference's Localidades.
    const FIELD_TEMPLATES = Object.freeze({
        first_name: { name: 'first_name', label: 'Nombre', type: 'text', options: '', is_required: 1, role: 'first_name', is_group: 0 },
        last_name: { name: 'last_name', label: 'Apellido', type: 'text', options: '', is_required: 1, role: 'last_name', is_group: 0 },
        email: { name: 'email', label: 'Email', type: 'text', options: '', is_required: 0, role: 'email', is_group: 0 },
        phone: { name: 'phone', label: 'Teléfono', type: 'text', options: '', is_required: 0, role: 'phone', is_group: 0 },
        gender: { name: 'gender', label: 'Género', type: 'select', options: 'M, F', is_required: 1, role: 'gender', is_group: 0 },
        // Grouping is a FLAG, not a role (the boot migration clears the legacy 'family_group' role).
        family_group: { name: 'family_group', label: 'Grupo Familiar', type: 'text', options: '', is_required: 0, role: '', is_group: 1 },
        // «Requiere hospedaje» (2.31.0): a Sí / No switch. «No» keeps the person out of every room — the automatic
        // assignment skips them and a manual one (admin or coordinator) is refused. See needsLodging.
        lodging: { name: 'needs_lodging', label: 'Requiere hospedaje', type: 'switch', options: '', is_required: 0, role: 'lodging', is_group: 0 },
        // «Edad» (2.32.0): a whole number 0–120; the meal groups read it (role 'age').
        age: { name: 'age', label: 'Edad', type: 'number', options: '', is_required: 0, role: 'age', is_group: 0 },
        // «Condiciones de salud» (2.32.0): several conditions, «Otros» with text, «Ninguna», «Prefiero no responder».
        // Special-category data: its answers live in their OWN table (server/health.js), never in a column of
        // the inscriptions table — the field's name is reserved below, so no generic path reads or writes it.
        health: { name: 'health_conditions' /* = server/health.js FIELD */, label: 'Condiciones de salud', type: healthMod.TYPE, options: healthMod.DEFAULT_OPTIONS.join(', '), is_required: 0, role: 'health', is_group: 0 },
    });
    // The lodging switch's column and its two canonical values. A form without the field (or a value left
    // blank) means the person NEEDS lodging: nothing changes for a conference that never added it.
    const LODGING_FIELD = 'needs_lodging';
    const SWITCH_ON = 'Sí', SWITCH_OFF = 'No';
    const needsLodging = (p) => !p || p[LODGING_FIELD] !== SWITCH_OFF;
    // SQL twin of needsLodging (the column always exists: the boot migration adds it).
    const lodgingSql = (col = LODGING_FIELD) => `(${col} IS NULL OR ${col} <> '${SWITCH_OFF}')`;
    const NO_LODGING_MSG = 'Este participante indicó que no requiere hospedaje: no se le puede asignar habitación.';

    // Only a safe SQL identifier may go into ALTER TABLE ... ADD COLUMN <name>. Reject anything else.
    const isSafeColumn = (s) => typeof s === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(s);

    // Columns of the inscriptions table that are NOT form fields. A form field may never be named after
    // one of them, the portal may never write one, and no write path may take one from a body key that
    // happens to match a legacy field row (defense in depth). first_name / last_name / gender / email /
    // phone / family_group / document_number are FORM-owned columns and are deliberately NOT reserved.
    const RESERVED_INSCRIPTION_COLUMNS = new Set([
        'id', 'conference_id', 'location', 'location_id', 'custom_data', 'registration_date', 'status',
        'payment_status', 'total_due', 'amount_paid', 'room_id', 'notes', 'reg_code', 'room_locked',
        // 2.36.10: who registered and who last edited the person (never a form field).
        'created_by', 'updated_by',
        // Not a column at all: the health field's answers live in server/health.js's table (2.32.0).
        healthMod.FIELD,
    ]);
    // SQL reserved words that isSafeColumn would otherwise accept as a column name.
    const SQL_RESERVED_WORDS = new Set(['select', 'from', 'where', 'table', 'order', 'group', 'by', 'index', 'primary',
        'key', 'default', 'null', 'and', 'or', 'not', 'in', 'is', 'like', 'limit', 'offset', 'join', 'on', 'as', 'case', 'when',
        'then', 'else', 'end', 'values', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'into', 'set', 'distinct',
        'having', 'union', 'all', 'exists', 'between', 'cast', 'constraint', 'references', 'foreign', 'unique', 'check',
        'column', 'add', 'user', 'date', 'time', 'timestamp', 'integer', 'int', 'text', 'real', 'boolean', 'true', 'false',
        'left', 'right', 'inner', 'outer', 'cross', 'natural', 'using', 'with', 'recursive', 'asc', 'desc', 'escape', 'glob',
        'match', 'regexp', 'collate', 'rowid', 'oid', 'xmin', 'ctid', 'tableoid']);
    const isReservedFieldName = (n) => RESERVED_INSCRIPTION_COLUMNS.has(n) || SQL_RESERVED_WORDS.has(String(n).toLowerCase());
    // A form-field column name usable in SQL AND writable from a form body.
    const isFieldColumn = (n) => isSafeColumn(n) && !RESERVED_INSCRIPTION_COLUMNS.has(n);

    // Idempotent ADD COLUMN (no IF NOT EXISTS in SQLite → swallow the duplicate-column error, but WARN on
    // anything else — a permission denial here used to surface later as an unexplained "no such column").
    async function addColumnIfMissing(table, col, type) {
        if (!isSafeColumn(col)) return false;
        try { await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); return true; }
        catch (e) {
            const msg = String(e && e.message || e);
            if (/duplicate column|already exists/i.test(msg)) return false;         // SQLite / Postgres / MySQL wording
            console.warn(`[conference-manager] ALTER TABLE ${table} ADD COLUMN ${col} failed: ${msg}`);
            return false;
        }
    }

    // LODGING DATES (see lodgingWindow): the sentinels of a location's own dates, and the date arithmetic —
    // function declarations, self-contained, because initSchema's migration uses them before init gets further.
    const LODGING_NO_WAIT = 'now', LODGING_NO_CLOSE = 'never';
    // A stored date as the admin typed it: a bare date stays bare, and so does a driver's DATETIME read back as
    // a Date / its JSON (Postgres, MySQL: midnight UTC); a datetime stays; '' / corrupt → null.
    function lodgingDay(v) {
        if (v == null || v === '') return null;
        if (v instanceof Date) v = Number.isFinite(v.getTime()) ? v.toISOString() : '';
        const str = String(v).trim();
        const json = /^(\d{4}-\d{2}-\d{2})T00:00:00\.000Z$/.exec(str);
        if (json) return json[1];
        const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
        if (bare) {
            const t = Date.UTC(+bare[1], +bare[2] - 1, +bare[3]);
            return new Date(t).toISOString().slice(0, 10) === str ? str : null;
        }
        return str && Number.isFinite(new Date(str).getTime()) ? str : null;
    }
    // A valid IANA zone, or null (UTC).
    function lodgingZone(tz) {
        if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
    }
    // The instant (ms) a calendar day starts in `tz` (null = UTC): local midnight minus the zone's offset there,
    // taken twice so a day that starts across a DST change still lands on its first instant.
    function zoneDayStart(y, m, d, tz) {
        const utc = Date.UTC(y, m - 1, d);
        if (!tz) return utc;
        try {
            const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const offset = (t) => {
                const p = {};
                for (const x of fmt.formatToParts(new Date(t))) p[x.type] = x.value;
                return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
            };
            return utc - offset(utc - offset(utc));
        } catch { return utc; }
    }
    // When a lodging date starts / ends: a bare date from its first instant to the next day's first instant;
    // a datetime is that instant both ways.
    function lodgingStart(v, tz) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        return m ? zoneDayStart(+m[1], +m[2], +m[3], tz) : new Date(v).getTime();
    }
    function lodgingEnd(v, tz) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        return m ? zoneDayStart(+m[1], +m[2], +m[3] + 1, tz) : new Date(v).getTime();
    }
    // A lodging date from a request: '' / null = none; else a real date ('2026-10-15', or a datetime) or 400.
    function lodgingDateInput(v, label) {
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
        const day = typeof v === 'string' ? lodgingDay(v) : null;
        if (!day) throw httpError(400, `Fecha inválida (${label}).`);
        return day;
    }
    // A zone from a request: '' / null = UTC; else an IANA zone or 400.
    function lodgingTzInput(v) {
        if (v === undefined || v === null || v === '') return null;
        const tz = lodgingZone(v);
        if (!tz) throw httpError(400, 'Zona horaria inválida.');
        return tz;
    }
    // 2.36.6: the coordinators' withdrawal deadline — a date-time 'YYYY-MM-DDTHH:MM' in the conference's zone; open
    // until that instant. { until, open }: until = the stored value (null = they cannot withdraw).
    function withdrawEnd(v, tz) {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v || ''));
        if (!m) return NaN;
        return zoneDayStart(+m[1], +m[2], +m[3], tz) + ((+m[4]) * 60 + (+m[5])) * 60000;
    }
    const withdrawWindow = (conf) => {
        const until = conf && conf.withdraw_until ? String(conf.withdraw_until) : null;
        const end = until ? withdrawEnd(until, lodgingZone(conf.lodging_tz)) : NaN;
        return { until, tz: conf ? lodgingZone(conf.lodging_tz) : null, open: !!until && Number.isFinite(end) && Date.now() < end };
    };

    // Indexes for the common filtered/joined lookups. Names AND targets must use the plugin prefix
    // (assertSqlAllowed enforces this). CREATE INDEX IF NOT EXISTS works on both SQLite and Postgres.
    const createIndex = async (name, table, cols) => {
        try {
            await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
        } catch (e) {
            // Ignore if index already exists / unsupported.
        }
    };
    // A UNIQUE index is load-bearing (it is what makes a write race-free without transactions), so a
    // failure is logged instead of swallowed.
    const createUniqueIndex = async (name, table, cols) => {
        try { await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`); }
        catch (e) { console.warn(`[conference-manager] unique index ${name} skipped:`, e.message); }
    };

    /**
     * Initialize Database Schema (idempotent — CREATE TABLE IF NOT EXISTS via the bridge).
     */
    async function initSchema() {
        // 1. Conferences
        await db.createTable(T.conferences, [
            'id INT_PK',
            'name TEXT NOT NULL',
            'slug TEXT UNIQUE NOT NULL',
            'date_start DATETIME',
            'date_end DATETIME',
            'status TEXT DEFAULT \'draft\'',
            'is_form_published INT DEFAULT 0',
            'fee_default REAL DEFAULT 0',
            'description TEXT',
            'lodging_deadline DATETIME',
            // The general opening of the coordinators' lodging (2.21.0; NULL = right away) and the zone its bare
            // dates are judged in (the admin's; NULL = UTC). See LODGING DATES.
            'lodging_opens TEXT',
            'lodging_tz TEXT'
        ]);

        // 2. Locations
        await db.createTable(T.locations, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'code TEXT NOT NULL',
            'responsible_name TEXT',
            'responsible_phone TEXT',
            'capacity INT',
            'payment_methods TEXT',
            // Lodging review (2.5.0): draft | submitted | validated — read as COALESCE(lodging_status, 'draft').
            'lodging_status TEXT DEFAULT \'draft\'',
            'lodging_note TEXT',
            'lodging_submitted_at DATETIME',
            'lodging_reviewed_at DATETIME',
            'lodging_reviewed_by TEXT',
            // Exception to the conference's lodging deadline (2.8.0): 1 = this location may keep arranging
            // after it, until lodging_permission_until (NULL = until the admin revokes it). Since 2.21.0 read
            // only once, by the boot that moves it into lodging_closes (see LODGING DATES).
            'lodging_permission INT DEFAULT 0',
            'lodging_permission_until DATETIME',
            // The location's own lodging dates (2.21.0): NULL = the general one; a date; 'now' (opening: no
            // wait) / 'never' (closing: none). See LODGING DATES.
            'lodging_opens TEXT',
            'lodging_closes TEXT',
            // Its place when «Sugerir reparto» hands out beds that do not reach everyone (2.21.0; NULL = after the
            // ordered ones, by name).
            'lodging_order INT',
            // Administration adjustments (2.17.0): the admin side changed the arrangement while it was
            // submitted / validated — when, who, and how many changes since the coordinator's last
            // submission (stampAdminAdjustment; cleared by POST /portal/lodging/submit).
            'lodging_admin_changed_at DATETIME',
            'lodging_admin_changed_by TEXT',
            'lodging_admin_changes INT DEFAULT 0',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);

        // 3. Hotels
        await db.createTable(T.hotels, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'address TEXT',
            'description TEXT',
            'capacity INT DEFAULT 0',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);

        // 4. Rooms
        await db.createTable(T.rooms, [
            'id INT_PK',
            'hotel_id INT NOT NULL',
            'room_number TEXT NOT NULL',
            'capacity INT DEFAULT 2',
            'gender TEXT DEFAULT \'Mixed\'',
            'is_family INT DEFAULT 0',
            'family_name TEXT',
            'notes TEXT',
            // NULL = pool room (the admin's conference-wide assignment); non-null = allotted to that
            // location. Plain column, no FK (ALTER cannot add one on SQLite; both install paths must agree).
            'location_id INT',
            // A shared room's class (2.21.0): JSON [{ field, value }] — see «THE CLASS OF A SHARED ROOM».
            'share_lock TEXT',
            // Blocked by the administration (2.21.0): see «HELD BY THE ADMINISTRATION».
            'blocked INT',
            `FOREIGN KEY (hotel_id) REFERENCES ${T.hotels}(id) ON DELETE CASCADE`
        ]);

        // 4b. Beds of a room shared between locations (2.18.0, «camas por localidad»). A room with rows
        // here keeps location_id NULL; each row gives `beds` of it to one location, and the rest of its
        // capacity are pool beds. One row per (room, location).
        await db.createTable(T.roomBeds, [
            'id INT_PK',
            'room_id INT NOT NULL',
            'location_id INT NOT NULL',
            'beds INT NOT NULL',
            `FOREIGN KEY (room_id) REFERENCES ${T.rooms}(id) ON DELETE CASCADE`
        ]);

        // 5. Inscriptions. `location_id` is the ISOLATION KEY of the coordinator portal (a location's
        // stable id); `location` is only the DISPLAY LABEL, kept in sync on rename (added by the
        // migration below on installs that predate it — so it is not in this column list on purpose,
        // otherwise the two paths would disagree on fresh vs. upgraded installs).
        await db.createTable(T.inscriptions, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'first_name TEXT NOT NULL',
            'last_name TEXT NOT NULL',
            'gender TEXT',
            'email TEXT',
            'phone TEXT',
            'location TEXT',
            'document_number TEXT',
            'family_group TEXT',
            'custom_data TEXT',
            'registration_date DATETIME DEFAULT CURRENT_TIMESTAMP',
            'status TEXT DEFAULT \'pending\'',
            'payment_status TEXT DEFAULT \'unpaid\'',
            'total_due REAL DEFAULT 0',
            'amount_paid REAL DEFAULT 0',
            'room_id INT',
            // The room this person was fixed in by the administration (2.21.0): see «HELD BY THE ADMINISTRATION».
            'room_locked INT',
            'notes TEXT',
            // Registration code (2.9.0): unique, random, admin-only — the barcode payload. VARCHAR, not TEXT,
            // so MySQL can index it.
            'reg_code VARCHAR(16)',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (room_id) REFERENCES ${T.rooms}(id) ON DELETE SET NULL`
        ]);

        // 6. Payments. Every payment carries a mandatory `proof` (comprobante) and starts `pending` —
        // an admin must VALIDATE it before it counts toward amount_paid. `status`: pending|validated|rejected.
        await db.createTable(T.payments, [
            'id INT_PK',
            'inscription_id INT NOT NULL',
            'amount REAL NOT NULL',
            'date DATETIME DEFAULT CURRENT_TIMESTAMP',
            'method TEXT',
            'reference TEXT',
            'proof TEXT',
            'status TEXT DEFAULT \'pending\'',
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`
        ]);

        // 7. Assignment Rules — a composable, field-generic room-assignment rule set. `type` is one of
        // keep_together | separate_by | split_by | require_companion; `config` is the primary field name
        // (for keep_together/separate_by/split_by); `params` is a JSON blob with the type's extra config
        // (min_size, when-predicates, subject/needs predicates, min…); `hard` = must never be violated
        // (vs. a soft preference). See runAssignment for the semantics.
        await db.createTable(T.rules, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'type TEXT NOT NULL',
            'enabled INT DEFAULT 1',
            'priority INT DEFAULT 0',
            'config TEXT',
            'params TEXT DEFAULT \'{}\'',
            'hard INT DEFAULT 0',
            // NULL = the admin's conference rule; non-null = that location's own rule (coordinator). No FK.
            'location_id INT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);

        // 8. Dynamic Fields — the registration form. Each field owns a real column on the inscriptions
        // table (name = column). Feature behaviour is per-field and GENERIC over ANY field: `is_group`
        // marks the one field whose value groups attendees (portal groups); `is_unique` forbids
        // duplicate values (the dup guard). Room-assignment rules also reference fields by name. `role`
        // is legacy (kept only so the boot migration can derive the flags from old data).
        await db.createTable(T.fields, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'label TEXT NOT NULL',
            'type TEXT DEFAULT \'text\'',
            'options TEXT',
            'is_required INT DEFAULT 0',
            'sort_order INT DEFAULT 0',
            'width INT DEFAULT 100',
            'role TEXT DEFAULT \'\'',
            'is_group INT DEFAULT 0',
            'is_unique INT DEFAULT 0',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);

        // 9. Fee rules — dynamic pricing driven by the form fields. Evaluated in priority order on
        // top of the conference base fee: a 'set' rule fixes total_due, an 'add' rule adjusts it.
        await db.createTable(T.feeRules, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'label TEXT',
            'field_name TEXT',                 // '' / operator 'any' = unconditional
            'operator TEXT DEFAULT \'eq\'',    // eq|neq|contains|gt|gte|lt|lte|filled|empty|any
            'value TEXT',
            'action TEXT DEFAULT \'set\'',     // set | add
            'amount REAL DEFAULT 0',
            'priority INT DEFAULT 0',
            'enabled INT DEFAULT 1',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);

        // 10. Transport (2.11.0) — separate from the participation fee. A bus is a trip (origin → destination,
        // departure) with seats and a price; a ticket puts one attendee on one bus at the price it had when
        // sold; transport payments pay tickets. A ticket's amount_paid / payment_status are derived from its
        // payments (recomputeTickets) and never touch the inscription's fee balance.
        await db.createTable(T.buses, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'origin TEXT',
            'destination TEXT',
            'departure DATETIME',
            'capacity INT NOT NULL',
            'price REAL DEFAULT 0',
            'notes TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);
        await db.createTable(T.tickets, [
            'id INT_PK',
            'bus_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'price REAL DEFAULT 0',
            'amount_paid REAL DEFAULT 0',
            'payment_status TEXT DEFAULT \'unpaid\'',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (bus_id) REFERENCES ${T.buses}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`
        ]);
        await db.createTable(T.transportPayments, [
            'id INT_PK',
            'ticket_id INT NOT NULL',
            'amount REAL NOT NULL',
            'method TEXT',
            'reference TEXT',
            'date DATETIME DEFAULT CURRENT_TIMESTAMP',
            'recorded_by TEXT',
            `FOREIGN KEY (ticket_id) REFERENCES ${T.tickets}(id) ON DELETE CASCADE`
        ]);

        // 11. Accounting (2.12.0): manual income / expense entries of a conference. The money the plugin
        // already receives (validated inscription payments, transport payments) is NOT copied here — the
        // ledger view reads it live, read-only, so it can never drift from its source.
        await db.createTable(T.ledger, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'kind TEXT NOT NULL',
            'date DATETIME NOT NULL',
            'category TEXT',
            'description TEXT NOT NULL',
            'amount REAL NOT NULL',
            'method TEXT',
            'reference TEXT',
            'recorded_by TEXT',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);

        // 12. Meals (2.14.0). A SERVICE is one meal on one day of a conference (unique per conference). The
        // LOCATION PLAN says which services each location gets; a per-attendee OVERRIDE adds ('include') or
        // removes ('exclude') one service against that plan; a DELIVERY records that an attendee received a
        // service — at most one per (service, attendee), guaranteed by a UNIQUE index (no transactions on
        // the bridge, so the index — not a read-then-write — is what stops a double scan). Indexed text
        // columns are VARCHAR: MySQL cannot index TEXT.
        await db.createTable(T.mealServices, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'service_date VARCHAR(10) NOT NULL',   // YYYY-MM-DD
            'meal VARCHAR(16) NOT NULL',           // desayuno | almuerzo | cena
            'label TEXT',
            'start_time VARCHAR(5)',               // HH:MM, NULL = the meal's default window (client side)
            'end_time VARCHAR(5)',
            'notes TEXT',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);
        await db.createTable(T.mealPlan, [
            'id INT_PK',
            'location_id INT NOT NULL',
            'service_id INT NOT NULL',
            `FOREIGN KEY (location_id) REFERENCES ${T.locations}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (service_id) REFERENCES ${T.mealServices}(id) ON DELETE CASCADE`
        ]);
        await db.createTable(T.mealOverrides, [
            'id INT_PK',
            'inscription_id INT NOT NULL',
            'service_id INT NOT NULL',
            'mode VARCHAR(8) NOT NULL',            // include | exclude (no row = inherit from the location)
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (service_id) REFERENCES ${T.mealServices}(id) ON DELETE CASCADE`
        ]);
        await db.createTable(T.mealDeliveries, [
            'id INT_PK',
            'service_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'delivered_by TEXT',
            'method VARCHAR(12)',                  // scan | manual | override
            'note TEXT',
            `FOREIGN KEY (service_id) REFERENCES ${T.mealServices}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`
        ]);
        await createUniqueIndex(`${P}uidx_meal_services_day`, T.mealServices, 'conference_id, service_date, meal');
        await createUniqueIndex(`${P}uidx_meal_plan_loc_svc`, T.mealPlan, 'location_id, service_id');
        await createIndex(`${P}idx_meal_plan_service`, T.mealPlan, 'service_id');
        await createUniqueIndex(`${P}uidx_meal_overrides_ins_svc`, T.mealOverrides, 'inscription_id, service_id');
        await createIndex(`${P}idx_meal_overrides_service`, T.mealOverrides, 'service_id');
        await createUniqueIndex(`${P}uidx_meal_deliveries_svc_ins`, T.mealDeliveries, 'service_id, inscription_id');
        await createIndex(`${P}idx_meal_deliveries_ins`, T.mealDeliveries, 'inscription_id');

        await createIndex(`${P}idx_inscriptions_conference`, T.inscriptions, 'conference_id');
        await createIndex(`${P}idx_inscriptions_room`, T.inscriptions, 'room_id');
        await createIndex(`${P}idx_rooms_hotel`, T.rooms, 'hotel_id');
        await createIndex(`${P}idx_hotels_conference`, T.hotels, 'conference_id');

        // Seed a default conference if none exists — with no form fields and no assignment rules, like every
        // new conference since 2.16.0 (the admin adds the fields, from the templates or their own).
        const count = await db.get(`SELECT COUNT(*) as count FROM ${T.conferences}`);
        if (!count || count.count === 0) {
            await db.run(
                `INSERT INTO ${T.conferences} (name, slug, status, description) VALUES (?, ?, ?, ?)`,
                ['Default Conference', 'default-conf', 'active', 'Initial system conference']
            );
        }
    }

    await initSchema();

    // ── shared helpers (pure; used by the migrations below and by every route) ───────────────────

    // HTTP-mapped validation error: routes `throw httpError(400, '...')` and every catch does
    // `sendError(res, e)` → res.status(e.status).json({ error: e.message }). Any other error is
    // unexpected: its text goes to the server log and the reply is generic, because the catch blocks
    // also serve the public form and the location portal, and a driver's message names tables and
    // constraints ("no such table: wjp_conference_manager_conferences").
    class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
    // `extra` (2.36.6): fields the answer carries too — `code`, a refusal the client tells apart.
    const httpError = (status, message, extra) => Object.assign(new HttpError(status, message), extra && extra.code ? { code: extra.code } : {});
    const sendError = (res, e) => {
        // `field` names the form field an error belongs to (the screens show it there).
        if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.field ? { field: e.field } : {}), ...(e.code ? { code: e.code } : {}) });
        console.error('[conference-manager] request failed:', e && e.message ? e.message : e);
        return res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
    };

    // Money: integer-cents arithmetic, 2-decimal results.
    // Upper bound: 1e13 (ten trillion) in whole currency units — far above any real fee, and still
    // exact in integer cents (1e15 < 2^53). Without it Number('1e400') → Infinity round-trips through
    // toCents as Infinity and a fee or a payment could store a non-finite total.
    const MAX_MONEY = 1e13;
    const toCents = (v) => Math.round((Number(v) || 0) * 100);
    const fromCents = (c) => c / 100;
    const roundMoney = (v) => fromCents(toCents(v));
    // Throws the route-level 400 for a non-finite or out-of-range amount; callers then apply their own
    // sign/zero rules on the rounded value.
    const assertMoneyRange = (v, what) => {
        const n = Number(v);
        if (!Number.isFinite(n) || Math.abs(n) > MAX_MONEY) throw httpError(400, `${what} está fuera de rango.`);
        return n;
    };
    // Inscription lifecycle states an admin may set directly (PUT /inscriptions/:id).
    const INSCRIPTION_STATUSES = new Set(['pending', 'active', 'cancelled']);

    // Forms of payment (closed vocabulary — cash or bank transfer). Each location enables the ones it
    // receives, stored as a JSON array in locations.payment_methods; NULL (a location created before the
    // column existed) means both. Every recorded payment, admin or coordinator, names one of these.
    const PAYMENT_METHODS = ['Efectivo', 'Transferencia'];
    // Body value → deduplicated array in catalog order. Throws 400 on anything outside the vocabulary.
    const parsePaymentMethods = (v) => {
        if (!Array.isArray(v)) throw httpError(400, 'Las formas de pago deben ser una lista.');
        const chosen = new Set(v.map(x => (typeof x === 'string' ? x.trim() : x)));
        for (const m of chosen) if (!PAYMENT_METHODS.includes(m)) throw httpError(400, `Forma de pago inválida: «${m}».`);
        return PAYMENT_METHODS.filter(m => chosen.has(m));
    };
    // Stored JSON (or NULL) of a location row → the enabled array, always in catalog order.
    const enabledPaymentMethods = (row) => {
        const stored = row && row.payment_methods;
        if (stored == null || stored === '') return PAYMENT_METHODS.slice();
        try { const arr = JSON.parse(stored); return Array.isArray(arr) ? PAYMENT_METHODS.filter(m => arr.includes(m)) : PAYMENT_METHODS.slice(); }
        catch { return PAYMENT_METHODS.slice(); }
    };
    // A payment's `method` must name a catalog entry (and, for the portal, one the location enables).
    const assertPaymentMethod = (method, allowed) => {
        const m = typeof method === 'string' ? method.trim() : '';
        if (!m) throw httpError(400, 'Indica la forma de pago.');
        if (!PAYMENT_METHODS.includes(m)) throw httpError(400, 'Forma de pago inválida.');
        if (allowed && !allowed.includes(m)) throw httpError(400, `La forma de pago «${m}» no está habilitada para esta localidad.`);
        return m;
    };


    // Guarded JSON.parse for custom_data — one malformed legacy row must never 500 a whole roster.
    const parseCd = (cd) => { if (typeof cd !== 'string') return cd || {}; try { const v = JSON.parse(cd || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

    // LIKE with user text: escape the wildcards with '!' (a backslash is banned in plugin SQL).
    const likeEscape = (s) => String(s).replace(/[!%_]/g, (m) => '!' + m);
    const LIKE_ESCAPE = ` ESCAPE '!'`;

    // Split a comma-separated options string into trimmed, non-empty option values.
    const fieldOptions = (field) => String(field.options || '').split(',').map(o => o.trim()).filter(Boolean);

    // Canonical text of a decimal number WITHOUT going through a double: a number field often holds an
    // identifier (cédula, NIT, passport, phone) longer than the 15-16 digits a double keeps, and
    // is_unique compares the stored text — String(Number('12345678901234567891')) would fold distinct
    // ids onto '12345678901234567000'. Accepts plain decimals only (optional sign, digits, optional
    // fraction); hex, exponent and Infinity forms are rejected (null) rather than rewritten.
    // "30.0" → "30", "0030" → "30", "12.50" → "12.5", "-0" → "0", ".5" → "0.5", "1e3" → null.
    const DECIMAL_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
    function canonicalNumber(text) {
        const s = String(text).trim();
        if (!DECIMAL_RE.test(s)) return null;
        let sign = '', body = s;
        if (body[0] === '+' || body[0] === '-') { sign = body[0] === '-' ? '-' : ''; body = body.slice(1); }
        const dot = body.indexOf('.');
        let int = dot === -1 ? body : body.slice(0, dot);
        let frac = dot === -1 ? '' : body.slice(dot + 1);
        int = int.replace(/^0+/, '') || '0';
        frac = frac.replace(/0+$/, '');
        if (int === '0' && frac === '') sign = '';
        return sign + int + (frac ? '.' + frac : '');
    }

    // Dynamic-field canonicalisation. ONE function for every write path and for /public/quote.
    // Returns the canonical STRING to store, '' for "empty", or undefined when the key was absent.
    // Throws HttpError(400) for a value that cannot be canonicalised.
    function canonicalFieldValue(field, raw, opts = {}) {
        if (raw === undefined) return undefined;
        if (raw === null) return '';
        if (typeof raw === 'object' || typeof raw === 'function') throw httpError(400, `El campo «${field.label || field.name}» tiene un formato inválido.`);
        const s = String(raw).trim();
        if (s === '') return '';
        // A phone (role 'phone' or type 'tel', 2.33.2) is stored in E.164: «+» / «00» keep their country, a national
        // number takes the conference's default country (opts.phoneCountry) and loses its leading «0».
        if (field.role === 'phone' || field.type === 'tel') {
            const e164 = phoneMod.toE164(s, opts.phoneCountry);
            if (!e164 && opts.lenientPhone) return s;
            if (!e164) throw httpError(400, `El campo «${field.label || field.name}» debe ser un número de teléfono válido (con su indicativo de país).`);
            return e164;
        }
        if (field.type === 'number') {
            const canon = canonicalNumber(s);   // textual: "30.0"→"30", "0030"→"30", "12.50"→"12.5"; 20 digits stay 20 digits
            if (canon === null) throw httpError(400, `El campo «${field.label || field.name}» debe ser un número.`);
            // «Edad» (2.32.0, role 'age'): whole years, 0–120 — the meal groups read it.
            if (field.role === 'age' && (!/^[0-9]+$/.test(canon) || Number(canon) > 120)) throw httpError(400, `El campo «${field.label || field.name}» debe ser una edad en años, de 0 a 120.`);
            return canon;
        }
        if (field.type === 'switch') {
            const k = s.toLowerCase();
            if (['sí', 'si', 'yes', 'true', '1', 'on'].includes(k)) return SWITCH_ON;
            if (['no', 'false', '0', 'off'].includes(k)) return SWITCH_OFF;
            throw httpError(400, `El campo «${field.label || field.name}» debe ser Sí o No.`);
        }
        if (field.type === 'select') {
            const opts = fieldOptions(field);
            if (opts.length && !opts.includes(s)) throw httpError(400, `El valor de «${field.label || field.name}» no es una opción válida.`);
        }
        return s;
    }
    // Apply canonicalisation to a body over the DEFINED fields of a conference. Only defined, writable
    // field names are taken from the body (unknown keys and reserved columns are ignored). Iterates the
    // defined fields, never the body keys, so a 50 000-key body costs O(fields).
    function canonicalFieldValues(confFields, body, opts = {}) {
        const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        const out = {};
        for (const f of confFields) {
            if (!isFieldColumn(f.name)) continue;
            const raw = Object.prototype.hasOwnProperty.call(src, f.name) ? src[f.name] : undefined;
            const v = canonicalFieldValue(f, raw, opts);
            if (v !== undefined) out[f.name] = v;
        }
        return out;
    }
    // Required check: '' and absent are both "missing". `onlyPresent` = PUT semantics (partial body).
    function assertRequired(confFields, values, onlyPresent) {
        for (const f of confFields) {
            if (!f.is_required || !isFieldColumn(f.name)) continue;
            if (onlyPresent && values[f.name] === undefined) continue;
            if (values[f.name] === undefined || values[f.name] === '') throw httpError(400, `El campo «${f.label || f.name}» es obligatorio.`);
        }
    }
    // Unique check. `scope` = { conference_id, location_id? } (the portal scopes to the coordinator's
    // OWN location so the 409 is not a cross-location probe oracle), excludeId for PUT.
    async function assertUnique(confFields, values, scope, excludeId) {
        for (const f of confFields) {
            if (!f.is_unique || !isFieldColumn(f.name)) continue;
            const v = values[f.name];
            if (v === undefined || v === '') continue;
            let sql = `SELECT id FROM ${T.inscriptions} WHERE conference_id = ? AND ${f.name} = ?`;
            const params = [scope.conference_id, v];
            if (scope.location_id != null) { sql += ` AND location_id = ?`; params.push(scope.location_id); }
            if (excludeId != null) { sql += ` AND id != ?`; params.push(excludeId); }
            if (await db.get(sql, params)) throw httpError(409, `Ya existe una inscripción con ese valor en «${f.label || f.name}» (campo sin duplicados).`);
        }
    }
    const FIELD_COLUMNS_SQL = `SELECT name, label, type, options, is_required, is_unique, role FROM ${T.fields} WHERE conference_id = ?`;
    // The default country of a conference's phone numbers (2.33.2; Campos › «Indicativo por defecto»).
    const phoneCountryOf = (conf) => (conf && phoneMod.isCountry(conf.phone_country) ? String(conf.phone_country).toUpperCase() : phoneMod.DEFAULT_COUNTRY);

    // Resolve the admin-supplied location for an inscription. `location_id` (preferred) must belong to
    // the conference; a legacy caller may still send the `location` NAME. Returns { id, name } or null
    // (no location), throws 400 when a location was named but does not exist in this conference.
    async function resolveAdminLocation(conferenceId, body) {
        if (body.location_id !== undefined) {
            if (body.location_id === null || body.location_id === '') return null;
            const lid = Number(body.location_id);
            const loc = Number.isInteger(lid) && lid > 0
                ? await db.get(`SELECT id, name, capacity FROM ${T.locations} WHERE id = ? AND conference_id = ?`, [lid, conferenceId]) : null;
            if (!loc) throw httpError(400, 'Localidad no encontrada en esta conferencia.');
            return loc;
        }
        if (typeof body.location === 'string' && body.location.trim()) {
            const loc = await db.get(`SELECT id, name, capacity FROM ${T.locations} WHERE conference_id = ? AND LOWER(name) = LOWER(?)`, [conferenceId, body.location.trim()]);
            if (!loc) throw httpError(400, 'Localidad no encontrada en esta conferencia.');
            return loc;
        }
        return undefined; // neither key present
    }

    // === LOCATION CAPACITY ===
    // A seat is taken by every inscription of the location that is not cancelled — cancelling frees it,
    // deleting frees it, moving the attendee to another location frees it here and takes one there.
    const occupiedSql = (col = 'status') => `(${col} IS NULL OR ${col} != 'cancelled')`;
    const MAX_CAPACITY = 1000000;

    async function locationOccupancy(locationId) {
        const row = await db.get(`SELECT COUNT(*) AS n FROM ${T.inscriptions} WHERE location_id = ? AND ${occupiedSql()}`, [locationId]);
        return Number(row && row.n) || 0;
    }

    // Admin-supplied capacity: a positive integer (strings from a form input are accepted). Throws 400.
    function parseCapacity(v) {
        // Only a number or a numeric string: Number(true) and Number([3]) coerce to 1 and 3 and must not.
        if (typeof v !== 'number' && typeof v !== 'string') throw httpError(400, 'El cupo máximo debe ser un número entero mayor que cero.');
        if (typeof v === 'string' && !v.trim()) throw httpError(400, 'El cupo máximo de inscritos es obligatorio.');
        const n = typeof v === 'string' ? Number(v.trim()) : v;
        if (!Number.isInteger(n) || n < 1 || n > MAX_CAPACITY) throw httpError(400, 'El cupo máximo debe ser un número entero mayor que cero.');
        return n;
    }

    // Throws 409 when `loc` ({ id, name, capacity }) has no free seat. A NULL capacity (a location created
    // before 2.3.0 whose limit was never set) is unlimited. A check alone is an early answer: the write that
    // takes the seat goes through takeSeat, which repeats it under the location's seat lock.
    async function assertLocationHasRoom(loc) {
        if (!loc || loc.capacity == null) return;
        const taken = await locationOccupancy(loc.id);
        if (taken >= loc.capacity) throw httpError(409, `La localidad «${loc.name}» ha alcanzado su cupo máximo de ${loc.capacity} inscritos.`);
    }
    // Seats (2.17.1): the count and the write that takes a seat run under ONE lock per location, so two
    // simultaneous registrations for the LAST seat cannot both pass (the bridge has no transactions; a
    // single child process makes an in-memory chain the whole picture). The capacity is re-read inside the
    // lock. Every write that takes a seat — the admin's and the portal's registrations, an edit that moves
    // or un-cancels an attendee into a location — goes through here. Map entries go once their chain drains.
    const seatLocks = new Map(); // location_id -> tail of its chain
    const withSeatLock = (locationId, fn) => {
        const key = String(locationId);
        const run = (seatLocks.get(key) || Promise.resolve()).then(fn, fn);
        const tail = run.then(() => {}, () => {});
        seatLocks.set(key, tail);
        tail.then(() => { if (seatLocks.get(key) === tail) seatLocks.delete(key); });
        return run;
    };
    function takeSeat(loc, write) {
        return withSeatLock(loc.id, async () => {
            const cur = await db.get(`SELECT id, name, capacity FROM ${T.locations} WHERE id = ?`, [loc.id]);
            if (!cur) throw httpError(409, `La localidad «${loc.name}» ya no existe.`);
            await assertLocationHasRoom(cur);
            return write();
        });
    }

    // «Pagos de cuotas» (2.18.0). THE money model lives in server/fee-payments.js: the payment headers, the
    // ONE definition of a part's effective status (fees.EFFECTIVE — every SQL that reads payment money goes
    // through it or through fees.personSum / fees.PERSON_MONEY) and the writes. Routes are installed later
    // (fees.install), once the request-time helpers exist.
    const fees = createFeePayments({ db, T, P, toCents, fromCents, addColumnIfMissing, createIndex, createUniqueIndex, httpError });
    // «Escarapelas» (2.19.0): the badge design, links, tickets and the PDF live in server/badges.js; its
    // routes are installed later (badges.install), once the request-time helpers exist.
    const badges = createBadges({ db, T, P, addColumnIfMissing, createIndex, createUniqueIndex, httpError });
    const selfPage = createSelfPage({ db, T, P, createIndex, createUniqueIndex });
    const packages = createPackages({ db, T, P, addColumnIfMissing, createIndex, createUniqueIndex });
    // Boarding and bus notices (2.27.0): bus state, the passengers' phones and Web Push live in server/transport-push.js.
    const push = createPush({ db, T, P, addColumnIfMissing, createIndex, createUniqueIndex });
    // «Condiciones de salud» and «Turnos de comida» (2.32.0): see server/health.js and server/meal-priority.js.
    const health = healthMod.createHealth({ db, T, P, createIndex, createUniqueIndex, addColumnIfMissing });
    // «Plantillas de correo» (2.36.11): see server/mail-templates.js.
    const mailTemplates = mailTplMod.createMailTemplates({ db, T, P, createUniqueIndex });
    const mealPriority = createMealPriority({ db, T, P, createIndex, createUniqueIndex });
    // «Autorización de datos» (2.33.0): see server/consent.js.
    const consent = createConsent({ db, T, P, createIndex, createUniqueIndex, addColumnIfMissing });
    /**
     * Set-based payment recompute: ONE statement for a set of inscriptions. `where` is 'id = ?' |
     * 'id IN (?, ?, …)' | 'conference_id = ?' | '1 = 1'. amount_paid / payment_status come from VALIDATED
     * live parts only (fees.recomputePayments), in a single statement, so two concurrent payment writes
     * cannot lose an update. `+ 0.005` = half-cent tolerance (ROUND(x, 2) is NOT portable).
     */
    const recomputePayments = (where, params) => fees.recomputePayments(where, params);
    const recomputePayment = (id) => recomputePayments('id = ?', [id]);

    // Run `writes` ([sql, params] pairs) through db.batch, chunked by COUNT (200 — the bridge's cap)
    // AND by BYTES: one db.batch call is ONE IPC frame, and the host rejects bridge-call args over
    // 32 MB (and the child pays the whole frame in heap before that). A payment proof is up to ~1.4 M
    // chars, so 200 inserts that each carry one would be a ~260 MB frame — chunk so no frame exceeds
    // BATCH_MAX_BYTES (a single oversized statement still travels alone, exactly like db.run would).
    // Sequential, NOT atomic — a failure mid-batch leaves the earlier statements applied.
    const BATCH_MAX_STATEMENTS = 200;
    const BATCH_MAX_BYTES = 4 * 1024 * 1024;
    // Same estimate the host applies to the args (string → chars, other scalars → 8, containers → 16).
    const statementBytes = ([sql, params]) => {
        let n = String(sql).length + 32;
        if (Array.isArray(params)) for (const p of params) n += typeof p === 'string' ? p.length : 8;
        return n;
    };
    async function runBatched(writes) {
        let chunk = [], bytes = 0;
        for (const w of writes) {
            const b = statementBytes(w);
            if (chunk.length && (chunk.length >= BATCH_MAX_STATEMENTS || bytes + b > BATCH_MAX_BYTES)) {
                await db.batch(chunk);
                chunk = []; bytes = 0;
            }
            chunk.push(w); bytes += b;
        }
        if (chunk.length) await db.batch(chunk);
    }

    // ── schema-follows-form migration (idempotent) ───────────────────────────────────────────────
    // 1. Ensure the `role` column exists on the fields table (installs whose table predates it).
    // 2. Ensure every already-defined form field has its real column on the inscriptions table.
    // (2.16.0: a conference with no field is a legitimate state — a new conference starts empty — so the
    //  old boot backfill that seeded default fields onto such a conference is gone; it would bring them
    //  back on every restart.)
    try {
        await addColumnIfMissing(T.fields, 'role', "TEXT DEFAULT ''");
        // Generic per-field feature flags (replaced the old fixed `role` mapping). Derive them ONCE from
        // the legacy roles, then clear those roles so a later admin toggle isn't overwritten every boot.
        await addColumnIfMissing(T.fields, 'is_group', 'INT DEFAULT 0');
        await addColumnIfMissing(T.fields, 'is_unique', 'INT DEFAULT 0');
        try { await db.run(`UPDATE ${T.fields} SET is_group = 1 WHERE role = 'family_group'`); } catch (e) {}
        try { await db.run(`UPDATE ${T.fields} SET is_unique = 1 WHERE role = 'document_number'`); } catch (e) {}
        try { await db.run(`UPDATE ${T.fields} SET role = '' WHERE role = 'family_group' OR role = 'document_number'`); } catch (e) {}
        // Assignment rules: composable model. Add params/hard, and rename the two legacy rule types.
        await addColumnIfMissing(T.rules, 'params', "TEXT DEFAULT '{}'");
        await addColumnIfMissing(T.rules, 'hard', 'INT DEFAULT 0');
        try { await db.run(`UPDATE ${T.rules} SET type = 'keep_together' WHERE type = 'group_together'`); } catch (e) {}
        try { await db.run(`UPDATE ${T.rules} SET type = 'separate_by' WHERE type = 'exclusive'`); } catch (e) {}
        // Payment validation: existing payments predate the feature → grandfather them to 'validated'.
        // ADD COLUMN's default only sets rows on the boot the column is first created; every NEW payment
        // is inserted with an explicit 'pending' status, so this never re-validates a genuinely pending one.
        await addColumnIfMissing(T.payments, 'status', "TEXT DEFAULT 'validated'");
        // Payment review audit trail (who validated/rejected, when).
        await addColumnIfMissing(T.payments, 'reviewed_at', 'DATETIME');
        await addColumnIfMissing(T.payments, 'reviewed_by', 'TEXT');
        // Location capacity (2.3.0): the maximum number of registrants a location accepts. Required on
        // every location created from now on; rows that predate the column stay NULL = no limit until the
        // admin sets one (the card shows it as unlimited). See assertLocationHasRoom.
        await addColumnIfMissing(T.locations, 'capacity', 'INT');
        // Forms of payment the location receives (JSON array; NULL = both, see enabledPaymentMethods).
        await addColumnIfMissing(T.locations, 'payment_methods', 'TEXT');
        // Lodging per location (2.5.0): rooms allotted to a location, the location's own assignment
        // rules, and the review state of its arrangement. Plain columns (no FK — see createTable).
        await addColumnIfMissing(T.rooms, 'location_id', 'INT');
        await addColumnIfMissing(T.rules, 'location_id', 'INT');
        await addColumnIfMissing(T.locations, 'lodging_status', "TEXT DEFAULT 'draft'");
        await addColumnIfMissing(T.locations, 'lodging_note', 'TEXT');
        await addColumnIfMissing(T.locations, 'lodging_submitted_at', 'DATETIME');
        await addColumnIfMissing(T.locations, 'lodging_reviewed_at', 'DATETIME');
        await addColumnIfMissing(T.locations, 'lodging_reviewed_by', 'TEXT');
        await addColumnIfMissing(T.locations, 'lodging_permission', 'INT DEFAULT 0');
        await addColumnIfMissing(T.locations, 'lodging_permission_until', 'DATETIME');
        await addColumnIfMissing(T.inscriptions, 'reg_code', 'VARCHAR(16)');
        await createIndex(`${P}idx_buses_conference`, T.buses, 'conference_id');
        await createIndex(`${P}idx_tickets_bus`, T.tickets, 'bus_id');
        await createIndex(`${P}idx_tickets_inscription`, T.tickets, 'inscription_id');
        await createIndex(`${P}idx_transport_payments_ticket`, T.transportPayments, 'ticket_id');
        await createIndex(`${P}idx_ledger_conference`, T.ledger, 'conference_id');
        try { await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_tickets_bus_inscription ON ${T.tickets} (bus_id, inscription_id)`); }
        catch (e) { console.warn('[conference-manager] ticket unique index skipped:', e.message); }
        // Deadline for the coordinators' lodging arrangements (NULL = none). Admin-only writes ignore it.
        await addColumnIfMissing(T.conferences, 'lodging_deadline', 'DATETIME');
        // Lodging dates (2.21.0): the general opening and its zone; a location's own dates. TEXT (not
        // DATETIME) keeps a bare date bare on every driver.
        await addColumnIfMissing(T.conferences, 'lodging_opens', 'TEXT');
        await addColumnIfMissing(T.conferences, 'lodging_tz', 'TEXT');
        // 2.36.6: «Los encargados pueden retirar inscripciones hasta» — a date-time in the conference's zone (lodging_tz);
        // NULL = coordinators cannot withdraw. A withdrawal is a cancellation that says who, when and why (withdrawn_*),
        // so every list, count, room, meal, badge and export that leaves cancelled people out leaves it out too.
        await addColumnIfMissing(T.conferences, 'withdraw_until', 'TEXT');
        await addColumnIfMissing(T.inscriptions, 'withdrawn_at', 'VARCHAR(19)');
        await addColumnIfMissing(T.inscriptions, 'withdrawn_by', 'TEXT');
        await addColumnIfMissing(T.inscriptions, 'withdraw_reason', 'TEXT');
        // 2.36.10: who registered the person and who last edited them (admin login / «portal:<locality>»), from now on;
        // and the «Historial» of each registration and edit (the fields' names, never their values). A row from
        // before has neither: its history says «Sin registro» for the registration.
        await addColumnIfMissing(T.inscriptions, 'created_by', 'TEXT');
        await addColumnIfMissing(T.inscriptions, 'updated_by', 'TEXT');
        await db.createTable(T.history, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'kind VARCHAR(12) NOT NULL',
            'actor VARCHAR(120)',
            'via VARCHAR(12)',
            'at_utc VARCHAR(19) NOT NULL',
            'fields TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_history_ins`, T.history, 'inscription_id');
        // 2.36.11: «Correo del encargado» of a locality, and the welcome e-mail sent to it (when, by whom), with its log.
        await addColumnIfMissing(T.locations, 'responsible_email', 'TEXT');
        await addColumnIfMissing(T.locations, 'welcome_sent_s', 'INT');
        await addColumnIfMissing(T.locations, 'welcome_sent_by', 'TEXT');
        await db.createTable(T.locationMails, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'location_id INT NOT NULL',
            'kind VARCHAR(12) NOT NULL',
            'email TEXT',
            'actor VARCHAR(120)',
            'at_s INT NOT NULL',
            'ok INT NOT NULL',
            'error TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_location_mails_loc`, T.locationMails, 'location_id');
        // 2.36.12: the address the last welcome went to — a changed «Correo del encargado» shows «No enviado al nuevo
        // correo». Rows stamped before the column take it from the send log.
        await addColumnIfMissing(T.locations, 'welcome_sent_to', 'TEXT');
        await db.run(`UPDATE ${T.locations} SET welcome_sent_to = (SELECT m.email FROM ${T.locationMails} m WHERE m.location_id = ${T.locations}.id AND m.kind = 'welcome' AND m.ok = 1 ORDER BY m.at_s DESC, m.id DESC LIMIT 1) WHERE welcome_sent_s IS NOT NULL AND welcome_sent_to IS NULL`);
        await db.createTable(T.locationLog, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'location_id INT NOT NULL',
            'kind VARCHAR(16) NOT NULL',
            'actor VARCHAR(120)',
            'at_s INT NOT NULL',
            'fields TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_location_log_loc`, T.locationLog, 'location_id');
        // Every withdrawal and every restore (the audit); kept when the person is deleted (no foreign key to them).
        await db.createTable(T.withdrawals, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'kind VARCHAR(10) NOT NULL',
            'actor TEXT',
            'at_utc VARCHAR(19) NOT NULL',
            'reason TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_withdrawals_ins`, T.withdrawals, 'inscription_id');
        // 2.33.2: the default country (ISO 3166 alpha-2) of the conference's phone numbers; NULL = CO.
        await addColumnIfMissing(T.conferences, 'phone_country', 'TEXT');
        await addColumnIfMissing(T.locations, 'lodging_opens', 'TEXT');
        await addColumnIfMissing(T.locations, 'lodging_closes', 'TEXT');
        await addColumnIfMissing(T.locations, 'lodging_order', 'INT');
        await addColumnIfMissing(T.rooms, 'share_lock', 'TEXT');
        await addColumnIfMissing(T.rooms, 'blocked', 'INT');
        // 2.36.6: who gave a room / a share of beds to a location — 'plan' («Sugerir reparto › Aplicar») or 'manual' (the
        // admin's allotments, «Dar camas»). NULL on a pool room; on an allotment made before 2.36.6 it reads as
        // 'manual' (the owner's choice): «Limpiar todas las asignaciones» frees the plan's, and the manual ones only
        // when asked.
        await addColumnIfMissing(T.rooms, 'allot_source', 'VARCHAR(8)');
        await addColumnIfMissing(T.roomBeds, 'allot_source', 'VARCHAR(8)');
        // 2.36.6: every «Limpiar todas las asignaciones» — who, when, and what it freed (the audit).
        await db.createTable(T.lodgingResets, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'actor TEXT',
            'at_utc VARCHAR(19) NOT NULL',
            'people INT NOT NULL',
            'plan_released INT NOT NULL',
            'manual_released INT NOT NULL',
            'manual_kept INT NOT NULL',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_lodging_resets_conf`, T.lodgingResets, 'conference_id');
        await addColumnIfMissing(T.inscriptions, 'room_locked', 'INT');
        // The «Requiere hospedaje» switch's column (2.31.0) exists even before a form adds the field, so the
        // engine's SQL can always read it (lodgingSql).
        await addColumnIfMissing(T.inscriptions, LODGING_FIELD, 'TEXT');
        // A hotel's position (2.23.0): 'lat,lng' (6 decimals) from the link or coordinates the admin pasted —
        // TEXT, never REAL (a Postgres REAL is float4 and would move the pin by metres).
        await addColumnIfMissing(T.hotels, 'geo', 'TEXT');
        // A fix holds only in its room (see «HELD BY THE ADMINISTRATION»): none left over from a bed since freed.
        try { await db.run(`UPDATE ${T.inscriptions} SET room_locked = NULL WHERE room_locked IS NOT NULL AND (room_id IS NULL OR room_locked <> room_id)`); } catch (e) { console.warn('[conference-manager] stale room_locked cleanup skipped:', e.message); }
        // The 2.8.0 permission becomes the location's own closing, once: the location could arrange until the
        // later of the general deadline and its permission's date (no date = until revoked → no closing). An
        // expired one keeps its date — closed, as it was. Cleared as it moves, so a reboot finds nothing.
        try {
            const granted = await db.all(`SELECT l.id, l.lodging_permission_until AS until_at, c.lodging_deadline AS deadline FROM ${T.locations} l JOIN ${T.conferences} c ON c.id = l.conference_id WHERE l.lodging_permission = 1`);
            for (const g of granted) {
                const until = lodgingDay(g.until_at), deadline = lodgingDay(g.deadline);
                const closes = !until ? LODGING_NO_CLOSE : (deadline && lodgingEnd(deadline, null) > lodgingEnd(until, null) ? deadline : until);
                await db.run(`UPDATE ${T.locations} SET lodging_closes = COALESCE(lodging_closes, ?), lodging_permission = 0, lodging_permission_until = NULL WHERE id = ?`, [closes, g.id]);
            }
        } catch (e) { console.warn('[conference-manager] lodging permission → own closing skipped:', e.message); }
        await createIndex(`${P}idx_rooms_location`, T.rooms, 'location_id');
        await createIndex(`${P}idx_room_beds_location`, T.roomBeds, 'location_id');
        try { await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_room_beds_room_location ON ${T.roomBeds} (room_id, location_id)`); }
        catch (e) { console.warn('[conference-manager] room_beds unique index skipped:', e.message); }
        await createIndex(`${P}idx_rules_location`, T.rules, 'location_id');
        // Stable location identity: `location_id` is the portal ISOLATION KEY; the free-text `location`
        // stays as the display label. ONE-OFF backfill from the label, run only on the boot that creates
        // the column (a 2.1.0 → 2.2.0 upgrade): afterwards a NULL location_id is a deliberate state —
        // DELETE /locations/:id detaches its attendees but keeps the label for history, and a later
        // location with the SAME name must never inherit them (identity is the id, not the name).
        // Names match case-insensitively (the same rule the 409 on POST/PUT /locations applies); with
        // duplicate legacy names the LOWEST id (the first created) wins — the admin can move attendees
        // with the inscription editor. No FK can be added by ALTER in SQLite, so DELETE /locations/:id
        // nulls location_id explicitly.
        const locationIdCreated = await addColumnIfMissing(T.inscriptions, 'location_id', 'INT');
        if (locationIdCreated) {
            await db.run(`UPDATE ${T.inscriptions} SET location_id = (SELECT MIN(l.id) FROM ${T.locations} l WHERE l.conference_id = ${T.inscriptions}.conference_id AND LOWER(l.name) = LOWER(${T.inscriptions}.location) ) WHERE location_id IS NULL AND location IS NOT NULL AND location != ''`);
        }
        await createIndex(`${P}idx_inscriptions_location`, T.inscriptions, 'conference_id, location_id');
        // Every field name → a real inscriptions column (TEXT; SQLite is flexibly typed).
        const fieldNames = await db.all(`SELECT DISTINCT name FROM ${T.fields}`);
        const knownCols = new Set();
        for (const f of fieldNames) { if (isFieldColumn(f.name)) { knownCols.add(f.name); await addColumnIfMissing(T.inscriptions, f.name, 'TEXT'); } }
        // 4. Backfill legacy custom_data JSON into the new real columns (only where the column is still
        //    empty, so this never clobbers a later edit). Keeps existing attendees' data visible.
        const legacy = await db.all(`SELECT id, custom_data FROM ${T.inscriptions} WHERE custom_data IS NOT NULL AND custom_data != '' AND custom_data != '{}'`);
        for (const row of legacy) {
            const data = parseCd(row.custom_data);
            for (const [k, v] of Object.entries(data)) {
                if (!knownCols.has(k)) continue;
                await db.run(`UPDATE ${T.inscriptions} SET ${k} = ? WHERE id = ? AND (${k} IS NULL OR ${k} = '')`, [v == null ? '' : String(v), row.id]);
            }
        }
        // 5. Canonicalise legacy number-field values ("30.0" → "30", "0030" → "30") so fee rules and
        //    is_unique match across the portal (which used to bind JS numbers as doubles) and the admin
        //    form (strings). Textual canonicalisation (canonicalNumber) — never through a double, so a
        //    20-digit identifier keeps its digits. Scoped per CONFERENCE: a column shared by name with a
        //    TEXT field of another conference is left alone there. Idempotent: a canonical value is never
        //    rewritten; a value that is not a plain decimal is skipped.
        const numberFields = await db.all(`SELECT conference_id, name FROM ${T.fields} WHERE type = 'number'`);
        for (const f of numberFields) {
            if (!isFieldColumn(f.name) || !knownCols.has(f.name)) continue;
            const rows = await db.all(`SELECT id, ${f.name} FROM ${T.inscriptions} WHERE conference_id = ? AND (${f.name} LIKE '%.%' OR ${f.name} LIKE '0%' OR ${f.name} LIKE '+%' OR ${f.name} LIKE '-0%' OR ${f.name} LIKE ' %' OR ${f.name} LIKE '% ')`, [f.conference_id]);
            const writes = [];
            for (const r of rows) {
                const cur = r[f.name] == null ? '' : String(r[f.name]);
                if (cur.trim() === '') continue;
                const canon = canonicalNumber(cur);
                if (canon !== null && canon !== cur) writes.push([`UPDATE ${T.inscriptions} SET ${f.name} = ? WHERE id = ?`, [canon, r.id]]);
            }
            if (writes.length) await runBatched(writes);
        }
    } catch (e) {
        console.warn('[conference-manager] schema-follows-form migration skipped:', e.message);
    }
    // (b0) Fee payments (2.18.0): the payment headers + their history, the parts' transfer_id / alloc_gen
    //      columns, their indexes, and the WRAP of every pre-2.18 payment into a 1-part payment
    //      (idempotent; see fees.wrapLegacyPayments). Its own block: when it fails (or a swallowed ALTER left
    //      a column out — migrate() ends with a schema probe) fees.ready stays false, and every money reader
    //      falls back to the pre-2.18 query (the part's own, mirrored status, no header join): the roster,
    //      the portal and the reports keep working, /portal/login and /portal/me advertise no «Pagos de
    //      cuotas», and the fee routes answer 503 `unavailable` after one more migration attempt of their own.
    try {
        await fees.migrate();
    } catch (e) {
        console.warn('[conference-manager] fee payments migration failed — «Pagos de cuotas» is unavailable until it succeeds:', e.message);
    }
    // Badges (2.19.0): their own tables; a failure leaves the badge routes answering 503 until a retry works.
    try {
        await badges.migrate();
    } catch (e) {
        console.warn('[conference-manager] badges migration failed — «Escarapelas» is unavailable until it succeeds:', e.message);
    }
    try {
        await selfPage.migrate();
    } catch (e) {
        console.warn('[conference-manager] self page migration failed — «Mi inscripción» is unavailable until it succeeds:', e.message);
    }
    try {
        await packages.migrate();
    } catch (e) {
        console.warn('[conference-manager] transport packages migration failed:', e.message);
    }
    try {
        await push.migrate();
    } catch (e) {
        console.warn('[conference-manager] bus notices migration failed — boarding notices are unavailable until it succeeds:', e.message);
    }
    try {
        await mailTemplates.migrate();
    } catch (e) {
        console.warn('[conference-manager] mail templates migration failed — the default e-mails are used:', e.message);
    }
    try {
        await health.migrate();
        await mealPriority.migrate();
    } catch (e) {
        console.warn('[conference-manager] health / meal groups migration failed:', e.message);
    }
    try {
        await consent.migrate();
    } catch (e) {
        console.warn('[conference-manager] data consent migration failed — consent links are unavailable until it succeeds:', e.message);
    }

    // ── one-time data hygiene (idempotent, safe to run every boot) ───────────────────────────────
    // (a) Purge garbage inscriptions bound to a non-existent conference — residue of the old admin
    //     createInscription arity bug that posted the whole form object as conference_id.
    // (a2) Fee payments (2.18.0): crashed drafts, orphan / stale-generation parts, headers without a live
    //     part, and the part status mirrors (fees.bootHygiene) — before the recompute below.
    // (b) Recompute amount_paid / payment_status from the live validated parts (the one recompute) so any
    //     row left stale by an interrupted write is corrected.
    try {
        // NOTE: keep a space before the closing ')' — the host SQL guard's table-attribution regex
        // captures up to whitespace/'('/';' but NOT ')', so `FROM ${T.conferences})` would read the
        // table name as '...conferences)' and wrongly deny it. `FROM ${T.conferences} )` parses clean.
        await db.run(`DELETE FROM ${T.inscriptions} WHERE conference_id NOT IN (SELECT id FROM ${T.conferences} )`);
        try { await fees.bootHygiene(); }
        catch (e) { console.warn('[conference-manager] fee payments hygiene skipped:', e.message); }
        await recomputePayments('1 = 1', []);
    } catch (e) {
        console.warn('[conference-manager] data hygiene skipped:', e.message);
    }
    // (b2) Meals (2.14.0): the FKs cascade, but a driver/session with foreign keys off would leave rows
    //      pointing at a deleted conference / location / attendee / service. Each statement reads ANOTHER
    //      table in its subquery (MySQL error 1093 forbids reading the target table), children first.
    try {
        await db.run(`DELETE FROM ${T.mealServices} WHERE conference_id NOT IN (SELECT id FROM ${T.conferences} )`);
        await db.run(`DELETE FROM ${T.mealDeliveries} WHERE service_id NOT IN (SELECT id FROM ${T.mealServices} )`);
        await db.run(`DELETE FROM ${T.mealDeliveries} WHERE inscription_id NOT IN (SELECT id FROM ${T.inscriptions} )`);
        await db.run(`DELETE FROM ${T.mealOverrides} WHERE service_id NOT IN (SELECT id FROM ${T.mealServices} )`);
        await db.run(`DELETE FROM ${T.mealOverrides} WHERE inscription_id NOT IN (SELECT id FROM ${T.inscriptions} )`);
        await db.run(`DELETE FROM ${T.mealPlan} WHERE service_id NOT IN (SELECT id FROM ${T.mealServices} )`);
        await db.run(`DELETE FROM ${T.mealPlan} WHERE location_id NOT IN (SELECT id FROM ${T.locations} )`);
    } catch (e) {
        console.warn('[conference-manager] meals hygiene skipped:', e.message);
    }
    // (b3) Meals (2.16.0): what the delivery card shows — a JSON array of keys per conference (NULL = the
    //      default, see mealDisplayOf). Its own idempotent ADD COLUMN, outside the migration block above:
    //      addColumnIfMissing never throws, and a failure there must not leave this column out. Every read
    //      of it tolerates its absence (the default applies), so a scan never fails over a display setting.
    await addColumnIfMissing(T.conferences, 'meal_display_fields', 'TEXT');
    // (b4) Lodging (2.17.0): the administration's adjustments of a submitted / validated arrangement (see
    //      stampAdminAdjustment). Outside the migration block for the same reason as (b3); every read
    //      tolerates their absence (no stamp), and the stamp and its reset are best-effort writes.
    await addColumnIfMissing(T.locations, 'lodging_admin_changed_at', 'DATETIME');
    await addColumnIfMissing(T.locations, 'lodging_admin_changed_by', 'TEXT');
    await addColumnIfMissing(T.locations, 'lodging_admin_changes', 'INT DEFAULT 0');
    // (c) Registration codes (2.9.0): unique index + a code for every attendee that has none — run at
    //     the end of init (see below), once the code generator exists.

    /**
     * 6-digit access code that gates a location's portal (SELECT ... WHERE id = ? AND code = ?). The
     * "webcrypto is unreachable / the db bridge exposes no RNG" note was FALSE: the host CSPRNG is
     * bridged as `wordjs.crypto.randomInt` (vendor-marketplace/event-tickets already use it). It matters
     * because Math.random is V8 xorshift128+ whose state is reconstructable from observed codes — a
     * predicted code defeats the per-location throttle that is the only OTHER defense for a short numeric
     * secret. Async (RPC to the host); randomInt is uniform in [lo, hi).
     */
    async function genAccessCode() {
        return String(await wordjs.crypto.randomInt(100000, 1000000)); // uniform 6-digit CSPRNG
    }

    // ── registration codes (2.9.0) ──────────────────────────────────────────────────────────────────
    // Every attendee gets a unique, random code (10 chars of a 32-letter alphabet without I/O/0/1 =
    // 50 bits) — the payload of the barcode the admin prints. Admin-only: no portal projection carries
    // it and no body may set it (RESERVED_INSCRIPTION_COLUMNS). Entropy comes from the host CSPRNG in
    // bulk (randomToken = up to 64 bytes per RPC, 256 % 32 = 0 so `byte % 32` is uniform), so a
    // backfill of thousands of rows costs a few hundred bridge calls, not one per character.
    const REG_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const REG_CODE_LEN = 10;
    async function randomRegCodes(n) {
        const out = [];
        while (out.length < n) {
            const hex = String(await wordjs.crypto.randomToken(64));
            for (let i = 0; i + 2 * REG_CODE_LEN <= hex.length && out.length < n; i += 2 * REG_CODE_LEN) {
                let code = '';
                for (let j = 0; j < REG_CODE_LEN; j++) code += REG_CODE_ALPHABET[parseInt(hex.substr(i + 2 * j, 2), 16) % 32];
                out.push(code);
            }
        }
        return out;
    }
    // A code not yet used by any attendee (collisions are ~2^-50 per pair; checked anyway, and the
    // UNIQUE index catches a race).
    async function newRegCode() {
        for (let attempt = 0; attempt < 5; attempt++) {
            const [code] = await randomRegCodes(1);
            const taken = await db.get(`SELECT id FROM ${T.inscriptions} WHERE reg_code = ?`, [code]);
            if (!taken) return code;
        }
        throw httpError(500, 'No se pudo generar un código de inscripción único.');
    }
    // Give every attendee without a code one (boot backfill + safety net). Batched writes.
    async function backfillRegCodes() {
        const rows = await db.all(`SELECT id FROM ${T.inscriptions} WHERE reg_code IS NULL OR reg_code = ''`);
        if (!rows.length) return 0;
        const codes = await randomRegCodes(rows.length);
        const seen = new Set((await db.all(`SELECT reg_code FROM ${T.inscriptions} WHERE reg_code IS NOT NULL`)).map(r => r.reg_code));
        const writes = [];
        for (let i = 0; i < rows.length; i++) {
            let code = codes[i];
            while (seen.has(code)) code = (await randomRegCodes(1))[0];
            seen.add(code);
            writes.push([`UPDATE ${T.inscriptions} SET reg_code = ? WHERE id = ? AND (reg_code IS NULL OR reg_code = '')`, [code, rows[i].id]]);
        }
        await runBatched(writes);
        return rows.length;
    }

    // In-process portal-login throttle (2.17.2; single child process → in-memory maps are the whole
    // picture, and every map is bounded). Only WRONG codes are counted, against three fixed-window budgets:
    //   - per client + location (req.clientKey = the host's HMAC of the caller's address): the ONLY
    //     budget that refuses. Another client's mistakes never lock this one out, and a right code
    //     clears only the caller's own count. It is charged synchronously BEFORE the code check is
    //     awaited (so a parallel burst cannot outrun it) and refunded when the code is right;
    //   - per location, all clients together, and site-wide (location ids are public): bound guessing
    //     spread over many addresses and many locations by slowing every attempt down once spent
    //     (escalating delay), never by refusing — a right code is never turned away for other callers'
    //     wrong ones. Only wrong codes for a location that exists are charged to them.
    // A signed-in coordinator never meets this: the portal session is an opaque server-side id (see
    // PORTAL AUTH HELPER), not something carrying the code.
    const LOGIN_LIMITS = {
        perClient: 6, clientWindowMs: 10 * 60 * 1000,
        perLocation: 20, perSite: 100, sharedWindowMs: 60 * 60 * 1000,
        // Past a shared budget every attempt waits before its code is checked: delayBaseMs, doubling
        // every delayDoubleEvery further wrong codes, up to delayMaxMs.
        delayBaseMs: 250, delayDoubleEvery: 10, delayMaxMs: 8000,
    };
    const LOGIN_MAP_CAP = 5000;
    const loginBuckets = { client: new Map(), location: new Map(), site: new Map() };
    const loginBucket = (map, key, windowMs, now) => {
        let b = map.get(key);
        if (!b || now - b.first >= windowMs) {
            if (!b && map.size >= LOGIN_MAP_CAP) {
                for (const [k, v] of map) if (now - v.first >= windowMs) map.delete(k);
                while (map.size >= LOGIN_MAP_CAP) map.delete(map.keys().next().value);
            }
            b = { count: 0, first: now };
            map.set(key, b);
        }
        return b;
    };
    /** A bucket's live count, without creating one (an unknown id never becomes a map key). */
    const loginCount = (map, key, windowMs, now) => {
        const b = map.get(key);
        return b && now - b.first < windowMs ? b.count : 0;
    };
    /**
     * Charge one attempt for `locationId` to the caller's own budget: null when it is spent (the only
     * refusal), else { delayMs, failed(), succeeded() }. `delayMs` is how long the attempt waits before
     * its code is checked, from the shared budgets; failed() charges them (call it only for a wrong
     * code on a location that exists); succeeded() refunds the caller's own attempt.
     */
    const beginLoginAttempt = (req, locationId) => {
        const now = Date.now(), L = LOGIN_LIMITS;
        const clientKey = `${String((req && req.clientKey) || 'anon').slice(0, 64)}|${locationId}`;
        const own = loginBucket(loginBuckets.client, clientKey, L.clientWindowMs, now);
        if (own.count >= L.perClient) return null;
        own.count++;
        const excess = Math.max(
            loginCount(loginBuckets.location, String(locationId), L.sharedWindowMs, now) - L.perLocation,
            loginCount(loginBuckets.site, '*', L.sharedWindowMs, now) - L.perSite
        );
        const delayMs = excess < 0 ? 0
            : Math.min(L.delayMaxMs, L.delayBaseMs * 2 ** Math.floor(excess / L.delayDoubleEvery));
        let settled = false;
        return {
            delayMs,
            failed() {
                if (settled) return;
                settled = true;
                const at = Date.now();
                loginBucket(loginBuckets.location, String(locationId), L.sharedWindowMs, at).count++;
                loginBucket(loginBuckets.site, '*', L.sharedWindowMs, at).count++;
            },
            succeeded() {
                if (settled) return;
                settled = true;
                loginBuckets.client.delete(clientKey); // the caller's own record only
            },
        };
    };
    const loginPause = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null);

    // Serialize the auto-assigner: it loads occupancy into memory then writes in a loop, so two
    // concurrent runs (or a run racing a manual assign) would double-book. Chain them instead.
    let assignmentLock = Promise.resolve();
    const withAssignmentLock = (fn) => {
        const run = assignmentLock.then(fn, fn);
        assignmentLock = run.then(() => {}, () => {});
        return run;
    };
    // Meals (2.14.0): plan / override writes are read-then-write sets, and so is the deletion of what they
    // hang from (a conference, location, attendee or service). Both run under this lock and re-read their
    // parents INSIDE it, so a plan or override row can never be written for a parent deleted meanwhile
    // (no transactions on the bridge). Deliveries are NOT serialised: their UNIQUE index decides, and the
    // deliver route re-checks its parents after inserting (see POST /meals/deliver).
    let mealsLock = Promise.resolve();
    const withMealsLock = (fn) => {
        const run = mealsLock.then(fn, fn);
        mealsLock = run.then(() => {}, () => {});
        return run;
    };

    // Accept '' / null (→ null) or a parseable date; throw 400 on an unparseable non-empty string.
    const normDate = (v, label) => {
        if (v === undefined || v === null || v === '') return null;
        if (isNaN(new Date(v).getTime())) throw httpError(400, `Fecha inválida (${label})`);
        return v;
    };

    // Base fee from a body value: undefined → null (caller keeps the current one); non-numeric → 400.
    const normFee = (v) => {
        if (v === undefined) return null;
        const n = Number(v === '' || v === null ? 0 : v);
        if (!Number.isFinite(n)) throw httpError(400, 'La cuota debe ser un número.');
        assertMoneyRange(n, 'La cuota');
        const fee = roundMoney(n);
        if (fee < 0) throw httpError(400, 'La cuota no puede ser negativa.');
        return fee;
    };

    // A payment proof must be an image data URL of at most ~1 MB (1 MB of image → ~1.37 M base64 chars).
    const PROOF_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
    const MAX_PROOF_CHARS = 1400000;
    // ...and of a sane SIZE IN PIXELS (2.18.0). A few hundred KB of PNG can declare 30000 × 30000 pixels
    // (deflated zeros compress ~1000:1): the browser that shows it — the admin review queue opens the oldest
    // receipt by itself — tries to decode gigabytes and the tab dies. The phone shrinks a real receipt to
    // ≤ 1600 px; a caller of the API skips that, so the declared size is read from the image header here.
    const MAX_PROOF_SIDE = 8192;
    const MAX_PROOF_PIXELS = 24000000;
    /**
     * The pixel size a PNG / GIF / WebP / JPEG declares in its header: { w, h } (for a GIF the largest of the
     * logical screen and every frame), or null when the header cannot be read. `bin` = the decoded bytes as a
     * binary string (atob).
     */
    function proofImageSize(kind, bin) {
        const u8 = (i) => (i < bin.length ? bin.charCodeAt(i) & 0xff : -1);
        const be16 = (i) => (u8(i) << 8) | u8(i + 1);
        const le16 = (i) => u8(i) | (u8(i + 1) << 8);
        const be32 = (i) => ((u8(i) << 24) >>> 0) + (u8(i + 1) << 16) + (u8(i + 2) << 8) + u8(i + 3);
        if (bin.length < 24) return null;
        if (kind === 'png') {
            if (bin.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || bin.slice(12, 16) !== 'IHDR') return null;
            return { w: be32(16), h: be32(20) };
        }
        if (kind === 'gif') {
            if (!/^GIF8[79]a/.test(bin.slice(0, 6))) return null;
            let w = le16(6), h = le16(8);
            let i = 13;
            if (u8(10) & 0x80) i += 3 * (2 << (u8(10) & 7));
            const skipBlocks = () => { while (i < bin.length) { const n = u8(i); i += 1; if (n <= 0) return n === 0; i += n; } return false; };
            for (let guard = 0; guard < 100000 && i < bin.length; guard++) {
                const b = u8(i);
                if (b === 0x3b) break;                                                  // trailer
                if (b === 0x21) { i += 2; if (!skipBlocks()) return null; continue; }  // extension
                if (b !== 0x2c) return null;                                            // not a GIF block
                w = Math.max(w, le16(i + 1) + le16(i + 5));
                h = Math.max(h, le16(i + 3) + le16(i + 7));
                const packed = u8(i + 9);
                i += 10;
                if (packed & 0x80) i += 3 * (2 << (packed & 7));
                i += 1;                                                                 // LZW minimum code size
                if (!skipBlocks()) return null;
            }
            return { w, h };
        }
        if (kind === 'webp') {
            if (bin.slice(0, 4) !== 'RIFF' || bin.slice(8, 12) !== 'WEBP') return null;
            const chunk = bin.slice(12, 16);
            if (chunk === 'VP8 ') return u8(23) === 0x9d && u8(24) === 0x01 && u8(25) === 0x2a ? { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff } : null;
            if (chunk === 'VP8L') {
                if (u8(20) !== 0x2f) return null;
                const bits = u8(21) | (u8(22) << 8) | (u8(23) << 16) | ((u8(24) << 24) >>> 0);
                return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
            }
            if (chunk === 'VP8X') return { w: (u8(24) | (u8(25) << 8) | (u8(26) << 16)) + 1, h: (u8(27) | (u8(28) << 8) | (u8(29) << 16)) + 1 };
            return null;
        }
        // JPEG: walk the segments to the first frame header (SOF0..SOF15 except DHT / JPG / DAC).
        if (u8(0) !== 0xff || u8(1) !== 0xd8) return null;
        let i = 2;
        while (i + 3 < bin.length) {
            if (u8(i) !== 0xff) return null;
            let m = u8(i + 1);
            while (m === 0xff && i + 2 < bin.length) { i += 1; m = u8(i + 1); }     // fill bytes
            if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }         // markers without a length
            if (m === 0xd9 || m === 0xda) return null;                                // end / scan before any frame header
            const len = be16(i + 2);
            if (len < 2) return null;
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: be16(i + 7), h: be16(i + 5) };
            i += 2 + len;
        }
        return null;
    }
    function assertProof(proof) {
        const p = typeof proof === 'string' ? proof.trim() : '';
        if (!p) throw httpError(400, 'El comprobante es obligatorio.');
        if (p.length > MAX_PROOF_CHARS) throw httpError(400, 'El comprobante es demasiado grande (máximo 1 MB).');
        const m = PROOF_RE.exec(p);
        if (!m) throw httpError(400, 'El comprobante debe ser una imagen (PNG, JPG, GIF o WebP).');
        let bin = '';
        try { bin = atob(p.slice(p.indexOf(',') + 1)); } catch { bin = ''; }
        const size = proofImageSize(m[1] === 'jpg' || m[1] === 'jpeg' ? 'jpeg' : m[1], bin);
        if (!size || !(size.w > 0) || !(size.h > 0)) throw httpError(400, 'El comprobante no es una imagen válida.');
        if (size.w > MAX_PROOF_SIDE || size.h > MAX_PROOF_SIDE || size.w * size.h > MAX_PROOF_PIXELS) {
            throw httpError(400, `El comprobante es una imagen demasiado grande (${size.w} × ${size.h} px; máximo ${MAX_PROOF_SIDE} px por lado y 24 megapíxeles).`);
        }
        return p;
    }
    const shortText = (v, max) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));

    // ── lodging per location (2.5.0) — shared helpers ────────────────────────────────────────────
    // A room with a non-null `location_id` is ALLOTTED to that location: only its attendees may sleep
    // there (roomAllows). A location is DELEGATED when it has at least one allotted room, and FROZEN
    // while its arrangement is under review (lodging_status submitted | validated).
    const frozenSqlOf = (col) => `COALESCE(${col}, 'draft') IN ('submitted', 'validated')`;
    const frozenSql = frozenSqlOf('lodging_status');
    const LODGING_STATUSES = new Set(['draft', 'submitted', 'validated']);
    const lodgingStatusOf = (row) => (row && LODGING_STATUSES.has(row.lodging_status) ? row.lodging_status : 'draft');
    const isFrozen = (row) => lodgingStatusOf(row) !== 'draft';
    // Invariant 1: a pool room takes anyone; an allotted room takes only its location's attendees.
    const roomAllows = (room, person) => room.location_id == null || Number(room.location_id) === Number(person.location_id);
    // Rooms SHARED between locations (2.18.0, «camas por localidad»). A room's beds may be split between
    // several locations — rows of room_beds (room_id, location_id, beds) — the rest of its capacity being
    // POOL beds. So a room is one of:
    //   POOL   — location_id NULL, no share: anyone; the admin's conference-wide assignment fills it;
    //   WHOLE  — location_id = L, no share: only L's attendees (2.5.0, unchanged);
    //   SHARED — location_id NULL, ≥1 share: each sharing location fills up to its beds; the remaining
    //            capacity − Σ beds are pool beds that anyone may take.
    // A sharing location's occupants use its beds first; any beyond them (an admin's manual placement)
    // use pool beds, as do the occupants of every other location. A location with a share is DELEGATED
    // like one with a whole room.
    async function sharesByRoom(roomIds) {
        const map = new Map();
        const ids = [...new Set((roomIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
        for (let i = 0; i < ids.length; i += 400) {
            const chunk = ids.slice(i, i + 400);
            const rows = await db.all(`SELECT room_id, location_id, beds FROM ${T.roomBeds} WHERE room_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY id`, chunk);
            for (const r of rows) {
                const k = Number(r.room_id);
                if (!map.has(k)) map.set(k, []);
                map.get(k).push({ location_id: Number(r.location_id), beds: Math.max(0, Number(r.beds) || 0) });
            }
        }
        return map;
    }
    const roomCapacityOf = (room) => Math.max(1, Number(room.capacity) || 1);
    // Beds of a room's `shares` given to `locationId` (0 = none).
    const shareBedsOf = (shares, locationId) => {
        if (locationId == null) return 0;
        const share = (shares || []).find(x => Number(x.location_id) === Number(locationId));
        return share ? share.beds : 0;
    };
    // Pool beds of a room: all of a pool room, none of a whole room, capacity − Σ beds of a shared one.
    const poolBedsOf = (room, shares) => {
        if (room.location_id != null) return 0;
        const given = (shares || []).reduce((n, x) => n + x.beds, 0);
        return Math.max(0, roomCapacityOf(room) - given);
    };
    // Pool beds in use by `occupants`: each occupant of a location without a share in the room, plus a
    // sharing location's occupants beyond its beds.
    const poolUsedOf = (shares, occupants) => {
        const byLoc = new Map();
        let pool = 0;
        for (const o of occupants || []) {
            const lid = o.location_id == null ? null : Number(o.location_id);
            if (!shareBedsOf(shares, lid)) { pool++; continue; }
            byLoc.set(lid, (byLoc.get(lid) || 0) + 1);
        }
        for (const [lid, n] of byLoc) pool += Math.max(0, n - shareBedsOf(shares, lid));
        return pool;
    };
    // Invariant 1 with shares: may `person` take a bed of `room` (holding `occupants`) now?
    const bedFreeFor = (room, shares, occupants, person) => {
        const others = (occupants || []).filter(o => Number(o.id) !== Number(person.id));
        if (others.length >= roomCapacityOf(room)) return false;
        if (room.location_id != null) return Number(room.location_id) === Number(person.location_id);
        if (!shares || !shares.length) return true;
        const lid = person.location_id == null ? null : Number(person.location_id);
        const mine = shareBedsOf(shares, lid);
        if (mine && others.filter(o => o.location_id != null && Number(o.location_id) === lid).length < mine) return true;
        return poolUsedOf(shares, others) < poolBedsOf(room, shares);
    };
    // The locations with a share in any room (they are delegated, like the owners of whole rooms).
    const SHARE_LOCATIONS_SQL = () => `SELECT DISTINCT location_id FROM ${T.roomBeds}`;
    // The rooms a location has beds in — its whole rooms and the rooms it shares. Takes [locationId, locationId].
    const LOCATION_ROOMS_SQL = () => `SELECT id FROM ${T.rooms} WHERE location_id = ? UNION SELECT room_id FROM ${T.roomBeds} WHERE location_id = ?`;
    // THE CLASS OF A SHARED ROOM (2.21.0; the owner: «si el motor comparte habitación entre dos localidades es obligatorio
    // que se quede el género que asignó el motor a esa habitación»). When «Sugerir reparto» shares a room, the value its
    // people have for each hard «Separar por» field (the gender, usually) is written on the room — `share_lock`, JSON
    // [{ field, value }] — and binds every bed of it from then on, even while the room is empty: the engine's runs, the
    // planner, a coordinator's placement and the admin's never put there anyone with another value (a blank value is no
    // value, as for the rule itself). In force only while the room is shared and only on a field an enabled hard «Separar
    // por» rule (the conference's or a location's) still separates by; the admin frees it in «Repartir camas».
    const parseShareLock = (raw) => {
        let v = raw;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
        return Array.isArray(v) ? v.filter(x => x && typeof x.field === 'string' && x.value != null && String(x.value).trim() !== '').map(x => ({ field: x.field, value: String(x.value).trim() })) : [];
    };
    // The class in force for `room`: `shared` = its shares (or how many), `lockFields` = lockFieldsOf(…).
    const shareLockOf = (room, shared, lockFields) => {
        const n = Array.isArray(shared) ? shared.length : Number(shared) || 0;
        if (!room || room.location_id != null || !n || !room.share_lock) return [];
        return parseShareLock(room.share_lock).filter(x => lockFields.has(x.field));
    };
    const lockAllows = (lock, person) => !lock || lock.every(x => {
        const v = ruleVal(person, x.field);
        return v == null || String(v).trim() === '' || String(v).trim().toLowerCase() === x.value.toLowerCase();
    });
    // The fields a class binds: those of the enabled hard «Separar por» rules on the form.
    const lockFieldsOf = (ruleRows, fieldNames) => new Set(ruleRows.map(parseRuleRow).filter(ruleOnFormFields(fieldNames))
        .filter(r => r.enabled && r.type === 'separate_by' && r.hard && r.field).map(r => r.field));
    async function shareLockFields(conferenceId) {
        return lockFieldsOf(await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND type = 'separate_by' ORDER BY priority DESC, id ASC`, [conferenceId]), await ruleFieldNames(conferenceId));
    }
    // A placement into a shared room whose class is fixed: 409 when the person has another value.
    async function assertShareLock(room, person, conferenceId, { admin = false } = {}) {
        if (!room || room.location_id != null || !room.share_lock) return;
        const shares = (await sharesByRoom([room.id])).get(Number(room.id)) || [];
        const lock = shareLockOf(room, shares, await shareLockFields(conferenceId));
        const p = { ...person, custom_data: parseCd(person.custom_data) };
        const bad = lock.find(x => !lockAllows([x], p));
        if (!bad) return;
        const mine = String(ruleVal(p, bad.field)).trim();
        // The gender in words (the form's options may be letters: «M» / «F»); any other value as the form spells it.
        const word = (v, plural) => {
            const s = String(v).trim().toLowerCase();
            if (bad.field === 'gender' && /^(f|fem|femenin[oa]|female|woman|mujer|mulher|feminino)$/.test(s)) return plural ? 'mujeres' : 'mujer';
            if (bad.field === 'gender' && /^(m|masc|masculin[oa]|male|man|hombre|homem|var[oó]n)$/.test(s)) return plural ? 'hombres' : 'hombre';
            return null;
        };
        const forRoom = word(bad.value, true) || `«${bad.value}»`;
        const who = word(mine, false) ? `esta persona es ${word(mine, false)}` : `esta persona tiene «${mine}»`;
        throw httpError(409, `Esta habitación es compartida entre localidades y el reparto la dejó solo para ${forRoom}; ${who}. `
            + (admin ? 'Para cambiarlo, libera la habitación en «Repartir camas».' : 'Elige otra habitación.'));
    }
    // HELD BY THE ADMINISTRATION (2.21.0; the owner: «el admin puede bloquear a alguien una habitación o bloquear una
    // habitación entera para que la siguiente sugerencia no los tenga en cuenta»; «solo el admin» changes them by hand).
    // `rooms.blocked`: a room the engine leaves exactly as it is — no run (the admin's, a coordinator's, the overflow),
    // no «Sugerir reparto» (not even «Rehacer todo»), no «Dar camas» places anyone in it or moves anyone out, and no
    // reset empties it. `inscriptions.room_locked`: the room a person was fixed in, held the same way — only while they
    // are in THAT room: whatever takes them out of it (the admin by hand, a cancellation, a change of location, a room,
    // hotel or location deleted) ends the fix, and a later placement never inherits it. Both hold until the
    // administration lifts them. A coordinator can neither place anyone in a blocked room nor take anyone out of it, nor
    // move a fixed person (409); only who manages lodging does it by hand (an edit that would free a held bed included).
    const isBlocked = (room) => !!(room && Number(room.blocked));
    const isPinned = (p) => !!(p && p.room_id != null && Number(p.room_locked) > 0 && Number(p.room_locked) === Number(p.room_id));
    const HELD_ROOM_MSG = 'La administración bloqueó esta habitación: solo el administrador puede cambiar quién duerme en ella.';
    const HELD_PERSON_MSG = 'La administración fijó a esta persona en su habitación: solo el administrador puede moverla.';
    // People a reset may take out of their beds: not fixed ones, not those in a blocked room.
    const NOT_HELD_SQL = () => `(room_id IS NULL OR COALESCE(room_locked, 0) <> room_id) AND (room_id IS NULL OR room_id NOT IN (SELECT id FROM ${T.rooms} WHERE COALESCE(blocked, 0) = 1))`;
    // A room no longer shared keeps no class (so a later share starts free).
    const STALE_LOCKS_SQL = () => `UPDATE ${T.rooms} SET share_lock = NULL WHERE share_lock IS NOT NULL AND (location_id IS NOT NULL OR id NOT IN (SELECT room_id FROM ${T.roomBeds}))`;
    // `:id` route params (and body ids): a positive integer or null.
    const positiveInt = (v) => {
        if (typeof v !== 'number' && typeof v !== 'string') return null;
        if (typeof v === 'string' && !/^\s*[0-9]+\s*$/.test(v)) return null;
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
    };
    // Invariant 3 (2.17.0): a frozen location's rooms and occupants are read-only for its COORDINATOR — every
    // portal write answers 409 (assertPortalDraft) — but not for the administration. The site owner's rule:
    // the admin who validates (or is reviewing) an arrangement must be able to change it without reopening
    // it. So the admin-panel lodging writes (Hospedaje › gestionar: placements, allotments, rooms, hotels)
    // go through on a submitted / validated location, the status stays as it is, and every such change is
    // an ADMINISTRATION ADJUSTMENT recorded on the location (stampAdminAdjustment) — shown to the admin in
    // the review and on the location card, and to the coordinator in the portal. Bulk operations (the
    // conference-wide run and reset) still skip frozen locations: they arrange what nobody arranged by
    // hand, and must not rewrite (or empty) a reviewed arrangement as a side effect.
    //
    // The frozen row of a location id (null when the location is a draft or gone). `locationIdOrRow` may be
    // a row already carrying { id, name, lodging_status }.
    async function frozenLocationRow(locationIdOrRow) {
        if (locationIdOrRow == null) return null;
        const row = typeof locationIdOrRow === 'object' ? locationIdOrRow
            : await db.get(`SELECT id, name, lodging_status FROM ${T.locations} WHERE id = ?`, [locationIdOrRow]);
        return row && isFrozen(row) ? row : null;
    }
    // «ya está validado» / «está enviado a validación» — the frozen state of a row, for a message.
    const frozenPhrase = (row) => (lodgingStatusOf(row) === 'validated' ? 'ya está validado' : 'está enviado a validación');
    // How a frozen row becomes a draft again, for a message: a VALIDATED one is reopened (POST …/lodging/reopen,
    // which takes nothing else), a SUBMITTED one is returned to its coordinator (POST …/lodging/return).
    // Impersonal — whoever reads the refusal may not be the one who can do either.
    const releasePhrase = (row) => (lodgingStatusOf(row) === 'validated' ? 'cuando se reabra desde Localidades' : 'cuando se devuelva al encargado desde Localidades');
    // Record an administration adjustment on every location of `locationIds` that is frozen RIGHT NOW (a
    // compare-and-set on the status: a location that went back to draft meanwhile is not stamped). Callers
    // hold withAssignmentLock — where every lodging status transition runs too (submit, withdraw, validate,
    // return, reopen) — so the status cannot move between the write and its stamp. Best-effort: a failed
    // stamp (a column a failed migration left out) never undoes or fails the change itself. Returns the
    // stamped locations, as { location_id, name, status }, for the response (`lodging_adjusted`).
    async function stampAdminAdjustment(req, locationIds) {
        const ids = [...new Set((locationIds || []).map(positiveInt).filter(Boolean))];
        if (!ids.length) return [];
        const marks = ids.map(() => '?').join(', ');
        let stamped = null;
        try {
            const r = await db.run(
                `UPDATE ${T.locations} SET lodging_admin_changed_at = CURRENT_TIMESTAMP, lodging_admin_changed_by = ?, lodging_admin_changes = COALESCE(lodging_admin_changes, 0) + 1 WHERE id IN (${marks}) AND ${frozenSql}`,
                [actorOf(req), ...ids]);
            stamped = Number(r && r.changes) || 0;
        } catch (e) {
            console.warn('[conference-manager] lodging adjustment stamp skipped:', e && e.message);
        }
        if (stamped === 0) return [];
        const rows = await db.all(`SELECT id, name, lodging_status FROM ${T.locations} WHERE id IN (${marks}) AND ${frozenSql} ORDER BY name`, ids);
        return rows.map(l => ({ location_id: l.id, name: l.name, status: lodgingStatusOf(l) }));
    }
    // The stamp as the admin panel reads it (GET /locations, GET /locations/:id/lodging); `by` only for
    // whoever may read the review stamps (locations:view).
    const adminAdjustmentOf = (row, withActor) => {
        const n = Number(row && row.lodging_admin_changes) || 0;
        const at = row && row.lodging_admin_changed_at != null ? row.lodging_admin_changed_at : null;
        return {
            lodging_admin_changes: at ? n : 0,
            lodging_admin_changed_at: at,
            lodging_admin_changed_by: withActor && at && row.lodging_admin_changed_by != null ? row.lodging_admin_changed_by : null,
        };
    };

    // ── rule validation (shared by POST /assignment/rules and the portal's rule editor) ──────────
    // Fields a rule (or a predicate inside its params) may read: the conference's defined form fields
    // plus these base columns. Anything else (notes, custom_data, payment columns…) is rejected, so a
    // predicate can never be a read oracle over data the caller may not see.
    const BASE_RULE_FIELDS = ['first_name', 'last_name', 'gender', 'email', 'phone', 'document_number', 'family_group', 'location'];
    const PRED_OPS = new Set(['any', 'filled', 'empty', 'eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte']);
    const RULE_PARAMS_MAX_CHARS = 4096, RULE_MAX_PREDICATES = 20, RULE_PRIORITY_MAX = 1000000;
    // The field names a rule of this conference may read: its form's fields plus the columns the server
    // always fills (RULE_ALWAYS_FILLED: the location). 2.16.0 — every base field is a form field the admin
    // may delete, so a base column the form does not have (gender, family_group…) is no longer offered:
    // a rule on it could only read stale values.
    const RULE_ALWAYS_FILLED = Object.freeze(['location']);
    async function ruleFieldNames(conferenceId) {
        const rows = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [conferenceId]);
        return new Set([...RULE_ALWAYS_FILLED, ...rows.map(r => r.name).filter(isFieldColumn)]);
    }
    // Every field a parsed rule (parseRuleRow) reads: its main field and its conditions' fields.
    const ruleFieldsOf = (r) => [r.field, ...['when', 'subject', 'needs'].flatMap(k => (Array.isArray(r.params && r.params[k]) ? r.params[k].map(p => p && p.field) : []))]
        .filter(f => typeof f === 'string' && f !== '');
    // A rule reading a field the form no longer has (deleted while the form was unpublished) is SKIPPED by
    // the assignment engine and the lodging audits — like a price rule on a deleted field — never run on
    // whatever the column still holds. The admin's and the coordinators' pages flag it «no tiene efecto».
    const ruleOnFormFields = (names) => (r) => ruleFieldsOf(r).every(f => names.has(f));
    // Body → { name, type, enabled, priority, config, params (object), hard } or throws 400.
    function normalizeRule(body, { conferenceId, fieldNames }) {
        const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        const names = fieldNames instanceof Set ? fieldNames : new Set(fieldNames || BASE_RULE_FIELDS);
        const cleanName = typeof src.name === 'string' ? src.name.trim() : '';
        if (!cleanName) throw httpError(400, 'El nombre de la regla es obligatorio.');
        if (!RULE_TYPES.has(src.type)) throw httpError(400, 'Tipo de regla inválido.');
        const cfg = src.config == null ? '' : String(src.config).trim();
        if (cfg !== '' && !names.has(cfg)) throw httpError(400, 'El campo de la regla es inválido.');
        // params: a JSON object (a string body is parsed), bounded in size and in shape.
        let params;
        if (src.params == null) params = {};
        else if (typeof src.params === 'string') {
            const t = src.params.trim();
            if (!t) params = {};
            else { try { params = JSON.parse(t); } catch { params = null; } }
        } else params = src.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw httpError(400, 'Los parámetros de la regla no son JSON válido.');
        const invalid = () => httpError(400, 'Los parámetros de la regla son inválidos.');
        const out = { ...params };
        for (const k of ['min_size', 'min']) {
            if (out[k] === undefined || out[k] === null || out[k] === '') { delete out[k]; continue; }
            const n = typeof out[k] === 'number' || typeof out[k] === 'string' ? Number(out[k]) : NaN;
            if (!Number.isInteger(n) || n < 1) throw invalid();
            out[k] = n;
        }
        const normPred = (pr) => {
            if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw invalid();
            const op = pr.op == null || pr.op === '' ? 'eq' : pr.op;
            if (typeof op !== 'string' || !PRED_OPS.has(op)) throw invalid();
            const field = pr.field == null ? '' : String(pr.field).trim();
            if (field === '' ? op !== 'any' : !names.has(field)) throw invalid();
            const p = { field, op };
            if (pr.value !== undefined && pr.value !== null) {
                if (typeof pr.value === 'object' || typeof pr.value === 'function') throw invalid();
                const v = String(pr.value);
                if (v.length > 200) throw invalid();
                p.value = v;
            }
            return p;
        };
        for (const k of ['when', 'subject', 'needs']) {
            if (out[k] === undefined || out[k] === null) { delete out[k]; continue; }
            let arr = out[k];
            if (!Array.isArray(arr)) { if (arr && typeof arr === 'object') arr = [arr]; else throw invalid(); }
            if (arr.length > RULE_MAX_PREDICATES) throw invalid();
            out[k] = arr.map(normPred);
        }
        if (JSON.stringify(out).length > RULE_PARAMS_MAX_CHARS) throw invalid();
        let priority = 0;
        if (src.priority !== undefined && src.priority !== null && src.priority !== '') {
            priority = typeof src.priority === 'number' || typeof src.priority === 'string' ? Number(src.priority) : NaN;
            if (!Number.isInteger(priority) || Math.abs(priority) > RULE_PRIORITY_MAX) throw httpError(400, 'La prioridad de la regla debe ser un número entero.');
        }
        return {
            name: shortText(cleanName, 100),
            type: src.type,
            enabled: src.enabled === undefined ? 1 : (src.enabled ? 1 : 0),
            priority,
            config: cfg,
            params: out,
            hard: src.hard ? 1 : 0,
        };
    }
    // A stored rule row → the engine/audit shape (params parsed, flags as booleans).
    const parseRuleRow = (r) => {
        let params = {};
        try { params = r.params ? (typeof r.params === 'string' ? JSON.parse(r.params) : r.params) : {}; } catch { params = {}; }
        return { id: r.id, name: r.name, type: r.type, field: r.config, params: params && typeof params === 'object' ? params : {}, hard: !!r.hard, priority: Number(r.priority) || 0, enabled: r.enabled == null ? true : !!Number(r.enabled), location_id: r.location_id == null ? null : r.location_id };
    };
    // What a rule looks like on the wire (admin review + portal): params as an object.
    const ruleProjection = (r) => ({ id: r.id, name: r.name, type: r.type, config: r.config == null ? '' : r.config, params: parseRuleRow(r).params, hard: Number(r.hard) ? 1 : 0, priority: r.priority, enabled: r.enabled == null ? 1 : (Number(r.enabled) ? 1 : 0), location_id: r.location_id == null ? null : r.location_id });

    // ── dynamic pricing engine ───────────────────────────────────────────────────────────────────
    // Numeric-looking values compare by their canonical text ("30" == "30.0" == "0030"), everything
    // else case-insensitively — so a rule value `30` matches stored "30" and legacy "30.0" alike.
    // Same textual canonicalisation as the stored values (no double in between: long ids stay exact).
    const canonNumberish = (s) => { const c = canonicalNumber(s); return c === null ? s.toLowerCase() : c; };
    // 2.36.4 (the rule builder): a list value ('in' / 'not_in': the values picked; 'between': [from, to]) is stored
    // as JSON text in `value`; a date compares as its YYYY-MM-DD; `__person` conditions on WHO (the inscription id).
    const FEE_PERSON = '__person';
    const feeList = (v) => { try { const a = JSON.parse(String(v == null ? '' : v)); return Array.isArray(a) ? a.map(x => (x == null ? '' : String(x).trim())) : null; } catch { return null; } };
    const feeDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v).trim()); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
    // Compare two values as dates when both are, else as numbers (NaN never matches).
    const feeCmp = (a, b) => {
        const da = feeDate(a), db2 = feeDate(b);
        if (da && db2) return da < db2 ? -1 : da > db2 ? 1 : 0;
        const na = Number(a), nb = Number(b);
        if (String(a).trim() === '' || String(b).trim() === '' || !Number.isFinite(na) || !Number.isFinite(nb)) return NaN;
        return na < nb ? -1 : na > nb ? 1 : 0;
    };
    // Does a single fee rule match this attendee's field values?
    function feeRuleMatches(rule, values) {
        const field = rule.field_name || '';
        const op = rule.operator || 'eq';
        if (!field || op === 'any') return true;                 // unconditional
        const raw = values ? (field === FEE_PERSON ? values.id : values[field]) : undefined;
        if (op === 'filled') return raw != null && String(raw).trim() !== '';
        if (op === 'empty') return raw == null || String(raw).trim() === '';
        const a = raw == null ? '' : String(raw).trim();
        const b = rule.value == null ? '' : String(rule.value).trim();
        switch (op) {
            case 'eq': return canonNumberish(a) === canonNumberish(b);
            case 'neq': return canonNumberish(a) !== canonNumberish(b);
            case 'contains': return canonNumberish(a).includes(canonNumberish(b));
            case 'gt': return Number(a) > Number(b);
            case 'gte': return Number(a) >= Number(b);
            case 'lt': return Number(a) < Number(b);
            case 'lte': return Number(a) <= Number(b);
            case 'in': case 'not_in': {
                const list = feeList(rule.value) || [];
                const hit = a !== '' && list.some(v => canonNumberish(v) === canonNumberish(a));
                return op === 'in' ? hit : !hit;
            }
            case 'between': {
                // Either end may be open: [from, ''] is «from on», ['', to] «up to».
                const [lo, hi] = feeList(rule.value) || ['', ''];
                if (a === '' || (!lo && !hi)) return false;
                const okLo = !lo || feeCmp(a, lo) >= 0, okHi = !hi || feeCmp(a, hi) <= 0;
                return okLo === true && okHi === true;
            }
            case 'before': return feeCmp(a, b) < 0;
            case 'after': return feeCmp(a, b) > 0;
            default: return false;
        }
    }
    // A rule conditioned on a field the form no longer has (deleted while the form was unpublished) is
    // SKIPPED, never evaluated against an always-empty value — where «≠» / «vacío» would match everyone.
    // The Precios page flags such a rule. Unconditional rules (no field, or operator 'any') always apply,
    // and so do rules on a column the server fills itself, whatever the form has (FEE_ALWAYS_FILLED: the
    // attendee's location — client lib/fields.ts ALWAYS_THERE).
    const FEE_ALWAYS_FILLED = Object.freeze(['location']);
    async function loadFeeRules(conferenceId) {
        try {
            const rules = await db.all(`SELECT * FROM ${T.feeRules} WHERE conference_id = ? AND enabled = 1 ORDER BY priority ASC, id ASC`, [conferenceId]);
            if (!rules.length) return rules;
            const names = new Set([...FEE_ALWAYS_FILLED, ...(await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [conferenceId])).map(f => f.name).filter(isFieldColumn)]);
            return rules.filter(r => !r.field_name || r.operator === 'any' || r.field_name === FEE_PERSON || names.has(r.field_name));
        }
        catch { return []; }
    }
    // Compute total_due from the conference base fee + its enabled rules (priority order). A 'set'
    // rule fixes the running total; an 'add' rule adjusts it. Pure, integer cents; never negative.
    function applyFeeRules(rules, values, feeDefault) {
        let cents = toCents(feeDefault);
        for (const r of rules) {
            if (!feeRuleMatches(r, values)) continue;
            const a = toCents(r.amount);
            cents = r.action === 'add' ? cents + a : a;
        }
        return fromCents(Math.max(0, cents));
    }
    async function computeFee(conferenceId, values, feeDefault) {
        return applyFeeRules(await loadFeeRules(conferenceId), values, feeDefault);
    }

    // === TEAM & PERMISSIONS (2.15.0) ===
    // Several people work in this panel, each on some sections only. A WordJS ADMINISTRATOR adds a WordJS
    // user to the conference TEAM (staff_members) with a ROLE (staff_roles); the role grants one level per
    // SECTION, none < view < manage (a section without a level, or with an unknown key or level, is none).
    // Administrators always have every section at its highest level and alone manage the team; a role has
    // no conference / location scope (it applies to everything in its sections).
    //
    // TEAM ROLE (2.16.0). The manifest declares ONE WordJS role, TEAM_ROLE («Equipo de conferencia»), whose
    // only own capability is TEAM_CAPABILITY (the core adds `read` + `access_admin_panel`, nothing else):
    // an account with that role reaches the admin shell, its own account page and THIS plugin's page —
    // no other admin page. WHO may be on the team is decided by that CAPABILITY: the team role carries it,
    // and an administrator may also give it to another role in Usuarios › Roles (an editor who also runs
    // registrations keeps every editorial screen AND gets this one). The host tells the plugin the
    // capability on both wires — req.user.pluginCapabilities and the users bridge's projection — and a host
    // that sends neither (older than 2.16.0) is answered by the role alone. Only such accounts can join
    // the team (POST /staff/members); a member whose account no longer has the capability (an editor added
    // before 2.16.0, a role changed in Usuarios) keeps their row — flagged in the team list — but gets no
    // section until it is given back. The team role (staff_roles) still decides WHAT each member sees.
    //
    // The host knows only { auth } / { admin } for isolated routes and forwards req.user without any core
    // capability (at most this plugin's own, as pluginCapabilities), so every admin-panel route is
    // registered { auth: true } and GATES ITSELF as the first statement of its handler —
    // `if (!await allow(req, res, section, level)) return;` (or allowAny / isStaff). A refusal is
    // 403 { error: 'No tienes acceso a esta sección.' }. The coordinator portal (/portal/*: a location code)
    // and the public form (/public/*) keep their own authentication.
    //
    // ROUTE → PERMISSION (reads = view, writes = manage; «staff» = any active team member or administrator;
    // «a | b» = any of them; «admin» = administrators only, enforced by the host AND in the handler):
    //   GET    /list                                   staff (context: the conference list)
    //   POST   /create                                 settings:manage
    //   PUT    /:id                                    settings:manage — a body that ONLY sets the lodging dates
    //                                                  (lodging_opens, lodging_deadline, lodging_tz — the «fechas» of
    //                                                  Localidades): locations:manage | settings:manage
    //   DELETE /:id                                    settings:manage, plus manage on each section whose records
    //                                                  the conference holds: inscriptions (attendees), payments
    //                                                  (fee payments), transport (transport payments), accounting
    //                                                  (ledger entries) — else 409 conference_has_records
    //   POST   /publish                                settings:manage
    //   GET    /fields                                 staff (context: names every attendee column)
    //   POST   /fields, DELETE /fields/:id             settings:manage
    //   GET    /fee-rules                              settings:view
    //   POST   /fee-rules, DELETE /fee-rules/:id       settings:manage
    //   POST   /reprice                                settings:manage
    //   GET    /locations                              staff (context: names, capacity, the conference row);
    //                                                  the access `code` only with locations:manage (else null)
    //   POST   /locations, PUT/DELETE /locations/:id   locations:manage (codes = who can log in to the portal)
    //   GET    /locations/:id/lodging                  locations:view (the ID document only with inscriptions:view)
    //   POST   /locations/:id/lodging/validate|return|reopen   locations:manage (validate / return: `seen`
    //                                                  = the review's submitted_at + admin_changes, else 409
    //                                                  `lodging_changed`; 2.17.0)
    //   GET    /hotels                                 lodging:view | inscriptions:view | dashboard:view | reports:view
    //   POST   /hotels, PUT/DELETE /hotels/:id         lodging:manage
    //   POST   /hotels/:id/allot                       lodging:manage
    //   POST   /rooms, PUT/DELETE /rooms/:id           lodging:manage
    //   (2.17.0: the lodging writes reach a submitted / validated location too — an administration
    //   adjustment, stamped on it and reported as `lodging_adjusted`; see stampAdminAdjustment)
    //   GET    /assignment/rules                       lodging:view
    //   POST   /assignment/rules, DELETE /assignment/rules/:id, POST /assignment/reset, POST /assignment/run,
    //          POST /assignment/plan, /plan/apply, /simulate, /location-order
    //                                                  lodging:manage
    //   POST   /inscriptions/:id/assign                lodging:manage
    //   GET    /inscriptions                           inscriptions:view | lodging:view | transport:view |
    //                                                  accounting:view | dashboard:view | reports:view (the roster
    //                                                  those pages name people from; since 2.18.0 not payments:view,
    //                                                  D-P20); `reg_code` and `document_number` only with
    //                                                  inscriptions:view (else null)
    //   GET    /inscriptions/:id                       same as GET /inscriptions (one row; 2.18.0)
    //   POST   /inscriptions, PUT/DELETE /inscriptions/:id   inscriptions:manage — a PUT that moves an attendee
    //                                                  WHO HOLDS A BED out of a submitted / validated location,
    //                                                  or into one with the bed they keep, also needs
    //                                                  lodging:manage (409 otherwise; 2.17.0). Without a bed,
    //                                                  in or out, inscriptions:manage alone (the bed rule).
    //                                                  DELETE of a person with fee payments also needs
    //                                                  payments:manage; 409 when the person is part of a payment
    //                                                  shared with others (2.18.0)
    //   GET    /inscriptions/export                    reports:view | inscriptions:view (the Código column only
    //                                                  with inscriptions:view)
    //   «Pagos de cuotas» (2.18.0, D-P20): payments:view to look, payments:manage to register, correct, validate,
    //   return, reject and delete. «Inscripciones» no longer opens with Pagos alone — in the panel (the client's
    //   viewAllowed) and here: the roster (GET /inscriptions[/:id]) refuses payments:view; the section names
    //   people from GET /fee-payments `people[]` (name, live location, family group; reg_code only with
    //   inscriptions:view) and never sees a contact, a form answer or a note.
    //   GET    /fee-payments, /fee-payments/:id        payments:view (no receipt image in either)
    //   GET    /fee-payments/:id/proof                 payments:view
    //   POST   /fee-payments, PUT/DELETE /fee-payments/:id   payments:manage
    //   POST   /fee-payments/:id/validate|return|reject      payments:manage
    //   GET    /inscriptions/:id/payments              payments:view | inscriptions:view (the person's parts, no
    //                                                  receipts; `with_proof=1` adds them for payments:view only)
    //   POST   /inscriptions/:id/payments              payments:manage (pre-2.18: a 1-person payment, left pending)
    //   DELETE /payments/:id                           payments:manage (pre-2.18: acts on a 1-person payment)
    //   POST   /payments/:id/validate|reject           payments:manage (pre-2.18: idem; 409 for a shared payment)
    //   GET    /reports/summary                        reports:view
    //   GET    /buses                                  transport:view | reports:view
    //   POST   /buses, PUT/DELETE /buses/:id           transport:manage
    //   POST   /buses/:id/passengers, DELETE /buses/:id/passengers/:inscriptionId   transport:manage
    //   GET    /tickets/:id/payments                   transport:view
    //   POST   /tickets/:id/payments, DELETE /transport-payments/:id   transport:manage
    //   GET    /accounting                             accounting:view
    //   POST   /accounting/entries, PUT/DELETE /accounting/entries/:id   accounting:manage
    //   GET    /meals                                  meals:view | meals_delivery:manage (the kitchen's services list)
    //   POST   /meals/services, POST /meals/services/bulk, PUT/DELETE /meals/services/:id   meals:manage
    //   PUT    /meals/plan, PUT /meals/services/:id/plan, POST /meals/plan/toggle   meals:manage
    //   GET    /meals/people                           meals:view | meals_delivery:manage (manual delivery search)
    //   GET    /meals/inscriptions/:id                 meals:view
    //   PUT    /meals/inscriptions/:id/overrides       meals:manage
    //   POST   /meals/check                            meals_delivery:manage (read-only: the confirmation card)
    //   POST   /meals/deliver                          meals_delivery:manage
    //   GET    /meals/display-fields                   meals:view | meals_delivery:manage (what the card shows)
    //   PUT    /meals/display-fields                   meals:manage
    //   DELETE /meals/deliveries/:id                   meals_delivery:manage
    //   GET    /meals/services/:id/stats               meals:view | meals_delivery:manage
    //   GET    /meals/services/:id/deliveries          meals:view | meals_delivery:manage (recent deliveries)
    //   GET    /meals/services/:id/report              meals:view
    //   (every meals answer carries reg_code — and GET /meals/people and the card the ID document, document_number — only
    //   with inscriptions:view, else null; without it the people search matches a document only whole)
    //   GET    /staff/me                               any authenticated user (all `none` when not on the team)
    //   GET|POST /staff/roles, PUT|DELETE /staff/roles/:id       admin
    //   GET|POST /staff/members, PUT|DELETE /staff/members/:id   admin
    //   GET    /staff/user-search                      admin
    //   /public/*, /portal/*                           no WordJS session: the portal's location code (the
    //                                                  /portal/fee-payments* routes see the coordinator's own
    //                                                  location only)
    const STAFF_SECTIONS = [
        { key: 'dashboard', levels: ['none', 'view'] },
        { key: 'inscriptions', levels: ['none', 'view', 'manage'] },
        { key: 'payments', levels: ['none', 'view', 'manage'] },
        { key: 'locations', levels: ['none', 'view', 'manage'] },
        { key: 'lodging', levels: ['none', 'view', 'manage'] },
        { key: 'transport', levels: ['none', 'view', 'manage'] },
        { key: 'accounting', levels: ['none', 'view', 'manage'] },
        { key: 'meals', levels: ['none', 'view', 'manage'] },
        { key: 'meals_delivery', levels: ['none', 'manage'] },
        // «Escarapelas» (2.19.0): view = see / share / download badges (with inscriptions:view, as they carry
        // the code); manage = the design and regenerating or revoking links. Existing roles get none.
        { key: 'badges', levels: ['none', 'view', 'manage'] },
        // «Datos de salud» (2.32.0): view = read the answers to «Condiciones de salud» (and the meal-group scores built
        // from them); manage = write them. Special-category data: existing roles get none.
        { key: 'health', levels: ['none', 'view', 'manage'] },
        { key: 'reports', levels: ['none', 'view'] },
        { key: 'settings', levels: ['none', 'view', 'manage'] },
    ];
    const STAFF_LEVELS = new Map(STAFF_SECTIONS.map(s => [s.key, s.levels]));
    const NO_ACCESS = 'No tienes acceso a esta sección.';
    // The WordJS role and capability the manifest declares (manifest.json › roles). Both carry the
    // plugin's namespace prefix (`conference_manager_`), which the core requires of a plugin role.
    const TEAM_ROLE = 'conference_manager_team';
    const TEAM_CAPABILITY = 'conference_manager_access';
    // Does this account (req.user, or a users-bridge projection) hold the team role?
    const hasTeamRole = (u) => !!(u && u.role === TEAM_ROLE);
    // May this account (req.user, or a users-bridge projection) work in the panel as a team member? It must
    // hold TEAM_CAPABILITY — through the team role, or through another role an administrator gave it to.
    // The host sends the account's own-namespace capabilities as `pluginCapabilities`; without that list (a
    // host older than 2.16.0) the team role is the answer. An administrator who took the capability off the
    // team role, or revoked the plugin's `roles:declare` permission, closes the panel to its holders.
    const hasTeamAccess = (u) => !!u && (Array.isArray(u.pluginCapabilities)
        ? u.pluginCapabilities.includes(TEAM_CAPABILITY)
        : hasTeamRole(u));
    const NOT_TEAM_ROLE = 'Solo pueden formar parte del equipo las cuentas cuyo rol de WordJS da acceso a «Conference»: el rol «Equipo de conferencia», '
        + 'u otro rol al que un administrador haya dado el permiso «conference_manager_access» en Usuarios › Roles. '
        + 'Cámbiale el rol en Usuarios (o da ese permiso a su rol) y vuelve a añadirla.';
    const ADMIN_PERMISSIONS = Object.freeze(Object.fromEntries(STAFF_SECTIONS.map(s => [s.key, s.levels[s.levels.length - 1]])));
    const NO_PERMISSIONS = Object.freeze(Object.fromEntries(STAFF_SECTIONS.map(s => [s.key, 'none'])));
    const levelRank = (lv) => (lv === 'manage' ? 2 : lv === 'view' ? 1 : 0);

    // Stored (JSON text) or already-parsed permissions → EVERY section with a valid level: unknown keys are
    // ignored, a missing or invalid level is none. Never throws (a corrupt row grants nothing).
    function normalizePermissions(raw) {
        let src = raw;
        if (typeof src === 'string') { try { src = JSON.parse(src); } catch { src = null; } }
        const ok = src && typeof src === 'object' && !Array.isArray(src);
        const out = {};
        for (const s of STAFF_SECTIONS) {
            const v = ok && Object.prototype.hasOwnProperty.call(src, s.key) ? src[s.key] : 'none';
            out[s.key] = s.levels.includes(v) ? v : 'none';
        }
        return out;
    }
    // A request body's permissions: a plain object whose every key is a section and every value one of its
    // levels (400 otherwise). Sections left out are none. `undefined` (POST without it) = all none.
    function parsePermissionsBody(raw) {
        if (raw === undefined) return { ...NO_PERMISSIONS };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Los permisos deben ser un objeto { sección: nivel }.');
        for (const k of Object.keys(raw)) {
            const levels = STAFF_LEVELS.get(k);
            if (!levels) throw httpError(400, `Sección desconocida: «${String(k).slice(0, 40)}».`);
            if (!levels.includes(raw[k])) throw httpError(400, `Nivel inválido para «${k}»: «${String(raw[k]).slice(0, 20)}» (${levels.join(', ')}).`);
        }
        return normalizePermissions(raw);
    }

    // Who did it, for the audit columns (reviewed_by, recorded_by, delivered_by, lodging_reviewed_by,
    // added_by): the acting user's login — the host forwards it for administrators and team members alike —
    // else the user id.
    const actorOf = (req) => {
        const u = req.user || null;
        if (!u) return null;
        if (u.userLogin) return String(u.userLogin).slice(0, 100);
        return u.id != null ? String(u.id) : null;
    };

    // The caller's permissions, cached per user for ≤ STAFF_CACHE_MS and dropped on EVERY team / role write
    // (invalidateStaffCache), so a revocation takes effect on the very next request of this worker. A read
    // that started before a write never repopulates the cache with what it read (the generation check).
    const STAFF_CACHE_MS = 5000;
    const STAFF_CACHE_MAX = 1000;
    const staffCache = new Map();   // String(user id) → { at, gen, perms }
    let staffGen = 0;
    const invalidateStaffCache = () => { staffGen++; staffCache.clear(); };
    const isAdminUser = (req) => !!(req && req.user && req.user.role === 'administrator');
    async function permsOf(req) {
        const u = req && req.user;
        if (u && u.role === 'administrator') return { isAdmin: true, isStaff: true, permissions: ADMIN_PERMISSIONS, role: null, member: false };
        const uid = u ? positiveInt(u.id) : null;
        if (!uid) return { isAdmin: false, isStaff: false, permissions: NO_PERMISSIONS, role: null, member: false };
        // The WordJS role is part of the key: the host forwards it on every request, so changing someone's
        // role in Usuarios takes effect on their next request, not after the cache window.
        const teamRole = hasTeamAccess(u);
        const key = `${uid}:${teamRole ? 1 : 0}`, now = Date.now();
        const hit = staffCache.get(key);
        if (hit && hit.gen === staffGen && now - hit.at < STAFF_CACHE_MS) return hit.perms;
        const gen = staffGen;
        const row = await db.get(
            `SELECT m.id, m.active, m.role_id, r.name AS role_name, r.permissions FROM ${T.staffMembers} m JOIN ${T.staffRoles} r ON r.id = m.role_id WHERE m.user_id = ?`, [uid]);
        // An active member WITHOUT the team role (see TEAM ROLE above) is not staff: no section, no context.
        const perms = row && Number(row.active) === 1 && teamRole
            ? { isAdmin: false, isStaff: true, permissions: Object.freeze(normalizePermissions(row.permissions)), role: { id: row.role_id, name: row.role_name }, member: true }
            : { isAdmin: false, isStaff: false, permissions: NO_PERMISSIONS, role: null, member: !!row };
        if (gen === staffGen) {
            if (staffCache.size >= STAFF_CACHE_MAX) staffCache.clear();
            staffCache.set(key, { at: now, gen, perms });
        }
        return perms;
    }
    const hasLevel = (perms, section, level) => perms.isAdmin || levelRank(perms.permissions[section]) >= levelRank(level);
    const canSeeRegCodes = (perms) => hasLevel(perms, 'inscriptions', 'view');
    const canSeeLocationCodes = (perms) => hasLevel(perms, 'locations', 'manage');
    // reg_code (the barcode payload) travels with inscriptions:view only.
    const maskRegCode = (obj, perms) => (obj && !canSeeRegCodes(perms) ? { ...obj, reg_code: null } : obj);
    // So does the attendee's ID document (inscriptions.document_number): it is roster data, and the meals
    // screens never show it — a kitchen role (meals_delivery:manage) cannot read the roster.
    const canSeeDocuments = (perms) => hasLevel(perms, 'inscriptions', 'view');
    // ONE projection for every answer that carries inscription rows (2.17.1): the roster, its CSV export,
    // the lodging review, the meals card. GET /inscriptions is open to payments/lodging/transport/…:view
    // to NAME people; the ID document stays with inscriptions:view.
    const DOCUMENT_COLUMN = 'document_number';
    const maskDocument = (obj, perms) => (obj && !canSeeDocuments(perms) && DOCUMENT_COLUMN in obj ? { ...obj, [DOCUMENT_COLUMN]: null } : obj);

    // «Condiciones de salud» (2.32.0): read with health:view, written from the admin with health:manage.
    const HEALTH_FIELD = healthMod.FIELD;
    const canSeeHealth = (perms) => hasLevel(perms, 'health', 'view');
    const canWriteHealth = (perms) => hasLevel(perms, 'health', 'manage');
    // The body's answer to the conference's health field, checked BEFORE anything is written: { field, answer, verbal }
    // (answer undefined = the key was absent; null = clear). A caller who may not write it and sends it gets 403;
    // `creating` makes a required field required (an edit only refuses clearing it). The portal may always answer
    // (it registers the person, and never reads an answer back).
    async function healthFromBody(conferenceId, body, { mayWrite, creating, inscriptionId = null }) {
        const field = await health.fieldOf(conferenceId);
        if (!field) return { field: null, answer: undefined };
        const has = !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, HEALTH_FIELD);
        if (has && !mayWrite) throw httpError(403, 'No tienes permiso para registrar datos de salud.');
        const answer = has ? healthMod.parseAnswer(field, body[HEALTH_FIELD], httpError) : undefined;
        if (await consent.isEnabled(conferenceId)) {
            // «Autorización de datos» (2.34.0): staff may enter a person's health answer only on the strength of their
            // verbal authorization (the ticked statement below), until the person authorizes health in writing (code
            // or paper), which confirms it. Clearing one is always allowed.
            // A written «no» stands: no verbal statement can override it.
            if (answer && inscriptionId != null && await consent.healthRefused(inscriptionId)) {
                throw httpError(409, 'La persona no autorizó por escrito el tratamiento de sus datos de salud: no se pueden registrar.');
            }
            const written = inscriptionId != null && await consent.healthWritten(inscriptionId);
            // 2.36.10: a live authorization covers later edits — the written one, or the verbal one already recorded
            // (verbal = authorized): no new tick. The edit is still logged (health_entered, basis written / verbal).
            const live = written || (inscriptionId != null && await consent.healthAllowed(conferenceId, inscriptionId));
            if (answer && !live && !(body && body.health_verbal_consent === true)) {
                const e = httpError(400, 'Marca que la persona te autorizó verbalmente el tratamiento de sus datos de salud, tras informarle que es voluntario. Sin esa autorización no se guardan.');
                e.field = 'health_verbal_consent';
                throw e;
            }
            return { field, answer, verbal: !!answer && !written };
        }
        // A required field asks for the conditions part (2.36.9: a blood type or an EPS alone does not answer it).
        const unanswered = !healthMod.conditionsAnswered(answer);
        if (mayWrite && Number(field.is_required) && ((creating && unanswered) || (!creating && answer !== undefined && unanswered))) {
            throw httpError(400, `El campo «${field.label || 'Condiciones de salud'}» es obligatorio.`);
        }
        return { field, answer };
    }
    // «Autorización de datos» (2.33.0): while the conference asks for it, only the answers of people whose health
    // authorization is live are shown (one given before the setting was turned on stays hidden until they authorize).
    async function consentedHealth(conferenceId, answers) {
        if (!await consent.isEnabled(conferenceId)) return answers;
        const states = await consent.statesOf(conferenceId, [...answers.keys()]);
        return new Map([...answers].filter(([id]) => { const st = states.get(id); return st && ((st.state === 'granted' && st.health) || st.verbal_health); }));
    }
    // 2.36.10: the ONE way to read health answers for use — shown, exported or scored: these ids', or a whole
    // conference's, through `consentedHealth`. The roster, the export, the edit form's read (GET /inscriptions/:id/health)
    // and the meal priority model (and so every meal group shown on the scanner, the person's page and the badges)
    // all go through these two, so an answer whose health authorization is pending or revoked is used nowhere.
    const consentedAnswersOf = async (conferenceId, ids) => consentedHealth(conferenceId, await health.answersOf(ids));
    const consentedAnswersOfConference = async (conferenceId) => consentedHealth(conferenceId, await health.answersOfConference(conferenceId));
    // Roster rows of ONE conference + the health answer as text, for health:view only (and only when the form has it).
    async function withHealthText(rows, conferenceId, perms) {
        if (!rows.length || !canSeeHealth(perms) || !await health.fieldOf(conferenceId)) return rows;
        const answers = await consentedAnswersOf(conferenceId, rows.map(r => r.id));
        return rows.map(r => ({ ...r, [HEALTH_FIELD]: healthMod.answerText(answers.get(Number(r.id))) }));
    }

    const denyAccess = (res) => { res.status(403).json({ error: NO_ACCESS }); return false; };
    async function gatePerms(req, res) {
        try { return await permsOf(req); }
        catch (e) {
            console.warn('[conference-manager] permission lookup failed:', e && e.message);
            res.status(500).json({ error: 'No se pudieron comprobar tus permisos; inténtalo de nuevo.' });
            return null;
        }
    }
    // THE gate: resolves to the caller's permissions (truthy) when allowed, else answers 403 (500 when the
    // lookup itself failed) and resolves to false. Never throws.
    async function allow(req, res, section, level) {
        if (!STAFF_LEVELS.has(section)) console.warn(`[conference-manager] allow(): unknown section «${section}»`);
        const p = await gatePerms(req, res);
        if (!p) return false;
        return hasLevel(p, section, level) ? p : denyAccess(res);
    }
    // Any of [[section, level], …] is enough.
    async function allowAny(req, res, alternatives) {
        const p = await gatePerms(req, res);
        if (!p) return false;
        for (const [section, level] of alternatives) {
            if (hasLevel(p, section, level)) return p;
        }
        return denyAccess(res);
    }
    // Context every team member needs for the panel to work (the conference list, the form fields, the
    // locations' names): an active membership is enough, whatever the role.
    async function isStaff(req, res) {
        const p = await gatePerms(req, res);
        if (!p) return false;
        return p.isStaff ? p : denyAccess(res);
    }
    // Team management: administrators only (the routes also carry { admin: true }; this is the second lock).
    const adminOnly = (req, res) => (isAdminUser(req) ? true : denyAccess(res));

    // Team writes are read-then-write: serialised here (single worker process) and backed by UNIQUE indexes.
    let staffLock = Promise.resolve();
    const withStaffLock = (fn) => {
        const run = staffLock.then(fn, fn);
        staffLock = run.then(() => {}, () => {});
        return run;
    };

    async function initStaffSchema() {
        // First run = the roles table did not exist before this boot. The example roles are seeded then
        // only: seeding on «no role» would bring them back every boot after an administrator deleted them.
        let firstRun = false;
        try { await db.get(`SELECT COUNT(*) AS n FROM ${T.staffRoles}`); } catch (e) { firstRun = true; }
        await db.createTable(T.staffRoles, [
            'id INT_PK',
            'name VARCHAR(80) NOT NULL',
            'permissions TEXT',                    // JSON { section: level }
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP'
        ]);
        await db.createTable(T.staffMembers, [
            'id INT_PK',
            'user_id INT NOT NULL',                // the WordJS user (core users.id; no FK across namespaces)
            'role_id INT NOT NULL',                // a role with members cannot be deleted (checked in code)
            'active INT DEFAULT 1',
            'added_by TEXT',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (role_id) REFERENCES ${T.staffRoles}(id)`
        ]);
        await createUniqueIndex(`${P}uidx_staff_roles_name`, T.staffRoles, 'name');
        await createUniqueIndex(`${P}uidx_staff_members_user`, T.staffMembers, 'user_id');
        await createIndex(`${P}idx_staff_members_role`, T.staffMembers, 'role_id');
        if (!firstRun) return;
        const c = await db.get(`SELECT COUNT(*) AS n FROM ${T.staffRoles}`);
        if (Number(c && c.n) > 0) return;
        const seeds = [
            { name: 'Solo lectura', permissions: Object.fromEntries(STAFF_SECTIONS.map(s => [s.key, s.levels.includes('view') ? 'view' : 'none'])) },
            { name: 'Cocina', permissions: { ...NO_PERMISSIONS, meals_delivery: 'manage' } },
        ];
        for (const s of seeds) {
            try { await db.run(`INSERT INTO ${T.staffRoles} (name, permissions) VALUES (?, ?)`, [s.name, JSON.stringify(s.permissions)]); }
            catch (e) { console.warn('[conference-manager] staff role seed skipped:', e.message); }
        }
    }
    await initStaffSchema();

    // Portal sessions (2.17.1): see PORTAL AUTH HELPER. VARCHAR, not TEXT: MySQL cannot index TEXT. No
    // FK — the lookup joins the location, so a session of a deleted location resolves to none.
    await db.createTable(T.portalSessions, [
        'id INT_PK',
        'token VARCHAR(64) NOT NULL',
        'location_id INT NOT NULL',
        'code VARCHAR(32) NOT NULL',
        'expires_at VARCHAR(16) NOT NULL',
        'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ]);
    await createUniqueIndex(`${P}uidx_portal_sessions_token`, T.portalSessions, 'token');
    await createIndex(`${P}idx_portal_sessions_expires`, T.portalSessions, 'expires_at');

    // ── WordJS users (grant users:read) ──
    const USERS_GRANT_MESSAGE = 'Para buscar usuarios, concede al plugin el permiso «users:read» en Plugins.';
    const isUsersGrantError = (e) => /without permission|security block|not granted|permission/i.test(String(e && e.message ? e.message : e));
    const usersBridge = () => (wordjs.users && typeof wordjs.users.findById === 'function' && typeof wordjs.users.search === 'function' ? wordjs.users : null);
    // The host's SAFE projection → the wire shape { id, login, email, name, role, team_role }. `role` is the
    // account's WordJS role (slug); `team_role` = that role gives the account access to the panel (it holds
    // TEAM_CAPABILITY — see hasTeamAccess), which is what joining the team requires.
    const wireUser = (u) => (u && u.id != null ? {
        id: u.id,
        login: u.userLogin || u.username || null,
        email: u.userEmail || null,
        name: u.displayName || u.userLogin || u.username || null,
        role: u.role || null,
        team_role: hasTeamAccess(u),
    } : null);
    // Throws 503 (USERS_GRANT_MESSAGE) when the grant is missing.
    async function findWordjsUser(id) {
        const api = usersBridge();
        if (!api) throw httpError(503, USERS_GRANT_MESSAGE);
        try { return await api.findById(id); }
        catch (e) { if (isUsersGrantError(e)) throw httpError(503, USERS_GRANT_MESSAGE); throw e; }
    }
    async function searchWordjsUsers(term, limit) {
        const api = usersBridge();
        if (!api) throw httpError(503, USERS_GRANT_MESSAGE);
        try { return await api.search(term, limit); }
        catch (e) { if (isUsersGrantError(e)) throw httpError(503, USERS_GRANT_MESSAGE); throw e; }
    }

    const STAFF_ADMIN_ROUTE = { auth: true, admin: true };
    const ROLE_DUPLICATE = 'Ya existe un rol con ese nombre.';
    const staffSectionsWire = () => STAFF_SECTIONS.map(s => ({ key: s.key, levels: s.levels.slice() }));
    const roleWire = (r) => ({ id: r.id, name: r.name, permissions: normalizePermissions(r.permissions), members: Number(r.members) || 0, created_at: r.created_at || null, updated_at: r.updated_at || null });
    const parseRoleName = (v) => {
        const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
        if (!s) throw httpError(400, 'El nombre del rol es obligatorio.');
        if (s.length > 80) throw httpError(400, 'El nombre del rol es demasiado largo (máximo 80 caracteres).');
        return s;
    };
    // Role names are unique ignoring case AND accents — compared HERE, not with SQL LOWER(), which folds
    // only ASCII on SQLite («TESORERÍA» ≠ «tesorería» there) while MySQL's default collation also ignores
    // accents (its UNIQUE index would refuse «Tesoreria» next to «Tesorería» with a 500). The roles table is
    // small; the UNIQUE index backs the exact-name race.
    const foldRoleName = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const roleNameTaken = async (name, exceptId) => {
        const want = foldRoleName(name);
        const rows = await db.all(`SELECT id, name FROM ${T.staffRoles}`);
        return rows.some(r => Number(r.id) !== Number(exceptId || 0) && foldRoleName(r.name) === want);
    };
    const parseFlag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : v === false || v === 0 || v === '0' || v === 'false' ? 0 : null);

    // What the caller may do here — the admin UI loads it at mount (200 with every section `none` for a
    // logged-in user who is not on the team, so the page can explain how to get access: `teamRole` = the
    // account has the WordJS role «Equipo de conferencia», `member` = it is on the team list, active or not).
    http.route('get', '/staff/me', { auth: true }, async (req, res) => {
        try {
            const p = await permsOf(req);
            const u = req.user || {};
            res.json({
                isAdmin: p.isAdmin,
                isStaff: p.isStaff,
                permissions: { ...p.permissions },
                role: p.role ? { id: p.role.id, name: p.role.name } : null,
                teamRole: hasTeamAccess(u),
                member: !!p.member,
                user: { id: u.id == null ? null : u.id, name: String(u.userLogin || u.userEmail || (u.id != null ? `#${u.id}` : '')) },
            });
        } catch (e) { sendError(res, e); }
    });

    http.route('get', '/staff/roles', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const rows = await db.all(`SELECT r.*, (SELECT COUNT(*) FROM ${T.staffMembers} m WHERE m.role_id = r.id) AS members FROM ${T.staffRoles} r ORDER BY r.name, r.id`);
            res.json({ roles: rows.map(roleWire), sections: staffSectionsWire() });
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/staff/roles', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const body = req.body || {};
            const name = parseRoleName(body.name);
            const permissions = parsePermissionsBody(body.permissions);
            const id = await withStaffLock(async () => {
                if (await roleNameTaken(name, null)) throw httpError(409, ROLE_DUPLICATE);
                let r;
                try {
                    r = await db.run(`INSERT INTO ${T.staffRoles} (name, permissions, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [name, JSON.stringify(permissions)]);
                } catch (e) {
                    if (await roleNameTaken(name, null)) throw httpError(409, ROLE_DUPLICATE);
                    throw e;
                }
                invalidateStaffCache();
                return r.lastID;
            });
            res.json({ success: true, id });
        } catch (e) { sendError(res, e); }
    });

    http.route('put', '/staff/roles/:id', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const id = positiveInt(req.params.id);
            const body = req.body || {};
            const name = body.name === undefined ? undefined : parseRoleName(body.name);
            const permissions = body.permissions === undefined ? undefined : parsePermissionsBody(body.permissions);
            await withStaffLock(async () => {
                const role = id ? await db.get(`SELECT id FROM ${T.staffRoles} WHERE id = ?`, [id]) : null;
                if (!role) throw httpError(404, 'Rol no encontrado.');
                if (name !== undefined && await roleNameTaken(name, id)) throw httpError(409, ROLE_DUPLICATE);
                const sets = ['updated_at = CURRENT_TIMESTAMP'], params = [];
                if (name !== undefined) { sets.push('name = ?'); params.push(name); }
                if (permissions !== undefined) { sets.push('permissions = ?'); params.push(JSON.stringify(permissions)); }
                try { await db.run(`UPDATE ${T.staffRoles} SET ${sets.join(', ')} WHERE id = ?`, [...params, id]); }
                catch (e) {
                    if (name !== undefined && await roleNameTaken(name, id)) throw httpError(409, ROLE_DUPLICATE);
                    throw e;
                }
                invalidateStaffCache();
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // A role that still has members (active or not) is never deleted: 409 { error, members }.
    http.route('delete', '/staff/roles/:id', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const id = positiveInt(req.params.id);
            const outcome = await withStaffLock(async () => {
                const role = id ? await db.get(`SELECT id FROM ${T.staffRoles} WHERE id = ?`, [id]) : null;
                if (!role) throw httpError(404, 'Rol no encontrado.');
                // One conditional statement: "has no member" and "delete it" cannot be split by a writer.
                const r = await db.run(`DELETE FROM ${T.staffRoles} WHERE id = ? AND NOT EXISTS (SELECT 1 FROM ${T.staffMembers} m WHERE m.role_id = ? )`, [id, id]);
                if (r && r.changes) { invalidateStaffCache(); return { deleted: true }; }
                const c = await db.get(`SELECT COUNT(*) AS n FROM ${T.staffMembers} WHERE role_id = ?`, [id]);
                return { members: Number(c && c.n) || 0 };
            });
            if (!outcome.deleted) {
                const n = outcome.members;
                return res.status(409).json({ error: `El rol tiene ${n} miembro(s); cámbialos de rol o quítalos del equipo antes de eliminarlo.`, members: n });
            }
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // The team, with each member's WordJS account when the users:read grant allows looking it up
    // (`user: null` otherwise, or when the account no longer exists; `users_read` says which).
    // `roles_ready`: does the team role exist and open the panel right now? The host gives an administrator
    // every capability this plugin's registered roles confer, so TEAM_CAPABILITY is missing from theirs
    // exactly when the role is not registered (roles:declare not granted — an in-place update to 2.16.0
    // keeps the old grants) or confers nothing (the permission revoked). null = the host does not say.
    http.route('get', '/staff/members', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const rows = await db.all(`SELECT m.*, r.name AS role_name FROM ${T.staffMembers} m LEFT JOIN ${T.staffRoles} r ON r.id = m.role_id ORDER BY m.created_at, m.id`);
            let usersRead = true;
            const members = [];
            for (const m of rows) {
                let user = null;
                if (usersRead) {
                    try { user = wireUser(await findWordjsUser(m.user_id)); }
                    catch (e) { if (e && e.status === 503) usersRead = false; }
                }
                members.push({
                    id: m.id, user_id: m.user_id, role_id: m.role_id, role_name: m.role_name || null,
                    active: Number(m.active) === 1, added_by: m.added_by || null, created_at: m.created_at || null, user,
                    // false = the account no longer has the WordJS team role, so the member gets no section
                    // (the list flags it); null = unknown (no users:read grant, or the account is gone).
                    team_role: user ? user.team_role : null,
                });
            }
            const caps = req.user && req.user.pluginCapabilities;
            res.json({ members, users_read: usersRead, team_role: TEAM_ROLE, roles_ready: Array.isArray(caps) ? caps.includes(TEAM_CAPABILITY) : null });
        } catch (e) { sendError(res, e); }
    });

    // Add a WordJS user to the team: { user_id, role_id }. 400 unknown role / an administrator (they already
    // have everything) / an account whose WordJS role does not give access to the panel (hasTeamAccess);
    // 404 unknown user; 409 already on the team; 503 without the users:read grant.
    http.route('post', '/staff/members', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const body = req.body || {};
            const userId = positiveInt(body.user_id);
            if (!userId) return res.status(400).json({ error: 'Indica el usuario.' });
            const roleId = positiveInt(body.role_id);
            const role = roleId ? await db.get(`SELECT id FROM ${T.staffRoles} WHERE id = ?`, [roleId]) : null;
            if (!role) return res.status(400).json({ error: 'Rol desconocido.' });
            const user = await findWordjsUser(userId);
            if (!user || user.id == null) return res.status(404).json({ error: 'Usuario no encontrado.' });
            if (user.role === 'administrator') return res.status(400).json({ error: 'Los administradores ya tienen acceso a todo; no hace falta añadirlos al equipo.' });
            if (!hasTeamAccess(user)) return res.status(400).json({ error: NOT_TEAM_ROLE, code: 'not_team_role' });
            const id = await withStaffLock(async () => {
                if (!(await db.get(`SELECT id FROM ${T.staffRoles} WHERE id = ?`, [roleId]))) throw httpError(400, 'Rol desconocido.');
                const dup = 'Esa persona ya forma parte del equipo.';
                if (await db.get(`SELECT id FROM ${T.staffMembers} WHERE user_id = ?`, [userId])) throw httpError(409, dup);
                let r;
                try {
                    r = await db.run(`INSERT INTO ${T.staffMembers} (user_id, role_id, active, added_by, created_at) VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)`, [userId, roleId, actorOf(req)]);
                } catch (e) {
                    if (await db.get(`SELECT id FROM ${T.staffMembers} WHERE user_id = ?`, [userId])) throw httpError(409, dup);
                    throw e;
                }
                invalidateStaffCache();
                return r.lastID;
            });
            res.json({ success: true, id });
        } catch (e) { sendError(res, e); }
    });

    // Change a member's role and/or (de)activate them: { role_id?, active? }. Effective at once. Changing the
    // role or (re)activating needs the account's WordJS role to give access to the panel (400 otherwise,
    // like POST); deactivating never does, so a member who lost it can always be switched off. Without the
    // users:read grant the account cannot be looked up: the change is made anyway — the check only saves
    // the administrator a pointless edit, it guards nothing (every request re-checks access, see permsOf).
    http.route('put', '/staff/members/:id', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const id = positiveInt(req.params.id);
            const body = req.body || {};
            let roleId;
            if (body.role_id !== undefined) {
                roleId = positiveInt(body.role_id);
                if (!roleId) return res.status(400).json({ error: 'Rol desconocido.' });
            }
            let active;
            if (body.active !== undefined) {
                active = parseFlag(body.active);
                if (active === null) return res.status(400).json({ error: 'active debe ser verdadero o falso.' });
            }
            // A role change or a (re)activation that leaves the person ACTIVE on the team: same rule as POST.
            // Switching someone off (even together with a role change), or changing the role of someone who
            // stays switched off, never needs it.
            const row = (roleId !== undefined || active === 1) && active !== 0 && id
                ? await db.get(`SELECT user_id, active FROM ${T.staffMembers} WHERE id = ?`, [id]) : null;
            if ((roleId !== undefined || active === 1) && active !== 0 && !row) return res.status(404).json({ error: 'Miembro no encontrado.' });
            if (row && (active === 1 || Number(row.active) === 1)) {
                let user;
                let lookedUp = true;
                try { user = await findWordjsUser(row.user_id); }
                catch (e) { if (e && e.status === 503) lookedUp = false; else throw e; }
                if (lookedUp) {
                    if (!user || user.id == null) return res.status(404).json({ error: 'Usuario no encontrado: su cuenta de WordJS ya no existe; quítalo del equipo.' });
                    if (!hasTeamAccess(user)) return res.status(400).json({ error: NOT_TEAM_ROLE, code: 'not_team_role' });
                }
            }
            await withStaffLock(async () => {
                const m = id ? await db.get(`SELECT id FROM ${T.staffMembers} WHERE id = ?`, [id]) : null;
                if (!m) throw httpError(404, 'Miembro no encontrado.');
                if (roleId !== undefined && !(await db.get(`SELECT id FROM ${T.staffRoles} WHERE id = ?`, [roleId]))) throw httpError(400, 'Rol desconocido.');
                const sets = [], params = [];
                if (roleId !== undefined) { sets.push('role_id = ?'); params.push(roleId); }
                if (active !== undefined) { sets.push('active = ?'); params.push(active); }
                if (sets.length) await db.run(`UPDATE ${T.staffMembers} SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
                invalidateStaffCache();
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/staff/members/:id', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const id = positiveInt(req.params.id);
            await withStaffLock(async () => {
                const r = id ? await db.run(`DELETE FROM ${T.staffMembers} WHERE id = ?`, [id]) : null;
                invalidateStaffCache();
                if (!r || !r.changes) throw httpError(404, 'Miembro no encontrado.');
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // WordJS users by name / e-mail / login (empty q = the first ones), for «add to the team».
    http.route('get', '/staff/user-search', STAFF_ADMIN_ROUTE, async (req, res) => {
        if (!adminOnly(req, res)) return;
        try {
            const q = String(req.query.q == null ? '' : req.query.q).trim().slice(0, 100);
            const list = await searchWordjsUsers(q, 20);
            // Each user carries `team_role` (its WordJS role gives access to the panel): only those can be added
            // (the picker greys out the rest and says why).
            res.json({ users: (Array.isArray(list) ? list : []).map(wireUser).filter(Boolean), team_role: TEAM_ROLE });
        } catch (e) { sendError(res, e); }
    });

    // === CONFERENCES MANAGEMENT ===
    http.route('get', '/list', { auth: true }, async (req, res) => {
        if (!await isStaff(req, res)) return;
        try {
            const list = await db.all(`SELECT * FROM ${T.conferences} ORDER BY id DESC`);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/create', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        const { name, slug, date_start, date_end, fee_default, description } = req.body;
        try {
            const cleanName = String(name || '').trim();
            if (!cleanName) return res.status(400).json({ error: 'El nombre es obligatorio.' });
            // Slug: use the caller's or derive a URL-safe one from the name; must be unique.
            let cleanSlug = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (!cleanSlug) cleanSlug = 'conf-' + Date.now().toString(36);
            const ds = normDate(date_start, 'inicio');
            const de = normDate(date_end, 'fin');
            if (ds && de && new Date(de).getTime() < new Date(ds).getTime()) {
                return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la de inicio.' });
            }
            const fee = normFee(fee_default) || 0;
            const exists = await db.get(`SELECT id FROM ${T.conferences} WHERE slug = ?`, [cleanSlug]);
            if (exists) return res.status(409).json({ error: 'Ya existe una conferencia con ese identificador (slug).' });

            const result = await db.run(
                `INSERT INTO ${T.conferences} (name, slug, date_start, date_end, fee_default, description, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`,
                [cleanName, cleanSlug, ds, de, fee, description || null]
            );
            const conference_id = result.lastID;

            // 2.16.0: no default form and no default assignment rules — the admin builds the form in «Campos»
            // (the base fields are offered as templates) and adds the rules in «Asignación».
            res.json({ success: true, id: conference_id });
        } catch (e) { sendError(res, e); }
    });

    // Update conference metadata (name/slug/dates/fee/description/status). Only the fields present
    // in the body are changed, so partial updates are safe.
    const CONFERENCE_STATUSES = new Set(['draft', 'active', 'archived']);
    http.route('put', '/:id', { auth: true }, async (req, res) => {
        // Only the lodging dates (the «fechas» of Localidades) → locations:manage suffices too.
        const LODGING_DATE_KEYS = ['lodging_opens', 'lodging_deadline', 'lodging_tz', 'withdraw_until'];
        const editKeys = ['name', 'slug', 'date_start', 'date_end', 'fee_default', 'description', 'status', 'phone_country', ...LODGING_DATE_KEYS].filter(k => (req.body || {})[k] !== undefined);
        const datesOnly = editKeys.length > 0 && editKeys.every(k => LODGING_DATE_KEYS.includes(k));
        if (!await (datesOnly ? allowAny(req, res, [['settings', 'manage'], ['locations', 'manage']]) : allow(req, res, 'settings', 'manage'))) return;
        const { name, slug, date_start, date_end, fee_default, description, status, lodging_opens, lodging_deadline, lodging_tz } = req.body;
        try {
            const conf = await db.get(`SELECT * FROM ${T.conferences} WHERE id = ?`, [req.params.id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });

            const sets = [], params = [];
            if (name !== undefined) {
                const v = String(name).trim();
                if (!v) return res.status(400).json({ error: 'El nombre es obligatorio.' });
                sets.push('name = ?'); params.push(v);
            }
            if (slug !== undefined) {
                const v = String(slug).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                if (!v) return res.status(400).json({ error: 'Identificador (slug) inválido.' });
                const clash = await db.get(`SELECT id FROM ${T.conferences} WHERE slug = ? AND id != ?`, [v, req.params.id]);
                if (clash) return res.status(409).json({ error: 'Ese identificador ya está en uso.' });
                sets.push('slug = ?'); params.push(v);
            }
            const nextStart = date_start !== undefined ? normDate(date_start, 'inicio') : conf.date_start;
            const nextEnd = date_end !== undefined ? normDate(date_end, 'fin') : conf.date_end;
            if (nextStart && nextEnd && new Date(nextEnd).getTime() < new Date(nextStart).getTime()) {
                return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la de inicio.' });
            }
            if (date_start !== undefined) { sets.push('date_start = ?'); params.push(nextStart); }
            if (date_end !== undefined) { sets.push('date_end = ?'); params.push(nextEnd); }
            if (fee_default !== undefined) {
                sets.push('fee_default = ?'); params.push(normFee(fee_default));
            }
            if (description !== undefined) { sets.push('description = ?'); params.push(description || null); }
            // The general lodging dates: the opening may not come after the closing (judged in the zone the
            // request brings, else the stored one).
            const tz = lodging_tz !== undefined ? lodgingTzInput(lodging_tz) : lodgingZone(conf.lodging_tz);
            if (lodging_opens !== undefined || lodging_deadline !== undefined) {
                const opens = lodging_opens !== undefined ? lodgingDateInput(lodging_opens, 'apertura de hospedajes') : lodgingDay(conf.lodging_opens);
                const closes = lodging_deadline !== undefined ? lodgingDateInput(lodging_deadline, 'cierre de hospedajes') : lodgingDay(conf.lodging_deadline);
                if (opens && closes && lodgingStart(opens, tz) >= lodgingEnd(closes, tz)) {
                    return res.status(400).json({ error: 'La apertura de los hospedajes no puede ser posterior a su cierre.' });
                }
                if (lodging_opens !== undefined) { sets.push('lodging_opens = ?'); params.push(opens); }
                if (lodging_deadline !== undefined) { sets.push('lodging_deadline = ?'); params.push(closes); }
            }
            if (lodging_tz !== undefined) { sets.push('lodging_tz = ?'); params.push(tz); }
            // 2.36.6: «Los encargados pueden retirar inscripciones hasta» — '' / null = they cannot.
            const withdrawUntil = (req.body || {}).withdraw_until;
            if (withdrawUntil !== undefined) {
                const v = withdrawUntil == null || withdrawUntil === '' ? null : String(withdrawUntil).trim();
                if (v != null && !Number.isFinite(withdrawEnd(v, tz))) return res.status(400).json({ error: 'Fecha y hora inválidas (retiro de inscripciones).', field: 'withdraw_until' });
                sets.push('withdraw_until = ?'); params.push(v == null ? null : v.slice(0, 16));
            }
            // «Indicativo por defecto» (2.33.2): the country national phone numbers belong to.
            const phoneCountry = (req.body || {}).phone_country;
            if (phoneCountry !== undefined) {
                const iso = String(phoneCountry || '').trim().toUpperCase();
                if (!phoneMod.isCountry(iso)) return res.status(400).json({ error: 'País inválido para el indicativo por defecto.' });
                sets.push('phone_country = ?'); params.push(iso);
            }
            if (status !== undefined) {
                if (!CONFERENCE_STATUSES.has(status)) return res.status(400).json({ error: 'Estado inválido (draft, active o archived).' });
                sets.push('status = ?'); params.push(status);
            }

            if (!sets.length) return res.json({ success: true });
            params.push(req.params.id);
            await db.run(`UPDATE ${T.conferences} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // Deleting a conference deletes everything that hangs from it (the FKs cascade): its attendees, their fee
    // payments, the transport payments of its buses and its accounting ledger. Each of those is another
    // section's to erase (DELETE /inscriptions/:id, /payments/:id, /transport-payments/:id,
    // /accounting/entries/:id), so the conference delete asks for the same: settings:manage, plus manage on
    // every section below whose records the conference still holds — the rule DELETE /inscriptions/:id
    // applies to an attendee's payments. An empty conference needs settings:manage only.
    const CONFERENCE_DELETE_GUARDS = [
        { section: 'inscriptions', what: 'inscripciones',
            sql: `SELECT 1 FROM ${T.inscriptions} WHERE conference_id = ?`, args: 1 },
        { section: 'payments', what: 'pagos de inscripción',
            sql: `SELECT 1 FROM ${T.payments} p JOIN ${T.inscriptions} i ON i.id = p.inscription_id WHERE i.conference_id = ?`, args: 1 },
        // 2.18.0: a fee payment's header (a portal or admin transfer) — only once its table exists (fees.ready).
        { section: 'payments', what: 'pagos de inscripción', when: () => fees.ready,
            sql: `SELECT 1 FROM ${T.transfers} WHERE conference_id = ?`, args: 1 },
        { section: 'transport', what: 'pagos de transporte',
            sql: `SELECT 1 FROM ${T.transportPayments} tp JOIN ${T.tickets} t ON t.id = tp.ticket_id`
                + ` WHERE t.bus_id IN (SELECT id FROM ${T.buses} WHERE conference_id = ?) OR t.inscription_id IN (SELECT id FROM ${T.inscriptions} WHERE conference_id = ?)`, args: 2 },
        // 2.26.0: what is sold is a package of buses; its payments are transport money too.
        { section: 'transport', what: 'pagos de transporte',
            sql: `SELECT 1 FROM ${T.packagePayments} pp JOIN ${T.packageSales} s ON s.id = pp.sale_id JOIN ${T.packages} k ON k.id = s.package_id WHERE k.conference_id = ?`, args: 1 },
        { section: 'accounting', what: 'movimientos de contabilidad',
            sql: `SELECT 1 FROM ${T.ledger} WHERE conference_id = ?`, args: 1 },
    ];
    http.route('delete', '/:id', { auth: true }, async (req, res) => {
        const perms = await allow(req, res, 'settings', 'manage');
        if (!perms) return;
        try {
            const id = req.params.id;
            const guards = CONFERENCE_DELETE_GUARDS.filter(g => (!g.when || g.when()) && !hasLevel(perms, g.section, 'manage'));
            const argsOf = (g) => Array.from({ length: g.args }, () => id);
            // Under the fee payments lock (2.18.0: a fee payment is recorded under it), inside it the assignment
            // lock (transport payments are recorded under it) and inside that the meals lock — the order every
            // route takes them in (see withMealsLock /
            // deleteMealsOfConference: parent first). The checks are part of the DELETE itself (NOT EXISTS), so a
            // record written between a check and the delete by a route that takes none of these locks (a ledger
            // entry) keeps the conference: it is never erased by a role that may not erase it. Fee payments
            // (2.18.0): their history rows are found through the headers, which the conference's delete would
            // cascade away, so they go once the conference is gone (explicit for foreign keys off too); their
            // parts go with the inscriptions; a part left without its header never counts (fees.EFFECTIVE).
            // Meals (2.14.0): the FKs cascade; the explicit deletes keep it so with foreign keys off too.
            const held = await fees.withPaymentsLock(() => withAssignmentLock(() => withMealsLock(async () => {
                // The fee payments' history is found through their headers, which the delete cascades away: their
                // ids are read first (no new one can appear: payments are recorded under the lock held here).
                const transferIds = fees.ready ? (await db.all(`SELECT id FROM ${T.transfers} WHERE conference_id = ?`, [id])).map(t => Number(t.id)) : [];
                const r = await db.run(
                    `DELETE FROM ${T.conferences} WHERE id = ?${guards.map(g => ` AND NOT EXISTS (${g.sql})`).join('')}`,
                    [id, ...guards.flatMap(argsOf)]);
                if (!(r && r.changes) && await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [id])) {
                    const found = [];
                    for (const g of guards) if (await db.get(g.sql, argsOf(g))) found.push(g);
                    return found.length ? found : guards;
                }
                await fees.deleteConference(id, transferIds);
                await deleteMealsOfConference(id);
                return null;
            })));
            if (held) {
                return res.status(409).json({
                    error: `La conferencia tiene ${[...new Set(held.map(g => g.what))].join(', ')}: eliminarla las borraría, y tu rol no las gestiona. `
                        + 'Pide a quien las gestiona (o a un administrador) que la elimine, o archívala.',
                    code: 'conference_has_records',
                    sections: [...new Set(held.map(g => g.section))],
                });
            }
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === DATA SEGMENTATION (requires conference_id in query/body) ===

    // Hotels for a conference
    http.route('get', '/hotels', { auth: true }, async (req, res) => {
        if (!await allowAny(req, res, [['lodging', 'view'], ['inscriptions', 'view'], ['dashboard', 'view'], ['reports', 'view']])) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            const hotels = await db.all(`SELECT * FROM ${T.hotels} WHERE conference_id = ? ORDER BY name`, [conference_id]);

            // Single joined query with a correlated occupancy subquery (mirrors runAssignment),
            // then group rooms under their hotel in JS — avoids the per-hotel + per-room N+1.
            const rooms = await db.all(`
                SELECT r.*, l.name AS location_name,
                (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) as occupied
                FROM ${T.rooms} r
                JOIN ${T.hotels} h ON r.hotel_id = h.id
                LEFT JOIN ${T.locations} l ON r.location_id = l.id
                WHERE h.conference_id = ?
            `, [conference_id]);

            // Shared rooms (2.18.0): each room carries `shares` — [{ location_id, location_name, beds,
            // occupied }] — and its `pool_beds` / `pool_occupied`. A whole or a pool room has no share.
            const shareMap = await sharesByRoom(rooms.map(r => r.id));
            const sharedIds = [...shareMap.keys()];
            const occByRoomLoc = new Map();
            const locNames = new Map();
            if (sharedIds.length) {
                for (let i = 0; i < sharedIds.length; i += 400) {
                    const chunk = sharedIds.slice(i, i + 400);
                    const rows = await db.all(`SELECT id, room_id, location_id FROM ${T.inscriptions} WHERE room_id IN (${chunk.map(() => '?').join(', ')})`, chunk);
                    for (const o of rows) {
                        if (!occByRoomLoc.has(Number(o.room_id))) occByRoomLoc.set(Number(o.room_id), []);
                        occByRoomLoc.get(Number(o.room_id)).push(o);
                    }
                }
                for (const l of await db.all(`SELECT id, name FROM ${T.locations} WHERE conference_id = ?`, [conference_id])) locNames.set(Number(l.id), l.name);
            }
            const lockFields = await shareLockFields(conference_id);
            for (const r of rooms) {
                const shares = shareMap.get(Number(r.id)) || [];
                // A shared room's class (see «THE CLASS OF A SHARED ROOM»), as in force — only when there is one.
                const lock = shareLockOf(r, shares, lockFields);
                if (lock.length) r.lock = lock;
                delete r.share_lock;
                if (!shares.length) { r.shares = []; continue; }
                const occupants = occByRoomLoc.get(Number(r.id)) || [];
                r.shares = shares.map(sh => ({
                    location_id: sh.location_id,
                    location_name: locNames.get(sh.location_id) || null,
                    beds: sh.beds,
                    occupied: Math.min(sh.beds, occupants.filter(o => o.location_id != null && Number(o.location_id) === sh.location_id).length),
                }));
                r.pool_beds = poolBedsOf(r, shares);
                r.pool_occupied = poolUsedOf(shares, occupants);
            }
            const roomsByHotel = new Map();
            for (const r of rooms) {
                if (!roomsByHotel.has(r.hotel_id)) roomsByHotel.set(r.hotel_id, []);
                roomsByHotel.get(r.hotel_id).push(r);
            }
            for (const h of hotels) {
                h.rooms = roomsByHotel.get(h.id) || [];
            }
            res.json(hotels);
        } catch (e) { sendError(res, e); }
    });

    // Shared filter builder for GET /inscriptions and /inscriptions/export (same query params).
    // `search` matches every DEFINED field column + the location label with LIKE, wildcards escaped.
    // `perms`: reg_code and the ID document are matched only for callers who may SEE them — otherwise the
    // filter is an oracle that rebuilds a hidden value one character at a time.
    async function inscriptionFilters(q, params, perms) {
        let where = '';
        const search = q.search ? String(q.search).slice(0, 200) : '';
        if (search) {
            const flds = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [q.conference_id]);
            // The ID document is searched only by whoever may read it (a substring search answers for it).
            const docsOk = canSeeDocuments(perms);
            const cols = [...new Set([...flds.map(f => f.name).filter(isFieldColumn).filter(c => docsOk || c !== DOCUMENT_COLUMN), 'location', ...(canSeeRegCodes(perms) ? ['reg_code'] : [])])];
            const term = `%${likeEscape(search)}%`;
            where += ` AND (` + cols.map(c => `i.${c} LIKE ?${LIKE_ESCAPE}`).join(' OR ') + `)`;
            cols.forEach(() => params.push(term));
        }
        if (q.location) { where += ` AND i.location LIKE ?${LIKE_ESCAPE}`; params.push(`%${likeEscape(String(q.location).slice(0, 200))}%`); }
        if (q.location_id !== undefined && q.location_id !== '') {
            const lid = Number(q.location_id);
            // A non-integer filter can match nothing; never bind NaN.
            if (Number.isInteger(lid)) { where += ` AND i.location_id = ?`; params.push(lid); }
            else where += ` AND 1 = 0`;
        }
        if (q.family_group) { where += ` AND i.family_group = ?`; params.push(q.family_group); }
        if (q.payment_status) { where += ` AND i.payment_status = ?`; params.push(q.payment_status); }
        if (q.assigned === 'true') where += ` AND i.room_id IS NOT NULL`;
        else if (q.assigned === 'false') where += ` AND i.room_id IS NULL AND ${lodgingSql('i.' + LODGING_FIELD)}`;
        return where;
    }

    // ONE roster row shape for GET /inscriptions and GET /inscriptions/:id: the inscription, its room and
    // hotel, and its fee money still under review — `pending_amount` (payments por validar) and
    // `returned_amount` (payments the admin returned for correction), both from LIVE parts (fees.personSum).
    // Cancelled rows keep `status: 'cancelled'` (the admin shows them struck through).
    // Built PER REQUEST, like every other money reader: fees.personSum follows the payments' readiness — a
    // string built once at init would keep a failed boot migration's degraded SQL (the parts' own mirrored
    // status, no header join) after a later request recovers the schema.
    // NOT payments:view (2.18.0, D-P20): «Pagos de cuotas» is a section of its own and learns who each person
    // is from GET /fee-payments (name, location, family group) — never the roster's contacts and form answers.
    const ROSTER_ACCESS = [['inscriptions', 'view'], ['lodging', 'view'], ['transport', 'view'], ['accounting', 'view'], ['dashboard', 'view'], ['reports', 'view']];
    const rosterSelect = () => `
                SELECT i.*, r.room_number, r.hotel_id, r.location_id AS room_location_id, h.name as hotel_name,
                       CASE WHEN EXISTS (SELECT 1 FROM ${T.roomBeds} b WHERE b.room_id = i.room_id) THEN 1 ELSE 0 END AS room_shared,
                       ${fees.personSum('pending', 'i.id')} as pending_amount,
                       ${fees.personSum('returned', 'i.id')} as returned_amount
                FROM ${T.inscriptions} i
                LEFT JOIN ${T.rooms} r ON i.room_id = r.id
                LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id`;
    // Stable order (2.18.0): the id breaks ties between equal names, so a page boundary never repeats or
    // drops a person.
    const ROSTER_ORDER = ` ORDER BY i.last_name, i.first_name, i.id`;
    // One roster row: the registration code (badge payload) and the ID document only reach inscriptions:view.
    const rosterRow = (item, perms) => maskDocument({ ...item, custom_data: parseCd(item.custom_data), reg_code: canSeeRegCodes(perms) ? item.reg_code : null }, perms);

    // Inscriptions for a conference
    http.route('get', '/inscriptions', { auth: true }, async (req, res) => {
        const perms = await allowAny(req, res, ROSTER_ACCESS);
        if (!perms) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            let query = `${rosterSelect()}
                WHERE i.conference_id = ?
            `;
            const params = [conference_id];
            query += await inscriptionFilters(req.query, params, perms);
            query += ROSTER_ORDER;

            // Optional pagination — only kicks in when the caller passes `limit` (keeps the existing
            // admin list, which reads the full array, working unchanged).
            const rawLimit = parseInt(req.query.limit, 10);
            if (Number.isFinite(rawLimit) && rawLimit > 0) {
                const lim = Math.min(rawLimit, 1000);
                const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
                query += ` LIMIT ? OFFSET ?`;
                params.push(lim, off);
            }

            const list = await db.all(query, params);

            // Parse custom_data (guarded — one malformed legacy row must not 500 the whole roster). The
            // registration code (barcode payload) only reaches inscriptions:view; the health answer health:view.
            res.json(await withHealthText(list.map(item => rosterRow(item, perms)), conference_id, perms));
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/publish', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        const { conference_id, published } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // A form with no field would take registrations with no data at all (2.16.0: a conference starts
            // empty). The page refuses too; this is the server's own rule. Unpublishing is always allowed.
            if (published) {
                const n = await db.get(`SELECT COUNT(*) AS n FROM ${T.fields} WHERE conference_id = ?`, [conference_id]);
                if (!Number(n && n.n)) return res.status(400).json({ error: 'No puedes publicar un formulario sin campos: añade al menos uno.', code: 'form_empty' });
            }
            await db.run(`UPDATE ${T.conferences} SET is_form_published = ? WHERE id = ?`, [published ? 1 : 0, conference_id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === FIELDS ===
    http.route('get', '/fields', { auth: true }, async (req, res) => {
        if (!await isStaff(req, res)) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT * FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    // Closed allowlist of field types (the admin builder offers text/number/select/date; the rest are
    // accepted for API callers and render as text inputs on the portal).
    const FIELD_TYPES = new Set(['text', 'number', 'select', 'textarea', 'date', 'email', 'tel', 'notes', 'switch', healthMod.TYPE]);
    // Field creation is check-then-insert (a template refuses a duplicate): serialised in this process.
    let fieldsLock = Promise.resolve();
    const withFieldsLock = (fn) => {
        const run = fieldsLock.then(fn, fn);
        fieldsLock = run.then(() => {}, () => {});
        return run;
    };
    // The next position at the END of a conference's form.
    const nextFieldOrder = async (conferenceId) => {
        const row = await db.get(`SELECT MAX(sort_order) AS m FROM ${T.fields} WHERE conference_id = ?`, [conferenceId]);
        return (Number(row && row.m) || 0) + 1;
    };

    // POST /fields { conference_id, template, label? } — add one of FIELD_TEMPLATES with its exact definition.
    // 400 unknown template / published form; 404 unknown conference; 409 the form already has that field
    // (same column name, or another field with the same role).
    async function createTemplateField(req, res) {
        const body = req.body || {};
        const conferenceId = positiveInt(body.conference_id);
        if (!conferenceId) return res.status(400).json({ error: 'Missing conference_id' });
        const key = typeof body.template === 'string' ? body.template : '';
        const tpl = Object.prototype.hasOwnProperty.call(FIELD_TEMPLATES, key) ? FIELD_TEMPLATES[key] : null;
        if (!tpl) return res.status(400).json({ error: 'Plantilla de campo desconocida.' });
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : tpl.label;
        if (label.length > 120) return res.status(400).json({ error: 'La etiqueta del campo es demasiado larga (máximo 120 caracteres).' });
        try {
            const out = await withFieldsLock(async () => {
                const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [conferenceId]);
                if (!conf) throw httpError(404, 'Conferencia no encontrada.');
                if (Number(conf.is_form_published)) throw httpError(400, 'No se pueden añadir campos después de publicar el formulario.');
                const existing = await db.all(`SELECT id, name, label, role, is_group FROM ${T.fields} WHERE conference_id = ?`, [conferenceId]);
                const clash = existing.find(f => f.name === tpl.name || (tpl.role && f.role === tpl.role));
                if (clash) {
                    const e = httpError(409, `El formulario ya tiene este campo: «${clash.label || clash.name}».`);
                    e.code = 'field_exists';
                    throw e;
                }
                // ONE grouping field per conference: a template never takes the flag away from another field.
                const grp = tpl.is_group && !existing.some(f => Number(f.is_group)) ? 1 : 0;
                if (tpl.type !== healthMod.TYPE) await addColumnIfMissing(T.inscriptions, tpl.name, 'TEXT');
                const r = await db.run(
                    `INSERT INTO ${T.fields} (conference_id, name, label, type, options, is_required, sort_order, width, role, is_group, is_unique) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conferenceId, tpl.name, label, tpl.type, tpl.options, tpl.is_required, await nextFieldOrder(conferenceId), 100, tpl.role, grp, 0]
                );
                return { id: r.lastID, name: tpl.name, is_group: grp };
            });
            res.json({ success: true, ...out });
        } catch (e) {
            if (e && e.code === 'field_exists') return res.status(409).json({ error: e.message, code: e.code });
            sendError(res, e);
        }
    }

    http.route('post', '/fields', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        if (req.body && req.body.template !== undefined && !req.body.id) return createTemplateField(req, res);
        const { id, conference_id, name, label, type, options, is_required, sort_order, width, is_group, is_unique } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const cleanLabel = String(label || '').trim();
        if (!cleanLabel) return res.status(400).json({ error: 'La etiqueta del campo es obligatoria.' });
        if (cleanLabel.length > 120) return res.status(400).json({ error: 'La etiqueta del campo es demasiado larga (máximo 120 caracteres).' });
        if (!FIELD_TYPES.has(type)) return res.status(400).json({ error: 'Tipo de campo inválido.' });
        let opts = options == null ? '' : String(options);
        if (opts.length > 2000) return res.status(400).json({ error: 'Las opciones del campo son demasiado largas (máximo 2000 caracteres).' });
        try {
            // Normalize width to the two layouts the builder offers (100% / 50%).
            const w = Number(width) === 50 ? 50 : 100;
            // Generic per-field feature flags: ANY field can be the grouping field (is_group) or a
            // no-duplicates field (is_unique). Nothing is tied to a fixed column name anymore.
            const grp = is_group ? 1 : 0;
            const uniq = is_unique ? 1 : 0;
            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            if (id) {
                // Column name is immutable after creation; the flags + cosmetic attributes can change
                // anytime (they don't alter the column). Publish still freezes the field's type.
                const existing = await db.get(`SELECT type, conference_id, name FROM ${T.fields} WHERE id = ?`, [id]);
                if (!existing) return res.status(404).json({ error: 'Campo no encontrado.' });
                // «Requiere hospedaje» stays a Sí / No switch: the assignment reads its «No».
                if (existing.name === LODGING_FIELD && type !== 'switch') return res.status(400).json({ error: 'El campo «Requiere hospedaje» siempre es un interruptor Sí / No.' });
                // «Condiciones de salud» stays what it is, and no other field becomes one (its answers are not a column).
                if ((existing.name === healthMod.FIELD) !== (type === healthMod.TYPE)) return res.status(400).json({ error: 'El campo «Condiciones de salud» solo se crea con su plantilla y no cambia de tipo.' });
                if (type === healthMod.TYPE) {
                    opts = healthMod.optionsText(opts);
                    if (!opts) return res.status(400).json({ error: 'Deja al menos una condición en la lista (además de «Otros»).' });
                }
                if (String(existing.conference_id) !== String(conference_id)) return res.status(403).json({ error: 'El campo no pertenece a esta conferencia.' });
                if (conf.is_form_published && existing.type !== type) {
                    return res.status(400).json({ error: 'No se puede cambiar el tipo de un campo después de publicar el formulario.' });
                }
                // Exactly ONE field groups attendees per conference — clear the flag off the others first.
                if (grp) await db.run(`UPDATE ${T.fields} SET is_group = 0 WHERE conference_id = ? AND id != ?`, [conference_id, id]);
                await db.run(
                    `UPDATE ${T.fields} SET label = ?, type = ?, options = ?, is_required = ?, sort_order = ?, width = ?, is_group = ?, is_unique = ? WHERE id = ?`,
                    [cleanLabel, type, opts, is_required ? 1 : 0, sort_order || 0, w, grp, uniq, id]
                );
            } else {
                if (conf.is_form_published) {
                    return res.status(400).json({ error: 'No se pueden añadir campos después de publicar el formulario.' });
                }
                // The registration form drives the schema: every field gets a safe column named after it
                // (or a generated fallback). A name that collides with an operational column (id,
                // total_due, room_id…) or a SQL reserved word is refused outright — the builder relies on
                // the generated `f_…` fallback only for names that are not identifiers at all.
                const requested = typeof name === 'string' ? name.trim() : '';
                if (requested && isReservedFieldName(requested)) return res.status(400).json({ error: 'Ese nombre de campo está reservado por el sistema.' });
                // The lodging switch's column is the template's alone (the assignment reads its «No»).
                if (requested === LODGING_FIELD) return res.status(400).json({ error: 'Para preguntar si requiere hospedaje, usa la plantilla «Requiere hospedaje».' });
                if (type === healthMod.TYPE) return res.status(400).json({ error: 'Para preguntar por condiciones de salud, usa la plantilla «Condiciones de salud».' });
                const colName = isSafeColumn(requested) ? requested : ('f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
                const clash = await db.get(`SELECT id FROM ${T.fields} WHERE conference_id = ? AND name = ?`, [conference_id, colName]);
                if (clash) return res.status(409).json({ error: 'Ya existe un campo con ese nombre en este formulario.' });
                if (grp) await db.run(`UPDATE ${T.fields} SET is_group = 0 WHERE conference_id = ?`, [conference_id]);
                await addColumnIfMissing(T.inscriptions, colName, 'TEXT');
                // A new field goes to the END of the form unless the caller places it (sort_order > 0).
                const order = Number(sort_order) > 0 ? Number(sort_order) : await nextFieldOrder(conference_id);
                await db.run(
                    `INSERT INTO ${T.fields} (conference_id, name, label, type, options, is_required, sort_order, width, is_group, is_unique) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, colName, cleanLabel, type, opts, is_required ? 1 : 0, order, w, grp, uniq]
                );
            }
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/fields/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        try {
            const field = await db.get(`SELECT conference_id, name FROM ${T.fields} WHERE id = ?`, [req.params.id]);
            if (field) {
                const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [field.conference_id]);
                if (conf?.is_form_published) {
                    return res.status(400).json({ error: 'No se pueden eliminar campos después de publicar el formulario.' });
                }
            }
            await db.run(`DELETE FROM ${T.fields} WHERE id = ?`, [req.params.id]);
            // Without the switch everyone needs lodging again: its answers must not keep anyone out of a room.
            if (field && field.name === LODGING_FIELD) await db.run(`UPDATE ${T.inscriptions} SET ${LODGING_FIELD} = NULL WHERE conference_id = ?`, [field.conference_id]);
            // Deleting «Condiciones de salud» deletes every answer to it (2.32.0).
            if (field && field.name === healthMod.FIELD) await health.clearConference(field.conference_id);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === FEE RULES (dynamic pricing) ===
    const FEE_OPERATORS = new Set(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'filled', 'empty', 'any', 'in', 'not_in', 'between', 'before', 'after']);
    const FEE_LIST_MAX = 500;
    // The value a rule stores for its operator (lists as JSON text), or an error message.
    function feeRuleValue(op, value) {
        if (op === 'in' || op === 'not_in') {
            const list = Array.isArray(value) ? value : feeList(value);
            if (!list || !list.length) return { error: 'Escoge al menos un valor para la regla.' };
            if (list.length > FEE_LIST_MAX) return { error: `Máximo ${FEE_LIST_MAX} valores por regla.` };
            return { value: JSON.stringify([...new Set(list.map(v => String(v == null ? '' : v).trim()).filter(Boolean))]) };
        }
        if (op === 'between') {
            const pair = Array.isArray(value) ? value : feeList(value);
            if (!pair || pair.length !== 2) return { error: 'Un rango necesita «desde» y «hasta» (uno de los dos puede quedar abierto).' };
            const [lo, hi] = pair.map(v => String(v == null ? '' : v).trim());
            if (!lo && !hi) return { error: 'Escribe al menos uno de los dos extremos del rango.' };
            if (lo && hi && feeCmp(lo, hi) > 0) return { error: '«Desde» no puede ser mayor que «hasta».' };
            return { value: JSON.stringify([lo, hi]) };
        }
        if ((op === 'before' || op === 'after') && !feeDate(value)) return { error: 'Escoge una fecha para la regla.' };
        return { value: value == null ? '' : String(value) };
    }
    // The people a rule would reach now (the builder's live preview): the active inscriptions.
    async function feeRulePreview(cid, rule) {
        const rows = await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND (status IS NULL OR status <> 'cancelled') ORDER BY id ASC`, [cid]);
        const hits = rows.filter(r => feeRuleMatches(rule, r));
        const sample = [];
        for (const r of hits.slice(0, 8)) sample.push((await personWithName(r)).name || `#${r.id}`);
        return { count: hits.length, total: rows.length, sample };
    }

    http.route('get', '/fee-rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'view')) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // 2.36.4, the rule builder's choices: ?values=<field> → the distinct values this conference's people have,
            // with how many have each; ?values=__person → the people (name, locality, document), to pick some.
            const field = req.query.values;
            if (field) {
                const cid = positiveInt(conference_id);
                if (field === FEE_PERSON) {
                    if (!await allow(req, res, 'inscriptions', 'view')) return;
                    const rows = await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND (status IS NULL OR status <> 'cancelled') ORDER BY id ASC`, [cid]);
                    const docField = (await db.all(`SELECT name, label FROM ${T.fields} WHERE conference_id = ?`, [cid])).find(f => /document|cedula|c[eé]dula|identificaci/i.test(`${f.name} ${f.label}`) && isFieldColumn(f.name));
                    const people = [];
                    for (const r of rows) people.push({ id: Number(r.id), name: (await personWithName(r)).name || `#${r.id}`, location: r.location || '', document: docField && r[docField.name] != null ? String(r[docField.name]) : '' });
                    return res.json({ field, people });
                }
                const names = new Set([...FEE_ALWAYS_FILLED, ...(await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [cid])).map(f => f.name).filter(isFieldColumn)]);
                if (!names.has(field) || field === healthMod.FIELD) return res.status(400).json({ error: 'Campo inválido.' });
                const rows = await db.all(`SELECT ${field} AS v, COUNT(*) AS n FROM ${T.inscriptions} WHERE conference_id = ? AND (status IS NULL OR status <> 'cancelled') GROUP BY ${field} ORDER BY n DESC`, [cid]);
                const merged = new Map();
                for (const r of rows) {
                    const v = r.v == null ? '' : String(r.v).trim();
                    if (!v) continue;
                    const k = canonNumberish(v);
                    const cur = merged.get(k);
                    merged.set(k, { value: cur ? cur.value : v, count: (cur ? cur.count : 0) + Number(r.n || 0) });
                }
                return res.json({ field, values: [...merged.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'es')) });
            }
            const list = await db.all(`SELECT * FROM ${T.feeRules} WHERE conference_id = ? ORDER BY priority ASC, id ASC`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/fee-rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        const { id, conference_id, label, field_name, operator, action, amount, priority, enabled } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const op = FEE_OPERATORS.has(operator) ? operator : 'eq';
        // 2.36.4: a list or a range is stored as JSON text; a date rule needs a date.
        const checked = field_name && op !== 'any' && !['filled', 'empty'].includes(op) ? feeRuleValue(op, req.body.value) : { value: req.body.value == null ? '' : String(req.body.value) };
        if (checked.error) return res.status(400).json({ error: checked.error, field: 'value' });
        const value = checked.value;
        // «Esta regla aplica a N personas» (the builder's live preview): the rule as typed, nothing saved.
        if (req.body.preview) {
            if (field_name === healthMod.FIELD) return res.status(400).json({ error: 'Las condiciones de salud no pueden usarse en una regla de precio.' });
            try { return res.json(await feeRulePreview(positiveInt(conference_id), { field_name: field_name || '', operator: op, value })); }
            catch (e) { return sendError(res, e); }
        }
        const act = action === 'add' ? 'add' : 'set';
        if (!Number.isFinite(Number(amount)) || Math.abs(Number(amount)) > MAX_MONEY) return res.status(400).json({ error: 'El monto de la regla es inválido.' });
        const amt = roundMoney(amount);
        // Health answers never set a price (2.32.0): they are not a column, and pricing by them would be unfair.
        if (field_name === healthMod.FIELD) return res.status(400).json({ error: 'Las condiciones de salud no pueden usarse en una regla de precio.' });
        try {
            const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            if (id) {
                await db.run(
                    `UPDATE ${T.feeRules} SET label = ?, field_name = ?, operator = ?, value = ?, action = ?, amount = ?, priority = ?, enabled = ? WHERE id = ? AND conference_id = ?`,
                    [label || '', field_name || '', op, value == null ? '' : String(value), act, amt, Number(priority) || 0, enabled ? 1 : 0, id, conference_id]
                );
            } else {
                await db.run(
                    `INSERT INTO ${T.feeRules} (conference_id, label, field_name, operator, value, action, amount, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, label || '', field_name || '', op, value == null ? '' : String(value), act, amt, Number(priority) || 0, enabled === undefined ? 1 : (enabled ? 1 : 0)]
                );
            }
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/fee-rules/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        try {
            await db.run(`DELETE FROM ${T.feeRules} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // GET /public/pdfjs?part=main|worker (2.36.4) → { version, part, sha256, b64 } — the PDF renderer (pdf.js, Apache-2.0,
    // server/pdfjs-legacy.js) the signed-sheet viewer loads only when a PDF is opened, to show ANY PDF page by page.
    // Public and immutable: code, no data. Read from disk the first time it is asked for.
    let pdfjsVendor = null;
    http.route('get', '/public/pdfjs', async (req, res) => {
        const q = req.query || {};
        const part = q.part === 'main' || q.part === 'worker' ? q.part : null;
        if (!part) return res.status(400).json({ error: 'part: main o worker.' });
        try {
            if (!pdfjsVendor) pdfjsVendor = require('./server/pdfjs-legacy');
            try { res.set({ 'Cache-Control': 'public, max-age=31536000, immutable' }); } catch (e) { /* a bridge without headers */ }
            res.json({ version: pdfjsVendor.version, part, sha256: pdfjsVendor.sha256[part], b64: pdfjsVendor[part] });
        } catch (e) { sendError(res, e); }
    });

    // Public price quote — the portal shows the live total before submitting. Returns only a number
    // (no PII). Only for a published conference. Values are canonicalised exactly like a registration
    // (a value that cannot be canonicalised → 400 with the same message the form would get).
    http.route('post', '/public/quote', async (req, res) => {
        const { conference_id, fields } = req.body || {};
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT fee_default, is_form_published FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf || !conf.is_form_published) return res.status(403).json({ error: 'Formulario no disponible.' });
            const confFields = await db.all(FIELD_COLUMNS_SQL, [conference_id]);
            // A phone still being typed never fails a quote (phones do not price).
            const vals = canonicalFieldValues(confFields, fields, { lenientPhone: true });
            const total = await computeFee(conference_id, vals, conf.fee_default);
            res.json({ total });
        } catch (e) { sendError(res, e); }
    });

    // Re-price EVERY inscription of a conference against the CURRENT base fee + rules. total_due is
    // frozen at registration (PUT /inscriptions/:id re-prices one row only when the edit itself changes
    // the outcome of the current rules); THIS is the path that applies rule/base-fee changes
    // retroactively, to everyone at once. amount_paid
    // (the payments ledger) is untouched — only total_due + the derived payment_status change.
    // Bounded: the rules load ONCE, rows page in 500s, writes go through db.batch, and payment_status
    // is refreshed with ONE set-based statement (≈142 RPCs for 20 000 rows instead of 60 000+).
    const REPRICE_MAX_ROWS = 20000, REPRICE_PAGE = 500;
    http.route('post', '/reprice', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        const { conference_id } = req.body || {};
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT fee_default FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const cnt = await db.get(`SELECT COUNT(*) as c FROM ${T.inscriptions} WHERE conference_id = ?`, [conference_id]);
            if (Number(cnt && cnt.c) > REPRICE_MAX_ROWS) return res.status(400).json({ error: `Demasiadas inscripciones para re-cotizar en una sola operación (máximo ${REPRICE_MAX_ROWS}).` });
            const rules = await loadFeeRules(conference_id);
            let updated = 0, total = 0;
            for (let off = 0; ; off += REPRICE_PAGE) {
                const rows = await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? ORDER BY id LIMIT ? OFFSET ?`, [conference_id, REPRICE_PAGE, off]);
                const writes = [];
                for (const row of rows) {
                    const fee = applyFeeRules(rules, row, conf.fee_default);
                    if (toCents(fee) !== toCents(row.total_due)) writes.push([`UPDATE ${T.inscriptions} SET total_due = ? WHERE id = ?`, [fee, row.id]]);
                }
                await runBatched(writes);
                updated += writes.length; total += rows.length;
                if (rows.length < REPRICE_PAGE) break;
            }
            // Always refresh payment_status — it can be stale even when total_due is unchanged
            // (e.g. a free/$0 fee with a prior payment should read 'paid', not 'partial').
            await recomputePayments('conference_id = ?', [conference_id]);
            res.json({ success: true, total, updated });
        } catch (e) { sendError(res, e); }
    });

    // Create Inscription (admin). total_due is server-controlled (fee rules + base fee).
    http.route('post', '/inscriptions', { auth: true }, async (req, res) => {
        const perms = await allow(req, res, 'inscriptions', 'manage');
        if (!perms) return;
        const { conference_id, ...fieldValues } = req.body || {};
        // Guard against a non-scalar conference_id (the old client arity bug shipped the whole form
        // object here) so we never insert a garbage row bound to '[object Object]'.
        const confId = Number(conference_id);
        if (!confId || !Number.isFinite(confId)) return res.status(400).json({ error: 'Missing or invalid conference_id' });

        try {
            const conf = await db.get(`SELECT fee_default, phone_country FROM ${T.conferences} WHERE id = ?`, [confId]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });

            // The form is the source of truth: write each DEFINED field's canonical value into its own
            // column. Values for keys that aren't defined (writable) fields are ignored.
            const confFields = await db.all(FIELD_COLUMNS_SQL, [confId]);
            const values = { conference_id: confId };
            Object.assign(values, canonicalFieldValues(confFields, fieldValues, { phoneCountry: phoneCountryOf(conf) }));
            assertRequired(confFields, values, false);
            const healthIn = await healthFromBody(confId, fieldValues, { mayWrite: canWriteHealth(perms), creating: true });
            const consentOn = await consent.isEnabled(confId);
            assertGeneralVerbal(consentOn, fieldValues);
            if (consentOn) await assertConsentEmail(confId, values);

            // The admin explicitly PICKS the location (unlike the portal, which forces the coordinator's
            // own). It's an operational column, not a form field: `location_id` (preferred) or the
            // legacy `location` name, both resolved against this conference's locations. A new attendee holds
            // no bed, so registering them into a submitted / validated location adjusts nobody's arrangement
            // (the bed rule of PUT /inscriptions/:id): inscriptions:manage alone, no stamp.
            const loc = await resolveAdminLocation(confId, fieldValues);
            if (loc) { await assertLocationHasRoom(loc); values.location_id = loc.id; values.location = loc.name; }

            // first_name / last_name are NOT NULL — default to '' (no more 'Sin Nombre' placeholder);
            // the display name is whatever the form collects, not an assumed column.
            if (values.first_name == null) values.first_name = '';
            if (values.last_name == null) values.last_name = '';

            // Apply the fee (server-controlled) from the pricing rules + base fee, computed against
            // the attendee's field values — so the attendee isn't instantly 'paid' and tiered/rule
            // pricing takes effect. A client-sent total_due is never honoured.
            values.total_due = await computeFee(confId, values, conf.fee_default);
            values.reg_code = await newRegCode();

            // Duplicate guard: every field flagged "no duplicates" must be unique within the conference
            // (generic — the admin can mark any field, e.g. a document number or an email, as unique).
            await assertUnique(confFields, values, { conference_id: confId });
            await assertNoEmailDuplicate(confId, values, { conference_id: confId });
            values.created_by = actorOf(req);

            const keys = Object.keys(values);
            const insert = () => db.run(
                `INSERT INTO ${T.inscriptions} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                Object.values(values)
            );
            const result = loc ? await takeSeat(loc, insert) : await insert();
            if (healthIn.answer) await health.save(confId, result.lastID, healthIn.answer);
            const consentOut = consentOn ? await askConsent(result.lastID, actorOf(req), 'admin') : undefined;
            await recordHistory(confId, result.lastID, 'created', actorOf(req), 'admin');
            if (consentOn) await consentGeneralEntered(result.lastID, actorOf(req), 'admin');
            if (consentOn && healthIn.answer) await consentHealthEntered(result.lastID, actorOf(req), 'admin', healthIn);
            res.json({ success: true, id: result.lastID, ...(consentOut ? { consent: consentOut } : {}) });
        } catch (e) { sendError(res, e); }
    });

    // === LOCATIONS ===
    http.route('get', '/locations', { auth: true }, async (req, res) => {
        const perms = await isStaff(req, res);
        if (!perms) return;
        const showCodes = canSeeLocationCodes(perms);
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT *, (SELECT COUNT(*) FROM ${T.fields} WHERE conference_id = ${T.conferences}.id) as fields_count FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            // `inscribed` = seats taken (see occupiedSql), so the card can show 12 / 50 without a second call.
            // Lodging (2.5.0): rooms/beds allotted to the location, its attendees with a room (any room)
            // and its non-cancelled attendees still without one.
            const locations = await db.all(
                `SELECT l.*, (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.location_id = l.id AND ${occupiedSql('i.status')}) AS inscribed,`
                + ` (SELECT COUNT(*) FROM ${T.rooms} r WHERE r.location_id = l.id) + (SELECT COUNT(*) FROM ${T.roomBeds} b WHERE b.location_id = l.id) AS rooms_allotted,`
                + ` (SELECT COALESCE(SUM(r.capacity), 0) FROM ${T.rooms} r WHERE r.location_id = l.id) + (SELECT COALESCE(SUM(b.beds), 0) FROM ${T.roomBeds} b WHERE b.location_id = l.id) AS beds_allotted,`
                + ` (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.location_id = l.id AND i.room_id IS NOT NULL) AS lodged,`
                + ` (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.location_id = l.id AND i.room_id IS NULL AND ${occupiedSql('i.status')} AND ${lodgingSql('i.' + LODGING_FIELD)}) AS unlodged`
                + ` FROM ${T.locations} l WHERE l.conference_id = ? ORDER BY l.name`, [conference_id]);
            for (const l of locations) {
                l.payment_methods = enabledPaymentMethods(l);
                l.lodging_status = lodgingStatusOf(l);
                l.rooms_allotted = Number(l.rooms_allotted) || 0;
                l.beds_allotted = Number(l.beds_allotted) || 0;
                l.lodged = Number(l.lodged) || 0;
                l.unlodged = Number(l.unlodged) || 0;
                // Its lodging dates (2.21.0): its own (lodging_opens / lodging_closes as stored: null = the general
                // one) and the window they make with the general ones.
                const win = lodgingWindow(conf, l);
                l.lodging_opens = win.own_opens;
                l.lodging_closes = win.own_closes;
                l.lodging_window = lodgingWindowView(win);
                delete l.lodging_permission; delete l.lodging_permission_until;
                // Can the coordinator change the lodging right now? (window open AND still a draft)
                l.lodging_can_edit = win.open && l.lodging_status === 'draft';
                // The administration's adjustments since the coordinator's last submission (2.17.0).
                Object.assign(l, adminAdjustmentOf(l, hasLevel(perms, 'locations', 'view')));
                // The access code IS the coordinator's portal login: only who may change it sees it.
                if (!showCodes) l.code = null;
                // Every team member gets the locations as context (names, capacity, lodging state); the
                // coordinator's contact and the admin's review notes are the Localidades section's business.
                if (!hasLevel(perms, 'locations', 'view')) {
                    l.responsible_name = null; l.responsible_phone = null; l.lodging_note = null; l.lodging_reviewed_by = null;
                    l.responsible_email = null; l.welcome_sent_s = null; l.welcome_sent_by = null; l.welcome_sent_to = null;
                }
            }
            // 2.36.12: «Encargado editado» — the last edits of each locality's coordinator data (who, when, which fields).
            if (hasLevel(perms, 'locations', 'view') && locations.length) {
                const rows = await db.all(`SELECT location_id, actor, at_s, fields FROM ${T.locationLog} WHERE conference_id = ? AND kind = 'coordinator' ORDER BY at_s DESC, id DESC`, [conference_id]);
                const byLoc = new Map();
                for (const r of rows) {
                    const list = byLoc.get(Number(r.location_id)) || [];
                    if (list.length >= 10) continue;
                    let fields = [];
                    try { fields = JSON.parse(r.fields || '[]'); } catch (e) { fields = []; }
                    list.push({ actor: r.actor || null, at_s: Number(r.at_s), fields: Array.isArray(fields) ? fields : [] });
                    byLoc.set(Number(r.location_id), list);
                }
                for (const l of locations) l.coordinator_log = byLoc.get(Number(l.id)) || [];
            }
            if (conf) {
                // The general dates as typed, and their window (no location's own dates).
                const general = lodgingWindow(conf, null);
                conf.lodging_opens = general.opens;
                conf.lodging_deadline = general.closes;
                conf.lodging_tz = general.tz;
                conf.lodging_window = lodgingWindowView(general);
                conf.lodging_deadline_passed = general.passed;
            }
            res.json({ locations, conference: conf });
        } catch (e) { sendError(res, e); }
    });

    // Location names are unique per conference (case-insensitive) so the display label is unambiguous.
    http.route('post', '/locations', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        const { conference_id, name, capacity, payment_methods } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const cleanName = String(name || '').trim();
        if (!cleanName) return res.status(400).json({ error: 'El nombre de la localidad es obligatorio.' });
        // The maximum number of registrants is part of creating a location, not an afterthought.
        if (capacity === undefined || capacity === null) return res.status(400).json({ error: 'El cupo máximo de inscritos es obligatorio.' });

        try {
            const cap = parseCapacity(capacity);
            // Forms of payment: chosen at creation (default both), editable later through PUT.
            const methods = payment_methods === undefined ? PAYMENT_METHODS.slice() : parsePaymentMethods(payment_methods);
            const conf = await db.get(`SELECT id, phone_country FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const coord = coordinatorInput(req.body, conf);
            if (coord.error) return res.status(400).json(coord.error);
            const dup = await db.get(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND LOWER(name) = LOWER(?)`, [conference_id, cleanName]);
            if (dup) return res.status(409).json({ error: 'Ya existe una localidad con ese nombre en esta conferencia.' });
            const code = await genAccessCode();
            const result = await db.run(
                `INSERT INTO ${T.locations} (conference_id, name, code, responsible_name, responsible_phone, responsible_email, capacity, payment_methods) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [conference_id, cleanName, code, coord.values.responsible_name || null, coord.values.responsible_phone || null, coord.values.responsible_email || null, cap, JSON.stringify(methods)]
            );
            res.json({ success: true, id: result.lastID, code, payment_methods: methods });
        } catch (e) { sendError(res, e); }
    });

    // Update a location; pass rotate_code:true to issue a fresh access code (invalidates old sessions).
    // A rename also refreshes the display label on the location's inscriptions (location_id stays).
    // `capacity` may go up or down, but never below the seats already taken (409 with the current count).
    // `payment_methods` replaces the enabled set (a form of payment not enabled at creation can be enabled here).
    // Its own lodging dates (2.21.0): `lodging_opens` — '' / null = the general opening, 'now' = no wait, or a
    // date; `lodging_closes` — '' / null = the general closing, 'never' = no closing, or a date (a past one
    // closes it now). Together with the general ones they may not make a window that never opens (400).
    // `lodging_tz`: the admin's zone, stored on the conference with the dates. The 2.8.0 permission is an
    // own closing: `lodging_permission` true = until `lodging_permission_until` (none = no closing), false
    // = the general closing.
    // 2.36.11: «Enviar bienvenida» / «Reenviar» — the welcome e-mail to the locality's coordinator («Correo del
    // encargado»): what the portal is, the portal's address (the layout's button) and the administration's contact
    // when «Autorizaciones» has one. NEVER the access code: no value of the message can hold it — the coordinator
    // asks the administration for it. Once a minute and five times an hour per locality; every send is logged
    // (location_mails) and the last one is shown on the locality (welcome_sent_s / welcome_sent_by).
    const welcomeSends = new Map();
    http.route('post', '/locations/:id/welcome', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const loc = id ? await db.get(`SELECT id, conference_id, name, responsible_email FROM ${T.locations} WHERE id = ?`, [id]) : null;
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const to = String(loc.responsible_email || '').trim();
            if (!CONSENT_EMAIL_RE.test(to)) return res.status(409).json({ error: 'Escribe primero el correo del encargado.', code: 'no_email' });
            const now = Date.now();
            const recent = (welcomeSends.get(loc.id) || []).filter(t => now - t < 3600e3);
            if ((recent.length && now - recent[recent.length - 1] < 60e3) || recent.length >= 5) {
                return res.status(429).json({ error: 'Ya se envió hace poco. Espera un momento antes de reenviarlo.', code: 'rate' });
            }
            recent.push(now);
            welcomeSends.set(loc.id, recent);
            const conf = await db.get(`SELECT id, name, slug FROM ${T.conferences} WHERE id = ?`, [loc.conference_id]);
            const base = (await siteLinkBase().catch(() => '')) || '';
            const url = `${base}/portal/conference?slug=${encodeURIComponent(conf ? conf.slug : '')}`;
            let contact = '';
            try { contact = String((await consent.settingsOf(loc.conference_id)).contact_email || ''); } catch (e) { contact = ''; }
            const lang = await consent.mailLangOf(loc.conference_id);
            const msg = await mailTemplates.render('location.welcome', lang, { location: loc.name, conference: conf ? conf.name : '', admin_contact: contact }, { action: { url } });
            const at = Math.floor(now / 1000);
            const actor = actorOf(req);
            let why = null;
            try { await wordjs.mail({ to, ...msg }); } catch (e) { why = String(e && e.message || e).slice(0, 300); }
            await db.run(`INSERT INTO ${T.locationMails} (conference_id, location_id, kind, email, actor, at_s, ok, error) VALUES (?, ?, 'welcome', ?, ?, ?, ?, ?)`,
                [loc.conference_id, loc.id, to, actor ? String(actor).slice(0, 120) : null, at, why ? 0 : 1, why]);
            if (why) {
                const off = /permission|denied|not available|not granted|permiso/i.test(why);
                return res.status(off ? 503 : 502).json({ error: off ? 'El correo del sitio no está disponible: revisa el plugin de correo y su permiso.' : 'No se pudo enviar el correo. Inténtalo de nuevo más tarde.', code: off ? 'mail_off' : 'mail_failed' });
            }
            await db.run(`UPDATE ${T.locations} SET welcome_sent_s = ?, welcome_sent_by = ?, welcome_sent_to = ? WHERE id = ?`, [at, actor ? String(actor).slice(0, 120) : null, to, loc.id]);
            res.json({ success: true, sent: true, welcome_sent_at: new Date(at * 1000).toISOString(), welcome_sent_to: to, email_masked: maskEmail(to) });
        } catch (e) { sendError(res, e); }
    });

    http.route('put', '/locations/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        const { name, responsible_name, responsible_phone, responsible_email, rotate_code, capacity, payment_methods, lodging_opens, lodging_permission, lodging_permission_until, lodging_tz } = req.body;
        let { lodging_closes } = req.body;
        try {
            const loc = await db.get(`SELECT * FROM ${T.locations} WHERE id = ?`, [req.params.id]);
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const sets = [], params = [];
            let newName = null;
            if (name !== undefined) {
                const v = String(name).trim();
                if (!v) return res.status(400).json({ error: 'El nombre de la localidad es obligatorio.' });
                const dup = await db.get(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND LOWER(name) = LOWER(?) AND id != ?`, [loc.conference_id, v, loc.id]);
                if (dup) return res.status(409).json({ error: 'Ya existe una localidad con ese nombre en esta conferencia.' });
                sets.push('name = ?'); params.push(v);
                if (v !== loc.name) newName = v;
            }
            // The coordinator's data (2.36.12: all of it editable — «Editar encargado»): name, phone (E.164 with the
            // conference's default country) and «Correo del encargado» (where the welcome goes); '' clears a field.
            // A change is logged as «encargado editado» (who, when, which fields — never the values).
            const conf = await db.get(`SELECT phone_country FROM ${T.conferences} WHERE id = ?`, [loc.conference_id]);
            const coord = coordinatorInput({ responsible_name, responsible_phone, responsible_email }, conf);
            if (coord.error) return res.status(400).json(coord.error);
            const changedCoord = [];
            for (const [key, field] of COORDINATOR_FIELDS) {
                if (!(key in coord.values)) continue;
                const next = coord.values[key] || null;
                sets.push(`${key} = ?`); params.push(next);
                const before = loc[key] == null || loc[key] === '' ? null : String(loc[key]);
                if (before !== next) changedCoord.push(field);
            }
            if (capacity !== undefined) {
                const cap = parseCapacity(capacity);
                const taken = await locationOccupancy(loc.id);
                if (cap < taken) return res.status(409).json({ error: `El cupo no puede ser menor que los ${taken} inscritos que ya tiene la localidad.`, inscribed: taken });
                sets.push('capacity = ?'); params.push(cap);
            }
            if (payment_methods !== undefined) { sets.push('payment_methods = ?'); params.push(JSON.stringify(parsePaymentMethods(payment_methods))); }
            if (lodging_closes === undefined && (lodging_permission !== undefined || lodging_permission_until !== undefined)) {
                const PERM = { true: 1, false: 0, 1: 1, 0: 0 };
                const granted = lodging_permission === undefined ? 1 : PERM[String(lodging_permission)];
                if (granted === undefined) return res.status(400).json({ error: 'El permiso debe ser verdadero o falso.' });
                lodging_closes = granted ? (lodging_permission_until || LODGING_NO_CLOSE) : null;
            }
            let tz = null;
            if (lodging_opens !== undefined || lodging_closes !== undefined) {
                const conf = await db.get(`SELECT lodging_opens, lodging_deadline, lodging_tz FROM ${T.conferences} WHERE id = ?`, [loc.conference_id]);
                tz = lodging_tz !== undefined ? lodgingTzInput(lodging_tz) : lodgingZone(conf && conf.lodging_tz);
                const own = (v, current, none, label) => (v === undefined ? current : v === null || String(v).trim() === '' ? null
                    : String(v).trim() === none ? none : lodgingDateInput(v, label));
                const opens = own(lodging_opens, loc.lodging_opens || null, LODGING_NO_WAIT, 'apertura de hospedajes');
                const closes = own(lodging_closes, loc.lodging_closes || null, LODGING_NO_CLOSE, 'cierre de hospedajes');
                const win = lodgingWindow({ ...conf, lodging_tz: tz }, { lodging_opens: opens, lodging_closes: closes });
                if (win.opens && win.closes && lodgingStart(win.opens, tz) >= lodgingEnd(win.closes, tz)) {
                    return res.status(400).json({ error: `Con esas fechas la localidad nunca podría acomodar: la apertura (${fmtDeadline(win.opens)}) es posterior al cierre (${fmtDeadline(win.closes)}).` });
                }
                sets.push('lodging_opens = ?', 'lodging_closes = ?'); params.push(opens, closes);
            }
            let newCode = null;
            if (rotate_code) { newCode = await genAccessCode(); sets.push('code = ?'); params.push(newCode); }
            if (sets.length) {
                params.push(loc.id);
                await db.run(`UPDATE ${T.locations} SET ${sets.join(', ')} WHERE id = ?`, params);
            }
            if (newName !== null) await db.run(`UPDATE ${T.inscriptions} SET location = ? WHERE location_id = ?`, [newName, loc.id]);
            let coordEntry = null;
            if (changedCoord.length) {
                const actor = actorOf(req);
                coordEntry = { actor: actor ? String(actor).slice(0, 120) : null, at_s: Math.floor(Date.now() / 1000), fields: changedCoord };
                await db.run(`INSERT INTO ${T.locationLog} (conference_id, location_id, kind, actor, at_s, fields) VALUES (?, ?, 'coordinator', ?, ?, ?)`,
                    [loc.conference_id, loc.id, coordEntry.actor, coordEntry.at_s, JSON.stringify(changedCoord)]);
            }
            if (tz && lodging_tz !== undefined) await db.run(`UPDATE ${T.conferences} SET lodging_tz = ? WHERE id = ?`, [tz, loc.conference_id]);
            const out = { success: true, code: newCode || loc.code };
            // What was stored (the phone as E.164), so the card shows exactly that.
            if (Object.keys(coord.values).length) Object.assign(out, coord.values, { coordinator_changed: changedCoord, coordinator_entry: coordEntry });
            res.json(out);
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/locations/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            if (!id) return res.status(404).json({ error: 'Localidad no encontrada.' });
            // Lodging: its attendees leave the rooms that were allotted to it (those rooms go back to
            // the pool and would otherwise hold people of no location), and its own rules go with it.
            // Under the assignment lock (2.18.0), like every write of rooms and beds.
            await withAssignmentLock(async () => {
                // Nobody held by the administration (see «HELD BY THE ADMINISTRATION»): their rooms become pool rooms.
                await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE location_id = ? AND room_id IN (SELECT id FROM ${T.rooms} WHERE location_id = ?) AND ${NOT_HELD_SQL()}`, [id, id]);
                await db.run(`UPDATE ${T.rooms} SET location_id = NULL, allot_source = NULL WHERE location_id = ?`, [id]);
                // Its beds in shared rooms (2.18.0) become pool beds; its attendees there leave them, like above.
                await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE location_id = ? AND room_id IN (SELECT room_id FROM ${T.roomBeds} WHERE location_id = ?) AND ${NOT_HELD_SQL()}`, [id, id]);
                await db.run(`DELETE FROM ${T.roomBeds} WHERE location_id = ?`, [id]);
                await db.run(STALE_LOCKS_SQL());
                await db.run(`DELETE FROM ${T.rules} WHERE location_id = ?`, [id]);
            });
            // Under the payments lock, then the meals lock (the order DELETE /inscriptions takes them in):
            // - a portal payment of this location being recorded right now (it checks its people, then
            //   writes its header) finishes BEFORE the location goes — and detachLocation then clears its
            //   recorder location — or starts after, when its people no longer belong to the location (400).
            //   Without it the header could be written with the deleted id after the detach ran: a payment
            //   that offers «Devolver» to a portal that no longer exists;
            // - a plan write re-reads the location inside the meals lock, so it can never add a plan row for
            //   this location once it is gone.
            await fees.withPaymentsLock(() => withMealsLock(async () => {
                // No FK can be added by ALTER in SQLite: detach the attendees explicitly. The label is kept
                // for history (reports/CSV still show where they registered; the meals views show the
                // live location of location_id instead).
                await db.run(`UPDATE ${T.inscriptions} SET location_id = NULL WHERE location_id = ?`, [id]);
                await db.run(`DELETE FROM ${T.locations} WHERE id = ?`, [id]);
                // Fee payments (2.18.0): a payment the location's portal recorded keeps its people and money;
                // it just no longer names a recorder location (plain column, no FK).
                await fees.detachLocation(id);
                // Meals (2.14.0): the location's plan goes with it (parent first; the FK cascades too); its
                // attendees keep only their explicit per-person includes (and every delivery already made —
                // that is history).
                await db.run(`DELETE FROM ${T.mealPlan} WHERE location_id = ?`, [id]);
            }));
            // A room or bed write that was already waiting for the lock when the location was read may have
            // given it a room or beds in between: one last sweep, under the lock, once the row is gone (every
            // later write re-reads the location under the lock and finds nothing).
            await withAssignmentLock(async () => {
                await db.run(`UPDATE ${T.rooms} SET location_id = NULL, allot_source = NULL WHERE location_id = ?`, [id]);
                await db.run(`DELETE FROM ${T.roomBeds} WHERE location_id = ?`, [id]);
                await db.run(STALE_LOCKS_SQL());
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // ── lodging review (admin validates what the coordinator arranged) ───────────────────────
    // The arrangement of a location: its allotted rooms with L's occupants, L's attendees without a
    // room, those the admin placed elsewhere, the rules in force and the audit of the current state.
    http.route('get', '/locations/:id/lodging', { auth: true }, async (req, res) => {
        const perms = await allow(req, res, 'locations', 'view');
        if (!perms) return;
        try {
            const id = positiveInt(req.params.id);
            const loc = id ? await db.get(`SELECT * FROM ${T.locations} WHERE id = ?`, [id]) : null;
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            res.json(await loadLodging(loc, { forAdmin: true, perms }));
        } catch (e) { sendError(res, e); }
    });
    // State transitions are compare-and-set: ONE conditional UPDATE under the assignment lock; a 409 is
    // derived from `changes === 0` (someone else moved the state first).
    //
    // Validate / return also take what the reviewer SAW (2.17.0): since the administration may change a
    // submitted arrangement while it is under review (an administration adjustment, possibly by another
    // admin or team member), `seen: { submitted_at, admin_changes }` — the `lodging_submitted_at` and
    // `lodging_admin_changes` of the review the admin was looking at — must still be the location's, or
    // the answer is 409 `lodging_changed` and the admin reviews again. It catches an adjustment made
    // meanwhile and a coordinator who withdrew and sent again. Checked under the lock, where every stamp and
    // every submission is written, so nothing lands between the check and the UPDATE. Without `seen` (an
    // API caller) the status alone decides, as before; without the stamp columns (a failed migration) the
    // submission time alone does.
    const LODGING_CHANGED = 'El hospedaje cambió mientras lo revisabas (un ajuste de la administración o un nuevo envío del encargado): revísalo de nuevo antes de validarlo o devolverlo.';
    const canonStamp = (v) => (v == null || v === '' ? null : (v instanceof Date ? v.toISOString() : String(v)));
    async function reviewStillSeen(id, seen) {
        if (!seen || typeof seen !== 'object') return true;
        let now;
        try {
            now = await db.get(`SELECT lodging_status, lodging_submitted_at, lodging_admin_changed_at, lodging_admin_changes FROM ${T.locations} WHERE id = ?`, [id]);
        } catch (e) {
            now = await db.get(`SELECT lodging_status, lodging_submitted_at FROM ${T.locations} WHERE id = ?`, [id]);
            if (now) now.lodging_admin_changes = undefined;
        }
        // Not submitted any more (or gone): the status compare-and-set answers that.
        if (!now || lodgingStatusOf(now) !== 'submitted') return true;
        if (canonStamp(now.lodging_submitted_at) !== canonStamp(seen.submitted_at)) return false;
        if (now.lodging_admin_changes === undefined) return true;
        return adminAdjustmentOf(now, false).lodging_admin_changes === (Number(seen.admin_changes) || 0);
    }
    http.route('post', '/locations/:id/lodging/validate', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const loc = id ? await db.get(`SELECT id FROM ${T.locations} WHERE id = ?`, [id]) : null;
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const r = await withAssignmentLock(async () => {
                if (!await reviewStillSeen(id, (req.body || {}).seen)) return { stale: true };
                return db.run(
                    `UPDATE ${T.locations} SET lodging_status = 'validated', lodging_reviewed_at = CURRENT_TIMESTAMP, lodging_reviewed_by = ?, lodging_note = NULL WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'submitted'`,
                    [reviewerOf(req), id]);
            });
            if (r && r.stale) return res.status(409).json({ error: LODGING_CHANGED, code: 'lodging_changed' });
            if (!r || !r.changes) return res.status(409).json({ error: 'El hospedaje no está enviado a validación.' });
            res.json({ success: true, lodging_status: 'validated' });
        } catch (e) { sendError(res, e); }
    });
    http.route('post', '/locations/:id/lodging/return', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const loc = id ? await db.get(`SELECT id FROM ${T.locations} WHERE id = ?`, [id]) : null;
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const note = typeof (req.body || {}).note === 'string' ? req.body.note.trim() : '';
            if (!note) return res.status(400).json({ error: 'Indica las observaciones para el encargado.' });
            if (note.length > 2000) return res.status(400).json({ error: 'Las observaciones son demasiado largas (máximo 2000 caracteres).' });
            const r = await withAssignmentLock(async () => {
                if (!await reviewStillSeen(id, (req.body || {}).seen)) return { stale: true };
                return db.run(
                    `UPDATE ${T.locations} SET lodging_status = 'draft', lodging_note = ?, lodging_reviewed_at = CURRENT_TIMESTAMP, lodging_reviewed_by = ? WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'submitted'`,
                    [note, reviewerOf(req), id]);
            });
            if (r && r.stale) return res.status(409).json({ error: LODGING_CHANGED, code: 'lodging_changed' });
            if (!r || !r.changes) return res.status(409).json({ error: 'El hospedaje no está enviado a validación.' });
            res.json({ success: true, lodging_status: 'draft' });
        } catch (e) { sendError(res, e); }
    });
    // Reopen a validated arrangement (keeps it and the review stamps; the coordinator may edit again).
    http.route('post', '/locations/:id/lodging/reopen', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const loc = id ? await db.get(`SELECT id FROM ${T.locations} WHERE id = ?`, [id]) : null;
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const r = await withAssignmentLock(() => db.run(
                `UPDATE ${T.locations} SET lodging_status = 'draft' WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'validated'`, [id]));
            if (!r || !r.changes) return res.status(409).json({ error: 'El hospedaje no está validado.' });
            res.json({ success: true, lodging_status: 'draft' });
        } catch (e) { sendError(res, e); }
    });

    // === HOTELS & ROOMS (full CRUD) ===
    // `location` (2.23.0): what the admin pasted for the hotel's position — a Google Maps / OpenStreetMap link or
    // coordinates (server/geo.js). Absent = unchanged; '' = no position. → { value: 'lat,lng' | null } | { error }.
    function geoOfBody(location) {
        if (location === undefined || location === null || String(location).trim() === '') return { value: null };
        const g = parseGeo(location);
        return g.ok ? { value: g.geo } : { error: GEO_MESSAGES[g.code] || GEO_MESSAGES.no_coords };
    }
    http.route('post', '/hotels', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { conference_id, name, address, description, capacity, location } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        if (!String(name || '').trim()) return res.status(400).json({ error: 'El nombre del hotel es obligatorio.' });
        const geo = geoOfBody(location);
        if (geo.error) return res.status(400).json({ error: geo.error, code: 'geo' });
        try {
            const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const r = await db.run(`INSERT INTO ${T.hotels} (conference_id, name, address, description, capacity, geo) VALUES (?, ?, ?, ?, ?, ?)`,
                [conference_id, String(name).trim(), address || null, description || null, Number(capacity) || 0, geo.value || null]);
            res.json({ success: true, id: r.lastID });
        } catch (e) { sendError(res, e); }
    });
    http.route('put', '/hotels/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { name, address, description, capacity, location } = req.body;
        const geo = geoOfBody(location);
        if (geo.error) return res.status(400).json({ error: geo.error, code: 'geo' });
        try {
            const sets = [], params = [];
            if (location !== undefined) { sets.push('geo = ?'); params.push(geo.value || null); }
            if (name !== undefined) {
                if (!String(name).trim()) return res.status(400).json({ error: 'El nombre del hotel es obligatorio.' });
                sets.push('name = ?'); params.push(String(name).trim());
            }
            if (address !== undefined) { sets.push('address = ?'); params.push(address || null); }
            if (description !== undefined) { sets.push('description = ?'); params.push(description || null); }
            if (capacity !== undefined) { sets.push('capacity = ?'); params.push(Number(capacity) || 0); }
            if (!sets.length) return res.json({ success: true });
            params.push(req.params.id);
            await db.run(`UPDATE ${T.hotels} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/hotels/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            if (!id) return res.status(404).json({ error: 'Hotel no encontrado.' });
            // Under the assignment lock (an engine run's load→flush window, a status transition): rooms
            // allotted to a submitted / validated location go too — an administration adjustment of that
            // location (2.17.0; it used to be a 409 until the location was reopened). So is every location
            // whose attendees lose a bed here: an attendee the admin placed in a POOL room of this hotel is
            // part of their location's arrangement (`placed_elsewhere`) as much as one in an allotted room.
            const adjusted = await withAssignmentLock(async () => {
                const owners = await db.all(`SELECT DISTINCT location_id FROM ${T.rooms} WHERE hotel_id = ? AND location_id IS NOT NULL UNION SELECT DISTINCT location_id FROM ${T.roomBeds} WHERE room_id IN (SELECT id FROM ${T.rooms} WHERE hotel_id = ?)`, [id, id]);
                const sleepers = await db.all(`SELECT DISTINCT location_id FROM ${T.inscriptions} WHERE room_id IN (SELECT id FROM ${T.rooms} WHERE hotel_id = ?) AND location_id IS NOT NULL`, [id]);
                // Free any attendees assigned to this hotel's rooms before the FK cascade drops the rooms,
                // so occupancy counts stay honest.
                await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE room_id IN (SELECT id FROM ${T.rooms} WHERE hotel_id = ?)`, [id]);
                await db.run(`DELETE FROM ${T.roomBeds} WHERE room_id IN (SELECT id FROM ${T.rooms} WHERE hotel_id = ?)`, [id]);
                const r = await db.run(`DELETE FROM ${T.hotels} WHERE id = ?`, [id]);
                return r && r.changes ? stampAdminAdjustment(req, [...owners, ...sleepers].map(o => o.location_id)) : [];
            });
            res.json({ success: true, lodging_adjusted: adjusted });
        } catch (e) { sendError(res, e); }
    });

    // Allot every room of a hotel (or only `room_ids`) to a location — `location_id` null = back to the
    // pool. All-or-nothing: the occupant check runs first, then ONE UPDATE. A submitted / validated
    // location on either side (the target, or a location whose rooms change hands) is no longer a 409:
    // the change goes through and is stamped on it as an administration adjustment (2.17.0).
    http.route('post', '/hotels/:id/allot', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { location_id, room_ids } = req.body || {};
        try {
            const hotelId = positiveInt(req.params.id);
            const hotel = hotelId ? await db.get(`SELECT id, conference_id FROM ${T.hotels} WHERE id = ?`, [hotelId]) : null;
            if (!hotel) return res.status(404).json({ error: 'Hotel no encontrado.' });
            let target = null;
            if (location_id !== undefined && location_id !== null && location_id !== '') {
                const lid = positiveInt(location_id);
                target = lid ? await db.get(`SELECT id, name, lodging_status FROM ${T.locations} WHERE id = ? AND conference_id = ?`, [lid, hotel.conference_id]) : null;
                if (!target) return res.status(400).json({ error: 'Localidad no encontrada en esta conferencia.' });
            }
            let roomIds = null;
            if (room_ids !== undefined && room_ids !== null) {
                if (!Array.isArray(room_ids) || room_ids.length === 0 || room_ids.length > 1000) return res.status(400).json({ error: 'Habitación inválida.' });
                roomIds = [...new Set(room_ids.map(positiveInt))];
                if (roomIds.some(x => !x)) return res.status(400).json({ error: 'Habitación inválida.' });
                const owned = await db.get(`SELECT COUNT(*) AS c FROM ${T.rooms} WHERE hotel_id = ? AND id IN (${roomIds.map(() => '?').join(', ')})`, [hotelId, ...roomIds]);
                if (Number(owned && owned.c) !== roomIds.length) return res.status(400).json({ error: 'Habitación inválida.' });
            }
            const inSql = roomIds ? ` AND r.id IN (${roomIds.map(() => '?').join(', ')})` : '';
            const inParams = roomIds || [];
            // The checks and the UPDATE run under the assignment lock: an engine run loads occupancy
            // into memory and flushes at the end, so an allotment landing in between would let it place
            // a non-delegated attendee into a room that is no longer a pool room.
            const outcome = await withAssignmentLock(async () => {
                // Occupants: an allotted room may only hold the target location's attendees.
                if (target) {
                    const bad = await db.all(
                        `SELECT DISTINCT r.room_number FROM ${T.inscriptions} i JOIN ${T.rooms} r ON i.room_id = r.id WHERE r.hotel_id = ?${inSql} AND (i.location_id IS NULL OR i.location_id != ?) ORDER BY r.room_number`,
                        [hotelId, ...inParams, target.id]);
                    if (bad.length) return { bad };
                }
                // The rooms that actually change hands, and whose they were: an allotment that changes
                // nothing is no adjustment of anybody's arrangement.
                // A shared room (2.18.0) changes hands as well: it becomes a whole room (or a pool room) and
                // its sharers lose their beds there.
                const hasShare = `EXISTS (SELECT 1 FROM ${T.roomBeds} b WHERE b.room_id = r.id)`;
                const moving = await db.all(
                    `SELECT r.id, r.location_id FROM ${T.rooms} r WHERE r.hotel_id = ?${inSql} AND ${target ? `(r.location_id IS NULL OR r.location_id != ? OR ${hasShare})` : `(r.location_id IS NOT NULL OR ${hasShare})`}`,
                    [hotelId, ...inParams, ...(target ? [target.id] : [])]);
                const movingShares = await sharesByRoom(moving.map(m => m.id));
                const r = await db.run(`UPDATE ${T.rooms} SET location_id = ?, share_lock = NULL, allot_source = ? WHERE hotel_id = ?${roomIds ? ` AND id IN (${roomIds.map(() => '?').join(', ')})` : ''}`, [target ? target.id : null, target ? 'manual' : null, hotelId, ...inParams]);
                if (movingShares.size) {
                    const ids = [...movingShares.keys()];
                    await db.run(`DELETE FROM ${T.roomBeds} WHERE room_id IN (${ids.map(() => '?').join(', ')})`, ids);
                }
                const sharers = [...movingShares.values()].flat().map(x => x.location_id);
                const touched = moving.length ? [...moving.map(m => m.location_id), ...sharers, ...(target ? [target.id] : [])] : [];
                return { changes: Number(r && r.changes) || 0, adjusted: await stampAdminAdjustment(req, touched) };
            });
            if (outcome.bad) {
                const names = outcome.bad.map(b => b.room_number).slice(0, 20).join(', ');
                return res.status(409).json({ error: `Hay ocupantes de otra localidad en ${outcome.bad.length === 1 ? 'la habitación' : 'las habitaciones'} ${names}; libéralas antes de asignarlas.`, rooms: outcome.bad.map(b => b.room_number) });
            }
            res.json({ success: true, rooms: outcome.changes, lodging_adjusted: outcome.adjusted });
        } catch (e) { sendError(res, e); }
    });

    // A room number as stored: trimmed, inner runs of spaces collapsed. Two numbers are the same room when
    // they match ignoring case («A1» = «a1» = « A1 »); a hotel holds each number once.
    const roomNumberOf = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
    const roomWithNumber = (hotelId, number, exceptId) => db.get(
        `SELECT id, room_number FROM ${T.rooms} WHERE hotel_id = ? AND LOWER(room_number) = LOWER(?)${exceptId ? ' AND id <> ?' : ''} ORDER BY id LIMIT 1`,
        exceptId ? [hotelId, number, exceptId] : [hotelId, number]);
    http.route('post', '/rooms', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { hotel_id, room_number, capacity, gender, is_family, family_name, notes } = req.body;
        if (!hotel_id) return res.status(400).json({ error: 'Missing hotel_id' });
        if (!String(room_number || '').trim()) return res.status(400).json({ error: 'El número de habitación es obligatorio.' });
        try {
            const hotel = await db.get(`SELECT id FROM ${T.hotels} WHERE id = ?`, [hotel_id]);
            if (!hotel) return res.status(404).json({ error: 'Hotel no encontrado.' });
            const number = roomNumberOf(room_number);
            // Check and insert under the lodging lock: two requests for the same number (a double tap, a
            // bulk run started twice) must not both pass the check.
            const outcome = await withAssignmentLock(async () => {
                const existing = await roomWithNumber(hotel.id, number);
                if (existing) return { existing };
                const r = await db.run(`INSERT INTO ${T.rooms} (hotel_id, room_number, capacity, gender, is_family, family_name, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [hotel.id, number, Math.max(1, Number(capacity) || 1), gender || 'Mixed', is_family ? 1 : 0, family_name || null, notes || null]);
                return { id: r.lastID };
            });
            if (outcome.existing) return res.status(409).json({ error: `Ya existe la habitación «${outcome.existing.room_number}» en este hotel.`, code: 'duplicate_room', id: outcome.existing.id, room_number: outcome.existing.room_number });
            res.json({ success: true, id: outcome.id });
        } catch (e) { sendError(res, e); }
    });
    // `location_id` (positive integer | null | '' → null) allots the room to a location of the room's
    // conference. Checks: capacity (never below the occupants), then occupants (an allotted room may only
    // hold the target location's attendees). A re-allotment or a capacity change of a room of a submitted
    // / validated location — or an allotment to one — is stamped on it as an administration adjustment
    // (2.17.0; it used to be a 409 until the location was reopened).
    http.route('put', '/rooms/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { room_number, capacity, gender, is_family, family_name, notes, location_id } = req.body;
        try {
            const id = positiveInt(req.params.id);
            const room = id ? await db.get(`SELECT r.*, h.conference_id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE r.id = ?`, [id]) : null;
            if (!room) return res.status(404).json({ error: 'Habitación no encontrada.' });
            const sets = [], params = [];
            if (room_number !== undefined) {
                const number = roomNumberOf(room_number);
                if (!number) return res.status(400).json({ error: 'El número de habitación es obligatorio.' });
                const clash = await roomWithNumber(room.hotel_id, number, room.id);
                if (clash) return res.status(409).json({ error: `Ya existe la habitación «${clash.room_number}» en este hotel.`, code: 'duplicate_room', id: clash.id, room_number: clash.room_number });
                sets.push('room_number = ?'); params.push(number);
            }
            // Resolve the target location first so every 400 precedes the occupant 409.
            let target;   // undefined = not in the body; null = back to the pool; row = allot
            if (location_id !== undefined) {
                if (location_id === null || location_id === '') target = null;
                else {
                    const lid = positiveInt(location_id);
                    target = lid ? await db.get(`SELECT id, name, lodging_status FROM ${T.locations} WHERE id = ? AND conference_id = ?`, [lid, room.conference_id]) : null;
                    if (!target) return res.status(400).json({ error: 'Localidad no encontrada en esta conferencia.' });
                }
            }
            let cap = null;
            if (capacity !== undefined) cap = Math.max(1, Number(capacity) || 1);
            if (gender !== undefined) { sets.push('gender = ?'); params.push(gender || 'Mixed'); }
            if (is_family !== undefined) { sets.push('is_family = ?'); params.push(is_family ? 1 : 0); }
            if (family_name !== undefined) { sets.push('family_name = ?'); params.push(family_name || null); }
            if (notes !== undefined) { sets.push('notes = ?'); params.push(notes || null); }
            // The occupant checks and the UPDATE are serialised with the engine (which loads occupancy
            // into memory, places people, then flushes): a re-allotment or a capacity change may not
            // interleave with a run's load→flush window.
            const adjusted = await withAssignmentLock(async () => {
                // Whose arrangement this changes is decided on the room as it is NOW (re-read under the lock):
                // a concurrent allotment of this room must not leave the stamp on its previous owner.
                const now = await db.get(`SELECT location_id, capacity FROM ${T.rooms} WHERE id = ?`, [id]);
                if (!now) throw httpError(404, 'Habitación no encontrada.');
                const ownerId = now.location_id == null ? null : Number(now.location_id);
                const locationChanges = target !== undefined && (target ? Number(target.id) : null) !== ownerId;
                const capacityChanges = cap !== null && cap !== Number(now.capacity);
                const nowShares = (await sharesByRoom([id])).get(id) || [];
                if (cap !== null) {
                    // Never shrink capacity below the people already placed in the room.
                    const occ = await db.get(`SELECT COUNT(*) as c FROM ${T.inscriptions} WHERE room_id = ?`, [id]);
                    if (cap < (occ?.c || 0)) throw httpError(400, `La capacidad no puede ser menor que los ${occ.c} ocupantes actuales.`);
                    // …nor below the beds given to locations in a shared room (2.18.0), whose pool beds must
                    // still hold the pool occupants.
                    if (nowShares.length && target === undefined) {
                        const given = nowShares.reduce((n, x) => n + x.beds, 0);
                        if (cap < given) throw httpError(400, `La capacidad no puede ser menor que las ${given} camas repartidas entre localidades; cambia antes el reparto.`);
                        const occupants = await db.all(`SELECT id, location_id FROM ${T.inscriptions} WHERE room_id = ?`, [id]);
                        if (poolUsedOf(nowShares, occupants) > cap - given) throw httpError(400, 'Con esa capacidad no caben los ocupantes que usan camas libres; libera alguna cama antes.');
                    }
                    sets.push('capacity = ?'); params.push(cap);
                }
                if (target !== undefined) {
                    if (target) {
                        const foreign = await db.get(`SELECT COUNT(*) AS c FROM ${T.inscriptions} WHERE room_id = ? AND (location_id IS NULL OR location_id != ?)`, [id, target.id]);
                        if (Number(foreign && foreign.c) > 0) throw httpError(409, 'La habitación tiene ocupantes de otra localidad; libérala antes de asignarla.');
                    }
                    sets.push('location_id = ?', 'allot_source = ?'); params.push(target ? target.id : null, target ? 'manual' : null);
                }
                if (!sets.length) return [];
                params.push(id);
                await db.run(`UPDATE ${T.rooms} SET ${sets.join(', ')} WHERE id = ?`, params);
                // A whole-room allotment (or a return to the pool) replaces any split of the room (2.18.0).
                const sharesGo = target !== undefined && nowShares.length > 0;
                if (sharesGo) {
                    await db.run(`DELETE FROM ${T.roomBeds} WHERE room_id = ?`, [id]);
                    await db.run(`UPDATE ${T.rooms} SET share_lock = NULL WHERE id = ?`, [id]);
                }
                // Whose arrangement this changed: the room's location (its beds moved or resized) and the
                // location it was allotted to. A rename, a gender or a note is no adjustment.
                const touched = [];
                if ((locationChanges || capacityChanges) && ownerId != null) touched.push(ownerId);
                if (locationChanges && target) touched.push(target.id);
                if (sharesGo || (capacityChanges && nowShares.length)) touched.push(...nowShares.map(x => x.location_id));
                return stampAdminAdjustment(req, touched);
            });
            res.json({ success: true, lodging_adjusted: adjusted });
        } catch (e) { sendError(res, e); }
    });
    // Split a room's beds between locations (2.18.0, «camas por localidad»): body { shares: [{ location_id,
    // beds }] }. No share (or every one at 0) makes it a pool room; ONE location with every bed makes it
    // that location's whole room, as POST /hotels/:id/allot does. Otherwise the room keeps location_id NULL,
    // each location gets its beds there and the rest of the capacity are pool beds. Refused (409) when the
    // room's occupants would not fit the new split: each location's beds first, then the pool beds for
    // everyone else. Stamped on every location whose beds in the room change (an administration adjustment
    // of a reviewed arrangement, 2.17.0).
    http.route('put', '/rooms/:id/beds', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const room = id ? await db.get(`SELECT r.id, r.capacity, h.conference_id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE r.id = ?`, [id]) : null;
            if (!room) return res.status(404).json({ error: 'Habitación no encontrada.' });
            const raw = req.body ? req.body.shares : undefined;
            if (!Array.isArray(raw) || raw.length > 50) return res.status(400).json({ error: 'Reparto de camas inválido.' });
            // `release_lock`: the admin frees the class the plan fixed (see «THE CLASS OF A SHARED ROOM»).
            const releaseLock = !!(req.body && req.body.release_lock === true);
            const wanted = new Map();
            for (const x of raw) {
                const lid = positiveInt(x && x.location_id);
                const beds = Number(x && x.beds);
                if (!lid || !Number.isInteger(beds) || beds < 0) return res.status(400).json({ error: 'Reparto de camas inválido.' });
                if (wanted.has(lid)) return res.status(400).json({ error: 'Una localidad aparece dos veces en el reparto.' });
                if (beds > 0) wanted.set(lid, beds);
            }
            if (wanted.size) {
                const ids = [...wanted.keys()];
                const found = await db.all(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [room.conference_id, ...ids]);
                if (found.length !== ids.length) return res.status(400).json({ error: 'Localidad no encontrada en esta conferencia.' });
            }
            const adjusted = await withAssignmentLock(async () => {
                const now = await db.get(`SELECT id, location_id, capacity, share_lock FROM ${T.rooms} WHERE id = ?`, [id]);
                if (!now) throw httpError(404, 'Habitación no encontrada.');
                // A location may have been deleted while this request waited for the lock.
                if (wanted.size) {
                    const ids = [...wanted.keys()];
                    const still = await db.all(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [room.conference_id, ...ids]);
                    if (still.length !== ids.length) throw httpError(400, 'Localidad no encontrada en esta conferencia.');
                }
                const cap = roomCapacityOf(now);
                const shares = [...wanted].map(([location_id, beds]) => ({ location_id, beds }));
                const given = shares.reduce((n, x) => n + x.beds, 0);
                if (given > cap) throw httpError(400, `El reparto suma ${given} camas y la habitación tiene ${cap}.`);
                const whole = shares.length === 1 && shares[0].beds === cap ? shares[0].location_id : null;
                const occupants = await db.all(`SELECT id, location_id FROM ${T.inscriptions} WHERE room_id = ?`, [id]);
                if (whole != null) {
                    if (occupants.some(o => o.location_id == null || Number(o.location_id) !== whole)) throw httpError(409, 'La habitación tiene ocupantes de otra localidad; libérala antes de dársela entera a una localidad.');
                } else if (poolUsedOf(shares, occupants) > poolBedsOf({ location_id: null, capacity: cap }, shares)) {
                    throw httpError(409, 'Con este reparto no caben los ocupantes actuales de la habitación; mueve a alguien antes.');
                }
                // Before → after, per location: whose beds in this room change.
                const beforeShares = (await sharesByRoom([id])).get(id) || [];
                const before = new Map(beforeShares.map(x => [x.location_id, x.beds]));
                if (now.location_id != null) before.set(Number(now.location_id), cap);
                const after = new Map(whole != null ? [[whole, cap]] : shares.map(x => [x.location_id, x.beds]));
                const touched = [...new Set([...before.keys(), ...after.keys()])].filter(lid => (before.get(lid) || 0) !== (after.get(lid) || 0));
                // The class goes with the share, or when the admin frees it.
                const keepLock = whole == null && shares.length > 0 && !releaseLock ? (now.share_lock || null) : null;
                if (!touched.length && (now.location_id == null) === (whole == null)) {
                    if ((now.share_lock || null) !== keepLock) await db.run(`UPDATE ${T.rooms} SET share_lock = ? WHERE id = ?`, [keepLock, id]);
                    return [];
                }
                const writes = [[`DELETE FROM ${T.roomBeds} WHERE room_id = ?`, [id]]];
                if (whole == null) for (const x of shares) writes.push([`INSERT INTO ${T.roomBeds} (room_id, location_id, beds, allot_source) VALUES (?, ?, ?, 'manual')`, [id, x.location_id, x.beds]]);
                writes.push([`UPDATE ${T.rooms} SET location_id = ?, share_lock = ?, allot_source = ? WHERE id = ?`, [whole, keepLock, whole == null ? null : 'manual', id]]);
                await runBatched(writes);
                return stampAdminAdjustment(req, touched);
            });
            res.json({ success: true, lodging_adjusted: adjusted });
        } catch (e) { sendError(res, e); }
    });

    // Block / unblock a room (2.21.0, see «HELD BY THE ADMINISTRATION»): body { blocked }.
    http.route('put', '/rooms/:id/block', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const blocked = !!(req.body && (req.body.blocked === true || req.body.blocked === 1 || req.body.blocked === '1'));
            const r = id ? await withAssignmentLock(() => db.run(`UPDATE ${T.rooms} SET blocked = ? WHERE id = ?`, [blocked ? 1 : 0, id])) : null;
            if (!r || !r.changes) return res.status(404).json({ error: 'Habitación no encontrada.' });
            res.json({ success: true, blocked });
        } catch (e) { sendError(res, e); }
    });
    // Fix / unfix a person in their room (2.21.0, see «HELD BY THE ADMINISTRATION»): body { pinned }. Only someone in a
    // room can be fixed; taking them out of it by hand lifts it.
    http.route('put', '/inscriptions/:id/pin', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const pinned = !!(req.body && (req.body.pinned === true || req.body.pinned === 1 || req.body.pinned === '1'));
            await withAssignmentLock(async () => {
                const ins = id ? await db.get(`SELECT id, room_id FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
                if (!ins) throw httpError(404, 'Inscripción no encontrada.');
                if (pinned && ins.room_id == null) throw httpError(400, 'Solo se puede fijar a alguien que ya tiene habitación.');
                // The room they are fixed in (see «HELD BY THE ADMINISTRATION»).
                await db.run(`UPDATE ${T.inscriptions} SET room_locked = ? WHERE id = ?`, [pinned ? ins.room_id : null, id]);
            });
            res.json({ success: true, pinned });
        } catch (e) { sendError(res, e); }
    });

    // Give a location N beds (2.18.0): body { beds, hotel_id? }. Takes FREE beds only — nobody already
    // placed moves: first pool rooms with no occupant, whole, in hotel and room order (each while it fits
    // in what is left); then the rest from rooms with free pool beds — a room this location already shares
    // first, then any other — as shares, which splits the last room. All-or-nothing: 409 with `available`
    // when the free beds are fewer than asked. Stamped on the location.
    http.route('post', '/locations/:id/beds', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const lid = positiveInt(req.params.id);
            const location = lid ? await db.get(`SELECT id, name, conference_id FROM ${T.locations} WHERE id = ?`, [lid]) : null;
            if (!location) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const want = Number(req.body && req.body.beds);
            if (!Number.isInteger(want) || want < 1 || want > 5000) return res.status(400).json({ error: 'Indica cuántas camas (un número entre 1 y 5000).' });
            let hotelId = null;
            if (req.body && req.body.hotel_id != null && req.body.hotel_id !== '') {
                hotelId = positiveInt(req.body.hotel_id);
                const hotel = hotelId ? await db.get(`SELECT id FROM ${T.hotels} WHERE id = ? AND conference_id = ?`, [hotelId, location.conference_id]) : null;
                if (!hotel) return res.status(400).json({ error: 'Hotel no encontrado en esta conferencia.' });
            }
            const outcome = await withAssignmentLock(async () => {
                // The location may have been deleted while this request waited for the lock.
                if (!await db.get(`SELECT id FROM ${T.locations} WHERE id = ?`, [location.id])) throw httpError(404, 'Localidad no encontrada.');
                const rows = await db.all(
                    `SELECT r.id, r.room_number, r.capacity, r.location_id, h.name AS hotel_name FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id
                     WHERE h.conference_id = ? AND r.location_id IS NULL AND COALESCE(r.blocked, 0) = 0${hotelId ? ' AND h.id = ?' : ''} ORDER BY h.name, h.id, r.id`,
                    hotelId ? [location.conference_id, hotelId] : [location.conference_id]);
                // Natural room order inside a hotel: «A2» before «A10».
                const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
                rows.sort((a, b) => (a.hotel_name === b.hotel_name ? collator.compare(String(a.room_number), String(b.room_number)) || a.id - b.id : 0));
                const shareMap = await sharesByRoom(rows.map(r => r.id));
                const occ = new Map();
                for (let i = 0; i < rows.length; i += 400) {
                    const chunk = rows.slice(i, i + 400).map(r => r.id);
                    if (!chunk.length) continue;
                    for (const o of await db.all(`SELECT id, room_id, location_id FROM ${T.inscriptions} WHERE room_id IN (${chunk.map(() => '?').join(', ')})`, chunk)) {
                        if (!occ.has(Number(o.room_id))) occ.set(Number(o.room_id), []);
                        occ.get(Number(o.room_id)).push(o);
                    }
                }
                const freePool = (r) => {
                    const shares = shareMap.get(Number(r.id)) || [];
                    const occupants = occ.get(Number(r.id)) || [];
                    return Math.max(0, Math.min(roomCapacityOf(r) - occupants.length, poolBedsOf(r, shares) - poolUsedOf(shares, occupants)));
                };
                let left = want;
                const wholeRooms = [];
                const shareAdds = new Map();   // room id -> beds to add for this location
                for (const r of rows) {
                    if (!left) break;
                    if ((shareMap.get(Number(r.id)) || []).length || (occ.get(Number(r.id)) || []).length) continue;
                    const cap = roomCapacityOf(r);
                    if (cap <= left) { wholeRooms.push(r); left -= cap; }
                }
                const takenWhole = new Set(wholeRooms.map(r => r.id));
                const partial = rows.filter(r => !takenWhole.has(r.id) && freePool(r) > 0);
                const mineFirst = (r) => ((shareMap.get(Number(r.id)) || []).some(x => x.location_id === Number(location.id)) ? 0 : 1);
                partial.sort((a, b) => mineFirst(a) - mineFirst(b));
                for (const r of partial) {
                    if (!left) break;
                    const take = Math.min(left, freePool(r));
                    shareAdds.set(r.id, take);
                    left -= take;
                }
                if (left > 0) return { available: want - left };
                const writes = [];
                for (const r of wholeRooms) writes.push([`UPDATE ${T.rooms} SET location_id = ?, allot_source = 'manual' WHERE id = ?`, [location.id, r.id]]);
                const shared = [];
                for (const [roomId, beds] of shareAdds) {
                    const r = rows.find(x => x.id === roomId);
                    const prev = shareBedsOf(shareMap.get(Number(roomId)) || [], location.id);
                    // The location's people the administration already put on pool beds there join its share:
                    // they are its beds now, not free beds given (`beds` are the free ones taken on top).
                    const own = (occ.get(Number(roomId)) || []).filter(o => o.location_id != null && Number(o.location_id) === Number(location.id)).length;
                    const absorbed = Math.max(0, own - prev);
                    const total = prev + absorbed + beds;
                    // A whole free room taken through this pass (no other share, every bed) becomes a whole room.
                    const others = (shareMap.get(Number(roomId)) || []).filter(x => x.location_id !== Number(location.id));
                    if (!others.length && total === roomCapacityOf(r) && !(occ.get(Number(roomId)) || []).some(o => o.location_id == null || Number(o.location_id) !== Number(location.id))) {
                        writes.push([`DELETE FROM ${T.roomBeds} WHERE room_id = ?`, [roomId]]);
                        writes.push([`UPDATE ${T.rooms} SET location_id = ?, share_lock = NULL, allot_source = 'manual' WHERE id = ?`, [location.id, roomId]]);
                        wholeRooms.push(r);
                        continue;
                    }
                    if (prev) writes.push([`UPDATE ${T.roomBeds} SET beds = ?, allot_source = 'manual' WHERE room_id = ? AND location_id = ?`, [total, roomId, location.id]]);
                    else writes.push([`INSERT INTO ${T.roomBeds} (room_id, location_id, beds, allot_source) VALUES (?, ?, ?, 'manual')`, [roomId, location.id, total]]);
                    shared.push({ room_id: roomId, room_number: r.room_number, hotel_name: r.hotel_name, beds: total, added: beds });
                }
                await runBatched(writes);
                return {
                    whole: wholeRooms.map(r => ({ room_id: r.id, room_number: r.room_number, hotel_name: r.hotel_name, beds: roomCapacityOf(r) })),
                    shared,
                    adjusted: await stampAdminAdjustment(req, [location.id]),
                };
            });
            if (outcome.available !== undefined) {
                const where = hotelId ? ' en ese hotel' : '';
                const free = outcome.available === 0 ? `No quedan camas libres${where}`
                    : outcome.available === 1 ? `Solo queda 1 cama libre${where}` : `Solo quedan ${outcome.available} camas libres${where}`;
                return res.status(409).json({ error: `${free}; pediste ${want}.`, code: 'not_enough_beds', available: outcome.available });
            }
            res.json({ success: true, beds: want, whole_rooms: outcome.whole, shared_rooms: outcome.shared, lodging_adjusted: outcome.adjusted });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/rooms/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            if (!id) return res.status(404).json({ error: 'Habitación no encontrada.' });
            // A room of a submitted / validated location goes too: an administration adjustment (2.17.0) of
            // the location it is allotted to, and of every location whose attendees sleep in it — a POOL room
            // holding an attendee of a reviewed arrangement (`placed_elsewhere`) changes that arrangement too.
            const adjusted = await withAssignmentLock(async () => {
                const room = await db.get(`SELECT id, location_id FROM ${T.rooms} WHERE id = ?`, [id]);
                const sleepers = await db.all(`SELECT DISTINCT location_id FROM ${T.inscriptions} WHERE room_id = ? AND location_id IS NOT NULL`, [id]);
                const sharers = (await sharesByRoom([id])).get(id) || [];
                await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE room_id = ?`, [id]);
                await db.run(`DELETE FROM ${T.roomBeds} WHERE room_id = ?`, [id]);
                const r = await db.run(`DELETE FROM ${T.rooms} WHERE id = ?`, [id]);
                if (!room || !r || !r.changes) return [];
                return stampAdminAdjustment(req, [room.location_id, ...sharers.map(x => x.location_id), ...sleepers.map(s => s.location_id)]);
            });
            res.json({ success: true, lodging_adjusted: adjusted });
        } catch (e) { sendError(res, e); }
    });

    // === TRANSPORT (2.11.0) ===
    // Sold apart from the participation fee: a ticket stores the bus price at sale time and is paid by its
    // own transport payments (cash / transfer, recorded by the admin). Capacity never drops below the
    // tickets sold; a cancelled attendee cannot get a new ticket; a ticket (or a bus) with payments cannot
    // be removed until those payments are — money is never deleted as a side effect. Every check here that
    // a transport payment could invalidate (the price a ticket owes, whether a ticket has payments) runs
    // with the write it decides under the assignment lock, the lock payments are recorded under.
    const BUS_MAX_PASSENGERS_PER_CALL = 500;
    const busSelect = `SELECT b.*, (SELECT COUNT(*) FROM ${T.tickets} t WHERE t.bus_id = b.id) AS sold,`
        + ` (SELECT COALESCE(SUM(t.price), 0) FROM ${T.tickets} t WHERE t.bus_id = b.id) AS revenue,`
        + ` (SELECT COALESCE(SUM(t.amount_paid), 0) FROM ${T.tickets} t WHERE t.bus_id = b.id) AS collected FROM ${T.buses} b`;
    // amount_paid = SUM of the ticket's payments; status over the ticket price (half-cent tolerance).
    async function recomputeTickets(where, params) {
        await db.run(`UPDATE ${T.tickets}
            SET amount_paid = (SELECT COALESCE(SUM(amount), 0) FROM ${T.transportPayments} WHERE ticket_id = ${T.tickets}.id),
                payment_status = CASE
                    WHEN price <= 0 THEN 'paid'
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.transportPayments} WHERE ticket_id = ${T.tickets}.id) + 0.005 >= price THEN 'paid'
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.transportPayments} WHERE ticket_id = ${T.tickets}.id) > 0 THEN 'partial'
                    ELSE 'unpaid' END
            WHERE ${where}`, params);
    }
    function parseBusBody(body, partial) {
        const out = {};
        const text = (v, max) => (v === undefined ? undefined : (v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max)));
        if (!partial || body.name !== undefined) {
            const name = String(body.name == null ? '' : body.name).trim();
            if (!name) throw httpError(400, 'El nombre del bus es obligatorio.');
            out.name = name.slice(0, 120);
        }
        for (const k of ['origin', 'destination']) { const v = text(body[k], 160); if (v !== undefined) out[k] = v; }
        if (body.notes !== undefined) out.notes = text(body.notes, 1000);
        if (body.departure !== undefined) out.departure = normDate(body.departure, 'salida');
        if (!partial || body.capacity !== undefined) {
            const cap = positiveInt(body.capacity);
            if (!cap || cap > 10000) throw httpError(400, 'La capacidad del bus debe ser un número entero mayor que cero.');
            out.capacity = cap;
        }
        if (!partial || body.price !== undefined) {
            const n = Number(body.price == null || body.price === '' ? 0 : body.price);
            if (!Number.isFinite(n) || n < 0) throw httpError(400, 'El precio del transporte no puede ser negativo.');
            assertMoneyRange(n, 'El precio del transporte');
            out.price = roundMoney(n);
        }
        return out;
    }
    const busRow = (b) => ({ ...b, sold: Number(b.sold) || 0, price: roundMoney(Number(b.price) || 0), revenue: roundMoney(Number(b.revenue) || 0), collected: roundMoney(Number(b.collected) || 0) });
    const ticketRow = (t) => ({ ...t, price: roundMoney(Number(t.price) || 0), amount_paid: roundMoney(Number(t.amount_paid) || 0), payment_status: t.payment_status || 'unpaid' });

    // Buses of a conference with their tickets (passengers) — names are joined by the admin page.
    http.route('get', '/buses', { auth: true }, async (req, res) => {
        if (!await allowAny(req, res, [['transport', 'view'], ['reports', 'view']])) return;
        const cid = positiveInt(req.query.conference_id);
        if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const buses = (await db.all(`${busSelect} WHERE b.conference_id = ? ORDER BY b.departure, b.name`, [cid])).map(busRow);
            const tickets = await db.all(
                `SELECT t.* FROM ${T.tickets} t JOIN ${T.buses} b ON t.bus_id = b.id WHERE b.conference_id = ? ORDER BY t.id`, [cid]);
            // 2.26.0: a seat is part of a package sale — the money, the status and the package's name come from it.
            const sales = await packages.salesBySeat(cid);
            const byBus = new Map();
            for (const t of tickets) {
                const sale = sales.get(Number(t.id));
                const row = sale ? { ...ticketRow(t), sale_id: sale.id, package_id: sale.package_id, package_name: sale.package_name, price: sale.price, amount_paid: sale.amount_paid, payment_status: sale.payment_status } : ticketRow(t);
                if (!byBus.has(t.bus_id)) byBus.set(t.bus_id, []);
                byBus.get(t.bus_id).push(row);
            }
            // 2.27.0: the boarding state and how many passengers have the bus notices on (their phones).
            const alerts = await push.busSummaries(cid);
            for (const b of buses) {
                b.passengers = byBus.get(b.id) || [];
                Object.assign(b, push.busState(b));
                b.alerts = alerts.get(Number(b.id)) || 0;
                delete b.boarding_status; delete b.boarding_s; delete b.departed_s;
            }
            res.json(buses);
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/buses', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        try {
            const cid = positiveInt(req.body && req.body.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const v = parseBusBody(req.body || {}, false);
            const keys = Object.keys(v);
            const r = await db.run(`INSERT INTO ${T.buses} (conference_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [cid, ...keys.map(k => v[k])]);
            res.json({ success: true, id: r.lastID });
        } catch (e) { sendError(res, e); }
    });

    // Edit a bus. A new price applies to tickets sold from now on; `reprice_tickets: true` also moves every
    // ticket already sold to it (their payment status is recomputed).
    http.route('put', '/buses/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            // The sold-seats check and the write run under the assignment lock, the lock ticket sales
            // (POST /buses/:id/passengers) check the seats left under: a sale landing between this
            // check and the write otherwise left more tickets sold than the capacity just set.
            // 2.26.0: what is sold is a package (its own price): a bus price prices nothing sold, so it is never
            // pushed onto the seats (`reprice_tickets` is ignored).
            const outcome = await withAssignmentLock(async () => {
                const bus = id ? await db.get(`${busSelect} WHERE b.id = ?`, [id]) : null;
                if (!bus) throw httpError(404, 'Bus no encontrado.');
                const v = parseBusBody(req.body || {}, true);
                if (v.capacity !== undefined && v.capacity < (Number(bus.sold) || 0)) {
                    return { status: 409, body: { error: `La capacidad no puede ser menor que los ${bus.sold} pasajes vendidos.`, sold: Number(bus.sold) } };
                }
                const keys = Object.keys(v);
                if (keys.length) await db.run(`UPDATE ${T.buses} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => v[k]), id]);
                return {};
            });
            if (outcome.status) return res.status(outcome.status).json(outcome.body);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/buses/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            // The no-payments check and the deletes run under the assignment lock, the lock payments
            // are recorded under: a payment landing between them was answered as recorded and then
            // erased with the ticket (the foreign key cascades; without one it pointed at nothing).
            const outcome = await withAssignmentLock(async () => {
                const bus = id ? await db.get(`SELECT id FROM ${T.buses} WHERE id = ?`, [id]) : null;
                if (!bus) return { status: 404, body: { error: 'Bus no encontrado.' } };
                const paid = await db.get(`SELECT COUNT(*) AS n FROM ${T.transportPayments} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE bus_id = ? )`, [id]);
                if (Number(paid && paid.n) > 0) return { status: 409, body: { error: 'El bus tiene pasajes con pagos registrados; elimina esos pagos antes de borrar el bus.' } };
                // 2.26.0: seats sold in a package keep the bus (the package would lose a trip it was paid for).
                const inSales = await db.get(`SELECT COUNT(*) AS n FROM ${T.tickets} WHERE bus_id = ? AND sale_id IS NOT NULL`, [id]);
                if (Number(inSales && inSales.n) > 0) return { status: 409, body: { error: `El bus está en paquetes ya vendidos (${inSales.n} puesto(s)); quita esas ventas antes de borrarlo.` } };
                const released = await db.run(`DELETE FROM ${T.tickets} WHERE bus_id = ?`, [id]);
                await db.run(`DELETE FROM ${T.packageBuses} WHERE bus_id = ?`, [id]);
                await db.run(`DELETE FROM ${T.buses} WHERE id = ?`, [id]);
                return { released: (released && released.changes) || 0 };
            });
            if (outcome.status) return res.status(outcome.status).json(outcome.body);
            res.json({ success: true, released: outcome.released });
        } catch (e) { sendError(res, e); }
    });

    // Sell tickets: { inscription_ids: [...] }. Same conference only, never a cancelled attendee, never
    // twice on the same bus, never beyond the seats left (all-or-nothing). Serialised with the assignment
    // lock so two admins cannot both sell the last seat.
    http.route('post', '/buses/:id/passengers', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        // 2.26.0: only packages are sold (a one-bus trip is a one-bus package).
        return res.status(410).json({ error: 'Ahora se venden paquetes de buses: vende el paquete en «Paquetes».', code: 'packages' });
    });

    http.route('delete', '/buses/:id/passengers/:inscriptionId', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        try {
            const id = positiveInt(req.params.id), iid = positiveInt(req.params.inscriptionId);
            // Same as the bus delete: the no-payments check and the delete under the payments' lock.
            const outcome = await withAssignmentLock(async () => {
                const ticket = id && iid ? await db.get(`SELECT id, sale_id FROM ${T.tickets} WHERE bus_id = ? AND inscription_id = ?`, [id, iid]) : null;
                if (!ticket) return { status: 404, body: { error: 'Pasaje no encontrado.' } };
                if (ticket.sale_id != null) return { status: 409, body: { error: 'Este puesto es parte de un paquete: quita el paquete a la persona en «Paquetes».', code: 'package' } };
                const paid = await db.get(`SELECT COUNT(*) AS n FROM ${T.transportPayments} WHERE ticket_id = ?`, [ticket.id]);
                if (Number(paid && paid.n) > 0) return { status: 409, body: { error: 'El pasaje tiene pagos registrados; elimínalos antes de quitar al pasajero.' } };
                await db.run(`DELETE FROM ${T.tickets} WHERE id = ?`, [ticket.id]);
                return {};
            });
            if (outcome.status) return res.status(outcome.status).json(outcome.body);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // Boarding check (2.25.0): POST /transport/check { bus_id, code } — does the person whose badge was scanned
    // (the code, the «Mi inscripción» link of the QR, or a typed code: findByScanCode) travel on THIS bus?
    // Read only, never records anything. → { result, person?, ticket?, buses? }:
    //   ok        — a ticket on this bus (with its payment state, shown as information only);
    //   other_bus — tickets on other buses of the same conference (named, so the person can be sent there);
    //   no_ticket — registered, no ticket on any bus;  cancelled — the inscription is cancelled;
    //   unknown   — no registration of this conference has that code.
    http.route('post', '/transport/check', { auth: true }, async (req, res) => {
        const perms = await allowAny(req, res, [['transport', 'view'], ['transport', 'manage']]);
        if (!perms) return;
        try {
            const body = req.body || {};
            const busId = positiveInt(body.bus_id);
            const bus = busId ? await db.get(`SELECT id, conference_id, name FROM ${T.buses} WHERE id = ?`, [busId]) : null;
            if (!bus) return res.status(404).json({ error: 'Bus no encontrado.' });
            const row = await findByScanCode(body.code);
            if (!row || Number(row.conference_id) !== Number(bus.conference_id)) return res.json({ result: 'unknown', bus: { id: bus.id, name: bus.name } });
            const p = await personWithName(row);
            // The registration code only with inscriptions:view, as on every other surface (the scanner shows the name).
            const person = { id: p.id, name: p.name, location: p.location, reg_code: canSeeRegCodes(perms) ? p.reg_code : null };
            if (row.status === 'cancelled') return res.json({ result: 'cancelled', bus: { id: bus.id, name: bus.name }, person });
            const tickets = await db.all(
                `SELECT t.id, t.bus_id, COALESCE(s.price, t.price) AS price, COALESCE(s.amount_paid, t.amount_paid) AS amount_paid, COALESCE(s.payment_status, t.payment_status) AS payment_status, b.name AS bus_name, p.name AS package_name`
                + ` FROM ${T.tickets} t JOIN ${T.buses} b ON b.id = t.bus_id LEFT JOIN ${T.packageSales} s ON s.id = t.sale_id LEFT JOIN ${T.packages} p ON p.id = s.package_id`
                + ` WHERE t.inscription_id = ? AND b.conference_id = ? ORDER BY b.departure, b.name`, [row.id, bus.conference_id]);
            const mine = tickets.find(t => Number(t.bus_id) === Number(bus.id));
            if (mine) {
                const price = roundMoney(Number(mine.price) || 0), paid = roundMoney(Number(mine.amount_paid) || 0);
                return res.json({ result: 'ok', bus: { id: bus.id, name: bus.name }, person,
                    ticket: { payment_status: mine.payment_status || 'unpaid', price, amount_paid: paid, balance: roundMoney(Math.max(0, price - paid)), package_name: mine.package_name || null } });
            }
            if (tickets.length) return res.json({ result: 'other_bus', bus: { id: bus.id, name: bus.name }, person, buses: tickets.map(t => ({ id: t.bus_id, name: t.bus_name })) });
            res.json({ result: 'no_ticket', bus: { id: bus.id, name: bus.name }, person });
        } catch (e) { sendError(res, e); }
    });

    // Transport payments (admin): { amount, method (Efectivo | Transferencia), reference?, date? }.
    // Never more than what the ticket still owes.
    http.route('get', '/tickets/:id/payments', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'view')) return;
        try {
            const id = positiveInt(req.params.id);
            if (!id) return res.status(404).json({ error: 'Pasaje no encontrado.' });
            const list = await db.all(`SELECT * FROM ${T.transportPayments} WHERE ticket_id = ? ORDER BY date DESC, id DESC`, [id]);
            res.json(list.map(x => ({ ...x, amount: roundMoney(Number(x.amount) || 0) })));
        } catch (e) { sendError(res, e); }
    });
    http.route('post', '/tickets/:id/payments', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        // 2.26.0: payments belong to the package sale (POST /transport/package-sales/:id/payments).
        return res.status(410).json({ error: 'Los pagos ahora se registran al paquete.', code: 'packages' });
    });
    http.route('delete', '/transport-payments/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const pay = id ? await db.get(`SELECT id, ticket_id FROM ${T.transportPayments} WHERE id = ?`, [id]) : null;
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            await db.run(`DELETE FROM ${T.transportPayments} WHERE id = ?`, [id]);
            await recomputeTickets('id = ?', [pay.ticket_id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === ACCOUNTING (2.12.0) ===
    // Manual entries (income / expense) are written here; validated inscription payments and transport
    // payments are read live as income lines with `source` 'inscription' / 'transport' and `readonly: true`
    // (they are managed where they belong — the inscription's payments, the ticket's payments).
    const LEDGER_KINDS = new Set(['income', 'expense']);
    const LEDGER_DEFAULT_CATEGORIES = { income: ['Inscripciones', 'Transporte', 'Donaciones', 'Patrocinios', 'Ventas', 'Otros ingresos'], expense: ['Hospedaje', 'Transporte', 'Alimentación', 'Logística', 'Materiales', 'Publicidad', 'Honorarios', 'Otros gastos'] };
    function parseLedgerBody(body, partial) {
        const out = {};
        if (!partial || body.kind !== undefined) {
            if (!LEDGER_KINDS.has(body.kind)) throw httpError(400, 'El tipo debe ser ingreso o egreso.');
            out.kind = body.kind;
        }
        if (!partial || body.amount !== undefined) {
            const n = Number(body.amount);
            if (!Number.isFinite(n) || n <= 0) throw httpError(400, 'El monto debe ser mayor que cero.');
            assertMoneyRange(n, 'El monto');
            out.amount = roundMoney(n);
            if (out.amount <= 0) throw httpError(400, 'El monto debe ser mayor que cero.');
        }
        if (!partial || body.date !== undefined) {
            const d = normDate(body.date, 'fecha');
            if (!d) throw httpError(400, 'La fecha es obligatoria.');
            out.date = d;
        }
        if (!partial || body.description !== undefined) {
            const v = String(body.description == null ? '' : body.description).trim();
            if (!v) throw httpError(400, 'La descripción es obligatoria.');
            out.description = v.slice(0, 300);
        }
        if (!partial || body.category !== undefined) {
            const v = String(body.category == null ? '' : body.category).trim();
            out.category = v ? v.slice(0, 60) : null;
        }
        if (body.method !== undefined) out.method = body.method === null || body.method === '' ? null : assertPaymentMethod(body.method);
        if (body.reference !== undefined) out.reference = shortText(body.reference, 100);
        return out;
    }
    const ledgerRow = (r) => ({ ...r, amount: roundMoney(Number(r.amount) || 0), source: 'manual', readonly: false });

    // Every movement of a conference: manual entries + validated fee payments + transport payments, newest
    // first, plus the totals. Filtering (dates, kind, category, source) is the client's job — the whole
    // ledger of one conference is small enough to send at once.
    http.route('get', '/accounting', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'accounting', 'view')) return;
        const cid = positiveInt(req.query.conference_id);
        if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const manual = (await db.all(`SELECT * FROM ${T.ledger} WHERE conference_id = ? ORDER BY date DESC, id DESC`, [cid])).map(ledgerRow);
            // Fee income (2.18.0, D-P15 / D-P14): ONE line per validated payment — «Pago de cuotas · 3 personas»
            // with its `allocations` (or «Pago de inscripción» and `inscription_id` for one person) — dated by
            // the payment date the recorder typed. Its amount is the sum of the live parts.
            const feeLines = await fees.ledgerFeeLines(cid);
            const rides = await db.all(
                `SELECT tp.id, tp.amount, tp.method, tp.reference, tp.date, t.inscription_id, b.name AS bus_name, i.location_id`
                + ` FROM ${T.transportPayments} tp JOIN ${T.tickets} t ON tp.ticket_id = t.id JOIN ${T.buses} b ON t.bus_id = b.id`
                + ` LEFT JOIN ${T.inscriptions} i ON i.id = t.inscription_id WHERE b.conference_id = ?`, [cid]);
            // 2.26.0: transport income = the package sales' payments.
            const packageRides = await db.all(
                `SELECT pp.id, pp.amount, pp.method, pp.reference, pp.date, s.inscription_id, p.name AS package_name, i.location_id`
                + ` FROM ${T.packagePayments} pp JOIN ${T.packageSales} s ON pp.sale_id = s.id JOIN ${T.packages} p ON s.package_id = p.id`
                + ` LEFT JOIN ${T.inscriptions} i ON i.id = s.inscription_id WHERE p.conference_id = ?`, [cid]);
            const auto = [
                ...feeLines,
                ...packageRides.map(r => ({ id: `transport-pkg-${r.id}`, kind: 'income', date: r.date, category: 'Transporte', description: `Paquete de transporte — ${r.package_name}`, amount: roundMoney(Number(r.amount) || 0), method: r.method || null, reference: r.reference || null, inscription_id: r.inscription_id, location_id: r.location_id == null ? null : r.location_id, source: 'transport', readonly: true })),
                ...rides.map(r => ({ id: `transport-${r.id}`, kind: 'income', date: r.date, category: 'Transporte', description: `Pasaje — ${r.bus_name}`, amount: roundMoney(Number(r.amount) || 0), method: r.method || null, reference: r.reference || null, inscription_id: r.inscription_id, location_id: r.location_id == null ? null : r.location_id, source: 'transport', readonly: true })),
            ];
            const entries = [...manual, ...auto].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id)));
            const cents = { income: 0, expense: 0 };
            for (const e of entries) cents[e.kind] += toCents(e.amount);
            const used = { income: new Set(LEDGER_DEFAULT_CATEGORIES.income), expense: new Set(LEDGER_DEFAULT_CATEGORIES.expense) };
            for (const e of manual) if (e.category) used[e.kind].add(e.category);
            res.json({
                entries,
                totals: { income: fromCents(cents.income), expense: fromCents(cents.expense), balance: fromCents(cents.income - cents.expense) },
                categories: { income: [...used.income], expense: [...used.expense] },
            });
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/accounting/entries', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'accounting', 'manage')) return;
        try {
            const cid = positiveInt(req.body && req.body.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const v = { ...parseLedgerBody(req.body || {}, false), recorded_by: reviewerOf(req) };
            const keys = Object.keys(v);
            const r = await db.run(`INSERT INTO ${T.ledger} (conference_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [cid, ...keys.map(k => v[k])]);
            res.json({ success: true, id: r.lastID });
        } catch (e) { sendError(res, e); }
    });

    http.route('put', '/accounting/entries/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'accounting', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const row = id ? await db.get(`SELECT id FROM ${T.ledger} WHERE id = ?`, [id]) : null;
            if (!row) return res.status(404).json({ error: 'Movimiento no encontrado.' });
            const v = parseLedgerBody(req.body || {}, true);
            const keys = Object.keys(v);
            if (keys.length) await db.run(`UPDATE ${T.ledger} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => v[k]), id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/accounting/entries/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'accounting', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const r = id ? await db.run(`DELETE FROM ${T.ledger} WHERE id = ?`, [id]) : null;
            if (!r || !r.changes) return res.status(404).json({ error: 'Movimiento no encontrado.' });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === MEALS (2.14.0) ===
    // A service is one meal (desayuno | almuerzo | cena) on one day. Entitlement of attendee I to service S
    // is computed HERE, never on the client:
    //   I is not cancelled AND (override(I,S) = include OR (override(I,S) != exclude AND S is in the plan
    //   of I's location)).
    // An attendee without a location only gets explicit includes. Deliveries are unique per (service,
    // attendee) by index; POST /meals/deliver always answers 200 with a verdict so the kitchen scanner never
    // handles HTTP errors for a normal outcome. Every id is checked against the conference it belongs to.
    // { auth: true } + the in-handler gate of each route (meals:* / meals_delivery:manage, see allow()).
    const MEAL_ROUTE = { auth: true };
    const MEALS = ['desayuno', 'almuerzo', 'cena'];
    const MEAL_SET = new Set(MEALS);
    const OVERRIDE_MODES = new Set(['include', 'exclude']);
    const MEAL_MAX_BULK_DATES = 60;
    const MEAL_MAX_IDS = 1000;
    const MEAL_PEOPLE_MAX = 100;
    const mealRank = (m) => { const i = MEALS.indexOf(m); return i === -1 ? MEALS.length : i; };
    const sortServices = (list) => list.sort((a, b) => String(a.service_date).localeCompare(String(b.service_date)) || mealRank(a.meal) - mealRank(b.meal) || Number(a.id) - Number(b.id));
    // A real calendar day written YYYY-MM-DD (2026-02-30 is refused), or null.
    const parseDay = (v) => {
        if (typeof v !== 'string') return null;
        const s = v.trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (!m) return null;
        const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : null;
    };
    // HH:MM (H:MM and HH:MM:SS from a time input are accepted and normalized). undefined = absent, '' → null.
    const parseTime = (v, label) => {
        if (v === undefined) return undefined;
        if (v === null || String(v).trim() === '') return null;
        const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(v).trim());
        if (!m) throw httpError(400, `Hora inválida (${label}); usa HH:MM.`);
        return `${m[1].padStart(2, '0')}:${m[2]}`;
    };
    const parseMeal = (v) => {
        const m = typeof v === 'string' ? v.trim().toLowerCase() : '';
        if (!MEAL_SET.has(m)) throw httpError(400, 'Comida inválida (desayuno, almuerzo o cena).');
        return m;
    };
    const mealText = (v, max) => (v === undefined ? undefined : (v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max)));
    // Body → the editable columns of a service (date/meal only when creating).
    function parseServiceBody(body, partial) {
        const out = {};
        if (!partial) {
            const day = parseDay(body.service_date);
            if (!day) throw httpError(400, 'Fecha del servicio inválida (usa AAAA-MM-DD).');
            out.service_date = day;
            out.meal = parseMeal(body.meal);
        }
        const label = mealText(body.label, 120); if (label !== undefined) out.label = label;
        const notes = mealText(body.notes, 1000); if (notes !== undefined) out.notes = notes;
        const start = parseTime(body.start_time, 'inicio'); if (start !== undefined) out.start_time = start;
        const end = parseTime(body.end_time, 'fin'); if (end !== undefined) out.end_time = end;
        return out;
    }
    const assertWindow = (start, end) => {
        if (start && end && end <= start) throw httpError(400, 'La hora de fin del servicio debe ser posterior a la de inicio.');
    };
    // A list of positive integer ids from a body value (deduplicated). Throws 400.
    const parseIdList = (raw, what) => {
        if (!Array.isArray(raw)) throw httpError(400, `${what} debe ser una lista.`);
        if (raw.length > MEAL_MAX_IDS) throw httpError(400, `Máximo ${MEAL_MAX_IDS} elementos en ${what}.`);
        const ids = [...new Set(raw.map(positiveInt))];
        if (ids.some(n => !n)) throw httpError(400, `Identificadores inválidos en ${what}.`);
        return ids;
    };
    const placeholders = (list) => list.map(() => '?').join(', ');
    const serviceRow = (s) => ({ id: s.id, conference_id: s.conference_id, service_date: s.service_date, meal: s.meal, label: s.label || null, start_time: s.start_time || null, end_time: s.end_time || null, notes: s.notes || null });
    async function loadServices(cid) {
        return sortServices(await db.all(`SELECT * FROM ${T.mealServices} WHERE conference_id = ?`, [cid]));
    }
    const getService = async (id) => { const sid = positiveInt(id); return sid ? db.get(`SELECT * FROM ${T.mealServices} WHERE id = ?`, [sid]) : null; };
    // The conference's location plan as rows + a "locationId:serviceId" set.
    async function loadPlan(cid) {
        const rows = await db.all(
            `SELECT p.location_id, p.service_id FROM ${T.mealPlan} p JOIN ${T.mealServices} s ON p.service_id = s.id JOIN ${T.locations} l ON p.location_id = l.id`
            + ` WHERE s.conference_id = ? AND l.conference_id = ? ORDER BY p.location_id, p.service_id`, [cid, cid]);
        const set = new Set(rows.map(r => `${r.location_id}:${r.service_id}`));
        return { rows: rows.map(r => ({ location_id: r.location_id, service_id: r.service_id })), set };
    }
    // Ids of these locations, all in conference `cid` (undefined/null = every location of it). Throws 400.
    async function resolvePlanLocations(cid, raw) {
        if (raw === undefined || raw === null) return (await db.all(`SELECT id FROM ${T.locations} WHERE conference_id = ? ORDER BY id`, [cid])).map(r => r.id);
        const ids = parseIdList(raw, 'location_ids');
        if (!ids.length) return ids;
        const rows = await db.all(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND id IN (${placeholders(ids)})`, [cid, ...ids]);
        if (rows.length !== ids.length) throw httpError(400, 'Alguna localidad no pertenece a esta conferencia.');
        return ids;
    }
    // Ids of these services, all in conference `cid`. Throws 400.
    async function resolveServiceIds(cid, raw, what, foreignMessage) {
        const ids = parseIdList(raw, what);
        if (!ids.length) return ids;
        const rows = await db.all(`SELECT id FROM ${T.mealServices} WHERE conference_id = ? AND id IN (${placeholders(ids)})`, [cid, ...ids]);
        if (rows.length !== ids.length) throw httpError(400, foreignMessage || 'Algún servicio de comida no pertenece a esta conferencia.');
        return ids;
    }
    const isCancelled = (status) => status === 'cancelled';
    // THE entitlement rule (see the section note). `mode` = the override row's mode or null; `planned` =
    // the service is in the plan of the attendee's location.
    function entitlementFrom(status, mode, planned) {
        const source = mode === 'include' ? 'include' : mode === 'exclude' ? 'exclude' : planned ? 'location' : 'none';
        return { entitled: !isCancelled(status) && (source === 'include' || source === 'location'), source };
    }
    // 2.16.0 — every form field is optional, so a conference may have no Nombre / Apellido. An attendee with
    // neither is named (and found by the kitchen's search) by the first two filled values of the conference's
    // OTHER form fields, in form order — the fallback the admin lists use (client lib/fields.ts
    // isNameFallbackField) — and only then by their number. Only fields that are fit to stand in for a NAME:
    // never a unique identifier (an ID document), a contact (email, phone) or free text (notes) — the meals
    // screens show this name to a kitchen role that may not read the roster at all.
    const NAME_FALLBACK_COLUMNS = 4;
    const NAME_UNFIT_ROLES = new Set(['email', 'phone']);
    const NAME_UNFIT_TYPES = new Set(['textarea', 'notes', 'email', 'tel']);
    const isNameFallbackField = (f) => !!f && isFieldColumn(f.name) && f.name !== 'first_name' && f.name !== 'last_name'
        && !Number(f.is_unique) && !NAME_UNFIT_ROLES.has(String(f.role || '')) && !NAME_UNFIT_TYPES.has(String(f.type || ''))
        && !NAME_UNFIT_ROLES.has(f.name);
    async function nameFallbackColumns(conferenceId) {
        const rows = await db.all(`SELECT name, type, role, is_unique FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [conferenceId]);
        return rows.filter(isNameFallbackField).map(r => r.name).slice(0, NAME_FALLBACK_COLUMNS);
    }
    // `, i.col1, i.col2` for a SELECT (the columns are isFieldColumn-validated field names).
    const nameColumnsSql = (cols) => (cols || []).map(c => `, i.${c}`).join('');
    const fallbackName = (r, cols) => {
        const parts = [];
        for (const c of cols || []) {
            const v = r ? r[c] : null;
            if (v != null && String(v).trim() !== '') parts.push(String(v).trim());
            if (parts.length === 2) break;
        }
        return parts.join(' ');
    };
    const personName = (r, cols) => `${r.first_name || ''} ${r.last_name || ''}`.trim() || fallbackName(r, cols) || `#${r.id}`;
    // The meals views show the LIVE location of location_id (what the plan and every per-location counter
    // use), never the stored text label alone: DELETE /locations/:id nulls location_id but keeps the label
    // for history, and showing it would put an attendee under a location that no longer feeds them.
    // Every attendee query of this section selects `l.name AS location_name` through this join.
    const LOCATION_JOIN = ` LEFT JOIN ${T.locations} l ON l.id = i.location_id`;
    const PERSON_SQL = `SELECT i.id, i.conference_id, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.status, i.reg_code, l.name AS location_name FROM ${T.inscriptions} i${LOCATION_JOIN}`;
    const liveLocation = (r) => (r.location_id == null ? null : (r.location_name || r.location || null));
    const personOf = (r, cols) => ({ id: r.id, name: personName(r, cols), location: liveLocation(r), location_id: r.location_id == null ? null : r.location_id, family_group: r.family_group || null, reg_code: r.reg_code || null });
    // One attendee row of PERSON_SQL → personOf, reading its name fallback columns when it has no name.
    async function personWithName(r) {
        if (`${r.first_name || ''}${r.last_name || ''}`.trim()) return personOf(r);
        const cols = await nameFallbackColumns(r.conference_id);
        const extra = cols.length ? await db.get(`SELECT ${cols.join(', ')} FROM ${T.inscriptions} WHERE id = ?`, [r.id]) : null;
        return personOf({ ...(extra || {}), ...r }, cols);
    }
    const deliveryFields = (d) => ({ delivery_id: d.id, delivered_at: d.delivered_at, delivered_by: d.delivered_by || null, method: d.method || null, note: d.note || null });
    const deliveryOf = (serviceId, inscriptionId) => db.get(`SELECT * FROM ${T.mealDeliveries} WHERE service_id = ? AND inscription_id = ?`, [serviceId, inscriptionId]);
    // Who delivered: actorOf (team section) — the acting user's login, administrator or team member.
    // UTC 'YYYY-MM-DD HH:MM:SS' — the same form SQLite's CURRENT_TIMESTAMP stores (the admin UI parses it as
    // UTC), written explicitly so MySQL (whose CURRENT_TIMESTAMP is session-local) stores the same instant.
    const utcStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Scanner input → registration code: trim, uppercase, drop every character outside the code alphabet
    // (scanners add prefixes / suffixes / CR-LF; people type dashes and lowercase). The client mirrors this.
    const NOT_IN_CODE_ALPHABET = new RegExp(`[^${REG_CODE_ALPHABET}]`, 'g');
    const normalizeScanCode = (raw) => String(raw == null ? '' : raw).trim().toUpperCase().replace(NOT_IN_CODE_ALPHABET, '');
    // The attendee a scan names (any conference — the caller decides), or null. Longer than a code after
    // normalization (a scanner prefix made of alphabet letters, e.g. the "C" an AIM "]C0" id leaves): the
    // unique 10-character window that is a real code wins; none or several = unknown.
    async function findByScanCode(raw) {
        const text = String(raw == null ? '' : raw);
        if (text.length > 256) return null;
        // The badge's «Mi inscripción» link (2.23.0): the code is the `c=` of its fragment (or query).
        const linked = /[#?&]c=([A-Za-z0-9]{10})(?=$|[&#\s])/.exec(text.trim());
        if (linked) return (await db.get(`${PERSON_SQL} WHERE i.reg_code = ?`, [linked[1].toUpperCase()])) || null;
        const code = normalizeScanCode(text);
        if (code.length < REG_CODE_LEN || code.length > 64) return null;
        if (code.length === REG_CODE_LEN) return (await db.get(`${PERSON_SQL} WHERE i.reg_code = ?`, [code])) || null;
        const windows = [];
        for (let k = 0; k + REG_CODE_LEN <= code.length; k++) { const w = code.slice(k, k + REG_CODE_LEN); if (!windows.includes(w)) windows.push(w); }
        const rows = await db.all(`${PERSON_SQL} WHERE i.reg_code IN (${placeholders(windows)})`, windows);
        return rows.length === 1 ? rows[0] : null;
    }
    // Entitlement of one attendee row to one service id.
    async function entitlementOf(ins, serviceId) {
        const ov = await db.get(`SELECT mode FROM ${T.mealOverrides} WHERE inscription_id = ? AND service_id = ?`, [ins.id, serviceId]);
        const planned = ins.location_id != null
            && !!(await db.get(`SELECT id FROM ${T.mealPlan} WHERE location_id = ? AND service_id = ?`, [ins.location_id, serviceId]));
        return entitlementFrom(ins.status, ov ? ov.mode : null, planned);
    }

    // Plan / override writes run under withMealsLock (defined with the assignment lock; single child
    // process, so an in-memory chain is the whole view).
    // Insert plan rows (pairs not already planned). Caller holds the meals lock.
    async function insertPlanRows(pairs) {
        if (!pairs.length) return;
        await runBatched(pairs.map(([locationId, serviceId]) => [`INSERT INTO ${T.mealPlan} (location_id, service_id) VALUES (?, ?)`, [locationId, serviceId]]));
    }
    // DELETE … WHERE <col> = ? AND <other> IN (…), chunked so no statement binds too many parameters.
    async function deleteIn(table, col, value, otherCol, ids) {
        for (let k = 0; k < ids.length; k += 500) {
            const chunk = ids.slice(k, k + 500);
            await db.run(`DELETE FROM ${table} WHERE ${col} = ? AND ${otherCol} IN (${placeholders(chunk)})`, [value, ...chunk]);
        }
    }
    // DELETE … WHERE <col> IN (…), chunked.
    async function deleteWhereIn(table, col, ids) {
        for (let k = 0; k < ids.length; k += 500) {
            const chunk = ids.slice(k, k + 500);
            await db.run(`DELETE FROM ${table} WHERE ${col} IN (${placeholders(chunk)})`, chunk);
        }
    }
    // Every meal row of a conference (DELETE /:id, under the meals lock; the FKs would cascade anyway).
    // PARENT FIRST: with no transactions, a delivery a scan inserts while this runs either lands before the
    // services are gone (and the sweep below removes it) or after (and the scan's own re-check removes it)
    // — deleting the children first would leave a window where a new child outlives its parent.
    async function deleteMealsOfConference(conferenceId) {
        const ids = (await db.all(`SELECT id FROM ${T.mealServices} WHERE conference_id = ?`, [conferenceId])).map(r => Number(r.id));
        await db.run(`DELETE FROM ${T.mealServices} WHERE conference_id = ?`, [conferenceId]);
        await deleteWhereIn(T.mealDeliveries, 'service_id', ids);
        await deleteWhereIn(T.mealOverrides, 'service_id', ids);
        await deleteWhereIn(T.mealPlan, 'service_id', ids);
    }
    // Insert one service and plan it for `locIds` (caller holds the meals lock). Returns the new id, or
    // null when the unique (conference, day, meal) index refused it because it exists. No transactions: if
    // its plan cannot be written the service is removed again, so it never stays without its plan — a
    // retry skips existing services untouched, so it would never repair one.
    async function createServiceWithPlan(cid, v, locIds) {
        const keys = Object.keys(v);
        let r;
        try {
            r = await db.run(`INSERT INTO ${T.mealServices} (conference_id, ${keys.join(', ')}) VALUES (?, ${placeholders(keys)})`, [cid, ...keys.map(k => v[k])]);
        } catch (e) {
            if (await db.get(`SELECT id FROM ${T.mealServices} WHERE conference_id = ? AND service_date = ? AND meal = ?`, [cid, v.service_date, v.meal])) return null;
            throw e;
        }
        try {
            await insertPlanRows(locIds.map(lid => [lid, r.lastID]));
        } catch (e) {
            try {
                await db.run(`DELETE FROM ${T.mealServices} WHERE id = ?`, [r.lastID]);
                await db.run(`DELETE FROM ${T.mealPlan} WHERE service_id = ?`, [r.lastID]);
            } catch (e2) { /* the original error is the one to report; boot hygiene sweeps orphan plan rows */ }
            throw e;
        }
        return r.lastID;
    }

    // Per-service counters of a conference (all services, or the one `onlyServiceId`):
    //   entitled            attendees entitled right now
    //   delivered           deliveries recorded (whoever received them)
    //   pending             entitled attendees not served yet
    //   overrides_delivered deliveries to someone NOT entitled now («entregar de todas formas», or the
    //                       right was removed after serving) — so delivered = (entitled − pending) + this
    //   by_location         the same per location (every location of the conference, then the attendees
    //                       without a location as location_id null when they have any count)
    async function mealStats(cid, plan, locations, onlyServiceId) {
        const svcFilter = onlyServiceId ? ' AND s.id = ?' : '';
        const svcParams = onlyServiceId ? [onlyServiceId] : [];
        const services = await db.all(`SELECT s.id FROM ${T.mealServices} s WHERE s.conference_id = ?${svcFilter}`, [cid, ...svcParams]);
        const key = (v) => (v == null ? 'null' : String(v));
        const active = new Map();
        for (const r of await db.all(`SELECT location_id, COUNT(*) AS n FROM ${T.inscriptions} WHERE conference_id = ? AND ${occupiedSql()} GROUP BY location_id`, [cid])) active.set(key(r.location_id), Number(r.n) || 0);
        const ovCount = new Map(); // "serviceId|locKey|mode" → n (non-cancelled attendees only)
        const ovRows = await db.all(
            `SELECT o.service_id, i.location_id, o.mode, COUNT(*) AS n FROM ${T.mealOverrides} o JOIN ${T.inscriptions} i ON o.inscription_id = i.id JOIN ${T.mealServices} s ON o.service_id = s.id`
            + ` WHERE s.conference_id = ? AND i.conference_id = ? AND ${occupiedSql('i.status')}${svcFilter} GROUP BY o.service_id, i.location_id, o.mode`, [cid, cid, ...svcParams]);
        for (const r of ovRows) ovCount.set(`${r.service_id}|${key(r.location_id)}|${r.mode}`, Number(r.n) || 0);
        const deliveries = await db.all(
            `SELECT d.service_id, i.location_id, i.status, o.mode FROM ${T.mealDeliveries} d JOIN ${T.mealServices} s ON d.service_id = s.id JOIN ${T.inscriptions} i ON d.inscription_id = i.id`
            + ` LEFT JOIN ${T.mealOverrides} o ON o.inscription_id = d.inscription_id AND o.service_id = d.service_id WHERE s.conference_id = ?${svcFilter}`, [cid, ...svcParams]);
        const locKeys = new Set([...locations.map(l => key(l.id)), ...active.keys(), ...ovRows.map(r => key(r.location_id)), ...deliveries.map(d => key(d.location_id))]);
        const deliveriesBy = new Map();
        for (const d of deliveries) { const k = Number(d.service_id); if (!deliveriesBy.has(k)) deliveriesBy.set(k, []); deliveriesBy.get(k).push(d); }
        const known = new Set(locations.map(l => key(l.id)));
        const out = new Map();
        for (const s of services) {
            const per = new Map();
            for (const lk of locKeys) per.set(lk, { entitled: 0, delivered: 0, delivered_entitled: 0 });
            for (const lk of locKeys) {
                const planned = lk !== 'null' && plan.set.has(`${lk}:${s.id}`);
                const c = per.get(lk);
                c.entitled = planned
                    ? (active.get(lk) || 0) - (ovCount.get(`${s.id}|${lk}|exclude`) || 0)
                    : (ovCount.get(`${s.id}|${lk}|include`) || 0);
            }
            let overrides = 0;
            for (const d of deliveriesBy.get(Number(s.id)) || []) {
                const lk = key(d.location_id);
                const c = per.get(lk);
                c.delivered++;
                const planned = lk !== 'null' && plan.set.has(`${lk}:${s.id}`);
                if (entitlementFrom(d.status, d.mode, planned).entitled) c.delivered_entitled++;
                else overrides++;
            }
            const byLocation = [];
            const push = (lk) => {
                const c = per.get(lk);
                byLocation.push({ location_id: lk === 'null' ? null : Number(lk), entitled: c.entitled, delivered: c.delivered, pending: c.entitled - c.delivered_entitled });
            };
            for (const l of locations) push(key(l.id));
            for (const lk of locKeys) { const c = per.get(lk); if (!known.has(lk) && (c.entitled || c.delivered)) push(lk); }
            const tot = { entitled: 0, delivered: 0, pending: 0 };
            for (const b of byLocation) { tot.entitled += b.entitled; tot.delivered += b.delivered; tot.pending += b.pending; }
            out.set(s.id, { ...tot, overrides_delivered: overrides, by_location: byLocation });
        }
        return out;
    }
    const conferenceLocations = (cid) => db.all(`SELECT id, name FROM ${T.locations} WHERE conference_id = ? ORDER BY name, id`, [cid]);

    // Everything the «Alimentación» page needs at once: services (sorted by day, then desayuno → almuerzo
    // → cena) with their counters, the conference's locations, the plan matrix, and how many per-person
    // adjustments exist.
    http.route('get', '/meals', MEAL_ROUTE, async (req, res) => {
        if (!await allowAny(req, res, [['meals', 'view'], ['meals_delivery', 'manage']])) return;
        const cid = positiveInt(req.query.conference_id);
        if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const [services, locations, plan] = [await loadServices(cid), await conferenceLocations(cid), await loadPlan(cid)];
            const stats = await mealStats(cid, plan, locations, null);
            const ov = await db.get(`SELECT COUNT(*) AS n FROM ${T.mealOverrides} o JOIN ${T.mealServices} s ON o.service_id = s.id WHERE s.conference_id = ?`, [cid]);
            res.json({
                services: services.map(s => ({ ...serviceRow(s), ...(stats.get(s.id) || { entitled: 0, delivered: 0, pending: 0, overrides_delivered: 0, by_location: [] }) })),
                locations,
                plan: plan.rows,
                overrides_count: Number(ov && ov.n) || 0,
            });
        } catch (e) { sendError(res, e); }
    });

    // Create one service: { conference_id, service_date, meal, label?, start_time?, end_time?, notes?,
    // location_ids? } — location_ids are planned right away (omitted = every location of the conference).
    // The conference and the locations are (re-)read INSIDE the meals lock, where their deletion runs too.
    const conferenceExists = async (cid) => !!(await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid]));
    http.route('post', '/meals/services', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const body = req.body || {};
            const cid = positiveInt(body.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            if (!(await conferenceExists(cid))) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const v = parseServiceBody(body, false);
            assertWindow(v.start_time, v.end_time);
            const result = await withMealsLock(async () => {
                if (!(await conferenceExists(cid))) throw httpError(404, 'Conferencia no encontrada.');
                const locIds = await resolvePlanLocations(cid, body.location_ids);
                const dupSql = `SELECT id FROM ${T.mealServices} WHERE conference_id = ? AND service_date = ? AND meal = ?`;
                const dupErr = (row) => Object.assign(httpError(409, `Ya existe el servicio de ${v.meal} del ${v.service_date}.`), { id: row ? row.id : null });
                const dup = await db.get(dupSql, [cid, v.service_date, v.meal]);
                if (dup) throw dupErr(dup);
                const id = await createServiceWithPlan(cid, v, locIds);
                if (id == null) throw dupErr(await db.get(dupSql, [cid, v.service_date, v.meal]));
                return { id, planned: locIds.length };
            });
            res.json({ success: true, ...result });
        } catch (e) {
            if (e && e.status === 409 && e.id) return res.status(409).json({ error: e.message, id: e.id });
            sendError(res, e);
        }
    });

    // Create many: { conference_id, dates:[YYYY-MM-DD…] (≤ 60), meals:[…] (≤ 3), location_ids? } — every
    // missing (date, meal) is created and planned for location_ids (omitted = all); existing ones are
    // skipped untouched (their plan is not modified). Validation is all-or-nothing, before any write. Each
    // service is created together with its plan (createServiceWithPlan), so a failure part-way leaves only
    // complete services: the same request repeated skips them and creates the rest. That failure answers
    // 500 { error, created, skipped, ids } with what was already created.
    http.route('post', '/meals/services/bulk', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const body = req.body || {};
            const cid = positiveInt(body.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            if (!(await conferenceExists(cid))) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            if (!Array.isArray(body.dates) || !body.dates.length) return res.status(400).json({ error: 'Indica al menos una fecha.' });
            if (body.dates.length > MEAL_MAX_BULK_DATES * 4) return res.status(400).json({ error: `Máximo ${MEAL_MAX_BULK_DATES} fechas por operación.` });
            const dates = [];
            for (const raw of body.dates) {
                const d = parseDay(raw);
                if (!d) return res.status(400).json({ error: `Fecha inválida: «${String(raw).slice(0, 40)}» (usa AAAA-MM-DD).` });
                if (!dates.includes(d)) dates.push(d);
            }
            if (dates.length > MEAL_MAX_BULK_DATES) return res.status(400).json({ error: `Máximo ${MEAL_MAX_BULK_DATES} fechas por operación.` });
            if (!Array.isArray(body.meals) || !body.meals.length) return res.status(400).json({ error: 'Indica al menos una comida.' });
            if (body.meals.length > 12) return res.status(400).json({ error: 'Comida inválida (desayuno, almuerzo o cena).' });
            const chosen = new Set(body.meals.map(parseMeal));
            const meals = MEALS.filter(m => chosen.has(m));
            dates.sort();
            const result = await withMealsLock(async () => {
                if (!(await conferenceExists(cid))) throw httpError(404, 'Conferencia no encontrada.');
                const locIds = await resolvePlanLocations(cid, body.location_ids);
                const existing = new Set((await db.all(`SELECT service_date, meal FROM ${T.mealServices} WHERE conference_id = ?`, [cid])).map(r => `${r.service_date}|${r.meal}`));
                const ids = [];
                let skipped = 0;
                try {
                    for (const d of dates) {
                        for (const m of meals) {
                            if (existing.has(`${d}|${m}`)) { skipped++; continue; }
                            // null: created meanwhile outside this process's lock (the unique index refused it).
                            const id = await createServiceWithPlan(cid, { service_date: d, meal: m }, locIds);
                            if (id == null) skipped++; else ids.push(id);
                        }
                    }
                } catch (e) {
                    if (!ids.length) throw e;
                    throw Object.assign(httpError(500, `Se crearon ${ids.length} servicio(s) antes de un error; repite la operación para crear el resto (los ya creados se omiten). Detalle: ${e && e.message ? e.message : e}`),
                        { partial: { created: ids.length, skipped, ids } });
                }
                return { created: ids.length, skipped, ids };
            });
            res.json({ success: true, ...result });
        } catch (e) {
            if (e && e.partial) return res.status(500).json({ error: e.message, ...e.partial });
            sendError(res, e);
        }
    });

    // Edit a service's label / delivery window / notes. Its day and meal are its identity: to change them,
    // delete it and create another (400 when the body tries).
    http.route('put', '/meals/services/:id', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const body = req.body || {};
            const svc = await getService(req.params.id);
            if (!svc) return res.status(404).json({ error: 'Servicio de comida no encontrado.' });
            const changesDay = body.service_date !== undefined && String(body.service_date).trim() !== svc.service_date;
            const changesMeal = body.meal !== undefined && String(body.meal).trim().toLowerCase() !== svc.meal;
            if (changesDay || changesMeal) return res.status(400).json({ error: 'La fecha y la comida de un servicio no se pueden cambiar; elimínalo y créalo de nuevo.' });
            const v = parseServiceBody(body, true);
            assertWindow(v.start_time !== undefined ? v.start_time : svc.start_time, v.end_time !== undefined ? v.end_time : svc.end_time);
            const keys = Object.keys(v);
            if (keys.length) await db.run(`UPDATE ${T.mealServices} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => v[k]), svc.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // Delete a service with its plan, overrides and deliveries. With deliveries already recorded it answers
    // 409 { requiresConfirm: true, deliveries } unless ?force=1.
    // Deliveries are not serialised by the meals lock (scans never wait), so "has no delivery" and "delete
    // it" are ONE statement: a separate count followed by the delete would destroy a scan landing in
    // between without the confirmation. The service row goes FIRST and its children after it: from then
    // on a scan's INSERT fails on the foreign key, or (foreign keys off) the scan finds the service gone
    // when it re-checks and removes its own row — either way it answers 404, never «Entregado». With force,
    // deliveries are deleted (and counted) until the conditional delete passes, so deleted_deliveries counts
    // every delivery a scan reported before the service went.
    const MEAL_DELETE_ATTEMPTS = 5;
    http.route('delete', '/meals/services/:id', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const force = ['1', 'true'].includes(String(req.query.force || ''));
            const result = await withMealsLock(async () => {
                const svc = await getService(req.params.id);
                if (!svc) throw httpError(404, 'Servicio de comida no encontrado.');
                const deleteIfUnserved = `DELETE FROM ${T.mealServices} WHERE id = ? AND NOT EXISTS (SELECT 1 FROM ${T.mealDeliveries} d WHERE d.service_id = ? )`;
                let deleted = 0;
                for (let attempt = 1; ; attempt++) {
                    if (force) {
                        const d = await db.run(`DELETE FROM ${T.mealDeliveries} WHERE service_id = ?`, [svc.id]);
                        deleted += Number(d && d.changes) || 0;
                    }
                    const r = await db.run(deleteIfUnserved, [svc.id, svc.id]);
                    if (r && r.changes) break;
                    if (!(await getService(svc.id))) throw httpError(404, 'Servicio de comida no encontrado.');
                    if (!force) {
                        const n = Number(((await db.get(`SELECT COUNT(*) AS n FROM ${T.mealDeliveries} WHERE service_id = ?`, [svc.id])) || {}).n) || 0;
                        if (n > 0) return { blocked: n };
                        // 0: the delivery that blocked it was undone meanwhile — try again.
                    }
                    if (attempt >= MEAL_DELETE_ATTEMPTS) throw httpError(409, 'Se están registrando entregas en este servicio ahora mismo; inténtalo de nuevo.');
                }
                await db.run(`DELETE FROM ${T.mealOverrides} WHERE service_id = ?`, [svc.id]);
                await db.run(`DELETE FROM ${T.mealPlan} WHERE service_id = ?`, [svc.id]);
                await db.run(`DELETE FROM ${T.mealDeliveries} WHERE service_id = ?`, [svc.id]);
                return { deleted_deliveries: deleted };
            });
            if (result.blocked) return res.status(409).json({ error: `El servicio ya tiene ${result.blocked} entrega(s) registrada(s); confirma para eliminarlo con ellas.`, requiresConfirm: true, deliveries: result.blocked });
            res.json({ success: true, ...result });
        } catch (e) { sendError(res, e); }
    });

    // Replace ONE location's set of services (a row of the matrix): { conference_id, location_id,
    // service_ids:[…] } — only services of the location's conference. Parents are read inside the lock.
    http.route('put', '/meals/plan', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const body = req.body || {};
            const lid = positiveInt(body.location_id);
            const final = await withMealsLock(async () => {
                const loc = lid ? await db.get(`SELECT id, conference_id FROM ${T.locations} WHERE id = ?`, [lid]) : null;
                if (!loc) throw httpError(404, 'Localidad no encontrada.');
                if (body.conference_id !== undefined && body.conference_id !== null && positiveInt(body.conference_id) !== Number(loc.conference_id)) {
                    throw httpError(400, 'La localidad no pertenece a esta conferencia.');
                }
                const ids = await resolveServiceIds(loc.conference_id, body.service_ids, 'service_ids');
                const current = (await db.all(`SELECT service_id FROM ${T.mealPlan} WHERE location_id = ?`, [loc.id])).map(r => Number(r.service_id));
                const want = new Set(ids);
                await deleteIn(T.mealPlan, 'location_id', loc.id, 'service_id', current.filter(s => !want.has(s)));
                const have = new Set(current);
                await insertPlanRows(ids.filter(s => !have.has(s)).map(s => [loc.id, s]));
                return { location_id: loc.id, service_ids: [...want].sort((a, b) => a - b) };
            });
            res.json({ success: true, ...final });
        } catch (e) { sendError(res, e); }
    });

    // Replace ONE service's set of locations (a column of the matrix): { location_ids:[…] } — only
    // locations of the service's conference. Parents are read inside the lock.
    http.route('put', '/meals/services/:id/plan', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const raw = (req.body || {}).location_ids;
            const final = await withMealsLock(async () => {
                const svc = await getService(req.params.id);
                if (!svc) throw httpError(404, 'Servicio de comida no encontrado.');
                if (raw === undefined || raw === null) throw httpError(400, 'location_ids debe ser una lista.');
                const ids = await resolvePlanLocations(svc.conference_id, raw);
                const current = (await db.all(`SELECT location_id FROM ${T.mealPlan} WHERE service_id = ?`, [svc.id])).map(r => Number(r.location_id));
                const want = new Set(ids);
                await deleteIn(T.mealPlan, 'service_id', svc.id, 'location_id', current.filter(l => !want.has(l)));
                const have = new Set(current);
                await insertPlanRows(ids.filter(l => !have.has(l)).map(l => [l, svc.id]));
                return { service_id: svc.id, location_ids: [...want].sort((a, b) => a - b) };
            });
            res.json({ success: true, ...final });
        } catch (e) { sendError(res, e); }
    });

    // One cell of the matrix: { location_id, service_id, enabled: boolean } (idempotent). Parents are read
    // inside the lock.
    http.route('post', '/meals/plan/toggle', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const body = req.body || {};
            const on = body.enabled === true || body.enabled === 1 || body.enabled === 'true' || body.enabled === '1';
            const off = body.enabled === false || body.enabled === 0 || body.enabled === 'false' || body.enabled === '0';
            if (!on && !off) return res.status(400).json({ error: 'enabled debe ser verdadero o falso.' });
            const enabled = on;
            const lid = positiveInt(body.location_id);
            const done = await withMealsLock(async () => {
                const loc = lid ? await db.get(`SELECT id, conference_id FROM ${T.locations} WHERE id = ?`, [lid]) : null;
                if (!loc) throw httpError(404, 'Localidad no encontrada.');
                const svc = await getService(body.service_id);
                if (!svc) throw httpError(404, 'Servicio de comida no encontrado.');
                if (Number(svc.conference_id) !== Number(loc.conference_id)) throw httpError(400, 'La localidad y el servicio son de conferencias distintas.');
                if (!enabled) await db.run(`DELETE FROM ${T.mealPlan} WHERE location_id = ? AND service_id = ?`, [loc.id, svc.id]);
                else if (!(await db.get(`SELECT id FROM ${T.mealPlan} WHERE location_id = ? AND service_id = ?`, [loc.id, svc.id]))) await insertPlanRows([[loc.id, svc.id]]);
                return { location_id: loc.id, service_id: svc.id };
            });
            res.json({ success: true, ...done, enabled });
        } catch (e) { sendError(res, e); }
    });

    // «Por persona»: non-cancelled attendees of the conference matching `q` (every word must match the
    // name, document or registration code), optionally of one location (`location_id`, or 'none' for those
    // without one), paged (`limit` ≤ 100, `offset`), each with its entitlement summary.
    // The words are matched HERE, not with SQL LIKE: SQLite's LOWER()/LIKE fold only ASCII letters and no
    // engine ignores accents, so «ángela», «angela» and «ÁNGELA» must all find «Ángela» (and «nunez»
    // «Núñez»). A conference's non-cancelled attendees are a bounded set, read once with the columns needed.
    const foldText = (v) => String(v == null ? '' : v).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const foldCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    // A folded ID document without its separators ('12.345.678-9' → '123456789').
    const docKeyOf = (folded) => folded.replace(/[^\p{L}\p{N}]/gu, '');
    http.route('get', '/meals/people', MEAL_ROUTE, async (req, res) => {
        const perms = await allowAny(req, res, [['meals', 'view'], ['meals_delivery', 'manage']]);
        if (!perms) return;
        const cid = positiveInt(req.query.conference_id);
        if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MEAL_PEOPLE_MAX);
            const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
            let where = ` WHERE i.conference_id = ? AND ${occupiedSql('i.status')}`;
            const params = [cid];
            const rawLoc = req.query.location_id;
            if (rawLoc !== undefined && rawLoc !== '') {
                if (rawLoc === 'none') where += ' AND i.location_id IS NULL';
                else { const lid = positiveInt(rawLoc); if (lid) { where += ' AND i.location_id = ?'; params.push(lid); } else where += ' AND 1 = 0'; }
            }
            const words = String(req.query.q || '').trim().slice(0, 100).split(/\s+/).filter(Boolean).slice(0, 5);
            const docsOk = canSeeDocuments(perms);
            const matchers = words.map(w => {
                // A word that IS (part of) a code — only code letters, dashes allowed, 4+ of them — also
                // matches reg_code; a name or a stray symbol never turns into a broad code match.
                const code = normalizeScanCode(w);
                // Only for whoever may see codes or scans them (the kitchen types a code into the search).
                const codeOk = canSeeRegCodes(perms) || hasLevel(perms, 'meals_delivery', 'manage');
                return { text: foldText(w), docKey: docKeyOf(foldText(w)), code: codeOk && code.length >= 4 && code === w.toUpperCase().replace(/-/g, '') ? code : null };
            });
            // The ID document matches a part of it only for whoever may read it (inscriptions:view). Anyone
            // else — the kitchen, which looks people up by the document they show — finds a person by the
            // WHOLE document (dots, dashes and spaces aside), so the search cannot spell one out piece by piece.
            const docMatches = (doc, docKey, m) => (docsOk ? doc.includes(m.text) : docKey !== '' && docKey === m.docKey);
            const nameCols = await nameFallbackColumns(cid);
            const candidates = await db.all(
                `SELECT i.id, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.document_number, i.reg_code, i.status, l.name AS location_name${nameColumnsSql(nameCols)}`
                + ` FROM ${T.inscriptions} i${LOCATION_JOIN}${where}`, params);
            const hits = [];
            for (const r of candidates) {
                // No name fields: the fallback name is what is shown, searched and sorted by.
                const unnamed = !`${r.first_name || ''}${r.last_name || ''}`.trim();
                const first = unnamed ? foldText(fallbackName(r, nameCols)) : foldText(r.first_name), last = foldText(r.last_name), doc = foldText(r.document_number);
                const docKey = docKeyOf(doc);
                const reg = String(r.reg_code || '').toUpperCase();
                if (matchers.every(m => first.includes(m.text) || last.includes(m.text) || docMatches(doc, docKey, m) || (m.code !== null && reg.includes(m.code)))) hits.push({ r, first, last });
            }
            hits.sort((a, b) => foldCompare(a.last, b.last) || foldCompare(a.first, b.first) || Number(a.r.id) - Number(b.r.id));
            const total = hits.length;
            const rows = hits.slice(offset, offset + limit).map(h => h.r);
            const services = await db.all(`SELECT id FROM ${T.mealServices} WHERE conference_id = ?`, [cid]);
            const plan = await loadPlan(cid);
            const ids = rows.map(r => r.id);
            const ovBy = new Map(), delBy = new Map();
            if (ids.length) {
                for (const o of await db.all(`SELECT inscription_id, service_id, mode FROM ${T.mealOverrides} WHERE inscription_id IN (${placeholders(ids)})`, ids)) ovBy.set(`${o.inscription_id}:${o.service_id}`, o.mode);
                for (const d of await db.all(
                    `SELECT d.inscription_id, COUNT(*) AS n FROM ${T.mealDeliveries} d JOIN ${T.mealServices} s ON d.service_id = s.id`
                    + ` WHERE s.conference_id = ? AND d.inscription_id IN (${placeholders(ids)}) GROUP BY d.inscription_id`, [cid, ...ids])) delBy.set(String(d.inscription_id), Number(d.n) || 0);
            }
            const people = rows.map(r => {
                let entitled = 0, includes = 0, excludes = 0;
                for (const s of services) {
                    const mode = ovBy.get(`${r.id}:${s.id}`) || null;
                    if (mode === 'include') includes++;
                    if (mode === 'exclude') excludes++;
                    if (entitlementFrom(r.status, mode, r.location_id != null && plan.set.has(`${r.location_id}:${s.id}`)).entitled) entitled++;
                }
                return maskRegCode({ ...personOf(r, nameCols), first_name: r.first_name || '', last_name: r.last_name || '', document_number: docsOk ? r.document_number || null : null, status: r.status || null, entitled, delivered: delBy.get(String(r.id)) || 0, includes, excludes }, perms);
            });
            res.json({ people, total, limit, offset, services_count: services.length });
        } catch (e) { sendError(res, e); }
    });

    // One attendee's meals: every service of their conference with entitlement, its source, the override
    // (null = inherit) and the delivery if any.
    async function personMeals(ins) {
        const services = await loadServices(ins.conference_id);
        const ov = new Map((await db.all(`SELECT service_id, mode FROM ${T.mealOverrides} WHERE inscription_id = ?`, [ins.id])).map(o => [Number(o.service_id), o.mode]));
        const planned = new Set(ins.location_id == null ? [] : (await db.all(`SELECT service_id FROM ${T.mealPlan} WHERE location_id = ?`, [ins.location_id])).map(p => Number(p.service_id)));
        const del = new Map((await db.all(`SELECT * FROM ${T.mealDeliveries} WHERE inscription_id = ?`, [ins.id])).map(d => [Number(d.service_id), d]));
        return services.map(s => {
            const mode = ov.get(Number(s.id)) || null;
            const ent = entitlementFrom(ins.status, mode, planned.has(Number(s.id)));
            const d = del.get(Number(s.id));
            return {
                id: s.id, service_date: s.service_date, meal: s.meal, label: s.label || null, start_time: s.start_time || null, end_time: s.end_time || null,
                entitled: ent.entitled, source: ent.source, override: mode, planned: planned.has(Number(s.id)),
                delivered_at: d ? d.delivered_at : null, delivery_id: d ? d.id : null, method: d ? d.method || null : null, delivered_by: d ? d.delivered_by || null : null,
            };
        });
    }
    http.route('get', '/meals/inscriptions/:id', MEAL_ROUTE, async (req, res) => {
        const perms = await allow(req, res, 'meals', 'view');
        if (!perms) return;
        try {
            const id = positiveInt(req.params.id);
            const ins = id ? await db.get(`${PERSON_SQL} WHERE i.id = ?`, [id]) : null;
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            res.json({ person: maskRegCode({ ...(await personWithName(ins)), status: ins.status || null, conference_id: ins.conference_id }, perms), services: await personMeals(ins) });
        } catch (e) { sendError(res, e); }
    });

    // Set the per-person adjustment: { service_id (or service_ids:[…]), mode: 'include' | 'exclude' |
    // 'inherit' } — 'inherit' removes the row (back to what the location plan says). The attendee and the
    // services are read inside the meals lock, where their deletion runs too.
    http.route('put', '/meals/inscriptions/:id/overrides', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const body = req.body || {};
            const id = positiveInt(req.params.id);
            const { ins, ids, mode } = await withMealsLock(async () => {
                const ins = id ? await db.get(`${PERSON_SQL} WHERE i.id = ?`, [id]) : null;
                if (!ins) throw httpError(404, 'Inscripción no encontrada.');
                const mode = typeof body.mode === 'string' ? body.mode.trim() : '';
                if (!OVERRIDE_MODES.has(mode) && mode !== 'inherit') throw httpError(400, 'Modo inválido (include, exclude o inherit).');
                let raw;
                if (body.service_ids !== undefined) raw = body.service_ids;
                else if (body.service_id !== undefined && body.service_id !== null) raw = [body.service_id];
                else throw httpError(400, 'Indica el servicio de comida.');
                const ids = await resolveServiceIds(ins.conference_id, raw, 'service_ids', 'El servicio de comida no pertenece a la conferencia de esta inscripción.');
                if (!ids.length) throw httpError(400, 'Indica el servicio de comida.');
                if (mode === 'inherit') await deleteIn(T.mealOverrides, 'inscription_id', ins.id, 'service_id', ids);
                else {
                    for (const sid of ids) {
                        const up = await db.run(`UPDATE ${T.mealOverrides} SET mode = ? WHERE inscription_id = ? AND service_id = ?`, [mode, ins.id, sid]);
                        if (up && up.changes) continue;
                        try { await db.run(`INSERT INTO ${T.mealOverrides} (inscription_id, service_id, mode) VALUES (?, ?, ?)`, [ins.id, sid, mode]); }
                        catch (e) { await db.run(`UPDATE ${T.mealOverrides} SET mode = ? WHERE inscription_id = ? AND service_id = ?`, [mode, ins.id, sid]); }
                    }
                }
                return { ins, ids, mode };
            });
            const touched = new Set(ids);
            const services = (await personMeals(ins)).filter(s => touched.has(Number(s.id)))
                .map(s => ({ id: s.id, entitled: s.entitled, source: s.source, override: s.override }));
            res.json({ success: true, mode, services });
        } catch (e) { sendError(res, e); }
    });

    // ── What the delivery card shows (2.16.0) ────────────────────────────────────────────────────────
    // The confirmation card of the phone scanner and of «Entrega» shows the attendee's data the meals
    // manager chose for the conference, in the chosen order: built-ins (keys starting with '@', which no
    // column name can) and the registration form's own fields (by column name). Stored as a JSON array in
    // conferences.meal_display_fields; NULL (never configured) = MEAL_DISPLAY_DEFAULT. Always resolved
    // against the conference's CURRENT form: a stored key whose field was deleted is dropped, and when
    // nothing is left the default applies. The full name ('@name') is ALWAYS the first entry (the card's
    // heading: staff must see who they deliver to) — whatever is stored or sent. WHAT TRAVELS: person.fields
    // of /meals/check and /meals/deliver carries the values of these keys only, so form answers, the
    // payment status and the room reach the delivery device only when configured (the inscription row
    // itself never travels). Next to it, `person` keeps the 2.15 projection (name, location, family group,
    // masked code) — the same the delivery staff already get from the manual search (/meals/people), so
    // the setting chooses what the card SHOWS, it does not hide the name or the location from them.
    // '@reg_code' keeps the usual rule (only with inscriptions:view; otherwise its value is null and the
    // entry says `hidden: true`).
    const MEAL_DISPLAY_BUILTINS = [
        { key: '@name', label: 'Nombre completo' },
        { key: '@location', label: 'Localidad' },
        { key: '@reg_code', label: 'Código de inscripción' },
        { key: '@payment_status', label: 'Estado de pago' },
        { key: '@room', label: 'Habitación' },
    ];
    const MEAL_DISPLAY_DEFAULT = Object.freeze(['@name', '@location']);
    // The name first, once; the rest in their order.
    const withMealName = (keys) => ['@name', ...keys.filter(k => k !== '@name')];
    const MEAL_DISPLAY_MAX_KEYS = 200;      // body cap, before any validation
    const MEAL_DISPLAY_VALUE_MAX = 200;     // characters of one value on the card
    const parseDisplayKeys = (raw) => {
        if (raw == null || raw === '') return null;
        try { const v = JSON.parse(String(raw)); return Array.isArray(v) ? v : null; } catch { return null; }
    };
    // { available:[{ key, label, builtin, type? }], keys:[…effective, in order], configured } of a conference.
    async function mealDisplayOf(cid) {
        let stored = null;
        try {
            const row = await db.get(`SELECT meal_display_fields FROM ${T.conferences} WHERE id = ?`, [cid]);
            stored = row ? parseDisplayKeys(row.meal_display_fields) : null;
        } catch (e) { stored = null; /* the column is missing (a failed migration): the default */ }
        const formFields = await db.all(`SELECT name, label, type FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]);
        const available = [
            ...MEAL_DISPLAY_BUILTINS.map(b => ({ key: b.key, label: b.label, builtin: true })),
            ...formFields.filter(f => isFieldColumn(f.name)).map(f => ({ key: f.name, label: f.label || f.name, builtin: false, type: f.type || 'text' })),
        ];
        const known = new Set(available.map(f => f.key));
        const keys = [];
        for (const k of stored || []) if (typeof k === 'string' && known.has(k) && !keys.includes(k)) keys.push(k);
        return { available, keys: keys.length ? withMealName(keys) : [...MEAL_DISPLAY_DEFAULT], configured: stored !== null };
    }
    const displayText = (v) => {
        if (v == null) return null;
        const s = String(v).trim();
        return s ? s.slice(0, MEAL_DISPLAY_VALUE_MAX) : null;
    };
    // The configured entries of one attendee row (a PERSON_SQL row): [{ key, label, value, hidden? }].
    // Reads only the columns the configuration names.
    async function displayFieldsOf(ins, display, perms) {
        const labels = new Map(display.available.map(f => [f.key, f.label]));
        const cols = display.keys.filter(k => !k.startsWith('@') && isFieldColumn(k));
        const wantsRow = cols.length > 0 || display.keys.includes('@payment_status') || display.keys.includes('@room');
        let row = {};
        if (wantsRow) {
            const select = [...cols.map(c => `i.${c}`), 'i.payment_status', 'i.room_id'];
            try { row = (await db.get(`SELECT ${select.join(', ')} FROM ${T.inscriptions} i WHERE i.id = ?`, [ins.id])) || {}; }
            catch (e) {
                // A form field whose column is missing (a failed ADD COLUMN): the card shows it empty — a
                // display setting must never turn a scan into a 500.
                console.warn('[conference-manager] delivery card fields unreadable:', e && e.message);
                try { row = (await db.get(`SELECT i.* FROM ${T.inscriptions} i WHERE i.id = ?`, [ins.id])) || {}; } catch (e2) { row = {}; }
            }
        }
        let room = null;
        if (display.keys.includes('@room') && row.room_id != null) {
            room = await db.get(`SELECT r.room_number, h.name AS hotel_name FROM ${T.rooms} r LEFT JOIN ${T.hotels} h ON h.id = r.hotel_id WHERE r.id = ?`, [row.room_id]);
        }
        const showCodes = canSeeRegCodes(perms);
        const showDocuments = canSeeDocuments(perms);
        // The name follows the same rule as everywhere else (personWithName: the form's name fields, else its
        // name-fallback columns), so a form without first/last name still names the person on the card.
        const fullName = display.keys.includes('@name') ? (await personWithName(ins)).name : null;
        return display.keys.map((key) => {
            const label = labels.get(key) || key;
            switch (key) {
                case '@name': return { key, label, value: fullName };
                case '@location': return { key, label, value: liveLocation(ins) };
                case '@reg_code': return showCodes ? { key, label, value: ins.reg_code || null } : { key, label, value: null, hidden: true };
                case '@payment_status': return { key, label, value: displayText(row.payment_status) };
                case '@room': return { key, label, value: room ? displayText([room.hotel_name, room.room_number].filter(Boolean).join(' · ')) : null };
                // The ID document, like '@reg_code': only with inscriptions:view (maskDocument).
                case DOCUMENT_COLUMN: return showDocuments ? { key, label, value: displayText(row[key]) } : { key, label, value: null, hidden: true };
                default: return { key, label, value: displayText(row[key]) };
            }
        });
    }

    // Read endpoint for everyone who delivers or plans meals (the card and the configuration dialog).
    http.route('get', '/meals/display-fields', MEAL_ROUTE, async (req, res) => {
        if (!await allowAny(req, res, [['meals', 'view'], ['meals_delivery', 'manage']])) return;
        const cid = positiveInt(req.query.conference_id);
        if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            if (!(await conferenceExists(cid))) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const d = await mealDisplayOf(cid);
            res.json({ conference_id: cid, keys: d.keys, configured: d.configured, default_keys: [...MEAL_DISPLAY_DEFAULT], available: d.available });
        } catch (e) { sendError(res, e); }
    });

    // { conference_id, keys: [key…] (in display order) | null (back to the default) }. meals:manage — the
    // same level that decides who eats what: which personal data the kitchen sees on every scan is a
    // decision of whoever manages Alimentación, not of the delivery staff it is shown to. Every key must
    // be offered by GET (400 otherwise); duplicates collapse; at least one key; '@name' is stored first
    // (added when missing, moved up when elsewhere).
    http.route('put', '/meals/display-fields', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals', 'manage')) return;
        try {
            const body = req.body || {};
            const cid = positiveInt(body.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            if (!(await conferenceExists(cid))) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            let stored = null;
            if (body.keys !== null) {
                if (!Array.isArray(body.keys)) return res.status(400).json({ error: 'keys debe ser una lista.' });
                if (body.keys.length > MEAL_DISPLAY_MAX_KEYS) return res.status(400).json({ error: `Máximo ${MEAL_DISPLAY_MAX_KEYS} datos.` });
                const known = new Set((await mealDisplayOf(cid)).available.map(f => f.key));
                const keys = [];
                for (const k of body.keys) {
                    if (typeof k !== 'string' || !known.has(k)) return res.status(400).json({ error: `Dato desconocido para esta conferencia: «${String(k).slice(0, 40)}».` });
                    if (!keys.includes(k)) keys.push(k);
                }
                if (!keys.length) return res.status(400).json({ error: 'Elige al menos un dato para mostrar.' });
                stored = JSON.stringify(withMealName(keys));
            }
            await db.run(`UPDATE ${T.conferences} SET meal_display_fields = ? WHERE id = ?`, [stored, cid]);
            const d = await mealDisplayOf(cid);
            res.json({ success: true, conference_id: cid, keys: d.keys, configured: d.configured });
        } catch (e) { sendError(res, e); }
    });

    // ── The scan decision (2.16.0): ONE function for POST /meals/check and POST /meals/deliver ─────────
    // Same lookup, same order of checks, so the confirmation card can never promise what the delivery then
    // refuses (or the reverse). Never writes. Throws 400 when neither code nor inscription_id is sent;
    // `code` wins over inscription_id when both come.
    //   { result: 'unknown' | 'other_conference' }
    //   { result: 'already', ins, prior }        a delivery exists (whoever recorded it)
    //   { result: 'cancelled', ins }
    //   { result: 'ready' | 'not_entitled', ins, ent, viaCode }
    //   { result: 'group_not_called', ins, ent, viaCode, gate } (2.36.5) entitled, but this service is calling the
    //     groups and theirs has not been called: not served unless someone allows it (allow_group on /meals/deliver)
    async function decideMealScan(svc, body) {
        const hasCode = body.code !== undefined && body.code !== null;
        const hasId = body.inscription_id !== undefined && body.inscription_id !== null && body.inscription_id !== '';
        if (!hasCode && !hasId) throw httpError(400, 'Indica el código o la inscripción.');
        let ins = null;
        if (hasCode) ins = typeof body.code === 'string' || typeof body.code === 'number' ? await findByScanCode(body.code) : null;
        else { const iid = positiveInt(body.inscription_id); ins = iid ? ((await db.get(`${PERSON_SQL} WHERE i.id = ?`, [iid])) || null) : null; }
        if (!ins) return { result: 'unknown' };
        if (Number(ins.conference_id) !== Number(svc.conference_id)) return { result: 'other_conference' };
        const prior = await deliveryOf(svc.id, ins.id);
        if (prior) return { result: 'already', ins, prior };
        if (isCancelled(ins.status)) return { result: 'cancelled', ins };
        const ent = await entitlementOf(ins, svc.id);
        if (!ent.entitled) return { result: 'not_entitled', ins, ent, viaCode: hasCode };
        // The owner's rule (2.36.5): once a group has been called on this service, the others wait — priority people
        // too (priority only decides which group they are in).
        const gate = await mealPriority.callGate(svc.conference_id, svc.id, ins.id);
        if (gate) return { result: 'group_not_called', ins, ent, viaCode: hasCode, gate };
        return { result: 'ready', ins, ent, viaCode: hasCode };
    }
    // The service as the card names it (day, meal, label, window).
    const scanServiceOf = (svc) => ({ id: svc.id, service_date: svc.service_date, meal: svc.meal, label: svc.label || null, start_time: svc.start_time || null, end_time: svc.end_time || null });
    // The answer for every outcome that writes nothing — /meals/check answers it as is; /meals/deliver for
    // everything but a delivery. `person` = the usual projection (personOf, reg_code masked) + `fields`.
    async function scanAnswer(svc, d, perms) {
        const base = { result: d.result, service_id: svc.id, service: scanServiceOf(svc) };
        if (!d.ins) return base;
        const person = { ...maskRegCode(await personWithName(d.ins), perms), fields: await displayFieldsOf(d.ins, await mealDisplayOf(svc.conference_id), perms) };
        // 2.32.0: the person's meal group letter, only while «Turnos de comida» is on (shown, never enforced: an early
        // or a late arrival is served all the same).
        const mealGroup = await mealPriority.letterOf(svc.conference_id, d.ins.id);
        if (mealGroup) person.meal_group = mealGroup;
        if (d.result === 'already') return { ...base, person, ...deliveryFields(d.prior) };
        if (d.result === 'cancelled') return { ...base, person };
        if (d.result === 'group_not_called') return { ...base, person, source: d.ent.source, group: d.gate.group, called_groups: d.gate.called };
        return { ...base, person, source: d.ent.source };
    }
    const SERVICE_GONE = 'Servicio de comida no encontrado.';

    // The confirmation card (2.16.0): { service_id, code? | inscription_id? } → ALWAYS 200 with
    //   { result: 'ready' | 'not_entitled' | 'already' | 'cancelled' | 'unknown' | 'other_conference',
    //     service_id, service, person? { …, fields }, source?, delivery_id?, delivered_at?, delivered_by?,
    //     method?, note? }
    // READ-ONLY: it records nothing («Cancelar» on the card leaves the attendee pending, and the next scan
    // asks again). 'ready' = /meals/deliver would deliver; 'not_entitled' = it needs force:true (an
    // authorised override). 404 for an unknown service (also when it is deleted while this runs and the
    // answer would offer a delivery), 400 when neither code nor inscription_id is sent.
    http.route('post', '/meals/check', MEAL_ROUTE, async (req, res) => {
        const perms = await allow(req, res, 'meals_delivery', 'manage');
        if (!perms) return;
        try {
            const body = req.body || {};
            const svc = await getService(body.service_id);
            if (!svc) return res.status(404).json({ error: SERVICE_GONE });
            const d = await decideMealScan(svc, body);
            const answer = await scanAnswer(svc, d, perms);
            // A service deleted meanwhile takes its plan with it (after the service row): still there now =
            // the entitlement read above was intact.
            if ((d.result === 'ready' || d.result === 'not_entitled' || d.result === 'group_not_called') && !(await getService(svc.id))) return res.status(404).json({ error: SERVICE_GONE });
            res.json(answer);
        } catch (e) { sendError(res, e); }
    });

    // The kitchen scan: { service_id, code? | inscription_id?, force?, note? } → ALWAYS 200 with
    //   { result: 'delivered' | 'already' | 'not_entitled' | 'cancelled' | 'unknown' | 'other_conference',
    //     service_id, service, person? { …, fields }, delivered_at?, delivery_id?, delivered_by?, method?,
    //     note?, source? }
    // (404 only for an unknown service, 400 when neither code nor inscription_id is sent). The decision is
    // decideMealScan's — the one /meals/check shows: 'ready' delivers, force:true turns ONLY 'not_entitled'
    // into a delivery (method 'override'). Two simultaneous scans of one person: the UNIQUE (service,
    // attendee) index lets exactly one INSERT through; the other catches the constraint error, re-reads,
    // and answers 'already'.
    // Scans are not serialised with deletions (no transactions either), so after its INSERT — or when the
    // INSERT fails and no winning row exists (a foreign key refused it) — the route re-reads the service
    // and the attendee: if either was deleted meanwhile, its own row is removed and it answers 404 (service)
    // or 'unknown' (attendee), never «Entregado» for a delivery that does not survive. The deletions go
    // parent first, so a row inserted before the parent went is swept by them.
    const deliveryParentGone = async (serviceId, inscriptionId) => {
        if (!(await db.get(`SELECT id FROM ${T.mealServices} WHERE id = ?`, [serviceId]))) return 'service';
        if (!(await db.get(`SELECT id FROM ${T.inscriptions} WHERE id = ?`, [inscriptionId]))) return 'person';
        return null;
    };
    http.route('post', '/meals/deliver', MEAL_ROUTE, async (req, res) => {
        const perms = await allow(req, res, 'meals_delivery', 'manage');
        if (!perms) return;
        try {
            const body = req.body || {};
            const svc = await getService(body.service_id);
            if (!svc) return res.status(404).json({ error: SERVICE_GONE });
            const d = await decideMealScan(svc, body);
            const answer = await scanAnswer(svc, d, perms);
            if (d.result !== 'ready' && d.result !== 'not_entitled' && d.result !== 'group_not_called') return res.json(answer);
            const ins = d.ins;
            let method = d.viaCode ? 'scan' : 'manual';
            // 2.36.5: their group has not been called — served only when someone allows it («Dejar pasar igual»),
            // and then logged as an exception (who, when, the person, their group).
            if (d.result === 'group_not_called') {
                if (body.allow_group !== true) return res.json(answer);
                method = 'group_exception';
            }
            if (d.result === 'not_entitled') {
                if (body.force !== true) {
                    // A service deleted while this scan ran takes its plan rows with it (after the service
                    // row): if it is still there now, the plan read above was intact.
                    if (!(await getService(svc.id))) return res.status(404).json({ error: SERVICE_GONE });
                    return res.json(answer);
                }
                method = 'override';
            }
            const { person, service } = answer;
            const verdict = (result, extra) => res.json({ result, service_id: svc.id, service, ...(extra || {}) });
            const note = shortText(typeof body.note === 'string' ? body.note.trim() : null, 500);
            const stamp = utcStamp(), actor = actorOf(req);
            const parentGone = (gone) => (gone === 'service' ? res.status(404).json({ error: SERVICE_GONE }) : verdict('unknown'));
            let r;
            try {
                r = await db.run(`INSERT INTO ${T.mealDeliveries} (service_id, inscription_id, delivered_at, delivered_by, method, note) VALUES (?, ?, ?, ?, ?, ?)`,
                    [svc.id, ins.id, stamp, actor, method, note]);
            } catch (e) {
                const won = await deliveryOf(svc.id, ins.id);
                if (won) return verdict('already', { person, ...deliveryFields(won) });
                const gone = await deliveryParentGone(svc.id, ins.id);
                if (gone) return parentGone(gone);
                throw e;
            }
            const gone = await deliveryParentGone(svc.id, ins.id);
            if (gone) {
                // Its parent is gone: the (service, attendee) pair can hold no valid delivery any more.
                await db.run(`DELETE FROM ${T.mealDeliveries} WHERE service_id = ? AND inscription_id = ?`, [svc.id, ins.id]);
                return parentGone(gone);
            }
            const row = (await deliveryOf(svc.id, ins.id)) || { id: r && r.lastID, delivered_at: stamp, delivered_by: actor, method, note };
            if (method === 'group_exception') await mealPriority.logException(Number(svc.conference_id), svc.id, ins.id, d.gate.group, actor);
            return verdict('delivered', { person, ...deliveryFields(row) });
        } catch (e) { sendError(res, e); }
    });

    // Undo a delivery.
    http.route('delete', '/meals/deliveries/:id', MEAL_ROUTE, async (req, res) => {
        if (!await allow(req, res, 'meals_delivery', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const d = id ? await db.get(`SELECT id, service_id, inscription_id FROM ${T.mealDeliveries} WHERE id = ?`, [id]) : null;
            if (!d) return res.status(404).json({ error: 'Entrega no encontrada.' });
            const r = await db.run(`DELETE FROM ${T.mealDeliveries} WHERE id = ?`, [d.id]);
            if (!r || !r.changes) return res.status(404).json({ error: 'Entrega no encontrada.' });
            res.json({ success: true, delivery_id: d.id, service_id: d.service_id, inscription_id: d.inscription_id });
        } catch (e) { sendError(res, e); }
    });

    // Live counters of one service (the delivery screen polls this): same numbers as GET /meals.
    http.route('get', '/meals/services/:id/stats', MEAL_ROUTE, async (req, res) => {
        if (!await allowAny(req, res, [['meals', 'view'], ['meals_delivery', 'manage']])) return;
        try {
            const svc = await getService(req.params.id);
            if (!svc) return res.status(404).json({ error: 'Servicio de comida no encontrado.' });
            const stats = await mealStats(svc.conference_id, await loadPlan(svc.conference_id), await conferenceLocations(svc.conference_id), svc.id);
            res.json({ service_id: svc.id, ...stats.get(svc.id) });
        } catch (e) { sendError(res, e); }
    });

    // The latest deliveries of a service, newest first (`limit` ≤ 100, default 20) — the scan history.
    // `service` says WHAT every row delivered (day, meal, label — as /meals/check and /meals/deliver name
    // it) and each row carries its `service_id`: «Últimas entregas» named the person but never the meal.
    http.route('get', '/meals/services/:id/deliveries', MEAL_ROUTE, async (req, res) => {
        const perms = await allowAny(req, res, [['meals', 'view'], ['meals_delivery', 'manage']]);
        if (!perms) return;
        const showCodes = canSeeRegCodes(perms);
        try {
            const svc = await getService(req.params.id);
            if (!svc) return res.status(404).json({ error: 'Servicio de comida no encontrado.' });
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
            const nameCols = await nameFallbackColumns(svc.conference_id);
            const rows = await db.all(
                `SELECT d.id AS delivery_id, d.inscription_id, d.delivered_at, d.delivered_by, d.method, d.note, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.reg_code, l.name AS location_name${nameColumnsSql(nameCols)}`
                + ` FROM ${T.mealDeliveries} d JOIN ${T.inscriptions} i ON d.inscription_id = i.id${LOCATION_JOIN} WHERE d.service_id = ? ORDER BY d.delivered_at DESC, d.id DESC LIMIT ?`, [svc.id, limit]);
            res.json({
                service_id: svc.id,
                service: scanServiceOf(svc),
                deliveries: rows.map(r => ({ delivery_id: r.delivery_id, service_id: svc.id, inscription_id: r.inscription_id, name: personName({ ...r, id: r.inscription_id }, nameCols), location: liveLocation(r), location_id: r.location_id == null ? null : r.location_id, family_group: r.family_group || null, reg_code: showCodes ? (r.reg_code || null) : null, delivered_at: r.delivered_at, delivered_by: r.delivered_by || null, method: r.method || null, note: r.note || null })),
            });
        } catch (e) { sendError(res, e); }
    });

    // Report of one service: one row per attendee who is entitled OR was served (anyone else is not
    // concerned by it), the totals and the per-location breakdown (every location of the conference, then
    // attendees without a location as location_id null).
    http.route('get', '/meals/services/:id/report', MEAL_ROUTE, async (req, res) => {
        const perms = await allow(req, res, 'meals', 'view');
        if (!perms) return;
        const showCodes = canSeeRegCodes(perms);
        try {
            const svc = await getService(req.params.id);
            if (!svc) return res.status(404).json({ error: 'Servicio de comida no encontrado.' });
            const planned = new Set((await db.all(
                `SELECT p.location_id FROM ${T.mealPlan} p JOIN ${T.locations} l ON p.location_id = l.id WHERE p.service_id = ? AND l.conference_id = ?`, [svc.id, svc.conference_id])).map(p => Number(p.location_id)));
            const nameCols = await nameFallbackColumns(svc.conference_id);
            const list = await db.all(
                `SELECT i.id, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.reg_code, i.status, o.mode,`
                + ` d.id AS delivery_id, d.delivered_at, d.method, d.delivered_by, d.note, l.name AS location_name${nameColumnsSql(nameCols)}`
                + ` FROM ${T.inscriptions} i${LOCATION_JOIN}`
                + ` LEFT JOIN ${T.mealOverrides} o ON o.inscription_id = i.id AND o.service_id = ?`
                + ` LEFT JOIN ${T.mealDeliveries} d ON d.inscription_id = i.id AND d.service_id = ?`
                + ` WHERE i.conference_id = ? AND (d.id IS NOT NULL OR o.mode = 'include' OR i.location_id IN (SELECT p.location_id FROM ${T.mealPlan} p WHERE p.service_id = ? ))`,
                [svc.id, svc.id, svc.conference_id, svc.id]);
            const rows = [];
            for (const r of list) {
                const ent = entitlementFrom(r.status, r.mode || null, r.location_id != null && planned.has(Number(r.location_id)));
                if (!ent.entitled && r.delivery_id == null) continue;
                rows.push({
                    inscription_id: r.id, name: personName(r, nameCols), location: liveLocation(r), location_id: r.location_id == null ? null : r.location_id,
                    family_group: r.family_group || null, reg_code: showCodes ? (r.reg_code || null) : null, status: r.status || null,
                    entitled: ent.entitled, source: ent.source, delivered: r.delivery_id != null,
                    delivery_id: r.delivery_id == null ? null : r.delivery_id, delivered_at: r.delivered_at || null, method: r.method || null, delivered_by: r.delivered_by || null, note: r.note || null,
                });
            }
            // By location (its live name; people without a location — location_id null, the same bucket as
            // by_location — last), then by name.
            rows.sort((a, b) => (a.location_id == null) - (b.location_id == null) || String(a.location || '').localeCompare(String(b.location || ''))
                || (a.location_id == null ? 0 : Number(a.location_id) - Number(b.location_id)) || a.name.localeCompare(b.name) || a.inscription_id - b.inscription_id);
            const totals = { entitled: 0, delivered: 0, pending: 0, overrides_delivered: 0 };
            const locations = await conferenceLocations(svc.conference_id);
            const byLoc = new Map(locations.map(l => [String(l.id), { location_id: l.id, location: l.name, entitled: 0, delivered: 0, pending: 0 }]));
            for (const r of rows) {
                const k = r.location_id == null ? 'null' : String(r.location_id);
                // Attendees without a location share one bucket (r.location is already null for them).
                if (!byLoc.has(k)) byLoc.set(k, { location_id: r.location_id, location: r.location, entitled: 0, delivered: 0, pending: 0 });
                const b = byLoc.get(k);
                if (r.entitled) { totals.entitled++; b.entitled++; }
                if (r.delivered) { totals.delivered++; b.delivered++; }
                if (r.entitled && !r.delivered) { totals.pending++; b.pending++; }
                if (r.delivered && !r.entitled) totals.overrides_delivered++;
            }
            res.json({ service: serviceRow(svc), rows, totals, by_location: [...byLoc.values()] });
        } catch (e) { sendError(res, e); }
    });

    // === INSCRIPTIONS: edit / delete / manual room assignment ===
    // total_due is DERIVED — a client value is ignored. It is frozen at registration; an edit re-prices
    // it ONLY when the edit changes what the CURRENT rules yield (a fee-relevant field changed: the
    // rules give a different fee for the row before vs after). A notes/status/location-only edit —
    // or an edit that leaves every fee-relevant value as it was — never touches total_due, even when
    // rules or the base fee changed since registration: those reach existing attendees only through
    // /reprice, for EVERYONE at once, never one attendee at a time through an unrelated edit.
    http.route('put', '/inscriptions/:id', { auth: true }, async (req, res) => {
        const perms = await allow(req, res, 'inscriptions', 'manage');
        if (!perms) return;
        const { conference_id, ...fieldValues } = req.body || {};
        try {
            // Every decision that touches a bed or a frozen location is taken again on the row as it is under
            // the assignment lock (see «touchesLodging» below): a placement landing between this read and the
            // write, or a submit of the location's arrangement, is seen there. A notes-only edit skips the lock.
            const existing = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            if (!existing) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            const id = existing.id;

            // Write each DEFINED field's canonical value to its column (schema follows the form) + the
            // operational edits the admin is allowed to change directly (status, notes, location_id).
            const confFields = await db.all(FIELD_COLUMNS_SQL, [existing.conference_id]);
            const vals = canonicalFieldValues(confFields, fieldValues, { phoneCountry: phoneCountryOf(await db.get(`SELECT phone_country FROM ${T.conferences} WHERE id = ?`, [existing.conference_id])) });
            assertRequired(confFields, vals, true);
            await assertUnique(confFields, vals, { conference_id: existing.conference_id }, id);
            const healthIn = await healthFromBody(existing.conference_id, fieldValues, { mayWrite: canWriteHealth(perms), creating: false, inscriptionId: id });
            // 2.36.10: the form fields this edit really changes (their names go to the «Historial»; never the values).
            const changedFields = Object.keys(vals).filter(k => String(existing[k] == null ? '' : existing[k]) !== String(vals[k] == null ? '' : vals[k]));
            const recordGeneral = await consent.isEnabled(existing.conference_id) ? await assertEditAuthorizations(id, fieldValues, changedFields.length > 0) : false;

            const sets = [], params = [];
            for (const [k, v] of Object.entries(vals)) { sets.push(`${k} = ?`); params.push(v); }
            let newStatus = existing.status;
            if (fieldValues.status !== undefined) {
                // Closed vocabulary — the same rule the conference `status` already follows. 'pending' is the
                // insert default, 'active' is what the admin's toggle writes; anything else is a typo or a probe.
                const st = fieldValues.status == null ? null : String(fieldValues.status);
                if (st !== null && !INSCRIPTION_STATUSES.has(st)) return res.status(400).json({ error: 'Estado de inscripción inválido.' });
                // «Autorización de datos» (2.33.0): nobody is confirmed before they authorize the processing of their data.
                if (st === 'active' && existing.status !== 'active' && await consent.isEnabled(existing.conference_id) && !await consent.isGranted(id)) {
                    return res.status(409).json({ error: 'Esta persona aún no autoriza el tratamiento de sus datos: la inscripción se confirma cuando lo haga (Autorizaciones › Reenviar enlace).', code: 'consent_pending' });
                }
                sets.push('status = ?'); params.push(st);
                newStatus = st;
            }
            // 2.36.6: a withdrawn registration put back (restored) loses its withdrawal stamp — and NOT its old bed: the
            // withdrawal freed it and nothing gives it back (the answer says so: `restored`).
            const restored = !!existing.withdrawn_at && fieldValues.status !== undefined && newStatus !== 'cancelled';
            if (restored) { sets.push('withdrawn_at = ?', 'withdrawn_by = ?', 'withdraw_reason = ?'); params.push(null, null, null); }
            if (fieldValues.notes !== undefined) { sets.push('notes = ?'); params.push(fieldValues.notes == null ? null : String(fieldValues.notes)); }
            const loc = await resolveAdminLocation(existing.conference_id, { location_id: fieldValues.location_id });
            if (loc === null) { sets.push('location_id = ?', 'location = ?'); params.push(null, null); }
            else if (loc) { sets.push('location_id = ?', 'location = ?'); params.push(loc.id, loc.name); }
            const currentLocationId = existing.location_id == null ? null : Number(existing.location_id);
            const locationChanges = loc !== undefined && (loc ? Number(loc.id) : null) !== currentLocationId;
            // 2.36.10: what the «Historial» will say this edit changed, and who did it (updated_by).
            const historyFields = [...changedFields];
            if (newStatus !== existing.status) historyFields.push('status');
            if (locationChanges) historyFields.push('location');
            if (fieldValues.notes !== undefined && String(existing.notes == null ? '' : existing.notes) !== String(fieldValues.notes == null ? '' : fieldValues.notes)) historyFields.push('notes');
            if (healthIn.answer !== undefined) historyFields.push(HEALTH_FIELD);
            if (historyFields.length) { sets.push('updated_by = ?'); params.push(actorOf(req)); }
            // Capacity: the edit takes a seat when the attendee ends up counted in a location where they were
            // not counted before — moved in from elsewhere (or from no location), or un-cancelled in place.
            // Staying put, cancelling, or leaving a location never needs a free seat.
            const target = loc !== undefined ? loc
                : (existing.location_id != null ? await db.get(`SELECT id, name, capacity FROM ${T.locations} WHERE id = ?`, [existing.location_id]) : null);
            const willCount = !!target && newStatus !== 'cancelled';
            const wasCountedThere = !!target && existing.location_id === target.id && existing.status !== 'cancelled';
            if (willCount && !wasCountedThere) await assertLocationHasRoom(target);
            // The write that takes the seat repeats that check under the location's seat lock (2.17.1, takeSeat):
            // two edits (or an edit and a registration) racing for the last seat cannot both pass.
            const takesSeat = willCount && !wasCountedThere;
            // Lodging: a move out of an ALLOTTED room frees the bed (invariant 1) unless the room is allotted
            // to the DESTINATION location (the placement stays valid), and a cancellation always frees the
            // bed (invariant 2).
            //
            // Against a submitted / validated ("reviewed") arrangement (2.17.0) the rule is the BED RULE — the
            // same here, in DELETE /inscriptions/:id and in every door that adds an attendee to a location
            // (POST /inscriptions, POST /portal/inscriptions, the public form): a reviewed arrangement is who
            // sleeps where, so only an attendee who HOLDS A BED changes it, in either direction.
            //   - WITH a bed: moving them OUT of a reviewed location (the move frees the bed, or they take a
            //     pool bed with them) or INTO one with the bed they keep (a pool bed, or one of its own rooms)
            //     re-arranges it: Hospedaje › gestionar's to do as well (409 to a role that may only manage
            //     inscriptions — it must not re-arrange one through this door) and stamped on it. Cancelling
            //     or deleting them frees the bed (invariant 2) with inscriptions:manage alone, as before 2.17.0,
            //     and is stamped on it.
            //   - WITHOUT a bed (none, or one the move itself frees on the way): entering, leaving, cancelling
            //     or deleting changes nobody's bed — inscriptions:manage alone and never stamped, going in AND
            //     coming out (like a new registration into the location; the review's «sin habitación» count
            //     shows them). One permission for both directions: a role that may register someone into a
            //     reviewed location may also take them out while they hold no bed.
            // An edit that changes neither the location nor the cancellation touches no bed: it skips the
            // assignment lock (a conference-wide run holds it while it loads and flushes, and must not stall
            // every notes edit). The others decide on the row as it is under the lock (re-read there), where
            // every lodging status transition runs too: the statuses read are the ones the write lands on.
            // «Requiere hospedaje» switched to No (2.31.0) frees the bed too, like a cancellation.
            const dropsLodging = vals[LODGING_FIELD] === SWITCH_OFF;
            const touchesLodging = locationChanges || newStatus === 'cancelled' || dropsLodging;
            const writeEdit = async (extraSets = [], extraParams = []) => {
                const s = [...sets, ...extraSets];
                if (!s.length) return false;
                const write = () => db.run(`UPDATE ${T.inscriptions} SET ${s.join(', ')} WHERE id = ?`, [...params, ...extraParams, id]);
                if (takesSeat) await takeSeat(target, write); else await write();
                return true;
            };
            const adjusted = !touchesLodging ? (await writeEdit(), []) : await withAssignmentLock(async () => {
                const cur = await db.get(`SELECT location_id, room_id FROM ${T.inscriptions} WHERE id = ?`, [id]);
                if (!cur) throw httpError(404, 'Inscripción no encontrada.');
                const curLocationId = cur.location_id == null ? null : Number(cur.location_id);
                // The move (and the seat check above) were decided against the location read before the lock:
                // if another edit moved the attendee meanwhile, refuse rather than act on a stale origin.
                if (locationChanges && curLocationId !== currentLocationId) {
                    throw httpError(409, 'La localidad de este participante cambió mientras guardabas; recarga y vuelve a intentarlo.');
                }
                const hasBed = cur.room_id != null;
                let freeBed = false;
                if (hasBed) {
                    if (newStatus === 'cancelled' || dropsLodging) freeBed = true;
                    else if (locationChanges) {
                        const curRoom = await db.get(`SELECT id, location_id, capacity FROM ${T.rooms} WHERE id = ?`, [cur.room_id]);
                        if (curRoom && curRoom.location_id != null && Number(curRoom.location_id) !== (loc ? Number(loc.id) : NaN)) freeBed = true;
                        else if (curRoom && curRoom.location_id == null) {
                            // A shared room (2.18.0): the bed stays only if the new location has a free bed of
                            // its own there, or a pool bed is free.
                            const shares = (await sharesByRoom([curRoom.id])).get(Number(curRoom.id)) || [];
                            if (shares.length) {
                                const occupants = await db.all(`SELECT id, location_id FROM ${T.inscriptions} WHERE room_id = ?`, [curRoom.id]);
                                if (!bedFreeFor(curRoom, shares, occupants, { id, location_id: loc ? loc.id : null })) freeBed = true;
                            }
                        }
                    }
                }
                const keepsBed = hasBed && !freeBed;
                // The bed rule (above): an attendee without a bed is part of no arrangement — no source, no into.
                const source = hasBed && curLocationId != null && (locationChanges || freeBed) ? await frozenLocationRow(curLocationId) : null;
                const into = locationChanges && keepsBed && loc ? await frozenLocationRow(loc.id) : null;
                if (!hasLevel(perms, 'lodging', 'manage')) {
                    // A bed the administration holds (see «HELD BY THE ADMINISTRATION»): freeing it is lodging's.
                    if (freeBed) {
                        const held = await db.get(`SELECT i.room_id, i.room_locked, r.blocked FROM ${T.inscriptions} i LEFT JOIN ${T.rooms} r ON r.id = i.room_id WHERE i.id = ?`, [id]);
                        if (held && (isPinned(held) || isBlocked(held))) throw httpError(409, isPinned(held) ? HELD_PERSON_MSG : HELD_ROOM_MSG);
                    }
                    if (source && locationChanges) {
                        throw httpError(409, `El hospedaje de la localidad «${source.name}» ${frozenPhrase(source)}: sacar de ella a un participante que tiene cama lo cambia, y eso lo hace quien gestiona el Hospedaje (o se podrá ${releasePhrase(source)}).`);
                    }
                    if (into) {
                        throw httpError(409, `El hospedaje de la localidad «${into.name}» ${frozenPhrase(into)}: este participante entraría en él con la cama que ya tiene, y eso lo hace quien gestiona el Hospedaje (sin habitación sí podría entrar; con ella, se podrá ${releasePhrase(into)}).`);
                    }
                }
                const wrote = freeBed ? await writeEdit(['room_id = ?', 'room_locked = ?'], [null, null]) : await writeEdit();
                return wrote ? stampAdminAdjustment(req, [source && source.id, into && into.id]) : [];
            });
            // Re-price ONLY if the edit changed the outcome of the CURRENT rules (before vs after the
            // update, same rules, same base fee) — so a rule added since registration cannot leak onto
            // one attendee through a notes-only edit (see the route comment). Then keep payment_status
            // coherent with total_due.
            const updated = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [id]);
            const c = await db.get(`SELECT fee_default FROM ${T.conferences} WHERE id = ?`, [existing.conference_id]);
            const rules = await loadFeeRules(existing.conference_id);
            const feeBefore = applyFeeRules(rules, existing, c ? c.fee_default : 0);
            const feeAfter = applyFeeRules(rules, updated, c ? c.fee_default : 0);
            if (toCents(feeBefore) !== toCents(feeAfter) && toCents(feeAfter) !== toCents(updated.total_due)) {
                await db.run(`UPDATE ${T.inscriptions} SET total_due = ? WHERE id = ?`, [feeAfter, id]);
            }
            await recomputePayment(id);
            if (healthIn.answer !== undefined) {
                await health.save(existing.conference_id, id, healthIn.answer);
                await consentHealthEntered(id, actorOf(req), 'admin', healthIn);
            }
            if (historyFields.length) await recordHistory(existing.conference_id, id, 'edited', actorOf(req), 'admin', historyFields);
            if (recordGeneral) await consentGeneralEntered(id, actorOf(req), 'admin');
            if (restored) {
                await db.run(`INSERT INTO ${T.withdrawals} (conference_id, inscription_id, kind, actor, at_utc, reason) VALUES (?, ?, 'restore', ?, ?, NULL)`,
                    [existing.conference_id, id, actorOf(req), new Date().toISOString().slice(0, 19).replace('T', ' ')]);
            }
            res.json({ success: true, lodging_adjusted: adjusted, ...(restored ? { restored: true } : {}) });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/inscriptions/:id', { auth: true }, async (req, res) => {
        const perms = await allow(req, res, 'inscriptions', 'manage');
        if (!perms) return;
        try {
            // A fee migration that failed at boot gets one more attempt first: in degraded mode a person with
            // payments cannot be deleted (fees.inscriptionDeletePlan answers 503).
            if (!fees.ready) await fees.ensureReady();
            let adjusted = [];
            // Under the payments lock: no payment of THIS node can take this person in between the checks and the
            // delete (another node's: see the «tombstone» below). Transport is sold and paid under the ASSIGNMENT
            // lock, which is also where the lodging status transitions run: a person with a seat, a package or a
            // bed is deleted under it too (below) — a transport payment landing between the check and the delete
            // was otherwise erased by a role that may not erase it, or answered as recorded and then erased with
            // its seat. Lock order: payments, then assignment, then meals (nothing takes them the other way).
            await fees.withPaymentsLock(async () => {
                // Deleting the attendee deletes its money too (fee payments, transport payments below). That is a
                // payments / transport decision: a role that may only manage inscriptions must not erase validated
                // income through this door (DELETE /fee-payments/:id and DELETE /buses/:id refuse it). Checked
                // FIRST: such a role gets this generic answer, never the payment numbers, statuses and sizes of
                // the shared-payment answer below — payment data belongs to Pagos (D-P20).
                const fee = await db.get(`SELECT COUNT(*) AS n FROM ${T.payments} WHERE inscription_id = ?`, [req.params.id]);
                const rides = await db.get(`SELECT (SELECT COUNT(*) FROM ${T.transportPayments} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE inscription_id = ? ))`
                    + ` + (SELECT COUNT(*) FROM ${T.packagePayments} WHERE sale_id IN (SELECT id FROM ${T.packageSales} WHERE inscription_id = ? )) AS n`, [req.params.id, req.params.id]);
                if ((Number(fee && fee.n) > 0 && !hasLevel(perms, 'payments', 'manage')) || (Number(rides && rides.n) > 0 && !hasLevel(perms, 'transport', 'manage'))) {
                    throw httpError(409, 'La inscripción tiene pagos registrados: pide a quien gestiona los pagos que los anule, o cancela la inscripción en lugar de eliminarla.');
                }
                // Fee payments (2.18.0): a person who is a part of a payment SHARED with others cannot be
                // deleted (the receipt's split would no longer add up) — 409 `shared`: correct the split or
                // cancel the inscription. Their 1-person payments go with them (header first).
                let plan = await fees.inscriptionDeletePlan(req.params.id);
                // Several nodes (2.18.0 review R4-L2): another node may record a payment with this person between
                // that check and the delete (its lock is its own), and the delete would take that payment's part
                // — a receipt left with a part missing. So the person is first marked cancelled (a «tombstone»:
                // a cancelled inscription owes nothing, so any payment another node adds for them from now on
                // fails its own re-check after writing and backs off — fees.overAfterWrite), and THEN checked
                // again: a payment that landed before the tombstone is seen here (409 shared, the person stays as
                // they were), one after it never stands.
                // The person's 1-person payments go FIRST, each only at the split it has (R5-L1 / R6-L2,
                // fees.deleteForInscription): every one is read again before anything is deleted; one another node
                // moved to someone else meanwhile is left alone (it is no longer theirs), one that became shared
                // answers 409 stale — before anything is deleted, or, in the instant between two deletes, naming
                // the payments already deleted (validated ones go last). A refusal puts the person back as they were.
                const was = await db.get(`SELECT status FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
                const marked = !!(was && was.status !== 'cancelled');
                if (marked) await db.run(`UPDATE ${T.inscriptions} SET status = 'cancelled' WHERE id = ?`, [req.params.id]);
                try {
                    if (marked) plan = await fees.inscriptionDeletePlan(req.params.id);
                    await fees.deleteForInscription(req.params.id, plan.transfers);
                } catch (e) {
                    if (marked) await db.run(`UPDATE ${T.inscriptions} SET status = ? WHERE id = ? AND status = 'cancelled'`, [was.status, req.params.id]);
                    throw e;
                }
                // Meals (2.14.0): the attendee first, then its meal rows (the FKs cascade; the explicit deletes
                // keep it so with foreign keys off). Under the meals lock an override write cannot slip in for a
                // deleted attendee, and a scan racing this re-checks the attendee after its INSERT. `onlyIfFree`
                // makes the attendee's DELETE conditional on holding no bed, no seat and no package (and then
                // nothing else runs when no row went). Answers whether the attendee's row went.
                const FREE_SQL = ` AND room_id IS NULL AND NOT EXISTS (SELECT 1 FROM ${T.tickets} t WHERE t.inscription_id = ? )`
                    + ` AND NOT EXISTS (SELECT 1 FROM ${T.packageSales} s WHERE s.inscription_id = ? )`;
                const deleteAttendee = (onlyIfFree) => withMealsLock(async () => {
                    const r = await db.run(`DELETE FROM ${T.inscriptions} WHERE id = ?${onlyIfFree ? FREE_SQL : ''}`,
                        onlyIfFree ? [req.params.id, req.params.id, req.params.id] : [req.params.id]);
                    const gone = !!(r && r.changes);
                    if (onlyIfFree && !gone) return false;
                    await db.run(`DELETE FROM ${T.mealDeliveries} WHERE inscription_id = ?`, [req.params.id]);
                    await db.run(`DELETE FROM ${T.mealOverrides} WHERE inscription_id = ?`, [req.params.id]);
                    await health.clearInscription(req.params.id);
                    // 2.33.0: the consent link goes with the person; their evidence (consent_events) stays.
                    await db.run(`DELETE FROM ${T.consentRequests} WHERE inscription_id = ?`, [req.params.id]);
                    await db.run(`DELETE FROM ${T.mealGroups} WHERE inscription_id = ?`, [req.params.id]);
                    return gone;
                });
                // Someone with no bed, no seat and no package touches neither transport nor lodging: deleted without
                // the assignment lock (a conference-wide run holds it while it loads and flushes, and must not stall
                // it) — conditional, in ONE statement, on still having none, so a seat sold or a bed given meanwhile
                // falls to the locked path.
                if (await deleteAttendee(true)) return;
                adjusted = await withAssignmentLock(async () => {
                    // Transport, again under the lock its payments are recorded under (a sale and its payment may have
                    // landed since the first check).
                    const ridesNow = await db.get(`SELECT (SELECT COUNT(*) FROM ${T.transportPayments} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE inscription_id = ? ))`
                        + ` + (SELECT COUNT(*) FROM ${T.packagePayments} WHERE sale_id IN (SELECT id FROM ${T.packageSales} WHERE inscription_id = ? )) AS n`, [req.params.id, req.params.id]);
                    if (Number(ridesNow && ridesNow.n) > 0 && !hasLevel(perms, 'transport', 'manage')) {
                        if (marked) await db.run(`UPDATE ${T.inscriptions} SET status = ? WHERE id = ? AND status = 'cancelled'`, [was.status, req.params.id]);
                        throw httpError(409, 'La inscripción tiene pagos registrados: pide a quien gestiona los pagos que los anule, o cancela la inscripción en lugar de eliminarla.');
                    }
                    await db.run(`DELETE FROM ${T.transportPayments} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE inscription_id = ? )`, [req.params.id]);
                    await db.run(`DELETE FROM ${T.tickets} WHERE inscription_id = ?`, [req.params.id]);
                    await db.run(`DELETE FROM ${T.packagePayments} WHERE sale_id IN (SELECT id FROM ${T.packageSales} WHERE inscription_id = ? )`, [req.params.id]);
                    await db.run(`DELETE FROM ${T.packageSales} WHERE inscription_id = ?`, [req.params.id]);
                    // Lodging (2.17.0) — the bed rule of PUT /inscriptions/:id: deleting someone who holds a bed
                    // changes the arrangement of THEIR location when it is submitted / validated — an administration
                    // adjustment, stamped here under the assignment lock (where the status transitions run), with
                    // inscriptions:manage alone, like a cancellation (invariant 2 frees the bed). Someone WITHOUT a
                    // bed changes nobody's arrangement: never stamped, whatever their location's state. The fee
                    // «tombstone» above only changes the status: a bed, if any, is still held here, so the stamp sees it.
                    const victim = await db.get(`SELECT location_id, room_id FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
                    const gone = await deleteAttendee(false);
                    return gone && victim && victim.room_id != null && victim.location_id != null ? stampAdminAdjustment(req, [victim.location_id]) : [];
                });
            });
            res.json({ success: true, lodging_adjusted: adjusted });
        } catch (e) { fees.sendFeeError(res, e); }
    });

    // Manual room assignment — validates capacity + same-conference scope (auto-assign already does;
    // the manual path used to bare-UPDATE and could overfill or cross-place). Pass room_id null to free.
    // Lodging (2.5.0): a cancelled attendee is never placed; an allotted room only takes its own
    // location's attendees (roomAllows). An attendee of a submitted / validated location is placed,
    // moved or freed all the same: an administration adjustment, stamped on that location (2.17.0 — it
    // used to be a 409 until the location was reopened).
    http.route('post', '/inscriptions/:id/assign', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { room_id: rawRoomId } = req.body || {};
        try {
            const id = positiveInt(req.params.id);
            const ins = id ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            const unassign = rawRoomId === null || rawRoomId === undefined || rawRoomId === '';
            const roomId = unassign ? null : positiveInt(rawRoomId);
            if (!unassign && !roomId) return res.status(400).json({ error: 'Habitación inválida.' });
            // Check-then-write under the assignment lock: two concurrent assigns into the last bed (or an
            // assign racing an engine run's load→flush window) would otherwise overbook the room. The
            // attendee's room, location and status are read again INSIDE the lock, where an edit (PUT
            // /inscriptions) cannot cancel or move them between the read and the write: read only before the
            // lock, a cancellation landing in between left the cancelled attendee holding the bed. The UPDATE is
            // conditional on the capacity as well, so a lost race answers "llena" instead of writing.
            const adjusted = await withAssignmentLock(async () => {
                // What the stamp and the "already here / nothing to free" no-ops look at is what the write lands on.
                const cur = await db.get(`SELECT room_id, location_id, status FROM ${T.inscriptions} WHERE id = ?`, [id]);
                if (!cur) throw httpError(404, 'Inscripción no encontrada.');
                const person = { ...ins, ...cur };
                if (unassign) {
                    if (cur.room_id == null) return [];
                    // Out of the room, a fixed person is fixed nowhere (see «HELD BY THE ADMINISTRATION»).
                    await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE id = ?`, [id]);
                    return stampAdminAdjustment(req, [cur.location_id]);
                }
                if (person.status === 'cancelled') throw httpError(400, 'Un participante cancelado no ocupa habitación.');
                if (!needsLodging(person)) throw httpError(400, NO_LODGING_MSG);
                const room = await db.get(
                    `SELECT r.*, h.conference_id, l.name AS location_name,
                            (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) as occupied
                     FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id LEFT JOIN ${T.locations} l ON r.location_id = l.id WHERE r.id = ?`, [roomId]);
                if (!room) throw httpError(404, 'Habitación no encontrada.');
                if (Number(room.conference_id) !== Number(person.conference_id)) throw httpError(400, 'Esa habitación pertenece a otra conferencia.');
                if (!roomAllows(room, person)) throw httpError(400, `Esa habitación está asignada a la localidad «${room.location_name || room.location_id}».`);
                const alreadyHere = Number(cur.room_id) === Number(roomId);
                if (alreadyHere) return [];
                if (room.occupied >= room.capacity) throw httpError(400, 'La habitación está llena.');
                // A shared room (2.18.0): the person takes one of their location's beds there, or a pool bed.
                const shares = (await sharesByRoom([room.id])).get(Number(room.id)) || [];
                if (shares.length) {
                    const occupants = await db.all(`SELECT id, location_id FROM ${T.inscriptions} WHERE room_id = ?`, [room.id]);
                    if (!bedFreeFor(room, shares, occupants, person)) {
                        throw httpError(400, shareBedsOf(shares, person.location_id)
                            ? 'Las camas de su localidad en esta habitación ya están ocupadas y no quedan camas libres.'
                            : 'Esta habitación está repartida entre localidades y no le quedan camas libres.');
                    }
                }
                await assertShareLock(room, person, person.conference_id, { admin: true });
                // Plain UPDATE on purpose: the capacity check above runs under the assignment lock, and an
                // UPDATE whose subquery reads the table being updated is refused by MySQL (error 1093).
                await db.run(`UPDATE ${T.inscriptions} SET room_id = ?, room_locked = NULL WHERE id = ?`, [roomId, id]);
                return stampAdminAdjustment(req, [cur.location_id]);
            });
            res.json({ success: true, lodging_adjusted: adjusted });
        } catch (e) { sendError(res, e); }
    });

    // === PAYMENTS ===
    // «Pagos de cuotas» (2.18.0): /fee-payments* (admin) and /portal/fee-payments* (coordinators) — the
    // routes, the model and the state machine are in server/fee-payments.js:
    //   pending → validated | returned | rejected; returned → pending (corrected and resent) | validated |
    //   rejected; validated → rejected (void, with a reason); rejected → validated. A validated payment is
    //   never edited or deleted. Reviews stamp reviewed_at / reviewed_by with the acting user's login (actorOf).
    const reviewerOf = (req) => actorOf(req);
    fees.install({
        http, allow, positiveInt, actorOf, resolvePortalLocation, personName, nameFallbackColumns, canSeeRegCodes,
        PAYMENT_METHODS, MAX_PROOF_CHARS, assertPaymentMethod, enabledPaymentMethods, assertProof,
    });
    // «Mi inscripción» (2.23.0). The badge's QR carries `<site>/portal/conference/yo#c=<code>` while the
    // conference's participant page is on and the site's address is readable (grant settings:read); otherwise the
    // bare code, as in 2.22.0. The meal scanner reads both (findByScanCode). The address is the site's ONE link
    // base (wordjs.site.url), cached for a minute.
    let siteBase = { v: null, at: 0 };
    async function siteLinkBase() {
        if (Date.now() - siteBase.at < 60 * 1000) return siteBase.v;
        let v = null;
        try {
            const u = String((await wordjs.site.url()) || '').trim().replace(/\/+$/, '');
            v = /^https?:\/\/[^\s#?]+$/i.test(u) ? u : null;
        } catch (e) { v = null; }
        siteBase = { v, at: Date.now() };
        return v;
    }
    const SELF_PATH = '/portal/conference/yo#c=';
    async function selfLinkPrefix(cid, cfg) {
        const c = cfg || await badges.configOf(cid);
        if (!c.policy.self_page.enabled) return null;
        const base = await siteLinkBase();
        return base ? `${base}${SELF_PATH}` : null;
    }
    async function qrText(code, cid, cfg) {
        const prefix = code ? await selfLinkPrefix(cid, cfg) : null;
        return prefix ? `${prefix}${code}` : code;
    }
    // A stored delivery time as ISO UTC: SQLite / MySQL keep 'YYYY-MM-DD HH:MM:SS' (UTC, utcStamp), Postgres
    // hands back a Date.
    const isoUtc = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
        const s = String(v).trim().replace(' ', 'T');
        return /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
    };
    // One person's meals for «Mi inscripción»: those delivered (and when) and those still to come — the
    // services they are entitled to (entitlementFrom, THE rule) and have not received yet. Day, then meal order.
    async function mealsOfPerson(ins) {
        const services = await db.all(`SELECT id, service_date, meal, label, start_time, end_time FROM ${T.mealServices} WHERE conference_id = ?`, [ins.conference_id]);
        if (!services.length) return { delivered: [], pending: [] };
        const delivered = new Map((await db.all(`SELECT service_id, delivered_at FROM ${T.mealDeliveries} WHERE inscription_id = ?`, [ins.id])).map(d => [Number(d.service_id), d.delivered_at]));
        const modes = new Map((await db.all(`SELECT service_id, mode FROM ${T.mealOverrides} WHERE inscription_id = ?`, [ins.id])).map(o => [Number(o.service_id), o.mode]));
        const planned = new Set(ins.location_id == null ? [] : (await db.all(`SELECT service_id FROM ${T.mealPlan} WHERE location_id = ?`, [ins.location_id])).map(r => Number(r.service_id)));
        const order = (s) => `${s.service_date} ${MEALS.indexOf(s.meal) < 0 ? 9 : MEALS.indexOf(s.meal)}`;
        const out = { delivered: [], pending: [] };
        for (const s of services.slice().sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))) {
            const base = { date: s.service_date, meal: s.meal, label: s.label || null, start_time: s.start_time || null, end_time: s.end_time || null };
            const id = Number(s.id);
            if (delivered.has(id)) out.delivered.push({ ...base, delivered_at: isoUtc(delivered.get(id)) });
            else if (entitlementFrom(ins.status, modes.get(id) || null, planned.has(id)).entitled) out.pending.push(base);
        }
        return out;
    }
    // «Plantillas de correo» (2.36.11): the admin routes, and the site's name for the footer of every e-mail.
    const siteName = async () => { try { return wordjs.options && wordjs.options.get ? String(await wordjs.options.get('blogname', '') || '') : ''; } catch (e) { return ''; } };
    mailTemplates.install({ http, sendError, httpError, actorOf, siteLinkBase, siteName, mail: (msg) => wordjs.mail(msg) });
    badges.install({
        mailTemplates,
        http, allow, positiveInt, actorOf, resolvePortalLocation, personWithName, isFieldColumn, hasLevel,
        randomToken: (n) => wordjs.crypto.randomToken(n), qrText,
        mealGroupOf: (cid, id) => mealPriority.letterOf(cid, id),
        // 2.36.6, «Escarapela» › «Enviar»: the person's e-mail and WhatsApp number as consent reads them, the e-mail
        // language, the site's address for the link and the site's mail (email:admin, as consent's e-mails).
        contactOf: (ins) => consent.contactOf(ins),
        emailsOf: (cid, rows) => consent.emailsOf(cid, rows),
        mailLangOf: (cid) => consent.mailLangOf(cid),
        siteLinkBase: () => siteLinkBase(),
        mail: (msg) => wordjs.mail(msg),
    });
    packages.install({
        http, allow, allowAny, positiveInt, withAssignmentLock, sendError, httpError, roundMoney, assertMoneyRange, runBatched, MAX_MONEY,
        assertPaymentMethod, normDate, shortText, reviewerOf, toCents, fromCents,
    });
    selfPage.install({
        http, isFieldColumn, personWithName, badges, mealsOf: mealsOfPerson,
        mealGroupOf: (ins) => mealPriority.personGroup(ins.conference_id, ins.id),
        randomToken: (n) => wordjs.crypto.randomToken(n),
        transportOf: (ins) => push.transportOf(ins),
        pushKey: async () => (await push.siteKey()).publicKey,
        onSessionEnd: (id) => push.dropSession(id),
    });
    push.install({ http, allow, positiveInt, sendError, actorOf, siteLinkBase, selfPage, selfMessages: selfPage.MSG });
    // «Autorización de datos» (2.33.0).
    consent.install({
        mailTemplates,
        http, allow, positiveInt, sendError, httpError, actorOf, resolvePortalLocation, siteLinkBase, personWithName, isFieldColumn, health,
        docFieldsOf: (form) => selfDocFieldsOf(form, null, isFieldColumn),
        parseHealthAnswer: healthMod.parseAnswer,
        randomToken: (n) => wordjs.crypto.randomToken(n),
        randomInt: (lo, hi) => wordjs.crypto.randomInt(lo, hi),
        // The site's mail plugin (email:admin). Without it, or without the grant, the link is still created and the
        // coordinator sees «correo no enviado».
        mail: (msg) => wordjs.mail(msg),
        // 2.36.3: a ticket for the portal's file route, which answers the paper sheet's PDF (badges' public route).
        fileTicket: (cid, scope) => badges.fileTicket(cid, scope),
        // The site's language (WPLANG, settings:read), the default «Idioma de los correos» (2.33.4).
        siteLang: async () => { try { return wordjs.options && wordjs.options.get ? await wordjs.options.get('WPLANG', '') : ''; } catch (e) { return ''; } },
    });
    badges.fileProvider('consent_sheet', (t) => consent.paperPdf(t.conference_id, t.scope.sheet_id));
    // The health purge runs at boot and then every six hours (and when the settings are opened).
    consent.purgeDue({ force: true }).catch((e) => console.warn('[conference-manager] health purge:', e && e.message));
    if (typeof setInterval === 'function') {
        const purgeTimer = setInterval(() => { consent.purgeDue({ force: true }).catch(() => {}); }, 6 * 60 * 60 * 1000);
        if (purgeTimer && typeof purgeTimer.unref === 'function') purgeTimer.unref();
    }
    // Registering someone while consent is asked: an e-mail written in the form must be a valid one (the link goes
    // there). Since 2.35.0 it may be left empty — a walk-in signs on paper, or gets the link by «Copiar mensaje»
    // and types an e-mail on the consent page. Checked before the insert…
    const CONSENT_EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
    async function assertConsentEmail(conferenceId, values) {
        const form = await db.all(`SELECT name, label, type, role FROM ${T.fields} WHERE conference_id = ?`, [conferenceId]);
        // The same field the consent module reads (role, name, type, or a label like «Correo», 2.33.3).
        const f = emailFieldIn(form, isFieldColumn);
        const v = f ? String(values[f.name] == null ? '' : values[f.name]).trim() : '';
        if (v && !CONSENT_EMAIL_RE.test(v)) {
            throw httpError(400, `Escribe un correo válido en «${f.label || f.name}» (o déjalo vacío): allí llega el enlace para que la persona (o su padre, madre o representante) autorice el tratamiento de sus datos.`);
        }
    }
    /**
     * Without an e-mail (2.35.0) the duplicate guard falls back to the person: the same name (accents and case aside)
     * and the same ID document number or phone in the conference (the portal: in the coordinator's own location, like
     * the other duplicate checks) is the same registration. Only when the form has an e-mail field left empty.
     */
    const personKey = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    async function assertNoEmailDuplicate(conferenceId, values, scope) {
        const form = await db.all(FIELD_COLUMNS_SQL, [conferenceId]);
        const emailField = emailFieldIn(form, isFieldColumn);
        if (!emailField || String(values[emailField.name] == null ? '' : values[emailField.name]).trim()) return;
        const name = personKey(`${values.first_name || ''} ${values.last_name || ''}`);
        if (!name) return;
        const doc = selfDocFieldsOf(form, null, isFieldColumn).number;
        const usable = form.filter(f => isFieldColumn(f.name));
        const phone = usable.find(f => f.role === 'phone') || usable.find(f => f.type === 'tel' || f.type === 'phone');
        const keys = [doc, phone].filter(f => f && String(values[f.name] == null ? '' : values[f.name]).trim());
        if (!keys.length) return;
        let sql = `SELECT id, first_name, last_name FROM ${T.inscriptions} WHERE conference_id = ? AND (status IS NULL OR status <> 'cancelled') AND (${keys.map(f => `${f.name} = ?`).join(' OR ')})`;
        const params = [conferenceId, ...keys.map(f => values[f.name])];
        if (scope.location_id != null) { sql += ' AND location_id = ?'; params.push(scope.location_id); }
        const same = (await db.all(sql, params)).find(r => personKey(`${r.first_name || ''} ${r.last_name || ''}`) === name);
        if (same) throw httpError(409, `Ya hay una inscripción con el mismo nombre y ${keys.map(f => `«${f.label || f.name}»`).join(' o ')}. Si es otra persona, escribe su correo para distinguirla.`);
    }
    // A health answer staff entered (2.34.0): the verbal authorization it rests on, and who entered or changed it.
    // 2.36.10: a registration made by staff (the admin's «Nueva inscripción», the portal's «Registrar nuevo») while the
    // conference asks for consent needs the person's verbal authorization of their personal data — the ticked
    // statement, `general_verbal_consent: true`. Checked before anything is written; recorded right after.
    function assertGeneralVerbal(consentOn, body) {
        if (!consentOn || (body && body.general_verbal_consent === true)) return;
        const e = httpError(400, 'Marca que la persona te autorizó verbalmente a tratar sus datos personales. Sin esa autorización no se guarda la inscripción.');
        e.field = 'general_verbal_consent';
        throw e;
    }
    // 2.36.10: editing a person while consent is on. A recorded authorization (written or verbal) cannot be cleared
    // here (409 — «Revocar» does that); with none recorded (a registration from before 2.36.10) an edit that changes
    // their data needs the personal-data tick, which is then recorded. Revoked people are not asked: a written «no»
    // is not overridden by a verbal tick. Returns whether to record the verbal authorization after the write.
    async function assertEditAuthorizations(inscriptionId, body, changesData) {
        const auth = await consent.authorizationOf(inscriptionId);
        const b = body || {};
        if ((b.general_verbal_consent === false && auth.general) || (b.health_verbal_consent === false && auth.health)) {
            const e = httpError(409, 'Esta autorización ya está registrada: no se quita editando la inscripción. Para retirarla, usa «Revocar» en Autorizaciones.');
            e.field = b.general_verbal_consent === false && auth.general ? 'general_verbal_consent' : 'health_verbal_consent';
            throw e;
        }
        if (auth.general || auth.revoked) return false;
        if (b.general_verbal_consent === true) return true;
        if (changesData) assertGeneralVerbal(true, b);
        return false;
    }
    // 2.36.10: one «Historial» row (kind created / edited), with the names of the fields an edit changed.
    async function recordHistory(conferenceId, inscriptionId, kind, actor, via, fields = []) {
        try {
            await db.run(`INSERT INTO ${T.history} (conference_id, inscription_id, kind, actor, via, at_utc, fields) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [conferenceId, inscriptionId, kind, actor ? String(actor).slice(0, 120) : null, via, new Date().toISOString().slice(0, 19).replace('T', ' '), JSON.stringify(fields)]);
        } catch (e) { console.warn('[conference-manager] history not recorded:', e && e.message); }
    }
    async function consentGeneralEntered(inscriptionId, actor, via) {
        try {
            const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [inscriptionId]);
            if (ins) await consent.generalVerbalEntered(ins, { actor, via });
        } catch (e) { console.warn('[conference-manager] verbal authorization not logged:', e && e.message); }
    }
    async function consentHealthEntered(inscriptionId, actor, via, healthIn) {
        try {
            const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [inscriptionId]);
            if (ins) await consent.healthEntered(ins, { actor, via, verbal: !!healthIn.verbal, cleared: healthIn.answer === null });
        } catch (e) { console.warn('[conference-manager] health entry not logged:', e && e.message); }
    }
    // …and get the link right after it (a mail failure never undoes the registration).
    async function askConsent(inscriptionId, actor, via) {
        try {
            const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [inscriptionId]);
            // No e-mail (2.35.0): nothing to send; the screens offer «Copiar mensaje» and the paper sheet.
            if (!await consent.hasEmail(ins)) return { state: 'pending', sent: false, email_masked: '', no_email: true };
            const r = await consent.issueLink(ins, { actor, via, httpError, force: true });
            return { state: r.state, sent: r.sent, email_masked: r.email_masked };
        } catch (e) {
            console.warn('[conference-manager] consent link not created:', e && e.message);
            return { state: 'pending', sent: false, email_masked: '' };
        }
    }
    // «Turnos de comida» (2.32.0). Group writes are read-then-write: serialised in this process.
    let priorityLock = Promise.resolve();
    const withPriorityLock = (fn) => {
        const run = priorityLock.then(fn, fn);
        priorityLock = run.then(() => {}, () => {});
        return run;
    };
    mealPriority.install({
        http, allow, allowAny, hasLevel, positiveInt, sendError, httpError, actorOf, runBatched, isFieldColumn,
        entitlementFrom, withPriorityLock,
        // 2.36.10: the model scores only the answers whose health authorization is live (see consentedAnswersOf).
        healthAnswersOfConference: consentedAnswersOfConference,
        // 2.36.5: a called group's phones (the boarding notices' Web Push).
        pushToPeople: (ids, payloadFor) => push.pushToPeople(ids, payloadFor),
        // Names for the groups list: the meals section's own (name fallback included), live location.
        peopleByIds: async (cid, ids) => {
            const cols = await nameFallbackColumns(cid);
            const rows = await db.all(`${PERSON_SQL.replace(' FROM ', `${nameColumnsSql(cols)} FROM `)} WHERE i.id IN (${ids.map(() => '?').join(', ')})`, ids);
            return rows.map(r => personOf(r, cols));
        },
    });
    // GET /qr-link?conference_id → { prefix } — what the admin's code viewer and the Excel QR column put before
    // a code (null = the bare code). inscriptions:view, like the codes themselves.
    http.route('get', '/qr-link', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'inscriptions', 'view')) return;
        try {
            const cid = positiveInt(req.query.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            await badges.ensureReady();
            res.json({ prefix: await selfLinkPrefix(cid) });
        } catch (e) { sendError(res, e); }
    });
    // The portal's feature flags (/portal/login, /portal/me): fee payments' and badges', merged — two spreads
    // that both set `features` would overwrite each other.
    const portalFeaturesOf = async (location) => {
        const f = await fees.portalFeatures(location), b = await badges.portalFeatures(location);
        const out = { ...f, ...b };
        // No flag at all when neither has one: a portal without «Pagos de cuotas» keeps its older flow.
        if (f.features || b.features) out.features = { ...(f.features || {}), ...(b.features || {}) };
        else delete out.features;
        return out;
    };

    // The pre-2.18 payment routes stay, as thin wrappers over the payment model, for any client still on
    // them. They name ONE person (or one part): a payment shared with others answers 409 `shared`. The part
    // routes check that (and the status) BEFORE the payments lock, so they hand the operation the
    // { status, alloc_gen } they inspected as `expected`: a payment re-split meanwhile (now shared) or
    // changed answers 409 `stale` instead of being validated / rejected / deleted unseen.
    const feesReady = async (res) => {
        if (await fees.ensureReady()) return true;
        res.status(503).json({ error: fees.MSG.unavailable, code: 'unavailable' });
        return false;
    };
    const inspected = (of) => ({ status: of.header.status, alloc_gen: Number(of.header.alloc_gen) });
    // POST /inscriptions/:id/payments { amount, method, reference?, proof?, paid_on?, note? } → a 1-person
    // payment, left 'pending' as before (the receipt is optional for cash, D-P12; never over what is owed).
    http.route('post', '/inscriptions/:id/payments', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        if (!await feesReady(res)) return;
        try {
            const iid = positiveInt(req.params.id);
            const ins = iid ? await db.get(`SELECT id, conference_id FROM ${T.inscriptions} WHERE id = ?`, [iid]) : null;
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            const body = req.body || {};
            const input = fees.parseBody({ ...body, allocations: [{ inscription_id: ins.id, amount: body.amount }], leave_pending: body.leave_pending === undefined ? true : body.leave_pending });
            const r = await fees.createTransfer({ via: 'admin', conferenceId: ins.conference_id, actor: actorOf(req) }, input);
            res.json({ success: true, id: r.id, transfer_id: r.id });
        } catch (e) { fees.sendFeeError(res, e); }
    });
    http.route('delete', '/payments/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        if (!await feesReady(res)) return;
        try {
            const of = await fees.paymentOfPart(positiveInt(req.params.id));
            if (!of) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (of.people > 1) throw fees.sharedError(of.people);
            if (of.header.status === 'validated') return res.status(409).json({ error: 'Un pago validado no se puede eliminar; recházalo primero.', code: 'validated_delete' });
            await fees.deleteTransfer({ via: 'admin', actor: actorOf(req) }, of.header.id, inspected(of));
            res.json({ success: true });
        } catch (e) { fees.sendFeeError(res, e); }
    });
    // Validate / reject a 1-person payment by its part id (admin gate). Only VALIDATED money counts toward
    // amount_paid. The reject reason is optional here (the new routes require it).
    http.route('post', '/payments/:id/validate', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        if (!await feesReady(res)) return;
        try {
            const of = await fees.paymentOfPart(positiveInt(req.params.id));
            if (!of) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (of.people > 1) throw fees.sharedError(of.people);
            if (of.header.status === 'validated') return res.status(409).json({ error: 'El pago ya está validado.', code: 'invalid_transition' });
            const allowRef = [true, 1, '1'].includes((req.body || {}).allow_duplicate_reference);
            await fees.transition({ via: 'admin', actor: actorOf(req) }, of.header.id, 'validate', { legacy: true, expected: inspected(of), allowDuplicateReference: allowRef });
            res.json({ success: true, status: 'validated', transfer_id: of.header.id });
        } catch (e) { fees.sendFeeError(res, e); }
    });
    http.route('post', '/payments/:id/reject', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        if (!await feesReady(res)) return;
        try {
            const of = await fees.paymentOfPart(positiveInt(req.params.id));
            if (!of) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (of.people > 1) throw fees.sharedError(of.people);
            if (of.header.status === 'rejected') return res.status(409).json({ error: 'El pago ya está rechazado.', code: 'invalid_transition' });
            await fees.transition({ via: 'admin', actor: actorOf(req) }, of.header.id, 'reject', { legacy: true, note: (req.body || {}).note, expected: inspected(of) });
            res.json({ success: true, status: 'rejected', transfer_id: of.header.id });
        } catch (e) { fees.sendFeeError(res, e); }
    });

    // A person's payment parts (newest first) with their payment's summary and EFFECTIVE status — no receipt
    // images (`has_proof` + GET /fee-payments/:id/proof); `with_proof=1` adds them, for payments:view only.
    // A role with Inscripciones but without Pagos › ver (D-P20: payment data belongs to Pagos) reads each part's
    // amount, date, method and status only — never the payment it is part of (its number, size, people), its
    // reference, its receipt or its review (note, reviewer): the twin of DELETE /inscriptions/:id's generic 409
    // (2.18.0 review R6-L1).
    http.route('get', '/inscriptions/:id/payments', { auth: true }, async (req, res) => {
        const perms = await allowAny(req, res, [['payments', 'view'], ['inscriptions', 'view']]);
        if (!perms) return;
        try {
            const iid = positiveInt(req.params.id);
            if (!iid) return res.json([]);
            const full = hasLevel(perms, 'payments', 'view');
            const withProof = String((req.query || {}).with_proof || '') === '1' && full;
            const list = await fees.partsOfPerson(iid, withProof);
            res.json(full ? list : list.map(fees.briefPart));
        } catch (e) { sendError(res, e); }
    });

    // === REPORTS ===
    // Aggregate roster stats for the Reports dashboard (counts, money, per-location breakdown).
    http.route('get', '/reports/summary', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'reports', 'view')) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // 2.18.0: the money and the counts follow ONE per-person model — «Pagos de cuotas» › Resumen's and
            // the Dashboard's (fees.reportFigures): a cancelled person owes nothing, validated / pending money
            // counts up to the fee, «Saldo pendiente» (due − paid) is Por validar + Por cobrar; the counts are
            // the roster pills of ACTIVE people (cancelled apart). One read of the people with their LIVE money
            // (fees.PERSON_MONEY — one derived table of this conference, bound first).
            const people = await db.all(`
                SELECT i.id, COALESCE(NULLIF(i.location, ''), '—') as location, i.status, i.total_due, i.payment_status,
                       COALESCE(m.validated, 0) as validated, COALESCE(m.pending, 0) as pending, COALESCE(m.returned, 0) as returned
                FROM ${T.inscriptions} i LEFT JOIN ${fees.PERSON_MONEY} m ON m.iid = i.id WHERE i.conference_id = ?`, [conference_id, conference_id]);
            const fig = fees.reportFigures(people);
            const rooms = await db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN room_id IS NOT NULL THEN 1 ELSE 0 END) as assigned_count
                FROM ${T.inscriptions} WHERE conference_id = ?`, [conference_id]);
            const totals = { ...fig.totals, total: Number(rooms && rooms.total) || 0, assigned_count: Number(rooms && rooms.assigned_count) || 0 };
            const byLocation = fig.byLocation;
            // The gender breakdown exists only while the form has a «Género» field (column `gender`); without
            // one it is [] and the report hides it, instead of a single «—» bar for everybody.
            const genderField = await db.get(`SELECT id FROM ${T.fields} WHERE conference_id = ? AND name = 'gender'`, [conference_id]);
            const byGender = !genderField ? [] : await db.all(`
                SELECT COALESCE(NULLIF(gender, ''), '—') as gender, COUNT(*) as count
                FROM ${T.inscriptions} WHERE conference_id = ? GROUP BY COALESCE(NULLIF(gender, ''), '—')`, [conference_id]);
            res.json({ totals, byLocation, byGender });
        } catch (e) { sendError(res, e); }
    });

    // CSV roster export — honors the same filters as GET /inscriptions.
    http.route('get', '/inscriptions/export', { auth: true }, async (req, res) => {
        const perms = await allowAny(req, res, [['reports', 'view'], ['inscriptions', 'view']]);
        if (!perms) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Columns follow the form: one per defined field (its label), then payment + lodging.
            const flds = await db.all(`SELECT name, label, sort_order FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            // The ID document's column only for inscriptions:view (maskDocument).
            const safeFlds = flds.filter(f => isFieldColumn(f.name) && (canSeeDocuments(perms) || f.name !== DOCUMENT_COLUMN));

            let query = `
                SELECT i.*, r.room_number, h.name as hotel_name, ${fees.personSum('pending', 'i.id')} as pending_amount
                FROM ${T.inscriptions} i
                LEFT JOIN ${T.rooms} r ON i.room_id = r.id
                LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id
                WHERE i.conference_id = ?`;
            const params = [conference_id];
            query += await inscriptionFilters(req.query, params, perms);
            query += ROSTER_ORDER;
            const rows = await withHealthText(await db.all(query, params), conference_id, perms);
            // «Condiciones de salud» (2.32.0): its column, in form order, for health:view only.
            const healthCol = canSeeHealth(perms) ? flds.find(f => f.name === HEALTH_FIELD) : null;
            if (healthCol) safeFlds.splice(flds.filter(f => safeFlds.includes(f) && f.sort_order <= healthCol.sort_order).length, 0, healthCol);

            const MONEY_COLS = new Set(['total_due', 'amount_paid', 'pending_amount']);
            // The Código column (barcode payload) only for inscriptions:view. «Por validar» (2.18.0) = fee money
            // registered and still awaiting the admin's validation.
            const cols = [
                ...safeFlds.map(f => [f.name, f.label || f.name]),
                ...(canSeeRegCodes(perms) ? [['reg_code', 'Código']] : []), ['status', 'Estado'], ['payment_status', 'Pago'],
                ['total_due', 'Cuota'], ['amount_paid', 'Pagado'], ['pending_amount', 'Por validar'],
                ['hotel_name', 'Hotel'], ['room_number', 'Habitación'],
            ];
            const esc = (v) => {
                let s = v === null || v === undefined ? '' : String(v);
                // Neutralize spreadsheet formula injection — attendee fields come from the portal form.
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const cell = (r, c) => MONEY_COLS.has(c[0]) ? roundMoney(r[c[0]]).toFixed(2) : r[c[0]];
            const header = cols.map(c => esc(c[1])).join(',');
            const body = rows.map(r => cols.map(c => esc(cell(r, c))).join(',')).join('\r\n');
            const csv = '﻿' + header + '\r\n' + body; // BOM so Excel reads UTF-8

            // NOTE: the sandbox's res.send() JSON-encodes string bodies (quotes + escaped newlines),
            // which corrupts raw CSV. Return the CSV as a JSON field and let the client build the file.
            res.json({ csv, filename: `inscripciones-${conference_id}.csv`, count: rows.length });
        } catch (e) { sendError(res, e); }
    });

    // One roster row (2.18.0) — exactly a row of GET /inscriptions (same SELECT, same gate, the same reg_code
    // masking), so a page patches one person after an action instead of reloading the whole roster.
    // Registered AFTER /inscriptions/export: a `/inscriptions/:id` route registered before it would capture
    // «export». A non-integer id is 404.
    http.route('get', '/inscriptions/:id', { auth: true }, async (req, res) => {
        const perms = await allowAny(req, res, ROSTER_ACCESS);
        if (!perms) return;
        try {
            const id = positiveInt(req.params.id);
            const row = id ? await db.get(`${rosterSelect()} WHERE i.id = ?`, [id]) : null;
            if (!row) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            res.json((await withHealthText([rosterRow(row, perms)], row.conference_id, perms))[0]);
        } catch (e) { sendError(res, e); }
    });

    // 2.36.10: «Historial» of one person — who registered them and how, every edit (the fields' NAMES, never their
    // values), the withdrawals and restores, and the authorization events (never an answer, e-mail or document).
    // Health events and the health field's edits only for health:view; the coordinators' portal never sees them,
    // nor «Notas internas», nor an administrator's login («Administración» instead). `legacy`: registered before
    // 2.36.10, so who registered them is unknown («Sin registro»).
    async function historyEntries(ins, { seesHealth, portal }) {
        const fields = await db.all(`SELECT name, label FROM ${T.fields} WHERE conference_id = ?`, [ins.conference_id]);
        const labelOf = new Map(fields.map(f => [f.name, f.label]));
        const NAMED = { status: 'Estado', location: 'Localidad', notes: 'Notas internas', [HEALTH_FIELD]: labelOf.get(HEALTH_FIELD) || 'Datos de salud' };
        const iso = (s) => (s && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s || null);
        const who = (actor) => (!portal || !actor || String(actor).startsWith('portal:') ? (actor || null) : 'admin');
        const hidden = new Set([...(seesHealth && !portal ? [] : [HEALTH_FIELD]), ...(portal ? ['notes'] : [])]);
        const out = [];
        for (const r of await db.all(`SELECT kind, actor, via, at_utc, fields FROM ${T.history} WHERE inscription_id = ? ORDER BY id`, [ins.id])) {
            let names = [];
            try { names = JSON.parse(r.fields || '[]'); } catch { /* none */ }
            const shown = names.filter(n => !hidden.has(n)).map(n => labelOf.get(n) || NAMED[n] || n);
            if (r.kind === 'edited' && !shown.length) continue; // only what this viewer may not see changed
            out.push({ kind: r.kind, at: iso(r.at_utc), actor: who(r.actor), via: r.via || null, fields: shown });
        }
        for (const r of await db.all(`SELECT kind, actor, at_utc, reason FROM ${T.withdrawals} WHERE inscription_id = ? ORDER BY id`, [ins.id])) {
            out.push({ kind: r.kind === 'restore' ? 'restored' : 'withdrawn', at: iso(r.at_utc), actor: who(r.actor), reason: r.reason || null });
        }
        if (await consent.ensureReady()) {
            for (const e of await consent.historyOf(ins.id)) {
                if (e.scope === 'health' && (portal || !seesHealth)) continue;
                out.push({ ...e, kind: `consent_${e.kind}`, actor: who(e.actor) });
            }
        }
        // By time (the history rows have whole seconds, the authorization log milliseconds: compared as times, not
        // text); within the same second the registration comes first.
        const ms = (e) => { const t = Date.parse(e.at || ''); return Number.isFinite(t) ? Math.floor(t / 1000) : 0; };
        out.sort((a, b) => ms(a) - ms(b) || (a.kind === 'created' ? -1 : b.kind === 'created' ? 1 : 0));
        return { entries: out, legacy: !out.some(e => e.kind === 'created'), registered_at: ins.registration_date || null };
    }
    http.route('get', '/inscriptions/:id/history', { auth: true }, async (req, res) => {
        const perms = await allow(req, res, 'inscriptions', 'view');
        if (!perms) return;
        try {
            const id = positiveInt(req.params.id);
            const ins = id ? await db.get(`SELECT id, conference_id, registration_date FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            res.json(await historyEntries(ins, { seesHealth: canSeeHealth(perms), portal: false }));
        } catch (e) { sendError(res, e); }
    });

    // GET /inscriptions/:id/health → { field, answer } — the answer as the edit form needs it (health:view). The
    // field is null when the form has no «Condiciones de salud»; the answer null when the person gave none.
    http.route('get', '/inscriptions/:id/health', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'health', 'view')) return;
        try {
            const id = positiveInt(req.params.id);
            const ins = id ? await db.get(`SELECT id, conference_id FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            const field = await health.fieldOf(ins.conference_id);
            // 2.36.10: the same consent filter as the roster: a pending or revoked authorization shows no answer.
            const answer = field ? ((await consentedAnswersOf(ins.conference_id, [id])).get(id) || null) : null;
            // 2.34.0: entering an answer needs the person's verbal authorization until they authorize health in writing.
            // 2.36.10: not while a verbal authorization is live either (the form shows no tick then).
            const verbalRequired = !!field && await consent.isEnabled(ins.conference_id) && !await consent.healthAllowed(ins.conference_id, id) && !await consent.healthRefused(id);
            res.json({ field: field ? { name: field.name, label: field.label } : null, answer, verbal_required: verbalRequired });
        } catch (e) { sendError(res, e); }
    });

    // === ASSIGNMENT RULES ===
    http.route('get', '/assignment/rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'view')) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // The admin's conference rules only; a location's own rules travel with its lodging view.
            // `?all=1` adds every location's own rules, each with its `location_name` — what «Campos» needs
            // to say which rules deleting a field switches off, the coordinators' included.
            if (req.query.all === '1' || req.query.all === 'true') {
                const all = await db.all(
                    `SELECT r.*, l.name AS location_name FROM ${T.rules} r LEFT JOIN ${T.locations} l ON l.id = r.location_id WHERE r.conference_id = ? ORDER BY r.priority DESC, r.id ASC`, [conference_id]);
                return res.json(all);
            }
            const list = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND location_id IS NULL ORDER BY priority DESC, id ASC`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    const RULE_TYPES = new Set(['keep_together', 'separate_by', 'split_by', 'require_companion']);
    // Two rules that apply together may not share a priority (2.21.0; the owner: «dos reglas no pueden tener el
    // mismo número de prioridad») — the higher number goes first, and a tie used to be broken by age, unseen. A
    // conference rule applies with every location's own rules, so its number may be no other rule's of the
    // conference; a location's rule, no conference rule's and no other of that location's. Checked only when the
    // number is new or changes (a rule saved again as it was — e.g. switched on — is never refused for an older tie).
    async function assertFreePriority({ conferenceId, locationId, ruleId, priority }) {
        if (ruleId) {
            const was = await db.get(`SELECT priority FROM ${T.rules} WHERE id = ?`, [ruleId]);
            if (was && Number(was.priority) === Number(priority)) return;
        }
        const clash = await db.get(locationId == null
            ? `SELECT r.id, r.name, l.name AS location_name FROM ${T.rules} r LEFT JOIN ${T.locations} l ON l.id = r.location_id WHERE r.conference_id = ? AND r.priority = ? AND r.id != ? ORDER BY r.location_id IS NOT NULL, r.id LIMIT 1`
            : `SELECT r.id, r.name, l.name AS location_name FROM ${T.rules} r LEFT JOIN ${T.locations} l ON l.id = r.location_id WHERE r.conference_id = ? AND r.priority = ? AND r.id != ? AND (r.location_id IS NULL OR r.location_id = ?) ORDER BY r.location_id IS NOT NULL, r.id LIMIT 1`,
            locationId == null ? [conferenceId, priority, ruleId || 0] : [conferenceId, priority, ruleId || 0, locationId]);
        if (!clash) return;
        const whose = clash.location_name == null ? (locationId == null ? '' : ' de la administración') : (locationId == null ? ` de la localidad ${clash.location_name}` : '');
        const err = httpError(409, `La prioridad ${priority} ya la usa la regla «${clash.name}»${whose}. Dos reglas no pueden tener la misma prioridad: usa otro número.`);
        err.code = 'priority_taken';
        throw err;
    }
    // The admin's CONFERENCE rules (location_id IS NULL). A location's own rules are the coordinator's
    // (portal) and are never reachable through this route: an `id` of a location rule is a 404.
    http.route('post', '/assignment/rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { id, conference_id, name, type, enabled, priority, config, params, hard } = req.body || {};
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const rule = normalizeRule({ name, type, enabled, priority, config, params, hard }, { conferenceId: conference_id, fieldNames: await ruleFieldNames(conference_id) });
            const paramsStr = JSON.stringify(rule.params);
            await assertFreePriority({ conferenceId: conference_id, locationId: null, ruleId: positiveInt(id), priority: rule.priority });
            if (id) {
                // Verify the rule belongs to the specified conference before updating.
                const existing = await db.get(`SELECT conference_id, location_id FROM ${T.rules} WHERE id = ?`, [id]);
                if (!existing || existing.location_id != null) return res.status(404).json({ error: 'Regla no encontrada.' });
                if (String(existing.conference_id) !== String(conference_id)) {
                    return res.status(403).json({ error: 'La regla no pertenece a esta conferencia.' });
                }
                await db.run(
                    `UPDATE ${T.rules} SET name = ?, type = ?, enabled = ?, priority = ?, config = ?, params = ?, hard = ? WHERE id = ? AND location_id IS NULL`,
                    [rule.name, rule.type, rule.enabled, rule.priority, rule.config, paramsStr, rule.hard, id]
                );
            } else {
                const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [conference_id]);
                if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                await db.run(
                    `INSERT INTO ${T.rules} (conference_id, name, type, enabled, priority, config, params, hard, location_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
                    [conference_id, rule.name, rule.type, rule.enabled, rule.priority, rule.config, paramsStr, rule.hard]
                );
            }
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/assignment/rules/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const r = id ? await db.run(`DELETE FROM ${T.rules} WHERE id = ? AND location_id IS NULL`, [id]) : null;
            if (!r || !r.changes) return res.status(404).json({ error: 'Regla no encontrada.' });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // Clears every room of the conference EXCEPT those of frozen locations (their arrangement is under
    // review or validated: a bulk reset must not empty it as a side effect); those are listed in
    // `skipped_frozen` so the admin knows — they are adjusted one change at a time, or reopened.
    //
    // 2.36.6 (the owner: «Limpiar todas las asignaciones» left the rooms reserved for the locations): it also frees the
    // rooms and beds «Sugerir reparto» gave to locations (allot_source 'plan'), so the next assignment starts from
    // scratch; the ones the admin reserved by hand ('manual', and every allotment made before 2.36.6) only with
    // `release_manual: true` (the confirmation's checkbox, unticked by default). Never a frozen location's, a blocked
    // room's, nor a room still holding someone the administration fixed. `preview: true` answers the counts the
    // confirmation shows and changes nothing. Every reset is a row of lodging_resets (who, when, what it freed).
    http.route('post', '/assignment/reset', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const preview = req.body.preview === true, releaseManual = req.body.release_manual === true;
        try {
            // Serialize with runs so a reset can't interleave with an in-flight assignment.
            const out = await withAssignmentLock(async () => {
                const frozen = await db.all(`SELECT id, name, lodging_status FROM ${T.locations} WHERE conference_id = ? AND ${frozenSql} ORDER BY name`, [conference_id]);
                // Nobody the administration fixed, nor anyone in a blocked room (see «HELD BY THE ADMINISTRATION»).
                const whoSql = `conference_id = ? AND room_id IS NOT NULL AND (location_id IS NULL OR location_id NOT IN (SELECT id FROM ${T.locations} WHERE ${frozenSql} )) AND ${NOT_HELD_SQL()}`;
                const people = Number((await db.get(`SELECT COUNT(*) AS n FROM ${T.inscriptions} WHERE ${whoSql}`, [conference_id])).n) || 0;
                // The allotments that may go: of this conference's rooms, to a location that is not frozen, in a room that
                // is not blocked and holds nobody once the people above are out (a fixed person keeps their room's).
                const kept = `(SELECT room_id FROM ${T.inscriptions} WHERE conference_id = ? AND room_id IS NOT NULL AND NOT (${whoSql.replace('conference_id = ? AND ', '')}))`;
                const scope = (col) => `${col} IN (SELECT r.id FROM ${T.rooms} r JOIN ${T.hotels} h ON h.id = r.hotel_id WHERE h.conference_id = ? AND COALESCE(r.blocked, 0) = 0) AND ${col} NOT IN ${kept}`;
                const freeLoc = `NOT IN (SELECT id FROM ${T.locations} WHERE ${frozenSql} )`;
                const PLAN = `allot_source = 'plan'`, MANUAL = `(allot_source IS NULL OR allot_source <> 'plan')`;
                const roomsWhere = (src) => `location_id IS NOT NULL AND location_id ${freeLoc} AND ${src} AND ${scope('id')}`;
                const bedsWhere = (src) => `location_id ${freeLoc} AND ${src} AND ${scope('room_id')}`;
                const args = [conference_id, conference_id];
                const count = async (src) => (Number((await db.get(`SELECT COUNT(*) AS n FROM ${T.rooms} WHERE ${roomsWhere(src)}`, args)).n) || 0)
                    + (Number((await db.get(`SELECT COUNT(*) AS n FROM ${T.roomBeds} WHERE ${bedsWhere(src)}`, args)).n) || 0);
                const plan = await count(PLAN), manual = await count(MANUAL);
                const skipped = frozen.map(l => ({ location_id: l.id, name: l.name, status: lodgingStatusOf(l) }));
                if (preview) return { people, plan_allotments: plan, manual_allotments: manual, skipped_frozen: skipped };
                await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE ${whoSql}`, [conference_id]);
                const release = async (src) => {
                    await db.run(`UPDATE ${T.rooms} SET location_id = NULL, allot_source = NULL, share_lock = NULL WHERE ${roomsWhere(src)}`, args);
                    await db.run(`DELETE FROM ${T.roomBeds} WHERE ${bedsWhere(src)}`, args);
                };
                await release(PLAN);
                if (releaseManual) await release(MANUAL);
                await db.run(STALE_LOCKS_SQL());
                await db.run(`INSERT INTO ${T.lodgingResets} (conference_id, actor, at_utc, people, plan_released, manual_released, manual_kept) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, actorOf(req), new Date().toISOString().slice(0, 19).replace('T', ' '), people, plan, releaseManual ? manual : 0, releaseManual ? 0 : manual]);
                // `status` as in the run's report: the admin panel names it («ya está validado» / «está enviado…»).
                return { people, plan_released: plan, manual_released: releaseManual ? manual : 0, manual_kept: releaseManual ? 0 : manual, skipped_frozen: skipped };
            });
            res.json({ success: true, ...out });
        } catch (e) { sendError(res, e); }
    });

    // Conference-wide run: the pool scope plus every delegated location that is not frozen (see
    // runAssignment). Returns totals + by_location + skipped_frozen (each with its `unassigned`) +
    // skipped_unassigned.
    http.route('post', '/assignment/run', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Mutex: two concurrent runs (or a run racing a manual assign/reset) would double-book.
            const result = await withAssignmentLock(() => runAssignment(conference_id));
            res.json({ success: true, ...result });
        } catch (e) { sendError(res, e); }
    });

    // «Sugerir reparto» (2.20.0, see planOnSnapshot): POST /assignment/plan { conference_id, replan?, share?,
    // hotel_id? } answers the suggestion — nothing is written; POST /assignment/plan/apply { …, token } plans
    // again under the lock and writes it — the allotments and the people it places, then the automatic assignment for
    // whoever is still without a bed — only when it is still the plan the admin saw (409 plan_changed with the new
    // one otherwise) and never when it is worse than today (409 plan_worse). Hospedaje › gestionar.
    // `fresh` (2.21.0): the whole arrangement thought again — see planOnSnapshot.
    const planOptionsOf = (b) => {
        const off = (v) => v === false || v === 0 || v === '0' || v === 'false';
        const on = (v) => v === true || v === 1 || v === '1' || v === 'true';
        return { replan: !off(b.replan), share: !off(b.share), hotelId: positiveInt(b.hotel_id), fresh: on(b.fresh), divideFamilies: on(b.divide_families) };
    };
    const planConference = async (req, res) => {
        const cid = positiveInt((req.body || {}).conference_id);
        if (!cid) { res.status(400).json({ error: 'Missing conference_id' }); return null; }
        if (!await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid])) { res.status(404).json({ error: 'Conferencia no encontrada.' }); return null; }
        const hotelId = positiveInt((req.body || {}).hotel_id);
        if (hotelId && !await db.get(`SELECT id FROM ${T.hotels} WHERE id = ? AND conference_id = ?`, [hotelId, cid])) { res.status(400).json({ error: 'Hotel no encontrado en esta conferencia.' }); return null; }
        return cid;
    };
    // The locations' order for «Sugerir reparto» when the beds do not reach everyone (2.21.0): { conference_id,
    // location_ids } — that order first; a location left out goes after them, by name. Hospedaje › gestionar.
    http.route('post', '/assignment/location-order', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const cid = positiveInt((req.body || {}).conference_id);
        const ids = (req.body || {}).location_ids;
        if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
        if (!Array.isArray(ids) || ids.length > 2000) return res.status(400).json({ error: 'location_ids debe ser una lista de localidades.' });
        try {
            const mine = new Set((await db.all(`SELECT id FROM ${T.locations} WHERE conference_id = ?`, [cid])).map(l => Number(l.id)));
            const list = [...new Set(ids.map(Number))];
            if (list.some(id => !mine.has(id))) return res.status(400).json({ error: 'Localidad inválida.' });
            await runBatched([[`UPDATE ${T.locations} SET lodging_order = NULL WHERE conference_id = ?`, [cid]],
                ...list.map((id, i) => [`UPDATE ${T.locations} SET lodging_order = ? WHERE id = ? AND conference_id = ?`, [i + 1, id, cid]])]);
            res.json({ success: true, location_ids: list });
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/assignment/plan', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const cid = await planConference(req, res);
            if (!cid) return;
            const plan = await withAssignmentLock(async () => planOnSnapshot(await loadAssignmentSnapshot(cid), planOptionsOf(req.body || {})));
            res.json({ success: true, plan });
        } catch (e) { sendError(res, e); }
    });
    http.route('post', '/assignment/plan/apply', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const cid = await planConference(req, res);
            if (!cid) return;
            const token = typeof (req.body || {}).token === 'string' ? req.body.token : '';
            if (!token) return res.status(400).json({ error: 'Falta la sugerencia que quieres aplicar.' });
            const out = await withAssignmentLock(async () => {
                const plan = await planOnSnapshot(await loadAssignmentSnapshot(cid), planOptionsOf(req.body || {}));
                if (plan.token !== token) return { stale: true, plan };
                // Never what would leave the people worse off than today (more hard rules broken, more without a bed).
                if (plan.worse) return { worse: true, plan };
                // «Rehacer todo»: the people the plan moves leave their beds first (only those still in them).
                if (plan.moved_ids.length) await runBatched(plan.moved_ids.map(x => [`UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE id = ? AND room_id = ?`, [x.inscription_id, x.room_id]]));
                await applyPlanChanges(plan.changes, plan.placements);
                // Then the automatic assignment for whoever is still without a bed — the arrangement the plan measured.
                const run = await runAssignment(cid);
                return { plan, run };
            });
            if (out.worse) return res.status(409).json({ error: 'Esta sugerencia dejaría a las personas peor que el reparto actual; no se aplica.', code: 'plan_worse', plan: out.plan });
            if (out.stale) return res.status(409).json({ error: 'Algo cambió desde que se calculó la sugerencia (inscripciones, habitaciones o repartos). Revisa la nueva antes de aplicarla.', code: 'plan_changed', plan: out.plan });
            res.json({ success: true, changed: out.plan.changes.length, placed: out.plan.placements.length, run_placed: out.run.assignedCount, remaining: out.run.remaining, plan: out.plan });
        } catch (e) { sendError(res, e); }
    });
    // What the automatic assignment WOULD do now (2.20.0) — the run on a copy; nothing is written. Its report,
    // and every bed it would change (`from_room_id` null = a new placement).
    http.route('post', '/assignment/simulate', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'view')) return;
        try {
            const cid = await planConference(req, res);
            if (!cid) return;
            const out = await withAssignmentLock(async () => {
                const snap = await loadAssignmentSnapshot(cid);
                const { result, snap: after } = await simulateSweep(snap);
                const was = new Map(snap.people.map(p => [p.id, p.room_id]));
                // Everyone whose bed changes: a new placement, or a move (the hard companion repair moves people who had a bed).
                const placements = after.people.filter(p => p.room_id !== was.get(p.id)).map(p => ({ inscription_id: p.id, room_id: p.room_id, from_room_id: was.get(p.id) ?? null }));
                return { ...result, placements };
            });
            res.json({ success: true, ...out });
        } catch (e) { sendError(res, e); }
    });

    /**
     * Helper: Run Auto-Assignment Logic
     */
    // A predicate is { field, op, value }; a condition is an array of predicates AND-ed together. This
    // mirrors feeRuleMatches so the assignment rules speak the same language as the pricing rules.
    function attrMatches(pred, getVal) {
        const field = pred && pred.field;
        const op = (pred && pred.op) || 'eq';
        if (!field || op === 'any') return true;
        const raw = getVal(field);
        if (op === 'filled') return raw != null && String(raw).trim() !== '';
        if (op === 'empty') return raw == null || String(raw).trim() === '';
        const a = raw == null ? '' : String(raw).trim();
        const b = (pred && pred.value) == null ? '' : String(pred.value).trim();
        switch (op) {
            case 'eq': return a.toLowerCase() === b.toLowerCase();
            case 'neq': return a.toLowerCase() !== b.toLowerCase();
            case 'contains': return a.toLowerCase().includes(b.toLowerCase());
            case 'gt': return Number(a) > Number(b);
            case 'gte': return Number(a) >= Number(b);
            case 'lt': return Number(a) < Number(b);
            case 'lte': return Number(a) <= Number(b);
            default: return false;
        }
    }
    // ONE implementation of "an attendee's value of a rule field" and "a condition holds for an
    // attendee", shared by the engine and by auditArrangement. The custom_data fallback keeps legacy
    // rows (values not yet backfilled into a real column) visible to the rules; it is safe because
    // normalizeRule only lets a rule name a defined field or a base column.
    function ruleVal(p, f) {
        return (p[f] !== undefined && p[f] !== null && p[f] !== '') ? p[f] : (p.custom_data && typeof p.custom_data === 'object' ? p.custom_data[f] : undefined);
    }
    function condMatches(preds, p) {
        return !Array.isArray(preds) || preds.length === 0 || preds.every(pr => attrMatches(pr, (f) => ruleVal(p, f)));
    }
    // Distinct non-blank, case-folded values of `field` across `people`.
    const distinctValues = (people, field) => {
        const seen = new Map();
        for (const p of people) { const v = ruleVal(p, field); if (v != null && String(v).trim() !== '') { const k = String(v).trim().toLowerCase(); if (!seen.has(k)) seen.set(k, String(v).trim()); } }
        return [...seen.values()];
    };
    // FIRST MATCH. Rules are consulted in priority order (priority DESC, then id ASC = the older rule) and
    // the first one that applies to a person wins a conflict: a family kept together by a keep_together
    // rule that outranks a separate_by rule may mix that rule's field — in a room of its own: nobody from outside
    // joins a family's mixed room (judgedBy, 2.21.0); a separate_by rule that outranks the family rule divides the family
    // and the family rule says nothing about that division. `rank` = the rule's index in that order.
    const rankRules = (rules) => [...rules]
        .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0))
        .map((r, i) => ({ ...r, rank: i }));
    // The members of a room composition a separate_by rule judges: all of them, unless every two of them with
    // different values are of the same family (the same value of an outranking keep_together rule, `when`
    // honoured) — then nobody (`[]`): a family's mixed room is the family's alone (2.21.0; the owner: «si se
    // agrupa una familia en una habitación mixta no se pueda añadir a nadie más que no sea del grupo familiar»).
    // Before, the family was left out and only the others were compared among themselves, so a woman from outside
    // could join a room with a family's men, or a man a women-only family's room. A room with a single value is
    // judged as before (anyone of that value may complete it).
    const sameFamily = (a, b, keepRules) => keepRules.some(k => {
        if (!k.field || !condMatches(k.params.when, a) || !condMatches(k.params.when, b)) return false;
        const va = ruleVal(a, k.field), vb = ruleVal(b, k.field);
        if (va == null || vb == null) return false;
        const ka = String(va).trim().toLowerCase();
        return ka !== '' && ka === String(vb).trim().toLowerCase();
    });
    const judgedBy = (sepRule, members, keepRules) => {
        const outranking = keepRules.filter(k => k.rank < sepRule.rank);
        if (!outranking.length) return members;
        const keyOf = (p) => { const v = ruleVal(p, sepRule.field); return v == null ? '' : String(v).trim().toLowerCase(); };
        const valued = members.filter(m => keyOf(m) !== '');
        for (let i = 0; i < valued.length; i++) {
            for (let j = i + 1; j < valued.length; j++) {
                if (keyOf(valued[i]) !== keyOf(valued[j]) && !sameFamily(valued[i], valued[j], outranking)) return members;
            }
        }
        return [];
    };
    // Companion rules a room's occupants do not satisfy.
    const companionUnmetIn = (companionRules, occupants) => {
        const out = [];
        for (const rule of companionRules) {
            const min = Number(rule.params.min) || 1;
            if (!occupants.some(o => condMatches(rule.params.subject, o))) continue;
            if (occupants.filter(o => condMatches(rule.params.needs, o)).length < min) out.push(rule);
        }
        return out;
    };

    // Composable, priority-ordered, best-effort room assignment. Rule types (all field-generic):
    //   keep_together     — members sharing `field` should share a room (params.min_size, params.when[])
    //   separate_by       — a room holds at most one value of `field` (hard = never mix genders/etc.)
    //   split_by          — when a kept-together group can't fit whole, divide it along `field`
    //   require_companion — a room with an occupant matching params.subject[] needs >= params.min
    //                       occupants matching params.needs[] (e.g. a child needs an adult)
    // `hard` rules are invariants (never violated / best-effort repaired); soft rules are preferences.
    // Optimal constrained assignment is NP-hard, so this is a documented greedy heuristic, run
    // IN-MEMORY (occupancy loaded with one query, placements recorded in a map) with a SINGLE flush of
    // room_id writes through db.batch at the end; cap ASSIGN_MAX_PARTICIPANTS unassigned per run. It
    // RETURNS { assignedCount, remaining, violations[] } naming whatever it could not satisfy — every
    // kept-together group that had to be divided (by a hard separate_by, a split_by or for lack of a
    // room big enough) is reported under its rule's name with that rule's `hard` flag.
    //
    // SCOPES (2.5.0). A run never crosses a scope: the POOL scope is (pool rooms ↔ attendees of no
    // location or of a non-delegated location, conference rules only); a LOCATION scope is (the rooms
    // allotted to L ↔ L's attendees, conference rules ∪ L's own rules). Occupants already in a scope's
    // rooms count for capacity; those outside the scope's participant filter (a foreign stray, a
    // cancelled row) are `fixed` and never moved by the repair pass. `runAssignmentScope` runs ONE
    // scope. OVERFLOW (2.18.0): the conference-wide sweep ends with one pool run PER swept location whose
    // own beds could not hold all its attendees: its participants are that location's leftovers, it fills
    // only pool beds still free after the pool's own attendees (a second pool pass runs first), moves
    // nobody already placed (every occupant is fixed) and applies the conference (admin) rules only — it is
    // the administration's run, not the location's. It never fills a bed of the location's own share: a
    // shared room where that location still has free beds of its own is no overflow target. RULE VIEWS
    // (2.18.0): a location's own rule only ever judges that location's people;
    // a conference require_companion judges the scope location's people in a location scope and everyone
    // in the room in the pool scopes.
    // `runAssignment(conferenceId, { locationId })` runs a location scope when `locationId` is
    // given and, when it is undefined, the admin's conference-wide sweep (pool + every non-frozen
    // delegated location; a frozen one is skipped by decision, not because it is locked — see below).
    // Callers hold withAssignmentLock.
    const ASSIGN_MAX_PARTICIPANTS = 5000;
    // WHERE THE ENGINE READS AND WRITES (2.20.0). The engine below never touches `db` itself: it reads the
    // conference through an `io` — the database (dbAssignmentIo, the default) or an in-memory copy of it
    // (snapshotAssignmentIo) — so «Sugerir reparto» can run the very same code on a hypothetical allotment
    // and know what the automatic assignment WOULD do, without writing anything. Every read is ordered (by id,
    // or by name where the sweep goes in name order; a location's rooms hotel by hotel, the order 2.19 walked
    // them), so a run is deterministic and its simulation identical.
    function dbAssignmentIo(conferenceId) {
        const inRooms = (lid) => (lid == null
            ? { sql: 'r.location_id IS NULL', params: [conferenceId] }
            : { sql: `(r.location_id = ? OR EXISTS (SELECT 1 FROM ${T.roomBeds} b WHERE b.room_id = r.id AND b.location_id = ?))`, params: [conferenceId, lid, lid] });
        return {
            conferenceId,
            rules: (ruleLocation) => (ruleLocation == null
                ? db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND enabled = 1 AND location_id IS NULL ORDER BY priority DESC, id ASC`, [conferenceId])
                : db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND enabled = 1 AND (location_id IS NULL OR location_id = ?) ORDER BY priority DESC, id ASC`, [conferenceId, ruleLocation])),
            companionRules: () => db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND enabled = 1 AND type = 'require_companion' ORDER BY priority DESC, id ASC`, [conferenceId]),
            fieldNames: () => ruleFieldNames(conferenceId),
            delegatedIds: async () => new Set((await db.all(`SELECT DISTINCT location_id FROM ${T.rooms} WHERE location_id IS NOT NULL UNION ${SHARE_LOCATIONS_SQL()}`)).map(r => Number(r.location_id))),
            frozenRows: () => db.all(`SELECT id, name, lodging_status FROM ${T.locations} WHERE conference_id = ? AND ${frozenSql} ORDER BY name`, [conferenceId]),
            delegatedLocations: () => delegatedLocations(conferenceId),
            // A location's attendees still without a bed (also the overflow's participants).
            participants: (lid) => db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND location_id = ? AND room_id IS NULL AND ${occupiedSql()} AND ${lodgingSql()} ORDER BY id`, [conferenceId, lid]),
            // The pool scope's: no location, or a location with no bed of its own that is not frozen.
            poolParticipants: () => db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND room_id IS NULL AND ${occupiedSql()} AND ${lodgingSql()} AND (location_id IS NULL OR location_id NOT IN (SELECT DISTINCT location_id FROM ${T.rooms} WHERE location_id IS NOT NULL )) AND (location_id IS NULL OR location_id NOT IN (${SHARE_LOCATIONS_SQL()} )) AND (location_id IS NULL OR location_id NOT IN (SELECT id FROM ${T.locations} WHERE ${frozenSql} )) ORDER BY id`, [conferenceId]),
            // A scope's rooms: every pool room (null), or a location's whole and shared rooms.
            scopeRooms: (lid) => { const s = inRooms(lid); return db.all(`SELECT r.*, h.name as hotel_name FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? AND ${s.sql} ORDER BY ${lid == null ? 'r.id' : 'h.id, r.id'}`, s.params); },
            scopeOccupants: (lid) => { const s = inRooms(lid); return db.all(`SELECT i.* FROM ${T.inscriptions} i WHERE i.room_id IN (SELECT r.id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? AND ${s.sql} ) ORDER BY i.id`, s.params); },
            shares: (roomIds) => sharesByRoom(roomIds),
            lockFields: () => shareLockFields(conferenceId),
            flush: async (placements) => {
                const writes = [];
                // Never a «Requiere hospedaje: No» (2.31.0), whatever chose them: the write itself refuses.
                for (const [personId, roomId] of placements) writes.push([`UPDATE ${T.inscriptions} SET room_id = ?, room_locked = NULL WHERE id = ? AND ${lodgingSql()}`, [roomId, personId]]);
                await runBatched(writes);
            },
            unassignedByLocation: async (ids) => {
                const out = new Map();
                if (!ids.length) return out;
                const marks = ids.map(() => '?').join(', ');
                const counts = await db.all(
                    `SELECT location_id, COUNT(*) AS n FROM ${T.inscriptions} WHERE conference_id = ? AND room_id IS NULL AND ${occupiedSql()} AND ${lodgingSql()} AND location_id IN (${marks}) GROUP BY location_id`,
                    [conferenceId, ...ids]);
                for (const c of counts) out.set(Number(c.location_id), Number(c.n) || 0);
                return out;
            },
            reportRooms: () => db.all(`SELECT r.id, r.room_number, r.location_id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? ORDER BY h.name, r.room_number, r.id`, [conferenceId]),
            placed: () => db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND room_id IS NOT NULL ORDER BY id`, [conferenceId]),
        };
    }
    // ── the engine's view of the rules and its grouping (2.20.0) ─────────────────────────────────────
    // Lifted out of runAssignmentScope so «Sugerir reparto» groups people exactly as a run does. A scope is the
    // pool (isPool) or one location; `rules` are parsed and ranked (rankRules).
    function scopeRuleContext(rules, { isPool, locationId }) {
        const keepRules = rules.filter(r => r.type === 'keep_together');
        const separateRules = rules.filter(r => r.type === 'separate_by');
        const splitRules = rules.filter(r => r.type === 'split_by');
        const companionRules = rules.filter(r => r.type === 'require_companion');
        const val = ruleVal;
        // Who a rule judges in a room (2.18.0). A location's OWN rule: that location's people only — in a
        // shared or pool room it never reads, nor reacts to, another location's attendees, and it still
        // holds for its people on pool beds (the overflow). A conference require_companion in a LOCATION
        // scope: that location's people (the audit of a location's arrangement judges the same); in the pool
        // scopes, everyone in the room. Every other conference rule: everyone in the room.
        const peopleOf = (lid, list) => list.filter(o => o.location_id != null && Number(o.location_id) === lid);
        const viewFor = (rule, list) => {
            if (rule.location_id != null) return peopleOf(Number(rule.location_id), list);
            if (rule.type === 'require_companion' && !isPool) return peopleOf(Number(locationId), list);
            return list;
        };
        // A merged set (a room's occupants + candidate people) is OK for a HARD separate rule iff it has
        // at most one distinct non-blank value of that rule's field.
        const mergedSeparateOk = (occupants, people) => {
            const after = occupants.concat(people);
            for (const rule of separateRules) {
                if (!rule.hard) continue;
                if (distinctValues(judgedBy(rule, viewFor(rule, after), keepRules), rule.field).length > 1) return false;
            }
            return true;
        };
        const companionUnmet = (occupants) => companionRules.filter(rule => companionUnmetIn([rule], viewFor(rule, occupants)).length > 0);
        const partitionBy = (people, fields) => {
            if (!fields.length) return [people];
            const map = new Map();
            for (const p of people) {
                const key = fields.map(f => { const v = val(p, f); return v == null ? '' : String(v).trim().toLowerCase(); }).join('');
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(p);
            }
            return [...map.values()];
        };

        // The hard separate_by rules that outrank a unit's keep_together rule (every one, for a loner).
        const dividingRules = (group) => separateRules.filter(r => r.hard && (!group || r.rank < group.rule.rank));
        return { keepRules, separateRules, splitRules, companionRules, hardSeparate: separateRules.filter(r => r.hard), softSeparate: separateRules.filter(r => !r.hard), viewFor, mergedSeparateOk, companionUnmet, partitionBy, dividingRules };
    }
    // A scope's people as the engine places them: units, parts, bundled companions and CLASSES (see the
    // packing notes in runAssignmentScope). Returns { classList, units, notes } — `units` are 2.19's placement
    // units (larger first, each with its `parts`, no companion bundled); notes are information, never hard.
    // `maxRoom`: the most beds one room offers — a companion is bundled only while the part still fits one.
    // `splitSoftMixed` (2.21.0): a PREFERRED keep_together group is divided by every hard separate_by (as if they
    // outranked it) — a mixed family then goes as its men and its women, each able to complete a room of their value.
    // true = every such group; a function (unit) → boolean = only those it picks. Used only where that gives a bed to
    // more people (runAssignmentScope's 'pack-split…' strategies, planOnSnapshot).
    function scopeClasses(ctx, participants, { maxRoom = Infinity, splitSoftMixed = false } = {}) {
        const wantsSplit = typeof splitSoftMixed === 'function' ? splitSoftMixed : () => !!splitSoftMixed;
        const { keepRules, separateRules, companionRules, viewFor, mergedSeparateOk, partitionBy, dividingRules } = ctx;
        const val = ruleVal, cond = condMatches;
        const notes = [];
        const note = (rule, detail, hard) => ({ rule, detail, hard: !!hard });
        // Build placement units — highest-priority keep_together first; each member is claimed once.
        // Grouping key is case-insensitive ("Perez"/"perez" = one family); the first-seen spelling is
        // the display value.
        const claimed = new Set();
        const units = [];
        for (const rule of keepRules) {
            const groups = new Map(); // lowercased key -> { display, people }
            for (const p of participants) {
                if (claimed.has(p.id) || !cond(rule.params.when, p)) continue;
                const v = val(p, rule.field);
                if (v == null || String(v).trim() === '') continue;
                const display = String(v).trim();
                const k = display.toLowerCase();
                if (!groups.has(k)) groups.set(k, { display, people: [] });
                groups.get(k).people.push(p);
            }
            const min = Number(rule.params.min_size) || 1;
            for (const g of groups.values()) {
                if (g.people.length >= min) { units.push({ people: g.people, group: { rule, key: g.display } }); g.people.forEach(p => claimed.add(p.id)); }
            }
        }
        for (const p of participants) if (!claimed.has(p.id)) units.push({ people: [p], group: null });

        const hardSeparate = separateRules.filter(r => r.hard);
        const parts = [];
        units.sort((a, b) => b.people.length - a.people.length);
        for (const unit of units) {
            const yields = !!(unit.group && !unit.group.rule.hard && wantsSplit(unit));
            const dividing = yields ? separateRules.filter(r => r.hard && r.field) : dividingRules(unit.group);
            const split = partitionBy(unit.people, dividing.map(r => r.field));
            // Expected under first match (the separate_by rule ranks first): information, not a broken rule.
            if (split.length > 1 && unit.group) {
                const own = dividingRules(unit.group);
                if (yields && partitionBy(unit.people, own.map(r => r.field)).length < split.length) {
                    notes.push(note(unit.group.rule.name, `El grupo «${unit.group.key}» (${unit.people.length}) se separó por «${dividing.map(r => r.name).join('», «')}» para que más personas tengan cama (la regla es preferente).`, false));
                    unit.yielded = true;
                } else notes.push(note(unit.group.rule.name, `El grupo «${unit.group.key}» (${unit.people.length}) se dividió por «${dividing.map(r => r.name).join('», «')}», que tiene prioridad.`, false));
            }
            unit.parts = split;
            for (const people of split) parts.push({ people, group: unit.group });
        }
        for (const rule of [...companionRules.filter(r => r.hard), ...companionRules.filter(r => !r.hard)]) {
            const min = Number(rule.params.min) || 1;
            for (const part of parts) {
                if (part.gone) continue;
                const view = viewFor(rule, part.people);
                if (!view.some(o => cond(rule.params.subject, o))) continue;
                let have = view.filter(o => cond(rule.params.needs, o)).length;
                for (const donor of parts) {
                    if (have >= min) break;
                    if (donor === part || donor.gone || donor.group || donor.people.length !== 1) continue;
                    const p = donor.people[0];
                    if (!viewFor(rule, [p]).length || !cond(rule.params.needs, p) || cond(rule.params.subject, p)) continue;
                    if (!mergedSeparateOk(part.people, [p])) continue;
                    if (part.people.length + 1 > maxRoom) break;
                    part.people = part.people.concat([p]); part.donors = (part.donors || []).concat([p]); donor.gone = true; have++;
                }
            }
        }
        const MIX = '\u0002';
        // A part's class: the value its people share for each hard field — '' (fits any class) only when NOBODY in it
        // has one; a group whose values differ (a family an outranking keep_together keeps whole) is a class of its own.
        const classKey = (people, list) => list.map(r => {
            const v = distinctValues(viewFor(r, people), r.field);
            return v.length === 0 ? '' : v.length === 1 ? v[0].toLowerCase() : MIX;
        });
        const classes = new Map();
        parts.filter(p => !p.gone).forEach((p, i) => {
            const hard = classKey(p.people, hardSeparate);
            const key = hard.includes(MIX) ? `${MIX}${i}` : hard.join('\u0001');
            if (!classes.has(key)) classes.set(key, { wild: hard.includes(''), size: 0, big: 0, parts: [] });
            const c = classes.get(key);
            c.parts.push({ people: p.people, group: p.group, size: p.people.length, donors: p.donors || [] });
            c.size += p.people.length;
            c.big = Math.max(c.big, p.people.length);
        });
        // The class with the largest indivisible part first (a family of 4 gets the room of 4 before loners take
        // it), then the larger; people with no value for a hard field last — they fill the beds left.
        const classList = [...classes.values()].sort((a, b) => (Number(a.wild) - Number(b.wild)) || (b.big - a.big) || (b.size - a.size));
        return { classList, units, notes };
    }
    async function runAssignmentScope(conferenceId, locationId, opts = {}) {
        const io = opts.io || dbAssignmentIo(conferenceId);
        const isPool = locationId == null;
        // The overflow of location L (2.18.0): a pool-bed run for L's leftovers, under the admin's rules.
        const overflowOf = isPool && opts.overflowLocationId != null ? Number(opts.overflowLocationId) : null;
        const ruleLocation = isPool ? null : locationId;
        const ruleRows = await io.rules(ruleLocation);
        const rules = rankRules(ruleRows.map(parseRuleRow).filter(ruleOnFormFields(await io.fieldNames())));
        const ctx = scopeRuleContext(rules, { isPool, locationId });
        const { keepRules, separateRules, splitRules, companionRules, viewFor, mergedSeparateOk, companionUnmet, partitionBy } = ctx;

        // The set of delegated locations decides who belongs to the pool scope; a FROZEN location's
        // attendees are out of every scope but their own. That is a decision about BULK operations, not a
        // lock: a conference-wide run (like the reset) must not rewrite a submitted / validated arrangement
        // as a side effect — see `skipped_frozen`. The administration still adjusts such an arrangement one
        // change at a time (manual assign, allotments, rooms), and each change is stamped on the location
        // (stampAdminAdjustment, 2.17.0).
        let delegated = opts.delegatedIds;
        if (isPool && !delegated) delegated = await io.delegatedIds();
        let frozenIds = opts.frozenIds;
        if (isPool && !frozenIds) frozenIds = new Set((await io.frozenRows()).map(r => Number(r.id)));
        const inScope = (p) => overflowOf == null && (p.status == null || p.status !== 'cancelled') && (isPool
            ? (p.location_id == null || (!delegated.has(Number(p.location_id)) && !frozenIds.has(Number(p.location_id))))
            : Number(p.location_id) === Number(locationId));

        const participantRows = overflowOf != null ? await io.participants(overflowOf)
            : isPool ? await io.poolParticipants()
            : await io.participants(locationId);
        const participants = participantRows.map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
        if (participants.length > ASSIGN_MAX_PARTICIPANTS) throw httpError(400, `Demasiados inscritos sin asignar para una sola ejecución (máximo ${ASSIGN_MAX_PARTICIPANTS}).`);

        // A location scope covers its WHOLE rooms and the rooms it SHARES; the pool scope every room with
        // location_id NULL (pool rooms, and shared rooms for their pool beds — filtered by quota below).
        const roomRows = await io.scopeRooms(isPool ? null : locationId);
        // Occupancy in ONE query (no per-room SELECT), grouped by room in JS.
        const occRows = await io.scopeOccupants(isPool ? null : locationId);
        const occByRoom = new Map();
        for (const o of occRows) {
            if (!occByRoom.has(o.room_id)) occByRoom.set(o.room_id, []);
            const occ = { ...o, custom_data: parseCd(o.custom_data) };
            // Counts for capacity, never moved by this run; a probe («Sugerir reparto») moves nobody who has a bed.
            if (!inScope(occ) || opts.probe || isPinned(occ)) occ.fixed = true;
            occByRoom.get(o.room_id).push(occ);
        }
        // Each room's QUOTA for this scope — the beds this run may fill there — and how many of them are
        // in use: a whole room's (or a pool room's) capacity; a shared room's beds of this location, or
        // its pool beds for the pool scope (2.18.0). A shared room with no pool bed left is not in the pool
        // scope at all.
        const roomShares = await io.shares(roomRows.map(r => r.id));
        const lockFields = await io.lockFields();
        const rooms = roomRows.map(r => {
            const occupants = occByRoom.get(r.id) || [];
            const shares = roomShares.get(Number(r.id)) || [];
            const room = { id: r.id, capacity: Math.max(1, Number(r.capacity) || 1), room_number: r.room_number, hotel_name: r.hotel_name, location_id: r.location_id == null ? null : r.location_id, occupants,
                // A shared room's class (see «THE CLASS OF A SHARED ROOM»): nobody of another value takes a bed of it.
                lock: shareLockOf(r, shares, lockFields), blocked: isBlocked(r) };
            if (isPool) {
                room.quota = shares.length ? poolBedsOf(room, shares) : room.capacity;
                room.used = shares.length ? poolUsedOf(shares, occupants) : occupants.length;
            } else {
                room.quota = room.location_id != null ? room.capacity : shareBedsOf(shares, locationId);
                room.used = occupants.filter(o => o.location_id != null && Number(o.location_id) === Number(locationId)).length;
            }
            return room;
        }).filter(room => room.quota > 0 && !room.blocked
            // The overflow of L fills pool beds only: a room where L still has free beds of its own is out.
            && !(overflowOf != null && shareBedsOf(roomShares.get(Number(room.id)) || [], overflowOf) > peopleOfLocation(overflowOf, room.occupants).length));
        function peopleOfLocation(lid, list) { return list.filter(o => o.location_id != null && Number(o.location_id) === lid); }
        // Free beds of a room for THIS scope: what is left of its quota, never above its free capacity.
        const freeOf = (room) => Math.max(0, Math.min(room.capacity - room.occupants.length, room.quota - room.used));

        const val = ruleVal;
        const cond = condMatches;

        // Invariant 1 + a shared room's class + hard separate_by, at EVERY placement site.
        const compatible = (room, people) => people.every(p => roomAllows(room, p) && lockAllows(room.lock, p)) && mergedSeparateOk(room.occupants, people);
        // Higher = better room for placing `people`: penalize soft-separate mixing, companion gaps, waste.
        const score = (room, people) => {
            let s = 0;
            const after = room.occupants.concat(people);
            for (const rule of separateRules) {
                if (rule.hard) continue;
                if (distinctValues(judgedBy(rule, viewFor(rule, after), keepRules), rule.field).length > 1) s -= 5;
            }
            s -= companionUnmet(after).length * 3;
            s -= Math.abs(freeOf(room) - people.length) * 0.1;
            return s;
        };
        // Ties between equally full rooms: the one where the soft rules (and companions) hold best.
        const { softSeparate } = ctx;
        const softCost = (room, people) => {
            const after = room.occupants.concat(people);
            let s = 0;
            for (const rule of softSeparate) if (distinctValues(judgedBy(rule, viewFor(rule, after), keepRules), rule.field).length > 1) s += 5;
            return s + companionUnmet(after).length * 3;
        };

        // ROOM PACKING (2.20.0). The site owner: «la menor cantidad de habitaciones … y sin o la menor cantidad
        // de camas vacías en las habitaciones con personas». The hard rules are never broken; within them a run
        // uses the fewest rooms, then leaves the fewest empty beds in the rooms it fills; a SOFT rule (a
        // preference) gives way when keeping it would cost a room or beds — the owner's choice — and is reported.
        //   1. Each unit is divided by the hard separate_by rules that outrank it (a hard rule always wins): PARTS.
        //   2. A part with someone a companion rule asks company for takes the companions it lacks from the single
        //      people of its class, while it still fits one room — a child and an adult then travel together.
        //   3. Parts are grouped into CLASSES (the values of every hard separate_by field), which never share a
        //      room — the class with the largest indivisible part first. Each fills (a) the rooms already holding
        //      people, where it fits the rules — no new room, fewer empty beds; then (b) new rooms, chosen exactly
        //      (the fewest rooms whose beds reach the class, then the fewest spare beds — server/lodging-pack.js),
        //      keeping the preferences when that costs nothing; (c) whatever still has no bed takes the old path
        //      (placePartition: split_by, then chunks; a bundled companion goes back on its own first).
        // STRATEGIES. That packing (classes by largest part, and by size) and 2.19's placement (units one by one,
        // larger first) each run on a copy of the rooms; the run keeps the best by, in order: fewer hard rules
        // broken, fewer people without a bed, fewer rooms used, fewer empty beds in them, fewer preferences broken.
        // So a run never does worse than 2.19 on the rules or the beds — and packs whenever it can.
        const { classList: packClasses, units, notes: groupNotes } = scopeClasses(ctx, participants, { maxRoom: Math.max(0, opts.maxRoom || 0, ...rooms.map(freeOf)) });
        // Preferred mixed families given way (2.21.0): the same people, such families as their men and their women —
        // first only those no empty room here fits exactly ('pack-split-a'), then all of them ('pack-split'); each
        // tried only when some family does divide so, and taken only when it beds more people.
        const exactCaps = new Set(rooms.filter(r => !r.occupants.length).map(r => r.capacity));
        const splitMax = Math.max(0, opts.maxRoom || 0, ...rooms.map(freeOf));
        const splitAlts = {
            'pack-split-a': scopeClasses(ctx, participants, { maxRoom: splitMax, splitSoftMixed: (u) => !exactCaps.has(u.people.length) }),
            'pack-split': scopeClasses(ctx, participants, { maxRoom: splitMax, splitSoftMixed: true }),
        };
        const splitClassesOf = (kind) => (splitAlts[kind] && splitAlts[kind].units.some(u => u.yielded) ? splitAlts[kind].classList : null);
        const roomsAtStart = rooms.map(r => ({ ...r, occupants: r.occupants.slice() }));
        const runStrategy = (kind) => {
            // 'greedy' is 2.19's placement exactly — its chunking and its repair — so the sweep's 'legacy' mode is a
            // true floor: whatever the packing does, the run never ends worse than 2.19 (see THE SWEEP'S MODE).
            const legacy = kind === 'greedy';
            const R = roomsAtStart.map(r => ({ ...r, occupants: r.occupants.slice() }));
            let placed = 0;
            const violations = [];
            const noteViol = (rule, detail, hard) => { if (!violations.some(v => v.rule === rule && v.detail === detail)) violations.push({ rule, detail, hard: !!hard }); };
            for (const n of (splitAlts[kind] ? splitAlts[kind].notes : groupNotes)) noteViol(n.rule, n.detail, n.hard);
            // Deferred writes: mutate memory now, flush every placement once at the end.
            const placements = new Map(); // inscription id -> room id
            const assignTo = (room, person) => { placements.set(person.id, room.id); room.occupants.push(person); room.used++; placed++; };
            const moveTo = (room, donor, person) => { placements.set(person.id, room.id); donor.occupants = donor.occupants.filter(o => o.id !== person.id); donor.used--; room.occupants.push(person); room.used++; };

            // `group` = null | { rule, key } — the keep_together rule that formed this unit and its display
            // value, so a forced division can be reported under that rule's name.
            const placePartition = (people, group) => {
                if (people.length === 0) return;
                const feasible = R.filter(room => freeOf(room) >= people.length && compatible(room, people));
                if (feasible.length) {
                    feasible.sort((a, b) => score(b, people) - score(a, people));
                    for (const p of [...people]) assignTo(feasible[0], p);
                    return;
                }
                if (people.length > 1) {
                    // Divide along a configured split_by field first, then fall back to chunking.
                    for (const sr of splitRules) {
                        const sub = partitionBy(people, [sr.field]);
                        if (sub.length > 1) {
                            if (group) noteViol(group.rule.name, `El grupo «${group.key}» se dividió por «${sr.name}» en ${sub.length} partes.`, group.rule.hard);
                            for (const x of sub) placePartition(x, group);
                            return;
                        }
                    }
                    // The room with the most free beds that takes the longest run of these people the rules allow
                    // together (every one checked, not only the first). 2.19's own rule — the most free beds where the
                    // FIRST person fits, then as many as fit — for its placement ('greedy'), so that one stays 2.19's
                    // exactly: its parts are units, uniform on the dividing fields or explained by their family.
                    let target = null, freeMax = 0, take = 0;
                    for (const room of R) {
                        const free = freeOf(room);
                        if (free < 1 || free <= freeMax) continue;
                        if (legacy) {
                            if (compatible(room, [people[0]])) {
                                // 2.19's run, stopped before anyone a shared room's class refuses (2.21.0: the class binds
                                // every bed of the room, not only the first person's).
                                const run = people.slice(0, Math.min(free, people.length));
                                const stop = run.findIndex(p => !lockAllows(room.lock, p));
                                target = room; freeMax = free; take = stop < 0 ? run.length : stop;
                            }
                            continue;
                        }
                        let k = Math.min(free, people.length);
                        while (k > 0 && !compatible(room, people.slice(0, k))) k--;
                        if (k > 0) { target = room; freeMax = free; take = k; }
                    }
                    if (target) {
                        for (const p of people.slice(0, take)) assignTo(target, p);
                        if (group) noteViol(group.rule.name, `El grupo «${group.key}» (${people.length}) no cupo junto y se dividió.`, group.rule.hard);
                        placePartition(people.slice(take), group);
                        return;
                    }
                    // No room left with any free, compatible capacity — leave them unassigned; they're
                    // counted in `remaining` and reported once (aggregated by count) at the end.
                    return;
                }
                let target = null, best = -Infinity;
                for (const room of R) {
                    if (freeOf(room) >= 1 && compatible(room, people)) { const sc = score(room, people); if (sc > best) { best = sc; target = room; } }
                }
                if (target) assignTo(target, people[0]);
                // else: left unassigned → aggregated into the single capacity violation at the end.
            };

            if (kind === 'greedy') {
                // 2.19: units one by one, larger first (each divided by the hard rules that outrank it).
                for (const u of units) for (const part of u.parts) placePartition(part, u.group);
            } else {
                const peopleIn = (inside) => inside.flatMap(x => x.people);
                // A bed a child still needs for its adult (a HARD require_companion subject without enough companions
                // in the room) goes only to someone who brings one: anyone else would leave the child alone for good.
                const blocksCompanion = (room, people) => {
                    const after = room.occupants.concat(people);
                    const left = freeOf(room) - people.length;
                    for (const rule of companionRules) {
                        if (!rule.hard) continue;
                        const view = viewFor(rule, after);
                        if (!view.some(o => cond(rule.params.subject, o))) continue;
                        const missing = (Number(rule.params.min) || 1) - view.filter(o => cond(rule.params.needs, o)).length;
                        if (missing > 0 && left < missing) return true;
                    }
                    return false;
                };
                const fitsBin = (b, it, inside) => compatible(b.room, peopleIn(inside).concat(it.people)) && !blocksCompanion(b.room, peopleIn(inside).concat(it.people));
                const costBin = (b, it, inside) => softCost(b.room, peopleIn(inside).concat(it.people));
                // Everyone already in the room is of another location than these people (2.36.6, option (a)).
                const locKey = (p) => (p.location_id == null ? null : Number(p.location_id));
                const foreignTo = (inRoom, people) => {
                    if (!inRoom.length) return false;
                    const mine = new Set(people.map(locKey));
                    return !inRoom.some(o => mine.has(locKey(o)));
                };
                const baseClasses = splitAlts[kind] ? splitClassesOf(kind) : packClasses;
                const classes = kind === 'pack-size' ? [...baseClasses].sort((a, b) => (Number(a.wild) - Number(b.wild)) || (b.size - a.size)) : baseClasses;
                for (const cls of classes) {
                    let pending = cls.parts;
                    // 2.36.6, the owner's option (a): a location's people first fill rooms that already hold their own
                    // location (or nobody's), then empty rooms, and only then the free beds of a room another location's
                    // people sleep in (same class — the gender — as always): a location stays together when it can.
                    // Each location's parts are packed on their own (the largest location first), so the fewest-rooms
                    // packing never mixes two locations to save a room; what is left of all of them comes last.
                    const partialRooms = () => R.filter(r => r.occupants.length > 0 && freeOf(r) > 0).map(r => ({ room: r, free: freeOf(r) }));
                    const ownBin = (b, it, inside) => fitsBin(b, it, inside) && !foreignTo(b.room.occupants.concat(peopleIn(inside)), it.people);
                    const byLocation = new Map();
                    for (const it of pending) {
                        const k = locKey(it.people[0] || {});
                        if (!byLocation.has(k)) byLocation.set(k, []);
                        byLocation.get(k).push(it);
                    }
                    const groups = [...byLocation.values()].sort((a, b) => b.reduce((n, it) => n + it.people.length, 0) - a.reduce((n, it) => n + it.people.length, 0));
                    let rest = [];
                    for (let group of groups) {
                        const partial = partialRooms();
                        if (partial.length) {
                            const res = pack.packInto(group, partial, ownBin, costBin);
                            for (const [it, b] of res.placed) for (const p of it.people) assignTo(b.room, p);
                            group = res.left;
                        }
                        if (group.length) {
                            const empty = R.filter(r => r.occupants.length === 0 && freeOf(r) > 0).map(r => ({ room: r, free: freeOf(r) }));
                            const res = pack.packNew(group, empty, fitsBin, costBin);
                            for (const [it, b] of res.placed) for (const p of it.people) assignTo(b.room, p);
                            group = res.left;
                        }
                        rest = rest.concat(group);
                    }
                    pending = rest;
                    if (pending.length) {
                        const partial = partialRooms();
                        if (partial.length) {
                            const res = pack.packInto(pending, partial, fitsBin, costBin);
                            for (const [it, b] of res.placed) for (const p of it.people) assignTo(b.room, p);
                            pending = res.left;
                        }
                    }
                    // A probe («Sugerir reparto») leaves what did not fit whole for the plan to place — except a group
                    // bigger than every room (here and among the plan's free ones): no arrangement keeps it together, so
                    // it goes in piece by piece, as a run places it.
                    if (opts.probe) {
                        const biggest = Math.max(Number(opts.maxRoom) || 0, ...R.map(r => r.capacity));
                        pending = pending.filter(it => it.people.length > biggest);
                    }
                    // A part mixed on a hard «separar por» (a family an outranking rule keeps together) that no room
                    // took whole — its mixed room is the family's alone (judgedBy): divided along those values, each
                    // piece packed like any part (rooms with people first). The family is divided anyway; this way
                    // the «separar por» holds and the pieces may complete rooms of their value (2.21.0).
                    else if (pending.length && ctx.hardSeparate.length) {
                        const fields = ctx.hardSeparate.map(r => r.field).filter(Boolean);
                        const pieces = [], whole = [];
                        for (const it of pending) {
                            const own = it.people.filter(p => !it.donors.includes(p));
                            const split = ctx.partitionBy(own, fields);
                            if (split.length < 2) { whole.push(it); continue; }
                            for (const people of split) pieces.push({ people, group: it.group, size: people.length, donors: [] });
                            for (const d of it.donors) pieces.push({ people: [d], group: null, size: 1, donors: [] });
                        }
                        let left = pieces;
                        const partialRooms = R.filter(r => r.occupants.length > 0 && freeOf(r) > 0).map(r => ({ room: r, free: freeOf(r) }));
                        if (left.length && partialRooms.length) {
                            const res = pack.packInto(left, partialRooms, fitsBin, costBin);
                            for (const [it, b] of res.placed) for (const p of it.people) assignTo(b.room, p);
                            left = res.left;
                        }
                        if (left.length) {
                            const emptyRooms = R.filter(r => r.occupants.length === 0 && freeOf(r) > 0).map(r => ({ room: r, free: freeOf(r) }));
                            const res = pack.packNew(left, emptyRooms, fitsBin, costBin);
                            for (const [it, b] of res.placed) for (const p of it.people) assignTo(b.room, p);
                            left = res.left;
                        }
                        pending = whole.concat(left);
                    }
                    for (const it of pending) {
                        const own = it.people.filter(p => !it.donors.includes(p));
                        placePartition(own, it.group);
                        for (const d of it.donors) placePartition([d], null);
                    }
                }
            }

            // The room a repair takes someone from must keep its hard rules without them: no hard separate_by mix
            // left unexplained, and no hard keep_together family taken apart — a family (its block of the hard
            // separate_by rules that outrank it) that is WHOLE in that room: nobody of it elsewhere, nobody of it still
            // without a bed. A family already divided loses nothing more (2.19 checked only the receiving room).
            const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
            const leavesOk = (donor, o) => {
                const rest = donor.occupants.filter(x => x.id !== o.id);
                if (!mergedSeparateOk(rest, [])) return false;
                for (const k of keepRules) {
                    if (!k.hard || !k.field || !cond(k.params.when, o)) continue;
                    const key = norm(val(o, k.field));
                    if (!key) continue;
                    const dividing = separateRules.filter(r => r.hard && r.field && r.rank < k.rank);
                    const sameBlock = (x) => x.id !== o.id && cond(k.params.when, x) && norm(val(x, k.field)) === key && dividing.every(r => norm(val(x, r.field)) === norm(val(o, r.field)));
                    if (!rest.some(sameBlock)) continue;
                    const elsewhere = R.some(r => r !== donor && r.occupants.some(sameBlock));
                    const waiting = participants.some(p => !placements.has(p.id) && sameBlock(p));
                    if (!elsewhere && !waiting) return false;
                }
                return true;
            };
            // Repair pass for HARD require_companion: pull a "needs" member into a room that has a subject
            // but too few companions (respecting capacity + hard separate + roomAllows), without stranding
            // the donor. Only occupants of THIS scope are movable (`fixed` ones stay where they are).
            for (const rule of companionRules) {
                if (!rule.hard) continue;
                const min = Number(rule.params.min) || 1;
                for (const room of R) {
                    if (!viewFor(rule, room.occupants).some(o => cond(rule.params.subject, o))) continue;
                    let have = viewFor(rule, room.occupants).filter(o => cond(rule.params.needs, o)).length;
                    while (have < min && freeOf(room) >= 1) {
                        let moved = false;
                        for (const donor of R) {
                            if (donor === room) continue;
                            const donorView = viewFor(rule, donor.occupants);
                            const donorHasSubject = donorView.some(o => cond(rule.params.subject, o));
                            const donorNeeds = donorView.filter(o => cond(rule.params.needs, o)).length;
                            if (donorHasSubject && donorNeeds <= min) continue; // don't break the donor's own rule
                            const cand = donorView.find(o => !o.fixed && cond(rule.params.needs, o) && compatible(room, [o]) && (legacy || leavesOk(donor, o)));
                            if (cand) { moveTo(room, donor, cand); have++; moved = true; break; }
                        }
                        if (!moved) break;
                    }
                }
            }
            return { kind, rooms: R, placements, assignedCount: placed, violations };
        };
        // [hard broken, without a bed, rooms mixing locations, rooms used, empty beds in them, preferences broken] — lower
        // is better. 2.36.6 (option (a)): a location kept together counts before a room saved.
        const scoreOf = (st) => {
            let hard = st.violations.filter(v => v.hard).length, soft = st.violations.filter(v => !v.hard).length, used = 0, empty = 0, mixed = 0;
            for (const room of st.rooms) {
                if (!room.occupants.length) continue;
                used++; empty += freeOf(room);
                if (new Set(room.occupants.map(o => (o.location_id == null ? null : Number(o.location_id)))).size > 1) mixed++;
                if (!mergedSeparateOk(room.occupants, [])) hard++;
                for (const rule of companionUnmet(room.occupants)) { if (rule.hard) hard++; else soft++; }
                for (const rule of softSeparate) if (distinctValues(judgedBy(rule, viewFor(rule, room.occupants), keepRules), rule.field).length > 1) soft++;
            }
            return [hard, participants.length - st.assignedCount, mixed, used, empty, soft];
        };
        const lexLess = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k]; return false; };
        let chosen = null;
        const kinds = opts.probe ? ['pack'] : opts.strategies || ['pack', 'pack-size', 'greedy'];
        for (const kind of kinds) {
            const st = runStrategy(kind);
            st.score = scoreOf(st);
            if (!chosen || lexLess(st.score, chosen.score)) chosen = st;
        }
        // A preferred mixed family gives way only when someone would otherwise be left without a bed (the owner: «que
        // ceda si falta cama»): the split is taken when it beds more people and breaks no more hard rules — with beds
        // enough, families stay together even in a room bigger than them.
        if (!opts.probe && kinds.includes('pack')) {
            for (const kind of ['pack-split-a', 'pack-split']) {
                if (chosen.score[1] === 0 || !splitClassesOf(kind)) continue;
                const st = runStrategy(kind);
                st.score = scoreOf(st);
                if (st.score[0] <= chosen.score[0] && st.score[1] < chosen.score[1]) chosen = st;
            }
        }
        const finalRooms = chosen.rooms;
        const placements = chosen.placements;
        const assignedCount = chosen.assignedCount;
        const violations = chosen.violations;
        const noteViol = (rule, detail, hard) => { if (!violations.some(v => v.rule === rule && v.detail === detail)) violations.push({ rule, detail, hard: !!hard }); };

        // Single flush of every placement (chunks of 200 through db.batch; the assignment lock still
        // serialises runs, so nothing else writes room_id meanwhile). A simulation writes to its copy.
        await io.flush(placements);

        // The preferences this run gave way to (2.20.0): a soft separate_by mixed in a room it filled, to use fewer
        // rooms (the owner's choice: rooms over preferences). Reported, never hard.
        const filled = new Set(placements.values());
        for (const room of finalRooms) {
            if (!filled.has(room.id)) continue;
            for (const rule of softSeparate) {
                const values = distinctValues(judgedBy(rule, viewFor(rule, room.occupants), keepRules), rule.field);
                if (values.length > 1) noteViol(rule.name, `Habitación ${room.room_number || room.id}: mezcla ${values.length} valores de «${rule.field}» (${values.join(', ')}) para usar menos habitaciones.`, false);
            }
        }

        // Report every remaining companion gap (hard ones we couldn't repair + soft preferences). The sweep
        // reports them once, on the final rooms (sweepCompanionReport), so its scopes stay quiet here.
        if (!opts.quietRooms) for (const room of finalRooms) {
            for (const rule of companionUnmet(room.occupants)) {
                noteViol(rule.name, `Habitación ${room.room_number || room.id}: no se cumplió «${rule.name}».`, rule.hard);
            }
        }

        // One clear, count-accurate capacity report (instead of per-person lines that would dedupe).
        const remaining = participants.length - assignedCount;
        if (remaining > 0 && !opts.quietCapacity) noteViol('capacidad', capacityDetail(remaining), true);
        return { assignedCount, remaining, violations };
    }
    const capacityDetail = (n) => (n === 1 ? '1 inscrito quedó sin cupo — faltan habitaciones.' : `${n} inscritos quedaron sin cupo — faltan habitaciones.`);

    // Delegated locations of a conference (at least one allotted room), with their review status.
    async function delegatedLocations(conferenceId) {
        const rows = await db.all(
            `SELECT l.id, l.name, l.lodging_status FROM ${T.locations} l WHERE l.conference_id = ? AND (EXISTS (SELECT 1 FROM ${T.rooms} r WHERE r.location_id = l.id ) OR EXISTS (SELECT 1 FROM ${T.roomBeds} b WHERE b.location_id = l.id )) ORDER BY l.name`,
            [conferenceId]);
        return rows.map(l => ({ id: l.id, name: l.name, status: lodgingStatusOf(l) }));
    }

    // The sweep's companion breaches (2.18.0), judged once on the final rooms instead of per scope (the
    // scopes overlapped: the pool, the overflow and a location saw the same shared room). A location's own
    // rule judges that location's people; a conference rule judges the owner's people in a whole room and
    // everyone in a pool or shared room. Rooms of a frozen location, and frozen locations' own rules, are
    // left out (the sweep did not touch them). Each breach carries the location whose line it belongs to
    // (null = the conference's).
    async function sweepCompanionReport(conferenceId, frozenIds, io = dbAssignmentIo(conferenceId)) {
        const rules = rankRules((await io.companionRules())
            .map(parseRuleRow).filter(ruleOnFormFields(await io.fieldNames())));
        if (!rules.length) return [];
        const rooms = await io.reportRooms();
        const byRoom = new Map();
        for (const o of await io.placed()) {
            if (!byRoom.has(Number(o.room_id))) byRoom.set(Number(o.room_id), []);
            byRoom.get(Number(o.room_id)).push({ ...o, custom_data: parseCd(o.custom_data) });
        }
        const out = [];
        for (const room of rooms) {
            const owner = room.location_id == null ? null : Number(room.location_id);
            if (owner != null && frozenIds.has(owner)) continue;
            const occupants = byRoom.get(Number(room.id)) || [];
            if (!occupants.length) continue;
            for (const rule of rules) {
                const ruleLoc = rule.location_id == null ? null : Number(rule.location_id);
                if (ruleLoc != null && frozenIds.has(ruleLoc)) continue;
                const judged = ruleLoc != null ? ruleLoc : owner;
                const view = judged != null ? occupants.filter(o => o.location_id != null && Number(o.location_id) === judged) : occupants;
                if (!view.length || !companionUnmetIn([rule], view).length) continue;
                out.push({ location_id: judged, rule: rule.name, detail: `Habitación ${room.room_number || room.id}: no se cumplió «${rule.name}».`, hard: !!rule.hard });
            }
        }
        return out;
    }

    // `locationId` given (number) → that location's scope only (the coordinator's run; the admin's
    // per-location run). `locationId` null → the pool scope only. `locationId` undefined → the admin's
    // conference-wide sweep: the pool scope, then one scope per delegated location that is not frozen,
    // in name order. Totals on top, per-location detail in `by_location`, EVERY frozen location of the
    // conference (delegated or not — its attendees are untouchable either way) in `skipped_frozen`.
    // `io` (2.20.0): the database by default; an in-memory copy for a simulation (see dbAssignmentIo).
    async function runAssignment(conferenceId, { locationId, io = dbAssignmentIo(conferenceId), mode, snap } = {}) {
        if (locationId === null) return runAssignmentScope(conferenceId, null, { io });
        if (locationId !== undefined) return runAssignmentScope(conferenceId, locationId, { io });
        // THE SWEEP'S MODE (2.20.0). Each scope keeps its best strategy, but scopes meet — in shared rooms and in
        // the overflow — where one scope's best can leave the next worse off. So the whole sweep is first run on
        // copies of the conference: «best» (each scope its best) and «legacy» (2.19's placement in every scope);
        // the run takes the one that leaves the conference better off: fewer hard rules broken, fewer people
        // without a bed, fewer rooms, fewer empty beds, fewer preferences broken. `snap`: the copy a simulation
        // already holds (otherwise the conference is loaded).
        if (!mode) {
            const start = snap ? cloneSnapshot(snap) : await loadAssignmentSnapshot(conferenceId);
            let bestScore = null;
            for (const m of ['best', 'legacy']) {
                const copy = cloneSnapshot(start);
                await runAssignment(conferenceId, { io: snapshotAssignmentIo(copy), mode: m });
                const sc = sweepScore(copy);
                if (!bestScore || sweepLess(sc, bestScore)) { bestScore = sc; mode = m; }
            }
        }
        const strategies = mode === 'legacy' ? ['greedy'] : undefined;
        const delegated = await io.delegatedLocations();
        const frozenRows = await io.frozenRows();
        const frozenIds = new Set(frozenRows.map(l => Number(l.id)));
        const delegatedIds = new Set(delegated.map(l => Number(l.id)));
        // Every scope of the sweep keeps its capacity line and its per-room companion report for the end.
        const quiet = { quietCapacity: true, quietRooms: true, io, strategies };
        const pool = await runAssignmentScope(conferenceId, null, { delegatedIds, frozenIds, ...quiet });
        const result = {
            assignedCount: pool.assignedCount, remaining: 0, violations: pool.violations.slice(), by_location: [],
            skipped_frozen: frozenRows.map(l => ({ location_id: l.id, name: l.name, status: lodgingStatusOf(l) })),
        };
        const pushOnce = (list, v) => { if (!list.some(x => x.rule === v.rule && x.detail === v.detail)) list.push(v); };
        const swept = [];
        for (const l of delegated) {
            if (frozenIds.has(Number(l.id))) continue;
            swept.push({ l, r: await runAssignmentScope(conferenceId, l.id, quiet) });
        }
        // A pool bed a location run freed (its repair pass moved one of its people off a pool bed) goes
        // to the pool's own attendees first.
        let poolLeft = pool.remaining;
        if (poolLeft > 0 && swept.length) {
            const again = await runAssignmentScope(conferenceId, null, { delegatedIds, frozenIds, ...quiet });
            result.assignedCount += again.assignedCount;
            poolLeft = again.remaining;
            for (const v of again.violations) pushOnce(result.violations, v);
        }
        if (poolLeft > 0) result.violations.push({ rule: 'capacidad', detail: capacityDetail(poolLeft), hard: true });
        result.remaining = poolLeft;
        // Overflow (2.18.0), location by location in name order: the people a location's own beds could not
        // hold take the pool beds still free, under the admin's (conference) rules.
        for (const { l, r } of swept) {
            const o = r.remaining > 0 ? await runAssignmentScope(conferenceId, null, { delegatedIds, frozenIds, overflowLocationId: l.id, ...quiet }) : null;
            const inPool = o ? o.assignedCount : 0;
            const left = Math.max(0, r.remaining - inPool);
            const violations = r.violations.slice();
            if (o) for (const v of o.violations) pushOnce(violations, { rule: v.rule, detail: `Camas del pool: ${v.detail}`, hard: v.hard });
            if (left > 0) violations.push({ rule: 'capacidad', detail: capacityDetail(left), hard: true });
            result.assignedCount += r.assignedCount + inPool;
            result.remaining += left;
            result.by_location.push({ location_id: l.id, name: l.name, assignedCount: r.assignedCount + inPool, pool_beds: inPool, remaining: left, violations });
        }
        // Companion breaches, once, on the final rooms of the sweep (2.18.0): a breach in a location's whole
        // room, or of a location's own rule, goes on that location's line too.
        const companion = await sweepCompanionReport(conferenceId, frozenIds, io);
        const lineOf = new Map(result.by_location.map(x => [Number(x.location_id), x]));
        for (const v of companion) {
            const line = v.location_id != null ? lineOf.get(Number(v.location_id)) : null;
            if (line) pushOnce(line.violations, { rule: v.rule, detail: v.detail, hard: v.hard });
            else if (v.location_id == null) pushOnce(result.violations, { rule: v.rule, detail: v.detail, hard: v.hard });
        }
        for (const line of result.by_location) {
            for (const v of line.violations) result.violations.push({ rule: v.rule, detail: `«${line.name}»: ${v.detail}`, hard: v.hard });
        }
        // The skipped locations' attendees still without a bed (each skipped location's `unassigned`, and
        // their sum): `remaining` only counts the scopes the run covered, so without these the report said
        // «Pendientes: 0» next to the explorer's «2 sin asignar» (2.17.0). remaining + skipped_unassigned is
        // every non-cancelled attendee still without a bed once the run is done (read under the same lock).
        const byFrozen = await io.unassignedByLocation(frozenRows.map(l => Number(l.id)));
        for (const s of result.skipped_frozen) s.unassigned = byFrozen.get(Number(s.location_id)) || 0;
        result.skipped_unassigned = result.skipped_frozen.reduce((n, s) => n + s.unassigned, 0);
        return result;
    }

    // ── the engine on a copy (2.20.0) ─────────────────────────────────────────────────────────────
    // A SNAPSHOT is the conference as the engine reads it — rules, the form's field names, locations (in
    // the database's name order, the sweep's order), rooms (by id, with their hotel), the bed shares and
    // every inscription — loaded in one go. snapshotAssignmentIo answers the engine's reads from it exactly
    // as dbAssignmentIo answers them from the database (same filters, same order) and writes placements into
    // it, so runAssignment on a snapshot does what it would do on the database. The planner changes a copy's
    // allotment (setRoomWhole / setRoomShares / setRoomPool) and runs the engine on it.
    async function loadAssignmentSnapshot(conferenceId) {
        const [rules, fieldNames, locations, rooms, reportOrder, people] = await Promise.all([
            db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? ORDER BY priority DESC, id ASC`, [conferenceId]),
            ruleFieldNames(conferenceId),
            db.all(`SELECT id, name, lodging_status, lodging_order FROM ${T.locations} WHERE conference_id = ? ORDER BY name`, [conferenceId]),
            db.all(`SELECT r.*, h.name AS hotel_name FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? ORDER BY r.id`, [conferenceId]),
            db.all(`SELECT r.id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? ORDER BY h.name, r.room_number, r.id`, [conferenceId]),
            db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? ORDER BY id`, [conferenceId]),
        ]);
        const roomIds = rooms.map(r => r.id);
        const roomBeds = [];
        for (let i = 0; i < roomIds.length; i += 400) {
            const chunk = roomIds.slice(i, i + 400);
            if (chunk.length) roomBeds.push(...await db.all(`SELECT id, room_id, location_id, beds FROM ${T.roomBeds} WHERE room_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY id`, chunk));
        }
        roomBeds.sort((a, b) => Number(a.id) - Number(b.id));
        return {
            conferenceId: Number(conferenceId), rules, fieldNames, locations,
            rooms: rooms.map(r => ({ ...r, id: Number(r.id), location_id: r.location_id == null ? null : Number(r.location_id) })),
            reportOrder: reportOrder.map(r => Number(r.id)),
            roomBeds: roomBeds.map(b => ({ id: Number(b.id), room_id: Number(b.room_id), location_id: Number(b.location_id), beds: Number(b.beds) || 0 })),
            // Whoever said they need no lodging and holds no bed is nobody's to place (dbAssignmentIo's lodgingSql).
            people: people.filter(p => p.room_id != null || needsLodging(p)).map(p => ({ ...p, id: Number(p.id), room_id: p.room_id == null ? null : Number(p.room_id), location_id: p.location_id == null ? null : Number(p.location_id) })),
        };
    }
    const cloneSnapshot = (s) => ({ ...s, rooms: s.rooms.map(r => ({ ...r })), roomBeds: s.roomBeds.map(b => ({ ...b })), people: s.people.map(p => ({ ...p })) });
    // Allotment edits on a copy (the planner's): a room whole to a location, split into shares, or pool.
    const nextBedId = (s) => s.roomBeds.reduce((n, b) => Math.max(n, b.id), 0) + 1;
    const setRoomPool = (s, roomId) => { const r = s.rooms.find(x => x.id === roomId); if (r) { r.location_id = null; r.share_lock = null; } s.roomBeds = s.roomBeds.filter(b => b.room_id !== roomId); };
    const setRoomWhole = (s, roomId, lid) => { setRoomPool(s, roomId); const r = s.rooms.find(x => x.id === roomId); if (r) r.location_id = Number(lid); };
    const setRoomShares = (s, roomId, shares) => {
        setRoomPool(s, roomId);
        let id = nextBedId(s);
        for (const x of shares) if (x.beds > 0) s.roomBeds.push({ id: id++, room_id: roomId, location_id: Number(x.location_id), beds: x.beds });
    };
    // `delegated`: locations to treat as having beds although the copy gives them none yet (the planner's
    // probe: their people are not the pool's).
    function snapshotAssignmentIo(s, { delegated: forced = new Set() } = {}) {
        const live = (p) => p.status == null || p.status !== 'cancelled';
        const byId = (a, b) => a.id - b.id;
        const ruleOn = (r) => Number(r.enabled) === 1;
        const frozen = () => s.locations.filter(isFrozen);
        const owners = () => new Set(s.rooms.filter(r => r.location_id != null).map(r => r.location_id));
        const sharers = () => new Set(s.roomBeds.map(b => b.location_id));
        const roomsOf = (lid) => s.rooms.filter(r => (lid == null ? r.location_id == null : r.location_id === Number(lid) || s.roomBeds.some(b => b.room_id === r.id && b.location_id === Number(lid))));
        return {
            conferenceId: s.conferenceId,
            rules: async (ruleLocation) => s.rules.filter(r => ruleOn(r) && (r.location_id == null || (ruleLocation != null && Number(r.location_id) === Number(ruleLocation)))),
            companionRules: async () => s.rules.filter(r => ruleOn(r) && r.type === 'require_companion'),
            fieldNames: async () => s.fieldNames,
            delegatedIds: async () => new Set([...owners(), ...sharers(), ...forced]),
            frozenRows: async () => frozen().map(l => ({ id: l.id, name: l.name, lodging_status: l.lodging_status })),
            delegatedLocations: async () => {
                const o = owners(), sh = sharers();
                return s.locations.filter(l => o.has(Number(l.id)) || sh.has(Number(l.id))).map(l => ({ id: l.id, name: l.name, status: lodgingStatusOf(l) }));
            },
            participants: async (lid) => s.people.filter(p => p.location_id === Number(lid) && p.room_id == null && live(p)).map(p => ({ ...p })),
            poolParticipants: async () => {
                const o = owners(), sh = sharers(), fz = new Set(frozen().map(l => Number(l.id)));
                return s.people.filter(p => p.room_id == null && live(p) && (p.location_id == null
                    || (!o.has(p.location_id) && !sh.has(p.location_id) && !fz.has(p.location_id) && !forced.has(p.location_id)))).map(p => ({ ...p }));
            },
            scopeRooms: async (lid) => roomsOf(lid).sort(lid == null ? byId : (a, b) => Number(a.hotel_id) - Number(b.hotel_id) || a.id - b.id).map(r => ({ ...r })),
            scopeOccupants: async (lid) => { const ids = new Set(roomsOf(lid).map(r => r.id)); return s.people.filter(p => p.room_id != null && ids.has(p.room_id)).map(p => ({ ...p })); },
            lockFields: async () => lockFieldsOf(s.rules, s.fieldNames),
            shares: async (roomIds) => {
                const want = new Set((roomIds || []).map(Number));
                const map = new Map();
                for (const b of s.roomBeds) {
                    if (!want.has(b.room_id)) continue;
                    if (!map.has(b.room_id)) map.set(b.room_id, []);
                    map.get(b.room_id).push({ location_id: b.location_id, beds: Math.max(0, b.beds) });
                }
                return map;
            },
            flush: async (placements) => { const at = new Map(s.people.map(p => [p.id, p])); for (const [pid, rid] of placements) { const p = at.get(Number(pid)); if (p) p.room_id = Number(rid); } },
            unassignedByLocation: async (ids) => {
                const want = new Set(ids.map(Number)), out = new Map();
                for (const p of s.people) if (p.room_id == null && live(p) && p.location_id != null && want.has(p.location_id)) out.set(p.location_id, (out.get(p.location_id) || 0) + 1);
                return out;
            },
            reportRooms: async () => { const at = new Map(s.rooms.map(r => [r.id, r])); return s.reportOrder.map(id => at.get(id)).filter(Boolean).map(r => ({ id: r.id, room_number: r.room_number, location_id: r.location_id })); },
            placed: async () => s.people.filter(p => p.room_id != null).map(p => ({ ...p })),
        };
    }
    // A conference's rules as a run reads them (enabled, on form fields, ranked), each location's view of them, and
    // the audit of a snapshot's rooms: every location present applies its view to the room (a conference rule sees
    // everyone, its own rules its people — the engine's mergedSeparateOk); a require_companion as
    // sweepCompanionReport does (its own rule on its people; a conference rule on the owner's people in a whole
    // room, on everyone in a pool or shared room). `who`: the people whose rooms are judged.
    function makeAuditor(S) {
        const allRules = rankRules(S.rules.filter(r => Number(r.enabled) === 1).map(parseRuleRow).filter(ruleOnFormFields(S.fieldNames)));
        const cache = new Map();
        const ctxFor = (lid) => {
            const k = lid == null ? 'pool' : String(lid);
            if (!cache.has(k)) cache.set(k, scopeRuleContext(allRules.filter(r => r.location_id == null || (lid != null && Number(r.location_id) === Number(lid))), { isPool: lid == null, locationId: lid == null ? null : Number(lid) }));
            return cache.get(k);
        };
        const audit = (T2, who) => {
            const hard = [], soft = [];
            const occ = new Map();
            for (const p of T2.people) {
                if (p.room_id == null) continue;
                if (!occ.has(p.room_id)) occ.set(p.room_id, []);
                occ.get(p.room_id).push({ ...p, custom_data: parseCd(p.custom_data) });
            }
            const seen = new Set();
            const note = (list, v) => { const k = v.key || `${v.room_id}|${v.rule}`; if (!seen.has(k)) { seen.add(k); list.push(v); } };
            // keep_together, as auditArrangement: a family (the rule's value, `when` honoured, at least min_size people)
            // in more than one room, or in a room while someone of it has no bed — judged per block of the hard
            // separate_by rules that outrank it (a family divided by gender on purpose is no breach). A conference
            // rule's family spans locations (a group split between scopes IS split); a location's own rule, its people.
            const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
            const liveOnes = T2.people.filter(p => p.status == null || p.status !== 'cancelled').map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
            for (const rule of allRules) {
                if (rule.type !== 'keep_together' || !rule.field) continue;
                const own = rule.location_id == null ? null : Number(rule.location_id);
                const dividing = allRules.filter(r => r.type === 'separate_by' && r.hard && r.field && r.rank < rule.rank && (r.location_id == null || Number(r.location_id) === own));
                const groups = new Map();
                for (const p of liveOnes) {
                    if (own != null && p.location_id !== own) continue;
                    if (!condMatches(rule.params.when, p)) continue;
                    const k = norm(ruleVal(p, rule.field));
                    if (!k) continue;
                    if (!groups.has(k)) groups.set(k, { display: String(ruleVal(p, rule.field)).trim(), members: [] });
                    groups.get(k).members.push(p);
                }
                const min = Number(rule.params.min_size) || 1;
                for (const g of groups.values()) {
                    if (g.members.length < min || !g.members.some(who)) continue;
                    const blocks = new Map();
                    for (const p of g.members) { const bk = dividing.map(d => norm(ruleVal(p, d.field))).join('\u0001'); if (!blocks.has(bk)) blocks.set(bk, []); blocks.get(bk).push(p); }
                    for (const [bk, b] of blocks) {
                        const rooms = new Set(b.filter(p => p.room_id != null).map(p => p.room_id));
                        const out = b.filter(p => p.room_id == null).length;
                        if (rooms.size > 1 || (rooms.size === 1 && out > 0)) note(rule.hard ? hard : soft, { room_id: null, key: `keep|${rule.id}|${norm(g.display)}|${bk}`, location_id: own,
                            location_ids: [...new Set(b.map(p => p.location_id))], rule: rule.name, hard: !!rule.hard,
                            detail: `El grupo «${g.display}» está en ${rooms.size === 1 ? '1 habitación' : rooms.size + ' habitaciones'}${out ? ` y ${out} sin cama` : ''}.` });
                    }
                }
            }
            for (const room of T2.rooms) {
                const list = occ.get(room.id);
                if (!list || !list.some(who)) continue;
                const owner = room.location_id == null ? null : Number(room.location_id);
                const label = `Habitación ${room.room_number || room.id}`;
                for (const lid of [...new Set(list.map(o => o.location_id))]) {
                    const c = ctxFor(lid);
                    for (const rule of c.separateRules) {
                        if (!rule.field) continue;
                        const values = distinctValues(judgedBy(rule, c.viewFor(rule, list), c.keepRules), rule.field);
                        if (values.length > 1) note(rule.hard ? hard : soft, { room_id: room.id, location_id: rule.location_id == null ? owner : Number(rule.location_id), rule: rule.name, hard: !!rule.hard,
                            detail: `${label}: mezcla ${values.length} valores de «${rule.field}» (${values.join(', ')})${rule.hard ? '' : ' para usar menos habitaciones'}.` });
                    }
                }
                for (const rule of allRules) {
                    if (rule.type !== 'require_companion') continue;
                    const own = rule.location_id == null ? null : Number(rule.location_id);
                    const view = own != null ? list.filter(o => o.location_id === own) : owner != null ? list.filter(o => o.location_id === owner) : list;
                    if (view.length && companionUnmetIn([rule], view).length) note(rule.hard ? hard : soft, { room_id: room.id, location_id: own != null ? own : owner, rule: rule.name, hard: !!rule.hard,
                        detail: `${label}: no se cumplió «${rule.name}».` });
                }
            }
            return { hard, soft };
        };
        // What an arrangement gives `who`: hard rules broken, people without a bed, rooms used, their empty beds.
        const measure = (T2, who) => {
            const a = audit(T2, who);
            const live = (p) => p.status == null || p.status !== 'cancelled';
            const roomsWith = new Set(T2.people.filter(p => p.room_id != null && who(p)).map(p => p.room_id));
            const count = new Map();
            for (const p of T2.people) if (p.room_id != null) count.set(p.room_id, (count.get(p.room_id) || 0) + 1);
            let empty = 0;
            for (const r of T2.rooms) if (roomsWith.has(r.id)) empty += roomCapacityOf(r) - (count.get(r.id) || 0);
            return { hard: a.hard.length, unplaced: T2.people.filter(p => who(p) && live(p) && p.room_id == null).length, rooms: roomsWith.size, empty_beds: empty, soft: a.soft.length, audit: a };
        };
        return { allRules, ctxFor, audit, measure };
    }
    // A finished sweep, for the choice of its mode: everyone not in a frozen location.
    const sweepScore = (S) => {
        const frozen = new Set(S.locations.filter(isFrozen).map(l => Number(l.id)));
        const m = makeAuditor(S).measure(S, (p) => p.location_id == null || !frozen.has(Number(p.location_id)));
        // 2.36.6 (option (a)): rooms holding people of more than one location — a location kept together counts
        // before a room saved, as in each scope's own choice (runAssignmentScope's scoreOf).
        const locsIn = new Map();
        for (const p of S.people) {
            if (p.room_id == null) continue;
            if (!locsIn.has(p.room_id)) locsIn.set(p.room_id, new Set());
            locsIn.get(p.room_id).add(p.location_id == null ? null : Number(p.location_id));
        }
        const mixed = [...locsIn.values()].filter(s => s.size > 1).length;
        return [m.hard, m.unplaced, mixed, m.rooms, m.empty_beds, m.soft];
    };
    const sweepLess = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k]; return false; };
    // What the automatic assignment (the admin's conference-wide run) would do on `snap` — on a copy; returns
    // the run's report and the copy with everyone placed.
    async function simulateSweep(snap, opts = {}) {
        const copy = cloneSnapshot(snap);
        const result = await runAssignment(copy.conferenceId, { io: snapshotAssignmentIo(copy, opts), snap: copy });
        return { result, snap: copy };
    }

    // ── «Sugerir reparto» (2.20.0) ────────────────────────────────────────────────────────────────
    // The site owner: allotting rooms to locations by head count alone leaves arrangements the automatic
    // assignment cannot fill without breaking a rule; the panel must SUGGEST how to give beds to the locations
    // «de tal forma que se usen la menor cantidad de habitaciones y que no se incumplan las reglas».
    //
    // planOnSnapshot works on a copy of the conference:
    //   1. Rooms it may (re)allot: nobody inside, in the chosen hotel, not a frozen location's; with `replan`
    //      also the empty rooms already given to a draft location (they are reconsidered — kept when they
    //      still fit best). Every other room, and everyone already placed, stays as it is.
    //   2. Who needs a bed: every draft location's attendees without one, minus those its rooms that stay
    //      can still take (a probe run of the engine on the rooms that stay), and the pool's (no location).
    //   3. Each location's people are grouped exactly as a run groups them (scopeClasses) and packed into
    //      the free rooms by the engine's arithmetic (lodging-pack.js): per class, the fewest rooms, then the
    //      fewest spare beds. Rooms a location had are preferred, then rooms in a hotel it already uses.
    //   4. With `share`, each class (the conference's hard separate_by values) is also packed with every
    //      location together — shared rooms, beds per location — and that is kept only when it leaves fewer
    //      people out, or uses fewer rooms, or leaves fewer empty beds than each location on its own rooms. Then
    //      each room is swapped for a smaller free one when its people fit (fewer empty beds).
    //   5. The plan PLACES its people too — those packed into its rooms and those the probe put in rooms their
    //      location keeps — so the arrangement is exactly the one shown: a run left to itself, given only the
    //      allotment, may give a shared room to another class than the plan meant (both fit the first location it
    //      sweeps) and push the next locations' people onto pool beds. «Aplicar» then runs the automatic
    //      assignment for whoever is still without a bed, so every candidate is judged after that run (settle:
    //      simulateSweep, then makeAuditor's measure); a location left with someone without a bed or a hard rule
    //      broken is planned again on its own rooms (no sharing), then with spare beds; the best plan wins.
    // When the free beds do not reach everyone waiting (2.21.0; the owner: «en orden por localidad»), they go
    // location by location in ORDER — the order the admin set in the sheet (POST /assignment/location-order), else
    // the Localidades list (by name): the first gets every bed it needs, then the next, and so on; the score puts
    // the earlier locations' people without a bed before rooms and empty beds. A hard keep_together group bigger
    // than every free room (e.g. «mantener juntos» by gender) cannot be kept together by any arrangement: its
    // people are packed one by one, and the plan says so (`oversized`).
    // «Aplicar» re-plans under the assignment lock and writes the allotments and the placements only when the
    // plan is still the same (`token`); nobody who has a bed is moved.
    const PLAN_ATTEMPTS = 4;
    async function planOnSnapshot(snap, opts = {}) {
        const replan = opts.replan !== false, share = opts.share !== false;
        const hotelId = opts.hotelId == null ? null : Number(opts.hotelId);
        // «Rehacer todo el reparto» (`fresh`, 2.21.0 — the owner: a second suggestion after a new rule did nothing,
        // since nobody with a bed is ever moved): the plan is made on a copy where every live person of a draft
        // location, and of the pool, is out of their bed — unless the room is a frozen location's (whole or a share
        // of it), or, with a hotel chosen, in another hotel. «Aplicar» unassigns them first (`moved_ids`); today's
        // arrangement is still what the plan is measured against.
        const original = snap;
        const movedIds = [];
        if (opts.fresh) {
            const frozen0 = new Set(snap.locations.filter(isFrozen).map(l => Number(l.id)));
            const roomById = new Map(snap.rooms.map(r => [r.id, r]));
            const keepRoom = (roomId) => {
                const r = roomById.get(roomId);
                if (!r || isBlocked(r)) return true;
                if (hotelId != null && Number(r.hotel_id) !== hotelId) return true;
                if (r.location_id != null && frozen0.has(Number(r.location_id))) return true;
                return snap.roomBeds.some(b => b.room_id === roomId && frozen0.has(Number(b.location_id)));
            };
            snap = cloneSnapshot(snap);
            for (const p of snap.people) {
                if (p.room_id == null || (p.status != null && p.status === 'cancelled')) continue;
                if (p.location_id != null && frozen0.has(Number(p.location_id))) continue;
                if (isPinned(p) || keepRoom(p.room_id)) continue;
                movedIds.push({ inscription_id: p.id, room_id: p.room_id });
                p.room_id = null;
            }
        }
        const cid = snap.conferenceId;
        const live = (p) => p.status == null || p.status !== 'cancelled';
        const frozenIds = new Set(snap.locations.filter(isFrozen).map(l => Number(l.id)));
        const locName = new Map(snap.locations.map(l => [Number(l.id), l.name]));
        const occupied = new Set(snap.people.filter(p => p.room_id != null).map(p => p.room_id));
        const sharesOf = (s, roomId) => s.roomBeds.filter(b => b.room_id === roomId);
        const inHotel = (r) => hotelId == null || Number(r.hotel_id) === hotelId;
        // Who waits for a bed: every draft location with someone without one (the plan's TARGETS), and the pool.
        const targets = snap.locations.filter(l => !frozenIds.has(Number(l.id)) && snap.people.some(p => p.location_id === Number(l.id) && p.room_id == null && live(p)));
        // In ORDER: the admin's (lodging_order), then the rest by name (the snapshot's order; a stable sort).
        const rankOf = (l) => (l.lodging_order == null || l.lodging_order === '' ? Infinity : Number(l.lodging_order));
        const byRank = (a, b) => { const x = rankOf(a), y = rankOf(b); return x === y ? 0 : x < y ? -1 : 1; };
        targets.sort(byRank);
        const targetIds = new Set(targets.map(l => Number(l.id)));
        // 1. The rooms it may (re)allot: nobody inside, in the hotel chosen — a pool room, and with `replan` an
        //    empty room of a location with someone waiting (a location with nobody waiting keeps its rooms).
        const reusable = snap.rooms.filter(r => {
            if (occupied.has(r.id) || !inHotel(r) || isBlocked(r)) return false;
            const sh = sharesOf(snap, r.id);
            if (r.location_id == null && !sh.length) return true;
            if (!replan) return false;
            if (r.location_id != null) return targetIds.has(r.location_id);
            return sh.every(b => targetIds.has(b.location_id));
        });
        const reusableIds = new Set(reusable.map(r => r.id));
        const base = cloneSnapshot(snap);
        for (const r of reusable) setRoomPool(base, r.id);

        // 2. Who still needs a bed once the rooms that stay are used — the engine itself, on a copy without the free
        //    rooms, as a PROBE: a group that does not fit those rooms whole is left for the plan (never divided there).
        const probe = cloneSnapshot(base);
        probe.rooms = probe.rooms.filter(r => !reusableIds.has(r.id));
        probe.roomBeds = probe.roomBeds.filter(b => !reusableIds.has(b.room_id));
        const probeIo = snapshotAssignmentIo(probe, { delegated: targetIds });
        // A child and its adult stay one group even where only one bed is left (`maxRoom`: the plan's rooms are bigger).
        const quiet = { io: probeIo, quietCapacity: true, quietRooms: true, probe: true, maxRoom: Math.max(0, ...reusable.map(roomCapacityOf)) };
        for (const l of targets) await runAssignmentScope(cid, l.id, quiet);
        await runAssignmentScope(cid, null, { ...quiet, delegatedIds: await probeIo.delegatedIds(), frozenIds });
        // What the probe placed (people into rooms their location keeps): part of the plan, applied with it.
        const roomBefore = new Map(snap.people.map(p => [p.id, p.room_id]));
        const probePlaced = probe.people.filter(p => p.room_id != null && roomBefore.get(p.id) == null).map(p => ({ inscription_id: p.id, room_id: p.room_id }));
        // The rules as a run reads them, each location's view of them (ctxFor), and the audit (makeAuditor).
        const auditor = makeAuditor(snap);
        const { allRules, ctxFor } = auditor;
        // The fields a shared room's class binds (see «THE CLASS OF A SHARED ROOM»), and the class the plan gives one:
        // each field's one value among the people it ends with (a field none of them fills keeps the room's value).
        const lockFields = lockFieldsOf(snap.rules, snap.fieldNames);
        const lockFor = (s, roomId, prev) => {
            const inRoom = s.people.filter(p => p.room_id === roomId && live(p)).map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
            const out = [];
            for (const field of lockFields) {
                const vals = distinctValues(inRoom, field);
                if (vals.length === 1) out.push({ field, value: vals[0] });
                else if (!vals.length) { const old = prev.find(x => x.field === field); if (old) out.push(old); }
            }
            return out;
        };

        // Where each free room stood before (for the preference and the report).
        const prevOwners = (roomId) => {
            const r = snap.rooms.find(x => x.id === roomId);
            if (r && r.location_id != null) return [r.location_id];
            return sharesOf(snap, roomId).map(b => b.location_id);
        };
        const inventory = reusable.map(r => ({ room: r, cap: roomCapacityOf(r), hotel: Number(r.hotel_id), order: snap.reportOrder.indexOf(r.id) }));
        // Free beds in rooms that already hold people (a pool room, or the pool beds of a shared one — never a frozen
        // location's): the pool's people may take them, and with `share` a location too, as beds of its own there.
        const partials = probe.rooms.filter(r => r.location_id == null && !isBlocked(r) && inHotel(r) && probe.people.some(p => p.room_id === r.id) && sharesOf(probe, r.id).every(b => !frozenIds.has(b.location_id)))
            .map(r => {
                const occ = probe.people.filter(p => p.room_id === r.id).map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
                const shares = sharesOf(probe, r.id).map(b => ({ location_id: b.location_id, beds: b.beds }));
                const free = Math.max(0, Math.min(roomCapacityOf(r) - occ.length, poolBedsOf(r, shares) - poolUsedOf(shares, occ)));
                return { room: snap.rooms.find(x => x.id === r.id), cap: roomCapacityOf(r), hotel: Number(r.hotel_id), order: snap.reportOrder.indexOf(r.id), occ, shares, free, lock: shareLockOf(r, shares, lockFields) };
            }).filter(x => x.free > 0);
        const maxRoom = Math.max(0, ...inventory.map(x => x.cap), ...partials.map(x => x.free));

        const groups = [];
        const leftOf = (lid) => probe.people.filter(p => p.room_id == null && live(p) && (lid == null ? p.location_id == null : p.location_id === lid)).map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
        for (const l of targets) {
            const people = leftOf(Number(l.id));
            if (people.length) groups.push({ id: Number(l.id), name: l.name, people, ctx: ctxFor(Number(l.id)) });
        }
        const poolPeople = leftOf(null);
        if (poolPeople.length) groups.push({ id: null, name: null, people: poolPeople, ctx: ctxFor(null) });
        // Preferred mixed families as their men and their women (2.21.0), for the rounds when beds are short: first only
        // the families no free room fits exactly, then all of them.
        const exactCaps = new Set(inventory.map(x => x.cap));
        const splitLevels = [(u) => !exactCaps.has(u.people.length), true];
        for (const g of groups) {
            g.classes = scopeClasses(g.ctx, g.people, { maxRoom }).classList;
            g.split = splitLevels.map(level => {
                const alt = scopeClasses(g.ctx, g.people, { maxRoom, splitSoftMixed: level });
                const yielded = alt.units.filter(u => u.yielded).length;
                return yielded ? { classes: alt.classList, yielded } : null;
            });
        }
        // A part no free room can hold (a keep_together group bigger than every room — a family of 5 and rooms of 4,
        // or a rule misused on a whole gender): split into the fewest pieces a room holds (5 → 4 + 1), in its order,
        // so it stays as together as the rooms allow.
        const tooBig = (part) => maxRoom > 0 && part.size > maxRoom;
        const piecesOf = (whole) => {
            if (!tooBig(whole)) return [whole];
            const out = [];
            for (let i = 0; i < whole.people.length; i += maxRoom) {
                const people = whole.people.slice(i, i + maxRoom);
                out.push({ people, group: whole.group, size: people.length });
            }
            return out;
        };
        const oversizedBy = new Map();
        for (const g of groups) for (const cls of g.classes) for (const part of cls.parts) {
            if (!tooBig(part) || !part.group) continue;
            const k = `${part.group.rule.name}\u0001${String(part.group.key).toLowerCase()}`;
            if (!oversizedBy.has(k)) oversizedBy.set(k, { rule: part.group.rule.name, value: part.group.key, people: 0, largest_room: maxRoom, hard: !!part.group.rule.hard });
            oversizedBy.get(k).people += part.size;
        }
        // Beds short: more people waiting than free beds (whole free rooms and free beds next to people).
        const demand = groups.reduce((n, g) => n + g.people.length, 0);
        const supply = inventory.reduce((n, x) => n + x.cap, 0) + partials.reduce((n, x) => n + x.free, 0);
        const shortage = demand > supply;
        const rankOfGroup = new Map(groups.map((g, i) => [g.id, i]));

        const attempt = (level) => {
            // level: Map(group key → 0 normal | 1 its own rooms only | 2 … plus a spare bed per class | 3 … two)
            const taken = new Set();
            const bins = [];
            const keyOfGroup = (g) => (g.id == null ? 'pool' : String(g.id));
            const lvOf = (g) => (g.pseudo ? 0 : level.get(keyOfGroup(g)) || 0);
            const used = (b) => b.members.reduce((n, m) => n + m.size, 0);
            const groupsIn = (b) => [...new Set(b.members.map(m => m.g))];
            // The people already in a room take part in its rules as their own location's people.
            const pseudo = new Map();
            const gOf = (lid) => groups.find(g => g.id === lid) || pseudo.get(lid) || (pseudo.set(lid, { id: lid, ctx: ctxFor(lid), pseudo: true }), pseudo.get(lid));
            const partialBins = partials.map(x => ({ room: x.room, cap: x.cap, hotel: x.hotel, partial: x, members: x.occ.map(o => ({ people: [o], size: 1, g: gOf(o.location_id), fixed: true })) }));
            const added = (b) => b.members.filter(m => !m.fixed).reduce((n, m) => n + m.size, 0);
            const spareOf = (b) => (b.partial ? b.partial.free - added(b) : b.cap - used(b));
            // Every group present keeps its rules on the whole room (a conference rule sees everyone; a location's
            // own rule, its people).
            const composedOk = (members) => [...new Set(members.map(m => m.g))].every(g => g.ctx.mergedSeparateOk([], members.flatMap(m => m.people)));
            // A room that holds people and is shared keeps its class.
            const lockOk = (b, it) => !b.partial || it.people.every(p => lockAllows(b.partial.lock, p));
            // Free rooms for `g`, best first: rooms it had, then rooms in a hotel it already uses, then hotel order.
            const freeFor = (g) => {
                const hotels = new Set(bins.filter(b => b.members.some(m => m.g === g)).map(b => b.hotel));
                const rank = (x) => (g && prevOwners(x.room.id).includes(g.id) ? 0 : g && hotels.has(x.hotel) ? 1 : 2);
                return inventory.filter(x => !taken.has(x.room.id)).sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.room.id - b.room.id);
            };
            // `items` into new rooms by the engine's arithmetic; nothing is committed yet.
            const tryPack = (items, free, prefer) => {
                const res = pack.packNew(items, free.map(x => ({ x, free: x.cap })), (bin, it, inside) => composedOk(inside.concat([it])), prefer);
                const binOf = new Map();
                for (const [it, b] of res.placed) {
                    if (!binOf.has(b)) binOf.set(b, { room: b.x.room, cap: b.x.cap, hotel: b.x.hotel, members: [] });
                    binOf.get(b).members.push(it);
                }
                const out = [...binOf.values()];
                return { bins: out, left: res.left, rooms: out.length, empty: out.reduce((n, b) => n + b.cap - used(b), 0) };
            };
            const commit = (r) => { for (const b of r.bins) { bins.push(b); taken.add(b.room.id); } return r.left; };
            // Beds short: the free rooms `items` can FILL with the most beds, then the fewest rooms (lodging-pack
            // fillSets) — the people in by Best Fit Decreasing; a set they cannot fill exactly is skipped.
            const fillRooms = (items, free) => {
                const have = items.reduce((n, it) => n + it.size, 0);
                for (const set of pack.fillSets(free.map(x => x.cap), have)) {
                    const cand = set.map(i => ({ x: free[i], free: free[i].cap }));
                    const res = pack.packInto(items, cand, (bin, it, inside) => composedOk(inside.concat([it])));
                    const filled = new Map(cand.map(b => [b, 0]));
                    for (const [it, b] of res.placed) filled.set(b, filled.get(b) + it.size);
                    if (![...filled].every(([b, n]) => n === b.x.cap)) continue;
                    return { bins: cand.map(b => ({ room: b.x.room, cap: b.x.cap, hotel: b.x.hotel, members: res.placed.filter(([, x]) => x === b).map(([it]) => it) })), left: res.left };
                }
                return { bins: [], left: items };
            };
            // Spare beds before any new room: rooms the plan already fills, and the free beds of rooms that hold
            // people — where the rules allow; a location shares a room (or takes beds of a pool room) only with `share`.
            const fillSpare = (items) => {
                if (!items.length) return items;
                const cands = bins.concat(partialBins).filter(b => spareOf(b) > 0 && !groupsIn(b).some(g => lvOf(g) >= 1));
                if (!cands.length) return items;
                const mixOk = (b, it, inside) => (b.partial ? it.g.id == null || share : share || b.members.concat(inside).every(m => m.g === it.g));
                // First the companions: a room where a group's child (a hard require_companion subject) has no adult
                // takes one of that group's single adults before anyone else may take the bed.
                items = items.slice();
                for (const b of cands) {
                    for (const g of groupsIn(b)) {
                        for (const rule of g.ctx.companionRules) {
                            if (!rule.hard) continue;
                            const mine = b.members.filter(m => m.g === g).flatMap(m => m.people);
                            const view = g.ctx.viewFor(rule, mine);
                            if (!view.some(o => condMatches(rule.params.subject, o))) continue;
                            if (view.filter(o => condMatches(rule.params.needs, o)).length >= (Number(rule.params.min) || 1)) continue;
                            const k = items.findIndex(it => it.g === g && it.size === 1 && condMatches(rule.params.needs, it.people[0]) && spareOf(b) >= 1
                                && mixOk(b, it, []) && lockOk(b, it) && composedOk(b.members.concat([it])));
                            if (k >= 0) { b.members.push(items[k]); items.splice(k, 1); }
                        }
                    }
                }
                const res = pack.packInto(items, cands.map(b => ({ b, free: spareOf(b) })),
                    (x, it, inside) => mixOk(x.b, it, inside) && lockOk(x.b, it) && composedOk(x.b.members.concat(inside, [it])),
                    (x, it) => (x.b.members.some(m => m.g === it.g) ? 0 : 1));
                for (const [it, x] of res.placed) x.b.members.push(it);
                return res.left;
            };
            // Every group's parts, keyed by the CONFERENCE's hard separate_by values: a location's own rule judges
            // only its people, so it never keeps two locations apart (composedOk still holds it inside a room).
            const confHard = allRules.filter(r => r.type === 'separate_by' && r.hard && r.location_id == null);
            const MIX = '\u0002';
            const classes = new Map();
            let mixN = 0;
            for (const g of groups) {
                g.unpacked = [];
                for (const cls of g.classes) for (const whole of cls.parts) for (const part of piecesOf(whole)) {
                    const vals = confHard.map(r => { const v = distinctValues(part.people, r.field); return v.length === 0 ? '' : v.length === 1 ? v[0].toLowerCase() : MIX; });
                    const key = vals.includes(MIX) ? `${MIX}${mixN++}` : vals.join('\u0001');
                    if (!classes.has(key)) classes.set(key, { wild: vals.includes(''), size: 0, big: 0, items: [] });
                    const c = classes.get(key);
                    c.items.push({ people: part.people, group: part.group, size: part.size, g });
                    c.size += part.size;
                    c.big = Math.max(c.big, part.size);
                }
            }
            const classList = [...classes.values()].sort((a, b) => Number(a.wild) - Number(b.wild) || b.big - a.big || b.size - a.size);
            const groupOrder = (items) => [...new Set(items.map(it => it.g))].sort((a, b) => (a.id == null) - (b.id == null)
                || (shortage ? rankOfGroup.get(a.id) - rankOfGroup.get(b.id) : b.people.length - a.people.length));
            // Beds short: location by location in ORDER. First each one, in turn, takes the spare beds the plan
            // already has and only the new rooms its classes (largest part first) FILL — a bed left empty while people
            // wait is a bed lost; then, in order again, whatever is still free goes class by class. So a location
            // never loses a room it fills to a later one, and no bed stays empty that someone could use.
            if (shortage) {
                const restOf = new Map();
                for (const g of groups) {
                    const mine = classList.map(cls => cls.items.filter(it => it.g === g)).filter(items => items.length);
                    if (lvOf(g) >= 1) {
                        for (const items of mine) {
                            if (lvOf(g) >= 2) items.push({ people: [], size: lvOf(g) - 1, g, spare: true });
                            g.unpacked.push(...commit(tryPack(items, freeFor(g))).filter(it => !it.spare));
                        }
                        continue;
                    }
                    const rest = [];
                    for (const items of mine) {
                        const open = fillSpare(items);
                        if (open.length) rest.push(...commit(fillRooms(open, freeFor(g))));
                    }
                    restOf.set(g, rest);
                }
                for (const g of groups) {
                    const rest = restOf.get(g) || [];
                    for (const cls of classList) {
                        const items = rest.filter(it => cls.items.includes(it));
                        if (!items.length) continue;
                        const open = fillSpare(items);
                        if (open.length) for (const it of commit(tryPack(open, freeFor(g)))) it.g.unpacked.push(it);
                    }
                }
            }
            else for (const cls of classList) {
                const solo = cls.items.filter(it => lvOf(it.g) >= 1);
                const open = fillSpare(cls.items.filter(it => lvOf(it.g) < 1));
                // A location kept to its own rooms (a retry): its own packing, with its spare beds.
                for (const g of groupOrder(solo)) {
                    const items = solo.filter(it => it.g === g);
                    if (lvOf(g) >= 2) items.push({ people: [], size: lvOf(g) - 1, g, spare: true });
                    g.unpacked.push(...commit(tryPack(items, freeFor(g))).filter(it => !it.spare));
                }
                if (!open.length) continue;
                // Each location on rooms of its own…
                const own = { bins: [], left: [], rooms: 0, empty: 0 };
                const scratch = new Set();
                for (const g of groupOrder(open)) {
                    const r = tryPack(open.filter(it => it.g === g), freeFor(g).filter(x => !scratch.has(x.room.id)));
                    for (const b of r.bins) scratch.add(b.room.id);
                    own.bins.push(...r.bins); own.left.push(...r.left); own.rooms += r.rooms; own.empty += r.empty;
                }
                // …or the whole class together, sharing rooms (each location kept in as few rooms as it can) —
                // taken only when it leaves fewer people out, or uses fewer rooms, or leaves fewer empty beds.
                let pick = own;
                if (share && groupOrder(open).length > 1) {
                    const together = tryPack(open, freeFor(null), (bin, it, inside) => (inside.some(m => m.g === it.g) ? 0 : inside.length ? 2 : 1));
                    const outOwn = own.left.reduce((n, it) => n + it.size, 0), outTog = together.left.reduce((n, it) => n + it.size, 0);
                    if (outTog < outOwn || (outTog === outOwn && (together.rooms < own.rooms || (together.rooms === own.rooms && together.empty < own.empty)))) pick = together;
                }
                for (const it of commit(pick)) it.g.unpacked.push(it);
            }
            // Whatever is still out: the spare beds left anywhere (a class the rules allow there).
            for (const g of groups) if (lvOf(g) < 1 && g.unpacked.length) g.unpacked = fillSpare(g.unpacked);
            // A room holding only reserved spare beds is no room for anyone: left free.
            const live2 = bins.filter(b => b.members.some(m => !m.spare));
            for (const b of bins) if (!live2.includes(b)) taken.delete(b.room.id);
            // A smaller free room for the same people (fewer empty beds); same hotel first.
            for (const b of [...live2].sort((x, y) => (y.cap - used(y)) - (x.cap - used(x)) || x.room.id - y.room.id)) {
                const need = used(b);
                const owners = groupsIn(b);
                const swap = inventory.filter(x => !taken.has(x.room.id) && x.cap >= need && x.cap < b.cap)
                    .sort((x, y) => x.cap - y.cap || (x.hotel === b.hotel ? 0 : 1) - (y.hotel === b.hotel ? 0 : 1)
                        || (owners.some(g => prevOwners(x.room.id).includes(g.id)) ? 0 : 1) - (owners.some(g => prevOwners(y.room.id).includes(g.id)) ? 0 : 1)
                        || x.order - y.order)[0];
                if (!swap) continue;
                taken.delete(b.room.id); taken.add(swap.room.id);
                b.room = swap.room; b.cap = swap.cap; b.hotel = swap.hotel;
            }

            // The allotment AND the placements, on a copy. The plan places its people itself: a run left to
            // itself may give a shared room to another class than the plan meant (both fit the first location
            // swept) and push the next locations' people onto pool beds — seen live, 5 rooms planned, 7 used.
            const cand = cloneSnapshot(base);
            const at = new Map(cand.people.map(p => [p.id, p]));
            const placements = probePlaced.map(x => ({ ...x }));
            for (const x of probePlaced) at.get(x.inscription_id).room_id = x.room_id;
            const plannedRooms = [];
            const placeMembers = (b) => { for (const m of b.members) if (!m.spare && !m.fixed) for (const p of m.people) { at.get(p.id).room_id = b.room.id; placements.push({ inscription_id: p.id, room_id: b.room.id }); } };
            for (const b of live2) {
                const byLoc = new Map();
                for (const m of b.members) { if (m.spare) continue; const k = m.g.id; byLoc.set(k, (byLoc.get(k) || 0) + m.size); }
                const spare = b.members.filter(m => m.spare).reduce((n, m) => n + m.size, 0);
                const locs = [...byLoc.keys()].filter(k => k != null);
                let after;
                const spareFor = (lid) => b.members.filter(m => m.spare && m.g.id === lid).reduce((n, m) => n + m.size, 0);
                // 2.36.6, the owner's option (a): a location holds only the beds its people use. A room of one location
                // is WHOLE only when they fill it; otherwise it is shared — their beds, the rest pool beds that the next
                // people of the room's class (its «Separar por» value, the gender — see «THE CLASS OF A SHARED ROOM»)
                // may take, whatever their location. («asignó más camas que los inscritos de la localidad») With sharing
                // off («no compartir habitaciones entre localidades», `share: false`) a location's rooms stay its own.
                const full = locs.length === 1 && !byLoc.has(null) && (!share || byLoc.get(locs[0]) + spareFor(locs[0]) >= b.cap);
                if (!locs.length) after = { kind: 'pool' };
                else if (full) { after = { kind: 'whole', location_id: locs[0] }; setRoomWhole(cand, b.room.id, locs[0]); }
                else {
                    // Shared: each location its people's beds (its spare beds too); the rest are pool beds.
                    const shares = locs.map(lid => ({ location_id: lid, beds: byLoc.get(lid) + spareFor(lid) }));
                    after = { kind: 'shared', shares };
                    setRoomShares(cand, b.room.id, shares);
                }
                placeMembers(b);
                plannedRooms.push({ room: b.room, cap: b.cap, after, members: [...byLoc].map(([lid, n]) => ({ location_id: lid, count: n })), spare, added: used(b) - spare,
                    labels: [...new Set(b.members.filter(m => !m.spare).map(m => classLabel(m.g.ctx, m.people)).filter(Boolean))] });
            }
            // A room that already held people: a location that takes beds there gets them as its share (its people
            // already on pool beds there count in it, as «Dar camas» does); the pool's people use pool beds.
            for (const b of partialBins) {
                if (!added(b)) continue;
                const shares = b.partial.shares.map(x => ({ ...x }));
                const newBy = new Map();
                for (const m of b.members) if (!m.fixed && m.g.id != null) newBy.set(m.g.id, (newBy.get(m.g.id) || 0) + m.size);
                for (const [lid, n] of newBy) {
                    const prev = shareBedsOf(shares, lid);
                    const own = b.partial.occ.filter(o => o.location_id === lid).length;
                    const total = prev + Math.max(0, own - prev) + n;
                    const x = shares.find(y => y.location_id === lid);
                    if (x) x.beds = total; else shares.push({ location_id: lid, beds: total });
                }
                const after = shares.length ? { kind: 'shared', shares } : { kind: 'pool' };
                if (newBy.size) setRoomShares(cand, b.room.id, shares);
                placeMembers(b);
                const byLoc = new Map();
                for (const m of b.members) byLoc.set(m.g.id, (byLoc.get(m.g.id) || 0) + m.size);
                plannedRooms.push({ room: b.room, cap: b.cap, after, members: [...byLoc].map(([lid, n]) => ({ location_id: lid, count: n })), spare: 0, added: added(b), partial: true,
                    labels: [...new Set(b.members.filter(m => !m.fixed).map(m => classLabel(m.g.ctx, m.people)).filter(Boolean))] });
            }
            // Each room the plan shares keeps the class it gives it (the run after the plan, and every bed of it later).
            for (const pr of plannedRooms) {
                if (pr.after.kind !== 'shared') continue;
                pr.after.lock = lockFor(cand, pr.room.id, pr.partial ? shareLockOf(pr.room, sharesOf(snap, pr.room.id), lockFields) : []);
                const r = cand.rooms.find(x => x.id === pr.room.id);
                if (r) r.share_lock = pr.after.lock.length ? JSON.stringify(pr.after.lock) : null;
            }
            placements.sort((x, y) => x.inscription_id - y.inscription_id);
            const unplacedBy = new Map(groups.map(g => [g.id, g.unpacked.reduce((n, it) => n + it.size, 0)]));
            return { cand, plannedRooms, placements, unplacedBy };
        };
        // A class's display: the values of the hard separate_by fields its people share («Masculino»).
        function classLabel(ctx, people) {
            return ctx.hardSeparate.map(r => distinctValues(people, r.field)).filter(v => v.length === 1).map(v => v[0]).join(' · ');
        }
        // The people the plan is about: the targets' and the pool's (frozen locations are left as they are).
        const isTouched = (p) => live(p) && (p.location_id == null ? true : targetIds.has(p.location_id));
        // What an arrangement gives them once the automatic assignment has placed whoever is still without a bed —
        // which is what «Aplicar» does: the plan, then the run (the same engine, here on a copy).
        const settle = async (S) => { const { snap: done } = await simulateSweep(S); return { done, m: auditor.measure(done, isTouched) }; };
        // Lexicographic: fewer hard breaches, then fewer people without a bed, then fewer rooms, then fewer empty beds.
        const lexLess = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k]; return false; };
        const groupKey = (g) => (g.id == null ? 'pool' : String(g.id));
        const runAttempts = async () => {
        const level = new Map();
        let best = null;
        for (let i = 0; i < PLAN_ATTEMPTS; i++) {
            const a = attempt(level);
            const { done, m } = await settle(a.cand);
            // A breach belongs to the locations with people in its room; a location left without beds is trouble too.
            const inRoom = (roomId) => new Set(done.people.filter(p => p.room_id === roomId).map(p => p.location_id));
            const outOf = (g) => done.people.filter(p => isTouched(p) && p.room_id == null && (g.id == null ? p.location_id == null : p.location_id === g.id)).length;
            // Beds short: someone is left out whatever the plan; only a broken hard rule is worth another attempt.
            const trouble = groups.filter(g => (!shortage && outOf(g) > 0) || m.audit.hard.some(v => (v.room_id != null ? inRoom(v.room_id).has(g.id) : (v.location_ids || []).includes(g.id))));
            // Beds short: the locations in order — fewer without a bed in an earlier one wins before rooms and empty beds.
            const score = [m.hard, m.unplaced, ...(shortage ? groups.map(outOf) : []), m.rooms, m.empty_beds];
            if (!best || lexLess(score, best.score)) best = { ...a, m, done, score };
            if (!trouble.length) break;
            let raised = false;
            for (const g of trouble) { const k = groupKey(g); const lv = level.get(k) || 0; if (lv < 3) { level.set(k, lv + 1); raised = true; } }
            if (!raised) break;
        }
        return best;
        };
        // The attempts with the preferred mixed families of a split level as their men and their women (computed once).
        const splitRuns = [];
        const runSplit = async (lv) => {
            if (splitRuns[lv] === undefined) {
                const splitGroups = groups.filter(g => g.split[lv]);
                if (!splitGroups.length) splitRuns[lv] = null;
                else {
                    for (const g of splitGroups) { g.classesWhole = g.classes; g.classes = g.split[lv].classes; }
                    const run = await runAttempts();
                    for (const g of splitGroups) g.classes = g.classesWhole;
                    splitRuns[lv] = { run, yielded: splitGroups.reduce((n, g) => n + g.split[lv].yielded, 0) };
                }
            }
            return splitRuns[lv];
        };
        let best = await runAttempts();
        // Someone still without a bed and a preferred mixed family whose room is its own (2.21.0; the owner: «que ceda
        // si falta cama»): the attempts again with such families as their men and their women.
        for (let lv = 0; lv < splitLevels.length && best.m.unplaced > 0; lv++) {
            const s = await runSplit(lv);
            if (s && s.run.score[0] <= best.score[0] && s.run.score[1] < best.score[1]) best = s.run;
        }
        // «DIVIDIR FAMILIAS» (2.21.0; the owner: «que lo de dividir las familias sea una opción, que calcule ambos, le
        // diga al admin cuántas habitaciones serían en ambos casos y en el caso que se dividen las familias diga cuántas
        // se dividieron»). Two answers, both always computed, each the best of every arrangement the plan computed:
        //   KEEP   — [hard, unplaced, (location order), families divided, rooms, empty beds]: a family is divided only
        //            when that gives someone a bed;
        //   DIVIDE — [hard, unplaced, (location order), rooms, families divided, empty beds]: preferred mixed families may
        //            go as their men and their women to use fewer rooms.
        // Only with beds enough: when they are short every free room is used anyway (KEEP alone, as before).
        // FAMILIES: the groups of the preferred rules whose mixed groups can yield, one per location (a conference
        // rule's «Pérez» in two locations are two families), of at least min_size people. Divided: its people sleep in
        // more than one room, or some have a bed and some do not.
        const yieldRuleIds = new Set();
        for (const g of groups) for (const u of scopeClasses(g.ctx, g.people, { maxRoom, splitSoftMixed: true }).units) if (u.yielded) yieldRuleIds.add(u.group.rule.id);
        const yieldRules = allRules.filter(r => yieldRuleIds.has(r.id));
        const dividedOf = new Map();
        const familiesDivided = (c) => {
            if (dividedOf.has(c)) return dividedOf.get(c);
            const fams = new Map();
            for (const p0 of c.done.people) {
                if (!isTouched(p0)) continue;
                const p = { ...p0, custom_data: parseCd(p0.custom_data) };
                for (const rule of yieldRules) {
                    if (!condMatches(rule.params.when, p)) continue;
                    const v = ruleVal(p, rule.field);
                    if (v == null || String(v).trim() === '') continue;
                    const k = `${rule.id}|${p.location_id == null ? '' : p.location_id}|${String(v).trim().toLowerCase()}`;
                    if (!fams.has(k)) fams.set(k, { min: Number(rule.params.min_size) || 1, n: 0, rooms: new Set(), out: 0 });
                    const fam = fams.get(k);
                    fam.n++;
                    if (p.room_id == null) fam.out++; else fam.rooms.add(p.room_id);
                }
            }
            let n = 0;
            for (const fam of fams.values()) if (fam.n >= fam.min && (fam.rooms.size > 1 || (fam.rooms.size === 1 && fam.out > 0))) n++;
            dividedOf.set(c, n);
            return n;
        };
        // Last, the preferences broken (`soft`): between arrangements alike in everything else, the one that keeps more.
        const keepKey = (c) => [...c.score.slice(0, -2), familiesDivided(c), ...c.score.slice(-2), c.m.soft];
        const divideKey = (c) => [...c.score.slice(0, -1), familiesDivided(c), c.score[c.score.length - 1], c.m.soft];
        const candidates = [best];
        const consider = (c) => { if (c && !candidates.includes(c)) candidates.push(c); };
        for (const s of splitRuns) if (s) consider(s.run);
        const bestBy = (key) => candidates.reduce((a, b) => (lexLess(key(b), key(a)) ? b : a));
        let divideBest = null;
        if (!shortage && yieldRules.length) {
            const all = await runSplit(splitLevels.length - 1);
            consider(all && all.run);
            divideBest = bestBy(divideKey);
            // The families that could be divided, in the order they are best kept whole — those a free room fits exactly
            // first (no bed lost), then the larger first — and two searches over how many of them, in that order, stay
            // whole (each try is one more set of attempts, shared by both searches):
            //   DIVIDE: the most kept whole without needing more rooms than the best divided answer;
            //   KEEP:   the most kept whole without leaving more people without a bed (or a location earlier in the order).
            // Fewer tries for a big event — by its size, never by the clock: «Aplicar» re-plans and must find the very
            // same answer.
            const tries = demand <= 1200 ? 16 : demand <= 2000 ? 3 : 0;
            if (tries) {
                const famId = (g, u) => `${g.id == null ? 'pool' : g.id}|${u.group.rule.id}|${String(u.group.key).trim().toLowerCase()}`;
                const order = [];
                for (const g of groups) for (const u of scopeClasses(g.ctx, g.people, { maxRoom, splitSoftMixed: true }).units) if (u.yielded) order.push({ id: famId(g, u), size: u.people.length, exact: exactCaps.has(u.people.length) });
                order.sort((x, y) => Number(y.exact) - Number(x.exact) || y.size - x.size || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
                const tried = new Map();
                const keeping = async (k) => {
                    if (tried.has(k)) return tried.get(k);
                    const whole = new Set(order.slice(0, k).map(x => x.id));
                    for (const g of groups) { g.classesWhole = g.classes; g.classes = scopeClasses(g.ctx, g.people, { maxRoom, splitSoftMixed: (u) => !whole.has(famId(g, u)) }).classList; }
                    const run = await runAttempts();
                    for (const g of groups) g.classes = g.classesWhole;
                    tried.set(k, run);
                    consider(run);
                    return run;
                };
                // The largest k (in at most `tries` steps) whose answer still `fits`.
                const most = async (fits) => {
                    let lo = 0, hi = order.length;
                    for (let t = tries; lo < hi && t > 0; t--) {
                        const mid = Math.ceil((lo + hi) / 2);
                        if (fits(await keeping(mid))) lo = mid; else hi = mid - 1;
                    }
                };
                // [hard, unplaced, (location order), rooms] and [hard, unplaced, (location order)].
                const upToRooms = (c) => c.score.slice(0, -1);
                const upToBeds = (c) => c.score.slice(0, -2);
                if (familiesDivided(divideBest) > 0) {
                    const target = upToRooms(divideBest);
                    await most((run) => !lexLess(target, upToRooms(run)));
                }
                const keepNow = bestBy(keepKey);
                if (familiesDivided(keepNow) > 0) {
                    const target = upToBeds(bestBy((c) => upToBeds(c)));
                    await most((run) => !lexLess(target, upToBeds(run)));
                }
            }
            divideBest = bestBy(divideKey);
        }
        // TODAY is an answer too (2.21.0; the owner, on a suggestion for one hotel that used 180 rooms and left 5 beds
        // empty where today's arrangement used 179 with none: «revísalo»): leaving everything as it is — no room allotted
        // or released, nobody moved, the automatic assignment for whoever waits — is scored like the arrangements the
        // plan tried, and replaces an answer it beats on that answer's own key (families together, or divided). On a tie
        // it replaces an answer that would move someone who has a bed, or change nothing at all (moving people for nothing
        // gains nothing); an answer that moves nobody and only gives out or back empty rooms keeps the tie. The plan never
        // suggests something worse than what there is: when nothing beats today, the suggestion is to leave it
        // (`keeps_today`; nothing to apply but the automatic assignment for whoever waits). And only as an allotment at
        // least as good as the answer it replaces: of the people whose beds the plan decides (whoever waits; with
        // «Rehacer todo», whoever it took out of a bed — the others are where they are in every answer), no more in a
        // room that is not their location's (the pool's people: not in a pool room) — not a pool where locations mix,
        // before the rooms are given out.
        const today = await settle(original);
        const decided = new Set(snap.people.filter(p => isTouched(p) && p.room_id == null).map(p => p.id));
        const offAllot = new Map();
        const offAllotOf = (c) => {
            if (offAllot.has(c)) return offAllot.get(c);
            const S = c.done, byId = new Map(S.rooms.map(r => [r.id, r]));
            let n = 0;
            for (const p of S.people) {
                if (!decided.has(p.id) || p.room_id == null) continue;
                const r = byId.get(p.room_id);
                if (!r) continue;
                const theirs = p.location_id == null ? r.location_id == null
                    : Number(r.location_id) === Number(p.location_id) || sharesOf(S, r.id).some(b => Number(b.location_id) === Number(p.location_id));
                if (!theirs) n++;
            }
            offAllot.set(c, n);
            return n;
        };
        const allotmentOf = (S) => JSON.stringify([S.rooms.map(r => [r.id, r.location_id == null ? null : Number(r.location_id)]).sort((x, y) => x[0] - y[0]),
            S.roomBeds.map(b => [b.room_id, Number(b.location_id), Number(b.beds) || 0]).sort((x, y) => x[0] - y[0] || x[1] - y[1])]);
        const movesOf = (c) => { const at = new Map(c.done.people.map(p => [p.id, p.room_id])); return movedIds.filter(x => at.get(x.inscription_id) !== x.room_id).length; };
        const outToday = (g) => today.done.people.filter(p => isTouched(p) && p.room_id == null && (g.id == null ? p.location_id == null : p.location_id === g.id)).length;
        const todayC = { today: true, cand: original, done: today.done, m: today.m, plannedRooms: [], placements: [],
            score: [today.m.hard, today.m.unplaced, ...(shortage ? groups.map(outToday) : []), today.m.rooms, today.m.empty_beds] };
        const orToday = (c, key) => {
            if (offAllotOf(todayC) > offAllotOf(c)) return c;
            const kt = key(todayC), kc = key(c);
            if (lexLess(kt, kc)) return todayC;
            if (lexLess(kc, kt)) return c;
            return movesOf(c) > 0 || allotmentOf(c.done) === allotmentOf(today.done) ? todayC : c;
        };
        if (divideBest) divideBest = orToday(divideBest, divideKey);
        const keepBest = orToday(bestBy(keepKey), keepKey);
        best = opts.divideFamilies && divideBest ? divideBest : keepBest;
        // The rooms as the sheet shows them (2.21.0; the owner: «¿no deberían quedar las mismas camas vacías? Lo que debería
        // cambiar es el número de habitaciones vacías»), per answer: the rooms used and their empty beds, the rooms nobody
        // is in and their beds, all of one set — the rooms the plan may fill (in the hotel chosen, not blocked: a pool room,
        // a room of a location with someone waiting, a shared room with pool beds or such a location's share), and any
        // other room holding the people it places (another hotel's, a blocked one…), used. Two answers that bed the same
        // people leave the same beds over: together, a family's room keeps the beds it does not fill; divided, they gather
        // into rooms nobody needs. (`rooms` / `empty_beds` stay the plan's own measure, the rooms holding its people.)
        const reach = snap.rooms.filter(r => {
            if (!inHotel(r) || isBlocked(r)) return false;
            if (r.location_id != null) return targetIds.has(Number(r.location_id));
            const sh = sharesOf(snap, r.id);
            return !sh.length || sh.some(b => targetIds.has(Number(b.location_id))) || sh.reduce((n, b) => n + (Number(b.beds) || 0), 0) < roomCapacityOf(r);
        });
        const reachIds = new Set(reach.map(r => r.id));
        const roomsViewOf = (done) => {
            const inRoom = new Map(), theirs = new Set();
            for (const p of done.people) {
                if (p.room_id == null || !live(p)) continue;
                inRoom.set(p.room_id, (inRoom.get(p.room_id) || 0) + 1);
                if (isTouched(p)) theirs.add(p.room_id);
            }
            const v = { used_rooms: 0, used_empty_beds: 0, free_rooms: 0, free_beds: 0 };
            for (const r of reach) {
                const n = inRoom.get(r.id) || 0;
                if (n) { v.used_rooms++; v.used_empty_beds += Math.max(0, roomCapacityOf(r) - n); } else { v.free_rooms++; v.free_beds += roomCapacityOf(r); }
            }
            for (const r of done.rooms) if (!reachIds.has(r.id) && theirs.has(r.id)) { v.used_rooms++; v.used_empty_beds += Math.max(0, roomCapacityOf(r) - inRoom.get(r.id)); }
            return v;
        };
        const variantOf = (c) => ({ hard: c.m.hard, unplaced: c.m.unplaced, rooms: c.m.rooms, empty_beds: c.m.empty_beds, ...roomsViewOf(c.done), families_divided: familiesDivided(c), today: !!c.today });
        // Today, without the plan: the current allotment and the automatic assignment (the same engine, on a copy).
        const current = { ...today.m, ...roomsViewOf(today.done) };

        // The report: every room the plan fills or frees, every location it plans for, every placement.
        const before = (roomId) => {
            const r = snap.rooms.find(x => x.id === roomId);
            const sh = sharesOf(snap, roomId);
            if (r.location_id != null) return { kind: 'whole', location_id: r.location_id };
            if (sh.length) return { kind: 'shared', shares: sh.map(b => ({ location_id: b.location_id, beds: b.beds })), lock: shareLockOf(r, sh, lockFields) };
            return { kind: 'pool' };
        };
        const sameAllot = (x, y) => JSON.stringify(x) === JSON.stringify(y);
        const roomOut = (r) => ({ room_id: r.id, room_number: r.room_number, hotel_id: Number(r.hotel_id), hotel_name: r.hotel_name, capacity: roomCapacityOf(r) });
        const named = (a) => (a.kind === 'whole' ? { ...a, location_name: locName.get(a.location_id) || null }
            : a.kind === 'shared' ? { ...a, shares: a.shares.map(x => ({ ...x, location_name: locName.get(x.location_id) || null })) } : a);
        const usedIds = new Set(best.plannedRooms.map(p => p.room.id));
        const rooms = best.plannedRooms.map(p => {
            const b = before(p.room.id);
            return { ...roomOut(p.room), before: named(b), after: named(p.after), changed: !sameAllot(b, p.after), had_people: !!p.partial, added: p.added,
                people: p.members.map(m => ({ location_id: m.location_id, location_name: m.location_id == null ? null : locName.get(m.location_id) || null, count: m.count })),
                labels: p.labels, empty_beds: p.cap - p.members.reduce((n, m) => n + m.count, 0) };
        }).sort((x, y) => snap.reportOrder.indexOf(x.room_id) - snap.reportOrder.indexOf(y.room_id));
        // Today's answer releases nothing either.
        const released = best.today ? [] : reusable.filter(r => !usedIds.has(r.id) && before(r.id).kind !== 'pool').map(r => ({ ...roomOut(r), before: named(before(r.id)), after: { kind: 'pool' } }));
        const keptOf = (lid) => probePlaced.filter(x => (snap.people.find(p => p.id === x.inscription_id) || {}).location_id === lid).length;
        const all = [...best.m.audit.hard, ...best.m.audit.soft];
        // After the plan and the run: who is still without a bed, and how many the run places after the plan.
        const outAfter = (lid) => best.done.people.filter(p => isTouched(p) && p.room_id == null && (lid == null ? p.location_id == null : p.location_id === lid)).length;
        const inCand = new Map(best.cand.people.map(p => [p.id, p.room_id]));
        const runPlaced = best.done.people.filter(p => isTouched(p) && p.room_id != null && inCand.get(p.id) == null).length;
        const waiting = best.cand.people.filter(p => isTouched(p) && p.room_id == null).length;
        // Today's answer plans no room: each location as today's arrangement has it (the rooms its people are in, its
        // beds there, who is still without one).
        const todayRow = (lid) => {
            const S = today.done, theirs = S.people.filter(p => isTouched(p) && (lid == null ? p.location_id == null : p.location_id === lid));
            const roomIds = [...new Set(theirs.filter(p => p.room_id != null).map(p => p.room_id))];
            let beds = 0, shared = 0;
            for (const id of roomIds) {
                const r = S.rooms.find(x => x.id === id), sh = sharesOf(S, id), own = sh.find(b => Number(b.location_id) === lid);
                if (lid != null && r && Number(r.location_id) === lid) beds += roomCapacityOf(r);
                else if (own) { beds += Number(own.beds) || 0; shared++; } else beds += theirs.filter(p => p.room_id === id).length;
            }
            return { people: theirs.length, rooms: roomIds.length, beds, shared_rooms: shared, unplaced: outAfter(lid) };
        };
        const poolToday = best.today ? todayRow(null) : null;
        const locations = targets.map(l => {
            const lid = Number(l.id);
            if (best.today) return { location_id: lid, name: l.name, kept: 0, ...todayRow(lid),
                violations: all.filter(v => v.location_id === lid || (v.location_ids || []).includes(lid)).map(({ rule, detail, hard }) => ({ rule, detail, hard })) };
            const g = groups.find(x => x.id === lid);
            const mine = rooms.filter(r => r.people.some(m => m.location_id === lid));
            return {
                location_id: lid, name: l.name, people: (g ? g.people.length : 0) + keptOf(lid), kept: keptOf(lid),
                rooms: mine.length, beds: mine.reduce((n, r) => n + (r.after.kind === 'whole' ? r.capacity : ((r.after.shares || []).find(x => x.location_id === lid) || {}).beds || 0), 0),
                shared_rooms: mine.filter(r => r.after.kind === 'shared').length,
                unplaced: outAfter(lid),
                violations: all.filter(v => v.location_id === lid || (v.location_ids || []).includes(lid)).map(({ rule, detail, hard }) => ({ rule, detail, hard })),
            };
        }).filter(l => l.people > 0);
        // The draft locations with everyone in a bed (not touched): listed too, with the rules today's arrangement
        // breaks for their people — a rule added since shows here, and «Rehacer todo» is what fixes it.
        const targetSet = new Set(targets.map(l => Number(l.id)));
        const settledLocs = snap.locations.filter(l => !frozenIds.has(Number(l.id)) && !targetSet.has(Number(l.id))).sort(byRank);
        if (settledLocs.length) {
            const settledIds = new Set(settledLocs.map(l => Number(l.id)));
            const seen = auditor.measure(today.done, (p) => live(p) && p.location_id != null && settledIds.has(p.location_id));
            const settledAll = [...seen.audit.hard, ...seen.audit.soft];
            for (const l of settledLocs) {
                const lid = Number(l.id);
                const theirs = original.people.filter(p => live(p) && p.location_id === lid);
                if (!theirs.length) continue;
                locations.push({
                    location_id: lid, name: l.name, people: theirs.length, kept: 0, settled: true,
                    rooms: new Set(theirs.map(p => p.room_id)).size, beds: theirs.length, shared_rooms: 0, unplaced: 0,
                    violations: settledAll.filter(v => v.location_id === lid || (v.location_ids || []).includes(lid)).map(({ rule, detail, hard }) => ({ rule, detail, hard })),
                });
            }
        }
        const pool = groups.find(g => g.id == null);
        const changes = [...rooms.filter(r => r.changed).map(r => ({ room_id: r.room_id, after: r.after.kind === 'whole' ? { kind: 'whole', location_id: r.after.location_id } : r.after.kind === 'shared' ? { kind: 'shared', shares: r.after.shares.map(x => ({ location_id: x.location_id, beds: x.beds })), lock: r.after.lock || [] } : { kind: 'pool' } })),
            ...released.map(r => ({ room_id: r.room_id, after: { kind: 'pool' } }))].sort((x, y) => x.room_id - y.room_id);
        const after = { hard: best.m.hard, unplaced: best.m.unplaced, rooms: best.m.rooms, empty_beds: best.m.empty_beds, ...roomsViewOf(best.done) };
        // A proof where there is one (2.21.0; the owner: «¿el motor me puede demostrar matemáticamente que esa siempre
        // va a ser la mejor acomodación?»). A proof for every case is out of reach — placing people in rooms under
        // rules is NP-hard — but two bounds hold for ANY arrangement, ignoring every rule: nobody beds more people than
        // there are beds for them, and P people need at least as many rooms as the biggest rooms reaching P beds. A
        // plan that reaches a bound (with no hard rule broken) is proven the best possible on that count.
        let proof = null;
        if (hotelId == null) {
            const touched = snap.people.filter(isTouched);
            const others = new Map();
            for (const p of snap.people) if (p.room_id != null && live(p) && !isTouched(p)) others.set(p.room_id, (others.get(p.room_id) || 0) + 1);
            const caps = [];
            for (const r of snap.rooms) {
                if (r.location_id != null && frozenIds.has(Number(r.location_id))) continue;
                // A blocked room holds only who is in it.
                if (isBlocked(r)) { const held = snap.people.filter(p => p.room_id === r.id && live(p) && isTouched(p)).length; if (held > 0) caps.push(held); continue; }
                const frozenBeds = sharesOf(snap, r.id).filter(b => frozenIds.has(Number(b.location_id))).reduce((n, b) => n + (Number(b.beds) || 0), 0);
                const usable = roomCapacityOf(r) - Math.max(others.get(r.id) || 0, frozenBeds);
                if (usable > 0) caps.push(usable);
            }
            const beds = caps.reduce((n, c) => n + c, 0);
            const unplacedMin = Math.max(0, touched.length - beds);
            const placedNow = touched.length - best.m.unplaced;
            caps.sort((a, b) => b - a);
            let roomsMin = 0;
            for (let sum = 0; sum < placedNow && roomsMin < caps.length; roomsMin++) sum += caps[roomsMin];
            const bedsOptimal = best.m.hard === 0 && best.m.unplaced === unplacedMin;
            proof = { people: touched.length, beds, unplaced_min: unplacedMin, rooms_min: roomsMin, beds_optimal: bedsOptimal, rooms_optimal: bedsOptimal && best.m.rooms === roomsMin };
        }
        // «Rehacer todo»: who actually changes bed (the others are put back where they were).
        const finalRoom = new Map(best.done.people.map(p => [p.id, p.room_id]));
        const moved = opts.fresh && !best.today ? movedIds.filter(x => finalRoom.get(x.inscription_id) !== x.room_id).length : 0;
        const movedOut = best.today ? [] : movedIds;
        return {
            options: { replan, share, hotel_id: hotelId, fresh: !!opts.fresh, divide_families: !!(opts.divideFamilies && divideBest) },
            // What the administration holds and the plan leaves as it is (see «HELD BY THE ADMINISTRATION»).
            held: { rooms: snap.rooms.filter(r => inHotel(r) && isBlocked(r)).length, people: snap.people.filter(p => live(p) && isPinned(p) && snap.rooms.some(r => r.id === p.room_id && inHotel(r))).length },
            // «Dividir familias»: both answers (see «DIVIDIR FAMILIAS»), whichever is the plan below; null when no
            // preferred family could be divided or beds are short. `same`: the engine found nothing better by dividing.
            variants: divideBest ? { chosen: opts.divideFamilies ? 'divide' : 'keep', keep: variantOf(keepBest), divide: variantOf(divideBest), same: divideBest === keepBest } : null,
            // «Rehacer todo»: everyone the plan takes out of a bed before placing (`moved_ids`), and how many end up
            // in another bed or none (`moved`).
            moved, moved_ids: movedOut,
            // Nothing the plan found beats today's arrangement: the suggestion is to leave it (see «TODAY is an answer too»).
            keeps_today: !!best.today,
            // The order the locations get beds in when they do not reach everyone, and whether they do not (`short`).
            // Every location, in order (so the arrows keep each one's place): `state` waiting (people without a bed),
            // settled (everyone in a bed — not touched unless «Rehacer todo») or frozen (submitted / validated).
            order: [...snap.locations].sort(byRank).map(l => ({ location_id: Number(l.id), name: l.name,
                state: frozenIds.has(Number(l.id)) ? 'frozen' : targetSet.has(Number(l.id)) ? 'waiting' : 'settled' })),
            short: shortage ? { people: demand, beds: supply } : null,
            oversized: [...oversizedBy.values()],
            // The families this plan divides (see «DIVIDIR FAMILIAS»: one per location, of a rule whose groups can yield).
            families_split: yieldRules.length ? familiesDivided(best) : 0,
            // The bounds no arrangement beats, and whether this plan reaches them (see «A proof where there is one»).
            proof,
            people: best.today ? snap.people.filter(p => isTouched(p) && p.room_id == null).length : best.placements.length + waiting, kept: best.today ? 0 : probePlaced.length,
            rooms, released, locations,
            pool: poolToday ? (poolToday.people ? { people: poolToday.people, rooms: poolToday.rooms, unplaced: poolToday.unplaced } : null) : pool || keptOf(null) ? { people: (pool ? pool.people.length : 0) + keptOf(null), rooms: rooms.filter(r => r.people.some(m => m.location_id == null)).length, unplaced: outAfter(null) } : null,
            totals: { rooms: rooms.length, beds: rooms.reduce((n, r) => n + r.capacity, 0), empty_beds: rooms.reduce((n, r) => n + r.empty_beds, 0), shared: rooms.filter(r => r.after.kind === 'shared').length, changed: changes.length },
            outcome: {
                // `run_placed`: people the automatic assignment places after the plan (with «Aplicar» too).
                placed: best.placements.length, run_placed: runPlaced, unplaced: best.m.unplaced, hard: best.m.hard,
                violations: all.slice(0, 200).map(({ rule, detail, hard }) => ({ rule, detail, hard })),
            },
            // Today (the current allotment and the automatic assignment) against the plan (and the automatic
            // assignment for whoever it leaves), for the same people; `worse`: more hard rules broken or more people
            // without a bed than today — never applied.
            current: { hard: current.hard, unplaced: current.unplaced, rooms: current.rooms, empty_beds: current.empty_beds,
                used_rooms: current.used_rooms, used_empty_beds: current.used_empty_beds, free_rooms: current.free_rooms, free_beds: current.free_beds },
            after,
            worse: lexLess([current.hard, current.unplaced], [after.hard, after.unplaced]),
            skipped_frozen: snap.locations.filter(isFrozen).map(l => ({ location_id: l.id, name: l.name, status: lodgingStatusOf(l) })),
            changes, placements: best.placements,
            token: planToken({ changes, placements: best.placements, waiting: snap.people.filter(p => isTouched(p) && p.room_id == null).map(p => p.id), moved: movedOut }),
        };
    }
    // The plan's identity (FNV-1a over its changes, its placements and who was waiting): «Aplicar» writes only the
    // plan the admin saw — a registration since, even one the plan leaves to the automatic run, changes it.
    function planToken(plan) {
        const text = JSON.stringify(plan);
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return `${plan.changes.length}-${plan.placements.length}-${h.toString(16)}`;
    }
    // Write a plan (callers hold withAssignmentLock and re-planned under it): the allotments, then the people —
    // only those still without a bed.
    async function applyPlanChanges(changes, placements = []) {
        const writes = [];
        for (const c of changes) {
            writes.push([`DELETE FROM ${T.roomBeds} WHERE room_id = ?`, [c.room_id]]);
            if (c.after.kind === 'whole') writes.push([`UPDATE ${T.rooms} SET location_id = ?, share_lock = NULL, allot_source = 'plan' WHERE id = ?`, [c.after.location_id, c.room_id]]);
            else {
                // A shared room's class (see «THE CLASS OF A SHARED ROOM»); a pool room has none.
                const lock = c.after.kind === 'shared' && c.after.lock && c.after.lock.length ? JSON.stringify(c.after.lock) : null;
                writes.push([`UPDATE ${T.rooms} SET location_id = NULL, share_lock = ?, allot_source = NULL WHERE id = ?`, [lock, c.room_id]]);
                if (c.after.kind === 'shared') for (const x of c.after.shares) writes.push([`INSERT INTO ${T.roomBeds} (room_id, location_id, beds, allot_source) VALUES (?, ?, ?, 'plan')`, [c.room_id, x.location_id, x.beds]]);
            }
        }
        for (const x of placements) writes.push([`UPDATE ${T.inscriptions} SET room_id = ?, room_locked = NULL WHERE id = ? AND room_id IS NULL AND ${lodgingSql()}`, [x.room_id, x.inscription_id]]);
        await runBatched(writes);
    }

    // ── arrangement audit (pure — no db) ──────────────────────────────────────────────────────────
    // `rooms[i].occupants` and `unassigned` are full attendee rows (custom_data parsed); `rules` are
    // stored rows or parsed rules (only enabled ones count). Returns every rule the CURRENT arrangement
    // breaks plus over-capacity rooms, and the headline counts. Shared by the admin review and the portal.
    // `placed_elsewhere` (L's attendees the admin put in a pool/foreign room) only take part in the
    // keep_together check — a group split between scopes IS split — through a synthetic room each;
    // they never count as `placed`.
    function auditArrangement({ rooms = [], unassigned = [], rules = [], placed_elsewhere = [] }) {
        const parsed = rankRules(rules.map(r => (r.field !== undefined && typeof r.hard === 'boolean' ? r : parseRuleRow(r))).filter(r => r.enabled !== false));
        const keepRules = parsed.filter(r => r.type === 'keep_together');
        const violations = [];
        const note = (rule, detail, hard) => { if (!violations.some(v => v.rule === rule && v.detail === detail)) violations.push({ rule, detail, hard: !!hard }); };
        const label = (room) => `Habitación ${room.room_number || room.id}`;
        const companionRules = parsed.filter(r => r.type === 'require_companion');
        for (const room of rooms) {
            const occ = Array.isArray(room.occupants) ? room.occupants : [];
            for (const rule of parsed) {
                if (rule.type !== 'separate_by' || !rule.field) continue;
                const values = distinctValues(judgedBy(rule, occ, keepRules), rule.field);
                if (values.length > 1) note(rule.name, `${label(room)}: mezcla ${values.length} valores de «${rule.field}» (${values.join(', ')}).`, rule.hard);
            }
            for (const rule of companionUnmetIn(companionRules, occ)) note(rule.name, `${label(room)}: no se cumplió «${rule.name}».`, rule.hard);
            const cap = Math.max(1, Number(room.capacity) || 1);
            const n = room.occupied != null ? Math.max(Number(room.occupied) || 0, occ.length) : occ.length;
            if (n > cap) note('capacidad', `${label(room)}: ${n} ocupantes para ${cap} camas.`, true);
        }
        // keep_together: a group (case-insensitive value of the field, `when` honoured, size ≥ min_size)
        // whose members sit in more than one room, or in a room while others are still unassigned.
        const everyone = [];
        for (const room of rooms) for (const o of (room.occupants || [])) everyone.push({ p: o, room });
        for (const p of unassigned) everyone.push({ p, room: null });
        for (const p of placed_elsewhere) {
            everyone.push({ p, room: { id: `x${p.room_id}`, room_number: `${p.hotel_name ? p.hotel_name + ' ' : ''}${p.room_number || p.room_id}` } });
        }
        for (const rule of parsed) {
            if (rule.type !== 'keep_together' || !rule.field) continue;
            const min = Number(rule.params.min_size) || 1;
            // A hard separate_by that outranks this rule divides its groups on purpose: judge each block
            // of members that share those fields' values separately (a family split by gender is fine;
            // the men of that family sitting in two rooms is not).
            const dividing = parsed.filter(r => r.type === 'separate_by' && r.hard && r.field && r.rank < rule.rank);
            const blockKey = (p) => dividing.map(d => { const v = ruleVal(p, d.field); return v == null ? '' : String(v).trim().toLowerCase(); }).join('\u0001');
            const groups = new Map();
            for (const e of everyone) {
                if (!condMatches(rule.params.when, e.p)) continue;
                const v = ruleVal(e.p, rule.field);
                if (v == null || String(v).trim() === '') continue;
                const display = String(v).trim(), k = display.toLowerCase();
                if (!groups.has(k)) groups.set(k, { display, size: 0, blocks: new Map() });
                const g = groups.get(k);
                g.size++;
                const bk = blockKey(e.p);
                if (!g.blocks.has(bk)) g.blocks.set(bk, { rooms: new Map(), unassigned: 0 });
                const b = g.blocks.get(bk);
                if (e.room) b.rooms.set(e.room.id, e.room); else b.unassigned++;
            }
            for (const g of groups.values()) {
                if (g.size < min) continue;
                for (const b of g.blocks.values()) {
                    const nRooms = b.rooms.size;
                    if (nRooms > 1 || (nRooms === 1 && b.unassigned > 0)) {
                        const names = [...b.rooms.values()].map(r => r.room_number || r.id).join(', ');
                        const roomsPart = nRooms === 1 ? `1 habitación (${names})` : `${nRooms} habitaciones (${names})`;
                        const tail = b.unassigned > 0 ? ` y ${b.unassigned} sin asignar` : '';
                        note(rule.name, `El grupo «${g.display}» está en ${roomsPart}${tail}.`, rule.hard);
                    }
                }
            }
        }
        const placed = rooms.reduce((n, r) => n + (Array.isArray(r.occupants) ? r.occupants.length : 0), 0);
        const counts = {
            placed,
            unassigned: unassigned.length,
            hard_violations: violations.filter(v => v.hard).length,
            soft_violations: violations.filter(v => !v.hard).length,
        };
        return { violations, counts };
    }

    // ── a location's lodging view (admin review + coordinator portal) ─────────────────────────────
    // `location` is the location row. `forAdmin` = true adds room notes/gender and the occupant's
    // status; false is the portal projection (id, first_name, last_name, gender, family_group + the
    // conference's dynamic field columns — never notes, raw custom_data, status, payment columns, room
    // notes) and lists only non-cancelled attendees. Either way `occupants` / `unassigned` /
    // `placed_elsewhere` are L's OWN attendees: a foreign stray in one of L's rooms counts in `occupied`
    // but is never listed. `lodging_reviewed_by` is never part of the result.
    // `perms` (admin review): the attendees' ID document follows maskDocument. The coordinators' portal
    // (no perms) sees its own attendees' form answers, as on its roster.
    async function loadLodging(location, { forAdmin = false, perms = null } = {}) {
        const L = location, cid = L.conference_id;
        const fieldRows = await db.all(`SELECT name, label, type, role, is_unique FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]);
        // `role` names the display-name fields (first_name / last_name) wherever they sit in the form.
        const fields = fieldRows.filter(f => isFieldColumn(f.name)).map(f => ({ name: f.name, label: f.label, type: f.type, role: f.role || '' }));
        // Every attendee carries `display_name`, named the way the admin screens name them (personName with
        // the same fallback fields): the fields tagged Nombre / Apellido, else the name columns, else the
        // first two filled fields fit to stand in for a name — 2.16.0 forms may have no Nombre / Apellido,
        // and the portal showed every such attendee as «#id».
        const nameRoleCols = ['first_name', 'last_name'].map(r => fields.find(f => f.role === r)).filter(Boolean).map(f => f.name);
        const nameFallbackCols = fieldRows.filter(isNameFallbackField).map(f => f.name).slice(0, NAME_FALLBACK_COLUMNS);
        const displayNameOf = (p) => {
            const named = nameRoleCols.map(c => (p[c] == null ? '' : String(p[c]).trim())).filter(Boolean).join(' ');
            return named || personName(p, nameFallbackCols);
        };
        const attendeeCols = [...new Set(['id', 'first_name', 'last_name', 'gender', 'family_group', 'room_locked', ...(forAdmin ? ['status'] : []), ...fields.map(f => f.name)])];
        // No «Género» field in the form (2.16.0: every field is optional) → no gender at all, so a value left
        // in the column by a deleted field never drives the gender hints of the lodging boards.
        const hasGender = fields.some(f => f.name === 'gender');
        const projectAttendee = (p) => {
            const o = {};
            for (const c of attendeeCols) o[c] = p[c] === undefined ? null : p[c];
            o.room_locked = isPinned(p) ? 1 : 0;
            if (!hasGender) o.gender = null;
            o.display_name = displayNameOf(p);
            return perms ? maskDocument(o, perms) : o;
        };
        // A room the location SHARES (2.18.0) is part of its arrangement too: `share_beds` are its beds there.
        const roomRows = await db.all(
            `SELECT r.*, h.name AS hotel_name, (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) AS occupied,
                    (SELECT b.beds FROM ${T.roomBeds} b WHERE b.room_id = r.id AND b.location_id = ?) AS share_beds
             FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id
             WHERE (r.location_id = ? OR EXISTS (SELECT 1 FROM ${T.roomBeds} b2 WHERE b2.room_id = r.id AND b2.location_id = ?)) AND h.conference_id = ?
             ORDER BY h.name, r.room_number, r.id`, [L.id, L.id, L.id, cid]);
        const people = (await db.all(
            `SELECT i.*, r.room_number, r.location_id AS room_location_id, h.name AS hotel_name
             FROM ${T.inscriptions} i LEFT JOIN ${T.rooms} r ON i.room_id = r.id LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id
             WHERE i.location_id = ? AND i.conference_id = ? ORDER BY i.last_name, i.first_name, i.id`, [L.id, cid]))
            .map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
        const ruleRows = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND (location_id IS NULL OR location_id = ?) ORDER BY priority DESC, id ASC`, [cid, L.id]);

        const roomIds = new Set(roomRows.map(r => Number(r.id)));
        const occByRoom = new Map();
        const unassignedRows = [], elsewhereRows = [], noLodgingRows = [];
        for (const p of people) {
            const cancelled = p.status === 'cancelled';
            if (p.room_id != null && roomIds.has(Number(p.room_id))) {
                if (cancelled && !forAdmin) continue;
                if (!occByRoom.has(Number(p.room_id))) occByRoom.set(Number(p.room_id), []);
                occByRoom.get(Number(p.room_id)).push(p);
            } else if (cancelled) {
                continue;                       // a cancelled attendee never occupies a bed and is not "sin habitación"
            } else if (p.room_id != null) {
                elsewhereRows.push(p);          // placed by the admin outside L's allotted rooms (pool or another location)
            } else if (!needsLodging(p)) {
                noLodgingRows.push(p);          // «Requiere hospedaje: No» (2.31.0): not waiting for a bed, never assignable
            } else {
                unassignedRows.push(p);
            }
        }
        // In a shared room the location sees its own beds and its own people only: the capacity is its
        // share (or more, when the administration put one of its people in a free bed of the room) and
        // `occupied` counts its own occupants. `shared` says how big the room really is.
        const shareOf = (r) => {
            if (r.location_id != null || r.share_beds == null) return null;
            const own = (occByRoom.get(Number(r.id)) || []).filter(p => p.status !== 'cancelled').length;
            return { beds: Number(r.share_beds) || 0, own, capacity: Math.max(Number(r.share_beds) || 0, own) };
        };
        const auditRooms = roomRows.map(r => {
            const sh = shareOf(r);
            return { id: r.id, room_number: r.room_number, capacity: sh ? sh.capacity : r.capacity, occupied: sh ? sh.own : r.occupied, occupants: occByRoom.get(Number(r.id)) || [] };
        });
        const formNames = new Set([...RULE_ALWAYS_FILLED, ...fieldRows.map(f => f.name).filter(isFieldColumn)]);
        const effectiveRules = ruleRows.map(parseRuleRow).filter(ruleOnFormFields(formNames));
        const { violations, counts } = auditArrangement({ rooms: auditRooms, unassigned: unassignedRows, rules: effectiveRules, placed_elsewhere: elsewhereRows });
        counts.placed_elsewhere = elsewhereRows.length;

        const lockFields = await shareLockFields(cid);
        const rooms = roomRows.map(r => {
            const sh = shareOf(r);
            const base = { id: r.id, hotel_name: r.hotel_name, room_number: r.room_number, capacity: sh ? sh.capacity : r.capacity, is_family: r.is_family, family_name: r.family_name, occupied: sh ? sh.own : (Number(r.occupied) || 0) };
            if (sh) {
                base.shared = { beds: sh.beds, room_capacity: Number(r.capacity) || 0 };
                // `lock`: the class the plan fixed for the whole room, when there is one (see «THE CLASS OF A SHARED ROOM»).
                const lock = shareLockOf(r, 1, lockFields);
                if (lock.length) base.shared.lock = lock;
            }
            if (isBlocked(r)) base.blocked = true;
            if (forAdmin) { base.gender = r.gender; base.notes = r.notes; }
            base.occupants = (occByRoom.get(Number(r.id)) || []).map(projectAttendee);
            return base;
        });
        const ruleSplit = { conference: [], location: [] };
        for (const r of ruleRows) (r.location_id == null ? ruleSplit.conference : ruleSplit.location).push(ruleProjection(r));
        return {
            location: {
                id: L.id, name: L.name,
                lodging_status: lodgingStatusOf(L), lodging_note: L.lodging_note == null ? null : L.lodging_note,
                lodging_submitted_at: L.lodging_submitted_at == null ? null : L.lodging_submitted_at,
                lodging_reviewed_at: L.lodging_reviewed_at == null ? null : L.lodging_reviewed_at,
                // The administration's adjustments since the last submission (2.17.0); who made them only
                // for the admin (the portal never names the reviewing account).
                ...adminAdjustmentOf(L, forAdmin),
                capacity: L.capacity == null ? null : L.capacity,
                inscribed: people.filter(p => p.status !== 'cancelled').length,
            },
            rooms,
            unassigned: unassignedRows.map(projectAttendee),
            no_lodging: noLodgingRows.map(projectAttendee),
            placed_elsewhere: elsewhereRows.map(p => ({ id: p.id, first_name: p.first_name, last_name: p.last_name, display_name: displayNameOf(p), hotel_name: p.hotel_name, room_number: p.room_number })),
            rules: ruleSplit,
            fields,
            violations,
            counts,
        };
    }


    // === PORTAL AUTH HELPER ===
    // A login mints an opaque random session id (host CSPRNG, 256 bits) stored server-side with the
    // location and the access code it was opened with (2.17.1 — it used to be a base64 `id:code:expiry`
    // token that carried the code). Under the sandbox the host NAMESPACES any cookie the plugin sets —
    // `wordjs_portal_token` is stored/returned as the namespaced cookie name below — and forwards the
    // `x-portal-token` header verbatim. Accept either. Every request re-reads the location and its
    // conference: rotate_code, deleting the location, or unpublishing the conference's form (the login
    // refuses an unpublished one too) ends every session at once. Returns the location row, or null
    // (caller responds 401). The id carries nothing guessable, so this path needs no throttle.
    const PORTAL_COOKIE = `${db.tablePrefix}wordjs_portal_token`; // host-namespaced cookie name
    const PORTAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const PORTAL_TOKEN_RE = /^[0-9a-f]{64}$/;
    // Expiry as a fixed-width ms string: compares correctly as text on every engine.
    const expiryText = (ms) => String(Math.floor(ms)).padStart(15, '0');
    async function createPortalSession(location) {
        const token = String(await wordjs.crypto.randomToken(32));
        const now = Date.now();
        await db.run(`DELETE FROM ${T.portalSessions} WHERE expires_at < ?`, [expiryText(now)]);
        await db.run(
            `INSERT INTO ${T.portalSessions} (token, location_id, code, expires_at) VALUES (?, ?, ?, ?)`,
            [token, location.id, String(location.code), expiryText(now + PORTAL_TOKEN_TTL_MS)]
        );
        return token;
    }
    const portalTokenOf = (req) => {
        const cookies = req.cookies || {};
        const token = cookies[PORTAL_COOKIE] || cookies.wordjs_portal_token || (req.headers && req.headers['x-portal-token']);
        return typeof token === 'string' && PORTAL_TOKEN_RE.test(token) ? token : null;
    };
    async function resolvePortalLocation(req) {
        const token = portalTokenOf(req);
        if (!token) return null;
        try {
            const location = await db.get(
                `SELECT l.* FROM ${T.portalSessions} s
                 JOIN ${T.locations} l ON l.id = s.location_id
                 JOIN ${T.conferences} c ON c.id = l.conference_id
                 WHERE s.token = ? AND s.expires_at > ? AND l.code = s.code AND c.is_form_published = 1`,
                [token, expiryText(Date.now())]
            );
            return location || null;
        } catch (e) {
            return null;
        }
    }

    // === PUBLIC PORTAL API ===

    http.route('get', '/public/list', async (req, res) => {
        try {
            const list = await db.all(`SELECT id, name, slug, date_start, date_end, description, status, is_form_published, phone_country FROM ${T.conferences} WHERE is_form_published = 1 ORDER BY id DESC`);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    // GET /public/flags?iso=CO,EC → { flags: { CO: '<svg…>' } } — the phone selector's flags (2.33.2), a batch at a
    // time (≤ 48), from the bundled flag-icons set (server/flags.js, read on first use). Unknown codes are left out.
    let flagSet = null;
    http.route('get', '/public/flags', async (req, res) => {
        try {
            if (!flagSet) flagSet = require('./server/flags');
            const isos = [...new Set(String((req.query || {}).iso || '').toUpperCase().split(',').map(x => x.trim()).filter(x => /^[A-Z]{2}$/.test(x)))].slice(0, 48);
            const flags = {};
            for (const iso of isos) if (Object.prototype.hasOwnProperty.call(flagSet, iso)) flags[iso] = flagSet[iso];
            try { res.set({ 'Cache-Control': 'public, max-age=604800' }); } catch (e) { /* a bridge without headers */ }
            res.json({ flags });
        } catch (e) { sendError(res, e); }
    });

    // 2. List Locations for Login (Public)
    http.route('get', '/public/locations', async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario de esta conferencia no está publicado.' });
            }
            // Only the id + name are needed to pick a location at login. responsible_name is PII and
            // must not be exposed on this unauthenticated route (it's returned post-login instead).
            const list = await db.all(`SELECT id, name FROM ${T.locations} WHERE conference_id = ? ORDER BY name`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    // 2b. Get Fields for Portal (Public) — same publish gate as /public/locations.
    http.route('get', '/public/fields', async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario de esta conferencia no está publicado.' });
            }
            // `role` and `is_unique` let the coordinators' portal name people the way the admin does (the
            // fields tagged Nombre / Apellido; never an ID document as a name).
            const list = await db.all(`SELECT name, label, type, options, is_required, width, is_group, role, is_unique FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            // The health field travels as a definition (the portal asks it on registration, write-only). While the
            // conference asks for «Autorización de datos», it goes with `verbal_consent: true`: the coordinator must tick
            // the person's verbal authorization to send an answer (2.34.0).
            const consentOn = await consent.isEnabled(conference_id);
            res.json(list.filter(f => isFieldColumn(f.name) || f.name === healthMod.FIELD)
                .map(f => (f.name === healthMod.FIELD && consentOn ? { ...f, verbal_consent: true, verbal_statement: consent.VERBAL_STATEMENT } : f)));
        } catch (e) { sendError(res, e); }
    });

    // 3. Login
    http.route('post', '/portal/login', async (req, res) => {
        const { code } = req.body;
        // Canonicalize the location id to an integer BEFORE it keys the throttle. The raw body value was
        // used as the key, so "5"/"05"/"005"/" 5"/"5.0" each got a fresh LOGIN_MAX budget while all
        // matching the same DB row via INTEGER affinity — defeating the brute-force limiter (audit HIGH).
        const location_id = Number(req.body && req.body.location_id);
        if (!Number.isInteger(location_id) || location_id <= 0) {
            return res.status(400).json({ error: 'Localidad inválida.' });
        }
        try {
            // Charged to the caller's budget before touching the DB, refunded only when the code is right
            // (or the form is closed — that refusal is not a guess). Bounds brute force of the 6-digit code.
            const attempt = beginLoginAttempt(req, location_id);
            if (!attempt) {
                return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
            }
            await loginPause(attempt.delayMs);
            const location = await db.get(`SELECT * FROM ${T.locations} WHERE id = ?`, [location_id]);
            if (!location) return res.status(404).json({ error: 'Location not found' });

            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [location.conference_id]);
            if (!conf || !conf.is_form_published) {
                attempt.succeeded();
                return res.status(403).json({ error: 'El formulario de esta conferencia no está publicado.' });
            }

            // Simple code check
            if (!location.code || String(location.code) !== String(code)) {
                attempt.failed();
                return res.status(401).json({ error: 'Invalid code' });
            }
            attempt.succeeded();

            // Opaque server-side session (createPortalSession): the token carries no code.
            const token = await createPortalSession(location);

            // Set the portal cookie. The host namespaces it to `${tablePrefix}wordjs_portal_token`,
            // clamps it to this plugin's route path, and strips `secure` handling itself; we still pass
            // sensible flags. The client also receives the token to send via the x-portal-token header.
            res.cookie('wordjs_portal_token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days (host clamps anything longer)
            });

            // `features.fee_payments` (2.18.0) tells a core portal that «Pagos de cuotas» exists here (an older
            // plugin sends no flag and the portal keeps its previous payment flow); `fees` = the badge counters.
            const withdraw = withdrawWindow(await db.get(`SELECT withdraw_until, lodging_tz FROM ${T.conferences} WHERE id = ?`, [location.conference_id]));
            res.json({ success: true, token, location: { id: location.id, name: location.name, responsible_name: location.responsible_name, withdraw, conference_id: location.conference_id, conference_name: await conferenceNameOf(location.conference_id), capacity: location.capacity, inscribed: await locationOccupancy(location.id), payment_methods: enabledPaymentMethods(location), ...(await portalLodgingSummary(location)), ...(await portalFeaturesOf(location)) } });
        } catch (e) { sendError(res, e); }
    });

    // 4. Get Current Location Info
    // The portal's header names the conference (2.36.1): its name, or '' when it is gone.
    const conferenceNameOf = async (cid) => {
        try { const c = await db.get(`SELECT name FROM ${T.conferences} WHERE id = ?`, [cid]); return (c && c.name) || ''; } catch (e) { return ''; }
    };
    http.route('get', '/portal/me', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        // Strip the secret access code (and the reviewing admin's id) before sending to the client; add
        // the live seat count so the portal can show 12 / 50 and close its form when the location is
        // full, plus the lodging summary (status, rooms allotted, attendees without a room). The other
        // lodging columns stay out too: GET /portal/lodging is the only source of the note/stamps and it
        // hides the note once the arrangement is submitted — this twin surface must not leak it.
        // The administration-adjustment stamp (2.17.0) too: `lodging_admin_changed_by` is an admin's login.
        const { code, lodging_reviewed_by, lodging_note, lodging_submitted_at, lodging_reviewed_at, lodging_status, lodging_permission, lodging_permission_until,
            lodging_opens, lodging_closes, lodging_admin_changed_at, lodging_admin_changed_by, lodging_admin_changes,
            welcome_sent_s, welcome_sent_by, welcome_sent_to, ...safe } = location;
        try {
            const withdraw = withdrawWindow(await db.get(`SELECT withdraw_until, lodging_tz FROM ${T.conferences} WHERE id = ?`, [location.conference_id]));
            // 2.36.10: «Registrar nuevo» asks for the verbal authorization of the personal data while consent is on.
            res.json({ ...safe, withdraw, consent_verbal_general: await consent.isEnabled(location.conference_id), conference_name: await conferenceNameOf(location.conference_id), inscribed: await locationOccupancy(location.id), payment_methods: enabledPaymentMethods(location), ...(await portalLodgingSummary(location)), ...(await portalFeaturesOf(location)) });
        } catch (e) { sendError(res, e); }
    });

    // 2.36.6: «Retirar inscripción» — a coordinator takes one of THEIR location's people out, before the conference's
    // deadline (withdraw_until, 409 withdraw_closed after it or without one), never someone with any payment recorded
    // (fees, transport, packages — 409 has_payments: the administrator withdraws them), never a bed the administration
    // fixed nor one in a submitted / validated arrangement (409). It is a cancellation (status 'cancelled', the bed
    // freed — every list, count, room, meal, badge and export already leaves cancelled people out) stamped with who,
    // when and why; the record stays, and the admin may restore it. A row of inscription_withdrawals (the audit).
    // Under the payments lock, then the assignment lock: no payment or bed can land between the checks and the write.
    // Any payment recorded for the person: a fee payment part (any state), a transport or package payment, or money
    // the old single-payment model counted (amount_paid).
    async function hasPaymentsRecorded(id) {
        const r = await db.get(`SELECT (SELECT COUNT(*) FROM ${T.payments} WHERE inscription_id = ? )`
            + ` + (SELECT COUNT(*) FROM ${T.transportPayments} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE inscription_id = ? ))`
            + ` + (SELECT COUNT(*) FROM ${T.packagePayments} WHERE sale_id IN (SELECT id FROM ${T.packageSales} WHERE inscription_id = ? ))`
            + ` + (SELECT COUNT(*) FROM ${T.inscriptions} WHERE id = ? AND COALESCE(amount_paid, 0) > 0) AS n`, [id, id, id, id]);
        return Number(r && r.n) > 0;
    }
    http.route('post', '/portal/inscriptions/:id/withdraw', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            const id = positiveInt(req.params.id);
            const mine = id ? await db.get(`SELECT id FROM ${T.inscriptions} WHERE id = ? AND location_id = ? AND conference_id = ?`, [id, location.id, location.conference_id]) : null;
            if (!mine) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            const reason = String(((req.body || {}).reason) == null ? '' : req.body.reason).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
            const actor = `portal:${location.id}`;
            const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
            if (!fees.ready) await fees.ensureReady();
            await fees.withPaymentsLock(async () => {
                const conf = await db.get(`SELECT withdraw_until, lodging_tz FROM ${T.conferences} WHERE id = ?`, [location.conference_id]);
                const win = withdrawWindow(conf);
                if (!win.open) {
                    throw httpError(409, win.until
                        ? 'El plazo para retirar inscripciones ya venció: pídele al administrador que la retire.'
                        : 'En esta conferencia los encargados no retiran inscripciones: pídeselo al administrador.', { code: 'withdraw_closed' });
                }
                if (await hasPaymentsRecorded(id)) throw httpError(409, 'Tiene pagos registrados: pídele al administrador que la retire.', { code: 'has_payments' });
                await withAssignmentLock(async () => {
                    const cur = await db.get(`SELECT i.status, i.room_id, i.room_locked, r.blocked FROM ${T.inscriptions} i LEFT JOIN ${T.rooms} r ON r.id = i.room_id WHERE i.id = ?`, [id]);
                    if (!cur || cur.status === 'cancelled') throw httpError(409, 'Esta inscripción ya no está activa.', { code: 'not_active' });
                    if (cur.room_id != null) {
                        if (isPinned(cur) || isBlocked(cur)) throw httpError(409, 'La administración fijó la cama de esta persona: pídele al administrador que la retire.', { code: 'held' });
                        if (await frozenLocationRow(location.id)) throw httpError(409, 'El hospedaje de tu localidad ya está enviado o validado: pídele al administrador que la retire.', { code: 'lodging_frozen' });
                    }
                    await db.run(`UPDATE ${T.inscriptions} SET status = 'cancelled', room_id = NULL, room_locked = NULL, withdrawn_at = ?, withdrawn_by = ?, withdraw_reason = ? WHERE id = ? AND status <> 'cancelled'`,
                        [at, actor, reason, id]);
                });
            });
            await db.run(`INSERT INTO ${T.withdrawals} (conference_id, inscription_id, kind, actor, at_utc, reason) VALUES (?, ?, 'withdraw', ?, ?, ?)`, [location.conference_id, id, actor, at, reason]);
            res.json({ success: true, withdrawn_at: at });
        } catch (e) { sendError(res, e); }
    });

    // 4b. Logout — clear the namespaced session cookie so a refresh on a shared device does not
    // silently re-authenticate the previous coordinator.
    // The session row goes too, so the token is dead everywhere, not just in this browser.
    http.route('post', '/portal/logout', async (req, res) => {
        const token = portalTokenOf(req);
        if (token) {
            try { await db.run(`DELETE FROM ${T.portalSessions} WHERE token = ?`, [token]); }
            catch (e) { console.warn('[conference-manager] portal logout: session not removed:', e.message); }
        }
        res.clearCookie('wordjs_portal_token', { path: '/' });
        res.json({ success: true });
    });

    // 5. Get Inscriptions for Location — isolated by location_id, projected to what the coordinator
    // needs: payment state + the form fields. Never notes/custom_data/room_id/status/location(_id).
    // 2.18.0: plus the fee money still under review — `pending_amount` (por validar) and `returned_amount`
    // (devuelto) from live parts — and `cancelled` (D-P19: shown «Cancelada», no fee owed, cannot be paid;
    // a boolean, never the raw status). Ordered by first name, then id (stable pages).
    const PORTAL_BASE_COLS = ['id', 'payment_status', 'total_due', 'amount_paid', 'registration_date'];
    http.route('get', '/portal/inscriptions', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            const fields = await db.all(`SELECT name, label, type, role FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [location.conference_id]);
            const cols = [...new Set([...PORTAL_BASE_COLS, ...fields.map(f => f.name).filter(isFieldColumn)])];
            const emailField = emailFieldIn(fields, isFieldColumn);
            const list = await db.all(`SELECT ${cols.map(c => `i.${c}`).join(', ')}, ${fees.personSum('pending', 'i.id')} AS pending_amount,`
                + ` ${fees.personSum('returned', 'i.id')} AS returned_amount, CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END AS cancelled`
                + ` FROM ${T.inscriptions} i WHERE i.location_id = ? AND i.conference_id = ? AND i.withdrawn_at IS NULL ORDER BY i.first_name, i.id`, [location.id, location.conference_id]);
            // «Autorización de datos» (2.33.0): each person's state (pending / granted with its time / revoked), while asked.
            const consentStates = await consent.isEnabled(location.conference_id) ? await consent.statesOf(location.conference_id, list.map(r => r.id)) : null;
            // 2.35.0: «sin correo» — nobody to e-mail the link to (the coordinator copies the message or uses paper).
            const noEmail = (r) => !emailField || !CONSENT_EMAIL_RE.test(String(r[emailField.name] == null ? '' : r[emailField.name]).trim());
            const consentOf = (r) => {
                const st = consentStates.get(Number(r.id));
                return st ? { state: st.state, granted_at: st.granted_at, revoked_at: st.revoked_at, email_masked: st.email_masked, mail_failed: st.mail_failed, link_expired: st.link_expired, verbal_health: st.verbal_health, verbal_overdue: st.verbal_overdue, verbal_general: st.verbal_general, no_email: noEmail(r) }
                    : { state: 'pending', granted_at: null, revoked_at: null, email_masked: '', mail_failed: false, link_expired: false, never_sent: true, no_email: noEmail(r) };
            };
            res.json(list.map(r => ({ ...r, pending_amount: roundMoney(r.pending_amount), returned_amount: roundMoney(r.returned_amount), cancelled: !!Number(r.cancelled), ...(consentStates ? { consent: consentOf(r) } : {}) })));
        } catch (e) { sendError(res, e); }
    });

    // 5b. Groups for this coordinator's location — the distinct values of the GROUPING field (the field
    // roled 'family_group', stored in the family_group column) among the location's inscriptions, each
    // with its members. Lets the portal search/filter existing groups and preview who's in them.
    http.route('get', '/portal/groups', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            const q = String((req.query && req.query.q) || '').trim().toLowerCase();
            const fields = await db.all(`SELECT name, is_group FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [location.conference_id]);
            // Which field groups attendees? ANY field can be flagged is_group (one per conference). If
            // none is, there are no groups to show.
            const groupField = fields.find(f => f.is_group && isFieldColumn(f.name));
            if (!groupField) return res.json({ groups: [] });
            const gcol = groupField.name; // safe identifier (isFieldColumn-validated)
            // Display name = the first 1-2 non-grouping fields' values (mirrors the frontend helper).
            const nameFields = fields.filter(f => f.name !== gcol && isFieldColumn(f.name)).slice(0, 2);
            const cols = [...new Set(['id', gcol, ...nameFields.map(f => f.name)])];
            const rows = await db.all(
                `SELECT ${cols.join(', ')} FROM ${T.inscriptions} WHERE location_id = ? AND conference_id = ? AND ${gcol} IS NOT NULL AND ${gcol} != ''`,
                [location.id, location.conference_id]
            );
            const rowName = (r) => {
                const parts = nameFields.map(f => r[f.name]).filter(v => v != null && v !== '').map(String);
                return parts.slice(0, 2).join(' ').trim() || ('#' + r.id);
            };
            const map = new Map();
            for (const r of rows) {
                const g = String(r[gcol]).trim();
                if (!g) continue;
                if (!map.has(g)) map.set(g, []);
                map.get(g).push({ id: r.id, name: rowName(r) });
            }
            let groups = [...map.entries()].map(([name, members]) => ({ name, count: members.length, members }));
            if (q) groups = groups.filter(gr => gr.name.toLowerCase().includes(q));
            groups.sort((a, b) => a.name.localeCompare(b.name));
            res.json({ groups });
        } catch (e) { sendError(res, e); }
    });

    // 2.36.10: «Historial» of one of the locality's people (see historyEntries: no health, no notes, no admin login).
    http.route('get', '/portal/inscriptions/:id/history', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            const id = positiveInt(req.params.id);
            const ins = id ? await db.get(`SELECT id, conference_id, location_id, registration_date FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
            if (!ins || Number(ins.location_id) !== Number(location.id) || Number(ins.conference_id) !== Number(location.conference_id)) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            res.json(await historyEntries(ins, { seesHealth: false, portal: true }));
        } catch (e) { sendError(res, e); }
    });

    // 6. Create Inscription (Portal)
    http.route('post', '/portal/inscriptions', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const fieldValues = req.body && typeof req.body === 'object' ? req.body : {};
        const conference_id = location.conference_id;

        try {
            const conf = await db.get(`SELECT is_form_published, fee_default, date_end, phone_country FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario no está publicado.' });
            }
            // Registration window: once the event's end date has passed, the public form closes.
            // (date_end is the gate by design — one calendar day of grace.)
            if (conf.date_end) {
                const closeAt = new Date(conf.date_end).getTime();
                if (Number.isFinite(closeAt) && Date.now() > closeAt + 24 * 60 * 60 * 1000) {
                    return res.status(403).json({ error: 'El período de inscripción para esta conferencia ya cerró.' });
                }
            }
            // Seats: the coordinator registers into their OWN location, which may be full (409).
            await assertLocationHasRoom(location);

            // Server-controlled operational state: the coordinator's OWN location (id = isolation key,
            // name = display label). Every RESERVED_INSCRIPTION_COLUMNS key in the body is ignored —
            // canonicalFieldValues only reads DEFINED, writable form fields.
            const values = {
                conference_id,
                location_id: location.id,
                location: location.name,
                status: 'pending'
            };

            // Write each DEFINED form field's canonical value to its own column (schema follows the form).
            const confFields = await db.all(FIELD_COLUMNS_SQL, [conference_id]);
            Object.assign(values, canonicalFieldValues(confFields, fieldValues, { phoneCountry: phoneCountryOf(conf) }));
            // «Condiciones de salud» (2.32.0): the coordinator answers it while registering — write-only.
            const healthIn = await healthFromBody(conference_id, fieldValues, { mayWrite: true, creating: true });
            const consentOn = await consent.isEnabled(conference_id);
            assertGeneralVerbal(consentOn, fieldValues);
            if (consentOn) await assertConsentEmail(conference_id, values);

            // Enforce required fields SERVER-SIDE — is_required was only advisory on the public form, so a
            // client could omit a field that drives pricing and under-quote total_due (audit MEDIUM).
            // '' (an empty number input) counts as missing.
            assertRequired(confFields, values, false);

            // Duplicate guard: a field flagged "no duplicates" must be unique — scoped to the coordinator's
            // OWN location. A conference-wide check turned the 409 into a cross-location probe oracle (a
            // coordinator could enumerate registrations in locations they don't manage) (audit LOW).
            await assertUnique(confFields, values, { conference_id, location_id: location.id });
            await assertNoEmailDuplicate(conference_id, values, { location_id: location.id });

            // first_name / last_name are NOT NULL — default to '' (no 'Sin Nombre' placeholder).
            if (values.first_name == null) values.first_name = '';
            if (values.last_name == null) values.last_name = '';

            // Fee from the pricing rules + base fee, evaluated against the submitted field values.
            values.total_due = await computeFee(conference_id, values, conf.fee_default);
            values.reg_code = await newRegCode();

            values.created_by = `portal:${location.name}`;
            // The seat is taken under the location's seat lock (takeSeat re-counts there).
            const keys = Object.keys(values);
            const result = await takeSeat(location, () => db.run(
                `INSERT INTO ${T.inscriptions} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                Object.values(values)
            ));
            if (healthIn.answer) await health.save(conference_id, result.lastID, healthIn.answer);
            const consentOut = consentOn ? await askConsent(result.lastID, `portal:${location.name}`, 'portal') : undefined;
            await recordHistory(conference_id, result.lastID, 'created', `portal:${location.name}`, 'portal');
            if (consentOn) await consentGeneralEntered(result.lastID, `portal:${location.name}`, 'portal');
            if (consentOn && healthIn.answer) await consentHealthEntered(result.lastID, `portal:${location.name}`, 'portal', healthIn);
            res.json({ success: true, id: result.lastID, ...(consentOut ? { consent: consentOut } : {}) });
        } catch (e) { sendError(res, e); }
    });

    // 7. Bulk Payments (Portal) — kept for core portals older than «Pagos de cuotas» (2.18.0). The same
    // amount for each selected person becomes ONE payment of N equal parts with the receipt stored once,
    // 'pending' for the admin. All or nothing: an id outside this coordinator's location (or cancelled, or
    // already covered — never more than what is owed) refuses the whole request. ≤ BULK_MAX_IDS people.
    // A repeated transfer reference is accepted here: that portal has no «Registrar de todas formas» to
    // confirm it with, and its one-amount-per-person form needs two posts with the same transfer for a family
    // whose fees differ. The administration's queue still flags the payment «Referencia repetida».
    const BULK_MAX_IDS = 200;
    http.route('post', '/portal/payments/bulk', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        // Degraded mode (the fee migration did not complete): no payment can be recorded until it does — the
        // coordinator gets a message meant for them, not the administrator's (2.18.0 review R5-L3).
        if (!await fees.ensureReady()) return res.status(503).json({ error: fees.MSG.unavailable_portal, code: 'unavailable' });
        const { inscription_ids, amount_per_person, method, reference, proof } = req.body || {};
        try {
            if (!Array.isArray(inscription_ids) || inscription_ids.length === 0) {
                return res.status(400).json({ error: 'Selecciona al menos una persona.' });
            }
            if (inscription_ids.length > 1000) return res.status(400).json({ error: `Máximo ${BULK_MAX_IDS} personas por pago.` });
            const ids = [...new Set(inscription_ids.map(Number))];
            if (ids.some(n => !Number.isInteger(n) || n <= 0)) return res.status(400).json({ error: 'Identificadores de inscripción inválidos.' });
            if (ids.length > BULK_MAX_IDS) return res.status(400).json({ error: `Máximo ${BULK_MAX_IDS} personas por pago.` });
            if (!Number.isFinite(Number(amount_per_person)) || Number(amount_per_person) > MAX_MONEY) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const amtC = toCents(amount_per_person);
            if (amtC <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            // The coordinator may only record a form of payment the admin enabled for this location.
            const input = fees.parseBody({
                amount: fromCents(amtC * ids.length), method, reference, proof,
                allocations: ids.map(id => ({ inscription_id: id, amount: fromCents(amtC) })),
                allow_duplicate_reference: true,
            }, { methods: enabledPaymentMethods(location) });
            const r = await fees.createTransfer({ via: 'portal', conferenceId: location.conference_id, location }, input);
            res.json({ success: true, applied: ids.length, skipped: 0, id: r.id });
        } catch (e) { fees.sendFeeError(res, e); }
    });

    // === PORTAL LODGING (2.5.0) — the coordinator arranges THEIR attendees in THEIR allotted rooms ===
    // Every route resolves the location first (401 otherwise); every query is scoped by location.id
    // AND location.conference_id. Writes are refused unless the arrangement is a draft (409 while it
    // is submitted / validated); state transitions are compare-and-set UPDATEs under the assignment
    // lock. Nothing here can reach a pool room, another location's room or another location's rules.
    const PORTAL_FROZEN_MSG = 'El hospedaje está en validación/validado y no se puede modificar.';
    // A room L shares (2.18.0) where the administration placed more of L's people than L has beds: the
    // extras sit on POOL beds, which are the administration's — the coordinator neither empties nor moves
    // L's people out of that room (it could never fill those beds again).
    const PORTAL_POOL_BEDS_MSG = 'En esta habitación compartida la administración puso a gente de tu localidad en camas del pool: ese cambio lo hace la administración.';
    async function holdsAdminPoolBeds(roomId, locationId) {
        if (roomId == null) return false;
        const r = await db.get(
            `SELECT r.location_id, (SELECT b.beds FROM ${T.roomBeds} b WHERE b.room_id = r.id AND b.location_id = ?) AS share_beds,
                    (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id AND i.location_id = ?) AS own
             FROM ${T.rooms} r WHERE r.id = ?`, [locationId, locationId, roomId]);
        return !!r && r.location_id == null && r.share_beds != null && Number(r.own) > Number(r.share_beds);
    }
    const PORTAL_RULES_MAX = 50;
    const PORTAL_RUN_COOLDOWN_MS = 5000;
    // Lodging summary for the /portal/login and /portal/me payloads: status (COALESCE'd), the number of
    // rooms allotted to the location and its non-cancelled attendees without a room.
    async function portalLodgingSummary(location) {
        const row = await db.get(
            `SELECT (SELECT COUNT(*) FROM ${T.rooms} r WHERE r.location_id = ?) + (SELECT COUNT(*) FROM ${T.roomBeds} b WHERE b.location_id = ?) AS rooms_allotted,`
            + ` (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.location_id = ? AND i.conference_id = ? AND i.room_id IS NULL AND ${occupiedSql('i.status')} AND ${lodgingSql('i.' + LODGING_FIELD)}) AS unlodged`,
            [location.id, location.id, location.id, location.conference_id]);
        return {
            lodging_status: lodgingStatusOf(location),
            rooms_allotted: Number(row && row.rooms_allotted) || 0,
            unlodged: Number(row && row.unlodged) || 0,
        };
    }
    // '2026-10-01' → '01/10/2026'; a datetime keeps its clock ('01/10/2026 18:00').
    const fmtDeadline = (v) => {
        const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        if (!m) return String(v);
        return `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
    };
    // LODGING DATES (2.21.0). The coordinators arrange their lodging from the portal between a general
    // OPENING (conferences.lodging_opens; NULL = right away) and a general CLOSING (conferences.lodging_deadline;
    // NULL = none). A location may have dates of its own that replace them (locations.lodging_opens /
    // lodging_closes: NULL = the general one, a date = its own, 'now' = no wait, 'never' = no closing — the
    // 2.8.0 «permiso fuera de plazo» became such a closing). A bare date ('2026-10-15') is a whole day: the
    // opening from its first instant, the closing until its last, in the conference's zone (lodging_tz: the
    // admin's browser zone, saved with the dates; none = UTC, as before 2.21.0). A datetime is exact. Only
    // portal writes honour them — the admin arranges whenever it likes. The date arithmetic (lodgingDay,
    // lodgingStart / lodgingEnd, lodgingZone) sits near the top of init: initSchema's migration needs it first.
    function lodgingWindow(conf, loc, now = Date.now()) {
        const ownOf = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
        const ownOpens = ownOf(loc && loc.lodging_opens), ownCloses = ownOf(loc && loc.lodging_closes);
        const tz = lodgingZone(conf && conf.lodging_tz);
        const opens = ownOpens ? (ownOpens === LODGING_NO_WAIT ? null : lodgingDay(ownOpens)) : lodgingDay(conf && conf.lodging_opens);
        const closes = ownCloses ? (ownCloses === LODGING_NO_CLOSE ? null : lodgingDay(ownCloses)) : lodgingDay(conf && conf.lodging_deadline);
        const passed = closes != null && now >= lodgingEnd(closes, tz);
        const notYet = !passed && opens != null && now < lodgingStart(opens, tz);
        return { opens, closes, own_opens: ownOpens, own_closes: ownCloses, tz, not_yet: notYet, passed, open: !notYet && !passed };
    }
    // What the admin's screens get of a window.
    const lodgingWindowView = (w) => ({ opens: w.opens, closes: w.closes, not_yet: w.not_yet, passed: w.passed, open: w.open });
    // The window of ONE location, both rows re-read (dates changed a moment ago apply at once).
    async function lodgingWindowOf(location) {
        return lodgingWindow(
            await db.get(`SELECT lodging_opens, lodging_deadline, lodging_tz FROM ${T.conferences} WHERE id = ?`, [location.conference_id]),
            await db.get(`SELECT lodging_opens, lodging_closes FROM ${T.locations} WHERE id = ?`, [location.id]));
    }
    // Every portal lodging write: 403 before the location's opening and after its closing.
    async function assertLodgingWindowOpen(location) {
        const w = await lodgingWindowOf(location);
        if (w.open) return;
        if (w.passed) throw httpError(403, `El plazo para acomodar los hospedajes venció el ${fmtDeadline(w.closes)}. Solo el administrador puede modificarlos.`);
        throw httpError(403, `Los hospedajes se habilitan el ${fmtDeadline(w.opens)}. Hasta entonces solo el administrador puede acomodarlos.`);
    }
    // Re-reads the status (the resolved row may be a few ms old) and throws 409 unless it is a draft.
    // Used inside the assignment lock by the routes that write.
    async function assertPortalDraft(location) {
        const fresh = await db.get(`SELECT id, lodging_status FROM ${T.locations} WHERE id = ?`, [location.id]);
        if (!fresh || isFrozen(fresh)) throw httpError(409, PORTAL_FROZEN_MSG);
    }
    // A body id: undefined/null/'' → null; otherwise a positive integer or 400 with the given message.
    const bodyId = (v, msg) => {
        if (v === undefined || v === null || v === '') return null;
        const n = positiveInt(v);
        if (!n) throw httpError(400, msg);
        return n;
    };
    const portalRuleProjection = (r) => { const { location_id, ...pub } = r; return pub; };

    // 8. The whole lodging view in ONE request (the portal must not fan out: the login throttle caps
    // in-flight authenticated calls per location).
    http.route('get', '/portal/lodging', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            const view = await loadLodging(location, { forAdmin: false });
            const status = view.location.lodging_status;
            const win = await lodgingWindowOf(location);
            res.json({
                status,
                // The dates THIS location arranges between (its own where the admin set them, the general ones
                // otherwise — see LODGING DATES). `deadline` / `deadline_passed` keep their meaning (the closing
                // that applies), so a portal older than 2.21.0 still tells the truth.
                opens: win.opens,
                not_yet_open: win.not_yet,
                deadline: win.closes,
                deadline_passed: win.passed,
                window_open: win.open,
                // The admin's observations only matter while the coordinator can act on them.
                note: status === 'draft' ? view.location.lodging_note : null,
                submitted_at: view.location.lodging_submitted_at,
                reviewed_at: view.location.lodging_reviewed_at,
                // «Ajustado por la administración el …» (2.17.0): when the admin last changed the arrangement
                // while it was submitted / validated, and how many changes since the last submission.
                admin_changed_at: view.location.lodging_admin_changed_at,
                admin_changes: view.location.lodging_admin_changes,
                can_edit: status === 'draft' && win.open,
                rooms: view.rooms,
                unassigned: view.unassigned,
                // «Requiere hospedaje: No» (2.31.0): shown apart, never offered for a room.
                no_lodging: view.no_lodging,
                placed_elsewhere: view.placed_elsewhere,
                rules: { conference: view.rules.conference.map(portalRuleProjection), location: view.rules.location.map(portalRuleProjection) },
                fields: view.fields,
                violations: view.violations,
                counts: view.counts,
            });
        } catch (e) { sendError(res, e); }
    });

    // 8b. Manual placement: { inscription_id, room_id | null }. The attendee must be L's; the room must be
    // allotted to L (a pool room or another location's room is "not found"); a cancelled attendee is
    // never placed; capacity is enforced. Unassigning only works out of L's own rooms — an attendee the
    // admin placed in a pool room is read-only for the coordinator (placed_elsewhere).
    http.route('post', '/portal/lodging/assign', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const { inscription_id, room_id: rawRoomId } = req.body || {};
        try {
            if (isFrozen(location)) return res.status(409).json({ error: PORTAL_FROZEN_MSG });
            await assertLodgingWindowOpen(location);
            const insId = positiveInt(inscription_id);
            if (!insId) return res.status(400).json({ error: 'Identificador inválido.' });
            const roomId = bodyId(rawRoomId, 'Habitación inválida.');
            // Everything from the ownership checks to the UPDATE runs under the assignment lock (the
            // status is re-read there): two concurrent assigns into the last bed, an engine run's
            // load→flush window, or an admin re-allotting the room may not interleave with this
            // check-then-write. The placement UPDATE is conditional on the room still being L's and
            // still having a free bed, so a lost race writes nothing.
            await withAssignmentLock(async () => {
                await assertPortalDraft(location);
                const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND location_id = ? AND conference_id = ?`, [insId, location.id, location.conference_id]);
                if (!ins) throw httpError(404, 'Inscripción no encontrada.');
                // Held by the administration (see «HELD BY THE ADMINISTRATION»): a fixed person, or anyone in a blocked room.
                if (ins.room_id != null && Number(ins.room_id) !== Number(roomId)) {
                    if (isPinned(ins)) throw httpError(409, HELD_PERSON_MSG);
                    if (await db.get(`SELECT id FROM ${T.rooms} WHERE id = ? AND COALESCE(blocked, 0) = 1`, [ins.room_id])) throw httpError(409, HELD_ROOM_MSG);
                }

                if (ins.room_id != null && Number(ins.room_id) !== Number(roomId) && await holdsAdminPoolBeds(ins.room_id, location.id)) {
                    throw httpError(409, PORTAL_POOL_BEDS_MSG);
                }
                if (roomId === null) {
                    if (ins.room_id == null) return;
                    const r = await db.run(
                        `UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE id = ? AND location_id = ? AND room_id IN (${LOCATION_ROOMS_SQL()})`,
                        [ins.id, location.id, location.id, location.id]);
                    if (!r || !r.changes) throw httpError(404, 'Habitación no encontrada.');
                    return;
                }
                // L's whole room, or a room L shares (2.18.0) — where only L's beds are L's to fill.
                const room = await db.get(
                    `SELECT r.id, r.capacity, r.location_id, r.share_lock, r.blocked, (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) AS occupied,
                            (SELECT b.beds FROM ${T.roomBeds} b WHERE b.room_id = r.id AND b.location_id = ?) AS share_beds,
                            (SELECT COUNT(*) FROM ${T.inscriptions} i2 WHERE i2.room_id = r.id AND i2.location_id = ?) AS own_occupied
                     FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id
                     WHERE r.id = ? AND (r.location_id = ? OR EXISTS (SELECT 1 FROM ${T.roomBeds} b2 WHERE b2.room_id = r.id AND b2.location_id = ?)) AND h.conference_id = ?`,
                    [location.id, location.id, roomId, location.id, location.id, location.conference_id]);
                if (!room) throw httpError(404, 'Habitación no encontrada.');
                if (ins.status === 'cancelled') throw httpError(400, 'Un participante cancelado no ocupa habitación.');
                if (!needsLodging(ins)) throw httpError(400, NO_LODGING_MSG);
                const alreadyHere = Number(ins.room_id) === Number(room.id);
                if (alreadyHere) return;
                if (isBlocked(room)) throw httpError(409, HELD_ROOM_MSG);
                if (Number(room.occupied) >= Number(room.capacity)) throw httpError(400, 'La habitación está llena.');
                if (room.location_id == null && Number(room.own_occupied) >= (Number(room.share_beds) || 0)) {
                    throw httpError(400, 'Las camas de tu localidad en esta habitación ya están ocupadas.');
                }
                await assertShareLock(room, ins, location.conference_id);
                // The room must still be L's when the write lands (an admin re-allotment cannot interleave
                // thanks to the lock, but the predicate costs nothing). No self-referencing capacity
                // subquery here: MySQL refuses an UPDATE whose subquery reads the updated table (1093);
                // the capacity check above is serialised by the assignment lock instead.
                const r = await db.run(
                    `UPDATE ${T.inscriptions} SET room_id = ?, room_locked = NULL WHERE id = ? AND location_id = ? AND conference_id = ?`
                    + ` AND EXISTS (SELECT 1 FROM ${T.rooms} x WHERE x.id = ? AND (x.location_id = ? OR EXISTS (SELECT 1 FROM ${T.roomBeds} b WHERE b.room_id = x.id AND b.location_id = ?)))`,
                    [room.id, ins.id, location.id, location.conference_id, room.id, location.id, location.id]);
                if (!r || !r.changes) throw httpError(404, 'Habitación no encontrada.');
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // 8c. Auto-assignment of L's scope (its own rules + the admin's). One run per location at a time and
    // a short cooldown between runs (the engine loads L's whole scope into memory): 429 otherwise.
    const portalRuns = new Map(); // location id → { inflight, finishedAt }
    http.route('post', '/portal/lodging/run', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        let acquired = false;
        try {
            if (isFrozen(location)) return res.status(409).json({ error: PORTAL_FROZEN_MSG });
            await assertLodgingWindowOpen(location);
            const now = Date.now();
            const prev = portalRuns.get(location.id);
            if (prev && (prev.inflight || now - prev.finishedAt < PORTAL_RUN_COOLDOWN_MS)) {
                return res.status(429).json({ error: 'Ya hay una asignación en curso para esta localidad.' });
            }
            // Keep the map bounded: drop entries whose cooldown has elapsed.
            for (const [k, v] of portalRuns) if (!v.inflight && now - v.finishedAt >= PORTAL_RUN_COOLDOWN_MS) portalRuns.delete(k);
            portalRuns.set(location.id, { inflight: true, finishedAt: 0 });
            acquired = true;
            const result = await withAssignmentLock(async () => {
                await assertPortalDraft(location);
                return runAssignment(location.conference_id, { locationId: location.id });
            });
            res.json({ success: true, ...result });
        } catch (e) { sendError(res, e); }
        finally { if (acquired) portalRuns.set(location.id, { inflight: false, finishedAt: Date.now() }); }
    });

    // 8d. Empty L's allotted rooms of L's attendees (a stray the admin put there, or an attendee of L
    // the admin placed in a pool room, is not touched).
    http.route('post', '/portal/lodging/reset', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            if (isFrozen(location)) return res.status(409).json({ error: PORTAL_FROZEN_MSG });
            await assertLodgingWindowOpen(location);
            await withAssignmentLock(async () => {
                await assertPortalDraft(location);
                // The rooms L shares where the administration put L's people on pool beds keep them all.
                const kept = (await db.all(
                    `SELECT b.room_id, b.beds, (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = b.room_id AND i.location_id = ?) AS own
                     FROM ${T.roomBeds} b JOIN ${T.rooms} r ON r.id = b.room_id WHERE b.location_id = ? AND r.location_id IS NULL`, [location.id, location.id]))
                    .filter(x => Number(x.own) > Number(x.beds)).map(x => Number(x.room_id));
                await db.run(
                    `UPDATE ${T.inscriptions} SET room_id = NULL, room_locked = NULL WHERE location_id = ? AND conference_id = ? AND room_id IN (${LOCATION_ROOMS_SQL()}) AND ${NOT_HELD_SQL()}`
                    + (kept.length ? ` AND room_id NOT IN (${kept.map(() => '?').join(', ')})` : ''),
                    [location.id, location.conference_id, location.id, location.id, ...kept]);
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // 8e. The location's OWN rules: create, or update when `id` names one of L's rules. Same validation
    // as the admin's rules (normalizeRule with the conference's field names); at most 50 per location.
    // There is no GET: the rules travel in GET /portal/lodging.
    http.route('post', '/portal/lodging/rules', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const { id, name, type, enabled, priority, config, params, hard } = req.body || {};
        try {
            if (isFrozen(location)) return res.status(409).json({ error: PORTAL_FROZEN_MSG });
            await assertLodgingWindowOpen(location);
            const cid = location.conference_id;
            const rule = normalizeRule({ name, type, enabled, priority, config, params, hard }, { conferenceId: cid, fieldNames: await ruleFieldNames(cid) });
            const paramsStr = JSON.stringify(rule.params);
            // The write runs under the assignment lock (where submit flips the status) with the status
            // re-read, so a rule can never land on an arrangement that was submitted meanwhile.
            const saved = await withAssignmentLock(async () => {
                await assertPortalDraft(location);
                await assertFreePriority({ conferenceId: cid, locationId: location.id, ruleId: positiveInt(id), priority: rule.priority });
                if (id !== undefined && id !== null && id !== '') {
                    const ruleId = positiveInt(id);
                    const existing = ruleId ? await db.get(`SELECT id FROM ${T.rules} WHERE id = ? AND location_id = ? AND conference_id = ?`, [ruleId, location.id, cid]) : null;
                    if (!existing) throw httpError(404, 'Regla no encontrada.');
                    await db.run(
                        `UPDATE ${T.rules} SET name = ?, type = ?, enabled = ?, priority = ?, config = ?, params = ?, hard = ? WHERE id = ? AND location_id = ? AND conference_id = ?`,
                        [rule.name, rule.type, rule.enabled, rule.priority, rule.config, paramsStr, rule.hard, ruleId, location.id, cid]);
                    return ruleId;
                }
                const cnt = await db.get(`SELECT COUNT(*) AS n FROM ${T.rules} WHERE location_id = ? AND conference_id = ?`, [location.id, cid]);
                if ((Number(cnt && cnt.n) || 0) >= PORTAL_RULES_MAX) throw httpError(400, `Máximo ${PORTAL_RULES_MAX} reglas por localidad.`);
                const r = await db.run(
                    `INSERT INTO ${T.rules} (conference_id, name, type, enabled, priority, config, params, hard, location_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [cid, rule.name, rule.type, rule.enabled, rule.priority, rule.config, paramsStr, rule.hard, location.id]);
                return r && r.lastID;
            });
            res.json({ success: true, id: saved });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/portal/lodging/rules/:id', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            if (isFrozen(location)) return res.status(409).json({ error: PORTAL_FROZEN_MSG });
            await assertLodgingWindowOpen(location);
            const ruleId = positiveInt(req.params.id);
            if (!ruleId) return res.status(404).json({ error: 'Regla no encontrada.' });
            const r = await withAssignmentLock(async () => {
                await assertPortalDraft(location);
                return db.run(`DELETE FROM ${T.rules} WHERE id = ? AND location_id = ? AND conference_id = ?`, [ruleId, location.id, location.conference_id]);
            });
            if (!r || !r.changes) return res.status(404).json({ error: 'Regla no encontrada.' });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // 8f. Submit the arrangement for the admin's validation (draft → submitted). Refused when the
    // location has attendees but none of them sleeps in one of its rooms; the admin's previous
    // observations stay on the row (hidden from the portal while not a draft).
    http.route('post', '/portal/lodging/submit', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            await assertLodgingWindowOpen(location);
            await withAssignmentLock(async () => {
                const c = await db.get(
                    `SELECT COUNT(*) AS present,`
                    + ` SUM(CASE WHEN i.room_id IN (${LOCATION_ROOMS_SQL()}) THEN 1 ELSE 0 END) AS placed`
                    + ` FROM ${T.inscriptions} i WHERE i.location_id = ? AND i.conference_id = ? AND ${occupiedSql('i.status')} AND ${lodgingSql('i.' + LODGING_FIELD)}`,
                    [location.id, location.id, location.id, location.conference_id]);
                const present = Number(c && c.present) || 0, placed = Number(c && c.placed) || 0;
                if (present > 0 && placed === 0) throw httpError(400, 'No hay ninguna asignación de hospedaje para enviar.');
                const r = await db.run(
                    `UPDATE ${T.locations} SET lodging_status = 'submitted', lodging_submitted_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'draft'`,
                    [location.id]);
                if (!r || !r.changes) throw httpError(409, 'El hospedaje ya fue enviado.');
                // A new submission is the coordinator's arrangement as it stands — the administration's
                // earlier adjustments included, which the coordinator has seen: the stamp starts over
                // (2.17.0). Same lock as every stamp, so no adjustment can fall between the two writes.
                // Best-effort: a missing stamp column must not cost the coordinator the submission.
                try {
                    await db.run(`UPDATE ${T.locations} SET lodging_admin_changed_at = NULL, lodging_admin_changed_by = NULL, lodging_admin_changes = 0 WHERE id = ?`, [location.id]);
                } catch (e) { console.warn('[conference-manager] lodging adjustment reset skipped:', e && e.message); }
            });
            res.json({ success: true, lodging_status: 'submitted' });
        } catch (e) { sendError(res, e); }
    });
    // 8g. Take a submission back (submitted → draft) to keep arranging; a validated arrangement can only
    // be reopened by the admin.
    http.route('post', '/portal/lodging/withdraw', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            await assertLodgingWindowOpen(location);
            const r = await withAssignmentLock(() => db.run(
                `UPDATE ${T.locations} SET lodging_status = 'draft' WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'submitted'`, [location.id]));
            if (!r || !r.changes) return res.status(409).json({ error: 'El hospedaje no está enviado.' });
            res.json({ success: true, lodging_status: 'draft' });
        } catch (e) { sendError(res, e); }
    });

    // === ADMIN MENU ===
    // Team role (2.16.0): the entry needs this plugin's own capability, which only the WordJS role the
    // manifest declares («Equipo de conferencia», TEAM_ROLE) holds — and administrators, who hold every
    // capability. Editors, authors and subscribers no longer see it. The page then asks GET /staff/me and
    // shows only the sections the person's team role allows; the server gates every route itself (allow()).
    adminMenu.add({
        href: '/admin/plugin/conference-manager',
        label: 'Conference',
        icon: 'fa-users',
        order: 50,
        cap: TEAM_CAPABILITY
    });

    // Registration codes (2.9.0): one UNIQUE index (NULLs allowed while the backfill runs) and a code
    // for every attendee that has none — idempotent, a no-op once every row has one.
    try { await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_inscriptions_reg_code ON ${T.inscriptions} (reg_code)`); }
    catch (e) { console.warn('[conference-manager] reg_code unique index skipped:', e.message); }
    try { await backfillRegCodes(); }
    catch (e) { console.warn('[conference-manager] reg_code backfill skipped:', e.message); }

    console.log('Conference Manager Plugin (Multi-Event, sandboxed) initialized.');
};

exports.deactivate = function () {
    console.log('Conference Manager plugin deactivated');
};
