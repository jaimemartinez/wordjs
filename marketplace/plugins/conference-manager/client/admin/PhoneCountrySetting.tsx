// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Indicativo por defecto» (conference-manager 2.33.2) — in Campos, while the form has a phone field: the country
 * the phone selector starts on, and the one a number typed without its code (an older row, an API call) belongs
 * to. Saved on the conference (PUT /:id { phone_country }); Configuración › gestionar.
 */
import React, { useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi } from "../lib/conference";
import { useConference } from "../contexts/ConferenceContext";
import { DEFAULT_COUNTRY, isCountry } from "../lib/phone";
import { CountrySelect } from "../lib/CountrySelect";

const L: Record<string, Record<string, string>> = {
    es: { title: 'Indicativo de país por defecto', hint: 'El selector de los teléfonos empieza en este país, y un número escrito sin indicativo se toma de aquí (también al abrir WhatsApp).', saved: 'Indicativo guardado' },
    en: { title: 'Default country code', hint: 'Phone selectors start on this country, and a number written without a country code is taken as from here (also when opening WhatsApp).', saved: 'Country code saved' },
    pt: { title: 'Código do país padrão', hint: 'O seletor dos telefones começa neste país, e um número escrito sem código é considerado daqui (também ao abrir o WhatsApp).', saved: 'Código salvo' },
};

export function PhoneCountrySetting({ conference, language = 'es', canManage, onSaved }: { conference: any; language?: string; canManage: boolean; onSaved?: (iso: string) => void }) {
    const t = L[String(language).slice(0, 2)] || L.es;
    const { addToast } = useToast();
    const ctx = useConference();
    const current = conference && isCountry(conference.phone_country) ? String(conference.phone_country).toUpperCase() : DEFAULT_COUNTRY;
    const [busy, setBusy] = useState(false);
    const save = async (iso: string) => {
        if (!conference) return;
        setBusy(true);
        try {
            await conferenceApi.updateConference(conference.id, { phone_country: iso });
            onSaved && onSaved(iso);
            if (ctx && ctx.currentConference && ctx.currentConference.id === conference.id && ctx.setCurrentConference) ctx.setCurrentConference({ ...ctx.currentConference, phone_country: iso });
            addToast(t.saved, 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(false); }
    };
    return (
        <div className="rounded-2xl border-2 border-gray-100 bg-white p-5 flex flex-wrap items-center gap-4" data-phone-country-setting="">
            <div className="min-w-0" style={{ flex: '1 1 16rem' }}>
                <p className="text-sm font-bold text-gray-900">{t.title}</p>
                <p className="text-xs text-gray-500 mt-1">{t.hint}</p>
            </div>
            <div style={{ flex: '0 1 18rem' }}>
                <CountrySelect value={current} lang={language} label={t.title} disabled={!canManage || busy} onChange={save}
                    buttonClassName="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 hover:bg-white text-gray-900 font-medium text-sm" />
            </div>
        </div>
    );
}
