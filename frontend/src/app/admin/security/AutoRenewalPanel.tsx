"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { Button, Checkbox, Input } from "@/components/ui";

/**
 * One translated sentence with styled parts in it: `{name}` in the text is replaced by parts[name]. Each
 * language orders and punctuates the whole sentence itself; gluing fragments together left "in the every
 * deployment mode" and "listenerabove" (FALLOS 137).
 */
export function withParts(text: string, parts: Record<string, ReactNode>): ReactNode[] {
    return text.split(/(\{\w+\})/).map((piece, i) => {
        const name = /^\{(\w+)\}$/.exec(piece)?.[1];
        return <Fragment key={i}>{name && name in parts ? parts[name] : piece}</Fragment>;
    });
}

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
    const { t } = useI18n();
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
                challengeType: 'http-01',
                // Sent every time: leaving it out used to drop a port set earlier.
                http01Port: cfg.http01Port || null
            });
            if (res?.error) { await alert(t('ssl.auto.saveFailed').replace('{error}', () => res.error)); }
            else { await alert(t('ssl.auto.saved')); await load(); }
        } catch (e: any) {
            await alert(t('ssl.auto.saveFailed').replace('{error}', () => e.message || t('ssl.auto.unknownError')));
        } finally {
            setSaving(false);
        }
    };

    const renewNow = async () => {
        setRenewing(true);
        try {
            const res = await apiPost<any>('/system/certs/renew-now', {});
            if (res?.ok) await alert(t('ssl.auto.renewed').replace('{domain}', () => res.domain));
            else if (res?.skipped) await alert(t('ssl.auto.skipped').replace('{reason}', () => res.reason || t('ssl.auto.notDue')));
            else await alert(t('ssl.auto.incomplete').replace('{error}', () => res?.error || t('ssl.auto.unknownError')));
            await load();
        } catch (e: any) {
            await alert(t('ssl.auto.renewFailed').replace('{error}', () => e.message || t('ssl.auto.unknownError')));
        } finally {
            setRenewing(false);
        }
    };

    if (loading || !cfg) return (
        <div className="text-center py-10">
            <i className="fa-solid fa-circle-notch fa-spin text-2xl text-amber-500 mb-3"></i>
            <p className="text-gray-500 font-medium">{t('ssl.auto.loading')}</p>
        </div>
    );

    const last = cfg.lastRenewal;

    return (
        <form onSubmit={save} className="space-y-6">
            {/* Status row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-white/60 rounded-xl border border-amber-100">
                    <span className="block text-xs uppercase tracking-wider text-amber-500 font-bold mb-1">{t('ssl.auto.nextCheck')}</span>
                    <span className="font-semibold text-gray-800">
                        {cfg.nextRun ? new Date(cfg.nextRun).toLocaleString() : '—'}
                    </span>
                </div>
                <div className="p-4 bg-white/60 rounded-xl border border-amber-100">
                    <span className="block text-xs uppercase tracking-wider text-amber-500 font-bold mb-1">{t('ssl.auto.lastRenewal')}</span>
                    {last ? (
                        <span className={`font-semibold ${last.ok ? 'text-emerald-600' : last.reason ? 'text-gray-600' : 'text-red-600'}`}>
                            {last.ok ? '✓ ' : last.reason ? '• ' : '✕ '}
                            {new Date(last.at).toLocaleString()}
                            {last.domain ? ` — ${last.domain}` : ''}
                            {!last.ok && (last.error || last.reason) ? ` (${last.error || last.reason})` : ''}
                        </span>
                    ) : <span className="font-semibold text-gray-400 italic">{t('ssl.auto.never')}</span>}
                </div>
            </div>

            {/* Enable toggle */}
            <div
                className="p-5 bg-amber-50 rounded-2xl border border-amber-100 flex items-center justify-between gap-6 cursor-pointer hover:bg-amber-100/50 transition-all"
                onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })}
            >
                <div className="flex gap-4 items-center">
                    <div className="bg-white p-3 rounded-xl shadow-sm border border-amber-200 text-amber-600">
                        <i className="fa-solid fa-arrows-rotate text-xl"></i>
                    </div>
                    <div>
                        <h4 className="text-base font-bold text-gray-900">{t('ssl.auto.title')}</h4>
                        <p className="text-xs text-gray-500 mt-1">{t('ssl.auto.description')}</p>
                    </div>
                </div>
                <div className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors ${cfg.enabled ? 'bg-amber-500' : 'bg-gray-300'}`}>
                    <span className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform duration-200 ${cfg.enabled ? 'translate-x-7' : 'translate-x-1'}`} />
                </div>
            </div>

            {/* Settings */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Input
                    id="autorenew-field-1"
                    size="md"
                    label={t('ssl.auto.accountEmail')}
                    help={t('ssl.auto.accountEmailHint')}
                    type="email"
                    value={cfg.email}
                    onChange={e => setCfg({ ...cfg, email: e.target.value })}
                    placeholder="you@example.com"
                />
                <Input
                    id="autorenew-field-2"
                    size="md"
                    label={t('ssl.auto.renewBefore')}
                    help={t('ssl.auto.renewBeforeHint')}
                    type="number" min={1} max={89}
                    value={cfg.renewBeforeDays}
                    onChange={e => setCfg({ ...cfg, renewBeforeDays: Number(e.target.value) })}
                    className="font-mono"
                />
                <Input
                    id="autorenew-field-3"
                    size="md"
                    label={t('ssl.auto.domains')}
                    help={t('ssl.auto.domainsHint')}
                    type="text"
                    value={domainsText}
                    onChange={e => setDomainsText(e.target.value)}
                    placeholder="example.com, www.example.com"
                    containerClassName="md:col-span-2"
                />
                <Input
                    id="acme-http01-port"
                    size="md"
                    label={t('ssl.auto.port80')}
                    help={t('ssl.auto.port80Hint')}
                    type="number" min={1} max={65535}
                    value={cfg.http01Port ?? ''}
                    onChange={e => setCfg({ ...cfg, http01Port: e.target.value === '' ? null : Number(e.target.value) })}
                    placeholder={t('ssl.auto.port80Off')}
                    data-testid="acme-http01-port"
                    className="font-mono"
                />
            </div>

            {/* Staging */}
            <Checkbox
                checked={cfg.staging}
                onChange={e => setCfg({ ...cfg, staging: e.target.checked })}
                label={<span className="font-normal text-gray-700">{t('ssl.auto.stagingBefore')} <span className="font-semibold">{t('ssl.auto.stagingWord')}</span> {t('ssl.auto.stagingAfter')}</span>}
            />

            {/* HTTP-01 reachability note */}
            <div className="flex items-start gap-3 p-4 bg-blue-50/60 rounded-xl border border-blue-100 text-sm text-blue-800">
                <i className="fa-solid fa-circle-info mt-0.5"></i>
                <p data-testid="acme-http01-note">
                    {withParts(t('ssl.auto.note.http01'), {
                        modes: <span className="font-semibold">{t('ssl.auto.note.everyMode')}</span>,
                        challenge: <span className="font-semibold">HTTP-01</span>,
                        path: <span className="font-mono break-all">http://&lt;domain&gt;/.well-known/acme-challenge/</span>,
                        port80: <span className="font-semibold">{t('ssl.auto.port80')}</span>,
                        dns: <span className="font-semibold">DNS</span>,
                        custom: <span className="font-semibold">{t('ssl.auto.note.customUpload')}</span>,
                    })}
                </p>
            </div>

            <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-gray-100">
                <Button variant="secondary" size="md" icon="fa-bolt" onClick={renewNow} pending={renewing} pendingLabel={t('ssl.auto.renewing')}>
                    {t('ssl.auto.renewNow')}
                </Button>
                <Button type="submit" size="md" icon="fa-floppy-disk" pending={saving} pendingLabel={t('ssl.auto.saving')}>
                    {t('ssl.auto.save')}
                </Button>
            </div>
        </form>
    );
}
