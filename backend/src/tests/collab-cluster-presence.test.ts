/**
 * Verso/collaboration — WHO THE JOINER IS TOLD ABOUT, WHEN THE ROOM SPANS MORE THAN ONE NODE.
 *
 * The bug this suite exists for was invisible on one node and one-sided on two, which is why it
 * survived a full transport review and a multi-node gate: the `members` broadcast DOES cross the
 * cluster bus, so an editor who is already connected is told about a newcomer on another node. It is
 * the newcomer's own `welcome` roster that was assembled from `room.conns` — the connections of the
 * process that happened to answer — so it never mentioned anyone attached elsewhere. With one author
 * per node the second one to open the page was told «nobody else is editing this page», and stayed
 * told that: nothing re-announces a member who is just sitting there.
 *
 * Seen from the product, that is the presence feature reporting the wrong thing in exactly the
 * deployment presence matters most in. It was found in the browser, with two frontends against two
 * backends sharing one Postgres and one Redis.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The room, the route, the SSE stream and the shared
 * `collab_members` table are real — the table is the whole subject, since it is the cluster's own
 * answer to "who is live in this room". The other node is represented by its ROW, which is precisely
 * what a second backend leaves behind, and the pub/sub leg is stubbed out: it is not what builds a
 * welcome roster, and wiring a Redis in would test the stub, not the fix.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-collab-cluster-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const cache = require('../core/cache');
const collab = require('../core/collab-rooms');

// "Is there a cluster tier at all?" is the same question `broadcast` asks, and it is the gate on
// looking beyond this process. Answer yes; leave the shared TABLE untouched, because that is the
// thing under test. The publish/subscribe legs become no-ops so the suite needs no Redis.
cache.redisConfigured = () => true;
cache.publish = async () => true;
cache.subscribe = () => { /* no bus in this suite: the roster does not come from it */ };

const express = require('express');
const cookieParser = require('cookie-parser');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

let server: any;
let origin = '';
let dbAsync: any;

const U: Record<string, number> = {};
const P: Record<string, number> = {};

const tok = (login: string) =>
    jwt.sign({ userId: U[login], username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

async function seedUser(login: string, role: string, displayName: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, displayName],
    );
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

type Stream = {
    events: { event: string; data: any }[];
    waitFor: (event: string, timeoutMs?: number) => Promise<any>;
    close: () => void;
};

function openStream(login: string, postId: number, nonce: string): Promise<Stream> {
    return new Promise((resolve, reject) => {
        const req = http.get(
            {
                host: '127.0.0.1',
                port: server.address().port,
                path: `/api/v1/collab/${postId}/stream?siteId=${encodeURIComponent(nonce)}`,
                headers: {
                    Cookie: `wordjs_token=${tok(login)}`,
                    Origin: origin,
                    Accept: 'text/event-stream',
                },
            },
            (res: any) => {
                const events: { event: string; data: any }[] = [];
                const waiters: { event: string; resolve: (v: any) => void }[] = [];
                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    let sep: number;
                    while ((sep = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, sep);
                        buffer = buffer.slice(sep + 2);
                        const nameLine = frame.split('\n').find((l) => l.startsWith('event: '));
                        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
                        if (!nameLine || !dataLine) continue; // keepalive / retry
                        const event = nameLine.slice(7);
                        let data: any = null;
                        try { data = JSON.parse(dataLine.slice(6)); } catch { /* split frame */ }
                        events.push({ event, data });
                        for (let i = waiters.length - 1; i >= 0; i--) {
                            if (waiters[i].event === event) waiters.splice(i, 1)[0].resolve(data);
                        }
                    }
                });
                resolve({
                    events,
                    waitFor: (event, timeoutMs = 4000) =>
                        new Promise((ok, ko) => {
                            const found = events.find((e) => e.event === event);
                            if (found) return ok(found.data);
                            const timer = setTimeout(() => ko(new Error(`timeout waiting for "${event}"`)), timeoutMs);
                            waiters.push({ event, resolve: (v) => { clearTimeout(timer); ok(v); } });
                        }),
                    close: () => { try { req.destroy(); res.destroy(); } catch { /* already closed */ } },
                });
            },
        );
        req.on('error', reject);
    });
}

type Session = Stream & { site: string; welcome: any };

async function openSession(login: string, postId: number, nonce: string): Promise<Session> {
    const s = await openStream(login, postId, nonce);
    const welcome = await s.waitFor('welcome');
    return Object.assign(s, { site: String(welcome.self.siteId), welcome });
}

/**
 * The row a SECOND backend leaves in the shared table when one of its editors joins: same post, its
 * own `node_id`, a positive (i.e. finished-joining) heartbeat. Nothing else crosses — which is the
 * point: name and colour have to be reconstructed from `user_id` on whichever node is asked.
 */
async function remoteMemberRow(opts: {
    postId: number;
    siteId: string;
    userId: number;
    nodeId?: string;
    seenAt?: number;
}) {
    await dbAsync.run(
        'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
            `conn-${opts.siteId}-${Math.random().toString(36).slice(2)}`,
            opts.postId,
            opts.siteId,
            opts.userId,
            opts.nodeId ?? 'backend-B',
            opts.seenAt ?? Date.now(),
        ],
    );
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();

    await seedUser('jefa', 'administrator', 'La Jefa');
    await seedUser('remota', 'administrator', 'Editora Remota');
    await seedUser('tercera', 'administrator', 'Tercera Persona');

    P.pagina = (await Post.create({ authorId: U.jefa, title: 'Una página compartida', type: 'page', status: 'draft' })).id;
    P.otra = (await Post.create({ authorId: U.jefa, title: 'Otra página', type: 'page', status: 'draft' })).id;
    P.mixta = (await Post.create({ authorId: U.jefa, title: 'Local y remoto', type: 'page', status: 'draft' })).id;
    P.rancia = (await Post.create({ authorId: U.jefa, title: 'Fila rancia', type: 'page', status: 'draft' })).id;
    P.entrando = (await Post.create({ authorId: U.jefa, title: 'A medio entrar', type: 'page', status: 'draft' })).id;
    P.mudanza = (await Post.create({ authorId: U.jefa, title: 'Reconexión entre nodos', type: 'page', status: 'draft' })).id;

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    try { if (server) server.close(); } catch { /* ya cerrado */ }
    try { if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB); } catch { /* best effort */ }
});

describe('presencia: el welcome nombra a los editores de OTROS nodos', () => {
    test('un editor de otro backend aparece en la lista de compañeros, con su NOMBRE', async () => {
        await remoteMemberRow({ postId: P.pagina, siteId: 'site-remoto-1', userId: U.remota });

        const a = await openSession('jefa', P.pagina, 's_aaaaaaaaaaaaaaaa');
        try {
            const members = a.welcome.members || [];
            const remote = members.find((m: any) => m.siteId === 'site-remoto-1');
            assert.ok(
                remote,
                'el editor conectado al OTRO nodo no aparece en el welcome — quien entra segundo cree estar solo',
            );
            // El nombre es lo que se pinta junto al cursor ajeno: sin él la presencia no identifica.
            assert.strictEqual(remote.name, 'Editora Remota');
            assert.strictEqual(remote.userId, U.remota);
            // El color se DERIVA del userId en cada nodo, sin coordinarse: la misma persona sale del
            // mismo color en las dos pantallas.
            assert.strictEqual(remote.color, collab.colorForUser(U.remota));
            // La selección es efímera y la sirve SU nodo: llega con su próximo `presence`.
            assert.strictEqual(remote.sel, null);
        } finally {
            a.close();
            await settle();
        }
    });

    test('local y remoto conviven, cada uno UNA vez, y nadie se ve a sí mismo', async () => {
        const a = await openSession('jefa', P.mixta, 's_bbbbbbbbbbbbbbbb');
        await remoteMemberRow({ postId: P.mixta, siteId: 'site-remoto-2', userId: U.remota });
        const b = await openSession('tercera', P.mixta, 's_cccccccccccccccc');
        try {
            const sites = (b.welcome.members || []).map((m: any) => m.siteId).sort();
            assert.deepStrictEqual(
                sites,
                [a.site, 'site-remoto-2'].sort(),
                'el que entra el último tiene que ver al compañero LOCAL y al de otro nodo, y a nadie más',
            );
            assert.ok(!sites.includes(b.site), 'nadie se ve a sí mismo en la lista de compañeros');
        } finally {
            b.close();
            a.close();
            await settle();
        }
    });

    test('una fila rancia (latido más viejo que MEMBER_TTL_MS) NO es un miembro', async () => {
        await remoteMemberRow({
            postId: P.rancia,
            siteId: 'site-fantasma',
            userId: U.remota,
            seenAt: Date.now() - collab.CONFIG.MEMBER_TTL_MS - 5_000,
        });
        const a = await openSession('jefa', P.rancia, 's_dddddddddddddddd');
        try {
            const sites = (a.welcome.members || []).map((m: any) => m.siteId);
            assert.ok(
                !sites.includes('site-fantasma'),
                'un nodo que murió dejaría a su editor en la sala para siempre',
            );
        } finally {
            a.close();
            await settle();
        }
    });

    test('quien está A MITAD DE ENTRAR en otro nodo (latido negativo) todavía no está en la sala', async () => {
        // `claimMember` aparca la fila en `-now`: existe para que su `leave` tenga qué borrar, pero
        // no cuenta como miembro vivo. La misma regla que excluye a las conns locales sin `ready`.
        await remoteMemberRow({
            postId: P.entrando,
            siteId: 'site-entrando',
            userId: U.remota,
            seenAt: -Date.now(),
        });
        const a = await openSession('jefa', P.entrando, 's_eeeeeeeeeeeeeeee');
        try {
            const sites = (a.welcome.members || []).map((m: any) => m.siteId);
            assert.ok(!sites.includes('site-entrando'), 'un join a medias no es todavía un compañero');
        } finally {
            a.close();
            await settle();
        }
    });

    test('una reconexión que cambió de nodo no se cuenta dos veces', async () => {
        // El mismo `siteId` es ESTABLE entre reconexiones (§2.1), así que una pestaña que vuelve a
        // entrar por otro backend deja atrás la fila del anterior hasta que caduca. La conexión que
        // este proceso sirve es conocimiento de primera mano y gana.
        const a = await openSession('jefa', P.mudanza, 's_ffffffffffffffff');
        await remoteMemberRow({ postId: P.mudanza, siteId: a.site, userId: U.jefa, nodeId: 'backend-viejo' });
        const b = await openSession('tercera', P.mudanza, 's_gggggggggggggggg');
        try {
            const sites = (b.welcome.members || []).map((m: any) => m.siteId);
            assert.deepStrictEqual(sites, [a.site], 'un siteId no puede aparecer dos veces en la sala');
        } finally {
            b.close();
            a.close();
            await settle();
        }
    });

    test('los miembros de OTRA página no se cuelan', async () => {
        await remoteMemberRow({ postId: P.otra, siteId: 'site-de-otra-pagina', userId: U.remota });
        const a = await openSession('jefa', P.pagina, 's_hhhhhhhhhhhhhhhh');
        try {
            const sites = (a.welcome.members || []).map((m: any) => m.siteId);
            assert.ok(!sites.includes('site-de-otra-pagina'));
        } finally {
            a.close();
            await settle();
        }
    });
});
