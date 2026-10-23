"use client";

import { useI18n } from "@/contexts/I18nContext";
import { Button, Checkbox, Input, PageHeader, UnstyledButton } from "@/components/ui";
import Link from "next/link";
import SSLCertManager from "./SSLCertManager";
import AutoRenewalPanel from "./AutoRenewalPanel";
import ServerSettingsPanel from "./ServerSettingsPanel";
import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { useOptionalAuth } from "@/contexts/AuthContext";

export default function SecurityPage() {
    const { t } = useI18n();
    const [adminEmail, setAdminEmail] = useState("");
    const viewerNetwork = useOptionalAuth()?.user?.network;
    const certsOffered = !viewerNetwork || (viewerNetwork.mainSite && viewerNetwork.networkAdmin);

    useEffect(() => {
        // Fetch admin email to pre-fill
        settingsApi.get().then(data => {
            if (data.admin_email) setAdminEmail(data.admin_email);
        });
    }, []);

    return (
        <div className="relative min-h-full w-full overflow-hidden bg-gray-50 transition-colors duration-500">
            {/* Animated Background */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none">
                <div className="absolute top-[-10%] right-[10%] w-96 h-96 bg-blue-300/30 rounded-full mix-blend-multiply filter blur-3xl opacity-60 animate-blob"></div>
                <div className="absolute bottom-[-10%] left-[10%] w-96 h-96 bg-indigo-300/30 rounded-full mix-blend-multiply filter blur-3xl opacity-60 animate-blob animation-delay-2000"></div>
                <div className="absolute top-[30%] left-[40%] w-80 h-80 bg-cyan-300/30 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-blob animation-delay-4000"></div>
            </div>

            <div className="relative z-10 w-full max-w-5xl mx-auto px-6 py-10 h-full overflow-y-auto custom-scrollbar">

                {/* The shared header (QA M1-12: centred and oversized on a phone, its own font). */}
                <PageHeader title={t('security.title')} subtitle={t('security.intro')} icon="fa-shield-halved" />

                <div className="space-y-8 animate-in slide-in-bottom fade-in duration-700 delay-150">
                    {/* Multisite: certificates and the gateway are the network's — a network administrator on the
                        main site manages them (the server refuses everyone else). A single site is unchanged. */}
                    {certsOffered && (<>
                    {/* SSL / HTTPS Settings Section */}
                    <div className="glass-panel rounded-3xl md:rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-blue-500 transition-all hover:shadow-blue-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-3">
                                <i className="fa-solid fa-lock text-emerald-500 text-xl"></i>
                                {t('security.ssl.title')}
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 space-y-8 bg-white/40">

                            <div className="bg-blue-50/50 rounded-2xl border border-blue-100 p-8 shadow-inner">
                                <div className="flex items-start gap-4 mb-6">
                                    <div className="bg-blue-100 text-blue-600 w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
                                        <i className="fa-solid fa-certificate"></i>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-gray-900 mb-1">{t('security.certManagement.title')}</h3>
                                        <p className="text-sm text-gray-600">
                                            {t('security.certManagement.description')}
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
                    <div id="ssl-auto-renewal" className="scroll-mt-24 glass-panel rounded-3xl md:rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-amber-500 transition-all hover:shadow-amber-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-3">
                                <i className="fa-solid fa-arrows-rotate text-amber-500 text-xl"></i>
                                {t('security.autoRenewal.title')}
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 bg-white/40">
                            <AutoRenewalPanel adminEmail={adminEmail} />
                        </div>
                    </div>

                    {/* Gateway Configuration */}
                    <div className="glass-panel rounded-3xl md:rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-indigo-500 transition-all hover:shadow-indigo-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-3">
                                <i className="fa-solid fa-server text-indigo-500 text-xl"></i>
                                {t('security.gateway.title')}
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 bg-white/40">
                            <GatewayConfigForm />
                        </div>
                    </div>

                    {/* Server: reverse-proxy trust and log level, from the panel instead of the config file */}
                    <div className="glass-panel rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-sky-500 transition-all hover:shadow-sky-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-3">
                                <i className="fa-solid fa-network-wired text-sky-500 text-xl"></i>
                                {t('server.title')}
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 bg-white/40">
                            <ServerSettingsPanel />
                        </div>
                    </div>

                    </>)}

                    {/* Two-Factor Enforcement Policy */}
                    <div className="glass-panel rounded-3xl md:rounded-[40px] shadow-2xl overflow-hidden border-t-4 border-emerald-500 transition-all hover:shadow-emerald-900/10">
                        <div className="px-8 py-6 border-b border-gray-100/50 bg-white/40 backdrop-blur-md">
                            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-3">
                                <i className="fa-solid fa-shield-halved text-emerald-500 text-xl"></i>
                                {t('security.mfa.title')}
                            </h2>
                        </div>
                        <div className="p-8 md:p-10 bg-white/40">
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
import { useRouter } from "next/navigation";
import { afterGatewayConfigSave, edgeKey, type EdgeKind } from "@/lib/siteAddress";
import { gatewayServingNotice, gatewayNeedsCertificate } from "@/lib/gatewayServing";

// The certificate box's note, by the code the backend sends with it; an unknown code (or none, from an older
// backend) shows the backend's own English text.
function certInfoMessage(info: { code?: string; message?: string }, t: (key: string) => string): string {
    switch (info.code) {
        case 'plain-http': return t('security.cert.plainHttp');
        case 'plain-http-env': return t('security.cert.plainHttpEnv');
        case 'cert-missing': return t('security.cert.missing');
        case 'cert-unreadable': return t('security.cert.unreadable');
        default: return info.message || '';
    }
}

function GatewayConfigForm() {
    const [config, setConfig] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const { t } = useI18n();

    const { alert, confirm } = useModal();
    const router = useRouter();
    // The switch as the gateway reported it when the screen loaded: a save that flips it asks first.
    const [savedSsl, setSavedSsl] = useState<boolean | null>(null);
    const [generating, setGenerating] = useState(false);
    // The configuration as the gateway reported it: the warning above the form describes the gateway,
    // never the switch the administrator is still editing.
    const [reported, setReported] = useState<any>(null);

    // Reading the gateway's configuration is ALL this screen does on load. It used to POST
    // /system/certs/check whenever no certificate was reported, which generated a self-signed certificate
    // and switched a gateway serving HTTP behind a proxy or tunnel to HTTPS - opening a screen took the
    // site down (FALLOS 114). Generating one is now the button below, shown when it is needed.
    const load = async () => {
        try {
            const data = await apiGet<any>('/system/certs/config?t=' + Date.now());
            setConfig(data);
            setReported(data);
            setSavedSsl(data && typeof data.sslEnabled === 'boolean' ? data.sslEnabled : null);
        } catch (err: any) {
            setConfig({ error: err.message });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        load();
    }, []);

    const generateSelfSigned = async () => {
        setGenerating(true);
        try {
            await apiPost('/system/certs/check', {});
            await load();
        } catch (e: any) {
            await alert(t('security.gateway.generateFailed').replace('{error}', () => e.message));
        } finally {
            setGenerating(false);
        }
    };

    // What answers on the public port. A monolith has no gateway: its dialogs and notices say "the server".
    const edge: EdgeKind = config?.source === 'monolith' ? 'server' : 'gateway';

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        // Changing the protocol the gateway speaks can cut off whatever sits in front of it (a proxy or a
        // tunnel speaking the other one), so it is never a silent side effect of "Save".
        if (savedSsl !== null && !!config.sslEnabled !== savedSsl) {
            const ok = await confirm(
                t(edgeKey(config.sslEnabled ? 'security.gateway.confirmTransportOn' : 'security.gateway.confirmTransportOff', edge)),
                t(edgeKey('security.gateway.confirmTitle', edge)),
                true,
            );
            if (!ok) return;
        }
        setSaving(true);
        try {
            const saved = await apiPost<unknown>('/system/certs/config', {
                port: config.gatewayPort,
                sslEnabled: config.sslEnabled
            });
            const transportChanged = savedSsl !== null && !!config.sslEnabled !== savedSsl;
            setSavedSsl(!!config.sslEnabled);
            // What the gateway serves now, for the warning and the "serving now" line. Not after a protocol
            // change: this page was loaded over the protocol the gateway no longer speaks.
            if (!transportChanged) await load();
            // The answer also says what the change did to the site's main address: followed at once
            // (same host, http → https) or only suggested — then the admin decides on the
            // site-address screen, which opens the change dialog prefilled (SPEC §6, REDTEAM R1).
            await afterGatewayConfigSave(saved, { alert, navigate: (href) => router.push(href), t, edge });
        } catch (e: any) {
            await alert(t('security.gateway.saveFailed').replace('{error}', () => e.message));
        } finally {
            setSaving(false);
        }
    };

    if (loading || !config) return (
        <div className="text-center py-12">
            <i className="fa-solid fa-circle-notch fa-spin text-3xl text-indigo-500 mb-4"></i>
            <p className="text-gray-500 font-medium">{t('security.gateway.loading')}</p>
        </div>
    );

    if (config.error) {
        return (
            <div className="p-6 bg-red-50 text-red-600 rounded-2xl border border-red-100 flex items-start gap-4">
                <i className="fa-solid fa-triangle-exclamation text-2xl mt-1"></i>
                <div>
                    <h3 className="font-bold text-lg mb-1">{t('security.gateway.loadError')}</h3>
                    <p className="text-sm opacity-90">{config.error}</p>
                    <Button variant="link" className="mt-3" onClick={() => window.location.reload()}>{t('security.gateway.retry')}</Button>
                </div>
            </div>
        );
    }

    // Monolith mode: a single process serves the site — there is no separate gateway to reconfigure at
    // runtime. Present the live port + TLS state as read-only, with the current certificate, and explain
    // where these are actually set (env / config at startup) instead of showing an editable form whose
    // Save would try to reach a gateway that isn't running.
    // A monolith is edited here like the gateway (QA M2-15): saving restarts WordJS by itself. Only a value
    // the service's environment pins (PORT, WORDJS_HTTP=1) is shown read-only; both pinned = nothing to edit.
    const monolith = config.source === 'monolith';
    const pinnedPort = monolith && config.pinned?.port === true;
    const pinnedTls = monolith && config.pinned?.tls === true;
    if (monolith && pinnedPort && pinnedTls) {
        const ci = config.certInfo || {};
        return (
            <div className="space-y-6">
                <div className="p-5 bg-indigo-50/70 rounded-2xl border border-indigo-100 flex items-start gap-4">
                    <i className="fa-solid fa-circle-info text-xl text-indigo-500 mt-0.5"></i>
                    <div className="text-sm text-indigo-900/90">
                        <h3 className="font-bold text-base mb-1">{t('security.monolith.title')}</h3>
                        <p className="opacity-90 leading-relaxed">
                            {t('security.monolith.intro')} <code className="font-mono text-xs bg-white/60 px-1.5 py-0.5 rounded">PORT</code> {t('security.monolith.and')}{" "}
                            <code className="font-mono text-xs bg-white/60 px-1.5 py-0.5 rounded">WORDJS_HTTP</code> {t('security.monolith.envVarsOr')}{" "}
                            <code className="font-mono text-xs bg-white/60 px-1.5 py-0.5 rounded">gateway-config.json</code>{t('security.monolith.outro')}
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100">
                        <span className="block text-xs uppercase tracking-wider text-gray-400 font-bold mb-1">{t('security.gateway.publicPort')}</span>
                        <span className="font-mono font-bold text-gray-800 text-lg">:{config.gatewayPort ?? 3000}</span>
                    </div>
                    <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 flex items-center justify-between">
                        <div>
                            <span className="block text-xs uppercase tracking-wider text-gray-400 font-bold mb-1">TLS</span>
                            <span className={`font-bold ${config.sslEnabled ? 'text-emerald-600' : 'text-gray-500'}`}>
                                {config.sslEnabled ? t('security.gateway.httpsEnabled') : t('security.gateway.httpNoTls')}
                            </span>
                        </div>
                        <i className={`fa-solid ${config.sslEnabled ? 'fa-lock text-emerald-500' : 'fa-lock-open text-gray-400'} text-xl`}></i>
                    </div>
                </div>

                <div className="bg-gradient-to-br from-indigo-50/80 to-purple-50/80 rounded-2xl border border-indigo-100 p-6 shadow-sm">
                    <h4 className="text-sm font-bold text-indigo-900 mb-4 flex items-center gap-2 uppercase tracking-wide">
                        <i className="fa-solid fa-certificate"></i> {t('security.cert.current')}
                    </h4>
                    {ci.commonName ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 text-sm">
                            <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.domain')}</span>
                                <span className="font-bold text-gray-800 truncate block" title={ci.commonName}>{ci.commonName}</span>
                            </div>
                            <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.issuer')}</span>
                                <span className="font-medium text-gray-700 truncate block" title={ci.issuer}>{ci.issuer}</span>
                            </div>
                            <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.expiry')}</span>
                                <span className={`font-bold ${ci.validTo && new Date(ci.validTo) < new Date() ? 'text-red-600' : 'text-emerald-600'}`}>
                                    {ci.validTo ? new Date(ci.validTo).toLocaleDateString() : '-'}
                                </span>
                            </div>
                            <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.type')}</span>
                                <span className={`font-bold capitalize ${ci.type === 'letsencrypt' ? 'text-blue-600' : 'text-gray-700'}`}>{ci.type}</span>
                            </div>
                        </div>
                    ) : (
                        <p className="text-gray-500 font-medium italic">{ci.message || t('security.cert.noDetails')}</p>
                    )}
                </div>
            </div>
        );
    }

    // What visitors actually get (the workers' own report), next to the switch (QA X1-03).
    const notice = gatewayServingNotice(reported);
    const needsCertificate = gatewayNeedsCertificate(reported);

    return (
        <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {monolith && (
                <div data-testid="gateway-monolith-note" className="md:col-span-2 p-5 bg-indigo-50/70 rounded-2xl border border-indigo-100 flex items-start gap-4 text-sm text-indigo-900/90">
                    <i className="fa-solid fa-circle-info text-xl text-indigo-500 mt-0.5"></i>
                    <div>
                        <h3 className="font-bold text-base mb-1">{t('security.monolith.title')}</h3>
                        <p className="opacity-90 leading-relaxed">{t('security.monolith.editable')}</p>
                    </div>
                </div>
            )}
            {notice && (
                <div role="status" data-testid="gateway-serving-notice" className="md:col-span-2 p-5 bg-amber-50 rounded-2xl border border-amber-200 flex items-start gap-4">
                    <i className="fa-solid fa-triangle-exclamation text-xl text-amber-600 mt-0.5"></i>
                    <div className="text-sm text-amber-900 space-y-3">
                        <p>{t(notice)}</p>
                        {needsCertificate && (
                            <Button size="md" icon="fa-certificate" onClick={generateSelfSigned} pending={generating}>
                                {t('security.gateway.generateSelfSigned')}
                            </Button>
                        )}
                    </div>
                </div>
            )}
            {typeof reported?.serving === 'string' && (
                <div className="md:col-span-2 text-sm text-gray-600 flex items-center gap-2" data-testid="gateway-serving">
                    <span className="text-xs uppercase tracking-wider text-gray-400 font-bold">{t('security.gateway.servingNow')}</span>
                    <span className={`font-bold ${reported.serving === 'https' ? 'text-emerald-600' : 'text-gray-700'}`}>
                        {reported.serving === 'https' ? t('security.gateway.httpsEnabled') : reported.serving === 'http' ? t('security.gateway.httpNoTls') : t('security.gateway.servingReloading')}
                    </span>
                </div>
            )}
            {config.certInfo && (
                <div className="md:col-span-2 bg-gradient-to-br from-indigo-50/80 to-purple-50/80 rounded-2xl border border-indigo-100 p-6 shadow-sm">
                    <h4 className="text-sm font-bold text-indigo-900 mb-4 flex items-center gap-2 uppercase tracking-wide">
                        <i className="fa-solid fa-certificate"></i> {t('security.cert.current')}
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 text-sm">
                        {config.certInfo.error ? (
                            <div className="col-span-4 text-red-500 font-medium bg-red-50 p-4 rounded-xl border border-red-100">{t('ssl.log.error').replace('{error}', () => config.certInfo.error)}</div>
                        ) : config.certInfo.message ? (
                            <div className="col-span-4 text-gray-500 font-medium italic" data-testid="cert-info-message">{certInfoMessage(config.certInfo, t)}</div>
                        ) : config.certInfo.commonName ? (
                            <>
                                <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.domain')}</span>
                                    <span className="font-bold text-gray-800 truncate block" title={config.certInfo.commonName}>{config.certInfo.commonName}</span>
                                </div>
                                <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.issuer')}</span>
                                    <span className="font-medium text-gray-700 truncate block" title={config.certInfo.issuer}>{config.certInfo.issuer}</span>
                                </div>
                                <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.expiry')}</span>
                                    <span className={`font-bold ${config.certInfo.validTo && new Date(config.certInfo.validTo) < new Date() ? 'text-red-600' : 'text-emerald-600'}`}>
                                        {config.certInfo.validTo ? new Date(config.certInfo.validTo).toLocaleDateString() : '-'}
                                    </span>
                                </div>
                                <div className="p-3 bg-white/60 rounded-xl border border-indigo-50">
                                    <span className="block text-xs uppercase tracking-wider text-indigo-400 font-bold mb-1">{t('security.cert.type')}</span>
                                    <span className={`font-bold capitalize ${config.certInfo.type === 'letsencrypt' ? 'text-blue-600' : 'text-gray-700'}`}>
                                        {config.certInfo.type}
                                    </span>
                                </div>
                            </>
                        ) : (
                            <div className="col-span-4 text-gray-400 italic text-center py-2">{t('security.cert.noActiveDetails')}</div>
                        )}
                    </div>
                </div>
            )}

            <div className="space-y-3">
                <Input
                    id="security-gateway-port"
                    type="number"
                    label={t('security.gateway.port')}
                    help={t(pinnedPort ? 'security.monolith.portPinned' : monolith ? 'security.monolith.portHint' : 'security.gateway.portHint')}
                    disabled={pinnedPort}
                    value={config.gatewayPort ?? 3000}
                    onChange={e => setConfig({ ...config, gatewayPort: e.target.value })}
                    className="font-mono"
                    placeholder="3000"
                />
            </div>

            <div className="p-6 bg-emerald-50 rounded-2xl border border-emerald-100 flex items-center justify-between gap-6 group hover:bg-emerald-100/50 transition-all cursor-pointer shadow-sm" aria-disabled={pinnedTls} onClick={() => { if (!pinnedTls) setConfig({ ...config, sslEnabled: !config.sslEnabled }); }}>
                <div className="flex gap-4 items-center">
                    <div className="bg-white p-3 rounded-xl shadow-sm border border-emerald-200 text-emerald-600 group-hover:scale-110 transition-transform">
                        <i className={`fa-solid ${config.sslEnabled ? 'fa-lock' : 'fa-lock-open'} text-xl`}></i>
                    </div>
                    <div>
                        <h4 className="text-base font-bold text-gray-900">{t('security.gateway.enableSsl')}</h4>
                        <p className="text-xs text-gray-500 mt-1">{t(pinnedTls ? 'security.monolith.tlsPinned' : 'security.gateway.enableSslHint')}</p>
                    </div>
                </div>
                <div
                    className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${config.sslEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                >
                    <span
                        className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform duration-200 ease-in-out shadow-md ${config.sslEnabled ? 'translate-x-7' : 'translate-x-1'}`}
                    />
                </div>
            </div>

            <div className="md:col-span-2 flex justify-end pt-4 border-t border-gray-100">
                <Button type="submit" size="lg" icon="fa-floppy-disk" pending={saving} pendingLabel={t('settings.saving')}>
                    {t('security.gateway.save')}
                </Button>
            </div>
        </form>
    );
}

import { mfaApi, rolesApi, type Role, type MfaTokenExposure } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";

// Admin editor for the MFA-by-role enforcement policy: pick which roles must have 2FA + a grace period.
function MfaPolicyForm() {
    const { addToast } = useToast();
    const { user } = useAuth();
    const { t } = useI18n();
    const [roles, setRoles] = useState<Record<string, Role>>({});
    const [required, setRequired] = useState<string[]>([]);
    const [graceDays, setGraceDays] = useState(7);
    const [enforceForApiTokens, setEnforceForApiTokens] = useState(false);
    // The SAVED policy's answer about existing tokens — what the notice below reports.
    const [savedRoles, setSavedRoles] = useState<string[]>([]);
    const [savedEnforceTokens, setSavedEnforceTokens] = useState(false);
    const [exposure, setExposure] = useState<MfaTokenExposure | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const [rolesData, { policy, tokenExposure, enforceForApiTokensDefault }] = await Promise.all([rolesApi.list(), mfaApi.getPolicy()]);
                setRoles(rolesData);
                setRequired(policy.requiredRoles || []);
                setGraceDays(typeof policy.graceDays === "number" ? policy.graceDays : 7);
                // A freshly installed site that has never required a role starts with the switch ON; the
                // admin can still uncheck it before the first save. Everywhere else it shows what is stored.
                setEnforceForApiTokens(policy.enforceForApiTokens === true || enforceForApiTokensDefault === true);
                setSavedRoles(policy.requiredRoles || []);
                setSavedEnforceTokens(policy.enforceForApiTokens === true);
                setExposure(tokenExposure ?? null);
            } catch (e: any) {
                addToast(e?.message || t('security.mfa.loadFailed'), "error");
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
            const { policy, tokenExposure } = await mfaApi.savePolicy({
                requiredRoles: required,
                graceDays: Number(graceDays) || 0,
                enforceForApiTokens,
            });
            setRequired(policy.requiredRoles);
            setEnforceForApiTokens(policy.enforceForApiTokens === true);
            setSavedRoles(policy.requiredRoles);
            setSavedEnforceTokens(policy.enforceForApiTokens === true);
            setExposure(tokenExposure ?? null);
            addToast(policy.requiredRoles.length ? t('security.mfa.updated') : t('security.mfa.disabled'), "success");
        } catch (e: any) {
            addToast(e?.message || t('security.mfa.saveFailed'), "error");
        } finally {
            setSaving(false);
        }
    };

    // Warn when the admin is about to require 2FA for their OWN role without having it enabled — after the
    // grace period they'd be forced into the enrolment screen.
    const selfAtRisk = user?.role != null && required.includes(user.role) && user.mfa?.enabled === false;
    // The saved policy requires 2FA for some roles but leaves `wjt_` tokens exempt: say so, with numbers.
    const tokensExempt = savedRoles.length > 0 && !savedEnforceTokens;
    const exposed = exposure?.unenrolledOwnerTokens ?? 0;

    if (loading) return <p className="text-gray-500 font-medium">{t('security.mfa.loading')}</p>;

    return (
        <div className="space-y-6">
            <p className="text-sm text-gray-600 leading-relaxed">
                {t('security.mfa.intro')}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {Object.entries(roles).map(([slug, role]) => {
                    const on = required.includes(slug);
                    return (
                        <UnstyledButton
                            key={slug}
                            onClick={() => toggle(slug)}
                            aria-pressed={on}
                            className={`flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border-2 text-left transition-all ${on
                                ? "border-emerald-500 bg-emerald-50/60"
                                : "border-gray-200 hover:border-gray-300 bg-white/40"}`}
                        >
                            <span>
                                <span className="block font-bold text-gray-800">{role.name || slug}</span>
                                <span className="block text-[11px] font-mono text-gray-500">{slug}</span>
                            </span>
                            <i className={`fa-solid ${on ? "fa-circle-check text-emerald-500" : "fa-circle text-gray-400"} text-lg`} aria-hidden="true"></i>
                        </UnstyledButton>
                    );
                })}
            </div>

            <Checkbox
                checked={enforceForApiTokens}
                onChange={(e) => setEnforceForApiTokens(e.target.checked)}
                containerClassName="px-4 py-3 rounded-2xl border-2 border-gray-200 bg-white/40"
                label={t('security.mfa.enforceTokens')}
                help={<>{t('security.mfa.enforceTokensHelpBefore')} <code>Bearer wjt_…</code>{" "}{t('security.mfa.enforceTokensHelpAfter')}</>}
            />

            {tokensExempt && (
                <div
                    role="status"
                    data-testid="mfa-token-exemption-notice"
                    className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800"
                >
                    <i className="fa-solid fa-key mt-0.5"></i>
                    <span>
                        <strong>{t('security.mfa.tokensExempt')}</strong>{" "}
                        {exposed > 0 ? (
                            <>
                                {t(exposed === 1
                                    ? (exposure!.unenrolledOwners === 1 ? 'security.mfa.exposure.oneTokenOneOwner' : 'security.mfa.exposure.oneTokenManyOwners')
                                    : (exposure!.unenrolledOwners === 1 ? 'security.mfa.exposure.manyTokensOneOwner' : 'security.mfa.exposure.manyTokensManyOwners'))
                                    .replace('{tokens}', () => String(exposed))
                                    .replace('{owners}', () => String(exposure!.unenrolledOwners))}
                            </>
                        ) : (
                            <>{t('security.mfa.noExposure')}</>
                        )}{" "}
                        {t('security.mfa.turnOnHint').replace('{option}', () => t('security.mfa.enforceTokens'))}
                    </span>
                </div>
            )}

            <div className="flex flex-wrap items-end gap-4">
                <Input
                    id="security-mfa-grace-days"
                    size="md"
                    type="number"
                    min={0}
                    label={t('security.mfa.graceDays')}
                    help={t('security.mfa.graceHint')}
                    value={graceDays}
                    onChange={(e) => setGraceDays(Math.max(0, Number(e.target.value)))}
                    containerClassName="w-40"
                    className="font-bold"
                />
                <Button size="md" onClick={save} pending={saving} pendingLabel={t('common.saving')}>
                    {t('security.mfa.save')}
                </Button>
            </div>

            {selfAtRisk && (
                <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800">
                    <i className="fa-solid fa-triangle-exclamation mt-0.5"></i>
                    <span>
                        {t('security.mfa.selfRiskBefore')}<strong>{roles[user!.role]?.name || user!.role}</strong>{t('security.mfa.selfRiskAfter')}{" "}
                        <Link href="/admin/account" className="font-bold underline underline-offset-2">{t('security.mfa.enableNow')}</Link>.
                    </span>
                </div>
            )}
        </div>
    );
}
