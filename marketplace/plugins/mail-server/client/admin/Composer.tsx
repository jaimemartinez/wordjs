// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend tsc.
"use client";

import { errorText } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { api, apiPost } from "../../../../../frontend/src/lib/api";
// Platform isomorphic sanitizer (DOMPurify on the client). It guards the ONE live-DOM innerHTML sink —
// this editor — which receives the quoted body of a reply/forward (attacker-controlled HTML).
import { sanitizeHTML } from "../../../../../frontend/src/lib/sanitize";
import { useModal } from "@/contexts/ModalContext";
import { cx, ScrollRow, IconBtn, Button, Menu, MenuItem, Avatar, formatBytes, escapeHtml } from "./ui";

const splitList = (v: string) => String(v || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
const looksLikeAddress = (s: string) => /^[^\s@,;<>"]+@[^\s@,;<>"]+$/.test(s);

/** To / Cc / Bcc as chips, with autocomplete from colleagues + your correspondence history. */
function RecipientField({ label, value, onChange, onPending, autoFocus, t, trailing }: any) {
    const [text, setText] = useState('');
    const [suggestions, setSuggestions] = useState<any[]>([]);
    const [hi, setHi] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const chips = splitList(value);

    useEffect(() => {
        const q = text.trim();
        if (q.length < 2) { setSuggestions([]); return; }
        const timer = setTimeout(async () => {
            try {
                const data = await api(`/plugin/mail-server/contacts/suggest?q=${encodeURIComponent(q)}`) as any;
                const list = (Array.isArray(data) ? data : []).filter((s: any) => !chips.includes(s.email));
                setSuggestions(list);
                setHi(0);
            } catch { setSuggestions([]); }
        }, 200);
        return () => clearTimeout(timer);
    }, [text]);

    const commit = (addr: string) => {
        const a = addr.trim().replace(/^<|>$/g, '');
        if (!a) return;
        if (!chips.includes(a)) onChange([...chips, a].join(', '));
        setText('');
        onPending?.('');
        setSuggestions([]);
    };
    const remove = (addr: string) => onChange(chips.filter(c => c !== addr).join(', '));

    const onKeyDown = (e: any) => {
        // Ctrl/Cmd+Enter is "send": leave the text pending (send() folds it in) instead of committing a
        // chip whose state update the send handler, in this same event, would not see yet.
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') return;
        if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setHi(h => (h + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
            return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length > 0 && text.trim()) {
            e.preventDefault();
            commit(suggestions[hi].email);
            return;
        }
        if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === ' ' && looksLikeAddress(text.trim()))) {
            if (text.trim()) { e.preventDefault(); commit(text); }
            else if (e.key === 'Enter') e.preventDefault();
            return;
        }
        if (e.key === 'Backspace' && !text && chips.length) remove(chips[chips.length - 1]);
    };

    return (
        <div className="relative flex min-h-[44px] items-start gap-2 border-b border-slate-100 px-4 py-1.5 focus-within:bg-slate-50/60" onClick={() => inputRef.current?.focus()}>
            <span className="w-10 shrink-0 pt-2 text-[13px] text-slate-500">{label}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-0.5">
                {chips.map(c => (
                    <span key={c} className={cx('inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-1 pr-1.5 text-[13px]', looksLikeAddress(c) ? 'border-slate-200 bg-white text-slate-700' : 'border-red-200 bg-red-50 text-red-700')}>
                        <Avatar email={c} name={c} size={20} />
                        <span className="truncate">{c}</span>
                        <button type="button" onClick={(e) => { e.stopPropagation(); remove(c); }} className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Remove">
                            <i className="fa-solid fa-xmark text-[10px]"></i>
                        </button>
                    </span>
                ))}
                <input
                    ref={inputRef}
                    autoFocus={autoFocus}
                    value={text}
                    onChange={(e) => {
                        // Mobile keyboards report ',' as an unidentified key, so a separator typed there
                        // never reaches onKeyDown: split it here too.
                        const v = e.target.value;
                        const parts = v.split(/[,;]/);
                        if (parts.length > 1) {
                            const add = parts.slice(0, -1).map(s => s.trim().replace(/^<|>$/g, '')).filter(Boolean);
                            onChange([...chips, ...add.filter(a => !chips.includes(a))].join(', '));
                            setText(parts[parts.length - 1]);
                            onPending?.(parts[parts.length - 1]);
                            return;
                        }
                        setText(v);
                        onPending?.(v);
                    }}
                    onKeyDown={onKeyDown}
                    onBlur={() => { setTimeout(() => { if (text.trim()) commit(text); setSuggestions([]); }, 150); }}
                    onPaste={(e) => {
                        const pasted = e.clipboardData.getData('text');
                        if (/[,;\n]/.test(pasted)) {
                            e.preventDefault();
                            const add = pasted.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
                            onChange([...chips, ...add.filter(a => !chips.includes(a))].join(', '));
                        }
                    }}
                    className="min-w-[120px] flex-1 bg-transparent py-1.5 text-sm text-slate-900 outline-none"
                    inputMode="email"
                    autoComplete="off"
                    aria-label={label}
                />
            </div>
            {trailing}
            {suggestions.length > 0 && (
                <div className="absolute left-12 right-2 top-full mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl" style={{ zIndex: 70 }}>
                    {suggestions.map((s, i) => (
                        <button
                            type="button"
                            key={s.email}
                            onMouseDown={(e) => { e.preventDefault(); commit(s.email); }}
                            className={cx('flex w-full items-center gap-3 px-3 py-2 text-left', i === hi ? 'bg-violet-50' : 'hover:bg-slate-50')}
                        >
                            <Avatar name={s.name} email={s.email} size={28} />
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-slate-800">{s.name || s.email}</span>
                                <span className="block truncate text-xs text-slate-500">{s.email}</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function schedulePresets(t: any) {
    const at = (d: Date, h: number) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; };
    const now = new Date();
    const out = [];
    if (now.getHours() < 13) out.push({ label: t('comp.scheduleAfternoon'), date: at(now, 14) });
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    out.push({ label: t('comp.scheduleTomorrow'), date: at(tomorrow, 8) });
    const monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
    if (monday.toDateString() !== tomorrow.toDateString()) out.push({ label: t('comp.scheduleMonday'), date: at(monday, 8) });
    return out;
}
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/**
 * The composer. Docked bottom-right on large screens (minimizable / expandable), full screen on phones.
 * Owns its draft: autosaves to POST /drafts and sends through POST /send; the parent shows the undo toast.
 */
export default function Composer({ initial, prefs, user, t, locale, fullscreen: forceFull, onClose, onSent, onError, onDraftSaved, confirm }: any) {
    const [mail, setMail] = useState(() => ({
        to: '', cc: '', bcc: '', subject: '', body: '', attachments: [], useSignature: true, ...initial
    }));
    const [draftId, setDraftId] = useState<number | null>(initial?.draftId || null);
    const [replyToId] = useState<number | null>(initial?.replyToId || null);
    const [showCc, setShowCc] = useState(!!initial?.cc);
    const [showBcc, setShowBcc] = useState(!!initial?.bcc);
    const [minimized, setMinimized] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [saveStatus, setSaveStatus] = useState<null | 'saving' | 'saved' | 'error'>(null);
    const [sending, setSending] = useState(false);
    const [uploading, setUploading] = useState(0);
    const [scheduledAt, setScheduledAt] = useState('');
    const [pickDate, setPickDate] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const editorRef = useRef<HTMLDivElement>(null);
    const { prompt } = useModal();
    const fileRef = useRef<HTMLInputElement>(null);
    const lastBody = useRef('');
    const dirty = useRef(false);

    const full = forceFull || expanded;

    // Load the (sanitized) initial body into the editor once, and whenever a template replaces it.
    const setEditorHtml = (html: string) => {
        const clean = sanitizeHTML(html || '');
        if (editorRef.current) editorRef.current.innerHTML = clean;
        lastBody.current = clean;
        setMail(m => ({ ...m, body: clean }));
    };
    useEffect(() => { setEditorHtml(mail.body); }, []); // eslint-disable-line
    useEffect(() => {
        // Re-attach the content after the editor remounts (minimize → restore).
        if (!minimized && editorRef.current && editorRef.current.innerHTML !== lastBody.current) editorRef.current.innerHTML = lastBody.current;
    }, [minimized]);

    const update = (patch: any) => { dirty.current = true; setMail(m => ({ ...m, ...patch })); };

    // Autosave (2 s after the last change). The signature is NOT baked in: it is a send-time transform,
    // otherwise reopening a draft would append it a second time.
    useEffect(() => {
        if (!dirty.current || sending) return;
        if (!mail.to && !mail.subject && !stripTags(mail.body)) return;
        const timer = setTimeout(async () => {
            setSaveStatus('saving');
            try {
                const res = await api('/plugin/mail-server/drafts', {
                    method: 'POST',
                    body: { to: mail.to, cc: mail.cc, bcc: mail.bcc, subject: mail.subject, body: mail.body, attachments: mail.attachments, isHtml: true, replyToId, id: draftId }
                }) as any;
                if (res && res.success && res.id) { setDraftId(res.id); setSaveStatus('saved'); onDraftSaved && onDraftSaved(); }
            } catch { setSaveStatus('error'); }
        }, 2000);
        return () => clearTimeout(timer);
    }, [mail]);

    const signatureHtml = () => {
        const stored = (prefs && typeof prefs.signature === 'string') ? prefs.signature.trim() : '';
        if (stored) return `<br/><br/>-- <br/>${escapeHtml(stored).replace(/\n/g, '<br/>')}`;
        const name = user?.displayName || user?.username || '';
        const email = user?.userEmail || user?.email || '';
        return name || email ? `<br/><br/>-- <br/>${escapeHtml(name)}<br/>${escapeHtml(email)}` : '';
    };

    // An address still being typed (no Enter / comma yet) only becomes a chip on blur, AFTER a click on
    // Send has already run — so send() folds the pending text in itself.
    const pending = useRef<any>({ to: '', cc: '', bcc: '' });
    const withPending = (v: string, p: string) => {
        const list = splitList(v);
        return [...list, ...splitList(p).filter(a => !list.includes(a))].join(', ');
    };
    const send = async () => {
        if (sending) return;
        const to = withPending(mail.to, pending.current.to);
        const cc = withPending(mail.cc, pending.current.cc);
        const bcc = withPending(mail.bcc, pending.current.bcc);
        if (to !== mail.to || cc !== mail.cc || bcc !== mail.bcc) update({ to, cc, bcc });
        if (!splitList(to).length) { onError(t('comp.needRecipient')); return; }
        if (!mail.subject.trim() && !(await confirm(t('comp.noSubjectConfirm'), t('comp.send')))) return;
        setSending(true);
        try {
            const res = await api('/plugin/mail-server/send', {
                method: 'POST',
                body: {
                    to, cc, bcc, subject: mail.subject,
                    body: mail.useSignature ? mail.body + signatureHtml() : mail.body,
                    attachments: mail.attachments, isHtml: true, replyToId, id: draftId,
                    scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined
                }
            }) as any;
            onSent(res, { scheduled: !!scheduledAt });
        } catch (e: any) {
            onError(errorText(e, t));
            setSending(false);
        }
    };

    const discard = async () => {
        if ((stripTags(mail.body) || mail.subject || mail.to) && !(await confirm(t('comp.discardConfirm'), t('comp.discard'), true))) return;
        if (draftId) {
            try { await api(`/plugin/mail-server/emails/${draftId}`, { method: 'DELETE' }); } catch { /* best effort */ }
        }
        onClose({ discarded: !!draftId });
    };

    const upload = async (files: File[]) => {
        for (const file of files) {
            setUploading(n => n + 1);
            const fd = new FormData();
            fd.append('file', file);
            try {
                const data = await apiPost<any>('/plugin/mail-server/upload/attachment', fd);
                if (data && data.file) update({ attachments: [...(mailRef.current.attachments || []), data.file] });
            } catch (e: any) {
                onError(`${file.name}: ${errorText(e, t)}`);
            } finally {
                setUploading(n => n - 1);
            }
        }
    };
    const mailRef = useRef(mail);
    mailRef.current = mail;

    // Insert a link over the selected text. The address is asked in the host's dialog (never the browser's
    // prompt()); the dialog takes the focus, so the editor's selection is saved first and put back before
    // the link is applied.
    const insertLink = async () => {
        const sel = typeof window !== 'undefined' ? window.getSelection() : null;
        const inEditor = sel && sel.rangeCount && editorRef.current && editorRef.current.contains(sel.anchorNode);
        const saved = inEditor ? sel.getRangeAt(0).cloneRange() : null;
        const url = await prompt(t('comp.linkPrompt'), t('comp.link'), { defaultValue: 'https://', inputType: 'url', confirmText: t('comp.link') });
        editorRef.current?.focus();
        if (saved) { const s2 = window.getSelection(); s2?.removeAllRanges(); s2?.addRange(saved); }
        if (url && /^(https?:|mailto:)/i.test(url.trim())) exec('createLink', url.trim());
    };
    const exec = (cmd: string, arg?: string) => {
        editorRef.current?.focus();
        document.execCommand(cmd, false, arg);
        onEditorInput();
    };
    const onEditorInput = () => {
        const html = editorRef.current?.innerHTML || '';
        lastBody.current = html;
        update({ body: html });
    };
    const insertTemplate = (tpl: any) => {
        const html = escapeHtml(tpl.body).replace(/\n/g, '<br/>');
        const current = editorRef.current?.innerHTML || '';
        setEditorHtml(html + (stripTags(current) ? '<br/>' + current : current));
        if (tpl.subject && !mail.subject) update({ subject: tpl.subject });
        dirty.current = true;
    };

    const onKeyDown = (e: any) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
        if (e.key === 'Escape' && !full) { e.stopPropagation(); setMinimized(true); }
    };

    const title = mail.subject || (initial?.kind === 'reply' ? t('comp.reply') : initial?.kind === 'forward' ? t('comp.forward') : t('comp.new'));
    const statusText = saveStatus === 'saving' ? t('comp.saving') : saveStatus === 'saved' ? t('comp.saved') : saveStatus === 'error' ? t('comp.saveError') : '';

    // Minimized: a slim bar docked bottom-right.
    if (minimized && !forceFull) {
        return (
            <div className="fixed bottom-0 right-4 w-72 overflow-hidden rounded-t-xl bg-slate-900 shadow-2xl sm:right-6" style={{ zIndex: 6000 }}>
                <div className="flex h-11 cursor-pointer items-center gap-2 px-4 text-sm font-semibold text-white" onClick={() => setMinimized(false)}>
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    <IconBtn size="sm" icon="fa-solid fa-up-right-and-down-left-from-center" label={t('comp.restore')} className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={(e: any) => { e.stopPropagation(); setMinimized(false); }} />
                    <IconBtn size="sm" icon="fa-solid fa-xmark" label={t('common.close')} className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={(e: any) => { e.stopPropagation(); onClose({}); }} />
                </div>
            </div>
        );
    }

    const frame = full
        ? 'fixed inset-0 sm:inset-6 lg:inset-x-[10%] lg:inset-y-8 sm:rounded-2xl'
        : 'fixed bottom-0 right-4 sm:right-6 w-[min(560px,calc(100vw-2rem))] h-[min(640px,calc(100dvh-5rem))] rounded-t-2xl';

    return (
        <>
            {full && !forceFull && <div className="fixed inset-0 bg-slate-900/40" style={{ zIndex: 5999 }} onClick={() => setExpanded(false)}></div>}
            {forceFull && <div className="fixed inset-0 bg-white" style={{ zIndex: 5999 }}></div>}
            <div
                className={cx(frame, 'flex flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl shadow-slate-900/25')}
                style={{ zIndex: 6000 }}
                onKeyDown={onKeyDown}
                onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
                onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setDragOver(false); upload(Array.from(e.dataTransfer.files)); } }}
                role="dialog"
                aria-label={title}
            >
                {/* Header */}
                <div className={cx('flex h-12 shrink-0 items-center gap-1 px-2 sm:px-4', forceFull ? 'border-b border-slate-100 bg-white' : 'bg-slate-900 text-white')}>
                    {forceFull && <IconBtn icon="fa-solid fa-arrow-left" label={t('common.back')} onClick={() => onClose({})} />}
                    <span className={cx('min-w-0 flex-1 truncate px-1 text-sm font-semibold', forceFull ? 'text-slate-900' : 'cursor-pointer')} onClick={() => !forceFull && setMinimized(true)}>
                        {title}
                    </span>
                    {statusText && <span className={cx('hidden text-[11px] sm:inline', saveStatus === 'error' ? 'text-red-400' : forceFull ? 'text-slate-400' : 'text-slate-400')}>{statusText}</span>}
                    {!forceFull && (
                        <>
                            <IconBtn size="sm" icon="fa-solid fa-minus" label={t('comp.minimize')} className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setMinimized(true)} />
                            <IconBtn size="sm" icon={expanded ? 'fa-solid fa-down-left-and-up-right-to-center' : 'fa-solid fa-up-right-and-down-left-from-center'} label={expanded ? t('comp.restore') : t('comp.maximize')} className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setExpanded(v => !v)} />
                            <IconBtn size="sm" icon="fa-solid fa-xmark" label={t('common.close')} className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => onClose({})} />
                        </>
                    )}
                    {forceFull && (
                        <Button variant="primary" size="sm" icon={scheduledAt ? 'fa-regular fa-clock' : 'fa-solid fa-paper-plane'} loading={sending} onClick={send}>
                            {scheduledAt ? t('comp.schedule') : t('comp.send')}
                        </Button>
                    )}
                </div>

                {/* Recipients */}
                <RecipientField
                    label={t('comp.to')} value={mail.to} onChange={(v: string) => update({ to: v })} onPending={(v: string) => { pending.current.to = v; }} autoFocus={!mail.to} t={t}
                    trailing={(
                        <div className="flex shrink-0 gap-1 pt-2 text-[13px] text-slate-500">
                            {!showCc && <button type="button" className="rounded px-1 hover:bg-slate-100 hover:text-slate-900" onClick={() => setShowCc(true)}>{t('comp.cc')}</button>}
                            {!showBcc && <button type="button" className="rounded px-1 hover:bg-slate-100 hover:text-slate-900" onClick={() => setShowBcc(true)}>{t('comp.bcc')}</button>}
                        </div>
                    )}
                />
                {showCc && <RecipientField label={t('comp.cc')} value={mail.cc} onChange={(v: string) => update({ cc: v })} onPending={(v: string) => { pending.current.cc = v; }} autoFocus={!initial?.cc} t={t} />}
                {showBcc && <RecipientField label={t('comp.bcc')} value={mail.bcc} onChange={(v: string) => update({ bcc: v })} onPending={(v: string) => { pending.current.bcc = v; }} autoFocus={!initial?.bcc} t={t} />}
                <div className="flex items-center border-b border-slate-100 px-4">
                    <input
                        value={mail.subject}
                        onChange={(e) => update({ subject: e.target.value })}
                        placeholder={t('comp.subject')}
                        aria-label={t('comp.subject')}
                        autoFocus={!!mail.to && !mail.subject}
                        className="h-11 w-full bg-transparent text-sm font-medium text-slate-900 outline-none placeholder:font-normal placeholder:text-slate-400"
                    />
                </div>

                {/* Body */}
                <div className="relative min-h-0 flex-1 overflow-y-auto">
                    <div
                        ref={editorRef}
                        contentEditable
                        suppressContentEditableWarning
                        onInput={onEditorInput}
                        onPaste={(e) => {
                            const files = Array.from(e.clipboardData?.files || []);
                            if (files.length) { e.preventDefault(); upload(files); }
                        }}
                        className="min-h-full px-4 py-3 text-[15px] leading-relaxed text-slate-800 outline-none sm:text-sm [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 [&_a]:text-violet-700 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_h1]:my-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:my-2 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:my-2 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-2 [&_img]:h-auto [&_img]:max-w-full [&_table]:max-w-full [&_td]:p-1"
                        role="textbox"
                        aria-multiline="true"
                        aria-label={t('comp.body')}
                    />
                    {!stripTags(mail.body) && !mail.body.includes('<img') && (
                        <div className="pointer-events-none absolute left-4 top-3 text-sm text-slate-400">{t('comp.body')}</div>
                    )}
                    {dragOver && (
                        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-violet-400 bg-violet-50/90 text-sm font-semibold text-violet-700">
                            <i className="fa-solid fa-paperclip mr-2"></i>{t('comp.attach')}
                        </div>
                    )}
                </div>

                {/* Attachments */}
                {(mail.attachments.length > 0 || uploading > 0) && (
                    <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto border-t border-slate-100 px-4 py-2">
                        {mail.attachments.map((f: any, i: number) => (
                            <span key={i} className="inline-flex max-w-[240px] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                                <i className="fa-regular fa-file text-slate-400"></i>
                                <span className="truncate">{f.filename}</span>
                                {f.size ? <span className="text-slate-400">{formatBytes(f.size)}</span> : null}
                                <button type="button" aria-label={t('common.delete')} className="text-slate-400 hover:text-red-600" onClick={() => update({ attachments: mail.attachments.filter((_: any, j: number) => j !== i) })}>
                                    <i className="fa-solid fa-xmark"></i>
                                </button>
                            </span>
                        ))}
                        {uploading > 0 && <span className="inline-flex items-center gap-2 px-2 text-xs text-slate-500"><i className="fa-solid fa-circle-notch fa-spin"></i>{t('comp.uploading')}</span>}
                    </div>
                )}

                {/* Formatting toolbar */}
                <ScrollRow wrapClassName="shrink-0 border-t border-slate-100" className="flex items-center gap-0.5 px-2 py-1">
                    <IconBtn size="sm" icon="fa-solid fa-bold" label={t('comp.bold')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('bold')} />
                    <IconBtn size="sm" icon="fa-solid fa-italic" label={t('comp.italic')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('italic')} />
                    <IconBtn size="sm" icon="fa-solid fa-underline" label={t('comp.underline')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('underline')} />
                    <IconBtn size="sm" icon="fa-solid fa-strikethrough" label={t('comp.strike')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('strikeThrough')} />
                    <span className="mx-1 h-5 w-px shrink-0 bg-slate-200"></span>
                    <IconBtn size="sm" icon="fa-solid fa-list-ul" label={t('comp.bullets')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('insertUnorderedList')} />
                    <IconBtn size="sm" icon="fa-solid fa-list-ol" label={t('comp.numbers')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('insertOrderedList')} />
                    <IconBtn size="sm" icon="fa-solid fa-quote-left" label={t('comp.quote')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('formatBlock', 'blockquote')} />
                    <IconBtn size="sm" icon="fa-solid fa-link" label={t('comp.link')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => insertLink()} />
                    <IconBtn size="sm" icon="fa-solid fa-text-slash" label={t('comp.clear')} onMouseDown={(e: any) => e.preventDefault()} onClick={() => exec('removeFormat')} />
                </ScrollRow>

                {/* Footer */}
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-2.5" style={{ paddingBottom: forceFull ? 'max(0.625rem, env(safe-area-inset-bottom))' : undefined }}>
                    {!forceFull && (
                        <div className="flex overflow-hidden rounded-xl shadow-sm shadow-violet-600/20">
                            <button type="button" onClick={send} disabled={sending} className="inline-flex h-10 items-center gap-2 bg-violet-600 px-5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
                                {sending ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className={scheduledAt ? 'fa-regular fa-clock' : 'fa-solid fa-paper-plane'}></i>}
                                {scheduledAt ? t('comp.schedule') : t('comp.send')}
                            </button>
                            <Menu align="left" width="w-64" className="border-l border-violet-500/50" trigger={({ toggle }: any) => (
                                <button type="button" onClick={toggle} aria-label={t('comp.scheduleSend')} title={t('comp.scheduleSend')} className="inline-flex h-10 w-9 items-center justify-center bg-violet-600 text-white hover:bg-violet-700">
                                    <i className="fa-solid fa-chevron-up text-[11px]"></i>
                                </button>
                            )}>
                                <ScheduleItems t={t} locale={locale} scheduledAt={scheduledAt} setScheduledAt={setScheduledAt} setPickDate={setPickDate} />
                            </Menu>
                        </div>
                    )}
                    {forceFull && (
                        <Menu align="left" width="w-64" trigger={({ toggle }: any) => (
                            <IconBtn icon="fa-regular fa-clock" label={t('comp.scheduleSend')} active={!!scheduledAt} onClick={toggle} />
                        )}>
                            <ScheduleItems t={t} locale={locale} scheduledAt={scheduledAt} setScheduledAt={setScheduledAt} setPickDate={setPickDate} />
                        </Menu>
                    )}
                    <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) upload(f); }} />
                    <IconBtn icon="fa-solid fa-paperclip" label={t('comp.attach')} onClick={() => fileRef.current?.click()} />
                    <Menu align="left" width="w-72" trigger={({ toggle }: any) => <IconBtn icon="fa-regular fa-file-lines" label={t('comp.templates')} onClick={toggle} />}>
                        {(prefs?.templates || []).length === 0
                            ? <p className="px-3.5 py-2 text-xs leading-relaxed text-slate-500">{t('comp.noTemplates')}</p>
                            : (prefs.templates || []).map((tpl: any) => (
                                <MenuItem key={tpl.id} icon="fa-regular fa-file-lines" onClick={() => insertTemplate(tpl)}>{tpl.name}</MenuItem>
                            ))}
                    </Menu>
                    <label className="ml-1 flex cursor-pointer select-none items-center gap-1.5 text-xs text-slate-600">
                        <input type="checkbox" checked={mail.useSignature} onChange={(e) => update({ useSignature: e.target.checked })} className="h-3.5 w-3.5 accent-violet-600" />
                        {t('comp.signature')}
                    </label>
                    <span className="flex-1"></span>
                    {statusText && <span className={cx('text-[11px] sm:hidden', saveStatus === 'error' ? 'text-red-500' : 'text-slate-400')}>{statusText}</span>}
                    <IconBtn icon="fa-regular fa-trash-can" label={t('comp.discard')} danger onClick={discard} />
                </div>
                {scheduledAt && (
                    <div className="flex items-center gap-2 border-t border-violet-100 bg-violet-50 px-4 py-2 text-xs text-violet-800">
                        <i className="fa-regular fa-clock"></i>
                        <span className="flex-1">{t('comp.scheduleFor', { date: new Date(scheduledAt).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}</span>
                        <button type="button" className="font-semibold hover:underline" onClick={() => setScheduledAt('')}>{t('comp.clearSchedule')}</button>
                    </div>
                )}
                {pickDate && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2.5">
                        <input type="datetime-local" min={toLocalInput(new Date())} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2 text-sm" />
                        <Button size="sm" variant="ghost" onClick={() => setPickDate(false)}>{t('common.close')}</Button>
                    </div>
                )}
            </div>
        </>
    );
}

function ScheduleItems({ t, locale, scheduledAt, setScheduledAt, setPickDate }: any) {
    return (
        <>
            <p className="px-3.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('comp.scheduleSend')}</p>
            {schedulePresets(t).map(p => (
                <MenuItem key={p.label} icon="fa-regular fa-clock" onClick={() => { setScheduledAt(toLocalInput(p.date)); setPickDate(false); }}
                    hint={p.date.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}>
                    {p.label}
                </MenuItem>
            ))}
            <MenuItem icon="fa-regular fa-calendar" onClick={() => setPickDate(true)}>{t('comp.schedulePick')}</MenuItem>
            {scheduledAt && <MenuItem icon="fa-solid fa-paper-plane" onClick={() => setScheduledAt('')}>{t('comp.clearSchedule')}</MenuItem>}
        </>
    );
}

// The visible text of the editor's html, only to tell "empty" from "has content" (never rendered).
// Stripped to a fixpoint and then of any stray angle bracket: one pass of /<[^>]*>/ can splice two
// fragments into a new tag ("<<b>b>"), which CodeQL rightly flags as an incomplete sanitizer.
function stripTags(html: string) {
    let out = String(html || '');
    for (let prev = null; prev !== out;) { prev = out; out = out.replace(/<[^>]*>/g, ''); }
    return out.replace(/[<>]/g, '').replace(/&nbsp;/g, ' ').trim();
}
