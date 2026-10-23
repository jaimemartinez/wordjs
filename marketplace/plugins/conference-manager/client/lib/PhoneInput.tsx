// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * A phone field with its country (conference-manager 2.33.2): a small flag box in the same row as the national
 * number — closed it shows only the flag; it opens the list of countries (name and calling code, in the screen's
 * language; typing a name jumps to it). It sends E.164
 * («+573001234567»), or '' while the number is empty. A stored value without «+» (an older row) opens as a
 * national number in the conference's default country. Used by the admin's inscription form and the
 * coordinators' portal; errors stay with the caller's in-place FieldError.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { countryOptions, flagOf, joinPhone, splitPhone } from "./phone";

export const PHONE_LABELS: Record<string, { country: string; number: string }> = {
    es: { country: 'Indicativo de país', number: 'Número' },
    en: { country: 'Country code', number: 'Number' },
    pt: { country: 'Código do país', number: 'Número' },
};
export const phoneLabels = (lang?: string) => PHONE_LABELS[String(lang || 'es').slice(0, 2)] || PHONE_LABELS.es;

export function PhoneInput({ id, value, onChange, defaultCountry, lang = 'es', label, dataField, invalid, describedBy, selectClassName, inputClassName }: {
    id?: string; value: string; onChange: (v: string) => void; defaultCountry?: string | null; lang?: string; label?: string;
    dataField?: string; invalid?: boolean; describedBy?: string; selectClassName?: string; inputClassName?: string;
}) {
    const L = phoneLabels(lang);
    const options = useMemo(() => countryOptions(lang), [lang]);
    const [iso, setIso] = useState(() => splitPhone(value, defaultCountry).iso);
    const [national, setNational] = useState(() => splitPhone(value, defaultCountry).national);
    const sent = useRef(value);
    // A value that did not come from here (a reset, another person) re-splits the two parts.
    useEffect(() => {
        if (value === sent.current) return;
        const p = splitPhone(value, defaultCountry);
        setIso(p.iso); setNational(p.national); sent.current = value;
    }, [value, defaultCountry]);
    const emit = (nextIso: string, nextNational: string) => {
        const v = joinPhone(nextIso, nextNational);
        sent.current = v;
        onChange(v);
    };
    const name = label ? `${label} · ` : '';
    return (
        <div className="flex gap-2 items-stretch" data-phone-input={dataField || ''}>
            {/* Closed, only the flag shows (a small box beside the number); the native list underneath opens with the
                names and codes, so it keeps the keyboard, the screen reader and the phone's own picker. */}
            <div className={`${selectClassName || ''} relative shrink-0 flex items-center justify-center gap-1 focus-within:ring-2 focus-within:ring-blue-400`}
                style={{ width: '3.75rem', paddingLeft: 0, paddingRight: 0 }} data-phone-flag={iso}>
                <span className="text-lg leading-none" aria-hidden="true">{flagOf(iso)}</span>
                <i className="fa-solid fa-chevron-down text-[8px] text-gray-400" aria-hidden="true"></i>
                <select aria-label={`${name}${L.country}`} title={options.find(o => o.iso === iso)?.label} value={iso} data-phone-country=""
                    onChange={(e) => { setIso(e.target.value); emit(e.target.value, national); }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
                    {options.map(o => <option key={o.iso} value={o.iso}>{o.label}</option>)}
                </select>
            </div>
            <input id={id} type="tel" inputMode="tel" autoComplete="tel-national" aria-label={`${name}${L.number}`} data-field={dataField}
                value={national} onChange={(e) => { setNational(e.target.value); emit(iso, e.target.value); }}
                className={`${inputClassName || ''} min-w-0 flex-1`} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
        </div>
    );
}
