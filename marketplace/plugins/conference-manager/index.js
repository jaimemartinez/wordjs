/**
 * Conference Manager Plugin for WordJS — ISOLATED, NO TRUST TIER.
 *
 * Runs in the child_process sandbox like every other plugin. It uses ONLY the injected `wordjs`
 * capability bridge (no direct require of express/core/dbAsync) and is granted Android-style
 * permissions (database:read, database:write, express:register_route, admin_menu:register) by the
 * admin. There is NO trusted bypass:
 *   - All tables live under the plugin's own prefix `wjp_conference_manager_` so they pass
 *     assertSqlAllowed's default-deny prefix check. Table names are built from wordjs.db.tablePrefix.
 *   - No PRAGMA / information_schema / ALTER-driven migration (all blocked for plugins). Schema is
 *     created idempotently with createTable (CREATE TABLE IF NOT EXISTS) carrying the full column set.
 *   - Routes are namespaced under /api/v1/plugin/conference-manager/* (no `absolute` paths). The
 *     options object only carries { auth, admin } which the host honors with real middleware.
 *   - The portal cookie is host-namespaced; we read the namespaced cookie OR the x-portal-token header.
 */

exports.metadata = {
    name: 'Conference Manager',
    version: '2.1.0',
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
    // Idempotent ADD COLUMN (no IF NOT EXISTS in SQLite → swallow the duplicate-column error).
    async function addColumnIfMissing(table, col, type) {
        if (!isSafeColumn(col)) return false;
        try { await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); return true; }
        catch (e) { return false; /* already exists (or bad type) — safe to ignore */ }
    }

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

        // 5. Inscriptions
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

        // Indexes for the common filtered/joined lookups. Names AND targets must use the plugin prefix
        // (assertSqlAllowed enforces this). CREATE INDEX IF NOT EXISTS works on both SQLite and Postgres.
        const createIndex = async (name, table, cols) => {
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
            } catch (e) {
                // Ignore if index already exists / unsupported.
            }
        };
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
        const confsNoFields = await db.all(
            `SELECT c.id FROM ${T.conferences} c WHERE NOT EXISTS (SELECT 1 FROM ${T.fields} f WHERE f.conference_id = c.id)`
        );
        for (const c of confsNoFields) await seedDefaultFields(c.id);
        // Every field name → a real inscriptions column (TEXT; SQLite is flexibly typed).
        const fieldNames = await db.all(`SELECT DISTINCT name FROM ${T.fields}`);
        const knownCols = new Set();
        for (const f of fieldNames) { if (isSafeColumn(f.name)) knownCols.add(f.name); await addColumnIfMissing(T.inscriptions, f.name, 'TEXT'); }
        // 4. Backfill legacy custom_data JSON into the new real columns (only where the column is still
        //    empty, so this never clobbers a later edit). Keeps existing attendees' data visible.
        const legacy = await db.all(`SELECT id, custom_data FROM ${T.inscriptions} WHERE custom_data IS NOT NULL AND custom_data != '' AND custom_data != '{}'`);
        for (const row of legacy) {
            let data; try { data = JSON.parse(row.custom_data); } catch { continue; }
            if (!data || typeof data !== 'object') continue;
            for (const [k, v] of Object.entries(data)) {
                if (!knownCols.has(k)) continue;
                await db.run(`UPDATE ${T.inscriptions} SET ${k} = ? WHERE id = ? AND (${k} IS NULL OR ${k} = '')`, [v == null ? '' : String(v), row.id]);
            }
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
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated') >= total_due THEN 'paid'
                    WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ${T.inscriptions}.id AND status = 'validated') > 0 THEN 'partial'
                    ELSE 'unpaid'
                END
        `);
    } catch (e) {
        console.warn('[conference-manager] data hygiene skipped:', e.message);
    }

    // ── shared helpers ───────────────────────────────────────────────────────────────────────────

    /**
     * Atomic payment recompute for one inscription. Recomputes amount_paid straight from the
     * payments ledger in a SINGLE statement, so two concurrent payment posts cannot lose an update
     * (there is no read-in-JS-then-write). The sandbox db bridge exposes no transaction primitive,
     * so this single-statement form is the correct way to stay race-free.
     */
    async function recomputePayment(inscriptionId) {
        await db.run(
            `UPDATE ${T.inscriptions}
             SET amount_paid = (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ? AND status = 'validated'),
                 payment_status = CASE
                     WHEN total_due <= 0 THEN 'paid'
                     WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ? AND status = 'validated') >= total_due THEN 'paid'
                     WHEN (SELECT COALESCE(SUM(amount), 0) FROM ${T.payments} WHERE inscription_id = ? AND status = 'validated') > 0 THEN 'partial'
                     ELSE 'unpaid'
                 END
             WHERE id = ?`,
            [inscriptionId, inscriptionId, inscriptionId, inscriptionId]
        );
    }

    /**
     * 6-digit access code. The sandbox's static validator blocks `globalThis`/crypto access and the
     * db bridge exposes no RNG, so webcrypto is unreachable here — brute force is instead bounded by
     * the per-location login throttle below (LOGIN_MAX attempts per window), which is the real
     * defense for a short numeric code regardless of the RNG.
     */
    function genAccessCode() {
        return String(Math.floor(100000 + Math.random() * 900000));
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

    // Serialize the auto-assigner: it loads occupancy into memory then writes in a loop, so two
    // concurrent runs (or a run racing a manual assign) would double-book. Chain them instead.
    let assignmentLock = Promise.resolve();
    const withAssignmentLock = (fn) => {
        const run = assignmentLock.then(fn, fn);
        assignmentLock = run.then(() => {}, () => {});
        return run;
    };

    // Accept '' / null (→ null) or a parseable date; throw on an unparseable non-empty string.
    const normDate = (v, label) => {
        if (v === undefined || v === null || v === '') return null;
        if (isNaN(new Date(v).getTime())) throw new Error(`Fecha inválida (${label})`);
        return v;
    };

    const MAX_PROOF_CHARS = 1500000; // ~1.1 MB decoded — a receipt photo, not a RAW file

    // ── dynamic pricing engine ───────────────────────────────────────────────────────────────────
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
    // Compute total_due from the conference base fee + its enabled rules (priority order). A 'set'
    // rule fixes the running total; an 'add' rule adjusts it. Never returns a negative amount.
    async function computeFee(conferenceId, values, feeDefault) {
        let total = Number(feeDefault) || 0;
        let rules;
        try { rules = await db.all(`SELECT * FROM ${T.feeRules} WHERE conference_id = ? AND enabled = 1 ORDER BY priority ASC, id ASC`, [conferenceId]); }
        catch { return total; }
        for (const r of rules) {
            if (!feeRuleMatches(r, values)) continue;
            const amt = Number(r.amount) || 0;
            total = (r.action === 'add') ? total + amt : amt;
        }
        return total < 0 ? 0 : total;
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
            const fee = Number(fee_default) || 0;
            if (fee < 0) return res.status(400).json({ error: 'La cuota no puede ser negativa.' });
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Update conference metadata (name/slug/dates/fee/description/status). Only the fields present
    // in the body are changed, so partial updates are safe.
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
                const fee = Number(fee_default) || 0;
                if (fee < 0) return res.status(400).json({ error: 'La cuota no puede ser negativa.' });
                sets.push('fee_default = ?'); params.push(fee);
            }
            if (description !== undefined) { sets.push('description = ?'); params.push(description || null); }
            if (status !== undefined) { sets.push('status = ?'); params.push(String(status)); }

            if (!sets.length) return res.json({ success: true });
            params.push(req.params.id);
            await db.run(`UPDATE ${T.conferences} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.conferences} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Inscriptions for a conference
    http.route('get', '/inscriptions', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, search, family_group, payment_status, assigned, location } = req.query;
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

            if (search) {
                // Search across every DEFINED field column (schema follows the form) + location.
                const flds = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [conference_id]);
                const cols = [...new Set([...flds.map(f => f.name).filter(isSafeColumn), 'location'])];
                const term = `%${search}%`;
                query += ` AND (` + cols.map(c => `i.${c} LIKE ?`).join(' OR ') + `)`;
                cols.forEach(() => params.push(term));
            }

            if (location) {
                query += ` AND i.location LIKE ?`;
                params.push(`%${location}%`);
            }

            if (family_group) {
                query += ` AND i.family_group = ?`;
                params.push(family_group);
            }

            if (payment_status) {
                query += ` AND i.payment_status = ?`;
                params.push(payment_status);
            }

            if (assigned === 'true') {
                query += ` AND i.room_id IS NOT NULL`;
            } else if (assigned === 'false') {
                query += ` AND i.room_id IS NULL`;
            }

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

            // Parse custom_data
            const parsedList = list.map(item => ({
                ...item,
                custom_data: typeof item.custom_data === 'string' ? JSON.parse(item.custom_data || '{}') : (item.custom_data || {})
            }));

            res.json(parsedList);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/publish', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, published } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            await db.run(`UPDATE ${T.conferences} SET is_form_published = ? WHERE id = ?`, [published ? 1 : 0, conference_id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === FIELDS ===
    http.route('get', '/fields', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT * FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/fields', { auth: true, admin: true }, async (req, res) => {
        const { id, conference_id, name, label, type, options, is_required, sort_order, width, is_group, is_unique } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        if (!String(label || '').trim()) return res.status(400).json({ error: 'La etiqueta del campo es obligatoria.' });
        try {
            // Normalize width to the two layouts the builder offers (100% / 50%).
            const w = Number(width) === 50 ? 50 : 100;
            // Generic per-field feature flags: ANY field can be the grouping field (is_group) or a
            // no-duplicates field (is_unique). Nothing is tied to a fixed column name anymore.
            const grp = is_group ? 1 : 0;
            const uniq = is_unique ? 1 : 0;
            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            // Exactly ONE field groups attendees per conference — clear the flag off the others first.
            if (grp) {
                if (id) await db.run(`UPDATE ${T.fields} SET is_group = 0 WHERE conference_id = ? AND id != ?`, [conference_id, id]);
                else await db.run(`UPDATE ${T.fields} SET is_group = 0 WHERE conference_id = ?`, [conference_id]);
            }
            if (id) {
                // Column name is immutable after creation; the flags + cosmetic attributes can change
                // anytime (they don't alter the column). Publish still freezes the field's type.
                if (conf?.is_form_published) {
                    const existing = await db.get(`SELECT type FROM ${T.fields} WHERE id = ?`, [id]);
                    if (existing && existing.type !== type) {
                        return res.status(400).json({ error: 'No se puede cambiar el tipo de un campo después de publicar el formulario.' });
                    }
                }
                await db.run(
                    `UPDATE ${T.fields} SET label = ?, type = ?, options = ?, is_required = ?, sort_order = ?, width = ?, is_group = ?, is_unique = ? WHERE id = ?`,
                    [label, type, options || '', is_required ? 1 : 0, sort_order || 0, w, grp, uniq, id]
                );
            } else {
                if (conf?.is_form_published) {
                    return res.status(400).json({ error: 'No se pueden añadir campos después de publicar el formulario.' });
                }
                // The registration form drives the schema: every field gets a safe column named after it
                // (or a generated fallback). Ensure the column exists, then insert the field row.
                const colName = isSafeColumn(name) ? name : ('f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
                await addColumnIfMissing(T.inscriptions, colName, 'TEXT');
                await db.run(
                    `INSERT INTO ${T.fields} (conference_id, name, label, type, options, is_required, sort_order, width, is_group, is_unique) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, colName, label, type, options || '', is_required ? 1 : 0, sort_order || 0, w, grp, uniq]
                );
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === FEE RULES (dynamic pricing) ===
    const FEE_OPERATORS = new Set(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'filled', 'empty', 'any']);

    http.route('get', '/fee-rules', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT * FROM ${T.feeRules} WHERE conference_id = ? ORDER BY priority ASC, id ASC`, [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/fee-rules', { auth: true, admin: true }, async (req, res) => {
        const { id, conference_id, label, field_name, operator, value, action, amount, priority, enabled } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        const op = FEE_OPERATORS.has(operator) ? operator : 'eq';
        const act = action === 'add' ? 'add' : 'set';
        const amt = Number(amount);
        if (!Number.isFinite(amt)) return res.status(400).json({ error: 'El monto de la regla es inválido.' });
        try {
            if (id) {
                await db.run(
                    `UPDATE ${T.feeRules} SET label = ?, field_name = ?, operator = ?, value = ?, action = ?, amount = ?, priority = ?, enabled = ? WHERE id = ?`,
                    [label || '', field_name || '', op, value == null ? '' : String(value), act, amt, Number(priority) || 0, enabled ? 1 : 0, id]
                );
            } else {
                await db.run(
                    `INSERT INTO ${T.feeRules} (conference_id, label, field_name, operator, value, action, amount, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, label || '', field_name || '', op, value == null ? '' : String(value), act, amt, Number(priority) || 0, enabled === undefined ? 1 : (enabled ? 1 : 0)]
                );
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('delete', '/fee-rules/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.feeRules} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Public price quote — the form/portal can show the live total before submitting. Returns only a
    // number (no PII). Only for a published conference.
    http.route('post', '/public/quote', async (req, res) => {
        const { conference_id, fields } = req.body || {};
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT fee_default, is_form_published FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf || !conf.is_form_published) return res.status(403).json({ error: 'Formulario no disponible.' });
            const total = await computeFee(conference_id, fields && typeof fields === 'object' ? fields : {}, conf.fee_default);
            res.json({ total });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Re-price EVERY inscription of a conference against the CURRENT base fee + rules. total_due is
    // normally frozen at registration; this applies rule/base-fee changes retroactively. amount_paid
    // (the payments ledger) is untouched — only total_due + the derived payment_status change.
    http.route('post', '/reprice', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.body || {};
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT fee_default FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
            const rows = await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ?`, [conference_id]);
            let updated = 0;
            for (const row of rows) {
                const fee = await computeFee(conference_id, row, conf.fee_default);
                if (Number(fee) !== Number(row.total_due)) {
                    await db.run(`UPDATE ${T.inscriptions} SET total_due = ? WHERE id = ?`, [fee, row.id]);
                    updated++;
                }
                // Always refresh payment_status — it can be stale even when total_due is unchanged
                // (e.g. a free/$0 fee with a prior payment should read 'paid', not 'partial').
                await recomputePayment(row.id);
            }
            res.json({ success: true, total: rows.length, updated });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Create Inscription
    http.route('post', '/inscriptions', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, ...fieldValues } = req.body;
        // Guard against a non-scalar conference_id (the old client arity bug shipped the whole form
        // object here) so we never insert a garbage row bound to '[object Object]'.
        const confId = Number(conference_id);
        if (!confId || !Number.isFinite(confId)) return res.status(400).json({ error: 'Missing or invalid conference_id' });

        try {
            const conf = await db.get(`SELECT fee_default FROM ${T.conferences} WHERE id = ?`, [confId]);
            if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });

            // The form is the source of truth: write each DEFINED field's value into its own column
            // (every field owns a real column). Values for keys that aren't defined fields are ignored.
            const confFields = await db.all(`SELECT name, label, is_unique FROM ${T.fields} WHERE conference_id = ?`, [confId]);
            const fieldNames = new Set(confFields.map(f => f.name));

            const values = { conference_id: confId };
            Object.keys(fieldValues).forEach(key => {
                if (key !== 'custom_data' && fieldNames.has(key) && isSafeColumn(key)) {
                    values[key] = fieldValues[key];
                }
            });

            // The admin explicitly PICKS the location (unlike the portal, which forces the coordinator's
            // own). It's an operational column, not a form field, so accept it separately here.
            if (typeof fieldValues.location === 'string' && fieldValues.location.trim()) values.location = fieldValues.location.trim();

            // first_name / last_name are NOT NULL — default to '' (no more 'Sin Nombre' placeholder);
            // the display name is whatever the form collects, not an assumed column.
            if (values.first_name == null) values.first_name = '';
            if (values.last_name == null) values.last_name = '';

            // Apply the fee (server-controlled) from the pricing rules + base fee, computed against
            // the attendee's field values — so the attendee isn't instantly 'paid' and tiered/rule
            // pricing takes effect.
            if (values.total_due === undefined || values.total_due === null || values.total_due === '') {
                values.total_due = await computeFee(confId, values, conf.fee_default);
            }

            // Duplicate guard: every field flagged "no duplicates" must be unique within the conference
            // (generic — the admin can mark any field, e.g. a document number or an email, as unique).
            for (const f of confFields) {
                if (!f.is_unique || !isSafeColumn(f.name)) continue;
                const v = values[f.name];
                if (v === undefined || v === null || v === '') continue;
                const dup = await db.get(
                    `SELECT id FROM ${T.inscriptions} WHERE conference_id = ? AND ${f.name} = ?`,
                    [confId, v]
                );
                if (dup) return res.status(409).json({ error: `Ya existe una inscripción con ese valor en «${f.label || f.name}» (campo sin duplicados).` });
            }

            const keys = Object.keys(values);
            const result = await db.run(
                `INSERT INTO ${T.inscriptions} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                Object.values(values)
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === LOCATIONS ===
    http.route('get', '/locations', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await db.get(`SELECT *, (SELECT COUNT(*) FROM ${T.fields} WHERE conference_id = ${T.conferences}.id) as fields_count FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            const locations = await db.all(`SELECT * FROM ${T.locations} WHERE conference_id = ? ORDER BY name`, [conference_id]);
            res.json({ locations, conference: conf });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/locations', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, name, responsible_name, responsible_phone } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        if (!String(name || '').trim()) return res.status(400).json({ error: 'El nombre de la localidad es obligatorio.' });

        const code = genAccessCode();
        try {
            const result = await db.run(
                `INSERT INTO ${T.locations} (conference_id, name, code, responsible_name, responsible_phone) VALUES (?, ?, ?, ?, ?)`,
                [conference_id, String(name).trim(), code, responsible_name || null, responsible_phone || null]
            );
            res.json({ success: true, id: result.lastID, code });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Update a location; pass rotate_code:true to issue a fresh access code (invalidates old sessions).
    http.route('put', '/locations/:id', { auth: true, admin: true }, async (req, res) => {
        const { name, responsible_name, responsible_phone, rotate_code } = req.body;
        try {
            const loc = await db.get(`SELECT * FROM ${T.locations} WHERE id = ?`, [req.params.id]);
            if (!loc) return res.status(404).json({ error: 'Localidad no encontrada.' });
            const sets = [], params = [];
            if (name !== undefined) {
                const v = String(name).trim();
                if (!v) return res.status(400).json({ error: 'El nombre de la localidad es obligatorio.' });
                sets.push('name = ?'); params.push(v);
            }
            if (responsible_name !== undefined) { sets.push('responsible_name = ?'); params.push(responsible_name || null); }
            if (responsible_phone !== undefined) { sets.push('responsible_phone = ?'); params.push(responsible_phone || null); }
            let newCode = null;
            if (rotate_code) { newCode = genAccessCode(); sets.push('code = ?'); params.push(newCode); }
            if (sets.length) {
                params.push(req.params.id);
                await db.run(`UPDATE ${T.locations} SET ${sets.join(', ')} WHERE id = ?`, params);
            }
            res.json({ success: true, code: newCode || loc.code });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('delete', '/locations/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.locations} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === HOTELS & ROOMS (full CRUD) ===
    http.route('post', '/hotels', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, name, address, description, capacity } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        if (!String(name || '').trim()) return res.status(400).json({ error: 'El nombre del hotel es obligatorio.' });
        try {
            const r = await db.run(`INSERT INTO ${T.hotels} (conference_id, name, address, description, capacity) VALUES (?, ?, ?, ?, ?)`,
                [conference_id, String(name).trim(), address || null, description || null, Number(capacity) || 0]);
            res.json({ success: true, id: r.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    http.route('delete', '/hotels/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            // Free any attendees assigned to this hotel's rooms before the FK cascade drops the rooms,
            // so occupancy counts stay honest.
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE room_id IN (SELECT id FROM ${T.rooms} WHERE hotel_id = ?)`, [req.params.id]);
            await db.run(`DELETE FROM ${T.hotels} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/rooms', { auth: true, admin: true }, async (req, res) => {
        const { hotel_id, room_number, capacity, gender, is_family, family_name, notes } = req.body;
        if (!hotel_id) return res.status(400).json({ error: 'Missing hotel_id' });
        if (!String(room_number || '').trim()) return res.status(400).json({ error: 'El número de habitación es obligatorio.' });
        try {
            const r = await db.run(`INSERT INTO ${T.rooms} (hotel_id, room_number, capacity, gender, is_family, family_name, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [hotel_id, String(room_number).trim(), Math.max(1, Number(capacity) || 1), gender || 'Mixed', is_family ? 1 : 0, family_name || null, notes || null]);
            res.json({ success: true, id: r.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    http.route('delete', '/rooms/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE room_id = ?`, [req.params.id]);
            await db.run(`DELETE FROM ${T.rooms} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === INSCRIPTIONS: edit / delete / manual room assignment ===
    http.route('put', '/inscriptions/:id', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, ...fieldValues } = req.body;
        try {
            const existing = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            if (!existing) return res.status(404).json({ error: 'Inscripción no encontrada.' });

            // Write each DEFINED field's value to its column (schema follows the form) + a couple of
            // operational edits the admin is allowed to change directly.
            const confFields = await db.all(`SELECT name FROM ${T.fields} WHERE conference_id = ?`, [existing.conference_id]);
            const editable = new Set(confFields.map(f => f.name));
            editable.add('total_due'); editable.add('status'); editable.add('notes'); editable.add('location');

            const sets = [], params = [];
            Object.keys(fieldValues).forEach(key => {
                if (key !== 'custom_data' && editable.has(key) && isSafeColumn(key)) {
                    sets.push(`${key} = ?`); params.push(fieldValues[key]);
                }
            });
            if (sets.length) {
                params.push(req.params.id);
                await db.run(`UPDATE ${T.inscriptions} SET ${sets.join(', ')} WHERE id = ?`, params);
            }
            // Re-price from the rules against the updated field values, unless the admin set total_due
            // explicitly (a field that drives pricing may have changed).
            if (fieldValues.total_due === undefined) {
                const updated = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
                const c = await db.get(`SELECT fee_default FROM ${T.conferences} WHERE id = ?`, [existing.conference_id]);
                const fee = await computeFee(existing.conference_id, updated, c ? c.fee_default : 0);
                await db.run(`UPDATE ${T.inscriptions} SET total_due = ? WHERE id = ?`, [fee, req.params.id]);
            }
            // total_due may have changed → keep payment_status coherent.
            await recomputePayment(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    http.route('delete', '/inscriptions/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === PAYMENTS: add / void ===
    http.route('post', '/inscriptions/:id/payments', { auth: true, admin: true }, async (req, res) => {
        const { amount, method, reference, proof } = req.body;
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
        if (!proof || !String(proof).trim()) return res.status(400).json({ error: 'El comprobante es obligatorio.' });
        if (String(proof).length > MAX_PROOF_CHARS) return res.status(400).json({ error: 'El comprobante es demasiado grande.' });
        try {
            const ins = await db.get(`SELECT id FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
            if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
            // New payments start 'pending' — an admin must validate before they count toward the balance.
            await db.run(`INSERT INTO ${T.payments} (inscription_id, amount, method, reference, proof, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
                [req.params.id, amt, method || null, reference || null, proof]);
            await recomputePayment(req.params.id); // validated-only recompute → pending doesn't count yet
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    http.route('delete', '/payments/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const pay = await db.get(`SELECT inscription_id FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            await db.run(`DELETE FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Validate / reject a payment (admin gate). Only a VALIDATED payment counts toward amount_paid.
    http.route('post', '/payments/:id/validate', { auth: true, admin: true }, async (req, res) => {
        try {
            const pay = await db.get(`SELECT inscription_id FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            await db.run(`UPDATE ${T.payments} SET status = 'validated' WHERE id = ?`, [req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    http.route('post', '/payments/:id/reject', { auth: true, admin: true }, async (req, res) => {
        try {
            const pay = await db.get(`SELECT inscription_id FROM ${T.payments} WHERE id = ?`, [req.params.id]);
            if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
            await db.run(`UPDATE ${T.payments} SET status = 'rejected' WHERE id = ?`, [req.params.id]);
            await recomputePayment(pay.inscription_id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('get', '/inscriptions/:id/payments', { auth: true, admin: true }, async (req, res) => {
        try {
            const list = await db.all(`SELECT * FROM ${T.payments} WHERE inscription_id = ? ORDER BY date DESC`, [req.params.id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
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
            res.json({ totals, byLocation, byGender });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // CSV roster export — honors the same filters as GET /inscriptions.
    http.route('get', '/inscriptions/export', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, search, family_group, payment_status, assigned, location } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Columns follow the form: one per defined field (its label), then payment + lodging.
            const flds = await db.all(`SELECT name, label FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            const safeFlds = flds.filter(f => isSafeColumn(f.name));

            let query = `
                SELECT i.*, r.room_number, h.name as hotel_name
                FROM ${T.inscriptions} i
                LEFT JOIN ${T.rooms} r ON i.room_id = r.id
                LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id
                WHERE i.conference_id = ?`;
            const params = [conference_id];
            if (search) {
                const cols = [...new Set([...safeFlds.map(f => f.name), 'location'])];
                const t = `%${search}%`;
                query += ` AND (` + cols.map(c => `i.${c} LIKE ?`).join(' OR ') + `)`;
                cols.forEach(() => params.push(t));
            }
            if (location) { query += ` AND i.location LIKE ?`; params.push(`%${location}%`); }
            if (family_group) { query += ` AND i.family_group = ?`; params.push(family_group); }
            if (payment_status) { query += ` AND i.payment_status = ?`; params.push(payment_status); }
            if (assigned === 'true') query += ` AND i.room_id IS NOT NULL`;
            else if (assigned === 'false') query += ` AND i.room_id IS NULL`;
            query += ` ORDER BY i.last_name, i.first_name`;
            const rows = await db.all(query, params);

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
            const header = cols.map(c => esc(c[1])).join(',');
            const body = rows.map(r => cols.map(c => esc(r[c[0]])).join(',')).join('\r\n');
            const csv = '﻿' + header + '\r\n' + body; // BOM so Excel reads UTF-8

            // NOTE: the sandbox's res.send() JSON-encodes string bodies (quotes + escaped newlines),
            // which corrupts raw CSV. Return the CSV as a JSON field and let the client build the file.
            res.json({ csv, filename: `inscripciones-${conference_id}.csv`, count: rows.length });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === ASSIGNMENT RULES ===
    http.route('get', '/assignment/rules', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? ORDER BY priority DESC`, [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/assignment/rules', { auth: true, admin: true }, async (req, res) => {
        const { id, conference_id, name, type, enabled, priority, config, params, hard } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // params is a JSON blob of the rule type's extra config — normalize to a string.
            const paramsStr = typeof params === 'string' ? params : JSON.stringify(params || {});
            const hardVal = hard ? 1 : 0;
            if (id) {
                // Verify the rule belongs to the specified conference before updating.
                const existing = await db.get(`SELECT conference_id FROM ${T.rules} WHERE id = ?`, [id]);
                if (!existing) return res.status(404).json({ error: 'Regla no encontrada.' });
                if (String(existing.conference_id) !== String(conference_id)) {
                    return res.status(403).json({ error: 'La regla no pertenece a esta conferencia.' });
                }
                await db.run(
                    `UPDATE ${T.rules} SET name = ?, type = ?, enabled = ?, priority = ?, config = ?, params = ?, hard = ? WHERE id = ?`,
                    [name, type, enabled, priority, config, paramsStr, hardVal, id]
                );
            } else {
                await db.run(
                    `INSERT INTO ${T.rules} (conference_id, name, type, enabled, priority, config, params, hard) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, name, type, enabled, priority, config, paramsStr, hardVal]
                );
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('delete', '/assignment/rules/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.rules} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/assignment/reset', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Serialize with runs so a reset can't interleave with an in-flight assignment.
            await withAssignmentLock(() => db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE conference_id = ?`, [conference_id]));
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/assignment/run', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Mutex: two concurrent runs (or a run racing a manual assign/reset) would double-book.
            const result = await withAssignmentLock(() => runAssignment(conference_id));
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
    // Optimal constrained assignment is NP-hard, so this is a documented greedy heuristic that RETURNS
    // { assignedCount, remaining, violations[] } naming whatever it could not satisfy.
    async function runAssignment(conferenceId) {
        const parseCd = (cd) => { if (typeof cd !== 'string') return cd || {}; try { return JSON.parse(cd || '{}'); } catch { return {}; } };

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

        const roomRows = await db.all(
            `SELECT r.*, h.name as hotel_name FROM ${T.rooms} r JOIN ${T.hotels} h ON r.hotel_id = h.id WHERE h.conference_id = ?`,
            [conferenceId]
        );
        const rooms = [];
        for (const r of roomRows) {
            const occ = (await db.all(`SELECT * FROM ${T.inscriptions} WHERE room_id = ?`, [r.id])).map(o => ({ ...o, custom_data: parseCd(o.custom_data) }));
            rooms.push({ id: r.id, capacity: Math.max(1, Number(r.capacity) || 1), room_number: r.room_number, hotel_name: r.hotel_name, occupants: occ });
        }

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

        const assignTo = async (room, person) => { await db.run(`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [room.id, person.id]); room.occupants.push(person); assignedCount++; };
        const moveTo = async (room, donor, person) => { await db.run(`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [room.id, person.id]); donor.occupants = donor.occupants.filter(o => o.id !== person.id); room.occupants.push(person); };

        const partitionBy = (people, fields) => {
            if (!fields.length) return [people];
            const map = new Map();
            for (const p of people) {
                const key = fields.map(f => { const v = val(p, f); return v == null ? '' : String(v).trim().toLowerCase(); }).join('');
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(p);
            }
            return [...map.values()];
        };

        const hardSepFields = separateRules.filter(r => r.hard).map(r => r.field);

        const placePartition = async (people) => {
            if (people.length === 0) return;
            const feasible = rooms.filter(room => (room.capacity - room.occupants.length) >= people.length && mergedSeparateOk(room.occupants, people));
            if (feasible.length) {
                feasible.sort((a, b) => score(b, people) - score(a, people));
                for (const p of [...people]) await assignTo(feasible[0], p);
                return;
            }
            if (people.length > 1) {
                // Divide along a configured split_by field first, then fall back to chunking.
                for (const sr of splitRules) {
                    const sub = partitionBy(people, [sr.field]);
                    if (sub.length > 1) { for (const s of sub) await placePartition(s); return; }
                }
                let target = null, freeMax = 0;
                for (const room of rooms) {
                    const free = room.capacity - room.occupants.length;
                    if (free >= 1 && free > freeMax && mergedSeparateOk(room.occupants, [people[0]])) { target = room; freeMax = free; }
                }
                if (target && freeMax >= 1) {
                    for (const p of people.slice(0, freeMax)) await assignTo(target, p);
                    if (keepRules.length) noteViol('keep_together', `Un grupo de ${people.length} no cupo junto y se dividió.`, false);
                    await placePartition(people.slice(freeMax));
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
            if (target) await assignTo(target, people[0]);
            // else: left unassigned → aggregated into the single capacity violation at the end.
        };

        // Hard separate_by forces a unit to divide along those fields before placement.
        const placeUnit = async (people) => { for (const part of partitionBy(people, hardSepFields)) await placePartition(part); };

        // Build placement units — highest-priority keep_together first; each member is claimed once.
        const claimed = new Set();
        const units = [];
        for (const rule of keepRules) {
            const groups = {};
            for (const p of participants) {
                if (claimed.has(p.id) || !cond(rule.params.when, p)) continue;
                const v = val(p, rule.field);
                if (v == null || String(v).trim() === '') continue;
                const k = String(v).trim();
                (groups[k] = groups[k] || []).push(p);
            }
            const min = Number(rule.params.min_size) || 1;
            for (const k in groups) { if (groups[k].length >= min) { units.push(groups[k]); groups[k].forEach(p => claimed.add(p.id)); } }
        }
        for (const p of participants) if (!claimed.has(p.id)) units.push([p]);

        // Larger units first, so families get contiguous space before individuals fill the rooms.
        units.sort((a, b) => b.length - a.length);
        for (const u of units) await placeUnit(u);

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
                        if (cand) { await moveTo(room, donor, cand); have++; moved = true; break; }
                    }
                    if (!moved) break;
                }
            }
        }

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
    // The portal session is a base64 `id:code` token. Under the sandbox the host NAMESPACES any cookie
    // the plugin sets — `wordjs_portal_token` is stored/returned as the namespaced cookie name below —
    // and forwards the `x-portal-token` header verbatim. Accept either. Returns the resolved location
    // row on success, or null on any failure (caller responds 401).
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
            const location = await db.get(`SELECT * FROM ${T.locations} WHERE id = ? AND code = ?`, [id, code]);
            if (!location) { noteLoginFailure(id); return null; }
            clearLoginFailures(id); // a valid token resets this location's failure counter
            return location;
        } catch (e) {
            return null;
        }
    }


    // === PUBLIC PORTAL API ===

    http.route('get', '/public/list', async (req, res) => {
        try {
            const list = await db.all(`SELECT id, name, slug, date_start, date_end, description, status, is_form_published FROM ${T.conferences} WHERE is_form_published = 1 ORDER BY id DESC`);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 2b. Get Fields for Portal (Public)
    http.route('get', '/public/fields', async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT name, label, type, options, is_required, width, is_group FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
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
            // Rate limit before touching the DB — bounds brute force of the 6-digit code per location.
            if (loginThrottled(location_id)) {
                return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
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
        } catch (e) { res.status(500).json({ error: e.message }); }
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

    // 5. Get Inscriptions for Location
    http.route('get', '/portal/inscriptions', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        try {
            const list = await db.all(`SELECT * FROM ${T.inscriptions} WHERE location = ? AND conference_id = ? ORDER BY first_name`, [location.name, location.conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
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
            const groupField = fields.find(f => f.is_group && isSafeColumn(f.name));
            if (!groupField) return res.json({ groups: [] });
            const gcol = groupField.name; // safe identifier (isSafeColumn-validated)
            // Display name = the first 1-2 non-grouping fields' values (mirrors the frontend helper).
            const nameFields = fields.filter(f => f.name !== gcol && isSafeColumn(f.name)).slice(0, 2);
            const rows = await db.all(
                `SELECT * FROM ${T.inscriptions} WHERE location = ? AND conference_id = ? AND ${gcol} IS NOT NULL AND ${gcol} != ''`,
                [location.name, location.conference_id]
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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 6. Create Inscription (Portal)
    http.route('post', '/portal/inscriptions', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const { ...fieldValues } = req.body;
        const conference_id = location.conference_id;

        try {
            const conf = await db.get(`SELECT is_form_published, fee_default, date_end FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario no está publicado.' });
            }
            // Registration window: once the event's end date has passed, the public form closes.
            // (No dedicated close-date column can be added — the sandbox blocks ALTER — so date_end
            //  is the gate; a full day of grace is allowed.)
            if (conf.date_end) {
                const closeAt = new Date(conf.date_end).getTime();
                if (Number.isFinite(closeAt) && Date.now() > closeAt + 24 * 60 * 60 * 1000) {
                    return res.status(403).json({ error: 'El período de inscripción para esta conferencia ya cerró.' });
                }
            }

            const values = {
                conference_id,
                location: location.name,          // server-controlled: the coordinator's own location
                status: 'pending'
            };
            // Columns the portal must never set from form input (server-controlled operational state).
            const protectedFields = new Set(['total_due', 'status', 'location', 'notes', 'conference_id', 'room_id', 'payment_status', 'amount_paid']);

            // Write each DEFINED form field to its own column (schema follows the form).
            const confFields = await db.all(`SELECT name, label, is_required, is_unique FROM ${T.fields} WHERE conference_id = ?`, [conference_id]);
            const fieldNames = new Set(confFields.map(f => f.name));
            Object.keys(fieldValues).forEach(key => {
                if (protectedFields.has(key)) return;
                if (fieldNames.has(key) && isSafeColumn(key)) values[key] = fieldValues[key];
            });

            // Enforce required fields SERVER-SIDE — is_required was only advisory on the public form, so a
            // client could omit a field that drives pricing and under-quote total_due (audit MEDIUM).
            for (const f of confFields) {
                if (!f.is_required || !isSafeColumn(f.name)) continue;
                const v = values[f.name];
                if (v === undefined || v === null || String(v).trim() === '') {
                    return res.status(400).json({ error: `El campo «${f.label || f.name}» es obligatorio.` });
                }
            }

            // Duplicate guard: a field flagged "no duplicates" must be unique — scoped to the coordinator's
            // OWN location. A conference-wide check turned the 409 into a cross-location probe oracle (a
            // coordinator could enumerate registrations in locations they don't manage) (audit LOW).
            for (const f of confFields) {
                if (!f.is_unique || !isSafeColumn(f.name)) continue;
                const v = values[f.name];
                if (v === undefined || v === null || v === '') continue;
                const dup = await db.get(`SELECT id FROM ${T.inscriptions} WHERE conference_id = ? AND location = ? AND ${f.name} = ?`, [conference_id, location.name, v]);
                if (dup) return res.status(409).json({ error: `Ya existe una inscripción con ese valor en «${f.label || f.name}» (campo sin duplicados).` });
            }

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
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 7. Bulk Payments (Portal)
    http.route('post', '/portal/payments/bulk', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const { inscription_ids, amount_per_person, method, reference, proof } = req.body;
        if (!inscription_ids || !Array.isArray(inscription_ids) || inscription_ids.length === 0) {
            return res.status(400).json({ error: 'Selecciona al menos una persona.' });
        }
        const amt = Number(amount_per_person);
        if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
        if (!proof || !String(proof).trim()) return res.status(400).json({ error: 'El comprobante es obligatorio.' });
        if (String(proof).length > MAX_PROOF_CHARS) return res.status(400).json({ error: 'El comprobante es demasiado grande.' });

        try {
            let applied = 0, skipped = 0;
            for (const id of inscription_ids) {
                // Verify inscription belongs to this location
                const ins = await db.get(`SELECT id FROM ${T.inscriptions} WHERE id = ? AND location = ? AND conference_id = ?`, [id, location.name, location.conference_id]);
                if (!ins) { skipped++; continue; }

                // Coordinator-recorded payments also start 'pending' — the admin validates the comprobante.
                await db.run(
                    `INSERT INTO ${T.payments} (inscription_id, amount, method, reference, proof, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
                    [id, amt, method || null, reference || null, proof]
                );
                await recomputePayment(id); // validated-only recompute → pending doesn't count yet
                applied++;
            }
            if (applied === 0) return res.status(400).json({ error: 'No se aplicó ningún pago (las personas seleccionadas no pertenecen a esta localidad).' });
            res.json({ success: true, applied, skipped });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === ADMIN MENU ===
    adminMenu.add({
        href: '/admin/plugin/conference-manager',
        label: 'Conference',
        icon: 'fa-users',
        order: 50,
        cap: 'manage_categories'
    });

    console.log('Conference Manager Plugin (Multi-Event, sandboxed) initialized.');
};

exports.deactivate = function () {
    console.log('Conference Manager plugin deactivated');
};
