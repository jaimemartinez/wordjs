/**
 * Verso — deriva un corpus de FORMAS a partir del corpus REAL de producción.
 *
 * El corpus real (documentation/verso/corpus/corpus.json) está gitignorado a propósito: es
 * contenido de clientes sin anonimizar. Su ausencia, sin embargo, hacía que el gate de round-trip
 * se SALTARA en CI, y un skip silencioso es indistinguible de un pase. Este script produce un
 * fixture commiteable que conserva lo único que el gate necesita —la ESTRUCTURA— y borra el
 * significado:
 *
 *  · claves, orden de claves y anidamiento: intactos (el round-trip compara byte a byte, así que
 *    el orden ES el contrato);
 *  · `type` e `id`: literales (son vocabulario nuestro, no datos del cliente), salvo los `type` de
 *    plugins PRIVADOS de cliente, que se renombran a `Sample<Sufijo>` (ver TYPE RENAME abajo);
 *  · cualquier otra cadena: letras→'x'/'X' y dígitos→'0' carácter a carácter, preservando toda la
 *    puntuación, el markup y el unicode — precisamente los bytes que hacen interesante un
 *    round-trip (comillas, `<em>`, entidades, emojis) sobreviven; las palabras no.
 *
 * Uso: node scripts/verso-corpus-anonymize.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = resolve("documentation/verso/corpus/corpus.json");
const OUT = resolve("frontend/src/lib/verso/__tests__/fixtures/corpus.shapes.json");
const GITIGNORE = resolve(".gitignore");
const MAX_ENTRIES = 45;

if (!existsSync(SRC)) {
  console.error(`No hay corpus real en ${SRC} — expórtalo con scripts/verso-corpus-export.mjs`);
  process.exit(1);
}

const scrubString = (s) => s.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? "X" : "x")).replace(/[0-9]/g, "0");
const KEEP_VERBATIM = new Set(["type", "id"]);

// --- TYPE RENAME ------------------------------------------------------------------------------
// Un plugin PRIVADO (de cliente o interno) no puede dejar su nombre en un fixture COMMITEADO: sus
// bloques se emiten como `Sample<Sufijo>`, que describe la forma sin nombrar a nadie. Los prefijos
// se LEEN de .gitignore (el único sitio donde esas rutas se nombran legítimamente) en vez de
// escribirse aquí, para que este script tampoco reintroduzca el nombre ni se desincronice; se
// excluyen los slugs que SÍ tienen fuente pública en marketplace/plugins (su vocabulario es
// nuestro, aunque su copia instalada esté ignorada).
const pascal = (slug) =>
  slug.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
const PRIVATE_PREFIXES = (existsSync(GITIGNORE) ? readFileSync(GITIGNORE, "utf8") : "")
  .split(/\r?\n/)
  .map((line) => /^backend\/plugins\/([A-Za-z0-9._-]+)\/?$/.exec(line.trim()))
  .filter(Boolean)
  .map((m) => m[1])
  .filter((slug) => !existsSync(resolve("marketplace/plugins", slug)))
  .map(pascal)
  .sort((a, b) => b.length - a.length); // el prefijo más largo gana
// Sufijos en español del corpus original → su equivalente neutro; el resto pasa tal cual.
const SUFFIX_ALIASES = { Portafolio: "Portfolio", Proceso: "Process", Testimonio: "Testimonial" };
const renameType = (t) => {
  const p = PRIVATE_PREFIXES.find((x) => t.startsWith(x) && t.length > x.length);
  if (!p) return t;
  const rest = t.slice(p.length);
  return `Sample${SUFFIX_ALIASES[rest] ?? rest}`;
};

function scrub(node, key) {
  if (typeof node === "string") {
    if (key === "type") return renameType(node);
    return KEEP_VERBATIM.has(key) ? node : scrubString(node);
  }
  if (Array.isArray(node)) return node.map((v) => scrub(v, key));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = scrub(v, k); // orden de claves preservado
    return out;
  }
  return node;
}

const typesOf = (node, acc = new Set()) => {
  if (Array.isArray(node)) node.forEach((n) => typesOf(n, acc));
  else if (node && typeof node === "object") {
    if (typeof node.type === "string") acc.add(renameType(node.type));
    Object.values(node).forEach((v) => typesOf(v, acc));
  }
  return acc;
};

const raw = JSON.parse(readFileSync(SRC, "utf8"));
const entries = (raw.entries ?? []).map((e) => ({ ...e, versoData: e.versoData ?? e.puckData }));

// Cobertura codiciosa: el subconjunto más pequeño que toca cada tipo de bloque al menos una vez,
// para que el fixture commiteado ejercite las 51 formas sin arrastrar los 1,2 MB del original.
const covered = new Set();
const picked = [];
const ranked = [...entries].sort((a, b) => typesOf(b.versoData).size - typesOf(a.versoData).size);
for (const e of ranked) {
  const t = typesOf(e.versoData);
  if ([...t].some((x) => !covered.has(x)) && picked.length < MAX_ENTRIES) {
    picked.push(e);
    t.forEach((x) => covered.add(x));
  }
}

const out = {
  note: "DERIVADO — formas reales, contenido anonimizado. Regenerar: node scripts/verso-corpus-anonymize.mjs",
  generatedFrom: `${entries.length} documentos reales`,
  blockTypes: [...covered].sort(),
  entries: picked.map((e) => ({
    id: e.id,
    type: e.type,
    status: e.status,
    versoData: scrub(e.versoData),
  })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n", "utf8");
console.log(`escrito ${OUT}`);
console.log(`  entradas: ${out.entries.length} de ${entries.length} · tipos cubiertos: ${covered.size}`);
