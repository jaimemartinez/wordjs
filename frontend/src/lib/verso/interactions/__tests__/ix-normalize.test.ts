/**
 * VALIDADOR CONTRA ENTRADAS HOSTILES.
 *
 * `_puck_data` puede llegar por la API o por una importación WXR, así que un `ix` puede traer
 * cualquier cosa. La invariante que se prueba aquí es una sola y es estructural:
 *
 *   NINGUNA cadena del autor llega jamás al CSS. Y por tanto NINGÚN CSS emitido puede escaparse
 *   de su regla.
 *
 * No se prueba "que el escapado funcione" — es que no hay escapado, porque no hay interpolación de
 * cadenas: todo valor es un número clampado que el emisor formatea, o un token de una lista
 * cerrada. El fuzz de abajo lo verifica sobre el CSS realmente emitido.
 */
import { describe, expect, it } from "vitest";
import {
  IX_DELAY_MAX,
  IX_DUR_MAX,
  IX_DUR_MIN,
  IX_MAX_STEPS,
  IX_MAX_TRACKS,
  IX_PROP_KEYS,
  IX_REPEAT_MAX,
  IX_STAGGER_MAX,
  normalizeIxPreset,
  normalizeIxSpec,
  normProps,
} from "../normalize";
import { compileIx, compileIxPage, ixCss } from "../compile";

const track = (over: Record<string, unknown> = {}) => ({
  target: { kind: "self" },
  steps: [
    { at: 0, set: { opacity: 0 } },
    { at: 100, set: { opacity: 1 } },
  ],
  ...over,
});

const spec = (over: Record<string, unknown> = {}) => ({ v: 1, tracks: [track()], ...over });

/* ------------------------------------------------------------------ */

describe("la puerta de entrada", () => {
  it("cualquier cosa que no sea un objeto con v===1 se ignora entera", () => {
    for (const bad of [
      undefined, null, 0, 1, "", "x", true, [], [{ v: 1 }], () => {},
      { v: 0 }, { v: 2 }, { v: "1" }, { v: 1.0000001 }, {},
      Object.create(null),
    ]) {
      expect(normalizeIxSpec(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("un `v` desconocido NO se adivina: se ignora (fail-open hacia adelante)", () => {
    expect(normalizeIxSpec({ v: 2, tracks: [track()] })).toBeNull();
  });

  it("sin pistas utilizables y sin preset → null (el bloque queda visible y quieto)", () => {
    expect(normalizeIxSpec({ v: 1 })).toBeNull();
    expect(normalizeIxSpec({ v: 1, tracks: [] })).toBeNull();
    expect(normalizeIxSpec({ v: 1, tracks: "muchas" })).toBeNull();
    expect(normalizeIxSpec({ v: 1, tracks: [{ target: { kind: "self" }, steps: [{ at: 0, set: {} }] }] })).toBeNull();
  });
});

describe("propiedades: la lista es CERRADA", () => {
  it("todo lo que provoca reflow es INEXPRESABLE — se descarta en silencio", () => {
    const hostile = {
      width: 100, height: 100, top: 10, left: 10, right: 0, bottom: 0,
      margin: 20, marginTop: 20, padding: 8, fontSize: 40, lineHeight: 2,
      display: "none", position: "fixed", zIndex: 9999, content: "'x'",
      backgroundImage: "url(javascript:alert(1))", behavior: "url(#x)",
      __proto__: { opacity: 0.5 },
      // y las buenas, para comprobar que sí pasan
      opacity: 0.5, x: 10,
    };
    const out = normProps(hostile);
    expect(Object.keys(out).sort()).toEqual(["opacity", "x"]);
  });

  it("solo acepta NÚMEROS: una cadena, aunque parezca un número, se descarta", () => {
    for (const bad of ["1", "1px", "0.5", "1e3", true, null, {}, [], NaN, Infinity, -Infinity]) {
      expect(normProps({ opacity: bad }), JSON.stringify(bad)).toEqual({});
    }
    expect(normProps({ opacity: 0.5 })).toEqual({ opacity: 0.5 });
  });

  it("clampa números absurdos en vez de propagarlos al compositor", () => {
    const out = normProps({
      opacity: 999, x: 1e9, y: -1e9, scale: 1e12, rotate: 1e6, rotateX: -1e6,
      blur: 1e9, clip: 1e9,
    });
    expect(out).toEqual({
      opacity: 1, x: 4000, y: -4000, scale: 10, rotate: 3600, rotateX: -3600,
      blur: 100, clip: 100,
    });
    const neg = normProps({ opacity: -5, scale: -5, blur: -5, clip: -5 });
    expect(neg).toEqual({ opacity: 0, scale: 0, blur: 0, clip: 0 });
  });

  it("cubre las propiedades declaradas y ninguna más — las 8 originales SIEMPRE primero", () => {
    // El prefijo es sagrado: el orden canónico decide bytes de emisión, y las 8 primeras en su
    // orden de siempre garantizan que un documento anterior a P3 emite CSS byte-idéntico.
    expect([...IX_PROP_KEYS].slice(0, 8)).toEqual([
      "opacity", "x", "y", "scale", "rotate", "rotateX", "blur", "clip",
    ]);
    expect([...IX_PROP_KEYS]).toEqual([
      "opacity", "x", "y", "scale", "rotate", "rotateX", "blur", "clip",
      "z", "scaleX", "scaleY", "rotateY", "skewX", "skewY",
      "brightness", "contrast", "saturate", "grayscale", "hue",
      "textColor", "bgColor", "borderColor",
      "draw",
    ]);
  });
});

describe("clamps temporales — los mismos que AnimSpec", () => {
  it("duración y retardo se clampan a 100–3000 / 0–3000", () => {
    const r = normalizeIxSpec(spec({ tracks: [track({ dur: 9_999_999, delay: -50 })] }))!;
    expect(r.spec.tracks![0].dur).toBe(IX_DUR_MAX);
    expect(r.spec.tracks![0].delay).toBe(0);

    const r2 = normalizeIxSpec(spec({ tracks: [track({ dur: 1, delay: 86_400_000 })] }))!;
    expect(r2.spec.tracks![0].dur).toBe(IX_DUR_MIN);
    expect(r2.spec.tracks![0].delay).toBe(IX_DELAY_MAX);
  });

  it("`repeat` finito se clampa y se redondea; `inf` es el único token", () => {
    expect(normalizeIxSpec(spec({ tracks: [track({ repeat: 1e6 })] }))!.spec.tracks![0].repeat).toBe(IX_REPEAT_MAX);
    expect(normalizeIxSpec(spec({ tracks: [track({ repeat: 2.7 })] }))!.spec.tracks![0].repeat).toBe(3);
    expect(normalizeIxSpec(spec({ tracks: [track({ repeat: "inf" })] }))!.spec.tracks![0].repeat).toBe("inf");
    expect(normalizeIxSpec(spec({ tracks: [track({ repeat: "infinite" })] }))!.spec.tracks![0].repeat).toBeUndefined();
  });

  it("el escalonado se clampa y su origen viene de una lista cerrada", () => {
    const r = normalizeIxSpec(spec({ tracks: [track({ stagger: { each: 1e9, from: "arriba" } })] }))!;
    expect(r.spec.tracks![0].stagger).toEqual({ each: IX_STAGGER_MAX });
    const r2 = normalizeIxSpec(spec({ tracks: [track({ stagger: { each: 60, from: "center" } })] }))!;
    expect(r2.spec.tracks![0].stagger).toEqual({ each: 60, from: "center" });
  });

  it("el retardo del disparador `load` también se clampa", () => {
    const r = normalizeIxSpec(spec({ trigger: { on: "load", delay: 999_999 } }))!;
    expect(r.spec.trigger).toEqual({ on: "load", delay: IX_DELAY_MAX });
  });
});

describe("pasos: forma garantizada para el emisor", () => {
  it("se ordenan, se deduplican y los extremos se anclan a 0 y 100", () => {
    const r = normalizeIxSpec({
      v: 1,
      tracks: [{
        target: { kind: "self" },
        steps: [
          { at: 70, set: { opacity: 0.7 } },
          { at: 3, set: { opacity: 0.1 } },
          { at: 70, set: { opacity: 0.9 } }, // duplicado: gana el primero
          { at: 96, set: { opacity: 1 } },
        ],
      }],
    })!;
    const steps = r.spec.tracks![0].steps;
    expect(steps.map((s) => s.at)).toEqual([0, 70, 100]);
    expect(steps[0].set.opacity).toBe(0.1);
    expect(steps[1].set.opacity).toBe(0.7);
  });

  it("por encima del tope se conservan los primeros N−1 Y EL ÚLTIMO (el final no se pierde)", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ at: i * 9, set: { opacity: i / 11 } }));
    const r = normalizeIxSpec({ v: 1, tracks: [{ target: { kind: "self" }, steps: many }] })!;
    const steps = r.spec.tracks![0].steps;
    expect(steps).toHaveLength(IX_MAX_STEPS);
    expect(steps[0].at).toBe(0);
    expect(steps[steps.length - 1].at).toBe(100);
    expect(r.warnings.join(" ")).toContain("IX_MAX_STEPS");
  });

  it("una pista que no toca NINGUNA propiedad se descarta (no emite CSS inerte)", () => {
    // Es el caso al que llega un `set` lleno de propiedades no permitidas: tras el filtro queda {}.
    expect(normalizeIxSpec({ v: 1, tracks: [{ target: { kind: "self" }, steps: [
      { at: 0, set: { width: 100, display: "none" } },
      { at: 100, set: { height: 50 } },
    ] }] })).toBeNull();
    expect(compileIx({ v: 1, tracks: [{ target: { kind: "self" }, steps: [
      { at: 0, set: {} }, { at: 100, set: {} },
    ] }] })).toBeNull();
  });

  it("una pista con menos de 2 pasos se descarta entera", () => {
    expect(normalizeIxSpec({ v: 1, tracks: [{ target: { kind: "self" }, steps: [{ at: 50, set: { opacity: 1 } }] }] })).toBeNull();
  });

  it("por encima del tope de pistas se emiten las primeras y se avisa", () => {
    const r = normalizeIxSpec({ v: 1, tracks: Array.from({ length: 9 }, () => track()) })!;
    expect(r.spec.tracks).toHaveLength(IX_MAX_TRACKS);
    expect(r.warnings.join(" ")).toContain("IX_MAX_TRACKS");
  });

  it("un easing desconocido se descarta; no se propaga como cadena", () => {
    const r = normalizeIxSpec({
      v: 1,
      tracks: [{ target: { kind: "self" }, steps: [
        { at: 0, set: { opacity: 0 }, ease: "cubic-bezier(0,0,0,0);} body{display:none" },
        { at: 100, set: { opacity: 1 }, ease: "spring" },
      ] }],
    })!;
    expect(r.spec.tracks![0].steps[0].ease).toBeUndefined();
    expect(r.spec.tracks![0].steps[1].ease).toBe("spring");
  });
});

describe("objetivos y disparadores", () => {
  it("un `kind` desconocido descarta la pista", () => {
    expect(normalizeIxSpec({ v: 1, tracks: [track({ target: { kind: "document" } })] })).toBeNull();
    expect(normalizeIxSpec({ v: 1, tracks: [track({ target: "self" })] })).toBeNull();
  });

  it("el id de un objetivo externo se acota al alfabeto seguro de un selector", () => {
    for (const bad of ['a"] , * {color:red}', "a b", "a'b", "", "x".repeat(65), 7, null]) {
      expect(normalizeIxSpec({ v: 1, tracks: [track({ target: { kind: "block", id: bad } })] }), String(bad)).toBeNull();
    }
    const ok = normalizeIxSpec({ v: 1, tracks: [track({ target: { kind: "block", id: "Abc-1_2" } })] })!;
    expect(ok.spec.tracks![0].target).toEqual({ kind: "block", id: "Abc-1_2" });
  });

  it("un disparador desconocido se descarta y el compilador aplica el suyo por defecto", () => {
    const r = normalizeIxSpec(spec({ trigger: { on: "mousemove" } }))!;
    expect(r.spec.trigger).toBeUndefined();
    expect(compileIx(spec({ trigger: { on: "mousemove" } }))!.body.trigger).toEqual({ on: "view", once: true });
  });

  it("los bordes de `animation-range` salen de una lista cerrada y el % se clampa", () => {
    const r = normalizeIxSpec(spec({
      trigger: { on: "scrub", range: { from: { at: "cover", pct: -500 }, to: { at: "exit", pct: 5000 } } },
    }))!;
    expect(r.spec.trigger).toEqual({
      on: "scrub",
      range: { from: { at: "cover", pct: 0 }, to: { at: "exit", pct: 100 } },
    });
    // Un borde inventado invalida el rango entero (no se mezcla con uno por defecto a medias).
    expect(normalizeIxSpec(spec({
      trigger: { on: "scrub", range: { from: { at: "nowhere", pct: 0 }, to: { at: "cover", pct: 100 } } },
    }))!.spec.trigger).toEqual({ on: "scrub" });
  });
});

describe("presets", () => {
  it("un id que no es slug se descarta (y `tracks` sigue su curso normal)", () => {
    const r = normalizeIxSpec(spec({ preset: "../../etc/passwd" }))!;
    expect(r.spec.preset).toBeUndefined();
    expect(r.spec.tracks).toHaveLength(1);
    expect(r.warnings.join(" ")).toContain("preset");
  });

  it("preset y tracks NUNCA coexisten: gana el preset y se avisa", () => {
    const r = normalizeIxSpec(spec({ preset: "sys:fade" }))!;
    expect(r.spec.preset).toBe("sys:fade");
    expect(r.spec.tracks).toBeUndefined();
    expect(r.warnings.join(" ")).toContain("`tracks`");
  });

  it("un preset de ajustes sin pistas utilizables se descarta entero", () => {
    expect(normalizeIxPreset({ id: "x", tracks: [] })).toBeNull();
    expect(normalizeIxPreset({ id: "MAYÚSCULAS", tracks: [track()] })).toBeNull();
    const p = normalizeIxPreset({ id: "aparecer-tarjetas", tracks: [track()], rev: 7.6 })!;
    expect(p.rev).toBe(8);
    expect(p.name).toBe("aparecer-tarjetas");
    expect(p.trigger).toEqual({ on: "view", once: true });
  });
});

/* ------------------------------------------------------------------ */
/* La invariante, sobre el CSS realmente emitido                       */
/* ------------------------------------------------------------------ */

/** Cargas que en un motor con interpolación de cadenas romperían la regla o inyectarían CSS. */
const PAYLOADS: unknown[] = [
  "1px} body{display:none",
  "}",
  "{",
  "*/",
  "/*",
  "expression(alert(1))",
  "url(javascript:alert(1))",
  "url('data:text/html,<script>')",
  "red;position:fixed;top:0",
  "\\3c script\\3e",
  "@import url(//evil)",
  "()",
  ";",
  "\n}\n.x{color:red",
  "attr(href)",
  "var(--x); background:url(//evil)",
  1e308,
  -1e308,
  Number.MAX_SAFE_INTEGER,
  NaN,
  Infinity,
];

describe("fuzz: jamás se emite CSS que escape de su regla", () => {
  const balanced = (css: string) => {
    let depth = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  };

  it("con las cargas en TODOS los huecos del modelo, el CSS sigue balanceado y limpio", () => {
    const specs: unknown[] = [];
    for (const p of PAYLOADS) {
      for (const key of [...IX_PROP_KEYS, "width", "height", "top", "margin"]) {
        specs.push({
          v: 1,
          trigger: { on: "load", delay: p },
          tracks: [{
            target: { kind: "self" },
            steps: [{ at: p, set: { [key]: p }, ease: p }, { at: 100, set: { [key]: p } }],
            dur: p,
            delay: p,
            repeat: p,
            stagger: { each: p, from: p },
          }],
        });
        specs.push({ v: 1, preset: p, trigger: { on: p } });
        specs.push({
          v: 1,
          tracks: [{
            target: { kind: "block", id: p },
            steps: [{ at: 0, set: { opacity: 0 } }, { at: 100, set: { opacity: 1 } }],
          }],
        });
        specs.push({
          v: 1,
          trigger: { on: "scrub", range: { from: { at: p, pct: p }, to: { at: "cover", pct: p } } },
          tracks: [{ target: { kind: "children" }, steps: [{ at: 0, set: { y: p } }, { at: 100, set: { y: 0 } }], stagger: { each: p } }],
        });
      }
    }
    expect(specs.length).toBeGreaterThan(800);

    const page = compileIxPage(specs);
    const css = page.css;
    expect(balanced(css)).toBe(true);

    // Ninguna carga aparece en el CSS, ni entera ni como fragmento reconocible.
    for (const bad of ["display:none", "display: none", "expression(", "javascript:", "@import", "position:fixed", "<script", "attr(", "url("]) {
      expect(css.toLowerCase(), bad).not.toContain(bad);
    }
    // Ni una sola propiedad fuera de las cuatro de compositor.
    for (const prop of ["width:", "height:", "top:", "left:", "margin", "padding", "font-size", "display:", "position:", "content:"]) {
      expect(css, prop).not.toContain(prop);
    }
  });

  it("las declaraciones emitidas son SOLO las del contrato: compositor + colores de pintado", () => {
    const page = compileIxPage([
      { v: 1, tracks: [{ target: { kind: "self" }, steps: [
        { at: 0, set: { opacity: 0, x: 1, y: 2, scale: 0.5, rotate: 3, rotateX: 4, blur: 5, clip: 0 } },
        { at: 100, set: { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, rotateX: 0, blur: 0, clip: 100 } },
      ] }] },
      // P3: la unión completa de las propiedades nuevas, con origin/clipDir/persp puestos.
      { v: 1, trigger: { on: "load" }, tracks: [{ target: { kind: "self" }, origin: "top-left", clipDir: "up", persp: 800, steps: [
        { at: 0, set: { z: -80, scaleX: 0.5, scaleY: 1.5, rotateY: 45, skewX: 10, skewY: -5, brightness: 2, contrast: 1.5, saturate: 0.2, grayscale: 80, hue: 90, textColor: 0xff0000, bgColor: 0x00ff00, borderColor: 0x0000ff, clip: 0 } },
        { at: 100, set: { z: 0, scaleX: 1, scaleY: 1, rotateY: 0, skewX: 0, skewY: 0, brightness: 1, contrast: 1, saturate: 1, grayscale: 0, hue: 0, clip: 100 } },
      ] }] },
      { v: 1, trigger: { on: "hover" }, tracks: [{ target: { kind: "self" }, steps: [
        { at: 0, set: { scale: 1 } }, { at: 100, set: { scale: 1.05 } },
      ] }] },
    ]);
    // Toda declaración del CSS emitido: un identificador seguido de `:` justo detrás de `{` o `;`
    // (lo que descarta los `:hover`/`:nth-child` de los selectores y la condición del `@supports`).
    const props = [...page.css.matchAll(/[{;]\s*([a-z-]+)\s*:/g)].map((m) => m[1]);
    const allowed = new Set([
      "opacity", "transform", "filter", "clip-path",
      // P3: pintado permitido por contrato (pintan, no recolocan) + el origin de lista cerrada.
      "color", "background-color", "border-color", "transform-origin",
      // P12: el trazo SVG es geometría del dash, no caja — cero reflow del layout HTML.
      "stroke-dashoffset",
      // Las de control de la propia animación (no pintan nada, no causan reflow).
      "animation", "animation-delay", "animation-timeline", "animation-range",
      "transition", "transition-delay",
    ]);
    expect(props.length).toBeGreaterThan(10);
    for (const p of props) expect(allowed.has(p), p).toBe(true);
  });

  it("un `ix` hostil no puede hacer que el compilador lance", () => {
    for (const bad of [
      { v: 1, tracks: [{ target: { kind: "self" }, steps: null }] },
      { v: 1, tracks: [null, undefined, 0, "x"] },
      { v: 1, tracks: [{ target: { kind: "self" }, steps: [{ at: 0 }, { at: 100 }] }] },
      { v: 1, trigger: null, tracks: [track()] },
    ]) {
      expect(() => compileIx(bad)).not.toThrow();
      expect(() => ixCss(compileIx(bad) ? [compileIx(bad)!] : [])).not.toThrow();
    }
  });
});
