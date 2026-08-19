/**
 * Auditoría 2026-08, ola 4 — grupo X5 (colaboración y lock distribuido).
 *
 * Cada bloque de aquí fija una CLASE de defecto, no el ejemplo con el que se descubrió. Las tres
 * rondas anteriores se perdieron por lo contrario: se arreglaba el campo del informe y el hermano de
 * al lado seguía abierto. Así que todos los tests de este fichero RECORREN los miembros de su clase,
 * y varios de ellos leen el CÓDIGO FUENTE para que un miembro NUEVO —el que todavía no existe— tenga
 * que pasar por el mismo sitio o ponga esto en rojo.
 *
 *   CLASE A — todo lo que MATERIALIZA el estado de una sala para un cliente tiene que pagar por lo que
 *             trae al heap, y pagarlo en UN SOLO sitio. El presupuesto contaba el LOG y no el
 *             SNAPSHOT: con el log vacío, entrar y reanudar volvían a ser gratis.
 *   CLASE B — un presupuesto que se MIRA y se COBRA con `await` en medio no acota nada: N lecturas
 *             simultáneas del mismo usuario ven el mismo saldo y pasan todas.
 *   CLASE C — un código que acuña el servidor y clasifica el cliente con una lista escrita a mano es
 *             un contrato con dos copias; la variante nueva cae en la rama terminal.
 *   CLASE D — un rechazo tiene que anunciar la espera DEL RECURSO AGOTADO, no la de otro cubo.
 *   CLASE E — un `MAX_` que no desaloja nada no es un máximo.
 *   CLASE F — SQL por DIALECTO que ninguna suite ejercita se va a producción sin mirar.
 *   CLASE G — «no me lo han concedido» y «este motor nunca me lo va a conceder» no pueden ser el
 *             mismo valor: el que espera se queda esperando los cinco minutos enteros.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-x5-${process.pid}-${Date.now()}.db`);
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
app.use(express.json({ limit: '10mb' }));
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

/* --- cliente SSE mínimo (event: + data: + línea en blanco), igual que en audit-collab-g1 --------- */

type Stream = {
    events: { event: string; data: any }[];
    waitAny: (nombres: string[], timeoutMs?: number) => Promise<{ event: string; data: any }>;
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
            const waiters: { nombres: string[]; resolve: (v: any) => void }[] = [];
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
                        if (waiters[i].nombres.includes(event)) waiters.splice(i, 1)[0].resolve({ event, data });
                    }
                }
            });
            resolve({
                events,
                waitAny: (nombres, timeoutMs = 5000) => new Promise((res2, rej2) => {
                    const found = events.find((e) => nombres.includes(e.event));
                    if (found) return res2(found);
                    const timer = setTimeout(() => rej2(new Error(`timeout esperando ${nombres.join('|')}`)), timeoutMs);
                    waiters.push({ nombres, resolve: (v) => { clearTimeout(timer); res2(v); } });
                }),
                close: () => { try { req.destroy(); res.destroy(); } catch { /* ya cerrado */ } },
            });
        });
        req.on('error', reject);
    });
}

/** Abre y devuelve el DESENLACE: `welcome` (entró) o `error` (rechazo, con su motivo y su plazo). */
async function abre(login: string, postId: number, nonce: string) {
    const s = await openStream(login, postId, nonce);
    const r = await s.waitAny(['welcome', 'error']);
    return { ...r, close: s.close };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const NONCE_A = 's_aaaaaaaaaaaaaaaa';
const NONCE_B = 's_bbbbbbbbbbbbbbbb';
const NONCE_C = 's_cccccccccccccccc';

/** Snapshot GRANDE con el log VACÍO: exactamente el estado en el que el cobro anterior no veía nada. */
const GORDO = 200_000;
const baseGorda = (n = GORDO) => JSON.stringify({
    root: { props: { title: 'T' } },
    content: [{ type: 'Text', props: { id: 't1', text: 'x'.repeat(n) } }],
});

const FUENTE_SALAS = path.join(__dirname, '..', 'core', 'collab-rooms.ts');

/**
 * El fuente del módulo, CON LOS FINALES DE LÍNEA NORMALIZADOS.
 *
 * Los gates que derivan su población del código tienen que leer el MISMO fichero en cualquier copia de
 * trabajo, y no lo hacían: `core.autocrlf` viene activado en Git para Windows y ningún atributo `eol`
 * fija los `*.ts`, así que un mismo commit se materializa con LF en Linux y con CRLF en un checkout de
 * Windows. Los delimitadores de abajo buscan un `}` en la columna 0 precedido de salto de línea: con
 * CRLF `\n}` no casa NUNCA y el cuerpo no se podía acotar. Eso es estado que git deliberadamente no
 * transporta, así que no puede decidir lo que este gate mide — se normaliza una vez, aquí.
 */
function leeFuente(p: string): string {
    return fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
}

/** El `}` en la columna 0 que cierra una declaración de primer nivel, o -1 si no lo hay. */
function finDeCuerpo(fuente: string, desde: number): number {
    const cierre = /\n\}(?=\n|$)/g;
    cierre.lastIndex = desde;
    const m = cierre.exec(fuente);
    return m ? m.index : -1;
}

/** Doce cuentas distintas para la CLASE E: el cubo cuelga del usuario, así que hacen falta usuarios. */
const MUCHOS = Array.from({ length: 12 }, (_, i) => `cubo${i}`);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();

    // Un usuario POR CASO: el presupuesto cuelga del USUARIO, así que compartirlo haría que un test
    // gastara el saldo del siguiente y los veredictos dependieran del orden.
    for (const login of ['entra', 'reanuda', 'concurre', 'plazo', 'controla', ...MUCHOS]) {
        await seedUser(login, 'administrator');
    }

    for (const k of ['entra', 'reanuda', 'plazo', 'control']) {
        P[k] = (await Post.create({ authorId: U.entra, title: `Sala ${k}`, type: 'post', status: 'draft' })).id;
        await Post.updateMeta(P[k], '_puck_data', baseGorda());
    }
    for (let i = 0; i < 5; i++) {
        const id = (await Post.create({ authorId: U.entra, title: `Concurrente ${i}`, type: 'post', status: 'draft' })).id;
        P[`conc${i}`] = id;
        await Post.updateMeta(id, '_puck_data', baseGorda());
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

/** Ejecuta con el presupuesto de lectura puesto a medida, y lo restaura pase lo que pase. */
async function conPresupuesto(burst: number, rate: number, fn: () => Promise<void>) {
    const b = collab.CONFIG.USER_READ_BURST;
    const r = collab.CONFIG.USER_READ_BYTES_PER_SEC;
    collab.CONFIG.USER_READ_BURST = burst;
    collab.CONFIG.USER_READ_BYTES_PER_SEC = rate;
    try { await fn(); } finally {
        collab.CONFIG.USER_READ_BURST = b;
        collab.CONFIG.USER_READ_BYTES_PER_SEC = r;
        await settle(200);
    }
}

/* ============================================================================================= */
/* CLASE A — lo que se materializa se cobra, y se cobra en UN solo sitio                          */
/* ============================================================================================= */

describe('CLASE A: el presupuesto cobra TODO lo que una entrada trae al heap, no solo el log', () => {
    // LOS MIEMBROS DE LA CLASE son las dos puertas que materializan el estado de una sala. Las dos se
    // recorren con el MISMO fixture —snapshot grande, log VACÍO— porque es ahí donde el cobro
    // anterior (`log.bytes`) valía exactamente 0 y las dos puertas volvían a ser gratis.
    const MATERIALIZADORES: { nombre: string; postKey: string; user: string; segunda: (u: string, p: number) => Promise<{ ok: boolean; motivo: string; espera: number }> }[] = [
        {
            nombre: 'join (abrir el stream)',
            postKey: 'entra',
            user: 'entra',
            segunda: async (user, postId) => {
                const r = await abre(user, postId, NONCE_B);
                r.close();
                return {
                    ok: r.event === 'welcome',
                    motivo: String(r.data?.code || ''),
                    espera: Number(r.data?.retryAfterMs || 0),
                };
            },
        },
        {
            nombre: 'resync (reanudar)',
            postKey: 'reanuda',
            user: 'reanuda',
            segunda: async (user, postId) => {
                const room = collab._rooms.get(postId);
                const conn = room ? [...room.conns.values()][0] : null;
                const r = await post(user, `/collab/${postId}/resync`, { siteId: conn?.siteId, epoch: 1, vv: {} });
                return { ok: r.status === 200, motivo: String(r.body?.code || ''), espera: Number(r.body?.retryAfterMs || 0) };
            },
        },
    ];

    for (const m of MATERIALIZADORES) {
        test(`${m.nombre}: con el LOG VACÍO el snapshot ya agota el presupuesto`, async () => {
            // Ráfaga por DEBAJO del snapshot: la primera lectura pasa (queda saldo) y deja el cubo en
            // descubierto; la segunda tiene que rebotar. Cobrando solo el log —que aquí pesa 0— el
            // cubo no bajaba NUNCA y las dos puertas se podían repetir sin fin con un objeto más
            // grande que el propio log (el tope del log son 4 MB; `_puck_data` no tiene tope propio).
            await conPresupuesto(Math.floor(GORDO / 2), 1, async () => {
                const primera = await abre(m.user, P[m.postKey], NONCE_A);
                try {
                    assert.equal(primera.event, 'welcome', 'la PRIMERA lectura sí se sirve: el saldo estaba entero');
                    const filas = await dbAsync.get(
                        'SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ?', [P[m.postKey]]);
                    assert.equal(Number(filas.c), 0, 'el fixture exige el log VACÍO: es donde el cobro viejo valía 0');

                    const segunda = await m.segunda(m.user, P[m.postKey]);
                    assert.equal(segunda.ok, false,
                        `${m.nombre}: el snapshot ya se cobró una vez; repetirlo no puede ser gratis`);
                    assert.ok(/read-budget|collab_read_budget/.test(segunda.motivo),
                        `y el motivo tiene que ser el presupuesto de lectura, no otro: ${segunda.motivo}`);
                } finally { primera.close(); }
            });
        });
    }

    test('UN SOLO CAMINO: nadie materializa una sala sin pasar por la función que cobra', () => {
        // Esta es la parte que hace que la clase quede CERRADA y no solo sus dos miembros de hoy. Un
        // materializador NUEVO (una vista previa, un export, un modo lector) que llame a `ensureDoc` o
        // a `loadOps` por su cuenta es este mismo defecto otra vez, y aquí se entera antes de existir.
        const fuente = leeFuente(FUENTE_SALAS);
        const inicio = fuente.indexOf('async function materializeRoom(');
        assert.ok(inicio > 0, 'la función que cobra tiene que seguir existiendo con ese nombre');
        const fin = finDeCuerpo(fuente, inicio);
        assert.ok(fin > inicio,
            'no se pudo delimitar el cuerpo del cobro: sin `}` en la columna 0 tras su cabecera. Este gate ' +
            'saca su población del texto del fuente, así que ha dejado de medir nada — se arregla el lector, ' +
            'NO se ablanda el aserto.');

        const intrusos: string[] = [];
        const re = /\b(ensureDoc|loadOps)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(fuente)) !== null) {
            const antes = fuente.slice(Math.max(0, m.index - 20), m.index);
            if (/function\s+$/.test(antes)) continue;          // su propia declaración
            if (m.index >= inicio && m.index <= fin) continue;  // el chokepoint
            const linea = fuente.slice(0, m.index).split('\n').length;
            intrusos.push(`${m[1]} en la línea ${linea}`);
        }
        assert.deepEqual(intrusos, [],
            'materializar la sala fuera de `materializeRoom` es saltarse el presupuesto: ' + intrusos.join(', '));
    });
});

/* ============================================================================================= */
/* CLASE B — mirar y cobrar con `await` en medio no acota nada                                    */
/* ============================================================================================= */

describe('CLASE B: N lecturas simultáneas del mismo usuario no pueden ver todas el mismo saldo', () => {
    test('cinco entradas a la vez con presupuesto para tres: pasan tres', async () => {
        // `canReadLog` consultaba el cubo y el descuento ocurría 70 líneas más abajo, con
        // `claimMember`, `ensureDoc` y `loadOps` en medio. Cinco `join` simultáneos del MISMO usuario
        // veían todos el saldo entero y pasaban todos: el pico real era `MAX_CONNS_PER_USER` lecturas
        // completas vivas en el heap a la vez, no una, que es lo que el comentario de CONFIG afirma.
        //
        // EL DRIVER TIENE QUE CEDER EL CONTROL, o el test no prueba nada. La suite corre sobre
        // better-sqlite3, que es SÍNCRONO: sus `await` se resuelven en el mismo turno y las cinco
        // peticiones acaban atendiéndose una detrás de otra por casualidad del event loop, así que la
        // ventana de check-then-act no llega a abrirse. En producción el motor de un despliegue
        // multinodo es de red (Postgres/MySQL) y CADA consulta cede. Se reproduce esa condición
        // metiendo una espera real en el driver — el código bajo prueba es el de producción, lo que
        // cambia es el motor, que es exactamente la diferencia que este defecto necesita para verse.
        const S = GORDO;
        const real = { get: dbAsync.get, all: dbAsync.all, run: dbAsync.run };
        const cede = (fn: any) => async (...args: any[]) => {
            await new Promise((r) => setTimeout(r, 12));
            return fn.apply(dbAsync, args);
        };
        dbAsync.get = cede(real.get);
        dbAsync.all = cede(real.all);
        dbAsync.run = cede(real.run);
        try {
            await conPresupuesto(Math.floor(S * 2.2), 1, async () => {
                const ids = [0, 1, 2, 3, 4].map((i) => P[`conc${i}`]);
                const resultados = await Promise.all(ids.map((id) => abre('concurre', id, NONCE_A)));
                try {
                    const exitos = resultados.filter((r) => r.event === 'welcome').length;
                    assert.ok(exitos >= 1, 'algo tenía que entrar: el saldo estaba entero al empezar');
                    assert.ok(exitos <= 3,
                        `con saldo para 2,2 lecturas se sirvieron ${exitos}: el saldo se mira y se cobra sin reservar nada`);
                    for (const r of resultados) {
                        if (r.event === 'error') assert.equal(r.data?.code, 'read-budget');
                    }
                } finally { for (const r of resultados) r.close(); }
            });
        } finally {
            dbAsync.get = real.get;
            dbAsync.all = real.all;
            dbAsync.run = real.run;
            await settle(300);
        }
    });
});

/* ============================================================================================= */
/* CLASE C + D — el rechazo dice si se reintenta y CUÁNTO, y no cobra del cubo equivocado          */
/* ============================================================================================= */

describe('CLASE C: la retryabilidad la publica quien acuña los códigos', () => {
    test('TODA variante de `JoinRefusal` está clasificada — el compilador no es el único gate', () => {
        const fuente = leeFuente(FUENTE_SALAS);
        const union = fuente.slice(fuente.indexOf('export type JoinRefusal ='));
        const cuerpo = union.slice(0, union.indexOf(';'));
        const variantes = [...cuerpo.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
        assert.ok(variantes.length >= 5, `la unión tiene que leerse entera: ${variantes.join(',')}`);

        const tabla = fuente.slice(fuente.indexOf('const REFUSAL_RETRYABLE'));
        const clasificados = tabla.slice(0, tabla.indexOf('};'));
        for (const v of variantes) {
            assert.ok(clasificados.includes(`'${v}'`),
                `'${v}' no está clasificado: una variante sin entrada acaba en la rama terminal del cliente`);
            assert.equal(typeof collab.refusalIsRetryable(v), 'boolean');
        }
        assert.equal(collab.refusalIsRetryable('read-budget'), true,
            'el ÚNICO rechazo que se cura solo con el tiempo no puede ser el único que mata la sesión');
        assert.equal(collab.refusalIsRetryable('forbidden'), false,
            'y lo que no es un rechazo de sala no se vuelve reintentable por descuido');
    });
});

describe('CLASE D: el plazo lo calcula el recurso agotado, y el rechazo no gasta otro cubo', () => {
    test('las DOS superficies del rechazo anuncian la recarga del cubo de LECTURA, no los 900 ms de la conexión', async () => {
        // 100 KB de ráfaga a 10 KB/s: tras servir un snapshot de 200 KB el descubierto son ~100 KB, o
        // sea ~10 segundos de espera real. `rateInstruction` anunciaba 900 ms (la ventana del cubo de
        // la CONEXIÓN), así que el cliente sondeaba once veces por cada espera de verdad y cada sondeo
        // le costaba fichas de ESCRITURA.
        await conPresupuesto(100_000, 10_000, async () => {
            const primera = await abre('plazo', P.plazo, NONCE_A);
            try {
                assert.equal(primera.event, 'welcome');
                const room = collab._rooms.get(P.plazo);
                const conn = [...room.conns.values()][0];
                const opsAntes = conn.opTokens;
                const bytesAntes = conn.byteTokens;

                const rechazos = [
                    {
                        nombre: 'resync (429)',
                        pide: async () => {
                            const r = await post('plazo', `/collab/${P.plazo}/resync`,
                                { siteId: conn.siteId, epoch: 1, vv: {} });
                            assert.equal(r.status, 429);
                            assert.equal(r.body.code, 'collab_read_budget',
                                'con el código genérico el cliente congela también la SUBIDA de ops');
                            assert.ok(typeof r.body.rateSeal === 'string' && r.body.rateSeal.length > 0,
                                'todo rechazo del módulo sigue llevando su instrucción completa');
                            return Number(r.body.retryAfterMs);
                        },
                    },
                    {
                        nombre: 'stream (rechazo de join)',
                        pide: async () => {
                            const r = await abre('plazo', P.plazo, NONCE_C);
                            r.close();
                            assert.equal(r.event, 'error');
                            assert.equal(r.data.code, 'read-budget');
                            assert.equal(r.data.retryable, true,
                                'el servidor tiene que DECIR que esto se reintenta: la lista del cliente era la segunda copia');
                            return Number(r.data.retryAfterMs);
                        },
                    },
                ];

                for (const r of rechazos) {
                    const espera = await r.pide();
                    assert.ok(Number.isFinite(espera) && espera > collab.CONFIG.RATE_RETRY_MS * 5,
                        `${r.nombre}: la espera anunciada (${espera} ms) sigue siendo la de otro cubo`);
                }

                // Y NO SE PAGA CON EL CUBO DE ESCRITURA: el cheque de lectura va ANTES del `rateGate`,
                // así que un rechazo que no depende de las fichas de la conexión ya no se las gasta.
                assert.equal(conn.opTokens, opsAntes,
                    'un rechazo por presupuesto de LECTURA no puede descontar fichas de ops');
                assert.equal(conn.byteTokens, bytesAntes, 'ni bytes del cubo de la conexión');

                // CONTRAPARTIDA NO NEGOCIABLE: leer de más nunca puede impedir ESCRIBIR.
                const escribe = await post('plazo', `/collab/${P.plazo}/ops`, {
                    siteId: conn.siteId, epoch: 1, ops: [{
                        k: 'propSet', id: { site: conn.siteId, counter: 1 }, hlc: { l: 101, c: 0, site: conn.siteId },
                        nodeId: 'n1', key: 'titulo', value: 'sigo editando',
                    }],
                });
                assert.equal(escribe.status, 200, 'el descubierto de LECTURA no frena la subida');
            } finally {
                primera.close();
                await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [P.plazo]);
            }
        });
    });
});

/* ============================================================================================= */
/* CLASE E — un MAX_ que no desaloja nada no es un máximo                                          */
/* ============================================================================================= */

describe('CLASE E: `MAX_READ_BUCKETS` acota de verdad', () => {
    test('con todos los cubos en DESCUBIERTO el Map no pasa del tope', async () => {
        // La poda estaba estrangulada a una por segundo y solo borraba los cubos LLENOS, así que el
        // caso que importa —muchos usuarios debiendo a la vez— no recortaba NADA: el Map crecía por
        // encima del número declarado y el `MAX_` no era un máximo. Se recorre POR LA PUERTA REAL
        // (doce usuarios entrando en una sala) con el tope bajado, que es la única forma de ejercitar
        // el camino sin fabricar 5.000 cuentas.
        const tope = collab.CONFIG.MAX_READ_BUCKETS;
        collab.CONFIG.MAX_READ_BUCKETS = 8;
        const abiertos: { close: () => void }[] = [];
        try {
            await conPresupuesto(1_000, 1, async () => {
                collab._readBuckets.clear();
                for (const login of MUCHOS) {
                    const r = await abre(login, P.control, NONCE_A);
                    abiertos.push(r);
                    assert.equal(r.event, 'welcome', `${login} tenía su saldo entero: entra`);
                }
                assert.equal(MUCHOS.length > collab.CONFIG.MAX_READ_BUCKETS, true,
                    'el fixture tiene que superar el tope o no prueba nada');
                assert.ok(collab._readBuckets.size <= collab.CONFIG.MAX_READ_BUCKETS,
                    `el tope declarado son ${collab.CONFIG.MAX_READ_BUCKETS} cubos y hay ${collab._readBuckets.size}`);
                // Y lo que sobrevive es lo que DEBE: olvidar un cubo perdona su deuda, así que el
                // desalojo tiene que morder siempre por el lado del que menos debe.
                for (const [, b] of collab._readBuckets) {
                    assert.ok(b.tokens < collab.CONFIG.USER_READ_BURST,
                        'un cubo LLENO no debería seguir ocupando sitio mientras se desaloja a otros');
                }
            });
        } finally {
            for (const a of abiertos) a.close();
            collab.CONFIG.MAX_READ_BUCKETS = tope;
            await settle(250);
            collab._readBuckets.clear();
        }
    });
});

/* ============================================================================================= */
/* CLASE F — el SQL por dialecto que ninguna suite ejercita                                       */
/* ============================================================================================= */

describe('CLASE F: cada motor tiene su expresión, y ninguna rama se va sin aserto', () => {
    const realGetDbType = database.getDbType;
    after(() => { database.getDbType = realGetDbType; });

    const MOTORES = [
        { nombre: 'postgres', tipo: { isPostgres: true, isMySQL: false, driver: 'postgres' }, espera: 'octet_length(payload)', prohibido: /^LENGTH\(payload\)$/ },
        { nombre: 'mysql', tipo: { isPostgres: false, isMySQL: true, driver: 'mysql' }, espera: 'LENGTH(payload)', prohibido: /octet_length/ },
        { nombre: 'mariadb', tipo: { isPostgres: false, isMySQL: true, driver: 'mariadb' }, espera: 'LENGTH(payload)', prohibido: /octet_length/ },
        { nombre: 'sqlite-native', tipo: { isPostgres: false, isMySQL: false, driver: 'sqlite-native' }, espera: 'LENGTH(CAST(payload AS BLOB))', prohibido: /octet_length/ },
        { nombre: 'desconocido', tipo: { isPostgres: false, isMySQL: false, driver: 'cockroach' }, espera: 'LENGTH(payload)', prohibido: /octet_length|BLOB/ },
    ];

    for (const m of MOTORES) {
        test(`payloadBytesExpr: ${m.nombre}`, () => {
            database.getDbType = () => m.tipo;
            const expr = collab._payloadBytesExpr();
            assert.equal(expr, m.espera, `${m.nombre}: la expresión de bytes no es la de su dialecto`);
            assert.ok(!m.prohibido.test(expr),
                `${m.nombre}: ${expr} no existe (o no cuenta bytes) en este motor`);
        });
    }

    test('y en el motor que la suite SÍ puede ejecutar, la expresión devuelve BYTES', async () => {
        // El aserto de cadena fija el dialecto elegido; esto fija que el dialecto elegido SIGNIFICA lo
        // que el presupuesto necesita. Un carácter CJK son 3 bytes y 1 carácter: si algún día alguien
        // quita el CAST, aquí sale 1 y el techo del log vuelve a valer el triple sin decirlo.
        database.getDbType = realGetDbType;
        const CJK = String.fromCodePoint(0x597d).repeat(10);   // 好 ×10 = 30 bytes, 10 caracteres
        await dbAsync.run(
            'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [P.control, 99, NONCE_A, 1, 'propSet', CJK, U.controla]);
        try {
            const r = await dbAsync.get(
                `SELECT ${collab._payloadBytesExpr()} AS n FROM collab_ops WHERE post_id = ? AND epoch = 99`, [P.control]);
            assert.equal(Number(r.n), Buffer.byteLength(CJK, 'utf8'), 'la medida del log tiene que ser en BYTES');
            assert.notEqual(Number(r.n), CJK.length, 'contar caracteres es lo que subía el techo ×3 en japonés');
        } finally {
            await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ? AND epoch = 99', [P.control]);
        }
    });

    test('dist-lock: el RELOJ de cada modo, recorrido entero', async () => {
        const realDbAsync = database.dbAsync;
        const sql: string[] = [];
        const MODOS = [
            { driver: 'postgres', tipo: { isPostgres: true, isMySQL: false, driver: 'postgres' }, espera: /EXTRACT\(EPOCH FROM now\(\)\)/, prohibido: /UNIX_TIMESTAMP/ },
            { driver: 'mysql', tipo: { isPostgres: false, isMySQL: true, driver: 'mysql' }, espera: /CAST\(UNIX_TIMESTAMP/, prohibido: /EXTRACT\(EPOCH/ },
            { driver: 'mariadb', tipo: { isPostgres: false, isMySQL: true, driver: 'mariadb' }, espera: /CAST\(UNIX_TIMESTAMP/, prohibido: /EXTRACT\(EPOCH/ },
        ];
        try {
            for (const m of MODOS) {
                sql.length = 0;
                database.getDbType = () => m.tipo;
                database.dbAsync = {
                    run: async (q: string) => { sql.push(q); return { changes: 1 }; },
                    exec: async (q: string) => { sql.push(q); },
                    get: async () => undefined, all: async () => [],
                };
                assert.equal(await distLock.tryAcquire(`x5:${m.driver}`, 1000), true);
                const cas = sql.find((q) => /UPDATE wordjs_locks SET holder/.test(q)) || '';
                assert.ok(m.espera.test(cas), `${m.driver}: reloj equivocado -> ${cas}`);
                assert.ok(!m.prohibido.test(cas), `${m.driver}: sintaxis de otro motor -> ${cas}`);
            }
        } finally {
            database.getDbType = realGetDbType;
            database.dbAsync = realDbAsync;
        }
    });
});

/* ============================================================================================= */
/* CLASE G — «no concedido» y «nunca concedible» no pueden ser el mismo valor                     */
/* ============================================================================================= */

describe('CLASE G: el lock distingue la CONTENCIÓN de un lock que nunca se va a poder tomar', () => {
    const realGetDbType = database.getDbType;
    const realDbAsync = database.dbAsync;

    const err = (props: any) => Object.assign(new Error(String(props.message || 'fallo del lock')), props);

    const FALLOS = [
        { nombre: 'la tabla no existe (MySQL)', e: () => err({ message: "Table 'wordjs.wordjs_locks' doesn't exist", code: 'ER_NO_SUCH_TABLE', errno: 1146 }), estructural: true },
        { nombre: 'la tabla no existe (Postgres)', e: () => err({ message: 'relation "wordjs_locks" does not exist', code: '42P01' }), estructural: true },
        { nombre: 'sin permiso sobre la tabla (MySQL)', e: () => err({ message: "SELECT command denied to user 'wjs'", code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }), estructural: true },
        { nombre: 'sin permiso (Postgres)', e: () => err({ message: 'permission denied for table wordjs_locks', code: '42501' }), estructural: true },
        { nombre: 'sintaxis inválida en este motor', e: () => err({ message: 'syntax error at or near "ON"', code: '42601' }), estructural: true },
        { nombre: 'la conexión se cayó (transitorio)', e: () => err({ message: 'read ECONNRESET', code: 'ECONNRESET' }), estructural: false },
    ];

    async function conFallo(e: () => any, fn: (intentos: () => number, avisos: () => number) => Promise<void>) {
        let intentos = 0;
        let avisos = 0;
        const realWarn = console.warn;
        database.getDbType = () => ({ isPostgres: false, isMySQL: true, isSQLite: false, driver: 'mysql' });
        database.dbAsync = {
            run: async () => { intentos++; throw e(); },
            exec: async () => { /* la DDL "funciona": el fallo es de la sentencia, no del CREATE */ },
            get: async () => undefined, all: async () => [],
        };
        console.warn = () => { avisos++; };
        try { await fn(() => intentos, () => avisos); } finally {
            console.warn = realWarn;
            database.getDbType = realGetDbType;
            database.dbAsync = realDbAsync;
        }
    }

    for (const f of FALLOS) {
        test(`${f.nombre}: el bucle NO se come el timeout entero`, async () => {
            await conFallo(f.e, async (intentos, avisos) => {
                const t0 = Date.now();
                const h = await distLock.acquireBlocking(`x5:g:${f.nombre}`, { ttlMs: 1000, timeoutMs: 3000, pollMs: 50 });
                const tardo = Date.now() - t0;
                assert.equal(h.held, false, 'sigue fallando CERRADO: un lock que no se tiene no se finge');
                assert.ok(tardo < 1500,
                    `esperar no arregla esto y se estuvo esperando ${tardo} ms (en producción son 300.000)`);
                // Un fallo ESTRUCTURAL se ve al primer intento; uno desconocido se reintenta un par de
                // veces por si era un parpadeo, pero tampoco puede comprarse el timeout entero.
                if (f.estructural) assert.ok(intentos() <= 2, `un fallo estructural no se reintenta 600 veces (fueron ${intentos()})`);
                else assert.ok(intentos() >= 2 && intentos() <= 4, `un fallo transitorio sí merece reintento (fueron ${intentos()})`);
                assert.ok(avisos() <= 2, `la causa se registra UNA vez, no una por intento (fueron ${avisos()})`);
            });
        });
    }

    test('CONTROL POSITIVO: la CONTENCIÓN legítima se sigue esperando', async () => {
        // El arreglo no puede convertir «otro nodo lo tiene» en «ríndete»: eso rompería la serialización
        // del arranque, que es para lo que existe el lock. Aquí el CAS no lanza, simplemente no toca
        // filas, y el bucle tiene que seguir sondeando hasta que el otro nodo suelte.
        let intentos = 0;
        database.getDbType = () => ({ isPostgres: false, isMySQL: true, isSQLite: false, driver: 'mysql' });
        database.dbAsync = {
            run: async (q: string) => {
                if (/UPDATE wordjs_locks SET holder/.test(q)) { intentos++; return { changes: intentos >= 4 ? 1 : 0 }; }
                return { changes: 1 };
            },
            exec: async () => { /* la tabla existe */ },
            get: async () => undefined, all: async () => [],
        };
        try {
            const h = await distLock.acquireBlocking('x5:contencion', { ttlMs: 1000, timeoutMs: 3000, pollMs: 20 });
            assert.equal(h.held, true, 'quien espera a que el otro suelte tiene que acabar entrando');
            assert.ok(intentos >= 4, `y tiene que haber SONDEADO, no rendirse al primero (fueron ${intentos})`);
            await h.release();
        } finally {
            database.getDbType = realGetDbType;
            database.dbAsync = realDbAsync;
        }
    });
});
