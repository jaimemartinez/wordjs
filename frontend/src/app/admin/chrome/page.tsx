"use client";

// /admin/chrome — "Cabecera y Pie (beta)": the composable-chrome (contract v1) editor. Mounts
// @wordjs/puck's <Puck> DIRECTLY with the chrome-only config (chromeEditorConfig.tsx) — NOT the
// pages PuckEditor, which is coupled to posts (autosave/revisions/status). Loads the EFFECTIVE
// composition with the same precedence the public layout resolves (site option → theme chrome
// file → starter template), saves through the dedicated PUT /api/v1/chrome/:part (backend
// validator is the write authority) and restores by DELETE + reload. The legacy /admin/footer
// page stays alongside during the beta.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Puck, type Data } from "@wordjs/puck";
import "@wordjs/puck/puck.css";
import { chromeApi, settingsApi, type ChromePart } from "@/lib/api";
import { themeStylesheetHref, uiFrameworkHref } from "@/lib/assetVersion";
import { parseChromeData, STARTER_TEMPLATES, type ChromeBlock, type ChromeData } from "@/lib/chromeData";
import { useToast } from "@/contexts/ToastContext";
import { buildChromeEditorConfig } from "./chromeEditorConfig";

type ChromeSource = "site" | "theme" | "starter";

const SOURCE_LABEL: Record<ChromeSource, string> = {
    site: "Composición del sitio",
    theme: "Chrome del tema",
    starter: "Plantilla inicial",
};

// Puck keys every block instance by a stable string props.id; theme files / starter templates ship
// without ids, so stamp them once on load (the contract explicitly allows the editor's id prop).
const genId = (type: string) =>
    `${type}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`;

function withBlockIds(data: ChromeData): ChromeData {
    const stamp = (block: ChromeBlock): ChromeBlock => {
        const props: Record<string, unknown> = { ...(block.props || {}) };
        if (typeof props.id !== "string") props.id = genId(block.type);
        if (block.type === "ChromeRow" && Array.isArray(props.items)) {
            props.items = (props.items as ChromeBlock[]).map(stamp);
        }
        return { type: block.type, props };
    };
    return { root: { props: { ...(data.root?.props || {}) } }, content: (data.content || []).map(stamp) };
}

// The stored contract form is EXACTLY { root, content } — Puck's Data may carry extras (e.g. a
// legacy `zones` key); never persist anything beyond the contract shape.
function toContractData(data: Data): ChromeData {
    const d = data as unknown as { root?: { props?: Record<string, unknown> }; content?: ChromeBlock[] };
    return { root: { props: d.root?.props ?? {} }, content: d.content ?? [] };
}

// The backend validator answers with structured entries ({ code, path, message }), the local one with
// plain strings. Both end up in the same banner, so flatten to text here: rendering an object as a
// React child throws and takes the whole editor down — on the very path meant to REPORT a problem.
// The path is kept in the message because it names the offending block ("content.2.props.href").
function describeError(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
        const e = entry as { path?: unknown; message?: unknown; code?: unknown };
        const message = typeof e.message === "string" ? e.message : typeof e.code === "string" ? e.code : "";
        const path = typeof e.path === "string" && e.path ? `${e.path}: ` : "";
        if (message) return `${path}${message}`;
    }
    return "Error de validación no reconocido";
}

export default function ChromeEditorPage() {
    const { addToast } = useToast();
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
    const [dirty, setDirty] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);

    // Save reads the LATEST Puck data from a ref (state would re-render the whole page per keystroke);
    // dirty tracking compares the contract-shaped JSON against the loaded baseline — exact, no
    // "ignore the first onChange" heuristics.
    const latestDataRef = useRef<Data | null>(null);
    const baselineJsonRef = useRef<string>("");

    const config = useMemo(() => buildChromeEditorConfig(part), [part]);

    const loadPart = useCallback(async (target: ChromePart, opts: { skipSite?: boolean } = {}) => {
        setLoading(true);
        setErrors([]);
        setConfirmRestore(false);
        try {
            // Same precedence the public layout resolves — the editor always opens the EFFECTIVE
            // chrome: 1º site option (site_chrome_*) → 2º active theme's chrome/<part>.json →
            // 3º starter template. Every level is fail-closed via parseChromeData.
            let resolved: ChromeData | null = null;
            let from: ChromeSource = "starter";
            // A FAILED settings read is not "nothing configured": falling through to the starter here
            // showed a pristine composition over a site that has a real one, and the next Save wrote
            // the starter on top of it. Treat it as an error and leave the editor empty instead.
            const settings = await settingsApi.get();
            const slug = settings?.template || "default";
            if (!opts.skipSite) {
                const site = parseChromeData(settings?.[`site_chrome_${target}`], { source: "site" });
                if (site.ok && site.data) { resolved = site.data; from = "site"; }
            }
            if (!resolved) {
                try {
                    // Served statically from the active theme, same relative path the admin footer
                    // page already uses for /themes/<slug>/style.css.
                    const res = await fetch(`/themes/${encodeURIComponent(slug)}/chrome/${target}.json`, { cache: "no-store" });
                    if (res.ok) {
                        const theme = parseChromeData(await res.text(), { source: "theme" });
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
            setErrors([`No se pudo cargar la composición actual: ${(e as Error).message || "error de red"}. Recarga la página antes de editar — guardar ahora sobrescribiría la composición del sitio.`]);
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
            if (iframe && !iframe.title) iframe.title = "Lienzo de edición de la cabecera y el pie";
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
    }, [themeSlug, themeVersion, mountKey]);

    const handleChange = useCallback((newData: Data) => {
        latestDataRef.current = newData;
        setDirty(JSON.stringify(toContractData(newData)) !== baselineJsonRef.current);
    }, []);

    const switchPart = (target: ChromePart) => {
        if (target === part || loading || saving) return;
        if (dirty) addToast("Se descartaron los cambios sin guardar", "info");
        setPart(target);
    };

    const handleSave = async () => {
        const data = latestDataRef.current;
        if (!data || saving || loading) return;
        const contract = toContractData(data);
        // Same fail-closed validation the renderer applies — catch violations locally before the
        // PUT; the backend validator (the write authority) re-checks and its 400 errors[] land in
        // the same banner.
        const local = parseChromeData(contract, { source: "editor" });
        if (!local.ok) { setErrors(local.errors); return; }
        setSaving(true);
        setErrors([]);
        try {
            await chromeApi.save(part, contract);
            baselineJsonRef.current = JSON.stringify(contract);
            setDirty(false);
            setSource("site");
            addToast("Composición guardada", "success");
        } catch (e) {
            const err = e as Error & { errors?: unknown[] };
            const list = Array.isArray(err.errors) && err.errors.length > 0 ? err.errors.map(describeError) : [];
            setErrors(list.length > 0 ? list : [err.message || "No se pudo guardar"]);
            addToast("No se pudo guardar la composición", "error");
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
            addToast("Composición del sitio eliminada — se usa la del tema", "success");
            await loadPart(part, { skipSite: true });
        } catch (e) {
            addToast((e as Error).message || "No se pudo restaurar", "error");
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
                            <h1 className="font-black italic text-xl tracking-tighter leading-none">Cabecera y Pie</h1>
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">Chrome componible (beta)</span>
                        </div>
                    </div>
                    <div className="h-8 w-px bg-gray-100 hidden md:block"></div>

                    {/* Part selector */}
                    <div className="flex items-center bg-gray-100 rounded-xl p-1 gap-1">
                        {(["header", "footer"] as ChromePart[]).map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => switchPart(p)}
                                className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${part === p ? "bg-white text-indigo-600 shadow-sm" : "text-gray-400 hover:text-gray-600"}`}
                            >
                                {p === "header" ? "Cabecera" : "Pie"}
                            </button>
                        ))}
                    </div>

                    {/* Effective source badge */}
                    <span className="hidden lg:inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-50 border border-gray-100 text-[10px] font-black uppercase tracking-widest text-gray-400">
                        <i className={`fa-solid ${source === "site" ? "fa-floppy-disk text-indigo-500" : source === "theme" ? "fa-palette text-purple-500" : "fa-wand-magic-sparkles text-gray-400"}`}></i>
                        {SOURCE_LABEL[source]}
                        {dirty && <span className="text-amber-500 normal-case tracking-normal font-bold">· sin guardar</span>}
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
                        title="Elimina la composición del sitio y vuelve al chrome del tema"
                    >
                        {restoring ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-rotate-left"></i>}
                        {confirmRestore ? "¿Seguro? Confirmar" : "Restaurar del tema"}
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
                        {saving ? "Guardando…" : "Guardar"}
                    </button>
                </div>
            </div>

            {/* Validation errors from the local check or the backend validator's 400 */}
            {errors.length > 0 && (
                <div className="shrink-0 bg-red-50 border-b border-red-100 px-6 md:px-8 py-3 flex items-start gap-3">
                    <i className="fa-solid fa-triangle-exclamation text-red-500 mt-0.5"></i>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-black uppercase tracking-widest text-red-600 mb-1">La composición no cumple el contrato</p>
                        <ul className="text-xs text-red-500 space-y-0.5 list-disc pl-4">
                            {errors.map((err, i) => <li key={i} className="break-words">{err}</li>)}
                        </ul>
                    </div>
                    <button type="button" onClick={() => setErrors([])} className="text-red-300 hover:text-red-500 transition-colors p-1" aria-label="Cerrar">
                        <i className="fa-solid fa-xmark"></i>
                    </button>
                </div>
            )}

            {/* Purge note — kept simple on purpose */}
            <div className="shrink-0 bg-indigo-50/60 border-b border-indigo-100/60 px-6 md:px-8 py-2 flex items-center gap-2">
                <i className="fa-solid fa-circle-info text-indigo-400 text-xs"></i>
                <p className="text-[11px] text-indigo-500 font-medium">Los cambios guardados se ven en el sitio público en ~2 segundos (purga automática de caché).</p>
            </div>

            {/* EDITOR — Puck mounted directly with the chrome-only config; custom 3-pane layout
                (children replace Puck's default UI). The iframe canvas gets the active theme's
                stylesheets injected by the effect above. */}
            <div className="relative flex-1 min-h-0 wjs-chrome-editor bg-gray-50/50">
                {loading || !initialData ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-gray-300">
                            <i className="fa-solid fa-circle-notch fa-spin text-2xl"></i>
                            <span className="text-[10px] font-black uppercase tracking-widest">Cargando composición…</span>
                        </div>
                    </div>
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
                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Bloques</h3>
                                    <Puck.Components />
                                </div>
                                <div className="p-3">
                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Estructura</h3>
                                    <Puck.Outline />
                                </div>
                            </aside>

                            {/* Center: canvas */}
                            <main className="flex-1 min-w-0 min-h-0 overflow-hidden p-4 md:p-6 flex flex-col">
                                <div className="flex-1 min-h-0 mx-auto w-full max-w-5xl bg-white shadow-xl rounded-xl overflow-hidden border border-gray-200">
                                    <Puck.Preview />
                                </div>
                            </main>

                            {/* Right: selected block fields */}
                            <aside className="w-72 shrink-0 border-l border-gray-100 bg-white overflow-y-auto custom-scrollbar hidden lg:block">
                                <div className="p-3">
                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Propiedades</h3>
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
