"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { usersApi } from "@/lib/api";
import ModernSelect from "@/components/ModernSelect";
import { PluginHook, pluginHooks } from "@/lib/plugin-hooks";

export default function UserEditorPage() {
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
    });
    const [saving, setSaving] = useState(false);
    const [, setHookTick] = useState(0);

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
            alert("Failed to save user");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="p-6 h-full overflow-auto">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800">{isNew ? "New User" : "Edit User"}</h1>
                <button onClick={() => router.back()} className="text-gray-600 hover:text-gray-800">
                    <i className="fa-solid fa-xmark text-xl"></i>
                </button>
            </div>

            <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 max-w-2xl">
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                        <input
                            type="text"
                            value={formData.username}
                            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                            disabled={!isNew}
                            className="w-full px-4 py-2 border rounded-lg bg-gray-50 focus:ring-2 focus:ring-blue-500"
                            required
                        />
                    </div>
                    <PluginHook name="user_form_before_email" data={{ formData, setFormData, isNew }} />
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                        <input
                            type="email"
                            value={formData.email}
                            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                            {...pluginHooks.applyFilters('user_form_email_input_props', {
                                className: "w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500",
                                required: true,
                                readOnly: false
                            }, { formData, isNew })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
                        <input
                            type="text"
                            value={formData.displayName}
                            onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
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
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            {isNew ? "Password" : "New Password (leave blank to keep current)"}
                        </label>
                        <input
                            type="password"
                            value={formData.password}
                            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                            required={isNew}
                        />
                    </div>
                </div>

                <div className="mt-6 flex justify-end gap-3">
                    <button type="button" onClick={() => router.back()} className="px-4 py-2 border rounded-lg hover:bg-gray-50">Cancel</button>
                    <button
                        type="submit"
                        disabled={saving}
                        className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
                    >
                        {saving ? "Saving..." : "Save User"}
                    </button>
                </div>
            </form>
        </div>
    );
}
