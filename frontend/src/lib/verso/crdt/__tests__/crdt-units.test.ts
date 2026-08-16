/**
 * Unidades del núcleo: identidad, reloj, mapa LWW y campo de texto.
 *
 * Estos tests fijan las reglas que los demás dan por supuestas — si una de
 * ellas cambia, aquí falla algo concreto y legible en vez de fallar "la
 * convergencia" en un escenario 743 con 40 ops.
 */

import { describe, expect, it } from "vitest";
import {
  compareOpId,
  compareStamp,
  createSiteId,
  HlcClock,
  isRealSiteId,
  opIdKey,
  parseOpId,
  SEED_SITE,
  textSeedSite,
} from "../identity";
import { LwwMap } from "../lww";
import { TextField } from "../text";

const stamp = (l: number, c: number, site: string, tie = `${site}@${c}`) => ({ hlc: { l, c, site }, tie });

describe("identidad", () => {
  it("`siteId` real nunca colisiona con los sitios SEMILLA", () => {
    for (let i = 0; i < 50; i++) {
      const site = createSiteId((n) => new Uint8Array(n).fill(i));
      expect(site.startsWith("s_")).toBe(true);
      expect(isRealSiteId(site)).toBe(true);
      expect(isRealSiteId(SEED_SITE)).toBe(false);
      expect(isRealSiteId(textSeedSite("n", "content"))).toBe(false);
    }
  });

  it("el desempate de hermanos es (counter, siteId) y es total", () => {
    expect(compareOpId({ site: "s_b", counter: 1 }, { site: "s_a", counter: 2 })).toBeLessThan(0);
    expect(compareOpId({ site: "s_b", counter: 2 }, { site: "s_a", counter: 2 })).toBeGreaterThan(0);
    expect(compareOpId({ site: "s_a", counter: 2 }, { site: "s_a", counter: 2 })).toBe(0);
  });

  it("`opIdKey`/`parseOpId` son inversos incluso con `@` en el siteId", () => {
    const id = { site: "~t:nodo@raro:content", counter: 12 };
    expect(parseOpId(opIdKey(id))).toEqual(id);
    expect(parseOpId("sin-arroba")).toBeNull();
  });

  it("HLC: `send` es monótono aunque el reloj físico no avance", () => {
    const clock = new HlcClock("s_a", () => 1000);
    const a = clock.send();
    const b = clock.send();
    const c = clock.send();
    expect(compareStamp({ hlc: a, tie: "" }, { hlc: b, tie: "" })).toBeLessThan(0);
    expect(compareStamp({ hlc: b, tie: "" }, { hlc: c, tie: "" })).toBeLessThan(0);
  });

  it("HLC: `receive` avanza el reloj pero un remoto del futuro NO lo envenena", () => {
    const clock = new HlcClock("s_a", () => 1_000);
    clock.receive({ l: 5_000, c: 3, site: "s_b" });
    expect(clock.peek().l).toBe(5_000);
    clock.receive({ l: 1e15, c: 0, site: "s_malo" });
    expect(clock.peek().l).toBeLessThan(5_000 + 25 * 60 * 60 * 1000);
    // Un remoto basura no rompe nada.
    clock.receive(null);
    clock.receive({ l: Number.NaN, c: 0, site: "s_x" });
    expect(Number.isFinite(clock.peek().l)).toBe(true);
  });

  it("el sello desempata HLC exactamente iguales por el causal dot", () => {
    const a = stamp(5, 1, "s_x", "s_x@1");
    const b = stamp(5, 1, "s_x", "s_x@2");
    expect(compareStamp(a, b)).toBeLessThan(0);
    expect(compareStamp(b, a)).toBeGreaterThan(0);
  });
});

describe("LwwMap", () => {
  it("gana el sello mayor, por CLAVE", () => {
    const m = new LwwMap({ a: 1, b: 2 }, ["a", "b"]);
    expect(m.set("a", 10, stamp(5, 0, "s_a"))).toBe(true);
    expect(m.set("a", 99, stamp(3, 0, "s_a"))).toBe(false);
    expect(m.get("a")).toBe(10);
    expect(m.get("b")).toBe(2);
  });

  it("el borrado es un tombstone que puede ganar y perder", () => {
    const m = new LwwMap({ a: 1 });
    m.delete("a", stamp(5, 0, "s_a"));
    expect(m.has("a")).toBe(false);
    m.set("a", 2, stamp(4, 0, "s_a"));
    expect(m.has("a")).toBe(false); // escritura anterior al borrado: pierde
    m.set("a", 3, stamp(6, 0, "s_a"));
    expect(m.get("a")).toBe(3);
  });

  it("una clave del snapshot conserva su hueco; borrada+reescrita va al final", () => {
    const m = new LwwMap({ a: 1, b: 2, c: 3 }, ["a", "b", "c"]);
    m.set("b", 20, stamp(5, 0, "s_a"));
    expect(m.keysInOrder()).toEqual(["a", "b", "c"]);
    m.delete("a", stamp(6, 0, "s_a"));
    m.set("a", 100, stamp(7, 0, "s_a"));
    expect(m.keysInOrder()).toEqual(["b", "c", "a"]);
  });

  it("las claves NUEVAS se ordenan por la escritura que las creó, no por la última", () => {
    const m = new LwwMap({ id: "x" }, ["id"]);
    m.set("primera", 1, stamp(10, 0, "s_a"));
    m.set("segunda", 2, stamp(11, 0, "s_a"));
    m.set("primera", 9, stamp(12, 0, "s_a")); // reescribir NO la mueve
    expect(m.keysInOrder()).toEqual(["id", "primera", "segunda"]);
    expect(m.toObject()).toEqual({ id: "x", primera: 9, segunda: 2 });
  });

  it("una clave `__proto__` del snapshot se emite como propiedad PROPIA", () => {
    const base = JSON.parse('{"__proto__": 1, "z": 2}') as Record<string, unknown>;
    const m = new LwwMap(base, Object.keys(base));
    const out = m.toObject();
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":1,"z":2}');
  });
});

describe("TextField", () => {
  it("un campo intacto emite su HTML ORIGINAL verbatim", () => {
    const f = TextField.open("n", "content", "<p>a  <b>b</b></p>")!;
    expect(f).not.toBeNull();
    expect(f.isDirty).toBe(false);
    expect(f.serialize()).toBe("<p>a  <b>b</b></p>");
  });

  it("tras la primera op emite la forma CANÓNICA del serializador", () => {
    const f = TextField.open("n", "content", "<p>ab</p>")!;
    const { left, right } = f.neighborsForIndex(1);
    f.insert({ site: "s_a", counter: 1 }, left, right, { br: false, ch: "X", marks: { bold: false, italic: false, link: null } }, stamp(1, 0, "s_a"));
    expect(f.isDirty).toBe(true);
    expect(f.serialize()).toBe("<p>aXb</p>");
  });

  it("las marcas son LWW por átomo y respetan el orden canónico al serializar", () => {
    const f = TextField.open("n", "content", "<p>ab</p>")!;
    const pos = f.livePositions()[0];
    f.setMark(pos, "bold", true, stamp(5, 0, "s_a"));
    expect(f.serialize()).toBe("<p><strong>a</strong>b</p>");
    f.setMark(pos, "bold", false, stamp(4, 0, "s_b")); // sello menor: pierde
    expect(f.serialize()).toBe("<p><strong>a</strong>b</p>");
    f.setMark(pos, "bold", false, stamp(9, 0, "s_b"));
    expect(f.serialize()).toBe("<p>ab</p>");
  });

  it("un `href` de marca llega saneado en su forma (el saneo de URL es del ingest)", () => {
    const f = TextField.open("n", "content", "<p>a</p>")!;
    const pos = f.livePositions()[0];
    f.setMark(pos, "link", { href: "/ok", newTab: true } as never, stamp(1, 0, "s_a"));
    expect(f.serialize()).toBe('<p><a href="/ok" target="_blank" rel="noopener noreferrer">a</a></p>');
  });

  it("un campo que NO es un solo párrafo no se abre (límite declarado de v1)", () => {
    expect(TextField.open("n", "content", "<ul><li><p>a</p></li></ul>")).toBeNull();
    expect(TextField.open("n", "content", "<p>a</p><p>b</p>")).toBeNull();
    expect(TextField.open("n", "content", 42)).toBeNull();
  });

  it("borrar todos los átomos deja el campo vacío, no el HTML viejo", () => {
    const f = TextField.open("n", "content", "<p>ab</p>")!;
    for (const pos of [...f.livePositions()]) f.remove(pos, stamp(3, 0, "s_a"));
    expect(f.serialize()).toBe("");
  });
});
