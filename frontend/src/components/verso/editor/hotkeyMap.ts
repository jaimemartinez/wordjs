/**
 * Verso — mapa puro de atajos del editor (F3). El componente de hotkeys (dentro de
 * VersoEditor.tsx) solo enruta eventos por aquí; la decisión es testeable en node.
 *
 * Contrato (paridad con EditorHotkeys del PuckEditor actual, checklist W03 — núcleo):
 *   Ctrl/Cmd+S → save          (funciona TAMBIÉN mientras se escribe)
 *   Ctrl/Cmd+K → palette       (ídem — abre desde cualquier foco, incluso el iframe)
 *   Ctrl/Cmd+Z → undo          · Ctrl/Cmd+Shift+Z o Ctrl/Cmd+Y → redo
 *   Delete     → delete        · Ctrl/Cmd+D → duplicate
 * Todo salvo save/palette se ignora mientras se escribe (input/textarea/select/contenteditable/
 * .ProseMirror) o hay edición inline activa — ese guard lo aplica el llamador con
 * `bypassesTypingGuard`. Ctrl+C/V (clipboard de bloques) y las flechas de mover son de otras
 * capas: el clipboard llega en una ola posterior; mover por teclado ya vive en el DnDDriver (M /
 * Ctrl+Shift+Flecha).
 */

export type HotkeyAction = "save" | "palette" | "undo" | "redo" | "delete" | "duplicate";

export interface HotkeyEventLike {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

/** Acción del atajo, o null si el evento no es un atajo del editor. */
export function hotkeyActionOf(e: HotkeyEventLike): HotkeyAction | null {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "s") return "save";
    if (mod && key === "k") return "palette";
    if (mod && key === "z" && !e.shiftKey) return "undo";
    if ((mod && key === "z" && e.shiftKey) || (mod && key === "y")) return "redo";
    if (e.key === "Delete") return "delete";
    if (mod && key === "d") return "duplicate";
    return null;
}

/** save y palette actúan incluso con el foco en un campo (mismo orden de guardas que hoy). */
export function bypassesTypingGuard(action: HotkeyAction): boolean {
    return action === "save" || action === "palette";
}

/** Selector de "está escribiendo" — el mismo del EditorHotkeys actual. */
export const TYPING_TARGET_SELECTOR =
    'input, textarea, select, [contenteditable="true"], .ProseMirror';
