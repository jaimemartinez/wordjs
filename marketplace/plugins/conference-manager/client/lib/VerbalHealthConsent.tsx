// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The verbal health authorization (2.34.0): while the conference asks for «Autorización de datos», a coordinator or the
 * admin who enters a person's «Condiciones de salud» ticks that the person authorized it verbally, having been told
 * it is voluntary. Without the tick the answer is not saved (an error under the box, never a browser bubble). The
 * person's later written authorization (code or paper) confirms it.
 */
import React from "react";

export function VerbalHealthConsent({ id, label, checked, onChange, error }: {
    id: string; label: string; checked: boolean; onChange: (v: boolean) => void; error?: string | null;
}) {
    const errId = `${id}-error`;
    return (
        <div className="space-y-1" data-health-verbal="">
            <label htmlFor={id} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2 text-sm cursor-pointer ${error ? "border-rose-300 bg-rose-50/40" : checked ? "border-emerald-300 bg-emerald-50/60" : "border-amber-200 bg-amber-50/50"}`}>
                <input id={id} type="checkbox" className="mt-0.5 w-4 h-4 shrink-0 accent-emerald-600" checked={checked} onChange={(e) => onChange(e.target.checked)}
                    aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} data-health-verbal-box="" />
                <span className="min-w-0 text-gray-800">{label}</span>
            </label>
            {error && <p id={errId} role="alert" className="text-xs font-semibold text-rose-600">{error}</p>}
        </div>
    );
}

export default VerbalHealthConsent;
