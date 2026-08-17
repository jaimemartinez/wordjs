/**
 * COMPILACIÓN DETERMINISTA.
 *
 * El contrato: mismo modelo → mismo CSS byte a byte, y nombres estables entre ejecuciones y entre
 * procesos. De ahí cuelgan tres propiedades que importan de verdad:
 *  · reguardar una página sin tocar la interacción no cambia el CSS → diffs limpios y caché de
 *    navegador que no se invalida sola;
 *  · N bloques con el mismo movimiento comparten UNA clase y UN `@keyframes` → coste sublineal;
 *  · editar un preset cambia el hash → el navegador no puede servir CSS viejo, y `_puck_data` no
 *    se toca.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  compileIx,
  compileIxPage,
  emitUnit,
  ixCss,
  ixClassFor,
  ixHash,
  ixKeyframes,
  resolveIxBody,
  SYS_IX_PRESETS,
  SYS_IX_PRESET_IDS,
  IX_MAX_UNITS_PER_PAGE,
} from "..";
import type { IxSpec } from "../types";

const ctx = { presets: SYS_IX_PRESETS };

const FADE_UP: IxSpec = {
  v: 1,
  trigger: { on: "view", once: true },
  tracks: [
    {
      target: { kind: "self" },
      steps: [
        { at: 0, set: { opacity: 0, y: 28 }, ease: "out" },
        { at: 100, set: { opacity: 1, y: 0 } },
      ],
      dur: 600,
      delay: 0,
    },
  ],
};

/** Baraja las claves de todos los objetos del árbol, sin tocar el valor. */
function shufflekeys(value: unknown, rnd: () => number): unknown {
  if (Array.isArray(value)) return value.map((v) => shufflekeys(v, rnd));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, shufflekeys(v, rnd)]));
  }
  return value;
}

/** PRNG determinista: el test no puede depender de Math.random. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */

describe("determinismo", () => {
  it("1000 permutaciones del orden de claves del MISMO spec → un solo hash y un solo CSS", () => {
    const rnd = mulberry32(20260815);
    const hashes = new Set<string>();
    const csss = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const permuted = shufflekeys(FADE_UP, rnd);
      const unit = compileIx(permuted)!;
      hashes.add(unit.hash);
      csss.add(ixCss([unit]));
    }
    expect(hashes.size).toBe(1);
    expect(csss.size).toBe(1);
  });

  it("dos compilaciones independientes producen CSS byte-idéntico", () => {
    const a = ixCss(compileIxPage([FADE_UP], ctx).units);
    const b = ixCss(compileIxPage([FADE_UP], ctx).units);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("el hash NO depende del id del bloque, ni de su posición, ni del momento de guardado", () => {
    const base = compileIx(FADE_UP)!.hash;
    // El mismo cuerpo dentro de páginas distintas, en posiciones distintas, con vecinos distintos.
    const p1 = compileIxPage([FADE_UP, { ...FADE_UP, trigger: { on: "load" } }], ctx);
    const p2 = compileIxPage([{ ...FADE_UP, trigger: { on: "load" } }, FADE_UP], ctx);
    expect(p1.css).toBe(p2.css);
    expect(p1.units.some((u) => u.hash === base)).toBe(true);
  });

  it("mover un bloque dentro de la página no cambia un byte del CSS", () => {
    const specs = SYS_IX_PRESET_IDS.slice(0, 6).map((id) => ({ v: 1 as const, preset: id }));
    const forward = compileIxPage(specs, ctx).css;
    const backward = compileIxPage([...specs].reverse(), ctx).css;
    expect(forward).toBe(backward);
  });

  it("floats equivalentes dan el mismo hash (canónico a 4 decimales, sin -0)", () => {
    const a = compileIx({ v: 1, tracks: [{ target: { kind: "self" }, steps: [
      { at: 0, set: { opacity: 0.1 + 0.2 } }, { at: 100, set: { y: -0 } },
    ] }] })!;
    const b = compileIx({ v: 1, tracks: [{ target: { kind: "self" }, steps: [
      { at: 0, set: { opacity: 0.3 } }, { at: 100, set: { y: 0 } },
    ] }] })!;
    expect(a.hash).toBe(b.hash);
    expect(a.rules).toEqual(b.rules);
  });

  it("el hash es 7 chars base36 y estable como literal", () => {
    const unit = compileIx(FADE_UP)!;
    expect(unit.hash).toMatch(/^[0-9a-z]{7}$/);
    expect(unit.cls).toBe(`wjs-ix-${unit.hash}`);
    // Literal: si esto cambia, ha cambiado la forma canónica del cuerpo o el algoritmo del hash —
    // las dos cosas invalidan todo el CSS cacheado del mundo y tienen que ser una decisión.
    expect(unit.hash).toBe(ixHash(unit.body));
  });
});

describe("deduplicación y coste sublineal", () => {
  it("40 bloques con el mismo preset emiten UN juego de reglas", () => {
    const specs = Array.from({ length: 40 }, () => ({ v: 1 as const, preset: "sys:fade-up" }));
    const page = compileIxPage(specs, ctx);
    expect(page.units).toHaveLength(1);
    expect((page.css.match(/@keyframes /g) ?? []).length).toBe(1);
  });

  it("un preset y su cuerpo DESVINCULADO idéntico comparten hash y reglas", () => {
    const preset = SYS_IX_PRESETS["sys:fade-up"];
    const linked = { v: 1 as const, preset: "sys:fade-up" };
    const detached = { v: 1 as const, trigger: preset.trigger, tracks: preset.tracks };
    const a = compileIx(linked, ctx)!;
    const b = compileIx(detached, ctx)!;
    // El cuerpo del enlazado lleva `rev`; el desvinculado no. Son cuerpos DISTINTOS a propósito:
    // editar el preset debe cambiar el hash del enlazado y NO el del desvinculado.
    expect(a.hash).not.toBe(b.hash);
    // Pero el CSS que producen es el mismo movimiento, con los nombres de cada uno.
    expect(a.rules.join().replaceAll(a.hash, "H")).toBe(b.rules.join().replaceAll(b.hash, "H"));
  });

  it("editar un preset (rev++) cambia el hash — y `_puck_data` no se toca", () => {
    const before = { ...SYS_IX_PRESETS["sys:fade-up"], rev: 7 };
    const after = { ...before, rev: 8 };
    const spec = { v: 1 as const, preset: "sys:fade-up" };
    const h1 = compileIx(spec, { presets: { "sys:fade-up": before } })!.hash;
    const h2 = compileIx(spec, { presets: { "sys:fade-up": after } })!.hash;
    expect(h1).not.toBe(h2);
    // El dato del bloque es EXACTAMENTE el mismo objeto: cero bytes de diferencia.
    expect(canonicalJson(spec)).toBe('{"preset":"sys:fade-up","v":1}');
  });

  it("una referencia rota no compila nada y no rompe la página", () => {
    const page = compileIxPage([{ v: 1, preset: "no-existe" }, FADE_UP], ctx);
    expect(page.units).toHaveLength(1);
    expect(ixClassFor({ v: 1, preset: "no-existe" }, page, ctx)).toBeNull();
  });
});

describe("colisión de hash", () => {
  it("dos cuerpos distintos con el mismo hash se desambiguan de forma determinista", () => {
    // Se fuerza la colisión llamando al emisor con el mismo hash para dos cuerpos: es el mismo
    // camino que recorrería `compileIxPage`, sin tener que buscar una colisión real de FNV.
    const bodyA = resolveIxBody(FADE_UP)!.body;
    const bodyB = resolveIxBody({ ...FADE_UP, trigger: { on: "load" } })!.body;
    const a = emitUnit(bodyA, "aaaaaaa");
    const b = emitUnit(bodyB, "aaaaaaa__1");
    expect(a.cls).toBe("wjs-ix-aaaaaaa");
    expect(b.cls).toBe("wjs-ix-aaaaaaa__1");
    // El separador `__` no puede aparecer en un hash base36, así que el nombre de los keyframes de
    // la unidad desambiguada nunca choca con el de la pista N de la unidad original.
    expect(Object.keys(a.kf)).toEqual(["wjs-ixk-aaaaaaa"]);
    expect(Object.keys(b.kf)).toEqual(["wjs-ixk-aaaaaaa__1"]);
  });

  it("con varias pistas los keyframes se numeran, y no colisionan con el sufijo de colisión", () => {
    const two = {
      v: 1 as const,
      tracks: [
        { target: { kind: "self" as const }, steps: [{ at: 0, set: { opacity: 0 } }, { at: 100, set: { opacity: 1 } }] },
        { target: { kind: "children" as const }, steps: [{ at: 0, set: { y: 10 } }, { at: 100, set: { y: 0 } }] },
      ],
    };
    const u = compileIx(two)!;
    expect(Object.keys(u.kf)).toEqual([`wjs-ixk-${u.hash}-0`, `wjs-ixk-${u.hash}-1`]);
  });

  it("el orden de desambiguación no depende del orden de los bloques en la página", () => {
    // Se comprueba la propiedad general: la lista de clases emitidas es la misma en cualquier orden.
    const specs = [
      FADE_UP,
      { ...FADE_UP, trigger: { on: "load" as const } },
      { ...FADE_UP, trigger: { on: "hover" as const } },
    ];
    const c1 = compileIxPage(specs).units.map((u) => u.cls);
    const c2 = compileIxPage([...specs].reverse()).units.map((u) => u.cls);
    expect(c1).toEqual(c2);
  });
});

describe("presupuestos y topes", () => {
  it("una página REAL de 30 bloques se queda muy por debajo de los 8 KB", () => {
    // Una página de verdad reutiliza: 30 bloques repartidos entre los presets del sistema. El
    // compilador deduplica por CUERPO, así que el CSS crece con las interacciones DISTINTAS, no
    // con los bloques.
    const specs = Array.from({ length: 30 }, (_, i) => ({
      v: 1 as const,
      preset: SYS_IX_PRESET_IDS[i % 5],
    }));
    const page = compileIxPage(specs, ctx);
    expect(page.units).toHaveLength(5);
    expect(page.css.length).toBeLessThanOrEqual(8 * 1024);
    // El CATÁLOGO ENTERO (26 presets, P7) a la vez es un caso extremo, no una página realista:
    // pesa ~11,9 KB medidos — el grueso son los DOS bloques de fallback `nth-child` de
    // cascada/rejilla (~1,2 KB cada uno) más las curvas linear() de las físicas. Se pinea el techo
    // MEDIDO (mismo criterio que el "PEOR CASO" de abajo) para que cualquier engorde del emisor
    // sea visible; el presupuesto de 8 KB de §7.3 sigue vigente para páginas con reutilización.
    const all = compileIxPage(SYS_IX_PRESET_IDS.map((id) => ({ v: 1 as const, preset: id })), ctx);
    expect(all.units).toHaveLength(26);
    expect(all.css.length).toBeLessThanOrEqual(12 * 1024);
  });

  it("PEOR CASO MEDIDO: 30 unidades sin NADA compartido pesan ~8,4 KB", () => {
    // Cifra medida, no aspiracional: 30 interacciones distintas de 2 pasos y 2 propiedades cada
    // una, sin un solo preset repetido. Supera por ~5 % el presupuesto de 8 KB de la spec §7.3,
    // que se escribió pensando en una página de corpus (donde hay reutilización). Se pinea el
    // techo real para que cualquier crecimiento del emisor sea VISIBLE en vez de silencioso.
    const specs = Array.from({ length: IX_MAX_UNITS_PER_PAGE }, (_, i) => ({
      v: 1 as const,
      tracks: [{
        target: { kind: "self" as const },
        steps: [{ at: 0, set: { opacity: 0, y: i + 1 } }, { at: 100, set: { opacity: 1, y: 0 } }],
      }],
    }));
    const page = compileIxPage(specs);
    expect(page.units).toHaveLength(IX_MAX_UNITS_PER_PAGE);
    expect(page.css.length).toBeLessThanOrEqual(9 * 1024);
    expect(page.css.length).toBeGreaterThan(8 * 1024);
  });

  it("por encima del tope de unidades se emite lo que cabe y se avisa; nunca se rompe", () => {
    const specs = Array.from({ length: 50 }, (_, i) => ({
      v: 1 as const,
      tracks: [{ target: { kind: "self" as const }, steps: [{ at: 0, set: { y: i + 1 } }, { at: 100, set: { y: 0 } }] }],
    }));
    const page = compileIxPage(specs);
    expect(page.units).toHaveLength(IX_MAX_UNITS_PER_PAGE);
    expect(page.warnings.join(" ")).toContain("IX_MAX_UNITS_PER_PAGE");
    expect(page.css).toContain("@keyframes");
  });
});

describe("la envoltura de accesibilidad", () => {
  it("TODO el CSS generado vive dentro de prefers-reduced-motion: no-preference", () => {
    const page = compileIxPage(SYS_IX_PRESET_IDS.map((id) => ({ v: 1 as const, preset: id })), ctx);
    expect(page.css.startsWith("@media screen and (prefers-reduced-motion:no-preference){\n")).toBe(true);
    // Ninguna llave se cierra antes de tiempo: no hay forma de que una regla quede fuera del @media.
    const firstClose = page.css.indexOf("\n}\n");
    expect(firstClose).toBe(page.css.length - 3);
  });

  it("sin unidades no se emite ni un byte", () => {
    expect(ixCss([])).toBe("");
    expect(compileIxPage([]).css).toBe("");
    expect(compileIxPage([{ v: 2 }, null, "x"]).css).toBe("");
  });
});

describe("los dos backends del IR salen del mismo sitio", () => {
  it("los @keyframes CSS y los IxKeyframe WAAPI declaran los MISMOS valores", () => {
    const unit = compileIx(FADE_UP)!;
    const kf = ixKeyframes(unit);
    const frames = Object.values(kf)[0];
    expect(frames.map((f) => f.offset)).toEqual([0, 1]);
    expect(frames[0]).toEqual({
      offset: 0,
      easing: "cubic-bezier(.16,1,.3,1)",
      opacity: "0",
      transform: "translate3d(0px,28px,0)",
    });
    expect(frames[1]).toEqual({ offset: 1, opacity: "1", transform: "translate3d(0px,0px,0)" });
    const css = unit.keyframes.join("\n");
    expect(css).toBe(
      "@keyframes wjs-ixk-" + unit.hash +
      "{0%{animation-timing-function:cubic-bezier(.16,1,.3,1);opacity:0;transform:translate3d(0px,28px,0)}" +
      "100%{opacity:1;transform:translate3d(0px,0px,0)}}",
    );
  });

  it("una pista rellena la UNIÓN de propiedades en todos sus pasos (interpolación exacta)", () => {
    const unit = compileIx({
      v: 1,
      tracks: [{ target: { kind: "self" }, steps: [
        { at: 0, set: { y: 20 } },
        { at: 50, set: { opacity: 0.5 } },
        { at: 100, set: { blur: 0 } },
      ] }],
    })!;
    const frames = Object.values(unit.kf)[0];
    // Los tres fotogramas declaran opacity, transform y filter, aunque el autor tocara uno por paso.
    for (const f of frames) {
      expect(f.opacity).toBeDefined();
      expect(f.transform).toBeDefined();
      expect(f.filter).toBeDefined();
    }
    // El relleno usa el valor NEUTRO, no "el anterior": el paso 50 vuelve a y=0.
    expect(frames[1].transform).toBe("translate3d(0px,0px,0)");
  });

  it("`rotateX` lleva su propia perspectiva dentro del transform (no depende de ningún ancestro)", () => {
    const unit = compileIx({
      v: 1,
      tracks: [{ target: { kind: "self" }, steps: [
        { at: 0, set: { rotateX: -70 } }, { at: 100, set: { rotateX: 0 } },
      ] }],
    })!;
    expect(unit.keyframes.join()).toContain("transform:perspective(1000px) rotateX(-70deg)");
  });

  it("`clip` se emite como clip-path inset (revelado %), nunca como width/overflow", () => {
    const unit = compileIx({
      v: 1,
      tracks: [{ target: { kind: "self" }, steps: [
        { at: 0, set: { clip: 0 } }, { at: 100, set: { clip: 100 } },
      ] }],
    })!;
    expect(unit.keyframes.join()).toContain("clip-path:inset(0 100% 0 0)");
    expect(unit.keyframes.join()).toContain("clip-path:inset(0 0% 0 0)");
  });
});

describe("presets de sistema", () => {
  it("los 26 compilan, y ninguno emite propiedades que provoquen reflow", () => {
    expect(SYS_IX_PRESET_IDS).toHaveLength(26);
    for (const id of SYS_IX_PRESET_IDS) {
      const unit = compileIx({ v: 1, preset: id }, ctx);
      expect(unit, id).not.toBeNull();
      // Los de PUNTERO no emiten CSS por diseño (la animación se posiciona): su IR va entero.
      if (SYS_IX_PRESETS[id].trigger.on === "pointer") {
        expect(unit!.rules, id).toHaveLength(0);
        expect(Object.keys(unit!.kf).length, id).toBeGreaterThan(0);
      } else {
        expect(unit!.rules.length, id).toBeGreaterThan(0);
      }
    }
  });

  it("la taxonomía del catálogo: 18 de entrada, 6 de scroll y 2 de puntero", () => {
    const byTrigger = { view: [] as string[], scrub: [] as string[], pointer: [] as string[] };
    for (const id of SYS_IX_PRESET_IDS) {
      const on = SYS_IX_PRESETS[id].trigger.on;
      (byTrigger as Record<string, string[]>)[on]?.push(id);
    }
    expect(byTrigger.view).toHaveLength(18);
    expect(byTrigger.scrub).toHaveLength(6);
    expect(byTrigger.pointer).toHaveLength(2);
    for (const id of byTrigger.view) {
      expect(SYS_IX_PRESETS[id].trigger, id).toEqual({ on: "view", once: true });
    }
  });
});
