"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

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
    is_sent: number;
    parent_id: number;
    thread_id: number;
    thread_count?: number;
    thread?: Email[];
};

export default function MailServerAdmin() {
    const [folder, setFolder] = useState<'inbox' | 'sent' | 'settings'>('inbox');
    const [emails, setEmails] = useState<Email[]>([]);
    const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
    const [settings, setSettings] = useState({
        mail_from_email: "",
        mail_from_name: "",
        smtp_listen_port: "2525",
        smtp_catch_all: "0"
    });
    const [composing, setComposing] = useState(false);
    const [newMail, setNewMail] = useState({ to: "", subject: "", body: "" });
    const [replyToId, setReplyToId] = useState<number | null>(null);
    const [suggestions, setSuggestions] = useState<{ email: string, name: string }[]>([]);
    const [searching, setSearching] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [sending, setSending] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const { user } = useAuth();

    useEffect(() => {
        const timer = setTimeout(async () => {
            if (newMail.to.length >= 2 && !newMail.to.includes('@')) {
                setSearching(true);
                try {
                    const data = await api(`/mail-server/users/search?q=${newMail.to}`);
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
    }, [folder]);

    const loadData = async () => {
        setLoading(true);
        try {
            if (folder === 'settings') {
                const data = await api('/mail-server/settings');
                setSettings(data);
            } else {
                const res = await api(`/mail-server/emails?folder=${folder}`);
                setEmails(res.emails || []);
            }
        } catch (error) {
            console.error("Failed to load data:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        setSending(true);
        setMessage(null);
        try {
            await api('/mail-server/send', {
                method: 'POST',
                body: { ...newMail, isHtml: true, replyToId }
            });
            setMessage({ type: 'success', text: 'Message sent successfully!' });
            setComposing(false);
            setNewMail({ to: "", subject: "", body: "" });
            setReplyToId(null);
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
            setMessage({ type: 'success', text: 'Server settings updated' });
        } catch (error: any) {
            setMessage({ type: 'error', text: error.message || 'Failed to save settings' });
        } finally {
            setSaving(false);
        }
    };

    const handleReply = (email: Email) => {
        setReplyToId(email.id);
        const isReply = email.subject.toLowerCase().startsWith('re:');
        setNewMail({
            to: email.is_sent ? email.to_address : email.from_address,
            subject: isReply ? email.subject : `Re: ${email.subject}`,
            body: `\n\n\n--- On ${new Date(email.date_received).toLocaleString()}, ${email.from_name || email.from_address} wrote: ---\n${email.body_text}`
        });
        setComposing(true);
    };

    const deleteEmail = async (id: number) => {
        if (!confirm('Are you sure?')) return;
        try {
            await api(`/mail-server/emails/${id}`, { method: 'DELETE' });
            setEmails(emails.filter(e => e.id !== id));
            if (selectedEmail?.id === id) setSelectedEmail(null);
        } catch (error) {
            console.error("Delete failed:", error);
        }
    };

    const viewEmail = async (email: Email) => {
        setSelectedEmail(email);
        try {
            const fullEmail = await api(`/mail-server/emails/${email.id}`);
            setSelectedEmail(fullEmail);
            setEmails(emails.map(e => e.id === email.id ? { ...e, is_read: 1 } : e));
        } catch (error) {
            console.error("Fetch email failed:", error);
        }
    };

    return (
        <div className="flex h-full min-h-[calc(100vh-100px)] bg-gray-50/50 rounded-3xl overflow-hidden border border-gray-100 shadow-sm relative">
            {/* Sidebar (Gmail-like) */}
            <div className="w-64 bg-white border-r border-gray-100 p-6 flex flex-col">
                <button
                    onClick={() => setComposing(true)}
                    className="mb-8 w-full bg-blue-600 text-white py-4 rounded-2xl font-bold shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all flex items-center justify-center gap-3 text-lg"
                >
                    <i className="fa-solid fa-pencil"></i> Compose
                </button>

                <nav className="space-y-2 flex-1">
                    <SidebarItem
                        icon="fa-inbox"
                        label="Inbox"
                        active={folder === 'inbox'}
                        onClick={() => { setFolder('inbox'); setSelectedEmail(null); }}
                    />
                    <SidebarItem
                        icon="fa-paper-plane"
                        label="Sent"
                        active={folder === 'sent'}
                        onClick={() => { setFolder('sent'); setSelectedEmail(null); }}
                    />
                    {user?.role === 'administrator' && (
                        <div className="pt-8 mt-8 border-t border-gray-50">
                            <SidebarItem
                                icon="fa-screwdriver-wrench"
                                label="Server Config"
                                active={folder === 'settings'}
                                onClick={() => { setFolder('settings'); setSelectedEmail(null); }}
                            />
                        </div>
                    )}
                </nav>

                <div className="mt-auto pt-6">
                    <div className="bg-emerald-50 p-4 rounded-2xl flex items-center gap-3">
                        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                        <span className="text-xs font-bold text-emerald-700 uppercase tracking-widest">Server Active</span>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className={`flex-1 flex flex-col ${folder === 'settings' ? 'p-12 overflow-y-auto' : ''}`}>
                {folder === 'settings' ? (
                    <div className="max-w-2xl mx-auto w-full">
                        <h1 className="text-3xl font-extrabold text-gray-900 mb-8">Server Administration</h1>
                        <SettingsForm
                            settings={settings}
                            setSettings={setSettings}
                            onSave={handleSaveSettings}
                            saving={saving}
                            message={message}
                        />
                    </div>
                ) : (
                    <div className="flex h-full">
                        {/* Email List */}
                        <div className={`w-full lg:w-[400px] border-r border-gray-50 bg-white flex flex-col ${selectedEmail ? 'hidden lg:flex' : 'flex'}`}>
                            <div className="p-6 border-b border-gray-50 flex justify-between items-center bg-gray-50/30">
                                <h2 className="text-xl font-bold text-gray-800 capitalize">{folder}</h2>
                                <span className="bg-gray-100 text-gray-500 text-xs font-bold px-2 py-1 rounded-lg">{emails.length}</span>
                            </div>
                            <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
                                {loading && emails.length === 0 ? (
                                    <div className="p-8 text-center text-gray-400">Loading messages...</div>
                                ) : emails.length === 0 ? (
                                    <div className="p-12 text-center text-gray-300">
                                        <i className="fa-solid fa-folder-open text-5xl mb-4 block opacity-50"></i>
                                        Your {folder} is empty
                                    </div>
                                ) : (
                                    emails.map(email => (
                                        <EmailListItem
                                            key={email.id}
                                            email={email}
                                            selected={selectedEmail?.id === email.id}
                                            onClick={() => viewEmail(email)}
                                        />
                                    ))
                                )}
                            </div>
                        </div>

                        {/* Email Detail */}
                        <div className={`flex-1 bg-gray-50/20 flex flex-col ${selectedEmail ? 'flex' : 'hidden lg:flex items-center justify-center text-gray-400 italic'}`}>
                            {selectedEmail ? (
                                <div className="h-full flex flex-col bg-white">
                                    {/* Simple Header */}
                                    <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white z-10">
                                        <div className="flex items-center gap-4 overflow-hidden">
                                            <button onClick={() => setSelectedEmail(null)} className="lg:hidden text-gray-400 hover:text-gray-600 transition-colors">
                                                <i className="fa-solid fa-arrow-left text-lg"></i>
                                            </button>
                                            <h1 className="text-xl font-medium text-gray-900 truncate" title={selectedEmail.subject}>{selectedEmail.subject}</h1>
                                            <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs font-mono">Inbox</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => deleteEmail(selectedEmail.id)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-500 transition-all" title="Delete">
                                                <i className="fa-regular fa-trash-can"></i>
                                            </button>
                                        </div>
                                    </div>

                                    {/* Thread Stream */}
                                    <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-white">
                                        {(selectedEmail.thread && selectedEmail.thread.length > 0 ? selectedEmail.thread : [selectedEmail]).map((msg, idx) => (
                                            <div key={msg.id} className={`group transition-all ${idx === 0 ? 'pb-4 border-b border-gray-100' : ''}`}>
                                                <div className="flex items-start gap-4 mb-3">
                                                    {/* Avatar */}
                                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium text-white shadow-sm flex-shrink-0 ${msg.is_sent ? 'bg-blue-600' : 'bg-green-600'}`}>
                                                        {(msg.from_name || msg.from_address).charAt(0).toUpperCase()}
                                                    </div>

                                                    <div className="flex-1 min-w-0">
                                                        {/* Message Meta */}
                                                        <div className="flex items-baseline justify-between mb-1">
                                                            <div className="flex items-baseline gap-2 truncate">
                                                                <span className="font-bold text-gray-900 text-sm truncate">{msg.from_name || msg.from_address}</span>
                                                                <span className="text-xs text-gray-500 truncate">&lt;{msg.from_address}&gt;</span>
                                                            </div>
                                                            <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
                                                                {new Date(msg.date_received).toLocaleString()}
                                                            </span>
                                                        </div>
                                                        <div className="text-xs text-gray-500 mb-3">to me</div>

                                                        {/* Message Body */}
                                                        <div className="subpixel-antialiased text-gray-800 text-sm leading-relaxed overflow-hidden">
                                                            {msg.body_html ? (
                                                                <div className="prose prose-sm max-w-none text-gray-800" dangerouslySetInnerHTML={{ __html: msg.body_html }} />
                                                            ) : (
                                                                <div className="whitespace-pre-wrap font-sans">{msg.body_text}</div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Sticky Reply Box */}
                                    <div className="p-4 border-t border-gray-200 bg-white sticky bottom-0 z-10">
                                        <button
                                            onClick={() => handleReply(selectedEmail.thread && selectedEmail.thread.length > 0 ? selectedEmail.thread[selectedEmail.thread.length - 1] : selectedEmail)}
                                            className="w-full border border-gray-300 rounded-full py-3 px-6 text-left text-gray-500 hover:shadow-md transition-shadow flex items-center gap-3 bg-white"
                                        >
                                            <i className="fa-solid fa-reply text-gray-400"></i>
                                            <span>Reply to all...</span>
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                "Select a message to start reading"
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Premium Compose Dock (v1.4) */}
            {composing && (
                <div className={`fixed bottom-0 right-12 z-50 transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${sending ? 'opacity-80' : 'opacity-100'}`}>
                    <div className="bg-white/95 backdrop-blur-xl w-[540px] rounded-t-2xl shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.15)] border-x border-t border-gray-100 overflow-hidden flex flex-col">
                        {/* Header */}
                        <div className="px-6 py-4 bg-gray-900 flex justify-between items-center group cursor-pointer" onClick={() => setComposing(!composing)}>
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
                                <h2 className="text-sm font-bold text-white tracking-tight">New Message</h2>
                            </div>
                            <div className="flex items-center gap-4">
                                <button onClick={(e) => { e.stopPropagation(); setComposing(false); }} className="text-gray-400 hover:text-white transition-colors">
                                    <i className="fa-solid fa-minus text-xs"></i>
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); setComposing(false); }} className="text-gray-400 hover:text-white transition-colors">
                                    <i className="fa-solid fa-xmark text-sm"></i>
                                </button>
                            </div>
                        </div>

                        {/* Form */}
                        <form onSubmit={handleSend} className="flex flex-col">
                            {/* Recipients Field */}
                            <div className="px-6 py-3 border-b border-gray-50 flex items-center gap-3 group focus-within:bg-blue-50/20 transition-all relative">
                                <span className="text-xs font-bold text-gray-400 uppercase w-16">To</span>
                                <input
                                    required
                                    type="email"
                                    value={newMail.to}
                                    onChange={e => setNewMail({ ...newMail, to: e.target.value })}
                                    className="flex-1 bg-transparent border-none outline-none text-sm font-medium text-gray-800 placeholder:text-gray-300 py-1"
                                    placeholder="recipients@domain.com"
                                />
                                {searching && <i className="fa-solid fa-circle-notch fa-spin text-blue-400 text-xs"></i>}

                                {/* Autocomplete Dropdown */}
                                {suggestions.length > 0 && (
                                    <div className="absolute top-full left-16 right-6 bg-white/90 backdrop-blur-xl border border-gray-100 rounded-2xl shadow-2xl z-[60] mt-1 overflow-hidden animate-in fade-in slide-in-from-top-2">
                                        {suggestions.map((s, idx) => (
                                            <div
                                                key={idx}
                                                onClick={() => {
                                                    setNewMail({ ...newMail, to: s.email });
                                                    setSuggestions([]);
                                                }}
                                                className="px-5 py-3 hover:bg-blue-600 hover:text-white cursor-pointer transition-all flex flex-col"
                                            >
                                                <span className="text-xs font-bold uppercase opacity-60">{s.name}</span>
                                                <span className="text-sm font-medium">{s.email}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Subject Field */}
                            <div className="px-6 py-3 border-b border-gray-50 flex items-center gap-3 focus-within:bg-blue-50/20 transition-all">
                                <span className="text-xs font-bold text-gray-400 uppercase w-16">Subject</span>
                                <input
                                    required
                                    type="text"
                                    value={newMail.subject}
                                    onChange={e => setNewMail({ ...newMail, subject: e.target.value })}
                                    className="flex-1 bg-transparent border-none outline-none text-sm font-semibold text-gray-900 placeholder:text-gray-300 py-1"
                                    placeholder="Brief summary of your message"
                                />
                            </div>

                            {/* Body Textarea */}
                            <div className="px-6 py-4 relative">
                                <textarea
                                    required
                                    rows={12}
                                    value={newMail.body}
                                    onChange={e => setNewMail({ ...newMail, body: e.target.value })}
                                    className="w-full bg-transparent border-none outline-none text-[15px] leading-relaxed text-gray-700 placeholder:text-gray-300 resize-none min-h-[300px]"
                                    placeholder="Compose your thoughts here..."
                                />

                                {/* Fake Formatting Toolbar (Aesthetics) */}
                                <div className="absolute bottom-6 left-6 right-6 flex items-center justify-between pointer-events-none opacity-30">
                                    <div className="flex gap-4">
                                        <i className="fa-solid fa-bold"></i>
                                        <i className="fa-solid fa-italic"></i>
                                        <i className="fa-solid fa-link"></i>
                                        <i className="fa-solid fa-image"></i>
                                    </div>
                                    <i className="fa-solid fa-ellipsis-vertical"></i>
                                </div>
                            </div>

                            {/* Footer Actions */}
                            <div className="px-6 py-5 bg-gray-50/80 border-t border-gray-100 flex items-center justify-between gap-4">
                                <div className="flex gap-2">
                                    <button
                                        type="submit"
                                        disabled={sending}
                                        className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-bold transition-all shadow-lg shadow-blue-200 disabled:opacity-50 flex items-center gap-3 active:scale-95 translate-y-0 hover:-translate-y-0.5"
                                    >
                                        {sending ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-paper-plane text-xs"></i>}
                                        {sending ? "Sending..." : "Send Message"}
                                    </button>

                                    <button type="button" className="w-12 h-12 flex items-center justify-center text-gray-400 hover:bg-white hover:text-gray-600 rounded-xl transition-all">
                                        <i className="fa-solid fa-paperclip"></i>
                                    </button>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => setComposing(false)}
                                    className="px-4 py-3 text-gray-400 hover:text-red-500 font-bold text-xs uppercase tracking-widest transition-all hover:bg-red-50 rounded-xl"
                                >
                                    Discard
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

function SidebarItem({ icon, label, active, onClick }: { icon: string, label: string, active: boolean, onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className={`w-full flex items-center justify-between px-6 py-4 rounded-2xl font-bold transition-all ${active ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'}`}
        >
            <div className="flex items-center gap-4">
                <i className={`fa-solid ${icon} text-lg`}></i>
                {label}
            </div>
            {active && <div className="w-1.5 h-1.5 bg-blue-600 rounded-full"></div>}
        </button>
    );
}

function EmailListItem({ email, selected, onClick }: { email: Email, selected: boolean, onClick: () => void }) {
    const displayLabel = email.is_sent
        ? `To: ${email.to_address}`
        : (email.from_name || email.from_address);

    return (
        <div
            onClick={onClick}
            className={`p-6 cursor-pointer border-l-4 transition-all ${selected ? 'bg-blue-50/30 border-blue-600' : 'border-transparent hover:bg-gray-50/50'} ${!email.is_read && !email.is_sent ? 'font-bold' : ''}`}
        >
            <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2 max-w-[180px]">
                    <span className="text-sm text-gray-900 truncate">{displayLabel}</span>
                    {email.thread_count && email.thread_count > 1 && (
                        <span className="bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap">
                            {email.thread_count}
                        </span>
                    )}
                </div>
                <span className="text-[10px] font-bold text-gray-400 uppercase">{new Date(email.date_received).toLocaleDateString()}</span>
            </div>
            <h3 className="text-sm text-gray-700 truncate mb-1">{email.subject}</h3>
            <p className="text-xs text-gray-400 truncate opacity-80">{email.body_text?.substring(0, 60)}...</p>
        </div>
    );
}

function SettingsForm({ settings, setSettings, onSave, saving, message }: any) {
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const res = await api('/mail-server/test', { method: 'POST' });
            setTestResult("✅ " + res.message);
        } catch (error: any) {
            setTestResult("❌ " + error.message);
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="space-y-8">
            {message && (
                <div className={`p-4 rounded-2xl flex items-center gap-3 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
                    <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}`}></i>
                    {message.text}
                </div>
            )}

            <div className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100 space-y-6">
                <h3 className="text-lg font-bold text-gray-800">Server Configuration</h3>
                <form onSubmit={onSave} className="space-y-6">
                    <div className="grid grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-500 uppercase">Listen Port (Inbound)</label>
                            <input
                                type="text"
                                value={settings.smtp_listen_port}
                                onChange={e => setSettings({ ...settings, smtp_listen_port: e.target.value })}
                                className="w-full px-5 py-3 bg-gray-50 border border-gray-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-100"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-500 uppercase">Catch-All</label>
                            <select
                                value={settings.smtp_catch_all}
                                onChange={e => setSettings({ ...settings, smtp_catch_all: e.target.value })}
                                className="w-full px-5 py-3 bg-gray-50 border border-gray-200 rounded-2xl outline-none"
                            >
                                <option value="0">Disabled</option>
                                <option value="1">Enabled</option>
                            </select>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-500 uppercase">Default "From" Name</label>
                        <input
                            type="text"
                            value={settings.mail_from_name}
                            onChange={e => setSettings({ ...settings, mail_from_name: e.target.value })}
                            className="w-full px-5 py-3 bg-gray-50 border border-gray-200 rounded-2xl outline-none"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={saving}
                        className="w-full bg-gray-900 text-white py-4 rounded-2xl font-bold hover:bg-black transition-all flex items-center justify-center gap-2"
                    >
                        {saving ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-floppy-disk"></i>}
                        Update Server Topology
                    </button>
                </form>
            </div>

            {/* DNS Setup Guide */}
            <div className="bg-blue-600 rounded-3xl p-8 text-white relative overflow-hidden">
                <i className="fa-solid fa-cloud-arrow-up absolute -bottom-4 -right-4 text-white/5 text-[150px]"></i>
                <h3 className="text-xl font-bold mb-4 flex items-center gap-3">
                    <i className="fa-solid fa-circle-info"></i> DNS Setup Required for Direct Send
                </h3>

                <div className="space-y-6">
                    <div className="space-y-2">
                        <p className="text-xs font-bold text-blue-200 uppercase tracking-widest">1. PTR Record (Reverse DNS)</p>
                        <p className="text-sm">Crucial for Gmail/Outlook. In your Hostinger panel, set your VPS IP PTR to point to your main domain.</p>
                    </div>

                    <div className="space-y-2">
                        <p className="text-xs font-bold text-blue-200 uppercase tracking-widest">2. SPF Record (TXT)</p>
                        <p className="text-sm mb-2">Add this TXT record to your DNS to authorize your VPS to send mail:</p>
                        <code className="block bg-white/10 px-4 py-3 rounded-xl text-xs font-mono break-all">
                            v=spf1 ip4:YOUR_VPS_IP ~all
                        </code>
                    </div>

                    <div className="space-y-2">
                        <p className="text-xs font-bold text-blue-200 uppercase tracking-widest">3. MX Record</p>
                        <p className="text-sm">To receive mail, ensure your domain has an MX record pointing to your VPS IP or Hostname.</p>
                    </div>

                    <div className="pt-6 border-t border-white/10 flex flex-col gap-4">
                        <p className="text-sm font-bold">Verification Tool:</p>
                        <button
                            onClick={handleTest}
                            disabled={testing}
                            className="w-full bg-white text-blue-600 py-4 rounded-2xl font-bold hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
                        >
                            {testing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-vial"></i>}
                            {testing ? "Sending Handshake..." : "Test Direct Send Delivery"}
                        </button>
                        {testResult && (
                            <div className="p-4 bg-white/10 rounded-2xl text-xs font-mono animate-in fade-in slide-in-from-top-2">
                                {testResult}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
