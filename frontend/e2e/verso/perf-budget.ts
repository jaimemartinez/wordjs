/**
 * Verso F6 — ORIGEN ÚNICO de los presupuestos de perf del editor.
 *
 * Estos tres números vivían DOS veces: como literales en perf.spec.ts (lo único
 * que decidía algo) y en backend/f0-performance-budgets.json#versoEditorMilliseconds
 * (un fichero comprometido y revisado que NADIE leía). Dos copias libres de
 * separarse: apretar el JSON no apretaba nada, y aflojar el literal del spec no se
 * veía en el fichero donde se revisan los presupuestos. Aquí se lee el JSON y el
 * spec consume ESTO, así que el número existe una sola vez.
 *
 * Las palancas de entorno (VERSO_PERF_*_MS) siguen vivas porque ci.yml planea
 * calibrarlas en el runner real, pero SOLO PUEDEN APRETAR. Una palanca más floja
 * que el presupuesto comprometido lanza aquí mismo, en la recolección del spec,
 * en vez de aceptarse en silencio: ese era el agujero real que quedaba abierto —
 * una variable de job podía dejar el presupuesto comprometido en papel mojado
 * mientras el fichero revisado seguía diciendo 16ms. Subir un techo es una edición
 * VISIBLE de f0-performance-budgets.json, nunca una variable de entorno.
 *
 * Este módulo no importa nada de Playwright a propósito: el gate de backend
 * (backend/scripts/verify-f6-migration.ts) lo CARGA y lo EJECUTA para comprobar
 * la propiedad «el spec no puede exigir un techo más flojo que el comprometido».
 */
import fs from "node:fs";
import path from "node:path";

/** Ruta, relativa a la raíz del repo, del presupuesto comprometido. */
export const BUDGET_FILE = "backend/f0-performance-budgets.json";
/** Sección de ese fichero que gobierna el editor. */
export const BUDGET_SECTION = "versoEditorMilliseconds";

export interface VersoPerfBudget {
    /** Techo del p95 de input-latency (keydown → fin del transact), en ms. */
    inputP95: number;
    /** Techo del p95 del coste de un transact del store, en ms. */
    transactionP95: number;
    /** Techo del TTI del fixture de 500 bloques, en ms. */
    timeToInteractive: number;
}

export interface PerfLever {
    /** Clave dentro de versoEditorMilliseconds. */
    key: keyof VersoPerfBudget;
    /** Variable de entorno que puede APRETARLA (nunca aflojarla). */
    env: string;
    /** Nombre humano, para los mensajes de error. */
    label: string;
}

/**
 * La tabla de palancas. El gate la enumera desde aquí y la compara por IGUALDAD con
 * las claves del JSON: añadir un techo comprometido sin palanca, o borrar una palanca
 * que el JSON sigue declarando, pone el gate en rojo.
 */
export const PERF_LEVERS: readonly PerfLever[] = [
    { key: "inputP95", env: "VERSO_PERF_INPUT_P95_MS", label: "input p95" },
    { key: "transactionP95", env: "VERSO_PERF_TRANSACT_P95_MS", label: "transact p95" },
    { key: "timeToInteractive", env: "VERSO_PERF_TTI_MS", label: "TTI" },
];

/**
 * Localiza el JSON comprometido subiendo desde ESTE fichero.
 *
 * No se usa process.cwd(): el spec corre con cwd=frontend/ bajo Playwright y el gate
 * lo carga con cwd=backend/, así que un cwd distinto no puede hacer que se lea otro
 * presupuesto (ni ninguno).
 */
export function budgetFilePath(): string {
    let dir = __dirname;
    for (;;) {
        const candidate = path.join(dir, ...BUDGET_FILE.split("/"));
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(
        `no se encuentra ${BUDGET_FILE} subiendo desde ${__dirname}; sin él los presupuestos del editor ` +
            "no existen y el spec no debe correr fingiendo que sí",
    );
}

/** Los techos tal y como están comprometidos, sin ninguna palanca aplicada. */
export function committedVersoPerfBudget(): VersoPerfBudget {
    const file = budgetFilePath();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const section = parsed[BUDGET_SECTION] as Record<string, unknown> | undefined;
    if (!section || typeof section !== "object") {
        throw new Error(`${BUDGET_FILE} no declara la sección ${BUDGET_SECTION}`);
    }
    const budget = {} as VersoPerfBudget;
    for (const lever of PERF_LEVERS) {
        const value = Number(section[lever.key]);
        // Un techo NaN o <=0 no es un presupuesto: toda comparación contra NaN es falsa,
        // así que el gate dejaría de hablar de rendimiento y hablaría de configuración.
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(
                `${BUDGET_FILE}#${BUDGET_SECTION}.${lever.key} = ${JSON.stringify(section[lever.key])} ` +
                    "no es un número de milisegundos positivo",
            );
        }
        budget[lever.key] = value;
    }
    return budget;
}

/**
 * Los techos que el spec va a EXIGIR: el presupuesto comprometido, apretado (nunca
 * aflojado) por las palancas de entorno.
 *
 * Lanza si una palanca intenta aflojar. Llamarla en el ámbito de módulo del spec hace
 * que ese rechazo aparezca en la recolección de Playwright — ruidoso y en rojo — en
 * lugar de convertirse en una corrida verde con un presupuesto que nadie aprobó.
 */
export function resolveVersoPerfBudget(
    env: Record<string, string | undefined> = process.env,
): VersoPerfBudget {
    const committed = committedVersoPerfBudget();
    const resolved: VersoPerfBudget = { ...committed };
    for (const lever of PERF_LEVERS) {
        const raw = env[lever.env];
        if (raw === undefined || String(raw).trim() === "") continue;
        const override = Number(raw);
        if (!Number.isFinite(override) || override <= 0) {
            throw new Error(
                `${lever.env}=${JSON.stringify(raw)} no es un número de milisegundos positivo; ` +
                    `un techo NaN no mide ${lever.label}, solo hace ilegible el veredicto`,
            );
        }
        if (override > committed[lever.key]) {
            throw new Error(
                `${lever.env}=${override}ms es MÁS FLOJO que el presupuesto comprometido ` +
                    `${BUDGET_FILE}#${BUDGET_SECTION}.${lever.key}=${committed[lever.key]}ms. ` +
                    "Una palanca de entorno solo puede APRETAR: si el techo real de este runner es otro, " +
                    `súbelo en ${BUDGET_FILE}, que es donde se revisa, no en una variable del job.`,
            );
        }
        resolved[lever.key] = override;
    }
    return resolved;
}
