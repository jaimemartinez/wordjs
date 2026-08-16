"use client";

// Composable-chrome EDITOR config (contract v1) for /admin/chrome ONLY. It wraps the SAME
// presentational chrome blocks the public shell renders (components/chrome/*) in thin client-side
// wrappers that resolve their data-bindings (menus by location + public settings) with a one-shot
// client fetch — the blocks themselves stay fetch-free, exactly as on the public site. Kept apart
// from versoConfig.tsx on purpose: the page editor knows nothing about chrome and vice versa, and
// the PUBLIC bundle never imports this file (it lives under app/admin).
import { useEffect, useState } from "react";
import { menusApi, settingsApi, type ChromePart } from "@/lib/api";
// Same i18n access the page editor's config factory uses (components/versoConfig.tsx): the config
// is built outside the React tree, so it reads the stored language directly instead of useI18n().
import { t as translate, getStoredLanguage } from "@/lib/i18n";
import { buildChromeBindings, parseChromeSocials, type ChromeBindings } from "@/lib/chromeData";
import ChromeButton from "@/components/chrome/ChromeButton";
import ChromeLogo from "@/components/chrome/ChromeLogo";
import ChromeNav from "@/components/chrome/ChromeNav";
import { ALIGN_CLASS, GAP_CLASS } from "@/components/chrome/ChromeRow";
import ChromeSearch from "@/components/chrome/ChromeSearch";
import ChromeSiteTitle from "@/components/chrome/ChromeSiteTitle";
import ChromeSocials from "@/components/chrome/ChromeSocials";
import ChromeSpacer from "@/components/chrome/ChromeSpacer";
import ChromeText from "@/components/chrome/ChromeText";

// One-shot client fetch of the data the public RENDERER binds on the server (menus by the same
// 'header'/'footer' locations the public layout queries + the public settings). Module-level cache:
// every wrapper across both parts shares one promise; individual failures degrade to empty
// bindings (the wrappers then show their empty hints) instead of rejecting forever.
let bindingsPromise: Promise<ChromeBindings> | null = null;
function getEditorBindings(): Promise<ChromeBindings> {
    if (!bindingsPromise) {
        bindingsPromise = Promise.all([
            settingsApi.get().catch(() => ({} as Record<string, string>)),
            menusApi.getByLocation("header").catch(() => null),
            menusApi.getByLocation("footer").catch(() => null),
        ]).then(([settings, header, footer]) => buildChromeBindings(settings, header?.items, footer?.items));
    }
    return bindingsPromise;
}

function useEditorBindings(): ChromeBindings | null {
    const [bindings, setBindings] = useState<ChromeBindings | null>(null);
    useEffect(() => {
        let alive = true;
        getEditorBindings().then((b) => { if (alive) setBindings(b); });
        return () => { alive = false; };
    }, []);
    return bindings;
}

// Shown while the bindings fetch is in flight — the block renders SOMETHING selectable/draggable.
function BindingPlaceholder({ label }: { label: string }) {
    return (
        <span className="inline-flex items-center rounded-lg bg-gray-200/80 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 animate-pulse">
            {label}…
        </span>
    );
}

// Shown when the bindings resolved to nothing: the public block would render null/empty, which in
// the canvas means an invisible, unselectable block — surface a hint instead.
function EmptyHint({ text }: { text: string }) {
    return (
        <span className="inline-flex items-center rounded-lg border border-dashed border-gray-300 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
            {text}
        </span>
    );
}

function LogoEdit({ size }: { size?: "sm" | "md" | "lg" }) {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.logo", lang)} />;
    const settings = bindings.settings;
    if (!settings.site_logo && !settings.blogname) return <EmptyHint text={translate("chrome.hint.noLogo", lang)} />;
    return <ChromeLogo size={size} logoUrl={settings.site_logo || null} siteTitle={settings.blogname || ""} />;
}

function SiteTitleEdit({ showTagline }: { showTagline?: boolean }) {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.siteTitle", lang)} />;
    const settings = bindings.settings;
    if (!settings.blogname) return <EmptyHint text={translate("chrome.hint.noSiteTitle", lang)} />;
    return <ChromeSiteTitle showTagline={showTagline} siteTitle={settings.blogname || ""} tagline={settings.blogdescription || ""} />;
}

function NavEdit({ location, orientation }: { location: "header" | "footer"; orientation: "horizontal" | "vertical" }) {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.nav", lang)} />;
    const items = location === "footer" ? bindings.menus.footer : bindings.menus.header;
    if (items.length === 0) {
        const where = translate(location === "footer" ? "chrome.admin.part.footer" : "chrome.admin.part.header", lang);
        return <EmptyHint text={translate("chrome.hint.noMenu", lang).replace("{location}", where)} />;
    }
    return <ChromeNav location={location} orientation={orientation} items={items} />;
}

function SocialsEdit() {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.socials", lang)} />;
    const links = parseChromeSocials(bindings.settings);
    if (links.length === 0) return <EmptyHint text={translate("chrome.hint.noSocials", lang)} />;
    return <ChromeSocials links={links} />;
}

/**
 * Forma del config de chrome — la declaraba el `Config` del fork; ahora es propia. Deliberadamente
 * laxa en el interior de cada entrada: el único consumidor (chromeVersoAdapter) la re-tipa contra su
 * `LegacyChromeConfigShape` y el test anti-drift compara fields/render POR REFERENCIA.
 */
export interface ChromeEditorConfig {
    components: Record<string, any>;
    root?: any;
}

// Config factory, one per part. The root canvas mirrors the EXACT wrapper the public layout puts
// around a composed part ((public)/layout.tsx headerSlot/footerSlot) so what you compose is what
// ships. The caller MUST memoize the result per part — un config no memoizado remonta el lienzo en
// cada pulsación.
export function buildChromeEditorConfig(part: ChromePart): ChromeEditorConfig {
    const lang = getStoredLanguage();
    const config = {
        components: {
            ChromeLogo: {
                label: translate("chrome.block.logo", lang),
                fields: {
                    size: {
                        type: "select",
                        label: translate("chrome.field.size", lang),
                        options: [
                            { label: translate("chrome.option.size.sm", lang), value: "sm" },
                            { label: translate("chrome.option.size.md", lang), value: "md" },
                            { label: translate("chrome.option.size.lg", lang), value: "lg" },
                        ],
                    },
                },
                defaultProps: { size: "md" },
                render: ({ size }: any) => <LogoEdit size={size} />,
            },
            ChromeSiteTitle: {
                label: translate("chrome.block.siteTitle", lang),
                fields: {
                    showTagline: {
                        type: "radio",
                        label: translate("chrome.field.showTagline", lang),
                        options: [
                            { label: translate("yes", lang), value: true },
                            { label: translate("no", lang), value: false },
                        ],
                    },
                },
                defaultProps: { showTagline: false },
                render: ({ showTagline }: any) => <SiteTitleEdit showTagline={showTagline} />,
            },
            ChromeNav: {
                label: translate("chrome.block.nav", lang),
                fields: {
                    location: {
                        type: "select",
                        label: translate("chrome.field.menuLocation", lang),
                        options: [
                            { label: translate("chrome.admin.part.header", lang), value: "header" },
                            { label: translate("chrome.admin.part.footer", lang), value: "footer" },
                        ],
                    },
                    orientation: {
                        type: "select",
                        label: translate("chrome.field.orientation", lang),
                        options: [
                            { label: translate("chrome.option.horizontal", lang), value: "horizontal" },
                            { label: translate("chrome.option.vertical", lang), value: "vertical" },
                        ],
                    },
                },
                defaultProps: part === "header"
                    ? { location: "header", orientation: "horizontal" }
                    : { location: "footer", orientation: "vertical" },
                render: ({ location, orientation }: any) => <NavEdit location={location} orientation={orientation} />,
            },
            ChromeSearch: {
                label: translate("chrome.block.search", lang),
                fields: {
                    placeholder: { type: "text", label: translate("chrome.field.placeholder", lang) },
                },
                defaultProps: { placeholder: "Buscar…" },
                render: ({ placeholder }: any) => <ChromeSearch placeholder={placeholder} />,
            },
            ChromeSocials: {
                label: translate("chrome.block.socials", lang),
                fields: {
                    source: {
                        type: "select",
                        label: translate("chrome.field.source", lang),
                        options: [{ label: translate("chrome.option.settings", lang), value: "settings" }],
                    },
                },
                defaultProps: { source: "settings" },
                render: () => <SocialsEdit />,
            },
            ChromeText: {
                label: translate("chrome.block.text", lang),
                fields: {
                    text: { type: "textarea", label: translate("chrome.field.text", lang) },
                },
                defaultProps: { text: "Texto" },
                render: ({ text }: any) => <ChromeText text={text ?? ""} />,
            },
            ChromeButton: {
                label: translate("chrome.block.button", lang),
                fields: {
                    label: { type: "text", label: translate("chrome.field.label", lang) },
                    href: { type: "text", label: translate("chrome.field.href", lang) },
                    variant: {
                        type: "select",
                        label: translate("chrome.field.variant", lang),
                        options: [
                            { label: translate("chrome.option.primary", lang), value: "primary" },
                            { label: translate("chrome.option.ghost", lang), value: "ghost" },
                        ],
                    },
                },
                defaultProps: { label: "Botón", href: "/", variant: "primary" },
                render: ({ label, href, variant }: any) => <ChromeButton label={label ?? ""} href={href ?? ""} variant={variant} />,
            },
            ChromeSpacer: {
                label: translate("chrome.block.spacer", lang),
                fields: {
                    size: {
                        type: "select",
                        label: translate("chrome.field.size", lang),
                        options: [
                            { label: translate("chrome.option.size.sm", lang), value: "sm" },
                            { label: translate("chrome.option.size.md", lang), value: "md" },
                            { label: translate("chrome.option.size.lg", lang), value: "lg" },
                        ],
                    },
                },
                defaultProps: { size: "md" },
                render: ({ size }: any) => <ChromeSpacer size={size} />,
            },
            ChromeRow: {
                label: translate("chrome.block.row", lang),
                fields: {
                    // v0.20 SLOT (not a zone): the slot prop arrives in render as a component whose
                    // className lands on the drop-zone div itself, so we make the ZONE the flex
                    // container (same literal classes as the public ChromeRow) and dropped blocks
                    // become direct flex children. Depth stays bounded by the save-time validator.
                    items: { type: "slot" },
                    align: {
                        type: "select",
                        label: translate("chrome.field.align", lang),
                        options: [
                            { label: translate("chrome.option.start", lang), value: "start" },
                            { label: translate("chrome.option.center", lang), value: "center" },
                            { label: translate("chrome.option.end", lang), value: "end" },
                            { label: translate("chrome.option.between", lang), value: "between" },
                        ],
                    },
                    gap: {
                        type: "select",
                        label: translate("chrome.field.gap", lang),
                        options: [
                            { label: translate("chrome.option.gap.sm", lang), value: "sm" },
                            { label: translate("chrome.option.gap.md", lang), value: "md" },
                            { label: translate("chrome.option.gap.lg", lang), value: "lg" },
                        ],
                    },
                    wrap: {
                        type: "radio",
                        label: translate("chrome.field.wrap", lang),
                        options: [
                            { label: translate("yes", lang), value: true },
                            { label: translate("no", lang), value: false },
                        ],
                    },
                },
                defaultProps: { align: "between", gap: "md", wrap: false },
                render: ({ items: Items, align, gap, wrap }: any) => (
                    <Items
                        className={`wjs-chrome-row flex items-center w-full min-h-12 ${ALIGN_CLASS[align as keyof typeof ALIGN_CLASS] ?? ALIGN_CLASS.start} ${GAP_CLASS[gap as keyof typeof GAP_CLASS] ?? GAP_CLASS.md}${wrap ? " flex-wrap" : ""}`}
                    />
                ),
            },
        },
        root: {
            render: ({ children }: any) =>
                part === "header" ? (
                    // Same wrapper the public layout renders around a composed header (normal-flow,
                    // solid surface, data-scrolled kept as the stable theme hook).
                    <header data-scrolled="false" className="wjs-header wjs-chrome-header bg-[var(--wjs-bg-surface-glass,white)] shadow-sm py-4">
                        <div className="wjs-header-container container mx-auto px-4 min-h-16">{children}</div>
                    </header>
                ) : part === "announcement" ? (
                    // Same full-bleed band the public layout renders above the header.
                    <aside className="wjs-chrome-announcement w-full bg-[var(--wjs-bg-announcement,var(--wjs-color-primary,#1f2937))] text-[var(--wjs-color-on-primary,#ffffff)] text-sm">
                        <div className="wjs-announcement-container container mx-auto px-4 py-2 min-h-8">{children}</div>
                    </aside>
                ) : (
                    <footer className="wjs-chrome-footer bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12">
                        <div className="wjs-footer-container container mx-auto px-4 min-h-24">{children}</div>
                    </footer>
                ),
        },
    } as ChromeEditorConfig;
    // The announcement bar bars ChromeNav (chrome-validate's 'announcement' position — the header
    // already owns the one mobile drawer), so it is not offered in the drawer for that part.
    if (part === "announcement") delete (config.components as Record<string, unknown>).ChromeNav;
    return config;
}
