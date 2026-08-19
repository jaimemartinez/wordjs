/**
 * Auditoría 2026-08, grupo G1 (colaboración) — hallazgos 12, 20 y 23.
 *
 * Contra el router REAL sobre un servidor HTTP real y, en el caso del lock, contra el módulo REAL
 * con el motor cambiado por la única costura que decide su comportamiento (`getDbType`). Nada de
 * objetos a mano: este repo ya se ha comido varias veces un test que consagraba una forma que el
 * productor no emite.
 *
 *   #12 — `POST /presence/:postId` autorizaba por la capacidad GLOBAL `edit_posts`, que es permiso
 *         sobre una FAMILIA de contenido, no sobre esa fila. Un contributor barría `postId` 1..N y
 *         se enteraba de quién tenía abierto cualquier borrador privado, y además ESCRIBÍA: aparecía
 *         con su nombre en el chip «X también está editando» de un post que no puede ni leer. Aquí
 *         se fija que las dos superficies —presencia legacy y sala en vivo— aplican EL MISMO gate,
 *         `core/post-capabilities.canEditPostRecord`, y que ninguna opera sobre tipos internos.
 *
 *   #20 — el log de una sala tenía tope de FILAS y de FRAME, pero no de BYTES: 5000 filas de ~250 KB
 *         son ~1,25 GB que `loadOps` traía enteros al heap en cada entrada a la sala. Aquí se fija
 *         que hay tope de tamaño al ESCRIBIR (y que salta MUY por debajo del tope de filas, que es
 *         lo que demuestra que el de filas no era una cota de memoria), presupuesto duro al LEER, y
 *         que un `resync` paga de verdad los bytes que sirve.
 *
 *   #23 — el lock distribuido preguntaba `isPg()` y concedía en cualquier otro motor. Aquí se fija
 *         que MySQL tiene implementación real (con SU dialecto de reloj) y que un motor sin
 *         implementación falla CERRADO en vez de mentir con «concedido».
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-g1-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const collab = require('../core/collab-rooms');
const distLock = require('../core/dist-lock');

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

/* --- cliente SSE mínimo, igual que en collab-routes.test.ts (event: + data: + línea en blanco) --- */

type Stream = {
    events: { event: string; data: any }[];
    waitFor: (event: string, timeoutMs?: number) => Promise<any>;
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
                waitFor: (event, timeoutMs = 4000) => new Promise((res2, rej2) => {
                    const found = events.find((e) => e.event === event);
                    if (found) return res2(found.data);
                    const timer = setTimeout(() => rej2(new Error(`timeout esperando "${event}"`)), timeoutMs);
                    waiters.push({ event, resolve: (v) => { clearTimeout(timer); res2(v); } });
                }),
                close: () => { try { req.destroy(); res.destroy(); } catch { /* ya cerrado */ } },
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

const NONCE_A = 's_aaaaaaaaaaaaaaaa';
const NONCE_B = 's_bbbbbbbbbbbbbbbb';

const hlc = (site: string, l = 100) => ({ l, c: 0, site });
const opPropSet = (site: string, counter: number, key: string, value: any) =>
    ({ k: 'propSet', id: { site, counter }, hlc: hlc(site, 100 + counter), nodeId: 'n1', key, value });

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();
    // El registro de tipos, como en producción: sin él la familia de capacidades cae al comodín y el
    // gate POR TIPO —la mitad del hallazgo 12— no se ejercita.
    await require('../core/post-types').initPostTypes();

    await seedUser('jefa', 'administrator');
    await seedUser('colabora', 'contributor');
    await seedUser('otra', 'author');
    // Cuenta propia para el presupuesto de lectura: el cubo cuelga del USUARIO, así que compartirlo
    // con `jefa` haría que el saldo gastado aquí se notara en los demás tests (y al revés).
    await seedUser('gorron', 'administrator');

    P.propio = (await Post.create({ authorId: U.colabora, title: 'Borrador propio', type: 'post', status: 'draft' })).id;
    P.ajeno = (await Post.create({ authorId: U.otra, title: 'Borrador ajeno', type: 'post', status: 'draft' })).id;
    P.publicado = (await Post.create({ authorId: U.colabora, title: 'Ya publicado', type: 'post', status: 'publish' })).id;
    P.pagina = (await Post.create({ authorId: U.colabora, title: 'Una página', type: 'page', status: 'draft' })).id;
    P.revision = (await Post.create({ authorId: U.jefa, title: 'Instantánea', type: 'revision', status: 'inherit' })).id;
    P.bytes = (await Post.create({ authorId: U.jefa, title: 'Log gordo', type: 'post', status: 'draft' })).id;
    P.tope = (await Post.create({ authorId: U.jefa, title: 'Tope de bytes', type: 'post', status: 'draft' })).id;
    P.cobro = (await Post.create({ authorId: U.jefa, title: 'Cobro del resync', type: 'post', status: 'draft' })).id;
    P.presu = (await Post.create({ authorId: U.jefa, title: 'Presupuesto de lectura', type: 'post', status: 'draft' })).id;
    P.mide = (await Post.create({ authorId: U.jefa, title: 'Coste de medir', type: 'post', status: 'draft' })).id;
    P.uni = (await Post.create({ authorId: U.jefa, title: 'Bytes o caracteres', type: 'post', status: 'draft' })).id;
    // El orden de creación FIJA el orden del cursor del barrido (`ORDER BY post_id`): A antes que B.
    P.barreA = (await Post.create({ authorId: U.jefa, title: 'Sala vieja pero viva', type: 'post', status: 'draft' })).id;
    P.barreB = (await Post.create({ authorId: U.jefa, title: 'Sala retirable', type: 'post', status: 'draft' })).id;

    const VACIO = JSON.stringify({ root: { props: {} }, content: [] });
    for (const k of ['propio', 'bytes', 'tope', 'cobro', 'presu', 'mide', 'uni', 'barreA', 'barreB']) {
        await Post.updateMeta(P[k], '_puck_data', VACIO);
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

describe('#12 la presencia se autoriza por EL POST, no por la familia de capacidades', () => {
    test('un contributor NO obtiene presencia de un borrador ajeno — y tampoco entra en él', async () => {
        // La mitad de LECTURA: antes esto era un 200 con la lista de quién lo tiene abierto.
        const r = await post('colabora', `/presence/${P.ajeno}`, {});
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'rest_forbidden');

        // La mitad de ESCRITURA, que es la que un status no demuestra: el dueño legítimo no puede ver
        // al atacante en su chip de coeditores.
        const dueno = await post('otra', `/presence/${P.ajeno}`, {});
        assert.equal(dueno.status, 200);
        assert.deepEqual(dueno.body.editors, [],
            `nadie que no pueda editar el post puede aparecer en su presencia: ${JSON.stringify(dueno.body.editors)}`);
    });

    test('CONTROL POSITIVO: sobre su PROPIO borrador el mismo contributor sí late', async () => {
        const r = await post('colabora', `/presence/${P.propio}`, {});
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.editors, []);
    });

    test('su propio post YA PUBLICADO también rebota: falta `edit_published_posts`', async () => {
        // Exactamente la tercera línea del gate compartido. Con la capacidad global bastaba con
        // `edit_posts` y un contributor entraba en lo que el sitio está sirviendo.
        const r = await post('colabora', `/presence/${P.publicado}`, {});
        assert.equal(r.status, 403);
        assert.equal((await post('jefa', `/presence/${P.publicado}`, {})).status, 200);
    });

    test('una `page` propia rebota: la FAMILIA la elige el tipo del post', async () => {
        const r = await post('colabora', `/presence/${P.pagina}`, {});
        assert.equal(r.status, 403, 'un contributor tiene edit_posts, no edit_pages');
    });

    test('un tipo INTERNO no tiene presencia ni para un administrador', async () => {
        // `revision` es una fila de `posts` sin `capability_type`: la familia la dejaba caer en la de
        // `post` y quedaba tan accesible como cualquier entrada.
        const r = await post('jefa', `/presence/${P.revision}`, {});
        assert.equal(r.status, 403);
    });

    test('`leave` NO se deniega: retirarse solo puede borrar la entrada de uno mismo', async () => {
        // Denegar una RETIRADA no protege nada, y sí hace daño: al publicar un borrador que su autor
        // tiene abierto, su beacon de `beforeunload` rebotaría y su nombre se quedaría en el chip de
        // los demás hasta agotar el TTL. La respuesta es constante, así que no es un oráculo.
        const r = await post('colabora', `/presence/${P.ajeno}`, { action: 'leave' });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { ok: true, editors: [] });
    });

    test('DENEGAR NO DICE SI EL POST EXISTE: inexistente y prohibido responden IGUAL', async () => {
        // El arreglo del hallazgo 12 introdujo un oráculo de existencia por la puerta de atrás: 404
        // para «no hay tal fila» y 403 para «existe pero no puedes editarla» son dos respuestas, y la
        // diferencia ES la respuesta a «¿existe el post N?» — recorrible id a id. Y como el gate ya no
        // es la capacidad GLOBAL sino la de la fila, quien puede sondear ya no es un contributor: es
        // cualquier cuenta autenticada. `GET /posts/:id` se niega a hacer esa distinción a propósito
        // (404 tanto para lo que no existe como para el borrador ajeno); aquí también.
        const inexistente = await post('jefa', `/presence/999999`, {});
        const prohibido = await post('colabora', `/presence/${P.ajeno}`, {});
        assert.equal(inexistente.status, prohibido.status,
            'el status no puede depender de si la fila existe');
        assert.deepEqual(inexistente.body, prohibido.body,
            'ni el cuerpo: un código distinto es el mismo oráculo escrito de otra forma');
        assert.equal(inexistente.body.editors, undefined);
    });

    test('GEMELA — el canal en vivo aplica EL MISMO gate sobre las MISMAS filas', async () => {
        // Las dos superficies conviven (`VersoEditor` usa la legacy mientras la sala no esté `live`),
        // así que la prueba de que ya no divergen es que responden igual a las mismas entradas.
        for (const [postId, esperado] of [[P.ajeno, 403], [P.publicado, 403], [P.pagina, 403], [P.revision, 403]] as const) {
            const stream = await request(origin).get(`/api/v1/collab/${postId}/stream?siteId=${NONCE_A}`)
                .set('Cookie', `wordjs_token=${tok(postId === P.revision ? 'jefa' : 'colabora')}`)
                .set('Origin', origin);
            const presencia = await post(postId === P.revision ? 'jefa' : 'colabora', `/presence/${postId}`, {});
            assert.equal(stream.status, esperado, `stream de ${postId}`);
            assert.equal(presencia.status, esperado, `presencia de ${postId}`);
        }
    });
});

/* ------------------------------------------------------------------------------------------- */

describe('#20 el log tiene tope de BYTES, no solo de filas', () => {
    test('el tope de ESCRITURA salta muy por debajo del tope de FILAS y marca la sala', async () => {
        // El tope de bytes se baja para que el test dure milisegundos; lo que se comprueba no es el
        // número, es que EXISTE una cota de tamaño y que es ella la que para la escritura mientras el
        // contador de filas sigue en 2. Con solo el tope de filas hacían falta 5000 filas de 250 KB.
        const original = collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH;
        collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH = 3_000;
        let a: Session | null = null;
        try {
            a = await openSession('jefa', P.tope, NONCE_A);
            const grande = 'x'.repeat(2_000);

            const uno = await post('jefa', `/collab/${P.tope}/ops`,
                { siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'k1', grande)] });
            assert.equal(uno.status, 200);
            assert.equal(uno.body.persisted, true, 'el primero cabe');

            const dos = await post('jefa', `/collab/${P.tope}/ops`,
                { siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 2, 'k2', grande)] });
            assert.equal(dos.status, 200, 'se sigue COLABORANDO: la difusión no para');
            assert.equal(dos.body.persisted, false, 'pero ya no se persiste: el log llegó a su tamaño');

            const filas = await dbAsync.get(
                'SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ? AND epoch = ?', [P.tope, a.welcome.epoch]);
            assert.equal(Number(filas.c), 1,
                'y ha parado con UNA fila persistida: el tope de filas (5000) no era una cota de memoria');

            const doc = await dbAsync.get('SELECT truncated FROM collab_docs WHERE post_id = ?', [P.tope]);
            assert.equal(Number(doc.truncated), 1, 'la bandera pegajosa es la que ya existía: se REUSA');

            // Y el que entra después se entera ANTES de empezar, no cuando pierda algo.
            const b = await openSession('jefa', P.tope, NONCE_B);
            try {
                assert.equal(b.welcome.truncated, true);
            } finally { b.close(); }
        } finally {
            a?.close();
            collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH = original;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.tope]);
            await dbAsync.run('UPDATE collab_docs SET truncated = 0 WHERE post_id = ?', [P.tope]);
        }
    });

    test('la LECTURA tiene su propio presupuesto duro: el `welcome` deja de acumular y lo dice', async () => {
        // Ésta es la cota de memoria de verdad. Un log escrito antes de que existiera el tope de bytes
        // puede pesar cientos de MB, y quien entra hoy no puede pagarlo: se sirve lo que cabe y la
        // sesión se declara NO reanudable con la bandera que ya significa eso.
        const original = collab.CONFIG.MAX_LOG_LOAD_BYTES;
        collab.CONFIG.MAX_LOG_LOAD_BYTES = 4_000;
        let a: Session | null = null;
        try {
            for (let i = 1; i <= 40; i++) {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [P.bytes, 1, 's_zzzzzzzzzzzzzzzz', i, 'propSet',
                        JSON.stringify(opPropSet('s_zzzzzzzzzzzzzzzz', i, `k${i}`, 'x'.repeat(400))), U.jefa]);
            }
            a = await openSession('jefa', P.bytes, NONCE_A);
            assert.ok(a.welcome.ops.length > 0, 'lo que cabe se sirve');
            assert.ok(a.welcome.ops.length < 40,
                `no puede venir el log entero: cabían ~8 ops de 400 B en 4000 B (vinieron ${a.welcome.ops.length})`);
            assert.equal(a.welcome.truncated, true,
                'y servir de menos SIN decirlo es la mentira que este flag existe para evitar');

            // El `resync` cuenta la misma verdad por su propio campo.
            const rs = await post('jefa', `/collab/${P.bytes}/resync`, { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(rs.status, 200);
            assert.equal(rs.body.complete, false);
        } finally {
            a?.close();
            collab.CONFIG.MAX_LOG_LOAD_BYTES = original;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.bytes]);
        }
    });

    test('un `resync` PAGA los bytes que sirve: el segundo seguido rebota con espera', async () => {
        // El refutador de la auditoría: `resync` cobraba `rateGate(conn, RESYNC_OP_COST, 0)` y la
        // condición de rechazo del cubo de bytes es `(bytes > 0 && byteTokens < bytes)`, falsa siempre
        // con 0. La deuda que dejaba `chargeBytes` no frenaba nada. Con el mínimo cobrado por
        // adelantado, el descubierto vuelve a ser una espera — un 429 CON instrucción, no un cierre.
        let a: Session | null = null;
        try {
            // ~300 KB de log: por encima de BYTES_BURST (256 KB), así que el primer resync deja el
            // cubo en el suelo del descubierto.
            for (let i = 1; i <= 3; i++) {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [P.cobro, 1, 's_wwwwwwwwwwwwwwww', i, 'propSet',
                        JSON.stringify(opPropSet('s_wwwwwwwwwwwwwwww', i, `k${i}`, 'x'.repeat(100_000))), U.jefa]);
            }
            a = await openSession('jefa', P.cobro, NONCE_A);
            const uno = await post('jefa', `/collab/${P.cobro}/resync`, { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(uno.status, 200, 'el primero es legítimo y se sirve entero');

            const dos = await post('jefa', `/collab/${P.cobro}/resync`, { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(dos.status, 429, 'el repetidor ya no es gratis');
            assert.ok(dos.body.retryAfterMs > 0, 'y el rechazo lleva SU instrucción, como todos');
            assert.ok(typeof dos.body.rateSeal === 'string' && dos.body.rateSeal.length > 0,
                'con el sello de la conexión que la acuñó: sin él el número no identifica nada');

            // Contrapartida no negociable: la PRESENCIA no gasta bytes, así que la deuda no puede
            // dejar mudo a quien solo mueve el cursor (el defecto que costó tres rondas).
            const pres = await post('jefa', `/collab/${P.cobro}/presence`, { siteId: a.site, sel: { nodeId: 'n1' } });
            assert.equal(pres.status, 200);
        } finally {
            a?.close();
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.cobro]);
        }
    });
});

/* ------------------------------------------------------------------------------------------- */

describe('#20 (verificación) el cobro de la lectura, por sus dos puertas y sin coste nuevo', () => {
    const SITIO = 's_qqqqqqqqqqqqqqqq';

    const sembrarLog = async (postId: number, n: number, tam: number) => {
        for (let i = 1; i <= n; i++) {
            await dbAsync.run(
                'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [postId, 1, SITIO, i, 'propSet',
                    JSON.stringify(opPropSet(SITIO, i, `k${i}`, 'x'.repeat(tam))), U.jefa]);
        }
    };

    test('RECONECTAR NO ES GRATIS: `join` también paga el log, y contra el saldo DEL USUARIO', async () => {
        // El cobro se le puso a `resync`, pero `join` lee EL MISMO log por EL MISMO camino y tiraba el
        // campo `bytes`. Y el cubo de la conexión no sirve para acotarlo: reconectar con el mismo
        // `siteId` desaloja la conexión anterior y la nueva NACE CON EL CUBO LLENO, así que quien
        // quiera repetir la lectura no pide una reanudación — cierra el stream y lo reabre. El saldo
        // tiene que colgar de algo que sobreviva a la conexión, y eso es el usuario.
        const burst = collab.CONFIG.USER_READ_BURST;
        const rate = collab.CONFIG.USER_READ_BYTES_PER_SEC;
        collab.CONFIG.USER_READ_BURST = 8_000;
        collab.CONFIG.USER_READ_BYTES_PER_SEC = 1;   // sin recarga apreciable durante el test
        let a: Session | null = null;
        try {
            await sembrarLog(P.presu, 40, 400);      // ~20 KB de log: más que el saldo

            a = await openSession('gorron', P.presu, NONCE_A);
            assert.ok(a.welcome.ops.length > 0, 'la PRIMERA lectura es legítima y se sirve entera');

            // GEMELA: la otra puerta a la misma lectura queda cerrada por el MISMO saldo, no por el
            // cubo de la conexión (20 KB no acercan siquiera a `BYTES_BURST`, que son 256 KB).
            const rs = await post('gorron', `/collab/${P.presu}/resync`,
                { siteId: a.site, epoch: a.welcome.epoch, vv: {} });
            assert.equal(rs.status, 429, 'sin saldo de lectura no se vuelve a servir el log');
            assert.ok(rs.body.retryAfterMs > 0, 'y el rechazo lleva SU instrucción, como todos');
            assert.ok(typeof rs.body.rateSeal === 'string' && rs.body.rateSeal.length > 0);

            // CONTRAPARTIDA NO NEGOCIABLE: la deuda de LECTURA no puede dejar mudo a quien escribe.
            // Es el cubo aparte lo que lo garantiza — el de la conexión conserva su suelo justamente
            // para que la subida nunca se congele.
            const escribe = await post('gorron', `/collab/${P.presu}/ops`,
                { siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'sigo', 'editando')] });
            assert.equal(escribe.status, 200, 'leer de más no puede impedir GUARDAR');

            // Y la puerta de la reconexión: el stream nuevo no consigue `welcome`, consigue el motivo.
            a.close();
            await settle(250);
            const otra = await openStream('gorron', P.presu, NONCE_B);
            try {
                const err = await otra.waitFor('error');
                assert.equal(err.code, 'read-budget',
                    'reabrir el stream era la puerta por la que el log volvía al heap gratis');
            } finally { otra.close(); }
        } finally {
            a?.close();
            collab.CONFIG.USER_READ_BURST = burst;
            collab.CONFIG.USER_READ_BYTES_PER_SEC = rate;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.presu]);
        }
    });

    test('MEDIR EL LOG NO SE PAGA EN CADA FRAME: un escaneo por sala, no uno por op', async () => {
        // `pushOps` contaba filas con `COUNT(*)`, que el índice resuelve como covering index. El tope
        // de bytes lo cambió por un `SUM(...)` sobre el payload, que obliga a LEERLOS TODOS en cada
        // frame aceptado: coste cuadrático para llenar un epoch y, con better-sqlite3 —que es
        // SÍNCRONO—, event loop del proceso bloqueado en cada frame. Arreglar una cota de MEMORIA no
        // puede costar una cota de CPU.
        const orig = dbAsync.get;
        const consultas: string[] = [];
        (dbAsync as any).get = async (q: any, p: any) => { consultas.push(String(q)); return orig.call(dbAsync, q, p); };
        let a: Session | null = null;
        try {
            a = await openSession('jefa', P.mide, NONCE_A);
            consultas.length = 0;
            for (let i = 1; i <= 4; i++) {
                const r = await post('jefa', `/collab/${P.mide}/ops`,
                    { siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, i, `k${i}`, 'contenido')] });
                assert.equal(r.status, 200);
                assert.equal(r.body.persisted, true, `el frame ${i} tiene que caber`);
            }
            const escaneos = consultas.filter((q) => /SUM\(/.test(q)).length;
            assert.ok(escaneos <= 2,
                `cuatro frames aceptados no pueden costar cuatro escaneos del log (fueron ${escaneos})`);
            assert.ok(escaneos >= 1, 'pero el tamaño sí se mide: no se ha dejado de comprobar el tope');

            // Y el tope SIGUE EN PIE con la cuenta en memoria: lo que se lleva sumado es lo insertado.
            const cuenta = await dbAsync.get(
                'SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.mide]);
            assert.equal(Number(cuenta.c), 4);
        } finally {
            (dbAsync as any).get = orig;
            a?.close();
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.mide]);
        }
    });

    test('el tope del log mide BYTES, no CARACTERES: un log CJK no vale por tres', async () => {
        // `SUM(LENGTH(payload))` cuenta CARACTERES en SQLite y Postgres, y se comparaba con
        // `Buffer.byteLength`, que son BYTES: con contenido CJK el techo real se multiplicaba por tres
        // sin que nadie lo decidiera, y eso rompe la razón por la que `MAX_LOG_LOAD_BYTES` está por
        // encima de `MAX_LOG_BYTES_PER_EPOCH` — «un log que respeta el tope se sirve SIEMPRE entero».
        // Un sitio en japonés perdía la reanudación con un log que el guard de escritura daba por bueno.
        const original = collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH;
        const CJK = String.fromCodePoint(0x597d);    // 好 — 3 bytes en UTF-8, 1 carácter
        let a: Session | null = null;
        try {
            const muestra = JSON.stringify(opPropSet(SITIO, 1, 'k1', CJK.repeat(1200)));
            const bytes = Buffer.byteLength(muestra, 'utf8');
            const chars = muestra.length;
            assert.ok(bytes > chars * 2, 'el fixture tiene que ser multibyte de verdad');

            for (let i = 1; i <= 2; i++) {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [P.uni, 1, SITIO, i, 'propSet',
                        JSON.stringify(opPropSet(SITIO, i, `k${i}`, CJK.repeat(1200))), U.jefa]);
            }

            // El tope se coloca ENTRE las dos medidas del MISMO log: por encima de lo que suman sus
            // caracteres y por debajo de lo que suman sus bytes. Ahí es donde las dos unidades dan
            // veredictos opuestos, y por eso este número no es arbitrario.
            collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH = 2 * chars + 2_000;
            assert.ok(collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH < 2 * bytes, 'el tope tiene que quedar en medio');

            a = await openSession('jefa', P.uni, NONCE_A);
            const r = await post('jefa', `/collab/${P.uni}/ops`,
                { siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 1, 'nuevo', 'corto')] });
            assert.equal(r.status, 200, 'se sigue COLABORANDO');
            assert.equal(r.body.persisted, false,
                'midiendo caracteres el log parece caber en un tercio de lo que ocupa y se sigue escribiendo');

            const filas = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.uni]);
            assert.equal(Number(filas.c), 2, 'y no ha entrado ninguna fila más');
        } finally {
            a?.close();
            collab.CONFIG.MAX_LOG_BYTES_PER_EPOCH = original;
            await settle(250);
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.uni]);
            await dbAsync.run('UPDATE collab_docs SET truncated = 0 WHERE post_id = ?', [P.uni]);
        }
    });

    test('el barrido AVANZA: un lote de salas vivas no lo deja famélico para siempre', async () => {
        // El `LIMIT` que acotó el pico de memoria no llevaba cursor, y el lote era siempre el de las
        // MÁS ANTIGUAS: las filas que el bucle descarta —viva en este nodo, viva en otro— vuelven a
        // encabezar el orden en la pasada siguiente. Con el lote lleno de ésas, ninguna sala retirable
        // se examina JAMÁS y las tablas crecen sin límite, que es lo contrario de lo que el barrido
        // existe para hacer.
        const original = collab.CONFIG.MAX_SWEEP_ROOMS;
        collab.CONFIG.MAX_SWEEP_ROOMS = 1;           // un lote de una: la sala viva lo llena entero
        let viva: Session | null = null;
        try {
            viva = await openSession('jefa', P.barreA, NONCE_A);
            const efimera = await openSession('jefa', P.barreB, NONCE_B);
            efimera.close();
            await settle(300);                       // que su `leave` termine y suelte la liveness

            // Solo estas dos salas son candidatas: las demás se mandan al futuro para que el corte por
            // antigüedad las excluya y el recuento de retiradas sea exacto.
            await dbAsync.run('UPDATE collab_docs SET updated_ms = ? WHERE post_id <> ? AND post_id <> ?',
                [Date.now() + 3_600_000, P.barreA, P.barreB]);
            await dbAsync.run('UPDATE collab_docs SET updated_ms = ? WHERE post_id = ? OR post_id = ?',
                [Date.now() - 600_000, P.barreA, P.barreB]);

            const primera = await collab.sweepIdleRooms(60_000);
            assert.equal(primera, 0, 'el lote entero es la sala VIVA: no se retira nada, y está bien');
            const segunda = await collab.sweepIdleRooms(60_000);
            assert.equal(segunda, 1,
                'sin cursor el segundo lote vuelve a ser la MISMA sala viva y no se retira nunca nada');

            const doc = await dbAsync.get('SELECT base_doc FROM collab_docs WHERE post_id = ?', [P.barreB]);
            assert.equal(String(doc.base_doc || ''), '', 'la retirada es real, no un contador');
        } finally {
            viva?.close();
            collab.CONFIG.MAX_SWEEP_ROOMS = original;
            await settle(250);
        }
    });
});

/* ------------------------------------------------------------------------------------------- */

describe('#23 el lock distribuido: motor de RED compartido, no «¿es Postgres?»', () => {
    // La única costura que decide el comportamiento del módulo es `getDbType()`, y `dist-lock` la
    // pregunta EN CADA LLAMADA (no la cachea). Sustituirla aquí ejercita el código real de cada
    // primitiva contra cada motor, que es lo que no se puede hacer con un objeto a mano.
    const realGetDbType = database.getDbType;
    const realDbAsync = database.dbAsync;
    let sql: string[] = [];

    const conMotor = async (driver: string, isPostgres: boolean, isMySQL: boolean, fn: () => Promise<void>) => {
        sql = [];
        database.getDbType = () => ({ isPostgres, isMySQL, isSQLite: !isPostgres, driver });
        database.dbAsync = {
            run: async (q: string) => { sql.push(q); return { lastID: 0, changes: 1 }; },
            exec: async (q: string) => { sql.push(q); },
            get: async () => undefined,
            all: async () => [],
        };
        try { await fn(); } finally {
            database.getDbType = realGetDbType;
            database.dbAsync = realDbAsync;
        }
    };

    test('MySQL/MariaDB toman el camino REAL, con su dialecto de reloj', async () => {
        for (const driver of ['mysql', 'mariadb']) {
            await conMotor(driver, false, true, async () => {
                await distLock.ensureLockTable();
                assert.ok(sql.some((q) => /CREATE TABLE IF NOT EXISTS wordjs_locks/.test(q)),
                    `${driver}: la tabla del lock NI SIQUIERA SE CREABA — el no-op empezaba ahí`);
                assert.equal(await distLock.tryAcquire('wordjs:boot', 1000), true);
                const cas = sql.find((q) => /UPDATE wordjs_locks SET holder/.test(q)) || '';
                assert.ok(/UNIX_TIMESTAMP/.test(cas), `${driver}: el reloj tiene que ser el de MySQL: ${cas}`);
                assert.ok(!/EXTRACT\(EPOCH/.test(cas), `${driver}: EXTRACT(EPOCH …) es sintaxis exclusiva de Postgres`);
            });
        }
    });

    test('Postgres sigue exactamente igual', async () => {
        await conMotor('postgres', true, false, async () => {
            assert.equal(await distLock.tryAcquire('wordjs:cron', 1000), true);
            const cas = sql.find((q) => /UPDATE wordjs_locks SET holder/.test(q)) || '';
            assert.ok(/EXTRACT\(EPOCH FROM now\(\)\)/.test(cas), cas);
        });
    });

    test('SQLite sigue siendo un no-op concedido, y no toca la BD', async () => {
        await conMotor('sqlite-native', false, false, async () => {
            const h = await distLock.acquireBlocking('wordjs:boot', { timeoutMs: 50 });
            assert.equal(h.held, true, 'un solo host no tiene con quién competir');
            await h.release();
            let corrio = false;
            await distLock.runAsLeader('wordjs:cron', {}, async () => { corrio = true; });
            assert.equal(corrio, true);
            assert.deepEqual(sql, [], 'y no escribe una sola sentencia');
        });
    });

    test('tras el asistente la tabla NO existe todavía: `tryAcquire` ni revienta ni miente', async () => {
        // La instalación arranca en `sqlite-native`, así que `ensureLockTable` —cuyo único llamador es
        // el arranque— no crea nada; el asistente cambia el motor EN CALIENTE (`routes/setup.ts` hace
        // `init({driver:'mysql'})` + `initializeDatabase()`) y no hay reinicio. Desde ese instante las
        // primitivas son REALES contra una tabla que no existe. `tryAcquire` era la ÚNICA sin
        // try/catch, así que el error subía por `acquireBlocking` hasta `setInterval(runCron)`, cuya
        // promesa nadie espera: el cron entero —publicación programada, backups, renovación ACME— se
        // paraba EN SILENCIO hasta el siguiente reinicio.
        sql = [];
        let creada = false;
        const faltaLaTabla = () => {
            const e: any = new Error("Table 'wordjs.wordjs_locks' doesn't exist");
            e.code = 'ER_NO_SUCH_TABLE';
            e.errno = 1146;
            return e;
        };
        database.getDbType = () => ({ isPostgres: false, isMySQL: true, isSQLite: false, driver: 'mysql' });
        database.dbAsync = {
            run: async (q: string) => { sql.push(q); if (!creada) throw faltaLaTabla(); return { changes: 1 }; },
            exec: async (q: string) => { sql.push(q); if (/CREATE TABLE IF NOT EXISTS wordjs_locks/.test(q)) creada = true; },
            get: async () => undefined,
            all: async () => [],
        };
        try {
            // Dos intentos seguidos, como los que hace el cron: ninguno puede LANZAR (eso es lo que
            // mataba el planificador) y al final la tabla tiene que estar creada y el lock concedido.
            const uno = await distLock.tryAcquire('wordjs:cron', 1000);
            const dos = await distLock.tryAcquire('wordjs:cron', 1000);
            assert.equal(typeof uno, 'boolean', 'una excepción aquí es el cron muerto');
            assert.equal(dos, true, 'y el lock se recupera solo: la tabla se crea al detectar que falta');
            assert.ok(sql.some((q) => /CREATE TABLE IF NOT EXISTS wordjs_locks/.test(q)),
                'nadie más va a crearla: `ensureLockTable` solo corre en el arranque, con otro motor');
        } finally {
            database.getDbType = realGetDbType;
            database.dbAsync = realDbAsync;
        }
    });

    test('si la tabla NO se puede ni crear, se responde «no concedido» — nunca una excepción', async () => {
        // Fail-closed de verdad: sin permiso de CREATE el lock no existe, pero el proceso sigue vivo y
        // el cron sigue latiendo (sin correr, que es lo correcto: correr sin lock son backups
        // duplicados y N órdenes ACME a la vez).
        sql = [];
        database.getDbType = () => ({ isPostgres: false, isMySQL: true, isSQLite: false, driver: 'mysql' });
        database.dbAsync = {
            run: async (q: string) => { sql.push(q); throw new Error('ER_NO_SUCH_TABLE: wordjs_locks does not exist'); },
            exec: async () => { throw new Error('CREATE command denied'); },
            get: async () => undefined,
            all: async () => [],
        };
        try {
            assert.equal(await distLock.tryAcquire('wordjs:cron', 1000), false);
            const h = await distLock.acquireBlocking('wordjs:boot', { timeoutMs: 50, pollMs: 10 });
            assert.equal(h.held, false, 'el bucle de poll tampoco puede dejar escapar la excepción');
            let corrio = false;
            await distLock.runAsLeader('wordjs:cron', {}, async () => { corrio = true; });
            assert.equal(corrio, false);
        } finally {
            database.getDbType = realGetDbType;
            database.dbAsync = realDbAsync;
        }
    });

    test('un motor SIN implementación falla CERRADO: no-concedido, no «concedido»', async () => {
        // El corazón del hallazgo: la puerta decía «no es Postgres ⇒ no hace falta lock» cuando la
        // verdad era «no es Postgres ⇒ el lock no está implementado». Con dos réplicas eso son dos
        // siembras simultáneas de la BD y N órdenes ACME a la vez.
        await conMotor('cockroach', false, false, async () => {
            assert.equal(await distLock.tryAcquire('wordjs:boot', 1000), false);
            const h = await distLock.acquireBlocking('wordjs:boot', { timeoutMs: 50 });
            assert.equal(h.held, false, 'index.ts ya sabe reiniciar con esto; con `true` sembraba dos veces');
            let corrio = false;
            await distLock.runAsLeader('wordjs:cron', {}, async () => { corrio = true; });
            assert.equal(corrio, false, 'y el cron NO puede correr en todas las réplicas a la vez');
        });
    });
});
