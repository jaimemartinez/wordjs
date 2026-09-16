/**
 * Conference Manager Plugin for WordJS — ISOLATED, NO TRUST TIER.
 *
 * Runs in the child_process sandbox like every other plugin. It uses ONLY the injected `wordjs`
 * capability bridge (no direct require of express/core/dbAsync) and is granted Android-style
 * permissions (database:read, database:write, express:register_route, admin_menu:register) by the
 * admin. There is NO trusted bypass:
 *   - All tables live under the plugin's own prefix `wjp_conference_manager_` so they pass
 *     assertSqlAllowed's default-deny prefix check. Table names are built from wordjs.db.tablePrefix.
 *   - No PRAGMA / information_schema (denied for plugins). Schema is created idempotently with
 *     createTable and extended with ALTER TABLE … ADD COLUMN on our OWN prefixed tables (permitted;
 *     see addColumnIfMissing).
 *   - Routes are namespaced under /api/v1/plugin/conference-manager/* (no `absolute` paths). The
 *     options object only carries { auth, admin } which the host honors with real middleware.
 *   - The portal cookie is host-namespaced; we read the namespaced cookie OR the x-portal-token header.
 *
 * Plugin SQL rules (host guard, assertSqlAllowed): no backslashes, no `$`, no `[ ]`, no `;` — so a
 * LIKE with user text escapes its wildcards with `!` (LIKE … ESCAPE '!'), never with a backslash.
 */

exports.metadata = {
    name: 'Conference Manager',
    version: '2.2.0',
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
        'payment_status', 'total_due', 'amount_paid', 'room_id', 'notes',
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
            'description TEXT'
        ]);

        // 2. Locations
        await db.createTable(T.locations, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'code TEXT NOT NULL',
            'responsible_name TEXT',
            'responsible_phone TEXT',
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
    // `sendError(res, e)` → res.status(e.status || 500).json({ error: e.message }).
    class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
    const httpError = (status, message) => new HttpError(status, message);
    const sendError = (res, e) => res.status(e && e.status ? e.status : 500).json({ error: e && e.message ? e.message : String(e) });

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
                ? await db.get(`SELECT id, name FROM ${T.locations} WHERE id = ? AND conference_id = ?`, [lid, conferenceId]) : null;
            if (!loc) throw httpError(400, 'Localidad no encontrada en esta conferencia.');
            return loc;
        }
        if (typeof body.location === 'string' && body.location.trim()) {
            const loc = await db.get(`SELECT id, name FROM ${T.locations} WHERE conference_id = ? AND LOWER(name) = LOWER(?)`, [conferenceId, body.location.trim()]);
            if (!loc) throw httpError(400, 'Localidad no encontrada en esta conferencia.');
            return loc;
        }
        return undefined; // neither key present
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

    // === CONFERENCES MANAGEMENT ===
    http.route('get', '/list', { auth: true, admin: true }, async (req, res) => {
        const list = await db.all(`SELECT * FROM ${T.conferences} ORDER BY id DESC`);
        res.json(list);
    });

    http.route('post', '/create', { auth: true, admin: true }, async (req, res) => {
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
    http.route('put', '/:id', { auth: true, admin: true }, async (req, res) => {
        const { name, slug, date_start, date_end, fee_default, description, status } = req.body;
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

    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.conferences} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === DATA SEGMENTATION (requires conference_id in query/body) ===

    // Hotels for a conference
    http.route('get', '/hotels', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            const hotels = await db.all(`SELECT * FROM ${T.hotels} WHERE conference_id = ? ORDER BY name`, [conference_id]);

            // Single joined query with a correlated occupancy subquery (mirrors runAssignment),
            // then group rooms under their hotel in JS — avoids the per-hotel + per-room N+1.
            const rooms = await db.all(`
                SELECT r.*,
                (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) as occupied
                FROM ${T.rooms} r
                JOIN ${T.hotels} h ON r.hotel_id = h.id
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
    async function inscriptionFilters(q, params) {
        let where = '';
        const search = q.search ? String(q.search).slice(0, 200) : '';
        if (search) {
            const flds = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [q.conference_id]);
            const cols = [...new Set([...flds.map(f => f.name).filter(isFieldColumn), 'location'])];
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
    http.route('get', '/inscriptions', { auth: true, admin: true }, async (req, res) => {
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
            query += await inscriptionFilters(req.query, params);
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

            // Parse custom_data (guarded — one malformed legacy row must not 500 the whole roster).
            const parsedList = list.map(item => ({ ...item, custom_data: parseCd(item.custom_data) }));

            res.json(parsedList);
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/publish', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, published } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            await db.run(`UPDATE ${T.conferences} SET is_form_published = ? WHERE id = ?`, [published ? 1 : 0, conference_id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === FIELDS ===
    http.route('get', '/fields', { auth: true, admin: true }, async (req, res) => {
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
    http.route('post', '/fields', { auth: true, admin: true }, async (req, res) => {
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

    http.route('delete', '/fields/:id', { auth: true, admin: true }, async (req, res) => {
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

    http.route('get', '/fee-rules', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT * FROM ${T.feeRules} WHERE conference_id = ? ORDER BY priority ASC, id ASC`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/fee-rules', { auth: true, admin: true }, async (req, res) => {
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

    http.route('delete', '/fee-rules/:id', { auth: true, admin: true }, async (req, res) => {
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
    http.route('post', '/reprice', { auth: true, admin: true }, async (req, res) => {
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
    http.route('post', '/inscriptions', { auth: true, admin: true }, async (req, res) => {
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
            if (loc) { values.location_id = loc.id; values.location = loc.name; }

            // first_name / last_name are NOT NULL — default to '' (no more 'Sin Nombre' placeholder);
            // the display name is whatever the form collects, not an assumed column.
            if (values.first_name == null) values.first_name = '';
            if (values.last_name == null) values.last_name = '';

            // Apply the fee (server-controlled) from the pricing rules + base fee, computed against
            // the attendee's field values — so the attendee isn't instantly 'paid' and tiered/rule
            // pricing takes effect. A client-sent total_due is never honoured.
            values.total_due = await computeFee(confId, values, conf.fee_default);

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
    http.route('get', '/locations', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT *, (SELECT COUNT(*) FROM ${T.fields} WHERE conference_id = ${T.conferences}.id) as fields_count FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            const locations = await db.all(`SELECT * FROM ${T.locations} WHERE conference_id = ? ORDER BY name`, [conference_id]);
            res.json({ locations, conference: conf });
        } catch (e) { sendError(res, e); }
    });

    // Location names are unique per conference (case-insensitive) so the display label is unambiguous.
    http.route('post', '/locations', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, name, responsible_name, responsible_phone } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const cleanName = String(name || '').trim();
        if (!cleanName) return res.status(400).json({ error: 'El nombre de la localidad es obligatorio.' });

        try {
            const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const dup = await db.get(`SELECT id FROM ${T.locations} WHERE conference_id = ? AND LOWER(name) = LOWER(?)`, [conference_id, cleanName]);
            if (dup) return res.status(409).json({ error: 'Ya existe una localidad con ese nombre en esta conferencia.' });
            const code = await genAccessCode();
            const result = await db.run(
                `INSERT INTO ${T.locations} (conference_id, name, code, responsible_name, responsible_phone) VALUES (?, ?, ?, ?, ?)`,
                [conference_id, cleanName, code, responsible_name || null, responsible_phone || null]
            );
            res.json({ success: true, id: result.lastID, code });
        } catch (e) { sendError(res, e); }
    });

    // Update a location; pass rotate_code:true to issue a fresh access code (invalidates old sessions).
    // A rename also refreshes the display label on the location's inscriptions (location_id stays).
    http.route('put', '/locations/:id', { auth: true, admin: true }, async (req, res) => {
        const { name, responsible_name, responsible_phone, rotate_code } = req.body;
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

    http.route('delete', '/locations/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            // No FK can be added by ALTER in SQLite: detach the attendees explicitly. The label is kept
            // for history (reports/CSV still show where they registered).
            await db.run(`UPDATE ${T.inscriptions} SET location_id = NULL WHERE location_id = ?`, [req.params.id]);
            await db.run(`DELETE FROM ${T.locations} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === HOTELS & ROOMS (full CRUD) ===
    http.route('post', '/hotels', { auth: true, admin: true }, async (req, res) => {
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
    http.route('put', '/hotels/:id', { auth: true, admin: true }, async (req, res) => {
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
    http.route('delete', '/hotels/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            // Free any attendees assigned to this hotel's rooms before the FK cascade drops the rooms,
            // so occupancy counts stay honest.
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE room_id IN (SELECT id FROM ${T.rooms} WHERE hotel_id = ?)`, [req.params.id]);
            await db.run(`DELETE FROM ${T.hotels} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/rooms', { auth: true, admin: true }, async (req, res) => {
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
    http.route('put', '/rooms/:id', { auth: true, admin: true }, async (req, res) => {
        const { room_number, capacity, gender, is_family, family_name, notes } = req.body;
        try {
            const sets = [], params = [];
            if (room_number !== undefined) {
                if (!String(room_number).trim()) return res.status(400).json({ error: 'El número de habitación es obligatorio.' });
                sets.push('room_number = ?'); params.push(String(room_number).trim());
            }
            if (capacity !== undefined) {
                const cap = Math.max(1, Number(capacity) || 1);
                // Never shrink capacity below the people already placed in the room.
                const occ = await db.get(`SELECT COUNT(*) as c FROM ${T.inscriptions} WHERE room_id = ?`, [req.params.id]);
                if (cap < (occ?.c || 0)) return res.status(400).json({ error: `La capacidad no puede ser menor que los ${occ.c} ocupantes actuales.` });
                sets.push('capacity = ?'); params.push(cap);
            }
            if (gender !== undefined) { sets.push('gender = ?'); params.push(gender || 'Mixed'); }
            if (is_family !== undefined) { sets.push('is_family = ?'); params.push(is_family ? 1 : 0); }
            if (family_name !== undefined) { sets.push('family_name = ?'); params.push(family_name || null); }
            if (notes !== undefined) { sets.push('notes = ?'); params.push(notes || null); }
            if (!sets.length) return res.json({ success: true });
            params.push(req.params.id);
            await db.run(`UPDATE ${T.rooms} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/rooms/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE room_id = ?`, [req.params.id]);
            await db.run(`DELETE FROM ${T.rooms} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === INSCRIPTIONS: edit / delete / manual room assignment ===
    // total_due is DERIVED — a client value is ignored. It is frozen at registration; an edit re-prices
    // it ONLY when the edit changes what the CURRENT rules yield (a fee-relevant field changed: the
    // rules give a different fee for the row before vs after). A notes/status/location-only edit —
    // or an edit that leaves every fee-relevant value as it was — never touches total_due, even when
    // rules or the base fee changed since registration: those reach existing attendees only through
    // /reprice, for EVERYONE at once, never one attendee at a time through an unrelated edit.
    http.route('put', '/inscriptions/:id', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, ...fieldValues } = req.body || {};
        try {
            const existing = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            if (!existing) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            const id = existing.id;

            // Write each DEFINED field's canonical value to its column (schema follows the form) + the
            // operational edits the admin is allowed to change directly (status, notes, location_id).
            const confFields = await db.all(FIELD_COLUMNS_SQL, [existing.conference_id]);
            const vals = canonicalFieldValues(confFields, fieldValues);
            assertRequired(confFields, vals, true);
            await assertUnique(confFields, vals, { conference_id: existing.conference_id }, id);

            const sets = [], params = [];
            for (const [k, v] of Object.entries(vals)) { sets.push(`${k} = ?`); params.push(v); }
            if (fieldValues.status !== undefined) {
                // Closed vocabulary — the same rule the conference `status` already follows. 'pending' is the
                // insert default, 'active' is what the admin's toggle writes; anything else is a typo or a probe.
                const st = fieldValues.status == null ? null : String(fieldValues.status);
                if (st !== null && !INSCRIPTION_STATUSES.has(st)) return res.status(400).json({ error: 'Estado de inscripción inválido.' });
                sets.push('status = ?'); params.push(st);
            }
            if (fieldValues.notes !== undefined) { sets.push('notes = ?'); params.push(fieldValues.notes == null ? null : String(fieldValues.notes)); }
            const loc = await resolveAdminLocation(existing.conference_id, { location_id: fieldValues.location_id });
            if (loc === null) { sets.push('location_id = ?', 'location = ?'); params.push(null, null); }
            else if (loc) { sets.push('location_id = ?', 'location = ?'); params.push(loc.id, loc.name); }
            if (sets.length) {
                params.push(id);
                await db.run(`UPDATE ${T.inscriptions} SET ${sets.join(', ')} WHERE id = ?`, params);
            }
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
    http.route('delete', '/inscriptions/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // Manual room assignment — validates capacity + same-conference scope (auto-assign already does;
    // the manual path used to bare-UPDATE and could overfill or cross-place). Pass room_id null to free.
    http.route('post', '/inscriptions/:id/assign', { auth: true, admin: true }, async (req, res) => {
        const roomId = req.body.room_id;
        try {
            const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });

            if (roomId === null || roomId === undefined || roomId === '') {
                await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE id = ?`, [req.params.id]);
                return res.json({ success: true });
            }
            const room = await db.get(
                `SELECT r.*, h.conference_id,
                        (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) as occupied
                 FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE r.id = ?`, [roomId]);
            if (!room) return res.status(404).json({ error: 'Habitación no encontrada.' });
            if (Number(room.conference_id) !== Number(ins.conference_id)) {
                return res.status(400).json({ error: 'Esa habitación pertenece a otra conferencia.' });
            }
            const alreadyHere = Number(ins.room_id) === Number(roomId);
            if (!alreadyHere && room.occupied >= room.capacity) {
                return res.status(400).json({ error: 'La habitación está llena.' });
            }
            await db.run(`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [roomId, req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    // === PAYMENTS: add / void / validate / reject ===
    // State machine: pending → validated | rejected; validated ↔ rejected; only pending/rejected may be
    // deleted (a validated payment is part of the ledger — reject it first). validate/reject stamp
    // reviewed_at/reviewed_by (the host forwards req.user {id, role, …} to isolated routes).
    const reviewerOf = (req) => (req.user && req.user.id != null ? String(req.user.id) : null);
    http.route('post', '/inscriptions/:id/payments', { auth: true, admin: true }, async (req, res) => {
        const { amount, method, reference, proof } = req.body;
        try {
            if (!Number.isFinite(Number(amount)) || Number(amount) > MAX_MONEY) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const amt = roundMoney(amount);
            if (amt <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
            const p = assertProof(proof);
            const ins = await db.get(`SELECT id FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            // New payments start 'pending' — an admin must validate before they count toward the balance.
            await db.run(`INSERT INTO ${T.payments} (inscription_id, amount, method, reference, proof, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
                [ins.id, amt, shortText(method, 100), shortText(reference, 100), p]);
            await recomputePayment(ins.id); // validated-only recompute → pending doesn't count yet
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });
    http.route('delete', '/payments/:id', { auth: true, admin: true }, async (req, res) => {
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
    http.route('post', '/payments/:id/validate', { auth: true, admin: true }, async (req, res) => {
        try {
            const pay = await db.get(`SELECT inscription_id, status FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (pay.status === 'validated') return res.status(409).json({ error: 'El pago ya está validado.' });
            await db.run(`UPDATE ${T.payments} SET status = 'validated', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?`, [reviewerOf(req), req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true, status: 'validated' });
        } catch (e) { sendError(res, e); }
    });
    http.route('post', '/payments/:id/reject', { auth: true, admin: true }, async (req, res) => {
        try {
            const pay = await db.get(`SELECT inscription_id, status FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            if (pay.status === 'rejected') return res.status(409).json({ error: 'El pago ya está rechazado.' });
            await db.run(`UPDATE ${T.payments} SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?`, [reviewerOf(req), req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true, status: 'rejected' });
        } catch (e) { sendError(res, e); }
    });

    http.route('get', '/inscriptions/:id/payments', { auth: true, admin: true }, async (req, res) => {
        try {
            const list = await db.all(`SELECT * FROM ${T.payments} WHERE inscription_id = ? ORDER BY date DESC`, [req.params.id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    // === REPORTS ===
    // Aggregate roster stats for the Reports dashboard (counts, money, per-location breakdown).
    http.route('get', '/reports/summary', { auth: true, admin: true }, async (req, res) => {
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
    http.route('get', '/inscriptions/export', { auth: true, admin: true }, async (req, res) => {
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
            query += await inscriptionFilters(req.query, params);
            query += ` ORDER BY i.last_name, i.first_name`;
            const rows = await db.all(query, params);

            const MONEY_COLS = new Set(['total_due', 'amount_paid']);
            const cols = [
                ...safeFlds.map(f => [f.name, f.label || f.name]),
                ['status', 'Estado'], ['payment_status', 'Pago'],
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
    http.route('get', '/assignment/rules', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? ORDER BY priority DESC`, [conference_id]);
            res.json(list);
        } catch (e) { sendError(res, e); }
    });

    const RULE_TYPES = new Set(['keep_together', 'separate_by', 'split_by', 'require_companion']);
    http.route('post', '/assignment/rules', { auth: true, admin: true }, async (req, res) => {
        const { id, conference_id, name, type, enabled, priority, config, params, hard } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const cleanName = typeof name === 'string' ? name.trim() : '';
            if (!cleanName) return res.status(400).json({ error: 'El nombre de la regla es obligatorio.' });
            if (!RULE_TYPES.has(type)) return res.status(400).json({ error: 'Tipo de regla inválido.' });
            const cfg = config == null ? '' : String(config).trim();
            if (cfg !== '' && !isFieldColumn(cfg)) return res.status(400).json({ error: 'El campo de la regla es inválido.' });
            // params is a JSON blob of the rule type's extra config — normalize to a string.
            let paramsObj;
            if (params == null) paramsObj = {};
            else if (typeof params === 'string') {
                const t = params.trim();
                if (!t) paramsObj = {};
                else { try { paramsObj = JSON.parse(t); } catch { paramsObj = null; } }
            } else paramsObj = params;
            if (!paramsObj || typeof paramsObj !== 'object' || Array.isArray(paramsObj)) return res.status(400).json({ error: 'Los parámetros de la regla no son JSON válido.' });
            const paramsStr = JSON.stringify(paramsObj);
            const hardVal = hard ? 1 : 0;
            const en = enabled === undefined ? 1 : (enabled ? 1 : 0);
            const prio = Number(priority) || 0;
            if (id) {
                // Verify the rule belongs to the specified conference before updating.
                const existing = await db.get(`SELECT conference_id FROM ${T.rules} WHERE id = ?`, [id]);
                if (!existing) return res.status(404).json({ error: 'Regla no encontrada.' });
                if (String(existing.conference_id) !== String(conference_id)) {
                    return res.status(403).json({ error: 'La regla no pertenece a esta conferencia.' });
                }
                await db.run(
                    `UPDATE ${T.rules} SET name = ?, type = ?, enabled = ?, priority = ?, config = ?, params = ?, hard = ? WHERE id = ?`,
                    [cleanName, type, en, prio, cfg, paramsStr, hardVal, id]
                );
            } else {
                const conf = await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [conference_id]);
                if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                await db.run(
                    `INSERT INTO ${T.rules} (conference_id, name, type, enabled, priority, config, params, hard) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, cleanName, type, en, prio, cfg, paramsStr, hardVal]
                );
            }
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('delete', '/assignment/rules/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.rules} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/assignment/reset', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Serialize with runs so a reset can't interleave with an in-flight assignment.
            await withAssignmentLock(() => db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE conference_id = ?`, [conference_id]));
            res.json({ success: true });
        } catch (e) { sendError(res, e); }
    });

    http.route('post', '/assignment/run', { auth: true, admin: true }, async (req, res) => {
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
    const ASSIGN_MAX_PARTICIPANTS = 5000;
    async function runAssignment(conferenceId) {
        const ruleRows = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND enabled = 1 ORDER BY priority DESC, id ASC`, [conferenceId]);
        const rules = ruleRows.map(r => {
            let params = {};
            try { params = r.params ? JSON.parse(r.params) : {}; } catch { params = {}; }
            return { id: r.id, name: r.name, type: r.type, field: r.config, params: params || {}, hard: !!r.hard, priority: r.priority };
        });
        const keepRules = rules.filter(r => r.type === 'keep_together');
        const separateRules = rules.filter(r => r.type === 'separate_by');
        const splitRules = rules.filter(r => r.type === 'split_by');
        const companionRules = rules.filter(r => r.type === 'require_companion');

        let participants = (await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND room_id IS NULL`, [conferenceId]))
            .map(p => ({ ...p, custom_data: parseCd(p.custom_data) }));
        if (participants.length > ASSIGN_MAX_PARTICIPANTS) throw httpError(400, `Demasiados inscritos sin asignar para una sola ejecución (máximo ${ASSIGN_MAX_PARTICIPANTS}).`);

        const roomRows = await db.all(
            `SELECT r.*, h.name as hotel_name FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ?`,
            [conferenceId]
        );
        // Occupancy in ONE query (no per-room SELECT), grouped by room in JS.
        const occRows = await db.all(
            `SELECT i.* FROM ${T.inscriptions} i WHERE i.room_id IN (SELECT r.id FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ? )`,
            [conferenceId]
        );
        const occByRoom = new Map();
        for (const o of occRows) {
            if (!occByRoom.has(o.room_id)) occByRoom.set(o.room_id, []);
            occByRoom.get(o.room_id).push({ ...o, custom_data: parseCd(o.custom_data) });
        }
        const rooms = roomRows.map(r => ({ id: r.id, capacity: Math.max(1, Number(r.capacity) || 1), room_number: r.room_number, hotel_name: r.hotel_name, occupants: occByRoom.get(r.id) || [] }));

        const val = (p, f) => (p[f] !== undefined && p[f] !== null && p[f] !== '') ? p[f] : (p.custom_data ? p.custom_data[f] : undefined);
        const cond = (preds, p) => !Array.isArray(preds) || preds.length === 0 || preds.every(pr => attrMatches(pr, (f) => val(p, f)));

        let assignedCount = 0;
        const violations = [];
        const noteViol = (rule, detail, hard) => { if (!violations.some(v => v.rule === rule && v.detail === detail)) violations.push({ rule, detail, hard: !!hard }); };

        // A merged set (a room's occupants + candidate people) is OK for a HARD separate rule iff it has
        // at most one distinct non-blank value of that rule's field.
        const mergedSeparateOk = (occupants, people) => {
            for (const rule of separateRules) {
                if (!rule.hard) continue;
                const seen = new Set();
                for (const p of occupants.concat(people)) { const v = val(p, rule.field); if (v != null && String(v).trim() !== '') seen.add(String(v).trim().toLowerCase()); }
                if (seen.size > 1) return false;
            }
            return true;
        };
        const companionUnmet = (occupants) => {
            const out = [];
            for (const rule of companionRules) {
                const min = Number(rule.params.min) || 1;
                if (!occupants.some(o => cond(rule.params.subject, o))) continue;
                if (occupants.filter(o => cond(rule.params.needs, o)).length < min) out.push(rule);
            }
            return out;
        };
        // Higher = better room for placing `people`: penalize soft-separate mixing, companion gaps, waste.
        const score = (room, people) => {
            let s = 0;
            const after = room.occupants.concat(people);
            for (const rule of separateRules) {
                if (rule.hard) continue;
                const seen = new Set();
                for (const p of after) { const v = val(p, rule.field); if (v != null && String(v).trim() !== '') seen.add(String(v).trim().toLowerCase()); }
                if (seen.size > 1) s -= 5;
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

        const hardSepFields = separateRules.filter(r => r.hard).map(r => r.field);
        const hardSepNames = separateRules.filter(r => r.hard).map(r => r.name).join('», «');

        // `group` = null | { rule, key } — the keep_together rule that formed this unit and its display
        // value, so a forced division can be reported under that rule's name.
        const placePartition = (people, group) => {
            if (people.length === 0) return;
            const feasible = rooms.filter(room => (room.capacity - room.occupants.length) >= people.length && mergedSeparateOk(room.occupants, people));
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
                    if (free >= 1 && free > freeMax && mergedSeparateOk(room.occupants, [people[0]])) { target = room; freeMax = free; }
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
                if ((room.capacity - room.occupants.length) >= 1 && mergedSeparateOk(room.occupants, people)) { const s = score(room, people); if (s > best) { best = s; target = room; } }
            }
            if (target) assignTo(target, people[0]);
            // else: left unassigned → aggregated into the single capacity violation at the end.
        };

        // Hard separate_by forces a unit to divide along those fields before placement.
        const placeUnit = (unit) => {
            const parts = partitionBy(unit.people, hardSepFields);
            if (parts.length > 1 && unit.group) noteViol(unit.group.rule.name, `El grupo «${unit.group.key}» (${unit.people.length}) se dividió por la regla obligatoria «${hardSepNames}».`, unit.group.rule.hard);
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
        // but too few companions (respecting capacity + hard separate), without stranding the donor.
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
                        const cand = donor.occupants.find(o => cond(rule.params.needs, o) && mergedSeparateOk(room.occupants, [o]));
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

            res.json({ success: true, token, location: { id: location.id, name: location.name, responsible_name: location.responsible_name, conference_id: location.conference_id } });
        } catch (e) { sendError(res, e); }
        finally { if (acquired) endLoginAttempt(location_id); }
    });

    // 4. Get Current Location Info
    http.route('get', '/portal/me', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        // Strip the secret access code before sending to the client.
        const { code, ...safe } = location;
        res.json(safe);
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

            // ONE ownership query — every id must belong to this coordinator's location (by id).
            const owned = await db.all(
                `SELECT id FROM ${T.inscriptions} WHERE conference_id = ? AND location_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
                [location.conference_id, location.id, ...ids]
            );
            const skipped = ids.length - owned.length;
            if (owned.length === 0) return res.status(400).json({ error: 'No se aplicó ningún pago (las personas seleccionadas no pertenecen a esta localidad).' });

            // Coordinator-recorded payments also start 'pending' — the admin validates the comprobante.
            const m = shortText(method, 100), ref = shortText(reference, 100);
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

    // === ADMIN MENU ===
    // Every route here requires role `administrator`; gate the sidebar entry on a capability only
    // administrators hold (editors have manage_categories and would see an entry that 403s).
    adminMenu.add({
        href: '/admin/plugin/conference-manager',
        label: 'Conference',
        icon: 'fa-users',
        order: 50,
        cap: 'manage_options'
    });

    console.log('Conference Manager Plugin (Multi-Event, sandboxed) initialized.');
};

exports.deactivate = function () {
    console.log('Conference Manager plugin deactivated');
};
