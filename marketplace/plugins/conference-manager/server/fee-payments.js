/**
 * «Pagos de cuotas» (conference-manager 2.18.0): split fee payments for the admin panel and the
 * coordinator portal.
 *
 * MODEL. A PAYMENT is one receipt (a bank transfer or a cash handover): one row of `payment_transfers` (the
 * HEADER). It is split into PARTS, one per person: rows of the existing `payments` table, linked by
 * `transfer_id` and stamped with the header's allocation generation `alloc_gen`. The STATUS lives on the
 * header only (draft | pending | validated | returned | rejected); a part's own `status` column is a MIRROR
 * written after each transition, for an older plugin after a downgrade and nothing else. The receipt image
 * (`proof`) is stored ONCE, on the header; parts carry none.
 *
 * ONE definition of a part's effective status (EFFECTIVE below): a legacy part (no header) keeps its own
 * status; a linked part counts with its header's status only while it belongs to the header's CURRENT
 * generation. Every reader of money goes through it: an orphan part, a stale generation and a draft never
 * count. `amount_paid` / `payment_status` are recomputed from VALIDATED live parts only (recomputePayments).
 *
 * WRITES WITHOUT TRANSACTIONS (the db bridge has none). Every write runs under one in-memory lock
 * (withPaymentsLock) and is built so that a crash between two statements never counts money twice or
 * loses it:
 *   - create: header INSERT as 'draft' (invisible) → ONE multi-row INSERT of the parts → compare-and-set
 *     flip of the header to 'pending' / 'validated'. A failure in between leaves an invisible draft that the
 *     boot hygiene removes.
 *   - edit (re-split): the attempt MINTS its own generation (a compare-and-set on the header's `gen_seq`:
 *     unique per attempt and always above every earlier one), inserts the new parts with it (invisible),
 *     then ONE header compare-and-set swaps alloc_gen to it (atomic), then the OLDER generations go. A failed
 *     attempt deletes only its own generation; one undone by its re-check (below) puts the split it replaced
 *     back as a FRESH generation (restoreSplit) — never the old one, which another node's boot may have removed.
 *   - transitions: ONE header compare-and-set that also matches the status and generation the caller saw.
 *   - delete: the header first (its parts stop counting at once), then the parts.
 *
 * SEVERAL NODES (documentation/multi-node.md: each node forks its own plugin process, so the in-memory lock
 * only serialises one node). Nothing here relies on being alone: generations are unique per attempt (no
 * attempt can delete or adopt another's parts), the boot hygiene never touches an attempt that may still be
 * in flight elsewhere (a newer generation is left alone for DRAFT_TTL_MS), and the «never overpay» rule is
 * re-checked AFTER each write that adds money (create, edit, validate): if the people's live money is now
 * past what they owe — another node wrote meanwhile — the write is undone and answers 409 over_cap. Of two
 * racing writers at least one sees the other's write in its re-check, so they never both stand.
 *
 * RULES (owner decisions, see documentation/plugins-reference.md): the parts add up to the payment's amount
 * to the cent; nobody may ever be paid more than they owe — each part ≤ due − validated − pending (other
 * payments); the receipt is required for a transfer and optional for cash; the portal records only its own
 * location's people with its enabled methods; an admin payment is born validated unless «Dejar por validar»;
 * a shared payment is validated all-or-nothing; a validated payment is never edited (reject it with a reason,
 * then «Duplicar» re-uses its receipt); one handover counts in ONE payment at a time (`duplicate_of`, see
 * «Duplicar» below — set when the payment is recorded, never changed by a correction).
 *
 * SQL: every statement passes the host guard (own prefixed tables, a space before a closing parenthesis
 * after a table name, no `$`/backslash/brackets) and runs on SQLite, Postgres and MySQL: no UPDATE/DELETE
 * reads its own target table in a subquery (MySQL 1093), no `INSERT … SELECT ?` (Postgres cannot type it).
 */
'use strict';

const split = require('./fee-split');

const MAX_PARTS = split.MAX_PARTS;
const LIVE_STATUSES = ['pending', 'validated', 'returned', 'rejected'];
const STATUS_SET = new Set(['draft', ...LIVE_STATUSES]);
// The state machine (admin unless noted). `edit` is also the portal's, on its own payments.
const TRANSITIONS = Object.freeze({
    validate: { from: ['pending', 'returned', 'rejected'], to: 'validated', note: false },
    return: { from: ['pending'], to: 'returned', note: true },
    reject: { from: ['pending', 'returned', 'validated'], to: 'rejected', note: true },
});
const EDITABLE = ['pending', 'returned'];
const DELETABLE = { admin: ['draft', 'pending', 'returned', 'rejected'], portal: ['pending', 'returned'] };
const NOTE_MAX = 2000;      // a review note (return / reject reason)
const MEMO_MAX = 500;       // the recorder's own note
const REF_MAX = 100;
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
// A crashed create leaves a draft; the boot removes drafts older than this (a day covers any clock offset
// between the database's CURRENT_TIMESTAMP and this process).
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const MSG = Object.freeze({
    empty: 'Selecciona al menos una persona.',
    too_many: `Máximo ${MAX_PARTS} personas por pago.`,
    invalid_id: 'Identificadores de inscripción inválidos.',
    duplicate: 'Una persona aparece dos veces en el reparto.',
    non_positive: 'Cada parte del reparto debe ser mayor que cero.',
    sum_mismatch: 'El reparto no suma el monto del pago.',
    invalid_amount: 'El monto debe ser mayor que cero.',
    invalid_date: 'Fecha del pago inválida.',
    future_date: 'La fecha del pago no puede ser futura.',
    unknown_people: 'Alguna de las personas no pertenece a esta conferencia.',
    unknown_people_location: 'Alguna de las personas no pertenece a tu localidad.',
    cancelled_people: 'Una inscripción cancelada no puede recibir pagos.',
    cancelled_people_validate: 'Este pago incluye una inscripción cancelada, que ya no debe nada: corrige el reparto, reactívala o rechaza el pago.',
    over_cap: 'El pago supera lo que falta por pagar de alguna persona.',
    no_recorder: 'Nadie puede corregir este pago desde el portal (se registró antes de «Pagos de cuotas» o su localidad ya no existe): edítalo tú o recházalo.',
    invalid_proof: 'El comprobante guardado no se puede mostrar: no es una imagen válida o es demasiado grande. Pide uno nuevo.',
    proof_source_invalid: 'El comprobante del pago de origen no es una imagen válida o es demasiado grande: adjunta uno nuevo.',
    proof_required: 'El comprobante es obligatorio para una transferencia.',
    proof_source: 'El pago de origen no tiene comprobante.',
    proof_source_live: 'Anula (rechaza) el pago de origen antes de duplicarlo: mientras cuente, su comprobante no puede registrar otro pago.',
    source_used: 'Este pago anulado ya se registró de nuevo en otro pago que cuenta: un mismo comprobante no puede contar dos veces. Anula o elimina ese otro pago antes.',
    source_fixed: 'Un pago registrado no cambia de pago de origen («Duplicar»): para registrar de nuevo otro pago anulado, usa «Duplicar» en ese pago.',
    duplicate_reference: 'Esa referencia ya se usó en otro pago.',
    invalid_client_key: 'Identificador de envío inválido.',
    client_key_conflict: 'Ese identificador de envío ya se usó para otro pago.',
    client_key_changed: 'Este pago ya se había registrado antes con otros datos: revísalo en «Pagos» en lugar de enviarlo de nuevo.',
    unknown_people_portal: 'Un pago registrado por una localidad solo puede incluir a sus personas: registra a las demás en otro pago.',
    expected_required: 'Falta el estado del pago que estás viendo (expected).',
    unavailable: '«Pagos de cuotas» no está disponible: su migración no se completó (revisa el registro del servidor).',
    // The same state as the coordinator sees it (portal routes): nothing for them to check on the server.
    unavailable_portal: 'Los pagos no están disponibles en este momento; inténtalo más tarde.',
    unavailable_delete: '«Pagos de cuotas» no está disponible (su migración no se completó): una persona con pagos no se puede eliminar hasta que lo esté. Cancela la inscripción en su lugar o inténtalo más tarde.',
    stale: 'Otra persona cambió este pago; vuelve a cargarlo.',
    invalid_transition: 'Este pago no admite esa acción en su estado actual.',
    note_required: 'Escribe el motivo.',
    note_too_long: `El motivo es demasiado largo (máximo ${NOTE_MAX} caracteres).`,
    not_found: 'Pago no encontrado.',
    validated_delete: 'Un pago validado no se puede eliminar; recházalo primero.',
    no_methods: 'La administración no ha habilitado formas de pago para esta localidad.',
});

/**
 * @param base early dependencies (available before the boot migrations): { db, T, P, toCents, fromCents,
 *   addColumnIfMissing, createIndex, createUniqueIndex, httpError }.
 * install(deps) later adds the request-time dependencies and registers the routes.
 */
function createFeePayments(base) {
    const { db, T, P, toCents, fromCents, addColumnIfMissing, createIndex, createUniqueIndex, httpError } = base;
    let D = null;   // request-time dependencies (install)

    const money = (v) => fromCents(toCents(v));
    const feeError = (status, code, message, extra) => {
        const e = httpError(status, message || MSG[code] || code);
        e.code = code;
        if (extra) e.extra = extra;
        return e;
    };
    const sendFeeError = (res, e) => res.status(e && e.status ? e.status : 500).json({
        error: e && e.message ? e.message : String(e),
        ...(e && e.code ? { code: e.code } : {}),
        ...(e && e.extra ? e.extra : {}),
    });
    const ph = (list) => list.map(() => '?').join(', ');

    // ── the lock ────────────────────────────────────────────────────────────────────────────────────
    // Serialises this process's payment writes. Another node has its own: see «SEVERAL NODES» above.
    let lock = Promise.resolve();
    const withPaymentsLock = (fn) => {
        const run = lock.then(fn, fn);
        lock = run.then(() => {}, () => {});
        return run;
    };

    // ── readiness ───────────────────────────────────────────────────────────────────────────────────
    // True once migrate() completed AND its schema answers a probe. Until then (a boot ALTER that failed on
    // a lock timeout, a missing table) every money reader falls back to the pre-2.18 query — the part's own
    // status, no header join — so the roster, the portal and the reports keep working on the mirrored
    // statuses, /portal/login and /portal/me advertise no «Pagos de cuotas», and every route that records or
    // reviews a payment answers 503 `unavailable` after one more migration attempt of its own — the portal's
    // (POST /portal/payments/bulk included) with a message meant for the coordinator: NO payment can be
    // recorded until the migration completes (2.18.0 review R5-L3).
    let ready = false;
    let retrying = null;

    // ── SQL building blocks ────────────────────────────────────────────────────────────────────────
    /** THE effective status of a part `p` joined (LEFT JOIN) to its header `t`. */
    const EFFECTIVE = (p = 'p', t = 't') => (ready
        ? `(CASE WHEN ${p}.transfer_id IS NULL THEN ${p}.status WHEN ${p}.alloc_gen = ${t}.alloc_gen THEN ${t}.status ELSE NULL END)`
        : `${p}.status`);
    /** parts + their header, aliased for subqueries so they never shadow a caller's own aliases. */
    const PARTS = (p = 'xp', t = 'xt') => (ready ? `${T.payments} ${p} LEFT JOIN ${T.transfers} ${t} ON ${t}.id = ${p}.transfer_id` : `${T.payments} ${p}`);
    /** Scalar: one person's live money in one status. `insRef` is the outer inscription id expression. */
    const personSum = (status, insRef) => {
        if (!STATUS_SET.has(status)) throw new Error(`personSum: unknown status ${status}`);
        return `(SELECT COALESCE(SUM(xp.amount), 0) FROM ${PARTS()} WHERE xp.inscription_id = ${insRef} AND ${EFFECTIVE('xp', 'xt')} = '${status}' )`;
    };
    /** Derived table m(iid, validated, pending, returned) of ONE conference (bind its id once). Built per use (readiness). */
    const personMoney = () => `(SELECT xp.inscription_id AS iid,`
        + ` SUM(CASE WHEN ${EFFECTIVE('xp', 'xt')} = 'validated' THEN xp.amount ELSE 0 END) AS validated,`
        + ` SUM(CASE WHEN ${EFFECTIVE('xp', 'xt')} = 'pending' THEN xp.amount ELSE 0 END) AS pending,`
        + ` SUM(CASE WHEN ${EFFECTIVE('xp', 'xt')} = 'returned' THEN xp.amount ELSE 0 END) AS returned`
        + ` FROM ${PARTS()} JOIN ${T.inscriptions} xi ON xi.id = xp.inscription_id WHERE xi.conference_id = ? GROUP BY xp.inscription_id )`;
    /** 1 when the header (or, for a wrapped legacy payment, its original row) holds a receipt. */
    const HAS_PROOF = (t = 't') => `(CASE WHEN ${t}.proof IS NOT NULL AND ${t}.proof <> '' THEN 1`
        + ` WHEN ${t}.legacy_payment_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${T.payments} lp WHERE lp.id = ${t}.legacy_payment_id AND lp.proof IS NOT NULL AND lp.proof <> '' ) THEN 1 ELSE 0 END)`;
    // Header columns for every read — never `t.*`, which would carry the receipt image.
    const HEADER_COLS = 't.id, t.conference_id, t.location_id, t.amount, t.method, t.reference, t.paid_on, t.note, t.status, t.review_note,'
        + ' t.alloc_gen, t.recorded_via, t.recorded_by, t.legacy_payment_id, t.created_at, t.submitted_at, t.updated_at, t.updated_by,'
        + ` t.reviewed_at, t.reviewed_by, t.duplicate_of, ${HAS_PROOF('t')} AS has_proof`;

    /**
     * Set-based recompute of amount_paid / payment_status: ONE statement for a set of inscriptions
     * (`where` = 'id = ?' | 'id IN (?, …)' | 'conference_id = ?' | '1 = 1'), from VALIDATED live parts only.
     * No read-in-JS-then-write, so two concurrent writers cannot lose an update. `+ 0.005` = half-cent
     * tolerance (ROUND(x, 2) is not portable).
     */
    async function recomputePayments(where, params) {
        const paid = personSum('validated', `${T.inscriptions}.id`);
        await db.run(`UPDATE ${T.inscriptions}
            SET amount_paid = ${paid},
                payment_status = CASE
                    WHEN total_due <= 0 THEN 'paid'
                    WHEN ${paid} + 0.005 >= total_due THEN 'paid'
                    WHEN ${paid} > 0 THEN 'partial'
                    ELSE 'unpaid' END
            WHERE ${where}`, params);
    }
    const recomputeIds = async (ids) => {
        const list = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
        for (let i = 0; i < list.length; i += MAX_PARTS) {
            const chunk = list.slice(i, i + MAX_PARTS);
            await recomputePayments(`id IN (${ph(chunk)})`, chunk);
        }
    };

    // ── schema + boot ────────────────────────────────────────────────────────────────────────────────
    async function migrate() {
        await db.createTable(T.transfers, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            // The recorder's location (the portal's own; NULL = an admin payment spanning several locations
            // or none). Plain column, no FK: DELETE /locations/:id nulls it explicitly.
            'location_id INT',
            'amount REAL NOT NULL',            // the receipt's total = Σ live parts (checked in JS cents on write)
            'method TEXT NOT NULL',
            'reference TEXT',
            'paid_on DATETIME',                // the bank / cash date the recorder typed (the ledger date)
            'note TEXT',
            'proof TEXT',                      // the receipt (image data URL), stored ONCE
            "status VARCHAR(16) NOT NULL DEFAULT 'draft'",
            'review_note TEXT',                // the admin's last return / reject reason
            'alloc_gen INT NOT NULL DEFAULT 1',
            'recorded_via VARCHAR(8)',         // portal | admin | legacy
            'recorded_by TEXT',                // 'portal:<location id>' or the admin's login
            'client_key VARCHAR(64)',          // idempotency key of the recorder's draft
            'legacy_payment_id INT',           // the wrapped pre-2.18 payment row
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'submitted_at DATETIME',
            'updated_at DATETIME',
            'updated_by TEXT',
            'reviewed_at DATETIME',
            'reviewed_by TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        // Append-only history («Historial»). Written after each transition; losing a line loses only the line.
        await db.createTable(T.transferEvents, [
            'id INT_PK',
            'transfer_id INT NOT NULL',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'actor TEXT',
            'action VARCHAR(16) NOT NULL',
            'note TEXT',
        ]);
        // The last generation an edit attempt minted (mintGeneration); NULL until the first edit.
        await addColumnIfMissing(T.transfers, 'gen_seq', 'INT');
        // «Duplicar»: the voided payment this one records again — the ROOT of the chain (see liveFamily).
        await addColumnIfMissing(T.transfers, 'duplicate_of', 'INT');
        // The parts: existing payment rows gain their header and generation (both NULL on legacy rows), and
        // when the row was written (NULL on legacy rows): the boot hygiene leaves a newer generation alone
        // while it may still belong to an edit in flight on another node.
        await addColumnIfMissing(T.payments, 'transfer_id', 'INT');
        await addColumnIfMissing(T.payments, 'alloc_gen', 'INT');
        await addColumnIfMissing(T.payments, 'created_at', 'DATETIME');
        await createIndex(`${P}idx_payments_inscription`, T.payments, 'inscription_id');
        await createIndex(`${P}idx_payments_transfer`, T.payments, 'transfer_id, alloc_gen');
        await createIndex(`${P}idx_transfers_conf_status`, T.transfers, 'conference_id, status');
        await createIndex(`${P}idx_transfers_location`, T.transfers, 'location_id');
        await createIndex(`${P}idx_transfers_duplicate_of`, T.transfers, 'duplicate_of');
        await createIndex(`${P}idx_transfer_events_transfer`, T.transferEvents, 'transfer_id');
        // Load-bearing (they make the replay and the wrap race-free); several NULLs are fine on all 3 engines.
        await createUniqueIndex(`${P}uidx_transfers_client_key`, T.transfers, 'client_key');
        await createUniqueIndex(`${P}uidx_transfers_legacy`, T.transfers, 'legacy_payment_id');
        // addColumnIfMissing logs and swallows a failed ALTER: the probe is what says the schema is there.
        await probeSchema();
        ready = true;
        await wrapLegacyPayments();
    }
    /** Throws unless every table and column the model reads exists. */
    const probeSchema = () => db.all(`SELECT xp.id, xp.transfer_id, xp.alloc_gen, xp.created_at, xt.id AS tid, xt.gen_seq, xt.duplicate_of, xe.id AS eid`
        + ` FROM ${T.payments} xp LEFT JOIN ${T.transfers} xt ON xt.id = xp.transfer_id LEFT JOIN ${T.transferEvents} xe ON xe.transfer_id = xt.id WHERE 1 = 0`);
    /**
     * The fee routes' gate: ready, or one more migration attempt (single-flight). False when it still fails —
     * the route answers 503 `unavailable` and the failure is logged.
     */
    async function ensureReady() {
        if (ready) return true;
        if (!retrying) {
            retrying = migrate()
                .catch((e) => { console.warn('[conference-manager] fee payments migration retry failed:', e && e.message); })
                .finally(() => { retrying = null; });
        }
        await retrying;
        return ready;
    }

    /**
     * D-P13: every pre-2.18 payment becomes a 1-part payment (old group payments become N single ones).
     * Two set-based statements, idempotent (NOT EXISTS + the unique index): the header copies the row
     * (amount, method, reference, date, status, review stamps — the receipt is NOT copied: the proof
     * endpoint reads it through legacy_payment_id), then the row is linked to it. Between the two, readers
     * still count the row through EFFECTIVE's legacy branch, and a header without a linked part is
     * invisible. An unknown legacy status is wrapped as 'rejected' (it counted nowhere before either).
     * `only` narrows it to one conference or one payment row (the lazy wrap).
     */
    async function wrapLegacyPayments(only = {}) {
        let extra = '';
        const params = [];
        if (only.conferenceId) { extra += ' AND i.conference_id = ?'; params.push(only.conferenceId); }
        if (only.paymentId) { extra += ' AND p.id = ?'; params.push(only.paymentId); }
        await db.run(`INSERT INTO ${T.transfers} (conference_id, location_id, amount, method, reference, paid_on, status,`
            + ` reviewed_at, reviewed_by, recorded_via, created_at, submitted_at, legacy_payment_id, alloc_gen)`
            + ` SELECT i.conference_id, i.location_id, p.amount, COALESCE(p.method, ''), p.reference, p.date,`
            + ` CASE WHEN p.status IN ('pending', 'validated', 'rejected') THEN p.status ELSE 'rejected' END,`
            + ` p.reviewed_at, p.reviewed_by, 'legacy', COALESCE(p.date, CURRENT_TIMESTAMP), p.date, p.id, 1`
            + ` FROM ${T.payments} p JOIN ${T.inscriptions} i ON i.id = p.inscription_id`
            + ` WHERE p.transfer_id IS NULL AND NOT EXISTS (SELECT 1 FROM ${T.transfers} x WHERE x.legacy_payment_id = p.id )${extra}`, params);
        await db.run(`UPDATE ${T.payments} SET transfer_id = (SELECT x.id FROM ${T.transfers} x WHERE x.legacy_payment_id = ${T.payments}.id ), alloc_gen = 1`
            + ` WHERE transfer_id IS NULL AND EXISTS (SELECT 1 FROM ${T.transfers} x WHERE x.legacy_payment_id = ${T.payments}.id )`);
    }
    /** The lazy wrap (a boot wrap that failed gets another chance), only when there is something to wrap. */
    async function ensureWrapped(conferenceId) {
        if (!ready) return;
        const row = await db.get(`SELECT p.id FROM ${T.payments} p JOIN ${T.inscriptions} i ON i.id = p.inscription_id WHERE i.conference_id = ? AND p.transfer_id IS NULL`, [conferenceId]);
        if (row) await withPaymentsLock(() => wrapLegacyPayments({ conferenceId }));
    }

    const utcStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    /**
     * Boot hygiene (after the migrations, before the recompute). Each statement reads ANOTHER table in its
     * subquery (MySQL 1093). Drafts older than DRAFT_TTL_MS (a crashed create) go with their parts; parts of
     * a missing header go; parts of an OLDER generation than the header's go (no attempt can ever make them
     * live again: generations only grow); parts of a NEWER generation go only once older than DRAFT_TTL_MS —
     * until then they may be an edit in flight on another node (a rolling restart). A live header without a
     * live part and a header of a deleted conference go; a header naming a deleted location names none; the
     * part mirrors of the header's LIVE generation are
     * re-written from their header — never a newer generation's, which keeps its 'draft' mirror (partsInsert):
     * an edit that crashed or is still running must not count for a reader of the parts' own status (degraded
     * mode, an older plugin after a downgrade).
     */
    async function bootHygiene() {
        if (!ready) return;
        const cutoff = utcStamp(Date.now() - DRAFT_TTL_MS);
        await db.run(`DELETE FROM ${T.payments} WHERE transfer_id IN (SELECT x.id FROM ${T.transfers} x WHERE x.status = 'draft' AND x.created_at < ? )`, [cutoff]);
        await db.run(`DELETE FROM ${T.transfers} WHERE status = 'draft' AND created_at < ?`, [cutoff]);
        await db.run(`DELETE FROM ${T.transfers} WHERE conference_id NOT IN (SELECT c.id FROM ${T.conferences} c )`);
        await db.run(`DELETE FROM ${T.payments} WHERE transfer_id IS NOT NULL AND transfer_id NOT IN (SELECT x.id FROM ${T.transfers} x )`);
        await db.run(`DELETE FROM ${T.payments} WHERE transfer_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${T.transfers} x WHERE x.id = ${T.payments}.transfer_id`
            + ` AND x.status <> 'draft' AND (${T.payments}.alloc_gen IS NULL OR ${T.payments}.alloc_gen < x.alloc_gen`
            + ` OR (${T.payments}.alloc_gen > x.alloc_gen AND (${T.payments}.created_at IS NULL OR ${T.payments}.created_at < ?))) )`, [cutoff]);
        await db.run(`DELETE FROM ${T.transfers} WHERE ${T.transfers}.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM ${T.payments} xp WHERE xp.transfer_id = ${T.transfers}.id AND xp.alloc_gen = ${T.transfers}.alloc_gen )`);
        await db.run(`DELETE FROM ${T.transferEvents} WHERE transfer_id NOT IN (SELECT x.id FROM ${T.transfers} x )`);
        // A header never names a deleted location (a delete on another node while its payment was recorded:
        // detachIfGone covers it at once; this covers a crash in between) — «Devolver» needs a live portal.
        await db.run(`UPDATE ${T.transfers} SET location_id = NULL WHERE location_id IS NOT NULL AND location_id NOT IN (SELECT l.id FROM ${T.locations} l )`);
        await db.run(`UPDATE ${T.payments} SET status = (SELECT x.status FROM ${T.transfers} x WHERE x.id = ${T.payments}.transfer_id AND x.alloc_gen = ${T.payments}.alloc_gen )`
            + ` WHERE transfer_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${T.transfers} x WHERE x.id = ${T.payments}.transfer_id AND x.alloc_gen = ${T.payments}.alloc_gen`
            + ` AND x.status <> 'draft' AND (${T.payments}.status IS NULL OR x.status <> ${T.payments}.status) )`);
    }

    // ── small parsers ─────────────────────────────────────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, '0');
    const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    /** The payment date: 'YYYY-MM-DD' (a datetime keeps its day); default today; never after tomorrow. */
    function parseDay(v) {
        if (v === undefined || v === null || v === '') return localDay(new Date());
        if (typeof v !== 'string') throw feeError(400, 'invalid_date');
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(v.trim());
        if (!m) throw feeError(400, 'invalid_date');
        const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (y < 2000 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw feeError(400, 'invalid_date');
        const day = `${m[1]}-${m[2]}-${m[3]}`;
        if (day > localDay(new Date(Date.now() + 24 * 60 * 60 * 1000))) throw feeError(400, 'future_date');
        return day;
    }
    /**
     * A stored DATETIME → its 'YYYY-MM-DD'. SQLite and MySQL (dateStrings) hand back 'YYYY-MM-DD HH:MM:SS';
     * Postgres hands a TIMESTAMP back as a Date built from the server's LOCAL time (an ISO string with a zone
     * once it crossed the bridge as JSON): its day is read back in local time — slicing the UTC form would
     * move a payment dated '2026-10-07' to the 6th on a server east of UTC.
     */
    const dayOut = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : localDay(v);
        const s = String(v);
        if (/^\d{4}-\d{2}-\d{2}T[^ ]*(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
            const d = new Date(s);
            if (!Number.isNaN(d.getTime())) return localDay(d);
        }
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
        return m ? m[1] : s;
    };
    const text = (v, max) => {
        if (v === undefined || v === null) return null;
        const s = String(v).trim();
        return s ? s.slice(0, max) : null;
    };
    /** A money value of a body (number or plain decimal string) → cents, or null. */
    const centsOfBody = (v) => {
        if (typeof v !== 'number' && typeof v !== 'string') return null;
        if (typeof v === 'string' && !/^\s*[0-9]+(?:\.[0-9]+)?\s*$/.test(v)) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1e13) return null;
        return toCents(n);
    };
    const refKey = (r) => String(r || '').trim().toLowerCase();

    /**
     * A create / edit body → the normalised draft. No database. Throws 400 with a `code`.
     *   { amount, method, paid_on?, reference?, note?, proof? | null, client_key?, copy_proof_from?, duplicate_of?,
     *     allow_duplicate_reference?, leave_pending?, allocations: [{ inscription_id, amount }]
     *     | inscription_ids: [...] with split: 'equal' }
     */
    function parseBody(body, { methods } = {}) {
        const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        const totalC = centsOfBody(src.amount);
        if (totalC === null || totalC <= 0) throw feeError(400, 'invalid_amount');
        const method = D.assertPaymentMethod(src.method, methods);
        let parts;
        let mode = 'manual';
        if (Array.isArray(src.allocations)) {
            if (src.allocations.length > MAX_PARTS) throw feeError(400, 'too_many', null, { max: MAX_PARTS });
            parts = src.allocations.map(a => ({ inscription_id: D.positiveInt(a && a.inscription_id), cents: centsOfBody(a && a.amount) }));
        } else if (Array.isArray(src.inscription_ids)) {
            if (src.split !== undefined && src.split !== 'equal') throw feeError(400, 'empty', 'Modo de reparto inválido.');
            if (src.inscription_ids.length > MAX_PARTS) throw feeError(400, 'too_many', null, { max: MAX_PARTS });
            const ids = src.inscription_ids.map(D.positiveInt);
            if (ids.some(n => !n)) throw feeError(400, 'invalid_id');
            const uniq = [...new Set(ids)];
            if (uniq.length !== ids.length) throw feeError(400, 'duplicate', null, { ids: ids.filter((x, i) => ids.indexOf(x) !== i) });
            const cents = split.splitEqual(totalC, uniq.length);
            parts = uniq.map((id, i) => ({ inscription_id: id, cents: cents[i] }));
            mode = 'equal';
        } else throw feeError(400, 'empty');
        const v = split.validateAllocations(parts, totalC, MAX_PARTS);
        if (!v.ok) {
            const extra = {};
            if (v.ids) extra.ids = v.ids;
            if (v.code === 'sum_mismatch') { extra.assigned = fromCents(v.assigned); extra.diff = fromCents(v.diff); }
            if (v.code === 'too_many') extra.max = MAX_PARTS;
            throw feeError(400, v.code, null, Object.keys(extra).length ? extra : undefined);
        }
        let proof;   // undefined = not sent (keep); null = remove; string = the new receipt
        if (src.proof === null) proof = null;
        else if (src.proof !== undefined && src.proof !== '') proof = D.assertProof(src.proof);
        let clientKey = null;
        if (src.client_key !== undefined && src.client_key !== null && src.client_key !== '') {
            if (typeof src.client_key !== 'string' || !CLIENT_KEY_RE.test(src.client_key)) throw feeError(400, 'invalid_client_key');
            clientKey = src.client_key;
        }
        const copyFrom = src.copy_proof_from === undefined || src.copy_proof_from === null || src.copy_proof_from === '' ? null : D.positiveInt(src.copy_proof_from);
        if (src.copy_proof_from != null && src.copy_proof_from !== '' && !copyFrom) throw feeError(400, 'proof_source', 'Pago de origen inválido.');
        // «Duplicar» without copying the receipt (cash without a photo, or a new photo): the voided payment it
        // records again. With copy_proof_from it is that payment (both, when sent, must name the same one).
        const dupOf = src.duplicate_of === undefined || src.duplicate_of === null || src.duplicate_of === '' ? null : D.positiveInt(src.duplicate_of);
        if (src.duplicate_of != null && src.duplicate_of !== '' && !dupOf) throw feeError(400, 'proof_source', 'Pago de origen inválido.');
        if (copyFrom && dupOf && copyFrom !== dupOf) throw feeError(400, 'proof_source', 'Pago de origen inválido.');
        return {
            totalC, method, parts, mode,
            paidOn: parseDay(src.paid_on),
            // Whether the request named its date (one that did not means «today», whatever day it is replayed).
            paidOnGiven: !(src.paid_on === undefined || src.paid_on === null || src.paid_on === ''),
            reference: text(src.reference, REF_MAX),
            note: text(src.note, MEMO_MAX),
            proof, clientKey, copyFrom, sourceId: copyFrom || dupOf || null,
            allowDuplicateReference: src.allow_duplicate_reference === true || src.allow_duplicate_reference === 1 || src.allow_duplicate_reference === '1',
            leavePending: src.leave_pending === true || src.leave_pending === 1 || src.leave_pending === '1' || src.validate === false,
        };
    }
    function parseExpected(raw, required) {
        if (raw === undefined || raw === null) {
            if (required) throw feeError(400, 'expected_required');
            return null;
        }
        const st = raw && typeof raw === 'object' ? raw.status : undefined;
        const gen = raw && typeof raw === 'object' ? D.positiveInt(raw.alloc_gen) : null;
        if (!STATUS_SET.has(st) || !gen) throw feeError(400, 'expected_required');
        return { status: st, alloc_gen: gen };
    }
    function parseNote(raw, required) {
        const s = raw === undefined || raw === null ? '' : String(raw).trim();
        if (!s) { if (required) throw feeError(400, 'note_required'); return null; }
        if (s.length > NOTE_MAX) throw feeError(400, 'note_too_long');
        return s;
    }

    // ── reads ─────────────────────────────────────────────────────────────────────────────────────────
    const header = (id) => db.get(`SELECT ${HEADER_COLS}, t.client_key FROM ${T.transfers} t WHERE t.id = ?`, [id]);
    const liveParts = (transferId) => db.all(
        `SELECT p.id, p.inscription_id, p.amount FROM ${T.payments} p JOIN ${T.transfers} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen WHERE t.id = ? ORDER BY p.id`, [transferId]);

    /**
     * A STORED receipt passes the same rule as a new one (index.js assertProof: an image data URL whose header
     * declares ≤ 8192 px a side and ≤ 24 MP). Receipts written before 2.18 were only checked against the
     * data-URL pattern and the size in characters: one may declare 30000 × 30000 px, and the admin review
     * queue opens the oldest receipt by itself — the tab would try to decode gigabytes. Such a receipt is
     * never served, copied («Duplicar») or moved onto a header.
     */
    const storedProofOk = (p) => {
        try { D.assertProof(p); return true; } catch { return false; }
    };
    /** The receipt of a payment (its own, else its wrapped legacy row's): { proof, invalid }. */
    async function proofRead(h) {
        const row = await db.get(`SELECT proof, legacy_payment_id FROM ${T.transfers} WHERE id = ?`, [h.id]);
        let p = row && row.proof ? row.proof : null;
        if (!p && row && row.legacy_payment_id != null) {
            const lp = await db.get(`SELECT proof FROM ${T.payments} WHERE id = ?`, [row.legacy_payment_id]);
            p = lp && lp.proof ? lp.proof : null;
        }
        if (!p) return { proof: null, invalid: false };
        return storedProofOk(p) ? { proof: p, invalid: false } : { proof: null, invalid: true };
    }
    /** The receipt that may be shown or copied, or null (none, or one that fails the rule above). */
    const proofOf = async (h) => (await proofRead(h)).proof;

    /** Headers + their LIVE parts. `where` reads only `t` (code-built). Headers without a live part are dropped. */
    async function transfersWhere(where, params) {
        const headers = await db.all(`SELECT ${HEADER_COLS}, l.name AS location_name FROM ${T.transfers} t LEFT JOIN ${T.locations} l ON l.id = t.location_id`
            + ` WHERE t.status <> 'draft' AND ${where} ORDER BY t.id DESC`, params);
        if (!headers.length) return [];
        const parts = await db.all(`SELECT p.id, p.transfer_id, p.inscription_id, p.amount, i.location_id, i.status AS ins_status`
            + ` FROM ${T.payments} p JOIN ${T.transfers} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen`
            + ` LEFT JOIN ${T.inscriptions} i ON i.id = p.inscription_id WHERE t.status <> 'draft' AND ${where} ORDER BY p.id`, params);
        const byT = new Map();
        for (const p of parts) {
            const k = Number(p.transfer_id);
            if (!byT.has(k)) byT.set(k, []);
            byT.get(k).push(p);
        }
        return headers.filter(h => byT.has(Number(h.id))).map(h => ({ h, parts: byT.get(Number(h.id)) }));
    }

    /** The people of a conference (optionally one location) with their live money. */
    async function peopleMoney(conferenceId, locationId) {
        let sql = `SELECT i.id, i.location_id, i.status, i.total_due, COALESCE(m.validated, 0) AS validated, COALESCE(m.pending, 0) AS pending,`
            + ` COALESCE(m.returned, 0) AS returned FROM ${T.inscriptions} i LEFT JOIN ${personMoney()} m ON m.iid = i.id WHERE i.conference_id = ?`;
        const params = [conferenceId, conferenceId];
        if (locationId !== undefined && locationId !== null) { sql += ' AND i.location_id = ?'; params.push(locationId); }
        return db.all(sql + ' ORDER BY i.id', params);
    }
    /** One person's money state (D: due is 0 for a cancelled inscription). All arithmetic in cents. */
    function balanceOf(r) {
        const cancelled = r.status === 'cancelled';
        const dueC = cancelled ? 0 : Math.max(0, toCents(r.total_due));
        const valC = toCents(r.validated), pendC = toCents(r.pending), retC = toCents(r.returned);
        const coverC = Math.max(0, dueC - valC - pendC);
        const creditC = Math.max(0, valC - dueC);
        return {
            c: { due: dueC, validated: valC, pending: pendC, returned: retC, to_cover: coverC, credit: creditC },
            wire: {
                id: r.id, location_id: r.location_id == null ? null : r.location_id,
                total_due: money(r.total_due), due: fromCents(dueC), validated: fromCents(valC), pending: fromCents(pendC),
                returned: fromCents(retC), to_cover: fromCents(coverC), credit: fromCents(creditC),
                cancelled, payable: !cancelled && coverC > 0,
            },
        };
    }
    const SUM_KEYS = ['due', 'validated', 'pending', 'returned', 'to_cover', 'credit'];
    /** The «Resumen» (fee-split summaryOf: Validado + Por validar + Por cobrar = Cuotas, credit apart). */
    function summarize(balances) {
        const s = split.summaryOf(balances.map(b => ({ ...b.c, cancelled: b.wire.cancelled })));
        return { people: s.people, cancelled: s.cancelled, ...Object.fromEntries(SUM_KEYS.map(k => [k, fromCents(s[k])])) };
    }

    /**
     * «Reportes» (/reports/summary) on the SAME per-person model as «Pagos de cuotas» › Resumen and the
     * Dashboard. `rows`: { location, status, total_due, payment_status, validated, pending, returned } per
     * inscription. Per group (the whole conference, then each location label):
     *   - due / paid / pending / to_cover / credit / returned = the Resumen's Cuotas / Validado / Por validar /
     *     Por cobrar / A favor / Devuelto (summaryOf): a cancelled person owes nothing and their money counts
     *     only as «A favor», so due − paid (= Por validar + Por cobrar) never goes negative;
     *   - paid_count / partial_count / unpaid_count: the roster pills (validated money only) of ACTIVE people;
     *     cancelled_count apart; owing_count = active people with something no payment covers yet
     *     (to_cover > 0 — the Dashboard's «Con saldo», the Saldos filter of the same name).
     */
    function reportFigures(rows) {
        const group = (list) => {
            const s = summarize(list.map(x => x.b));
            const n = { paid_count: 0, partial_count: 0, unpaid_count: 0, owing_count: 0, cancelled_count: 0 };
            for (const { r, b } of list) {
                if (b.wire.cancelled) { n.cancelled_count++; continue; }
                const pill = ['paid', 'partial', 'unpaid'].includes(r.payment_status) ? r.payment_status
                    : (b.c.due <= 0 || b.c.validated >= b.c.due ? 'paid' : b.c.validated > 0 ? 'partial' : 'unpaid');
                n[`${pill}_count`]++;
                if (b.c.to_cover > 0) n.owing_count++;
            }
            return { count: list.length, people: s.people, due: s.due, paid: s.validated, pending: s.pending, to_cover: s.to_cover, credit: s.credit, returned: s.returned, ...n };
        };
        const all = (rows || []).map(r => ({ r, b: balanceOf(r) }));
        const byLabel = new Map();
        for (const x of all) {
            const k = x.r.location == null || x.r.location === '' ? '—' : String(x.r.location);
            if (!byLabel.has(k)) byLabel.set(k, []);
            byLabel.get(k).push(x);
        }
        const byLocation = [...byLabel.entries()].map(([location, list]) => ({ location, ...group(list) }))
            .sort((a, b) => b.count - a.count || a.location.localeCompare(b.location));
        return { totals: group(all), byLocation };
    }

    /** The wire shape of one payment (admin). Parts carry ids and amounts; names come from the roster. */
    function wireTransfer(x) {
        const { h, parts } = x;
        const allocatedC = parts.reduce((s, p) => s + toCents(p.amount), 0);
        const locs = [...new Set(parts.map(p => p.location_id).filter(v => v != null).map(Number))].sort((a, b) => a - b);
        return {
            id: h.id, conference_id: h.conference_id, location_id: h.location_id == null ? null : h.location_id,
            location: h.location_name || null, locations: locs, mixed: locs.length > 1,
            amount: money(h.amount), allocated: fromCents(allocatedC), method: h.method || '', reference: h.reference || null,
            paid_on: dayOut(h.paid_on), note: h.note || null, status: h.status, review_note: h.review_note || null,
            alloc_gen: Number(h.alloc_gen), recorded_via: h.recorded_via || null, recorded_by: h.recorded_by || null,
            created_at: h.created_at || null, submitted_at: h.submitted_at || null, updated_at: h.updated_at || null,
            updated_by: h.updated_by || null, reviewed_at: h.reviewed_at || null, reviewed_by: h.reviewed_by || null,
            has_proof: !!Number(h.has_proof), legacy: h.recorded_via === 'legacy',
            // «Duplicar»: the voided payment this one records again (the root of its family), and the payments
            // of its family that count now besides this one (adminView / adminDetail fill it).
            duplicate_of: h.duplicate_of == null ? null : Number(h.duplicate_of), reused_by: [],
            people: parts.length,
            allocations: parts.map(p => ({
                id: p.id, inscription_id: p.inscription_id, amount: money(p.amount),
                location_id: p.location_id == null ? null : p.location_id, cancelled: p.ins_status === 'cancelled',
            })),
            flags: { cancelled_people: parts.filter(p => p.ins_status === 'cancelled').map(p => p.inscription_id), duplicate_reference: false },
        };
    }
    /** Marks payments that share a transfer reference with another live one («Referencia repetida»). */
    function flagDuplicateReferences(list) {
        const seen = new Map();
        for (const t of list) {
            if (t.method !== 'Transferencia' || !refKey(t.reference) || t.status === 'rejected') continue;
            const k = refKey(t.reference);
            seen.set(k, (seen.get(k) || 0) + 1);
        }
        for (const t of list) {
            if (t.method === 'Transferencia' && refKey(t.reference) && t.status !== 'rejected' && seen.get(refKey(t.reference)) > 1) t.flags.duplicate_reference = true;
        }
    }
    /**
     * «Duplicar» families (liveFamily) within one conference's list: each payment learns which OTHER payments
     * of its family count now (`reused_by`) — on a voided one, the copy that records it again: it cannot be
     * validated or duplicated again while that copy counts.
     */
    function markReused(list) {
        const live = new Map();
        for (const t of list) {
            if (!['pending', 'validated', 'returned'].includes(t.status)) continue;
            const k = t.duplicate_of != null ? t.duplicate_of : t.id;
            if (!live.has(k)) live.set(k, []);
            live.get(k).push({ id: t.id, status: t.status });
        }
        for (const t of list) {
            const k = t.duplicate_of != null ? t.duplicate_of : t.id;
            t.reused_by = (live.get(k) || []).filter(m => m.id !== t.id);
        }
    }
    const countsOf = (list) => {
        const c = { pending: 0, validated: 0, returned: 0, rejected: 0, total: list.length };
        for (const t of list) if (c[t.status] !== undefined) c[t.status]++;
        return c;
    };

    /**
     * Who each person of the conference is — ALL «Pagos de cuotas» knows about them (D-P20: Pagos › ver does
     * not read the roster): the display name (personName: Nombre + Apellido, else the form's name fallback
     * fields — never a contact, an ID document or a note), the live location, the family group, the
     * inscription status and, for inscriptions:view only, the registration code. No email, phone, form
     * answer, room or note.
     */
    async function peopleIdentity(cid, showCodes) {
        const cols = await D.nameFallbackColumns(cid);
        const rows = await db.all(`SELECT i.id, i.first_name, i.last_name, i.family_group, i.status, i.reg_code, i.location, i.location_id, l.name AS location_name`
            + `${cols.map(c => `, i.${c}`).join('')} FROM ${T.inscriptions} i LEFT JOIN ${T.locations} l ON l.id = i.location_id WHERE i.conference_id = ?`, [cid]);
        return new Map(rows.map(r => [Number(r.id), {
            name: D.personName(r, cols),
            location: r.location_id == null ? null : (r.location_name || r.location || null),
            family_group: r.family_group == null || String(r.family_group).trim() === '' ? null : String(r.family_group),
            status: r.status || null,
            reg_code: showCodes ? (r.reg_code || null) : null,
        }]));
    }

    /** GET /fee-payments. `opts.showCodes`: the caller may read registration codes (inscriptions:view). */
    async function adminView(cid, q = {}, opts = {}) {
        const rows = await peopleMoney(cid);
        const balances = rows.map(balanceOf);
        const who = await peopleIdentity(cid, !!opts.showCodes);
        const locations = await db.all(`SELECT id, name FROM ${T.locations} WHERE conference_id = ? ORDER BY name, id`, [cid]);
        const buckets = new Map(locations.map(l => [String(l.id), { location_id: l.id, location: l.name, list: [] }]));
        for (const b of balances) {
            const k = b.wire.location_id == null ? 'null' : String(b.wire.location_id);
            if (!buckets.has(k)) buckets.set(k, { location_id: k === 'null' ? null : b.wire.location_id, location: null, list: [] });
            buckets.get(k).list.push(b);
        }
        const byLocation = [...buckets.values()]
            .sort((a, b) => (a.location_id == null) - (b.location_id == null))
            .map(g => ({ location_id: g.location_id, location: g.location, ...summarize(g.list) }));
        const all = (await transfersWhere('t.conference_id = ?', [cid])).map(wireTransfer);
        flagDuplicateReferences(all);
        markReused(all);
        let list = all;
        const statuses = typeof q.status === 'string' && q.status ? q.status.split(',').filter(s => STATUS_SET.has(s)) : null;
        if (statuses) list = list.filter(t => statuses.includes(t.status));
        if (q.location_id !== undefined && q.location_id !== '') {
            // A payment belongs to the recorder's location and to each of its people's — «Sin localidad»
            // (`none`) included when one of its people has none (the admin's «Pagos» and «Contabilidad» filters).
            const none = q.location_id === 'none';
            const lid = none ? null : D.positiveInt(q.location_id);
            list = none ? list.filter(t => t.location_id == null && (!t.locations.length || t.allocations.some(a => a.location_id == null)))
                : !lid ? [] : list.filter(t => Number(t.location_id) === lid || t.locations.includes(lid));
        }
        const iid = q.inscription_id !== undefined ? D.positiveInt(q.inscription_id) : null;
        if (iid) list = list.filter(t => t.allocations.some(a => Number(a.inscription_id) === iid));
        if (typeof q.recorded_via === 'string' && q.recorded_via) list = list.filter(t => t.recorded_via === q.recorded_via);
        if (typeof q.method === 'string' && q.method) list = list.filter(t => t.method === q.method);
        // Payment date range, inclusive ('YYYY-MM-DD' compare as text).
        const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
        const fromDay = day(q.from), toDay = day(q.to);
        if (fromDay) list = list.filter(t => t.paid_on && t.paid_on >= fromDay);
        if (toDay) list = list.filter(t => t.paid_on && t.paid_on <= toDay);
        return {
            conference_id: cid,
            features: { fee_payments: 1 },
            methods: D.PAYMENT_METHODS.slice(),
            max_people: MAX_PARTS,
            proof: { required_for: ['Transferencia'], max_chars: D.MAX_PROOF_CHARS },
            summary: summarize(balances),
            by_location: byLocation,
            counts: countsOf(all),
            transfers: list,
            people: balances.map(b => ({ ...b.wire, ...(who.get(Number(b.wire.id)) || { name: `#${b.wire.id}`, location: null, family_group: null, status: null, reg_code: null }) })),
        };
    }

    /** One payment with the facts of each person in it (admin TransferSheet) and its history. */
    async function adminDetail(id) {
        const [x] = await transfersWhere('t.id = ?', [id]);
        if (!x) return null;
        const t = wireTransfer(x);
        const ids = x.parts.map(p => Number(p.inscription_id));
        const cols = await D.nameFallbackColumns(x.h.conference_id);
        const people = ids.length ? await db.all(
            `SELECT i.id, i.first_name, i.last_name, i.location_id, i.status, i.total_due, l.name AS location_name${cols.map(c => `, i.${c}`).join('')}`
            + ` FROM ${T.inscriptions} i LEFT JOIN ${T.locations} l ON l.id = i.location_id WHERE i.id IN (${ph(ids)})`, ids) : [];
        const byId = new Map(people.map(r => [Number(r.id), r]));
        const m = await moneyOf(ids, null);
        t.allocations = t.allocations.map(a => {
            const r = byId.get(Number(a.inscription_id)) || {};
            const mc = m.get(Number(a.inscription_id)) || { validated: 0, pending: 0, returned: 0 };
            const partC = toCents(a.amount);
            const own = (st) => (t.status === st ? partC : 0);
            const valOther = mc.validated - own('validated'), pendOther = mc.pending - own('pending'), retOther = mc.returned - own('returned');
            const cancelled = r.status === 'cancelled';
            const dueC = cancelled ? 0 : Math.max(0, toCents(r.total_due));
            const afterC = valOther + partC;
            return {
                ...a,
                name: r.id != null ? D.personName(r, cols) : null,
                location: r.location_id == null ? null : (r.location_name || null),
                total_due: money(r.total_due), due: fromCents(dueC),
                validated_other: fromCents(valOther), pending_other: fromCents(pendOther), returned_other: fromCents(retOther),
                after: { paid: fromCents(afterC), owed: fromCents(Math.max(0, dueC - afterC)), credit: fromCents(Math.max(0, afterC - dueC)) },
            };
        });
        const root = rootOf(x.h);
        t.reused_by = (await liveFamily(root, id)).map(m => ({ id: Number(m.id), status: m.status }));
        if (t.method === 'Transferencia' && refKey(t.reference)) {
            // A voided payment is flagged too: validating it again would count a transfer another live payment
            // already counts. Its own «Duplicar» family is left out — `reused_by` says that, and blocks it.
            const fam = t.status === 'rejected' ? ' AND id <> ? AND (duplicate_of IS NULL OR duplicate_of <> ?)' : '';
            const other = await db.get(`SELECT id FROM ${T.transfers} WHERE conference_id = ? AND id <> ? AND method = 'Transferencia'`
                + ` AND status IN ('pending', 'validated', 'returned') AND LOWER(TRIM(reference)) = ?${fam}`,
            [x.h.conference_id, id, refKey(t.reference), ...(fam ? [root, root] : [])]);
            t.flags.duplicate_reference = !!other;
            // Which payment: «Validar» of a voided one asks «Esa referencia ya cuenta en el pago #N…» (R5-M1).
            t.flags.duplicate_reference_of = other ? Number(other.id) : null;
        }
        t.events = (await db.all(`SELECT id, created_at, actor, action, note FROM ${T.transferEvents} WHERE transfer_id = ? ORDER BY id`, [id]))
            .map(e => ({ id: e.id, at: e.created_at, actor: e.actor || null, action: e.action, note: e.note || null }));
        return t;
    }

    /** Live money per person of `ids` (cents), optionally leaving one payment out. */
    async function moneyOf(ids, excludeTransferId) {
        const out = new Map();
        if (!ids.length) return out;
        let sql = `SELECT xp.inscription_id AS iid,`
            + ` SUM(CASE WHEN ${EFFECTIVE('xp', 'xt')} = 'validated' THEN xp.amount ELSE 0 END) AS validated,`
            + ` SUM(CASE WHEN ${EFFECTIVE('xp', 'xt')} = 'pending' THEN xp.amount ELSE 0 END) AS pending,`
            + ` SUM(CASE WHEN ${EFFECTIVE('xp', 'xt')} = 'returned' THEN xp.amount ELSE 0 END) AS returned`
            + ` FROM ${PARTS()} WHERE xp.inscription_id IN (${ph(ids)})`;
        const params = [...ids];
        if (excludeTransferId) { sql += ' AND (xp.transfer_id IS NULL OR xp.transfer_id <> ?)'; params.push(excludeTransferId); }
        for (const r of await db.all(sql + ' GROUP BY xp.inscription_id', params)) {
            out.set(Number(r.iid), { validated: toCents(r.validated), pending: toCents(r.pending), returned: toCents(r.returned) });
        }
        return out;
    }

    // ── portal projections ──────────────────────────────────────────────────────────────────────────
    const ownWhere = 't.conference_id = ? AND t.recorded_via = ? AND t.location_id = ?';
    const isOwn = (h, location) => h.recorded_via === 'portal' && Number(h.location_id) === Number(location.id);
    /**
     * «Devolver» hands a payment back to whoever recorded it, to correct and resend: a location's portal (its
     * own payments) or the administration (its «Pagos» list). A pre-2.18 payment (`legacy`: nobody knows who
     * recorded it, and no portal sees it as its own) or a portal payment whose location was deleted has
     * nobody to correct it — returning it would leave it «Devuelto» for good, so only edit / validate /
     * reject apply. The location is looked up, not trusted from the header: on several nodes a header may
     * still name a location another node just deleted (detachIfGone and the boot hygiene clear it).
     */
    async function canBeReturned(h) {
        if (h.recorded_via === 'admin') return true;
        if (h.recorded_via !== 'portal' || h.location_id == null) return false;
        return !!(await db.get(`SELECT id FROM ${T.locations} WHERE id = ?`, [h.location_id]));
    }
    /** A payment never names a deleted location: `locationId` gone → the header's location_id is cleared. */
    async function detachIfGone(transferId, locationId) {
        if (locationId == null) return;
        if (await db.get(`SELECT id FROM ${T.locations} WHERE id = ?`, [locationId])) return;
        await db.run(`UPDATE ${T.transfers} SET location_id = NULL WHERE id = ? AND location_id = ?`, [transferId, locationId]);
    }

    async function portalView(location) {
        const cid = location.conference_id, lid = location.id;
        const methods = D.enabledPaymentMethods(location);
        const balances = (await peopleMoney(cid, lid)).map(balanceOf);
        const list = await transfersWhere(
            `t.conference_id = ? AND ((t.recorded_via = 'portal' AND t.location_id = ?) OR t.id IN (SELECT q.transfer_id FROM ${T.payments} q`
            + ` JOIN ${T.inscriptions} qi ON qi.id = q.inscription_id WHERE qi.location_id = ? AND q.transfer_id IS NOT NULL ))`, [cid, lid, lid]);
        const own = [], foreign = [];
        for (const x of list) {
            const h = x.h;
            if (isOwn(h, location)) {
                const allocatedC = x.parts.reduce((s, p) => s + toCents(p.amount), 0);
                own.push({
                    id: h.id, foreign: false, recorded_via: 'portal',
                    amount: money(h.amount), allocated: fromCents(allocatedC), method: h.method || '', reference: h.reference || null,
                    paid_on: dayOut(h.paid_on), note: h.note || null, status: h.status, review_note: h.review_note || null,
                    alloc_gen: Number(h.alloc_gen), created_at: h.created_at || null, submitted_at: h.submitted_at || null,
                    updated_at: h.updated_at || null, reviewed_at: h.reviewed_at || null, has_proof: !!Number(h.has_proof),
                    people: x.parts.length,
                    allocations: x.parts.map(p => ({
                        id: p.id, inscription_id: p.inscription_id, amount: money(p.amount),
                        moved: Number(p.location_id) !== Number(lid), cancelled: p.ins_status === 'cancelled',
                    })),
                    can_edit: EDITABLE.includes(h.status), can_delete: DELETABLE.portal.includes(h.status),
                    duplicate_of: h.duplicate_of == null ? null : Number(h.duplicate_of), reused: false, reused_by: null,
                });
            } else {
                // D-P22: another recorder's payment (the administration's, or a pre-2.18 one) that covers some of
                // this location's people: only those parts, without the receipt, the reference or any note.
                const mine = x.parts.filter(p => Number(p.location_id) === Number(lid));
                if (!mine.length) continue;
                const mineC = mine.reduce((s, p) => s + toCents(p.amount), 0);
                foreign.push({
                    id: h.id, foreign: true, recorded_via: h.recorded_via === 'legacy' ? 'legacy' : (h.recorded_via === 'portal' ? 'portal' : 'admin'),
                    amount: fromCents(mineC), allocated: fromCents(mineC), method: h.method || '', reference: null,
                    paid_on: dayOut(h.paid_on), note: null, status: h.status, review_note: null, alloc_gen: Number(h.alloc_gen),
                    created_at: h.created_at || null, reviewed_at: h.reviewed_at || null, has_proof: false,
                    people: mine.length,
                    allocations: mine.map(p => ({ id: p.id, inscription_id: p.inscription_id, amount: money(p.amount), moved: false, cancelled: p.ins_status === 'cancelled' })),
                    can_edit: false, can_delete: false,
                });
            }
        }
        // «Duplicar»: a voided payment of the location that another payment already records again (and that
        // counts) is not offered «Duplicar» again; the other one is named only when it is the location's own.
        const ownIds = new Set(own.map(o => Number(o.id)));
        for (const o of own) {
            const root = o.duplicate_of != null ? o.duplicate_of : Number(o.id);
            if (o.duplicate_of != null && !ownIds.has(o.duplicate_of)) o.duplicate_of = null;
            if (o.status !== 'rejected') continue;
            const used = await liveFamily(root, o.id);
            if (!used.length) continue;
            o.reused = true;
            const mine = used.find(m => isOwn(m, location));
            o.reused_by = mine ? Number(mine.id) : null;
        }
        // «Requiere tu atención» first: returned own payments, then newest first.
        own.sort((a, b) => (b.status === 'returned') - (a.status === 'returned') || Number(b.id) - Number(a.id));
        return {
            features: { fee_payments: 1 },
            location: { id: lid, name: location.name },
            methods, can_record: methods.length > 0,
            proof: { required_for: ['Transferencia'], max_chars: D.MAX_PROOF_CHARS },
            max_people: MAX_PARTS,
            summary: summarize(balances),
            people: balances.map(b => { const { location_id, total_due, ...w } = b.wire; return w; }),
            counts: countsOf(own),
            transfers: [...own, ...foreign],
        };
    }
    /** /portal/me and /portal/login: the version-skew flag and the fee tab's badge counters. */
    async function portalFeatures(location) {
        // Never throws: it decorates /portal/login and /portal/me, which must keep working whatever happens
        // here. Without the schema there is no flag at all, so a core portal keeps its older payment flow.
        if (!ready) return {};
        try {
            const rows = await db.all(`SELECT t.status, COUNT(*) AS n FROM ${T.transfers} t WHERE ${ownWhere} AND t.status IN ('pending', 'returned') GROUP BY t.status`,
                [location.conference_id, 'portal', location.id]);
            const fees = { pending: 0, returned: 0 };
            for (const r of rows) fees[r.status] = Number(r.n) || 0;
            return { features: { fee_payments: 1 }, fees };
        } catch (e) {
            console.warn('[conference-manager] fee payment counters skipped:', e && e.message);
            return { features: { fee_payments: 1 } };
        }
    }

    // ── writes ───────────────────────────────────────────────────────────────────────────────────────
    async function logEvent(transferId, actor, action, note) {
        try { await db.run(`INSERT INTO ${T.transferEvents} (transfer_id, actor, action, note) VALUES (?, ?, ?, ?)`, [transferId, actor || null, action, note || null]); }
        catch (e) { console.warn('[conference-manager] payment history line skipped:', e && e.message); }
    }
    async function purge(transferId) {
        await db.run(`DELETE FROM ${T.transfers} WHERE id = ?`, [transferId]);
        await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ?`, [transferId]);
        await db.run(`DELETE FROM ${T.transferEvents} WHERE transfer_id = ?`, [transferId]);
    }

    /** The people of a split: same conference (and the portal's own location), none cancelled. */
    async function loadPeople(conferenceId, ids, locationId) {
        let sql = `SELECT i.id, i.location_id, i.status, i.total_due FROM ${T.inscriptions} i WHERE i.conference_id = ? AND i.id IN (${ph(ids)})`;
        const params = [conferenceId, ...ids];
        if (locationId != null) { sql += ' AND i.location_id = ?'; params.push(locationId); }
        const map = new Map((await db.all(sql, params)).map(r => [Number(r.id), r]));
        const missing = ids.filter(id => !map.has(id));
        if (missing.length) throw feeError(400, 'unknown_people', locationId != null ? MSG.unknown_people_location : MSG.unknown_people, { ids: missing });
        const cancelled = ids.filter(id => map.get(id).status === 'cancelled');
        if (cancelled.length) throw feeError(400, 'cancelled_people', null, { ids: cancelled });
        return map;
    }
    /** What a person owes, in cents: the fee, or 0 for a cancelled inscription (balanceOf's rule). */
    const dueCentsOf = (who) => (!who || who.status === 'cancelled' ? 0 : Math.max(0, toCents(who.total_due)));
    /**
     * D-P9 «Nunca»: no part may take a person past what they owe. When RECORDING (create / edit) the room
     * left is due − validated − pending of their OTHER payments; when VALIDATING it is due − validated. A
     * cancelled inscription owes nothing (D-P19): validating a payment that still holds one is refused with
     * 409 cancelled_people (recording one already is, 400 in loadPeople) — the admin corrects the split,
     * reactivates the person or rejects the payment.
     */
    async function assertCaps(people, parts, excludeTransferId, mode) {
        if (mode === 'validate') {
            const cancelled = parts.map(p => Number(p.inscription_id)).filter(id => (people.get(id) || {}).status === 'cancelled');
            if (cancelled.length) throw feeError(409, 'cancelled_people', MSG.cancelled_people_validate, { ids: cancelled });
        }
        const m = await moneyOf(parts.map(p => p.inscription_id), excludeTransferId);
        const over = [];
        for (const p of parts) {
            const who = people.get(Number(p.inscription_id));
            const mc = m.get(Number(p.inscription_id)) || { validated: 0, pending: 0 };
            const dueC = dueCentsOf(who);
            const maxC = Math.max(0, dueC - mc.validated - (mode === 'record' ? mc.pending : 0));
            if (p.cents > maxC) over.push({ inscription_id: p.inscription_id, amount: fromCents(p.cents), max: fromCents(maxC) });
        }
        if (over.length) throw feeError(409, 'over_cap', null, { people: over });
    }
    /**
     * The same rule AFTER a write that added money (several nodes: another process may have written for the
     * same people between our check and our write). The people's LIVE money now, this payment included:
     * validated + pending (record) or validated (validate) must not pass their fee. Returns who is over
     * (empty = the write stands), in the 409 over_cap shape. A person who is GONE (deleted meanwhile on another
     * node: DELETE /inscriptions — a foreign key may have taken their part with them) is over too, flagged
     * `missing`: the write backs off whole (raceError), so a receipt never stands with a part missing.
     */
    async function overAfterWrite(parts, mode) {
        const ids = [...new Set(parts.map(p => Number(p.inscription_id)))];
        if (!ids.length) return [];
        const who = new Map((await db.all(`SELECT id, status, total_due FROM ${T.inscriptions} WHERE id IN (${ph(ids)})`, ids)).map(r => [Number(r.id), r]));
        const m = await moneyOf(ids, null);
        const over = [];
        for (const p of parts) {
            const id = Number(p.inscription_id);
            if (!who.has(id)) { over.push({ inscription_id: id, amount: fromCents(p.cents), max: 0, missing: true }); continue; }
            const mc = m.get(id) || { validated: 0, pending: 0 };
            const dueC = dueCentsOf(who.get(id));
            const usedC = mc.validated + (mode === 'record' ? mc.pending : 0);
            if (usedC > dueC) over.push({ inscription_id: id, amount: fromCents(p.cents), max: fromCents(Math.max(0, dueC - (usedC - p.cents))) });
        }
        return over;
    }
    /** The answer of a write that backed off after overAfterWrite: 400 unknown_people when someone is gone, else 409 over_cap. */
    const raceError = (over) => {
        const gone = over.filter(o => o.missing).map(o => o.inscription_id);
        return gone.length ? feeError(400, 'unknown_people', null, { ids: gone }) : feeError(409, 'over_cap', null, { people: over });
    };
    /** The people a payment touched, every generation (what a recompute after it must cover). */
    const peopleOfTransfer = async (transferId) =>
        (await db.all(`SELECT DISTINCT inscription_id FROM ${T.payments} WHERE transfer_id = ?`, [transferId])).map(r => Number(r.inscription_id));
    /**
     * A write answered 409 stale / invalid_transition: the caller may be retrying something that already
     * happened. Re-write the live parts' status mirror from the header and re-run the recompute of the
     * payment's people first, so a write whose compare-and-set succeeded but whose mirror write or recompute
     * failed (a deadlock on the inscriptions UPDATE) is repaired by the retry. Best effort; always rethrows `e`.
     */
    async function repairThen(transferId, e) {
        if (e && (e.code === 'stale' || e.code === 'invalid_transition') && transferId) {
            try {
                const h = await db.get(`SELECT status, alloc_gen FROM ${T.transfers} WHERE id = ?`, [transferId]);
                if (h && h.status !== 'draft') await mirrorFromHeader(transferId, Number(h.alloc_gen), { strict: true });
            } catch (err) { console.warn('[conference-manager] payment mirror on retry skipped:', err && err.message); }
            try { await recomputeIds(await peopleOfTransfer(transferId)); }
            catch (err) { console.warn('[conference-manager] payment recompute on retry skipped:', err && err.message); }
        }
        throw e;
    }
    /**
     * Another payment of the conference that COUNTS (pending, validated, returned) with the same transfer
     * reference (case and outer spaces aside), or null. `selfId` is left out; so is `root`'s whole «Duplicar»
     * family when given (one handover recorded again: source_used already guards it). Only a Transferencia
     * with a reference has one.
     */
    async function referenceTaken(conferenceId, method, reference, selfId, root) {
        if (method !== 'Transferencia' || !refKey(reference)) return null;
        let sql = `SELECT id, location_id, recorded_via FROM ${T.transfers} WHERE conference_id = ? AND method = 'Transferencia'`
            + ` AND status IN ('pending', 'validated', 'returned') AND LOWER(TRIM(reference)) = ?`;
        const params = [conferenceId, refKey(reference)];
        if (selfId) { sql += ' AND id <> ?'; params.push(selfId); }
        if (root) { sql += ' AND id <> ? AND (duplicate_of IS NULL OR duplicate_of <> ?)'; params.push(root, root); }
        return (await db.get(sql + ' ORDER BY id', params)) || null;
    }
    /**
     * 409 duplicate_reference naming `other` — to the portal only when it is its own payment. `details` carries
     * the same (the admin's api client keeps `details`, not other top-level fields, for its confirmation).
     */
    const referenceError = (other, location) => {
        const visible = !location || isOwn(other, location);
        const named = visible ? { id: Number(other.id) } : null;
        return feeError(409, 'duplicate_reference', null, { other: named, details: { other: named } });
    };
    /**
     * A write whose undo (its re-check failed) changed nothing: another node acted on the payment meanwhile.
     * Its decision stands — unless the payment is GONE (deleted on another node): then this write took no
     * effect, and answering success would acknowledge a correction or a validation that counts nowhere
     * (2.18.0 review R5-L1). The leftover parts go, the people are recomputed, and it answers 409 stale.
     */
    async function assertStillThere(transferId, ids) {
        if (await db.get(`SELECT id FROM ${T.transfers} WHERE id = ?`, [transferId])) return;
        await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ?`, [transferId]);
        await recomputeIds(ids);
        throw feeError(409, 'stale');
    }
    /** 409 duplicate_reference unless allowed: another live transfer of the conference with the same reference. */
    async function assertReference(conferenceId, input, excludeId, location) {
        if (input.allowDuplicateReference) return;
        const other = await referenceTaken(conferenceId, input.method, input.reference, excludeId, null);
        if (other) throw referenceError(other, location);
    }
    // ── «Duplicar» (D-P10): one handover counts in ONE payment ──────────────────────────────────────
    /**
     * A payment recorded again with «Duplicar» names the voided payment it records again in `duplicate_of`,
     * always the ROOT of the chain (a copy of a copy names the first payment). The root and every header whose
     * duplicate_of is the root are one FAMILY: one receipt, one handover. At most ONE member of a family may
     * count (pending, validated or returned) at a time: a second «Duplicar» of the same voided payment, or
     * validating the voided one again while its copy counts, is refused (409 source_used) — one $250 cash
     * handover never counts as $500. Voiding or deleting the copy frees the family again.
     */
    const rootOf = (h) => (h.duplicate_of != null ? Number(h.duplicate_of) : Number(h.id));
    /** The members of family `root` that count now, except `selfId` (oldest first). */
    const liveFamily = (root, selfId) => db.all(`SELECT id, status, recorded_via, location_id FROM ${T.transfers}`
        + ` WHERE (id = ? OR duplicate_of = ?) AND id <> ? AND status IN ('pending', 'validated', 'returned') ORDER BY id`, [root, root, selfId || 0]);
    /** 409 source_used; the portal learns the other payment only when it is its own. */
    const sourceUsed = (members, location) => {
        const m = members[0];
        const visible = !location || isOwn(m, location);
        return feeError(409, 'source_used', null, { used_by: visible ? { id: Number(m.id), status: m.status } : null });
    };
    /**
     * The voided payment a new or corrected payment records again («Duplicar»: `copy_proof_from` or
     * `duplicate_of`): a payment of the same conference (the portal: its own) that was VOIDED. D-P10 orders
     * «anular, luego Duplicar»: while the source still counts or can count (pending, validated, returned) its
     * receipt would stand behind two live payments, so it is refused (409 proof_source_live); and once another
     * payment already records it again and counts, a second copy is refused too (409 source_used). `selfId` =
     * the payment being corrected (never a second copy of itself). Returns { src, root }.
     */
    async function assertSource(conferenceId, sourceId, location, selfId) {
        const src = await db.get(`SELECT id, conference_id, recorded_via, location_id, legacy_payment_id, status, duplicate_of FROM ${T.transfers} WHERE id = ? AND status <> 'draft'`, [sourceId]);
        if (!src || Number(src.conference_id) !== Number(conferenceId) || (location && !isOwn(src, location))) throw feeError(400, 'proof_source', 'Pago de origen no encontrado.');
        if (src.status !== 'rejected') throw feeError(409, 'proof_source_live', null, { source: { id: Number(src.id), status: src.status } });
        const root = rootOf(src);
        const used = await liveFamily(root, selfId);
        if (used.length) throw sourceUsed(used, location);
        return { src, root };
    }
    /**
     * A correction (PUT) that names a «Duplicar» source (`duplicate_of` / `copy_proof_from`): only the family the
     * payment already belongs to — the voided payment it records again, or itself — is accepted, and changes
     * nothing; any other one is refused (400 source_fixed). Moving a copy into another family would free the
     * first voided payment while the copy keeps its copied receipt.
     */
    async function assertSameFamily(h, sourceId) {
        if (!sourceId) return;
        const src = await db.get(`SELECT id, conference_id, duplicate_of FROM ${T.transfers} WHERE id = ? AND status <> 'draft'`, [sourceId]);
        if (!src || Number(src.conference_id) !== Number(h.conference_id) || rootOf(src) !== rootOf(h)) throw feeError(400, 'source_fixed');
    }
    /** The receipt of a checked source (assertSource) that «Duplicar» copies. */
    async function copiedProof(src) {
        const r = await proofRead(src);
        if (r.invalid) throw feeError(400, 'proof_source', MSG.proof_source_invalid);
        if (!r.proof) throw feeError(400, 'proof_source');
        return r.proof;
    }
    /**
     * The parts of a new generation, written with the mirror 'draft': no reader that goes by the part's own
     * status (degraded mode, an older plugin after a downgrade) may count them before the header's
     * compare-and-set made them live — a crash in between would otherwise leave money «validated» that was
     * never recorded. Their mirror is written from the header once they are live (mirrorFromHeader).
     */
    const partsInsert = (transferId, gen, parts, input) => {
        const rows = parts.map(() => "(?, ?, ?, ?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP)").join(', ');
        const params = [];
        for (const p of parts) params.push(p.inscription_id, transferId, gen, fromCents(p.cents), input.method, input.reference, input.paidOn);
        return db.run(`INSERT INTO ${T.payments} (inscription_id, transfer_id, alloc_gen, amount, method, reference, date, status, created_at) VALUES ${rows}`, params);
    };
    /**
     * The status mirror of generation `gen`, copied from the header AS IT IS NOW (never from what this
     * writer thinks it wrote: another node may have validated or voided it meanwhile), and only while
     * `gen` is the header's live generation. Best effort: repairThen and the boot hygiene re-write a lost one.
     * `strict`: the failure is thrown (a transition answers 500, and its retry repairs the mirror at once).
     */
    async function mirrorFromHeader(transferId, gen, { strict = false } = {}) {
        try {
            await db.run(`UPDATE ${T.payments} SET status = (SELECT x.status FROM ${T.transfers} x WHERE x.id = ? AND x.alloc_gen = ? AND x.status <> 'draft' )`
                + ` WHERE transfer_id = ? AND alloc_gen = ? AND EXISTS (SELECT 1 FROM ${T.transfers} x WHERE x.id = ? AND x.alloc_gen = ? AND x.status <> 'draft' )`,
            [transferId, gen, transferId, gen, transferId, gen]);
        } catch (e) {
            if (strict) throw e;
            console.warn('[conference-manager] payment mirror skipped:', e && e.message);
        }
    }
    /**
     * A generation for ONE edit attempt: a compare-and-set on the header's `gen_seq`, so two attempts (two
     * nodes) never get the same number, and above the current one and every part's (a leftover of an
     * attempt that crashed before generations were minted included), so it is never one of them either.
     */
    async function mintGeneration(h) {
        for (let i = 0; i < 8; i++) {
            const row = await db.get(`SELECT gen_seq, alloc_gen FROM ${T.transfers} WHERE id = ?`, [h.id]);
            if (!row) throw feeError(404, 'not_found');
            const top = await db.get(`SELECT MAX(alloc_gen) AS g FROM ${T.payments} WHERE transfer_id = ?`, [h.id]);
            const seq = row.gen_seq == null ? null : Number(row.gen_seq);
            const next = Math.max(seq || 0, Number(row.alloc_gen) || 0, Number(h.alloc_gen) || 0, Number(top && top.g) || 0) + 1;
            const cas = seq == null
                ? await db.run(`UPDATE ${T.transfers} SET gen_seq = ? WHERE id = ? AND gen_seq IS NULL`, [next, h.id])
                : await db.run(`UPDATE ${T.transfers} SET gen_seq = ? WHERE id = ? AND gen_seq = ?`, [next, h.id, seq]);
            if (cas && cas.changes) return next;
        }
        throw feeError(409, 'stale');
    }
    /**
     * An edit that backs off (its re-check found money another node recorded meanwhile) puts the payment back as
     * it was — as a FRESH generation holding the split it had (`parts`: the live parts read before the edit),
     * never by pointing the header back at the old generation: a node booting meanwhile (a rolling restart) may
     * already have removed those rows (bootHygiene drops every generation older than the header's), and the
     * payment would be left without parts — invisible, its money gone (2.18.0 review R4-L3). One compare-and-set
     * from the edit's generation `ng` (only while it is still the pending split this edit wrote: a decision
     * another node took on it stands); then every older generation goes. `undo` / `back`: the header's other
     * columns as they were. Returns true when undone. Without a generation to mint it falls back to the old one.
     */
    async function restoreSplit(h, ng, parts, undo, back) {
        let rg = null;
        try { rg = await mintGeneration(h); } catch { rg = null; }
        if (rg != null) {
            try {
                await partsInsert(h.id, rg, parts.map(p => ({ inscription_id: Number(p.inscription_id), cents: toCents(p.amount) })),
                    { method: h.method, reference: h.reference, paidOn: dayOut(h.paid_on) });
            } catch (e) {
                console.warn('[conference-manager] payment split restore skipped:', e && e.message);
                await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen = ?`, [h.id, rg]);
                rg = null;
            }
        }
        const target = rg != null ? rg : Number(h.alloc_gen);
        const undone = await db.run(`UPDATE ${T.transfers} SET alloc_gen = ?, ${undo.join(', ')} WHERE id = ? AND alloc_gen = ? AND status = 'pending'`, [target, ...back, h.id, ng]);
        if (!undone || !undone.changes) {
            if (rg != null) await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen = ?`, [h.id, rg]);
            return false;
        }
        if (rg != null) {
            await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen < ?`, [h.id, rg]);
            await mirrorFromHeader(h.id, rg);
        } else {
            await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen = ?`, [h.id, ng]);
        }
        return true;
    }

    /**
     * Does a create request under an already used `client_key` ask for the payment that key recorded (2.18.0
     * review R6-M2)? The same method, reference, note, amount, split ({person → amount} of its live parts),
     * «Duplicar» source and receipt — and the same date when the request names one (a request without a date
     * means «today», which a retry after midnight would no longer match). Amounts compare in cents, with the
     * rounding a Postgres REAL column may add to a large amount (relative 1e-7, at least 1 cent).
     */
    async function sameAsRecorded(id, input) {
        const h = await db.get(`SELECT id, method, reference, paid_on, note, amount, proof, duplicate_of FROM ${T.transfers} WHERE id = ?`, [id]);
        if (!h) return false;
        const near = (storedC, wantC) => Math.abs(storedC - wantC) <= Math.max(1, Math.round(Math.abs(wantC) * 1e-7));
        if ((h.method || '') !== input.method) return false;
        if ((h.reference || null) !== (input.reference || null)) return false;
        if ((h.note || null) !== (input.note || null)) return false;
        if (input.paidOnGiven && dayOut(h.paid_on) !== input.paidOn) return false;
        if (!near(toCents(h.amount), input.totalC)) return false;
        const parts = await liveParts(h.id);
        if (parts.length !== input.parts.length) return false;
        const want = new Map(input.parts.map(p => [Number(p.inscription_id), p.cents]));
        for (const p of parts) {
            const c = want.get(Number(p.inscription_id));
            if (c === undefined || !near(toCents(p.amount), c)) return false;
        }
        if (input.sourceId) {
            const src = await db.get(`SELECT id, duplicate_of FROM ${T.transfers} WHERE id = ?`, [input.sourceId]);
            const root = src ? rootOf(src) : Number(input.sourceId);
            if (h.duplicate_of == null || Number(h.duplicate_of) !== root) return false;
        } else if (h.duplicate_of != null) return false;
        // The receipt: a copied one goes with its source (checked above); otherwise the photo sent, or none.
        if (!input.copyFrom && (typeof input.proof === 'string' ? input.proof : null) !== (h.proof || null)) return false;
        return true;
    }

    /**
     * Record a payment. ctx = { conferenceId, via: 'admin' | 'portal', location (portal), actor }.
     * Returns { id, replayed }.
     */
    function createTransfer(ctx, input) {
        return withPaymentsLock(async () => {
            const recorder = ctx.via === 'portal' ? `portal:${ctx.location.id}` : (ctx.actor || 'admin');
            if (input.clientKey) {
                const prev = await db.get(`SELECT id, conference_id, recorded_by, status FROM ${T.transfers} WHERE client_key = ?`, [input.clientKey]);
                if (prev) {
                    // A draft under this key is the leftover of a crashed attempt: start again. A finished one is
                    // the same request replayed by the same recorder — its recompute runs again, so a first
                    // attempt whose recompute failed after the payment was written is repaired by the retry.
                    if (prev.status === 'draft' && prev.recorded_by === recorder) await purge(prev.id);
                    else if (prev.recorded_by === recorder && Number(prev.conference_id) === Number(ctx.conferenceId)) {
                        // Only the SAME request is a replay (2.18.0 review R6-M2): a send whose answer was lost, then
                        // corrected on screen (other amounts, another person, a new photo) and sent again with the
                        // draft's key, was answered «registered» for the FIRST payment — the correction recorded
                        // nowhere. A different request under a used key is refused, naming the recorded payment.
                        if (!(await sameAsRecorded(prev.id, input))) {
                            throw feeError(409, 'client_key_changed', `Este pago ya se había registrado antes con otros datos (pago #${Number(prev.id)}): revísalo en «Pagos» en lugar de enviarlo de nuevo.`,
                                { id: Number(prev.id), details: { id: Number(prev.id) } });
                        }
                        await recomputeIds(await peopleOfTransfer(prev.id));
                        return { id: prev.id, replayed: true };
                    }
                    else throw feeError(409, 'client_key_conflict');
                }
            }
            const portalLoc = ctx.via === 'portal' ? ctx.location : null;
            let proof = typeof input.proof === 'string' ? input.proof : null;
            // «Duplicar»: the voided payment this one records again (its family; the receipt when copied).
            const source = input.sourceId ? await assertSource(ctx.conferenceId, input.sourceId, portalLoc, null) : null;
            if (!proof && input.copyFrom) proof = await copiedProof(source.src);
            if (input.method === 'Transferencia' && !proof) throw feeError(400, 'proof_required');
            const ids = input.parts.map(p => p.inscription_id);
            const people = await loadPeople(ctx.conferenceId, ids, ctx.via === 'portal' ? ctx.location.id : null);
            await assertCaps(people, input.parts, null, 'record');
            await assertReference(ctx.conferenceId, input, null, ctx.via === 'portal' ? ctx.location : null);
            // The recorder's location: the portal's own; for the admin the people's one location, else NULL.
            const locs = [...new Set([...people.values()].map(r => (r.location_id == null ? 'null' : String(r.location_id))))];
            const locationId = ctx.via === 'portal' ? ctx.location.id : (locs.length === 1 && locs[0] !== 'null' ? Number(locs[0]) : null);
            const target = ctx.via === 'admin' && !input.leavePending ? 'validated' : 'pending';
            const ins = await db.run(`INSERT INTO ${T.transfers} (conference_id, location_id, amount, method, reference, paid_on, note, proof, status,`
                + ` alloc_gen, recorded_via, recorded_by, client_key, updated_by, duplicate_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?)`,
                [ctx.conferenceId, locationId, fromCents(input.totalC), input.method, input.reference, input.paidOn, input.note, proof,
                    ctx.via, recorder, input.clientKey, recorder, source ? source.root : null]);
            const id = ins && ins.lastID;
            if (!id) throw new Error('payment header insert returned no id');
            try { await partsInsert(id, 1, input.parts, input); }
            catch (e) { await purge(id); throw e; }
            const flip = target === 'validated'
                ? await db.run(`UPDATE ${T.transfers} SET status = 'validated', submitted_at = CURRENT_TIMESTAMP, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ? AND status = 'draft'`, [recorder, id])
                : await db.run(`UPDATE ${T.transfers} SET status = 'pending', submitted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'`, [id]);
            if (!flip || !flip.changes) { await purge(id); throw feeError(409, 'stale'); }
            // Several nodes: did another process record money for these people meanwhile, record the same voided
            // payment again («Duplicar»), or record a payment with the same transfer reference? Then this one
            // backs off (of two racing writers at least one sees the other).
            const over = await overAfterWrite(input.parts, 'record');
            const clash = source ? await liveFamily(source.root, id) : [];
            const sameRef = over.length || clash.length || input.allowDuplicateReference ? null
                : await referenceTaken(ctx.conferenceId, input.method, input.reference, id, null);
            if (over.length || clash.length || sameRef) {
                await purge(id);
                await recomputeIds(ids);
                throw over.length ? raceError(over) : clash.length ? sourceUsed(clash, portalLoc) : referenceError(sameRef, portalLoc);
            }
            // Several nodes: the recorder's location deleted on another node meanwhile (DELETE /locations
            // serialises with this write only on its own node). A payment never names a location that no longer
            // exists — «Devolver» would wait on a portal nobody can open (2.18.0 review R5-L2).
            await detachIfGone(id, locationId);
            await mirrorFromHeader(id, 1);
            await recomputeIds(ids);
            await logEvent(id, recorder, 'created', null);
            if (target === 'validated') await logEvent(id, recorder, 'validated', null);
            return { id, replayed: false };
        });
    }

    /** Scope check of an existing payment for the caller. Returns the header or throws 404. */
    async function scopedHeader(id, ctx) {
        const h = id ? await header(id) : null;
        if (!h || h.status === 'draft') throw feeError(404, 'not_found');
        if (ctx.via === 'portal' && !(Number(h.conference_id) === Number(ctx.location.conference_id) && isOwn(h, ctx.location))) throw feeError(404, 'not_found');
        return h;
    }
    const assertExpected = (h, expected) => {
        if (expected && (h.status !== expected.status || Number(h.alloc_gen) !== Number(expected.alloc_gen))) {
            throw feeError(409, 'stale', null, { current: { status: h.status, alloc_gen: Number(h.alloc_gen) } });
        }
    };

    /** Re-split / correct a pending or returned payment (generation swap). Returns { id }. */
    function editTransfer(ctx, id, input, expected) {
        return withPaymentsLock(async () => {
            const h = await scopedHeader(id, ctx);
            try {
                if (!EDITABLE.includes(h.status)) throw feeError(409, 'invalid_transition', null, { current: { status: h.status, alloc_gen: Number(h.alloc_gen) } });
                assertExpected(h, expected);
            } catch (e) { return repairThen(h.id, e); }
            const actor = ctx.via === 'portal' ? `portal:${ctx.location.id}` : (ctx.actor || 'admin');
            // «Duplicar» belongs to the payment as it was RECORDED (create): a correction never moves a payment
            // into another voided payment's family, nor out of its own. A copy that left its family would keep
            // the first payment's copied receipt while that payment became free to count again — one handover
            // counted twice (2.18.0 review R4-M1). `duplicate_of` / `copy_proof_from` on an edit are accepted
            // only when they name the family the payment already is in, and then change nothing.
            await assertSameFamily(h, input.sourceId);
            // The receipt: a new one, removed (cash only), or kept — a wrapped legacy payment's receipt moves
            // onto the header first, since its original row goes with the old generation.
            let proofSet = null;     // [clause, params]
            let hasProof = !!Number(h.has_proof);
            if (typeof input.proof === 'string') { proofSet = ['proof = ?', [input.proof]]; hasProof = true; }
            else if (input.proof === null) { proofSet = ['proof = NULL', []]; hasProof = false; }
            else if (hasProof) {
                // Kept: a receipt that fails the rule (a pre-2.18 one, see storedProofOk) is dropped, never kept
                // or moved — a transfer then needs a new one (400 proof_required below).
                const r = await proofRead(h);
                if (r.invalid) { proofSet = ['proof = NULL', []]; hasProof = false; }
                else if (h.legacy_payment_id != null && r.proof) {
                    const own = await db.get(`SELECT proof FROM ${T.transfers} WHERE id = ?`, [h.id]);
                    if (!(own && own.proof)) proofSet = ['proof = ?', [r.proof]];
                }
            }
            if (input.method === 'Transferencia' && !hasProof) throw feeError(400, 'proof_required');
            const ids = input.parts.map(p => p.inscription_id);
            const people = await loadPeople(h.conference_id, ids, ctx.via === 'portal' ? ctx.location.id : null);
            // The split as it is now: put back as a NEW generation if the re-check below undoes this edit.
            const beforeParts = await liveParts(h.id);
            const before = beforeParts.map(p => Number(p.inscription_id));
            // D-P3: a payment a location's portal recorded stays that location's — its coordinator sees all of
            // it and may resend it. The administration correcting it may keep a person who moved away since,
            // never add someone of another location (that money is recorded apart).
            if (ctx.via === 'admin' && h.recorded_via === 'portal' && h.location_id != null) {
                const outside = ids.filter(pid => !before.includes(pid) && Number(people.get(pid).location_id) !== Number(h.location_id));
                if (outside.length) throw feeError(400, 'unknown_people', MSG.unknown_people_portal, { ids: outside });
            }
            await assertCaps(people, input.parts, h.id, 'record');
            await assertReference(h.conference_id, input, h.id, ctx.via === 'portal' ? ctx.location : null);
            // The receipt as it is now, to put back if the re-check below undoes this edit: the header's own, else
            // (a wrapped legacy payment) its original row's — that row goes with the old split when undone.
            const legacyProof = h.legacy_payment_id != null ? ((await db.get(`SELECT proof FROM ${T.payments} WHERE id = ?`, [h.legacy_payment_id])) || {}).proof || null : null;
            const ownProof = proofSet || legacyProof ? ((await db.get(`SELECT proof FROM ${T.transfers} WHERE id = ?`, [h.id])) || {}).proof || null : null;
            const g = Number(h.alloc_gen);
            const ng = await mintGeneration(h);
            await partsInsert(h.id, ng, input.parts, input);
            const resent = h.status === 'returned';
            const sets = ['alloc_gen = ?', 'amount = ?', 'method = ?', 'reference = ?', 'paid_on = ?', 'note = ?', "status = 'pending'",
                'updated_at = CURRENT_TIMESTAMP', 'updated_by = ?'];
            const params = [ng, fromCents(input.totalC), input.method, input.reference, input.paidOn, input.note, actor];
            if (proofSet) { sets.push(proofSet[0]); params.push(...proofSet[1]); }
            if (resent) sets.push('submitted_at = CURRENT_TIMESTAMP');
            let movesLocation = false;
            if (ctx.via === 'admin' && h.recorded_via !== 'portal') {
                // The recorder's location follows the people for an admin / legacy payment.
                const locs = [...new Set([...people.values()].map(r => (r.location_id == null ? 'null' : String(r.location_id))))];
                sets.push('location_id = ?'); params.push(locs.length === 1 && locs[0] !== 'null' ? Number(locs[0]) : null);
                movesLocation = true;
            }
            const cas = await db.run(`UPDATE ${T.transfers} SET ${sets.join(', ')} WHERE id = ? AND alloc_gen = ? AND status = ?`, [...params, h.id, g, h.status]);
            if (!cas || !cas.changes) {
                // Only THIS attempt's parts: its generation is its own (mintGeneration).
                await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen = ?`, [h.id, ng]);
                return repairThen(h.id, feeError(409, 'stale'));
            }
            // Several nodes: money another process recorded meanwhile for these people, or a payment it recorded
            // with this transfer reference → this edit backs off.
            const over = await overAfterWrite(input.parts, 'record');
            const sameRef = over.length || input.allowDuplicateReference ? null : await referenceTaken(h.conference_id, input.method, input.reference, h.id, null);
            if (over.length || sameRef) {
                const undo = ['amount = ?', 'method = ?', 'reference = ?', 'paid_on = ?', 'note = ?', 'status = ?', 'updated_at = CURRENT_TIMESTAMP', 'updated_by = ?'];
                const back = [money(h.amount), h.method, h.reference, dayOut(h.paid_on), h.note, h.status, actor];
                if (proofSet || (legacyProof && ownProof == null)) { undo.push('proof = ?'); back.push(ownProof != null ? ownProof : legacyProof); }
                if (movesLocation) { undo.push('location_id = ?'); back.push(h.location_id == null ? null : h.location_id); }
                const undone = await restoreSplit(h, ng, beforeParts, undo, back);
                if (undone) {
                    await recomputeIds([...before, ...ids]);
                    throw over.length ? raceError(over) : referenceError(sameRef, ctx.via === 'portal' ? ctx.location : null);
                }
                // Someone already acted on the new split (it is no longer ours to undo): it stands — unless the
                // payment was deleted meanwhile (another node deleting its person): then 409 stale, never 200.
                await assertStillThere(h.id, [...before, ...ids]);
            }
            // Back to «Por validar»: whoever reviewed the payment before reviewed ANOTHER version of it (a resent or
            // corrected one awaits a new review; the history keeps who returned it and when). Only while the new
            // split is still the pending one this edit wrote.
            try { await db.run(`UPDATE ${T.transfers} SET reviewed_at = NULL, reviewed_by = NULL WHERE id = ? AND alloc_gen = ? AND status = 'pending'`, [h.id, ng]); }
            catch (e) { console.warn('[conference-manager] payment review stamps kept:', e && e.message); }
            try {
                // The older generations go (never a newer one: it may be another attempt in flight), THEN the new
                // one's mirror: a reader of the parts' own status never sees both generations counting at once.
                await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen < ?`, [h.id, ng]);
                await mirrorFromHeader(h.id, ng);
            } finally {
                await recomputeIds([...before, ...ids]);
            }
            await logEvent(h.id, actor, resent ? 'resent' : 'edited', null);
            return { id: h.id };
        });
    }

    /**
     * validate | return | reject (admin). `legacy` = the pre-2.18 routes: reject without a note.
     * `allowDuplicateReference`: validate a voided payment again although another live payment uses its
     * transfer reference (the admin confirmed it is another transfer).
     */
    function transition(ctx, id, action, { note, expected, legacy, allowDuplicateReference } = {}) {
        const rule = TRANSITIONS[action];
        return withPaymentsLock(async () => {
            const h = await scopedHeader(id, ctx);
            try {
                if (!rule.from.includes(h.status)) throw feeError(409, 'invalid_transition', null, { current: { status: h.status, alloc_gen: Number(h.alloc_gen) } });
                assertExpected(h, expected);
            } catch (e) { return repairThen(h.id, e); }
            if (action === 'return' && !(await canBeReturned(h))) throw feeError(409, 'no_recorder');
            const reason = rule.note ? parseNote(note, !legacy) : null;
            const parts = await liveParts(h.id);
            if (!parts.length) throw feeError(404, 'not_found');
            const ids = parts.map(p => Number(p.inscription_id));
            const partsC = parts.map(p => ({ inscription_id: Number(p.inscription_id), cents: toCents(p.amount) }));
            // A voided payment counts again only while no other payment records it again («Duplicar»): one
            // handover never counts twice (409 source_used).
            const revives = action === 'validate' && h.status === 'rejected';
            // ...nor while another live payment uses its transfer reference: the same bank transfer recorded again
            // by hand as a NEW payment (not «Duplicar») would count twice. EVERY validation checks it — a voided
            // payment validated again (2.18.0 review R5-M1) and a pending or returned one alike (R6-M1): a payment
            // can be recorded with a repeated reference (the portal's «Registrar de todas formas», an older
            // portal's /portal/payments/bulk), and that confirmation came from someone who cannot check the bank.
            // Only the administration validating it, told which payment holds the reference, may confirm it is
            // another transfer (allow_duplicate_reference). The payment's own «Duplicar» family is left out.
            const refGuard = action === 'validate' && !allowDuplicateReference;
            // The confirmed duplicate, for the history: the admin validated a payment whose reference another
            // live payment uses (R6 skeptic: «Validado · admin» alone left no trace of that decision).
            let confirmedRef = null;
            if (action === 'validate') {
                const people = new Map((await db.all(`SELECT id, status, total_due FROM ${T.inscriptions} WHERE id IN (${ph(ids)})`, ids)).map(r => [Number(r.id), r]));
                await assertCaps(people, partsC, h.id, 'validate');
                if (revives) { const used = await liveFamily(rootOf(h), h.id); if (used.length) throw sourceUsed(used, null); }
                const other = await referenceTaken(h.conference_id, h.method, h.reference, h.id, rootOf(h));
                if (other && refGuard) throw referenceError(other, null);
                confirmedRef = other;
            }
            const actor = ctx.actor || 'admin';
            const gen = Number(h.alloc_gen);
            if (action === 'validate') {
                // Two steps, so the re-check below can undo by putting the status back: the flip, then (when it
                // stands) the review stamps.
                const flip = await db.run(`UPDATE ${T.transfers} SET status = 'validated', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = ? AND alloc_gen = ?`,
                    [actor, h.id, h.status, gen]);
                if (!flip || !flip.changes) return repairThen(h.id, feeError(409, 'stale'));
                // Several nodes: another process validated money for these people meanwhile, recorded this voided
                // payment again («Duplicar») or recorded a payment with its transfer reference → this one backs off.
                const over = await overAfterWrite(partsC, 'validate');
                const clash = revives ? await liveFamily(rootOf(h), h.id) : [];
                const sameRef = refGuard && !over.length && !clash.length ? await referenceTaken(h.conference_id, h.method, h.reference, h.id, rootOf(h)) : null;
                if (over.length || clash.length || sameRef) {
                    const undone = await db.run(`UPDATE ${T.transfers} SET status = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = 'validated' AND alloc_gen = ?`,
                        [h.status, actor, h.id, gen]);
                    if (undone && undone.changes) {
                        await recomputeIds(ids);
                        throw over.length ? raceError(over) : clash.length ? sourceUsed(clash, null) : referenceError(sameRef, null);
                    }
                    // Not undone: another node acted on the payment since the flip (its decision stands) — unless it
                    // DELETED it: then this validation counts nowhere and must not answer «validated» (2.18.0 review
                    // R5-L1).
                    await assertStillThere(h.id, ids);
                }
                await db.run(`UPDATE ${T.transfers} SET review_note = NULL, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ? AND status = 'validated' AND alloc_gen = ?`, [actor, h.id, gen]);
            } else {
                const cas = await db.run(`UPDATE ${T.transfers} SET status = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,`
                    + ` updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND status = ? AND alloc_gen = ?`,
                    [rule.to, reason, actor, actor, h.id, h.status, gen]);
                if (!cas || !cas.changes) return repairThen(h.id, feeError(409, 'stale'));
            }
            // The mirror from the header AS IT IS NOW, never `rule.to`: on several nodes another one may have acted
            // on this payment since our compare-and-set (a late 'validated' must not overwrite its void).
            try { await mirrorFromHeader(h.id, gen, { strict: true }); }
            finally { await recomputeIds(ids); }
            await logEvent(h.id, actor, { validate: 'validated', return: 'returned', reject: 'rejected' }[action], reason);
            if (confirmedRef) await logEvent(h.id, actor, 'reference_confirmed', String(Number(confirmedRef.id)));
            return { id: h.id, status: rule.to };
        });
    }

    /** Delete a payment that is not validated (the portal: its own pending / returned ones). */
    function deleteTransfer(ctx, id, expected) {
        return withPaymentsLock(async () => {
            const h = id ? await header(id) : null;
            if (!h || (ctx.via === 'portal' && h.status === 'draft')) throw feeError(404, 'not_found');
            if (ctx.via === 'portal' && !(Number(h.conference_id) === Number(ctx.location.conference_id) && isOwn(h, ctx.location))) throw feeError(404, 'not_found');
            if (h.status === 'validated') throw feeError(409, 'validated_delete');
            try {
                if (!DELETABLE[ctx.via].includes(h.status)) throw feeError(409, 'invalid_transition', null, { current: { status: h.status, alloc_gen: Number(h.alloc_gen) } });
                assertExpected(h, expected);
            } catch (e) { return repairThen(h.id, e); }
            const ids = await peopleOfTransfer(h.id);
            const del = await db.run(`DELETE FROM ${T.transfers} WHERE id = ? AND status = ? AND alloc_gen = ?`, [h.id, h.status, Number(h.alloc_gen)]);
            if (!del || !del.changes) return repairThen(h.id, feeError(409, 'stale'));
            try {
                await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ?`, [h.id]);
                await db.run(`DELETE FROM ${T.transferEvents} WHERE transfer_id = ?`, [h.id]);
            } finally {
                await recomputeIds(ids);
            }
            return { id: h.id };
        });
    }

    /**
     * A pre-2.18 route names a PART (payments.id). Its payment, wrapped on demand, when the part is live:
     * { header, people (live parts), part } or null.
     */
    async function paymentOfPart(partId) {
        let row = partId ? await db.get(`SELECT id, transfer_id, alloc_gen, inscription_id FROM ${T.payments} WHERE id = ?`, [partId]) : null;
        if (!row) return null;
        if (row.transfer_id == null) {
            await withPaymentsLock(() => wrapLegacyPayments({ paymentId: row.id }));
            row = await db.get(`SELECT id, transfer_id, alloc_gen, inscription_id FROM ${T.payments} WHERE id = ?`, [partId]);
            if (!row || row.transfer_id == null) return null;
        }
        const h = await header(row.transfer_id);
        if (!h || h.status === 'draft' || Number(h.alloc_gen) !== Number(row.alloc_gen)) return null;
        const n = await db.get(`SELECT COUNT(*) AS n FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen = ?`, [h.id, Number(h.alloc_gen)]);
        return { header: h, people: Number(n && n.n) || 0, part: row };
    }
    const sharedError = (n) => feeError(409, 'shared', `Este pago es compartido por ${n} personas: revísalo en «Pagos de cuotas».`, { people: n });

    /**
     * DELETE /inscriptions/:id (call inside withPaymentsLock): refuses (409 shared) when the person is a part
     * of a payment of ≥ 2 people; otherwise returns the 1-part payments to delete with the person. Degraded
     * mode: 503 for a person with payment rows. index.js calls it twice around a «tombstone» (several nodes).
     */
    async function inscriptionDeletePlan(inscriptionId) {
        if (!ready) {
            // Degraded mode (see «readiness»): which of the person's rows are parts of a SHARED receipt cannot be
            // told — deleting them could leave a receipt whose split no longer adds up (2.18.0 review R4-L1).
            // A person with payment rows waits for the schema (503); one without any goes.
            const n = await db.get(`SELECT COUNT(*) AS n FROM ${T.payments} WHERE inscription_id = ?`, [inscriptionId]);
            if (Number(n && n.n) > 0) throw feeError(503, 'unavailable', MSG.unavailable_delete);
            return { transfers: [] };
        }
        // Each payment with the generation seen here: the delete removes exactly that split (deleteForInscription).
        const rows = await db.all(`SELECT DISTINCT p.transfer_id AS tid, t.alloc_gen AS gen FROM ${T.payments} p JOIN ${T.transfers} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen`
            + ` WHERE p.inscription_id = ? AND t.status <> 'draft'`, [inscriptionId]);
        const tids = rows.map(r => Number(r.tid));
        if (!tids.length) return { transfers: [] };
        const counts = await db.all(`SELECT p.transfer_id AS tid, COUNT(*) AS n FROM ${T.payments} p JOIN ${T.transfers} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen`
            + ` WHERE p.transfer_id IN (${ph(tids)}) GROUP BY p.transfer_id`, tids);
        const shared = counts.filter(c => Number(c.n) >= 2);
        if (shared.length) {
            const n = Math.max(...shared.map(c => Number(c.n)));
            const statusOf = new Map((await db.all(`SELECT id, status FROM ${T.transfers} WHERE id IN (${ph(shared.map(c => Number(c.tid)))})`,
                shared.map(c => Number(c.tid)))).map(r => [Number(r.id), r.status]));
            const blocking = shared.map(c => ({ id: Number(c.tid), status: statusOf.get(Number(c.tid)) || 'pending' }));
            throw feeError(409, 'shared', sharedDeleteMessage(n, blocking), { people: n, transfer_ids: blocking.map(b => b.id), transfers: blocking });
        }
        return { transfers: rows.map(r => ({ id: Number(r.tid), alloc_gen: Number(r.gen) })) };
    }
    /**
     * What the admin can actually do about the shared payments that block deleting a person — only a
     * pending / returned split can be edited (EDITABLE); a validated one is voided first (D-P10) and a
     * rejected one, which counts nowhere, is simply deleted.
     */
    function sharedDeleteMessage(n, blocking) {
        const ids = (st) => blocking.filter(b => b.status === st).map(b => `#${b.id}`).join(', ');
        const steps = [];
        if (blocking.some(b => EDITABLE.includes(b.status))) steps.push(`quítala del reparto del pago ${blocking.filter(b => EDITABLE.includes(b.status)).map(b => `#${b.id}`).join(', ')} («Editar reparto»)`);
        if (blocking.some(b => b.status === 'validated')) steps.push(`anula el pago validado ${ids('validated')} y regístralo de nuevo sin ella («Duplicar»)`);
        if (blocking.some(b => b.status === 'rejected')) steps.push(`elimina el pago rechazado ${ids('rejected')}`);
        const people = n === 1 ? '1 persona' : `${n} personas`;
        return `La inscripción forma parte de un pago compartido de ${people}: ${steps.join('; ')}, o cancela la inscripción en su lugar.`;
    }
    /**
     * Where a payment the delete plan named stands NOW for person `iid`: { gone } (deleted meanwhile), { notTheirs }
     * (re-split on another node so that the person is no longer one of its live parts: the money moved to someone
     * else — that payment and that correction are not this delete's), { shared } (the person is in it with
     * others now), else { gen, status } — still the person's alone, at generation `gen`.
     */
    async function plannedNow(iid, id) {
        const h = await db.get(`SELECT id, alloc_gen, status FROM ${T.transfers} WHERE id = ?`, [id]);
        if (!h) return { gone: true };
        const live = await db.all(`SELECT inscription_id FROM ${T.payments} WHERE transfer_id = ? AND alloc_gen = ?`, [id, Number(h.alloc_gen)]);
        if (!live.some(r => Number(r.inscription_id) === Number(iid))) return { notTheirs: true };
        if (live.length > 1) return { shared: true };
        return { gen: Number(h.alloc_gen), status: h.status };
    }
    /**
     * The person's 1-person payments (the plan's `transfers`), each header first (its parts stop counting at
     * once) and only at the GENERATION seen — then every part of the person. Several nodes: another node may
     * re-split one of them meanwhile (2.18.0 reviews R5-L1, R6-L2), and deleting it by id alone would take a
     * payment that is no longer this person's, and the other node's correction with it. So:
     *   - before ANYTHING is deleted, every planned payment is read again (plannedNow): one that became shared
     *     answers 409 stale at once — nothing deleted, index.js puts the person back as they were;
     *   - they go in an order that keeps VALIDATED money for last (a refusal further on never costs income);
     *   - a delete whose generation no longer matches reads the payment again: gone, or no longer the person's
     *     (moved to someone else) → left alone, the delete goes on; still the person's alone at a new generation
     *     → deleted at that one; shared now → 409 stale, naming the payments already deleted (in the answer and
     *     in the log) — a person never stays while one of their payments is gone without being told which.
     * Returns the ids of the payments deleted.
     */
    async function deleteForInscription(inscriptionId, transfers) {
        const deleted = [];
        if (ready && transfers && transfers.length) {
            const iid = Number(inscriptionId);
            const todo = [];
            for (const t of transfers) {
                const now = await plannedNow(iid, t.id);
                if (now.gone || now.notTheirs) continue;
                if (now.shared) {
                    await recomputeIds([iid]);
                    throw feeError(409, 'stale', `El pago #${t.id} de esta persona cambió mientras tanto: vuelve a cargar e inténtalo de nuevo.`, { transfer_id: t.id });
                }
                todo.push({ id: Number(t.id), gen: now.gen, validated: now.status === 'validated' });
            }
            todo.sort((a, b) => Number(a.validated) - Number(b.validated) || a.id - b.id);
            for (const t of todo) {
                let gen = t.gen;
                let done = false;
                for (let attempt = 0; attempt < 4; attempt++) {
                    const del = await db.run(`DELETE FROM ${T.transfers} WHERE id = ? AND alloc_gen = ?`, [t.id, gen]);
                    if (del && del.changes) { done = true; break; }
                    const now = await plannedNow(iid, t.id);
                    if (now.gone || now.notTheirs) break;
                    if (now.shared || attempt === 3) {
                        await recomputeIds([iid]);
                        if (deleted.length) console.warn(`[conference-manager] deleting inscription ${iid} stopped at payment #${t.id} (changed on another node); its payments already deleted: ${deleted.map(d => `#${d}`).join(', ')}`);
                        const gone = deleted.length ? ` Ya se eliminaron sus pagos ${deleted.map(d => `#${d}`).join(', ')}.` : '';
                        throw feeError(409, 'stale', `El pago #${t.id} de esta persona cambió mientras tanto: vuelve a cargar e inténtalo de nuevo.${gone}`, { transfer_id: t.id, deleted_transfer_ids: deleted.slice() });
                    }
                    gen = now.gen;
                }
                if (!done) continue;
                deleted.push(t.id);
                await db.run(`DELETE FROM ${T.payments} WHERE transfer_id = ?`, [t.id]);
                await db.run(`DELETE FROM ${T.transferEvents} WHERE transfer_id = ?`, [t.id]);
            }
        }
        // The person's own parts — never another person's: a payment moved to someone else keeps its parts.
        await db.run(`DELETE FROM ${T.payments} WHERE inscription_id = ?`, [inscriptionId]);
        return deleted;
    }
    /**
     * A deleted conference's payments and their history. `transferIds`: the conference's headers read BEFORE its
     * row was deleted (with foreign keys on, that delete has already cascaded them away, and the history is
     * found through them); without it, the headers still present.
     */
    async function deleteConference(conferenceId, transferIds = null) {
        if (!ready) return;   // no headers to delete (the boot hygiene removes a deleted conference's later)
        const ids = Array.isArray(transferIds) ? transferIds.filter(n => Number.isInteger(n) && n > 0) : null;
        if (ids) {
            for (let i = 0; i < ids.length; i += 400) {
                const chunk = ids.slice(i, i + 400);
                await db.run(`DELETE FROM ${T.transferEvents} WHERE transfer_id IN (${chunk.map(() => '?').join(', ')})`, chunk);
            }
        } else {
            await db.run(`DELETE FROM ${T.transferEvents} WHERE transfer_id IN (SELECT x.id FROM ${T.transfers} x WHERE x.conference_id = ? )`, [conferenceId]);
        }
        await db.run(`DELETE FROM ${T.transfers} WHERE conference_id = ?`, [conferenceId]);
    }
    /** DELETE /locations/:id: a payment that location's portal recorded keeps its people and money. */
    async function detachLocation(locationId) {
        if (!ready) return;
        await db.run(`UPDATE ${T.transfers} SET location_id = NULL WHERE location_id = ?`, [locationId]);
    }

    /** GET /inscriptions/:id/payments (pre-2.18 shape): the person's live parts, newest first, no receipts. */
    async function partsOfPerson(inscriptionId, withProof) {
        if (!ready) {
            // The pre-2.18 shape from the rows themselves (degraded mode, see «readiness»).
            const legacy = await db.all(`SELECT p.id, p.inscription_id, p.amount, p.date, p.method, p.reference, ${EFFECTIVE('p', 't')} AS eff_status, p.reviewed_at, p.reviewed_by,`
                + ` CASE WHEN p.proof IS NOT NULL AND p.proof <> '' THEN 1 ELSE 0 END AS p_has_proof FROM ${T.payments} p WHERE p.inscription_id = ? ORDER BY p.date DESC, p.id DESC`, [inscriptionId]);
            return legacy.map(r => ({
                id: r.id, inscription_id: r.inscription_id, amount: money(r.amount), date: r.date, method: r.method || null, reference: r.reference || null,
                status: r.eff_status || null, transfer_id: null, alloc_gen: null, has_proof: !!Number(r.p_has_proof),
                reviewed_at: r.reviewed_at || null, reviewed_by: r.reviewed_by || null, review_note: null, transfer: null,
            }));
        }
        const rows = await db.all(`SELECT p.id, p.inscription_id, p.amount, p.date, p.method, p.reference, p.transfer_id, p.alloc_gen,`
            + ` ${EFFECTIVE('p', 't')} AS eff_status, t.amount AS t_amount, t.status AS t_status, t.paid_on, t.recorded_via, t.location_id AS t_location_id,`
            + ` t.review_note, t.reviewed_at, t.reviewed_by, t.alloc_gen AS t_gen, ${HAS_PROOF('t')} AS t_has_proof,`
            + ` CASE WHEN p.proof IS NOT NULL AND p.proof <> '' THEN 1 ELSE 0 END AS p_has_proof`
            + ` FROM ${T.payments} p LEFT JOIN ${T.transfers} t ON t.id = p.transfer_id`
            + ` WHERE p.inscription_id = ? AND (p.transfer_id IS NULL OR (p.alloc_gen = t.alloc_gen AND t.status <> 'draft'))`
            + ` ORDER BY p.date DESC, p.id DESC`, [inscriptionId]);
        const tids = [...new Set(rows.filter(r => r.transfer_id != null).map(r => Number(r.transfer_id)))];
        const counts = new Map();
        if (tids.length) {
            for (const c of await db.all(`SELECT p.transfer_id AS tid, COUNT(*) AS n FROM ${T.payments} p JOIN ${T.transfers} t ON t.id = p.transfer_id AND p.alloc_gen = t.alloc_gen`
                + ` WHERE p.transfer_id IN (${ph(tids)}) GROUP BY p.transfer_id`, tids)) counts.set(Number(c.tid), Number(c.n));
        }
        const out = [];
        for (const r of rows) {
            const linked = r.transfer_id != null;
            const item = {
                id: r.id, inscription_id: r.inscription_id, amount: money(r.amount),
                date: linked ? (dayOut(r.paid_on) || r.date) : r.date, method: r.method || null, reference: r.reference || null,
                status: r.eff_status || null, transfer_id: linked ? r.transfer_id : null, alloc_gen: linked ? Number(r.alloc_gen) : null,
                has_proof: linked ? !!Number(r.t_has_proof) : !!Number(r.p_has_proof),
                reviewed_at: linked ? (r.reviewed_at || null) : null, reviewed_by: linked ? (r.reviewed_by || null) : null,
                review_note: linked ? (r.review_note || null) : null,
                transfer: linked ? {
                    id: r.transfer_id, amount: money(r.t_amount), status: r.t_status, people: counts.get(Number(r.transfer_id)) || 1,
                    paid_on: dayOut(r.paid_on), recorded_via: r.recorded_via || null, location_id: r.t_location_id == null ? null : r.t_location_id,
                    alloc_gen: Number(r.t_gen),
                } : null,
            };
            if (withProof) {
                // Never a receipt that fails the write rule (storedProofOk): a pre-2.18 one may be a pixel flood.
                const own = linked ? null : ((await db.get(`SELECT proof FROM ${T.payments} WHERE id = ?`, [r.id])) || {}).proof || null;
                item.proof = linked ? await proofOf({ id: r.transfer_id }) : (own && storedProofOk(own) ? own : null);
            }
            out.push(item);
        }
        return out;
    }

    /**
     * What a role with Inscripciones but without Pagos › ver may read of a person's part (2.18.0 review R6-L1):
     * its amount, date, method and status — the pre-2.18 fields of the person's own money, nothing of the payment
     * it belongs to (number, size, people), its reference, receipt or review.
     */
    const briefPart = (p) => ({ id: p.id, inscription_id: p.inscription_id, amount: p.amount, date: p.date, method: p.method || null, status: p.status || null });

    /** /accounting: one read-only income line per VALIDATED payment (D-P15), dated by the payment date (D-P14). */
    async function ledgerFeeLines(conferenceId) {
        // Degraded mode (see «readiness»): every validated row is its own pre-2.18 line.
        const rows = ready
            ? await db.all(`SELECT p.id, p.transfer_id, p.inscription_id, p.amount, p.method, p.reference, p.date, i.location_id,`
                + ` t.method AS t_method, t.reference AS t_reference, t.paid_on, t.location_id AS t_location_id`
                + ` FROM ${T.payments} p LEFT JOIN ${T.transfers} t ON t.id = p.transfer_id JOIN ${T.inscriptions} i ON i.id = p.inscription_id`
                + ` WHERE i.conference_id = ? AND ${EFFECTIVE('p', 't')} = 'validated' ORDER BY p.id`, [conferenceId])
            : (await db.all(`SELECT p.id, p.inscription_id, p.amount, p.method, p.reference, p.date, i.location_id`
                + ` FROM ${T.payments} p JOIN ${T.inscriptions} i ON i.id = p.inscription_id WHERE i.conference_id = ? AND ${EFFECTIVE('p', 't')} = 'validated' ORDER BY p.id`, [conferenceId]))
                .map(r => ({ ...r, transfer_id: null }));
        const lines = [];
        const groups = new Map();
        for (const r of rows) {
            if (r.transfer_id == null) {
                // A part the wrap has not reached yet: the pre-2.18 line.
                lines.push({ id: `fee-${r.id}`, kind: 'income', date: r.date, category: 'Inscripciones', description: 'Pago de inscripción',
                    amount: money(r.amount), method: r.method || null, reference: r.reference || null, inscription_id: r.inscription_id,
                    location_id: r.location_id == null ? null : r.location_id, transfer_id: null, people: 1,
                    allocations: [{ inscription_id: r.inscription_id, amount: money(r.amount) }], source: 'inscription', readonly: true });
                continue;
            }
            const k = Number(r.transfer_id);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(r);
        }
        for (const [tid, parts] of groups) {
            const first = parts[0];
            const cents = parts.reduce((s, p) => s + toCents(p.amount), 0);
            const locs = [...new Set(parts.map(p => (p.location_id == null ? 'null' : String(p.location_id))))];
            const loc = first.t_location_id != null ? first.t_location_id : (locs.length === 1 && locs[0] !== 'null' ? Number(locs[0]) : null);
            lines.push({
                id: `transfer-${tid}`, kind: 'income', date: dayOut(first.paid_on) || first.date, category: 'Inscripciones',
                description: parts.length === 1 ? 'Pago de inscripción' : `Pago de cuotas · ${parts.length} personas`,
                amount: fromCents(cents), method: first.t_method || null, reference: first.t_reference || null,
                inscription_id: parts.length === 1 ? first.inscription_id : null, location_id: loc, transfer_id: tid, people: parts.length,
                allocations: parts.map(p => ({ inscription_id: p.inscription_id, amount: money(p.amount) })),
                source: 'inscription', readonly: true,
            });
        }
        return lines;
    }

    // ── routes ───────────────────────────────────────────────────────────────────────────────────────
    function install(deps) {
        D = deps;
        const { http, allow } = deps;
        const AUTH = { auth: true };
        const adminCtx = (req, conferenceId) => ({ via: 'admin', conferenceId, actor: D.actorOf(req) });
        const portalCtx = (location) => ({ via: 'portal', conferenceId: location.conference_id, location });
        // Every admin fee route: the caller's permission FIRST, then the schema (one more migration attempt;
        // see «readiness»). In that order an account without the section gets its 403 and never starts a
        // migration attempt (DDL) or learns the plugin's internal state from a 503.
        const route = (method, path, section, level, fn) => http.route(method, path, AUTH, async (req, res) => {
            const perms = await allow(req, res, section, level);
            if (!perms) return;
            if (!await ensureReady()) return res.status(503).json({ error: MSG.unavailable, code: 'unavailable' });
            return fn(req, res, perms);
        });

        // ── admin ──
        route('get', '/fee-payments', 'payments', 'view', async (req, res, perms) => {
            const cid = D.positiveInt(req.query && req.query.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            try {
                if (!await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid])) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                await ensureWrapped(cid);
                res.json(await adminView(cid, req.query || {}, { showCodes: D.canSeeRegCodes(perms) }));
            } catch (e) { sendFeeError(res, e); }
        });
        route('get', '/fee-payments/:id', 'payments', 'view', async (req, res) => {
            try {
                const id = D.positiveInt(req.params.id);
                const t = id ? await adminDetail(id) : null;
                if (!t) return res.status(404).json({ error: MSG.not_found, code: 'not_found' });
                res.json(t);
            } catch (e) { sendFeeError(res, e); }
        });
        route('get', '/fee-payments/:id/proof', 'payments', 'view', async (req, res) => {
            try {
                const id = D.positiveInt(req.params.id);
                const h = id ? await header(id) : null;
                const r = h && h.status !== 'draft' ? await proofRead(h) : { proof: null, invalid: false };
                if (r.invalid) return res.status(422).json({ error: MSG.invalid_proof, code: 'invalid_proof' });
                if (!r.proof) return res.status(404).json({ error: 'Este pago no tiene comprobante.', code: 'no_proof' });
                res.json({ id: h.id, proof: r.proof });
            } catch (e) { sendFeeError(res, e); }
        });
        route('post', '/fee-payments', 'payments', 'manage', async (req, res) => {
            try {
                const cid = D.positiveInt(req.body && req.body.conference_id);
                if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
                if (!await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid])) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const input = parseBody(req.body);
                const r = await createTransfer(adminCtx(req, cid), input);
                res.json({ success: true, id: r.id, replayed: r.replayed, transfer: await adminDetail(r.id) });
            } catch (e) { sendFeeError(res, e); }
        });
        route('put', '/fee-payments/:id', 'payments', 'manage', async (req, res) => {
            try {
                const id = D.positiveInt(req.params.id);
                if (!id) throw feeError(404, 'not_found');
                const expected = parseExpected(req.body && req.body.expected, true);
                const input = parseBody(req.body);
                await editTransfer(adminCtx(req, null), id, input, expected);
                res.json({ success: true, transfer: await adminDetail(id) });
            } catch (e) { sendFeeError(res, e); }
        });
        for (const action of Object.keys(TRANSITIONS)) {
            route('post', `/fee-payments/:id/${action}`, 'payments', 'manage', async (req, res) => {
                try {
                    const id = D.positiveInt(req.params.id);
                    if (!id) throw feeError(404, 'not_found');
                    const body = req.body || {};
                    const r = await transition(adminCtx(req, null), id, action, {
                        note: body.note, expected: parseExpected(body.expected, true),
                        allowDuplicateReference: [true, 1, '1'].includes(body.allow_duplicate_reference),
                    });
                    res.json({ success: true, status: r.status, transfer: await adminDetail(id) });
                } catch (e) { sendFeeError(res, e); }
            });
        }
        route('delete', '/fee-payments/:id', 'payments', 'manage', async (req, res) => {
            try {
                const id = D.positiveInt(req.params.id);
                if (!id) throw feeError(404, 'not_found');
                await deleteTransfer(adminCtx(req, null), id, parseExpected(req.body && req.body.expected, false));
                res.json({ success: true });
            } catch (e) { sendFeeError(res, e); }
        });

        // ── coordinator portal (own location only; one request per view — the login throttle) ──
        const portalRoute = (method, path, fn) => http.route(method, path, async (req, res) => {
            const location = await D.resolvePortalLocation(req);
            if (!location) return res.status(401).json({ error: 'No token' });
            if (!await ensureReady()) return res.status(503).json({ error: MSG.unavailable_portal, code: 'unavailable' });
            try { await fn(req, res, location); } catch (e) { sendFeeError(res, e); }
        });
        portalRoute('get', '/portal/fee-payments', async (req, res, location) => {
            await ensureWrapped(location.conference_id);
            res.json(await portalView(location));
        });
        portalRoute('get', '/portal/fee-payments/:id/proof', async (req, res, location) => {
            const id = D.positiveInt(req.params.id);
            const h = id ? await header(id) : null;
            if (!h || h.status === 'draft' || Number(h.conference_id) !== Number(location.conference_id) || !isOwn(h, location)) {
                return res.status(404).json({ error: MSG.not_found, code: 'not_found' });
            }
            const r = await proofRead(h);
            if (r.invalid) return res.status(422).json({ error: MSG.invalid_proof, code: 'invalid_proof' });
            if (!r.proof) return res.status(404).json({ error: 'Este pago no tiene comprobante.', code: 'no_proof' });
            res.json({ id: h.id, proof: r.proof });
        });
        portalRoute('post', '/portal/fee-payments', async (req, res, location) => {
            const methods = D.enabledPaymentMethods(location);
            if (!methods.length) throw feeError(400, 'no_methods');
            const input = parseBody(req.body, { methods });
            input.leavePending = true;
            const r = await createTransfer(portalCtx(location), input);
            res.json({ success: true, id: r.id, replayed: r.replayed, view: await portalView(location) });
        });
        portalRoute('put', '/portal/fee-payments/:id', async (req, res, location) => {
            const id = D.positiveInt(req.params.id);
            if (!id) throw feeError(404, 'not_found');
            await scopedHeader(id, portalCtx(location));   // 404 before any body rule: not this location's payment
            const expected = parseExpected(req.body && req.body.expected, true);
            const input = parseBody(req.body, { methods: D.enabledPaymentMethods(location) });
            await editTransfer(portalCtx(location), id, input, expected);
            res.json({ success: true, id, view: await portalView(location) });
        });
        portalRoute('delete', '/portal/fee-payments/:id', async (req, res, location) => {
            const id = D.positiveInt(req.params.id);
            if (!id) throw feeError(404, 'not_found');
            await deleteTransfer(portalCtx(location), id, parseExpected(req.body && req.body.expected, false));
            res.json({ success: true, view: await portalView(location) });
        });
    }

    return {
        // boot
        migrate, bootHygiene, wrapLegacyPayments, ensureWrapped, ensureReady,
        /** True once the schema is in place (see «readiness»). */
        get ready() { return ready; },
        // money readers (PERSON_MONEY is built per read: it follows the readiness)
        EFFECTIVE, PARTS, personSum, get PERSON_MONEY() { return personMoney(); }, recomputePayments, recomputeIds,
        // ops for index.js
        withPaymentsLock, feeError, sendFeeError, parseBody, parseNote, createTransfer, editTransfer, transition, deleteTransfer,
        paymentOfPart, sharedError, inscriptionDeletePlan, deleteForInscription, deleteConference, detachLocation, partsOfPerson, briefPart, ledgerFeeLines,
        portalFeatures, portalView, adminView, adminDetail, reportFigures,
        install,
        // pure helpers and constants (tests, docs)
        dayOut, MAX_PARTS, TRANSITIONS, EDITABLE, DELETABLE, MSG,
    };
}

module.exports = { createFeePayments, MAX_PARTS, TRANSITIONS, EDITABLE, DELETABLE };
