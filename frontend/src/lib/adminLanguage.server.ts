/**
 * The admin language for THIS request (server layouts only): the visitor's stored choice from the
 * cookie, else the site's language. The layouts that call it render dynamically — the answer depends on
 * the request — so it is never computed at build time.
 */
import type { Language } from "./i18n";
import { ADMIN_LANGUAGE_COOKIE, adminLanguageFrom } from "./adminLanguage";
import { resolveDocumentLanguage } from "./documentLanguage";
import { getSettings } from "./server-api";

export async function initialAdminLanguage(): Promise<Language> {
    let stored: string | undefined;
    try {
        const { cookies } = await import("next/headers");
        stored = (await cookies()).get(ADMIN_LANGUAGE_COOKIE)?.value;
    } catch {
        // Outside a request (a unit test): no stored choice.
    }
    let siteLanguage: string | null = null;
    try {
        siteLanguage = resolveDocumentLanguage(await getSettings()).lang;
    } catch {
        // Settings unavailable (mid-install): the fallback decides.
    }
    return adminLanguageFrom(stored, siteLanguage);
}
