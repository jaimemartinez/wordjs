"use client";

// Composable-chrome EDITOR config (contract v1) for /admin/chrome ONLY. It wraps the SAME
// presentational chrome blocks the public shell renders (components/chrome/*) in thin client-side
// wrappers that resolve their data-bindings (menus by location + public settings) with a one-shot
// client fetch — the blocks themselves stay fetch-free, exactly as on the public site. Kept apart
// from puckConfig.tsx on purpose: the page editor knows nothing about chrome and vice versa, and
// the PUBLIC bundle never imports this file (it lives under app/admin).
import { useEffect, useState } from "react";
import type { Config } from "@wordjs/puck";
import { menusApi, settingsApi, type ChromePart } from "@/lib/api";
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
    if (!bindings) return <BindingPlaceholder label="Logo" />;
    const settings = bindings.settings;
    if (!settings.site_logo && !settings.blogname) return <EmptyHint text="Sin logo ni nombre del sitio" />;
    return <ChromeLogo size={size} logoUrl={settings.site_logo || null} siteTitle={settings.blogname || ""} />;
}

function SiteTitleEdit({ showTagline }: { showTagline?: boolean }) {
    const bindings = useEditorBindings();
    if (!bindings) return <BindingPlaceholder label="Título" />;
    const settings = bindings.settings;
    if (!settings.blogname) return <EmptyHint text="Sin nombre del sitio" />;
    return <ChromeSiteTitle showTagline={showTagline} siteTitle={settings.blogname || ""} tagline={settings.blogdescription || ""} />;
}

function NavEdit({ location, orientation }: { location: "header" | "footer"; orientation: "horizontal" | "vertical" }) {
    const bindings = useEditorBindings();
    if (!bindings) return <BindingPlaceholder label="Menú" />;
    const items = location === "footer" ? bindings.menus.footer : bindings.menus.header;
    if (items.length === 0) return <EmptyHint text={`Sin menú en «${location}»`} />;
    return <ChromeNav location={location} orientation={orientation} items={items} />;
}

function SocialsEdit() {
    const bindings = useEditorBindings();
    if (!bindings) return <BindingPlaceholder label="Redes" />;
    const links = parseChromeSocials(bindings.settings);
    if (links.length === 0) return <EmptyHint text="Sin redes (ver Pie de Página)" />;
    return <ChromeSocials links={links} />;
}

// Config factory, one per part. The root canvas mirrors the EXACT wrapper the public layout puts
// around a composed part ((public)/layout.tsx headerSlot/footerSlot) so what you compose is what
// ships. The caller MUST memoize the result per part — an unmemoized Puck config remounts the
// canvas on every keystroke (Puck appearance lesson).
export function buildChromeEditorConfig(part: ChromePart): Config {
    return {
        components: {
            ChromeLogo: {
                label: "Logo",
                fields: {
                    size: {
                        type: "select",
                        label: "Tamaño",
                        options: [
                            { label: "Pequeño", value: "sm" },
                            { label: "Mediano", value: "md" },
                            { label: "Grande", value: "lg" },
                        ],
                    },
                },
                defaultProps: { size: "md" },
                render: ({ size }: any) => <LogoEdit size={size} />,
            },
            ChromeSiteTitle: {
                label: "Título del sitio",
                fields: {
                    showTagline: {
                        type: "radio",
                        label: "Mostrar descripción",
                        options: [
                            { label: "Sí", value: true },
                            { label: "No", value: false },
                        ],
                    },
                },
                defaultProps: { showTagline: false },
                render: ({ showTagline }: any) => <SiteTitleEdit showTagline={showTagline} />,
            },
            ChromeNav: {
                label: "Navegación",
                fields: {
                    location: {
                        type: "select",
                        label: "Menú (ubicación)",
                        options: [
                            { label: "Cabecera", value: "header" },
                            { label: "Pie", value: "footer" },
                        ],
                    },
                    orientation: {
                        type: "select",
                        label: "Orientación",
                        options: [
                            { label: "Horizontal", value: "horizontal" },
                            { label: "Vertical", value: "vertical" },
                        ],
                    },
                },
                defaultProps: part === "header"
                    ? { location: "header", orientation: "horizontal" }
                    : { location: "footer", orientation: "vertical" },
                render: ({ location, orientation }: any) => <NavEdit location={location} orientation={orientation} />,
            },
            ChromeSearch: {
                label: "Buscador",
                fields: {
                    placeholder: { type: "text", label: "Placeholder" },
                },
                defaultProps: { placeholder: "Buscar…" },
                render: ({ placeholder }: any) => <ChromeSearch placeholder={placeholder} />,
            },
            ChromeSocials: {
                label: "Redes sociales",
                fields: {
                    source: {
                        type: "select",
                        label: "Origen",
                        options: [{ label: "Ajustes del sitio", value: "settings" }],
                    },
                },
                defaultProps: { source: "settings" },
                render: () => <SocialsEdit />,
            },
            ChromeText: {
                label: "Texto",
                fields: {
                    text: { type: "textarea", label: "Texto (plano, siempre escapado)" },
                },
                defaultProps: { text: "Texto" },
                render: ({ text }: any) => <ChromeText text={text ?? ""} />,
            },
            ChromeButton: {
                label: "Botón",
                fields: {
                    label: { type: "text", label: "Etiqueta" },
                    href: { type: "text", label: "Enlace (/ruta o https://…)" },
                    variant: {
                        type: "select",
                        label: "Variante",
                        options: [
                            { label: "Primario", value: "primary" },
                            { label: "Fantasma", value: "ghost" },
                        ],
                    },
                },
                defaultProps: { label: "Botón", href: "/", variant: "primary" },
                render: ({ label, href, variant }: any) => <ChromeButton label={label ?? ""} href={href ?? ""} variant={variant} />,
            },
            ChromeSpacer: {
                label: "Separador",
                fields: {
                    size: {
                        type: "select",
                        label: "Tamaño",
                        options: [
                            { label: "Pequeño", value: "sm" },
                            { label: "Mediano", value: "md" },
                            { label: "Grande", value: "lg" },
                        ],
                    },
                },
                defaultProps: { size: "md" },
                render: ({ size }: any) => <ChromeSpacer size={size} />,
            },
            ChromeRow: {
                label: "Fila",
                fields: {
                    // v0.20 SLOT (not a zone): the slot prop arrives in render as a component whose
                    // className lands on the drop-zone div itself, so we make the ZONE the flex
                    // container (same literal classes as the public ChromeRow) and dropped blocks
                    // become direct flex children. Depth stays bounded by the save-time validator.
                    items: { type: "slot" },
                    align: {
                        type: "select",
                        label: "Alineación",
                        options: [
                            { label: "Inicio", value: "start" },
                            { label: "Centro", value: "center" },
                            { label: "Final", value: "end" },
                            { label: "Espaciado", value: "between" },
                        ],
                    },
                    gap: {
                        type: "select",
                        label: "Separación",
                        options: [
                            { label: "Pequeña", value: "sm" },
                            { label: "Mediana", value: "md" },
                            { label: "Grande", value: "lg" },
                        ],
                    },
                    wrap: {
                        type: "radio",
                        label: "Multilínea",
                        options: [
                            { label: "Sí", value: true },
                            { label: "No", value: false },
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
                    <header data-scrolled="false" className="wjs-chrome-header bg-[var(--wjs-bg-surface-glass,white)] shadow-sm py-4">
                        <div className="wjs-header-container container mx-auto px-4 min-h-16">{children}</div>
                    </header>
                ) : (
                    <footer className="wjs-chrome-footer bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12">
                        <div className="wjs-footer-container container mx-auto px-4 min-h-24">{children}</div>
                    </footer>
                ),
        },
    } as Config;
}
