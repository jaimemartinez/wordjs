// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend tsc.
"use client";

import { errorText } from "./i18n";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../../../frontend/src/lib/api";
import {
    ScrollRow,
    cx, Button, IconBtn, Field, Toggle, Card, Pill, EmptyState, Spinner, Sheet, Avatar, Menu, MenuItem,
    inputCls, formatBytes, listDate, fullDate, relativeTime
} from "./ui";
import SystemSent from "./SystemSent";

const TABS = [
    ['overview', 'fa-solid fa-chart-line'],
    ['mailboxes', 'fa-solid fa-users'],
    ['aliases', 'fa-solid fa-at'],
    ['queue', 'fa-solid fa-paper-plane'],
    ['systemSent', 'fa-solid fa-envelope-circle-check'],
    ['policies', 'fa-solid fa-shield-halved'],
    ['config', 'fa-solid fa-server'],
    ['dns', 'fa-solid fa-globe'],
    ['test', 'fa-solid fa-vial'],
];

const QUOTA_PRESETS = [100, 500, 1024, 2048, 5120, 10240];

// =================================================================================================
// Overview
// =================================================================================================

function Kpi({ icon, label, value, sub, tone = 'violet', onClick }: any) {
    const tones = { violet: 'bg-violet-50 text-violet-600', green: 'bg-emerald-50 text-emerald-600', blue: 'bg-sky-50 text-sky-600', orange: 'bg-orange-50 text-orange-600', red: 'bg-red-50 text-red-600', slate: 'bg-slate-100 text-slate-600' };
    const Tag = onClick ? 'button' : 'div';
    return (
        <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cx('flex flex-col items-start gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm sm:flex-row sm:items-center sm:gap-3 sm:p-4', onClick && 'transition hover:border-violet-300 hover:shadow')}>
            <span className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg', tones[tone])}><i className={icon}></i></span>
            <span className="min-w-0">
                <span className="block text-xs font-medium leading-tight text-slate-500">{label}</span>
                <span className="mt-0.5 block text-xl font-bold tabular-nums text-slate-900">{value}</span>
                {sub && <span className="block text-[11px] leading-tight text-slate-400">{sub}</span>}
            </span>
        </Tag>
    );
}

function TrafficChart({ series, t, locale }: any) {
    const max = Math.max(1, ...series.map((d: any) => d.received + d.sent + d.spam));
    const [hover, setHover] = useState<number | null>(null);
    const h = 150;
    return (
        <div>
            <div className="mb-3 flex flex-wrap gap-4 text-xs text-slate-600">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-violet-500"></span>{t('srv.received')}</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-sky-400"></span>{t('srv.sent')}</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-orange-300"></span>{t('srv.spam')}</span>
            </div>
            <div className="relative flex items-end gap-1 sm:gap-1.5" style={{ height: h }} onMouseLeave={() => setHover(null)}>
                {series.map((d: any, i: number) => {
                    const part = (n: number) => `${(n / max) * 100}%`;
                    return (
                        <div key={d.date} className="group relative flex h-full flex-1 cursor-default flex-col justify-end" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
                            <div className={cx('flex flex-col justify-end overflow-hidden rounded-t-md transition-opacity', hover !== null && hover !== i && 'opacity-50')} style={{ height: '100%' }}>
                                <div className="bg-orange-300" style={{ height: part(d.spam) }}></div>
                                <div className="bg-sky-400" style={{ height: part(d.sent) }}></div>
                                <div className="bg-violet-500" style={{ height: part(d.received) }}></div>
                            </div>
                            {d.received + d.sent + d.spam === 0 && <div className="h-0.5 rounded bg-slate-200"></div>}
                        </div>
                    );
                })}
                {hover !== null && series[hover] && (
                    <div className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-lg" style={{ left: `min(calc(${(hover / series.length) * 100}% ), calc(100% - 150px))` }}>
                        <div className="mb-1 font-semibold">{new Date(series[hover].date + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                        <div>{t('srv.received')}: {series[hover].received}</div>
                        <div>{t('srv.sent')}: {series[hover].sent}</div>
                        <div>{t('srv.spam')}: {series[hover].spam}</div>
                        {series[hover].failed > 0 && <div className="text-red-300">{t('srv.failed')}: {series[hover].failed}</div>}
                    </div>
                )}
            </div>
            <div className="mt-2 flex gap-1 text-[10px] text-slate-400 sm:gap-1.5">
                {series.map((d: any, i: number) => (
                    <span key={d.date} className="flex-1 text-center">{i % 2 === 0 || series.length < 10 ? new Date(d.date + 'T12:00:00Z').toLocaleDateString(locale, { day: 'numeric' }) : ''}</span>
                ))}
            </div>
        </div>
    );
}

function Overview({ t, locale, data, settings, go, reload }: any) {
    if (!data) return <div className="py-20 text-center"><Spinner className="text-2xl" /></div>;
    const sum = (k: string) => data.series.reduce((a: number, d: any) => a + (d[k] || 0), 0);
    // Final failures are not waiting for anything: they stay on their Sent copy and in the system log.
    const queueCount = data.totals.retrying + data.totals.scheduled;
    const dkim = settings?.mail_security_dkim_enabled === '1';
    // Where inbound SMTP actually listens: this node's addresses (a multi-machine install runs the plugin
    // on the backend node, which is NOT the address visitors reach the site on).
    const addrs = data.inbound?.addresses || {};
    const listenIps = [...(addrs.public || []), ...(addrs.private || [])];
    const listenAt = data.inbound?.boundPort && listenIps.length ? t('srv.listenAt', { where: listenIps.map((ip: string) => `${ip}:${data.inbound.boundPort}`).join(', ') }) : null;
    const tls = data.inbound?.tls;
    const health = [
        data.inbound?.ok
            ? { ok: true, icon: 'fa-solid fa-inbox', text: t('srv.inboundOk'), detail: [data.inbound.mode === 'host' ? t('srv.inboundViaHost') : null, listenAt].filter(Boolean).join(' · ') || null }
            : data.inbound?.boundPort
                ? { ok: false, icon: 'fa-solid fa-inbox', text: t('srv.inboundDegraded', { port: data.inbound.boundPort }), detail: [listenAt, data.inbound.reason].filter(Boolean).join(' · '), action: () => go('config') }
                : { ok: false, icon: 'fa-solid fa-inbox', text: t('srv.inboundUnknown'), action: () => go('config') },
        ...(data.mailDomain && data.mailDomainPublic === false ? [{ ok: false, icon: 'fa-solid fa-at', text: t('srv.domainLocal', { domain: data.mailDomain }), detail: t('srv.domainLocalHint', { domain: data.mailDomain }), action: () => go('config') }] : []),
        data.relay && data.relayStatus && !data.relayStatus.ok
            ? { ok: false, icon: 'fa-solid fa-tower-broadcast', text: t('srv.relayDown'), detail: data.relayStatus.error, action: () => go('config') }
            : { ok: true, neutral: true, icon: 'fa-solid fa-tower-broadcast', text: data.relay ? t('srv.relayOn') : t('srv.relayOff'), action: () => go('config') },
        ...(data.inbound?.mode === 'host' ? [tls
            ? { ok: true, icon: 'fa-solid fa-lock', text: t('srv.tlsOk'), detail: t('srv.tlsDetail', { subject: tls.subject.replace(/^CN=/, ''), until: new Date(tls.validTo).toLocaleDateString(locale) }) }
            : { ok: false, icon: 'fa-solid fa-lock-open', text: t('srv.tlsOff') }] : []),
        { ok: dkim, icon: 'fa-solid fa-key', text: dkim ? 'DKIM ✓' : 'DKIM —', action: () => go('dns') },
        // Password recovery through this server: the host offers it only once delivery is ready.
        data.deliveryReady
            ? { ok: true, icon: 'fa-solid fa-key', text: t('srv.accountMailReady'), action: () => { window.location.href = '/admin/settings/email'; } }
            : { ok: false, icon: 'fa-solid fa-user-lock', text: t('srv.accountMailNotReady'), detail: t('srv.accountMailNotReadyHint'), action: () => { window.location.href = '/admin/settings/email'; } },
        { ok: true, neutral: true, icon: 'fa-solid fa-at', text: t('srv.aliasesCount', { n: data.aliases }), action: () => go('aliases') },
        { ok: true, neutral: true, icon: 'fa-solid fa-hard-drive', text: t('srv.defaultQuota', { q: data.defaultQuotaMb > 0 ? formatBytes(data.defaultQuotaMb * 1048576) : t('common.unlimited') }), action: () => go('policies') },
    ];
    return (
        <div className="grid gap-4 sm:gap-6">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                <Kpi icon="fa-solid fa-inbox" label={`${t('srv.received')} · ${t('srv.last14')}`} value={sum('received')} />
                <Kpi icon="fa-solid fa-paper-plane" label={`${t('srv.sent')} · ${t('srv.last14')}`} value={sum('sent')} tone="blue" />
                <Kpi icon="fa-solid fa-clock-rotate-left" label={t('srv.queue')} value={queueCount} sub={`${data.totals.retrying} ${t('srv.retrying').toLowerCase()} · ${data.totals.scheduled} ${t('srv.scheduledShort')}`} tone={data.totals.retrying ? 'orange' : 'slate'} onClick={() => go('queue')} />
                <Kpi icon="fa-solid fa-hard-drive" label={t('srv.storage')} value={formatBytes(data.totals.bytes)} sub={`${data.totals.messages} ${t('srv.messages').toLowerCase()} · ${t('srv.attachments', { n: data.totals.attachments })}`} tone="green" />
            </div>
            <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
                <Card title={`${t('srv.traffic')} · ${t('srv.last14')}`} icon="fa-solid fa-chart-column" className="xl:col-span-2" action={<IconBtn size="sm" icon="fa-solid fa-rotate-right" label={t('common.refresh')} onClick={reload} />}>
                    <TrafficChart series={data.series} t={t} locale={locale} />
                </Card>
                <Card title={t('srv.health')} icon="fa-solid fa-heart-pulse" bodyClass="p-2">
                    <ul>
                        {health.map((h: any, i) => (
                            <li key={i}>
                                <button type="button" onClick={h.action} className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-slate-50">
                                    <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs', h.neutral ? 'bg-slate-100 text-slate-500' : h.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600')}><i className={h.icon}></i></span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm text-slate-800">{h.text}</span>
                                        {h.detail && <span className="mt-0.5 line-clamp-2 block text-[11px] text-slate-500">{h.detail}</span>}
                                    </span>
                                    <i className="fa-solid fa-chevron-right mt-2 text-[10px] text-slate-300"></i>
                                </button>
                            </li>
                        ))}
                    </ul>
                </Card>
            </div>
            <Card title={t('srv.recent')} icon="fa-solid fa-list" bodyClass="p-0">
                {data.recent.length === 0 ? <EmptyState icon="fa-regular fa-envelope" title={t('srv.noRecent')} className="py-10" /> : (
                    <ul className="divide-y divide-slate-100">
                        {data.recent.map((r: any) => (
                            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
                                <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs', r.is_sent ? 'bg-sky-50 text-sky-600' : r.is_spam ? 'bg-orange-50 text-orange-600' : 'bg-violet-50 text-violet-600')}>
                                    <i className={r.is_sent ? 'fa-solid fa-paper-plane' : r.is_spam ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-inbox'}></i>
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm text-slate-800">{r.subject || '(no subject)'}</span>
                                    <span className="block truncate text-xs text-slate-500">{r.is_sent ? `→ ${r.to_address}` : `${r.from_name || r.from_address}`}</span>
                                </span>
                                {r.delivery_status === 'failed' && <Pill tone="red">{t('badge.failed')}</Pill>}
                                {r.delivery_status === 'retry' && <Pill tone="amber">{t('badge.retrying')}</Pill>}
                                <span className="shrink-0 text-xs tabular-nums text-slate-400">{listDate(r.date_received, locale)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
}

// =================================================================================================
// Mailboxes
// =================================================================================================

function QuotaPicker({ value, defaultMb, onChange, t }: any) {
    const [custom, setCustom] = useState(false);
    const [mb, setMb] = useState(value > 0 ? String(value) : '');
    const label = value === -1 ? t('srv.mbx.inherit', { q: defaultMb > 0 ? formatBytes(defaultMb * 1048576) : t('common.unlimited') }) : value === 0 ? t('common.unlimited') : formatBytes(value * 1048576);
    if (custom) {
        return (
            <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const n = parseInt(mb, 10); if (n > 0) { onChange(n); setCustom(false); } }}>
                <input autoFocus type="number" min={1} value={mb} onChange={(e) => setMb(e.target.value)} className="h-8 w-24 rounded-lg border border-slate-200 px-2 text-sm" placeholder="MB" />
                <IconBtn size="sm" type="submit" icon="fa-solid fa-check" label={t('common.save')} />
                <IconBtn size="sm" icon="fa-solid fa-xmark" label={t('common.cancel')} onClick={() => setCustom(false)} />
            </form>
        );
    }
    return (
        <Menu width="w-56" trigger={({ toggle }: any) => (
            <button type="button" onClick={toggle} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 hover:border-slate-300">
                <span className="truncate">{label}</span><i className="fa-solid fa-chevron-down text-[9px] text-slate-400"></i>
            </button>
        )}>
            <MenuItem checked={value === -1} onClick={() => onChange(-1)}>{t('srv.mbx.inherit', { q: defaultMb > 0 ? formatBytes(defaultMb * 1048576) : t('common.unlimited') })}</MenuItem>
            <MenuItem checked={value === 0} onClick={() => onChange(0)}>{t('common.unlimited')}</MenuItem>
            {QUOTA_PRESETS.map(q => <MenuItem key={q} checked={value === q} onClick={() => onChange(q)}>{formatBytes(q * 1048576)}</MenuItem>)}
            <MenuItem icon="fa-solid fa-pen" onClick={() => setCustom(true)}>{t('srv.mbx.custom')}</MenuItem>
        </Menu>
    );
}

function UsageBar({ bytes, quotaMb, percent }: any) {
    return (
        <div className="min-w-[110px]">
            <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium tabular-nums text-slate-700">{formatBytes(bytes)}</span>
                {quotaMb > 0 && <span className="tabular-nums text-slate-400">{percent}%</span>}
            </div>
            {quotaMb > 0 && (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className={cx('h-full rounded-full', percent >= 95 ? 'bg-red-500' : percent >= 80 ? 'bg-amber-500' : 'bg-violet-500')} style={{ width: `${Math.max(2, percent)}%` }}></div>
                </div>
            )}
        </div>
    );
}

function Mailboxes({ t, locale, toast }: any) {
    const [data, setData] = useState<any>(null);
    const [q, setQ] = useState('');
    const [loading, setLoading] = useState(false);
    const load = async (query = q) => {
        setLoading(true);
        try { setData(await api(`/plugin/mail-server/admin/mailboxes${query ? `?q=${encodeURIComponent(query)}` : ''}`)); }
        catch (e: any) { toast('error', errorText(e, t)); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(''); }, []);
    useEffect(() => { const id = setTimeout(() => load(q), 300); return () => clearTimeout(id); }, [q]);

    const setQuota = async (m: any, quotaMb: number) => {
        try {
            await api(`/plugin/mail-server/admin/mailboxes/${m.id}`, { method: 'PUT', body: { quotaMb } });
            toast('success', t('srv.mbx.quotaSaved'));
            load();
        } catch (e: any) { toast('error', errorText(e, t)); }
    };

    const list = data?.mailboxes || [];
    return (
        <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-[200px] flex-1">
                    <i className="fa-solid fa-magnifying-glass pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400"></i>
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('srv.mbx.search')} className={cx(inputCls, 'pl-10')} />
                </div>
                <IconBtn icon={cx('fa-solid fa-rotate-right', loading && 'fa-spin')} label={t('common.refresh')} onClick={() => load()} />
            </div>
            <p className="flex items-start gap-2 text-xs text-slate-500"><i className="fa-solid fa-circle-info mt-0.5 text-slate-400"></i>{t('srv.mbx.howTo')}</p>
            {!data ? <div className="py-16 text-center"><Spinner className="text-2xl" /></div> : list.length === 0 ? (
                <Card><EmptyState icon="fa-solid fa-users" title={t('srv.mbx.empty')} hint={t('srv.mbx.howTo')} action={<Button variant="secondary" size="sm" icon="fa-solid fa-user-plus" onClick={() => { window.location.href = '/admin/users'; }}>{t('srv.mbx.goUsers')}</Button>} /></Card>
            ) : (
                <>
                    {/* Table on wide screens */}
                    <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:block">
                        <table className="w-full text-left text-sm">
                            <thead className="border-b border-slate-100 bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                <tr>
                                    <th className="px-5 py-3">{t('srv.mbx.account')}</th>
                                    <th className="px-3 py-3">{t('srv.mbx.usage')}</th>
                                    <th className="px-3 py-3 text-right">{t('srv.messages')}</th>
                                    <th className="px-3 py-3 text-right">{t('srv.mbx.unread')}</th>
                                    <th className="px-3 py-3">{t('srv.mbx.last')}</th>
                                    <th className="px-5 py-3">{t('srv.mbx.quota')}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {list.map((m: any) => (
                                    <tr key={m.id} className="hover:bg-slate-50/60">
                                        <td className="px-5 py-3">
                                            <div className="flex items-center gap-3">
                                                <Avatar name={m.name} email={m.email} size={36} />
                                                <div className="min-w-0">
                                                    <div className="truncate font-medium text-slate-900">{m.name}</div>
                                                    <div className="truncate text-xs text-slate-500">{m.address || m.email}</div>
                                                    {!m.hasMailbox && <Pill tone="slate" className="mt-1">{t('srv.mbx.noMailbox')}</Pill>}
                                                    {m.missingAddress && <Pill tone="amber" className="mt-1">{t('srv.mbx.offDomain', { domain: data.mailDomain })}</Pill>}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-3 py-3"><UsageBar {...m} /></td>
                                        <td className="px-3 py-3 text-right tabular-nums text-slate-700">{m.messages}</td>
                                        <td className="px-3 py-3 text-right tabular-nums text-slate-700">{m.unread}</td>
                                        <td className="px-3 py-3 text-xs text-slate-500">{m.lastActivity ? relativeTime(m.lastActivity, locale) : t('common.never')}</td>
                                        <td className="px-5 py-3"><QuotaPicker value={m.quotaOverride} defaultMb={data.defaultQuotaMb} onChange={(v: number) => setQuota(m, v)} t={t} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {/* Cards on phones/tablets */}
                    <div className="grid gap-3 sm:grid-cols-2 lg:hidden">
                        {list.map((m: any) => (
                            <div key={m.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                                <div className="flex items-center gap-3">
                                    <Avatar name={m.name} email={m.email} size={40} />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium text-slate-900">{m.name}</div>
                                        <div className="truncate text-xs text-slate-500">{m.address || m.email}</div>
                                    </div>
                                </div>
                                {!m.hasMailbox && <Pill tone="slate" className="mt-2">{t('srv.mbx.noMailbox')}</Pill>}
                                {m.missingAddress && <Pill tone="amber" className="mt-2">{t('srv.mbx.offDomain', { domain: data.mailDomain })}</Pill>}
                                <div className="mt-3"><UsageBar {...m} /></div>
                                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                                    <span>{m.messages} {t('srv.messages').toLowerCase()} · {m.unread} {t('srv.mbx.unread').toLowerCase()}</span>
                                    <QuotaPicker value={m.quotaOverride} defaultMb={data.defaultQuotaMb} onChange={(v: number) => setQuota(m, v)} t={t} />
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

// =================================================================================================
// Aliases
// =================================================================================================

function Aliases({ t, toast, confirm }: any) {
    const [data, setData] = useState<any>(null);
    const [editing, setEditing] = useState<any>(null);
    const [saving, setSaving] = useState(false);
    const load = async () => {
        try { setData(await api('/plugin/mail-server/admin/aliases')); }
        catch (e: any) { toast('error', errorText(e, t)); }
    };
    useEffect(() => { load(); }, []);
    const domain = data?.mailDomain || '';

    const save = async () => {
        setSaving(true);
        try {
            const body = { localPart: editing.localPart, destinations: editing.destinations, description: editing.description, enabled: editing.enabled !== false };
            if (editing.id) await api(`/plugin/mail-server/admin/aliases/${editing.id}`, { method: 'PUT', body });
            else await api('/plugin/mail-server/admin/aliases', { method: 'POST', body });
            toast('success', t('srv.alias.saved'));
            setEditing(null);
            load();
        } catch (e: any) { toast('error', errorText(e, t)); }
        finally { setSaving(false); }
    };
    const remove = async (a: any) => {
        if (!(await confirm(t('srv.alias.deleteConfirm', { addr: `${a.local_part}@${domain}` }), t('common.delete'), true))) return;
        try { await api(`/plugin/mail-server/admin/aliases/${a.id}`, { method: 'DELETE' }); toast('success', t('srv.alias.deleted')); load(); }
        catch (e: any) { toast('error', errorText(e, t)); }
    };
    const toggle = async (a: any) => {
        try {
            await api(`/plugin/mail-server/admin/aliases/${a.id}`, { method: 'PUT', body: { localPart: a.local_part, destinations: a.destinations, description: a.description, enabled: !a.enabled } });
            load();
        } catch (e: any) { toast('error', errorText(e, t)); }
    };

    return (
        <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-xl text-sm text-slate-500">{t('srv.alias.destinationsHint')}</p>
                <Button variant="primary" icon="fa-solid fa-plus" onClick={() => setEditing({ localPart: '', destinations: '', description: '', enabled: true })}>{t('srv.alias.new')}</Button>
            </div>
            {!data ? <div className="py-16 text-center"><Spinner className="text-2xl" /></div> : data.aliases.length === 0 ? (
                <Card><EmptyState icon="fa-solid fa-at" title={t('srv.alias.empty')} action={<Button variant="primary" icon="fa-solid fa-plus" onClick={() => setEditing({ localPart: '', destinations: '', description: '', enabled: true })}>{t('srv.alias.new')}</Button>} /></Card>
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {data.aliases.map((a: any) => (
                        <div key={a.id} className={cx('rounded-2xl border bg-white p-4 shadow-sm', a.enabled ? 'border-slate-200' : 'border-dashed border-slate-300 opacity-70')}>
                            <div className="flex items-start gap-3">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><i className="fa-solid fa-at"></i></span>
                                <div className="min-w-0 flex-1">
                                    <div className="break-all font-semibold text-slate-900">{a.local_part}<span className="font-normal text-slate-400">@{domain}</span></div>
                                    {a.description && <div className="truncate text-xs text-slate-500">{a.description}</div>}
                                </div>
                                <button type="button" role="switch" aria-checked={!!a.enabled} onClick={() => toggle(a)} title={a.enabled ? t('common.enabled') : t('common.disabled')}
                                    className={cx('relative mt-1 h-5 w-9 shrink-0 rounded-full transition-colors', a.enabled ? 'bg-violet-600' : 'bg-slate-300')}>
                                    <span className={cx('absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', a.enabled && 'translate-x-4')}></span>
                                </button>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-1.5">
                                {a.destinations.map((d: string) => (
                                    <span key={d} className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700">
                                        <i className={cx(d.endsWith('@' + domain) ? 'fa-regular fa-user' : 'fa-solid fa-share', 'text-[10px] text-slate-400')}></i>
                                        <span className="truncate">{d}</span>
                                        {!d.endsWith('@' + domain) && <span className="text-[10px] text-slate-400">({t('srv.alias.external')})</span>}
                                    </span>
                                ))}
                            </div>
                            <div className="mt-3 flex justify-end gap-1">
                                <Button size="sm" variant="ghost" icon="fa-solid fa-pen" onClick={() => setEditing({ id: a.id, localPart: a.local_part, destinations: a.destinations.join('\n'), description: a.description || '', enabled: !!a.enabled })}>{t('common.edit')}</Button>
                                <Button size="sm" variant="dangerGhost" icon="fa-regular fa-trash-can" onClick={() => remove(a)}>{t('common.delete')}</Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? t('srv.alias.edit') : t('srv.alias.new')}
                footer={<><Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={saving} onClick={save}>{t('common.save')}</Button></>}>
                {editing && (
                    <div className="grid gap-4">
                        <Field label={t('srv.alias.name')}>
                            <div className="flex items-stretch overflow-hidden rounded-xl border border-slate-200 focus-within:border-violet-500 focus-within:ring-4 focus-within:ring-violet-500/10">
                                <input autoFocus value={editing.localPart} onChange={(e) => setEditing({ ...editing, localPart: e.target.value.toLowerCase().replace(/\s/g, '') })} placeholder="info" className="min-w-0 flex-1 px-3.5 py-2.5 text-sm outline-none" />
                                <span className="flex items-center border-l border-slate-200 bg-slate-50 px-3 text-sm text-slate-500">@{domain}</span>
                            </div>
                        </Field>
                        <Field label={t('srv.alias.destinations')} hint={t('srv.alias.destinationsHint')}>
                            <textarea value={editing.destinations} onChange={(e) => setEditing({ ...editing, destinations: e.target.value })} placeholder={`ana@${domain}\nluis@${domain}`} className={cx(inputCls, 'min-h-[110px] resize-y font-mono text-[13px]')} />
                        </Field>
                        <Field label={`${t('srv.alias.description')} (${t('common.optional')})`}>
                            <input value={editing.description} maxLength={200} onChange={(e) => setEditing({ ...editing, description: e.target.value })} className={inputCls} />
                        </Field>
                        <Toggle label={t('common.enabled')} checked={editing.enabled !== false} onChange={(v: boolean) => setEditing({ ...editing, enabled: v })} />
                    </div>
                )}
            </Sheet>
        </div>
    );
}

// =================================================================================================
// Queue
// =================================================================================================

/**
 * The general queue's sending rate: the setting (messages per minute, 0 = no cap) and what the queue is
 * doing with it now — this minute's count, how many messages wait, and how long they take at that rate.
 */
function SendRateCard({ t, toast, pacing, onSaved }: any) {
    const [value, setValue] = useState('');
    const [saved, setSaved] = useState('');
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        api('/plugin/mail-server/settings')
            .then((s: any) => { const v = String(s?.mail_queue_per_minute ?? '0'); setValue(v); setSaved(v); })
            .catch(() => { /* the queue list reports load errors */ });
    }, []);
    const valid = /^\d{1,6}$/.test(value.trim());
    const save = async () => {
        if (!valid) return;
        setSaving(true);
        try {
            await api('/plugin/mail-server/settings', { method: 'POST', body: { mail_queue_per_minute: value.trim() } });
            const v = String(parseInt(value.trim(), 10));
            setValue(v); setSaved(v);
            toast('success', t('srv.rate.saved'));
            onSaved();
        } catch (e: any) { toast('error', errorText(e, t)); }
        finally { setSaving(false); }
    };
    const perMinute = pacing ? Number(pacing.perMinute) || 0 : 0;
    const waiting = pacing ? Number(pacing.waiting) || 0 : 0;
    return (
        <Card title={t('srv.rate.title')} icon="fa-solid fa-gauge-high">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                <Field label={t('srv.rate.label')} hint={t('srv.rate.hint')} htmlFor="mail-queue-per-minute">
                    <div className="flex gap-2">
                        <input id="mail-queue-per-minute" data-testid="mail-queue-per-minute" inputMode="numeric" value={value}
                            onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                            className={cx(inputCls, 'max-w-[10rem]')} />
                        <Button icon="fa-solid fa-floppy-disk" loading={saving} disabled={!valid || value.trim() === saved} onClick={save}>{t('common.save')}</Button>
                    </div>
                </Field>
                <dl className="grid grid-cols-3 gap-3 text-center" data-testid="mail-queue-pacing">
                    <div className="rounded-xl bg-slate-50 p-3">
                        <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{t('srv.rate.now')}</dt>
                        <dd className="mt-1 text-lg font-semibold text-slate-900">
                            {pacing ? (perMinute > 0 ? t('srv.rate.nowOf', { n: pacing.sentThisMinute, max: perMinute }) : String(pacing.sentThisMinute || 0)) : '…'}
                        </dd>
                        <dd className="text-[11px] text-slate-400">{perMinute > 0 ? t('srv.rate.perMinute') : t('srv.rate.unlimited')}</dd>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                        <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{t('srv.rate.waiting')}</dt>
                        <dd className="mt-1 text-lg font-semibold text-slate-900">{pacing ? waiting : '…'}</dd>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                        <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{t('srv.rate.eta')}</dt>
                        <dd className="mt-1 text-lg font-semibold text-slate-900">
                            {!pacing ? '…' : waiting === 0 ? '—' : pacing.etaMinutes > 0 ? t('srv.rate.etaMinutes', { n: pacing.etaMinutes }) : t('srv.rate.etaSoon')}
                        </dd>
                    </div>
                </dl>
            </div>
        </Card>
    );
}

function Queue({ t, locale, toast, confirm, onChanged }: any) {
    const [items, setItems] = useState<any[] | null>(null);
    const [pacing, setPacing] = useState<any>(null);
    const [busy, setBusy] = useState<number | null>(null);
    const load = async () => {
        try { const d = await api('/plugin/mail-server/admin/queue') as any; setItems(d.items || []); setPacing(d.pacing || null); if (onChanged) onChanged(); }
        catch (e: any) { toast('error', errorText(e, t)); }
    };
    useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id); }, []);

    const retry = async (it: any) => {
        setBusy(it.id);
        try {
            const r = await api(`/plugin/mail-server/admin/queue/${it.id}/retry`, { method: 'POST' }) as any;
            if (r && r.waiting) toast('progress', t('read.retryWaiting'));
            else if (r && r.pending) toast('progress', t('read.retryPending'));
            else if (r && r.success) toast('success', t('read.delivered')); else toast('error', r?.message || t('read.stillFailing'));
            load();
        } catch (e: any) { toast('error', errorText(e, t)); }
        finally { setBusy(null); }
    };
    const cancel = async (it: any) => {
        if (!(await confirm(t('srv.queue.cancelConfirm'), t('srv.queue.cancel'), true))) return;
        setBusy(it.id);
        try { await api(`/plugin/mail-server/admin/queue/${it.id}`, { method: 'DELETE' }); toast('success', t('srv.queue.cancelled')); load(); }
        catch (e: any) { toast('error', errorText(e, t)); }
        finally { setBusy(null); }
    };

    const status = (it: any) => it.delivery_status === 'failed' ? ['red', t('badge.failed'), 'fa-solid fa-circle-exclamation']
        : it.delivery_status === 'retry' && Number(it.paced) === 1 ? ['blue', t('badge.waitingRate'), 'fa-solid fa-hourglass-half']
        : it.delivery_status === 'retry' ? ['amber', t('badge.retrying'), 'fa-solid fa-rotate']
            : ['violet', t('badge.scheduled'), 'fa-regular fa-clock'];

    // One column whose children may shrink below their content: a long unbroken token (an address glued to
    // a colon in a delivery error) must wrap inside the card, not widen the page on a phone.
    return (
        <div className="grid min-w-0 grid-cols-1 gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-0 max-w-xl text-sm text-slate-500">{t('srv.queue.hint')}</p>
                <IconBtn icon="fa-solid fa-rotate-right" label={t('common.refresh')} onClick={load} />
            </div>
            <SendRateCard t={t} toast={toast} pacing={pacing} onSaved={load} />
            {!items ? <div className="py-16 text-center"><Spinner className="text-2xl" /></div> : items.length === 0 ? (
                <Card><EmptyState icon="fa-solid fa-circle-check" title={t('srv.queue.empty')} /></Card>
            ) : (
                <ul className="grid grid-cols-1 gap-3">
                    {items.map(it => {
                        const [tone, label, icon] = status(it);
                        return (
                            <li key={it.id} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                                <div className="flex flex-wrap items-start gap-3">
                                    <Pill tone={tone}><i className={icon}></i>{label}</Pill>
                                    <div className="min-w-0 flex-1 basis-60">
                                        <div className="truncate font-medium text-slate-900">{it.subject || '(no subject)'}</div>
                                        <div className="mt-0.5 break-all text-xs text-slate-500">{it.from_address} → {it.to_address}</div>
                                        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-400">
                                            <span>{fullDate(it.date_received, locale)}</span>
                                            {it.delivery_attempts > 0 && <span>{t('srv.queue.attempts', { n: it.delivery_attempts })}</span>}
                                            {it.delivery_status === 'retry' && it.next_attempt_at && <span>{t('srv.queue.next', { when: relativeTime(it.next_attempt_at, locale) })}</span>}
                                            {!it.delivery_status && it.scheduled_at && <span>{t('srv.queue.at', { when: relativeTime(it.scheduled_at, locale) })}</span>}
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(it.delivery_status === 'failed' || it.delivery_status === 'retry') && <Button size="sm" icon="fa-solid fa-paper-plane" loading={busy === it.id} onClick={() => retry(it)}>{t('srv.queue.retryNow')}</Button>}
                                        {it.delivery_status !== 'failed' && <Button size="sm" variant="dangerGhost" icon="fa-solid fa-ban" disabled={busy === it.id} onClick={() => cancel(it)}>{t('srv.queue.cancel')}</Button>}
                                    </div>
                                </div>
                                {it.last_error && Number(it.paced) !== 1 && <pre className="mt-3 whitespace-pre-wrap wrap-anywhere rounded-lg bg-slate-50 p-2.5 font-mono text-[11px] text-slate-600">{it.last_error}</pre>}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

// =================================================================================================
// Policies + configuration (both edit /settings)
// =================================================================================================

function SaveBar({ dirty, saving, onSave, onReset, t }: any) {
    if (!dirty) return null;
    return (
        <div className="sticky bottom-0 z-20 -mx-3 mt-2 border-t border-slate-200 bg-white/95 px-3 py-3 backdrop-blur sm:-mx-6 sm:px-6" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
            <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onReset}>{t('common.cancel')}</Button>
                <Button variant="primary" loading={saving} onClick={onSave}>{t('srv.saveChanges')}</Button>
            </div>
        </div>
    );
}

function Policies({ t, settings, set }: any) {
    const on = (k: string, def = '0') => (settings[k] ?? def) !== '0';
    return (
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <Card title={t('srv.pol.blocked')} icon="fa-solid fa-ban">
                <Field hint={t('srv.pol.blockedHint')}>
                    <textarea value={settings.mail_blocked_senders || ''} onChange={(e) => set({ mail_blocked_senders: e.target.value })} placeholder={'spammer@example.com\n@bad-domain.example'} className={cx(inputCls, 'min-h-[140px] resize-y font-mono text-[13px]')} />
                </Field>
            </Card>
            <Card title={t('srv.pol.allowed')} icon="fa-solid fa-user-check">
                <Field hint={t('srv.pol.allowedHint')}>
                    <textarea value={settings.mail_allowed_senders || ''} onChange={(e) => set({ mail_allowed_senders: e.target.value })} placeholder={'@partner.example\nboss@client.example'} className={cx(inputCls, 'min-h-[140px] resize-y font-mono text-[13px]')} />
                </Field>
            </Card>
            <Card title={t('srv.pol.quota')} icon="fa-solid fa-hard-drive">
                <Field hint={t('srv.pol.quotaHint')}>
                    <div className="flex items-center gap-2">
                        <input type="number" min={0} value={settings.mail_quota_default_mb ?? '0'} onChange={(e) => set({ mail_quota_default_mb: e.target.value })} className={cx(inputCls, 'max-w-[160px]')} />
                        <span className="text-sm text-slate-500">MB</span>
                        {Number(settings.mail_quota_default_mb) > 0 && <span className="text-xs text-slate-400">= {formatBytes(Number(settings.mail_quota_default_mb) * 1048576)}</span>}
                    </div>
                </Field>
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {[0, ...QUOTA_PRESETS].map(q => (
                        <button key={q} type="button" onClick={() => set({ mail_quota_default_mb: String(q) })} className={cx('rounded-lg border px-2.5 py-1 text-xs', String(q) === String(settings.mail_quota_default_mb ?? '0') ? 'border-violet-300 bg-violet-50 font-semibold text-violet-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
                            {q === 0 ? t('common.unlimited') : formatBytes(q * 1048576)}
                        </button>
                    ))}
                </div>
            </Card>
            <Card title={t('srv.policies')} icon="fa-solid fa-shield-halved" bodyClass="divide-y divide-slate-100 px-4 sm:px-6">
                <Toggle className="py-3.5" label={t('srv.pol.forwarding')} hint={t('srv.pol.forwardingHint')} checked={on('mail_forwarding_allowed', '1')} onChange={(v: boolean) => set({ mail_forwarding_allowed: v ? '1' : '0' })} />
                <Toggle className="py-3.5" label={t('srv.pol.dnsbl')} checked={on('mail_security_dnsbl_enabled', '1')} onChange={(v: boolean) => set({ mail_security_dnsbl_enabled: v ? '1' : '0' })} />
                <Toggle className="py-3.5" label={t('srv.pol.spf')} checked={on('mail_security_spf_enabled', '1')} onChange={(v: boolean) => set({ mail_security_spf_enabled: v ? '1' : '0' })} />
                <Toggle className="py-3.5" label={t('srv.pol.spfReject')} disabled={!on('mail_security_spf_enabled', '1')} checked={on('mail_security_spf_reject', '1')} onChange={(v: boolean) => set({ mail_security_spf_reject: v ? '1' : '0' })} />
                <Toggle className="py-3.5" label={t('srv.pol.dmarc')} hint={t('srv.pol.dmarcHint')} checked={on('mail_security_dmarc_enabled', '1')} onChange={(v: boolean) => set({ mail_security_dmarc_enabled: v ? '1' : '0' })} />
                <Toggle className="py-3.5" label={t('srv.pol.catchAll')} checked={on('smtp_catch_all', '0')} onChange={(v: boolean) => set({ smtp_catch_all: v ? '1' : '0' })} />
                <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                    <span className="text-sm font-semibold text-slate-800">{t('srv.pol.undo')}</span>
                    <select value={settings.mail_undo_send_seconds || '10'} onChange={(e) => set({ mail_undo_send_seconds: e.target.value })} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm">
                        <option value="0">{t('srv.pol.undoOff')}</option>
                        {[5, 10, 20, 30].map(n => <option key={n} value={String(n)}>{t('srv.pol.seconds', { n })}</option>)}
                    </select>
                </div>
            </Card>
        </div>
    );
}

function InboundStatus({ settings, setSettings, t, confirm }: any) {
    const [freeing, setFreeing] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const consent = (c: any) => {
        const label = c?.occupant?.label || t('srv.cfg.conflictingService');
        const scope = c?.occupant?.loopbackOnly
            ? t('srv.cfg.freeLoopback', { label })
            : t('srv.cfg.freePublic', { label });
        return confirm(t('srv.cfg.freeConfirm', { label, scope }), t('srv.cfg.freePort'), true);
    };
    const free = async () => {
        setMsg(null); setFreeing(true);
        try {
            const info = await api('/plugins/mail-server/port-conflicts') as any;
            const c = (info?.conflicts || []).find((x: any) => x.port === 25);
            if (c?.reason && !(c.inUse && c.canFree)) { setMsg(c.reason); return; }
            let allowDisable = false;
            if (c?.inUse && c?.canFree) { if (!(await consent(c))) return; allowDisable = true; }
            try { await api('/plugins/mail-server/free-port', { method: 'POST', body: { port: 25, allowDisable } }); }
            catch (e: any) {
                if (e?.details?.code === 'CONSENT_REQUIRED') {
                    if (!(await consent(e.details.conflict))) return;
                    await api('/plugins/mail-server/free-port', { method: 'POST', body: { port: 25, allowDisable: true } });
                } else throw e;
            }
            const fresh = await api('/plugin/mail-server/settings') as any;
            setSettings((p: any) => ({ ...p, inbound_bound_port: fresh.inbound_bound_port, inbound_ok: fresh.inbound_ok, inbound_degraded: fresh.inbound_degraded, inbound_reason: fresh.inbound_reason }));
        } catch (e: any) { setMsg(e?.message || t('srv.cfg.freeFailed')); }
        finally { setFreeing(false); }
    };
    if (settings.inbound_bound_port === null || settings.inbound_bound_port === undefined) {
        return (
            <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                <span className="flex items-center gap-3"><i className="fa-solid fa-circle-info text-slate-400"></i>{t('srv.inboundUnknown')}</span>
                {settings.inbound_reason && <code className="block whitespace-pre-wrap break-words rounded-lg bg-white px-3 py-2 font-mono text-xs leading-relaxed">{settings.inbound_reason}</code>}
                {settings.inbound_mode !== 'host' && (
                    <span className="flex flex-wrap items-center gap-2 text-xs"><i className="fa-solid fa-key text-slate-400"></i><span className="flex-1">{t('srv.grantInbound')}</span><a href="/admin/plugins?permissions=mail-server" className="font-semibold text-violet-700 hover:underline">{t('srv.openPermissions')}</a></span>
                )}
            </div>
        );
    }
    if (settings.inbound_ok) {
        return (
            <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <i className="fa-solid fa-circle-check mt-0.5 text-emerald-500"></i>
                <span><span className="font-medium">{t('srv.inboundOk')}</span>{settings.inbound_mode === 'host' && <span className="block text-xs text-emerald-700">{t('srv.inboundViaHost')}</span>}</span>
            </div>
        );
    }
    const grantHint = settings.inbound_mode !== 'host' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs">
            <i className="fa-solid fa-key text-amber-600"></i>
            <span className="min-w-0 flex-1">{t('srv.grantInbound')}</span>
            <a href="/admin/plugins?permissions=mail-server" className="font-semibold text-violet-700 hover:underline">{t('srv.openPermissions')}</a>
        </div>
    );
    return (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
            <div className="flex items-start gap-3">
                <i className="fa-solid fa-triangle-exclamation mt-0.5 text-amber-500"></i>
                <div className="grid min-w-0 gap-2">
                    <span className="text-sm font-semibold">{t('srv.inboundDegraded', { port: settings.inbound_bound_port })}</span>
                    {settings.inbound_reason && <code className="block whitespace-pre-wrap break-words rounded-lg bg-amber-100/70 px-3 py-2 font-mono text-xs leading-relaxed">{settings.inbound_reason}</code>}
                    {grantHint}
                    <div><Button size="sm" variant="secondary" icon="fa-solid fa-unlock" loading={freeing} onClick={free}>{t('srv.cfg.freePort')}</Button></div>
                    {msg && <div className="whitespace-pre-wrap text-xs">{msg}</div>}
                </div>
            </div>
        </div>
    );
}

// The relay's last check (initTransporter on the server): ready, or unavailable and why. A configured relay
// that is down keeps mail in the queue — it is never bypassed — so this is the first thing to look at.
const relayDest = (host: string, port: any) => `${String(host).includes(':') ? `[${host}]` : host}:${port}`;

function RelayStatus({ t, settings }: any) {
    const st = settings.relay_status;
    const host = String(settings.mail_server || '').trim();
    if (!host) return null;
    if (!st?.configured || st.host !== host || String(st.port) !== String(settings.mail_port || '587')) {
        return <p className="mt-4 text-xs text-slate-500"><i className="fa-solid fa-circle-info mr-1 text-slate-400"></i>{t('srv.cfg.relayUnsaved')}</p>;
    }
    if (st.ok) {
        return (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <i className="fa-solid fa-circle-check mt-0.5 text-emerald-500"></i>
                <span>{t('srv.cfg.relayReady', { dest: relayDest(st.host, st.port) })}</span>
            </div>
        );
    }
    return (
        <div className="mt-4 grid gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <span className="flex items-start gap-3 font-semibold"><i className="fa-solid fa-circle-exclamation mt-0.5 text-red-500"></i>{t('srv.cfg.relayUnavailable', { reason: st.error || '—' })}</span>
            <span className="text-xs text-red-700">{t(settings.mail_relay_mode === 'fallback' ? 'srv.cfg.relayDownFallback' : 'srv.cfg.relayQueued')}</span>
        </div>
    );
}

// Sandbox access for a PRIVATE relay. WordJS lets plugins reach public addresses only; an administrator can
// approve exactly one host:port for this plugin (the host's POST /plugins/mail-server/private-egress, which
// restarts the plugin so it applies). Shown for any saved relay: only the operator knows whether it is on
// their LAN, and the relay status above says so when the sandbox refused it.
function SandboxAccess({ t, settings, onChanged }: any) {
    const st = settings.relay_status;
    const [state, setState] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const load = async () => { try { setState(await api('/plugins/mail-server/private-egress')); } catch { setState(null); } };
    useEffect(() => { load(); }, []);
    if (!st?.configured || !state) return null;
    const dest = relayDest(st.host, st.port);
    const approved: string[] = state.destinations || [];
    const allowed = approved.includes(dest.toLowerCase());
    const others = approved.filter((d) => d !== dest.toLowerCase());
    const change = async (destinations: string[]) => {
        setBusy(true); setMsg('');
        try {
            await api('/plugins/mail-server/private-egress', { method: 'POST', body: { destinations } });
            await load();
            // The host restarted the plugin; give it a moment to re-check the relay, then refresh.
            setTimeout(onChanged, 1500);
        } catch (e: any) { setMsg(e?.message || t('srv.cfg.sandboxFailed')); }
        finally { setBusy(false); }
    };
    return (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <div className="mb-1 flex items-center gap-2 font-semibold"><i className="fa-solid fa-shield-halved text-slate-400"></i>{t('srv.cfg.sandbox')}</div>
            {!state.network ? <p className="text-xs text-amber-700">{t('srv.cfg.sandboxNoNetwork')}</p> : allowed ? (
                <div className="flex flex-wrap items-center gap-3">
                    <span className="flex-1 text-xs text-emerald-700"><i className="fa-solid fa-circle-check mr-1"></i>{t('srv.cfg.sandboxAllowed', { dest })}</span>
                    <Button size="sm" variant="secondary" loading={busy} onClick={() => change(others)}>{t('srv.cfg.sandboxWithdraw')}</Button>
                </div>
            ) : (
                <div className="grid gap-3">
                    <p className="text-xs leading-relaxed text-slate-500">{t('srv.cfg.sandboxHint', { dest })}</p>
                    <div><Button size="sm" variant="dark" icon="fa-solid fa-unlock" loading={busy} onClick={() => change([dest])}>{t('srv.cfg.sandboxAllow', { dest })}</Button></div>
                </div>
            )}
            {others.length > 0 && <p className="mt-2 text-[11px] text-slate-500">{t('srv.cfg.sandboxOthers', { list: others.join(', ') })}</p>}
            {msg && <p className="mt-2 whitespace-pre-wrap text-xs text-red-700">{msg}</p>}
        </div>
    );
}

function Config({ t, settings, set, setSettings, dnsInfo, onGenerateDkim, generatingDkim, confirm, reloadSettings }: any) {
    return (
        <div className="grid gap-4 sm:gap-6">
            <Card title="SMTP" icon="fa-solid fa-server">
                <div className="grid gap-5">
                    {settings.mail_domain && settings.mail_domain_public === false && (
                        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                            <i className="fa-solid fa-triangle-exclamation mt-0.5 text-amber-500"></i>
                            <span><span className="block font-semibold">{t('srv.domainLocal', { domain: settings.mail_domain })}</span><span className="block text-xs">{t('srv.domainLocalHint', { domain: settings.mail_domain })}</span></span>
                        </div>
                    )}
                    <InboundStatus settings={settings} setSettings={setSettings} t={t} confirm={confirm} />
                    <div className="grid gap-4 md:grid-cols-2">
                        <Field label={t('srv.cfg.fromEmail')} hint={settings.mail_from_effective ? t('srv.cfg.fromEmailHint', { address: settings.mail_from_effective, domain: settings.mail_domain || '' }) : undefined}><input type="email" className={inputCls} value={settings.mail_from_email || ''} onChange={(e) => set({ mail_from_email: e.target.value })} placeholder={settings.mail_domain ? `noreply@${settings.mail_domain}` : 'noreply@example.com'} /></Field>
                        <Field label={t('srv.cfg.fromName')}><input className={inputCls} value={settings.mail_from_name || ''} onChange={(e) => set({ mail_from_name: e.target.value })} placeholder="My Site" /></Field>
                    </div>
                    <Field label={t('srv.cfg.helo')} hint={t('srv.cfg.heloHint')}><input className={inputCls} value={settings.mail_helo_host || ''} onChange={(e) => set({ mail_helo_host: e.target.value })} placeholder="mail.example.com" /></Field>
                    <details className="rounded-xl border border-slate-200 p-4">
                        <summary className="cursor-pointer text-sm font-semibold text-slate-700">{t('srv.cfg.advanced')}</summary>
                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                            <Field label={t('srv.cfg.listenPort')} hint={t('srv.cfg.listenPortHint')}>
                                <input className={inputCls} value={settings.smtp_listen_port || ''} onChange={(e) => set({ smtp_listen_port: e.target.value })} placeholder="25" />
                            </Field>
                            <Field label={t('srv.cfg.proxyIps')} hint={t('srv.cfg.proxyIpsHint')}>
                                <input className={cx(inputCls, 'font-mono')} value={settings.smtp_proxy_ips || ''} onChange={(e) => set({ smtp_proxy_ips: e.target.value })} placeholder="10.8.0.1, 2001:db8::1" />
                            </Field>
                        </div>
                        {settings.smtp_proxy_active && <p className="mt-3 text-xs font-medium text-emerald-700"><i className="fa-solid fa-shield-halved mr-1"></i>{t('srv.cfg.proxyActive')}</p>}
                    </details>
                </div>
            </Card>
            <Card title={<>{t('srv.cfg.relay')} <span className="ml-1 text-xs font-normal text-slate-400">({t('common.optional')})</span></>} icon="fa-solid fa-tower-broadcast">
                <p className="mb-5 text-xs leading-relaxed text-slate-500">{t('srv.cfg.relayHint')}</p>
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label={t('srv.cfg.relayHost')}><input className={inputCls} value={settings.mail_server || ''} onChange={(e) => set({ mail_server: e.target.value })} placeholder="smtp.sendgrid.net" /></Field>
                    <Field label={t('srv.cfg.port')}><input className={inputCls} value={settings.mail_port || ''} onChange={(e) => set({ mail_port: e.target.value })} placeholder="587" /></Field>
                    <Field label={t('srv.cfg.username')}><input className={inputCls} value={settings.mail_user || ''} onChange={(e) => set({ mail_user: e.target.value })} placeholder="apikey" autoComplete="off" /></Field>
                    <Field label={settings.mail_pass_set ? t('srv.cfg.passwordStored') : t('srv.cfg.password')}>
                        <input type="password" className={inputCls} value={settings.mail_pass || ''} onChange={(e) => set({ mail_pass: e.target.value })} placeholder={settings.mail_pass_set ? '••••••••' : ''} autoComplete="new-password" />
                    </Field>
                    <Field label={t('srv.cfg.encryption')}>
                        <select className={inputCls} value={settings.mail_secure || '0'} onChange={(e) => set({ mail_secure: e.target.value })}>
                            <option value="0">STARTTLS (587 / 25)</option><option value="1">{t('srv.cfg.implicitTls')}</option>
                        </select>
                    </Field>
                    <Field label={t('srv.cfg.requireTls')}>
                        <select className={inputCls} value={settings.mail_relay_require_tls || '1'} onChange={(e) => set({ mail_relay_require_tls: e.target.value })}>
                            <option value="1">{t('common.yes')}</option><option value="0">{t('common.no')} — {t('srv.cfg.noTlsRelay')}</option>
                        </select>
                    </Field>
                    <Field label={t('srv.cfg.relayMode')} hint={settings.mail_relay_mode === 'fallback' ? t('srv.cfg.relayModeFallbackHint') : t('srv.cfg.relayModeAlwaysHint')} className="md:col-span-2">
                        <select className={inputCls} value={settings.mail_relay_mode || 'always'} onChange={(e) => set({ mail_relay_mode: e.target.value })}>
                            <option value="always">{t('srv.cfg.relayModeAlways')}</option>
                            <option value="fallback">{t('srv.cfg.relayModeFallback')}</option>
                        </select>
                    </Field>
                </div>
                {settings.direct_paused_until && (
                    <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                        <i className="fa-solid fa-pause mt-0.5"></i>
                        <span>{t('srv.cfg.directPaused', { until: new Date(settings.direct_paused_until).toLocaleTimeString() })}</span>
                    </p>
                )}
                <RelayStatus t={t} settings={settings} />
                <SandboxAccess t={t} settings={settings} onChanged={reloadSettings} />
            </Card>
            <Card title="DKIM" icon="fa-solid fa-key" action={<Pill tone={dnsInfo?.dkimConfigured ? 'green' : 'amber'}>{dnsInfo?.dkimConfigured ? '✓' : '—'}</Pill>}>
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label={t('srv.cfg.domain')}><input className={inputCls} value={settings.mail_security_dkim_domain || ''} onChange={(e) => set({ mail_security_dkim_domain: e.target.value })} placeholder="example.com" /></Field>
                    <Field label={t('srv.cfg.selector')}><input className={inputCls} value={settings.mail_security_dkim_selector || ''} onChange={(e) => set({ mail_security_dkim_selector: e.target.value })} placeholder="default" /></Field>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button variant="dark" icon="fa-solid fa-key" loading={generatingDkim} onClick={onGenerateDkim}>{dnsInfo?.dkimConfigured ? t('srv.cfg.dkimRegenerate') : t('srv.cfg.dkimGenerate')}</Button>
                    <span className="text-xs text-amber-700"><i className="fa-solid fa-triangle-exclamation mr-1"></i>{t('srv.cfg.dkimWarning')}</span>
                </div>
            </Card>
        </div>
    );
}

// =================================================================================================
// DNS
// =================================================================================================

const DNS_PROVIDER_GUIDE = { cloudflare: 'Cloudflare', hostinger: 'Hostinger', godaddy: 'GoDaddy', namecheap: 'Namecheap', generic: '' };

function CopyBtn({ value, t }: any) {
    const [ok, setOk] = useState(false);
    const copy = async () => {
        try { await navigator.clipboard.writeText(value); }
        catch {
            const ta = document.createElement('textarea'); ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { } document.body.removeChild(ta);
        }
        setOk(true); setTimeout(() => setOk(false), 1500);
    };
    return (
        <button type="button" onClick={copy} disabled={!value} className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-40', ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300 hover:text-violet-700')}>
            <i className={cx('fa-solid', ok ? 'fa-check' : 'fa-copy')}></i>{ok ? t('common.copied') : t('common.copy')}
        </button>
    );
}

function DnsRow({ step, title, record, check, note, t }: any) {
    if (!record) return null;
    const st = check ? {
        ok: ['green', 'fa-circle-check', t('srv.dnsx.ok')], missing: ['amber', 'fa-clock', t('srv.dnsx.missing')],
        mismatch: ['red', 'fa-triangle-exclamation', t('srv.dnsx.mismatch')], nokey: ['slate', 'fa-key', t('srv.dnsx.nokey')],
    }[check.status] : null;
    return (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
                {step && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">{step}</span>}
                <span className="text-sm font-bold text-slate-800">{title}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-600">{/^PTR/.test(record.type) ? t('srv.dnsx.ptrType') : record.type}</span>
                {st && <Pill tone={st[0]}><i className={cx('fa-solid', st[1])}></i>{st[2]}</Pill>}
            </div>
            <dl className="grid gap-2 text-xs">
                {record.host && (
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                        <dt className="w-16 shrink-0 font-semibold uppercase text-slate-400">{t('srv.dnsx.host')}</dt>
                        <dd className="min-w-0 flex-1 break-all font-mono text-slate-700">{record.host}</dd>
                        <CopyBtn value={record.host} t={t} />
                    </div>
                )}
                {record.priority !== undefined && record.priority !== null && (
                    <div className="flex items-center gap-2"><dt className="w-16 shrink-0 font-semibold uppercase text-slate-400">{t('srv.dnsx.priority')}</dt><dd className="font-mono text-slate-700">{record.priority}</dd></div>
                )}
                {record.value && (
                    <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
                        <dt className="w-16 shrink-0 pt-0.5 font-semibold uppercase text-slate-400">{t('srv.dnsx.value')}</dt>
                        <dd className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-slate-700">{record.value}</dd>
                        <CopyBtn value={record.value} t={t} />
                    </div>
                )}
            </dl>
            {record.note && <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{note || record.note}</p>}
            {check?.status === 'mismatch' && check.detail && <p className="mt-2 text-[11px] text-red-600"><i className="fa-solid fa-triangle-exclamation mr-1"></i>{check.detail}</p>}
        </div>
    );
}

/**
 * Every public address mail can leave from (IPv4 and IPv6): what the last check found for each, and the
 * reverse-DNS value to ask the provider for — WordJS cannot look a PTR up, so that one is an instruction.
 */
function SenderAddresses({ t, dnsInfo, check }: any) {
    const ptr = dnsInfo?.records?.ptr;
    const addresses: string[] = ptr?.addresses || [];
    if (!addresses.length) return null;
    const found = new Map<string, any>((check?.results?.senders || []).map((x: any) => [x.ip, x]));
    const line = (ok: boolean | null, text: string) => (
        <li className="flex items-start gap-2">
            <i className={cx('fa-solid mt-0.5', ok === null ? 'fa-circle text-slate-300' : ok ? 'fa-circle-check text-emerald-500' : 'fa-triangle-exclamation text-amber-500')}></i>
            <span className="min-w-0 break-words">{text}</span>
        </li>
    );
    return (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-1 flex flex-wrap items-center gap-2">
                <i className="fa-solid fa-network-wired text-violet-500"></i>
                <span className="text-sm font-bold text-slate-800">{t('srv.dnsx.senders')}</span>
            </div>
            <p className="mb-3 text-[11px] leading-relaxed text-slate-500">{t('srv.dnsx.sendersHint')}</p>
            <div className="grid gap-3">
                {addresses.map((ip) => {
                    const r = found.get(ip);
                    const v6 = ip.includes(':');
                    const helo = r?.heloHost || dnsInfo?.heloHost || ptr?.value;
                    return (
                        <div key={ip} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <Pill tone="slate">{v6 ? 'IPv6' : 'IPv4'}</Pill>
                                <code className="min-w-0 break-all font-mono text-xs text-slate-800">{ip}</code>
                            </div>
                            <ul className="grid gap-1.5 text-xs text-slate-600">
                                {line(r ? r.host === 'ok' : null, t('srv.dnsx.chk.host', { type: v6 ? 'AAAA' : 'A', host: dnsInfo?.records?.mx?.value || '' }))}
                                {line(r ? r.spf === 'pass' : null, r && r.spf !== 'pass' ? t('srv.dnsx.chk.spfNot', { result: r.spf }) : t('srv.dnsx.chk.spf'))}
                                {line(r ? r.helo === 'ok' : null, t('srv.dnsx.chk.helo', { helo }))}
                            </ul>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600 sm:flex-nowrap">
                                <span className="min-w-0 flex-1 break-words">{t('srv.dnsx.chk.ptr')} <code className="break-all font-mono text-slate-800">{ip} → {helo}</code></span>
                                <CopyBtn value={helo} t={t} />
                            </div>
                        </div>
                    );
                })}
            </div>
            {!check?.results?.senders && <p className="mt-3 text-[11px] text-slate-500">{t('srv.dnsx.sendersVerify')}</p>}
        </div>
    );
}

function Dns({ t, locale, dnsInfo, loading, reload }: any) {
    const [provider, setProvider] = useState('generic');
    const [check, setCheck] = useState<any>(null);
    const [checking, setChecking] = useState(false);
    const run = async () => {
        setChecking(true);
        try { setCheck(await api('/plugin/mail-server/security/dns-check')); }
        catch { setCheck({ error: true }); }
        finally { setChecking(false); }
    };
    // The server's notes are English; show the interface-language version with the same facts.
    const note = (k: string) => t(`srv.dnsx.note.${k}`, { domain: dnsInfo?.domain || '', mailHost: dnsInfo?.records?.mx?.value || '' });
    const verified = check && !check.error ? ['mx', 'a', 'spf', 'dkim', 'dmarc'].filter(k => check.results?.[k]?.status === 'ok').length : null;
    return (
        <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1fr_340px]">
            <div className="grid content-start gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-slate-600">{t('srv.dnsx.publishFor')} <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-800">{dnsInfo?.domain || '—'}</code>{dnsInfo?.heloHost && <> · HELO <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-800">{dnsInfo.heloHost}</code></>}</p>
                    <div className="flex items-center gap-2">
                        {verified !== null && <Pill tone={verified === 5 ? 'green' : 'amber'}>{verified} / 5</Pill>}
                        <Button size="sm" variant="primary" icon="fa-solid fa-shield-halved" loading={checking} onClick={run}>{check && !check.error ? t('srv.dnsx.recheck') : t('srv.dnsx.verify')}</Button>
                        <IconBtn size="sm" icon={cx('fa-solid fa-rotate-right', loading && 'fa-spin')} label={t('common.refresh')} onClick={reload} />
                    </div>
                </div>
                {check?.checkedAt && <p className="text-xs text-slate-500">{fullDate(check.checkedAt, locale)}</p>}
                {!dnsInfo ? <div className="py-16 text-center"><Spinner className="text-2xl" /></div> : (
                    <>
                        {(() => {
                            // AAAA only when this server has a public IPv6; the steps number what is shown.
                            const rows = [
                                { title: 'MX', record: dnsInfo.records?.mx, note: note('mx'), check: check?.results?.mx },
                                { title: 'A', record: dnsInfo.records?.a, note: note('a'), check: check?.results?.a },
                                { title: 'AAAA', record: dnsInfo.records?.aaaa, note: note('aaaa'), check: check?.results?.aaaa },
                                { title: 'SPF', record: dnsInfo.records?.spf, note: note('spf'), check: check?.results?.spf },
                                { title: 'DKIM', record: dnsInfo.records?.dkim, note: note('dkim'), check: check?.results?.dkim },
                                { title: 'DMARC', record: dnsInfo.records?.dmarc, check: check?.results?.dmarc },
                                { title: 'PTR', record: dnsInfo.records?.ptr, note: note('ptr') },
                            ].filter(r => r.record);
                            return rows.map((r, i) => <DnsRow key={r.title} step={i + 1} title={r.title} record={r.record} note={r.note} check={r.check} t={t} />);
                        })()}
                        <SenderAddresses t={t} dnsInfo={dnsInfo} check={check} />
                    </>
                )}
            </div>
            <Card title={t('srv.dnsx.howTo')} icon="fa-solid fa-book" className="self-start xl:sticky xl:top-4">
                <div className="mb-4 flex flex-wrap gap-1.5">
                    {Object.keys(DNS_PROVIDER_GUIDE).map(k => (
                        <button key={k} type="button" onClick={() => setProvider(k)} className={cx('rounded-full border px-3 py-1 text-xs font-semibold', provider === k ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-200 text-slate-600 hover:border-violet-300')}>{k === 'generic' ? t('srv.guide.other') : DNS_PROVIDER_GUIDE[k]}</button>
                    ))}
                </div>
                <p className="mb-2 text-xs leading-relaxed text-slate-600"><b className="text-slate-500">{t('srv.dnsx.where')}</b> {t(`srv.guide.${provider}.where`)}</p>
                <p className="mb-3 text-xs leading-relaxed text-slate-600"><b className="text-slate-500">{t('srv.dnsx.fields')}</b> {t(`srv.guide.${provider}.fields`)}</p>
                <ul className="grid gap-1.5">
                    {t(`srv.guide.${provider}.tips`).split('\n').map((tip: string, i: number) => <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-500"><i className="fa-solid fa-circle-check mt-0.5 text-violet-400"></i>{tip}</li>)}
                </ul>
            </Card>
        </div>
    );
}

// =================================================================================================
// Test
// =================================================================================================

function TestDelivery({ t }: any) {
    const [to, setTo] = useState('');
    const [busy, setBusy] = useState(false);
    const [res, setRes] = useState<any>(null);
    const run = async () => {
        setBusy(true); setRes(null);
        try { setRes(await api('/plugin/mail-server/test', { method: 'POST', body: { to: to || undefined } })); }
        catch (e: any) { setRes({ success: false, message: e?.message || t('srv.testx.failed'), delivered: [], failed: [] }); }
        finally { setBusy(false); }
    };
    return (
        <Card title={t('srv.testx.title')} icon="fa-solid fa-vial" className="max-w-3xl">
            <form className="flex flex-col gap-3 sm:flex-row" onSubmit={(e) => { e.preventDefault(); run(); }}>
                <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@gmail.com" className={cx(inputCls, 'flex-1')} />
                <Button type="submit" variant="primary" icon="fa-solid fa-paper-plane" loading={busy}>{t('srv.testx.send')}</Button>
            </form>
            <p className="mt-3 text-xs leading-relaxed text-slate-500">{t('srv.testx.hint')}</p>
            {res && (
                <div className={cx('mt-5 rounded-xl border p-4 text-sm', res.localOnly ? 'border-amber-200 bg-amber-50' : res.success ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50')}>
                    <div className={cx('flex items-center gap-2 font-semibold', res.localOnly ? 'text-amber-800' : res.success ? 'text-emerald-800' : 'text-red-800')}>
                        <i className={cx('fa-solid', res.localOnly ? 'fa-triangle-exclamation' : res.success ? 'fa-circle-check' : 'fa-circle-exclamation')}></i>{res.localOnly ? t('srv.testx.localOnly', { to: res.to }) : res.success ? t('srv.testx.ok') : res.message && ((!res.failed?.length && !res.delivered?.length) || (res.relay?.configured && !res.relay.ok)) ? res.message : t('srv.testx.fail')}
                    </div>
                    {(res.delivered || []).map((d: any, i: number) => <div key={'d' + i} className="mt-2 break-all rounded-lg bg-white/70 px-3 py-2 font-mono text-xs text-emerald-900"><b>{d.recipient}</b> {t('srv.testx.via')} <b>{d.via}</b> — {d.response}</div>)}
                    {(res.failed || []).map((f: any, i: number) => <div key={'f' + i} className="mt-2 break-all rounded-lg bg-white/70 px-3 py-2 font-mono text-xs text-red-900"><b>{f.recipient}</b> — {f.error}{f.permanent ? ` (${t('srv.testx.permanent')})` : ''}</div>)}
                </div>
            )}
        </Card>
    );
}

// =================================================================================================
// Shell
// =================================================================================================

const SETTINGS_KEYS_EDITABLE = [
    'mail_from_email', 'mail_from_name', 'smtp_listen_port', 'smtp_proxy_ips', 'smtp_catch_all', 'mail_helo_host',
    'mail_server', 'mail_port', 'mail_secure', 'mail_user', 'mail_pass', 'mail_relay_require_tls', 'mail_relay_mode',
    'mail_security_dkim_domain', 'mail_security_dkim_selector', 'mail_security_dnsbl_enabled', 'mail_security_spf_enabled',
    'mail_security_spf_reject', 'mail_security_dmarc_enabled', 'mail_undo_send_seconds', 'mail_blocked_senders', 'mail_allowed_senders',
    'mail_quota_default_mb', 'mail_forwarding_allowed',
];

export default function ServerAdmin({ t, locale, toasts, confirm, canUseMail, onBack, initialTab = 'overview' }: any) {
    const [tab, setTab] = useState(initialTab);
    const [overview, setOverview] = useState<any>(null);
    const [settings, setSettings] = useState<any>(null);
    const [saved, setSaved] = useState<any>(null);
    const [saving, setSaving] = useState(false);
    const [dnsInfo, setDnsInfo] = useState<any>(null);
    const [dnsLoading, setDnsLoading] = useState(false);
    const [generatingDkim, setGeneratingDkim] = useState(false);
    const toast = toasts.push;

    // `quiet`: a background refresh says nothing when it fails (the figures just stay as they were).
    const loadOverview = async (quiet = false) => { try { setOverview(await api('/plugin/mail-server/admin/overview')); } catch (e: any) { if (!quiet) toast('error', errorText(e, t)); } };
    const loadSettings = async () => {
        try { const s = await api('/plugin/mail-server/settings') as any; setSettings(s); setSaved(s); }
        catch (e: any) { toast('error', errorText(e, t)); }
    };
    const loadDns = async () => {
        setDnsLoading(true);
        try { setDnsInfo(await api('/plugin/mail-server/security/dns-records')); } catch { /* shown as empty */ }
        finally { setDnsLoading(false); }
    };
    useEffect(() => { loadOverview(); loadSettings(); loadDns(); }, []);
    // The overview figures and the queue counter on the tab follow the server while the page is open:
    // every 20 s when the page is visible, and on every tab switch.
    useEffect(() => {
        const id = setInterval(() => { if (document.visibilityState === 'visible') loadOverview(true); }, 20000);
        return () => clearInterval(id);
    }, []);
    useEffect(() => { loadOverview(true); }, [tab]);

    const set = (patch: any) => setSettings((s: any) => ({ ...s, ...patch }));
    const dirty = useMemo(() => settings && saved && SETTINGS_KEYS_EDITABLE.some(k => String(settings[k] ?? '') !== String(saved[k] ?? '')), [settings, saved]);

    const save = async () => {
        setSaving(true);
        try {
            const body: any = {};
            for (const k of SETTINGS_KEYS_EDITABLE) if (String(settings[k] ?? '') !== String(saved[k] ?? '')) body[k] = settings[k] ?? '';
            await api('/plugin/mail-server/settings', { method: 'POST', body });
            toast('success', t('srv.saved'));
            await loadSettings();
            loadOverview();
            loadDns();
        } catch (e: any) { toast('error', errorText(e, t)); }
        finally { setSaving(false); }
    };

    const generateDkim = async () => {
        const domain = settings?.mail_security_dkim_domain || dnsInfo?.domain || '';
        const selector = settings?.mail_security_dkim_selector || 'default';
        if (dnsInfo?.dkimConfigured && !(await confirm(t('srv.cfg.dkimConfirm'), t('srv.cfg.dkimRegenerate'), true))) return;
        setGeneratingDkim(true);
        try {
            await api('/plugin/mail-server/security/dkim/generate', { method: 'POST', body: { domain, selector, force: dnsInfo?.dkimConfigured ? true : undefined } });
            toast('success', t('srv.cfg.dkimGenerated'));
            await loadDns();
            loadSettings();
        } catch (e: any) { toast('error', errorText(e, t)); }
        finally { setGeneratingDkim(false); }
    };

    const domain = overview?.mailDomain || dnsInfo?.domain || '';
    const needsSettings = ['policies', 'config'].includes(tab);

    return (
        <div className="flex h-full min-h-0 w-full flex-col bg-slate-50">
            <header className="shrink-0 border-b border-slate-200 bg-white">
                <div className="mx-auto flex max-w-7xl items-center gap-3 px-3 pt-3 sm:px-6 sm:pt-5">
                    {canUseMail && <IconBtn icon="fa-solid fa-arrow-left" label={t('app.backToMail')} onClick={onBack} />}
                    <span className="hidden h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-slate-800 to-slate-950 text-white sm:flex"><i className="fa-solid fa-server"></i></span>
                    <div className="min-w-0 flex-1">
                        <h1 className="truncate text-lg font-bold text-slate-900 sm:text-xl">{t('srv.title')}</h1>
                        <p className="truncate text-xs text-slate-500 sm:text-sm">{t('srv.subtitle', { domain: domain || '—' })}</p>
                    </div>
                    {canUseMail && <Button size="sm" variant="secondary" icon="fa-solid fa-inbox" className="hidden sm:inline-flex" onClick={onBack}>{t('app.backToMail')}</Button>}
                </div>
                <ScrollRow as="nav" activeKey={tab} wrapClassName="mx-auto max-w-7xl" className="flex gap-1 px-2 pt-3 sm:px-5" role="tablist">
                    {TABS.map(([id, icon]) => (
                        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                            className={cx('flex shrink-0 items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors', tab === id ? 'border-violet-600 font-semibold text-violet-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>
                            <i className={cx(icon, 'text-xs')}></i>{t(`srv.${id}`)}
                            {id === 'queue' && overview && overview.totals.retrying > 0 && (
                                <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">{overview.totals.retrying}</span>
                            )}
                        </button>
                    ))}
                </ScrollRow>
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-6">
                    {tab === 'overview' && <Overview t={t} locale={locale} data={overview} settings={settings} go={setTab} reload={() => loadOverview()} />}
                    {tab === 'mailboxes' && <Mailboxes t={t} locale={locale} toast={toast} />}
                    {tab === 'aliases' && <Aliases t={t} toast={toast} confirm={confirm} />}
                    {tab === 'queue' && <Queue t={t} locale={locale} toast={toast} confirm={confirm} onChanged={() => loadOverview(true)} />}
                    {tab === 'systemSent' && <SystemSent t={t} locale={locale} toast={toast} confirm={confirm} goQueue={() => setTab('queue')} />}
                    {needsSettings && !settings && <div className="py-20 text-center"><Spinner className="text-2xl" /></div>}
                    {tab === 'policies' && settings && <Policies t={t} settings={settings} set={set} />}
                    {tab === 'config' && settings && <Config t={t} settings={settings} set={set} setSettings={setSettings} dnsInfo={dnsInfo} onGenerateDkim={generateDkim} generatingDkim={generatingDkim} confirm={confirm} reloadSettings={() => { loadSettings(); loadOverview(); }} />}
                    {tab === 'dns' && <Dns t={t} locale={locale} dnsInfo={dnsInfo} loading={dnsLoading} reload={loadDns} />}
                    {tab === 'test' && <TestDelivery t={t} />}
                    {needsSettings && <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={() => setSettings(saved)} t={t} />}
                </div>
            </main>
        </div>
    );
}
