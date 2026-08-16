/**
 * GATE G-F8.1-b — CONFORMIDAD CON EL PAPER (cierra [ABIERTO-1] de la spec).
 *
 * Los escenarios de interleaving del paper codificados como tests, con el
 * resultado que el paper espera. La spec lo dice explícitamente: si nuestra
 * lectura del paper produce otro resultado, **el test manda y el código se
 * corrige** — jamás al revés.
 *
 * Fuentes de las reglas verificadas aquí (agosto 2026):
 * - Weidner, *Fugue: A Basic List CRDT* — regla `createBetween` (ancestro).
 * - Weidner, Gentle, Kleppmann, *The Art of the Fugue* (arXiv:2305.00583):
 *   «FugueMax is the replicated list algorithm that is identical to Fugue
 *   except that its tree traversal visits right-side siblings in the *reverse*
 *   order of their right origins, breaking ties using the lexicographic order
 *   of their IDs.»
 */

import { describe, expect, it } from "vitest";
import { FugueList } from "../fugue";
import { compareOpId, opIdKey, type OpId } from "../identity";
import { mulberry32, shuffle } from "./helpers";

interface Ins {
  id: OpId;
  left: string | null;
  right: string | null;
  value: string;
}

const ins = (site: string, counter: number, left: string | null, right: string | null, value: string): Ins => ({
  id: { site, counter },
  left,
  right,
  value,
});

function build(inserts: readonly Ins[]): FugueList<string> {
  const list = new FugueList<string>();
  for (const i of inserts) list.integrate(i.id, i.left, i.right, i.value);
  return list;
}

/** Aplica los mismos inserts en N órdenes distintos y exige el MISMO resultado. */
function convergesUnderPermutation(inserts: readonly Ins[], seed: number, tries = 12): string[] {
  const reference = build(inserts).values();
  const rng = mulberry32(seed);
  for (let t = 0; t < tries; t++) {
    const list = new FugueList<string>();
    // Entrega fuera de orden causal: se reintenta hasta que todo integra.
    let queue = shuffle(rng, inserts);
    for (let pass = 0; pass < inserts.length + 2 && queue.length > 0; pass++) {
      const next: Ins[] = [];
      for (const i of queue) {
        const res = list.integrate(i.id, i.left, i.right, i.value);
        if (!res.ok) next.push(i);
      }
      queue = next;
    }
    expect(list.values(), `permutación ${t}`).toEqual(reference);
  }
  return reference;
}

describe("FugueList — reglas del árbol", () => {
  it("inserción al final encadena hijos DERECHOS; al principio, izquierdos", () => {
    const list = new FugueList<string>();
    list.integrate({ site: "s_a", counter: 1 }, null, null, "a");
    list.integrate({ site: "s_a", counter: 2 }, "s_a@1", null, "b");
    list.integrate({ site: "s_a", counter: 3 }, null, "s_a@1", "z");
    expect(list.values()).toEqual(["z", "a", "b"]);
  });

  it("el borrado deja TOMBSTONE: las posiciones siguen sirviendo de origen", () => {
    const list = new FugueList<string>();
    list.integrate({ site: "s_a", counter: 1 }, null, null, "a");
    list.integrate({ site: "s_a", counter: 2 }, "s_a@1", null, "b");
    list.remove("s_a@1");
    expect(list.values()).toEqual(["b"]);
    // Una op concurrente que referencia la posición borrada sigue integrando.
    const res = list.integrate({ site: "s_b", counter: 1 }, "s_a@1", "s_a@2", "c");
    expect(res).toEqual({ ok: true, created: true });
    expect(list.values()).toEqual(["c", "b"]);
  });

  it("integrar dos veces el mismo OpId es un no-op EXACTO (idempotencia)", () => {
    const list = new FugueList<string>();
    list.integrate({ site: "s_a", counter: 1 }, null, null, "a");
    const before = list.debugDump();
    expect(list.integrate({ site: "s_a", counter: 1 }, null, null, "OTRO")).toEqual({ ok: true, created: false });
    expect(list.debugDump()).toBe(before);
    expect(list.values()).toEqual(["a"]);
  });

  it("un origen ausente NO lanza: devuelve la dependencia que falta", () => {
    const list = new FugueList<string>();
    expect(list.integrate({ site: "s_a", counter: 1 }, "fantasma@1", null, "a")).toEqual({
      ok: false,
      code: "missing-origin",
      dep: "fantasma@1",
    });
  });
});

describe("FugueList — no-interleaving (escenarios del paper)", () => {
  it("LtR: dos tiradas escritas HACIA ADELANTE en el mismo hueco no se intercalan", () => {
    // A escribe "abc" y B escribe "xyz", ambos entre el principio y el final.
    const inserts: Ins[] = [
      ins("s_a", 1, null, null, "a"),
      ins("s_a", 2, "s_a@1", null, "b"),
      ins("s_a", 3, "s_a@2", null, "c"),
      ins("s_b", 1, null, null, "x"),
      ins("s_b", 2, "s_b@1", null, "y"),
      ins("s_b", 3, "s_b@2", null, "z"),
    ];
    const order = convergesUnderPermutation(inserts, 11);
    const texto = order.join("");
    expect(["abcxyz", "xyzabc"]).toContain(texto);
  });

  it("RtL: dos tiradas escritas HACIA ATRÁS en el mismo hueco no se intercalan", () => {
    // Cada autor teclea su tirada de derecha a izquierda (prepends repetidos),
    // que es justo donde RGA sí intercala.
    const inserts: Ins[] = [
      ins("s_a", 1, null, null, "c"),
      ins("s_a", 2, null, "s_a@1", "b"),
      ins("s_a", 3, null, "s_a@2", "a"),
      ins("s_b", 1, null, null, "z"),
      ins("s_b", 2, null, "s_b@1", "y"),
      ins("s_b", 3, null, "s_b@2", "x"),
    ];
    const order = convergesUnderPermutation(inserts, 12);
    const texto = order.join("");
    expect(["abcxyz", "xyzabc"]).toContain(texto);
  });

  it("EL escenario que separa FugueMax de Fugue: hermanos derechos con orígenes distintos", () => {
    // Estado compartido: [p]. Luego, concurrentemente:
    //  · A inserta a1 al final de [p]           → hijo derecho de p, origen END
    //  · B inserta c  al final de [p]           → hijo derecho de p, origen END
    // Al fusionar, c ordena antes que a1 (counter menor) ⇒ [p, c, a1].
    //  · A sigue escribiendo HACIA ATRÁS: a2 entre c y a1 → hijo DERECHO de c
    //    con origen derecho a1.
    //  · D (que solo vio [p, c]) escribe al final: d1 entre c y END → hijo
    //    DERECHO de c con origen END; y d2 justo antes de d1.
    // c tiene entonces dos hijos derechos con orígenes DISTINTOS: a2→a1, d1→END.
    const inserts: Ins[] = [
      ins("s_p", 1, null, null, "p"),
      ins("s_b", 1, "s_p@1", null, "c"),
      ins("s_a", 5, "s_p@1", null, "a1"),
      ins("s_a", 6, "s_b@1", "s_a@5", "a2"),
      ins("s_d", 9, "s_b@1", null, "d1"),
      ins("s_d", 10, "s_b@1", "s_d@9", "d2"),
    ];
    const order = convergesUnderPermutation(inserts, 13);

    // FugueMax: orden INVERSO de los orígenes derechos ⇒ el de origen END (d1)
    // va ANTES que el de origen a1 (a2), que se queda pegado a su origen.
    expect(order).toEqual(["p", "c", "d2", "d1", "a2", "a1"]);

    // Cada tirada queda CONTIGUA: es la propiedad, no el orden concreto.
    const adjacent = (x: string, y: string) => order.indexOf(y) === order.indexOf(x) + 1;
    expect(adjacent("a2", "a1")).toBe(true);
    expect(adjacent("d2", "d1")).toBe(true);

    // Contrafactual EXPLÍCITO: con el desempate de Fugue base (solo por id),
    // a2 (counter 6) ordenaría ANTES que d1 (counter 9) y partiría la tirada de
    // A en dos trozos con la de D en medio. Esa es exactamente la anomalía que
    // FugueMax elimina y por la que se eligió (D1).
    expect(compareOpId({ site: "s_a", counter: 6 }, { site: "s_d", counter: 9 })).toBeLessThan(0);
    expect(order.indexOf("d1")).toBeLessThan(order.indexOf("a2"));
  });

  it("el desempate entre hermanos es TOTAL y determinista (counter, luego siteId)", () => {
    const inserts: Ins[] = [
      ins("s_b", 7, null, null, "B"),
      ins("s_a", 7, null, null, "A"),
      ins("s_c", 3, null, null, "C"),
    ];
    // Mismo counter ⇒ desempata el siteId; counter menor primero.
    expect(convergesUnderPermutation(inserts, 14)).toEqual(["C", "A", "B"]);
  });

  it("`compare` es un orden total consistente con el recorrido", () => {
    const rng = mulberry32(99);
    const list = new FugueList<string>();
    const positions: string[] = [];
    for (let i = 1; i <= 40; i++) {
      const id: OpId = { site: `s_${i % 3}`, counter: i };
      const left = positions.length > 0 ? positions[Math.floor(rng() * positions.length)] : null;
      const right = null;
      list.integrate(id, left, right, `v${i}`);
      positions.push(opIdKey(id));
    }
    const order = list.livePositions();
    for (let i = 0; i + 1 < order.length; i++) {
      expect(list.compare(order[i], order[i + 1])).toBeLessThan(0);
      expect(list.compare(order[i + 1], order[i])).toBeGreaterThan(0);
      expect(list.compare(order[i], order[i])).toBe(0);
    }
  });
});
