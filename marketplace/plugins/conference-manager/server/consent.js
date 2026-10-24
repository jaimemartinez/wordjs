/**
 * «Autorización de datos» (conference-manager 2.33.0): each registrant's own authorization to process their
 * personal data, signed electronically with a one-time code sent to their e-mail.
 *
 * WHY. The site's controller must keep PROOF of every data subject's authorization; a coordinator's word that
 * the person agreed is not proof. Health data are special-category data: their authorization is express,
 * separate and optional, and a minor's is given by their legal representative.
 *
 * FLOW (when the conference turns it on, «Autorizaciones › Configuración»):
 *   1. A coordinator (portal) or the admin registers a person with an e-mail (a parent's, for a minor). The
 *      inscription stays «Autorización pendiente»: it cannot be confirmed (status 'active'), and a health answer
 *      exists for it only on the person's verbal authorization, ticked by whoever enters it (9, 2.34.0).
 *   2. A single-use link is e-mailed (wordjs.mail): /portal/conference/autorizacion#t=<token>. On that page the
 *      person reads the policy (its link and version), ticks SEPARATE, unticked boxes — general processing
 *      (required), sensitive health data (optional), image use (optional) —, answers «Condiciones de salud»
 *      themselves (only with the health box ticked) and, for a minor, names the representative.
 *   3. They confirm with a 6-digit code sent to the same e-mail: 10 minutes, 5 tries per code, a new code at
 *      most once a minute and 5 an hour. The code is never stored anywhere — only its salted hash, in this
 *      process's memory, until it is used or expires — and the log keeps only «sent» and «verified».
 *   4. The evidence goes to an APPEND-ONLY log (consent_events): this module has no UPDATE and no DELETE on it,
 *      a revocation is a new row, and each row carries the SHA-256 of the previous row of the same person
 *      (a chain the export verifies). It holds the subject's identity and verified e-mail, the server's UTC
 *      time and time zone (and the browser's), the caller's network key and user agent, the policy URL and
 *      version with the SHA-256 of the EXACT text shown, each box, the code's sent / verified times and the
 *      representative of a minor. Deleting an inscription keeps its evidence.
 *      Each signature also names the POLICY VERSION in force: the settings that make the page (policy address and
 *      version, controller, contact, the three texts) are kept as an append-only snapshot (consent_policies), and
 *      the signature carries its id and SHA-256. Once someone signed a version, its texts cannot change under the
 *      same version: the administrator must publish a new version, so every record proves what it accepted.
 *   5. A confirmation e-mail tells the person what they accepted, with the policy link.
 *   6. Coordinators see each person's state (pendiente / autorizada with its date / revocada) and can resend the
 *      link, or copy a message with a fresh link to send by hand (WhatsApp, 2.33.2: logged «link_shared», no
 *      e-mail); the admin exports one person's evidence (a data protection authority's request).
 *   7. N days after the conference ends (30 by default) the health answers of the conference are deleted; the
 *      evidence stays.
 *   8. «Consentimiento en papel» (2.34.0, server/consent-paper.js): next to the code, a locality's printed sheet,
 *      its signed pages uploaded and a checklist of who signed — each tick a «granted» row with method 'paper' in
 *      the same chain, and a wrong tick undone by a new row.
 *   9. Verbal health authorization (2.34.0): a coordinator or the admin may enter «Condiciones de salud» while
 *      registering a person, only after ticking that the person authorized it verbally, having been told it is
 *      voluntary. That is a «verbal_granted» row (scope health, method 'verbal', pending written confirmation) and
 *      the answer is in use at once. The later written authorization (code or paper) confirms it («verbal_confirmed»,
 *      linked to the signature); a written «no» to health deletes the answer («health_deleted»). One never
 *      confirmed within `verbal_days` (15 by default) is flagged, not deleted.
 *
 * NETWORK DATA. An isolated plugin never receives the caller's raw IP address: the host hands it `clientKey`, a
 * keyed hash of that address (core/client-ip pluginClientKey), which is what the log keeps («clave de red»):
 * the site's operator can tell whether a given address produced it. That key is the install's own secret: it
 * must stay the same for later correlation to work (see README.md). The user agent is the one the browser
 * reports with the request.
 *
 * SQL: own prefixed tables, portable (SQLite / PostgreSQL / MySQL): VARCHAR for indexed text, times as
 * explicit UTC text and epoch seconds, no upsert syntax, no triggers.
 */
'use strict';

const crypto = require('crypto');
const { waDigits } = require('./phone');
const mails = require('./consent-mail');
const mailTpl = require('./mail-templates');
const { createPaper } = require('./consent-paper');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowS = () => Math.floor(Date.now() / 1000);
const TOKEN_RE = /^[0-9a-f]{32}$/;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const MAX_TEXT = 4000;

const STATES = ['pending', 'granted', 'revoked'];
const RELATIONSHIPS = ['Madre', 'Padre', 'Tutor legal', 'Otro representante legal'];

/**
 * The default health text up to 2.36.8. 2.36.9 names the blood type and the EPS too (DEFAULTS.text_health); a
 * conference that kept the default and whose current policy version was already signed is pinned to this text
 * (migrate), so what those people signed keeps proving the same version — the admin brings the new text in with a
 * new version number, as for any change of text.
 */
const TEXT_HEALTH_BEFORE_2_36_9 = 'Autorizo expresamente el tratamiento de mis datos sensibles de salud (condiciones médicas, alergias, medicamentos y restricciones alimentarias) únicamente para atender emergencias y adaptar la logística del evento. Entiendo que no estoy obligado a suministrarlos y que se eliminarán después del evento.';

/** The defaults a conference starts with (the admin edits every one). {responsable}, {conferencia}, {correo}. */
const DEFAULTS = {
    policy_url: '',               // '' = <site>/politica-de-datos
    policy_version: '1.0',
    responsible: '',
    contact_email: '',
    text_general: 'Autorizo a {responsable}, como Responsable, y al coordinador de mi localidad, que actúa por su cuenta, a tratar mis datos personales para gestionar mi inscripción a «{conferencia}», según la Política de Tratamiento de Datos. Conozco mis derechos a conocer, actualizar, rectificar y suprimir mis datos y a revocar esta autorización escribiendo a {correo}.',
    text_health: 'Autorizo expresamente el tratamiento de mis datos sensibles de salud (condiciones médicas, alergias, medicamentos, restricciones alimentarias, tipo de sangre y EPS) únicamente para atender emergencias y adaptar la logística del evento. Entiendo que no estoy obligado a suministrarlos y que se eliminarán después del evento.',
    text_image: 'Autorizo el uso de mi imagen en fotografías y videos del evento para su publicación en los canales de {responsable}.',
    purge_days: 30,
    link_days: 14,
    verbal_days: 15,
};
const DEFAULT_POLICY_PATH = '/politica-de-datos';

const LIMITS = {
    codeTtlMs: 10 * 60 * 1000,      // a code lives 10 minutes
    codeTries: 5,                   // wrong tries per code, then it is burnt
    resendGapMs: 60 * 1000,         // one new code a minute…
    sendsPerHour: 5,                // …and five an hour, per person
    clientTries: 30,                // confirm attempts per caller in 15 minutes (any person)
    clientWindowMs: 15 * 60 * 1000,
    linkResendGapMs: 60 * 1000,     // the coordinator's «Reenviar enlace», once a minute per person
};

const MSG = {
    link: 'Este enlace no es válido o ya se usó. Pide a tu coordinador que te envíe uno nuevo.',
    expired: 'Este enlace venció. Pide a tu coordinador que te envíe uno nuevo.',
    off: 'Esta conferencia ya no pide esta autorización.',
    throttled: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
    wait: 'Ya te enviamos un código. Espera un minuto para pedir otro.',
    nocode: 'Pide primero el código que te enviamos por correo.',
    codeExpired: 'El código venció. Pide uno nuevo.',
    codeBad: 'El código no es correcto.',
    codeBurnt: 'Escribiste mal el código demasiadas veces. Pide uno nuevo.',
    general: 'Para inscribirte debes aceptar el tratamiento de tus datos personales.',
    rep: 'Escribe el nombre, el documento y el parentesco del representante legal.',
    mail: 'No se pudo enviar el correo. Inténtalo más tarde.',
    unavailable: 'Esta página no está disponible todavía.',
    emailBad: 'Escribe un correo válido: allí te enviaremos el código para firmar.',
};

/**
 * The e-mail field of a form: the one roled 'email', else named «email», else typed email, else (2.33.3) the first
 * non-select field whose label speaks of a mail («Correo», «Correo electrónico», «E-mail», «Email»).
 */
function emailFieldIn(form, isFieldColumn) {
    const usable = (form || []).filter(f => f && isFieldColumn(f.name));
    const label = (f) => String(f.label || f.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return usable.find(f => f.role === 'email') || usable.find(f => f.name === 'email') || usable.find(f => f.type === 'email')
        || usable.find(f => f.type !== 'select' && /(^|\b)(correo|e-?mail)(\b|$)/.test(label(f))) || null;
}

/** «jaime@gmail.com» → «j***@g***.com» (the UI never shows an e-mail whole). */
function maskEmail(email) {
    const m = String(email || '').match(/^([^@]*)@(.+)$/);
    if (!m) return '';
    const [, local, domain] = m;
    const dot = domain.lastIndexOf('.');
    const host = dot > 0 ? domain.slice(0, dot) : domain;
    const tld = dot > 0 ? domain.slice(dot) : '';
    return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

const fill = (text, vars) => String(text || '').replace(/\{(responsable|conferencia|correo)\}/g, (_, k) => vars[k] || '');
const clean = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isoUtc = (ms = Date.now()) => new Date(ms).toISOString();
const serverTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/**
 * The exact text the page shows, as one canonical string: what its SHA-256 proves. The same function builds the
 * page's text and the hash, so the two cannot drift.
 */
function shownText({ conference, policyUrl, policyVersion, texts, minor, representative }) {
    const lines = [
        `Conferencia: ${conference}`,
        `Política de Tratamiento de Datos, versión ${policyVersion}: ${policyUrl}`,
    ];
    if (minor) lines.push(`Representante legal: ${representative ? `${representative.name} (${representative.relationship}), documento ${representative.document}` : ''}. Otorga estas autorizaciones en nombre de la persona inscrita, menor de edad.`);
    lines.push(`[Obligatoria] ${texts.general}`);
    lines.push(`[Opcional] ${texts.health}`);
    lines.push(`[Opcional] ${texts.image}`);
    return lines.join('\n');
}

/** Canonical JSON (sorted keys) for the row hash. */
function canon(v) {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}
const EVENT_COLS = ['conference_id', 'inscription_id', 'request_id', 'kind', 'at_utc', 'at_s', 'server_tz', 'client_tz', 'client_key', 'user_agent',
    'email', 'policy_version', 'policy_sha256', 'text_sha256', 'general', 'health', 'image', 'data', 'actor', 'prev_hash'];
const rowHashOf = (row) => sha256(canon(Object.fromEntries(EVENT_COLS.map(c => [c, row[c] == null ? null : (typeof row[c] === 'number' ? row[c] : String(row[c]))]))));
/** What a policy version is made of (the effective settings the page shows), and its SHA-256. */
const POLICY_KEYS = ['policy_url', 'policy_version', 'responsible', 'contact_email', 'text_general', 'text_health', 'text_image'];
const policyBody = (s) => Object.fromEntries(POLICY_KEYS.map(k => [k, String(s[k] == null ? '' : s[k])]));
const policyHashOf = (s) => sha256(canon(policyBody(s)));

function createConsent(base) {
    const { db, T, P, createIndex, createUniqueIndex, addColumnIfMissing } = base;
    T.consentSettings = `${P}consent_settings`;
    T.consentRequests = `${P}consent_requests`;
    T.consentEvents = `${P}consent_events`;
    T.consentPolicies = `${P}consent_policies`;
    let D = null;
    let ready = false;

    async function migrate() {
        await db.createTable(T.consentSettings, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'enabled INT DEFAULT 0',
            'policy_url TEXT',
            'policy_version VARCHAR(40)',
            'responsible TEXT',
            'contact_email TEXT',
            'text_general TEXT',
            'text_health TEXT',
            'text_image TEXT',
            'purge_days INT',
            'link_days INT',
            'health_purged_s INT',
            'updated_s INT',
            'email_lang VARCHAR(8)',
            'verbal_days INT',
        ]);
        // 2.33.4: «Idioma de los correos» ('' / NULL = the site's language). Older installs get the column here.
        if (addColumnIfMissing) await addColumnIfMissing(T.consentSettings, 'email_lang', 'VARCHAR(8)');
        // 2.34.0: days a verbal health authorization may wait for its written confirmation before it is flagged.
        if (addColumnIfMissing) await addColumnIfMissing(T.consentSettings, 'verbal_days', 'INT');
        await createUniqueIndex(`${P}uidx_consent_settings_conf`, T.consentSettings, 'conference_id');
        // The current state of each person (a projection of the log, for lists): mutable. The log is not.
        await db.createTable(T.consentRequests, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'email VARCHAR(254)',
            'token_hash VARCHAR(64)',
            'token_expires_s INT',
            'link_sent_s INT',
            'mail_failed INT DEFAULT 0',
            'state VARCHAR(12) NOT NULL',
            'general INT DEFAULT 0',
            'health INT DEFAULT 0',
            'image INT DEFAULT 0',
            'granted_s INT',
            'revoked_s INT',
            'updated_s INT',
            'method VARCHAR(12)',
            'sheet_id INT',
            'verbal_s INT',
            'verbal_by VARCHAR(120)',
            'verbal_event_id INT',
            'vgeneral_s INT',
            'vgeneral_by VARCHAR(120)',
            'vgeneral_event_id INT',
        ]);
        // 2.34.0: how the live authorization was given ('otp' | 'paper', NULL before) and the paper sheet; and a live
        // verbal health authorization still waiting for its written confirmation (verbal_s set).
        if (addColumnIfMissing) {
            await addColumnIfMissing(T.consentRequests, 'method', 'VARCHAR(12)');
            await addColumnIfMissing(T.consentRequests, 'sheet_id', 'INT');
            await addColumnIfMissing(T.consentRequests, 'verbal_s', 'INT');
            await addColumnIfMissing(T.consentRequests, 'verbal_by', 'VARCHAR(120)');
            await addColumnIfMissing(T.consentRequests, 'verbal_event_id', 'INT');
            // 2.36.10: the person's verbal authorization of their personal data, ticked by the staff who register
            // them, waiting for its written confirmation (vgeneral_s set).
            await addColumnIfMissing(T.consentRequests, 'vgeneral_s', 'INT');
            await addColumnIfMissing(T.consentRequests, 'vgeneral_by', 'VARCHAR(120)');
            await addColumnIfMissing(T.consentRequests, 'vgeneral_event_id', 'INT');
        }
        await createUniqueIndex(`${P}uidx_consent_requests_ins`, T.consentRequests, 'inscription_id');
        await createIndex(`${P}idx_consent_requests_conf`, T.consentRequests, 'conference_id');
        await createIndex(`${P}idx_consent_requests_token`, T.consentRequests, 'token_hash');
        // APPEND-ONLY. No foreign key to the inscriptions: deleting a person keeps their evidence.
        await db.createTable(T.consentEvents, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT',
            'request_id INT',
            'kind VARCHAR(24) NOT NULL',
            'at_utc VARCHAR(32) NOT NULL',
            'at_s INT NOT NULL',
            'server_tz VARCHAR(64)',
            'client_tz VARCHAR(64)',
            'client_key VARCHAR(64)',
            'user_agent TEXT',
            'email VARCHAR(254)',
            'policy_version VARCHAR(40)',
            'policy_sha256 VARCHAR(64)',
            'text_sha256 VARCHAR(64)',
            'general INT',
            'health INT',
            'image INT',
            'data TEXT',
            'actor VARCHAR(120)',
            'prev_hash VARCHAR(64)',
            'row_hash VARCHAR(64) NOT NULL',
        ]);
        await createIndex(`${P}idx_consent_events_ins`, T.consentEvents, 'inscription_id');
        await createIndex(`${P}idx_consent_events_conf`, T.consentEvents, 'conference_id');
        // APPEND-ONLY too: one row per distinct policy version a conference ever showed (its body and SHA-256).
        await db.createTable(T.consentPolicies, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'policy_version VARCHAR(40)',
            'policy_sha256 VARCHAR(64) NOT NULL',
            'body TEXT NOT NULL',
            'created_utc VARCHAR(32) NOT NULL',
            'created_s INT NOT NULL',
        ]);
        await createIndex(`${P}idx_consent_policies_conf`, T.consentPolicies, 'conference_id, policy_sha256');
        await paper.migrate();
        // 2.36.9: the default health text now names the blood type and the EPS. A conference on the default whose
        // current version was already signed keeps the text it signed — read from that version's policy snapshot
        // (the text the signatures prove), else the pre-2.36.9 default — written into its settings, so a signed
        // version never changes under the same number. Runs on every start; only rows still on the default whose
        // version is signed are touched, and once pinned a row is not on the default any more.
        const loose = await db.all(`SELECT conference_id, policy_version FROM ${T.consentSettings} WHERE text_health IS NULL OR text_health = ''`);
        for (const r of loose) {
            const cid = Number(r.conference_id);
            const version = r.policy_version == null || r.policy_version === '' ? DEFAULTS.policy_version : r.policy_version;
            if (!await versionSigned(cid, version)) continue;
            const snap = await db.get(`SELECT body FROM ${T.consentPolicies} WHERE conference_id = ? AND policy_version = ? ORDER BY id DESC LIMIT 1`, [cid, version]);
            let signed = '';
            try { const b = snap ? JSON.parse(snap.body) : null; signed = b && typeof b.text_health === 'string' ? b.text_health : ''; } catch { /* the old default */ }
            await db.run(`UPDATE ${T.consentSettings} SET text_health = ? WHERE conference_id = ? AND (text_health IS NULL OR text_health = '')`, [signed || TEXT_HEALTH_BEFORE_2_36_9, cid]);
        }
        ready = true;
    }
    const ensureReady = async () => {
        if (ready) return true;
        try { await migrate(); } catch (e) { console.warn('[conference-manager] consent schema:', e && e.message); }
        return ready;
    };

    // ── the log (append-only) ──
    // Appends are serialised in this process, so each person's chain has one predecessor per row.
    let logLock = Promise.resolve();
    function append(ev) {
        const run = logLock.then(async () => {
            const scope = ev.inscription_id != null
                ? await db.get(`SELECT row_hash FROM ${T.consentEvents} WHERE inscription_id = ? ORDER BY id DESC LIMIT 1`, [ev.inscription_id])
                : await db.get(`SELECT row_hash FROM ${T.consentEvents} WHERE conference_id = ? AND inscription_id IS NULL ORDER BY id DESC LIMIT 1`, [ev.conference_id]);
            const ms = Date.now();
            const row = {
                conference_id: Number(ev.conference_id), inscription_id: ev.inscription_id == null ? null : Number(ev.inscription_id),
                request_id: ev.request_id == null ? null : Number(ev.request_id), kind: ev.kind,
                at_utc: isoUtc(ms), at_s: Math.floor(ms / 1000), server_tz: serverTz(),
                client_tz: ev.client_tz ? clean(ev.client_tz, 64) : null, client_key: ev.client_key ? clean(ev.client_key, 64) : null,
                user_agent: ev.user_agent ? clean(ev.user_agent, 400) : null, email: ev.email || null,
                policy_version: ev.policy_version || null, policy_sha256: ev.policy_sha256 || null, text_sha256: ev.text_sha256 || null,
                general: ev.general == null ? null : (ev.general ? 1 : 0), health: ev.health == null ? null : (ev.health ? 1 : 0), image: ev.image == null ? null : (ev.image ? 1 : 0),
                data: ev.data == null ? null : JSON.stringify(ev.data), actor: ev.actor ? clean(ev.actor, 120) : null,
                prev_hash: scope ? scope.row_hash : null,
            };
            row.row_hash = rowHashOf(row);
            const cols = [...EVENT_COLS, 'row_hash'];
            const ins = await db.run(`INSERT INTO ${T.consentEvents} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]));
            // The new row's id (not hashed: it is not one of EVENT_COLS).
            row.id = ins && ins.lastID != null ? Number(ins.lastID) : null;
            return row;
        });
        logLock = run.then(() => {}, () => {});
        return run;
    }
    /** One person's log, oldest first, with the chain checked (`chain_ok`, and `broken_at` = the first bad id). */
    async function eventsOf(inscriptionId) {
        const rows = await db.all(`SELECT * FROM ${T.consentEvents} WHERE inscription_id = ? ORDER BY id ASC`, [inscriptionId]);
        let prev = null, brokenAt = null;
        for (const r of rows) {
            const norm = { ...r };
            for (const c of ['conference_id', 'inscription_id', 'request_id', 'at_s', 'general', 'health', 'image']) if (norm[c] != null) norm[c] = Number(norm[c]);
            if (brokenAt == null && ((r.prev_hash || null) !== prev || rowHashOf(norm) !== r.row_hash)) brokenAt = r.id;
            prev = r.row_hash;
        }
        return { rows, chain_ok: brokenAt == null, broken_at: brokenAt };
    }

    // ── policy versions (append-only) ──
    // The snapshot of the policy a page shows: found by its SHA-256, inserted the first time it is signed.
    let policyLock = Promise.resolve();
    function policySnapshot(cid, s) {
        const run = policyLock.then(async () => {
            const hash = policyHashOf(s);
            const found = await db.get(`SELECT id, policy_version, policy_sha256 FROM ${T.consentPolicies} WHERE conference_id = ? AND policy_sha256 = ?`, [cid, hash]);
            if (found) return { id: Number(found.id), version: found.policy_version, sha256: found.policy_sha256 };
            const ms = Date.now();
            const r = await db.run(`INSERT INTO ${T.consentPolicies} (conference_id, policy_version, policy_sha256, body, created_utc, created_s) VALUES (?, ?, ?, ?, ?, ?)`,
                [cid, s.policy_version, hash, JSON.stringify(policyBody(s)), isoUtc(ms), Math.floor(ms / 1000)]);
            return { id: Number(r.lastID), version: s.policy_version, sha256: hash };
        });
        policyLock = run.then(() => {}, () => {});
        return run;
    }
    /** Has anyone signed this conference's policy version? */
    const versionSigned = async (cid, version) =>
        !!(await db.get(`SELECT id FROM ${T.consentEvents} WHERE conference_id = ? AND kind = 'granted' AND policy_version = ? LIMIT 1`, [cid, version]));

    // ── settings ──
    async function settingsRow(cid) {
        return db.get(`SELECT * FROM ${T.consentSettings} WHERE conference_id = ?`, [cid]);
    }
    /** The conference's settings with every default filled in ({ enabled: false } when never set). */
    async function settingsOf(cid) {
        const r = (await settingsRow(cid)) || {};
        const pick = (k) => (r[k] == null || r[k] === '' ? DEFAULTS[k] : r[k]);
        const base = await D.siteLinkBase();
        const policyUrl = pick('policy_url') || (base ? `${base}${DEFAULT_POLICY_PATH}` : DEFAULT_POLICY_PATH);
        const intOr = (v, d, lo, hi) => { if (v == null || v === '') return d; const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
        return {
            enabled: !!Number(r.enabled || 0),
            policy_url: policyUrl,
            policy_url_custom: r.policy_url || '',
            policy_version: pick('policy_version'),
            responsible: pick('responsible'),
            contact_email: pick('contact_email'),
            text_general: pick('text_general'),
            text_health: pick('text_health'),
            text_image: pick('text_image'),
            purge_days: intOr(r.purge_days, DEFAULTS.purge_days, 0, 3650),
            link_days: intOr(r.link_days, DEFAULTS.link_days, 1, 90),
            verbal_days: intOr(r.verbal_days, DEFAULTS.verbal_days, 1, 365),
            health_purged_at: r.health_purged_s ? isoUtc(Number(r.health_purged_s) * 1000) : null,
            // «Idioma de los correos» (2.33.4): the e-mails, the copied message and the consent page start in it.
            email_lang: mails.langOf(r.email_lang) || '',
            site_lang: await siteLang(),
            plugin_email_lang: await pluginLang(),
            mail_lang: mails.langOf(r.email_lang) || await pluginLang(),
        };
    }
    // The plugin's own default (owner: «en el plugin se configure en qué idioma se envían los correos de consentimiento
    // by default»): the row conference_id = 0 of consent_settings (no conference has id 0), never set = the site's.
    const PLUGIN_ROW = 0;
    async function pluginLang() {
        let r = null;
        try { r = await db.get(`SELECT email_lang FROM ${T.consentSettings} WHERE conference_id = ?`, [PLUGIN_ROW]); } catch { r = null; }
        return (r && mails.langOf(r.email_lang)) || await siteLang();
    }
    async function setPluginLang(lang) {
        const v = lang ? String(lang).toLowerCase() : '';
        const r = await db.run(`UPDATE ${T.consentSettings} SET email_lang = ?, updated_s = ? WHERE conference_id = ?`, [v, nowS(), PLUGIN_ROW]);
        if (!r || !r.changes) await db.run(`INSERT INTO ${T.consentSettings} (conference_id, enabled, email_lang, updated_s) VALUES (?, 0, ?, ?)`, [PLUGIN_ROW, v, nowS()]);
    }
    /** The site's language (WPLANG, «es_ES» → es) when it is es / en / pt; else Spanish, the plugin's own. */
    async function siteLang() {
        let raw = '';
        try { raw = D && D.siteLang ? await D.siteLang() : ''; } catch { raw = ''; }
        return mails.langOf(raw) || 'es';
    }
    const mailLangOf = async (cid) => (await settingsOf(cid)).mail_lang;
    const isEnabled = async (cid) => {
        if (!await ensureReady()) return false;
        const r = await settingsRow(cid);
        return !!(r && Number(r.enabled));
    };
    async function saveSettings(cid, body, httpError) {
        const b = body || {};
        const txt = (k, max) => {
            if (b[k] === undefined) return undefined;
            const v = String(b[k] == null ? '' : b[k]).trim();
            if (v.length > max) throw httpError(400, 'Uno de los textos es demasiado largo.');
            return v;
        };
        const vals = {
            enabled: b.enabled === undefined ? undefined : (b.enabled ? 1 : 0),
            policy_url: txt('policy_url', 500),
            policy_version: txt('policy_version', 40),
            responsible: txt('responsible', 200),
            contact_email: txt('contact_email', 254),
            text_general: txt('text_general', MAX_TEXT),
            text_health: txt('text_health', MAX_TEXT),
            text_image: txt('text_image', MAX_TEXT),
            purge_days: b.purge_days === undefined ? undefined : Number(b.purge_days),
            link_days: b.link_days === undefined ? undefined : Number(b.link_days),
            verbal_days: b.verbal_days === undefined ? undefined : Number(b.verbal_days),
            email_lang: b.email_lang === undefined ? undefined : String(b.email_lang || '').trim().toLowerCase(),
        };
        if (vals.email_lang && !mails.LANGS.includes(vals.email_lang)) throw httpError(400, 'Idioma de los correos inválido (es, en o pt).');
        if (vals.policy_url && !/^https?:\/\/[^\s<>"']+$/i.test(vals.policy_url)) throw httpError(400, 'La dirección de la política debe empezar por https://');
        if (vals.contact_email && !EMAIL_RE.test(vals.contact_email)) throw httpError(400, 'El correo de contacto no es válido.');
        if (vals.purge_days !== undefined && !(Number.isInteger(vals.purge_days) && vals.purge_days >= 0 && vals.purge_days <= 3650)) throw httpError(400, 'Los días para borrar los datos de salud deben ser un número entero entre 0 y 3650.');
        if (vals.link_days !== undefined && !(Number.isInteger(vals.link_days) && vals.link_days >= 1 && vals.link_days <= 90)) throw httpError(400, 'Los días de validez del enlace deben ser un número entero entre 1 y 90.');
        if (vals.verbal_days !== undefined && !(Number.isInteger(vals.verbal_days) && vals.verbal_days >= 1 && vals.verbal_days <= 365)) throw httpError(400, 'Los días para confirmar por escrito una autorización verbal deben ser un número entero entre 1 y 365.');
        for (const k of ['text_general', 'text_health', 'text_image']) if (vals[k] === '') throw httpError(400, 'Ningún texto de autorización puede quedar vacío.');
        const sets = Object.entries(vals).filter(([, v]) => v !== undefined);
        // A signed version is closed: what it says can only change under a new version number.
        const before = await settingsOf(cid);
        const after = { ...before, ...Object.fromEntries(sets) };
        if (vals.policy_url !== undefined && !vals.policy_url) {
            const base = await D.siteLinkBase();
            after.policy_url = base ? `${base}${DEFAULT_POLICY_PATH}` : DEFAULT_POLICY_PATH;
        }
        if (vals.policy_version !== undefined && !vals.policy_version) throw httpError(400, 'Escribe la versión de la política.');
        if (after.policy_version === before.policy_version && policyHashOf(after) !== policyHashOf(before) && await versionSigned(cid, before.policy_version)) {
            throw httpError(409, `Ya hay personas que firmaron la versión ${before.policy_version} de la política: para cambiar los textos, la dirección, el responsable o el correo, escribe una versión nueva (por ejemplo, la siguiente). Así cada firma sigue probando qué versión aceptó.`);
        }
        const existing = await settingsRow(cid);
        if (existing) {
            if (sets.length) await db.run(`UPDATE ${T.consentSettings} SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_s = ? WHERE conference_id = ?`, [...sets.map(([, v]) => v), nowS(), cid]);
        } else {
            const cols = ['conference_id', ...sets.map(([k]) => k), 'updated_s'];
            await db.run(`INSERT INTO ${T.consentSettings} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, [cid, ...sets.map(([, v]) => v), nowS()]);
        }
        return settingsOf(cid);
    }

    // ── the person ──
    async function formOf(cid) {
        return db.all(`SELECT name, label, type, role, options, is_unique, is_required FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]);
    }
    /** The e-mail field of a form: the one roled 'email', else named «email», else the first of type email. */
    function emailFieldOf(form) {
        return emailFieldIn(form, D.isFieldColumn);
    }
    async function emailOf(ins, form) {
        const f = emailFieldOf(form || await formOf(ins.conference_id));
        const v = f ? String(ins[f.name] == null ? '' : ins[f.name]).trim() : '';
        return EMAIL_RE.test(v) ? v.toLowerCase() : '';
    }
    /** Is the person a minor by the form's «Edad» (role 'age')? null when the form does not say. */
    function minorByAge(ins, form) {
        const f = form.find(x => x.role === 'age' && D.isFieldColumn(x.name));
        if (!f) return null;
        const n = Number(String(ins[f.name] == null ? '' : ins[f.name]).trim());
        return String(ins[f.name] == null ? '' : ins[f.name]).trim() !== '' && Number.isFinite(n) ? n < 18 : null;
    }
    async function identityOf(ins, form) {
        const person = await D.personWithName(ins);
        const doc = D.docFieldsOf(form);
        const loc = ins.location_id != null ? await db.get(`SELECT name FROM ${T.locations} WHERE id = ?`, [ins.location_id]) : null;
        return {
            inscription_id: Number(ins.id),
            name: person.name || '',
            document_type: doc.type ? clean(ins[doc.type.name], 60) || null : null,
            document_number: doc.number ? clean(ins[doc.number.name], 60) || null : null,
            registration_code: ins.reg_code || null,
            location: loc ? loc.name : null,
        };
    }
    async function conferenceOf(cid) {
        return db.get(`SELECT id, name, date_start, date_end, phone_country FROM ${T.conferences} WHERE id = ?`, [cid]);
    }
    const requestOf = (insId) => db.get(`SELECT * FROM ${T.consentRequests} WHERE inscription_id = ?`, [insId]);

    async function textsOf(cid, conf) {
        const s = await settingsOf(cid);
        return { s, texts: fillTexts(s, conf) };
    }
    /** The three texts of a policy body (the settings, or a stored snapshot) with {responsable}… filled in. */
    function fillTexts(s, conf) {
        const vars = { responsable: s.responsible || 'los organizadores', conferencia: conf ? conf.name : '', correo: s.contact_email || 'los organizadores' };
        return { general: fill(s.text_general, vars), health: fill(s.text_health, vars), image: fill(s.text_image, vars) };
    }

    // ── mail ──
    // 2.36.11: the message through «Plantillas de correo» (the stored edit of its language), else its default.
    async function renderMail(id, lang, values, extras, fallback) {
        if (D && D.mailTemplates) { try { return await D.mailTemplates.render(id, lang, values, extras); } catch (e) { console.warn('[conference-manager] mail template:', e && e.message); } }
        return fallback();
    }
    async function sendMail(msg) {
        try { await D.mail(msg); return true; }
        catch (e) { console.warn('[conference-manager] consent e-mail not sent:', e && e.message); return false; }
    }
    // The three e-mails, in the conference's e-mail language (server/consent-mail.js, 2.33.4).
    async function mailLink(conf, email, link, name, days) {
        const lang = await mailLangOf(conf.id);
        return sendMail({ to: email, ...await renderMail('consent.link', lang, { conference: conf.name, name, days }, { action: { url: link } }, () => mails.linkMail(lang, { conference: conf.name, name, link, days })) });
    }
    async function mailCode(conf, email, code) {
        const lang = await mailLangOf(conf.id);
        return sendMail({ to: email, ...await renderMail('consent.code', lang, { conference: conf.name, code }, { code }, () => mails.codeMail(lang, { conference: conf.name, code })) });
    }
    async function mailConfirmation(conf, email, ev) {
        const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
        const lang = (await mailLangOf(conf.id)) || 'es';
        return sendMail({ to: email, ...await renderMail('consent.confirmation', lang, { conference: conf.name, contact: d.contact || mails.ORGANIZERS[mails.langOf(lang) || 'es'] }, { record: mailTpl.recordOf(lang, ev, d) }, () => mails.confirmationMail(lang, { conference: conf.name, ev, d })) });
    }

    // ── links ──
    const LINK_PATH = '/portal/conference/autorizacion#t=';
    /**
     * A NEW single-use link for the person (any older one stops working) and its e-mail. Returns
     * { state, sent, link, email_masked } — `link` so the coordinator may also share it (it is useless without the
     * code sent to the e-mail). Throws 400 without an e-mail, 429 when asked again within a minute.
     */
    async function issueLink(ins, { actor, via, httpError, force = false }) {
        const conf = await conferenceOf(ins.conference_id);
        const form = await formOf(ins.conference_id);
        const email = await emailOf(ins, form);
        if (!email) throw httpError(400, NO_EMAIL);
        const s = await settingsOf(ins.conference_id);
        const prior = await requestOf(ins.id);
        if (!force && prior && prior.link_sent_s && !Number(prior.mail_failed) && Date.now() - Number(prior.link_sent_s) * 1000 < LIMITS.linkResendGapMs) throw httpError(429, 'Acabamos de enviar el enlace. Espera un minuto para reenviarlo.');
        const { token, link, expires } = await newToken(s);
        const name = (await D.personWithName(ins)).name || '';
        const sent = await mailLink(conf, email, link, name, s.link_days);
        const requestId = await storeToken(ins, email, token, expires, { mailSent: sent });
        await append({ conference_id: ins.conference_id, inscription_id: ins.id, request_id: requestId, kind: 'link_sent', email, actor, data: { via, mail_sent: sent, link_expires_utc: isoUtc(expires * 1000) } });
        const now = await requestOf(ins.id);
        return { state: now.state, sent, link, email_masked: maskEmail(email) };
    }
    const NO_EMAIL = 'Para pedir la autorización de datos, la persona necesita un correo electrónico válido (el de su padre, madre o representante si es menor de edad).';
    async function newToken(s) {
        const token = String(await D.randomToken(16));
        const base = await D.siteLinkBase();
        return { token, link: `${base || ''}${LINK_PATH}${token}`, expires: nowS() + s.link_days * 86400 };
    }
    /**
     * The person's live token becomes `token` (any older link stops working). `mailSent` true / false records an
     * e-mailed link (its time and whether the mail left); undefined (a link shared by hand) leaves both alone.
     * Returns the request id.
     */
    async function storeToken(ins, email, token, expires, { mailSent } = {}) {
        const mailed = mailSent !== undefined;
        const sets = ['email = ?', 'token_hash = ?', 'token_expires_s = ?', ...(mailed ? ['link_sent_s = ?', 'mail_failed = ?'] : []), 'updated_s = ?'];
        const vals = [email, sha256(token), expires, ...(mailed ? [nowS(), mailSent ? 0 : 1] : []), nowS()];
        const update = (id) => db.run(`UPDATE ${T.consentRequests} SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
        // A revoked or granted person asked again keeps that state until they sign the new link.
        const prior = await requestOf(ins.id);
        if (prior) { await update(prior.id); return Number(prior.id); }
        try {
            const r = await db.run(`INSERT INTO ${T.consentRequests} (conference_id, inscription_id, email, token_hash, token_expires_s, link_sent_s, mail_failed, state, updated_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                [ins.conference_id, ins.id, email, sha256(token), expires, mailed ? nowS() : null, mailed && !mailSent ? 1 : 0, nowS()]);
            return Number(r.lastID);
        } catch (e) {
            // A concurrent first link won the UNIQUE index: this one replaces its token.
            const again = await requestOf(ins.id);
            await update(again.id);
            return Number(again.id);
        }
    }
    /** The person's phone as the form has it (the field roled 'phone', typed tel, or named like a phone), or ''. */
    async function phoneOf(ins, form) {
        const usable = form.filter(f => D.isFieldColumn(f.name));
        const f = usable.find(x => x.role === 'phone') || usable.find(x => x.type === 'tel' || x.type === 'phone')
            || usable.find(x => /^(phone|telefono|tel[eé]fono|celular|movil|m[oó]vil|whatsapp)$/i.test(String(x.name)));
        return f ? clean(ins[f.name], 40) : '';
    }
    /**
     * «Copiar mensaje» (2.33.2): a NEW single-use link to send by hand (WhatsApp, …) — no e-mail leaves, the
     * request is not marked e-mailed, and the log gets a «link_shared» row. The signature itself is unchanged: the
     * code still goes to the person's e-mail. Returns what the message needs (the staff screen writes it in its
     * own language).
     */
    async function shareLink(ins, { actor, via }) {
        const conf = await conferenceOf(ins.conference_id);
        const form = await formOf(ins.conference_id);
        // 2.33.3: a person with no e-mail on file can still get the link: the consent page asks for one, and the code
        // goes there (the evidence says the e-mail was typed on the page).
        const email = await emailOf(ins, form);
        const s = await settingsOf(ins.conference_id);
        const { token, link, expires } = await newToken(s);
        const requestId = await storeToken(ins, email || null, token, expires);
        await append({ conference_id: ins.conference_id, inscription_id: ins.id, request_id: requestId, kind: 'link_shared', email: email || null, actor, data: { via, channel: 'manual', link_expires_utc: isoUtc(expires * 1000), email_on_file: !!email } });
        const now = await requestOf(ins.id);
        const name = (await D.personWithName(ins)).name || '';
        return {
            state: now.state, link, email_masked: email ? maskEmail(email) : '', first_name: String(name).split(' ')[0] || '',
            conference: conf ? conf.name : '', policy_version: s.policy_version, policy_url: s.policy_url, link_days: s.link_days,
            email_lang: s.mail_lang,
            phone: await phoneOf(ins, form),
            // The number wa.me wants: its stored country code, or the conference's default for an older national one.
            phone_wa: waDigits(await phoneOf(ins, form), conf && conf.phone_country) || '',
        };
    }

    // ── one-time codes: only their salted hash, in memory ──
    const codes = new Map();   // request id → { hash, salt, expiresAt, tries, sentAt }
    const sends = new Map();   // request id → [sent ms, …] (last hour)
    const clientTries = new Map(); // client → { count, first }
    const CAP = 5000;
    const trim = (map) => { if (map.size >= CAP) map.delete(map.keys().next().value); };
    const codeHash = (code, salt) => sha256(`${salt}:${code}`);
    function chargeClient(client) {
        const now = Date.now();
        let b = clientTries.get(client);
        if (!b || now - b.first >= LIMITS.clientWindowMs) { trim(clientTries); b = { count: 0, first: now }; clientTries.set(client, b); }
        if (b.count >= LIMITS.clientTries) return false;
        b.count++;
        return true;
    }

    /** The request a token opens (live, not expired), or a refusal code: 'link' | 'expired' | 'off'. */
    async function byToken(token) {
        if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { code: 'link' };
        const req = await db.get(`SELECT * FROM ${T.consentRequests} WHERE token_hash = ?`, [sha256(token)]);
        if (!req) return { code: 'link' };
        if (Number(req.token_expires_s) < nowS()) return { code: 'expired' };
        const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [req.inscription_id]);
        if (!ins || ins.status === 'cancelled') return { code: 'link' };
        if (!await isEnabled(ins.conference_id)) return { code: 'off' };
        return { code: null, req, ins };
    }

    /** What the public page shows for a live request (`representative` fills in the minor's sentence). */
    async function pageOf(req, ins, representative) {
        const conf = await conferenceOf(ins.conference_id);
        const form = await formOf(ins.conference_id);
        const { s, texts } = await textsOf(ins.conference_id, conf);
        const healthField = await D.health.fieldOf(ins.conference_id);
        const minor = minorByAge(ins, form);
        const name = (await D.personWithName(ins)).name || '';
        return {
            conf, s, texts, form, healthField, minor, name,
            view: {
                conference: conf ? conf.name : '',
                first_name: String(name).split(' ')[0] || '',
                email_masked: req.email ? maskEmail(req.email) : '',
                // 2.33.3: no e-mail on file — the page asks for one, and the code is sent there.
                needs_email: !req.email,
                // 2.33.4: the page starts in the conference's e-mail language (the person may switch).
                lang: s.mail_lang,
                minor, // true / false by «Edad»; null = the person says
                policy: { url: s.policy_url, version: s.policy_version },
                responsible: s.responsible || '',
                contact_email: s.contact_email || '',
                texts,
                relationships: RELATIONSHIPS,
                health_field: healthField ? { name: healthField.name, label: healthField.label, options: healthField.options, is_required: 0 } : null,
                // The text this page hashes (the minor's sentence is added once the representative is known).
                text: shownText({ conference: conf ? conf.name : '', policyUrl: s.policy_url, policyVersion: s.policy_version, texts, minor: !!(minor || representative), representative }),
                state: req.state,
            },
        };
    }

    // ── health purge ──
    let lastPurgeCheck = 0;
    /** Delete the health answers of every conference whose purge date passed (once per conference). */
    async function purgeDue({ force = false } = {}) {
        if (!force && Date.now() - lastPurgeCheck < 60 * 60 * 1000) return [];
        lastPurgeCheck = Date.now();
        if (!await ensureReady()) return [];
        const rows = await db.all(`SELECT s.conference_id, s.purge_days, c.date_end FROM ${T.consentSettings} s JOIN ${T.conferences} c ON c.id = s.conference_id WHERE s.enabled = 1 AND s.health_purged_s IS NULL`);
        const done = [];
        for (const r of rows) {
            const end = r.date_end ? Date.parse(`${String(r.date_end).slice(0, 10)}T23:59:59Z`) : NaN;
            if (!Number.isFinite(end)) continue;
            const days = r.purge_days == null ? DEFAULTS.purge_days : Number(r.purge_days);
            if (Date.now() < end + days * 86400 * 1000) continue;
            const cid = Number(r.conference_id);
            const n = (await db.get(`SELECT COUNT(*) AS n FROM ${T.healthAnswers} WHERE conference_id = ?`, [cid])).n;
            await D.health.clearConference(cid);
            // Nothing is left for a verbal authorization to confirm.
            await db.run(`UPDATE ${T.consentRequests} SET verbal_s = NULL, verbal_by = NULL, verbal_event_id = NULL WHERE conference_id = ?`, [cid]);
            await db.run(`UPDATE ${T.consentSettings} SET health_purged_s = ? WHERE conference_id = ?`, [nowS(), cid]);
            await append({ conference_id: cid, inscription_id: null, kind: 'health_purged', actor: 'sistema', data: { answers_deleted: Number(n) || 0, days_after_end: days, conference_end: String(r.date_end).slice(0, 10) } });
            done.push(cid);
        }
        return done;
    }

    // ── what the rest of the plugin asks ──
    /** inscription id → { state, granted_at, revoked_at, general, health, image, email_masked, mail_failed } */
    async function statesOf(conferenceId, ids) {
        const out = new Map();
        if (!await ensureReady()) return out;
        const verbalDays = (await settingsOf(conferenceId)).verbal_days;
        const list = ids ? [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : null;
        const add = (rows) => {
            for (const r of rows) {
                out.set(Number(r.inscription_id), {
                    state: STATES.includes(r.state) ? r.state : 'pending',
                    granted_at: r.granted_s ? isoUtc(Number(r.granted_s) * 1000) : null,
                    revoked_at: r.revoked_s ? isoUtc(Number(r.revoked_s) * 1000) : null,
                    general: !!Number(r.general), health: !!Number(r.health), image: !!Number(r.image),
                    email_masked: maskEmail(r.email), mail_failed: !!Number(r.mail_failed),
                    link_expired: r.state === 'pending' && Number(r.token_expires_s) < nowS(),
                    // 2.34.0: 'otp' | 'paper' while granted (an authorization from before 2.34.0 was by code).
                    method: r.state === 'granted' ? (r.method || 'otp') : null,
                    // 2.34.0: a verbal health authorization waiting for its written confirmation, and whether it is late.
                    verbal_health: r.verbal_s != null,
                    verbal_at: r.verbal_s != null ? isoUtc(Number(r.verbal_s) * 1000) : null,
                    verbal_overdue: r.verbal_s != null && nowS() - Number(r.verbal_s) > verbalDays * 86400,
                    // 2.36.10: the verbal authorization of the personal data (staff registration), until confirmed in writing.
                    verbal_general: r.vgeneral_s != null,
                    verbal_general_at: r.vgeneral_s != null ? isoUtc(Number(r.vgeneral_s) * 1000) : null,
                    verbal_general_by: r.vgeneral_s != null ? (r.vgeneral_by || null) : null,
                });
            }
        };
        if (!list) add(await db.all(`SELECT * FROM ${T.consentRequests} WHERE conference_id = ?`, [conferenceId]));
        else for (let i = 0; i < list.length; i += 500) {
            const chunk = list.slice(i, i + 500);
            add(await db.all(`SELECT * FROM ${T.consentRequests} WHERE inscription_id IN (${chunk.map(() => '?').join(', ')})`, chunk));
        }
        return out;
    }
    /** Has the person a valid e-mail on file (the form's e-mail field)? (2.35.0: registering without one is allowed.) */
    async function hasEmail(ins) {
        return !!(await emailOf(ins, await formOf(ins.conference_id)));
    }
    /** The ids of a conference's people without a valid e-mail on file («sin correo», 2.35.0). */
    async function noEmailIds(conferenceId) {
        const f = emailFieldOf(await formOf(conferenceId));
        const rows = await db.all(`SELECT id${f ? `, ${f.name} AS email_value` : ''} FROM ${T.inscriptions} WHERE conference_id = ?`, [conferenceId]);
        return rows.filter(r => !f || !EMAIL_RE.test(String(r.email_value == null ? '' : r.email_value).trim())).map(r => Number(r.id));
    }
    /** Has the person's general authorization (the one that confirms an inscription)? */
    async function isGranted(inscriptionId) {
        const r = await requestOf(inscriptionId);
        return !!(r && r.state === 'granted' && Number(r.general));
    }
    /** May health data be held for this person (consent on: only with their live health authorization)? */
    async function healthAllowed(conferenceId, inscriptionId) {
        if (!await isEnabled(conferenceId)) return true;
        if (inscriptionId == null) return false;
        const r = await requestOf(inscriptionId);
        return !!(r && ((r.state === 'granted' && Number(r.health)) || r.verbal_s != null));
    }
    /**
     * 2.36.10: how each authorization of the person is recorded — the personal data (`general`) and the health data
     * (`health`): 'written' (code or paper), 'verbal' (ticked by staff, waiting for the written one) or null; and
     * whether they revoked everything. The edit form locks a recorded one; a missing one is asked for.
     */
    async function authorizationOf(inscriptionId) {
        const r = await requestOf(inscriptionId);
        const granted = !!r && r.state === 'granted';
        return {
            revoked: !!r && r.state === 'revoked',
            general: granted && Number(r.general) ? 'written' : (r && r.vgeneral_s != null ? 'verbal' : null),
            health: granted && Number(r.health) ? 'written' : (r && r.verbal_s != null ? 'verbal' : null),
        };
    }
    /**
     * 2.36.10: the person's authorization events for the «Historial»: what happened, when, by whom — never an answer,
     * an e-mail or a document (those stay in the evidence export). `scope` says personal data or health.
     */
    async function historyOf(inscriptionId) {
        const KEEP = new Set(['link_sent', 'link_shared', 'verbal_granted', 'verbal_confirmed', 'granted', 'revoked', 'paper_unmarked', 'health_entered', 'health_deleted', 'health_purged']);
        const rows = await db.all(`SELECT kind, at_utc, actor, general, health, image, data FROM ${T.consentEvents} WHERE inscription_id = ? ORDER BY id ASC`, [inscriptionId]);
        return rows.filter(r => KEEP.has(r.kind)).map((r) => {
            let d = {};
            try { d = JSON.parse(r.data || '{}') || {}; } catch { /* no detail */ }
            const scope = r.kind === 'verbal_granted' ? (d.scope === 'general' ? 'general' : 'health')
                : r.kind === 'verbal_confirmed' ? (d.scope === 'general' ? 'general' : 'health')
                : /^health_/.test(r.kind) ? 'health' : null;
            const flag = (v) => (v == null ? null : !!Number(v));
            return {
                // A code signature's row carries the verified e-mail, not a method: it is 'otp' (paper says 'paper').
                kind: r.kind, at: r.at_utc, actor: r.actor || null, scope, method: d.method || (r.kind === 'granted' && d.verified_email ? 'otp' : null), via: d.via || null,
                ...(r.kind === 'granted' || r.kind === 'revoked' ? { general: flag(r.general), health: flag(r.health), image: flag(r.image) } : {}),
            };
        });
    }
    /** Has the person's WRITTEN health authorization (code or paper)? */
    async function healthWritten(inscriptionId) {
        const r = await requestOf(inscriptionId);
        return !!(r && r.state === 'granted' && Number(r.health));
    }
    /** Did the person say «no» to health in writing (signed without it, revoked it, or revoked everything)? */
    async function healthRefused(inscriptionId) {
        const r = await requestOf(inscriptionId);
        return !!(r && (r.state === 'revoked' || (r.state === 'granted' && !Number(r.health))));
    }

    // ── routes ──
    function install(deps) {
        D = deps;
        const { http, allow, positiveInt, sendError, httpError, actorOf, resolvePortalLocation } = deps;
        const send = (res, e) => res.status(e && e.status ? e.status : 500).json({ error: e && e.message ? e.message : String(e) });
        const refuse = (res, code, status) => res.status(status || (code === 'throttled' || code === 'wait' ? 429 : code === 'link' || code === 'expired' || code === 'off' ? 410 : 400)).json({ error: MSG[code] || MSG.link, code });
        const gate = async (res) => {
            if (!await ensureReady()) { res.status(503).json({ error: MSG.unavailable, code: 'unavailable' }); return false; }
            return true;
        };
        const clientOf = (req) => String((req && (req.clientKey || req.ip)) || '').slice(0, 64);
        const uaOf = (req, body) => clean((body && body.user_agent) || (req.headers && req.headers['user-agent']) || '', 400);

        // POST /public/consent/open { token } → { view }
        http.route('post', '/public/consent/open', async (req, res) => {
            if (!await gate(res)) return;
            try {
                const t = await byToken((req.body || {}).token);
                if (t.code) return refuse(res, t.code);
                const p = await pageOf(t.req, t.ins, null);
                res.json({ view: p.view });
            } catch (e) { send(res, e); }
        });

        // POST /public/consent/code { token } → { sent, email_masked, expires_in, resend_in }
        http.route('post', '/public/consent/code', async (req, res) => {
            if (!await gate(res)) return;
            try {
                const t = await byToken((req.body || {}).token);
                if (t.code) return refuse(res, t.code);
                const id = Number(t.req.id), now = Date.now();
                const list = (sends.get(id) || []).filter(x => now - x < 60 * 60 * 1000);
                if (list.length && now - list[list.length - 1] < LIMITS.resendGapMs) return res.status(429).json({ error: MSG.wait, code: 'wait', resend_in: Math.ceil((LIMITS.resendGapMs - (now - list[list.length - 1])) / 1000) });
                if (list.length >= LIMITS.sendsPerHour) return refuse(res, 'throttled');
                // The e-mail on file; without one (2.33.3), the one the person types on the page.
                const typed = String((req.body || {}).email == null ? '' : (req.body || {}).email).trim().toLowerCase();
                const email = t.req.email || typed;
                if (!t.req.email && !EMAIL_RE.test(typed)) return res.status(400).json({ error: MSG.emailBad, code: 'email', field: 'email' });
                const code = String(await D.randomInt(0, 1000000)).padStart(6, '0');
                const salt = String(await D.randomToken(8));
                const conf = await conferenceOf(t.ins.conference_id);
                const ok = await mailCode(conf, email, code);
                if (!ok) return res.status(502).json({ error: MSG.mail, code: 'mail' });
                list.push(now);
                trim(sends); sends.set(id, list);
                trim(codes); codes.set(id, { hash: codeHash(code, salt), salt, expiresAt: now + LIMITS.codeTtlMs, tries: 0, sentAt: now, email, typed: !t.req.email });
                await append({ conference_id: t.ins.conference_id, inscription_id: t.ins.id, request_id: id, kind: 'otp_sent', email,
                    client_key: clientOf(req), user_agent: uaOf(req, req.body), data: { expires_utc: isoUtc(now + LIMITS.codeTtlMs), email_source: t.req.email ? 'on_file' : 'typed_on_page' } });
                res.json({ sent: true, email_masked: maskEmail(email), expires_in: LIMITS.codeTtlMs / 1000, resend_in: LIMITS.resendGapMs / 1000 });
            } catch (e) { send(res, e); }
        });

        // POST /public/consent/confirm { token, code, general, health, image, health_answer?, minor?, representative?,
        //   client_tz?, user_agent? } → { state, granted_at, choices } | 400 (field: …) | 401 (code) | 429 | 410.
        http.route('post', '/public/consent/confirm', async (req, res) => {
            if (!await gate(res)) return;
            try {
                const body = req.body || {};
                if (!chargeClient(clientOf(req) || 'anon')) return refuse(res, 'throttled');
                const t = await byToken(body.token);
                if (t.code) return refuse(res, t.code);
                const id = Number(t.req.id);
                // The form first (a mistake there costs no code try).
                if (body.general !== true) return res.status(400).json({ error: MSG.general, code: 'general', field: 'general' });
                const wantsHealth = body.health === true, wantsImage = body.image === true;
                const p0 = await pageOf(t.req, t.ins, null);
                const minor = p0.minor === true || (p0.minor == null && body.minor === true);
                let representative = null;
                if (minor) {
                    const r = body.representative || {};
                    representative = { name: clean(r.name, 120), document: clean(r.document, 60), relationship: clean(r.relationship, 60) };
                    if (!representative.name || !representative.document || !RELATIONSHIPS.includes(representative.relationship)) return res.status(400).json({ error: MSG.rep, code: 'representative', field: 'representative' });
                }
                let healthAnswer;
                if (wantsHealth && p0.healthField && body.health_answer !== undefined) healthAnswer = D.parseHealthAnswer(p0.healthField, body.health_answer, httpError);
                // The code.
                const c = codes.get(id);
                if (!c) return res.status(401).json({ error: MSG.nocode, code: 'nocode', field: 'code' });
                if (Date.now() > c.expiresAt) { codes.delete(id); return res.status(401).json({ error: MSG.codeExpired, code: 'code_expired', field: 'code' }); }
                if (c.tries >= LIMITS.codeTries) { codes.delete(id); return res.status(429).json({ error: MSG.codeBurnt, code: 'code_burnt', field: 'code' }); }
                const given = String(body.code == null ? '' : body.code).replace(/\D/g, '');
                const good = given.length === 6 && crypto.timingSafeEqual(Buffer.from(codeHash(given, c.salt)), Buffer.from(c.hash));
                if (!good) {
                    c.tries++;
                    if (c.tries >= LIMITS.codeTries) { codes.delete(id); return res.status(429).json({ error: MSG.codeBurnt, code: 'code_burnt', field: 'code' }); }
                    return res.status(401).json({ error: MSG.codeBad, code: 'code_bad', field: 'code', tries_left: LIMITS.codeTries - c.tries });
                }
                codes.delete(id); // single use
                const verifiedMs = Date.now();
                const client_key = clientOf(req), user_agent = uaOf(req, body), client_tz = clean(body.client_tz, 64) || null;
                const email = c.email || t.req.email;
                await append({ conference_id: t.ins.conference_id, inscription_id: t.ins.id, request_id: id, kind: 'otp_verified', email, client_key, user_agent, client_tz,
                    data: { otp_sent_utc: isoUtc(c.sentAt), tries: c.tries + 1 } });
                // The evidence.
                const p = await pageOf(t.req, t.ins, representative);
                const text = p.view.text;
                const policy = await policySnapshot(t.ins.conference_id, p.s);
                const ev = await append({
                    conference_id: t.ins.conference_id, inscription_id: t.ins.id, request_id: id, kind: 'granted', email,
                    client_key, user_agent, client_tz, policy_version: p.s.policy_version, policy_sha256: policy.sha256, text_sha256: sha256(text),
                    general: true, health: wantsHealth, image: wantsImage,
                    data: {
                        subject: await identityOf(t.ins, p.form),
                        verified_email: email,
                        email_source: c.typed ? 'typed_on_page' : 'on_file',
                        minor, representative,
                        policy: { url: p.s.policy_url, version: p.s.policy_version, sha256: policy.sha256, snapshot_id: policy.id },
                        text, contact: p.s.contact_email || null, responsible: p.s.responsible || null,
                        otp_sent_utc: isoUtc(c.sentAt), otp_verified_utc: isoUtc(verifiedMs),
                        health_answered: wantsHealth && healthAnswer != null,
                    },
                });
                // The single-use link is spent; the state follows the log.
                await db.run(`UPDATE ${T.consentRequests} SET token_hash = NULL, email = ?, state = 'granted', general = 1, health = ?, image = ?, granted_s = ?, revoked_s = NULL, method = 'otp', sheet_id = NULL, updated_s = ? WHERE id = ?`,
                    [email, wantsHealth ? 1 : 0, wantsImage ? 1 : 0, ev.at_s, nowS(), id]);
                // An e-mail typed on the page (2.33.3) also fills the person's e-mail field, when the form has one and it is empty.
                if (c.typed) {
                    const f = emailFieldOf(p.form);
                    if (f) await db.run(`UPDATE ${T.inscriptions} SET ${f.name} = ? WHERE id = ? AND (${f.name} IS NULL OR ${f.name} = '')`, [email, t.ins.id]);
                }
                // Health: only with its box; without it nothing is kept. What the person writes here wins over an answer
                // entered for them earlier.
                if (wantsHealth && healthAnswer !== undefined) await D.health.save(t.ins.conference_id, t.ins.id, healthAnswer);
                await settleVerbal(t.req, ev, wantsHealth, { via: 'otp' });
                if (!wantsHealth) await D.health.clearInscription(t.ins.id);
                await mailConfirmation(p.conf, email, ev);
                res.json({ state: 'granted', granted_at: ev.at_utc, choices: { general: true, health: wantsHealth, image: wantsImage } });
            } catch (e) { send(res, e); }
        });

        // ── staff ──
        // GET /consent/settings?conference_id → settings + mail readiness (settings:view).
        http.route('get', '/consent/settings', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'settings', 'view')) return;
            try {
                const cid = positiveInt(req.query.conference_id);
                if (!cid || !await conferenceOf(cid)) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                if (!await ensureReady()) return res.status(503).json({ error: MSG.unavailable });
                purgeDue().catch(() => {});
                res.json({ settings: await settingsOf(cid), defaults: { ...DEFAULTS, policy_path: DEFAULT_POLICY_PATH }, has_health_field: !!await D.health.fieldOf(cid) });
            } catch (e) { sendError(res, e); }
        });
        // PUT /consent/settings { conference_id, … } (settings:manage).
        http.route('put', '/consent/settings', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'settings', 'manage')) return;
            try {
                const cid = positiveInt((req.body || {}).conference_id);
                if (!cid || !await conferenceOf(cid)) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                if (!await ensureReady()) return res.status(503).json({ error: MSG.unavailable });
                res.json({ settings: await saveSettings(cid, req.body, httpError) });
            } catch (e) { sendError(res, e); }
        });
        // GET / PUT /consent/defaults { email_lang } — the plugin-wide default e-mail language (2.33.4): '' = the site's.
        http.route('get', '/consent/defaults', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'settings', 'view')) return;
            try {
                if (!await ensureReady()) return res.status(503).json({ error: MSG.unavailable });
                const r = await db.get(`SELECT email_lang FROM ${T.consentSettings} WHERE conference_id = ?`, [PLUGIN_ROW]);
                res.json({ email_lang: (r && mails.langOf(r.email_lang)) || '', site_lang: await siteLang(), effective: await pluginLang() });
            } catch (e) { sendError(res, e); }
        });
        http.route('put', '/consent/defaults', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'settings', 'manage')) return;
            try {
                if (!await ensureReady()) return res.status(503).json({ error: MSG.unavailable });
                const v = String(((req.body || {}).email_lang) || '').trim().toLowerCase();
                if (v && !mails.LANGS.includes(v)) return res.status(400).json({ error: 'Idioma de los correos inválido (es, en o pt).' });
                await setPluginLang(v);
                res.json({ email_lang: v, site_lang: await siteLang(), effective: await pluginLang() });
            } catch (e) { sendError(res, e); }
        });
        // POST /consent/purge { conference_id } → { purged } — runs the due purge now (settings:manage).
        http.route('post', '/consent/purge', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'settings', 'manage')) return;
            try { res.json({ purged: await purgeDue({ force: true }) }); } catch (e) { sendError(res, e); }
        });
        // GET /consent/states?conference_id → { states: { [id]: … }, enabled } (inscriptions:view).
        http.route('get', '/consent/states', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'inscriptions', 'view')) return;
            try {
                const cid = positiveInt(req.query.conference_id);
                if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
                res.json({ enabled: await isEnabled(cid), states: Object.fromEntries(await statesOf(cid, null)), no_email: await noEmailIds(cid) });
            } catch (e) { sendError(res, e); }
        });
        // GET /consent/authorization/:id → { enabled, revoked, general, health } (2.36.10: the edit form's boxes).
        http.route('get', '/consent/authorization/:id', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'inscriptions', 'view')) return;
            try {
                const id = positiveInt(req.params.id);
                const ins = id ? await db.get(`SELECT id, conference_id FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                const enabled = await isEnabled(ins.conference_id);
                res.json({ enabled, ...(enabled && await ensureReady() ? await authorizationOf(id) : { revoked: false, general: null, health: null }) });
            } catch (e) { sendError(res, e); }
        });
        // POST /consent/send { inscription_id } → the link (inscriptions:manage).
        http.route('post', '/consent/send', { auth: true }, async (req, res) => {
            const perms = await allow(req, res, 'inscriptions', 'manage');
            if (!perms) return;
            try {
                const id = positiveInt((req.body || {}).inscription_id);
                const ins = id ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                if (!await isEnabled(ins.conference_id)) return res.status(409).json({ error: 'Esta conferencia no pide la autorización de datos.' });
                if (ins.status === 'cancelled') return res.status(409).json({ error: 'La inscripción está cancelada.' });
                res.json(await issueLink(ins, { actor: actorOf(req), via: 'admin', httpError }));
            } catch (e) { sendError(res, e); }
        });
        // POST /consent/share { inscription_id } → a new link and what the message says, for «Copiar mensaje»
        // (inscriptions:manage). No e-mail leaves.
        http.route('post', '/consent/share', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'inscriptions', 'manage')) return;
            try {
                const id = positiveInt((req.body || {}).inscription_id);
                const ins = id ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [id]) : null;
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                if (!await isEnabled(ins.conference_id)) return res.status(409).json({ error: 'Esta conferencia no pide la autorización de datos.' });
                if (ins.status === 'cancelled') return res.status(409).json({ error: 'La inscripción está cancelada.' });
                res.json(await shareLink(ins, { actor: actorOf(req), via: 'admin', httpError }));
            } catch (e) { sendError(res, e); }
        });
        // POST /consent/revoke { inscription_id, general, health, image, note } — the person revoked (by mail, …):
        // a NEW row. Revoking health deletes the answers; revoking the general one revokes all (inscriptions:manage).
        http.route('post', '/consent/revoke', { auth: true }, async (req, res) => {
            if (!await allow(req, res, 'inscriptions', 'manage')) return;
            try {
                const b = req.body || {};
                const id = positiveInt(b.inscription_id);
                const r = id ? await requestOf(id) : null;
                if (!r || r.state !== 'granted') return res.status(409).json({ error: 'Esta persona no tiene una autorización vigente.' });
                const all = b.general === true;
                const health = all || b.health === true, image = all || b.image === true;
                if (!all && !health && !image) return res.status(400).json({ error: 'Marca qué autorización revoca la persona.', field: 'scope' });
                const note = clean(b.note, 500);
                if (!note) return res.status(400).json({ error: 'Escribe cómo pidió la persona la revocación (por ejemplo, «correo del 3 de noviembre»).', field: 'note' });
                const next = { general: all ? 0 : Number(r.general), health: health ? 0 : Number(r.health), image: image ? 0 : Number(r.image) };
                const ev = await append({ conference_id: r.conference_id, inscription_id: id, request_id: r.id, kind: 'revoked', email: r.email, actor: actorOf(req),
                    general: !!next.general, health: !!next.health, image: !!next.image, data: { revoked: { general: all, health, image }, note } });
                await db.run(`UPDATE ${T.consentRequests} SET state = ?, general = ?, health = ?, image = ?, revoked_s = ?, updated_s = ? WHERE id = ?`,
                    [all ? 'revoked' : 'granted', next.general, next.health, next.image, ev.at_s, nowS(), r.id]);
                if (all) await db.run(`UPDATE ${T.consentRequests} SET vgeneral_s = NULL, vgeneral_by = NULL, vgeneral_event_id = NULL WHERE id = ?`, [r.id]);
                if (health) {
                    await D.health.clearInscription(id);
                    if (r.verbal_s != null) await db.run(`UPDATE ${T.consentRequests} SET verbal_s = NULL, verbal_by = NULL, verbal_event_id = NULL WHERE id = ?`, [r.id]);
                }
                res.json({ success: true, state: all ? 'revoked' : 'granted' });
            } catch (e) { sendError(res, e); }
        });
        // GET /consent/evidence/:id → one person's whole log, chain checked (WordJS administrators only: it carries
        // the verified e-mail and the representative's document, unmasked, for a data protection authority).
        http.route('get', '/consent/evidence/:id', { auth: true, admin: true }, async (req, res) => {
            try {
                if (!req.user || req.user.role !== 'administrator') return res.status(403).json({ error: 'Solo un administrador puede exportar la evidencia.' });
                const id = positiveInt(req.params.id);
                if (!id || !await ensureReady()) return res.status(404).json({ error: 'Sin evidencia.' });
                const log = await eventsOf(id);
                if (!log.rows.length) return res.status(404).json({ error: 'No hay evidencia de autorización para esta persona.' });
                const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return s; } };
                const policiesOf = async (rows) => {
                    const hashes = [...new Set(rows.map(r => r.policy_sha256).filter(Boolean))];
                    const out = [];
                    for (const h of hashes) {
                        const pr = await db.get(`SELECT * FROM ${T.consentPolicies} WHERE conference_id = ? AND policy_sha256 = ?`, [rows[0].conference_id, h]);
                        if (pr) out.push({ id: Number(pr.id), policy_version: pr.policy_version, policy_sha256: pr.policy_sha256, created_utc: pr.created_utc, body: parse(pr.body), sha256_ok: policyHashOf(parse(pr.body) || {}) === pr.policy_sha256 });
                    }
                    return out;
                };
                const conf = await conferenceOf(log.rows[0].conference_id);
                const paperSheets = await paper.sheetsForExport(log.rows);
                await append({ conference_id: log.rows[0].conference_id, inscription_id: id, kind: 'evidence_exported', actor: actorOf(req) });
                res.json({
                    exported_utc: isoUtc(), conference: conf ? conf.name : null, inscription_id: id,
                    chain_ok: log.chain_ok, broken_at: log.broken_at,
                    network_note: 'client_key es una clave derivada (HMAC) de la dirección IP del cliente, calculada por el servidor del sitio; no es la dirección IP.',
                    events: log.rows.map(r => ({ ...r, data: parse(r.data) })),
                    // Every policy version this person signed: its exact body, to recompute its SHA-256.
                    policies: await policiesOf(log.rows),
                    // 2.34.0: the paper sheets this person signed (their exact text and every uploaded file's SHA-256).
                    paper_sheets: paperSheets,
                });
            } catch (e) { sendError(res, e); }
        });

        // Portal: POST /portal/consent/share { inscription_id } — the coordinator's «Copiar mensaje» (own location).
        http.route('post', '/portal/consent/share', async (req, res) => {
            const location = await resolvePortalLocation(req);
            if (!location) return res.status(401).json({ error: 'No token' });
            try {
                const id = positiveInt((req.body || {}).inscription_id);
                const ins = id ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND location_id = ? AND conference_id = ?`, [id, location.id, location.conference_id]) : null;
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                if (!await isEnabled(ins.conference_id)) return res.status(409).json({ error: 'Esta conferencia no pide la autorización de datos.' });
                if (ins.status === 'cancelled') return res.status(409).json({ error: 'La inscripción está cancelada.' });
                if (await isGranted(id)) return res.status(409).json({ error: 'Esta persona ya autorizó el tratamiento de sus datos.' });
                res.json(await shareLink(ins, { actor: `portal:${location.name}`, via: 'portal', httpError }));
            } catch (e) { sendError(res, e); }
        });

        // Portal: POST /portal/consent/resend { inscription_id } — the coordinator's «Reenviar enlace» (own location).
        http.route('post', '/portal/consent/resend', async (req, res) => {
            const location = await resolvePortalLocation(req);
            if (!location) return res.status(401).json({ error: 'No token' });
            try {
                const id = positiveInt((req.body || {}).inscription_id);
                const ins = id ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND location_id = ? AND conference_id = ?`, [id, location.id, location.conference_id]) : null;
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                if (!await isEnabled(ins.conference_id)) return res.status(409).json({ error: 'Esta conferencia no pide la autorización de datos.' });
                if (ins.status === 'cancelled') return res.status(409).json({ error: 'La inscripción está cancelada.' });
                if (await isGranted(id)) return res.status(409).json({ error: 'Esta persona ya autorizó el tratamiento de sus datos.' });
                const r = await issueLink(ins, { actor: `portal:${location.name}`, via: 'portal', httpError });
                res.json(r);
            } catch (e) { sendError(res, e); }
        });

        paper.install(deps);
    }

    // ── verbal health authorization (2.34.0) ──
    const VERBAL_STATEMENT = 'La persona me autorizó verbalmente el tratamiento de sus datos de salud, tras informarle que es voluntario.';
    // ── verbal authorization of the personal data (2.36.10) ──
    const VERBAL_GENERAL_STATEMENT = 'La persona me autorizó verbalmente a tratar sus datos personales para gestionar su inscripción, según la Política de Tratamiento de Datos.';
    /**
     * Staff registered the person on the strength of their verbal authorization of the personal data (the ticked
     * statement, required for every registration made by staff while the conference asks for consent). A
     * «verbal_granted» row (scope general, method 'verbal', pending written confirmation): who, when, the statement
     * and the policy version. The later written authorization (code or paper) confirms it (settleVerbal). Never a
     * second one while it waits, nor once the person authorized in writing.
     */
    async function generalVerbalEntered(ins, { actor, via }) {
        if (!await isEnabled(ins.conference_id)) return;
        let r = await requestOf(ins.id);
        if (!r) {
            try {
                await db.run(`INSERT INTO ${T.consentRequests} (conference_id, inscription_id, state, updated_s) VALUES (?, ?, 'pending', ?)`, [ins.conference_id, ins.id, nowS()]);
            } catch { /* a concurrent first link made it */ }
            r = await requestOf(ins.id);
        }
        if (!r || r.vgeneral_s != null || r.state === 'granted') return;
        const s = await settingsOf(ins.conference_id);
        const policy = await policySnapshot(ins.conference_id, s);
        const ev = await append({
            conference_id: ins.conference_id, inscription_id: ins.id, request_id: r.id, kind: 'verbal_granted', actor,
            policy_version: s.policy_version, policy_sha256: policy.sha256, text_sha256: sha256(VERBAL_GENERAL_STATEMENT), general: true,
            data: { method: 'verbal', scope: 'general', status: 'pending_written_confirmation', statement: VERBAL_GENERAL_STATEMENT,
                entered_by: actor, via, policy: { url: s.policy_url, version: s.policy_version, sha256: policy.sha256, snapshot_id: policy.id },
                subject: await identityOf(ins, await formOf(ins.conference_id)) },
        });
        await db.run(`UPDATE ${T.consentRequests} SET vgeneral_s = ?, vgeneral_by = ?, vgeneral_event_id = ?, updated_s = ? WHERE id = ?`, [ev.at_s, actor ? clean(actor, 120) : null, ev.id, nowS(), r.id]);
    }
    /**
     * Staff entered a health answer for the person (`verbal` = on the strength of their ticked verbal statement). A
     * first verbal one is a «verbal_granted» row (scope health, pending written confirmation); every entry is also
     * logged «health_entered» (who, how, whether it cleared the answer; never the answer itself).
     */
    async function healthEntered(ins, { actor, via, verbal, cleared }) {
        if (!await isEnabled(ins.conference_id)) return;
        let r = await requestOf(ins.id);
        if (!r) {
            try {
                await db.run(`INSERT INTO ${T.consentRequests} (conference_id, inscription_id, state, updated_s) VALUES (?, ?, 'pending', ?)`, [ins.conference_id, ins.id, nowS()]);
            } catch { /* a concurrent first link made it */ }
            r = await requestOf(ins.id);
        }
        if (verbal && !cleared && r.verbal_s == null && !(r.state === 'granted' && Number(r.health))) {
            const s = await settingsOf(ins.conference_id);
            const policy = await policySnapshot(ins.conference_id, s);
            const ev = await append({
                conference_id: ins.conference_id, inscription_id: ins.id, request_id: r.id, kind: 'verbal_granted', actor,
                policy_version: s.policy_version, policy_sha256: policy.sha256, text_sha256: sha256(VERBAL_STATEMENT), health: true,
                data: { method: 'verbal', scope: 'health', status: 'pending_written_confirmation', statement: VERBAL_STATEMENT,
                    entered_by: actor, via, policy: { url: s.policy_url, version: s.policy_version, sha256: policy.sha256, snapshot_id: policy.id },
                    subject: await identityOf(ins, await formOf(ins.conference_id)) },
            });
            await db.run(`UPDATE ${T.consentRequests} SET verbal_s = ?, verbal_by = ?, verbal_event_id = ?, updated_s = ? WHERE id = ?`, [ev.at_s, actor ? clean(actor, 120) : null, ev.id, nowS(), r.id]);
        }
        await append({ conference_id: ins.conference_id, inscription_id: ins.id, request_id: r.id, kind: 'health_entered', actor,
            data: { entered_by: actor, via, basis: cleared ? null : (verbal ? 'verbal' : 'written'), cleared: !!cleared } });
    }
    /**
     * A written signature (code or paper) settles a live verbal authorization: confirmed and linked when it covers
     * health, else the answer is deleted (the caller deletes it) and the deletion logged.
     */
    async function settleVerbal(req, grantedRow, healthYes, { via }) {
        const r = await requestOf(req.inscription_id);
        const grantId = grantedRow.id;
        // 2.36.10: a written signature always gives the general authorization: it confirms the verbal one.
        if (r && r.vgeneral_s != null) {
            await append({ conference_id: r.conference_id, inscription_id: r.inscription_id, request_id: r.id, kind: 'verbal_confirmed', actor: grantedRow.actor || null,
                data: { scope: 'general', verbal_event_id: r.vgeneral_event_id == null ? null : Number(r.vgeneral_event_id), confirmed_by_event_id: grantId == null ? null : Number(grantId), method: via, verbal_entered_by: r.vgeneral_by, verbal_at_utc: isoUtc(Number(r.vgeneral_s) * 1000) } });
            await db.run(`UPDATE ${T.consentRequests} SET vgeneral_s = NULL, vgeneral_by = NULL, vgeneral_event_id = NULL WHERE id = ?`, [r.id]);
        }
        if (r && r.verbal_s != null) {
            await append({ conference_id: r.conference_id, inscription_id: r.inscription_id, request_id: r.id, kind: healthYes ? 'verbal_confirmed' : 'health_deleted', actor: grantedRow.actor || null,
                data: healthYes
                    ? { verbal_event_id: r.verbal_event_id == null ? null : Number(r.verbal_event_id), confirmed_by_event_id: grantId == null ? null : Number(grantId), method: via, verbal_entered_by: r.verbal_by, verbal_at_utc: isoUtc(Number(r.verbal_s) * 1000) }
                    : { reason: 'health_not_authorized_in_writing', method: via, verbal_event_id: r.verbal_event_id == null ? null : Number(r.verbal_event_id), signed_event_id: grantId == null ? null : Number(grantId) } });
            await db.run(`UPDATE ${T.consentRequests} SET verbal_s = NULL, verbal_by = NULL, verbal_event_id = NULL WHERE id = ?`, [r.id]);
        } else if (!healthYes && r && (await D.health.answersOf([Number(r.inscription_id)])).size) {
            await append({ conference_id: r.conference_id, inscription_id: r.inscription_id, request_id: r.id, kind: 'health_deleted', actor: grantedRow.actor || null,
                data: { reason: 'health_not_authorized_in_writing', method: via, signed_event_id: grantId == null ? null : Number(grantId) } });
        }
    }

    // ── paper (2.34.0, server/consent-paper.js) ──
    /** The person signed on paper: their request becomes granted (created when they never had a link). */
    async function grantPaper(ins, prior, { health, image, at_s, sheet_id }) {
        const vals = [health ? 1 : 0, image ? 1 : 0, at_s, sheet_id, nowS()];
        const update = (id) => db.run(`UPDATE ${T.consentRequests} SET token_hash = NULL, state = 'granted', general = 1, health = ?, image = ?, granted_s = ?, revoked_s = NULL, method = 'paper', sheet_id = ?, updated_s = ? WHERE id = ?`, [...vals, id]);
        if (prior) return update(prior.id);
        try {
            await db.run(`INSERT INTO ${T.consentRequests} (conference_id, inscription_id, state, general, health, image, granted_s, method, sheet_id, updated_s) VALUES (?, ?, 'granted', 1, ?, ?, ?, 'paper', ?, ?)`,
                [ins.conference_id, ins.id, ...vals]);
        } catch (e) {
            const again = await requestOf(ins.id);
            if (!again) throw e;
            await update(again.id);
        }
    }
    /** A wrong paper tick undone: back to pending (the log row is written first by the caller). */
    async function ungrantPaper(r) {
        await db.run(`UPDATE ${T.consentRequests} SET state = 'pending', general = 0, health = 0, image = 0, granted_s = NULL, method = NULL, sheet_id = NULL, verbal_s = NULL, verbal_by = NULL, verbal_event_id = NULL, vgeneral_s = NULL, vgeneral_by = NULL, vgeneral_event_id = NULL, updated_s = ? WHERE id = ?`, [nowS(), r.id]);
    }
    const paper = createPaper({
        db, T, P, createIndex, createUniqueIndex, addColumnIfMissing, append, policySnapshot, formOf, conferenceOf, requestOf, isEnabled, ensureReady, minorByAge, settingsOf, identityOf,
        textsOf: async (cid, conf, body) => (body ? { texts: fillTexts(body, conf) } : textsOf(cid, conf)),
        grantPaper, ungrantPaper, settleVerbal, deps: () => D,
    });

    return {
        migrate, ensureReady, install, isEnabled, settingsOf, statesOf, isGranted, hasEmail, healthAllowed, healthWritten, healthRefused, healthEntered, generalVerbalEntered, authorizationOf, historyOf, issueLink, shareLink, purgeDue, eventsOf,
        VERBAL_STATEMENT, VERBAL_GENERAL_STATEMENT,
        // 2.36.3: a paper sheet's PDF, for the file ticket the badge route answers.
        paperPdf: (cid, sheetId) => paper.pdfFile(cid, sheetId),
        // 2.36.6: a person's e-mail and WhatsApp number as the consent message reads them (the badge section), and the
        // conference's e-mail language («Autorizaciones › Idioma de los correos»).
        contactOf: async (ins) => {
            const form = await formOf(ins.conference_id);
            const conf = await conferenceOf(ins.conference_id);
            const phone = await phoneOf(ins, form);
            return { email: await emailOf(ins, form), phone, phone_wa: waDigits(phone, conf && conf.phone_country) || '' };
        },
        mailLangOf,
        MSG, LIMITS,
    };
}

module.exports = { createConsent, emailFieldIn, maskEmail, shownText, rowHashOf, policyHashOf, DEFAULTS, TEXT_HEALTH_BEFORE_2_36_9, RELATIONSHIPS, LIMITS };
