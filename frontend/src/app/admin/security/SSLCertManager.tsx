"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";

interface CertInfo {
    commonName?: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    fingerprint?: string;
    serialNumber?: string;
    type?: 'letsencrypt' | 'self-signed' | 'custom' | 'none' | 'error';
    path?: string;
    error?: string;
    message?: string;
}

interface SSLCertManagerProps {
    domain?: string;
    adminEmail?: string;
}

export default function SSLCertManager({ domain: initialDomain, adminEmail: initialEmail }: SSLCertManagerProps) {
    const [domain, setDomain] = useState(initialDomain || "");
    const [email, setEmail] = useState(initialEmail || "");
    const [method, setMethod] = useState<"http" | "dns" | "custom">("http");
    const [staging, setStaging] = useState(false);

    // Custom Cert State
    const [keyContent, setKeyContent] = useState("");
    const [certContent, setCertContent] = useState("");

    // Certificate Info State
    const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
    const [sslEnabled, setSslEnabled] = useState(false);
    const [loading, setLoading] = useState(true);

    // State machine
    const [status, setStatus] = useState<"idle" | "loading" | "step1_dns" | "success" | "error">("idle");
    const [logs, setLogs] = useState<string[]>([]);
    const [dnsData, setDnsData] = useState<any>(null);
    const [error, setError] = useState("");

    const addLog = (msg: string) => setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

    // Load certificate info on mount
    useEffect(() => {
        const loadCertInfo = async () => {
            try {
                // Use api helper which injects JWT token
                const data = await api<any>("/system/certs/config");
                setCertInfo(data.certInfo);
                setSslEnabled(data.sslEnabled);
            } catch (e) {
                console.error("Failed to load cert info:", e);
                addLog("Failed to load certification info: " + (e as Error).message);
            } finally {
                setLoading(false);
            }
        };
        loadCertInfo();
    }, [status]);

    // Helper to read file content
    const readFile = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    };

    const handleCustomUpload = async () => {
        if (!keyContent || !certContent) {
            setError("Please upload both Private Key and Certificate files.");
            return;
        }

        setStatus("loading");
        setLogs([]);
        setError("");
        addLog("Uploading custom certificate...");

        try {
            await api<any>("/system/certs/upload-custom", {
                method: "POST",
                body: { key: keyContent, cert: certContent }
            });

            addLog("Custom certificate installed successfully!");
            setStatus("success");
            // Clear inputs
            setKeyContent("");
            setCertContent("");
        } catch (e: any) {
            setError(e.message);
            addLog("Error: " + e.message);
            setStatus("error");
        }
    };

    const handleProvision = async () => {
        if (method === 'custom') {
            await handleCustomUpload();
            return;
        }

        setStatus("loading");
        setLogs([]);
        setError("");
        addLog(`Starting provisioning for ${domain} via ${method.toUpperCase()}...`);

        try {
            if (method === "http") {
                const data = await api<any>("/system/certs/auto-provision", {
                    method: "POST",
                    body: { domain, email, staging: false }
                });

                addLog("Certificate provisioned successfully!");
                addLog("Saved to: " + data.path);
                setStatus("success");
            } else {
                // DNS Step 1
                const data = await api<any>("/system/certs/dns-start", {
                    method: "POST",
                    body: { domain, email, staging: false }
                });

                addLog("DNS Challenge Created. Please add the TXT record.");
                setDnsData(data);
                setStatus("step1_dns");
            }
        } catch (e: any) {
            setError(e.message);
            addLog("Error: " + e.message);
            setStatus("error");
        }
    };

    const handleDNSCheck = async () => {
        if (!dnsData) return;
        addLog("Checking DNS propagation...");
        try {
            const data = await api<any>("/system/certs/dns-check", {
                method: "POST",
                body: { domain, expectedValue: dnsData.txtValue }
            });

            if (data.passed) {
                addLog("DNS Record Found! Proceeding to verification...");
                handleDNSFinish();
            } else {
                addLog("⚠️ DNS record not found yet. Please wait a moment and try again.");
            }
        } catch (e: any) {
            addLog("Check Failed: " + e.message);
        }
    };

    const handleDNSFinish = async () => {
        setStatus("loading");
        try {
            await api<any>("/system/certs/dns-finish", {
                method: "POST",
                body: { step1Data: dnsData, email, staging: false }
            });

            addLog("Success! Certificate installed.");
            setStatus("success");
            setDnsData(null);
        } catch (e: any) {
            setError(e.message);
            addLog("Error: " + e.message);
            setStatus("step1_dns");
        }
    };

    return (
        <div className="space-y-8">
            {/* Status Messages */}
            {certInfo && certInfo.type === 'error' && (
                <div className="p-4 bg-red-50 text-red-600 rounded-xl border border-red-100 flex items-center gap-2">
                    <i className="fa-solid fa-circle-exclamation"></i>
                    <span className="font-medium text-sm">Certificate Error: {certInfo.error}</span>
                </div>
            )}

            {loading && (
                <div className="text-center py-4 text-blue-500">
                    <i className="fa-solid fa-circle-notch fa-spin text-xl"></i>
                </div>
            )}

            <div className="space-y-6">
                <div className="flex items-center gap-3 pb-2 border-b border-blue-200/30">
                    <h4 className="text-sm font-bold text-blue-900 uppercase tracking-wider">
                        <i className="fa-solid fa-plus mr-2 text-blue-500"></i>
                        Provision / Install Certificate
                    </h4>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide ml-1">Domain Name</label>
                        <input
                            type="text"
                            value={domain}
                            onChange={e => setDomain(e.target.value)}
                            placeholder="example.com"
                            className="w-full px-5 py-3 bg-white/70 border border-blue-100 rounded-xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all placeholder-gray-400"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide ml-1">Email <span className="text-gray-300 font-normal">(for Let's Encrypt)</span></label>
                        <input
                            type="email"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            placeholder="admin@example.com"
                            className="w-full px-5 py-3 bg-white/70 border border-blue-100 rounded-xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all placeholder-gray-400"
                        />
                    </div>
                </div>
            </div>

            <div className="space-y-4 pt-4">
                <label className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Validation Method</label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div
                        onClick={() => setMethod("http")}
                        className={`p-5 rounded-xl border-2 cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ${method === "http"
                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/40 dark:border-blue-500 shadow-md"
                            : "border-gray-200 dark:border-gray-700 hover:border-blue-300 bg-white/50 dark:bg-gray-800/50"
                            }`}
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <h4 className={`font-bold ${method === "http" ? "text-blue-700 dark:text-blue-300" : "text-gray-900 dark:text-gray-200"}`}>HTTP-01 (Auto)</h4>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400">Fastest. Requires port 80 open.</p>
                    </div>
                    <div
                        onClick={() => setMethod("dns")}
                        className={`p-5 rounded-xl border-2 cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ${method === "dns"
                            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/40 dark:border-indigo-500 shadow-md"
                            : "border-gray-200 dark:border-gray-700 hover:border-indigo-300 bg-white/50 dark:bg-gray-800/50"
                            }`}
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <h4 className={`font-bold ${method === "dns" ? "text-indigo-700 dark:text-indigo-300" : "text-gray-900 dark:text-gray-200"}`}>DNS-01 (Manual)</h4>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400">For firewalls / wildcards.</p>
                    </div>
                    <div
                        onClick={() => setMethod("custom")}
                        className={`p-5 rounded-xl border-2 cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ${method === "custom"
                            ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/40 dark:border-emerald-500 shadow-md"
                            : "border-gray-200 dark:border-gray-700 hover:border-emerald-300 bg-white/50 dark:bg-gray-800/50"
                            }`}
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <i className={`fa-solid fa-upload ${method === "custom" ? "text-emerald-600" : "text-gray-400"}`}></i>
                            <h4 className={`font-bold ${method === "custom" ? "text-emerald-700 dark:text-emerald-300" : "text-gray-900 dark:text-gray-200"}`}>Custom Upload</h4>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400">Upload existing .key/.pem.</p>
                    </div>
                </div>
            </div>

            {/* Custom Upload Inputs */}
            {method === "custom" && (
                <div className="bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-800 rounded-2xl p-6 space-y-4 animate-in fade-in slide-in-bottom duration-300">
                    <h4 className="font-bold text-emerald-900 dark:text-emerald-300 flex items-center gap-2">
                        <i className="fa-solid fa-file-arrow-up"></i> Upload Certificate Files
                    </h4>
                    <p className="text-sm text-emerald-800 dark:text-emerald-200/80">
                        Please upload your <strong>Private Key</strong> and <strong>Certificate</strong> (PEM format).
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide ml-1">Private Key (.key / .pem)</label>
                            <input
                                type="file"
                                accept=".key,.pem,.txt"
                                onChange={async (e) => {
                                    if (e.target.files?.[0]) {
                                        const content = await readFile(e.target.files[0]);
                                        setKeyContent(content);
                                    }
                                }}
                                className="w-full text-sm text-gray-600 dark:text-gray-300
                                file:mr-4 file:py-2.5 file:px-4
                                file:rounded-xl file:border-0
                                file:text-sm file:font-bold
                                file:bg-emerald-100 dark:file:bg-emerald-800 file:text-emerald-700 dark:file:text-emerald-300
                                hover:file:bg-emerald-200 dark:hover:file:bg-emerald-700
                                cursor-pointer"
                            />
                            {keyContent && <p className="text-xs text-emerald-600 dark:text-emerald-400 font-bold ml-1 animate-pulse"><i className="fa-solid fa-check mr-1"></i>Key loaded</p>}
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide ml-1">Certificate (.crt / .pem)</label>
                            <input
                                type="file"
                                accept=".crt,.pem,.txt"
                                onChange={async (e) => {
                                    if (e.target.files?.[0]) {
                                        const content = await readFile(e.target.files[0]);
                                        setCertContent(content);
                                    }
                                }}
                                className="w-full text-sm text-gray-600 dark:text-gray-300
                                file:mr-4 file:py-2.5 file:px-4
                                file:rounded-xl file:border-0
                                file:text-sm file:font-bold
                                file:bg-emerald-100 dark:file:bg-emerald-800 file:text-emerald-700 dark:file:text-emerald-300
                                hover:file:bg-emerald-200 dark:hover:file:bg-emerald-700
                                cursor-pointer"
                            />
                            {certContent && <p className="text-xs text-emerald-600 dark:text-emerald-400 font-bold ml-1 animate-pulse"><i className="fa-solid fa-check mr-1"></i>Certificate loaded</p>}
                        </div>
                    </div>
                </div>
            )}

            {/* Logs Console */}
            {logs.length > 0 && (
                <div className="bg-slate-900 rounded-xl p-4 font-mono text-sm max-h-60 overflow-y-auto">
                    {logs.map((l, i) => (
                        <div key={i} className="text-green-400 mb-1 last:mb-0">{l}</div>
                    ))}
                </div>
            )}

            {/* DNS Instructions */}
            {status === "step1_dns" && dnsData && (
                <div className="p-6 bg-blue-50 rounded-xl border border-blue-200 space-y-4">
                    <h4 className="font-bold text-blue-900"><i className="fa-solid fa-circle-info mr-2"></i>DNS Action Required</h4>
                    <p className="text-blue-800 text-sm">Please add the following TXT record to your DNS provider:</p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="bg-white p-3 rounded border">
                            <span className="text-xs text-gray-500 block mb-1">Type</span>
                            <code className="font-bold">TXT</code>
                        </div>
                        <div className="bg-white p-3 rounded border">
                            <span className="text-xs text-gray-500 block mb-1">Host / Name</span>
                            <code className="font-bold select-all">{dnsData.txtRecord}</code>
                        </div>
                        <div className="md:col-span-2 bg-white p-3 rounded border">
                            <span className="text-xs text-gray-500 block mb-1">Value / Content</span>
                            <code className="font-bold break-all select-all">{dnsData.txtValue}</code>
                        </div>
                    </div>

                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={handleDNSCheck}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
                        >
                            <i className="fa-solid fa-rotate-right mr-2"></i>
                            Check Propagation
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-200 flex items-start gap-3">
                    <i className="fa-solid fa-circle-exclamation mt-1"></i>
                    <div>
                        <h4 className="font-bold">Provisioning Failed</h4>
                        <p>{error}</p>
                    </div>
                </div>
            )}

            <div className="flex justify-end">
                {status !== "step1_dns" && (
                    <button
                        onClick={handleProvision}
                        disabled={status === "loading" || !domain || !email}
                        className={`px-6 py-3 rounded-xl font-bold flex items-center gap-2 text-white ${status === "loading" || !domain || !email
                            ? "bg-gray-300 cursor-not-allowed"
                            : "bg-blue-600 hover:bg-blue-700 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 transition-all"
                            }`}
                    >
                        {status === "loading" ? (
                            <><i className="fa-solid fa-circle-notch fa-spin"></i> Processing...</>
                        ) : (
                            "Start Provisioning"
                        )}
                    </button>
                )}
            </div>
        </div>
    );
}
