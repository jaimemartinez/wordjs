"use client";

import { useState, useEffect, useId, useRef } from "react";
import { useDialogFocus } from "@/components/useDialogFocus";
import { usersApi, User, userSaveErrorText } from "@/lib/api";
import ModernSelect from "@/components/ModernSelect";
import DialogLayer from "@/components/DialogLayer";
import { PluginHook, pluginHooks } from "@/lib/plugin-hooks";
import { useModal } from "@/contexts/ModalContext";
import UserMfaReset from "./UserMfaReset";
import AccountCapabilityToggles, { grantedMap } from "./AccountCapabilityToggles";
import { useRoleOptions } from "@/lib/useRoleOptions";
import { useI18n } from "@/contexts/I18nContext";

/**
 * A field label of this dialog. gray-500 (4.8:1 on white): the labels and the helper text were gray-400,
 * 2.6:1, under WCAG AA. Exported for the unit test.
 */
export const FIELD_LABEL = "block text-[11px] font-black uppercase tracking-widest text-gray-500 mb-2";
export const HELP_TEXT = "text-[11px] text-gray-600 mt-2 leading-relaxed";

interface UserFormModalProps {
    user: User | "new" | null;
    onClose: () => void;
    onSuccess: () => void;
}

export default function UserFormModal({ user, onClose, onSuccess }: UserFormModalProps) {
    const isNew = user === "new";
    const panelRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    // A modal dialog: focus moves in, Tab stays in, Escape closes, focus returns to "New user".
    useDialogFocus(panelRef, { open: !!user, onClose });
    const userId = isNew ? null : (user as User).id;

    const [formData, setFormData] = useState<{
        username: string; email: string; displayName: string; role: string;
        password: string; personalEmail: string; accountCapabilities?: Record<string, boolean>;
    }>({
        username: "",
        email: "",
        displayName: "",
        role: "subscriber",
        password: "",
        personalEmail: "",
        // PLUGIN-DECLARED ACCOUNT CAPABILITIES — the admin-owned per-account grants, one toggle each
        // (AccountCapabilityToggles), carried in the form data and submitted with it. The backend writes
        // only what CHANGED, and only for an `edit_users` caller.
        accountCapabilities: {},
    });
    const [saving, setSaving] = useState(false);
    const [, setHookTick] = useState(0);

    const { alert } = useModal();
    const { t } = useI18n();
    // Every role the site has (core, custom, plugin-provided), grouped — not a hardcoded four.
    const roleOptions = useRoleOptions(user && user !== "new" ? user.role : undefined);

    useEffect(() => {
        if (user && user !== "new") {
            setFormData({
                username: user.username,
                email: user.email,
                displayName: user.displayName || "",
                role: user.role,
                password: "", // Don't load password
                personalEmail: user.personalEmail || "",
                accountCapabilities: grantedMap(user.accountCapabilities),
            });
        }
        // Listen for plugin hook changes
        return pluginHooks.subscribe(() => setHookTick(t => t + 1));
    }, [user]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        // The server's rule (8 characters, every password it writes): said before the round trip.
        if (formData.password && formData.password.length < 8) {
            await alert(t('account.pwTooShort'));
            return;
        }
        setSaving(true);

        try {
            if (userId && user !== "new") {
                await usersApi.update(userId, formData);
            } else {
                await usersApi.create(formData);
            }
            onSuccess();
            onClose();
        } catch (error) {
            console.error("Failed to save user:", error);
            await alert(userSaveErrorText(error, t));
        } finally {
            setSaving(false);
        }
    };

    if (!user) return null;

    return (
        // Above the admin shell (components/DialogLayer.tsx): on a phone it opened UNDER the header, its
        // title and close button cut off. 90dvh, not 90vh: on iOS vh is the toolbar-less height, taller
        // than what is visible, and the footer (Save) started below the screen.
        <DialogLayer className="flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-3xl md:rounded-[40px] shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 border border-white/20">
                {/* Header */}
                <div className="p-8 pb-0 flex justify-between items-start">
                    <div>
                        <h2 id={titleId} className="text-3xl font-black text-gray-900 italic tracking-tighter mb-2">
                            {isNew ? t('user.edit.titleNew') : t('user.edit.titleEdit')}
                        </h2>
                        <p className="text-xs font-bold uppercase tracking-widest text-gray-500">
                            {isNew ? t('user.edit.subtitleNew') : t('user.edit.subtitleEditing').replace('{username}', (user as User).username)}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('common.close')}
                        className="w-10 h-10 shrink-0 rounded-full bg-gray-50 text-gray-500 hover:bg-gray-100 hover:text-gray-600 flex items-center justify-center transition-colors"
                    >
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>

                <div className="p-8 overflow-y-auto">
                    {/* The browser's own "required" bubble speaks the BROWSER's language; this one speaks the admin's. */}
                    <form
                        id="user-form"
                        onSubmit={handleSubmit}
                        onInvalidCapture={(e) => {
                            const field = e.target as HTMLInputElement;
                            if (field.validity?.valueMissing) field.setCustomValidity(t('form.required'));
                        }}
                        onInputCapture={(e) => (e.target as HTMLInputElement).setCustomValidity?.("")}
                        className="space-y-6"
                    >
                        <div>
                            <label htmlFor="user-form-field-1" className={FIELD_LABEL}>{t('user.edit.username')}</label>
                            <input id="user-form-field-1"
                                type="text"
                                value={formData.username}
                                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                disabled={!isNew}
                                className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium disabled:opacity-50"
                                required
                            />
                        </div>
                        <AccountCapabilityToggles
                            value={formData.accountCapabilities}
                            onChange={(next) => setFormData((prev) => ({ ...prev, accountCapabilities: next }))}
                            isNew={isNew}
                        />
                        <PluginHook name="user_form_before_email" data={{ formData, setFormData, isNew }} />
                        <div>
                            <label htmlFor="user-form-field-2" className={FIELD_LABEL}>{t('user.edit.email')}</label>
                            <input id="user-form-field-2"
                                type="email"
                                value={formData.email}
                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                {...pluginHooks.applyFilters('user_form_email_input_props', {
                                    className: "w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium",
                                    required: true,
                                    readOnly: false
                                }, { formData, isNew })}
                            />
                        </div>
                        <div>
                            <label htmlFor="user-form-field-3" className={FIELD_LABEL}>{t('user.edit.personalEmail')}</label>
                            <input id="user-form-field-3"
                                type="email"
                                value={formData.personalEmail}
                                onChange={(e) => setFormData({ ...formData, personalEmail: e.target.value })}
                                placeholder="name@gmail.com"
                                className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                            />
                            <p className={HELP_TEXT}>{t('user.edit.personalEmail.help')}</p>
                        </div>
                        <div>
                            <label htmlFor="user-form-field-4" className={FIELD_LABEL}>{t('user.edit.displayName')}</label>
                            <input id="user-form-field-4"
                                type="text"
                                value={formData.displayName}
                                onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                                className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                            />
                        </div>
                        <ModernSelect
                            label={t('user.edit.role')}
                            value={formData.role}
                            onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                            options={roleOptions}
                        />
                        <div>
                            <label htmlFor="user-form-field-5" className={FIELD_LABEL}>
                                {isNew ? t('user.edit.password') : t('user.edit.newPassword')}
                            </label>
                            <input id="user-form-field-5"
                                type="password"
                                value={formData.password}
                                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                className="w-full px-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                                required={isNew}
                            />
                        </div>
                    </form>

                    {/* Outside the <form>: this acts on the SAVED account immediately, it is not part of
                        the pending edit that "Save User" submits. */}
                    {!isNew && userId != null && (
                        <UserMfaReset userId={userId} username={(user as User).username} targetRole={(user as User).role} />
                    )}
                </div>

                <div className="p-6 border-t border-gray-100 bg-gray-50/30 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-6 py-3 border-2 border-gray-100 rounded-2xl hover:bg-gray-50 text-gray-600 font-bold text-xs uppercase tracking-widest transition-all"
                    >
                        {t('user.edit.cancel')}
                    </button>
                    <button
                        type="submit"
                        form="user-form"
                        disabled={saving}
                        className="px-8 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transform hover:-translate-y-1 transition-all disabled:opacity-50"
                    >
                        {saving ? t('user.edit.saving') : t('user.edit.save')}
                    </button>
                </div>
            </div>
        </DialogLayer>
    );
}
