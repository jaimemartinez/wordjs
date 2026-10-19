/**
 * «Mi inscripción» (conference-manager 2.23.0): the page a registrant reaches by scanning the QR on their own
 * badge — /portal/conference/yo#c=<registration code> — where, after confirming their identity document, they
 * see their own registration: the virtual badge, their answers, the meals already delivered (and
 * when) and those still to come, and their hotel, room and a map of the hotel.
 *
 * WHO. The registration code is printed on the badge, so it is NOT enough on its own: the page also asks the
 * document type and number the person registered with (the conference's form fields chosen in «Escarapelas ›
 * Uso», detected by their label when not chosen). Both must match. A match opens a SESSION — a 128-bit random
 * token kept by that phone (localStorage), stored here only as its SHA-256 — so the document is not asked again
 * on that phone until it expires (30 days, or the badges' expiry date, whichever comes first) or the person
 * leaves. Nothing about another person is ever shown (no roommates, no other names).
 *
 * THROTTLE. Only failures count: per code (5 wrong documents in 15 minutes lock THAT code for the rest of the
 * window — the holder of the real badge is never locked out by a guesser of another code), per client key and
 * globally. An unknown code and a wrong document answer the same 401; /start names the event and its document
 * types once a code exists (what the badge in hand already says) and counts unknown codes as failures. Only after
 * the document matches does anything personal leave the server.
 *
 * WHEN. The page works while the conference's participant page is on (Escarapelas › Uso, on by default), the
 * inscription is not cancelled, and the badges' expiry date (if any) has not passed.
 *
 * SQL: own prefixed tables, a space before a closing parenthesis after a table name, no `$`, portable.
 */
'use strict';

const crypto = require('crypto');
const { geoPoint } = require('./geo');

const SESSION_DAYS = 30;
const CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;
const SESSION_RE = /^[0-9a-f]{32}$/;
const MSG = {
    nomatch: 'Los datos no coinciden. Revisa el tipo y el número de documento.',
    throttled: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
    disabled: 'Esta página no está disponible para este evento.',
    inactive: 'Esta inscripción ya no está activa. Si es un error, comunícate con los organizadores.',
    expired: 'La información de este evento ya no está disponible.',
    nodoc: 'Tu inscripción no tiene número de documento registrado. Pide ayuda a los organizadores.',
    session: 'Tu sesión terminó. Vuelve a escribir tu documento.',
    unavailable: 'Esta página no está disponible todavía.',
};

/** Document text as compared: letters and digits only, uppercase, accents dropped («1.234.567-8» = «12345678»). */
const normDoc = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** A choice as compared: trimmed, lowercase, accents dropped («Cédula» = «cedula»). */
const normChoice = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * The document fields of a form, as chosen (`chosen` = { type_field, number_field }) or detected by their
 * label: the TYPE is a select whose label speaks of «tipo … documento»; the NUMBER a non-select field whose
 * label names a document number («número de documento», «cédula», «documento», «identificación», «pasaporte»),
 * a unique one preferred. Returns { type, number } (field rows or null).
 */
function docFieldsOf(fields, chosen, isFieldColumn) {
    const usable = (fields || []).filter(f => f && isFieldColumn(f.name));
    const byName = (n) => (n ? usable.find(f => f.name === n) || null : null);
    const label = (f) => normChoice(f.label || f.name);
    let type = byName(chosen && chosen.type_field);
    if (!type) type = usable.find(f => f.type === 'select' && /tipo/.test(label(f)) && /(documento|identificaci|doc\b)/.test(label(f))) || null;
    let number = byName(chosen && chosen.number_field);
    if (!number) {
        const cands = usable.filter(f => f !== type && f.type !== 'select'
            && (/(numero|nro|no\.?|num)\b.*(documento|identificaci|doc\b)/.test(label(f)) || /^(documento|cedula|identificacion|pasaporte|documento de identidad)$/.test(label(f)) || f.name === 'document_number'));
        number = cands.find(f => Number(f.is_unique)) || cands[0] || null;
    }
    return { type, number };
}
const optionsOf = (f) => String((f && f.options) || '').split(',').map(s => s.trim()).filter(Boolean);

function createSelfPage(base) {
    const { db, T, P, createIndex, createUniqueIndex } = base;
    T.selfSessions = `${P}self_sessions`;
    let D = null;
    let ready = false;

    async function migrate() {
        await db.createTable(T.selfSessions, [
            'id INT_PK',
            'token_hash VARCHAR(64) NOT NULL',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'expires_s INT NOT NULL',
            'last_seen_s INT',
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_self_sessions_token`, T.selfSessions, 'token_hash');
        await createIndex(`${P}idx_self_sessions_ins`, T.selfSessions, 'inscription_id');
        try { await db.run(`DELETE FROM ${T.selfSessions} WHERE expires_s < ?`, [nowS()]); } catch (e) { /* best effort */ }
        ready = true;
    }
    const ensureReady = async () => {
        if (ready) return true;
        try { await migrate(); } catch (e) { console.warn('[conference-manager] self page schema:', e && e.message); }
        return ready;
    };

    // ── throttle (failures only) ──
    const WINDOW_MS = 15 * 60 * 1000, PER_CODE = 5, PER_CLIENT = 30, GLOBAL = 500;
    const byCode = new Map(), byClient = new Map();
    let globalFail = { n: 0, first: 0 };
    const over = (map, key, limit) => { const f = map.get(key); return !!(f && Date.now() - f.first < WINDOW_MS && f.n >= limit); };
    const bump = (map, key) => {
        const now = Date.now();
        const f = map.get(key);
        if (!f || now - f.first >= WINDOW_MS) map.set(key, { n: 1, first: now }); else f.n++;
        if (map.size > 5000) map.clear();
    };
    const throttled = (code, client) => (Date.now() - globalFail.first < WINDOW_MS && globalFail.n >= GLOBAL) || over(byCode, code, PER_CODE) || over(byClient, client, PER_CLIENT);
    const noteFailure = (code, client) => {
        const now = Date.now();
        if (now - globalFail.first >= WINDOW_MS) globalFail = { n: 0, first: now };
        globalFail.n++;
        bump(byCode, code); bump(byClient, client);
    };
    const clientOf = (req) => String((req && (req.clientKey || req.ip)) || 'anon');

    // ── state of one inscription for this page ──
    // { code: null, ins, conf, policy, cfg } | { code: 'disabled' | 'inactive' | 'expired' }.
    async function stateOf(ins) {
        const conf = await db.get(`SELECT id, name, date_start, date_end FROM ${T.conferences} WHERE id = ?`, [ins.conference_id]);
        if (!conf) return { code: 'disabled' };
        const cfg = await D.badges.configOf(ins.conference_id);
        if (!cfg.policy.self_page.enabled) return { code: 'disabled' };
        if (ins.status === 'cancelled') return { code: 'inactive' };
        const exp = D.badges.expiresAtMs(cfg.policy);
        if (exp != null && Date.now() >= exp) return { code: 'expired' };
        return { code: null, ins, conf, cfg };
    }
    async function formOf(cid) {
        return db.all(`SELECT name, label, type, role, options, is_unique FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]);
    }
    async function docOf(cid, cfg) {
        return docFieldsOf(await formOf(cid), cfg.policy.self_page, D.isFieldColumn);
    }

    // ── the view ──
    async function viewOf(st) {
        const { ins, conf, cfg } = st;
        const person = await D.personWithName(ins);
        const loc = ins.location_id != null ? await db.get(`SELECT name FROM ${T.locations} WHERE id = ?`, [ins.location_id]) : null;
        // Their own answers, in form order (every field the form has; empty ones left out).
        const form = await formOf(ins.conference_id);
        const answers = [];
        for (const f of form) {
            if (!D.isFieldColumn(f.name)) continue;
            const v = ins[f.name];
            if (v == null || String(v).trim() === '') continue;
            answers.push({ label: f.label || f.name, value: String(v).trim() });
        }
        // Lodging: only their own hotel and room (never who else sleeps there).
        let lodging = null;
        if (ins.room_id != null) {
            const r = await db.get(`SELECT r.room_number, h.name AS hotel, h.address, h.geo FROM ${T.rooms} r LEFT JOIN ${T.hotels} h ON h.id = r.hotel_id WHERE r.id = ?`, [ins.room_id]);
            if (r) {
                const p = geoPoint(r.geo);
                lodging = { hotel: r.hotel || '', room: r.room_number || '', address: r.address || null, lat: p ? p.lat : null, lng: p ? p.lng : null };
            }
        }
        const meals = await D.mealsOf(ins);
        const badge = await D.badges.selfBadge(ins, conf, cfg);
        // 2.27.0: their buses, each with its boarding state and last notices, and the key to turn notices on.
        const transport = D.transportOf ? await D.transportOf(ins) : [];
        const pushKey = transport.length && D.pushKey ? await D.pushKey() : null;
        return {
            name: person.name || '',
            conference: conf.name,
            location: loc ? loc.name : null,
            code: ins.reg_code || '',
            answers,
            meals,
            lodging,
            badge,
            transport,
            push_key: pushKey,
            expires_on: cfg.policy.expires_on,
        };
    }

    // ── sessions ──
    async function openSession(st) {
        const token = String(await D.randomToken(16));
        const exp = D.badges.expiresAtMs(st.cfg.policy);
        let expires = nowS() + SESSION_DAYS * 86400;
        if (exp != null) expires = Math.min(expires, Math.floor(exp / 1000));
        await db.run(`INSERT INTO ${T.selfSessions} (token_hash, conference_id, inscription_id, expires_s, last_seen_s) VALUES (?, ?, ?, ?, ?)`,
            [sha256(token), st.ins.conference_id, st.ins.id, expires, nowS()]);
        return token;
    }
    async function sessionState(token) {
        if (typeof token !== 'string' || !SESSION_RE.test(token)) return null;
        const s = await db.get(`SELECT id, inscription_id, expires_s FROM ${T.selfSessions} WHERE token_hash = ?`, [sha256(token)]);
        if (!s || Number(s.expires_s) < nowS()) return null;
        const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [s.inscription_id]);
        if (!ins) return null;
        try { await db.run(`UPDATE ${T.selfSessions} SET last_seen_s = ? WHERE id = ?`, [nowS(), s.id]); } catch (e) { /* best effort */ }
        return { session: s, st: await stateOf(ins) };
    }

    // ── routes ──
    function install(deps) {
        D = deps;
        const { http } = deps;
        const send = (res, e) => res.status(e && e.status ? e.status : 500).json({ error: e && e.message ? e.message : String(e) });
        const refuse = (res, code) => res.status(code === 'throttled' ? 429 : code === 'nomatch' || code === 'session' ? 401 : 410).json({ error: MSG[code] || MSG.nomatch, code });
        const gate = async (res) => {
            if (!await ensureReady() || !await D.badges.ensureReady()) { res.status(503).json({ error: MSG.unavailable, code: 'unavailable' }); return false; }
            return true;
        };
        const codeOf = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

        // POST /public/me/start { code } → { conference, doc_types: string[] | null, needs_type }. Answers the same
        // 401 for an unknown code as /verify does for a wrong document — it names the conference only once the
        // code exists, which the badge in hand already says.
        http.route('post', '/public/me/start', async (req, res) => {
            if (!await gate(res)) return;
            try {
                const code = codeOf((req.body || {}).code), client = clientOf(req);
                if (throttled(code, client)) return refuse(res, 'throttled');
                const ins = CODE_RE.test(code) ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE reg_code = ?`, [code]) : null;
                if (!ins) { noteFailure(code, client); return refuse(res, 'nomatch'); }
                const st = await stateOf(ins);
                if (st.code) return refuse(res, st.code);
                const doc = await docOf(ins.conference_id, st.cfg);
                if (!doc.number) return refuse(res, 'disabled');
                res.json({ conference: st.conf.name, doc_types: doc.type ? optionsOf(doc.type) : null, needs_type: !!doc.type, number_label: doc.number.label || 'Número de documento' });
            } catch (e) { send(res, e); }
        });

        // POST /public/me/verify { code, doc_type?, doc_number } → { session, view } | 401 | 429 | 410.
        http.route('post', '/public/me/verify', async (req, res) => {
            if (!await gate(res)) return;
            try {
                const body = req.body || {};
                const code = codeOf(body.code), client = clientOf(req);
                if (throttled(code, client)) return refuse(res, 'throttled');
                const ins = CODE_RE.test(code) ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE reg_code = ?`, [code]) : null;
                if (!ins) { noteFailure(code, client); return refuse(res, 'nomatch'); }
                const st = await stateOf(ins);
                if (st.code) return refuse(res, st.code);
                const doc = await docOf(ins.conference_id, st.cfg);
                if (!doc.number) return refuse(res, 'disabled');
                const stored = normDoc(ins[doc.number.name]);
                if (!stored) return refuse(res, 'nodoc');
                const numberOk = normDoc(body.doc_number) === stored;
                // The type only counts when the person has one recorded (an older registration may not).
                const storedType = doc.type ? normChoice(ins[doc.type.name]) : '';
                const typeOk = !storedType || normChoice(body.doc_type) === storedType;
                if (!numberOk || !typeOk) { noteFailure(code, client); return refuse(res, 'nomatch'); }
                const session = await openSession(st);
                res.json({ session, view: await viewOf(st) });
            } catch (e) { send(res, e); }
        });

        // POST /public/me/view { session } → { view } | 401 (ended) | 410.
        http.route('post', '/public/me/view', async (req, res) => {
            if (!await gate(res)) return;
            try {
                const s = await sessionState((req.body || {}).session);
                if (!s) return refuse(res, 'session');
                if (s.st.code) return refuse(res, s.st.code);
                res.json({ view: await viewOf(s.st) });
            } catch (e) { send(res, e); }
        });

        // POST /public/me/ticket { session } → { d } — the badge PDF through the badges' file route.
        http.route('post', '/public/me/ticket', async (req, res) => {
            if (!await gate(res)) return;
            try {
                const s = await sessionState((req.body || {}).session);
                if (!s) return refuse(res, 'session');
                if (s.st.code) return refuse(res, s.st.code);
                const d = await D.badges.selfTicket(s.st.ins, s.st.cfg);
                if (!d) return res.status(404).json({ error: 'La escarapela no está disponible.' });
                res.json({ d });
            } catch (e) { send(res, e); }
        });

        // POST /public/me/logout { session } → { success } (always: leaving is never refused).
        http.route('post', '/public/me/logout', async (req, res) => {
            try {
                const token = (req.body || {}).session;
                if (typeof token === 'string' && SESSION_RE.test(token) && await ensureReady()) {
                    // 2.27.0: the phone's bus notices end with the session.
                    const row = await db.get(`SELECT id FROM ${T.selfSessions} WHERE token_hash = ?`, [sha256(token)]);
                    if (row && D.onSessionEnd) { try { await D.onSessionEnd(row.id); } catch (e) { /* the session still goes */ } }
                    await db.run(`DELETE FROM ${T.selfSessions} WHERE token_hash = ?`, [sha256(token)]);
                }
            } catch (e) { /* leaving still works on the phone */ }
            res.json({ success: true });
        });
    }

    return { migrate, ensureReady, install, sessionOf: sessionState, docFieldsOf: (fields, chosen) => docFieldsOf(fields, chosen, D ? D.isFieldColumn : () => true), MSG };
}

module.exports = { createSelfPage, docFieldsOf, normDoc, normChoice };
