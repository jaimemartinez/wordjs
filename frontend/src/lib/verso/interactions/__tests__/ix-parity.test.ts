/**
 * C6 — PARIDAD ENTRE LOS DOS BACKENDS, defendida por aritmética.
 *
 * El motor tiene dos salidas para el MISMO modelo: el CSS que emite el compilador (el camino
 * nativo, el que ve Chrome y Safari) y los fotogramas WAAPI del IR (el camino que baja Firefox, y
 * el que dibuja el previsualizador del editor). Las escriben dos funciones distintas —`declsOf` y
 * `keyframeOf`— y hasta ahora nada comprobaba que dijeran lo mismo: un fallo de paridad no rompe
 * ningún test, simplemente hace que el visitante de un navegador vea otra animación que el de otro,
 * y que el autor edite mirando una tercera.
 *
 * Aquí se comparan fotograma a fotograma, propiedad a propiedad, en los tres puntos que definen una
 * animación (0 %, 50 % y 100 %) y en el estado final que ve quien pide menos movimiento.
 *
 * La ÚNICA diferencia legítima es el espejo RTL (C4): el CSS lo resuelve con
 * `calc(var(--wjs-ix-dir,1) * …)` porque una variable sí se resuelve en una hoja, mientras que el
 * IR trae los dos juegos ya calculados porque `Element.animate()` no resuelve variables. El test
 * sustituye la variable por su valor (1 para LTR, −1 para RTL) y exige igualdad exacta: es
 * precisamente esa sustitución la que prueba que las dos ramas hacen la MISMA cuenta.
 */
import { describe, expect, it } from "vitest";
import { compileIx, compileIxPage, toRuntimeUnit } from "../compile";
import type { IxKeyframe, IxSpec, IxStep } from "../types";

/* ------------------------------------------------------------------ */
/* Lectura del CSS emitido                                             */
/* ------------------------------------------------------------------ */

/** `@keyframes x{0%{a:1;b:2}100%{…}}` → `{ "0%": {a:"1",b:"2"}, … }`. */
function parseKeyframes(css: string): Record<string, Record<string, string>> {
  const body = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
  const out: Record<string, Record<string, string>> = {};
  const re = /([\d.]+%)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const decls: Record<string, string> = {};
    for (const part of m[2].split(";")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    out[m[1]] = decls;
  }
  return out;
}

/** `color` → `color`, `background-color` → `backgroundColor`: los nombres del IR son camelCase. */
const camel = (prop: string) => prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Resuelve el espejo direccional del CSS con un valor concreto de `--wjs-ix-dir`, que es lo que
 * hace el motor al aplicar la regla. Sin esto no se podrían comparar los dos caminos: uno lleva la
 * cuenta pendiente y el otro la trae hecha.
 */
function resolveDir(value: string, dir: 1 | -1): string {
  return value.replace(
    /calc\(var\(--wjs-ix-dir,1\)\s*\*\s*(-?[\d.]+)(px|deg)\)/g,
    (_, n: string, unit: string) => {
      const v = Number(n) * dir;
      // Mismo formateo que `n()` del compilador: sin ceros de más, y `-0` normalizado a `0`.
      return `${Object.is(v, -0) ? 0 : v}${unit}`;
    },
  );
}

/** Los fotogramas del CSS y los del IR, ya normalizados para poder compararse. */
function bothBackends(spec: IxSpec, dir: 1 | -1 = 1) {
  const unit = compileIx(spec)!;
  const css = parseKeyframes(unit.keyframes[0]);
  const track = toRuntimeUnit(unit).tracks[0];
  const kf = dir === -1 && track.kfRtl ? track.kfRtl : track.kf;
  return { css, kf, unit };
}

/** Un fotograma del IR sin su `offset` (que no es una propiedad animada sino su posición). */
function propsOf(frame: IxKeyframe): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(frame)) {
    if (k === "offset" || k === "easing") continue;
    out[k] = String(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */

const track = (steps: IxStep[]) => ({ target: { kind: "self" as const }, steps });
const mk = (steps: IxStep[], trigger: IxSpec["trigger"] = { on: "load" }): IxSpec =>
  ({ v: 1, trigger, tracks: [track(steps)] }) as IxSpec;

/** Un caso por familia de propiedades: transform, filtro, recorte, color y trazo. */
const CASES: ReadonlyArray<{ name: string; spec: IxSpec }> = [
  {
    name: "transform completo (x, y, escala, giros, sesgo, z)",
    spec: mk([
      { at: 0, set: { x: -40, y: 24, scale: 0.8, rotate: -6, rotateX: 12, skewX: 8, z: -80 } },
      { at: 50, set: { x: -10, y: 6, scale: 0.95, rotate: -1, rotateX: 3, skewX: 2, z: -20 } },
      { at: 100, set: { x: 0, y: 0, scale: 1, rotate: 0, rotateX: 0, skewX: 0, z: 0 } },
    ] as IxStep[]),
  },
  {
    name: "filtros (desenfoque, brillo, saturación, tono)",
    spec: mk([
      { at: 0, set: { blur: 8, brightness: 0.6, saturate: 0.2, hue: 40 } },
      { at: 50, set: { blur: 4, brightness: 0.8, saturate: 0.6, hue: 20 } },
      { at: 100, set: { blur: 0, brightness: 1, saturate: 1, hue: 0 } },
    ] as IxStep[]),
  },
  {
    name: "recorte y opacidad",
    spec: mk([
      // `clip` es REVELADO: 0 = tapado, 100 = a la vista (su valor neutro).
      { at: 0, set: { clip: 0, opacity: 0 } },
      { at: 50, set: { clip: 50, opacity: 0.5 } },
      { at: 100, set: { clip: 100, opacity: 1 } },
    ] as IxStep[]),
  },
  {
    name: "colores, literales y del tema",
    spec: mk([
      { at: 0, set: { textColor: 0x112233, bgColor: 0x445566 } },
      { at: 50, set: { textColor: 0x778899 }, tint: { bgColor: "primary" } },
      { at: 100, set: { textColor: 0xaabbcc }, tint: { bgColor: "accent" } },
    ] as unknown as IxStep[]),
  },
  {
    name: "trazo SVG",
    spec: {
      v: 1,
      trigger: { on: "scrub" },
      tracks: [{ target: { kind: "svg" }, steps: [{ at: 0, set: { draw: 0 } }, { at: 100, set: { draw: 100 } }] }],
    } as unknown as IxSpec,
  },
];

describe("paridad CSS ↔ WAAPI: los dos caminos describen la MISMA animación", () => {
  for (const c of CASES) {
    it(`${c.name}: mismos fotogramas, mismas propiedades, mismos valores`, () => {
      const { css, kf } = bothBackends(c.spec);
      const offsets = Object.keys(css);
      expect(kf).toHaveLength(offsets.length);

      for (const frame of kf) {
        const pct = `${Number(frame.offset) * 100}%`;
        const cssFrame = css[pct];
        expect(cssFrame, `el CSS no tiene el fotograma ${pct}`).toBeDefined();

        const irProps = propsOf(frame);
        // Mismo CONJUNTO de propiedades: una que solo declare un lado es una divergencia visible.
        expect(Object.keys(irProps).sort()).toEqual(
          Object.keys(cssFrame).map(camel).sort(),
        );
        for (const [prop, value] of Object.entries(cssFrame)) {
          expect(irProps[camel(prop)], `${pct} → ${prop}`).toBe(resolveDir(value, 1));
        }
      }
    });
  }

  it("el espejo RTL también cuadra: el CSS con dir=−1 es el juego `kfRtl` del IR", () => {
    const spec = mk([
      { at: 0, set: { x: -40, skewX: 6, y: 20 } },
      { at: 100, set: { x: 0, skewX: 0, y: 0 } },
    ] as IxStep[]);
    const { css, kf } = bothBackends(spec, -1);
    for (const frame of kf) {
      const cssFrame = css[`${Number(frame.offset) * 100}%`];
      for (const [prop, value] of Object.entries(cssFrame)) {
        expect(propsOf(frame)[camel(prop)], `${prop} espejado`).toBe(resolveDir(value, -1));
      }
    }
  });

  it("el ÚLTIMO fotograma es el mismo en los dos caminos — es el que ve quien pide menos movimiento", () => {
    // Con `prefers-reduced-motion` no se ejecuta ninguna animación (el CSS entero vive dentro de
    // la media query y el runtime no arma nada), así que lo que queda a la vista es el estado
    // final. Que los dos backends coincidan en ÉL es la garantía que no puede fallar.
    for (const c of CASES) {
      const { css, kf } = bothBackends(c.spec);
      const last = kf[kf.length - 1];
      const cssLast = css["100%"];
      for (const [prop, value] of Object.entries(cssLast)) {
        expect(propsOf(last)[camel(prop)], `${c.name} → ${prop}`).toBe(resolveDir(value, 1));
      }
    }
  });

  it("y el estado final es NEUTRO: nada queda desplazado, girado ni a medio pintar", () => {
    const { css } = bothBackends(CASES[0].spec);
    // La identidad se declara ENTERA en vez de `none`: todos los fotogramas de la pista declaran
    // el mismo conjunto de funciones, que es lo que hace la interpolación determinista. Lo que se
    // comprueba aquí es que cada una está en su valor neutro.
    expect(css["100%"].transform).toBe(
      "perspective(1000px) translate3d(0px,0px,0px) scale(1) rotate(0deg) rotateX(0deg) skewX(0deg)",
    );
    const { css: filters } = bothBackends(CASES[1].spec);
    expect(filters["100%"].filter).toBe("blur(0px) brightness(1) saturate(1) hue-rotate(0deg)");
    const { css: clip } = bothBackends(CASES[2].spec);
    expect(clip["100%"].opacity).toBe("1");
    expect(clip["100%"]["clip-path"]).toBe("inset(0 0% 0 0)"); // revelado del todo
  });

  it("la página entera mantiene la paridad, unidad por unidad", () => {
    const page = compileIxPage(CASES.map((c) => c.spec));
    expect(page.units.length).toBeGreaterThan(1);
    for (const unit of page.units) {
      const css = parseKeyframes(unit.keyframes[0]);
      const kf = toRuntimeUnit(unit).tracks[0].kf;
      expect(kf).toHaveLength(Object.keys(css).length);
    }
  });
});
