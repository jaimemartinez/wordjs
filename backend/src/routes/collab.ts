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

import type { Response } from 'express';

const express = require('express');
const router = express.Router();

const jwt = require('jsonwebtoken');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { capsFor, capsForType } = require('../core/post-capabilities');
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
function sameOrigin(req: any): boolean {
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
 * El gate de edición del post, calcado de `routes/posts.ts` (update). Se copia la forma, no se
 * inventa: si esas tres líneas cambian allí, tienen que cambiar aquí, y por eso comparten
 * `capsForType` en vez de tener cada una su tabla de permisos.
 */
async function gate(req: any, postId: number): Promise<Gate> {
    const post = await Post.findById(postId);
    if (!post) return { ok: false, status: 404, code: 'rest_post_invalid', message: 'Post not found.' };

    const caps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    const isOwn = post.authorId === req.user.id;
    let canEdit = isOwn ? req.user.can(caps.edit) : req.user.can(caps.editOthers);
    if (post.postStatus === 'publish' && !req.user.can(caps.editPublished)) canEdit = false;

    if (!canEdit) {
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

/** El mismo token que usó `authenticate`, para poder volver a evaluarlo mientras el stream vive. */
function sessionToken(req: any): string {
    const header = String(req.get('Authorization') || '');
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    return String((req.cookies && req.cookies.wordjs_token) || '');
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
 */
function makeRevalidate(req: any, postId: number): () => Promise<boolean> {
    const rawToken = sessionToken(req);
    const userId = req.user.id;
    const User = require('../models/User');

    return async (): Promise<boolean> => {
        let user: any;
        if (rawToken && rawToken.split('.').length === 3) {
            let decoded: any;
            try {
                decoded = jwt.verify(rawToken, config.jwt.secret, { algorithms: ['HS256'] });
            } catch {
                return false; // caducado, revocado por firma o manipulado
            }
            if (decoded.purpose) return false;
            if (Number(decoded.userId) !== Number(userId)) return false;
            user = await User.findById(userId);
            if (!user) return false;
            const validAfter = parseInt(user.meta && user.meta.token_valid_after, 10);
            if (validAfter && decoded.iat && decoded.iat <= validAfter) return false;
        } else {
            // Cliente con token de API (`wjt_`): no hay JWT que re-verificar, pero el rol y el estado
            // del post sí pueden haber cambiado.
            user = await User.findById(userId);
            if (!user) return false;
        }
        const g = await gate({ user }, postId);
        return g.ok;
    };
}

/** Resuelve post + conexión para las rutas de subida. */
async function connGate(req: any, res: Response): Promise<any | null> {
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
    return conn;
}

/* ------------------------------------------------------------------------------------------- */
/* GET /:postId/stream — canal de BAJADA (SSE)                                                   */
/* ------------------------------------------------------------------------------------------- */

router.get('/:postId/stream', authenticate, asyncHandler(async (req: any, res: Response) => {
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
        sseWrite(res, `event: error\ndata: ${JSON.stringify({ code: joined.refusal, message: 'No se pudo abrir la sesión colaborativa.' })}\n\n`);
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
        },
    });
}));

/* ------------------------------------------------------------------------------------------- */
/* POST /:postId/ops — SUBIDA                                                                    */
/* ------------------------------------------------------------------------------------------- */

router.post('/:postId/ops', authenticate, asyncHandler(async (req: any, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;

    const result = await collab.pushOps(conn, req.body?.ops, req.body?.epoch);
    if (!result.ok) {
        return res.status(result.status).json({ code: result.code, message: result.message, data: { status: result.status } });
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

router.post('/:postId/presence', authenticate, asyncHandler(async (req: any, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;

    const r = await collab.setPresence(conn, req.body?.sel);
    if (!r.ok) {
        const status = r.code === 'collab_rate_limit' ? 429 : 409;
        return res.status(status).json({ code: r.code, message: r.message, data: { status } });
    }
    res.json({ ok: true });
}));

/* ------------------------------------------------------------------------------------------- */
/* POST /:postId/resync                                                                          */
/* ------------------------------------------------------------------------------------------- */

router.post('/:postId/resync', authenticate, asyncHandler(async (req: any, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;

    // `resync` pasa por el límite de ritmo DENTRO de la sala (necesita la conexión para cobrar): es
    // la petición más barata de formular y la más cara de servir, así que sin cobrarla era un
    // amplificador contra la memoria del proceso y contra la BD.
    const r = await collab.resync(conn, req.body?.vv, req.body?.epoch);
    if (!r.ok) {
        return res.status(r.status).json({ code: r.code, message: r.message, data: { status: r.status } });
    }
    res.json({ epoch: r.epoch, ops: r.ops, base: r.base, complete: r.complete });
}));

/* ------------------------------------------------------------------------------------------- */
/* POST /:postId/leave                                                                           */
/* ------------------------------------------------------------------------------------------- */

router.post('/:postId/leave', authenticate, asyncHandler(async (req: any, res: Response) => {
    const conn = await connGate(req, res);
    if (!conn) return;
    await collab.leave(conn);
    res.json({ ok: true });
}));

module.exports = router;
