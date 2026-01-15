"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import Link from "next/link";

interface Notification {
    uuid: string;
    type: string;
    title: string;
    message: string;
    is_read: number;
    created_at: string;
    icon?: string;
    color?: string;
    action_url?: string;
}

interface NotificationCenterProps {
    variant?: 'floating' | 'inline';
    isCollapsed?: boolean;
}

export default function NotificationCenter({ variant = 'floating', isCollapsed = false }: NotificationCenterProps) {
    const { token, user } = useAuth();
    const { addToast } = useToast();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const eventSourceRef = useRef<EventSource | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const API_URL = '/api/v1';

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Fetch initial notifications
    const fetchNotifications = async (silent = false) => {
        if (!token) return;
        if (!silent) setIsRefreshing(true);
        try {
            const res = await fetch(`${API_URL}/notifications`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                setNotifications(data);
                setUnreadCount(data.filter((n: Notification) => n.is_read === 0).length);
            }
        } catch (error) {
            console.error("Fetch notifications error:", error);
        } finally {
            if (!silent) setIsRefreshing(false);
        }
    };

    useEffect(() => {
        fetchNotifications(true);
    }, [token]);

    // Real-time stream
    useEffect(() => {
        if (!token || !user) return;

        const connectStream = () => {
            const url = `${API_URL}/notifications/stream?token=${token}`;
            const es = new EventSource(url);
            eventSourceRef.current = es;

            es.onmessage = (event) => {
                const newNotification = JSON.parse(event.data);
                setNotifications(prev => {
                    const exists = prev.some(n => n.uuid === newNotification.uuid);
                    if (exists) return prev;
                    return [newNotification, ...prev];
                });
                setUnreadCount(prev => prev + 1);
                addToast(newNotification.title || "New Notification", "info");

                // Dispatch global event for other components to react (e.g. Inbox refresh)
                window.dispatchEvent(new CustomEvent('wordjs:notification', { detail: newNotification }));

                if ("vibrate" in navigator) {
                    navigator.vibrate(100);
                }
            };

            es.onerror = () => {
                console.warn("SSE Connection lost. Reconnecting in 5s...");
                es.close();
                setTimeout(connectStream, 5000);
            };
        };

        connectStream();

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
        };
    }, [token, user]);

    const markAsRead = async (uuid: string) => {
        try {
            const res = await fetch(`${API_URL}/notifications/${uuid}/read`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                setNotifications(prev =>
                    prev.map(n => n.uuid === uuid ? { ...n, is_read: 1 } : n)
                );
                setUnreadCount(prev => Math.max(0, prev - 1));
            }
        } catch (error) {
            console.error("Mark as read error:", error);
        }
    };

    const markAllRead = async () => {
        try {
            const res = await fetch(`${API_URL}/notifications/read-all`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
                setUnreadCount(0);
                addToast("All notifications marked as read", "success");
            }
        } catch (error) {
            console.error("Mark all read error:", error);
        }
    };

    const getIcon = (n: Notification) => {
        if (n.icon) return n.icon;
        switch (n.type) {
            case 'success': return 'fa-circle-check';
            case 'warning': return 'fa-triangle-exclamation';
            case 'error': return 'fa-circle-xmark';
            default: return 'fa-circle-info';
        }
    };

    const getColorStyles = (n: Notification) => {
        if (n.color) {
            // Support simple colors like 'blue', 'green', 'rose', 'amber'
            const base = n.color;
            return `text-${base}-500 bg-${base}-50/50`;
        }
        switch (n.type) {
            case 'success': return 'text-emerald-500 bg-emerald-50/50';
            case 'warning': return 'text-amber-500 bg-amber-50/50';
            case 'error': return 'text-rose-500 bg-rose-50/50';
            default: return 'text-blue-500 bg-blue-50/50';
        }
    };

    const buttonClasses = variant === 'floating'
        ? `w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500
           shadow-[0_10px_40px_-10px_rgba(59,130,246,0.5)]
           hover:shadow-[0_20px_50px_-10px_rgba(59,130,246,0.6)]
           hover:-translate-y-1 active:scale-90 relative group
           ${isOpen
            ? 'bg-gradient-to-br from-gray-800 to-black text-white'
            : 'bg-gradient-to-br from-indigo-500 via-blue-600 to-blue-700 text-white'
        }`
        : `w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-300
           ${isOpen ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 z-[10001]' : 'bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/10 text-gray-400 hover:text-white'}
           relative group`;

    const panelClasses = variant === 'floating'
        ? "absolute bottom-20 right-0 w-[420px] max-h-[640px] flex flex-col bg-white/95 backdrop-blur-xl rounded-[40px] border border-white/40 shadow-[0_40px_100px_-20px_rgba(0,0,0,0.2)] overflow-hidden animate-in fade-in zoom-in-95 slide-in-from-bottom-10 duration-500 ease-out origin-bottom-right z-[100]"
        : `fixed top-2 bottom-2 left-2 right-2 md:top-6 md:bottom-6 md:right-auto md:ml-6 md:w-[420px] flex flex-col bg-white/98 backdrop-blur-3xl rounded-[32px] md:rounded-[40px] border border-gray-100/50 shadow-[0_30px_90px_-20px_rgba(0,0,0,0.18)] overflow-hidden animate-in fade-in slide-in-from-left-6 md:slide-in-from-left-6 duration-400 cubic-bezier(0.16, 1, 0.3, 1) z-[9999] ${isCollapsed ? "md:left-24" : "md:left-80"}`;

    return (
        <div
            ref={containerRef}
            className={variant === 'floating' ? "fixed bottom-8 right-8 z-[100]" : "relative"}
        >
            {isOpen && variant === 'inline' && (
                <div className="fixed inset-0 bg-black/10 backdrop-blur-[1px] z-[9998]" onClick={() => setIsOpen(false)}></div>
            )}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`${buttonClasses} ${isOpen ? 'hidden md:flex' : 'flex'}`}
                title={variant === 'inline' ? "Notifications" : undefined}
            >
                <div className="absolute inset-0 rounded-full bg-white opacity-0 group-hover:opacity-10 transition-opacity"></div>
                {isOpen ? (
                    <i className={`fa-solid fa-xmark animate-in spin-in duration-300 ${variant === 'floating' ? 'text-xl' : 'text-base'}`}></i>
                ) : (
                    <i className={`fa-solid fa-bell ${unreadCount > 0 ? 'animate-bounce-slow' : ''} ${variant === 'floating' ? 'text-2xl' : 'text-base'}`}></i>
                )}
                {unreadCount > 0 && (
                    <span className={`absolute -top-1 -right-1 flex ${variant === 'floating' ? 'h-6 w-6' : 'h-4 w-4'}`}>
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                        <span className={`relative inline-flex rounded-full bg-rose-500 text-white font-bold items-center justify-center border-2 border-white ${variant === 'floating' ? 'h-6 w-6 text-[10px]' : 'h-4 w-4 text-[7px]'}`}>
                            {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                    </span>
                )}
            </button>

            {isOpen && (
                <div className={panelClasses}>
                    <div className="px-10 py-8 flex items-center justify-between bg-white/50 border-b border-gray-50/50 flex-shrink-0">
                        <div className="flex flex-col gap-1">
                            <h3 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-3">
                                Notifications
                                {unreadCount > 0 && (
                                    <span className="flex h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"></span>
                                )}
                            </h3>
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-[0.15em]">
                                {unreadCount > 0 ? `${unreadCount} new messages` : 'Up to date'}
                            </p>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={markAllRead}
                                title="Mark all as read"
                                className="w-11 h-11 flex items-center justify-center rounded-2xl text-gray-400 hover:text-blue-600 hover:bg-blue-50/50 transition-all active:scale-95 group"
                            >
                                <i className="fa-solid fa-check-double text-sm transition-transform group-hover:scale-110"></i>
                            </button>
                            <button
                                onClick={() => fetchNotifications()}
                                title="Refresh"
                                className={`w-11 h-11 flex items-center justify-center rounded-2xl text-gray-400 hover:text-blue-600 hover:bg-blue-50/50 transition-all active:scale-95 group ${isRefreshing ? 'animate-spin text-blue-500' : ''}`}
                            >
                                <i className="fa-solid fa-arrows-rotate text-sm transition-transform group-hover:rotate-45"></i>
                            </button>
                            {variant === 'inline' && (
                                <button
                                    onClick={() => setIsOpen(false)}
                                    className="w-11 h-11 flex items-center justify-center rounded-2xl bg-gray-50 text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all active:scale-95 border border-gray-100/50 shadow-sm"
                                    title="Close"
                                >
                                    <i className="fa-solid fa-xmark text-lg"></i>
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto px-6 py-6 custom-scrollbar">
                        {notifications.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-center px-10">
                                <div className="relative mb-10">
                                    <div className="w-32 h-32 bg-gradient-to-tr from-gray-50 to-white rounded-[40px] shadow-sm flex items-center justify-center relative z-10">
                                        <i className="fa-solid fa-bell-slash text-5xl text-gray-200"></i>
                                    </div>
                                    <div className="absolute -inset-4 bg-blue-50/30 rounded-[48px] blur-2xl -z-0"></div>
                                </div>
                                <h4 className="text-xl font-black text-gray-900 mb-2">You're all set!</h4>
                                <p className="text-sm text-gray-400 font-medium leading-relaxed italic">
                                    There are no new notifications to display right now. Check back later!
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {notifications.map((n) => {
                                    const Content = (
                                        <div
                                            className={`
                                                    p-6 rounded-[32px] transition-all cursor-pointer group relative
                                                    ${n.is_read
                                                    ? 'opacity-60 grayscale-[0.2] hover:opacity-100 hover:bg-gray-50/50'
                                                    : 'bg-white shadow-[0_10px_30px_-10px_rgba(0,0,0,0.04)] border border-gray-100/50 hover:shadow-[0_20px_40px_-10px_rgba(0,0,0,0.08)] hover:-translate-y-1'
                                                }
                                                `}
                                            onClick={() => !n.is_read && markAsRead(n.uuid)}
                                        >
                                            <div className="flex gap-5">
                                                <div className="shrink-0">
                                                    <div className={`w-14 h-14 rounded-[22px] flex items-center justify-center text-xl shadow-inner ${getColorStyles(n)}`}>
                                                        <i className={`fa-solid ${getIcon(n)}`}></i>
                                                    </div>
                                                </div>
                                                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                                                    <div className="flex items-start justify-between gap-4">
                                                        <span className={`text-[17px] leading-tight transition-colors ${n.is_read ? 'font-medium text-gray-600' : 'font-black text-gray-900 group-hover:text-blue-600'}`}>
                                                            {n.title}
                                                        </span>
                                                        <span className="text-[11px] font-black text-gray-300 uppercase tracking-tighter pt-1">
                                                            {new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                    </div>
                                                    <p className="text-[14px] text-gray-500 font-medium leading-relaxed line-clamp-2">
                                                        {n.message}
                                                    </p>
                                                </div>
                                            </div>
                                            {!n.is_read && (
                                                <div className="absolute right-6 top-1/2 -translate-y-1/2">
                                                    <div className="w-3 h-3 bg-blue-600 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.8)]"></div>
                                                </div>
                                            )}
                                        </div>
                                    );

                                    return n.action_url ? (
                                        <Link key={n.uuid} href={n.action_url} className="block no-underline">
                                            {Content}
                                        </Link>
                                    ) : (
                                        <div key={n.uuid}>{Content}</div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {notifications.length > 0 && (
                        <div className="px-10 py-8 bg-gray-50/30 flex items-center justify-center border-t border-gray-50/50">
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.25em]">
                                Notification History Ends Here
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
