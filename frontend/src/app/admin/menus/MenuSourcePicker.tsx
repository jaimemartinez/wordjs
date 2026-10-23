"use client";

/**
 * One «Add to menu» source — pages, posts, categories or tags — as a searchable checklist, so several
 * entries go into the menu in one click (the editor offered pages only, one at a time, through radio
 * buttons: QA S1-14).
 */
import { useId, useMemo, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";

export interface MenuSourceEntry {
    key: string;
    title: string;
    url: string;
    type: string;
    objectId?: number;
}

interface Props {
    title: string;
    icon: string;
    entries: MenuSourceEntry[];
    disabled?: boolean;
    onAdd: (entries: MenuSourceEntry[]) => Promise<void>;
}

export default function MenuSourcePicker({ title, icon, entries, disabled, onAdd }: Props) {
    const { t } = useI18n();
    const id = useId();
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? entries.filter((e) => e.title.toLowerCase().includes(q)) : entries;
    }, [entries, query]);
    const toggle = (key: string) => setChecked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    const add = async () => {
        setBusy(true);
        try {
            await onAdd(entries.filter((e) => checked.has(e.key)));
            setChecked(new Set());
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 shrink-0 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-xs">
                    <i className={`fa-solid ${icon}`} aria-hidden="true"></i>
                </div>
                <h4 id={`${id}-title`} className="font-bold text-sm text-gray-700">{title}</h4>
            </div>
            {entries.length === 0 ? (
                <p className="text-sm text-gray-400 italic font-medium">{t("menus.nothingToAdd")}</p>
            ) : (
                <div className="space-y-3">
                    {entries.length > 8 && (
                        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("menus.filter")}
                            aria-label={`${title}: ${t("menus.filter")}`}
                            className="w-full min-h-11 px-3 rounded-xl border-2 border-gray-100 bg-gray-50/30 text-sm" />
                    )}
                    <div role="group" aria-labelledby={`${id}-title`} className="max-h-48 overflow-y-auto custom-scrollbar border-2 border-gray-100 rounded-xl bg-gray-50/30 p-2">
                        {shown.map((entry) => (
                            <label key={entry.key} className="flex items-center gap-3 p-2.5 min-h-11 hover:bg-white hover:shadow-sm rounded-lg cursor-pointer transition-all">
                                <input type="checkbox" checked={checked.has(entry.key)} onChange={() => toggle(entry.key)} className="h-4 w-4 shrink-0" />
                                <span className="text-sm font-medium text-gray-700 truncate">{entry.title}</span>
                            </label>
                        ))}
                    </div>
                    <button type="button" onClick={add} disabled={disabled || busy || checked.size === 0}
                        className="w-full py-3 bg-white border-2 border-gray-100 hover:border-indigo-500 hover:text-indigo-600 text-gray-600 rounded-xl transition-all text-sm font-black uppercase tracking-widest disabled:opacity-50">
                        {checked.size > 1 ? t("menus.addSelected").replace("{n}", String(checked.size)) : t("menus.addToMenu")}
                    </button>
                </div>
            )}
        </div>
    );
}
