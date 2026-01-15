"use client";
import React, { useEffect, useState } from "react";

export default function DbMigrationPage() {
    const [status, setStatus] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Modal State
    const [modal, setModal] = useState<{
        isOpen: boolean;
        target: string | null;
    }>({ isOpen: false, target: null });

    useEffect(() => {
        fetchStatus();
    }, []);

    const fetchStatus = async () => {
        const token = localStorage.getItem("wordjs_token");
        try {
            const res = await fetch('/api/v1/db-migration/status', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            setStatus(data);
        } catch (e) {
            console.error(e);
        }
    };

    const confirmMigration = (target: string) => {
        setModal({ isOpen: true, target });
    };

    const runMigration = async () => {
        const target = modal.target;
        if (!target) return;

        setModal({ isOpen: false, target: null });
        setLoading(true);
        setError(null);
        setResult(null);
        const token = localStorage.getItem("wordjs_token");

        try {
            const res = await fetch('/api/v1/db-migration/migrate', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ targetDriver: target })
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Migration failed');

            setResult(data.message);
            fetchStatus();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    if (!status) return <div className="p-8">Loading Status...</div>;

    return (
        <div className="p-8 max-w-4xl relative">
            <h1 className="text-3xl font-bold mb-2">Database Migration</h1>
            <p className="text-gray-600 mb-8">Move your data between storage engines without data loss.</p>

            <div className="grid gap-6">
                {/* Current Status Card */}
                <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                    <h2 className="text-lg font-semibold mb-4">Current Configuration</h2>
                    <div className="flex items-center gap-4">
                        <div className="text-sm font-medium text-gray-500">Active Driver</div>
                        <div className="px-3 py-1 bg-green-100 text-green-700 rounded-full font-mono text-sm">
                            {status.currentDriver}
                        </div>
                    </div>
                </div>

                {/* Migration Options */}
                <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                    <h2 className="text-lg font-semibold mb-4">Available Migrations</h2>

                    <div className="flex flex-col gap-4">
                        {status.currentDriver === 'sqlite-legacy' && (
                            <div className="flex items-center justify-between p-4 bg-blue-50 border border-blue-100 rounded-lg">
                                <div>
                                    <h3 className="font-bold text-blue-900">Native SQLite (Recommended)</h3>
                                    <p className="text-sm text-blue-700">10x faster writes using WAL mode. Removes file-locking.</p>
                                    <p className="text-xs text-blue-600 mt-1">Driver will be <strong>installed automatically</strong> (may take 20s).</p>
                                </div>
                                <button
                                    onClick={() => confirmMigration('sqlite-native')}
                                    disabled={loading}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                                >
                                    {loading ? 'Processing...' : 'Migrate to Native'}
                                </button>
                            </div>
                        )}

                        {status.currentDriver === 'sqlite-native' && (
                            <div className="flex items-center justify-between p-4 bg-gray-50 border border-gray-200 rounded-lg">
                                <div>
                                    <h3 className="font-bold text-gray-700">Legacy SQLite (sql.js)</h3>
                                    <p className="text-sm text-gray-600">Pure JS implementation. Slower but works everywhere without compilation.</p>
                                </div>
                                <button
                                    onClick={() => confirmMigration('sqlite-legacy')}
                                    disabled={loading}
                                    className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                                >
                                    {loading ? 'Processing...' : 'Downgrade to Legacy'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Logs / Results */}
                {result && (
                    <div className="p-4 bg-green-50 text-green-800 rounded-lg border border-green-200 animate-in fade-in">
                        <i className="fa-solid fa-check-circle mr-2"></i>
                        {result}
                    </div>
                )}
                {error && (
                    <div className="p-4 bg-red-50 text-red-800 rounded-lg border border-red-200 animate-in fade-in">
                        <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                        Error: {error}
                    </div>
                )}
            </div>

            {/* Custom Modal */}
            {modal.isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden scale-100">
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                                    <i className="fa-solid fa-triangle-exclamation text-lg"></i>
                                </div>
                                <h3 className="text-xl font-bold text-gray-900">Confirm Migration</h3>
                            </div>
                            <p className="text-gray-600 mb-6 leading-relaxed">
                                Are you sure you want to migrate to <strong>{modal.target}</strong>?
                                <br /><br />
                                The server configuration will be updated, and the backend will restart automatically.
                            </p>
                            <div className="flex justify-end gap-3">
                                <button
                                    onClick={() => setModal({ isOpen: false, target: null })}
                                    className="px-5 py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={runMigration}
                                    className="px-5 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 shadow-sm transition-colors"
                                >
                                    Yes, Migrate Data
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
