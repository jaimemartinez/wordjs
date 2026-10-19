// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend tsc.
"use client";

import { errorText } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../../../frontend/src/lib/api";
import { sanitizeHTML } from "../../../../../frontend/src/lib/sanitize";
import {
    cx, IconBtn, Button, Menu, MenuItem, Avatar, Pill, EmptyState, Spinner, Sheet, EmailBodyFrame,
    useElementWidth, listDate, fullDate, formatBytes, escapeHtml, shortPeople, parseDate, prepareEmailHtml
} from "./ui";
import Composer from "./Composer";
import MailSettings, { ShortcutList } from "./MailSettings";

const LABEL_COLORS = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#db2777', '#0891b2', '#65a30d', '#4f46e5', '#64748b'];
const PAGE = 50;

const FOLDERS = [
    { id: 'inbox', icon: 'fa-solid fa-inbox', count: 'inbox_unread' },
    { id: 'starred', icon: 'fa-regular fa-star' },
    { id: 'sent', icon: 'fa-regular fa-paper-plane' },
    { id: 'drafts', icon: 'fa-regular fa-file-lines', count: 'drafts', countMuted: true },
    { id: 'archive', icon: 'fa-solid fa-box-archive' },
    { id: 'spam', icon: 'fa-solid fa-triangle-exclamation', count: 'spam_unread' },
    { id: 'trash', icon: 'fa-regular fa-trash-can' },
];

const spfVerdict = (header?: string) => {
    const m = /^Received-SPF:\s*([a-z]+)/i.exec(String(header || '').trim());
    return m ? m[1].toLowerCase() : '';
};
const SPF_TONE = { fail: 'red', softfail: 'orange', neutral: 'slate', permerror: 'amber', temperror: 'amber' };

const readLocal = (k: string, d: any) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const writeLocal = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };

const addrOf = (s: string) => { const m = /<([^>]+)>/.exec(s || ''); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };

// SPF vouches for the ENVELOPE sender's domain only. When the From the reader sees is on a different
// domain, even an SPF pass says nothing about it — so the reading pane flags the mismatch. Returns the
// two domains when they differ, else null (no recorded verdict = internal mail, nothing to compare).
const domainOfAddr = (a: string) => { const s = String(a || '').trim().toLowerCase(); const i = s.lastIndexOf('@'); return i > 0 ? s.slice(i + 1) : ''; };
const senderMismatch = (header?: string, from?: string) => {
    const h = String(header || '').trim();
    if (!/^Received-SPF:/i.test(h)) return null;
    const m = /envelope-from=<([^>]*)>/i.exec(h);
    const envelope = domainOfAddr(m ? m[1] : '');
    const fromDomain = domainOfAddr(addrOf(from || ''));
    if (!fromDomain || fromDomain === envelope) return null;
    return { from: fromDomain, envelope: envelope || '—' };
};

// The DKIM / DMARC verdict the server recorded (RFC 8601 Authentication-Results, auth_results).
// Returns null when the message was not evaluated (outbound, internal, or the check turned off).
const authVerdict = (header?: string) => {
    const h = String(header || '');
    if (!h) return null;
    const dkim = [...h.matchAll(/dkim=([a-z]+)(?: \([^)]*\))? header\.d=([^\s;]*)/g)].map(m => ({ result: m[1], domain: m[2] }));
    const d = /dmarc=([a-z]+)(?: \(p=([a-z]+) dis=([a-z]+)\))? header\.from=([^\s;]*)/.exec(h);
    const dmarc = d ? { result: d[1], policy: d[2] || '', disposition: d[3] || 'none', domain: d[4] } : null;
    const dkimPass = dkim.find(s => s.result === 'pass');
    const dkimBad = !dkimPass && dkim.find(s => s.result === 'fail' || s.result === 'permerror' || s.result === 'policy');
    return { dkimPass, dkimBad, dmarc };
};

export default function Webmail({ access, user, t, locale, toasts, confirm, isAdmin, onOpenServer }: any) {
    const me = String(access?.address || user?.userEmail || '').toLowerCase();
    const rootRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(rootRef);
    const sidebarMode = width >= 1180 ? 'full' : width >= 720 ? 'rail' : 'drawer';
    const split = width >= 900;
    const phone = width > 0 && width < 640;

    // --- state ---------------------------------------------------------------------------------
    const [folder, setFolder] = useState('inbox');
    const [emails, setEmails] = useState<any[]>([]);
    const [total, setTotal] = useState(0);
    const [counts, setCounts] = useState({ inbox_unread: 0, spam_unread: 0, drafts: 0 });
    const [labels, setLabels] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [activeQuery, setActiveQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [openId, setOpenId] = useState<number | null>(null);
    const [openEmail, setOpenEmail] = useState<any>(null);
    const [openLoading, setOpenLoading] = useState(false);
    const [cursor, setCursor] = useState(0);
    const [drawer, setDrawer] = useState(false);
    const [prefs, setPrefs] = useState<any>({});
    const [quota, setQuota] = useState<any>(null);
    const [composer, setComposer] = useState<any>(null);
    const [composerKey, setComposerKey] = useState(0);
    const [settings, setSettings] = useState<{ open: boolean, tab?: string, seedRule?: any }>({ open: false });
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [creatingLabel, setCreatingLabel] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const [density, setDensityState] = useState(() => readLocal('wjp_mail_density', 'comfortable'));
    const [showPreview, setShowPreviewState] = useState(() => readLocal('wjp_mail_preview', true));
    const [listWidth, setListWidth] = useState(() => readLocal('wjp_mail_list_w', 400));
    // Reader state per open conversation: which messages are expanded, images allowed, details shown.
    const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
    const [showImages, setShowImages] = useState<Record<number, boolean>>({});
    const [details, setDetails] = useState<Record<number, boolean>>({});
    const threadLen = openEmail ? (openEmail.thread ? openEmail.thread.length : 1) : 0;
    useEffect(() => {
        // Newest message (and any unread ones) open; older ones collapsed to a one-line summary.
        if (!openEmail) return;
        const msgs = openEmail.thread && openEmail.thread.length ? openEmail.thread : [openEmail];
        const ids = new Set<number>();
        if (msgs.length) ids.add(msgs[msgs.length - 1].id);
        msgs.forEach((m: any) => { if (m.is_read === 0) ids.add(m.id); });
        setExpandedIds(ids);
        setShowImages({});
        setDetails({});
    }, [openEmail?.id, threadLen]);
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const queryRef = useRef('');
    const folderRef = useRef(folder);
    folderRef.current = folder;

    const setDensity = (v: string) => { setDensityState(v); writeLocal('wjp_mail_density', v); };
    const setShowPreview = (v: boolean) => { setShowPreviewState(v); writeLocal('wjp_mail_preview', v); };
    const { push: toast } = toasts;
    const ok = (text: string, opts?: any) => toast('success', text, opts);
    const fail = (e: any) => toast('error', errorText(e, t));

    // --- data ------------------------------------------------------------------------------------
    const loadList = useCallback(async ({ query = queryRef.current, silent = false, append = false } = {}) => {
        queryRef.current = query;
        const f = folderRef.current;
        if (!silent && !append) setLoading(true);
        if (append) setLoadingMore(true);
        try {
            const offset = append ? emailsRef.current.length : 0;
            const limit = silent && !append ? Math.max(PAGE, emailsRef.current.length) : PAGE;
            const endpoint = query
                ? `/plugin/mail-server/emails/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`
                : `/plugin/mail-server/emails?folder=${encodeURIComponent(f)}&limit=${limit}&offset=${offset}`;
            const res = await api(endpoint) as any;
            if (folderRef.current !== f || queryRef.current !== query) return; // a newer view won
            const labelMap = res.labels || {};
            const list = (res.emails || []).map((e: any) => ({ ...e, labels: labelMap[e.id] || [] }));
            setEmails(prev => append ? [...prev, ...list.filter((x: any) => !prev.some((p: any) => p.id === x.id))] : list);
            setTotal(typeof res.total === 'number' ? res.total : (append ? emailsRef.current.length + list.length : list.length));
            if (res.counts) setCounts(res.counts);
            setLoadError(false);
            if (!append) setSelectedIds(prev => {
                if (!prev.size) return prev;
                const next = new Set<number>();
                for (const e of list) if (prev.has(e.id)) next.add(e.id);
                return next;
            });
        } catch (e) {
            if (!silent) setLoadError(true);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }, []);
    const emailsRef = useRef<any[]>([]);
    emailsRef.current = emails;

    const loadLabels = async () => {
        try { const d = await api('/plugin/mail-server/labels') as any; setLabels(Array.isArray(d?.labels) ? d.labels : []); } catch { /* keep */ }
    };
    const loadPrefs = async () => { try { setPrefs(await api('/plugin/mail-server/prefs') as any); } catch { /* keep */ } };
    const loadQuota = async () => { try { setQuota(await api('/plugin/mail-server/quota') as any); } catch { /* optional */ } };

    useEffect(() => { loadLabels(); loadPrefs(); loadQuota(); }, []);
    useEffect(() => {
        setSelectedIds(new Set());
        setCursor(0);
        if (!split) { setOpenId(null); setOpenEmail(null); }
        loadList({ query: '' });
        setSearchText('');
        setActiveQuery('');
        listRef.current?.scrollTo?.(0, 0);
    }, [folder]);

    // Deep link from a notification: /admin/plugin/emails?id=123
    useEffect(() => {
        try {
            const id = parseInt(new URLSearchParams(window.location.search).get('id') || '', 10);
            if (id > 0) openMessage({ id });
        } catch { /* no window */ }
    }, []);

    // Live refresh: SSE notification + a silent poll every 20 s while visible, and on focus.
    useEffect(() => {
        const onNotif = (e: any) => { if (e?.detail?.type === 'email') { loadList({ silent: true }); loadQuota(); } };
        window.addEventListener('wordjs:notification', onNotif);
        const tick = () => { if (document.visibilityState === 'visible') loadList({ silent: true }); };
        const id = setInterval(tick, 20000);
        window.addEventListener('focus', tick);
        return () => { window.removeEventListener('wordjs:notification', onNotif); clearInterval(id); window.removeEventListener('focus', tick); };
    }, [loadList]);

    // --- opening a conversation --------------------------------------------------------------------
    const openMessage = async (email: any) => {
        if (email.is_draft) return openDraft(email.id);
        setOpenId(email.id);
        setOpenEmail(email.subject !== undefined ? email : null);
        setOpenLoading(true);
        try {
            const full = await api(`/plugin/mail-server/emails/${email.id}`) as any;
            setOpenEmail(full);
            if (email.is_read === 0 || email.is_read === undefined) {
                setEmails(list => list.map(x => x.id === email.id ? { ...x, is_read: 1 } : x));
                setCounts(c => (!email.is_sent && folderRef.current === 'inbox' && email.is_read === 0) ? { ...c, inbox_unread: Math.max(0, c.inbox_unread - 1) } : c);
            }
            // Clear the matching bell notification.
            api('/notifications').then((list: any) => {
                const hit = (Array.isArray(list) ? list : []).find((n: any) => n.is_read === 0 && String(n.action_url || '').includes(`id=${email.id}`));
                if (hit) api(`/notifications/${hit.uuid}/read`, { method: 'POST' }).catch(() => { });
            }).catch(() => { });
        } catch (e) {
            fail(e);
            setOpenId(null);
        } finally {
            setOpenLoading(false);
        }
    };
    const closeMessage = () => { setOpenId(null); setOpenEmail(null); };

    const openDraft = async (id: number) => {
        try {
            const d = await api(`/plugin/mail-server/emails/${id}`) as any;
            startCompose({ to: d.to_address || '', cc: d.cc_address || '', bcc: d.bcc_address || '', subject: d.subject || '', body: d.raw_content || d.body_html || d.body_text || '', draftId: d.id, replyToId: d.thread_id || null, useSignature: true });
        } catch (e) { fail(e); }
    };

    // --- composing ---------------------------------------------------------------------------------
    const startCompose = (initial: any = {}) => {
        setComposer({ to: '', cc: '', bcc: '', subject: '', body: '', attachments: [], useSignature: true, ...initial });
        setComposerKey(k => k + 1);
    };
    const quoteBlock = (msg: any) => {
        const who = escapeHtml(msg.from_name ? `${msg.from_name} <${msg.from_address}>` : msg.from_address);
        const body = msg.body_html ? msg.body_html : escapeHtml(msg.body_text || '').replace(/\n/g, '<br/>');
        return `<br/><br/><div>${escapeHtml(t('comp.wrote', { date: fullDate(msg.date_received, locale), who: '' })).replace(/:$/, '')} ${who}:</div><blockquote>${body}</blockquote>`;
    };
    const lastOf = (email: any) => (email?.thread && email.thread.length ? email.thread[email.thread.length - 1] : email);
    const reply = (email: any, all = false, msg?: any) => {
        const m = msg || lastOf(email);
        const subj = String(m.subject || '');
        let to = m.is_sent ? m.to_address : m.from_address;
        let cc = '';
        if (all) {
            const people = [m.from_address, ...String(m.to_address || '').split(/[,;]/), ...String(m.cc_address || '').split(/[,;]/)]
                .map(addrOf).filter(a => a && a !== me);
            const uniq = [...new Set(people)];
            to = uniq.slice(0, 1).join(', ') || to;
            cc = uniq.slice(1).join(', ');
        }
        startCompose({ kind: 'reply', to, cc, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, body: quoteBlock(m), replyToId: email.id });
    };
    const forward = (email: any, msg?: any) => {
        const m = msg || lastOf(email);
        const head = `<br/><br/><div>${escapeHtml(t('comp.forwardedHeader'))}<br/>${escapeHtml(t('read.from'))}: ${escapeHtml(m.from_name || '')} &lt;${escapeHtml(m.from_address)}&gt;<br/>${escapeHtml(t('read.date'))}: ${escapeHtml(fullDate(m.date_received, locale))}<br/>${escapeHtml(t('comp.subject'))}: ${escapeHtml(m.subject)}<br/>${escapeHtml(t('comp.to'))}: ${escapeHtml(m.to_address)}</div><br/>`;
        const body = m.body_html || escapeHtml(m.body_text || '').replace(/\n/g, '<br/>');
        startCompose({ kind: 'forward', subject: `Fwd: ${String(m.subject || '').replace(/^(re|fwd?):\s*/i, '')}`, body: head + body,
            // The original files travel by id: the server checks the user may read them and copies them.
            attachments: (m.attachments || []).map((a: any) => ({ attachmentId: a.id, filename: a.filename, size: a.size, contentType: a.content_type })) });
    };

    const onSent = (res: any, { scheduled }: any) => {
        setComposer(null);
        if (res && res.success === false) {
            toast('error', res.message || t('read.stillFailing'));
        } else if (res && res.queued) {
            const id = res.id;
            toast('progress', t('comp.sending'), {
                ttl: Math.max(1, Number(res.undoSeconds) || 10) * 1000,
                action: { label: t('comp.undo'), onClick: () => undoSend(id) }
            });
        } else {
            ok(scheduled ? t('comp.scheduled') : t('comp.sent'));
        }
        setTimeout(() => { loadList({ silent: true }); loadQuota(); }, 400);
    };
    const undoSend = async (id: number) => {
        try {
            await api(`/plugin/mail-server/emails/${id}/unsend`, { method: 'POST' });
            const d = await api(`/plugin/mail-server/emails/${id}`) as any;
            startCompose({ to: d.to_address || '', cc: d.cc_address || '', bcc: d.bcc_address || '', subject: d.subject || '', body: d.raw_content || d.body_html || d.body_text || '', draftId: d.id, useSignature: false });
            ok(t('comp.unsent'));
            loadList({ silent: true });
        } catch (e: any) {
            toast('error', e?.message || t('comp.tooLate'));
        }
    };

    // --- actions -----------------------------------------------------------------------------------
    const removeFromList = (ids: number[]) => {
        setEmails(list => list.filter(x => !ids.includes(x.id)));
        setTotal(n => Math.max(0, n - ids.length));
        if (openId && ids.includes(openId)) {
            // Move to the next conversation in split view (Gmail behaviour), else back to the list.
            const idx = emails.findIndex(x => x.id === openId);
            const next = emails.filter(x => !ids.includes(x.id))[idx] || null;
            if (split && next) openMessage(next); else closeMessage();
        }
        setSelectedIds(prev => { const n = new Set(prev); ids.forEach(i => n.delete(i)); return n; });
    };

    const bulk = async (action: string, ids: number[], opts: any = {}) => {
        if (!ids.length) return;
        if (action === 'delete' && !(await confirm(ids.length > 1 ? t('confirm.bulkDelete', { n: ids.length }) : t('confirm.deleteForever'), t('act.deleteForever'), true))) return;
        const snapshot = emails;
        const leaves = ['archive', 'trash', 'restore', 'spam', 'notspam', 'delete'].includes(action)
            || (action === 'unarchive' && folder === 'archive') || (action === 'unstar' && folder === 'starred')
            || (action === 'unlabel' && folder === `label:${opts.labelId}`);
        if (leaves) removeFromList(ids);
        else setEmails(list => list.map(x => ids.includes(x.id) ? {
            ...x,
            ...(action === 'read' ? { is_read: 1 } : action === 'unread' ? { is_read: 0 } : {}),
            ...(action === 'star' ? { is_starred: 1 } : action === 'unstar' ? { is_starred: 0 } : {}),
        } : x));
        if (openEmail && ids.includes(openEmail.id) && !leaves) {
            setOpenEmail((o: any) => o && ({ ...o, ...(action === 'star' ? { is_starred: 1 } : action === 'unstar' ? { is_starred: 0 } : {}) }));
        }
        try {
            await api('/plugin/mail-server/emails/bulk', { method: 'POST', body: { ids, action, labelId: opts.labelId } });
            const undoable = { archive: 'unarchive', trash: 'restore', spam: 'notspam' }[action];
            const msg = {
                archive: t('toast.archived'), trash: t('toast.trashed'), restore: t('toast.restored'), spam: t('toast.spam'),
                notspam: t('toast.notSpam'), delete: t('toast.deleted'), unarchive: t('toast.moved', { folder: t('folder.inbox') }),
            }[action];
            if (msg || ids.length > 1) {
                ok(msg || t('toast.updated', { n: ids.length }), undoable && !opts.noUndo ? {
                    action: { label: t('comp.undo'), onClick: async () => { await api('/plugin/mail-server/emails/bulk', { method: 'POST', body: { ids, action: undoable } }).catch(fail); loadList({ silent: true }); } }
                } : undefined);
            }
            if (action === 'label' || action === 'unlabel') loadLabels();
            loadList({ silent: true });
        } catch (e) {
            setEmails(snapshot);
            fail(e);
        }
    };

    const toggleLabelOn = async (email: any, label: any) => {
        const has = (email.labels || []).some((l: any) => l.id === label.id);
        try {
            const res = await api(`/plugin/mail-server/emails/${email.id}/labels`, { method: 'PUT', body: has ? { remove: [label.id] } : { add: [label.id] } }) as any;
            const updated = res.labels || [];
            setOpenEmail((o: any) => o && o.id === email.id ? { ...o, labels: updated } : o);
            setEmails(list => list.map(x => x.id === email.id ? { ...x, labels: updated } : x));
            loadLabels();
        } catch (e) { fail(e); }
    };

    const createLabel = async (e?: any) => {
        e?.preventDefault?.();
        const name = newLabel.trim();
        if (!name) return;
        try {
            await api('/plugin/mail-server/labels', { method: 'POST', body: { name, color: LABEL_COLORS[labels.length % LABEL_COLORS.length] } });
            setNewLabel(''); setCreatingLabel(false); loadLabels();
        } catch (err) { fail(err); }
    };
    const recolorLabel = async (label: any, color: string) => {
        try { await api(`/plugin/mail-server/labels/${label.id}`, { method: 'PUT', body: { color } }); loadLabels(); } catch (e) { fail(e); }
    };
    const deleteLabel = async (label: any) => {
        if (!(await confirm(t('folder.deleteLabelConfirm', { name: label.name }), t('folder.deleteLabel'), true))) return;
        try {
            await api(`/plugin/mail-server/labels/${label.id}`, { method: 'DELETE' });
            if (folder === `label:${label.id}`) setFolder('inbox');
            loadLabels();
        } catch (e) { fail(e); }
    };

    const emptyTrash = async () => {
        if (!(await confirm(t('confirm.emptyTrash'), t('folder.emptyTrash'), true))) return;
        try {
            const res = await api('/plugin/mail-server/trash/empty', { method: 'DELETE' }) as any;
            closeMessage();
            const n = typeof res?.deleted === 'number' ? res.deleted : null;
            ok(n === 1 ? t('toast.trashEmptiedOne') : n === null ? t('folder.emptyTrash') : t('toast.trashEmptied', { n }));
            loadList();
            loadQuota();
        } catch (e) { fail(e); }
    };

    const retryDelivery = async (email: any) => {
        try {
            const res = await api(`/plugin/mail-server/emails/${email.id}/retry`, { method: 'POST' }) as any;
            if (res && res.success) {
                ok(t('read.delivered'));
                setOpenEmail((o: any) => o && o.id === email.id ? { ...o, delivery_status: 'sent', last_error: null } : o);
            } else {
                toast('error', res?.message || t('read.stillFailing'));
                setOpenEmail((o: any) => o && o.id === email.id ? { ...o, delivery_status: res?.status || 'failed', last_error: res?.lastError || o.last_error } : o);
            }
            loadList({ silent: true });
        } catch (e) { fail(e); }
    };

    const blockedList = (prefs?.blockedSenders || []) as string[];
    const isBlocked = (addr: string) => blockedList.includes(String(addr || '').toLowerCase());
    const toggleBlock = async (addr: string, email?: any) => {
        const a = String(addr || '').toLowerCase();
        if (!a) return;
        const blocked = isBlocked(a);
        const next = blocked ? blockedList.filter(x => x !== a) : [...blockedList, a];
        try {
            await api('/plugin/mail-server/prefs', { method: 'PUT', body: { blockedSenders: next } });
            setPrefs((p: any) => ({ ...p, blockedSenders: next }));
            if (!blocked && email && !email.is_spam) await bulk('spam', [email.id], { noUndo: true });
            ok(blocked ? t('toast.unblocked', { who: a }) : t('toast.blocked', { who: a }));
        } catch (e) { fail(e); }
    };

    const filterLike = (email: any) => {
        const from = addrOf(email.from_address);
        setSettings({ open: true, tab: 'filters', seedRule: { id: Math.random().toString(36).slice(2, 10), name: from, enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: from }], actions: {} } });
    };

    const printConversation = (email: any) => {
        const msgs = email.thread && email.thread.length ? email.thread : [email];
        const html = `<h1 style="font:600 20px system-ui">${escapeHtml(email.subject)}</h1>` + msgs.map((m: any) =>
            `<hr/><p style="font:13px system-ui;color:#475569"><b>${escapeHtml(m.from_name || m.from_address)}</b> &lt;${escapeHtml(m.from_address)}&gt;<br/>${escapeHtml(fullDate(m.date_received, locale))}<br/>${escapeHtml(t('comp.to'))}: ${escapeHtml(m.to_address)}</p>`
            + `<div style="font:14px/1.6 system-ui">${m.body_html ? sanitizeHTML(prepareEmailHtml(m.body_html, true).html) : escapeHtml(m.body_text || '').replace(/\n/g, '<br/>')}</div>`
        ).join('');
        const frame = document.createElement('iframe');
        // No scripts in the frame; allow-modals is what lets the PARENT call print() on it.
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
        frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(email.subject)}</title></head><body>${html}</body></html>`;
        frame.onload = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { /* blocked */ } setTimeout(() => frame.remove(), 60000); };
        document.body.appendChild(frame);
    };

    // --- keyboard shortcuts ----------------------------------------------------------------------
    const gPressed = useRef(0);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = e.target as HTMLElement;
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
            if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
            if (composer || settings.open || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
            const k = e.key;
            const current = openEmail || emails[cursor];
            if (k === 'g') { gPressed.current = Date.now(); return; }
            if (k === 'i' && Date.now() - gPressed.current < 1200) { go('inbox'); return; }
            const map: Record<string, () => void> = {
                'c': () => startCompose(),
                '/': () => searchRef.current?.focus(),
                '?': () => setShortcutsOpen(true),
                'j': () => { const n = Math.min(cursor + 1, emails.length - 1); setCursor(n); if (openId && emails[n]) openMessage(emails[n]); },
                'k': () => { const n = Math.max(cursor - 1, 0); setCursor(n); if (openId && emails[n]) openMessage(emails[n]); },
                'o': () => emails[cursor] && openMessage(emails[cursor]),
                'Enter': () => emails[cursor] && openMessage(emails[cursor]),
                'u': () => closeMessage(),
                'Escape': () => { if (selectedIds.size) setSelectedIds(new Set()); else closeMessage(); },
                'x': () => emails[cursor] && toggleSelect(emails[cursor].id),
                'r': () => openEmail && reply(openEmail),
                'a': () => openEmail && reply(openEmail, true),
                'f': () => openEmail && forward(openEmail),
                'e': () => current && bulk(folder === 'archive' ? 'unarchive' : 'archive', [current.id]),
                '#': () => current && bulk(folder === 'trash' ? 'delete' : 'trash', [current.id]),
                's': () => current && bulk(current.is_starred ? 'unstar' : 'star', [current.id]),
                'U': () => current && bulk('unread', [current.id]),
            };
            const fn = map[k];
            if (fn) { e.preventDefault(); fn(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    });

    useEffect(() => {
        const row = listRef.current?.querySelector?.(`[data-row="${cursor}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
    }, [cursor]);

    const toggleSelect = (id: number) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

    // --- resizable list (split view) -----------------------------------------------------------------
    const startResize = (e: any) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = listWidth;
        const max = Math.max(360, Math.min(720, width - 460));
        const clamp = (x: number) => Math.min(Math.max(startW + (x - startX), 300), max);
        const move = (ev: any) => setListWidth(clamp(ev.clientX));
        const up = (ev: any) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.body.style.userSelect = '';
            writeLocal('wjp_mail_list_w', clamp(ev.clientX));
        };
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    };

    // --- derived -----------------------------------------------------------------------------------
    const folderLabel = folder.startsWith('label:')
        ? (labels.find(l => `label:${l.id}` === folder)?.name || t('folder.labels'))
        : t(`folder.${folder}`);
    const viewTitle = activeQuery ? `${t('common.search')}: ${activeQuery}` : folderLabel;
    const allSelected = emails.length > 0 && emails.every(e => selectedIds.has(e.id));
    const selection = [...selectedIds];
    const showReader = split || !!openId;
    const showList = split || !openId;
    const effListWidth = Math.min(listWidth, Math.max(320, width - (sidebarMode === 'full' ? 248 : sidebarMode === 'rail' ? 72 : 0) - 420));

    const go = (f: string) => {
        setDrawer(false);
        closeMessage();
        // The folder effect only runs on a CHANGE: picking the folder already shown (to leave a search)
        // must clear the search and reload it here, or the results simply stayed on screen.
        if (f === folderRef.current) {
            setSearchText('');
            setActiveQuery('');
            loadList({ query: '' });
        } else {
            setFolder(f);
        }
    };
    const runSearch = (q: string) => {
        const query = q.trim();
        setActiveQuery(query);
        closeMessage();
        loadList({ query });
    };

    // --- sidebar ---------------------------------------------------------------------------------
    const quotaBar = quota && (quota.quotaMb > 0 || quota.usedBytes > 0) && (
        <div className="px-3 pb-1 pt-3">
            {quota.quotaMb > 0 && (
                <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div className={cx('h-full rounded-full', quota.percent >= 95 ? 'bg-red-500' : quota.percent >= 80 ? 'bg-amber-500' : 'bg-violet-500')} style={{ width: `${Math.max(2, quota.percent)}%` }}></div>
                </div>
            )}
            <p className={cx('text-[11px]', quota.full ? 'font-semibold text-red-600' : 'text-slate-500')}>
                {quota.full ? t('quota.full') : quota.quotaMb > 0
                    ? t('quota.used', { used: formatBytes(quota.usedBytes), total: formatBytes(quota.quotaMb * 1048576) })
                    : t('quota.usedNoLimit', { used: formatBytes(quota.usedBytes) })}
            </p>
        </div>
    );

    const SidebarFull = (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-sm"><i className="fa-solid fa-envelope"></i></span>
                <div className="min-w-0">
                    <div className="text-[15px] font-bold leading-tight text-slate-900">{t('app.name')}</div>
                    <div className="truncate text-[11px] text-slate-500">{me}</div>
                </div>
                {sidebarMode === 'drawer' && <IconBtn icon="fa-solid fa-xmark" label={t('common.close')} className="ml-auto" onClick={() => setDrawer(false)} />}
            </div>
            <div className="px-3 pb-3">
                <button type="button" onClick={() => { startCompose(); setDrawer(false); }} className="flex h-12 w-full items-center gap-3 rounded-2xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-md shadow-violet-600/25 transition hover:bg-violet-700 active:scale-[0.99]">
                    <i className="fa-solid fa-pen"></i>{t('act.compose')}
                </button>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {FOLDERS.map(f => {
                    const n = f.count ? counts[f.count] : 0;
                    const active = folder === f.id && !activeQuery;
                    return (
                        <button key={f.id} type="button" onClick={() => go(f.id)}
                            className={cx('group flex h-9 w-full items-center gap-3 rounded-full px-4 text-sm transition-colors', active ? 'bg-violet-100 font-semibold text-violet-900' : 'text-slate-700 hover:bg-slate-100')}>
                            <i className={cx(f.icon, 'w-4 text-center', active ? 'text-violet-700' : 'text-slate-500')}></i>
                            <span className="flex-1 truncate text-left">{t(`folder.${f.id}`)}</span>
                            {n > 0 && <span className={cx('text-xs tabular-nums', f.countMuted ? 'text-slate-500' : 'font-semibold')}>{n}</span>}
                        </button>
                    );
                })}
                {folder === 'trash' && emails.length > 0 && (
                    <button type="button" onClick={emptyTrash} className="ml-11 mt-1 text-xs font-semibold text-red-600 hover:underline">{t('folder.emptyTrash')}</button>
                )}
                <div className="mb-1 mt-4 flex items-center justify-between pl-4 pr-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t('folder.labels')}</span>
                    <IconBtn size="sm" icon={creatingLabel ? 'fa-solid fa-minus' : 'fa-solid fa-plus'} label={t('folder.newLabel')} onClick={() => { setCreatingLabel(v => !v); setNewLabel(''); }} />
                </div>
                {creatingLabel && (
                    <form onSubmit={createLabel} className="mb-1 flex gap-1.5 px-2">
                        <input autoFocus value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={40} placeholder={t('folder.labelName')}
                            className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-sm outline-none focus:border-violet-500" />
                        <Button size="sm" variant="primary" type="submit">{t('common.create')}</Button>
                    </form>
                )}
                {labels.map(l => {
                    const active = folder === `label:${l.id}` && !activeQuery;
                    return (
                        <div key={l.id} className={cx('group flex h-9 items-center rounded-full pr-1 transition-colors', active ? 'bg-violet-100' : 'hover:bg-slate-100')}>
                            <button type="button" onClick={() => go(`label:${l.id}`)} className="flex min-w-0 flex-1 items-center gap-3 pl-4 text-sm">
                                <span className="h-3 w-3 shrink-0 rounded-[4px]" style={{ background: l.color || '#7c3aed' }}></span>
                                <span className={cx('flex-1 truncate text-left', active ? 'font-semibold text-violet-900' : 'text-slate-700')}>{l.name}</span>
                                {(l.email_count || 0) > 0 && <span className="text-xs tabular-nums text-slate-400 group-hover:hidden">{l.email_count}</span>}
                            </button>
                            <Menu width="w-52" trigger={({ toggle }: any) => (
                                <IconBtn size="sm" icon="fa-solid fa-ellipsis-vertical" label={t('common.more')} className="opacity-100 lg:opacity-0 lg:group-hover:opacity-100" onClick={toggle} />
                            )}>
                                <div className="grid grid-cols-5 gap-1.5 px-3 py-2">
                                    {LABEL_COLORS.map(c => (
                                        <button key={c} type="button" data-menu-close onClick={() => recolorLabel(l, c)} aria-label={c}
                                            className={cx('h-6 w-6 rounded-md ring-offset-2', l.color === c && 'ring-2 ring-slate-400')} style={{ background: c }}></button>
                                    ))}
                                </div>
                                <MenuItem icon="fa-regular fa-trash-can" danger onClick={() => deleteLabel(l)}>{t('folder.deleteLabel')}</MenuItem>
                            </Menu>
                        </div>
                    );
                })}
            </nav>
            {quotaBar}
            <div className="flex items-center gap-1 border-t border-slate-200/70 px-2 py-2">
                <Button variant="ghost" size="sm" icon="fa-solid fa-gear" className="flex-1 justify-start" onClick={() => { setSettings({ open: true, tab: 'general' }); setDrawer(false); }}>{t('act.settings')}</Button>
                <IconBtn size="sm" icon="fa-regular fa-keyboard" label={t('act.shortcuts')} onClick={() => setShortcutsOpen(true)} className="hidden sm:inline-flex" />
                {isAdmin && <IconBtn size="sm" icon="fa-solid fa-server" label={t('app.serverConsole')} onClick={onOpenServer} />}
            </div>
        </div>
    );

    const SidebarRail = (
        <div className="flex h-full flex-col items-center gap-1 py-3">
            <button type="button" onClick={() => startCompose()} title={t('act.compose')} aria-label={t('act.compose')} className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-md shadow-violet-600/25 hover:bg-violet-700">
                <i className="fa-solid fa-pen"></i>
            </button>
            {FOLDERS.map(f => {
                const n = f.count ? counts[f.count] : 0;
                const active = folder === f.id && !activeQuery;
                return <IconBtn key={f.id} size="lg" icon={f.icon} label={t(`folder.${f.id}`)} active={active} badge={!f.countMuted && n > 0 ? (n > 99 ? '99+' : n) : null} onClick={() => go(f.id)} />;
            })}
            {labels.length > 0 && <span className="my-1 h-px w-8 bg-slate-200"></span>}
            <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto">
                {labels.map(l => (
                    <button key={l.id} type="button" title={l.name} aria-label={l.name} onClick={() => go(`label:${l.id}`)}
                        className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', folder === `label:${l.id}` ? 'bg-violet-100' : 'hover:bg-slate-100')}>
                        <span className="h-3.5 w-3.5 rounded-[4px]" style={{ background: l.color }}></span>
                    </button>
                ))}
            </div>
            <span className="flex-1"></span>
            <IconBtn icon="fa-solid fa-folder-tree" label={t('folder.labels')} onClick={() => setDrawer(true)} />
            <IconBtn icon="fa-solid fa-gear" label={t('act.settings')} onClick={() => setSettings({ open: true, tab: 'general' })} />
            {isAdmin && <IconBtn icon="fa-solid fa-server" label={t('app.serverConsole')} onClick={onOpenServer} />}
        </div>
    );

    // --- list ------------------------------------------------------------------------------------
    const compact = density === 'compact';
    const emptyFor = () => {
        if (activeQuery) return { icon: 'fa-solid fa-magnifying-glass', title: t('list.empty.search', { q: activeQuery }) };
        if (folder.startsWith('label:')) return { icon: 'fa-solid fa-tag', title: t('list.empty.label') };
        const icon = { inbox: 'fa-solid fa-mug-hot', trash: 'fa-regular fa-trash-can', drafts: 'fa-regular fa-file-lines', sent: 'fa-regular fa-paper-plane', archive: 'fa-solid fa-box-archive', starred: 'fa-regular fa-star', spam: 'fa-solid fa-shield-halved' }[folder];
        return { icon, title: t(`list.empty.${folder}`), hint: folder === 'inbox' ? t('list.empty.inboxHint') : null };
    };

    const renderRow = (email: any, index: number) => {
        const unread = !email.is_read && !email.is_sent;
        const selected = selectedIds.has(email.id);
        const isOpen = openId === email.id;
        const who = email.is_draft
            ? t('list.draft')
            : email.is_sent ? t('list.to', { who: shortPeople(email.to_address, me, t('list.me')) || '—' }) : (email.from_name || email.from_address);
        const scheduledSoon = !email.is_sent && !email.is_draft && email.scheduled_at;
        const scheduledTime = scheduledSoon ? parseDate(email.scheduled_at) : null;
        return (
            <div
                key={email.id}
                data-row={index}
                role="option"
                aria-selected={isOpen}
                onClick={() => { setCursor(index); openMessage(email); }}
                className={cx(
                    'group relative flex cursor-pointer gap-3 border-b border-slate-100 px-3 transition-colors sm:px-4',
                    compact ? 'py-2' : 'py-3',
                    isOpen ? 'bg-violet-50' : selected ? 'bg-violet-50/60' : unread ? 'bg-white hover:bg-slate-50' : 'bg-slate-50/40 hover:bg-slate-50',
                    cursor === index && 'shadow-[inset_3px_0_0_#7c3aed]'
                )}
            >
                {/* Avatar doubles as the selection checkbox (tap it on touch screens). */}
                <button type="button" onClick={(e) => { e.stopPropagation(); toggleSelect(email.id); }} aria-label={t('kb.select')} aria-pressed={selected}
                    className={cx('relative mt-0.5 shrink-0 rounded-full', compact ? 'h-8 w-8' : 'h-10 w-10')}>
                    {selected ? (
                        <span className={cx('flex items-center justify-center rounded-full bg-violet-600 text-white', compact ? 'h-8 w-8' : 'h-10 w-10')}><i className="fa-solid fa-check"></i></span>
                    ) : (
                        <>
                            <Avatar name={email.is_sent ? shortPeople(email.to_address) : (email.from_name || email.from_address)} email={email.is_sent ? addrOf(email.to_address) : email.from_address} size={compact ? 32 : 40} className={cx(selectedIds.size > 0 ? 'opacity-0' : 'lg:group-hover:opacity-0')} />
                            <span className={cx('absolute inset-0 items-center justify-center rounded-full border-2 border-slate-300 bg-white text-transparent', selectedIds.size > 0 ? 'flex' : 'hidden lg:group-hover:flex')}></span>
                        </>
                    )}
                </button>
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                        <span className={cx('min-w-0 flex-1 truncate text-[14px]', unread ? 'font-bold text-slate-900' : 'text-slate-700', email.is_draft && 'text-red-600')}>
                            {who}
                            {email.thread_count > 1 && <span className="ml-1.5 text-xs font-normal text-slate-400">{email.thread_count}</span>}
                        </span>
                        <span className={cx('shrink-0 text-xs tabular-nums', unread ? 'font-bold text-violet-700' : 'text-slate-500', 'lg:group-hover:invisible')}>
                            {scheduledTime ? <><i className="fa-regular fa-clock mr-1"></i>{listDate(email.scheduled_at, locale)}</> : listDate(email.date_received, locale)}
                        </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={cx('min-w-0 truncate text-[13px]', unread ? 'font-semibold text-slate-900' : 'text-slate-700')}>{email.subject || <i className="text-slate-400">(no subject)</i>}</span>
                        {!!email.has_attachment && <i className="fa-solid fa-paperclip shrink-0 text-[11px] text-slate-400"></i>}
                    </div>
                    {showPreview && !compact && email.snippet && (
                        <p className="mt-0.5 truncate text-[13px] text-slate-500">{email.snippet}</p>
                    )}
                    {((email.labels || []).length > 0 || email.delivery_status === 'failed' || email.delivery_status === 'retry' || scheduledSoon || (activeQuery && email.is_spam)) && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                            {email.delivery_status === 'failed' && <Pill tone="red"><i className="fa-solid fa-circle-exclamation"></i>{t('badge.failed')}</Pill>}
                            {email.delivery_status === 'retry' && <Pill tone="amber"><i className="fa-solid fa-rotate"></i>{t('badge.retrying')}</Pill>}
                            {scheduledSoon && <Pill tone="violet">{scheduledTime && scheduledTime.getTime() - Date.now() < 60000 ? t('badge.sending') : t('badge.scheduled')}</Pill>}
                            {activeQuery && !!email.is_spam && <Pill tone="orange">{t('badge.spam')}</Pill>}
                            {(email.labels || []).slice(0, 3).map((l: any) => (
                                <span key={l.id} className="inline-flex max-w-[140px] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ background: `${l.color}1a`, color: l.color }}>{l.name}</span>
                            ))}
                        </div>
                    )}
                </div>
                {/* Right column: star (always), hover actions on desktop */}
                <div className="flex shrink-0 flex-col items-end justify-between">
                    <span className="h-4"></span>
                    {!email.is_draft && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); bulk(email.is_starred ? 'unstar' : 'star', [email.id]); }}
                            aria-label={email.is_starred ? t('act.unstar') : t('act.star')} className="-mr-1 rounded-full p-1.5 hover:bg-slate-100">
                            <i className={cx(email.is_starred ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star text-slate-300 hover:text-slate-500', 'text-sm')}></i>
                        </button>
                    )}
                </div>
                {!email.is_draft && (
                    <div className="absolute right-3 top-2 hidden items-center gap-0.5 rounded-full bg-white/95 px-1 shadow-sm ring-1 ring-slate-200 lg:group-hover:flex">
                        {folder !== 'trash' && folder !== 'spam' && <IconBtn size="sm" icon="fa-solid fa-box-archive" label={folder === 'archive' ? t('act.unarchive') : t('act.archive')} onClick={(e: any) => { e.stopPropagation(); bulk(folder === 'archive' ? 'unarchive' : 'archive', [email.id]); }} />}
                        {folder === 'trash'
                            ? <IconBtn size="sm" icon="fa-solid fa-rotate-left" label={t('act.restore')} onClick={(e: any) => { e.stopPropagation(); bulk('restore', [email.id]); }} />
                            : <IconBtn size="sm" icon="fa-regular fa-trash-can" label={t('act.trash')} onClick={(e: any) => { e.stopPropagation(); bulk('trash', [email.id]); }} />}
                        <IconBtn size="sm" icon={email.is_read ? 'fa-regular fa-envelope' : 'fa-regular fa-envelope-open'} label={email.is_read ? t('act.markUnread') : t('act.markRead')} onClick={(e: any) => { e.stopPropagation(); bulk(email.is_read ? 'unread' : 'read', [email.id]); }} />
                    </div>
                )}
            </div>
        );
    };

    const BulkBar = selection.length > 0 && (
        <div className={cx('flex items-center gap-1 border-b border-violet-100 bg-violet-50 px-2 py-1.5', phone && 'fixed inset-x-0 bottom-0 z-40 justify-around border-t border-b-0 bg-white shadow-[0_-4px_20px_rgba(15,23,42,0.08)]')} style={phone ? { paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' } : undefined}>
            {!phone && <IconBtn size="sm" icon="fa-solid fa-xmark" label={t('common.close')} onClick={() => setSelectedIds(new Set())} />}
            {!phone && <span className="mr-2 text-sm font-semibold text-violet-900 tabular-nums">{t('list.selected', { n: selection.length })}</span>}
            {folder !== 'trash' && folder !== 'spam' && <IconBtn icon="fa-solid fa-box-archive" label={folder === 'archive' ? t('act.unarchive') : t('act.archive')} onClick={() => bulk(folder === 'archive' ? 'unarchive' : 'archive', selection)} />}
            {folder === 'spam' ? <IconBtn icon="fa-solid fa-circle-check" label={t('act.notSpam')} onClick={() => bulk('notspam', selection)} />
                : folder !== 'trash' && <IconBtn icon="fa-solid fa-triangle-exclamation" label={t('act.spam')} onClick={() => bulk('spam', selection)} />}
            {folder === 'trash' ? (
                <>
                    <IconBtn icon="fa-solid fa-rotate-left" label={t('act.restore')} onClick={() => bulk('restore', selection)} />
                    <IconBtn icon="fa-solid fa-trash-can" danger label={t('act.deleteForever')} onClick={() => bulk('delete', selection)} />
                </>
            ) : <IconBtn icon="fa-regular fa-trash-can" label={t('act.trash')} onClick={() => bulk('trash', selection)} />}
            <IconBtn icon="fa-regular fa-envelope-open" label={t('act.markRead')} onClick={() => bulk('read', selection)} />
            <IconBtn icon="fa-regular fa-envelope" label={t('act.markUnread')} onClick={() => bulk('unread', selection)} />
            <Menu align={phone ? 'right' : 'left'} width="w-56" className={phone ? '' : ''} trigger={({ toggle }: any) => <IconBtn icon="fa-solid fa-tag" label={t('act.label')} onClick={toggle} />}>
                {labels.length === 0 && <p className="px-3.5 py-2 text-xs text-slate-500">{t('folder.newLabel')}…</p>}
                {labels.map(l => <MenuItem key={l.id} onClick={() => bulk('label', selection, { labelId: l.id })} icon="fa-solid fa-tag">{l.name}</MenuItem>)}
            </Menu>
            {phone && <IconBtn icon="fa-solid fa-xmark" label={t('common.close')} onClick={() => setSelectedIds(new Set())} />}
        </div>
    );

    const ListPane = (
        <section className={cx('flex min-h-0 min-w-0 flex-col bg-white', split ? 'shrink-0 border-r border-slate-200' : 'flex-1')} style={split ? { width: effListWidth } : undefined}>
            {/* App bar */}
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-2 py-2 sm:px-3">
                {sidebarMode === 'drawer' && (
                    // Not a hamburger: the admin shell already shows one right above on phones. This opens
                    // the MAIL folders, so it shows the current folder's icon.
                    <button type="button" onClick={() => setDrawer(true)} aria-label={t('folder.labels')} title={t('folder.labels')}
                        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white pl-3 pr-2.5 text-slate-600 hover:bg-slate-50">
                        <i className={cx((FOLDERS.find(f => f.id === folder) || { icon: 'fa-solid fa-tag' }).icon, 'text-sm text-violet-600')}></i>
                        <i className="fa-solid fa-chevron-down text-[10px] text-slate-400"></i>
                    </button>
                )}
                <form className="relative min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); runSearch(searchText); }}>
                    <i className="fa-solid fa-magnifying-glass pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400"></i>
                    <input
                        ref={searchRef}
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Escape') { setSearchText(''); if (activeQuery) runSearch(''); (e.target as any).blur(); } }}
                        placeholder={t('list.search')}
                        title={t('list.searchHelp')}
                        aria-label={t('list.search')}
                        className="h-10 w-full rounded-full border border-transparent bg-slate-100 pl-10 pr-9 text-sm text-slate-800 outline-none transition placeholder:text-slate-500 focus:border-violet-300 focus:bg-white focus:ring-4 focus:ring-violet-500/10"
                    />
                    {(searchText || activeQuery) && (
                        <button type="button" aria-label={t('common.close')} onClick={() => { setSearchText(''); runSearch(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700">
                            <i className="fa-solid fa-xmark text-xs"></i>
                        </button>
                    )}
                </form>
                {phone && <Avatar name={user?.displayName || user?.username} email={me} size={32} />}
            </div>
            {/* Toolbar */}
            {selection.length > 0 && !phone ? BulkBar : (
                <div className="flex h-11 shrink-0 items-center gap-1 border-b border-slate-100 px-2 sm:px-3">
                    <button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(emails.map(e => e.id)))} aria-label={t('list.selectAll')} title={t('list.selectAll')}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100">
                        <i className={allSelected ? 'fa-solid fa-square-check text-violet-600' : 'fa-regular fa-square'}></i>
                    </button>
                    <IconBtn size="sm" icon={cx('fa-solid fa-rotate-right', loading && 'fa-spin')} label={t('common.refresh')} onClick={() => { loadList(); loadQuota(); }} />
                    <h2 className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">
                        {viewTitle}
                        {folder === 'inbox' && !activeQuery && counts.inbox_unread > 0 && <span className="ml-2 font-normal text-slate-500">{t('list.unread', { n: counts.inbox_unread })}</span>}
                    </h2>
                    {total > 0 && <span className="shrink-0 text-xs tabular-nums text-slate-500">{Math.min(emails.length, total)} / {total}</span>}
                    {folder === 'trash' && emails.length > 0 && sidebarMode !== 'full' && <Button size="sm" variant="dangerGhost" onClick={emptyTrash}>{t('folder.emptyTrash')}</Button>}
                </div>
            )}
            {folder === 'spam' && emails.length > 0 && !activeQuery && (
                <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800"><i className="fa-solid fa-circle-info"></i>{t('folder.emptySpam')}</div>
            )}
            {quota?.full && <div className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-xs font-medium text-red-700"><i className="fa-solid fa-hard-drive"></i>{t('quota.full')}</div>}
            {/* Rows */}
            <div ref={listRef} role="listbox" aria-label={viewTitle} className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain', phone && selection.length > 0 && 'pb-16')}>
                {loading && emails.length === 0 ? (
                    <div className="divide-y divide-slate-100">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="flex animate-pulse gap-3 px-4 py-3.5">
                                <div className="h-10 w-10 rounded-full bg-slate-200"></div>
                                <div className="flex-1 space-y-2 py-1"><div className="h-3 w-1/3 rounded bg-slate-200"></div><div className="h-3 w-3/4 rounded bg-slate-100"></div></div>
                            </div>
                        ))}
                    </div>
                ) : loadError ? (
                    <EmptyState icon="fa-solid fa-triangle-exclamation" title={t('list.loadError')} hint={t('list.loadErrorHint')} action={<Button variant="dark" icon="fa-solid fa-rotate-right" onClick={() => loadList()}>{t('common.retry')}</Button>} />
                ) : emails.length === 0 ? (
                    (() => { const e = emptyFor(); return <EmptyState icon={e.icon} title={e.title} hint={e.hint} />; })()
                ) : (
                    <>
                        {emails.map((email, i) => renderRow(email, i))}
                        {emails.length < total && (
                            <div className="p-4 text-center">
                                <Button variant="secondary" loading={loadingMore} onClick={() => loadList({ append: true })}>{t('list.loadMore')}</Button>
                            </div>
                        )}
                    </>
                )}
            </div>
            {phone && selection.length > 0 && BulkBar}
        </section>
    );

    // --- reader ----------------------------------------------------------------------------------
    const renderReader = () => {
        const email = openEmail;
        const msgs = email ? (email.thread && email.thread.length ? email.thread : [email]) : [];

        if (!openId) {
            return (
                <div className="flex flex-1 flex-col items-center justify-center bg-slate-50/50 px-6 text-center">
                    <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-3xl bg-white text-3xl text-slate-300 shadow-sm ring-1 ring-slate-200"><i className="fa-regular fa-envelope-open"></i></div>
                    <p className="text-sm font-medium text-slate-600">{t('read.select')}</p>
                    <p className="mt-1 hidden text-xs text-slate-400 lg:block">{t('read.selectHint')}</p>
                </div>
            );
        }
        if (!email || (openLoading && !email.body_html && !email.body_text && !email.thread)) {
            return <div className="flex flex-1 items-center justify-center"><Spinner className="text-2xl" /></div>;
        }
        const idx = emails.findIndex(x => x.id === email.id);
        const prev = idx > 0 ? emails[idx - 1] : null;
        const next = idx >= 0 && idx < emails.length - 1 ? emails[idx + 1] : null;
        const latest = msgs[msgs.length - 1];
        const sender = !latest.is_sent ? addrOf(latest.from_address) : '';
        const spf = SPF_TONE[spfVerdict(email.received_spf)] ? spfVerdict(email.received_spf) : '';
        const auth = authVerdict(email.auth_results);
        const dmarcPass = auth?.dmarc?.result === 'pass';
        const dmarcFail = auth?.dmarc?.result === 'fail';
        // An aligned DKIM signature (DMARC pass) authenticates the From domain, so no mismatch to flag.
        const unaligned = dmarcPass ? null : senderMismatch(email.received_spf, email.from_address);
        const authPills = !!(auth && (dmarcPass || dmarcFail || auth.dkimPass || auth.dkimBad));
        const inTrash = folder === 'trash' || !!email.is_trash;
        const inSpam = folder === 'spam' || !!email.is_spam;

        return (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
                {/* Toolbar */}
                <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-slate-100 px-1.5 sm:px-3">
                    {!split && <IconBtn icon="fa-solid fa-arrow-left" label={t('common.back')} onClick={closeMessage} />}
                    {!inTrash && !inSpam && <IconBtn icon="fa-solid fa-box-archive" label={email.is_archived ? t('act.unarchive') : t('act.archive')} active={!!email.is_archived} onClick={() => bulk(email.is_archived ? 'unarchive' : 'archive', [email.id])} />}
                    {inSpam
                        ? <IconBtn icon="fa-solid fa-circle-check" label={t('act.notSpam')} onClick={() => bulk('notspam', [email.id])} />
                        : !inTrash && <IconBtn icon="fa-solid fa-triangle-exclamation" label={t('act.spam')} onClick={() => bulk('spam', [email.id])} />}
                    {inTrash ? (
                        <>
                            <IconBtn icon="fa-solid fa-rotate-left" label={t('act.restore')} onClick={() => bulk('restore', [email.id])} />
                            <IconBtn icon="fa-solid fa-trash-can" danger label={t('act.deleteForever')} onClick={() => bulk('delete', [email.id])} />
                        </>
                    ) : <IconBtn icon="fa-regular fa-trash-can" label={t('act.trash')} onClick={() => bulk('trash', [email.id])} />}
                    <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block"></span>
                    <IconBtn icon="fa-regular fa-envelope" label={t('act.markUnread')} className="hidden sm:inline-flex" onClick={() => { bulk('unread', [email.id]); closeMessage(); }} />
                    <Menu width="w-60" trigger={({ toggle }: any) => <IconBtn icon="fa-solid fa-tag" label={t('act.label')} onClick={toggle} />}>
                        {labels.length === 0 && <p className="px-3.5 py-2 text-xs text-slate-500">{t('folder.newLabel')}…</p>}
                        {labels.map(l => (
                            <MenuItem key={l.id} checked={(email.labels || []).some((x: any) => x.id === l.id)} onClick={() => toggleLabelOn(email, l)}>
                                <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: l.color }}></span>{l.name}
                            </MenuItem>
                        ))}
                    </Menu>
                    <Menu width="w-64" trigger={({ toggle }: any) => <IconBtn icon="fa-solid fa-ellipsis-vertical" label={t('common.more')} onClick={toggle} />}>
                        <MenuItem icon="fa-regular fa-envelope" onClick={() => { bulk('unread', [email.id]); closeMessage(); }}>{t('act.markUnread')}</MenuItem>
                        <MenuItem icon={email.is_starred ? 'fa-solid fa-star' : 'fa-regular fa-star'} onClick={() => bulk(email.is_starred ? 'unstar' : 'star', [email.id])}>{email.is_starred ? t('act.unstar') : t('act.star')}</MenuItem>
                        {sender && <MenuItem icon="fa-solid fa-filter" onClick={() => filterLike(latest)}>{t('act.filterLike')}</MenuItem>}
                        {sender && <MenuItem icon="fa-solid fa-ban" danger={!isBlocked(sender)} onClick={() => toggleBlock(sender, email)}>{isBlocked(sender) ? t('act.unblockSender', { who: sender }) : t('act.blockSender', { who: sender })}</MenuItem>}
                        <MenuItem icon="fa-solid fa-print" onClick={() => printConversation(email)}>{t('act.print')}</MenuItem>
                    </Menu>
                    <span className="flex-1"></span>
                    {idx >= 0 && (
                        <>
                            <span className="mr-1 hidden text-xs tabular-nums text-slate-500 md:inline">{idx + 1} / {total || emails.length}</span>
                            <IconBtn icon="fa-solid fa-chevron-left" label={t('act.prev')} disabled={!prev} onClick={() => { setCursor(idx - 1); openMessage(prev); }} />
                            <IconBtn icon="fa-solid fa-chevron-right" label={t('act.next')} disabled={!next} onClick={() => { setCursor(idx + 1); openMessage(next); }} />
                        </>
                    )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    <div className="mx-auto max-w-4xl px-3 pb-6 pt-4 sm:px-6">
                        <div className="mb-4 flex items-start gap-3">
                            <h1 className="min-w-0 flex-1 break-words text-xl font-semibold leading-snug text-slate-900 sm:text-[22px]">{email.subject || '(no subject)'}</h1>
                            <button type="button" onClick={() => bulk(email.is_starred ? 'unstar' : 'star', [email.id])} aria-label={email.is_starred ? t('act.unstar') : t('act.star')} className="mt-1 rounded-full p-1.5 hover:bg-slate-100">
                                <i className={cx(email.is_starred ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star text-slate-400', 'text-lg')}></i>
                            </button>
                        </div>
                        {((email.labels || []).length > 0 || inSpam || spf || unaligned || authPills) && (
                            <div className="-mt-2 mb-4 flex flex-wrap items-center gap-1.5">
                                {inSpam && <Pill tone="orange"><i className="fa-solid fa-triangle-exclamation"></i>{t('badge.spam')}</Pill>}
                                {spf && <Pill tone={SPF_TONE[spf]} title={`${t('spf.' + spf + 'Hint')}\n\n${email.received_spf}`}><i className="fa-solid fa-shield-halved"></i>{t('spf.' + spf)}</Pill>}
                                {unaligned && <Pill tone="orange" title={`${t('spf.unalignedHint', unaligned)}\n\n${email.received_spf}`}><i className="fa-solid fa-user-shield"></i>{t('spf.unaligned')}</Pill>}
                                {dmarcPass && <Pill tone="green" title={`${t('auth.dmarcPassHint', { domain: auth.dmarc.domain })}\n\n${email.auth_results}`}><i className="fa-solid fa-circle-check"></i>{t('auth.dmarcPass')}</Pill>}
                                {dmarcFail && <Pill tone="red" title={`${t(auth.dmarc.disposition === 'quarantine' ? 'auth.dmarcQuarantineHint' : 'auth.dmarcFailHint', { domain: auth.dmarc.domain, policy: auth.dmarc.policy || 'none' })}\n\n${email.auth_results}`}><i className="fa-solid fa-circle-xmark"></i>{t(auth.dmarc.disposition === 'quarantine' ? 'auth.dmarcQuarantine' : 'auth.dmarcFail')}</Pill>}
                                {!dmarcPass && auth?.dkimPass && <Pill tone="green" title={`${t('auth.dkimPassHint', { domain: auth.dkimPass.domain })}\n\n${email.auth_results}`}><i className="fa-solid fa-signature"></i>{t('auth.dkimPass', { domain: auth.dkimPass.domain })}</Pill>}
                                {auth?.dkimBad && <Pill tone="red" title={`${t(auth.dkimBad.result === 'fail' ? 'auth.dkimFailHint' : 'auth.dkimErrorHint', { domain: auth.dkimBad.domain })}\n\n${email.auth_results}`}><i className="fa-solid fa-signature"></i>{t('auth.dkimFail')}</Pill>}
                                {(email.labels || []).map((l: any) => (
                                    <span key={l.id} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium" style={{ background: `${l.color}1a`, color: l.color }}>
                                        {l.name}
                                        <button type="button" aria-label={t('common.delete')} onClick={() => toggleLabelOn(email, l)} className="opacity-60 hover:opacity-100"><i className="fa-solid fa-xmark text-[10px]"></i></button>
                                    </span>
                                ))}
                            </div>
                        )}
                        {sender && isBlocked(sender) && (
                            <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
                                <i className="fa-solid fa-ban text-slate-400"></i><span className="flex-1">{t('read.blockedBanner')}</span>
                                <Button size="sm" variant="ghost" onClick={() => toggleBlock(sender)}>{t('act.unblockSender', { who: '' }).trim()}</Button>
                            </div>
                        )}
                        {(email.delivery_status === 'failed' || email.delivery_status === 'retry') && (
                            <div className={cx('mb-4 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start', email.delivery_status === 'failed' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50')}>
                                <i className={cx('fa-solid mt-0.5 text-lg', email.delivery_status === 'failed' ? 'fa-circle-exclamation text-red-500' : 'fa-rotate text-amber-500')}></i>
                                <div className="min-w-0 flex-1">
                                    <p className={cx('text-sm font-semibold', email.delivery_status === 'failed' ? 'text-red-800' : 'text-amber-800')}>{email.delivery_status === 'failed' ? t('read.deliveryFailed') : t('read.deliveryRetry')}</p>
                                    <p className="mt-1 break-words font-mono text-xs text-slate-600">{email.last_error || t('read.deliveryFailedTo', { to: email.to_address })}</p>
                                </div>
                                <Button size="sm" variant={email.delivery_status === 'failed' ? 'danger' : 'secondary'} icon="fa-solid fa-paper-plane" onClick={() => retryDelivery(email)}>{t('read.retryNow')}</Button>
                            </div>
                        )}

                        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
                            {msgs.map((m: any) => {
                                const open = expandedIds.has(m.id);
                                const blockedCount = m.body_html && !showImages[m.id] ? prepareEmailHtml(m.body_html, false).blocked : 0;
                                return (
                                    <article key={m.id} className="px-3 py-3 sm:px-5 sm:py-4">
                                        <header className="flex cursor-pointer items-start gap-3" onClick={() => setExpandedIds(s => { const n = new Set(s); n.has(m.id) && msgs.length > 1 ? n.delete(m.id) : n.add(m.id); return n; })}>
                                            <Avatar name={m.from_name || m.from_address} email={m.from_address} size={40} />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-baseline gap-x-2">
                                                    <span className="font-semibold text-slate-900">{m.from_name || m.from_address}</span>
                                                    {m.from_name && <span className="truncate text-xs text-slate-500">&lt;{m.from_address}&gt;</span>}
                                                </div>
                                                {open ? (
                                                    <button type="button" className="mt-0.5 flex max-w-full items-center gap-1 text-left text-xs text-slate-500 hover:text-slate-800" onClick={(e) => { e.stopPropagation(); setDetails(d => ({ ...d, [m.id]: !d[m.id] })); }}>
                                                        <span className="truncate">{t('read.to')} {shortPeople([m.to_address, m.cc_address].filter(Boolean).join(', '), me, t('list.me'))}</span>
                                                        <i className={cx('fa-solid text-[10px]', details[m.id] ? 'fa-caret-up' : 'fa-caret-down')}></i>
                                                    </button>
                                                ) : (
                                                    <p className="mt-0.5 truncate text-[13px] text-slate-500">{m.snippet || String(m.body_text || '').slice(0, 160)}</p>
                                                )}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1">
                                                {(m.attachments || []).length > 0 && <i className="fa-solid fa-paperclip text-xs text-slate-400"></i>}
                                                <span className="text-xs text-slate-500" title={fullDate(m.date_received, locale)}>{listDate(m.date_received, locale)}</span>
                                                {open && (
                                                    <span onClick={(e) => e.stopPropagation()} className="flex items-center">
                                                        <IconBtn size="sm" icon="fa-solid fa-reply" label={t('act.reply')} className="hidden sm:inline-flex" onClick={() => reply(email, false, m)} />
                                                        <Menu width="w-52" trigger={({ toggle }: any) => <IconBtn size="sm" icon="fa-solid fa-ellipsis-vertical" label={t('common.more')} onClick={toggle} />}>
                                                            <MenuItem icon="fa-solid fa-reply" onClick={() => reply(email, false, m)}>{t('act.reply')}</MenuItem>
                                                            <MenuItem icon="fa-solid fa-reply-all" onClick={() => reply(email, true, m)}>{t('act.replyAll')}</MenuItem>
                                                            <MenuItem icon="fa-solid fa-share" onClick={() => forward(email, m)}>{t('act.forward')}</MenuItem>
                                                        </Menu>
                                                    </span>
                                                )}
                                            </div>
                                        </header>
                                        {open && details[m.id] && (
                                            <dl className="ml-[52px] mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-slate-50 p-3 text-xs">
                                                <dt className="text-slate-500">{t('read.from')}</dt><dd className="break-all text-slate-800">{m.from_name} &lt;{m.from_address}&gt;</dd>
                                                <dt className="text-slate-500">{t('comp.to')}</dt><dd className="break-all text-slate-800">{m.to_address}</dd>
                                                {m.cc_address && <><dt className="text-slate-500">{t('comp.cc')}</dt><dd className="break-all text-slate-800">{m.cc_address}</dd></>}
                                                <dt className="text-slate-500">{t('read.date')}</dt><dd className="text-slate-800">{fullDate(m.date_received, locale)}</dd>
                                            </dl>
                                        )}
                                        {open && (
                                            <div className="mt-3 sm:ml-[52px]">
                                                {blockedCount > 0 && (
                                                    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                                                        <i className="fa-regular fa-image text-slate-400"></i>
                                                        <span className="flex-1">{t('read.imagesHidden', { n: blockedCount })}</span>
                                                        <button type="button" className="font-semibold text-violet-700 hover:underline" onClick={() => setShowImages(s => ({ ...s, [m.id]: true }))}>{t('read.showImages')}</button>
                                                    </div>
                                                )}
                                                {m.body_html
                                                    ? <EmailBodyFrame html={m.body_html} showImages={!!showImages[m.id]} title={m.subject} />
                                                    : <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{m.body_text || <span className="italic text-slate-400">{t('read.noContent')}</span>}</div>}
                                                {(m.attachments || []).length > 0 && (
                                                    <div className="mt-4">
                                                        <p className="mb-2 text-xs font-semibold text-slate-500">{t('read.attachments', { n: m.attachments.length })}</p>
                                                        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))' }}>
                                                            {m.attachments.map((att: any) => {
                                                                const isImg = /^image\/(png|jpe?g|gif|webp)$/i.test(att.content_type || '');
                                                                const url = `/api/v1/plugin/mail-server/attachments/${att.id}`;
                                                                return (
                                                                    <a key={att.id} href={url} download={att.filename || true} className="group/att flex items-center gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white p-2 no-underline transition hover:border-violet-300 hover:shadow-sm">
                                                                        {isImg
                                                                            ? <img src={url} alt="" loading="lazy" className="h-11 w-11 shrink-0 rounded-lg bg-slate-100 object-cover" />
                                                                            : <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><i className={cx('fa-regular', /pdf/i.test(att.content_type) ? 'fa-file-pdf' : /zip|compressed/i.test(att.content_type) ? 'fa-file-zipper' : /sheet|excel|csv/i.test(att.content_type) ? 'fa-file-excel' : /word|document/i.test(att.content_type) ? 'fa-file-word' : 'fa-file')}></i></span>}
                                                                        <span className="min-w-0 flex-1">
                                                                            <span className="block truncate text-[13px] font-medium text-slate-800">{att.filename || 'attachment'}</span>
                                                                            <span className="block text-[11px] text-slate-500">{formatBytes(att.size)}</span>
                                                                        </span>
                                                                        <i className="fa-solid fa-download px-1 text-slate-300 group-hover/att:text-violet-600"></i>
                                                                    </a>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </article>
                                );
                            })}
                        </div>

                        {!email.is_draft && (
                            <div className="mt-5 flex flex-wrap gap-2">
                                <Button icon="fa-solid fa-reply" onClick={() => reply(email)}>{t('act.reply')}</Button>
                                <Button icon="fa-solid fa-reply-all" onClick={() => reply(email, true)}>{t('act.replyAll')}</Button>
                                <Button icon="fa-solid fa-share" onClick={() => forward(email)}>{t('act.forward')}</Button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // --- layout ------------------------------------------------------------------------------------
    return (
        <div ref={rootRef} className="relative flex h-full min-h-0 w-full overflow-hidden bg-white text-slate-800">
            {sidebarMode === 'full' && <aside className="w-[248px] shrink-0 border-r border-slate-200 bg-slate-50/70">{SidebarFull}</aside>}
            {sidebarMode === 'rail' && <aside className="w-[72px] shrink-0 border-r border-slate-200 bg-slate-50/70">{SidebarRail}</aside>}
            {drawer && sidebarMode !== 'full' && (
                <div className="fixed inset-0" style={{ zIndex: 5500 }}>
                    <div className="absolute inset-0 bg-slate-900/40" onClick={() => setDrawer(false)}></div>
                    <aside className="absolute inset-y-0 left-0 w-[min(300px,85vw)] bg-white shadow-2xl">{SidebarFull}</aside>
                </div>
            )}

            {showList && ListPane}
            {split && <div onMouseDown={startResize} className="-ml-px w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-violet-300" title="↔"></div>}
            {showReader && renderReader()}

            {/* Compose FAB on phones/tablets */}
            {sidebarMode === 'drawer' && !openId && !composer && selection.length === 0 && (
                <button type="button" onClick={() => startCompose()} aria-label={t('act.compose')}
                    className="fixed right-4 flex h-14 items-center gap-2 rounded-2xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-xl shadow-violet-600/30 active:scale-95"
                    style={{ zIndex: 40, bottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
                    <i className="fa-solid fa-pen"></i>{t('act.compose')}
                </button>
            )}

            {composer && (
                <Composer
                    key={composerKey}
                    initial={composer}
                    prefs={prefs}
                    user={user}
                    t={t}
                    locale={locale}
                    fullscreen={width > 0 && width < 640}
                    confirm={confirm}
                    onClose={(r: any) => { setComposer(null); if (r?.discarded) { ok(t('toast.draftDiscarded')); } loadList({ silent: true }); }}
                    onSent={onSent}
                    onError={(m: string) => toast('error', m)}
                    onDraftSaved={() => { if (folderRef.current === 'drafts') loadList({ silent: true }); }}
                />
            )}

            <MailSettings
                open={settings.open}
                initialTab={settings.tab || 'general'}
                seedRule={settings.seedRule}
                onClose={() => setSettings({ open: false })}
                t={t}
                labels={labels}
                density={density}
                setDensity={setDensity}
                showPreview={showPreview}
                setShowPreview={setShowPreview}
                onSaved={(p: any) => { setPrefs((old: any) => ({ ...old, ...p })); ok(t('toast.prefsSaved')); }}
                onError={(m: string) => toast('error', m)}
            />

            <Sheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title={t('kb.title')} wide>
                <ShortcutList t={t} />
            </Sheet>
        </div>
    );
}
