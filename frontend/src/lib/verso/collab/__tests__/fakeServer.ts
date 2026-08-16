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
    const mix = (i < 8 ? h1 >>> (i * 4) : h2 >>> ((i - 8) * 4)) ^ (i * 7);
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
  private outbox: Pending[] = [];
  /**
   * Nonces tal cual llegaron en la query de cada `GET /stream`, en orden. Es la huella del PRODUCTOR
   * REAL (`client.ts#openStream`): un test de reconexión que no la mire está probando el doble.
   */
  readonly openedWith: string[] = [];

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
          limits: { maxOpsPerSec: 50, maxBytesPerSec: 65536, maxFrameBytes: 262144 },
        });
        for (const [other] of this.handlers) {
          if (other !== siteId) this.enqueue(other, "members", { joined: { ...self, sel: null, at: 0 } });
        }
        return { close: () => { this.handlers.delete(siteId); this.presence.delete(siteId); } };
      },

      post: async (url: string, body: unknown): Promise<PostResponse> => {
        const path = url.split("/").pop() ?? "";
        const payload = body as { siteId?: string; epoch?: number; ops?: CollabOp[]; sel?: unknown; vv?: Record<string, number> };
        const siteId = String(payload?.siteId ?? "");

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
          if (Number(payload.epoch) !== this.epoch) {
            return { status: 200, body: { epoch: this.epoch, base: this.base, ops: [...this.log], complete: true } };
          }
          const vv = payload.vv ?? {};
          const missing = this.log.filter((op) => !(vv[op.id.site] >= op.id.counter));
          return { status: 200, body: { epoch: this.epoch, ops: missing, complete: true } };
        }

        if (path === "leave") return { status: 200, body: { ok: true } };
        return { status: 404, body: null };
      },
    };
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
