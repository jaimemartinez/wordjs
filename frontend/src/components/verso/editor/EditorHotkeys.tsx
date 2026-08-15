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
 * el sustituto Verso de window.puckActiveEditorId). Ctrl+C/V (clipboard de bloques) y las flechas
 * de mover son de otras capas (ola posterior / DnDDriver).
 */
import React from "react";
import type { EditorHandle } from "@/lib/verso/store";
import { duplicateSelected, removeSelected } from "../overlay/actionBarCommands";
import { bypassesTypingGuard, hotkeyActionOf, TYPING_TARGET_SELECTOR } from "./hotkeyMap";

export interface VersoEditorHotkeysProps {
    handle: EditorHandle;
    /** Documento del iframe (null hasta onFrameReady) — re-engancha al cambiar. */
    frameDocument: Document | null;
    onSave?: () => void;
    onCommandPalette?: () => void;
}

export default function EditorHotkeys({ handle, frameDocument, onSave, onCommandPalette }: VersoEditorHotkeysProps) {
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
    }, [handle, frameDocument]);

    return null;
}
