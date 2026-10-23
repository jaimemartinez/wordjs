// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The language of the copied consent message (2.33.4): three toggle buttons (Español / English / Português) in the
 * «Copiar mensaje» dialog of the admin and of the coordinators' portal.
 */
import React from "react";
import { COPY_LANGS } from "./consentMessage";

const NAMES: Record<string, string> = { es: "Español", en: "English", pt: "Português" };

export function CopyLangPicker({ value, onChange, label }: { value: string; onChange: (lang: string) => void; label: string }) {
    return (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label} data-copy-lang="">
            <span className="text-xs font-bold text-gray-600">{label}</span>
            {COPY_LANGS.map((l) => (
                <button key={l} type="button" lang={l} aria-pressed={value === l} onClick={() => onChange(l)} data-copy-lang-option={l}
                    className={`min-h-[36px] px-3 rounded-full text-xs font-bold border ${value === l ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-200 hover:border-gray-300"}`}>
                    {NAMES[l]}
                </button>
            ))}
        </div>
    );
}
