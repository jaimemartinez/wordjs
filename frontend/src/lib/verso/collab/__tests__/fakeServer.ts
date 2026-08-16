/**
 * Servidor colaborativo de mentira, en memoria, que habla el MISMO protocolo que
 * `backend/src/routes/collab.ts`.
 *
 * Existe para una cosa que un servidor de verdad no permite hacer: CONTROLAR EL DESORDEN. La
 * convergencia de un CRDT solo significa algo si se demuestra con las ops llegando en órdenes
 * distintos a cada réplica, duplicadas y a saltos — y eso hay que provocarlo, no esperarlo.
 *
 * Reproduce las reglas del servidor real que afectan al cliente:
 *   · `welcome` = snapshot base del epoch + log de ops posteriores;
 *   · el emisor NO recibe su propio eco (ya aplicó la op localmente);
 *   · idempotencia por causal dot (una op reenviada no se duplica en el log);
 *   · `resync` filtrado por version vector.
 *
 * NO reproduce el saneado ni la autorización: eso se prueba contra el servidor REAL en
 * `backend/src/tests/collab-ops.test.ts` y `collab-routes.test.ts`, que es donde vive.
 */

import type {
  CollabMember,
  CollabSelf,
  CollabTransport,
  PostResponse,
  StreamHandlers,
} from "../types";
import type { CollabOp } from "../../crdt";

type Pending = { siteId: string; event: string; data: unknown };

type PostBody = {
  siteId?: string;
  epoch?: number;
  ops?: CollabOp[];
  sel?: unknown;
  vv?: Record<string, number>;
  /** Acuse del último aviso de espera que el cliente dice haber visto (ver `ritmo`). */
  rateAck?: unknown;
};

/** Estado de ritmo por sitio: los cubos y la INSTRUCCIÓN de espera vigente. */
type Rate = {
  opTokens: number;
  byteTokens: number;
  presenceTokens: number;
  lastRefill: number;
  strikes: number;
  notice: number;
  retryAt: number;
  ack: number;
};

export interface FakeClient {
  siteId: string;
  userId: number;
  name: string;
}

/**
 * Planificador de temporizadores manual: la sesión agrupa envíos con `setTimeout`, y en un test hay
 * que poder avanzar ese tiempo de forma determinista en vez de dormir y cruzar los dedos.
 */
export class ManualTimers {
  private items = new Map<number, { fn: () => void; at: number }>();
  private seq = 0;
  private clock = 0;

  readonly set = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.items.set(id, { fn, at: this.clock + Math.max(0, ms) });
    return id;
  };

  readonly clear = (handle: unknown): void => {
    if (typeof handle === "number") this.items.delete(handle);
  };

  /** Reloj simulado. Un test que mide ESPERAS necesita leerlo, no solo avanzarlo. */
  get time(): number {
    return this.clock;
  }

  /** Dispara todo lo pendiente (incluido lo que se re-programe) y deja asentar las promesas. */
  async run(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds && this.items.size > 0; i++) {
      let next: [number, { fn: () => void; at: number }] | null = null;
      for (const entry of this.items) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next) break;
      this.items.delete(next[0]);
      this.clock = Math.max(this.clock, next[1].at);
      next[1].fn();
      await settleMicrotasks();
    }
    await settleMicrotasks();
  }
}

export async function settleMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const SITE_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Identidad de réplica derivada del nonce, con la propiedad que importa del `replicaId` real: es
 * DETERMINISTA (el mismo nonce da siempre la misma identidad, que es lo que permite desalojar la
 * conexión vieja al reconectar) y NO ES IDEMPOTENTE (aplicarla a su propio resultado da otra cosa,
 * que es lo que castiga a un cliente que confunda el nonce con la identidad).
 */
export function deriveSite(nonce: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const seeded = `srv:${nonce}`;
  for (let i = 0; i < seeded.length; i++) {
    h1 = Math.imul(h1 ^ seeded.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seeded.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 16; i++) {
    // El `>>> 0` FINAL no es cosmético. `^` devuelve un int32 CON SIGNO: en cuanto el operando trae
    // el bit alto puesto, `mix` era negativo, `mix % 32` negativo, y `SITE_ALPHABET[negativo]` es
    // `undefined`, que se concatena como la CADENA "undefined". 3684 de 5000 nonces sintéticos
    // salían así —`s_k53s2j6uundefined6qkmi5c`, 25 caracteres— y eso rompe justo la propiedad que
    // este doble existe para modelar: la identidad derivada tiene que tener la MISMA FORMA que un
    // nonce y pasar el filtro `^s_[a-z2-7]{1,32}$` de `routes/collab.ts` sin un solo 400, porque de
    // ahí venía el SILENCIO del bug de producción. Con identidades visiblemente inválidas los tests
    // seguían verdes (se anclan a `deriveSite(...)` literal, así que son autoconsistentes) mientras
    // la convergencia CRDT se probaba con identificadores de sitio que no pueden existir.
    const mix = ((i < 8 ? h1 >>> (i * 4) : h2 >>> ((i - 8) * 4)) ^ (i * 7)) >>> 0;
    out += SITE_ALPHABET[mix % 32];
  }
  return `s_${out}`;
}

export class FakeCollabServer {
  epoch = 1;
  base: string;
  log: CollabOp[] = [];
  /** Dots ya vistos: la idempotencia es un invariante del servidor, no del cliente. */
  private readonly seen = new Set<string>();
  private readonly handlers = new Map<string, StreamHandlers>();
  private readonly clients = new Map<string, FakeClient>();
  private readonly presence = new Map<string, CollabMember>();
  private readonly rate = new Map<string, Rate>();
  private outbox: Pending[] = [];
  /**
   * Nonces tal cual llegaron en la query de cada `GET /stream`, en orden. Es la huella del PRODUCTOR
   * REAL (`client.ts#openStream`): un test de reconexión que no la mire está probando el doble.
   */
  readonly openedWith: string[] = [];

  /**
   * Espera que este servidor exige tras un 429, tal cual la publica el real en
   * `welcome.limits.rateRetryMs` (`CONFIG.RATE_RETRY_MS` = 900). Un test puede subirla para
   * comprobar que el cliente DERIVA su backoff de ella en vez de llevar 1000 ms escritos a mano.
   */
  rateRetryMs = 900;

  /**
   * TIEMPO DE VUELO, en una sola dirección. Por defecto 0 para no cambiar los tests que no lo
   * necesitan, pero un doble instantáneo NO MODELA UNA RED, y ésa fue la razón —comprobada— de que
   * ninguno de los 45 tests de colaboración viera el defecto que sobrevivió tres rondas: el 429 se
   * respondía en el MISMO tick, así que entre mandar un frame y enterarse de que lo han rechazado no
   * cabía nada. La carrera que expulsaba a la gente de la sala es justamente lo que pasa en ese
   * hueco: una pulsación o un movimiento de cursor mientras el 429 viene de vuelta.
   */
  latencyMs = 0;

  /** Cuántos 429 seguidos servir por camino, saltándose los cubos. Fuerza el rechazo en un test. */
  readonly refuse: Record<string, number> = {};

  /** Reloj del test (normalmente `timers.time`): sin él no se puede medir CUÁNTO esperó el cliente. */
  clock: () => number = () => 0;

  /**
   * Cómo espera este doble el tiempo de vuelo. Con `ManualTimers` tiene que ser SU cola, o el retardo
   * no se podría avanzar de forma determinista y el test volvería a medir otra cosa.
   */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Ata reloj y retardo a los temporizadores del test de una vez: es fácil poner uno y olvidar el otro. */
  useTimers(timers: ManualTimers): ManualTimers {
    this.clock = () => timers.time;
    this.sleep = (ms) => new Promise<void>((r) => { timers.set(r, ms); });
    return timers;
  }

  /**
   * LÍMITES QUE ESTE DOBLE APLICA, y los mismos que publica en el `welcome`. Están en un único sitio
   * a propósito: si lo que exige y lo que dice exigir pudieran divergir, el cliente estaría
   * obedeciendo un contrato que el servidor no cumple — que es EXACTAMENTE el defecto original, con
   * el 900 del servidor y el 1000 del cliente escritos por separado.
   */
  readonly limits = {
    maxOpsPerSec: 50,
    maxBytesPerSec: 64 * 1024,
    maxFrameBytes: 256 * 1024,
    opsBurst: 400,
    bytesBurst: 256 * 1024,
    maxPresencePerSec: 20,
    presenceBurst: 40,
    /** Coste en fichas de ops de un `resync`, como `CONFIG.RESYNC_OP_COST`. */
    resyncOpCost: 10,
    /** Desobediencias probadas antes de cerrar, como `CONFIG.MAX_STRIKES`. */
    maxStrikes: 3,
  };

  /** Sitios SIN sesión ahora mismo por haber sido cerrados por ritmo (su POST responde 409). */
  private readonly expulsados = new Set<string>();

  /**
   * REGISTRO PERMANENTE de expulsiones. Aparte del conjunto vivo porque una reconexión lo limpia, y
   * la evidencia de que a alguien lo echaron no puede borrarla el propio cliente al volver a entrar.
   */
  readonly expulsiones: { siteId: string; at: number }[] = [];

  /** Cada POST recibido: cuándo se mandó y cuándo se sirvió (difieren en cuanto hay latencia). */
  readonly posted: { path: string; at: number; servedAt: number; status: number }[] = [];

  /**
   * DERIVACIÓN de la identidad de réplica, igual que hace el servidor real: lo que el cliente pone
   * en la query es un NONCE, y la identidad con la que firma sale del `welcome`.
   *
   * Por defecto era la FUNCIÓN IDENTIDAD (`nonce => nonce`), y eso convertía a este doble en un
   * mentiroso: con ella, un cliente que reconectara mandando su identidad derivada en vez del nonce
   * obtenía la misma identidad y todo parecía correcto. El servidor real deriva con un HMAC, que NO
   * es idempotente — `replicaId(u, replicaId(u, n)) ≠ replicaId(u, n)` (anclado en
   * `backend/src/tests/collab-failure-paths.test.ts`) — así que ese cliente cambiaba de identidad en
   * CADA reconexión, tiraba su cola de ediciones y pisaba el canvas. Un doble que no reproduce esa
   * propiedad no prueba nada de lo que dice probar.
   */
  siteFor: (nonce: string) => string = deriveSite;

  /** `manual` ⇒ nada se entrega hasta llamar a `deliver()`, que es donde se controla el orden. */
  constructor(base: unknown, readonly mode: "auto" | "manual" = "manual") {
    this.base = typeof base === "string" ? base : JSON.stringify(base);
  }

  register(client: FakeClient): void {
    this.clients.set(client.siteId, client);
  }

  transport(): CollabTransport {
    return {
      openStream: (url: string, h: StreamHandlers) => {
        const nonce = new URL(url, "http://x").searchParams.get("siteId") ?? "";
        this.openedWith.push(nonce);
        const siteId = this.siteFor(nonce);
        const client = this.clients.get(nonce) ?? this.clients.get(siteId);
        this.handlers.set(siteId, h);
        // Conexión NUEVA: cubos llenos y numeración de avisos desde cero, como el `Conn` que crea
        // `join()` en el servidor real. Arrastrar la deuda de la conexión anterior haría que una
        // reconexión heredara un castigo que el servidor de verdad no aplica.
        this.rate.delete(siteId);
        this.expulsados.delete(siteId);
        h.onOpen();

        const self: CollabSelf = {
          siteId,
          userId: client?.userId ?? 0,
          name: client?.name ?? siteId,
          color: "#2563eb",
        };
        const members = [...this.presence.values()].filter((m) => m.siteId !== siteId);
        this.presence.set(siteId, { ...self, sel: null, at: 0 });

        // El `welcome` se entrega SIEMPRE de inmediato: es la semilla del estado, y retrasarlo
        // solo probaría que un cliente sin estado no hace nada.
        h.onEvent("welcome", {
          epoch: this.epoch,
          base: this.base,
          ops: [...this.log],
          members,
          self,
          serverTime: 0,
          truncated: false,
          limits: {
            maxOpsPerSec: this.limits.maxOpsPerSec,
            maxBytesPerSec: this.limits.maxBytesPerSec,
            maxFrameBytes: this.limits.maxFrameBytes,
            rateRetryMs: this.rateRetryMs,
          },
        });
        for (const [other] of this.handlers) {
          if (other !== siteId) this.enqueue(other, "members", { joined: { ...self, sel: null, at: 0 } });
        }
        return { close: () => { this.handlers.delete(siteId); this.presence.delete(siteId); } };
      },

      post: async (url: string, body: unknown): Promise<PostResponse> => {
        const path = url.split("/").pop() ?? "";
        const payload = body as PostBody;
        const enviadoEn = this.clock();

        // IDA. A partir de aquí estamos en el SERVIDOR: todo lo que el cliente haga mientras tanto
        // (teclear, mover el cursor) ocurre sin saber nada de lo que se decida aquí dentro.
        if (this.latencyMs > 0) await this.sleep(this.latencyMs);
        const res = this.sirve(path, payload);
        this.posted.push({ path, at: enviadoEn, servedAt: this.clock(), status: res.status });
        // VUELTA.
        if (this.latencyMs > 0) await this.sleep(this.latencyMs);
        return res;
      },
    };
  }

  /** Lo que decide el servidor, ya en su reloj (después de la ida). */
  private sirve(path: string, payload: PostBody): PostResponse {
    const siteId = String(payload?.siteId ?? "");

    if (path === "leave") return { status: 200, body: { ok: true } };

    // Sin sesión viva no hay sala a la que hablar: es el 409 del `connGate` real, y es la firma con
    // la que se manifestaba el defecto (expulsado ⇒ 409 collab_no_session en todo lo que mande).
    if (this.expulsados.has(siteId)) {
      return { status: 409, body: { code: "collab_no_session", message: "No hay una sesión colaborativa abierta para ese siteId." } };
    }

    const freno = this.ritmo(siteId, path, payload);
    if (freno) return freno;

    return this.aplica(path, payload, siteId);
  }

  /**
   * EL FRENO DE RITMO DEL SERVIDOR REAL, con su regla de expulsión.
   *
   * Reproduce `rateGate` de backend/src/core/collab-rooms.ts, y en particular la parte sin la cual un
   * test de esta propiedad sería VACUO: este doble SÍ PUEDE EXPULSAR. Si solo devolviera 429, la
   * aserción «el cliente nunca recibe un 409 collab_no_session» se cumpliría sola y no probaría nada.
   * Hay un test de control negativo que comprueba que expulsa de verdad.
   *
   * La regla: un rechazo emite una instrucción `{retryAfterMs, notice}`; solo suma strike un frame
   * que llega con `rateAck >= notice` VIGENTE y antes del plazo, o sea uno cuyo emisor reconoce haber
   * recibido esa instrucción concreta. Un frame en vuelo trae un acuse anterior y nunca puede contar.
   */
  private ritmo(siteId: string, path: string, payload: PostBody): PostResponse | null {
    if (path !== "ops" && path !== "presence" && path !== "resync") return null;

    const now = this.clock();
    const r = this.rateState(siteId, now);

    const ack = Number(payload?.rateAck);
    if (Number.isFinite(ack) && ack > r.ack) r.ack = ack;

    const ops = path === "ops" ? (payload.ops ?? []).length : path === "resync" ? this.limits.resyncOpCost : 0;
    const bytes = path === "ops" ? JSON.stringify(payload.ops ?? null).length : 0;
    const presence = path === "presence" ? 1 : 0;

    const forzado = (this.refuse[path] ?? 0) > 0;
    if (forzado) this.refuse[path]--;

    const falta = forzado
      || (ops > 0 && r.opTokens < ops)
      || (bytes > 0 && r.byteTokens < bytes)
      || (presence > 0 && r.presenceTokens < presence);

    if (!falta) {
      r.opTokens -= ops;
      r.byteTokens -= bytes;
      r.presenceTokens -= presence;
      r.strikes = 0;
      r.retryAt = 0;
      return null;
    }

    const vigente = now < r.retryAt;
    if (vigente && r.ack >= r.notice) {
      r.strikes++;
      if (r.strikes >= this.limits.maxStrikes) {
        this.expulsados.add(siteId);
        this.expulsiones.push({ siteId, at: now });
        const h = this.handlers.get(siteId);
        this.handlers.delete(siteId);
        this.presence.delete(siteId);
        h?.onEvent("error", { code: "rate_limit", message: "Demasiadas operaciones: conexión cerrada." });
        return { status: 409, body: { code: "collab_no_session", message: "No hay una sesión colaborativa abierta para ese siteId." } };
      }
    }
    if (!vigente) {
      r.notice++;
      r.retryAt = now + this.rateRetryMs;
    }
    return {
      status: 429,
      body: {
        code: "collab_rate_limit",
        retryAfterMs: Math.max(0, r.retryAt - now),
        rateNotice: r.notice,
      },
    };
  }

  private rateState(siteId: string, now: number): Rate {
    let r = this.rate.get(siteId);
    if (!r) {
      r = {
        opTokens: this.limits.opsBurst,
        byteTokens: this.limits.bytesBurst,
        presenceTokens: this.limits.presenceBurst,
        lastRefill: now,
        strikes: 0, notice: 0, retryAt: 0, ack: 0,
      };
      this.rate.set(siteId, r);
      return r;
    }
    const dt = Math.max(0, now - r.lastRefill) / 1000;
    if (dt > 0) {
      r.lastRefill = now;
      r.opTokens = Math.min(this.limits.opsBurst, r.opTokens + dt * this.limits.maxOpsPerSec);
      r.byteTokens = Math.min(this.limits.bytesBurst, r.byteTokens + dt * this.limits.maxBytesPerSec);
      r.presenceTokens = Math.min(this.limits.presenceBurst, r.presenceTokens + dt * this.limits.maxPresencePerSec);
    }
    return r;
  }

  /**
   * Cobra bytes YA SERVIDOS (la respuesta de un `resync`), con el mismo SUELO que el real: la deuda
   * no puede pasar de una ráfaga, o el tiempo de recuperación crecería con el documento.
   */
  private cobraBytes(siteId: string, bytes: number): void {
    const r = this.rateState(siteId, this.clock());
    r.byteTokens = Math.max(-this.limits.bytesBurst, r.byteTokens - Math.max(0, bytes));
  }

  private aplica(path: string, payload: PostBody, siteId: string): PostResponse {
    {
        if (path === "ops") {
          if (Number(payload.epoch) !== this.epoch) {
            return { status: 409, body: { code: "collab_epoch" } };
          }
          const fresh: CollabOp[] = [];
          for (const op of payload.ops ?? []) {
            const dot = `${op.id.site}@${op.id.counter}`;
            if (this.seen.has(dot)) continue;
            this.seen.add(dot);
            this.log.push(op);
            fresh.push(op);
          }
          if (fresh.length) {
            for (const [other] of this.handlers) {
              if (other !== siteId) this.enqueue(other, "ops", { ops: fresh, from: siteId, epoch: this.epoch });
            }
          }
          const known = (payload.ops ?? []).length - fresh.length;
          return { status: 200, body: { ok: true, accepted: fresh.length, known, rejected: [], persisted: true, normalized: [] } };
        }

        if (path === "presence") {
          const client = this.clients.get(siteId);
          const entry: CollabMember = {
            siteId, userId: client?.userId ?? 0, name: client?.name ?? siteId,
            color: "#2563eb", sel: (payload.sel ?? null) as CollabMember["sel"], at: 0,
          };
          this.presence.set(siteId, entry);
          for (const [other] of this.handlers) {
            if (other !== siteId) this.enqueue(other, "presence", { entries: [entry] });
          }
          return { status: 200, body: { ok: true } };
        }

        if (path === "resync") {
          // Igual que el servidor real: con OTRA generación no se puede filtrar por version vector
          // —las posiciones semilla del cliente ya no existen— así que se devuelve el snapshot base
          // y el log entero para que re-siembre.
          //
          // Y como el real, LO LEÍDO SE COBRA ENTERO aunque se filtre después: el coste que hay que
          // frenar es recorrer la sala. Es lo que deja el cubo de bytes en descubierto y lo que
          // convierte un resync legítimo en una ráfaga de 429 — el escenario del defecto.
          const otraGeneracion = Number(payload.epoch) !== this.epoch;
          const vv = payload.vv ?? {};
          const ops = otraGeneracion ? [...this.log] : this.log.filter((op) => !(vv[op.id.site] >= op.id.counter));
          this.cobraBytes(siteId, JSON.stringify(this.log).length);
          return otraGeneracion
            ? { status: 200, body: { epoch: this.epoch, base: this.base, ops, complete: true } }
            : { status: 200, body: { epoch: this.epoch, ops, complete: true } };
        }

        return { status: 404, body: null };
    }
  }

  private enqueue(siteId: string, event: string, data: unknown): void {
    if (this.mode === "auto") {
      this.handlers.get(siteId)?.onEvent(event, data);
      return;
    }
    this.outbox.push({ siteId, event, data });
  }

  get pending(): number {
    return this.outbox.length;
  }

  /**
   * Entrega lo pendiente. `order` permuta la cola: es el corazón del test de convergencia — cada
   * réplica ve las mismas ops en un orden distinto y aun así tiene que acabar idéntica.
   */
  deliver(order?: (items: Pending[]) => Pending[]): void {
    const batch = this.outbox;
    this.outbox = [];
    for (const item of order ? order(batch) : batch) {
      this.handlers.get(item.siteId)?.onEvent(item.event, item.data);
    }
  }

  /** Entrega repetidamente hasta que nadie genera nada nuevo (el reposo de la sala). */
  drain(order?: (items: Pending[]) => Pending[], maxRounds = 50): void {
    for (let i = 0; i < maxRounds && this.outbox.length; i++) this.deliver(order);
  }

  /** Empuja un evento del SERVIDOR a un cliente concreto (avisos, errores de sala). */
  emit(siteOrNonce: string, event: string, data: unknown): void {
    const key = this.handlers.has(siteOrNonce) ? siteOrNonce : this.siteFor(siteOrNonce);
    this.handlers.get(key)?.onEvent(event, data);
  }

  /**
   * Corta el canal de un cliente sin avisar, como una caída de red. Admite el NONCE o la identidad
   * derivada por comodidad del test: cortar el cable no tiene nada que ver con la identidad.
   */
  dropStream(siteOrNonce: string): void {
    const key = this.handlers.has(siteOrNonce) ? siteOrNonce : this.siteFor(siteOrNonce);
    const h = this.handlers.get(key);
    this.handlers.delete(key);
    h?.onError(new Error("caída de red simulada"));
  }
}

/** PRNG determinista: un test que baraja tiene que poder repetirse exactamente igual al fallar. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

export function shuffler(rng: () => number) {
  return <T>(items: T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
}
