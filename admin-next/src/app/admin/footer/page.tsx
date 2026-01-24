"use client";

import { useEffect, useState } from "react";
import { settingsApi, menusApi, themesApi } from "@/lib/api";
import Link from "next/link";
import { useToast } from "@/contexts/ToastContext";
import ModernSelect from "@/components/ModernSelect";
import Footer from "@/components/public/Footer";

interface SocialLink {
    platform: string;
    url: string;
    icon: string;
}

const PLATFORMS = [
    { id: 'facebook', name: 'Facebook', icon: 'fa-brands fa-facebook' },
    { id: 'instagram', name: 'Instagram', icon: 'fa-brands fa-instagram' },
    { id: 'twitter', name: 'Twitter / X', icon: 'fa-brands fa-x-twitter' },
    { id: 'tiktok', name: 'TikTok', icon: 'fa-brands fa-tiktok' },
    { id: 'youtube', name: 'YouTube', icon: 'fa-brands fa-youtube' },
    { id: 'linkedin', name: 'LinkedIn', icon: 'fa-brands fa-linkedin' },
    { id: 'github', name: 'GitHub', icon: 'fa-brands fa-github' },
    { id: 'discord', name: 'Discord', icon: 'fa-brands fa-discord' },
    { id: 'whatsapp', name: 'WhatsApp', icon: 'fa-brands fa-whatsapp' },
    { id: 'telegram', name: 'Telegram', icon: 'fa-brands fa-telegram' },
    { id: 'web', name: 'Website', icon: 'fa-solid fa-globe' },
];

export default function FooterSettingsPage() {
    const { addToast } = useToast();
    const [settings, setSettings] = useState({
        footer_text: "",
        footer_copyright: "",
        footer_socials: "[]",
        site_logo: "",
        blogname: "My Site"
    });

    // UI State for Social Builder
    const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
    const [newPlatform, setNewPlatform] = useState(PLATFORMS[0].id);
    const [newUrl, setNewUrl] = useState("");

    // Preview Menu
    const [previewMenu, setPreviewMenu] = useState<any[]>([]);

    const [saving, setSaving] = useState(false);
    const [themeCss, setThemeCss] = useState("");

    useEffect(() => {
        loadSettings();
        loadThemeCss();
    }, []);

    const loadThemeCss = async () => {
        try {
            const themes = await themesApi.list();
            const active = themes.find(t => t.active) || themes.find(t => t.slug === 'default');
            if (active) {
                const res = await fetch(`/themes/${active.slug}/style.css`);
                let css = await res.text();
                // Scope the CSS variables and base styles to our preview container
                // 1. Replace :root with the ID
                // 2. Replace body selector with the ID to capture background colors etc
                css = css.replace(/:root/g, '#preview-theme-scope')
                    .replace(/body/g, '#preview-theme-scope');
                setThemeCss(css);
            }
        } catch (e) {
            console.error("Failed to load theme css", e);
        }
    };

    const loadSettings = async () => {
        try {
            const data = await settingsApi.get();
            setSettings({
                footer_text: data.footer_text || "",
                footer_copyright: data.footer_copyright || "",
                footer_socials: data.footer_socials || "[]",
                site_logo: data.site_logo || "",
                blogname: data.blogname || "My Site"
            });

            // Load Footer Menu for Preview
            try {
                const menuData = await menusApi.getByLocation('footer');
                if (menuData && menuData.items) {
                    setPreviewMenu(menuData.items);
                }
            } catch (err) {
                // Ignore if no menu assigned
                console.log("No footer menu assigned or error loading it.");
                setPreviewMenu([]);
            }

            try {
                let parsed = data.footer_socials;
                if (typeof parsed === 'string') {
                    parsed = JSON.parse(parsed || "[]");
                } else if (!parsed) {
                    parsed = [] as any;
                }
                if (Array.isArray(parsed)) {
                    setSocialLinks(parsed);
                }
            } catch (e) {
                console.error("Error parsing socials:", e);
                setSocialLinks([]);
            }

        } catch (error) {
            console.error("Failed to load footer settings:", error);
            addToast("Failed to load settings", "error");
        }
    };

    const addSocialLink = () => {
        if (!newUrl) return;
        const platformData = PLATFORMS.find(p => p.id === newPlatform);
        const newLink: SocialLink = {
            platform: newPlatform,
            url: newUrl,
            icon: platformData ? platformData.icon : 'fa-solid fa-link'
        };
        setSocialLinks([...socialLinks, newLink]);
        setNewUrl("");
    };

    const removeSocialLink = (index: number) => {
        const newLinks = [...socialLinks];
        newLinks.splice(index, 1);
        setSocialLinks(newLinks);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        if (e) e.preventDefault();
        setSaving(true);

        const payload = {
            ...settings,
            footer_socials: JSON.stringify(socialLinks)
        };

        try {
            await settingsApi.update(payload);
            addToast("Footer settings saved successfully!", "success");
        } catch (error) {
            addToast("Failed to save settings", "error");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex flex-col h-full w-full overflow-hidden bg-white">
            {/* PREMIUM HEADER (h-20) */}
            <div className="h-20 flex items-center justify-between bg-white/80 backdrop-blur-md px-6 md:px-8 shrink-0 z-20 relative border-b border-gray-100 shadow-sm gap-6">
                {/* Left: Branding */}
                <div className="flex items-center gap-6">
                    <div className="flex items-center gap-3 text-gray-900">
                        <div className="w-10 h-10 bg-gradient-to-br from-purple-600 to-pink-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-purple-500/20">
                            <i className="fa-solid fa-shoe-prints text-lg"></i>
                        </div>
                        <div className="hidden md:block">
                            <h1 className="font-black italic text-xl tracking-tighter leading-none">Footer</h1>
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">Global Settings</span>
                        </div>
                    </div>
                    <div className="h-8 w-px bg-gray-100 hidden md:block"></div>
                </div>

                {/* Right: Actions */}
                <div className="flex items-center gap-4">
                    <button
                        type="button"
                        onClick={(e) => handleSubmit(e as any)}
                        disabled={saving}
                        className={`px-8 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg ${saving
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed shadow-none'
                            : 'bg-gray-900 hover:bg-purple-600 text-white shadow-gray-200 hover:shadow-purple-500/30 hover:-translate-y-0.5'
                            }`}
                    >
                        {saving ? (
                            <i className="fa-solid fa-circle-notch fa-spin"></i>
                        ) : (
                            <i className="fa-solid fa-floppy-disk"></i>
                        )}
                        {saving ? "Guardando..." : "Guardar Cambios"}
                    </button>
                </div>
            </div>

            {/* 2. Content Area */}
            <div className="relative flex-1 w-full bg-gray-50/50 overflow-hidden flex flex-col min-h-0 md:flex-row">

                {/* SETTINGS SIDEBAR (Left) */}
                <div className="flex flex-col w-[400px] bg-white z-30 shadow-[4px_0_24px_-4px_rgba(0,0,0,0.05)] border-r border-gray-100 relative">
                    {/* Gradient Border Line */}
                    <div className="absolute top-0 bottom-0 right-0 w-px bg-gradient-to-b from-gray-100 via-gray-200 to-gray-100"></div>

                    <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-6 space-y-8">

                        {/* Section 1: About */}
                        <div className="space-y-3">
                            <div className="flex items-center gap-3 mb-2 border-b border-gray-50 pb-2">
                                <div className="w-6 h-6 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs shadow-sm">1</div>
                                <h3 className="text-xs font-black uppercase text-gray-900 tracking-widest">Descripción del Sitio</h3>
                            </div>
                            <div className="pl-9 space-y-2">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">Texto del Footer</label>
                                <textarea
                                    rows={4}
                                    value={settings.footer_text}
                                    onChange={(e) => setSettings({ ...settings, footer_text: e.target.value })}
                                    placeholder="Escribe una breve descripción..."
                                    className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-600 font-medium text-sm resize-none placeholder:text-gray-300"
                                />
                            </div>
                        </div>

                        {/* Section 2: Socials */}
                        <div className="space-y-3">
                            <div className="flex items-center gap-3 mb-2 border-b border-gray-50 pb-2">
                                <div className="w-6 h-6 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center font-bold text-xs shadow-sm">2</div>
                                <h3 className="text-xs font-black uppercase text-gray-900 tracking-widest">Redes Sociales</h3>
                            </div>

                            <div className="pl-9 space-y-4">
                                {/* List */}
                                <div className="space-y-2">
                                    {socialLinks.map((link, idx) => (
                                        <div key={idx} className="flex items-center gap-3 bg-white p-2.5 rounded-xl border-2 border-gray-50 shadow-sm group hover:border-purple-100 transition-colors">
                                            <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-gray-400 group-hover:bg-purple-50 group-hover:text-purple-600 transition-colors">
                                                <i className={link.icon}></i>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[10px] font-black uppercase text-gray-700 tracking-wide">{link.platform}</p>
                                                <p className="text-[10px] text-gray-400 truncate">{link.url}</p>
                                            </div>
                                            <button
                                                onClick={() => removeSocialLink(idx)}
                                                className="w-8 h-8 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center"
                                            >
                                                <i className="fa-solid fa-trash-can text-xs"></i>
                                            </button>
                                        </div>
                                    ))}
                                    {socialLinks.length === 0 && (
                                        <div className="text-center py-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                                            <p className="text-[10px] text-gray-400 font-bold uppercase">Sin redes conectadas</p>
                                        </div>
                                    )}
                                </div>

                                {/* Add New */}
                                <div className="bg-gray-50/50 p-4 rounded-2xl border border-gray-100 space-y-3">
                                    <h4 className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Añadir nueva red</h4>
                                    <ModernSelect
                                        value={newPlatform}
                                        onChange={(e) => setNewPlatform(e.target.value)}
                                        options={PLATFORMS.map(p => ({ value: p.id, label: p.name }))}
                                        className="!py-2.5 !px-3 !text-xs !bg-white !border-gray-200 !rounded-xl"
                                    />
                                    <div className="flex gap-2">
                                        <input
                                            type="url"
                                            value={newUrl}
                                            onChange={(e) => setNewUrl(e.target.value)}
                                            placeholder="https://..."
                                            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-xs bg-white focus:outline-none focus:border-purple-500 transition-colors"
                                        />
                                        <button
                                            type="button"
                                            onClick={addSocialLink}
                                            disabled={!newUrl}
                                            className="bg-gray-900 text-white w-9 h-9 rounded-xl hover:bg-purple-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-gray-200 flex items-center justify-center"
                                        >
                                            <i className="fa-solid fa-plus text-xs"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Section 3: Copyright */}
                        <div className="space-y-3">
                            <div className="flex items-center gap-3 mb-2 border-b border-gray-50 pb-2">
                                <div className="w-6 h-6 rounded-lg bg-orange-50 text-orange-600 flex items-center justify-center font-bold text-xs shadow-sm">3</div>
                                <h3 className="text-xs font-black uppercase text-gray-900 tracking-widest">Copyright</h3>
                            </div>
                            <div className="pl-9 space-y-2">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">Texto Legal</label>
                                <input
                                    type="text"
                                    value={settings.footer_copyright}
                                    onChange={(e) => setSettings({ ...settings, footer_copyright: e.target.value })}
                                    placeholder="© 2026..."
                                    className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-orange-500 transition-all outline-none text-gray-600 font-medium text-sm placeholder:text-gray-300"
                                />
                            </div>
                        </div>

                        {/* Section 4: Menu */}
                        <div className="space-y-3 pb-10">
                            <div className="flex items-center gap-3 mb-2 border-b border-gray-50 pb-2">
                                <div className="w-6 h-6 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-xs shadow-sm">4</div>
                                <h3 className="text-xs font-black uppercase text-gray-900 tracking-widest">Navegación</h3>
                            </div>
                            <div className="pl-9">
                                <div className="bg-white border-2 border-gray-50 p-4 rounded-2xl shadow-sm flex items-center justify-between group hover:border-emerald-100 transition-all">
                                    <div>
                                        <h4 className="font-black text-gray-700 text-xs uppercase tracking-wide">Quick Links</h4>
                                        <p className="text-[10px] text-gray-400 mt-1">
                                            Gestionados en Menús
                                        </p>
                                    </div>
                                    <Link href="/admin/menus" className="bg-gray-50 text-gray-600 border border-gray-200 px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200 transition-all">
                                        Editar
                                    </Link>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>

                {/* DEVICE PREVIEW AREA (Right) */}
                <div className="flex-1 relative overflow-hidden bg-gray-100/50 h-full min-h-0 flex flex-col items-center p-4 md:py-10 md:px-12">
                    {/* Dotted Background Pattern */}
                    <div className="absolute inset-0 opacity-40 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

                    <div className="relative w-full max-w-5xl h-full flex flex-col">
                        <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-3 py-1.5 rounded-xl text-[10px] font-black text-gray-400 uppercase tracking-widest shadow-sm pointer-events-none z-20 border border-gray-100">
                            <i className="fa-solid fa-eye mr-2 text-blue-500"></i>Live Preview
                        </div>

                        {/* Device Container */}
                        <div className="flex-1 shadow-2xl bg-white border-[8px] border-gray-900 rounded-[3rem] overflow-hidden relative z-10 w-full flex flex-col">

                            {/* Notch */}
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-gray-900 rounded-b-2xl z-50 pointer-events-none"></div>

                            {/* Scrollable Content */}
                            <div className="flex-1 overflow-y-auto custom-scrollbar bg-gray-50 flex flex-col" id="preview-theme-scope">
                                {/* Inject Scoped Theme CSS */}
                                <style>{themeCss}</style>

                                {/* Mock Page Content */}
                                <div className="flex-1 p-8 md:p-12 flex flex-col items-center justify-center text-center opacity-50 grayscale hover:grayscale-0 transition-all duration-700">
                                    <div className="w-24 h-24 bg-gray-200 rounded-2xl mb-6"></div>
                                    <div className="h-4 w-64 bg-gray-200 rounded mb-3"></div>
                                    <div className="h-3 w-40 bg-gray-200 rounded"></div>
                                    <div className="mt-12 grid grid-cols-3 gap-6 w-full max-w-2xl">
                                        <div className="h-32 bg-white rounded-2xl shadow-sm"></div>
                                        <div className="h-32 bg-white rounded-2xl shadow-sm"></div>
                                        <div className="h-32 bg-white rounded-2xl shadow-sm"></div>
                                    </div>
                                </div>

                                {/* THE FOOTER Component */}
                                <Footer
                                    previewSettings={settings}
                                    previewMenu={previewMenu}
                                    previewSocials={socialLinks}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
