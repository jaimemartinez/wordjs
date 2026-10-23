// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Condiciones de salud» (2.32.0): the multiple-choice input of the registration form, shared by the admin's
 * inscription form and the coordinators' portal. Conditions as checkboxes, «Otros» reveals its text box, and
 * «Ninguna» / «Prefiero no responder» as two exclusive choices. A consent line says what the answers are for.
 * Errors are shown in place (`error`, with the same FieldError as every other field since 2.31.1), never with the
 * browser's `required` bubbles or a native dialog.
 */
import React from "react";
import { HEALTH_OTHER, HEALTH_OTHER_MAX, chooseSpecial, healthOptions, setOtherText, toggleCondition, type HealthAnswer } from "./health";
import { FieldError } from "./useFieldErrors";

export type HealthLabels = {
    consent: string; other: string; otherPlaceholder: string; none: string; declined: string;
};
export const HEALTH_LABELS_ES: HealthLabels = {
    consent: 'Usaremos esta información solo para atenderte mejor. Solo la ve el equipo autorizado. Puedes no responder.',
    other: 'Otros', otherPlaceholder: '¿Cuál?', none: 'Ninguna', declined: 'Prefiero no responder',
};

export function HealthConditionsInput({ id, field, value, onChange, error, labels = HEALTH_LABELS_ES, disabled = false }: {
    id: string; field: { label?: string; options?: string | null }; value: HealthAnswer | null;
    onChange: (next: HealthAnswer | null) => void; error?: string | null; labels?: HealthLabels; disabled?: boolean;
}) {
    const list = value && value.answer === 'list' ? value : null;
    const checked = (c: string) => !!list && list.conditions.includes(c);
    const otherOn = checked(HEALTH_OTHER);
    const errId = `${id}-error`;
    const box = (c: string, label: string) => (
        <label key={c} className={`flex items-start gap-2.5 min-h-[44px] rounded-xl border px-3 py-2 text-sm cursor-pointer transition ${checked(c) ? 'border-blue-300 bg-blue-50/60 text-gray-900' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}>
            <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0 accent-blue-600" checked={checked(c)} disabled={disabled}
                onChange={() => onChange(toggleCondition(value, c))} data-health-option={c} />
            <span className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{label}</span>
        </label>
    );
    const special = (which: 'none' | 'declined', label: string) => {
        const on = !!value && value.answer === which;
        return (
            <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(chooseSpecial(value, which))}
                className={`min-h-[44px] px-4 py-2 rounded-xl border text-sm font-semibold transition ${on ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}
                data-health-special={which}>
                {label}
            </button>
        );
    };
    return (
        <fieldset id={id} className="space-y-3" aria-describedby={`${id}-consent${error ? ` ${errId}` : ''}`} aria-invalid={error ? true : undefined} data-health-input="">
            <legend className="sr-only">{field.label || 'Condiciones de salud'}</legend>
            <p id={`${id}-consent`} className="flex items-start gap-2 text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2" data-health-consent="">
                <i className="fa-solid fa-lock text-gray-400 mt-0.5" aria-hidden="true"></i>
                <span>{labels.consent}</span>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {healthOptions(field).map(c => box(c, c))}
                {box(HEALTH_OTHER, labels.other)}
            </div>
            {otherOn && (
                <input type="text" className={`w-full border-2 rounded-xl px-4 py-2.5 text-sm outline-none transition ${error && !list?.other?.trim() ? 'border-rose-300 bg-rose-50/40' : 'border-gray-100 bg-gray-50/30 focus:bg-white focus:border-blue-500'}`}
                    aria-label={`${labels.other}: ${labels.otherPlaceholder}`} placeholder={labels.otherPlaceholder} maxLength={HEALTH_OTHER_MAX}
                    value={list?.other || ''} disabled={disabled} onChange={e => onChange(setOtherText(value, e.target.value))} data-health-other="" />
            )}
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={field.label || 'Condiciones de salud'}>
                {special('none', labels.none)}
                {special('declined', labels.declined)}
            </div>
            <FieldError id={errId} message={error} />
        </fieldset>
    );
}
