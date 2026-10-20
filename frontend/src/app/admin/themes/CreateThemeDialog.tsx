"use client";

import { useState } from "react";
import DialogLayer from "@/components/DialogLayer";
import { themesApi } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { contrastRatio, onColor, readableColor } from "@/lib/colorContrast";

/**
 * Themes → New theme: the panel path for `node backend/cli/wordjs.js create theme <slug> --primary
 * --secondary --bg --text`. Four seed colours, a heading and a body font, a live preview, and a live
 * WCAG AA check of the pairs a visitor reads. The server builds a declarative theme.json from them and
 * installs it only if the theme doctor finds no LOW_CONTRAST pair (backend routes/themes.ts POST /themes,
 * enforceContrast), so the guarantee does not rest on this screen.
 */

const SEEDS: Array<{ key: "primary" | "secondary" | "bg" | "text"; label: string; initial: string }> = [
    { key: "primary", label: "themes.create.primary", initial: "#2563eb" },
    { key: "secondary", label: "themes.create.secondary", initial: "#9333ea" },
    { key: "bg", label: "themes.create.bg", initial: "#ffffff" },
    { key: "text", label: "themes.create.text", initial: "#111827" },
];

/** Font stacks that need no download (offline installs, the CSP): what every visitor's system has. */
export const FONT_STACKS: Array<{ id: string; label: string; stack: string }> = [
    { id: "system", label: "System sans", stack: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` },
    { id: "humanist", label: "Humanist sans", stack: `Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif` },
    { id: "geometric", label: "Geometric sans", stack: `Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif` },
    { id: "serif", label: "Classic serif", stack: `Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif` },
    { id: "didone", label: "Elegant serif", stack: `Didot, "Bodoni MT", "Noto Serif Display", "URW Palladio L", P052, Sylfaen, serif` },
    { id: "slab", label: "Slab serif", stack: `Rockwell, "Rockwell Nova", "Roboto Slab", "DejaVu Serif", "Sitka Small", serif` },
    { id: "mono", label: "Monospace", stack: `ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace` },
];

export function themeSlugFrom(name: string): string {
    return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

/** The pairs a visitor reads, as the generated theme will paint them. */
export function contrastPairs(seeds: Record<string, string>) {
    return [
        { id: "text", ratio: contrastRatio(seeds.text, seeds.bg), min: 4.5 },
        { id: "button", ratio: contrastRatio(onColor(seeds.primary), seeds.primary), min: 4.5 },
        { id: "accent", ratio: contrastRatio(onColor(seeds.secondary), seeds.secondary), min: 4.5 },
    ];
}

export default function CreateThemeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string) => void }) {
    const { t } = useI18n();
    const [name, setName] = useState("");
    const [seeds, setSeeds] = useState<Record<string, string>>(Object.fromEntries(SEEDS.map((s) => [s.key, s.initial])));
    const [bodyFont, setBodyFont] = useState("system");
    const [headingFont, setHeadingFont] = useState("system");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [findings, setFindings] = useState<string[]>([]);
    const slug = themeSlugFrom(name);
    const pairs = contrastPairs(seeds);
    const failing = pairs.filter((p) => p.ratio < p.min);
    const stack = (id: string) => (FONT_STACKS.find((f) => f.id === id) || FONT_STACKS[0]).stack;

    /** Make the text readable on the background; a fill whose label cannot reach AA is darkened or lightened. */
    const fixContrast = () => {
        setSeeds((s) => {
            const next: Record<string, string> = { ...s, text: readableColor(s.text, s.bg) };
            for (const k of ["primary", "secondary"]) {
                if (contrastRatio(onColor(next[k]), next[k]) < 4.5) {
                    // Move the fill away from its label until the label reads on it.
                    next[k] = readableColor(next[k], onColor(next[k]));
                }
            }
            return next;
        });
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setFindings([]);
        if (!slug) { setError(t("themes.create.nameRequired")); return; }
        if (failing.length) { setError(t("themes.create.contrastFirst")); return; }
        setBusy(true);
        try {
            const tokens: Record<string, string> = {};
            if (bodyFont !== "system") tokens["--wjs-font-family-base"] = stack(bodyFont);
            if (headingFont !== bodyFont) tokens["--wjs-font-family-heading"] = stack(headingFont);
            await themesApi.create({
                slug,
                metadata: { name: name.trim() },
                seeds: { primary: seeds.primary, secondary: seeds.secondary, bg: seeds.bg, text: seeds.text },
                ...(Object.keys(tokens).length ? { tokens } : {}),
                enforceContrast: true,
            });
            onCreated(slug);
        } catch (err: any) {
            const list = Array.isArray(err?.data?.findings) ? err.data.findings : Array.isArray(err?.details?.findings) ? err.details.findings : [];
            setFindings(list.map((f: any) => String(f.message || "")).filter(Boolean));
            setError(err?.message || t("themes.create.failed"));
        } finally {
            setBusy(false);
        }
    };

    const labelFor: Record<string, string> = { text: t("themes.create.pairText"), button: t("themes.create.pairButton"), accent: t("themes.create.pairAccent") };

    return (
        <DialogLayer className="bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300">
            <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-theme-title" data-testid="create-theme-dialog"
                className="bg-white rounded-[32px] max-w-lg w-full shadow-2xl border border-slate-200/50 p-6 sm:p-8 space-y-5 max-h-[90dvh] overflow-y-auto">
                <h2 id="create-theme-title" className="text-xl font-bold text-gray-900 flex items-center gap-3">
                    <i className="fa-solid fa-swatchbook text-blue-600" aria-hidden="true"></i>{t("themes.create.title")}
                </h2>
                <p className="text-sm text-gray-500">{t("themes.create.help")}</p>
                <div className="space-y-2">
                    <label htmlFor="create-theme-name" className="text-xs font-bold uppercase tracking-wide text-gray-600">{t("themes.create.name")}</label>
                    <input id="create-theme-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80}
                        className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900" />
                    {slug && <p className="text-xs text-gray-400 font-mono">themes/{slug}</p>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                    {SEEDS.map((s) => (
                        <label key={s.key} className="flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2">
                            <input type="color" value={seeds[s.key]} onChange={(e) => setSeeds((v) => ({ ...v, [s.key]: e.target.value }))} className="h-9 w-12 cursor-pointer rounded" aria-label={t(s.label)} />
                            <span className="text-sm text-gray-700">{t(s.label)}</span>
                        </label>
                    ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {([["create-theme-heading-font", "themes.create.headingFont", headingFont, setHeadingFont], ["create-theme-body-font", "themes.create.bodyFont", bodyFont, setBodyFont]] as const).map(([id, label, value, set]) => (
                        <div key={id} className="space-y-1">
                            <label htmlFor={id} className="text-xs font-bold uppercase tracking-wide text-gray-600">{t(label)}</label>
                            <select id={id} value={value} onChange={(e) => set(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm">
                                {FONT_STACKS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                            </select>
                        </div>
                    ))}
                </div>
                <div className="rounded-2xl p-5 border" style={{ background: seeds.bg, color: seeds.text, borderColor: seeds.secondary }} data-testid="create-theme-preview">
                    <p className="text-lg font-bold" style={{ fontFamily: stack(headingFont) }}>{name || t("themes.create.previewTitle")}</p>
                    <p className="text-sm" style={{ fontFamily: stack(bodyFont) }}>{t("themes.create.previewText")}</p>
                    <div className="mt-3 flex gap-2">
                        <span className="inline-block rounded-lg px-3 py-1 text-sm font-bold" style={{ background: seeds.primary, color: onColor(seeds.primary), fontFamily: stack(bodyFont) }}>{t("themes.create.previewButton")}</span>
                        <span className="inline-block rounded-lg px-3 py-1 text-sm font-bold" style={{ background: seeds.secondary, color: onColor(seeds.secondary), fontFamily: stack(bodyFont) }}>{t("themes.create.previewAccent")}</span>
                    </div>
                </div>
                <ul className="space-y-1 text-sm" data-testid="create-theme-contrast" aria-label={t("themes.create.contrastTitle")}>
                    {pairs.map((p) => (
                        <li key={p.id} data-ok={p.ratio >= p.min ? "1" : "0"} className={`flex items-center gap-2 ${p.ratio >= p.min ? "text-emerald-700" : "text-red-600"}`}>
                            <i className={`fa-solid ${p.ratio >= p.min ? "fa-circle-check" : "fa-circle-xmark"}`} aria-hidden="true"></i>
                            <span>{labelFor[p.id]}: {p.ratio.toFixed(2)}:1</span>
                            <span className="text-xs text-gray-400">({t("themes.create.needs").replace("{min}", String(p.min))})</span>
                        </li>
                    ))}
                </ul>
                {failing.length > 0 && (
                    <button type="button" onClick={fixContrast} className="text-sm font-bold text-blue-700 underline" data-testid="create-theme-fix-contrast">
                        {t("themes.create.fixContrast")}
                    </button>
                )}
                {error && (
                    <div role="alert" className="text-sm text-red-600 break-words">
                        <p>{error}</p>
                        {findings.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{findings.map((f) => <li key={f}>{f}</li>)}</ul>}
                    </div>
                )}
                <div className="flex justify-end gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-3 rounded-xl border border-gray-200 text-gray-700 font-bold text-sm">{t("cancel")}</button>
                    <button type="submit" disabled={busy || failing.length > 0} className="px-5 py-3 rounded-xl bg-gray-900 text-white font-bold text-sm disabled:opacity-50">
                        {busy ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> : t("themes.create.submit")}
                    </button>
                </div>
            </form>
        </DialogLayer>
    );
}
