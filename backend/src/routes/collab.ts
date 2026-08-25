/**
 * WordJS — Verso/colaboración en tiempo real: rutas del transporte (F8.3).
 *
 *   GET  /api/v1/collab/:postId/stream?siteId=…   SSE — canal de BAJADA
 *   POST /api/v1/collab/:postId/ops               operaciones CRDT (SUBIDA)
 *   POST /api/v1/collab/:postId/presence          cursor/selección (efímero)
 *   POST /api/v1/collab/:postId/resync            cierre de huecos por version vector
 *   POST /api/v1/collab/:postId/leave             baja explícita (el `unload` del navegador)
 *
 * MODELO DE AUTORIZACIÓN — la parte que no se negocia:
 *
 *  1. AUTENTICACIÓN igual que el resto de la API: `authenticate` (cookie HttpOnly `wordjs_token`
 *     o `Authorization: Bearer`). NO se usa `authenticateAllowQuery`: un JWT en la query se filtra
 *     por los access logs, el `Referer` y el historial, y `EventSource` ya manda la cookie
 *     same-origin sin ayuda.
 *  2. CSRF. Los POST los cubre el `csrfProtection` global (Origin/Referer same-origin). El GET del
 *     stream NO lo cubre — solo mira métodos que cambian estado — así que aquí se comprueba el
 *     Origin explícitamente: sin eso, un sitio hostil podría abrir el stream con las credenciales
 *     ambientales de la víctima y leer en vivo el contenido de un borrador.
 *  3. AUTORIZACIÓN POR EL POST CONCRETO, no por un permiso nuevo: se carga el post y se aplica
 *     EXACTAMENTE el mismo gate que `PUT /posts/:id` (`capsForType` + own/others + published).
 *     Si puedes editar ese post por HTTP, entras en su sala; si no, no. No hay modo lector (D16):
 *     un lector consumiría un borrador por un canal que no pasa por los filtros de la ruta de
 *     lectura, y su presencia filtraría quién está editando qué a quien no puede editar.
 *  4. IDENTIDAD DE RÉPLICA. El `siteId` se ata a la conexión SSE en el `join`; los POST tienen que
 *     presentar un `siteId` que sea de una conexión viva Y del usuario que llama (`findConn`), y
 *     el validador exige además que cada op se declare de ese mismo `siteId`. El servidor JAMÁS
 *     usa un id de usuario que venga del cliente: sale de `req.user`.
 *  5. INGEST HOSTIL. Toda op se re-construye y se sanea en `core/collab-ops.ts` con el mismo
 *     `sanitizePuckTree` de la ruta de escritura antes de persistirse y difundirse.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();

const jwt = require('jsonwebtoken');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { canEditPostRecord, isRestExposedPostType } = require('../core/post-capabilities');
const config = require('../config/app');
const Post = require('../models/Post');
const collab = require('../core/collab-rooms');

/* ------------------------------------------------------------------------------------------- */
/* Gates                                                                                         */
/* ------------------------------------------------------------------------------------------- */

function parsePostId(raw: any): number | null {
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Same-origin para el GET del stream. Réplica de la lógica de `csrfProtection` (que solo corre en
 * métodos que cambian estado): se honra `X-Forwarded-Host` primero porque detrás del gateway el
 * `Host` que ve el backend es la dirección interna del upstream, no la que puso el navegador.
 */
function sameOrigin(req: Request): boolean {
    const origin = req.get('Origin');
    const referer = req.get('Referer');
    let requestOrigin: string | null = origin || null;
    if (!requestOrigin && referer) {
        try { requestOrigin = new URL(referer).origin; } catch { requestOrigin = null; }
    }
    // Un cliente NO-navegador (Bearer, sin Origin ni Referer) no puede ser víctima de CSRF: no hay
    // credencial ambiental que un tercero pueda hacer viajar.
    if (!origin && !referer) {
        const auth = req.get('Authorization') || '';
        return auth.startsWith('Bearer ') && auth !== 'Bearer null' && auth !== 'Bearer undefined';
    }
    if (!requestOrigin) return false;

    const fwdHost = (req.get('X-Forwarded-Host') || '').split(',')[0].trim();
    const host = fwdHost || req.get('Host');
    try {
        if (new URL(requestOrigin).host === host) return true;
    } catch { return false; }

    const allowed = [config.site?.url, config.site?.frontendUrl, `http://${host}`, `https://${host}`].filter(Boolean);
    return allowed.some((a: string) => { try { return new URL(a).origin === requestOrigin; } catch { return false; } });
}

type Gate = { ok: true; post: any } | { ok: false; status: number; code: string; message: string };

/**
 * Lo ÚNICO que `gate` mira es el principal, y por eso el parámetro es el principal y no la petición:
 * `makeRevalidate` lo vuelve a evaluar contra un usuario RECIÉN cargado de la BD, cuando ya no hay
 * ninguna petición viva a la que preguntarle. Sale de la propia `Request` (types/globals.d.ts) para
 * que si algún día `user` deja de ser laxo, este camino se entere.
 */
type Principal = Pick<Request, 'user'>;

/**
 * `authenticate` marca las sesiones de token de máquina (`wjt_`) con `req.apiToken`, pero la
 * ampliación global de `Request` (types/globals.d.ts) solo declara `user` y `pluginSlug`. El campo se
 * nombra AQUÍ, en el único sitio que lo lee, en lugar de ensanchar el parámetro entero: la CLASE de
 * credencial es justamente lo que no puede volver a deducirse de un dato laxo (ver `makeRevalidate`).
 */
type AuthedRequest = Request & { apiToken?: unknown };

/**
 * El gate de edición del post. YA NO SE COPIA: es literalmente el de `PUT /posts/:id`, porque las
 * tres líneas (familia por tipo + propio/ajeno + publicado) viven una sola vez en
 * `core/post-capabilities.canEditPostRecord`. Tenerlas escritas aquí era la forma en la que
 * `POST /presence/:postId` acabó autorizando por la capacidad GLOBAL mientras este canal
 * autorizaba por el post: dos superficies, una política, una de ellas equivocada.
 *
 * `isRestExposedPostType` además: `revision` y `nav_menu_item` son filas de `posts` sin
 * `capability_type`, así que la familia las deja caer en la de `post`. Pertenecen a sus propias
 * APIs y no hay sesión de editor que colaborar sobre ellas.
 */
async function gate(req: Principal, postId: number): Promise<Gate> {
    const post = await Post.findById(postId);
    if (!post) return { ok: false, status: 404, code: 'rest_post_invalid', message: 'Post not found.' };

    if (!isRestExposedPostType(post.type || post.postType || 'post') || !canEditPostRecord(req.user, post)) {
        return { ok: false, status: 403, code: 'rest_forbidden', message: 'You cannot edit this post.' };
    }
    return { ok: true, post };
}

const deny = (res: Response, g: Extract<Gate, { ok: false }>) =>
    res.status(g.status).json({ code: g.code, message: g.message, data: { status: g.status } });

/**
 * Escritura SEGURA sobre el stream. `res.write()` sobre una respuesta ya terminada NO lanza: Node
 * emite `'error'` (`ERR_STREAM_WRITE_AFTER_END`) en el siguiente tick, FUERA de la cadena de
 * promesas del `asyncHandler`, así que ningún `try/catch` de la ruta lo ve y acaba en el
 * `process.on('uncaughtException')` del arranque, que hace `process.exit(1)`.
 *
 * Traducido: un hipo de BD durante el `join` de UN editor tumbaba el CMS entero. Aquí se mira el
 * estado del socket antes de escribir, y el `res.on('error')` de la ruta remata la contención.
 */
function sseWrite(res: Response, chunk: string): boolean {
    const r = res as any;
    if (!r || r.destroyed || r.writableEnded || r.writable === false) return false;
    try { return res.write(chunk); } catch { return false; }
}

/**
 * EL MISMO TOKEN QUE USÓ `authenticate`, para poder volver a evaluarlo mientras el stream vive.
 *
 * La selección replica la de `middleware/auth.ts#authenticate`, incluidas las exclusiones que parecen
 * cosmética y no lo son: `Bearer null` y `Bearer undefined` (lo que manda un frontend que hace
 * `localStorage.getItem('token')` sin comprobar). `authenticate` las IGNORA y cae a la cookie; la
 * versión anterior de esta función no, y ahí había un bypass real: con `Authorization: Bearer null` +
 * la cookie de sesión válida, `authenticate` autenticaba por cookie y aquí se recogía la cadena
 * `"null"`, que no es un JWT — así que la re-autorización tomaba el camino "no hay JWT que verificar"
 * y el stream sobrevivía al cierre de sesión, al cambio de contraseña y a la caducidad del token. Un
 * valor elegido por quien llama decidía si se comprobaba la revocación.
 *
 * LA CAÍDA A LA COOKIE SE ESCRIBE COMO LA ESCRIBE `authenticate`: «si del header no sale un token,
 * usa la cookie». Enumerar los tres casos malos a mano dejó fuera el tercero — `Authorization:
 * Bearer ` a secas, con el token vacío — porque en `authenticate` no lo excluye ninguna comparación,
 * lo excluye que `''` sea FALSY en `if (!token && cookie)`. Aquí se recogía esa cadena vacía y no se
 * caía a la cookie, así que el editor entraba (autenticado por cookie) y la primera re-autorización
 * lo echaba de la sala con `unauthorized`. Fallaba hacia el lado seguro, pero echaba a un editor
 * legítimo cada cuatro ticks. La forma de la regla es lo que evita que la lista se vuelva a quedar
 * corta: no hay lista.
 */
function sessionToken(req: Request): string {
    const header = String(req.get('Authorization') || '');
    const delHeader = header.startsWith('Bearer ') && header !== 'Bearer null' && header !== 'Bearer undefined'
        ? header.slice(7).trim()
        : '';
    return delHeader || String((req.cookies && req.cookies.wordjs_token) || '');
}

/**
 * RE-AUTORIZACIÓN de un stream vivo.
 *
 * `gate()` corre una sola vez, en el handshake, y el SSE puede vivir horas. Sin esto, cerrar sesión,
 * cambiar la contraseña (que estampa `token_valid_after`), que caduque el JWT o que a alguien le
 * bajen el rol NO cortaban la entrega en vivo del borrador: el editor revocado seguía recibiendo
 * cada tecla que escribían los demás. Los mecanismos de revocación del proyecto se evalúan POR
 * PETICIÓN, y un stream es UNA petición.
 *
 * Contrato con la sala: `false` = denegado (se cierra); LANZAR = no se ha podido comprobar (la sala
 * lo tolera un rato acotado antes de cerrar por precaución). Un token caducado o inválido es
 * denegación explícita, no incertidumbre.
 *
 * QUÉ CREDENCIAL HAY QUE RE-VERIFICAR NO LO DECIDE EL DATO, LO DECIDE EL MIDDLEWARE. Antes se
 * deducía de la FORMA de la cadena (`rawToken.split('.').length === 3` ⇒ "esto parece un JWT"), o
 * sea de un valor que pone quien llama: bastaba una cadena sin dos puntos en `Authorization` para
 * que el stream cayera en la rama "no hay JWT que verificar" y se saltara la caducidad y el
 * `token_valid_after`. Ahora la rama sale de `req.apiToken`, que solo existe si `authenticate`
 * validó de verdad un token de API, y el resto de credenciales de sesión TIENEN que verificar su JWT
 * o se deniegan. Falla cerrado: si la cadena no verifica, no hay "otra rama" a la que caer.
 */
function makeRevalidate(req: AuthedRequest, postId: number): () => Promise<boolean> {
    const rawToken = sessionToken(req);
    // La clase de credencial la fijó `authenticate` al autenticar; aquí no se vuelve a inferir.
    const apiTokenSession = !!req.apiToken;
    const userId = req.user.id;
    const User = require('../models/User');
    const ApiToken = require('../models/ApiToken');

    return async (): Promise<boolean> => {
        let user: any;
        if (apiTokenSession) {
            // Token de API (`wjt_`): no hay JWT, pero SÍ hay revocación y caducidad que comprobar —
            // `findByRawToken` devuelve `null` para un token revocado o vencido. No re-verificar nada
            // aquí dejaba vivo el stream de un token ya revocado.
            const record = await ApiToken.findByRawToken(rawToken);
            if (!record || Number(record.userId) !== Number(userId)) return false;
            user = await User.findById(userId);
            if (!user) return false;
        } else {
            let decoded: any;
            try {
                decoded = jwt.verify(rawToken, config.jwt.secret, { algorithms: ['HS256'] });
            } catch {
                return false; // caducado, revocado por firma, manipulado… o simplemente no es un JWT
            }
            if (decoded.purpose) return false;
            if (Number(decoded.userId) !== Number(userId)) return false;
            user = await User.findById(userId);
            if (!user) return false;
            const validAfter = parseInt(user.meta && user.meta.token_valid_after, 10);
            if (validAfter && decoded.iat && decoded.iat <= validAfter) return false;
        }
        const g = await gate({ user }, postId);
        return g.ok;
    };
}

/**
 * ÚNICA TRADUCCIÓN DE UN RECHAZO POR RITMO A HTTP. Un 429 SIEMPRE lleva la espera, el número de
 * serie del aviso y el SELLO de la conexión que lo acuñó: son lo que el cliente devuelve para poder
 * ser considerado desobediente (ver `rateGate` en core/collab-rooms.ts), así que un camino que se
 * olvide de mandarlos vuelve inmune a su cliente. Con una sola función no hay «un camino que se
 * olvide». El sello va con el número porque sin él el número no identifica nada: es el par entero lo
 * que el servidor sabe reconocer.
 */
function denyRate(res: Response, status: number, r: { code: string; message?: string; rate?: any }): Response {
    return res.status(status).json({
        code: r.code,
        message: r.message,
        retryAfterMs: r.rate ? r.rate.retryAfterMs : undefined,
        rateNotice: r.rate ? r.rate.notice : undefined,
        rateSeal: r.rate ? r.rate.seal : undefined,
        data: { status },
    });
}

/** Resuelve post + conexión para las rutas de subida. */
async function connGate(req: Request, res: Response): Promise<any | null> {
    const postId = parsePostId(req.params.postId);
    if (postId === null) {
        res.status(400).json({ code: 'rest_invalid_param', message: 'invalid post id', data: { status: 400 } });
        return null;
    }
    const g = await gate(req, postId);
    if (!g.ok) { deny(res, g); return null; }

    const conn = collab.findConn(postId, req.body?.siteId, req.user.id);
    if (!conn) {
        // Sin conexión SSE viva no hay sala a la que hablar. Esto no es una formalidad: es lo que
        // impide usar la ruta como amplificador sin mantener un canal abierto y auditado.
        res.status(409).json({
            code: 'collab_no_session',
            message: 'No hay una sesión colaborativa abierta para ese siteId.',
            data: { status: 409 },
        });
        return null;
    }
    // ÚNICA PUERTA por la que una ruta de subida consigue una conexión, y por eso el acuse de la
    // espera se anota AQUÍ: cualquier ruta nueva lo hereda sin tener que acordarse. Anotarlo en cada
    // handler es exactamente la forma en la que este defecto se mudó de camino tres veces.
    //
    // El acuse viaja SIEMPRE con su sello. Los dos campos se pasan juntos porque juntos son el dato:
    // un número sin sello no dice de qué conexión habla, y ése era el agujero de la ronda 5.
    collab.noteRateAck(conn, req.body?.rateAck, req.body?.rateSeal);
    return conn;
}

/* ------------------------------------------------------------------------------------------- */
/* GET /:postId/stream — canal de BAJADA (SSE)                                                   */
/* ------------------------------------------------------------------------------------------- */

router.get('/:postId/stream', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const postId = parsePostId(req.params.postId);
    if (postId === null) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'invalid post id', data: { status: 400 } });
    }
    if (!sameOrigin(req)) {
        return res.status(403).json({ code: 'rest_csrf_invalid', message: 'Cross-site request blocked.', data: { status: 403 } });
    }
    const g = await gate(req, postId);
    if (!g.ok) return deny(res, g);

    const siteNonce = String(req.query.siteId || '');
    // Lo que manda el cliente es un NONCE, no la identidad: la identidad la deriva el servidor con
    // el `userId` dentro (ver `replicaId` en core/collab-rooms.ts), así que presentar el `siteId`
    // público de un compañero no sirve para emitir a su nombre. La FORMA se sigue exigiendo aquí
    // porque de ella cuelga la del identificador derivado.
    if (!/^s_[a-z2-7]{1,32}$/.test(siteNonce)) {
        return res.status(400).json({ code: 'collab_bad_site', message: 'siteId inválido.', data: { status: 400 } });
    }

    // El listener de cierre se registra ANTES del `await`, y no es un detalle de estilo: `join()`
    // hace varias consultas, y si el cliente aborta dentro de esa ventana (un F5 sobre el editor,
    // nginx cortando el upstream) el evento `close` YA se emitió cuando se registraba después — el
    // listener no corría nunca y la conexión quedaba dada de alta para siempre, con su temporizador
    // y su cupo. Escribir en un socket destruido NO lanza, así que nada la recogía.
    let conn: any = null;
    let aborted = false;
    const onClose = () => { aborted = true; if (conn) void collab.leave(conn); };
    req.on('close', onClose);
    res.on('close', onClose);

    // CONTENCIÓN DEL FALLO A UNA SOLA SESIÓN. Sin este listener, CUALQUIER error del stream (escribir
    // sobre una respuesta terminada, un socket que se rompe a media escritura) es un `'error'` sin
    // manejador sobre la `ServerResponse` ⇒ `uncaughtException` ⇒ `process.exit(1)`. Con él, lo peor
    // que puede pasar es que se caiga ESTA sesión colaborativa.
    res.on('error', (e: any) => {
        console.warn('[collab] stream roto:', e && e.message);
        if (conn) void collab.leave(conn);
    });
    req.on('error', () => { /* aborto del cliente: lo recoge `onClose` */ });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx/gateway: no bufferizar el stream
    (res as any).flushHeaders?.();
    sseWrite(res, 'retry: 3000\n\n');

    const joined = await collab.join({
        res,
        postId,
        userId: req.user.id,
        siteId: siteNonce,
        name: req.user.display_name || req.user.displayName || req.user.username || '',
        revalidate: makeRevalidate(req, postId),
    });

    if (!joined.ok) {
        // Los headers ya salieron (es un stream), así que el rechazo se comunica DENTRO del stream
        // y se cierra: un status HTTP ya no es posible y un cierre mudo dejaría al cliente
        // reintentando en bucle sin saber por qué. La sala NO cierra la respuesta en su camino de
        // error justamente para que este mensaje pueda salir (ver `leave(conn, {closeSocket:false})`).
        //
        // EL RECHAZO DICE SI SE PUEDE REINTENTAR Y CUÁNDO, y las dos cosas las decide QUIEN LAS SABE.
        // Antes solo viajaba el código y el cliente lo clasificaba con una lista blanca escrita a
        // mano: añadir una variante en el servidor (`read-budget`) la dejaba caer en su rama
        // terminal, así que lo que aquí se diseñó como una ESPERA mataba la sesión del usuario hasta
        // recargar la página. La retryabilidad sale ahora de `REFUSAL_RETRYABLE` (que el compilador
        // obliga a completar para cada variante) y el plazo, del cubo que de verdad bloquea.
        sseWrite(res, `event: error\ndata: ${JSON.stringify({
            code: joined.refusal,
            retryable: collab.refusalIsRetryable(joined.refusal),
            retryAfterMs: joined.retryAfterMs,
            message: 'No se pudo abrir la sesión colaborativa.',
        })}\n\n`);
        if (!(res as any).writableEnded) res.end();
        return;
    }

    conn = joined.conn;

    // El cliente pudo irse mientras `join()` consultaba la BD: el `close` ya saltó y el listener de
    // arriba no tenía todavía `conn`. Se comprueba explícitamente en vez de confiar en el evento.
    if (aborted || req.destroyed || (res as any).writableEnded || (res as any).destroyed) {
        void collab.leave(conn);
        return;
    }

    // `welcome` lleva TODO lo necesario para reconstruir el estado sin más viajes: el snapshot base
    // del epoch y el log de ops posteriores. El cliente hace `toCrdt(base)` + `applyAll(ops)`; las
    // posiciones semilla son función pura del snapshot, así que llega EXACTAMENTE al mismo estado
    // que los que ya estaban.
    //
    // `self.siteId` es la identidad DERIVADA POR EL SERVIDOR, no el nonce que mandó el cliente: el
    // cliente la adopta desde aquí y con ella firma todas sus ops.
    collab.writeEvent(conn, 'welcome', {
        epoch: joined.epoch,
        base: joined.base,
        ops: joined.ops,
        members: joined.members,
        self: { siteId: conn.siteId, userId: req.user.id, name: conn.name, color: conn.color },
        serverTime: Date.now(),
        truncated: joined.truncated,
        limits: {
            maxOpsPerSec: collab.CONFIG.MAX_OPS_PER_SEC,
            maxBytesPerSec: collab.CONFIG.MAX_BYTES_PER_SEC,
            maxFrameBytes: collab.CONFIG.MAX_FRAME_BYTES,
            // LA ESPERA VIAJA POR EL CABLE, y ésta es su ÚNICA FUENTE. El cliente llevaba 1000 ms
            // fijos escritos en otro fichero de otro paquete: con 900 < 1000 funcionaba POR
            // CASUALIDAD, y subir la constante del servidor —o bajar la del cliente— reabría la
            // expulsión en silencio, sin un solo test en rojo. De aquí sale AHORA la espera de todos
            // los caminos del cliente (ops, presencia, resync y reconexión), y cada 429 la repite
            // junto al número de serie del aviso.
            rateRetryMs: collab.CONFIG.RATE_RETRY_MS,
        },
    });
}));

/* ------------------------------------------------------------------------------------------- */
/* POST /:postId/ops — SUBIDA                                                                    */
/* ------------------------------------------------------------------------------------------- */

router.post('/:postId/ops', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;

    const result = await collab.pushOps(conn, req.body?.ops, req.body?.epoch);
    if (!result.ok) {
        return denyRate(res, result.status, result);
    }
    // `rejected` viaja de vuelta a propósito: el emisor tiene que poder enterarse de que algo suyo
    // no pasó el filtro en el momento, no releyendo su documento más tarde. `normalized` es lo mismo
    // para lo que el saneador REESCRIBIÓ: el emisor no recibe la difusión de sus propias ops, así
    // que este es su único camino para adoptar el valor bueno en vez de quedarse con el crudo.
    res.json({
        ok: true,
        txId: req.body?.txId ?? null,
        accepted: result.accepted,
        known: result.known,
        rejected: result.rejected,
        persisted: result.persisted,
        normalized: result.normalized,
    });
}));

/* ------------------------------------------------------------------------------------------- */
/* POST /:postId/presence                                                                        */
/* ------------------------------------------------------------------------------------------- */

router.post('/:postId/presence', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;

    const r = await collab.setPresence(conn, req.body?.sel);
    if (!r.ok) {
        return denyRate(res, r.status || 409, r);
    }
    res.json({ ok: true });
}));

/* ------------------------------------------------------------------------------------------- */
/* POST /:postId/resync                                                                          */
/* ------------------------------------------------------------------------------------------- */

router.post('/:postId/resync', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;

    // `resync` pasa por el límite de ritmo DENTRO de la sala (necesita la conexión para cobrar): es
    // la petición más barata de formular y la más cara de servir, así que sin cobrarla era un
    // amplificador contra la memoria del proceso y contra la BD.
    const r = await collab.resync(conn, req.body?.vv, req.body?.epoch);
    if (!r.ok) {
        return denyRate(res, r.status, r);
    }
    res.json({ epoch: r.epoch, ops: r.ops, base: r.base, complete: r.complete });
}));

/* ------------------------------------------------------------------------------------------- */
/* POST /:postId/leave                                                                           */
/* ------------------------------------------------------------------------------------------- */

router.post('/:postId/leave', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;
    await collab.leave(conn);
    res.json({ ok: true });
}));

// `sseWrite` se expone SOLO para poder falsearlo. Es una guarda de contención cuyo caso —escribir
// sobre una respuesta ya terminada— no se puede provocar por HTTP mientras el resto del arreglo esté
// en su sitio (la sala no cierra la respuesta en su camino de error), así que sin esta puerta la
// guarda se quedaba sin ningún test que la pusiera roja. Una defensa en profundidad que nadie falsea
// es la que desaparece en el siguiente refactor.
(router as any)._sseWrite = sseWrite;

// MISMA PUERTA, MISMO MOTIVO, para las DOS MITADES del arreglo de #688.
//
// El bypass necesitaba las dos a la vez (recoger `Bearer null` como si fuera la credencial Y elegir
// la rama por la FORMA del dato), así que el test de caja negra —revocar la sesión y esperar que el
// stream se cierre— se pone verde revirtiendo cualquiera de ellas por separado: la que sobrevive
// cierra el agujero sola. Eso deja el bypass a UN commit de distancia con la suite en verde, que es
// exactamente lo que este proyecto ya se comió antes. Cada mitad tiene aquí su contrato, y cada
// contrato su rojo:
//   · `sessionToken` — devolver LA MISMA credencial que usó `authenticate`, exclusiones incluidas.
//   · `makeRevalidate` — la CLASE de credencial la fija el middleware (`req.apiToken`), nunca el
//     aspecto de la cadena; lo que no sea token de API tiene que verificar su JWT o denegarse.
(router as any)._sessionToken = sessionToken;
(router as any)._makeRevalidate = makeRevalidate;

module.exports = router;
