/**
 * F3 ola 3 — patrones (checklist W19/W27):
 *
 *  - Insertar un patrón (built-in o de usuario) = UNA transacción = UNA entrada de undo.
 *  - buildVersoPatternItems: defaults reales del registry + overrides del patrón + ids frescos;
 *    tipos no registrados se saltan; slots del patrón se construyen recursivamente y los slots
 *    declarados que falten se materializan como [].
 *  - Patrones de usuario: MISMA clave (wjs_user_patterns), MISMA forma {id,name,items,createdAt}
 *    y MISMO cap 30 que el legacy (interop cross-editor); insertar regenera TODOS los ids.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry } from "@/lib/verso/registry";
import type { VersoItem } from "@/lib/verso/types";
import {
    PATTERNS,
    USER_PATTERNS_KEY,
    USER_PATTERNS_MAX,
    buildVersoPatternItems,
    deleteUserPattern,
    insertVersoPattern,
    insertVersoUserPattern,
    loadUserPatterns,
    saveDocAsPattern,
    type Pattern,
} from "../patterns";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, String(v));
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
});

function makeRegistry(): BlockRegistry {
    const r = createBlockRegistry();
    r.register([
        {
            type: "Heading",
            fields: { title: { type: "text" }, level: { type: "select", options: [] } },
            defaultProps: { title: "Un título", level: "h2", look: {} },
            render: () => null,
        },
        {
            type: "Text",
            fields: { content: { type: "textarea" } },
            defaultProps: { content: "..." },
            render: () => null,
        },
        {
            type: "Button",
            fields: { label: { type: "text" }, href: { type: "text" }, align: { type: "text" } },
            defaultProps: { label: "Botón", href: "#", align: "left" },
            render: () => null,
        },
        {
            type: "Section",
            fields: { children: { type: "slot" } },
            // OJO: defaultProps SIN children — el builder debe materializar el slot declarado.
            defaultProps: {},
            render: () => null,
        },
    ]);
    return r;
}

function makeHandle(registry: BlockRegistry, content: VersoItem[] = []) {
    return createEditor({
        initialData: { content, root: { props: {} } },
        isSlot: makeSlotResolver(registry),
    });
}

function collectIds(item: VersoItem, out: string[] = []): string[] {
    out.push(item.props.id);
    for (const v of Object.values(item.props)) {
        if (Array.isArray(v)) {
            for (const c of v) {
                if (c && typeof c === "object" && (c as VersoItem).type) collectIds(c as VersoItem, out);
            }
        }
    }
    return out;
}

beforeEach(() => {
    store.clear();
});

describe("buildVersoPatternItems", () => {
    it("mergea defaults del registry + overrides del patrón + id fresco; salta tipos no registrados", () => {
        const registry = makeRegistry();
        // El patrón "intro" REAL del catálogo compartido: Heading + Text + Button.
        const intro = PATTERNS.find((p) => p.id === "intro") as Pattern;
        const items = buildVersoPatternItems(intro, registry);
        expect(items.map((i) => i.type)).toEqual(["Heading", "Text", "Button"]);
        // Override del patrón gana al default; el default no pisado sobrevive.
        expect(items[0].props.title).toBe("Un título que engancha");
        expect(items[0].props.look).toEqual({});
        expect(items[2].props.label).toBe("Saber más");
        // Ids frescos y únicos.
        const ids = items.map((i) => i.props.id);
        expect(new Set(ids).size).toBe(ids.length);

        // "hero" usa el tipo Hero, NO registrado aquí → se salta (paridad buildPatternBlocks).
        const hero = PATTERNS.find((p) => p.id === "hero") as Pattern;
        expect(buildVersoPatternItems(hero, registry)).toEqual([]);
    });

    it("construye slots del patrón recursivamente y materializa los slots declarados que falten", () => {
        const registry = makeRegistry();
        const nested: Pattern = {
            id: "nested",
            name: "Anidado",
            icon: "fa-grip",
            description: "x",
            blocks: [
                { type: "Section", slots: { children: [{ type: "Text", props: { content: "hijo" } }] } } as Pattern["blocks"][number],
                { type: "Section" },
            ],
        };
        const items = buildVersoPatternItems(nested, registry);
        expect((items[0].props.children as VersoItem[])[0].props.content).toBe("hijo");
        // Sin slots en el patrón NI en defaultProps → el slot declarado se materializa vacío.
        expect(items[1].props.children).toEqual([]);
    });
});

describe("insertar patrón = UNA entrada de historia", () => {
    it("insertVersoPattern añade todos los bloques al final y UN solo undo los revierte", () => {
        const registry = makeRegistry();
        const existing: VersoItem = { type: "Text", props: { id: "t-0", content: "ya estaba" } };
        const handle = makeHandle(registry, [existing]);
        const intro = PATTERNS.find((p) => p.id === "intro") as Pattern;

        expect(insertVersoPattern(handle, registry, intro)).toBe(true);
        expect(handle.getData().content.map((i) => i.type)).toEqual(["Text", "Heading", "Text", "Button"]);

        expect(handle.undo()).toBe(true); // UNA entrada revierte el patrón entero
        expect(handle.getData().content.map((i) => i.props.id)).toEqual(["t-0"]);
        expect(handle.canUndo()).toBe(false);
    });

    it("un patrón sin bloques disponibles no abre transacción", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        const hero = PATTERNS.find((p) => p.id === "hero") as Pattern; // Hero no registrado
        expect(insertVersoPattern(handle, registry, hero)).toBe(false);
        expect(handle.canUndo()).toBe(false);
    });
});

describe("patrones de usuario (clave/forma/cap compartidos con el legacy)", () => {
    it("saveDocAsPattern captura la página viva con la forma {id,name,items,createdAt}", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "captura" } }]);
        const saved = saveDocAsPattern(handle, "  Mi landing  ");
        expect(saved).not.toBeNull();
        expect(saved?.name).toBe("Mi landing"); // trim, como el legacy
        expect(saved?.id).toMatch(/^user-/);
        expect(typeof saved?.createdAt).toBe("string");
        expect(saved?.items).toEqual(handle.getData().content);

        // Persiste bajo la MISMA clave que lee el editor legacy.
        const raw = JSON.parse(store.get(USER_PATTERNS_KEY) as string);
        expect(Array.isArray(raw)).toBe(true);
        expect(raw[0].id).toBe(saved?.id);
        expect(Object.keys(raw[0]).sort()).toEqual(["createdAt", "id", "items", "name"]);
        // Y loadUserPatterns (el del legacy, reutilizado) lo lee.
        expect(loadUserPatterns()[0]).toEqual(saved);
    });

    it("lienzo vacío → null (no guarda patrones vacíos)", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        expect(saveDocAsPattern(handle, "Vacía")).toBe(null);
        expect(loadUserPatterns()).toEqual([]);
    });

    it("cap 30: el guardado 31 descarta el más viejo y el más nuevo queda primero", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "x" } }]);
        for (let i = 1; i <= USER_PATTERNS_MAX + 1; i++) {
            expect(saveDocAsPattern(handle, `P${i}`)).not.toBeNull();
        }
        const list = loadUserPatterns();
        expect(list.length).toBe(USER_PATTERNS_MAX);
        expect(list[0].name).toBe(`P${USER_PATTERNS_MAX + 1}`); // más nuevo primero
        expect(list.some((p) => p.name === "P1")).toBe(false); // el más viejo cayó
    });

    it("insertVersoUserPattern regenera ids (repetir jamás colisiona) y es UNA entrada de undo", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "base" } }]);
        const saved = saveDocAsPattern(handle, "Base");
        expect(saved).not.toBeNull();
        if (!saved) return;

        expect(insertVersoUserPattern(handle, registry, saved)).toBe(true);
        expect(insertVersoUserPattern(handle, registry, saved)).toBe(true);
        const allIds = handle.getData().content.flatMap((i) => collectIds(i));
        expect(allIds.length).toBe(3);
        expect(new Set(allIds).size).toBe(3); // t-1 + 2 copias con ids frescos

        handle.undo(); // revierte SOLO la segunda inserción, entera
        expect(handle.getData().content.length).toBe(2);
    });

    it("insertVersoUserPattern salta tipos no registrados (paridad legacy)", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry);
        const p = {
            id: "user-x",
            name: "Mixto",
            items: [
                { type: "PluginRetirado", props: { id: "p-1" } },
                { type: "Text", props: { id: "t-9", content: "vivo" } },
            ],
            createdAt: new Date().toISOString(),
        };
        expect(insertVersoUserPattern(handle, registry, p)).toBe(true);
        expect(handle.getData().content.map((i) => i.type)).toEqual(["Text"]);
    });

    it("deleteUserPattern (el del legacy, reutilizado) borra por id", () => {
        const registry = makeRegistry();
        const handle = makeHandle(registry, [{ type: "Text", props: { id: "t-1", content: "x" } }]);
        const a = saveDocAsPattern(handle, "A");
        const b = saveDocAsPattern(handle, "B");
        expect(loadUserPatterns().length).toBe(2);
        const rest = deleteUserPattern(a?.id ?? "");
        expect(rest.length).toBe(1);
        expect(rest[0].id).toBe(b?.id);
        expect(loadUserPatterns().length).toBe(1);
    });
});
