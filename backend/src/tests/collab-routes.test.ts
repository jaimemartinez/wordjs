/**
 * Verso/colaboración — TRANSPORTE Y AUTORIZACIÓN, contra el router REAL sobre un servidor HTTP real.
 *
 * Aquí no se simula el transporte: se abre un `EventSource` de verdad (a pelo con `http.get`, que es
 * lo que hace el navegador) y se suben ops por POST, exactamente como lo hará el editor. Lo que fija
 * esta suite:
 *
 *   AUTORIZACIÓN — la sala se autoriza por la capacidad de editar ESE post, reutilizando el mismo
 *   gate que `PUT /posts/:id`: un contributor no entra en una `page` ajena (G-F8.3-a), ni en un post
 *   de otro, ni en uno ya publicado; sí entra en su propio borrador. Y la autorización NO es de una
 *   sola vez: el stream se vuelve a autorizar mientras vive.
 *
 *   CSRF — el stream es un GET, así que el `csrfProtection` global (que solo mira métodos que
 *   cambian estado) NO lo cubre: un Origin cross-site tiene que rebotar aquí (G-F8.3-b). Sin esto,
 *   un sitio hostil leería en vivo el borrador de la víctima con su cookie ambiental.
 *
 *   ATRIBUCIÓN — la identidad de réplica la DERIVA el servidor del `userId` de quien pide, así que
 *   el `siteId` de un compañero (que es público: viaja en `members`, `presence` y en cada op) no
 *   sirve para emitir a su nombre NI SIQUIERA en un nodo que nunca ha visto esa sala.
 *
 *   NO PERDER NADA EN SILENCIO — un fallo de BD no se reporta como éxito; una op que no cabe en el
 *   log lo dice a toda la sala; una réplica obsoleta se rechaza en vez de mezclarse.
 *
 *   TRANSPORTE Y CONVERGENCIA — lo que A sube, B lo recibe por su stream, YA SANEADO; y lo que se
 *   persiste es lo mismo que se difundió, así que un tercero que llega tarde reconstruye el mismo
 *   estado a partir de `welcome` (base + ops).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-collab-${process.pid}-${Date.now()}.db`);
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

/** POST autenticado y same-origin — como lo manda el admin del navegador. */
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
/* Cliente SSE mínimo (lo justo del protocolo: `event:` + `data:` + línea en blanco)            */
/* ------------------------------------------------------------------------------------------- */

type Stream = {
    events: { event: string; data: any }[];
    status: number;
    ended: () => boolean;
    waitFor: (event: string, timeoutMs?: number) => Promise<any>;
    close: () => void;
};

function openStream(
    login: string,
    postId: number,
    siteId: string,
    opts: { origin?: string; authorization?: string } = {},
): Promise<Stream> {
    return new Promise((resolve, reject) => {
        const req = http.get({
            host: '127.0.0.1',
            port: server.address().port,
            path: `/api/v1/collab/${postId}/stream?siteId=${encodeURIComponent(siteId)}`,
            headers: {
                Cookie: `wordjs_token=${tok(login)}`,
                Origin: opts.origin === undefined ? origin : opts.origin,
                Accept: 'text/event-stream',
                // `authenticate` IGNORA un `Bearer null`/`Bearer undefined` y cae a la cookie. Poder
                // mandarlo desde aquí es lo que permite comprobar que la RE-autorización elige la
                // misma credencial que la autenticación (ver el test del bypass más abajo).
                ...(opts.authorization ? { Authorization: opts.authorization } : {}),
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
                    if (!nameLine || !dataLine) continue; // keepalive / retry
                    const event = nameLine.slice(7);
                    let data: any = null;
                    try { data = JSON.parse(dataLine.slice(6)); } catch { /* frame partido: se ignora */ }
                    events.push({ event, data });
                    for (let i = waiters.length - 1; i >= 0; i--) {
                        if (waiters[i].event === event) waiters.splice(i, 1)[0].resolve(data);
                    }
                }
            });

            const stream: Stream = {
                events,
                status: res.statusCode,
                ended: () => closed,
                waitFor: (event, timeoutMs = 4000) => new Promise((res2, rej2) => {
                    const found = events.find((e) => e.event === event);
                    if (found) return res2(found.data);
                    const timer = setTimeout(() => rej2(new Error(`timeout esperando el evento "${event}"`)), timeoutMs);
                    waiters.push({ event, resolve: (v) => { clearTimeout(timer); res2(v); } });
                }),
                close: () => { try { req.destroy(); res.destroy(); } catch { /* ya cerrado */ } },
            };
            resolve(stream);
        });
        req.on('error', reject);
    });
}

type Session = Stream & { site: string; welcome: any };

/**
 * Abre el stream y espera el `welcome`, ADOPTANDO la identidad que asigna el servidor — que es lo
 * que hace el cliente real. Lo que se manda en la query es solo un nonce.
 */
async function openSession(login: string, postId: number, nonce: string): Promise<Session> {
    const s = await openStream(login, postId, nonce);
    const welcome = await s.waitFor('welcome');
    return Object.assign(s, { site: String(welcome.self.siteId), welcome });
}

/** Espera activa corta: la baja de una conexión viaja por el `close` del socket, que es asíncrono. */
async function settle(ms = 120) {
    await new Promise((r) => setTimeout(r, ms));
}

const NONCE_A = 's_aaaaaaaaaaaaaaaa';
const NONCE_B = 's_bbbbbbbbbbbbbbbb';
const NONCE_C = 's_cccccccccccccccc';

const hlc = (site: string, l = 100, c = 0) => ({ l, c, site });
const opPropSet = (site: string, counter: number, key: string, value: any, nodeId = 'n1') =>
    ({ k: 'propSet', id: { site, counter }, hlc: hlc(site, 100 + counter), nodeId, key, value });

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();

    await seedUser('jefa', 'administrator');
    await seedUser('colabora', 'contributor');
    await seedUser('otra', 'author');

    P.borrador = (await Post.create({ authorId: U.colabora, title: 'Borrador propio', type: 'post', status: 'draft' })).id;
    P.publicado = (await Post.create({ authorId: U.colabora, title: 'Ya publicado', type: 'post', status: 'publish' })).id;
    P.ajeno = (await Post.create({ authorId: U.otra, title: 'De otra persona', type: 'post', status: 'draft' })).id;
    P.pagina = (await Post.create({ authorId: U.jefa, title: 'Una página', type: 'page', status: 'draft' })).id;
    P.ciclo = (await Post.create({ authorId: U.colabora, title: 'Ciclo de vida', type: 'post', status: 'draft' })).id;
    P.fuga = (await Post.create({ authorId: U.colabora, title: 'Fuga de cupo', type: 'post', status: 'draft' })).id;

    await Post.updateMeta(P.borrador, '_puck_data', JSON.stringify({ root: { props: {} }, content: [] }));
    await Post.updateMeta(P.ciclo, '_puck_data', JSON.stringify({ root: { props: {} }, content: [] }));

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

describe('autorización de sala: la capacidad de editar ESE post, y nada más', () => {
    test('sin sesión no se entra', async () => {
        const r = await request(origin).get(`/api/v1/collab/${P.borrador}/stream?siteId=${NONCE_A}`);
        assert.equal(r.status, 401);
    });

    test('G-F8.3-a — un contributor NO entra en una `page` (familia de capacidades distinta)', async () => {
        const r = await request(origin).get(`/api/v1/collab/${P.pagina}/stream?siteId=${NONCE_A}`)
            .set('Cookie', `wordjs_token=${tok('colabora')}`).set('Origin', origin);
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'rest_forbidden');
    });

    test('un contributor NO entra en el post de OTRA persona (le falta edit_others_posts)', async () => {
        const r = await request(origin).get(`/api/v1/collab/${P.ajeno}/stream?siteId=${NONCE_A}`)
            .set('Cookie', `wordjs_token=${tok('colabora')}`).set('Origin', origin);
        assert.equal(r.status, 403);
    });

    test('un contributor NO entra en su propio post YA PUBLICADO (le falta edit_published_posts)', async () => {
        const r = await request(origin).get(`/api/v1/collab/${P.publicado}/stream?siteId=${NONCE_A}`)
            .set('Cookie', `wordjs_token=${tok('colabora')}`).set('Origin', origin);
        assert.equal(r.status, 403);
    });

    test('un post inexistente da 404, no 403 (no se filtra la existencia al revés)', async () => {
        const r = await request(origin).get(`/api/v1/collab/999999/stream?siteId=${NONCE_A}`)
            .set('Cookie', `wordjs_token=${tok('jefa')}`).set('Origin', origin);
        assert.equal(r.status, 404);
    });

    test('G-F8.3-b — un Origin cross-site rebota aunque la cookie sea válida', async () => {
        const r = await request(origin).get(`/api/v1/collab/${P.borrador}/stream?siteId=${NONCE_A}`)
            .set('Cookie', `wordjs_token=${tok('colabora')}`)
            .set('Origin', 'https://sitio-hostil.example');
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'rest_csrf_invalid');
    });

    test('un `siteId` con forma inválida (o un sitio SEMILLA suplantado) se rechaza', async () => {
        for (const bad of ['~s', 'pepe', 's_MAYUSCULAS', '']) {
            const r = await request(origin).get(`/api/v1/collab/${P.borrador}/stream?siteId=${encodeURIComponent(bad)}`)
                .set('Cookie', `wordjs_token=${tok('colabora')}`).set('Origin', origin);
            assert.equal(r.status, 400, `debería rechazar el siteId ${bad}`);
        }
    });

    test('la sesión viva se VUELVE A AUTORIZAR: revocar el token cierra el stream, no solo las peticiones nuevas', async () => {
        // El `gate` corre una sola vez, en el handshake, y el SSE puede vivir horas: sin re-autorizar,
        // cerrar sesión o bajar el rol no cortaban la entrega en vivo del borrador.
        const User = require('../models/User');
        const keepalive = collab.CONFIG.KEEPALIVE_MS;
        const every = collab.CONFIG.REAUTH_EVERY_TICKS;
        collab.CONFIG.KEEPALIVE_MS = 40;
        collab.CONFIG.REAUTH_EVERY_TICKS = 1;
        let a: Session | null = null;
        try {
            a = await openSession('otra', P.ajeno, NONCE_A);
            // Cambio de contraseña / cierre de sesión: estampa la época de validez de los tokens.
            await User.updateMeta(U.otra, 'token_valid_after', String(Math.floor(Date.now() / 1000) + 60));
            const err = await a.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized');
        } finally {
            a?.close();
            collab.CONFIG.KEEPALIVE_MS = keepalive;
            collab.CONFIG.REAUTH_EVERY_TICKS = every;
            await User.deleteMeta(U.otra, 'token_valid_after');
            await settle(300);
        }
    });

    test('un `Authorization: Bearer null` NO puede desactivar la re-autorización del stream', async () => {
        // BYPASS REAL (CodeQL #688, `js/user-controlled-bypass`). La re-autorización decidía QUÉ
        // credencial verificar mirando la FORMA de la cadena: `rawToken.split('.').length === 3` ⇒
        // "esto parece un JWT". Y `sessionToken()` la sacaba del header `Authorization` en cuanto
        // empezaba por `Bearer `, mientras que `authenticate` IGNORA `Bearer null` y `Bearer
        // undefined` (lo que manda un frontend que hace `localStorage.getItem('token')` sin
        // comprobar) y cae a la cookie.
        //
        // O sea: con `Authorization: Bearer null` + la cookie de sesión válida, se autenticaba por
        // cookie y aquí se recogía la cadena `"null"` — que no tiene dos puntos, así que caía en la
        // rama "no hay JWT que verificar" y el stream sobrevivía a cerrar sesión, a cambiar la
        // contraseña y a que caducara el token. Un valor que pone quien llama decidía si se
        // comprobaba la revocación, y el editor revocado seguía recibiendo cada tecla de los demás.
        const User = require('../models/User');
        const keepalive = collab.CONFIG.KEEPALIVE_MS;
        const every = collab.CONFIG.REAUTH_EVERY_TICKS;
        collab.CONFIG.KEEPALIVE_MS = 40;
        collab.CONFIG.REAUTH_EVERY_TICKS = 1;
        let a: Session | null = null;
        try {
            const s = await openStream('otra', P.ajeno, NONCE_B, { authorization: 'Bearer null' });
            const welcome = await s.waitFor('welcome');
            a = Object.assign(s, { site: String(welcome.self.siteId), welcome });

            await User.updateMeta(U.otra, 'token_valid_after', String(Math.floor(Date.now() / 1000) + 60));
            const err = await a.waitFor('error', 3000);
            assert.equal(err.code, 'unauthorized',
                'la revocación tiene que cerrar el stream aunque el cliente mande un `Bearer null`');
        } finally {
            a?.close();
            collab.CONFIG.KEEPALIVE_MS = keepalive;
            collab.CONFIG.REAUTH_EVERY_TICKS = every;
            await User.deleteMeta(U.otra, 'token_valid_after');
            await settle(300);
        }
    });

    /**
     * LAS DOS MITADES DE #688, CADA UNA CON SU ROJO.
     *
     * El test de arriba es de caja negra y prueba la CONJUNCIÓN: revocar la sesión cierra el stream.
     * Pero el bypass necesitaba las dos mitades a la vez, así que revirtiendo cualquiera de ellas por
     * separado ese test sigue VERDE — la que sobrevive cierra el agujero sola. Traducido: un refactor
     * que se lleve una sola mitad deja la suite en verde con el bypass a un commit de distancia.
     *
     * Aquí se falsea cada mitad por su CONTRATO, a través de las puertas `_sessionToken` y
     * `_makeRevalidate` (mismo motivo y mismo precedente que `_sseWrite`).
     */
    test('#688 mitad A — `sessionToken` recoge la MISMA credencial que `authenticate`, exclusiones incluidas', () => {
        const router = require('../routes/collab');
        const jwtDeLaCookie = tok('otra');
        const req = (auth: string | undefined, cookie: string | undefined) => ({
            get: (h: string) => (h === 'Authorization' ? auth : undefined),
            cookies: cookie === undefined ? {} : { wordjs_token: cookie },
        });

        // Lo que manda un frontend que hace `localStorage.getItem('token')` sin comprobar.
        // `authenticate` IGNORA estos tres y cae a la cookie; si aquí se recogiera la cadena literal,
        // la re-autorización estaría verificando una credencial que NADIE usó para autenticar.
        for (const basura of ['Bearer null', 'Bearer undefined', 'Bearer ']) {
            assert.equal(router._sessionToken(req(basura, jwtDeLaCookie)), jwtDeLaCookie,
                `con \`${basura}\` + cookie válida hay que re-verificar la COOKIE, no la cadena literal`);
        }

        // ANTI-VACUIDAD: no vale con devolver siempre la cookie. Un Bearer de verdad manda.
        assert.equal(router._sessionToken(req(`Bearer ${jwtDeLaCookie}`, 'otra-cosa')), jwtDeLaCookie,
            'un `Authorization` legítimo sigue siendo la credencial de la petición');
        assert.equal(router._sessionToken(req(undefined, jwtDeLaCookie)), jwtDeLaCookie);
    });

    test('#688 mitad B — la CLASE de credencial la fija el middleware, no la forma de la cadena', async () => {
        const router = require('../routes/collab');
        // Sesión NORMAL (sin `req.apiToken`) cuya credencial no se parece a un JWT. Antes la rama se
        // elegía contando puntos, así que esto caía en «no hay JWT que verificar» y se autorizaba
        // saltándose caducidad y `token_valid_after`. Ahora no hay otra rama a la que caer: verifica
        // o deniega.
        const sinPinta = router._makeRevalidate({
            get: () => undefined,
            cookies: { wordjs_token: 'esto-no-tiene-tres-partes' },
            user: { id: U.otra },
        }, P.ajeno);
        assert.equal(await sinPinta(), false,
            'una credencial de sesión que no verifica NO puede autorizar por no parecer un JWT');

        // Y la de dos puntos, que sí «parece» un JWT pero no lo es: mismo veredicto, otra forma.
        const conPinta = router._makeRevalidate({
            get: () => undefined,
            cookies: { wordjs_token: 'a.b.c' },
            user: { id: U.otra },
        }, P.ajeno);
        assert.equal(await conPinta(), false);

        // ANTI-VACUIDAD: si esta función denegara SIEMPRE, las dos aserciones de arriba pasarían sin
        // probar nada y además el stream se caería para todo el mundo cada cuatro ticks.
        const buena = router._makeRevalidate({
            get: () => undefined,
            cookies: { wordjs_token: tok('otra') },
            user: { id: U.otra },
        }, P.ajeno);
        assert.equal(await buena(), true,
            'una sesión legítima tiene que seguir autorizándose, o el arreglo echa a los editores buenos');
    });
});

describe('identidad de réplica: infalsificable y estable', () => {
    test('el `welcome` trae el snapshot base, el log y la identidad DERIVADA por el servidor', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);

        assert.equal(a.welcome.epoch, 1);
        assert.deepEqual(JSON.parse(a.welcome.base), { root: { props: {} }, content: [] });
        assert.deepEqual(a.welcome.ops, []);
        // El siteId NO es el que mandó el cliente: es el que deriva el servidor con su userId dentro.
        assert.notEqual(a.site, NONCE_A);
        assert.equal(a.site, collab.replicaId(U.colabora, NONCE_A));
        assert.match(a.site, /^s_[a-z2-7]{16}$/);
        assert.equal(a.welcome.self.color[0], '#');
        // Nombre público sí; correo NUNCA (la presencia la ve todo el que edita el post).
        assert.equal(a.welcome.self.name, 'Nombre de colabora');
        assert.ok(!JSON.stringify(a.welcome).includes('@example.com'));

        a.close();
        await settle();
    });

    test('el mismo nonce en usuarios distintos da identidades DISTINTAS, y es estable para el mismo usuario', () => {
        assert.notEqual(collab.replicaId(U.colabora, NONCE_A), collab.replicaId(U.jefa, NONCE_A));
        assert.equal(collab.replicaId(U.colabora, NONCE_A), collab.replicaId(U.colabora, NONCE_A));
    });

    test('sin stream abierto no se pueden empujar ops (el servidor no es un amplificador ciego)', async () => {
        const r = await post('colabora', `/collab/${P.borrador}/ops`, { siteId: collab.replicaId(U.colabora, NONCE_A), epoch: 1, ops: [] });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'collab_no_session');
    });

    test('un usuario NO puede empujar ops con el `siteId` de otro contra la conexión viva de aquel', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);

        // `jefa` es administradora (puede editar el post), pero el siteId es de `colabora`.
        const r = await post('jefa', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1, ops: [opPropSet(a.site, 1, 'color', '#123')],
        });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'collab_no_session');

        a.close();
        await settle();
    });

    test('MULTINODO — un editor autorizado NO puede emitir a nombre de la réplica de otro en un nodo que nunca vio la sala', async () => {
        // El escenario del hallazgo [1]: el candado de identidad era un Map en memoria de UN proceso,
        // así que bastaba con que el gateway enrutara al otro nodo para reclamar el siteId ajeno.
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const victima = a.site;

        // "Nodo 2": un proceso que NO tiene esa sala en memoria. Se emula vaciando el mapa local.
        collab._rooms.delete(P.borrador);

        // Bruno abre su stream presentando como nonce el siteId PÚBLICO de la víctima.
        const b = await openSession('jefa', P.borrador, victima);
        assert.notEqual(b.site, victima, 'la identidad no puede reclamarse presentándola');

        // 1. No puede hablar por la conexión de la víctima.
        const suplantando = await post('jefa', `/collab/${P.borrador}/ops`, {
            siteId: victima, epoch: 1, ops: [opPropSet(victima, 1, 'x', 1)],
        });
        assert.equal(suplantando.status, 409);
        assert.equal(suplantando.body.code, 'collab_no_session');

        // 2. Ni declarar ops de la víctima desde SU PROPIA conexión.
        const firmando = await post('jefa', `/collab/${P.borrador}/ops`, {
            siteId: b.site, epoch: 1, ops: [opPropSet(victima, 1, 'x', 1)],
        });
        assert.equal(firmando.status, 200);
        assert.equal(firmando.body.accepted, 0);
        assert.deepEqual(firmando.body.rejected, [{ index: 0, code: 'forged-site' }]);

        a.close(); b.close();
        await settle();
        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.borrador]);
    });

    test('las ops de la víctima NO se descartan en silencio tras el intento de suplantación', async () => {
        // El daño real del hallazgo [1] no era la firma: era que las ops REALES de la víctima
        // chocaban contra las falsas en el UNIQUE y se tragaban como "duplicado exacto".
        const a = await openSession('colabora', P.ciclo, NONCE_A);
        const victima = a.site;
        const b = await openSession('jefa', P.ciclo, NONCE_B);

        for (const c of [1, 2, 3]) {
            const r = await post('jefa', `/collab/${P.ciclo}/ops`, {
                siteId: b.site, epoch: a.welcome.epoch, ops: [opPropSet(victima, c, 'pisado', c)],
            });
            assert.equal(r.body.accepted, 0, 'nada emitido a nombre ajeno puede aceptarse');
        }

        const mias = await post('colabora', `/collab/${P.ciclo}/ops`, {
            siteId: victima, epoch: a.welcome.epoch,
            ops: [opPropSet(victima, 1, 'mio', 'a'), opPropSet(victima, 2, 'mio2', 'b')],
        });
        assert.equal(mias.status, 200);
        assert.equal(mias.body.accepted, 2, 'las ops legítimas de la víctima tienen que entrar');
        const filas = await dbAsync.all(
            'SELECT counter, user_id FROM collab_ops WHERE post_id = ? AND site_id = ? ORDER BY counter', [P.ciclo, victima]);
        assert.equal(filas.length, 2);
        assert.ok(filas.every((f: any) => Number(f.user_id) === U.colabora));

        a.close(); b.close();
        await settle(300);
        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.ciclo]);
    });

    test('un dot ya ocupado por OTRO usuario se rechaza tipado, no se traga como duplicado', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        // Fila plantada como si otro usuario hubiera escrito ese dot (colisión de identidad).
        await dbAsync.run(
            'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [P.borrador, a.welcome.epoch, a.site, 7, 'propSet', JSON.stringify(opPropSet(a.site, 7, 'ajeno', 1)), U.jefa]);

        const r = await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 7, 'mio', 1)],
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.accepted, 0);
        assert.deepEqual(r.body.rejected, [{ index: 0, code: 'dot-taken' }]);

        a.close();
        await settle();
        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.borrador]);
    });

    test('reconectar con el mismo nonce DESALOJA la conexión vieja en vez de rechazar la nueva', async () => {
        // Un corte que el servidor no observa (portátil suspendido, salto de wifi) dejaba el siteId
        // cautivo: el reintento chocaba con `site-taken` y el cliente se rendía sin reintentar.
        const antes = collab.stats().totalConns;
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const b = await openSession('colabora', P.borrador, NONCE_B);
        assert.equal(collab.stats().totalConns, antes + 2);

        const dup = await openSession('colabora', P.borrador, NONCE_A);
        assert.equal(dup.site, a.site, 'la identidad es estable entre reconexiones');
        await settle(200);
        assert.equal(a.ended(), true, 'la conexión vieja de esa réplica se desaloja');
        assert.equal(collab.stats().totalConns, antes + 2, 'y no se acumulan cupos');

        b.close(); dup.close();
        await settle(300);
    });
});

describe('sesión, presencia y relevo de operaciones', () => {
    test('lo que A sube le llega a B por su stream, SANEADO, y sin volver al emisor', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const b = await openSession('jefa', P.borrador, NONCE_B);

        const hostil = '<img src=x onerror=alert(1)>hola';
        const r = await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1, txId: 't1',
            ops: [opPropSet(a.site, 1, 'text', hostil)],
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.accepted, 1);
        assert.deepEqual(r.body.rejected, []);

        const got = await b.waitFor('ops');
        assert.equal(got.from, a.site);
        assert.equal(got.ops.length, 1);
        assert.ok(!/onerror/i.test(got.ops[0].value), `llegó sin sanear: ${got.ops[0].value}`);
        assert.match(got.ops[0].value, /hola/);

        // El emisor NO recibe su propio eco: ya aplicó la op localmente...
        assert.equal(a.events.some((e) => e.event === 'ops'), false);
        // ...pero el valor SANEADO vuelve en la respuesta, o su réplica se quedaría con el crudo
        // para siempre (la difusión lo excluye y el `resync` no se lo devolvería).
        assert.equal(r.body.normalized.length, 1);
        assert.deepEqual(r.body.normalized[0].value, got.ops[0].value);

        // Y lo PERSISTIDO es exactamente lo DIFUNDIDO (si no, un `resync` daría otro documento).
        const row = await dbAsync.get('SELECT payload FROM collab_ops WHERE post_id = ? AND site_id = ? AND counter = 1', [P.borrador, a.site]);
        assert.deepEqual(JSON.parse(row.payload), got.ops[0]);

        a.close(); b.close();
        await settle();
    });

    test('un valor que el saneador NO toca no genera corrección para el emisor', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const r = await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1, ops: [opPropSet(a.site, 2, 'padding', 8)],
        });
        assert.equal(r.body.accepted, 1);
        assert.deepEqual(r.body.normalized, []);
        a.close();
        await settle();
    });

    test('una op inválida vuelve identificada sin tumbar las buenas del mismo frame', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);

        const r = await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1,
            ops: [
                opPropSet(a.site, 10, 'padding', 8),
                { k: 'propSet', id: { site: NONCE_B, counter: 11 }, hlc: hlc(NONCE_B), nodeId: 'n1', key: 'x', value: 1 },
                opPropSet(a.site, 12, 'margin', 4),
            ],
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.accepted, 2);
        assert.deepEqual(r.body.rejected, [{ index: 1, code: 'forged-site' }]);

        a.close();
        await settle();
    });

    test('un `listInsert` (que por catálogo NO lleva reloj) se acepta y se difunde', async () => {
        // Exigirle `hlc` rechazaba con `bad-hlc` TODA inserción y duplicación de bloque: aparecía en
        // el editor que la hizo y no llegaba a nadie más.
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const b = await openSession('jefa', P.borrador, NONCE_B);
        const r = await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1,
            ops: [{ k: 'listInsert', id: { site: a.site, counter: 13 }, parentId: 'root', slotKey: 'content', left: null, right: null, nodeId: 'n9' }],
        });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.rejected, []);
        assert.equal(r.body.accepted, 1);
        const got = await b.waitFor('ops');
        assert.equal(got.ops[0].k, 'listInsert');
        a.close(); b.close();
        await settle();
    });

    test('la presencia se difunde con nombre y color, y jamás el correo', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const b = await openSession('jefa', P.borrador, NONCE_B);

        // El alta de B ya le llega a A como `members`.
        const joined = await a.waitFor('members');
        assert.equal(joined.joined.siteId, b.site);
        assert.equal(joined.joined.name, 'Nombre de jefa');

        const r = await post('jefa', `/collab/${P.borrador}/presence`, {
            siteId: b.site, sel: { nodeId: 'n1', field: 'text', anchor: `${b.site}@3`, focus: `${b.site}@7` },
        });
        assert.equal(r.status, 200);

        const pres = await a.waitFor('presence');
        assert.equal(pres.entries[0].siteId, b.site);
        assert.equal(pres.entries[0].sel.nodeId, 'n1');
        assert.equal(pres.entries[0].sel.field, 'text');
        assert.ok(!JSON.stringify(pres).includes('@example.com'));

        // La presencia es awareness, NO documento: no puede acabar en el log de ops.
        const n = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE kind = ?', ['presence']);
        assert.equal(Number(n.c), 0);

        a.close(); b.close();
        await settle();
    });

    test('el que llega tarde recibe en el `welcome` las ops ya emitidas (reanudación)', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1, ops: [opPropSet(a.site, 20, 'color', '#abc')],
        });

        const c = await openSession('jefa', P.borrador, NONCE_C);
        assert.ok(c.welcome.ops.some((o: any) => o.id.site === a.site && o.id.counter === 20));
        assert.equal(c.welcome.members.length >= 1, true);

        a.close(); c.close();
        await settle();
    });

    test('`resync` devuelve SOLO lo que le falta al cliente según su version vector', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1, ops: [opPropSet(a.site, 30, 'a', 1), opPropSet(a.site, 31, 'b', 2)],
        });

        const b = await openSession('jefa', P.borrador, NONCE_B);

        const todo = await post('jefa', `/collab/${P.borrador}/resync`, { siteId: b.site, epoch: 1, vv: {} });
        const parcial = await post('jefa', `/collab/${P.borrador}/resync`, { siteId: b.site, epoch: 1, vv: { [a.site]: 30 } });

        assert.equal(todo.body.complete, true);
        assert.ok(todo.body.ops.length > parcial.body.ops.length);
        assert.equal(parcial.body.ops.some((o: any) => o.id.counter === 30), false);
        assert.equal(parcial.body.ops.some((o: any) => o.id.counter === 31), true);

        // Un epoch distinto obliga a re-sembrar: la respuesta trae el snapshot base.
        const viejo = await post('jefa', `/collab/${P.borrador}/resync`, { siteId: b.site, epoch: 0, vv: {} });
        assert.equal(typeof viejo.body.base, 'string');

        a.close(); b.close();
        await settle();
    });

    test('G-F8.3-g — `resync` NO se puede usar como amplificador: pasa por el límite de ritmo', async () => {
        // ~60 bytes de petición contra la lectura y serialización de la sala ENTERA. Sin cobrarlo,
        // el único freno era el limitador global de la API (1000 peticiones por IP cada 15 min).
        const a = await openSession('colabora', P.borrador, NONCE_A);
        let limited = 0;
        for (let i = 0; i < 80 && !limited; i++) {
            const r = await post('colabora', `/collab/${P.borrador}/resync`, { siteId: a.site, epoch: 1, vv: {} });
            if (r.status === 429) limited++;
        }
        assert.ok(limited > 0, 'el resync repetido tiene que acabar topando');
        a.close();
        await settle(300);
    });

    test('reenviar una op ya conocida es un no-op exacto (idempotencia por la BD)', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const op = opPropSet(a.site, 40, 'reintento', 'v1');

        const first = await post('colabora', `/collab/${P.borrador}/ops`, { siteId: a.site, epoch: 1, ops: [op] });
        const again = await post('colabora', `/collab/${P.borrador}/ops`, { siteId: a.site, epoch: 1, ops: [op] });
        assert.equal(first.body.accepted, 1);
        assert.equal(again.body.accepted, 0);
        // Pero SÍ se contabiliza como conocida: el cliente tiene que poder cuadrar el lote entero, o
        // no sabría distinguir "ya la tenías" de "se perdió".
        assert.equal(again.body.known, 1);

        const n = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ? AND site_id = ? AND counter = 40', [P.borrador, a.site]);
        assert.equal(Number(n.c), 1);

        a.close();
        await settle();
    });

    test('un epoch caducado se rechaza con 409 en vez de mezclarse en silencio', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const r = await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 99, ops: [opPropSet(a.site, 50, 'x', 1)],
        });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'collab_epoch');
        a.close();
        await settle();
    });

    test('G-F8.3-f — una avalancha de ops acaba en 429 y cierre, sin tumbar la sala', async () => {
        const a = await openSession('colabora', P.borrador, NONCE_A);
        const b = await openSession('jefa', P.borrador, NONCE_B);

        let limited = 0;
        let counter = 1000;
        for (let i = 0; i < 60 && limited < 3; i++) {
            const ops = Array.from({ length: 60 }, () => opPropSet(a.site, counter++, `k${counter}`, 1));
            const r = await post('colabora', `/collab/${P.borrador}/ops`, { siteId: a.site, epoch: 1, ops });
            if (r.status === 429) limited++;
        }
        assert.ok(limited > 0, 'el límite de ritmo no llegó a dispararse');

        // El resto de la sala sigue viva: B puede seguir trabajando.
        const ok = await post('jefa', `/collab/${P.borrador}/presence`, { siteId: b.site, sel: null });
        assert.equal(ok.status, 200);

        a.close(); b.close();
        await settle(300);
        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.borrador]);
    });

    test('un frame grande pero legítimo SE ACEPTA: no hay banda muerta entre el validador y el ritmo', async () => {
        // Reescribir un titular emite un borrado y una inserción POR CARÁCTER: >50 ops en UN comando.
        // Con una ventana de un segundo eso era imposible de aceptar por muy despacio que se fuera, y
        // el cliente moría a los tres reintentos.
        const a = await openSession('colabora', P.ciclo, NONCE_C);
        let counter = 500;
        const ops = Array.from({ length: 120 }, () => opPropSet(a.site, counter++, `k${counter}`, 1));
        const r = await post('colabora', `/collab/${P.ciclo}/ops`, { siteId: a.site, epoch: a.welcome.epoch, ops });
        assert.equal(r.status, 200);
        assert.equal(r.body.accepted, 120);
        a.close();
        await settle(300);
        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.ciclo]);
    });
});

describe('no perder nada en silencio', () => {
    test('un fallo de BD que NO es duplicado se reporta como fallo, no como éxito', async () => {
        // El `catch {}` pelado del INSERT trataba cualquier fallo operativo como "op ya conocida":
        // 200 OK, la op ni persistida ni difundida, y el cliente borrándola de su outbox.
        const a = await openSession('colabora', P.borrador, NONCE_A);
        await dbAsync.exec(
            "CREATE TRIGGER collab_ops_boom BEFORE INSERT ON collab_ops BEGIN SELECT RAISE(ABORT, 'disco lleno'); END");
        try {
            const r = await post('colabora', `/collab/${P.borrador}/ops`, {
                siteId: a.site, epoch: 1, ops: [opPropSet(a.site, 80, 'perdida', 'no')],
            });
            assert.equal(r.status, 503);
            assert.equal(r.body.code, 'collab_store_failed');
        } finally {
            await dbAsync.exec('DROP TRIGGER collab_ops_boom');
        }
        const n = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ? AND counter = 80', [P.borrador]);
        assert.equal(Number(n.c), 0);

        // Y el reintento (que es lo que hace el cliente con un 5xx) sí entra.
        const retry = await post('colabora', `/collab/${P.borrador}/ops`, {
            siteId: a.site, epoch: 1, ops: [opPropSet(a.site, 80, 'perdida', 'no')],
        });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.accepted, 1);

        a.close();
        await settle();
        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.borrador]);
    });

    test('el log lleno se denuncia a TODA la sala y queda marcado para el que entre después', async () => {
        // La señal se derivaba de `COUNT(*)`, que se queda POR DEBAJO del tope en cuanto un frame no
        // cabe: a todo el que entraba se le decía "log completo" mientras faltaban las ediciones.
        const tope = collab.CONFIG.MAX_OPS_PER_EPOCH;
        collab.CONFIG.MAX_OPS_PER_EPOCH = 2;
        try {
            const a = await openSession('colabora', P.ciclo, NONCE_A);
            const b = await openSession('jefa', P.ciclo, NONCE_B);
            const r = await post('colabora', `/collab/${P.ciclo}/ops`, {
                siteId: a.site, epoch: a.welcome.epoch,
                ops: [opPropSet(a.site, 1, 'a', 1), opPropSet(a.site, 2, 'b', 2), opPropSet(a.site, 3, 'c', 3)],
            });
            assert.equal(r.status, 200);
            assert.equal(r.body.persisted, false, 'no cabía: hay que decirlo en la respuesta');

            // El aviso llega también a QUIEN NO EMITIÓ: su sesión tampoco es ya reanudable.
            const avisoB = await b.waitFor('warning');
            assert.equal(avisoB.code, 'log_full');
            // Y el que entra después no puede recibir un "está todo completo".
            const c = await openSession('jefa', P.ciclo, NONCE_C);
            assert.equal(c.welcome.truncated, true);
            const rs = await post('jefa', `/collab/${P.ciclo}/resync`, { siteId: c.site, epoch: c.welcome.epoch, vv: {} });
            assert.equal(rs.body.complete, false);

            a.close(); b.close(); c.close();
            await settle(300);
        } finally {
            collab.CONFIG.MAX_OPS_PER_EPOCH = tope;
            await dbAsync.run('UPDATE collab_docs SET truncated = 0 WHERE post_id = ?', [P.ciclo]);
        }
    });
});

describe('ciclo de vida de la sala: el epoch sube de verdad', () => {
    test('vaciar la sala NO purga: la sesión sigue siendo reanudable dentro de la ventana', async () => {
        // Purgar al cerrar la última pestaña tira las ediciones que aún no se han guardado: viven
        // SOLO en el log. La purga la decide el barrido, cuando ya nadie ha vuelto.
        const a = await openSession('colabora', P.ciclo, NONCE_A);
        await post('colabora', `/collab/${P.ciclo}/ops`, {
            siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 60, 'z', 1)],
        });
        a.close();
        await settle(400);

        const quedan = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.ciclo]);
        assert.ok(Number(quedan.c) > 0, 'las ops sin guardar no se tiran al cerrar la pestaña');

        const vuelve = await openSession('colabora', P.ciclo, NONCE_A);
        assert.equal(vuelve.welcome.epoch, a.welcome.epoch, 'misma generación: se reanuda');
        assert.ok(vuelve.welcome.ops.some((o: any) => o.id.counter === 60));
        vuelve.close();
        await settle(300);
    });

    test('retirar y reabrir SUBE el epoch, y una réplica obsoleta es RECHAZADA', async () => {
        // `retireRoom` leía el epoch y no lo usaba: borraba la fila, así que al reabrir renacía en 1
        // y el cliente creía estar en la misma generación. Toda la detección de reinicio era código
        // muerto y la réplica vieja pisaba el contenido guardado.
        const a = await openSession('colabora', P.ciclo, NONCE_A);
        const epochAntes = a.welcome.epoch;
        await post('colabora', `/collab/${P.ciclo}/ops`, {
            siteId: a.site, epoch: epochAntes, ops: [opPropSet(a.site, 70, 'q', 1)],
        });
        a.close();
        await settle(300);

        // El barrido con ventana 0: nadie dentro, la sala se retira.
        const retiradas = await collab.sweepIdleRooms(0);
        assert.ok(retiradas >= 1);

        const fila = await dbAsync.get('SELECT epoch, base_doc FROM collab_docs WHERE post_id = ?', [P.ciclo]);
        assert.equal(Number(fila.epoch), epochAntes + 1, 'el epoch tiene que ser MONÓTONO, no renacer en 1');
        const ops = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.ciclo]);
        assert.equal(Number(ops.c), 0);

        // Reabrir re-siembra del `_puck_data` canónico y anuncia la generación nueva.
        const b = await openSession('colabora', P.ciclo, NONCE_A);
        assert.equal(b.welcome.epoch, epochAntes + 1);
        assert.deepEqual(JSON.parse(b.welcome.base), { root: { props: {} }, content: [] });

        // Una réplica que sobrevivió a la purga (sigue hablando del epoch viejo) se rechaza.
        const obsoleta = await post('colabora', `/collab/${P.ciclo}/ops`, {
            siteId: b.site, epoch: epochAntes, ops: [opPropSet(b.site, 71, 'vieja', 1)],
        });
        assert.equal(obsoleta.status, 409);
        assert.equal(obsoleta.body.code, 'collab_epoch');

        b.close();
        await settle(300);
    });

    test('el barrido NO retira una sala con miembros vivos en OTRO nodo', async () => {
        // La única prueba de liveness era el mapa en memoria de ESTE proceso: el nodo que barría
        // borraba el estado de salas que otro nodo estaba sirviendo en vivo.
        //
        // El nombre decía «(falla cerrado)» y solo ejercitaba `live > 0`, que es el caso en que la
        // consulta SÍ contesta: prometía una cobertura que no tenía. El fallo cerrado de verdad —
        // `live === null`, la consulta que no se puede hacer, y el driver que no lanza— vive en
        // `collab-failure-paths.test.ts` con dos tests propios.
        const a = await openSession('colabora', P.ciclo, NONCE_A);
        await post('colabora', `/collab/${P.ciclo}/ops`, {
            siteId: a.site, epoch: a.welcome.epoch, ops: [opPropSet(a.site, 90, 'viva', 1)],
        });
        const epochAntes = a.welcome.epoch;
        a.close();
        await settle(300);

        // Miembro de OTRO nodo, con latido reciente y sin rastro en el mapa local.
        await dbAsync.run(
            'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
            ['c_otro_nodo', P.ciclo, 's_zzzzzzzzzzzzzzzz', U.jefa, 'nodo-2', Date.now()]);
        try {
            await collab.sweepIdleRooms(0);
            const fila = await dbAsync.get('SELECT epoch FROM collab_docs WHERE post_id = ?', [P.ciclo]);
            assert.equal(Number(fila.epoch), epochAntes, 'no se puede purgar una sala que otro nodo sirve');
            const ops = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P.ciclo]);
            assert.ok(Number(ops.c) > 0);
        } finally {
            await dbAsync.run('DELETE FROM collab_members WHERE conn_id = ?', ['c_otro_nodo']);
        }
        await collab.sweepIdleRooms(0);
    });

    test('reabrir con el `_puck_data` cambiado por fuera re-siembra con epoch nuevo, no sirve el snapshot rancio', async () => {
        // `ensureDoc` devolvía el `base_doc` de la fila sin compararlo nunca con el contenido
        // canónico: restaurar una revisión y reabrir el editor enseñaba el borrador viejo, y al
        // guardar pisaba la revisión restaurada.
        const a = await openSession('colabora', P.ciclo, NONCE_A);
        const epochAntes = a.welcome.epoch;
        a.close();
        await settle(300);

        const nuevo = { root: { props: { title: 'restaurado' } }, content: [] };
        await Post.updateMeta(P.ciclo, '_puck_data', JSON.stringify(nuevo));

        const b = await openSession('colabora', P.ciclo, NONCE_A);
        assert.equal(b.welcome.epoch, epochAntes + 1, 'contenido nuevo ⇒ generación nueva');
        assert.deepEqual(JSON.parse(b.welcome.base), nuevo);
        b.close();
        await settle(300);
    });
});

describe('recursos: ni cupos fugados ni contabilidad doble', () => {
    test('abortar el GET del stream durante el `join` no fuga cupo', async () => {
        // El listener de cierre se registraba DESPUÉS del `await join()`: si el cliente se iba dentro
        // de esa ventana, el evento `close` ya se había emitido y el listener no corría nunca. La
        // conexión quedaba contada para siempre (y escribir en un socket muerto no lanza).
        const antes = collab.stats().totalConns;
        const realGetMeta = Post.getMeta;
        Post.getMeta = async (...args: any[]) => {
            await new Promise((r) => setTimeout(r, 250));
            return realGetMeta.apply(Post, args);
        };
        try {
            for (let i = 0; i < 3; i++) {
                await new Promise<void>((resolve) => {
                    const req = http.get({
                        host: '127.0.0.1',
                        port: server.address().port,
                        path: `/api/v1/collab/${P.fuga}/stream?siteId=s_dddddddddddddd${i}a`,
                        headers: { Cookie: `wordjs_token=${tok('colabora')}`, Origin: origin, Accept: 'text/event-stream' },
                    }, (res: any) => {
                        res.destroy();
                        req.destroy();
                        resolve();
                    });
                    req.on('error', () => resolve());
                });
            }
            await settle(800);
        } finally {
            Post.getMeta = realGetMeta;
        }
        assert.equal(collab.stats().totalConns, antes, 'el contador tiene que volver a su sitio');
        const filas = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_members WHERE post_id = ?', [P.fuga]);
        assert.equal(Number(filas.c), 0, 'y la presencia de clúster tampoco puede quedar colgada');
    });

    test('`leave` es idempotente: el doble descuento no puede anular los topes de admisión', async () => {
        // El `POST /leave` cierra la respuesta, lo que dispara el `close` del stream, que llama a
        // `leave` OTRA VEZ sobre el mismo objeto: la segunda pasada descontaba de nuevo y los topes
        // acababan leyendo ceros con conexiones vivas dentro.
        const antes = collab.stats().totalConns;
        const a = await openSession('colabora', P.fuga, NONCE_A);
        const b = await openSession('colabora', P.fuga, NONCE_B);
        assert.equal(collab.stats().totalConns, antes + 2);

        const r = await post('colabora', `/collab/${P.fuga}/leave`, { siteId: a.site });
        assert.equal(r.status, 200);
        await settle(300);

        assert.equal(collab.stats().totalConns, antes + 1, 'solo puede descontarse UNA vez');
        b.close();
        await settle(300);
        assert.equal(collab.stats().totalConns, antes);
    });
});
