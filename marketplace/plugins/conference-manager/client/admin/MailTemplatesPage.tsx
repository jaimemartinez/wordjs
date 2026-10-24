// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Plantillas de correo» (2.36.11, WordJS administrators): every e-mail the plugin sends — the consent link, code
 * and copy, the badge, the coordinator's welcome — in Spanish, English and Portuguese. For each: the subject, the
 * text before and after the part the system draws (the button with its link, the code, the record — never
 * editable), the button's label; the placeholders as chips that insert at the cursor; a live preview rendered BY
 * THE SERVER (the same code that sends it) in a sandboxed frame, at desktop or phone width; «Enviar prueba» to the
 * administrator's own e-mail; «Restaurar original». The texts are plain text with a tiny markup (**negrita**,
 * «- » lists, [texto](https://…)): typed HTML shows as text. Errors are said under their field.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { conferenceApi } from "../lib/conference";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useTx } from "./MealScanner";

const LANG_NAMES = { es: 'Español', en: 'English', pt: 'Português' };
const field = 'w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 text-base sm:text-sm bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none';
const label = 'block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5';
const btn = 'min-h-[44px] px-4 rounded-xl text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50';

export default function MailTemplatesPage() {
    const tx = useTx();
    const { language } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const ui = String(language || 'es').slice(0, 2);
    const [data, setData] = useState<any>(null);
    const [loadError, setLoadError] = useState('');
    const [id, setId] = useState('consent.link');
    const [lang, setLang] = useState(['es', 'en', 'pt'].includes(ui) ? ui : 'es');
    const [draft, setDraft] = useState({ subject: '', body: '', after: '', action: '' });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
    const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
    const [busy, setBusy] = useState('');
    const lastField = useRef<{ name: string; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);

    const load = () => conferenceApi.getMailTemplates().then(setData).catch((e) => setLoadError(e?.message || 'Error'));
    useEffect(() => { load(); }, []);
    const tpl = useMemo(() => (data ? data.templates.find((t) => t.id === id) : null), [data, id]);
    const edited = !!(tpl && tpl.edits && tpl.edits[lang]);
    // The draft of the chosen message and language: its stored edit, else its default.
    useEffect(() => {
        if (!tpl) return;
        const src = (tpl.edits && tpl.edits[lang]) || tpl.defaults[lang];
        setDraft({ subject: src.subject || '', body: src.body || '', after: src.after || '', action: src.action || '' });
        setErrors({});
    }, [tpl, lang]);
    // The preview, rendered by the server from the draft (debounced).
    useEffect(() => {
        if (!tpl || !draft.subject) return undefined;
        const t = setTimeout(() => {
            conferenceApi.previewMailTemplate(id, { lang, ...draft }).then((r) => setPreview({ subject: r.subject, html: r.html })).catch(() => {});
        }, 350);
        return () => clearTimeout(t);
    }, [id, lang, draft.subject, draft.body, draft.after, draft.action]); // eslint-disable-line react-hooks/exhaustive-deps

    const set = (k: string, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
    const remember = (name: string) => (e: any) => { lastField.current = { name, el: e.target }; };
    const insert = (key: string) => {
        const target = lastField.current || { name: 'body', el: null };
        const name = target.name;
        const el = target.el;
        const cur = draft[name] || '';
        const token = `{${key}}`;
        const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : cur.length;
        const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : at;
        set(name, cur.slice(0, at) + token + cur.slice(end));
        if (el) requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(at + token.length, at + token.length); } catch { /* ignore */ } });
    };
    const fail = (e: any) => {
        const f = e && (e.field || (e.data && e.data.field) || (e.body && e.body.field));
        if (f) setErrors((x) => ({ ...x, [f]: e.message }));
        else addToast(e?.message || 'Error', 'error');
    };
    // Said in place before anything is sent (the server checks again).
    const checked = () => {
        const e: Record<string, string> = {};
        if (!draft.subject.trim()) e.subject = tx('mail.subject.missing', 'Escribe el asunto.');
        if (!draft.body.trim()) e.body = tx('mail.body.missing', 'Escribe el texto del correo.');
        setErrors(e);
        return !Object.keys(e).length;
    };
    const save = async () => {
        if (!checked()) return;
        setBusy('save');
        try {
            await conferenceApi.saveMailTemplate(id, { lang, ...draft });
            addToast(tx('mail.saved', 'Plantilla guardada.'), 'success');
            await load();
        } catch (e) { fail(e); } finally { setBusy(''); }
    };
    const restore = async () => {
        if (!await confirm(tx('mail.restore.confirm', 'Se borra lo que cambiaste en este idioma y vuelve el texto original.'), tx('mail.restore', 'Restaurar original'), true)) return;
        setBusy('restore');
        try { await conferenceApi.restoreMailTemplate(id, lang); addToast(tx('mail.restored', 'Se restauró el texto original.'), 'success'); await load(); }
        catch (e) { fail(e); } finally { setBusy(''); }
    };
    const test = async () => {
        if (!checked()) return;
        setBusy('test');
        try {
            const r = await conferenceApi.testMailTemplate(id, { lang, ...draft });
            addToast(tx('mail.test.sent', 'Enviamos la prueba a {email}.').replace('{email}', r.to_masked || ''), 'success');
        } catch (e) { fail(e); } finally { setBusy(''); }
    };

    if (loadError) return <p role="alert" className="text-sm text-rose-700">{loadError}</p>;
    if (!data || !tpl) return <p className="text-sm text-gray-400" role="status">{tx('loading', 'Cargando…')}</p>;
    const nameOf = (t) => t.name[ui] || t.name.es;
    const blockWord = tpl.block === 'action' ? tx('mail.block.action', 'del botón') : tpl.block === 'code' ? tx('mail.block.code', 'del código') : tx('mail.block.record', 'del registro de lo autorizado');
    const err = (k) => errors[k] ? <p role="alert" className="mt-1 text-xs font-semibold text-rose-600">{errors[k]}</p> : null;
    return (
        <div className="space-y-6" data-mail-templates="">
            <div>
                <h2 className="text-xl font-black text-gray-900">{tx('mail.templates', 'Plantillas de correo')}</h2>
                <p className="text-sm text-gray-500 mt-1 max-w-3xl">{tx('mail.templates.hint', 'Los correos que envía la conferencia, en tres idiomas. El enlace, el código y el registro de lo autorizado los pone el sistema: no se editan.')}</p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-6">
                <nav className="space-y-2" aria-label={tx('mail.templates', 'Plantillas de correo')}>
                    {data.templates.map((t) => (
                        <button key={t.id} type="button" onClick={() => setId(t.id)} aria-current={t.id === id ? 'true' : undefined} data-mail-template={t.id}
                            className={`w-full text-left rounded-2xl border-2 px-4 py-3 transition ${t.id === id ? 'border-blue-500 bg-blue-50/60' : 'border-gray-100 bg-white hover:border-gray-200'}`}>
                            <span className="block text-sm font-bold text-gray-900">{nameOf(t)}</span>
                            <span className="block text-[11px] text-gray-500 mt-0.5">{Object.keys(t.edits || {}).length ? tx('mail.custom.in', 'Personalizada: {langs}').replace('{langs}', Object.keys(t.edits).map((l) => l.toUpperCase()).join(', ')) : tx('mail.original', 'Texto original')}</span>
                        </button>
                    ))}
                </nav>
                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6 min-w-0">
                    <section className="space-y-4 min-w-0" aria-label={tx('mail.editor', 'Editor')}>
                        <p className="text-sm text-gray-600">{tpl.description[ui] || tpl.description.es}</p>
                        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={tx('language', 'Idioma')}>
                            {data.langs.map((l) => (
                                <button key={l} type="button" lang={l} aria-pressed={l === lang} onClick={() => setLang(l)} data-mail-lang={l}
                                    className={`min-h-[40px] px-3 rounded-xl border-2 text-sm font-bold ${l === lang ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-100 bg-white text-gray-700'}`}>
                                    {LANG_NAMES[l]}{tpl.edits && tpl.edits[l] ? ' •' : ''}
                                </button>
                            ))}
                            <span className="text-[11px] font-bold text-gray-500 ml-1" data-mail-state={edited ? 'custom' : 'original'}>{edited ? tx('mail.custom', 'Personalizada') : tx('mail.original', 'Texto original')}</span>
                        </div>
                        <div>
                            <label htmlFor="cm-mail-subject" className={label}>{tx('mail.subject', 'Asunto')}</label>
                            <input id="cm-mail-subject" className={field} value={draft.subject} maxLength={data.limits.subject} onFocus={remember('subject')} onClick={remember('subject')} onKeyUp={remember('subject')}
                                onChange={(e) => set('subject', e.target.value)} aria-invalid={errors.subject ? true : undefined} />
                            {err('subject')}
                        </div>
                        <div>
                            <label htmlFor="cm-mail-body" className={label}>{tx('mail.before', 'Texto antes {block}').replace('{block}', blockWord)}</label>
                            <textarea id="cm-mail-body" rows={7} className={field} value={draft.body} maxLength={data.limits.body} onFocus={remember('body')} onClick={remember('body')} onKeyUp={remember('body')}
                                onChange={(e) => set('body', e.target.value)} aria-invalid={errors.body ? true : undefined} />
                            {err('body')}
                        </div>
                        <div>
                            <label htmlFor="cm-mail-after" className={label}>{tx('mail.after', 'Texto después {block}').replace('{block}', blockWord)}</label>
                            <textarea id="cm-mail-after" rows={5} className={field} value={draft.after} maxLength={data.limits.after} onFocus={remember('after')} onClick={remember('after')} onKeyUp={remember('after')}
                                onChange={(e) => set('after', e.target.value)} aria-invalid={errors.after ? true : undefined} />
                            {err('after')}
                        </div>
                        {tpl.has_action && (
                            <div>
                                <label htmlFor="cm-mail-action" className={label}>{tx('mail.action', 'Texto del botón')}</label>
                                <input id="cm-mail-action" className={field} value={draft.action} maxLength={data.limits.action} onChange={(e) => set('action', e.target.value)} aria-invalid={errors.action ? true : undefined} />
                                {err('action')}
                            </div>
                        )}
                        <div className="space-y-2">
                            <p className={label}>{tx('mail.placeholders', 'Datos que se rellenan solos (toca para insertar)')}</p>
                            <div className="flex flex-wrap gap-2">
                                {tpl.placeholders.map((p) => (
                                    <button key={p.key} type="button" onClick={() => insert(p.key)} title={p.subject_only ? tx('mail.subject.only', 'Solo en el asunto') : undefined} data-mail-placeholder={p.key}
                                        className="min-h-[36px] px-3 rounded-full border border-gray-200 bg-white text-xs font-semibold text-gray-700 hover:border-blue-400">
                                        <code className="text-blue-700">{`{${p.key}}`}</code> · {p.label[ui] || p.label.es}
                                    </button>
                                ))}
                            </div>
                            <p className="text-[11px] text-gray-500" data-mail-markup="">{tx('mail.markup', 'Formato: **negrita**, una línea que empieza con «- » hace una lista, [texto](https://…) hace un enlace. Una línea en blanco separa párrafos. El HTML se muestra como texto.')}</p>
                        </div>
                        <div className="flex flex-wrap gap-2 pt-2">
                            <button type="button" className={`${btn} bg-blue-600 text-white`} disabled={!!busy} onClick={save} data-mail-save="">{busy === 'save' ? tx('saving', 'Guardando…') : tx('save', 'Guardar')}</button>
                            <button type="button" className={`${btn} border-2 border-gray-200 bg-white text-gray-800`} disabled={!!busy} onClick={test} data-mail-test="">
                                <i className="fa-solid fa-paper-plane" aria-hidden="true"></i>{tx('mail.test', 'Enviar prueba a mi correo')}
                            </button>
                            {edited && (
                                <button type="button" className={`${btn} text-rose-700 hover:bg-rose-50`} disabled={!!busy} onClick={restore} data-mail-restore="">
                                    <i className="fa-solid fa-rotate-left" aria-hidden="true"></i>{tx('mail.restore', 'Restaurar original')}
                                </button>
                            )}
                        </div>
                    </section>
                    <section className="space-y-3 min-w-0" aria-label={tx('mail.preview', 'Vista previa')}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('mail.preview', 'Vista previa')}</h3>
                            <div className="flex gap-1" role="group" aria-label={tx('mail.device', 'Pantalla')}>
                                {[['desktop', 'fa-desktop', tx('mail.desktop', 'Escritorio')], ['mobile', 'fa-mobile-screen', tx('mail.mobile', 'Celular')]].map(([d, icon, name]) => (
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
                                style={{ display: 'block', margin: '0 auto', border: 0, background: '#f3f4f6', width: device === 'mobile' ? 375 : '100%', maxWidth: '100%', height: 640, borderRadius: 12 }} />
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
