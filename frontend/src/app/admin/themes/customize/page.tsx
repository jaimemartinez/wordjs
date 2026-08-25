"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { settingsApi, themesApi, Theme } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button } from "@/components/ui";
import { sanitizeThemeMods } from "@/lib/themeTokenPolicy";

// The single settings key that stores the live theme overlay. The public site SSR-injects this
// (active_theme_mods option -> inline :root{}) so saving here re-skins the live site.
const MODS_KEY = "active_theme_mods";

// A --wjs-* design token the admin can edit, grouped under a labelled section.
interface TokenDef {
    key: string; // CSS custom property name, e.g. "--wjs-color-primary"
    label: string; // human label shown next to the control
    kind: "color" | "text"; // color = <input type=color> + text; text = plain text input
}

interface TokenGroup {
    title: string;
    icon: string;
    tokens: TokenDef[];
}

// `title` and `label` hold i18n keys resolved through t() at render time.
const TOKEN_GROUPS: TokenGroup[] = [
    {
        title: "customizer.group.colors",
        icon: "fa-palette",
        tokens: [
            { key: "--wjs-color-primary", label: "customizer.token.primary", kind: "color" },
            { key: "--wjs-color-primary-dark", label: "customizer.token.primaryDark", kind: "color" },
            { key: "--wjs-color-secondary", label: "customizer.token.secondary", kind: "color" },
            { key: "--wjs-color-accent", label: "customizer.token.accent", kind: "color" },
            { key: "--wjs-color-success", label: "customizer.token.success", kind: "color" },
            { key: "--wjs-color-danger", label: "customizer.token.danger", kind: "color" },
            { key: "--wjs-color-warning", label: "customizer.token.warning", kind: "color" },
            { key: "--wjs-color-info", label: "customizer.token.info", kind: "color" },
            { key: "--wjs-bg-canvas", label: "customizer.token.bgCanvas", kind: "color" },
            { key: "--wjs-bg-surface", label: "customizer.token.bgSurface", kind: "color" },
            { key: "--wjs-bg-muted", label: "customizer.token.bgMuted", kind: "color" },
            { key: "--wjs-color-text-main", label: "customizer.token.textMain", kind: "color" },
            { key: "--wjs-color-text-muted", label: "customizer.token.textMuted", kind: "color" },
            { key: "--wjs-color-heading", label: "customizer.token.heading", kind: "color" },
            { key: "--wjs-color-link", label: "customizer.token.link", kind: "color" },
            { key: "--wjs-border-subtle", label: "customizer.token.borderSubtle", kind: "color" },
        ],
    },
    {
        title: "customizer.group.typography",
        icon: "fa-font",
        tokens: [
            { key: "--wjs-font-family-base", label: "customizer.token.fontFamilyBase", kind: "text" },
            { key: "--wjs-font-family-heading", label: "customizer.token.fontFamilyHeading", kind: "text" },
            { key: "--wjs-font-size-base", label: "customizer.token.fontSizeBase", kind: "text" },
            { key: "--wjs-line-height-base", label: "customizer.token.lineHeightBase", kind: "text" },
        ],
    },
    {
        title: "customizer.group.shape",
        icon: "fa-shapes",
        tokens: [
            { key: "--wjs-radius", label: "customizer.token.radius", kind: "text" },
            { key: "--wjs-spacer", label: "customizer.token.spacer", kind: "text" },
        ],
    },
];

const ALL_TOKENS: TokenDef[] = TOKEN_GROUPS.flatMap((g) => g.tokens);

// Key/value sanitizer — mirror the server's contract: only --wjs-* keys, short values without CSS
// control characters. Returns a clean object suitable for JSON.stringify into the settings key.
function sanitizeMods(input: Record<string, string>): Record<string, string> {
    return sanitizeThemeMods(Object.fromEntries(
        Object.entries(input).map(([key, value]) => [key, (value ?? "").trim()]),
    ));
}

// Is a string a hex color the native color picker can render? (#rgb / #rrggbb)
function isHexColor(v: string): boolean {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ThemeCustomizerPage() {
    const { t } = useI18n();
    // Active theme (for the heading). null until loaded.
    const [activeTheme, setActiveTheme] = useState<Theme | null>(null);
    // The user's current (unsaved) overrides, keyed by token. Only tokens the user edited live here.
    const [overrides, setOverrides] = useState<Record<string, string>>({});
    // Seeded theme defaults, read once from the preview iframe's computed styles. Used only as the
    // placeholder / color-picker fallback — never saved.
    const [seeded, setSeeded] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [saveState, setSaveState] = useState<SaveState>("idle");
    const [errorText, setErrorText] = useState<string | null>(null);
    // Set when the preview iframe is cross-origin (split/separate deploy): reading its contentDocument
    // throws a SecurityError, so seeding/injection can never work — surface a notice instead of polling forever.
    const [previewBlocked, setPreviewBlocked] = useState(false);

    const iframeRef = useRef<HTMLIFrameElement>(null);
    // Hidden <input type=file> the "Import" button clicks — reading a JSON file the admin picked.
    const importInputRef = useRef<HTMLInputElement>(null);

    // --- Load active theme + existing overrides on mount ---------------------------------------
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [themes, settings] = await Promise.all([
                    themesApi.list(),
                    settingsApi.get(),
                ]);
                if (cancelled) return;

                const active =
                    themes.find((t) => t.active) ||
                    themes.find((t) => t.slug === "default") ||
                    themes[0] ||
                    null;
                setActiveTheme(active);

                // Parse the stored JSON overlay; tolerate empty / malformed values.
                const rawMods = settings[MODS_KEY];
                if (rawMods) {
                    try {
                        const parsed = JSON.parse(rawMods);
                        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                            const clean: Record<string, string> = {};
                            for (const [k, v] of Object.entries(parsed)) {
                                if (typeof v === "string") clean[k] = v;
                            }
                            setOverrides(clean);
                        }
                    } catch {
                        // ignore malformed JSON — start with no overrides
                    }
                }
            } catch (err) {
                if (!cancelled) {
                    setErrorText(err instanceof Error ? err.message : t("customizer.loadError"));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // --- Seed token defaults from the live theme via the preview iframe ------------------------
    // Mirror the editor-canvas pattern: poll for the iframe's contentDocument, guard nulls, read the
    // computed --wjs-* values once available, then stop. Runs once on mount.
    useEffect(() => {
        let done = false;
        const read = (): boolean => {
            try {
                const doc = iframeRef.current?.contentDocument;
                const win = iframeRef.current?.contentWindow;
                if (!doc?.documentElement || !win) return false;
                const cs = win.getComputedStyle(doc.documentElement);
                const next: Record<string, string> = {};
                for (const tok of ALL_TOKENS) {
                    const val = cs.getPropertyValue(tok.key).trim();
                    if (val) next[tok.key] = val;
                }
                if (Object.keys(next).length === 0) return false; // styles not applied yet
                setSeeded(next);
                return true;
            } catch {
                // Cross-origin preview (split/separate deploy): can't read the iframe. Stop polling.
                setPreviewBlocked(true);
                return true;
            }
        };
        if (read()) return;
        const timer = setInterval(() => {
            if (done) return;
            if (read()) {
                done = true;
                clearInterval(timer);
            }
        }, 400);
        const stop = setTimeout(() => clearInterval(timer), 12000);
        return () => {
            clearInterval(timer);
            clearTimeout(stop);
        };
    }, []);

    // --- Live preview: inject/update a <style> with the CURRENT overrides into the iframe -------
    // Re-runs whenever overrides change. Polls for the iframe head so it works even before load.
    useEffect(() => {
        const STYLE_ID = "wjs-theme-mods-preview";
        const clean = sanitizeMods(overrides);
        const css = Object.keys(clean).length
            ? `:root{${Object.entries(clean)
                  .map(([k, v]) => `${k}:${v};`)
                  .join("")}}`
            : "";

        let done = false;
        const apply = (): boolean => {
            try {
                const doc = iframeRef.current?.contentDocument;
                if (!doc?.head) return false;
                let styleEl = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
                if (!styleEl) {
                    styleEl = doc.createElement("style");
                    styleEl.id = STYLE_ID;
                    doc.head.appendChild(styleEl);
                }
                styleEl.textContent = css;
                return true;
            } catch {
                // Cross-origin preview (split/separate deploy): can't inject styles. Stop polling.
                setPreviewBlocked(true);
                return true;
            }
        };
        if (apply()) done = true;
        const timer = setInterval(() => {
            if (done) return;
            if (apply()) {
                done = true;
                clearInterval(timer);
            }
        }, 400);
        const stop = setTimeout(() => clearInterval(timer), 12000);
        return () => {
            clearInterval(timer);
            clearTimeout(stop);
        };
    }, [overrides]);

    // --- Editing handlers ----------------------------------------------------------------------
    const setToken = useCallback((key: string, value: string) => {
        setSaveState("idle");
        setOverrides((prev) => {
            const next = { ...prev };
            if (value === "") {
                delete next[key]; // clearing a field removes the override (falls back to theme default)
            } else {
                next[key] = value;
            }
            return next;
        });
    }, []);

    const handleSave = useCallback(async () => {
        setSaveState("saving");
        setErrorText(null);
        try {
            const clean = sanitizeMods(overrides);
            await settingsApi.update({ [MODS_KEY]: JSON.stringify(clean) });
            // Reflect the sanitized result back into state so the UI matches what was stored.
            setOverrides(clean);
            setSaveState("saved");
        } catch (err) {
            setSaveState("error");
            setErrorText(err instanceof Error ? err.message : t("customizer.saveError"));
        }
    }, [overrides, t]);

    const handleReset = useCallback(async () => {
        setSaveState("saving");
        setErrorText(null);
        try {
            await settingsApi.update({ [MODS_KEY]: "" });
            setOverrides({});
            setSaveState("saved");
        } catch (err) {
            setSaveState("error");
            setErrorText(err instanceof Error ? err.message : t("customizer.resetError"));
        }
    }, [t]);

    // Export: a plain link to the backend download endpoint (cookie-authed) — no state to manage.
    const handleExport = useCallback(() => {
        themesApi.exportMods();
    }, []);

    // Import: read the picked JSON file, hand it to the backend (which VALIDATES every key/value and
    // rejects the whole file on any bad entry), then reflect the applied mods back into the editor.
    const handleImportFile = useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            // Clear the input so re-picking the same file fires change again.
            e.target.value = "";
            if (!file) return;
            setSaveState("saving");
            setErrorText(null);
            try {
                const text = await file.text();
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    throw new Error(t("customizer.importInvalidJson"));
                }
                await themesApi.importMods(parsed);
                // Re-read the stored mods so the controls match exactly what the backend accepted.
                const settings = await settingsApi.get();
                const raw = settings[MODS_KEY];
                const next: Record<string, string> = {};
                if (raw) {
                    try {
                        const obj = JSON.parse(raw);
                        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                            for (const [k, v] of Object.entries(obj)) {
                                if (typeof v === "string") next[k] = v;
                            }
                        }
                    } catch {
                        /* ignore — leave editor as-is */
                    }
                }
                setOverrides(next);
                setSaveState("saved");
            } catch (err) {
                setSaveState("error");
                setErrorText(err instanceof Error ? err.message : t("customizer.importError"));
            }
        },
        [t],
    );

    const hasOverrides = Object.keys(sanitizeMods(overrides)).length > 0;

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50">
            <div className="max-w-7xl mx-auto">
                <PageHeader
                    icon="fa-paintbrush"
                    title={t("customizer.title")}
                    subtitle={
                        activeTheme
                            ? t("customizer.activeTheme").replace("{name}", activeTheme.name)
                            : loading
                              ? t("customizer.loadingTheme")
                              : t("customizer.subtitle")
                    }
                    actions={
                        <>
                            <input
                                ref={importInputRef}
                                type="file"
                                accept="application/json,.json"
                                className="hidden"
                                onChange={handleImportFile}
                            />
                            <Button
                                variant="secondary"
                                icon="fa-file-export"
                                onClick={handleExport}
                                disabled={saveState === "saving"}
                            >
                                {t("customizer.export")}
                            </Button>
                            <Button
                                variant="secondary"
                                icon="fa-file-import"
                                onClick={() => importInputRef.current?.click()}
                                disabled={saveState === "saving"}
                            >
                                {t("customizer.import")}
                            </Button>
                            <Button
                                variant="secondary"
                                icon="fa-rotate-left"
                                onClick={handleReset}
                                disabled={saveState === "saving" || !hasOverrides}
                            >
                                {t("customizer.reset")}
                            </Button>
                            <Button
                                icon={saveState === "saved" ? "fa-circle-check" : "fa-floppy-disk"}
                                loading={saveState === "saving"}
                                onClick={handleSave}
                                disabled={saveState === "saving"}
                            >
                                {saveState === "saved" ? t("customizer.saved") : t("customizer.saveChanges")}
                            </Button>
                        </>
                    }
                />

                {errorText && (
                    <div className="mb-8 p-5 rounded-2xl flex items-center gap-4 bg-rose-50 border border-rose-100 text-rose-700">
                        <i className="fa-solid fa-circle-exclamation text-xl"></i>
                        <p className="font-bold">{errorText}</p>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pb-20">
                    {/* LEFT: controls */}
                    <div className="space-y-8">
                        {TOKEN_GROUPS.map((group) => (
                            <div
                                key={group.title}
                                className="bg-white rounded-[32px] border border-gray-100 shadow-[0_15px_40px_-15px_rgba(0,0,0,0.04)] p-8"
                            >
                                <div className="flex items-center gap-3 mb-6">
                                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 flex items-center justify-center shadow-inner">
                                        <i className={`fa-solid ${group.icon}`}></i>
                                    </div>
                                    <h2 className="text-lg font-black text-gray-900 italic tracking-tight">
                                        {t(group.title)}
                                    </h2>
                                </div>

                                <div className="space-y-5">
                                    {group.tokens.map((tok) => {
                                        const value = overrides[tok.key] ?? "";
                                        const placeholder = seeded[tok.key] ?? "";
                                        return (
                                            <div key={tok.key} className="flex flex-col gap-2">
                                                <label
                                                    htmlFor={tok.key}
                                                    className="block text-[10px] font-black uppercase tracking-widest text-gray-400"
                                                >
                                                    {t(tok.label)}
                                                    <span className="ml-2 normal-case font-mono font-medium text-gray-300 tracking-normal">
                                                        {tok.key}
                                                    </span>
                                                </label>
                                                <div className="flex items-center gap-3">
                                                    {tok.kind === "color" && (
                                                        <input
                                                            type="color"
                                                            aria-label={`${t(tok.label)} ${t("customizer.colorPicker")}`}
                                                            value={
                                                                isHexColor(value)
                                                                    ? value
                                                                    : isHexColor(placeholder)
                                                                      ? placeholder
                                                                      : "#000000"
                                                            }
                                                            onChange={(e) =>
                                                                setToken(tok.key, e.target.value)
                                                            }
                                                            className="h-11 w-12 shrink-0 cursor-pointer rounded-xl border-2 border-gray-100 bg-white p-1"
                                                        />
                                                    )}
                                                    <input
                                                        id={tok.key}
                                                        type="text"
                                                        value={value}
                                                        placeholder={placeholder || t("customizer.themeDefault")}
                                                        onChange={(e) =>
                                                            setToken(tok.key, e.target.value)
                                                        }
                                                        className="w-full bg-gray-50/50 border-2 border-gray-100 focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium placeholder:text-gray-300 placeholder:font-normal px-4 py-3 text-sm rounded-xl font-mono"
                                                    />
                                                    {value && (
                                                        <button
                                                            type="button"
                                                            title={t("customizer.clearOverride")}
                                                            aria-label={t("customizer.clearOverrideAria").replace("{label}", t(tok.label))}
                                                            onClick={() => setToken(tok.key, "")}
                                                            className="shrink-0 w-9 h-9 rounded-xl text-gray-300 hover:text-rose-500 hover:bg-rose-50 transition-colors flex items-center justify-center"
                                                        >
                                                            <i className="fa-solid fa-xmark"></i>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* RIGHT: live preview */}
                    <div className="lg:sticky lg:top-12 self-start">
                        <div className="bg-white rounded-[32px] border border-gray-100 shadow-[0_15px_40px_-15px_rgba(0,0,0,0.04)] overflow-hidden flex flex-col h-[70vh] min-h-[480px]">
                            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-100 shrink-0">
                                <div className="flex items-center gap-2 text-gray-400">
                                    <span className="flex h-2.5 w-2.5 rounded-full bg-rose-300"></span>
                                    <span className="flex h-2.5 w-2.5 rounded-full bg-amber-300"></span>
                                    <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-300"></span>
                                </div>
                                <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                                    <i className="fa-solid fa-eye mr-2"></i>
                                    {t("customizer.livePreview")}
                                </span>
                            </div>
                            {previewBlocked && (
                                <div className="px-6 py-3 bg-amber-50 border-b border-amber-100 text-amber-700 text-xs font-medium flex items-center gap-2 shrink-0">
                                    <i className="fa-solid fa-triangle-exclamation"></i>
                                    {t("customizer.previewUnavailable")}
                                </div>
                            )}
                            <iframe
                                ref={iframeRef}
                                src="/"
                                title={t("customizer.previewTitle")}
                                className="flex-1 w-full border-0 bg-white"
                            />
                        </div>
                        <p className="mt-4 text-xs font-medium text-gray-400 px-2">
                            {t("customizer.help.pre")}
                            <span className="font-bold text-gray-600">{t("customizer.saveChanges")}</span>
                            {t("customizer.help.mid")}
                            <span className="font-bold text-gray-600">{t("customizer.reset")}</span>
                            {t("customizer.help.post")}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
