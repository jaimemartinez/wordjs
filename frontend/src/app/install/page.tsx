"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiPost, apiGet } from "@/lib/api";
import { FaServer, FaUserShield, FaMagic, FaCheckCircle, FaArrowRight, FaArrowLeft } from 'react-icons/fa';

export default function InstallPage() {
    const router = useRouter();
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Step 1: Site Info
    const [siteName, setSiteName] = useState("");
    const [siteDescription, setSiteDescription] = useState("Just another WordJS site");

    // Step 2: Admin Account
    const [adminUser, setAdminUser] = useState("admin");
    const [adminEmail, setAdminEmail] = useState("");
    const [adminPassword, setAdminPassword] = useState("");

    useEffect(() => {
        apiGet<{ installed: boolean }>('/setup/status')
            .then(data => {
                if (data.installed) router.push('/login');
            })
            .catch(() => { });
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        try {
            await apiPost('/setup/install', {
                siteName,
                siteDescription,
                adminUser,
                adminEmail,
                adminPassword,
                frontendUrl: window.location.origin
            });
            router.push('/login?installed=true');
        } catch (err: any) {
            setError(err.message || "Installation failed.");
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen relative flex items-center justify-center overflow-hidden bg-gray-50 dark:bg-gray-900 transition-colors duration-500">
            {/* Animated Background */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
                <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob"></div>
                <div className="absolute top-0 right-1/4 w-96 h-96 bg-yellow-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-2000"></div>
                <div className="absolute -bottom-32 left-1/3 w-96 h-96 bg-pink-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-4000"></div>
            </div>

            <div className="relative z-10 w-full max-w-2xl px-4">
                <div className="glass-panel rounded-2xl shadow-2xl overflow-hidden transition-all duration-300">

                    {/* Header */}
                    <div className="relative bg-gradient-to-r from-blue-600 to-indigo-600 p-8 text-center overflow-hidden">
                        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
                        <div className="relative z-10">
                            <div className="mx-auto bg-white/20 w-16 h-16 rounded-full flex items-center justify-center backdrop-blur-sm mb-4 shadow-lg border border-white/30">
                                <FaMagic className="text-3xl text-white" />
                            </div>
                            <h1 className="text-3xl font-bold text-white tracking-tight font-oswald">WordJS Setup</h1>
                            <p className="text-blue-100 mt-2 font-medium">Build something meaningful</p>
                        </div>
                    </div>

                    <div className="p-8 md:p-10">
                        {/* Progress Steps */}
                        <div className="flex items-center justify-center mb-10">
                            <div className={`flex items-center ${step >= 1 ? 'text-blue-600' : 'text-gray-400'}`}>
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 ${step >= 1 ? 'border-blue-600 bg-blue-50' : 'border-gray-300'} transition-all duration-300`}>
                                    <FaServer size={16} />
                                </div>
                                <span className="ml-3 font-semibold hidden md:block">Site Config</span>
                            </div>
                            <div className={`w-16 h-1 mx-4 rounded ${step >= 2 ? 'bg-blue-600' : 'bg-gray-200'} transition-all duration-300`}></div>
                            <div className={`flex items-center ${step >= 2 ? 'text-blue-600' : 'text-gray-400'}`}>
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 ${step >= 2 ? 'border-blue-600 bg-blue-50' : 'border-gray-300'} transition-all duration-300`}>
                                    <FaUserShield size={16} />
                                </div>
                                <span className="ml-3 font-semibold hidden md:block">Admin User</span>
                            </div>
                        </div>

                        {error && (
                            <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded mb-6 flex items-start shadow-sm">
                                <div className="mr-3 mt-1">⚠️</div>
                                <div>
                                    <p className="font-bold">Installation Error</p>
                                    <p className="text-sm">{error}</p>
                                </div>
                            </div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-6">
                            {step === 1 && (
                                <div className="space-y-5 animate-in fade-in slide-in-from-right-8 duration-500">
                                    <div className="group">
                                        <label className="block text-sm font-semibold text-gray-700 mb-2 group-focus-within:text-blue-600 transition-colors">Site Title</label>
                                        <input
                                            type="text"
                                            required
                                            className="block w-full px-4 py-3 rounded-lg border border-gray-300 bg-white/50 text-gray-900 placeholder-gray-500 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 outline-none"
                                            value={siteName}
                                            onChange={(e) => setSiteName(e.target.value)}
                                            placeholder="e.g. My Amazing Portfolio"
                                        />
                                    </div>
                                    <div className="group">
                                        <label className="block text-sm font-semibold text-gray-700 mb-2 group-focus-within:text-blue-600 transition-colors">Tagline</label>
                                        <input
                                            type="text"
                                            className="block w-full px-4 py-3 rounded-lg border border-gray-300 bg-white/50 text-gray-900 placeholder-gray-500 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 outline-none"
                                            value={siteDescription}
                                            onChange={(e) => setSiteDescription(e.target.value)}
                                            placeholder="Just another WordJS site"
                                        />
                                    </div>

                                    <div className="pt-4">
                                        <button
                                            type="button"
                                            onClick={() => setStep(2)}
                                            disabled={!siteName}
                                            className="w-full flex items-center justify-center bg-gray-900 text-white py-3.5 px-6 rounded-lg font-semibold hover:bg-gray-800 focus:ring-4 focus:ring-gray-300 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                                        >
                                            Next Step <FaArrowRight className="ml-2" />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {step === 2 && (
                                <div className="space-y-5 animate-in fade-in slide-in-from-right-8 duration-500">
                                    <div className="group">
                                        <label className="block text-sm font-semibold text-gray-700 mb-2 group-focus-within:text-blue-600 transition-colors">Username</label>
                                        <input
                                            type="text"
                                            required
                                            className="block w-full px-4 py-3 rounded-lg border border-gray-300 bg-white/50 text-gray-900 placeholder-gray-500 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 outline-none"
                                            value={adminUser}
                                            onChange={(e) => setAdminUser(e.target.value)}
                                        />
                                    </div>
                                    <div className="group">
                                        <label className="block text-sm font-semibold text-gray-700 mb-2 group-focus-within:text-blue-600 transition-colors">Email Address</label>
                                        <input
                                            type="email"
                                            className="block w-full px-4 py-3 rounded-lg border border-gray-300 bg-white/50 text-gray-900 placeholder-gray-500 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 outline-none"
                                            value={adminEmail}
                                            onChange={(e) => setAdminEmail(e.target.value)}
                                        />
                                    </div>
                                    <div className="group">
                                        <label className="block text-sm font-semibold text-gray-700 mb-2 group-focus-within:text-blue-600 transition-colors">Password</label>
                                        <input
                                            type="password"
                                            required
                                            className="block w-full px-4 py-3 rounded-lg border border-gray-300 bg-white/50 text-gray-900 placeholder-gray-500 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 outline-none"
                                            value={adminPassword}
                                            onChange={(e) => setAdminPassword(e.target.value)}
                                        />
                                    </div>

                                    <div className="flex gap-4 pt-4">
                                        <button
                                            type="button"
                                            onClick={() => setStep(1)}
                                            className="w-1/3 flex items-center justify-center bg-white text-gray-700 border border-gray-300 py-3.5 px-6 rounded-lg font-semibold hover:bg-gray-50 focus:ring-4 focus:ring-gray-100 transition-all duration-300"
                                        >
                                            <FaArrowLeft className="mr-2" /> Back
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={loading}
                                            className="w-2/3 flex items-center justify-center bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3.5 px-6 rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 focus:ring-4 focus:ring-blue-300 transition-all duration-300 disabled:opacity-70 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                                        >
                                            {loading ? (
                                                <span className="flex items-center">
                                                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                    </svg>
                                                    Installing...
                                                </span>
                                            ) : (
                                                <span className="flex items-center">
                                                    Install WordJS <FaCheckCircle className="ml-2" />
                                                </span>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </form>
                    </div>
                </div>

                <p className="text-center text-gray-500 mt-8 text-sm font-medium relative z-10">
                    &copy; {new Date().getFullYear()} WordJS. The future of content management.
                </p>
            </div>
        </div>
    );
}
