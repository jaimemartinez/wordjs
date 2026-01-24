"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { api, apiPost } from "../../../../../admin-next/src/lib/api";
import { useAuth } from "../../../../../admin-next/src/contexts/AuthContext";
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

// Helper function to generate email signature
const getSignature = (user: any) => {
    if (!user) return '';
    const name = user.displayName || user.username || '';
    const email = user.userEmail || user.email || '';
    return `\n\n--\n${name}\n${email}`;
};

export default function MailServerAdmin() {
    // Data State
    const [folder, setFolder] = useState<'inbox' | 'sent' | 'settings' | 'starred' | 'archive' | 'drafts' | 'trash'>('inbox');
    const [emails, setEmails] = useState<Email[]>([]);
    const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
    const [settings, setSettings] = useState({
        mail_from_email: "",
        mail_from_name: "",
        smtp_listen_port: "2525",
        smtp_catch_all: "0"
    });

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

    const { user } = useAuth();
    const editorRef = useRef<HTMLDivElement>(null);
    const lastBodyRef = useRef("");

    // --- Effects & Logic ---

    const loadStats = async () => {
        try {
            const data = await api('/mail-server/stats') as any;
            if (data && typeof data.unread === 'number') setInboxCount(data.unread);
        } catch (e) { }
    };

    const loadData = useCallback(async (query = "") => {
        setLoading(true);
        loadStats();
        try {
            if (folder === 'settings') {
                const data = await api('/mail-server/settings');
                setSettings(data as any);
            } else {
                const endpoint = query
                    ? `/mail-server/emails/search?q=${query}`
                    : `/mail-server/emails?folder=${folder}`;

                const res = await api(endpoint) as any;
                setEmails(res.emails || []);
            }
        } catch (error) {
            console.error("Failed to load data:", error);
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
                    const data = await api(`/mail-server/users/search?q=${newMail.to}`) as any;
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

    // Auto-save Draft
    useEffect(() => {
        if (!composing || (!newMail.to && !newMail.subject && !newMail.body)) return;
        if (sending) return;

        const timer = setTimeout(async () => {
            setSaveStatus('saving');
            try {
                const res = await api('/mail-server/drafts', {
                    method: 'POST',
                    body: {
                        ...newMail,
                        isHtml: true,
                        replyToId,
                        id: draftId,
                        // Append signature if enabled
                        body: newMail.useSignature ? newMail.body + getSignature(user) : newMail.body
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
                await api(`/mail-server/emails/${draftId}`, { method: 'DELETE' });
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
        setSending(true);
        setMessage(null);
        try {
            await api('/mail-server/send', {
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
            await api('/mail-server/settings', {
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

    const handleReply = (email: Email) => {
        setReplyToId(email.id);
        const isReply = email.subject.toLowerCase().startsWith('re:');
        setNewMail({
            to: email.is_sent ? email.to_address : email.from_address,
            cc: "",
            bcc: "",
            subject: isReply ? email.subject : `Re: ${email.subject}`,
            body: `\n\n\n--- On ${new Date(email.date_received).toLocaleString()}, ${email.from_name || email.from_address} wrote: ---\n${email.body_text}`,
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
            body: `\n\n\n---------- Forwarded message ---------\nFrom: ${email.from_name || email.from_address} <${email.from_address}>\nDate: ${new Date(email.date_received).toLocaleString()}\nSubject: ${email.subject}\nTo: ${email.to_address}\n\n${email.body_text}`,
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
            await api('/mail-server/trash/empty', { method: 'DELETE' });
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
            await api(`/mail-server/emails/${email.id}/restore`, { method: 'PUT' });
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
            await api(`/mail-server/emails/${id}`, { method: 'DELETE' });
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
            await api(`/mail-server/emails/${email.id}/archive`, {
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
            await api(`/mail-server/emails/${email.id}/star`, {
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
            setReplyToId(email.thread_id || null);
            setDraftId(email.id);
            setComposing(true);
            setIsMinimized(false);
            return;
        }

        setSelectedEmail(email);
        try {
            const fullEmail = await api(`/mail-server/emails/${email.id}`) as any;
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
                        onClick={() => { setFolder('sent'); setSelectedEmail(null); }}
                    />
                    <SidebarLink
                        icon="fa-file-lines" // Changed to file-lines
                        label="Drafts"
                        active={folder === 'drafts'}
                        onClick={() => { setFolder('drafts'); setSelectedEmail(null); }}
                    />
                    <SidebarLink
                        icon="fa-box-archive"
                        label="Archive"
                        active={folder === 'archive'}
                        onClick={() => { setFolder('archive'); setSelectedEmail(null); }}
                    />
                    <SidebarLink
                        icon="fa-trash"
                        label="Trash"
                        active={folder === 'trash'}
                        onClick={() => { setFolder('trash'); setSelectedEmail(null); }}
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
                        onClick={() => { setFolder('starred'); setSelectedEmail(null); }}
                        iconColor="text-amber-400"
                    />
                    <SidebarLink icon="fa-triangle-exclamation" label="Important" active={false} iconColor="text-orange-400" />

                    {user?.role === 'administrator' && (
                        <div className="pt-8 mt-auto">
                            <SidebarLink
                                icon="fa-sliders"
                                label="Server Admin"
                                active={folder === 'settings'}
                                onClick={() => { setFolder('settings'); setSelectedEmail(null); }}
                            />
                        </div>
                    )}
                </nav>

                {/* User Profile Mini */}
                <div className="mt-auto px-6 pt-6 border-t border-slate-800/50 flex items-center gap-3 cursor-pointer group hover:bg-white/5 mx-3 rounded-xl transition-colors pb-2">
                    <div className="w-9 h-9 rounded-lg bg-slate-800 overflow-hidden ring-1 ring-white/10 group-hover:ring-indigo-500/50 transition-all">
                        {/* Placeholder Avatar */}
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-tr from-slate-700 to-slate-600 text-xs font-bold text-slate-300">
                            {user?.username?.charAt(0).toUpperCase()}
                        </div>
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-200 truncate group-hover:text-white">{user?.displayName || user?.username}</div>
                        <div className="text-[10px] text-slate-500 truncate">{(user as any)?.userEmail}</div>
                    </div>
                    <i className="fa-solid fa-chevron-right text-slate-600 text-xs"></i>
                </div>
            </aside>

            {folder === 'settings' ? (
                // SETTINGS VIEW (Full Width)
                <div className="flex-1 bg-white overflow-y-auto p-12">
                    <SettingsView settings={settings} setSettings={setSettings} onSave={handleSaveSettings} saving={saving} message={message} />
                </div>
            ) : (
                // MAIL VIEW
                <>
                    {/* COLUMN 2: MESSAGE LIST */}
                    <div className={`
                        bg-white border-r border-slate-200 flex flex-col z-10 shadow-sm relative transition-all duration-300
                        ${selectedEmail ? 'hidden lg:flex lg:w-[400px]' : 'flex w-full md:flex-1 lg:w-[400px] lg:flex-none'}
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
                                    onClick={() => loadData()}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-violet-600 transition-colors"
                                    title="Refresh"
                                >
                                    <i className={`fa-solid fa-rotate-right ${loading ? 'fa-spin' : ''}`}></i>
                                </button>
                            </div>
                        </div>

                        {/* List */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-50/50">
                            {emails.length === 0 && !loading ? (
                                <div className="flex flex-col items-center justify-center h-64 text-slate-400 opacity-60">
                                    <i className="fa-solid fa-inbox text-4xl mb-4"></i>
                                    <span className="text-sm font-medium">All caught up</span>
                                </div>
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
                                        <ActionButton icon="fa-solid fa-envelope-open" tooltip="Mark as Unread" />
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
                                <div className="flex-1 overflow-y-auto p-10 custom-scrollbar">
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
                                                                <span className="text-base font-bold text-slate-900 mr-2">{msg.from_name || msg.from_address}</span>
                                                                <span className="text-sm text-slate-400 font-medium">&lt;{msg.from_address}&gt;</span>
                                                            </div>
                                                            <span className="text-xs text-slate-400 font-medium">{new Date(msg.date_received).toLocaleString()}</span>
                                                        </div>

                                                        <div className="prose prose-slate prose-sm max-w-none text-slate-600 leading-7 rounded-2xl bg-[#f8fafc] p-8 border border-slate-100 group-hover:border-slate-200 group-hover:shadow-sm transition-all">
                                                            {msg.body_html ? (
                                                                <div dangerouslySetInnerHTML={{ __html: msg.body_html }} />
                                                            ) : (
                                                                <div className="whitespace-pre-wrap font-sans">{msg.body_text}</div>
                                                            )}
                                                        </div>
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
                                        value={newMail.to}
                                        onChange={(e) => setNewMail({ ...newMail, to: e.target.value })}
                                        className="w-full py-2 bg-transparent outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300 group-focus-within:placeholder:text-slate-400"
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
                                                            const data = await apiPost<any>('/mail-server/upload/attachment', formData);
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
                                    <i className="fa-regular fa-image hover:text-violet-600 cursor-pointer transition-colors text-sm" title="Insert Image"></i>
                                    <i className="fa-regular fa-face-smile hover:text-violet-600 cursor-pointer transition-colors text-sm" title="Emoji"></i>

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

function ActionButton({ icon, onClick, tooltip, active }: any) {
    return (
        <button
            onClick={onClick}
            title={tooltip}
            className={`
                w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200
                ${active
                    ? 'bg-slate-100 text-slate-900 ring-1 ring-slate-200 shadow-sm'
                    : 'text-slate-400 hover:text-slate-700 hover:bg-slate-50'
                }
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

function SettingsView({ settings, setSettings, onSave, saving, message }: any) {
    return (
        <div className="max-w-2xl mx-auto pt-10">
            <h2 className="text-3xl font-bold text-slate-900 mb-3 tracking-tight">Mail Settings</h2>
            <p className="text-slate-500 mb-10 text-lg">Configure your server's outbound identity.</p>

            {message && (
                <div className={`mb-8 p-4 rounded-xl flex items-center gap-3 text-sm font-bold shadow-sm ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
                    <i className={`fa-solid ${message.type === 'success' ? 'fa-check' : 'fa-circle-exclamation'}`}></i>
                    {message.text}
                </div>
            )}

            <div className="bg-white rounded-[1.5rem] border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/40">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <i className="fa-solid fa-server text-violet-500"></i>
                        SMTP Configuration
                    </h3>
                </div>

                <div className="p-8 grid gap-8">
                    <SettingInput label="Server Port" value={settings.smtp_listen_port} onChange={(v: string) => setSettings({ ...settings, smtp_listen_port: v })} />
                    <SettingInput label="Catch-All Mode" value={settings.smtp_catch_all} onChange={(v: string) => setSettings({ ...settings, smtp_catch_all: v })} type="select" options={[{ label: 'Disabled (Strict)', value: '0' }, { label: 'Enabled (Catch All)', value: '1' }]} />
                    <SettingInput label="From Name (Default)" value={settings.mail_from_name} onChange={(v: string) => setSettings({ ...settings, mail_from_name: v })} />
                </div>
            </div>

            <div className="bg-white rounded-[1.5rem] border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/40 mt-8">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                    <h3 className="font-bold text-slate-800 flex items-center gap-2">
                        <i className="fa-solid fa-shield-halved text-emerald-500"></i>
                        Security Configuration
                    </h3>
                </div>
                <div className="p-8 grid gap-8">
                    <div className="grid grid-cols-2 gap-8">
                        <SettingInput label="DNSBL Filtering" value={settings.mail_security_dnsbl_enabled} onChange={(v: string) => setSettings({ ...settings, mail_security_dnsbl_enabled: v })} type="select" options={[{ label: 'Disabled', value: '0' }, { label: 'Enabled (Zen.spamhaus)', value: '1' }]} />
                        <SettingInput label="SPF Verification" value={settings.mail_security_spf_enabled} onChange={(v: string) => setSettings({ ...settings, mail_security_spf_enabled: v })} type="select" options={[{ label: 'Disabled', value: '0' }, { label: 'Enabled', value: '1' }]} />
                    </div>

                    <div className="border-t border-slate-100 pt-6 mt-2">
                        <h4 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2"><i className="fa-solid fa-key text-slate-400"></i> DKIM Signing (Outgoing)</h4>
                        <div className="grid grid-cols-2 gap-4 mb-4">
                            <SettingInput label="Domain" value={settings.mail_security_dkim_domain} onChange={(v: string) => setSettings({ ...settings, mail_security_dkim_domain: v })} placeholder="example.com" />
                            <SettingInput label="Selector" value={settings.mail_security_dkim_selector} onChange={(v: string) => setSettings({ ...settings, mail_security_dkim_selector: v })} placeholder="default" />
                        </div>
                        <SettingInput label="Private Key (PEM)" value={settings.mail_security_dkim_private_key} onChange={(v: string) => setSettings({ ...settings, mail_security_dkim_private_key: v })} type="textarea" className="font-mono text-xs" />
                    </div>

                    <div className="bg-slate-50 px-8 py-6 border-t border-slate-100 flex justify-end">
                        <button onClick={onSave} disabled={saving} className="bg-slate-900 text-white px-8 py-3 rounded-xl font-bold text-sm shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:transform-none">
                            {saving ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
