"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { usersApi } from "@/lib/api";
import ModernSelect from "@/components/ModernSelect";
import { PluginHook, pluginHooks } from "@/lib/plugin-hooks";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";

export default function UserEditorPage() {
    const { t } = useI18n();
    const router = useRouter();
    const params = useParams();
    const isNew = params.id === "new";
    const userId = isNew ? null : Number(params.id);

    const [formData, setFormData] = useState({
        username: "",
        email: "",
        displayName: "",
        role: "subscriber",
        password: "",
        personalEmail: "",
    });
    const [saving, setSaving] = useState(false);
    const [, setHookTick] = useState(0);

    const { alert } = useModal();

    useEffect(() => {
        if (userId) loadUser();
        // Listen for plugin hook changes (e.g. toggle auto-email)
        return pluginHooks.subscribe(() => setHookTick(t => t + 1));
    }, [userId]);

    const loadUser = async () => {
        try {
            const user = await usersApi.get(userId!);
            setFormData({
                username: user.username,
                email: user.email,
                displayName: user.displayName,
                role: user.role,
                password: "", // Don't load password
                personalEmail: user.personalEmail || "",
            });
        } catch (error) {
            console.error("Failed to load user:", error);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);

        try {
            if (userId) {
                // Update
                // Note: API might require password for updates based on implementation?
                // Usually update endpoint allows partial.
                // Our usersApi.create uses POST /users.
                // We need to check if we have update method in api.ts for users.
                // Checking api.ts... usersApi has list, get, create, delete. NO UPDATE!
                // I need to add update to usersApi first!
                // For now assuming it exists or I will add it.
                // Let's assume I will add usersApi.update right after this.
                await usersApi.update(userId, formData);
            } else {
                // Create
                await usersApi.create(formData);
            }
            router.push("/admin/users");
        } catch (error) {
            console.error("Failed to save user:", error);
            await alert(t('user.edit.saveError'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 animate-in fade-in duration-500">
            {/* Premium Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12 flex-shrink-0">
                <div>
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 text-gray-400 hover:text-gray-600 transition-colors mb-4 group"
                    >
                        <i className="fa-solid fa-arrow-left group-hover:-translate-x-1 transition-transform"></i>
                        <span className="text-sm font-medium">{t('user.edit.back')}</span>
                    </button>
                    <h1 className="text-4xl md:text-5xl font-black text-gray-900 italic tracking-tighter">
                        {isNew ? t('user.edit.titleNew') : t('user.edit.titleEdit')}
                    </h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        {isNew ? t('user.edit.subtitleNew') : t('user.edit.subtitleEdit')}
                    </p>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 p-8 max-w-2xl">
                <div className="space-y-6">
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t('user.edit.username')}</label>
                        <input
                            type="text"
                            value={formData.username}
                            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                            disabled={!isNew}
                            className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium disabled:opacity-50"
                            required
                        />
                    </div>
                    <PluginHook name="user_form_before_email" data={{ formData, setFormData, isNew }} />
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t('user.edit.email')}</label>
                        <input
                            type="email"
                            value={formData.email}
                            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                            {...pluginHooks.applyFilters('user_form_email_input_props', {
                                className: "w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium",
                                required: true,
                                readOnly: false
                            }, { formData, isNew })}
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t('user.edit.personalEmail') || 'Personal / Recovery Email'}</label>
                        <input
                            type="email"
                            value={formData.personalEmail}
                            onChange={(e) => setFormData({ ...formData, personalEmail: e.target.value })}
                            placeholder="name@gmail.com"
                            className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">{t('user.edit.personalEmail.help') || 'External address for password recovery & notifications — independent of the professional mailbox.'}</p>
                    </div>
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t('user.edit.displayName')}</label>
                        <input
                            type="text"
                            value={formData.displayName}
                            onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                            className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                        />
                    </div>
                    <ModernSelect
                        label={t('user.edit.role')}
                        value={formData.role}
                        onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                        options={[
                            { value: "subscriber", label: t('user.edit.roleSubscriber') },
                            { value: "author", label: t('user.edit.roleAuthor') },
                            { value: "editor", label: t('user.edit.roleEditor') },
                            { value: "administrator", label: t('user.edit.roleAdministrator') },
                        ]}
                    />
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                            {isNew ? t('user.edit.password') : t('user.edit.newPassword')}
                        </label>
                        <input
                            type="password"
                            value={formData.password}
                            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                            className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                            required={isNew}
                        />
                    </div>
                </div>

                <div className="mt-8 flex justify-end gap-4">
                    <button
                        type="button"
                        onClick={() => router.back()}
                        className="px-6 py-3 border-2 border-gray-100 rounded-2xl hover:bg-gray-50 text-gray-600 font-bold text-xs uppercase tracking-widest transition-all"
                    >
                        {t('user.edit.cancel')}
                    </button>
                    <button
                        type="submit"
                        disabled={saving}
                        className="px-8 py-4 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transform hover:-translate-y-1 transition-all disabled:opacity-50"
                    >
                        {saving ? t('user.edit.saving') : t('user.edit.save')}
                    </button>
                </div>
            </form>
        </div>
    );
}

