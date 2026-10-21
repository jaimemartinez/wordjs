/**
 * Which language the admin and the sign-in screens render in — decided the same way on the server and
 * in the browser, so the first paint is already in that language.
 *
 * The choice used to live only in localStorage, which the server cannot read: every screen rendered in
 * Spanish (the provider's fixed default) and switched after hydration — a visible flash, a server/client
 * mismatch, and a fresh browser always starting in Spanish whatever the site's language. Now the choice
 * is also a cookie (written whenever it changes), and with no choice stored the site's own language
 * (`<html lang>`, from WPLANG) decides.
 *
 * Pure and dependency-free: imported by server layouts and by the client provider alike.
 */
import type { Language } from "./i18n";

export const ADMIN_LANGUAGES: readonly Language[] = ["es", "en", "pt"];
export const ADMIN_LANGUAGE_COOKIE = "wordjs-lang";
/** Used only when neither a stored choice nor the site's language is one the admin is translated into. */
export const FALLBACK_ADMIN_LANGUAGE: Language = "es";

/** `en-US`, `pt_BR`, `ES` → the admin language it names, or null. */
export function asAdminLanguage(value: string | null | undefined): Language | null {
    const base = (value ?? "").trim().toLowerCase().split(/[-_]/)[0];
    return (ADMIN_LANGUAGES as readonly string[]).includes(base) ? (base as Language) : null;
}

/** The stored choice wins; then the site's language; then the fallback. */
export function adminLanguageFrom(stored: string | null | undefined, siteLanguage: string | null | undefined): Language {
    return asAdminLanguage(stored) ?? asAdminLanguage(siteLanguage) ?? FALLBACK_ADMIN_LANGUAGE;
}

/** The cookie that carries the choice to the server: a year, the whole site, never to another site. */
export function adminLanguageCookie(lang: Language): string {
    return `${ADMIN_LANGUAGE_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
