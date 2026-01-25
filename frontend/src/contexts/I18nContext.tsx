"use client";

import React, { createContext, useContext, useState, useEffect } from 'react';
import { Language, getStoredLanguage, setStoredLanguage, t } from '@/lib/i18n';

interface I18nContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: React.ReactNode }) {
    const [language, setLanguageState] = useState<Language>(getStoredLanguage());

    useEffect(() => {
        // Load language from localStorage on mount
        const stored = getStoredLanguage();
        if (stored !== language) {
            setLanguageState(stored);
        }
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
