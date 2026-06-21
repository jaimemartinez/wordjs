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
    version: '2.0.0',
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
    };

    /**
     * Initialize Database Schema (idempotent — CREATE TABLE IF NOT EXISTS via the bridge).
     *
     * Tables carry the FULL column set up-front (including columns the legacy plugin used to add via
     * ALTER, e.g. custom_data / document fields / responsible_phone / width / proof). PRAGMA,
     * information_schema and ALTER are all denied for sandboxed plugins, so there is no runtime
     * column-migration step; new installs always get the complete schema here.
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
            'age INT',
            'location TEXT',
            'document_type TEXT',
            'document_number TEXT',
            'blood_type TEXT',
            'eps TEXT',
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

        // 6. Payments
        await db.createTable(T.payments, [
            'id INT_PK',
            'inscription_id INT NOT NULL',
            'amount REAL NOT NULL',
            'date DATETIME DEFAULT CURRENT_TIMESTAMP',
            'method TEXT',
            'reference TEXT',
            'proof TEXT',
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`
        ]);

        // 7. Assignment Rules
        await db.createTable(T.rules, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'type TEXT NOT NULL',
            'enabled INT DEFAULT 1',
            'priority INT DEFAULT 0',
            'config TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`
        ]);

        // 8. Dynamic Fields
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

        // Seed a default conference if none exists.
        const count = await db.get(`SELECT COUNT(*) as count FROM ${T.conferences}`);
        if (!count || count.count === 0) {
            await db.run(
                `INSERT INTO ${T.conferences} (name, slug, status, description) VALUES (?, ?, ?, ?)`,
                ['Default Conference', 'default-conf', 'active', 'Initial system conference']
            );
        }
    }

    await initSchema();

    // === CONFERENCES MANAGEMENT ===
    http.route('get', '/list', { auth: true, admin: true }, async (req, res) => {
        const list = await db.all(`SELECT * FROM ${T.conferences} ORDER BY id DESC`);
        res.json(list);
    });

    http.route('post', '/create', { auth: true, admin: true }, async (req, res) => {
        const { name, slug, date_start, date_end, fee_default } = req.body;
        try {
            const result = await db.run(
                `INSERT INTO ${T.conferences} (name, slug, date_start, date_end, fee_default) VALUES (?, ?, ?, ?, ?)`,
                [name, slug, date_start, date_end, fee_default || 0]
            );
            const conference_id = result.lastID;

            // Seed default fields for the administrator to customize
            const defaults = [
                { name: 'first_name', label: 'Nombre', type: 'text', required: 1, order: 1 },
                { name: 'last_name', label: 'Apellido', type: 'text', required: 1, order: 2 },
                { name: 'gender', label: 'Género', type: 'select', options: 'M, F', required: 1, order: 3 },
                { name: 'email', label: 'Email', type: 'text', required: 0, order: 4 },
                { name: 'phone', label: 'Teléfono', type: 'text', required: 0, order: 5 },
                { name: 'location', label: 'Localidad', type: 'text', required: 0, order: 6 },
                { name: 'family_group', label: 'Grupo Familiar', type: 'text', required: 0, order: 7 },
            ];

            for (const f of defaults) {
                await db.run(
                    `INSERT INTO ${T.fields} (conference_id, name, label, type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, f.name, f.label, f.type, f.options || '', f.required, f.order]
                );
            }

            res.json({ success: true, id: conference_id });
        } catch (e) { res.status(500).json({ error: e.message }); }
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
                SELECT i.*, r.room_number, r.hotel_id, h.name as hotel_name
                FROM ${T.inscriptions} i
                LEFT JOIN ${T.rooms} r ON i.room_id = r.id
                LEFT JOIN ${T.hotels} h ON r.hotel_id = h.id
                WHERE i.conference_id = ?
            `;
            const params = [conference_id];

            if (search) {
                query += ` AND (i.first_name LIKE ? OR i.last_name LIKE ? OR i.email LIKE ? OR i.location LIKE ? OR i.document_number LIKE ?)`;
                const term = `%${search}%`;
                params.push(term, term, term, term, term);
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
        const { id, conference_id, name, label, type, options, is_required, sort_order } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Check if published
            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (conf?.is_form_published && !id) {
                return res.status(400).json({ error: 'No se pueden añadir campos después de publicar el formulario.' });
            }
            if (id) {
                await db.run(
                    `UPDATE ${T.fields} SET name = ?, label = ?, type = ?, options = ?, is_required = ?, sort_order = ? WHERE id = ?`,
                    [name, label, type, options, is_required, sort_order, id]
                );
            } else {
                await db.run(
                    `INSERT INTO ${T.fields} (conference_id, name, label, type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [conference_id, name, label, type, options, is_required, sort_order]
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

    // Create Inscription
    http.route('post', '/inscriptions', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, ...fieldValues } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            // Columns list from schema (for mapping dynamic fields to actual columns)
            const schemaColumns = [
                'first_name', 'last_name', 'gender', 'email', 'phone', 'age',
                'location', 'document_type', 'document_number', 'blood_type',
                'eps', 'family_group', 'total_due', 'notes'
            ];

            const values = { conference_id };
            const customData = { ...(fieldValues.custom_data || {}) };

            // Move values from fieldValues to columns if they match
            Object.keys(fieldValues).forEach(key => {
                if (key === 'custom_data') return;
                if (schemaColumns.includes(key)) {
                    values[key] = fieldValues[key];
                } else {
                    customData[key] = fieldValues[key];
                }
            });

            // Fallback for required fields if missing (e.g. if the user deleted the system fields from the visual builder)
            if (!values.first_name) values.first_name = 'Sin Nombre';
            if (!values.last_name) values.last_name = 'Sin Apellido';

            const keys = Object.keys(values);

            // Add custom_data
            keys.push('custom_data');
            const dataStr = typeof customData === 'string' ? customData : JSON.stringify(customData);
            const queryValues = [...Object.values(values), dataStr];

            const result = await db.run(
                `INSERT INTO ${T.inscriptions} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                queryValues
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

        // Generate random 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        try {
            const result = await db.run(
                `INSERT INTO ${T.locations} (conference_id, name, code, responsible_name, responsible_phone) VALUES (?, ?, ?, ?, ?)`,
                [conference_id, name, code, responsible_name, responsible_phone]
            );
            res.json({ success: true, id: result.lastID, code });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('delete', '/locations/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.locations} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Bridge for missing methods (compact for speed)
    http.route('post', '/hotels', { auth: true, admin: true }, async (req, res) => {
        const { conference_id, name, address, description, capacity } = req.body;
        const r = await db.run(`INSERT INTO ${T.hotels} (conference_id, name, address, description, capacity) VALUES (?, ?, ?, ?, ?)`, [conference_id, name, address, description, capacity]);
        res.json({ success: true, id: r.lastID });
    });
    http.route('post', '/rooms', { auth: true, admin: true }, async (req, res) => {
        const { hotel_id, room_number, capacity, gender, is_family, family_name, notes } = req.body;
        const r = await db.run(`INSERT INTO ${T.rooms} (hotel_id, room_number, capacity, gender, is_family, family_name, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`, [hotel_id, room_number, capacity, gender, is_family, family_name, notes]);
        res.json({ success: true, id: r.lastID });
    });
    http.route('post', '/inscriptions/:id/assign', { auth: true, admin: true }, async (req, res) => {
        await db.run(`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [req.body.room_id, req.params.id]);
        res.json({ success: true });
    });
    http.route('post', '/inscriptions/:id/payments', { auth: true, admin: true }, async (req, res) => {
        const { amount, method, reference, proof } = req.body;
        await db.run(`INSERT INTO ${T.payments} (inscription_id, amount, method, reference, proof) VALUES (?, ?, ?, ?, ?)`, [req.params.id, amount, method, reference, proof]);
        const total = await db.get(`SELECT SUM(amount) as s FROM ${T.payments} WHERE inscription_id = ?`, [req.params.id]);
        const p = await db.get(`SELECT total_due FROM ${T.inscriptions} WHERE id = ?`, [req.params.id]);
        const status = total.s >= (p?.total_due || 0) ? 'paid' : 'partial';
        await db.run(`UPDATE ${T.inscriptions} SET amount_paid = ?, payment_status = ? WHERE id = ?`, [total.s, status, req.params.id]);
        res.json({ success: true });
    });

    http.route('get', '/inscriptions/:id/payments', { auth: true, admin: true }, async (req, res) => {
        try {
            const list = await db.all(`SELECT * FROM ${T.payments} WHERE inscription_id = ? ORDER BY date DESC`, [req.params.id]);
            res.json(list);
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
        const { id, conference_id, name, type, enabled, priority, config } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            if (id) {
                await db.run(
                    `UPDATE ${T.rules} SET name = ?, type = ?, enabled = ?, priority = ?, config = ? WHERE id = ?`,
                    [name, type, enabled, priority, config, id]
                );
            } else {
                await db.run(
                    `INSERT INTO ${T.rules} (conference_id, name, type, enabled, priority, config) VALUES (?, ?, ?, ?, ?, ?)`,
                    [conference_id, name, type, enabled, priority, config]
                );
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/assignment/reset', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            await db.run(`UPDATE ${T.inscriptions} SET room_id = NULL WHERE conference_id = ?`, [conference_id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    http.route('post', '/assignment/run', { auth: true, admin: true }, async (req, res) => {
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const result = await runAssignment(conference_id);
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    /**
     * Helper: Run Auto-Assignment Logic
     */
    async function runAssignment(conferenceId) {
        // 1. Get enabled rules
        const rules = await db.all(`SELECT * FROM ${T.rules} WHERE conference_id = ? AND enabled = 1 ORDER BY priority DESC`, [conferenceId]);

        // 2. Get unassigned inscriptions
        let participantsData = await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND room_id IS NULL`, [conferenceId]);
        let participants = participantsData.map(p => ({
            ...p,
            custom_data: typeof p.custom_data === 'string' ? JSON.parse(p.custom_data || '{}') : (p.custom_data || {})
        }));

        // 3. Get all rooms with current occupancy and hotel context
        const query = `
            SELECT r.*, h.name as hotel_name,
            (SELECT COUNT(*) FROM ${T.inscriptions} i WHERE i.room_id = r.id) as occupied
            FROM ${T.rooms} r
            JOIN ${T.hotels} h ON r.hotel_id = h.id
            WHERE h.conference_id = ?
        `;
        let rooms = await db.all(query, [conferenceId]);

        let assignedCount = 0;
        const roomConstraints = {}; // room_id -> inscription_template

        // Initialize room constraints from already occupied rooms
        for (const r of rooms) {
            if (r.occupied > 0) {
                const first = await db.get(`SELECT * FROM ${T.inscriptions} WHERE room_id = ? LIMIT 1`, [r.id]);
                if (first) {
                    first.custom_data = typeof first.custom_data === 'string' ? JSON.parse(first.custom_data || '{}') : (first.custom_data || {});
                    roomConstraints[r.id] = first;
                }
            }
        }

        // Helper to get field value (handling custom fields)
        const getFieldValue = (p, field) => {
            if (p[field] !== undefined) return p[field];
            return p.custom_data ? p.custom_data[field] : undefined;
        };

        // Helper to check if a room matches all exclusive rules for a given participant/group
        const matchesExclusiveRules = (room, participant) => {
            const exclusiveRules = rules.filter(r => r.type === 'exclusive');
            for (const rule of exclusiveRules) {
                const field = rule.config; // The field name (gender, location, etc)
                const roomVal = roomConstraints[room.id] ? getFieldValue(roomConstraints[room.id], field) : null;
                const pVal = getFieldValue(participant, field);
                if (roomVal !== null && roomVal !== pVal) {
                    return false;
                }
            }
            return true;
        };

        // Pass 1: Handle Grouping Rules (High priority first)
        const groupingRules = rules.filter(r => r.type === 'group_together');
        for (const rule of groupingRules) {
            const field = rule.config;
            const groups = {};

            participants.forEach(p => {
                const val = getFieldValue(p, field);
                if (val) {
                    if (!groups[val]) groups[val] = [];
                    groups[val].push(p);
                }
            });

            const exclusiveFields = rules.filter(r => r.type === 'exclusive').map(r => r.config);

            for (const val in groups) {
                const group = groups[val];
                const needed = group.length;

                // A group can only share a room if ALL members agree on every exclusive field.
                // Otherwise co-placing them would violate an exclusive rule for some member —
                // skip the group here and let Pass 2 assign them individually.
                const groupAgrees = exclusiveFields.every(field => {
                    const first = getFieldValue(group[0], field);
                    return group.every(m => getFieldValue(m, field) === first);
                });
                if (!groupAgrees) continue;

                // All members agree, so checking against any member (group[0]) is valid for the whole group.
                const targetRoom = rooms.find(r =>
                    (r.capacity - r.occupied) >= needed && matchesExclusiveRules(r, group[0])
                );

                if (targetRoom) {
                    for (const member of group) {
                        await db.run(`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [targetRoom.id, member.id]);
                        targetRoom.occupied++;
                        roomConstraints[targetRoom.id] = member;
                        assignedCount++;
                    }
                    // Filter out assigned
                    const groupIds = group.map(m => m.id);
                    participants = participants.filter(p => !groupIds.includes(p.id));
                }
            }
        }

        // Pass 2: Individual assignment for remaining participants
        for (const p of participants) {
            const targetRoom = rooms.find(r =>
                r.occupied < r.capacity && matchesExclusiveRules(r, p)
            );

            if (targetRoom) {
                await db.run(`UPDATE ${T.inscriptions} SET room_id = ? WHERE id = ?`, [targetRoom.id, p.id]);
                targetRoom.occupied++;
                roomConstraints[targetRoom.id] = p;
                assignedCount++;
            }
        }

        return { assignedCount };
    }


    // === PORTAL AUTH HELPER ===
    // The portal session is a base64 `id:code` token. Under the sandbox the host NAMESPACES any cookie
    // the plugin sets — `wordjs_portal_token` is stored/returned as the namespaced cookie name below —
    // and forwards the `x-portal-token` header verbatim. Accept either. Returns the resolved location
    // row on success, or null on any failure (caller responds 401).
    const PORTAL_COOKIE = `${db.tablePrefix}wordjs_portal_token`; // host-namespaced cookie name
    async function resolvePortalLocation(req) {
        const cookies = req.cookies || {};
        let token = cookies[PORTAL_COOKIE] || cookies.wordjs_portal_token || (req.headers && req.headers['x-portal-token']);
        if (!token) return null;
        try {
            const decoded = atob(token);
            const [id, code] = decoded.split(':');
            const location = await db.get(`SELECT * FROM ${T.locations} WHERE id = ? AND code = ?`, [id, code]);
            if (!location) return null;
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
            // Only return necessary info for login selection
            const list = await db.all(`SELECT id, name, responsible_name FROM ${T.locations} WHERE conference_id = ? ORDER BY name`, [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 2b. Get Fields for Portal (Public)
    http.route('get', '/public/fields', async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await db.all(`SELECT name, label, type, options, is_required, width FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC`, [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 3. Login
    http.route('post', '/portal/login', async (req, res) => {
        const { location_id, code } = req.body;
        try {
            const location = await db.get(`SELECT * FROM ${T.locations} WHERE id = ?`, [location_id]);
            if (!location) return res.status(404).json({ error: 'Location not found' });

            const conf = await db.get(`SELECT is_form_published FROM ${T.conferences} WHERE id = ?`, [location.conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario de esta conferencia no está publicado.' });
            }

            // Simple code check
            if (String(location.code) !== String(code)) {
                return res.status(401).json({ error: 'Invalid code' });
            }

            // Create a simple session token (id:code base64 encoded)
            const token = btoa(`${location.id}:${location.code}`);

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
        res.json(location);
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

    // 6. Create Inscription (Portal)
    http.route('post', '/portal/inscriptions', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const { ...fieldValues } = req.body;
        const conference_id = location.conference_id;

        try {
            const conf = await db.get(`SELECT is_form_published, fee_default FROM ${T.conferences} WHERE id = ?`, [conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario no está publicado.' });
            }

            const schemaColumns = [
                'first_name', 'last_name', 'gender', 'email', 'phone', 'age',
                'location', 'document_type', 'document_number', 'blood_type',
                'eps', 'family_group', 'total_due', 'notes'
            ];

            const values = {
                conference_id,
                location: location.name,
                total_due: conf.fee_default || 0,
                status: 'pending'
            };
            const customData = {};

            Object.keys(fieldValues).forEach(key => {
                if (schemaColumns.includes(key)) {
                    values[key] = fieldValues[key];
                } else {
                    customData[key] = fieldValues[key];
                }
            });

            const keys = Object.keys(values);
            keys.push('custom_data');
            const dataStr = JSON.stringify(customData);
            const queryValues = [...Object.values(values), dataStr];

            const result = await db.run(
                `INSERT INTO ${T.inscriptions} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                queryValues
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 7. Bulk Payments (Portal)
    http.route('post', '/portal/payments/bulk', async (req, res) => {
        const location = await resolvePortalLocation(req);
        if (!location) return res.status(401).json({ error: 'No token' });
        const { inscription_ids, amount_per_person, method, reference, proof } = req.body;
        if (!inscription_ids || !Array.isArray(inscription_ids)) return res.status(400).json({ error: 'Missing inscription_ids' });

        try {
            for (const id of inscription_ids) {
                // Verify inscription belongs to this location
                const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND location = ? AND conference_id = ?`, [id, location.name, location.conference_id]);
                if (!ins) continue;

                await db.run(
                    `INSERT INTO ${T.payments} (inscription_id, amount, method, reference, proof) VALUES (?, ?, ?, ?, ?)`,
                    [id, amount_per_person, method, reference, proof]
                );

                // Update inscription totals
                const total = await db.get(`SELECT SUM(amount) as s FROM ${T.payments} WHERE inscription_id = ?`, [id]);
                const status = total.s >= (ins.total_due || 0) ? 'paid' : 'partial';
                await db.run(`UPDATE ${T.inscriptions} SET amount_paid = ?, payment_status = ? WHERE id = ?`, [total.s, status, id]);
            }
            res.json({ success: true });
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
