// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the
// frontend tsc (react/deps resolve at bundle time, not in the frontend-only CI). Matches every other
// plugin's client components (card-gallery, photo-carousel, video-gallery).
"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { api, apiPost } from "../../../../../frontend/src/lib/api";
import { useAuth } from "../../../../../frontend/src/contexts/AuthContext";
import { useModal } from "@/contexts/ModalContext";

type Email = {
    id: number;
    from_address: string;
    from_name: string;
    subject: string;
    date_received: string;
    is_read: number;
    body_text: string;
    body_html: string;
    to_address: string;
    cc_address?: string;
    bcc_address?: string;
    is_sent: number;
    parent_id: number;
    thread_id: number;
    thread_count?: number;
    thread?: Email[];
    is_starred?: number;
    is_archived?: number;
    is_draft?: number;
    is_trash?: number;
    raw_content?: string;
};

type DnsRecord = { host?: string; type: string; value?: string; priority?: number; note?: string };
type DnsInfo = {
    domain: string;
    selector: string;
    heloHost: string;
    dkimConfigured: boolean;
    records: { dkim: DnsRecord; spf: DnsRecord; dmarc: DnsRecord; ptr: DnsRecord };
};
type TestResult = {
    success: boolean;
    to: string;
    message: string;
    delivered?: { recipient: string; via: string; response: string }[];
    failed?: { recipient: string; error: string; permanent?: boolean }[];
};

// Lightweight client-side sanitizer for rendered email HTML. Strips active content
// (scripts, inline event handlers, javascript: URLs, embedded frames/objects) so a
// malicious email body cannot run code in the admin context. Defense-in-depth only;
// the server should also sanitize on ingest.
const sanitizeEmailHtml = (html: string): string => {
    if (!html) return '';
    if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
        // SSR fallback: coarse regex strip
        return html
            .replace(/<\s*(script|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
            .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    }
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, iframe, object, embed, link, meta, style').forEach(el => el.remove());
        doc.querySelectorAll('*').forEach(el => {
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                const val = attr.value.replace(/\s+/g, '').toLowerCase();
                if (name.startsWith('on')) el.removeAttribute(attr.name);
                else if ((name === 'href' || name === 'src' || name === 'xlink:href') && val.startsWith('javascript:')) el.removeAttribute(attr.name);
            }
        });
        return doc.body.innerHTML;
    } catch {
        return '';
    }
};

// Helper function to generate email signature
const getSignature = (user: any) => {
    if (!user) return '';
    const name = user.displayName || user.username || '';
    const email = user.userEmail || user.email || '';
    return `\n\n--\n${name}\n${email}`;
};

// Human-readable file size for attachment chips.
const formatBytes = (bytes: any) => {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export default function MailServerAdmin() {
    // Data State
    const [folder, setFolder] = useState<'inbox' | 'sent' | 'settings' | 'starred' | 'archive' | 'drafts' | 'trash'>('inbox');
    const [emails, setEmails] = useState<Email[]>([]);
    const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
    const [settings, setSettings] = useState<Record<string, string>>({
        mail_from_email: "",
        mail_from_name: "",
        smtp_listen_port: "25",
        smtp_catch_all: "0",
        mail_helo_host: "",
        mail_security_dkim_domain: "",
        mail_security_dkim_selector: "default",
        mail_security_dkim_enabled: "0",
        mail_security_dnsbl_enabled: "0",
        mail_security_spf_enabled: "0"
    });

    // Deliverability / Security State
    const [dnsInfo, setDnsInfo] = useState<DnsInfo | null>(null);
    const [dnsLoading, setDnsLoading] = useState(false);
    const [generatingDkim, setGeneratingDkim] = useState(false);
    const [testTo, setTestTo] = useState("");
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<TestResult | null>(null);

    // Compose State
    const [composing, setComposing] = useState(false);
    const [isMinimized, setIsMinimized] = useState(false);
    const [scheduledDate, setScheduledDate] = useState<string>("");
    const [showScheduleInput, setShowScheduleInput] = useState(false);
    const [newMail, setNewMail] = useState<{ to: string, cc: string, bcc: string, subject: string, body: string, attachments: any[], useSignature: boolean }>({ to: "", cc: "", bcc: "", subject: "", body: "", attachments: [], useSignature: true });
    const [showCc, setShowCc] = useState(false);
    const [showBcc, setShowBcc] = useState(false);
    const [replyToId, setReplyToId] = useState<number | null>(null);
    const [draftId, setDraftId] = useState<number | null>(null);
    const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | null>(null);
    const [suggestions, setSuggestions] = useState<{ email: string, name: string }[]>([]);
    const [inboxCount, setInboxCount] = useState(0);
    // Functional State
    const [searchQuery, setSearchQuery] = useState("");
    const [searching, setSearching] = useState(false); // For autocomplete
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [sending, setSending] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [loadError, setLoadError] = useState(false);

    const { user } = useAuth();
    const editorRef = useRef<HTMLDivElement>(null);
    const lastBodyRef = useRef("");

    // --- Effects & Logic ---

    const loadStats = async () => {
        try {
            const data = await api('/plugin/mail-server/stats') as any;
            if (data && typeof data.unread === 'number') setInboxCount(data.unread);
        } catch (e) { }
    };

    const loadData = useCallback(async (query = "") => {
        setLoading(true);
        loadStats();
        try {
            if (folder === 'settings') {
                const data = await api('/plugin/mail-server/settings');
                setSettings(prev => ({ ...prev, ...(data as any) }));
                loadDnsRecords();
            } else {
                setLoadError(false);
                const endpoint = query
                    ? `/plugin/mail-server/emails/search?q=${encodeURIComponent(query)}`
                    : `/plugin/mail-server/emails?folder=${folder}`;

                const res = await api(endpoint) as any;
                setEmails(res.emails || []);
            }
        } catch (error) {
            console.error("Failed to load data:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, [folder]);

    // Sync newMail.body to editor content when it changes externally
    useEffect(() => {
        if (editorRef.current && newMail.body !== lastBodyRef.current) {
            editorRef.current.innerHTML = newMail.body;
            lastBodyRef.current = newMail.body;
        }
    }, [newMail.body]);

    useEffect(() => {
        const timer = setTimeout(async () => {
            if (newMail.to.length >= 2 && !newMail.to.includes('@')) {
                setSearching(true);
                try {
                    const data = await api(`/plugin/mail-server/users/search?q=${encodeURIComponent(newMail.to)}`) as any;
                    setSuggestions(Array.isArray(data) ? data : []);
                } catch (error) {
                    console.error("Search failed:", error);
                } finally {
                    setSearching(false);
                }
            } else {
                setSuggestions([]);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [newMail.to]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    useEffect(() => {
        const handleNotification = (e: any) => {
            const notif = e.detail;
            console.log("Mail Plugin: Notification received", notif);

            // Refresh if we are in inbox and get a new email
            if (folder === 'inbox' && notif.type === 'email') {
                loadData();
            }
        };
        window.addEventListener('wordjs:notification' as any, handleNotification);
        return () => window.removeEventListener('wordjs:notification' as any, handleNotification);
    }, [folder, loadData]);

    // Auto-dismiss the global feedback toast.
    useEffect(() => {
        if (message) {
            const t = setTimeout(() => setMessage(null), 4000);
            return () => clearTimeout(t);
        }
    }, [message]);

    // Clear stale feedback when switching folders/views.
    useEffect(() => {
        setMessage(null);
    }, [folder]);

    // Auto-save Draft
    useEffect(() => {
        if (!composing || (!newMail.to && !newMail.subject && !newMail.body)) return;
        if (sending) return;

        const timer = setTimeout(async () => {
            setSaveStatus('saving');
            try {
                const res = await api('/plugin/mail-server/drafts', {
                    method: 'POST',
                    body: {
                        ...newMail,
                        isHtml: true,
                        replyToId,
                        id: draftId,
                        // Store the RAW body only. The signature is applied purely as a send-time
                        // transform (see handleSend) — baking it into the draft here caused it to be
                        // appended a second time when the draft was reopened and then sent.
                        body: newMail.body
                    }
                }) as any;
                if (res.success && res.id) {
                    setDraftId(res.id);
                    setSaveStatus('saved');
                }
            } catch (e) {
                setSaveStatus('error');
            }
        }, 2000);

        return () => clearTimeout(timer);
    }, [newMail, composing, draftId, replyToId]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        loadData(searchQuery);
    };

    const { confirm } = useModal();

    const discardDraft = async () => {
        if (!await confirm("Are you sure you want to discard this draft?", "Discard Draft", true)) return;
        if (draftId) {
            try {
                await api(`/plugin/mail-server/emails/${draftId}`, { method: 'DELETE' });
                if (folder === 'drafts' || folder === 'trash') loadData();
                loadStats();
                setMessage({ type: 'success', text: 'Draft discarded' });
            } catch (e) { }
        }
        setComposing(false);
        setNewMail({ to: "", cc: "", bcc: "", subject: "", body: "", attachments: [], useSignature: true });
        setDraftId(null);
        setReplyToId(null);
    };

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newMail.to.trim()) { setMessage({ type: 'error', text: 'Please add at least one recipient.' }); return; }
        setSending(true);
        setMessage(null);
        try {
            await api('/plugin/mail-server/send', {
                method: 'POST',
                body: {
                    ...newMail,
                    isHtml: true,
                    replyToId,
                    id: draftId,
                    body: newMail.useSignature ? newMail.body + getSignature(user) : newMail.body,
                    scheduledAt: scheduledDate || undefined
                }
            });
            setMessage({ type: 'success', text: scheduledDate ? 'Message scheduled!' : 'Message sent successfully!' });
            setComposing(false);
            setNewMail({ to: "", cc: "", bcc: "", subject: "", body: "", attachments: [], useSignature: true });
            setShowCc(false);
            setShowBcc(false);
            setScheduledDate("");
            setShowScheduleInput(false);
            setReplyToId(null);
            setDraftId(null);
            if (folder === 'sent') loadData();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.message || 'Failed to send' });
        } finally {
            setSending(false);
        }
    };

    const handleSaveSettings = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            await api('/plugin/mail-server/settings', {
                method: 'POST',
                body: settings
            });
            setMessage({ type: 'success', text: 'Settings updated' });
        } catch (error: any) {
            setMessage({ type: 'error', text: error.message || 'Failed' });
        } finally {
            setSaving(false);
        }
    };

    const loadDnsRecords = async () => {
        setDnsLoading(true);
        try {
            const data = await api('/plugin/mail-server/security/dns-records') as DnsInfo;
            setDnsInfo(data);
        } catch (error) {
            console.error('Failed to load DNS records:', error);
        } finally {
            setDnsLoading(false);
        }
    };

    const handleGenerateDkim = async () => {
        const domain = settings.mail_security_dkim_domain || (dnsInfo?.domain ?? '');
        const selector = settings.mail_security_dkim_selector || 'default';
        if (dnsInfo?.dkimConfigured) {
            if (!await confirm('Regenerating the DKIM key invalidates the old key. Any DNS record still pointing at the old key will fail signature checks until you publish the new value. Continue?', 'Regenerate DKIM Key', true)) return;
        }
        setGeneratingDkim(true);
        setMessage(null);
        try {
            // force:true when a key already exists — the backend 409s a rotation without it, so the
            // confirmed "Regenerate" above would otherwise fail. First-time generation sends no force.
            await api('/plugin/mail-server/security/dkim/generate', { method: 'POST', body: { domain, selector, force: dnsInfo?.dkimConfigured ? true : undefined } });
            setMessage({ type: 'success', text: 'DKIM key generated. Publish the new DNS record below.' });
            await loadDnsRecords();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.message || 'Failed to generate DKIM key' });
        } finally {
            setGeneratingDkim(false);
        }
    };

    const handleSendTest = async () => {
        setTesting(true);
        setTestResult(null);
        setMessage(null);
        try {
            const res = await api('/plugin/mail-server/test', { method: 'POST', body: { to: testTo || undefined } }) as TestResult;
            setTestResult(res);
        } catch (error: any) {
            setTestResult({ success: false, to: testTo, message: error.message || 'Test request failed', delivered: [], failed: [] });
        } finally {
            setTesting(false);
        }
    };

    const handleReply = (email: Email) => {
        setReplyToId(email.id);
        const isReply = email.subject.toLowerCase().startsWith('re:');
        setNewMail({
            to: email.is_sent ? email.to_address : email.from_address,
            cc: "",
            bcc: "",
            subject: isReply ? email.subject : `Re: ${email.subject}`,
            body: `<br/><br/><br/><br/>________________________________<br/><strong>From:</strong> ${email.from_name || email.from_address}<br/><strong>Sent:</strong> ${new Date(email.date_received).toLocaleString()}<br/><strong>Subject:</strong> ${email.subject}<br/><br/>${email.body_html || email.body_text.replace(/\n/g, '<br/>')}`,
            attachments: [],
            useSignature: true
        });
        setComposing(true);
        setIsMinimized(false);
        setDraftId(null);
    };

    const handleForward = (email: Email) => {
        setNewMail({
            to: "",
            cc: "",
            bcc: "",
            subject: `Fwd: ${email.subject.replace(/^(re|fwd):\s*/i, '')}`,
            body: `<br/><br/><br/>---------- Forwarded message ---------<br/><strong>From:</strong> ${email.from_name || email.from_address} &lt;${email.from_address}&gt;<br/><strong>Date:</strong> ${new Date(email.date_received).toLocaleString()}<br/><strong>Subject:</strong> ${email.subject}<br/><strong>To:</strong> ${email.to_address}<br/><br/>${email.body_html || (email.body_text || '').replace(/\n/g, '<br/>')}`,
            attachments: (email as any).attachments || [],
            useSignature: true
        });
        setComposing(true);
        setIsMinimized(false);
        setDraftId(null);
    };

    const emptyTrash = async () => {
        if (!await confirm('Are you sure you want to permanently delete all items in Trash?', 'Empty Trash', true)) return;
        try {
            await api('/plugin/mail-server/trash/empty', { method: 'DELETE' });
            setEmails([]);
            setSelectedEmail(null);
            setMessage({ type: 'success', text: 'Trash emptied' });
        } catch (error: any) {
            setMessage({ type: 'error', text: error.message || 'Failed' });
        }
    };

    const handleRestore = async (email: Email, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        try {
            await api(`/plugin/mail-server/emails/${email.id}/restore`, { method: 'PUT' });
            setEmails(emails.filter(e => e.id !== email.id));
            if (selectedEmail?.id === email.id) setSelectedEmail(null);
            setMessage({ type: 'success', text: 'Conversation restored' });
        } catch (error: any) {
            setMessage({ type: 'error', text: 'Failed to restore' });
        }
    };

    const deleteEmail = async (id: number, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        const isPermanent = folder === 'trash';
        if (!await confirm(isPermanent ? 'Delete this conversation permanently?' : 'Move to trash?', isPermanent ? 'Delete Forever' : 'Move to Trash', isPermanent)) return;
        try {
            await api(`/plugin/mail-server/emails/${id}`, { method: 'DELETE' });
            setEmails(emails.filter(e => e.id !== id));
            if (selectedEmail?.id === id) setSelectedEmail(null);
            loadStats();
            setMessage({ type: 'success', text: isPermanent ? 'Deleted permanently' : 'Moved to trash' });
        } catch (error) {
            console.error("Delete failed:", error);
        }
    };

    const handleArchive = async (email: Email, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        // Optimistic UI update
        const newState = !(email.is_archived);

        // If we are in inbox and archiving, remove from list
        if (folder === 'inbox' && newState) {
            setEmails(emails.filter(e => e.id !== email.id));
            if (selectedEmail?.id === email.id) setSelectedEmail(null);
        } else {
            setEmails(emails.map(e => e.id === email.id ? { ...e, is_archived: newState ? 1 : 0 } : e));
            if (selectedEmail?.id === email.id) setSelectedEmail({ ...selectedEmail, is_archived: newState ? 1 : 0 });
        }

        try {
            await api(`/plugin/mail-server/emails/${email.id}/archive`, {
                method: 'PUT',
                body: { archived: newState }
            });
        } catch (error) {
            console.error("Archive failed:", error);
            // Revert on failure (simplified)
            loadData();
        }
    };

    const handleStar = async (email: Email, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        const newState = !(email.is_starred);

        setEmails(emails.map(e => e.id === email.id ? { ...e, is_starred: newState ? 1 : 0 } : e));
        if (selectedEmail?.id === email.id) setSelectedEmail({ ...selectedEmail, is_starred: newState ? 1 : 0 });

        try {
            await api(`/plugin/mail-server/emails/${email.id}/star`, {
                method: 'PUT',
                body: { starred: newState }
            });
        } catch (error) {
            console.error("Star failed:", error);
        }
    };

    const viewEmail = async (email: Email) => {
        // If draft, open in composer
        if (email.is_draft) {
            setNewMail({
                to: email.to_address || "",
                cc: email.cc_address || "",
                bcc: email.bcc_address || "",
                subject: email.subject || "",
                body: email.raw_content || email.body_text || "",
                attachments: (email as any).attachments || [],
                useSignature: true
            });
            setShowCc(!!email.cc_address);
            setShowBcc(!!email.bcc_address);
            setReplyToId(email.thread_id || null);
            setDraftId(email.id);
            setComposing(true);
            setIsMinimized(false);
            return;
        }

        setSelectedEmail(email);
        try {
            const fullEmail = await api(`/plugin/mail-server/emails/${email.id}`) as any;
            setSelectedEmail(fullEmail);
            setEmails(emails.map(e => e.id === email.id ? { ...e, is_read: 1 } : e));

            // Sync notifications: Mark matching notification as read
            const currentNotifs = await api('/notifications') as any[];
            const targetUrl = `/admin/plugin/emails?id=${email.id}`;
            const matching = currentNotifs.find(n => n.action_url === targetUrl && n.is_read === 0);
            if (matching) {
                api(`/notifications/${matching.uuid}/read`, { method: 'POST' });
            }
        } catch (error) {
            console.error("Fetch email failed:", error);
        }
    };

    // --- RENDER ---
    return (
        <div className="flex w-full h-full bg-[#f8fafc] text-slate-800 font-sans overflow-hidden shadow-2xl relative">

            {/* GLOBAL FEEDBACK TOAST — renders in every view (above the composer's z-[6000]) */}
            {message && (
                <div className={`fixed top-4 right-4 z-[7000] max-w-sm flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg text-sm font-bold animate-in fade-in slide-in-from-top-2 ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                    <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'} mt-0.5`}></i>
                    <span className="flex-1 leading-snug">{message.text}</span>
                    <button
                        type="button"
                        onClick={() => setMessage(null)}
                        className={`shrink-0 -mr-1 -mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${message.type === 'success' ? 'hover:bg-emerald-100 text-emerald-500' : 'hover:bg-red-100 text-red-500'}`}
                        title="Dismiss"
                    >
                        <i className="fa-solid fa-xmark text-xs"></i>
                    </button>
                </div>
            )}

            {/* COLUMN 1: DARK BRAND SIDEBAR (Responsive Drawer) */}
            {/* Mobile Overlay */}
            {mobileMenuOpen && (
                <div onClick={() => setMobileMenuOpen(false)} className="fixed inset-0 bg-black/50 z-30 md:hidden backdrop-blur-sm"></div>
            )}

            <aside className={`
                absolute inset-y-0 left-0 z-40 w-[280px] bg-gradient-to-b from-slate-900 to-slate-950 flex flex-col pt-8 pb-6 text-white overflow-hidden transition-transform duration-300 ease-out shadow-2xl md:shadow-none md:relative md:translate-x-0
                ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
            `}>
                {/* Decoration */}
                <div className="absolute top-0 left-0 w-full h-40 bg-gradient-to-b from-indigo-500/10 to-transparent pointer-events-none"></div>

                {/* Brand */}
                <div className="px-8 mb-10 flex items-center gap-3 relative z-10">
                    <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-xl flex items-center justify-center text-white text-lg shadow-lg shadow-indigo-500/30 ring-1 ring-white/20">
                        <i className="fa-solid fa-layer-group"></i>
                    </div>
                    <div>
                        <span className="font-bold text-xl tracking-tight text-white block leading-none">Mailbox</span>
                        <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">Workspace</span>
                    </div>
                </div>

                <div className="px-6 mb-8 relative z-10">
                    <button
                        onClick={() => { setComposing(true); setIsMinimized(false); setDraftId(null); setNewMail({ to: "", cc: "", bcc: "", subject: "", body: "", attachments: [], useSignature: true }); }}
                        className="w-full bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white py-3.5 rounded-xl font-bold text-sm shadow-xl shadow-indigo-900/40 transform transition-all hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-3 group ring-1 ring-white/10"
                    >
                        <i className="fa-solid fa-feather-pointed text-indigo-200 group-hover:text-white transition-colors"></i>
                        New Message
                    </button>
                </div>

                {/* Menu */}
                <nav className="flex-1 px-4 space-y-1.5 overflow-y-auto custom-scrollbar relative z-10">
                    <SidebarLink
                        icon="fa-inbox"
                        label="Inbox"
                        count={inboxCount}
                        active={folder === 'inbox'}
                        onClick={() => { setFolder('inbox'); setSelectedEmail(null); setMobileMenuOpen(false); }}
                    />
                    <SidebarLink
                        icon="fa-paper-plane"
                        label="Sent"
                        active={folder === 'sent'}
                        onClick={() => { setFolder('sent'); setSelectedEmail(null); setMobileMenuOpen(false); }}
                    />
                    <SidebarLink
                        icon="fa-file-lines" // Changed to file-lines
                        label="Drafts"
                        active={folder === 'drafts'}
                        onClick={() => { setFolder('drafts'); setSelectedEmail(null); setMobileMenuOpen(false); }}
                    />
                    <SidebarLink
                        icon="fa-box-archive"
                        label="Archive"
                        active={folder === 'archive'}
                        onClick={() => { setFolder('archive'); setSelectedEmail(null); setMobileMenuOpen(false); }}
                    />
                    <SidebarLink
                        icon="fa-trash"
                        label="Trash"
                        active={folder === 'trash'}
                        onClick={() => { setFolder('trash'); setSelectedEmail(null); setMobileMenuOpen(false); }}
                    />

                    {folder === 'trash' && emails.length > 0 && (
                        <div className="px-4 mt-4">
                            <button onClick={emptyTrash} className="w-full py-2 text-xs font-bold text-red-500 bg-red-50 hover:bg-red-100 rounded-lg transition-colors border border-red-200">
                                <i className="fa-solid fa-dumpster-fire mr-2"></i>Empty Trash
                            </button>
                        </div>
                    )}

                    <div className="pt-8 pb-3 px-4">
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Smart Filters</p>
                    </div>
                    <SidebarLink
                        icon="fa-star"
                        label="Starred"
                        active={folder === 'starred'}
                        onClick={() => { setFolder('starred'); setSelectedEmail(null); setMobileMenuOpen(false); }}
                        iconColor="text-amber-400"
                    />

                    {user?.role === 'administrator' && (
                        <div className="pt-8 mt-auto">
                            <SidebarLink
                                icon="fa-sliders"
                                label="Server Admin"
                                active={folder === 'settings'}
                                onClick={() => { setFolder('settings'); setSelectedEmail(null); setMobileMenuOpen(false); }}
                            />
                        </div>
                    )}
                </nav>

                {/* User Profile Mini (informational — not an interactive menu) */}
                <div className="mt-auto px-6 pt-6 border-t border-slate-800/50 flex items-center gap-3 mx-3 rounded-xl pb-2">
                    <div className="w-9 h-9 rounded-lg bg-slate-800 overflow-hidden ring-1 ring-white/10">
                        {/* Placeholder Avatar */}
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-tr from-slate-700 to-slate-600 text-xs font-bold text-slate-300">
                            {user?.username?.charAt(0).toUpperCase()}
                        </div>
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-200 truncate">{user?.displayName || user?.username}</div>
                        <div className="text-[10px] text-slate-500 truncate">{(user as any)?.userEmail}</div>
                    </div>
                </div>
            </aside>

            {folder === 'settings' ? (
                // SETTINGS VIEW (Full Width)
                <div className="flex-1 bg-white overflow-y-auto p-6 md:p-12">
                    {/* Mobile top bar with hamburger so Settings isn't a navigation trap */}
                    <div className="md:hidden mb-6 flex items-center gap-2">
                        <button onClick={() => setMobileMenuOpen(true)} className="p-2 -ml-2 text-slate-500 hover:text-slate-900">
                            <i className="fa-solid fa-bars text-lg"></i>
                        </button>
                        <span className="font-bold text-slate-700">Server Admin</span>
                    </div>
                    <SettingsView
                        settings={settings}
                        setSettings={setSettings}
                        onSave={handleSaveSettings}
                        saving={saving}
                        message={message}
                        dnsInfo={dnsInfo}
                        dnsLoading={dnsLoading}
                        onRefreshDns={loadDnsRecords}
                        onGenerateDkim={handleGenerateDkim}
                        generatingDkim={generatingDkim}
                        testTo={testTo}
                        setTestTo={setTestTo}
                        onSendTest={handleSendTest}
                        testing={testing}
                        testResult={testResult}
                    />
                </div>
            ) : (
                // MAIL VIEW
                <>
                    {/* COLUMN 2: MESSAGE LIST */}
                    <div className={`
                        bg-white border-r border-slate-200 flex flex-col z-10 shadow-sm relative transition-all duration-300
                        ${selectedEmail ? 'hidden lg:flex lg:w-[340px] lg:flex-none lg:flex-shrink-0' : 'flex w-full md:flex-1 lg:w-[340px] lg:flex-none lg:flex-shrink-0'}
                    `}>
                        {/* Header & Search */}
                        <div className="h-20 px-4 md:px-6 flex items-center border-b border-slate-100 bg-white/90 backdrop-blur-sm sticky top-0 z-20 gap-3">
                            {/* Mobile Hamburger */}
                            <button onClick={() => setMobileMenuOpen(true)} className="md:hidden p-2 text-slate-500 hover:text-slate-900">
                                <i className="fa-solid fa-bars text-lg"></i>
                            </button>

                            <div className="relative w-full group">
                                <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-violet-600 transition-colors"></i>
                                <input
                                    type="text"
                                    placeholder="Search messages..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch(e)}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-10 pr-10 text-sm font-medium text-slate-700 placeholder:text-slate-400 focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all outline-none"
                                />
                                <button
                                    onClick={() => loadData(searchQuery)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-violet-600 transition-colors"
                                    title="Refresh"
                                >
                                    <i className={`fa-solid fa-rotate-right ${loading ? 'fa-spin' : ''}`}></i>
                                </button>
                            </div>
                        </div>

                        {/* List */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-50/50">
                            {loading && emails.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                                    <i className="fa-solid fa-circle-notch fa-spin text-3xl mb-4 text-violet-400"></i>
                                    <span className="text-sm font-medium">Loading messages...</span>
                                </div>
                            ) : loadError ? (
                                <div className="flex flex-col items-center justify-center h-64 text-slate-500 px-6 text-center">
                                    <i className="fa-solid fa-triangle-exclamation text-4xl mb-4 text-red-400"></i>
                                    <span className="text-sm font-bold text-slate-700">Couldn't load messages</span>
                                    <span className="text-xs text-slate-400 mt-1 mb-4">Something went wrong while fetching this folder.</span>
                                    <button
                                        onClick={() => loadData(searchQuery)}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-black transition-colors"
                                    >
                                        <i className="fa-solid fa-rotate-right"></i>
                                        Retry
                                    </button>
                                </div>
                            ) : emails.length === 0 ? (
                                (() => {
                                    let icon = 'fa-inbox';
                                    let text = 'All caught up';
                                    if (searchQuery) { icon = 'fa-magnifying-glass'; text = `No results for "${searchQuery}"`; }
                                    else if (folder === 'trash') { icon = 'fa-trash'; text = 'Trash is empty'; }
                                    else if (folder === 'drafts') { icon = 'fa-file-lines'; text = 'No drafts yet'; }
                                    else if (folder === 'sent') { icon = 'fa-paper-plane'; text = 'No sent messages'; }
                                    else if (folder === 'archive') { icon = 'fa-box-archive'; text = 'Archive is empty'; }
                                    else if (folder === 'starred') { icon = 'fa-star'; text = 'No starred messages'; }
                                    return (
                                        <div className="flex flex-col items-center justify-center h-64 text-slate-400 opacity-60 px-6 text-center">
                                            <i className={`fa-solid ${icon} text-4xl mb-4`}></i>
                                            <span className="text-sm font-medium break-words">{text}</span>
                                        </div>
                                    );
                                })()
                            ) : (
                                <div className="p-2 space-y-1">
                                    {emails.map(email => (
                                        <div
                                            key={email.id}
                                            onClick={() => viewEmail(email)}
                                            className={`
                                                group relative px-4 py-4 rounded-xl cursor-pointer transition-all duration-200 border
                                                ${selectedEmail?.id === email.id
                                                    ? 'bg-white border-violet-200 shadow-lg shadow-violet-100/50 ring-1 ring-violet-500/20 z-10'
                                                    : 'bg-white border-transparent hover:border-slate-200 hover:shadow-sm'
                                                }
                                                ${!email.is_read && selectedEmail?.id !== email.id ? 'bg-slate-50 border-slate-100' : ''}
                                            `}
                                        >
                                            <div className="flex justify-between items-start mb-1.5">
                                                <span className={`text-sm truncate max-w-[75%] ${!email.is_read ? 'font-bold text-slate-900' : 'font-medium text-slate-700'}`}>
                                                    {email.is_sent ? `To: ${email.to_address}` : (email.from_name || email.from_address)}
                                                </span>
                                                <span className={`text-[10px] tabular-nums ${!email.is_read ? 'text-violet-600 font-bold' : 'text-slate-400'}`}>
                                                    {new Date(email.date_received).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 mb-1.5">
                                                {email.is_starred === 1 && <i className="fa-solid fa-star text-[10px] text-amber-400"></i>}
                                                <div className={`text-xs truncate flex-1 ${!email.is_read ? 'text-slate-900 font-bold' : 'text-slate-600'}`}>
                                                    {email.subject}
                                                </div>
                                                {email.thread_count > 1 && (
                                                    <span className="flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 tabular-nums" title={`${email.thread_count} messages in this conversation`}>
                                                        <i className="fa-solid fa-layer-group text-[8px] mr-0.5"></i>{email.thread_count}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[11px] text-slate-400 leading-relaxed line-clamp-2 font-medium">
                                                {email.is_archived === 1 && <span className="inline-block px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[9px] mr-1.5 font-bold uppercase tracking-wider">Archived</span>}
                                                {email.body_text?.substring(0, 120)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* COLUMN 3: READING PANE */}
                    <main className={`
                        flex-1 bg-white relative flex flex-col min-w-0 transition-all duration-300
                        ${selectedEmail ? 'absolute inset-0 z-30 lg:static lg:w-auto lg:flex md:relative md:inset-auto md:z-auto md:flex-1 md:flex' : 'hidden lg:flex'}
                    `}>
                        {selectedEmail ? (
                            <>
                                {/* Toolbar */}
                                <div className="h-20 px-4 md:px-8 flex items-center justify-between border-b border-slate-100 bg-white sticky top-0 z-20 gap-4">
                                    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                                        {/* Mobile/Tablet Back */}
                                        <button onClick={() => setSelectedEmail(null)} className="lg:hidden p-2 mr-2 text-slate-500 hover:text-slate-800">
                                            <i className="fa-solid fa-arrow-left"></i>
                                        </button>

                                        {folder === 'trash' ? (
                                            <ActionButton icon="fa-solid fa-rotate-left" onClick={() => handleRestore(selectedEmail)} tooltip="Restore to Inbox" />
                                        ) : (
                                            <ActionButton
                                                icon={`fa-box-archive ${selectedEmail.is_archived ? 'fa-solid text-violet-600' : 'fa-solid'}`}
                                                onClick={() => handleArchive(selectedEmail)}
                                                tooltip={selectedEmail.is_archived ? "Unarchive" : "Archive"}
                                                active={selectedEmail.is_archived === 1}
                                            />
                                        )}

                                        <ActionButton
                                            icon="fa-solid fa-trash"
                                            onClick={() => deleteEmail(selectedEmail.id)}
                                            tooltip={folder === 'trash' ? "Delete Forever" : "Move to Trash"}
                                            className={folder === 'trash' ? "text-red-500 hover:bg-red-50 hover:text-red-600" : ""}
                                        />
                                        <div className="w-px h-6 bg-slate-200 mx-1 md:mx-2 self-center flex-shrink-0"></div>
                                        <ActionButton
                                            icon={`fa-star ${selectedEmail.is_starred ? 'fa-solid text-amber-400' : 'fa-regular'}`}
                                            onClick={() => handleStar(selectedEmail)}
                                            tooltip="Star conversation"
                                            active={selectedEmail.is_starred === 1}
                                        />
                                    </div>
                                    <div className="flex items-center gap-3 hidden md:flex">
                                        <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-500 text-[10px] font-bold uppercase tracking-wider font-mono">
                                            ID: {selectedEmail.id}
                                        </span>
                                    </div>
                                </div>

                                {/* Content */}
                                <div className="flex-1 overflow-y-auto p-6 lg:p-8 custom-scrollbar">
                                    <h1 className="text-3xl font-bold text-slate-900 mb-8 leading-tight select-text tracking-tight">
                                        {selectedEmail.subject}
                                    </h1>

                                    {/* Thread Loop */}
                                    <div className="space-y-10 relative">
                                        {/* Vertical Thread Line */}
                                        <div className="absolute left-5 top-8 bottom-8 w-0.5 bg-slate-100 -z-10"></div>

                                        {(selectedEmail.thread && selectedEmail.thread.length > 0 ? selectedEmail.thread : [selectedEmail]).map((msg, idx) => (
                                            <div key={msg.id} className="relative group">
                                                <div className="flex items-start gap-5">
                                                    {/* Avatar */}
                                                    <div className={`
                                                        w-11 h-11 rounded-xl flex items-center justify-center text-sm font-bold text-white shadow-md ring-4 ring-white z-10
                                                        ${msg.is_sent ? 'bg-gradient-to-br from-slate-700 to-slate-900' : 'bg-gradient-to-br from-violet-500 to-indigo-600'}
                                                    `}>
                                                        {(msg.from_name || msg.from_address).charAt(0).toUpperCase()}
                                                    </div>

                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-baseline justify-between mb-3 pt-1">
                                                            <div>
                                                                <span className="text-base font-bold text-slate-900 mr-2 break-words">{msg.from_name || msg.from_address}</span>
                                                                <span className="text-sm text-slate-400 font-medium break-all">&lt;{msg.from_address}&gt;</span>
                                                            </div>
                                                            <span className="text-xs text-slate-400 font-medium shrink-0 ml-3">{new Date(msg.date_received).toLocaleString()}</span>
                                                        </div>

                                                        <div className="prose prose-slate prose-sm max-w-none text-slate-600 leading-7 rounded-2xl bg-[#f8fafc] p-8 border border-slate-100 group-hover:border-slate-200 group-hover:shadow-sm transition-all overflow-x-auto break-words [&_img]:max-w-full [&_img]:h-auto [&_a]:break-all [&_table]:max-w-full">
                                                            {msg.body_html ? (
                                                                <div dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msg.body_html) }} />
                                                            ) : (
                                                                <div className="whitespace-pre-wrap font-sans break-words">{msg.body_text || <span className="text-slate-400 italic">(No content)</span>}</div>
                                                            )}
                                                        </div>

                                                        {/* Attachments (only surfaced on the fetched single-message view) */}
                                                        {msg.id === selectedEmail.id && selectedEmail.attachments?.length > 0 && (
                                                            <div className="mt-4 flex flex-wrap gap-2">
                                                                {selectedEmail.attachments.map((att: any) => (
                                                                    <a
                                                                        key={att.id}
                                                                        href={`/api/v1/plugin/mail-server/attachments/${att.id}`}
                                                                        download
                                                                        className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl shadow-sm text-xs font-medium text-slate-700 hover:border-violet-300 hover:text-violet-600 hover:shadow transition-all no-underline"
                                                                    >
                                                                        <i className="fa-solid fa-paperclip text-slate-400"></i>
                                                                        <span className="max-w-[180px] truncate">{att.filename || 'attachment'}</span>
                                                                        {formatBytes(att.size) && <span className="text-[10px] text-slate-400">{formatBytes(att.size)}</span>}
                                                                    </a>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Reply Dock */}
                                <div className="p-8 border-t border-slate-100 bg-white/80 backdrop-blur-md flex gap-4">
                                    <button
                                        onClick={() => handleReply(selectedEmail)}
                                        className="flex-1 h-14 border border-slate-200 rounded-2xl flex items-center justify-center px-6 text-slate-500 text-sm font-bold hover:border-violet-300 hover:ring-4 hover:ring-violet-500/10 hover:text-violet-600 transition-all shadow-sm bg-white"
                                    >
                                        <i className="fa-solid fa-reply mr-2"></i>
                                        Reply
                                    </button>
                                    <button
                                        onClick={() => handleForward(selectedEmail)}
                                        className="flex-1 h-14 border border-slate-200 rounded-2xl flex items-center justify-center px-6 text-slate-500 text-sm font-bold hover:border-indigo-300 hover:ring-4 hover:ring-indigo-500/10 hover:text-indigo-600 transition-all shadow-sm bg-white"
                                    >
                                        <i className="fa-solid fa-share mr-2"></i>
                                        Forward
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                                <div className="w-24 h-24 bg-slate-50 rounded-3xl flex items-center justify-center mb-6 text-slate-200">
                                    <i className="fa-regular fa-paper-plane text-4xl"></i>
                                </div>
                                <span className="text-base font-medium text-slate-400">Select a conversation to start reading</span>
                            </div>
                        )}
                    </main>
                </>
            )}

            {/* COMPOSE MODAL (Glass + WordJS styling) */}
            {/* COMPOSE DOCKED WINDOW (Gmail/Chat Style - Fullscreen on Mobile/Tablet) */}
            {composing && (
                <div
                    className={`z-[6000] bg-white shadow-2xl border-x border-t border-slate-200 transition-all duration-300 ease-in-out flex flex-col
                    ${isMinimized
                            ? 'fixed bottom-0 right-4 md:right-20 w-[240px] md:w-[300px] h-12 rounded-t-xl'
                            : 'absolute inset-0 md:fixed md:bottom-0 md:right-20 md:w-[500px] md:h-[600px] md:rounded-t-2xl md:inset-auto'
                        }`}
                >
                    {/* Header */}
                    <div
                        onClick={() => setIsMinimized(!isMinimized)}
                        className="h-12 md:h-14 bg-slate-900 flex items-center justify-between px-4 md:px-6 cursor-pointer md:rounded-t-2xl hover:bg-slate-800 transition-colors flex-shrink-0"
                    >
                        <span className="font-bold text-white text-sm tracking-wide flex items-center gap-3">
                            <i className="fa-regular fa-paper-plane text-violet-300"></i>
                            New Message
                            {saveStatus && (
                                <span className={`text-[10px] font-normal uppercase tracking-wider ml-2 ${saveStatus === 'error' ? 'text-red-400' : 'text-slate-400 opacity-80'}`}>
                                    {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : 'Error'}
                                </span>
                            )}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={(e) => { e.stopPropagation(); setIsMinimized(!isMinimized); }}
                                className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                            >
                                <i className={`fa-solid ${isMinimized ? 'fa-window-maximize' : 'fa-minus'}`}></i>
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); setComposing(false); }}
                                className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-red-500/80 transition-colors"
                            >
                                <i className="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    </div>

                    {/* Window Body */}
                    {!isMinimized && (
                        <form onSubmit={handleSend} className="flex-1 flex flex-col overflow-hidden bg-white relative">

                            {/* To Field */}
                            <div className="px-6 py-2 border-b border-slate-50 flex items-center gap-3 group focus-within:bg-slate-50 transition-colors">
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest w-8 group-focus-within:text-violet-600">To</span>
                                <div className="flex-1 relative">
                                    <input
                                        autoFocus
                                        required
                                        value={newMail.to}
                                        onChange={(e) => setNewMail({ ...newMail, to: e.target.value })}
                                        className="w-full py-2 pr-16 bg-transparent outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300 group-focus-within:placeholder:text-slate-400"
                                        placeholder="Recipient"
                                    />
                                    <div className="absolute right-0 top-1/2 -translate-y-1/2 flex gap-2 text-[10px] font-bold text-slate-400">
                                        {!showCc && <button type="button" onClick={() => setShowCc(true)} className="hover:text-violet-600">CC</button>}
                                        {!showBcc && <button type="button" onClick={() => setShowBcc(true)} className="hover:text-violet-600">BCC</button>}
                                    </div>
                                    {/* Auto-complete */}
                                    {suggestions.length > 0 && (
                                        <div className="absolute top-10 left-0 right-0 bg-white border border-slate-100 rounded-xl shadow-xl shadow-slate-200/50 z-50 py-1 overflow-hidden">
                                            {suggestions.map((s, i) => (
                                                <div key={i} onClick={() => { setNewMail({ ...newMail, to: s.email }); setSuggestions([]) }} className="px-4 py-2 hover:bg-violet-50 cursor-pointer transition-colors flex flex-col border-l-2 border-transparent hover:border-violet-500">
                                                    <span className="font-bold text-slate-800 text-xs">{s.name}</span>
                                                    <span className="text-[10px] text-slate-500">{s.email}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* CC Field */}
                            {showCc && (
                                <div className="px-6 py-2 border-b border-slate-50 flex items-center gap-3 group focus-within:bg-slate-50 transition-colors">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest w-8 group-focus-within:text-violet-600">CC</span>
                                    <input
                                        value={newMail.cc}
                                        onChange={(e) => setNewMail({ ...newMail, cc: e.target.value })}
                                        className="w-full py-1 bg-transparent outline-none text-sm font-medium text-slate-700 placeholder:text-slate-300"
                                        placeholder="Cc Recipients"
                                    />
                                </div>
                            )}

                            {/* BCC Field */}
                            {showBcc && (
                                <div className="px-6 py-2 border-b border-slate-50 flex items-center gap-3 group focus-within:bg-slate-50 transition-colors">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest w-8 group-focus-within:text-violet-600">BCC</span>
                                    <input
                                        value={newMail.bcc}
                                        onChange={(e) => setNewMail({ ...newMail, bcc: e.target.value })}
                                        className="w-full py-1 bg-transparent outline-none text-sm font-medium text-slate-700 placeholder:text-slate-300"
                                        placeholder="Bcc Recipients"
                                    />
                                </div>
                            )}

                            {/* Subject Field */}
                            <div className="px-6 py-1 border-b border-slate-50 flex items-center gap-3 group focus-within:bg-slate-50 transition-colors">
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest w-8 group-focus-within:text-violet-600">Subj</span>
                                <input
                                    value={newMail.subject}
                                    onChange={(e) => setNewMail({ ...newMail, subject: e.target.value })}
                                    className="flex-1 py-2 bg-transparent outline-none text-sm font-semibold text-slate-700 placeholder:text-slate-300 group-focus-within:placeholder:text-slate-400"
                                    placeholder="Subject"
                                />
                            </div>

                            {/* Toolbar */}
                            <div className="px-4 py-2 border-b border-slate-50 flex items-center gap-1 bg-white">
                                <button type="button" onClick={() => document.execCommand('bold')} className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded transition-colors" title="Bold"><i className="fa-solid fa-bold text-xs"></i></button>
                                <button type="button" onClick={() => document.execCommand('italic')} className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded transition-colors" title="Italic"><i className="fa-solid fa-italic text-xs"></i></button>
                                <button type="button" onClick={() => document.execCommand('underline')} className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded transition-colors" title="Underline"><i className="fa-solid fa-underline text-xs"></i></button>
                                <div className="w-px h-4 bg-slate-200 mx-2"></div>
                                <button type="button" onClick={() => document.execCommand('insertUnorderedList')} className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded transition-colors" title="Bullet List"><i className="fa-solid fa-list-ul text-xs"></i></button>
                                <button type="button" onClick={() => document.execCommand('insertOrderedList')} className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded transition-colors" title="Numbered List"><i className="fa-solid fa-list-ol text-xs"></i></button>
                                <div className="w-px h-4 bg-slate-200 mx-2"></div>
                                <button type="button" onClick={() => { const url = prompt('Enter URL'); if (url) document.execCommand('createLink', false, url); }} className="p-1.5 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded transition-colors" title="Link"><i className="fa-solid fa-link text-xs"></i></button>
                            </div>

                            {/* Rich Text Body */}
                            <div className="flex-1 relative overflow-hidden">
                                <div
                                    ref={editorRef}
                                    className="absolute inset-0 p-6 outline-none text-sm text-slate-700 leading-relaxed font-sans overflow-y-auto custom-scrollbar prose prose-sm max-w-none"
                                    contentEditable
                                    onInput={(e) => {
                                        const html = e.currentTarget.innerHTML;
                                        lastBodyRef.current = html;
                                        setNewMail({ ...newMail, body: html });
                                    }}
                                    style={{ minHeight: '100%' }}
                                    data-placeholder="Type your message here..."
                                />
                                {!newMail.body && (
                                    <div className="absolute top-6 left-6 text-sm text-slate-300 pointer-events-none">
                                        Type your message here...
                                    </div>
                                )}
                            </div>

                            {/* Attachments List */}
                            {newMail.attachments && newMail.attachments.length > 0 && (
                                <div className="px-6 py-2 flex flex-wrap gap-2 bg-slate-50/50">
                                    {newMail.attachments.map((file, idx) => (
                                        <div key={idx} className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded-lg shadow-sm text-xs font-medium text-slate-700">
                                            <i className="fa-regular fa-file text-slate-400"></i>
                                            <span className="max-w-[150px] truncate">{file.filename}</span>
                                            <button
                                                type="button"
                                                onClick={() => setNewMail(prev => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== idx) }))}
                                                className="text-slate-400 hover:text-red-500 ml-1"
                                            >
                                                <i className="fa-solid fa-xmark"></i>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Footer */}
                            <div className="px-6 py-4 bg-slate-50/50 border-t border-slate-100 flex items-center justify-between">
                                <div className="flex gap-4 text-slate-400">
                                    <label className="cursor-pointer hover:text-violet-600 transition-colors flex items-center gap-2">
                                        <input
                                            type="file"
                                            className="hidden"
                                            multiple
                                            onChange={async (e) => {
                                                if (e.target.files && e.target.files.length > 0) {
                                                    setSaveStatus('saving');
                                                    const files = Array.from(e.target.files);

                                                    for (const file of files) {
                                                        const formData = new FormData();
                                                        formData.append('file', file);

                                                        try {
                                                            const data = await apiPost<any>('/plugin/mail-server/upload/attachment', formData);
                                                            setNewMail(prev => ({
                                                                ...prev,
                                                                attachments: [...(prev.attachments || []), data.file]
                                                            }));
                                                        } catch (err) {
                                                            console.error("Upload failed", err);
                                                        }
                                                    }
                                                    setSaveStatus('saved');
                                                }
                                            }}
                                        />
                                        <i className="fa-solid fa-paperclip text-sm"></i>
                                    </label>

                                    <div className="w-px h-4 bg-slate-200 mx-2"></div>
                                    <button type="button" onClick={discardDraft} className="hover:text-red-500 transition-colors mr-2" title="Discard Draft"><i className="fa-solid fa-trash text-sm"></i></button>
                                    <label className="flex items-center gap-2 cursor-pointer hover:text-slate-600 text-xs">
                                        <input
                                            type="checkbox"
                                            checked={newMail.useSignature}
                                            onChange={(e) => setNewMail({ ...newMail, useSignature: e.target.checked })}
                                            className="accent-violet-600"
                                        />
                                        Signature
                                    </label>
                                </div>
                                <div className="flex items-center gap-2">
                                    {showScheduleInput && (
                                        <input
                                            type="datetime-local"
                                            value={scheduledDate}
                                            onChange={(e) => setScheduledDate(e.target.value)}
                                            className="h-8 text-[10px] border border-slate-300 rounded-lg px-2 text-slate-600 outline-none bg-white font-mono"
                                        />
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setShowScheduleInput(!showScheduleInput)}
                                        className={`p-2 rounded-lg transition-colors ${showScheduleInput || scheduledDate ? 'text-violet-600 bg-violet-50' : 'text-slate-400 hover:text-violet-600'}`}
                                        title="Schedule Send"
                                    >
                                        <i className="fa-regular fa-clock text-sm"></i>
                                    </button>

                                    <button
                                        type="submit"
                                        disabled={sending}
                                        className="bg-slate-900 text-white px-6 py-2.5 rounded-lg font-bold text-xs shadow-lg shadow-slate-900/10 hover:bg-black hover:-translate-y-0.5 active:translate-y-0 transition-all flex items-center gap-2"
                                    >
                                        {sending ? <i className="fa-solid fa-circle-notch fa-spin"></i> :
                                            scheduledDate ? <i className="fa-solid fa-clock text-violet-300"></i> :
                                                <i className="fa-solid fa-paper-plane text-violet-300"></i>}
                                        {scheduledDate ? 'Schedule' : 'Send'}
                                    </button>
                                </div>
                            </div>
                        </form>
                    )}
                </div>
            )}
        </div>
    );
}

// --- Component Helpers ---

function SidebarLink({ icon, label, count, active, onClick, iconColor }: any) {
    return (
        <button
            onClick={onClick}
            className={`
                w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all mb-1 group
                ${active
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/20 ring-1 ring-white/20 font-bold'
                    : 'text-slate-400 hover:bg-white/10 hover:text-white font-medium'
                }
            `}
        >
            <div className="flex items-center gap-3.5">
                <i className={`fa-solid ${icon} w-5 text-center text-sm ${!active && iconColor ? iconColor : ''} ${active ? 'text-indigo-200' : ''}`}></i>
                <span className="text-sm tracking-wide">{label}</span>
            </div>
            {count > 0 && (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${active ? 'bg-white text-indigo-700' : 'bg-slate-800 text-slate-300'}`}>
                    {count}
                </span>
            )}
        </button>
    );
}

function ActionButton({ icon, onClick, tooltip, active, className = '' }: any) {
    return (
        <button
            onClick={onClick}
            title={tooltip}
            disabled={!onClick}
            className={`
                w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed
                ${active
                    ? 'bg-slate-100 text-slate-900 ring-1 ring-slate-200 shadow-sm'
                    : 'text-slate-400 hover:text-slate-700 hover:bg-slate-50'
                }
                ${className}
            `}
        >
            <i className={icon + " text-sm"}></i>
        </button>
    );
}

function SettingInput({ label, value, onChange, type = 'text', options = [], placeholder = '', className = '' }: any) {
    if (type === 'select') {
        return (
            <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">{label}</label>
                <select
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value)}
                    className={`w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all ${className}`}
                >
                    {options.map((opt: any) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
            </div>
        );
    }
    if (type === 'textarea') {
        return (
            <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">{label}</label>
                <textarea
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    rows={4}
                    className={`w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all resize-none ${className}`}
                />
            </div>
        );
    }
    return (
        <div>
            <label className="block text-sm font-bold text-slate-700 mb-2">{label}</label>
            <input
                type={type}
                value={value || ''}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className={`w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all ${className}`}
            />
        </div>
    );
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            // Fallback for non-secure contexts
            const ta = document.createElement('textarea');
            ta.value = value;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { }
            document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (
        <button
            type="button"
            onClick={copy}
            disabled={!value}
            title={value ? `Copy ${label}` : 'Nothing to copy'}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors border disabled:opacity-40 disabled:cursor-not-allowed ${copied ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-white text-slate-500 border-slate-200 hover:text-violet-600 hover:border-violet-300'}`}
        >
            <i className={`fa-solid ${copied ? 'fa-check' : 'fa-copy'}`}></i>
            {copied ? 'Copied' : label}
        </button>
    );
}

const DNS_PROVIDER_GUIDE = {
    cloudflare: {
        label: 'Cloudflare',
        where: 'dash.cloudflare.com → pick your domain → DNS → Records → “Add record”.',
        fields: 'Type · Name · (Content, or “Mail server” for MX) · Priority (MX only) · TTL (Auto).',
        tips: [
            'Name is the sub-part only — Cloudflare appends your domain. Use @ for the root.',
            'For MX and TXT records leave Proxy status as “DNS only” (grey cloud).',
            'Cloudflare auto-splits long TXT values (DKIM), so paste the value as one string.'
        ]
    },
    hostinger: {
        label: 'Hostinger',
        where: 'hPanel → Domains → your domain → DNS / Nameservers → “Manage DNS records” → “Add Record”.',
        fields: 'Type · Name (host) · Points to / Value · Priority (MX) · TTL.',
        tips: ['Use @ in Name for the root domain.', 'Paste the value exactly as shown; no surrounding quotes needed.']
    },
    godaddy: {
        label: 'GoDaddy',
        where: 'GoDaddy account → Domain Portfolio → your domain → DNS → “Add New Record”.',
        fields: 'Type · Name (Host) · Value / Points to · Priority (MX) · TTL.',
        tips: ['Use @ in Name/Host for the root domain.', 'Default TTL (1 hour) is fine.']
    },
    namecheap: {
        label: 'Namecheap',
        where: 'Domain List → “Manage” your domain → Advanced DNS → “Add New Record”.',
        fields: 'Type (Namecheap has a dedicated “MX Record” type) · Host · Value / Target · Priority · TTL.',
        tips: ['Use @ in Host for the root domain.', 'For MX pick the “MX Record” type; enter the Priority in its own field.']
    },
    generic: {
        label: 'Other',
        where: 'Open your registrar/DNS host’s DNS management (a.k.a. “DNS zone editor” / “Manage DNS”).',
        fields: 'Type · Host/Name · Value/Content/Points-to · Priority (MX) · TTL.',
        tips: [
            'Host/Name = the record’s host with your domain removed. Use @ for the root domain.',
            'e.g. for _dmarc.example.com enter “_dmarc”; for example.com enter “@”; for default._domainkey.example.com enter “default._domainkey”.',
            'Value/Content/Points-to = the record’s value. MX also needs a Priority (use 10).'
        ]
    }
};

function DnsRecordRow({ title, record, step, check }: { title: string; record?: DnsRecord; step?: number; check?: any }) {
    if (!record) return null;
    const statusStyles: any = {
        ok: { cls: 'bg-emerald-50 text-emerald-600 border-emerald-200', icon: 'fa-circle-check', label: 'Verified' },
        missing: { cls: 'bg-amber-50 text-amber-600 border-amber-200', icon: 'fa-clock', label: 'Not found yet' },
        mismatch: { cls: 'bg-red-50 text-red-600 border-red-200', icon: 'fa-triangle-exclamation', label: "Doesn't match" },
        nokey: { cls: 'bg-slate-100 text-slate-500 border-slate-200', icon: 'fa-key', label: 'No DKIM key yet' },
    };
    const s = check ? statusStyles[check.status] : null;
    return (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    {step !== undefined && (
                        <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-violet-600 text-white text-[10px] font-black">{step}</span>
                    )}
                    <span className="text-xs font-black uppercase tracking-wider text-slate-700">{title}</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 font-mono">{record.type}</span>
                    {s && (
                        <span
                            title={check.status === 'missing' ? 'DNS changes can take a few minutes to propagate' : undefined}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${s.cls}`}
                        >
                            <i className={`fa-solid ${s.icon}`}></i>{s.label}
                        </span>
                    )}
                </div>
                {record.value && <CopyButton value={record.value} label="Copy value" />}
            </div>
            {record.host && (
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold uppercase text-slate-400 w-12 shrink-0">Host</span>
                    <code className="text-xs text-slate-700 font-mono break-all flex-1">{record.host}</code>
                    <CopyButton value={record.host} label="Copy host" />
                </div>
            )}
            {(record.priority !== undefined && record.priority !== null) && (
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold uppercase text-slate-400 w-12 shrink-0">Priority</span>
                    <code className="text-xs text-slate-700 font-mono">{record.priority}</code>
                </div>
            )}
            {record.value && (
                <div className="flex items-start gap-2">
                    <span className="text-[10px] font-bold uppercase text-slate-400 w-12 shrink-0 mt-0.5">Value</span>
                    <code className="text-xs text-slate-700 font-mono break-all flex-1 whitespace-pre-wrap">{record.value}</code>
                </div>
            )}
            {record.note && <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">{record.note}</p>}
            {check?.status === 'mismatch' && check?.detail && (
                <p className="text-[11px] text-red-600 mt-2 leading-relaxed">
                    <i className="fa-solid fa-triangle-exclamation mr-1"></i>{check.detail}
                </p>
            )}
        </div>
    );
}

function SettingsView({ settings, setSettings, onSave, saving, message, dnsInfo, dnsLoading, onRefreshDns, onGenerateDkim, generatingDkim, testTo, setTestTo, onSendTest, testing, testResult }: any) {
    const [dnsProvider, setDnsProvider] = useState('generic');
    const [dnsCheck, setDnsCheck] = useState<any>(null);
    const [checkingDns, setCheckingDns] = useState(false);
    const runDnsCheck = async () => {
        setCheckingDns(true);
        try { const r = await api('/plugin/mail-server/security/dns-check') as any; setDnsCheck(r); }
        catch (e) { setDnsCheck({ error: true }); }
        finally { setCheckingDns(false); }
    };

    // One-click, EXPLICITLY-CONFIRMED fix for the port-25 squatter (usually the distro's preinstalled
    // Postfix/Exim bound to loopback). The heavy lifting is host-side (core port-conflicts + admin
    // routes); this just shows WHO holds the port, asks consent for a PERMANENT disable, and refreshes.
    const { confirm: confirmFreePort } = useModal();
    const [freeingPort, setFreeingPort] = useState(false);
    const [freePortMsg, setFreePortMsg] = useState<string | null>(null);
    const askFreePortConsent = async (conflict: any) => {
        const label = conflict?.occupant?.label || 'The conflicting service';
        const scope = conflict?.occupant?.loopbackOnly
            ? `${label} only listens on localhost, so it is NOT receiving internet mail — disabling it is safe.`
            : `CAREFUL: ${label} is listening on public interfaces and may be receiving real mail for this server.`;
        return confirmFreePort(
            `${label} is holding port 25, which WordJS needs to receive internet mail.\n\n${scope}\n\nWordJS will PERMANENTLY disable ${label} (systemctl disable --now — it will NOT come back after a reboot) and restart the mail listener so it takes port 25. Continue?`,
            'Free port 25',
            true
        );
    };
    const freeInboundPort = async () => {
        setFreePortMsg(null);
        setFreeingPort(true);
        try {
            const info = await api('/plugins/mail-server/port-conflicts') as any;
            const conflict = (info?.conflicts || []).find((c: any) => c.port === 25);
            // Not fixable OR not even inspectable (non-Linux, ss missing): the reason IS the answer —
            // show it and do nothing else (no consent skipped, no pointless plugin restart).
            if (conflict?.reason && !(conflict.inUse && conflict.canFree)) {
                setFreePortMsg(conflict.reason);
                return;
            }
            // Consent BEFORE disabling anything; the flag travels with the request so the server never
            // disables a service on a stale snapshot (it re-checks and demands consent: TOCTOU-safe).
            let allowDisable = false;
            if (conflict?.inUse && conflict?.canFree) {
                if (!(await askFreePortConsent(conflict))) return;
                allowDisable = true;
            }
            try {
                await api('/plugins/mail-server/free-port', { method: 'POST', body: { port: 25, allowDisable } });
            } catch (e: any) {
                // The squatter (re)appeared between snapshot and POST — server refused without consent.
                // Ask now, with the server's FRESH conflict, and retry carrying the consent.
                const details = e && e.details;
                if (details && details.code === 'CONSENT_REQUIRED') {
                    if (!(await askFreePortConsent(details.conflict))) return;
                    await api('/plugins/mail-server/free-port', { method: 'POST', body: { port: 25, allowDisable: true } });
                } else {
                    throw e;
                }
            }
            // MERGE the refetch (the loader merges too): a full replace would wipe unsaved form edits
            // (e.g. a relay password typed but not yet saved) from this same settings screen.
            const fresh = await api('/plugin/mail-server/settings') as any;
            setSettings((prev: any) => ({ ...prev, ...fresh }));
        } catch (e: any) {
            setFreePortMsg((e && e.message) || 'Failed to free port 25.');
        } finally {
            setFreeingPort(false);
        }
    };
    return (
        <div className="max-w-2xl mx-auto pt-10 pb-20">
            <h2 className="text-3xl font-bold text-slate-900 mb-3 tracking-tight">Server &amp; Deliverability</h2>
            <p className="text-slate-500 mb-10 text-lg">Configure your server's outbound identity, security, and DNS.</p>

            {/* SMTP + Identity */}
            <div className="bg-white rounded-[1.5rem] border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/40">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <i className="fa-solid fa-server text-violet-500"></i>
                        SMTP &amp; Identity
                    </h3>
                </div>
                <div className="p-8 grid gap-8">
                    {/* Inbound listener status */}
                    {(settings.inbound_bound_port !== null && settings.inbound_bound_port !== undefined) ? (
                        settings.inbound_ok ? (
                            <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-emerald-700">
                                <i className="fa-solid fa-circle-check text-emerald-500 text-lg"></i>
                                <span className="text-sm font-semibold">Receiving on port 25 — ready to accept mail from the internet.</span>
                            </div>
                        ) : settings.inbound_degraded ? (
                            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-800">
                                <div className="flex items-start gap-3">
                                    <i className="fa-solid fa-triangle-exclamation text-amber-500 text-lg mt-0.5"></i>
                                    <div className="grid gap-2">
                                        <span className="text-sm font-semibold">
                                            Listening on port {settings.inbound_bound_port} — NOT the standard port 25. Inbound internet mail will NOT arrive until you fix this:
                                        </span>
                                        {settings.inbound_reason ? (
                                            <code className="block text-[12px] font-mono text-amber-900/70 bg-amber-100/60 rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap break-words">
                                                {settings.inbound_reason}
                                            </code>
                                        ) : null}
                                        <div>
                                            <button
                                                type="button"
                                                onClick={freeInboundPort}
                                                disabled={freeingPort}
                                                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold uppercase tracking-wide transition-colors disabled:opacity-50"
                                            >
                                                {freeingPort ? (<><i className="fa-solid fa-circle-notch fa-spin mr-2"></i>Freeing port 25…</>) : (<><i className="fa-solid fa-unlock mr-2"></i>Free port 25 automatically</>)}
                                            </button>
                                        </div>
                                        {freePortMsg ? (
                                            <div className="text-[12px] text-amber-900/80 whitespace-pre-wrap">{freePortMsg}</div>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        ) : null
                    ) : (
                        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-slate-500">
                            <i className="fa-solid fa-circle-info text-slate-400 text-lg"></i>
                            <span className="text-sm font-medium">Inbound listener status unavailable.</span>
                        </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <SettingInput label="From Email (Default)" value={settings.mail_from_email} onChange={(v: string) => setSettings({ ...settings, mail_from_email: v })} placeholder="noreply@example.com" type="email" />
                        <SettingInput label="From Name (Default)" value={settings.mail_from_name} onChange={(v: string) => setSettings({ ...settings, mail_from_name: v })} placeholder="My Site" />
                    </div>
                    <SettingInput label="HELO / EHLO Host" value={settings.mail_helo_host} onChange={(v: string) => setSettings({ ...settings, mail_helo_host: v })} placeholder="mail.example.com" />
                    <SettingInput label="Catch-All Mode" value={settings.smtp_catch_all} onChange={(v: string) => setSettings({ ...settings, smtp_catch_all: v })} type="select" options={[{ label: 'Disabled (Strict)', value: '0' }, { label: 'Enabled (Catch All)', value: '1' }]} />

                    {/* Advanced */}
                    <div className="border-t border-slate-100 pt-6">
                        <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-2">
                            <i className="fa-solid fa-sliders text-slate-300"></i>
                            Advanced
                        </h4>
                        <div className="max-w-xs">
                            <label className="block text-[13px] font-semibold text-slate-500 mb-1.5">Inbound listen port (advanced)</label>
                            <input
                                type="text"
                                value={settings.smtp_listen_port || ''}
                                onChange={(e) => setSettings({ ...settings, smtp_listen_port: e.target.value })}
                                placeholder="25"
                                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50/60 text-slate-600 focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all"
                            />
                            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                                Defaults to 25 — the port the internet delivers mail to. Leave it unless you're deliberately mapping ports at the OS/proxy level (e.g. 25 → 2525).
                            </p>
                        </div>

                        <div className="max-w-md mt-6">
                            <label className="block text-[13px] font-semibold text-slate-500 mb-1.5">Trusted proxy IPs — PROXY protocol</label>
                            <input
                                type="text"
                                value={settings.smtp_proxy_ips || ''}
                                onChange={(e) => setSettings({ ...settings, smtp_proxy_ips: e.target.value })}
                                placeholder="10.8.0.1, 2001:db8::1"
                                className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg bg-slate-50/60 text-slate-600 focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all"
                            />
                            {settings.smtp_proxy_active ? (
                                <p className="text-[11px] text-emerald-600 mt-2 font-medium">
                                    <i className="fa-solid fa-shield-halved mr-1"></i>
                                    PROXY protocol active — the real sender IP is read from these proxies for SPF, DNSBL and logging.
                                </p>
                            ) : null}
                            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                                Only set this if inbound mail reaches WordJS <strong>through a TCP proxy</strong> — e.g. nginx <code className="text-[10px] bg-slate-100 px-1 rounded">stream</code> with <code className="text-[10px] bg-slate-100 px-1 rounded">proxy_protocol on;</code> or HAProxy <code className="text-[10px] bg-slate-100 px-1 rounded">send-proxy</code>. List the proxy's own IP(s), comma-separated. WordJS reads the real client IP from the PROXY v1 header <strong>only</strong> on connections from these exact IPs — never from anyone else, so a sender can't forge their source IP. Leave blank for direct delivery.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Relay / Smarthost (optional) */}
            <div className="bg-white rounded-[1.5rem] border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/40 mt-8">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50">
                    <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <i className="fa-solid fa-tower-broadcast text-sky-500"></i>
                        Relay / Smarthost <span className="text-xs font-medium text-slate-400 ml-1">optional</span>
                    </h3>
                </div>
                <div className="p-8 grid gap-8">
                    <p className="text-[12px] text-slate-500 leading-relaxed -mt-2">
                        Leave blank to deliver <strong>direct-to-MX on port 25</strong>. Most cloud, VPS and residential hosts
                        <strong> block outbound port 25</strong> — point at an SMTP relay (SendGrid, Mailgun, Amazon SES, your ISP,
                        or a LAN smarthost) to deliver through it instead. The password is stored <strong>encrypted</strong>.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <SettingInput label="Relay Host" value={settings.mail_server || ''} onChange={(v: string) => setSettings({ ...settings, mail_server: v })} placeholder="smtp.sendgrid.net" />
                        <SettingInput label="Port" value={settings.mail_port || ''} onChange={(v: string) => setSettings({ ...settings, mail_port: v })} placeholder="587" />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <SettingInput label="Username" value={settings.mail_user || ''} onChange={(v: string) => setSettings({ ...settings, mail_user: v })} placeholder="apikey" />
                        <SettingInput
                            label={settings.mail_pass_set ? 'Password (stored — leave blank to keep)' : 'Password'}
                            value={settings.mail_pass || ''}
                            onChange={(v: string) => setSettings({ ...settings, mail_pass: v })}
                            placeholder={settings.mail_pass_set ? '••••••••' : 'relay password / API key'}
                            type="password"
                        />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <SettingInput label="Encryption" value={settings.mail_secure || '0'} onChange={(v: string) => setSettings({ ...settings, mail_secure: v })} type="select" options={[{ label: 'STARTTLS (587 / 25)', value: '0' }, { label: 'Implicit TLS (465)', value: '1' }]} />
                        <SettingInput label="Require STARTTLS" value={settings.mail_relay_require_tls || '1'} onChange={(v: string) => setSettings({ ...settings, mail_relay_require_tls: v })} type="select" options={[{ label: 'Yes (recommended)', value: '1' }, { label: 'No — internal TLS-less relay only', value: '0' }]} />
                    </div>
                </div>
            </div>

            {/* Security */}
            <div className="bg-white rounded-[1.5rem] border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/40 mt-8">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <i className="fa-solid fa-shield-halved text-emerald-500"></i>
                        Security
                    </h3>
                </div>
                <div className="p-8 grid gap-8">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <SettingInput label="DNSBL Filtering" value={settings.mail_security_dnsbl_enabled} onChange={(v: string) => setSettings({ ...settings, mail_security_dnsbl_enabled: v })} type="select" options={[{ label: 'Disabled', value: '0' }, { label: 'Enabled (Zen.spamhaus)', value: '1' }]} />
                        <SettingInput label="SPF Verification" value={settings.mail_security_spf_enabled} onChange={(v: string) => setSettings({ ...settings, mail_security_spf_enabled: v })} type="select" options={[{ label: 'Disabled', value: '0' }, { label: 'Enabled', value: '1' }]} />
                    </div>

                    <div className="border-t border-slate-100 pt-6 mt-1">
                        <div className="flex items-center justify-between mb-4">
                            <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2"><i className="fa-solid fa-key text-slate-400"></i> DKIM Signing (Outgoing)</h4>
                            <span className={`text-[10px] font-bold px-2 py-1 rounded-md ${dnsInfo?.dkimConfigured ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                                <i className={`fa-solid ${dnsInfo?.dkimConfigured ? 'fa-circle-check' : 'fa-triangle-exclamation'} mr-1`}></i>
                                {dnsInfo?.dkimConfigured ? 'Configured' : 'Not configured'}
                            </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                            <SettingInput label="Domain" value={settings.mail_security_dkim_domain} onChange={(v: string) => setSettings({ ...settings, mail_security_dkim_domain: v })} placeholder="example.com" />
                            <SettingInput label="Selector" value={settings.mail_security_dkim_selector} onChange={(v: string) => setSettings({ ...settings, mail_security_dkim_selector: v })} placeholder="default" />
                        </div>
                        <button
                            type="button"
                            onClick={onGenerateDkim}
                            disabled={generatingDkim}
                            className="inline-flex items-center gap-2 bg-emerald-600 text-white px-5 py-2.5 rounded-xl font-bold text-xs shadow-lg shadow-emerald-600/20 hover:bg-emerald-500 hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:transform-none"
                        >
                            {generatingDkim ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-key"></i>}
                            {dnsInfo?.dkimConfigured ? 'Regenerate DKIM Key' : 'Generate DKIM Key'}
                        </button>
                        <p className="text-[11px] text-amber-600 mt-2 leading-relaxed">
                            <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                            Regenerating invalidates the old key. Mail signed with the old key will fail until you publish the new DKIM DNS record below.
                        </p>
                    </div>
                </div>
                <div className="bg-slate-50 px-8 py-6 border-t border-slate-100 flex justify-end">
                    <button onClick={onSave} disabled={saving} className="bg-slate-900 text-white px-8 py-3 rounded-xl font-bold text-sm shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:transform-none">
                        {saving ? <><i className="fa-solid fa-circle-notch fa-spin mr-2"></i>Saving...</> : 'Save Changes'}
                    </button>
                </div>
            </div>

            {/* DNS Records */}
            <div className="bg-white rounded-[1.5rem] border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/40 mt-8">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <i className="fa-solid fa-globe text-indigo-500"></i>
                        DNS Records to Publish
                    </h3>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={runDnsCheck}
                            disabled={checkingDns}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors bg-white text-violet-600 border-violet-200 hover:bg-violet-50 hover:border-violet-300 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <i className={`fa-solid ${checkingDns ? 'fa-circle-notch fa-spin' : 'fa-shield-halved'}`}></i>
                            {checkingDns ? 'Checking…' : dnsCheck && !dnsCheck.error ? 'Re-check' : 'Verify DNS'}
                        </button>
                        <button type="button" onClick={onRefreshDns} disabled={dnsLoading} className="text-slate-400 hover:text-indigo-600 transition-colors disabled:opacity-50" title="Refresh records">
                            <i className={`fa-solid fa-rotate-right ${dnsLoading ? 'fa-spin' : ''}`}></i>
                        </button>
                    </div>
                </div>
                {dnsCheck && !dnsCheck.error && (
                    <div className="px-8 py-2.5 border-b border-slate-100 bg-slate-50/30 flex items-center gap-2 text-[11px] text-slate-500">
                        <i className="fa-solid fa-shield-halved text-emerald-500"></i>
                        <span>
                            <strong className="text-slate-700">{['mx', 'a', 'spf', 'dkim', 'dmarc'].filter((k) => dnsCheck.results?.[k]?.status === 'ok').length}</strong> of 5 records verified
                            {dnsCheck.checkedAt && <> · checked {new Date(dnsCheck.checkedAt).toLocaleTimeString()}</>}
                        </span>
                    </div>
                )}
                <div className="p-8 grid gap-4">
                    {dnsLoading && !dnsInfo ? (
                        <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                            <i className="fa-solid fa-circle-notch fa-spin text-2xl mb-3"></i>
                            <span className="text-sm font-medium">Loading DNS records...</span>
                        </div>
                    ) : dnsInfo ? (
                        <>
                            <p className="text-xs text-slate-500 leading-relaxed -mt-1">
                                Publish these at your DNS provider for domain <code className="font-mono text-slate-700">{dnsInfo.domain || '(set a domain)'}</code>. Sending HELO host: <code className="font-mono text-slate-700">{dnsInfo.heloHost}</code>.
                            </p>
                            <DnsRecordRow step={1} title="MX" record={dnsInfo.records?.mx} check={dnsCheck?.results?.mx} />
                            <DnsRecordRow step={2} title="A" record={dnsInfo.records?.a} check={dnsCheck?.results?.a} />
                            <DnsRecordRow step={3} title="SPF" record={dnsInfo.records?.spf} check={dnsCheck?.results?.spf} />
                            <DnsRecordRow step={4} title="DKIM" record={dnsInfo.records?.dkim} check={dnsCheck?.results?.dkim} />
                            <DnsRecordRow step={5} title="DMARC" record={dnsInfo.records?.dmarc} check={dnsCheck?.results?.dmarc} />
                            <DnsRecordRow step={6} title="PTR" record={dnsInfo.records?.ptr} />

                            {/* How to add these at your DNS provider */}
                            <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-5 mt-2">
                                <div className="flex items-start gap-2 mb-4">
                                    <i className="fa-solid fa-circle-info text-violet-500 mt-0.5"></i>
                                    <p className="text-xs text-slate-600 leading-relaxed">
                                        Most providers want the host <strong>without your domain</strong> — use <code className="font-mono text-slate-700">@</code> for the root (e.g. <code className="font-mono text-slate-700">{dnsInfo.domain || 'example.com'}</code>).
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-2 mb-4">
                                    {Object.keys(DNS_PROVIDER_GUIDE).map((key) => (
                                        <button
                                            key={key}
                                            type="button"
                                            onClick={() => setDnsProvider(key)}
                                            className={`px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors ${dnsProvider === key ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-500 border-slate-200 hover:text-violet-600 hover:border-violet-300'}`}
                                        >
                                            {DNS_PROVIDER_GUIDE[key].label}
                                        </button>
                                    ))}
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white p-4">
                                    <div className="flex items-center gap-2 mb-3">
                                        <i className="fa-solid fa-book text-violet-500"></i>
                                        <span className="text-xs font-black uppercase tracking-wider text-slate-700">How to add these at {DNS_PROVIDER_GUIDE[dnsProvider].label}</span>
                                    </div>
                                    <p className="text-xs text-slate-600 leading-relaxed mb-1.5"><span className="font-bold text-slate-500">Where:</span> {DNS_PROVIDER_GUIDE[dnsProvider].where}</p>
                                    <p className="text-xs text-slate-600 leading-relaxed mb-3"><span className="font-bold text-slate-500">Fields you'll fill:</span> {DNS_PROVIDER_GUIDE[dnsProvider].fields}</p>
                                    <ul className="grid gap-1.5">
                                        {DNS_PROVIDER_GUIDE[dnsProvider].tips.map((tip, i) => (
                                            <li key={i} className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed">
                                                <i className="fa-solid fa-circle-check text-violet-400 mt-0.5 text-[10px]"></i>
                                                <span>{tip}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                            <i className="fa-solid fa-globe text-2xl mb-3 opacity-50"></i>
                            <span className="text-sm font-medium">No DNS records loaded</span>
                            <button type="button" onClick={onRefreshDns} className="mt-3 text-xs font-bold text-indigo-600 hover:underline">Load records</button>
                        </div>
                    )}
                </div>
            </div>

            {/* Test Delivery */}
            <div className="bg-white rounded-[1.5rem] border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/40 mt-8">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <i className="fa-solid fa-paper-plane text-violet-500"></i>
                        Test Deliverability
                    </h3>
                </div>
                <div className="p-8">
                    <div className="flex flex-col sm:flex-row gap-3">
                        <input
                            type="email"
                            value={testTo}
                            onChange={(e) => setTestTo(e.target.value)}
                            placeholder="recipient@example.com (defaults to your address)"
                            className="flex-1 px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all text-sm"
                        />
                        <button
                            type="button"
                            onClick={onSendTest}
                            disabled={testing}
                            className="inline-flex items-center justify-center gap-2 bg-violet-600 text-white px-6 py-3 rounded-xl font-bold text-sm shadow-lg shadow-violet-600/20 hover:bg-violet-500 hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:transform-none shrink-0"
                        >
                            {testing ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-paper-plane"></i>}
                            Send test email
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
                        Real external delivery requires reverse DNS (rDNS/PTR) for your sending IP, published SPF/DKIM/DMARC records, and an open outbound port 25.
                    </p>

                    {testResult && (
                        <div className={`mt-5 rounded-xl border p-4 text-sm ${testResult.localOnly ? 'bg-amber-50 border-amber-200' : testResult.success ? 'bg-emerald-50 border-emerald-100' : 'bg-red-50 border-red-100'}`}>
                            <div className={`flex items-center gap-2 font-bold ${testResult.localOnly ? 'text-amber-700' : testResult.success ? 'text-emerald-700' : 'text-red-700'}`}>
                                <i className={`fa-solid ${testResult.localOnly ? 'fa-triangle-exclamation' : testResult.success ? 'fa-circle-check' : 'fa-circle-exclamation'}`}></i>
                                {testResult.message}
                            </div>
                            {testResult.delivered && testResult.delivered.length > 0 && (
                                <div className="mt-3 space-y-1.5">
                                    {testResult.delivered.map((d: any, i: number) => (
                                        <div key={`d-${i}`} className="text-xs text-emerald-800 bg-emerald-100/50 rounded-lg px-3 py-2 font-mono break-all">
                                            <span className="font-bold">{d.recipient}</span> via <span className="font-bold">{d.via}</span> — {d.response}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {testResult.failed && testResult.failed.length > 0 && (
                                <div className="mt-3 space-y-1.5">
                                    {testResult.failed.map((f: any, i: number) => (
                                        <div key={`f-${i}`} className="text-xs text-red-800 bg-red-100/50 rounded-lg px-3 py-2 font-mono break-all">
                                            <span className="font-bold">{f.recipient}</span> — {f.error}{f.permanent ? ' (permanent)' : ''}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
