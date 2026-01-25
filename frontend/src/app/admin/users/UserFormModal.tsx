"use client";

import { useState, useEffect } from "react";
import { usersApi, User } from "@/lib/api";
import ModernSelect from "@/components/ModernSelect";
import { PluginHook, pluginHooks } from "@/lib/plugin-hooks";
import { useModal } from "@/contexts/ModalContext";

interface UserFormModalProps {
    user: User | "new" | null;
    onClose: () => void;
    onSuccess: () => void;
}

export default function UserFormModal({ user, onClose, onSuccess }: UserFormModalProps) {
    const isNew = user === "new";
    const userId = isNew ? null : (user as User).id;

    const [formData, setFormData] = useState({
        username: "",
        email: "",
        displayName: "",
        role: "subscriber",
        password: "",
    });
    const [saving, setSaving] = useState(false);
    const [, setHookTick] = useState(0);

    const { alert } = useModal();

    useEffect(() => {
        if (user && user !== "new") {
            setFormData({
                username: user.username,
                email: user.email,
                displayName: user.displayName || "",
                role: user.role,
                password: "", // Don't load password
            });
        }
        // Listen for plugin hook changes
        return pluginHooks.subscribe(() => setHookTick(t => t + 1));
    }, [user]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);

        try {
            if (userId && user !== "new") {
                await usersApi.update(userId, formData);
            } else {
                await usersApi.create(formData);
            }
            onSuccess();
            onClose();
        } catch (error) {
            console.error("Failed to save user:", error);
            await alert("Failed to save user");
        } finally {
            setSaving(false);
        }
    };

    if (!user) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 border border-white/20">
                {/* Header */}
                <div className="p-8 pb-0 flex justify-between items-start">
                    <div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter mb-2">
                            {isNew ? "New User" : "Edit User"}
                        </h2>
                        <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                            {isNew ? "Create a new user account" : `Editing @${(user as User).username}`}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-10 h-10 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-600 flex items-center justify-center transition-colors"
                    >
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>

                <div className="p-8 overflow-y-auto">
                    <form id="user-form" onSubmit={handleSubmit} className="space-y-6">
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Username</label>
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
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Email</label>
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
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Display Name</label>
                            <input
                                type="text"
                                value={formData.displayName}
                                onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                                className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                            />
                        </div>
                        <ModernSelect
                            label="Role"
                            value={formData.role}
                            onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                            options={[
                                { value: "subscriber", label: "Subscriber" },
                                { value: "author", label: "Author" },
                                { value: "editor", label: "Editor" },
                                { value: "administrator", label: "Administrator" },
                            ]}
                        />
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                                {isNew ? "Password" : "New Password (leave blank to keep)"}
                            </label>
                            <input
                                type="password"
                                value={formData.password}
                                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                                required={isNew}
                            />
                        </div>
                    </form>
                </div>

                <div className="p-6 border-t border-gray-100 bg-gray-50/30 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-6 py-3 border-2 border-gray-100 rounded-2xl hover:bg-gray-50 text-gray-600 font-bold text-xs uppercase tracking-widest transition-all"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        form="user-form"
                        disabled={saving}
                        className="px-8 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transform hover:-translate-y-1 transition-all disabled:opacity-50"
                    >
                        {saving ? "Saving..." : "Save User"}
                    </button>
                </div>
            </div>
        </div>
    );
}
