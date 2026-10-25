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
        general_verbal_consent: true, // 2.36.10: the coordinator ticks the person's verbal authorization
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

test('with consent on, a portal registration checks a written e-mail, stays pending and cannot be confirmed; health needs the verbal tick', async () => {
    const w = await world();
    // 2.34.0: the portal gets the health field, marked as needing the person's verbal authorization.
    const fields = ok(await w.p.call('get', `/public/fields?conference_id=${w.cid}`, { anonymous: true }));
    assert.strictEqual(fields.find((f: any) => f.name === 'health_conditions').verbal_consent, true);
    assert.strictEqual((await w.register({ email: 'no-es-correo' })).status, 400, 'an e-mail written must be valid');
    const noTick = await w.register({ health_conditions: { answer: 'none' } });
    assert.strictEqual(noTick.status, 400, 'no health without the verbal tick');
    assert.strictEqual(noTick.body.field, 'health_verbal_consent');
    const r = await w.register({});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.consent, { state: 'pending', sent: true, email_masked: 'a***@e***.org' });
    const id = r.body.id as number;
    assert.ok(w.linkToken(), 'the link was mailed');
    // The admin cannot confirm it, nor write health for it.
    const put = await w.p.call('put', `/inscriptions/${id}`, { body: { status: 'active' } });
    assert.strictEqual(put.status, 409);
    assert.strictEqual(put.body.code, 'consent_pending');
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id}`, { body: { health_conditions: { answer: 'none' } } })).status, 400, 'the admin too needs the verbal tick');
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
    // 2.36.10: the coordinator's registration records the person's verbal authorization of the personal data.
    assert.deepStrictEqual(w.events(id).map(e => e.kind), ['link_sent', 'verbal_granted', 'otp_sent', 'otp_sent', 'otp_sent', 'otp_sent', 'otp_sent']);
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
    // 2.36.10: the verbal authorization of the personal data, then confirmed by the signature.
    assert.deepStrictEqual(ev.map(e => e.kind), ['link_sent', 'verbal_granted', 'otp_sent', 'otp_verified', 'granted', 'verbal_confirmed']);
    const g = ev.find(e => e.kind === 'granted');
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
    const a = ok(await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Li', last_name: 'Wei', email: 'li@example.org', location_id: w.norte, phone: '+1 (305) 555-0100', general_verbal_consent: true } }));
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

test('no e-mail on file (2.33.3): «Copiar mensaje» still works, the page asks for one, the code and the evidence use it', async () => {
    const w = await world();
    const id = (await w.register({})).body.id as number;
    // The person's e-mail is gone (registered before consent was asked, or cleared).
    w.p.exec(`UPDATE ${PREFIX}inscriptions SET email = '' WHERE id = ?`, id);
    w.p.exec(`UPDATE ${PREFIX}consent_requests SET email = NULL WHERE inscription_id = ?`, id);
    const share = ok(await portal(w.p, 'post', '/portal/consent/share', w.ptoken, { inscription_id: id }));
    assert.strictEqual(share.email_masked, '');
    assert.strictEqual(JSON.parse(w.events(id).filter(e => e.kind === 'link_shared').pop().data).email_on_file, false);
    const token = share.link.split('#t=')[1];
    const view = ok(await w.pub('open', { token })).view;
    assert.strictEqual(view.needs_email, true);
    // The e-mail is checked before any code leaves; then the code goes to it.
    const bad = await w.pub('code', { token, email: 'not-an-email' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.field, 'email');
    ok(await w.pub('code', { token, email: 'Nueva.Persona@Example.org' }));
    const code = w.lastCode('nueva.persona@example.org');
    assert.ok(code, 'the code went to the typed e-mail');
    assert.strictEqual(JSON.parse(w.events(id).filter(e => e.kind === 'otp_sent').pop().data).email_source, 'typed_on_page');
    ok(await w.pub('confirm', { token, code, ...GRANT }));
    const g = w.events(id).find(e => e.kind === 'granted');
    assert.strictEqual(g.email, 'nueva.persona@example.org');
    assert.deepStrictEqual({ v: JSON.parse(g.data).verified_email, s: JSON.parse(g.data).email_source }, { v: 'nueva.persona@example.org', s: 'typed_on_page' });
    // It fills the empty e-mail field and the request; the copy goes to it.
    assert.strictEqual(w.p.one(`SELECT email FROM ${PREFIX}inscriptions WHERE id = ?`, id).email, 'nueva.persona@example.org');
    assert.strictEqual(w.p.one(`SELECT email FROM ${PREFIX}consent_requests WHERE inscription_id = ?`, id).email, 'nueva.persona@example.org');
    assert.ok(w.p.mails.some((m: any) => m.to === 'nueva.persona@example.org' && /registrada/.test(m.subject)));
    // With an e-mail on file, a typed one is ignored: the code still goes to the e-mail on file.
    const other = (await w.register({ first_name: 'Eva', email: 'eva@example.org' })).body.id as number;
    const t2 = w.linkToken('eva@example.org')!;
    assert.strictEqual(ok(await w.pub('open', { token: t2 })).view.needs_email, false);
    ok(await w.pub('code', { token: t2, email: 'intruso@example.org' }, 'ck-eva'));
    assert.ok(w.lastCode('eva@example.org') && !w.lastCode('intruso@example.org'));
    assert.ok(other);
});

test('the e-mail field is found by its label too (a custom «Correo electrónico» field, 2.33.3)', async () => {
    const C = require(path.join(PLUGIN_DIR, 'server/consent.js'));
    const yes = () => true;
    assert.strictEqual(C.emailFieldIn([{ name: 'f_a', label: 'Correo electrónico', type: 'text' }], yes).name, 'f_a');
    assert.strictEqual(C.emailFieldIn([{ name: 'f_b', label: 'E-mail', type: 'text' }], yes).name, 'f_b');
    assert.strictEqual(C.emailFieldIn([{ name: 'f_c', label: 'Correos enviados', type: 'select' }], yes), null);
    const p = await bootPlugin();
    const cid = ok(await p.call('post', '/create', { body: { name: 'Otra', slug: `dc-mail-${Date.now()}`, date_start: '2030-01-10', date_end: '2030-01-12' } })).id as number;
    ok(await p.call('post', '/fields', { body: { conference_id: cid, template: 'first_name' } }));
    const f = ok(await p.call('post', '/fields', { body: { conference_id: cid, label: 'Correo electrónico', type: 'text' } }));
    const col = p.one(`SELECT name FROM ${PREFIX}fields WHERE conference_id = ? AND label = 'Correo electrónico'`, cid).name;
    ok(await p.call('put', '/consent/settings', { body: { conference_id: cid, enabled: true } }));
    const r = ok(await p.call('post', '/inscriptions', { body: { conference_id: cid, first_name: 'Ana', [col]: 'ana@example.org', general_verbal_consent: true } }));
    assert.strictEqual(r.consent.email_masked, 'a***@e***.org');
    assert.ok(p.mails.some((m: any) => m.to === 'ana@example.org'));
    assert.ok(f);
});

test('e-mail language (2.33.4): the site language by default, the setting when chosen; e-mails, page and copied message follow it', async () => {
    const M = require(path.join(PLUGIN_DIR, 'server/consent-mail.js'));
    // The templates, every language, values escaped and the signed text quoted as signed.
    const ev = { general: 1, health: 0, image: 1, at_utc: '2030-01-01T00:00:00.000Z', text_sha256: 'abc' };
    const d = { subject: { name: 'Ana <b>' }, representative: null, policy: { version: '1.0', url: 'https://x.example/p', sha256: 'def' }, text: 'Autorizo a …', contact: 'datos@x.example' };
    const subjects = { es: 'Autorización registrada', en: 'Consent recorded', pt: 'Autorização registrada' } as Record<string, string>;
    for (const l of ['es', 'en', 'pt']) {
        const m = M.confirmationMail(l, { conference: 'Asume', ev, d });
        assert.ok(m.subject.startsWith(subjects[l]), `${l}: ${m.subject}`);
        assert.ok(m.text.includes('Autorizo a …'), 'the signed text stays as signed');
        assert.ok(m.html.includes('Ana &lt;b&gt;') && !m.html.includes('Ana <b>'), 'escaped');
        assert.ok(M.linkMail(l, { conference: 'Asume', name: 'Ana', link: 'https://x.example/l', days: 14 }).text.includes('https://x.example/l'));
        assert.ok(M.codeMail(l, { conference: 'Asume', code: '123456' }).subject.includes('123456'));
    }
    assert.strictEqual(M.langOf('pt_BR'), 'pt');
    assert.strictEqual(M.langOf('fr_FR'), null);

    const w = await world();
    const codeTo = (to: string) => [...w.p.mails].reverse().find((m: any) => m.to === to && /\d{6}/.test(m.subject));
    // No setting, no site language: Spanish.
    let st = ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings;
    assert.deepStrictEqual([st.email_lang, st.site_lang, st.mail_lang], ['', 'es', 'es']);
    // The site's language (WPLANG) is the default.
    w.p.setOption('WPLANG', 'en_US');
    st = ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings;
    assert.deepStrictEqual([st.email_lang, st.site_lang, st.mail_lang], ['', 'en', 'en']);
    const id1 = (await w.register({ first_name: 'Ann', email: 'ann@example.org' })).body.id as number;
    assert.ok(w.p.mails.some((m: any) => m.to === 'ann@example.org' && m.subject.startsWith('Consent to the use of your data')));
    const t1 = w.linkToken('ann@example.org')!;
    assert.strictEqual(ok(await w.pub('open', { token: t1 })).view.lang, 'en');
    ok(await w.pub('code', { token: t1 }, 'ck-ann'));
    assert.ok(codeTo('ann@example.org').subject.startsWith('Your consent code'));
    // The setting wins: Portuguese.
    assert.strictEqual((await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, email_lang: 'fr' } })).status, 400);
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, email_lang: 'pt' } }));
    const id2 = (await w.register({ first_name: 'João', email: 'joao@example.org' })).body.id as number;
    assert.ok(w.p.mails.some((m: any) => m.to === 'joao@example.org' && m.subject.startsWith('Autorize o uso dos seus dados')));
    const t2 = w.linkToken('joao@example.org')!;
    assert.strictEqual(ok(await w.pub('open', { token: t2 })).view.lang, 'pt');
    ok(await w.pub('code', { token: t2 }, 'ck-joao'));
    const c2 = codeTo('joao@example.org');
    assert.ok(c2.subject.startsWith('Seu código de autorização'));
    ok(await w.pub('confirm', { token: t2, code: c2.subject.match(/(\d{6})/)[1], ...GRANT }, 'ck-joao'));
    const done = [...w.p.mails].reverse().find((m: any) => m.to === 'joao@example.org' && /registrada/.test(m.subject));
    assert.ok(done.subject.startsWith('Autorização registrada') && done.text.includes('[Obligatoria]'), 'Portuguese copy; the signed text as signed');
    // The copied message follows it too.
    assert.strictEqual(ok(await w.p.call('post', '/consent/share', { body: { inscription_id: id1 } })).email_lang, 'pt');
    // Changing the language is not a new policy version.
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}consent_policies WHERE conference_id = ?`, w.cid).n, 1);
    assert.ok(id2);
});

test('the plugin-wide default e-mail language (2.33.4): starts as the site language, a conference may override it', async () => {
    const w = await world();
    w.p.setOption('WPLANG', 'en_US');
    // Never set: the site's language.
    assert.deepStrictEqual(ok(await w.p.call('get', '/consent/defaults')), { email_lang: '', site_lang: 'en', effective: 'en' });
    // Set in the plugin: every conference without its own choice follows it.
    assert.strictEqual((await w.p.call('put', '/consent/defaults', { body: { email_lang: 'de' } })).status, 400);
    ok(await w.p.call('put', '/consent/defaults', { body: { email_lang: 'pt' } }));
    let st = ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings;
    assert.deepStrictEqual([st.email_lang, st.plugin_email_lang, st.mail_lang], ['', 'pt', 'pt']);
    (await w.register({ first_name: 'Rui', email: 'rui@example.org' }));
    assert.ok(w.p.mails.some((m: any) => m.to === 'rui@example.org' && m.subject.startsWith('Autorize o uso dos seus dados')));
    // A conference's own choice wins; clearing it goes back to the plugin's.
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, email_lang: 'es' } }));
    st = ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings;
    assert.strictEqual(st.mail_lang, 'es');
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, email_lang: '' } }));
    assert.strictEqual(ok(await w.p.call('get', `/consent/settings?conference_id=${w.cid}`)).settings.mail_lang, 'pt');
    // Back to «the site's»: English again. The plugin row is no conference: the purge and the states ignore it.
    ok(await w.p.call('put', '/consent/defaults', { body: { email_lang: '' } }));
    assert.strictEqual(ok(await w.p.call('get', '/consent/defaults')).effective, 'en');
    assert.deepStrictEqual(ok(await w.p.call('post', '/consent/purge', { body: {} })).purged, []);
    // A role without Configuración cannot change it.
    const staff = { id: 79, role: 'conference_manager_team', userLogin: 'nocfg', extra: { pluginCapabilities: ['conference_manager_access'] } };
    assert.strictEqual((await w.p.call('put', '/consent/defaults', { body: { email_lang: 'es' }, user: staff as any })).status, 403);
});

// ── 2.34.0: the verbal health authorization ──
const DIABETES = { health_conditions: { conditions: ['Diabetes'] }, health_verbal_consent: true };
test('verbal: no answer without the tick; with it, a verbal record (pending written confirmation) and the answer in use at once', async () => {
    const w = await world();
    assert.strictEqual((await w.register({ health_conditions: { conditions: ['Diabetes'] } })).body.field, 'health_verbal_consent');
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers`).n, 0, 'nothing saved without the tick');
    const id = ok(await w.register(DIABETES)).id as number;
    const v = w.events(id).find(e => e.kind === 'verbal_granted' && JSON.parse(e.data || '{}').scope === 'health');
    const d = JSON.parse(v.data);
    assert.strictEqual(d.method, 'verbal');
    assert.strictEqual(d.scope, 'health');
    assert.strictEqual(d.status, 'pending_written_confirmation');
    assert.strictEqual(d.entered_by, 'portal:Norte');
    assert.strictEqual(v.actor, 'portal:Norte');
    assert.strictEqual(v.policy_version, '1.0');
    assert.ok(v.policy_sha256 && v.text_sha256 === sha256(d.statement));
    assert.ok(d.statement.includes('verbalmente') && d.statement.includes('voluntario'));
    const entered = JSON.parse(w.events(id).find(e => e.kind === 'health_entered').data);
    assert.deepStrictEqual({ by: entered.entered_by, via: entered.via, basis: entered.basis }, { by: 'portal:Norte', via: 'portal', basis: 'verbal' });
    assert.ok(!w.events(id).some(e => String(e.data || '').includes('Diabetes')), 'the log never holds the answer');
    // In use at once: the roster (health:view), the meal priority, the states.
    assert.strictEqual(ok(await w.p.call('get', `/inscriptions/${id}`)).health_conditions, 'Diabetes');
    const pr = ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`));
    assert.ok(pr.people.find((p: any) => p.id === id).health_points > 0, 'meal priority uses it');
    const st = ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[id];
    assert.deepStrictEqual([st.state, st.verbal_health, st.verbal_overdue], ['pending', true, false]);
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken))[0].consent.verbal_health, true);
    // The chain stays whole.
    assert.strictEqual(ok(await w.p.call('get', `/consent/evidence/${id}`)).chain_ok, true);
});

test('verbal: the code signature confirms it (linked), or deletes the answer when health is not authorized', async () => {
    const w = await world();
    const id = ok(await w.register(DIABETES)).id as number;
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT }));
    const granted = w.events(id).find(e => e.kind === 'granted');
    const c = JSON.parse(w.events(id).find(e => e.kind === 'verbal_confirmed' && JSON.parse(e.data || '{}').scope !== 'general').data);
    assert.strictEqual(c.confirmed_by_event_id, granted.id);
    assert.strictEqual(c.verbal_event_id, w.events(id).find(e => e.kind === 'verbal_granted' && JSON.parse(e.data || '{}').scope === 'health').id);
    assert.strictEqual(c.method, 'otp');
    assert.strictEqual(ok(await w.p.call('get', `/inscriptions/${id}`)).health_conditions, 'Diabetes', 'the answer stays');
    assert.strictEqual(ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[id].verbal_health, false);
    // Another person signs WITHOUT health: their answer goes, and that is logged.
    const id2 = ok(await w.register({ ...DIABETES, first_name: 'Beto', email: 'beto@example.org' })).id as number;
    const t2 = w.linkToken('beto@example.org')!;
    ok(await w.pub('code', { token: t2 }, 'ck-beto'));
    ok(await w.pub('confirm', { token: t2, code: w.lastCode('beto@example.org'), ...GRANT, health: false }, 'ck-beto'));
    const del = w.events(id2).find(e => e.kind === 'health_deleted');
    assert.strictEqual(JSON.parse(del.data).reason, 'health_not_authorized_in_writing');
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id2).n, 0);
    // A written «no» stands: no verbal statement brings it back.
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id2}`, { body: DIABETES })).status, 409);
    // The person's own answer on the page wins over the one entered for them.
    const id3 = ok(await w.register({ ...DIABETES, first_name: 'Carla', email: 'carla@example.org' })).id as number;
    const t3 = w.linkToken('carla@example.org')!;
    ok(await w.pub('code', { token: t3 }, 'ck-carla'));
    ok(await w.pub('confirm', { token: t3, code: w.lastCode('carla@example.org'), ...GRANT, health_answer: { answer: 'none' } }, 'ck-carla'));
    assert.strictEqual(ok(await w.p.call('get', `/inscriptions/${id3}`)).health_conditions !== 'Diabetes', true);
});

test('verbal: never confirmed within the days is flagged, not deleted; the admin needs «Datos de salud», and the tick', async () => {
    const w = await world();
    const id = ok(await w.register(DIABETES)).id as number;
    // The admin: with the tick, logged as theirs; a role without «Datos de salud › gestionar» cannot.
    const id2 = ok(await w.register({ first_name: 'Beto', email: 'beto@example.org' })).id as number;
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id2}`, { body: { health_conditions: { answer: 'none' } } })).body.field, 'health_verbal_consent');
    ok(await w.p.call('put', `/inscriptions/${id2}`, { body: { health_conditions: { answer: 'none' }, health_verbal_consent: true } }));
    assert.strictEqual(JSON.parse(w.events(id2).find(e => e.kind === 'verbal_granted' && JSON.parse(e.data || '{}').scope === 'health').data).via, 'admin');
    const staff = { id: 79, role: 'conference_manager_team', userLogin: 'nohealth', extra: { pluginCapabilities: ['conference_manager_access'] } };
    assert.notStrictEqual((await w.p.call('put', `/inscriptions/${id2}`, { body: DIABETES, user: staff as any })).status, 200);
    advance(16 * 86400 * 1000);
    let st = ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[id];
    assert.deepStrictEqual([st.verbal_health, st.verbal_overdue], [true, true]);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id).n, 1, 'not deleted');
    // (the portal session expired with the time travel: sign in again)
    const code = w.p.one(`SELECT code FROM ${PREFIX}locations WHERE id = ?`, w.norte).code;
    const fresh = ok(await w.p.call('post', '/portal/login', { anonymous: true, body: { location_id: w.norte, code } })).token as string;
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', fresh))[0].consent.verbal_overdue, true);
    // The days are a setting.
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, verbal_days: 30 } }));
    st = ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[id];
    assert.strictEqual(st.verbal_overdue, false);
    assert.strictEqual((await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, verbal_days: 0 } })).status, 400);
    // The post-conference purge still deletes it all (and leaves no verbal flag).
    advance(5 * 366 * 86400 * 1000); // past the conference (2030) and its purge days
    ok(await w.p.call('post', '/consent/purge', { body: {} }));
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers`).n, 0);
    assert.strictEqual(ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[id].verbal_health, false);
});

// ── 2.35.0: registering without an e-mail ──
test('without an e-mail: the registration is saved, flagged «sin correo», and every e-mail path degrades cleanly', async () => {
    const w = await world();
    const mailsBefore = w.p.mails.length;
    const r = ok(await w.register({ email: '' }));
    assert.deepStrictEqual(r.consent, { state: 'pending', sent: false, email_masked: '', no_email: true });
    assert.strictEqual(w.p.mails.length, mailsBefore, 'nothing to e-mail');
    const id = r.id as number;
    // The coordinator and the admin see «sin correo».
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken))[0].consent.no_email, true);
    assert.deepStrictEqual(ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).no_email, [id]);
    // «Reenviar enlace» has nowhere to go (a clear 400), «Copiar mensaje» works, and the page asks for the e-mail.
    assert.strictEqual((await portal(w.p, 'post', '/portal/consent/resend', w.ptoken, { inscription_id: id })).status, 400);
    const share = ok(await portal(w.p, 'post', '/portal/consent/share', w.ptoken, { inscription_id: id }));
    assert.strictEqual(share.email_masked, '');
    const token = String(share.link.match(/#t=([0-9a-f]{32})/)[1]);
    assert.strictEqual(ok(await w.pub('open', { token })).view.needs_email, true);
    ok(await w.pub('code', { token, email: 'ana.nueva@example.org' }));
    ok(await w.pub('confirm', { token, code: w.lastCode('ana.nueva@example.org'), ...GRANT }));
    assert.deepStrictEqual(ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).no_email, [], 'the typed e-mail fills the form');
    // The CSV export carries the person (an empty e-mail column before, the typed one now).
    const csv = ok(await w.p.call('get', `/inscriptions/export?conference_id=${w.cid}`)).csv as string;
    assert.ok(csv.includes('Ana') && csv.includes('ana.nueva@example.org'));
    // A written e-mail must still be a valid one.
    assert.strictEqual((await w.register({ first_name: 'Beto', email: 'no-es-correo' })).status, 400);
});

test('without an e-mail, the duplicate guard falls back to the name plus the ID document or the phone', async () => {
    const w = await world();
    ok(await w.register({ email: '' }));
    const dup = await w.register({ email: '', first_name: 'ANA', last_name: 'Perez' }); // same person, other spelling
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.ok(/mismo nombre/.test(dup.body.error));
    // Another person with the same name but another document is fine; so is the same one with an e-mail.
    const docCol = (w.p.q(`SELECT name FROM ${PREFIX}fields WHERE conference_id = ? AND label = 'Número de documento'`, w.cid) as any[])[0].name;
    ok(await w.register({ email: '', [docCol]: '9.999.999' }));
    ok(await w.register({ email: 'ana.otra@example.org' }));
    // Cancelled registrations do not count.
    w.p.exec(`UPDATE ${PREFIX}inscriptions SET status = 'cancelled' WHERE conference_id = ? AND ${docCol} = '1.234.567'`, w.cid);
    ok(await w.register({ email: '' }));
});

// ── 2.36.9 «Tipo de sangre» and «EPS»: health data, under the same consent ──────────────────────────────────────

test('2.36.9 blood type and EPS follow the health consent: not saved without it, saved with the verbal tick or the code, wiped on opt-out', async () => {
    const w = await world();
    const extras = (id: number) => w.p.one(`SELECT blood_type, eps FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id);
    // Only a blood type, without the verbal tick: refused, nothing stored.
    const noTick = await w.register({ health_conditions: { blood_type: 'O+' } });
    assert.strictEqual(noTick.status, 400);
    assert.strictEqual(noTick.body.field, 'health_verbal_consent');
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers`).n, 0, 'nothing saved without the authorization');
    // With the tick: saved, and the log names the entry, never the value.
    const id = ok(await w.register({ health_conditions: { answer: 'none', blood_type: 'O+', eps: 'Sura' }, health_verbal_consent: true })).id as number;
    assert.deepStrictEqual({ ...extras(id) }, { blood_type: 'O+', eps: 'Sura' });
    assert.ok(!w.events(id).some(e => /Sura|O\+/.test(String(e.data || ''))), 'the log never holds the answer');
    // Shown (health:view) while the verbal authorization is live.
    assert.match(ok(await w.p.call('get', `/inscriptions/${id}`)).health_conditions, /Tipo de sangre: O\+ · EPS: Sura/);
    // The person signs WITHOUT health: the whole answer goes, the blood type and the EPS with it.
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT, health: false }));
    assert.strictEqual(extras(id), undefined, 'a signature without health deletes them');
    // The person answers them on the consent page (code) with health: saved; revoking health later wipes them.
    const id2 = ok(await w.register({ email: 'luis@example.org', first_name: 'Luis' })).id as number;
    const t2 = w.linkToken('luis@example.org')!;
    ok(await w.pub('code', { token: t2 }, 'ck-luis'));
    ok(await w.pub('confirm', { token: t2, code: w.lastCode('luis@example.org'), ...GRANT, health_answer: { answer: 'declined', blood_type: 'AB−', eps: 'Compensar' } }, 'ck-luis'));
    assert.deepStrictEqual({ ...extras(id2) }, { blood_type: 'AB−', eps: 'Compensar' });
    ok(await w.p.call('post', '/consent/revoke', { body: { inscription_id: id2, health: true, note: 'Pidió borrar su salud' } }));
    assert.strictEqual(extras(id2), undefined, 'revoking health deletes them');
    // A written «no» stands: no verbal tick brings them back.
    const r = await w.p.call('put', `/inscriptions/${id2}`, { body: { health_conditions: { eps: 'Sura' }, health_verbal_consent: true } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(extras(id2), undefined);
});

test('2.36.9 the consent text names the blood type and the EPS; a signed version keeps the text it was signed with', async () => {
    const C = require(path.join(PLUGIN_DIR, 'server/consent.js'));
    assert.match(C.DEFAULTS.text_health, /tipo de sangre y EPS/);
    assert.ok(!/tipo de sangre/.test(C.TEXT_HEALTH_BEFORE_2_36_9), 'the text up to 2.36.8');
    // A new conference on the default shows (and signs) the new text: on the page and on the paper sheet.
    const w = await world();
    const id = (await w.register({})).body.id as number;
    const token = w.linkToken()!;
    const view = ok(await w.pub('open', { token })).view;
    assert.match(JSON.stringify(view), /tipo de sangre y EPS/);
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT }));
    const signedWithNew = w.p.one(`SELECT body FROM ${PREFIX}consent_policies WHERE conference_id = ?`, w.cid).body;
    assert.match(signedWithNew, /tipo de sangre y EPS/);
    // Restarting pins the text that was signed (the new one here) into the settings: a restart never changes it.
    const settings = () => w.p.one(`SELECT text_health FROM ${PREFIX}consent_settings WHERE conference_id = ?`, w.cid).text_health;
    assert.ok(settings() == null || settings() === '', 'on the default before the restart');
    await bootPlugin({ raw: w.p.raw });
    assert.match(settings(), /tipo de sangre y EPS/);
    // A conference that signed the OLD default (before 2.36.9) keeps it under the same version after the upgrade.
    const w2 = await world();
    const id2 = (await w2.register({})).body.id as number;
    const t2 = w2.linkToken()!;
    ok(await w2.pub('code', { token: t2 }));
    ok(await w2.pub('confirm', { token: t2, code: w2.lastCode(), ...GRANT }));
    // What a pre-2.36.9 install holds: the snapshot of that version carries the old text.
    const snap = w2.p.one(`SELECT id, body FROM ${PREFIX}consent_policies WHERE conference_id = ?`, w2.cid);
    const old = { ...JSON.parse(snap.body), text_health: C.TEXT_HEALTH_BEFORE_2_36_9 };
    w2.p.exec(`UPDATE ${PREFIX}consent_policies SET body = ? WHERE id = ?`, JSON.stringify(old), snap.id);
    await bootPlugin({ raw: w2.p.raw });
    assert.strictEqual(w2.p.one(`SELECT text_health FROM ${PREFIX}consent_settings WHERE conference_id = ?`, w2.cid).text_health, C.TEXT_HEALTH_BEFORE_2_36_9);
    // An unsigned conference on the default is left on it (it gets the new text).
    const w3 = await world();
    await bootPlugin({ raw: w3.p.raw });
    const t3 = w3.p.one(`SELECT text_health FROM ${PREFIX}consent_settings WHERE conference_id = ?`, w3.cid).text_health;
    assert.ok(t3 == null || t3 === '', 'nothing signed: still on the default');
    assert.ok(id && id2);
});

// ── 2.36.10 every read of health answers applies the consent filter ───────────────────────────────────────────

test('2.36.10 the edit form read and the meal priority use an answer only while its health authorization is live: pending, verbal, granted, revoked', async () => {
    // Answers given while the conference did not ask for consent; then it starts asking.
    const w = await world({ enable: false });
    const id = (await w.register({ health_conditions: { conditions: ['Diabetes'], blood_type: 'O+' } })).body.id as number;
    const nora = (await w.register({ first_name: 'Nora', email: 'nora@example.org', health_conditions: { conditions: ['Embarazo'] } })).body.id as number;
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, enabled: true, responsible: 'La iglesia en Barranquilla', contact_email: 'datos@example.org', policy_url: 'https://example.org/politica-de-datos', policy_version: '1.0' } }));
    const read = async (pid: number) => ok(await w.p.call('get', `/inscriptions/${pid}/health`)).answer;
    const roster = async (pid: number) => ok(await w.p.call('get', `/inscriptions/${pid}`)).health_conditions;
    const csv = async () => ok(await w.p.call('get', `/inscriptions/export?conference_id=${w.cid}`)).csv as string;
    const priority = async (pid: number) => ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`)).people.find((p: any) => p.id === pid);
    const stored = (pid: number) => w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, pid).n;

    // PENDING (no authorization yet): the answer is kept but used nowhere — not the edit form's read, not the
    // roster, not the export, not the meal priority's score.
    assert.strictEqual(stored(id), 1);
    assert.strictEqual(await read(id), null, 'GET /inscriptions/:id/health hides a pending answer');
    assert.strictEqual(await roster(id), '');
    assert.ok(!(await csv()).includes('Diabetes'));
    assert.strictEqual((await priority(id)).health_points, 0, 'the meal priority does not score it');
    assert.strictEqual((await priority(id)).health_answer, null);
    assert.strictEqual(ok(await w.p.call('get', `/meals/priority?conference_id=${w.cid}`)).health_answered, 0);

    // VERBAL only (the coordinator's tick, pending the written confirmation): in use.
    ok(await w.p.call('put', `/inscriptions/${nora}`, { body: { health_conditions: { conditions: ['Embarazo'] }, health_verbal_consent: true } }));
    assert.deepStrictEqual(await read(nora), { conditions: ['Embarazo'], other: '', answer: 'list' });
    assert.strictEqual(await roster(nora), 'Embarazo');
    assert.ok((await priority(nora)).health_points > 0);

    // GRANTED with health (the code): in use, every part of it. (Ana registered before consent: her link now.)
    ok(await portal(w.p, 'post', '/portal/consent/resend', w.ptoken, { inscription_id: id }));
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT }));
    assert.deepStrictEqual(await read(id), { conditions: ['Diabetes'], other: '', answer: 'list', blood_type: 'O+' });
    assert.strictEqual(await roster(id), 'Diabetes · Tipo de sangre: O+');
    assert.ok((await csv()).includes('Diabetes'));
    assert.ok((await priority(id)).health_points > 0);

    // REVOKED: the answers are deleted; one left behind (say, restored from a backup) is still used nowhere.
    ok(await w.p.call('post', '/consent/revoke', { body: { inscription_id: id, general: true, note: 'Retira su inscripción' } }));
    assert.strictEqual(stored(id), 0);
    w.p.exec(`INSERT INTO ${PREFIX}health_answers (conference_id, inscription_id, answer, conditions, other_text) VALUES (?, ?, 'list', ?, '')`, w.cid, id, JSON.stringify(['Diabetes']));
    assert.strictEqual(await read(id), null);
    assert.strictEqual(await roster(id), '');
    const p = await priority(id);
    assert.ok(!p || p.health_points === 0, 'not scored');
});

test('2.36.10 no read of health answers bypasses the consent filter (source sweep)', () => {
    const files = ['index.js', ...fs.readdirSync(path.join(PLUGIN_DIR, 'server')).map(f => `server/${f}`)].filter(f => f.endsWith('.js') && f !== 'server/health.js');
    const reads: string[] = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
        for (const m of src.matchAll(/^.*\.(answersOf|answersOfConference)\(.*$/gm)) reads.push(`${f}: ${m[0].trim()}`);
    }
    // The two helpers, and the one existence check of the signature flow (it deletes, never shows or scores).
    assert.strictEqual(reads.length, 3, reads.join('\n'));
    assert.ok(reads.some(r => r.startsWith('index.js: const consentedAnswersOf = async (conferenceId, ids) => consentedHealth(conferenceId, await health.answersOf(ids));')), reads.join('\n'));
    assert.ok(reads.some(r => r.startsWith('index.js: const consentedAnswersOfConference = async (conferenceId) => consentedHealth(conferenceId, await health.answersOfConference(conferenceId));')), reads.join('\n'));
    assert.ok(reads.some(r => r.startsWith('server/consent.js:') && r.includes('!healthYes')), reads.join('\n'));
    // The meal priority gets the filtered reader, not the raw module.
    const mp = fs.readFileSync(path.join(PLUGIN_DIR, 'server/meal-priority.js'), 'utf8');
    assert.ok(mp.includes('await D.healthAnswersOfConference(cid)') && !/D\.health\./.test(mp));
});

test('2.36.10 editing a health answer under a live authorization (verbal or written) needs no new tick and is logged; without one, or revoked, it is refused', async () => {
    const w = await world();
    const entries = (pid: number) => w.events(pid).filter(e => e.kind === 'health_entered').map(e => JSON.parse(e.data));
    const verbals = (pid: number) => w.events(pid).filter(e => e.kind === 'verbal_granted' && JSON.parse(e.data || '{}').scope === 'health').length;
    // Verbal authorization recorded at registration (the coordinator's tick).
    const id = ok(await w.register({ health_conditions: { conditions: ['Diabetes'] }, health_verbal_consent: true })).id as number;
    assert.strictEqual(verbals(id), 1);
    // The edit form sees no tick is needed, and an edit saves without one — no second verbal record, one more entry.
    assert.strictEqual(ok(await w.p.call('get', `/inscriptions/${id}/health`)).verbal_required, false);
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { health_conditions: { conditions: ['Diabetes'], blood_type: 'A+' } } }));
    assert.strictEqual(w.p.one(`SELECT blood_type FROM ${PREFIX}health_answers WHERE inscription_id = ?`, id).blood_type, 'A+');
    assert.strictEqual(verbals(id), 1, 'no new verbal authorization');
    assert.deepStrictEqual(entries(id).map(d => [d.basis, d.via]), [['verbal', 'portal'], ['verbal', 'admin']]);
    assert.ok(!w.events(id).some(e => /A\+|Diabetes/.test(String(e.data || ''))), 'the log never holds the answer');
    // Written authorization (the code): edits save, logged as «written».
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT }));
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { health_conditions: { answer: 'none', eps: 'Sura' } } }));
    assert.strictEqual(entries(id).pop().basis, 'written');
    // Clearing is always allowed and logged as a clearing.
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { health_conditions: null } }));
    assert.strictEqual(entries(id).pop().cleared, true);
    // No authorization at all (registered without health): the tick is still needed.
    const nora = ok(await w.register({ first_name: 'Nora', email: 'nora@example.org' })).id as number;
    assert.strictEqual(ok(await w.p.call('get', `/inscriptions/${nora}/health`)).verbal_required, true);
    const noTick = await w.p.call('put', `/inscriptions/${nora}`, { body: { health_conditions: { blood_type: 'O+' } } });
    assert.strictEqual(noTick.status, 400);
    assert.strictEqual(noTick.body.field, 'health_verbal_consent');
    // Revoked: the verbal authorization goes with it, and no edit (nor a new tick) brings the answer back.
    ok(await w.p.call('put', `/inscriptions/${nora}`, { body: { health_conditions: { blood_type: 'O+' }, health_verbal_consent: true } }));
    const tn = w.linkToken('nora@example.org')!;
    ok(await w.pub('code', { token: tn }, 'ck-nora'));
    ok(await w.pub('confirm', { token: tn, code: w.lastCode('nora@example.org'), ...GRANT }, 'ck-nora'));
    ok(await w.p.call('post', '/consent/revoke', { body: { inscription_id: nora, health: true, note: 'Lo pidió' } }));
    assert.strictEqual((await w.p.call('put', `/inscriptions/${nora}`, { body: { health_conditions: { blood_type: 'O+' } } })).status, 409);
    assert.strictEqual((await w.p.call('put', `/inscriptions/${nora}`, { body: { health_conditions: { blood_type: 'O+' }, health_verbal_consent: true } })).status, 409);
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}health_answers WHERE inscription_id = ?`, nora).n, 0);
});

// ── 2.36.10 the verbal authorization of the personal data (staff registrations) ───────────────────────────────

test('2.36.10 a staff registration needs the verbal authorization of the personal data; health data needs the health one too; none without consent on', async () => {
    const w = await world();
    const gv = (pid: number) => w.events(pid).filter(e => e.kind === 'verbal_granted' && JSON.parse(e.data || '{}').scope === 'general');
    // Portal, no tick: refused before anything is written (the field names the box).
    const before = w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}inscriptions`).n;
    const r = await w.register({ general_verbal_consent: false });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'general_verbal_consent');
    assert.strictEqual(w.p.one(`SELECT COUNT(*) AS n FROM ${PREFIX}inscriptions`).n, before, 'nothing written');
    assert.strictEqual((await portal(w.p, 'post', '/portal/inscriptions', w.ptoken, { first_name: 'Sin', last_name: 'Tick', email: 'sin@example.org', age: 30 })).body.field, 'general_verbal_consent', 'the key missing');
    // Admin, no tick: refused too.
    const a = await w.p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Li', last_name: 'Wei', email: 'li@example.org', location_id: w.norte } });
    assert.deepStrictEqual([a.status, a.body.field], [400, 'general_verbal_consent']);
    // No health data: only the personal-data box — no health tick is asked.
    const id = ok(await w.register({})).id as number;
    const ev = gv(id);
    assert.strictEqual(ev.length, 1);
    const d = JSON.parse(ev[0].data);
    assert.deepStrictEqual([d.method, d.scope, d.status, d.entered_by, d.via, ev[0].actor, ev[0].general, ev[0].policy_version], ['verbal', 'general', 'pending_written_confirmation', 'portal:Norte', 'portal', 'portal:Norte', 1, '1.0']);
    assert.ok(d.statement.includes('verbalmente') && d.statement.includes('datos personales'));
    assert.strictEqual(ev[0].text_sha256, sha256(d.statement));
    assert.deepStrictEqual({ name: d.subject.name }, { name: 'Ana Pérez' });
    // It shows in the person's consent record (the admin's states, the portal's list).
    const st = ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[id];
    assert.deepStrictEqual([st.state, st.verbal_general, st.verbal_general_by, !!st.verbal_general_at, st.verbal_health], ['pending', true, 'portal:Norte', true, false]);
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/inscriptions', w.ptoken)).find((x: any) => x.id === id).consent.verbal_general, true);
    assert.strictEqual(ok(await portal(w.p, 'get', '/portal/me', w.ptoken)).consent_verbal_general, true);
    // Health data: the health box is required as well (both ticks).
    const h1 = await w.register({ first_name: 'Beto', email: 'beto@example.org', health_conditions: { eps: 'Sura' } });
    assert.deepStrictEqual([h1.status, h1.body.field], [400, 'health_verbal_consent']);
    const h2 = await w.register({ first_name: 'Beto', email: 'beto@example.org', general_verbal_consent: false, health_conditions: { eps: 'Sura' }, health_verbal_consent: true });
    assert.deepStrictEqual([h2.status, h2.body.field], [400, 'general_verbal_consent']);
    const beto = ok(await w.register({ first_name: 'Beto', email: 'beto@example.org', health_conditions: { eps: 'Sura' }, health_verbal_consent: true })).id as number;
    const scopes = w.events(beto).filter(e => e.kind === 'verbal_granted').map(e => JSON.parse(e.data).scope);
    assert.deepStrictEqual(scopes, ['general', 'health']);
    // Editing a registered person never asks for the personal-data box again.
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { last_name: 'Pérez Gómez' } }));
    assert.strictEqual(gv(id).length, 1, 'no second verbal record');

    // The written signature (code) confirms it, linked; the record no longer shows it waiting.
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT }));
    const conf = w.events(id).filter(e => e.kind === 'verbal_confirmed').map(e => JSON.parse(e.data)).find(x => x.scope === 'general');
    assert.deepStrictEqual([conf.verbal_event_id, conf.confirmed_by_event_id, conf.method, conf.verbal_entered_by], [ev[0].id, w.events(id).find(e => e.kind === 'granted').id, 'otp', 'portal:Norte']);
    assert.strictEqual(ok(await w.p.call('get', `/consent/states?conference_id=${w.cid}`)).states[id].verbal_general, false);
    assert.strictEqual(ok(await w.p.call('get', `/consent/evidence/${id}`)).chain_ok, true);

    // A conference that does not ask for consent: no box, no record.
    const off = await world({ enable: false });
    const plain = await portal(off.p, 'post', '/portal/inscriptions', off.ptoken, { first_name: 'Ana', last_name: 'Pérez', email: 'ana@example.org', age: 34 });
    assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
    assert.strictEqual(ok(await portal(off.p, 'get', '/portal/me', off.ptoken)).consent_verbal_general, false);
    assert.strictEqual(ok(await off.p.call('post', '/inscriptions', { body: { conference_id: off.cid, first_name: 'Li', last_name: 'Wei', email: 'li@example.org', location_id: off.norte } })).success, true);
});

test('2.36.10 the paper signature confirms the verbal authorization of the personal data; revoking everything clears it', async () => {
    const w = await world();
    const id = ok(await w.register({})).id as number;
    // Paper: create a sheet and tick the person.
    const sheet = ok(await portal(w.p, 'post', '/portal/consent/paper', w.ptoken, { action: 'create' })).sheet;
    ok(await portal(w.p, 'post', '/portal/consent/paper', w.ptoken, { action: 'upload', sheet_id: sheet.id, data_url: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), crypto.randomBytes(80)]).toString('base64')}` }));
    ok(await portal(w.p, 'post', '/portal/consent/paper', w.ptoken, { action: 'marks', sheet_id: sheet.id, marks: [{ inscription_id: id }] }));
    const conf = w.events(id).filter(e => e.kind === 'verbal_confirmed').map(e => JSON.parse(e.data)).find(x => x.scope === 'general');
    assert.strictEqual(conf.method, 'paper');
    // A second registration, revoked as a whole before any signature is not possible (409: nothing granted); after a
    // code signature, revoking everything leaves nothing verbal behind.
    const id2 = ok(await w.register({ first_name: 'Luis', email: 'luis@example.org' })).id as number;
    const t2 = w.linkToken('luis@example.org')!;
    ok(await w.pub('code', { token: t2 }, 'ck-luis'));
    ok(await w.pub('confirm', { token: t2, code: w.lastCode('luis@example.org'), ...GRANT }, 'ck-luis'));
    ok(await w.p.call('post', '/consent/revoke', { body: { inscription_id: id2, general: true, note: 'Lo pidió por correo' } }));
    const row = w.p.one(`SELECT vgeneral_s, verbal_s, state FROM ${PREFIX}consent_requests WHERE inscription_id = ?`, id2);
    assert.deepStrictEqual([row.vgeneral_s, row.verbal_s, row.state], [null, null, 'revoked']);
});

test('2.36.10 editing: a recorded authorization cannot be cleared; with none recorded (legacy) changing the data needs the personal tick, then recorded; the history shows the authorization events', async () => {
    // Registered while the conference did not ask for consent (a legacy person); then it starts asking.
    const w = await world({ enable: false });
    const id = (await w.register({ health_conditions: { conditions: ['Diabetes'] } })).body.id as number;
    ok(await w.p.call('put', '/consent/settings', { body: { conference_id: w.cid, enabled: true, responsible: 'La iglesia en Barranquilla', contact_email: 'datos@example.org', policy_url: 'https://example.org/politica-de-datos', policy_version: '1.0' } }));
    assert.deepStrictEqual(ok(await w.p.call('get', `/consent/authorization/${id}`)), { enabled: true, revoked: false, general: null, health: null });
    // Changing their data without the tick: refused; a status-only change is not a data change.
    const no = await w.p.call('put', `/inscriptions/${id}`, { body: { last_name: 'Pérez Ruiz' } });
    assert.deepStrictEqual([no.status, no.body.field], [400, 'general_verbal_consent']);
    assert.strictEqual(w.p.one(`SELECT last_name FROM ${PREFIX}inscriptions WHERE id = ?`, id).last_name, 'Pérez', 'nothing written');
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { notes: 'Llamar' } }));
    // With the tick: saved and recorded (scope general, by the admin).
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { last_name: 'Pérez Ruiz', general_verbal_consent: true } }));
    const gv = w.events(id).filter(e => e.kind === 'verbal_granted').map(e => JSON.parse(e.data));
    assert.deepStrictEqual(gv.map(d => [d.scope, d.via]), [['general', 'admin']]);
    assert.strictEqual(ok(await w.p.call('get', `/consent/authorization/${id}`)).general, 'verbal');
    // Now recorded: no tick asked, and it cannot be cleared here (409 — «Revocar» does that).
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { last_name: 'Pérez' } }));
    const clear = await w.p.call('put', `/inscriptions/${id}`, { body: { last_name: 'X', general_verbal_consent: false } });
    assert.deepStrictEqual([clear.status, clear.body.field], [409, 'general_verbal_consent']);
    // Health: the legacy answer needs the health tick (with the data sent), then recorded and locked too.
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { health_conditions: { conditions: ['Diabetes'] }, health_verbal_consent: true } }));
    assert.strictEqual(ok(await w.p.call('get', `/consent/authorization/${id}`)).health, 'verbal');
    assert.strictEqual((await w.p.call('put', `/inscriptions/${id}`, { body: { health_verbal_consent: false } })).status, 409);
    // Written (the code): 'written', still locked.
    ok(await portal(w.p, 'post', '/portal/consent/resend', w.ptoken, { inscription_id: id }));
    const token = w.linkToken()!;
    ok(await w.pub('code', { token }));
    ok(await w.pub('confirm', { token, code: w.lastCode(), ...GRANT }));
    assert.deepStrictEqual(ok(await w.p.call('get', `/consent/authorization/${id}`)), { enabled: true, revoked: false, general: 'written', health: 'written' });
    // The «Historial» lists the authorization events (personal and health) — never the e-mail or an answer.
    const h = ok(await w.p.call('get', `/inscriptions/${id}/history`));
    const k = h.entries.map((e: any) => e.kind + (e.scope ? `:${e.scope}` : ''));
    for (const x of ['consent_verbal_granted:general', 'consent_verbal_granted:health', 'consent_granted', 'consent_verbal_confirmed:general', 'consent_verbal_confirmed:health', 'consent_link_sent']) assert.ok(k.includes(x), `${x} in ${k.join(', ')}`);
    assert.ok(!JSON.stringify(h).includes('ana.perez@example.org') && !JSON.stringify(h).includes('Diabetes'));
    assert.strictEqual(h.entries.find((e: any) => e.kind === 'consent_granted').method, 'otp');
    // The portal's history has no health events.
    const r = w.p.routes.find((x: any) => x.method === 'get' && x.path === '/portal/inscriptions/:id/history') as any;
    const res: any = { statusCode: 200, _body: undefined, status(c: number) { this.statusCode = c; return this; }, json(x: any) { this._body = JSON.parse(JSON.stringify(x)); return this; }, cookie() { return this; }, clearCookie() { return this; }, setHeader() { return this; } };
    await r.handler({ params: { id: String(id) }, query: {}, body: {}, headers: { 'x-portal-token': w.ptoken }, cookies: {}, user: null }, res);
    assert.ok(res._body.entries.every((e: any) => e.scope !== 'health'), JSON.stringify(res._body.entries));
    // Revoked everything: not asked again (a written «no» is not overridden), edits of other data still allowed.
    ok(await w.p.call('post', '/consent/revoke', { body: { inscription_id: id, general: true, note: 'Lo pidió' } }));
    assert.strictEqual(ok(await w.p.call('get', `/consent/authorization/${id}`)).revoked, true);
    ok(await w.p.call('put', `/inscriptions/${id}`, { body: { last_name: 'Pérez Gómez' } }));
});

// ── 2.36.11 «Plantillas de correo» and the coordinator's welcome ─────────────────────────────────────────────

test('2.36.11 the templates: a safe markup (never HTML), values escaped after the markup is read, the link/code/record drawn by the layout, a text alternative', () => {
    const MT = require(path.join(PLUGIN_DIR, 'server/mail-templates.js'));
    assert.deepStrictEqual(MT.DEFS.map((d: any) => d.id), ['consent.link', 'consent.code', 'consent.confirmation', 'badge.link', 'location.welcome']);
    for (const d of MT.DEFS) for (const l of ['es', 'en', 'pt']) assert.ok(d.subject[l] && d.body[l] && d.name[l], `${d.id} ${l}`);
    const edit = {
        subject: 'Hola {name} <script>',
        body: 'Hola **{name}**: <b>no es html</b> <script>alert(1)</script>\n\n- uno\n- [la política](https://example.org/p?a=1&b=2)\n- [mal](javascript:alert(1))\n\nContacto: {conference}',
        after: 'Fin.', action: 'Ir',
    };
    const m = MT.renderMessage('consent.link', 'es', { name: '<img src=x onerror=1> **x** [y](https://evil.example)', conference: '', days: '14' }, { action: { url: 'https://site.example/portal/conference/autorizacion#t=abc&x=1' } }, edit, { site: 'Iglesia <i>' });
    // Typed tags are text; markup works; a javascript: link is not a link; a value never becomes markup or a link.
    assert.ok(m.html.includes('&lt;b&gt;no es html&lt;/b&gt;') && m.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!/<script/i.test(m.html) && !/<img/i.test(m.html) && !m.html.includes('href="javascript'));
    assert.ok(m.html.includes('<a href="https://example.org/p?a=1&amp;b=2"'));
    assert.ok(m.html.includes('<ul') && m.html.includes('<strong>'));
    assert.ok(m.html.includes('&lt;img src=x onerror=1&gt; **x** [y](https://evil.example)'), 'the value as text');
    assert.ok(!m.html.includes('href="https://evil.example"'));
    // A line whose placeholders are all empty is left out («Contacto: {conference}» with no conference).
    assert.ok(!m.text.includes('Contacto:'));
    // The link is the layout's button (and copy line), never from the text; the subject is plain text.
    assert.ok(m.html.includes('href="https://site.example/portal/conference/autorizacion#t=abc&amp;x=1"'));
    assert.ok(m.text.includes('Ir: https://site.example/portal/conference/autorizacion#t=abc&x=1'));
    assert.strictEqual(m.subject, 'Hola <img src=x onerror=1> **x** [y](https://evil.example) <script>');
    assert.ok(m.html.includes('<title>Hola &lt;img'));
    assert.ok(m.html.includes('Enviado por Iglesia &lt;i&gt;.'));
    assert.ok(m.text.includes('[la política] (https://example.org/p?a=1&b=2)') || m.text.includes('la política (https://example.org/p?a=1&b=2)'));
    // Responsive, e-mail-safe layout: tables, inline styles, a preheader, a phone rule.
    assert.ok(m.html.startsWith('<!doctype html>') && m.html.includes('role="presentation"') && m.html.includes('@media (max-width:600px)') && m.html.includes('max-width:600px'));
    // The code: in its box (and in the code message's subject only); the texts never receive it.
    const c = MT.renderMessage('consent.code', 'en', { conference: 'Asume', code: '482913' }, { code: '482913' }, { subject: 'Code {code}', body: 'Here: {code}', after: '', action: '' });
    assert.strictEqual(c.subject, 'Code 482913');
    assert.ok(c.html.includes('>482913</div>') && !c.html.includes('Here: 482913') && c.text.includes('482913'));
    // The welcome has no code to put anywhere, and no URL placeholder.
    const wdef = MT.DEFS.find((d: any) => d.id === 'location.welcome');
    assert.deepStrictEqual(wdef.placeholders.map((p: any) => p.key), ['location', 'conference', 'admin_contact']);
    // Limits and checks of an edit.
    assert.strictEqual(MT.cleanEdit({ subject: '', body: 'x' }).field, 'subject');
    assert.strictEqual(MT.cleanEdit({ subject: 'x', body: ' ' }).field, 'body');
    assert.strictEqual(MT.cleanEdit({ subject: 'x'.repeat(201), body: 'x' }).field, 'subject');
    assert.ok(MT.cleanEdit({ subject: 'Hola\nmundo', body: 'x\u0001y' }).edit.subject === 'Hola mundo');
    assert.strictEqual(MT.cleanEdit({ subject: 's', body: 'x\u0001y' }).edit.body, 'xy', 'control characters never reach a text');
});

test('2.36.11 «Plantillas de correo»: administrators edit, preview, test and restore; the edit is what the real e-mail says', async () => {
    const w = await world();
    const staff = { id: 77, role: 'conference_manager_team', userLogin: 'coord', extra: { pluginCapabilities: ['conference_manager_access'] } };
    assert.strictEqual((await w.p.call('get', '/mail-templates', { user: staff as any })).status, 403, 'administrators only');
    const list = ok(await w.p.call('get', '/mail-templates'));
    assert.deepStrictEqual(list.langs, ['es', 'en', 'pt']);
    const link = list.templates.find((t: any) => t.id === 'consent.link');
    assert.ok(link.has_action && link.defaults.es.subject.includes('{conference}') && Object.keys(link.edits).length === 0);
    // Invalid edits are said by field.
    const bad = await w.p.call('post', '/mail-templates/consent.link/save', { body: { lang: 'es', subject: '', body: 'x' } });
    assert.deepStrictEqual([bad.status, bad.body.field], [400, 'subject']);
    assert.strictEqual((await w.p.call('post', '/mail-templates/consent.link/save', { body: { lang: 'fr', subject: 's', body: 'b' } })).status, 400);
    assert.strictEqual((await w.p.call('post', '/mail-templates/nope/save', { body: { lang: 'es', subject: 's', body: 'b' } })).status, 404);
    // Preview: the draft with samples, never stored.
    const pv = ok(await w.p.call('post', '/mail-templates/consent.link/preview', { body: { lang: 'es', subject: 'Firma · {conference}', body: 'Hola **{name}**', after: '', action: 'Firmar ya' } }));
    assert.ok(pv.subject === 'Firma · Asume el Riesgo' && pv.html.includes('<strong>Ana</strong>') && pv.html.includes('>Firmar ya</a>'));
    assert.strictEqual(Object.keys(ok(await w.p.call('get', '/mail-templates')).templates.find((t: any) => t.id === 'consent.link').edits).length, 0);
    // Saved: the real link e-mail says it.
    ok(await w.p.call('post', '/mail-templates/consent.link/save', { body: { lang: 'es', subject: 'Por favor firma · {conference}', body: 'Hola {name}, falta tu firma.', after: '', action: 'Firmar' } }));
    const saved = ok(await w.p.call('get', '/mail-templates')).templates.find((t: any) => t.id === 'consent.link').edits.es;
    assert.deepStrictEqual([saved.subject, saved.updated_by], ['Por favor firma · {conference}', 'boss']);
    (await w.register({}));
    const sent = w.p.mails[w.p.mails.length - 1];
    assert.strictEqual(sent.subject, 'Por favor firma · Asume el Riesgo');
    assert.ok(sent.text.includes('Hola Ana Pérez, falta tu firma.') && /Firmar: http.*#t=[0-9a-f]{32}/.test(sent.text), sent.text);
    // Test send: to the administrator's own e-mail, marked; a few per administrator.
    const before = w.p.mails.length;
    const t = ok(await w.p.call('post', '/mail-templates/badge.link/test', { body: { lang: 'en', subject: 'Badge {name}', body: 'Hi {name}', after: '', action: 'Open' } }));
    assert.strictEqual(t.sent, true);
    const tm = w.p.mails[before];
    assert.deepStrictEqual([tm.to, tm.subject], ['boss@example.test', '[Prueba] Badge Ana']);
    for (let i = 0; i < 4; i++) ok(await w.p.call('post', '/mail-templates/badge.link/test', { body: { lang: 'en', subject: 's', body: 'b' } }));
    assert.strictEqual((await w.p.call('post', '/mail-templates/badge.link/test', { body: { lang: 'en', subject: 's', body: 'b' } })).status, 429);
    // Restore: the default again.
    ok(await w.p.call('post', '/mail-templates/consent.link/restore', { body: { lang: 'es' } }));
    assert.strictEqual(Object.keys(ok(await w.p.call('get', '/mail-templates')).templates.find((t: any) => t.id === 'consent.link').edits).length, 0);
    (await w.register({ first_name: 'Luis', email: 'luis@example.org' }));
    assert.ok(w.p.mails[w.p.mails.length - 1].subject.startsWith('Autoriza el uso de tus datos'));
});

test('2.36.11 the welcome to a locality\'s coordinator: never the access code, the portal link and the admin contact; once a minute; logged; no admin login on the portal', async () => {
    const w = await world();
    const loc = () => w.p.one(`SELECT code, responsible_email, welcome_sent_s, welcome_sent_by FROM ${PREFIX}locations WHERE id = ?`, w.norte);
    // No e-mail yet: nothing to send. A bad one is refused.
    assert.strictEqual((await w.p.call('post', `/locations/${w.norte}/welcome`)).body.code, 'no_email');
    const badMail = await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_email: 'no-es-correo' } });
    assert.deepStrictEqual([badMail.status, badMail.body.field], [400, 'responsible_email']);
    ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_email: 'encargado@example.org' } }));
    assert.strictEqual(loc().responsible_email, 'encargado@example.org');
    // Sent: to the coordinator, with the portal's address and the administration's contact — never the code.
    const before = w.p.mails.length;
    const r = ok(await w.p.call('post', `/locations/${w.norte}/welcome`));
    assert.deepStrictEqual([r.sent, r.email_masked], [true, 'e***@e***.org']);
    const m = w.p.mails[before];
    assert.strictEqual(m.to, 'encargado@example.org');
    assert.ok(m.subject.includes('Norte') && m.subject.includes('Asume el Riesgo'));
    const code = String(loc().code);
    assert.ok(!m.text.includes(code) && !m.html.includes(code) && !m.subject.includes(code), 'the access code is never in it');
    assert.ok(/\/portal\/conference\?slug=dc-\d+/.test(m.text) && m.html.includes('/portal/conference?slug='));
    assert.ok(m.text.includes('datos@example.org'), 'the administration contact (Autorizaciones)');
    assert.ok(m.text.includes('pídeselo a la administración'));
    // Stamped and logged; a second one right away is refused (rate).
    assert.ok(loc().welcome_sent_s && loc().welcome_sent_by === 'boss');
    assert.strictEqual((await w.p.call('post', `/locations/${w.norte}/welcome`)).status, 429);
    const log = w.p.q(`SELECT kind, email, actor, ok FROM ${PREFIX}location_mails WHERE location_id = ?`, w.norte) as any[];
    assert.deepStrictEqual(log.map(x => [x.kind, x.email, x.actor, x.ok]), [['welcome', 'encargado@example.org', 'boss', 1]]);
    // The locality list shows when; the portal never sees the administrator's login.
    const row = ok(await w.p.call('get', `/locations?conference_id=${w.cid}`)).locations.find((x: any) => x.id === w.norte);
    assert.ok(row.welcome_sent_s && row.responsible_email === 'encargado@example.org');
    const me = ok(await portal(w.p, 'get', '/portal/me', w.ptoken));
    assert.ok(!('welcome_sent_by' in me) && !('welcome_sent_s' in me));
    // Without the data contact configured, the contact line is left out.
    const w2 = await world({ enable: false });
    ok(await w2.p.call('put', `/locations/${w2.norte}`, { body: { responsible_email: 'enc@example.org' } }));
    ok(await w2.p.call('post', `/locations/${w2.norte}/welcome`));
    assert.ok(!w2.p.mails[w2.p.mails.length - 1].text.includes('Contacto de la administración'));
    // A mail failure is said, logged, and nothing is stamped.
    const w3 = await world({ enable: false });
    ok(await w3.p.call('put', `/locations/${w3.norte}`, { body: { responsible_email: 'enc@example.org' } }));
    w3.p.setMailFail(true);
    const failed = await w3.p.call('post', `/locations/${w3.norte}/welcome`);
    assert.deepStrictEqual([failed.status, failed.body.code], [503, 'mail_off'], 'the site has no mail: said so');
    assert.strictEqual(w3.p.one(`SELECT welcome_sent_s FROM ${PREFIX}locations WHERE id = ?`, w3.norte).welcome_sent_s, null);
    assert.strictEqual(w3.p.one(`SELECT ok FROM ${PREFIX}location_mails WHERE location_id = ?`, w3.norte).ok, 0);
});

test('2.36.11: sibling actions share one route — well under the host cap, same URLs, same checks', async () => {
    const p = await bootPlugin();
    assert.ok(p.routes.length <= 185, `registers ${p.routes.length} routes; keep headroom under plugin-isolate.ts MAX_ROUTES=200`);
    const grouped = p.routes.filter(r => r.path.endsWith('/:act'));
    assert.ok(grouped.length >= 9, 'the groups are registered as one route each');
    // Each group keeps its members' options: a public group stays public, an admin group stays admin-only.
    assert.strictEqual(grouped.find(r => r.path === '/public/consent/:act')!.opts.auth, undefined);
    assert.deepStrictEqual([grouped.find(r => r.path === '/mail-templates/:id/:act')!.opts.auth, grouped.find(r => r.path === '/mail-templates/:id/:act')!.opts.admin], [true, true]);
    assert.strictEqual((await p.call('post', '/mail-templates/consent.link/preview', { anonymous: true })).status, 401);
    // An action no member registered answers 404, like a missing route.
    assert.strictEqual((await p.call('post', '/mail-templates/consent.link/nope', { body: { lang: 'es' } })).status, 404);
    assert.strictEqual((await p.call('post', '/public/me/nope', { anonymous: true, body: {} })).status, 404);
});

// ── 2.36.12 «Editar encargado» ───────────────────────────────────────────────────────────────────────────────
test('2.36.12 every piece of the coordinator data is editable: name, phone (E.164 with the default country), e-mail; checked by field; «encargado editado» logged (which fields, never the values)', async () => {
    const w = await world({ enable: false });
    const row = () => w.p.one(`SELECT responsible_name, responsible_phone, responsible_email FROM ${PREFIX}locations WHERE id = ?`, w.norte);
    const logRows = () => w.p.q(`SELECT kind, actor, fields FROM ${PREFIX}location_log WHERE location_id = ? ORDER BY id`, w.norte) as any[];
    // All three at once; a national number takes the conference's default country (CO).
    const r = ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_name: '  Ana   María ', responsible_phone: '300 123 4567', responsible_email: 'ana@example.org' } }));
    assert.deepStrictEqual([r.responsible_name, r.responsible_phone, r.responsible_email], ['Ana María', '+573001234567', 'ana@example.org'], 'what was stored comes back');
    assert.deepStrictEqual([r.coordinator_entry.actor, r.coordinator_entry.fields], ['boss', ['name', 'phone', 'email']], 'the stored log entry comes back');
    assert.deepStrictEqual(row(), { responsible_name: 'Ana María', responsible_phone: '+573001234567', responsible_email: 'ana@example.org' });
    assert.deepStrictEqual(logRows(), [{ kind: 'coordinator', actor: 'boss', fields: '["name","phone","email"]' }]);
    assert.ok(!JSON.stringify(logRows()).includes('3001234567') && !JSON.stringify(logRows()).includes('ana@example.org'), 'never the values');
    // An E.164 number from the selector keeps its country; only what changed is logged.
    ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_phone: '+52 55 1234 5678' } }));
    assert.strictEqual(row().responsible_phone, '+525512345678');
    assert.deepStrictEqual(logRows().map(x => x.fields), ['["name","phone","email"]', '["phone"]']);
    // The same values again: nothing logged.
    ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_name: 'Ana María', responsible_phone: '+525512345678' } }));
    assert.strictEqual(logRows().length, 2);
    // Errors name their field and change nothing.
    for (const [body, field] of [[{ responsible_phone: '+12' }, 'responsible_phone'], [{ responsible_phone: 'llamar a Ana' }, 'responsible_phone'],
        [{ responsible_email: 'no-es-correo' }, 'responsible_email'], [{ responsible_name: 'x'.repeat(121) }, 'responsible_name']] as const) {
        const bad = await w.p.call('put', `/locations/${w.norte}`, { body });
        assert.deepStrictEqual([bad.status, bad.body.field], [400, field], JSON.stringify(body));
    }
    assert.strictEqual(row().responsible_phone, '+525512345678');
    assert.strictEqual(logRows().length, 2);
    // Clearing is a change.
    ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_phone: '' } }));
    assert.strictEqual(row().responsible_phone, null);
    // An old phone typed before E.164 is left alone while another field changes.
    w.p.exec(`UPDATE ${PREFIX}locations SET responsible_phone = '300 123 / 310 456' WHERE id = ${w.norte}`);
    ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_name: 'Ana' } }));
    assert.strictEqual(row().responsible_phone, '300 123 / 310 456');
    // The list shows the change log (newest first) to who manages the localities.
    const loc = ok(await w.p.call('get', `/locations?conference_id=${w.cid}`)).locations.find((x: any) => x.id === w.norte);
    assert.deepStrictEqual(loc.coordinator_log.map((e: any) => e.fields), [['name'], ['phone'], ['phone'], ['name', 'phone', 'email']]);
    assert.ok(loc.coordinator_log.every((e: any) => e.actor === 'boss' && Number.isInteger(e.at_s)));
    // Creating a locality follows the same rules.
    const created = ok(await w.p.call('post', '/locations', { body: { conference_id: w.cid, name: 'Sur', capacity: 10, responsible_name: 'Luis', responsible_phone: '3109876543', responsible_email: 'luis@example.org' } }));
    assert.deepStrictEqual(w.p.one(`SELECT responsible_name, responsible_phone, responsible_email FROM ${PREFIX}locations WHERE id = ?`, created.id),
        { responsible_name: 'Luis', responsible_phone: '+573109876543', responsible_email: 'luis@example.org' });
    const badCreate = await w.p.call('post', '/locations', { body: { conference_id: w.cid, name: 'Este', capacity: 10, responsible_phone: '12' } });
    assert.deepStrictEqual([badCreate.status, badCreate.body.field], [400, 'responsible_phone']);
    assert.strictEqual(w.p.q(`SELECT id FROM ${PREFIX}locations WHERE name = 'Este'`).length, 0);
});

test('2.36.12 a new «Correo del encargado» after a welcome: the welcome went to the old address (welcome_sent_to), never to the portal', async () => {
    const w = await world({ enable: false });
    ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_email: 'viejo@example.org' } }));
    const sent = ok(await w.p.call('post', `/locations/${w.norte}/welcome`));
    assert.strictEqual(sent.welcome_sent_to, 'viejo@example.org');
    ok(await w.p.call('put', `/locations/${w.norte}`, { body: { responsible_email: 'nuevo@example.org' } }));
    const loc = ok(await w.p.call('get', `/locations?conference_id=${w.cid}`)).locations.find((x: any) => x.id === w.norte);
    assert.deepStrictEqual([loc.responsible_email, loc.welcome_sent_to, !!loc.welcome_sent_s], ['nuevo@example.org', 'viejo@example.org', true]);
    const me = ok(await portal(w.p, 'get', '/portal/me', w.ptoken));
    assert.ok(!('welcome_sent_to' in me));
    // A row stamped before the column takes the address from the send log on the next migration.
    w.p.exec(`UPDATE ${PREFIX}locations SET welcome_sent_to = NULL WHERE id = ${w.norte}`);
    await w.p.reboot();
    assert.strictEqual(w.p.one(`SELECT welcome_sent_to FROM ${PREFIX}locations WHERE id = ?`, w.norte).welcome_sent_to, 'viejo@example.org');
});

test('2.36.12 a team member without «Localidades» sees no coordinator contact, welcome stamps or change log', async () => {
    const recep = { id: 71, role: 'conference_manager_team', extra: { pluginCapabilities: ['conference_manager_access'] }, userLogin: 'recepcion', userEmail: 'recepcion@example.test' } as any;
    const p = await bootPlugin({ users: [recep] });
    const cid = ok(await p.call('post', '/create', { body: { name: 'Asume el Riesgo', slug: `dc-team-${++seq}`, date_start: '2030-01-10', date_end: '2030-01-12' } })).id as number;
    const norte = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 5, responsible_name: 'Ana', responsible_phone: '3001234567', responsible_email: 'ana@example.org' } })).id;
    ok(await p.call('put', `/locations/${norte}`, { body: { responsible_name: 'Ana María' } }));
    ok(await p.call('post', '/staff/members', { body: { user_id: recep.id, role_id: ok(await p.call('post', '/staff/roles', { body: { name: 'Insc', permissions: { inscriptions: 'view' } } })).id } }));
    const loc = ok(await p.call('get', `/locations?conference_id=${cid}`, { user: recep })).locations.find((x: any) => x.id === norte);
    assert.deepStrictEqual([loc.responsible_name, loc.responsible_phone, loc.responsible_email, loc.welcome_sent_to, loc.coordinator_log], [null, null, null, null, undefined]);
    assert.strictEqual((await p.call('put', `/locations/${norte}`, { user: recep, body: { responsible_name: 'X' } })).status, 403);
});
