/**
 * Conference Manager Plugin for WordJS — ISOLATED, NO TRUST TIER.
 *
 * Runs in the child_process sandbox like every other plugin. It uses ONLY the injected `wordjs`
 * capability bridge (no direct require of express/core/dbAsync) and is granted Android-style
 * permissions (database:read, database:write, express:register_route, admin_menu:register, users:read) by
 * the admin. There is NO trusted bypass:
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

exports.metadata = {
    name: 'Conference Manager',
    version: '2.15.1',
    description: 'Manage multiple conference inscriptions, payments, and lodging assignments.',
    author: 'WordJS'
};

exports.init = async function (wordjs) {
    const { db, http, adminMenu } = wordjs;

    console.log('Initializing Conference Manager Plugin (Multi-Event, sandboxed)...');

    // Per-plugin table namespace enforced by the host (assertSqlAllowed default-deny). Every table
    // this plugin touches MUST start with this prefix. slug 'conference-manager' -> 'wjp_conference_manager_'.
    const P = db.tablePrefix; // 'wjp_conference_manager_'
    const T = {
        conferences: `${P}conferences`,
        locations: `${P}locations`,
        hotels: `${P}hotels`,
        rooms: `${P}rooms`,
        inscriptions: `${P}inscriptions`,
        payments: `${P}payments`,
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
    };

    // Schema-follows-form: the registration FORM is the source of truth. Every form field owns a real
    // column in the inscriptions table, added on demand with `ALTER TABLE ... ADD COLUMN`. A plugin
    // MAY alter its OWN wjp_-prefixed tables (plugin-api.ts allows the `alter` write verb, scoped by
    // the table-attribution guard). PRAGMA / information_schema ARE denied (read verbs are select/with
    // only), so we can't introspect columns first — instead ADD COLUMN runs idempotently by swallowing
    // the "duplicate column" error (SQLite has no ADD COLUMN IF NOT EXISTS).
    // Seeded onto every new conference so a working form exists out of the box (all map to real cols).
    const DEFAULT_FIELDS = [
        { name: 'first_name', label: 'Nombre', type: 'text', required: 1, order: 1, role: 'first_name' },
        { name: 'last_name', label: 'Apellido', type: 'text', required: 1, order: 2, role: 'last_name' },
        { name: 'gender', label: 'Género', type: 'select', options: 'M, F', required: 1, order: 3, role: 'gender' },
        { name: 'email', label: 'Email', type: 'text', required: 0, order: 4, role: 'email' },
        { name: 'phone', label: 'Teléfono', type: 'text', required: 0, order: 5, role: 'phone' },
        { name: 'family_group', label: 'Grupo Familiar', type: 'text', required: 0, order: 6, role: 'family_group', is_group: 1 },
    ];

    // Only a safe SQL identifier may go into ALTER TABLE ... ADD COLUMN <name>. Reject anything else.
    const isSafeColumn = (s) => typeof s === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(s);

    // Columns of the inscriptions table that are NOT form fields. A form field may never be named after
    // one of them, the portal may never write one, and no write path may take one from a body key that
    // happens to match a legacy field row (defense in depth). first_name / last_name / gender / email /
    // phone / family_group / document_number are FORM-owned columns and are deliberately NOT reserved.
    const RESERVED_INSCRIPTION_COLUMNS = new Set([
        'id', 'conference_id', 'location', 'location_id', 'custom_data', 'registration_date', 'status',
        'payment_status', 'total_due', 'amount_paid', 'room_id', 'notes', 'reg_code',
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
            'lodging_deadline DATETIME'
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
            // after it, until lodging_permission_until (NULL = until the admin revokes it).
            'lodging_permission INT DEFAULT 0',
            'lodging_permission_until DATETIME',
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
            `FOREIGN KEY (hotel_id) REFERENCES ${T.hotels}(id) ON DELETE CASCADE`
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

        // Seed a default conference (with a working default form) if none exists.
        const count = await db.get(`SELECT COUNT(*) as count FROM ${T.conferences}`);
        if (!count || count.count === 0) {
            const r = await db.run(
                `INSERT INTO ${T.conferences} (name, slug, status, description) VALUES (?, ?, ?, ?)`,
                ['Default Conference', 'default-conf', 'active', 'Initial system conference']
            );
            await seedDefaultFields(r.lastID);
            await seedDefaultRules(r.lastID);
        }
    }

    // Insert the DEFAULT_FIELDS rows for a conference (used by the seed + POST /create). Column
    // creation on inscriptions is handled by the migration/backfill below, so this only writes rows.
    async function seedDefaultFields(conferenceId) {
        for (const f of DEFAULT_FIELDS) {
            await db.run(
                `INSERT INTO ${T.fields} (conference_id, name, label, type, options, is_required, sort_order, role, is_group, is_unique) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [conferenceId, f.name, f.label, f.type, f.options || '', f.required, f.order, f.role || '', f.is_group ? 1 : 0, f.is_unique ? 1 : 0]
            );
        }
    }

    // Seed the default room-assignment rules ONCE, at conference-creation time. Deliberately NOT
    // re-seeded on "0 rules" (that resurrected them whenever the admin deleted them all + reloaded).
    async function seedDefaultRules(conferenceId) {
        const defaults = [
            { name: 'Familias juntas', type: 'keep_together', priority: 90, config: 'family_group', params: {}, hard: 0 },
            { name: 'Separar por género', type: 'separate_by', priority: 80, config: 'gender', params: {}, hard: 0 },
        ];
        for (const d of defaults) {
            await db.run(
                `INSERT INTO ${T.rules} (conference_id, name, type, enabled, priority, config, params, hard) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
                [conferenceId, d.name, d.type, d.priority, d.config, JSON.stringify(d.params || {}), d.hard ? 1 : 0]
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
    const httpError = (status, message) => new HttpError(status, message);
    const sendError = (res, e) => {
        if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
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
    function canonicalFieldValue(field, raw) {
        if (raw === undefined) return undefined;
        if (raw === null) return '';
        if (typeof raw === 'object' || typeof raw === 'function') throw httpError(400, `El campo «${field.label || field.name}» tiene un formato inválido.`);
        const s = String(raw).trim();
        if (s === '') return '';
        if (field.type === 'number') {
            const canon = canonicalNumber(s);   // textual: "30.0"→"30", "0030"→"30", "12.50"→"12.5"; 20 digits stay 20 digits
            if (canon === null) throw httpError(400, `El campo «${field.label || field.name}» debe ser un número.`);
            return canon;
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
    function canonicalFieldValues(confFields, body) {
        const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        const out = {};
        for (const f of confFields) {
            if (!isFieldColumn(f.name)) continue;
            const raw = Object.prototype.hasOwnProperty.call(src, f.name) ? src[f.name] : undefined;
            const v = canonicalFieldValue(f, raw);
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
    const FIELD_COLUMNS_SQL = `SELECT name, label, type, options, is_required, is_unique FROM ${T.fields} WHERE conference_id = ?`;

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
    // before 2.3.0 whose limit was never set) is unlimited. Check-then-insert, like assertUnique: the
    // bridge has no transactions, so two simultaneous registrations for the LAST seat of a location can
    // both pass — the same window every other guard in this file accepts.
    async function assertLocationHasRoom(loc) {
        if (!loc || loc.capacity == null) return;
        const taken = await locationOccupancy(loc.id);
        if (taken >= loc.capacity) throw httpError(409, `La localidad «${loc.name}» ha alcanzado su cupo máximo de ${loc.capacity} inscritos.`);
    }

    /**
     * Set-based payment recompute: ONE statement for a set of inscriptions. `where` is 'id = ?' |
     * 'id IN (?, ?, …)' | 'conference_id = ?'. Recomputes amount_paid straight from the payments ledger
     * in a SINGLE statement, so two concurrent payment posts cannot lose an update (there is no
     * read-in-JS-then-write). The sandbox db bridge exposes no transaction primitive, so this
     * single-statement form is the correct way to stay race-free. `+ 0.005` = half-cent tolerance so
     * `0.1 + 0.7` vs `0.8` reads `paid` (ROUND(x, 2) is NOT portable — Postgres has no
     * round(double precision, int)).
     */
    async function recomputePayments(where, params) {
        await db.run(`UPDATE ${T.inscriptions}
            SET amount_paid = (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated'),
                payment_status = CASE
                    WHEN total_due <= 0 THEN 'paid'
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated') + 0.005 >= total_due THEN 'paid'
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated') > 0 THEN 'partial'
                    ELSE 'unpaid' END
            WHERE ${where}`, params);
    }
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
    // 3. Backfill: seed default fields onto any conference that has NONE (e.g. the legacy Default
    //    Conference created before form-seeding existed), so no conference is left with a broken form.
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
        await createIndex(`${P}idx_rooms_location`, T.rooms, 'location_id');
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
        const confsNoFields = await db.all(
            `SELECT c.id FROM ${T.conferences} c WHERE NOT EXISTS (SELECT 1 FROM ${T.fields} f WHERE f.conference_id = c.id)`
        );
        for (const c of confsNoFields) await seedDefaultFields(c.id);
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

    // ── one-time data hygiene (idempotent, safe to run every boot) ───────────────────────────────
    // (a) Purge garbage inscriptions bound to a non-existent conference — residue of the old admin
    //     createInscription arity bug that posted the whole form object as conference_id.
    // (b) Recompute amount_paid / payment_status from the payments ledger so any row left stale by
    //     the previous read-modify-write race is corrected.
    try {
        // NOTE: keep a space before the closing ')' — the host SQL guard's table-attribution regex
        // captures up to whitespace/'('/';' but NOT ')', so `FROM ${T.conferences})` would read the
        // table name as '...conferences)' and wrongly deny it. `FROM ${T.conferences} )` parses clean.
        await db.run(`DELETE FROM ${T.inscriptions} WHERE conference_id NOT IN (SELECT id FROM ${T.conferences} )`);
        await db.run(`
            UPDATE ${T.inscriptions}
            SET amount_paid = (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated'),
                payment_status = CASE
                    WHEN total_due <= 0 THEN 'paid'
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated') + 0.005 >= total_due THEN 'paid'
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated') > 0 THEN 'partial'
                    ELSE 'unpaid'
                END
        `);
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

    // In-process portal-login throttle (single child process → in-memory is sufficient). Per
    // location: at most LOGIN_MAX wrong codes per rolling window, then locked out until it rolls.
    const LOGIN_MAX = 6, LOGIN_WINDOW_MS = 10 * 60 * 1000;
    const loginAttempts = new Map(); // location_id -> { count, first }
    const loginThrottled = (locationId) => {
        const rec = loginAttempts.get(String(locationId));
        return !!(rec && Date.now() - rec.first < LOGIN_WINDOW_MS && rec.count >= LOGIN_MAX);
    };
    const noteLoginFailure = (locationId) => {
        const now = Date.now(), key = String(locationId);
        const rec = loginAttempts.get(key);
        if (!rec || now - rec.first >= LOGIN_WINDOW_MS) loginAttempts.set(key, { count: 1, first: now });
        else rec.count++;
    };
    const clearLoginFailures = (locationId) => loginAttempts.delete(String(locationId));

    // Concurrency backstop (audit AUTH-A3 class): loginThrottled above is check-then-arm and the code
    // check straddles awaited db.get calls (event-loop yields), so a BURST of parallel guesses for one
    // location would all clear loginThrottled before noteLoginFailure arms the counter — evaluating far
    // more than LOGIN_MAX guesses per window. Cap the number of CONCURRENT in-flight code verifications
    // per location; the counter is per single child process so an in-memory Map is the whole cluster view.
    const LOGIN_MAX_INFLIGHT = 3;
    const loginInflight = new Map(); // location_id -> count
    const beginLoginAttempt = (locationId) => {
        const k = String(locationId), n = loginInflight.get(k) || 0;
        if (n >= LOGIN_MAX_INFLIGHT) return false;
        loginInflight.set(k, n + 1);
        return true;
    };
    const endLoginAttempt = (locationId) => {
        const k = String(locationId), n = (loginInflight.get(k) || 0) - 1;
        if (n <= 0) loginInflight.delete(k); else loginInflight.set(k, n);
    };

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
    function assertProof(proof) {
        const p = typeof proof === 'string' ? proof.trim() : '';
        if (!p) throw httpError(400, 'El comprobante es obligatorio.');
        if (p.length > MAX_PROOF_CHARS) throw httpError(400, 'El comprobante es demasiado grande (máximo 1 MB).');
        if (!PROOF_RE.test(p)) throw httpError(400, 'El comprobante debe ser una imagen (PNG, JPG, GIF o WebP).');
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
    // `:id` route params (and body ids): a positive integer or null.
    const positiveInt = (v) => {
        if (typeof v !== 'number' && typeof v !== 'string') return null;
        if (typeof v === 'string' && !/^\s*[0-9]+\s*$/.test(v)) return null;
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
    };
    // Invariant 3: a frozen location's rooms and occupants are read-only for everyone. `locationIdOrRow`
    // is a location id (looked up) or a row carrying { id, name, lodging_status }. A missing location
    // (deleted meanwhile) is not frozen. Throws 409.
    async function assertLocationNotFrozen(locationIdOrRow, action) {
        if (locationIdOrRow == null) return;
        const row = typeof locationIdOrRow === 'object' ? locationIdOrRow
            : await db.get(`SELECT id, name, lodging_status FROM ${T.locations} WHERE id = ?`, [locationIdOrRow]);
        if (!row || !isFrozen(row)) return;
        throw httpError(409, `El hospedaje de la localidad «${row.name}» está en validación/validado; reábrelo antes de ${action}.`);
    }

    // ── rule validation (shared by POST /assignment/rules and the portal's rule editor) ──────────
    // Fields a rule (or a predicate inside its params) may read: the conference's defined form fields
    // plus these base columns. Anything else (notes, custom_data, payment columns…) is rejected, so a
    // predicate can never be a read oracle over data the caller may not see.
    const BASE_RULE_FIELDS = ['first_name', 'last_name', 'gender', 'email', 'phone', 'document_number', 'family_group', 'location'];
    const PRED_OPS = new Set(['any', 'filled', 'empty', 'eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte']);
    const RULE_PARAMS_MAX_CHARS = 4096, RULE_MAX_PREDICATES = 20, RULE_PRIORITY_MAX = 1000000;
    // The allowed field-name set of a conference: defined fields ∪ BASE_RULE_FIELDS.
    async function ruleFieldNames(conferenceId) {
        const rows = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [conferenceId]);
        return new Set([...BASE_RULE_FIELDS, ...rows.map(r => r.name).filter(isFieldColumn)]);
    }
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
    // Does a single fee rule match this attendee's field values?
    function feeRuleMatches(rule, values) {
        const field = rule.field_name || '';
        const op = rule.operator || 'eq';
        if (!field || op === 'any') return true;                 // unconditional
        const raw = values ? values[field] : undefined;
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
            default: return false;
        }
    }
    async function loadFeeRules(conferenceId) {
        try { return await db.all(`SELECT * FROM ${T.feeRules} WHERE conference_id = ? AND enabled = 1 ORDER BY priority ASC, id ASC`, [conferenceId]); }
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
    // The host knows only { auth } / { admin } for isolated routes and forwards req.user without
    // capabilities, so every admin-panel route is registered { auth: true } and GATES ITSELF as the first
    // statement of its handler — `if (!await allow(req, res, section, level)) return;` (or allowAny /
    // isStaff). A refusal is 403 { error: 'No tienes acceso a esta sección.' }. The coordinator portal
    // (/portal/*: a location code) and the public form (/public/*) keep their own authentication.
    //
    // ROUTE → PERMISSION (reads = view, writes = manage; «staff» = any active team member or administrator;
    // «a | b» = any of them; «admin» = administrators only, enforced by the host AND in the handler):
    //   GET    /list                                   staff (context: the conference list)
    //   POST   /create                                 settings:manage
    //   PUT    /:id                                    settings:manage — a body that ONLY sets lodging_deadline
    //                                                  (the «plazos» of Localidades): locations:manage | settings:manage
    //   DELETE /:id                                    settings:manage
    //   POST   /publish                                settings:manage
    //   GET    /fields                                 staff (context: names every attendee column)
    //   POST   /fields, DELETE /fields/:id             settings:manage
    //   GET    /fee-rules                              settings:view
    //   POST   /fee-rules, DELETE /fee-rules/:id       settings:manage
    //   POST   /reprice                                settings:manage
    //   GET    /locations                              staff (context: names, capacity, the conference row);
    //                                                  the access `code` only with locations:manage (else null)
    //   POST   /locations, PUT/DELETE /locations/:id   locations:manage (codes = who can log in to the portal)
    //   GET    /locations/:id/lodging                  locations:view
    //   POST   /locations/:id/lodging/validate|return|reopen   locations:manage
    //   GET    /hotels                                 lodging:view | inscriptions:view | dashboard:view | reports:view
    //   POST   /hotels, PUT/DELETE /hotels/:id         lodging:manage
    //   POST   /hotels/:id/allot                       lodging:manage
    //   POST   /rooms, PUT/DELETE /rooms/:id           lodging:manage
    //   GET    /assignment/rules                       lodging:view
    //   POST   /assignment/rules, DELETE /assignment/rules/:id, POST /assignment/reset, POST /assignment/run
    //                                                  lodging:manage
    //   POST   /inscriptions/:id/assign                lodging:manage
    //   GET    /inscriptions                           inscriptions:view | payments:view | lodging:view |
    //                                                  transport:view | accounting:view | dashboard:view | reports:view
    //                                                  (the roster those pages name people from); `reg_code` only
    //                                                  with inscriptions:view (else null)
    //   POST   /inscriptions, PUT/DELETE /inscriptions/:id   inscriptions:manage
    //   GET    /inscriptions/export                    reports:view | inscriptions:view (the Código column only
    //                                                  with inscriptions:view)
    //   GET    /inscriptions/:id/payments              payments:view | inscriptions:view
    //   POST   /inscriptions/:id/payments              payments:manage
    //   DELETE /payments/:id                           payments:manage
    //   POST   /payments/:id/validate|reject           payments:manage
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
    //   POST   /meals/deliver                          meals_delivery:manage
    //   DELETE /meals/deliveries/:id                   meals_delivery:manage
    //   GET    /meals/services/:id/stats               meals:view | meals_delivery:manage
    //   GET    /meals/services/:id/deliveries          meals:view | meals_delivery:manage (recent deliveries)
    //   GET    /meals/services/:id/report              meals:view
    //   (every meals answer carries reg_code only with inscriptions:view, else null)
    //   GET    /staff/me                               any authenticated user (all `none` when not on the team)
    //   GET|POST /staff/roles, PUT|DELETE /staff/roles/:id       admin
    //   GET|POST /staff/members, PUT|DELETE /staff/members/:id   admin
    //   GET    /staff/user-search                      admin
    //   /public/*, /portal/*                           unchanged (no WordJS session involved)
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
        { key: 'reports', levels: ['none', 'view'] },
        { key: 'settings', levels: ['none', 'view', 'manage'] },
    ];
    const STAFF_LEVELS = new Map(STAFF_SECTIONS.map(s => [s.key, s.levels]));
    const NO_ACCESS = 'No tienes acceso a esta sección.';
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
        if (u && u.role === 'administrator') return { isAdmin: true, isStaff: true, permissions: ADMIN_PERMISSIONS, role: null };
        const uid = u ? positiveInt(u.id) : null;
        if (!uid) return { isAdmin: false, isStaff: false, permissions: NO_PERMISSIONS, role: null };
        const key = String(uid), now = Date.now();
        const hit = staffCache.get(key);
        if (hit && hit.gen === staffGen && now - hit.at < STAFF_CACHE_MS) return hit.perms;
        const gen = staffGen;
        const row = await db.get(
            `SELECT m.id, m.active, m.role_id, r.name AS role_name, r.permissions FROM ${T.staffMembers} m JOIN ${T.staffRoles} r ON r.id = m.role_id WHERE m.user_id = ?`, [uid]);
        const perms = row && Number(row.active) === 1
            ? { isAdmin: false, isStaff: true, permissions: Object.freeze(normalizePermissions(row.permissions)), role: { id: row.role_id, name: row.role_name } }
            : { isAdmin: false, isStaff: false, permissions: NO_PERMISSIONS, role: null };
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

    // ── WordJS users (grant users:read) ──
    const USERS_GRANT_MESSAGE = 'Para buscar usuarios, concede al plugin el permiso «users:read» en Plugins.';
    const isUsersGrantError = (e) => /without permission|security block|not granted|permission/i.test(String(e && e.message ? e.message : e));
    const usersBridge = () => (wordjs.users && typeof wordjs.users.findById === 'function' && typeof wordjs.users.search === 'function' ? wordjs.users : null);
    // The host's SAFE projection → the wire shape { id, login, email, name, role }.
    const wireUser = (u) => (u && u.id != null ? {
        id: u.id,
        login: u.userLogin || u.username || null,
        email: u.userEmail || null,
        name: u.displayName || u.userLogin || u.username || null,
        role: u.role || null,
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
    // logged-in user who is not on the team, so the page can explain how to get access).
    http.route('get', '/staff/me', { auth: true }, async (req, res) => {
        try {
            const p = await permsOf(req);
            const u = req.user || {};
            res.json({
                isAdmin: p.isAdmin,
                isStaff: p.isStaff,
                permissions: { ...p.permissions },
                role: p.role ? { id: p.role.id, name: p.role.name } : null,
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
                });
            }
            res.json({ members, users_read: usersRead });
        } catch (e) { sendError(res, e); }
    });

    // Add a WordJS user to the team: { user_id, role_id }. 400 unknown role / an administrator (they already
    // have everything); 404 unknown user; 409 already on the team; 503 without the users:read grant.
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

    // Change a member's role and/or (de)activate them: { role_id?, active? }. Effective at once.
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
            res.json({ users: (Array.isArray(list) ? list : []).map(wireUser).filter(Boolean) });
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

            // Seed the default form + default assignment rules (the admin can customize or delete both).
            await seedDefaultFields(conference_id);
            await seedDefaultRules(conference_id);

            res.json({ success: true, id: conference_id });
        } catch (e) { sendError(res, e); }
    });

    // Update conference metadata (name/slug/dates/fee/description/status). Only the fields present
    // in the body are changed, so partial updates are safe.
    const CONFERENCE_STATUSES = new Set(['draft', 'active', 'archived']);
    http.route('put', '/:id', { auth: true }, async (req, res) => {
        // Only the lodging deadline (the «plazos» of Localidades) → locations:manage suffices too.
        const editKeys = ['name', 'slug', 'date_start', 'date_end', 'fee_default', 'description', 'status', 'lodging_deadline'].filter(k => (req.body || {})[k] !== undefined);
        const deadlineOnly = editKeys.length === 1 && editKeys[0] === 'lodging_deadline';
        if (!await (deadlineOnly ? allowAny(req, res, [['settings', 'manage'], ['locations', 'manage']]) : allow(req, res, 'settings', 'manage'))) return;
        const { name, slug, date_start, date_end, fee_default, description, status, lodging_deadline } = req.body;
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
            if (lodging_deadline !== undefined) { sets.push('lodging_deadline = ?'); params.push(normDate(lodging_deadline, 'plazo de hospedaje')); }
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

    http.route('delete', '/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        try {
            // Meals (2.14.0): the FKs cascade; the explicit deletes keep it so with foreign keys off too.
            // Parent first, under the meals lock (see withMealsLock / deleteMealsOfConference).
            await withMealsLock(async () => {
                await db.run(`DELETE FROM ${T.conferences} WHERE id = ?`, [req.params.id]);
                await deleteMealsOfConference(req.params.id);
            });
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
    // `withCodes`: also match the search term against reg_code. Only for callers who may SEE the codes —
    // otherwise the filter is an oracle that rebuilds a hidden code one character at a time.
    async function inscriptionFilters(q, params, withCodes) {
        let where = '';
        const search = q.search ? String(q.search).slice(0, 200) : '';
        if (search) {
            const flds = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [q.conference_id]);
            const cols = [...new Set([...flds.map(f => f.name).filter(isFieldColumn), 'location', ...(withCodes ? ['reg_code'] : [])])];
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
        else if (q.assigned === 'false') where += ` AND i.room_id IS NULL`;
        return where;
    }

    // Inscriptions for a conference
    http.route('get', '/inscriptions', { auth: true }, async (req, res) => {
        const perms = await allowAny(req, res, [['inscriptions', 'view'], ['payments', 'view'], ['lodging', 'view'], ['transport', 'view'], ['accounting', 'view'], ['dashboard', 'view'], ['reports', 'view']]);
        if (!perms) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            let query = `
                SELECT i.*, r.room_number, r.hotel_id, h.name as hotel_name,
                       (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = i.id AND status = 'pending') as pending_amount
                FROM ${T.inscriptions} i
                LEFT JOIN ${T.rooms} r ON i.room_id = r.id
                LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id
                WHERE i.conference_id = ?
            `;
            const params = [conference_id];
            query += await inscriptionFilters(req.query, params, canSeeRegCodes(perms));
            query += ` ORDER BY i.last_name, i.first_name`;

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
            // registration code (barcode payload) only reaches inscriptions:view.
            const showCodes = canSeeRegCodes(perms);
            const parsedList = list.map(item => ({ ...item, custom_data: parseCd(item.custom_data), reg_code: showCodes ? item.reg_code : null }));

            res.json(parsedList);
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/publish', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        const { conference_id, published } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
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
    const FIELD_TYPES = new Set(['text', 'number', 'select', 'textarea', 'date', 'email', 'tel', 'notes']);
    http.route('post', '/fields', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        const { id, conference_id, name, label, type, options, is_required, sort_order, width, is_group, is_unique } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const cleanLabel = String(label || '').trim();
        if (!cleanLabel) return res.status(400).json({ error: 'La etiqueta del campo es obligatoria.' });
        if (cleanLabel.length > 120) return res.status(400).json({ error: 'La etiqueta del campo es demasiado larga (máximo 120 caracteres).' });
        if (!FIELD_TYPES.has(type)) return res.status(400).json({ error: 'Tipo de campo inválido.' });
        const opts = options == null ? '' : String(options);
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
                const existing = await db.get(`SELECT type, conference_id FROM ${T.fields} WHERE id = ?`, [id]);
                if (!existing) return res.status(404).json({ error: 'Campo no encontrado.' });
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
                const colName = isSafeColumn(requested) ? requested : ('f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
                const clash = await db.get(`SELECT id FROM ${T.fields} WHERE conference_id = ? AND name = ?`, [conference_id, colName]);
                if (clash) return res.status(409).json({ error: 'Ya existe un campo con ese nombre en este formulario.' });
                if (grp) await db.run(`UPDATE ${T.fields} SET is_group = 0 WHERE conference_id = ?`, [conference_id]);
                await addColumnIfMissing(T.inscriptions, colName, 'TEXT');
                await db.run(
                    `INSERT INTO ${T.fields} (conference_id, name, label, type, options, is_required, sort_order, width, is_group, is_unique) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, colName, cleanLabel, type, opts, is_required ? 1 : 0, sort_order || 0, w, grp, uniq]
                );
            }
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/fields/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        try {
            const field = await db.get(`SELECT conference_id FROM ${T.fields} WHERE id = ?`, [req.params.id]);
            if (field) {
                const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [field.conference_id]);
                if (conf?.is_form_published) {
                    return res.status(400).json({ error: 'No se pueden eliminar campos después de publicar el formulario.' });
                }
            }
            await db.run(`DELETE FROM ${T.fields} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === FEE RULES (dynamic pricing) ===
    const FEE_OPERATORS = new Set(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'filled', 'empty', 'any']);

    http.route('get', '/fee-rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'view')) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT * FROM ${T.feeRules} WHERE conference_id = ? ORDER BY priority ASC, id ASC`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/fee-rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'settings', 'manage')) return;
        const { id, conference_id, label, field_name, operator, value, action, amount, priority, enabled } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const op = FEE_OPERATORS.has(operator) ? operator : 'eq';
        const act = action === 'add' ? 'add' : 'set';
        if (!Number.isFinite(Number(amount)) || Math.abs(Number(amount)) > MAX_MONEY) return res.status(400).json({ error: 'El monto de la regla es inválido.' });
        const amt = roundMoney(amount);
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
            const vals = canonicalFieldValues(confFields, fields);
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
        if (!await allow(req, res, 'inscriptions', 'manage')) return;
        const { conference_id, ...fieldValues } = req.body || {};
        // Guard against a non-scalar conference_id (the old client arity bug shipped the whole form
        // object here) so we never insert a garbage row bound to '[object Object]'.
        const confId = Number(conference_id);
        if (!confId || !Number.isFinite(confId)) return res.status(400).json({ error: 'Missing or invalid conference_id' });

        try {
            const conf = await db.get(`SELECT fee_default FROM ${T.conferences} WHERE id = ?`, [confId]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });

            // The form is the source of truth: write each DEFINED field's canonical value into its own
            // column. Values for keys that aren't defined (writable) fields are ignored.
            const confFields = await db.all(FIELD_COLUMNS_SQL, [confId]);
            const values = { conference_id: confId };
            Object.assign(values, canonicalFieldValues(confFields, fieldValues));
            assertRequired(confFields, values, false);

            // The admin explicitly PICKS the location (unlike the portal, which forces the coordinator's
            // own). It's an operational column, not a form field: `location_id` (preferred) or the
            // legacy `location` name, both resolved against this conference's locations.
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

            const keys = Object.keys(values);
            const result = await db.run(
                `INSERT INTO ${T.inscriptions} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                Object.values(values)
            );
            res.json({ success: true, id: result.lastID });
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
                + ` (SELECT COUNT(*) FROM ${T.rooms} r WHERE r.location_id = l.id) AS rooms_allotted,`
                + ` (SELECT COALESCE(SUM(r.capacity), 0) FROM ${T.rooms} r WHERE r.location_id = l.id) AS beds_allotted,`
                + ` (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.location_id = l.id AND i.room_id IS NOT NULL) AS lodged,`
                + ` (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.location_id = l.id AND i.room_id IS NULL AND ${occupiedSql('i.status')}) AS unlodged`
                + ` FROM ${T.locations} l WHERE l.conference_id = ? ORDER BY l.name`, [conference_id]);
            for (const l of locations) {
                l.payment_methods = enabledPaymentMethods(l);
                l.lodging_status = lodgingStatusOf(l);
                l.rooms_allotted = Number(l.rooms_allotted) || 0;
                l.beds_allotted = Number(l.beds_allotted) || 0;
                l.lodged = Number(l.lodged) || 0;
                l.unlodged = Number(l.unlodged) || 0;
                const win = lodgingWindow(conf, l);
                l.lodging_permission = win.permission.granted;
                l.lodging_permission_until = win.permission.until;
                l.lodging_permission_active = win.permission.active;
                l.lodging_permission_expired = win.permission.expired;
                // Can the coordinator change the lodging right now? (window open AND still a draft)
                l.lodging_can_edit = win.open && l.lodging_status === 'draft';
                // The access code IS the coordinator's portal login: only who may change it sees it.
                if (!showCodes) l.code = null;
                // Every team member gets the locations as context (names, capacity, lodging state); the
                // coordinator's contact and the admin's review notes are the Localidades section's business.
                if (!hasLevel(perms, 'locations', 'view')) { l.responsible_name = null; l.responsible_phone = null; l.lodging_note = null; l.lodging_reviewed_by = null; }
            }
            if (conf) conf.lodging_deadline_passed = lodgingDeadlineInfo(conf).passed;
            res.json({ locations, conference: conf });
        } catch (e) { sendError(res, e); }
    });

    // Location names are unique per conference (case-insensitive) so the display label is unambiguous.
    http.route('post', '/locations', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        const { conference_id, name, responsible_name, responsible_phone, capacity, payment_methods } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const cleanName = String(name || '').trim();
        if (!cleanName) return res.status(400).json({ error: 'El nombre de la localidad es obligatorio.' });
        // The maximum number of registrants is part of creating a location, not an afterthought.
        if (capacity === undefined || capacity === null) return res.status(400).json({ error: 'El cupo máximo de inscritos es obligatorio.' });

        try {
            const cap = parseCapacity(capacity);
            // Forms of payment: chosen at creation (default both), editable later through PUT.
            const methods = payment_methods === undefined ? PAYMENT_METHODS.slice() : parsePaymentMethods(payment_methods);
            const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const dup = await db.get(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND LOWER(name) = LOWER(?)`, [conference_id, cleanName]);
            if (dup) return res.status(409).json({ error: 'Ya existe una localidad con ese nombre en esta conferencia.' });
            const code = await genAccessCode();
            const result = await db.run(
                `INSERT INTO ${T.locations} (conference_id, name, code, responsible_name, responsible_phone, capacity, payment_methods) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [conference_id, cleanName, code, responsible_name || null, responsible_phone || null, cap, JSON.stringify(methods)]
            );
            res.json({ success: true, id: result.lastID, code, payment_methods: methods });
        } catch (e) { sendError(res, e); }
    });

    // Update a location; pass rotate_code:true to issue a fresh access code (invalidates old sessions).
    // A rename also refreshes the display label on the location's inscriptions (location_id stays).
    // `capacity` may go up or down, but never below the seats already taken (409 with the current count).
    // `payment_methods` replaces the enabled set (a form of payment not enabled at creation can be enabled here).
    // `lodging_permission` (true/false) lets this location keep arranging lodging after the conference deadline,
    // until `lodging_permission_until` (optional date; '' / null = until revoked). Revoking clears the date.
    http.route('put', '/locations/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        const { name, responsible_name, responsible_phone, rotate_code, capacity, payment_methods, lodging_permission, lodging_permission_until } = req.body;
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
            if (responsible_name !== undefined) { sets.push('responsible_name = ?'); params.push(responsible_name || null); }
            if (responsible_phone !== undefined) { sets.push('responsible_phone = ?'); params.push(responsible_phone || null); }
            if (capacity !== undefined) {
                const cap = parseCapacity(capacity);
                const taken = await locationOccupancy(loc.id);
                if (cap < taken) return res.status(409).json({ error: `El cupo no puede ser menor que los ${taken} inscritos que ya tiene la localidad.`, inscribed: taken });
                sets.push('capacity = ?'); params.push(cap);
            }
            if (payment_methods !== undefined) { sets.push('payment_methods = ?'); params.push(JSON.stringify(parsePaymentMethods(payment_methods))); }
            if (lodging_permission !== undefined || lodging_permission_until !== undefined) {
                const PERM = { true: 1, false: 0, 1: 1, 0: 0 };
                const granted = lodging_permission === undefined ? (Number(loc.lodging_permission) ? 1 : 0) : PERM[String(lodging_permission)];
                if (granted === undefined) return res.status(400).json({ error: 'El permiso debe ser verdadero o falso.' });
                let until = null;
                if (granted) {
                    until = lodging_permission_until === undefined ? (loc.lodging_permission_until || null) : normDate(lodging_permission_until, 'permiso de hospedaje');
                    if (until && lodgingPermissionInfo({ lodging_permission: 1, lodging_permission_until: until }).expired) {
                        return res.status(400).json({ error: 'La fecha del permiso ya pasó.' });
                    }
                }
                sets.push('lodging_permission = ?', 'lodging_permission_until = ?'); params.push(granted, until);
            }
            let newCode = null;
            if (rotate_code) { newCode = await genAccessCode(); sets.push('code = ?'); params.push(newCode); }
            if (sets.length) {
                params.push(loc.id);
                await db.run(`UPDATE ${T.locations} SET ${sets.join(', ')} WHERE id = ?`, params);
            }
            if (newName !== null) await db.run(`UPDATE ${T.inscriptions} SET location = ? WHERE location_id = ?`, [newName, loc.id]);
            res.json({ success: true, code: newCode || loc.code });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/locations/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            if (!id) return res.status(404).json({ error: 'Localidad no encontrada.' });
            // Lodging: its attendees leave the rooms that were allotted to it (those rooms go back to
            // the pool and would otherwise hold people of no location), and its own rules go with it.
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE location_id = ? AND room_id IN (SELECT id FROM ${T.rooms} WHERE location_id = ?)`, [id, id]);
            await db.run(`UPDATE ${T.rooms} SET location_id = NULL WHERE location_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.rules} WHERE location_id = ?`, [id]);
            // Under the meals lock: a plan write re-reads the location inside that lock, so it can never
            // add a plan row for this location once it is gone.
            await withMealsLock(async () => {
                // No FK can be added by ALTER in SQLite: detach the attendees explicitly. The label is kept
                // for history (reports/CSV still show where they registered; the meals views show the
                // live location of location_id instead).
                await db.run(`UPDATE ${T.inscriptions} SET location_id = NULL WHERE location_id = ?`, [id]);
                await db.run(`DELETE FROM ${T.locations} WHERE id = ?`, [id]);
                // Meals (2.14.0): the location's plan goes with it (parent first; the FK cascades too); its
                // attendees keep only their explicit per-person includes (and every delivery already made —
                // that is history).
                await db.run(`DELETE FROM ${T.mealPlan} WHERE location_id = ?`, [id]);
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // ── lodging review (admin validates what the coordinator arranged) ───────────────────────
    // The arrangement of a location: its allotted rooms with L's occupants, L's attendees without a
    // room, those the admin placed elsewhere, the rules in force and the audit of the current state.
    http.route('get', '/locations/:id/lodging', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'view')) return;
        try {
            const id = positiveInt(req.params.id);
            const loc = id ? await db.get(`SELECT * FROM ${T.locations} WHERE id = ?`, [id]) : null;
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            res.json(await loadLodging(loc, { forAdmin: true }));
        } catch (e) { sendError(res, e); }
    });
    // State transitions are compare-and-set: ONE conditional UPDATE under the assignment lock; a 409 is
    // derived from `changes === 0` (someone else moved the state first).
    http.route('post', '/locations/:id/lodging/validate', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'locations', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            const loc = id ? await db.get(`SELECT id FROM ${T.locations} WHERE id = ?`, [id]) : null;
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const r = await withAssignmentLock(() => db.run(
                `UPDATE ${T.locations} SET lodging_status = 'validated', lodging_reviewed_at = CURRENT_TIMESTAMP, lodging_reviewed_by = ?, lodging_note = NULL WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'submitted'`,
                [reviewerOf(req), id]));
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
            const r = await withAssignmentLock(() => db.run(
                `UPDATE ${T.locations} SET lodging_status = 'draft', lodging_note = ?, lodging_reviewed_at = CURRENT_TIMESTAMP, lodging_reviewed_by = ? WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'submitted'`,
                [note, reviewerOf(req), id]));
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
    http.route('post', '/hotels', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { conference_id, name, address, description, capacity } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        if (!String(name || '').trim()) return res.status(400).json({ error: 'El nombre del hotel es obligatorio.' });
        try {
            const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const r = await db.run(`INSERT INTO ${T.hotels} (conference_id, name, address, description, capacity) VALUES (?, ?, ?, ?, ?)`,
                [conference_id, String(name).trim(), address || null, description || null, Number(capacity) || 0]);
            res.json({ success: true, id: r.lastID });
        } catch (e) { sendError(res, e); }
    });
    http.route('put', '/hotels/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { name, address, description, capacity } = req.body;
        try {
            const sets = [], params = [];
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
            // A room allotted to a frozen location is part of an arrangement under review.
            const frozen = await db.get(
                `SELECT l.id, l.name, l.lodging_status FROM ${T.rooms} r JOIN ${T.locations} l ON r.location_id = l.id WHERE r.hotel_id = ? AND ${frozenSqlOf('l.lodging_status')} ORDER BY l.name LIMIT 1`, [id]);
            if (frozen) await assertLocationNotFrozen(frozen, 'eliminar sus habitaciones');
            // Free any attendees assigned to this hotel's rooms before the FK cascade drops the rooms,
            // so occupancy counts stay honest.
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE room_id IN (SELECT id FROM ${T.rooms} WHERE hotel_id = ?)`, [id]);
            await db.run(`DELETE FROM ${T.hotels} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // Allot every room of a hotel (or only `room_ids`) to a location — `location_id` null = back to the
    // pool. All-or-nothing: the frozen checks (target + every affected room's current location) and the
    // occupant check run first, then ONE UPDATE.
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
                // Frozen: the target, then every location whose rooms would change hands.
                if (target) await assertLocationNotFrozen(target.id, 'cambiar sus habitaciones');
                const frozen = await db.get(
                    `SELECT l.id, l.name, l.lodging_status FROM ${T.rooms} r JOIN ${T.locations} l ON r.location_id = l.id WHERE r.hotel_id = ?${inSql} AND ${frozenSqlOf('l.lodging_status')} ORDER BY l.name LIMIT 1`,
                    [hotelId, ...inParams]);
                if (frozen) await assertLocationNotFrozen(frozen, 'cambiar sus habitaciones');
                // Occupants: an allotted room may only hold the target location's attendees.
                if (target) {
                    const bad = await db.all(
                        `SELECT DISTINCT r.room_number FROM ${T.inscriptions} i JOIN ${T.rooms} r ON i.room_id = r.id WHERE r.hotel_id = ?${inSql} AND (i.location_id IS NULL OR i.location_id != ?) ORDER BY r.room_number`,
                        [hotelId, ...inParams, target.id]);
                    if (bad.length) return { bad };
                }
                const r = await db.run(`UPDATE ${T.rooms} SET location_id = ? WHERE hotel_id = ?${roomIds ? ` AND id IN (${roomIds.map(() => '?').join(', ')})` : ''}`, [target ? target.id : null, hotelId, ...inParams]);
                return { changes: Number(r && r.changes) || 0 };
            });
            if (outcome.bad) {
                const names = outcome.bad.map(b => b.room_number).slice(0, 20).join(', ');
                return res.status(409).json({ error: `Hay ocupantes de otra localidad en ${outcome.bad.length === 1 ? 'la habitación' : 'las habitaciones'} ${names}; libéralas antes de asignarlas.`, rooms: outcome.bad.map(b => b.room_number) });
            }
            res.json({ success: true, rooms: outcome.changes });
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/rooms', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { hotel_id, room_number, capacity, gender, is_family, family_name, notes } = req.body;
        if (!hotel_id) return res.status(400).json({ error: 'Missing hotel_id' });
        if (!String(room_number || '').trim()) return res.status(400).json({ error: 'El número de habitación es obligatorio.' });
        try {
            const hotel = await db.get(`SELECT id FROM ${T.hotels} WHERE id = ?`, [hotel_id]);
            if (!hotel) return res.status(404).json({ error: 'Hotel no encontrado.' });
            const r = await db.run(`INSERT INTO ${T.rooms} (hotel_id, room_number, capacity, gender, is_family, family_name, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [hotel_id, String(room_number).trim(), Math.max(1, Number(capacity) || 1), gender || 'Mixed', is_family ? 1 : 0, family_name || null, notes || null]);
            res.json({ success: true, id: r.lastID });
        } catch (e) { sendError(res, e); }
    });
    // `location_id` (positive integer | null | '' → null) allots the room to a location of the room's
    // conference. Checks, in order: frozen (the room's current location when location_id/capacity
    // changes; the target location when allotting), then occupants (an allotted room may only hold the
    // target location's attendees).
    http.route('put', '/rooms/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { room_number, capacity, gender, is_family, family_name, notes, location_id } = req.body;
        try {
            const id = positiveInt(req.params.id);
            const room = id ? await db.get(`SELECT r.*, h.conference_id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE r.id = ?`, [id]) : null;
            if (!room) return res.status(404).json({ error: 'Habitación no encontrada.' });
            const sets = [], params = [];
            if (room_number !== undefined) {
                if (!String(room_number).trim()) return res.status(400).json({ error: 'El número de habitación es obligatorio.' });
                sets.push('room_number = ?'); params.push(String(room_number).trim());
            }
            // Resolve the target location first so every 400 precedes the frozen/occupant 409s.
            let target;   // undefined = not in the body; null = back to the pool; row = allot
            if (location_id !== undefined) {
                if (location_id === null || location_id === '') target = null;
                else {
                    const lid = positiveInt(location_id);
                    target = lid ? await db.get(`SELECT id, name, lodging_status FROM ${T.locations} WHERE id = ? AND conference_id = ?`, [lid, room.conference_id]) : null;
                    if (!target) return res.status(400).json({ error: 'Localidad no encontrada en esta conferencia.' });
                }
            }
            const locationChanges = target !== undefined && (target ? Number(target.id) : null) !== (room.location_id == null ? null : Number(room.location_id));
            let cap = null;
            if (capacity !== undefined) cap = Math.max(1, Number(capacity) || 1);
            const capacityChanges = cap !== null && cap !== Number(room.capacity);
            if (gender !== undefined) { sets.push('gender = ?'); params.push(gender || 'Mixed'); }
            if (is_family !== undefined) { sets.push('is_family = ?'); params.push(is_family ? 1 : 0); }
            if (family_name !== undefined) { sets.push('family_name = ?'); params.push(family_name || null); }
            if (notes !== undefined) { sets.push('notes = ?'); params.push(notes || null); }
            // The occupant checks and the UPDATE are serialised with the engine (which loads occupancy
            // into memory, places people, then flushes): a re-allotment or a capacity change may not
            // interleave with a run's load→flush window.
            await withAssignmentLock(async () => {
                if ((locationChanges || capacityChanges) && room.location_id != null) await assertLocationNotFrozen(room.location_id, 'cambiar sus habitaciones');
                if (locationChanges && target) await assertLocationNotFrozen(target.id, 'cambiar sus habitaciones');
                if (cap !== null) {
                    // Never shrink capacity below the people already placed in the room.
                    const occ = await db.get(`SELECT COUNT(*) as c FROM ${T.inscriptions} WHERE room_id = ?`, [id]);
                    if (cap < (occ?.c || 0)) throw httpError(400, `La capacidad no puede ser menor que los ${occ.c} ocupantes actuales.`);
                    sets.push('capacity = ?'); params.push(cap);
                }
                if (target !== undefined) {
                    if (target) {
                        const foreign = await db.get(`SELECT COUNT(*) AS c FROM ${T.inscriptions} WHERE room_id = ? AND (location_id IS NULL OR location_id != ?)`, [id, target.id]);
                        if (Number(foreign && foreign.c) > 0) throw httpError(409, 'La habitación tiene ocupantes de otra localidad; libérala antes de asignarla.');
                    }
                    sets.push('location_id = ?'); params.push(target ? target.id : null);
                }
                if (!sets.length) return;
                params.push(id);
                await db.run(`UPDATE ${T.rooms} SET ${sets.join(', ')} WHERE id = ?`, params);
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/rooms/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        try {
            const id = positiveInt(req.params.id);
            if (!id) return res.status(404).json({ error: 'Habitación no encontrada.' });
            const room = await db.get(`SELECT id, location_id FROM ${T.rooms} WHERE id = ?`, [id]);
            if (room && room.location_id != null) await assertLocationNotFrozen(room.location_id, 'eliminar sus habitaciones');
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE room_id = ?`, [id]);
            await db.run(`DELETE FROM ${T.rooms} WHERE id = ?`, [id]);
            res.json({ success: true });
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
            const byBus = new Map();
            for (const t of tickets) { if (!byBus.has(t.bus_id)) byBus.set(t.bus_id, []); byBus.get(t.bus_id).push(ticketRow(t)); }
            for (const b of buses) b.passengers = byBus.get(b.id) || [];
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
            // check and the write otherwise left more tickets sold than the capacity just set. A
            // reprice writes the tickets' new price under it too, the lock transport payments check
            // what a ticket still owes under: written after the lock was released, a payment landing
            // in between was accepted against the old price, and the ticket ended up paid beyond the
            // new one — what the check below refuses.
            const outcome = await withAssignmentLock(async () => {
                const bus = id ? await db.get(`${busSelect} WHERE b.id = ?`, [id]) : null;
                if (!bus) throw httpError(404, 'Bus no encontrado.');
                const v = parseBusBody(req.body || {}, true);
                if (v.capacity !== undefined && v.capacity < (Number(bus.sold) || 0)) {
                    return { status: 409, body: { error: `La capacidad no puede ser menor que los ${bus.sold} pasajes vendidos.`, sold: Number(bus.sold) } };
                }
                // Repricing may never leave a ticket paid beyond its new price (money already received is not
                // silently turned into a credit): refuse before writing anything.
                if (req.body && req.body.reprice_tickets && v.price !== undefined) {
                    const over = await db.get(`SELECT COUNT(*) AS n FROM ${T.tickets} WHERE bus_id = ? AND amount_paid > ? + 0.005`, [id, v.price]);
                    if (Number(over && over.n) > 0) return { status: 409, body: { error: `El nuevo precio es menor que lo ya pagado en ${over.n} pasaje(s); ajusta esos pagos primero o aplica el precio solo a las próximas ventas.` } };
                }
                const keys = Object.keys(v);
                if (keys.length) await db.run(`UPDATE ${T.buses} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => v[k]), id]);
                if (req.body && req.body.reprice_tickets && v.price !== undefined) {
                    await db.run(`UPDATE ${T.tickets} SET price = ? WHERE bus_id = ?`, [v.price, id]);
                    await recomputeTickets('bus_id = ?', [id]);
                }
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
                const released = await db.run(`DELETE FROM ${T.tickets} WHERE bus_id = ?`, [id]);
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
        try {
            const id = positiveInt(req.params.id);
            const raw = req.body && req.body.inscription_ids;
            if (!Array.isArray(raw) || !raw.length) return res.status(400).json({ error: 'Selecciona al menos un participante.' });
            if (raw.length > BUS_MAX_PASSENGERS_PER_CALL) return res.status(400).json({ error: `Máximo ${BUS_MAX_PASSENGERS_PER_CALL} participantes por operación.` });
            const ids = [...new Set(raw.map(positiveInt))];
            if (ids.some(n => !n)) return res.status(400).json({ error: 'Identificadores de inscripción inválidos.' });
            const result = await withAssignmentLock(async () => {
                const bus = id ? await db.get(`${busSelect} WHERE b.id = ?`, [id]) : null;
                if (!bus) throw httpError(404, 'Bus no encontrado.');
                const rows = await db.all(
                    `SELECT i.id, i.status, (SELECT COUNT(*) FROM ${T.tickets} t WHERE t.bus_id = ? AND t.inscription_id = i.id) AS on_bus`
                    + ` FROM ${T.inscriptions} i WHERE i.conference_id = ? AND i.id IN (${ids.map(() => '?').join(', ')})`,
                    [id, bus.conference_id, ...ids]);
                if (rows.length !== ids.length) throw httpError(400, 'Alguno de los participantes no pertenece a esta conferencia.');
                if (rows.some(r => r.status === 'cancelled')) throw httpError(400, 'Un participante cancelado no puede recibir pasaje.');
                const fresh = rows.filter(r => !Number(r.on_bus)).map(r => r.id);
                const free = Number(bus.capacity) - (Number(bus.sold) || 0);
                if (fresh.length > free) throw httpError(409, `Solo quedan ${Math.max(0, free)} puestos en este bus.`);
                const price = roundMoney(Number(bus.price) || 0);
                if (fresh.length) {
                    await runBatched(fresh.map(iid => [`INSERT INTO ${T.tickets} (bus_id, inscription_id, price, amount_paid, payment_status) VALUES (?, ?, ?, 0, ?)`, [id, iid, price, price <= 0 ? 'paid' : 'unpaid']]));
                }
                return { added: fresh.length, skipped: ids.length - fresh.length };
            });
            res.json({ success: true, ...result });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/buses/:id/passengers/:inscriptionId', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'transport', 'manage')) return;
        try {
            const id = positiveInt(req.params.id), iid = positiveInt(req.params.inscriptionId);
            // Same as the bus delete: the no-payments check and the delete under the payments' lock.
            const outcome = await withAssignmentLock(async () => {
                const ticket = id && iid ? await db.get(`SELECT id FROM ${T.tickets} WHERE bus_id = ? AND inscription_id = ?`, [id, iid]) : null;
                if (!ticket) return { status: 404, body: { error: 'Pasaje no encontrado.' } };
                const paid = await db.get(`SELECT COUNT(*) AS n FROM ${T.transportPayments} WHERE ticket_id = ?`, [ticket.id]);
                if (Number(paid && paid.n) > 0) return { status: 409, body: { error: 'El pasaje tiene pagos registrados; elimínalos antes de quitar al pasajero.' } };
                await db.run(`DELETE FROM ${T.tickets} WHERE id = ?`, [ticket.id]);
                return {};
            });
            if (outcome.status) return res.status(outcome.status).json(outcome.body);
            res.json({ success: true });
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
        try {
            const id = positiveInt(req.params.id);
            const { amount, method, reference, date } = req.body || {};
            if (!Number.isFinite(Number(amount)) || Number(amount) > MAX_MONEY) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const amt = roundMoney(amount);
            if (amt <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const m = assertPaymentMethod(method);
            const when = date === undefined || date === null || date === '' ? null : normDate(date, 'fecha del pago');
            const result = await withAssignmentLock(async () => {
                const ticket = id ? await db.get(`SELECT * FROM ${T.tickets} WHERE id = ?`, [id]) : null;
                if (!ticket) throw httpError(404, 'Pasaje no encontrado.');
                const owed = toCents(ticket.price) - toCents(ticket.amount_paid);
                if (toCents(amt) > owed) throw httpError(400, `El pago supera el saldo del pasaje (${fromCents(Math.max(0, owed)).toFixed(2)}).`);
                const cols = ['ticket_id', 'amount', 'method', 'reference', 'recorded_by'], vals = [ticket.id, amt, m, shortText(reference, 100), reviewerOf(req)];
                if (when) { cols.push('date'); vals.push(when); }
                const r = await db.run(`INSERT INTO ${T.transportPayments} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
                await recomputeTickets('id = ?', [ticket.id]);
                return { id: r.lastID };
            });
            res.json({ success: true, ...result });
        } catch (e) { sendError(res, e); }
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
            const fees = await db.all(
                `SELECT p.id, p.amount, p.method, p.reference, p.date, p.reviewed_at, p.inscription_id, i.location, i.reg_code`
                + ` FROM ${T.payments} p JOIN ${T.inscriptions} i ON p.inscription_id = i.id WHERE i.conference_id = ? AND p.status = 'validated'`, [cid]);
            const rides = await db.all(
                `SELECT tp.id, tp.amount, tp.method, tp.reference, tp.date, t.inscription_id, b.name AS bus_name`
                + ` FROM ${T.transportPayments} tp JOIN ${T.tickets} t ON tp.ticket_id = t.id JOIN ${T.buses} b ON t.bus_id = b.id WHERE b.conference_id = ?`, [cid]);
            const auto = [
                ...fees.map(f => ({ id: `fee-${f.id}`, kind: 'income', date: f.date, category: 'Inscripciones', description: 'Pago de inscripción', amount: roundMoney(Number(f.amount) || 0), method: f.method || null, reference: f.reference || null, inscription_id: f.inscription_id, source: 'inscription', readonly: true })),
                ...rides.map(r => ({ id: `transport-${r.id}`, kind: 'income', date: r.date, category: 'Transporte', description: `Pasaje — ${r.bus_name}`, amount: roundMoney(Number(r.amount) || 0), method: r.method || null, reference: r.reference || null, inscription_id: r.inscription_id, source: 'transport', readonly: true })),
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
    const personName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim() || `#${r.id}`;
    // The meals views show the LIVE location of location_id (what the plan and every per-location counter
    // use), never the stored text label alone: DELETE /locations/:id nulls location_id but keeps the label
    // for history, and showing it would put an attendee under a location that no longer feeds them.
    // Every attendee query of this section selects `l.name AS location_name` through this join.
    const LOCATION_JOIN = ` LEFT JOIN ${T.locations} l ON l.id = i.location_id`;
    const PERSON_SQL = `SELECT i.id, i.conference_id, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.status, i.reg_code, l.name AS location_name FROM ${T.inscriptions} i${LOCATION_JOIN}`;
    const liveLocation = (r) => (r.location_id == null ? null : (r.location_name || r.location || null));
    const personOf = (r) => ({ id: r.id, name: personName(r), location: liveLocation(r), location_id: r.location_id == null ? null : r.location_id, family_group: r.family_group || null, reg_code: r.reg_code || null });
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
            const matchers = words.map(w => {
                // A word that IS (part of) a code — only code letters, dashes allowed, 4+ of them — also
                // matches reg_code; a name or a stray symbol never turns into a broad code match.
                const code = normalizeScanCode(w);
                // Only for whoever may see codes or scans them (the kitchen types a code into the search).
                const codeOk = canSeeRegCodes(perms) || hasLevel(perms, 'meals_delivery', 'manage');
                return { text: foldText(w), code: codeOk && code.length >= 4 && code === w.toUpperCase().replace(/-/g, '') ? code : null };
            });
            const candidates = await db.all(
                `SELECT i.id, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.document_number, i.reg_code, i.status, l.name AS location_name`
                + ` FROM ${T.inscriptions} i${LOCATION_JOIN}${where}`, params);
            const hits = [];
            for (const r of candidates) {
                const first = foldText(r.first_name), last = foldText(r.last_name), doc = foldText(r.document_number);
                const reg = String(r.reg_code || '').toUpperCase();
                if (matchers.every(m => first.includes(m.text) || last.includes(m.text) || doc.includes(m.text) || (m.code !== null && reg.includes(m.code)))) hits.push({ r, first, last });
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
                return maskRegCode({ ...personOf(r), first_name: r.first_name || '', last_name: r.last_name || '', document_number: r.document_number || null, status: r.status || null, entitled, delivered: delBy.get(String(r.id)) || 0, includes, excludes }, perms);
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
            res.json({ person: maskRegCode({ ...personOf(ins), status: ins.status || null, conference_id: ins.conference_id }, perms), services: await personMeals(ins) });
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

    // The kitchen scan: { service_id, code? | inscription_id?, force?, note? } → ALWAYS 200 with
    //   { result: 'delivered' | 'already' | 'not_entitled' | 'cancelled' | 'unknown' | 'other_conference',
    //     service_id, person?, delivered_at?, delivery_id?, delivered_by?, method?, note?, source? }
    // (404 only for an unknown service, 400 when neither code nor inscription_id is sent). `code` wins over
    // inscription_id when both come. force:true turns ONLY 'not_entitled' into a delivery (method
    // 'override'). Two simultaneous scans of one person: the UNIQUE (service, attendee) index lets exactly
    // one INSERT through; the other catches the constraint error, re-reads, and answers 'already'.
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
            if (!svc) return res.status(404).json({ error: 'Servicio de comida no encontrado.' });
            const hasCode = body.code !== undefined && body.code !== null;
            const hasId = body.inscription_id !== undefined && body.inscription_id !== null && body.inscription_id !== '';
            if (!hasCode && !hasId) return res.status(400).json({ error: 'Indica el código o la inscripción.' });
            const verdict = (result, extra) => res.json({ result, service_id: svc.id, ...(extra || {}) });
            let ins = null;
            if (hasCode) ins = typeof body.code === 'string' || typeof body.code === 'number' ? await findByScanCode(body.code) : null;
            else { const iid = positiveInt(body.inscription_id); ins = iid ? ((await db.get(`${PERSON_SQL} WHERE i.id = ?`, [iid])) || null) : null; }
            if (!ins) return verdict('unknown');
            if (Number(ins.conference_id) !== Number(svc.conference_id)) return verdict('other_conference');
            const person = maskRegCode(personOf(ins), perms);
            const prior = await deliveryOf(svc.id, ins.id);
            if (prior) return verdict('already', { person, ...deliveryFields(prior) });
            if (isCancelled(ins.status)) return verdict('cancelled', { person });
            const ent = await entitlementOf(ins, svc.id);
            let method = hasCode ? 'scan' : 'manual';
            if (!ent.entitled) {
                if (body.force !== true) {
                    // A service deleted while this scan ran takes its plan rows with it (after the service
                    // row): if it is still there now, the plan read above was intact.
                    if (!(await getService(svc.id))) return res.status(404).json({ error: 'Servicio de comida no encontrado.' });
                    return verdict('not_entitled', { person, source: ent.source });
                }
                method = 'override';
            }
            const note = shortText(typeof body.note === 'string' ? body.note.trim() : null, 500);
            const stamp = utcStamp(), actor = actorOf(req);
            const parentGone = (gone) => (gone === 'service' ? res.status(404).json({ error: 'Servicio de comida no encontrado.' }) : verdict('unknown'));
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
    http.route('get', '/meals/services/:id/deliveries', MEAL_ROUTE, async (req, res) => {
        const perms = await allowAny(req, res, [['meals', 'view'], ['meals_delivery', 'manage']]);
        if (!perms) return;
        const showCodes = canSeeRegCodes(perms);
        try {
            const svc = await getService(req.params.id);
            if (!svc) return res.status(404).json({ error: 'Servicio de comida no encontrado.' });
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
            const rows = await db.all(
                `SELECT d.id AS delivery_id, d.inscription_id, d.delivered_at, d.delivered_by, d.method, d.note, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.reg_code, l.name AS location_name`
                + ` FROM ${T.mealDeliveries} d JOIN ${T.inscriptions} i ON d.inscription_id = i.id${LOCATION_JOIN} WHERE d.service_id = ? ORDER BY d.delivered_at DESC, d.id DESC LIMIT ?`, [svc.id, limit]);
            res.json({
                service_id: svc.id,
                deliveries: rows.map(r => ({ delivery_id: r.delivery_id, inscription_id: r.inscription_id, name: personName({ ...r, id: r.inscription_id }), location: liveLocation(r), location_id: r.location_id == null ? null : r.location_id, family_group: r.family_group || null, reg_code: showCodes ? (r.reg_code || null) : null, delivered_at: r.delivered_at, delivered_by: r.delivered_by || null, method: r.method || null, note: r.note || null })),
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
            const list = await db.all(
                `SELECT i.id, i.first_name, i.last_name, i.location, i.location_id, i.family_group, i.reg_code, i.status, o.mode,`
                + ` d.id AS delivery_id, d.delivered_at, d.method, d.delivered_by, d.note, l.name AS location_name`
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
                    inscription_id: r.id, name: personName(r), location: liveLocation(r), location_id: r.location_id == null ? null : r.location_id,
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
        if (!await allow(req, res, 'inscriptions', 'manage')) return;
        const { conference_id, ...fieldValues } = req.body || {};
        try {
            // Read, decide and write under the assignment lock, like every other write that moves a bed
            // or freezes a location (manual and portal placement, the engine run, the lodging submit and
            // review): the lodging checks below read the row and its room, and an edit decided outside
            // the lock let a placement land between its read and its write — a cancelled attendee then
            // kept the bed it had just been given — and a move out of a location could pass the frozen
            // check while the location's arrangement was being submitted.
            const existing = await withAssignmentLock(async () => {
                const existing = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
                if (!existing) throw httpError(404, 'Inscripción no encontrada.');
                const id = existing.id;

                // Write each DEFINED field's canonical value to its column (schema follows the form) + the
                // operational edits the admin is allowed to change directly (status, notes, location_id).
                const confFields = await db.all(FIELD_COLUMNS_SQL, [existing.conference_id]);
                const vals = canonicalFieldValues(confFields, fieldValues);
                assertRequired(confFields, vals, true);
                await assertUnique(confFields, vals, { conference_id: existing.conference_id }, id);

                const sets = [], params = [];
                for (const [k, v] of Object.entries(vals)) { sets.push(`${k} = ?`); params.push(v); }
                let newStatus = existing.status;
                if (fieldValues.status !== undefined) {
                    // Closed vocabulary — the same rule the conference `status` already follows. 'pending' is the
                    // insert default, 'active' is what the admin's toggle writes; anything else is a typo or a probe.
                    const st = fieldValues.status == null ? null : String(fieldValues.status);
                    if (st !== null && !INSCRIPTION_STATUSES.has(st)) throw httpError(400, 'Estado de inscripción inválido.');
                    sets.push('status = ?'); params.push(st);
                    newStatus = st;
                }
                if (fieldValues.notes !== undefined) { sets.push('notes = ?'); params.push(fieldValues.notes == null ? null : String(fieldValues.notes)); }
                const loc = await resolveAdminLocation(existing.conference_id, { location_id: fieldValues.location_id });
                if (loc === null) { sets.push('location_id = ?', 'location = ?'); params.push(null, null); }
                else if (loc) { sets.push('location_id = ?', 'location = ?'); params.push(loc.id, loc.name); }
                // Lodging: moving an attendee out of a frozen location is refused (the arrangement is under
                // review); a move out of an ALLOTTED room frees the bed (invariant 1) unless the room is
                // allotted to the DESTINATION location (the placement stays valid), and a cancellation
                // always frees the bed (invariant 2) — even in a frozen location.
                const currentLocationId = existing.location_id == null ? null : Number(existing.location_id);
                const locationChanges = loc !== undefined && (loc ? Number(loc.id) : null) !== currentLocationId;
                let freeBed = false;
                if (locationChanges) {
                    if (currentLocationId != null) await assertLocationNotFrozen(currentLocationId, 'mover a sus participantes');
                    if (existing.room_id != null) {
                        const curRoom = await db.get(`SELECT location_id FROM ${T.rooms} WHERE id = ?`, [existing.room_id]);
                        if (curRoom && curRoom.location_id != null && Number(curRoom.location_id) !== (loc ? Number(loc.id) : NaN)) freeBed = true;
                    }
                }
                if (newStatus === 'cancelled' && existing.room_id != null) freeBed = true;
                if (freeBed) { sets.push('room_id = ?'); params.push(null); }
                // Capacity: the edit takes a seat when the attendee ends up counted in a location where they were
                // not counted before — moved in from elsewhere (or from no location), or un-cancelled in place.
                // Staying put, cancelling, or leaving a location never needs a free seat.
                const target = loc !== undefined ? loc
                    : (existing.location_id != null ? await db.get(`SELECT id, name, capacity FROM ${T.locations} WHERE id = ?`, [existing.location_id]) : null);
                const willCount = !!target && newStatus !== 'cancelled';
                const wasCountedThere = !!target && existing.location_id === target.id && existing.status !== 'cancelled';
                if (willCount && !wasCountedThere) await assertLocationHasRoom(target);
                if (sets.length) {
                    params.push(id);
                    await db.run(`UPDATE ${T.inscriptions} SET ${sets.join(', ')} WHERE id = ?`, params);
                }
                return existing;
            });
            const id = existing.id;
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
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/inscriptions/:id', { auth: true }, async (req, res) => {
        const perms = await allow(req, res, 'inscriptions', 'manage');
        if (!perms) return;
        try {
            // Deleting the attendee deletes its money too (fee payments cascade, transport payments below).
            // That is a payments / transport decision: a role that may only manage inscriptions must not
            // erase validated income through this door (DELETE /payments/:id and DELETE /buses/:id refuse it).
            // The transport side runs under the assignment lock, the lock transport payments are recorded
            // under: a payment landing between the check and the deletes (or between the two deletes) was
            // either erased by a role that may not erase it, or answered as recorded and then erased
            // with its ticket.
            const refused = await withAssignmentLock(async () => {
                const fee = await db.get(`SELECT COUNT(*) AS n FROM ${T.payments} WHERE inscription_id = ?`, [req.params.id]);
                const rides = await db.get(`SELECT COUNT(*) AS n FROM ${T.transportPayments} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE inscription_id = ? )`, [req.params.id]);
                if ((Number(fee && fee.n) > 0 && !hasLevel(perms, 'payments', 'manage')) || (Number(rides && rides.n) > 0 && !hasLevel(perms, 'transport', 'manage'))) return true;
                await db.run(`DELETE FROM ${T.transportPayments} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE inscription_id = ? )`, [req.params.id]);
                await db.run(`DELETE FROM ${T.tickets} WHERE inscription_id = ?`, [req.params.id]);
                return false;
            });
            if (refused) {
                return res.status(409).json({ error: 'La inscripción tiene pagos registrados: pide a quien gestiona los pagos que los anule, o cancela la inscripción en lugar de eliminarla.' });
            }
            // Meals (2.14.0): the attendee first, then its meal rows (the FKs cascade; the explicit deletes
            // keep it so with foreign keys off). Under the meals lock an override write cannot slip in for
            // a deleted attendee, and a scan racing this re-checks the attendee after its INSERT.
            await withMealsLock(async () => {
                await db.run(`DELETE FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
                await db.run(`DELETE FROM ${T.mealDeliveries} WHERE inscription_id = ?`, [req.params.id]);
                await db.run(`DELETE FROM ${T.mealOverrides} WHERE inscription_id = ?`, [req.params.id]);
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // Manual room assignment — validates capacity + same-conference scope (auto-assign already does;
    // the manual path used to bare-UPDATE and could overfill or cross-place). Pass room_id null to free.
    // Lodging (2.5.0): the attendee's location must not be frozen; a cancelled attendee is never placed;
    // an allotted room only takes its own location's attendees (roomAllows).
    http.route('post', '/inscriptions/:id/assign', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { room_id: rawRoomId } = req.body || {};
        try {
            const id = positiveInt(req.params.id);
            if (!id || !await db.get(`SELECT id FROM ${T.inscriptions} WHERE id = ?`, [id])) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            const unassign = rawRoomId === null || rawRoomId === undefined || rawRoomId === '';
            const roomId = unassign ? null : positiveInt(rawRoomId);
            if (!unassign && !roomId) return res.status(400).json({ error: 'Habitación inválida.' });
            // Check-then-write under the assignment lock: two concurrent assigns into the last bed (or an
            // assign racing an engine run's load→flush window) would otherwise overbook the room. The
            // attendee is read INSIDE the lock, where an edit (PUT /inscriptions) cannot cancel or move
            // them between the read and the write: read before the lock, a cancellation landing in
            // between left the cancelled attendee holding the bed.
            await withAssignmentLock(async () => {
                const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [id]);
                if (!ins) throw httpError(404, 'Inscripción no encontrada.');
                if (ins.location_id != null) await assertLocationNotFrozen(ins.location_id, 'cambiar su hospedaje');
                if (unassign) {
                    await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE id = ?`, [id]);
                    return;
                }
                if (ins.status === 'cancelled') throw httpError(400, 'Un participante cancelado no ocupa habitación.');
                const room = await db.get(
                    `SELECT r.*, h.conference_id, l.name AS location_name,
                            (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) as occupied
                     FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id LEFT JOIN ${T.locations} l ON r.location_id = l.id WHERE r.id = ?`, [roomId]);
                if (!room) throw httpError(404, 'Habitación no encontrada.');
                if (Number(room.conference_id) !== Number(ins.conference_id)) throw httpError(400, 'Esa habitación pertenece a otra conferencia.');
                if (!roomAllows(room, ins)) throw httpError(400, `Esa habitación está asignada a la localidad «${room.location_name || room.location_id}».`);
                const alreadyHere = Number(ins.room_id) === Number(roomId);
                if (alreadyHere) return;
                if (room.occupied >= room.capacity) throw httpError(400, 'La habitación está llena.');
                // Plain UPDATE on purpose: the capacity check above runs under the assignment lock, and an
                // UPDATE whose subquery reads the table being updated is refused by MySQL (error 1093).
                await db.run(`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [roomId, id]);
            });
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === PAYMENTS: add / void / validate / reject ===
    // State machine: pending → validated | rejected; validated ↔ rejected; only pending/rejected may be
    // deleted (a validated payment is part of the ledger — reject it first). validate/reject stamp
    // reviewed_at/reviewed_by (the host forwards req.user {id, role, userLogin, …} to isolated routes): the
    // acting user's login — an administrator's or a team member's (actorOf) — else the user id.
    const reviewerOf = (req) => actorOf(req);
    http.route('post', '/inscriptions/:id/payments', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        const { amount, method, reference, proof } = req.body;
        try {
            if (!Number.isFinite(Number(amount)) || Number(amount) > MAX_MONEY) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const amt = roundMoney(amount);
            if (amt <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const p = assertProof(proof);
            const m = assertPaymentMethod(method);
            const ins = await db.get(`SELECT id FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            // New payments start 'pending' — an admin must validate before they count toward the balance.
            await db.run(`INSERT INTO ${T.payments} (inscription_id, amount, method, reference, proof, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
                [ins.id, amt, m, shortText(reference, 100), p]);
            await recomputePayment(ins.id); // validated-only recompute → pending doesn't count yet
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/payments/:id', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        try {
            const pay = await db.get(`SELECT inscription_id, status FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (pay.status === 'validated') return res.status(409).json({ error: 'Un pago validado no se puede eliminar; recházalo primero.' });
            await db.run(`DELETE FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });
    // Validate / reject a payment (admin gate). Only a VALIDATED payment counts toward amount_paid.
    http.route('post', '/payments/:id/validate', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        try {
            const pay = await db.get(`SELECT inscription_id, status FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (pay.status === 'validated') return res.status(409).json({ error: 'El pago ya está validado.' });
            await db.run(`UPDATE ${T.payments} SET status = 'validated', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?`, [reviewerOf(req), req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true, status: 'validated' });
        } catch (e) { sendError(res, e); }
    });
    http.route('post', '/payments/:id/reject', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'payments', 'manage')) return;
        try {
            const pay = await db.get(`SELECT inscription_id, status FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (pay.status === 'rejected') return res.status(409).json({ error: 'El pago ya está rechazado.' });
            await db.run(`UPDATE ${T.payments} SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?`, [reviewerOf(req), req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true, status: 'rejected' });
        } catch (e) { sendError(res, e); }
    });

    http.route('get', '/inscriptions/:id/payments', { auth: true }, async (req, res) => {
        if (!await allowAny(req, res, [['payments', 'view'], ['inscriptions', 'view']])) return;
        try {
            const list = await db.all(`SELECT * FROM ${T.payments} WHERE inscription_id = ? ORDER BY date DESC`, [req.params.id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    // === REPORTS ===
    // Aggregate roster stats for the Reports dashboard (counts, money, per-location breakdown).
    http.route('get', '/reports/summary', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'reports', 'view')) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const totals = await db.get(`
                SELECT COUNT(*) as total,
                       COALESCE(SUM(total_due), 0) as due,
                       COALESCE(SUM(amount_paid), 0) as paid,
                       SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) as paid_count,
                       SUM(CASE WHEN payment_status = 'partial' THEN 1 ELSE 0 END) as partial_count,
                       SUM(CASE WHEN payment_status = 'unpaid' OR payment_status IS NULL THEN 1 ELSE 0 END) as unpaid_count,
                       SUM(CASE WHEN room_id IS NOT NULL THEN 1 ELSE 0 END) as assigned_count
                FROM ${T.inscriptions} WHERE conference_id = ?`, [conference_id]);
            const byLocation = await db.all(`
                SELECT COALESCE(NULLIF(location, ''), '—') as location,
                       COUNT(*) as count,
                       COALESCE(SUM(total_due), 0) as due,
                       COALESCE(SUM(amount_paid), 0) as paid
                FROM ${T.inscriptions} WHERE conference_id = ?
                GROUP BY COALESCE(NULLIF(location, ''), '—') ORDER BY count DESC`, [conference_id]);
            const byGender = await db.all(`
                SELECT COALESCE(NULLIF(gender, ''), '—') as gender, COUNT(*) as count
                FROM ${T.inscriptions} WHERE conference_id = ? GROUP BY COALESCE(NULLIF(gender, ''), '—')`, [conference_id]);
            if (totals) { totals.due = roundMoney(totals.due); totals.paid = roundMoney(totals.paid); }
            for (const row of byLocation) { row.due = roundMoney(row.due); row.paid = roundMoney(row.paid); }
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
            const flds = await db.all(`SELECT name, label FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            const safeFlds = flds.filter(f => isFieldColumn(f.name));

            let query = `
                SELECT i.*, r.room_number, h.name as hotel_name
                FROM ${T.inscriptions} i
                LEFT JOIN ${T.rooms} r ON i.room_id = r.id
                LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id
                WHERE i.conference_id = ?`;
            const params = [conference_id];
            query += await inscriptionFilters(req.query, params, canSeeRegCodes(perms));
            query += ` ORDER BY i.last_name, i.first_name`;
            const rows = await db.all(query, params);

            const MONEY_COLS = new Set(['total_due', 'amount_paid']);
            // The Código column (barcode payload) only for inscriptions:view.
            const cols = [
                ...safeFlds.map(f => [f.name, f.label || f.name]),
                ...(canSeeRegCodes(perms) ? [['reg_code', 'Código']] : []), ['status', 'Estado'], ['payment_status', 'Pago'],
                ['total_due', 'Cuota'], ['amount_paid', 'Pagado'],
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

    // === ASSIGNMENT RULES ===
    http.route('get', '/assignment/rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'view')) return;
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // The admin's conference rules only; a location's own rules travel with its lodging view.
            const list = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND location_id IS NULL ORDER BY priority DESC, id ASC`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    const RULE_TYPES = new Set(['keep_together', 'separate_by', 'split_by', 'require_companion']);
    // The admin's CONFERENCE rules (location_id IS NULL). A location's own rules are the coordinator's
    // (portal) and are never reachable through this route: an `id` of a location rule is a 404.
    http.route('post', '/assignment/rules', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { id, conference_id, name, type, enabled, priority, config, params, hard } = req.body || {};
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const rule = normalizeRule({ name, type, enabled, priority, config, params, hard }, { conferenceId: conference_id, fieldNames: await ruleFieldNames(conference_id) });
            const paramsStr = JSON.stringify(rule.params);
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

    // Clears every room of the conference EXCEPT those of frozen locations (their arrangement is
    // under review); those are listed in `skipped_frozen` so the admin knows to reopen them.
    http.route('post', '/assignment/reset', { auth: true }, async (req, res) => {
        if (!await allow(req, res, 'lodging', 'manage')) return;
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Serialize with runs so a reset can't interleave with an in-flight assignment.
            const skipped = await withAssignmentLock(async () => {
                const frozen = await db.all(`SELECT id, name FROM ${T.locations} WHERE conference_id = ? AND ${frozenSql} ORDER BY name`, [conference_id]);
                await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE conference_id = ? AND (location_id IS NULL OR location_id NOT IN (SELECT id FROM ${T.locations} WHERE ${frozenSql} ))`, [conference_id]);
                return frozen.map(l => ({ location_id: l.id, name: l.name }));
            });
            res.json({ success: true, skipped_frozen: skipped });
        } catch (e) { sendError(res, e); }
    });

    // Conference-wide run: the pool scope plus every delegated location that is not frozen (see
    // runAssignment). Returns totals + by_location + skipped_frozen.
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
    // rule that outranks a separate_by rule may mix that rule's field, and the separate_by rule says
    // nothing about those members; a separate_by rule that outranks the family rule divides the family
    // and the family rule says nothing about that division. `rank` = the rule's index in that order.
    const rankRules = (rules) => [...rules]
        .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0))
        .map((r, i) => ({ ...r, rank: i }));
    // Is `person` explained for a lower-ranked rule by one of `keepRules` (all outranking it)? Yes when a
    // keep_together rule applies to the person (`when`), the person has a value for its field and at
    // least one other member of the same room shares that value — they are together on purpose.
    const explainedBy = (person, members, keepRules) => {
        for (const k of keepRules) {
            if (!k.field || !condMatches(k.params.when, person)) continue;
            const v = ruleVal(person, k.field);
            if (v == null || String(v).trim() === '') continue;
            const key = String(v).trim().toLowerCase();
            if (members.some(m => m !== person && m.id !== person.id && condMatches(k.params.when, m)
                && String(ruleVal(m, k.field) == null ? '' : ruleVal(m, k.field)).trim().toLowerCase() === key)) return true;
        }
        return false;
    };
    // The members of a room composition a separate_by rule still judges (the ones no outranking
    // keep_together rule explains).
    const judgedBy = (sepRule, members, keepRules) => {
        const outranking = keepRules.filter(k => k.rank < sepRule.rank);
        return outranking.length ? members.filter(m => !explainedBy(m, members, outranking)) : members;
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
    // scope; `runAssignment(conferenceId, { locationId })` runs a location scope when `locationId` is
    // given and, when it is undefined, the admin's conference-wide sweep (pool + every non-frozen
    // delegated location). Callers hold withAssignmentLock.
    const ASSIGN_MAX_PARTICIPANTS = 5000;
    async function runAssignmentScope(conferenceId, locationId, opts = {}) {
        const isPool = locationId == null;
        const ruleRows = isPool
            ? await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND enabled = 1 AND location_id IS NULL ORDER BY priority DESC, id ASC`, [conferenceId])
            : await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND enabled = 1 AND (location_id IS NULL OR location_id = ?) ORDER BY priority DESC, id ASC`, [conferenceId, locationId]);
        const rules = rankRules(ruleRows.map(parseRuleRow));
        const keepRules = rules.filter(r => r.type === 'keep_together');
        const separateRules = rules.filter(r => r.type === 'separate_by');
        const splitRules = rules.filter(r => r.type === 'split_by');
        const companionRules = rules.filter(r => r.type === 'require_companion');

        // The set of delegated locations decides who belongs to the pool scope; a FROZEN location's
        // attendees are out of every scope but their own (reset/manual assign refuse to touch them,
        // so the sweep must not place them either — see `skipped_frozen`).
        let delegated = opts.delegatedIds;
        if (isPool && !delegated) {
            delegated = new Set((await db.all(`SELECT DISTINCT location_id FROM ${T.rooms} WHERE location_id IS NOT NULL`)).map(r => Number(r.location_id)));
        }
        let frozenIds = opts.frozenIds;
        if (isPool && !frozenIds) {
            frozenIds = new Set((await db.all(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND ${frozenSql}`, [conferenceId])).map(r => Number(r.id)));
        }
        const inScope = (p) => (p.status == null || p.status !== 'cancelled') && (isPool
            ? (p.location_id == null || (!delegated.has(Number(p.location_id)) && !frozenIds.has(Number(p.location_id))))
            : Number(p.location_id) === Number(locationId));

        const participantRows = isPool
            ? await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND room_id IS NULL AND ${occupiedSql()} AND (location_id IS NULL OR location_id NOT IN (SELECT DISTINCT location_id FROM ${T.rooms} WHERE location_id IS NOT NULL )) AND (location_id IS NULL OR location_id NOT IN (SELECT id FROM ${T.locations} WHERE ${frozenSql} ))`, [conferenceId])
            : await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND location_id = ? AND room_id IS NULL AND ${occupiedSql()}`, [conferenceId, locationId]);
        const participants = participantRows.map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
        if (participants.length > ASSIGN_MAX_PARTICIPANTS) throw httpError(400, `Demasiados inscritos sin asignar para una sola ejecución (máximo ${ASSIGN_MAX_PARTICIPANTS}).`);

        const roomScopeSql = isPool ? 'r.location_id IS NULL' : 'r.location_id = ?';
        const roomScopeParams = isPool ? [conferenceId] : [conferenceId, locationId];
        const roomRows = await db.all(
            `SELECT r.*, h.name as hotel_name FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? AND ${roomScopeSql}`,
            roomScopeParams
        );
        // Occupancy in ONE query (no per-room SELECT), grouped by room in JS.
        const occRows = await db.all(
            `SELECT i.* FROM ${T.inscriptions} i WHERE i.room_id IN (SELECT r.id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? AND ${roomScopeSql} )`,
            roomScopeParams
        );
        const occByRoom = new Map();
        for (const o of occRows) {
            if (!occByRoom.has(o.room_id)) occByRoom.set(o.room_id, []);
            const occ = { ...o, custom_data: parseCd(o.custom_data) };
            if (!inScope(occ)) occ.fixed = true;   // counts for capacity, never moved by this run
            occByRoom.get(o.room_id).push(occ);
        }
        const rooms = roomRows.map(r => ({ id: r.id, capacity: Math.max(1, Number(r.capacity) || 1), room_number: r.room_number, hotel_name: r.hotel_name, location_id: r.location_id == null ? null : r.location_id, occupants: occByRoom.get(r.id) || [] }));

        const val = ruleVal;
        const cond = condMatches;

        let assignedCount = 0;
        const violations = [];
        const noteViol = (rule, detail, hard) => { if (!violations.some(v => v.rule === rule && v.detail === detail)) violations.push({ rule, detail, hard: !!hard }); };

        // A merged set (a room's occupants + candidate people) is OK for a HARD separate rule iff it has
        // at most one distinct non-blank value of that rule's field.
        const mergedSeparateOk = (occupants, people) => {
            const after = occupants.concat(people);
            for (const rule of separateRules) {
                if (!rule.hard) continue;
                if (distinctValues(judgedBy(rule, after, keepRules), rule.field).length > 1) return false;
            }
            return true;
        };
        // Invariant 1 + hard separate_by, at EVERY placement site.
        const compatible = (room, people) => people.every(p => roomAllows(room, p)) && mergedSeparateOk(room.occupants, people);
        const companionUnmet = (occupants) => companionUnmetIn(companionRules, occupants);
        // Higher = better room for placing `people`: penalize soft-separate mixing, companion gaps, waste.
        const score = (room, people) => {
            let s = 0;
            const after = room.occupants.concat(people);
            for (const rule of separateRules) {
                if (rule.hard) continue;
                if (distinctValues(judgedBy(rule, after, keepRules), rule.field).length > 1) s -= 5;
            }
            s -= companionUnmet(after).length * 3;
            s -= Math.abs(room.capacity - after.length) * 0.1;
            return s;
        };

        // Deferred writes: mutate memory now, flush every placement once at the end.
        const placements = new Map(); // inscription id -> room id
        const assignTo = (room, person) => { placements.set(person.id, room.id); room.occupants.push(person); assignedCount++; };
        const moveTo = (room, donor, person) => { placements.set(person.id, room.id); donor.occupants = donor.occupants.filter(o => o.id !== person.id); room.occupants.push(person); };

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

        // `group` = null | { rule, key } — the keep_together rule that formed this unit and its display
        // value, so a forced division can be reported under that rule's name.
        const placePartition = (people, group) => {
            if (people.length === 0) return;
            const feasible = rooms.filter(room => (room.capacity - room.occupants.length) >= people.length && compatible(room, people));
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
                        for (const s of sub) placePartition(s, group);
                        return;
                    }
                }
                let target = null, freeMax = 0;
                for (const room of rooms) {
                    const free = room.capacity - room.occupants.length;
                    if (free >= 1 && free > freeMax && compatible(room, [people[0]])) { target = room; freeMax = free; }
                }
                if (target && freeMax >= 1) {
                    for (const p of people.slice(0, freeMax)) assignTo(target, p);
                    if (group) noteViol(group.rule.name, `El grupo «${group.key}» (${people.length}) no cupo junto y se dividió.`, group.rule.hard);
                    placePartition(people.slice(freeMax), group);
                    return;
                }
                // No room left with any free, compatible capacity — leave them unassigned; they're
                // counted in `remaining` and reported once (aggregated by count) at the end.
                return;
            }
            let target = null, best = -Infinity;
            for (const room of rooms) {
                if ((room.capacity - room.occupants.length) >= 1 && compatible(room, people)) { const s = score(room, people); if (s > best) { best = s; target = room; } }
            }
            if (target) assignTo(target, people[0]);
            // else: left unassigned → aggregated into the single capacity violation at the end.
        };

        // Hard separate_by forces a unit to divide along those fields before placement.
        const placeUnit = (unit) => {
            const dividing = dividingRules(unit.group);
            const parts = partitionBy(unit.people, dividing.map(r => r.field));
            // Expected under first match (the separate_by rule ranks first): information, not a broken rule.
            if (parts.length > 1 && unit.group) noteViol(unit.group.rule.name, `El grupo «${unit.group.key}» (${unit.people.length}) se dividió por «${dividing.map(r => r.name).join('», «')}», que tiene prioridad.`, false);
            for (const part of parts) placePartition(part, unit.group);
        };

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

        // Larger units first, so families get contiguous space before individuals fill the rooms.
        units.sort((a, b) => b.people.length - a.people.length);
        for (const u of units) placeUnit(u);

        // Repair pass for HARD require_companion: pull a "needs" member into a room that has a subject
        // but too few companions (respecting capacity + hard separate + roomAllows), without stranding
        // the donor. Only occupants of THIS scope are movable (`fixed` ones stay where they are).
        for (const rule of companionRules) {
            if (!rule.hard) continue;
            const min = Number(rule.params.min) || 1;
            for (const room of rooms) {
                if (!room.occupants.some(o => cond(rule.params.subject, o))) continue;
                let have = room.occupants.filter(o => cond(rule.params.needs, o)).length;
                while (have < min && (room.capacity - room.occupants.length) >= 1) {
                    let moved = false;
                    for (const donor of rooms) {
                        if (donor === room) continue;
                        const donorHasSubject = donor.occupants.some(o => cond(rule.params.subject, o));
                        const donorNeeds = donor.occupants.filter(o => cond(rule.params.needs, o)).length;
                        if (donorHasSubject && donorNeeds <= min) continue; // don't break the donor's own rule
                        const cand = donor.occupants.find(o => !o.fixed && cond(rule.params.needs, o) && compatible(room, [o]));
                        if (cand) { moveTo(room, donor, cand); have++; moved = true; break; }
                    }
                    if (!moved) break;
                }
            }
        }

        // Single flush of every placement (chunks of 200 through db.batch; the assignment lock still
        // serialises runs, so nothing else writes room_id meanwhile).
        const writes = [];
        for (const [personId, roomId] of placements) writes.push([`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [roomId, personId]]);
        await runBatched(writes);

        // Report every remaining companion gap (hard ones we couldn't repair + soft preferences).
        for (const room of rooms) {
            for (const rule of companionUnmet(room.occupants)) {
                noteViol(rule.name, `Habitación ${room.room_number || room.id}: no se cumplió «${rule.name}».`, rule.hard);
            }
        }

        // One clear, count-accurate capacity report (instead of per-person lines that would dedupe).
        const remaining = participants.length - assignedCount;
        if (remaining > 0) noteViol('capacidad', remaining === 1 ? '1 inscrito quedó sin cupo — faltan habitaciones.' : `${remaining} inscritos quedaron sin cupo — faltan habitaciones.`, true);
        return { assignedCount, remaining, violations };
    }

    // Delegated locations of a conference (at least one allotted room), with their review status.
    async function delegatedLocations(conferenceId) {
        const rows = await db.all(
            `SELECT l.id, l.name, l.lodging_status FROM ${T.locations} l WHERE l.conference_id = ? AND EXISTS (SELECT 1 FROM ${T.rooms} r WHERE r.location_id = l.id ) ORDER BY l.name`,
            [conferenceId]);
        return rows.map(l => ({ id: l.id, name: l.name, status: lodgingStatusOf(l) }));
    }

    // `locationId` given (number) → that location's scope only (the coordinator's run; the admin's
    // per-location run). `locationId` null → the pool scope only. `locationId` undefined → the admin's
    // conference-wide sweep: the pool scope, then one scope per delegated location that is not frozen,
    // in name order. Totals on top, per-location detail in `by_location`, EVERY frozen location of the
    // conference (delegated or not — its attendees are untouchable either way) in `skipped_frozen`.
    async function runAssignment(conferenceId, { locationId } = {}) {
        if (locationId === null) return runAssignmentScope(conferenceId, null);
        if (locationId !== undefined) return runAssignmentScope(conferenceId, locationId);
        const delegated = await delegatedLocations(conferenceId);
        const frozenRows = await db.all(`SELECT id, name, lodging_status FROM ${T.locations} WHERE conference_id = ? AND ${frozenSql} ORDER BY name`, [conferenceId]);
        const frozenIds = new Set(frozenRows.map(l => Number(l.id)));
        const pool = await runAssignmentScope(conferenceId, null, { delegatedIds: new Set(delegated.map(l => Number(l.id))), frozenIds });
        const result = {
            assignedCount: pool.assignedCount, remaining: pool.remaining, violations: pool.violations.slice(), by_location: [],
            skipped_frozen: frozenRows.map(l => ({ location_id: l.id, name: l.name, status: lodgingStatusOf(l) })),
        };
        for (const l of delegated) {
            if (frozenIds.has(Number(l.id))) continue;
            const r = await runAssignmentScope(conferenceId, l.id);
            result.assignedCount += r.assignedCount;
            result.remaining += r.remaining;
            for (const v of r.violations) result.violations.push({ rule: v.rule, detail: `«${l.name}»: ${v.detail}`, hard: v.hard });
            result.by_location.push({ location_id: l.id, name: l.name, assignedCount: r.assignedCount, remaining: r.remaining, violations: r.violations });
        }
        return result;
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
    async function loadLodging(location, { forAdmin = false } = {}) {
        const L = location, cid = L.conference_id;
        const fieldRows = await db.all(`SELECT name, label, type FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]);
        const fields = fieldRows.filter(f => isFieldColumn(f.name)).map(f => ({ name: f.name, label: f.label, type: f.type }));
        const attendeeCols = [...new Set(['id', 'first_name', 'last_name', 'gender', 'family_group', ...(forAdmin ? ['status'] : []), ...fields.map(f => f.name)])];
        const projectAttendee = (p) => { const o = {}; for (const c of attendeeCols) o[c] = p[c] === undefined ? null : p[c]; return o; };
        const roomRows = await db.all(
            `SELECT r.*, h.name AS hotel_name, (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) AS occupied
             FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id
             WHERE r.location_id = ? AND h.conference_id = ? ORDER BY h.name, r.room_number, r.id`, [L.id, cid]);
        const people = (await db.all(
            `SELECT i.*, r.room_number, r.location_id AS room_location_id, h.name AS hotel_name
             FROM ${T.inscriptions} i LEFT JOIN ${T.rooms} r ON i.room_id = r.id LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id
             WHERE i.location_id = ? AND i.conference_id = ? ORDER BY i.last_name, i.first_name, i.id`, [L.id, cid]))
            .map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
        const ruleRows = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND (location_id IS NULL OR location_id = ?) ORDER BY priority DESC, id ASC`, [cid, L.id]);

        const roomIds = new Set(roomRows.map(r => Number(r.id)));
        const occByRoom = new Map();
        const unassignedRows = [], elsewhereRows = [];
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
            } else {
                unassignedRows.push(p);
            }
        }
        const auditRooms = roomRows.map(r => ({ id: r.id, room_number: r.room_number, capacity: r.capacity, occupied: r.occupied, occupants: occByRoom.get(Number(r.id)) || [] }));
        const { violations, counts } = auditArrangement({ rooms: auditRooms, unassigned: unassignedRows, rules: ruleRows, placed_elsewhere: elsewhereRows });
        counts.placed_elsewhere = elsewhereRows.length;

        const rooms = roomRows.map(r => {
            const base = { id: r.id, hotel_name: r.hotel_name, room_number: r.room_number, capacity: r.capacity, is_family: r.is_family, family_name: r.family_name, occupied: Number(r.occupied) || 0 };
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
                capacity: L.capacity == null ? null : L.capacity,
                inscribed: people.filter(p => p.status !== 'cancelled').length,
            },
            rooms,
            unassigned: unassignedRows.map(projectAttendee),
            placed_elsewhere: elsewhereRows.map(p => ({ id: p.id, first_name: p.first_name, last_name: p.last_name, hotel_name: p.hotel_name, room_number: p.room_number })),
            rules: ruleSplit,
            fields,
            violations,
            counts,
        };
    }


    // === PORTAL AUTH HELPER ===
    // The portal session is a base64 `id:code:expiry` token. Under the sandbox the host NAMESPACES any
    // cookie the plugin sets — `wordjs_portal_token` is stored/returned as the namespaced cookie name
    // below — and forwards the `x-portal-token` header verbatim. Accept either. Returns the resolved
    // location row on success, or null on any failure (caller responds 401).
    //
    // The bearer token EMBEDS the location's access code (the shared secret). Mitigations: the HttpOnly
    // namespaced cookie is the primary carrier, 7-day expiry inside the token, the code is re-checked
    // against the DB on every request (rotate_code invalidates every outstanding token), and the
    // throttle applies to forged tokens. A future version should mint an opaque random session id
    // stored server-side instead of carrying the code; that needs a sessions table and is out of scope
    // for 2.2.0.
    const PORTAL_COOKIE = `${db.tablePrefix}wordjs_portal_token`; // host-namespaced cookie name
    const PORTAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const makePortalToken = (id, code) => btoa(`${id}:${code}:${Date.now() + PORTAL_TOKEN_TTL_MS}`);
    async function resolvePortalLocation(req) {
        const cookies = req.cookies || {};
        let token = cookies[PORTAL_COOKIE] || cookies.wordjs_portal_token || (req.headers && req.headers['x-portal-token']);
        if (!token) return null;
        try {
            const decoded = atob(token);
            const [rawId, code, exp] = decoded.split(':');
            // Canonicalize the id to an integer so "5"/"05"/"005"/" 5" can't each get a fresh throttle
            // budget (they all resolve to the same DB row via INTEGER affinity) — see /portal/login.
            const id = Number(rawId);
            if (!Number.isInteger(id) || id <= 0) return null;
            // Token must carry an expiry and not be past it. The access code is still verified against
            // the DB on every request, so rotating a code also invalidates any outstanding token.
            if (!exp || Date.now() > Number(exp)) return null;
            // SECURITY (audit HIGH): the token path was an unthrottled brute-force oracle for the 6-digit
            // code (attacker forges base64(id:guess:far-future) and reads the 200-vs-401). Apply the SAME
            // per-location throttle as /portal/login; a wrong code here counts as a failed attempt.
            if (loginThrottled(id)) return null;
            // Concurrency backstop (AUTH-A3 class): cap concurrent in-flight guesses per location so a
            // burst of forged tokens can't clear the throttle before noteLoginFailure arms it.
            if (!beginLoginAttempt(id)) return null;
            try {
                const location = await db.get(`SELECT * FROM ${T.locations} WHERE id = ? AND code = ?`, [id, code]);
                if (!location) { noteLoginFailure(id); return null; }
                clearLoginFailures(id); // a valid token resets this location's failure counter
                return location;
            } finally { endLoginAttempt(id); }
        } catch (e) {
            return null;
        }
    }


    // === PUBLIC PORTAL API ===

    http.route('get', '/public/list', async (req, res) => {
        try {
            const list = await db.all(`SELECT id, name, slug, date_start, date_end, description, status, is_form_published FROM ${T.conferences} WHERE is_form_published = 1 ORDER BY id DESC`);
            res.json(list);
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
            const list = await db.all(`SELECT name, label, type, options, is_required, width, is_group FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            res.json(list.filter(f => isFieldColumn(f.name)));
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
        let acquired = false;
        try {
            // Rate limit before touching the DB — bounds brute force of the 6-digit code per location.
            if (loginThrottled(location_id)) {
                return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
            }
            // Concurrency backstop (audit AUTH-A3 class): cap concurrent in-flight guesses per location so a
            // parallel burst can't clear the throttle before noteLoginFailure arms it. Released in finally.
            if (!(acquired = beginLoginAttempt(location_id))) {
                return res.status(429).json({ error: 'Demasiados intentos simultáneos. Inténtalo de nuevo en un momento.' });
            }
            const location = await db.get(`SELECT * FROM ${T.locations} WHERE id = ?`, [location_id]);
            if (!location) { noteLoginFailure(location_id); return res.status(404).json({ error: 'Location not found' }); }

            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [location.conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario de esta conferencia no está publicado.' });
            }

            // Simple code check
            if (String(location.code) !== String(code)) {
                noteLoginFailure(location_id);
                return res.status(401).json({ error: 'Invalid code' });
            }
            clearLoginFailures(location_id);

            // Stateless session token: base64(id:code:expiry). The code is the shared secret and is
            // re-checked against the DB on every request (resolvePortalLocation).
            const token = makePortalToken(location.id, location.code);

            // Set the portal cookie. The host namespaces it to `${tablePrefix}wordjs_portal_token`,
            // clamps it to this plugin's route path, and strips `secure` handling itself; we still pass
            // sensible flags. The client also receives the token to send via the x-portal-token header.
            res.cookie('wordjs_portal_token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days (host clamps anything longer)
            });

            res.json({ success: true, token, location: { id: location.id, name: location.name, responsible_name: location.responsible_name, conference_id: location.conference_id, capacity: location.capacity, inscribed: await locationOccupancy(location.id), payment_methods: enabledPaymentMethods(location), ...(await portalLodgingSummary(location)) } });
        } catch (e) { sendError(res, e); }
        finally { if (acquired) endLoginAttempt(location_id); }
    });

    // 4. Get Current Location Info
    http.route('get', '/portal/me', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        // Strip the secret access code (and the reviewing admin's id) before sending to the client; add
        // the live seat count so the portal can show 12 / 50 and close its form when the location is
        // full, plus the lodging summary (status, rooms allotted, attendees without a room). The other
        // lodging columns stay out too: GET /portal/lodging is the only source of the note/stamps and it
        // hides the note once the arrangement is submitted — this twin surface must not leak it.
        const { code, lodging_reviewed_by, lodging_note, lodging_submitted_at, lodging_reviewed_at, lodging_status, lodging_permission, lodging_permission_until, ...safe } = location;
        // Inside a catch: the handler answers every failure itself (sendError: a generic reply, the
        // details in the server log).
        try {
            res.json({ ...safe, inscribed: await locationOccupancy(location.id), payment_methods: enabledPaymentMethods(location), ...(await portalLodgingSummary(location)) });
        } catch (e) { sendError(res, e); }
    });

    // 4b. Logout — clear the namespaced session cookie so a refresh on a shared device does not
    // silently re-authenticate the previous coordinator.
    http.route('post', '/portal/logout', async (req, res) => {
        res.clearCookie('wordjs_portal_token', { path: '/' });
        res.json({ success: true });
    });

    // 5. Get Inscriptions for Location — isolated by location_id, projected to what the coordinator
    // needs: payment state + the form fields. Never notes/custom_data/room_id/status/location(_id).
    const PORTAL_BASE_COLS = ['id', 'payment_status', 'total_due', 'amount_paid', 'registration_date'];
    http.route('get', '/portal/inscriptions', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            const fields = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [location.conference_id]);
            const cols = [...new Set([...PORTAL_BASE_COLS, ...fields.map(f => f.name).filter(isFieldColumn)])];
            const list = await db.all(`SELECT ${cols.join(', ')} FROM ${T.inscriptions} WHERE location_id = ? AND conference_id = ? ORDER BY first_name`, [location.id, location.conference_id]);
            res.json(list);
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

    // 6. Create Inscription (Portal)
    http.route('post', '/portal/inscriptions', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const fieldValues = req.body && typeof req.body === 'object' ? req.body : {};
        const conference_id = location.conference_id;

        try {
            const conf = await db.get(`SELECT is_form_published, fee_default, date_end FROM ${T.conferences} WHERE id = ?`, [conference_id]);
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
            Object.assign(values, canonicalFieldValues(confFields, fieldValues));

            // Enforce required fields SERVER-SIDE — is_required was only advisory on the public form, so a
            // client could omit a field that drives pricing and under-quote total_due (audit MEDIUM).
            // '' (an empty number input) counts as missing.
            assertRequired(confFields, values, false);

            // Duplicate guard: a field flagged "no duplicates" must be unique — scoped to the coordinator's
            // OWN location. A conference-wide check turned the 409 into a cross-location probe oracle (a
            // coordinator could enumerate registrations in locations they don't manage) (audit LOW).
            await assertUnique(confFields, values, { conference_id, location_id: location.id });

            // first_name / last_name are NOT NULL — default to '' (no 'Sin Nombre' placeholder).
            if (values.first_name == null) values.first_name = '';
            if (values.last_name == null) values.last_name = '';

            // Fee from the pricing rules + base fee, evaluated against the submitted field values.
            values.total_due = await computeFee(conference_id, values, conf.fee_default);
            values.reg_code = await newRegCode();

            const keys = Object.keys(values);
            const result = await db.run(
                `INSERT INTO ${T.inscriptions} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                Object.values(values)
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) { sendError(res, e); }
    });

    // 7. Bulk Payments (Portal). Bounded: ids are deduplicated and capped at BULK_MAX_IDS, ownership is
    // ONE query keyed by location_id, the inserts go through db.batch and payment_status is refreshed
    // with ONE set-based statement — 1 SELECT + ≤1 batch + 1 UPDATE per request, whatever the input.
    const BULK_MAX_IDS = 200;
    http.route('post', '/portal/payments/bulk', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
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
            const amt = roundMoney(amount_per_person);
            if (amt <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const p = assertProof(proof);
            // The coordinator may only record a form of payment the admin enabled for this location.
            const m = assertPaymentMethod(method, enabledPaymentMethods(location));

            // ONE ownership query — every id must belong to this coordinator's location (by id).
            const owned = await db.all(
                `SELECT id FROM ${T.inscriptions} WHERE conference_id = ? AND location_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
                [location.conference_id, location.id, ...ids]
            );
            const skipped = ids.length - owned.length;
            if (owned.length === 0) return res.status(400).json({ error: 'No se aplicó ningún pago (las personas seleccionadas no pertenecen a esta localidad).' });

            // Coordinator-recorded payments also start 'pending' — the admin validates the comprobante.
            const ref = shortText(reference, 100);
            await runBatched(owned.map(o => [
                `INSERT INTO ${T.payments} (inscription_id, amount, method, reference, proof, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
                [o.id, amt, m, ref, p]
            ]));
            // validated-only recompute → pending doesn't count yet (keeps payment_status coherent anyway).
            const ownedIds = owned.map(o => o.id);
            await recomputePayments(`id IN (${ownedIds.map(() => '?').join(', ')})`, ownedIds);
            res.json({ success: true, applied: owned.length, skipped });
        } catch (e) { sendError(res, e); }
    });

    // === PORTAL LODGING (2.5.0) — the coordinator arranges THEIR attendees in THEIR allotted rooms ===
    // Every route resolves the location first (401 otherwise); every query is scoped by location.id
    // AND location.conference_id. Writes are refused unless the arrangement is a draft (409 while it
    // is submitted / validated); state transitions are compare-and-set UPDATEs under the assignment
    // lock. Nothing here can reach a pool room, another location's room or another location's rules.
    const PORTAL_FROZEN_MSG = 'El hospedaje está en validación/validado y no se puede modificar.';
    const PORTAL_RULES_MAX = 50;
    const PORTAL_RUN_COOLDOWN_MS = 5000;
    // Lodging summary for the /portal/login and /portal/me payloads: status (COALESCE'd), the number of
    // rooms allotted to the location and its non-cancelled attendees without a room.
    async function portalLodgingSummary(location) {
        const row = await db.get(
            `SELECT (SELECT COUNT(*) FROM ${T.rooms} r WHERE r.location_id = ?) AS rooms_allotted,`
            + ` (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.location_id = ? AND i.conference_id = ? AND i.room_id IS NULL AND ${occupiedSql('i.status')}) AS unlodged`,
            [location.id, location.id, location.conference_id]);
        return {
            lodging_status: lodgingStatusOf(location),
            rooms_allotted: Number(row && row.rooms_allotted) || 0,
            unlodged: Number(row && row.unlodged) || 0,
        };
    }
    // The admin's deadline for the coordinators' arrangements (conferences.lodging_deadline). NULL = no
    // deadline. A bare date ('2026-10-01') covers the WHOLE day, like date_end for registrations; a
    // datetime is exact. Only portal writes honour it — the admin keeps arranging whenever it likes.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const isBareDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim());
    function lodgingDeadlineInfo(conf) {
        const rawValue = conf && conf.lodging_deadline;
        if (rawValue == null || rawValue === '') return { deadline: null, passed: false };
        const t = new Date(rawValue).getTime();
        if (!Number.isFinite(t)) return { deadline: null, passed: false };
        return { deadline: rawValue, passed: Date.now() > (isBareDate(rawValue) ? t + DAY_MS : t) };
    }
    // '2026-10-01' → '01/10/2026'; a datetime keeps its clock ('01/10/2026 18:00').
    const fmtDeadline = (v) => {
        const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        if (!m) return String(v);
        return `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
    };
    // The admin's exception for ONE location (locations.lodging_permission / _until): it may keep arranging
    // after the conference deadline, until `until` (a bare date covers its whole day, like the deadline) or,
    // with no date, until the admin revokes it. A corrupt date reads as "no end" — the admin granted it.
    function lodgingPermissionInfo(loc) {
        if (!loc || !Number(loc.lodging_permission)) return { granted: false, until: null, active: false, expired: false };
        const rawValue = loc.lodging_permission_until;
        const t = rawValue == null || rawValue === '' ? NaN : new Date(rawValue).getTime();
        if (!Number.isFinite(t)) return { granted: true, until: null, active: true, expired: false };
        const expired = Date.now() > (isBareDate(rawValue) ? t + DAY_MS : t);
        return { granted: true, until: rawValue, active: !expired, expired };
    }
    // May this location's coordinator change its lodging right now (deadline-wise)? The frozen state
    // (submitted / validated) is a separate check.
    function lodgingWindow(conf, loc) {
        const deadline = lodgingDeadlineInfo(conf);
        const permission = lodgingPermissionInfo(loc);
        return { deadline, permission, open: !deadline.passed || permission.active };
    }
    // Every portal lodging write: 403 once the deadline has passed, unless the location holds an active
    // permission. Both rows are re-read so a permission granted or revoked a moment ago applies at once.
    async function assertLodgingWindowOpen(location) {
        const conf = await db.get(`SELECT lodging_deadline FROM ${T.conferences} WHERE id = ?`, [location.conference_id]);
        const loc = await db.get(`SELECT lodging_permission, lodging_permission_until FROM ${T.locations} WHERE id = ?`, [location.id]);
        const w = lodgingWindow(conf, loc);
        if (w.open) return;
        const d = fmtDeadline(w.deadline.deadline);
        if (w.permission.expired) throw httpError(403, `El plazo para acomodar los hospedajes venció el ${d} y el permiso de tu localidad venció el ${fmtDeadline(w.permission.until)}. Solo el administrador puede modificarlos.`);
        throw httpError(403, `El plazo para acomodar los hospedajes venció el ${d}. Solo el administrador puede modificarlos.`);
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
            const win = lodgingWindow(
                await db.get(`SELECT lodging_deadline FROM ${T.conferences} WHERE id = ?`, [location.conference_id]),
                await db.get(`SELECT lodging_permission, lodging_permission_until FROM ${T.locations} WHERE id = ?`, [location.id]));
            const deadline = win.deadline;
            res.json({
                status,
                deadline: deadline.deadline,
                deadline_passed: deadline.passed,
                // The admin's exception for this location (see lodgingPermissionInfo) and the verdict.
                permission: win.permission,
                window_open: win.open,
                // The admin's observations only matter while the coordinator can act on them.
                note: status === 'draft' ? view.location.lodging_note : null,
                submitted_at: view.location.lodging_submitted_at,
                reviewed_at: view.location.lodging_reviewed_at,
                can_edit: status === 'draft' && win.open,
                rooms: view.rooms,
                unassigned: view.unassigned,
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
                const ins = await db.get(`SELECT id, status, room_id, location_id FROM ${T.inscriptions} WHERE id = ? AND location_id = ? AND conference_id = ?`, [insId, location.id, location.conference_id]);
                if (!ins) throw httpError(404, 'Inscripción no encontrada.');

                if (roomId === null) {
                    if (ins.room_id == null) return;
                    const r = await db.run(
                        `UPDATE ${T.inscriptions} SET room_id = NULL WHERE id = ? AND location_id = ? AND room_id IN (SELECT id FROM ${T.rooms} WHERE location_id = ?)`,
                        [ins.id, location.id, location.id]);
                    if (!r || !r.changes) throw httpError(404, 'Habitación no encontrada.');
                    return;
                }
                const room = await db.get(
                    `SELECT r.id, r.capacity, (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) AS occupied
                     FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id
                     WHERE r.id = ? AND r.location_id = ? AND h.conference_id = ?`, [roomId, location.id, location.conference_id]);
                if (!room) throw httpError(404, 'Habitación no encontrada.');
                if (ins.status === 'cancelled') throw httpError(400, 'Un participante cancelado no ocupa habitación.');
                const alreadyHere = Number(ins.room_id) === Number(room.id);
                if (alreadyHere) return;
                if (Number(room.occupied) >= Number(room.capacity)) throw httpError(400, 'La habitación está llena.');
                // The room must still be L's when the write lands (an admin re-allotment cannot interleave
                // thanks to the lock, but the predicate costs nothing). No self-referencing capacity
                // subquery here: MySQL refuses an UPDATE whose subquery reads the updated table (1093);
                // the capacity check above is serialised by the assignment lock instead.
                const r = await db.run(
                    `UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ? AND location_id = ? AND conference_id = ?`
                    + ` AND EXISTS (SELECT 1 FROM ${T.rooms} x WHERE x.id = ? AND x.location_id = ?)`,
                    [room.id, ins.id, location.id, location.conference_id, room.id, location.id]);
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
                await db.run(
                    `UPDATE ${T.inscriptions} SET room_id = NULL WHERE location_id = ? AND conference_id = ? AND room_id IN (SELECT id FROM ${T.rooms} WHERE location_id = ?)`,
                    [location.id, location.conference_id, location.id]);
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
                    + ` SUM(CASE WHEN i.room_id IN (SELECT id FROM ${T.rooms} WHERE location_id = ?) THEN 1 ELSE 0 END) AS placed`
                    + ` FROM ${T.inscriptions} i WHERE i.location_id = ? AND i.conference_id = ? AND ${occupiedSql('i.status')}`,
                    [location.id, location.id, location.conference_id]);
                const present = Number(c && c.present) || 0, placed = Number(c && c.placed) || 0;
                if (present > 0 && placed === 0) throw httpError(400, 'No hay ninguna asignación de hospedaje para enviar.');
                const r = await db.run(
                    `UPDATE ${T.locations} SET lodging_status = 'submitted', lodging_submitted_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(lodging_status, 'draft') = 'draft'`,
                    [location.id]);
                if (!r || !r.changes) throw httpError(409, 'El hospedaje ya fue enviado.');
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
    // Team & permissions (2.15.0): every logged-in user who may open /admin sees the entry; the page asks
    // GET /staff/me and shows only the sections the user's role allows (a user not on the team gets a
    // friendly «no access» screen). The server gates every route itself (allow()).
    adminMenu.add({
        href: '/admin/plugin/conference-manager',
        label: 'Conference',
        icon: 'fa-users',
        order: 50,
        cap: 'access_admin_panel'
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
