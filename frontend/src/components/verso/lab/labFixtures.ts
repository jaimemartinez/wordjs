/**
 * Verso Lab — fixtures del banco (PUROS: sin React, sin DOM — testeados en node).
 *
 * - `makeLabData()`: el doc de 30 bloques de siempre (movido tal cual desde
 *   verso-lab/page.tsx; es el default, ?fixture=30).
 * - `makeFixture500()`: doc DETERMINISTA de 500 bloques (?fixture=500) para el
 *   gate de rendimiento. Mezcla realista fijada por FIXTURE_500_COUNTS:
 *   40% Text (200), 25% Heading (125), 15% Card (75) = 400 hojas, y 100
 *   contenedores Section/Grid (50/50) anidados hasta EXACTAMENTE 3 niveles de
 *   contenedor (40 en raíz, 40 dentro de los de nivel 1, 20 dentro de los de
 *   nivel 2), con las hojas repartidas por PRNG entre la raíz y los 100 slots.
 *   PRNG = mulberry32 con semilla fija (FIXTURE_500_SEED) — cero Math.random:
 *   mismo seed ⇒ mismo doc byte a byte (JSON.stringify idéntico), verificado
 *   por labFixtures.test.ts.
 */

import type { VersoData, VersoItem } from "@/lib/verso/types";

/* ------------------------------------------------------------------ */
/* Constructores de items (compartidos por ambos fixtures).             */
/* ------------------------------------------------------------------ */

const heading = (id: string, title: string, level = "h2"): VersoItem => ({
    type: "Heading",
    props: { id, title, level },
});
const text = (id: string, content: string): VersoItem => ({
    type: "Text",
    props: { id, content: `<p>${content}</p>` },
});
const card = (id: string, title: string): VersoItem => ({
    type: "Card",
    props: { id, title, description: `Descripción de ${title}` },
});
const section = (id: string, pad: number, children: VersoItem[]): VersoItem => ({
    type: "Section",
    props: { id, pad, children },
});
const grid = (id: string, columns: number, children: VersoItem[]): VersoItem => ({
    type: "Grid",
    props: { id, columns, gap: 16, children },
});

/* ------------------------------------------------------------------ */
/* Fixture 30 (default) — idéntico al doc histórico del lab.            */
/* ------------------------------------------------------------------ */

/**
 * El doc histórico del lab (?fixture=30), byte-idéntico al que vivía en
 * page.tsx. NOTA: su comentario original decía "30 bloques exactos (contados)"
 * pero el conteo real es 27 (9 raíz + G1+6 hijos + G2/H4/T4 + S3/T6 + G3 +
 * S4/C8 + G4 + T5/C7 — verificado por labFixtures.test.ts); se preserva TAL
 * CUAL porque el encargo exige mantener el doc actual, y la clave de query
 * sigue siendo "30" por continuidad.
 */
export function makeLabData(): VersoData {
    return {
        content: [
            heading("lab-h-top", "Verso Lab", "h1"),
            text("lab-t-top", "Banco de pruebas del núcleo F2 — canvas propio + overlay en padre."),
            section("lab-s1", 32, [
                grid("lab-g1", 3, [
                    card("lab-c1", "Alfa"),
                    card("lab-c2", "Beta"),
                    card("lab-c3", "Gamma"),
                    heading("lab-h2", "Dentro de la rejilla", "h3"),
                    text("lab-t2", "Celda de texto."),
                    card("lab-c4", "Delta"),
                ]),
            ]),
            section("lab-s2", 24, [
                grid("lab-g2", 2, [
                    section("lab-s3", 16, [
                        grid("lab-g3", 2, [
                            section("lab-s4", 8, [
                                grid("lab-g4", 1, [
                                    text("lab-t5", "Nivel 3 de anidamiento."),
                                    card("lab-c7", "Épsilon"),
                                ]),
                            ]),
                            card("lab-c8", "Zeta"),
                        ]),
                    ]),
                    text("lab-t6", "Columna derecha del nivel 1."),
                ]),
                heading("lab-h4", "Cierre de la sección", "h3"),
                text("lab-t4", "Texto de cierre."),
            ]),
            heading("lab-h6", "Bloques sueltos", "h2"),
            text("lab-t7", "Raíz, tras las secciones."),
            card("lab-c9", "Eta"),
            card("lab-c10", "Theta"),
            text("lab-t8", "Último bloque del banco."),
        ],
        root: { props: {} },
    };
}

/* ------------------------------------------------------------------ */
/* PRNG determinista (mulberry32, el mismo de verso-commands.test.ts).  */
/* ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pickInt = (rng: () => number, n: number): number => Math.floor(rng() * n);

/* ------------------------------------------------------------------ */
/* Fixture 500.                                                         */
/* ------------------------------------------------------------------ */

/** Semilla fija del fixture 500 — cambiarla cambia el doc y rompe el gate a propósito. */
export const FIXTURE_500_SEED = 0xf500;

/** Composición exacta del fixture 500 (el test la verifica tipo a tipo). */
export const FIXTURE_500_COUNTS = {
    Text: 200, // 40%
    Heading: 125, // 25%
    Card: 75, // 15%
    Section: 50, // 10%  ┐ 100 contenedores (20%)
    Grid: 50, //  10%  ┘
    total: 500,
} as const;

/** Contenedores por nivel de anidamiento (1 = hijos de la raíz). Máximo 3 niveles. */
const CONTAINERS_PER_LEVEL = [40, 40, 20] as const;

const SECTION_PADS = [8, 16, 24, 32] as const;

/**
 * Doc determinista de 500 bloques. Estructura:
 * 1. 100 contenedores (Section/Grid alternados por PRNG hasta agotar el cupo
 *    50/50): 40 en raíz, 40 colgados de un nivel-1 al azar, 20 de un nivel-2
 *    al azar — profundidad de contenedor EXACTA 3 por construcción.
 * 2. 400 hojas (200 Text / 125 Heading / 75 Card) barajadas Fisher-Yates y
 *    repartidas por PRNG entre los 101 destinos (raíz + cada slot children).
 * Ids secuenciales `f500-<n>` (deterministas). Todo consumo del PRNG ocurre
 * en orden de programa fijo ⇒ byte-determinismo.
 */
export function makeFixture500(): VersoData {
    const rng = mulberry32(FIXTURE_500_SEED);
    let n = 0;
    const nextId = (): string => `f500-${++n}`;

    /* -- 1. contenedores ------------------------------------------------ */
    let sectionsLeft: number = FIXTURE_500_COUNTS.Section;
    let gridsLeft: number = FIXTURE_500_COUNTS.Grid;
    const makeContainer = (): VersoItem => {
        // Alternancia por PRNG respetando el cupo exacto 50/50.
        const useSection = sectionsLeft > 0 && (gridsLeft === 0 || rng() < 0.5);
        if (useSection) {
            sectionsLeft -= 1;
            return section(nextId(), SECTION_PADS[pickInt(rng, SECTION_PADS.length)], []);
        }
        gridsLeft -= 1;
        return grid(nextId(), 1 + pickInt(rng, 4), []);
    };

    const rootContent: VersoItem[] = [];
    const byLevel: VersoItem[][] = [];
    for (let level = 0; level < CONTAINERS_PER_LEVEL.length; level++) {
        const created: VersoItem[] = [];
        for (let i = 0; i < CONTAINERS_PER_LEVEL[level]; i++) {
            const container = makeContainer();
            if (level === 0) {
                rootContent.push(container);
            } else {
                const parents = byLevel[level - 1];
                const parent = parents[pickInt(rng, parents.length)];
                (parent.props.children as VersoItem[]).push(container);
            }
            created.push(container);
        }
        byLevel.push(created);
    }
    const allContainers = byLevel.flat();

    /* -- 2. hojas -------------------------------------------------------- */
    const leafTypes: Array<"Text" | "Heading" | "Card"> = [
        ...Array<"Text">(FIXTURE_500_COUNTS.Text).fill("Text"),
        ...Array<"Heading">(FIXTURE_500_COUNTS.Heading).fill("Heading"),
        ...Array<"Card">(FIXTURE_500_COUNTS.Card).fill("Card"),
    ];
    // Fisher-Yates con el PRNG: mezcla realista y determinista.
    for (let i = leafTypes.length - 1; i > 0; i--) {
        const j = pickInt(rng, i + 1);
        [leafTypes[i], leafTypes[j]] = [leafTypes[j], leafTypes[i]];
    }

    const HEADING_LEVELS = ["h2", "h3", "h4"] as const;
    for (const leafType of leafTypes) {
        const id = nextId();
        let leaf: VersoItem;
        if (leafType === "Text") {
            leaf = text(id, `Bloque de texto ${id} del fixture de quinientos.`);
        } else if (leafType === "Heading") {
            leaf = heading(id, `Encabezado ${id}`, HEADING_LEVELS[pickInt(rng, HEADING_LEVELS.length)]);
        } else {
            leaf = card(id, `Tarjeta ${id}`);
        }
        // Destino: 0 = raíz, 1..100 = el slot children del contenedor i-1.
        const target = pickInt(rng, allContainers.length + 1);
        if (target === 0) rootContent.push(leaf);
        else (allContainers[target - 1].props.children as VersoItem[]).push(leaf);
    }

    return { content: rootContent, root: { props: {} } };
}

/** Claves de fixture aceptadas en la query del lab (?fixture=). */
export type LabFixtureKey = "30" | "500";

/** Fixtures disponibles del lab por su clave de query (?fixture=). */
export function makeFixtureData(fixture: LabFixtureKey): VersoData {
    return fixture === "500" ? makeFixture500() : makeLabData();
}
