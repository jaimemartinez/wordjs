"use client";

import React, { createContext, useContext, useState, useEffect } from 'react';
import { Language, getStoredLanguage, setStoredLanguage, syncLanguageCookie, t } from '@/lib/i18n';
import { FALLBACK_ADMIN_LANGUAGE } from '@/lib/adminLanguage';

interface I18nContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

/**
 * @param initialLanguage what the server rendered with (lib/adminLanguage.server.ts: the cookie, else the
 *        site's language). Starting from it keeps the first client render identical to the server's;
 *        without it (a screen mounted with no server layout) the fallback applies until mount.
 */
export function I18nProvider({ children, initialLanguage }: { children: React.ReactNode; initialLanguage?: Language }) {
    const [language, setLanguageState] = useState<Language>(initialLanguage ?? FALLBACK_ADMIN_LANGUAGE);

    useEffect(() => {
        // A choice stored before the cookie existed lives only in localStorage: apply it, and write the
        // cookie so the server renders it from the next request on.
        const stored = getStoredLanguage();
        setLanguageState(stored);
        syncLanguageCookie(stored);
    }, []);

    const setLanguage = (lang: Language) => {
        setLanguageState(lang);
        setStoredLanguage(lang);
    };

    const translate = (key: string) => t(key, language);

    return (
        <I18nContext.Provider value={{ language, setLanguage, t: translate }}>
            {children}
        </I18nContext.Provider>
    );
}

export function useI18n() {
    const context = useContext(I18nContext);
    if (!context) {
        throw new Error('useI18n must be used within I18nProvider');
    }
    return context;
}

/** useI18n() for a component that may also render outside the provider: null there. */
export function useOptionalI18n(): I18nContextType | null {
    return useContext(I18nContext) ?? null;
}
