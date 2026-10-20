/**
 * conference-manager 2.18.0 — a hotel holds each room number ONCE.
 *
 * The site owner found every room of the test hotel seven times («en el único hotel que tenemos en prueba
 * las habitaciones están repetidas»). The admin creates a range of rooms («A1»…«A10») with one POST /rooms
 * per room, the button gave no sign of progress for those seconds, and every extra tap started the whole
 * batch again; the server accepted any number. Pinned against the REAL plugin
 * (fixtures/conference-manager-harness.ts):
 *   - POST /rooms refuses a number the hotel already has (trimmed, inner spaces collapsed, any case) with
 *     409 `duplicate_room`, naming the existing room; another hotel may reuse it;
 *   - PUT /rooms/:id refuses a rename to another room's number of the same hotel, but a room may keep or
 *     re-case its own number;
 *   - seven simultaneous creates of one number leave exactly one room.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { bootPlugin } from './fixtures/conference-manager-harness';

const ROOMS = 'wjp_conference_manager_rooms';

type P = Awaited<ReturnType<typeof bootPlugin>>;

let seq = 0;
const ok = (r: any, what = '') => { assert.strictEqual(r.status, 200, `${what} ${JSON.stringify(r.body)}`); return r.body; };

async function hotel(p: P, name: string) {
    const cid = ok(await p.call('post', '/create', { body: { name: `Congreso ${++seq}`, slug: `rooms-${seq}` } }), 'create').id as number;
    const hid = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name } }), 'hotel').id as number;
    return { cid, hid };
}
const roomsOf = (p: P, hid: number) => p.q(`SELECT id, room_number FROM ${ROOMS} WHERE hotel_id = ? ORDER BY id`, hid) as Array<{ id: number; room_number: string }>;

test('POST /rooms refuses a number the hotel already has, in any case or spacing; another hotel may reuse it', async () => {
    const p = await bootPlugin();
    const { cid, hid } = await hotel(p, 'Dorado');
    const first = ok(await p.call('post', '/rooms', { body: { hotel_id: hid, room_number: '  A1 ', capacity: 4 } }), 'A1');
    assert.deepStrictEqual(roomsOf(p, hid).map(r => r.room_number), ['A1'], 'stored trimmed');

    for (const again of ['A1', 'a1', ' A1  ']) {
        const r = await p.call('post', '/rooms', { body: { hotel_id: hid, room_number: again, capacity: 4 } });
        assert.strictEqual(r.status, 409, `«${again}» is the same room: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'duplicate_room');
        assert.strictEqual(r.body.id, first.id);
        assert.strictEqual(r.body.room_number, 'A1');
    }
    // Inner spaces collapse: «Suite 2» and «Suite   2» are one room.
    ok(await p.call('post', '/rooms', { body: { hotel_id: hid, room_number: 'Suite 2', capacity: 2 } }), 'Suite 2');
    assert.strictEqual((await p.call('post', '/rooms', { body: { hotel_id: hid, room_number: 'Suite   2', capacity: 2 } })).status, 409);
    assert.strictEqual(roomsOf(p, hid).length, 2);

    // The same number in ANOTHER hotel of the same conference is a different room.
    const other = ok(await p.call('post', '/hotels', { body: { conference_id: cid, name: 'Prado' } }), 'hotel 2').id as number;
    ok(await p.call('post', '/rooms', { body: { hotel_id: other, room_number: 'A1', capacity: 4 } }), 'A1 in Prado');
    assert.strictEqual(roomsOf(p, other).length, 1);
});

test('PUT /rooms/:id refuses a rename to another room\'s number of the hotel; a room keeps or re-cases its own', async () => {
    const p = await bootPlugin();
    const { hid } = await hotel(p, 'Dorado');
    const a1 = ok(await p.call('post', '/rooms', { body: { hotel_id: hid, room_number: 'A1', capacity: 4 } }), 'A1').id as number;
    const a2 = ok(await p.call('post', '/rooms', { body: { hotel_id: hid, room_number: 'A2', capacity: 4 } }), 'A2').id as number;

    const clash = await p.call('put', `/rooms/${a2}`, { body: { room_number: 'a1' } });
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));
    assert.strictEqual(clash.body.code, 'duplicate_room');
    assert.strictEqual(clash.body.id, a1);
    assert.deepStrictEqual(roomsOf(p, hid).map(r => r.room_number), ['A1', 'A2'], 'nothing renamed');

    ok(await p.call('put', `/rooms/${a1}`, { body: { room_number: 'A1', capacity: 6 } }), 'same number');
    ok(await p.call('put', `/rooms/${a1}`, { body: { room_number: 'a1' } }), 're-case its own number');
    ok(await p.call('put', `/rooms/${a2}`, { body: { room_number: 'B2' } }), 'free number');
    assert.deepStrictEqual(roomsOf(p, hid).map(r => r.room_number), ['a1', 'B2']);
});

test('seven simultaneous creates of one number leave exactly one room (the double-tap batch)', async () => {
    const p = await bootPlugin();
    const { hid } = await hotel(p, 'Dorado');
    const answers = await Promise.all(Array.from({ length: 7 }, () => p.call('post', '/rooms', { body: { hotel_id: hid, room_number: 'A7', capacity: 4 } })));
    assert.strictEqual(answers.filter(r => r.status === 200).length, 1, JSON.stringify(answers.map(r => r.status)));
    assert.strictEqual(answers.filter(r => r.status === 409 && r.body.code === 'duplicate_room').length, 6);
    assert.deepStrictEqual(roomsOf(p, hid).map(r => r.room_number), ['A7']);
});
