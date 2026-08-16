import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GATE DE SINCRONÍA HOST_MODULES (F4 — la jornada que las 3 propuestas de arquitectura pidieron).
 *
 * La superficie host que un bundle de plugin puede importar vive en DOS listas mantenidas A MANO:
 *  - backend/scripts/build-plugin.js  → `const HOST_MODULES = [...]` (fuente de verdad de COMPILACIÓN:
 *    reescribe cada import `@/x` a `globalThis.WordJS.host['x']`, y FALLA el build si el módulo no
 *    está en la lista).
 *  - frontend/src/lib/pluginBundleLoader.ts → `const HOST_MODULES = {...}` (fuente de verdad de
 *    RUNTIME: inyecta cada módulo real del host en window.WordJS.host).
 *
 * Divergencia = build roto (clave solo en el loader) o bloque que falla EN RUNTIME, en producción,
 * silenciosamente hasta el primer intento de carga (clave solo en el builder). No había ningún test
 * que fallara automáticamente si divergían (f0-audit-core.md, riesgo documentado) — este lo es: parsea
 * las DOS listas REALES (los ficheros fuente, no copias) y falla si difieren en cualquier dirección.
 *
 * También verifica coherencia INTERNA del loader: cada clave de su HOST_MODULES debe respaldarse en un
 * `import * as h_x from '@/<clave>'` del propio fichero (una clave apuntando a otro módulo del que
 * dice exponer sería una deriva que la igualdad de listas no ve), y viceversa.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const LOADER_PATH = path.resolve(REPO_ROOT, "frontend/src/lib/pluginBundleLoader.ts");
const BUILDER_PATH = path.resolve(REPO_ROOT, "backend/scripts/build-plugin.js");

/** Quita comentarios de línea y de bloque, para que un módulo citado en prosa no cuente como clave. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Claves del objeto `const HOST_MODULES: ... = { 'clave': valor, ... }` del loader. */
function loaderHostModuleKeys(src: string): string[] {
    const m = src.match(/const HOST_MODULES\s*:[^=]*=\s*\{([\s\S]*?)\n\}/);
    if (!m) throw new Error("no se encontró `const HOST_MODULES = {...}` en pluginBundleLoader.ts");
    const body = stripComments(m[1]);
    const keys: string[] = [];
    for (const key of body.matchAll(/['"]([^'"]+)['"]\s*:/g)) keys.push(key[1]);
    return keys;
}

/** Elementos del array `const HOST_MODULES = [ 'clave', ... ]` del builder. */
function builderHostModuleKeys(src: string): string[] {
    const m = src.match(/const HOST_MODULES\s*=\s*\[([\s\S]*?)\]/);
    if (!m) throw new Error("no se encontró `const HOST_MODULES = [...]` en build-plugin.js");
    const body = stripComments(m[1]);
    const keys: string[] = [];
    for (const key of body.matchAll(/['"]([^'"]+)['"]/g)) keys.push(key[1]);
    return keys;
}

/** Rutas de los `import * as h_x from '@/<ruta>'` del loader (los respaldos reales de sus claves). */
function loaderHostImports(src: string): string[] {
    const paths: string[] = [];
    for (const m of stripComments(src).matchAll(/import \* as h_\w+ from ['"]@\/([^'"]+)['"]/g)) {
        paths.push(m[1]);
    }
    return paths;
}

describe("HOST_MODULES — sincronía build-plugin.js ↔ pluginBundleLoader.ts (gate de CI)", () => {
    const loaderSrc = fs.readFileSync(LOADER_PATH, "utf8");
    const builderSrc = fs.readFileSync(BUILDER_PATH, "utf8");
    const loaderKeys = loaderHostModuleKeys(loaderSrc);
    const builderKeys = builderHostModuleKeys(builderSrc);

    it("las dos listas exponen EXACTAMENTE las mismas claves (divergencia = build roto o fallo runtime silencioso)", () => {
        const loaderSet = new Set(loaderKeys);
        const builderSet = new Set(builderKeys);
        const onlyInLoader = loaderKeys.filter((k) => !builderSet.has(k));
        const onlyInBuilder = builderKeys.filter((k) => !loaderSet.has(k));
        expect(
            { soloEnLoader: onlyInLoader, soloEnBuilder: onlyInBuilder },
            "HOST_MODULES divergentes: añade la clave que falte en el otro lado " +
            "(backend/scripts/build-plugin.js Y frontend/src/lib/pluginBundleLoader.ts deben listar lo mismo)",
        ).toEqual({ soloEnLoader: [], soloEnBuilder: [] });
    });

    it("ninguna lista tiene claves duplicadas", () => {
        expect(new Set(loaderKeys).size).toBe(loaderKeys.length);
        expect(new Set(builderKeys).size).toBe(builderKeys.length);
    });

    it("el parser encontró una lista plausible (regresión del propio gate: vacío = parser roto, no sincronía)", () => {
        // Hoy son 13 claves; el suelo evita que un refactor que rompa el regex pase como 'listas iguales (vacías)'.
        expect(loaderKeys.length).toBeGreaterThanOrEqual(10);
        expect(builderKeys.length).toBeGreaterThanOrEqual(10);
        expect(loaderKeys).toContain("lib/api");
        expect(builderKeys).toContain("lib/api");
    });

    it("cada clave del loader está respaldada por su import real del host (y no hay imports huérfanos)", () => {
        const imports = loaderHostImports(loaderSrc).sort();
        expect(imports).toEqual([...loaderKeys].sort());
    });
});
