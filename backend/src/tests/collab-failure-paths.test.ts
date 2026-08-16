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

    for (const key of ['join', 'log', 'latido', 'viva', 'carrera', 'retirada', 'aviso', 'cubo', 'presencia',
        'docfail', 'barrido', 'ciego', 'logciego', 'entrando', 'sello', 'ventana']) {
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
        } finally {
            s?.close();
            await dbAsync.exec('DROP TRIGGER collab_members_boom');
            await settle(300);
            process.removeListener('uncaughtException', capturar);
            // ESTE ASSERT VA EN EL `finally`, y no es estilo. Estaba después del `waitFor('error')`, y
            // toda regresión que reintroduzca el `write after end` impide justamente que ese evento
            // llegue: el `waitFor` rechaza por timeout y el assert de `uncaughtException` no se
            // ejecutaba NUNCA. La mitad del test que da nombre al caso —«y no dispara
            // uncaughtException»— era decorativa. Aquí corre pase lo que pase con la primera mitad.
            assert.deepEqual(
                sueltos.map((e: any) => String(e && e.code)), [],
                `un fallo de join no puede llegar a uncaughtException: ${sueltos.map((e: any) => e && e.message).join(' | ')}`);
        }
    });

    test('`sseWrite` NO escribe sobre una respuesta ya terminada (la guarda, falseada de frente)', () => {
        // Esta guarda no se puede provocar por HTTP mientras el resto del arreglo esté en su sitio: la
        // sala ya no cierra la respuesta en su camino de error (`leave(conn, {closeSocket:false})`),
        // así que cuando la ruta escribe el motivo el socket sigue vivo. Comprobado: revertir
        // `sseWrite` a un `res.write` crudo dejaba los 21 tests en verde. Por eso se ejercita
        // DIRECTAMENTE — es lo único que la separa de ser código que nadie prueba.
        //
        // `res.write()` sobre una respuesta terminada NO lanza: Node emite `'error'`
        // (`ERR_STREAM_WRITE_AFTER_END`) en el siguiente tick, fuera de toda cadena de promesas, y
        // acaba en el `process.on('uncaughtException')` del arranque ⇒ `process.exit(1)`.
        const sseWrite = require('../routes/collab')._sseWrite;
        assert.equal(typeof sseWrite, 'function', 'la guarda tiene que existir y ser alcanzable');

        const escrituras: string[] = [];
        const viva: any = { destroyed: false, writableEnded: false, writable: true, write: (c: string) => { escrituras.push(c); return true; } };
        const terminada: any = { destroyed: false, writableEnded: true, writable: true, write: () => { throw new Error('write after end'); } };
        const destruida: any = { destroyed: true, writableEnded: false, writable: false, write: () => { throw new Error('destroyed'); } };

        assert.equal(sseWrite(viva, 'hola'), true, 'sobre una respuesta viva sí escribe');
        assert.deepEqual(escrituras, ['hola']);
        assert.equal(sseWrite(terminada, 'x'), false, 'sobre una respuesta TERMINADA no puede intentarlo siquiera');
        assert.equal(sseWrite(destruida, 'x'), false, 'ni sobre una destruida');
    });

    test('un error del stream de UNA sesión se contiene en esa sesión', async () => {
        // El `res.on('error')` del handshake tampoco tenía test. Sin él, CUALQUIER error del stream
        // —escribir sobre una respuesta terminada, un socket que se rompe a media escritura— es un
        // evento `'error'` sin manejador sobre la `ServerResponse`, y eso en Node es
        // `uncaughtException` ⇒ `process.exit(1)`: un editor con mala suerte tumbaba el CMS entero.
        // Con él, lo peor que puede pasar es que se caiga ESA sesión.
        const sueltos: any[] = [];
        const capturar = (e: any) => sueltos.push(e);
        process.on('uncaughtException', capturar);
        let a: Session | null = null;
        let b: Session | null = null;
        try {
            a = await openSession('jefa', P.join, NONCE_A);
            b = await openSession('mano', P.join, NONCE_B);
            const conn = collab.findConn(P.join, a.site, U.jefa);
            assert.ok(conn, 'la conexión de A tiene que existir');

            (conn.res as any).emit('error', Object.assign(new Error('socket roto'), { code: 'ERR_STREAM_WRITE_AFTER_END' }));
            await settle(300);

            assert.equal(collab.findConn(P.join, a.site, U.jefa), null, 'la sesión rota se retira');
            assert.ok(collab.findConn(P.join, b!.site, U.mano), 'y la del compañero sigue viva');
        } finally {
            a?.close(); b?.close();
            await settle(300);
            process.removeListener('uncaughtException', capturar);
            assert.deepEqual(
                sueltos.map((e: any) => String(e && e.code)), [],
                `un error de stream no puede tumbar el proceso: ${sueltos.map((e: any) => e && e.message).join(' | ')}`);
        }
    });

    test('un cliente que ABORTA a mitad de un join fallido no deja sala, cupo ni fila colgando', async () => {
        // El listener de cierre se registra ANTES del `await` justamente por esto: `join()` hace
        // varias consultas y si el cliente se va dentro de esa ventana (un F5 sobre el editor, nginx
        // cortando el upstream) el `close` YA se emitió cuando se registraba después, el listener no
        // corría nunca y la conexión quedaba dada de alta para siempre, con su temporizador y su cupo.
        // Escribir en un socket destruido NO lanza, así que nada la recogía.
        const realGetMeta = Post.getMeta;
        Post.getMeta = async (...args: any[]) => {
            await new Promise((r) => setTimeout(r, 250));
            return realGetMeta.apply(Post, args);
        };
        await dbAsync.exec(
            "CREATE TRIGGER collab_docs_boom_abort BEFORE INSERT ON collab_docs BEGIN SELECT RAISE(ABORT, 'disco lleno'); END");
        let s: Stream | null = null;
        try {
            s = await openStream('jefa', P.docfail, NONCE_B);
            await settle(60);
            s.close();                       // aborto del cliente DENTRO del join
            await settle(600);               // el join termina en fallo y la ruta intenta responder
            assert.equal(collab.stats().rooms, 0, 'la sala no puede quedarse abierta');
            assert.equal(collab.stats().totalConns, 0, 'ni el cupo consumido');
            const filas = await dbAsync.get(
                'SELECT COUNT(*) AS c FROM collab_members WHERE post_id = ?', [P.docfail]);
            assert.equal(Number(filas.c), 0, 'ni la fila de liveness huérfana');
        } finally {
            s?.close();
            Post.getMeta = realGetMeta;
            await dbAsync.exec('DROP TRIGGER collab_docs_boom_abort');
            await settle(300);
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

    test('si el aviso de reinicio NO cruza el bus, se dice; no se pierde en silencio', async () => {
        // El superviviente al que este aviso rescata está, por definición, en OTRO nodo. `cache.publish`
        // devuelve `false` SIN LANZAR cuando Redis está caído, y `broadcast` tiraba ese resultado: la
        // pérdida no dejaba ni una línea de log, y el editor del otro nodo volvía al «live y mudo»
        // que el aviso existe para cerrar. No se puede reintentar (el epoch ya subió), pero sí se
        // puede dejar de ser invisible.
        const cache = require('../core/cache');
        const realDisponible = cache.pubsubAvailable;
        const realPublish = cache.publish;
        const realError = console.error;
        const gritos: string[] = [];
        // Sala con contenido de verdad: retirar una ya retirada es `noop` y no anuncia nada.
        const a = await openSession('jefa', P.aviso, NONCE_A);
        cache.pubsubAvailable = () => true;              // hay clúster...
        cache.publish = async () => false;              // ...pero el bus no entrega
        console.error = (...a2: any[]) => { gritos.push(a2.join(' ')); };
        try {
            assert.equal(await collab.retireRoom(P.aviso), 'retired', 'la sala tiene que retirarse de verdad');
        } finally {
            console.error = realError;
            cache.pubsubAvailable = realDisponible;
            cache.publish = realPublish;
            a.close();
            await settle(250);
        }
        assert.ok(gritos.some((g) => /aviso de reinicio NO cruzó el bus/.test(g)),
            `una retirada cuyo aviso no sale del nodo tiene que quedar registrada: ${JSON.stringify(gritos)}`);
    });

    test('el barrido falla CERRADO también con un driver que NO LANZA: `undefined` no es cero', async () => {
        // «Falla cerrado» era una propiedad del DRIVER, no del código. Con `sqlite-native` la consulta
        // imposible LANZA y el `catch` devolvía `null` — bien. Pero `sqlite-legacy`, que
        // `config/database.ts` documenta como «the automatic fallback when the native binary isn't
        // available», NO LANZA: loguea y devuelve `undefined` desde `get` (`drivers/sqlite-legacy.ts`,
        // sus `get`/`all`). Ahí `Number(undefined?.c) || 0` daba 0 = «no hay nadie ⇒ purga», y el
        // barrido borraba el log y subía el epoch de salas CON GENTE DENTRO en otros nodos — que son
        // justo a quienes la señal de clúster existe para proteger.
        //
        // Aquí se reproduce ESA forma de fallar (devolver `undefined` en vez de lanzar) sobre el
        // driver vivo, que es lo que el test anterior no cubría: renombrar la tabla solo ejercita el
        // camino de excepción.
        const a = await openSession('jefa', P.ciego, NONCE_A);
        await post('jefa', `/collab/${P.ciego}/ops`, {
            siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'x', 1)],
        });
        const epochAntes = a.welcome.epoch;
        a.close();
        await settle(300);

        const db = database.getDbAsync();
        const realGet = db.get.bind(db);
        db.get = async (sql: string, params?: any) =>
            (/FROM collab_members/i.test(String(sql)) ? undefined : realGet(sql, params));
        try {
            const retiradas = await collab.sweepIdleRooms(0);
            assert.equal(retiradas, 0,
                'un driver que responde `undefined` en vez de lanzar no está diciendo "no hay nadie"');
            const fila = await dbAsync.get('SELECT epoch FROM collab_docs WHERE post_id = ?', [P.ciego]);
            assert.equal(Number(fila.epoch), epochAntes, 'no se puede subir el epoch a ciegas');
            const ops = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.ciego]);
            assert.ok(Number(ops.c) > 0, 'ni borrar el log');
        } finally {
            db.get = realGet;
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.ciego]);
        }
    });

    test('un log que NO se llega a leer no se sirve como «vacío y completo»', async () => {
        // Mismo contrato por el otro método del driver: `all` devuelve `[]` cuando la consulta falla,
        // y un `[]` de fallo es indistinguible de un log vacío. Sin contrastar contra el recuento, el
        // `welcome` salía con `truncated: false` y 0 ops habiendo leído CERO filas de un log lleno:
        // al cliente se le decía «tienes el histórico completo» y lo creía.
        await dbAsync.run(
            'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [P.logciego, 1, 's_yyyyyyyyyyyyyyyy', 1, 'propSet',
                JSON.stringify(opPropSet('s_yyyyyyyyyyyyyyyy', 1, 'k', 'v')), U.jefa]);

        const db = database.getDbAsync();
        const realAll = db.all.bind(db);
        db.all = async (sql: string, params?: any) =>
            (/FROM collab_ops/i.test(String(sql)) ? [] : realAll(sql, params));
        let a: Session | null = null;
        try {
            a = await openSession('jefa', P.logciego, NONCE_A);
            assert.equal(a.welcome.ops.length, 0, 'el driver no devolvió nada, en efecto');
            assert.equal(a.welcome.truncated, true,
                'haber leído cero filas de un log con filas es una sesión NO reanudable, no un log vacío');
        } finally {
            db.all = realAll;
            a?.close();
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.logciego]);
        }
    });

    test('la fila de quien ESTÁ ENTRANDO no cuenta como viva pero SÍ lleva su edad', async () => {
        // Las dos propiedades del marcador, juntas, porque una sin la otra reabre un fallo distinto:
        //   · si contara como viva, dos joins simultáneos se verían el uno al otro y NINGUNO
        //     re-sembraría (el hallazgo 12);
        //   · si no llevara la edad —el `seen_at = 0` de antes— la poda del barrido la confundiría con
        //     la fila de un nodo muerto hace horas y la borraría mientras el join está en curso.
        const realGetMeta = Post.getMeta;
        Post.getMeta = async (...args: any[]) => {
            await new Promise((r) => setTimeout(r, 400));
            return realGetMeta.apply(Post, args);
        };
        let s: Promise<Session> | null = null;
        try {
            s = openSession('jefa', P.entrando, NONCE_A);
            await settle(150);      // el join está DENTRO de `ensureDoc`, con la fila ya reclamada

            const fila = await dbAsync.get(
                'SELECT seen_at FROM collab_members WHERE post_id = ? AND node_id = ?', [P.entrando, collab.NODE_ID]);
            assert.ok(fila, 'la fila se reclama ANTES de los await, para que nada quede huérfano');
            const seen = Number(fila.seen_at);
            assert.ok(seen <= 0, 'quien está entrando NO puede contar como miembro vivo');
            assert.ok(Math.abs(seen) > Date.now() - 60_000,
                `la marca tiene que llevar la EDAD del intento, no un 0 que parece antiquísimo (seen_at=${seen})`);

            const vivos = await collab.liveMembers(P.entrando);
            assert.equal(vivos, 0, 'y para la re-siembra sigue sin contar');
        } finally {
            Post.getMeta = realGetMeta;
            (await s)?.close();
            await settle(300);
        }
    });

    test('el barrido NO retira una sala con alguien A MITAD DE ENTRAR en otro nodo', async () => {
        // Carrera real: `claimMember` marcaba la fila del que entra con `seen_at = 0` para que no
        // contara como miembro vivo (si contara, dos joins simultáneos se verían el uno al otro y
        // ninguno re-sembraría). Pero para la PODA del barrido un 0 es la marca de tiempo más vieja
        // posible: la conexión que estaba entrando en el nodo A era indistinguible de la fila de un
        // nodo muerto hace horas. El barrido del nodo B la borraba y retiraba la sala —epoch arriba y
        // log fuera— con A dentro, que acababa de leer ese log. Ahora la fila guarda `-now`: sigue sin
        // contar como viva, pero lleva su edad.
        const a = await openSession('jefa', P.entrando, NONCE_A);
        await post('jefa', `/collab/${P.entrando}/ops`, {
            siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'x', 1)],
        });
        const epochAntes = a.welcome.epoch;
        a.close();
        await settle(300);

        // Fila de alguien entrando AHORA MISMO en OTRO nodo (sin rastro en el mapa local de éste).
        await dbAsync.run(
            'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
            ['c_entrando_nodo2', P.entrando, 's_zzzzzzzzzzzzzzzz', U.mano, 'nodo-2', -Date.now()]);
        try {
            await collab.sweepIdleRooms(0);
            const viva = await dbAsync.get(
                'SELECT conn_id FROM collab_members WHERE conn_id = ?', ['c_entrando_nodo2']);
            assert.ok(viva, 'su fila no puede podarse por parecer antiquísima: acaba de crearse');
            const fila = await dbAsync.get('SELECT epoch FROM collab_docs WHERE post_id = ?', [P.entrando]);
            assert.equal(Number(fila.epoch), epochAntes,
                'quien está entrando cuenta: subirle el epoch por debajo le invalida el log que acaba de leer');
            const ops = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.entrando]);
            assert.ok(Number(ops.c) > 0, 'ni borrárselo');
        } finally {
            await dbAsync.run('DELETE FROM collab_members WHERE conn_id = ?', ['c_entrando_nodo2']);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.entrando]);
        }
    });

    test('una fila de ENTRANTE abandonada sí acaba podándose (no bloquea el barrido para siempre)', async () => {
        // La contracara: si «entrando» inmunizara la fila, un nodo que muere a mitad de un join dejaría
        // la sala inmortal. La marca lleva su edad justamente para que la poda pueda distinguirlas.
        await dbAsync.run(
            'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
            ['c_entrando_zombi', P.entrando, 's_zzzzzzzzzzzzzzzz', U.mano, 'nodo-3',
                -(Date.now() - collab.CONFIG.MEMBER_TTL_MS * 10)]);
        try {
            await collab.sweepIdleRooms(0);
            const viva = await dbAsync.get(
                'SELECT conn_id FROM collab_members WHERE conn_id = ?', ['c_entrando_zombi']);
            assert.equal(viva, undefined, 'un join que se quedó a medias hace horas se poda como cualquier otra fila');
        } finally {
            await dbAsync.run('DELETE FROM collab_members WHERE conn_id = ?', ['c_entrando_zombi']);
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
    /**
     * ESPERA DEL CLIENTE, DERIVADA COMO LA DERIVA EL CLIENTE REAL.
     *
     * La versión anterior de estos tests ponía `CONFIG.RATE_RETRY_MS = 60` y esperaba
     * `CONFIG.RATE_RETRY_MS + 20`: reescribía LOS DOS LADOS del acoplamiento que decía proteger, así
     * que «quien espera lo que pide el servidor no acumula strike» era cierto POR CONSTRUCCIÓN para
     * cualquier valor. Prueba de que no valía: subir `RATE_RETRY_MS` de 900 a 5000 —un cambio que
     * REABRE la expulsión contra el cliente de entonces, que esperaba 1000 ms fijos— dejaba los 77
     * tests en verde.
     *
     * Aquí la espera sale de `welcome.limits.rateRetryMs`, que es EXACTAMENTE de donde la saca
     * `client.ts#rateBackoff()`, con el mismo suelo (1000) y el mismo margen (100). Si alguien toca
     * la constante del servidor, este test cambia de espera igual que cambiaría el navegador — y si
     * alguien deja de PUBLICARLA, el suelo de 1000 vuelve a ser lo único que hay y el test se
     * comporta como el cliente real en ese servidor.
     */
    const esperaDelCliente = (welcome: any) =>
        Math.min(Math.max(1000, (Number(welcome?.limits?.rateRetryMs) || 0) + 100), 30_000);

    test('un `resync` legítimo no puede expulsar de la sala a quien respeta la espera (con el backoff REAL del cliente)', async () => {
        // `chargeBytes` restaba SIN SUELO los bytes del log entero, así que un solo `resync` dejaba el
        // cubo en descubierto; con el cubo negativo la guarda de ritmo era cierta incluso para un
        // frame diminuto, y tres frames de tecleo después el servidor cerraba el stream con
        // `rate_limit` — que el cliente trata como terminal: mudo hasta recargar la página. Un
        // co-editor podía provocarlo a voluntad contra todos los demás.
        //
        // `RATE_RETRY_MS` NO se toca: es la mitad del acoplamiento que hay que ejercitar de verdad.
        // Solo se escala el cubo, y con la MISMA proporción que en producción (ráfaga / ritmo = 4 s
        // de recuperación con suelo), para que el test dure segundos y no minutos.
        const burst = collab.CONFIG.BYTES_BURST;
        const perSec = collab.CONFIG.MAX_BYTES_PER_SEC;
        collab.CONFIG.BYTES_BURST = 2_000;
        collab.CONFIG.MAX_BYTES_PER_SEC = 500;      // ráfaga/ritmo = 4 s, igual que 256 KB / 64 KB/s
        let a: Session | null = null;
        try {
            // Log MUY por encima de la ráfaga: ~28 KB. Con suelo, la deuda máxima es −2000 y el cubo
            // vuelve a cero en 4 s. SIN suelo la deuda sería ≈ −28 000 ⇒ 56 s de mudez, y creciendo
            // con el documento. El presupuesto de intentos de abajo es lo que separa un caso del otro.
            for (let i = 1; i <= 140; i++) {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [P.cubo, 1, 's_yyyyyyyyyyyyyyyy', i, 'propSet',
                        JSON.stringify(opPropSet('s_yyyyyyyyyyyyyyyy', i, `k${i}`, 'x'.repeat(120))), U.jefa]);
            }
            a = await openSession('jefa', P.cubo, NONCE_A);
            const espera = esperaDelCliente(a.welcome);
            assert.ok(espera > collab.CONFIG.RATE_RETRY_MS,
                `el cliente TIENE que esperar más que el servidor: ${espera} vs ${collab.CONFIG.RATE_RETRY_MS}`);

            const rs = await post('jefa', `/collab/${P.cubo}/resync`, { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(rs.status, 200);
            assert.ok(rs.body.ops.length >= 140);

            // PRESUPUESTO. Con suelo hacen falta ~4 s ⇒ 5 intentos de 1000 ms sobran. Sin suelo harían
            // falta ~56 s ⇒ 8 intentos NO llegan y el test cae por `entregada === false`. Ése es el
            // rojo que faltaba: el suelo de `chargeBytes` no lo falseaba ningún test.
            const INTENTOS = 8;
            let entregada = false;
            let usados = 0;
            for (; usados < INTENTOS && !entregada; usados++) {
                const r = await post('jefa', `/collab/${P.cubo}/ops`, {
                    siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'tecleo', 'a')],
                });
                if (r.status === 200) { entregada = true; break; }
                assert.equal(r.status, 429, `respetando la espera solo cabe un 429, no un ${r.status} (${JSON.stringify(r.body)})`);
                await settle(espera);
            }
            assert.ok(entregada,
                `la deuda de un resync tiene que drenarse en ${INTENTOS} reintentos del cliente (~${INTENTOS * espera} ms); ` +
                `sin el suelo de chargeBytes son decenas de segundos y crecen con el documento`);
            assert.equal(a.ended(), false, 'y el stream no puede haberse cerrado por el camino');
            assert.equal(a.events.some((e) => e.event === 'error'), false,
                `nadie puede ser expulsado por pedir un resync: ${JSON.stringify(a.events.filter((e) => e.event === 'error'))}`);
        } finally {
            a?.close();
            collab.CONFIG.BYTES_BURST = burst;
            collab.CONFIG.MAX_BYTES_PER_SEC = perSec;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.cubo]);
        }
    });

    test('el `welcome` PUBLICA la espera del servidor: es de donde el cliente saca su backoff', async () => {
        // El acoplamiento `RATE_RETRY_MS (900) < backoff del cliente (1000)` vivía en dos ficheros de
        // dos paquetes distintos, sin un comentario que los atara y con 100 ms de margen. Tocar
        // cualquiera de los dos reabría la expulsión EN SILENCIO. Ahora la ventana viaja por el cable.
        const a = await openSession('jefa', P.cubo, NONCE_A);
        try {
            assert.equal(a.welcome.limits.rateRetryMs, collab.CONFIG.RATE_RETRY_MS,
                'sin este campo el cliente vuelve a llevar la espera escrita a mano');
        } finally {
            a.close();
            await settle(250);
        }
    });

    test('un cubo de BYTES en descubierto no puede rebotar la PRESENCIA, que no gasta bytes', async () => {
        // AQUÍ es donde F2 seguía vivo. `rateCheck` comparaba `conn.byteTokens < bytes` incluso con
        // `bytes = 0`, y `setPresence` llama con `rateCheck(conn, 0, 0, 1)`: con el cubo de bytes en
        // rojo tras un `resync`, TODA la presencia rebotaba con 429. Y el cliente de presencia
        // re-posteaba cada 50 ms sin mirar el status, así que el servidor contaba tres «ignoró la
        // espera» seguidos y CERRABA la sesión. ~150 ms de bajar con las flechas por el documento
        // después de un resync legítimo y el editor mudo hasta recargar la página.
        const burst = collab.CONFIG.BYTES_BURST;
        const perSec = collab.CONFIG.MAX_BYTES_PER_SEC;
        collab.CONFIG.BYTES_BURST = 2_000;
        collab.CONFIG.MAX_BYTES_PER_SEC = 500;
        let a: Session | null = null;
        try {
            for (let i = 1; i <= 140; i++) {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [P.presencia, 1, 's_yyyyyyyyyyyyyyyy', i, 'propSet',
                        JSON.stringify(opPropSet('s_yyyyyyyyyyyyyyyy', i, `k${i}`, 'x'.repeat(120))), U.jefa]);
            }
            a = await openSession('jefa', P.presencia, NONCE_A);
            const rs = await post('jefa', `/collab/${P.presencia}/resync`, { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(rs.status, 200, 'el resync es legítimo y se sirve');

            // Exactamente el patrón del editor: un `setSelection` por bloque al bajar con las flechas,
            // coalescido a un POST cada `presenceMs` (50 ms). Nada de esto gasta bytes ni ops.
            const status: number[] = [];
            for (let i = 0; i < 6; i++) {
                const r = await post('jefa', `/collab/${P.presencia}/presence`, {
                    siteId: a.site, sel: { nodeId: `n${i}` },
                });
                status.push(r.status);
                await settle(50);
            }
            assert.deepEqual(status, [200, 200, 200, 200, 200, 200],
                `la presencia no gasta bytes: un cubo de bytes en descubierto no puede frenarla (${JSON.stringify(status)})`);
            assert.equal(a.ended(), false, 'y desde luego no puede cerrar el stream');
            assert.equal(a.events.some((e) => e.event === 'error'), false,
                `mover el cursor tras un resync no expulsa a nadie: ${JSON.stringify(a.events.filter((e) => e.event === 'error'))}`);
        } finally {
            a?.close();
            collab.CONFIG.BYTES_BURST = burst;
            collab.CONFIG.MAX_BYTES_PER_SEC = perSec;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.presencia]);
        }
    });

    test('el freno de PRESENCIA sigue existiendo: quien ACUSA el aviso y no espera acaba fuera', async () => {
        // La contracara del anterior: que un cubo ajeno no la frene no puede significar que la
        // presencia sea gratis. Su propio cubo (`PRESENCE_BURST` / `MAX_PRESENCE_PER_SEC`) sigue
        // frenando, y quien ignora la espera sigue acabando cerrado.
        //
        // «Ignorar la espera» es AHORA una cosa comprobable, no una suposición sobre el reloj:
        // devolver el `rateNotice` del 429 —o sea, reconocer que se ha recibido esa instrucción— y
        // mandar igual dentro de su ventana. Es exactamente lo que hace un cliente nuestro con el
        // planificador roto, que es el caso que esto tiene que seguir frenando.
        const burst = collab.CONFIG.PRESENCE_BURST;
        const perSec = collab.CONFIG.MAX_PRESENCE_PER_SEC;
        collab.CONFIG.PRESENCE_BURST = 3;
        collab.CONFIG.MAX_PRESENCE_PER_SEC = 1;
        let a: Session | null = null;
        try {
            a = await openSession('mano', P.presencia, NONCE_B);
            let rechazos = 0;
            let cerrado = false;
            let rateAck = 0;
            let rateSeal: string | undefined;
            for (let i = 0; i < 40 && !cerrado; i++) {
                const r = await post('mano', `/collab/${P.presencia}/presence`, {
                    siteId: a.site, sel: { nodeId: `n${i}` }, rateAck, rateSeal,
                });
                if (r.status === 429) {
                    rechazos++;
                    assert.ok(r.body.retryAfterMs > 0, 'un 429 tiene que decir CUÁNTO esperar');
                    // Se entera… y vuelve dentro de la ventana. El acuse va con SU SELLO: sin él el
                    // servidor lo descarta, y con razón (ver `noteRateAck`) — así que un cliente que
                    // quiera desobedecer de forma demostrable tiene que devolver el par entero.
                    rateAck = r.body.rateNotice;
                    rateSeal = r.body.rateSeal;
                }
                if (r.status === 409 && r.body.code === 'collab_no_session') cerrado = true;
            }
            assert.ok(rechazos > 0, 'el cubo de presencia tiene que frenar');
            assert.ok(cerrado, 'y quien no respeta la espera acaba fuera, igual que en `ops`');
            assert.ok(a.events.some((e) => e.event === 'error' && e.data.code === 'rate_limit'),
                'y se le dice por qué');
        } finally {
            a?.close();
            collab.CONFIG.PRESENCE_BURST = burst;
            collab.CONFIG.MAX_PRESENCE_PER_SEC = perSec;
            await settle(250);
        }
    });

    test('quien IGNORA la espera sigue acabando expulsado (el freno no se ha desactivado)', async () => {
        // La contracara del test anterior: relajar el strike NO puede haber desactivado el freno. Los
        // frames van muy por debajo del máximo (si no, rebotarían como 413 `too-large`, que no es un
        // problema de ritmo) y se mandan seguidos, acusando el aviso y sin respetar ninguna espera.
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
            let rateAck = 0;
            let rateSeal: string | undefined;
            for (let i = 0; i < 60 && !cerrado; i++) {
                const ops = Array.from({ length: 3 }, () => opPropSet(a!.site, counter++, `k${counter}`, 'y'.repeat(200)));
                const r = await post('jefa', `/collab/${P.cubo}/ops`, { siteId: a.site, epoch: a.welcome.epoch, ops, rateAck, rateSeal });
                // El acuse completo: número Y sello de quien lo acuñó (ver `noteRateAck`).
                if (r.status === 429) { rechazos++; rateAck = r.body.rateNotice; rateSeal = r.body.rateSeal; }
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

    test('UN FRAME EN VUELO NO PRUEBA NADA: llegar dentro de la ventana sin acusar el aviso no expulsa', async () => {
        // EL DEFECTO DE FONDO, el que hacía que el arreglo se mudara de sitio cada ronda.
        //
        // La regla anterior decía «un frame que llega dentro de la ventana = el cliente ignoró la
        // espera», y eso es FALSO EN CUANTO HAY RED: un frame que ya iba por el cable cuando el
        // servidor emitió la instrucción llega dentro de la ventana sin que su emisor pudiera saber
        // nada. Con RTT de 120 ms y tres canales a la vez (ops, presencia, resync), eso eran tres
        // strikes de un cliente impecable — y no hay arreglo posible en el cliente, porque un paquete
        // ya enviado no se puede desconvocar.
        //
        // Aquí se reproduce exactamente eso: rechazos seguidos, TODOS dentro de la ventana, con el
        // acuse que traía el frame en vuelo (ninguno). No puede cerrarse la sesión.
        const burst = collab.CONFIG.PRESENCE_BURST;
        const perSec = collab.CONFIG.MAX_PRESENCE_PER_SEC;
        collab.CONFIG.PRESENCE_BURST = 2;
        collab.CONFIG.MAX_PRESENCE_PER_SEC = 1;
        let a: Session | null = null;
        try {
            a = await openSession('mano', P.presencia, NONCE_A);
            const status: number[] = [];
            for (let i = 0; i < 12; i++) {
                const r = await post('mano', `/collab/${P.presencia}/presence`, {
                    siteId: a.site, sel: { nodeId: `n${i}` },
                });
                status.push(r.status);
            }
            assert.ok(status.includes(429), 'la contrapresión tiene que actuar: si no, el test no prueba nada');
            assert.equal(status.includes(409), false,
                `un frame en vuelo no puede costar la sesión: ${JSON.stringify(status)}`);
            assert.equal(a.ended(), false, 'y el stream sigue abierto');
            assert.equal(a.events.some((e) => e.event === 'error'), false,
                `nadie es expulsado sin prueba: ${JSON.stringify(a.events.filter((e) => e.event === 'error'))}`);
        } finally {
            a?.close();
            collab.CONFIG.PRESENCE_BURST = burst;
            collab.CONFIG.MAX_PRESENCE_PER_SEC = perSec;
            await settle(250);
        }
    });

    test('el 429 lleva SIEMPRE la espera y el número de aviso: sin eso el cliente no puede obedecer', async () => {
        // Los dos campos son el contrato entero: `retryAfterMs` es lo que el cliente espera y
        // `rateNotice` lo que devuelve para que se le pueda probar algo. Un camino que se olvidara de
        // mandarlos volvería inmune a su propio cliente Y le dejaría sin saber cuánto esperar.
        const burst = collab.CONFIG.PRESENCE_BURST;
        const perSec = collab.CONFIG.MAX_PRESENCE_PER_SEC;
        collab.CONFIG.PRESENCE_BURST = 1;
        collab.CONFIG.MAX_PRESENCE_PER_SEC = 1;
        let a: Session | null = null;
        try {
            a = await openSession('mano', P.presencia, NONCE_B);
            let visto: any = null;
            for (let i = 0; i < 8 && !visto; i++) {
                const r = await post('mano', `/collab/${P.presencia}/presence`, { siteId: a.site, sel: { nodeId: `n${i}` } });
                if (r.status === 429) visto = r.body;
            }
            assert.ok(visto, 'hacía falta al menos un 429 para mirarlo');
            assert.equal(typeof visto.retryAfterMs, 'number', 'sin `retryAfterMs` el cliente no sabe cuánto esperar');
            assert.ok(visto.retryAfterMs > 0 && visto.retryAfterMs <= collab.CONFIG.RATE_RETRY_MS,
                `la espera anunciada sale de RATE_RETRY_MS: ${visto.retryAfterMs}`);
            assert.equal(typeof visto.rateNotice, 'number', 'sin `rateNotice` no hay nada que acusar');
            assert.ok(visto.rateNotice > 0, 'el número de aviso empieza en 1');
            assert.equal(typeof visto.rateSeal, 'string', 'sin `rateSeal` el número no dice de QUÉ conexión habla');
            assert.ok(visto.rateSeal.length > 0, 'y un sello vacío no identifica nada');
        } finally {
            a?.close();
            collab.CONFIG.PRESENCE_BURST = burst;
            collab.CONFIG.MAX_PRESENCE_PER_SEC = perSec;
            await settle(250);
        }
    });

    /* --------------------------------------------------------------------------------------- */
    /* RONDA 5 — el acuse está atado a la conexión que lo acuñó                                  */
    /* --------------------------------------------------------------------------------------- */

    test('RECONECTAR no puede envenenar el contador: un acuse de la conexión ANTERIOR no cuenta en la nueva', async () => {
        // EL DEFECTO DE LA RONDA 5, reproducido contra el router real.
        //
        // El número de aviso es POR CONEXIÓN y arranca en 0, pero el acuse se fundía con `Math.max` y
        // nunca bajaba. Al reconectar, `join()` da de alta la conexión NUEVA de forma SÍNCRONA —desde
        // ese instante `findConn` la devuelve y acepta frames— y un POST rezagado de la conexión
        // anterior aterrizaba en ella con un acuse de, digamos, 4: `conn.rateAck = 4` contra un
        // contador que iba por 0, y para siempre. A partir de ahí el servidor creía que el cliente ya
        // había acusado avisos que aún no había emitido, así que el PRIMER 429 real de la conexión
        // nueva ya nacía "reconocido" y cualquier frame en vuelo dentro de su ventana sumaba strike:
        // tres seguidos y fuera. Un cliente impecable, expulsado en ~4 s (el verificador lo midió con
        // el `welcome` de 1,80 MB de una sala de 5000 ops).
        //
        // El arreglo no es un caso especial de reconexión: el acuse deja de ser un número suelto y
        // pasa a ser un PAR (número + sello de la conexión que lo acuñó). Uno de otra conexión no es
        // un acuse viejo — no es un acuse, y no se anota.
        const burst = collab.CONFIG.PRESENCE_BURST;
        const perSec = collab.CONFIG.MAX_PRESENCE_PER_SEC;
        collab.CONFIG.PRESENCE_BURST = 2;
        collab.CONFIG.MAX_PRESENCE_PER_SEC = 1;
        let a: Session | null = null;
        let b: Session | null = null;
        try {
            // --- CONEXIÓN 1: se gana un aviso de VERDAD (429 con su instrucción) y lo acusa.
            a = await openSession('jefa', P.sello, NONCE_A);
            let aviso: any = null;
            for (let i = 0; i < 6 && !aviso; i++) {
                const r = await post('jefa', `/collab/${P.sello}/presence`, { siteId: a.site, sel: { nodeId: `n${i}` } });
                if (r.status === 429) aviso = r.body;
            }
            assert.ok(aviso, 'hacía falta un 429 en la conexión 1 o no hay acuse que reutilizar');

            // --- RECONEXIÓN. El MISMO nonce da la misma identidad de réplica (el HMAC lleva dentro el
            // userId), así que es la misma persona volviendo tras un parpadeo de red: conexión nueva,
            // contador de avisos a 0, cubos llenos.
            a.close();
            await settle(200);
            b = await openSession('jefa', P.sello, NONCE_A);

            // EL FRAME REZAGADO: salió pensando en la conexión vieja y llega a la nueva. Lleva el
            // acuse de aquélla, sello incluido — o sea el peor caso posible, no una versión suavizada.
            const rezagado = await post('jefa', `/collab/${P.sello}/presence`, {
                siteId: b.site, sel: { nodeId: 'rezagado' },
                rateAck: aviso.rateNotice, rateSeal: aviso.rateSeal,
            });
            assert.ok(rezagado.status === 200 || rezagado.status === 429,
                `el frame rezagado se sirve o se frena, pero no cierra nada: ${rezagado.status}`);

            const conn = collab.findConn(P.sello, b.site, U.jefa);
            assert.ok(conn, 'la conexión nueva tiene que seguir viva');
            assert.equal(conn.rateAck, 0,
                `un acuse acuñado por otra conexión no puede anotarse aquí (rateAck=${conn.rateAck}, ` +
                `rateNotice=${conn.rateNotice}): con eso el servidor da por reconocidos avisos que aún no ha emitido`);

            // --- Y AHORA EL CLIENTE OBEDIENTE de la conexión nueva: frames SIN acuse, que es lo que
            // trae cualquier frame que ya iba por el cable. Ninguno puede costarle la sesión.
            const status: number[] = [];
            for (let i = 0; i < 12; i++) {
                const r = await post('jefa', `/collab/${P.sello}/presence`, { siteId: b.site, sel: { nodeId: `m${i}` } });
                status.push(r.status);
            }
            assert.ok(status.includes(429), 'la contrapresión tiene que actuar: si no, el test no prueba nada');
            assert.equal(status.includes(409), false,
                `reconectar no puede acabar en expulsión de quien no ha desobedecido: ${JSON.stringify(status)}`);
            assert.equal(b.ended(), false, 'y el stream de la conexión nueva sigue abierto');
            assert.equal(b.events.some((e) => e.event === 'error'), false,
                `ni un evento de error: ${JSON.stringify(b.events.filter((e) => e.event === 'error'))}`);
        } finally {
            a?.close();
            b?.close();
            collab.CONFIG.PRESENCE_BURST = burst;
            collab.CONFIG.MAX_PRESENCE_PER_SEC = perSec;
            await settle(250);
        }
    });

    test('una conexión que todavía no ha mandado su `welcome` no acumula strikes', async () => {
        // LA OTRA MITAD DE LA MISMA VENTANA. `join()` da de alta la conexión ANTES de sus `await` de
        // BD (para cerrar el TOCTOU de los cupos) y la ruta escribe el `welcome` DESPUÉS: entre esos
        // dos instantes la conexión ya acepta frames pero el cliente no sabe que existe. Castigar ahí
        // es castigar por no reconocer una instrucción de alguien que aún no se ha presentado.
        //
        // El estado se reproduce poniendo `welcomed` a false, que es EXACTAMENTE lo que vale dentro
        // de esa ventana; el resto de la sesión es real (router real, sockets reales). Y la segunda
        // mitad del test es su propio control de vacuidad: con el mismo cliente y los mismos frames,
        // en cuanto la conexión SÍ se ha presentado, la expulsión vuelve a ocurrir.
        const burst = collab.CONFIG.PRESENCE_BURST;
        const perSec = collab.CONFIG.MAX_PRESENCE_PER_SEC;
        collab.CONFIG.PRESENCE_BURST = 2;
        collab.CONFIG.MAX_PRESENCE_PER_SEC = 1;
        let a: Session | null = null;
        try {
            a = await openSession('jefa', P.ventana, NONCE_A);
            const conn = collab.findConn(P.ventana, a.site, U.jefa);
            assert.ok(conn, 'la sesión tiene que estar viva');
            conn.welcomed = false;   // …volvemos a la ventana alta→`welcome`

            // Cliente que ACUSA con el sello bueno y no espera: la desobediencia más demostrable que
            // existe. Aun así, mientras no nos hayamos presentado, no hay strike que valga.
            let rateAck = 0;
            let rateSeal: string | undefined;
            const status: number[] = [];
            for (let i = 0; i < 12; i++) {
                const r = await post('jefa', `/collab/${P.ventana}/presence`, {
                    siteId: a.site, sel: { nodeId: `n${i}` }, rateAck, rateSeal,
                });
                status.push(r.status);
                if (r.status === 429) { rateAck = r.body.rateNotice; rateSeal = r.body.rateSeal; }
            }
            assert.ok(status.includes(429), 'la contrapresión sigue actuando ahí dentro: rechazar no es castigar');
            assert.equal(status.includes(409), false,
                `sin habernos presentado no se puede expulsar a nadie: ${JSON.stringify(status)}`);
            assert.equal(conn.strikes, 0, `y no se acumula ni un strike (strikes=${conn.strikes})`);

            // CONTROL DE VACUIDAD: mismo cliente, mismos frames, ya presentados ⇒ acaba fuera.
            conn.welcomed = true;
            let cerrado = false;
            for (let i = 0; i < 30 && !cerrado; i++) {
                const r = await post('jefa', `/collab/${P.ventana}/presence`, {
                    siteId: a.site, sel: { nodeId: `z${i}` }, rateAck, rateSeal,
                });
                if (r.status === 429) { rateAck = r.body.rateNotice; rateSeal = r.body.rateSeal; }
                if (r.status === 409 && r.body.code === 'collab_no_session') cerrado = true;
            }
            assert.ok(cerrado,
                'presentados, la regla vuelve a valer: si esto no expulsa, la mitad de arriba no prueba nada');
        } finally {
            a?.close();
            collab.CONFIG.PRESENCE_BURST = burst;
            collab.CONFIG.MAX_PRESENCE_PER_SEC = perSec;
            await settle(250);
        }
    });
});

describe('la sala dice quién está dentro, no quién ha movido el cursor', () => {
    test('quien entra ve a los que YA estaban aunque nadie haya tocado el cursor', async () => {
        // `livePresence` derivaba los miembros del mapa de PRESENCIA, que solo se llena con los POST
        // de `/presence` y caduca por TTL. Al recargar una pestaña, el editor decía «no hay nadie
        // más» aunque hubiera gente conectada, hasta que esa persona moviera el cursor. Con dos
        // personas quietas, cada una se creía sola en el documento.
        //
        // Se reproduce con el TTL a cero, que es la forma determinista de «la entrada efímera ya
        // caducó» sin dormir treinta segundos: la pertenencia no puede depender de ella.
        const ttl = collab.CONFIG.PRESENCE_TTL_MS;
        let a: Session | null = null;
        let b: Session | null = null;
        try {
            a = await openSession('jefa', P.presencia, NONCE_A);
            collab.CONFIG.PRESENCE_TTL_MS = 0;
            await settle(30);

            b = await openSession('mano', P.presencia, NONCE_B);
            const vistos = (b.welcome.members || []).map((m: any) => m.siteId);
            assert.deepEqual(vistos, [a.site],
                `la pertenencia sale de las CONEXIONES vivas, no de una presencia efímera caducada: ${JSON.stringify(b.welcome.members)}`);
            assert.equal(b.welcome.members[0].sel, null, 'sin selección conocida, el hecho de estar ya es información');
            assert.equal(vistos.includes(b.site), false, 'y uno no se ve a sí mismo entre los compañeros');
        } finally {
            collab.CONFIG.PRESENCE_TTL_MS = ttl;
            a?.close();
            b?.close();
            await settle(250);
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
        // Las SONDAS de columna se registran aparte. El assert «no usa PRAGMA» miraba `exec`/`run`,
        // donde un PRAGMA no puede aparecer NUNCA (la sonda va por `get` en MySQL y por `all` en
        // SQLite): era un assert que no podía fallar. Registrando los dos caminos, una regresión a la
        // rama SQLite mete aquí el `PRAGMA table_info` y el assert se pone rojo de verdad.
        const sondas: string[] = [];
        const ctx = {
            exec: async (s: string) => { sql.push(s); },
            run: async (s: string) => { sql.push(s); },
            get: async (s: string) => { sondas.push(s); return null; },   // ninguna columna existe aún
            all: async (s: string) => { sondas.push(s); throw new Error('PRAGMA no existe en MariaDB'); },
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
        // Y la sonda de columnas usa information_schema, no PRAGMA (que en MariaDB no existe).
        assert.ok(sondas.length > 0, 'la migración TIENE que sondar las columnas antes de tocarlas');
        assert.ok(!sondas.some((s) => /PRAGMA/i.test(s)),
            `la sonda de columnas no puede ser un PRAGMA con el driver mariadb:\n${sondas.join('\n')}`);
        assert.ok(sondas.some((s) => /information_schema/i.test(s)),
            `tiene que sondar por information_schema:\n${sondas.join('\n')}`);
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
