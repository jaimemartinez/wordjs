"use client";

// Composable-chrome EDITOR config (contract v1) for /admin/chrome ONLY. It wraps the SAME
// presentational chrome blocks the public shell renders (components/chrome/*) in thin client-side
// wrappers that resolve their data-bindings (menus by location + public settings) with a one-shot
// client fetch — the blocks themselves stay fetch-free, exactly as on the public site. Kept apart
// from versoConfig.tsx on purpose: the page editor knows nothing about chrome and vice versa, and
// the PUBLIC bundle never imports this file (it lives under app/admin).
import { useContext, useEffect, useState } from "react";
import { menusApi, settingsApi, widgetsApi, type ChromePart } from "@/lib/api";
// Same i18n access the page editor's config factory uses (components/versoConfig.tsx): the config
// is built outside the React tree, so it reads the stored language directly instead of useI18n().
import { t as translate, getStoredLanguage } from "@/lib/i18n";
import { buildChromeBindings, parseChromeSocials, type ChromeBindings } from "@/lib/chromeData";
import ChromeButton from "@/components/chrome/ChromeButton";
import { chromeColumnsClass } from "@/components/chrome/ChromeColumns";
import ChromeCopyright from "@/components/chrome/ChromeCopyright";
import ChromeHeading from "@/components/chrome/ChromeHeading";
import ChromeLanguageSwitcher from "@/components/chrome/ChromeLanguageSwitcher";
import ChromeLogo from "@/components/chrome/ChromeLogo";
import ChromeNav from "@/components/chrome/ChromeNav";
import ChromeRichText from "@/components/chrome/ChromeRichText";
import { chromeRowClass } from "@/components/chrome/ChromeRow";
import ChromeSearch from "@/components/chrome/ChromeSearch";
import ChromeSiteTitle from "@/components/chrome/ChromeSiteTitle";
import ChromeSocials from "@/components/chrome/ChromeSocials";
import ChromeSpacer from "@/components/chrome/ChromeSpacer";
import ChromeText from "@/components/chrome/ChromeText";
import { ChromeRootContext, useHiddenOnDevice } from "./chromeEditorDevice";

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

// Bindings changed outside the canvas (the social profiles panel saved new links): drop the cache and
// tell every mounted wrapper to re-read, so the canvas shows the new icons without a reload.
const BINDINGS_EVENT = "wjs-chrome-bindings";
export function refreshEditorBindings(): void {
    bindingsPromise = null;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(BINDINGS_EVENT));
}

function useEditorBindings(): ChromeBindings | null {
    const [bindings, setBindings] = useState<ChromeBindings | null>(null);
    useEffect(() => {
        let alive = true;
        const load = () => getEditorBindings().then((b) => { if (alive) setBindings(b); });
        load();
        window.addEventListener(BINDINGS_EVENT, load);
        return () => { alive = false; window.removeEventListener(BINDINGS_EVENT, load); };
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

function LogoEdit({ size, showTitle }: { size?: "sm" | "md" | "lg"; showTitle?: boolean }) {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.logo", lang)} />;
    const settings = bindings.settings;
    if (!settings.site_logo && !settings.blogname) return <EmptyHint text={translate("chrome.hint.noLogo", lang)} />;
    return <ChromeLogo size={size} showTitle={showTitle === true} logoUrl={settings.site_logo || null} siteTitle={settings.blogname || ""} />;
}

function SiteTitleEdit({ showTagline }: { showTagline?: boolean }) {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.siteTitle", lang)} />;
    const settings = bindings.settings;
    if (!settings.blogname) return <EmptyHint text={translate("chrome.hint.noSiteTitle", lang)} />;
    return <ChromeSiteTitle showTagline={showTagline} siteTitle={settings.blogname || ""} tagline={settings.blogdescription || ""} />;
}

function NavEdit({ location, orientation, collapse, title }: { location: "header" | "footer"; orientation: "horizontal" | "vertical"; collapse?: "mobile" | "tablet" | "always" | "never"; title?: string }) {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.nav", lang)} />;
    const items = location === "footer" ? bindings.menus.footer : bindings.menus.header;
    if (items.length === 0) {
        const where = translate(location === "footer" ? "chrome.admin.part.footer" : "chrome.admin.part.header", lang);
        return <EmptyHint text={translate("chrome.hint.noMenu", lang).replace("{location}", where)} />;
    }
    return <ChromeNav location={location} orientation={orientation} collapse={collapse} title={title} items={items} />;
}

function SocialsEdit({ title }: { title?: string }) {
    const bindings = useEditorBindings();
    const lang = getStoredLanguage();
    if (!bindings) return <BindingPlaceholder label={translate("chrome.block.socials", lang)} />;
    const links = parseChromeSocials(bindings.settings);
    if (links.length === 0) return <EmptyHint text={translate("chrome.hint.noSocials", lang)} />;
    return <ChromeSocials title={title} links={links} />;
}

function SiteBoundEdit({ render }: { render: (siteTitle: string) => React.ReactNode }) {
    const bindings = useEditorBindings();
    return <>{render(bindings?.settings?.blogname || "")}</>;
}

function RichTextEdit({ html }: { html?: string }) {
    const lang = getStoredLanguage();
    if (!html || !html.trim()) return <EmptyHint text={translate("chrome.hint.emptyText", lang)} />;
    return <SiteBoundEdit render={(site) => <ChromeRichText html={html} siteTitle={site} />} />;
}

function WidgetsEdit({ area }: { area?: string }) {
    const lang = getStoredLanguage();
    const [html, setHtml] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        if (!area) return;
        widgetsApi.renderSidebar(area).then((h) => { if (alive) setHtml(h || ""); }).catch(() => { if (alive) setHtml(""); });
        return () => { alive = false; };
    }, [area]);
    // The canvas shows WHERE the area sits, not its widgets' markup (that is sanitized and rendered on
    // the public page): an empty area says so, a filled one names how much is in it.
    const label = translate("chrome.block.widgets", lang) + (area ? ` · ${area}` : "");
    if (html === null) return <BindingPlaceholder label={label} />;
    return (
        <span className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">
            <i className="fa-solid fa-shapes" aria-hidden="true"></i>
            {label}{html.trim() ? "" : ` — ${translate("chrome.hint.noWidgets", lang)}`}
        </span>
    );
}

// Per-breakpoint visibility in the CANVAS: a block hidden on the device being previewed is drawn
// dimmed with a dashed outline (and named in a tooltip) — the public page drops it, the editor must
// not, or the author could never select it again to undo the choice.
function DeviceVisibility({ props, children }: { props: Record<string, unknown>; children: React.ReactNode }) {
    const hidden = useHiddenOnDevice(props);
    if (!hidden) return <>{children}</>;
    return (
        <span className="wjs-chrome-hidden-here inline-flex opacity-35 outline outline-1 outline-dashed outline-gray-400 rounded" title={translate("chrome.hint.hiddenHere", getStoredLanguage())}>
            {children}
        </span>
    );
}

type ComponentDef = { label: string; fields: Record<string, any>; defaultProps: Record<string, unknown>; render: (props: any) => React.ReactNode };

/**
 * Forma del config de chrome — la declaraba el `Config` del fork; ahora es propia. Deliberadamente
 * laxa en el interior de cada entrada: el único consumidor (chromeVersoAdapter) la re-tipa contra su
 * `LegacyChromeConfigShape` y el test anti-drift compara fields/render POR REFERENCIA.
 */
export interface ChromeEditorConfig {
    components: Record<string, any>;
    root?: any;
}

/** The three "hide on …" switches every block carries (contract commonProps). */
export const VISIBILITY_FIELDS = ["hideMobile", "hideTablet", "hideDesktop"] as const;

// Root props the editor offers per part (contract rootProps): the header decides how it sits on the
// page, the footer only its width. The announcement bar is always a full-bleed band.
export function chromeRootFields(part: ChromePart): Record<string, any> {
    const lang = getStoredLanguage();
    const yesNo = [
        { label: translate("yes", lang), value: true },
        { label: translate("no", lang), value: false },
    ];
    const width = {
        type: "select",
        label: translate("chrome.field.width", lang),
        options: [
            { label: translate("chrome.option.width.container", lang), value: "container" },
            { label: translate("chrome.option.width.full", lang), value: "full" },
        ],
    };
    if (part === "header") {
        return {
            sticky: { type: "radio", label: translate("chrome.field.sticky", lang), options: yesNo },
            transparent: { type: "radio", label: translate("chrome.field.transparent", lang), options: yesNo },
            overlayText: {
                type: "select",
                label: translate("chrome.field.overlayText", lang),
                options: [
                    { label: translate("chrome.option.overlayText.theme", lang), value: "" },
                    { label: translate("chrome.option.overlayText.light", lang), value: "light" },
                    { label: translate("chrome.option.overlayText.dark", lang), value: "dark" },
                ],
            },
            width,
        };
    }
    if (part === "footer") return { width };
    return {};
}

// Config factory, one per part. The root canvas mirrors the EXACT wrapper the public layout puts
// around a composed part ((public)/layout.tsx headerSlot/footerSlot) so what you compose is what
// ships. The caller MUST memoize the result per part — un config no memoizado remonta el lienzo en
// cada pulsación.
export function buildChromeEditorConfig(part: ChromePart): ChromeEditorConfig {
    const lang = getStoredLanguage();
    const tr = (key: string) => translate(key, lang);
    const yesNo = [
        { label: tr("yes"), value: true },
        { label: tr("no"), value: false },
    ];
    const sizeOptions = [
        { label: tr("chrome.option.size.sm"), value: "sm" },
        { label: tr("chrome.option.size.md"), value: "md" },
        { label: tr("chrome.option.size.lg"), value: "lg" },
    ];
    const gapOptions = [
        { label: tr("chrome.option.gap.sm"), value: "sm" },
        { label: tr("chrome.option.gap.md"), value: "md" },
        { label: tr("chrome.option.gap.lg"), value: "lg" },
    ];
    const components: Record<string, ComponentDef> = {
        ChromeLogo: {
            label: tr("chrome.block.logo"),
            fields: {
                size: { type: "select", label: tr("chrome.field.size"), options: sizeOptions },
                showTitle: { type: "radio", label: tr("chrome.field.showTitle"), options: yesNo },
            },
            defaultProps: { size: "md" },
            render: ({ size, showTitle }: any) => <LogoEdit size={size} showTitle={showTitle} />,
        },
        ChromeSiteTitle: {
            label: tr("chrome.block.siteTitle"),
            fields: {
                showTagline: { type: "radio", label: tr("chrome.field.showTagline"), options: yesNo },
            },
            defaultProps: { showTagline: false },
            render: ({ showTagline }: any) => <SiteTitleEdit showTagline={showTagline} />,
        },
        ChromeNav: {
            label: tr("chrome.block.nav"),
            fields: {
                location: {
                    type: "select",
                    label: tr("chrome.field.menuLocation"),
                    options: [
                        { label: tr("chrome.admin.part.header"), value: "header" },
                        { label: tr("chrome.admin.part.footer"), value: "footer" },
                    ],
                },
                orientation: {
                    type: "select",
                    label: tr("chrome.field.orientation"),
                    options: [
                        { label: tr("chrome.option.horizontal"), value: "horizontal" },
                        { label: tr("chrome.option.vertical"), value: "vertical" },
                    ],
                },
                collapse: {
                    type: "select",
                    label: tr("chrome.field.collapse"),
                    options: [
                        { label: tr("chrome.option.collapse.mobile"), value: "mobile" },
                        { label: tr("chrome.option.collapse.tablet"), value: "tablet" },
                        { label: tr("chrome.option.collapse.always"), value: "always" },
                        { label: tr("chrome.option.collapse.never"), value: "never" },
                    ],
                },
                title: { type: "text", label: tr("chrome.field.title") },
            },
            defaultProps: part === "header"
                ? { location: "header", orientation: "horizontal" }
                : { location: "footer", orientation: "vertical" },
            render: ({ location, orientation, collapse, title }: any) => <NavEdit location={location} orientation={orientation} collapse={collapse} title={title} />,
        },
        ChromeSearch: {
            label: tr("chrome.block.search"),
            fields: {
                placeholder: { type: "text", label: tr("chrome.field.placeholder") },
            },
            defaultProps: { placeholder: tr("chrome.default.search") },
            render: ({ placeholder }: any) => <ChromeSearch placeholder={placeholder} />,
        },
        ChromeSocials: {
            label: tr("chrome.block.socials"),
            fields: {
                title: { type: "text", label: tr("chrome.field.title") },
            },
            defaultProps: { source: "settings" },
            render: ({ title }: any) => <SocialsEdit title={title} />,
        },
        ChromeText: {
            label: tr("chrome.block.text"),
            fields: {
                text: { type: "textarea", label: tr("chrome.field.text") },
            },
            defaultProps: { text: tr("chrome.default.text") },
            render: ({ text }: any) => <ChromeText text={text ?? ""} />,
        },
        ChromeHeading: {
            label: tr("chrome.block.heading"),
            fields: {
                text: { type: "text", label: tr("chrome.field.text") },
                level: {
                    type: "select",
                    label: tr("chrome.field.level"),
                    options: [
                        { label: "H2", value: "h2" },
                        { label: "H3", value: "h3" },
                        { label: "H4", value: "h4" },
                    ],
                },
            },
            defaultProps: { text: tr("chrome.default.heading"), level: "h3" },
            render: ({ text, level }: any) => <ChromeHeading text={text ?? ""} level={level} />,
        },
        ChromeRichText: {
            label: tr("chrome.block.richText"),
            fields: {
                html: { type: "textarea", label: tr("chrome.field.html") },
            },
            defaultProps: { html: tr("chrome.default.richText") },
            render: ({ html }: any) => <RichTextEdit html={html} />,
        },
        ChromeCopyright: {
            label: tr("chrome.block.copyright"),
            fields: {
                text: { type: "text", label: tr("chrome.field.copyright") },
            },
            defaultProps: { text: "© {year} {site}" },
            render: ({ text }: any) => <SiteBoundEdit render={(site) => <ChromeCopyright text={text} siteTitle={site} />} />,
        },
        ChromeButton: {
            label: tr("chrome.block.button"),
            fields: {
                label: { type: "text", label: tr("chrome.field.label") },
                href: { type: "text", label: tr("chrome.field.href") },
                variant: {
                    type: "select",
                    label: tr("chrome.field.variant"),
                    options: [
                        { label: tr("chrome.option.primary"), value: "primary" },
                        { label: tr("chrome.option.ghost"), value: "ghost" },
                    ],
                },
            },
            defaultProps: { label: tr("chrome.default.button"), href: "/", variant: "primary" },
            render: ({ label, href, variant }: any) => <ChromeButton label={label ?? ""} href={href ?? ""} variant={variant} />,
        },
        ChromeLanguageSwitcher: {
            label: tr("chrome.block.languages"),
            fields: {
                style: {
                    type: "select",
                    label: tr("chrome.field.style"),
                    options: [
                        { label: tr("chrome.option.style.inline"), value: "inline" },
                        { label: tr("chrome.option.style.dropdown"), value: "dropdown" },
                    ],
                },
                labels: {
                    type: "select",
                    label: tr("chrome.field.labels"),
                    options: [
                        { label: tr("chrome.option.labels.native"), value: "native" },
                        { label: tr("chrome.option.labels.code"), value: "code" },
                    ],
                },
            },
            defaultProps: { style: "inline", labels: "native" },
            render: ({ style, labels }: any) => (
                <span className="inline-flex flex-col items-start gap-1">
                    <ChromeLanguageSwitcher style={style} labels={labels} preview />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400">{tr("chrome.hint.languages")}</span>
                </span>
            ),
        },
        ChromeWidgets: {
            label: tr("chrome.block.widgets"),
            fields: {
                area: { type: "custom", label: tr("chrome.field.area"), render: WidgetAreaField },
            },
            defaultProps: { area: "footer-1" },
            render: ({ area }: any) => <WidgetsEdit area={area} />,
        },
        ChromeSpacer: {
            label: tr("chrome.block.spacer"),
            fields: {
                size: { type: "select", label: tr("chrome.field.size"), options: sizeOptions },
            },
            defaultProps: { size: "md" },
            render: ({ size }: any) => <ChromeSpacer size={size} />,
        },
        ChromeRow: {
            label: tr("chrome.block.row"),
            fields: {
                // v0.20 SLOT (not a zone): the slot prop arrives in render as a component whose
                // className lands on the drop-zone div itself, so we make the ZONE the flex
                // container (same literal classes as the public ChromeRow) and dropped blocks
                // become direct flex children. Depth stays bounded by the save-time validator.
                items: { type: "slot" },
                direction: {
                    type: "select",
                    label: tr("chrome.field.direction"),
                    options: [
                        { label: tr("chrome.option.direction.row"), value: "row" },
                        { label: tr("chrome.option.direction.column"), value: "column" },
                    ],
                },
                align: {
                    type: "select",
                    label: tr("chrome.field.align"),
                    options: [
                        { label: tr("chrome.option.start"), value: "start" },
                        { label: tr("chrome.option.center"), value: "center" },
                        { label: tr("chrome.option.end"), value: "end" },
                        { label: tr("chrome.option.between"), value: "between" },
                    ],
                },
                gap: { type: "select", label: tr("chrome.field.gap"), options: gapOptions },
                wrap: { type: "radio", label: tr("chrome.field.wrap"), options: yesNo },
                stack: {
                    type: "select",
                    label: tr("chrome.field.stack"),
                    options: [
                        { label: tr("chrome.option.stack.never"), value: "never" },
                        { label: tr("chrome.option.stack.mobile"), value: "mobile" },
                        { label: tr("chrome.option.stack.tablet"), value: "tablet" },
                    ],
                },
                tone: {
                    type: "select",
                    label: tr("chrome.field.tone"),
                    options: [
                        { label: tr("chrome.option.tone.none"), value: "none" },
                        { label: tr("chrome.option.tone.muted"), value: "muted" },
                        { label: tr("chrome.option.tone.primary"), value: "primary" },
                        { label: tr("chrome.option.tone.inverse"), value: "inverse" },
                    ],
                },
            },
            defaultProps: { align: "between", gap: "md", wrap: false },
            render: ({ items: Items, ...props }: any) => <Items className={`${chromeRowClass(props)} min-h-12`} />,
        },
        ChromeColumns: {
            label: tr("chrome.block.columns"),
            fields: {
                items: { type: "slot" },
                columns: {
                    type: "select",
                    label: tr("chrome.field.columns"),
                    options: ["2", "3", "4", "5"].map((n) => ({ label: n, value: n })),
                },
                gap: { type: "select", label: tr("chrome.field.gap"), options: gapOptions },
            },
            defaultProps: { columns: "3", gap: "lg" },
            render: ({ items: Items, ...props }: any) => <Items className={`${chromeColumnsClass(props)} min-h-24`} />,
        },
    };

    // Every block carries the three "hide on …" switches, and its canvas render honours them for the
    // previewed device. Wrapped ONCE here, so the adapter keeps reusing render/fields by reference.
    for (const def of Object.values(components)) {
        for (const flag of VISIBILITY_FIELDS) {
            def.fields[flag] = { type: "radio", label: tr(`chrome.field.${flag}`), options: yesNo, group: "visibility" };
        }
        const inner = def.render;
        def.render = (props: any) => <DeviceVisibility props={props}>{inner(props)}</DeviceVisibility>;
    }

    const config: ChromeEditorConfig = {
        components,
        root: {
            render: ({ children }: any) => <RootFrame part={part}>{children}</RootFrame>,
        },
    };
    // The announcement bar bars ChromeNav (chrome-validate's 'announcement' position — the header
    // already owns the one mobile drawer), so it is not offered in the drawer for that part.
    if (part === "announcement") delete (config.components as Record<string, unknown>).ChromeNav;
    return config;
}

// The same wrapper the public layout renders around each part, honouring the composition's root
// props: a transparent header is drawn over a sample hero band (so the author sees what "transparent
// over the hero" means), and a full-width part drops the centred container.
function RootFrame({ part, children }: { part: ChromePart; children: React.ReactNode }) {
    const root = useContext(ChromeRootContext);
    const container = root.width === "full" ? "w-full px-4 md:px-8" : "container mx-auto px-4";
    if (part === "header") {
        // Same wrapper the public layout renders around a composed header (normal-flow, solid surface
        // unless transparent, data-scrolled kept as the stable theme hook).
        const header = (
            <header
                data-scrolled="false"
                data-transparent={root.transparent ? "true" : undefined}
                data-overlay-text={root.transparent ? root.overlayText : undefined}
                className={`wjs-header wjs-chrome-header ${root.transparent ? "absolute inset-x-0 top-0 z-10" : ""} bg-[var(--wjs-bg-surface-glass,white)] shadow-sm py-4`}
            >
                <div className={`wjs-header-container ${container} min-h-16`}>{children}</div>
            </header>
        );
        if (!root.transparent) return header;
        return (
            <div className="relative">
                {header}
                <div aria-hidden="true" className="h-64 bg-gradient-to-br from-slate-700 via-slate-500 to-indigo-400 flex items-end p-6">
                    <span className="text-[10px] font-black uppercase tracking-widest text-white/70">{translate("chrome.hint.sampleHero", getStoredLanguage())}</span>
                </div>
            </div>
        );
    }
    if (part === "announcement") {
        // Same full-bleed band the public layout renders above the header.
        return (
            <aside className="wjs-chrome-announcement w-full bg-[var(--wjs-bg-announcement,var(--wjs-color-primary,#1f2937))] text-[var(--wjs-color-on-primary,#ffffff)] text-sm">
                <div className="wjs-announcement-container container mx-auto px-4 py-2 min-h-8">{children}</div>
            </aside>
        );
    }
    return (
        <footer className="wjs-chrome-footer bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12">
            <div className={`wjs-footer-container ${container} min-h-24`}>{children}</div>
        </footer>
    );
}

// The widget-area picker: the areas registered on this site (core + plugins), loaded on demand.
function WidgetAreaField({ value, onChange, id }: { value: unknown; onChange: (v: unknown) => void; id: string }) {
    const [areas, setAreas] = useState<{ id: string; name: string }[]>([]);
    useEffect(() => {
        let alive = true;
        widgetsApi.listSidebars().then((list) => { if (alive) setAreas(Array.isArray(list) ? list.map((s) => ({ id: s.id, name: s.name })) : []); }).catch(() => {});
        return () => { alive = false; };
    }, []);
    const current = typeof value === "string" ? value : "";
    const options = areas.some((a) => a.id === current) || !current ? areas : [{ id: current, name: current }, ...areas];
    return (
        <select id={id} value={current} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs">
            {options.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
        </select>
    );
}
