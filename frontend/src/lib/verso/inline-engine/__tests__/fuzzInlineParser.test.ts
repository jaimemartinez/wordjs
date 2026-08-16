/**
 * Verso F6 — FUZZING del parser del motor de texto inline (parseRichHtml /
 * projectHtmlToBlocks / serializeDoc) con HTML hostil.
 *
 * Generador determinista (mulberry32, semilla fija — el PRNG compartido del
 * programa). HTML hostil cubierto:
 *  - tags rotos: sin cerrar, cierres huérfanos, `<>`, `<` suelto, comentarios
 *    sin cerrar, doctype/PI, atributos con comillas desbalanceadas,
 *  - entidades: con nombre (conocidas y desconocidas), decimales, hex,
 *    fuera de rango (&#x110000;), truncadas,
 *  - scripts/estilos/iframes/svg (contenido que se descarta ENTERO),
 *  - atributos venenosos: onclick/onerror, href="javascript:", style con
 *    expresiones, atributos gigantes,
 *  - anidamiento profundo, listas anidadas, tablas, tags desconocidos.
 *
 * INVARIANTES:
 *  1. El parser JAMÁS lanza (tolerante por contrato).
 *  2. La salida serializada está SIEMPRE en el subset del motor:
 *     p / br / strong / em / a[href,target,rel] / ul / ol / li — ningún otro
 *     tag puede aparecer en serializeDoc, y jamás atributos on*.
 *  3. TEXTO PRESERVADO: cada centinela colocado por el generador en posición
 *     de texto FUERA de un elemento drop-with-content sobrevive al parse
 *     (contención vía la misma normalización del guard anti-pérdida real).
 *  4. Idempotencia (el gate documentado del parser):
 *     parse(serialize(parse(x))) deep-equal parse(x).
 *
 * VOLUMEN: los 10.000 casos del encargo corren por DEFECTO (~1s medido, muy
 * por debajo del presupuesto de 60s/fichero — sin recorte). VERSO_FUZZ_FULL=1
 * multiplica x5 para barridos largos.
 */

import { describe, expect, test } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { mulberry32 } from "@/components/verso/lab/labFixtures";
import { parseRichHtml } from "../parse";
import { serializeDoc } from "../serialize";
import { docGuardText, normalizeGuardText } from "../guard";

const FUZZ_CASES_DEFAULT = 10_000; // el encargo completo, por defecto (~1s medido)
const FUZZ_CASES = process.env.VERSO_FUZZ_FULL === "1" ? FUZZ_CASES_DEFAULT * 5 : FUZZ_CASES_DEFAULT;
const FUZZ_SEED = 0x1e51;
const TEST_TIMEOUT_MS = 300_000;

type Rng = () => number;
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const int = (rng: Rng, n: number): number => Math.floor(rng() * n);
const chance = (rng: Rng, p: number): boolean => rng() < p;

/* ------------------------------------------------------------------ */
/* Generador de HTML hostil con centinelas rastreados                   */
/* ------------------------------------------------------------------ */

/** Tags cuyo contenido el parser descarta ENTERO (espejo del DROP_WITH_CONTENT del parser). */
const DROP_TAGS = ["script", "style", "textarea", "select", "iframe", "svg", "template", "noscript"] as const;

const NORMAL_TAGS = [
  "p", "div", "span", "b", "i", "strong", "em", "u", "s", "code", "mark",
  "h1", "h2", "h3", "h6", "ul", "ol", "li", "table", "tr", "td", "th",
  "blockquote", "section", "article", "pre", "x-custom", "font",
] as const;

const VOIDISH = ["br", "img", "hr", "input", "wbr"] as const;

const POISON_ATTRS = [
  ` onclick="alert(1)"`,
  ` onerror=alert(1)`,
  ` href="javascript:alert(1)"`,
  ` style="width:expression(alert(1));background:url(javascript:x)"`,
  ` data-x="<b>no-html</b>"`,
  ` class='rota"comilla'`,
  ` a`,
  ` ="sin-nombre"`,
  // NOTA (invariante del generador): NADA de comillas desbalanceadas DENTRO de un
  // tag con `>` posterior — el tokenizador (correctamente) extiende el tag hasta la
  // siguiente comilla y engulle el contenido intermedio, así que el rastreo de
  // centinelas dejaría de ser veraz. La tolerancia a comillas rotas se cubre con
  // los tokens de BREAKAGE (un `<tag` sin `>` convierte el RESTO en texto literal,
  // que sí preserva los centinelas).
  ` target="_blank"`,
  ` target="_top"`,
  ` rel="opener"`,
] as const;

const ENTITY_SOUP = [
  "&amp;", "&lt;", "&gt;", "&quot;", "&nbsp;", "&mdash;",
  "&desconocida;", "&#65;", "&#x41;", "&#x110000;", "&#999999999;", "&#;", "&#x;", "&amp", "&",
] as const;

// Roturas SEGURAS para el rastreo: no pueden engullir texto posterior.
const BREAKAGE = [
  "</div>", "</p>", "</strong>", "</noexiste>", "<>", "<!-- ok -->", "<!DOCTYPE html>", "<?xml daño?>",
] as const;

/**
 * Roturas ENGULLIDORAS — un `<tag` sin `>` (el tag se extiende hasta el
 * siguiente `>` del input), una comilla sin cerrar dentro de un tag, o un
 * comentario sin `-->`: el tokenizador (correctamente) consume el contenido
 * posterior como parte del tag/comentario. Solo pueden ir AL FINAL del caso,
 * después del último centinela rastreado — si fueran hermanas intermedias, el
 * rastreo de "kept" mentiría.
 */
const TAIL_BREAKAGE = [
  "< suelto", "<!--comentario", "</", "<b", `<a href="sin-cierre`, `<td href='mixta">resto`,
  "<style>engullido hasta el final", "<script>alert(1) sin cierre", "<svg><rect>",
] as const;

interface HostileCase {
  html: string;
  /** Centinelas colocados FUERA de regiones drop-with-content: deben sobrevivir. */
  kept: string[];
}

function makeHostileHtml(rng: Rng, caseIdx: number): HostileCase {
  const out: string[] = [];
  const kept: string[] = [];
  let sentinelN = 0;
  let budget = 30 + int(rng, 40);

  const sentinel = (inDropped: boolean): string => {
    const s = `S${caseIdx}x${++sentinelN}z`;
    if (!inDropped) kept.push(s);
    return s;
  };

  const emitText = (inDropped: boolean): void => {
    const r = rng();
    if (r < 0.5) {
      out.push(` ${sentinel(inDropped)} `);
    } else if (r < 0.7) {
      out.push(pick(rng, ENTITY_SOUP));
    } else if (r < 0.8) {
      out.push(`${pick(rng, ENTITY_SOUP)}${sentinel(inDropped)}${pick(rng, ENTITY_SOUP)}`);
    } else if (r < 0.9) {
      out.push("   \n\t ");
    } else {
      out.push(`texto${int(rng, 100)}`);
    }
  };

  const emitAttrs = (): string => {
    let s = "";
    const n = int(rng, 3);
    for (let i = 0; i < n; i++) s += pick(rng, POISON_ATTRS);
    if (chance(rng, 0.1)) s += ` big="${"y".repeat(2000 + int(rng, 3000))}"`;
    return s;
  };

  const emitNode = (depth: number, inDropped: boolean): void => {
    if (budget <= 0) return;
    budget -= 1;
    const r = rng();
    if (r < 0.35 || depth > 8) {
      emitText(inDropped);
      return;
    }
    if (r < 0.45) {
      out.push(pick(rng, BREAKAGE));
      return;
    }
    if (r < 0.52) {
      const v = pick(rng, VOIDISH);
      out.push(`<${v}${emitAttrs()}${chance(rng, 0.5) ? "/" : ""}>`);
      return;
    }
    if (r < 0.6 && !inDropped) {
      // Región descartada entera: todo lo de dentro (centinelas incluidos) se
      // pierde a propósito. SIEMPRE cerrada: el tokenizador salta del primer
      // `<tag` al PRIMER `</tag` del input (no hay emparejamiento), así que un
      // drop-tag sin cerrar (o dos hermanos del mismo tag) desplaza la región
      // engullida y el rastreo de centinelas mentiría — el caso "sin cerrar"
      // se cubre en la cola (TAIL_BREAKAGE), después del último centinela.
      const t = pick(rng, DROP_TAGS);
      out.push(`<${t}${emitAttrs()}>`);
      const n = 1 + int(rng, 3);
      for (let i = 0; i < n; i++) emitNode(depth + 1, true);
      out.push(`</${t}>`);
      return;
    }
    const tag = pick(rng, NORMAL_TAGS);
    out.push(`<${tag}${emitAttrs()}>`);
    const n = 1 + int(rng, 3);
    for (let i = 0; i < n; i++) emitNode(depth + 1, inDropped);
    if (chance(rng, 0.8)) out.push(`</${tag}>`); // 20%: tag sin cerrar
  };

  const top = 1 + int(rng, 6);
  for (let i = 0; i < top; i++) emitNode(0, false);

  // Cola engullidora (sin centinelas rastreados a partir de aquí).
  if (chance(rng, 0.3)) {
    out.push(pick(rng, TAIL_BREAKAGE));
    if (chance(rng, 0.5)) out.push(` resto${int(rng, 10)} <div>final</div>`);
  }

  // Con drop-tags sin cerrar, TODO lo posterior se engulle: para que `kept` sea
  // veraz, el caso se corta en el primer drop-tag sin cierre. Más simple:
  // detectar y recalcular no vale la pena — el generador solo deja drop-tags
  // sin cerrar al FINAL del caso con prob. baja; si el html tras el último
  // drop-tag abierto contiene centinelas, se retiran de kept.
  const html = out.join("");
  const keptFinal = kept.filter((s) => sentinelSurvivesDropSwallow(html, s));
  return { html, kept: keptFinal };
}

/**
 * ¿El centinela queda ENGULLIDO por un drop-tag abierto sin cierre? Espejo
 * conservador del comportamiento del tokenizador: al abrir un drop-tag salta
 * hasta su `</tag`; si no existe, engulle hasta el final. Aquí basta con
 * comprobar, para cada aparición del centinela, que no hay un drop-tag abierto
 * sin su cierre correspondiente ANTES de esa posición.
 */
function sentinelSurvivesDropSwallow(html: string, sentinel: string): boolean {
  const at = html.indexOf(sentinel);
  if (at < 0) return false;
  const lower = html.toLowerCase();
  for (const t of DROP_TAGS) {
    let from = 0;
    for (;;) {
      const open = lower.indexOf(`<${t}`, from);
      if (open < 0 || open > at) break;
      const close = lower.indexOf(`</${t}`, open);
      if (close < 0 || close > at) return false; // engullido
      from = close + 1;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Subset permitido en la emisión canónica                              */
/* ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "a", "ul", "ol", "li"]);
// La emisión canónica escapa TODO `<` de texto/atributos (escapeText/escapeAttr), así que
// cada `<` literal de la salida abre un tag real: el regex es un parser suficiente aquí.
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
// Forma canónica exacta de los atributos de <a> (D11): href siempre; target+rel SOLO juntos.
const A_ATTRS_RE = /^ href="[^"]*"( target="_blank" rel="noopener noreferrer")?$/;

/** Violaciones del subset canónico: tag fuera de contrato o atributos fuera de forma. */
function subsetViolations(serialized: string): string[] {
  const bad: string[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(serialized)) !== null) {
    const [, closing, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      bad.push(`tag <${closing}${rawTag}>`);
      continue;
    }
    if (closing === "/") {
      if (attrs !== "") bad.push(`cierre con atributos </${rawTag}${attrs}>`);
      continue;
    }
    if (tag === "a") {
      if (!A_ATTRS_RE.test(attrs)) bad.push(`atributos de <a> fuera de forma: "${attrs}"`);
    } else if (attrs !== "") {
      bad.push(`atributos en <${rawTag}>: "${attrs}"`);
    }
  }
  return bad;
}

/* ------------------------------------------------------------------ */
/* Suite                                                                */
/* ------------------------------------------------------------------ */

describe(`fuzz parser inline-engine (${FUZZ_CASES} casos, seed 0x${FUZZ_SEED.toString(16)})`, () => {
  test(
    "HTML hostil: jamás throw, salida en el subset, texto preservado, idempotente",
    { timeout: TEST_TIMEOUT_MS },
    () => {
      const rng = mulberry32(FUZZ_SEED);
      for (let i = 0; i < FUZZ_CASES; i++) {
        const { html, kept } = makeHostileHtml(rng, i);

        let doc: ReturnType<typeof parseRichHtml>;
        let serialized: string;
        try {
          doc = parseRichHtml(html);
          serialized = serializeDoc(doc);
        } catch (err) {
          throw new Error(`caso ${i}: el parser lanzó (${String(err)})\nhtml: ${clip(html)}`);
        }

        // 2. Subset canónico: ningún tag fuera de contrato y ningún atributo
        //    fuera de la forma exacta de <a> (con lo que un on*/style/src en un
        //    TAG real es imposible; en TEXTO escapado es contenido legítimo).
        const bad = subsetViolations(serialized);
        if (bad.length > 0) {
          throw new Error(`caso ${i}: fuera del subset: ${bad.join(" · ")}\nsalida: ${clip(serialized)}`);
        }

        // 3. Texto preservado: cada centinela colocado fuera de regiones
        //    descartadas sobrevive (misma normalización que el guard real).
        const guardText = normalizeGuardText(docGuardText(doc));
        for (const s of kept) {
          if (!guardText.includes(s)) {
            throw new Error(`caso ${i}: centinela PERDIDO "${s}"\nhtml: ${clip(html)}\nsalida: ${clip(serialized)}`);
          }
        }

        // 4. Idempotencia del pipeline (el gate documentado del parser).
        const reparsed = parseRichHtml(serialized);
        if (!isDeepStrictEqual(reparsed, doc)) {
          expect(reparsed, `caso ${i}: parse(serialize(parse(x))) != parse(x)\nhtml: ${clip(html)}`).toEqual(doc);
        }
      }
    },
  );
});

function clip(s: string): string {
  return s.length > 1200 ? `${s.slice(0, 1200)}…(${s.length})` : s;
}
