/**
 * PREAJUSTES DEL SITIO — LA FRONTERA DE ESCRITURA (F9-E).
 *
 * `sitePresets.ts` (probado en ix-site-presets.test.ts) es la frontera de LECTURA. Esto prueba la de
 * ESCRITURA: lo que la pantalla de Ajustes puede y NO puede meter en `wjs_ix_presets`.
 *
 * Y al final está el gate decisivo de la ola, expresado sobre el dato: editar un preajuste cambia el
 * CSS de las páginas que lo usan y NO CAMBIA NI UN BYTE de su `_puck_data`. Si eso fallase, el
 * diseño estaría mal, no el código.
 */
import { describe, expect, it } from "vitest";
import {
    collectIxSpecs,
    compileIxPage,
    ixCtxFromSite,
    ixFreePresetId,
    ixPresetDelete,
    ixPresetDuplicate,
    ixPresetSave,
    ixPresetSlug,
    ixPresetToSpec,
    ixPresetUsage,
    ixSpecToBody,
    parseSiteIxPresets,
    serializeSiteIxPresets,
    IX_MAX_SITE_PRESETS,
    IX_PRESET_NAME_MAX,
    type IxCatalog,
    type IxTrack,
} from "../index";

const TRACK: IxTrack = {
    target: { kind: "children" },
    steps: [
        { at: 0, set: { opacity: 0, y: 20 }, ease: "out" },
        { at: 100, set: { opacity: 1, y: 0 } },
    ],
    stagger: { each: 80 },
};

const draft = (name: string) => ({ name, trigger: { on: "view" as const, once: true }, tracks: [TRACK] });

/** Alta que DEBE salir bien; devuelve el catálogo nuevo. */
function create(catalog: IxCatalog, name: string): IxCatalog {
    const r = ixPresetSave(catalog, draft(name));
    if (!r.ok) throw new Error(`el alta debería haber salido bien: ${r.error}`);
    return r.catalog;
}

/* ------------------------------------------------------------------ */

describe("ids: legibles, estables y libres", () => {
    it("el nombre se convierte en un slug sin acentos ni símbolos", () => {
        expect(ixPresetSlug("Aparecer Tarjetás")).toBe("aparecer-tarjetas");
        expect(ixPresetSlug("  ¡Hola, mundo!  ")).toBe("hola-mundo");
        expect(ixPresetSlug("Título — con «rayas»")).toBe("titulo-con-rayas");
    });

    it("un nombre del que no queda nada utilizable no produce un id vacío", () => {
        expect(ixFreePresetId("日本語", [])).toBe("preajuste");
        expect(ixFreePresetId("", [])).toBe("preajuste");
    });

    it("dos preajustes con el mismo nombre no se pisan", () => {
        expect(ixFreePresetId("Cascada", [])).toBe("cascada");
        expect(ixFreePresetId("Cascada", ["cascada"])).toBe("cascada-2");
        expect(ixFreePresetId("Cascada", ["cascada", "cascada-2"])).toBe("cascada-3");
    });
});

describe("alta y edición", () => {
    it("un alta nace con rev 1 y con el cuerpo ya normalizado", () => {
        const cat = create({}, "Aparecer tarjetas");
        const p = cat["aparecer-tarjetas"];
        expect(p.rev).toBe(1);
        expect(p.name).toBe("Aparecer tarjetas");
        expect(p.tracks[0].stagger).toEqual({ each: 80 });
    });

    it("cada guardado SUBE la rev, aunque el cuerpo no cambie", () => {
        // `rev` entra en el hash del CSS: si no subiera, el navegador podría servir la hoja vieja y
        // el admin creería que su edición no ha hecho nada.
        let cat = create({}, "Cascada");
        for (const expected of [2, 3, 4]) {
            const r = ixPresetSave(cat, { id: "cascada", ...draft("Cascada") });
            expect(r.ok).toBe(true);
            cat = (r as { catalog: IxCatalog }).catalog;
            expect(cat.cascada.rev).toBe(expected);
        }
    });

    it("cambiar el NOMBRE no mueve el id: los bloques guardan el id", () => {
        const cat = create({}, "Cascada");
        const r = ixPresetSave(cat, { id: "cascada", ...draft("Otro nombre completamente") });
        expect(r.ok).toBe(true);
        const next = (r as { catalog: IxCatalog }).catalog;
        expect(Object.keys(next)).toEqual(["cascada"]);
        expect(next.cascada.name).toBe("Otro nombre completamente");
    });

    it("el nombre es obligatorio y se acota", () => {
        expect(ixPresetSave({}, draft("   "))).toEqual({
            ok: false,
            error: "El preajuste necesita un nombre.",
        });
        const r = ixPresetSave({}, draft("N".repeat(400)));
        expect(r.ok).toBe(true);
        const name = Object.values((r as { catalog: IxCatalog }).catalog)[0].name;
        expect(name).toHaveLength(IX_PRESET_NAME_MAX);
    });

    it("el espacio `sys:` está RESERVADO: un preajuste de sitio no puede suplantar a uno del sistema", () => {
        const r = ixPresetSave({}, { id: "sys:fade-up", ...draft("Suplantador") });
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.error).toContain("sys:");
        // Y tampoco por la puerta de atrás del serializador: el lector lo descarta igual.
        const smuggled = parseSiteIxPresets(
            JSON.stringify([{ id: "sys:fade-up", name: "x", trigger: { on: "load" }, tracks: [TRACK], rev: 9 }]),
        );
        expect(smuggled).toEqual({});
    });

    it("un id inválido se rechaza con su motivo, no en silencio", () => {
        const r = ixPresetSave({}, { id: "MAYÚSCULAS Y ESPACIOS", ...draft("x") });
        expect(r.ok).toBe(false);
    });

    it("un cuerpo que no anima nada se rechaza (nunca un preajuste inerte en la lista)", () => {
        const r = ixPresetSave({}, {
            name: "Vacío",
            trigger: { on: "view", once: true },
            tracks: [{ target: { kind: "self" }, steps: [{ at: 0, set: {} }, { at: 100, set: {} }] }],
        });
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.error).toContain("no anima nada");
    });

    it("el tope del sitio corta las ALTAS pero nunca las ediciones", () => {
        let cat: IxCatalog = {};
        for (let i = 0; i < IX_MAX_SITE_PRESETS; i++) cat = create(cat, `Preajuste ${i}`);
        expect(Object.keys(cat)).toHaveLength(IX_MAX_SITE_PRESETS);
        expect(ixPresetSave(cat, draft("Uno más")).ok).toBe(false);
        // Editar uno de los que ya hay sigue funcionando: si no, un sitio lleno quedaría congelado.
        expect(ixPresetSave(cat, { id: "preajuste-0", ...draft("Preajuste 0 editado") }).ok).toBe(true);
    });
});

describe("borrado y duplicado", () => {
    it("borrar quita solo el suyo y no muta el catálogo original", () => {
        const cat = create(create({}, "Uno"), "Dos");
        const next = ixPresetDelete(cat, "uno");
        expect(Object.keys(next)).toEqual(["dos"]);
        expect(Object.keys(cat).sort()).toEqual(["dos", "uno"]);
    });

    it("borrar lo que no existe no es un error", () => {
        const cat = create({}, "Uno");
        expect(ixPresetDelete(cat, "no-existe")).toBe(cat);
    });

    it("duplicar da un id NUEVO y arranca su propia numeración de revisiones", () => {
        const cat = create({}, "Cascada");
        const r = ixPresetDuplicate(cat, "cascada");
        expect(r.ok).toBe(true);
        const next = (r as { catalog: IxCatalog; id: string }).catalog;
        const id = (r as { id: string }).id;
        expect(id).not.toBe("cascada");
        expect(next[id].name).toBe("Cascada (copia)");
        expect(next[id].rev).toBe(1);
        expect(next[id].tracks).toEqual(cat.cascada.tracks);
    });
});

describe("el puente con el panel del bloque", () => {
    it("preajuste ↔ IxSpec ida y vuelta, sin perder nada", () => {
        const cat = create({}, "Cascada");
        const spec = ixPresetToSpec(cat.cascada);
        expect(spec.v).toBe(1);
        const body = ixSpecToBody(spec)!;
        expect(body.trigger).toEqual(cat.cascada.trigger);
        expect(body.tracks).toEqual(cat.cascada.tracks);
    });

    it("un borrador sin pistas no vuelve", () => {
        expect(ixSpecToBody({ v: 1 })).toBeNull();
        expect(ixSpecToBody(null)).toBeNull();
    });
});

describe("lo que se guarda es lo que se vuelve a leer", () => {
    it("serializar y volver a parsear devuelve el MISMO catálogo", () => {
        const cat = create(create({}, "Uno"), "Dos");
        expect(parseSiteIxPresets(serializeSiteIxPresets(cat))).toEqual(cat);
    });

    it("y el texto guardado es un ARRAY ordenado por id (byte-estable entre guardados iguales)", () => {
        const a = create(create({}, "Zeta"), "Alfa");
        const b = create(create({}, "Alfa"), "Zeta");
        expect(serializeSiteIxPresets(a)).toBe(serializeSiteIxPresets(b));
        expect(JSON.parse(serializeSiteIxPresets(a)).map((p: { id: string }) => p.id)).toEqual([
            "alfa",
            "zeta",
        ]);
    });
});

describe("recuento de usos (aviso antes de borrar — riesgo R6)", () => {
    const page = {
        content: [
            { type: "Heading", props: { id: "a", ix: { v: 1, preset: "cascada" } } },
            {
                type: "Section",
                props: {
                    id: "s",
                    children: [
                        { type: "Card", props: { id: "b", ix: { v: 1, preset: "cascada" } } },
                        { type: "Card", props: { id: "c", ix: { v: 1, preset: "otro" } } },
                    ],
                },
            },
            // Un bloque DESVINCULADO ya tiene su propio cuerpo: borrar el preajuste no le afecta, así
            // que no cuenta como uso.
            { type: "Text", props: { id: "d", ix: { v: 1, tracks: [TRACK] } } },
        ],
    };

    it("cuenta las referencias por id, a cualquier profundidad", () => {
        const usage = ixPresetUsage(page);
        expect(usage.get("cascada")).toBe(2);
        expect(usage.get("otro")).toBe(1);
    });

    it("acumula entre documentos (el sitio entero, no una página)", () => {
        const usage = ixPresetUsage(page);
        ixPresetUsage(page, usage);
        expect(usage.get("cascada")).toBe(4);
    });

    it("un `_puck_data` que no se entiende no revienta el recuento", () => {
        for (const bad of [null, undefined, 0, "x", {}, { content: "no-array" }]) {
            expect(ixPresetUsage(bad).size).toBe(0);
        }
    });
});

/* ------------------------------------------------------------------ */
/* EL GATE DE F9-E                                                     */
/* ------------------------------------------------------------------ */

describe("gate F9-E — editar un preajuste propaga SIN tocar `_puck_data`", () => {
    /** Tres páginas distintas, las tres con un bloque enlazado al MISMO preajuste. */
    const pages = [
        { content: [{ type: "Heading", props: { id: "h1", title: "Uno", ix: { v: 1, preset: "cascada" } } }] },
        { content: [{ type: "Card", props: { id: "c1", ix: { v: 1, preset: "cascada" } } }] },
        {
            content: [
                { type: "Section", props: { id: "s1", children: [{ type: "Card", props: { id: "c2", ix: { v: 1, preset: "cascada" } } }] } },
            ],
        },
    ];

    it("(a) el CSS cambia, (b) el hash cambia, (c) el documento no se toca", () => {
        // Los bytes EXACTOS de los tres documentos, antes de nada.
        const before = pages.map((p) => JSON.stringify(p));

        const v1 = create({}, "Cascada");
        const cssV1 = pages.map((p) => compileIxPage(collectIxSpecs(p), ixCtxFromSite(v1)));

        // El admin edita el preajuste en Ajustes: otra curva, otro desplazamiento.
        const edited = ixPresetSave(v1, {
            id: "cascada",
            name: "Cascada",
            trigger: { on: "scrub" },
            tracks: [{ target: { kind: "self" }, steps: [{ at: 0, set: { y: 60 } }, { at: 100, set: { y: -60 } }] }],
        });
        expect(edited.ok).toBe(true);
        const v2 = (edited as { catalog: IxCatalog }).catalog;
        const cssV2 = pages.map((p) => compileIxPage(collectIxSpecs(p), ixCtxFromSite(v2)));

        for (let i = 0; i < pages.length; i++) {
            // (a) las tres páginas emiten CSS nuevo…
            expect(cssV1[i].css, `página ${i}`).not.toBe(cssV2[i].css);
            expect(cssV2[i].css).toContain("translate3d(0px,60px,0)");
            // (b) …con una clase nueva, así que el navegador no puede servir la hoja vieja…
            expect(cssV1[i].units[0].cls).not.toBe(cssV2[i].units[0].cls);
            // (c) …y el documento está intacto, byte a byte. Este es el punto entero del diseño.
            expect(JSON.stringify(pages[i])).toBe(before[i]);
        }
    });

    it("subir SOLO la rev ya invalida el caché, aunque el movimiento sea idéntico", () => {
        const v1 = create({}, "Cascada");
        const v2 = (ixPresetSave(v1, { id: "cascada", ...draft("Cascada") }) as { catalog: IxCatalog }).catalog;
        expect(v2.cascada.rev).toBe(v1.cascada.rev + 1);
        const a = compileIxPage(collectIxSpecs(pages[0]), ixCtxFromSite(v1));
        const b = compileIxPage(collectIxSpecs(pages[0]), ixCtxFromSite(v2));
        expect(a.units[0].cls).not.toBe(b.units[0].cls);
    });

    it("borrar el preajuste deja los bloques VISIBLES y quietos, nunca una página rota", () => {
        const v1 = create({}, "Cascada");
        const empty = ixPresetDelete(v1, "cascada");
        const page = compileIxPage(collectIxSpecs(pages[0]), ixCtxFromSite(empty));
        expect(page.css).toBe("");
        expect(page.units).toHaveLength(0);
        expect(page.runtime).toHaveLength(0);
    });
});
