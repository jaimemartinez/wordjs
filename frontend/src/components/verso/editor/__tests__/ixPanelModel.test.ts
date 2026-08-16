/**
 * Verso — modelo del panel de interacciones (F9-D).
 *
 * Aquí vive la prueba de las dos reglas del panel, porque son las dos que, si se rompen, rompen algo
 * que no se ve hasta producción:
 *
 *  · **Nada llega al documento sin normalizar.** Cada escritor devuelve un `IxSpec` que
 *    `normalizeIxSpec` acepta, o `undefined`. Se comprueba compilando la salida: si el panel pudiera
 *    escribir algo que el compilador rechaza, el bloque se guardaría "con interacción" y no se
 *    movería nunca.
 *  · **Un preajuste no se bifurca en silencio.** Un bloque enlazado guarda un ID y, como mucho, su
 *    propio disparador. Nunca `tracks` junto a `preset` — eso rompería la propagación, que es el
 *    motivo entero de que los presets se guarden por referencia.
 */
import { describe, expect, it } from "vitest";
import {
  compileIx,
  ixCtxFromSite,
  normalizeIxSpec,
  parseSiteIxPresets,
  IX_MAX_STEPS,
  SYS_IX_PRESETS,
  type IxCompileCtx,
} from "@/lib/verso/interactions";
import {
  addStep,
  availableProps,
  clearIx,
  defaultIxSpec,
  ixPanelState,
  ixPresetChoice,
  ixPresetOptions,
  removeStep,
  setDelay,
  setDuration,
  setPresetChoice,
  setStagger,
  setStepAt,
  setStepEase,
  setStepProp,
  setTargetKind,
  setTriggerKind,
  setViewOnce,
  unlinkPreset,
  usedProps,
  IX_PANEL_CUSTOM,
  IX_PANEL_NONE,
} from "../ixPanelModel";

const SITE = JSON.stringify([
  {
    id: "aparecer-tarjetas",
    name: "Aparecer tarjetas",
    trigger: { on: "view", once: true },
    tracks: [
      {
        target: { kind: "children" },
        steps: [
          { at: 0, set: { opacity: 0, y: 20 }, ease: "out" },
          { at: 100, set: { opacity: 1, y: 0 } },
        ],
        stagger: { each: 80 },
      },
    ],
    rev: 3,
  },
]);

const CTX: IxCompileCtx = ixCtxFromSite(parseSiteIxPresets(SITE));

/** Lo que el panel escribiría: normalizado y, si no es `undefined`, COMPILABLE. */
function assertWritable(value: unknown, ctx: IxCompileCtx = CTX): void {
  if (value === undefined) return;
  expect(normalizeIxSpec(value), "el panel escribió algo que el normalizador rechaza").not.toBeNull();
  expect(compileIx(value, ctx), "el panel escribió algo que el compilador no emite").not.toBeNull();
}

/* ------------------------------------------------------------------ */
/* Lectura                                                             */
/* ------------------------------------------------------------------ */

describe("ixPanelState — leer lo que el bloque tiene", () => {
  it("sin `ix`: inactivo y con un resumen que lo dice", () => {
    const s = ixPanelState(undefined, CTX);
    expect(s.active).toBe(false);
    expect(s.spec).toBeNull();
    expect(s.tracks).toEqual([]);
    expect(s.summary).toBe("Sin interacción.");
    expect(ixPresetChoice(s)).toBe(IX_PANEL_NONE);
  });

  it("enlazado a un preajuste: pistas y disparador salen del PRESET, no del bloque", () => {
    const s = ixPanelState({ v: 1, preset: "aparecer-tarjetas" }, CTX);
    expect(s.active).toBe(true);
    expect(s.presetId).toBe("aparecer-tarjetas");
    expect(s.presetOk).toBe(true);
    expect(s.custom).toBe(false);
    expect(s.tracks[0].target.kind).toBe("children");
    expect(s.tracks[0].stagger?.each).toBe(80);
    expect(ixPresetChoice(s)).toBe("aparecer-tarjetas");
    expect(s.summary).toContain("Aparecer tarjetas");
  });

  it("referencia ROTA: no está activo, pero el panel lo dice en un aviso (no en silencio)", () => {
    const s = ixPanelState({ v: 1, preset: "borrado" }, CTX);
    expect(s.active).toBe(false);
    expect(s.presetId).toBe("borrado");
    expect(s.presetOk).toBe(false);
    expect(s.warnings.join(" ")).toContain("borrado");
    expect(s.summary).toContain("no encontrado");
  });

  it("cuerpo propio: editable, y el resumen nombra disparador, objetivo y pasos", () => {
    const s = ixPanelState(defaultIxSpec(), CTX);
    expect(s.custom).toBe(true);
    expect(ixPresetChoice(s)).toBe(IX_PANEL_CUSTOM);
    expect(s.summary).toContain("al entrar en pantalla");
    expect(s.summary).toContain("este bloque");
    expect(s.summary).toContain("2 pasos");
  });

  it("un `ix` hostil no rompe el panel: se lee como 'sin interacción'", () => {
    for (const bad of [null, 42, "x", { v: 9 }, { v: 1 }, { v: 1, tracks: "no" }]) {
      expect(() => ixPanelState(bad, CTX)).not.toThrow();
      expect(ixPanelState(bad, CTX).active).toBe(false);
    }
  });
});

describe("ixPresetOptions — el desplegable del nivel 1", () => {
  it("Ninguna primero, sistema, sitio, y Personalizada al final", () => {
    const opts = ixPresetOptions(CTX);
    expect(opts[0]).toEqual({ value: IX_PANEL_NONE, label: "Ninguna" });
    expect(opts[opts.length - 1].value).toBe(IX_PANEL_CUSTOM);
    const values = opts.map((o) => o.value);
    const firstSite = values.indexOf("aparecer-tarjetas");
    const lastSys = values.lastIndexOf("sys:zoom");
    expect(firstSite).toBeGreaterThan(lastSys);
    expect(values).toContain("sys:fade-up");
  });

  it("dentro de cada grupo, por NOMBRE — que es lo que el autor lee, no el id", () => {
    const sys = ixPresetOptions(CTX).filter((o) => o.value.startsWith("sys:"));
    const labels = sys.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "es")));
    // Y no por id: por id, "sys:blur" (Desenfocar) iría primero.
    expect(labels[0]).not.toBe("Desenfocar");
  });

  it("orden estable entre llamadas (no depende del orden de claves del ajuste)", () => {
    const a = ixPresetOptions(ixCtxFromSite(parseSiteIxPresets(SITE))).map((o) => o.value);
    const b = ixPresetOptions(ixCtxFromSite(parseSiteIxPresets(SITE))).map((o) => o.value);
    expect(a).toEqual(b);
  });

  it("sin contexto: solo los dos sentinels (nunca un desplegable vacío)", () => {
    expect(ixPresetOptions(undefined).map((o) => o.value)).toEqual([
      IX_PANEL_NONE,
      IX_PANEL_CUSTOM,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Nivel 1 — preajuste                                                 */
/* ------------------------------------------------------------------ */

describe("setPresetChoice", () => {
  it("«Ninguna» quita la prop entera (el bloque vuelve a sus bytes de origen)", () => {
    expect(setPresetChoice({ v: 1, preset: "sys:fade-up" }, IX_PANEL_NONE, CTX)).toBeUndefined();
  });

  it("elegir un preajuste guarda SOLO el id — jamás una copia del cuerpo", () => {
    const out = setPresetChoice(undefined, "aparecer-tarjetas", CTX);
    expect(out).toEqual({ v: 1, preset: "aparecer-tarjetas" });
    expect((out as Record<string, unknown>).tracks).toBeUndefined();
    assertWritable(out);
  });

  it("cambiar de preajuste no arrastra el disparador del anterior", () => {
    const withTrigger = setTriggerKind({ v: 1, preset: "sys:fade-up" }, "click", CTX);
    expect((withTrigger as { trigger?: unknown }).trigger).toEqual({ on: "click" });
    const swapped = setPresetChoice(withTrigger, "aparecer-tarjetas", CTX);
    expect(swapped).toEqual({ v: 1, preset: "aparecer-tarjetas" });
  });

  it("«Personalizada» desde vacío arranca con la entrada de siempre", () => {
    const out = setPresetChoice(undefined, IX_PANEL_CUSTOM, CTX) as Record<string, unknown>;
    expect(out.preset).toBeUndefined();
    expect(Array.isArray(out.tracks)).toBe(true);
    assertWritable(out);
  });

  it("«Personalizada» desde un preajuste COPIA su cuerpo y suelta la referencia", () => {
    const out = setPresetChoice({ v: 1, preset: "aparecer-tarjetas" }, IX_PANEL_CUSTOM, CTX) as {
      preset?: string;
      tracks?: { target: { kind: string }; stagger?: { each: number } }[];
    };
    expect(out.preset).toBeUndefined();
    expect(out.tracks?.[0].target.kind).toBe("children");
    expect(out.tracks?.[0].stagger?.each).toBe(80);
    assertWritable(out);
  });
});

describe("unlinkPreset", () => {
  it("copia el cuerpo resuelto y borra la referencia; el resultado ya no propaga", () => {
    const out = unlinkPreset({ v: 1, preset: "aparecer-tarjetas" }, CTX);
    const state = ixPanelState(out, CTX);
    expect(state.presetId).toBeNull();
    expect(state.custom).toBe(true);
    expect(state.tracks[0].target.kind).toBe("children");
    assertWritable(out);
  });

  it("sobre una referencia rota no inventa un cuerpo: quita la interacción", () => {
    expect(unlinkPreset({ v: 1, preset: "borrado" }, CTX)).toBeUndefined();
  });
});

it("clearIx quita la prop", () => {
  expect(clearIx()).toBeUndefined();
});

/* ------------------------------------------------------------------ */
/* Nivel 2 — disparador                                                */
/* ------------------------------------------------------------------ */

describe("disparador", () => {
  it("con un preajuste puesto, el disparador es el ÚNICO override local (nunca `tracks`)", () => {
    const out = setTriggerKind({ v: 1, preset: "aparecer-tarjetas" }, "hover", CTX) as Record<
      string,
      unknown
    >;
    expect(out.preset).toBe("aparecer-tarjetas");
    expect(out.trigger).toEqual({ on: "hover" });
    expect(out.tracks).toBeUndefined();
    assertWritable(out);
  });

  it("con cuerpo propio, cambia el disparador y conserva las pistas", () => {
    const base = defaultIxSpec();
    const out = setTriggerKind(base, "scrub", CTX) as { trigger: unknown; tracks: unknown[] };
    expect(out.trigger).toEqual({ on: "scrub" });
    expect(out.tracks).toHaveLength(1);
    assertWritable(out);
  });

  it("`view` conserva su modo de repetición al volver a elegirlo", () => {
    const once = setViewOnce(defaultIxSpec(), false, CTX);
    expect(ixPanelState(once, CTX).trigger).toEqual({ on: "view", once: false });
    const round = setTriggerKind(setTriggerKind(once, "click", CTX), "view", CTX);
    // Al pasar por `click` se pierde el modo (el dato ya no lo lleva): vuelve al defecto seguro.
    expect(ixPanelState(round, CTX).trigger).toEqual({ on: "view", once: true });
  });

  it("`once:false` es el camino de CSS puro; `once:true`, el que necesita runtime", () => {
    const cada = compileIx(setViewOnce(defaultIxSpec(), false, CTX), CTX);
    const unaVez = compileIx(setViewOnce(defaultIxSpec(), true, CTX), CTX);
    expect(cada?.needsRuntime).toBe("no-native");
    expect(unaVez?.needsRuntime).toBe("always");
  });

  it("setViewOnce sobre un disparador que no es `view` no cambia nada", () => {
    const hover = setTriggerKind(defaultIxSpec(), "hover", CTX);
    expect(setViewOnce(hover, false, CTX)).toEqual(normalizeIxSpec(hover)?.spec);
  });
});

describe("objetivo, escalonado y tiempos", () => {
  it("cambiar el objetivo a `children` habilita el escalonado", () => {
    const out = setStagger(setTargetKind(defaultIxSpec(), "children", CTX), 120, CTX);
    const state = ixPanelState(out, CTX);
    expect(state.tracks[0].target.kind).toBe("children");
    expect(state.tracks[0].stagger?.each).toBe(120);
    assertWritable(out);
  });

  it("escalonado 0 QUITA la clave (y no deja un `{each:0}` inerte en el dato)", () => {
    const conStagger = setStagger(setTargetKind(defaultIxSpec(), "children", CTX), 120, CTX);
    const sin = setStagger(conStagger, 0, CTX) as { tracks: { stagger?: unknown }[] };
    expect(sin.tracks[0].stagger).toBeUndefined();
  });

  it("duración y retardo se CLAMPAN en la escritura, no solo al pintar", () => {
    const largo = setDuration(defaultIxSpec(), 999_999, CTX) as { tracks: { dur: number }[] };
    expect(largo.tracks[0].dur).toBe(3000);
    const corto = setDuration(defaultIxSpec(), 1, CTX) as { tracks: { dur: number }[] };
    expect(corto.tracks[0].dur).toBe(100);
    const retardo = setDelay(defaultIxSpec(), -50, CTX) as { tracks: { delay: number }[] };
    expect(retardo.tracks[0].delay).toBe(0);
  });

  it("un valor no numérico no corrompe el dato", () => {
    const out = setDuration(defaultIxSpec(), Number.NaN, CTX) as { tracks: { dur: number }[] };
    expect(out.tracks[0].dur).toBe(600);
    assertWritable(out);
  });
});

/* ------------------------------------------------------------------ */
/* Nivel 3 — pasos                                                     */
/* ------------------------------------------------------------------ */

describe("pasos", () => {
  it("añadir un paso lo mete ANTES del último: el fotograma final no se mueve", () => {
    const out = addStep(defaultIxSpec(), CTX) as { tracks: { steps: { at: number }[] }[] };
    const ats = out.tracks[0].steps.map((s) => s.at);
    expect(ats).toHaveLength(3);
    expect(ats[0]).toBe(0);
    expect(ats[ats.length - 1]).toBe(100);
    assertWritable(out);
  });

  it("el tope de pasos AVISA pero nunca rompe: al llegar a IX_MAX_STEPS deja de añadir", () => {
    let spec: unknown = defaultIxSpec();
    for (let i = 0; i < IX_MAX_STEPS + 4; i++) spec = addStep(spec, CTX);
    const state = ixPanelState(spec, CTX);
    expect(state.tracks[0].steps.length).toBeLessThanOrEqual(IX_MAX_STEPS);
    expect(state.active).toBe(true);
    assertWritable(spec);
  });

  it("los extremos no se quitan: una pista de un paso no interpola nada", () => {
    const tres = addStep(defaultIxSpec(), CTX);
    expect(ixPanelState(removeStep(tres, 0, CTX), CTX).tracks[0].steps).toHaveLength(3);
    expect(ixPanelState(removeStep(tres, 2, CTX), CTX).tracks[0].steps).toHaveLength(3);
    expect(ixPanelState(removeStep(tres, 1, CTX), CTX).tracks[0].steps).toHaveLength(2);
  });

  it("el momento de un paso intermedio se guarda; el de los extremos lo reancla el normalizador", () => {
    const tres = addStep(defaultIxSpec(), CTX);
    const movido = setStepAt(tres, 1, 30, CTX);
    expect(ixPanelState(movido, CTX).tracks[0].steps[1].at).toBe(30);
    const forzado = setStepAt(tres, 0, 40, CTX);
    expect(ixPanelState(forzado, CTX).tracks[0].steps[0].at).toBe(0);
  });

  it("la curva se guarda por paso", () => {
    const out = setStepEase(defaultIxSpec(), 0, "spring", CTX);
    expect(ixPanelState(out, CTX).tracks[0].steps[0].ease).toBe("spring");
    assertWritable(out);
  });

  it("poner y quitar una propiedad de UN paso", () => {
    const conEscala = setStepProp(defaultIxSpec(), 0, "scale", 0.8, CTX);
    expect(ixPanelState(conEscala, CTX).tracks[0].steps[0].set.scale).toBe(0.8);
    const sinEscala = setStepProp(conEscala, 0, "scale", undefined, CTX);
    expect(ixPanelState(sinEscala, CTX).tracks[0].steps[0].set.scale).toBeUndefined();
  });

  it("un valor fuera de rango se CLAMPA (un blur de 1e9 tumba el compositor, no 'se ve feo')", () => {
    const out = setStepProp(defaultIxSpec(), 0, "blur", 1e9, CTX);
    expect(ixPanelState(out, CTX).tracks[0].steps[0].set.blur).toBe(100);
    assertWritable(out);
  });

  it("vaciar la última propiedad de todos los pasos QUITA la interacción (nunca queda a medias)", () => {
    let spec: unknown = defaultIxSpec();
    for (const key of ["opacity", "y"] as const) {
      spec = setStepProp(spec, 0, key, undefined, CTX);
      spec = setStepProp(spec, 1, key, undefined, CTX);
    }
    expect(spec).toBeUndefined();
  });

  it("availableProps / usedProps salen en el ORDEN CANÓNICO, no en el de inserción", () => {
    const step = { at: 0, set: { y: 10, opacity: 0 } };
    expect(usedProps(step)).toEqual(["opacity", "y"]);
    expect(availableProps(step)[0]).toBe("x");
    expect(availableProps(step)).not.toContain("opacity");
  });

  it("editar un paso estando enlazado a un preajuste DESVINCULA (nunca `preset` + `tracks`)", () => {
    const out = setStepProp({ v: 1, preset: "aparecer-tarjetas" }, 0, "scale", 0.5, CTX) as Record<
      string,
      unknown
    >;
    expect(out.preset).toBeUndefined();
    expect(Array.isArray(out.tracks)).toBe(true);
    assertWritable(out);
  });
});

/* ------------------------------------------------------------------ */
/* La invariante: lo que el panel escribe, el compilador lo emite      */
/* ------------------------------------------------------------------ */

describe("invariante de escritura", () => {
  it("una sesión larga de edición deja SIEMPRE un dato compilable", () => {
    let spec: unknown = setPresetChoice(undefined, IX_PANEL_CUSTOM, CTX);
    const ops: Array<(v: unknown) => unknown> = [
      (v) => setTriggerKind(v, "hover", CTX),
      (v) => setTargetKind(v, "children", CTX),
      (v) => setStagger(v, 90, CTX),
      (v) => addStep(v, CTX),
      (v) => setStepProp(v, 1, "rotate", 12, CTX),
      (v) => setStepEase(v, 1, "back", CTX),
      (v) => setStepAt(v, 1, 45, CTX),
      (v) => setDuration(v, 800, CTX),
      (v) => setDelay(v, 150, CTX),
      (v) => setTriggerKind(v, "scrub", CTX),
      (v) => setTriggerKind(v, "view", CTX),
    ];
    for (const op of ops) {
      spec = op(spec);
      assertWritable(spec);
    }
    expect(ixPanelState(spec, CTX).active).toBe(true);
  });

  it("el CSS que sale de una edición del panel SOLO toca propiedades de compositor", () => {
    let spec: unknown = setPresetChoice(undefined, IX_PANEL_CUSTOM, CTX);
    for (const key of ["scale", "rotate", "rotateX", "blur", "clip", "x"] as const) {
      spec = setStepProp(spec, 0, key, 10, CTX);
    }
    const unit = compileIx(spec, CTX)!;
    const css = [...unit.keyframes, ...unit.rules].join("\n");
    const props = [...css.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
    const allowed = new Set([
      "opacity",
      "transform",
      "filter",
      "clip-path",
      "animation",
      "animation-delay",
      "animation-timeline",
      "animation-range",
      "animation-timing-function",
      "transition",
      "transition-delay",
    ]);
    for (const p of props) expect(allowed.has(p), `propiedad inesperada en el CSS: ${p}`).toBe(true);
  });

  it("los preajustes de SISTEMA del desplegable compilan todos", () => {
    for (const id of Object.keys(SYS_IX_PRESETS)) {
      const out = setPresetChoice(undefined, id, CTX);
      expect(out).toEqual({ v: 1, preset: id });
      assertWritable(out);
    }
  });
});
