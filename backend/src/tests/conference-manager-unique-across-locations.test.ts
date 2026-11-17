/**
 * conference-manager 2.36.25 — a «no duplicates» field (is_unique, the ID document) is checked across the WHOLE
 * conference from the coordinators' portal too.
 *
 * The portal used to look for the value only in the coordinator's own location, so one person was registered
 * twice from two locations. Pinned against the REAL plugin (fixtures/conference-manager-harness.ts):
 *   - a coordinator cannot register a document another location already has (409), nor one of their own;
 *   - the refusal names neither the other registration nor its location;
 *   - a different document still registers, and the admin's own check is unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin } from './fixtures/conference-manager-harness';

type P = Awaited<ReturnType<typeof bootPlugin>>;
let seq = 0;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

async function world(p: P) {
    const cid = ok(await p.call('post', '/create', { body: { name: 'Congreso', slug: `unique-${++seq}`, fee_default: 80 } })).id as number;
    for (const template of ['first_name', 'last_name']) ok(await p.call('post', '/fields', { body: { conference_id: cid, template } }));
    ok(await p.call('post', '/fields', { body: { conference_id: cid, name: 'documento', label: 'Número de documento', type: 'number', is_unique: 1 } }));
    ok(await p.call('post', '/publish', { body: { conference_id: cid, published: true } }));
    const north = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Norte', capacity: 50 } }));
    const south = ok(await p.call('post', '/locations', { body: { conference_id: cid, name: 'Sur', capacity: 50 } }));
    const tokenOf = async (loc: any) => ok(await p.call('post', '/portal/login', { anonymous: true, body: { location_id: loc.id, code: loc.code } })).token as string;
    const register = async (token: string, body: Record<string, unknown>) =>
        p.call('post', '/portal/inscriptions', { anonymous: true, headers: { 'x-portal-token': token }, body });
    return { cid, north, south, tNorth: await tokenOf(north), tSouth: await tokenOf(south), register };
}

test('portal: a document registered by another location is refused, without saying where', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    ok(await w.register(w.tNorth, { first_name: 'Ana', last_name: 'Pérez', documento: '1012345678' }), 'north registers Ana');

    const again = await w.register(w.tSouth, { first_name: 'Ana María', last_name: 'Pérez', documento: '1012345678' });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    const text = JSON.stringify(again.body);
    assert.ok(text.includes('Número de documento'), 'names the field');
    for (const leak of ['Norte', 'Ana', String(w.north.id)]) assert.ok(!text.includes(leak), `the refusal must not reveal «${leak}»: ${text}`);

    // The same number written differently is the same document (a number field is stored canonically).
    assert.strictEqual((await w.register(w.tSouth, { first_name: 'Ana', last_name: 'P', documento: '001012345678' })).status, 409);
    // Within the coordinator's own location, as before.
    assert.strictEqual((await w.register(w.tNorth, { first_name: 'Otra', last_name: 'Vez', documento: '1012345678' })).status, 409);

    ok(await w.register(w.tSouth, { first_name: 'Luis', last_name: 'Gómez', documento: '79000111' }), 'another document registers');
    const rows = ok(await p.call('get', `/inscriptions?conference_id=${w.cid}`));
    assert.deepStrictEqual(rows.map((r: any) => r.documento).sort(), ['1012345678', '79000111'], 'exactly one Ana');
});

test('admin: the conference-wide check is unchanged', async () => {
    const p = await bootPlugin();
    const w = await world(p);
    ok(await w.register(w.tNorth, { first_name: 'Ana', last_name: 'Pérez', documento: '55' }));
    const dup = await p.call('post', '/inscriptions', { body: { conference_id: w.cid, first_name: 'Ana', last_name: 'P', documento: '55', location_id: w.south.id } });
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
});
