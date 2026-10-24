/**
 * «Condiciones de salud» (conference-manager 2.32.0): a multiple-choice registration field with «Otros» (free
 * text), «Ninguna» and «Prefiero no responder».
 *
 * SPECIAL-CATEGORY DATA (GDPR art. 9). The answers never live in the inscriptions table: they are kept in their
 * own table (`health_answers`, one row per inscription), so no reader of inscription rows — the roster, the
 * exports, the badges, the meals screens, the coordinators' portal, the participant's own page, the assignment
 * and price rules — can carry them by accident. The field's column name is RESERVED in index.js
 * (RESERVED_INSCRIPTION_COLUMNS), which keeps every generic form-field path away from it; the paths that do
 * show it opt in here, behind the «Datos de salud» staff section:
 *   - health:view   reads the answers (roster column, Excel, the person's sheet, the edit form);
 *   - health:manage writes them from the admin; a coordinator registering someone in the portal may answer
 *     the field (write-only: the portal never reads an answer back).
 * Nothing here logs a value; audit lines name the field, never an answer.
 *
 * Value on the wire: { conditions: string[], other: string, answer: 'list' | 'none' | 'declined' }, or null to
 * clear. `conditions` must be options of the field (in the field's order); «Otros» is the option OTHER and needs
 * `other` text. 'none' («Ninguna») and 'declined' («Prefiero no responder») carry no condition.
 *
 * 2.36.9: «Tipo de sangre» (`blood_type`, one of BLOOD_TYPES) and «EPS» (`eps`, the health insurer, plain text)
 * are two more parts of the same answer, stored in the same row (columns blood_type / eps). Being part of the
 * health answer, they inherit every rule above with no path of their own: written only with the health consent
 * (or the coordinator's verbal one), deleted with it (revoke, a signature without health, the purge, the field's
 * deletion), read only with health:view. Both optional and independent of the conditions; on the wire they are
 * present only when given. A row may carry only them (answer 'list', no condition): that is not a conditions
 * answer, so a REQUIRED field still asks for the conditions (`conditionsAnswered`).
 *
 * SQL: own prefixed tables, portable (SQLite / PostgreSQL / MySQL): VARCHAR for indexed text, no upsert syntax.
 */
'use strict';

const FIELD = 'health_conditions';
const TYPE = 'health';
const OTHER = 'Otros';
const ANSWERS = ['list', 'none', 'declined'];
const MAX_OTHER = 200;
const MAX_CONDITIONS = 40;
/** «Tipo de sangre»: the eight groups and «No sabe» (the same list and order as client/lib/health.ts). */
const BLOOD_TYPES = ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−', 'No sabe'];
const MAX_EPS = 120;
/** A sent «A-» is the list's «A−» (the minus sign); '' when not one of the list. */
function bloodTypeOf(v) {
    const raw = String(v == null ? '' : v).trim();
    if (raw.toLowerCase() === 'no sabe') return 'No sabe';
    const s = raw.replace(/-/g, '−').toUpperCase();
    return BLOOD_TYPES.includes(s) ? s : '';
}
/** The extras of an answer object, only those given. */
function extrasOf(a) {
    const out = {};
    if (a && a.blood_type) out.blood_type = a.blood_type;
    if (a && a.eps) out.eps = a.eps;
    return out;
}
/** Did the person answer the conditions part (a condition, «Ninguna» or «Prefiero no responder»)? */
const conditionsAnswered = (a) => !!a && (a.answer !== 'list' || (a.conditions || []).length > 0);
/** The options a new field starts with, in this order (the admin edits them like a select's). */
const DEFAULT_OPTIONS = [
    'Diabetes', 'Movilidad reducida', 'Embarazo', 'Cáncer u otro tratamiento que debilita', 'Enfermedad del corazón',
    'Lactancia', 'Enfermedad renal', 'Autismo o ansiedad en multitudes', 'Epilepsia',
    'Discapacidad visual o auditiva', 'Hipertensión', 'Asma o EPOC', 'Alergia alimentaria grave o celiaquía',
];
// Options are stored comma-separated, like a select's (so a condition name holds no comma).
const OPTION_SEP = ',';

/** The field's options, without «Otros» (always offered). */
const optionsOf = (field) => String((field && field.options) || '').split(OPTION_SEP).map(s => s.trim()).filter(s => s && s !== OTHER);

/** The stored options string for a list of names (deduplicated, «Otros» dropped — it is always there). */
function optionsText(list) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : String(list || '').split(OPTION_SEP)) {
        const s = String(raw == null ? '' : raw).replace(/,/g, ' ').trim().slice(0, 120);
        if (!s || s === OTHER || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
    }
    return out.join(`${OPTION_SEP} `);
}

/**
 * Body value → canonical answer, null (clear), or undefined (absent). Throws `httpError(400)` on anything else.
 * The messages name the field by its label, never the value.
 */
function parseAnswer(field, raw, httpError) {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    const label = (field && field.label) || 'Condiciones de salud';
    const bad = () => httpError(400, `El campo «${label}» tiene un formato inválido.`);
    if (typeof raw !== 'object' || Array.isArray(raw)) throw bad();
    const answer = raw.answer === undefined ? 'list' : raw.answer;
    if (!ANSWERS.includes(answer)) throw bad();
    // 2.36.9: the blood type (one of the list, or nothing) and the EPS (plain text).
    const extras = {};
    if (raw.blood_type != null && raw.blood_type !== '') {
        if (typeof raw.blood_type !== 'string') throw bad();
        const b = bloodTypeOf(raw.blood_type);
        if (!b) throw httpError(400, `El tipo de sangre no es una de las opciones (${BLOOD_TYPES.join(', ')}).`);
        extras.blood_type = b;
    }
    if (raw.eps != null && raw.eps !== '') {
        if (typeof raw.eps !== 'string') throw bad();
        const e = raw.eps.replace(/\s+/g, ' ').trim();
        if (e.length > MAX_EPS) throw httpError(400, `El nombre de la EPS es demasiado largo (máximo ${MAX_EPS} caracteres).`);
        if (e) extras.eps = e;
    }
    if (answer !== 'list') return { conditions: [], other: '', answer, ...extras };
    if (raw.conditions !== undefined && !Array.isArray(raw.conditions)) throw bad();
    const picked = new Set();
    for (const c of raw.conditions || []) {
        if (typeof c !== 'string') throw bad();
        picked.add(c.trim());
    }
    if (picked.size > MAX_CONDITIONS) throw bad();
    const opts = optionsOf(field);
    for (const c of picked) if (c !== OTHER && !opts.includes(c)) throw httpError(400, `Una de las condiciones marcadas en «${label}» no es una opción del formulario.`);
    const other = typeof raw.other === 'string' ? raw.other.trim() : '';
    if (raw.other != null && typeof raw.other !== 'string') throw bad();
    if (other.length > MAX_OTHER) throw httpError(400, `El texto de «${OTHER}» es demasiado largo (máximo ${MAX_OTHER} caracteres).`);
    if (picked.has(OTHER) && !other) throw httpError(400, `Escribe cuál es la otra condición en «${label}».`);
    const conditions = opts.filter(o => picked.has(o));
    if (picked.has(OTHER)) conditions.push(OTHER);
    // Nothing marked and nothing else = not answered; only a blood type / EPS = an answer without conditions.
    if (!conditions.length) return Object.keys(extras).length ? { conditions: [], other: '', answer: 'list', ...extras } : null;
    return { conditions, other: picked.has(OTHER) ? other : '', answer: 'list', ...extras };
}

/** The answer as one line of text (roster column, Excel, the person's sheet). */
function answerText(a) {
    if (!a) return '';
    const parts = [];
    if (a.answer === 'none') parts.push('Ninguna');
    else if (a.answer === 'declined') parts.push('Prefiere no responder');
    else { const c = (a.conditions || []).map(c => (c === OTHER && a.other ? `${OTHER}: ${a.other}` : c)).join(', '); if (c) parts.push(c); }
    if (a.blood_type) parts.push(`Tipo de sangre: ${a.blood_type}`);
    if (a.eps) parts.push(`EPS: ${a.eps}`);
    return parts.join(' · ');
}

function rowToAnswer(row) {
    if (!row) return null;
    let conditions = [];
    try { const v = JSON.parse(row.conditions || '[]'); if (Array.isArray(v)) conditions = v.filter(x => typeof x === 'string'); } catch { /* stays [] */ }
    const answer = ANSWERS.includes(row.answer) ? row.answer : 'list';
    // A row from before 2.36.9 has no blood_type / eps (undefined or NULL): the answer simply carries none.
    const blood = bloodTypeOf(row.blood_type);
    const eps = String(row.eps == null ? '' : row.eps).trim();
    return {
        conditions: answer === 'list' ? conditions : [], other: answer === 'list' ? String(row.other_text || '') : '', answer,
        ...(blood ? { blood_type: blood } : {}), ...(eps ? { eps } : {}),
    };
}

function createHealth(base) {
    const { db, T, P, createIndex, createUniqueIndex, addColumnIfMissing } = base;
    T.healthAnswers = `${P}health_answers`;

    async function migrate() {
        await db.createTable(T.healthAnswers, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'answer VARCHAR(12) NOT NULL',          // list | none | declined
            'conditions TEXT',                      // JSON array of option names (list only)
            'other_text TEXT',                      // «Otros» (list only)
            'blood_type VARCHAR(8)',                // 2.36.9: «Tipo de sangre» (BLOOD_TYPES), NULL = not given
            'eps TEXT',                             // 2.36.9: «EPS», NULL = not given
            'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_health_answers_ins`, T.healthAnswers, 'inscription_id');
        await createIndex(`${P}idx_health_answers_conf`, T.healthAnswers, 'conference_id');
        // 2.36.9: tables created before get the two columns here (SQLite / PostgreSQL / MySQL ALTER TABLE ADD COLUMN).
        if (addColumnIfMissing) {
            await addColumnIfMissing(T.healthAnswers, 'blood_type', 'VARCHAR(8)');
            await addColumnIfMissing(T.healthAnswers, 'eps', 'TEXT');
        }
    }

    /** The conference's health field (definition only), or null. */
    const fieldOf = (conferenceId) => db.get(`SELECT id, name, label, type, options, is_required FROM ${T.fields} WHERE conference_id = ? AND name = ?`, [conferenceId, FIELD]);

    /** Map inscription id → answer, for these ids (chunked: an IN list stays small). */
    async function answersOf(ids) {
        const out = new Map();
        const list = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
        for (let i = 0; i < list.length; i += 500) {
            const chunk = list.slice(i, i + 500);
            const rows = await db.all(`SELECT inscription_id, answer, conditions, other_text, blood_type, eps FROM ${T.healthAnswers} WHERE inscription_id IN (${chunk.map(() => '?').join(', ')})`, chunk);
            for (const r of rows) out.set(Number(r.inscription_id), rowToAnswer(r));
        }
        return out;
    }
    /** Every answer of a conference (the meal priority model). */
    async function answersOfConference(conferenceId) {
        const rows = await db.all(`SELECT inscription_id, answer, conditions, other_text, blood_type, eps FROM ${T.healthAnswers} WHERE conference_id = ?`, [conferenceId]);
        return new Map(rows.map(r => [Number(r.inscription_id), rowToAnswer(r)]));
    }

    /** Store (or clear, with null) one person's answer. UPDATE first, INSERT when there was no row. */
    async function save(conferenceId, inscriptionId, answer) {
        if (answer === undefined) return;
        if (answer === null) { await db.run(`DELETE FROM ${T.healthAnswers} WHERE inscription_id = ?`, [inscriptionId]); return; }
        const vals = [answer.answer, JSON.stringify(answer.conditions || []), answer.other || '', answer.blood_type || null, answer.eps || null];
        const SET = 'answer = ?, conditions = ?, other_text = ?, blood_type = ?, eps = ?, updated_at = CURRENT_TIMESTAMP';
        const r = await db.run(`UPDATE ${T.healthAnswers} SET ${SET} WHERE inscription_id = ?`, [...vals, inscriptionId]);
        if (r && r.changes) return;
        try {
            await db.run(`INSERT INTO ${T.healthAnswers} (conference_id, inscription_id, answer, conditions, other_text, blood_type, eps) VALUES (?, ?, ?, ?, ?, ?, ?)`, [conferenceId, inscriptionId, ...vals]);
        } catch (e) {
            // A concurrent first write won the UNIQUE index: this one becomes the update it is.
            await db.run(`UPDATE ${T.healthAnswers} SET ${SET} WHERE inscription_id = ?`, [...vals, inscriptionId]);
        }
    }
    /** Deleting the field clears every answer of the conference. */
    const clearConference = (conferenceId) => db.run(`DELETE FROM ${T.healthAnswers} WHERE conference_id = ?`, [conferenceId]);
    /** Deleting a person (the FK cascades where the engine enforces it; this makes it explicit everywhere). */
    const clearInscription = (inscriptionId) => db.run(`DELETE FROM ${T.healthAnswers} WHERE inscription_id = ?`, [inscriptionId]);

    return { migrate, fieldOf, answersOf, answersOfConference, save, clearConference, clearInscription };
}

module.exports = { createHealth, parseAnswer, answerText, optionsOf, optionsText, conditionsAnswered, extrasOf, bloodTypeOf, FIELD, TYPE, OTHER, DEFAULT_OPTIONS, OPTION_SEP, MAX_OTHER, BLOOD_TYPES, MAX_EPS };
