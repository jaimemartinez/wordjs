/**
 * Verso/collaboration — the session hardening pass, against the REAL routers on a real HTTP server.
 *
 * Every assertion goes through the producer a browser or another node would reach: the SSE stream and
 * the upload routes of routes/collab.ts, PUT /posts/:id and POST /revisions/:id/restore, the models'
 * own write paths (User.updateMeta, Post.update, Post.delete, mfa.setPolicy), and the cluster bus
 * handler that a Redis message lands in. What it pins:
 *
 *   CREDENTIALS — the channel is for interactive sessions only; an API token cannot open or drive it.
 *   REVOCATION BY EVENT — a stream closes when the fact that revokes it happens (sign-out, role, the
 *     post's status or author, the post's deletion, an MFA requirement), not at the next periodic
 *     check; a check that cannot complete closes the stream after a short grace.
 *   THE BUS — an unsigned or forged message, an unknown event, or an op the upload route would refuse
 *     never reaches a stream.
 *   WRITES OUTSIDE THE ROOM — a revision restore resets the live room; a save from the generation it
 *     replaced is refused; the room's own saves do not reset it.
 *   CAPS — per room and per user across the cluster, a per-user write budget across tabs, a per-user
 *     share of the epoch log, and the session rows of a deleted post.
 *   IDENTITY — a display name cannot reorder what others see, and presence carries the account id.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-collab-hardening-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const User = require('../models/User');
const collab = require('../core/collab-rooms');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

let server: any;
let origin = '';
let dbAsync: any;

const U: Record<string, number> = {};
const P: Record<string, number> = {};

const tok = (login: string) => jwt.sign({ userId: U[login], username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const post = (login: string, url: string, body: any) =>
    request(origin).post(`/api/v1${url}`)
        .set('Cookie', `wordjs_token=${tok(login)}`)
        .set('Origin', origin)
        .send(body);

async function seedUser(login: string, role: string, displayName?: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, displayName ?? `Name of ${login}`]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

const PUCK = (title: string) => JSON.stringify({ root: { props: { title } }, content: [] });

/* --- minimal SSE client (the same one collab-routes.test.ts uses) ---------------------------- */

type Stream = {
    events: { event: string; data: any }[];
    ended: () => boolean;
    waitFor: (event: string, timeoutMs?: number, pred?: (d: any) => boolean) => Promise<any>;
    close: () => void;
};

function openStream(login: string, postId: number, siteId: string): Promise<Stream> {
    return new Promise((resolve, reject) => {
        const req = http.get({
            host: '127.0.0.1',
            port: server.address().port,
            path: `/api/v1/collab/${postId}/stream?siteId=${encodeURIComponent(siteId)}`,
            headers: { Cookie: `wordjs_token=${tok(login)}`, Origin: origin, Accept: 'text/event-stream' },
        }, (res: any) => {
            const events: { event: string; data: any }[] = [];
            const waiters: { event: string; pred?: (d: any) => boolean; resolve: (v: any) => void }[] = [];
            let buffer = '';
            let closed = false;
            res.setEncoding('utf8');
            res.on('end', () => { closed = true; });
            res.on('close', () => { closed = true; });
            res.on('data', (chunk: string) => {
                buffer += chunk;
                let sep: number;
                while ((sep = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    const nameLine = frame.split('\n').find((l) => l.startsWith('event: '));
                    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
                    if (!nameLine || !dataLine) continue;
                    const event = nameLine.slice(7);
                    let data: any = null;
                    try { data = JSON.parse(dataLine.slice(6)); } catch { /* partial */ }
                    events.push({ event, data });
                    for (let i = waiters.length - 1; i >= 0; i--) {
                        const w = waiters[i];
                        if (w.event === event && (!w.pred || w.pred(data))) waiters.splice(i, 1)[0].resolve(data);
                    }
                }
            });
            resolve({
                events,
                ended: () => closed,
                waitFor: (event, timeoutMs = 3000, pred) => new Promise((res2, rej2) => {
                    const found = events.find((e) => e.event === event && (!pred || pred(e.data)));
                    if (found) return res2(found.data);
                    const timer = setTimeout(() => rej2(new Error(`timeout waiting for "${event}"; got ${JSON.stringify(events)}`)), timeoutMs);
                    waiters.push({ event, pred, resolve: (v) => { clearTimeout(timer); res2(v); } });
                }),
                close: () => { try { req.destroy(); res.destroy(); } catch { /* closed */ } },
            });
        });
        req.on('error', reject);
    });
}

type Session = Stream & { site: string; welcome: any };

async function openSession(login: string, postId: number, nonce: string): Promise<Session> {
    const s = await openStream(login, postId, nonce);
    const welcome = await s.waitFor('welcome');
    return Object.assign(s, { site: String(welcome.self.siteId), welcome });
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** True when the stream received NO event of that kind within `ms`. */
async function silent(s: Stream, event: string, ms = 400): Promise<boolean> {
    try { await s.waitFor(event, ms); return false; } catch { return true; }
}

let nonceSeq = 0;
/** A fresh, well-formed replica nonce (`s_` + base32) per stream. */
const nonce = () => {
    const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
    let n = ++nonceSeq;
    let tail = '';
    for (let i = 0; i < 6; i++) { tail = B32[n % 32] + tail; n = Math.floor(n / 32); }
    return `s_nonce${tail}`;
};

const hlc = (site: string, l = 100, c = 0) => ({ l, c, site });
const opPropSet = (site: string, counter: number, key: string, value: any, nodeId = 'n1') =>
    ({ k: 'propSet', id: { site, counter }, hlc: hlc(site, 100 + counter), nodeId, key, value });

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();

    await seedUser('jefa', 'administrator');
    await seedUser('jefa2', 'administrator');
    await seedUser('edita', 'editor');
    await seedUser('autora', 'author');
    await seedUser('colab', 'contributor');
    await seedUser('rlo', 'editor', 'Ad' + String.fromCharCode(0x202e) + 'min' + String.fromCharCode(0x200b) + '  Bob' + String.fromCharCode(7));

    for (const [key, author, type] of [
        ['pagina', 'jefa', 'page'], ['logout', 'autora', 'post'], ['rol', 'colab', 'post'],
        ['estado', 'colab', 'post'], ['autor', 'colab', 'post'], ['borrar', 'autora', 'post'],
        ['mfa', 'edita', 'post'], ['bus', 'jefa', 'page'], ['cupo', 'jefa', 'page'],
        ['escritura', 'jefa', 'page'], ['reparto', 'jefa', 'page'], ['grace', 'autora', 'post'],
        ['nombre', 'jefa', 'page'],
    ] as const) {
        P[key] = (await Post.create({ authorId: U[author], title: key, type, status: 'draft' })).id;
        await Post.updateMeta(P[key], '_puck_data', PUCK(key));
    }

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    collab._resetForTests();
    try { await new Promise<void>((r) => server.close(() => r())); } catch { /* closed */ }
    try { await database.closeDatabase(); } catch { /* closed */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* absent */ }
    }
});

/* ------------------------------------------------------------------------------------------- */

describe('credentials: interactive sessions only', () => {
    test('an API token cannot open the stream nor drive the upload routes', async () => {
        const ApiToken = require('../models/ApiToken');
        const t = await ApiToken.generate({ userId: U.jefa, name: 'ci', scopes: ['collab:write'] });
        // The token's owner can edit this page and the scope names the URL resource: before the fix
        // this opened a live feed of the draft.
        const stream = await request(origin).get(`/api/v1/collab/${P.pagina}/stream?siteId=s_aaaaaaaaaaaaaaaa`)
            .set('Authorization', `Bearer ${t.token}`);
        assert.equal(stream.status, 403);
        assert.equal(stream.body.code, 'rest_session_required');

        for (const route of ['ops', 'presence', 'resync', 'leave']) {
            const r = await request(origin).post(`/api/v1/collab/${P.pagina}/${route}`)
                .set('Authorization', `Bearer ${t.token}`).send({ siteId: 's_aaaaaaaaaaaaaaaa', ops: [] });
            assert.equal(r.status, 403, route);
            assert.equal(r.body.code, 'rest_session_required', route);
        }
    });

    test('ANTI-VACUITY: the same user with a session still gets in', async () => {
        const s = await openSession('jefa', P.pagina, nonce());
        assert.ok(s.welcome.epoch >= 1);
        s.close();
        await settle();
    });
});

describe('revocation happens when the fact happens', () => {
    // The periodic re-check is 30 s at its fastest; every wait below is ~3 s, so only the event-driven
    // path can close these streams in time.

    test('signing out (the security epoch) closes the stream at once', async () => {
        const s = await openSession('autora', P.logout, nonce());
        try {
            await User.updateMeta(U.autora, 'token_valid_after', String(Math.floor(Date.now() / 1000) + 60));
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
        } finally {
            s.close();
            await User.deleteMeta(U.autora, 'token_valid_after');
            await settle();
        }
    });

    test('a role change closes the stream at once', async () => {
        const s = await openSession('colab', P.rol, nonce());
        try {
            await User.updateMeta(U.colab, 'role', 'subscriber');
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
        } finally {
            s.close();
            await User.updateMeta(U.colab, 'role', 'contributor');
            await settle();
        }
    });

    test('publishing a contributor\'s draft (status) closes their stream at once', async () => {
        const s = await openSession('colab', P.estado, nonce());
        try {
            await Post.update(P.estado, { status: 'publish' });
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
        } finally { s.close(); await settle(); }
    });

    test('reassigning the author closes the previous author\'s stream at once', async () => {
        const s = await openSession('colab', P.autor, nonce());
        try {
            await Post.update(P.autor, { authorId: U.autora });
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
        } finally { s.close(); await settle(); }
    });

    test('an MFA requirement the user does not meet closes the stream at once', async () => {
        const mfa = require('../core/mfa');
        const s = await openSession('edita', P.mfa, nonce());
        try {
            await mfa.setPolicy({ requiredRoles: ['editor'], graceDays: 0 });
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
        } finally {
            s.close();
            await mfa.setPolicy({ requiredRoles: [] });
            await settle();
        }
    });

    test('deleting the post closes its streams and removes its session rows', async () => {
        const s = await openSession('autora', P.borrar, nonce());
        const r = await post('autora', `/collab/${P.borrar}/ops`, {
            siteId: s.site, epoch: s.welcome.epoch, ops: [opPropSet(s.site, 1, 'title', 'x')],
        });
        assert.equal(r.status, 200);
        try {
            await Post.delete(P.borrar, true);
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
            await settle(200);
            for (const table of ['collab_docs', 'collab_ops', 'collab_members']) {
                const row = await dbAsync.get(`SELECT COUNT(*) AS c FROM ${table} WHERE post_id = ?`, [P.borrar]);
                assert.equal(Number(row.c), 0, `${table} still holds rows of a deleted post`);
            }
        } finally { s.close(); await settle(); }
    });

    test('a re-check that cannot complete closes the stream after a short grace (fail closed)', async () => {
        const mfa = require('../core/mfa');
        const keepalive = collab.CONFIG.KEEPALIVE_MS;
        const grace = collab.CONFIG.AUTH_GRACE_MS;
        const realGetPolicy = mfa.getPolicy;
        collab.CONFIG.KEEPALIVE_MS = 40;
        collab.CONFIG.AUTH_GRACE_MS = 150;
        const s = await openSession('autora', P.grace, nonce());
        try {
            mfa.getPolicy = async () => { throw new Error('option store unavailable'); };
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
        } finally {
            mfa.getPolicy = realGetPolicy;
            collab.CONFIG.KEEPALIVE_MS = keepalive;
            collab.CONFIG.AUTH_GRACE_MS = grace;
            s.close();
            await settle();
        }
    });
});

describe('the cluster bus: signed, closed set of events, validated ops', () => {
    const send = (body: any, mac?: string) => {
        const b = JSON.stringify({ o: 'another-node', t: Date.now(), ...body });
        collab._handleBusMessage(JSON.stringify({ b, m: mac ?? collab._busMac(b) }));
    };

    test('only a correctly signed, known event with a valid payload reaches a stream', async () => {
        const s = await openSession('jefa', P.bus, nonce());
        const peer = collab.replicaId(U.edita, 's_peerpeerpeerpeer');
        try {
            // Unsigned (the pre-fix wire format) — dropped.
            collab._handleBusMessage(JSON.stringify({
                o: 'another-node', p: P.bus, e: 'ops', d: { ops: [opPropSet(peer, 1, 'title', 'unsigned')], from: peer, epoch: s.welcome.epoch },
            }));
            // Signed with a key the cluster does not have — dropped.
            send({ p: P.bus, e: 'ops', d: { ops: [opPropSet(peer, 2, 'title', 'forged')], from: peer, epoch: s.welcome.epoch } },
                require('crypto').createHmac('sha256', 'not-the-key').update('x').digest('base64url'));
            // Correctly signed but an event no node ever publishes — dropped.
            send({ p: P.bus, e: 'error', d: { code: 'unauthorized', message: 'kicked' } });
            send({ p: P.bus, e: 'welcome', d: { epoch: 99, base: '{}' } });
            // Correctly signed ops that the upload route would refuse (declared from another replica).
            send({ p: P.bus, e: 'ops', d: { ops: [opPropSet(collab.replicaId(U.jefa, 'x'), 3, 'title', 'spoof')], from: peer, epoch: s.welcome.epoch } });
            assert.ok(await silent(s, 'ops'), 'a refused bus message reached the stream');
            assert.ok(!s.events.some((e) => e.event === 'error'), 'a forged error frame reached the stream');

            // ANTI-VACUITY: a well-formed signed op IS delivered — and sanitized on the way in.
            send({ p: P.bus, e: 'ops', d: { ops: [opPropSet(peer, 4, 'href', 'javascript:alert(1)')], from: peer, epoch: s.welcome.epoch } });
            const ops = await s.waitFor('ops', 2000);
            assert.equal(ops.from, peer);
            assert.equal(ops.ops.length, 1);
            assert.notEqual(ops.ops[0].value, 'javascript:alert(1)');
        } finally { s.close(); await settle(); }
    });

    test('a signed message outside the time window is not replayed', async () => {
        const s = await openSession('jefa', P.bus, nonce());
        const peer = collab.replicaId(U.edita, 's_peerpeerpeerpeeq');
        try {
            const b = JSON.stringify({ o: 'another-node', t: Date.now() - 10 * 60_000, p: P.bus, e: 'members', d: { left: { siteId: peer, userId: U.edita } } });
            collab._handleBusMessage(JSON.stringify({ b, m: collab._busMac(b) }));
            assert.ok(await silent(s, 'members'));
        } finally { s.close(); await settle(); }
    });
});

describe('writes made outside the live room', () => {
    test('a revision restore resets the live room; a save from the replaced generation is refused', async () => {
        const { saveRevision } = require('../core/revisions');
        // Revision of V1, then the live content moves to V2 before anyone opens the editor.
        await Post.updateMeta(P.pagina, '_puck_data', PUCK('V1'));
        await saveRevision(P.pagina);
        await Post.updateMeta(P.pagina, '_puck_data', PUCK('V2'));
        const rev = await dbAsync.get(
            "SELECT id FROM posts WHERE post_parent = ? AND post_type = 'revision' ORDER BY id DESC LIMIT 1", [P.pagina]);

        const a = await openSession('jefa', P.pagina, nonce());
        const b = await openSession('edita', P.pagina, nonce());
        const epoch = a.welcome.epoch;
        assert.equal(JSON.parse(a.welcome.base).root.props.title, 'V2');
        try {
            // The room's own save (the epoch it was seeded from) does NOT reset it.
            const own = await request(origin).put(`/api/v1/posts/${P.pagina}`)
                .set('Cookie', `wordjs_token=${tok('edita')}`).set('X-Collab-Epoch', String(epoch))
                .send({ meta: { _puck_data: PUCK('V2b') }, autosave: true });
            assert.equal(own.status, 200, JSON.stringify(own.body));
            // …nor does a live member's save without the header (an editor opened before the upgrade).
            const legacy = await request(origin).put(`/api/v1/posts/${P.pagina}`)
                .set('Cookie', `wordjs_token=${tok('jefa')}`)
                .send({ meta: { _puck_data: PUCK('V2c') }, autosave: true });
            assert.equal(legacy.status, 200);
            assert.ok(await silent(a, 'warning', 300), 'the room reset itself on its own save');

            const restored = await post('jefa2', `/revisions/${rev.id}/restore`, {});
            assert.equal(restored.status, 200, JSON.stringify(restored.body));
            for (const s of [a, b]) {
                const w = await s.waitFor('warning', 3000, (d) => d.code === 'room_reset');
                assert.equal(w.code, 'room_reset');
            }

            // The autosave of a member still on the replaced generation would write V2 back over V1.
            const stale = await request(origin).put(`/api/v1/posts/${P.pagina}`)
                .set('Cookie', `wordjs_token=${tok('edita')}`).set('X-Collab-Epoch', String(epoch))
                .send({ meta: { _puck_data: PUCK('V2-stale') }, autosave: true });
            assert.equal(stale.status, 409);
            assert.equal(stale.body.code, 'collab_epoch_stale');
            assert.equal((await Post.getMeta(P.pagina, '_puck_data')).root.props.title, 'V1');

            // Re-seeding hands everybody the restored content on a new generation.
            const r = await post('edita', `/collab/${P.pagina}/resync`, { siteId: b.site, epoch, vv: {} });
            assert.equal(r.status, 200);
            assert.ok(r.body.epoch > epoch);
            assert.equal(JSON.parse(r.body.base).root.props.title, 'V1');
        } finally {
            a.close(); b.close();
            await settle();
        }
    });

    test('a page-tree save from someone outside the room resets it', async () => {
        const a = await openSession('jefa', P.nombre, nonce());
        try {
            const r = await request(origin).put(`/api/v1/posts/${P.nombre}`)
                .set('Cookie', `wordjs_token=${tok('jefa2')}`)
                .send({ meta: { _puck_data: PUCK('from outside') } });
            assert.equal(r.status, 200);
            const w = await a.waitFor('warning', 3000, (d) => d.code === 'room_reset');
            assert.equal(w.code, 'room_reset');
        } finally { a.close(); await settle(); }
    });
});

describe('caps', () => {
    test('a room has a ceiling of its own', async () => {
        const cap = collab.CONFIG.MAX_CONNS_PER_ROOM;
        collab.CONFIG.MAX_CONNS_PER_ROOM = 2;
        const open: Stream[] = [];
        try {
            open.push(await openSession('jefa', P.cupo, nonce()));
            open.push(await openSession('edita', P.cupo, nonce()));
            const third = await openStream('jefa2', P.cupo, nonce());
            open.push(third);
            const err = await third.waitFor('error', 3000);
            assert.equal(err.code, 'room-full');
            assert.equal(err.retryable, true);
        } finally {
            collab.CONFIG.MAX_CONNS_PER_ROOM = cap;
            for (const s of open) s.close();
            await settle();
        }
    });

    test('the room ceiling counts the members served by OTHER nodes', async () => {
        const now = Date.now();
        const cap = collab.CONFIG.MAX_CONNS_PER_ROOM;
        // The room is full on the other nodes; this process serves nobody in it.
        for (let i = 0; i < cap; i++) {
            await dbAsync.run(
                'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
                [`roomfull-${i}`, P.cupo, `s_roomfull${String(i).padStart(6, 'a')}`, 100000 + i, 'other-node', now]);
        }
        const s = await openStream('jefa', P.cupo, nonce());
        try {
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'room-full');
        } finally {
            s.close();
            await dbAsync.run("DELETE FROM collab_members WHERE conn_id LIKE 'roomfull-%'");
            await settle();
        }
    });

    test('a user\'s connections are capped across the whole cluster, not per process', async () => {
        const now = Date.now();
        const cap = collab.CONFIG.MAX_CONNS_PER_USER_CLUSTER;
        // Connections this user holds on OTHER nodes, as those nodes recorded them.
        for (let i = 0; i < cap; i++) {
            await dbAsync.run(
                'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
                [`remote-${i}`, P.cupo, `s_remote${String(i).padStart(8, 'a')}`, U.edita, 'other-node', now]);
        }
        const s = await openStream('edita', P.cupo, nonce());
        try {
            const err = await s.waitFor('error', 3000);
            assert.equal(err.code, 'too-many-connections');
        } finally {
            s.close();
            await dbAsync.run("DELETE FROM collab_members WHERE conn_id LIKE 'remote-%'");
            await settle();
        }
    });

    test('the write budget belongs to the user: a second tab does not double it', async () => {
        const burst = collab.CONFIG.USER_WRITE_BURST;
        const rate = collab.CONFIG.USER_WRITE_BYTES_PER_SEC;
        collab.CONFIG.USER_WRITE_BURST = 3000;
        collab.CONFIG.USER_WRITE_BYTES_PER_SEC = 1;
        const a = await openSession('jefa', P.escritura, nonce());
        const b = await openSession('jefa', P.escritura, nonce());
        try {
            const big = 'x'.repeat(1800);
            const r1 = await post('jefa', `/collab/${P.escritura}/ops`, { siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'title', big)] });
            assert.equal(r1.status, 200);
            // The second tab's own connection bucket is full — the user's is not.
            const r2 = await post('jefa', `/collab/${P.escritura}/ops`, { siteId: b.site, epoch: b.welcome.epoch, ops: [opPropSet(b.site, 1, 'title', big)] });
            assert.equal(r2.status, 429);
            assert.equal(r2.body.code, 'collab_rate_limit');
            assert.ok(r2.body.retryAfterMs > 0 && typeof r2.body.rateSeal === 'string');
        } finally {
            collab.CONFIG.USER_WRITE_BURST = burst;
            collab.CONFIG.USER_WRITE_BYTES_PER_SEC = rate;
            a.close(); b.close();
            await settle();
        }
    });

    test('one co-editor cannot fill the epoch log and end resumability for the others', async () => {
        const maxBytes = collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH;
        collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH = 6000;
        const a = await openSession('jefa', P.reparto, nonce());
        const b = await openSession('edita', P.reparto, nonce());
        try {
            const chunk = 'y'.repeat(900);
            let n = 0;
            let last: any = null;
            for (; n < 12; n++) {
                last = await post('jefa', `/collab/${P.reparto}/ops`, { siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, n + 1, 'title', chunk)] });
                assert.equal(last.status, 200);
                if (last.body.rejected.length) break;
            }
            assert.ok(n < 12, 'the flooding user was never stopped');
            assert.equal(last.body.rejected[0].code, 'log-budget');
            const doc = await dbAsync.get('SELECT truncated FROM collab_docs WHERE post_id = ?', [P.reparto]);
            assert.equal(Number(doc.truncated), 0, 'the room was truncated for everybody');

            // The other member still persists.
            const rb = await post('edita', `/collab/${P.reparto}/ops`, { siteId: b.site, epoch: b.welcome.epoch, ops: [opPropSet(b.site, 1, 'title', 'mine')] });
            assert.equal(rb.status, 200);
            assert.equal(rb.body.persisted, true);
        } finally {
            collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH = maxBytes;
            a.close(); b.close();
            await settle();
        }
    });
});

describe('identity in presence', () => {
    test('a display name cannot reorder what the others see, and presence carries the account id', async () => {
        const a = await openSession('jefa', P.nombre, nonce());
        const r = await openSession('rlo', P.nombre, nonce());
        try {
            assert.equal(r.welcome.self.name, 'Admin Bob');
            const joined = await a.waitFor('members', 3000, (d) => d.joined && d.joined.userId === U.rlo);
            assert.equal(joined.joined.name, 'Admin Bob');
            assert.equal(joined.joined.userId, U.rlo);
        } finally { a.close(); r.close(); await settle(); }
    });
});

describe('collab-ops: shapeSet is sanitized with the tree key, like PUT /posts/:id', () => {
    test('extras:css gets the style criterion, not the generic string one', () => {
        const { validateFrame } = require('../core/collab-ops');
        const { sanitizePuckTree } = require('../core/sanitize-meta');
        const site = collab.replicaId(U.jefa, 's_shapeshapeshapes');
        const hostile = { color: 'red;position:fixed;inset:0', background: 'url(javascript:alert(1))' };
        const frame = validateFrame([{ k: 'shapeSet', id: { site, counter: 1 }, hlc: hlc(site), key: 'extras:css', value: hostile }], site);
        assert.equal(frame.ok, true);
        assert.equal(frame.ops.length, 1, JSON.stringify(frame.rejected));
        const viaPut = sanitizePuckTree({ css: hostile }).css;
        assert.deepEqual(frame.ops[0].value, viaPut);
        // ANTI-VACUITY: the style criterion really rewrites this value.
        assert.notDeepEqual(viaPut, hostile);
    });
});
