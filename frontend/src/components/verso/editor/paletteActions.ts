/**
 * Verso — acciones de la CommandPalette ⌘K (F3, checklist W29): módulo PURO y testeable en node.
 *
 * Espec: `paletteActions` del PuckEditor legacy (L1448-1611) — mismos ids, mismos glifos MSym,
 * mismos strings ES fuente (trStr) y mismos hints. Las acciones dependientes de selección la leen
 * PEREZOSAMENTE del handle en el momento de ejecutar (la paleta puede quedar abierta a través de
 * cambios de selección; sin selección = no-op), igual que el legacy leía el store interno.
 *
 * Diferencias deliberadas y documentadas respecto al legacy:
 *  - move-up / move-down: NUEVAS filas (encargo F3 ola 3) sobre moveSelected de actionBarCommands
 *    — el legacy solo las tenía en el ActionBar, no en la paleta.
 *  - outline ("Ver estructura"): NUEVA — navegación a la vista Estructura del rail (encargo).
 *  - import: valida la forma y sustituye el documento vía `handle.replaceData` = UNA entrada de
 *    historia (Ctrl+Z restaura, el contrato del `recordHistory:true` + migrate del legacy;
 *    normalize.ts de Verso ya absorbe zones legacy fail-soft — supersede a migrate, ver W40).
 *  - media / revisiones / comentarios / a11y / guías (F3 ola 4): filas REALES con los ids/glifos/
 *    labels del legacy; revisiones y comentarios solo con `hasPage` (mismo gate `pageId` del
 *    legacy).
 *  - save-symbol (F3 ola 5, W35): fila REAL con el id/glifo/label del legacy (PuckEditor
 *    L1571-1593); la serialización + strip de props resueltas vive en `saveSelectedAsSymbol`
 *    (testeable en node, symbolsApi inyectado) — el componente pone toast/alert e idioma.
 */
import { SYMBOL_BLOCK_TYPE } from "@/lib/symbols";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoData, VersoItem } from "@/lib/verso/types";
import { subtreeToItem } from "@/lib/verso/commands";
import { duplicateSelected, moveSelected, removeSelected } from "../overlay/actionBarCommands";
import { copyStylesFromSelected, pasteStylesToSelected } from "./blockClipboard";

/** Misma forma que el PaletteAction del legacy (CommandPalette.tsx L29). */
export interface PaletteAction {
    id: string;
    ms: string;
    label: string;
    hint?: string;
    run: () => void;
}

export interface VersoPaletteActionDeps {
    handle: EditorHandle;
    /** trStr ya ligado al idioma activo. */
    tr: (s: string) => string;
    status: string;
    /** true si el editor tiene onSave (fila Guardar/Publicar). */
    hasSave: boolean;
    /** true si hay previewSlug (fila Vista previa). */
    hasPreview: boolean;
    save: () => void;
    preview: () => void;
    /** Descarga el JSON del documento (el componente pone el blob/anchor). */
    exportDoc: (data: VersoData) => void;
    /** Flujo de import (file picker + confirm + importDataIntoHandle) — vive en el componente. */
    importDoc: () => void;
    toast: (msg: string) => void;
    /** Deselecciona y abre el panel derecho sobre los campos ROOT (ajustes de página). */
    openPageSettings: () => void;
    /** Abre la vista Estructura (outline) del rail. */
    openOutline: () => void;
    replayAnims: () => void;
    /** true si el registro existe (pageId) — gate de revisiones/comentarios, como el legacy. */
    hasPage: boolean;
    /** Abre la biblioteca de medios (también la única vía en móvil, como el legacy). */
    openMedia: () => void;
    openRevisions: () => void;
    openComments: () => void;
    /** Abre el drawer de accesibilidad Y lanza el análisis (mismo run del legacy). */
    openA11y: () => void;
    toggleGuides: () => void;
    /** "Guardar bloque como símbolo" (W35) — el componente cablea saveSelectedAsSymbol + toast/alert. */
    saveSymbol: () => void;
}

/** Props inyectadas por el resolver SSR que JAMÁS se persisten en un símbolo (legacy L1580-1583). */
export const SYMBOL_RESOLVED_PROPS = ["resolvedPosts", "resolvedFiltered", "resolvedSymbolItems"] as const;

export interface SaveSymbolIO {
    /** symbolsApi.create (inyectado para test). */
    create: (name: string, items: VersoItem[]) => Promise<unknown>;
    /** Label ya traducido del tipo de bloque (registry def.label → tr). */
    labelOf: (type: string) => string;
    /** Sello horario del nombre — inyectable en tests (default: hora local HH:MM). */
    stamp?: () => string;
}

/**
 * W35 — "Guardar bloque como símbolo": serializa el SUBTREE seleccionado (hijos de slots
 * incluidos — `subtreeToItem`, la MISMA forma cruda Puck que el resolver de símbolos consume),
 * descarta las props resueltas server-side del nivel raíz (mismo alcance que el legacy, que solo
 * limpiaba `sel.props`) y lo crea vía symbolsApi con el nombre `<label> · <HH:MM>` del legacy.
 *  - "saved"   → creado (el llamador toastea "Símbolo guardado");
 *  - "skipped" → sin selección o la selección ya ES un Symbol (mismo guard del legacy);
 *  - "error"   → create() falló (el llamador alerta "No se pudo guardar el símbolo").
 */
export async function saveSelectedAsSymbol(
    handle: EditorHandle,
    io: SaveSymbolIO,
): Promise<"saved" | "skipped" | "error"> {
    const id = handle.getState().selection.nodeId;
    const doc = handle.getDoc();
    if (!id || !doc.nodes[id]) return "skipped";
    const item = subtreeToItem(doc, id);
    if (item.type === SYMBOL_BLOCK_TYPE) return "skipped";
    const props = { ...item.props };
    for (const k of SYMBOL_RESOLVED_PROPS) delete (props as Record<string, unknown>)[k];
    const stamp = io.stamp
        ? io.stamp()
        : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    try {
        await io.create(`${io.labelOf(item.type)} · ${stamp}`, [{ type: item.type, props }]);
        return "saved";
    } catch {
        return "error";
    }
}

/**
 * Import de página (JSON): mismo criterio de validación que el legacy
 * (`objeto con content: []`) y sustitución completa vía replaceData — UNA entrada de undo.
 */
export function importDataIntoHandle(handle: EditorHandle, parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (!Array.isArray((parsed as { content?: unknown }).content)) return false;
    return handle.replaceData(parsed as VersoData);
}

export function buildVersoPaletteActions(d: VersoPaletteActionDeps): PaletteAction[] {
    const acts: PaletteAction[] = [];
    const selectedId = () => d.handle.getState().selection.nodeId;

    if (d.hasSave) {
        acts.push({
            id: "save",
            ms: "cloud_done",
            hint: "Ctrl+S",
            label: d.status === "draft" ? d.tr("Guardar") : d.tr("Publicar"),
            run: () => d.save(),
        });
    }
    if (d.hasPreview) {
        acts.push({ id: "preview", ms: "open_in_new", label: d.tr("Vista previa"), run: () => d.preview() });
    }
    acts.push({
        id: "export",
        ms: "arrow_downward",
        label: d.tr("Exportar página (JSON)"),
        run: () => d.exportDoc(d.handle.getData()),
    });
    acts.push({
        id: "import",
        ms: "arrow_upward",
        label: d.tr("Importar página (JSON)"),
        run: () => d.importDoc(),
    });
    // Misma posición que el legacy (tras import): también la única vía del TELÉFONO a la
    // biblioteca — el rail que la abre es md-only y el FAB móvil abre esta paleta.
    acts.push({
        id: "media",
        ms: "image",
        label: d.tr("Biblioteca de medios"),
        run: () => d.openMedia(),
    });
    acts.push({
        id: "copy-styles",
        ms: "palette",
        label: d.tr("Copiar estilos del bloque"),
        run: () => {
            if (copyStylesFromSelected(d.handle)) d.toast(d.tr("Estilos copiados"));
        },
    });
    acts.push({
        id: "paste-styles",
        ms: "edit",
        label: d.tr("Pegar estilos en el bloque"),
        run: () => {
            pasteStylesToSelected(d.handle);
        },
    });
    acts.push({
        id: "duplicate",
        ms: "content_copy",
        hint: "Ctrl+D",
        label: d.tr("Duplicar bloque"),
        run: () => {
            const id = selectedId();
            if (id) duplicateSelected(d.handle, id);
        },
    });
    acts.push({
        id: "delete-block",
        ms: "delete",
        hint: "Supr",
        label: d.tr("Eliminar bloque"),
        run: () => {
            const id = selectedId();
            if (id) removeSelected(d.handle, id);
        },
    });
    acts.push({
        id: "move-up",
        ms: "arrow_upward",
        label: d.tr("Subir bloque"),
        run: () => {
            const id = selectedId();
            if (id) moveSelected(d.handle, id, -1);
        },
    });
    acts.push({
        id: "move-down",
        ms: "arrow_downward",
        label: d.tr("Bajar bloque"),
        run: () => {
            const id = selectedId();
            if (id) moveSelected(d.handle, id, 1);
        },
    });
    acts.push({
        id: "page-settings",
        ms: "settings",
        label: d.tr("Ajustes de página"),
        run: () => d.openPageSettings(),
    });
    if (d.hasPage) {
        acts.push({
            id: "revisions",
            ms: "history",
            label: d.tr("Historial de revisiones"),
            run: () => d.openRevisions(),
        });
    }
    acts.push({
        id: "outline",
        ms: "layers",
        label: d.tr("Ver estructura"),
        run: () => d.openOutline(),
    });
    acts.push({
        id: "replay",
        ms: "play_arrow",
        label: d.tr("Reproducir las animaciones de entrada"),
        run: () => d.replayAnims(),
    });
    // Misma posición que el legacy: tras replay, antes de comments (PuckEditor L1571).
    acts.push({
        id: "save-symbol",
        ms: "collections",
        label: d.tr("Guardar bloque como símbolo"),
        run: () => d.saveSymbol(),
    });
    if (d.hasPage) {
        acts.push({
            id: "comments",
            ms: "forum",
            label: d.tr("Comentarios de revisión"),
            run: () => d.openComments(),
        });
    }
    acts.push({
        id: "a11y",
        ms: "check_circle",
        label: d.tr("Auditoría de accesibilidad"),
        run: () => d.openA11y(),
    });
    acts.push({
        id: "guides",
        ms: "grid_view",
        label: d.tr("Guías y contornos"),
        run: () => d.toggleGuides(),
    });
    return acts;
}
