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
    // A document to ask: badge links lead to «Mi inscripción» (2.28.0).
    ok(await p.call('post', '/fields', { body: { conference_id: cid, label: 'Número de documento', type: 'text' } }), 'documento');
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
const preview = async (w: W, iid: number) => ok(await w.p.call('post', '/badges/preview', { body: { conference_id: w.cid, inscription_id: iid } }), 'preview').badge;
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

test('links: the public view leads to «Mi inscripción»; wrong tokens 404 (throttled), cancelled / expired / disabled 410', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: { fields: [{ key: '@location', show_label: true }] } } }));
    const link = await linkFor(w, w.ana, VIEWER);
    assert.match(link.token, /^[0-9a-f]{32}$/);
    assert.strictEqual((await linkFor(w, w.ana)).token, link.token, 'one link per inscription');

    const v = ok(await view(w, link.token), 'view');
    // 2.28.0: the link shows no badge (it carried no check) — only where the person confirms their document.
    assert.deepStrictEqual(v, { self: `/portal/conference/yo#c=${w.codeOf(w.ana)}` });
    const badge = await preview(w, w.ana);
    assert.deepStrictEqual(texts(badge).slice(0, 4), ['Congreso Nacional de Jóvenes', 'Ana Pérez', 'LOCALIDAD', 'Norte']);
    // 2.22.0: the code is a QR; 2.23.0: it carries the «Mi inscripción» link (a bigger symbol than the bare code's 21×21).
    assert.ok(badge.items.some((i: any) => i.t === 'qr' && i.size > 21 && i.rows.length === i.size && i.rows.every((r: string) => r.length === i.size && /^[01]+$/.test(r))));
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
    assert.strictEqual((await pub(p, 'post', '/public/badge/ticket', { token: link.token })).status, 410, '2.28.0: no PDF through a link');
    const d = ok(await p.call('post', '/badges/ticket', { body: { conference_id: w.cid, inscription_ids: [w.beto] } })).d;
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
    // 2.36.6: the locality-wide links and PDF (POST /portal/badges/links, /portal/badges/ticket) are gone with the portal's section.
    for (const gone of ['/portal/badges/links', '/portal/badges/ticket']) assert.ok(!p.routes.some((r: any) => r.method === 'post' && r.path === gone), gone);

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
    assert.ok(texts(await preview(w, w.carla)).includes('Sur'));
    ok(await p.call('delete', `/locations/${w.sur}`), 'delete Sur');
    const after = texts(await preview(w, w.carla));
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

/** Runs `fn` with every sign-in wait (setTimeout ≥ 250 ms) recorded and skipped. */
async function withWaitsRecorded<R>(fn: (waits: number[]) => Promise<R>): Promise<R> {
    const real = global.setTimeout;
    const waits: number[] = [];
    (global as any).setTimeout = (cb: any, ms?: number, ...a: any[]) => {
        if (typeof ms === 'number' && ms >= 250) { waits.push(ms); return (real as any)(cb, 0, ...a); }
        return (real as any)(cb, ms, ...a);
    };
    try { return await fn(waits); } finally { (global as any).setTimeout = real; }
}
const verifyAs = (p: Plugin, clientKey: string, body: any) => p.call('post', '/public/me/verify', { anonymous: true, clientKey, body });

test('«Mi inscripción»: wrong documents refuse only the guesser; the right document is never refused; no site address = the bare code', async () => {
    const w = await selfWorld();
    const { p } = w;
    const ana = w.codeOf(w.ana), beto = w.codeOf(w.beto);
    for (let i = 0; i < 5; i++) assert.strictEqual((await verifyAs(p, 'guesser', { code: ana, doc_type: 'Cédula', doc_number: `9${i}` })).status, 401);
    // The guesser's own budget for that code is spent: even the right document is refused to THEM.
    const locked = await verifyAs(p, 'guesser', { code: ana, doc_type: 'Cédula', doc_number: '1045678901' });
    assert.deepStrictEqual([locked.status, locked.body.code], [429, 'throttled']);
    ok(await verifyAs(p, 'guesser', { code: beto, doc_type: 'Pasaporte', doc_number: 'ab-123456' }), 'another code is not locked');
    // The holder of the badge, from their own phone: past the code's shared budget they wait, never a refusal.
    await withWaitsRecorded(async (waits) => {
        const owner = await verifyAs(p, 'owner-phone', { code: ana, doc_type: 'Cédula', doc_number: '1045678901' });
        assert.strictEqual(owner.status, 200, `the right document was refused for somebody else's guesses: ${JSON.stringify(owner.body)}`);
        assert.deepStrictEqual(waits, [250], 'one wait once the code\'s shared budget is spent');
    });
    // Unknown codes are charged to the caller only: they never slow down a real code.
    for (let i = 0; i < 25; i++) assert.strictEqual((await verifyAs(p, `enumerator-${i % 3}`, { code: `ZZZZZZZZ${String(i).padStart(2, '2').replace(/[01]/g, '2')}`, doc_number: '1' })).status, 401);
    await withWaitsRecorded(async (waits) => {
        ok(await verifyAs(p, 'beto-phone', { code: beto, doc_type: 'Pasaporte', doc_number: 'ab-123456' }), 'beto');
        assert.deepStrictEqual(waits, [], 'unknown codes slowed down a real one');
    });

    const bare = await selfWorld({ siteUrl: null });
    const prev = ok(await bare.p.call('post', '/badges/preview', { body: { conference_id: bare.cid, inscription_id: bare.ana } })).badge;
    assert.strictEqual(qrTextOf(prev), bare.codeOf(bare.ana));
    assert.strictEqual(ok(await bare.p.call('get', `/qr-link?conference_id=${bare.cid}`)).prefix, null);
});

test('boarding check: the scanned badge says whether the person travels on THIS bus', async () => {
    const w = await selfWorld();
    const { p } = w;
    const ana = w.codeOf(w.ana), beto = w.codeOf(w.beto);
    const bus1 = ok(await p.call('post', '/buses', { body: { conference_id: w.cid, name: 'Bus 1', capacity: 40 } }), 'bus1').id;
    const bus2 = ok(await p.call('post', '/buses', { body: { conference_id: w.cid, name: 'Bus 2', capacity: 40 } }), 'bus2').id;
    // 2.26.0: what is sold is a package of buses.
    const pkg = ok(await p.call('post', '/transport/packages', { body: { conference_id: w.cid, name: 'Ida', price: 50000, bus_ids: [bus1] } }), 'package').id;
    ok(await p.call('post', `/transport/packages/${pkg}/sales`, { body: { inscription_ids: [w.ana] } }), 'sale');
    const check = (bus_id: number, code: string) => p.call('post', '/transport/check', { body: { bus_id, code } });

    // Ana's QR (the «Mi inscripción» link) on her bus → ok, with what her ticket still owes.
    const okRes = ok(await check(bus1, `https://congreso.example.org/portal/conference/yo#c=${ana}`), 'ok');
    assert.strictEqual(okRes.result, 'ok');
    assert.strictEqual(okRes.person.name, 'Ana Pérez');
    assert.deepStrictEqual(okRes.ticket, { payment_status: 'unpaid', price: 50000, amount_paid: 0, balance: 50000, package_name: 'Ida' });
    // On the other bus → other_bus, naming hers.
    const other = ok(await check(bus2, ana), 'other');
    assert.strictEqual(other.result, 'other_bus');
    assert.deepStrictEqual(other.buses, [{ id: bus1, name: 'Bus 1' }]);
    // Beto has no ticket; a code nobody has is unknown; a cancelled registration says so.
    assert.strictEqual(ok(await check(bus1, beto)).result, 'no_ticket');
    assert.strictEqual(ok(await check(bus1, 'ZZZZZZZZZZ')).result, 'unknown');
    ok(await p.call('put', `/inscriptions/${w.beto}`, { body: { status: 'cancelled' } }), 'cancel');
    assert.strictEqual(ok(await check(bus1, beto)).result, 'cancelled');
    // A code of ANOTHER conference is unknown here; a bus that does not exist is a 404.
    const elsewhere = await selfWorld();
    assert.strictEqual(ok(await elsewhere.p.call('post', '/buses', { body: { conference_id: elsewhere.cid, name: 'X', capacity: 1 } })).id > 0, true);
    assert.strictEqual((await check(9999, ana)).status, 404);
    // Nothing was written: the check is read only.
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('transport_tickets')}`).n, 1);
});

// ── Transport packages (2.26.0): packages of buses are sold, paid per package ──

test('packages: a sale seats the person on every bus of the package, all-or-nothing; one price, its own payments', async () => {
    const w = await selfWorld();
    const { p } = w;
    const bus = async (name: string, capacity: number) => ok(await p.call('post', '/buses', { body: { conference_id: w.cid, name, capacity } }), name).id;
    const ida = await bus('Ida 1', 40), regreso = await bus('Regreso 1', 1), otro = await bus('Otro', 40);
    // A package = a fixed list of buses and one price.
    assert.strictEqual((await p.call('post', '/transport/packages', { body: { conference_id: w.cid, name: 'X', price: 10, bus_ids: [] } })).status, 400);
    const pkg = ok(await p.call('post', '/transport/packages', { body: { conference_id: w.cid, name: 'Ida y regreso', price: 120000, bus_ids: [ida, regreso] } }), 'pkg').id;
    // Selling it to two people when «Regreso 1» has one seat: refused, nothing written.
    const full = await p.call('post', `/transport/packages/${pkg}/sales`, { body: { inscription_ids: [w.ana, w.beto] } });
    assert.strictEqual(full.status, 409);
    assert.match(full.body.error, /Regreso 1 \(quedan 1\)/);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('transport_tickets')}`).n, 0);
    // To Ana: one sale, a seat on each bus.
    ok(await p.call('post', `/transport/packages/${pkg}/sales`, { body: { inscription_ids: [w.ana] } }), 'sell');
    assert.deepStrictEqual(p.q(`SELECT bus_id FROM ${T('transport_tickets')} WHERE inscription_id = ? ORDER BY bus_id`, w.ana).map((r: any) => r.bus_id), [ida, regreso]);
    // A second package that also uses «Ida 1» cannot be sold to her (she already sits there).
    const pkg2 = ok(await p.call('post', '/transport/packages', { body: { conference_id: w.cid, name: 'Ida sola', price: 60000, bus_ids: [ida, otro] } })).id;
    const twice = await p.call('post', `/transport/packages/${pkg2}/sales`, { body: { inscription_ids: [w.ana] } });
    assert.strictEqual(twice.status, 409);
    assert.match(twice.body.error, /Ida 1/);
    // The list of a sold package is locked; its price changes for new sales, and with reprice_sales for the sold one.
    assert.strictEqual((await p.call('put', `/transport/packages/${pkg}`, { body: { bus_ids: [ida] } })).status, 409);
    ok(await p.call('put', `/transport/packages/${pkg}`, { body: { price: 100000 } }), 'price');
    let pk = (ok(await p.call('get', `/transport/packages?conference_id=${w.cid}`)) as any[]).find((x: any) => x.id === pkg);
    assert.strictEqual(pk.price, 100000);
    assert.strictEqual(pk.sales[0].price, 120000, 'a sold sale keeps its price');
    // Payments go to the sale, never beyond its balance; the bus lists show the package and its status.
    const sale = pk.sales[0].id;
    assert.strictEqual((await p.call('post', `/transport/package-sales/${sale}/payments`, { body: { amount: 130000, method: 'Efectivo' } })).status, 400);
    ok(await p.call('post', `/transport/package-sales/${sale}/payments`, { body: { amount: 20000, method: 'Efectivo' } }), 'pay');
    assert.strictEqual((await p.call('put', `/transport/packages/${pkg}`, { body: { price: 10000, reprice_sales: true } })).status, 409, 'not below what was paid');
    ok(await p.call('put', `/transport/packages/${pkg}`, { body: { price: 100000, reprice_sales: true } }), 'reprice');
    pk = (ok(await p.call('get', `/transport/packages?conference_id=${w.cid}`)) as any[]).find((x: any) => x.id === pkg);
    assert.deepStrictEqual([pk.sales[0].price, pk.sales[0].amount_paid, pk.sales[0].payment_status, pk.revenue, pk.collected], [100000, 20000, 'partial', 100000, 20000]);
    const buses = ok(await p.call('get', `/buses?conference_id=${w.cid}`));
    const seat = buses.find((b: any) => b.id === regreso).passengers[0];
    assert.deepStrictEqual([seat.package_name, seat.price, seat.amount_paid, seat.payment_status], ['Ida y regreso', 100000, 20000, 'partial']);
    // Accounting: the package payment is transport income.
    const led = ok(await p.call('get', `/accounting?conference_id=${w.cid}`));
    assert.deepStrictEqual(led.entries.filter((e: any) => e.source === 'transport').map((e: any) => [e.amount, e.description]), [[20000, 'Paquete de transporte — Ida y regreso']]);
    // Single tickets are no longer sold; a seat of a package is removed by removing the package.
    assert.strictEqual((await p.call('post', `/buses/${otro}/passengers`, { body: { inscription_ids: [w.beto] } })).status, 410);
    assert.strictEqual((await p.call('delete', `/buses/${ida}/passengers/${w.ana}`)).status, 409);
    // With a payment: the sale, the package and a bus in it stay.
    assert.strictEqual((await p.call('delete', `/transport/package-sales/${sale}`)).status, 409);
    assert.strictEqual((await p.call('delete', `/transport/packages/${pkg}`)).status, 409);
    assert.strictEqual((await p.call('delete', `/buses/${ida}`)).status, 409);
    // Without it, the sale goes and its seats free up.
    const payId = (ok(await p.call('get', `/transport/package-sales/${sale}/payments`)) as any[])[0].id;
    ok(await p.call('delete', `/transport/package-payments/${payId}`), 'unpay');
    ok(await p.call('delete', `/transport/package-sales/${sale}`), 'unsell');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('transport_tickets')}`).n, 0);
});

test('packages: tickets sold before packages become one-bus package sales, with their payments, once', async () => {
    const w = await selfWorld();
    const { p } = w;
    const bus = ok(await p.call('post', '/buses', { body: { conference_id: w.cid, name: 'Bus viejo', capacity: 10, price: 30000 } })).id;
    // The old way: a ticket at the bus price with a payment of its own.
    p.exec(`INSERT INTO ${T('transport_tickets')} (bus_id, inscription_id, price, amount_paid, payment_status) VALUES (?, ?, 30000, 10000, 'partial')`, bus, w.ana);
    const ticket = p.one(`SELECT id FROM ${T('transport_tickets')} WHERE inscription_id = ?`, w.ana).id;
    p.exec(`INSERT INTO ${T('transport_payments')} (ticket_id, amount, method, reference, date) VALUES (?, 10000, 'Efectivo', 'R-1', '2026-10-01')`, ticket);
    await p.reboot();
    await p.reboot();   // twice: nothing is converted again
    const pk = ok(await p.call('get', `/transport/packages?conference_id=${w.cid}`)) as any[];
    assert.strictEqual(pk.length, 1);
    assert.deepStrictEqual([pk[0].name, pk[0].price, pk[0].buses.map((b: any) => b.id)], ['Bus viejo', 30000, [bus]]);
    assert.deepStrictEqual(pk[0].sales.map((s: any) => [s.inscription_id, s.price, s.amount_paid, s.payment_status]), [[w.ana, 30000, 10000, 'partial']]);
    const pays = ok(await p.call('get', `/transport/package-sales/${pk[0].sales[0].id}/payments`)) as any[];
    assert.deepStrictEqual(pays.map((x: any) => [x.amount, x.method, x.reference]), [[10000, 'Efectivo', 'R-1']]);
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('transport_payments')}`).n, 0, 'the payment moved, it is not counted twice');
    const led = ok(await p.call('get', `/accounting?conference_id=${w.cid}`));
    assert.deepStrictEqual(led.entries.filter((e: any) => e.source === 'transport').map((e: any) => e.amount), [10000]);
});

// ── 2.27.0: boarding and bus notices, by Web Push ──
const pushLib = require(path.join(PLUGIN_DIR, 'server', 'transport-push.js'));
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
/** The phone's side of RFC 8291: decrypt an aes128gcm body with the phone's ECDH key and auth secret. */
function uaDecrypt(body: Buffer, ua: any, auth: Buffer): string {
    const crypto = require('crypto');
    const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const shared = ua.computeSecret(asPublic);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.strictEqual(plain[plain.length - 1], 2, 'the last record delimiter');
    return plain.subarray(0, plain.length - 1).toString('utf8');
}
function phone() {
    const crypto = require('crypto');
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    return { ua, auth, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
}

test('web push: the payload is encrypted as RFC 8291 says (its own test vector) and the VAPID JWT verifies', async () => {
    const crypto = require('crypto');
    // RFC 8291 Appendix A.
    const as = crypto.createECDH('prime256v1');
    as.setPrivateKey(unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    const out = pushLib.encryptPayload('When I grow up, I want to be a watermelon',
        { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
        { ecdh: as, salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw') });
    assert.strictEqual(b64u(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    // A fresh phone decrypts what is sent to it.
    const ph = phone();
    assert.strictEqual(uaDecrypt(pushLib.encryptPayload('{"title":"Tu bus está embarcando"}', ph.keys), ph.ua, ph.auth), '{"title":"Tu bus está embarcando"}');
    // VAPID: an ES256 JWT for the push service's origin, signed by the key whose public half is `k`.
    const key = pushLib.newVapidKey();
    const h = pushLib.vapidHeader(new URL('https://fcm.googleapis.com/fcm/send/abc'), key, 'https://congreso.example.org');
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    assert.ok(m, h);
    assert.strictEqual(m[4], key.publicKey);
    const claims = JSON.parse(unb64u(m[2]).toString());
    assert.strictEqual(claims.aud, 'https://fcm.googleapis.com');
    assert.strictEqual(claims.sub, 'https://congreso.example.org');
    const pub65 = unb64u(key.publicKey);
    const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub65.subarray(1, 33)), y: b64u(pub65.subarray(33)) }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, unb64u(m[3])));
    // Only push services' hosts, over https, are endpoints.
    assert.ok(pushLib.pushEndpoint('https://fcm.googleapis.com/fcm/send/x'));
    assert.ok(pushLib.pushEndpoint('https://web.push.apple.com/QA'));
    assert.ok(pushLib.pushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'https://127.0.0.1/x', 'https://u:p@fcm.googleapis.com/x']) {
        assert.strictEqual(pushLib.pushEndpoint(bad), null, bad);
    }
});

test('boarding: the admin starts boarding / marks the departure / messages a bus; its passengers\' phones are notified', async () => {
    const w = await selfWorld();
    const { p } = w;
    const ida = ok(await p.call('post', '/buses', { body: { conference_id: w.cid, name: 'Bus Norte', origin: 'Medellín', destination: 'Cartagena', capacity: 40 } })).id;
    const pkg = ok(await p.call('post', '/transport/packages', { body: { conference_id: w.cid, name: 'Ida', price: 10, bus_ids: [ida] } })).id;
    ok(await p.call('post', `/transport/packages/${pkg}/sales`, { body: { inscription_ids: [w.ana] } }), 'sell');
    const session = ok(await pub(p, 'post', '/public/me/verify', { code: w.codeOf(w.ana), doc_type: 'Cédula', doc_number: '1045678901' })).session;
    const beto = ok(await pub(p, 'post', '/public/me/verify', { code: w.codeOf(w.beto), doc_type: 'Pasaporte', doc_number: 'AB123456' })).session;

    // Her page shows the bus (scheduled) and the key to turn the notices on.
    const v = ok(await pub(p, 'post', '/public/me/view', { session })).view;
    assert.strictEqual(v.transport.length, 1);
    assert.strictEqual(v.transport[0].name, 'Bus Norte');
    assert.strictEqual(v.transport[0].status, 'scheduled');
    assert.match(v.push_key, /^B[A-Za-z0-9_-]{86}$/);
    assert.deepStrictEqual(ok(await pub(p, 'post', '/public/me/view', { session: beto })).view.transport, [], 'no bus, no transport');

    // Subscribing: only a push service's endpoint with well-formed keys, and only with a live session.
    const ph = phone();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/ana-phone';
    assert.strictEqual((await pub(p, 'post', '/public/me/push/subscribe', { session, subscription: { endpoint: 'https://evil.example/x', keys: ph.keys } })).status, 400);
    assert.strictEqual((await pub(p, 'post', '/public/me/push/subscribe', { session, subscription: { endpoint, keys: { p256dh: 'AAAA', auth: ph.keys.auth } } })).status, 400);
    assert.strictEqual((await pub(p, 'post', '/public/me/push/subscribe', { session: 'f'.repeat(32), subscription: { endpoint, keys: ph.keys } })).status, 401);
    ok(await pub(p, 'post', '/public/me/push/subscribe', { session, subscription: { endpoint, keys: ph.keys } }), 'subscribe');
    ok(await pub(p, 'post', '/public/me/push/subscribe', { session, subscription: { endpoint, keys: ph.keys } }), 'again: the same phone, once');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('push_subs')}`).n, 1);
    const bus = ok(await p.call('get', `/buses?conference_id=${w.cid}`))[0];
    assert.strictEqual(bus.alerts, 1);
    assert.strictEqual(bus.status, 'scheduled');

    // «Iniciar embarque»: the push service receives an encrypted, VAPID-signed notice her phone can read.
    const sent: { url: string; init: any }[] = [];
    let answer = 201;
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => { sent.push({ url, init }); return new Response(null, { status: answer }); };
    try {
        assert.strictEqual((await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'nope' } })).status, 400);
        const r = ok(await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'boarding' } }), 'boarding');
        assert.strictEqual(r.bus.status, 'boarding');
        assert.deepStrictEqual(r.delivery, { subscribers: 1, sent: 1, failed: 0, network: true });
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].url, endpoint);
        assert.strictEqual(sent[0].init.headers['Content-Encoding'], 'aes128gcm');
        assert.match(sent[0].init.headers.Authorization, /^vapid t=[^.]+\.[^.]+\.[^,]+, k=B/);
        const payload = JSON.parse(uaDecrypt(sent[0].init.body, ph.ua, ph.auth));
        assert.strictEqual(payload.kind, 'boarding');
        assert.match(payload.title, /embarcando: Bus Norte/);
        assert.match(payload.body, /Medellín → Cartagena/);

        // A message needs its text; it goes to the same phones.
        assert.strictEqual((await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'message', text: '   ' } })).status, 400);
        assert.strictEqual((await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'message', text: 'x'.repeat(241) } })).status, 400);
        ok(await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'message', text: 'Salimos desde la puerta 3' } }), 'message');
        assert.strictEqual(JSON.parse(uaDecrypt(sent[1].init.body, ph.ua, ph.auth)).body, 'Salimos desde la puerta 3');

        // Her page lists the state and the notices, newest first (also without push: /public/me/transport).
        const t = ok(await pub(p, 'post', '/public/me/transport', { session })).transport[0];
        assert.strictEqual(t.status, 'boarding');
        assert.ok(t.boarding_at);
        assert.deepStrictEqual(t.notices.map((n: any) => n.kind), ['message', 'boarding']);

        // «Marcar salida»; the push service says the subscription is gone → it is dropped.
        answer = 410;
        const d = ok(await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'departed' } }), 'departed');
        assert.strictEqual(d.bus.status, 'departed');
        assert.strictEqual(d.delivery.failed, 1);
        assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('push_subs')}`).n, 0);
        const notices = ok(await p.call('get', `/buses/${ida}/notices`));
        assert.deepStrictEqual(notices.map((n: any) => [n.kind, n.sent]), [['departed', 0], ['message', 1], ['boarding', 1]]);
        // Reset back to scheduled: no notice.
        ok(await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'reset' } }), 'reset');
        assert.strictEqual(ok(await p.call('get', `/buses?conference_id=${w.cid}`))[0].status, 'scheduled');
        assert.strictEqual(sent.length, 3);

        // Without «network» (the sandbox's fetch getter throws): nothing sent, the admin is told; the page still has it.
        answer = 201;
        ok(await pub(p, 'post', '/public/me/push/subscribe', { session, subscription: { endpoint, keys: ph.keys } }), 'resubscribe');
        Object.defineProperty(globalThis, 'fetch', { configurable: true, get() { throw new Error('[sandbox] network blocked'); } });
        const nn = ok(await p.call('post', `/buses/${ida}/notice`, { body: { kind: 'boarding' } }), 'no network');
        assert.deepStrictEqual(nn.delivery, { subscribers: 1, sent: 0, failed: 1, network: false });
        assert.strictEqual(ok(await pub(p, 'post', '/public/me/transport', { session })).transport[0].status, 'boarding');
    } finally {
        Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: realFetch });
    }
    // Only transport:manage sends; leaving «Mi inscripción» drops the phone.
    assert.strictEqual((await p.call('post', `/buses/${ida}/notice`, { user: VIEWER, body: { kind: 'boarding' } })).status, 403);
    ok(await pub(p, 'post', '/public/me/logout', { session }), 'logout');
    assert.strictEqual(p.one(`SELECT COUNT(*) AS n FROM ${T('push_subs')}`).n, 0);
});

test('a shared badge link leads to «Mi inscripción» (the document first); with that page off it leads nowhere', async () => {
    const w = await selfWorld();
    const { p } = w;
    const link = ok(await p.call('post', '/badges/links', { body: { conference_id: w.cid, inscription_ids: [w.ana] } }), 'link').links[0];
    const r = ok(await pub(p, 'post', '/public/badge/view', { token: link.token }), 'view');
    assert.deepStrictEqual(r, { self: `/portal/conference/yo#c=${w.codeOf(w.ana)}` }, 'only where to go: no badge, no name');
    // What the admin and the coordinators open, copy and send is that page itself.
    assert.strictEqual(link.self, r.self);
    assert.strictEqual(ok(await p.call('get', `/badges/links?conference_id=${w.cid}`)).links[0].self, r.self);
    const t = await pub(p, 'post', '/public/badge/ticket', { token: link.token });
    assert.strictEqual(t.status, 410, 'no PDF through the link either');
    assert.strictEqual(p.one(`SELECT view_count FROM ${T('badge_links')} WHERE token = ?`, link.token).view_count, 1, 'the open still counts');
    // The page turned off: the link shows nothing at all.
    const cfg = ok(await p.call('get', `/badges/config?conference_id=${w.cid}`)).config;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: cfg.design, policy: { ...cfg.policy, self_page: { ...cfg.policy.self_page, enabled: false } } } }), 'off');
    const off = await pub(p, 'post', '/public/badge/view', { token: link.token });
    assert.strictEqual(ok(await p.call('get', `/badges/links?conference_id=${w.cid}`)).links[0].self, null, 'no page to send to');
    assert.strictEqual(off.status, 410);
    assert.strictEqual(off.body.code, 'self_off');
    assert.ok(!off.body.badge && !off.body.self);
});

// ── 2.29.0: the free-form («Canva») designer ──
const designLib = require(path.join(PLUGIN_DIR, 'server', 'badge-design.js'));
/** A real 2×2 RGBA PNG (one pixel half transparent). */
const REAL_PNG = (() => {
    const zlib = require('zlib');
    const chunk = (tag: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(tag, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
    const rows = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 128, 0, 0, 255, 0, 255, 255, 255, 0, 255]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
})();
const fontLib = require(path.join(PLUGIN_DIR, 'server', 'badge-font.js'));
const V2 = (imageId: string) => ({
    version: 2, layout: 'horizontal', background: '#0f172a',
    elements: [
        { type: 'shape', x: 0, y: 0, w: 85.6, h: 12, fill: '#f59e0b' },
        { type: 'image', asset: imageId, x: 3, y: 2, w: 8, h: 8, mask: 'circle' },
        { type: 'text', x: 14, y: 2, w: 44, h: 8, text: '{{@conference}}', font: 'oswald', bold: true, size: 11, color: '#0f172a', valign: 'middle', upper: true },
        { type: 'text', x: 4, y: 16, w: 50, h: 14, text: '{{@name}}', font: 'montserrat', bold: true, size: 20, color: '#ffffff', valign: 'middle' },
        { type: 'text', x: 4, y: 33, w: 50, h: 6, text: 'Hab. {{@room}}', font: 'poppins', size: 8, color: '#cbd5e1' },
        { type: 'text', x: 4, y: 41, w: 50, h: 6, text: '{{@location}}', font: 'playfair', size: 10, color: '#fbbf24', rot: -8, op: 0.8 },
        { type: 'line', x: 4, y: 30, w: 50, h: 1, stroke: '#f59e0b', sw: 0.4 },
        { type: 'qr', x: 60, y: 26, w: 23, h: 23 },
    ],
});

test('free-form designs: bounded, one QR always, tokens resolved, texts fitted; fonts measured the same way everywhere', () => {
    const d = designLib.normalizeDesignV2({ version: 2, layout: 'vertical', background: '#FFF', elements: [
        { type: 'qr', x: 1, y: 1, w: 200 }, { type: 'qr', x: 5, y: 5, w: 20 }, { type: 'nope' },
        { type: 'text', text: 'x'.repeat(900), font: 'comic-sans', size: 999, color: 'red' },
        { type: 'image', asset: 'not-a-sha' },
    ] });
    assert.strictEqual(d.background, '#ffffff');
    assert.strictEqual(d.elements.filter((e: any) => e.type === 'qr').length, 1, 'one QR');
    assert.strictEqual(d.elements[0].w, 54, 'the QR fits the card');
    const t = d.elements.find((e: any) => e.type === 'text');
    assert.strictEqual(t.text.length, 400);
    assert.strictEqual(t.font, 'helvetica');
    assert.strictEqual(t.size, 120);
    assert.strictEqual(t.color, '#111827');
    assert.ok(!d.elements.some((e: any) => e.type === 'image'), 'an image without a valid asset is dropped');
    // No QR at all → one is added (the meal scanner needs it).
    assert.strictEqual(designLib.normalizeDesignV2({ version: 2, elements: [] }).elements[0].type, 'qr');

    const parsed = new Map<string, any>();
    const metrics = fontLib.createMetrics((f: string) => {
        if (!parsed.has(f)) parsed.set(f, fontLib.parseTtf(Buffer.from(require(path.join(PLUGIN_DIR, 'fonts', `${f}.js`)), 'base64')));
        return parsed.get(f);
    });
    const v2 = designLib.normalizeDesignV2(V2('a'.repeat(16)));
    const badge = designLib.layoutDesign(v2, { data: { '@name': 'María Fernanda Gómez de la Torre', '@conference': 'Congreso', '@location': 'Soledad' }, qr: 'ABCDEFGHJK', metrics, images: { ['a'.repeat(16)]: { w: 100, h: 50 } } });
    const texts = badge.items.filter((i: any) => i.t === 'text');
    assert.deepStrictEqual(texts.filter((i: any) => i.face === 'montserrat-700').map((i: any) => i.text), ['María Fernanda', 'Gómez de la Torre'], 'the long name wraps');
    assert.ok(texts.find((i: any) => i.face === 'montserrat-700').size < 20, 'and shrinks to fit its box');
    assert.ok(!texts.some((i: any) => /Hab\./.test(i.text)), 'a text whose only token is empty is not drawn');
    assert.strictEqual(texts.find((i: any) => i.face === 'oswald-700').text, 'CONGRESO');
    const loc = texts.find((i: any) => i.face === 'playfair-400');
    assert.strictEqual(loc.rot, 352);
    assert.strictEqual(loc.op, 0.8);
    const img = badge.items.find((i: any) => i.t === 'image');
    assert.deepStrictEqual([img.clip, img.dw, img.dh], ['ellipse', 16, 8], 'cover: the 2:1 image fills the 8 mm circle');
    assert.deepStrictEqual(badge.faces.sort(), ['montserrat-700', 'oswald-700', 'playfair-400']);
    // Every text sits inside its box (horizontally).
    for (const it of texts) {
        const el = v2.elements.find((e: any) => e.id === it.el);
        assert.ok(it.x >= el.x - 0.01 && it.x + metrics.widthMm(it.text, it.face, it.bold, it.size, it.ls || 0) <= el.x + el.w + 0.05, it.text);
    }
});

test('free-form designs: saved with their images, previewed, printed with embedded fonts, shown on «Mi inscripción»', async () => {
    const w = await selfWorld();
    const { p } = w;
    // An image for the designer (PNG, 2×2), stored once by its sha.
    const up = ok(await p.call('put', '/badges/assets', { body: { conference_id: w.cid, kind: 'image', data_url: dataUrl('image/png', REAL_PNG), width: 2, height: 2 } }), 'image');
    assert.match(up.id, /^[0-9a-f]{16}$/);
    assert.strictEqual(ok(await p.call('put', '/badges/assets', { body: { conference_id: w.cid, kind: 'image', data_url: dataUrl('image/png', REAL_PNG), width: 2, height: 2 } })).id, up.id, 'the same image once');
    assert.strictEqual((await p.call('put', '/badges/assets', { body: { conference_id: w.cid, kind: 'image', data_url: dataUrl('image/png', REAL_PNG) } })).status, 400, 'its size is required');
    // The design saved: an image id that does not exist is dropped.
    const saved = ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: { ...V2(up.id), elements: [...V2(up.id).elements, { type: 'image', asset: 'b'.repeat(16), x: 0, y: 0, w: 5, h: 5 }] } } }), 'save').config;
    assert.strictEqual(saved.design.version, 2);
    assert.strictEqual(saved.design.elements.filter((e: any) => e.type === 'image').length, 1);
    // The preview of a real person, with the images it draws.
    const prev = ok(await p.call('post', '/badges/preview', { body: { conference_id: w.cid, inscription_id: w.ana } }), 'preview');
    assert.strictEqual(prev.badge.version, 2);
    assert.ok(prev.badge.items.some((i: any) => i.t === 'text' && i.text === 'Ana Pérez'));
    assert.ok(prev.badge.items.some((i: any) => i.t === 'qr'));
    assert.match(prev.images[up.id], /^data:image\/png;base64,/);
    // A saved design's image cannot be deleted from the gallery.
    assert.strictEqual((await p.call('delete', `/badges/assets?conference_id=${w.cid}&kind=img_${up.id}`)).status, 409);
    // The PDF: one page per badge, the three faces embedded once each.
    const d = ok(await p.call('post', '/badges/ticket', { body: { conference_id: w.cid, inscription_ids: [w.ana, w.beto] } })).d;
    const f = ok(await p.call('get', `/public/badge/file?d=${d}`, { anonymous: true }), 'file');
    const pdf = Buffer.from(f.b64, 'base64').toString('latin1');
    assert.strictEqual((pdf.match(/\/Type \/Page\b/g) || []).length, 2);
    assert.strictEqual((pdf.match(/\/FontFile2/g) || []).length, 3);
    assert.ok(/\/BaseFont \/Montserrat-Bold/.test(pdf) && /\/BaseFont \/Oswald-Bold/.test(pdf) && /\/BaseFont \/PlayfairDisplay-Regular/.test(pdf));
    assert.strictEqual((pdf.match(/\/Subtype \/Image/g) || []).length, 2, 'the image once, with its soft mask');
    assert.strictEqual((pdf.match(/\/SMask/g) || []).length, 1);
    // «Mi inscripción»: the badge with its images.
    const session = ok(await pub(p, 'post', '/public/me/verify', { code: w.codeOf(w.ana), doc_type: 'Cédula', doc_number: '1045678901' })).session;
    const view = ok(await pub(p, 'post', '/public/me/view', { session })).view;
    assert.strictEqual(view.badge.badge.version, 2);
    assert.match(view.badge.images[up.id], /^data:image\/png/);
    // The faces are public.
    const font = ok(await pub(p, 'get', '/public/badge/font?f=montserrat-700'), 'font');
    assert.strictEqual(fontLib.parseTtf(Buffer.from(font.b64, 'base64')).psName, 'Montserrat-Bold');
    assert.strictEqual((await pub(p, 'get', '/public/badge/font?f=../index')).status, 404);
    assert.strictEqual((await pub(p, 'get', '/public/badge/font?f=helvetica-400')).status, 404);
});

// ── 2.36.0: the printable sticker ──
const PT_PER_MM = 72 / 25.4;
const mediaBoxes = (pdf: string) => [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m => [Number(m[1]) / PT_PER_MM, Number(m[2]) / PT_PER_MM].map(v => Math.round(v * 10) / 10));

test('sticker: its own design and size next to the virtual badge, saved together, bounded', async () => {
    const w = await world();
    const { p } = w;
    const cfg0 = ok(await p.call('get', `/badges/config?conference_id=${w.cid}`)).config;
    assert.strictEqual(cfg0.sticker.layout, 'sticker');
    assert.deepStrictEqual(cfg0.sticker.size, { w: 62, h: 100 }, 'Brother QL 62 × 100 mm by default');
    assert.ok(cfg0.sticker.elements.some((e: any) => e.text === '{{@meal_group}}'), 'the default sticker shows the meal group letter');
    const sticker = { version: 2, layout: 'horizontal', size: { w: 5000, h: 29 }, background: '#ffffff', elements: [
        { id: 'n', type: 'text', x: 2, y: 2, w: 58, h: 12, text: '{{@name}}', size: 14 },
        { id: 'g', type: 'text', x: 2, y: 14, w: 20, h: 13, text: '{{@meal_group}}', size: 30, bold: true },
    ] };
    const saved = ok(await p.call('put', '/badges/config', { user: DESIGNER, body: { conference_id: w.cid, design: cfg0.design, policy: cfg0.policy, sticker } })).config;
    assert.strictEqual(saved.sticker.layout, 'sticker', 'always a sticker');
    assert.deepStrictEqual(saved.sticker.size, { w: 220, h: 29 }, 'bounded to 220 mm');
    assert.ok(!saved.sticker.elements.some((e: any) => e.type === 'qr'), 'a sticker may have no QR');
    assert.strictEqual(saved.design.layout, cfg0.design.layout, 'the virtual badge is untouched');
    // The virtual badge keeps its QR whatever the sticker does.
    assert.ok(ok(await p.call('get', `/badges/config?conference_id=${w.cid}`)).config.design.version !== 2
        || ok(await p.call('get', `/badges/config?conference_id=${w.cid}`)).config.design.elements.some((e: any) => e.type === 'qr'));
    assert.strictEqual((await p.call('put', '/badges/config', { user: VIEWER, body: { conference_id: w.cid, sticker } })).status, 403);
});

test('sticker: the meal group letter from live data (nothing without a group), one label per page at its exact size', async () => {
    const w = await world();
    const { p } = w;
    const cfg0 = ok(await p.call('get', `/badges/config?conference_id=${w.cid}`)).config;
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: cfg0.design, policy: cfg0.policy, sticker: { ...cfg0.sticker, size: { w: 62, h: 29 } } } }));
    // The preview of the sticker for a real person: their name; no group yet → no letter.
    const pv = async (iid: number) => ok(await p.call('post', '/badges/preview', { body: { conference_id: w.cid, inscription_id: iid, target: 'sticker' } })).badge;
    let b = await pv(w.ana);
    assert.deepStrictEqual([b.w_mm, b.h_mm], [62, 29]);
    assert.ok(texts(b).join(' ').includes('Ana'));
    assert.ok(!b.items.some((i: any) => i.t === 'text' && /^[A-F]$/.test(i.text)), 'no group yet: no letter');
    // Meal turns on and a group set: the letter appears (only the letter).
    ok(await p.call('put', '/meals/priority/config', { body: { conference_id: w.cid, enabled: true } }));
    ok(await p.call('put', `/meals/priority/people/${w.ana}`, { body: { group: 'B' } }));
    b = await pv(w.ana);
    assert.ok(b.items.some((i: any) => i.t === 'text' && i.text === 'B'), JSON.stringify(texts(b)));
    // The sample (no person) shows a sample letter.
    const sample = ok(await p.call('post', '/badges/preview', { body: { conference_id: w.cid, target: 'sticker' } })).badge;
    assert.ok(texts(sample).includes('C'));
    // Print: a locality → one page per person, each exactly 62 × 29 mm; the virtual badge's PDF is unchanged.
    const d = ok(await p.call('post', '/badges/ticket', { user: VIEWER, body: { conference_id: w.cid, location_id: w.norte, sheet: 'sticker' } })).d;
    const f = ok(await p.call('get', `/public/badge/file?d=${d}`, { anonymous: true }));
    assert.strictEqual(f.filename, 'Stickers-Norte.pdf');
    const boxes = mediaBoxes(Buffer.from(f.b64, 'base64').toString('latin1'));
    assert.deepStrictEqual(boxes, [[62, 29], [62, 29]], 'Ana and Beto, one label each');
    const one = ok(await p.call('post', '/badges/ticket', { body: { conference_id: w.cid, inscription_id: w.carla, sheet: 'sticker' } })).d;
    const f1 = ok(await p.call('get', `/public/badge/file?d=${one}`, { anonymous: true }));
    assert.strictEqual(f1.filename, 'Sticker-Carla-Rios.pdf');
    const badge = ok(await p.call('post', '/badges/ticket', { body: { conference_id: w.cid, inscription_id: w.carla, sheet: 'single' } })).d;
    const fb = ok(await p.call('get', `/public/badge/file?d=${badge}`, { anonymous: true }));
    assert.notDeepStrictEqual(mediaBoxes(Buffer.from(fb.b64, 'base64').toString('latin1'))[0], [62, 29], 'the virtual badge keeps its card size');
    // A chosen list (the search) prints just those.
    const sel = ok(await p.call('post', '/badges/ticket', { body: { conference_id: w.cid, inscription_ids: [w.beto, w.carla], sheet: 'sticker' } })).d;
    assert.strictEqual(mediaBoxes(Buffer.from(ok(await p.call('get', `/public/badge/file?d=${sel}`, { anonymous: true })).b64, 'base64').toString('latin1')).length, 2);
    // Codes stay behind «Inscripciones › ver».
    assert.strictEqual((await p.call('post', '/badges/ticket', { user: NOCODES, body: { conference_id: w.cid, inscription_id: w.ana, sheet: 'sticker' } })).status, 403);
});

test('the meal group is offered to the designer as a data field', async () => {
    const w = await world();
    const fields = ok(await w.p.call('get', `/badges/config?conference_id=${w.cid}`)).available_fields;
    assert.ok(fields.some((f: any) => f.key === '@meal_group' && f.builtin));
});

test('the portal session names its conference (the header shows it after a reload too)', async () => {
    const w = await world();
    const code = w.p.one(`SELECT code FROM ${T('locations')} WHERE id = ?`, w.norte).code;
    const login = ok(await w.p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.norte, code } }));
    assert.strictEqual(login.location.conference_name, 'Congreso Nacional de Jóvenes');
    const me = ok(await portal(w.p, 'get', '/portal/me', login.token));
    assert.strictEqual(me.conference_name, 'Congreso Nacional de Jóvenes');
    assert.strictEqual(me.code, undefined, 'the access code never leaves');
});

test('«Mi inscripción» (2.36.5): a called group shows on the pending meal, and the notices can be turned on without a bus', async () => {
    const w = await selfWorld();
    const { p } = w;
    const code = w.codeOf(w.ana);
    const svc = ok(await p.call('post', '/meals/services', { body: { conference_id: w.cid, service_date: '2027-03-01', meal: 'cena' } })).id;
    ok(await p.call('post', '/meals/plan/toggle', { body: { location_id: w.norte, service_id: svc, enabled: true } }), 'plan');
    ok(await p.call('put', '/meals/priority/config', { body: { conference_id: w.cid, enabled: true } }), 'turnos');
    const view = async () => ok(await pub(p, 'post', '/public/me/verify', { code, doc_type: 'Cédula', doc_number: '1045678901' })).view;
    const before = await view();
    assert.ok(before.meal_group, 'a meal group');
    assert.ok(before.push_key, 'the notices key, with no bus');
    assert.strictEqual(before.meals.pending[0].called_at, undefined);
    ok(await p.call('post', '/meals/priority/call', { body: { service_id: svc, group: before.meal_group } }), 'call');
    const after = await view();
    assert.match(after.meals.pending[0].called_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Another group called instead: theirs is not.
    ok(await p.call('post', '/meals/priority/call', { body: { service_id: svc, group: before.meal_group, undo: true } }), 'undo');
    const other = ['A', 'B', 'C', 'D', 'E', 'F'].find((g) => g !== before.meal_group);
    ok(await p.call('post', '/meals/priority/call', { body: { service_id: svc, group: other } }), 'call other');
    assert.strictEqual((await view()).meals.pending[0].called_at, undefined);
});

test('2.36.6 «Escarapela» in the portal: WhatsApp only with a phone, «Enviar» only with an e-mail — own people only, one e-mail per 5 minutes, never a silent failure', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: false } }));
    for (const template of ['email', 'phone']) ok(await p.call('post', '/fields', { body: { conference_id: w.cid, template } }), template);
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: true } }));
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: {} } }));
    const dani = ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Dani', last_name: 'Mora', location_id: w.norte, email: 'Dani@Example.org', phone: '300 123 4567' } }), 'dani').id as number;
    const tn = await w.tokenOf(w.norte);
    const email = (iid: number, token = tn) => portal(p, 'post', '/portal/badges/email', token, { inscription_id: iid });

    // What the section offers: the number as the consent message builds it (E.164 with the default code), the e-mail masked.
    const withBoth = ok(await portal(p, 'post', '/portal/badges/link', tn, { inscription_id: dani }));
    assert.deepStrictEqual([withBoth.phone_wa, withBoth.email_masked], ['573001234567', 'd***@e***.org']);
    const without = ok(await portal(p, 'post', '/portal/badges/link', tn, { inscription_id: w.ana }));
    assert.deepStrictEqual([without.phone_wa, without.email_masked], ['', '']);

    // No e-mail on file; another location's person (Sur) is not this coordinator's.
    const none = await email(w.ana);
    assert.deepStrictEqual([none.status, none.body.code], [400, 'no_email']);
    assert.strictEqual((await email(w.carla)).status, 404);
    assert.strictEqual(p.mails.length, 0);

    // Sent: to the address on file, with the person's «Mi inscripción» link and the instructions; the answer masks it.
    const sent = ok(await email(dani), 'send');
    assert.deepStrictEqual(sent, { sent: true, email_masked: 'd***@e***.org' });
    assert.strictEqual(p.mails.length, 1);
    const m = p.mails[0];
    assert.strictEqual(m.to, 'dani@example.org');
    assert.strictEqual(m.subject, 'Tu escarapela · Congreso Nacional de Jóvenes');
    assert.ok(m.text.includes(`https://congreso.example.org/portal/conference/yo#c=${w.codeOf(dani)}`), m.text);
    for (const step of ['pantalla de inicio', 'Activa los avisos', 'no lo compartas']) assert.ok(m.text.includes(step), step);
    assert.ok(m.html.includes('Abrir mi escarapela'));

    // Again at once: refused, with the wait; nothing sent.
    const again = await email(dani);
    assert.deepStrictEqual([again.status, again.body.code], [429, 'mail_wait']);
    assert.ok(again.body.retry_in > 0 && again.body.retry_in <= 300);
    assert.strictEqual(p.mails.length, 1);

    // The audit: who, to which address, sent.
    const rows = p.q(`SELECT email, actor, ok, error FROM ${T('badge_mails')} WHERE inscription_id = ? ORDER BY id`, dani) as any[];
    assert.deepStrictEqual(rows.map(r => [r.email, r.actor, Number(r.ok), r.error]), [['dani@example.org', `portal:${w.norte}`, 1, null]]);

    // Five minutes later, with the site's mail gone: a clear 503, logged as not sent — never a silent «sent».
    p.exec(`UPDATE ${T('badge_mails')} SET at_s = at_s - 301 WHERE inscription_id = ?`, dani);
    p.setMailFail(true);
    const off = await email(dani);
    assert.deepStrictEqual([off.status, off.body.code], [503, 'mail_off']);
    assert.match(off.body.error, /correo del sitio no está configurado/);
    const failed = (p.q(`SELECT ok, error FROM ${T('badge_mails')} WHERE inscription_id = ? ORDER BY id`, dani) as any[]).pop();
    assert.deepStrictEqual([Number(failed.ok), failed.error], [0, 'Mail server not available']);
    p.setMailFail(false);

    // The conference's e-mail language («Autorizaciones › Idioma de los correos»): English.
    ok(await p.call('put', '/consent/settings', { body: { conference_id: w.cid, email_lang: 'en' } }), 'lang');
    ok(await email(dani), 'send in English');
    assert.strictEqual(p.mails[1].subject, 'Your badge · Congreso Nacional de Jóvenes');
    assert.ok(p.mails[1].text.includes('Add to Home Screen'));
});

test('2.36.13 «Enviar por correo» from the admin: the portal\'s e-mail (template, 5-minute pause per person whoever sends, audit) — only with an e-mail on file, masked on the links; Escarapelas › ver with the inscriptions', async () => {
    const w = await world();
    const { p } = w;
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: false } }));
    ok(await p.call('post', '/fields', { body: { conference_id: w.cid, template: 'email' } }), 'email');
    ok(await p.call('post', '/publish', { body: { conference_id: w.cid, published: true } }));
    ok(await p.call('put', '/badges/config', { body: { conference_id: w.cid, design: {} } }));
    const dani = ok(await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Dani', last_name: 'Mora', location_id: w.norte, email: 'Dani@Example.org' } }), 'dani').id as number;
    const email = (iid: number, user?: HarnessUser) => p.call('post', `/badges/links/${iid}/email`, { user, body: {} });

    // The links say where it would go (masked), or '' — the action is hidden — and the list (GET) too.
    assert.strictEqual((await linkFor(w, dani)).email_masked, 'd***@e***.org');
    assert.strictEqual((await linkFor(w, w.ana)).email_masked, '');
    const listed = ok(await p.call('get', `/badges/links?conference_id=${w.cid}`)).links;
    assert.strictEqual(listed.find((l: any) => l.inscription_id === dani).email_masked, 'd***@e***.org');

    // Who may: Escarapelas › ver with the inscriptions (as sharing the link); without the inscriptions, no.
    assert.strictEqual((await email(dani, NOCODES)).status, 403);
    assert.strictEqual(p.mails.length, 0);
    const none = await email(w.ana, VIEWER);
    assert.deepStrictEqual([none.status, none.body.code], [400, 'no_email']);
    assert.strictEqual((await email(999999)).status, 404);

    // Sent by the team member: the same e-mail as the portal's «Enviar» (badge.link), masked in the answer.
    assert.deepStrictEqual(ok(await email(dani, VIEWER), 'send'), { sent: true, email_masked: 'd***@e***.org' });
    assert.strictEqual(p.mails.length, 1);
    assert.strictEqual(p.mails[0].to, 'dani@example.org');
    assert.strictEqual(p.mails[0].subject, 'Tu escarapela · Congreso Nacional de Jóvenes');
    assert.ok(p.mails[0].text.includes(`/portal/conference/yo#c=${w.codeOf(dani)}`), p.mails[0].text);

    // One per person every 5 minutes, whoever sends: the coordinator's portal right after the admin is refused too.
    const again = await email(dani);
    assert.deepStrictEqual([again.status, again.body.code], [429, 'mail_wait']);
    const fromPortal = await portal(p, 'post', '/portal/badges/email', await w.tokenOf(w.norte), { inscription_id: dani });
    assert.deepStrictEqual([fromPortal.status, fromPortal.body.code], [429, 'mail_wait']);
    assert.strictEqual(p.mails.length, 1);

    // The audit names the admin; a failure is said and logged, never a silent «sent».
    p.exec(`UPDATE ${T('badge_mails')} SET at_s = at_s - 301 WHERE inscription_id = ?`, dani);
    p.setMailFail(true);
    const off = await email(dani);
    assert.deepStrictEqual([off.status, off.body.code], [503, 'mail_off']);
    p.setMailFail(false);
    const rows = p.q(`SELECT email, actor, ok FROM ${T('badge_mails')} WHERE inscription_id = ? ORDER BY id`, dani) as any[];
    assert.deepStrictEqual(rows.map(r => [r.email, r.actor, Number(r.ok)]), [['dani@example.org', 'viewer', 1], ['dani@example.org', 'boss', 0]]);

    // A cancelled registration has no badge to send.
    p.exec(`UPDATE ${T('inscriptions')} SET status = 'cancelled' WHERE id = ?`, dani);
    assert.strictEqual((await email(dani)).status, 404);
    // «Regenerar enlace» shares the route and still needs Escarapelas › administrar.
    assert.strictEqual((await p.call('post', `/badges/links/${w.ana}/rotate`, { user: VIEWER, body: {} })).status, 403);
    assert.strictEqual((await p.call('post', `/badges/links/${w.ana}/nope`, { body: {} })).status, 404);
});
