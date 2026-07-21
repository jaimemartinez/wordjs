"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { usersApi } from "@/lib/api";
import MfaSetup from "@/components/MfaSetup";

// Self-service account page — reachable by EVERY logged-in user (cap 'read'), including subscribers
// who have no access to the admin Users editor. Lets any user update their profile + personal/recovery
// email and change their own password (verifying the current one).
export default function AccountPage() {
    const { user, logout } = useAuth();
    const { addToast } = useToast();
    const { t } = useI18n();
    const router = useRouter();

    const [displayName, setDisplayName] = useState("");
    const [personalEmail, setPersonalEmail] = useState("");
    const [savingProfile, setSavingProfile] = useState(false);

    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [changingPw, setChangingPw] = useState(false);

    useEffect(() => {
        if (user) {
            setDisplayName(user.displayName || "");
            setPersonalEmail(user.personalEmail || "");
        }
    }, [user]);

    const saveProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingProfile(true);
        try {
            await usersApi.updateMe({ displayName, personalEmail });
            addToast(t('account.profileUpdated'), "success");
        } catch (err: any) {
            addToast(err?.message || t('account.profileError'), "error");
        } finally {
            setSavingProfile(false);
        }
    };

    const changePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (newPassword.length < 8) { addToast(t('account.pwTooShort'), "error"); return; }
        if (newPassword !== confirmPassword) { addToast(t('account.pwMismatch'), "error"); return; }
        setChangingPw(true);
        try {
            await usersApi.updateMe({ currentPassword, password: newPassword });
            // Changing the password revokes all sessions (token_valid_after) — sign out and re-login.
            addToast(t('account.pwChanged'), "success");
            setTimeout(() => { logout(); router.replace("/login"); }, 900);
        } catch (err: any) {
            addToast(err?.message || t('account.pwError'), "error");
            setChangingPw(false);
        }
    };

    const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
    const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
    const btnCls = "px-6 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg shadow-gray-200 hover:shadow-blue-500/30 transition-all disabled:opacity-50";
    const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8";

    const initials = (user?.displayName || user?.username || "?").trim().charAt(0).toUpperCase();

    return (
        // Root must own its scroll: the admin <main> is overflow-hidden, so a page that just
        // stacks tall content would get clipped (no scroll). h-full + overflow-y-auto fixes it.
        <div className="h-full overflow-y-auto bg-gray-50/50">
            <div className="max-w-6xl mx-auto p-4 sm:p-8 lg:p-10">
                {/* Header */}
                <div className="mb-8">
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">{t('account.title')}</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1 break-words">
                        {user?.username} · {user?.email}
                    </p>
                </div>

                {/* Identity sidebar + content — two columns fill the width instead of a lone narrow column */}
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)] gap-6 lg:gap-8 items-start">
                    {/* Identity summary (sticky on desktop) */}
                    <aside className={`${cardCls} lg:sticky lg:top-4`}>
                        <div className="flex flex-col items-center text-center">
                            <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center text-3xl font-black shadow-lg shadow-blue-500/30">
                                {initials}
                            </div>
                            <h2 className="mt-4 text-lg font-black text-gray-900 tracking-tight break-words">{user?.displayName || user?.username}</h2>
                            <span className="mt-1.5 inline-block text-[10px] font-black uppercase tracking-widest text-blue-600 bg-blue-50 px-3 py-1 rounded-full">
                                {user?.role}
                            </span>
                        </div>
                        <div className="mt-6 pt-6 border-t border-gray-100 space-y-4">
                            <div>
                                <p className={labelCls}>{t('account.title')}</p>
                                <p className="text-sm font-medium text-gray-700 break-words">@{user?.username}</p>
                            </div>
                            <div>
                                <p className={labelCls}>Email</p>
                                <p className="text-sm font-medium text-gray-700 break-words">{user?.email}</p>
                            </div>
                        </div>
                    </aside>

                    {/* Content column */}
                    <div className="space-y-6 lg:space-y-8 min-w-0">
                        {/* Profile + Change password side by side on wide screens */}
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 lg:gap-8 items-start">
                            {/* Profile */}
                            <form onSubmit={saveProfile} className={`${cardCls} space-y-5`}>
                                <h2 className="font-bold text-gray-800">{t('account.profile')}</h2>
                                <div>
                                    <label className={labelCls}>{t('account.displayName')}</label>
                                    <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} />
                                </div>
                                <div>
                                    <label className={labelCls}>{t('account.personalEmail')}</label>
                                    <input type="email" value={personalEmail} onChange={(e) => setPersonalEmail(e.target.value)} placeholder="name@gmail.com" className={inputCls} />
                                    <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">{t('account.personalEmail.help')}</p>
                                </div>
                                <div className="flex justify-end">
                                    <button type="submit" disabled={savingProfile} className={btnCls}>{savingProfile ? t('account.saving') : t('account.saveProfile')}</button>
                                </div>
                            </form>

                            {/* Change password */}
                            <form onSubmit={changePassword} className={`${cardCls} space-y-5`}>
                                <h2 className="font-bold text-gray-800">{t('account.changePassword')}</h2>
                                <div>
                                    <label className={labelCls}>{t('account.currentPassword')}</label>
                                    <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required className={inputCls} />
                                </div>
                                <div>
                                    <label className={labelCls}>{t('account.newPassword')}</label>
                                    <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required className={inputCls} />
                                    <p className="text-[11px] text-gray-400 mt-2">{t('account.newPassword.help')}</p>
                                </div>
                                <div>
                                    <label className={labelCls}>{t('account.confirmPassword')}</label>
                                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required className={inputCls} />
                                </div>
                                <div className="flex justify-end">
                                    <button type="submit" disabled={changingPw} className={btnCls}>{changingPw ? t('account.changing') : t('account.changePassword')}</button>
                                </div>
                            </form>
                        </div>

                        {/* MFA */}
                        <MfaSetup />
                    </div>
                </div>
            </div>
        </div>
    );
}
