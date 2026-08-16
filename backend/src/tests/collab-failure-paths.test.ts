/**
 * Verso/colaboración — LOS CAMINOS DE FALLO DEL TRANSPORTE (F8.3, ronda 2).
 *
 * `collab-routes.test.ts` fija el camino feliz y la autorización. Esta suite fija lo otro: qué pasa
 * cuando la BD hipa, cuando una fila del log no se puede releer, cuando la señal de liveness se
 * pierde, cuando la retirada de una sala falla a mitad. Todos los casos de aquí salen de defectos
 * REPRODUCIDOS contra el árbol, y cada uno codifica la misma regla:
 *
 *   · un fallo de UNA sesión no puede tumbar el proceso ni contagiar a las demás;
 *   · nada se da por entregado ni por guardado sin comprobarlo — y si no se puede, el cliente se
 *     entera por su stream o por el status;
 *   · toda decisión DESTRUCTIVA (retirar una sala, purgar su log) falla CERRADA: ante la duda, se
 *     conserva, porque conservar de más cuesta bytes y conservar de menos cuesta el trabajo de
 *     alguien que está escribiendo ahora mismo.
 *
 * Se prueba contra el ROUTER REAL sobre un servidor HTTP real, y los fallos de BD se provocan con
 * triggers `RAISE(ABORT)` sobre las tablas de verdad: un doble de la BD no reproduce `SQLITE_BUSY`.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-collabfail-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const collab = require('../core/collab-rooms');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

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

const tok = (login: string) => jwt.sign({ userId: U[login], username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const post = (login: string, url: string, body: any) =>
    request(origin).post(`/api/v1${url}`)
        .set('Cookie', `wordjs_token=${tok(login)}`)
        .set('Origin', origin)
        .send(body);

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, `Nombre de ${login}`]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

/* ------------------------------------------------------------------------------------------- */
/* Cliente SSE mínimo                                                                            */
/* ------------------------------------------------------------------------------------------- */

type Stream = {
    events: { event: string; data: any }[];
    ended: () => boolean;
    waitFor: (event: string, timeoutMs?: number) => Promise<any>;
    close: () => void;
};

function openStream(login: string, postId: number, siteId: string): Promise<Stream> {
    return new Promise((resolve, reject) => {
        const req = http.get({
            host: '127.0.0.1',
            port: server.address().port,
            path: `/api/v1/collab/${postId}/stream?siteId=${encodeURIComponent(siteId)}`,
            headers: {
                Cookie: `wordjs_token=${tok(login)}`,
                Origin: origin,
                Accept: 'text/event-stream',
            },
        }, (res: any) => {
            const events: { event: string; data: any }[] = [];
            const waiters: { event: string; resolve: (v: any) => void }[] = [];
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
                    try { data = JSON.parse(dataLine.slice(6)); } catch { /* frame partido */ }
                    events.push({ event, data });
                    for (let i = waiters.length - 1; i >= 0; i--) {
                        if (waiters[i].event === event) waiters.splice(i, 1)[0].resolve(data);
                    }
                }
            });

            resolve({
                events,
                ended: () => closed,
                waitFor: (event, timeoutMs = 4000) => new Promise((res2, rej2) => {
                    const found = events.find((e) => e.event === event);
                    if (found) return res2(found.data);
                    const timer = setTimeout(() => rej2(new Error(`timeout esperando el evento "${event}"`)), timeoutMs);
                    waiters.push({ event, resolve: (v) => { clearTimeout(timer); res2(v); } });
                }),
                close: () => { try { req.destroy(); res.destroy(); } catch { /* ya cerrado */ } },
            });
        });
        req.on('error', reject);
    });
}

type Session = Stream & { site: string; welcome: any };

/** Abre y adopta la identidad DERIVADA que asigna el servidor, como hace el cliente real. */
async function openSession(login: string, postId: number, nonce: string): Promise<Session> {
    const s = await openStream(login, postId, nonce);
    const welcome = await s.waitFor('welcome');
    return Object.assign(s, { site: String(welcome.self.siteId), welcome });
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const NONCE_A = 's_aaaaaaaaaaaaaaaa';
const NONCE_B = 's_bbbbbbbbbbbbbbbb';

const hlc = (site: string, l = 100, c = 0) => ({ l, c, site });
const opPropSet = (site: string, counter: number, key: string, value: any, nodeId = 'n1') =>
    ({ k: 'propSet', id: { site, counter }, hlc: hlc(site, 100 + counter), nodeId, key, value });

const VACIO = JSON.stringify({ root: { props: {} }, content: [] });

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();

    await seedUser('jefa', 'administrator');
    await seedUser('mano', 'administrator');

    for (const key of ['join', 'log', 'latido', 'viva', 'carrera', 'retirada', 'aviso', 'cubo', 'docfail', 'barrido']) {
        P[key] = (await Post.create({ authorId: U.jefa, title: `post ${key}`, type: 'post', status: 'draft' })).id;
        await Post.updateMeta(P[key], '_puck_data', VACIO);
    }

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    collab._resetForTests();
    try { await new Promise<void>((r) => server.close(() => r())); } catch { /* ya cerrado */ }
    try { await database.closeDatabase(); } catch { /* ya cerrada */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* no existe */ }
    }
});

/* ------------------------------------------------------------------------------------------- */

describe('un fallo de UNA sesión no puede tumbar el proceso', () => {
    test('un fallo de BD durante el `join` se le DICE al cliente y no dispara `uncaughtException`', async () => {
        // Cadena reproducida: el `catch` del join hacía `leave(conn)`, que termina la respuesta con
        // `res.end()`; después la ruta escribía el evento de error SOBRE esa respuesta terminada. El
        // `ERR_STREAM_WRITE_AFTER_END` sale por `nextTick`, fuera de la cadena de promesas del
        // `asyncHandler`, y acaba en el `process.on('uncaughtException')` del arranque, que hace
        // `process.exit(1)`. Un editor con mala suerte tumbaba el CMS entero.
        const sueltos: any[] = [];
        const capturar = (e: any) => sueltos.push(e);
        process.on('uncaughtException', capturar);
        await dbAsync.exec(
            "CREATE TRIGGER collab_members_boom BEFORE INSERT ON collab_members BEGIN SELECT RAISE(ABORT, 'disco lleno'); END");
        let s: Stream | null = null;
        try {
            s = await openStream('jefa', P.join, NONCE_A);
            const err = await s.waitFor('error', 4000);
            assert.equal(err.code, 'server-error', 'el cliente tiene que enterarse de por qué no entró');
            await settle(200);
            assert.deepEqual(
                sueltos.map((e: any) => String(e && e.code)), [],
                `un fallo de join no puede llegar a uncaughtException: ${sueltos.map((e: any) => e && e.message).join(' | ')}`);
        } finally {
            s?.close();
            await dbAsync.exec('DROP TRIGGER collab_members_boom');
            process.removeListener('uncaughtException', capturar);
            await settle(200);
        }
    });

    test('si no se puede crear la fila del documento, el join FALLA en vez de abrir una sesión que lo rechaza todo', async () => {
        // `ensureDoc` se tragaba el fallo del INSERT y devolvía un `DocState` sintético: el `welcome`
        // salía «bien» (epoch 1) y luego TODO `pushOps` daba 409 `collab_epoch`, así que el editor
        // veía una sesión pintada como viva en bucle de «la sesión se reinició».
        await dbAsync.exec(
            "CREATE TRIGGER collab_docs_boom BEFORE INSERT ON collab_docs BEGIN SELECT RAISE(ABORT, 'disco lleno'); END");
        let s: Stream | null = null;
        try {
            s = await openStream('jefa', P.docfail, NONCE_A);
            const err = await s.waitFor('error', 4000);
            assert.equal(err.code, 'server-error');
            assert.equal(s.events.some((e) => e.event === 'welcome'), false, 'no puede haber welcome sin documento');
        } finally {
            s?.close();
            await dbAsync.exec('DROP TRIGGER collab_docs_boom');
            await settle(200);
        }
    });
});

describe('nada se contabiliza como entregado sin haberlo entregado', () => {
    test('un dot duplicado cuya fila NO se puede releer da 503, no un 200 `known`', async () => {
        // `known++` iba ANTES del `JSON.parse`: con una fila ilegible la op no entraba en `stored`,
        // no se difundía a nadie, y aun así la respuesta salía `200 {accepted:0, known:1}`. El
        // cliente cuadra `accepted+known+rejected` y SUELTA el lote: éxito habiendo perdido una op.
        const a = await openSession('jefa', P.log, NONCE_A);
        const b = await openSession('mano', P.log, NONCE_B);
        await dbAsync.run(
            'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [P.log, a.welcome.epoch, a.site, 5, 'propSet', '{esto no es JSON', U.jefa]);

        const r = await post('jefa', `/collab/${P.log}/ops`, {
            siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 5, 'mio', 1)],
        });
        assert.equal(r.status, 503, `no se puede confirmar lo que no se ha podido releer (body: ${JSON.stringify(r.body)})`);
        assert.equal(r.body.code, 'collab_store_failed');
        await settle(200);
        assert.equal(b.events.some((e) => e.event === 'ops'), false, 'y desde luego no llegó a nadie');

        a.close(); b.close();
        await settle(250);
        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.log]);
    });

    test('una fila ilegible en el log marca la sesión como NO reanudable (welcome.truncated y resync.complete)', async () => {
        // `loadOps` se saltaba la fila ilegible y `complete` se derivaba del recuento YA PARSEADO:
        // el `resync` respondía `complete:true` MINTIENDO, y quien entraba creía tener el histórico.
        await dbAsync.run(
            'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [P.log, 1, 's_zzzzzzzzzzzzzzzz', 9, 'propSet', '<<corrupta>>', U.jefa]);
        const a = await openSession('jefa', P.log, NONCE_A);
        try {
            assert.equal(a.welcome.truncated, true, 'con una op ilegible la sesión NO es reanudable: hay que decirlo');
            const rs = await post('jefa', `/collab/${P.log}/resync`, { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(rs.body.complete, false, '`complete:true` con una fila perdida es una mentira');
        } finally {
            a.close();
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.log]);
        }
    });
});

describe('la liveness de sala no puede quedarse en cero con gente dentro', () => {
    test('el latido RESUCITA la fila de liveness que el barrido borró', async () => {
        // `touchMember` era solo UPDATE y no miraba `changes`: si el barrido podaba la fila (porque
        // la BD estuvo >4 min sin aceptar escrituras) el editor quedaba INVISIBLE para todo el
        // clúster PARA SIEMPRE, y con él su log a merced de la primera decisión destructiva.
        const keepalive = collab.CONFIG.KEEPALIVE_MS;
        collab.CONFIG.KEEPALIVE_MS = 60;
        let a: Session | null = null;
        try {
            a = await openSession('jefa', P.latido, NONCE_A);
            await dbAsync.run('DELETE FROM collab_members WHERE post_id = ?', [P.latido]);
            await settle(400); // varios latidos
            const fila = await dbAsync.get(
                'SELECT conn_id, seen_at FROM collab_members WHERE post_id = ? AND site_id = ?', [P.latido, a.site]);
            assert.ok(fila, 'el latido tiene que poder re-clamar su propia fila, no solo actualizarla');
            assert.ok(Number(fila.seen_at) > 0, 'y con marca de tiempo viva');
        } finally {
            a?.close();
            collab.CONFIG.KEEPALIVE_MS = keepalive;
            await settle(250);
        }
    });

    test('NUNCA se retira una sala con un miembro vivo dentro, aunque su fila de liveness haya desaparecido', async () => {
        // El hallazgo [12] reintroducido: `ensureDoc` decidía la re-siembra SOLO con `collab_members`
        // y, al revés que el barrido, no tenía el cinturón del mapa local. Con la fila de Ana podada
        // y el `_puck_data` cambiado por fuera, el join de Ben retiraba la sala (epoch 1→2 y log
        // borrado) con Ana DENTRO y escribiendo. Eso es trabajo del usuario destruido.
        const ana = await openSession('jefa', P.viva, NONCE_A);
        const epochAntes = ana.welcome.epoch;
        const r = await post('jefa', `/collab/${P.viva}/ops`, {
            siteId: ana.site, epoch: epochAntes, ops: [opPropSet(ana.site, 1, 'trabajo', 'de Ana')],
        });
        assert.equal(r.body.accepted, 1);

        // La BD estuvo caída un rato: el barrido podó su fila y su latido (UPDATE) no la devuelve.
        await dbAsync.run('DELETE FROM collab_members WHERE post_id = ?', [P.viva]);
        // Alguien guarda el post por la vía clásica.
        await Post.updateMeta(P.viva, '_puck_data', JSON.stringify({ root: { props: { t: 'guardado por fuera' } }, content: [] }));

        const ben = await openSession('mano', P.viva, NONCE_B);
        try {
            const fila = await dbAsync.get('SELECT epoch FROM collab_docs WHERE post_id = ?', [P.viva]);
            assert.equal(Number(fila.epoch), epochAntes, 'no se puede subir el epoch con alguien dentro');
            const ops = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.viva]);
            assert.ok(Number(ops.c) > 0, 'ni borrar su log');
            const sigue = await post('jefa', `/collab/${P.viva}/ops`, {
                siteId: ana.site, epoch: epochAntes, ops: [opPropSet(ana.site, 2, 'trabajo', 'mas de Ana')],
            });
            assert.equal(sigue.status, 200, 'Ana tiene que poder seguir escribiendo');
        } finally {
            ana.close(); ben.close();
            await settle(300);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.viva]);
        }
    });

    test('dos joins simultáneos en una sala vacía cuyo contenido cambió por fuera: ninguno se queda con el snapshot RANCIO', async () => {
        // `claimMember` corre ANTES de `ensureDoc`, así que con dos entradas a la vez cada una veía a
        // la otra como «hay alguien dentro» y NINGUNA re-sembraba: los dos abrían con el snapshot
        // viejo y sin aviso, que es otra vez el hallazgo [12].
        const semilla = await openSession('jefa', P.carrera, NONCE_A);
        const epochAntes = semilla.welcome.epoch;
        semilla.close();
        await settle(300);

        const nuevo = { root: { props: { t: 'restaurado por fuera' } }, content: [] };
        await Post.updateMeta(P.carrera, '_puck_data', JSON.stringify(nuevo));

        // Se ensancha la ventana de solape para que las dos entradas coincidan dentro de `ensureDoc`.
        const realGetMeta = Post.getMeta;
        Post.getMeta = async (...args: any[]) => {
            await new Promise((r) => setTimeout(r, 200));
            return realGetMeta.apply(Post, args);
        };
        let a: Session | null = null;
        let b: Session | null = null;
        try {
            [a, b] = await Promise.all([
                openSession('jefa', P.carrera, NONCE_A),
                openSession('mano', P.carrera, NONCE_B),
            ]);
            assert.deepEqual(JSON.parse(a.welcome.base), nuevo, 'A no puede recibir el snapshot rancio');
            assert.deepEqual(JSON.parse(b.welcome.base), nuevo, 'B tampoco');
            assert.equal(a.welcome.epoch, b.welcome.epoch, 'y los dos tienen que estar en la MISMA generación');
            assert.equal(a.welcome.epoch, epochAntes + 1, 'la re-siembra sube el epoch exactamente una vez');
        } finally {
            Post.getMeta = realGetMeta;
            a?.close(); b?.close();
            await settle(300);
        }
    });

    test('si la retirada de la sala FALLA, el join falla CERRADO en vez de servir el snapshot rancio', async () => {
        // `ensureDoc` hacía `await retireRoom(postId)` SIN mirar el booleano, y `retireRoom` devuelve
        // `false` tragándose cualquier error de BD: se acababa sirviendo el `base_doc` viejo con el
        // epoch ANTERIOR, que es el hallazgo [12] por el camino de error.
        const semilla = await openSession('jefa', P.retirada, NONCE_A);
        const epochAntes = semilla.welcome.epoch;
        await post('jefa', `/collab/${P.retirada}/ops`, {
            siteId: semilla.site, epoch: epochAntes, ops: [opPropSet(semilla.site, 1, 'x', 1)],
        });
        semilla.close();
        await settle(300);

        await Post.updateMeta(P.retirada, '_puck_data', JSON.stringify({ root: { props: { t: 'otro' } }, content: [] }));
        await dbAsync.exec(
            "CREATE TRIGGER collab_ops_nodelete BEFORE DELETE ON collab_ops BEGIN SELECT RAISE(ABORT, 'disco lleno'); END");
        let s: Stream | null = null;
        try {
            s = await openStream('mano', P.retirada, NONCE_B);
            const err = await s.waitFor('error', 4000);
            assert.equal(err.code, 'server-error', 'sin poder retirar, se falla cerrado');
            const fila = await dbAsync.get('SELECT epoch FROM collab_docs WHERE post_id = ?', [P.retirada]);
            assert.equal(Number(fila.epoch), epochAntes, 'y el epoch no se toca a medias');
        } finally {
            s?.close();
            await dbAsync.exec('DROP TRIGGER collab_ops_nodelete');
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.retirada]);
        }
    });

    test('retirar una sala AVISA por el stream a quien siguiera dentro', async () => {
        // Aunque las dos guardas de arriba lo hagan improbable, si una sala se retira con gente
        // dentro esa gente NO puede quedarse en `live` y muda hasta que teclee: se le dice, y su
        // cliente re-siembra contando lo que no llegó a enviarse.
        const a = await openSession('jefa', P.aviso, NONCE_A);
        try {
            await collab.retireRoom(P.aviso);
            const aviso = await a.waitFor('warning', 3000);
            assert.equal(aviso.code, 'room_reset');
        } finally {
            a.close();
            await settle(250);
        }
    });

    test('el barrido falla CERRADO si la consulta de liveness no se puede hacer', async () => {
        // La rama `live === null`: el test que decía cubrirla solo ejercitaba `live > 0`. Una
        // consulta que falla NO es permiso para borrarle la sesión a nadie.
        const a = await openSession('jefa', P.barrido, NONCE_A);
        await post('jefa', `/collab/${P.barrido}/ops`, {
            siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'x', 1)],
        });
        const epochAntes = a.welcome.epoch;
        a.close();
        await settle(300);

        await dbAsync.exec('ALTER TABLE collab_members RENAME TO collab_members_off');
        try {
            const retiradas = await collab.sweepIdleRooms(0);
            assert.equal(retiradas, 0, 'sin poder leer la liveness no se retira NADA');
            const fila = await dbAsync.get('SELECT epoch FROM collab_docs WHERE post_id = ?', [P.barrido]);
            assert.equal(Number(fila.epoch), epochAntes);
            const ops = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.barrido]);
            assert.ok(Number(ops.c) > 0);
        } finally {
            await dbAsync.exec('ALTER TABLE collab_members_off RENAME TO collab_members');
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.barrido]);
        }
    });
});

describe('el límite de ritmo frena, pero no deja a nadie mudo', () => {
    test('un `resync` legítimo no puede expulsar de la sala a quien respeta la espera', async () => {
        // `chargeBytes` restaba SIN SUELO los bytes del log entero, así que un solo `resync` dejaba el
        // cubo en descubierto; con el cubo negativo la guarda de ritmo era cierta incluso para un
        // frame diminuto, y tres frames de tecleo después el servidor cerraba el stream con
        // `rate_limit` — que el cliente trata como terminal: mudo hasta recargar la página. Un
        // co-editor podía provocarlo a voluntad contra todos los demás.
        const burst = collab.CONFIG.BYTES_BURST;
        const perSec = collab.CONFIG.MAX_BYTES_PER_SEC;
        const espera = collab.CONFIG.RATE_RETRY_MS;
        collab.CONFIG.BYTES_BURST = 2_000;
        collab.CONFIG.MAX_BYTES_PER_SEC = 8_000;
        collab.CONFIG.RATE_RETRY_MS = 60;
        let a: Session | null = null;
        try {
            // Log de la sala muy por encima de la ráfaga: eso es lo que el `resync` va a cobrar.
            for (let i = 1; i <= 40; i++) {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [P.cubo, 1, 's_yyyyyyyyyyyyyyyy', i, 'propSet',
                        JSON.stringify(opPropSet('s_yyyyyyyyyyyyyyyy', i, `k${i}`, 'x'.repeat(120))), U.jefa]);
            }
            a = await openSession('jefa', P.cubo, NONCE_A);
            const rs = await post('jefa', `/collab/${P.cubo}/resync`, { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(rs.status, 200);
            assert.ok(rs.body.ops.length >= 40);

            // El cliente real hace exactamente esto: ante un 429 espera y reintenta el mismo lote.
            let entregada = false;
            for (let i = 0; i < 40 && !entregada; i++) {
                const r = await post('jefa', `/collab/${P.cubo}/ops`, {
                    siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'tecleo', 'a')],
                });
                if (r.status === 200) { entregada = true; break; }
                assert.equal(r.status, 429, `respetando la espera solo cabe un 429, no un ${r.status} (${JSON.stringify(r.body)})`);
                await settle(collab.CONFIG.RATE_RETRY_MS + 20);
            }
            assert.ok(entregada, 'la op tiene que acabar entrando: el cubo se rellena');
            assert.equal(a.ended(), false, 'y el stream no puede haberse cerrado por el camino');
            assert.equal(a.events.some((e) => e.event === 'error'), false,
                `nadie puede ser expulsado por pedir un resync: ${JSON.stringify(a.events.filter((e) => e.event === 'error'))}`);
        } finally {
            a?.close();
            collab.CONFIG.BYTES_BURST = burst;
            collab.CONFIG.MAX_BYTES_PER_SEC = perSec;
            collab.CONFIG.RATE_RETRY_MS = espera;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.cubo]);
        }
    });

    test('quien IGNORA la espera sigue acabando expulsado (el freno no se ha desactivado)', async () => {
        // La contracara del test anterior: relajar el strike NO puede haber desactivado el freno. Los
        // frames van muy por debajo del máximo (si no, rebotarían como 413 `too-large`, que no es un
        // problema de ritmo) y se mandan seguidos, sin respetar ninguna espera.
        const burst = collab.CONFIG.BYTES_BURST;
        const perSec = collab.CONFIG.MAX_BYTES_PER_SEC;
        collab.CONFIG.BYTES_BURST = 4_000;
        collab.CONFIG.MAX_BYTES_PER_SEC = 1_000;
        let a: Session | null = null;
        try {
            a = await openSession('jefa', P.cubo, NONCE_B);
            let cerrado = false;
            let rechazos = 0;
            let counter = 500;
            for (let i = 0; i < 60 && !cerrado; i++) {
                const ops = Array.from({ length: 3 }, () => opPropSet(a!.site, counter++, `k${counter}`, 'y'.repeat(200)));
                const r = await post('jefa', `/collab/${P.cubo}/ops`, { siteId: a.site, epoch: a.welcome.epoch, ops });
                if (r.status === 429) rechazos++;
                if (r.status === 409 && r.body.code === 'collab_no_session') cerrado = true;
            }
            assert.ok(rechazos > 0, 'el límite de ritmo tiene que dispararse');
            assert.ok(cerrado, 'el que machaca sin esperar tiene que acabar fuera');
            assert.ok(a.events.some((e) => e.event === 'error' && e.data.code === 'rate_limit'),
                'y se le dice por qué, no se le cierra en silencio');
        } finally {
            a?.close();
            collab.CONFIG.BYTES_BURST = burst;
            collab.CONFIG.MAX_BYTES_PER_SEC = perSec;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.cubo]);
        }
    });
});

describe('migración 0013: el motor se detecta bien o el índice viejo sobrevive', () => {
    test('con el driver `mariadb` se toma la rama MySQL, no la de SQLite', async () => {
        // `driverName === 'mysql'` dejaba fuera a `mariadb`, que es un valor soportado en
        // `config/database.ts`. Con la rama SQLite, `DROP INDEX IF EXISTS idx_collab_ops_dot` es
        // ERROR DE SINTAXIS en MariaDB (exige `ON <tabla>`), así que el índice LAXO
        // `(post_id, site_id, counter)` sobrevivía. Y el laxo es el MÁS restrictivo de los dos: con
        // él vivo, el reenvío de un dot de una generación anterior choca contra el UNIQUE viejo, el
        // re-SELECT filtra por el epoch vivo y no encuentra fila, y `pushOps` responde 503 EN BUCLE.
        const { MIGRATIONS } = require('../core/schema-migrations');
        const mig = MIGRATIONS.find((m: any) => m.id === '0013_collab_epoch_and_liveness');
        assert.ok(mig, 'la migración 0013 tiene que existir');

        const sql: string[] = [];
        const ctx = {
            exec: async (s: string) => { sql.push(s); },
            run: async (s: string) => { sql.push(s); },
            get: async () => null,          // ninguna columna existe todavía
            all: async () => { throw new Error('PRAGMA no existe en MariaDB'); },
            isPostgres: false,
            driverName: 'mariadb',
        };
        await mig.up(ctx);

        const todo = sql.join('\n');
        assert.ok(/DROP INDEX idx_collab_ops_dot ON collab_ops/.test(todo),
            `el DROP tiene que llevar \`ON <tabla>\` en MariaDB:\n${todo}`);
        assert.ok(!/DROP INDEX IF EXISTS idx_collab_ops_dot/.test(todo), 'esa forma no es válida en MariaDB');
        assert.ok(/ADD COLUMN base_hash VARCHAR\(255\)/.test(todo),
            `MariaDB no admite TEXT sin longitud donde se indexa:\n${todo}`);
        // Y la sonda de columnas usa information_schema, no PRAGMA (que aquí lanza).
        assert.ok(!/PRAGMA table_info/.test(todo));
    });
});

describe('la identidad de réplica y el contrato con el cliente', () => {
    test('`replicaId` NO es idempotente: el cliente TIENE que seguir mandando el nonce, no la derivada', () => {
        // De aquí cuelga el contrato del cliente (`frontend/src/lib/verso/collab/client.ts`): si al
        // reconectar mandara la identidad derivada en vez del nonce, el servidor derivaría OTRA
        // identidad — no desalojaría la conexión vieja, y el cliente tiraría su cola de ediciones.
        const derivada = collab.replicaId(U.jefa, NONCE_A);
        assert.notEqual(collab.replicaId(U.jefa, derivada), derivada,
            'si esto fuera idempotente, el bug del cliente sería invisible');
        assert.equal(collab.replicaId(U.jefa, NONCE_A), derivada, 'con el MISMO nonce sí es estable');
        // Y la derivada pasa el filtro de forma de la ruta, así que el error sería SILENCIOSO.
        assert.match(derivada, /^s_[a-z2-7]{1,32}$/);
    });

    test('reconectar con el NONCE desaloja; presentar la DERIVADA es otra réplica distinta', async () => {
        const antes = collab.stats().totalConns;
        const a = await openSession('jefa', P.join, NONCE_A);
        const dup = await openSession('jefa', P.join, NONCE_A);
        assert.equal(dup.site, a.site, 'el mismo nonce da la misma identidad');
        await settle(250);
        assert.equal(a.ended(), true, 'y la conexión vieja se desaloja');
        assert.equal(collab.stats().totalConns, antes + 1);

        // Lo que hacía el cliente antes del arreglo: reconectar mandando su identidad derivada.
        const drift = await openSession('jefa', P.join, dup.site);
        assert.notEqual(drift.site, dup.site, 'la derivada NO es un nonce válido para recuperar la identidad');
        await settle(200);
        assert.equal(dup.ended(), false, 'por eso no desalojaba nada y los cupos se acumulaban');

        dup.close(); drift.close();
        await settle(300);
    });
});
