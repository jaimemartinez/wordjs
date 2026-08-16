/**
 * PIN DE NO-RUPTURA — el motor de interacciones no puede cambiar NADA de lo que ya existía.
 *
 * `anim` (AnimSpec: type/duration/delay/scroll/scrollAmount) sigue produciendo EXACTAMENTE el
 * mismo markup y las mismas clases que antes del motor, y `look` (Appearance) exactamente el mismo
 * objeto de estilo. Reescribir `anim`→`ix` en las páginas guardadas cambiaría bytes de
 * `_puck_data` en cada una: rompería el gate de round-trip, invalidaría el caché de todas y
 * generaría una revisión por página — y el visitante NO vería ninguna diferencia.
 *
 * CÓMO SE PINEA. Dos capas:
 *  1. Un DIGEST (FNV-1a de la matriz entera serializada) sobre las 650 combinaciones de
 *     `animClasses` y sobre los 13 casos de `appearanceToStyle`. Un digest pilla CUALQUIER byte
 *     que se mueva, incluido el orden de las claves del objeto de estilo (que es orden de
 *     declaración CSS y por tanto significativo).
 *  2. Literales explícitos de los casos interesantes, para que el test DIGA qué se está
 *     protegiendo y no solo que "el número cambió". Si solo hubiera digest, romperlo no diría
 *     dónde; si solo hubiera literales, se colarían las combinaciones no listadas.
 *
 * Los valores golden se generaron ejecutando la implementación ANTES de tocar nada.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  animClasses,
  appearanceToStyle,
  type AnimSpec,
  type Appearance,
  type Hide,
} from "@/components/blocks/blockShell";
import SharedBlockShell from "@/components/content/SharedBlockShell";
import { fnv1a32 } from "../canonical";

const TYPES: AnimSpec["type"][] = [
  "", "fade", "fade-up", "fade-down", "fade-left", "fade-right",
  "zoom", "zoom-out", "blur", "rise", "flip", "reveal", "swing",
];
const SCROLLS: AnimSpec["scroll"][] = ["", "parallax", "fade", "scale", "rotate"];
/** Incluye hostiles a propósito: 0, negativo, absurdo y NaN — el clamp es parte del contrato. */
const AMOUNTS: (number | undefined)[] = [undefined, 0, 5, 10, 30, 47, 100, 250, -20, NaN];

const LOOKS: Appearance[] = [
  {},
  { bg: "color", bgColor: "#fff" },
  { bg: "gradient", gradFrom: "#a", gradVia: "#b", gradTo: "#c", gradAngle: 45, gradAnimate: true },
  { bg: "image", bgImage: "/x.png", bgFixed: true, overlay: 0.4, overlayColor: "#123", radius: 12 },
  { bg: "glass", glassBlur: 20, glassTint: "rgb(1 2 3 / .5)" },
  { borderWidth: 2, borderStyle: "dashed", borderColor: "#eee", radius: 8, shadow: "md" },
  { shadow: "custom", shadowX: 1, shadowY: 2, shadowBlur: 3, shadowSpread: 4, shadowColor: "#000" },
  { padY: 10, padX: 20, mt: 4, mb: 6, maxWidth: 800, minHeight: 200 },
  { color: "#111", fontSize: 18, fontWeight: "700", fontFamily: "X", lineHeight: 1.5, letterSpacing: 2, align: "left", transform: "uppercase" },
  { align: "right" },
  { hover: "lift", hoverAmount: 9, hoverSpeed: 200, hoverColor: "#f00" },
  { padY: 10, tb: { padY: 5, fontSize: 14 }, mo: { padY: 2, align: "right", maxWidth: 0, minHeight: 0, lineHeight: 0, fontSize: 0 } },
  { maxWidth: 0, minHeight: 0 },
];

describe("no-ruptura: animClasses", () => {
  it("la matriz COMPLETA (13 tipos × 5 scrolls × 10 intensidades) es byte-idéntica", () => {
    const rows: string[] = [];
    for (const type of TYPES) {
      for (const scroll of SCROLLS) {
        for (const scrollAmount of AMOUNTS) {
          const spec: AnimSpec = { type, duration: 600, delay: 0, scroll, scrollAmount };
          const amt = scrollAmount === undefined ? "" : Number.isNaN(scrollAmount) ? "NaN" : String(scrollAmount);
          rows.push([type, scroll, amt, animClasses(spec)].join("|"));
        }
      }
    }
    expect(rows).toHaveLength(650);
    expect(fnv1a32(rows.join("\n")).toString(36)).toBe("pczm0p");
  });

  it("los casos que documentan el contrato, literales", () => {
    expect(animClasses({ type: "fade-up" })).toBe("wjs-anim wjs-anim-fade-up");
    expect(animClasses({ type: "blur", scrollAmount: 0 })).toBe("wjs-anim wjs-anim-blur");
    // scrollAmount se cuantiza a decenas y se clampa a 10..100 — incluidos los hostiles.
    expect(animClasses({ scroll: "parallax", scrollAmount: 47 })).toBe(
      "wjs-scroll wjs-scroll-parallax wjs-scroll-amt-50",
    );
    expect(animClasses({ type: "zoom", scroll: "parallax", scrollAmount: 250 })).toBe(
      "wjs-anim wjs-anim-zoom wjs-scroll wjs-scroll-parallax wjs-scroll-amt-100",
    );
    expect(animClasses({ type: "swing", scroll: "rotate", scrollAmount: -20 })).toBe(
      "wjs-anim wjs-anim-swing wjs-scroll wjs-scroll-rotate wjs-scroll-amt-10",
    );
    expect(animClasses({ type: "reveal", scroll: "fade", scrollAmount: NaN })).toBe(
      "wjs-anim wjs-anim-reveal wjs-scroll wjs-scroll-fade wjs-scroll-amt-10",
    );
    expect(animClasses(undefined)).toBe("");
    expect(animClasses({})).toBe("");
  });
});

describe("no-ruptura: appearanceToStyle", () => {
  it("los 13 casos de la matriz son byte-idénticos, ORDEN DE CLAVES incluido", () => {
    const ser = JSON.stringify(LOOKS.map((l) => [l, appearanceToStyle(l)]));
    expect(fnv1a32(ser).toString(36)).toBe("16lvgor");
  });

  it("los casos que documentan el contrato, literales", () => {
    expect(appearanceToStyle({ hover: "lift", hoverAmount: 9, hoverSpeed: 200, hoverColor: "#f00" })).toEqual({
      style: { "--wjs-hover-amt": "9", "--wjs-hover-speed": "200ms", "--wjs-hover-color": "#f00" },
      className: "wjs-fx wjs-hover-lift",
      hasBox: true,
      overlay: null,
    });
    // `align: right` → lógico `end` (para que el bloque espeje bajo dir="rtl").
    expect(appearanceToStyle({ align: "right" }).style).toEqual({ textAlign: "end" });
    // Un bloque intacto no tiene caja: el wrapper se queda en display:contents.
    expect(appearanceToStyle({}).hasBox).toBe(false);
  });
});

describe("no-ruptura: markup de SharedBlockShell sin `ix`", () => {
  const cases: Array<[string, { hide?: Hide; anim?: AnimSpec; look?: Appearance }, string]> = [
    ["nada → el bloque sin envolver", {}, "<p>X</p>"],
    [
      "solo hide",
      { hide: { mobile: true } },
      '<div class="wjs-hide-mobile" style="display:contents"><p>X</p></div>',
    ],
    [
      "solo look",
      { look: { padY: 8, bg: "color", bgColor: "#eee" } },
      '<div style="background:#eee;padding:8px 0px"><p>X</p></div>',
    ],
    [
      "entrada",
      { anim: { type: "fade-up", duration: 600, delay: 0 } },
      '<div class="wjs-anim wjs-anim-fade-up" style="--wjs-anim-dur:600ms;--wjs-anim-delay:0ms"><p>X</p></div>',
    ],
    [
      "entrada + scroll + look + hide (las DOS capas anidadas)",
      {
        hide: { tablet: true },
        anim: { type: "zoom", duration: 900, delay: 120, scroll: "parallax", scrollAmount: 50 },
        look: { radius: 6, hover: "lift" },
      },
      '<div class="wjs-hide-tablet wjs-anim wjs-anim-zoom wjs-scroll wjs-scroll-parallax wjs-scroll-amt-50" style="--wjs-anim-dur:900ms;--wjs-anim-delay:120ms"><div class="wjs-fx wjs-hover-lift" style="border-radius:6px;--wjs-hover-amt:6;--wjs-hover-speed:300ms;--wjs-hover-color:var(--wjs-color-primary, #2563eb)"><p>X</p></div></div>',
    ],
    [
      // La verruga DOCUMENTADA: scroll sin entrada, sin hide y sin caja pierde sus clases. Se pinea
      // tal cual — arreglarla es un cambio deliberado en las DOS superficies, no un efecto lateral.
      "scroll solo (verruga documentada: se pierde)",
      { anim: { type: "", scroll: "fade", scrollAmount: 40 } },
      "<p>X</p>",
    ],
    [
      "overlay (capa de atenuación + contexto de apilado)",
      { look: { bg: "image", bgImage: "/x.png", overlay: 0.5, radius: 10 } },
      '<div style="background-image:url(/x.png);background-size:cover;background-position:center;background-repeat:no-repeat;border-radius:10px;position:relative;overflow:hidden"><div style="position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:#000;opacity:0.5" aria-hidden="true"></div><div style="position:relative"><p>X</p></div></div>',
    ],
  ];

  for (const [name, props, expected] of cases) {
    it(name, () => {
      const html = renderToStaticMarkup(
        <SharedBlockShell {...props}>
          <p>X</p>
        </SharedBlockShell>,
      );
      expect(html).toBe(expected);
    });
  }

  it("`ix: undefined` NO añade ni un elemento ni un atributo", () => {
    const withUndef = renderToStaticMarkup(
      <SharedBlockShell anim={{ type: "fade-up", duration: 600, delay: 0 }} ix={undefined}>
        <p>X</p>
      </SharedBlockShell>,
    );
    expect(withUndef).toBe(
      '<div class="wjs-anim wjs-anim-fade-up" style="--wjs-anim-dur:600ms;--wjs-anim-delay:0ms"><p>X</p></div>',
    );
  });

  it("un `ix` INVÁLIDO tampoco añade nada (fail-open: visible y quieto)", () => {
    for (const bad of [null, 0, "x", {}, { v: 2 }, { v: 1 }, { v: 1, tracks: [] }, { v: 1, preset: "no-existe" }]) {
      const html = renderToStaticMarkup(
        <SharedBlockShell ix={bad}>
          <p>X</p>
        </SharedBlockShell>,
      );
      expect(html, `ix=${JSON.stringify(bad)}`).toBe("<p>X</p>");
    }
  });

  it("un `ix` VÁLIDO añade la capa ③ DENTRO de la entrada y FUERA de la apariencia", () => {
    const html = renderToStaticMarkup(
      <SharedBlockShell
        anim={{ type: "fade-up", duration: 600, delay: 0 }}
        look={{ hover: "lift" }}
        ix={{ v: 1, preset: "sys:fade" }}
      >
        <p>X</p>
      </SharedBlockShell>,
    );
    // ① entrada  →  ③ interacción  →  ② apariencia  →  contenido
    expect(html).toMatch(
      /^<div class="wjs-anim wjs-anim-fade-up"[^>]*><div class="wjs-ix-[a-z0-9]{7}"[^>]*><div class="wjs-fx wjs-hover-lift"/,
    );
    // El servidor JAMÁS estampa el atributo de estado: el HTML servido no oculta nada.
    expect(html).not.toContain('data-wjs-ix="');
  });
});
