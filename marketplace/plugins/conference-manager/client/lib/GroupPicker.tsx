// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Combobox for the GROUPING field (the field flagged `is_group`, e.g. «Grupo familiar»): search / pick one of the
 * locality's existing groups (with who is in it) or type a new one. The coordinator's portal had it alone; from
 * conference-manager 2.36.22 the admin's «Editar participante» uses it too (owner: «al editar un contacto al admin
 * no le salen los grupos familiares de la localidad»). No `required` bubble: the server says what is missing.
 */
import React, { useState } from "react";

export type GroupOption = { name: string; count: number; members?: { id: number; name: string }[] };

/**
 * The groups of ONE locality among the admin's roster rows: the distinct values of the grouping field (trimmed; the
 * same name in another case is the same group, spelled as its first member wrote it), each with its members, by name.
 * `excludeId`: the person being edited, who is not listed as a member of their own group.
 */
export function groupsAmong(rows: any[], groupField: string, locationId: number | string | null | undefined, nameOf: (r: any) => string, excludeId?: number | null): GroupOption[] {
    if (!groupField || locationId == null || locationId === '') return [];
    const map = new Map<string, GroupOption>();
    for (const r of rows || []) {
        if (Number(r.location_id) !== Number(locationId) || r.status === 'cancelled') continue;
        const name = String(r[groupField] ?? '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, { name, count: 0, members: [] });
        if (excludeId != null && Number(r.id) === Number(excludeId)) continue;
        const g = map.get(key)!;
        g.count++;
        g.members!.push({ id: r.id, name: nameOf(r) });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const DEFAULT_LABELS = {
    placeholder: 'Buscar grupo existente o escribir uno nuevo…',
    empty: 'Aún no hay grupos en esta localidad. Escribe para crear el primero.',
    person: 'persona', people: 'personas',
    create: 'Crear grupo «{name}»',
    inGroup: 'En «{name}» ({n}):',
};
const fill = (s: string, vars: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export function GroupPicker({ field, value, onChange, groups, id, invalid, describedBy, className, labels }: {
    field: any; value: any; onChange: (v: string) => void; groups: GroupOption[]; id?: string;
    invalid?: boolean; describedBy?: string; className?: string; labels?: Partial<typeof DEFAULT_LABELS>;
}) {
    const L = { ...DEFAULT_LABELS, ...(labels || {}) };
    const [open, setOpen] = useState(false);
    const val = value == null ? '' : String(value);
    const lower = val.trim().toLowerCase();
    const list = groups || [];
    const filtered = lower ? list.filter((g) => g.name.toLowerCase().includes(lower)) : list;
    const exact = list.find((g) => g.name.toLowerCase() === lower);
    return (
        <div className="relative" data-group-picker={field.name}>
            <input
                id={id}
                type="text"
                data-field={field.name} aria-invalid={invalid} aria-describedby={describedBy}
                className={className}
                placeholder={L.placeholder}
                value={val}
                onChange={(e) => onChange(e.target.value)}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 180)}
                autoComplete="off"
            />
            {open && (
                <div className="absolute z-40 left-0 right-0 mt-2 bg-white border border-gray-100 rounded-3xl shadow-2xl max-h-64 overflow-y-auto p-2 animate-in slide-in-from-top-2 duration-200" data-group-options="">
                    {filtered.length === 0 && !val && (
                        <div className="px-4 py-3 text-xs font-bold text-gray-500 italic">{L.empty}</div>
                    )}
                    {filtered.map((g) => (
                        <button
                            type="button"
                            key={g.name}
                            onMouseDown={(e) => { e.preventDefault(); onChange(g.name); setOpen(false); }}
                            className="w-full text-left px-4 py-3 hover:bg-blue-50 rounded-2xl transition-all group"
                            data-group-option={g.name}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-bold text-gray-700 group-hover:text-blue-700 transition-colors truncate">{g.name}</span>
                                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest whitespace-nowrap">{g.count} {g.count === 1 ? L.person : L.people}</span>
                            </div>
                            {g.members && g.members.length > 0 && (
                                <div className="text-[11px] text-gray-400 truncate mt-0.5">{g.members.map((m) => m.name).join(', ')}</div>
                            )}
                        </button>
                    ))}
                    {val.trim() && !exact && (
                        <button
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); setOpen(false); }}
                            className="w-full text-left px-4 py-3 mt-1 rounded-2xl text-blue-600 hover:bg-blue-50 font-bold text-sm border-t border-gray-50 transition-all"
                        >
                            <i className="fa-solid fa-plus mr-2"></i>{fill(L.create, { name: val.trim() })}
                        </button>
                    )}
                </div>
            )}
            {exact && exact.members && exact.members.length > 0 && (
                <div className="mt-2 text-xs text-gray-600 bg-blue-50/60 rounded-xl px-4 py-2.5 border border-blue-100">
                    <span className="font-bold text-blue-900">{fill(L.inGroup, { name: exact.name, n: exact.count })}</span> {exact.members.map((m) => m.name).join(', ')}
                </div>
            )}
        </div>
    );
}

export default GroupPicker;
