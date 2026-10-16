// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend tsc.
"use client";

import { useEffect, useState } from "react";
import { api } from "../../../../../frontend/src/lib/api";
import { cx, Sheet, Button, IconBtn, Field, Toggle, Checkbox, inputCls, EmptyState, Pill } from "./ui";

const FIELDS = ['from', 'to', 'subject', 'body', 'any'];
const OPS = ['contains', 'not_contains', 'equals', 'starts', 'ends'];
const newId = () => Math.random().toString(36).slice(2, 10);

export const SHORTCUTS = [
    ['c', 'kb.compose'], ['/', 'kb.search'], ['j', 'kb.next'], ['k', 'kb.prev'], ['o / Enter', 'kb.open'],
    ['u / Esc', 'kb.back'], ['r', 'kb.reply'], ['a', 'kb.replyAll'], ['f', 'kb.forward'], ['e', 'kb.archive'],
    ['#', 'kb.delete'], ['s', 'kb.star'], ['Shift + U', 'kb.unread'], ['x', 'kb.select'], ['g i', 'kb.goInbox'],
    ['Ctrl + Enter', 'kb.send'], ['?', 'kb.help'],
];

export function ShortcutList({ t }: any) {
    return (
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {SHORTCUTS.map(([k, label]) => (
                <div key={k} className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5">
                    <dt className="text-sm text-slate-600">{t(label)}</dt>
                    <dd><kbd className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-700">{k}</kbd></dd>
                </div>
            ))}
        </dl>
    );
}

function FilterCard({ rule, labels, t, onChange, onDelete }: any) {
    const [open, setOpen] = useState(!rule.conditions?.[0]?.value);
    const set = (patch: any) => onChange({ ...rule, ...patch });
    const setCond = (i: number, patch: any) => set({ conditions: rule.conditions.map((c: any, j: number) => j === i ? { ...c, ...patch } : c) });
    const setAct = (patch: any) => set({ actions: { ...rule.actions, ...patch } });
    const summary = (rule.conditions || []).filter((c: any) => c.value).map((c: any) => `${t('set.field.' + c.field)} ${t('set.op.' + c.op)} “${c.value}”`).join(rule.match === 'any' ? ' · ' : ' + ');
    const acts = [];
    const lbl = labels.find((l: any) => l.id === rule.actions?.labelId);
    if (lbl) acts.push(<Pill key="l" tone="violet"><span className="h-2 w-2 rounded-full" style={{ background: lbl.color }}></span>{lbl.name}</Pill>);
    for (const k of ['markRead', 'star', 'archive', 'trash', 'spam', 'neverSpam', 'stop']) if (rule.actions?.[k]) acts.push(<Pill key={k}>{t('set.action.' + k)}</Pill>);

    return (
        <div className={cx('rounded-xl border bg-white', rule.enabled === false ? 'border-slate-200 opacity-70' : 'border-slate-200')}>
            <div className="flex items-start gap-3 p-3">
                <button type="button" onClick={() => setOpen(o => !o)} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-sm font-semibold text-slate-800">{rule.name || summary || t('set.newFilter')}</div>
                    {summary && <div className="mt-0.5 truncate text-xs text-slate-500">{summary}</div>}
                    {acts.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{acts}</div>}
                </button>
                <div className="flex items-center gap-1">
                    <button
                        type="button" role="switch" aria-checked={rule.enabled !== false} title={rule.enabled !== false ? t('common.enabled') : t('common.disabled')}
                        onClick={() => set({ enabled: rule.enabled === false })}
                        className={cx('relative h-5 w-9 rounded-full transition-colors', rule.enabled !== false ? 'bg-violet-600' : 'bg-slate-300')}
                    >
                        <span className={cx('absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', rule.enabled !== false && 'translate-x-4')}></span>
                    </button>
                    <IconBtn size="sm" icon={open ? 'fa-solid fa-chevron-up' : 'fa-solid fa-pen'} label={t('common.edit')} onClick={() => setOpen(o => !o)} />
                    <IconBtn size="sm" icon="fa-regular fa-trash-can" label={t('common.delete')} danger onClick={onDelete} />
                </div>
            </div>
            {open && (
                <div className="grid gap-4 border-t border-slate-100 p-3 sm:p-4">
                    <Field label={t('set.filterName')}>
                        <input className={inputCls} value={rule.name || ''} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
                    </Field>
                    <div>
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-slate-700">
                            {t('set.filterMatch')}
                            <select className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[13px] font-normal" value={rule.match || 'all'} onChange={(e) => set({ match: e.target.value })}>
                                <option value="all">{t('set.matchAll')}</option>
                                <option value="any">{t('set.matchAny')}</option>
                            </select>
                        </div>
                        <div className="grid gap-2">
                            {rule.conditions.map((c: any, i: number) => (
                                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[130px_150px_1fr_auto]">
                                    <select className={cx(inputCls, 'py-2')} value={c.field} onChange={(e) => setCond(i, { field: e.target.value })}>
                                        {FIELDS.map(f => <option key={f} value={f}>{t('set.field.' + f)}</option>)}
                                    </select>
                                    <select className={cx(inputCls, 'py-2')} value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                                        {OPS.map(o => <option key={o} value={o}>{t('set.op.' + o)}</option>)}
                                    </select>
                                    <input className={cx(inputCls, 'col-span-2 py-2 sm:col-span-1')} value={c.value} maxLength={200} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="…" />
                                    <IconBtn icon="fa-solid fa-xmark" label={t('common.delete')} disabled={rule.conditions.length <= 1} onClick={() => set({ conditions: rule.conditions.filter((_: any, j: number) => j !== i) })} className="hidden sm:inline-flex" />
                                </div>
                            ))}
                        </div>
                        {rule.conditions.length < 10 && (
                            <Button size="sm" variant="ghost" icon="fa-solid fa-plus" className="mt-2" onClick={() => set({ conditions: [...rule.conditions, { field: 'subject', op: 'contains', value: '' }] })}>{t('set.addCondition')}</Button>
                        )}
                    </div>
                    <div>
                        <div className="mb-2 text-[13px] font-semibold text-slate-700">{t('set.then')}</div>
                        <div className="grid gap-2.5 sm:grid-cols-2">
                            <label className="flex items-center gap-2.5 text-sm text-slate-700 sm:col-span-2">
                                <input type="checkbox" className="h-4 w-4 accent-violet-600" checked={!!rule.actions.labelId} onChange={(e) => setAct({ labelId: e.target.checked ? (labels[0]?.id || 0) : 0 })} disabled={labels.length === 0} />
                                <span>{t('set.action.label')}</span>
                                {!!rule.actions.labelId && (
                                    <select className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm" value={rule.actions.labelId} onChange={(e) => setAct({ labelId: parseInt(e.target.value, 10) })}>
                                        {labels.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
                                    </select>
                                )}
                            </label>
                            {['markRead', 'star', 'archive', 'trash', 'spam', 'neverSpam', 'stop'].map(k => (
                                <Checkbox key={k} label={t('set.action.' + k)} checked={!!rule.actions[k]} onChange={(v: boolean) => setAct({ [k]: v })} />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function MailSettings({ open, onClose, t, labels, density, setDensity, showPreview, setShowPreview, onSaved, onError, initialTab = 'general', seedRule }: any) {
    const [tab, setTab] = useState(initialTab);
    const [prefs, setPrefs] = useState<any>(null);
    const [saving, setSaving] = useState(false);
    const [blockInput, setBlockInput] = useState('');

    useEffect(() => {
        if (!open) return;
        setTab(initialTab);
        (async () => {
            try {
                const p: any = await api('/plugin/mail-server/prefs');
                // "Filter messages like this" opens the filters tab with a pre-filled rule to finish.
                if (seedRule) p.rules = [...(p.rules || []), seedRule];
                setPrefs(p);
            }
            catch (e: any) { onError(e?.message || t('common.error')); }
        })();
    }, [open, initialTab]);

    const set = (patch: any) => setPrefs((p: any) => ({ ...(p || {}), ...patch }));
    const setVac = (patch: any) => set({ vacation: { ...(prefs?.vacation || {}), ...patch } });
    const setFwd = (patch: any) => set({ forwarding: { ...(prefs?.forwarding || {}), ...patch } });

    const save = async () => {
        if (!prefs) return;
        const bad = (prefs.rules || []).some((r: any) => !(r.conditions || []).some((c: any) => String(c.value || '').trim()));
        if (bad) { setTab('filters'); onError(t('set.filterNeedsCondition')); return; }
        setSaving(true);
        try {
            const body: any = {
                signature: prefs.signature || '',
                vacation: prefs.vacation || {},
                rules: prefs.rules || [],
                blockedSenders: prefs.blockedSenders || [],
                templates: prefs.templates || [],
            };
            // Only send forwarding when it is allowed or being switched off — the server refuses enabling it otherwise.
            if (prefs.forwardingAllowed || !prefs.forwarding?.enabled) body.forwarding = prefs.forwarding || {};
            await api('/plugin/mail-server/prefs', { method: 'PUT', body });
            onSaved(prefs);
            onClose();
        } catch (e: any) {
            onError(e?.message || t('common.error'));
        } finally {
            setSaving(false);
        }
    };

    const TABS = [
        ['general', 'fa-solid fa-sliders', t('set.general')],
        ['vacation', 'fa-solid fa-umbrella-beach', t('set.vacation')],
        ['filters', 'fa-solid fa-filter', t('set.filters')],
        ['blocked', 'fa-solid fa-ban', t('set.blocked')],
        ['forwarding', 'fa-solid fa-share', t('set.forwarding')],
        ['templates', 'fa-regular fa-file-lines', t('set.templates')],
        ['shortcuts', 'fa-regular fa-keyboard', t('set.shortcuts')],
    ];

    const addBlocked = () => {
        const v = blockInput.trim().toLowerCase();
        if (!v) return;
        const list = prefs.blockedSenders || [];
        if (!list.includes(v)) set({ blockedSenders: [...list, v] });
        setBlockInput('');
    };

    return (
        <Sheet
            open={open}
            onClose={onClose}
            title={t('set.title')}
            wide
            bodyClass="p-0"
            footer={tab !== 'shortcuts' && (
                <>
                    <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" loading={saving} disabled={!prefs} onClick={save}>{t('common.save')}</Button>
                </>
            )}
        >
            <div className="flex h-full min-h-[420px] flex-col sm:flex-row">
                <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-100 p-2 [scrollbar-width:none] sm:w-52 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3">
                    {TABS.map(([id, icon, label]) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setTab(id)}
                            className={cx('flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors', tab === id ? 'bg-violet-50 font-semibold text-violet-700' : 'text-slate-600 hover:bg-slate-50')}
                        >
                            <i className={cx(icon, 'w-4 text-center')}></i>{label}
                        </button>
                    ))}
                </nav>
                <div className="min-w-0 flex-1 p-4 sm:p-6">
                    {!prefs ? (
                        <div className="py-16 text-center text-sm text-slate-500"><i className="fa-solid fa-circle-notch fa-spin mr-2 text-violet-500"></i>{t('common.loading')}</div>
                    ) : tab === 'general' ? (
                        <div className="grid gap-6">
                            <Field label={t('set.signature')} hint={t('set.signatureHint')}>
                                <textarea className={cx(inputCls, 'min-h-[110px] resize-y')} value={prefs.signature || ''} maxLength={5000} onChange={(e) => set({ signature: e.target.value })} placeholder={'Jane Doe\nAcme · +34 600 000 000'} />
                            </Field>
                            <div className="grid gap-4 rounded-xl border border-slate-200 p-4">
                                <div className="text-[13px] font-semibold text-slate-700">{t('set.display')}</div>
                                <div className="flex flex-wrap gap-2">
                                    {[['comfortable', t('set.densityComfortable')], ['compact', t('set.densityCompact')]].map(([v, l]) => (
                                        <button key={v} type="button" onClick={() => setDensity(v)} className={cx('rounded-lg border px-3 py-1.5 text-sm', density === v ? 'border-violet-300 bg-violet-50 font-semibold text-violet-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>{l}</button>
                                    ))}
                                </div>
                                <Toggle label={t('set.previewLines')} checked={showPreview} onChange={setShowPreview} />
                            </div>
                        </div>
                    ) : tab === 'vacation' ? (
                        <div className="grid gap-5">
                            <Toggle label={t('set.vacationTitle')} hint={t('set.vacationHint')} checked={!!prefs.vacation?.enabled} onChange={(v: boolean) => setVac({ enabled: v })} />
                            <fieldset disabled={!prefs.vacation?.enabled} className={cx('grid gap-4', !prefs.vacation?.enabled && 'opacity-50')}>
                                <Field label={t('set.vacationSubject')}>
                                    <input className={inputCls} value={prefs.vacation?.subject || ''} maxLength={180} onChange={(e) => setVac({ subject: e.target.value })} />
                                </Field>
                                <Field label={t('set.vacationMessage')}>
                                    <textarea className={cx(inputCls, 'min-h-[120px] resize-y')} value={prefs.vacation?.message || ''} maxLength={5000} onChange={(e) => setVac({ message: e.target.value })} />
                                </Field>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <Field label={t('set.vacationFrom')}>
                                        <input type="date" className={inputCls} value={(prefs.vacation?.startsAt || '').slice(0, 10)} onChange={(e) => setVac({ startsAt: e.target.value })} />
                                    </Field>
                                    <Field label={t('set.vacationUntil')}>
                                        <input type="date" className={inputCls} value={(prefs.vacation?.endsAt || '').slice(0, 10)} onChange={(e) => setVac({ endsAt: e.target.value })} />
                                    </Field>
                                </div>
                            </fieldset>
                        </div>
                    ) : tab === 'filters' ? (
                        <div className="grid gap-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <p className="max-w-md text-sm text-slate-500">{t('set.filtersHint')}</p>
                                <Button size="sm" variant="primary" icon="fa-solid fa-plus" disabled={(prefs.rules || []).length >= 50} onClick={() => set({ rules: [...(prefs.rules || []), { id: newId(), name: '', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: {} }] })}>
                                    {t('set.newFilter')}
                                </Button>
                            </div>
                            {(prefs.rules || []).length === 0
                                ? <EmptyState icon="fa-solid fa-filter" title={t('set.noFilters')} className="py-10" />
                                : (prefs.rules || []).map((r: any, i: number) => (
                                    <FilterCard key={r.id || i} rule={r} labels={labels} t={t}
                                        onChange={(nr: any) => set({ rules: prefs.rules.map((x: any, j: number) => j === i ? nr : x) })}
                                        onDelete={() => set({ rules: prefs.rules.filter((_: any, j: number) => j !== i) })} />
                                ))}
                        </div>
                    ) : tab === 'blocked' ? (
                        <div className="grid gap-4">
                            <p className="text-sm text-slate-500">{t('set.blockedHint')}</p>
                            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addBlocked(); }}>
                                <input className={inputCls} value={blockInput} onChange={(e) => setBlockInput(e.target.value)} placeholder={t('set.blockedPlaceholder')} />
                                <Button type="submit" variant="secondary" icon="fa-solid fa-plus">{t('common.add')}</Button>
                            </form>
                            {(prefs.blockedSenders || []).length === 0
                                ? <EmptyState icon="fa-solid fa-user-slash" title={t('set.noBlocked')} className="py-10" />
                                : (
                                    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                                        {(prefs.blockedSenders || []).map((b: string) => (
                                            <li key={b} className="flex items-center gap-3 px-3 py-2">
                                                <i className={cx(b.startsWith('@') ? 'fa-solid fa-globe' : 'fa-regular fa-user', 'w-4 text-center text-slate-400')}></i>
                                                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{b}</span>
                                                <IconBtn size="sm" icon="fa-solid fa-xmark" label={t('common.delete')} onClick={() => set({ blockedSenders: prefs.blockedSenders.filter((x: string) => x !== b) })} />
                                            </li>
                                        ))}
                                    </ul>
                                )}
                        </div>
                    ) : tab === 'forwarding' ? (
                        <div className="grid gap-5">
                            {!prefs.forwardingAllowed && (
                                <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                                    <i className="fa-solid fa-lock mt-0.5"></i>{t('set.forwardingDisabled')}
                                </div>
                            )}
                            <Toggle label={t('set.forwarding')} hint={t('set.forwardingHint')} disabled={!prefs.forwardingAllowed} checked={!!prefs.forwarding?.enabled} onChange={(v: boolean) => setFwd({ enabled: v })} />
                            <fieldset disabled={!prefs.forwarding?.enabled || !prefs.forwardingAllowed} className={cx('grid gap-4', (!prefs.forwarding?.enabled || !prefs.forwardingAllowed) && 'opacity-50')}>
                                <Field label={t('set.forwardingTo')}>
                                    <input type="email" className={inputCls} value={prefs.forwarding?.address || ''} onChange={(e) => setFwd({ address: e.target.value })} placeholder="name@example.com" />
                                </Field>
                                <div className="grid gap-2">
                                    <label className="flex items-center gap-2.5 text-sm text-slate-700"><input type="radio" className="accent-violet-600" checked={prefs.forwarding?.keepCopy !== false} onChange={() => setFwd({ keepCopy: true })} />{t('set.forwardingKeep')}</label>
                                    <label className="flex items-center gap-2.5 text-sm text-slate-700"><input type="radio" className="accent-violet-600" checked={prefs.forwarding?.keepCopy === false} onChange={() => setFwd({ keepCopy: false })} />{t('set.forwardingArchive')}</label>
                                </div>
                            </fieldset>
                        </div>
                    ) : tab === 'templates' ? (
                        <div className="grid gap-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <p className="max-w-md text-sm text-slate-500">{t('set.templatesHint')}</p>
                                <Button size="sm" variant="primary" icon="fa-solid fa-plus" disabled={(prefs.templates || []).length >= 30} onClick={() => set({ templates: [...(prefs.templates || []), { id: newId(), name: '', subject: '', body: '' }] })}>{t('set.newTemplate')}</Button>
                            </div>
                            {(prefs.templates || []).length === 0
                                ? <EmptyState icon="fa-regular fa-file-lines" title={t('set.noTemplates')} className="py-10" />
                                : (prefs.templates || []).map((tpl: any, i: number) => {
                                    const upd = (patch: any) => set({ templates: prefs.templates.map((x: any, j: number) => j === i ? { ...x, ...patch } : x) });
                                    return (
                                        <div key={tpl.id || i} className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:p-4">
                                            <div className="flex gap-2">
                                                <input className={inputCls} value={tpl.name} maxLength={80} placeholder={t('set.templateName')} onChange={(e) => upd({ name: e.target.value })} />
                                                <IconBtn icon="fa-regular fa-trash-can" label={t('common.delete')} danger onClick={() => set({ templates: prefs.templates.filter((_: any, j: number) => j !== i) })} />
                                            </div>
                                            <input className={inputCls} value={tpl.subject || ''} maxLength={200} placeholder={t('set.templateSubject')} onChange={(e) => upd({ subject: e.target.value })} />
                                            <textarea className={cx(inputCls, 'min-h-[100px] resize-y')} value={tpl.body} placeholder={t('set.templateBody')} onChange={(e) => upd({ body: e.target.value })} />
                                        </div>
                                    );
                                })}
                        </div>
                    ) : (
                        <ShortcutList t={t} />
                    )}
                </div>
            </div>
        </Sheet>
    );
}
