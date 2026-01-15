"use client";
import React, { useEffect, useState } from "react";

export default function DbMigrationPage() {
    const [status, setStatus] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [migrationProgress, setMigrationProgress] = useState<any>(null);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [restarting, setRestarting] = useState(false);

    // Postgres Form State
    const [pgConfig, setPgConfig] = useState({
        dbHost: 'localhost',
        dbPort: '5432',
        dbUser: 'postgres',
        dbPassword: '',
        dbName: 'wordjs'
    });

    // Modal State
    const [modal, setModal] = useState<{
        isOpen: boolean;
        target: string | null;
        type: 'confirm' | 'form';
    }>({ isOpen: false, target: null, type: 'confirm' });

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

    const initMigration = (target: string) => {
        if (target === 'postgres') {
            setModal({ isOpen: true, target, type: 'form' });
        } else {
            setModal({ isOpen: true, target, type: 'confirm' });
        }
    };

    const runCleanup = async (file: string) => {
        if (!confirm(`Are you sure you want to delete ${file}? This cannot be undone.`)) return;

        try {
            const token = localStorage.getItem("wordjs_token");
            const res = await fetch('/api/v1/db-migration/cleanup', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ file })
            });
            const data = await res.json();
            if (res.ok) {
                setResult(`Cleaned up ${file}`);
                fetchStatus(); // Refresh list
                setTimeout(() => setResult(null), 3000);
            } else {
                throw new Error(data.error);
            }
        } catch (e: any) {
            setError(e.message);
        }
    };

    const runMigration = async () => {
        const target = modal.target;
        if (!target) return;

        setModal({ isOpen: false, target: null, type: 'confirm' });
        setLoading(true);
        setError(null);
        setResult(null);
        setMigrationProgress(null);
        const token = localStorage.getItem("wordjs_token");

        // Start Polling for Progress
        const progressPoll = setInterval(async () => {
            try {
                const res = await fetch('/api/v1/db-migration/status', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();
                if (data.status) setMigrationProgress(data.status);
            } catch (e) { }
        }, 500);

        const payload: any = { targetDriver: target };
        if (target === 'postgres') {
            Object.assign(payload, pgConfig);
        }

        try {
            const res = await fetch('/api/v1/db-migration/migrate', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            clearInterval(progressPoll);
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Migration failed');

            setResult(data.message);
            setRestarting(true);

            // Poll for server status until it comes back up
            const poll = setInterval(async () => {
                try {
                    const health = await fetch('/health');
                    if (health.ok) {
                        clearInterval(poll);
                        window.location.reload();
                    }
                } catch (e) { }
            }, 1000);

        } catch (e: any) {
            clearInterval(progressPoll);
            setError(e.message);
            setLoading(false); // Only stop loading on error, keep it true for restart
        }
    };

    if (loading && migrationProgress && migrationProgress.step !== 'idle' && migrationProgress.step !== 'done') {
        return (
            <div className="fixed inset-0 z-[60] bg-white/95 flex flex-col items-center justify-center animate-in fade-in">
                <div className="w-96 max-w-full px-6">
                    <div className="flex justify-between mb-2 items-end">
                        <span className="font-bold text-gray-800 capitalize text-lg flex items-center gap-2">
                            {(migrationProgress.step === 'initializing' || migrationProgress.step === 'starting') && <i className="fa-solid fa-hourglass-start animate-spin"></i>}
                            {migrationProgress.step === 'copying' && <i className="fa-solid fa-copy animate-pulse text-blue-500"></i>}
                            {migrationProgress.step}
                        </span>
                        <span className="text-blue-600 font-mono font-bold text-lg">{migrationProgress.progress}%</span>
                    </div>
                    <div className="h-4 bg-gray-100 rounded-full overflow-hidden border border-gray-200 shadow-inner">
                        <div
                            className="h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-300 ease-out shadow-lg"
                            style={{ width: `${migrationProgress.progress}%` }}
                        ></div>
                    </div>
                    <div className="mt-4 text-sm text-gray-500 text-center font-medium h-6">
                        {migrationProgress.currentTable && `Migrating table: ${migrationProgress.currentTable}`}
                    </div>

                    {migrationProgress.warnings && migrationProgress.warnings.length > 0 && (
                        <div className="mt-6 p-4 bg-orange-50 text-orange-800 text-xs rounded-lg border border-orange-200 max-h-40 overflow-y-auto shadow-sm">
                            <h4 className="font-bold flex items-center gap-2 mb-2 sticky top-0 bg-orange-50 pb-2 border-b border-orange-200">
                                <i className="fa-solid fa-circle-exclamation"></i> Warnings ({migrationProgress.warnings.length})
                            </h4>
                            <ul className="space-y-1">
                                {migrationProgress.warnings.map((w: string, i: number) => (
                                    <li key={i} className="font-mono">{w}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    if (restarting) {
        return (
            <div className="fixed inset-0 z-50 bg-white/90 flex flex-col items-center justify-center animate-in fade-in">
                <div className="animate-spin text-4xl text-blue-600 mb-4">
                    <i className="fa-solid fa-circle-notch"></i>
                </div>
                <h2 className="text-xl font-bold text-gray-800">Restarting Server...</h2>
                <p className="text-gray-500 mt-2">Please wait while we apply changes.</p>
            </div>
        );
    }

    if (!status) return (
        <div className="flex items-center justify-center min-h-[60vh]">
            <div className="flex flex-col items-center gap-4 animate-pulse">
                <i className="fa-solid fa-circle-notch animate-spin text-4xl text-indigo-600"></i>
                <span className="text-gray-500 font-medium tracking-wide">Connecting to System...</span>
            </div>
        </div>
    );

    return (
        <div className="p-8 max-w-7xl mx-auto relative min-h-[85vh]">
            {/* Decorative Background Elements */}
            <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-purple-100/50 rounded-full blur-[100px] opacity-60 -z-10 translate-x-1/3 -translate-y-1/3 pointer-events-none"></div>
            <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-blue-100/50 rounded-full blur-[100px] opacity-60 -z-10 -translate-x-1/3 translate-y-1/3 pointer-events-none"></div>

            <header className="mb-12 animate-in slide-in-from-top-4 fade-in duration-500">
                <div className="flex items-center gap-5 mb-3">
                    <div className="w-14 h-14 bg-gradient-to-br from-indigo-600 to-violet-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200/50 transform rotate-3 hover:rotate-0 transition-transform duration-300">
                        <i className="fa-solid fa-database text-white text-2xl"></i>
                    </div>
                    <div>
                        <h1 className="text-4xl font-black text-gray-900 tracking-tight">Database Migration</h1>
                        <p className="text-lg text-gray-500 font-medium mt-1">Manage storage engines and data portability.</p>
                    </div>
                </div>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                {/* Left Column: Status (4 cols) */}
                <div className="lg:col-span-4 space-y-6 animate-in slide-in-from-left-4 fade-in duration-700 delay-100">
                    <div className="bg-white/80 backdrop-blur-xl p-8 rounded-3xl border border-white/60 shadow-xl overflow-hidden relative group hover:shadow-2xl transition-all duration-500">
                        <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover:opacity-[0.08] transition-opacity duration-500 transform scale-150 rotate-12 pointer-events-none">
                            <i className="fa-solid fa-server text-9xl text-indigo-900"></i>
                        </div>

                        <div className="relative z-10">
                            <h2 className="text-xs font-black text-indigo-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                                <i className="fa-solid fa-microchip"></i> Active Engine
                            </h2>

                            <div className="flex flex-col gap-6">
                                <div className="flex items-center gap-4">
                                    <div className="relative flex-shrink-0">
                                        <div className="w-4 h-4 bg-emerald-500 rounded-full shadow-[0_0_15px_rgba(16,185,129,0.5)]"></div>
                                        <div className="absolute inset-0 bg-emerald-500 rounded-full animate-ping opacity-75"></div>
                                    </div>
                                    <span className="text-3xl font-black text-gray-800 tracking-tight leading-none">
                                        {status.currentDriver === 'sqlite-native' ? 'Native SQLite' :
                                            status.currentDriver === 'postgres' ? 'PostgreSQL' : 'Legacy SQLite'}
                                    </span>
                                </div>

                                <div className="text-sm bg-gray-50/80 rounded-2xl p-5 border border-gray-100 text-gray-600 leading-relaxed font-medium">
                                    {status.currentDriver === 'sqlite-native' && "⚡ High-performance file-based storage with WAL mode enabled. Recommended for most users."}
                                    {status.currentDriver === 'postgres' && "🐘 Production-grade relational database engine. Best for scaling and high concurrency."}
                                    {status.currentDriver === 'sqlite-legacy' && "🐢 Compatibility mode using standard file locking. Slower, but works on all file systems."}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Stats / Info */}
                    <div className="bg-gradient-to-br from-gray-900 to-gray-800 text-white p-6 rounded-3xl shadow-xl flex items-center justify-between group overflow-hidden relative">
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent translate-x-[-200%] group-hover:translate-x-[200%] transition-transform duration-1000"></div>
                        <div className="relative z-10">
                            <div className="text-gray-400 text-xs font-bold uppercase mb-1 tracking-wider">System Status</div>
                            <div className="text-xl font-bold flex items-center gap-2">
                                Online
                                <i className="fa-solid fa-check text-emerald-400 text-sm"></i>
                            </div>
                        </div>
                        <div className="w-12 h-12 bg-gray-700/50 rounded-2xl flex items-center justify-center text-emerald-400 text-xl relative z-10">
                            <i className="fa-solid fa-wave-square"></i>
                        </div>
                    </div>
                </div>

                {/* Right Column: Migrations (8 cols) */}
                <div className="lg:col-span-8 animate-in slide-in-from-bottom-8 fade-in duration-700 delay-200">
                    <div className="bg-white/50 backdrop-blur-sm rounded-3xl p-2 md:p-8 border border-white/60">
                        <h2 className="text-xl font-bold text-gray-800 flex items-center gap-3 mb-6 px-2">
                            <div className="w-8 h-8 rounded-lg bg-gray-900 text-white flex items-center justify-center text-sm">
                                <i className="fa-solid fa-share-nodes"></i>
                            </div>
                            Available Migrations
                        </h2>

                        <div className="grid gap-5">
                            {/* Option: Native SQLite */}
                            {(status.currentDriver === 'sqlite-legacy' || status.currentDriver === 'postgres') && (
                                <div className="group bg-white p-6 md:p-8 rounded-2xl border border-gray-100 shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 relative overflow-hidden">
                                    <div className="absolute inset-0 bg-gradient-to-r from-blue-50/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                                    <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-6">
                                        <div className="flex items-start gap-6">
                                            <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex-shrink-0 flex items-center justify-center text-3xl shadow-blue-100 group-hover:scale-110 group-hover:rotate-3 transition-all duration-300">
                                                <i className="fa-solid fa-bolt"></i>
                                            </div>
                                            <div>
                                                <h3 className="text-xl font-bold text-gray-900 group-hover:text-blue-700 transition-colors">Migrate to Native SQLite</h3>
                                                <p className="text-gray-500 font-medium mt-1">Boost write performance by 10x with WAL mode.</p>
                                                <div className="flex gap-2 mt-3">
                                                    <span className="px-2 py-1 bg-blue-50 text-blue-700 text-xs font-bold rounded uppercase">Recommended</span>
                                                    <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs font-bold rounded uppercase">Fast</span>
                                                </div>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => initMigration('sqlite-native')}
                                            disabled={loading}
                                            className="px-8 py-4 bg-gray-900 text-white font-bold rounded-xl hover:bg-blue-600 hover:shadow-lg hover:shadow-blue-500/30 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                                        >
                                            Upgrade Now
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Option: Postgres */}
                            {status.currentDriver !== 'postgres' && (
                                <div className="group bg-white p-6 md:p-8 rounded-2xl border border-gray-100 shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 relative overflow-hidden">
                                    <div className="absolute inset-0 bg-gradient-to-r from-indigo-50/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                                    <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-6">
                                        <div className="flex items-start gap-6">
                                            <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-2xl flex-shrink-0 flex items-center justify-center text-3xl shadow-indigo-100 group-hover:scale-110 group-hover:-rotate-3 transition-all duration-300">
                                                <i className="fa-solid fa-network-wired"></i>
                                            </div>
                                            <div>
                                                <h3 className="text-xl font-bold text-gray-900 group-hover:text-indigo-700 transition-colors">Switch to PostgreSQL</h3>
                                                <p className="text-gray-500 font-medium mt-1">Scale up with a production-grade external database.</p>
                                                <div className="flex gap-2 mt-3">
                                                    <span className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs font-bold rounded uppercase">Scalable</span>
                                                    <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs font-bold rounded uppercase">Secure</span>
                                                </div>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => initMigration('postgres')}
                                            disabled={loading}
                                            className="px-8 py-4 bg-gray-900 text-white font-bold rounded-xl hover:bg-indigo-600 hover:shadow-lg hover:shadow-indigo-500/30 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                                        >
                                            Configure
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Option: Legacy */}
                            {(status.currentDriver === 'sqlite-native' || status.currentDriver === 'postgres') && (
                                <div className="group bg-white/40 p-6 md:p-8 rounded-2xl border-2 border-dashed border-gray-200 hover:border-gray-300 hover:bg-white transition-all duration-300">
                                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                                        <div className="flex items-start gap-6">
                                            <div className="w-16 h-16 bg-gray-100 text-gray-400 rounded-2xl flex-shrink-0 flex items-center justify-center text-3xl group-hover:text-gray-600 transition-colors">
                                                <i className="fa-regular fa-hard-drive"></i>
                                            </div>
                                            <div>
                                                <h3 className="text-xl font-bold text-gray-600 group-hover:text-gray-800 transition-colors">Downgrade to Legacy</h3>
                                                <p className="text-gray-400 font-medium mt-1">Revert to standard file locking (sql.js).</p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => initMigration('sqlite-legacy')}
                                            disabled={loading}
                                            className="px-6 py-3 text-gray-500 font-bold hover:text-gray-900 hover:bg-gray-100 rounded-xl transition-all disabled:opacity-50"
                                        >
                                            Downgrade
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Notifications */}
            <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none">
                {result && (
                    <div className="pointer-events-auto p-4 bg-emerald-500 text-white shadow-2xl shadow-emerald-500/30 rounded-2xl animate-in slide-in-from-right fade-in flex items-center gap-4 max-w-md border border-emerald-400">
                        <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
                            <i className="fa-solid fa-check text-lg"></i>
                        </div>
                        <span className="font-bold tracking-wide">{result}</span>
                    </div>
                )}
                {error && (
                    <div className="pointer-events-auto p-4 bg-red-500 text-white shadow-2xl shadow-red-500/30 rounded-2xl animate-in slide-in-from-right fade-in flex items-center gap-4 max-w-md border border-red-400">
                        <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
                            <i className="fa-solid fa-triangle-exclamation text-lg"></i>
                        </div>
                        <span className="font-bold tracking-wide">{error}</span>
                    </div>
                )}
            </div>

            {/* Custom Modal */}
            {modal.isOpen && (
                <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-in fade-in" onClick={() => setModal({ ...modal, isOpen: false })}></div>
                    <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full overflow-hidden relative z-10 animate-in zoom-in-95 duration-300">
                        {modal.type === 'confirm' ? (
                            <div className="p-8">
                                <div className="w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mb-6 mx-auto">
                                    <i className="fa-solid fa-arrow-right-arrow-left text-2xl"></i>
                                </div>
                                <h3 className="text-2xl font-black text-gray-900 text-center mb-2">Ready to Migrate?</h3>
                                <p className="text-gray-500 text-center mb-8 font-medium">
                                    You are about to migrate data to <strong>{modal.target}</strong>.
                                    The server will restart automatically.
                                </p>
                                <div className="grid grid-cols-2 gap-4">
                                    <button
                                        onClick={() => setModal({ ...modal, isOpen: false })}
                                        className="px-6 py-4 rounded-xl border border-gray-200 text-gray-700 font-bold hover:bg-gray-50 hover:border-gray-300 transition-all"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={runMigration}
                                        className="px-6 py-4 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/30 transition-all"
                                    >
                                        Start Migration
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="p-8">
                                <div className="flex items-center justify-between mb-8">
                                    <h3 className="text-2xl font-black text-gray-900">PostgreSQL Setup</h3>
                                    <button onClick={() => setModal({ ...modal, isOpen: false })} className="text-gray-400 hover:text-gray-600">
                                        <i className="fa-solid fa-xmark text-xl"></i>
                                    </button>
                                </div>

                                {/* Embedded Server Helper */}
                                <div className="mb-8 p-5 bg-indigo-50/50 rounded-2xl border border-indigo-100">
                                    <h4 className="font-bold text-sm text-indigo-900 mb-3 flex items-center gap-2">
                                        <i className="fa-solid fa-server"></i> Local Embedded DB
                                    </h4>

                                    <div className="flex items-center justify-between">
                                        <div className="text-sm font-medium text-indigo-700/80">
                                            Use built-in private instance.
                                        </div>
                                        <EmbeddedControls
                                            onReady={(creds) => setPgConfig({ ...pgConfig, ...creds })}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-5 mb-8">
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Host Address</label>
                                        <input
                                            type="text"
                                            value={pgConfig.dbHost}
                                            onChange={e => setPgConfig({ ...pgConfig, dbHost: e.target.value })}
                                            className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-indigo-500 focus:ring-0 font-medium transition-colors"
                                            placeholder="localhost"
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-5">
                                        <div>
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Port</label>
                                            <input
                                                type="text"
                                                value={pgConfig.dbPort}
                                                onChange={e => setPgConfig({ ...pgConfig, dbPort: e.target.value })}
                                                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-indigo-500 focus:ring-0 font-medium transition-colors"
                                                placeholder="5432"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">DB Name</label>
                                            <input
                                                type="text"
                                                value={pgConfig.dbName}
                                                onChange={e => setPgConfig({ ...pgConfig, dbName: e.target.value })}
                                                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-indigo-500 focus:ring-0 font-medium transition-colors"
                                                placeholder="wordjs"
                                            />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-5">
                                        <div>
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">User</label>
                                            <input
                                                type="text"
                                                value={pgConfig.dbUser}
                                                onChange={e => setPgConfig({ ...pgConfig, dbUser: e.target.value })}
                                                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-indigo-500 focus:ring-0 font-medium transition-colors"
                                                placeholder="postgres"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Password</label>
                                            <input
                                                type="password"
                                                value={pgConfig.dbPassword}
                                                onChange={e => setPgConfig({ ...pgConfig, dbPassword: e.target.value })}
                                                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-indigo-500 focus:ring-0 font-medium transition-colors"
                                                placeholder="••••••"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <button
                                    onClick={runMigration}
                                    className="w-full px-6 py-4 rounded-xl bg-gray-900 text-white font-bold hover:bg-indigo-600 hover:shadow-lg hover:shadow-indigo-500/30 transition-all text-lg"
                                >
                                    Confirm Configuration
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// Sub-component for Embedded Controls
function EmbeddedControls({ onReady }: { onReady: (creds: any) => void }) {
    const [status, setStatus] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const token = localStorage.getItem("wordjs_token");

    const fetchStatus = async () => {
        try {
            const res = await fetch('/api/v1/db-migration/embedded/status', { headers: { 'Authorization': `Bearer ${token}` } });
            setStatus(await res.json());
        } catch (e) { }
    };

    useEffect(() => { fetchStatus(); }, []);

    const action = async (act: 'install' | 'start' | 'stop') => {
        setLoading(true);
        try {
            await fetch(`/api/v1/db-migration/embedded/${act}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            await fetchStatus();

            // If just started, auto-fill
            if (act === 'start') {
                onReady({
                    dbHost: 'localhost',
                    dbPort: '5433', // Embedded Port
                    dbUser: 'postgres',
                    dbPassword: 'password',
                    dbName: 'wordjs'
                });
            }
        } catch (e) { }
        setLoading(false);
    };

    if (!status) return <span className="text-xs">Checking...</span>;
    if (status.isInstalling) return <span className="text-xs text-blue-600 animate-pulse">Installing binary...</span>;

    if (!status.installed) {
        return (
            <button
                onClick={() => action('install')}
                disabled={loading}
                className="text-xs px-2 py-1 bg-gray-200 hover:bg-gray-300 rounded"
            >
                {loading ? 'Installing...' : 'Install (~80MB)'}
            </button>
        );
    }

    if (!status.running) {
        return (
            <button
                onClick={() => action('start')}
                disabled={loading}
                className="text-xs px-2 py-1 bg-green-100 text-green-700 hover:bg-green-200 rounded font-medium"
            >
                {loading ? 'Starting...' : 'Start Server'}
            </button>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <span className="text-xs text-green-600 font-bold">● Running :5433</span>
            <button
                onClick={() => onReady({
                    dbHost: 'localhost',
                    dbPort: '5433',
                    dbUser: 'postgres',
                    dbPassword: 'password',
                    dbName: 'wordjs'
                })}
                className="text-xs px-2 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded"
            >
                Use
            </button>
        </div>
    );
}
