/**
 * Verso/colaboración — SESIÓN DE CLIENTE (F8.3).
 *
 * Une las tres piezas que ya existen y no reimplementa ninguna:
 *   · el núcleo CRDT (`../crdt`) pone la convergencia,
 *   · el puente comando↔op (`commandToOps`) pone la traducción,
 *   · el transporte (SSE + POST) pone el reparto.
 *
 * Esta clase es PURA respecto de React y del DOM: no importa `react` ni toca `window` salvo a
 * través del `CollabTransport` inyectado. Por eso se puede probar entera en Node con un servidor de
 * mentira que reordene y duplique mensajes a voluntad — que es como se prueba la convergencia a
 * través del transporte (`__tests__/collab-convergence.test.ts`).
 *
 * INVARIANTE QUE NO SE ROMPE: la UI y el DnD siguen emitiendo SOLO comandos. La sesión traduce el
 * comando EFECTIVO (el que devuelve `applyCommand`, con índices clampados e `idMap` resuelto) a
 * ops; nunca muta el documento por su cuenta. Un fallo del canal no puede corromper el documento
 * porque no puede escribirlo: solo puede dejar de enviar.
 */

import { toNormalized } from "../normalize";
import type { SlotResolver, VersoData, VersoDoc, VersoHistoryCommand } from "../types";
import {
  commandToOps,
  createSiteId,
  toCrdt,
  type CollabOp,
  type CrdtDoc,
  type RichTextResolver,
  type VersionVector,
} from "../crdt";
import type {
  CollabMember,
  CollabNotice,
  CollabOpLike,
  CollabSelection,
  CollabSelf,
  CollabStatus,
  CollabTransport,
  OpsResponse,
  SessionSnapshot,
  StreamHandle,
  WelcomeMessage,
} from "./types";

export interface CollabSessionOptions {
  postId: number;
  transport: CollabTransport;
  /** Base de la API. Relativa a propósito: funciona detrás del gateway en cualquier puerto. */
  apiBase?: string;
  isSlot?: SlotResolver;
  isRichText?: RichTextResolver;
  /** Ventana de agrupación de ops antes de un POST. Una ráfaga de pulsaciones = un frame. */
  flushMs?: number;
  /** Coalescencia de la presencia: un `selectionchange` no es un frame de red. */
  presenceMs?: number;
  /** Reintentos de reconexión antes de rendirse y quedarse en local. */
  maxRetries?: number;
  siteId?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface SessionListeners {
  /** Proyección VIGENTE tras aplicar ops REMOTAS. No se llama por cambios locales. */
  onRemoteDoc?: (doc: VersoDoc, ops: readonly CollabOp[]) => void;
  /** Primer documento de la sesión (el snapshot del epoch ya con el log aplicado). */
  onReady?: (doc: VersoDoc, self: CollabSelf) => void;
  onChange?: (snapshot: SessionSnapshot) => void;
  onNotice?: (notice: CollabNotice) => void;
}

const DEFAULTS = {
  flushMs: 100,
  presenceMs: 50,
  maxRetries: 6,
};

/**
 * Ops por POST. El validador del servidor tumba el frame entero por encima de su tope, así que un
 * outbox grande (duplicar una sección, reescribir un titular: el puente emite un borrado y una
 * inserción POR CARÁCTER) se enviaba como un frame imposible y volvía en bucle. Se trocea aquí.
 */
const MAX_OPS_PER_FLUSH = 400;

/**
 * Rechazos de sala que SÍ tienen sentido reintentar. Tratarlos todos como definitivos dejaba al
 * editor mudo tras un parpadeo de red — replicando en local sin que nadie lo recibiera — hasta
 * recargar la página, y sin gastar ni uno de los reintentos con backoff.
 */
const RETRYABLE_REFUSALS = new Set([
  "site-taken", "too-many-tabs", "too-many-connections", "server-full", "server-error",
]);

/**
 * ESPERA MÍNIMA TRAS UN 429, y margen sobre la que exige el servidor.
 *
 * El servidor cuenta un strike a quien reintenta antes de su `RATE_RETRY_MS` y a los tres CIERRA la
 * sesión — que este cliente trata como terminal: editor mudo hasta recargar la página. Estos 1000 ms
 * fijos y los 900 del servidor vivían en ficheros distintos sin nada que los atara: funcionaba por
 * 100 ms de casualidad. Ahora el servidor publica su ventana en `welcome.limits.rateRetryMs` y aquí
 * se espera SIEMPRE algo más que ella; el suelo cubre a un servidor que no la publique y el techo
 * impide que un valor absurdo (o manipulado) deje al editor parado indefinidamente.
 */
const RATE_BACKOFF_MS = 1000;
const RATE_BACKOFF_MARGIN_MS = 100;
const RATE_BACKOFF_CAP_MS = 30_000;

/** Espera tras un fallo del servidor que NO es de ritmo (5xx, red caída). */
const RETRY_BACKOFF_MS = 1000;

/**
 * Presupuesto de reintentos del envío. Sin tope, un 5xx permanente —o el 503 de una fila del log que
 * no se puede releer, que por construcción no se arregla solo— dejaba la pestaña posteando `/ops`
 * una vez por segundo PARA SIEMPRE: 3600 peticiones/hora, cada una pagando `authenticate` +
 * `Post.findById` + `capsForType`, y el `apiLimiter` global (1000 req/15 min POR IP) agotado en ~17
 * min para todo el que comparta esa IP. Es el mismo bucle que se cerró en el stream con
 * `maxRetries`, por la otra puerta. Al agotarse se dice CLARO que hay que guardar a mano.
 */
const MAX_FLUSH_RETRIES = 8;

export class VersoCollabSession {
  private readonly opts: Required<Pick<CollabSessionOptions, "postId" | "transport">> & CollabSessionOptions;
  private readonly listeners: SessionListeners;
  /**
   * NONCE de la pestaña. Es lo ÚNICO que viaja en la query del stream, y no cambia en toda la vida
   * de la sesión.
   *
   * Guardarlo aparte de la identidad no es cosmética, es el arreglo de un fallo de pérdida: el
   * servidor deriva la identidad con `HMAC(clave, "<userId>:<nonce>")`, que NO es idempotente.
   * Reutilizando una sola variable, la reconexión mandaba la identidad DERIVADA como nonce y salía
   * otra identidad distinta — con la forma correcta, así que ni un 400 saltaba. Consecuencias en
   * cada parpadeo de red: `identityChanged` vaciaba el outbox (ediciones a la basura), se
   * reconstruía el estado y `onReady` volvía a disparar, lo que en el editor es
   * `applyRemoteDoc(doc, { resetHistory: true })` — canvas pisado y pila de deshacer borrada. Y en
   * el servidor la conexión vieja no se desalojaba (busca por identidad), así que a las tres
   * reconexiones el propio editor se autobloqueaba con `too-many-tabs`.
   */
  private readonly nonce: string;
  /**
   * Identidad de RÉPLICA. Arranca como el nonce local y se sustituye por la que DERIVA el servidor
   * en el `welcome` (§2.1): así el identificador con el que se firman las ops no es un dato del
   * cliente, y presentar el de otro editor no sirve para emitir a su nombre.
   */
  private siteId: string;
  private readonly base: string;

  private state: CrdtDoc | null = null;
  private stream: StreamHandle | null = null;
  private status: CollabStatus = "off";
  private self: CollabSelf | null = null;
  private members = new Map<string, CollabMember>();
  private epoch = 0;
  private notice: CollabNotice | null = null;

  /** Ops emitidas localmente y aún no confirmadas por el servidor. */
  private outbox: CollabOp[] = [];
  /**
   * Dots efectivamente APLICADOS, por sitio.
   *
   * No se usa el `vv` del núcleo para pedir un `resync`, y el motivo es sutil y costó un test: el
   * `vv` del núcleo es un vector de MÁXIMOS (`max(counter) visto por sitio`), que solo equivale a
   * "lo tengo todo hasta ahí" bajo entrega CAUSAL. Si hay un hueco — que es exactamente cuando se
   * pide un resync — el máximo miente: recibir `s@3` sin haber visto `s@1` y `s@2` deja `vv[s]=3`,
   * y el servidor concluiría que no falta nada. Aquí se guarda el conjunto real y se deriva el
   * PREFIJO DENSO (`1..n` todos presentes), que es lo único que un version vector puede afirmar.
   */
  private readonly appliedDots = new Map<string, Set<number>>();
  private flushTimer: unknown = null;
  private flushing = false;
  private presenceTimer: unknown = null;
  private pendingSel: CollabSelection | null = null;
  private presenceDirty = false;
  private resyncTimer: unknown = null;
  private retries = 0;
  private stopped = false;
  /** Espera del PRÓXIMO envío. Un 429 o un fallo de guardado la suben; se consume una sola vez. */
  private backoffMs = 0;
  /** Igual que `backoffMs`, para el canal de PRESENCIA, que tiene su propio temporizador. */
  private presenceBackoffMs = 0;
  /** Ventana de espera que el SERVIDOR publica en el `welcome` (`CONFIG.RATE_RETRY_MS`). */
  private serverRetryMs = 0;
  /** Reintentos consecutivos del envío sin que el servidor se haya hecho cargo del lote. */
  private flushRetries = 0;
  private flushGaveUp = false;
  /** Tope vivo de ops por POST: baja al recibir un 413 y vuelve al máximo al aceptarse un lote. */
  private flushCap = MAX_OPS_PER_FLUSH;
  /** Dots ya corregidos con el valor saneado del servidor: corta cualquier bucle de corrección. */
  private readonly repairedDots = new Set<string>();
  private normalizedNoticeSent = false;

  constructor(opts: CollabSessionOptions, listeners: SessionListeners = {}) {
    this.opts = opts as VersoCollabSession["opts"];
    this.listeners = listeners;
    this.nonce = opts.siteId ?? createSiteId();
    this.siteId = this.nonce;
    this.base = (opts.apiBase ?? "/api/v1").replace(/\/+$/, "");
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Ciclo de vida                                                                               */
  /* ----------------------------------------------------------------------------------------- */

  start(): void {
    if (this.stream || this.stopped) return;
    this.setStatus("connecting");
    this.openStream();
  }

  stop(): void {
    this.stopped = true;
    this.clear(this.flushTimer); this.flushTimer = null;
    this.clear(this.presenceTimer); this.presenceTimer = null;
    this.clear(this.resyncTimer); this.resyncTimer = null;
    this.stream?.close();
    this.stream = null;
    // Baja explícita para que los demás vean marcharse el avatar sin esperar al TTL. Es
    // best-effort a propósito: si el navegador se está cerrando, el TTL del servidor lo cubre.
    if (this.self) void this.post("leave", { siteId: this.siteId }).catch(() => undefined);
    this.setStatus("off");
  }

  private openStream(): void {
    // SIEMPRE el nonce, nunca `this.siteId`: ver el comentario de `nonce`. Mandar la identidad
    // derivada deriva otra identidad y destruye la sesión en silencio.
    const url = `${this.base}/collab/${this.opts.postId}/stream?siteId=${encodeURIComponent(this.nonce)}`;
    this.stream = this.opts.transport.openStream(url, {
      // El contador de reintentos NO se pone a cero aquí. Un socket abierto no es una sesión: el
      // servidor ya mandó las cabeceras cuando decide rechazar, así que un `too-many-tabs` o un
      // `server-full` viajan DENTRO del stream con HTTP 200 y `onopen` dispara igual. Reseteando en
      // la apertura, la guarda `retries < maxRetries` no se alcanzaba nunca y una pestaña de más
      // gastaba una petición por segundo para siempre — con `server-full`, TODOS los editores a la
      // vez, realimentando justo la saturación que provocó el rechazo. Se pone a cero en el
      // `welcome`, que es cuando la sesión existe de verdad.
      onOpen: () => undefined,
      onEvent: (event, data) => this.onEvent(event, data),
      onError: (err) => this.onTransportError(err),
    });
  }

  private onTransportError(err: unknown): void {
    if (this.stopped) return;
    this.stream?.close();
    this.stream = null;
    this.setStatus("offline");

    if (this.retries >= (this.opts.maxRetries ?? DEFAULTS.maxRetries)) {
      this.emitNotice({
        code: "transport-error",
        message: "Se perdió la conexión con la sesión colaborativa. Tus cambios siguen guardándose al pulsar Guardar.",
        at: this.time(),
      });
      return;
    }
    // Backoff exponencial con techo: reconectar en bucle cerrado contra un servidor caído sería
    // exactamente el comportamiento que hace caer al servidor cuando vuelve.
    const delay = Math.min(1000 * 2 ** this.retries, 30_000);
    this.retries++;
    void err;
    this.later(delay, () => { if (!this.stopped) this.openStream(); });
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Entrada                                                                                     */
  /* ----------------------------------------------------------------------------------------- */

  private onEvent(event: string, data: unknown): void {
    switch (event) {
      case "welcome": return this.onWelcome(data as WelcomeMessage);
      case "ops": return this.onRemoteOps(data as { ops: CollabOp[] });
      case "presence": return this.onPresence(data as { entries: CollabMember[] });
      case "members": return this.onMembers(data as { joined?: CollabMember; left?: { siteId: string } });
      case "warning": return this.onWarning(data as { code: string; message: string });
      case "error": return this.onServerError(data as { code: string; message: string });
      default: return; // mensaje desconocido: se ignora, nunca se lanza
    }
  }

  private onWelcome(msg: WelcomeMessage): void {
    if (!msg || typeof msg !== "object") return;
    // Sesión ESTABLECIDA: aquí, y solo aquí, se recupera el presupuesto de reintentos —el de la
    // reconexión y el del envío, que también se agota (ver `MAX_FLUSH_RETRIES`).
    this.retries = 0;
    this.flushRetries = 0;
    this.flushGaveUp = false;

    // La espera que el servidor exige tras un 429 la dice ÉL. Duplicarla a ojo aquí es lo que hacía
    // que 900 vs 1000 funcionara por casualidad y que tocar cualquiera de los dos números reabriera
    // la expulsión sin un solo test en rojo.
    const retry = Number(msg.limits?.rateRetryMs);
    if (Number.isFinite(retry) && retry > 0) this.serverRetryMs = retry;

    // La identidad de réplica la manda el SERVIDOR y se adopta antes de tocar nada: con ella se
    // siembran las posiciones y se firman las ops. Que cambie con estado vivo es rarísimo (rotación
    // de la clave del sitio), pero si pasa, las ops locales ya no son "nuestras" para el servidor:
    // hay que re-sembrar, y se dice cuántos cambios se quedaron sin enviar.
    const serverSite = typeof msg.self?.siteId === "string" && msg.self.siteId ? msg.self.siteId : this.siteId;
    const identityChanged = this.state !== null && serverSite !== this.siteId;
    this.siteId = serverSite;

    const reconnect = this.state !== null && this.epoch === msg.epoch && !identityChanged;

    if (reconnect) {
      // MISMA generación: el estado local sigue siendo válido. Se aplican las ops del servidor
      // (idempotentes por el dot: las que ya teníamos son un no-op exacto) en vez de reconstruir,
      // que tiraría las ops locales aún sin enviar.
      this.applyRemote(msg.ops ?? []);
      this.emitNotice({ code: "reconnected", message: "Conexión restablecida.", at: this.time() });
      this.flushSoon();
    } else {
      if (this.state && (this.epoch !== msg.epoch || identityChanged)) {
        // Generación distinta: la sala se reinició (se purgó por inactividad, o alguien reemplazó el
        // contenido por otra vía). Lo local que no llegó a enviarse NO se pierde en silencio: se
        // cuenta. Ahora esta rama SÍ es alcanzable — el servidor incrementa el epoch de verdad.
        this.emitNotice({
          code: identityChanged ? "identity-reset" : "epoch-reset",
          message: this.outbox.length
            ? `La sesión se reinició y ${this.outbox.length} cambio(s) tuyo(s) no llegaron a enviarse. Revisa el documento antes de seguir.`
            : "La sesión colaborativa se reinició con el contenido guardado.",
          at: this.time(),
        });
        this.outbox = [];
      }
      this.state = this.buildState(msg.base);
      this.appliedDots.clear();
      this.repairedDots.clear();
      this.normalizedNoticeSent = false;
      if (this.state) this.ingest(msg.ops ?? []);
    }

    this.epoch = msg.epoch;
    this.self = msg.self ?? null;
    this.members.clear();
    for (const m of msg.members ?? []) this.members.set(m.siteId, m);

    this.setStatus(msg.truncated ? "degraded" : "live");
    if (msg.truncated) {
      this.emitNotice({
        code: "log-full",
        message: "Esta sesión colaborativa es muy larga: guarda y recarga la página para poder reconectar sin perder cambios.",
        at: this.time(),
      });
    }
    if (!reconnect && this.state && this.self) {
      this.listeners.onReady?.(this.state.toDoc(), this.self);
    }
    this.emitChange();
  }

  /** Construye el estado replicado desde el snapshot del epoch. Nunca lanza por un base corrupto. */
  private buildState(base: string): CrdtDoc | null {
    let data: VersoData;
    try {
      const parsed = base ? JSON.parse(base) : {};
      data = (parsed && typeof parsed === "object" ? parsed : {}) as VersoData;
    } catch {
      data = {} as VersoData;
    }
    // El MISMO `isSlot` que usa el editor: si dos réplicas clasificaran los slots distinto,
    // sembrarían árboles distintos del mismo snapshot y divergirían desde el primer instante.
    const doc = toNormalized(data, this.opts.isSlot);
    return toCrdt(doc, {
      site: this.siteId,
      isRichText: this.opts.isRichText,
      now: this.opts.now,
    });
  }

  private onRemoteOps(msg: { ops?: CollabOp[] }): void {
    if (!msg || !Array.isArray(msg.ops) || msg.ops.length === 0) return;
    this.applyRemote(msg.ops);
  }

  /**
   * Aplica ops ajenas y proyecta. Si alguna queda en el BUFFER CAUSAL es que falta una dependencia
   * (un hueco de entrega): se pide un `resync` por version vector en vez de esperar a que llegue
   * sola, que es lo que convierte un hueco transitorio en una divergencia permanente.
   */
  private applyRemote(ops: readonly CollabOp[]): void {
    const state = this.state;
    if (!state) return;
    const results = this.ingest(ops);
    const applied = results.some((r) => r.status === "applied");
    const gap = results.some((r) => r.status === "buffered");

    if (applied) this.listeners.onRemoteDoc?.(state.toDoc(), ops);
    if (gap) this.scheduleResync();
    this.emitChange();
  }

  /**
   * Único camino por el que una op entra en la réplica. Aparte de aplicarla, anota su dot para
   * poder derivar el prefijo denso del `resync` (ver `appliedDots`). Una op BUFFERADA no se anota:
   * no está aplicada, y contarla haría que el servidor no nos la reenviara nunca.
   */
  private ingest(ops: readonly CollabOp[]) {
    const state = this.state!;
    const results = state.applyAll(ops);
    for (let i = 0; i < ops.length; i++) {
      const status = results[i]?.status;
      if (status !== "applied" && status !== "duplicate") continue;
      const id = ops[i]?.id;
      if (!id) continue;
      let set = this.appliedDots.get(id.site);
      if (!set) this.appliedDots.set(id.site, (set = new Set()));
      set.add(id.counter);
    }
    return results;
  }

  /**
   * Version vector de PREFIJO DENSO: para cada sitio, el mayor `n` tal que se han aplicado todos
   * los dots `1..n`. Los contadores son densos por sitio (`nextOpId` incrementa de uno en uno), así
   * que esto es exacto. Lo que quede por encima de un hueco se volverá a pedir — reenviar una op
   * que ya teníamos es un no-op exacto, así que el error se paga en tráfico, nunca en corrección.
   */
  private denseVersionVector(): VersionVector {
    const out: VersionVector = {};
    for (const [site, counters] of this.appliedDots) {
      let n = 0;
      while (counters.has(n + 1)) n++;
      if (n > 0) out[site] = n;
    }
    return out;
  }

  private onPresence(msg: { entries?: CollabMember[] }): void {
    for (const e of msg?.entries ?? []) {
      if (e && typeof e.siteId === "string" && e.siteId !== this.siteId) this.members.set(e.siteId, e);
    }
    this.emitChange();
  }

  private onMembers(msg: { joined?: CollabMember; left?: { siteId: string } }): void {
    if (msg?.joined?.siteId && msg.joined.siteId !== this.siteId) this.members.set(msg.joined.siteId, msg.joined);
    if (msg?.left?.siteId) this.members.delete(msg.left.siteId);
    this.emitChange();
  }

  private onWarning(msg: { code?: string; message?: string }): void {
    if (msg?.code === "log_full") {
      this.setStatus("degraded");
      this.emitNotice({ code: "log-full", message: String(msg.message || "Sesión demasiado larga."), at: this.time() });
      return;
    }
    if (msg?.code === "room_reset") {
      // La sala se retiró y se re-sembró con NOSOTROS dentro (una fila de liveness que se perdió, un
      // reloj corrido entre nodos). Nuestro stream sigue sano, así que sin este aviso nos quedábamos
      // en `live` y MUDOS hasta teclear — y entonces el 409 nos dejaba con un documento derivado del
      // base VIEJO, que al guardar pisa lo que se guardó por fuera. Se pide el estado nuevo: el
      // `resync` verá otro epoch, re-sembrará y contará los cambios que no llegaron a enviarse.
      // El aviso sale YA, antes de saber si el `resync` llega: si la red también se ha caído, el
      // usuario tiene que ver el cambio de estado explicado y no un `degraded` mudo. Cuando el
      // `resync` responda, el `welcome` lo refina con cuántos cambios suyos no llegaron a enviarse.
      this.setStatus("degraded");
      this.emitNotice({
        code: "epoch-reset",
        message: String(msg.message || "La sesión colaborativa se reinició. Revisa el documento antes de seguir."),
        at: this.time(),
      });
      void this.resync();
    }
  }

  /**
   * El servidor cerró la sala para nosotros. NO todo rechazo es definitivo: los de CUPO y los
   * transitorios se reintentan con el mismo backoff que una caída de red. Tratarlos todos como
   * terminales dejaba al editor replicando en local, sin recibir nada y sin decir nada, hasta que
   * el usuario recargara la página.
   */
  private onServerError(msg: { code?: string; message?: string }): void {
    const code = String(msg?.code || "");
    this.stream?.close();
    this.stream = null;
    this.setStatus("offline");

    if (RETRYABLE_REFUSALS.has(code) && this.retries < (this.opts.maxRetries ?? DEFAULTS.maxRetries)) {
      const delay = Math.min(1000 * 2 ** this.retries, 30_000);
      this.retries++;
      this.emitNotice({
        code: "transport-error",
        message: `La sala no pudo abrirse (${code}); reintentando.`,
        at: this.time(),
      });
      this.later(delay, () => { if (!this.stopped) this.openStream(); });
      return;
    }

    this.stopped = true;
    this.emitNotice({
      code: code === "forbidden" || code === "unauthorized" ? "forbidden" : "transport-error",
      message: String(msg?.message || "La sesión colaborativa se cerró."),
      at: this.time(),
    });
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Salida                                                                                      */
  /* ----------------------------------------------------------------------------------------- */

  /**
   * Traduce un comando EFECTIVO del editor y lo encola. Devuelve las ops emitidas (vacío si el
   * comando no era replicable) para que quien cablee esto pueda registrarlas o ignorarlas.
   *
   * Aplicar las ops también a NUESTRA réplica es obligatorio: el editor ya cambió su documento por
   * su cuenta, y si la réplica no siguiera el mismo camino, la proyección de la siguiente op remota
   * pisaría el trabajo local.
   */
  sendCommand(command: VersoHistoryCommand): readonly CollabOp[] {
    const state = this.state;
    if (!state || this.stopped) return [];
    const result = commandToOps(state, state.toDoc(), command, { isSlot: this.opts.isSlot });
    if (!result.ok || result.ops.length === 0) return [];

    this.ingest(result.ops);
    this.outbox.push(...result.ops);
    this.flushSoon();
    this.emitChange();
    return result.ops;
  }

  private flushSoon(): void {
    // `flushGaveUp` corta el bucle AQUÍ, que es por donde se re-programaba (el `finally` de `flush`
    // llama a este mismo camino). Se recupera con el `welcome` de una reconexión, no tecleando: si
    // cada pulsación rearmara el reintento, el presupuesto no serviría de nada.
    if (this.flushTimer !== null || this.stopped || this.flushGaveUp) return;
    // El freno vive AQUÍ y no en un instante absoluto: el reintento que programa el `finally` de
    // `flush()` pasa por este mismo camino, así que un 429 ya no puede acabar reenviando a los
    // 100 ms como si no hubiera pasado nada.
    const delay = this.backoffMs || (this.opts.flushMs ?? DEFAULTS.flushMs);
    this.backoffMs = 0;
    this.flushTimer = this.later(delay, () => {
      this.flushTimer = null;
      void this.flush();
    });
  }

  /**
   * Envía el outbox. Público para que el cableado pueda forzar un envío antes de guardar.
   *
   * REGLA DE LA QUE CUELGA TODO: un lote solo sale de la cola cuando el servidor CONFIRMA qué ha
   * hecho con cada op. Un 200 con menos ops contabilizadas de las enviadas, un fallo de guardado o
   * un status desconocido devuelven el lote a la cola; lo único que se descarta es lo que el
   * servidor no va a aceptar nunca, y eso se dice con un aviso.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.outbox.length === 0 || this.stopped || this.flushGaveUp || !this.self) return;
    this.flushing = true;
    // Un solo frame por POST: por encima del tope del validador el frame entero vuelve inválido, y
    // reenviarlo intacto es un bucle. Lo que no cabe se queda encolado para el envío siguiente.
    const batch = this.outbox.slice(0, this.flushCap);
    this.outbox = this.outbox.slice(batch.length);
    try {
      const res = await this.post("ops", { siteId: this.siteId, epoch: this.epoch, ops: batch });
      if (res.status === 200) {
        const body = res.body as OpsResponse | null;
        const rejected = body?.rejected ?? [];
        this.flushCap = MAX_OPS_PER_FLUSH;
        if (rejected.length) {
          // El servidor descartó algo nuestro. Se dice EN EL MOMENTO: descubrirlo releyendo el
          // documento más tarde es indistinguible de una pérdida de datos.
          this.emitNotice({
            code: "rejected-ops",
            message: `El servidor rechazó ${rejected.length} cambio(s) por no superar la validación.`,
            at: this.time(),
            rejected,
          });
        }
        // Contabilidad completa: aceptadas + ya conocidas + rechazadas tiene que cubrir el lote. Si
        // no cuadra, hay ops de las que nadie se ha hecho cargo: vuelven a la cola (reenviarlas es
        // un no-op exacto por el dot) en vez de darlas por entregadas.
        const accounted = (body?.accepted ?? 0) + (body?.known ?? 0) + rejected.length;
        if (typeof body?.accepted === "number" && accounted < batch.length) {
          this.requeue(batch, RETRY_BACKOFF_MS, `El servidor no confirmó ${batch.length - accounted} cambio(s); se reintentan.`);
        } else if (body?.persisted === false) {
          // Difundido pero NO guardado: los demás lo ven, pero la sesión ya no es reanudable.
          this.setStatus("degraded");
          this.emitNotice({
            code: "log-full",
            message: "Esta sesión colaborativa es muy larga: guarda y recarga la página para poder reconectar sin perder cambios.",
            at: this.time(),
          });
        }
        if (accounted >= batch.length) this.flushRetries = 0;   // el servidor SÍ se hizo cargo
        if (body?.normalized?.length) this.adoptNormalized(body.normalized);
      } else if (res.status === 429) {
        // Un 429 no gasta presupuesto: es un freno, no un fallo, y el servidor dice cuánto esperar.
        this.outbox = batch.concat(this.outbox);
        this.backoffMs = this.rateBackoff();
        this.emitNotice({ code: "rate-limited", message: "Vas más rápido de lo que el servidor acepta; reintentando.", at: this.time() });
      } else if (res.status === 413) {
        // El frame no cabe. Se parte por la mitad y se reintenta; si ni una sola op cabe, esa op no
        // se va a poder enviar nunca y se dice, en vez de reintentarla en bucle para siempre.
        if (batch.length > 1) {
          this.flushCap = Math.max(1, Math.floor(batch.length / 2));
          this.outbox = batch.concat(this.outbox);
        } else {
          this.emitNotice({
            code: "rejected-ops",
            message: "Un cambio es demasiado grande para la sesión colaborativa y no se ha podido enviar. Guarda para conservarlo.",
            at: this.time(),
          });
        }
      } else if (res.status === 409) {
        // Epoch caducado o sesión cerrada: estas ops ya no encajan en el estado del servidor. El
        // documento local las conserva, así que Guardar sigue preservando el trabajo.
        this.setStatus("degraded");
        this.emitNotice({
          code: "epoch-reset",
          message: `La sesión se reinició; ${batch.length} cambio(s) no se pudieron enviar. Guarda y recarga para reconciliar.`,
          at: this.time(),
        });
      } else {
        // 5xx u otro status: el servidor NO se ha hecho cargo del lote. Vuelve a la cola con freno.
        this.requeue(batch, RETRY_BACKOFF_MS, "El servidor no pudo guardar los últimos cambios; se están reintentando.");
      }
    } catch {
      // Red caída: las ops vuelven a la cola INTACTAS y se reintentan al reconectar. Perderlas
      // aquí sería la pérdida silenciosa que este diseño no admite.
      this.requeue(batch, RETRY_BACKOFF_MS, null);
    } finally {
      this.flushing = false;
      this.emitChange();
      if (this.outbox.length) this.flushSoon();
    }
  }

  /**
   * Devuelve un lote a la cola CON PRESUPUESTO. Las ops nunca se tiran —eso sería la pérdida
   * silenciosa— pero los reintentos sí se acaban: un 503 por una fila del log ilegible es permanente
   * por construcción, y reintentarlo a 1 Hz para siempre agota el limitador global de la IP y no
   * arregla nada. Al agotarse se deja de posear y se dice que hay que guardar a mano.
   */
  private requeue(batch: CollabOp[], backoff: number, message: string | null): void {
    this.outbox = batch.concat(this.outbox);
    this.backoffMs = backoff;
    this.flushRetries++;
    if (this.flushRetries >= MAX_FLUSH_RETRIES) {
      this.flushGaveUp = true;
      this.setStatus("degraded");
      this.emitNotice({
        code: "store-failed",
        message: `El servidor lleva ${this.flushRetries} intentos sin aceptar ${this.outbox.length} cambio(s). Se deja de reintentar: guarda la página para conservarlos.`,
        at: this.time(),
      });
      return;
    }
    if (message) this.emitNotice({ code: "store-failed", message, at: this.time() });
  }

  /**
   * Adopta los valores que el SANEADO del servidor reescribió.
   *
   * El emisor es el único que no recibe la difusión de sus propias ops (ya las aplicó localmente, en
   * crudo), y el `resync` tampoco se las devuelve porque su version vector ya cubre ese dot. Sin
   * esto, quien escribe `Ofertas & Rebajas` se queda con `&` mientras TODOS los demás tienen
   * `&amp;`: la firma de estado deja de coincidir para siempre dentro del epoch.
   *
   * La corrección se emite como una op NUEVA (dot nuevo, reloj nuevo) en vez de re-aplicar el dot
   * viejo, que el núcleo descartaría como duplicado. El saneador es idempotente (gate en
   * `collab-sanitize.test.ts`), así que la corrección pasa sin volver a cambiar; y por si acaso, un
   * dot ya corregido no se corrige dos veces.
   */
  private adoptNormalized(ops: readonly CollabOpLike[]): void {
    const state = this.state;
    if (!state) return;
    const fixes: CollabOp[] = [];

    const push = (op: CollabOp) => {
      fixes.push(op);
      this.repairedDots.add(`${op.id.site}@${op.id.counter}`);
    };

    for (const op of ops) {
      const dot = op?.id ? `${op.id.site}@${op.id.counter}` : "";
      if (!dot || this.repairedDots.has(dot)) continue;
      this.repairedDots.add(dot);
      if (op.k === "propSet" && typeof op.nodeId === "string" && typeof op.key === "string") {
        push({ k: "propSet", id: state.nextOpId(), hlc: state.nextHlc(), nodeId: op.nodeId, key: op.key, value: op.value });
      } else if (op.k === "shapeSet" && typeof op.key === "string") {
        push({ k: "shapeSet", id: state.nextOpId(), hlc: state.nextHlc(), key: op.key as never, value: op.value });
      } else if (op.k === "nodeCreate" && typeof op.nodeId === "string" && op.props) {
        for (const [key, value] of Object.entries(op.props)) {
          push({ k: "propSet", id: state.nextOpId(), hlc: state.nextHlc(), nodeId: op.nodeId, key, value });
        }
      }
    }

    if (fixes.length) {
      this.ingest(fixes);
      this.outbox.push(...fixes);
      this.listeners.onRemoteDoc?.(state.toDoc(), fixes);
      this.flushSoon();
    }
    if (!this.normalizedNoticeSent) {
      this.normalizedNoticeSent = true;
      this.emitNotice({
        code: "normalized",
        message: "El servidor ajustó el formato de algún valor por seguridad y tu copia se ha puesto al día.",
        at: this.time(),
      });
    }
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Presencia                                                                                   */
  /* ----------------------------------------------------------------------------------------- */

  /** Declara dónde está el cursor/selección. Coalescido: la presencia no merece un POST por evento. */
  setSelection(sel: CollabSelection | null): void {
    if (this.stopped || !this.self) return;
    this.pendingSel = sel;
    this.presenceDirty = true;
    this.presenceSoon();
  }

  /**
   * LA PRESENCIA TAMBIÉN RESPETA LA ESPERA DE UN 429.
   *
   * Antes se posteaba cada `presenceMs` (50 ms por defecto) y el 429 ni se miraba
   * (`.catch(() => undefined)` sobre un `void`). Bajar con las flechas por el documento son decenas
   * de POST seguidos: si el cubo estaba en descubierto —cosa que un solo `resync` legítimo provoca—
   * el servidor veía tres rechazos separados 50 ms, los contaba como "ignora la espera" y cerraba la
   * sesión con `rate_limit`, que aquí es terminal. ~150 ms de mover el cursor y editor mudo hasta
   * recargar. El servidor ya no rebota la presencia por un cubo de BYTES en rojo, pero el freno de
   * presencia sigue existiendo (y debe): cuando salte, se espera como en `flush`.
   */
  private presenceSoon(): void {
    if (this.presenceTimer !== null || this.stopped) return;
    const delay = this.presenceBackoffMs || (this.opts.presenceMs ?? DEFAULTS.presenceMs);
    this.presenceBackoffMs = 0;
    this.presenceTimer = this.later(delay, () => {
      this.presenceTimer = null;
      if (!this.presenceDirty || this.stopped || !this.self) return;
      this.presenceDirty = false;
      void this.post("presence", { siteId: this.siteId, sel: this.pendingSel })
        .then((res) => {
          if (res?.status !== 429 || this.stopped) return;
          // Se reintenta la ÚLTIMA selección conocida (la presencia es estado, no un log: lo viejo
          // no interesa), y sobre todo se espera lo que el servidor pide antes de volver.
          this.presenceDirty = true;
          this.presenceBackoffMs = this.rateBackoff();
          this.presenceSoon();
        })
        .catch(() => undefined);
    });
  }

  /**
   * Espera antes de reintentar tras un 429, DERIVADA de la que el servidor publicó en el `welcome`.
   * Nunca menos que la suya (eso es lo que el servidor castiga con un strike) ni menos que el suelo
   * propio, y con techo para que un valor absurdo no deje al editor parado.
   */
  private rateBackoff(): number {
    const server = Number(this.serverRetryMs) || 0;
    return Math.min(Math.max(RATE_BACKOFF_MS, server + RATE_BACKOFF_MARGIN_MS), RATE_BACKOFF_CAP_MS);
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Reanudación                                                                                 */
  /* ----------------------------------------------------------------------------------------- */

  private scheduleResync(): void {
    if (this.resyncTimer !== null || this.stopped) return;
    this.resyncTimer = this.later(250, () => {
      this.resyncTimer = null;
      void this.resync();
    });
  }

  /**
   * Cierra un hueco pidiendo por VERSION VECTOR lo que nos falta. No por un cursor de secuencia: en
   * multinodo el bus no garantiza orden entre nodos, así que un cursor podría saltarse ops que sí
   * llegaron a la BD. El VV dice exactamente qué dots hemos visto.
   */
  async resync(): Promise<void> {
    const state = this.state;
    if (!state || this.stopped) return;
    try {
      const res = await this.post("resync", { siteId: this.siteId, epoch: this.epoch, vv: this.denseVersionVector() });
      if (res.status !== 200) return;
      const body = res.body as { epoch: number; ops?: CollabOp[]; base?: string; complete?: boolean };

      if (body.epoch !== this.epoch && typeof body.base === "string") {
        this.onWelcome({
          epoch: body.epoch, base: body.base, ops: body.ops ?? [],
          members: [...this.members.values()], self: this.self as CollabSelf,
          serverTime: this.time(), truncated: body.complete === false,
          limits: { maxOpsPerSec: 0, maxBytesPerSec: 0, maxFrameBytes: 0 },
        });
        return;
      }
      if (body.complete === false) {
        this.setStatus("degraded");
        this.emitNotice({
          code: "log-full",
          message: "No se pudo recuperar el histórico completo de la sesión: guarda y recarga la página.",
          at: this.time(),
        });
      }
      this.applyRemote(body.ops ?? []);
    } catch {
      // Sin red: el reintento llega por la reconexión del stream, que reenvía el `welcome`.
    }
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Utilidades                                                                                  */
  /* ----------------------------------------------------------------------------------------- */

  private post(path: string, body: unknown) {
    return this.opts.transport.post(`${this.base}/collab/${this.opts.postId}/${path}`, body);
  }

  private setStatus(status: CollabStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitChange();
  }

  private emitNotice(notice: CollabNotice): void {
    this.notice = notice;
    this.listeners.onNotice?.(notice);
    this.emitChange();
  }

  private emitChange(): void {
    this.listeners.onChange?.(this.snapshot());
  }

  snapshot(): SessionSnapshot {
    return {
      status: this.status,
      siteId: this.siteId,
      self: this.self,
      members: [...this.members.values()],
      epoch: this.epoch,
      vv: this.state ? ({ ...this.state.vv } as VersionVector) : {},
      pendingOps: this.outbox.length,
      notice: this.notice,
    };
  }

  /** Proyección vigente del estado replicado (`null` antes del `welcome`). */
  doc(): VersoDoc | null {
    return this.state ? this.state.toDoc() : null;
  }

  /** Firma canónica del estado: dos réplicas convergidas la tienen IDÉNTICA. */
  signature(): string {
    return this.state ? this.state.stateSignature() : "";
  }

  get id(): string {
    return this.siteId;
  }

  private time(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private later(ms: number, fn: () => void): unknown {
    if (this.opts.setTimer) return this.opts.setTimer(fn, ms);
    return setTimeout(fn, ms);
  }

  private clear(handle: unknown): void {
    if (handle === null || handle === undefined) return;
    if (this.opts.clearTimer) this.opts.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
