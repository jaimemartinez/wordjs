/**
 * conference-manager 2.33.0 — «Autorización de datos»: each registrant's own consent, signed with a code sent to
 * their e-mail, kept in an append-only evidence log.
 *
 * The site's controller must hold PROOF of each person's authorization (a coordinator's word is not proof);
 * health data need express, separate, optional consent; a minor's is given by the legal representative. Pinned
 * against the REAL plugin:
 *   - with the setting on, a registration needs an e-mail, starts «pendiente», cannot be confirmed, and carries
 *     no health answer — the coordinator's portal does not even get the health field;
 *   - the link is single-use; the 6-digit code expires (10 min), allows 5 tries, is re-sent at most once a
 *     minute and 5 times an hour, and is never stored (no table holds it);
 *   - the evidence: subject, verified e-mail, UTC time + zones, network key, user agent, policy version, the
 *     SHA-256 of the exact text shown, each box, the code's sent / verified times, the minor's representative;
 *   - append-only: no UPDATE / DELETE on the log anywhere in the plugin, a revocation is a new row, the rows of
 *     a person form a hash chain that the export checks, and deleting the person keeps the log;
 *   - health purge N days after the conference ends, keeping the evidence;
 *   - each signature names the policy version in force (version + SHA-256 of an append-only snapshot), and a
 *     version someone signed cannot change its texts without a new version number;
 *   - «Copiar mensaje» (2.33.2): a new link to share by hand — no e-mail, not marked e-mailed, logged
 *     «link_shared»; the old link stops working; signing still needs the e-mailed code.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { bootPlugin, PREFIX, PLUGIN_DIR, type Plugin } from './fixtures/conference-manager-harness';

const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Time travel for the code's expiry and the resend gaps (the plugin reads Date.now()).
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
afterEach(() => { offset = 0; });
const advance = (ms: number) => { offset += ms; };

async function portal(p: Plugin, method: string, url: string, token: string, body?: any) {
    for (const r of p.routes) {
        if (r.method !== method || r.path !== url) continue;
        const res: any = {
            statusCode: 200, _body: undefined,
            status(c: number) { this.statusCode = c; return this; },
            json(x: any) { this._body = JSON.parse(JSON.stringify(x)); return this; },
            cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; },
        };
        await r.handler({ params: {}, query: {}, body: body || {}, headers: { 'x-portal-token': token }, cookies: {}, user: null }, res);
        return { status: res.statusCode, body: res._body };
    }
    throw new Error(`no portal route ${method} ${url}`);
}

let seq = 0;
async function world({ enable = true, extra = [] as string[] } = {}) {
    const p = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'Asume el Riesgo', slug: `dc-${++seq}`, date_start: '2030-01-10', date_end: '2030-01-12' } })).id as number;
    for (const template of ['first_name', 'last_name', 'email', 'age', 'health', ...extra]) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }), template);
    ok(await p.call('post', '/fields', { body: { conference_id: cid, label: 'Tipo de documento', type: 'select', options: 'Cédula, Tarjeta de identidad' } }));
    ok(await p.call('post', '/fields', { body: { conference_id: cid, label: 'Número de documento', type: 'text' } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 500 } })).id as number;
    if (enable) ok(await p.call('put', '/consent/settings', { body: { conference_id: cid, enabled: true, responsible: 'La iglesia en Barranquilla', contact_email: 'datos@example.org', policy_url: 'https://example.org/politica-de-datos', policy_version: '1.0' } }));
    const code = p.one(`SELECT code FROM ${PREFIX}locations WHERE id = ?`, norte).code;
    const ptoken = ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: norte, code } })).token as string;
    const docCols = p.q(`SELECT name, label FROM ${PREFIX}fields WHERE conference_id = ? AND label LIKE '%documento%' ORDER BY id`, cid) as any[];
    const register = (body: Record<string, unknown>) => portal(p, 'post', '/portal/inscriptions', ptoken, {
        first_name: 'Ana', last_name: 'Pérez', email: 'ana.perez@example.org', age: 34,
        [docCols[0].name]: 'Cédula', [docCols[1].name]: '1.234.567', ...body,
    });
    /** The token of the last link mailed to `to`. */
    const linkToken = (to = 'ana.perez@example.org') => {
        const m = [...p.mails].reverse().find((x: any) => x.to === to && /#t=/.test(x.text));
        return m ? String(m.text.match(/#t=([0-9a-f]{32})/)[1]) : null;
    };
    const lastCode = (to = 'ana.perez@example.org') => {
        const m = [...p.mails].reverse().find((x: any) => x.to === to && /código/i.test(x.subject));
        return m ? String(m.subject.match(/(\d{6})/)[1]) : null;
    };
    const pub = (route: string, body: any, clientKey = 'ck-ana') => p.call('post', `/public/consent/${route}`, { anonymous: true, body, clientKey });
    const events = (id: number) => p.q(`SELECT * FROM ${PREFIX}consent_events WHERE inscription_id = ? ORDER BY id`, id) as any[];
    return { p, cid, norte, ptoken, register, linkToken, lastCode, pub, events };
}

const GRANT = { general: true, health: true, image: false, client_tz: 'America/Bogota', user_agent: 'Mozilla/5.0 (Test)' };

test('with consent on, a portal registration needs an e-mail, stays pending, cannot be confirmed and carries no health', async () => {
    const w = await world();
    // The portal does not even get the health field.
    const fields = ok(await w.p.call('get', `/public/fields?conference_id=${w.cid}`, { anonymous: true }));
    assert.ok(!fields.some((f: any) => f.name === 'health_conditions'));
    assert.strictEqual((await w.register({ email: '' })).status, 400, 'an e-mail is required');
    assert.strictEqual((await w.register({ health_conditions: { answer: 'none' } })).status, 409, 'the coordinator never handles health data');
    const r = await w.register({});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.consent, { state: 'pending', sent: true, email_masked: 'a***@e***.org' });
    const id = r.body.id as number;
    assert.ok(w.linkToken(), 'the link was mailed');
    // The admin cannot confirm it, nor write health for it.
    const put = await w.p.call('put', `/inscriptions/${id}`, { body: { status: 'active' } });
    assert.strictEqual(put.status, 409);
    assert.strictEqual(put.body.code, 'consent_pending');
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id}`, { body: { health_conditions: { answer: 'none' } } })).status, 409);
    // The coordinator sees «pendiente».
    const list = ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken));
    assert.strictEqual(list[0].consent.state, 'pending');
    assert.strictEqual(list[0].consent.email_masked, 'a***@e***.org');
});

test('the code: expiry, 5 tries, resend gap and hourly cap, single use — and it is never stored', async () => {
    const w = await world();
    const id = (await w.register({})).body.id as number;
    const token = w.linkToken()!;
    const view = ok(await w.pub('open', { token })).view;
    assert.strictEqual(view.email_masked, 'a***@e***.org');
    assert.strictEqual(view.policy.version, '1.0');
    assert.ok(view.texts.general.includes('La iglesia en Barranquilla') && view.texts.general.includes('datos@example.org'));
    // No code asked yet.
    assert.strictEqual((await w.pub('confirm', { token, code: '000000', ...GRANT })).body.code, 'nocode');
    ok(await w.pub('code', { token }));
    const first = w.lastCode()!;
    // A new code at most once a minute.
    const again = await w.pub('code', { token });
    assert.strictEqual(again.status, 429);
    assert.strictEqual(again.body.code, 'wait');
    // Expiry: 10 minutes.
    advance(10 * 60 * 1000 + 1000);
    const late = await w.pub('confirm', { token, code: first, ...GRANT });
    assert.strictEqual(late.status, 401);
    assert.strictEqual(late.body.code, 'code_expired');
    // Five wrong tries burn the code (even the right one fails afterwards).
    ok(await w.pub('code', { token }));
    const second = w.lastCode()!;
    const wrong = second === '111111' ? '222222' : '111111';
    for (let i = 1; i <= 4; i++) {
        const r = await w.pub('confirm', { token, code: wrong, ...GRANT });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.body.tries_left, 5 - i);
    }
    assert.strictEqual((await w.pub('confirm', { token, code: wrong, ...GRANT })).body.code, 'code_burnt');
    assert.strictEqual((await w.pub('confirm', { token, code: second, ...GRANT })).body.code, 'nocode');
    // Five codes an hour.
    for (let i = 0; i < 3; i++) { advance(61 * 1000); ok(await w.pub('code', { token }), `send ${i}`); }
    advance(61 * 1000);
    assert.strictEqual((await w.pub('code', { token })).body.code, 'throttled');
    // Never stored: no table of the plugin holds any of the codes sent.
    const codes = w.p.mails.filter((m: any) => /código/i.test(m.subject)).map((m: any) => m.subject.match(/(\d{6})/)[1]);
    const tables = w.p.q(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '${PREFIX}%'`).map((t: any) => t.name);
    for (const t of tables) {
        const dump = JSON.stringify(w.p.q(`SELECT * FROM ${t}`));
        for (const c of codes) assert.ok(!dump.includes(`"${c}"`) && !dump.includes(`:${c}`), `${t} holds a code`);
    }
    // Only «sent» events for the codes (no code value in them).
    assert.deepStrictEqual(w.events(id).map(e => e.kind), ['link_sent', 'otp_sent', 'otp_sent', 'otp_sent', 'otp_sent', 'otp_sent']);
});

test('signing: the evidence row, health only with its box, the confirmation e-mail, the link spent', async () => {
    const w = await world();
    const id = (await w.register({})).body.id as number;
    const token = w.linkToken()!;
    const view = ok(await w.pub('open', { token })).view;
    ok(await w.pub('code', { token }));
    // The general authorization is required; a form mistake costs no try.
    const noGeneral = await w.pub('confirm', { token, code: w.lastCode(), ...GRANT, general: false });
    assert.strictEqual(noGeneral.body.code, 'general');
    const r = ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT, health_answer: { conditions: ['Diabetes'] } }));
    assert.strictEqual(r.state, 'granted');
    const ev = w.events(id);
    assert.deepStrictEqual(ev.map(e => e.kind), ['link_sent', 'otp_sent', 'otp_verified', 'granted']);
    const g = ev[3];
    const data = JSON.parse(g.data);
    assert.strictEqual(g.email, 'ana.perez@example.org');
    assert.strictEqual(g.policy_version, '1.0');
    assert.strictEqual(g.text_sha256, sha256(view.text), 'the hash of the exact text shown');
    assert.strictEqual(data.text, view.text);
    assert.deepStrictEqual([g.general, g.health, g.image], [1, 1, 0]);
    assert.strictEqual(g.client_key, 'ck-ana');
    assert.strictEqual(g.user_agent, 'Mozilla/5.0 (Test)');
    assert.strictEqual(g.client_tz, 'America/Bogota');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(g.at_utc) && g.server_tz);
    assert.deepStrictEqual({ name: data.subject.name, type: data.subject.document_type, number: data.subject.document_number }, { name: 'Ana Pérez', type: 'Cédula', number: '1.234.567' });
    assert.ok(data.otp_sent_utc && data.otp_verified_utc && data.otp_sent_utc <= data.otp_verified_utc);
    assert.strictEqual(data.representative, null);
    // Health stored, visible to health:view now that it is authorized.
    assert.strictEqual(w.p.one(`SELECT conditions FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id).conditions, JSON.stringify(['Diabetes']));
    assert.strictEqual(ok(await w.p.call('get', `/inscriptions/${id}`)).health_conditions, 'Diabetes');
    // The confirmation e-mail says what was accepted, with the policy link.
    const conf = w.p.mails[w.p.mails.length - 1];
    assert.ok(/Autorización registrada/.test(conf.subject) && conf.text.includes('https://example.org/politica-de-datos') && conf.text.includes(g.text_sha256));
    // Single use.
    assert.strictEqual((await w.pub('open', { token })).status, 410);
    // Confirmable now; the portal shows the time.
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { status: 'active' } }));
    const row = ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken))[0];
    assert.strictEqual(row.consent.state, 'granted');
    assert.strictEqual(row.consent.granted_at, g.at_utc.slice(0, 19) + '.000Z');
    // The coordinator cannot resend a link to someone who authorized.
    assert.strictEqual((await portal(w.p, 'post', '/portal/consent/resend', w.ptoken, { inscription_id: id })).status, 409);
});

test('without the health box nothing about health is kept; a minor needs the representative', async () => {
    const w = await world();
    const adult = (await w.register({})).body.id as number;
    let token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT, health: false, health_answer: { conditions: ['Diabetes'] } }));
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, adult).n, 0);
    // A minor (by «Edad»): the parent's e-mail, and the representative is required.
    const kid = (await w.register({ first_name: 'Tomás', email: 'mama@example.org', age: 9 })).body.id as number;
    token = w.linkToken('mama@example.org')!;
    assert.strictEqual(ok(await w.pub('open', { token })).view.minor, true);
    ok(await w.pub('code', { token }, 'ck-mama'));
    const code = w.lastCode('mama@example.org');
    const noRep = await w.pub('confirm', { token, code, ...GRANT }, 'ck-mama');
    assert.strictEqual(noRep.body.code, 'representative');
    const rep = { name: 'Laura Gómez', document: '52.000.111', relationship: 'Madre' };
    ok(await w.pub('confirm', { token, code, ...GRANT, representative: rep }, 'ck-mama'));
    const g = w.events(kid).find(e => e.kind === 'granted');
    const data = JSON.parse(g.data);
    assert.deepStrictEqual(data.representative, rep);
    assert.strictEqual(data.minor, true);
    assert.ok(data.text.includes('Laura Gómez (Madre), documento 52.000.111'), 'the representative is part of the signed text');
    assert.strictEqual(g.text_sha256, sha256(data.text));
});

test('append-only: no UPDATE or DELETE on the log anywhere, revocation is a new row, the chain catches tampering, deleting the person keeps it', async () => {
    // 1. The source: no statement of the plugin updates or deletes consent_events.
    const files = ['index.js', ...fs.readdirSync(path.join(PLUGIN_DIR, 'server')).map(f => `server/${f}`)].filter(f => f.endsWith('.js'));
    for (const f of files) {
        const src = fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
        assert.ok(!/(UPDATE|DELETE\s+FROM)\s+\$\{T\.consentEvents\}/i.test(src), `${f} writes over the log`);
        assert.ok(!/(UPDATE|DELETE\s+FROM)\s+[`'"]?\$?\{?P?\}?consent_events/i.test(src), `${f} writes over the log by name`);
        assert.ok(!/(UPDATE|DELETE\s+FROM)\s+\$\{T\.consentPolicies\}/i.test(src), `${f} writes over the policy versions`);
    }
    // 2. Revocations append.
    const w = await world();
    const id = (await w.register({})).body.id as number;
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT, image: true, health_answer: { answer: 'none' } }));
    const before = JSON.stringify(w.events(id));
    assert.strictEqual((await w.p.call('post', '/consent/revoke', { body: { inscription_id: id, health: true } })).body.field, 'note');
    ok(await w.p.call('post', '/consent/revoke', { body: { inscription_id: id, health: true, note: 'Correo del 3 de noviembre' } }));
    const after = w.events(id);
    assert.strictEqual(JSON.stringify(after.slice(0, -1)), before, 'earlier rows untouched');
    assert.strictEqual(after[after.length - 1].kind, 'revoked');
    assert.deepStrictEqual([after[after.length - 1].general, after[after.length - 1].health, after[after.length - 1].image], [1, 0, 1]);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id).n, 0, 'revoking health deletes the answers');
    ok(await w.p.call('post', '/consent/revoke', { body: { inscription_id: id, general: true, note: 'Llamada' } }));
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken))[0].consent.state, 'revoked');
    // 3. The export checks the chain (and the export itself is logged).
    const ex = ok(await w.p.call('get', `/consent/evidence/${id}`));
    assert.strictEqual(ex.chain_ok, true);
    assert.strictEqual(ex.events.find((e: any) => e.kind === 'granted').data.verified_email, 'ana.perez@example.org');
    w.p.exec(`UPDATE ${PREFIX}consent_events SET image = 0 WHERE inscription_id = ? AND kind = 'granted'`, id); // a tampered row
    const ex2 = ok(await w.p.call('get', `/consent/evidence/${id}`));
    assert.strictEqual(ex2.chain_ok, false);
    assert.strictEqual(ex2.broken_at, after.find((e: any) => e.kind === 'granted').id);
    // Only WordJS administrators export.
    const staff = { id: 77, role: 'conference_manager_team', userLogin: 'coord', extra: { pluginCapabilities: ['conference_manager_access'] } };
    assert.strictEqual((await w.p.call('get', `/consent/evidence/${id}`, { user: staff as any })).status, 403);
    // 4. Deleting the person keeps the evidence.
    const n = w.events(id).length;
    ok(await w.p.call('delete', `/inscriptions/${id}`));
    assert.strictEqual(w.events(id).length, n);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}consent_requests WHERE inscription_id = ?`, id).n, 0);
});

test('health answers are purged N days after the conference ends; the evidence stays', async () => {
    const w = await world();
    const id = (await w.register({})).body.id as number;
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT, health_answer: { conditions: ['Asma o EPOC'] } }));
    // The conference is over (since 1 June 2025).
    w.p.exec(`UPDATE ${PREFIX}conferences SET date_start = '2025-05-28', date_end = '2025-06-01' WHERE id = ?`, w.cid);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers`).n, 1);
    // The defaults the admin sees before touching them: 30 days after the end, links valid 14 days.
    const st = ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings;
    assert.deepStrictEqual([st.purge_days, st.link_days], [30, 14]);
    // Not due while the setting keeps them longer.
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, purge_days: 3650 } }));
    assert.deepStrictEqual(ok(await w.p.call('post', '/consent/purge', { body: {} })).purged, []);
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, purge_days: 30 } }));
    assert.deepStrictEqual(ok(await w.p.call('post', '/consent/purge', { body: {} })).purged, [w.cid]);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers`).n, 0);
    assert.ok(w.events(id).some(e => e.kind === 'granted'), 'evidence kept');
    const purge = w.p.one(`SELECT * FROM ${PREFIX}consent_events WHERE conference_id = ? AND kind = 'health_purged'`, w.cid);
    assert.strictEqual(JSON.parse(purge.data).answers_deleted, 1);
    assert.ok(ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings.health_purged_at);
    // Once only.
    assert.deepStrictEqual(ok(await w.p.call('post', '/consent/purge', { body: {} })).purged, []);
});

test('without a mail plugin the registration still works and the coordinator sees it; settings validate; off = as before', async () => {
    const w = await world();
    w.p.setMailFail(true);
    const r = await w.register({});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.consent.sent, false);
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken))[0].consent.mail_failed, true);
    w.p.setMailFail(false);
    // The coordinator resends (and gets the link to share).
    const re = ok(await portal(w.p, 'post', '/portal/consent/resend', w.ptoken, { inscription_id: r.body.id }));
    assert.ok(re.sent && /#t=[0-9a-f]{32}$/.test(re.link));
    assert.strictEqual((await portal(w.p, 'post', '/portal/consent/resend', w.ptoken, { inscription_id: r.body.id })).status, 429, 'once a minute');
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken))[0].consent.mail_failed, false);
    // Settings validation.
    assert.strictEqual((await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, policy_url: 'javascript:alert(1)' } })).status, 400);
    assert.strictEqual((await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, text_general: '' } })).status, 400);
    assert.strictEqual((await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, purge_days: -1 } })).status, 400);
    // Off: nothing changes for a conference that never turned it on.
    const off = await world({ enable: false });
    const r2 = await off.register({ email: '', health_conditions: { answer: 'none' } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.consent, undefined);
    assert.ok(!('consent' in ok(await portal(off.p, 'get', '/portal/inscriptions', off.ptoken))[0]));
    ok(await off.p.call('put', `/inscriptions/${r2.body.id}`, { body: { status: 'active' } }));
});

test('each signature names the policy version in force; a signed version cannot change its texts', async () => {
    const w = await world();
    const C = require(path.join(PLUGIN_DIR, 'server/consent.js'));
    // Before anyone signs, the texts can still be corrected under 1.0.
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, text_image: 'Autorizo el uso de mi imagen en fotos y videos del evento.' } }));
    const sign = async (first: string, email: string, ck: string) => {
        const id = (await w.register({ first_name: first, email })).body.id as number;
        const token = w.linkToken(email)!;
        ok(await w.pub('code', { token }, ck));
        ok(await w.pub('confirm', { token, code: w.lastCode(email), ...GRANT }, ck));
        return w.events(id).find(e => e.kind === 'granted');
    };
    const g1 = await sign('Ana', 'ana.perez@example.org', 'ck-1');
    const snap1 = w.p.one(`SELECT * FROM ${PREFIX}consent_policies WHERE policy_sha256 = ?`, g1.policy_sha256);
    assert.ok(snap1, 'the version signed is kept');
    assert.strictEqual(g1.policy_version, '1.0');
    assert.strictEqual(C.policyHashOf(JSON.parse(snap1.body)), g1.policy_sha256, 'its SHA-256 is that of the snapshot');
    assert.strictEqual(JSON.parse(snap1.body).text_image, 'Autorizo el uso de mi imagen en fotos y videos del evento.');
    assert.deepStrictEqual(JSON.parse(g1.data).policy, { url: 'https://example.org/politica-de-datos', version: '1.0', sha256: g1.policy_sha256, snapshot_id: Number(snap1.id) });
    // 1.0 is signed: changing what it says under the same number is refused (texts, address, controller, contact)…
    for (const body of [{ text_general: 'Otro texto {conferencia}.' }, { policy_url: 'https://example.org/otra' }, { responsible: 'Otra entidad' }, { contact_email: 'otro@example.org' }]) {
        const r = await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, ...body } });
        assert.strictEqual(r.status, 409, JSON.stringify(body));
    }
    // …anything else still saves, and so does the same text again.
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, purge_days: 45, responsible: 'La iglesia en Barranquilla' } }));
    // A new version opens: the next signer names 1.1, the first keeps 1.0.
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, policy_version: '1.1', text_general: 'Autorizo a {responsable} a tratar mis datos para «{conferencia}» (v1.1).' } }));
    const g2 = await sign('Luis', 'luis@example.org', 'ck-2');
    assert.strictEqual(g2.policy_version, '1.1');
    assert.notStrictEqual(g2.policy_sha256, g1.policy_sha256);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}consent_policies WHERE conference_id = ?`, w.cid).n, 2);
    assert.ok(JSON.parse(g2.data).text.includes('(v1.1)'));
    // A second signer of the same version reuses its snapshot.
    const g3 = await sign('Eva', 'eva@example.org', 'ck-3');
    assert.strictEqual(g3.policy_sha256, g2.policy_sha256);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}consent_policies WHERE conference_id = ?`, w.cid).n, 2);
    // The export carries the version each person signed, verifiable; the chain covers policy_sha256 too.
    const ex = ok(await w.p.call('get', `/consent/evidence/${g1.inscription_id}`));
    assert.strictEqual(ex.chain_ok, true);
    assert.deepStrictEqual(ex.policies.map((x: any) => [x.policy_version, x.policy_sha256, x.sha256_ok]), [['1.0', g1.policy_sha256, true]]);
    w.p.exec(`UPDATE ${PREFIX}consent_events SET policy_sha256 = ? WHERE id = ?`, g2.policy_sha256, g1.id);
    assert.strictEqual(ok(await w.p.call('get', `/consent/evidence/${g1.inscription_id}`)).chain_ok, false, 'swapping the version breaks the chain');
    // The confirmation e-mail names it.
    const mail = [...w.p.mails].reverse().find((m: any) => m.to === 'ana.perez@example.org' && /registrada/.test(m.subject));
    assert.ok(mail.text.includes(g1.policy_sha256));
});

test('«Copiar mensaje»: a new link to share by hand — no e-mail, not marked e-mailed, logged, signing unchanged', async () => {
    const w = await world({ extra: ['phone'] });
    w.p.setMailFail(true);
    const r = await w.register({ phone: '+57 300 123 4567' });
    const id = r.body.id as number;
    assert.strictEqual(r.body.consent.sent, false);
    w.p.setMailFail(false);
    const mailsBefore = w.p.mails.length;
    const before = w.p.one(`SELECT link_sent_s, mail_failed FROM ${PREFIX}consent_requests WHERE inscription_id = ?`, id);
    // Admin.
    const share = ok(await w.p.call('post', '/consent/share', { body: { inscription_id: id } }));
    assert.ok(/\/portal\/conference\/autorizacion#t=[0-9a-f]{32}$/.test(share.link), share.link);
    assert.deepStrictEqual({ v: share.policy_version, url: share.policy_url, days: share.link_days, phone: share.phone, wa: share.phone_wa, name: share.first_name, conf: share.conference, email: share.email_masked },
        { v: '1.0', url: 'https://example.org/politica-de-datos', days: 14, phone: '+573001234567', wa: '573001234567', name: 'Ana', conf: 'Asume el Riesgo', email: 'a***@e***.org' });
    assert.strictEqual(w.p.mails.length, mailsBefore, 'no e-mail leaves');
    assert.deepStrictEqual({ ...w.p.one(`SELECT link_sent_s, mail_failed FROM ${PREFIX}consent_requests WHERE inscription_id = ?`, id) }, { ...before }, 'not marked as e-mailed');
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken))[0].consent.mail_failed, true, 'the coordinator still sees the e-mail failed');
    const shared = w.events(id).filter(e => e.kind === 'link_shared');
    assert.strictEqual(shared.length, 1);
    assert.deepStrictEqual({ via: JSON.parse(shared[0].data).via, channel: JSON.parse(shared[0].data).channel, actor: shared[0].actor }, { via: 'admin', channel: 'manual', actor: 'boss' });
    // Coordinator: its own location only; the new link replaces the previous one.
    const p2 = ok(await portal(w.p, 'post', '/portal/consent/share', w.ptoken, { inscription_id: id }));
    assert.notStrictEqual(p2.link, share.link);
    const oldToken = share.link.split('#t=')[1], token = p2.link.split('#t=')[1];
    assert.strictEqual((await w.pub('open', { token: oldToken })).status, 410, 'the previous link stops working');
    assert.strictEqual(JSON.parse(w.events(id).filter(e => e.kind === 'link_shared')[1].data).via, 'portal');
    assert.strictEqual((await portal(w.p, 'post', '/portal/consent/share', w.ptoken, { inscription_id: 999 })).status, 404);
    // Signing is unchanged: the code goes to the e-mail, and then the coordinator can no longer share.
    ok(await w.pub('open', { token }));
    ok(await w.pub('code', { token }));
    assert.ok(w.lastCode(), 'the code was e-mailed');
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT }));
    assert.strictEqual((await portal(w.p, 'post', '/portal/consent/share', w.ptoken, { inscription_id: id })).status, 409);
    // Off, or without the section: refused.
    const staff = { id: 78, role: 'conference_manager_team', userLogin: 'viewer', extra: { pluginCapabilities: ['conference_manager_access'] } };
    assert.strictEqual((await w.p.call('post', '/consent/share', { body: { inscription_id: id }, user: staff as any })).status, 403);
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, enabled: false } }));
    assert.strictEqual((await w.p.call('post', '/consent/share', { body: { inscription_id: id } })).status, 409);
});

test('phones (2.33.2): E.164 on write, the conference default for national numbers, WhatsApp digits, legacy rows read on the fly', async () => {
    const P = require(path.join(PLUGIN_DIR, 'server/phone.js'));
    // The rules.
    assert.strictEqual(P.toE164('+57 300 123 4567', 'CO'), '+573001234567');
    assert.strictEqual(P.toE164('300 123 4567', 'CO'), '+573001234567');
    assert.strictEqual(P.toE164('0057 300 123 4567', 'CO'), '+573001234567');
    assert.strictEqual(P.toE164('573001234567', 'CO'), '+573001234567', 'a code already there is not added twice');
    assert.strictEqual(P.toE164('020 7946 0958', 'GB'), '+442079460958', 'the trunk 0 goes');
    assert.strictEqual(P.toE164('(305) 555-0100', 'US'), '+13055550100');
    assert.strictEqual(P.toE164('099 123 4567', 'EC'), '+593991234567');
    for (const bad of ['12', 'abc', '+57', '+1234567890123456', '300-ABC']) assert.strictEqual(P.toE164(bad, 'CO'), null, bad);
    assert.deepStrictEqual(P.parseE164('+18095551234', 'DO'), { iso: 'DO', dial: '1', national: '8095551234' });
    assert.strictEqual(P.parseE164('+18095551234').iso, 'US', 'a shared code reads as its primary country');
    assert.strictEqual(P.waDigits('+57 300 123 4567', 'EC'), '573001234567', 'a stored code wins over the default');
    assert.strictEqual(P.waDigits('300 123 4567', 'CO'), '573001234567');

    const w = await world({ extra: ['phone'] });
    // Admin and portal writes store E.164; a bad number is refused in place.
    const r1 = await w.register({ phone: '300 123 4567' });
    assert.strictEqual(w.p.one(`SELECT phone FROM ${PREFIX}inscriptions WHERE id = ?`, r1.body.id).phone, '+573001234567');
    assert.strictEqual((await w.register({ email: 'x@example.org', phone: '12' })).status, 400);
    const a = ok(await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Li', last_name: 'Wei', email: 'li@example.org', location_id: w.norte, phone: '+1 (305) 555-0100' } }));
    assert.strictEqual(w.p.one(`SELECT phone FROM ${PREFIX}inscriptions WHERE id = ?`, a.id).phone, '+13055550100');
    // The default country: validated, stored, used for national numbers from then on.
    assert.strictEqual((await w.p.call('put', `/${w.cid}`, { body: { phone_country: 'ZZ' } })).status, 400);
    ok(await w.p.call('put', `/${w.cid}`, { body: { phone_country: 'ec' } }));
    assert.strictEqual(w.p.one(`SELECT phone_country FROM ${PREFIX}conferences WHERE id = ?`, w.cid).phone_country, 'EC');
    assert.ok(ok(await w.p.call('get', '/public/list', { anonymous: true })).some((c: any) => c.id === w.cid && c.phone_country === 'EC'), 'the portal learns the default');
    ok(await w.p.call('put', `/inscriptions/${a.id}`, { body: { phone: '099 123 4567' } }));
    assert.strictEqual(w.p.one(`SELECT phone FROM ${PREFIX}inscriptions WHERE id = ?`, a.id).phone, '+593991234567');
    // An older row without a code is never rewritten; WhatsApp reads it with the default.
    w.p.exec(`UPDATE ${PREFIX}inscriptions SET phone = '0991234567' WHERE id = ?`, r1.body.id);
    const share = ok(await w.p.call('post', '/consent/share', { body: { inscription_id: r1.body.id } }));
    assert.strictEqual(share.phone, '0991234567');
    assert.strictEqual(share.phone_wa, '593991234567');
    assert.strictEqual(w.p.one(`SELECT phone FROM ${PREFIX}inscriptions WHERE id = ?`, r1.body.id).phone, '0991234567', 'read, not rewritten');
    // A phone half typed never fails the live quote.
    assert.strictEqual((await w.p.call('post', '/public/quote', { anonymous: true, body: { conference_id: w.cid, fields: { phone: '30' } } })).status, 200);
    // The selector's flags (images: Windows has no flag emoji), a batch at a time, unknown codes left out.
    const flags = ok(await w.p.call('get', '/public/flags?iso=CO,ec,ZZ,xx1,CO', { anonymous: true })).flags;
    assert.deepStrictEqual(Object.keys(flags).sort(), ['CO', 'EC']);
    assert.ok(flags.CO.startsWith('<svg') && !/<script|\son[a-z]+=/i.test(flags.CO));
    const many = P.COUNTRIES.map((c: any) => c.iso).join(',');
    assert.strictEqual(Object.keys(ok(await w.p.call('get', `/public/flags?iso=${many}`, { anonymous: true })).flags).length, 48, 'at most 48 per request');
    // Badge WhatsApp links follow the default once chosen.
    const links = ok(await w.p.call('post', '/badges/links', { body: { conference_id: w.cid, inscription_id: a.id } }));
    assert.strictEqual(links.country_code, '593');
});
