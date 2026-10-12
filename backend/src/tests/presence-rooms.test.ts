/**
 * EDITING-PRESENCE ROOM RECLAMATION
 *
 * routes/presence.ts keeps one in-memory room per post. The per-heartbeat sweep only visits a room that
 * someone is still heartbeating, and only an explicit `leave` deleted a room — so every editor that
 * closed a tab without one (crash, lost network, a beacon the browser dropped) left its room in the map
 * for the life of the process. These tests pin the reclamation: an abandoned room is removed once all of
 * its editors have expired, live rooms are kept, and the periodic sweeper runs only while rooms exist.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-presence-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const presence = require('../routes/presence');
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/presence', presence);

let uid = 0;
const postIds: number[] = [];
const auth = () => `Bearer ${jwt.sign({ userId: uid, username: 'presenceadmin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;
const beat = (postId: number, body: any = {}) =>
    request(app).post(`/api/v1/presence/${postId}`).set('Authorization', auth()).send(body);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    const db = database.getDbAsync();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();
    const r = await db.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('presenceadmin', 'x', 'presence@example.com', 'Presence Admin')`);
    uid = r.lastID;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [uid]);
    const Post = require('../models/Post');
    for (const title of ['Room one', 'Room two']) {
        postIds.push((await Post.create({ authorId: uid, title, type: 'post', status: 'draft' })).id);
    }
});

after(async () => {
    presence.sweepAllRooms(Number.MAX_SAFE_INTEGER); // drains the map and stops the sweeper
    try { await database.closeDatabase(); } catch { /* already closed */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* absent */ }
    }
});

test('an abandoned room (no leave) is reclaimed once all of its editors expire', async () => {
    const rooms = presence._presenceRooms;
    const r = await beat(postIds[0]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(rooms.has(postIds[0]), 'the heartbeat opened the room');
    assert.ok(rooms.sweeperActive(), 'the periodic sweeper runs while rooms exist');

    // Still within the TTL: nothing is reclaimed.
    assert.strictEqual(presence.sweepAllRooms(Date.now()), 0);
    assert.ok(rooms.has(postIds[0]));

    // The editor vanished without `leave`: past the TTL the room itself goes, not just its entry.
    const removed = presence.sweepAllRooms(Date.now() + rooms.TTL_MS + 1_000);
    assert.strictEqual(removed, 1);
    assert.strictEqual(rooms.has(postIds[0]), false, 'the empty room must be deleted from the map');
    assert.strictEqual(rooms.size(), 0);
    assert.strictEqual(rooms.sweeperActive(), false, 'the sweeper stops once there is nothing left to reclaim');
});

test('the sweep keeps live rooms and removes only the expired ones', async () => {
    const rooms = presence._presenceRooms;
    await beat(postIds[0]);
    await beat(postIds[1]);
    const later = Date.now() + rooms.TTL_MS + 1_000;
    assert.strictEqual(rooms.size(), 2);
    assert.strictEqual(presence.sweepAllRooms(Date.now()), 0, 'fresh rooms survive');
    assert.strictEqual(presence.sweepAllRooms(later), 2, 'both expire together once past the TTL');
    assert.strictEqual(rooms.size(), 0);
});

test('`leave` of the last editor still deletes the room immediately', async () => {
    const rooms = presence._presenceRooms;
    await beat(postIds[1]);
    assert.ok(rooms.has(postIds[1]));
    const r = await beat(postIds[1], { action: 'leave' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(rooms.has(postIds[1]), false);
});
