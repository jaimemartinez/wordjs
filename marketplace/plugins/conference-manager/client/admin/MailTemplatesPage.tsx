// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Plantillas de correo» (2.36.11, WordJS administrators): every e-mail the plugin sends — the consent link, code
 * and copy, the badge, the coordinator's welcome — in Spanish, English and Portuguese. The texts are plain text with
 * a tiny markup (**negrita**, «- » lists, [texto](https://…)): typed HTML shows as text. The link, the code and the
 * record of the authorization are drawn by the layout — never editable.
 *
 * 2.36.14 (owner: «no es nada user friendly»), for a coordinator who knows nothing about markup:
 * - The list: one card per e-mail — its name, WHEN it is sent, «Personalizado / Original», the last edit, «Editar».
 * - The editor: the form beside a LIVE preview (rendered by the server — the same code that sends it — in a
 *   sandboxed frame, desktop or phone width); on a phone, one at a time with a sticky «Editar / Vista previa» switch.
 * - A formatting toolbar (Negrita, Lista, Enlace) writes the markup at the cursor; the placeholders read as names
 *   («{Nombre de la persona}», lib/mailEditor toDisplay / fromDisplay) and insert from chips that show an example.
 * - Languages as tabs with a dot when customised; a sticky footer (Guardar, Enviar prueba, Restaurar original —
 *   in-app confirm) that says when there are unsaved changes; leaving with unsaved changes asks first (in-app, and
 *   the browser's own prompt on a reload). Errors are said under their field before anything is sent.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { conferenceApi } from "../lib/conference";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useTx } from "./MealScanner";
import { applyBold, applyLink, applyList, badLinks, chipToken, fromDisplay, insertAt, isDirty, isSafeUrl, lastEdited, toDisplay } from "../lib/mailEditor";

const LANG_NAMES = { es: 'Español', en: 'English', pt: 'Português' };
const ICON = { 'consent.link': 'fa-file-signature', 'consent.code': 'fa-key', 'consent.confirmation': 'fa-file-circle-check', 'badge.link': 'fa-id-badge', 'location.welcome': 'fa-handshake' };
const field = 'w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 text-base sm:text-sm bg-white focus:border-blue-500 outline-none aria-[invalid=true]:border-rose-400';
const label = 'block text-sm font-bold text-gray-800';
const hint = 'block text-xs text-gray-500 mt-0.5 mb-1.5';
const btn = 'min-h-[44px] px-4 rounded-xl text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50';
const tool = 'min-h-[36px] px-3 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 text-gray-700 hover:bg-gray-100';
const EMPTY = { subject: '', body: '', after: '', action: '' };

export default function MailTemplatesPage() {
    const tx = useTx();
    const { language } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const ui = ['es', 'en', 'pt'].includes(String(language || 'es').slice(0, 2)) ? String(language || 'es').slice(0, 2) : 'es';
    const [data, setData] = useState<any>(null);
    const [loadError, setLoadError] = useState('');
    const [id, setId] = useState<string | null>(null);
    const [lang, setLang] = useState(ui);
    const [draft, setDraft] = useState(EMPTY);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
    const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
    const [pane, setPane] = useState<'form' | 'preview'>('form');
    const [busy, setBusy] = useState('');
    const [linkFor, setLinkFor] = useState<string | null>(null);
    const [linkDraft, setLinkDraft] = useState({ text: '', url: 'https://' });
    const refs = { subject: useRef(null), body: useRef(null), after: useRef(null), action: useRef(null) };
    const lastField = useRef<string>('body');

    const load = () => conferenceApi.getMailTemplates().then(setData).catch((e) => setLoadError(e?.message || 'Error'));
    useEffect(() => { load(); }, []);
    const tpl = useMemo(() => (data && id ? data.templates.find((t) => t.id === id) : null), [data, id]);
    const edited = !!(tpl && tpl.edits && tpl.edits[lang]);
    // What is stored for this message and language (its edit, else its default), as the admin reads it.
    const base = useMemo(() => {
        if (!tpl) return EMPTY;
        const src = (tpl.edits && tpl.edits[lang]) || tpl.defaults[lang];
        const d = (s) => toDisplay(s || '', tpl.placeholders, ui);
        return { subject: d(src.subject), body: d(src.body), after: d(src.after), action: src.action || '' };
    }, [tpl, lang, ui]);
    useEffect(() => { setDraft(base); setErrors({}); setLinkFor(null); }, [base]);
    const dirty = !!tpl && isDirty(draft, base);
    // What the server stores and renders: the placeholders back to their keys.
    const payload = () => ({ lang, subject: fromDisplay(draft.subject, tpl.placeholders, ui), body: fromDisplay(draft.body, tpl.placeholders, ui), after: fromDisplay(draft.after, tpl.placeholders, ui), action: draft.action });

    // The live preview, rendered by the server from the draft as it is typed (debounced).
    useEffect(() => {
        if (!tpl || !draft.subject.trim()) return undefined;
        const t = setTimeout(() => {
            conferenceApi.previewMailTemplate(tpl.id, payload()).then((r) => setPreview({ subject: r.subject, html: r.html })).catch(() => {});
        }, 300);
        return () => clearTimeout(t);
    }, [tpl, lang, draft.subject, draft.body, draft.after, draft.action]); // eslint-disable-line react-hooks/exhaustive-deps

    // A reload or a closed tab with unsaved changes: the browser asks.
    useEffect(() => {
        if (!dirty) return undefined;
        const on = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
        window.addEventListener('beforeunload', on);
        return () => window.removeEventListener('beforeunload', on);
    }, [dirty]);
    // Leaving the message (another language, the list) with unsaved changes: asked in-app first.
    const leave = async (go: () => void) => {
        if (dirty && !await confirm(tx('mail.leave.confirm', 'Tienes cambios sin guardar. Si sales, se pierden.'), tx('mail.leave', 'Salir sin guardar'), true)) return;
        go();
    };

    const set = (k: string, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
    /** Apply a toolbar / chip edit to field `name` at its selection, and put the cursor where the edit says. */
    const edit = (name: string, fn: (value: string, start: number, end: number) => { value: string; start: number; end: number }) => {
        const el = refs[name] && refs[name].current;
        const cur = draft[name] || '';
        const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : cur.length;
        const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
        const r = fn(cur, start, end);
        set(name, r.value);
        if (el) requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(r.start, r.end); } catch { /* ignore */ } });
    };
    const insert = (p) => {
        // A placeholder only the subject can carry («Código») goes to the subject.
        const name = p.subject_only ? 'subject' : (lastField.current || 'body');
        edit(name, (v, a, b) => insertAt(v, a, b, chipToken(p, ui)));
    };
    const addLink = () => {
        if (!isSafeUrl(linkDraft.url)) { setErrors((e) => ({ ...e, link: tx('mail.link.bad', 'El enlace debe empezar por https:// (o mailto: para un correo).') })); return; }
        const name = linkFor;
        setLinkFor(null);
        edit(name, (v, a, b) => applyLink(v, a, b, linkDraft.text || v.slice(a, b), linkDraft.url));
    };

    const fail = (e: any) => {
        const f = e && (e.field || (e.data && e.data.field));
        if (f) setErrors((x) => ({ ...x, [f]: e.message }));
        else addToast(e?.message || 'Error', 'error');
    };
    // Said in place before anything is sent (the server checks again).
    const checked = () => {
        const e: Record<string, string> = {};
        if (!draft.subject.trim()) e.subject = tx('mail.subject.missing', 'Escribe el asunto.');
        if (!draft.body.trim()) e.body = tx('mail.body.missing', 'Escribe el texto del correo.');
        for (const k of ['body', 'after']) if (!e[k] && badLinks(draft[k]).length) e[k] = tx('mail.link.bad', 'El enlace debe empezar por https:// (o mailto: para un correo).');
        setErrors(e);
        if (Object.keys(e).length) setPane('form');
        return !Object.keys(e).length;
    };
    const save = async () => {
        if (!checked()) return;
        setBusy('save');
        try {
            await conferenceApi.saveMailTemplate(tpl.id, payload());
            addToast(tx('mail.saved', 'Plantilla guardada.'), 'success');
            await load();
        } catch (e) { fail(e); } finally { setBusy(''); }
    };
    const restore = async () => {
        if (!await confirm(tx('mail.restore.confirm', 'Se borra lo que cambiaste en este idioma y vuelve el texto original.'), tx('mail.restore', 'Restaurar original'), true)) return;
        setBusy('restore');
        try { await conferenceApi.restoreMailTemplate(tpl.id, lang); addToast(tx('mail.restored', 'Se restauró el texto original.'), 'success'); await load(); }
        catch (e) { fail(e); } finally { setBusy(''); }
    };
    const test = async () => {
        if (!checked()) return;
        setBusy('test');
        try {
            const r = await conferenceApi.testMailTemplate(tpl.id, payload());
            addToast(tx('mail.test.sent', 'Enviamos la prueba a {email}.').replace('{email}', r.to_masked || ''), 'success');
        } catch (e) { fail(e); } finally { setBusy(''); }
    };

    const fmtDate = (iso: string) => { try { return new Intl.DateTimeFormat(ui, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); } catch { return String(iso).slice(0, 10); } };
    const nameOf = (t) => t.name[ui] || t.name.es;
    const whenOf = (t) => tx(`mail.when.${t.id}`, t.description[ui] || t.description.es);

    if (loadError) return <p role="alert" className="text-sm text-rose-700">{loadError}</p>;
    if (!data) return <p className="text-sm text-gray-400" role="status">{tx('loading', 'Cargando…')}</p>;

    // ── The list ─────────────────────────────────────────────────────────────────────────────────────────────
    if (!tpl) {
        return (
            <div className="space-y-5" data-mail-templates="" data-mail-view="list">
                <div>
                    <h2 className="text-xl font-black text-gray-900">{tx('mail.templates', 'Plantillas de correo')}</h2>
                    <p className="text-sm text-gray-500 mt-1 max-w-3xl">{tx('mail.templates.intro', 'Los correos que la conferencia envía sola. Puedes cambiar sus textos en español, inglés y portugués; el enlace, el código y el registro de lo autorizado los pone el sistema.')}</p>
                </div>
                <ul className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4" data-mail-cards="">
                    {data.templates.map((t) => {
                        const langs = Object.keys(t.edits || {});
                        const last = lastEdited(t.edits);
                        return (
                            <li key={t.id} className="rounded-2xl border-2 border-gray-100 bg-white p-4 sm:p-5 flex flex-col gap-3 min-w-0" data-mail-template={t.id}>
                                <div className="flex items-start gap-3 min-w-0">
                                    <span className="w-10 h-10 shrink-0 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><i className={`fa-solid ${ICON[t.id] || 'fa-envelope'}`} aria-hidden="true"></i></span>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="text-base font-bold text-gray-900 leading-snug">{nameOf(t)}</h3>
                                        <p className="text-sm text-gray-600 mt-1" data-mail-when="">{whenOf(t)}</p>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 mt-auto">
                                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${langs.length ? 'bg-amber-50 text-amber-800' : 'bg-gray-100 text-gray-600'}`} data-mail-state={langs.length ? 'custom' : 'original'}>
                                        {langs.length ? `${tx('mail.custom', 'Personalizado')} · ${langs.map((l) => l.toUpperCase()).join(', ')}` : tx('mail.original', 'Original')}
                                    </span>
                                    {last && <span className="text-xs text-gray-500" data-mail-edited="">{tx('mail.edited.at', 'Editado el {date}').replace('{date}', fmtDate(last))}</span>}
                                    <button type="button" className={`${btn} ml-auto bg-blue-600 text-white hover:bg-blue-700`} onClick={() => { setId(t.id); setPane('form'); }} data-mail-edit={t.id}>
                                        <i className="fa-solid fa-pen" aria-hidden="true"></i>{tx('edit', 'Editar')}
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </div>
        );
    }

    // ── The editor ───────────────────────────────────────────────────────────────────────────────────────────
    const blockWord = tpl.block === 'action' ? tx('mail.block.action', 'del botón') : tpl.block === 'code' ? tx('mail.block.code', 'del código') : tx('mail.block.record', 'del registro de lo autorizado');
    const err = (k) => errors[k] ? <p id={`cm-mail-${k}-error`} role="alert" className="mt-1 text-xs font-semibold text-rose-600" data-mail-error={k}>{errors[k]}</p> : null;
    const remember = (name) => () => { lastField.current = name; };
    const toolbar = (name) => (
        <div className="flex flex-wrap items-center gap-1 rounded-t-xl border-2 border-b-0 border-gray-100 bg-gray-50 px-1.5 py-1" role="toolbar" aria-label={tx('mail.format', 'Formato')} data-mail-toolbar={name}>
            <button type="button" className={tool} onMouseDown={(e) => e.preventDefault()} onClick={() => edit(name, (v, a, b) => applyBold(v, a, b, tx('mail.format.word', 'texto')))} data-mail-format="bold">
                <i className="fa-solid fa-bold" aria-hidden="true"></i>{tx('mail.format.bold', 'Negrita')}
            </button>
            <button type="button" className={tool} onMouseDown={(e) => e.preventDefault()} onClick={() => edit(name, applyList)} data-mail-format="list">
                <i className="fa-solid fa-list-ul" aria-hidden="true"></i>{tx('mail.format.list', 'Lista')}
            </button>
            <button type="button" className={tool} onMouseDown={(e) => e.preventDefault()} aria-expanded={linkFor === name} data-mail-format="link" onClick={() => {
                const el = refs[name].current;
                const sel = el ? (draft[name] || '').slice(el.selectionStart, el.selectionEnd) : '';
                setLinkDraft({ text: sel, url: 'https://' });
                setErrors((x) => ({ ...x, link: '' }));
                setLinkFor(linkFor === name ? null : name);
            }}>
                <i className="fa-solid fa-link" aria-hidden="true"></i>{tx('mail.format.link', 'Enlace')}
            </button>
        </div>
    );
    const linkForm = (name) => linkFor === name && (
        <div className="mt-2 rounded-xl border-2 border-blue-100 bg-blue-50/60 p-3 space-y-2" data-mail-link-form={name}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="block text-xs font-bold text-gray-700">{tx('mail.link.text', 'Texto que se ve')}
                    <input className={`${field} mt-1`} value={linkDraft.text} onChange={(e) => setLinkDraft((d) => ({ ...d, text: e.target.value }))} placeholder={tx('mail.link.text.example', 'Ej.: Ver la política de datos')} data-mail-link-text="" />
                </label>
                <label className="block text-xs font-bold text-gray-700">{tx('mail.link.url', 'Dirección (https://…)')}
                    <input className={`${field} mt-1`} type="url" inputMode="url" value={linkDraft.url} onChange={(e) => { setLinkDraft((d) => ({ ...d, url: e.target.value })); setErrors((x) => ({ ...x, link: '' })); }}
                        aria-invalid={errors.link ? true : undefined} aria-describedby={errors.link ? 'cm-mail-link-error' : undefined} data-mail-link-url="" />
                </label>
            </div>
            {err('link')}
            <div className="flex flex-wrap gap-2">
                <button type="button" className={`${btn} bg-blue-600 text-white`} onClick={addLink} data-mail-link-add="">{tx('mail.link.add', 'Insertar enlace')}</button>
                <button type="button" className={`${btn} text-gray-600 hover:bg-gray-100`} onClick={() => setLinkFor(null)}>{tx('cancel', 'Cancelar')}</button>
            </div>
        </div>
    );
    const area = (name, rows, max, title, sub, example) => (
        <div>
            <label htmlFor={`cm-mail-${name}`} className={label}>{title}</label>
            <span className={hint}>{sub}</span>
            {toolbar(name)}
            <textarea id={`cm-mail-${name}`} ref={refs[name]} rows={rows} className={`${field} rounded-t-none`} value={draft[name]} maxLength={max} placeholder={example}
                onFocus={remember(name)} onChange={(e) => set(name, e.target.value)} aria-invalid={errors[name] ? true : undefined} aria-describedby={errors[name] ? `cm-mail-${name}-error` : undefined} />
            {err(name)}
            {linkForm(name)}
        </div>
    );
    const chips = (
        <div className="space-y-2" data-mail-chips="">
            <p className={label}>{tx('mail.chips', 'Datos de cada persona')}</p>
            <p className="text-xs text-gray-500 -mt-1">{tx('mail.chips.hint', 'Toca uno para ponerlo donde está el cursor. En el correo se cambia por el dato real.')}</p>
            <div className="flex flex-wrap gap-2">
                {tpl.placeholders.map((p) => {
                    const sample = p.sample ? (p.sample[ui] || p.sample.es) : '';
                    return (
                        <button key={p.key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p)} data-mail-placeholder={p.key}
                            title={`${tx('mail.chip.example', 'Ejemplo: {value}').replace('{value}', sample)}${p.subject_only ? ` · ${tx('mail.subject.only', 'Solo en el asunto')}` : ''}`}
                            className="min-h-[36px] px-3 rounded-full border-2 border-blue-100 bg-blue-50 text-xs font-bold text-blue-800 hover:border-blue-400 inline-flex items-center gap-1.5">
                            <i className="fa-solid fa-plus text-[9px]" aria-hidden="true"></i>{p.label[ui] || p.label.es}
                            {sample && <span className="font-normal text-blue-700/70">· {sample}</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
    const previewPane = (
        <section className="space-y-3 min-w-0" aria-label={tx('mail.preview', 'Vista previa')} data-mail-preview-pane="">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-gray-800">{tx('mail.preview.live', 'Así lo verá la persona')}</h3>
                <div className="hidden lg:flex gap-1" role="group" aria-label={tx('mail.device', 'Pantalla')}>
                    {[['desktop', 'fa-desktop', tx('mail.desktop', 'Computador')], ['mobile', 'fa-mobile-screen', tx('mail.mobile', 'Celular')]].map(([d, icon, name]) => (
                        <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)} data-mail-device={d}
                            className={`min-h-[36px] px-3 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 ${device === d ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-700'}`}>
                            <i className={`fa-solid ${icon}`} aria-hidden="true"></i>{name}
                        </button>
                    ))}
                </div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm min-w-0" data-mail-preview-subject="">
                <span className="text-gray-500">{tx('mail.subject', 'Asunto')}:</span> <span className="font-semibold text-gray-900 break-words">{preview ? preview.subject : '…'}</span>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-gray-100 p-2 overflow-hidden">
                {/* sandbox="": no scripts, no forms, no top navigation — the e-mail is only looked at. */}
                <iframe title={tx('mail.preview', 'Vista previa')} sandbox="" srcDoc={preview ? preview.html : ''} data-mail-preview=""
                    style={{ display: 'block', margin: '0 auto', border: 0, background: '#f3f4f6', width: device === 'mobile' ? 375 : '100%', maxWidth: '100%', height: 'min(70vh, 720px)', minHeight: 420, borderRadius: 12 }} />
            </div>
        </section>
    );
    return (
        <div className="space-y-4 pb-2" data-mail-templates="" data-mail-view="edit">
            <div className="flex flex-wrap items-start gap-3">
                <button type="button" className={`${btn} border-2 border-gray-100 bg-white text-gray-700`} onClick={() => leave(() => { setId(null); setPreview(null); })} data-mail-back="">
                    <i className="fa-solid fa-arrow-left" aria-hidden="true"></i>{tx('mail.back', 'Todos los correos')}
                </button>
                <div className="min-w-0 flex-1 basis-60">
                    <h2 className="text-xl font-black text-gray-900 leading-tight">{nameOf(tpl)}</h2>
                    <p className="text-sm text-gray-600 mt-0.5">{whenOf(tpl)}</p>
                </div>
            </div>
            <div className="flex flex-wrap gap-1 border-b-2 border-gray-100" role="tablist" aria-label={tx('language', 'Idioma')}>
                {data.langs.map((l) => (
                    <button key={l} type="button" role="tab" lang={l} aria-selected={l === lang} onClick={() => l !== lang && leave(() => setLang(l))} data-mail-lang={l}
                        className={`min-h-[44px] px-4 -mb-[2px] border-b-2 text-sm font-bold inline-flex items-center gap-2 ${l === lang ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
                        {LANG_NAMES[l]}
                        {tpl.edits && tpl.edits[l] && <span className="w-2 h-2 rounded-full bg-amber-500" title={tx('mail.custom', 'Personalizado')} aria-label={tx('mail.custom', 'Personalizado')} data-mail-lang-custom={l}></span>}
                    </button>
                ))}
                <span className="ml-auto self-center text-xs font-bold text-gray-500" data-mail-state={edited ? 'custom' : 'original'}>{edited ? tx('mail.custom', 'Personalizado') : tx('mail.original', 'Original')}</span>
            </div>
            {/* On a phone the form and the preview take turns (the switch stays at the top while scrolling). */}
            <div className="lg:hidden sticky top-0 z-10 -mx-1 px-1 py-2 bg-white/95 backdrop-blur" data-mail-pane-switch="">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1" role="group" aria-label={tx('mail.preview', 'Vista previa')}>
                    {[['form', 'fa-pen', tx('mail.pane.edit', 'Editar')], ['preview', 'fa-eye', tx('mail.preview', 'Vista previa')]].map(([p, icon, name]) => (
                        <button key={p} type="button" aria-pressed={pane === p} onClick={() => setPane(p)} data-mail-pane={p}
                            className={`min-h-[40px] rounded-lg text-sm font-bold inline-flex items-center justify-center gap-2 ${pane === p ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'}`}>
                            <i className={`fa-solid ${icon}`} aria-hidden="true"></i>{name}
                        </button>
                    ))}
                </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 items-start">
                <section className={`space-y-5 min-w-0 ${pane === 'form' ? '' : 'hidden lg:block'}`} aria-label={tx('mail.editor', 'Editor')} data-mail-form="">
                    <div>
                        <label htmlFor="cm-mail-subject" className={label}>{tx('mail.subject', 'Asunto')}</label>
                        <span className={hint}>{tx('mail.subject.hint', 'Lo primero que la persona ve en su bandeja de entrada.')}</span>
                        <input id="cm-mail-subject" ref={refs.subject} className={field} value={draft.subject} maxLength={data.limits.subject} onFocus={remember('subject')}
                            onChange={(e) => set('subject', e.target.value)} aria-invalid={errors.subject ? true : undefined} aria-describedby={errors.subject ? 'cm-mail-subject-error' : undefined} />
                        {err('subject')}
                    </div>
                    {area('body', 6, data.limits.body, tx('mail.before', 'Texto antes {block}').replace('{block}', blockWord), tx('mail.before.hint', 'El saludo y lo que la persona debe saber.'), tx('mail.before.example', 'Ej.: Hola, te inscribimos en la conferencia…'))}
                    {tpl.has_action && (
                        <div>
                            <label htmlFor="cm-mail-action" className={label}>{tx('mail.action', 'Texto del botón')}</label>
                            <span className={hint}>{tx('mail.action.hint', 'Lo que dice el botón. El enlace lo pone el sistema.')}</span>
                            <input id="cm-mail-action" ref={refs.action} className={field} value={draft.action} maxLength={data.limits.action} onFocus={remember('action')} placeholder={tx('mail.action.example', 'Ej.: Revisar y autorizar')}
                                onChange={(e) => set('action', e.target.value)} aria-invalid={errors.action ? true : undefined} aria-describedby={errors.action ? 'cm-mail-action-error' : undefined} />
                            {err('action')}
                        </div>
                    )}
                    {area('after', 4, data.limits.after, tx('mail.after', 'Texto después {block}').replace('{block}', blockWord), tx('mail.after.hint', 'Opcional: una aclaración o la despedida.'), tx('mail.after.example', 'Ej.: Si no esperabas este correo, ignóralo.'))}
                    {chips}
                </section>
                <div className={`min-w-0 lg:sticky lg:top-4 ${pane === 'preview' ? '' : 'hidden lg:block'}`}>{previewPane}</div>
            </div>
            {/* Always in reach: save, test, restore — and whether something is still unsaved. */}
            <div className="sticky bottom-0 z-10 -mx-1 px-1 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] bg-white/95 backdrop-blur border-t-2 border-gray-100" data-mail-footer="">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`basis-full sm:basis-auto text-xs font-bold mr-auto inline-flex items-center gap-1.5 ${dirty ? 'text-amber-700' : 'text-gray-500'}`} data-mail-dirty={dirty ? 'yes' : 'no'} role="status">
                        <i className={`fa-solid ${dirty ? 'fa-circle-exclamation' : 'fa-circle-check'}`} aria-hidden="true"></i>
                        {dirty ? tx('mail.unsaved', 'Cambios sin guardar') : tx('mail.saved.state', 'Todo guardado')}
                    </span>
                    {edited && (
                        <button type="button" className={`${btn} flex-1 sm:flex-none px-3 text-rose-700 hover:bg-rose-50`} disabled={!!busy} onClick={restore} data-mail-restore="" aria-label={tx('mail.restore', 'Restaurar original')}>
                            <i className="fa-solid fa-rotate-left" aria-hidden="true"></i><span className="hidden sm:inline">{tx('mail.restore', 'Restaurar original')}</span><span className="sm:hidden">{tx('mail.restore.short', 'Original')}</span>
                        </button>
                    )}
                    <button type="button" className={`${btn} flex-1 sm:flex-none px-3 border-2 border-gray-200 bg-white text-gray-800`} disabled={!!busy} onClick={test} data-mail-test="" aria-label={tx('mail.test', 'Enviar prueba a mi correo')}>
                        <i className={`fa-solid ${busy === 'test' ? 'fa-spinner animate-spin' : 'fa-paper-plane'}`} aria-hidden="true"></i><span className="hidden sm:inline">{tx('mail.test', 'Enviar prueba a mi correo')}</span><span className="sm:hidden">{tx('mail.test.short', 'Prueba')}</span>
                    </button>
                    <button type="button" className={`${btn} flex-1 sm:flex-none bg-blue-600 text-white hover:bg-blue-700`} disabled={!!busy || !dirty} onClick={save} data-mail-save="">
                        <i className={`fa-solid ${busy === 'save' ? 'fa-spinner animate-spin' : 'fa-floppy-disk'}`} aria-hidden="true"></i>{busy === 'save' ? tx('saving', 'Guardando…') : tx('save', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
    );
}
