/**
 * «Escarapelas» (conference-manager 2.19.0): each registrant's digital badge — a credential page reached by a
 * private link, and a PDF to print (one per page, or a Letter sheet) — with the fields, colours, background and
 * logo the administration chooses, one design per conference.
 *
 * MODEL. The design and the policy live on the conference (`conferences.badge_config`, JSON: { design, policy,
 * rev }). The static layer of the card (background colour or image, legibility panel, logo) is the PLATE: two
 * JPEGs the designer composites in the browser (`plate_print` for the PDF, `plate_screen` for the page) and
 * uploads to `badge_assets` with their sources (`background_src`, `logo_src`, so the designer can composite
 * again). Everything personal is drawn over the plate from ONE display list (server/badge-layout.js).
 *
 * LINKS. One active link per inscription (`badge_links`): a 128-bit random token, in the URL FRAGMENT
 * (/portal/conference/badge#t=…) so it never reaches a log, a Referer or a link preview. Regenerating gives a
 * new token (the old link answers 404); revoking deletes it. The link works while the inscription is not
 * cancelled, badges are enabled and the conference's expiry date (if any) has not passed — checked at view
 * time, so reactivating an inscription brings its badge back.
 *
 * FILES. A PDF is fetched through a short-lived TICKET (`badge_tickets`: 120 s, 3 uses, so an iPhone's double
 * GET works) minted by an authenticated or token-holding caller; the core portal's file route turns the
 * ticket into bytes (GET /public/badge/file). Tickets live in the database, so they work across nodes.
 *
 * PRIVACY. A badge carries the chosen fields and the person's own reg_code (the meal credential), so: staff
 * need «Escarapelas» AND «Inscripciones: ver» (the code is theirs to see); the portal only its own location's
 * people, while the conference lets coordinators share badges; the public view only what the badge shows.
 * Wrong tokens all answer the same 404, throttled per client and globally.
 *
 * SQL: own prefixed tables, a space before a closing parenthesis after a table name, no `$`, portable on
 * SQLite / Postgres / MySQL (no UPDATE reading its own table).
 */
'use strict';

const { buildBadge, zonesOf, rowsOf, LAYOUTS, DEFAULT_COLORS } = require('./badge-layout');
const crypto = require('crypto');
const { buildBadgePdf } = require('./badge-pdf');
const { normalizeDesignV2, layoutDesign, assetsOfDesign, keysOfDesign, STICKER } = require('./badge-design');
const { createMetrics, isFace } = require('./badge-font');
const { faceBytes, faceBase64, faceParsed } = require('./badge-font-files');
const { docFieldsOf } = require('./selfpage');
const phoneMod = require('./phone');
const { maskEmail } = require('./consent');
const { badgeMail } = require('./badge-mail');

const MAX_FIELDS = 8;
const LABEL_MAX = 40;
const TITLE_MAX = 80;
const ASSET_KINDS = new Set(['background_src', 'logo_src', 'plate_print', 'plate_screen']);
// 2.29.0: the free-form designer's images, one row each: kind 'img_' + the first 16 hex of their sha256 (the
// id the design's image elements use).
const IMAGE_KIND = /^img_[0-9a-f]{16}$/;
const IMAGES_MAX = 40;
const isAssetKind = (k) => ASSET_KINDS.has(k) || IMAGE_KIND.test(k);
// The server measures with every face loaded (the layout and the PDF agree with the browser's).
const METRICS = createMetrics((face) => faceParsed(face));
const ASSET_MAX_CHARS = 2 * 1024 * 1024;               // a data URL, ~1.5 MB of image
const TICKET_TTL_S = 120, TICKET_MAX_USES = 3;
const PDF_MAX_BADGES = 1000;
const LINKS_MAX = 2000;
// 2.36.6: one «Enviar» of a person's badge every 5 minutes (a double tap, a coordinator sending again by mistake).
const MAIL_GAP_S = 5 * 60;
const HEX = /^#[0-9a-f]{6}$/i;
const PANELS = new Set(['none', 'light', 'dark']);
const BUILTINS = [
    { key: '@location', label: 'Localidad' },
    { key: '@room', label: 'Habitación' },
    { key: '@dates', label: 'Fechas' },
    { key: '@conference', label: 'Conferencia' },
    // 2.32.0: the person's meal group letter (A–F, «Turnos de comida»). Only the letter: the times are in «Mi
    // inscripción», and nothing about why.
    { key: '@meal_group', label: 'Grupo de comida' },
];
const DEFAULT_DESIGN = Object.freeze({
    layout: 'horizontal', title: '', colors: { ...DEFAULT_COLORS }, panel: 'none',
    fields: [{ key: '@location', show_label: true }],
});
// 2.36.0: «Sticker para imprimir» — the label a sticker printer prints for the physical badge, designed like the
// virtual badge (server/badge-design.js, layout 'sticker'). Black on white (label printers are thermal): the name,
// the locality, the meal group letter (nothing when the person has none yet) and the QR, on 62 × 100 mm.
const DEFAULT_STICKER = Object.freeze({
    version: 2, layout: STICKER, size: { w: 62, h: 100 }, background: '#ffffff', elements: [
        { id: 's1', type: 'text', x: 3, y: 4, w: 56, h: 22, text: '{{@name}}', font: 'montserrat', bold: true, size: 20, color: '#000000', align: 'center', valign: 'middle', fit: 'shrink', lh: 1.1 },
        { id: 's2', type: 'text', x: 3, y: 27, w: 56, h: 8, text: '{{@location}}', font: 'montserrat', size: 11, color: '#000000', align: 'center', valign: 'middle', upper: true, ls: 0.5 },
        { id: 's3', type: 'text', x: 11, y: 37, w: 40, h: 33, text: '{{@meal_group}}', font: 'montserrat', bold: true, size: 72, color: '#000000', align: 'center', valign: 'middle', fit: 'shrink', name: 'Grupo de comida' },
        { id: 's4', type: 'qr', x: 19, y: 73, w: 24, h: 24, bg: false },
    ],
});
const DEFAULT_POLICY = Object.freeze({ enabled: true, portal_enabled: true, expires_on: null, country_code: '57' });
const MSG = {
    not_found: 'Escarapela no encontrada.',
    self_off: 'Este enlace ya no muestra la escarapela: ábrela en «Mi inscripción» con tu documento (el código QR de tu escarapela lleva allí).',
    inactive: 'Esta escarapela ya no está activa.',
    expired: 'Esta escarapela venció.',
    disabled: 'Las escarapelas de esta conferencia no están activas.',
    throttled: 'Demasiados intentos. Espera unos minutos.',
    no_email: 'Esta persona no tiene correo registrado.',
    mail_wait: (min) => `Ya se le envió hace poco. Espera ${min} ${min === 1 ? 'minuto' : 'minutos'} antes de enviarla otra vez.`,
    mail_off: 'El correo del sitio no está configurado (o el plugin no tiene permiso para enviar correos): pídele al administrador que lo active.',
    mail_failed: 'No se pudo enviar el correo. Inténtalo más tarde o comparte el enlace por WhatsApp.',
    ticket: 'El enlace de descarga venció. Vuelve a pedir el archivo.',
};

function createBadges(base) {
    const { db, T, P, addColumnIfMissing, createIndex, createUniqueIndex, httpError } = base;
    T.badgeAssets = `${P}badge_assets`;
    T.badgeLinks = `${P}badge_links`;
    T.badgeTickets = `${P}badge_tickets`;
    T.badgeMails = `${P}badge_mails`;
    let D = null;
    let ready = false;

    // ── schema ─────────────────────────────────────────────────────────────────────────────────────
    async function migrate() {
        await addColumnIfMissing(T.conferences, 'badge_config', 'TEXT');
        await db.createTable(T.badgeAssets, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'kind VARCHAR(32) NOT NULL',
            'sha VARCHAR(64) NOT NULL',
            'mime VARCHAR(32) NOT NULL',
            'width INT',
            'height INT',
            'data TEXT NOT NULL',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            `FOREIGN KEY (conference_id) REFERENCES ${T.conferences}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_badge_assets_kind`, T.badgeAssets, 'conference_id, kind');
        await db.createTable(T.badgeLinks, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'token VARCHAR(64) NOT NULL',
            'rev VARCHAR(16) NOT NULL',
            'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
            'created_by TEXT',
            'rotated_at DATETIME',
            'view_count INT DEFAULT 0',
            'last_viewed_at DATETIME',
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
        ]);
        await createUniqueIndex(`${P}uidx_badge_links_ins`, T.badgeLinks, 'inscription_id');
        await createUniqueIndex(`${P}uidx_badge_links_token`, T.badgeLinks, 'token');
        await createIndex(`${P}idx_badge_links_conf`, T.badgeLinks, 'conference_id');
        await db.createTable(T.badgeTickets, [
            'id INT_PK',
            'nonce VARCHAR(64) NOT NULL',
            'conference_id INT NOT NULL',
            'scope TEXT NOT NULL',
            'uses INT DEFAULT 0',
            'expires_s INT NOT NULL',
        ]);
        await createUniqueIndex(`${P}uidx_badge_tickets_nonce`, T.badgeTickets, 'nonce');
        // 2.36.6: every «Enviar» of a person's badge by e-mail (who, to which address, when, sent or why not) — the
        // audit, and the per-person pause between two e-mails.
        await db.createTable(T.badgeMails, [
            'id INT_PK',
            'conference_id INT NOT NULL',
            'inscription_id INT NOT NULL',
            'email VARCHAR(255) NOT NULL',
            'actor TEXT',
            'at_s INT NOT NULL',
            'ok INT NOT NULL',
            'error TEXT',
            `FOREIGN KEY (inscription_id) REFERENCES ${T.inscriptions}(id) ON DELETE CASCADE`,
        ]);
        await createIndex(`${P}idx_badge_mails_ins`, T.badgeMails, 'inscription_id');
        // A link whose inscription is gone (a driver without enforced foreign keys) is dead weight.
        try { await db.run(`DELETE FROM ${T.badgeLinks} WHERE inscription_id NOT IN (SELECT id FROM ${T.inscriptions} )`); } catch (e) { /* best effort */ }
        ready = true;
    }
    const ensureReady = async () => {
        if (ready) return true;
        try { await migrate(); } catch (e) { console.warn('[conference-manager] badges schema:', e && e.message); }
        return ready;
    };

    // ── config ─────────────────────────────────────────────────────────────────────────────────────
    const parseJson = (raw) => { try { const v = JSON.parse(String(raw)); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } };
    // The calling code WhatsApp links add to a national number (2.33.2): the conference's «Indicativo por defecto»
    // (Campos) once chosen, else this page's own «Código de país para WhatsApp».
    async function whatsappCodeOf(cid, cfg) {
        const c = await db.get(`SELECT phone_country FROM ${T.conferences} WHERE id = ?`, [cid]);
        return c && phoneMod.isCountry(c.phone_country) ? phoneMod.dialOf(c.phone_country) : cfg.policy.country_code;
    }
    async function configOf(cid) {
        let raw = null;
        try { const row = await db.get(`SELECT badge_config FROM ${T.conferences} WHERE id = ?`, [cid]); raw = row ? row.badge_config : null; }
        catch (e) { raw = null; }
        const stored = raw ? parseJson(raw) : null;
        return {
            configured: !!stored,
            design: normalizeDesign(stored && stored.design, null),
            sticker: normalizeSticker(stored && stored.sticker, null),
            policy: normalizePolicy(stored && stored.policy),
            rev: stored && Number.isInteger(stored.rev) ? stored.rev : 0,
        };
    }
    const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
    // A design as stored: unknown keys dropped, every value bounded. `known` (a Set of field keys) drops
    // fields the form no longer has; null keeps them (reading a stored design).
    function normalizeDesign(d, known, assetIds) {
        // 2.29.0: a free-form design (server/badge-design.js) — its own model, bounded there.
        if (d && typeof d === 'object' && d.version === 2) return normalizeDesignV2(d, { assets: assetIds || null });
        const src = d && typeof d === 'object' ? d : {};
        const colors = {};
        for (const k of Object.keys(DEFAULT_COLORS)) {
            const v = src.colors && src.colors[k];
            colors[k] = typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : DEFAULT_COLORS[k];
        }
        const fields = [];
        const seen = new Set();
        for (const f of Array.isArray(src.fields) ? src.fields : (d ? [] : DEFAULT_DESIGN.fields)) {
            const key = f && typeof f.key === 'string' ? f.key : '';
            if (!key || seen.has(key) || (known && !known.has(key)) || fields.length >= MAX_FIELDS) continue;
            seen.add(key);
            const label = clip(f.label, LABEL_MAX);
            fields.push({ key, show_label: f.show_label !== false, ...(label ? { label } : {}) });
        }
        return {
            layout: LAYOUTS.includes(src.layout) ? src.layout : DEFAULT_DESIGN.layout,
            title: clip(src.title, TITLE_MAX),
            colors,
            panel: PANELS.has(src.panel) ? src.panel : 'none',
            fields,
        };
    }
    /** The sticker design (2.36.0): a free-form design with layout 'sticker' and its size; the default until saved. */
    function normalizeSticker(d, assetIds) {
        const src = d && typeof d === 'object' && d.version === 2 ? d : DEFAULT_STICKER;
        return normalizeDesignV2({ ...src, layout: STICKER }, { assets: assetIds || null });
    }
    const isBareDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    function normalizePolicy(p) {
        const src = p && typeof p === 'object' ? p : {};
        const cc = String(src.country_code == null ? DEFAULT_POLICY.country_code : src.country_code).replace(/\D/g, '').slice(0, 4);
        // «Mi inscripción» (2.23.0, server/selfpage.js): on unless turned off; the document fields chosen (null =
        // detected by their label). A field name is a plain column name — the routes check it against the form.
        const sp = src.self_page && typeof src.self_page === 'object' ? src.self_page : {};
        const fieldName = (v) => (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v) ? v : null);
        return {
            enabled: src.enabled !== false,
            portal_enabled: src.portal_enabled !== false,
            expires_on: isBareDate(src.expires_on) && !Number.isNaN(Date.parse(src.expires_on)) ? src.expires_on : null,
            country_code: cc || DEFAULT_POLICY.country_code,
            self_page: { enabled: sp.enabled !== false, type_field: fieldName(sp.type_field), number_field: fieldName(sp.number_field) },
        };
    }
    // The end of the expiry day: a bare date covers the WHOLE day wherever the event is — the link works until
    // that day has ended everywhere (midnight at UTC−12), so a server on UTC never cuts the closing dinner short.
    const expiresAtMs = (policy) => {
        if (!policy.expires_on) return null;
        const [y, m, d] = policy.expires_on.split('-').map(Number);
        return Date.UTC(y, m - 1, d + 1, 12);
    };
    async function availableFields(cid) {
        const rows = await db.all(`SELECT name, label, type, role, is_unique FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]);
        const nameRoles = new Set(['first_name', 'last_name']);
        return [
            ...BUILTINS.map(b => ({ key: b.key, label: b.label, builtin: true })),
            ...rows.filter(f => D.isFieldColumn(f.name) && !nameRoles.has(f.role) && !nameRoles.has(f.name)).map(f => ({
                key: f.name, label: f.label || f.name, builtin: false, type: f.type || 'text',
                // Contact fields carry a warning in the designer: whoever has the link sees them.
                sensitive: f.role === 'email' || f.role === 'phone' || f.type === 'email' || f.type === 'tel' || f.name === 'document_number' || !!Number(f.is_unique),
            })),
        ];
    }
    async function assetsOf(cid, withData) {
        const rows = await db.all(`SELECT kind, sha, mime, width, height${withData ? ', data' : ''} FROM ${T.badgeAssets} WHERE conference_id = ?`, [cid]);
        const map = new Map();
        for (const r of rows) map.set(r.kind, r);
        return map;
    }

    // ── one badge ──────────────────────────────────────────────────────────────────────────────────
    const DAY = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    // 'YYYY-MM-DD' of a stored date: a string as stored, or a Date (Postgres TIMESTAMP through the bridge;
    // node-postgres reads a timestamp without time zone as LOCAL time, so its local day is the stored day).
    const dayOf = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
        const s = String(v).slice(0, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };
    const datesOf = (conf) => {
        const da = dayOf(conf.date_start), db_ = dayOf(conf.date_end);
        const a = da ? Date.parse(da) : NaN;
        const b = db_ ? Date.parse(db_) : NaN;
        if (Number.isNaN(a) && Number.isNaN(b)) return null;
        if (Number.isNaN(b) || a === b) return DAY.format(new Date(Number.isNaN(a) ? b : a));
        if (Number.isNaN(a)) return DAY.format(new Date(b));
        return `${DAY.format(new Date(a))} – ${DAY.format(new Date(b))}`;
    };
    // The design + data of one inscription's badge, and its display list.
    async function badgeFor(ins, conf, cfg, assets, labels, sample = false) {
        if (cfg.design.version === 2) return badgeForV2(ins, conf, cfg, assets, labels, sample);
        const loc = ins.location_id != null ? await db.get(`SELECT name FROM ${T.locations} WHERE id = ?`, [ins.location_id]) : null;
        let room = null;
        if ((cfg.design.fields || []).some(f => f.key === '@room') && ins.room_id != null) {
            room = await db.get(`SELECT r.room_number, h.name AS hotel_name FROM ${T.rooms} r LEFT JOIN ${T.hotels} h ON h.id = r.hotel_id WHERE r.id = ?`, [ins.room_id]);
        }
        const lines = [];
        for (const f of cfg.design.fields) {
            let value = null;
            switch (f.key) {
                case '@location': value = loc ? loc.name : (sample ? 'Localidad' : null); break;
                case '@room': value = room ? [room.hotel_name, room.room_number].filter(Boolean).join(' · ') : (sample ? 'Hotel · 101' : null); break;
                case '@dates': value = datesOf(conf) || (sample ? '12 – 14 oct 2026' : null); break;
                case '@conference': value = conf.name; break;
                case '@meal_group': value = (D.mealGroupOf ? await D.mealGroupOf(conf.id, ins.id) : null) || (sample ? 'C' : null); break;
                default: value = D.isFieldColumn(f.key) && ins[f.key] != null ? String(ins[f.key]) : (sample ? (labels.get(f.key) || f.key) : null);
            }
            if (value == null || !String(value).trim()) continue;
            lines.push({ label: f.show_label ? (f.label || labels.get(f.key) || f.key) : null, value: String(value).trim() });
        }
        const name = (await D.personWithName(ins)).name || '';
        const plate = assets.get('plate_print');
        const design = { ...cfg.design, has_logo: assets.has('logo_src'), plate: plate ? { sha: plate.sha } : null };
        // The QR carries the link to «Mi inscripción» with the code (2.23.0), or the bare code when that page is
        // off or the site address is unknown — the meal scanner reads either.
        const code = ins.reg_code || '';
        const qr = code && D.qrText ? await D.qrText(code, conf.id, cfg) : code;
        return buildBadge(design, { title: cfg.design.title || conf.name, name, lines, code, qr });
    }
    // 2.29.0: a free-form design — the person's values for the tokens its texts use, then the shared layout.
    const SAMPLE = { '@name': 'María Fernanda Gómez', '@location': 'Localidad', '@room': 'Hotel Central · 204', '@code': 'ABCD2345EF', '@meal_group': 'C' };
    async function badgeForV2(ins, conf, cfg, assets, labels, sample) {
        const keys = new Set(keysOfDesign(cfg.design));
        const data = {};
        const name = (await D.personWithName(ins)).name || '';
        data['@name'] = sample ? SAMPLE['@name'] : name;
        data['@code'] = ins.reg_code || (sample ? SAMPLE['@code'] : '');
        data['@conference'] = conf.name || '';
        if (keys.has('@dates')) data['@dates'] = datesOf(conf) || (sample ? '12 – 14 oct 2026' : '');
        if (keys.has('@location')) {
            const loc = ins.location_id != null ? await db.get(`SELECT name FROM ${T.locations} WHERE id = ?`, [ins.location_id]) : null;
            data['@location'] = loc ? loc.name : (sample ? SAMPLE['@location'] : '');
        }
        if (keys.has('@room')) {
            const room = ins.room_id != null ? await db.get(`SELECT r.room_number, h.name AS hotel_name FROM ${T.rooms} r LEFT JOIN ${T.hotels} h ON h.id = r.hotel_id WHERE r.id = ?`, [ins.room_id]) : null;
            data['@room'] = room ? [room.hotel_name, room.room_number].filter(Boolean).join(' · ') : (sample ? SAMPLE['@room'] : '');
        }
        if (keys.has('@meal_group')) data['@meal_group'] = sample ? SAMPLE['@meal_group'] : ((D.mealGroupOf ? await D.mealGroupOf(conf.id, ins.id) : null) || '');
        for (const k of keys) {
            if (k.startsWith('@') || !D.isFieldColumn(k)) continue;
            data[k] = ins[k] != null && String(ins[k]).trim() ? String(ins[k]) : (sample ? (labels.get(k) || k) : '');
        }
        const images = {};
        for (const id of assetsOfDesign(cfg.design)) {
            const a = assets.get(`img_${id}`);
            if (a) images[id] = { w: Number(a.width) || 0, h: Number(a.height) || 0 };
        }
        const code = ins.reg_code || '';
        const qr = code && D.qrText ? await D.qrText(code, conf.id, cfg) : (code || data['@code']);
        return layoutDesign(cfg.design, { data, qr, metrics: METRICS, images });
    }
    /** The data URLs of a v2 badge's images (for the page and the designer to draw them): id → data URL. */
    async function imagesOf(cid, badge) {
        const out = {};
        for (const id of (badge && badge.images) || []) {
            const row = await db.get(`SELECT data FROM ${T.badgeAssets} WHERE conference_id = ? AND kind = ?`, [cid, `img_${id}`]);
            if (row && row.data) out[id] = row.data;
        }
        return out;
    }
    // «Mi inscripción» (server/selfpage.js): the person's own badge for the page, or null while the badges are
    // off or not designed yet; and a PDF ticket for it.
    async function selfBadge(ins, conf, cfg) {
        if (!cfg.configured || !cfg.policy.enabled) return null;
        const assets = await assetsOf(Number(conf.id), false);
        const badge = await badgeFor(ins, conf, cfg, assets, await labelsOf(Number(conf.id)));
        if (badge.version === 2) return { badge, plate: null, images: await imagesOf(Number(conf.id), badge) };
        const plate = assets.has('plate_screen')
            ? (await db.get(`SELECT data FROM ${T.badgeAssets} WHERE conference_id = ? AND kind = ?`, [conf.id, 'plate_screen']) || {}).data || null
            : null;
        return { badge, plate };
    }
    async function selfTicket(ins, cfg) {
        if (!cfg.configured || !cfg.policy.enabled) return null;
        return mintTicket(Number(ins.conference_id), { ids: [Number(ins.id)], sheet: 'single', name: null });
    }
    async function labelsOf(cid) {
        return new Map((await availableFields(cid)).map(f => [f.key, f.label]));
    }
    // The display lists of several inscriptions of one conference (the PDF), plus the plate bytes.
    async function badgesFor(cid, ids, { sticker = false } = {}) {
        const conf = await db.get(`SELECT id, name, date_start, date_end FROM ${T.conferences} WHERE id = ?`, [cid]);
        if (!conf) throw httpError(404, 'Conferencia no encontrada.');
        const cfg = await configOf(cid);
        if (sticker) cfg.design = cfg.sticker;
        const assets = await assetsOf(cid, true);
        const labels = await labelsOf(cid);
        const list = [];
        for (let i = 0; i < ids.length; i += 400) {
            const chunk = ids.slice(i, i + 400);
            const rows = await db.all(`SELECT * FROM ${T.inscriptions} WHERE conference_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`, [cid, ...chunk]);
            const byId = new Map(rows.map(r => [Number(r.id), r]));
            for (const id of chunk) {
                const ins = byId.get(Number(id));
                if (ins && ins.status !== 'cancelled') list.push(await badgeFor(ins, conf, cfg, assets, labels));
            }
        }
        const plates = new Map();
        const plate = assets.get('plate_print');
        if (plate) plates.set(plate.sha, dataUrlBytes(plate.data));
        // 2.29.0: the free-form design's images, by id.
        const images = new Map();
        for (const b of list) for (const id of b.images || []) {
            if (images.has(id)) continue;
            const a = assets.get(`img_${id}`);
            if (a) images.set(id, { bytes: dataUrlBytes(a.data) });
        }
        return { conf, list, plates, images };
    }
    const dataUrlBytes = (url) => {
        const m = /^data:[^;]+;base64,(.*)$/.exec(String(url || ''));
        return m ? Buffer.from(m[1], 'base64') : null;
    };

    // ── links ──────────────────────────────────────────────────────────────────────────────────────
    const newToken = async () => String(await D.randomToken(16));
    const newRev = async () => String(await D.randomToken(4)).slice(0, 8);
    // Create the missing links of `ids` (inscriptions of `cid`, not cancelled); return every link of them.
    async function ensureLinks(cid, ids, actor) {
        const out = new Map();
        for (let i = 0; i < ids.length; i += 400) {
            const chunk = ids.slice(i, i + 400);
            const marks = chunk.map(() => '?').join(', ');
            for (const l of await db.all(`SELECT inscription_id, token, rev, created_at, view_count, last_viewed_at FROM ${T.badgeLinks} WHERE conference_id = ? AND inscription_id IN (${marks})`, [cid, ...chunk])) out.set(Number(l.inscription_id), l);
            const missing = (await db.all(`SELECT id FROM ${T.inscriptions} WHERE conference_id = ? AND id IN (${marks}) AND (status IS NULL OR status <> 'cancelled')`, [cid, ...chunk]))
                .map(r => Number(r.id)).filter(id => !out.has(id));
            for (const id of missing) {
                const token = await newToken(), rev = await newRev();
                try {
                    await db.run(`INSERT INTO ${T.badgeLinks} (conference_id, inscription_id, token, rev, created_by) VALUES (?, ?, ?, ?, ?)`, [cid, id, token, rev, actor || null]);
                } catch (e) { /* another request created it meanwhile (UNIQUE): read it below */ }
                const l = await db.get(`SELECT inscription_id, token, rev, created_at, view_count, last_viewed_at FROM ${T.badgeLinks} WHERE inscription_id = ?`, [id]);
                if (l) out.set(id, l);
            }
        }
        return withSelf(cid, ids.map(id => out.get(Number(id))).filter(Boolean).map(linkOut));
    }
    const linkOut = (l) => ({ inscription_id: Number(l.inscription_id), token: l.token, created_at: l.created_at || null, view_count: Number(l.view_count) || 0, last_viewed_at: l.last_viewed_at || null });

    // Why a link does not show a badge right now (null = it does).
    async function linkState(token) {
        if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return { code: 'not_found' };
        const link = await db.get(`SELECT id, conference_id, inscription_id, rev FROM ${T.badgeLinks} WHERE token = ?`, [token]);
        if (!link) return { code: 'not_found' };
        const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND conference_id = ?`, [link.inscription_id, link.conference_id]);
        if (!ins) return { code: 'not_found' };
        const cfg = await configOf(link.conference_id);
        if (!cfg.policy.enabled) return { code: 'disabled' };
        if (ins.status === 'cancelled') return { code: 'inactive' };
        const exp = expiresAtMs(cfg.policy);
        if (exp != null && Date.now() >= exp) return { code: 'expired' };
        return { code: null, link, ins, cfg };
    }

    // ── tickets ────────────────────────────────────────────────────────────────────────────────────
    async function mintTicket(cid, scope) {
        const now = Math.floor(Date.now() / 1000);
        try { await db.run(`DELETE FROM ${T.badgeTickets} WHERE expires_s < ?`, [now]); } catch (e) { /* best effort */ }
        const nonce = String(await D.randomToken(16));
        await db.run(`INSERT INTO ${T.badgeTickets} (nonce, conference_id, scope, uses, expires_s) VALUES (?, ?, ?, 0, ?)`, [nonce, cid, JSON.stringify(scope), now + TICKET_TTL_S]);
        return nonce;
    }
    async function useTicket(nonce) {
        if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return null;
        const t = await db.get(`SELECT id, conference_id, scope, uses, expires_s FROM ${T.badgeTickets} WHERE nonce = ?`, [nonce]);
        if (!t || Number(t.expires_s) < Math.floor(Date.now() / 1000)) return null;
        const r = await db.run(`UPDATE ${T.badgeTickets} SET uses = uses + 1 WHERE id = ? AND uses < ?`, [t.id, TICKET_MAX_USES]);
        if (!r || !r.changes) return null;
        const scope = parseJson(t.scope);
        return scope ? { conference_id: Number(t.conference_id), scope } : null;
    }
    // 2.36.3: other files through the same ticket and the same public route (the portal has ONE file route): a
    // provider per `kind` answers { mime, filename, b64 } for a ticket's scope, or null when the file is gone.
    const fileProviders = new Map();
    const fileProvider = (kind, fn) => { fileProviders.set(String(kind), fn); };
    const fileTicket = (cid, scope) => mintTicket(Number(cid), { ...scope, kind: String(scope.kind) });
    // 'sticker' (2.36.0): the printable sticker's design, one label per page at the label's exact size.
    const sheetOf = (v) => (v === 'letter' ? 'letter' : v === 'sticker' ? 'sticker' : 'single');
    const pdfName = (base) => `${String(base || 'escarapela').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'escarapela'}.pdf`;

    // ── public throttle ────────────────────────────────────────────────────────────────────────────
    // Only MISSES count and only misses are refused: a token that exists is always served, so a venue's shared
    // Wi-Fi (one client key for hundreds of people) or someone else's guessing never locks a holder out. With
    // 128-bit tokens the throttle only slows a guesser down; it never decides who sees a badge.
    const WINDOW_MS = 10 * 60 * 1000, PER_CLIENT = 20, GLOBAL = 300;
    const failures = new Map();       // clientKey -> { n, first }
    let globalFail = { n: 0, first: 0 };
    const throttled = (key) => {
        const now = Date.now();
        if (now - globalFail.first < WINDOW_MS && globalFail.n >= GLOBAL) return true;
        const f = failures.get(key);
        return !!(f && now - f.first < WINDOW_MS && f.n >= PER_CLIENT);
    };
    const noteFailure = (key) => {
        const now = Date.now();
        if (now - globalFail.first >= WINDOW_MS) globalFail = { n: 0, first: now };
        globalFail.n++;
        const f = failures.get(key);
        if (!f || now - f.first >= WINDOW_MS) failures.set(key, { n: 1, first: now }); else f.n++;
        if (failures.size > 5000) failures.clear();
    };
    const clientOf = (req) => String((req && (req.clientKey || req.ip)) || 'anon');
    // The link a public call names, or an answer already sent (null): 404 for a miss (429 once this client
    // — or everybody — has missed too often), 410 for a link that exists but shows nothing right now.
    /**
     * 2.28.0: a link never shows the badge (nor its PDF) to whoever holds it — it carried no check at all. While the
     * conference's «Mi inscripción» page works (on, with a document field to ask), the link sends the person there
     * — `/portal/conference/yo#c=` + their code — where the badge shows only after they confirm their document.
     * null = that page is off or has no document to ask: the link then shows nothing.
     */
    async function selfUsable(cid, cfg) {
        if (!cfg.policy.self_page.enabled) return false;
        const form = await db.all(`SELECT name, label, type, options, is_unique FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]);
        return !!docFieldsOf(form, cfg.policy.self_page, D.isFieldColumn).number;
    }
    const SELF_PATH = '/portal/conference/yo#c=';
    async function selfPageOf(st) {
        if (!st.ins.reg_code || !await selfUsable(Number(st.link.conference_id), st.cfg)) return null;
        return `${SELF_PATH}${st.ins.reg_code}`;
    }
    /**
     * The links as the admin and the coordinators share them: each with `self`, the «Mi inscripción» address
     * (path) of that person, so what is opened, copied and sent is that page itself; null while the page is off.
     */
    /**
     * 2.36.13: each link with `email_masked` — where «Enviar por correo» would go («» = no e-mail on file: the action is
     * hidden). Only for callers that see inscriptions (the links routes check it).
     */
    async function withEmail(cid, links) {
        if (!links.length || !D.emailsOf) return links;
        const rows = [];
        const ids = links.map(l => l.inscription_id);
        for (let i = 0; i < ids.length; i += 400) {
            const chunk = ids.slice(i, i + 400);
            rows.push(...await db.all(`SELECT * FROM ${T.inscriptions} WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk));
        }
        const emails = await D.emailsOf(cid, rows);
        return links.map(l => ({ ...l, email_masked: emails.get(l.inscription_id) ? maskEmail(emails.get(l.inscription_id)) : '' }));
    }

    /**
     * The badge e-mail to one person (2.36.6, the portal's «Enviar»; 2.36.13 also the admin's «Enviar por correo»): the
     * person's badge link and how to use it, through «Plantillas de correo» (badge.link), in the conference's e-mail
     * language. With an e-mail on file (400 no_email); one e-mail per person every MAIL_GAP_S whoever sends it (429
     * mail_wait, with retry_in). Every attempt — sent or not — is a row of badge_mails with its actor (the audit). The
     * site's mail missing or not granted is a 503 mail_off, a provider failure a 502 mail_failed: never a silent «sent».
     * → { status, body }.
     */
    async function sendBadgeMail(ins, actor) {
        const cid = Number(ins.conference_id);
        const { email } = await D.contactOf(ins);
        if (!email) return { status: 400, body: { error: MSG.no_email, code: 'no_email' } };
        const now = Math.floor(Date.now() / 1000);
        const last = await db.get(`SELECT MAX(at_s) AS at_s FROM ${T.badgeMails} WHERE inscription_id = ? AND ok = 1`, [ins.id]);
        const wait = last && last.at_s != null ? Number(last.at_s) + MAIL_GAP_S - now : 0;
        if (wait > 0) return { status: 429, body: { error: MSG.mail_wait(Math.ceil(wait / 60)), code: 'mail_wait', retry_in: wait } };
        const [link] = await ensureLinks(cid, [Number(ins.id)], actor);
        const base = await D.siteLinkBase();
        if (!link || !base) return { status: 503, body: { error: MSG.mail_off, code: 'mail_off' } };
        const url = link.self ? `${base}${link.self}` : `${base}/portal/conference/badge#t=${link.token}`;
        const conf = await db.get(`SELECT id, name FROM ${T.conferences} WHERE id = ?`, [cid]);
        const name = String((await D.personWithName(ins)).name || '').split(' ')[0] || '';
        const log = (ok, error) => db.run(`INSERT INTO ${T.badgeMails} (conference_id, inscription_id, email, actor, at_s, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [cid, ins.id, email, actor ? String(actor).slice(0, 120) : null, now, ok ? 1 : 0, error ? String(error).slice(0, 300) : null]);
        try {
            // 2.36.11: through «Plantillas de correo» (the stored edit), else the default.
            const lang = await D.mailLangOf(cid);
            const vals = { conference: conf ? conf.name : '', name };
            const msg = D.mailTemplates ? await D.mailTemplates.render('badge.link', lang, vals, { action: { url } }) : badgeMail(lang, { ...vals, link: url });
            await D.mail({ to: email, ...msg });
        } catch (e) {
            const why = String(e && e.message || e);
            await log(false, why);
            const off = /permission|denied|not available|not granted|permiso/i.test(why);
            return { status: off ? 503 : 502, body: { error: off ? MSG.mail_off : MSG.mail_failed, code: off ? 'mail_off' : 'mail_failed' } };
        }
        await log(true, null);
        return { status: 200, body: { sent: true, email_masked: maskEmail(email) } };
    }

    async function withSelf(cid, links) {
        if (!links.length) return links;
        const usable = await selfUsable(cid, await configOf(cid));
        const codes = new Map();
        if (usable) {
            const ids = links.map(l => l.inscription_id);
            for (let i = 0; i < ids.length; i += 400) {
                const chunk = ids.slice(i, i + 400);
                for (const r of await db.all(`SELECT id, reg_code FROM ${T.inscriptions} WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk)) codes.set(Number(r.id), r.reg_code);
            }
        }
        return links.map(l => ({ ...l, self: usable && codes.get(l.inscription_id) ? `${SELF_PATH}${codes.get(l.inscription_id)}` : null }));
    }

    async function publicLink(req, res) {
        const key = clientOf(req);
        const st = await linkState((req.body || {}).token);
        if (st.code === 'not_found') {
            if (throttled(key)) { res.status(429).json({ error: MSG.throttled, code: 'throttled' }); return null; }
            noteFailure(key);
            res.status(404).json({ error: MSG.not_found, code: 'not_found' });
            return null;
        }
        if (st.code) { res.status(410).json({ error: MSG[st.code] || MSG.not_found, code: st.code }); return null; }
        return st;
    }

    // ── portal feature flag ────────────────────────────────────────────────────────────────────────
    async function portalFeatures(location) {
        try {
            if (!ready || !location) return {};
            const cfg = await configOf(location.conference_id);
            return cfg.configured && cfg.policy.enabled && cfg.policy.portal_enabled ? { features: { badges: 1 } } : {};
        } catch (e) { return {}; }
    }

    // ── routes ─────────────────────────────────────────────────────────────────────────────────────
    function install(deps) {
        D = deps;
        const { http, allow, positiveInt } = deps;
        const AUTH = { auth: true };
        const send = (res, e) => res.status(e && e.status ? e.status : 500).json({ error: e && e.message ? e.message : String(e) });
        // Staff gate: the section's level AND inscriptions:view when the answer carries codes or links.
        const gate = async (req, res, level, withCodes) => {
            const perms = await allow(req, res, 'badges', level);
            if (!perms) return false;
            if (withCodes && !D.hasLevel(perms, 'inscriptions', 'view')) { res.status(403).json({ error: 'Necesitas permiso para ver inscripciones.' }); return false; }
            if (!await ensureReady()) { res.status(503).json({ error: 'Las escarapelas no están disponibles todavía.' }); return false; }
            return perms;
        };
        const confOf = async (cid) => (cid ? db.get(`SELECT id, name, date_start, date_end FROM ${T.conferences} WHERE id = ?`, [cid]) : null);

        // GET /badges/config?conference_id → { config, available_fields, assets, zones }
        http.route('get', '/badges/config', AUTH, async (req, res) => {
            if (!await gate(req, res, 'view', false)) return;
            try {
                const cid = positiveInt(req.query.conference_id);
                if (!await confOf(cid)) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const assets = await assetsOf(cid, false);
                const config = await configOf(cid);
                // «Mi inscripción»: the form fields to choose the document from, those in use (chosen or detected),
                // and the link the QR carries (null = the site address is not readable: the QR keeps the bare code).
                const form = (await db.all(`SELECT name, label, type, options, is_unique FROM ${T.fields} WHERE conference_id = ? ORDER BY sort_order ASC, id ASC`, [cid]))
                    .filter(f => D.isFieldColumn(f.name));
                const doc = docFieldsOf(form, config.policy.self_page, D.isFieldColumn);
                res.json({
                    config,
                    self_page: {
                        fields: form.map(f => ({ name: f.name, label: f.label || f.name, type: f.type || 'text' })),
                        type_field: doc.type ? doc.type.name : null,
                        number_field: doc.number ? doc.number.name : null,
                        link: D.qrText ? await D.qrText('ABCDEFGHJK', cid, config) : null,
                    },
                    available_fields: await availableFields(cid),
                    assets: [...assets.values()].map(a => ({ kind: a.kind, sha: a.sha, width: a.width, height: a.height })),
                    zones: { horizontal: zonesOf('horizontal'), vertical: zonesOf('vertical') },
                    max_rows: { horizontal: rowsOf('horizontal'), vertical: rowsOf('vertical') },
                    limits: { fields: MAX_FIELDS, label: LABEL_MAX, title: TITLE_MAX, asset_chars: ASSET_MAX_CHARS },
                });
            } catch (e) { send(res, e); }
        });
        // PUT /badges/config { conference_id, design, policy } — badges:manage.
        http.route('put', '/badges/config', AUTH, async (req, res) => {
            if (!await gate(req, res, 'manage', false)) return;
            try {
                const body = req.body || {};
                const cid = positiveInt(body.conference_id);
                if (!await confOf(cid)) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const known = new Set((await availableFields(cid)).map(f => f.key));
                const cur = await configOf(cid);
                const assetIds = new Set([...(await assetsOf(cid, false)).keys()].filter(k => IMAGE_KIND.test(k)).map(k => k.slice(4)));
                const next = {
                    design: normalizeDesign(body.design || cur.design, known, assetIds),
                    sticker: normalizeSticker(body.sticker || cur.sticker, assetIds),
                    policy: normalizePolicy(body.policy || cur.policy),
                    rev: cur.rev + 1,
                };
                await db.run(`UPDATE ${T.conferences} SET badge_config = ? WHERE id = ?`, [JSON.stringify(next), cid]);
                res.json({ success: true, config: { configured: true, ...next } });
            } catch (e) { send(res, e); }
        });
        // GET /badges/assets/:kind?conference_id → { data_url } (the designer composites again from the sources).
        http.route('get', '/badges/assets/:kind', AUTH, async (req, res) => {
            if (!await gate(req, res, 'view', false)) return;
            try {
                const cid = positiveInt(req.query.conference_id);
                const kind = String(req.params.kind || '');
                if (!cid || !isAssetKind(kind)) return res.status(404).json({ error: 'Imagen no encontrada.' });
                const a = await db.get(`SELECT data, width, height, sha FROM ${T.badgeAssets} WHERE conference_id = ? AND kind = ?`, [cid, kind]);
                if (!a) return res.status(404).json({ error: 'Imagen no encontrada.' });
                res.json({ data_url: a.data, width: a.width, height: a.height, sha: a.sha });
            } catch (e) { send(res, e); }
        });
        // PUT /badges/assets { conference_id, kind, data_url, width, height } — badges:manage.
        http.route('put', '/badges/assets', AUTH, async (req, res) => {
            if (!await gate(req, res, 'manage', false)) return;
            try {
                const body = req.body || {};
                const cid = positiveInt(body.conference_id);
                const kind = String(body.kind || '');
                if (!await confOf(cid)) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                // 2.29.0: kind 'image' = one of the free-form designer's images (its row's kind comes from its sha).
                if (!ASSET_KINDS.has(kind) && kind !== 'image') return res.status(400).json({ error: 'Tipo de imagen desconocido.' });
                const url = String(body.data_url || '');
                if (url.length > ASSET_MAX_CHARS) return res.status(413).json({ error: 'La imagen es demasiado grande (máximo 1,5 MB).' });
                const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(url);
                if (!m) return res.status(400).json({ error: 'La imagen debe ser JPEG o PNG.' });
                const bytes = Buffer.from(m[2], 'base64');
                const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
                const isPng = bytes.length > 8 && bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
                if (!(m[1] === 'image/jpeg' ? isJpeg : isPng)) return res.status(400).json({ error: 'El archivo no es una imagen válida.' });
                // The plates are what the PDF embeds: JPEG only (DCTDecode).
                if ((kind === 'plate_print' || kind === 'plate_screen') && !isJpeg) return res.status(400).json({ error: 'La plantilla debe ser JPEG.' });
                const width = positiveInt(body.width), height = positiveInt(body.height);
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                if (kind === 'image') {
                    if (!width || !height) return res.status(400).json({ error: 'Falta el tamaño de la imagen.' });
                    const id = sha.slice(0, 16), rowKind = `img_${id}`;
                    const have = await db.get(`SELECT COUNT(*) AS n FROM ${T.badgeAssets} WHERE conference_id = ? AND kind LIKE ?`, [cid, 'img_%']);
                    const exists = await db.get(`SELECT id FROM ${T.badgeAssets} WHERE conference_id = ? AND kind = ?`, [cid, rowKind]);
                    if (!exists && have && Number(have.n) >= IMAGES_MAX) return res.status(409).json({ error: `Máximo ${IMAGES_MAX} imágenes por conferencia: borra alguna de la galería.` });
                    if (!exists) {
                        await db.run(`INSERT INTO ${T.badgeAssets} (conference_id, kind, sha, mime, width, height, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [cid, rowKind, sha, m[1], width, height, url]);
                    }
                    return res.json({ success: true, kind: rowKind, sha, id, width, height });
                }
                await db.run(`DELETE FROM ${T.badgeAssets} WHERE conference_id = ? AND kind = ?`, [cid, kind]);
                await db.run(`INSERT INTO ${T.badgeAssets} (conference_id, kind, sha, mime, width, height, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [cid, kind, sha, m[1], width || null, height || null, url]);
                res.json({ success: true, kind, sha });
            } catch (e) { send(res, e); }
        });
        // DELETE /badges/assets?conference_id&kind — badges:manage.
        http.route('delete', '/badges/assets', AUTH, async (req, res) => {
            if (!await gate(req, res, 'manage', false)) return;
            try {
                const cid = positiveInt(req.query.conference_id);
                const kind = String(req.query.kind || '');
                if (!cid || !isAssetKind(kind)) return res.status(400).json({ error: 'Tipo de imagen desconocido.' });
                // An image the saved design draws stays (the designer removes it from the design first).
                if (IMAGE_KIND.test(kind)) {
                    const cfg = await configOf(cid);
                    if (cfg.design.version === 2 && assetsOfDesign(cfg.design).includes(kind.slice(4))) return res.status(409).json({ error: 'La escarapela guardada usa esta imagen: quítala del diseño y guarda primero.' });
                }
                await db.run(`DELETE FROM ${T.badgeAssets} WHERE conference_id = ? AND kind = ?`, [cid, kind]);
                res.json({ success: true });
            } catch (e) { send(res, e); }
        });
        // POST /badges/preview { conference_id, design?, inscription_id?, target? } → { badge, plate_screen? }: the
        // designer's preview with the design being edited, for a chosen inscription or a sample person.
        // target 'sticker' (2.36.0): the printable sticker's design instead of the virtual badge's.
        http.route('post', '/badges/preview', AUTH, async (req, res) => {
            const perms = await gate(req, res, 'view', false);
            if (!perms) return;
            try {
                const body = req.body || {};
                const cid = positiveInt(body.conference_id);
                const conf = await confOf(cid);
                if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const known = new Set((await availableFields(cid)).map(f => f.key));
                const cfg = await configOf(cid);
                const sticker = body.target === 'sticker';
                if (sticker) cfg.design = cfg.sticker;
                if (body.design) {
                    const assetIds = new Set([...(await assetsOf(cid, false)).keys()].filter(k => IMAGE_KIND.test(k)).map(k => k.slice(4)));
                    cfg.design = sticker ? normalizeSticker(body.design, assetIds) : normalizeDesign(body.design, known, assetIds);
                }
                const assets = await assetsOf(cid, false);
                const labels = await labelsOf(cid);
                const iid = positiveInt(body.inscription_id);
                // A real person's badge carries their code: inscriptions:view (the sample has a fake one).
                let ins = null;
                if (iid && D.hasLevel(perms, 'inscriptions', 'view')) ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND conference_id = ?`, [iid, cid]);
                const sample = !ins;
                if (!ins) ins = { id: 0, first_name: 'Nombre', last_name: 'Apellido', location_id: null, reg_code: 'ABC234', status: 'active' };
                const badge = await badgeFor(ins, conf, cfg, assets, labels, sample);
                // 2.29.0: a free-form badge comes with its images unless the designer already has them.
                res.json(badge.version === 2 && !body.no_images ? { badge, images: await imagesOf(cid, badge) } : { badge });
            } catch (e) { send(res, e); }
        });
        // GET /badges/links?conference_id&location_id? → the existing links.
        http.route('get', '/badges/links', AUTH, async (req, res) => {
            if (!await gate(req, res, 'view', true)) return;
            try {
                const cid = positiveInt(req.query.conference_id);
                if (!cid) return res.status(400).json({ error: 'Missing conference_id' });
                const lid = positiveInt(req.query.location_id);
                const rows = await db.all(
                    `SELECT l.inscription_id, l.token, l.rev, l.created_at, l.view_count, l.last_viewed_at FROM ${T.badgeLinks} l JOIN ${T.inscriptions} i ON i.id = l.inscription_id
                     WHERE l.conference_id = ?${lid ? ' AND i.location_id = ?' : ''} ORDER BY l.inscription_id`, lid ? [cid, lid] : [cid]);
                res.json({ links: await withEmail(cid, await withSelf(cid, rows.map(linkOut))) });
            } catch (e) { send(res, e); }
        });
        // POST /badges/links { conference_id, inscription_ids? | location_id? | all? } → create the missing ones.
        http.route('post', '/badges/links', AUTH, async (req, res) => {
            if (!await gate(req, res, 'view', true)) return;
            try {
                const body = req.body || {};
                const cid = positiveInt(body.conference_id);
                if (!await confOf(cid)) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const ids = await idsOf(cid, body, LINKS_MAX);
                if (ids.length > LINKS_MAX) return res.status(400).json({ error: `Máximo ${LINKS_MAX} enlaces a la vez.` });
                // `state`: why the links show nothing right now (badges off, expired), so the admin never sends a dead link unknowingly.
                const cfg = await configOf(cid);
                const exp = expiresAtMs(cfg.policy);
                const state = !cfg.policy.enabled ? 'disabled' : exp != null && Date.now() >= exp ? 'expired' : null;
                res.json({ links: await withEmail(cid, await ensureLinks(cid, ids, D.actorOf(req))), state, country_code: await whatsappCodeOf(cid, cfg) });
            } catch (e) { send(res, e); }
        });
        // POST /badges/links/:iid/rotate — a new token (the old link stops working). badges:manage.
        http.route('post', '/badges/links/:iid/rotate', AUTH, async (req, res) => {
            if (!await gate(req, res, 'manage', true)) return;
            try {
                const iid = positiveInt(req.params.iid);
                const ins = iid ? await db.get(`SELECT id, conference_id, status FROM ${T.inscriptions} WHERE id = ?`, [iid]) : null;
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                const token = await newToken(), rev = await newRev();
                const r = await db.run(`UPDATE ${T.badgeLinks} SET token = ?, rev = ?, rotated_at = CURRENT_TIMESTAMP, view_count = 0, last_viewed_at = NULL WHERE inscription_id = ?`, [token, rev, iid]);
                if (!r || !r.changes) {
                    const made = await ensureLinks(Number(ins.conference_id), [iid], D.actorOf(req));
                    return res.json({ link: made[0] || null });
                }
                const l = await db.get(`SELECT inscription_id, token, rev, created_at, view_count, last_viewed_at FROM ${T.badgeLinks} WHERE inscription_id = ?`, [iid]);
                res.json({ link: l ? (await withEmail(Number(ins.conference_id), await withSelf(Number(ins.conference_id), [linkOut(l)])))[0] : null });
            } catch (e) { send(res, e); }
        });
        // POST /badges/links/:iid/email → { sent: true, email_masked } (2.36.13): «Enviar por correo» from the admin's badge
        // actions — the same e-mail, template, per-person pause and audit as the portal's «Enviar» (sendBadgeMail), as
        // whoever may share the badge (Escarapelas › ver, with the inscriptions). A cancelled registration has no badge.
        http.route('post', '/badges/links/:iid/email', AUTH, async (req, res) => {
            if (!await gate(req, res, 'view', true)) return;
            try {
                const iid = positiveInt(req.params.iid);
                const ins = iid ? await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ? AND (status IS NULL OR status <> 'cancelled')`, [iid]) : null;
                if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                const r = await sendBadgeMail(ins, D.actorOf(req));
                res.status(r.status).json(r.body);
            } catch (e) { send(res, e); }
        });
        // DELETE /badges/links/:iid — revoke. badges:manage.
        http.route('delete', '/badges/links/:iid', AUTH, async (req, res) => {
            if (!await gate(req, res, 'manage', false)) return;
            try {
                const iid = positiveInt(req.params.iid);
                if (!iid) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                await db.run(`DELETE FROM ${T.badgeLinks} WHERE inscription_id = ?`, [iid]);
                res.json({ success: true });
            } catch (e) { send(res, e); }
        });
        // POST /badges/ticket { conference_id, inscription_id? | inscription_ids? | location_id? | all?, sheet } → { d }.
        http.route('post', '/badges/ticket', AUTH, async (req, res) => {
            if (!await gate(req, res, 'view', true)) return;
            try {
                const body = req.body || {};
                const cid = positiveInt(body.conference_id);
                const conf = await confOf(cid);
                if (!conf) return res.status(404).json({ error: 'Conferencia no encontrada.' });
                const ids = await idsOf(cid, body, PDF_MAX_BADGES);
                if (!ids.length) return res.status(400).json({ error: 'No hay escarapelas para generar.' });
                if (ids.length > PDF_MAX_BADGES) return res.status(400).json({ error: `Máximo ${PDF_MAX_BADGES} escarapelas por PDF.` });
                const name = ids.length === 1 ? null : (body.location_id ? (await db.get(`SELECT name FROM ${T.locations} WHERE id = ?`, [positiveInt(body.location_id)]) || {}).name : conf.name);
                res.json({ d: await mintTicket(cid, { ids, sheet: sheetOf(body.sheet), name: name || null }) });
            } catch (e) { send(res, e); }
        });

        // The inscriptions a staff bulk call names: explicit ids, a location's, or the whole conference's
        // (never cancelled ones), within the conference.
        async function idsOf(cid, body, cap) {
            const one = positiveInt(body.inscription_id);
            if (one) return [one];
            if (Array.isArray(body.inscription_ids)) return [...new Set(body.inscription_ids.map(positiveInt).filter(Boolean))].slice(0, cap + 1);
            const lid = positiveInt(body.location_id);
            if (!lid && body.all !== true) return [];
            const rows = await db.all(
                `SELECT id FROM ${T.inscriptions} WHERE conference_id = ?${lid ? ' AND location_id = ?' : ''} AND (status IS NULL OR status <> 'cancelled') ORDER BY last_name, first_name, id`,
                lid ? [cid, lid] : [cid]);
            return rows.map(r => Number(r.id));
        }

        // ── portal (the coordinator's own location, while the conference lets coordinators share) ──
        const portalGate = async (req, res) => {
            const location = await D.resolvePortalLocation(req);
            if (!location) { res.status(401).json({ error: 'No token' }); return null; }
            if (!await ensureReady()) { res.status(503).json({ error: 'Las escarapelas no están disponibles todavía.' }); return null; }
            const cfg = await configOf(location.conference_id);
            if (!cfg.configured || !cfg.policy.enabled || !cfg.policy.portal_enabled) { res.status(403).json({ error: MSG.disabled, code: 'disabled' }); return null; }
            return location;
        };
        const ownIds = async (location, body) => {
            const one = positiveInt(body && body.inscription_id);
            const rows = await db.all(
                `SELECT id FROM ${T.inscriptions} WHERE conference_id = ? AND location_id = ? AND (status IS NULL OR status <> 'cancelled')${one ? ' AND id = ?' : ''} ORDER BY last_name, first_name, id`,
                one ? [location.conference_id, location.id, one] : [location.conference_id, location.id]);
            return rows.map(r => Number(r.id));
        };
        // POST /portal/badges/link { inscription_id } → { link }.
        http.route('post', '/portal/badges/link', async (req, res) => {
            const location = await portalGate(req, res);
            if (!location) return;
            try {
                const ids = await ownIds(location, req.body || {});
                if (!ids.length || !positiveInt((req.body || {}).inscription_id)) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                const [link] = await ensureLinks(location.conference_id, ids, `portal:${location.id}`);
                const conf = await confOf(location.conference_id);
                // 2.36.6: what the section offers — WhatsApp with the number as the consent message builds it, «Enviar»
                // only with an e-mail on file (masked: the coordinator sees where it goes, not the whole address).
                const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [ids[0]]);
                const contact = await D.contactOf(ins);
                res.json({
                    link: link || null, country_code: await whatsappCodeOf(location.conference_id, await configOf(location.conference_id)), conference: conf ? conf.name : '',
                    phone_wa: contact.phone_wa || '', email_masked: contact.email ? maskEmail(contact.email) : '',
                });
            } catch (e) { send(res, e); }
        });
        // POST /portal/badges/email { inscription_id } → { sent: true, email_masked } (2.36.6): the person's badge link and
        // how to use it, by e-mail, in the conference's e-mail language. Only a person of the coordinator's own location
        // (404 otherwise), with an e-mail on file (400 no_email); one e-mail per person every MAIL_GAP_S (429 mail_wait,
        // with retry_in). Every attempt — sent or not — is a row of badge_mails (the audit). The site's mail missing or
        // not granted is a 503 mail_off, a provider failure a 502 mail_failed: never a silent «sent».
        http.route('post', '/portal/badges/email', async (req, res) => {
            const location = await portalGate(req, res);
            if (!location) return;
            try {
                const ids = await ownIds(location, req.body || {});
                if (!ids.length || !positiveInt((req.body || {}).inscription_id)) return res.status(404).json({ error: 'Inscripción no encontrada.' });
                const ins = await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [ids[0]]);
                const r = await sendBadgeMail(ins, `portal:${location.id}`);
                res.status(r.status).json(r.body);
            } catch (e) { send(res, e); }
        });

        // ── public (the token holder) ──
        // POST /public/badge/view { token } → { self } | 404 | 410. 2.28.0: never the badge — only where the person
        // confirms their document (selfPageOf); with «Mi inscripción» off, the link leads nowhere (410 self_off).
        http.route('post', '/public/badge/view', async (req, res) => {
            if (!await ensureReady()) return res.status(503).json({ error: 'Las escarapelas no están disponibles todavía.' });
            await (async () => {
                try {
                    const st = await publicLink(req, res);
                    if (!st) return;
                    const self = await selfPageOf(st);
                    if (!self) return res.status(410).json({ error: MSG.self_off, code: 'self_off' });
                    try { await db.run(`UPDATE ${T.badgeLinks} SET view_count = view_count + 1, last_viewed_at = CURRENT_TIMESTAMP WHERE id = ?`, [st.link.id]); } catch (e) { /* counting is best effort */ }
                    res.json({ self });
                } catch (e) { send(res, e); }
            })();
        });
        // POST /public/badge/ticket { token } → 410 always (2.28.0): a link no longer gives the PDF; «Mi inscripción»
        // does, after the document.
        http.route('post', '/public/badge/ticket', async (req, res) => {
            res.status(410).json({ error: MSG.self_off, code: 'self_off' });
        });
        // GET /public/badge/font?f=<face> → { face, b64 } — one of the shipped typefaces (SIL OFL, fonts/README.md),
        // for the designer and the credential pages to draw a badge exactly as its PDF prints it. Public: the files
        // are the plugin's own, the same for everyone.
        http.route('get', '/public/badge/font', async (req, res) => {
            const face = String((req.query || {}).f || '');
            if (!isFace(face)) return res.status(404).json({ error: 'Fuente desconocida.' });
            const b64 = faceBase64(face);
            if (!b64) return res.status(404).json({ error: 'Fuente desconocida.' });
            try { res.set({ 'Cache-Control': 'public, max-age=86400' }); } catch (e) { /* a bridge without headers */ }
            res.json({ face, b64 });
        });
        // GET /public/badge/file?d= → { mime, filename, b64 } — for the core portal's file route, which
        // answers the bytes. The ticket is the only credential (128 random bits, 120 s, 3 uses), so no per-client
        // throttle here: every call comes from the portal's server, one client for everybody.
        http.route('get', '/public/badge/file', async (req, res) => {
            if (!await ensureReady()) return res.status(503).json({ error: 'Las escarapelas no están disponibles todavía.' });
            await (async () => {
                try {
                    const t = await useTicket(String((req.query || {}).d || ''));
                    if (!t) return res.status(410).json({ error: MSG.ticket, code: 'ticket' });
                    if (t.scope.kind) {
                        const provide = fileProviders.get(String(t.scope.kind));
                        const file = provide ? await provide(t) : null;
                        if (!file) return res.status(410).json({ error: MSG.ticket, code: 'ticket' });
                        return res.json(file);
                    }
                    const sticker = t.scope.sheet === 'sticker';
                    const { list, plates, images, conf } = await badgesFor(t.conference_id, (t.scope.ids || []).map(Number).filter(Boolean), { sticker });
                    if (!list.length) return res.status(410).json({ error: MSG.inactive, code: 'inactive' });
                    // A sticker sheet is one label per page, each page exactly the label's size.
                    const pdf = buildBadgePdf({ badges: list, plates, images, fontBytes: faceBytes, sheet: sticker ? 'single' : t.scope.sheet, title: conf.name });
                    const one = list.length === 1 && t.scope.ids.length === 1
                        ? (await D.personWithName(await db.get(`SELECT * FROM ${T.inscriptions} WHERE id = ?`, [t.scope.ids[0]]))).name : null;
                    res.json({ mime: 'application/pdf', filename: pdfName(sticker ? (one ? `Sticker ${one}` : `Stickers ${t.scope.name || conf.name}`) : one ? `Escarapela ${one}` : `Escarapelas ${t.scope.name || conf.name}`), b64: pdf.toString('base64') });
                } catch (e) { send(res, e); }
            })();
        });
    }

    return { migrate, ensureReady, install, portalFeatures, fileTicket, fileProvider, configOf, expiresAtMs, selfBadge, selfTicket, availableFields, MSG };
}

module.exports = { createBadges };
