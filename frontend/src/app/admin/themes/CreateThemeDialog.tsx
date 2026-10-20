"use client";

import { useState } from "react";
import DialogLayer from "@/components/DialogLayer";
import { themesApi } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";

/**
 * Themes → New theme: the panel path for `node backend/cli/wordjs.js create theme <slug> --primary
 * --secondary --bg --text`. Four seed colours and a name become a declarative theme.json that the
 * server compiles into the theme's stylesheet (backend routes/themes.ts POST /themes); the new theme is
 * then listed and activated like any other.
 */

const SEEDS: Array<{ key: "primary" | "secondary" | "bg" | "text"; label: string; initial: string }> = [
    { key: "primary", label: "themes.create.primary", initial: "#2563eb" },
    { key: "secondary", label: "themes.create.secondary", initial: "#9333ea" },
    { key: "bg", label: "themes.create.bg", initial: "#ffffff" },
    { key: "text", label: "themes.create.text", initial: "#111827" },
];

export function themeSlugFrom(name: string): string {
    return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

export default function CreateThemeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string) => void }) {
    const { t } = useI18n();
    const [name, setName] = useState("");
    const [seeds, setSeeds] = useState<Record<string, string>>(Object.fromEntries(SEEDS.map((s) => [s.key, s.initial])));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const slug = themeSlugFrom(name);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (!slug) { setError(t("themes.create.nameRequired")); return; }
        setBusy(true);
        try {
            await themesApi.create({ slug, metadata: { name: name.trim() }, seeds: { primary: seeds.primary, secondary: seeds.secondary, bg: seeds.bg, text: seeds.text } });
            onCreated(slug);
        } catch (err: any) {
            setError(err?.message || t("themes.create.failed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <DialogLayer className="bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300">
            <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-theme-title" data-testid="create-theme-dialog"
                className="bg-white rounded-[32px] max-w-lg w-full shadow-2xl border border-slate-200/50 p-8 space-y-6">
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
                <div className="grid grid-cols-2 gap-4">
                    {SEEDS.map((s) => (
                        <label key={s.key} className="flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2">
                            <input type="color" value={seeds[s.key]} onChange={(e) => setSeeds((v) => ({ ...v, [s.key]: e.target.value }))} className="h-9 w-12 cursor-pointer rounded" aria-label={t(s.label)} />
                            <span className="text-sm text-gray-700">{t(s.label)}</span>
                        </label>
                    ))}
                </div>
                <div className="rounded-2xl p-5 border" style={{ background: seeds.bg, color: seeds.text, borderColor: seeds.secondary }} aria-hidden="true">
                    <p className="font-bold">{name || t("themes.create.previewTitle")}</p>
                    <p className="text-sm opacity-80">{t("themes.create.previewText")}</p>
                    <span className="mt-3 inline-block rounded-lg px-3 py-1 text-sm font-bold" style={{ background: seeds.primary, color: seeds.bg }}>{t("themes.create.previewButton")}</span>
                </div>
                {error && <p role="alert" className="text-sm text-red-600 break-words">{error}</p>}
                <div className="flex justify-end gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-3 rounded-xl border border-gray-200 text-gray-700 font-bold text-sm">{t("cancel")}</button>
                    <button type="submit" disabled={busy} className="px-5 py-3 rounded-xl bg-gray-900 text-white font-bold text-sm disabled:opacity-50">
                        {busy ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> : t("themes.create.submit")}
                    </button>
                </div>
            </form>
        </DialogLayer>
    );
}
