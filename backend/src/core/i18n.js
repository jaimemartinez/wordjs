/**
 * WordJS - Internationalization (i18n) System
 * Equivalent to wp-includes/l10n.php
 */

const fs = require('fs');
const path = require('path');
const { getOption, updateOption } = require('./options');

// Loaded translations
const translations = new Map();

// Current locale
let currentLocale = 'en_US';

// Languages directory
const LANGUAGES_DIR = path.resolve('./languages');

/**
 * Ensure languages directory exists
 */
function ensureLanguagesDir() {
    if (!fs.existsSync(LANGUAGES_DIR)) {
        fs.mkdirSync(LANGUAGES_DIR, { recursive: true });
    }
}

/**
 * Load translation file for a locale
 */
function loadTextDomain(domain, locale = null) {
    const loc = locale || currentLocale;
    const key = `${domain}_${loc}`;

    if (translations.has(key)) {
        return true;
    }

    ensureLanguagesDir();

    // Try to load JSON translation file
    const jsonFile = path.join(LANGUAGES_DIR, `${domain}-${loc}.json`);
    if (fs.existsSync(jsonFile)) {
        try {
            const content = fs.readFileSync(jsonFile, 'utf8');
            const data = JSON.parse(content);
            translations.set(key, data);
            return true;
        } catch (e) {
            console.error(`Error loading translation ${jsonFile}:`, e.message);
        }
    }

    return false;
}

/**
 * Unload translation file
 */
function unloadTextDomain(domain) {
    let removed = false;
    for (const key of translations.keys()) {
        if (key.startsWith(`${domain}_`)) {
            translations.delete(key);
            removed = true;
        }
    }
    return removed;
}

/**
 * Get translated string
 * Equivalent to __()
 */
function __(text, domain = 'default') {
    const key = `${domain}_${currentLocale}`;
    const domainTranslations = translations.get(key);

    if (domainTranslations && domainTranslations[text]) {
        return domainTranslations[text];
    }

    return text;
}

/**
 * Get translated string with context
 * Equivalent to _x()
 */
function _x(text, context, domain = 'default') {
    const key = `${domain}_${currentLocale}`;
    const domainTranslations = translations.get(key);
    const contextKey = `${context}\u0004${text}`;

    if (domainTranslations && domainTranslations[contextKey]) {
        return domainTranslations[contextKey];
    }

    return text;
}

/**
 * Get translated plural string
 * Equivalent to _n()
 */
function _n(single, plural, number, domain = 'default') {
    const key = `${domain}_${currentLocale}`;
    const domainTranslations = translations.get(key);

    // Get plural form
    const pluralForm = getPluralForm(number, currentLocale);
    const pluralKey = `${single}\u0000${plural}`;

    if (domainTranslations && domainTranslations[pluralKey]) {
        const forms = domainTranslations[pluralKey];
        if (Array.isArray(forms)) {
            return forms[pluralForm] || (number === 1 ? single : plural);
        }
        return forms;
    }

    return number === 1 ? single : plural;
}

/**
 * Echo translated string (for templates)
 */
function _e(text, domain = 'default') {
    return __(text, domain);
}

/**
 * Get plural form index for a locale
 */
function getPluralForm(n, locale) {
    // Most common plural rules
    const lang = locale.split('_')[0];

    switch (lang) {
        // One/other (English, German, etc.)
        case 'en':
        case 'de':
        case 'nl':
        case 'it':
        case 'es':
        case 'pt':
            return n !== 1 ? 1 : 0;

        // Special cases
        case 'fr':
            return n > 1 ? 1 : 0;

        case 'ru':
        case 'uk':
            // Slavic languages
            if (n % 10 === 1 && n % 100 !== 11) return 0;
            if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 1;
            return 2;

        case 'pl':
            if (n === 1) return 0;
            if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 1;
            return 2;

        case 'ar':
            if (n === 0) return 0;
            if (n === 1) return 1;
            if (n === 2) return 2;
            if (n % 100 >= 3 && n % 100 <= 10) return 3;
            if (n % 100 >= 11) return 4;
            return 5;

        default:
            return n !== 1 ? 1 : 0;
    }
}

/**
 * Set the current locale
 */
function setLocale(locale) {
    currentLocale = locale;
    updateOption('WPLANG', locale);

    // Load default domain for new locale
    loadTextDomain('default', locale);
    loadTextDomain('admin', locale);
}

/**
 * Get current locale
 */
function getLocale() {
    return currentLocale;
}

/**
 * Get available locales
 */
function getAvailableLocales() {
    ensureLanguagesDir();

    const locales = new Set(['en_US']);

    const files = fs.readdirSync(LANGUAGES_DIR);
    for (const file of files) {
        const match = file.match(/^[^-]+-([a-z]{2}_[A-Z]{2})\.json$/);
        if (match) {
            locales.add(match[1]);
        }
    }

    return Array.from(locales);
}

/**
 * Create a translation file
 */
function createTranslationFile(domain, locale, translations) {
    ensureLanguagesDir();

    const filepath = path.join(LANGUAGES_DIR, `${domain}-${locale}.json`);
    fs.writeFileSync(filepath, JSON.stringify(translations, null, 2));

    return filepath;
}

/**
 * Language data
 */
const languages = {
    en_US: { name: 'English (US)', native: 'English' },
    es_ES: { name: 'Spanish', native: 'Español' },
    fr_FR: { name: 'French', native: 'Français' },
    de_DE: { name: 'German', native: 'Deutsch' },
    it_IT: { name: 'Italian', native: 'Italiano' },
    pt_BR: { name: 'Portuguese (Brazil)', native: 'Português do Brasil' },
    ru_RU: { name: 'Russian', native: 'Русский' },
    zh_CN: { name: 'Chinese (Simplified)', native: '简体中文' },
    ja: { name: 'Japanese', native: '日本語' },
    ko_KR: { name: 'Korean', native: '한국어' },
    ar: { name: 'Arabic', native: 'العربية' }
};

/**
 * Get language info
 */
function getLanguageInfo(locale) {
    return languages[locale] || { name: locale, native: locale };
}

/**
 * Initialize i18n system
 */
function initI18n() {
    // Get locale from options or default to en_US
    currentLocale = getOption('WPLANG', 'en_US');

    // Load default translations
    loadTextDomain('default');
    loadTextDomain('admin');
}

// Initialize on load
initI18n();

module.exports = {
    __,
    _x,
    _n,
    _e,
    loadTextDomain,
    unloadTextDomain,
    setLocale,
    getLocale,
    getAvailableLocales,
    createTranslationFile,
    getLanguageInfo,
    languages
};
