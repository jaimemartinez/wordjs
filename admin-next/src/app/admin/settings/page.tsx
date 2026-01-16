"use client";

import { useEffect, useState } from "react";
import { settingsApi, MediaItem, postsApi, Post, rolesApi, Role } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import MediaPickerModal from "@/components/MediaPickerModal";
import ModernSelect from "@/components/ModernSelect";

export default function SettingsPage() {
    const { t } = useI18n();
    const [settings, setSettings] = useState({
        blogname: "",
        blogdescription: "",
        admin_email: "",
        posts_per_page: "10",
        site_logo: "",
        site_icon: "",
        homepage_id: "",
        comments_enabled: "1",
        users_can_register: "0",
        default_role: "subscriber",
        comment_registration: "0",
    });
    const [roles, setRoles] = useState<Record<string, Role>>({});
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [activePicker, setActivePicker] = useState<"logo" | "icon" | null>(null);
    const [pages, setPages] = useState<Post[]>([]);

    useEffect(() => {
        loadSettings();
        loadPages();
        loadRoles();
    }, []);

    const loadRoles = async () => {
        try {
            const data = await rolesApi.list();
            setRoles(data);
        } catch (error) {
            console.error("Failed to load roles:", error);
        }
    };

    const loadPages = async () => {
        try {
            const data = await postsApi.list('page');
            setPages(data);
        } catch (error) {
            console.error("Failed to load pages:", error);
        }
    };

    const loadSettings = async () => {
        try {
            const data = await settingsApi.get();
            setSettings({
                blogname: data.blogname || "",
                blogdescription: data.blogdescription || "",
                admin_email: data.admin_email || "",
                posts_per_page: data.posts_per_page || "10",
                site_logo: data.site_logo || "",
                site_icon: data.site_icon || "",
                homepage_id: data.homepage_id || "",
                comments_enabled: data.comments_enabled !== undefined ? String(data.comments_enabled) : "1",
                users_can_register: data.users_can_register !== undefined ? String(data.users_can_register) : "0",
                default_role: data.default_role || "subscriber",
                comment_registration: data.comment_registration !== undefined ? String(data.comment_registration) : "0",
            });
        } catch (error) {
            console.error("Failed to load settings:", error);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setSaved(false);

        try {
            await settingsApi.update(settings);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (error) {
            console.error("Failed to save settings:", error);
            alert(t('settings.save.failed'));
        } finally {
            setSaving(false);
        }
    };

    const handleSelectMedia = (media: MediaItem) => {
        if (activePicker === "logo") {
            setSettings({ ...settings, site_logo: media.guid });
        } else if (activePicker === "icon") {
            setSettings({ ...settings, site_icon: media.guid });
        }
        setActivePicker(null);
    };

    return (
        <div className="p-8 h-full overflow-auto bg-gray-50/50">
            <div className="max-w-4xl mx-auto">
                <div className="flex justify-between items-center mb-10">
                    <div>
                        <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">{t('settings.title')}</h1>
                        <p className="text-gray-500 mt-1">{t('settings.general')}</p>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-8">
                    {/* General Settings Section */}
                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                        <div className="px-8 py-6 border-b border-gray-50 bg-gray-50/30">
                                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                                <i className="fa-solid fa-gear text-blue-500"></i> {t('settings.general')}
                            </h2>
                        </div>
                        <div className="p-8 space-y-8">
                            {/* Logo Config */}
                            <div className="flex flex-col md:flex-row gap-8 items-start md:items-center">
                                <div className="relative group">
                                    {settings.site_logo ? (
                                        <div className="h-32 w-32 bg-white rounded-2xl shadow-inner border-2 border-dashed border-gray-200 flex items-center justify-center p-2 relative overflow-hidden group-hover:border-blue-400 transition-colors">
                                            <img
                                                src={settings.site_logo}
                                                alt="Site Logo"
                                                className="max-h-full max-w-full object-contain"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setSettings({ ...settings, site_logo: "" })}
                                                className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity transform hover:scale-110"
                                            >
                                                <i className="fa-solid fa-xmark text-xs"></i>
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="h-32 w-32 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400 group-hover:border-blue-400 group-hover:bg-blue-50/30 transition-all">
                                            <i className="fa-solid fa-image text-3xl mb-2"></i>
                                            <span className="text-[10px] uppercase font-bold tracking-widest">No Logo</span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-sm font-bold text-gray-900 mb-2">{t('settings.site.logo')}</h3>
                                    <p className="text-sm text-gray-500 mb-4 leading-relaxed">{t('settings.site.logo')}</p>
                                    <button
                                        type="button"
                                        onClick={() => setActivePicker("logo")}
                                        className="bg-white hover:bg-gray-50 text-gray-700 font-bold px-5 py-2.5 rounded-xl border-2 border-gray-100 transition-all flex items-center gap-2 text-sm shadow-sm"
                                    >
                                        <i className="fa-solid fa-cloud-arrow-up text-blue-500"></i>
                                        {settings.site_logo ? t('settings.select.logo') : t('settings.select.logo')}
                                    </button>
                                </div>
                            </div>

                            {/* Favicon Config */}
                            <div className="flex flex-col md:flex-row gap-8 items-start md:items-center pt-8 border-t border-gray-50">
                                <div className="relative group">
                                    {settings.site_icon ? (
                                        <div className="h-20 w-20 bg-white rounded-2xl shadow-inner border-2 border-dashed border-gray-200 flex items-center justify-center p-2 relative overflow-hidden group-hover:border-purple-400 transition-colors">
                                            <img
                                                src={settings.site_icon}
                                                alt="Site Icon"
                                                className="max-h-full max-w-full object-contain"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setSettings({ ...settings, site_icon: "" })}
                                                className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity transform hover:scale-110"
                                            >
                                                <i className="fa-solid fa-xmark text-[10px]"></i>
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="h-20 w-20 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400 group-hover:border-purple-400 group-hover:bg-purple-50/30 transition-all">
                                            <i className="fa-solid fa-gem text-xl mb-1"></i>
                                            <span className="text-[8px] uppercase font-bold tracking-widest text-center">No Icon</span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-sm font-bold text-gray-900 mb-2">{t('settings.site.icon')}</h3>
                                    <p className="text-sm text-gray-500 mb-4 leading-relaxed">{t('settings.site.icon')}</p>
                                    <button
                                        type="button"
                                        onClick={() => setActivePicker("icon")}
                                        className="bg-white hover:bg-gray-50 text-gray-700 font-bold px-5 py-2.5 rounded-xl border-2 border-gray-100 transition-all flex items-center gap-2 text-sm shadow-sm"
                                    >
                                        <i className="fa-solid fa-wand-magic-sparkles text-purple-500"></i>
                                        {settings.site_icon ? t('settings.select.icon') : t('settings.select.icon')}
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-gray-700 flex items-center gap-2">
                                        Site Title
                                    </label>
                                    <div className="relative group">
                                        <i className="fa-solid fa-signature absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors"></i>
                                        <input
                                            type="text"
                                            value={settings.blogname}
                                            onChange={(e) => setSettings({ ...settings, blogname: e.target.value })}
                                            className="w-full pl-12 pr-4 py-3.5 bg-gray-50/50 border border-gray-200 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none"
                                            placeholder="Your Site Name"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-gray-700 flex items-center gap-2">
                                        Tagline
                                    </label>
                                    <div className="relative group">
                                        <i className="fa-solid fa-quote-left absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors"></i>
                                        <input
                                            type="text"
                                            value={settings.blogdescription}
                                            onChange={(e) => setSettings({ ...settings, blogdescription: e.target.value })}
                                            className="w-full pl-12 pr-4 py-3.5 bg-gray-50/50 border border-gray-200 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none"
                                            placeholder="A brief catchphrase"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2 md:col-span-2">
                                    <label className="text-sm font-bold text-gray-700 flex items-center gap-2">
                                        Admin Email
                                    </label>
                                    <div className="relative group">
                                        <i className="fa-solid fa-envelope absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors"></i>
                                        <input
                                            type="email"
                                            value={settings.admin_email}
                                            onChange={(e) => setSettings({ ...settings, admin_email: e.target.value })}
                                            className="w-full pl-12 pr-4 py-3.5 bg-gray-50/50 border border-gray-200 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none"
                                            placeholder="admin@example.com"
                                        />
                                    </div>
                                    <p className="text-xs text-gray-400 mt-1">This address is used for admin purposes. If you change this we will send you an email at your new address to confirm it. The new address will not become active until confirmed.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Content Settings Section */}
                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                        <div className="px-8 py-6 border-b border-gray-50 bg-gray-50/30">
                            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                                <i className="fa-solid fa-book-open text-purple-500"></i> Reading & Discussion
                            </h2>
                        </div>
                        <div className="p-8 space-y-8">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                <div className="space-y-2">
                                    <ModernSelect
                                        label="Homepage Display"
                                        value={settings.homepage_id}
                                        onChange={(e) => setSettings({ ...settings, homepage_id: e.target.value })}
                                        options={[
                                            { value: "", label: "Default (Latest Posts)" },
                                            ...pages.map((page) => ({ value: page.id, label: page.title }))
                                        ]}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-gray-700">Posts per Page</label>
                                    <input
                                        type="number"
                                        value={settings.posts_per_page}
                                        onChange={(e) => setSettings({ ...settings, posts_per_page: e.target.value })}
                                        className="w-full px-4 py-3.5 bg-gray-50/50 border border-gray-200 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none"
                                    />
                                </div>
                            </div>

                            <div className="p-5 bg-blue-50/50 rounded-2xl border border-blue-100 space-y-4 group hover:bg-blue-100/50 transition-colors">
                                <div className="flex items-center justify-between gap-6">
                                    <div className="flex gap-4 items-center">
                                        <div className="bg-white p-3 rounded-xl shadow-sm border border-blue-200 text-blue-600">
                                            <i className="fa-solid fa-user-plus text-xl"></i>
                                        </div>
                                        <div>
                                            <h4 className="text-sm font-bold text-gray-900">Membership</h4>
                                            <p className="text-xs text-gray-500 mt-0.5">Anyone can register as a new user on the site.</p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setSettings({ ...settings, users_can_register: settings.users_can_register === "1" ? "0" : "1" })}
                                        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${settings.users_can_register === "1" ? 'bg-blue-500' : 'bg-gray-200'}`}
                                    >
                                        <span
                                            className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${settings.users_can_register === "1" ? 'translate-x-6' : 'translate-x-1'}`}
                                        />
                                    </button>
                                </div>

                                {settings.users_can_register === "1" && (
                                    <div className="pl-16 pt-2 animate-in fade-in slide-in-from-top-2 duration-300">
                                        <ModernSelect
                                            label="New User Default Role"
                                            value={settings.default_role}
                                            onChange={(e) => setSettings({ ...settings, default_role: e.target.value })}
                                            options={Object.entries(roles).map(([slug, role]) => ({
                                                value: slug,
                                                label: role.name
                                            }))}
                                        />
                                    </div>
                                )}
                            </div>

                            <div className="p-5 bg-amber-50 rounded-2xl border border-amber-100 flex items-center justify-between gap-6 group hover:bg-amber-100/50 transition-colors">
                                <div className="flex gap-4 items-center">
                                    <div className="bg-white p-3 rounded-xl shadow-sm border border-amber-200 text-amber-600">
                                        <i className="fa-solid fa-comments text-xl"></i>
                                    </div>
                                    <div>
                                        <h4 className="text-sm font-bold text-gray-900">Enable Comments Globally</h4>
                                        <p className="text-xs text-gray-500 mt-0.5">Control if visitors can leave comments on your content.</p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setSettings({ ...settings, comments_enabled: settings.comments_enabled === "1" ? "0" : "1" })}
                                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 ${settings.comments_enabled === "1" ? 'bg-amber-500' : 'bg-gray-200'}`}
                                >
                                    <span
                                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${settings.comments_enabled === "1" ? 'translate-x-6' : 'translate-x-1'}`}
                                    />
                                </button>
                            </div>

                            <div className="p-5 bg-emerald-50/50 rounded-2xl border border-emerald-100 flex items-center justify-between gap-6 group hover:bg-emerald-100/50 transition-colors">
                                <div className="flex gap-4 items-center">
                                    <div className="bg-white p-3 rounded-xl shadow-sm border border-emerald-200 text-emerald-600">
                                        <i className="fa-solid fa-user-lock text-xl"></i>
                                    </div>
                                    <div>
                                        <h4 className="text-sm font-bold text-gray-900">Registered Comments</h4>
                                        <p className="text-xs text-gray-500 mt-0.5">Users must be registered and logged in to comment.</p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setSettings({ ...settings, comment_registration: settings.comment_registration === "1" ? "0" : "1" })}
                                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${settings.comment_registration === "1" ? 'bg-emerald-500' : 'bg-gray-200'}`}
                                >
                                    <span
                                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${settings.comment_registration === "1" ? 'translate-x-6' : 'translate-x-1'}`}
                                    />
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-end gap-4 pt-4 pb-12">
                        {saved && (
                            <span className="text-sm font-bold text-emerald-600 flex items-center gap-2 animate-bounce">
                                <i className="fa-solid fa-circle-check"></i> Changes saved successfully!
                            </span>
                        )}
                        <button
                            type="submit"
                            disabled={saving}
                            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-10 py-4 rounded-2xl font-bold transition-all flex items-center gap-3 shadow-lg shadow-blue-200 hover:shadow-blue-300 transform hover:-translate-y-0.5 active:translate-y-0 active:shadow-md"
                        >
                            {saving ? (
                                <i className="fa-solid fa-spinner fa-spin"></i>
                            ) : (
                                <i className="fa-solid fa-floppy-disk"></i>
                            )}
                            {saving ? "Updating..." : "Save Settings"}
                        </button>
                    </div>
                </form>
            </div>

            <MediaPickerModal
                isOpen={activePicker !== null}
                onClose={() => setActivePicker(null)}
                onSelect={handleSelectMedia}
            />
        </div>
    );
}
