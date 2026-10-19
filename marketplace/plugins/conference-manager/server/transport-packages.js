/**
 * Transport packages (conference-manager 2.26.0): what is sold is a PACKAGE — a named set of buses (a fixed list,
 * e.g. «Ida y regreso» = Bus 1 + Bus 4) with ONE price — never a single bus ticket.
 *
 * MODEL.
 *   packages          — { conference_id, name, price, notes, legacy_bus_id } (legacy_bus_id: see MIGRATION)
 *   package_buses     — the fixed list (package_id, bus_id), unique pair
 *   package_sales     — one per person and package: { price (the package price when sold), amount_paid,
 *                       payment_status } — the money lives HERE
 *   package_payments  — the sale's payments (cash / transfer), like the old ticket payments
 *   transport_tickets — kept as the SEATS: selling a package puts the person on every bus of the list (one seat
 *                       each, `sale_id` = the sale; price 0). Capacity, the bus passenger lists, the manifests and
 *                       the boarding check keep reading seats.
 *
 * RULES. A person holds a bus seat once (the old unique (bus, inscription) index): a package whose buses include
 * one where they already sit is refused (409, naming the bus). A sale needs a free seat on EVERY bus of the
 * package (all-or-nothing, under the assignment lock). The list of buses can change only while the package has
 * no sales; its price can, for new sales, and with `reprice_sales` for the sold ones too — never below what a
 * sale has already been paid. A sale, or a package, with payments cannot be removed until they are deleted.
 * Payments never exceed the sale's balance.
 *
 * MIGRATION (once, idempotent): every seat sold the old way (no `sale_id`) becomes a sale of a one-bus package
 * named after its bus at the bus price (one such package per bus, found again by legacy_bus_id), with the
 * ticket's price, and its payments move to the sale — no money is lost or counted twice (the seat's own price
 * and paid amount become 0).
 *
 * SQL: own prefixed tables, a space before a closing parenthesis after a table name, no `$`, portable.
 */
'use strict';

const MAX_PER_CALL = 500;

function createPackages(base) {
    const { db, T, P, addColumnIfMissing, createIndex, createUniqueIndex } = base;
    T.packages = `${P}transport_packages`;
    T.packageBuses = `${P}transport_package_buses`;
    T.packageSales = `${P}transport_package_sales`;
    T.packagePayments = `${P}transport_package_payments`;
    let D = null;

    async function migrate() {
        await db.createTable(T.packages, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'name TEXT NOT NULL',
            'price REAL DEFAULT 0',
            'notes TEXT',
            'legacy_bus_id INT',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_tpackages_conf`, T.packages, 'conference_id');
        await db.createTable(T.packageBuses, [
            'id INT_PK',
            'package_id INT NOT NULL',
            'bus_id INT NOT NULL',
            `FOREIGN KEY (package_id) REFERENCES ${T.packages}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (bus_id) REFERENCES ${T.buses}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_tpackage_buses`, T.packageBuses, 'package_id, bus_id');
        await createIndex(`${P}idx_tpackage_buses_bus`, T.packageBuses, 'bus_id');
        await db.createTable(T.packageSales, [
            'id INT_PK',
            'package_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'price REAL DEFAULT 0',
            'amount_paid REAL DEFAULT 0',
            "payment_status TEXT DEFAULT 'unpaid'",
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (package_id) REFERENCES ${T.packages}(id) ON DELETE CASCADE`,
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_tpackage_sales`, T.packageSales, 'package_id, inscription_id');
        await createIndex(`${P}idx_tpackage_sales_ins`, T.packageSales, 'inscription_id');
        await db.createTable(T.packagePayments, [
            'id INT_PK',
            'sale_id INT NOT NULL',
            'amount REAL NOT NULL',
            'method TEXT',
            'reference TEXT',
            'date DATETIME DEFAULT CURRENT_TIMESTAMP',
            'recorded_by TEXT',
            `FOREIGN KEY (sale_id) REFERENCES ${T.packageSales}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_tpackage_payments_sale`, T.packagePayments, 'sale_id');
        await addColumnIfMissing(T.tickets, 'sale_id', 'INT');
        await createIndex(`${P}idx_tickets_sale`, T.tickets, 'sale_id');
        await migrateLegacyTickets();
    }

    // Seats sold before packages → sales of one-bus packages (see MIGRATION).
    async function migrateLegacyTickets() {
        const legacy = await db.all(
            `SELECT t.id, t.bus_id, t.inscription_id, t.price, t.amount_paid, t.payment_status, b.conference_id, b.name AS bus_name, b.price AS bus_price`
            + ` FROM ${T.tickets} t JOIN ${T.buses} b ON b.id = t.bus_id WHERE t.sale_id IS NULL ORDER BY t.id`);
        if (!legacy.length) return;
        const pkgOf = new Map();
        for (const t of legacy) {
            let pkgId = pkgOf.get(t.bus_id);
            if (!pkgId) {
                const found = await db.get(`SELECT id FROM ${T.packages} WHERE legacy_bus_id = ?`, [t.bus_id]);
                if (found) pkgId = found.id;
                else {
                    const r = await db.run(`INSERT INTO ${T.packages} (conference_id, name, price, legacy_bus_id) VALUES (?, ?, ?, ?)`,
                        [t.conference_id, String(t.bus_name || 'Bus').slice(0, 120), Number(t.bus_price) || 0, t.bus_id]);
                    pkgId = r.lastID;
                    await db.run(`INSERT INTO ${T.packageBuses} (package_id, bus_id) VALUES (?, ?)`, [pkgId, t.bus_id]);
                }
                pkgOf.set(t.bus_id, pkgId);
            }
            let sale = await db.get(`SELECT id FROM ${T.packageSales} WHERE package_id = ? AND inscription_id = ?`, [pkgId, t.inscription_id]);
            if (!sale) {
                const r = await db.run(`INSERT INTO ${T.packageSales} (package_id, inscription_id, price, amount_paid, payment_status) VALUES (?, ?, ?, 0, 'unpaid')`,
                    [pkgId, t.inscription_id, Number(t.price) || 0]);
                sale = { id: r.lastID };
            }
            // Its payments move to the sale (copied, then removed from the ticket), then the seat points at the sale.
            await db.run(`INSERT INTO ${T.packagePayments} (sale_id, amount, method, reference, date, recorded_by)`
                + ` SELECT ?, amount, method, reference, date, recorded_by FROM ${T.transportPayments} WHERE ticket_id = ?`, [sale.id, t.id]);
            await db.run(`DELETE FROM ${T.transportPayments} WHERE ticket_id = ?`, [t.id]);
            await db.run(`UPDATE ${T.tickets} SET sale_id = ?, price = 0, amount_paid = 0, payment_status = 'paid' WHERE id = ?`, [sale.id, t.id]);
            await recomputeSales('id = ?', [sale.id]);
        }
    }

    // amount_paid = SUM of the sale's payments; status over the sale price (half-cent tolerance).
    async function recomputeSales(where, params) {
        const paid = `(SELECT COALESCE(SUM(amount), 0) FROM ${T.packagePayments} WHERE sale_id = ${T.packageSales}.id)`;
        await db.run(`UPDATE ${T.packageSales}
            SET amount_paid = ${paid},
                payment_status = CASE
                    WHEN price <= 0 THEN 'paid'
                    WHEN ${paid} + 0.005 >= price THEN 'paid'
                    WHEN ${paid} > 0 THEN 'partial'
                    ELSE 'unpaid' END
            WHERE ${where}`, params);
    }

    // ── reads ──
    const money = (v) => D.roundMoney(Number(v) || 0);
    const saleRow = (s) => ({ id: s.id, package_id: s.package_id, inscription_id: s.inscription_id, price: money(s.price), amount_paid: money(s.amount_paid), payment_status: s.payment_status || 'unpaid', created_at: s.created_at || null });
    async function packagesOf(cid) {
        const pkgs = await db.all(`SELECT * FROM ${T.packages} WHERE conference_id = ? ORDER BY name, id`, [cid]);
        const links = await db.all(`SELECT pb.package_id, pb.bus_id, b.name FROM ${T.packageBuses} pb JOIN ${T.buses} b ON b.id = pb.bus_id JOIN ${T.packages} p ON p.id = pb.package_id WHERE p.conference_id = ? ORDER BY b.departure, b.name`, [cid]);
        const sales = await db.all(`SELECT s.* FROM ${T.packageSales} s JOIN ${T.packages} p ON p.id = s.package_id WHERE p.conference_id = ? ORDER BY s.id`, [cid]);
        const busesOf = new Map(), salesOf = new Map();
        for (const l of links) { if (!busesOf.has(l.package_id)) busesOf.set(l.package_id, []); busesOf.get(l.package_id).push({ id: l.bus_id, name: l.name }); }
        for (const s of sales) { if (!salesOf.has(s.package_id)) salesOf.set(s.package_id, []); salesOf.get(s.package_id).push(saleRow(s)); }
        return pkgs.map((p) => {
            const list = salesOf.get(p.id) || [];
            const revenue = list.reduce((a, s) => a + s.price, 0), collected = list.reduce((a, s) => a + s.amount_paid, 0);
            return { id: p.id, conference_id: p.conference_id, name: p.name, price: money(p.price), notes: p.notes || null, buses: busesOf.get(p.id) || [],
                sold: list.length, revenue: money(revenue), collected: money(collected), sales: list };
        });
    }
    /** The sale (with its package's name) a seat belongs to, by seat ids — for the bus passenger lists. */
    async function salesBySeat(cid) {
        const rows = await db.all(`SELECT t.id AS ticket_id, s.id, s.package_id, s.inscription_id, s.price, s.amount_paid, s.payment_status, s.created_at, p.name AS package_name`
            + ` FROM ${T.tickets} t JOIN ${T.packageSales} s ON s.id = t.sale_id JOIN ${T.packages} p ON p.id = s.package_id WHERE p.conference_id = ?`, [cid]);
        return new Map(rows.map(r => [Number(r.ticket_id), { ...saleRow(r), package_name: r.package_name }]));
    }

    // ── writes ──
    function parsePackageBody(body, partial) {
        const out = {};
        if (!partial || body.name !== undefined) {
            const name = String(body.name == null ? '' : body.name).trim();
            if (!name) throw D.httpError(400, 'El nombre del paquete es obligatorio.');
            out.name = name.slice(0, 120);
        }
        if (!partial || body.price !== undefined) {
            const n = Number(body.price == null || body.price === '' ? 0 : body.price);
            if (!Number.isFinite(n) || n < 0) throw D.httpError(400, 'El precio del paquete no puede ser negativo.');
            D.assertMoneyRange(n, 'El precio del paquete');
            out.price = D.roundMoney(n);
        }
        if (body.notes !== undefined) out.notes = body.notes == null || String(body.notes).trim() === '' ? null : String(body.notes).trim().slice(0, 1000);
        return out;
    }
    async function busIdsOf(cid, raw) {
        if (!Array.isArray(raw)) throw D.httpError(400, 'Elige los buses del paquete.');
        const ids = [...new Set(raw.map(D.positiveInt))];
        if (!ids.length || ids.some(n => !n)) throw D.httpError(400, 'Elige al menos un bus para el paquete.');
        if (ids.length > 50) throw D.httpError(400, 'Un paquete puede tener hasta 50 buses.');
        const rows = await db.all(`SELECT id FROM ${T.buses} WHERE conference_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [cid, ...ids]);
        if (rows.length !== ids.length) throw D.httpError(400, 'Algún bus no pertenece a esta conferencia.');
        return ids;
    }

    function install(deps) {
        D = deps;
        const { http, allow, allowAny, positiveInt, withAssignmentLock, sendError, httpError } = deps;
        const VIEW = [['transport', 'view'], ['transport', 'manage'], ['reports', 'view']];

        // GET /transport/packages?conference_id → packages with their buses and sales.
        http.route('get', '/transport/packages', { auth: true }, async (req, res) => {
            if (!await allowAny(req, res, VIEW)) return;
            try {
                const cid = positiveInt(req.query.conference_id);
                if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
                res.json(await packagesOf(cid));
            } catch (e) { sendError(res, e); }
        });

        // POST /transport/packages { conference_id, name, price, notes?, bus_ids[] }.
        http.route('post', '/transport/packages', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            try {
                const body = req.body || {};
                const cid = positiveInt(body.conference_id);
                if (!cid || !await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid])) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const v = parsePackageBody(body, false);
                const busIds = await busIdsOf(cid, body.bus_ids);
                const r = await db.run(`INSERT INTO ${T.packages} (conference_id, name, price, notes) VALUES (?, ?, ?, ?)`, [cid, v.name, v.price, v.notes || null]);
                await D.runBatched(busIds.map(b => [`INSERT INTO ${T.packageBuses} (package_id, bus_id) VALUES (?, ?)`, [r.lastID, b]]));
                res.json({ success: true, id: r.lastID });
            } catch (e) { sendError(res, e); }
        });

        // PUT /transport/packages/:id { name?, price?, notes?, bus_ids?, reprice_sales? }.
        http.route('put', '/transport/packages/:id', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            try {
                const id = positiveInt(req.params.id);
                const body = req.body || {};
                const result = await withAssignmentLock(async () => {
                    const pkg = id ? await db.get(`SELECT * FROM ${T.packages} WHERE id = ?`, [id]) : null;
                    if (!pkg) throw httpError(404, 'Paquete no encontrado.');
                    const v = parsePackageBody(body, true);
                    const sold = Number((await db.get(`SELECT COUNT(*) AS n FROM ${T.packageSales} WHERE package_id = ?`, [id])).n) || 0;
                    let busIds = null;
                    if (body.bus_ids !== undefined) {
                        busIds = await busIdsOf(pkg.conference_id, body.bus_ids);
                        const now = (await db.all(`SELECT bus_id FROM ${T.packageBuses} WHERE package_id = ?`, [id])).map(r => Number(r.bus_id)).sort((a, b) => a - b);
                        const same = now.length === busIds.length && [...busIds].sort((a, b) => a - b).every((b, i) => b === now[i]);
                        if (same) busIds = null;
                        else if (sold) throw httpError(409, `El paquete ya se vendió a ${sold} persona(s): sus buses no pueden cambiar. Crea otro paquete.`);
                    }
                    if (body.reprice_sales && v.price !== undefined) {
                        const over = await db.get(`SELECT COUNT(*) AS n FROM ${T.packageSales} WHERE package_id = ? AND amount_paid > ? + 0.005`, [id, v.price]);
                        if (Number(over && over.n) > 0) throw httpError(409, `El nuevo precio es menor que lo ya pagado en ${over.n} venta(s); ajusta esos pagos primero o aplica el precio solo a las próximas ventas.`);
                    }
                    const keys = Object.keys(v);
                    if (keys.length) await db.run(`UPDATE ${T.packages} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => v[k]), id]);
                    if (busIds) {
                        await db.run(`DELETE FROM ${T.packageBuses} WHERE package_id = ?`, [id]);
                        await D.runBatched(busIds.map(b => [`INSERT INTO ${T.packageBuses} (package_id, bus_id) VALUES (?, ?)`, [id, b]]));
                    }
                    if (body.reprice_sales && v.price !== undefined) {
                        await db.run(`UPDATE ${T.packageSales} SET price = ? WHERE package_id = ?`, [v.price, id]);
                        await recomputeSales('package_id = ?', [id]);
                    }
                    return { success: true };
                });
                res.json(result);
            } catch (e) { sendError(res, e); }
        });

        // DELETE /transport/packages/:id — refused while any sale has payments; else its sales and seats go too.
        http.route('delete', '/transport/packages/:id', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            try {
                const id = positiveInt(req.params.id);
                const result = await withAssignmentLock(async () => {
                    const pkg = id ? await db.get(`SELECT id FROM ${T.packages} WHERE id = ?`, [id]) : null;
                    if (!pkg) throw httpError(404, 'Paquete no encontrado.');
                    const paid = await db.get(`SELECT COUNT(*) AS n FROM ${T.packagePayments} WHERE sale_id IN (SELECT id FROM ${T.packageSales} WHERE package_id = ? )`, [id]);
                    if (Number(paid && paid.n) > 0) throw httpError(409, 'El paquete tiene ventas con pagos registrados; elimina esos pagos antes de borrar el paquete.');
                    const seats = await db.run(`DELETE FROM ${T.tickets} WHERE sale_id IN (SELECT id FROM ${T.packageSales} WHERE package_id = ? )`, [id]);
                    await db.run(`DELETE FROM ${T.packageSales} WHERE package_id = ?`, [id]);
                    await db.run(`DELETE FROM ${T.packageBuses} WHERE package_id = ?`, [id]);
                    await db.run(`DELETE FROM ${T.packages} WHERE id = ?`, [id]);
                    return { success: true, released: (seats && seats.changes) || 0 };
                });
                res.json(result);
            } catch (e) { sendError(res, e); }
        });

        // POST /transport/packages/:id/sales { inscription_ids[] } — sell the package: a sale per person and a seat
        // on every bus of the list. All-or-nothing: same conference, never a cancelled person, never someone who
        // already has it or already sits on one of its buses, never beyond the free seats of ANY bus.
        http.route('post', '/transport/packages/:id/sales', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            try {
                const id = positiveInt(req.params.id);
                const raw = req.body && req.body.inscription_ids;
                if (!Array.isArray(raw) || !raw.length) return res.status(400).json({ error: 'Selecciona al menos un participante.' });
                if (raw.length > MAX_PER_CALL) return res.status(400).json({ error: `Máximo ${MAX_PER_CALL} participantes por operación.` });
                const ids = [...new Set(raw.map(positiveInt))];
                if (ids.some(n => !n)) return res.status(400).json({ error: 'Identificadores de inscripción inválidos.' });
                const result = await withAssignmentLock(async () => {
                    const pkg = id ? await db.get(`SELECT * FROM ${T.packages} WHERE id = ?`, [id]) : null;
                    if (!pkg) throw httpError(404, 'Paquete no encontrado.');
                    const buses = await db.all(`SELECT b.id, b.name, b.capacity, (SELECT COUNT(*) FROM ${T.tickets} t WHERE t.bus_id = b.id) AS sold`
                        + ` FROM ${T.packageBuses} pb JOIN ${T.buses} b ON b.id = pb.bus_id WHERE pb.package_id = ?`, [id]);
                    if (!buses.length) throw httpError(400, 'El paquete no tiene buses.');
                    const marks = ids.map(() => '?').join(', ');
                    const people = await db.all(`SELECT id, status FROM ${T.inscriptions} WHERE conference_id = ? AND id IN (${marks})`, [pkg.conference_id, ...ids]);
                    if (people.length !== ids.length) throw httpError(400, 'Alguno de los participantes no pertenece a esta conferencia.');
                    if (people.some(p => p.status === 'cancelled')) throw httpError(400, 'Un participante cancelado no puede recibir un paquete.');
                    const already = new Set((await db.all(`SELECT inscription_id FROM ${T.packageSales} WHERE package_id = ? AND inscription_id IN (${marks})`, [id, ...ids])).map(r => Number(r.inscription_id)));
                    const fresh = ids.filter(i => !already.has(i));
                    if (fresh.length) {
                        const busMarks = buses.map(() => '?').join(', ');
                        const seated = await db.all(`SELECT t.inscription_id, b.name FROM ${T.tickets} t JOIN ${T.buses} b ON b.id = t.bus_id`
                            + ` WHERE t.bus_id IN (${busMarks}) AND t.inscription_id IN (${fresh.map(() => '?').join(', ')})`, [...buses.map(b => b.id), ...fresh]);
                        if (seated.length) throw httpError(409, `${seated.length === 1 ? 'Una persona ya tiene' : `${seated.length} personas ya tienen`} puesto en ${[...new Set(seated.map(s => s.name))].join(', ')} (otro paquete). Quítale ese paquete primero.`);
                        const full = buses.filter(b => Number(b.capacity) - (Number(b.sold) || 0) < fresh.length);
                        if (full.length) throw httpError(409, `No hay puestos suficientes en ${full.map(b => `${b.name} (quedan ${Math.max(0, Number(b.capacity) - (Number(b.sold) || 0))})`).join(', ')}.`);
                        const price = D.roundMoney(Number(pkg.price) || 0);
                        for (const iid of fresh) {
                            const r = await db.run(`INSERT INTO ${T.packageSales} (package_id, inscription_id, price, amount_paid, payment_status) VALUES (?, ?, ?, 0, ?)`, [id, iid, price, price <= 0 ? 'paid' : 'unpaid']);
                            await D.runBatched(buses.map(b => [`INSERT INTO ${T.tickets} (bus_id, inscription_id, price, amount_paid, payment_status, sale_id) VALUES (?, ?, 0, 0, 'paid', ?)`, [b.id, iid, r.lastID]]));
                        }
                    }
                    return { added: fresh.length, skipped: ids.length - fresh.length };
                });
                res.json({ success: true, ...result });
            } catch (e) { sendError(res, e); }
        });

        // DELETE /transport/package-sales/:id — take the package away (refused with payments); its seats free up.
        http.route('delete', '/transport/package-sales/:id', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            try {
                const id = positiveInt(req.params.id);
                const result = await withAssignmentLock(async () => {
                    const sale = id ? await db.get(`SELECT id FROM ${T.packageSales} WHERE id = ?`, [id]) : null;
                    if (!sale) throw httpError(404, 'Venta no encontrada.');
                    const paid = await db.get(`SELECT COUNT(*) AS n FROM ${T.packagePayments} WHERE sale_id = ?`, [id]);
                    if (Number(paid && paid.n) > 0) throw httpError(409, 'El paquete tiene pagos registrados; elimínalos antes de quitárselo a la persona.');
                    await db.run(`DELETE FROM ${T.tickets} WHERE sale_id = ?`, [id]);
                    await db.run(`DELETE FROM ${T.packageSales} WHERE id = ?`, [id]);
                    return { success: true };
                });
                res.json(result);
            } catch (e) { sendError(res, e); }
        });

        // Payments of a sale: GET / POST /transport/package-sales/:id/payments, DELETE /transport/package-payments/:id.
        http.route('get', '/transport/package-sales/:id/payments', { auth: true }, async (req, res) => {
            if (!await allowAny(req, res, [['transport', 'view'], ['transport', 'manage']])) return;
            try {
                const id = positiveInt(req.params.id);
                if (!id) return res.status(404).json({ error: 'Venta no encontrada.' });
                const list = await db.all(`SELECT * FROM ${T.packagePayments} WHERE sale_id = ? ORDER BY date DESC, id DESC`, [id]);
                res.json(list.map(x => ({ ...x, amount: money(x.amount) })));
            } catch (e) { sendError(res, e); }
        });
        http.route('post', '/transport/package-sales/:id/payments', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            try {
                const id = positiveInt(req.params.id);
                const { amount, method, reference, date } = req.body || {};
                if (!Number.isFinite(Number(amount)) || Number(amount) > D.MAX_MONEY) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
                const amt = D.roundMoney(amount);
                if (amt <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });
                const m = D.assertPaymentMethod(method);
                const when = date === undefined || date === null || date === '' ? null : D.normDate(date, 'fecha del pago');
                const result = await withAssignmentLock(async () => {
                    const sale = id ? await db.get(`SELECT * FROM ${T.packageSales} WHERE id = ?`, [id]) : null;
                    if (!sale) throw httpError(404, 'Venta no encontrada.');
                    const owed = D.toCents(sale.price) - D.toCents(sale.amount_paid);
                    if (D.toCents(amt) > owed) throw httpError(400, `El pago supera el saldo del paquete (${D.fromCents(Math.max(0, owed)).toFixed(2)}).`);
                    const cols = ['sale_id', 'amount', 'method', 'reference', 'recorded_by'], vals = [sale.id, amt, m, D.shortText(reference, 100), D.reviewerOf(req)];
                    if (when) { cols.push('date'); vals.push(when); }
                    const r = await db.run(`INSERT INTO ${T.packagePayments} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
                    await recomputeSales('id = ?', [sale.id]);
                    return { id: r.lastID };
                });
                res.json({ success: true, ...result });
            } catch (e) { sendError(res, e); }
        });
        http.route('delete', '/transport/package-payments/:id', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'transport', 'manage')) return;
            try {
                const id = positiveInt(req.params.id);
                const pay = id ? await db.get(`SELECT id, sale_id FROM ${T.packagePayments} WHERE id = ?`, [id]) : null;
                if (!pay) return res.status(404).json({ error: 'Pago no encontrado.' });
                await db.run(`DELETE FROM ${T.packagePayments} WHERE id = ?`, [id]);
                await recomputeSales('id = ?', [pay.sale_id]);
                res.json({ success: true });
            } catch (e) { sendError(res, e); }
        });
    }

    return { migrate, install, packagesOf, salesBySeat, recomputeSales };
}

module.exports = { createPackages };
