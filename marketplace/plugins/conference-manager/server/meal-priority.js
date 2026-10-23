/**
 * Turnos de comida (conference-manager 2.32.0): every participant of a conference gets a meal group A–F, and
 * every meal service a call time per group, so the people who most need it are served first and nobody stands
 * in line longer than needed. The model the owner approved (2026-10-22):
 *
 *   SCORE   S = min(100, E(age) + H),   H = min(60, w1 + w2/2 + w3/4 + …)   (w1 ≥ w2 ≥ … the weights of the
 *           person's conditions in «Condiciones de salud»; E from the age bands below). Sex never counts on its
 *           own: «Embarazo» / «Lactancia» are conditions the person marks. «Prefiero no responder» = H 0.
 *   GROUPS  six groups of (nearly) EQUAL size: units — a family travels together, with at most
 *           `companions_max` companions per priority member; everyone else alone — sorted by score (desc), ties
 *           by a stable hash; a unit starting at position s with z people out of N goes to group
 *           ⌊6 (s + z/2) / N⌋. Monotone (more points never means a later group) and balanced (± one family).
 *           A coordinator's manual group is kept as is; the rest are cut around it.
 *   ORDER   by letter; the trailing groups made only of people with 0 points alternate their order day by day.
 *   TIMES   per service: K = occupancy · lines · plates per minute per line; group g lasts n_g / K minutes (n_g =
 *           the people of g entitled to that service), starting where the previous group ended.
 *
 * FREEZING. The cuts move with every registration, so «Fijar grupos» stores everyone's letter (meal_groups);
 * from then on the stored letters are used (badges stay right) and a later registrant joins the smallest
 * group whose stored scores span theirs. «Recalcular» stores the cuts again; manual groups survive both.
 *
 * PRIVACY. The score is built from health answers (server/health.js), so only health:view sees a score or its
 * reason; meals:view sees letters, counts and times. Nothing here logs a person's data.
 *
 * SQL: own prefixed tables, portable (SQLite / PostgreSQL / MySQL), no upsert syntax.
 */
'use strict';

const crypto = require('crypto');
const { OTHER, FIELD: HEALTH_FIELD, optionsOf: healthOptionsOf } = require('./health');

const GROUPS = ['A', 'B', 'C', 'D', 'E', 'F'];
/** [from, to, points] — inclusive ages. */
const AGE_BANDS = Object.freeze([[0, 2, 40], [3, 5, 30], [6, 11, 15], [12, 59, 0], [60, 69, 20], [70, 79, 35], [80, 130, 50]]);
const HEALTH_CAP = 60;
const SCORE_CAP = 100;
const MAX_WEIGHT = 60;
/** Default weight of each default condition (server/health.js DEFAULT_OPTIONS) and of «Otros». */
const DEFAULT_WEIGHTS = Object.freeze({
    'Diabetes': 40, 'Movilidad reducida': 35, 'Embarazo': 30, 'Cáncer u otro tratamiento que debilita': 30,
    'Enfermedad del corazón': 25, 'Lactancia': 20, 'Enfermedad renal': 20, 'Autismo o ansiedad en multitudes': 20,
    'Epilepsia': 15, 'Discapacidad visual o auditiva': 15, 'Hipertensión': 10, 'Asma o EPOC': 10,
    'Alergia alimentaria grave o celiaquía': 5, [OTHER]: 10,
});
/** A condition the admin added without giving it a weight. */
const UNKNOWN_WEIGHT = 10;
// `enabled`: off until the admin turns «Turnos de comida» on — until then no letter reaches a badge, the scanner or
// «Mi inscripción» (the meals page still previews the groups).
const DEFAULT_CONFIG = Object.freeze({ enabled: false, weights: {}, companions_max: 4, lines: 1, per_min: 4, occupancy: 0.85, services: {} });
const DEFAULT_WINDOWS = Object.freeze({ desayuno: ['06:00', '10:00'], almuerzo: ['11:30', '15:00'], cena: ['18:00', '21:30'] });

// ── the pure model (unit-tested on its own) ─────────────────────────────────────────────────────────────────

/** Age as an integer 0–130, or null (blank, not a number). */
function parseAge(v) {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 130) return null;
    return Math.floor(n);
}
/** E(age): the points of the age band (0 when the age is unknown). */
function agePoints(age) {
    const a = parseAge(age);
    if (a == null) return 0;
    const band = AGE_BANDS.find(([lo, hi]) => a >= lo && a <= hi);
    return band ? band[2] : 0;
}
/** The weight of one condition: the conference's own, else the default, else UNKNOWN_WEIGHT. */
function weightOf(condition, weights) {
    const own = weights && Object.prototype.hasOwnProperty.call(weights, condition) ? Number(weights[condition]) : NaN;
    if (Number.isFinite(own)) return Math.max(0, Math.min(MAX_WEIGHT, own));
    return Object.prototype.hasOwnProperty.call(DEFAULT_WEIGHTS, condition) ? DEFAULT_WEIGHTS[condition] : UNKNOWN_WEIGHT;
}
/** H: the strongest condition in full, the second half, the third a quarter…, capped at 60. */
function healthPoints(answer, weights) {
    if (!answer || answer.answer !== 'list') return 0;
    const ws = (answer.conditions || []).map(c => weightOf(c, weights)).sort((a, b) => b - a);
    let h = 0;
    ws.forEach((w, i) => { h += w / 2 ** i; });
    return Math.min(HEALTH_CAP, h);
}
/** S, rounded to one decimal. */
function priorityScore(age, answer, weights) {
    return Math.round(Math.min(SCORE_CAP, agePoints(age) + healthPoints(answer, weights)) * 10) / 10;
}
/** Stable tie-break: a number from the conference and the person (their code, else their id). */
function tieKey(conferenceId, person) {
    const h = crypto.createHash('sha256').update(`${conferenceId}:${person.reg_code || person.id}`).digest();
    return h.readUInt32BE(0);
}

/**
 * The cut. `people`: [{ id, score, family (key or ''), tie }]. `manual`: Map id → letter (kept as is, outside the
 * cut). Returns Map id → letter. Pure.
 */
function assignGroups(people, { manual = new Map(), companionsMax = 4 } = {}) {
    const out = new Map();
    const free = [];
    for (const p of people) {
        if (manual.has(p.id)) out.set(p.id, manual.get(p.id));
        else free.push(p);
    }
    const byTie = (a, b) => a.tie - b.tie || a.id - b.id;
    // Units: a family, capped at companionsMax companions per priority member; everyone else alone.
    const families = new Map();
    const units = [];
    for (const p of free) {
        if (p.family) {
            if (!families.has(p.family)) families.set(p.family, []);
            families.get(p.family).push(p);
        } else units.push([p]);
    }
    for (const members of families.values()) {
        const priority = members.filter(m => m.score > 0);
        const companions = members.filter(m => !(m.score > 0)).sort(byTie);
        if (!priority.length) { units.push(members); continue; }
        const lifted = companions.slice(0, priority.length * Math.max(0, companionsMax));
        units.push([...priority, ...lifted]);
        const rest = companions.slice(lifted.length);
        if (rest.length) units.push(rest);
    }
    const unitScore = (u) => Math.max(...u.map(m => m.score));
    const unitTie = (u) => Math.min(...u.map(m => m.tie));
    units.sort((a, b) => unitScore(b) - unitScore(a) || unitTie(a) - unitTie(b) || Math.min(...a.map(m => m.id)) - Math.min(...b.map(m => m.id)));
    const n = free.length;
    let s = 0;
    for (const u of units) {
        const g = Math.min(GROUPS.length - 1, Math.floor((GROUPS.length * (s + u.length / 2)) / n));
        for (const m of u) out.set(m.id, GROUPS[g]);
        s += u.length;
    }
    return out;
}

/**
 * Call order of the groups on a given day (dayIndex 0, 1, …): by letter, except that the trailing run of groups
 * made only of people with 0 points rotates by one each day. `zeroOnly`: Set of those letters. Empty groups
 * keep their place (they take no time).
 */
function callOrder(zeroOnly, dayIndex) {
    let k = GROUPS.length;
    while (k > 0 && zeroOnly.has(GROUPS[k - 1])) k--;
    const head = GROUPS.slice(0, k);
    const tail = GROUPS.slice(k);
    if (tail.length < 2) return GROUPS.slice();
    const r = ((dayIndex % tail.length) + tail.length) % tail.length;
    return [...head, ...tail.slice(r), ...tail.slice(0, r)];
}

const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmtMin = (min) => { const t = Math.max(0, Math.floor(min)); return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

/**
 * One service's slots. `counts`: { A: n, … } of entitled people; `order` from callOrder; rate { lines, per_min,
 * occupancy }. Returns { slots: [{ group, count, start, end, minutes }], start, end, overflow } — `overflow` when
 * the last group ends after the service's own end time.
 */
function serviceSlots(service, counts, order, rate) {
    const def = DEFAULT_WINDOWS[service.meal] || ['12:00', '14:00'];
    const start = toMin(service.start_time) ?? toMin(def[0]);
    const end = toMin(service.end_time) ?? toMin(def[1]);
    const k = Math.max(0.01, Number(rate.occupancy) * Number(rate.lines) * Number(rate.per_min));
    let t = start;
    const slots = [];
    for (const g of order) {
        const n = Number(counts[g]) || 0;
        const minutes = n / k;
        slots.push({ group: g, count: n, start: fmtMin(t), end: fmtMin(t + minutes), minutes: Math.round(minutes * 10) / 10 });
        t += minutes;
    }
    return { slots, start: fmtMin(start), end: fmtMin(t), overflow: end != null && t > end + 0.001, per_minute: Math.round(k * 10) / 10 };
}

/** Body → stored config: only known keys, every number clamped. Throws httpError(400) on a bad value. */
function cleanConfig(prev, body, httpError) {
    const cfg = { ...DEFAULT_CONFIG, ...(prev || {}) };
    const num = (v, lo, hi, what) => {
        const n = Number(v);
        if (v === '' || v == null || !Number.isFinite(n) || n < lo || n > hi) throw httpError(400, `${what} debe ser un número entre ${lo} y ${hi}.`);
        return n;
    };
    if (body.weights !== undefined) {
        if (!body.weights || typeof body.weights !== 'object' || Array.isArray(body.weights)) throw httpError(400, 'Los pesos deben ser una lista de condición → puntos.');
        const w = {};
        for (const [k, v] of Object.entries(body.weights).slice(0, 80)) w[String(k).slice(0, 120)] = Math.round(num(v, 0, MAX_WEIGHT, `El peso de «${String(k).slice(0, 60)}»`));
        cfg.weights = w;
    }
    if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw httpError(400, 'enabled debe ser verdadero o falso.');
        cfg.enabled = body.enabled;
    }
    if (body.companions_max !== undefined) cfg.companions_max = Math.round(num(body.companions_max, 0, 20, 'El máximo de acompañantes'));
    if (body.lines !== undefined) cfg.lines = Math.round(num(body.lines, 1, 50, 'El número de filas de entrega'));
    if (body.per_min !== undefined) cfg.per_min = Math.round(num(body.per_min, 0.1, 60, 'Los platos por minuto') * 10) / 10;
    if (body.occupancy !== undefined) cfg.occupancy = Math.round(num(body.occupancy, 0.5, 1, 'La ocupación') * 100) / 100;
    if (body.services !== undefined) {
        if (!body.services || typeof body.services !== 'object' || Array.isArray(body.services)) throw httpError(400, 'Formato de servicios inválido.');
        const out = {};
        for (const [id, v] of Object.entries(body.services).slice(0, 500)) {
            if (!/^\d+$/.test(id) || !v || typeof v !== 'object') continue;
            const one = {};
            if (v.lines != null && v.lines !== '') one.lines = Math.round(num(v.lines, 1, 50, 'El número de filas de entrega'));
            if (v.per_min != null && v.per_min !== '') one.per_min = Math.round(num(v.per_min, 0.1, 60, 'Los platos por minuto') * 10) / 10;
            if (Object.keys(one).length) out[id] = one;
        }
        cfg.services = out;
    }
    return cfg;
}

// ── the module ──────────────────────────────────────────────────────────────────────────────────────────────

function createMealPriority(base) {
    const { db, T, P, createUniqueIndex, createIndex } = base;
    T.mealPriority = `${P}meal_priority`;
    T.mealGroups = `${P}meal_groups`;
    let D = null;

    async function migrate() {
        await db.createTable(T.mealPriority, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'config TEXT',
            'frozen_at VARCHAR(19)',               // UTC 'YYYY-MM-DD HH:MM:SS' of «Fijar grupos», NULL = live
            'frozen_by TEXT',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_meal_priority_conf`, T.mealPriority, 'conference_id');
        // One row per person: a manual group (manual = 1, kept by every recalculation) or a frozen one.
        await db.createTable(T.mealGroups, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'grp VARCHAR(1) NOT NULL',
            'score REAL',
            'manual INT DEFAULT 0',
            'set_by TEXT',
            'set_at VARCHAR(19)',
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_meal_groups_ins`, T.mealGroups, 'inscription_id');
        await createIndex(`${P}idx_meal_groups_conf`, T.mealGroups, 'conference_id');
    }

    const utcStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
    async function settingsOf(cid) {
        const row = await db.get(`SELECT config, frozen_at, frozen_by FROM ${T.mealPriority} WHERE conference_id = ?`, [cid]);
        let cfg = {};
        try { cfg = row && row.config ? JSON.parse(row.config) : {}; } catch { cfg = {}; }
        return { config: { ...DEFAULT_CONFIG, ...(cfg && typeof cfg === 'object' ? cfg : {}) }, frozen_at: (row && row.frozen_at) || null, frozen_by: (row && row.frozen_by) || null };
    }
    async function writeSettings(cid, patch) {
        const r = await db.get(`SELECT id FROM ${T.mealPriority} WHERE conference_id = ?`, [cid]);
        const keys = Object.keys(patch);
        if (r) await db.run(`UPDATE ${T.mealPriority} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE conference_id = ?`, [...keys.map(k => patch[k]), cid]);
        else {
            try { await db.run(`INSERT INTO ${T.mealPriority} (conference_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [cid, ...keys.map(k => patch[k])]); }
            catch (e) { await db.run(`UPDATE ${T.mealPriority} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE conference_id = ?`, [...keys.map(k => patch[k]), cid]); }
        }
        cache.delete(Number(cid));
    }

    // ── the whole conference's model (cached a few seconds: badges and pages ask per person) ──
    const cache = new Map();
    const CACHE_MS = 5000;
    const invalidate = (cid) => { if (cid == null) cache.clear(); else cache.delete(Number(cid)); };

    async function modelOf(cid) {
        cid = Number(cid);
        const hit = cache.get(cid);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.model;
        const model = await buildModel(cid);
        if (cache.size > 50) cache.clear();
        cache.set(cid, { at: Date.now(), model });
        return model;
    }

    async function buildModel(cid) {
        const { config, frozen_at, frozen_by } = await settingsOf(cid);
        const fields = await db.all(`SELECT name, type, role, is_group, options FROM ${T.fields} WHERE conference_id = ?`, [cid]);
        const ageField = fields.find(f => f.role === 'age' && D.isFieldColumn(f.name));
        const familyField = fields.find(f => Number(f.is_group) && D.isFieldColumn(f.name));
        const healthField = fields.find(f => f.name === HEALTH_FIELD);
        const cols = ['i.id', 'i.reg_code', 'i.status', 'i.location_id'];
        if (ageField) cols.push(`i.${ageField.name} AS age_value`);
        if (familyField) cols.push(`i.${familyField.name} AS family_value`);
        const rows = await db.all(`SELECT ${cols.join(', ')} FROM ${T.inscriptions} i WHERE i.conference_id = ? AND (i.status IS NULL OR i.status != 'cancelled') ORDER BY i.id`, [cid]);
        const answers = healthField ? await D.health.answersOfConference(cid) : new Map();
        const stored = new Map((await db.all(`SELECT inscription_id, grp, score, manual FROM ${T.mealGroups} WHERE conference_id = ?`, [cid]))
            .map(r => [Number(r.inscription_id), { grp: r.grp, score: r.score == null ? null : Number(r.score), manual: !!Number(r.manual) }]));

        const people = rows.map(r => {
            const answer = answers.get(Number(r.id)) || null;
            const age = ageField ? parseAge(r.age_value) : null;
            const e = agePoints(age), h = healthPoints(answer, config.weights);
            return {
                id: Number(r.id), reg_code: r.reg_code, location_id: r.location_id == null ? null : Number(r.location_id),
                age, age_points: e, health_points: Math.round(h * 10) / 10, score: priorityScore(age, answer, config.weights),
                family: familyField && r.family_value != null && String(r.family_value).trim() ? `${r.location_id ?? ''}|${String(r.family_value).trim().toLowerCase()}` : '',
                health_answer: answer ? answer.answer : null,
            };
        });
        for (const p of people) p.tie = tieKey(cid, p);
        const manual = new Map([...stored].filter(([id, s]) => s.manual && GROUPS.includes(s.grp)).map(([id, s]) => [id, s.grp]));

        let groups;
        if (!frozen_at) groups = assignGroups(people, { manual, companionsMax: config.companions_max });
        else {
            // Frozen: stored letters; a later registrant joins the smallest group whose stored scores span theirs.
            groups = new Map();
            const span = new Map(GROUPS.map(g => [g, { lo: Infinity, hi: -Infinity, n: 0 }]));
            const late = [];
            for (const p of people) {
                const s = stored.get(p.id);
                if (s && GROUPS.includes(s.grp)) {
                    groups.set(p.id, s.grp);
                    const sp = span.get(s.grp);
                    sp.n++;
                    if (!s.manual) { const v = s.score == null ? p.score : s.score; sp.lo = Math.min(sp.lo, v); sp.hi = Math.max(sp.hi, v); }
                } else late.push(p);
            }
            // The smallest of the groups whose stored scores span theirs; in a gap between two groups, the earlier
            // one (more points never means a later group); below every group, the last group that has scores.
            for (const p of late) {
                const spanning = GROUPS.filter(g => span.get(g).lo <= p.score && p.score <= span.get(g).hi);
                let g;
                if (spanning.length) g = spanning.reduce((a, b) => (span.get(b).n < span.get(a).n ? b : a));
                else g = GROUPS.find(x => span.get(x).lo <= p.score) || [...GROUPS].reverse().find(x => Number.isFinite(span.get(x).lo)) || GROUPS[GROUPS.length - 1];
                groups.set(p.id, g);
                span.get(g).n++;
            }
        }
        const byId = new Map(people.map(p => [p.id, { ...p, group: groups.get(p.id), manual: manual.has(p.id) }]));
        const zeroOnly = new Set(GROUPS.filter(g => {
            const members = people.filter(p => groups.get(p.id) === g);
            return members.length > 0 && members.every(p => !(p.score > 0));
        }));
        const counts = Object.fromEntries(GROUPS.map(g => [g, people.filter(p => groups.get(p.id) === g).length]));

        // Services and who is entitled to each (the meals section's own rule: entitlementFrom).
        const services = await db.all(`SELECT id, service_date, meal, label, start_time, end_time FROM ${T.mealServices} WHERE conference_id = ? ORDER BY service_date, id`, [cid]);
        const plan = await db.all(`SELECT p.location_id, p.service_id FROM ${T.mealPlan} p JOIN ${T.mealServices} s ON s.id = p.service_id WHERE s.conference_id = ?`, [cid]);
        const overrides = await db.all(`SELECT o.inscription_id, o.service_id, o.mode FROM ${T.mealOverrides} o JOIN ${T.mealServices} s ON s.id = o.service_id WHERE s.conference_id = ?`, [cid]);
        const planned = new Set(plan.map(r => `${r.location_id}:${r.service_id}`));
        const modeOf = new Map(overrides.map(o => [`${o.inscription_id}:${o.service_id}`, o.mode]));
        const days = [...new Set(services.map(s => s.service_date))].sort();
        const mealRank = { desayuno: 0, almuerzo: 1, cena: 2 };
        services.sort((a, b) => (a.service_date < b.service_date ? -1 : a.service_date > b.service_date ? 1 : (mealRank[a.meal] ?? 9) - (mealRank[b.meal] ?? 9)));
        const svcOut = [];
        const entitledBy = new Map(); // service id → Set of person ids
        for (const s of services) {
            const set = new Set();
            const c = Object.fromEntries(GROUPS.map(g => [g, 0]));
            for (const p of people) {
                const ent = D.entitlementFrom(null, modeOf.get(`${p.id}:${s.id}`) || null, p.location_id != null && planned.has(`${p.location_id}:${s.id}`));
                if (!ent.entitled) continue;
                set.add(p.id);
                c[groups.get(p.id)]++;
            }
            entitledBy.set(Number(s.id), set);
            const own = (config.services && config.services[String(s.id)]) || {};
            const rate = { lines: own.lines || config.lines, per_min: own.per_min || config.per_min, occupancy: config.occupancy };
            const order = callOrder(zeroOnly, days.indexOf(s.service_date));
            svcOut.push({ id: Number(s.id), date: s.service_date, meal: s.meal, label: s.label || null, lines: rate.lines, per_min: rate.per_min, entitled: set.size, ...serviceSlots(s, c, order, rate), order });
        }
        const missingAge = ageField ? people.filter(p => p.age == null).length : people.length;
        const withHealth = people.filter(p => p.health_answer).length;
        return {
            conference_id: cid, config, frozen_at, frozen_by, has_age_field: !!ageField, has_health_field: !!healthField,
            has_family_field: !!familyField, health_options: healthField ? [...healthOptionsOf(healthField), OTHER] : [], total: people.length, counts, zero_only: [...zeroOnly], services: svcOut,
            missing_age: missingAge, health_answered: withHealth, byId, entitledBy,
        };
    }

    /** A person's letter and, for each service they are entitled to, their group's slot. null when cancelled/unknown. */
    async function personGroup(cid, inscriptionId) {
        const m = await modelOf(cid);
        if (!m.config.enabled) return null;
        const p = m.byId.get(Number(inscriptionId));
        if (!p || !p.group) return null;
        const services = m.services.filter(s => (m.entitledBy.get(s.id) || new Set()).has(p.id)).map(s => {
            const slot = s.slots.find(x => x.group === p.group);
            return { service_id: s.id, date: s.date, meal: s.meal, label: s.label, start: slot ? slot.start : null, end: slot ? slot.end : null };
        });
        return { group: p.group, services };
    }
    /** Letter of a person, or null (badges). */
    async function letterOf(cid, inscriptionId) {
        const m = await modelOf(cid);
        if (!m.config.enabled) return null;
        const p = m.byId.get(Number(inscriptionId));
        return p ? p.group || null : null;
    }

    function install(deps) {
        D = deps;
        const { http, allow, allowAny, hasLevel, positiveInt, sendError, httpError, actorOf } = D;

        // GET /meals/priority?conference_id → the model: settings, counts per group, every service's slots, and
        // the people (name, location, letter, manual). Scores and their reasons only for health:view.
        http.route('get', '/meals/priority', { auth: true }, async (req, res) => {
            const perms = await allowAny(req, res, [['meals', 'view'], ['meals_delivery', 'manage']]);
            if (!perms) return;
            const cid = positiveInt(req.query.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            try {
                const m = await buildModel(cid); // always fresh here; the cache serves badges and pages
                const seesHealth = hasLevel(perms, 'health', 'view');
                const seesPeople = hasLevel(perms, 'meals', 'view');
                let people = [];
                if (seesPeople && m.byId.size) {
                    const ids = [...m.byId.keys()];
                    const names = new Map();
                    for (let i = 0; i < ids.length; i += 500) {
                        const chunk = ids.slice(i, i + 500);
                        for (const r of await D.peopleByIds(cid, chunk)) names.set(Number(r.id), r);
                    }
                    people = [...m.byId.values()].map(p => {
                        const n = names.get(p.id) || {};
                        const row = { id: p.id, name: n.name || `#${p.id}`, location: n.location || null, family_group: n.family_group || null, group: p.group, manual: p.manual };
                        if (seesHealth) Object.assign(row, { score: p.score, age: p.age, age_points: p.age_points, health_points: p.health_points, health_answer: p.health_answer });
                        return row;
                    }).sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || String(a.name).localeCompare(String(b.name), 'es'));
                }
                const { byId, entitledBy, ...summary } = m;
                res.json({
                    ...summary,
                    config: seesHealth || hasLevel(perms, 'meals', 'manage') ? m.config : { ...m.config, weights: {} },
                    default_weights: DEFAULT_WEIGHTS, unknown_weight: UNKNOWN_WEIGHT, age_bands: AGE_BANDS,
                    health_answered: seesHealth ? m.health_answered : null,
                    sees_health: seesHealth, people,
                });
            } catch (e) { sendError(res, e); }
        });

        // PUT /meals/priority/config { conference_id, weights?, companions_max?, lines?, per_min?, occupancy?, services? }
        http.route('put', '/meals/priority/config', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'meals', 'manage')) return;
            const body = req.body || {};
            const cid = positiveInt(body.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            try {
                if (!await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid])) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const { config } = await settingsOf(cid);
                const next = cleanConfig(config, body, httpError);
                await writeSettings(cid, { config: JSON.stringify(next) });
                res.json({ success: true, config: next });
            } catch (e) { sendError(res, e); }
        });

        // POST /meals/priority/freeze { conference_id } — store everyone's current letter («Fijar grupos» and
        // «Recalcular»: the live cut is taken again, manual groups kept). { unfreeze: true } goes back to live.
        http.route('post', '/meals/priority/freeze', { auth: true }, async (req, res) => {
            const perms = await allow(req, res, 'meals', 'manage');
            if (!perms) return;
            const body = req.body || {};
            const cid = positiveInt(body.conference_id);
            if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
            try {
                if (!await db.get(`SELECT id FROM ${T.conferences} WHERE id = ?`, [cid])) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                await D.withPriorityLock(async () => {
                    await db.run(`DELETE FROM ${T.mealGroups} WHERE conference_id = ? AND (manual IS NULL OR manual = 0)`, [cid]);
                    if (body.unfreeze) { await writeSettings(cid, { frozen_at: null, frozen_by: null }); return; }
                    await writeSettings(cid, { frozen_at: null });
                    invalidate(cid);
                    const live = await buildModel(cid);
                    const at = utcStamp();
                    const writes = [];
                    for (const p of live.byId.values()) {
                        if (p.manual) continue;
                        writes.push([`INSERT INTO ${T.mealGroups} (conference_id, inscription_id, grp, score, manual, set_by, set_at) VALUES (?, ?, ?, ?, 0, ?, ?)`, [cid, p.id, p.group, p.score, actorOf(req), at]]);
                    }
                    await D.runBatched(writes);
                    await writeSettings(cid, { frozen_at: at, frozen_by: actorOf(req) });
                });
                invalidate(cid);
                res.json({ success: true });
            } catch (e) { sendError(res, e); }
        });

        // PUT /meals/priority/people/:id { group: 'A'…'F' | null } — a coordinator's manual group (null = automatic).
        http.route('put', '/meals/priority/people/:id', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'meals', 'manage')) return;
            const id = positiveInt(req.params.id);
            if (!id) return res.status(400).json({ error: 'Inscripción inválida.' });
            const g = req.body ? req.body.group : undefined;
            if (g !== null && !GROUPS.includes(g)) return res.status(400).json({ error: 'El grupo debe ser una letra de la A a la F.' });
            try {
                const ins = await db.get(`SELECT id, conference_id FROM ${T.inscriptions} WHERE id = ?`, [id]);
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                const cid = Number(ins.conference_id);
                await D.withPriorityLock(async () => {
                    if (g === null) {
                        // Back to automatic. When the groups are frozen the person is then placed like a later
                        // registrant (their letter from the last «Fijar grupos» was replaced by the manual one).
                        await db.run(`DELETE FROM ${T.mealGroups} WHERE inscription_id = ?`, [id]);
                    } else {
                        const at = utcStamp();
                        const r = await db.run(`UPDATE ${T.mealGroups} SET grp = ?, manual = 1, set_by = ?, set_at = ? WHERE inscription_id = ?`, [g, actorOf(req), at, id]);
                        if (!(r && r.changes)) await db.run(`INSERT INTO ${T.mealGroups} (conference_id, inscription_id, grp, score, manual, set_by, set_at) VALUES (?, ?, ?, NULL, 1, ?, ?)`, [cid, id, g, actorOf(req), at]);
                    }
                });
                // Who and when are stored on the row (set_by / set_at); never a reason, never a health answer.
                invalidate(cid);
                res.json({ success: true });
            } catch (e) { sendError(res, e); }
        });
    }

    return { migrate, install, modelOf, personGroup, letterOf, invalidate, GROUPS };
}

module.exports = {
    createMealPriority, assignGroups, callOrder, serviceSlots, priorityScore, agePoints, healthPoints, weightOf, parseAge,
    cleanConfig, tieKey, GROUPS, AGE_BANDS, DEFAULT_WEIGHTS, UNKNOWN_WEIGHT, DEFAULT_CONFIG,
};
