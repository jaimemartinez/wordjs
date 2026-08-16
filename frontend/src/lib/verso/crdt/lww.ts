/**
 * Verso CRDT — mapa LWW por CLAVE con HLC (D3, §1.3).
 *
 * Granularidad = clave, no nodo: dos autores que tocan `color` y `padding` del
 * mismo bloque NO se pisan. El borrado de clave es un TOMBSTONE con su propio
 * sello (`present: false`), porque "borrado" tiene que poder ganar a un escrito
 * anterior y perder contra uno posterior — un mapa que solo guardase valores no
 * distinguiría "nunca existió" de "lo borré después de tu escritura".
 *
 * El sello es (HLC, causal dot): el dot desempata los HLC exactamente iguales,
 * que solo produce un emisor bizantino pero que sin él rompen la convergencia
 * (ver `Stamp` en identity.ts).
 *
 * Los valores BASE (los que venían en el snapshot con el que arranca la sala)
 * no llevan sello: cualquier op los gana, porque toda op es posterior al
 * snapshot por construcción (la sala nace del `_puck_data` persistido).
 *
 * ORDEN DE CLAVES (importa para el round-trip byte-exacto, D12): las claves del
 * snapshot conservan su posición original; las claves NUEVAS van después,
 * ordenadas por el sello de la escritura que las hizo aparecer — función pura
 * del conjunto de ops, así que dos réplicas emiten el mismo objeto sea cual sea
 * el orden de llegada.
 */

import { compareStamp, type Stamp } from "./identity";
import { setOwn } from "./objects";

interface LwwEntry {
  value: unknown;
  stamp: Stamp;
  present: boolean;
}

export class LwwMap {
  private readonly base = new Map<string, unknown>();
  private readonly baseOrder: string[] = [];
  private readonly entries = new Map<string, LwwEntry>();
  /**
   * Sello del mayor borrado VISTO para cada clave, aunque haya perdido. No es
   * decoración: una clave borrada y vuelta a escribir tiene que reaparecer al
   * FINAL del objeto (es lo que hace `delete obj.k; obj.k = v` en JS y por tanto
   * lo que hace `applyCommand`), y "¿hubo un borrado anterior al ganador?" solo
   * es independiente del orden de llegada si se recuerda el borrado perdedor.
   */
  private readonly deletedAt = new Map<string, Stamp>();
  /** Sello de la escritura que hizo APARECER la clave (su hueco en el objeto). */
  private readonly posStamp = new Map<string, Stamp>();

  constructor(base?: Record<string, unknown>, order?: readonly string[]) {
    if (base) {
      const keys = order ?? Object.keys(base);
      for (const k of keys) {
        if (!Object.hasOwn(base, k)) continue;
        if (this.base.has(k)) continue;
        this.base.set(k, base[k]);
        this.baseOrder.push(k);
      }
    }
  }

  /** true si la escritura GANA (sello mayor); false si pierde y no cambia nada. */
  set(key: string, value: unknown, stamp: Stamp): boolean {
    return this.write(key, value, stamp, true);
  }

  /** Tombstone de clave. Mismo álgebra que `set`. */
  delete(key: string, stamp: Stamp): boolean {
    return this.write(key, undefined, stamp, false);
  }

  private write(key: string, value: unknown, stamp: Stamp, present: boolean): boolean {
    this.trackPosition(key, stamp, present);
    const cur = this.entries.get(key);
    if (cur && compareStamp(stamp, cur.stamp) <= 0) return false;
    this.entries.set(key, { value, stamp, present });
    return true;
  }

  /**
   * Mantiene el RANGO de posición de la clave: el sello de la escritura que la
   * hizo aparecer (no el de la última). Reescribir una clave existente no la
   * mueve — que es lo que hace `obj.k = v` en JS — mientras que borrarla y
   * volver a escribirla sí la manda al final. Los dos sellos que se guardan
   * (`deletedAt` máximo y `posStamp` mínimo posterior a él) hacen que el
   * resultado no dependa del ORDEN DE LLEGADA, que es lo que aquí se juega.
   */
  private trackPosition(key: string, stamp: Stamp, present: boolean): void {
    const maxDel = this.deletedAt.get(key);
    if (present) {
      if (maxDel && compareStamp(stamp, maxDel) < 0) return; // set anterior al borrado: no posiciona
      const cur = this.posStamp.get(key);
      if (!cur || compareStamp(stamp, cur) < 0) this.posStamp.set(key, stamp);
      return;
    }
    if (maxDel && compareStamp(stamp, maxDel) <= 0) return;
    this.deletedAt.set(key, stamp);
    const cur = this.posStamp.get(key);
    if (cur && compareStamp(cur, stamp) < 0) {
      // El borrado invalida la posición previa: si el ganador es un `set`
      // posterior, la clave reaparece en el sitio de ESE set.
      const winner = this.entries.get(key);
      if (winner?.present && compareStamp(winner.stamp, stamp) > 0) this.posStamp.set(key, winner.stamp);
      else this.posStamp.delete(key);
    }
  }

  has(key: string): boolean {
    const e = this.entries.get(key);
    if (e) return e.present;
    return this.base.has(key);
  }

  get(key: string): unknown {
    const e = this.entries.get(key);
    if (e) return e.present ? e.value : undefined;
    return this.base.get(key);
  }

  /** Sello de la escritura ganadora, o null si el valor viene del snapshot. */
  stampOf(key: string): Stamp | null {
    return this.entries.get(key)?.stamp ?? null;
  }

  /** Claves presentes en ORDEN de serialización (base primero, nuevas después). */
  keysInOrder(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const resurrected = new Set<string>();
    for (const k of this.baseOrder) {
      seen.add(k);
      if (!this.has(k)) continue;
      // Clave del snapshot borrada y reescrita ⇒ pierde su hueco original y
      // vuelve al final, igual que en un objeto JS.
      if (this.deletedAt.has(k)) {
        resurrected.add(k);
        continue;
      }
      out.push(k);
    }
    const fresh: { key: string; stamp: Stamp }[] = [];
    for (const [k, e] of this.entries) {
      if (!e.present) continue;
      if (seen.has(k) && !resurrected.has(k)) continue;
      fresh.push({ key: k, stamp: this.posStamp.get(k) ?? e.stamp });
    }
    fresh.sort((a, b) => {
      const byStamp = compareStamp(a.stamp, b.stamp);
      if (byStamp !== 0) return byStamp;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    for (const f of fresh) out.push(f.key);
    return out;
  }

  toObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of this.keysInOrder()) setOwn(out, k, this.get(k));
    return out;
  }
}
