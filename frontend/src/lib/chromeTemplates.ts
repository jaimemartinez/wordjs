// Starter templates for the header/footer editor's gallery (/admin/chrome). Each one is an ordinary
// composition of the chrome contract — the gallery only hands it to the editor, which applies it as ONE
// undoable step and saves it like any other edit. Pure and DOM-free; every template must pass
// parseChromeData for its part (pinned by lib/__tests__/chromeTemplates.test.ts).
//
// Texts that a visitor reads (a button label, a column title) come from the translator passed in, so a
// Spanish admin gets a Spanish starting point. Nothing here is required content: the author edits it.

import type { ChromeBlock, ChromeData } from "./chromeData";

export type ChromeTemplatePart = "header" | "footer" | "announcement";

export interface ChromeTemplate {
    id: string;
    part: ChromeTemplatePart;
    /** i18n keys for the gallery card. */
    nameKey: string;
    descriptionKey: string;
    data: ChromeData;
}

type Translate = (key: string) => string;

const block = (type: string, props: Record<string, unknown> = {}): ChromeBlock => ({ type, props });
const row = (props: Record<string, unknown>, items: ChromeBlock[]): ChromeBlock => block("ChromeRow", { align: "between", gap: "md", ...props, items });
const column = (items: ChromeBlock[]): ChromeBlock => row({ direction: "column", align: "start", gap: "md" }, items);
const doc = (content: ChromeBlock[], root: Record<string, unknown> = {}): ChromeData => ({ root: { props: root }, content });

export function chromeTemplates(t: Translate): ChromeTemplate[] {
    const headerNav = block("ChromeNav", { location: "header", orientation: "horizontal" });
    const logo = block("ChromeLogo", { size: "md" });
    const cta = block("ChromeButton", { label: t("chrome.template.text.cta"), href: "/contact", variant: "primary" });
    const copyright = block("ChromeCopyright", { text: "© {year} {site}" });
    const socials = block("ChromeSocials", { source: "settings" });

    return [
        // ── HEADER ───────────────────────────────────────────────────────────────────────────────
        {
            id: "header-classic",
            part: "header",
            nameKey: "chrome.template.headerClassic",
            descriptionKey: "chrome.template.headerClassic.desc",
            data: doc([row({}, [logo, headerNav])], { sticky: true }),
        },
        {
            id: "header-cta",
            part: "header",
            nameKey: "chrome.template.headerCta",
            descriptionKey: "chrome.template.headerCta.desc",
            data: doc([
                row({}, [
                    logo,
                    row({ align: "end", gap: "md" }, [
                        headerNav,
                        block("ChromeSearch", { placeholder: t("chrome.default.search"), hideMobile: true }),
                        { ...cta, props: { ...cta.props, hideMobile: true } },
                    ]),
                ]),
            ], { sticky: true }),
        },
        {
            id: "header-centered",
            part: "header",
            nameKey: "chrome.template.headerCentered",
            descriptionKey: "chrome.template.headerCentered.desc",
            data: doc([
                row({ align: "center" }, [block("ChromeLogo", { size: "lg" })]),
                row({ align: "center" }, [headerNav]),
            ], { sticky: false }),
        },
        {
            id: "header-two-rows",
            part: "header",
            nameKey: "chrome.template.headerTwoRows",
            descriptionKey: "chrome.template.headerTwoRows.desc",
            data: doc([
                row({ tone: "muted", gap: "sm", hideMobile: true }, [
                    block("ChromeText", { text: t("chrome.template.text.topbar") }),
                    row({ align: "end", gap: "md" }, [block("ChromeLanguageSwitcher", { style: "inline", labels: "code" }), socials]),
                ]),
                row({}, [logo, row({ align: "end", gap: "md" }, [headerNav, { ...cta, props: { ...cta.props, hideMobile: true } }])]),
            ], { sticky: true }),
        },
        {
            id: "header-minimal",
            part: "header",
            nameKey: "chrome.template.headerMinimal",
            descriptionKey: "chrome.template.headerMinimal.desc",
            data: doc([row({}, [logo, block("ChromeNav", { location: "header", orientation: "horizontal", collapse: "always" })])], { sticky: true }),
        },
        {
            id: "header-transparent",
            part: "header",
            nameKey: "chrome.template.headerTransparent",
            descriptionKey: "chrome.template.headerTransparent.desc",
            data: doc([row({}, [logo, row({ align: "end", gap: "md" }, [headerNav, { ...cta, props: { ...cta.props, variant: "ghost", hideMobile: true } }])])], { sticky: true, transparent: true, overlayText: "light", width: "full" }),
        },

        // ── FOOTER ───────────────────────────────────────────────────────────────────────────────
        {
            id: "footer-columns",
            part: "footer",
            nameKey: "chrome.template.footerColumns",
            descriptionKey: "chrome.template.footerColumns.desc",
            data: doc([
                block("ChromeColumns", {
                    columns: "4",
                    gap: "lg",
                    items: [
                        column([block("ChromeLogo", { size: "sm", showTitle: true }), block("ChromeText", { text: t("chrome.template.text.about") })]),
                        column([block("ChromeNav", { location: "footer", orientation: "vertical", title: t("chrome.template.text.links") })]),
                        column([{ ...socials, props: { ...socials.props, title: t("chrome.template.text.follow") } }]),
                        column([block("ChromeWidgets", { area: "footer-1" })]),
                    ],
                }),
                row({ align: "between", gap: "md", wrap: true, stack: "mobile" }, [copyright, block("ChromeLanguageSwitcher", { style: "inline", labels: "native" })]),
            ]),
        },
        {
            id: "footer-simple",
            part: "footer",
            nameKey: "chrome.template.footerSimple",
            descriptionKey: "chrome.template.footerSimple.desc",
            data: doc([
                row({ align: "between", gap: "lg", wrap: true, stack: "mobile" }, [
                    block("ChromeSiteTitle", { showTagline: true }),
                    block("ChromeNav", { location: "footer", orientation: "vertical" }),
                    socials,
                ]),
                row({ align: "center", gap: "sm" }, [copyright]),
            ]),
        },
        {
            id: "footer-centered",
            part: "footer",
            nameKey: "chrome.template.footerCentered",
            descriptionKey: "chrome.template.footerCentered.desc",
            data: doc([
                row({ direction: "column", align: "center", gap: "lg" }, [
                    block("ChromeLogo", { size: "md", showTitle: true }),
                    block("ChromeNav", { location: "footer", orientation: "horizontal" }),
                    socials,
                    copyright,
                ]),
            ]),
        },
        {
            id: "footer-minimal",
            part: "footer",
            nameKey: "chrome.template.footerMinimal",
            descriptionKey: "chrome.template.footerMinimal.desc",
            data: doc([row({ align: "between", gap: "md", wrap: true, stack: "mobile" }, [copyright, socials])]),
        },

        // ── ANNOUNCEMENT BAR ─────────────────────────────────────────────────────────────────────
        {
            id: "announcement-cta",
            part: "announcement",
            nameKey: "chrome.template.announcementCta",
            descriptionKey: "chrome.template.announcementCta.desc",
            data: doc([row({ align: "center", gap: "md" }, [
                block("ChromeText", { text: t("chrome.template.text.announcement") }),
                block("ChromeButton", { label: t("chrome.template.text.learnMore"), href: "/", variant: "ghost" }),
            ])]),
        },
        {
            id: "announcement-text",
            part: "announcement",
            nameKey: "chrome.template.announcementText",
            descriptionKey: "chrome.template.announcementText.desc",
            data: doc([row({ align: "center", gap: "md" }, [block("ChromeText", { text: t("chrome.template.text.announcement") })])]),
        },
    ];
}
