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
    /**
     * COSTE MÍNIMO EN BYTES DE UN `resync`, cobrado POR ADELANTADO — y es lo que hace que la deuda de
     * bytes signifique algo para el repetidor.
     *
     * `resync` cobraba `rateGate(conn, RESYNC_OP_COST, 0)`, o sea CERO bytes, y la condición de
     * rechazo del cubo de bytes es `(bytes > 0 && conn.byteTokens < bytes)`: con `bytes = 0` es falsa
     * SIEMPRE. Es decir, la deuda que `chargeBytes` deja tras servir un log entero no frenaba el
     * siguiente `resync` en absoluto — lo único que lo acotaba era el cubo de OPS. El coste real no
     * se puede conocer antes de leer el log, así que se cobra este mínimo antes y la diferencia
     * después: basta con que el cubo de bytes se MIRE para que el descubierto vuelva a ser una
     * espera. Y sigue sin afectar a la presencia, que gasta 0 bytes.
     *
     * SE EXPRESA COMO FRACCIÓN DE LA RÁFAGA, no como un número absoluto, y eso no es cosmética: un
     * mínimo mayor que `BYTES_BURST` no es una espera, es un `too-large` (413) — un rechazo TERMINAL
     * que ni esperando se arregla, exactamente la banda muerta que `OPS_BURST >= LIMITS.OPS_PER_FRAME`
     * existe para evitar en el otro cubo. Atado al cubo, el mínimo es siempre pagable por
     * construcción. 1/16 de la ráfaga son 16 KB con la configuración de producción.
     */
    RESYNC_MIN_BYTES_DIVISOR: 16,
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
    /**
     * TAMAÑO del log de un epoch. EL TOPE DE FILAS NO ES UNA COTA DE MEMORIA: 5000 filas de ~250 KB
     * (un `propSet` grande cabe de sobra en `LIMITS.STRING` y en `MAX_FRAME_BYTES`) son ~1,25 GB, y
     * cada entrada a la sala los traía enteros al heap. El techo lo tiene que poner el TAMAÑO.
     *
     * 4 MB con 5000 ops son ~840 B por op: muy por encima de lo que ocupa una edición real (un
     * `propSet` de texto ronda los cientos de bytes), así que para una sesión legítima el tope que
     * sigue mandando es el de FILAS y esto no se nota. Lo que acota es el abuso.
     *
     * SE MIDE EN BYTES EN LA BD, con la expresión que corresponda al motor (ver `payloadBytesExpr`).
     * `LENGTH()` a secas cuenta CARACTERES en SQLite y Postgres, y compararlo con `Buffer.byteLength`
     * —que son bytes— subía este techo ×3 con contenido CJK y ×4 con emoji. Eso no era solo «un techo
     * más alto»: rompía la razón por la que `MAX_LOG_LOAD_BYTES` está POR ENCIMA de esta constante, y
     * un log conforme en japonés dejaba de caber en una lectura, o sea sin reanudación de sesión.
     */
    MAX_LOG_BYTES_PER_EPOCH: 4 * 1024 * 1024,
    /**
     * PRESUPUESTO DURO de una sola lectura del log (`loadOps`). Es la cota de memoria de verdad, y
     * es INDEPENDIENTE del tope de escritura a propósito: un log escrito antes de que existiera el
     * tope de bytes puede pesar cientos de MB, y quien entra hoy no puede pagar eso. Por encima de
     * `MAX_LOG_BYTES_PER_EPOCH` para que un log que respeta el tope se sirva SIEMPRE entero.
     */
    MAX_LOG_LOAD_BYTES: 8 * 1024 * 1024,
    /**
     * PRESUPUESTO DE LECTURA DEL LOG **POR USUARIO**, y es el que cierra el amplificador de verdad.
     *
     * El cobro de `resync` vive en el cubo de la CONEXIÓN, y una conexión es un recurso que el cliente
     * fabrica cuando quiere: reconectar con el mismo `siteId` DESALOJA la anterior y la nueva nace con
     * el cubo LLENO (ver `join`). Así que quien quiera repetir la lectura no hace `resync` — cierra el
     * stream y lo reabre, y el log vuelve a viajar entero al heap gratis. Las dos puertas leen el
     * MISMO log por el MISMO camino (`loadOps`), luego el presupuesto tiene que colgar de algo que
     * SOBREVIVA a la conexión, y eso es el usuario.
     *
     * SIN SUELO, al revés que `chargeBytes`: la deuda es PROPORCIONAL a lo servido — servir 8 MB
     * cuesta 32 veces más espera que servir 256 KB —, que es lo único que hace que la deuda signifique
     * algo para el repetidor. Se puede pedir mientras quede saldo y se cobra DESPUÉS lo realmente
     * servido, así que el descubierto máximo es una lectura entera y el ritmo sostenido es exactamente
     * `USER_READ_BYTES_PER_SEC` por usuario, sume las conexiones que sume.
     *
     * Los números: 256 KB/s sostenidos son cuatro veces el cap de escritura de UNA conexión y muy por
     * debajo de lo que diez conexiones podrían pedir; la ráfaga de 16 MB deja entrar de golpe a un
     * usuario con muchas pestañas abiertas (10 salas de ~500 KB de log son 5 MB) sin rozar el tope.
     */
    USER_READ_BYTES_PER_SEC: 256 * 1024,
    USER_READ_BURST: 16 * 1024 * 1024,
    /**
     * Cubos de lectura recordados a la vez, Y ES UN MÁXIMO DE VERDAD (ver `readBucket`).
     *
     * Antes no lo era: la poda estaba estrangulada a una por segundo y solo borraba los cubos LLENOS,
     * así que con muchos usuarios en descubierto a la vez el Map crecía por encima del número
     * declarado y la constante no ataba nada. Ahora, al tocar el tope se barre SIN estrangular y, si
     * eso no libera nada, se desaloja el cubo con MÁS saldo: olvidar un cubo perdona su deuda, así que
     * el único que se puede olvidar sin abrir la puerta de atrás es el que menos debe.
     */
    MAX_READ_BUCKETS: 5_000,
    /**
     * LECTURAS DE SALA SIMULTÁNEAS DE UN MISMO USUARIO, y es lo que hace VERDAD la frase de
     * `USER_READ_BYTES_PER_SEC`: «el descubierto máximo es una lectura entera».
     *
     * No lo era. El saldo se MIRABA (`canReadLog`) y se COBRABA (`chargeReadBytes`) con varios `await`
     * en medio —reclamar la fila de liveness, `ensureDoc`, `loadOps`—, y un cubo de fichas no reserva
     * nada al mirarlo: N entradas simultáneas del MISMO usuario veían todas el mismo saldo positivo y
     * pasaban todas. Con `MAX_CONNS_PER_USER = 10` el pico real era 10 × `MAX_LOG_LOAD_BYTES` = 80 MB
     * de payloads vivos en el heap, más sus `JSON.parse` — y en SQLite, cuyo driver es SÍNCRONO, diez
     * escaneos encadenados bloqueando el event loop.
     *
     * Se arregla en la FORMA y no con otro cheque: las lecturas de un usuario se SERIALIZAN
     * (`materializeRoom`), así que la segunda ve el saldo que dejó la primera. No se rechazan —
     * rechazar rompería el viaje legítimo de abrir diez pestañas de golpe, que la ráfaga de 16 MB
     * existe para permitir—: se hacen esperar, que es lo que el presupuesto significa.
     */
    READ_CONCURRENCY_PER_USER: 1,
    /**
     * Lecturas ESPERANDO turno por usuario. La cola tiene tope porque una cola sin tope es la misma
     * amplificación con otro nombre: pasado el tope se rechaza con el mismo `read-budget`, que el
     * cliente sabe reintentar.
     */
    MAX_QUEUED_READS_PER_USER: 16,
    /**
     * CADA CUÁNTO SE VUELVE A MEDIR EL LOG. Medirlo (`SUM` sobre los payloads) en CADA frame aceptado
     * es cuadrático —llenar un epoch son miles de escaneos de un log que crece— y en SQLite, cuyo
     * driver nativo es SÍNCRONO, cada escaneo bloquea el event loop del proceso entero. El tamaño se
     * mide una vez y se lleva en memoria sumando lo que se inserta; se vuelve a medir por tiempo y por
     * número de frames para que la cuenta no se aleje de la BD (otro nodo también escribe).
     *
     * Que la cuenta pueda ir CORTA unos milisegundos no es un agujero: esto decide cuándo DEJAR DE
     * PERSISTIR, y el desfase máximo es lo que el clúster pueda escribir en esta ventana, acotado a su
     * vez por `MAX_BYTES_PER_SEC`. La cota de memoria de verdad es `MAX_LOG_LOAD_BYTES`, que se aplica
     * al LEER y no depende de esta caché.
     */
    LOG_SIZE_RESEED_MS: 2_000,
    LOG_SIZE_RESEED_FRAMES: 64,
    /** Salas que un solo barrido examina. Acota el lote: lo que no entre se retira en la pasada siguiente. */
    MAX_SWEEP_ROOMS: 500,
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
    /**
     * IDENTIDAD DE QUIEN ACUÑA LOS AVISOS. El número de serie es por conexión y arranca en 0 en cada
     * una, así que un número SUELTO no dice de qué conexión habla: al reconectar, un POST que sale de
     * la conexión vieja y aterriza en la nueva traía un acuse de 4 contra un contador que iba por 0, y
     * `Math.max` lo grababa para siempre. A partir de ahí el servidor creía que el cliente ya había
     * acusado avisos que todavía no había emitido, y el primer 429 real de la conexión nueva ya
     * contaba como desobediencia: expulsión garantizada de alguien impecable (ronda 5).
     *
     * El sello se acuña UNA vez por conexión, viaja en cada 429 y el cliente lo devuelve junto al
     * número. Un acuse sin ESTE sello no se puede aplicar aquí, así que un número acuñado por otra
     * conexión no es un acuse "viejo": no es un acuse en absoluto.
     */
    rateSeal: string;
    /**
     * El `welcome` de esta conexión YA SALIÓ por el cable. Hasta entonces se rechaza por ritmo (la
     * contrapresión protege al servidor y no depende de nadie), pero NO se suma strike: una conexión
     * que todavía no se ha presentado no puede exigirle a nadie que reconozca sus instrucciones.
     */
    welcomed: boolean;
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
 * Log de ops del epoch vigente, en el orden en que el servidor las aceptó.
 *
 * EL `LIMIT` DE FILAS NO ES UNA COTA DE MEMORIA, y creer que lo era es el hallazgo 20: 5000 filas de
 * ~250 KB caben en el tope y son ~1,25 GB en un solo array. `join` llama aquí para TODO el que entra
 * y `resync` lo repite, así que la entrada de cualquier coeditor legítimo era un pico de cientos de
 * MB y un bloqueo del event loop — en monolito, el CMS entero.
 *
 * POR QUÉ DOS CONSULTAS. Recortar en JS no sirve de nada: cuando el bucle empieza, el driver YA ha
 * materializado las filas con sus payloads. El presupuesto tiene que decidir CUÁNTAS FILAS pide la
 * consulta, así que primero se piden solo los TAMAÑOS (en bytes, sin traer el texto) y con
 * ellos se calcula cuántas caben; el `SELECT payload` va ya acotado. El presupuesto se vuelve a
 * aplicar en el bucle con `Buffer.byteLength`, que sí son bytes exactos: la primera pasada elige un
 * `k` seguro, la segunda es la que manda.
 *
 * `unreadable` cuenta las filas que están en la BD pero NO se pueden releer. Saltárselas en silencio
 * —que es lo que se hacía— no tumba la sala, pero convierte la reanudación en una mentira: el log
 * que se sirve ya no es el que se aceptó. Quien lo consuma tiene que decírselo al cliente.
 *
 * `budgetHit` es esa misma mentira por otro motivo: el log existe entero pero no cabe. Se devuelve
 * aparte porque el consumidor lo traduce a las banderas que YA tienen ese significado — `truncated`
 * en el `welcome`, `complete: false` en el `resync` — y ésas ya le dicen al cliente lo único que
 * puede hacer: guardar y recargar.
 */
async function loadOps(
    postId: number, epoch: number,
): Promise<{ ops: any[]; bytes: number; unreadable: number; budgetHit: boolean }> {
    // Cuántas filas TIENE que traer la consulta. Se pregunta ANTES y no es redundante: `dbAsync.all`
    // devuelve `[]` cuando el driver de reserva no puede leer (ver `countOrNull`), y un `[]` de fallo
    // es indistinguible de un log vacío. Sin este contraste, un log de miles de ops que no se puede
    // releer se servía como «vacío y COMPLETO» — `welcome.truncated: false` — y el cliente daba por
    // recuperado un histórico del que no había leído ni una fila.
    const total = await countOrNull(
        'SELECT COUNT(*) AS c FROM collab_ops WHERE post_id = ? AND epoch = ?', [postId, epoch]);

    // Sondeo de TAMAÑOS. Trae enteros, no payloads: es lo que permite acotar la segunda consulta sin
    // haber traído nunca el log entero al proceso. En BYTES (ver `payloadBytesExpr`), que es la unidad
    // del presupuesto: con `LENGTH()` a secas el sondeo contaba CARACTERES y con texto multibyte se
    // quedaba corto por un factor de hasta 4 — pedía cuatro veces más filas de las que caben y era la
    // segunda pasada la que tenía que recortar, ya con los payloads materializados por el driver.
    const sizeRows = await dbAsync.all(
        `SELECT ${payloadBytesExpr()} AS n FROM collab_ops WHERE post_id = ? AND epoch = ? ORDER BY id ASC LIMIT ?`,
        [postId, epoch, CONFIG.MAX_OPS_PER_EPOCH]
    );
    const tamanos: any[] = Array.isArray(sizeRows) ? sizeRows : [];
    let cabenFilas = 0;
    let sondeo = 0;
    let budgetHit = false;
    for (const r of tamanos) {
        const n = Number(r && r.n) || 0;
        if (sondeo + n > CONFIG.MAX_LOG_LOAD_BYTES) { budgetHit = true; break; }
        sondeo += n;
        cabenFilas++;
    }

    const rows = cabenFilas === 0 ? [] : await dbAsync.all(
        'SELECT payload FROM collab_ops WHERE post_id = ? AND epoch = ? ORDER BY id ASC LIMIT ?',
        [postId, epoch, cabenFilas]
    );
    const traidas: any[] = Array.isArray(rows) ? rows : [];
    const ops: any[] = [];
    let bytes = 0;
    let unreadable = 0;
    for (const r of traidas) {
        // Los bytes se cuentan sobre el texto que ya viene de la BD: sirven para cobrar el coste de
        // un `resync` sin volver a serializar la respuesta entera solo para medirla.
        const size = Buffer.byteLength(String(r.payload || ''), 'utf8');
        // Segunda aplicación del presupuesto, sobre el texto que YA está en el proceso. Sigue siendo
        // la que manda aunque el sondeo mida ahora los mismos bytes: el sondeo pregunta a la BD y esto
        // cuenta lo que de verdad se ha traído. Lo que no cabe ni se parsea ni se guarda.
        if (bytes + size > CONFIG.MAX_LOG_LOAD_BYTES) { budgetHit = true; break; }
        bytes += size;
        try { ops.push(JSON.parse(r.payload)); } catch { unreadable++; }
    }
    if (budgetHit) {
        console.warn(
            `[collab] sala ${postId}: el log supera el presupuesto de ${CONFIG.MAX_LOG_LOAD_BYTES} B; ` +
            `se sirven ${ops.length} op(s) y la sesión NO es reanudable`);
    }

    if (total === null) {
        // Ni siquiera se sabe cuántas había: no se puede afirmar que el log servido sea el aceptado.
        unreadable++;
        console.warn(`[collab] sala ${postId}: no se pudo contar el log; la sesión NO es reanudable`);
    } else if (!budgetHit) {
        // Solo se puede exigir que lleguen TODAS las filas cuando no se ha recortado a propósito: con
        // el presupuesto agotado, `traidas.length` es menor que `esperadas` PORQUE lo pedimos así, y
        // contarlo como «no llegaron a leerse» convertiría un recorte deliberado en un fallo de BD.
        const esperadas = Math.min(total, CONFIG.MAX_OPS_PER_EPOCH);
        const faltan = Math.max(0, esperadas - traidas.length);
        if (faltan > 0) {
            unreadable += faltan;
            console.warn(`[collab] sala ${postId}: ${faltan} fila(s) del log no llegaron a leerse`);
        }
    }

    if (unreadable) console.warn(`[collab] sala ${postId}: ${unreadable} fila(s) del log ilegibles o no leídas`);
    return { ops, bytes, unreadable, budgetHit };
}

/**
 * CUÁNTOS BYTES OCUPA UN PAYLOAD, EN EL DIALECTO DEL MOTOR ACTIVO — y la palabra que importa es BYTES.
 *
 * `LENGTH()` cuenta CARACTERES en SQLite y en Postgres, y BYTES en MySQL. Medir el log con `LENGTH()`
 * y compararlo con `Buffer.byteLength(...)` —que son bytes— es sumar peras y manzanas: con contenido
 * CJK (3 B/carácter) o emoji (4 B) el tope de escritura sube ×3 o ×4 sin que nadie lo haya decidido, y
 * entonces se rompe la razón declarada de que `MAX_LOG_LOAD_BYTES` (8 MB) esté POR ENCIMA de
 * `MAX_LOG_BYTES_PER_EPOCH` (4 MB): «para que un log que respeta el tope se sirva SIEMPRE entero». Un
 * log conforme en chino pesa 12 MB reales, `loadOps` marca `budgetHit`, y a partir de ahí TODO el que
 * entra recibe `truncated: true` y todo `resync` `complete: false` — cuyo único significado para el
 * cliente es «guarda y recarga». Un sitio en japonés perdía la reanudación de sesión con un log que el
 * propio guard de escritura consideraba dentro de tope.
 *
 * Se usa en LOS DOS sitios que miden el log —`logSize` (escritura) y el sondeo de `loadOps`
 * (lectura)—, que es lo que mantiene las dos cotas en la misma unidad y hace que el orden entre las
 * constantes vuelva a significar lo que dice el comentario.
 *
 * Un motor desconocido cae en `LENGTH(payload)`: puede quedarse corto, nunca inventa sintaxis.
 */
function payloadBytesExpr(): string {
    let t: any;
    try { t = require('../config/database').getDbType(); } catch { return 'LENGTH(payload)'; }
    if (t && t.isPostgres === true) return 'octet_length(payload)';
    if (t && t.isMySQL === true) return 'LENGTH(payload)';                    // ya son bytes
    if (/^sqlite/.test(String((t && t.driver) || ''))) return 'LENGTH(CAST(payload AS BLOB))';
    return 'LENGTH(payload)';
}

/**
 * Cuánto ocupa YA el log de este epoch: filas y BYTES. Las dos cotas salen de la MISMA consulta que
 * `pushOps` ya hacía para contar filas.
 *
 * RECORRE LOS PAYLOADS, así que NO puede llamarse en cada frame: ver `logSizeCached`, que es por
 * dónde entra `pushOps`.
 */
async function logSize(postId: number, epoch: number): Promise<{ count: number; bytes: number }> {
    const r = await dbAsync.get(
        `SELECT COUNT(*) AS c, SUM(${payloadBytesExpr()}) AS b FROM collab_ops WHERE post_id = ? AND epoch = ?`,
        [postId, epoch]);
    return { count: Number(r?.c) || 0, bytes: Number(r?.b) || 0 };
}

type LogSizeCache = { epoch: number; count: number; bytes: number; at: number; frames: number };

/** Tamaño del log por sala. Se olvida al retirar la sala y al vaciarse (ver `forgetLogSize`). */
const logSizes = new Map<number, LogSizeCache>();

/**
 * EL TAMAÑO DEL LOG SIN PAGARLO EN CADA FRAME.
 *
 * `pushOps` contaba filas con `COUNT(*)`, que el índice `idx_collab_ops_room (post_id, epoch, id)`
 * resuelve como COVERING INDEX — no toca los payloads. Al añadir el tope de BYTES pasó a llamar a
 * `logSize`, y `SUM(...)` sobre el payload obliga a LEERLOS TODOS en cada frame aceptado: medido en
 * este repo con 5000 filas de 840 B, ×18 más caro que el `COUNT(*)`, y como better-sqlite3 es
 * SÍNCRONO cada milisegundo de ese escaneo bloquea el event loop del proceso (en monolito, el CMS
 * entero). El coste de llenar un epoch se vuelve CUADRÁTICO, y el atacante lo compra barato: unas
 * pocas ops gordas para engordar el log y después ops diminutas al ritmo que el cubo permite. El
 * arreglo de una cota de MEMORIA no puede pagarse con una cota de CPU.
 *
 * Se mide UNA vez y a partir de ahí se lleva la cuenta sumando lo que se inserta; se vuelve a medir
 * por tiempo (otro nodo también escribe) y cada `LOG_SIZE_RESEED_FRAMES` frames (para que un chorro de
 * ops diminutas tampoco pueda alejar la cuenta indefinidamente). Ver `LOG_SIZE_RESEED_MS`.
 */
async function logSizeCached(postId: number, epoch: number, now: number): Promise<LogSizeCache> {
    const c = logSizes.get(postId);
    if (c && c.epoch === epoch
        && now - c.at < CONFIG.LOG_SIZE_RESEED_MS
        && c.frames < CONFIG.LOG_SIZE_RESEED_FRAMES) return c;
    const fresh = await logSize(postId, epoch);
    const next: LogSizeCache = { epoch, count: fresh.count, bytes: fresh.bytes, at: now, frames: 0 };
    logSizes.set(postId, next);
    return next;
}

/**
 * Apunta lo que ACABA de entrar en el log. Bytes EXACTOS de las filas insertadas —no los del frame—:
 * un reenvío tras reconexión trae ops que ya estaban, y contarlas inflaría la cuenta hasta marcar
 * `truncated` una sala que no lo está.
 */
function noteLogGrowth(postId: number, epoch: number, rows: number, bytes: number): void {
    const c = logSizes.get(postId);
    if (!c || c.epoch !== epoch) return;
    c.count += rows;
    c.bytes += bytes;
    c.frames++;
}

/** El epoch cambió o la sala se fue: la cuenta ya no habla de nada. */
function forgetLogSize(postId: number): void { logSizes.delete(postId); }

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
    // …PERO EL RESCATE POR INSERT ES SÓLO PARA CONEXIONES VIVAS. Sobre una que ya se fue, el UPSERT deja
    // de ser un rescate y pasa a ser una RESURRECCIÓN: `leave` ya borró la fila, el UPDATE toca 0 filas y
    // el INSERT la re-crea con `seen_at` positivo — un miembro vivo para todo el clúster, sin socket, sin
    // keepalive y sin entrada en `rooms`, durante los 4 minutos que tarda el barrido en llegar a él.
    // Mientras existe, `liveMembers(postId) > 0`, así que `ensureDoc` NO re-siembra aunque `_puck_data`
    // haya cambiado por fuera y `sweepIdleRooms` no retira la sala: el siguiente que entre recibe un
    // snapshot RANCIO y al guardar pisa lo escrito por la otra vía.
    if (conn.left || conn.closed) return;
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

/**
 * Cursor del barrido, por `post_id`. Es estado de PROCESO y no hace falta que sea compartido: cada
 * nodo recorre el catálogo por su cuenta y retirar dos veces la misma sala ya es un no-op
 * (`retireRoom` mira `base_doc <> ''`).
 */
let sweepCursor = 0;

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
        // El log de este epoch ya no existe y el epoch siguiente empieza vacío: la cuenta en memoria
        // hablaba de otra generación.
        forgetLogSize(postId);
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
        // ESCRIBIR EL `welcome` ES PRESENTARSE, así que el sello de "ya me he presentado" se pone
        // AQUÍ y no en la ruta: escribirlo es el acto, y una ruta nueva no puede olvidarse de marcar
        // algo que marca la propia escritura. Antes de esta línea la conexión existe —`join()` la da
        // de alta de forma síncrona, mucho antes de que la ruta escriba nada— y `rateGate` no le deja
        // acumular strikes (ver allí).
        if (event === 'welcome') conn.welcomed = true;
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
    // LA PREGUNTA ES «¿HAY TRAMO DE CLÚSTER?», NO «¿ESTÁ LEVANTADO AHORA MISMO?».
    //
    // Aquí se preguntaba `cache.pubsubAvailable()`, que es `redisConfigured() && redisAvailable`, y
    // eso mete en el MISMO saco dos situaciones opuestas:
    //   · Redis NO configurado (monolito): no hay nada que entregar fuera ⇒ `true` es la verdad;
    //   · Redis configurado pero CAÍDO (multinodo con el bus roto): la entrega a los demás nodos
    //     ACABA DE FALLAR ⇒ `true` es mentira.
    // Con el segundo caso devolviendo `true` se saltaba además el `publish`, así que tampoco salía
    // el aviso de «coherence DEGRADED» de `core/cache.ts`: la pérdida no dejaba NI UNA LÍNEA. Se
    // verificó en el laboratorio multinodo — con Redis parado, cinco ops del nodo A no llegaron al
    // editor del nodo B y el log de A no registró un solo `[collab]`, mientras `announceReset` daba
    // por entregado su aviso de retirada (que es justo el que existe para no perderse en silencio).
    //
    // Preguntando por la CONFIGURACIÓN, un bus caído entra en `publish`, que devuelve `false` y lo
    // registra: la degradación vuelve a ser visible y `announceReset` puede volver a gritar.
    if (!cache.redisConfigured()) return true;   // monolito: no hay tramo de clúster que fallar
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

export type JoinRefusal =
    | 'too-many-tabs' | 'too-many-connections' | 'server-full' | 'server-error'
    /** Sin saldo de lectura: entrar vuelve a traer el log entero al heap y este usuario ya ha leído de más. */
    | 'read-budget';

/**
 * QUÉ RECHAZOS SE CURAN ESPERANDO — Y POR QUÉ ESTA TABLA ESTÁ AQUÍ Y NO EN EL CLIENTE.
 *
 * CLASE DEL DEFECTO: cualquier código que el servidor acuña y el cliente clasifica con una lista
 * blanca escrita a mano es un contrato con DOS copias, y añadir una variante en el servidor —lo que
 * es un cambio local y aparentemente inocuo— la deja caer en la rama por defecto del cliente. Pasó
 * con `read-budget`: el servidor lo diseñó como una ESPERA (el cubo se recarga solo) y el cliente,
 * que no lo conocía, lo trataba como definitivo y MATABA la sesión colaborativa hasta recargar la
 * página. Es decir, el único rechazo del módulo que por construcción se cura solo era el único que
 * el cliente daba por irrecuperable.
 *
 * El arreglo no es «añadir el código que falta» —eso arregla el EJEMPLO— sino mover la decisión al
 * lado que acuña los códigos y mandarla por el cable (`retryable` en el evento de error). Y el
 * `Record<JoinRefusal, boolean>` es lo que impide que la clase se reabra: añadir una variante a la
 * unión SIN clasificarla aquí es un ERROR DE COMPILACIÓN, no un rechazo terminal en producción.
 */
const REFUSAL_RETRYABLE: Record<JoinRefusal, boolean> = {
    'too-many-tabs': true,          // otra pestaña propia: al cerrarse, hay hueco
    'too-many-connections': true,   // cupo del usuario: se libera al soltar conexiones
    'server-full': true,            // cupo del proceso: se libera solo
    'server-error': true,           // fallo transitorio de BD
    'read-budget': true,            // el cubo se recarga a USER_READ_BYTES_PER_SEC: es LITERALMENTE una espera
};

/** ¿Tiene sentido que el cliente reintente este rechazo? La respuesta viaja en el evento de error. */
function refusalIsRetryable(code: any): boolean {
    return REFUSAL_RETRYABLE[code as JoinRefusal] === true;
}

export type JoinResult =
    | { ok: true; conn: Conn; epoch: number; base: string; ops: any[]; members: PresenceEntry[]; truncated: boolean }
    /**
     * `retryAfterMs` NO es opcional por comodidad: un rechazo que se cura esperando tiene que decir
     * CUÁNTO, y ese número sale del cubo que de verdad bloquea (ver `readRetryMs`), no de la ventana
     * de la conexión — que es un número de otro recurso y que en este caso miente por un factor de 70.
     */
    | { ok: false; refusal: JoinRefusal; retryAfterMs?: number };

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
    // ENTRAR TAMBIÉN LEE EL LOG, y por esa puerta se rodeaba el cobro que se le puso a `resync`: el
    // atacante que quiere repetir la lectura no pide una reanudación, cierra el stream y lo reabre —
    // reconectar con el mismo `siteId` desaloja la conexión anterior y la nueva nace con el cubo
    // lleno, así que el cobro por conexión no le cuesta nada. El saldo se mira ANTES de dar de alta
    // nada: un rechazo tiene que ser más barato que lo que rechaza. (El cheque que MANDA es el de
    // `materializeRoom`, dentro del turno de lectura; éste solo evita el trabajo de darse de alta.)
    if (!canReadLog(userId)) {
        return { ok: false, refusal: 'read-budget', retryAfterMs: readRetryMs(userId) };
    }

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
        // Sello NUEVO en cada conexión, y por eso el acuse de la anterior no puede aplicarse aquí.
        // Aleatorio y no derivado del `connId` a propósito: el `connId` lleva dentro el `NODE_ID` y
        // un contador del proceso, y esto viaja al cliente en cada 429.
        rateSeal: crypto.randomBytes(9).toString('base64url'),
        welcomed: false,
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
    let budgetHit: boolean;
    try {
        // La liveness de clúster se reclama ANTES que nada: si se hiciera al final, un cliente que
        // aborta dentro de la ventana dejaría el DELETE de `leave` corriendo antes que el INSERT y
        // la fila quedaría huérfana. Entra con `seen_at = 0` (ver `claimMember`).
        await claimMember(conn);
        // TODO lo que esta entrada materializa —el SNAPSHOT y el log— se pide y se cobra en un solo
        // sitio (`materializeRoom`). Aquí se llamaba a `ensureDoc` + `loadOps` y se cobraba solo
        // `log.bytes`: con el log vacío, entrar era gratis por muy grande que fuera el snapshot.
        const servido = await materializeRoom(userId, postId, { reseed: true, exceptConnId: conn.connId });
        if (!servido.ok) {
            await leave(conn, { closeSocket: false });
            return { ok: false, refusal: 'read-budget', retryAfterMs: servido.retryAfterMs };
        }
        doc = servido.doc;
        ops = servido.ops;
        unreadable = servido.unreadable;
        budgetHit = servido.budgetHit;
        // ¿SIGUE AHÍ EL CLIENTE? `materializeRoom` tiene tres `await` (turno de lectura, snapshot, log) y
        // el turno NO tiene plazo: con READ_CONCURRENCY_PER_USER=1 y MAX_QUEUED_READS_PER_USER=16, este
        // join puede haber esperado lo que tarden 16 lecturas del mismo usuario. Si el socket se cerró en
        // esa ventana, `leave` ya corrió entero (fila borrada, keepalive parado) y la comprobación de
        // aborto de la ruta no repara nada: `leave` retorna en su primera línea por `if (conn.left)`.
        // Marcar `ready` y latir aquí resucitaba la fila de liveness. Se corta ANTES de tocar nada.
        if (conn.left || conn.closed) {
            // `leave` es idempotente (retorna en seco si ya corrió) y hace la contabilidad completa
            // cuando el socket se cerró sin que `leave` llegara a correr; el `releaseMember` explícito
            // que va detrás es la única línea que no depende de POR QUÉ se fue: la fila no se queda.
            await leave(conn, { closeSocket: false });
            await releaseMember(conn.connId);
            return { ok: false, refusal: 'server-error' };
        }
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
    // tiene que enterarse igual que si el log estuviera lleno. `budgetHit` es el mismo hecho por el
    // tamaño: el log existe, pero no cabe en una sola lectura y lo que se sirve no es todo.
    const truncated =
        doc.truncated || ops.length >= CONFIG.MAX_OPS_PER_EPOCH || unreadable > 0 || budgetHit;

    // Los demás, sin nosotros: nuestra conexión ya está `ready` y si no se excluyera nos veríamos a
    // nosotros mismos en la lista de compañeros. `clusterPresence`, not `livePresence`: the editors
    // of the OTHER nodes belong in this snapshot too, and this is the only moment we get to tell the
    // joiner about them — nothing re-announces an existing member (see `clusterPresence`).
    const members = await clusterPresence(room, postId, conn.siteId);
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
 * Display names for a set of user ids, for presence entries this node did not build itself.
 * Best-effort: a name is a label, and an unreadable `users` table must not cost anyone their join.
 */
async function displayNames(userIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    // Bounded by construction: a room's membership is capped, and an unbounded IN list is a way to
    // turn a roster read into a scan.
    const ids = [...new Set(userIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
    if (!ids.length) return out;
    try {
        const rows = await dbAsync.all(
            `SELECT id, display_name, user_login FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids,
        );
        for (const r of rows || []) {
            // Same precedence the route uses when it names a live connection, so a member looks the
            // same whichever node happens to describe them.
            out.set(Number(r.id), String(r.display_name || r.user_login || ''));
        }
    } catch (e: any) {
        console.warn('[collab] no se pudieron leer los nombres de los miembros remotos:', e && e.message);
    }
    return out;
}

/**
 * WHO IS IN THE ROOM, ACROSS THE WHOLE CLUSTER.
 *
 * `livePresence` answers out of `room.conns` — the connections THIS process is serving — and that is
 * the right answer to "who am I serving". It stops being the right answer to "who is editing this
 * page" the moment there is a second node, and it fails one-sidedly, which is why it survived: the
 * `members` broadcast DOES cross the bus, so whoever is already connected is told about a newcomer,
 * while the newcomer's own `welcome` roster is assembled locally and never mentions the editors
 * attached to other nodes. With one author per node, the second one to open the page is told
 * «nobody else is editing this page» — and keeps being told that until somebody joins after them.
 *
 * This is the question the destructive decisions already ask BOTH sources (see LIVENESS EN EL
 * CLÚSTER in the header): the local belt, plus `collab_members` — the shared row-per-connection
 * signal that exists precisely to cover the editors of other nodes. The roster was the last place
 * still answering it from one process's memory.
 *
 * The remote half is RECONSTRUCTED, not transported: `siteId`/`userId` come from the shared row, the
 * colour is a pure function of the userId (so every node derives the same one without coordinating —
 * see `colorForUser`), and the name is read from `users`. `sel` starts null deliberately: a cursor
 * position is ephemeral and belongs to the node serving that author, and it arrives with their next
 * `presence` broadcast — exactly as it does for a local member who has not moved yet.
 *
 * Never throws and never blocks a join. A roster is an adornment; an unreadable `collab_members`
 * degrades to "the ones I can see", which is what the code did before this existed.
 */
async function clusterPresence(room: Room, postId: number, exceptSite?: string | null): Promise<PresenceEntry[]> {
    const local = livePresence(room, exceptSite);
    // Same question `broadcast` asks: is there a cluster tier AT ALL? In a single-node install every
    // row in `collab_members` is already one of ours, so there is nothing to go and look for.
    if (!cache.redisConfigured()) return local;

    const since = Date.now() - CONFIG.MEMBER_TTL_MS;
    let rows: any[];
    try {
        rows = await dbAsync.all(
            // `seen_at > since` (positive) on purpose: it excludes the half-joined rows `claimMember`
            // parks at `-now`, for the same reason the roster excludes local conns that are not
            // `ready` — somebody who has not finished entering is not yet in the room.
            'SELECT site_id, user_id FROM collab_members WHERE post_id = ? AND node_id <> ? AND seen_at > ?',
            [postId, NODE_ID, since],
        );
    } catch (e: any) {
        console.warn('[collab] no se pudo leer la presencia del clúster:', e && e.message);
        return local;
    }
    if (!Array.isArray(rows) || !rows.length) return local;

    // A siteId this node is already serving wins: our own connection is first-hand knowledge, and a
    // reconnection that moved between nodes can leave the old row behind for up to MEMBER_TTL_MS.
    const seen = new Set(local.map((m) => m.siteId));
    if (exceptSite) seen.add(exceptSite);
    const remote = new Map<string, number>();
    for (const r of rows) {
        const siteId = String((r && r.site_id) || '');
        if (!siteId || seen.has(siteId)) continue;
        seen.add(siteId);
        remote.set(siteId, Number(r.user_id) || 0);
    }
    if (!remote.size) return local;

    const names = await displayNames([...remote.values()]);
    const now = Date.now();
    const out = local.slice();
    for (const [siteId, userId] of remote) {
        out.push({
            siteId,
            userId,
            name: names.get(userId) || '',
            color: colorForUser(userId),
            sel: null,
            at: now,
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
        // Sala vacía: la cuenta del log deja de tener quien la mantenga al día, y la próxima entrada
        // vuelve a medir. Guardarla sería quedarse con una cifra que otro nodo puede mover a solas.
        forgetLogSize(conn.postId);
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
        // El barrido es también el momento de soltar los cubos de lectura que ya no deben nada.
        pruneReadBuckets(now);

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

        // GEMELA DEL HALLAZGO 20, en pequeño: esta consulta no llevaba NINGUNA cota y traía una fila
        // por cada sala abierta del sitio para descartarlas después en JS. El filtro por antigüedad es
        // el mismo `if (ms > cutoff) continue` de abajo, dicho en SQL —una fila sin marca legible (0)
        // sigue viniendo, porque `0 <= cutoff`, y sigue avisando— y el `LIMIT` acota el lote: retirar
        // salas rancias no es urgente y el barrido vuelve a pasar. Una consulta sin cota es un pico de
        // memoria esperando a que el sitio crezca.
        //
        // PERO UN `LIMIT` SIN CURSOR NO AVANZA. Ordenado por antigüedad, el lote es siempre el de las
        // MÁS ANTIGUAS, y las filas que el bucle descarta —sala viva en este nodo (una pestaña abierta
        // toda la tarde sin teclear) o viva en otro— vuelven a encabezar el orden en la pasada
        // siguiente: con `MAX_SWEEP_ROOMS` salas en ese estado, ninguna sala retirable se examina
        // JAMÁS y `collab_docs`/`collab_ops` crecen sin límite, que es lo contrario de lo que el
        // barrido existe para hacer. Se pagina por CLAVE: el cursor garantiza que cada candidata se
        // mira una vez por vuelta completa, y al agotarse el recorrido vuelve a empezar. Se pierde el
        // «las más viejas primero», y no importa: TODAS las de este lote ya cumplen `updated_ms <=
        // cutoff`, o sea que todas son igual de retirables — el orden solo decidía en qué pasada.
        const rows = await dbAsync.all(
            "SELECT post_id, updated_ms FROM collab_docs WHERE base_doc <> '' AND updated_ms <= ? " +
            'AND post_id > ? ORDER BY post_id ASC LIMIT ?',
            [cutoff, sweepCursor, CONFIG.MAX_SWEEP_ROOMS]);
        const lote: any[] = Array.isArray(rows) ? rows : [];
        // El cursor se mueve ANTES de examinar el lote: si algo revienta a mitad, la pasada siguiente
        // continúa por donde iba en vez de reintentar eternamente las mismas filas.
        sweepCursor = lote.length > 0 && lote.length >= CONFIG.MAX_SWEEP_ROOMS
            ? Number(lote[lote.length - 1].post_id) || 0
            : 0;                                             // vuelta completa: se recomienza
        for (const r of lote) {
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

/**
 * La instrucción que acompaña SIEMPRE a un rechazo por ritmo: cuánto esperar, con qué nº de serie y
 * —lo que hace que el número signifique algo— DE QUÉ CONEXIÓN sale ese número (`seal`).
 */
export type RateInstruction = { retryAfterMs: number; notice: number; seal: string };

type RateVerdict =
    | { ok: true }
    | { ok: false; code: 'rate' | 'closed' | 'too-large'; message: string; rate?: RateInstruction };

/* --- PRESUPUESTO DE LECTURA DEL LOG, POR USUARIO (ver CONFIG.USER_READ_BYTES_PER_SEC) ----------- */

type ReadBucket = { tokens: number; last: number };

/** userId -> cubo. Sobrevive a la conexión A PROPÓSITO: la conexión es justo lo que el atacante recicla. */
const readBuckets = new Map<number, ReadBucket>();
let lastReadPrune = 0;

function refillRead(b: ReadBucket, now: number): void {
    const dt = Math.max(0, now - b.last) / 1000;
    if (dt <= 0) return;
    b.last = now;
    b.tokens = Math.min(CONFIG.USER_READ_BURST, b.tokens + dt * CONFIG.USER_READ_BYTES_PER_SEC);
}

/**
 * Descarta SOLO los cubos llenos: uno lleno no debe nada, así que olvidarlo no perdona ninguna deuda
 * (olvidar uno en descubierto sí la perdonaría, y sería la puerta de atrás del presupuesto). Y no se
 * barre más de una vez por segundo: si TODOS estuvieran en deuda no habría nada que descartar y el
 * barrido se volvería un coste O(n) por usuario nuevo.
 *
 * `forzado` es el caso en el que ese estrangulamiento no puede mandar: al TOCAR el tope hay que
 * intentarlo igualmente, o el tope no es un tope (ver `readBucket`).
 */
function pruneReadBuckets(now: number, forzado = false): void {
    if (!forzado && now - lastReadPrune < 1000) return;
    lastReadPrune = now;
    for (const [userId, b] of readBuckets) {
        refillRead(b, now);
        if (b.tokens >= CONFIG.USER_READ_BURST) readBuckets.delete(userId);
    }
}

/**
 * El cubo del usuario, MANTENIENDO `MAX_READ_BUCKETS` COMO MÁXIMO DE VERDAD.
 *
 * Antes se barría (con el estrangulamiento puesto, así que casi nunca) y se insertaba
 * INCONDICIONALMENTE: un `MAX_` que no acotaba nada. Ahora, si tras el barrido forzado sigue lleno,
 * se desaloja el cubo con MÁS saldo, porque olvidar un cubo PERDONA su deuda y el candidato tiene que
 * ser siempre el que menos debe.
 *
 * LO QUE ESTE TOPE **NO** GARANTIZA, dicho aquí en vez de dado por supuesto. Una versión anterior de este
 * comentario afirmaba que el desalojado «nunca» está en descubierto; el código no lo garantiza y no puede.
 * Si TODOS los cubos deben —el estado de saturación para el que existe el tope— se desaloja igualmente al
 * menos endeudado, y esa deuda se PERDONA: un atacante capaz de hacer aparecer usuarios nuevos puede
 * reciclar su propio descubierto. Se probó a traspasar la deuda al cubo que ocupa el sitio y es PEOR de
 * forma medible: un usuario recién llegado nace frenado por la deuda de otro y se le rechaza la entrada a
 * una sala en la que no ha leído nada (lo caza `audit-collab-x5` «con todos los cubos en DESCUBIERTO»).
 * Entre castigar a un inocente y perdonar una deuda, esto perdona la deuda: el tope es una cota de
 * MEMORIA, y sólo de memoria. La cota real del abuso sostenido es `USER_READ_BYTES_PER_SEC`, que no se
 * puede reciclar. Queda REGISTRADO como riesgo residual, no como propiedad.
 */
function readBucket(userId: number, now: number): ReadBucket {
    let b = readBuckets.get(userId);
    if (b) return b;
    if (readBuckets.size >= CONFIG.MAX_READ_BUCKETS) {
        pruneReadBuckets(now, true);
        while (readBuckets.size >= CONFIG.MAX_READ_BUCKETS) {
            let victima = -1;
            let mejor = -Infinity;
            for (const [id, otro] of readBuckets) {
                refillRead(otro, now);
                if (otro.tokens > mejor) { mejor = otro.tokens; victima = id; }
            }
            if (victima === -1) break;
            readBuckets.delete(victima);
        }
    }
    readBuckets.set(userId, (b = { tokens: CONFIG.USER_READ_BURST, last: now }));
    return b;
}

/** ¿Le queda saldo a este usuario para hacerse servir OTRA lectura del log? */
function canReadLog(userId: number): boolean {
    const now = Date.now();
    const b = readBucket(userId, now);
    refillRead(b, now);
    return b.tokens > 0;
}

/**
 * CUÁNTO HAY QUE ESPERAR DE VERDAD, calculado del cubo QUE BLOQUEA.
 *
 * CLASE DEL DEFECTO: un rechazo que anuncia la espera de OTRO recurso. El rechazo por presupuesto de
 * lectura devolvía `rateInstruction(conn)`, es decir `CONFIG.RATE_RETRY_MS` (900 ms) — la ventana del
 * cubo de la CONEXIÓN, que no tiene nada que ver con la recarga del cubo del USUARIO: `USER_READ_BURST`
 * (16 MB) a `USER_READ_BYTES_PER_SEC` (256 KB/s) son hasta 64 segundos. El cliente deriva TODAS sus
 * esperas del número que le llega, así que reintentaba ~1,1 veces por segundo durante todo el
 * descubierto, y cada reintento pasaba antes por `rateGate` y le COBRABA fichas de escritura por un
 * rechazo que no dependía de ellas. El freno que existe para reducir trabajo generaba trabajo.
 *
 * Regla general, y por eso vive junto al cubo y no junto al rechazo: la espera la calcula SIEMPRE el
 * recurso agotado. Se pide el déficit hasta volver a tener una ficha (`tokens > 0`, que es lo que
 * `canReadLog` exige) y se traduce a milisegundos con SU ritmo de recarga.
 */
function readRetryMs(userId: number, now = Date.now()): number {
    const b = readBuckets.get(userId);
    if (!b) return 0;
    refillRead(b, now);
    if (b.tokens > 0) return 0;
    const faltan = 1 - b.tokens;                       // fichas que faltan para volver a conceder
    return Math.ceil((faltan / CONFIG.USER_READ_BYTES_PER_SEC) * 1000);
}

/* --- TURNO DE LECTURA: las lecturas de un usuario NO se solapan (ver READ_CONCURRENCY_PER_USER) --- */

type ReadSlot = { corriendo: number; cola: (() => void)[] };
const readSlots = new Map<number, ReadSlot>();

/**
 * Pide turno. `false` = la cola de este usuario está llena y la lectura se rechaza como cualquier otro
 * exceso de presupuesto (una cola sin tope sería el mismo amplificador con otro nombre).
 */
function acquireReadSlot(userId: number): Promise<boolean> {
    let s = readSlots.get(userId);
    if (!s) readSlots.set(userId, (s = { corriendo: 0, cola: [] }));
    if (s.corriendo < CONFIG.READ_CONCURRENCY_PER_USER) { s.corriendo++; return Promise.resolve(true); }
    if (s.cola.length >= CONFIG.MAX_QUEUED_READS_PER_USER) return Promise.resolve(false);
    const slot = s;
    return new Promise<boolean>((resolve) => slot.cola.push(() => { slot.corriendo++; resolve(true); }));
}

function releaseReadSlot(userId: number): void {
    const s = readSlots.get(userId);
    if (!s) return;
    s.corriendo = Math.max(0, s.corriendo - 1);
    const siguiente = s.cola.shift();
    if (siguiente) { siguiente(); return; }
    if (s.corriendo === 0) readSlots.delete(userId);
}

/**
 * CUÁNTO CUESTA SERVIR UNA LECTURA, MEDIDO — para que la COLA pueda anunciar SU espera.
 *
 * CLASE D otra vez, en el tercer sitio de rechazo. Cuando la cola de un usuario está llena,
 * `materializeRoom` devolvía `readRetryMs(userId) || CONFIG.RATE_RETRY_MS`: con saldo POSITIVO
 * `readRetryMs` es 0, así que se anunciaban los 900 ms de la ventana del cubo de la CONEXIÓN — el plazo
 * de un recurso que no es el que se ha agotado. El recurso agotado aquí es la cola de lecturas, y lo que
 * la vacía es el TIEMPO QUE TARDA UNA LECTURA, que no es una constante que se pueda escribir: depende de
 * la BD y del tamaño de la sala. Así que se mide.
 *
 * EWMA sobre la duración real del tramo servido, con cada muestra acotada para que un pico patológico no
 * gobierne el plazo de todos. La semilla es deliberadamente pequeña: mientras no haya medida, el plazo
 * anunciado es corto y el cliente vuelve a preguntar — nunca al revés.
 */
const READ_SERVICE_SEED_MS = 120;
const READ_SERVICE_ALPHA = 0.25;
const READ_SERVICE_SAMPLE_MAX_MS = 5000;
let readServiceMs = READ_SERVICE_SEED_MS;

function observeReadService(ms: number): void {
    const muestra = Math.min(READ_SERVICE_SAMPLE_MAX_MS, Math.max(1, ms));
    readServiceMs = readServiceMs + READ_SERVICE_ALPHA * (muestra - readServiceMs);
}

/** La espera que anuncia LA COLA: lo que hay por delante × lo que cuesta servir una lectura. */
function queueRetryMs(userId: number): number {
    const s = readSlots.get(userId);
    const delante = s ? (s.corriendo + s.cola.length) : 1;
    return Math.max(1, Math.ceil(Math.max(1, delante) * readServiceMs));
}

/**
 * TODO LO QUE MATERIALIZA EL ESTADO DE UNA SALA PARA UN CLIENTE PASA POR AQUÍ, Y SE COBRA AQUÍ.
 *
 * CLASE DEL DEFECTO (tercera vez que este amplificador se reabre por una puerta que el arreglo
 * anterior no modeló): el presupuesto de lectura contaba lo que devolvía `loadOps` y NADA MÁS. Pero lo
 * que una entrada a la sala trae al heap no es solo el log: es el SNAPSHOT (`base_doc`, que `ensureDoc`
 * copia entero, y encima `readCanonicalBase` vuelve a leer el `_puck_data` canónico para hasearlo), y
 * ese snapshot viaja al cliente en el `welcome` y en el `resync` de epoch distinto. Con el log VACÍO
 * —el estado de toda sala recién sembrada o recién retirada— `log.bytes` es 0, el cubo no bajaba
 * nunca y las dos puertas volvían a ser gratis con un objeto MÁS GRANDE que el log: el tope del log
 * son 4 MB y `_puck_data` no tiene tope propio.
 *
 * Por eso el arreglo no es «cobrar también el snapshot en los dos sitios» —eso es otra pareja de
 * guards que la próxima puerta vuelve a rodear— sino que EL ÚNICO CAMINO a `ensureDoc`/`loadOps` desde
 * fuera sea esta función. Un materializador nuevo (una vista previa, un export, un modo lector) que
 * llame directo a `ensureDoc` no es un olvido menor: es este mismo defecto otra vez, y el test de la
 * clase lo pone rojo.
 *
 * Y SE SIRVE DE UNO EN UNO POR USUARIO (`acquireReadSlot`). Ése es el otro medio arreglo que faltaba:
 * mirar el saldo y cobrarlo con tres `await` en medio deja pasar N lecturas simultáneas con el mismo
 * saldo (ver `READ_CONCURRENCY_PER_USER`). Serializando, el cheque de dentro del turno ve lo que
 * cobró el anterior y el descubierto vuelve a ser UNA lectura, que es lo que el comentario de
 * `USER_READ_BYTES_PER_SEC` afirma.
 */
type Materialized =
    | { ok: true; doc: DocState; ops: any[]; bytes: number; unreadable: number; budgetHit: boolean }
    | { ok: false; retryAfterMs: number };

async function materializeRoom(
    userId: number, postId: number, opts: { reseed: boolean; exceptConnId?: string | null },
): Promise<Materialized> {
    // Rechazo BARATO: sin saldo no se pide turno ni se toca la BD.
    if (!canReadLog(userId)) return { ok: false, retryAfterMs: readRetryMs(userId) };
    // COLA LLENA: el recurso agotado es LA COLA, así que el plazo lo calcula la cola (`queueRetryMs`),
    // no `CONFIG.RATE_RETRY_MS`, que es la ventana del cubo de la conexión. Se toma el máximo con el
    // cubo de lectura porque, si además hay descubierto, las DOS esperas tienen que cumplirse.
    if (!(await acquireReadSlot(userId))) {
        return { ok: false, retryAfterMs: Math.max(queueRetryMs(userId), readRetryMs(userId)) };
    }
    const comenzado = Date.now();
    try {
        // El cheque QUE MANDA: dentro del turno, y ANTES de leer el snapshot. El de arriba pudo verse
        // un saldo que la lectura anterior de este mismo usuario ya se ha gastado.
        if (!canReadLog(userId)) return { ok: false, retryAfterMs: readRetryMs(userId) };
        const doc = await ensureDoc(postId, opts.reseed, opts.exceptConnId);
        const log = await loadOps(postId, doc.epoch);
        // LAS DOS COSAS QUE SE HAN MATERIALIZADO, en la misma unidad y contra el mismo cubo.
        const bytes = log.bytes + Buffer.byteLength(String(doc.base || ''), 'utf8');
        chargeReadBytes(userId, bytes);
        // Sólo una lectura REALIZADA es una muestra del coste de servir una: los rechazos de arriba
        // salen antes de tocar la BD y medirlos hundiría la estimación de la cola.
        observeReadService(Date.now() - comenzado);
        return { ok: true, doc, ops: log.ops, bytes, unreadable: log.unreadable, budgetHit: log.budgetHit };
    } finally {
        releaseReadSlot(userId);
    }
}

/**
 * Cobra bytes YA servidos. SIN SUELO, y esa es la diferencia con `chargeBytes`: aquí la deuda tiene
 * que ser PROPORCIONAL a lo servido, porque es la única que decide si se vuelve a leer el log.
 */
function chargeReadBytes(userId: number, bytes: number): void {
    const now = Date.now();
    const b = readBucket(userId, now);
    refillRead(b, now);
    b.tokens -= Math.max(0, bytes);
}

/* ---------------------------------------------------------------------------------------------- */

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
 *   · cada rechazo emite una INSTRUCCIÓN `{retryAfterMs, notice, seal}` — `notice` es un número de
 *     serie monótono por conexión, `rateRetryAt` su plazo (medido con el RELOJ DEL SERVIDOR) y
 *     `seal` la identidad de la conexión que lo acuñó;
 *   · el cliente devuelve en cada frame el último `notice` que ha VISTO **con su sello**;
 *   · solo es desobediencia un frame que llega con `rateAck >= notice` vigente y ANTES del plazo: el
 *     cliente reconoce haber recibido esta instrucción concreta y aun así mandó dentro de su ventana.
 *
 * EL SELLO ES LA RONDA 5, y es lo que hace verdadera la frase de la ronda 4. Aquella decía «un frame
 * en vuelo trae un acuse ANTERIOR y por construcción no puede contar», y era FALSA con reconexiones:
 * la condición no mira el acuse que trae el frame juzgado, mira `conn.rateAck`, el máximo monótono de
 * la conexión. Como el número de serie es POR CONEXIÓN y la nueva nace en 0, un POST rezagado de la
 * conexión anterior con acuse 4 dejaba `rateAck = 4` contra `rateNotice = 0`: a partir de ahí TODOS
 * los avisos 1..4 de la conexión nueva nacían ya "reconocidos" y cualquier frame dentro de un plazo
 * vivo —en vuelo o no— sumaba strike. Un cliente impecable acababa fuera en ~4 s. Con el sello, ese
 * acuse ni siquiera se anota (ver `noteRateAck`): no hay número que un tercero —ni el propio cliente
 * en otra conexión— pueda aplicar aquí.
 *
 * Y `conn.welcomed` cierra la otra mitad de la misma ventana: entre el alta síncrona de `join()` y el
 * `welcome` que escribe la ruta, la conexión ya acepta frames pero todavía no se ha presentado; ahí
 * se rechaza, pero no se castiga.
 *
 * Un cliente que espera manda después del plazo y tampoco cuenta. Ninguna latencia, ningún
 * planificador roto, ninguna reconexión y ningún reparto de la carga entre canales puede fabricar esa
 * prueba: por eso el defecto no puede volver a mudarse de sitio, y por eso el número de la espera ya
 * no puede desincronizarse (solo hay uno, `CONFIG.RATE_RETRY_MS`, y viaja con cada rechazo).
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
/**
 * ACUÑA (o REPITE) la instrucción de espera vigente de esta conexión. Está aquí, y no dentro de
 * `rateGate`, porque hay más de un motivo para frenar a alguien —el cubo de la conexión y el
 * presupuesto de lectura del usuario— y todos tienen que emitir EXACTAMENTE la misma forma: un plazo,
 * un número de serie y el sello de quién lo acuñó.
 *
 * La instrucción solo se RENUEVA cuando la anterior ha vencido: mientras una está en vigor, repetirla
 * movería el plazo hacia delante y volvería inalcanzable el número de serie que el cliente tiene que
 * reconocer — justo la puerta por la que un cliente que la ignora se haría inmune a los strikes. Un
 * plazo, un número de serie.
 */
function rateInstruction(conn: Conn, now = Date.now()): RateInstruction {
    if (!(now < conn.rateRetryAt)) {
        conn.rateNotice++;
        conn.rateRetryAt = now + CONFIG.RATE_RETRY_MS;
    }
    return {
        retryAfterMs: Math.max(0, conn.rateRetryAt - now),
        notice: conn.rateNotice,
        // El número va SIEMPRE acompañado de quién lo acuñó: sin esto, "aviso 1" es una frase sin
        // sujeto y el acuse de una conexión se aplica en otra.
        seal: conn.rateSeal,
    };
}

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
        // ¿Hay una instrucción VIGENTE de ESTA conexión, ya presentada, y este frame demuestra
        // conocerla? Ésa es toda la condición de expulsión del módulo, y está escrita una sola vez.
        //
        // `conn.welcomed` cierra la ventana alta→`welcome`: `join()` da de alta la conexión de forma
        // SÍNCRONA y desde ese instante acepta frames, pero la ruta todavía no ha escrito el
        // `welcome`. Una conexión que aún no se ha presentado no puede exigirle a nadie que reconozca
        // sus instrucciones — el cliente ni siquiera sabe que existe.
        const vigente = now < conn.rateRetryAt;
        if (vigente && conn.welcomed && conn.rateAck >= conn.rateNotice) {
            conn.strikes++;
            if (conn.strikes >= CONFIG.MAX_STRIKES) {
                writeEvent(conn, 'error', { code: 'rate_limit', message: 'Demasiadas operaciones: conexión cerrada.' });
                void leave(conn);
                return { ok: false, code: 'closed', message: 'Conexión cerrada por exceso de operaciones.' };
            }
        }
        return {
            ok: false,
            code: 'rate',
            message: 'Demasiadas operaciones. Reduce el ritmo.',
            rate: rateInstruction(conn, now),
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
 * EL RECHAZO POR PRESUPUESTO DE LECTURA, con SU espera y con SU código.
 *
 * Dos cosas lo separan de `rateFailure`, y las dos son el arreglo:
 *   · el PLAZO sale del cubo que bloquea (`readRetryMs`), no de `CONFIG.RATE_RETRY_MS`, que es la
 *     ventana de otro recurso y puede quedarse 70 veces corta;
 *   · el CÓDIGO es propio (`collab_read_budget`) para que el cliente pueda frenar SOLO la lectura.
 *     Con `collab_rate_limit` el cliente aplica su freno global —una espera de un minuto congelaría
 *     también la SUBIDA de ops— y un descubierto de lectura no puede impedir escribir; eso es
 *     exactamente lo que el cubo aparte de `chargeReadBytes` existe para no hacer.
 * El número de serie y el sello siguen viajando, como en todo rechazo del módulo: son la identidad de
 * la instrucción, no el plazo.
 */
function readBudgetFailure(conn: Conn, retryAfterMs?: number): {
    status: number; code: string; message: string; rate: RateInstruction;
} {
    const now = Date.now();
    const base = rateInstruction(conn, now);
    const espera = Math.max(1, retryAfterMs ?? readRetryMs(conn.userId, now), base.retryAfterMs);
    return {
        status: 429,
        code: 'collab_read_budget',
        message: 'Demasiadas lecturas del histórico. Reduce el ritmo.',
        rate: { ...base, retryAfterMs: espera },
    };
}

/**
 * Anota el aviso que el cliente DICE haber visto. Se llama desde `connGate`, que es la única puerta
 * por la que una ruta de subida consigue una `conn`: así ningún camino nuevo puede olvidarse de
 * pasarlo (que fue exactamente cómo el defecto se mudó de camino tres veces).
 *
 * UN ACUSE ES UN PAR, NO UN NÚMERO. El número de serie lo lleva la CONEXIÓN y arranca en 0 en cada
 * una, así que un número suelto no dice de qué conexión habla. Con solo el número, el defecto de la
 * ronda 5 era inevitable y no hacía falta ningún cliente malintencionado: al reconectar, un POST
 * que sale de la conexión vieja aterriza en la nueva —`join()` la da de alta de forma síncrona,
 * antes del `welcome`— con un acuse de, digamos, 4; `Math.max` lo grababa contra un contador que iba
 * por 0 y ya no bajaba nunca. Desde ese momento el servidor creía que el cliente había acusado
 * avisos que aún no había emitido y el PRIMER 429 real ya contaba como desobediencia.
 *
 * Ahora el acuse solo se aplica si viene sellado por ESTA conexión. Uno de otra no es un acuse
 * viejo: no es un acuse, y se ignora entero. Por eso no hay caso especial de "reconexión" en ningún
 * sitio — no hay una frontera que reconocer, hay una identidad que no coincide.
 *
 * Sigue siendo un dato del cliente y solo puede perjudicarle: declarar de menos = no se le puede
 * probar nada (y se le rechaza todo igualmente); declarar de más = se autoinculpa, y el sello lo
 * tiene porque se lo mandamos a él.
 */
function noteRateAck(conn: Conn, rawAck: any, rawSeal: any): void {
    if (typeof rawSeal !== 'string' || rawSeal !== conn.rateSeal) return;
    const n = Number(rawAck);
    if (!Number.isFinite(n) || n <= 0) return;
    conn.rateAck = Math.max(conn.rateAck, Math.min(n, Number.MAX_SAFE_INTEGER));
}

/**
 * Cobra bytes YA servidos (la respuesta de un `resync`) al cubo de LA CONEXIÓN. Deja el cubo en
 * descubierto, pero con SUELO.
 *
 * EL SUELO ES DELIBERADO Y NO ES EL LÍMITE DE LA LECTURA. Este cubo es también el que paga la SUBIDA
 * de ops (`pushOps` cobra aquí los bytes del frame): una deuda proporcional a un log de 8 MB serían
 * más de dos minutos sin poder ENVIAR nada, o sea alguien tecleando contra un servidor que le rechaza
 * todo por haber leído lo que se le sirvió. Con el suelo en una ráfaga, el peor caso vuelve a cero en
 * `BYTES_BURST / MAX_BYTES_PER_SEC` segundos: un frenazo, no una expulsión.
 *
 * Lo que el suelo NO puede seguir siendo es la única cota de la LECTURA, porque efectivamente la hace
 * CONSTANTE: servir 8 MB deja el cubo igual que servir 300 KB, y el repetidor obtiene ~1,9 MB/s por
 * conexión frente a los 64 KB/s que `MAX_BYTES_PER_SEC` declara. La deuda proporcional vive en el
 * presupuesto POR USUARIO (`chargeReadBytes`), que no tiene suelo, no frena la subida de nadie y —al
 * colgar del usuario y no de la conexión— tampoco se puede reciclar reconectando.
 */
function chargeBytes(conn: Conn, bytes: number): void {
    refill(conn, Date.now());
    conn.byteTokens = Math.max(-CONFIG.BYTES_BURST, conn.byteTokens - Math.max(0, bytes));
}

/**
 * DEVUELVE un cobro de `rateGate` que resultó no corresponder a trabajo hecho.
 *
 * CLASE D, el miembro que la reordenación de `resync` NO cubre. El orden nuevo (mirar el presupuesto de
 * LECTURA antes que el cubo de la CONEXIÓN) cierra sólo el camino RÁPIDO: si al entrar quedaba saldo,
 * `rateGate` ya ha descontado `RESYNC_OP_COST` fichas y el mínimo de bytes cuando `materializeRoom`
 * rechaza por presupuesto DENTRO del turno — y el cheque de dentro del turno es el que manda. Con
 * `READ_CONCURRENCY_PER_USER = 1` las lecturas del mismo usuario se serializan, así que dos pestañas
 * reanudando a la vez (el caso normal tras un `room_reset`, que el cliente traduce en un `resync`
 * inmediato) hacen que la segunda pague ESCRITURA por un rechazo de LECTURA. Eso es exactamente el
 * enunciado de la clase: el rechazo de un recurso no puede gastar otro.
 *
 * Devolver es preferible a mover `rateGate` detrás de `materializeRoom`: el cubo de la conexión existe
 * para frenar ANTES de tocar la BD, y moverlo lo convertiría en una contabilidad a posteriori.
 * El techo es el mismo que aplica `refill`, así que un reembolso nunca crea saldo de la nada.
 */
function refundRate(conn: Conn, ops: number, bytes: number, presence = 0): void {
    conn.opTokens = Math.min(CONFIG.OPS_BURST, conn.opTokens + Math.max(0, ops));
    conn.byteTokens = Math.min(CONFIG.BYTES_BURST, conn.byteTokens + Math.max(0, bytes));
    conn.presenceTokens = Math.min(CONFIG.PRESENCE_BURST, conn.presenceTokens + Math.max(0, presence));
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
    //
    // EL TOPE ES DOBLE, Y EL DE BYTES ES EL QUE FALTABA. Con solo el de filas, un contributor sobre
    // su PROPIO borrador manda un `propSet` de ~250 KB cada pocos segundos (cabe en `LIMITS.STRING` y
    // en `MAX_FRAME_BYTES`, y el ritmo lo permite `MAX_BYTES_PER_SEC`) hasta ~1,25 GB de log, que
    // luego `loadOps` tenía que traerse entero por cada entrada en la sala.
    //
    // La bandera `truncated` es PEGAJOSA y aquí se lee como lo que es: «este epoch ya dejó de ser
    // reanudable». Si ya está puesta no se vuelve a medir el log —la medida cuesta recorrer los
    // payloads— y no se persiste más. Es equivalente a lo que pasaba antes por el tope de filas (una
    // vez marcada, el contador ya estaba en el tope), solo que ahora está DICHO.
    const yaTruncada = Number(current.truncated) === 1;
    const frameBytes = frame.ops.reduce(
        (n: number, op: any) => n + Buffer.byteLength(JSON.stringify(op), 'utf8'), 0);
    let persisted = false;
    if (!yaTruncada) {
        // `logSizeCached`, NO `logSize`: medir el log con un `SUM` sobre los payloads en CADA frame es
        // cuadrático y, con better-sqlite3 (síncrono), bloquea el event loop del proceso entero. Ver
        // la cabecera de `logSizeCached`.
        const log = await logSizeCached(conn.postId, liveEpoch, Date.now());
        persisted = log.count + frame.ops.length <= CONFIG.MAX_OPS_PER_EPOCH
            && log.bytes + frameBytes <= CONFIG.MAX_LOG_BYTES_PER_EPOCH;
    }
    const stored: any[] = [];
    let accepted = 0;
    let acceptedBytes = 0;
    let known = 0;

    if (persisted) {
        for (let i = 0; i < frame.ops.length; i++) {
            const op = frame.ops[i];
            const srcIndex = frame.srcIndex[i];
            // El payload se serializa UNA vez: es lo que se inserta y lo que se suma al tamaño del
            // log, así que la cuenta y la fila son literalmente la misma cadena.
            const payload = JSON.stringify(op);
            try {
                await dbAsync.run(
                    'INSERT INTO collab_ops (post_id, epoch, site_id, counter, kind, payload, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [conn.postId, liveEpoch, conn.siteId, op.id.counter, op.k, payload, conn.userId]
                );
                stored.push(op);
                accepted++;
                acceptedBytes += Buffer.byteLength(payload, 'utf8');
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
            // La cuenta en memoria se mueve con la MISMA verdad que la fila: solo lo insertado.
            noteLogGrowth(conn.postId, liveEpoch, accepted, acceptedBytes);
            await dbAsync.run(
                'UPDATE collab_docs SET ops_count = ops_count + ?, updated_at = CURRENT_TIMESTAMP, updated_ms = ? WHERE post_id = ?',
                [accepted, Date.now(), conn.postId]
            );
        }
    } else {
        // Tope alcanzado —de filas o de BYTES: se sigue COLABORANDO (la difusión no para) pero la
        // reanudación ya no está garantizada. La bandera es PEGAJOSA en la BD porque el contador de
        // filas se queda por DEBAJO del tope — derivar la señal de él le decía "log completo" a todo
        // el que entraba mientras faltaban todas las ediciones posteriores. Y el aviso va a TODA la
        // sala: los demás también han dejado de tener sesión reanudable, no solo quien emitió el
        // frame que no cupo.
        stored.push(...frame.ops);
        accepted = frame.ops.length;
        // Solo la PRIMERA vez: una vez marcada, repetir el UPDATE en cada frame es escritura pura de
        // amplificación sobre una fila que ya dice lo que tiene que decir.
        if (!yaTruncada) {
            try {
                await dbAsync.run('UPDATE collab_docs SET truncated = 1, updated_ms = ? WHERE post_id = ?',
                    [Date.now(), conn.postId]);
            } catch (e: any) {
                console.warn('[collab] no se pudo marcar la sala como truncada:', e && e.message);
            }
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

    // EL COBRO EN BYTES SE HACE ANTES, AUNQUE TODAVÍA NO SE SEPA CUÁNTO PESA. Se cobraba
    // `rateGate(conn, RESYNC_OP_COST, 0)`, y con `bytes = 0` la condición de rechazo del cubo de
    // bytes —`(bytes > 0 && conn.byteTokens < bytes)`— es falsa SIEMPRE: la deuda que dejaba
    // `chargeBytes` tras servir un log entero no frenaba el siguiente `resync` en absoluto. Cobrando
    // un mínimo por adelantado el cubo se MIRA, así que el descubierto vuelve a ser una espera; el
    // resto se cobra abajo, cuando ya se sabe el tamaño real.
    const minBytes = Math.max(1, Math.floor(CONFIG.BYTES_BURST / CONFIG.RESYNC_MIN_BYTES_DIVISOR));

    // EL PRESUPUESTO DE LECTURA SE MIRA ANTES QUE EL CUBO DE LA CONEXIÓN, y el orden es el arreglo:
    // al revés, un rechazo que NO depende de las fichas de la conexión se las gastaba igualmente
    // (10 fichas de ops + 16 KB por cada reintento) y además reseteaba `strikes`. Un usuario en
    // descubierto de LECTURA acababa pagando presupuesto de ESCRITURA por no hacer nada malo.
    if (!canReadLog(conn.userId)) return { ok: false, ...readBudgetFailure(conn) };

    const verdict = rateGate(conn, CONFIG.RESYNC_OP_COST, minBytes);
    if (!verdict.ok) return { ok: false, ...rateFailure(verdict) };

    // MISMO CAMINO Y MISMA CONTABILIDAD QUE `join`: es la misma lectura, y lo que se materializa es el
    // log MÁS el snapshot (`ensureDoc` trae `base_doc` en todas las llamadas, se devuelva o no).
    const servido = await materializeRoom(conn.userId, conn.postId, { reseed: false });
    if (!servido.ok) {
        // SITIO DE RECHAZO nº2 (dentro del turno) y nº3 (cola llena). El cheque rápido de arriba dijo que
        // sí, así que `rateGate` YA cobró — y este rechazo no depende de esas fichas. Se devuelven: un
        // rechazo de LECTURA no puede dejar al usuario sin presupuesto de ESCRITURA. Ver `refundRate`.
        refundRate(conn, CONFIG.RESYNC_OP_COST, minBytes);
        return { ok: false, ...readBudgetFailure(conn, servido.retryAfterMs) };
    }
    const doc = servido.doc;
    const { ops: all, bytes, unreadable, budgetHit } = servido;
    // `unreadable > 0` ⇒ el log que se sirve NO es el que se aceptó. Derivar `complete` solo del
    // recuento YA PARSEADO respondía `complete: true` MINTIENDO, y el cliente daba por recuperado un
    // histórico al que le faltaban ops. `budgetHit` es lo mismo por tamaño: el log no cabía entero.
    const complete = !doc.truncated && all.length < CONFIG.MAX_OPS_PER_EPOCH
        && unreadable === 0 && !budgetHit;

    // Lo LEÍDO se cobra entero aunque se filtre después: el coste que hay que frenar es el de
    // recorrer la sala, no el del recorte que le toque a este cliente. Se descuenta el mínimo que ya
    // cobró `rateGate` para no cobrarlo dos veces.
    chargeBytes(conn, Math.max(0, bytes - minBytes));

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
    logSizes.clear();
    readBuckets.clear();
    readSlots.clear();
    lastReadPrune = 0;
    sweepCursor = 0;
}

module.exports = {
    CONFIG, NODE_ID, CHANNEL,
    colorForUser, initClusterBus, replicaId,
    join, leave, pushOps, setPresence, resync, findConn, noteRateAck,
    // `ensureDoc` YA NO SE EXPORTA. Era el sumidero del amplificador (copia `base_doc` entero al heap y
    // relee `_puck_data` para hashearlo) y estaba publicado en todo el repo, mientras la garantía «el
    // único camino es `materializeRoom`» sólo la vigilaba un test que lee UN fichero. Que nadie lo
    // llamara hoy era una observación, no una cota. Lo que se publica es el camino QUE COBRA.
    livePresence, retireRoom, sweepIdleRooms, liveMembers, materializeRoom,
    writeEvent, stats, _resetForTests,
    // La retryabilidad de un rechazo la decide QUIEN LO ACUÑA (ver `REFUSAL_RETRYABLE`): la ruta la
    // pone en el cable para que el cliente no tenga que mantener una segunda copia de la lista.
    refusalIsRetryable,
    // Solo para los tests de DIALECTO: las ramas Postgres y MySQL de esta expresión no las ejercita
    // ninguna suite (todas corren en SQLite) y son SQL que se va a producción sin que nadie lo mire.
    _payloadBytesExpr: payloadBytesExpr,
    _rooms: rooms,
    // Solo para el test de la COTA: `MAX_READ_BUCKETS` no se puede comprobar desde fuera sin ver el Map.
    _readBuckets: readBuckets,
};
