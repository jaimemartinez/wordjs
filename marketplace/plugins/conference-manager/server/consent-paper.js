/**
 * «Consentimiento en papel» (conference-manager 2.34.0): the data consent signed by hand, next to the e-mailed
 * one-time code (server/consent.js), never instead of it.
 *
 * FLOW (a locality's coordinator in the portal, or the admin for any locality):
 *   1. «Abrir hoja para imprimir o guardar como PDF»: a SHEET is made for the locality — its people still without an authorization, frozen
 *      in that order, plus blank rows for walk-ins, under the policy version in force (an append-only snapshot,
 *      consent_policies). The printable page (server/consent-paper-sheet.js) can be downloaded again at any time:
 *      it is always the same sheet, with the same id on every page.
 *   2. The signed pages are uploaded: photos (compressed in the browser) or a PDF, one file at a time, up to
 *      MAX_FILES per sheet. They are kept privately in the plugin's own table (never a public URL), each with the
 *      SHA-256 of its bytes; a file is never replaced or deleted.
 *   3. A checklist: who signed. ONE signature covers the whole authorization (general, image and health); the sheet
 *      has two opt-out boxes per person, «No autorizo datos de salud» and «No autorizo uso de imagen», so health and
 *      image start authorized and the coordinator unticks them for whoever marked an opt-out. A minor needs the
 *      representative's name. Each person ticked gets a «granted» row in their own hash chain (the same log, chain
 *      and export as an e-mailed signature) with `data.method = 'paper'` and `data.opt_outs`: the sheet's id and row,
 *      the policy version and its SHA-256, the SHA-256 of the sheet's text, every uploaded file's SHA-256, and who
 *      uploaded and who ticked, when. The inscription leaves «Autorización pendiente» exactly as with the code. A
 *      verbal health authorization given at registration is confirmed by it, or its answer deleted on a health
 *      opt-out (consent.js settleVerbal).
 *   4. A wrong tick is undone with a reason: a NEW «paper_unmarked» row (the log stays append-only), the person
 *      goes back to pending, and any health answer is deleted. Revoking stays what it was (consent.js).
 * Every sheet made and every file uploaded is also logged, in the conference's own chain (inscription_id NULL).
 *
 * SCOPE. A coordinator reaches only their own locality (the portal session's); the admin, any locality, with the
 * «inscriptions» permission (view to see, manage to make, upload and tick).
 *
 * SQL: own prefixed tables, portable (SQLite / PostgreSQL / MySQL); a file is a base64 data URL in a TEXT column
 * (LONGTEXT on MySQL), like a payment receipt.
 */
'use strict';

const crypto = require('crypto');
const { sheetHtml, sheetText, LANGS, PAPERS } = require('./consent-paper-sheet');
const { sheetPdf } = require('./consent-paper-pdf');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isoUtc = (ms = Date.now()) => new Date(ms).toISOString();
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

const MAX_BLANK = 40;
const DEFAULT_BLANK = 5;
const MAX_FILES = 20;
const MAX_FILE_CHARS = 3_000_000;        // ~2.2 MB of file
const MAX_MARKS = 300;
const DATA_URL_RE = /^data:(image\/jpeg|image\/png|image\/webp|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/;
/** The file's first bytes must say what its data URL claims. */
function bytesAre(mime, b) {
    if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (mime === 'image/png') return b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG';
    if (mime === 'image/webp') return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    if (mime === 'application/pdf') return b.subarray(0, 5).toString('latin1') === '%PDF-';
    return false;
}

const MSG = {
    off: 'Esta conferencia no pide la autorización de datos.',
    location: 'Localidad no encontrada.',
    sheet: 'Hoja no encontrada.',
    file: 'Archivo no encontrado.',
    fileBad: 'Sube una foto (JPG, PNG o WebP) o un PDF de la hoja firmada.',
    fileBig: 'El archivo es demasiado grande (máximo 2 MB). Toma la foto de nuevo o divide el PDF.',
    // 2.36.7: an iPhone photo kept as HEIC (the page converts it when the browser can read it; this is the rest).
    fileHeic: 'Esta foto está en formato HEIC (iPhone) y no se pudo convertir. Súbela desde el iPhone (la convierte a JPG) o, en el iPhone, Ajustes › Cámara › Formatos › «Más compatible».',
    tooMany: `Esta hoja ya tiene ${MAX_FILES} archivos.`,
    noFiles: 'Sube primero la foto o el PDF de la hoja firmada.',
    none: 'Marca al menos una persona que firmó.',
    choice: 'Las casillas de salud e imagen deben ser verdadero o falso.',
    rep: 'Escribe el nombre del representante legal del menor.',
    granted: 'Esta persona ya autorizó el tratamiento de sus datos.',
    notFound: 'Inscripción no encontrada.',
    cancelled: 'La inscripción está cancelada.',
    notPaper: 'Esta persona no tiene una autorización en papel para deshacer.',
    reason: 'Escribe por qué se deshace la marca (por ejemplo, «se marcó a la persona equivocada»).',
    inUse: 'Esta hoja ya tiene la foto o el PDF firmado: se conserva como evidencia y no se puede eliminar.',
};

/**
 * `core` — what consent.js shares: db, T, P, createIndex, createUniqueIndex, addColumnIfMissing, append,
 * policySnapshot, textsOf, identityOf, formOf, conferenceOf, requestOf, isEnabled, ensureReady, minorByAge,
 * settingsOf, deps() (the install deps: personWithName, health, randomToken, …).
 */
function createPaper(core) {
    const { db, T, P, createIndex, createUniqueIndex, addColumnIfMissing } = core;
    T.consentSheets = `${P}consent_sheets`;
    T.consentSheetFiles = `${P}consent_sheet_files`;

    async function migrate() {
        await db.createTable(T.consentSheets, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'location_id INT NOT NULL',
            'code VARCHAR(16) NOT NULL',
            'lang VARCHAR(8)',
            'paper VARCHAR(8)',
            'policy_id INT',
            'policy_version VARCHAR(40)',
            'policy_sha256 VARCHAR(64)',
            'text TEXT NOT NULL',
            'text_sha256 VARCHAR(64) NOT NULL',
            'roster TEXT NOT NULL',
            'blank INT',
            'created_by VARCHAR(120)',
            'created_utc VARCHAR(32) NOT NULL',
            'created_s INT NOT NULL',
        ]);
        if (addColumnIfMissing) await addColumnIfMissing(T.consentSheets, 'paper', 'VARCHAR(8)');
        await createUniqueIndex(`${P}uidx_consent_sheets_code`, T.consentSheets, 'code');
        await createIndex(`${P}idx_consent_sheets_loc`, T.consentSheets, 'conference_id, location_id');
        // Never updated, never deleted: each file is evidence (and a sheet with a file is never deleted either).
        await db.createTable(T.consentSheetFiles, [
            'id INT_PK',
            'sheet_id INT NOT NULL',
            'conference_id INT NOT NULL',
            'location_id INT NOT NULL',
            'name VARCHAR(120)',
            'mime VARCHAR(40) NOT NULL',
            'bytes INT NOT NULL',
            'sha256 VARCHAR(64) NOT NULL',
            'data TEXT NOT NULL',
            'uploaded_by VARCHAR(120)',
            'uploaded_utc VARCHAR(32) NOT NULL',
            'uploaded_s INT NOT NULL',
        ]);
        await createIndex(`${P}idx_consent_sheet_files_sheet`, T.consentSheetFiles, 'sheet_id');
    }

    const filesOf = async (sheetId) => (await db.all(
        `SELECT id, name, mime, bytes, sha256, uploaded_by, uploaded_utc FROM ${T.consentSheetFiles} WHERE sheet_id = ? ORDER BY id ASC`, [sheetId]))
        .map(f => ({ id: Number(f.id), name: f.name || '', mime: f.mime, bytes: Number(f.bytes), sha256: f.sha256, uploaded_by: f.uploaded_by || null, uploaded_utc: f.uploaded_utc }));
    const rosterOf = (sheet) => { try { const r = JSON.parse(sheet.roster); return Array.isArray(r) ? r : []; } catch { return []; } };

    /** The locality's people (not cancelled): name, consent state and how it was given, minor by «Edad». */
    async function peopleOf(cid, locationId) {
        const D = core.deps();
        const rows = await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND location_id = ? AND (status IS NULL OR status <> 'cancelled') ORDER BY id ASC`, [cid, locationId]);
        const form = await core.formOf(cid);
        const out = [];
        for (const ins of rows) {
            const r = await core.requestOf(ins.id);
            out.push({
                id: Number(ins.id),
                name: (await D.personWithName(ins)).name || `#${ins.id}`,
                state: r && ['granted', 'revoked'].includes(r.state) ? r.state : 'pending',
                method: r && r.state === 'granted' ? (r.method || 'otp') : null,
                sheet_id: r && r.state === 'granted' && r.sheet_id != null ? Number(r.sheet_id) : null,
                health: !!(r && Number(r.health)), image: !!(r && Number(r.image)),
                minor: core.minorByAge(ins, form),
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    }

    async function sheetsOf(cid, locationId) {
        const rows = await db.all(`SELECT * FROM ${T.consentSheets} WHERE conference_id = ? AND location_id = ? ORDER BY id DESC`, [cid, locationId]);
        const out = [];
        for (const s of rows) {
            const marked = await db.get(`SELECT COUNT(*) AS n FROM ${T.consentRequests} WHERE sheet_id = ? AND state = 'granted' AND method = 'paper'`, [s.id]);
            const files = await filesOf(s.id);
            out.push({
                id: Number(s.id), code: s.code, lang: s.lang, paper: s.paper || 'letter', policy_version: s.policy_version, created_by: s.created_by || null, created_utc: s.created_utc,
                rows: rosterOf(s).length, blank: Number(s.blank) || 0, files, marked: Number(marked && marked.n) || 0,
                // The printed rows, in the sheet's order, with the names as printed (2.36.2: the checklist shows the sheet).
                roster: rosterOf(s).map(p => ({ row: p.row, inscription_id: p.id, name: p.name })),
                deletable: !files.length && !Number(marked && marked.n),
            });
        }
        return out;
    }

    /** What the printable page (HTML or PDF) needs for a stored sheet. */
    async function sheetData(sheet) {
        const conf = await core.conferenceOf(sheet.conference_id);
        const loc = await db.get(`SELECT name FROM ${T.locations} WHERE id = ?`, [sheet.location_id]);
        const pol = sheet.policy_id ? await db.get(`SELECT body FROM ${T.consentPolicies} WHERE id = ?`, [sheet.policy_id]) : null;
        let body = {};
        try { body = pol ? JSON.parse(pol.body) : {}; } catch { body = {}; }
        const { texts } = await core.textsOf(sheet.conference_id, conf, body);
        return ({
            lang: sheet.lang, paper: sheet.paper, code: sheet.code, created_utc: sheet.created_utc, conference: conf ? conf.name : '', location: loc ? loc.name : '',
            policy: { url: body.policy_url || '', version: sheet.policy_version, sha256: sheet.policy_sha256 },
            responsible: body.responsible || '', contact: body.contact_email || '', texts,
            people: rosterOf(sheet).map(p => ({ row: p.row, name: p.name })), blank: Number(sheet.blank) || 0,
        });
    }
    const htmlOf = async (sheet) => sheetHtml(await sheetData(sheet));
    /**
     * The sheet as a real PDF (2.36.3): what «Descargar PDF» saves and what «Imprimir» opens — a phone ignores
     * window.print() from a frame, and the HTML download was an .html file. { mime, filename, b64 }.
     */
    async function pdfOf(sheet) {
        const bytes = sheetPdf(await sheetData(sheet));
        return { mime: 'application/pdf', filename: `consentimiento-${String(sheet.code).replace(/[^A-Za-z0-9]/g, '')}.pdf`, b64: bytes.toString('base64') };
    }
    /** The PDF of a sheet a file ticket names (the portal's file route): null when the sheet is gone. */
    async function pdfFile(cid, sheetId) {
        const sheet = await db.get(`SELECT * FROM ${T.consentSheets} WHERE id = ? AND conference_id = ?`, [Number(sheetId) || 0, Number(cid) || 0]);
        return sheet ? pdfOf(sheet) : null;
    }

    async function newCode() {
        for (let i = 0; i < 5; i++) {
            const code = String(await core.deps().randomToken(8)).slice(0, 10).toUpperCase();
            if (!await db.get(`SELECT id FROM ${T.consentSheets} WHERE code = ?`, [code])) return code;
        }
        throw new Error('no sheet code');
    }

    /** A new sheet for the locality (scope = { cid, location, actor, via }). */
    async function createSheet(scope, body, httpError) {
        const cid = scope.cid;
        const b = body || {};
        const blank = b.blank === undefined || b.blank === '' ? DEFAULT_BLANK : Number(b.blank);
        if (!Number.isInteger(blank) || blank < 0 || blank > MAX_BLANK) throw httpError(400, `Las filas en blanco deben ser un número entre 0 y ${MAX_BLANK}.`);
        const s = await core.settingsOf(cid);
        const lang = b.lang ? String(b.lang).toLowerCase() : s.mail_lang;
        if (!LANGS.includes(lang)) throw httpError(400, 'Idioma de la hoja inválido (es, en o pt).');
        // «Carta» (Letter) by default, the Colombian standard; A4 on request.
        const paper = b.paper ? String(b.paper).toLowerCase() : 'letter';
        if (!PAPERS[paper]) throw httpError(400, 'Tamaño de papel inválido (carta o A4).');
        const conf = await core.conferenceOf(cid);
        const { texts } = await core.textsOf(cid, conf);
        const policy = await core.policySnapshot(cid, s);
        // 2.36.16: `inscription_ids` — a sheet for the people chosen in the list (of this locality, not yet confirmed);
        // without it, everyone of the locality still to confirm, as before.
        let only = null;
        if (b.inscription_ids !== undefined) {
            if (!Array.isArray(b.inscription_ids) || b.inscription_ids.length > 500) throw httpError(400, 'Lista de personas inválida.');
            only = new Set(b.inscription_ids.map(Number).filter(n => Number.isInteger(n) && n > 0));
            if (!only.size) throw httpError(400, 'Escoge al menos una persona para la hoja.');
        }
        const people = (await peopleOf(cid, scope.location.id)).filter(p => p.state !== 'granted' && (!only || only.has(Number(p.id))));
        if (only && !people.length) throw httpError(400, 'Ninguna de las personas escogidas es de esta localidad o falta por confirmar.');
        const roster = people.map((p, i) => ({ row: i + 1, id: p.id, name: p.name }));
        const text = sheetText({ lang, conference: conf ? conf.name : '', location: scope.location.name, policy: { url: s.policy_url, version: s.policy_version, sha256: policy.sha256 },
            responsible: s.responsible, contact: s.contact_email, texts });
        const code = await newCode();
        const ms = Date.now();
        const r = await db.run(`INSERT INTO ${T.consentSheets} (conference_id, location_id, code, lang, paper, policy_id, policy_version, policy_sha256, text, text_sha256, roster, blank, created_by, created_utc, created_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [cid, scope.location.id, code, lang, paper, policy.id, s.policy_version, policy.sha256, text, sha256(text), JSON.stringify(roster), blank, scope.actor, isoUtc(ms), Math.floor(ms / 1000)]);
        const id = Number(r.lastID);
        await core.append({ conference_id: cid, inscription_id: null, kind: 'paper_sheet_created', actor: scope.actor, policy_version: s.policy_version, policy_sha256: policy.sha256, text_sha256: sha256(text),
            data: { sheet_id: id, code, location_id: Number(scope.location.id), location: scope.location.name, rows: roster.length, blank, lang, via: scope.via } });
        const sheet = await db.get(`SELECT * FROM ${T.consentSheets} WHERE id = ?`, [id]);
        return { sheet: { id, code, lang, paper, rows: roster.length, blank }, html: await htmlOf(sheet) };
    }

    async function upload(scope, sheet, body, httpError) {
        const b = body || {};
        const url = typeof b.data_url === 'string' ? b.data_url.trim() : '';
        if (url.length > MAX_FILE_CHARS) throw httpError(413, MSG.fileBig);
        if (/^data:image\/hei[cf][;,]/i.test(url)) throw httpError(400, MSG.fileHeic);
        const m = DATA_URL_RE.exec(url);
        if (!m) throw httpError(400, MSG.fileBad);
        const mime = m[1];
        const bytes = Buffer.from(m[2], 'base64');
        if (bytes.length < 16 || !bytesAre(mime, bytes)) throw httpError(400, MSG.fileBad);
        const n = await db.get(`SELECT COUNT(*) AS n FROM ${T.consentSheetFiles} WHERE sheet_id = ?`, [sheet.id]);
        if (Number(n && n.n) >= MAX_FILES) throw httpError(409, MSG.tooMany);
        const hash = sha256(bytes);
        const name = clean(b.name, 120) || null;
        const ms = Date.now();
        const r = await db.run(`INSERT INTO ${T.consentSheetFiles} (sheet_id, conference_id, location_id, name, mime, bytes, sha256, data, uploaded_by, uploaded_utc, uploaded_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sheet.id, sheet.conference_id, sheet.location_id, name, mime, bytes.length, hash, url, scope.actor, isoUtc(ms), Math.floor(ms / 1000)]);
        const id = Number(r.lastID);
        await core.append({ conference_id: sheet.conference_id, inscription_id: null, kind: 'paper_uploaded', actor: scope.actor,
            data: { sheet_id: Number(sheet.id), code: sheet.code, file_id: id, name, mime, bytes: bytes.length, sha256: hash, via: scope.via } });
        return { id, name: name || '', mime, bytes: bytes.length, sha256: hash, uploaded_by: scope.actor, uploaded_utc: isoUtc(ms) };
    }

    // Ticks and undos are serialised in this process: two staff members ticking the same person at once must not
    // both find them pending.
    let markLock = Promise.resolve();
    const locked = (fn) => { const run = markLock.then(fn, fn); markLock = run.then(() => {}, () => {}); return run; };
    const mark = (scope, sheet, body, httpError) => locked(() => markNow(scope, sheet, body, httpError));
    const unmark = (scope, ins, body, httpError) => locked(() => unmarkNow(scope, ins, body, httpError));

    const removeSheet = (scope, sheet, httpError) => locked(() => removeSheetNow(scope, sheet, httpError));

    /**
     * Delete a sheet that was never used (2.36.2): printed by mistake, or with the wrong language or paper. Only while it
     * has no signed page uploaded — a file is evidence, and ticks need one first, so no one was ever marked on it — and
     * nobody's authorization names it. The hash chain keeps both the creation and the deletion.
     */
    async function removeSheetNow(scope, sheet, httpError) {
        const files = await db.get(`SELECT COUNT(*) AS n FROM ${T.consentSheetFiles} WHERE sheet_id = ?`, [sheet.id]);
        const named = await db.get(`SELECT COUNT(*) AS n FROM ${T.consentRequests} WHERE sheet_id = ?`, [sheet.id]);
        if (Number(files && files.n) || Number(named && named.n)) throw httpError(409, MSG.inUse);
        await db.run(`DELETE FROM ${T.consentSheets} WHERE id = ?`, [sheet.id]);
        await core.append({ conference_id: sheet.conference_id, inscription_id: null, kind: 'paper_sheet_deleted', actor: scope.actor,
            policy_version: sheet.policy_version, policy_sha256: sheet.policy_sha256, text_sha256: sheet.text_sha256,
            data: { sheet_id: Number(sheet.id), code: sheet.code, location_id: Number(sheet.location_id), rows: rosterOf(sheet).length, blank: Number(sheet.blank) || 0,
                printed_utc: sheet.created_utc, printed_by: sheet.created_by || null, via: scope.via } });
        return { deleted: Number(sheet.id) };
    }

    /** Tick who signed (all checked first, then each one logged). Returns { marked: [ids] }. */
    async function markNow(scope, sheet, body, httpError) {
        const D = core.deps();
        const list = Array.isArray((body || {}).marks) ? body.marks : [];
        if (!list.length) throw httpError(400, MSG.none);
        if (list.length > MAX_MARKS) throw httpError(400, MSG.none);
        const files = await filesOf(sheet.id);
        if (!files.length) throw httpError(409, MSG.noFiles);
        const roster = rosterOf(sheet);
        const form = await core.formOf(sheet.conference_id);
        const fail = (status, error, id, field) => { const e = httpError(status, error); e.extra = { inscription_id: id, field }; return e; };
        const plan = [];
        const seen = new Set();
        for (const raw of list) {
            const id = Number(raw && raw.inscription_id);
            if (!Number.isInteger(id) || id <= 0 || seen.has(id)) throw httpError(400, MSG.notFound);
            seen.add(id);
            const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND conference_id = ? AND location_id = ?`, [id, sheet.conference_id, sheet.location_id]);
            if (!ins) throw fail(404, MSG.notFound, id);
            if (ins.status === 'cancelled') throw fail(409, MSG.cancelled, id);
            const r = await core.requestOf(id);
            if (r && r.state === 'granted') throw fail(409, MSG.granted, id);
            // Authorized unless the person marked the opt-out box («No autorizo …»).
            if ((raw.health !== undefined && typeof raw.health !== 'boolean') || (raw.image !== undefined && typeof raw.image !== 'boolean')) throw fail(400, MSG.choice, id, 'choice');
            const healthYes = raw.health !== false, imageYes = raw.image !== false;
            const byAge = core.minorByAge(ins, form);
            const minor = byAge === true || (byAge == null && raw.minor === true);
            let representative = null;
            if (minor) {
                const rep = raw.representative || {};
                representative = { name: clean(rep.name, 120), document: clean(rep.document, 60) || null };
                if (!representative.name) throw fail(400, MSG.rep, id, 'representative');
            }
            const onRoster = roster.find(p => Number(p.id) === id);
            const typedRow = Number(raw.row);
            const row = onRoster ? onRoster.row : (Number.isInteger(typedRow) && typedRow > roster.length && typedRow <= roster.length + (Number(sheet.blank) || 0) ? typedRow : null);
            plan.push({ ins, r, health: healthYes, image: imageYes, minor, representative, row, walk_in: !onRoster });
        }
        const policy = { url: '', version: sheet.policy_version, sha256: sheet.policy_sha256, snapshot_id: sheet.policy_id == null ? null : Number(sheet.policy_id) };
        const pol = sheet.policy_id ? await db.get(`SELECT body FROM ${T.consentPolicies} WHERE id = ?`, [sheet.policy_id]) : null;
        let polBody = {};
        try { polBody = pol ? JSON.parse(pol.body) : {}; } catch { polBody = {}; }
        policy.url = polBody.policy_url || '';
        const marked = [];
        for (const p of plan) {
            const ev = await core.append({
                conference_id: sheet.conference_id, inscription_id: p.ins.id, request_id: p.r ? p.r.id : null, kind: 'granted', email: (p.r && p.r.email) || null, actor: scope.actor,
                policy_version: sheet.policy_version, policy_sha256: sheet.policy_sha256, text_sha256: sheet.text_sha256,
                general: true, health: p.health, image: p.image,
                data: {
                    method: 'paper',
                    opt_outs: { health: !p.health, image: !p.image },
                    subject: await core.identityOf(p.ins, form),
                    minor: p.minor, representative: p.representative,
                    policy, text: sheet.text, contact: polBody.contact_email || null, responsible: polBody.responsible || null,
                    sheet: { id: Number(sheet.id), code: sheet.code, row: p.row, walk_in: p.walk_in, lang: sheet.lang, printed_utc: sheet.created_utc, printed_by: sheet.created_by || null },
                    files: files.map(f => ({ id: f.id, sha256: f.sha256, mime: f.mime, bytes: f.bytes, uploaded_by: f.uploaded_by, uploaded_utc: f.uploaded_utc })),
                    marked_by: scope.actor, via: scope.via,
                },
            });
            await core.grantPaper(p.ins, p.r, { health: p.health, image: p.image, at_s: ev.at_s, sheet_id: Number(sheet.id) });
            await core.settleVerbal({ inscription_id: p.ins.id }, ev, p.health, { via: 'paper' });
            if (!p.health) await D.health.clearInscription(p.ins.id);
            marked.push(Number(p.ins.id));
        }
        return { marked };
    }

    /** Undo a wrong tick: a new row, the person back to pending. */
    async function unmarkNow(scope, ins, body, httpError) {
        const D = core.deps();
        const reason = clean((body || {}).reason, 500);
        const r = await core.requestOf(ins.id);
        if (!r || r.state !== 'granted' || r.method !== 'paper') throw httpError(409, MSG.notPaper);
        if (!reason) { const e = httpError(400, MSG.reason); e.extra = { field: 'reason' }; throw e; }
        const last = await db.get(`SELECT id FROM ${T.consentEvents} WHERE inscription_id = ? AND kind = 'granted' ORDER BY id DESC LIMIT 1`, [ins.id]);
        const sheet = r.sheet_id != null ? await db.get(`SELECT id, code FROM ${T.consentSheets} WHERE id = ?`, [r.sheet_id]) : null;
        await core.append({ conference_id: ins.conference_id, inscription_id: ins.id, request_id: r.id, kind: 'paper_unmarked', email: r.email || null, actor: scope.actor,
            general: false, health: false, image: false,
            data: { reason, undoes_event_id: last ? Number(last.id) : null, sheet: sheet ? { id: Number(sheet.id), code: sheet.code } : null, via: scope.via, health_deleted: true } });
        await core.ungrantPaper(r);
        await D.health.clearInscription(ins.id);
        return { state: 'pending' };
    }

    /** The paper sheets a person's log names, with their files' SHA-256 (for the evidence export). */
    async function sheetsForExport(rows) {
        const ids = new Set();
        for (const r of rows) {
            let d = null;
            try { d = r.data ? JSON.parse(r.data) : null; } catch { d = null; }
            if (d && d.sheet && d.sheet.id) ids.add(Number(d.sheet.id));
        }
        const out = [];
        for (const id of ids) {
            const s = await db.get(`SELECT * FROM ${T.consentSheets} WHERE id = ?`, [id]);
            if (!s) continue;
            out.push({ id, code: s.code, lang: s.lang, policy_version: s.policy_version, policy_sha256: s.policy_sha256, text: s.text, text_sha256: s.text_sha256,
                text_sha256_ok: sha256(s.text) === s.text_sha256, created_by: s.created_by, created_utc: s.created_utc, files: await filesOf(id) });
        }
        return out;
    }

    // ── routes ──
    function install(deps) {
        const { http, allow, positiveInt, sendError, httpError, actorOf, resolvePortalLocation, fileTicket } = deps;
        const send = (res, e) => {
            if (e && e.status) return res.status(e.status).json({ error: e.message, ...(e.extra || {}), ...(e.extra ? { data: e.extra } : {}) });
            return sendError(res, e);
        };
        const ready = async (res, cid) => {
            if (!await core.ensureReady()) { res.status(503).json({ error: 'No disponible todavía.' }); return false; }
            if (!await core.isEnabled(cid)) { res.status(409).json({ error: MSG.off }); return false; }
            return true;
        };
        const locationOf = (cid, id) => db.get(`SELECT * FROM ${T.locations} WHERE id = ? AND conference_id = ?`, [id, cid]);
        const sheetById = (id) => db.get(`SELECT * FROM ${T.consentSheets} WHERE id = ?`, [id]);

        // The two doors to the same handlers: the admin (any locality, by permission) and the portal (its own).
        async function adminScope(req, res, level, cid, locationId) {
            if (!await allow(req, res, 'inscriptions', level)) return null;
            if (!cid || !await ready(res, cid)) { if (!cid) res.status(400).json({ error: 'Missing conference_id' }); return null; }
            const location = locationId ? await locationOf(cid, locationId) : null;
            if (!location) { res.status(404).json({ error: MSG.location }); return null; }
            return { cid, location, actor: actorOf(req), via: 'admin' };
        }
        async function portalScope(req, res) {
            const location = await resolvePortalLocation(req);
            if (!location) { res.status(401).json({ error: 'No token' }); return null; }
            const cid = Number(location.conference_id);
            if (!await ready(res, cid)) return null;
            return { cid, location, actor: `portal:${location.name}`, via: 'portal' };
        }
        /** A sheet in the scope (a coordinator never reaches another locality's: 404). */
        async function sheetIn(scope, res, id) {
            const sheet = id ? await sheetById(id) : null;
            if (!sheet || Number(sheet.conference_id) !== scope.cid || Number(sheet.location_id) !== Number(scope.location.id)) { res.status(404).json({ error: MSG.sheet }); return null; }
            return sheet;
        }
        /** The sheet a request names, in its scope (admin: by the sheet's locality and the permission). */
        async function sheetScope(req, res, level, portal, sheetId) {
            if (portal) {
                const scope = await portalScope(req, res);
                if (!scope) return null;
                const sheet = await sheetIn(scope, res, sheetId);
                return sheet ? { scope, sheet } : null;
            }
            if (!await allow(req, res, 'inscriptions', level)) return null;
            const sheet = sheetId ? await sheetById(sheetId) : null;
            if (!sheet) { res.status(404).json({ error: MSG.sheet }); return null; }
            const scope = await adminScope(req, res, level, Number(sheet.conference_id), Number(sheet.location_id));
            return scope ? { scope, sheet } : null;
        }
        const listOf = async (scope) => ({
            location: { id: Number(scope.location.id), name: scope.location.name },
            lang: (await core.settingsOf(scope.cid)).mail_lang,
            sheets: await sheetsOf(scope.cid, scope.location.id), people: await peopleOf(scope.cid, scope.location.id),
            limits: { max_files: MAX_FILES, max_blank: MAX_BLANK, default_blank: DEFAULT_BLANK, max_file_chars: MAX_FILE_CHARS },
        });

        // Two routes per door (the plugin is near the host's cap on routes): one to read, one to act.
        for (const portal of [false, true]) {
            const path = portal ? '/portal/consent/paper' : '/consent/paper';
            const route = (method, handler) => (portal ? http.route(method, path, handler) : http.route(method, path, { auth: true }, handler));

            // GET …/paper ?conference_id&location_id (admin) → { location, lang, sheets, people, limits }
            //   ?sheet_id → { code, html } (the same sheet, printed again) · ?file_id → { name, mime, sha256, data_url }
            //   ?sheet_id&format=pdf → { mime, filename, b64 } (2.36.3: the sheet as a real PDF, to save)
            //   ?sheet_id&format=ticket → { d } (2.36.3: a ticket for /portal/conference/file, which opens the PDF —
            //   on a phone in its own viewer, to print or share)
            route('get', async (req, res) => {
                try {
                    const q = req.query || {};
                    const fileId = positiveInt(q.file_id), sheetId = positiveInt(q.sheet_id);
                    if (fileId) {
                        const f = await db.get(`SELECT * FROM ${T.consentSheetFiles} WHERE id = ?`, [fileId]);
                        if (!f) return res.status(404).json({ error: MSG.file });
                        const s = await sheetScope(req, res, 'view', portal, Number(f.sheet_id));
                        if (!s) return;
                        return res.json({ id: Number(f.id), name: f.name || '', mime: f.mime, bytes: Number(f.bytes), sha256: f.sha256, data_url: f.data });
                    }
                    if (sheetId) {
                        const s = await sheetScope(req, res, 'view', portal, sheetId);
                        if (!s) return;
                        if (q.format === 'pdf') return res.json(await pdfOf(s.sheet));
                        if (q.format === 'ticket') {
                            if (typeof fileTicket !== 'function') return res.status(503).json({ error: 'No disponible todavía.' });
                            return res.json({ d: await fileTicket(Number(s.sheet.conference_id), { kind: 'consent_sheet', sheet_id: Number(s.sheet.id), ids: [] }) });
                        }
                        return res.json({ code: s.sheet.code, html: await htmlOf(s.sheet) });
                    }
                    const scope = portal ? await portalScope(req, res) : await adminScope(req, res, 'view', positiveInt(q.conference_id), positiveInt(q.location_id));
                    if (!scope) return;
                    res.json(await listOf(scope));
                } catch (e) { send(res, e); }
            });
            // POST …/paper { action, … }:
            //   create { [conference_id, location_id,] blank?, lang? } → { sheet, html }
            //   upload { sheet_id, data_url, name? } → the file (its SHA-256)
            //   marks  { sheet_id, marks: [{ inscription_id, health, image, minor?, representative?, row? }] } → { marked }
            //   unmark { inscription_id, reason } → { state: 'pending' }
            //   delete { sheet_id } → { deleted } (only a sheet with no signed page uploaded; else 409)
            route('post', async (req, res) => {
                try {
                    const b = req.body || {};
                    if (b.action === 'create') {
                        const scope = portal ? await portalScope(req, res) : await adminScope(req, res, 'manage', positiveInt(b.conference_id), positiveInt(b.location_id));
                        if (!scope) return;
                        return res.json(await createSheet(scope, b, httpError));
                    }
                    if (b.action === 'upload' || b.action === 'marks' || b.action === 'delete') {
                        const s = await sheetScope(req, res, 'manage', portal, positiveInt(b.sheet_id));
                        if (!s) return;
                        if (b.action === 'delete') return res.json(await removeSheet(s.scope, s.sheet, httpError));
                        return res.json(b.action === 'upload' ? await upload(s.scope, s.sheet, b, httpError) : await mark(s.scope, s.sheet, b, httpError));
                    }
                    if (b.action === 'unmark') {
                        const id = positiveInt(b.inscription_id);
                        const ins = id ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
                        let scope;
                        if (portal) scope = await portalScope(req, res);
                        else {
                            if (!ins) { if (await allow(req, res, 'inscriptions', 'manage')) res.status(404).json({ error: MSG.notFound }); return; }
                            scope = await adminScope(req, res, 'manage', Number(ins.conference_id), Number(ins.location_id));
                        }
                        if (!scope) return;
                        if (!ins || Number(ins.conference_id) !== scope.cid || Number(ins.location_id) !== Number(scope.location.id)) return res.status(404).json({ error: MSG.notFound });
                        return res.json(await unmark(scope, ins, b, httpError));
                    }
                    res.status(400).json({ error: 'Acción desconocida.' });
                } catch (e) { send(res, e); }
            });
        }
    }

    return { migrate, install, sheetsForExport, peopleOf, pdfFile, MSG, LIMITS: { MAX_FILES, MAX_BLANK, DEFAULT_BLANK, MAX_FILE_CHARS } };
}

module.exports = { createPaper, MAX_FILE_CHARS, MAX_FILES };
