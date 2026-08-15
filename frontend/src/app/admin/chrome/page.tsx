"use client";

// /admin/chrome — "Cabecera y Pie (beta)": the composable-chrome (contract v1) editor. Mounts
// @wordjs/puck's <Puck> DIRECTLY with the chrome-only config (chromeEditorConfig.tsx) — NOT the
// pages PuckEditor, which is coupled to posts (autosave/revisions/status). Loads the EFFECTIVE
// composition with the same precedence the public layout resolves (site option → theme chrome
// file → starter template), saves through the dedicated PUT /api/v1/chrome/:part (backend
// validator is the write authority) and restores by DELETE + reload. The legacy /admin/footer
// page stays alongside during the beta.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Puck, type Data } from "@wordjs/puck";
import "@wordjs/puck/puck.css";
import { chromeApi, settingsApi, type ChromePart } from "@/lib/api";
import { themeStylesheetHref, uiFrameworkHref } from "@/lib/assetVersion";
import { parseChromeData, STARTER_TEMPLATES, type ChromeData } from "@/lib/chromeData";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { resolveEditorEngineFromBrowser, type EditorEngine } from "@/lib/editorEngine";
import { unhydratedSaveBlocked } from "@/lib/editorGuards";
import EngineToggle from "@/components/verso/editor/EngineToggle";
import type { VersoData } from "@/lib/verso/types";
import { buildChromeEditorConfig } from "./chromeEditorConfig";
import { saveChromeComposition, toContractData, withBlockIds } from "./chromeContract";
import ChromeVersoEditor from "./ChromeVersoEditor";

type ChromeSource = "site" | "theme" | "starter";

const SOURCE_LABEL_KEY: Record<ChromeSource, string> = {
    site: "chrome.admin.source.site",
    theme: "chrome.admin.source.theme",
    starter: "chrome.admin.source.starter",
};

// withBlockIds / toContractData viven ahora en ./chromeContract.ts (MOVIDAS byte-idénticas, ver
// documentation/verso/chrome-oracle.md §6): una sola implementación para ambos motores y tests de
// wiring contra el productor real.

// The backend validator answers with structured entries ({ code, path, message }), the local one with
// plain strings. Both end up in the same banner, so flatten to text here: rendering an object as a
// React child throws and takes the whole editor down — on the very path meant to REPORT a problem.
// The path is kept in the message because it names the offending block ("content.2.props.href").
function describeError(entry: unknown, t: (key: string) => string): string {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
        const e = entry as { path?: unknown; message?: unknown; code?: unknown };
        const message = typeof e.message === "string" ? e.message : typeof e.code === "string" ? e.code : "";
        const path = typeof e.path === "string" && e.path ? `${e.path}: ` : "";
        if (message) return `${path}${message}`;
    }
    return t("chrome.admin.validationUnknown");
}

export default function ChromeEditorPage() {
    const { addToast } = useToast();
    const { t } = useI18n();
    const [part, setPart] = useState<ChromePart>("header");
    const [initialData, setInitialData] = useState<Data | null>(null);
    const [source, setSource] = useState<ChromeSource>("starter");
    const [themeSlug, setThemeSlug] = useState<string>("");
    const [themeVersion, setThemeVersion] = useState<string>("");
    const [mountKey, setMountKey] = useState(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [confirmRestore, setConfirmRestore] = useState(false);
    const [pendingPart, setPendingPart] = useState<ChromePart | null>(null);
    const [dirty, setDirty] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);

    // F3/W52 — flag de motor: legacy es el DEFAULT ABSOLUTO; Verso solo con opt-in explícito
    // (?engine= / localStorage wjs_editor_engine / env). Se resuelve tras montar (window no existe
    // en SSR) y se re-resuelve en navegación suave — el MISMO patrón de pages/[id] y posts/[id].
    const searchParams = useSearchParams();
    const [engine, setEngine] = useState<EditorEngine | null>(null);
    useEffect(() => {
        setEngine(resolveEditorEngineFromBrowser());
    }, [searchParams]);

    // Save reads the LATEST Puck data from a ref (state would re-render the whole page per keystroke);
    // dirty tracking compares the contract-shaped JSON against the loaded baseline — exact, no
    // "ignore the first onChange" heuristics.
    const latestDataRef = useRef<Data | null>(null);
    const baselineJsonRef = useRef<string>("");
    // loadPart and the stylesheet effect must keep a STABLE identity: they remount <Puck> / reload the
    // composition, so re-running them would drop unsaved edits. The context hands out a NEW t() on
    // every provider render, so read the translator through a ref instead of depending on it.
    const tRef = useRef(t);
    tRef.current = t;

    const config = useMemo(() => buildChromeEditorConfig(part), [part]);

    const loadPart = useCallback(async (target: ChromePart, opts: { skipSite?: boolean } = {}) => {
        setLoading(true);
        setErrors([]);
        setConfirmRestore(false);
        setPendingPart(null);
        try {
            // Same precedence the public layout resolves — the editor always opens the EFFECTIVE
            // chrome: 1º site option (site_chrome_*) → 2º active theme's chrome/<part>.json →
            // 3º starter template. Every level is fail-closed via parseChromeData.
            let resolved: ChromeData | null = null;
            let from: ChromeSource = "starter";
            // The announcement bar validates at its own position (bars ChromeNav); header/footer default.
            const position = target === "announcement" ? ("announcement" as const) : undefined;
            // A FAILED settings read is not "nothing configured": falling through to the starter here
            // showed a pristine composition over a site that has a real one, and the next Save wrote
            // the starter on top of it. Treat it as an error and leave the editor empty instead.
            const settings = await settingsApi.get();
            const slug = settings?.template || "default";
            if (!opts.skipSite) {
                const site = parseChromeData(settings?.[`site_chrome_${target}`], { source: "site", position });
                if (site.ok && site.data) { resolved = site.data; from = "site"; }
            }
            if (!resolved) {
                try {
                    // Served statically from the active theme, same relative path the admin footer
                    // page already uses for /themes/<slug>/style.css.
                    const res = await fetch(`/themes/${encodeURIComponent(slug)}/chrome/${target}.json`, { cache: "no-store" });
                    if (res.ok) {
                        const theme = parseChromeData(await res.text(), { source: "theme", position });
                        if (theme.ok && theme.data) { resolved = theme.data; from = "theme"; }
                    }
                } catch { /* unreadable theme chrome — fall through to the starter */ }
            }
            if (!resolved) { resolved = STARTER_TEMPLATES[target]; from = "starter"; }

            const stamped = withBlockIds(resolved) as unknown as Data;
            setThemeSlug(slug);
            setThemeVersion(String(settings?.active_theme_version || ""));
            setSource(from);
            latestDataRef.current = stamped;
            baselineJsonRef.current = JSON.stringify(toContractData(stamped));
            setDirty(false);
            setInitialData(stamped);
            setMountKey((k) => k + 1); // remount <Puck> with a fresh store for the new data
        } catch (e) {
            // No editable state: initialData stays null, so the editor (and Save with it) never mounts.
            setInitialData(null);
            latestDataRef.current = null;
            const reason = (e as Error).message || tRef.current("chrome.admin.loadErrorNetwork");
            setErrors([`${tRef.current("chrome.admin.loadError")}: ${reason}. ${tRef.current("chrome.admin.loadErrorHint")}`]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadPart(part); }, [part, loadPart]);

    // WYSIWYG canvas: the ensureLink pattern from PuckEditor — UI framework first, ACTIVE theme
    // sheet second (cascade contract), re-asserted for the whole session because AutoFrame reloads
    // the iframe and clones links back in arbitrary positions.
    useEffect(() => {
        if (!themeSlug) return;
        // SOLO motor legacy: el canvas Verso (/admin/canvas-frame) carga wordjs-ui.css + la hoja del
        // tema activo por sí mismo con los mismos helpers — inyectar aquí además crearía una pelea
        // de hrefs entre dos resoluciones de versión del tema.
        if (engine !== "legacy") return;
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
            const iframe = document.querySelector(".wjs-chrome-editor iframe") as HTMLIFrameElement | null;
            const doc = iframe?.contentDocument;
            if (!doc?.head) return;
            // Puck creates the canvas iframe itself, so its accessible name has to be set here —
            // an untitled iframe is announced as just "iframe" by screen readers.
            if (iframe && !iframe.title) iframe.title = tRef.current("chrome.admin.canvasTitle");
            const ui = ensureLink(doc, "wjs-ui-framework", uiFrameworkHref());
            // Same key the public site uses (slug + theme version + ui hash): editing a theme bumps its
            // version, and without it the canvas kept showing the pre-edit CSS from cache.
            const theme = ensureLink(doc, "wjs-theme-stylesheet", themeStylesheetHref(themeSlug, themeVersion));
            if (ui.parentNode !== doc.head) doc.head.appendChild(ui);
            if (theme.parentNode !== doc.head || !(ui.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                doc.head.appendChild(theme);
            }
        };
        inject();
        const t = setInterval(inject, 700);
        return () => clearInterval(t);
    }, [themeSlug, themeVersion, mountKey, engine]);

    const handleChange = useCallback((newData: Data) => {
        latestDataRef.current = newData;
        setDirty(JSON.stringify(toContractData(newData)) !== baselineJsonRef.current);
        // Editing instead of answering the pending switch IS "keep editing": drop the request, or an
        // undo back to the baseline (dirty false) followed by a new edit would resurrect the prompt.
        setPendingPart(null);
    }, []);

    const switchPart = (target: ChromePart) => {
        if (target === part || loading || saving) return;
        // Switching reloads the other part from scratch, so the in-memory edits are gone for good:
        // ask BEFORE discarding, in-page (window.confirm freezes the in-app browser — never use it).
        if (dirty) { setPendingPart(target); return; }
        setPart(target);
    };

    const handleSave = async () => {
        const data = latestDataRef.current;
        if (!data || saving || loading) return;
        // Cinturón explícito (W44 aplicado al chrome): jamás guardar una composición no hidratada.
        // Equivalente estructural ya garantizado por el guard anterior (initialData null ⇒ el editor
        // no se monta y latestDataRef es null), pero el contrato queda declarado, no implícito.
        if (unhydratedSaveBlocked({ isNew: false, loaded: initialData !== null })) return;
        const contract = toContractData(data);
        // Same fail-closed validation the renderer applies — catch violations locally before the
        // PUT; the backend validator (the write authority) re-checks and its 400 errors[] land in
        // the same banner.
        const local = parseChromeData(contract, { source: "editor", position: part === "announcement" ? "announcement" : undefined });
        if (!local.ok) { setErrors(local.errors); return; }
        setSaving(true);
        setErrors([]);
        try {
            // Wrapper 1:1 de chromeApi.save (PUT /api/v1/chrome/:part) — seam espiable en tests.
            await saveChromeComposition(part, contract);
            baselineJsonRef.current = JSON.stringify(contract);
            setDirty(false);
            setPendingPart(null); // nothing left to discard, so a pending switch is moot
            setSource("site");
            addToast(t("chrome.admin.saveSuccess"), "success");
        } catch (e) {
            const err = e as Error & { errors?: unknown[] };
            const list = Array.isArray(err.errors) && err.errors.length > 0 ? err.errors.map((entry) => describeError(entry, t)) : [];
            setErrors(list.length > 0 ? list : [err.message || t("chrome.admin.saveFailed")]);
            addToast(t("chrome.admin.saveError"), "error");
        } finally {
            setSaving(false);
        }
    };

    const handleRestore = async () => {
        if (restoring || loading) return;
        // Two-step confirm (window.confirm freezes the in-app browser — never use it).
        if (!confirmRestore) {
            setConfirmRestore(true);
            window.setTimeout(() => setConfirmRestore(false), 4000);
            return;
        }
        setConfirmRestore(false);
        setRestoring(true);
        try {
            await chromeApi.reset(part);
            addToast(t("chrome.admin.restoreSuccess"), "success");
            await loadPart(part, { skipSite: true });
        } catch (e) {
            addToast((e as Error).message || t("chrome.admin.restoreError"), "error");
        } finally {
            setRestoring(false);
        }
    };

    return (
        <div className="flex flex-col h-full w-full overflow-hidden bg-white">
            {/* PREMIUM HEADER (h-20) — same bar pattern as /admin/footer */}
            <div className="h-20 flex items-center justify-between bg-white/80 backdrop-blur-md px-6 md:px-8 shrink-0 z-20 relative border-b border-gray-100 shadow-sm gap-6">
                <div className="flex items-center gap-6 min-w-0">
                    <div className="flex items-center gap-3 text-gray-900">
                        <div className="w-10 h-10 bg-gradient-to-br from-indigo-600 to-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
                            <i className="fa-solid fa-window-maximize text-lg"></i>
                        </div>
                        <div className="hidden md:block">
                            <h1 className="font-black italic text-xl tracking-tighter leading-none">{t("chrome.admin.title")}</h1>
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">{t("chrome.admin.subtitle")}</span>
                        </div>
                    </div>
                    <div className="h-8 w-px bg-gray-100 hidden md:block"></div>

                    {/* Part selector — toggle buttons, so the active part is exposed via aria-pressed */}
                    <div role="group" aria-label={t("chrome.admin.partSelector")} className="flex items-center bg-gray-100 rounded-xl p-1 gap-1">
                        {(["header", "footer", "announcement"] as ChromePart[]).map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => switchPart(p)}
                                aria-pressed={part === p}
                                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${part === p ? "bg-white text-indigo-600 shadow-sm" : "text-gray-400 hover:text-gray-600"}`}
                            >
                                {/* Non-colour cue for the active part (the fill/colour swap alone is invisible
                                    under forced colours and to users who can't tell the two apart). Kept in the
                                    layout with `invisible` so switching doesn't shift the buttons. */}
                                <i className={`fa-solid fa-check text-[8px] ${part === p ? "" : "invisible"}`} aria-hidden="true"></i>
                                {t(`chrome.admin.part.${p}`)}
                            </button>
                        ))}
                    </div>

                    {/* Effective source badge */}
                    <span className="hidden lg:inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-50 border border-gray-100 text-[10px] font-black uppercase tracking-widest text-gray-400">
                        <i className={`fa-solid ${source === "site" ? "fa-floppy-disk text-indigo-500" : source === "theme" ? "fa-palette text-purple-500" : "fa-wand-magic-sparkles text-gray-400"}`}></i>
                        {t(SOURCE_LABEL_KEY[source])}
                        {dirty && <span className="text-amber-500 normal-case tracking-normal font-bold">· {t("chrome.admin.unsaved")}</span>}
                    </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                    <button
                        type="button"
                        onClick={handleRestore}
                        disabled={restoring || loading}
                        className={`px-5 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 border ${confirmRestore
                            ? "bg-red-50 border-red-200 text-red-600 hover:bg-red-100"
                            : "bg-white border-gray-200 text-gray-500 hover:border-purple-200 hover:text-purple-600"
                            } ${restoring || loading ? "opacity-50 cursor-not-allowed" : ""}`}
                        title={t("chrome.admin.restoreHint")}
                    >
                        {restoring ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-rotate-left"></i>}
                        {confirmRestore ? t("chrome.admin.restoreConfirm") : t("chrome.admin.restore")}
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || loading}
                        className={`px-8 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg ${saving || loading
                            ? "bg-gray-100 text-gray-400 cursor-not-allowed shadow-none"
                            : "bg-gray-900 hover:bg-indigo-600 text-white shadow-gray-200 hover:shadow-indigo-500/30 hover:-translate-y-0.5"
                            }`}
                    >
                        {saving ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-floppy-disk"></i>}
                        {saving ? t("chrome.admin.saving") : t("chrome.admin.save")}
                    </button>
                </div>
            </div>

            {/* Validation errors from the local check or the backend validator's 400 */}
            {errors.length > 0 && (
                <div className="shrink-0 bg-red-50 border-b border-red-100 px-6 md:px-8 py-3 flex items-start gap-3">
                    <i className="fa-solid fa-triangle-exclamation text-red-500 mt-0.5"></i>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-black uppercase tracking-widest text-red-600 mb-1">{t("chrome.admin.contractError")}</p>
                        <ul className="text-xs text-red-500 space-y-0.5 list-disc pl-4">
                            {errors.map((err, i) => <li key={i} className="break-words">{err}</li>)}
                        </ul>
                    </div>
                    <button type="button" onClick={() => setErrors([])} className="text-red-300 hover:text-red-500 transition-colors p-1" aria-label={t("close")}>
                        <i className="fa-solid fa-xmark"></i>
                    </button>
                </div>
            )}

            {/* Pending part switch — the edits are still in memory, nothing is discarded until the
                explicit confirmation. Gated on `dirty` so saving while it is open dismisses it. */}
            {pendingPart && dirty && (
                <div role="alert" className="shrink-0 bg-amber-50 border-b border-amber-100 px-6 md:px-8 py-3 flex items-center flex-wrap gap-3">
                    <i className="fa-solid fa-triangle-exclamation text-amber-500" aria-hidden="true"></i>
                    <p className="flex-1 min-w-0 text-xs text-amber-700 font-medium">{t("chrome.admin.discardPrompt")}</p>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => { setPendingPart(null); setPart(pendingPart); }}
                            className="px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-all"
                        >
                            {t("chrome.admin.discardConfirm")}
                        </button>
                        <button
                            type="button"
                            onClick={() => setPendingPart(null)}
                            className="px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest bg-white border border-gray-200 text-gray-500 hover:text-gray-700 transition-all"
                        >
                            {t("chrome.admin.discardCancel")}
                        </button>
                    </div>
                </div>
            )}

            {/* Narrow viewport: the fields pane is hidden under lg and the block drawer under md, so
                say so instead of silently dropping panes. Non-blocking — the canvas still works. */}
            <div className="lg:hidden shrink-0 bg-amber-50/70 border-b border-amber-100 px-6 md:px-8 py-2 flex items-center gap-2">
                <i className="fa-solid fa-display text-amber-400 text-xs" aria-hidden="true"></i>
                <p className="text-[11px] text-amber-600 font-medium">{t("chrome.admin.narrowScreen")}</p>
            </div>

            {/* Purge note — kept simple on purpose */}
            <div className="shrink-0 bg-indigo-50/60 border-b border-indigo-100/60 px-6 md:px-8 py-2 flex items-center gap-2">
                <i className="fa-solid fa-circle-info text-indigo-400 text-xs"></i>
                <p className="text-[11px] text-indigo-500 font-medium">{t("chrome.admin.purgeNote")}</p>
            </div>

            {/* EDITOR — Puck mounted directly with the chrome-only config; custom 3-pane layout
                (children replace Puck's default UI). The iframe canvas gets the active theme's
                stylesheets injected by the effect above. */}
            <div className="relative flex-1 min-h-0 wjs-chrome-editor bg-gray-50/50">
                <EngineToggle current={engine} />
                {loading || !initialData || engine === null ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-gray-300">
                            <i className="fa-solid fa-circle-notch fa-spin text-2xl"></i>
                            <span className="text-[10px] font-black uppercase tracking-widest">{t("chrome.admin.loading")}</span>
                        </div>
                    </div>
                ) : engine === "verso" ? (
                    /* MOTOR VERSO (opt-in explícito, W52). Mismos datos (initialData ya estampado por
                       withBlockIds), mismo onChange compartido (dirty por comparación de contrato) y
                       mismo camino de guardado/restaurar del header — el dato de chrome NO es
                       _puck_data. La rama legacy de abajo queda byte-intacta. */
                    <ChromeVersoEditor
                        key={`${part}-${mountKey}`}
                        part={part}
                        initialData={toContractData(initialData) as ChromeData}
                        onChange={(data: VersoData) => handleChange(data as unknown as Data)}
                        onInit={(data: VersoData) => {
                            // Re-basar el dirty sobre la SERIALIZACIÓN VERSO del doc cargado: emite
                            // `id` primero en nodos sin slots (byte-distinto, deep-igual) y comparar
                            // contra el crudo daba «sin guardar» en falso permanente.
                            latestDataRef.current = data as unknown as Data;
                            baselineJsonRef.current = JSON.stringify(toContractData(data as unknown as Data));
                        }}
                    />
                ) : (
                    <Puck
                        key={`${part}-${mountKey}`}
                        config={config}
                        data={initialData}
                        onChange={handleChange}
                        iframe={{ enabled: true }}
                    >
                        <div className="flex h-full min-h-0 w-full">
                            {/* Left: block drawer + outline */}
                            <aside className="w-64 shrink-0 border-r border-gray-100 bg-white overflow-y-auto custom-scrollbar hidden md:block">
                                <div className="p-3 border-b border-gray-50">
                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t("chrome.admin.pane.blocks")}</h3>
                                    <Puck.Components />
                                </div>
                                <div className="p-3">
                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t("chrome.admin.pane.outline")}</h3>
                                    <Puck.Outline />
                                </div>
                            </aside>

                            {/* Center: canvas. A plain div, NOT <main>: the admin shell already wraps every
                                page in its own <main>, and nesting a second one is an invalid landmark. */}
                            <div className="flex-1 min-w-0 min-h-0 overflow-hidden p-4 md:p-6 flex flex-col">
                                <div className="flex-1 min-h-0 mx-auto w-full max-w-5xl bg-white shadow-xl rounded-xl overflow-hidden border border-gray-200">
                                    <Puck.Preview />
                                </div>
                            </div>

                            {/* Right: selected block fields */}
                            <aside className="w-72 shrink-0 border-l border-gray-100 bg-white overflow-y-auto custom-scrollbar hidden lg:block">
                                <div className="p-3">
                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t("chrome.admin.pane.fields")}</h3>
                                    <Puck.Fields />
                                </div>
                            </aside>
                        </div>
                    </Puck>
                )}
            </div>
        </div>
    );
}
