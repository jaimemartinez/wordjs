const express = require('express');
const { dbAsync, createPluginTable, getDbType } = require('../../src/config/database');
const { authenticate } = require('../../src/middleware/auth');
const { isAdmin } = require('../../src/middleware/permissions');
const config = require('../../src/config/app');

exports.metadata = {
    name: 'Conference Manager',
    version: '1.2.0',
    description: 'Manage multiple conference inscriptions, payments, and lodging assignments.',
    author: 'WordJS'
};

/**
 * Initialize Database Schema (Multi-Conference Ready)
 */
async function initSchema() {
    const { isPostgres } = getDbType();

    // 1. Conferences Table
    await createPluginTable('conferences', [
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

    // Locations
    await createPluginTable('conference_locations', [
        'id INT_PK',
        'conference_id INT NOT NULL',
        'name TEXT NOT NULL',
        'code TEXT NOT NULL',
        'responsible_name TEXT',
        'responsible_phone TEXT',
        'FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE CASCADE'
    ]);

    // 2. Hotels (Linked to Conference)
    await createPluginTable('conference_hotels', [
        'id INT_PK',
        'conference_id INT NOT NULL',
        'name TEXT NOT NULL',
        'address TEXT',
        'description TEXT',
        'capacity INT DEFAULT 0',
        'FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE CASCADE'
    ]);

    // 3. Rooms
    await createPluginTable('conference_rooms', [
        'id INT_PK',
        'hotel_id INT NOT NULL',
        'room_number TEXT NOT NULL',
        'capacity INT DEFAULT 2',
        'gender TEXT DEFAULT \'Mixed\'',
        'is_family INT DEFAULT 0',
        'family_name TEXT',
        'notes TEXT',
        'FOREIGN KEY (hotel_id) REFERENCES conference_hotels(id) ON DELETE CASCADE'
    ]);

    // 4. Inscriptions (Linked to Conference)
    await createPluginTable('conference_inscriptions', [
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
        'registration_date DATETIME DEFAULT CURRENT_TIMESTAMP',
        'status TEXT DEFAULT \'pending\'',
        'payment_status TEXT DEFAULT \'unpaid\'',
        'total_due REAL DEFAULT 0',
        'amount_paid REAL DEFAULT 0',
        'room_id INT',
        'notes TEXT',
        'FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE CASCADE',
        'FOREIGN KEY (room_id) REFERENCES conference_rooms(id) ON DELETE SET NULL'
    ]);

    // 5. Payments
    await createPluginTable('conference_payments', [
        'id INT_PK',
        'inscription_id INT NOT NULL',
        'amount REAL NOT NULL',
        'date DATETIME DEFAULT CURRENT_TIMESTAMP',
        'method TEXT',
        'reference TEXT',
        'proof TEXT',
        'FOREIGN KEY (inscription_id) REFERENCES conference_inscriptions(id) ON DELETE CASCADE'
    ]);

    // 6. Assignment Rules
    await createPluginTable('conference_assignment_rules', [
        'id INT_PK',
        'conference_id INT NOT NULL',
        'name TEXT NOT NULL',
        'type TEXT NOT NULL',
        'enabled INT DEFAULT 1',
        'priority INT DEFAULT 0',
        'config TEXT',
        'FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE CASCADE'
    ]);

    // 7. Dynamic Fields
    await createPluginTable('conference_fields', [
        'id INT_PK',
        'conference_id INT NOT NULL',
        'name TEXT NOT NULL',
        'label TEXT NOT NULL',
        'type TEXT DEFAULT \'text\'',
        'options TEXT',
        'is_required INT DEFAULT 0',
        'sort_order INT DEFAULT 0',
        'width INT DEFAULT 100',
        'FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE CASCADE'
    ]);

    // Migration: Add missing columns to existing tables
    // Compatible with both SQLite and PostgreSQL
    try {
        const { isPostgres } = getDbType();

        // Helper function to check if column exists (driver-agnostic)
        async function columnExists(tableName, columnName) {
            if (isPostgres) {
                const result = await dbAsync.get(
                    `SELECT COUNT(*) as count FROM information_schema.columns 
                     WHERE table_name = ? AND column_name = ?`,
                    [tableName, columnName]
                );
                return result.count > 0;
            } else {
                // SQLite - PRAGMA doesn't support parameters, but tableName is from our code, not user input
                const result = await dbAsync.all(`PRAGMA table_info(${tableName})`);
                return result.some(col => col.name === columnName);
            }
        }

        // Check if conference_locations exists
        let locationsTableExists = false;
        try {
            if (isPostgres) {
                const result = await dbAsync.get(
                    `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = ?`,
                    ['conference_locations']
                );
                locationsTableExists = result.count > 0;
            } else {
                await dbAsync.get('SELECT 1 FROM conference_locations LIMIT 1');
                locationsTableExists = true;
            }
        } catch (e) {
            locationsTableExists = false;
        }

        if (!locationsTableExists) {
            console.log('🔄 Migrating: Creating conference_locations table...');
            await createPluginTable('conference_locations', [
                'id INT_PK',
                'conference_id INT NOT NULL',
                'name TEXT NOT NULL',
                'code TEXT NOT NULL',
                'responsible_name TEXT',
                'responsible_phone TEXT',
                'FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE CASCADE'
            ]);
        } else {
            // Check for responsible_phone column
            const hasPhone = await columnExists('conference_locations', 'responsible_phone');
            if (!hasPhone) {
                console.log('🔄 Migrating conference_locations: adding responsible_phone column...');
                await dbAsync.run('ALTER TABLE conference_locations ADD COLUMN responsible_phone TEXT');
            }
        }

        // Migrate document fields if missing
        const hasDocumentType = await columnExists('conference_inscriptions', 'document_type');
        if (!hasDocumentType) {
            console.log('🔄 Migrating conference_inscriptions: adding document fields...');
            await dbAsync.run('ALTER TABLE conference_inscriptions ADD COLUMN document_type TEXT');
            await dbAsync.run('ALTER TABLE conference_inscriptions ADD COLUMN document_number TEXT');
            await dbAsync.run('ALTER TABLE conference_inscriptions ADD COLUMN blood_type TEXT');
            await dbAsync.run('ALTER TABLE conference_inscriptions ADD COLUMN eps TEXT');
        }

        // Migrate custom_data if missing
        const hasCustomData = await columnExists('conference_inscriptions', 'custom_data');
        if (!hasCustomData) {
            console.log('🔄 Migrating conference_inscriptions: adding custom_data column...');
            await dbAsync.run('ALTER TABLE conference_inscriptions ADD COLUMN custom_data TEXT');
        }

        // Migrate is_form_published if missing
        const hasFormPublished = await columnExists('conferences', 'is_form_published');
        if (!hasFormPublished) {
            console.log('🔄 Migrating conferences: adding is_form_published column...');
            await dbAsync.run('ALTER TABLE conferences ADD COLUMN is_form_published INT DEFAULT 0');
        }

        // Check if conference_hotels exists but lacks conference_id
        let hotelsTableExists = false;
        try {
            if (isPostgres) {
                const result = await dbAsync.get(
                    `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = ?`,
                    ['conference_hotels']
                );
                hotelsTableExists = result.count > 0;
            } else {
                await dbAsync.get('SELECT 1 FROM conference_hotels LIMIT 1');
                hotelsTableExists = true;
            }
        } catch (e) {
            hotelsTableExists = false;
        }

        if (hotelsTableExists) {
            const hotelsHasConferenceId = await columnExists('conference_hotels', 'conference_id');
            if (!hotelsHasConferenceId) {
                console.log('🔄 Migrating conference_hotels: adding conference_id column...');
                await dbAsync.run('ALTER TABLE conference_hotels ADD COLUMN conference_id INTEGER');
                const defaultConf = await dbAsync.get('SELECT id FROM conferences LIMIT 1');
                if (defaultConf) {
                    await dbAsync.run(
                        'UPDATE conference_hotels SET conference_id = ? WHERE conference_id IS NULL',
                        [defaultConf.id]
                    );
                }
            }
        }

        // Migrate conference_fields: add width if missing
        const hasWidth = await columnExists('conference_fields', 'width');
        if (!hasWidth) {
            console.log('🔄 Migrating conference_fields: adding width column...');
            await dbAsync.run('ALTER TABLE conference_fields ADD COLUMN width INT DEFAULT 100');
        }

        // Migrate conference_payments: add proof if missing
        const hasProof = await columnExists('conference_payments', 'proof');
        if (!hasProof) {
            console.log('🔄 Migrating conference_payments: adding proof column...');
            await dbAsync.run('ALTER TABLE conference_payments ADD COLUMN proof TEXT');
        }
    } catch (e) {
        // Table might not exist yet, which is fine
        console.log('Migration check:', e.message);
    }

    // Create a default conference if none exists
    const count = await dbAsync.get('SELECT COUNT(*) as count FROM conferences');
    if (count.count === 0) {
        await dbAsync.run(
            "INSERT INTO conferences (name, slug, status, description) VALUES (?, ?, ?, ?)",
            ['Default Conference', 'default-conf', 'active', 'Initial system conference']
        );
    }
}

exports.init = async function () {
    console.log('🔌 Loading Conference Manager Plugin...');
    console.log('Initializing Conference Manager Plugin (Multi-Event Edition)...');
    await initSchema();

    // Ensure foreign keys are enabled for SQLite
    const { isPostgres } = getDbType();
    if (!isPostgres) {
        await dbAsync.run('PRAGMA foreign_keys = ON');
    }

    const router = express.Router();

    // === CONFERENCES MANAGEMENT ===
    router.get('/list', authenticate, isAdmin, async (req, res) => {
        const list = await dbAsync.all('SELECT * FROM conferences ORDER BY id DESC');
        res.json(list);
    });

    router.post('/create', authenticate, isAdmin, async (req, res) => {
        const { name, slug, date_start, date_end, fee_default } = req.body;
        try {
            const result = await dbAsync.run(
                'INSERT INTO conferences (name, slug, date_start, date_end, fee_default) VALUES (?, ?, ?, ?, ?)',
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
                await dbAsync.run(
                    'INSERT INTO conference_fields (conference_id, name, label, type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [conference_id, f.name, f.label, f.type, f.options || '', f.required, f.order]
                );
            }

            res.json({ success: true, id: conference_id });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/:id', authenticate, isAdmin, async (req, res) => {
        try {
            await dbAsync.run('DELETE FROM conferences WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === DATA SEGMENTATION (requires conference_id in query/body) ===

    // Hotels for a conference
    router.get('/hotels', authenticate, isAdmin, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            const hotels = await dbAsync.all('SELECT * FROM conference_hotels WHERE conference_id = ? ORDER BY name', [conference_id]);
            for (const h of hotels) {
                const rooms = await dbAsync.all('SELECT * FROM conference_rooms WHERE hotel_id = ?', [h.id]);
                h.rooms = rooms;
                for (const r of rooms) {
                    const occupants = await dbAsync.get('SELECT COUNT(*) as count FROM conference_inscriptions WHERE room_id = ?', [r.id]);
                    r.occupied = occupants.count;
                }
            }
            res.json(hotels);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Inscriptions for a conference
    router.get('/inscriptions', authenticate, isAdmin, async (req, res) => {
        const { conference_id, search, family_group, payment_status, assigned, location } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            let query = `
                SELECT i.*, r.room_number, r.hotel_id, h.name as hotel_name 
                FROM conference_inscriptions i
                LEFT JOIN conference_rooms r ON i.room_id = r.id
                LEFT JOIN conference_hotels h ON r.hotel_id = h.id
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
            const list = await dbAsync.all(query, params);

            // Parse custom_data
            const parsedList = list.map(item => ({
                ...item,
                custom_data: typeof item.custom_data === 'string' ? JSON.parse(item.custom_data || '{}') : (item.custom_data || {})
            }));

            res.json(parsedList);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/publish', authenticate, isAdmin, async (req, res) => {
        const { conference_id, published } = req.body;
        try {
            await dbAsync.run('UPDATE conferences SET is_form_published = ? WHERE id = ?', [published ? 1 : 0, conference_id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === FIELDS ===
    router.get('/fields', authenticate, isAdmin, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await dbAsync.all('SELECT * FROM conference_fields WHERE conference_id = ? ORDER BY sort_order ASC', [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/fields', authenticate, isAdmin, async (req, res) => {
        const { id, conference_id, name, label, type, options, is_required, sort_order } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            // Check if published
            const conf = await dbAsync.get('SELECT is_form_published FROM conferences WHERE id = ?', [conference_id]);
            if (conf?.is_form_published && !id) {
                return res.status(400).json({ error: 'No se pueden añadir campos después de publicar el formulario.' });
            }
            if (id) {
                await dbAsync.run(
                    'UPDATE conference_fields SET name = ?, label = ?, type = ?, options = ?, is_required = ?, sort_order = ? WHERE id = ?',
                    [name, label, type, options, is_required, sort_order, id]
                );
            } else {
                await dbAsync.run(
                    'INSERT INTO conference_fields (conference_id, name, label, type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [conference_id, name, label, type, options, is_required, sort_order]
                );
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/fields/:id', authenticate, isAdmin, async (req, res) => {
        try {
            const field = await dbAsync.get('SELECT conference_id FROM conference_fields WHERE id = ?', [req.params.id]);
            if (field) {
                const conf = await dbAsync.get('SELECT is_form_published FROM conferences WHERE id = ?', [field.conference_id]);
                if (conf?.is_form_published) {
                    return res.status(400).json({ error: 'No se pueden eliminar campos después de publicar el formulario.' });
                }
            }
            await dbAsync.run('DELETE FROM conference_fields WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Create Inscription
    router.post('/inscriptions', authenticate, isAdmin, async (req, res) => {
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

            const keys = Object.keys(values);
            const placeholders = keys.map(() => '?').join(', ');

            // Add custom_data
            keys.push('custom_data');
            const dataStr = typeof customData === 'string' ? customData : JSON.stringify(customData);
            const queryValues = [...Object.values(values), dataStr];

            const result = await dbAsync.run(
                `INSERT INTO conference_inscriptions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                queryValues
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ... (rest of methods: post hotels, post rooms, assign, payments - all using conference_id context)

    // === LOCATIONS ===
    router.get('/locations', authenticate, isAdmin, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await dbAsync.get('SELECT *, (SELECT COUNT(*) FROM conference_fields WHERE conference_id = conferences.id) as fields_count FROM conferences WHERE id = ?', [conference_id]);
            const locations = await dbAsync.all('SELECT * FROM conference_locations WHERE conference_id = ? ORDER BY name', [conference_id]);
            res.json({ locations, conference: conf });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/locations', authenticate, isAdmin, async (req, res) => {
        const { conference_id, name, responsible_name, responsible_phone } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        // Generate random 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        try {
            const result = await dbAsync.run(
                'INSERT INTO conference_locations (conference_id, name, code, responsible_name, responsible_phone) VALUES (?, ?, ?, ?, ?)',
                [conference_id, name, code, responsible_name, responsible_phone]
            );
            res.json({ success: true, id: result.lastID, code });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/locations/:id', authenticate, isAdmin, async (req, res) => {
        try {
            await dbAsync.run('DELETE FROM conference_locations WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Bridge for missing methods (compact for speed)
    router.post('/hotels', authenticate, isAdmin, async (req, res) => {
        const { conference_id, name, address, description, capacity } = req.body;
        const r = await dbAsync.run('INSERT INTO conference_hotels (conference_id, name, address, description, capacity) VALUES (?, ?, ?, ?, ?)', [conference_id, name, address, description, capacity]);
        res.json({ success: true, id: r.lastID });
    });
    router.post('/rooms', authenticate, isAdmin, async (req, res) => {
        const { hotel_id, room_number, capacity, gender, is_family, family_name, notes } = req.body;
        const r = await dbAsync.run('INSERT INTO conference_rooms (hotel_id, room_number, capacity, gender, is_family, family_name, notes) VALUES (?, ?, ?, ?, ?, ?, ?)', [hotel_id, room_number, capacity, gender, is_family, family_name, notes]);
        res.json({ success: true, id: r.lastID });
    });
    router.post('/inscriptions/:id/assign', authenticate, isAdmin, async (req, res) => {
        await dbAsync.run('UPDATE conference_inscriptions SET room_id = ? WHERE id = ?', [req.body.room_id, req.params.id]);
        res.json({ success: true });
    });
    router.post('/inscriptions/:id/payments', authenticate, isAdmin, async (req, res) => {
        const { amount, method, reference, proof } = req.body;
        await dbAsync.run('INSERT INTO conference_payments (inscription_id, amount, method, reference, proof) VALUES (?, ?, ?, ?, ?)', [req.params.id, amount, method, reference, proof]);
        const total = await dbAsync.get('SELECT SUM(amount) as s FROM conference_payments WHERE inscription_id = ?', [req.params.id]);
        const p = await dbAsync.get('SELECT total_due FROM conference_inscriptions WHERE id = ?', [req.params.id]);
        const status = total.s >= (p?.total_due || 0) ? 'paid' : 'partial';
        await dbAsync.run('UPDATE conference_inscriptions SET amount_paid = ?, payment_status = ? WHERE id = ?', [total.s, status, req.params.id]);
        res.json({ success: true });
    });

    router.get('/inscriptions/:id/payments', authenticate, isAdmin, async (req, res) => {
        try {
            const list = await dbAsync.all('SELECT * FROM conference_payments WHERE inscription_id = ? ORDER BY date DESC', [req.params.id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === ASSIGNMENT RULES ===
    router.get('/assignment/rules', authenticate, isAdmin, async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await dbAsync.all('SELECT * FROM conference_assignment_rules WHERE conference_id = ? ORDER BY priority DESC', [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/assignment/rules', authenticate, isAdmin, async (req, res) => {
        const { id, conference_id, name, type, enabled, priority, config } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            if (id) {
                await dbAsync.run(
                    'UPDATE conference_assignment_rules SET name = ?, type = ?, enabled = ?, priority = ?, config = ? WHERE id = ?',
                    [name, type, enabled, priority, config, id]
                );
            } else {
                await dbAsync.run(
                    'INSERT INTO conference_assignment_rules (conference_id, name, type, enabled, priority, config) VALUES (?, ?, ?, ?, ?, ?)',
                    [conference_id, name, type, enabled, priority, config]
                );
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/assignment/reset', authenticate, isAdmin, async (req, res) => {
        const { conference_id } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            await dbAsync.run('UPDATE conference_inscriptions SET room_id = NULL WHERE conference_id = ?', [conference_id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/assignment/run', authenticate, isAdmin, async (req, res) => {
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
        const rules = await dbAsync.all('SELECT * FROM conference_assignment_rules WHERE conference_id = ? AND enabled = 1 ORDER BY priority DESC', [conferenceId]);

        // 2. Get unassigned inscriptions
        let participantsData = await dbAsync.all('SELECT * FROM conference_inscriptions WHERE conference_id = ? AND room_id IS NULL', [conferenceId]);
        let participants = participantsData.map(p => ({
            ...p,
            custom_data: typeof p.custom_data === 'string' ? JSON.parse(p.custom_data || '{}') : (p.custom_data || {})
        }));

        // 3. Get all rooms with current occupancy and hotel context
        const query = `
            SELECT r.*, h.name as hotel_name, 
            (SELECT COUNT(*) FROM conference_inscriptions i WHERE i.room_id = r.id) as occupied
            FROM conference_rooms r
            JOIN conference_hotels h ON r.hotel_id = h.id
            WHERE h.conference_id = ?
        `;
        let rooms = await dbAsync.all(query, [conferenceId]);

        let assignedCount = 0;
        const roomConstraints = {}; // room_id -> inscription_template

        // Initialize room constraints from already occupied rooms
        for (const r of rooms) {
            if (r.occupied > 0) {
                const first = await dbAsync.get('SELECT * FROM conference_inscriptions WHERE room_id = ? LIMIT 1', [r.id]);
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

            for (const val in groups) {
                const group = groups[val];
                const needed = group.length;

                // Find room for the whole group
                const targetRoom = rooms.find(r =>
                    (r.capacity - r.occupied) >= needed && matchesExclusiveRules(r, group[0])
                );

                if (targetRoom) {
                    for (const member of group) {
                        await dbAsync.run('UPDATE conference_inscriptions SET room_id = ? WHERE id = ?', [targetRoom.id, member.id]);
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
                await dbAsync.run('UPDATE conference_inscriptions SET room_id = ? WHERE id = ?', [targetRoom.id, p.id]);
                targetRoom.occupied++;
                roomConstraints[targetRoom.id] = p;
                assignedCount++;
            }
        }

        return { assignedCount };
    }


    // === PUBLIC PORTAL API ===

    router.get('/public/list', async (req, res) => {
        try {
            const list = await dbAsync.all("SELECT id, name, slug, date_start, date_end, description, status, is_form_published FROM conferences WHERE is_form_published = 1 ORDER BY id DESC");
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 2. List Locations for Login (Public)
    router.get('/public/locations', async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const conf = await dbAsync.get('SELECT is_form_published FROM conferences WHERE id = ?', [conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario de esta conferencia no está publicado.' });
            }
            // Only return necessary info for login selection
            const list = await dbAsync.all('SELECT id, name, responsible_name FROM conference_locations WHERE conference_id = ? ORDER BY name', [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 2b. Get Fields for Portal (Public)
    router.get('/public/fields', async (req, res) => {
        const { conference_id } = req.query;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });
        try {
            const list = await dbAsync.all('SELECT name, label, type, options, is_required, width FROM conference_fields WHERE conference_id = ? ORDER BY sort_order ASC', [conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 3. Login
    router.post('/portal/login', async (req, res) => {
        const { location_id, code } = req.body;
        try {
            const location = await dbAsync.get('SELECT * FROM conference_locations WHERE id = ?', [location_id]);
            if (!location) return res.status(404).json({ error: 'Location not found' });

            const conf = await dbAsync.get('SELECT is_form_published FROM conferences WHERE id = ?', [location.conference_id]);
            if (!conf || !conf.is_form_published) {
                return res.status(403).json({ error: 'El formulario de esta conferencia no está publicado.' });
            }

            // Simple code check
            if (String(location.code) !== String(code)) {
                return res.status(401).json({ error: 'Invalid code' });
            }

            // Create a simple session token (id:code base64 encoded)
            const token = btoa(`${location.id}:${location.code}`);

            // Set HttpOnly cookie for the portal
            res.cookie('wordjs_portal_token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });

            res.json({ success: true, token, location: { id: location.id, name: location.name, responsible_name: location.responsible_name, conference_id: location.conference_id } });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Middleware for Portal Auth
    const authPortal = async (req, res, next) => {
        let token = req.cookies.wordjs_portal_token || req.headers['x-portal-token'];
        if (!token) return res.status(401).json({ error: 'No token' });

        try {
            const decoded = atob(token);
            const [id, code] = decoded.split(':');
            const location = await dbAsync.get('SELECT * FROM conference_locations WHERE id = ? AND code = ?', [id, code]);

            if (!location) return res.status(401).json({ error: 'Invalid token' });
            req.location = location;
            next();
        } catch (e) {
            res.status(401).json({ error: 'Auth failed' });
        }
    };

    // 4. Get Current Location Info
    router.get('/portal/me', authPortal, async (req, res) => {
        res.json(req.location);
    });

    // 5. Get Inscriptions for Location
    router.get('/portal/inscriptions', authPortal, async (req, res) => {
        try {
            const list = await dbAsync.all('SELECT * FROM conference_inscriptions WHERE location = ? AND conference_id = ? ORDER BY first_name', [req.location.name, req.location.conference_id]);
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 6. Create Inscription (Portal)
    router.post('/portal/inscriptions', authPortal, async (req, res) => {
        const { ...fieldValues } = req.body;
        const conference_id = req.location.conference_id;

        try {
            const conf = await dbAsync.get('SELECT is_form_published, fee_default FROM conferences WHERE id = ?', [conference_id]);
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
                location: req.location.name,
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

            const result = await dbAsync.run(
                `INSERT INTO conference_inscriptions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                queryValues
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 7. Bulk Payments (Portal)
    router.post('/portal/payments/bulk', authPortal, async (req, res) => {
        const { inscription_ids, amount_per_person, method, reference, proof } = req.body;
        if (!inscription_ids || !Array.isArray(inscription_ids)) return res.status(400).json({ error: 'Missing inscription_ids' });

        try {
            for (const id of inscription_ids) {
                // Verify inscription belongs to this location
                const ins = await dbAsync.get('SELECT * FROM conference_inscriptions WHERE id = ? AND location = ? AND conference_id = ?', [id, req.location.name, req.location.conference_id]);
                if (!ins) continue;

                await dbAsync.run(
                    'INSERT INTO conference_payments (inscription_id, amount, method, reference, proof) VALUES (?, ?, ?, ?, ?)',
                    [id, amount_per_person, method, reference, proof]
                );

                // Update inscription totals
                const total = await dbAsync.get('SELECT SUM(amount) as s FROM conference_payments WHERE inscription_id = ?', [id]);
                const status = total.s >= (ins.total_due || 0) ? 'paid' : 'partial';
                await dbAsync.run('UPDATE conference_inscriptions SET amount_paid = ?, payment_status = ? WHERE id = ?', [total.s, status, id]);
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    const { getApp } = require('../../src/core/appRegistry');
    const app = getApp();
    if (app) app.use('/api/v1/conference', router);

    const { registerAdminMenu } = require('../../src/core/adminMenu');
    registerAdminMenu('conference-manager', {
        href: '/admin/plugin/conference-manager',
        label: 'Conference',
        icon: 'fa-users',
        order: 50,
        cap: 'manage_categories'
    });

    console.log('Conference Manager Plugin (Multi-Event) initialized.');
};
