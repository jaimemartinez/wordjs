"use client";

import { useI18n } from "@/contexts/I18nContext";
import Link from "next/link";
import SSLCertManager from "./SSLCertManager";
import AutoRenewalPanel from "./AutoRenewalPanel";
import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";

export default function SecurityPage() {
    useI18n();
    const [adminEmail, setAdminEmail] = useState("");

    useEffect(() => {
        // Fetch admin email to pre-fill
        settingsApi.get().then(data => {
            if (data.admin_email) setAdminEmail(data.admin_email);
        });
    }, []);

    return (
        <div className="relative min-h-full w-full overflow-hidden bg-gray-50 dark:bg-gray-900 transition-colors duration-500">
            {/* Animated Background */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none">
                <div className="absolute top-[-10%] right-[10%] w-96 h-96 bg-blue-300/30 rounded-full mix-blend-multiply filter blur-3xl opacity-60 animate-blob"></div>
                <div className="absolute bottom-[-10%] left-[10%] w-96 h-96 bg-indigo-300/30 rounded-full mix-blend-multiply filter blur-3xl opacity-60 animate-blob animation-delay-2000"></div>
                <div className="absolute top-[30%] left-[40%] w-80 h-80 bg-cyan-300/30 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob animation-delay-4000"></div>
            </div>

            <div className="relative z-10 w-full max-w-5xl mx-auto px-6 py-10 h-full overflow-y-auto custom-scrollbar">

                <div className="mb-10 text-center md:text-left animate-in slide-in-bottom fade-in duration-700">
                    <h1 className="text-4xl font-bold text-gray-800 dark:text-white mb-3 font-oswald tracking-wide flex items-center justify-center md:justify-start gap-4">
                        <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-2xl shadow-sm">
                            <i className="fa-solid fa-shield-halved text-blue-600 dark:text-blue-400"></i>
                        </div>
                        Security Center
                    </h1>
                    <p className="text-gray-600 dark:text-gray-300 text-lg max-w-2xl">
                        Manage your site&apos;s SSL certificates, encryption protocols, and gateway configuration to ensure maximum security.
                    </p>
                </div>

                <div className="space-y-8 animate-in slide-in-bottom fade-in duration-700 delay-150">
                    {/* SSL / HTTPS Settings Section */}
                    <div className="glass-panel rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-blue-500 transition-all hover:shadow-blue-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
                                <i className="fa-solid fa-lock text-emerald-500 text-xl"></i>
                                SSL / HTTPS Configuration
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 space-y-8 bg-white/40 dark:bg-black/20">

                            <div className="bg-blue-50/50 dark:bg-blue-900/10 rounded-2xl border border-blue-100 dark:border-blue-800 p-8 shadow-inner">
                                <div className="flex items-start gap-4 mb-6">
                                    <div className="bg-blue-100 dark:bg-blue-800 text-blue-600 dark:text-blue-200 w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
                                        <i className="fa-solid fa-certificate"></i>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">Certificate Management</h3>
                                        <p className="text-sm text-gray-600 dark:text-gray-400">
                                            Provision a free Let&apos;s Encrypt certificate automatically, manually verify via DNS, or upload your own custom certificate files.
                                        </p>
                                    </div>
                                </div>
                                <SSLCertManager
                                    adminEmail={adminEmail}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Auto-Renewal (ACME) Section */}
                    <div className="glass-panel rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-amber-500 transition-all hover:shadow-amber-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
                                <i className="fa-solid fa-arrows-rotate text-amber-500 text-xl"></i>
                                Automatic Certificate Renewal
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 bg-white/40 dark:bg-black/20">
                            <AutoRenewalPanel adminEmail={adminEmail} />
                        </div>
                    </div>

                    {/* Gateway Configuration */}
                    <div className="glass-panel rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-indigo-500 transition-all hover:shadow-indigo-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
                                <i className="fa-solid fa-server text-indigo-500 text-xl"></i>
                                Gateway Configuration
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 bg-white/40 dark:bg-black/20">
                            <GatewayConfigForm />
                        </div>
                    </div>

                    {/* Two-Factor Enforcement Policy */}
                    <div className="glass-panel rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-emerald-500 transition-all hover:shadow-emerald-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
                                <i className="fa-solid fa-shield-halved text-emerald-500 text-xl"></i>
                                Two-Factor Enforcement
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 bg-white/40 dark:bg-black/20">
                            <MfaPolicyForm />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

import { apiGet, apiPost } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";

function GatewayConfigForm() {
    const [config, setConfig] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const { alert } = useModal();

    useEffect(() => {
        setLoading(true);
        const load = async () => {
            try {
                // 1. Get Config
                let data = await apiGet<any>('/system/certs/config?t=' + Date.now());

                // 2. If valid response but no cert, try to auto-generate (Self-Signed) via check.
                // Skip in monolith mode: /check pushes a cert to the (nonexistent) gateway and would
                // fail — mono manages its own cert at boot, so there is nothing to generate here.
                if (data && data.source !== 'monolith' && (!data.certInfo || data.certInfo.type === 'none')) {
                    await apiPost('/system/certs/check', {});
                    // Reload config
                    data = await apiGet<any>('/system/certs/config?t=' + Date.now());
                }
                setConfig(data);
            } catch (err: any) {
                setConfig({ error: err.message });
            } finally {
                setLoading(false);
            }
        };
        load();
    }, []);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            await apiPost('/system/certs/config', {
                port: config.gatewayPort,
                sslEnabled: config.sslEnabled
            });
            await alert('Settings saved. You may need to restart the gateway.');
        } catch (e: any) {
            await alert('Failed to save settings: ' + e.message);
        } finally {
            setSaving(false);
        }
    };

    if (loading || !config) return (
        <div className="text-center py-12">
            <i className="fa-solid fa-circle-notch fa-spin text-3xl text-indigo-500 mb-4"></i>
            <p className="text-gray-500 font-medium">Loading Gateway Configuration...</p>
        </div>
    );

    if (config.error) {
        return (
            <div className="p-6 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-2xl border border-red-100 dark:border-red-800 flex items-start gap-4">
                <i className="fa-solid fa-triangle-exclamation text-2xl mt-1"></i>
                <div>
                    <h3 className="font-bold text-lg mb-1">Error Loading Configuration</h3>
                    <p className="text-sm opacity-90">{config.error}</p>
                    <button onClick={() => window.location.reload()} className="text-sm font-bold underline mt-3 hover:text-red-800 dark:hover:text-red-300">Retry Connection</button>
                </div>
            </div>
        );
    }

    // Monolith mode: a single process serves the site — there is no separate gateway to reconfigure at
    // runtime. Present the live port + TLS state as read-only, with the current certificate, and explain
    // where these are actually set (env / config at startup) instead of showing an editable form whose
    // Save would try to reach a gateway that isn't running.
    if (config.source === 'monolith') {
        const ci = config.certInfo || {};
        return (
            <div className="space-y-6">
                <div className="p-5 bg-indigo-50/70 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-800 flex items-start gap-4">
                    <i className="fa-solid fa-circle-info text-xl text-indigo-500 mt-0.5"></i>
                    <div className="text-sm text-indigo-900/90 dark:text-indigo-200">
                        <h3 className="font-bold text-base mb-1">Monolith mode</h3>
                        <p className="opacity-90 leading-relaxed">
                            One process serves the whole site, so there&apos;s no separate gateway to configure here.
                            The port and TLS are set at startup (the <code className="font-mono text-xs bg-white/60 dark:bg-black/30 px-1.5 py-0.5 rounded">PORT</code> and{" "}
                            <code className="font-mono text-xs bg-white/60 dark:bg-black/30 px-1.5 py-0.5 rounded">WORDJS_HTTP</code> env vars, or{" "}
                            <code className="font-mono text-xs bg-white/60 dark:bg-black/30 px-1.5 py-0.5 rounded">gateway-config.json</code>) and take effect on restart. Live changes and ACME are available in split / gateway deployments.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="p-4 bg-gray-50 dark:bg-gray-800/60 rounded-2xl border border-gray-100 dark:border-gray-700">
                        <span className="block text-xs uppercase tracking-wider text-gray-400 font-bold mb-1">Public Port</span>
                        <span className="font-mono font-bold text-gray-800 dark:text-gray-200 text-lg">:{config.gatewayPort ?? 3000}</span>
                    </div>
                    <div className="p-4 bg-gray-50 dark:bg-gray-800/60 rounded-2xl border border-gray-100 dark:border-gray-700 flex items-center justify-between">
                        <div>
                            <span className="block text-xs uppercase tracking-wider text-gray-400 font-bold mb-1">TLS</span>
                            <span className={`font-bold ${config.sslEnabled ? 'text-emerald-600' : 'text-gray-500'}`}>
                                {config.sslEnabled ? 'HTTPS enabled' : 'HTTP (no TLS)'}
                            </span>
                        </div>
                        <i className={`fa-solid ${config.sslEnabled ? 'fa-lock text-emerald-500' : 'fa-lock-open text-gray-400'} text-xl`}></i>
                    </div>
                </div>

                <div className="bg-gradient-to-br from-indigo-50/80 to-purple-50/80 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-800 p-6 shadow-sm">
                    <h4 className="text-sm font-bold text-indigo-900 dark:text-indigo-300 mb-4 flex items-center gap-2 uppercase tracking-wide">
                        <i className="fa-solid fa-certificate"></i> Current Active Certificate
                    </h4>
                    {ci.commonName ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 text-sm">
                            <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Domain</span>
                                <span className="font-bold text-gray-800 dark:text-gray-200 truncate block" title={ci.commonName}>{ci.commonName}</span>
                            </div>
                            <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Issuer</span>
                                <span className="font-medium text-gray-700 dark:text-gray-300 truncate block" title={ci.issuer}>{ci.issuer}</span>
                            </div>
                            <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Expiry</span>
                                <span className={`font-bold ${ci.validTo && new Date(ci.validTo) < new Date() ? 'text-red-600' : 'text-emerald-600'}`}>
                                    {ci.validTo ? new Date(ci.validTo).toLocaleDateString() : '-'}
                                </span>
                            </div>
                            <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Type</span>
                                <span className={`font-bold capitalize ${ci.type === 'letsencrypt' ? 'text-blue-600' : 'text-gray-700 dark:text-gray-300'}`}>{ci.type}</span>
                            </div>
                        </div>
                    ) : (
                        <p className="text-gray-500 dark:text-gray-400 font-medium italic">{ci.message || 'No certificate details available.'}</p>
                    )}
                </div>
            </div>
        );
    }

    return (
        <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {config.certInfo && (
                <div className="md:col-span-2 bg-gradient-to-br from-indigo-50/80 to-purple-50/80 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-800 p-6 shadow-sm">
                    <h4 className="text-sm font-bold text-indigo-900 dark:text-indigo-300 mb-4 flex items-center gap-2 uppercase tracking-wide">
                        <i className="fa-solid fa-certificate"></i> Current Active Certificate
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 text-sm">
                        {config.certInfo.error ? (
                            <div className="col-span-4 text-red-500 font-medium bg-red-50 p-4 rounded-xl border border-red-100">Error: {config.certInfo.error}</div>
                        ) : config.certInfo.message ? (
                            <div className="col-span-4 text-gray-500 font-medium italic">{config.certInfo.message}</div>
                        ) : config.certInfo.commonName ? (
                            <>
                                <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Domain</span>
                                    <span className="font-bold text-gray-800 dark:text-gray-200 truncate block" title={config.certInfo.commonName}>{config.certInfo.commonName}</span>
                                </div>
                                <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Issuer</span>
                                    <span className="font-medium text-gray-700 dark:text-gray-300 truncate block" title={config.certInfo.issuer}>{config.certInfo.issuer}</span>
                                </div>
                                <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Expiry</span>
                                    <span className={`font-bold ${config.certInfo.validTo && new Date(config.certInfo.validTo) < new Date() ? 'text-red-600' : 'text-emerald-600'}`}>
                                        {config.certInfo.validTo ? new Date(config.certInfo.validTo).toLocaleDateString() : '-'}
                                    </span>
                                </div>
                                <div className="p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-indigo-50 dark:border-indigo-900/50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">Type</span>
                                    <span className={`font-bold capitalize ${config.certInfo.type === 'letsencrypt' ? 'text-blue-600' : 'text-gray-700 dark:text-gray-300'}`}>
                                        {config.certInfo.type}
                                    </span>
                                </div>
                            </>
                        ) : (
                            <div className="col-span-4 text-gray-400 italic text-center py-2">No active certificate details found</div>
                        )}
                    </div>
                </div>
            )}

            <div className="space-y-3">
                <label className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Gateway Port</label>
                <div className="relative">
                    <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 font-bold">:</span>
                    <input
                        type="number"
                        value={config.gatewayPort ?? 3000}
                        onChange={e => setConfig({ ...config, gatewayPort: e.target.value })}
                        className="w-full pl-8 pr-4 py-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all font-mono text-gray-800 dark:text-gray-200"
                        placeholder="3000"
                    />
                </div>
                <p className="text-xs text-gray-500 ml-1">Default: 3000. Changing this requires a gateway restart.</p>
            </div>

            <div className="p-6 bg-emerald-50 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-800 flex items-center justify-between gap-6 group hover:bg-emerald-100/50 dark:hover:bg-emerald-900/20 transition-all cursor-pointer shadow-sm" onClick={() => setConfig({ ...config, sslEnabled: !config.sslEnabled })}>
                <div className="flex gap-4 items-center">
                    <div className="bg-white dark:bg-emerald-800/50 p-3 rounded-xl shadow-sm border border-emerald-200 dark:border-emerald-700 text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">
                        <i className={`fa-solid ${config.sslEnabled ? 'fa-lock' : 'fa-lock-open'} text-xl`}></i>
                    </div>
                    <div>
                        <h4 className="text-base font-bold text-gray-900 dark:text-white">Enable SSL / HTTPS</h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Force secure connections globally.</p>
                    </div>
                </div>
                <div
                    className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${config.sslEnabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-700'}`}
                >
                    <span
                        className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform duration-200 ease-in-out shadow-md ${config.sslEnabled ? 'translate-x-7' : 'translate-x-1'}`}
                    />
                </div>
            </div>

            <div className="md:col-span-2 flex justify-end pt-4 border-t border-gray-100 dark:border-gray-800">
                <button
                    type="submit"
                    disabled={saving}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold text-lg px-10 py-4 rounded-xl transition-all shadow-xl shadow-indigo-200 dark:shadow-none hover:shadow-2xl transform hover:-translate-y-1 active:translate-y-0"
                >
                    {saving ? (
                        <span className="flex items-center gap-2">
                            <i className="fa-solid fa-circle-notch fa-spin"></i> Saving...
                        </span>
                    ) : (
                        <span className="flex items-center gap-2">
                            <i className="fa-solid fa-floppy-disk"></i> Save Configuration
                        </span>
                    )}
                </button>
            </div>
        </form>
    );
}

import { mfaApi, rolesApi, type Role } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";

// Admin editor for the MFA-by-role enforcement policy: pick which roles must have 2FA + a grace period.
function MfaPolicyForm() {
    const { addToast } = useToast();
    const { user } = useAuth();
    const [roles, setRoles] = useState<Record<string, Role>>({});
    const [required, setRequired] = useState<string[]>([]);
    const [graceDays, setGraceDays] = useState(7);
    const [enforceForApiTokens, setEnforceForApiTokens] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const [rolesData, { policy }] = await Promise.all([rolesApi.list(), mfaApi.getPolicy()]);
                setRoles(rolesData);
                setRequired(policy.requiredRoles || []);
                setGraceDays(typeof policy.graceDays === "number" ? policy.graceDays : 7);
                setEnforceForApiTokens(policy.enforceForApiTokens === true);
            } catch (e: any) {
                addToast(e?.message || "Failed to load the MFA policy", "error");
            } finally {
                setLoading(false);
            }
        })();
    }, [addToast]);

    const toggle = (slug: string) =>
        setRequired((prev) => (prev.includes(slug) ? prev.filter((r) => r !== slug) : [...prev, slug]));

    const save = async () => {
        setSaving(true);
        try {
            const { policy } = await mfaApi.savePolicy({
                requiredRoles: required,
                graceDays: Number(graceDays) || 0,
                enforceForApiTokens,
            });
            setRequired(policy.requiredRoles);
            setEnforceForApiTokens(policy.enforceForApiTokens === true);
            addToast(policy.requiredRoles.length ? "Two-factor enforcement updated" : "Two-factor enforcement disabled", "success");
        } catch (e: any) {
            addToast(e?.message || "Failed to save the MFA policy", "error");
        } finally {
            setSaving(false);
        }
    };

    // Warn when the admin is about to require 2FA for their OWN role without having it enabled — after the
    // grace period they'd be forced into the enrolment screen.
    const selfAtRisk = user?.role != null && required.includes(user.role) && user.mfa?.enabled === false;

    if (loading) return <p className="text-gray-500 font-medium">Loading policy…</p>;

    return (
        <div className="space-y-6">
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                Require members of the selected roles to enable two-factor authentication. They get a grace
                window to enrol, after which they&apos;re blocked from the dashboard until 2FA is on. Leave all
                roles unchecked to turn enforcement off.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {Object.entries(roles).map(([slug, role]) => {
                    const on = required.includes(slug);
                    return (
                        <button
                            type="button"
                            key={slug}
                            onClick={() => toggle(slug)}
                            aria-pressed={on}
                            className={`flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border-2 text-left transition-all ${on
                                ? "border-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/10"
                                : "border-gray-200 dark:border-gray-700 hover:border-gray-300 bg-white/40 dark:bg-black/10"}`}
                        >
                            <span>
                                <span className="block font-bold text-gray-800 dark:text-gray-100">{role.name || slug}</span>
                                <span className="block text-[11px] font-mono text-gray-400">{slug}</span>
                            </span>
                            <i className={`fa-solid ${on ? "fa-circle-check text-emerald-500" : "fa-circle text-gray-300"} text-lg`}></i>
                        </button>
                    );
                })}
            </div>

            <label className="flex items-start gap-3 px-4 py-3 rounded-2xl border-2 border-gray-200 dark:border-gray-700 bg-white/40 dark:bg-black/10 cursor-pointer">
                <input
                    type="checkbox"
                    checked={enforceForApiTokens}
                    onChange={(e) => setEnforceForApiTokens(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-emerald-600"
                />
                <span>
                    <span className="block font-bold text-gray-800 dark:text-gray-100">Also enforce for personal API tokens</span>
                    <span className="block text-[11px] text-gray-400 mt-0.5">
                        Blocks <code>Bearer wjt_…</code> tokens whose owner is in a selected role and hasn&apos;t enrolled — including
                        tokens minted before this policy. A token can&apos;t answer a 2FA challenge, so the fix is for its owner to
                        enrol (or for the token to be revoked). Off by default.
                    </span>
                </span>
            </label>

            <div className="flex flex-wrap items-end gap-4">
                <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Grace period (days)</label>
                    <input
                        type="number"
                        min={0}
                        value={graceDays}
                        onChange={(e) => setGraceDays(Math.max(0, Number(e.target.value)))}
                        className="w-40 px-4 py-3 bg-white/60 dark:bg-black/20 border-2 border-gray-200 dark:border-gray-700 rounded-2xl focus:ring-4 focus:ring-emerald-100 focus:border-emerald-500 outline-none font-bold"
                    />
                    <p className="text-[11px] text-gray-400 mt-1.5">0 = enforce immediately.</p>
                </div>
                <button
                    onClick={save}
                    disabled={saving}
                    className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg shadow-emerald-500/25 transition-all disabled:opacity-50"
                >
                    {saving ? "Saving…" : "Save policy"}
                </button>
            </div>

            {selfAtRisk && (
                <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-2xl px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                    <i className="fa-solid fa-triangle-exclamation mt-0.5"></i>
                    <span>
                        Your role (<strong>{roles[user!.role]?.name || user!.role}</strong>) is selected and you don&apos;t have 2FA enabled.
                        Once the grace period ends you&apos;ll be required to enrol before using the dashboard.{" "}
                        <Link href="/admin/account" className="font-bold underline underline-offset-2">Enable it now</Link>.
                    </span>
                </div>
            )}
        </div>
    );
}
