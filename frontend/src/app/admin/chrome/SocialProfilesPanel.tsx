"use client";

// The site's social profiles — the links every "Social links" block shows. They are a SITE setting
// (`footer_socials`, the option the legacy /admin/footer page used to edit), not part of a composition,
// so one list feeds the header, the footer and any theme that binds ChromeSocials. Moved here when the
// legacy page was retired; the stored shape is unchanged ([{ platform, url, icon }]).
import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { parseChromeSocials, safeChromeHref, type ChromeSocialLink } from "@/lib/chromeData";
import { useI18n } from "@/contexts/I18nContext";
import { useToast } from "@/contexts/ToastContext";
import DialogLayer from "@/components/DialogLayer";

export const SOCIAL_PLATFORMS = [
    { id: "facebook", name: "Facebook", icon: "fa-brands fa-facebook" },
    { id: "instagram", name: "Instagram", icon: "fa-brands fa-instagram" },
    { id: "twitter", name: "Twitter / X", icon: "fa-brands fa-x-twitter" },
    { id: "tiktok", name: "TikTok", icon: "fa-brands fa-tiktok" },
    { id: "youtube", name: "YouTube", icon: "fa-brands fa-youtube" },
    { id: "linkedin", name: "LinkedIn", icon: "fa-brands fa-linkedin" },
    { id: "github", name: "GitHub", icon: "fa-brands fa-github" },
    { id: "discord", name: "Discord", icon: "fa-brands fa-discord" },
    { id: "whatsapp", name: "WhatsApp", icon: "fa-brands fa-whatsapp" },
    { id: "telegram", name: "Telegram", icon: "fa-brands fa-telegram" },
    { id: "web", name: "Website", icon: "fa-solid fa-globe" },
];

export default function SocialProfilesPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [links, setLinks] = useState<ChromeSocialLink[] | null>(null);
    const [platform, setPlatform] = useState(SOCIAL_PLATFORMS[0].id);
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let alive = true;
        settingsApi.get()
            .then((settings) => { if (alive) setLinks(parseChromeSocials(settings)); })
            .catch(() => { if (alive) { setLinks([]); setError(t("chrome.socials.loadError")); } });
        return () => { alive = false; };
    }, [t]);

    // Escape closes the panel, like every other drawer in the admin.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const add = () => {
        const value = url.trim();
        if (!value) return;
        // Same rule the public block applies at render: a link that would not be painted is refused here.
        if (!safeChromeHref(value)) { setError(t("chrome.socials.badUrl")); return; }
        const p = SOCIAL_PLATFORMS.find((x) => x.id === platform);
        setLinks((prev) => [...(prev || []), { platform, url: value, icon: p ? p.icon : "fa-solid fa-link" }]);
        setUrl("");
        setError("");
    };

    const move = (index: number, delta: number) => setLinks((prev) => {
        const next = [...(prev || [])];
        const target = index + delta;
        if (target < 0 || target >= next.length) return next;
        [next[index], next[target]] = [next[target], next[index]];
        return next;
    });

    const save = async () => {
        if (!links) return;
        setSaving(true);
        try {
            await settingsApi.update({ footer_socials: JSON.stringify(links) });
            addToast(t("chrome.socials.saved"), "success");
            onSaved();
            onClose();
        } catch {
            addToast(t("chrome.socials.saveError"), "error");
        } finally {
            setSaving(false);
        }
    };

    return (
        <DialogLayer className="flex justify-end" role="dialog" aria-modal="true" aria-labelledby="wjs-socials-title">
            <button type="button" className="absolute inset-0 bg-black/30" aria-label={t("close")} onClick={onClose} />
            <div className="relative w-full max-w-md h-full bg-white shadow-2xl flex flex-col">
                <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                    <div>
                        <h2 id="wjs-socials-title" className="font-black text-lg text-gray-900">{t("chrome.socials.title")}</h2>
                        <p className="text-xs text-gray-400">{t("chrome.socials.subtitle")}</p>
                    </div>
                    <button type="button" onClick={onClose} className="w-9 h-9 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label={t("close")}>
                        <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-5">
                    <div className="flex flex-col gap-2">
                        <label htmlFor="wjs-social-platform" className="text-[10px] font-black uppercase tracking-widest text-gray-400">{t("chrome.socials.platform")}</label>
                        <select id="wjs-social-platform" value={platform} onChange={(e) => setPlatform(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                            {SOCIAL_PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <label htmlFor="wjs-social-url" className="text-[10px] font-black uppercase tracking-widest text-gray-400 mt-2">{t("chrome.socials.url")}</label>
                        <div className="flex gap-2">
                            <input
                                id="wjs-social-url"
                                type="url"
                                value={url}
                                onChange={(e) => { setUrl(e.target.value); setError(""); }}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
                                placeholder="https://"
                                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
                            />
                            <button type="button" onClick={add} className="px-4 rounded-lg bg-gray-900 text-white text-xs font-black uppercase tracking-widest hover:bg-indigo-600">{t("chrome.socials.add")}</button>
                        </div>
                        {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
                    </div>
                    <ul className="space-y-2" aria-label={t("chrome.socials.title")}>
                        {links === null && <li className="text-xs text-gray-400">{t("chrome.admin.loading")}</li>}
                        {links?.length === 0 && <li className="text-xs text-gray-400">{t("chrome.socials.empty")}</li>}
                        {links?.map((link, i) => (
                            <li key={`${link.platform}-${i}`} className="flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2">
                                <i className={`${link.icon || "fa-solid fa-link"} text-gray-500 w-5 text-center`} aria-hidden="true"></i>
                                <span className="flex-1 min-w-0 text-xs text-gray-700 truncate" title={link.url}>{link.url}</span>
                                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label={t("chrome.socials.up")}><i className="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
                                <button type="button" onClick={() => move(i, 1)} disabled={i === links.length - 1} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label={t("chrome.socials.down")}><i className="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
                                <button type="button" onClick={() => setLinks(links.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600" aria-label={t("chrome.socials.remove")}><i className="fa-solid fa-trash" aria-hidden="true"></i></button>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest text-gray-500 hover:bg-gray-100">{t("cancel")}</button>
                    <button type="button" onClick={save} disabled={saving || links === null} className="px-5 py-2 rounded-lg text-xs font-black uppercase tracking-widest bg-gray-900 text-white hover:bg-indigo-600 disabled:opacity-50">
                        {saving ? t("chrome.admin.saving") : t("chrome.admin.save")}
                    </button>
                </div>
            </div>
        </DialogLayer>
    );
}
