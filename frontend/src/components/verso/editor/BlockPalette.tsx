"use client";
/**
 * Verso — inserter de bloques del panel izquierdo (F3). Misma piel que BlockInserter (buscador,
 * chips de categoría con "Todos" primero, grilla grid-cols-3 md:grid-cols-2, tarjeta icono 20 +
 * label 11) sobre el catálogo compartido BLOCK_META/GROUP_MS_ICON — fuente única con el legacy.
 *
 * DnD: cada tarjeta lleva `data-wjs-palette-type` y el contenedor `data-wjs-palette` — el
 * contrato del DnDDriver de Verso (paleta arrastrable desde el documento padre). Sin Drawer.Item
 * del fork: el driver nuevo no duplica nodos para el placeholder. El click inserta directamente
 * (tap-to-insert, también el modo mobile-sheet).
 *
 * BlockPalette solo cubre la vista "blocks" del rail; la pestaña Plantillas (patrones) es un
 * panel aparte — editor/PatternsPanel.tsx (F3 ola 3, W27).
 */
import React, { useMemo, useRef, useState } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import { BLOCK_META, FALLBACK_GROUP, GROUP_MS_ICON, GROUP_ORDER } from "@/lib/blockCatalog";
import type { BlockRegistry } from "@/lib/verso/registry";
import { useRegistryVersion } from "@/lib/verso/useRegistryVersion";

export interface BlockPaletteProps {
    registry: BlockRegistry;
    /** Inserta el tipo (tap-to-insert). El arrastre lo captura el DnDDriver vía data-wjs-palette-type. */
    onInsert: (type: string) => void;
}

interface PaletteItem {
    name: string;
    label: string;
    ms: string;
    desc?: string;
}

export default function BlockPalette({ registry, onInsert }: BlockPaletteProps) {
    const { language } = useI18n();
    const [query, setQuery] = useState("");
    const [activeGroup, setActiveGroup] = useState("");
    // TAP-PARA-INSERTAR por PUNTERO, no por `click`: el editor re-renderiza entre el down y el up
    // (selección, drag preview…) y si el nodo de la tarjeta se remonta, el navegador SUPRIME el
    // click sintético — la tarjeta «no hacía nada» sin error alguno (cazado en vivo: el evento
    // click jamás llegaba al documento). El pointerup no depende de esa síntesis. El umbral de 5px
    // es EL MISMO del DnDDriver: menos que eso es un tap (insertar); más, un arrastre (suyo).
    const tapRef = useRef<{ name: string; x: number; y: number } | null>(null);
    // F4: los bloques de plugin llegan POST-hidratación con register() sobre el registry
    // identidad-estable — la versión es la dependencia real de estos memos.
    const registryVersion = useRegistryVersion(registry);

    const allGroups = useMemo(() => {
        void registryVersion; // dependencia deliberada: un register() debe recalcular los grupos
        const present = new Set<string>();
        for (const def of registry.list()) present.add(BLOCK_META[def.type]?.group || FALLBACK_GROUP);
        return [
            ...GROUP_ORDER.filter((g) => present.has(g)),
            ...Array.from(present).filter((g) => !GROUP_ORDER.includes(g)),
        ];
    }, [registry, registryVersion]);

    const groups = useMemo(() => {
        void registryVersion; // dependencia deliberada (ver arriba)
        const q = query.trim().toLowerCase();
        const byGroup: Record<string, PaletteItem[]> = {};
        for (const def of registry.list()) {
            const meta = BLOCK_META[def.type];
            // trStr: labels reactivos al idioma SIN remontar el registry (el localizeConfig del
            // legacy, reducido al punto de display; trStr matchea por cualquiera de los 3 idiomas
            // fuente y devuelve el input intacto si no está en el diccionario — plugins a salvo).
            const label = trStr(def.label || meta?.label || def.type, language);
            const ms = meta?.ms || "widgets";
            const desc = meta?.desc;
            const group = meta?.group || FALLBACK_GROUP;
            if (activeGroup && group !== activeGroup) continue;
            if (q && !`${label} ${def.type} ${desc || ""}`.toLowerCase().includes(q)) continue;
            (byGroup[group] ||= []).push({ name: def.type, label, ms, desc });
        }
        const orderedGroups = [
            ...GROUP_ORDER.filter((g) => byGroup[g]?.length),
            ...Object.keys(byGroup).filter((g) => !GROUP_ORDER.includes(g)),
        ];
        return orderedGroups.map((g) => ({
            group: g,
            ms: GROUP_MS_ICON[g] || "widgets",
            items: byGroup[g].sort((a, b) => a.label.localeCompare(b.label)),
        }));
    }, [registry, registryVersion, query, activeGroup, language]);

    const hasResults = groups.length > 0;

    return (
        <div className="w-full" data-wjs-palette="">
            {/* Sticky header: search + category chips (misma piel que BlockInserter) */}
            <div className="sticky top-0 z-10 bg-[var(--ed-surface-container-lowest)] px-3 pt-3 pb-2 border-b border-[var(--ed-outline-variant)]">
                <div className="relative">
                    <MSym
                        name="search"
                        size={18}
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ed-outline)] pointer-events-none"
                    />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={trStr("Buscar bloque…", language)}
                        aria-label={trStr("Buscar bloque", language)}
                        className="w-full pl-8 pr-8 py-2 rounded-md bg-[var(--ed-surface-container)] border border-transparent text-[13px] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)] focus:outline-none focus:ring-1 focus:ring-[var(--ed-primary)] focus:border-[var(--ed-primary)] transition"
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => setQuery("")}
                            title={trStr("Limpiar", language)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center text-[var(--ed-outline)] hover:text-[var(--ed-on-surface)]"
                        >
                            <MSym name="close" size={16} />
                        </button>
                    )}
                </div>

                {allGroups.length > 1 && (
                    <div className="flex gap-1.5 mt-2 overflow-x-auto scrollbar-hide">
                        {["", ...allGroups].map((g) => {
                            const active = activeGroup === g;
                            return (
                                <button
                                    key={g || "__all"}
                                    type="button"
                                    onClick={() => setActiveGroup(g)}
                                    className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors ${
                                        active
                                            ? "bg-[var(--ed-primary)] text-white"
                                            : "bg-[var(--ed-surface-container)] text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-on-surface)]"
                                    }`}
                                >
                                    {g ? trStr(g, language) : trStr("Todos", language)}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="px-3 py-3">
                <div className="space-y-4">
                    {groups.map((g) => (
                        <div key={g.group}>
                            <div className="flex items-center gap-1.5 px-0.5 pb-1.5">
                                <MSym name={g.ms} size={14} className="text-[var(--ed-outline)]" />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                                    {trStr(g.group, language)}
                                </span>
                                {/* on-surface-variant, NOT outline: outline es 4.50:1 exacto en blanco — cero margen AA */}
                                <span className="text-[10px] text-[var(--ed-on-surface-variant)]">{g.items.length}</span>
                            </div>
                            <div className="grid grid-cols-3 md:grid-cols-2 gap-2">
                                {g.items.map((item) => (
                                    <div
                                        key={item.name}
                                        role="button"
                                        tabIndex={0}
                                        data-wjs-palette-type={item.name}
                                        title={item.desc ? trStr(item.desc, language) : item.label}
                                        onPointerDown={(e) => {
                                            if (e.button !== 0) return;
                                            tapRef.current = { name: item.name, x: e.clientX, y: e.clientY };
                                        }}
                                        onPointerUp={(e) => {
                                            const tap = tapRef.current;
                                            tapRef.current = null;
                                            if (!tap || tap.name !== item.name) return;
                                            if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= 5) return;
                                            onInsert(item.name);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                onInsert(item.name);
                                            }
                                        }}
                                        className="group flex flex-col items-center gap-1 p-2 rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] hover:border-[var(--ed-primary)] transition-colors cursor-grab active:cursor-grabbing"
                                    >
                                        <MSym
                                            name={item.ms}
                                            size={20}
                                            className="text-[var(--ed-on-surface-variant)] group-hover:text-[var(--ed-primary)] transition-colors"
                                        />
                                        <span className="w-full text-[11px] leading-tight text-center text-[var(--ed-on-surface)] truncate">
                                            {item.label}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                {!hasResults && (
                    <div className="text-center py-10 text-[var(--ed-outline)] text-[12px]">
                        <MSym name="search" size={24} className="block mx-auto mb-2 opacity-50" />
                        {trStr("Sin resultados para", language)} “{query}”.
                    </div>
                )}
            </div>
        </div>
    );
}
