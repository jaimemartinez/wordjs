"use client";

// /admin/chrome — "Header & footer": the composable-chrome (contract v1) editor. Monta
// ChromeVersoEditor (variante delgada del motor Verso) con el config de chrome
// (chromeEditorConfig.tsx) — NO el editor de páginas, acoplado a posts (autosave/revisiones/estado).
//
// Loads the EFFECTIVE composition with the same precedence the public layout resolves — site option →
// theme chrome file → the site's BUILT-IN chrome (Header.tsx/Footer.tsx, converted by the backend so
// the first save keeps today's look) → a starter template (the announcement bar, which has no built-in
// form) — and says which one it is. Saves through PUT /api/v1/chrome/:part (the backend validator is
// the write authority), restores by DELETE + reload. It is also where the retired /admin/footer page's
// settings live now: the social profiles panel edits `footer_socials`, and a legacy footer is converted
// (POST /api/v1/chrome/migrate-legacy) or offered as blocks to insert.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chromeApi, settingsApi, type ChromePart } from "@/lib/api";
import { parseChromeData, STARTER_TEMPLATES, type ChromeData } from "@/lib/chromeData";
import { parseThemeLayout } from "@/lib/themeLayout";
import { chromeTemplates, type ChromeTemplate } from "@/lib/chromeTemplates";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { unhydratedSaveBlocked } from "@/lib/editorGuards";
// La forma persistida `{ content, root }` — el mismo tipo que exponía el fork, ahora propio.
import type { VersoData, VersoData as Data } from "@/lib/verso/types";
import { saveChromeComposition, toContractData, withBlockIds } from "./chromeContract";
import ChromeVersoEditor, { type ChromeEditorApi } from "./ChromeVersoEditor";
import { describeChromeProblem, formatChromeProblem } from "./chromeErrors";
import { refreshEditorBindings } from "./chromeEditorConfig";
import SocialProfilesPanel from "./SocialProfilesPanel";
import DialogLayer from "@/components/DialogLayer";

// Where the composition the editor opened comes from — the same four levels the public layout uses.
type ChromeSource = "site" | "theme" | "legacy" | "starter";

const SOURCE_ICON: Record<ChromeSource, string> = {
    site: "fa-floppy-disk text-indigo-500",
    theme: "fa-palette text-purple-500",
    legacy: "fa-clock-rotate-left text-amber-500",
    starter: "fa-wand-magic-sparkles text-gray-400",
};

const PARTS: ChromePart[] = ["header", "footer", "announcement"];

function partFromLocation(): ChromePart {
    if (typeof window === "undefined") return "header";
    const requested = new URLSearchParams(window.location.search).get("part");
    return PARTS.includes(requested as ChromePart) ? (requested as ChromePart) : "header";
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export default function ChromeEditorPage() {
    const { addToast } = useToast();
    const { t } = useI18n();
    // null until the URL is read on mount (?part=footer — where the retired /admin/footer redirects):
    // reading window during render would make the server and the first client render disagree.
    const [part, setPart] = useState<ChromePart | null>(null);
    const [initialData, setInitialData] = useState<Data | null>(null);
    const [source, setSource] = useState<ChromeSource>("starter");
    const [themeHasPart, setThemeHasPart] = useState(false);
    const [legacyText, setLegacyText] = useState<{ footerText: string; copyright: string }>({ footerText: "", copyright: "" });
    const [mountKey, setMountKey] = useState(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [migrating, setMigrating] = useState(false);
    const [confirmRestore, setConfirmRestore] = useState(false);
    const [pendingPart, setPendingPart] = useState<ChromePart | null>(null);
    const [dirty, setDirty] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [showTemplates, setShowTemplates] = useState(false);
    const [showSocials, setShowSocials] = useState(false);
    const [legacyInserted, setLegacyInserted] = useState(false);
    // The theme's layout v2 header.sticky — what an unset root `sticky` falls back to on the public site.
    const [themeSticky, setThemeSticky] = useState(true);

    // Save reads the LATEST editor data from a ref (state would re-render the whole page per keystroke);
    // dirty tracking compares the contract-shaped JSON against the loaded baseline — exact, no
    // "ignore the first onChange" heuristics.
    const latestDataRef = useRef<Data | null>(null);
    const baselineJsonRef = useRef<string>("");
    const editorApiRef = useRef<ChromeEditorApi | null>(null);
    // loadPart must keep a STABLE identity: re-running it reloads the composition and dropría las
    // ediciones sin guardar. The context hands out a NEW t() on every provider render, so read the
    // translator through a ref instead of depending on it. The ref is SEEDED with the first t() and
    // refreshed from an effect — writing it during render is what react-hooks/refs refuses, and the
    // only reads live in async error paths of loadPart, which always run after the commit.
    const tRef = useRef(t);
    useEffect(() => {
        tRef.current = t;
    }, [t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- lectura única de la URL (sistema externo) al montar; leerla en el render rompería la hidratación
        setPart(partFromLocation());
    }, []);

    const loadPart = useCallback(async (target: ChromePart, opts: { skipSite?: boolean } = {}) => {
        setLoading(true);
        setErrors([]);
        setConfirmRestore(false);
        setPendingPart(null);
        setLegacyInserted(false);
        try {
            // Same precedence the public layout resolves — the editor always opens the EFFECTIVE
            // chrome: 1º site option (site_chrome_*) → 2º active theme's chrome/<part>.json →
            // 3º the built-in chrome, converted → 4º starter template. Every level is fail-closed.
            let resolved: ChromeData | null = null;
            let from: ChromeSource = "starter";
            // The announcement bar validates at its own position (bars ChromeNav); header/footer default.
            const position = target === "announcement" ? ("announcement" as const) : undefined;
            // A FAILED settings read is not "nothing configured": falling through to the starter here
            // showed a pristine composition over a site that has a real one, and the next Save wrote
            // the starter on top of it. Treat it as an error and leave the editor empty instead.
            const settings = await settingsApi.get();
            const slug = settings?.template || "default";
            setLegacyText({ footerText: text(settings?.footer_text), copyright: text(settings?.footer_copyright) });
            {
                const raw = settings?.active_theme_layout as unknown;
                let layout: unknown = raw;
                try { if (typeof raw === "string") layout = raw.trim() ? JSON.parse(raw) : {}; } catch { layout = {}; }
                setThemeSticky(parseThemeLayout(layout).header.sticky);
            }
            if (!opts.skipSite) {
                const site = parseChromeData(settings?.[`site_chrome_${target}`], { source: "site", position });
                if (site.ok && site.data) { resolved = site.data; from = "site"; }
            }
            let themeOk = false;
            try {
                // Served statically from the active theme, same relative path the public layout uses.
                const res = await fetch(`/themes/${encodeURIComponent(slug)}/chrome/${target}.json`, { cache: "no-store" });
                if (res.ok) {
                    const theme = parseChromeData(await res.text(), { source: "theme", position });
                    if (theme.ok && theme.data) {
                        themeOk = true;
                        if (!resolved) { resolved = theme.data; from = "theme"; }
                    }
                }
            } catch { /* unreadable theme chrome — fall through */ }
            setThemeHasPart(themeOk);
            if (!resolved && target !== "announcement") {
                // What visitors see today when nothing is composed: the built-in Header/Footer in the
                // theme's layout variant, with the legacy footer settings — converted by the backend.
                const legacy = await chromeApi.legacy(target);
                const parsed = parseChromeData(legacy?.data, { source: "legacy" });
                if (parsed.ok && parsed.data) { resolved = parsed.data; from = "legacy"; }
            }
            if (!resolved) { resolved = STARTER_TEMPLATES[target]; from = "starter"; }

            const stamped = withBlockIds(resolved) as unknown as Data;
            setSource(from);
            latestDataRef.current = stamped;
            baselineJsonRef.current = JSON.stringify(toContractData(stamped));
            setDirty(false);
            setInitialData(stamped);
            setMountKey((k) => k + 1); // remount the editor with a fresh store for the new data
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

    useEffect(() => { if (part) loadPart(part); }, [part, loadPart]);

    const handleChange = useCallback((newData: Data) => {
        latestDataRef.current = newData;
        setDirty(JSON.stringify(toContractData(newData)) !== baselineJsonRef.current);
        // Editing instead of answering the pending switch IS "keep editing": drop the request, or an
        // undo back to the baseline (dirty false) followed by a new edit would resurrect the prompt.
        setPendingPart(null);
    }, []);

    // Leaving the page with unsaved edits asks first (the browser's own prompt — not window.confirm).
    useEffect(() => {
        if (!dirty) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [dirty]);

    const switchPart = (target: ChromePart) => {
        if (target === part || loading || saving) return;
        // Switching reloads the other part from scratch, so the in-memory edits are gone for good:
        // ask BEFORE discarding, in-page (window.confirm freezes the in-app browser — never use it).
        if (dirty) { setPendingPart(target); return; }
        setPart(target);
        window.history.replaceState(null, "", `?part=${target}`);
    };

    const showProblems = (entries: unknown[], data: unknown) => {
        setErrors(entries.map((entry) => formatChromeProblem(describeChromeProblem(entry, data, t))));
    };

    const handleSave = async () => {
        const data = latestDataRef.current;
        if (!part || !data || saving || loading) return;
        // Cinturón explícito (W44 aplicado al chrome): jamás guardar una composición no hidratada.
        if (unhydratedSaveBlocked({ isNew: false, loaded: initialData !== null })) return;
        const contract = toContractData(data);
        // Same fail-closed validation the renderer applies — catch violations locally before the
        // PUT; the backend validator (the write authority) re-checks and its 400 errors[] land in
        // the same banner, both in plain language.
        const local = parseChromeData(contract, { source: "editor", position: part === "announcement" ? "announcement" : undefined });
        if (!local.ok) { showProblems(local.errors, contract); return; }
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
            if (Array.isArray(err.errors) && err.errors.length > 0) showProblems(err.errors, contract);
            else setErrors([err.message || t("chrome.admin.saveFailed")]);
            addToast(t("chrome.admin.saveError"), "error");
        } finally {
            setSaving(false);
        }
    };

    const handleRestore = async () => {
        if (!part || restoring || loading) return;
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

    // The legacy footer, converted and stored server-side in one step (idempotent, lossless — the old
    // settings stay where they were). Then reload: the editor now opens the site composition.
    const handleMigrate = async () => {
        if (migrating || !part) return;
        setMigrating(true);
        try {
            const outcome = await chromeApi.migrateLegacy();
            addToast(t(`chrome.migrate.outcome.${outcome.footer}`), outcome.footer === "migrated" ? "success" : "info");
            await loadPart(part);
        } catch (e) {
            addToast((e as Error).message || t("chrome.migrate.error"), "error");
        } finally {
            setMigrating(false);
        }
    };

    // A theme footer is in effect, so the old footer text never reached the page: offer it as blocks.
    const insertLegacyText = () => {
        const blocks: ChromeData["content"] = [];
        if (legacyText.footerText) blocks.push({ type: "ChromeRow", props: { align: "start", gap: "md", items: [{ type: "ChromeRichText", props: { html: legacyText.footerText } }] } });
        if (legacyText.copyright) blocks.push({ type: "ChromeRow", props: { align: "center", gap: "sm", items: [{ type: "ChromeRichText", props: { html: legacyText.copyright } }] } });
        if (blocks.length === 0) return;
        editorApiRef.current?.append(blocks);
        setLegacyInserted(true);
    };

    const applyTemplate = (template: ChromeTemplate) => {
        editorApiRef.current?.replace(template.data);
        setShowTemplates(false);
        addToast(t("chrome.template.applied"), "success");
    };

    const templates = useMemo(() => (part ? chromeTemplates(t).filter((tpl) => tpl.part === part) : []), [part, t]);
    const hasLegacyText = !!(legacyText.footerText || legacyText.copyright);
    const restoreLabel = themeHasPart ? t("chrome.admin.restore") : t("chrome.admin.restoreBuiltIn");

    return (
        <div className="flex flex-col h-full w-full overflow-hidden bg-white">
            {/* PREMIUM HEADER (h-20) */}
            {/* Wraps onto two lines on narrow screens; the action buttons keep only their icon below sm
                (each carries its name as aria-label/title), so the bar never scrolls sideways. */}
            <div className="min-h-16 md:min-h-20 flex flex-wrap items-center justify-between bg-white/80 backdrop-blur-md px-3 sm:px-6 md:px-8 py-2 md:py-3 shrink-0 z-20 relative border-b border-gray-100 shadow-sm gap-x-4 gap-y-2">
                <div className="flex items-center gap-3 md:gap-6 min-w-0 flex-wrap">
                    <div className="hidden md:flex items-center gap-3 text-gray-900">
                        <div className="w-10 h-10 shrink-0 bg-gradient-to-br from-indigo-600 to-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
                            <i className="fa-solid fa-window-maximize text-lg"></i>
                        </div>
                        <div className="hidden md:block">
                            <h1 className="font-black italic text-xl tracking-tighter leading-none">{t("chrome.admin.title")}</h1>
                            <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest leading-none">{t("chrome.admin.subtitle")}</span>
                        </div>
                    </div>
                    <div className="h-8 w-px bg-gray-100 hidden md:block"></div>

                    {/* Part selector — toggle buttons, so the active part is exposed via aria-pressed */}
                    <div role="group" aria-label={t("chrome.admin.partSelector")} className="flex items-center bg-gray-100 rounded-xl p-1 gap-1">
                        {PARTS.map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => switchPart(p)}
                                aria-pressed={part === p}
                                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all ${part === p ? "bg-white text-indigo-600 shadow-sm" : "text-gray-400 hover:text-gray-600"}`}
                            >
                                {/* Non-colour cue for the active part (the fill/colour swap alone is invisible
                                    under forced colours and to users who can't tell the two apart). */}
                                <i className={`fa-solid fa-check text-[8px] ${part === p ? "" : "invisible"}`} aria-hidden="true"></i>
                                {t(`chrome.admin.part.${p}`)}
                            </button>
                        ))}
                    </div>

                    {/* Effective source — what visitors see right now, and where it comes from */}
                    <span
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-50 border border-gray-100 text-[11px] font-black uppercase tracking-widest text-gray-500 max-w-full min-w-0"
                        title={t(`chrome.admin.sourceHint.${source}`)}
                        data-wjs-chrome-source={source}
                    >
                        <i className={`fa-solid ${SOURCE_ICON[source]}`} aria-hidden="true"></i>
                        {t(`chrome.admin.source.${source}`)}
                        {dirty && <span className="text-amber-500 normal-case tracking-normal font-bold">· {t("chrome.admin.unsaved")}</span>}
                    </span>
                </div>

                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <button
                        type="button"
                        onClick={() => setShowTemplates(true)}
                        disabled={loading || !initialData}
                        className="min-h-11 min-w-11 px-3 sm:px-4 py-2 sm:py-3 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 border bg-white border-gray-200 text-gray-600 hover:border-indigo-200 hover:text-indigo-600 disabled:opacity-50"
                        aria-haspopup="dialog"
                        aria-label={t("chrome.template.open")}
                        title={t("chrome.template.open")}
                    >
                        <i className="fa-solid fa-swatchbook" aria-hidden="true"></i>
                        <span className="hidden sm:inline">{t("chrome.template.open")}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowSocials(true)}
                        className="min-h-11 min-w-11 px-3 sm:px-4 py-2 sm:py-3 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 border bg-white border-gray-200 text-gray-600 hover:border-indigo-200 hover:text-indigo-600"
                        aria-haspopup="dialog"
                        aria-label={t("chrome.socials.open")}
                        title={t("chrome.socials.open")}
                    >
                        <i className="fa-solid fa-share-nodes" aria-hidden="true"></i>
                        <span className="hidden sm:inline">{t("chrome.socials.open")}</span>
                    </button>
                    {source === "site" && (
                        <button
                            type="button"
                            onClick={handleRestore}
                            disabled={restoring || loading}
                            aria-label={confirmRestore ? t("chrome.admin.restoreConfirm") : restoreLabel}
                            className={`min-h-11 min-w-11 px-3 sm:px-4 py-2 sm:py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 border ${confirmRestore
                                ? "bg-red-50 border-red-200 text-red-600 hover:bg-red-100"
                                : "bg-white border-gray-200 text-gray-500 hover:border-purple-200 hover:text-purple-600"
                                } ${restoring || loading ? "opacity-50 cursor-not-allowed" : ""}`}
                            title={t(themeHasPart ? "chrome.admin.restoreHint" : "chrome.admin.restoreBuiltInHint")}
                        >
                            {restoring ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-rotate-left"></i>}
                            {/* The confirmation keeps its words at every width — it is the one place a label matters. */}
                            <span className={confirmRestore ? "" : "hidden sm:inline"}>{confirmRestore ? t("chrome.admin.restoreConfirm") : restoreLabel}</span>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || loading}
                        className={`min-h-11 px-5 sm:px-8 py-2 sm:py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg ${saving || loading
                            ? "bg-gray-100 text-gray-400 cursor-not-allowed shadow-none"
                            : "bg-gray-900 hover:bg-indigo-600 text-white shadow-gray-200 hover:shadow-indigo-500/30 hover:-translate-y-0.5"
                            }`}
                    >
                        {saving ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-floppy-disk"></i>}
                        {saving ? t("chrome.admin.saving") : t("chrome.admin.save")}
                    </button>
                </div>
            </div>

            {/* Validation problems — local check or the backend validator's 400, in plain language */}
            {errors.length > 0 && (
                <div role="alert" className="shrink-0 bg-red-50 border-b border-red-100 px-3 sm:px-6 md:px-8 py-3 flex items-start gap-3">
                    <i className="fa-solid fa-triangle-exclamation text-red-500 mt-0.5" aria-hidden="true"></i>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-black uppercase tracking-widest text-red-600 mb-1">{t("chrome.admin.contractError")}</p>
                        <ul className="text-xs text-red-600 space-y-0.5 list-disc pl-4">
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
                <div role="alert" className="shrink-0 bg-amber-50 border-b border-amber-100 px-3 sm:px-6 md:px-8 py-3 flex items-center flex-wrap gap-3">
                    <i className="fa-solid fa-triangle-exclamation text-amber-500" aria-hidden="true"></i>
                    <p className="flex-1 min-w-0 text-xs text-amber-700 font-medium">{t("chrome.admin.discardPrompt")}</p>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => { setPendingPart(null); setPart(pendingPart); window.history.replaceState(null, "", `?part=${pendingPart}`); }}
                            className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-all"
                        >
                            {t("chrome.admin.discardConfirm")}
                        </button>
                        <button
                            type="button"
                            onClick={() => setPendingPart(null)}
                            className="px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest bg-white border border-gray-200 text-gray-500 hover:text-gray-700 transition-all"
                        >
                            {t("chrome.admin.discardCancel")}
                        </button>
                    </div>
                </div>
            )}

            {/* Legacy footer: converted from the retired /admin/footer settings (source "legacy"), or —
                when a theme footer is in effect — the old text is offered as blocks to insert. */}
            {!loading && part === "footer" && source === "legacy" && hasLegacyText && (
                <div className="shrink-0 bg-amber-50/80 border-b border-amber-100 px-3 sm:px-6 md:px-8 py-2.5 flex items-center flex-wrap gap-3" data-wjs-chrome-legacy="convert">
                    <i className="fa-solid fa-clock-rotate-left text-amber-500" aria-hidden="true"></i>
                    <p className="flex-1 min-w-0 text-xs text-amber-800">{t("chrome.migrate.legacyNotice")}</p>
                    <button type="button" onClick={handleMigrate} disabled={migrating} className="px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
                        {migrating ? t("chrome.migrate.running") : t("chrome.migrate.convert")}
                    </button>
                </div>
            )}
            {!loading && part === "footer" && source === "theme" && hasLegacyText && !legacyInserted && (
                <div className="shrink-0 bg-amber-50/80 border-b border-amber-100 px-3 sm:px-6 md:px-8 py-2.5 flex items-center flex-wrap gap-3" data-wjs-chrome-legacy="insert">
                    <i className="fa-solid fa-circle-info text-amber-500" aria-hidden="true"></i>
                    <p className="flex-1 min-w-0 text-xs text-amber-800">{t("chrome.migrate.themeNotice")}</p>
                    <button type="button" onClick={insertLegacyText} className="px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest bg-white border border-amber-200 text-amber-700 hover:bg-amber-100">
                        {t("chrome.migrate.insert")}
                    </button>
                </div>
            )}

            {/* Source explanation + purge note */}
            <div className="shrink-0 bg-indigo-50/60 border-b border-indigo-100/60 px-3 sm:px-6 md:px-8 py-2 flex items-center gap-2">
                <i className="fa-solid fa-circle-info text-indigo-400 text-xs" aria-hidden="true"></i>
                <p className="text-[11px] text-indigo-600 font-medium">
                    {t(`chrome.admin.sourceHint.${source}`)} {t("chrome.admin.purgeNote")}
                </p>
            </div>

            {/* EDITOR — ChromeVersoEditor con el config de chrome; layout propio de 3 paneles. El
                iframe del lienzo carga wordjs-ui.css + la hoja del tema activo por sí mismo. */}
            <div className="relative flex-1 min-h-0 wjs-chrome-editor bg-gray-50/50">
                {loading || !initialData || !part ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-gray-300">
                            <i className="fa-solid fa-circle-notch fa-spin text-2xl"></i>
                            <span className="text-[11px] font-black uppercase tracking-widest">{t("chrome.admin.loading")}</span>
                        </div>
                    </div>
                ) : (
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
                        onApi={(api) => { editorApiRef.current = api; }}
                        rootDefaults={{ sticky: themeSticky, transparent: false, overlayText: "", width: "container" }}
                    />
                )}
            </div>

            {showTemplates && part && (
                <TemplatesDialog part={part} templates={templates} onPick={applyTemplate} onClose={() => setShowTemplates(false)} />
            )}
            {showSocials && (
                <SocialProfilesPanel onClose={() => setShowSocials(false)} onSaved={refreshEditorBindings} />
            )}
        </div>
    );
}

// Starter templates gallery. Each card draws a small wireframe of the template's structure (rows, and
// the blocks in them) so the choice is visual; picking one replaces the canvas in ONE undoable step.
function TemplatesDialog({ part, templates, onPick, onClose }: { part: ChromePart; templates: ChromeTemplate[]; onPick: (tpl: ChromeTemplate) => void; onClose: () => void }) {
    const { t } = useI18n();
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <DialogLayer className="flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="wjs-templates-title">
            <button type="button" className="absolute inset-0 bg-black/40" aria-label={t("close")} onClick={onClose} />
            <div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-2xl p-6">
                <div className="flex items-start justify-between gap-4 mb-5">
                    <div>
                        <h2 id="wjs-templates-title" className="font-black text-lg text-gray-900">{t("chrome.template.title")} · {t(`chrome.admin.part.${part}`)}</h2>
                        <p className="text-xs text-gray-500">{t("chrome.template.subtitle")}</p>
                    </div>
                    <button type="button" onClick={onClose} className="w-9 h-9 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label={t("close")}>
                        <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {templates.map((tpl) => (
                        <li key={tpl.id}>
                            <button
                                type="button"
                                onClick={() => onPick(tpl)}
                                data-wjs-chrome-template={tpl.id}
                                className="w-full text-left rounded-xl border border-gray-200 hover:border-indigo-300 hover:shadow-md transition-all p-3 group focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            >
                                <TemplateWireframe data={tpl.data} part={part} />
                                <span className="block mt-3 text-sm font-bold text-gray-800 group-hover:text-indigo-600">{t(tpl.nameKey)}</span>
                                <span className="block text-xs text-gray-500">{t(tpl.descriptionKey)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
        </DialogLayer>
    );
}

const WIRE_WIDTH: Record<string, string> = {
    ChromeLogo: "w-10", ChromeSiteTitle: "w-14", ChromeNav: "w-20", ChromeSearch: "w-12", ChromeSocials: "w-10",
    ChromeText: "w-16", ChromeButton: "w-8", ChromeSpacer: "w-2", ChromeHeading: "w-10", ChromeRichText: "w-16",
    ChromeCopyright: "w-14", ChromeLanguageSwitcher: "w-8", ChromeWidgets: "w-12",
};
const WIRE_TONE: Record<string, string> = { ChromeLogo: "bg-indigo-300", ChromeButton: "bg-indigo-500", ChromeNav: "bg-gray-400" };

function TemplateWireframe({ data, part }: { data: ChromeData; part: ChromePart }) {
    const dark = part === "footer";
    const render = (block: ChromeData["content"][number], key: string): React.ReactNode => {
        const props = block.props as Record<string, unknown>;
        const items = Array.isArray(props.items) ? (props.items as ChromeData["content"]) : null;
        if (items) {
            const column = props.direction === "column" || block.type === "ChromeColumns";
            const cls = block.type === "ChromeColumns"
                ? "grid grid-cols-4 gap-1 w-full"
                : `flex ${column ? "flex-col items-start" : "items-center justify-between"} gap-1 w-full ${props.tone && props.tone !== "none" ? "bg-gray-300/60 rounded px-1 py-0.5" : ""}`;
            return <div key={key} className={cls}>{items.map((child, i) => render(child, `${key}.${i}`))}</div>;
        }
        return <span key={key} className={`h-2 rounded-sm ${WIRE_WIDTH[block.type] || "w-8"} ${WIRE_TONE[block.type] || (dark ? "bg-gray-500" : "bg-gray-300")}`} />;
    };
    const transparent = (data.root?.props as Record<string, unknown> | undefined)?.transparent === true;
    return (
        <div aria-hidden="true" className={`rounded-lg p-2 flex flex-col gap-1.5 ${dark ? "bg-gray-800" : transparent ? "bg-gradient-to-br from-slate-500 to-indigo-300" : "bg-gray-100"} min-h-14`}>
            {data.content.map((block, i) => render(block, `b${i}`))}
        </div>
    );
}
