/**
 * Verso CRDT — identidad de réplica, causal dots y reloj híbrido.
 *
 * Contrato: documentation/verso/crdt-spec.md §2 (IDENTIDAD Y CAUSALIDAD).
 * - `siteId` por SESIÓN de edición (D7): dos pestañas del mismo autor son dos
 *   réplicas. Nunca se deriva del userId y nunca se persiste en sessionStorage
 *   (reutilizarlo con el contador reiniciado rompería la unicidad del dot).
 * - `OpId = (siteId, counter)` es el causal dot: identidad de posición Y de
 *   operación (idempotencia por deduplicación exacta).
 * - HLC (Kulkarni et al.) EXCLUSIVAMENTE para LWW (D9). La lista JAMÁS se
 *   ordena por tiempo: eso lo hace el árbol de posiciones de Fugue.
 *
 * Módulo puro: sin red, sin DOM, sin estado global.
 */

export type SiteId = string;

/** Causal dot. `counter` monótono por sitio, empieza en 1 y jamás se reutiliza. */
export interface OpId {
  readonly site: SiteId;
  readonly counter: number;
}

/** Clave textual de un OpId; es también la referencia a una POSICIÓN (posId). */
export type PosRef = string;

/**
 * Prefijo reservado para las identidades DERIVADAS del snapshot inicial (las
 * posiciones del contenido que ya existía al abrir la sala). No las emite
 * ningún sitio: las calcula toCrdt() de forma pura, así que todas las réplicas
 * que parten del mismo `_puck_data` obtienen exactamente las mismas posiciones
 * sin coordinarse. `createSiteId` garantiza que un sitio real jamás colisiona.
 */
export const SEED_PREFIX = "~";

/** Sitio de las posiciones semilla de los slots (orden DFS del snapshot). */
export const SEED_SITE: SiteId = "~s";

/** Sitio de las posiciones semilla de los átomos de un campo de texto. */
export function textSeedSite(nodeId: string, field: string): SiteId {
  return `~t:${nodeId}:${field}`;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * `siteId = 's_' + base32(10 bytes)` (§2.1). El prefijo `s_` es lo que hace
 * imposible la colisión con los sitios semilla (`~…`), que es un invariante de
 * convergencia, no una comodidad: una semilla suplantada reordenaría el doc.
 */
export function createSiteId(random?: (n: number) => Uint8Array): SiteId {
  const bytes =
    random?.(10) ??
    (() => {
      const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
      const out = new Uint8Array(10);
      if (c?.getRandomValues) return c.getRandomValues(out);
      for (let i = 0; i < out.length; i++) out[i] = Math.floor(Math.random() * 256);
      return out;
    })();
  let s = "";
  for (const b of bytes) s += B32[b >>> 3] + B32[((b & 0b111) << 2) % 32];
  return `s_${s.slice(0, 16)}`;
}

/** ¿Es `site` una identidad de réplica legítima (no una semilla suplantada)? */
export function isRealSiteId(site: unknown): site is SiteId {
  return typeof site === "string" && site.length > 0 && !site.startsWith(SEED_PREFIX);
}

export function opIdKey(id: OpId): PosRef {
  return `${id.site}@${id.counter}`;
}

/** OpId de una clave textual, o null si la clave no tiene la forma esperada. */
export function parseOpId(key: PosRef): OpId | null {
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  const counter = Number(key.slice(at + 1));
  if (!Number.isInteger(counter) || counter < 0) return null;
  return { site: key.slice(0, at), counter };
}

/**
 * Desempate entre hermanos (§1.2): PRIMERO `counter`, DESPUÉS `siteId` como
 * cadena. Total y determinista — que es lo único que la convergencia exige.
 */
export function compareOpId(a: OpId, b: OpId): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.site === b.site) return 0;
  return a.site < b.site ? -1 : 1;
}

/* ------------------------------------------------------------------ */
/* HLC — Hybrid Logical Clock (§2.3). Solo para LWW.                   */
/* ------------------------------------------------------------------ */

/**
 * `l` = componente físico (ms) ya acotado por el algoritmo; `c` = contador
 * lógico; `site` = desempate final. (La spec llama `wall` al componente físico
 * y `l`/`c` a los del algoritmo: aquí son `l` y `c`, un solo nombre por campo.)
 */
export interface Hlc {
  readonly l: number;
  readonly c: number;
  readonly site: SiteId;
}

/** Orden lexicográfico (l, c, site) — total y determinista. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.l !== b.l) return a.l < b.l ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  if (a.site === b.site) return 0;
  return a.site < b.site ? -1 : 1;
}

/**
 * Sello de una escritura LWW: el HLC más el causal dot de la op que la emitió.
 *
 * El dot NO es decoración: un emisor bizantino (o una réplica con el reloj
 * pisado) puede mandar dos escrituras con HLC EXACTAMENTE igual y valores
 * distintos; sin un desempate final por dot, ganaría "la que llegó primero" y
 * dos réplicas divergirían. Con él, el orden LWW es TOTAL sobre las ops, no
 * solo sobre los relojes. Cazado por el fuzzing adversarial.
 */
export interface Stamp {
  hlc: Hlc;
  /** `opIdKey` de la operación que hizo la escritura. */
  tie: string;
}

export function compareStamp(a: Stamp, b: Stamp): number {
  const byHlc = compareHlc(a.hlc, b.hlc);
  if (byHlc !== 0) return byHlc;
  if (a.tie === b.tie) return 0;
  return a.tie < b.tie ? -1 : 1;
}

/**
 * Deriva máxima que un reloj remoto puede imponer al LOCAL (24 h).
 *
 * Un HLC remoto absurdamente adelantado se respeta para ORDENAR (rechazarlo
 * divergiría: dos réplicas que rechazan cosas distintas ven cosas distintas),
 * pero NO adelanta el reloj local más allá de este techo. Así un cliente con
 * el reloj torcido gana sus propios conflictos, pero no envenena a la sala
 * para siempre — que es exactamente el fallo que HLC existe para acotar.
 */
export const MAX_CLOCK_DRIFT_MS = 24 * 60 * 60 * 1000;

export class HlcClock {
  readonly site: SiteId;
  private readonly now: () => number;
  private l = 0;
  private c = 0;

  constructor(site: SiteId, now: () => number = () => Date.now()) {
    this.site = site;
    this.now = now;
  }

  /** Estado actual sin avanzar (para inspección/tests). */
  peek(): Hlc {
    return { l: this.l, c: this.c, site: this.site };
  }

  /** Marca de tiempo para una operación LOCAL (send). */
  send(): Hlc {
    const wall = this.physical();
    const l = Math.max(this.l, wall);
    this.c = l === this.l ? this.c + 1 : 0;
    this.l = l;
    return { l: this.l, c: this.c, site: this.site };
  }

  /** Integra el HLC de una op REMOTA (receive). Nunca lanza. */
  receive(remote: Hlc | undefined | null): void {
    if (!remote || !Number.isFinite(remote.l) || !Number.isFinite(remote.c)) return;
    const wall = this.physical();
    // Techo anti-deriva: un remoto del futuro lejano ordena, pero no arrastra.
    const rl = Math.min(remote.l, Math.max(wall, this.l) + MAX_CLOCK_DRIFT_MS);
    const rc = Math.max(0, Math.trunc(remote.c));
    const l = Math.max(this.l, rl, wall);
    if (l === this.l && l === rl) this.c = Math.max(this.c, rc) + 1;
    else if (l === this.l) this.c = this.c + 1;
    else if (l === rl) this.c = rc + 1;
    else this.c = 0;
    this.l = l;
  }

  private physical(): number {
    const n = this.now();
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
}

/* ------------------------------------------------------------------ */
/* Version vector (§2.4)                                               */
/* ------------------------------------------------------------------ */

export type VersionVector = Record<SiteId, number>;

export function bumpVersionVector(vv: VersionVector, id: OpId): void {
  const cur = Object.hasOwn(vv, id.site) ? vv[id.site] : 0;
  if (id.counter > cur) vv[id.site] = id.counter;
}
