/**
 * WordJS Plugin: Restaurant Menu — ISOLATED, sandboxed.
 *
 * Menu sections + dishes (prices in INTEGER CENTS, photos, diet tags) served to a Puck block,
 * with OPTIONAL simple online ordering: the block builds a client-side cart, POSTs the order
 * (item ids + quantities ONLY — the server re-reads prices from the DB and computes every total
 * itself), stores it, optionally emails the restaurant, and returns a prebuilt WhatsApp summary
 * text the customer forwards via a wa.me link.
 *
 * Sandbox constraints honored here:
 *  - All tables under the plugin prefix (wjp_restaurant_menu_*), schema final from day 1 (no ALTER).
 *  - No crypto API: the public order token is a Math.random 32-char string; the real defense for
 *    the public order endpoint is the in-memory rate limit (no req.ip in the isolate, so the cap
 *    is a global rolling window).
 *  - No transactions: order insert is a single statement; reorders are admin-only swaps.
 *  - res.json for EVERY response (the isolate JSON-encodes string bodies).
 */

exports.metadata = {
    name: 'Restaurant Menu',
    version: '1.0.0',
    description: 'Menu sections + dishes with a Puck block, optional cart ordering handed off to WhatsApp.',
    author: 'WordJS',
};

const OPT_CONFIG = 'restaurant_menu_config';

const DEFAULT_CONFIG = {
    currencySymbol: '$',
    orderingEnabled: false,
    whatsappNumber: '',          // digits with country code, e.g. 573001234567
    deliveryCents: 0,
    pickupLabel: 'Recoger en local',
    deliveryLabel: 'Domicilio',
    notifyEmail: '',
};

const VALID_TAGS = ['vegano', 'picante', 'sin-gluten', 'nuevo', 'popular'];
const ORDER_STATUSES = ['new', 'preparing', 'ready', 'delivered', 'cancelled'];
const MAX_ORDER_LINES = 50;
const MAX_QTY = 99;
const MAX_NOTE_CHARS = 200;
const MAX_NAME_CHARS = 120;
const MAX_PHONE_CHARS = 30;
const MAX_ADDRESS_CHARS = 300;
const MAX_ORDER_NOTES_CHARS = 500;

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu, mail } = wordjs;

    console.log('[restaurant-menu] initializing…');

    // Per-plugin table namespace: 'restaurant-menu' -> 'wjp_restaurant_menu_'.
    const P = db.tablePrefix;
    const T = {
        sections: `${P}sections`,
        items: `${P}items`,
        orders: `${P}orders`,
    };

    // ---- schema (idempotent; full column set from day 1 — ALTER is unavailable) -----------------
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
    }

    await initSchema();

    // ---- config helpers --------------------------------------------------------------------------
    async function getConfig() {
        const stored = (await options.get(OPT_CONFIG, null)) || {};
        return { ...DEFAULT_CONFIG, ...stored };
    }

    // ---- misc helpers ------------------------------------------------------------------------------

    /**
     * 32-char public order token. No CSPRNG exists in the sandbox (globalThis is statically
     * blocked); brute-forcing 36^32 via a rate-limited endpoint is not a realistic threat.
     */
    function genToken() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let out = '';
        for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
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

    /** Money formatting for the WhatsApp text (client formats its own UI). */
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

    // Global rolling-window rate limit for public order creation (no req.ip in the isolate).
    const ORDER_MAX_PER_WINDOW = 10;
    const ORDER_WINDOW_MS = 60 * 1000;
    let orderTimestamps = [];
    function orderRateLimited() {
        const now = Date.now();
        orderTimestamps = orderTimestamps.filter((t) => now - t < ORDER_WINDOW_MS);
        if (orderTimestamps.length >= ORDER_MAX_PER_WINDOW) return true;
        orderTimestamps.push(now);
        return false;
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

    // ================================================================================================
    // PUBLIC ROUTES (consumed by the Puck block from the editor iframe AND the public page)
    // ================================================================================================

    // Active sections in order, each with its available items in order.
    http.route('get', '/public/menu', async (req, res) => {
        try {
            const sections = await db.all(
                `SELECT id, name FROM ${T.sections} WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
            );
            const items = await db.all(
                `SELECT id, section_id, name, description, price_cents, image_url, tags
                 FROM ${T.items} WHERE is_available = 1 ORDER BY sort_order ASC, id ASC`
            );
            const bySection = new Map();
            for (const s of sections) bySection.set(s.id, { id: s.id, name: s.name, items: [] });
            for (const it of items) {
                const bucket = bySection.get(it.section_id);
                if (bucket) {
                    bucket.items.push({
                        id: it.id,
                        name: it.name,
                        description: it.description || '',
                        price_cents: it.price_cents,
                        image_url: it.image_url || '',
                        tags: String(it.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
                    });
                }
            }
            res.json({ sections: Array.from(bySection.values()) });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cargar el menú.' });
        }
    });

    // Public slice of the config — only what the block needs to render/order.
    http.route('get', '/public/config', async (req, res) => {
        try {
            const cfg = await getConfig();
            res.json({
                currencySymbol: cfg.currencySymbol,
                orderingEnabled: !!cfg.orderingEnabled,
                whatsappNumber: cfg.whatsappNumber,
                deliveryCents: cfg.deliveryCents,
                pickupLabel: cfg.pickupLabel,
                deliveryLabel: cfg.deliveryLabel,
            });
        } catch (e) {
            res.status(500).json({ error: 'No se pudo cargar la configuración.' });
        }
    });

    // Create an order. The client sends item ids + quantities ONLY — prices, subtotal, delivery fee
    // and total are all recomputed server-side from the DB and the stored config.
    http.route('post', '/public/order', async (req, res) => {
        try {
            const cfg = await getConfig();
            if (!cfg.orderingEnabled) {
                return res.status(403).json({ error: 'Los pedidos en línea no están habilitados.' });
            }
            if (orderRateLimited()) {
                return res.status(429).json({ error: 'Demasiados pedidos en este momento. Intenta de nuevo en un minuto.' });
            }

            const body = req.body || {};
            const customerName = String(body.customer_name || '').trim();
            const customerPhone = String(body.customer_phone || '').trim();
            const customerAddress = String(body.customer_address || '').trim();
            const deliveryType = String(body.delivery_type || '').trim();
            const orderNotes = String(body.notes || '').trim();

            if (!customerName || customerName.length > MAX_NAME_CHARS) {
                return res.status(400).json({ error: 'El nombre es obligatorio (máx. 120 caracteres).' });
            }
            if (!customerPhone || customerPhone.length > MAX_PHONE_CHARS || !/^[+\d\s()-]+$/.test(customerPhone)) {
                return res.status(400).json({ error: 'El teléfono es obligatorio y debe ser válido.' });
            }
            if (deliveryType !== 'pickup' && deliveryType !== 'delivery') {
                return res.status(400).json({ error: 'Tipo de entrega inválido.' });
            }
            if (deliveryType === 'delivery' && !customerAddress) {
                return res.status(400).json({ error: 'La dirección es obligatoria para domicilio.' });
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

            // Merge duplicate lines and validate shapes BEFORE touching the DB.
            const merged = new Map(); // item_id -> { qty, note }
            for (const line of rawItems) {
                const itemId = parseInt(line && line.item_id, 10);
                const qty = parseInt(line && line.qty, 10);
                if (!Number.isInteger(itemId) || itemId <= 0) {
                    return res.status(400).json({ error: 'Producto inválido en el pedido.' });
                }
                if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
                    return res.status(400).json({ error: 'Cantidad inválida en el pedido (1–99).' });
                }
                const note = String((line && line.note) || '').trim().slice(0, MAX_NOTE_CHARS);
                const prev = merged.get(itemId);
                if (prev) {
                    prev.qty = Math.min(MAX_QTY, prev.qty + qty);
                    if (note) prev.note = prev.note ? `${prev.note}; ${note}`.slice(0, MAX_NOTE_CHARS) : note;
                } else {
                    merged.set(itemId, { qty, note });
                }
            }

            // Re-read prices from the DB; only available items in active sections are orderable.
            const snapshot = [];
            let subtotalCents = 0;
            for (const [itemId, line] of merged) {
                const row = await db.get(
                    `SELECT i.id, i.name, i.price_cents
                     FROM ${T.items} i
                     JOIN ${T.sections} s ON s.id = i.section_id
                     WHERE i.id = ? AND i.is_available = 1 AND s.is_active = 1`,
                    [itemId]
                );
                if (!row) {
                    return res.status(400).json({ error: 'Un producto del pedido ya no está disponible. Actualiza la página.' });
                }
                snapshot.push({
                    item_id: row.id,
                    name: row.name,
                    price_cents: row.price_cents,
                    qty: line.qty,
                    note: line.note,
                });
                subtotalCents += row.price_cents * line.qty;
            }

            const deliveryCents = deliveryType === 'delivery' ? (toCents(cfg.deliveryCents) || 0) : 0;
            const totalCents = subtotalCents + deliveryCents;
            const token = genToken();

            await db.run(
                `INSERT INTO ${T.orders}
                    (token, customer_name, customer_phone, customer_address, delivery_type, items,
                     subtotal_cents, delivery_cents, total_cents, notes, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
                [
                    token, customerName, customerPhone,
                    deliveryType === 'delivery' ? customerAddress : (customerAddress || ''),
                    deliveryType, JSON.stringify(snapshot),
                    subtotalCents, deliveryCents, totalCents, orderNotes,
                ]
            );

            // Prebuilt WhatsApp summary — the client opens wa.me with this text URL-encoded.
            const sym = String(cfg.currencySymbol || '$');
            const typeLabel = deliveryType === 'delivery'
                ? `${cfg.deliveryLabel || 'Domicilio'}: ${customerAddress}`
                : (cfg.pickupLabel || 'Recoger en local');
            const lines = [];
            lines.push('🍽️ *Nuevo pedido*');
            lines.push(`👤 ${customerName}`);
            lines.push(`📞 ${customerPhone}`);
            lines.push(`📍 ${typeLabel}`);
            lines.push('──────────');
            for (const it of snapshot) {
                lines.push(`${it.qty}x ${it.name} — ${fmtMoney(it.price_cents * it.qty, sym)}`);
                if (it.note) lines.push(`   ▸ ${it.note}`);
            }
            lines.push('──────────');
            lines.push(`Subtotal: ${fmtMoney(subtotalCents, sym)}`);
            if (deliveryCents > 0) lines.push(`Envío: ${fmtMoney(deliveryCents, sym)}`);
            lines.push(`*TOTAL: ${fmtMoney(totalCents, sym)}*`);
            if (orderNotes) lines.push(`📝 Notas: ${orderNotes}`);
            lines.push(`Ref: ${token}`);
            const waText = lines.join('\n');

            // Optional email notification — the order exists regardless of mail success.
            let mailNote = '';
            if (cfg.notifyEmail) {
                try {
                    await mail({
                        to: cfg.notifyEmail,
                        subject: `Nuevo pedido de ${customerName} — ${fmtMoney(totalCents, sym)}`,
                        text: waText.replace(/\*/g, ''),
                        html: `<pre style="font-family:inherit;white-space:pre-wrap">${waText
                            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                            .replace(/\*/g, '')}</pre>`,
                    });
                } catch (e) {
                    mailNote = 'correo no enviado';
                    console.warn('[restaurant-menu] order mail failed:', e.message);
                }
            }

            // Public response carries the random token only — never the sequential order id.
            res.json({ success: true, token, waText, mailNote });
        } catch (e) {
            console.error('[restaurant-menu] order failed:', e.message);
            res.status(500).json({ error: 'No se pudo registrar el pedido. Intenta de nuevo.' });
        }
    });

    // ================================================================================================
    // ADMIN ROUTES
    // ================================================================================================

    // Full menu for the admin (includes inactive sections and unavailable items).
    http.route('get', '/admin/menu', { auth: true, admin: true }, async (req, res) => {
        try {
            const sections = await db.all(
                `SELECT id, name, sort_order, is_active FROM ${T.sections} ORDER BY sort_order ASC, id ASC`
            );
            const items = await db.all(
                `SELECT id, section_id, name, description, price_cents, image_url, tags, is_available, sort_order
                 FROM ${T.items} ORDER BY sort_order ASC, id ASC`
            );
            const out = sections.map((s) => ({ ...s, items: [] }));
            const byId = new Map(out.map((s) => [s.id, s]));
            for (const it of items) {
                const bucket = byId.get(it.section_id);
                if (bucket) bucket.items.push(it);
            }
            res.json({ sections: out });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- sections CRUD + reorder ---------------------------------------------------------------

    http.route('post', '/sections', { auth: true, admin: true }, async (req, res) => {
        try {
            const name = String((req.body && req.body.name) || '').trim();
            if (!name || name.length > 120) return res.status(400).json({ error: 'El nombre de la sección es obligatorio (máx. 120).' });
            const max = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${T.sections}`);
            const result = await db.run(
                `INSERT INTO ${T.sections} (name, sort_order, is_active) VALUES (?, ?, 1)`,
                [name, (max ? max.m : -1) + 1]
            );
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
            await db.run(`DELETE FROM ${T.items} WHERE section_id = ?`, [id]);
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

    http.route('post', '/items', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            const sectionId = parseInt(body.section_id, 10);
            if (!Number.isInteger(sectionId)) return res.status(400).json({ error: 'Sección inválida.' });
            const section = await db.get(`SELECT id FROM ${T.sections} WHERE id = ?`, [sectionId]);
            if (!section) return res.status(404).json({ error: 'Sección no encontrada.' });

            const clean = await cleanItemPayload(body, true);
            if (clean.error) return res.status(400).json({ error: clean.error });

            const max = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${T.items} WHERE section_id = ?`, [sectionId]);
            const result = await db.run(
                `INSERT INTO ${T.items} (section_id, name, description, price_cents, image_url, tags, is_available, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
                [sectionId, clean.name, clean.description, clean.price_cents, clean.image_url, clean.tags, (max ? max.m : -1) + 1]
            );
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
            if (sets.length === 0) return res.json({ success: true });
            params.push(id);
            await db.run(`UPDATE ${T.items} SET ${sets.join(', ')} WHERE id = ?`, params);
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
            await db.run(`DELETE FROM ${T.items} WHERE id = ?`, [id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- orders ------------------------------------------------------------------------------------

    // ?status= filter; always returns per-status counts for the badges.
    http.route('get', '/orders', { auth: true, admin: true }, async (req, res) => {
        try {
            const status = String((req.query && req.query.status) || '').trim();
            let orders;
            if (status && ORDER_STATUSES.includes(status)) {
                orders = await db.all(`SELECT * FROM ${T.orders} WHERE status = ? ORDER BY id DESC`, [status]);
            } else {
                orders = await db.all(`SELECT * FROM ${T.orders} ORDER BY id DESC LIMIT 300`);
            }
            for (const o of orders) {
                try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; }
            }
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

    http.route('post', '/orders/:id/status', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            const status = String((req.body && req.body.status) || '').trim();
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
            const result = await db.run(`UPDATE ${T.orders} SET status = ? WHERE id = ?`, [status, id]);
            if (!result || result.changes === 0) return res.status(404).json({ error: 'Pedido no encontrado.' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    http.route('delete', '/orders/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido.' });
            await db.run(`DELETE FROM ${T.orders} WHERE id = ?`, [id]);
            res.json({ success: true });
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

    console.log('[restaurant-menu] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down.
};
