/**
 * SPLIT POR PALABRAS (motor de interacciones, F9-D) — LAS DOS CONDICIONES INNEGOCIABLES.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * (a) UN BLOQUE SIN ESA INTERACCIÓN SALE BYTE-IDÉNTICO AL DE HOY
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * Los literales de `GOLDEN` NO se escribieron a mano: se capturaron ejecutando `HeadingBlock` y
 * `QuoteBlock` ANTES de tocarlos, y se pegaron aquí tal cual. Cualquier byte que se mueva en el
 * camino sin split —un atributo reordenado, un espacio, un `aria-*` de más "por si acaso"— rompe
 * este test. Es el mismo criterio que `ix-nobreak.test.tsx` aplica al wrapper compartido, aplicado
 * ahora al interior de los bloques de texto.
 *
 * Se cubre además el caso que un renderer descuidado habría roto: `ix` PUESTO pero apuntando a otra
 * cosa (`self`), y un `ixWords: true` colado en `_puck_data`. Ninguno de los dos parte nada.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * (b) ACCESIBILIDAD: SE LEE LA FRASE, NO LAS PALABRAS SUELTAS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * Partir un titular en cajas (`display: inline-block`, que `transform` exige) es exactamente lo que
 * hace que un lector de pantalla trate cada palabra como un fragmento independiente. El contrato es
 * el de §3.4.1 de la spec: `aria-label` con el texto ÍNTEGRO en el contenedor y `aria-hidden="true"`
 * en cada span.
 *
 * Aquí se comprueba de las tres formas que un test sin navegador puede comprobarlo, y las tres a la
 * vez, porque cada una sola se puede satisfacer haciendo trampa:
 *   1. el contenedor tiene `aria-label` y su valor es EXACTAMENTE el texto completo;
 *   2. TODOS los spans de palabra están dentro de un subárbol `aria-hidden` (no queda ni uno suelto);
 *   3. el texto que un lector de pantalla RECORRERÍA dentro del contenedor es la cadena vacía — o
 *      sea: no hay ninguna palabra suelta que leer, solo el nombre accesible del punto 1.
 * (El árbol de accesibilidad real se verifica además en el navegador; esto es el suelo, no el techo.)
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  compileIx,
  ixCtxFromSite,
  parseSiteIxPresets,
  IX_MAX_WORDS,
  IX_SYS_CTX,
  type IxCompileCtx,
  type IxSpec,
} from "@/lib/verso/interactions";
import { HeadingBlock, QuoteBlock } from "../blocks";

/* ------------------------------------------------------------------ */
/* Datos                                                               */
/* ------------------------------------------------------------------ */

/** Interacción propia que mueve LAS PALABRAS, escalonadas. */
const WORDS_IX: IxSpec = {
  v: 1,
  trigger: { on: "view", once: true },
  tracks: [
    {
      target: { kind: "words" },
      steps: [
        { at: 0, set: { opacity: 0, y: 16 }, ease: "out" },
        { at: 100, set: { opacity: 1, y: 0 } },
      ],
      dur: 600,
      delay: 0,
      stagger: { each: 40 },
    },
  ],
};

/** La MISMA interacción, pero sobre el bloque entero: no debe partir nada. */
const SELF_IX: IxSpec = { ...WORDS_IX, tracks: [{ ...WORDS_IX.tracks![0], target: { kind: "self" } }] };

/** Un preajuste DEL SITIO que apunta a las palabras: el objetivo puede venir de ajustes. */
const SITE_CTX: IxCompileCtx = ixCtxFromSite(
  parseSiteIxPresets(
    JSON.stringify([
      { id: "titular-en-cascada", name: "Titular en cascada", ...WORDS_IX, rev: 3 },
    ]),
  ),
);

/* ------------------------------------------------------------------ */
/* (a) No-ruptura — literales capturados ANTES de tocar los bloques    */
/* ------------------------------------------------------------------ */

const GOLDEN: Array<[string, React.ReactElement, string]> = [
  [
    "heading mínimo",
    <HeadingBlock key="g1" title="Hola mundo cruel" />,
    '<h2 class="wjs-block-heading wp-block-heading heading-h2">Hola mundo cruel</h2>',
  ],
  [
    "heading con todas sus props",
    <HeadingBlock
      key="g2"
      title="Hola mundo"
      level="h1"
      elementId="x"
      color="#f00"
      size={40}
      weight="700"
      tracking={2}
      css={{ opacity: 0.5 }}
    />,
    '<h1 id="x" class="wjs-block-heading wp-block-heading heading-h1" style="--wjs-heading-color:#f00;--wjs-heading-size:40px;--wjs-heading-font-weight:700;--wjs-heading-tracking:2px;opacity:0.5">Hola mundo</h1>',
  ],
  [
    "heading con markup y entidades (sigue pasando por sanitizeHTML)",
    <HeadingBlock key="g3" title={"A & <em>B</em> > C"} level="h3" />,
    '<h3 class="wjs-block-heading wp-block-heading heading-h3">A &amp; <em>B</em> &gt; C</h3>',
  ],
  [
    "heading vacío",
    <HeadingBlock key="g4" title="" level="h4" />,
    '<h4 class="wjs-block-heading wp-block-heading heading-h4"></h4>',
  ],
  [
    "quote barra",
    <QuoteBlock key="g5" text="Uno dos tres" cite="Alguien" />,
    '<figure class="wjs-block-quote wp-block-quote wjs-block-quote--bar wp-block-quote--bar"><blockquote class="wjs-block-quote__body wp-block-quote__body">Uno dos tres<footer class="wjs-block-quote__cite wp-block-quote__cite">— Alguien</footer></blockquote></figure>',
  ],
  [
    "quote grande con todas sus props",
    <QuoteBlock
      key="g6"
      text="Uno dos tres"
      cite="Alguien"
      style="large"
      accent="#00f"
      size={20}
      color="#111"
      quoteStyle="italic"
      css={{ margin: 4 }}
    />,
    '<figure class="wjs-block-quote wp-block-quote wjs-block-quote--large wp-block-quote--large" style="--wjs-quote-accent:#00f;--wjs-quote-size:20px;--wjs-quote-color:#111;--wjs-quote-style:italic;margin:4px"><i class="fa-solid fa-quote-left wjs-block-quote__mark wp-block-quote__mark" aria-hidden="true"></i><blockquote class="wjs-block-quote__body wp-block-quote__body">Uno dos tres</blockquote><figcaption class="wjs-block-quote__cite wp-block-quote__cite">— Alguien</figcaption></figure>',
  ],
  [
    "quote sin autor",
    <QuoteBlock key="g7" text="Solo texto" />,
    '<figure class="wjs-block-quote wp-block-quote wjs-block-quote--bar wp-block-quote--bar"><blockquote class="wjs-block-quote__body wp-block-quote__body">Solo texto</blockquote></figure>',
  ],
  [
    "quote con caracteres que React escapa",
    <QuoteBlock key="g8" text={"A & <b>B</b>"} style="large" />,
    '<figure class="wjs-block-quote wp-block-quote wjs-block-quote--large wp-block-quote--large"><i class="fa-solid fa-quote-left wjs-block-quote__mark wp-block-quote__mark" aria-hidden="true"></i><blockquote class="wjs-block-quote__body wp-block-quote__body">A &amp; &lt;b&gt;B&lt;/b&gt;</blockquote></figure>',
  ],
];

describe("no-ruptura: el HTML de un bloque de texto SIN split", () => {
  for (const [name, el, expected] of GOLDEN) {
    it(`${name} — byte a byte`, () => {
      expect(renderToStaticMarkup(el)).toBe(expected);
    });
  }

  it("una interacción que NO apunta a las palabras deja el markup intacto", () => {
    expect(renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ix={SELF_IX} />)).toBe(
      GOLDEN[0][2],
    );
    expect(renderToStaticMarkup(<QuoteBlock text="Solo texto" ix={SELF_IX} />)).toBe(GOLDEN[6][2]);
  });

  it("un `ix` que el motor no entiende tampoco parte nada (fail-open)", () => {
    for (const bad of [undefined, null, 0, "x", {}, { v: 2 }, { v: 1 }, { v: 1, preset: "no-existe" }]) {
      expect(renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ix={bad} />)).toBe(
        GOLDEN[0][2],
      );
    }
  });

  it("`ixWords: true` colado en `_puck_data` NO parte nada: el dato que manda es `ix`", () => {
    // La prop solo se honra en su forma NEGATIVA (`false`, que usa el canvas al editar en línea).
    // Si `true` bastara, cualquiera podría cambiar el markup de un bloque sin tocar su interacción.
    expect(
      renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ixWords={true} />),
    ).toBe(GOLDEN[0][2]);
    expect(renderToStaticMarkup(<QuoteBlock text="Solo texto" ixWords={true} />)).toBe(GOLDEN[6][2]);
  });

  it("`ixWords: false` apaga el split aunque la interacción lo pida (sesión de edición inline)", () => {
    expect(
      renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ix={WORDS_IX} ixWords={false} />),
    ).toBe(GOLDEN[0][2]);
  });
});

/* ------------------------------------------------------------------ */
/* El split, cuando SÍ toca                                            */
/* ------------------------------------------------------------------ */

describe("el split emite lo que el compilador espera encontrar", () => {
  it("un span por palabra, con su índice inline", () => {
    const html = renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ix={WORDS_IX} />);
    expect(html).toBe(
      '<h2 class="wjs-block-heading wp-block-heading heading-h2" aria-label="Hola mundo cruel">' +
        '<span class="wjs-ixw" style="--wjs-ixv-i:0" aria-hidden="true">Hola</span> ' +
        '<span class="wjs-ixw" style="--wjs-ixv-i:1" aria-hidden="true">mundo</span> ' +
        '<span class="wjs-ixw" style="--wjs-ixv-i:2" aria-hidden="true">cruel</span>' +
        "</h2>",
    );
  });

  it("el SELECTOR que emite el compilador encuentra esos spans (o el CSS no movería nada)", () => {
    const unit = compileIx(WORDS_IX, IX_SYS_CTX)!;
    const html = renderToStaticMarkup(<HeadingBlock title="Hola mundo" ix={WORDS_IX} />);
    // El compilador escribe `.<cls>[estado] .wjs-ixw{…}` (aquí el estado es el latch de la entrada
    // «una vez») y el retardo por hermano contra `--wjs-ixv-i`.
    const rule = unit.rules.join("\n");
    expect(rule).toContain(`.${unit.cls}[data-wjs-ix="in"] .wjs-ixw{`);
    expect(rule).toContain("var(--wjs-ixv-i, 0) * 40ms");
    // …y el markup trae exactamente esa clase y esa variable.
    expect(html).toContain('class="wjs-ixw"');
    expect(html).toContain("--wjs-ixv-i:0");
  });

  it("Quote: la etiqueta va en el <blockquote> y la cita NO se pierde del árbol", () => {
    const html = renderToStaticMarkup(<QuoteBlock text="Uno dos" cite="Alguien" ix={WORDS_IX} />);
    // El pie sale del blockquote: un `aria-label` sustituye TODO el contenido del elemento que lo
    // lleva, y dentro se habría llevado la cita por delante.
    expect(html).toBe(
      '<figure class="wjs-block-quote wp-block-quote wjs-block-quote--bar wp-block-quote--bar">' +
        '<blockquote class="wjs-block-quote__body wp-block-quote__body" aria-label="Uno dos">' +
        '<span class="wjs-ixw" style="--wjs-ixv-i:0" aria-hidden="true">Uno</span> ' +
        '<span class="wjs-ixw" style="--wjs-ixv-i:1" aria-hidden="true">dos</span>' +
        "</blockquote>" +
        '<footer class="wjs-block-quote__cite wp-block-quote__cite">— Alguien</footer>' +
        "</figure>",
    );
  });

  it("el objetivo puede venir de un preajuste DEL SITIO (por eso el bloque recibe `ixCtx`)", () => {
    const ref = { v: 1, preset: "titular-en-cascada" };
    // Sin catálogo del sitio la referencia no resuelve: fail-open, markup de siempre.
    expect(renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ix={ref} />)).toBe(
      GOLDEN[0][2],
    );
    // Con él, parte igual que si el cuerpo estuviera en el bloque.
    expect(
      renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ix={ref} ixCtx={SITE_CTX} />),
    ).toBe(renderToStaticMarkup(<HeadingBlock title="Hola mundo cruel" ix={WORDS_IX} />));
  });
});

/* ------------------------------------------------------------------ */
/* Fail-open                                                           */
/* ------------------------------------------------------------------ */

describe("fail-open: cuando no se puede partir, el bloque se ve igual que siempre", () => {
  it("un titular con markup no se parte (repartir `<em>` entre spans lo rompería)", () => {
    expect(renderToStaticMarkup(<HeadingBlock title={"A & <em>B</em> > C"} level="h3" ix={WORDS_IX} />)).toBe(
      GOLDEN[2][2],
    );
  });

  it("un titular con `&` tampoco: la decisión no puede depender de qué saneador haya corrido", () => {
    // `sanitizeHTML` es sanitize-html en el servidor y DOMPurify en el cliente. Si la condición de
    // partir mirase su SALIDA, servidor y cliente podrían discrepar en la forma del árbol — y eso
    // es un fallo de hidratación que `suppressHydrationWarning` no tapa.
    const html = renderToStaticMarkup(<HeadingBlock title="Pros & contras" ix={WORDS_IX} />);
    expect(html).not.toContain("wjs-ixw");
    expect(html).toBe('<h2 class="wjs-block-heading wp-block-heading heading-h2">Pros &amp; contras</h2>');
  });

  it("una cita con `<` SÍ se parte: ahí el texto es un hijo de React, no HTML", () => {
    const html = renderToStaticMarkup(<QuoteBlock text={"a < b"} ix={WORDS_IX} />);
    expect(html).toContain('<span class="wjs-ixw" style="--wjs-ixv-i:1" aria-hidden="true">&lt;</span>');
    expect(html).toContain('aria-label="a &lt; b"');
  });

  it(`por encima de ${IX_MAX_WORDS} palabras no se parte`, () => {
    const justo = Array.from({ length: IX_MAX_WORDS }, (_, i) => `p${i}`).join(" ");
    const pasado = `${justo} extra`;
    expect(renderToStaticMarkup(<HeadingBlock title={justo} ix={WORDS_IX} />)).toContain("wjs-ixw");
    expect(renderToStaticMarkup(<HeadingBlock title={pasado} ix={WORDS_IX} />)).not.toContain("wjs-ixw");
  });

  it("un texto vacío o solo espacios no se parte", () => {
    for (const t of ["", "   ", "\n\t"]) {
      expect(renderToStaticMarkup(<HeadingBlock title={t} ix={WORDS_IX} />)).not.toContain("wjs-ixw");
    }
  });
});

/* ------------------------------------------------------------------ */
/* (b) Accesibilidad                                                   */
/* ------------------------------------------------------------------ */

/** Elementos sin cierre: no abren subárbol. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

/**
 * El texto que un lector de pantalla RECORRERÍA en un fragmento de markup: todo lo que no esté
 * dentro de un subárbol `aria-hidden="true"`.
 *
 * Se recorre carácter a carácter (gemelo del de `verso/fields/__tests__/interactionsControl.test.tsx`)
 * y no con `replace(/<[^>]+>/g, "")`, que ni descarta los subárboles ocultos ni sobrevive a una
 * etiqueta a medio escribir.
 */
function accessibleText(markup: string): string {
  let out = "";
  let hidden = false;
  let depth = 0;
  let i = 0;
  while (i < markup.length) {
    if (markup[i] !== "<") {
      if (!hidden) out += markup[i];
      i += 1;
      continue;
    }
    const close = markup.indexOf(">", i);
    if (close === -1) break;
    const tag = markup.slice(i + 1, close);
    i = close + 1;
    const isEnd = tag.startsWith("/");
    const name = (isEnd ? tag.slice(1) : tag).trim().split(/[\s/]/)[0].toLowerCase();
    const opensSubtree = !tag.endsWith("/") && !VOID_TAGS.has(name);
    if (hidden) {
      if (isEnd) {
        if (depth === 0) hidden = false;
        else depth -= 1;
      } else if (opensSubtree) depth += 1;
    } else if (!isEnd && opensSubtree && /\saria-hidden="true"/.test(tag)) {
      hidden = true;
      depth = 0;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

describe("a11y: un lector de pantalla lee la FRASE, no las palabras sueltas", () => {
  const FRASE = "El segundo mejor momento es ahora";

  it("[heading] el nombre accesible es el texto ÍNTEGRO", () => {
    const html = renderToStaticMarkup(<HeadingBlock title={FRASE} ix={WORDS_IX} />);
    expect(html).toContain(`aria-label="${FRASE}"`);
  });

  it("[heading] NO queda ni un span de palabra fuera de un subárbol oculto", () => {
    const html = renderToStaticMarkup(<HeadingBlock title={FRASE} ix={WORDS_IX} />);
    const spans = [...html.matchAll(/<span class="wjs-ixw"[^>]*>/g)].map((m) => m[0]);
    expect(spans).toHaveLength(6);
    for (const s of spans) expect(s).toContain('aria-hidden="true"');
  });

  it("[heading] el texto RECORRIBLE dentro del titular es vacío: no hay palabras que leer sueltas", () => {
    const html = renderToStaticMarkup(<HeadingBlock title={FRASE} ix={WORDS_IX} />);
    const inner = html.replace(/^<h2[^>]*>/, "").replace(/<\/h2>$/, "");
    expect(accessibleText(inner)).toBe("");
    // Y sin split, ese mismo interior SÍ se lee: la diferencia es real, no un artefacto del helper.
    const plano = renderToStaticMarkup(<HeadingBlock title={FRASE} />);
    expect(accessibleText(plano.replace(/^<h2[^>]*>/, "").replace(/<\/h2>$/, ""))).toBe(FRASE);
  });

  it("[quote] mismo contrato, y la cita sigue siendo legible", () => {
    const html = renderToStaticMarkup(<QuoteBlock text={FRASE} cite="Proverbio" ix={WORDS_IX} />);
    expect(html).toContain(`aria-label="${FRASE}"`);
    // Lo único que queda por leer en el subárbol es la cita — las palabras están ocultas.
    expect(accessibleText(html)).toBe("— Proverbio");
  });

  it("lo que se LEE y lo que se VE son la misma cadena (salen de la misma lista)", () => {
    const html = renderToStaticMarkup(<HeadingBlock title={"  Dos   espacios  raros "} ix={WORDS_IX} />);
    const label = html.match(/aria-label="([^"]*)"/)![1];
    const visible = [...html.matchAll(/aria-hidden="true">([^<]*)<\/span>/g)]
      .map((m) => m[1])
      .join(" ");
    expect(visible).toBe(label);
    expect(label).toBe("Dos espacios raros");
  });
});
