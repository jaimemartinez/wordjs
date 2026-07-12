"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { usersApi } from "@/lib/api";

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

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">{t('account.title')}</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1 break-words">
                    {user?.username} · {user?.email}
                </p>
            </div>

            {/* Profile */}
            <form onSubmit={saveProfile} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 mb-8 space-y-5">
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
            <form onSubmit={changePassword} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 space-y-5">
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
    );
}
