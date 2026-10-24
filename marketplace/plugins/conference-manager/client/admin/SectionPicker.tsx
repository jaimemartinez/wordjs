// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The admin's section menu (conference-manager 2.36.6). The owner: «no me gusta esa barra de menú… no es responsive, no
 * es user friendly» — fifteen tabs in one row scrolled sideways even on a wide screen. Now ONE button names the section
 * you are in («Inscripciones ▾»); it opens the sections grouped (Personas · Dinero · Logística · Configuración) with a
 * search box, at every width. It is the plugin's Select panel (lib/Select): the same keyboard (arrows, Enter, Escape),
 * placement (under the button, above it when there is no room) and scrolling as every searchable list.
 */
import React, { useRef, useState } from "react";
import { SelectPanel, type SelectItem } from "../lib/Select";

export type SectionTab = { name: string; view: string; icon: string };
type Tx = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** The sections by area, in the order the list shows them; a section not named here goes under Configuración. */
export const SECTION_GROUPS: [string, string, string[]][] = [
    ['people', 'Personas', ['dashboard', 'inscriptions', 'consent', 'badges', 'locations']],
    ['money', 'Dinero', ['fees', 'accounting', 'pricing']],
    ['logistics', 'Logística', ['lodging', 'assignment', 'transport', 'meals']],
    ['setup', 'Configuración', ['fields', 'reports', 'staff']],
];

/** The list's items: the sections this role may open, grouped and in order. */
export function sectionItems(tabs: SectionTab[], tx: Tx): SelectItem[] {
    const out: SelectItem[] = [];
    const placed = new Set<string>();
    for (const [key, label, views] of SECTION_GROUPS) {
        const group = tx(`nav.group.${key}`, label);
        for (const v of views) {
            const tab = tabs.find(t => t.view === v);
            if (!tab) continue;
            out.push({ value: tab.view, label: tab.name, group, data: tab });
            placed.add(tab.view);
        }
    }
    const rest = tabs.filter(t => !placed.has(t.view));
    for (const tab of rest) out.push({ value: tab.view, label: tab.name, group: tx('nav.group.setup', 'Configuración'), data: tab });
    return out;
}

export function SectionPicker({ tabs, current, onPick, tx, lang }: { tabs: SectionTab[]; current: string; onPick: (view: string) => void; tx: Tx; lang?: string }) {
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement | null>(null);
    const tab = tabs.find(t => t.view === current) || tabs[0];
    const items = sectionItems(tabs, tx);
    return (
        <>
            <button ref={button} type="button" onClick={() => setOpen(v => !v)} aria-haspopup="listbox" aria-expanded={open} data-cm-section-picker=""
                className="w-full sm:w-auto sm:min-w-[20rem] flex items-center gap-3 rounded-2xl border-2 border-gray-200 bg-white px-4 py-2.5 text-left shadow-sm hover:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
                <span className="w-10 h-10 shrink-0 inline-flex items-center justify-center rounded-xl bg-blue-50 text-blue-600" aria-hidden="true">
                    <i className={`fa-solid ${tab ? tab.icon : 'fa-bars'}`}></i>
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-gray-400">{tx('nav.section', 'Sección')}</span>
                    <span className="block truncate text-base font-bold text-gray-900">{tab ? tab.name : ''}</span>
                </span>
                <i className={`fa-solid fa-chevron-down text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true"></i>
            </button>
            {open && (
                <SelectPanel anchor={button} items={items} value={current} searchable lang={lang} label={tx('nav.section', 'Sección')}
                    placeholder={tx('nav.search', 'Buscar sección…')}
                    onPick={(v) => { setOpen(false); onPick(v); button.current?.focus(); }}
                    onClose={(focusBack) => { setOpen(false); if (focusBack) button.current?.focus(); }}
                    renderItem={(it) => (
                        <span className="flex-1 min-w-0 flex items-center gap-3">
                            <i className={`fa-solid ${it.data.icon} w-5 text-center text-gray-400`} aria-hidden="true"></i>
                            <span className="truncate">{it.label}</span>
                        </span>
                    )} />
            )}
        </>
    );
}

export default SectionPicker;
