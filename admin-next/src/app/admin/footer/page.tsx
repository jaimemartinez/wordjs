"use client";

import { useEffect, useState } from "react";
import { settingsApi, menusApi } from "@/lib/api";
import Link from "next/link";
import { useToast } from "@/contexts/ToastContext";
import ModernSelect from "@/components/ModernSelect";

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

    useEffect(() => {
        loadSettings();
    }, []);

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
        <div className="h-full overflow-hidden flex flex-col md:flex-row bg-gray-50">
            {/* LEFT: EDITOR */}
            <div className="w-full md:w-1/2 lg:w-[45%] h-full flex flex-col border-r border-gray-200 bg-white">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white sticky top-0 z-10">
                    <h1 className="text-2xl font-bold font-oswald text-gray-800 flex items-center gap-3">
                        <span className="bg-brand-blue/10 text-brand-blue w-10 h-10 rounded-lg flex items-center justify-center text-xl">
                            <i className="fa-solid fa-shoe-prints"></i>
                        </span>
                        Editar Footer
                    </h1>
                    <button
                        onClick={(e) => handleSubmit(e as any)}
                        disabled={saving}
                        className="bg-brand-blue hover:bg-brand-cyan text-white px-6 py-2 rounded-xl shadow-lg shadow-brand-blue/20 transition-all font-medium flex items-center gap-2 disabled:opacity-70"
                    >
                        {saving ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-floppy-disk"></i>}
                        {saving ? "Guardando..." : "Guardar"}
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">

                    {/* About Text */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-8 h-8 rounded-full bg-blue-50 text-brand-blue flex items-center justify-center font-bold font-oswald">1</span>
                            <h3 className="font-bold text-gray-800">Descripción del Sitio</h3>
                        </div>
                        <div className="pl-10">
                            <p className="text-sm text-gray-500 mb-2">Aparece en la primera columna del footer.</p>
                            <textarea
                                rows={4}
                                value={settings.footer_text}
                                onChange={(e) => setSettings({ ...settings, footer_text: e.target.value })}
                                placeholder="Escribe una breve descripción de tu sitio..."
                                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-brand-cyan/50 focus:border-brand-cyan transition-all text-sm"
                            />
                        </div>
                    </div>

                    {/* Social Links */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-8 h-8 rounded-full bg-blue-50 text-brand-blue flex items-center justify-center font-bold font-oswald">2</span>
                            <h3 className="font-bold text-gray-800">Redes Sociales</h3>
                        </div>
                        <div className="pl-10 space-y-4">
                            {/* List */}
                            {socialLinks.length > 0 && (
                                <div className="space-y-2">
                                    {socialLinks.map((link, idx) => (
                                        <div key={idx} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-gray-200 shadow-sm group">
                                            <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center text-gray-600 group-hover:bg-brand-blue/10 group-hover:text-brand-blue transition-colors">
                                                <i className={link.icon}></i>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-bold text-gray-800 capitalize">{link.platform}</p>
                                                <p className="text-xs text-gray-400 truncate">{link.url}</p>
                                            </div>
                                            <button
                                                onClick={() => removeSocialLink(idx)}
                                                className="w-8 h-8 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex items-center justify-center"
                                            >
                                                <i className="fa-solid fa-trash-can"></i>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Add New */}
                            <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                                <h4 className="text-xs font-bold text-gray-400 uppercase mb-3">Añadir nueva red</h4>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <ModernSelect
                                        containerClassName="relative"
                                        value={newPlatform}
                                        onChange={(e) => setNewPlatform(e.target.value)}
                                        options={PLATFORMS.map(p => ({ value: p.id, label: p.name }))}
                                        className="!py-2 !px-3" // Small adjustment for the builder row
                                    />
                                    <div className="md:col-span-2 flex gap-2">
                                        <input
                                            type="url"
                                            value={newUrl}
                                            onChange={(e) => setNewUrl(e.target.value)}
                                            placeholder="https://"
                                            className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-cyan/20 focus:outline-none"
                                        />
                                        <button
                                            type="button"
                                            onClick={addSocialLink}
                                            disabled={!newUrl}
                                            className="bg-gray-900 text-white px-3 py-2 rounded-lg hover:bg-black transition-colors disabled:opacity-50"
                                        >
                                            <i className="fa-solid fa-plus"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Copyright */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-8 h-8 rounded-full bg-blue-50 text-brand-blue flex items-center justify-center font-bold font-oswald">3</span>
                            <h3 className="font-bold text-gray-800">Copyright</h3>
                        </div>
                        <div className="pl-10">
                            <input
                                type="text"
                                value={settings.footer_copyright}
                                onChange={(e) => setSettings({ ...settings, footer_copyright: e.target.value })}
                                placeholder="© 2026 Mi Sitio Web. Todos los derechos reservados."
                                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-brand-cyan/50 focus:border-brand-cyan transition-all text-sm"
                            />
                        </div>
                    </div>

                    {/* Menu Actions */}
                    <div className="space-y-4 pb-10">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-8 h-8 rounded-full bg-blue-50 text-brand-blue flex items-center justify-center font-bold font-oswald">4</span>
                            <h3 className="font-bold text-gray-800">Menú del Footer</h3>
                        </div>
                        <div className="pl-10">
                            <div className="bg-orange-50 border border-orange-100 p-4 rounded-xl flex items-center justify-between">
                                <div>
                                    <h4 className="font-bold text-orange-900 text-sm">Gestionar Enlaces</h4>
                                    <p className="text-xs text-orange-700 mt-1">
                                        Los enlaces "Quick Links" se administran desde la sección de Menús.
                                    </p>
                                </div>
                                <Link href="/admin/menus" className="bg-white text-orange-600 border border-orange-200 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wide hover:bg-orange-50 transition-colors">
                                    Ir a Menús
                                </Link>
                            </div>
                        </div>
                    </div>

                </div>
            </div>

            {/* RIGHT: PREVIEW */}
            <div className="hidden md:flex flex-1 bg-gray-200/50 flex-col overflow-hidden relative">
                <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-3 py-1 rounded-full text-xs font-bold text-gray-500 uppercase tracking-widest shadow-sm pointer-events-none z-10">
                    Live Preview
                </div>

                <div className="flex-1 overflow-y-auto p-8 flex items-end justify-center">
                    <div className="w-full max-w-4xl bg-white shadow-2xl rounded-2xl overflow-hidden border border-gray-200 transform scale-90 origin-bottom">
                        {/* Mock Page Content Above Footer */}
                        <div className="h-32 bg-gray-50 border-b border-gray-100 p-8">
                            <div className="h-4 w-32 bg-gray-200 rounded mb-4"></div>
                            <div className="space-y-2">
                                <div className="h-2 w-full bg-gray-100 rounded"></div>
                                <div className="h-2 w-3/4 bg-gray-100 rounded"></div>
                            </div>
                        </div>

                        {/* THE FOOTER PREVIEW */}
                        <footer className="bg-gray-900 text-white py-12">
                            <div className="px-8">
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
                                    {/* Brand Column */}
                                    <div className="col-span-1 md:col-span-2">
                                        <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                                            {settings.site_logo && <img src={settings.site_logo} alt="Logo" className="h-6 w-auto" />}
                                            {settings.blogname}
                                        </h3>
                                        <div className="text-gray-400 text-sm max-w-sm whitespace-pre-line leading-relaxed">
                                            {settings.footer_text || "Tus visitantes verán aquí la descripción de tu sitio."}
                                        </div>
                                    </div>

                                    {/* Links Column (Real Preview) */}
                                    <div>
                                        <h4 className="font-bold mb-4 text-sm uppercase tracking-wide text-gray-500">Quick Links</h4>
                                        {previewMenu && previewMenu.length > 0 ? (
                                            <ul className="space-y-2 text-gray-400 text-sm">
                                                {previewMenu.map((item: any) => (
                                                    <li key={item.id} className="hover:text-white transition-colors cursor-pointer block truncate">
                                                        {item.title}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <ul className="space-y-2 text-gray-400 text-sm">
                                                <li className="hover:text-white transition-colors cursor-pointer">Inicio</li>
                                                <li className="hover:text-white transition-colors cursor-pointer">Blog</li>
                                                <li className="hover:text-white transition-colors cursor-pointer">Contacto</li>
                                                <li className="opacity-50 text-xs italic mt-2">(Ejemplo de menú)</li>
                                                <li className="text-yellow-600 text-xs mt-2 bg-yellow-50 p-1 rounded">
                                                    <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                                                    No has asignado un menú al footer.
                                                </li>
                                            </ul>
                                        )}
                                    </div>

                                    {/* Socials Column */}
                                    <div>
                                        <h4 className="font-bold mb-4 text-sm uppercase tracking-wide text-gray-500">Conectar</h4>
                                        <div className="flex gap-3 flex-wrap">
                                            {socialLinks.length === 0 ? (
                                                <p className="text-xs text-gray-600 italic">No hay redes</p>
                                            ) : (
                                                socialLinks.map((link, idx) => (
                                                    <div key={idx} className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center hover:bg-brand-blue transition-colors text-sm">
                                                        <i className={link.icon}></i>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Copyright */}
                                <div className="border-t border-gray-800 pt-8 text-center text-gray-500 text-xs">
                                    {settings.footer_copyright || "© 2026 Todos los derechos reservados."}
                                </div>
                            </div>
                        </footer>
                    </div>
                </div>
            </div>
        </div>
    );
}
