"use client";
/**
 * Verso — capa de atajos de teclado del wrapper (F3, checklist W03 núcleo). No renderiza nada.
 *
 * Listeners keydown en fase CAPTURE en la ventana PADRE y en el contentWindow del iframe del
 * canvas — SIN POLLING: el prop `frameDocument` llega del onFrameReady del FrameController y el
 * efecto se re-engancha cuando cambia (patrón del blueprint; el AutoFrame del editor viejo
 * recargaba el iframe y obligaba a re-chequear cada 1000ms — el frame de Verso no recarga, y si
 * algún día lo hace, onFrameReady vuelve a disparar y el efecto re-engancha).
 *
 * Mapa: hotkeyMap.ts (puro, testeado). Ctrl+S / Ctrl+K actúan incluso escribiendo; el resto se
 * ignora con foco en un campo o con edición inline activa (handle.getState().inlineEditingId —
 * el sustituto Verso de window.puckActiveEditorId). Ctrl+C copia el subtree seleccionado al
 * clipboard compartido (wjs_block_clipboard — interop con el editor legacy) SOLO si no hay
 * selección de texto real (y sin preventDefault: el copy nativo sigue funcionando, paridad
 * legacy); Ctrl+V pega con ids regenerados tras la selección o al final (blockClipboard.ts,
 * UNA entrada de undo). Las flechas de mover son del DnDDriver.
 */
import React from "react";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import { duplicateSelected, removeSelected } from "../overlay/actionBarCommands";
import { copySelectedSubtree, pasteFromClipboard } from "./blockClipboard";
import { bypassesTypingGuard, hotkeyActionOf, TYPING_TARGET_SELECTOR } from "./hotkeyMap";

export interface VersoEditorHotkeysProps {
    handle: EditorHandle;
    /** Registry vivo — el pegado valida que el tipo del clipboard exista en este editor. */
    registry: BlockRegistry;
    /** Documento del iframe (null hasta onFrameReady) — re-engancha al cambiar. */
    frameDocument: Document | null;
    onSave?: () => void;
    onCommandPalette?: () => void;
}

export default function EditorHotkeys({ handle, registry, frameDocument, onSave, onCommandPalette }: VersoEditorHotkeysProps) {
    // Refs para callbacks inline sin re-enganchar los listeners.
    const onSaveRef = React.useRef(onSave);
    const onPaletteRef = React.useRef(onCommandPalette);
    React.useEffect(() => {
        onSaveRef.current = onSave;
        onPaletteRef.current = onCommandPalette;
    });

    React.useEffect(() => {
        const isTypingTarget = (t: EventTarget | null): boolean => {
            const el = t as HTMLElement | null;
            return !!(el && typeof el.closest === "function" && el.closest(TYPING_TARGET_SELECTOR));
        };

        const onKey = (e: KeyboardEvent) => {
            const action = hotkeyActionOf(e);
            if (!action) return;
            if (!bypassesTypingGuard(action)) {
                if (isTypingTarget(e.target) || handle.getState().inlineEditingId !== null) return;
            }
            switch (action) {
                case "save":
                    e.preventDefault();
                    e.stopPropagation();
                    onSaveRef.current?.();
                    return;
                case "palette":
                    e.preventDefault();
                    e.stopPropagation();
                    onPaletteRef.current?.();
                    return;
                case "undo":
                    e.preventDefault();
                    e.stopPropagation();
                    handle.undo();
                    return;
                case "redo":
                    e.preventDefault();
                    e.stopPropagation();
                    handle.redo();
                    return;
                case "delete": {
                    const id = handle.getState().selection.nodeId;
                    if (!id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    removeSelected(handle, id);
                    return;
                }
                case "duplicate": {
                    const id = handle.getState().selection.nodeId;
                    if (!id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    duplicateSelected(handle, id);
                    return;
                }
                case "copy": {
                    // No secuestrar un copy de TEXTO real (paridad legacy): la selección se lee en
                    // la ventana donde ocurrió el evento (puede ser el iframe del canvas).
                    const view = e.view ?? window;
                    const textSel = typeof view.getSelection === "function" ? view.getSelection() : null;
                    if (textSel && !textSel.isCollapsed) return;
                    // Sin preventDefault: el evento nativo sigue su curso (igual que el legacy).
                    copySelectedSubtree(handle);
                    return;
                }
                case "paste": {
                    e.preventDefault();
                    e.stopPropagation();
                    pasteFromClipboard(handle, registry);
                    return;
                }
            }
        };

        const targets: Window[] = [window];
        const frameWin = frameDocument?.defaultView;
        if (frameWin) targets.push(frameWin);
        for (const w of targets) w.addEventListener("keydown", onKey as EventListener, true);
        return () => {
            for (const w of targets) {
                try {
                    w.removeEventListener("keydown", onKey as EventListener, true);
                } catch {
                    /* ventana del iframe ya destruida */
                }
            }
        };
    }, [handle, registry, frameDocument]);

    return null;
}
