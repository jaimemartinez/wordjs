/**
 * conference-manager 2.34.0 — «Consentimiento en papel»: the data consent signed by hand on a printed sheet, next to
 * the e-mailed code (never instead of it). Pinned against the REAL plugin:
 *   - the sheet: one locality's people still without an authorization, the policy version in force (its SHA-256),
 *     the full texts, Sí / No for health and image, the minor's representative, blank rows, page numbers and a QR
 *     on every page, in the configured e-mail language — and printing it again gives the same sheet;
 *   - the signed pages are uploaded privately (photo or PDF, checked by their bytes) with their SHA-256;
 *   - ticking who signed writes a «granted» row with method 'paper' in the person's own hash chain (sheet, row,
 *     policy, text and file hashes, who uploaded and who ticked) and the inscription leaves «pendiente»;
 *     health answers exist only with «salud Sí»; a minor needs the representative's name;
 *   - a wrong tick is undone with a reason — a NEW row; the chain stays append-only and checks;
 *   - scope: a coordinator reaches only their own locality; uploads, sheets, ticks and undos are all logged.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { bootPlugin, PREFIX, PLUGIN_DIR, type Plugin } from './fixtures/conference-manager-harness';

const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(64)]);
const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

let seq = 0;
async function world({ lang = '' } = {}) {
    const p: Plugin = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'Asume el Riesgo', slug: `pc-${++seq}`, date_start: '2030-01-10', date_end: '2030-01-12' } })).id as number;
    for (const template of ['first_name', 'last_name', 'email', 'age', 'health']) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }), template);
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 500 } })).id as number;
    const sur = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Sur', capacity: 500 } })).id as number;
    ok(await p.call('put', '/consent/settings', { body: { conference_id: cid, enabled: true, responsible: 'La iglesia en Barranquilla', contact_email: 'datos@example.org', policy_url: 'https://example.org/politica-de-datos', policy_version: '1.0', ...(lang ? { email_lang: lang } : {}) } }));
    const tokenOf = async (loc: number) => {
        const code = p.one(`SELECT code FROM ${PREFIX}locations WHERE id = ?`, loc).code;
        return ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: loc, code } })).token as string;
    };
    const tNorte = await tokenOf(norte), tSur = await tokenOf(sur);
    const portal = (method: string, url: string, token: string, body?: any) => p.call(method, url, { anonymous: true, headers: { 'x-portal-token': token }, body });
    const register = async (token: string, first: string, age = 34) => ok(await portal('post', '/portal/inscriptions', token, { first_name: first, last_name: 'Pérez', email: `${first.toLowerCase()}@example.org`, age })).id as number;
    const events = (id: number) => p.q(`SELECT * FROM ${PREFIX}consent_events WHERE inscription_id = ? ORDER BY id`, id) as any[];
    return { p, cid, norte, sur, tNorte, tSur, portal, register, events };
}

test('the sheet: the locality\'s pending people, the policy in force, one authorization, opt-out columns, representative, blank rows, pages and QR', async () => {
    const w = await world({ lang: 'en' });
    const ana = await w.register(w.tNorte, 'Ana');
    await w.register(w.tNorte, 'Beto', 12);
    await w.register(w.tSur, 'Carla');
    const made = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create', blank: 12 }));
    assert.strictEqual(made.sheet.rows, 2, 'only Norte\'s people');
    assert.strictEqual(made.sheet.lang, 'en', 'the configured e-mail language');
    const html: string = made.html;
    assert.ok(html.includes('Ana Pérez') && html.includes('Beto Pérez') && !html.includes('Carla'), 'pre-filled with this locality only');
    assert.ok(html.includes('version 1.0') && html.includes('https://example.org/politica-de-datos'));
    const policy = w.p.one(`SELECT policy_sha256 FROM ${PREFIX}consent_policies WHERE conference_id = ?`, w.cid);
    assert.ok(html.includes(policy.policy_sha256), 'the policy version\'s SHA-256');
    assert.ok(html.includes('La iglesia en Barranquilla') && html.includes('datos@example.org'), 'controller and contact');
    // ONE authorization: the three configured texts in one block, health and image said to be voluntary.
    const texts = ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings;
    assert.ok(html.includes('<b>Consent.</b>'), 'one authorization block');
    assert.ok(texts.text_health.startsWith('Autorizo expresamente') && html.includes('Autorizo expresamente el tratamiento de mis datos sensibles de salud'), 'the configured health text, in it');
    assert.ok(html.includes('Autorizo el uso de mi imagen') && html.includes('como Responsable'), 'the image and general texts, in it');
    assert.ok(html.includes('voluntary: I am not obliged to give it'));
    // Opt-out boxes, not Sí / No.
    assert.ok(html.includes('I do not consent to health data') && html.includes('I do not consent to use of image') && html.includes('Legal guardian (minors)'));
    assert.ok(!/>Yes<|>No</.test(html), 'no Yes / No columns');
    // 2 people + 12 blank = 14 rows over several pages; EVERY page repeats the authorization, the table header, the QR
    // and «Page i of n» (no cover page: whoever signs a later page reads what they sign). Letter by default.
    const pages = (html.match(/<section class="page">/g) || []).length;
    assert.ok(pages >= 2, `${pages} pages`);
    for (let i = 1; i <= pages; i++) assert.ok(html.includes(`Page ${i} of ${pages}`), `page ${i}`);
    for (const piece of [/<svg /g, /<b>Consent\.<\/b>/g, /<thead>/g, /voluntary: I am not obliged/g]) assert.strictEqual((html.match(piece) || []).length, pages, String(piece));
    assert.strictEqual((html.match(/<td class="n">/g) || []).length, 14, 'every row once');
    assert.ok(html.includes('@page { size: letter landscape'));
    const a4 = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create', paper: 'a4' }));
    assert.strictEqual(a4.sheet.paper, 'a4');
    assert.ok(a4.html.includes('@page { size: A4 landscape'));
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create', paper: 'legal' })).status, 400);
    assert.ok(!/<script/i.test(html), 'no script in the printable page');
    // An injected name is escaped.
    const evil = ok(await w.portal('post', '/portal/inscriptions', w.tNorte, { first_name: '<img src=x onerror=alert(1)>', last_name: 'X', email: 'x@example.org', age: 30 })).id;
    const again = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create' })).html as string;
    assert.ok(!again.includes('<img src=x') && again.includes('&lt;img src=x'));
    assert.ok(evil);
    // Printing it again gives the same sheet.
    const reprint = ok(await w.portal('get', `/portal/consent/paper?sheet_id=${made.sheet.id}`, w.tNorte));
    assert.strictEqual(reprint.html, html);
    // Every sheet is logged in the conference's chain.
    const audit = w.p.q(`SELECT kind, actor FROM ${PREFIX}consent_events WHERE conference_id = ? AND inscription_id IS NULL ORDER BY id`, w.cid) as any[];
    assert.deepStrictEqual(audit.map(a => a.kind), ['paper_sheet_created', 'paper_sheet_created', 'paper_sheet_created']);
    assert.strictEqual(audit[0].actor, 'portal:Norte');
    assert.ok(ana);
});

test('upload, tick and evidence: method paper in the person\'s chain, opt-outs, the inscription leaves pending, health only when authorized', async () => {
    const w = await world();
    const ana = await w.register(w.tNorte, 'Ana');
    const beto = await w.register(w.tNorte, 'Beto', 12);
    const sheet = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create' })).sheet;
    // No file yet → no ticks.
    const early = await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: ana, health: true, image: false }] });
    assert.strictEqual(early.status, 409);
    // Files are checked by their bytes, kept with their SHA-256.
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'upload', sheet_id: sheet.id, data_url: dataUrl('image/png', PDF) })).status, 400, 'a PDF that claims to be a PNG');
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'upload', sheet_id: sheet.id, data_url: 'data:text/html;base64,PGI+' })).status, 400);
    const f1 = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'upload', sheet_id: sheet.id, data_url: dataUrl('image/png', PNG), name: 'pagina-1.png' }));
    const f2 = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'upload', sheet_id: sheet.id, data_url: dataUrl('application/pdf', PDF), name: 'hoja.pdf' }));
    assert.strictEqual(f1.sha256, sha256(PNG));
    assert.strictEqual(f2.sha256, sha256(PDF));
    // A minor needs the representative; Sí/No must be said.
    const noRep = await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: ana, health: true, image: false }, { inscription_id: beto, health: false, image: true }] });
    assert.strictEqual(noRep.status, 400);
    assert.strictEqual(noRep.body.inscription_id, beto);
    assert.strictEqual(noRep.body.field, 'representative');
    assert.strictEqual(w.events(ana).filter(e => e.kind === 'granted').length, 0, 'all checked before anything is written');
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: ana, image: 'no' }] })).body.field, 'choice');
    const marked = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id,
        // Ana marked «No autorizo uso de imagen»; Beto «No autorizo datos de salud». Unsaid = authorized.
        marks: [{ inscription_id: ana, image: false }, { inscription_id: beto, health: false, representative: { name: 'Marta Pérez', document: '55.444' } }],
    }));
    assert.deepStrictEqual(marked.marked.sort(), [ana, beto].sort());
    // The evidence: a «granted» row, method paper, with the sheet, the policy and every file's hash.
    const g = w.events(ana).find(e => e.kind === 'granted');
    const d = JSON.parse(g.data);
    const stored = w.p.one(`SELECT * FROM ${PREFIX}consent_sheets WHERE id = ?`, sheet.id);
    assert.strictEqual(d.method, 'paper');
    assert.deepStrictEqual(d.opt_outs, { health: false, image: true });
    assert.strictEqual(g.policy_version, '1.0');
    assert.strictEqual(g.policy_sha256, stored.policy_sha256);
    assert.strictEqual(g.text_sha256, sha256(stored.text));
    assert.strictEqual(d.sheet.code, stored.code);
    assert.ok(Number.isInteger(d.sheet.row) && d.sheet.row >= 1);
    assert.deepStrictEqual(d.files.map((f: any) => f.sha256), [sha256(PNG), sha256(PDF)]);
    assert.strictEqual(d.files[0].uploaded_by, 'portal:Norte');
    assert.strictEqual(d.marked_by, 'portal:Norte');
    assert.strictEqual(g.health, 1);
    assert.strictEqual(g.image, 0);
    const db = JSON.parse(w.events(beto).find(e => e.kind === 'granted').data);
    assert.deepStrictEqual(db.representative, { name: 'Marta Pérez', document: '55.444' });
    assert.strictEqual(db.minor, true);
    assert.deepStrictEqual(db.opt_outs, { health: true, image: false });
    // The inscription leaves pending, as with the code: the admin can confirm it.
    ok(await w.p.call('put', `/inscriptions/${ana}`, { body: { status: 'active' } }), 'confirm after paper');
    const states = ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states;
    assert.strictEqual(states[ana].state, 'granted');
    assert.strictEqual(states[ana].method, 'paper');
    // Health answers: Ana said Sí → allowed; Beto said No → refused.
    ok(await w.p.call('put', `/inscriptions/${ana}`, { body: { health_conditions: { answer: 'none' } } }), 'health with Sí');
    assert.strictEqual((await w.p.call('put', `/inscriptions/${beto}`, { body: { health_conditions: { answer: 'none' } } })).status, 409, 'no health with No');
    // Ticking again is refused; the export carries the paper sheet and checks the chain.
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: ana, health: false, image: false }] })).status, 409);
    const ex = ok(await w.p.call('get', `/consent/evidence/${ana}`));
    assert.strictEqual(ex.chain_ok, true);
    assert.strictEqual(ex.paper_sheets[0].code, stored.code);
    assert.strictEqual(ex.paper_sheets[0].text_sha256_ok, true);
    assert.deepStrictEqual(ex.paper_sheets[0].files.map((f: any) => f.sha256), [sha256(PNG), sha256(PDF)]);
    // Uploads are logged in the conference's chain, and the file comes back only to those allowed.
    const audit = w.p.q(`SELECT kind, data FROM ${PREFIX}consent_events WHERE conference_id = ? AND inscription_id IS NULL AND kind = 'paper_uploaded'`, w.cid) as any[];
    assert.deepStrictEqual(audit.map(a => JSON.parse(a.data).sha256), [sha256(PNG), sha256(PDF)]);
    const file = ok(await w.portal('get', `/portal/consent/paper?file_id=${f1.id}`, w.tNorte));
    assert.strictEqual(file.data_url, dataUrl('image/png', PNG));
    assert.strictEqual((await w.p.call('get', `/consent/paper?file_id=${f1.id}`, { anonymous: true })).status, 401, 'never public');
});

test('a wrong tick is undone with a reason: a new row, back to pending, health deleted, the chain intact', async () => {
    const w = await world();
    const ana = await w.register(w.tNorte, 'Ana');
    const sheet = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create' })).sheet;
    ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'upload', sheet_id: sheet.id, data_url: dataUrl('image/png', PNG) }));
    ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: ana, health: true, image: true }] }));
    ok(await w.p.call('put', `/inscriptions/${ana}`, { body: { health_conditions: { answer: 'none' } } }));
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'unmark', inscription_id: ana })).body.field, 'reason');
    ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'unmark', inscription_id: ana, reason: 'Se marcó a la persona equivocada' }));
    const kinds = w.events(ana).map(e => e.kind);
    assert.deepStrictEqual(kinds.filter(k => k !== 'health_entered').slice(-2), ['granted', 'paper_unmarked']);
    const un = w.events(ana).at(-1);
    assert.strictEqual(JSON.parse(un.data).reason, 'Se marcó a la persona equivocada');
    assert.strictEqual(JSON.parse(un.data).undoes_event_id, w.events(ana).find(e => e.kind === 'granted').id);
    const st = ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[ana];
    assert.strictEqual(st.state, 'pending');
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, ana).n, 0, 'health deleted');
    assert.strictEqual(ok(await w.p.call('get', `/consent/evidence/${ana}`)).chain_ok, true);
    // Undo only undoes paper; it can be ticked again.
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'unmark', inscription_id: ana, reason: 'x' })).status, 409);
    ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: ana, health: false, image: false }] }));
    assert.strictEqual(ok(await w.p.call('get', `/consent/evidence/${ana}`)).chain_ok, true);
});

test('scope: a coordinator reaches only their locality; the admin any, by permission', async () => {
    const w = await world();
    const ana = await w.register(w.tNorte, 'Ana');
    const carla = await w.register(w.tSur, 'Carla');
    const norteSheet = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create' })).sheet;
    ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'upload', sheet_id: norteSheet.id, data_url: dataUrl('image/png', PNG) }));
    const f = w.p.one(`SELECT id FROM ${PREFIX}consent_sheet_files WHERE sheet_id = ?`, norteSheet.id);
    // Sur cannot see, print, upload to or tick Norte's sheet, nor see its file.
    for (const [m, u, b] of [['get', `/portal/consent/paper?sheet_id=${norteSheet.id}`], ['post', '/portal/consent/paper', { action: 'upload', sheet_id: norteSheet.id, data_url: dataUrl('image/png', PNG) }],
        ['post', '/portal/consent/paper', { action: 'marks', sheet_id: norteSheet.id, marks: [{ inscription_id: ana, health: false, image: false }] }], ['get', `/portal/consent/paper?file_id=${f.id}`],
        ['post', '/portal/consent/paper', { action: 'unmark', inscription_id: ana, reason: 'x' }]] as any[]) {
        assert.strictEqual((await w.portal(m, u, w.tSur, b)).status, 404, `${m} ${u} ${b ? b.action : ''}`);
    }
    // Sur's own sheet cannot tick a Norte person.
    const surSheet = ok(await w.portal('post', '/portal/consent/paper', w.tSur, { action: 'create' })).sheet;
    ok(await w.portal('post', '/portal/consent/paper', w.tSur, { action: 'upload', sheet_id: surSheet.id, data_url: dataUrl('image/png', PNG) }));
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tSur, { action: 'marks', sheet_id: surSheet.id, marks: [{ inscription_id: ana, health: false, image: false }] })).status, 404);
    // The list is per locality.
    const surList = ok(await w.portal('get', '/portal/consent/paper', w.tSur));
    assert.deepStrictEqual(surList.people.map((x: any) => x.id), [carla]);
    assert.deepStrictEqual(surList.sheets.map((x: any) => x.id), [surSheet.id]);
    // The admin reaches both, by conference and locality; a team member without «inscriptions» does not.
    const adminList = ok(await w.p.call('get', `/consent/paper?conference_id=${w.cid}&location_id=${w.norte}`));
    assert.deepStrictEqual(adminList.people.map((x: any) => x.id), [ana]);
    ok(await w.p.call('post', '/consent/paper', { body: { action: 'marks', sheet_id: surSheet.id, marks: [{ inscription_id: carla, health: false, image: false }] } }));
    assert.strictEqual(JSON.parse(w.events(carla).find(e => e.kind === 'granted').data).via, 'admin');
    const editor = { id: 77, role: 'editor', userLogin: 'editor' };
    assert.notStrictEqual((await w.p.call('get', `/consent/paper?conference_id=${w.cid}&location_id=${w.norte}`, { user: editor as any })).status, 200);
    // A location of another conference is refused.
    assert.strictEqual((await w.p.call('get', `/consent/paper?conference_id=${w.cid}&location_id=999`)).status, 404);
    // Off: nothing.
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, enabled: false } }));
    assert.strictEqual((await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create' })).status, 409);
});

test('a verbal health authorization is confirmed by the paper signature, or its answer deleted on the health opt-out', async () => {
    const w = await world();
    const reg = async (first: string) => ok(await w.portal('post', '/portal/inscriptions', w.tNorte, {
        first_name: first, last_name: 'Pérez', email: `${first.toLowerCase()}@example.org`, age: 34,
        health_conditions: { conditions: ['Diabetes'] }, health_verbal_consent: true,
    })).id as number;
    const ana = await reg('Ana'), beto = await reg('Beto');
    const sheet = ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'create' })).sheet;
    ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'upload', sheet_id: sheet.id, data_url: dataUrl('image/png', PNG) }));
    ok(await w.portal('post', '/portal/consent/paper', w.tNorte, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: ana }, { inscription_id: beto, health: false }] }));
    // Ana: confirmed, linked to her paper signature; the answer stays.
    const g = w.events(ana).find(e => e.kind === 'granted');
    const c = JSON.parse(w.events(ana).find(e => e.kind === 'verbal_confirmed').data);
    assert.deepStrictEqual([c.confirmed_by_event_id, c.method, c.verbal_entered_by], [g.id, 'paper', 'portal:Norte']);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, ana).n, 1);
    // Beto marked «No autorizo datos de salud»: the answer is deleted, and that is logged.
    assert.strictEqual(JSON.parse(w.events(beto).find(e => e.kind === 'health_deleted').data).method, 'paper');
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, beto).n, 0);
    for (const id of [ana, beto]) assert.strictEqual(ok(await w.p.call('get', `/consent/evidence/${id}`)).chain_ok, true);
});

test('the activation scan accepts the plugin (no computed call, every permission declared)', () => {
    const { validatePluginPermissions } = require('../core/plugins');
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
    assert.doesNotThrow(() => validatePluginPermissions('conference-manager', PLUGIN_DIR, manifest, { mode: 'grant' }));
});
