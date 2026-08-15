"use client";
/**
 * Verso — pestaña Plantillas del rail (F3, checklist W27): guardar la página actual como patrón,
 * listar/insertar/borrar patrones de usuario (localStorage `wjs_user_patterns`, cap 30, misma
 * clave y forma que el legacy — interoperables entre editores) + los 9 patrones built-in
 * compartidos (PATTERNS de lib/puckPatterns, fuente única).
 *
 * Piel: la vista "patterns" del BlockInserter legacy (card de guardado punteada + secciones
 * "Mis plantillas"/"Plantillas" con tarjetas icono chip 32 + nombre 12 bold + descripción 11,
 * add_circle al hover, delete flotante en las de usuario, live region siempre montada), con UNA
 * divergencia documentada: la MINIATURA EN VIVO (PatternPreview con el <Render> del motor viejo a
 * ~24%) no se porta en esta ola — exigiría montar el renderer Verso fuera del iframe del canvas;
 * queda para el gate visual (W27 parcial en la checklist). Las tarjetas conservan el resto de su
 * anatomía y comportamiento (insertar al final, un solo undo, ids regenerados).
 */
import React, { useEffect, useState } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import {
    PATTERNS,
    buildVersoPatternItems,
    deleteUserPattern,
    insertVersoPattern,
    insertVersoUserPattern,
    loadUserPatterns,
    saveDocAsPattern,
    type UserPattern,
} from "./patterns";

/* PATTERNS declara clases Font Awesome (compartidas con otros consumidores); mapa al subset de
 * Material Symbols — la MISMA tabla del BlockInserter legacy. */
const PATTERN_MS_ICON: Record<string, string> = {
    "fa-mountain-sun": "web",
    "fa-heading": "title",
    "fa-list-check": "list_alt",
    "fa-grip": "grid_view",
    "fa-chart-simple": "insert_chart",
    "fa-tags": "storefront",
    "fa-quote-left": "format_quote",
    "fa-circle-question": "help",
    "fa-bullhorn": "call_to_action",
};

export interface VersoPatternsPanelProps {
    handle: EditorHandle;
    registry: BlockRegistry;
}

export default function PatternsPanel({ handle, registry }: VersoPatternsPanelProps) {
    const { language } = useI18n();
    const [userPatterns, setUserPatterns] = useState<UserPattern[]>([]);
    const [newPatternName, setNewPatternName] = useState("");
    const [patternNotice, setPatternNotice] = useState<string | null>(null);

    // localStorage no existe en SSR — hidratación única al montar (misma secuencia que el legacy
    // al entrar a la pestaña).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hidratación única desde localStorage al montar
        setUserPatterns(loadUserPatterns());
    }, []);

    useEffect(() => {
        if (!patternNotice) return;
        const t = setTimeout(() => setPatternNotice(null), 4000);
        return () => clearTimeout(t);
    }, [patternNotice]);

    const handleSavePattern = () => {
        const saved = saveDocAsPattern(handle, newPatternName);
        if (saved) {
            setUserPatterns(loadUserPatterns());
            setNewPatternName("");
            setPatternNotice(`${trStr("Guardada", language)} “${saved.name}”.`);
        } else {
            setPatternNotice(trStr("La página está vacía: añade bloques antes de guardarla como plantilla.", language));
        }
    };

    // Patrones built-in disponibles en ESTE registry (tipos no registrados se saltan; un patrón
    // que queda sin bloques no se pinta — paridad con builtPatterns del legacy).
    const builtAvailable = PATTERNS.filter((p) => buildVersoPatternItems(p, registry).length > 0);

    return (
        <div className="px-3 py-3 space-y-3">
            {/* Guardar la página actual como plantilla reutilizable (persistida en este navegador). */}
            <div className="rounded-lg border border-dashed border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] p-3">
                <div className="flex items-center gap-1.5 mb-2">
                    <MSym name="cloud_upload" size={14} className="text-[var(--ed-outline)]" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                        {trStr("Guardar como plantilla", language)}
                    </span>
                </div>
                <div className="flex gap-1.5">
                    <input
                        value={newPatternName}
                        onChange={(e) => setNewPatternName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSavePattern(); }}
                        placeholder={trStr("Nombre (ej. Landing base)", language)}
                        className="flex-1 min-w-0 px-2.5 py-2 rounded-md bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] text-[12px] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)] focus:outline-none focus:ring-1 focus:ring-[var(--ed-primary)] focus:border-[var(--ed-primary)]"
                    />
                    <button
                        type="button"
                        onClick={handleSavePattern}
                        className="px-3 py-2 rounded-md bg-[var(--ed-primary)] text-white text-[11px] font-bold hover:opacity-90 transition-opacity"
                    >
                        {trStr("Guardar", language)}
                    </button>
                </div>
                <p className="text-[10px] text-[var(--ed-outline)] mt-1.5">
                    {trStr("Captura la página actual completa para reutilizarla en otras páginas.", language)}
                </p>
                {/* Live region SIEMPRE montada: una región que aparece junto con su primer mensaje
                    no se anuncia — solo el texto intercambiado dentro de una existente. */}
                <p role="status" className={`text-[11px] text-[var(--ed-primary)] font-semibold ${patternNotice ? "mt-1" : "sr-only"}`}>
                    {patternNotice}
                </p>
            </div>

            {/* Patrones del usuario */}
            {userPatterns.length > 0 && (
                <>
                    <div className="flex items-center gap-1.5 px-0.5 pt-1">
                        <MSym name="person" size={14} className="text-[var(--ed-outline)]" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                            {trStr("Mis plantillas", language)}
                        </span>
                        <span className="text-[10px] text-[var(--ed-on-surface-variant)]">{userPatterns.length}</span>
                    </div>
                    {userPatterns.map((p) => (
                        <div
                            key={p.id}
                            className="relative group rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] overflow-hidden hover:border-[var(--ed-primary)] transition-colors"
                        >
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => insertVersoUserPattern(handle, registry, p)}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertVersoUserPattern(handle, registry, p); } }}
                                className="w-full text-left cursor-pointer"
                                title={trStr("Insertar al final de la página", language)}
                            >
                                <span className="flex items-center gap-2 px-3 py-2">
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-[12px] font-semibold text-[var(--ed-on-surface)] truncate">{p.name}</span>
                                        <span className="block text-[11px] text-[var(--ed-outline)]">
                                            {p.items.length} {trStr(p.items.length === 1 ? "bloque" : "bloques", language)}
                                        </span>
                                    </span>
                                    <MSym
                                        name="add_circle"
                                        size={16}
                                        className="text-[var(--ed-outline-variant)] group-hover:text-[var(--ed-primary)] transition-colors"
                                    />
                                </span>
                            </div>
                            <button
                                type="button"
                                title={trStr("Eliminar plantilla", language)}
                                onClick={(e) => { e.stopPropagation(); setUserPatterns(deleteUserPattern(p.id)); }}
                                className="absolute top-2 right-2 w-7 h-7 rounded-md bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] flex items-center justify-center text-[var(--ed-outline)] hover:text-[var(--ed-error)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition"
                            >
                                <MSym name="delete" size={14} />
                            </button>
                        </div>
                    ))}
                </>
            )}

            {/* Patrones built-in */}
            <div className="flex items-center gap-1.5 px-0.5 pt-1">
                <MSym name="dashboard_customize" size={14} className="text-[var(--ed-outline)]" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                    {trStr("Plantillas", language)}
                </span>
            </div>
            {builtAvailable.map((p) => (
                <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => insertVersoPattern(handle, registry, p)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertVersoPattern(handle, registry, p); } }}
                    className="w-full group rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] overflow-hidden hover:border-[var(--ed-primary)] text-left cursor-pointer transition-colors"
                    title={trStr("Insertar al final de la página", language)}
                >
                    <span className="flex items-center gap-2.5 px-3 py-2">
                        <span className="w-8 h-8 rounded-md bg-[var(--ed-surface-container)] group-hover:bg-[var(--ed-primary-fixed)] flex items-center justify-center text-[var(--ed-on-surface-variant)] group-hover:text-[var(--ed-primary)] transition-colors shrink-0">
                            <MSym name={PATTERN_MS_ICON[p.icon] || "dashboard_customize"} size={18} />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-[12px] font-semibold text-[var(--ed-on-surface)]">{trStr(p.name, language)}</span>
                            <span className="block text-[11px] text-[var(--ed-outline)] truncate">{trStr(p.description, language)}</span>
                        </span>
                        <MSym
                            name="add_circle"
                            size={16}
                            className="text-[var(--ed-outline-variant)] group-hover:text-[var(--ed-primary)] transition-colors"
                        />
                    </span>
                </div>
            ))}
            <p className="text-[11px] text-[var(--ed-outline)] text-center pt-2">
                {trStr("Se añaden al final de la página. Luego puedes editarlas.", language)}
            </p>
        </div>
    );
}
