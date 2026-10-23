// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The country selector of phone fields (conference-manager 2.33.2), on the plugin's select panel (lib/Select.tsx).
 * Closed: a button with the flag (compact, beside the number) or the flag, name and code (full, the «Indicativo
 * por defecto» setting). Open: the search box — a name (accents ignored), the ISO code or the calling code
 * («col», «CO», «+57», «57») — over a scrolling list of flag, name and code. Flags are images (lib/Flag.tsx):
 * Windows has no flag emoji.
 */
import React, { useMemo, useRef, useState } from "react";
import { countryOptions } from "./phone";
import { Flag } from "./Flag";
import { SelectPanel, normSearch, type SelectItem } from "./Select";

const COUNTRY_SEARCH: Record<string, string> = { es: 'Buscar país o indicativo', en: 'Search country or code', pt: 'Buscar país ou código' };

/** The countries matching a search: name prefix first, then name containing it, its ISO code or its calling code. */
export function filterCountries(items: SelectItem[], q: string): SelectItem[] {
    const n = normSearch(q);
    if (!n) return items;
    const digits = n.replace(/^\+/, '');
    const starts: SelectItem[] = [], rest: SelectItem[] = [];
    for (const it of items) {
        const name = normSearch(it.data.name);
        if (name.startsWith(n)) starts.push(it);
        else if (name.includes(n) || it.value.toLowerCase() === n || (/^\d+$/.test(digits) && it.data.dial.startsWith(digits))) rest.push(it);
    }
    return [...starts, ...rest];
}

export function CountrySelect({ value, onChange, lang = 'es', label, compact = false, disabled = false, invalid, describedBy, buttonClassName = '', buttonStyle }: {
    value: string; onChange: (iso: string) => void; lang?: string; label: string; compact?: boolean; disabled?: boolean;
    invalid?: boolean; describedBy?: string; buttonClassName?: string; buttonStyle?: React.CSSProperties;
}) {
    const items = useMemo(() => countryOptions(lang).map(o => ({ value: o.iso, label: o.label, data: o })), [lang]);
    const current = (items.find(it => it.value === value) || items[0]).data;
    const [open, setOpen] = useState(false);
    const btn = useRef<HTMLButtonElement>(null);
    const close = (focusBack: boolean) => { setOpen(false); if (focusBack) setTimeout(() => btn.current && btn.current.focus(), 0); };
    return (
        <>
            <button ref={btn} type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
                aria-label={`${label}: ${current.name} +${current.dial}`} aria-invalid={invalid || undefined} aria-describedby={describedBy}
                title={`${current.name} (+${current.dial})`} onClick={() => setOpen(o => !o)}
                onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); } }}
                className={`${buttonClassName} inline-flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60`} style={buttonStyle} data-country-button={current.iso}>
                <Flag iso={current.iso} width={compact ? 24 : 22} />
                {!compact && <span className="flex-1 min-w-0 truncate text-left">{current.name} <span className="text-gray-500 tabular-nums">+{current.dial}</span></span>}
                <i className={`fa-solid fa-chevron-down text-[9px] text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true"></i>
            </button>
            {open && (
                <SelectPanel anchor={btn} items={items} value={current.iso} lang={lang} label={label} searchable filter={filterCountries}
                    placeholder={(COUNTRY_SEARCH[String(lang).slice(0, 2)] || COUNTRY_SEARCH.es)}
                    onPick={(iso) => { onChange(iso); close(true); }} onClose={close}
                    renderItem={(it) => (
                        <>
                            <Flag iso={it.value} width={22} lazy />
                            <span className="flex-1 min-w-0 truncate">{it.data.name}</span>
                            <span className="tabular-nums text-gray-500 text-xs shrink-0">+{it.data.dial}</span>
                        </>
                    )} />
            )}
        </>
    );
}
