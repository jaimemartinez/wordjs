/**
 * The handful of UI strings that the PUBLIC site paints itself (as opposed to content the author
 * wrote): the motion pause control and the Form block's runtime texts.
 *
 * They follow the SITE language — the same `WPLANG` that drives `<html lang>` (lib/documentLanguage)
 * — and come from the lib/i18n catalogue like every other WordJS string. The catalogue is resolved
 * HERE, on the server, and only the few resulting strings travel to the page as plain props: lib/i18n
 * is the whole admin catalogue and no public page should ship it (same reasoning as
 * HostNotAllowedNotice, which also loads it only on demand).
 *
 * Import this module from server components only (HomeContent, PostContent).
 */
import { t, type Language } from "@/lib/i18n";
import { resolveDocumentLanguage } from "@/lib/documentLanguage";

/** Already-resolved strings; serializable, so they can cross into client islands. */
export interface PublicUiStrings {
    motionPause: string;
    motionResume: string;
    formSelectPlaceholder: string;
    formSending: string;
    formSuccess: string;
    formError: string;
    formSubmit: string;
}

/** Catalogue language for a document language tag: its primary subtag when the catalogue has it, else English. */
export function catalogueLanguage(documentLang: string | null | undefined): Language {
    const base = (documentLang ?? "").toLowerCase().split(/[-_]/)[0];
    return base === "es" || base === "en" || base === "pt" ? base : "en";
}

export function publicUiStringsFor(lang: Language): PublicUiStrings {
    return {
        motionPause: t("public.motion.pause", lang),
        motionResume: t("public.motion.resume", lang),
        formSelectPlaceholder: t("public.form.selectPlaceholder", lang),
        formSending: t("public.form.sending", lang),
        formSuccess: t("public.form.success", lang),
        formError: t("public.form.error", lang),
        formSubmit: t("public.form.submit", lang),
    };
}

/** Strings for a site, from its settings (`WPLANG`; nothing configured → English, like `<html lang>`). */
export function publicUiStrings(settings: Record<string, unknown> | null | undefined): PublicUiStrings {
    return publicUiStringsFor(catalogueLanguage(resolveDocumentLanguage(settings).lang));
}

/** The built-in footer's two column headings (components/public/Footer). */
export interface FooterStrings {
    quickLinks: string;
    connect: string;
}

export function footerStringsFor(lang: Language): FooterStrings {
    return {
        quickLinks: t("public.footer.quickLinks", lang),
        connect: t("public.footer.connect", lang),
    };
}

/** Footer headings for a site, from its settings (`WPLANG`; nothing configured → English). */
export function footerStrings(settings: Record<string, unknown> | null | undefined): FooterStrings {
    return footerStringsFor(catalogueLanguage(resolveDocumentLanguage(settings).lang));
}

/** The members-only notice (core/content-access): shown where a gated entry's teaser ends. */
export interface MembersGateStrings {
    title: string;
    body: string;
    login: string;
    signup: string;
    checking: string;
}

export function membersGateStrings(settings: Record<string, unknown> | null | undefined): MembersGateStrings {
    const lang = catalogueLanguage(resolveDocumentLanguage(settings).lang);
    return {
        title: t("public.members.title", lang),
        body: t("public.members.body", lang),
        login: t("public.members.login", lang),
        signup: t("public.members.signup", lang),
        checking: t("public.members.checking", lang),
    };
}

/** The 404 page's own texts (components/NotFoundState). */
export interface NotFoundStrings {
    title: string;
    message: string;
    back: string;
}

export function notFoundStringsFor(lang: Language): NotFoundStrings {
    return {
        title: t("public.notFound.title", lang),
        message: t("public.notFound.message", lang),
        back: t("public.backHome", lang),
    };
}

/** 404 texts for a site, from its settings (`WPLANG`; nothing configured → English). */
export function notFoundStrings(settings: Record<string, unknown> | null | undefined): NotFoundStrings {
    return notFoundStringsFor(catalogueLanguage(resolveDocumentLanguage(settings).lang));
}
