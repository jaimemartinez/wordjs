/**
 * WordJS — Verso/colaboración: SALAS, transporte y fan-out (F8.3).
 *
 * ┌─ POR QUÉ SSE + POST Y NO WEBSOCKET ────────────────────────────────────────────────────────┐
 * │ La spec (D13) elegía `ws` sobre el `http.Server` existente. Al implementar se comprobó que  │
 * │ el backend NO tiene hoy servidor WebSocket ni la dependencia `ws`, ni un solo handler de    │
 * │ `upgrade`. Meterlo significaba: dependencia nueva, montarla sobre DOS listeners (el HTTP y  │
 * │ el HTTPS con mTLS del modo separado), y depender del proxy de `upgrade` del gateway.        │
 * │                                                                                            │
 * │ SSE+POST — que la propia spec ya define en D14 CON EL MISMO PROTOCOLO DE MENSAJES — no      │
 * │ paga nada de eso: son peticiones HTTP normales bajo `/api/v1`, así que atraviesan los tres  │
 * │ modos de despliegue (monolito, separado y detrás de gateway/nginx) por el MISMO camino que  │
 * │ ya está probado en producción con `/api/v1/notifications/stream`. Cero dependencias nuevas, │
 * │ cero bundle en el cliente (`EventSource` es nativo), y la autorización/CSRF son las mismas  │
 * │ que las del resto de la API en vez de un handshake aparte que hay que auditar por separado. │
 * │                                                                                            │
 * │ El precio, dicho claro: la subida cuesta un round-trip HTTP en vez de ir por el mismo       │
 * │ socket. Con la coalescencia del emisor (un frame por transacción, no por pulsación) eso son │
 * │ decenas de POST por minuto y editor — irrelevante. Si algún día se mide latencia de subida  │
 * │ inaceptable, el protocolo de mensajes NO cambia: solo se sustituye el par de rutas.         │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * MULTINODO. El gateway hace round-robin en cada petición: dos editores de la misma página caen en
 * réplicas distintas por construcción, y no hay afinidad de sesión. Se resuelve con el bus Redis
 * que ya existe (`core/cache.ts`), copiando el patrón EXACTO de `core/notifications.ts`: entrega
 * local primero, `publish` después con el payload etiquetado con `NODE_ID` para descartar el eco
 * propio. La BD compartida es el árbitro: toda op se persiste ANTES de difundirse, así que un
 * cliente que reconecta a OTRO nodo recupera por `resync` sin depender de la memoria de nadie.
 *
 * IDENTIDAD DE RÉPLICA (§2.1). El `siteId` que viaja en las ops NO es el que manda el cliente: el
 * cliente propone un NONCE y el servidor deriva de él la identidad real con
 * `HMAC(clave-del-sitio, "<userId>:<nonce>")`. Dos consecuencias, que son el motivo del cambio:
 *   · presentar el nonce de otro NO sirve de nada — el HMAC lleva dentro el `userId` de QUIEN pide,
 *     así que sale otra identidad. Emitir a nombre de otro es imposible aunque su `siteId` sea
 *     público (viaja en `members`, en `presence` y en cada op), y lo es en TODOS los nodos sin
 *     necesidad de coordinar nada, porque la derivación es pura;
 *   · es ESTABLE entre reconexiones (mismo usuario + mismo nonce ⇒ misma identidad), así que un
 *     corte de red no obliga a re-sembrar la réplica ni deja el `siteId` cautivo: la conexión nueva
 *     DESALOJA a la vieja, que por construcción es del mismo usuario.
 *
 * PERSISTENCIA Y REANUDACIÓN (§5). Dentro de un `epoch` la sala es: un `base` inmutable (el
 * `_puck_data` del post en el momento de abrirse) + el LOG de ops. Un cliente que llega tarde o que
 * reconecta reconstruye el estado igual que cualquier otro: `toCrdt(base)` + `applyAll(ops)`. Esto
 * funciona porque las posiciones SEMILLA que `toCrdt` deriva del snapshot son una función PURA del
 * snapshot — todas las réplicas que parten del mismo `base` obtienen las mismas posiciones sin
 * coordinarse. Por eso el `base` NO puede cambiar dentro de un epoch: reemplazarlo re-derivaría
 * semillas distintas de las que ya tienen los miembros vivos, que es divergencia garantizada.
 *
 * CICLO DE VIDA DE LA SALA (D19, corregido tras la revisión adversarial). Vaciarse NO purga: las
 * ediciones de la sesión que aún no se han guardado viven SOLO en el log, así que purgar al cerrar
 * la última pestaña es perder trabajo del usuario. Al quedarse vacía se anota el instante y empieza
 * la ventana de reanudación; se purga en dos casos, y los dos SUBEN EL EPOCH:
 *   · el barrido por antigüedad (`sweepIdleRooms`), cuando nadie ha vuelto en toda la ventana;
 *   · reabrir la sala con el `_puck_data` CAMBIADO por fuera (guardado clásico, importación,
 *     restauración de una revisión) y sin nadie dentro: ahí el snapshot rancio sería peor.
 * Subir el epoch en vez de borrar la fila es lo que hace que el contador sea MONÓTONO: un cliente
 * que sobrevivió a la purga ve un epoch distinto en el `welcome`, re-siembra y avisa. Borrar la
 * fila lo devolvía a 1 y la detección entera era código muerto.
 *
 * LIVENESS EN EL CLÚSTER. `rooms` es memoria de UN proceso: no basta para decidir si una sala está
 * viva. La señal compartida es `collab_members` (una fila por conexión, con latido). Toda decisión
 * destructiva pregunta a las DOS, y le basta con que UNA diga que hay alguien para no purgar:
 *   · el CINTURÓN LOCAL (`localMembers`) — este proceso sabe con certeza a quién está sirviendo, y
 *     esa certeza no depende de que la BD acepte escrituras. `ensureDoc` no lo tenía, y por eso una
 *     sala se podía retirar (epoch arriba, log borrado) con un editor DENTRO cuya fila de liveness
 *     había podado el barrido durante una caída de escrituras;
 *   · la SEÑAL DE CLÚSTER (`liveMembers`), que cubre a los editores de OTROS nodos y falla cerrado:
 *     si la consulta no se puede hacer, `null` ⇒ puede que haya gente ⇒ no se purga. Y "no se puede
 *     hacer" NO es "el driver lanzó": el driver de reserva devuelve `undefined`/`[]` en silencio, así
 *     que la ausencia de una respuesta utilizable cuenta igual que una excepción (`countOrNull`).
 * El latido es un UPSERT: una fila podada tiene que poder volver, o el editor queda invisible para
 * siempre. Conservar de más cuesta unas filas; conservar de menos cuesta el trabajo de quien está
 * escribiendo ahora mismo. Y si aun así se retira una sala con gente dentro, se les AVISA por su
 * stream (`room_reset`) en vez de dejarlos en `live` y mudos hasta que teclean.
 *
 * UN FALLO DE UNA SESIÓN NO PUEDE TUMBAR EL PROCESO. `res.write()` sobre una respuesta terminada no
 * lanza: emite `'error'` en el siguiente tick, fuera de toda cadena de promesas. Por eso el camino
 * de join fallido NO cierra la respuesta (la cierra la ruta, después de escribir el motivo) y la
 * ruta escribe siempre con guarda y con un `res.on('error')` puesto.
 *
 * QUIÉN ESCRIBE EL CONTENIDO CANÓNICO. El servidor NUNCA proyecta el estado CRDT (no ejecuta el
 * algoritmo, ver `collab-ops.ts`). El contenido lo sigue guardando el editor por la ruta de
 * siempre, `PUT /api/v1/posts/:id`, que ya pasa por `sanitize-meta`. La colaboración no abre una
 * segunda vía de escritura al post: solo reparte intenciones entre editores.
 */

import type { Response } from 'express';

const crypto = require('crypto');
const { dbAsync } = require('../config/database');
const cache = require('./cache');
const appConfig = require('../config/app');
const { validateFrame, sanitizeVersionVector, vvCovers, LIMITS } = require('./collab-ops');

/** Único por proceso — etiqueta los mensajes del bus para descartar el eco propio. */
const NODE_ID = crypto.randomBytes(8).toString('hex');

const CHANNEL = 'wordjs:collab';

const CONFIG = {
    /** Conexiones simultáneas de un mismo usuario sobre el MISMO post (pestañas). */
    MAX_CONNS_PER_USER_POST: 3,
    /** Conexiones simultáneas de un usuario en todo el servidor. */
    MAX_CONNS_PER_USER: 10,
    /** Conexiones colaborativas vivas en este proceso. */
    MAX_CONNS_TOTAL: 500,
    /** Ops aceptadas por segundo y conexión (ritmo SOSTENIDO del cubo de fichas). */
    MAX_OPS_PER_SEC: 50,
    /** Bytes de payload aceptados por segundo y conexión (ritmo SOSTENIDO). */
    MAX_BYTES_PER_SEC: 64 * 1024,
    /** Bytes de un solo frame. */
    MAX_FRAME_BYTES: 256 * 1024,
    /**
     * RÁFAGA del cubo de fichas. Es >= el frame máximo A PROPÓSITO: con una ráfaga menor que el
     * frame que el validador acepta habría una BANDA MUERTA — frames legítimos (duplicar una
     * sección, reescribir un titular largo: el puente emite un borrado y una inserción por carácter)
     * que pasan el validador, se sanean, y aun así son imposibles de aceptar. El cliente reenvía y
     * en tres intentos se queda sin sesión. El ritmo sostenido sigue frenando la avalancha.
     */
    OPS_BURST: LIMITS.OPS_PER_FRAME,
    BYTES_BURST: 256 * 1024,
    /** Actualizaciones de presencia por segundo y conexión. */
    MAX_PRESENCE_PER_SEC: 20,
    PRESENCE_BURST: 40,
    /** Coste en fichas de ops de UN `resync` (la ruta más cara del módulo: lee la sala entera). */
    RESYNC_OP_COST: 10,
    /** Desobediencias PROBADAS antes de cerrar la conexión (ver `rateGate`). */
    MAX_STRIKES: 3,
    /**
     * ÚNICA FUENTE DE LA ESPERA de todo el transporte. Viaja en `welcome.limits.rateRetryMs` y en
     * cada 429, y el cliente DERIVA de ella la suya: no hay ningún otro número de espera, ni aquí ni
     * en `client.ts`. Es también la ventana con la que `rateGate` decide si a un cliente se le puede
     * probar que ignoró una instrucción.
     */
    RATE_RETRY_MS: 900,
    /** Ops persistidas por epoch. Pasado el tope se sigue difundiendo pero NO se persiste. */
    MAX_OPS_PER_EPOCH: 5000,
    /** TTL de una entrada de presencia sin heartbeat. */
    PRESENCE_TTL_MS: 30_000,
    /** Ping de keepalive del SSE (los proxies cortan conexiones ociosas). */
    KEEPALIVE_MS: 15_000,
    /** Antigüedad máxima del latido de `collab_members` para contar como VIVO en el clúster. */
    MEMBER_TTL_MS: 60_000,
    /** Cada cuántos keepalives se vuelve a autorizar la conexión (4 × 15 s = 1 min). */
    REAUTH_EVERY_TICKS: 4,
    /** Comprobaciones de autorización NO CONCLUYENTES seguidas antes de cerrar por precaución. */
    MAX_AUTH_FAILURES: 3,
};

export type PresenceSel = {
    nodeId: string | null;
    field?: string;
    anchor?: string;
    focus?: string;
} | null;

export type PresenceEntry = {
    siteId: string;
    userId: number;
    name: string;
    color: string;
    sel: PresenceSel;
    at: number;
};

/** Devuelve `false` para denegar de forma explícita; lanzar = "no se ha podido comprobar". */
export type Revalidate = () => Promise<boolean>;

type Conn = {
    connId: string;
    postId: number;
    userId: number;
    /** Identidad de RÉPLICA derivada por el servidor. Nunca la cadena que mandó el cliente. */
    siteId: string;
    name: string;
    color: string;
    res: Response;
    keepalive: NodeJS.Timeout | null;
    ticks: number;
    opTokens: number;
    byteTokens: number;
    presenceTokens: number;
    lastRefill: number;
    /** Desobediencias PROBADAS (ver `rateGate`). No es "rechazos": un rechazo no prueba nada. */
    strikes: number;
    /**
     * INSTRUCCIÓN DE ESPERA VIGENTE, emitida por este servidor y con su reloj.
     *
     * `rateNotice` es su número de serie —monótono por conexión— y `rateRetryAt` el instante hasta el
     * que pidió esperar. Los dos viajan al cliente en el cuerpo del 429; `rateAck` es el número de
     * serie que el cliente DEVUELVE en el siguiente frame, y es la única prueba de que ya la conocía.
     */
    rateNotice: number;
    rateRetryAt: number;
    rateAck: number;
    authFailures: number;
    revalidate: Revalidate | null;
    closed: boolean;
    /** La baja ya se contabilizó. `closed` no vale: el cierre por ritmo no descuenta cupos. */
    left: boolean;
    /**
     * El `join` terminó. Hasta entonces la conexión OCUPA CUPO pero NO cuenta como "hay alguien
     * dentro": es el equivalente local del `seen_at = 0` de `collab_members`, y por el mismo motivo
     * —dos entradas simultáneas en una sala vacía se verían la una a la otra y ninguna re-sembraría.
     */
    ready: boolean;
};

type Room = {
    postId: number;
    conns: Map<string, Conn>;
    /** siteId → connId. Ata una identidad de réplica a UNA conexión (§2.1). */
    sites: Map<string, string>;
    presence: Map<string, PresenceEntry>;
};

const rooms = new Map<number, Room>();
/** userId → nº de conexiones colaborativas vivas en ESTE proceso. */
const perUser = new Map<number, number>();
let totalConns = 0;
let busReady = false;

/* ------------------------------------------------------------------------------------------- */
/* Identidad de réplica                                                                          */
/* ------------------------------------------------------------------------------------------- */

// Clave DERIVADA del secreto de firma, no el secreto en crudo: la misma en todos los nodos (todos
// validan los mismos JWT) y separada por dominio, para que este HMAC no sea un oráculo de aquel.
const SITE_KEY = crypto
    .createHash('sha256')
    .update(`wordjs:collab:site:${(appConfig.jwt && appConfig.jwt.secret) || ''}`)
    .digest();

const SITE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Identidad de réplica a partir del nonce del cliente. La forma es la misma que produce el núcleo
 * (`s_` + 16 chars base32) para que el resto del sistema no note el cambio.
 *
 * Lo que aporta: es una función del `userId` de QUIEN PIDE. Robar el nonce de un compañero (que es
 * público) no sirve para nada, porque el HMAC de otro usuario da otra identidad. Y es determinista,
 * así que sobrevive a una reconexión y no hace falta reservar nada en el clúster.
 */
function replicaId(userId: number, clientNonce: string): string {
    const mac = crypto.createHmac('sha256', SITE_KEY).update(`${Number(userId) || 0}:${String(clientNonce)}`).digest();
    let out = '';
    for (let i = 0; i < 16; i++) out += SITE_ALPHABET[mac[i] % 32];
    return `s_${out}`;
}

/* ------------------------------------------------------------------------------------------- */
/* Presencia: color determinista                                                                */
/* ------------------------------------------------------------------------------------------- */

// Paleta de 12 tonos con contraste suficiente sobre el fondo claro y el oscuro del admin. El color
// se DERIVA del userId (no se sortea) para que la misma persona salga del mismo color en todas las
// pantallas y en todas sus sesiones — si cambiara por conexión, el color dejaría de identificar.
const PRESENCE_COLORS = [
    '#e11d48', '#db2777', '#c026d3', '#7c3aed', '#4f46e5', '#2563eb',
    '#0891b2', '#059669', '#65a30d', '#ca8a04', '#ea580c', '#dc2626',
];

function colorForUser(userId: number): string {
    const n = Number(userId) || 0;
    return PRESENCE_COLORS[Math.abs(n) % PRESENCE_COLORS.length];
}

/* ------------------------------------------------------------------------------------------- */
/* Estado persistido de la sala                                                                  */
/* ------------------------------------------------------------------------------------------- */

export type DocState = { epoch: number; base: string; truncated: boolean };

function hashBase(base: string): string {
    return crypto.createHash('sha256').update(String(base || ''), 'utf8').digest('hex').slice(0, 32);
}

/**
 * `_puck_data` vigente del post, NORMALIZADO a una cadena no vacía. El '' está reservado como
 * centinela de "sala retirada, hay que re-sembrar", así que un post sin contenido se guarda como
 * `'{}'` — que es exactamente lo que el cliente deriva de una cadena vacía.
 */
async function readCanonicalBase(postId: number): Promise<string> {
    const Post = require('../models/Post');
    const raw = await Post.getMeta(postId, '_puck_data');
    const s = raw === null || raw === undefined ? '' : (typeof raw === 'string' ? raw : JSON.stringify(raw));
    return s.trim() === '' ? '{}' : s;
}

function docFromRow(row: any): DocState {
    return {
        epoch: Number(row.epoch) || 1,
        base: String(row.base_doc || ''),
        truncated: Number(row.truncated) === 1,
    };
}

/**
 * Devuelve (creándolo o re-sembrándolo si hace falta) el registro `collab_docs` del post.
 *
 * El `base` se congela aquí: es el `_puck_data` vigente en el instante de abrirse el epoch, y no
 * vuelve a cambiar mientras la sala tenga miembros (ver la cabecera: cambiarlo re-derivaría semillas
 * y divergiría). Con la sala VACÍA sí se comprueba contra el contenido canónico: si alguien guardó
 * por otra vía, servir el snapshot viejo le enseñaría al que entra un documento que ya no existe y
 * al guardar pisaría lo ajeno.
 *
 * @param reseed `false` desde `resync` — ahí quien pregunta ES un miembro vivo, así que la
 *               comprobación contra `_puck_data` no puede decidir nada y solo cuesta una lectura.
 * @param exceptConnId la conexión que está entrando: ya está en el mapa local y ya tiene su fila de
 *               liveness (ambas se reclaman ANTES de los `await` para que no puedan quedar
 *               huérfanas), pero no debe contarse a sí misma como "hay alguien dentro" o la sala no
 *               se re-sembraría nunca. Es el mismo motivo por el que entra con `ready = false` y
 *               `seen_at = 0`: quien está a mitad de entrar todavía no es un miembro vivo.
 */
async function ensureDoc(postId: number, reseed = true, exceptConnId?: string | null): Promise<DocState> {
    const row = await dbAsync.get(
        'SELECT epoch, base_doc, base_hash, truncated FROM collab_docs WHERE post_id = ?', [postId]);

    if (row && String(row.base_doc || '') !== '') {
        if (!reseed) return docFromRow(row);
        const canonical = await readCanonicalBase(postId);
        if (String(row.base_hash || '') === hashBase(canonical)) return docFromRow(row);

        // El contenido canónico se movió por fuera. Solo se re-siembra si la sala está VACÍA, y eso
        // se pregunta DOS VECES, igual que en el barrido:
        //
        //  1. CINTURÓN LOCAL. Si este proceso tiene conexiones vivas en la sala, no se retira, pase
        //     lo que pase con la señal compartida. `collab_members` puede quedarse en cero por
        //     causas ajenas al editor (la BD dejó de aceptar escrituras un rato y el barrido podó su
        //     fila), y decidir SOLO con ella retiraba la sala —epoch arriba y log borrado— con
        //     alguien DENTRO escribiendo. El barrido siempre tuvo este cinturón; aquí faltaba.
        //  2. SEÑAL DE CLÚSTER, que además falla cerrado (`null` ⇒ puede que haya gente).
        if (localMembers(postId, exceptConnId) > 0) return docFromRow(row);
        const live = await liveMembers(postId, exceptConnId);
        if (live === null || live > 0) return docFromRow(row);

        const outcome = await retireRoom(postId, {
            epoch: Number(row.epoch),
            baseHash: String(row.base_hash || ''),
            exceptConnId,
        });
        // Si la retirada FALLA no se puede servir el snapshot rancio con el epoch anterior: el que
        // entra vería un documento que ya no existe y al guardar pisaría lo que se guardó por fuera
        // (el hallazgo 12 por el camino de error). Se falla CERRADO y el join lo comunica.
        if (outcome === 'error') throw new Error(`no se pudo retirar la sala ${postId} para re-sembrarla`);
        // `noop` = otro join concurrente ya la retiró y re-sembró: abajo se relee su fila.
    }

    const base = await readCanonicalBase(postId);
    const hash = hashBase(base);
    const now = Date.now();

    if (row) {
        // Fila retirada (base_doc = ''): se re-siembra con el epoch YA subido por `retireRoom`. El
        // `WHERE base_doc = ''` hace que si dos joins concurrentes siembran, gane uno solo.
        await dbAsync.run(
            "UPDATE collab_docs SET base_doc = ?, base_hash = ?, ops_count = 0, truncated = 0, " +
            "updated_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE post_id = ? AND base_doc = ''",
            [base, hash, now, postId]
        );
        const again = await dbAsync.get(
            'SELECT epoch, base_doc, base_hash, truncated FROM collab_docs WHERE post_id = ?', [postId]);
        if (again) return docFromRow(again);
        // La fila existía hace dos consultas y ya no está. Devolver un estado inventado abriría una
        // sesión que `pushOps` va a rechazar con 409 en bucle: se falla cerrado.
        throw new Error(`la fila de collab_docs del post ${postId} desapareció durante la re-siembra`);
    }

    try {
        await dbAsync.run(
            'INSERT INTO collab_docs (post_id, epoch, base_doc, base_hash, ops_count, truncated, updated_ms) VALUES (?, ?, ?, ?, 0, 0, ?)',
            [postId, 1, base, hash, now]
        );
        return { epoch: 1, base, truncated: false };
    } catch (e: any) {
        // Carrera con otro nodo/petición que insertó primero: el suyo vale, releemos.
        const again = await dbAsync.get(
            'SELECT epoch, base_doc, base_hash, truncated FROM collab_docs WHERE post_id = ?', [postId]);
        if (again) return docFromRow(again);
        // No hay fila y no se ha podido crear. El `DocState` sintético que se devolvía aquí pintaba
        // una sesión VIVA (welcome con epoch 1) sobre un documento que no existe: `pushOps` no
        // encuentra fila y responde 409 `collab_epoch` a TODO, así que el editor entraba en un bucle
        // de «la sesión se reinició» sin poder enviar nada. Se falla cerrado.
        throw e;
    }
}

/**
 * Log de ops del epoch vigente, en el orden en que el servidor las aceptó. El `LIMIT` no es
 * decorativo: es el techo de lo que una sola petición puede cargar en el heap del proceso.
 *
 * `unreadable` cuenta las filas que están en la BD pero NO se pueden releer. Saltárselas en silencio
 * —que es lo que se hacía— no tumba la sala, pero convierte la reanudación en una mentira: el log
 * que se sirve ya no es el que se aceptó. Quien lo consuma tiene que decírselo al cliente.
 */
async function loadOps(postId: number, epoch: number): Promise<{ ops: any[]; bytes: number; unreadable: number }> {
    // Cuántas filas TIENE que traer la consulta. Se pregunta ANTES y no es redundante: `dbAsync.all`
    // devuelve `[]` cuando el driver de reserva no puede leer (ver `countOrNull`), y un `[]` de fallo
    // es indistinguible de un log vacío. Sin este contraste, un log de miles de ops que no se puede
    // releer se servía como «vacío y COMPLETO» — `welcome.truncated: false` — y el cliente daba por
    // recuperado un histórico del que no había leído ni una fila.
    const total = await countOrNull(
        'SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ? AND epoch = ?', [postId, epoch]);
    const rows = await dbAsync.all(
        'SELECT payload FROM collab_ops WHERE post_id = ? AND epoch = ? ORDER BY id ASC LIMIT ?',
        [postId, epoch, CONFIG.MAX_OPS_PER_EPOCH]
    );
    const traidas: any[] = Array.isArray(rows) ? rows : [];
    const ops: any[] = [];
    let bytes = 0;
    let unreadable = 0;
    for (const r of traidas) {
        // Los bytes se cuentan sobre el texto que ya viene de la BD: sirven para cobrar el coste de
        // un `resync` sin volver a serializar la respuesta entera solo para medirla.
        bytes += Buffer.byteLength(String(r.payload || ''), 'utf8');
        try { ops.push(JSON.parse(r.payload)); } catch { unreadable++; }
    }

    if (total === null) {
        // Ni siquiera se sabe cuántas había: no se puede afirmar que el log servido sea el aceptado.
        unreadable++;
        console.warn(`[collab] sala ${postId}: no se pudo contar el log; la sesión NO es reanudable`);
    } else {
        const esperadas = Math.min(total, CONFIG.MAX_OPS_PER_EPOCH);
        const faltan = Math.max(0, esperadas - traidas.length);
        if (faltan > 0) {
            unreadable += faltan;
            console.warn(`[collab] sala ${postId}: ${faltan} fila(s) del log no llegaron a leerse`);
        }
    }

    if (unreadable) console.warn(`[collab] sala ${postId}: ${unreadable} fila(s) del log ilegibles o no leídas`);
    return { ops, bytes, unreadable };
}

async function opsCount(postId: number, epoch: number): Promise<number> {
    const r = await dbAsync.get('SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ? AND epoch = ?', [postId, epoch]);
    return Number(r?.c) || 0;
}

/**
 * `SELECT COUNT(*)` que distingue CERO de NO SÉ.
 *
 * «Falla cerrado» era una propiedad del DRIVER, no de este código. `sqlite-native` LANZA cuando la
 * consulta no se puede hacer, y el `catch` devolvía `null` — correcto. Pero `sqlite-legacy` —el
 * fallback AUTOMÁTICO que `config/database.ts` documenta para cuando el binario nativo no carga— NO
 * LANZA: loguea el error y devuelve `undefined` desde `get` y `[]` desde `all`. Ahí
 * `Number(undefined?.c) || 0` daba **0**, que es exactamente la señal de «no hay nadie ⇒ purga».
 * Con `collab_members` inaccesible (una 0013 a medias, una imagen corrupta) el barrido borraba el
 * log y subía el epoch de salas CON GENTE DENTRO — y los desprotegidos eran justo los editores de
 * OTROS nodos, que son para quienes la señal de clúster existe.
 *
 * Una agregación SIEMPRE devuelve fila: si no viene una utilizable, la consulta falló. La ausencia
 * de respuesta no es prueba de que no haya nadie.
 */
async function countOrNull(sql: string, params: any[]): Promise<number | null> {
    let row: any;
    try {
        row = await dbAsync.get(sql, params);
    } catch (e: any) {
        console.warn('[collab] recuento fallido:', e && e.message);
        return null;
    }
    if (!row || row.c === null || row.c === undefined) {
        // El driver no lanzó, pero tampoco contestó. Es el mismo caso, no un cero.
        console.warn('[collab] recuento sin fila utilizable: se trata como "no se sabe", no como cero');
        return null;
    }
    const n = Number(row.c);
    return Number.isFinite(n) ? n : null;
}

/**
 * Miembros VIVOS de la sala en todo el clúster (no solo en este proceso).
 *
 * Devuelve `null` cuando NO SE HA PODIDO SABER. Quien decide purgar tiene que tratar ese `null`
 * como "puede que haya gente": una consulta fallida no es permiso para borrar la sesión de nadie.
 * El fallo cerrado NO puede depender de que el driver lance — ver `countOrNull`.
 *
 * @param incluirEntrantes cuenta también a quien está A MITAD DE ENTRAR (`seen_at` negativo). Los dos
 *   usos de esta señal quieren cosas DISTINTAS y por eso es un parámetro y no una constante:
 *     · `ensureDoc` decide si RE-SEMBRAR, y ahí un entrante NO puede contar — si contara, dos joins
 *       simultáneos se verían el uno al otro y ninguno re-sembraría (el hallazgo 12);
 *     · el BARRIDO decide si RETIRAR, que es destructivo, y ahí un entrante SÍ cuenta: retirar la
 *       sala por debajo de alguien que está entrando le borra el log que acaba de leer.
 */
async function liveMembers(
    postId: number,
    exceptConnId?: string | null,
    incluirEntrantes = false,
): Promise<number | null> {
    const since = Date.now() - CONFIG.MEMBER_TTL_MS;
    const edad = incluirEntrantes ? 'ABS(seen_at)' : 'seen_at';
    return exceptConnId
        ? countOrNull(
            `SELECT COUNT(*) AS c FROM collab_members WHERE post_id = ? AND ${edad} > ? AND conn_id <> ?`,
            [postId, since, exceptConnId])
        : countOrNull(
            `SELECT COUNT(*) AS c FROM collab_members WHERE post_id = ? AND ${edad} > ?`,
            [postId, since]);
}

/** Miembros vivos de la sala EN ESTE PROCESO. Cinturón local de las decisiones destructivas. */
function localMembers(postId: number, exceptConnId?: string | null): number {
    const room = rooms.get(postId);
    if (!room) return 0;
    let n = 0;
    for (const c of room.conns.values()) if (c.ready && !c.closed && c.connId !== exceptConnId) n++;
    return n;
}

/**
 * Reserva la fila de liveness de una conexión que está ENTRANDO.
 *
 * `seen_at` NEGATIVO a propósito, y el signo es el arreglo de una carrera. La fila tiene que existir
 * (así el `leave` de un cliente que aborta a mitad tiene qué borrar y nada queda huérfano) pero NO
 * puede contar como miembro vivo hasta que el join termina: sin ese matiz, dos entradas simultáneas
 * en una sala vacía se veían la una a la otra como «hay alguien dentro» y NINGUNA re-sembraba — las
 * dos abrían con el snapshot rancio, que es el hallazgo 12 otra vez.
 *
 * Se marcaba con `seen_at = 0`, y ahí estaba el problema: para la PODA del barrido, un 0 es la marca
 * de tiempo más vieja posible, así que una conexión a mitad de entrar en el nodo A era indistinguible
 * de la fila de un nodo que murió hace horas. El barrido del nodo B la borraba y retiraba la sala —
 * epoch arriba y log fuera— con A ya dentro. Guardando `-now` la fila sigue sin contar como viva
 * (toda comparación de liveness es `seen_at > algo positivo`) pero LLEVA SU EDAD, así que la poda
 * puede distinguir «entrando ahora» de «lleva horas colgada» mirando el valor absoluto.
 */
async function claimMember(conn: Conn): Promise<void> {
    await dbAsync.run(
        'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        [conn.connId, conn.postId, conn.siteId, conn.userId, NODE_ID, -Date.now()]
    );
}

/**
 * Latido de liveness. Es un UPSERT, y eso NO es una optimización: siendo solo `UPDATE`, una fila
 * podada por el barrido (porque la BD estuvo un rato sin aceptar escrituras y el `seen_at` se quedó
 * viejo) no volvía JAMÁS — el `changes = 0` no lo miraba nadie. El editor seguía conectado y
 * escribiendo, pero era INVISIBLE para todo el clúster, así que la siguiente decisión destructiva
 * borraba su log sin verlo. Aquí se re-clama la fila si el UPDATE no tocó ninguna.
 */
async function touchMember(conn: Conn): Promise<void> {
    try {
        const r = await dbAsync.run('UPDATE collab_members SET seen_at = ? WHERE conn_id = ?', [Date.now(), conn.connId]);
        if (Number(r && r.changes) > 0) return;
        try {
            await dbAsync.run(
                'INSERT INTO collab_members (conn_id, post_id, site_id, user_id, node_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
                [conn.connId, conn.postId, conn.siteId, conn.userId, NODE_ID, Date.now()]
            );
        } catch {
            // Otro camino la insertó entre el UPDATE y el INSERT: el UPDATE de rescate cierra el caso.
            await dbAsync.run('UPDATE collab_members SET seen_at = ? WHERE conn_id = ?', [Date.now(), conn.connId]);
        }
    } catch (e: any) {
        console.warn('[collab] latido de miembro fallido:', e && e.message);
    }
}

async function releaseMember(connId: string): Promise<void> {
    try {
        await dbAsync.run('DELETE FROM collab_members WHERE conn_id = ?', [connId]);
    } catch (e: any) {
        console.warn('[collab] no se pudo dar de baja al miembro:', e && e.message);
    }
}

/** Marca el instante en que la sala se quedó vacía: ahí empieza la ventana de reanudación. */
async function touchDoc(postId: number): Promise<void> {
    try {
        await dbAsync.run(
            'UPDATE collab_docs SET updated_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE post_id = ?',
            [Date.now(), postId]);
    } catch (e: any) {
        console.warn('[collab] no se pudo sellar la sala', postId, e && e.message);
    }
}

/**
 * Retirada del estado de SESIÓN de una sala: se purgan las ops y SUBE EL EPOCH.
 *
 * La fila de `collab_docs` NO se borra, y esa es la corrección clave: borrarla hacía que el epoch
 * renaciera en 1 al reabrir, de modo que un cliente superviviente veía «misma generación», se
 * quedaba con su réplica vieja y emitía ops contra posiciones semilla que ya no existían para
 * nadie. Conservando la fila el contador es MONÓTONO por post, el `welcome` llega con un epoch
 * distinto y el cliente re-siembra avisando en vez de divergir en silencio.
 *
 * REGLA DURA (§5.5): esto NO escribe contenido. El contenido canónico ya lo escribió el editor por
 * `PUT /posts/:id`. El `base` del epoch siguiente se vuelve a leer del `_puck_data` vigente cuando
 * alguien reabra, así que lo que se tira es la sesión, nunca el post.
 */
export type RetireOutcome = 'retired' | 'noop' | 'error';

async function retireRoom(
    postId: number,
    expect?: { epoch?: number; baseHash?: string | null; exceptConnId?: string | null },
): Promise<RetireOutcome> {
    try {
        const row = await dbAsync.get('SELECT epoch, base_doc, base_hash FROM collab_docs WHERE post_id = ?', [postId]);
        if (!row) return 'noop';
        if (String(row.base_doc || '') === '') return 'noop'; // ya estaba retirada: no se sube el epoch dos veces

        // GUARDA DE CARRERA. Quien pide la retirada tomó su decisión leyendo una fila concreta; si
        // esa fila se movió mientras tanto (otro join concurrente ya retiró y re-sembró), retirar
        // otra vez subiría el epoch por SEGUNDA vez y borraría el log del epoch recién abierto. Eso
        // no es un error: es que el trabajo ya está hecho.
        if (expect) {
            if (expect.epoch !== undefined && Number(row.epoch) !== Number(expect.epoch)) return 'noop';
            if (expect.baseHash !== undefined && String(row.base_hash || '') !== String(expect.baseHash || '')) return 'noop';
        }

        await dbAsync.run('DELETE FROM collab_ops WHERE post_id = ?', [postId]);
        await dbAsync.run(
            "UPDATE collab_docs SET epoch = epoch + 1, base_doc = '', base_hash = NULL, ops_count = 0, " +
            'truncated = 0, updated_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE post_id = ?',
            [Date.now(), postId]
        );
        await announceReset(postId, expect && expect.exceptConnId);
        return 'retired';
    } catch (e: any) {
        console.warn('[collab] no se pudo retirar la sala', postId, e && e.message);
        return 'error';
    }
}

/**
 * Avisa por el stream de que la sala se ha reiniciado.
 *
 * Las dos guardas de `ensureDoc` y del barrido hacen improbable retirar una sala con gente dentro,
 * pero improbable no es imposible (un nodo con el reloj corrido, una fila de liveness que se perdió
 * justo antes del latido). Sin este aviso, el superviviente se queda en `live` y MUDO: su stream
 * sigue sano, así que no se entera hasta que teclea y le devuelven un 409. Con él, su cliente
 * re-siembra desde el snapshot nuevo contando cuántos cambios suyos no llegaron a enviarse.
 *
 * `exceptConnId` es la conexión que está ENTRANDO y provocó la re-siembra: a ella no se le avisa de
 * nada porque su `welcome` ya trae el estado nuevo.
 */
async function announceReset(postId: number, exceptConnId?: string | null): Promise<boolean> {
    const room = rooms.get(postId);
    const exceptSite = exceptConnId ? (room && room.conns.get(exceptConnId)?.siteId) || null : null;
    const entregado = await broadcast(postId, 'warning', {
        code: 'room_reset',
        message: 'La sesión colaborativa se reinició con el contenido guardado. Revisa el documento antes de seguir.',
    }, exceptSite);
    if (!entregado) {
        // El superviviente que este aviso venía a rescatar está, por definición, en OTRO nodo: si el
        // bus no lo lleva, vuelve exactamente al «live y mudo» que esto cierra. `cache.publish`
        // devuelve `false` sin lanzar, así que sin esta línea la pérdida es INVISIBLE — ni un log.
        // No se puede reintentar (el epoch ya subió), pero sí se puede dejar de ser silenciosa.
        console.error(
            `[collab] sala ${postId}: el aviso de reinicio NO cruzó el bus. ` +
            'Los editores de otros nodos pueden haberse quedado en «live» y mudos: revisa Redis.');
    }
    return entregado;
}

/* ------------------------------------------------------------------------------------------- */
/* Entrega                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/**
 * Un socket muerto NO hace lanzar a `res.write()`: devuelve `false` en silencio. Fiarse del throw
 * dejaba conexiones fantasma vivas para siempre (con su temporizador y su cupo), así que el estado
 * del socket se mira explícitamente.
 */
function socketDead(conn: Conn): boolean {
    const res = conn.res as any;
    return !!(res && (res.destroyed || res.writableEnded || res.writable === false));
}

function writeEvent(conn: Conn, event: string, data: any): boolean {
    if (conn.closed) return false;
    if (socketDead(conn)) { void leave(conn); return false; }
    try {
        conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch {
        void leave(conn);
        return false;
    }
}

/** Entrega a las conexiones de ESTE proceso. `exceptSite` evita devolverle al emisor su propio eco. */
function deliverLocal(postId: number, event: string, data: any, exceptSite?: string | null): void {
    const room = rooms.get(postId);
    if (!room) return;
    for (const conn of [...room.conns.values()]) {
        if (exceptSite && conn.siteId === exceptSite) continue;
        writeEvent(conn, event, data);
    }
}

/**
 * Entrega local PRIMERO y publicación en el bus DESPUÉS, con el `NODE_ID` como etiqueta — patrón
 * copiado de `core/notifications.ts`: nunca se depende del round-trip del bus para la entrega
 * local (el subscriber puede estar re-suscribiéndose, y un publish con 0 receptores "va bien").
 */
/**
 * @returns `false` si el tramo de CLÚSTER no se pudo entregar. `cache.publish` devuelve `false` y no
 * lanza cuando Redis está caído, así que ignorar el resultado convierte "esto no llegó a los otros
 * nodos" en silencio absoluto. Para la mayoría de eventos eso se recupera solo (el `resync` del
 * cliente cierra el hueco); para el aviso de RETIRADA no, y por eso `announceReset` lo mira.
 */
async function broadcast(postId: number, event: string, data: any, exceptSite?: string | null): Promise<boolean> {
    deliverLocal(postId, event, data, exceptSite);
    if (!cache.pubsubAvailable()) return true;   // monolito: no hay tramo de clúster que fallar
    return (await cache.publish(CHANNEL, { o: NODE_ID, p: postId, e: event, d: data, x: exceptSite || null })) !== false;
}

/** Suscribe este proceso al bus de salas. Llamar una vez al arranque. No-op sin Redis. */
function initClusterBus(): void {
    if (busReady) return;
    busReady = true;
    cache.subscribe(CHANNEL, (msg: string) => {
        try {
            const parsed = JSON.parse(msg);
            if (!parsed || parsed.o === NODE_ID) return; // eco propio: ya entregado localmente
            deliverLocal(Number(parsed.p), String(parsed.e), parsed.d, parsed.x || null);
        } catch (e: any) {
            console.warn('[collab] bus parse error:', e && e.message);
        }
    });
}

/* ------------------------------------------------------------------------------------------- */
/* Ciclo de vida de una conexión                                                                 */
/* ------------------------------------------------------------------------------------------- */

export type JoinRefusal = 'too-many-tabs' | 'too-many-connections' | 'server-full' | 'server-error';

export type JoinResult =
    | { ok: true; conn: Conn; epoch: number; base: string; ops: any[]; members: PresenceEntry[]; truncated: boolean }
    | { ok: false; refusal: JoinRefusal };

let connSeq = 0;

async function join(params: {
    res: Response;
    postId: number;
    userId: number;
    /** NONCE del cliente. La identidad real la deriva el servidor (ver `replicaId`). */
    siteId: string;
    name: string;
    revalidate?: Revalidate | null;
}): Promise<JoinResult> {
    const { res, postId, userId } = params;
    const siteId = replicaId(userId, params.siteId);

    if (totalConns >= CONFIG.MAX_CONNS_TOTAL) return { ok: false, refusal: 'server-full' };
    if ((perUser.get(userId) || 0) >= CONFIG.MAX_CONNS_PER_USER) return { ok: false, refusal: 'too-many-connections' };

    let room = rooms.get(postId);
    if (!room) rooms.set(postId, (room = { postId, conns: new Map(), sites: new Map(), presence: new Map() }));

    // Esta réplica ya tenía conexión: por construcción es del MISMO usuario (el HMAC lleva dentro su
    // id), así que reconectar DESALOJA a la vieja en vez de rechazar. Rechazar dejaba al editor
    // mudo tras un parpadeo de red hasta recargar la página, con la conexión zombi contando cupo.
    const prevConnId = room.sites.get(siteId) || null;

    let sameUserHere = 0;
    for (const c of room.conns.values()) if (c.userId === userId && c.connId !== prevConnId) sameUserHere++;
    if (sameUserHere >= CONFIG.MAX_CONNS_PER_USER_POST) return { ok: false, refusal: 'too-many-tabs' };

    const now = Date.now();
    const conn: Conn = {
        connId: `c${++connSeq}_${NODE_ID}`,
        postId, userId, siteId,
        // Solo el nombre PÚBLICO. Nunca el email: la presencia la ve todo el que edita el post.
        name: String(params.name || `usuario ${userId}`).slice(0, 80),
        color: colorForUser(userId),
        res,
        keepalive: null,
        ticks: 0,
        opTokens: CONFIG.OPS_BURST,
        byteTokens: CONFIG.BYTES_BURST,
        presenceTokens: CONFIG.PRESENCE_BURST,
        lastRefill: now,
        strikes: 0,
        rateNotice: 0,
        rateRetryAt: 0,
        rateAck: 0,
        authFailures: 0,
        revalidate: params.revalidate || null,
        closed: false,
        left: false,
        ready: false,
    };

    // ALTA SÍNCRONA, ANTES de cualquier `await`. Con el alta después de las consultas había una
    // ventana en la que dos joins veían el mismo hueco (TOCTOU) y en la que un cliente que abortaba
    // dejaba la conexión contabilizada para siempre.
    room.conns.set(conn.connId, conn);
    room.sites.set(siteId, conn.connId);
    perUser.set(userId, (perUser.get(userId) || 0) + 1);
    totalConns++;
    startKeepalive(conn);

    if (prevConnId) {
        const prev = room.conns.get(prevConnId);
        if (prev) await leave(prev); // la sala ya no puede quedarse vacía: la nueva conn está dentro
    }

    let doc: DocState;
    let ops: any[];
    let unreadable: number;
    try {
        // La liveness de clúster se reclama ANTES que nada: si se hiciera al final, un cliente que
        // aborta dentro de la ventana dejaría el DELETE de `leave` corriendo antes que el INSERT y
        // la fila quedaría huérfana. Entra con `seen_at = 0` (ver `claimMember`).
        await claimMember(conn);
        doc = await ensureDoc(postId, true, conn.connId);
        const log = await loadOps(postId, doc.epoch);
        ops = log.ops;
        unreadable = log.unreadable;
        // Join terminado: AHORA cuenta como miembro vivo, aquí y para el resto del clúster.
        conn.ready = true;
        await touchMember(conn);
    } catch (e: any) {
        console.warn('[collab] join fallido:', e && e.message);
        // `closeSocket: false` a propósito: la respuesta la cierra la RUTA, después de escribir el
        // evento de error. Terminarla aquí dejaba a la ruta escribiendo sobre un stream ya cerrado,
        // y ese `ERR_STREAM_WRITE_AFTER_END` no lo veía ningún `catch` — salía por `nextTick` y
        // acababa en el `uncaughtException` del arranque, que hace `process.exit(1)`.
        await leave(conn, { closeSocket: false });
        return { ok: false, refusal: 'server-error' };
    }

    // La sala ya no acepta más ops en el log —o el log ya no se puede releer entero: se dice ANTES
    // de empezar, no cuando se pierdan. Una fila ilegible es una sesión NO reanudable, y el cliente
    // tiene que enterarse igual que si el log estuviera lleno.
    const truncated = doc.truncated || ops.length >= CONFIG.MAX_OPS_PER_EPOCH || unreadable > 0;

    // Los demás, sin nosotros: nuestra conexión ya está `ready` y si no se excluyera nos veríamos a
    // nosotros mismos en la lista de compañeros.
    const members = livePresence(room, conn.siteId);
    // Alta en presencia SIN selección: el hecho de estar es ya información útil para los demás.
    const entry: PresenceEntry = { siteId, userId, name: conn.name, color: conn.color, sel: null, at: Date.now() };
    room.presence.set(siteId, entry);
    await broadcast(postId, 'members', { joined: entry }, siteId);

    return { ok: true, conn, epoch: doc.epoch, base: doc.base, ops, members, truncated };
}

/**
 * Keepalive: ping contra los proxies, LATIDO de liveness para el clúster, SEGADOR de sockets
 * muertos y RE-AUTORIZACIÓN periódica.
 *
 * Lo último no es un extra: `gate()` corre una sola vez, en el handshake, y el stream vive
 * indefinidamente. Sin volver a comprobar, un cierre de sesión, un cambio de contraseña, la
 * caducidad del JWT o una bajada de rol NO cortan la entrega en vivo del borrador — que es
 * exactamente lo que esos mecanismos existen para cortar.
 */
function startKeepalive(conn: Conn): void {
    conn.keepalive = setInterval(() => {
        if (conn.closed) return;
        if (socketDead(conn)) { void leave(conn); return; }
        try { conn.res.write(': keepalive\n\n'); } catch { void leave(conn); return; }

        conn.ticks++;
        void touchMember(conn);
        if (conn.revalidate && conn.ticks % CONFIG.REAUTH_EVERY_TICKS === 0) void reauthorize(conn);
    }, CONFIG.KEEPALIVE_MS);
    if (typeof conn.keepalive.unref === 'function') conn.keepalive.unref();
}

async function reauthorize(conn: Conn): Promise<void> {
    let allowed: boolean;
    try {
        allowed = await conn.revalidate!();
    } catch (e: any) {
        // NO CONCLUYENTE (BD caída, etc.). Cerrar por un parpadeo echaría a todo el mundo; ignorarlo
        // para siempre sería no comprobar nada. Se tolera un rato acotado y luego se cierra.
        conn.authFailures++;
        if (conn.authFailures < CONFIG.MAX_AUTH_FAILURES) return;
        console.warn('[collab] re-autorización no concluyente repetida, se cierra la sesión:', e && e.message);
        allowed = false;
    }
    if (allowed) { conn.authFailures = 0; return; }
    if (conn.closed) return;
    writeEvent(conn, 'error', { code: 'unauthorized', message: 'Tu sesión ya no puede editar este contenido.' });
    await leave(conn);
}

/**
 * QUIÉN ESTÁ EN LA SALA. Sale de las CONEXIONES VIVAS, no del mapa de presencia.
 *
 * La presencia es efímera a propósito: se llena con los POST de `/presence` y caduca por TTL, porque
 * lo que describe es DÓNDE tiene cada uno el cursor, que envejece. Derivar de ahí la PERTENENCIA
 * mezclaba dos cosas distintas y se notaba al recargar una pestaña: quien entraba veía «no hay nadie
 * más» aunque hubiera gente conectada, hasta que alguna de esas personas moviera el cursor y su
 * entrada renaciera. Con dos personas quietas, cada una creía estar sola en el documento.
 *
 * Estar conectado es el hecho; la selección es un adorno que puede faltar. Los que están a mitad de
 * entrar (`ready === false`) NO cuentan, por el mismo motivo que en `collab_members`: dos entradas
 * simultáneas en una sala vacía se verían la una a la otra y ninguna re-sembraría.
 */
function livePresence(room: Room, exceptSite?: string | null): PresenceEntry[] {
    const now = Date.now();
    // Las entradas efímeras caducadas se siguen podando aquí: es el único recorrido periódico del
    // mapa, y sin él las selecciones de quien ya se fue se quedarían ocupando memoria.
    for (const [site, p] of room.presence) {
        if (now - p.at > CONFIG.PRESENCE_TTL_MS) room.presence.delete(site);
    }

    const out: PresenceEntry[] = [];
    for (const conn of room.conns.values()) {
        if (!conn.ready || conn.closed || conn.left) continue;
        if (exceptSite && conn.siteId === exceptSite) continue;
        const sel = room.presence.get(conn.siteId);
        out.push({
            siteId: conn.siteId,
            userId: conn.userId,
            name: conn.name,
            color: conn.color,
            sel: sel ? sel.sel : null,
            at: sel ? sel.at : now,
        });
    }
    return out;
}

/**
 * `endSocket = false` deja la respuesta ABIERTA para que la ruta pueda escribir todavía el motivo y
 * cerrarla ella. Lo usa el camino de join fallido: cerrar aquí y escribir allí es exactamente lo que
 * producía el `write after end` que se comía el proceso entero.
 */
function closeConn(conn: Conn, _reason: string, endSocket = true): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.keepalive) clearInterval(conn.keepalive);
    conn.keepalive = null;
    if (!endSocket) return;
    try { conn.res.end(); } catch { /* ya cerrada por el cliente */ }
}

/**
 * Baja de una conexión. IDEMPOTENTE por `conn.left`: hay dos invocadores (el `close` del socket y el
 * `POST /leave`) y el primero DISPARA al segundo — el `res.end()` de uno hace emitir `close` al
 * otro. Sin la guarda, la segunda pasada descontaba otra vez `perUser`/`totalConns` y los topes de
 * admisión leían ceros con conexiones vivas dentro.
 *
 * Vaciarse NO purga (ver la cabecera): solo se sella el instante para que empiece a correr la
 * ventana de reanudación. La purga la deciden `sweepIdleRooms` o la re-siembra de `ensureDoc`, y
 * ambas suben el epoch.
 */
async function leave(conn: Conn, opts?: { closeSocket?: boolean }): Promise<void> {
    if (conn.left) return;
    conn.left = true;

    const room = rooms.get(conn.postId);
    closeConn(conn, 'leave', opts?.closeSocket !== false);

    const n = (perUser.get(conn.userId) || 1) - 1;
    if (n <= 0) perUser.delete(conn.userId); else perUser.set(conn.userId, n);
    totalConns = Math.max(0, totalConns - 1);

    await releaseMember(conn.connId);

    if (!room) return;
    room.conns.delete(conn.connId);
    if (room.sites.get(conn.siteId) === conn.connId) room.sites.delete(conn.siteId);
    room.presence.delete(conn.siteId);

    await broadcast(conn.postId, 'members', { left: { siteId: conn.siteId, userId: conn.userId } }, conn.siteId);

    if (room.conns.size === 0 && rooms.get(conn.postId) === room) {
        rooms.delete(conn.postId);
        await touchDoc(conn.postId);
    }
}

/**
 * Barrido de salas que ya nadie usa. Se retira por ANTIGÜEDAD del último cambio y solo si NADIE
 * está dentro EN TODO EL CLÚSTER.
 *
 * Las dos trampas que este barrido tenía, y por qué el código es como es:
 *  · la liveness se miraba en el `Map` de ESTE proceso, así que el nodo que barre borraba el estado
 *    de salas que otro nodo servía en vivo. Ahora la señal es `collab_members`, y si no se puede
 *    leer NO SE PURGA;
 *  · la antigüedad salía de `Date.parse('YYYY-MM-DD HH:MM:SS')`, que V8 interpreta como hora LOCAL
 *    sobre un valor que la BD escribe en UTC: al este de UTC una fila recién tocada parecía vieja y
 *    se retiraba, y un parse fallido daba 0, que también retiraba. Ahora se compara un entero de
 *    milisegundos, que no tiene zona; y un valor ilegible (0) NO autoriza a purgar.
 */
async function sweepIdleRooms(maxAgeMs = 60 * 60 * 1000): Promise<number> {
    let retired = 0;
    try {
        const now = Date.now();
        const cutoff = now - maxAgeMs;

        // Miembros de nodos que murieron sin cerrar: caducan muy por encima del TTL de liveness.
        // `ABS` y no `seen_at` a secas: quien está a mitad de entrar guarda `-now` (ver
        // `claimMember`), y con la comparación directa su fila —recién creada— parecía la más vieja
        // de todas y se podaba. El barrido de OTRO nodo retiraba entonces la sala con esa conexión ya
        // dentro. Con el valor absoluto se compara la EDAD, que es lo que aquí importa.
        try {
            await dbAsync.run('DELETE FROM collab_members WHERE ABS(seen_at) < ?', [now - CONFIG.MEMBER_TTL_MS * 4]);
        } catch (e: any) {
            console.warn('[collab] no se pudo podar collab_members:', e && e.message);
        }

        const rows = await dbAsync.all("SELECT post_id, updated_ms FROM collab_docs WHERE base_doc <> ''");
        for (const r of rows || []) {
            const postId = Number(r.post_id);
            if (rooms.has(postId)) continue;                       // viva en ESTE nodo
            const ms = Number(r.updated_ms) || 0;
            if (!ms) {
                console.warn(`[collab] sala ${postId} sin marca de tiempo legible: no se retira`);
                continue;
            }
            if (ms > cutoff) continue;
            // `true`: aquí SÍ cuentan los que están a mitad de entrar. Retirar es destructivo y una
            // conexión que ya leyó el log en otro nodo no puede quedarse sin él por llegar tarde.
            const live = await liveMembers(postId, null, true);
            if (live === null || live > 0) continue;               // viva en otro nodo, o no se sabe
            if (await retireRoom(postId) === 'retired') retired++;
        }
    } catch (e: any) {
        console.warn('[collab] barrido fallido:', e && e.message);
    }
    return retired;
}

/* ------------------------------------------------------------------------------------------- */
/* Límites de ritmo                                                                              */
/* ------------------------------------------------------------------------------------------- */

/** La instrucción que acompaña SIEMPRE a un rechazo por ritmo: cuánto esperar y con qué nº de serie. */
export type RateInstruction = { retryAfterMs: number; notice: number };

type RateVerdict =
    | { ok: true }
    | { ok: false; code: 'rate' | 'closed' | 'too-large'; message: string; rate?: RateInstruction };

function refill(conn: Conn, now: number): void {
    const dt = Math.max(0, now - conn.lastRefill) / 1000;
    if (dt <= 0) return;
    conn.lastRefill = now;
    conn.opTokens = Math.min(CONFIG.OPS_BURST, conn.opTokens + dt * CONFIG.MAX_OPS_PER_SEC);
    conn.byteTokens = Math.min(CONFIG.BYTES_BURST, conn.byteTokens + dt * CONFIG.MAX_BYTES_PER_SEC);
    conn.presenceTokens = Math.min(CONFIG.PRESENCE_BURST, conn.presenceTokens + dt * CONFIG.MAX_PRESENCE_PER_SEC);
}

/**
 * EL ÚNICO SITIO DEL SERVIDOR QUE PUEDE RECHAZAR POR RITMO Y EL ÚNICO QUE PUEDE CERRAR POR RITMO.
 *
 * Aquí vive el invariante del que cuelga todo el transporte:
 *
 *     UN CLIENTE QUE RESPETA LA ESPERA QUE EL SERVIDOR LE PIDE NUNCA PUEDE SER EXPULSADO.
 *
 * Tres rondas de arreglos lo dieron por cerrado y tres veces reapareció en otro sitio (el camino de
 * ops, el de presencia, el planificador del cliente) porque se parcheaba el SÍNTOMA —dónde ocurría la
 * expulsión— en vez de la razón por la que era POSIBLE. La razón era ésta: la regla decía «un frame
 * que llega dentro de la ventana = el cliente ignoró la espera», y eso ES FALSO EN CUANTO HAY RED.
 * Un frame que ya iba por el cable cuando el servidor emitió la instrucción llega dentro de la
 * ventana sin que su emisor pudiera saber nada, y el servidor lo castigaba igual. Con RTT de 120 ms y
 * tres canales a la vez (ops, presencia, resync) eso son tres strikes de un cliente impecable. No hay
 * arreglo posible en el cliente: no se puede desconvocar un paquete ya enviado.
 *
 * Así que la expulsión pasa a exigir PRUEBA, y la prueba la firma el propio cliente:
 *
 *   · cada rechazo emite una INSTRUCCIÓN `{retryAfterMs, notice}` — `notice` es un número de serie
 *     monótono por conexión y `rateRetryAt` su plazo, medido con el RELOJ DEL SERVIDOR;
 *   · el cliente devuelve en cada frame el último `notice` que ha VISTO (`conn.rateAck`);
 *   · solo es desobediencia un frame que llega con `rateAck >= notice` vigente y ANTES del plazo: el
 *     cliente reconoce haber recibido esta instrucción concreta y aun así mandó dentro de su ventana.
 *
 * Un frame en vuelo trae un `rateAck` ANTERIOR y por construcción nunca puede contar. Un cliente que
 * espera manda después del plazo y tampoco. Ninguna latencia, ningún planificador roto y ningún
 * reparto de la carga entre canales puede fabricar esa prueba: por eso el defecto no puede volver a
 * mudarse de sitio, y por eso el número de la espera ya no puede desincronizarse (solo hay uno,
 * `CONFIG.RATE_RETRY_MS`, y viaja con cada rechazo).
 *
 * Lo que NO cambia: el rechazo en sí. La contrapresión —no aceptar el frame y decir cuánto esperar—
 * es lo que protege al servidor, y se aplica a todo el mundo, pruebe lo que pruebe. Cerrar la sesión
 * de alguien que obedece nunca protegió nada: el 409 posterior cuesta exactamente lo mismo de servir
 * que el 429 (los dos pasan por `authenticate` + `Post.findById` en `connGate`), así que la expulsión
 * solo ahorra el socket SSE. Un cliente ajeno al protocolo, que no devuelva `rateAck`, no se expulsa:
 * se le rechaza TODO igualmente, que es la parte que sirve para algo.
 *
 * CUBO DE FICHAS, no ventana de un segundo. Con la ventana, un frame legítimo más grande que el cap
 * por segundo era IMPOSIBLE de aceptar por muy despacio que fuera el editor: se validaba, se
 * saneaba, se rechazaba con 429 y a los tres reintentos se cerraba la sesión — y al reabrir pasaba
 * exactamente lo mismo. El cubo permite la ráfaga (>= el frame máximo) y mantiene el ritmo medio.
 */
function rateGate(conn: Conn, ops: number, bytes: number, presence = 0): RateVerdict {
    const now = Date.now();
    refill(conn, now);

    if (ops > CONFIG.OPS_BURST || bytes > CONFIG.BYTES_BURST || presence > CONFIG.PRESENCE_BURST) {
        // Ni esperando cabría: no es un problema de ritmo y reintentarlo no arregla nada.
        return { ok: false, code: 'too-large', message: 'La operación excede el máximo permitido.' };
    }

    // CADA CUBO FRENA SOLO LO QUE GASTA DE ÉL. `conn.byteTokens < bytes` con `bytes = 0` es cierto en
    // cuanto el cubo está en DESCUBIERTO — y `chargeBytes` lo deja ahí a propósito tras servir un
    // `resync`. Por esa puerta rebotaba TODA la presencia, que cuesta 0 ops y 0 bytes: mover el cursor
    // por los bloques después de un resync legítimo se comía los tres strikes y expulsaba de la sala a
    // quien no había hecho nada malo (y un co-editor lo provocaba a voluntad inflando el log). El
    // suelo de la deuda acota el tiempo de recuperación; esto acota A QUÉ afecta esa deuda.
    const falta =
        (ops > 0 && conn.opTokens < ops) ||
        (bytes > 0 && conn.byteTokens < bytes) ||
        (presence > 0 && conn.presenceTokens < presence);
    if (falta) {
        // ¿Hay una instrucción VIGENTE y este frame demuestra conocerla? Ésa es toda la condición de
        // expulsión del módulo, y está escrita una sola vez.
        const vigente = now < conn.rateRetryAt;
        if (vigente && conn.rateAck >= conn.rateNotice) {
            conn.strikes++;
            if (conn.strikes >= CONFIG.MAX_STRIKES) {
                writeEvent(conn, 'error', { code: 'rate_limit', message: 'Demasiadas operaciones: conexión cerrada.' });
                void leave(conn);
                return { ok: false, code: 'closed', message: 'Conexión cerrada por exceso de operaciones.' };
            }
        }
        // La instrucción solo se RENUEVA cuando la anterior ha vencido: mientras una está en vigor,
        // repetirla movería el plazo hacia delante y volvería inalcanzable el número de serie que el
        // cliente tiene que reconocer — justo la puerta por la que un cliente que la ignora se haría
        // inmune a los strikes. Un plazo, un número de serie.
        if (!vigente) {
            conn.rateNotice++;
            conn.rateRetryAt = now + CONFIG.RATE_RETRY_MS;
        }
        return {
            ok: false,
            code: 'rate',
            message: 'Demasiadas operaciones. Reduce el ritmo.',
            rate: { retryAfterMs: Math.max(0, conn.rateRetryAt - now), notice: conn.rateNotice },
        };
    }

    conn.opTokens -= ops;
    conn.byteTokens -= bytes;
    conn.presenceTokens -= presence;
    conn.strikes = 0;     // un pico aislado no puede acumularse hasta matar una sesión sana
    conn.rateRetryAt = 0; // frame aceptado ⇒ no hay espera en vigor que nadie pueda incumplir
    return { ok: true };
}

/**
 * TRADUCCIÓN ÚNICA de un veredicto de ritmo a lo que devuelven las rutas. Estaba repetida en los
 * tres puntos de entrada, y con una diferencia que costó un test: el veredicto `closed` —la sesión
 * ACABA de cerrarse— salía como 429 «espera un poco», o sea invitando a reintentar sobre una sesión
 * que ya no existe y sin la instrucción que un 429 tiene que llevar. Es un 409: no hay sesión.
 */
function rateFailure(v: Extract<RateVerdict, { ok: false }>): {
    status: number; code: string; message: string; rate?: RateInstruction;
} {
    if (v.code === 'too-large') return { status: 413, code: 'collab_frame_too_large', message: v.message };
    if (v.code === 'closed') return { status: 409, code: 'collab_closed', message: v.message };
    return { status: 429, code: 'collab_rate_limit', message: v.message, rate: v.rate };
}

/**
 * Anota el número de aviso que el cliente DICE haber visto. Se llama desde `connGate`, que es la
 * única puerta por la que una ruta de subida consigue una `conn`: así ningún camino nuevo puede
 * olvidarse de pasarlo (que fue exactamente cómo el defecto se mudó de camino tres veces).
 *
 * Es un dato del cliente y se trata como tal: solo puede perjudicarle. Declarar de menos = no se le
 * puede probar nada (y se le sigue rechazando todo); declarar de más = se autoinculpa. Nunca afecta a
 * otra conexión, porque el número de serie es por conexión.
 */
function noteRateAck(conn: Conn, raw: any): void {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    conn.rateAck = Math.max(conn.rateAck, Math.min(n, Number.MAX_SAFE_INTEGER));
}

/**
 * Cobra bytes YA servidos (la respuesta de un `resync`). Deja el cubo en descubierto, pero con
 * SUELO: sin él, la deuda era el tamaño del log entero (megabytes) y el tiempo de recuperación
 * crecía sin límite con el documento. Con el suelo en una ráfaga, el peor caso vuelve a cero en
 * `BYTES_BURST / MAX_BYTES_PER_SEC` segundos, que es un frenazo, no una expulsión.
 */
function chargeBytes(conn: Conn, bytes: number): void {
    refill(conn, Date.now());
    conn.byteTokens = Math.max(-CONFIG.BYTES_BURST, conn.byteTokens - Math.max(0, bytes));
}

/* ------------------------------------------------------------------------------------------- */
/* Ingest de operaciones                                                                         */
/* ------------------------------------------------------------------------------------------- */

export type PushResult =
    | {
        ok: true;
        /** Ops nuevas efectivamente escritas en el log. */
        accepted: number;
        /** Ops que YA estaban (reenvío tras reconexión). Se re-difunden, pero no son altas nuevas. */
        known: number;
        rejected: { index: number; code: string }[];
        persisted: boolean;
        /** Ops que el saneado REESCRIBIÓ, ya normalizadas, para que el emisor adopte el valor bueno. */
        normalized: any[];
    }
    | { ok: false; status: number; code: string; message: string; rate?: RateInstruction };

/**
 * ¿El error del INSERT es la violación del UNIQUE (= la op ya estaba) o un fallo de verdad?
 *
 * Tragarse los dos por igual convertía cualquier problema operativo — un `SQLITE_BUSY`, un lock
 * wait timeout de MySQL, un pool caído — en un 200 OK con la op perdida: ni persistida, ni
 * difundida, y el cliente la borraba de su outbox. Ante la duda se responde QUE NO es duplicado,
 * que es el lado que hace reintentar en vez de perder.
 */
function isDuplicateKeyError(e: any): boolean {
    const code = String((e && e.code) || '');
    const errno = Number(e && e.errno);
    const msg = String((e && e.message) || '').toLowerCase();
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
    if (code === 'ER_DUP_ENTRY' || errno === 1062) return true;
    if (code === '23505') return true;
    return /unique constraint failed|duplicate entry|duplicate key value/.test(msg);
}

/**
 * Punto de entrada de las ops. Orden deliberado: LÍMITES → VALIDACIÓN+SANEADO → PERSISTENCIA →
 * DIFUSIÓN. Nada se difunde antes de estar saneado y persistido, así que lo que ve el editor de al
 * lado es exactamente lo que se recuperaría en un `resync`.
 */
async function pushOps(conn: Conn, rawOps: any, epoch: number): Promise<PushResult> {
    if (conn.closed) return { ok: false, status: 409, code: 'collab_closed', message: 'La conexión ya no está activa.' };

    const bytes = Buffer.byteLength(JSON.stringify(rawOps ?? null), 'utf8');
    if (bytes > CONFIG.MAX_FRAME_BYTES) {
        return { ok: false, status: 413, code: 'collab_frame_too_large', message: 'Frame demasiado grande.' };
    }

    // El ritmo se cobra ANTES de la consulta y del saneado: no tiene sentido pagar sanitize-html
    // sobre un frame que se va a rechazar.
    const byteVerdict = rateGate(conn, 0, bytes);
    if (!byteVerdict.ok) return { ok: false, ...rateFailure(byteVerdict) };

    const current = await dbAsync.get('SELECT epoch, truncated FROM collab_docs WHERE post_id = ?', [conn.postId]);
    if (!current) {
        // Sin fila de documento no hay generación con la que comparar. Asumir "epoch 1" insertaba
        // ops HUÉRFANAS bajo un snapshot que ya no existía: se falla cerrado.
        return { ok: false, status: 409, code: 'collab_epoch', message: 'La sesión se reinició. Recarga el documento.' };
    }
    const liveEpoch = Number(current.epoch) || 1;
    if (Number(epoch) !== liveEpoch) {
        // El cliente habla de una generación que ya no existe: sus ops no encajan en este estado.
        return { ok: false, status: 409, code: 'collab_epoch', message: 'La sesión se reinició. Recarga el documento.' };
    }

    const frame = validateFrame(rawOps, conn.siteId);
    if (!frame.ok) {
        return { ok: false, status: 400, code: 'collab_bad_frame', message: `Frame inválido (${frame.code}).` };
    }

    const verdict = rateGate(conn, frame.ops.length, 0);
    if (!verdict.ok) return { ok: false, ...rateFailure(verdict) };

    const rejected = [...frame.rejected];
    if (frame.ops.length === 0) {
        return { ok: true, accepted: 0, known: 0, rejected, persisted: true, normalized: [] };
    }

    // Persistir ANTES de difundir. El UNIQUE(post_id, epoch, site_id, counter) hace la idempotencia
    // un invariante de la BD: un reenvío tras reconexión no duplica y no depende de que el proceso
    // recuerde nada.
    const total = await opsCount(conn.postId, liveEpoch);
    const persisted = total + frame.ops.length <= CONFIG.MAX_OPS_PER_EPOCH;
    const stored: any[] = [];
    let accepted = 0;
    let known = 0;

    if (persisted) {
        for (let i = 0; i < frame.ops.length; i++) {
            const op = frame.ops[i];
            const srcIndex = frame.srcIndex[i];
            try {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [conn.postId, liveEpoch, conn.siteId, op.id.counter, op.k, JSON.stringify(op), conn.userId]
                );
                stored.push(op);
                accepted++;
            } catch (e: any) {
                if (!isDuplicateKeyError(e)) {
                    // Fallo operativo. Se dice, con un status que el cliente sabe reintentar: dar el
                    // lote por bueno le haría borrarlo de su outbox y la op se perdería para siempre.
                    console.warn('[collab] no se pudo persistir una op:', e && e.message);
                    return {
                        ok: false, status: 503, code: 'collab_store_failed',
                        message: 'No se pudo guardar la operación. Se reintentará.',
                    };
                }
                const prior = await dbAsync.get(
                    'SELECT payload, user_id FROM collab_ops WHERE post_id = ? AND epoch = ? AND site_id = ? AND counter = ?',
                    [conn.postId, liveEpoch, conn.siteId, op.id.counter]
                );
                if (!prior) {
                    // Dijo "duplicado" pero no hay fila: no se puede afirmar que esté guardada.
                    return {
                        ok: false, status: 503, code: 'collab_store_failed',
                        message: 'No se pudo guardar la operación. Se reintentará.',
                    };
                }
                if (Number(prior.user_id) !== Number(conn.userId)) {
                    // Mismo dot, otro dueño: no es un reenvío, es una colisión de identidad.
                    rejected.push({ index: srcIndex, code: 'dot-taken' });
                    continue;
                }
                // Reenvío tras una reconexión (o tras un fallo a mitad del lote). Se RE-DIFUNDE la
                // versión CANÓNICA: si el proceso murió entre el INSERT y el broadcast, esta es la
                // única vía por la que la op llega a los demás.
                //
                // El `known++` va DESPUÉS del parse, y ese orden es el arreglo: contándola antes, una
                // fila ilegible salía como `200 {accepted:0, known:1}` sin haberse difundido a nadie
                // y sin poder recuperarse por reanudación (`loadOps` también se la salta). El cliente
                // cuadra `accepted+known+rejected` y SUELTA el lote: éxito habiendo perdido una op.
                let canonica: any;
                try {
                    canonica = JSON.parse(prior.payload);
                } catch {
                    console.warn('[collab] fila de op ilegible en el log:', conn.postId, op.id.counter);
                    return {
                        ok: false, status: 503, code: 'collab_store_failed',
                        message: 'No se pudo confirmar la operación. Se reintentará.',
                    };
                }
                known++;
                stored.push(canonica);
            }
        }
        if (accepted) {
            await dbAsync.run(
                'UPDATE collab_docs SET ops_count = ops_count + ?, updated_at = CURRENT_TIMESTAMP, updated_ms = ? WHERE post_id = ?',
                [accepted, Date.now(), conn.postId]
            );
        }
    } else {
        // Tope alcanzado: se sigue COLABORANDO (la difusión no para) pero la reanudación ya no está
        // garantizada. La bandera es PEGAJOSA en la BD porque el contador de filas se queda por
        // DEBAJO del tope — derivar la señal de él le decía "log completo" a todo el que entraba
        // mientras faltaban todas las ediciones posteriores. Y el aviso va a TODA la sala: los demás
        // también han dejado de tener sesión reanudable, no solo quien emitió el frame que no cupo.
        stored.push(...frame.ops);
        accepted = frame.ops.length;
        try {
            await dbAsync.run('UPDATE collab_docs SET truncated = 1, updated_ms = ? WHERE post_id = ?',
                [Date.now(), conn.postId]);
        } catch (e: any) {
            console.warn('[collab] no se pudo marcar la sala como truncada:', e && e.message);
        }
        await broadcast(conn.postId, 'warning', {
            code: 'log_full',
            message: 'La sesión colaborativa es muy larga: guarda y recarga para poder reconectar sin perder cambios.',
        });
    }

    if (stored.length) {
        await broadcast(conn.postId, 'ops', { ops: stored, from: conn.siteId, epoch: liveEpoch }, conn.siteId);
    }

    // Lo que el saneador REESCRIBIÓ vuelve al emisor. Sin esto el emisor era el único que se quedaba
    // con el valor sin sanear (la difusión lo excluye a propósito y el `resync` no se lo devuelve
    // porque su version vector ya cubre el dot): su réplica divergía del resto de forma permanente.
    const normalized = frame.changed.length
        ? frame.ops.filter((_op: any, i: number) => frame.changed[i])
        : [];

    return { ok: true, accepted, known, rejected, persisted, normalized };
}

/* ------------------------------------------------------------------------------------------- */
/* Presencia                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Normaliza la selección declarada por el cliente. Es dato hostil como cualquier otro. */
function cleanSel(raw: any): PresenceSel {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const nodeId = typeof raw.nodeId === 'string' && raw.nodeId.length <= 200 ? raw.nodeId : null;
    if (!nodeId) return null;
    const out: NonNullable<PresenceSel> = { nodeId };
    if (typeof raw.field === 'string' && raw.field.length > 0 && raw.field.length <= 160) out.field = raw.field;
    if (typeof raw.anchor === 'string' && raw.anchor.length <= 200) out.anchor = raw.anchor;
    if (typeof raw.focus === 'string' && raw.focus.length <= 200) out.focus = raw.focus;
    return out;
}

async function setPresence(
    conn: Conn,
    rawSel: any,
): Promise<{ ok: boolean; status?: number; code?: string; message?: string; rate?: RateInstruction }> {
    if (conn.closed) return { ok: false, status: 409, code: 'collab_closed', message: 'La conexión ya no está activa.' };
    const verdict = rateGate(conn, 0, 0, 1);
    if (!verdict.ok) return { ok: false, ...rateFailure(verdict) };

    const room = rooms.get(conn.postId);
    if (!room) return { ok: false, code: 'collab_no_room', message: 'La sala ya no existe.' };

    const entry: PresenceEntry = {
        siteId: conn.siteId,
        userId: conn.userId,
        name: conn.name,
        color: conn.color,
        sel: cleanSel(rawSel),
        at: Date.now(),
    };
    room.presence.set(conn.siteId, entry);
    // La presencia NO se persiste y NO entra en `collab_ops`: es awareness, no documento.
    await broadcast(conn.postId, 'presence', { entries: [entry] }, conn.siteId);
    return { ok: true };
}

/* ------------------------------------------------------------------------------------------- */
/* Reanudación                                                                                   */
/* ------------------------------------------------------------------------------------------- */

export type ResyncResult =
    | {
        ok: true;
        epoch: number;
        /** Ops que al cliente le faltan según su propio version vector. */
        ops: any[];
        /** `base` solo si el cliente no lo tiene (epoch distinto o arranque en frío). */
        base?: string;
        /** false ⇒ el log se truncó: el cliente debe recargar el documento del servidor. */
        complete: boolean;
    }
    | { ok: false; status: number; code: string; message: string; rate?: RateInstruction };

/**
 * Cierra un hueco. Se filtra por VERSION VECTOR y no por un cursor de secuencia: un cursor asume
 * que el cliente recibió TODO lo anterior en orden, y en multinodo el bus no garantiza orden entre
 * nodos. El VV dice exactamente qué dots ha visto, así que la respuesta es correcta aunque las ops
 * hayan llegado desordenadas o a saltos.
 *
 * PASA POR EL LÍMITE DE RITMO, y no por elegancia: es la petición más barata de formular (~60 B) y
 * la más cara de servir (lee la sala entera y la serializa). Sin cobrarla, era un amplificador de
 * cuatro órdenes de magnitud contra la memoria del proceso y contra la BD.
 */
async function resync(conn: Conn, rawVv: any, clientEpoch: number): Promise<ResyncResult> {
    if (conn.closed) return { ok: false, status: 409, code: 'collab_closed', message: 'La conexión ya no está activa.' };

    const verdict = rateGate(conn, CONFIG.RESYNC_OP_COST, 0);
    if (!verdict.ok) return { ok: false, ...rateFailure(verdict) };

    const doc = await ensureDoc(conn.postId, false);
    const { ops: all, bytes, unreadable } = await loadOps(conn.postId, doc.epoch);
    // `unreadable > 0` ⇒ el log que se sirve NO es el que se aceptó. Derivar `complete` solo del
    // recuento YA PARSEADO respondía `complete: true` MINTIENDO, y el cliente daba por recuperado un
    // histórico al que le faltaban ops.
    const complete = !doc.truncated && all.length < CONFIG.MAX_OPS_PER_EPOCH && unreadable === 0;

    // Lo LEÍDO se cobra entero aunque se filtre después: el coste que hay que frenar es el de
    // recorrer la sala, no el del recorte que le toque a este cliente.
    chargeBytes(conn, bytes);

    if (Number(clientEpoch) !== doc.epoch) {
        // Generación distinta: el cliente tiene que re-sembrar desde el snapshot.
        return { ok: true, epoch: doc.epoch, base: doc.base, ops: all, complete };
    }
    const vv = sanitizeVersionVector(rawVv);
    const missing = all.filter((op) => !(op?.id && vvCovers(vv, op.id.site, op.id.counter)));
    return { ok: true, epoch: doc.epoch, ops: missing, complete };
}

/* ------------------------------------------------------------------------------------------- */

/**
 * Localiza la conexión dueña de un `siteId` EXIGIENDO que sea del usuario que pregunta.
 *
 * Doble candado: el `siteId` solo puede existir si el servidor lo derivó del `userId` de quien pide
 * (`replicaId`), y aun así se comprueba aquí que la conexión viva sea suya.
 */
function findConn(postId: number, siteId: any, userId: number): Conn | null {
    const room = rooms.get(postId);
    if (!room || typeof siteId !== 'string') return null;
    const connId = room.sites.get(siteId);
    if (!connId) return null;
    const conn = room.conns.get(connId);
    if (!conn || conn.closed || conn.userId !== userId) return null;
    return conn;
}

/** Métricas mínimas para el panel de operador y para los tests. */
function stats() {
    let members = 0;
    for (const r of rooms.values()) members += r.conns.size;
    return { nodeId: NODE_ID, rooms: rooms.size, members, totalConns };
}

/** Solo para tests: cierra todo sin tocar la BD. */
function _resetForTests(): void {
    for (const room of rooms.values()) {
        for (const conn of room.conns.values()) { conn.left = true; closeConn(conn, 'test-reset'); }
    }
    rooms.clear();
    perUser.clear();
    totalConns = 0;
}

module.exports = {
    CONFIG, NODE_ID, CHANNEL,
    colorForUser, initClusterBus, replicaId,
    join, leave, pushOps, setPresence, resync, findConn, noteRateAck,
    livePresence, retireRoom, sweepIdleRooms, ensureDoc, liveMembers,
    writeEvent, stats, _resetForTests,
    _rooms: rooms,
};
