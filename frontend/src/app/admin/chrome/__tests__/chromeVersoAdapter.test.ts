/**
 * GATE W52 — unificación del editor de chrome sobre Verso (documentation/verso/chrome-oracle.md).
 *
 * ANTI-DRIFT: la fuente de verdad es buildChromeEditorConfig IMPORTADO (no una copia): la
 * adaptación se compara por REFERENCIA (fields/render reutilizados del mismo objeto) y por
 * deep-equal (defaultProps), sobre la MISMA instancia de config (cada llamada crea closures
 * nuevas). Cualquier drift en tipos, defaults o campos rompe aquí antes de romper la composición
 * guardada del sitio.
 *
 * WIRING: cadena PRODUCTOR-REAL (lección fixture-vs-producer): withBlockIds + toContractData son
 * las MISMAS funciones que usa page.tsx (movidas a chromeContract.ts), el documento pasa por el
 * createEditor real de Verso con el resolutor de slots del registry adaptado, y el guardado por
 * saveChromeComposition (el seam del PUT) con el endpoint espiado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Data } from "@wordjs/puck";
import { chromeApi, type ChromePart } from "@/lib/api";
import { parseChromeData, STARTER_TEMPLATES, type ChromeData } from "@/lib/chromeData";
import { ALIGN_CLASS, GAP_CLASS } from "@/components/chrome/ChromeRow";
import { createEditor } from "@/lib/verso/store";
import type { VersoData, VersoItem } from "@/lib/verso/types";
import { buildChromeEditorConfig } from "../chromeEditorConfig";
import {
    adaptChromeComponents,
    buildChromeBlockDefinitions,
    createChromeVersoSetup,
    type LegacyChromeConfigShape,
} from "../chromeVersoAdapter";
import { saveChromeComposition, toContractData, withBlockIds } from "../chromeContract";

const PARTS: ChromePart[] = ["header", "footer", "announcement"];

const positionFor = (part: ChromePart) => (part === "announcement" ? ("announcement" as const) : undefined);

afterEach(() => {
    vi.restoreAllMocks();
});

describe("adaptación de bloques de chrome (anti-drift contra chromeEditorConfig)", () => {
    it("cada part expone EXACTAMENTE los tipos del config legacy (announcement sin ChromeNav)", () => {
        for (const part of PARTS) {
            const config = buildChromeEditorConfig(part);
            const defs = buildChromeBlockDefinitions(part);
            expect(defs.map((d) => d.type).sort()).toEqual(Object.keys(config.components).sort());
        }
        const announcement = buildChromeBlockDefinitions("announcement").map((d) => d.type);
        expect(announcement).not.toContain("ChromeNav");
        expect(buildChromeBlockDefinitions("header").map((d) => d.type)).toContain("ChromeNav");
        expect(buildChromeBlockDefinitions("footer").map((d) => d.type)).toContain("ChromeNav");
    });

    it("labels, fields (por referencia) y defaultProps (deep-equal) fieles al config legacy", () => {
        for (const part of PARTS) {
            const config = buildChromeEditorConfig(part) as unknown as LegacyChromeConfigShape;
            const defs = adaptChromeComponents(config);
            for (const def of defs) {
                const legacy = config.components[def.type];
                expect(legacy).toBeDefined();
                expect(def.label).toBe(legacy.label);
                // Reutilización por REFERENCIA: los campos son EL MISMO objeto del config legacy.
                expect(def.fields).toBe(legacy.fields);
                expect(def.defaultProps).toEqual(legacy.defaultProps ?? {});
            }
        }
    });

    it("los defaults de ChromeNav dependen del part (header horizontal / footer vertical)", () => {
        const header = buildChromeBlockDefinitions("header").find((d) => d.type === "ChromeNav");
        const footer = buildChromeBlockDefinitions("footer").find((d) => d.type === "ChromeNav");
        expect(header?.defaultProps).toEqual({ location: "header", orientation: "horizontal" });
        expect(footer?.defaultProps).toEqual({ location: "footer", orientation: "vertical" });
    });

    it("render: reutilizado por referencia salvo ChromeRow (adaptado al slot-función de Verso)", () => {
        const config = buildChromeEditorConfig("header") as unknown as LegacyChromeConfigShape;
        const defs = adaptChromeComponents(config);
        for (const def of defs) {
            const legacy = config.components[def.type];
            if (def.type === "ChromeRow") expect(def.render).not.toBe(legacy.render);
            else expect(def.render).toBe(legacy.render);
        }
    });

    it("ChromeRow (Verso) pinta el slot con las MISMAS clases literales que el legacy/público", () => {
        const row = buildChromeBlockDefinitions("header").find((d) => d.type === "ChromeRow");
        expect(row).toBeDefined();
        const slot = vi.fn(() => null);
        const render = row!.render as (props: Record<string, unknown>) => unknown;
        render({ items: slot, align: "between", gap: "md", wrap: false });
        expect(slot).toHaveBeenCalledWith(
            `wjs-chrome-row flex items-center w-full min-h-12 ${ALIGN_CLASS.between} ${GAP_CLASS.md}`,
        );
        slot.mockClear();
        render({ items: slot, align: "center", gap: "lg", wrap: true });
        expect(slot).toHaveBeenCalledWith(
            `wjs-chrome-row flex items-center w-full min-h-12 ${ALIGN_CLASS.center} ${GAP_CLASS.lg} flex-wrap`,
        );
    });

    it("resolutor de slots: items de ChromeRow es slot; el resto de props no; tipo desconocido undefined", () => {
        const setup = createChromeVersoSetup("header");
        expect(setup.isSlot("ChromeRow", "items")).toBe(true);
        expect(setup.isSlot("ChromeRow", "align")).toBe(false);
        expect(setup.isSlot("ChromeLogo", "size")).toBe(false);
        expect(setup.isSlot("NoExiste", "items")).toBeUndefined();
    });

    it("el setup expone el root wrapper del config legacy por referencia (C09)", () => {
        for (const part of PARTS) {
            const setup = createChromeVersoSetup(part);
            expect(typeof setup.RootWrapper).toBe("function");
            expect(setup.componentMap.ChromeRow).toBe(setup.registry.get("ChromeRow")!.render);
        }
    });
});

describe("round-trip por el motor Verso (starter → createEditor → contrato)", () => {
    it("las 3 composiciones starter sobreviven byte-iguales y válidas tras pasar por el store", () => {
        for (const part of PARTS) {
            const setup = createChromeVersoSetup(part);
            const stamped = withBlockIds(STARTER_TEMPLATES[part]);
            const handle = createEditor({
                initialData: stamped as unknown as VersoData,
                isSlot: setup.isSlot,
            });
            const contract = toContractData(handle.getData() as unknown as Data);
            // Deep-equal contra lo cargado: la normalización de Verso no pierde ni reordena nada.
            expect(contract).toEqual(stamped);
            const parsed = parseChromeData(contract, { source: "editor", position: positionFor(part) });
            expect(parsed.errors).toEqual([]);
            expect(parsed.ok).toBe(true);
            handle.destroy();
        }
    });

    it("editar y anidar por transacciones produce SIEMPRE un contrato válido; undo notifica onChange", () => {
        const setup = createChromeVersoSetup("header");
        const stamped = withBlockIds(STARTER_TEMPLATES.header);
        const seen: VersoData[] = [];
        const handle = createEditor({
            initialData: stamped as unknown as VersoData,
            isSlot: setup.isSlot,
            onChange: (d) => seen.push(d),
        });

        // Insertar un ChromeButton DENTRO del ChromeRow del starter (slot items) con sus defaults.
        const rowId = (stamped.content[0].props as { id: string }).id;
        const buttonDef = setup.registry.get("ChromeButton")!;
        const item: VersoItem = {
            type: "ChromeButton",
            props: { ...(buttonDef.defaultProps as Record<string, unknown>), id: "ChromeButton-test-1" } as VersoItem["props"],
        };
        expect(handle.transact((tx) => tx.insertNode(item, rowId, "items", 0))).toBe(true);
        expect(seen).toHaveLength(1);

        // Editar una prop (el camino del panel de campos).
        expect(
            handle.transact((tx) => tx.setProps("ChromeButton-test-1", { label: "Contacto", href: "/contacto" })),
        ).toBe(true);
        expect(seen).toHaveLength(2);

        const contract = toContractData(seen[1] as unknown as Data);
        const parsed = parseChromeData(contract, { source: "editor" });
        expect(parsed.errors).toEqual([]);
        const row = contract.content[0].props as { items: Array<{ type: string; props: Record<string, unknown> }> };
        expect(row.items[0]).toEqual({
            type: "ChromeButton",
            props: { label: "Contacto", href: "/contacto", variant: "primary", id: "ChromeButton-test-1" },
        });

        // Undo → onChange de nuevo, y el contrato vuelve al estado tras la inserción.
        expect(handle.undo()).toBe(true);
        expect(seen).toHaveLength(3);
        const afterUndo = toContractData(seen[2] as unknown as Data);
        expect((afterUndo.content[0].props as { items: unknown[] }).items).toHaveLength(3);
        handle.destroy();
    });

    it("invariante del dirty (C03): baseline = serialización VERSO inicial; editar+deshacer vuelve al MISMO string", () => {
        // La normalización emite `id` primero en nodos sin slots (byte-distinto del crudo, deep-igual):
        // el baseline DEBE calcularse sobre handle.getData() (el onInit del editor), no sobre el
        // crudo estampado — si no, «sin guardar» queda en falso positivo permanente (cazado en
        // navegador). Este test pinea la propiedad que el dirty de page.tsx necesita.
        const setup = createChromeVersoSetup("header");
        const stamped = withBlockIds(STARTER_TEMPLATES.header);
        const emitted: VersoData[] = [];
        const handle = createEditor({
            initialData: stamped as unknown as VersoData,
            isSlot: setup.isSlot,
            onChange: (d) => emitted.push(d),
        });
        const baseline = JSON.stringify(toContractData(handle.getData() as unknown as Data));
        const logoId = ((stamped.content[0].props as { items: Array<{ props: { id: string } }> }).items[0].props).id;
        handle.transact((tx) => tx.setProps(logoId, { size: "lg" }));
        expect(JSON.stringify(toContractData(emitted[0] as unknown as Data))).not.toBe(baseline);
        handle.undo();
        expect(JSON.stringify(toContractData(emitted[1] as unknown as Data))).toBe(baseline);
        handle.destroy();
    });

    it("toContractData recorta a EXACTAMENTE { root, content } (jamás zones ni extras)", () => {
        const dirty = {
            root: { props: { a: 1 }, extraRootKey: true },
            content: [],
            zones: { "x:items": [] },
            somethingElse: 1,
        } as unknown as Data;
        const contract = toContractData(dirty);
        expect(Object.keys(contract).sort()).toEqual(["content", "root"]);
        expect(Object.keys(contract.root)).toEqual(["props"]);
        expect(contract.root.props).toEqual({ a: 1 });
    });
});

describe("wiring del guardado (endpoint espiado)", () => {
    const contract: ChromeData = withBlockIds(STARTER_TEMPLATES.header);

    it("saveChromeComposition llama al PUT con (part, contrato) EXACTOS", async () => {
        const save = vi.fn().mockResolvedValue({ part: "header", saved: true });
        await saveChromeComposition("header", contract, save);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith("header", contract);
    });

    it("el default ES chromeApi.save (PUT /api/v1/chrome/:part) — nada más se interpone", async () => {
        const spy = vi.spyOn(chromeApi, "save").mockResolvedValue({ part: "footer", saved: true });
        await saveChromeComposition("footer", contract);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith("footer", contract);
    });

    it("un fallo del endpoint se propaga al llamador (page.tsx conserva su catch de errors[])", async () => {
        const err = Object.assign(new Error("chrome_invalid"), { errors: [{ code: "CHROME_UNSAFE_HREF" }] });
        const save = vi.fn().mockRejectedValue(err);
        await expect(saveChromeComposition("header", contract, save)).rejects.toBe(err);
    });
});
