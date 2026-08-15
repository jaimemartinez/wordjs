"use client";

import { Puck, Config, Data, migrate, useGetPuck, createUsePuck, ActionBar } from "@wordjs/puck";
import "@wordjs/puck/puck.css";
import "./puck-theme.css";
import React, { useState, useEffect, useRef } from "react";
import ModernSelect from "./ModernSelect";
import PublicLayoutShell from "@/components/public/PublicLayoutShell";
import { CanvasThemeTemplate, CanvasTemplateContext, type CanvasTemplateInfo } from "@/components/editor/CanvasThemeTemplate";
import type { TemplateKind } from "@/lib/templateData";
import { puckConfig } from "./puckConfig";
import RevisionsSidebar from "./RevisionsSidebar";
import BlockInserter from "./BlockInserter";
import CommandPalette from "./CommandPalette";
import { PATTERNS, insertPattern, regenIds } from "@/lib/puckPatterns";
import InlineTiptap from "./InlineTiptap";
import { hideClasses } from "./puck/VisibilityField";
import { replayAnimations } from "./puck/AnimationField";
import { themeStylesheetHref, uiFrameworkHref } from "@/lib/assetVersion";
import { blockVars, unit } from "./puck/blockVars";
import { revisionsApi, Revision, themesApi } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";
import { sanitizeHTML } from "@/lib/sanitize";
import MSym from "./editor/MSym";
import MediaPickerModal from "./MediaPickerModal";
import { BLOCK_META } from "@/lib/blockCatalog";
import { setOutlineMode, showSpacingOverlay } from "./editor/canvasGuides";
import { runA11yAudit, A11yPanel, type A11yIssue } from "./editor/A11yAudit";
import { symbolsApi } from "@/lib/symbols";
import ReviewComments from "./editor/ReviewComments";

// Viewport switcher + responsive preview frame. The canvas renders in an iframe (#preview-frame; see
// <Puck iframe>) that fills its container, so we drive responsiveness by sizing the container to the
// chosen DEVICE width — the iframe follows and its own viewport drives the page's Tailwind md:/lg:
// breakpoints, matching the live site. (Puck's built-in viewport/zoom is NOT applied by <Puck.Preview>
// in composition mode, so we size + scale-to-fit ourselves; see PreviewFrame.)
type ViewportKey = "desktop" | "tablet" | "mobile";

// Selector-based Puck store hook (reactive, unlike useGetPuck) — must render inside <Puck>.
const usePuck = createUsePuck();

// ---- Block clipboard (copy/paste across pages; ids regenerated on paste via regenIds) ----
const BLOCK_CLIPBOARD_KEY = "wjs_block_clipboard";
// Style clipboard (Elementor-style "copy styles" between blocks — the shared look/anim/hide props).
const STYLE_CLIPBOARD_KEY = "wjs_style_clipboard";

const writeBlockClipboard = (item: any) => {
    try { localStorage.setItem(BLOCK_CLIPBOARD_KEY, JSON.stringify(item)); } catch { /* storage full/blocked */ }
};
const readBlockClipboard = (): any | null => {
    try {
        const raw = localStorage.getItem(BLOCK_CLIPBOARD_KEY);
        const item = raw ? JSON.parse(raw) : null;
        return item && item.type && item.props ? item : null;
    } catch { return null; }
};

// Undo/redo header buttons. Selectors keep them live; actions go through the store directly.
function HistoryControls() {
    const { language } = useI18n();
    const hasPast = usePuck((s: any) => s.history.hasPast);
    const hasFuture = usePuck((s: any) => s.history.hasFuture);
    const getPuck = useGetPuck();
    const btn = (enabled: boolean, icon: string, title: string, onClick: () => void) => (
        <button
            type="button"
            title={title}
            disabled={!enabled}
            onClick={onClick}
            className={`p-1.5 rounded-md flex items-center justify-center transition-colors ${
                enabled
                    ? "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                    : "text-[var(--ed-outline-variant)] cursor-not-allowed"
            }`}
        >
            <MSym name={icon} size={20} />
        </button>
    );
    return (
        <div className="flex items-center gap-0.5">
            {btn(hasPast, "undo", trStr("Deshacer (Ctrl+Z)", language), () => getPuck().history.back())}
            {btn(hasFuture, "redo", trStr("Rehacer (Ctrl+Shift+Z)", language), () => getPuck().history.forward())}
        </div>
    );
}

/**
 * Header save-state chip, per the design: a filled cloud_done + "Guardado hace Xm" when clean,
 * cloud_upload while dirty, a spinning sync while a save is in flight. Re-renders on a 30s tick so
 * the relative time stays honest without the parent re-rendering. The span stays MOUNTED (and
 * merely sr-only below xl) so its aria-live region exists before its content changes — an
 * announcement region that appears together with its first message is not announced.
 */
function SaveStateChip({ saving, hasChanges, savedAt, wasAuto, status }: {
    saving: boolean; hasChanges: boolean; savedAt: Date | null; wasAuto: boolean; status: string;
}) {
    const { language } = useI18n();
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick((x) => x + 1), 30000);
        return () => clearInterval(t);
    }, []);
    let icon: React.ReactNode = null;
    let text = "";
    let cls = "text-[var(--ed-outline)]";
    if (saving) {
        icon = <MSym name="sync" size={16} className="animate-spin" />;
        text = trStr("Guardando…", language);
    } else if (hasChanges) {
        icon = <MSym name="cloud_upload" size={16} />;
        text = status === "draft" ? trStr("Sin guardar", language) : trStr("Cambios sin publicar", language);
        cls = "text-amber-700";
    } else if (savedAt) {
        icon = <MSym name="cloud_done" size={16} fill className="text-[var(--ed-primary)]" />;
        const mins = Math.max(0, Math.round((Date.now() - savedAt.getTime()) / 60000));
        // Whole-string templates — word order differs per language; concatenation can't translate.
        text = mins < 1
            ? (wasAuto ? trStr("Autoguardado", language) : trStr("Guardado", language))
            : trStr(wasAuto ? "Autoguardado hace {m}m" : "Guardado hace {m}m", language).replace("{m}", String(mins));
    }
    return (
        <span className={`sr-only xl:not-sr-only xl:flex items-center gap-1.5 text-[11px] select-none ${cls}`} aria-live="polite">
            {icon}
            {text}
        </span>
    );
}

/**
 * EditorHotkeys — global keyboard layer (renders nothing). Attached in CAPTURE phase on both the
 * editor window and the canvas iframe window (cross-realm safe: no instanceof checks):
 *   Ctrl/Cmd+S save · Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (or Y) undo/redo · Ctrl/Cmd+D duplicate ·
 *   Supr delete · Ctrl/Cmd+C/V copy/paste the selected block (localStorage → works across pages).
 * Block-level keys are ignored while typing (inputs/contenteditable/inline Tiptap active).
 */
function EditorHotkeys({ onSave, onCommandPalette, components }: { onSave?: () => void; onCommandPalette?: () => void; components: Record<string, any> }) {
    const getPuck = useGetPuck();
    const onSaveRef = useRef(onSave);
    const onCommandPaletteRef = useRef(onCommandPalette);
    const componentsRef = useRef(components);
    React.useEffect(() => {
        onSaveRef.current = onSave;
        onCommandPaletteRef.current = onCommandPalette;
        componentsRef.current = components;
    });

    React.useEffect(() => {
        const isTypingTarget = (t: any): boolean =>
            !!(t && typeof t.closest === "function" &&
                t.closest('input, textarea, select, [contenteditable="true"], .ProseMirror'));
        const inlineEditing = () => !!((window as any).puckActiveEditorId);

        const pasteBlock = (sel: { index: number; zone?: string } | null) => {
            const clip = readBlockClipboard();
            if (!clip) return;
            if (!componentsRef.current[clip.type]) return; // block type not available in this config
            const item = regenIds(clip);
            getPuck().dispatch({
                type: "setData",
                data: (prev: any) => {
                    const content = [...(prev.content || [])];
                    // Paste after the selection when it lives in the root content; otherwise append.
                    const inRoot = sel && (!sel.zone || /(^|:)(default-zone|content)$/.test(sel.zone));
                    const at = inRoot ? Math.min(sel!.index + 1, content.length) : content.length;
                    content.splice(at, 0, item);
                    return { ...prev, content };
                },
                recordHistory: true, // make paste undoable (programmatic setData skips history by default)
            });
        };

        const onKey = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();

            if (mod && key === "s") {
                e.preventDefault();
                e.stopPropagation();
                onSaveRef.current?.();
                return;
            }

            // ⌘K / Ctrl+K — toggle the command palette. Handled BEFORE the typing-target guard so it
            // opens from anywhere (a focused field, or focus inside the canvas iframe).
            if (mod && key === "k") {
                e.preventDefault();
                e.stopPropagation();
                onCommandPaletteRef.current?.();
                return;
            }

            if (isTypingTarget(e.target) || inlineEditing()) return;

            const puck = getPuck();
            if (mod && key === "z" && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                if (puck.history.hasPast) puck.history.back();
                return;
            }
            if ((mod && key === "z" && e.shiftKey) || (mod && key === "y")) {
                e.preventDefault();
                e.stopPropagation();
                if (puck.history.hasFuture) puck.history.forward();
                return;
            }

            const sel = puck.appState.ui.itemSelector as { index: number; zone?: string } | null;

            if (mod && key === "v") {
                e.preventDefault();
                e.stopPropagation();
                pasteBlock(sel);
                return;
            }
            if (!sel) return;

            if (e.key === "Delete") {
                e.preventDefault();
                e.stopPropagation();
                puck.dispatch({ type: "remove", index: sel.index, zone: sel.zone ?? "root:default-zone" });
                return;
            }
            if (mod && key === "d") {
                e.preventDefault();
                e.stopPropagation();
                puck.dispatch({ type: "duplicate", sourceIndex: sel.index, sourceZone: sel.zone ?? "root:default-zone" });
                return;
            }
            if (mod && key === "c") {
                // Don't hijack a real text copy — only act when nothing is text-selected.
                const winSel = window.getSelection();
                if (winSel && !winSel.isCollapsed) return;
                const item = (puck as any).selectedItem;
                if (item) writeBlockClipboard(item);
                return;
            }
        };

        window.addEventListener("keydown", onKey, true);
        // The canvas iframe has its own event realm — attach there too (poll until mounted, and
        // re-check periodically in case the iframe reloads).
        const attached = new WeakSet<Window>();
        const hook = () => {
            const iframe = document.querySelector(".puck-container iframe") as HTMLIFrameElement | null;
            const win = iframe?.contentWindow;
            if (win && !attached.has(win)) {
                try {
                    win.addEventListener("keydown", onKey, true);
                    attached.add(win);
                } catch { /* cross-origin (never expected) */ }
            }
        };
        hook();
        const t = setInterval(hook, 1000);
        return () => {
            clearInterval(t);
            window.removeEventListener("keydown", onKey, true);
            const iframe = document.querySelector(".puck-container iframe") as HTMLIFrameElement | null;
            try { iframe?.contentWindow?.removeEventListener("keydown", onKey, true); } catch { /* gone */ }
        };
    }, [getPuck]);

    return null;
}
const VIEWPORT_WIDTH: Record<ViewportKey, number> = { desktop: 1280, tablet: 768, mobile: 375 };
const EDITOR_VIEWPORTS: { key: ViewportKey; icon: string; label: string }[] = [
    { key: "desktop", icon: "desktop_windows", label: "Escritorio" },
    { key: "tablet", icon: "tablet_mac", label: "Tableta" },
    { key: "mobile", icon: "smartphone", label: "Móvil" },
];

// Device switcher — the design's segmented control: a surface-container track with the active
// segment lifted onto a white chip.
function ViewportControls({ value, onChange }: { value: ViewportKey; onChange: (v: ViewportKey) => void }) {
    const { language } = useI18n();
    return (
        <div className="hidden lg:flex items-center bg-[var(--ed-surface-container)] p-0.5 rounded-lg">
            {EDITOR_VIEWPORTS.map((v) => (
                <button
                    key={v.key}
                    title={trStr(v.label, language)}
                    aria-label={trStr(v.label, language)}
                    aria-pressed={value === v.key}
                    onClick={() => onChange(v.key)}
                    className={`px-2 py-1 rounded-md flex items-center justify-center transition-colors ${
                        value === v.key
                            ? "bg-white shadow-sm text-[var(--ed-primary)]"
                            : "text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-primary)]"
                    }`}
                >
                    <MSym name={v.icon} size={18} />
                </button>
            ))}
        </div>
    );
}

/**
 * Per-block toolbar override — Puck's stock bar (label · edit · duplicate · delete) plus the
 * design's MOVE UP / MOVE DOWN arrows (Gutenberg parity: reordering without drag). Composes the
 * fork's public <ActionBar> primitives; the reorder goes through the store's own action so it
 * lands in history. The zone length (for clamping "down" at the end) comes from the internal
 * store bridge — optional-chained, so if that internal ever moves the arrows simply stop
 * clamping instead of crashing.
 */
function ActionBarOverride({ label, children, parentAction }: any) {
    const getPuck = useGetPuck();
    const { language } = useI18n();
    const move = (dir: -1 | 1) => {
        const puck = getPuck();
        const sel = puck.appState.ui.itemSelector as { index: number; zone?: string } | null;
        if (!sel) return;
        const zone = sel.zone ?? "root:default-zone";
        const dest = sel.index + dir;
        if (dest < 0) return;
        const len = (window as any).__PUCK_INTERNAL_DO_NOT_USE?.appStore?.getState?.()
            ?.state?.indexes?.zones?.[zone]?.contentIds?.length;
        if (typeof len === "number" && dest >= len) return;
        puck.dispatch({ type: "reorder", sourceIndex: sel.index, destinationIndex: dest, destinationZone: zone });
        // Selection follows the moved block (Gutenberg behaviour) — reorder alone leaves the
        // selector pointing at the old index, so a second click would move the WRONG block.
        puck.dispatch({ type: "setUi", ui: { itemSelector: { index: dest, zone } } });
    };
    return (
        <ActionBar>
            <ActionBar.Group>
                {parentAction}
                {label && <ActionBar.Label label={label} />}
            </ActionBar.Group>
            <ActionBar.Group>
                <ActionBar.Action onClick={() => move(-1)} label={trStr("Subir", language)}>
                    <MSym name="expand_less" size={16} />
                </ActionBar.Action>
                <ActionBar.Action onClick={() => move(1)} label={trStr("Bajar", language)}>
                    <MSym name="expand_more" size={16} />
                </ActionBar.Action>
            </ActionBar.Group>
            <ActionBar.Group>{children}</ActionBar.Group>
        </ActionBar>
    );
}

/**
 * Canvas guides (Webflow-style): dashed outlines on every block + a padding/margin measure overlay
 * on the SELECTED block, following it through selection changes and canvas scroll. Lives inside
 * <Puck> so it can watch the selection; the actual painting is DOM-only (editor/canvasGuides.ts)
 * inside the iframe document.
 */
function GuidesController({ enabled }: { enabled: boolean }) {
    const selId = usePuck((s: any) => s.selectedItem?.props?.id);
    useEffect(() => {
        const doc = (document.querySelector(".puck-container iframe") as HTMLIFrameElement | null)?.contentDocument;
        if (!doc) return;
        setOutlineMode(doc, enabled);
        if (!enabled) { showSpacingOverlay(doc, null); return; }
        const paint = () => showSpacingOverlay(doc, selId ? doc.querySelector(`[data-puck-component="${selId}"]`) : null);
        paint();
        doc.addEventListener("scroll", paint, true);
        doc.defaultView?.addEventListener("resize", paint);
        return () => {
            doc.removeEventListener("scroll", paint, true);
            doc.defaultView?.removeEventListener("resize", paint);
            showSpacingOverlay(doc, null);
        };
    }, [enabled, selId]);
    return null;
}

// While a block drag is live, the design shows a guide pill at the bottom of the canvas. The flag
// is public Puck state, so this stays a pure reader (renders nothing when idle).
function DragHint() {
    const { language } = useI18n();
    const isDragging = usePuck((s: any) => s.appState.ui.isDragging);
    if (!isDragging) return null;
    return (
        <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-[70] px-4 py-2 rounded-full bg-[var(--ed-inverse-surface)] text-[var(--ed-inverse-on-surface)] text-[12px] font-medium shadow-lg flex items-center gap-2 pointer-events-none whitespace-nowrap">
            <MSym name="info" size={18} />
            {trStr("Arrastra a una zona iluminada para añadir el bloque", language)}
        </div>
    );
}

// Renders the canvas iframe (#preview-frame) per viewport: DESKTOP fills the whole preview area (full
// width + height, like a normal editing canvas — no frame); MOBILE/TABLET render at their true device
// width inside a scaled device frame. The iframe fills its box, so its own viewport drives the page's
// responsive CSS — making the preview match the live site at each breakpoint.
function PreviewFrame({ viewport, children }: { viewport: ViewportKey; children?: React.ReactNode }) {
    const areaRef = React.useRef<HTMLDivElement>(null);
    const [area, setArea] = React.useState({ w: 0, h: 0 });
    React.useEffect(() => {
        const el = areaRef.current;
        if (!el) return;
        const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    // The page scrolls INSIDE the iframe, so its scrollbar is the browser default (chunky on Windows,
    // and out of place inside the phone/tablet bezel). Inject a thin, subtle scrollbar into the iframe
    // document. Polls until the iframe (#preview-frame) is mounted, then injects once.
    React.useEffect(() => {
        const STYLE_ID = "wjs-preview-scrollbar";
        const css =
            "::-webkit-scrollbar{width:9px;height:9px}" +
            "::-webkit-scrollbar-track{background:transparent}" +
            "::-webkit-scrollbar-thumb{background:rgba(100,116,139,.3);border-radius:9px}" +
            "::-webkit-scrollbar-thumb:hover{background:rgba(100,116,139,.55)}" +
            "html{scrollbar-width:thin;scrollbar-color:rgba(100,116,139,.3) transparent}";
        let done = false;
        const tick = () => {
            const iframe = document.querySelector(".puck-container iframe") as HTMLIFrameElement | null;
            const doc = iframe?.contentDocument;
            if (!doc?.head) return;
            if (!doc.getElementById(STYLE_ID)) {
                const s = doc.createElement("style");
                s.id = STYLE_ID;
                s.textContent = css;
                doc.head.appendChild(s);
            }
            done = true;
        };
        tick();
        const t = setInterval(() => (done ? clearInterval(t) : tick()), 400);
        const stop = setTimeout(() => clearInterval(t), 10000);
        return () => {
            clearInterval(t);
            clearTimeout(stop);
        };
    }, []);
    // ── EDITOR DOCUMENT CONTRACT ────────────────────────────────────────────────────────────────────
    // The canvas iframe deliberately loads the ACTIVE THEME's CSS (below) so the content renders like the
    // live site. But a theme's document-level rules (`html,body{…}`) must NEVER hijack the mechanics the
    // editor depends on: Puck computes its action-overlay position and the outline's scroll from a SINGLE
    // scroll container (the iframe's <html>) and an UNTRANSFORMED root. A theme that set, say,
    // `html,body{overflow-x:hidden}` turned <body> into a SECOND, nested scroll container (paired with the
    // app's `body{height:100%}`) — a double scroll that pushed the action buttons off-position and made the
    // outline scroll the wrong element. A theme transform on the root would likewise break the fixed-position
    // overlay. So the editor pins an inviolable scroll/stacking model here, winning by SPECIFICITY (`:root`
    // and `:root>body` outrank any theme's `html`/`body` element selector) — so it holds no matter what the
    // page brings, and regardless of stylesheet order. The visualizer is immutable against the page it edits.
    React.useEffect(() => {
        const STYLE_ID = "wjs-editor-doc-contract";
        const css =
            ":root{height:100%!important;overflow-x:hidden!important;overflow-y:auto!important;transform:none!important;filter:none!important;perspective:none!important}" +
            ":root>body{height:auto!important;min-height:100%!important;max-height:none!important;overflow:visible!important;transform:none!important;filter:none!important;perspective:none!important;margin:0!important}" +
            // The AutoFrame mount (#frame-root / [data-puck-entry]) must GROW with content so the iframe's
            // <html> stays the SINGLE scroll container. Puck ships `#frame-root{height:1px;min-height:100vh}`
            // for exactly this, but the app's global `html,body{height:100%}` (mirrored into the canvas by
            // AutoFrame's CopyHostStyles) collapses the mount to the viewport height — so a page taller than
            // the canvas can't scroll and everything below the fold is clipped. Re-assert the grow model.
            "#frame-root,[data-puck-entry]{height:auto!important;min-height:100vh!important;max-height:none!important}";
        const tick = () => {
            const iframe = document.querySelector(".puck-container iframe") as HTMLIFrameElement | null;
            const doc = iframe?.contentDocument;
            if (!doc?.head) return;
            let s = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
            if (!s) {
                s = doc.createElement("style");
                s.id = STYLE_ID;
                s.textContent = css;
                doc.head.appendChild(s);
            } else if (s.textContent !== css) {
                s.textContent = css;
            }
        };
        tick();
        // Re-assert for the WHOLE editor lifetime — NOT once. AutoFrame reloads the iframe (new srcDoc →
        // new document) and CopyHostStyles re-clones the parent stylesheets on mutation; either drops the
        // contract. The check is idempotent and dirt-cheap (one querySelector + id lookup), so keep it
        // running until unmount instead of stopping after the first success (the old bug that let the
        // contract silently vanish and took the canvas's scroll + overlay math with it).
        const t = setInterval(tick, 700);
        return () => clearInterval(t);
    }, []);
    // WYSIWYG: load the shared WordJS UI framework + the ACTIVE theme stylesheet into the preview iframe
    // so the canvas content (typography, tables, buttons, components, utilities) renders like the public
    // site. Only the iframe canvas is themed — Puck's editing chrome lives outside it. Idempotent + id-
    // guarded, so it's a safe no-op if the public layout already injected these into the iframe.
    React.useEffect(() => {
        let cancelled = false;
        let activeSlug: string | null = null;
        let activeVersion = "";
        const ensureLink = (doc: Document, id: string, href: string): HTMLLinkElement => {
            let l = doc.getElementById(id) as HTMLLinkElement | null;
            if (!l) {
                l = doc.createElement("link");
                l.id = id;
                l.rel = "stylesheet";
            }
            if (l.getAttribute("href") !== href) l.setAttribute("href", href);
            return l;
        };
        const inject = () => {
            const iframe = document.querySelector(".puck-container iframe") as HTMLIFrameElement | null;
            const doc = iframe?.contentDocument;
            if (!doc?.head || !activeSlug) return;
            // Version-stamped exactly like the public site's ThemeLoader (same helpers). Both files are
            // served with a ~1-day Cache-Control, so without ?v= the canvas kept serving the PREVIOUS
            // release's CSS for a day after an update — the editor would disagree with the live site
            // about spacing, hover effects and animations, with nothing on screen to explain why. The
            // theme's own version rides along so an in-place theme edit busts the canvas copy too.
            const ui = ensureLink(doc, "wjs-ui-framework", uiFrameworkHref());
            const theme = ensureLink(doc, "wjs-theme-stylesheet", themeStylesheetHref(activeSlug, activeVersion));
            // CASCADE CONTRACT: the framework's :root declares default values for the canonical
            // --wjs-* tokens, so the theme sheet must sit AFTER it or every theme renders half-default
            // in the canvas. AutoFrame document reloads clone links back in arbitrary positions (and
            // sometimes into <body>), so presence alone isn't enough — enforce the order and drop any
            // unmanaged clones, or a stale/misordered pair survives the whole session.
            if (ui.parentNode !== doc.head) doc.head.appendChild(ui);
            if (theme.parentNode !== doc.head || !(ui.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                doc.head.appendChild(theme);
            }
            doc.querySelectorAll('link[href*="/themes/"]:not(#wjs-theme-stylesheet), link[href*="wordjs-ui.css"]:not(#wjs-ui-framework)')
                .forEach((n) => n.remove());
        };
        const resolveSlug = () => {
            themesApi.list().then((list) => {
                if (cancelled) return;
                const active = list.find((t) => t.active) || list.find((t) => t.slug === "default");
                const slug = active?.slug || "default";
                const version = active?.version || "";
                if (slug !== activeSlug || version !== activeVersion) {
                    activeSlug = slug;
                    activeVersion = version;
                    inject();
                }
            }).catch(() => {
                if (!activeSlug) { activeSlug = "default"; inject(); } // offline fallback, never stay linkless
            });
        };
        resolveSlug();
        // Re-assert for the WHOLE editor lifetime (same lesson as the doc contract above): AutoFrame
        // reloads the iframe and the fresh document inherits cloned, mis-ordered, possibly stale links
        // with nobody left to fix them if this stops after a warm-up window. The slug poll also tracks
        // theme switches made from another tab while the editor is open.
        const t = setInterval(inject, 700);
        const slugTimer = setInterval(resolveSlug, 10000);
        return () => {
            cancelled = true;
            clearInterval(t);
            clearInterval(slugTimer);
        };
    }, []);
    const isDesktop = viewport === "desktop";
    // Every viewport renders at its TRUE device width and scales to fit, floating as a page card on
    // the design's dotted surface. Desktop = a bordered white card (the design's canvas); mobile/
    // tablet keep the device bezel. Rendering desktop at 1280 (not the available width) is what the
    // "Desktop" preset promises: the page's lg: breakpoint styles, identical on every monitor.
    // On a PHONE (narrow editor window) the switcher is hidden and the page simply renders at the
    // real available width — the design's mobile canvas, no bezel, no downscaling.
    const isNarrow = area.w > 0 && area.w < 640;
    const PAD = isNarrow ? 12 : isDesktop ? 28 : 24;
    const availW = Math.max(280, area.w - PAD * 2);
    const availH = Math.max(320, area.h - PAD * 2);
    const frameW = isNarrow ? availW : VIEWPORT_WIDTH[viewport];
    const scale = Math.min(1, availW / frameW);
    const innerH = availH / scale; // inner height so that, once scaled, it exactly fills the area height
    return (
        <div ref={areaRef} className="flex-1 relative overflow-hidden bg-[var(--ed-surface-container-low)] h-full min-h-0">
            {/* Dotted grid — the design's canvas surface, behind every device frame */}
            <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: "radial-gradient(#c8c4d5 0.5px, transparent 0.5px)", backgroundSize: "20px 20px" }}></div>
            {/* OUTER box = on-screen (scaled) footprint so it centers cleanly; INNER box = true device
                width, scaled into it. The iframe (Puck.Preview) fills the inner box, so its viewport
                equals the device width. Puck.Preview stays in one DOM position across viewports so the
                iframe never reloads when switching. */}
            <div className="absolute inset-0 flex items-start justify-center" style={{ padding: PAD }}>
                <div
                    className={`relative z-10 bg-white overflow-hidden shrink-0 ${isNarrow ? "rounded-xl border border-[var(--ed-outline-variant)] shadow-lg" : isDesktop ? "border border-[var(--ed-outline-variant)] shadow-lg" : "rounded-[2rem] ring-[7px] ring-gray-900 shadow-2xl"}`}
                    style={{ width: frameW * scale, height: availH }}
                >
                    <div className="absolute top-0 left-0 origin-top-left" style={{ width: frameW, height: innerH, transform: scale === 1 ? "none" : `scale(${scale})` }}>
                        <div className="w-full h-full">
                            <Puck.Preview />
                        </div>
                    </div>
                </div>
            </div>
            {children}
        </div>
    );
}

interface PuckEditorProps {
    initialData?: Data;
    onChange: (data: Data) => void;
    status?: string;
    onStatusChange?: (status: string) => void;
    saving?: boolean;
    hasChanges?: boolean;
    /** Called with {autosave:true} for background saves (parent should skip alerts/revisions).
     *  Return `false` to signal a FAILED/BLOCKED save — the parents swallow their own errors
     *  (alert + return), so without this signal the editor would announce success for saves that
     *  never happened. void/true = success (back-compat). */
    onSave?: (opts?: { autosave?: boolean }) => boolean | void | Promise<boolean | void>;
    onCancel?: () => void;
    config?: Config;
    pageId?: number;
    /** Slug of the post/page being edited — enables the "Preview" button (/preview/slug). */
    previewSlug?: string;
    /** Breadcrumb root label (Spanish source string, translated via trStr) — "Entradas" for posts. */
    breadcrumbRoot?: string;
    /**
     * OLA 3 — which theme page-template the canvas previews the content inside. `page` (the default,
     * used by the page editor) or `single` (the post editor). The canvas resolves the theme's matching
     * template through the same hierarchy the public route uses.
     */
    templateKind?: TemplateKind;
    /** Post type for a `single` route (e.g. "post"), so the hierarchy can prefer single-post templates. */
    templatePostType?: string;
}

// Context for Inline Editing
export const EditorContext = React.createContext<{
    updateComponent: (id: string, newProps: any) => void;
    activeEditorId: string | null;
    setActiveEditorId: (id: string | null) => void;
} | null>(null);

// Inline Text Component - Simple Textarea Swap
const InlineText = ({ id, content, title, elementId, level, color, size, weight, tracking, leading, measure }: any) => {
    const ctx = React.useContext(EditorContext);

    // Distinguish Text (content) vs Heading (title) by which prop is DEFINED, not by truthiness —
    // so an intentionally-emptied text body stays "" instead of falling back to the title.
    const isTextBlock = content !== undefined;
    const actualContent = (isTextBlock ? content : title) ?? "";

    // isEditing is REACTIVE via the 'puck-editor-change' event (the active id lives in a window
    // global because the Puck config is memoized/stable and can't close over React state).
    const readActiveId = (): string | null => {
        if (typeof window === 'undefined') return null;
        return (window as any).puckActiveEditorId ?? (window.parent as any)?.puckActiveEditorId ?? null;
    };
    const [activeId, setActiveId] = React.useState<string | null>(readActiveId);
    React.useEffect(() => {
        const handler = (e: any) => setActiveId(e?.detail ?? readActiveId());
        window.addEventListener('puck-editor-change', handler as EventListener);
        return () => window.removeEventListener('puck-editor-change', handler as EventListener);
    }, []);
    const isEditing = activeId === id;

    // WYSIWYG: wear the SAME contract class + variables the published block renders with, so the
    // canvas shows the active theme's real heading scale and body typography. Without this the
    // editor fell back to generic `prose` and every heading looked like a paragraph — the one
    // place the promise "what you see is what you get" is most visible.
    // Exactly the class list the published block renders with — `prose` included, so Tailwind
    // Typography and the contract resolve against each other here the same way they do live.
    const blockClass = isTextBlock ? "wp-block-text prose max-w-none" : `wp-block-heading heading-${level || "h2"}`;
    const blockStyle = isTextBlock
        ? blockVars("text", { color, size: unit(size), leading, measure: unit(measure) })
        : blockVars("heading", { color, size: unit(size), weight, tracking: unit(tracking) });

    // The inline editor opens ONLY via the per-block "Edit" (pencil) action in Puck's overlay
    // (patch-puck-actions.js → window.puckSetActiveEditorId). A bare click on the text falls through
    // to Puck (selects the block + shows its action bar), so editing is always intentional. The
    // editing surface, commit-on-blur, and the window.puckCommitActive flusher are owned by the
    // in-place <InlineTiptap/> below.

    if (!ctx || !id) {
        return (
            <div
                id={elementId || undefined}
                className={blockClass}
                style={blockStyle}
                dangerouslySetInnerHTML={{ __html: sanitizeHTML(actualContent) }}
            />
        );
    }

    return (
        <>
            {/* In-place editing: when active, the block's own element hosts the Tiptap editor (same
                position, transparent background, real color) so it looks identical to the rendered
                text. Otherwise it shows the sanitized static content. */}
            {/* The contract class lives on this WRAPPER so the Tiptap editing surface inherits the
                same size/weight/colour as the static view — text must not resize the moment you
                click into it. The inner view therefore carries no second copy of the class. */}
            <div
                style={{ position: 'relative', zIndex: isEditing ? 60 : 20, pointerEvents: 'auto', ...blockStyle }}
                className={`group min-h-[40px] px-1 -mx-1 rounded-lg transition-all inline-text-view ${blockClass} ${
                    isEditing
                        ? 'ring-2 ring-editor-primary/40'
                        : 'border border-transparent hover:border-blue-200 hover:bg-blue-50/10 cursor-pointer'
                }`}
                onMouseDown={isEditing ? (e) => e.stopPropagation() : undefined}
                onPointerDown={isEditing ? (e) => e.stopPropagation() : undefined}
            >
                {isEditing ? (
                    <InlineTiptap
                        html={actualContent}
                        inline={!isTextBlock}
                        elementId={elementId}
                        onCommit={(html: string) => ctx.updateComponent(id, isTextBlock ? { content: html } : { title: html })}
                        onClose={() => ctx.setActiveEditorId(null)}
                    />
                ) : (
                    <div
                        id={elementId || undefined}
                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(actualContent) }}
                    />
                )}
            </div>

        </>
    );
};

// Component to inject CSS into iframe to block overlays during editing
// Optimized to be surgical and self-cleaning
const OverlayBlocker = () => {
    const [activeId, setActiveId] = React.useState<string | null>(null);

    React.useEffect(() => {
        // Look for the initial state if any
        if (typeof window !== 'undefined') {
            const initialId = (window as any).puckActiveEditorId || (window.parent as any)?.puckActiveEditorId || null;
            setActiveId(initialId);
        }

        // The active-editor id is broadcast on the 'puck-editor-change' event with the id as the
        // detail (NOT { activeId }). The old listener used the wrong event name + detail shape, so this
        // blocker never activated — leaving Puck's overlay on top of the in-place editor, where it
        // intercepted clicks (selecting the block / disrupting editing on every click).
        const handleUpdate = (e: any) => {
            setActiveId(e?.detail ?? (window as any).puckActiveEditorId ?? null);
        };
        window.addEventListener('puck-editor-change', handleUpdate as any);
        return () => window.removeEventListener('puck-editor-change', handleUpdate as any);
    }, []);

    React.useEffect(() => {
        const styleId = 'puck-overlay-blocker';
        const doc = document;

        if (!activeId) {
            const styleEl = doc.getElementById(styleId);
            if (styleEl) styleEl.remove();
            if (doc.body) doc.body.style.pointerEvents = 'auto';
            return;
        }

        let styleEl = doc.getElementById(styleId) as HTMLStyleElement | null;
        if (!styleEl) {
            styleEl = doc.createElement('style');
            styleEl.id = styleId;
            doc.head.appendChild(styleEl);
        }

        styleEl.textContent = `
            /* Hide only Puck-specific overlays when text editing is active */
            [data-puck-overlay-portal],
            [data-puck-overlay],
            [class*="DraggableComponent-overlay"],
            [class*="DraggableComponent-actionsOverlay"] {
                pointer-events: none !important;
                opacity: 0 !important;
                display: none !important;
            }
            
            /* Absolute overflow override when editing to prevent toolbar clipping */
            section.wp-block-section, 
            div.flex-col, 
            div.inline-editor-container,
            [data-puck-node],
            [data-puck-component],
            .puck-drop-zone {
                overflow: visible !important;
                contain: none !important;
            }

            .rich-text-content, .rich-text-content * {
                cursor: text !important;
            }

            .inline-editor-container button, 
            .inline-editor-container button *,
            .inline-editor-container input,
            .inline-editor-container select,
            .inline-editor-container [role="button"],
            .editor-action-buttons,
            .editor-action-buttons * {
                cursor: pointer !important;
                pointer-events: auto !important;
            }

            .inline-editor-container, .inline-editor-container * {
                user-select: text !important;
                -webkit-user-select: text !important;
                pointer-events: auto !important;
            }

            [data-puck-component] {
                cursor: default !important;
            }
        `;

        return () => {
            const el = doc.getElementById(styleId);
            if (el) el.remove();
        };
    }, [activeId]);

    return null;
};

// CANVAS ROOT — MODULE SCOPE ON PURPOSE (do not move it back inside a hook).
// React identifies a component by its FUNCTION REFERENCE. This one is `config.root.render`, so if it
// were re-created whenever the editor config object is rebuilt, React would see a different component
// type at the top of the canvas and unmount + remount the ENTIRE tree inside the iframe — the page
// visibly "reloads", selection/scroll/undo context is lost, and any in-progress inline edit dies.
// Defined once at module scope, the root survives every config change (e.g. marketplace plugin blocks
// arriving mid-session): new blocks merge into the palette without disturbing the canvas.
const StablePuckRoot = ({ children }: { children: React.ReactNode }) => {
    // Expose Puck's dispatch to updateComponent (which lives outside the Puck provider).
    // useGetPuck() returns a stable getter and does NOT subscribe, so this root never
    // re-renders on store changes — preserving the "stable root" guarantee above.
    const getPuck = useGetPuck();
    React.useEffect(() => {
        (window as any).puckDispatch = getPuck().dispatch;
        // Live store getter — authoritative at save time (Puck's onChange has a deep-equal
        // guard that can leave the parent's mirrored ref stale).
        (window as any).puckGetData = () => getPuck().appState.data;
    }, [getPuck]);
    return (
        <div id="puck-root-wrapper">
            <OverlayBlocker />
            <EditorContext.Provider value={{
                updateComponent: (id: string, data: any) => {
                    const fn = (window as any).puckUpdateComponent || (window.parent as any)?.puckUpdateComponent;
                    if (fn) fn(id, data);
                },
                activeEditorId: (window as any).puckActiveEditorId || (window.parent as any)?.puckActiveEditorId || null,
                setActiveEditorId: (id: string | null) => {
                    const fn = (window as any).puckSetActiveEditorId || (window.parent as any)?.puckSetActiveEditorId;
                    if (fn) fn(id);
                }
            }}>
                <PublicLayoutShell>
                    {/* OLA 3: the editable content is composed INSIDE the active theme's matching page
                        template (page/single), so the author sees their blocks in the theme's real
                        Section/Grid arrangement — exactly what the public page renders. Display only:
                        the template is the theme's and never enters the saved _puck_data (Puck serializes
                        its store, not this render output). No template ⇒ children render as before. The
                        route identity comes from CanvasTemplateContext, provided by PuckEditor and read
                        here across the AutoFrame portal. */}
                    <CanvasThemeTemplate>
                        {children}
                    </CanvasThemeTemplate>
                </PublicLayoutShell>
            </EditorContext.Provider>
        </div>
    );
};

// Inline-editable Text/Heading renderer — module scope for the same reason as StablePuckRoot: a block's
// `render` identity is its component type, so re-creating it per config rebuild remounts every Text and
// Heading on the canvas (losing the caret mid-typing).
// Replacing render drops the withSharedBlockFields wrapper, so re-apply the wjs-hide-* classes here —
// otherwise "ocultar en móvil" on a Text/Heading previews on the live site but not in the canvas device
// preview. (Animations stay off in the editor by design.)
const inlineRender = (props: any) => {
    const cls = hideClasses(props.hide);
    const inner = <InlineText {...props} id={props.id || props.puck?.id} />;
    return cls ? <div className={cls} style={{ display: "contents" }}>{inner}</div> : inner;
};

/**
 * Right panel — 320px, docked, per the design's "Bloque seleccionado" screen: a block-identity
 * header (icon chip + name + mono ID) over the field list, and a "Panel bloqueado" state while a
 * drag is in flight. The earlier three-tab strip is gone on purpose: Puck renders every field a
 * block declares as ONE list, so two of the three tabs could never hold anything — a dead control
 * dressed as the design. The identity header is the design element that CAN be real.
 */
const PropertiesPanel = ({ onClose, components, mobileOpen = false }: { onClose: () => void; components: Record<string, any>; mobileOpen?: boolean }) => {
    const { t, language } = useI18n();
    const selectedItem = usePuck((s: any) => s.selectedItem);
    const isDragging = usePuck((s: any) => s.appState.ui.isDragging);

    const type = selectedItem?.type as string | undefined;
    // Block icons live in the shared catalog (Material Symbols subset); unknown blocks get the
    // generic glyph, the page (no selection) its own identity.
    const msIcon = type ? ((BLOCK_META as any)[type]?.ms || "widgets") : "web";
    const label = type
        ? (components[type]?.label ? trStr(components[type].label, language) : type)
        : trStr("Página", language);
    const blockId: string | undefined = selectedItem?.props?.id;

    /* REAL tabs (design: Contenido · Estilo · Avanzado). Puck renders one flat field list; the
     * split is done by CSS over the shared fields' marker classes (see puck-theme.css, data-ptab).
     * Availability is probed from the rendered DOM — a block without shared fields (or the page
     * root) greys the tabs out instead of showing an empty pane. */
    const [tab, setTab] = useState<'content' | 'style' | 'advanced'>('content');
    const fieldsRef = useRef<HTMLDivElement>(null);
    const [avail, setAvail] = useState({ style: false, advanced: false });
    useEffect(() => {
        const probe = () => {
            const c = fieldsRef.current;
            if (!c) return;
            setAvail({
                style: !!c.querySelector('.wjs-f-look'),
                advanced: !!(c.querySelector('.wjs-f-anim') || c.querySelector('.wjs-f-hide')),
            });
        };
        // Puck.Fields swaps its field list asynchronously after a selection change — probe twice.
        const t1 = setTimeout(probe, 50);
        const t2 = setTimeout(probe, 300);
        return () => { clearTimeout(t1); clearTimeout(t2); };
    }, [blockId, type]);
    useEffect(() => {
        if ((tab === 'style' && !avail.style) || (tab === 'advanced' && !avail.advanced)) setTab('content');
    }, [avail, tab]);

    // The design's RESET, made honest: back to this block's OWN default look/animation/visibility
    // (content untouched), through the normal update path so it lands in history and Ctrl+Z works.
    const resetStyles = () => {
        if (!blockId || !type) return;
        const def = components[type]?.defaultProps || {};
        const fn = (window as any).puckUpdateComponent;
        fn?.(blockId, { look: def.look ?? {}, anim: def.anim ?? {}, hide: def.hide ?? {} });
    };

    const TABS = [
        { id: 'content' as const, label: trStr("Contenido", language), enabled: true },
        { id: 'style' as const, label: trStr("Estilo", language), enabled: avail.style },
        { id: 'advanced' as const, label: trStr("Avanzado", language), enabled: avail.advanced },
    ];

    return (
        // Mobile (per the design's "Propiedades del Bloque" screen): a full sheet between the header
        // and the bottom nav. Desktop: the docked 320px column.
        <aside className={`flex-col bg-[var(--ed-surface-container-lowest)] border-l border-[var(--ed-outline-variant)] ${mobileOpen ? "flex fixed inset-x-0 top-12 bottom-14 z-40" : "hidden"} md:flex md:static md:inset-auto md:w-[320px] md:shrink-0 md:z-30`}>
            <div className="shrink-0 p-3 flex items-center gap-2.5 bg-[var(--ed-surface-container-low)] border-b border-[var(--ed-outline-variant)]">
                <div className="w-8 h-8 shrink-0 rounded bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)] flex items-center justify-center">
                    <MSym name={msIcon} size={20} />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-[12px] font-bold text-[var(--ed-on-surface)] leading-4 truncate">{label}</h3>
                    <p
                        className="text-[10px] text-[var(--ed-on-surface-variant)] truncate"
                        style={{ fontFamily: "var(--puck-font-family-monospaced)" }}
                    >
                        {blockId ? `ID: ${blockId}` : t('editor.properties')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    title={t('editor.hideProperties')}
                    className="w-6 h-6 shrink-0 rounded flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                >
                    <MSym name="chevron_right" size={16} />
                </button>
            </div>

            {/* Tabs — the design's three-way split, backed by the marker-class CSS filter. */}
            <div className="flex shrink-0 border-b border-[var(--ed-outline-variant)]" role="tablist">
                {TABS.map((x) => (
                    <button
                        key={x.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === x.id}
                        disabled={!x.enabled}
                        onClick={() => setTab(x.id)}
                        className={`flex-1 py-2.5 text-[11px] font-medium transition-colors border-b-2 ${tab === x.id
                            ? 'text-[var(--ed-primary)] border-[var(--ed-primary)] bg-[var(--ed-surface-container-low)]'
                            : x.enabled
                                ? 'text-[var(--ed-on-surface-variant)] border-transparent hover:bg-[var(--ed-surface-container)]'
                                : 'text-[var(--ed-outline-variant)] border-transparent cursor-not-allowed'}`}
                    >
                        {x.label}
                    </button>
                ))}
            </div>

            <div className="relative flex-1 min-h-0">
                <div ref={fieldsRef} data-ptab={tab} className="absolute inset-0 overflow-y-auto custom-scrollbar">
                    <Puck.Fields />
                </div>
                {/* Drag state — the fields can't apply to a block that is mid-air. */}
                {isDragging && (
                    <div className="absolute inset-0 z-10 bg-[var(--ed-surface-container-lowest)]/90 flex flex-col items-center justify-center text-center p-6 pointer-events-none select-none">
                        <div className="w-16 h-16 rounded-full bg-[var(--ed-surface-container)] flex items-center justify-center mb-4">
                            <MSym name="replace_image" size={32} className="text-[var(--ed-outline)]" />
                        </div>
                        <p className="text-[12px] font-semibold text-[var(--ed-on-surface)]">{trStr("Panel bloqueado", language)}</p>
                        <p className="text-[13px] text-[var(--ed-on-surface-variant)] mt-2">
                            {trStr("Suelta el bloque en el lienzo para editar sus propiedades.", language)}
                        </p>
                    </div>
                )}
            </div>

            {/* Footer — reset this block's styles to its own defaults (undoable; content untouched). */}
            {blockId && (avail.style || avail.advanced) && (
                <div className="shrink-0 p-2.5 border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]">
                    <button
                        type="button"
                        onClick={resetStyles}
                        className="w-full py-2 rounded-md border border-[var(--ed-outline-variant)] text-[11px] font-bold uppercase tracking-wide text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] hover:text-[var(--ed-error)] transition-colors flex items-center justify-center gap-1.5"
                    >
                        <MSym name="refresh" size={14} />
                        {trStr("Restablecer estilos", language)}
                    </button>
                </div>
            )}
        </aside>
    );
};


export default function PuckEditor({
    initialData,
    onChange,
    status = "draft",
    onStatusChange,
    saving = false,
    hasChanges = true,
    onSave,
    onCancel,
    config: passedConfig,
    pageId,
    previewSlug,
    breadcrumbRoot,
    templateKind = "page",
    templatePostType
}: PuckEditorProps) {
    const { t, language } = useI18n();
    const activeConfig = passedConfig || puckConfig;

    // OLA 3: route identity for the canvas theme-template preview, carried across the AutoFrame portal to
    // CanvasThemeTemplate (rendered in the iframe). Memoized on kind+postType only (NOT the slug, which
    // regenerates per keystroke while titling a draft) so the value is stable for the whole session and
    // never re-runs the canvas resolution.
    const canvasTemplateInfo = React.useMemo<CanvasTemplateInfo>(
        () => ({ kind: templateKind, postType: templatePostType }),
        [templateKind, templatePostType]
    );

    // Preview the REAL live page (SSR, active theme) in a new tab. Saves first when there are
    // unsaved changes so the preview reflects what's on screen; /preview/[slug] is the dedicated
    // dynamic route that forwards the admin cookie, so drafts render for the author while anonymous
    // visitors still 404 (and the public /[slug] route stays fully cacheable).
    const handlePreview = React.useCallback(async () => {
        try { if (hasChanges && onSave) await onSave(); } catch { /* preview anyway — user sees last saved state */ }
        if (previewSlug) window.open(`/preview/${previewSlug}`, '_blank', 'noopener');
    }, [hasChanges, onSave, previewSlug]);

    // ---- Save status + autosave ----
    // savedAt drives the header indicator; it's only SHOWN when hasChanges is false, so a failed
    // save (parent keeps isDirty=true) can't display a false "saved" state.
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [lastSaveWasAuto, setLastSaveWasAuto] = useState(false);

    // Design toast: dark inverse-surface pill, bottom-right beside the properties panel, 4s.
    // Message-based so palette actions (styles copied, page imported…) reuse it. Only MANUAL
    // saves earn the save toast — autosave already reports through the header chip, and a toast
    // every 30s would be noise.
    const [toastMsg, setToastMsg] = useState<string | null>(null);
    useEffect(() => {
        if (!toastMsg) return;
        const t = setTimeout(() => setToastMsg(null), 4000);
        return () => clearTimeout(t);
    }, [toastMsg]);

    const handleManualSave = React.useCallback(async () => {
        if (!onSave) return;
        // The parents alert-and-swallow their own failures and signal them by returning false —
        // a failed save must not stamp savedAt or celebrate with the success toast.
        const ok = await onSave();
        if (ok === false) return;
        setSavedAt(new Date());
        setLastSaveWasAuto(false);
        setToastMsg(trStr("¡Cambios guardados con éxito!", language));
    }, [onSave, language]);

    // Autosave: drafts only (a published page must never go live in the background). Fires 8s after
    // the page first becomes dirty, with a 30s floor between runs; the parent passes autosave:true
    // through to the API so these background saves skip revision snapshots and validation alerts.
    const lastAutosaveRef = useRef(0);
    useEffect(() => {
        if (status !== "draft" || !onSave || !hasChanges || saving) return;
        const wait = Math.max(8000, 30000 - (Date.now() - lastAutosaveRef.current));
        const t = setTimeout(async () => {
            lastAutosaveRef.current = Date.now();
            try {
                const ok = await onSave({ autosave: true });
                if (ok === false) return; // blocked/failed — don't stamp a save that didn't happen
                setSavedAt(new Date());
                setLastSaveWasAuto(true);
            } catch { /* background save — the next manual save surfaces real errors */ }
        }, wait);
        return () => clearTimeout(t);
    }, [status, onSave, hasChanges, saving]);

    const [data, setData] = useState<Data>(() => {
        const baseData = initialData || {
            content: [],
            root: {},
        };
        // Apply migration from DropZones to Slots
        return migrate(baseData, activeConfig);
    });

    // Track if data has been initialized to avoid overwriting state on hot reloads
    const hasInitializedRef = useRef(false);

    useEffect(() => {
        if (initialData && !hasInitializedRef.current) {
            setData(migrate(initialData, activeConfig));
            hasInitializedRef.current = true;
        }
    }, [initialData, activeConfig]);

    // Sync data ref for the updateComponent callback
    const dataRef = useRef(data);
    useEffect(() => {
        dataRef.current = data;
    }, [data]);

    // Active Inline Editor State - Required for overlay blocking and context
    const [activeEditorId, setActiveEditorId] = useState<string | null>(null);

    // Sync activeEditorId to window and dispatch event for the iframe
    React.useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as any).puckActiveEditorId = activeEditorId;
            window.dispatchEvent(new CustomEvent('puck-editor-change', { detail: activeEditorId }));
        }
    }, [activeEditorId]);
    // Expose setActiveEditorId globally (Legacy/Backup)
    useEffect(() => {
        (window as any).puckSetActiveEditorId = setActiveEditorId;
        return () => {
            delete (window as any).puckSetActiveEditorId;
        };
    }, [setActiveEditorId]);

    const updateComponent = React.useCallback((id: string, newProps: any) => {
        // Puck v0.20 nests child components inside SLOT props (e.g. a Columns block stores its
        // children under props['col-0'], props['col-1'], …), not under the legacy `zones` map. So
        // updating a component requires recursing through every prop that holds a component array —
        // a flat scan of `content`/`zones` silently misses anything inside Columns/Cards/etc.
        const isComponentArray = (val: any): boolean =>
            Array.isArray(val) && val.length > 0 &&
            val.some((v: any) => v && typeof v === 'object' && v.type && v.props);

        const updateItem = (item: any): any => {
            if (!item || typeof item !== 'object') return item;
            let nextProps = item.props;

            // Recurse into slot props (arrays of child components).
            if (item.props) {
                for (const key in item.props) {
                    const val = item.props[key];
                    if (isComponentArray(val)) {
                        const mapped = val.map(updateItem);
                        if (mapped.some((m: any, i: number) => m !== val[i])) {
                            if (nextProps === item.props) nextProps = { ...item.props };
                            nextProps[key] = mapped;
                        }
                    }
                }
            }

            // Apply the target update (matched by id) — merge into props, preserving id/others.
            if (item.props?.id === id || item._id === id || item.id === id) {
                nextProps = { ...nextProps, ...newProps };
            }

            return nextProps === item.props ? item : { ...item, props: nextProps };
        };

        const transform = (prev: any) => ({
            ...prev,
            content: (prev.content || []).map(updateItem),
            zones: Object.keys(prev.zones || {}).reduce((acc: any, key) => ({
                ...acc,
                [key]: (prev.zones[key] || []).map(updateItem)
            }), {})
        });

        // `data` is NOT a controlled prop in Puck v0.20 — Puck owns its store after mount, so mutating
        // our local mirror never reaches the rendered tree. Dispatch into Puck's store instead (the
        // function form receives Puck's live data). Puck's onChange then syncs our mirror back.
        const dispatch = (window as any).puckDispatch || (window.parent as any)?.puckDispatch;
        if (dispatch) {
            // recordHistory: inline text commits are debounced (300ms), so entries land in sane
            // chunks and Ctrl+Z can step back through text edits like any other change.
            dispatch({ type: 'setData', data: transform, recordHistory: true });
            return;
        }

        // Fallback before Puck has registered its dispatch (e.g. SSR / first paint).
        const newData = transform(dataRef.current);
        setData(newData);
        onChange(newData);
    }, [onChange]);

    // STABLE CONFIG: No dependencies on state that changes during editing
    // This prevents Puck from reloading the iframe when activeEditorId changes.
    // The root and the inline renderers live at MODULE scope (see above) so that even when this memo
    // DOES recompute — the config identity legitimately changes when runtime plugin blocks load — the
    // component types stay identical and React updates the canvas in place instead of remounting it.
    const editorConfig = React.useMemo(() => {
        const baseConfig = activeConfig;
        const editorOverrides = {
            Text: {
                ...baseConfig.components.Text,
                render: inlineRender
            },
            Heading: {
                ...baseConfig.components.Heading,
                render: inlineRender
            }
        };

        return {
            ...baseConfig,
            root: {
                ...baseConfig.root,
                render: StablePuckRoot
            },
            components: {
                ...baseConfig.components,
                ...editorOverrides
            }
        };
    }, [activeConfig]);

    // Sync state and functions to window for the stable config to use
    React.useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as any).puckActiveEditorId = activeEditorId;
            (window as any).puckSetActiveEditorId = setActiveEditorId;
            (window as any).puckUpdateComponent = updateComponent;

            const event = new CustomEvent('puck-editor-change', { detail: activeEditorId });
            window.dispatchEvent(event);

            // Also notify the iframe directly if it exists
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.dispatchEvent(new CustomEvent('puck-editor-change', { detail: activeEditorId }));
            }
        }
    }, [activeEditorId, updateComponent, setActiveEditorId]);

    const overrides = React.useMemo(() => ({
        button: ({ children, ...props }: any) => (
            <button
                {...props}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
                {children}
            </button>
        ),
        headerActions: () => (
            <div className="flex items-center gap-3">
                {onStatusChange && (
                    <ModernSelect
                        value={status}
                        onChange={(e) => onStatusChange(e.target.value)}
                        options={[
                            { value: "draft", label: t('editor.status.draft') },
                            { value: "publish", label: t('editor.status.publish') },
                            { value: "pending", label: t('editor.status.pending') },
                        ]}
                        placeholder={trStr("Select an option", language)}
                        className="!py-1.5 !px-3 !bg-white !border-gray-200 !rounded-md !text-sm font-normal min-w-[100px]"
                    />
                )}
                {pageId && (
                    <button
                        type="button"
                        onClick={() => setShowRevisions(!showRevisions)}
                        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 ${showRevisions ? 'bg-amber-500 text-white shadow-lg shadow-amber-200 scale-105' : 'bg-gray-50/50 text-gray-400 hover:text-amber-500 hover:bg-gray-100 border border-gray-100'}`}
                        title={t('editor.revisionHistory')}
                    >
                        <i className="fa-solid fa-clock-rotate-left"></i>
                    </button>
                )}
                {previewSlug && (
                    <button
                        type="button"
                        onClick={handlePreview}
                        disabled={saving}
                        className="px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                        title={trStr("Preview on the live site (drafts stay private to you)", language)}
                    >
                        <i className="fa-solid fa-eye text-xs"></i>
                        {trStr("Preview", language)}
                    </button>
                )}
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                        {t('editor.cancel')}
                    </button>
                )}
                {onSave && (
                    <button
                        type="button"
                        onClick={handleManualSave}
                        disabled={saving || (!hasChanges && !activeEditorId)}
                        className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${hasChanges
                            ? 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white'
                            : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                            }`}
                        title={hasChanges ? t('editor.saveChanges') : t('editor.noChangesToSave')}
                    >
                        <i className="fa-solid fa-floppy-disk text-xs"></i>
                        {saving ? t('editor.saving') : hasChanges ? t('editor.save') : t('editor.saved')}
                    </button>
                )}
            </div>
        ),
        componentOverlay: ({ children, componentId }: any) => {
            if (activeEditorId === componentId) {
                // Edit Mode: REMOVE the Overlay completely so it doesn't exist to trap clicks
                return <div className="hidden" />;
            }
            return <>{children}</>;
        },
        // Block toolbar + the design's move up/down arrows (module-scope component: stable identity).
        actionBar: ActionBarOverride,
    }), [onStatusChange, status, onCancel, onSave, handleManualSave, saving, hasChanges, activeEditorId, previewSlug, handlePreview, language]);




    // Layout Visibility State
    const { alert, confirm } = useModal();
    const [showSidebar, setShowSidebar] = useState(true);
    const [showProperties, setShowProperties] = useState(true);
    const [showRevisions, setShowRevisions] = useState(false);
    /* Which view the 64px rail is showing in the left panel. The design splits what used to be one
     * stacked column (inserter above, outline below, with a drag handle between) into rail-selected
     * views, so the panel shows one thing at a time at full height. */
    const [railView, setRailView] = useState<'blocks' | 'outline' | 'patterns'>('blocks');
    // "Recursos" rail entry — the media library modal; picking an item appends an Image block.
    const [mediaOpen, setMediaOpen] = useState(false);
    /* MOBILE (<md): the design turns both side panels into full sheets driven by a bottom nav.
     * Deliberately SEPARATE from showSidebar/showProperties so phone usage never rewrites the
     * persisted desktop layout preferences. */
    const [mobileSheet, setMobileSheet] = useState<null | 'left' | 'right'>(null);
    const isPhone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
    const [isUiLoaded, setIsUiLoaded] = useState(false);
    const [viewport, setViewport] = useState<ViewportKey>("desktop");
    const [cmdkOpen, setCmdkOpen] = useState(false); // ⌘K command palette (insert block)
    const [guidesOn, setGuidesOn] = useState(false); // canvas outlines + spacing measures
    const [commentsOpen, setCommentsOpen] = useState(false); // review-comments drawer (meta-based)
    // A11y audit panel state — the audit itself is a pure DOM scan of the canvas (editor/A11yAudit).
    const [a11yOpen, setA11yOpen] = useState(false);
    const [a11yIssues, setA11yIssues] = useState<A11yIssue[]>([]);
    const [a11yRunning, setA11yRunning] = useState(false);
    const runAudit = React.useCallback(() => {
        const doc = (document.querySelector(".puck-container iframe") as HTMLIFrameElement | null)?.contentDocument;
        if (!doc) return;
        setA11yRunning(true);
        // Next frame so the "running" state paints before a potentially heavy scan.
        requestAnimationFrame(() => {
            try { setA11yIssues(runA11yAudit(doc)); } finally { setA11yRunning(false); }
        });
    }, []);
    const selectBlockById = React.useCallback((blockId?: string) => {
        if (!blockId) return;
        try {
            const st = (window as any).__PUCK_INTERNAL_DO_NOT_USE?.appStore?.getState?.()?.state;
            const node = st?.indexes?.nodes?.[blockId];
            // node.zone is only the SEGMENT ("default-zone"); itemSelector needs the COMPOUND
            // ("root:default-zone") — the node's path ends with exactly that.
            const zone = node?.path?.[node.path.length - 1] || (node?.parentId && node?.zone ? `${node.parentId}:${node.zone}` : null);
            const index = zone ? st?.indexes?.zones?.[zone]?.contentIds?.indexOf(blockId) : -1;
            if (zone && index >= 0) (window as any).puckDispatch?.({ type: "setUi", ui: { itemSelector: { index, zone } } });
        } catch { /* stale internal bridge — selection simply doesn't move */ }
    }, []);

    /* PRESENCE (collaboration v1): heartbeat while this post is open; the backend answers with the
     * OTHER active editors and the header shows a warning chip. sendBeacon on the way out so the
     * server doesn't wait a full TTL to drop us. */
    const [coEditors, setCoEditors] = useState<{ id: number; name: string }[]>([]);
    useEffect(() => {
        if (!pageId) return;
        let dead = false;
        const ping = async () => {
            try {
                const res = await fetch(`/api/v1/presence/${pageId}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: "{}",
                });
                if (!res.ok) return;
                const data = await res.json();
                if (!dead) setCoEditors(Array.isArray(data.editors) ? data.editors : []);
            } catch { /* offline tick — keep the last known state */ }
        };
        ping();
        const t = setInterval(ping, 10000);
        const leave = () => {
            try {
                navigator.sendBeacon?.(
                    `/api/v1/presence/${pageId}`,
                    new Blob([JSON.stringify({ action: "leave" })], { type: "application/json" })
                );
            } catch { /* beacon is best-effort */ }
        };
        window.addEventListener("beforeunload", leave);
        return () => { dead = true; clearInterval(t); window.removeEventListener("beforeunload", leave); leave(); };
    }, [pageId]);

    // ── ⌘K palette ACTIONS — editor commands surfaced above the block list (the design's
    // "ACCIONES SUGERIDAS"): save/preview, page export/import as JSON, Elementor-style copy/paste
    // of a block's styles, block ops, panels. Selection-dependent commands read the selection
    // LAZILY at run time (through the internal store bridge, optional-chained) — the palette can
    // stay open across selection changes and a missing selection just no-ops.
    const readSelected = React.useCallback(() => {
        try {
            return (window as any).__PUCK_INTERNAL_DO_NOT_USE?.appStore?.getState?.()?.selectedItem ?? null;
        } catch { return null; }
    }, []);
    const readSelector = React.useCallback(() => {
        try {
            return (window as any).__PUCK_INTERNAL_DO_NOT_USE?.appStore?.getState?.()?.state?.ui?.itemSelector ?? null;
        } catch { return null; }
    }, []);

    const paletteActions = React.useMemo(() => {
        const acts: { id: string; ms: string; label: string; hint?: string; run: () => void }[] = [];
        if (onSave) acts.push({
            id: "save", ms: "cloud_done", hint: "Ctrl+S",
            label: status === "draft" ? trStr("Guardar", language) : trStr("Publicar", language),
            run: () => { void handleManualSave(); },
        });
        if (previewSlug) acts.push({
            id: "preview", ms: "open_in_new",
            label: trStr("Vista previa", language),
            run: () => { void handlePreview(); },
        });
        acts.push({
            id: "export", ms: "arrow_downward",
            label: trStr("Exportar página (JSON)", language),
            run: () => {
                const data = (window as any).puckGetData?.() || dataRef.current;
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `wordjs-page-${pageId ?? "borrador"}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            },
        });
        acts.push({
            id: "import", ms: "arrow_upward",
            label: trStr("Importar página (JSON)", language),
            run: () => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "application/json,.json";
                input.onchange = async () => {
                    const f = input.files?.[0];
                    if (!f) return;
                    try {
                        const parsed = JSON.parse(await f.text());
                        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.content)) throw new Error("shape");
                        const ok = await confirm(
                            trStr("¿Reemplazar todo el contenido de la página con el archivo importado?", language),
                            trStr("Importar", language)
                        );
                        if (!ok) return;
                        // Through the same migrate() the initial load uses; recordHistory → Ctrl+Z restores.
                        const migrated = migrate(parsed, activeConfig);
                        (window as any).puckDispatch?.({ type: "setData", data: () => migrated, recordHistory: true });
                        setToastMsg(trStr("Página importada", language));
                    } catch {
                        await alert(trStr("El archivo no es una página válida", language), "Error");
                    }
                };
                input.click();
            },
        });
        acts.push({
            id: "media", ms: "image",
            label: trStr("Biblioteca de medios", language),
            // Also the PHONE's only route to the media library — the rail that opens it is md-only,
            // and the mobile FAB opens this palette.
            run: () => setMediaOpen(true),
        });
        acts.push({
            id: "copy-styles", ms: "palette",
            label: trStr("Copiar estilos del bloque", language),
            run: () => {
                const sel = readSelected();
                if (!sel?.props) return;
                const { look = {}, anim = {}, hide = {} } = sel.props;
                try { localStorage.setItem(STYLE_CLIPBOARD_KEY, JSON.stringify({ look, anim, hide })); } catch { /* storage full */ }
                setToastMsg(trStr("Estilos copiados", language));
            },
        });
        acts.push({
            id: "paste-styles", ms: "edit",
            label: trStr("Pegar estilos en el bloque", language),
            run: () => {
                const sel = readSelected();
                if (!sel?.props?.id) return;
                try {
                    const raw = localStorage.getItem(STYLE_CLIPBOARD_KEY);
                    if (raw) (window as any).puckUpdateComponent?.(sel.props.id, JSON.parse(raw));
                } catch { /* malformed clipboard */ }
            },
        });
        acts.push({
            id: "duplicate", ms: "content_copy", hint: "Ctrl+D",
            label: trStr("Duplicar bloque", language),
            run: () => {
                const sel = readSelector();
                if (!sel) return;
                (window as any).puckDispatch?.({ type: "duplicate", sourceIndex: sel.index, sourceZone: sel.zone ?? "root:default-zone" });
            },
        });
        acts.push({
            id: "delete-block", ms: "delete", hint: "Supr",
            label: trStr("Eliminar bloque", language),
            run: () => {
                const sel = readSelector();
                if (!sel) return;
                (window as any).puckDispatch?.({ type: "remove", index: sel.index, zone: sel.zone ?? "root:default-zone" });
            },
        });
        acts.push({
            id: "page-settings", ms: "settings",
            label: trStr("Ajustes de página", language),
            run: () => {
                (window as any).puckDispatch?.({ type: "setUi", ui: { itemSelector: null } });
                if (isPhone()) setMobileSheet('right'); else setShowProperties(true);
            },
        });
        if (pageId) acts.push({
            id: "revisions", ms: "history",
            label: trStr("Historial de revisiones", language),
            run: () => setShowRevisions(true),
        });
        acts.push({
            id: "replay", ms: "play_arrow",
            label: trStr("Reproducir las animaciones de entrada", language),
            run: () => {
                const doc = (document.querySelector(".puck-container iframe") as HTMLIFrameElement | null)?.contentDocument;
                if (doc) replayAnimations(doc);
            },
        });
        acts.push({
            id: "save-symbol", ms: "collections",
            label: trStr("Guardar bloque como símbolo", language),
            run: () => {
                const sel = readSelected();
                if (!sel?.type || sel.type === "Symbol") return;
                void (async () => {
                    try {
                        // Strip SSR-injected resolutions — the resolver re-derives them per render.
                        const props: any = { ...sel.props };
                        delete props.resolvedPosts;
                        delete props.resolvedFiltered;
                        delete props.resolvedSymbolItems;
                        const blockLabel = (activeConfig.components as any)[sel.type]?.label || sel.type;
                        const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                        await symbolsApi.create(`${trStr(blockLabel, language)} · ${stamp}`, [{ type: sel.type, props }]);
                        setToastMsg(trStr("Símbolo guardado", language));
                    } catch {
                        await alert(trStr("No se pudo guardar el símbolo", language), "Error");
                    }
                })();
            },
        });
        if (pageId) acts.push({
            id: "comments", ms: "forum",
            label: trStr("Comentarios de revisión", language),
            run: () => setCommentsOpen(true),
        });
        acts.push({
            id: "a11y", ms: "check_circle",
            label: trStr("Auditoría de accesibilidad", language),
            run: () => { setA11yOpen(true); runAudit(); },
        });
        acts.push({
            id: "guides", ms: "grid_view",
            label: trStr("Guías y contornos", language),
            run: () => setGuidesOn((v) => !v),
        });
        return acts;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- setters are stable; isPhone reads live
    }, [onSave, previewSlug, status, language, pageId, handleManualSave, handlePreview, activeConfig, alert, confirm, readSelected, readSelector]);


    const handleRestore = async (revision: Revision) => {
        if (!pageId) return;
        try {
            await revisionsApi.restore(revision.id);
            // After restore, we need to reload the page to refresh the state
            // or just reload the post data. 
            // In WordJS, the easiest is to just reload the window to ensure everything is fresh
            window.location.reload();
        } catch (error) {
            console.error("Failed to restore revision:", error);
            await alert("Failed to restore revision. Please try again.", "Error");
        }
    };

    // Persist UI preferences
    useEffect(() => {
        // Load on mount
        const savedSidebar = localStorage.getItem('puck_show_sidebar');
        const savedProps = localStorage.getItem('puck_show_properties');

        if (savedSidebar !== null) setShowSidebar(savedSidebar === 'true');
        if (savedProps !== null) setShowProperties(savedProps === 'true');

        setIsUiLoaded(true);
    }, []);

    useEffect(() => {
        if (isUiLoaded) {
            localStorage.setItem('puck_show_sidebar', String(showSidebar));
        }
    }, [showSidebar, isUiLoaded]);

    useEffect(() => {
        if (isUiLoaded) {
            localStorage.setItem('puck_show_properties', String(showProperties));
        }
    }, [showProperties, isUiLoaded]);

    // Force re-calculation of scale after sidebar transition (300ms)
    useEffect(() => {
        const timer = setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 350);
        return () => clearTimeout(timer);
    }, [showSidebar]);

    return (
        <CanvasTemplateContext.Provider value={canvasTemplateInfo}>
        <EditorContext.Provider value={{ updateComponent, activeEditorId, setActiveEditorId }}>
            {activeEditorId && (
                <style dangerouslySetInnerHTML={{
                    __html: `
                    /* Hide only Puck-specific overlays when text editing is active */
                    [data-puck-overlay-portal], [data-puck-overlay] { pointer-events: none !important; opacity: 0 !important; }
                    [class*="DraggableComponent-overlay"], [class*="DraggableComponent-actionsOverlay"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }
                `}} />
            )}
            {/* FULL-VIEWPORT workspace (fixed, over the admin shell) — the design's editor owns the
                whole screen; its own rail + breadcrumb replace the admin sidebar while editing.
                Modals/drawers still win (RevisionsSidebar z-5000, pickers/palette z-9999). */}
            <div className="puck-container fixed inset-0 z-50 bg-[var(--ed-surface)]">
                <Puck
                    config={editorConfig}
                    data={data}
                    onPublish={(data) => onChange(data)}
                    onChange={(newData) => { setData(newData); onChange(newData); }}
                    overrides={overrides}
                    /* IFRAME preview: render the canvas in an isolated iframe so the page's responsive
                     * Tailwind breakpoints (md:/lg:) evaluate against the DEVICE width (the viewport
                     * frame below sets the iframe width), not the editor window — making mobile/tablet
                     * preview match the live site. Puck 0.20 (AutoFrame) copies the parent's stylesheets
                     * into the iframe, and the inline editor is already cross-frame aware
                     * (editor.view.dom.ownerDocument; events dispatched to iframe.contentWindow). */
                    iframe={{ enabled: true }}
                >
                    <div className="flex flex-col h-screen w-full overflow-hidden">
                        {/* Global keyboard layer: save/undo/redo/duplicate/delete/copy/paste + ⌘K palette */}
                        <EditorHotkeys onSave={handleManualSave} onCommandPalette={() => setCmdkOpen((v) => !v)} components={editorConfig.components} />

                        {/* ⌘K command palette — actions + insert any block by search (portals to <body>) */}
                        <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} components={editorConfig.components} actions={paletteActions} />

                        {/* HEADER — 48px, per the generated design: three groups (identity, view
                            controls + save state, actions) on a flat surface with one hairline
                            underneath. Colours come from --ed-* (the design's stated role values). */}
                        <div className="h-12 shrink-0 z-20 relative flex items-center justify-between gap-3 px-3 bg-[var(--ed-surface)] border-b border-[var(--ed-outline-variant)]">

                            {/* Left: wordmark + breadcrumb (the breadcrumb root navigates back) */}
                            <div className="flex items-center gap-3 min-w-0">
                                {/* Phone exit — the breadcrumb is md-only, and without this the
                                    fullscreen editor would have no way back on a phone. */}
                                {onCancel && (
                                    <button
                                        type="button"
                                        onClick={onCancel}
                                        title={t('editor.cancel')}
                                        aria-label={t('editor.cancel')}
                                        className="md:hidden w-8 h-8 -ml-1 shrink-0 rounded-md flex items-center justify-center text-[var(--ed-on-surface-variant)] active:bg-[var(--ed-surface-container)]"
                                    >
                                        <MSym name="chevron_left" size={22} />
                                    </button>
                                )}
                                <span className="text-[18px] font-black tracking-tight text-[var(--ed-primary)] select-none shrink-0">
                                    WordJS
                                </span>

                                <div className="h-4 w-px bg-[var(--ed-outline-variant)] hidden md:block"></div>

                                {/* Breadcrumb — the design's "Páginas / <nombre>" */}
                                <div className="hidden md:flex items-center gap-1.5 text-[12px] text-[var(--ed-on-surface-variant)] min-w-0">
                                    {onCancel ? (
                                        <button
                                            type="button"
                                            onClick={onCancel}
                                            title={t('editor.cancel')}
                                            className="shrink-0 px-1 py-0.5 rounded hover:bg-[var(--ed-surface-container)] hover:text-[var(--ed-primary)] transition-colors"
                                        >
                                            {trStr(breadcrumbRoot || "Páginas", language)}
                                        </button>
                                    ) : (
                                        <span className="shrink-0">{trStr(breadcrumbRoot || "Páginas", language)}</span>
                                    )}
                                    <MSym name="chevron_right" size={12} className="opacity-50 shrink-0" />
                                    <span className="font-semibold text-[var(--ed-on-surface)] truncate max-w-[220px]">
                                        {(data as any)?.root?.props?.title || trStr("Sin título", language)}
                                    </span>
                                </div>
                            </div>

                            {/* Centre: device switcher · history · save state, the design's pairing */}
                            <div className="flex items-center gap-3 shrink-0">
                                <ViewportControls value={viewport} onChange={setViewport} />
                                <div className="h-4 w-px bg-[var(--ed-outline-variant)] hidden md:block"></div>
                                <HistoryControls />
                                {onSave && (
                                    <SaveStateChip
                                        saving={saving}
                                        hasChanges={hasChanges}
                                        savedAt={savedAt}
                                        wasAuto={lastSaveWasAuto}
                                        status={status}
                                    />
                                )}
                                {/* Presence warning — someone else has this post open right now */}
                                {coEditors.length > 0 && (
                                    <span
                                        role="status"
                                        className="hidden lg:flex items-center gap-1.5 text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1 select-none"
                                        title={coEditors.map((e) => e.name).join(", ")}
                                    >
                                        <MSym name="person" size={14} fill />
                                        <span className="truncate max-w-[180px]">
                                            {coEditors.map((e) => e.name).join(", ")}{" "}
                                            {trStr(coEditors.length === 1 ? "también está editando" : "también están editando", language)}
                                        </span>
                                    </span>
                                )}
                            </div>

                            {/* Right: insert · replay · properties · status · preview · publish · avatar */}
                            <div className="flex items-center gap-2 min-w-0">
                                {/* Insert (⌘K) */}
                                <button
                                    type="button"
                                    onClick={() => setCmdkOpen(true)}
                                    title={trStr("Insertar bloque (Ctrl/⌘ + K)", language)}
                                    className="hidden lg:flex items-center gap-2 h-7 px-2.5 rounded-md border border-[var(--ed-outline-variant)] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                                >
                                    <MSym name="search" size={14} />
                                    <span className="text-[11px]">{trStr("Insertar", language)}</span>
                                    <kbd
                                        className="text-[9px] text-[var(--ed-on-surface-variant)] bg-[var(--ed-surface-container)] rounded px-1 py-0.5 leading-none"
                                        style={{ fontFamily: "var(--puck-font-family-monospaced)" }}
                                    >⌘K</kbd>
                                </button>

                                {/* Replay entrance animations in the canvas */}
                                <button
                                    type="button"
                                    onClick={() => {
                                        const doc = (document.querySelector(".puck-container iframe") as HTMLIFrameElement | null)?.contentDocument;
                                        if (doc) replayAnimations(doc);
                                    }}
                                    title={trStr("Reproducir las animaciones de entrada", language)}
                                    className="hidden md:flex w-7 h-7 rounded-md items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                                >
                                    <MSym name="play_arrow" size={18} />
                                </button>

                                {/* Guides — dashed outlines on every block + spacing measures on the
                                    selected one (Webflow-style), painted inside the canvas iframe. */}
                                <button
                                    onClick={() => setGuidesOn(!guidesOn)}
                                    className={`hidden md:flex w-7 h-7 rounded-md items-center justify-center transition-colors ${guidesOn ? 'bg-[var(--ed-surface-container-high)] text-[var(--ed-primary)]' : 'text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]'}`}
                                    title={trStr("Guías y contornos", language)}
                                    aria-pressed={guidesOn}
                                >
                                    <MSym name="grid_view" size={16} />
                                </button>

                                {/* Properties-panel toggle — the panel's own close leaves no way back
                                    without this; the left panel reopens from the rail instead. */}
                                <button
                                    onClick={() => setShowProperties(!showProperties)}
                                    className={`hidden md:flex w-7 h-7 rounded-md items-center justify-center transition-colors ${showProperties ? 'bg-[var(--ed-surface-container-high)] text-[var(--ed-primary)]' : 'text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]'}`}
                                    title={showProperties ? t('editor.hideProperties') : t('editor.showProperties')}
                                >
                                    <MSym name="tune" size={18} />
                                </button>

                                {onStatusChange && (
                                    <div className="hidden md:block">
                                        <ModernSelect
                                            value={status}
                                            onChange={(e) => onStatusChange(e.target.value)}
                                            options={[
                                                { value: "draft", label: t('editor.status.draft') },
                                                { value: "publish", label: t('editor.status.publish') },
                                                { value: "pending", label: t('editor.status.pending') },
                                            ]}
                                            placeholder={trStr("Select an option", language)}
                                            className="!py-1 !px-2 !bg-[var(--ed-surface-container)] !border-[var(--ed-outline-variant)] !rounded-md !text-[11px] min-w-[104px]"
                                        />
                                    </div>
                                )}

                                {previewSlug && (
                                    <button
                                        type="button"
                                        onClick={handlePreview}
                                        disabled={saving}
                                        className="hidden md:block px-4 py-1.5 rounded-lg text-[12px] font-medium text-[var(--ed-on-surface)] border border-[var(--ed-outline-variant)] hover:bg-[var(--ed-surface-container)] active:scale-95 duration-75 transition disabled:opacity-50"
                                    >
                                        {trStr("Vista Previa", language)}
                                    </button>
                                )}

                                {onSave && (
                                    <button
                                        type="button"
                                        onClick={handleManualSave}
                                        disabled={saving || (!hasChanges && !activeEditorId)}
                                        className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[var(--ed-primary)] hover:opacity-90 active:scale-95 duration-75 transition disabled:opacity-40 flex items-center gap-2"
                                    >
                                        {saving && <MSym name="sync" size={12} className="animate-spin" />}
                                        {status === "draft" ? trStr("Guardar", language) : trStr("Publicar", language)}
                                    </button>
                                )}

                                {/* Avatar — the design closes the bar with it */}
                                <div className="hidden md:flex w-8 h-8 rounded-full bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)] items-center justify-center shrink-0 border border-[var(--ed-outline-variant)]">
                                    <MSym name="person" size={16} fill />
                                </div>
                            </div>
                        </div>

                        {/* 2. Content Area (Below Header) — mobile reserves the bottom-nav strip */}
                        <div className="relative flex-1 w-full bg-[var(--ed-surface-container-low)] overflow-hidden flex flex-col min-h-0 md:flex-row pb-14 md:pb-0">

                            {/* RAIL — 64px, per the design. Selects what the left panel shows, so the
                                panel holds one view at full height instead of the old stacked
                                inserter-over-outline column with a drag handle between them. Every
                                entry is REAL: Plantillas is the inserter's patterns view, Recursos
                                opens the media library (picking appends an Image block), Historial
                                the revisions drawer, Ajustes selects the page itself so its settings
                                land in the properties panel. A rail of dead icons would look like
                                the design and behave like a mock. */}
                            <nav className="hidden md:flex w-16 shrink-0 bg-[var(--ed-surface)] border-r border-[var(--ed-outline-variant)] flex-col items-center py-2 gap-1 z-30">
                                {([
                                    { id: 'blocks' as const, icon: 'add_box', label: trStr("Bloques", language) },
                                    { id: 'outline' as const, icon: 'layers', label: trStr("Estructura", language) },
                                    { id: 'patterns' as const, icon: 'dashboard_customize', label: trStr("Plantillas", language) },
                                ]).map((item) => {
                                    const active = showSidebar && railView === item.id;
                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => {
                                                // Clicking the active view collapses the panel — the design's
                                                // "both sidebars collapsed" state, reachable without a separate control.
                                                if (showSidebar && railView === item.id) setShowSidebar(false);
                                                else { setRailView(item.id); setShowSidebar(true); }
                                            }}
                                            title={item.label}
                                            aria-pressed={active}
                                            className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors ${active
                                                ? 'bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]'
                                                : 'text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)]'}`}
                                        >
                                            <MSym name={item.icon} size={20} fill={active} />
                                            <span className="text-[9px] leading-none">{item.label}</span>
                                        </button>
                                    );
                                })}

                                <button
                                    type="button"
                                    onClick={() => setMediaOpen(true)}
                                    title={trStr("Biblioteca de medios", language)}
                                    className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                                >
                                    <MSym name="image" size={20} />
                                    <span className="text-[9px] leading-none">{trStr("Recursos", language)}</span>
                                </button>

                                <div className="mt-auto flex flex-col items-center gap-1">
                                    {pageId && (
                                        <button
                                            type="button"
                                            onClick={() => setCommentsOpen(!commentsOpen)}
                                            title={trStr("Comentarios de revisión", language)}
                                            aria-pressed={commentsOpen}
                                            className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors ${commentsOpen
                                                ? 'bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]'
                                                : 'text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)]'}`}
                                        >
                                            <MSym name="forum" size={20} fill={commentsOpen} />
                                            <span className="text-[9px] leading-none">{trStr("Notas", language)}</span>
                                        </button>
                                    )}
                                    {pageId && (
                                        <button
                                            type="button"
                                            onClick={() => setShowRevisions(!showRevisions)}
                                            title={t('editor.revisionHistory')}
                                            aria-pressed={showRevisions}
                                            className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors ${showRevisions
                                                ? 'bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]'
                                                : 'text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)]'}`}
                                        >
                                            <MSym name="history" size={20} fill={showRevisions} />
                                            <span className="text-[9px] leading-none">{trStr("Historial", language)}</span>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            // Deselect → Puck.Fields falls back to the ROOT (page) fields.
                                            (window as any).puckDispatch?.({ type: 'setUi', ui: { itemSelector: null } });
                                            setShowProperties(true);
                                        }}
                                        title={trStr("Ajustes de página", language)}
                                        className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                                    >
                                        <MSym name="settings" size={20} />
                                        <span className="text-[9px] leading-none">{trStr("Ajustes", language)}</span>
                                    </button>
                                </div>
                            </nav>

                            {/* LEFT PANEL — desktop: docked 280px column; mobile: a full sheet between
                                the header and the bottom nav (design's mobile Bloques/Capas screens).
                                `inert` removes the collapsed panel's controls from the tab order —
                                w-0/opacity-0 hides them visually but keyboard focus still landed there. */}
                            <div
                                inert={!showSidebar && mobileSheet !== 'left'}
                                className={`flex-col bg-[var(--ed-surface-container-lowest)] border-r border-[var(--ed-outline-variant)] md:transition-[width,opacity] duration-200 ease-in-out ${mobileSheet === 'left' ? 'flex fixed inset-x-0 top-12 bottom-14 z-40' : 'hidden'} md:flex md:static md:inset-auto md:z-30 ${showSidebar ? 'md:w-[280px] md:opacity-100' : 'md:w-0 md:opacity-0 md:overflow-hidden'}`}
                            >
                                <div className="h-10 shrink-0 px-3 flex items-center justify-between bg-[var(--ed-surface-container-low)] border-b border-[var(--ed-outline-variant)]">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ed-on-surface-variant)]">
                                        {railView === 'blocks' ? trStr("Bloques", language)
                                            : railView === 'patterns' ? trStr("Plantillas", language)
                                            : t('editor.panel.structure')}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => { if (isPhone()) setMobileSheet(null); else setShowSidebar(false); }}
                                        title={t('editor.hideSidebar')}
                                        className="w-6 h-6 rounded flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                                    >
                                        <MSym name="chevron_left" size={16} className="hidden md:block" />
                                        <MSym name="close" size={16} className="md:hidden" />
                                    </button>
                                </div>

                                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                                    {railView === 'outline'
                                        ? <div className="p-3"><Puck.Outline /></div>
                                        : <BlockInserter
                                            components={editorConfig.components}
                                            view={railView}
                                            onInsert={mobileSheet === 'left' ? () => setMobileSheet(null) : undefined}
                                        />}
                                </div>
                            </div>

                            {/* MAIN PREVIEW AREA — the canvas iframe is sized to the chosen device width
                                and scaled to fit (see PreviewFrame), so mobile/tablet match the live site
                                and desktop never overflows into a horizontal scrollbar. */}
                            <PreviewFrame viewport={viewport}>
                                {/* Empty-canvas onboarding — shown only when the page has no blocks.
                                    pointer-events-none lets drag-drop pass through everywhere except
                                    the pattern quick-pick buttons. */}
                                {(!data?.content || data.content.length === 0) && (
                                    <div className="absolute inset-0 z-30 flex items-center justify-center p-6 pointer-events-none">
                                        {/* The design's "Comienza tu diseño" state: illustration circle,
                                            headline, one primary pill CTA (opens the ⌘K inserter),
                                            pattern quick-picks as the secondary row. It floats OVER the
                                            themed page, which may be dark — the frosted white card keeps
                                            the on-surface text readable on any theme. */}
                                        <div className="text-center max-w-md pointer-events-none bg-white/95 backdrop-blur rounded-2xl border border-[var(--ed-outline-variant)] shadow-xl p-8">
                                            <div className="w-36 h-36 mx-auto rounded-full bg-[var(--ed-surface-container)] border border-[var(--ed-outline-variant)] flex items-center justify-center mb-6">
                                                <MSym name="space_dashboard" size={56} className="text-[var(--ed-outline)]" />
                                            </div>
                                            <h3 className="text-[18px] font-semibold tracking-tight text-[var(--ed-on-surface)] mb-2">{trStr("Comienza tu diseño", language)}</h3>
                                            <p className="text-[14px] text-[var(--ed-on-surface-variant)] mb-6">{trStr("Tu lienzo está listo. Añade el primer bloque para empezar a construir tu visión.", language)}</p>
                                            <button
                                                type="button"
                                                onClick={() => setCmdkOpen(true)}
                                                className="pointer-events-auto inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--ed-primary)] text-white text-[12px] font-semibold hover:shadow-lg transition-all active:scale-95"
                                            >
                                                <MSym name="add_circle" size={20} />
                                                {trStr("Añadir primer bloque", language)}
                                            </button>
                                            <div className="flex flex-wrap justify-center gap-2 mt-5">
                                                {PATTERNS.slice(0, 3).map((p) => (
                                                    <button
                                                        key={p.id}
                                                        type="button"
                                                        onClick={() => insertPattern(p, editorConfig.components)}
                                                        className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] hover:border-[var(--ed-primary)] text-[11px] font-semibold text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-primary)] transition"
                                                    >
                                                        {trStr(p.name, language)}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </PreviewFrame>

                            {/* Floating Properties Panel handled by state, rendered here for z-index context if needed */}
                            {(showProperties || mobileSheet === 'right') && (
                                <PropertiesPanel
                                    onClose={() => { if (isPhone()) setMobileSheet(null); else setShowProperties(false); }}
                                    components={editorConfig.components}
                                    mobileOpen={mobileSheet === 'right'}
                                />
                            )}
                        </div>

                        {/* MOBILE bottom navigation — the design's 4 tabs. Sheets open between the
                            48px header and this bar; the FAB below is the phone's insert gesture. */}
                        <div className="md:hidden fixed inset-x-0 bottom-0 h-14 z-40 bg-[var(--ed-surface)] border-t border-[var(--ed-outline-variant)] flex items-stretch">
                            {([
                                { id: 'blocks', icon: 'add_box', label: trStr("Bloques", language), active: mobileSheet === 'left' && railView !== 'outline' },
                                { id: 'layers', icon: 'layers', label: trStr("Capas", language), active: mobileSheet === 'left' && railView === 'outline' },
                                { id: 'props', icon: 'tune', label: trStr("Propiedades", language), active: mobileSheet === 'right' },
                                { id: 'settings', icon: 'settings', label: trStr("Ajustes", language), active: false },
                            ] as const).map((tab) => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    aria-pressed={tab.active}
                                    onClick={() => {
                                        if (tab.id === 'blocks') {
                                            const wasOpen = mobileSheet === 'left' && railView !== 'outline';
                                            setRailView('blocks');
                                            setMobileSheet(wasOpen ? null : 'left');
                                        } else if (tab.id === 'layers') {
                                            const wasOpen = mobileSheet === 'left' && railView === 'outline';
                                            setRailView('outline');
                                            setMobileSheet(wasOpen ? null : 'left');
                                        } else if (tab.id === 'props') {
                                            setMobileSheet(mobileSheet === 'right' ? null : 'right');
                                        } else {
                                            (window as any).puckDispatch?.({ type: 'setUi', ui: { itemSelector: null } });
                                            setMobileSheet('right');
                                        }
                                    }}
                                    className="flex-1 flex flex-col items-center justify-center gap-0.5"
                                >
                                    <span className={`w-10 h-6 rounded-md flex items-center justify-center transition-colors ${tab.active ? 'bg-[var(--ed-primary)] text-white' : 'text-[var(--ed-on-surface-variant)]'}`}>
                                        <MSym name={tab.icon} size={18} fill={tab.active} />
                                    </span>
                                    <span className={`text-[10px] leading-none ${tab.active ? 'text-[var(--ed-primary)] font-semibold' : 'text-[var(--ed-on-surface-variant)]'}`}>
                                        {tab.label}
                                    </span>
                                </button>
                            ))}
                        </div>

                        {/* MOBILE FAB — insert a block (opens the palette; tap-to-insert). Hidden
                            while a sheet is open (the sheet owns the screen then). */}
                        {!mobileSheet && (
                            <button
                                type="button"
                                onClick={() => setCmdkOpen(true)}
                                title={trStr("Insertar bloque (Ctrl/⌘ + K)", language)}
                                className="md:hidden fixed right-4 bottom-[72px] z-40 w-12 h-12 rounded-full bg-[var(--ed-primary)] text-white shadow-xl flex items-center justify-center active:scale-95 transition"
                            >
                                <MSym name="add" size={24} />
                            </button>
                        )}

                        {/* Drag guide pill (renders only while a block drag is live) */}
                        <DragHint />

                        {/* Canvas guides — outlines + spacing measures, driven by selection */}
                        <GuidesController enabled={guidesOn} />

                        {/* Accessibility audit drawer */}
                        {a11yOpen && (
                            <div className="fixed top-12 bottom-0 right-0 w-[340px] z-[90] bg-[var(--ed-surface-container-lowest)] border-l border-[var(--ed-outline-variant)] flex flex-col shadow-2xl">
                                <div className="shrink-0 h-10 px-3 flex items-center justify-between bg-[var(--ed-surface-container-low)] border-b border-[var(--ed-outline-variant)]">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ed-on-surface-variant)]">
                                        {trStr("Accesibilidad", language)}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setA11yOpen(false)}
                                        aria-label={t('common.close')}
                                        className="w-6 h-6 rounded flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                                    >
                                        <MSym name="close" size={16} />
                                    </button>
                                </div>
                                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                                    <A11yPanel
                                        issues={a11yIssues}
                                        running={a11yRunning}
                                        onRefresh={runAudit}
                                        onSelect={selectBlockById}
                                    />
                                </div>
                            </div>
                        )}

                        {/* Toast — dark pill beside the properties panel, per the design */}
                        {toastMsg && (
                            <div
                                className="fixed bottom-16 md:bottom-4 right-4 md:right-[var(--toast-right)] z-[80] bg-[var(--ed-inverse-surface)] text-[var(--ed-inverse-on-surface)] pl-3 pr-2 py-2.5 rounded-lg shadow-xl flex items-center gap-2.5"
                                style={{ "--toast-right": showProperties ? "336px" : "16px" } as React.CSSProperties}
                                role="status"
                            >
                                <MSym name="check_circle" size={20} fill className="text-[var(--ed-success)]" />
                                <span className="text-[13px] font-medium">{toastMsg}</span>
                                <button
                                    type="button"
                                    aria-label={t('common.close')}
                                    onClick={() => setToastMsg(null)}
                                    className="p-1 rounded hover:bg-white/10 transition-colors"
                                >
                                    <MSym name="close" size={16} />
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Media library ("Recursos"): picking an item appends an Image block to the page. */}
                    <MediaPickerModal
                        isOpen={mediaOpen}
                        onClose={() => setMediaOpen(false)}
                        onSelect={(item: any) => {
                            const def = (editorConfig.components as any).Image?.defaultProps || {};
                            // Relative sourceUrl, not guid — guid embeds the upload-time host.
                            const block = regenIds({ type: "Image", props: { ...def, src: item.sourceUrl || item.guid, alt: item.title || "" } });
                            (window as any).puckDispatch?.({
                                type: "setData",
                                data: (prev: any) => ({ ...prev, content: [...(prev.content || []), block] }),
                                recordHistory: true,
                            });
                            setMediaOpen(false);
                        }}
                    />
                </Puck>
            </div>
            {pageId && (
                <RevisionsSidebar
                    postId={pageId}
                    isOpen={showRevisions}
                    onClose={() => setShowRevisions(false)}
                    onRestore={handleRestore}
                />
            )}
            {/* Review comments (Figma/Webflow-style editorial thread; meta-based, never public) */}
            {pageId && (
                <ReviewComments
                    postId={pageId}
                    isOpen={commentsOpen}
                    onClose={() => setCommentsOpen(false)}
                />
            )}
        </EditorContext.Provider>
        </CanvasTemplateContext.Provider>
    );
}

