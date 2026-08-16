"use client";
/**
 * Verso — BubbleMenu PROPIO del motor de texto inline (F3.5, spec §2.2).
 *
 * Sustituye al BubbleMenu de Tiptap (react/menus). Presentacional: el estado de
 * la selección (rect + marcas activas) llega de VersoTextSurface; las acciones
 * son callbacks que aplican operaciones del motor. Anatomía de la spec:
 * - Aparece con selección NO vacía (la superficie decide `state !== null`) y
 *   se porta al `body` del documento del IFRAME (fuera del editable — la razón
 *   por la que el legacy no cierra en blur), `position: fixed` sobre el punto
 *   medio del rango; si no hay hueco arriba, debajo; clamp al viewport.
 * - Conserva el marcador `data-wjs-inline-bubble`: el detector de click-fuera
 *   lo considera «dentro» (se reutiliza sin cambios).
 * - Botones (todos con onMouseDown preventDefault para no perder la selección,
 *   activo = fondo primario, mismas clases del bubble F2): Negrita, Cursiva,
 *   Enlace (popover con input URL + checkbox «Abrir en pestaña nueva» — D9 —,
 *   Aplicar, Quitar si hay enlace), Lista, Lista numerada y Limpiar formato.
 * - Sin subrayado/tachado/color/fuente/alineación ni buscador interno: fuera
 *   del contrato F3.5 (huecos W34 documentados en la spec, jamás recorte
 *   silencioso).
 *
 * El popover de enlace se controla también IMPERATIVAMENTE (ref): Mod+K lo
 * abre y Escape lo cierra ANTES de cerrar la sesión (spec §4.2).
 */
import React from "react";
import { createPortal } from "react-dom";
import type { ActiveStates } from "@/lib/verso/inline-engine";

export interface BubbleSelectionState {
    /** Rect de la selección (coords de viewport del documento del iframe). */
    rect: { top: number; bottom: number; left: number; width: number };
    active: ActiveStates;
}

export interface VersoBubbleMenuHandle {
    /** Abre el popover de enlace (Mod+K) prefijado con el enlace activo. */
    openLinkPopover(): void;
    /** Cierra el popover si estaba abierto. Devuelve true si lo cerró. */
    closeLinkPopover(): boolean;
}

export interface VersoBubbleMenuProps {
    frameDoc: Document;
    /** null = oculto (selección vacía / arrastre en curso / sesión plain). */
    state: BubbleSelectionState | null;
    onToggleBold(): void;
    onToggleItalic(): void;
    onToggleList(ordered: boolean): void;
    onClearFormat(): void;
    onApplyLink(href: string, newTab: boolean): void;
    onUnlink(): void;
    /** La superficie captura la selección al abrir y decide la visibilidad. */
    onPopoverOpenChange(open: boolean): void;
}

const BTN_CLS =
    "flex h-7 w-7 items-center justify-center rounded text-xs leading-none transition";

function BubbleButton({
    label,
    active,
    onCmd,
    children,
}: {
    label: string;
    active?: boolean;
    onCmd: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={active === true}
            // preventDefault en mousedown: conserva la selección/foco del editable.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCmd}
            className={`${BTN_CLS} ${active ? "bg-white/25 text-white" : "text-gray-200 hover:bg-white/10"}`}
        >
            {children}
        </button>
    );
}

const VersoBubbleMenu = React.forwardRef<VersoBubbleMenuHandle, VersoBubbleMenuProps>(
    function VersoBubbleMenu(props, ref) {
        const { frameDoc, state } = props;
        const containerRef = React.useRef<HTMLDivElement | null>(null);
        const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
        const [linkOpen, setLinkOpen] = React.useState(false);
        const [url, setUrl] = React.useState("");
        const [newTab, setNewTab] = React.useState(false);

        const { onPopoverOpenChange } = props;
        const setOpen = React.useCallback(
            (open: boolean, prefill?: { href: string; newTab: boolean }) => {
                setLinkOpen(open);
                if (open && prefill) {
                    setUrl(prefill.href);
                    setNewTab(prefill.newTab);
                }
                onPopoverOpenChange(open);
            },
            [onPopoverOpenChange],
        );

        React.useImperativeHandle(
            ref,
            (): VersoBubbleMenuHandle => ({
                openLinkPopover: () => {
                    const link = state?.active.link ?? null;
                    setOpen(true, { href: link?.href ?? "", newTab: link?.newTab ?? false });
                },
                closeLinkPopover: () => {
                    if (!linkOpen) return false;
                    setOpen(false);
                    return true;
                },
            }),
            [state, linkOpen, setOpen],
        );

        // Posicionamiento: medir el propio bubble y colocarlo sobre el punto
        // medio del rango; sin hueco arriba → debajo; clamp al viewport.
        React.useLayoutEffect(() => {
            if (!state) {
                setPos(null);
                return;
            }
            const el = containerRef.current;
            if (!el) return;
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const view = frameDoc.defaultView;
            const vw = view?.innerWidth ?? 0;
            const vh = view?.innerHeight ?? 0;
            const { rect } = state;
            let top = rect.top - h - 8;
            if (top < 4) top = Math.min(rect.bottom + 8, Math.max(4, vh - h - 4));
            const left = Math.min(Math.max(rect.left + rect.width / 2 - w / 2, 4), Math.max(4, vw - w - 4));
            setPos({ top, left });
        }, [state, frameDoc, linkOpen]);

        // La selección desapareció con el popover abierto: ciérralo (efecto,
        // no en render — cambia estado del padre vía onPopoverOpenChange).
        React.useEffect(() => {
            if (!state && linkOpen) setOpen(false);
        }, [state, linkOpen, setOpen]);

        if (!state) return null;

        const { active } = state;

        const apply = (href: string): void => {
            if (!href.trim()) props.onUnlink();
            else props.onApplyLink(href.trim(), newTab);
            setOpen(false);
        };

        const bubble = (
            <div
                ref={containerRef}
                data-wjs-inline-bubble=""
                role="toolbar"
                aria-label="Formato del texto"
                style={{
                    position: "fixed",
                    top: pos ? pos.top : -10000,
                    left: pos ? pos.left : -10000,
                    zIndex: 100000,
                    visibility: pos ? "visible" : "hidden",
                }}
                className="flex items-center gap-0.5 rounded-lg bg-gray-900 p-1 shadow-xl"
            >
                <BubbleButton label="Negrita" active={active.bold} onCmd={props.onToggleBold}>
                    <strong>B</strong>
                </BubbleButton>
                <BubbleButton label="Cursiva" active={active.italic} onCmd={props.onToggleItalic}>
                    <em>I</em>
                </BubbleButton>
                <span className="relative inline-flex">
                    <BubbleButton
                        label="Enlace"
                        active={active.link !== null || linkOpen}
                        onCmd={() => {
                            if (linkOpen) {
                                setOpen(false);
                            } else {
                                setOpen(true, {
                                    href: active.link?.href ?? "",
                                    newTab: active.link?.newTab ?? false,
                                });
                            }
                        }}
                    >
                        🔗
                    </BubbleButton>
                    {linkOpen && (
                        <span
                            className="absolute left-0 top-full z-10 mt-1 flex w-64 flex-col gap-1 rounded bg-gray-900 p-1.5 shadow-xl"
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            <span className="flex items-center gap-1">
                                <input
                                    autoFocus
                                    type="text"
                                    value={url}
                                    spellCheck={false}
                                    aria-label="URL del enlace"
                                    placeholder="https://… o /pagina"
                                    onChange={(e) => setUrl(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            apply(url);
                                        }
                                    }}
                                    className="min-w-0 flex-1 rounded bg-white/10 px-1.5 py-1 text-xs text-white placeholder:text-gray-400 focus:outline-none"
                                />
                                <button
                                    type="button"
                                    aria-label="Aplicar enlace"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => apply(url)}
                                    className={`${BTN_CLS} text-gray-200 hover:bg-white/10`}
                                >
                                    ✓
                                </button>
                                {active.link !== null && (
                                    <button
                                        type="button"
                                        aria-label="Quitar enlace"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => {
                                            props.onUnlink();
                                            setOpen(false);
                                        }}
                                        className={`${BTN_CLS} text-gray-200 hover:bg-white/10`}
                                    >
                                        ✕
                                    </button>
                                )}
                            </span>
                            {/* D9: el toggle «nueva pestaña» del legacy entra en el contrato. */}
                            <label className="flex cursor-pointer items-center gap-1.5 px-0.5 text-[11px] text-gray-300">
                                <input
                                    type="checkbox"
                                    checked={newTab}
                                    onChange={(e) => setNewTab(e.target.checked)}
                                    className="h-3 w-3"
                                />
                                Abrir en pestaña nueva
                            </label>
                        </span>
                    )}
                </span>
                <BubbleButton
                    label="Lista"
                    active={active.bulletList}
                    onCmd={() => props.onToggleList(false)}
                >
                    ••
                </BubbleButton>
                <BubbleButton
                    label="Lista numerada"
                    active={active.orderedList}
                    onCmd={() => props.onToggleList(true)}
                >
                    1.
                </BubbleButton>
                <BubbleButton label="Limpiar formato" onCmd={props.onClearFormat}>
                    ⌫
                </BubbleButton>
            </div>
        );

        return createPortal(bubble, frameDoc.body);
    },
);

export default VersoBubbleMenu;
