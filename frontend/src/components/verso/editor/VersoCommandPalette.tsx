"use client";
/**
 * Verso — CommandPalette ⌘K (F3, checklist W29): la paleta COMPLETA, misma piel que
 * CommandPalette.tsx del legacy (backdrop rgba(27,27,34,0.4) + blur, caja max-w-xl/max-h-[70vh],
 * fila activa surface-container + icono primary + trailing hint solo sm:, footer con hints y
 * versión de la app, portal a <body>). Espec de comportamiento: blueprint §CommandPalette (⌘K).
 *
 * Sobre el legacy, dos mejoras deliberadas:
 *  - ARIA de COMBOBOX correcto (blueprint): input role="combobox" con aria-expanded/aria-controls/
 *    aria-activedescendant, lista role="listbox", filas role="option" + aria-selected, cabeceras
 *    role="presentation". La fila activa se maneja con activedescendant (el foco NUNCA sale del
 *    input), así que el focus-trap de Tab se reduce a mantener el foco dentro del diálogo.
 *  - Los bloques salen del BlockRegistry de Verso a través del MISMO catálogo compartido
 *    (getBlockItems/BLOCK_META de lib/blockCatalog — ya agnóstico de motor): ambas paletas
 *    presentan los bloques idénticos. Insertar delega en onInsertBlock (la inserción tras la
 *    selección del VersoEditor — mismo destino que su paleta lateral).
 *
 * Teclado (paridad exacta): ↑/↓ clamp [0,total-1] · Enter ejecuta · Esc cierra · Tab atrapado.
 * Al abrir: guarda el foco previo, resetea query/active, foco al input tras 20ms; al cerrar lo
 * restaura. La cabecera de grupo se repite solo cuando el grupo cambia (comparando con el item
 * anterior — mismo resultado que el `lastGroup` mutable del legacy, sin mutación en render).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import { getBlockItems, BLOCK_META } from "@/lib/blockCatalog";
import type { BlockRegistry } from "@/lib/verso/registry";
import { useRegistryVersion } from "@/lib/verso/useRegistryVersion";
import type { PaletteAction } from "./paletteActions";

// Versión real de la app (root package.json, inlined por next.config.ts). ASSET_VERSION es un
// sello de cache-busting, NO el número de release — el mismo aviso que el legacy.
const APP_VERSION = process.env.NEXT_PUBLIC_WORDJS_VERSION;

const LISTBOX_ID = "verso-cmdk-listbox";
const optionId = (idx: number) => `verso-cmdk-opt-${idx}`;

export interface VersoCommandPaletteProps {
    open: boolean;
    onClose: () => void;
    registry: BlockRegistry;
    actions?: PaletteAction[];
    /** Inserta el tipo tras la selección actual (insertType del VersoEditor). */
    onInsertBlock: (type: string) => void;
}

export default function VersoCommandPalette({
    open,
    onClose,
    registry,
    actions = [],
    onInsertBlock,
}: VersoCommandPaletteProps) {
    // El diálogo solo se MONTA mientras está abierto: cada apertura estrena estado (query=""
    // y active=0 de fábrica — el "reset al abrir" del legacy sin un setState en effect) y el
    // desmontaje restaura el foco previo (cleanup del effect de montaje del diálogo).
    if (!open || typeof document === "undefined") return null;
    return (
        <PaletteDialog
            onClose={onClose}
            registry={registry}
            actions={actions}
            onInsertBlock={onInsertBlock}
        />
    );
}

function PaletteDialog({
    onClose,
    registry,
    actions,
    onInsertBlock,
}: {
    onClose: () => void;
    registry: BlockRegistry;
    actions: PaletteAction[];
    onInsertBlock: (type: string) => void;
}) {
    const { language } = useI18n();
    const [query, setQuery] = useState("");
    const [activeRaw, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    // Mapa components-like para el catálogo compartido con labels YA localizados (el legacy
    // recibía el config pasado por localizeConfig; aquí trStr en el punto de entrada — así la
    // búsqueda matchea lo que se enseña y el idioma cambia SIN remontar el registry). El registry
    // es identidad-estable; los core blocks se registran antes del primer render y los de plugin
    // (F4) llegan POST-hidratación vía register() — de ahí la dependencia en la versión.
    const registryVersion = useRegistryVersion(registry);
    const components = useMemo(() => {
        void registryVersion; // dependencia deliberada: un register() debe recalcular el catálogo
        const map: Record<string, { label?: string }> = {};
        for (const def of registry.list()) map[def.type] = { label: def.label ? trStr(def.label, language) : undefined };
        return map;
    }, [registry, registryVersion, language]);

    const items = useMemo(() => getBlockItems(components, query), [components, query]);
    // Las acciones filtran sobre la misma query; con query vacía se muestran todas (encabezan la
    // lista, como las "ACCIONES SUGERIDAS" del diseño).
    const matchedActions = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
    }, [actions, query]);
    const total = matchedActions.length + items.length;

    // Índice activo DERIVADO con clamp en lectura: si la lista filtrada encoge, la fila activa
    // cae a la última sin necesitar un setState-en-effect (mismo resultado que el legacy).
    const active = Math.min(activeRaw, Math.max(0, total - 1));

    // Montaje = apertura: guarda el foco previo, foco al input tras 20ms (deja pintar el portal
    // antes de robar foco); el desmontaje (cierre) restaura el foco donde estaba.
    useEffect(() => {
        const prev = document.activeElement as HTMLElement | null;
        const t = setTimeout(() => inputRef.current?.focus(), 20);
        return () => {
            clearTimeout(t);
            prev?.focus?.();
        };
    }, []);

    // Scroll de la fila activa a la vista en navegación por teclado.
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const runRow = (idx: number) => {
        if (idx < matchedActions.length) {
            const a = matchedActions[idx];
            onClose();
            a.run();
            return;
        }
        const item = items[idx - matchedActions.length];
        if (!item) return;
        onInsertBlock(item.name);
        onClose();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(active + 1, total - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(active - 1, 0)); }
        else if (e.key === "Enter") { e.preventDefault(); runRow(active); }
        else if (e.key === "Escape") { e.preventDefault(); onClose(); }
        else if (e.key === "Tab") {
            // Focus trap: el diálogo es todo el mundo mientras está abierto. Con el patrón
            // combobox el input es el único focusable estable — ciclar entre los que haya.
            const focusables = dialogRef.current?.querySelectorAll<HTMLElement>("input, button");
            if (!focusables?.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            else if (focusables.length === 1) { e.preventDefault(); first.focus(); }
        }
    };

    // JetBrains Mono para el chrome de kbd/atajos — igual que el resto del editor.
    const mono = { fontFamily: "var(--ed-font-family-monospaced)" };

    const row = (
        idx: number,
        ms: string,
        label: string,
        trailing: string | undefined,
        onRun: () => void,
    ) => {
        const isActive = idx === active;
        return (
            <div
                key={`row-${idx}`}
                id={optionId(idx)}
                role="option"
                aria-selected={isActive}
                data-idx={idx}
                onMouseEnter={() => setActive(idx)}
                onClick={onRun}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left cursor-pointer transition-colors ${
                    isActive ? "bg-[var(--ed-surface-container)]" : ""
                }`}
            >
                <MSym name={ms} size={20} className={isActive ? "text-[var(--ed-primary)]" : "text-[var(--ed-on-surface-variant)]"} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ed-on-surface)]">{label}</span>
                {isActive && trailing && (
                    <span className="hidden sm:inline shrink-0 text-[10px] text-[var(--ed-outline)]" style={mono}>
                        {trailing}
                    </span>
                )}
            </div>
        );
    };

    return createPortal(
        <div
            className="verso-editor-ui fixed inset-0 z-[9999] flex items-start justify-center pt-[14vh] px-4 bg-[rgba(27,27,34,0.4)] backdrop-blur-sm"
            onMouseDown={onClose}
        >
            <div
                ref={dialogRef}
                className="w-full max-w-xl bg-white rounded-xl shadow-2xl border border-[var(--ed-outline-variant)] overflow-hidden flex flex-col max-h-[70vh]"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={onKeyDown}
                role="dialog"
                aria-modal="true"
                aria-label={trStr("Buscar un bloque para insertar", language)}
            >
                {/* Search — combobox: el foco vive aquí, la fila activa via aria-activedescendant */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--ed-outline-variant)]">
                    <MSym name="search" size={18} className="text-[var(--ed-primary)]" />
                    <input
                        ref={inputRef}
                        role="combobox"
                        aria-expanded={total > 0}
                        aria-controls={LISTBOX_ID}
                        aria-activedescendant={total > 0 ? optionId(active) : undefined}
                        aria-autocomplete="list"
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                        placeholder={trStr("Buscar un bloque para insertar…", language)}
                        aria-label={trStr("Buscar un bloque para insertar", language)}
                        className="flex-1 bg-transparent text-[14px] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)] focus:outline-none"
                    />
                    <kbd
                        className="hidden sm:inline px-1.5 py-0.5 rounded border border-[var(--ed-outline-variant)] text-[10px] text-[var(--ed-outline)]"
                        style={mono}
                    >
                        ESC
                    </kbd>
                </div>

                {/* Results */}
                <div
                    ref={listRef}
                    id={LISTBOX_ID}
                    role="listbox"
                    aria-label={trStr("Acciones", language)}
                    className="overflow-y-auto custom-scrollbar p-2 max-h-[400px]"
                >
                    {total === 0 ? (
                        <div className="text-center py-12 text-[13px] text-[var(--ed-on-surface-variant)]">
                            <MSym name="search" size={32} className="mx-auto mb-2 opacity-40 text-[var(--ed-outline)]" />
                            <p>{trStr("Sin resultados para", language)} “{query}”.</p>
                        </div>
                    ) : (
                        <>
                            {matchedActions.length > 0 && (
                                <div role="presentation" className="px-3 py-2 text-[10px] font-semibold text-[var(--ed-outline)] uppercase tracking-widest">
                                    {trStr("Acciones", language)}
                                </div>
                            )}
                            {matchedActions.map((a, i) => row(i, a.ms, a.label, a.hint, () => runRow(i)))}
                            {items.map((item, i) => {
                                const idx = matchedActions.length + i;
                                // Cabecera solo cuando el grupo cambia respecto al item anterior
                                // (getBlockItems ya devuelve la lista ordenada por grupo).
                                const header = item.group !== items[i - 1]?.group ? item.group : null;
                                // `ms` se lee laxo — cae a un glifo del subset (mismo aviso legacy).
                                const msName = BLOCK_META[item.name]?.ms || "widgets";
                                return (
                                    <React.Fragment key={item.name}>
                                        {header && (
                                            <div role="presentation" className="px-3 py-2 text-[10px] font-semibold text-[var(--ed-outline)] uppercase tracking-widest">
                                                {trStr(header, language)}
                                            </div>
                                        )}
                                        {row(idx, msName, item.label, `↵ ${trStr("Insertar", language)}`, () => runRow(idx))}
                                    </React.Fragment>
                                );
                            })}
                        </>
                    )}
                </div>

                {/* Footer hints */}
                <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] text-[10px] text-[var(--ed-on-surface-variant)] select-none">
                    <span>{trStr("Usa ↑↓ para navegar · ↵ para insertar", language)}</span>
                    <span>{APP_VERSION ? `WordJS v${APP_VERSION}` : "WordJS"}</span>
                </div>
            </div>
        </div>,
        document.body
    );
}
