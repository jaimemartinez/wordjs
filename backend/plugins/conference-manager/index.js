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
        'fee_default REAL DEFAULT 0',
        'description TEXT'
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
        'FOREIGN KEY (inscription_id) REFERENCES conference_inscriptions(id) ON DELETE CASCADE'
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
        
        // Check if conference_inscriptions exists and migrate missing columns
        let tableExists = false;
        try {
            if (isPostgres) {
                const result = await dbAsync.get(
                    `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = ?`,
                    ['conference_inscriptions']
                );
                tableExists = result.count > 0;
            } else {
                await dbAsync.get('SELECT 1 FROM conference_inscriptions LIMIT 1');
                tableExists = true;
            }
        } catch (e) {
            tableExists = false;
        }

        if (tableExists) {
            // Migrate conference_id if missing
            const hasConferenceId = await columnExists('conference_inscriptions', 'conference_id');
            if (!hasConferenceId) {
                console.log('🔄 Migrating conference_inscriptions: adding conference_id column...');
                await dbAsync.run('ALTER TABLE conference_inscriptions ADD COLUMN conference_id INTEGER');
                // Set default conference_id for existing records
                const defaultConf = await dbAsync.get('SELECT id FROM conferences LIMIT 1');
                if (defaultConf) {
                    await dbAsync.run(
                        'UPDATE conference_inscriptions SET conference_id = ? WHERE conference_id IS NULL',
                        [defaultConf.id]
                    );
                } else {
                    // Create default conference if none exists
                    const result = await dbAsync.run(
                        "INSERT INTO conferences (name, slug, status, description) VALUES (?, ?, ?, ?)",
                        ['Default Conference', 'default-conf', 'active', 'Initial system conference']
                    );
                    await dbAsync.run(
                        'UPDATE conference_inscriptions SET conference_id = ? WHERE conference_id IS NULL',
                        [result.lastID]
                    );
                }
            }
            
            // Migrate location if missing
            const hasLocation = await columnExists('conference_inscriptions', 'location');
            if (!hasLocation) {
                console.log('🔄 Migrating conference_inscriptions: adding location column...');
                await dbAsync.run('ALTER TABLE conference_inscriptions ADD COLUMN location TEXT');
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
    console.log('Initializing Conference Manager Plugin (Multi-Event Edition)...');
    await initSchema();

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
            res.json({ success: true, id: result.lastID });
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
            res.json(list);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Create Inscription
    router.post('/inscriptions', authenticate, isAdmin, async (req, res) => {
        const { conference_id, first_name, last_name, gender, email, phone, age, location, document_type, document_number, blood_type, eps, family_group, total_due, notes } = req.body;
        if (!conference_id) return res.status(400).json({ error: 'Missing conference_id' });

        try {
            const result = await dbAsync.run(
                `INSERT INTO conference_inscriptions 
                (conference_id, first_name, last_name, gender, email, phone, age, location, document_type, document_number, blood_type, eps, family_group, total_due, notes) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [conference_id, first_name, last_name, gender, email, phone, age, location, document_type, document_number, blood_type, eps, family_group, total_due || 0, notes]
            );
            res.json({ success: true, id: result.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ... (rest of methods: post hotels, post rooms, assign, payments - all using conference_id context)

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
        const { amount, method, reference } = req.body;
        await dbAsync.run('INSERT INTO conference_payments (inscription_id, amount, method, reference) VALUES (?, ?, ?, ?)', [req.params.id, amount, method, reference]);
        const total = await dbAsync.get('SELECT SUM(amount) as s FROM conference_payments WHERE inscription_id = ?', [req.params.id]);
        const p = await dbAsync.get('SELECT total_due FROM conference_inscriptions WHERE id = ?', [req.params.id]);
        const status = total.s >= p.total_due ? 'paid' : 'partial';
        await dbAsync.run('UPDATE conference_inscriptions SET amount_paid = ?, payment_status = ? WHERE id = ?', [total.s, status, req.params.id]);
        res.json({ success: true });
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
