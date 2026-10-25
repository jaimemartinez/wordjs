// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend tsc.
"use client";

/**
 * Correo › Servidor › «Enviados del sistema»: the mail the SITE sent (no mailbox owns it — core and plugin
 * mail through the provider, the email notifications), kept for the retention picked here. A user's own
 * mail is not here: it has its Sent folder.
 *
 * The preview renders the stored HTML — sanitized by the server (lib/sanitize-email-html.js) and again by
 * prepareEmailHtml — in an iframe with sandbox="" (no scripts, no same origin, no forms, no popups). Remote
 * images stay blocked until the administrator asks for them (a tracking pixel would report the admin's view).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../../../frontend/src/lib/api";
import { DatePicker } from "@/components/ui/DatePicker";
import { errorText } from "./i18n";
import {
    cx, Button, IconBtn, Card, Pill, EmptyState, Spinner, Sheet,
    inputCls, formatBytes, listDate, fullDate, prepareEmailHtml
} from "./ui";

const RETENTION_KEY = 'mail_system_sent_retention';
const PER_PAGE = 25;
const STATUSES = ['queued', 'delivered', 'retry', 'failed'];

export function statusChip(status: string, t: any) {
    if (status === 'delivered') return ['green', t('srv.sys.st.delivered'), 'fa-solid fa-circle-check'];
    if (status === 'failed') return ['red', t('srv.sys.st.failed'), 'fa-solid fa-circle-exclamation'];
    if (status === 'retry') return ['amber', t('srv.sys.st.retry'), 'fa-solid fa-rotate'];
    return ['blue', t('srv.sys.st.queued'), 'fa-solid fa-hourglass-half'];
}

const sourceLabel = (s: string, t: any) => {
    const k = `srv.sys.src.${s}`;
    const v = t(k);
    return v === k ? s : v;
};

function RetentionCard({ t, days, choices, confirm, toast, onSaved }: any) {
    const [busy, setBusy] = useState(false);
    const label = (d: number) => d === 0 ? t('srv.sys.keepNone') : t('srv.sys.keepDays', { n: d });
    const change = async (next: number) => {
        if (next === days) return;
        const shorter = next === 0 || (days > 0 && next < days);
        if (shorter && !(await confirm(
            next === 0 ? t('srv.sys.noneConfirm') : t('srv.sys.shortenConfirm', { n: next }),
            t('srv.sys.shortenAction'), true))) return;
        setBusy(true);
        try {
            const r = await api('/plugin/mail-server/settings', { method: 'POST', body: { [RETENTION_KEY]: String(next) } }) as any;
            const n = Number(r && r.systemSentPurged) || 0;
            toast('success', n > 0 ? t('srv.sys.savedPurged', { n }) : t('srv.saved'));
            onSaved();
        } catch (e: any) { toast('error', errorText(e, t)); }
        finally { setBusy(false); }
    };
    return (
        <Card bodyClass="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-64">
                    <label htmlFor="ms-sent-retention" className="block text-sm font-semibold text-slate-800">{t('srv.sys.retention')}</label>
                    <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('srv.sys.retentionHint')}</p>
                </div>
                <div className="flex items-center gap-2">
                    {busy && <Spinner />}
                    <select id="ms-sent-retention" value={String(days)} disabled={busy} onChange={(e) => change(parseInt(e.target.value, 10))}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm">
                        {choices.filter((d: number) => d > 0).map((d: number) => <option key={d} value={String(d)}>{label(d)}</option>)}
                        <option value="0">{label(0)}</option>
                    </select>
                </div>
            </div>
        </Card>
    );
}

/** The stored HTML in a frame that can run nothing: sandbox="" and a fixed height (it scrolls inside). */
function SandboxedPreview({ html, showImages, title }: any) {
    const prepared = useMemo(() => prepareEmailHtml(html || '', showImages), [html, showImages]);
    const srcDoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
        + '<style>html,body{margin:0;padding:0}body{padding:12px;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1e293b;word-break:break-word;overflow-wrap:anywhere}'
        + 'img{max-width:100%;height:auto}a{color:#6d28d9}table{max-width:100%!important}pre{white-space:pre-wrap}</style></head><body>'
        + prepared.html + '</body></html>';
    // The admin shell forces `iframe { height: 100% !important }`, so the height lives on the wrapper.
    return (
        <div className="h-[55dvh] min-h-[240px] w-full overflow-hidden rounded-xl border border-slate-200 bg-white">
            <iframe title={title} sandbox="" srcDoc={srcDoc} referrerPolicy="no-referrer" className="block h-full w-full border-0" />
        </div>
    );
}

function Detail({ id, t, locale, toast, onClose, onChanged, goQueue }: any) {
    const [m, setM] = useState<any>(null);
    const [view, setView] = useState<'html' | 'text'>('html');
    const [showImages, setShowImages] = useState(false);
    const [busy, setBusy] = useState(false);
    const load = async () => {
        try {
            const d = await api(`/plugin/mail-server/admin/system-sent/${id}`) as any;
            setM(d);
            if (!d.html && d.text) setView('text');
        } catch (e: any) { toast('error', errorText(e, t)); onClose(); }
    };
    useEffect(() => { setM(null); setShowImages(false); setView('html'); if (id) load(); }, [id]);
    const blocked = useMemo(() => (m && m.html ? prepareEmailHtml(m.html, false).blocked : 0), [m]);

    const retry = async () => {
        if (!m || !m.queue) return;
        setBusy(true);
        try {
            const r = await api(`/plugin/mail-server/admin/queue/${m.queue.id}/retry`, { method: 'POST' }) as any;
            if (r && r.success) toast('success', t('read.delivered')); else toast('error', r?.message || t('read.stillFailing'));
            await load();
            onChanged();
        } catch (e: any) { toast('error', errorText(e, t)); }
        finally { setBusy(false); }
    };

    // Addresses and ids break anywhere (no horizontal scroll at 375 px); prose wraps between words.
    const row = (label: string, value: any, mono = false, address = false) => value ? (
        <div className="grid gap-0.5 sm:grid-cols-[8rem_1fr] sm:gap-3">
            <dt className="text-xs font-semibold text-slate-500">{label}</dt>
            <dd className={cx('min-w-0 text-sm text-slate-800', address || mono ? 'break-all' : 'break-words', mono && 'font-mono text-xs')}>{value}</dd>
        </div>
    ) : null;

    const chip = m ? statusChip(m.status, t) : null;
    return (
        <Sheet open={!!id} onClose={onClose} wide title={m ? (m.subject || t('srv.sys.noSubject')) : t('srv.sys.detail')}
            footer={m && m.queue ? (
                <>
                    <Button variant="ghost" icon="fa-solid fa-list" onClick={() => { onClose(); goQueue(); }}>{t('srv.sys.openQueue')}</Button>
                    <Button variant="primary" icon="fa-solid fa-paper-plane" loading={busy} onClick={retry}>{t('srv.sys.retry')}</Button>
                </>
            ) : null}>
            {!m ? <div className="py-16 text-center"><Spinner className="text-2xl" /></div> : (
                <div className="grid gap-4">
                    <dl className="grid gap-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                            <Pill tone={chip[0]}><i className={chip[2]}></i>{chip[1]}</Pill>
                            <Pill tone="slate">{sourceLabel(m.source, t)}</Pill>
                            {Number(m.size) > 0 && <span className="text-xs text-slate-400">{formatBytes(Number(m.size))}</span>}
                        </div>
                        {row(t('srv.sys.h.date'), fullDate(m.created_at, locale))}
                        {row(t('srv.sys.h.from'), m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address, false, true)}
                        {row(t('srv.sys.h.to'), m.to_address, false, true)}
                        {row(t('srv.sys.h.subject'), m.subject)}
                        {row(t('srv.sys.h.messageId'), m.message_id, true)}
                    </dl>
                    {m.last_error && m.status !== 'delivered' && (
                        <pre className="whitespace-pre-wrap break-all rounded-lg bg-red-50 p-2.5 font-mono text-[11px] text-red-700">{m.last_error}</pre>
                    )}
                    {(m.status === 'failed' || m.status === 'retry') && !m.queue && (
                        <p className="text-xs text-slate-500">{t('srv.sys.notInQueue')}</p>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5" role="tablist">
                            {(['html', 'text'] as const).map(v => (
                                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                                    className={cx('rounded-lg px-3 py-1 text-xs font-semibold', view === v ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                                    {v === 'html' ? t('srv.sys.tabHtml') : t('srv.sys.tabText')}
                                </button>
                            ))}
                        </div>
                        {view === 'html' && blocked > 0 && (
                            <Button size="sm" variant="ghost" icon={showImages ? 'fa-regular fa-eye-slash' : 'fa-regular fa-image'} onClick={() => setShowImages(v => !v)}>
                                {showImages ? t('srv.sys.hideImages') : t('srv.sys.showImages', { n: blocked })}
                            </Button>
                        )}
                    </div>
                    {view === 'html' ? (
                        m.html ? <SandboxedPreview html={m.html} showImages={showImages} title={t('srv.sys.tabHtml')} /> : <p className="text-sm text-slate-500">{t('srv.sys.noHtml')}</p>
                    ) : (
                        m.text ? <pre className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">{m.text}</pre> : <p className="text-sm text-slate-500">{t('srv.sys.noText')}</p>
                    )}
                </div>
            )}
        </Sheet>
    );
}

export default function SystemSent({ t, locale, toast, confirm, goQueue }: any) {
    const [data, setData] = useState<any>(null);
    const [q, setQ] = useState('');
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('');
    const [source, setSource] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [page, setPage] = useState(1);
    const [openId, setOpenId] = useState<number | null>(null);
    const seq = useRef(0);

    // The search box waits for a pause in typing before it asks the server.
    useEffect(() => { const id = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300); return () => clearTimeout(id); }, [q]);

    const load = async () => {
        const mine = ++seq.current;
        try {
            const params = new URLSearchParams();
            if (query) params.set('q', query);
            if (status) params.set('status', status);
            if (source) params.set('source', source);
            if (from) params.set('from', from);
            if (to) params.set('to', to);
            params.set('page', String(page));
            params.set('perPage', String(PER_PAGE));
            const d = await api(`/plugin/mail-server/admin/system-sent?${params.toString()}`) as any;
            if (mine === seq.current) setData(d);
        } catch (e: any) { toast('error', errorText(e, t)); }
    };
    useEffect(() => { load(); }, [query, status, source, from, to, page]);

    const filtered = !!(query || status || source || from || to);
    const clear = () => { setQ(''); setQuery(''); setStatus(''); setSource(''); setFrom(''); setTo(''); setPage(1); };
    const pages = data ? Math.max(1, Math.ceil((data.total || 0) / (data.perPage || PER_PAGE))) : 1;
    const setFilter = (fn: any) => (v: any) => { fn(v); setPage(1); };

    return (
        <div className="grid min-w-0 gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-2xl text-sm text-slate-500">{t('srv.sys.hint')}</p>
                <IconBtn icon="fa-solid fa-rotate-right" label={t('common.refresh')} onClick={load} />
            </div>
            {data && <RetentionCard t={t} days={Number(data.retentionDays)} choices={data.retentionChoices || [0, 7, 30, 90, 180]} confirm={confirm} toast={toast} onSaved={() => { setPage(1); load(); }} />}

            <Card bodyClass="grid gap-3 p-3 sm:p-4">
                <div className="relative">
                    <i className="fa-solid fa-magnifying-glass pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-400"></i>
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('srv.sys.search')} aria-label={t('srv.sys.search')} className={cx(inputCls, 'pl-9')} />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <select value={status} onChange={(e) => setFilter(setStatus)(e.target.value)} aria-label={t('srv.sys.fStatus')} className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm">
                        <option value="">{t('srv.sys.allStatuses')}</option>
                        {STATUSES.map(s => <option key={s} value={s}>{t(`srv.sys.st.${s}`)}</option>)}
                    </select>
                    <select value={source} onChange={(e) => setFilter(setSource)(e.target.value)} aria-label={t('srv.sys.fSource')} className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm">
                        <option value="">{t('srv.sys.allSources')}</option>
                        {((data && data.sources) || []).map((s: string) => <option key={s} value={s}>{sourceLabel(s, t)}</option>)}
                    </select>
                    <div className="min-w-0 sm:w-44"><DatePicker value={from} onChange={setFilter(setFrom)} max={to || undefined} ariaLabel={t('srv.sys.fFrom')} placeholder={t('srv.sys.fFrom')} className="w-full" /></div>
                    <div className="min-w-0 sm:w-44"><DatePicker value={to} onChange={setFilter(setTo)} min={from || undefined} ariaLabel={t('srv.sys.fTo')} placeholder={t('srv.sys.fTo')} className="w-full" /></div>
                    {filtered && <Button size="sm" variant="ghost" icon="fa-solid fa-xmark" className="col-span-2 sm:col-span-1" onClick={clear}>{t('srv.sys.clear')}</Button>}
                </div>
            </Card>

            {!data ? <div className="py-16 text-center"><Spinner className="text-2xl" /></div> : data.items.length === 0 ? (
                <Card><EmptyState icon="fa-solid fa-envelope-circle-check"
                    title={filtered ? t('srv.sys.noMatch') : Number(data.retentionDays) === 0 ? t('srv.sys.off') : t('srv.sys.empty')}
                    hint={!filtered && Number(data.retentionDays) === 0 ? t('srv.sys.offHint') : undefined} /></Card>
            ) : (
                <>
                    <ul className="grid min-w-0 gap-2">
                        {data.items.map((it: any) => {
                            const [tone, label, icon] = statusChip(it.status, t);
                            return (
                                <li key={it.id} className="min-w-0">
                                    <button type="button" onClick={() => setOpenId(it.id)}
                                        className="grid w-full min-w-0 gap-1.5 rounded-2xl border border-slate-200 bg-white p-3.5 text-left shadow-sm transition hover:border-violet-200 hover:bg-violet-50/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 sm:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-center sm:gap-4">
                                        <span className="order-1 text-xs text-slate-400 sm:order-none" title={fullDate(it.created_at, locale)}>{listDate(it.created_at, locale)}</span>
                                        <span className="order-3 min-w-0 break-all text-xs text-slate-600 sm:order-none sm:text-sm">{it.to_address}</span>
                                        <span className="order-2 min-w-0 truncate text-sm font-medium text-slate-900 sm:order-none">{it.subject || t('srv.sys.noSubject')}</span>
                                        <span className="order-4 flex flex-wrap items-center gap-1.5 sm:order-none sm:justify-end">
                                            <Pill tone="slate">{sourceLabel(it.source, t)}</Pill>
                                            <Pill tone={tone}><i className={icon}></i>{label}</Pill>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                        <span>{t('srv.sys.count', { n: data.total })}</span>
                        <div className="flex items-center gap-1.5">
                            <IconBtn icon="fa-solid fa-chevron-left" size="sm" label={t('srv.sys.prev')} disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} />
                            <span>{t('srv.sys.page', { page, pages })}</span>
                            <IconBtn icon="fa-solid fa-chevron-right" size="sm" label={t('srv.sys.next')} disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))} />
                        </div>
                    </div>
                </>
            )}
            <Detail id={openId} t={t} locale={locale} toast={toast} onClose={() => setOpenId(null)} onChanged={load} goQueue={goQueue} />
        </div>
    );
}
