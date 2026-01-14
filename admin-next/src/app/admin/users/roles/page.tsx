"use client";

import { useEffect, useState } from "react";
import { rolesApi, Role } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";

export default function RolesPage() {
    const { user, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const [roles, setRoles] = useState<Record<string, Role>>({});
    const [availableCaps, setAvailableCaps] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Editing state
    const [editingSlug, setEditingSlug] = useState<string | null>(null);
    const [editName, setEditName] = useState("");
    const [editCaps, setEditCaps] = useState<string[]>([]);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (!authLoading && (!user || !user.capabilities.includes("*"))) {
            router.push("/admin");
            return;
        }

        const fetchData = async () => {
            try {
                const [rolesData, capsData] = await Promise.all([
                    rolesApi.list(),
                    rolesApi.getCapabilities()
                ]);
                setRoles(rolesData);
                setAvailableCaps(capsData);
            } catch (err: any) {
                setError(err.message);
            } finally {
                setIsLoading(false);
            }
        };

        if (user) fetchData();
    }, [user, authLoading, router]);

    const handleEdit = (slug: string, role: Role) => {
        setEditingSlug(slug);
        setEditName(role.name);
        setEditCaps(role.capabilities);
        setSuccess(null);
        setError(null);
    };

    const handleNewRole = () => {
        setEditingSlug("");
        setEditName("New Role");
        setEditCaps(["read"]);
        setSuccess(null);
        setError(null);
    };

    const toggleCap = (cap: string) => {
        setEditCaps(prev =>
            prev.includes(cap) ? prev.filter(c => c !== cap) : [...prev, cap]
        );
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editName) return;

        setIsSaving(true);
        setError(null);
        setSuccess(null);

        const slug = editingSlug === "" ? editName.toLowerCase().replace(/[^a-z0-9]/g, '_') : editingSlug!;

        try {
            await rolesApi.save(slug, { name: editName, capabilities: editCaps });
            const updatedRoles = await rolesApi.list();
            setRoles(updatedRoles);
            setSuccess(`Role "${editName}" saved successfully!`);
            setEditingSlug(null);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (slug: string) => {
        if (!confirm(`Are you sure you want to delete the role "${slug}"?`)) return;

        try {
            await rolesApi.delete(slug);
            const updatedRoles = await rolesApi.list();
            setRoles(updatedRoles);
            setSuccess("Role deleted successfully.");
        } catch (err: any) {
            setError(err.message);
        }
    };

    if (isLoading || authLoading) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
    );

    return (
        <div className="max-w-6xl mx-auto p-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-black text-gray-900 tracking-tight">User Roles & Capabilities</h1>
                    <p className="text-gray-500 mt-1">Manage what each user role is allowed to do across the platform.</p>
                </div>
                <button
                    onClick={handleNewRole}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2"
                >
                    <i className="fa-solid fa-plus text-sm"></i>
                    Add New Role
                </button>
            </div>

            {error && (
                <div className="bg-red-50 border border-red-200 text-red-600 px-6 py-4 rounded-2xl mb-6 flex items-center gap-3">
                    <i className="fa-solid fa-circle-exclamation"></i>
                    {error}
                </div>
            )}

            {success && (
                <div className="bg-green-50 border border-green-200 text-green-600 px-6 py-4 rounded-2xl mb-6 flex items-center gap-3">
                    <i className="fa-solid fa-circle-check"></i>
                    {success}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Roles List */}
                <div className="lg:col-span-1 space-y-4">
                    {Object.entries(roles).map(([slug, role]) => (
                        <div
                            key={slug}
                            onClick={() => handleEdit(slug, role)}
                            className={`p-4 rounded-2xl border transition-all cursor-pointer group ${editingSlug === slug
                                    ? "bg-white border-blue-500 shadow-xl shadow-blue-500/10 ring-1 ring-blue-500"
                                    : "bg-white border-gray-100 hover:border-blue-200 hover:shadow-lg"
                                }`}
                        >
                            <div className="flex justify-between items-start">
                                <div>
                                    <h3 className="font-bold text-gray-900 capitalize">{role.name}</h3>
                                    <p className="text-xs text-gray-400 mt-1 uppercase tracking-widest font-black leading-none">{slug}</p>
                                </div>
                                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleDelete(slug); }}
                                        className="text-gray-400 hover:text-red-500 p-1"
                                        title="Delete Role"
                                    >
                                        <i className="fa-solid fa-trash-can text-sm"></i>
                                    </button>
                                </div>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-1">
                                <span className="text-[10px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full font-bold">
                                    {role.capabilities.length} Caps
                                </span>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Editor */}
                <div className="lg:col-span-2">
                    {editingSlug !== null ? (
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl p-8 sticky top-8">
                            <form onSubmit={handleSave}>
                                <div className="flex justify-between items-center mb-8">
                                    <h2 className="text-xl font-bold text-gray-900">
                                        {editingSlug === "" ? "Create New Role" : `Editing: ${roles[editingSlug]?.name}`}
                                    </h2>
                                    <div className="flex gap-3">
                                        <button
                                            type="button"
                                            onClick={() => setEditingSlug(null)}
                                            className="px-4 py-2 text-gray-500 hover:text-gray-700 font-bold"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={isSaving || !editName}
                                            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-xl font-bold transition-all disabled:opacity-50"
                                        >
                                            {isSaving ? "Saving..." : "Save Changes"}
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-6">
                                    <div>
                                        <label className="block text-sm font-bold text-gray-700 mb-2">Display Name</label>
                                        <input
                                            type="text"
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all outline-none"
                                            placeholder="e.g. Content Moderator"
                                            required
                                        />
                                    </div>

                                    <div>
                                        <div className="flex justify-between items-end mb-4">
                                            <label className="block text-sm font-bold text-gray-700">Capabilities</label>
                                            <div className="flex gap-4">
                                                <button
                                                    type="button"
                                                    onClick={() => setEditCaps(availableCaps)}
                                                    className="text-xs text-blue-600 hover:underline font-bold"
                                                >
                                                    Select All
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setEditCaps(['read'])}
                                                    className="text-xs text-gray-400 hover:underline font-bold"
                                                >
                                                    Deselect All
                                                </button>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[400px] overflow-y-auto p-1 custom-scrollbar">
                                            {availableCaps.map(cap => (
                                                <label
                                                    key={cap}
                                                    className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer group ${editCaps.includes(cap)
                                                            ? "bg-blue-50 border-blue-200 text-blue-700"
                                                            : "bg-gray-50 border-gray-100 text-gray-500 hover:bg-white hover:border-gray-200"
                                                        }`}
                                                >
                                                    <div className={`w-5 h-5 rounded flex items-center justify-center transition-all ${editCaps.includes(cap) ? "bg-blue-600 text-white" : "bg-white border border-gray-300"
                                                        }`}>
                                                        {editCaps.includes(cap) && <i className="fa-solid fa-check text-[10px]"></i>}
                                                    </div>
                                                    <input
                                                        type="checkbox"
                                                        className="hidden"
                                                        checked={editCaps.includes(cap)}
                                                        onChange={() => toggleCap(cap)}
                                                    />
                                                    <span className="text-sm font-medium tracking-tight">
                                                        {cap.replace(/_/g, ' ')}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </form>
                        </div>
                    ) : (
                        <div className="h-full min-h-[400px] bg-gray-50 border-2 border-dashed border-gray-200 rounded-3xl flex flex-col items-center justify-center p-12 text-center text-gray-400">
                            <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center mb-4">
                                <i className="fa-solid fa-shield-halved text-2xl text-gray-200"></i>
                            </div>
                            <h3 className="font-bold text-gray-900 mb-2">Select a Role to Edit</h3>
                            <p className="text-sm max-w-[240px]">Click a role from the list on the left to manage its permissions or create a new one.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
