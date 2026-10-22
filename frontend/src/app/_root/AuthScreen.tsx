/**
 * The sign-in screens' shell (/login, /register, /reset-password, /verify-email — the main site's and
 * every network site's): Inter, and the admin language provider seeded with the language the SERVER
 * chose for this request (lib/adminLanguage.server.ts), so the page is rendered in that language from
 * its first byte instead of switching after hydration.
 *
 * Every layout that uses it reads the request's cookie, so it must be `dynamic = "force-dynamic"`.
 */
import { I18nProvider } from "@/contexts/I18nContext";
import { initialAdminLanguage } from "@/lib/adminLanguage.server";
import { inter } from "../fonts";
import RootDocument from "./RootDocument";

/** Inside an existing document (a network site's tree already has its own). */
export async function AuthScreen({ children }: { children: React.ReactNode }) {
    const lang = await initialAdminLanguage();
    return (
        <I18nProvider initialLanguage={lang}>
            <div className={inter.className} data-wjs-system-screen="">{children}</div>
        </I18nProvider>
    );
}

/** A main-site sign-in screen's whole document, its `<html lang>` in the screen's language. */
export async function authDocument(children: React.ReactNode) {
    const lang = await initialAdminLanguage();
    return RootDocument({
        uiLanguage: lang,
        children: (
            <I18nProvider initialLanguage={lang}>
                <div className={inter.className} data-wjs-system-screen="">{children}</div>
            </I18nProvider>
        ),
    });
}
