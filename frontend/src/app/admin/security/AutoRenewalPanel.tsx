"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";

interface AcmeConfig {
    enabled: boolean;
    email: string;
    domains: string[];
    staging: boolean;
    renewBeforeDays: number;
    challengeType: string;
    http01Port: number | null;
    lastRenewal: { at: number; ok?: boolean; domain?: string; error?: string; validTo?: string; reason?: string } | null;
    nextRun: string | null;
}

export default function AutoRenewalPanel({ adminEmail }: { adminEmail?: string }) {
    const { alert } = useModal();
    const [cfg, setCfg] = useState<AcmeConfig | null>(null);
    const [domainsText, setDomainsText] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [renewing, setRenewing] = useState(false);

    const load = async () => {
        try {
            const data = await apiGet<AcmeConfig>('/system/certs/acme-config?t=' + Date.now());
            setCfg(data);
            setDomainsText((data.domains || []).join(', '));
        } catch {
            setCfg({ enabled: false, email: '', domains: [], staging: false, renewBeforeDays: 30, challengeType: 'http-01', http01Port: null, lastRenewal: null, nextRun: null });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    // Pre-fill the account email from the admin email when none is set yet.
    useEffect(() => {
        if (cfg && !cfg.email && adminEmail) setCfg({ ...cfg, email: adminEmail });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [adminEmail, loading]);

    const parseDomains = () => domainsText.split(',').map(d => d.trim()).filter(Boolean);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!cfg) return;
        setSaving(true);
        try {
            const res = await apiPost<any>('/system/certs/acme-config', {
                enabled: cfg.enabled,
                email: cfg.email,
                domains: parseDomains(),
                staging: cfg.staging,
                renewBeforeDays: Number(cfg.renewBeforeDays) || 30,
                challengeType: 'http-01'
            });
            if (res?.error) { await alert('Could not save: ' + res.error); }
            else { await alert('Auto-renewal settings saved.'); await load(); }
        } catch (e: any) {
            await alert('Could not save: ' + (e.message || 'unknown error'));
        } finally {
            setSaving(false);
        }
    };

    const renewNow = async () => {
        setRenewing(true);
        try {
            const res = await apiPost<any>('/system/certs/renew-now', {});
            if (res?.ok) await alert(`Certificate renewed for ${res.domain}.`);
            else if (res?.skipped) await alert(`Renewal skipped: ${res.reason || 'not due'}.`);
            else await alert(`Renewal did not complete: ${res?.error || 'unknown error'}`);
            await load();
        } catch (e: any) {
            await alert('Renewal failed: ' + (e.message || 'unknown error'));
        } finally {
            setRenewing(false);
        }
    };

    if (loading || !cfg) return (
        <div className="text-center py-10">
            <i className="fa-solid fa-circle-notch fa-spin text-2xl text-amber-500 mb-3"></i>
            <p className="text-gray-500 font-medium">Loading auto-renewal settings…</p>
        </div>
    );

    const last = cfg.lastRenewal;

    return (
        <form onSubmit={save} className="space-y-6">
            {/* Status row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-white/60 dark:bg-black/20 rounded-xl border border-amber-100 dark:border-amber-900/40">
                    <span className="block text-xs uppercase tracking-wider text-amber-500 font-bold mb-1">Next scheduled check</span>
                    <span className="font-semibold text-gray-800 dark:text-gray-200">
                        {cfg.nextRun ? new Date(cfg.nextRun).toLocaleString() : '—'}
                    </span>
                </div>
                <div className="p-4 bg-white/60 dark:bg-black/20 rounded-xl border border-amber-100 dark:border-amber-900/40">
                    <span className="block text-xs uppercase tracking-wider text-amber-500 font-bold mb-1">Last renewal</span>
                    {last ? (
                        <span className={`font-semibold ${last.ok ? 'text-emerald-600' : last.reason ? 'text-gray-600 dark:text-gray-300' : 'text-red-600'}`}>
                            {last.ok ? '✓ ' : last.reason ? '• ' : '✕ '}
                            {new Date(last.at).toLocaleString()}
                            {last.domain ? ` — ${last.domain}` : ''}
                            {!last.ok && (last.error || last.reason) ? ` (${last.error || last.reason})` : ''}
                        </span>
                    ) : <span className="font-semibold text-gray-400 italic">never</span>}
                </div>
            </div>

            {/* Enable toggle */}
            <div
                className="p-5 bg-amber-50 dark:bg-amber-900/10 rounded-2xl border border-amber-100 dark:border-amber-800 flex items-center justify-between gap-6 cursor-pointer hover:bg-amber-100/50 dark:hover:bg-amber-900/20 transition-all"
                onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })}
            >
                <div className="flex gap-4 items-center">
                    <div className="bg-white dark:bg-amber-800/50 p-3 rounded-xl shadow-sm border border-amber-200 dark:border-amber-700 text-amber-600 dark:text-amber-400">
                        <i className="fa-solid fa-arrows-rotate text-xl"></i>
                    </div>
                    <div>
                        <h4 className="text-base font-bold text-gray-900 dark:text-white">Automatic renewal</h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Renew the Let&apos;s Encrypt certificate automatically before it expires.</p>
                    </div>
                </div>
                <div className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${cfg.enabled ? 'bg-amber-500' : 'bg-gray-300 dark:bg-gray-700'}`}>
                    <span className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform duration-200 ${cfg.enabled ? 'translate-x-7' : 'translate-x-1'}`} />
                </div>
            </div>

            {/* Settings */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Account email</label>
                    <input
                        type="email"
                        value={cfg.email}
                        onChange={e => setCfg({ ...cfg, email: e.target.value })}
                        placeholder="you@example.com"
                        className="w-full px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-4 focus:ring-amber-500/10 focus:border-amber-500 outline-none transition-all text-gray-800 dark:text-gray-200"
                    />
                    <p className="text-xs text-gray-500 ml-1">Let&apos;s Encrypt expiry notices go here.</p>
                </div>
                <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Renew before expiry (days)</label>
                    <input
                        type="number" min={1} max={89}
                        value={cfg.renewBeforeDays}
                        onChange={e => setCfg({ ...cfg, renewBeforeDays: Number(e.target.value) })}
                        className="w-full px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-4 focus:ring-amber-500/10 focus:border-amber-500 outline-none transition-all font-mono text-gray-800 dark:text-gray-200"
                    />
                    <p className="text-xs text-gray-500 ml-1">Default 30. Checked twice daily.</p>
                </div>
                <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Domain(s)</label>
                    <input
                        type="text"
                        value={domainsText}
                        onChange={e => setDomainsText(e.target.value)}
                        placeholder="example.com, www.example.com"
                        className="w-full px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-4 focus:ring-amber-500/10 focus:border-amber-500 outline-none transition-all text-gray-800 dark:text-gray-200"
                    />
                    <p className="text-xs text-gray-500 ml-1">Comma-separated. The first domain is the certificate&apos;s primary name.</p>
                </div>
            </div>

            {/* Staging */}
            <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300 cursor-pointer select-none">
                <input type="checkbox" checked={cfg.staging} onChange={e => setCfg({ ...cfg, staging: e.target.checked })} className="w-4 h-4 accent-amber-500" />
                Use Let&apos;s Encrypt <span className="font-semibold">staging</span> (for testing — issues untrusted certs, avoids rate limits)
            </label>

            {/* HTTP-01 reachability note */}
            <div className="flex items-start gap-3 p-4 bg-blue-50/60 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-800 text-sm text-blue-800 dark:text-blue-300">
                <i className="fa-solid fa-circle-info mt-0.5"></i>
                <p>
                    Auto-renewal runs in the <span className="font-semibold">split (gateway) deployment</span> and uses the
                    <span className="font-semibold"> HTTP-01</span> challenge, so
                    <span className="font-mono"> http://&lt;domain&gt;/.well-known/acme-challenge/</span> must be publicly reachable on port 80.
                    For a host serving HTTPS on 443, add <span className="font-mono">&quot;acme&quot;: {'{'} &quot;http01Port&quot;: 80 {'}'}</span> to
                    <span className="font-mono"> backend/wordjs-config.json</span> (binds a redirect + challenge listener — restart the gateway to apply),
                    or front the site with a reverse proxy. Otherwise use the manual <span className="font-semibold">DNS</span> or <span className="font-semibold">custom upload</span> flows above.
                </p>
            </div>

            <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-gray-100 dark:border-gray-800">
                <button
                    type="button"
                    onClick={renewNow}
                    disabled={renewing}
                    className="bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 font-bold px-6 py-3 rounded-xl transition-all hover:bg-amber-50 disabled:opacity-50"
                >
                    {renewing ? <span className="flex items-center gap-2"><i className="fa-solid fa-circle-notch fa-spin"></i> Renewing…</span>
                        : <span className="flex items-center gap-2"><i className="fa-solid fa-bolt"></i> Renew now</span>}
                </button>
                <button
                    type="submit"
                    disabled={saving}
                    className="bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white font-bold px-8 py-3 rounded-xl transition-all shadow-lg shadow-amber-200 dark:shadow-none hover:-translate-y-0.5"
                >
                    {saving ? <span className="flex items-center gap-2"><i className="fa-solid fa-circle-notch fa-spin"></i> Saving…</span>
                        : <span className="flex items-center gap-2"><i className="fa-solid fa-floppy-disk"></i> Save auto-renewal</span>}
                </button>
            </div>
        </form>
    );
}
