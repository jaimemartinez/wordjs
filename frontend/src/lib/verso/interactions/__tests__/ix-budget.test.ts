/**
 * PRESUPUESTO DE BYTES DEL RUNTIME (§7.3 de la spec) — hasta ahora solo se afirmaba el CSS.
 *
 * Los topes de la spec: isla de eventos ≤ 2 KB gz, chunk de scrub ≤ 4 KB gz. El troceado en sí
 * (qué navegador descarga qué) ya está clavado por los tests de la matriz de disparadores; lo que
 * NO había era un assert que se pusiera rojo si el runtime engorda por encima del presupuesto.
 *
 * CÓMO SE MIDE: se empaqueta CADA entrada con esbuild, minificada y gzip, igual que viajaría.
 * esbuild es una devDependency DECLARADA: este import se apoyaba en que llegase como transitiva de
 * vitest, y esa suposición se rompió en cuanto un bump de dependencias reorganizó el árbol — el
 * type-check caía con "Cannot find module 'esbuild'" en toda rama que tocara las dependencias. `./scrub` se marca external en la isla
 * porque en producción es un chunk aparte (dynamic import) que Chrome y Safari 26+ nunca bajan.
 * Se mide NUESTRO código, no el envoltorio de chunk de Next (que es del framework y ~constante):
 * el número exacto del navegador variará unos bytes, pero el presupuesto se vigila donde crece.
 */
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, "../runtime");

async function gzBundleSize(entry: string, external: string[] = []): Promise<number> {
  const result = await build({
    entryPoints: [resolve(runtimeDir, entry)],
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    external,
    logLevel: "silent",
  });
  return gzipSync(Buffer.from(result.outputFiles[0].contents)).byteLength;
}

describe("presupuestos de bytes del runtime (gz, minificado)", () => {
  it("la isla de eventos (runtime/index + host + targets) cabe en 2 KB", async () => {
    const size = await gzBundleSize("index.ts", ["./scrub"]);
    expect(size, `isla de eventos: ${size} bytes gz`).toBeLessThanOrEqual(2048);
  });

  it("el chunk de scrub cabe en 4 KB", async () => {
    const size = await gzBundleSize("scrub.ts");
    expect(size, `chunk de scrub: ${size} bytes gz`).toBeLessThanOrEqual(4096);
  });

  it("el scrubber del panel (canvas) cabe en 4 KB", async () => {
    // No viaja al público (solo el editor lo carga), pero comparte IR y técnica con el chunk de
    // scrub: si engorda de golpe es que alguien metió algo que no es del scrubber.
    const size = await gzBundleSize("scrubber.ts");
    expect(size, `scrubber del panel: ${size} bytes gz`).toBeLessThanOrEqual(4096);
  });
});
