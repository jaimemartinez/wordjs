"use client";

import { useEffect, useState } from "react";
import { PageHeader, Card, Button } from "@/components/ui";
import { backupsApi, BackupFile } from "@/lib/api";
import { format } from "date-fns";

export default function BackupsPage() {
    const [backups, setBackups] = useState<BackupFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const fetchBackups = async () => {
        try {
            const data = await backupsApi.list();
            setBackups(data);
            setError(null);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchBackups();
    }, []);

    const handleCreate = async () => {
        setCreating(true);
        try {
            await backupsApi.create();
            await fetchBackups();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (filename: string) => {
        if (!confirm("Are you sure you want to delete this backup?")) return;
        try {
            await backupsApi.delete(filename);
            setBackups(backups.filter(b => b.filename !== filename));
        } catch (err: any) {
            alert(err.message);
        }
    };

    const handleRestore = async () => {
        if (!restoring) return;
        try {
            setLoading(true);
            await backupsApi.restore(restoring);
            alert("System restored successfully!");
            setRestoring(null);
            // Optionally reload or redirect
            window.location.reload();
        } catch (err: any) {
            alert("Restore failed: " + err.message);
            setLoading(false);
        }
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <div className="p-8 md:p-12 h-full bg-gray-50/50 overflow-auto">
            <PageHeader
                title="System Backups"
                subtitle="Manage and restore automated backups"
                icon="fa-box-archive"
            />

            {error && (
                <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-xl border border-red-100 flex items-center gap-3">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                    {error}
                </div>
            )}

            <div className="flex justify-end mb-6">
                <Button
                    onClick={handleCreate}
                    disabled={creating}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                    {creating ? (
                        <><i className="fa-solid fa-spinner fa-spin mr-2"></i> Creating...</>
                    ) : (
                        <><i className="fa-solid fa-plus mr-2"></i> Create Backup</>
                    )}
                </Button>
            </div>

            <Card className="rounded-[40px] border-none shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-gray-100/50 text-left">
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold">Filename</th>
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold">Date</th>
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold">Size</th>
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {loading ? (
                                <tr>
                                    <td colSpan={4} className="p-12 text-center text-gray-400">
                                        <i className="fa-solid fa-spinner fa-spin text-2xl mb-3"></i>
                                        <p>Loading backups...</p>
                                    </td>
                                </tr>
                            ) : backups.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="p-12 text-center text-gray-400">
                                        <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                            <i className="fa-solid fa-box-open text-2xl text-gray-300"></i>
                                        </div>
                                        <p className="font-medium">No backups found</p>
                                        <p className="text-sm mt-1">Create your first backup to ensure data safety.</p>
                                    </td>
                                </tr>
                            ) : (
                                backups.map((backup) => (
                                    <tr key={backup.filename} className="hover:bg-gray-50/50 transition-colors group">
                                        <td className="p-6 font-medium text-gray-700">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-500 flex items-center justify-center">
                                                    <i className="fa-solid fa-file-zipper"></i>
                                                </div>
                                                {backup.filename}
                                            </div>
                                        </td>
                                        <td className="p-6 text-gray-500 text-sm">
                                            {format(new Date(backup.date), "PPP p")}
                                        </td>
                                        <td className="p-6 text-gray-500 text-sm font-mono">
                                            {formatSize(backup.size)}
                                        </td>
                                        <td className="p-6 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() => backupsApi.download(backup.filename)}
                                                    className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg transition-colors"
                                                    title="Download"
                                                >
                                                    <i className="fa-solid fa-download"></i>
                                                </button>
                                                <button
                                                    onClick={() => setRestoring(backup.filename)}
                                                    className="p-2 hover:bg-orange-50 text-orange-500 rounded-lg transition-colors"
                                                    title="Restore"
                                                >
                                                    <i className="fa-solid fa-clock-rotate-left"></i>
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(backup.filename)}
                                                    className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors"
                                                    title="Delete"
                                                >
                                                    <i className="fa-solid fa-trash"></i>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>

            {/* Restore Modal */}
            {restoring && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-white rounded-[30px] p-8 max-w-md w-full shadow-2xl space-y-6">
                        <div className="w-16 h-16 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center mx-auto">
                            <i className="fa-solid fa-triangle-exclamation text-3xl"></i>
                        </div>
                        <div className="text-center">
                            <h3 className="text-xl font-bold text-gray-900">Confirm System Restore</h3>
                            <p className="text-gray-500 mt-2">
                                You are about to restore <strong>{restoring}</strong>.
                                <br />
                                <span className="text-red-500 font-bold block mt-2">
                                    This will overwrite all current data and files.
                                </span>
                            </p>
                        </div>
                        <div className="flex gap-3">
                            <Button
                                variant="ghost"
                                className="flex-1"
                                onClick={() => setRestoring(null)}
                            >
                                Cancel
                            </Button>
                            <Button
                                className="flex-1 bg-orange-500 hover:bg-orange-600 text-white border-none"
                                onClick={handleRestore}
                            >
                                <i className="fa-solid fa-radiation mr-2"></i>
                                Yes, Restore
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
