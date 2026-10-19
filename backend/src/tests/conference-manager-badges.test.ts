/**
 * conference-manager 2.19.0 — «Escarapelas»: each registrant's digital badge, a credential page reached by a
 * private link and a PDF to print, with the fields, colours, background and logo the administration chooses.
 *
 * The site owner asked for badges «con los campos que yo escoja y fondo», a download link to send to each
 * registrant, and a button in the admin's person sheet and in the coordinators' portal. Their decisions: the
 * link expires on a date the admin picks per conference; coordinators may share their people's badges while a
 * per-conference switch allows it (on by default); a cancelled inscription's badge stops working and comes
 * back on reactivation; CR80 card size; one design per conference. Pinned against the REAL plugin:
 *   - the design is validated and bounded (unknown fields, bad colours, long titles), the policy too;
 *   - images: JPEG/PNG only by their bytes, plates JPEG only, size-capped;
 *   - links: one per inscription, a 128-bit token; the public view answers 404 for any wrong token (throttled),
 *     410 for a cancelled inscription (back when reactivated), past the expiry date, or with badges off;
 *     regenerating kills the old link, revoking deletes it;
 *   - files: a short-lived ticket (3 uses) turns into a real PDF — one badge, or a Letter sheet of a location;
 *   - permissions: the design needs «Escarapelas: administrar»; links and files need «Escarapelas: ver» AND
 *     «Inscripciones: ver» (a badge carries the meal code); the portal reaches only its own location's people,
 *     and only while the conference lets coordinators share badges; the portal advertises the feature.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { bootPlugin, PLUGIN_DIR, type HarnessUser, type Plugin } from './fixtures/conference-manager-harness';

const T = (n: string) => `wjp_conference_manager_${n}`;
const TEAM_ROLE = 'conference_manager_team';
const DESIGNER: HarnessUser = { id: 30, role: TEAM_ROLE, userLogin: 'designer', userEmail: 'd@example.test', displayName: 'Designer' };
const VIEWER: HarnessUser = { id: 31, role: TEAM_ROLE, userLogin: 'viewer', userEmail: 'v@example.test', displayName: 'Viewer' };
const NOCODES: HarnessUser = { id: 32, role: TEAM_ROLE, userLogin: 'nocodes', userEmail: 'n@example.test', displayName: 'No codes' };
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

// A minimal JPEG header (SOF0, 2×2, 3 components) and a PNG signature: what the byte checks look at.
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

async function portal(p: Plugin, method: string, url: string, token: string, body?: any) {
    for (const r of p.routes) {
        if (r.method !== method) continue;
        const a = r.path.split('/'), b = url.split('?')[0].split('/');
        if (a.length !== b.length) continue;
        const params: Record<string, string> = {};
        if (!a.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = b[i]), true) : seg === b[i]))) continue;
        const res: any = {
            statusCode: 200, _body: undefined,
            status(c: number) { this.statusCode = c; return this; },
            json(x: any) { this._body = JSON.parse(JSON.stringify(x)); return this; },
            cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; },
        };
        await r.handler({ params, query: {}, body: body || {}, headers: { 'x-portal-token': token }, cookies: {}, user: null }, res);
        return { status: res.statusCode, body: res._body };
    }
    throw new Error(`no portal route ${method} ${url}`);
}
const pub = (p: Plugin, method: string, url: string, body?: any) => p.call(method, url, { anonymous: true, body });

let seq = 0;
async function world() {
    const p = await bootPlugin({ users: [DESIGNER, VIEWER, NOCODES] });
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso Nacional de Jóvenes', slug: `badges-${++seq}` } })).id as number;
    for (const template of ['first_name', 'last_name']) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }), template);
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 50 } })).id as number;
    const sur = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Sur', capacity: 50 } })).id as number;
    const person = async (first_name: string, last_name: string, location_id: number) =>
        ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name, last_name, location_id } }), first_name).id as number;
    const ana = await person('Ana', 'Pérez', norte), beto = await person('Beto', 'Núñez', norte), carla = await person('Carla', 'Ríos', sur);
    const role = async (name: string, permissions: any) => ok(await p.call('post', '/staff/roles', { body: { name, permissions } })).id as number;
    const member = async (u: HarnessUser, roleId: number) => ok(await p.call('post', '/staff/members', { body: { user_id: u.id, role_id: roleId } }), u.userLogin);
    await member(DESIGNER, await role('Diseño', { badges: 'manage', inscriptions: 'view' }));
    await member(VIEWER, await role('Entrega', { badges: 'view', inscriptions: 'view' }));
    await member(NOCODES, await role('Sin códigos', { badges: 'view' }));
    const codeOf = (id: number) => p.one(`SELECT reg_code FROM ${T('inscriptions')} WHERE id = ?`, id).reg_code as string;
    const tokenOf = async (location_id: number) => {
        const code = p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, location_id).code;
        return ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id, code } })).token as string;
    };
    return { p, cid, norte, sur, ana, beto, carla, codeOf, tokenOf };
}
type W = Awaited<ReturnType<typeof world>>;
const linkFor = async (w: W, iid: number, user?: HarnessUser) => ok(await w.p.call('post', '/badges/links', { user, body: { conference_id: w.cid, inscription_ids: [iid] } }), 'link').links[0];
const view = (w: W, token: string) => pub(w.p, 'post', '/public/badge/view', { token });
const texts = (badge: any) => badge.items.filter((i: any) => i.t === 'text').map((i: any) => i.text);

test('the design is validated and bounded; only «Escarapelas: administrar» changes it', async () => {
    const w = await world();
    const { p } = w;
    const cfg0 = ok(await p.call('get', `/badges/config?conference_id=${w.cid}`)).config;
    assert.strictEqual(cfg0.configured, false);
    assert.deepStrictEqual(cfg0.design.fields, [{ key: '@location', show_label: true }]);

    const saved = ok(await p.call('put', '/badges/config', { user: DESIGNER, body: { conference_id: w.cid,
        design: { layout: 'vertical', title: 'x'.repeat(200), colors: { background: '#0F766E', text: 'red', accent: '#facc15' }, panel: 'weird',
            fields: [{ key: '@location' }, { key: 'nope' }, { key: '@location' }, { key: '@dates', show_label: false, label: 'Cuándo' }] },
        policy: { portal_enabled: false, expires_on: '2026-13-40', country_code: '+57 (Col)' } } }), 'save').config;
    assert.strictEqual(saved.design.layout, 'vertical');
    assert.strictEqual(saved.design.title.length, 80);
    assert.deepStrictEqual(saved.design.colors, { background: '#0f766e', text: '#ffffff', label: '#bfdbfe', accent: '#facc15' });
    assert.strictEqual(saved.design.panel, 'none');
    assert.deepStrictEqual(saved.design.fields, [{ key: '@location', show_label: true }, { key: '@dates', show_label: false, label: 'Cuándo' }]);
    assert.deepStrictEqual(saved.policy, { enabled: true, portal_enabled: false, expires_on: null, country_code: '57', self_page: { enabled: true, type_field: null, number_field: null } });
    assert.strictEqual(saved.rev, 1);

    assert.strictEqual((await p.call('put', '/badges/config', { user: VIEWER, body: { conference_id: w.cid, design: {} } })).status, 403);
    assert.strictEqual((await p.call('get', `/badges/config?conference_id=${w.cid}`, { user: VIEWER })).status, 200);
});

test('images: JPEG / PNG by their bytes, the plates JPEG only, size-capped', async () => {
    const w = await world();
    const { p } = w;
    const put = (kind: string, data_url: string, user?: HarnessUser) => p.call('put', '/badges/assets', { user, body: { conference_id: w.cid, kind, data_url, width: 2, height: 2 } });
    ok(await put('plate_print', dataUrl('image/jpeg', JPEG)), 'plate');
    ok(await put('logo_src', dataUrl('image/png', PNG)), 'logo png');
    assert.strictEqual((await put('plate_screen', dataUrl('image/png', PNG))).status, 400, 'a plate is JPEG');
    assert.strictEqual((await put('logo_src', dataUrl('image/png', JPEG))).status, 400, 'the bytes must match the type');
    assert.strictEqual((await put('logo_src', 'data:image/svg+xml;base64,PHN2Zz4=')).status, 400);
    assert.strictEqual((await put('anything', dataUrl('image/jpeg', JPEG))).status, 400);
    assert.strictEqual((await put('background_src', 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024 + 10))).status, 413);
    assert.strictEqual((await put('logo_src', dataUrl('image/png', PNG), VIEWER)).status, 403);
    const cfg = ok(await p.call('get', `/badges/config?conference_id=${w.cid}`));
    assert.deepStrictEqual(cfg.assets.map((a: any) => a.kind).sort(), ['logo_src', 'plate_print']);
    // The preview draws the plate and leaves room for the logo.
    const prev = ok(await p.call('post', '/badges/preview', { body: { conference_id: w.cid, inscription_id: w.ana } })).badge;
    assert.ok(prev.plate && prev.plate.sha);
    assert.ok(texts(prev).includes('Ana Pérez'));
});

test('links: the public view shows the badge; wrong tokens 404 (throttled), cancelled / expired / disabled 410', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: { fields: [{ key: '@location', show_label: true }] } } }));
    const link = await linkFor(w, w.ana, VIEWER);
    assert.match(link.token, /^[0-9a-f]{32}$/);
    assert.strictEqual((await linkFor(w, w.ana)).token, link.token, 'one link per inscription');

    const v = ok(await view(w, link.token), 'view');
    assert.strictEqual(v.name, 'Ana Pérez');
    assert.strictEqual(v.code, w.codeOf(w.ana));
    assert.deepStrictEqual(texts(v.badge).slice(0, 4), ['Congreso Nacional de Jóvenes', 'Ana Pérez', 'LOCALIDAD', 'Norte']);
    // 2.22.0: the code is a QR; 2.23.0: it carries the «Mi inscripción» link (a bigger symbol than the bare code's 21×21).
    assert.ok(v.badge.items.some((i: any) => i.t === 'qr' && i.size > 21 && i.rows.length === i.size && i.rows.every((r: string) => r.length === i.size && /^[01]+$/.test(r))));
    assert.strictEqual(p.one(`SELECT view_count FROM ${T('badge_links')} WHERE inscription_id = ?`, w.ana).view_count, 1);

    // Cancelled → 410, and back on reactivation.
    ok(await p.call('put', `/inscriptions/${w.ana}`, { body: { status: 'cancelled' } }), 'cancel');
    const gone = await view(w, link.token);
    assert.deepStrictEqual([gone.status, gone.body.code], [410, 'inactive']);
    ok(await p.call('put', `/inscriptions/${w.ana}`, { body: { status: 'active' } }), 'reactivate');
    ok(await view(w, link.token), 'back');

    // The expiry date: through that whole day, gone the day after.
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, policy: { expires_on: iso(new Date()) } } }));
    ok(await view(w, link.token), 'still today');
    // The chosen day lasts until it has ended everywhere (UTC−12): two days ago is over in every zone.
    const y = new Date(); y.setDate(y.getDate() - 2);
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, policy: { expires_on: iso(y) } } }));
    assert.strictEqual((await view(w, link.token)).body.code, 'expired');
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, policy: { enabled: false } } }));
    assert.strictEqual((await view(w, link.token)).body.code, 'disabled');
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, policy: { enabled: true } } }));

    // Regenerate (manage) kills the old link; revoke deletes it.
    assert.strictEqual((await p.call('post', `/badges/links/${w.ana}/rotate`, { user: VIEWER })).status, 403);
    const fresh = ok(await p.call('post', `/badges/links/${w.ana}/rotate`, { user: DESIGNER })).link;
    assert.notStrictEqual(fresh.token, link.token);
    assert.strictEqual((await view(w, link.token)).status, 404);
    ok(await view(w, fresh.token), 'new link');
    ok(await p.call('delete', `/badges/links/${w.ana}`, { user: DESIGNER }));
    assert.strictEqual((await view(w, fresh.token)).status, 404);

    // Wrong tokens: the same 404, then 429 once a client keeps guessing.
    for (const bad of ['', 'x', '0'.repeat(32), 'Z'.repeat(32)]) assert.strictEqual((await view(w, bad)).status, 404, bad);
    let last: number | string = 0;
    for (let i = 0; i < 25; i++) last = (await view(w, i.toString(16).padStart(32, 'a'))).status;
    assert.strictEqual(last, 429);
    // …and a link that exists is still served to that very client (a venue's shared Wi-Fi is one client):
    // only misses are ever refused.
    const again = await linkFor(w, w.ana);
    ok(await view(w, again.token), 'a real link after the misses');
});

test('links and files need «Inscripciones: ver» too (a badge carries the meal code)', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: {} } }));
    assert.strictEqual((await p.call('post', '/badges/links', { user: NOCODES, body: { conference_id: w.cid, inscription_ids: [w.ana] } })).status, 403);
    assert.strictEqual((await p.call('post', '/badges/ticket', { user: NOCODES, body: { conference_id: w.cid, inscription_id: w.ana } })).status, 403);
    assert.strictEqual((await p.call('get', `/badges/links?conference_id=${w.cid}`, { user: NOCODES })).status, 403);
    // The preview of a real person without inscriptions:view falls back to the sample (no real code).
    const prev = ok(await p.call('post', '/badges/preview', { user: NOCODES, body: { conference_id: w.cid, inscription_id: w.ana } })).badge;
    assert.ok(!JSON.stringify(prev).includes(w.codeOf(w.ana)));
});

test('files: a ticket (120 s, 3 uses) turns into a real PDF — one badge, or a Letter sheet of a location', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: {} } }));
    ok(await p.call('put', '/badges/assets', { body: { conference_id: w.cid, kind: 'plate_print', data_url: dataUrl('image/jpeg', JPEG), width: 2, height: 2 } }));
    const link = await linkFor(w, w.beto);
    const d = ok(await pub(p, 'post', '/public/badge/ticket', { token: link.token })).d;
    const file = async (nonce: string) => p.call('get', `/public/badge/file?d=${nonce}`, { anonymous: true });
    const f1 = ok(await file(d), 'file');
    assert.strictEqual(f1.mime, 'application/pdf');
    assert.strictEqual(f1.filename, 'Escarapela-Beto-Nunez.pdf');
    const pdf = Buffer.from(f1.b64, 'base64').toString('latin1');
    assert.ok(pdf.startsWith('%PDF-1.4'));
    assert.strictEqual((pdf.match(/\/Type \/Page\b/g) || []).length, 1);
    assert.strictEqual((pdf.match(/\/Subtype \/Image/g) || []).length, 1, 'the plate, once');
    ok(await file(d)); ok(await file(d));
    assert.strictEqual((await file(d)).status, 410, 'a 4th use');
    assert.strictEqual((await file('f'.repeat(32))).status, 410);

    // A location's sheet: one page holds 8 horizontal cards; the plate still once.
    for (let i = 0; i < 8; i++) ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: `P${i}`, last_name: 'X', location_id: w.norte } }));
    const sheet = ok(await p.call('post', '/badges/ticket', { user: VIEWER, body: { conference_id: w.cid, location_id: w.norte, sheet: 'letter' } })).d;
    const f2 = ok(await file(sheet), 'sheet');
    const pdf2 = Buffer.from(f2.b64, 'base64').toString('latin1');
    assert.strictEqual((pdf2.match(/\/Type \/Page\b/g) || []).length, 2, '10 badges → 8 + 2');
    assert.strictEqual((pdf2.match(/\/Subtype \/Image/g) || []).length, 1);
    assert.strictEqual(f2.filename, 'Escarapelas-Norte.pdf');
    // A cancelled person is left out of a sheet.
    ok(await p.call('put', `/inscriptions/${w.ana}`, { body: { status: 'cancelled' } }));
    const s2 = ok(await p.call('post', '/badges/ticket', { body: { conference_id: w.cid, location_id: w.norte, sheet: 'single' } })).d;
    assert.strictEqual((Buffer.from(ok(await file(s2)).b64, 'base64').toString('latin1').match(/\/Type \/Page\b/g) || []).length, 9);
});

test('the portal: only its own people, only while coordinators may share; /portal/me advertises it', async () => {
    const w = await world();
    const { p } = w;
    const tn = await w.tokenOf(w.norte);
    // No design yet: no feature, and the portal routes refuse.
    assert.ok(!(ok(await portal(p, 'get', '/portal/me', tn)).features || {}).badges);
    assert.strictEqual((await portal(p, 'post', '/portal/badges/link', tn, { inscription_id: w.ana })).status, 403);
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: {} } }));
    const me = ok(await portal(p, 'get', '/portal/me', tn));
    assert.strictEqual(me.features.badges, 1);
    assert.strictEqual(me.features.fee_payments, 1, 'the two flags merge');

    const link = ok(await portal(p, 'post', '/portal/badges/link', tn, { inscription_id: w.ana })).link;
    ok(await view(w, link.token), 'the coordinator\'s link works');
    assert.strictEqual((await portal(p, 'post', '/portal/badges/link', tn, { inscription_id: w.carla })).status, 404, 'Sur\'s person');
    const all = ok(await portal(p, 'post', '/portal/badges/links', tn)).links;
    assert.deepStrictEqual(all.map((l: any) => l.inscription_id).sort(), [w.ana, w.beto].sort());
    const d = ok(await portal(p, 'post', '/portal/badges/ticket', tn, { sheet: 'letter' })).d;
    assert.strictEqual(ok(await p.call('get', `/public/badge/file?d=${d}`, { anonymous: true })).filename, 'Escarapelas-Norte.pdf');
    assert.strictEqual((await portal(p, 'post', '/portal/badges/ticket', tn, { inscription_id: w.carla })).status, 404);

    // The switch off: the portal stops; the admin still can.
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, policy: { portal_enabled: false } } }));
    assert.strictEqual((await portal(p, 'post', '/portal/badges/link', tn, { inscription_id: w.ana })).status, 403);
    assert.ok(!(ok(await portal(p, 'get', '/portal/me', tn)).features || {}).badges);
    assert.ok((await linkFor(w, w.ana)).token, 'the admin still can');
});

test('the designer sees what fits: rows per orientation, and a sample with a value for every chosen field', async () => {
    const w = await world();
    const { p } = w;
    const cfg = ok(await p.call('get', `/badges/config?conference_id=${w.cid}`));
    assert.deepStrictEqual(cfg.max_rows, { horizontal: 3, vertical: 6 });
    const design = { layout: 'horizontal', fields: [{ key: '@location', show_label: true }, { key: '@room', show_label: true }, { key: '@dates', show_label: false }, { key: '@conference', show_label: true }] };
    const prev = ok(await p.call('post', '/badges/preview', { body: { conference_id: w.cid, design } })).badge;
    const t = texts(prev);
    assert.ok(t.includes('Localidad') && t.includes('Hotel · 101') && t.includes('12 – 14 oct 2026'), JSON.stringify(t));
    assert.ok(!t.includes('CONFERENCIA'), 'a 4th row does not fit a landscape card');
});

test('a badge shows the live location: none once the location is deleted', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: { fields: [{ key: '@location', show_label: true }] } } }));
    const link = await linkFor(w, w.carla);
    assert.ok(texts(ok(await view(w, link.token)).badge).includes('Sur'));
    ok(await p.call('delete', `/locations/${w.sur}`), 'delete Sur');
    const after = texts(ok(await view(w, link.token)).badge);
    assert.ok(!after.includes('Sur') && !after.includes('LOCALIDAD'), JSON.stringify(after));
});

test('links come with their state: badges off or expired say so, so a dead link is never sent unknowingly', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: {}, policy: { enabled: false, country_code: '593' } } }));
    const r = ok(await p.call('post', '/badges/links', { body: { conference_id: w.cid, inscription_ids: [w.ana] } }));
    assert.deepStrictEqual([r.state, r.country_code], ['disabled', '593']);
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, policy: { enabled: true, expires_on: '2020-01-01' } } }));
    assert.strictEqual(ok(await p.call('post', '/badges/links', { body: { conference_id: w.cid, inscription_ids: [w.ana] } })).state, 'expired');
    // Another conference's person: no link of theirs comes back.
    const other = ok(await p.call('post', '/create', { body: { name: 'Otro', slug: `otro-${Date.now()}` } })).id;
    const theirs = await linkFor(w, w.beto);
    const crossed = ok(await p.call('post', '/badges/links', { body: { conference_id: other, inscription_ids: [w.beto] } })).links;
    assert.ok(!crossed.some((l: any) => l.token === theirs.token));
});

// ── «Mi inscripción» (2.23.0): the badge's QR opens the person's own page behind their identity document ──

/** The text a display list's QR carries, decoded by jsQR (the meal scanner's reader) from a raster of it. */
function qrTextOf(badge: any): string | null {
    const jsQR = require(path.join(PLUGIN_DIR, 'client/lib/vendor/jsQR.js'));
    const item = badge.items.find((i: any) => i.t === 'qr');
    if (!item) return null;
    const px = 4, quiet = 4, side = (item.size + 2 * quiet) * px;
    const rgba = new Uint8ClampedArray(side * side * 4).fill(255);
    item.rows.forEach((row: string, y: number) => [...row].forEach((c, x) => {
        if (c !== '1') return;
        for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) { const i = (((y + quiet) * px + dy) * side + (x + quiet) * px + dx) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; }
    }));
    const r = jsQR(rgba, side, side);
    return r ? r.data : null;
}

async function selfWorld(opts: { siteUrl?: string | null } = {}) {
    const p = await bootPlugin(opts);
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso Costa', slug: `self-${++seq}` } })).id as number;
    for (const template of ['first_name', 'last_name']) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }), template);
    ok(await p.call('post', '/fields', { body: { conference_id: cid, label: 'Tipo de documento', type: 'select', options: 'Cédula, Tarjeta de identidad, Pasaporte' } }), 'tipo');
    ok(await p.call('post', '/fields', { body: { conference_id: cid, label: 'Número de Documento', type: 'text', is_unique: 1 } }), 'número');
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const fields = p.q(`SELECT name, label FROM ${T('fields')} WHERE conference_id = ?`, cid) as any[];
    const typeF = fields.find(f => f.label === 'Tipo de documento').name, numF = fields.find(f => f.label === 'Número de Documento').name;
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 50 } })).id as number;
    const ana = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'Ana', last_name: 'Pérez', location_id: norte, [typeF]: 'Cédula', [numF]: '1.045.678.901' } }), 'ana').id as number;
    const beto = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'Beto', last_name: 'Núñez', location_id: norte, [typeF]: 'Pasaporte', [numF]: 'AB123456' } }), 'beto').id as number;
    const codeOf = (id: number) => p.one(`SELECT reg_code FROM ${T('inscriptions')} WHERE id = ?`, id).reg_code as string;
    return { p, cid, norte, ana, beto, codeOf, typeF, numF };
}

test('«Mi inscripción»: the QR carries the link; the document opens the page; nothing without it', async () => {
    const w = await selfWorld();
    const { p } = w;
    const code = w.codeOf(w.ana);

    // The badge's QR now carries the link with the code (the site address from settings:read).
    const prev = ok(await p.call('post', '/badges/preview', { body: { conference_id: w.cid, inscription_id: w.ana } })).badge;
    assert.strictEqual(qrTextOf(prev), `https://congreso.example.org/portal/conference/yo#c=${code}`);
    const cfg = ok(await p.call('get', `/badges/config?conference_id=${w.cid}`));
    assert.strictEqual(cfg.self_page.type_field, w.typeF, 'the type field is detected by its label');
    assert.strictEqual(cfg.self_page.number_field, w.numF, 'the number field is detected by its label');
    assert.strictEqual(ok(await p.call('get', `/qr-link?conference_id=${w.cid}`)).prefix, 'https://congreso.example.org/portal/conference/yo#c=');

    // start: an unknown code and a known one; the document types come from the form.
    assert.strictEqual((await pub(p, 'post', '/public/me/start', { code: 'ZZZZZZZZZZ' })).status, 401);
    const start = ok(await pub(p, 'post', '/public/me/start', { code: code.toLowerCase() }), 'start');
    assert.deepStrictEqual(start.doc_types, ['Cédula', 'Tarjeta de identidad', 'Pasaporte']);
    assert.strictEqual(start.needs_type, true);

    // verify: wrong number, wrong type → the same 401; the right one (any punctuation) → a session and the view.
    assert.strictEqual((await pub(p, 'post', '/public/me/verify', { code, doc_type: 'Cédula', doc_number: '1045678900' })).status, 401);
    assert.strictEqual((await pub(p, 'post', '/public/me/verify', { code, doc_type: 'Pasaporte', doc_number: '1045678901' })).status, 401);
    const opened = ok(await pub(p, 'post', '/public/me/verify', { code, doc_type: 'cedula', doc_number: ' 1045678901 ' }), 'verify');
    assert.match(opened.session, /^[0-9a-f]{32}$/);
    assert.strictEqual(opened.view.name, 'Ana Pérez');
    assert.strictEqual(opened.view.location, 'Norte');
    assert.strictEqual(opened.view.code, code);
    assert.strictEqual(opened.view.lodging, null);
    assert.ok(opened.view.answers.some((a: any) => a.label === 'Número de Documento' && a.value === '1.045.678.901'));
    assert.ok(!JSON.stringify(opened.view).includes('Beto'), 'nobody else is in it');
    // Only the hash of the session is stored.
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('self_sessions')} WHERE token_hash = ?`, opened.session).n, 0);

    // The session reopens the view; leaving ends it.
    ok(await pub(p, 'post', '/public/me/view', { session: opened.session }), 'view');
    ok(await pub(p, 'post', '/public/me/logout', { session: opened.session }), 'logout');
    assert.strictEqual((await pub(p, 'post', '/public/me/view', { session: opened.session })).status, 401);
    assert.strictEqual((await pub(p, 'post', '/public/me/view', { session: 'f'.repeat(32) })).status, 401);
});

test('«Mi inscripción»: meals delivered and to come, the hotel and its position, a cancelled or disabled page', async () => {
    const w = await selfWorld();
    const { p } = w;
    const code = w.codeOf(w.ana);
    // The hotel's position from a Google Maps link (the place's pin wins over the map's centre); a short link is refused.
    assert.strictEqual((await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Corto', location: 'https://maps.app.goo.gl/AbC123' } })).status, 400);
    const hotel = ok(await p.call('post', '/hotels', { body: { conference_id: w.cid, name: 'Hotel Prado', address: 'Cra 54 # 70-10',
        location: 'https://www.google.com/maps/place/Hotel+El+Prado/@10.9970000,-74.8000000,17z/data=!3m1!4b1!4m9!8m2!3d10.9971234!4d-74.7998765' } }), 'hotel').id;
    assert.strictEqual(p.one(`SELECT geo FROM ${T('hotels')} WHERE id = ?`, hotel).geo, '10.997123,-74.799876');
    const room = ok(await p.call('post', '/rooms', { body: { hotel_id: hotel, room_number: '204', capacity: 2 } })).id;
    p.exec(`UPDATE ${T('inscriptions')} SET room_id = ? WHERE id IN (?, ?)`, room, w.ana, w.beto);
    // Two services: one delivered, one planned and still to come.
    const s1 = ok(await p.call('post', '/meals/services', { body: { conference_id: w.cid, service_date: '2027-03-01', meal: 'almuerzo' } })).id;
    const s2 = ok(await p.call('post', '/meals/services', { body: { conference_id: w.cid, service_date: '2027-03-01', meal: 'cena' } })).id;
    for (const s of [s1, s2]) ok(await p.call('post', '/meals/plan/toggle', { body: { location_id: w.norte, service_id: s, enabled: true } }), 'plan');
    // The kitchen scans the badge's QR — the LINK — and the scan finds Ana.
    const check = ok(await p.call('post', '/meals/check', { body: { service_id: s1, code: `https://congreso.example.org/portal/conference/yo#c=${code}` } }), 'check');
    assert.ok(JSON.stringify(check).includes('Ana'), JSON.stringify(check));
    ok(await p.call('post', '/meals/deliver', { body: { service_id: s1, inscription_id: w.ana, force: true } }), 'deliver');

    const v = ok(await pub(p, 'post', '/public/me/verify', { code, doc_type: 'Cédula', doc_number: '1045678901' })).view;
    assert.deepStrictEqual(v.lodging, { hotel: 'Hotel Prado', room: '204', address: 'Cra 54 # 70-10', lat: 10.997123, lng: -74.799876 });
    assert.deepStrictEqual(v.meals.delivered.map((m: any) => [m.date, m.meal]), [['2027-03-01', 'almuerzo']]);
    assert.match(v.meals.delivered[0].delivered_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.deepStrictEqual(v.meals.pending.map((m: any) => [m.date, m.meal]), [['2027-03-01', 'cena']]);
    assert.ok(!JSON.stringify(v).includes('Beto'), 'the roommate is not shown');

    // Cancelled → 410; the page turned off → 410 and the QR goes back to the bare code.
    ok(await p.call('put', `/inscriptions/${w.ana}`, { body: { status: 'cancelled' } }), 'cancel');
    const gone = await pub(p, 'post', '/public/me/start', { code });
    assert.deepStrictEqual([gone.status, gone.body.code], [410, 'inactive']);
    ok(await p.call('put', `/inscriptions/${w.ana}`, { body: { status: 'active' } }), 'reactivate');
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, policy: { self_page: { enabled: false } } } }), 'off');
    const off = await pub(p, 'post', '/public/me/start', { code });
    assert.deepStrictEqual([off.status, off.body.code], [410, 'disabled']);
    const prev = ok(await p.call('post', '/badges/preview', { body: { conference_id: w.cid, inscription_id: w.ana } })).badge;
    assert.strictEqual(qrTextOf(prev), code);
});

test('«Mi inscripción»: wrong documents lock only that code for a while; no site address = the bare code', async () => {
    const w = await selfWorld();
    const { p } = w;
    const ana = w.codeOf(w.ana), beto = w.codeOf(w.beto);
    for (let i = 0; i < 5; i++) assert.strictEqual((await pub(p, 'post', '/public/me/verify', { code: ana, doc_type: 'Cédula', doc_number: `9${i}` })).status, 401);
    const locked = await pub(p, 'post', '/public/me/verify', { code: ana, doc_type: 'Cédula', doc_number: '1045678901' });
    assert.deepStrictEqual([locked.status, locked.body.code], [429, 'throttled'], 'even the right document waits once the code is locked');
    ok(await pub(p, 'post', '/public/me/verify', { code: beto, doc_type: 'Pasaporte', doc_number: 'ab-123456' }), 'another code is not locked');

    const bare = await selfWorld({ siteUrl: null });
    const prev = ok(await bare.p.call('post', '/badges/preview', { body: { conference_id: bare.cid, inscription_id: bare.ana } })).badge;
    assert.strictEqual(qrTextOf(prev), bare.codeOf(bare.ana));
    assert.strictEqual(ok(await bare.p.call('get', `/qr-link?conference_id=${bare.cid}`)).prefix, null);
});
