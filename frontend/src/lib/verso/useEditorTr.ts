"use client";

import { useCallback, useEffect, useState } from "react";
import { useOptionalI18n } from "@/contexts/I18nContext";
import { getStoredLanguage, type Language } from "@/lib/i18n";
import { trFmt, trStr } from "@/lib/editorI18n";

/**
 * Editor-chrome translator for Verso panels, fields and editor-only block placeholders.
 * Strings stay written in their Spanish source form (the editorI18n dictionary keys) and are
 * rendered in the admin language. Works outside the I18nProvider too (Verso Lab, the boot
 * fallback): there it reads the stored admin language after mount, like I18nProvider does, so the
 * server render and the first client render agree.
 */
export function useEditorTr(): {
    language: Language;
    tr: (s: string) => string;
    trf: (s: string, vars: Record<string, string | number>) => string;
} {
    const ctx = useOptionalI18n();
    const [stored, setStored] = useState<Language>("es");
    useEffect(() => {
        if (!ctx) setStored(getStoredLanguage());
    }, [ctx]);
    const language = ctx?.language ?? stored;
    const tr = useCallback((s: string) => trStr(s, language), [language]);
    const trf = useCallback((s: string, vars: Record<string, string | number>) => trFmt(s, language, vars), [language]);
    return { language, tr, trf };
}
