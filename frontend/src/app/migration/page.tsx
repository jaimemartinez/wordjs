"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiPost, apiGet } from "@/lib/api";
import { FaGlobe, FaSyncAlt, FaExclamationTriangle } from 'react-icons/fa';

export default function MigrationPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [details, setDetails] = useState<{ configured: string, detected: string } | null>(null);

    // Auth state
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");

    useEffect(() => {
        apiGet<any>('/setup/status')
            .then(data => {
                if (data.mismatch) {
                    setDetails({
                        configured: data.configUrl,
                        detected: data.detectedUrl
                    });
                } else if (!data.installed) {
                    router.push('/install');
                } else {
                    router.push('/admin');
                }
            })
            .catch(() => { });
    }, [router]);

    const handleUpdate = async () => {
        setLoading(true);
        setError("");

        try {
            await apiPost('/setup/migrate', { username, password });
            // Wait a moment for UX
            setTimeout(() => {
                window.location.href = "/admin";
            }, 1000);
        } catch (err: any) {
            setError(err.message || "Migration failed.");
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen relative flex items-center justify-center overflow-hidden bg-gray-50 dark:bg-gray-900 transition-colors duration-500">
            {/* Animated Background */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
                <div className="absolute top-0 right-1/4 w-96 h-96 bg-amber-300 rounded-full mix-blend-multiply filter blur-xl opacity-60 animate-blob"></div>
                <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-orange-300 rounded-full mix-blend-multiply filter blur-xl opacity-60 animate-blob animation-delay-2000"></div>
                <div className="absolute top-1/2 left-1/3 w-96 h-96 bg-yellow-200 rounded-full mix-blend-multiply filter blur-xl opacity-60 animate-blob animation-delay-4000"></div>
            </div>

            <div className="relative z-10 w-full max-w-xl px-4">
                <div className="glass-panel rounded-2xl shadow-2xl overflow-hidden transition-all duration-300 border-t-4 border-amber-500">

                    <div className="p-8 md:p-12 text-center">
                        <div className="mx-auto bg-amber-100 w-20 h-20 rounded-full flex items-center justify-center mb-6 shadow-md animate-bounce-slow">
                            <FaExclamationTriangle className="text-4xl text-amber-500" />
                        </div>

                        <h1 className="text-3xl font-bold text-gray-800 mb-2 font-oswald">Domain Change Detected</h1>
                        <p className="text-gray-600 mb-8 max-w-sm mx-auto">
                            We noticed that your site address has changed. We need to update your configuration to keep everything running smoothly.
                        </p>

                        {details && (
                            <div className="bg-gray-50/80 backdrop-blur-sm rounded-xl p-6 mb-8 border border-gray-200 text-left shadow-inner">
                                <div className="grid grid-cols-1 gap-4">
                                    <div className="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-100 shadow-sm">
                                        <div className="flex items-center text-gray-400">
                                            <FaGlobe className="mr-3" />
                                            <span className="text-sm font-medium">Old Address</span>
                                        </div>
                                        <span className="font-mono text-gray-500 line-through text-sm">{details.configured}</span>
                                    </div>
                                    <div className="flex justify-center -my-2 relative z-10">
                                        <div className="bg-gray-200 rounded-full p-1">
                                            <FaSyncAlt className="text-gray-500 text-xs" />
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between p-3 bg-green-50 rounded-lg border border-green-100 shadow-sm">
                                        <div className="flex items-center text-green-600">
                                            <FaGlobe className="mr-3" />
                                            <span className="text-sm font-bold">New Address</span>
                                        </div>
                                        <span className="font-mono text-green-700 font-bold text-sm">{details.detected}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {error && (
                            <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-6 text-sm flex items-center justify-center">
                                <FaExclamationTriangle className="mr-2" /> {error}
                            </div>
                        )}

                        <div className="space-y-4 mb-6 text-left">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Admin Username</label>
                                <input
                                    type="text"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all"
                                    placeholder="Enter admin username"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Admin Password</label>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all"
                                    placeholder="Enter admin password"
                                />
                            </div>
                        </div>

                        <button
                            onClick={handleUpdate}
                            disabled={loading || !username || !password}
                            className="w-full bg-gradient-to-r from-amber-500 to-orange-500 text-white py-4 px-6 rounded-xl font-bold text-lg hover:from-amber-600 hover:to-orange-600 focus:ring-4 focus:ring-amber-200 transition-all duration-300 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none"
                        >
                            {loading ? (
                                <span className="flex items-center justify-center">
                                    <FaSyncAlt className="animate-spin mr-3" />
                                    Verifying & Updating...
                                </span>
                            ) : (
                                "Authenticate & Update Site"
                            )}
                        </button>

                        <p className="text-xs text-gray-400 mt-6">
                            Moved by mistake? <a href={details?.configured} className="text-amber-600 hover:underline">Go back to {details?.configured}</a>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
