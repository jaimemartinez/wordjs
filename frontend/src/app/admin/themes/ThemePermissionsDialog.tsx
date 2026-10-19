"use client";

import { useState } from "react";
import type { ThemePermissions } from "@/lib/api";
import DialogLayer from "@/components/DialogLayer";
import { permMeta } from "@/lib/permissionMeta";
import { useI18n } from "@/contexts/I18nContext";
import BreakableToken from "../plugins/BreakableToken";
import { RiskBadge, TOKEN_CLASS, REASON_LABEL_CLASS, PERMISSION_TOGGLE_CLASS, PERMISSION_DETAILS_CLASS } from "../plugins/PermissionRow";

/**
 * Which permissions the dialog starts with switched on. An administrator who already decided this theme's
 * grants on this site sees that decision (a revoke stays a revoke when the theme is activated again);
 * otherwise every permission the theme may hold starts on, as the plugin activation dialog grants what the
 * plugin asks for. Either way nothing is stored until the administrator confirms, and only what is on then.
 */
export function initialThemeGrants(data: Pick<ThemePermissions, "declared" | "granted" | "decided">): Set<string> {
    if (data.decided) return new Set(data.granted.filter((t) => data.declared.some((r) => r.token === t && r.grantable)));
    return new Set(data.declared.filter((r) => r.grantable).map((r) => r.token));
}

/**
 * The theme permissions dialog, in the plugins' shape (app/admin/plugins: the activation consent and the
 * Permissions dialog): every permission the theme's functions.js declares in theme.json, with the theme's
 * own reason, the platform's description and risk, and a switch. `mode` "activate" confirms an activation
 * with the switched-on set; "manage" saves the set for a theme already installed.
 */
export default function ThemePermissionsDialog({ themeName, data, mode, busy, onCancel, onConfirm }: {
    themeName: string;
    data: ThemePermissions;
    mode: "activate" | "manage";
    busy: boolean;
    onCancel: () => void;
    onConfirm: (granted: string[]) => void;
}) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<Set<string>>(() => initialThemeGrants(data));
    const toggle = (token: string) => setDraft((prev) => {
        const next = new Set(prev);
        if (next.has(token)) next.delete(token); else next.add(token);
        return next;
    });
    const problemText = (problem?: string) =>
        problem === "not_available_to_themes" ? t("themes.permissions.notAvailable")
            : problem === "not_available_on_this_site" ? t("themes.permissions.notOnThisSite")
                : t("themes.permissions.invalid");

    return (
        <DialogLayer className="bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300">
            <div role="dialog" aria-modal="true" aria-labelledby="theme-permissions-title" data-theme-permissions-dialog={mode}
                className="bg-white/95 backdrop-blur-lg rounded-[32px] max-w-lg w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 max-h-[85dvh] flex flex-col">
                <div className="p-8 pb-4 flex-shrink-0">
                    <div className="flex items-center gap-4 text-blue-600">
                        <div className="w-14 h-14 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0 text-blue-600 shadow-sm">
                            <i className="fa-solid fa-palette text-xl" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h3 id="theme-permissions-title" className="text-xl font-extrabold text-slate-900">{t("themes.permissions.title")}</h3>
                            <p className="text-xs text-slate-500 font-semibold mt-0.5 break-words">{themeName}</p>
                        </div>
                    </div>
                </div>
                <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
                    <p className="mb-4 text-slate-600 text-xs font-semibold leading-relaxed">
                        {mode === "activate" ? t("themes.permissions.activateIntro") : t("themes.permissions.manageIntro")}
                    </p>
                    {data.logic && (data.logic.state === "blocked" || data.logic.state === "error") && (
                        <p className="mb-4 p-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs font-semibold leading-relaxed" role="note" data-theme-logic={data.logic.state}>
                            <i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true" />
                            {t("themes.permissions.blocked")} {data.logic.reason}
                        </p>
                    )}
                    <div className="space-y-2 mb-4">
                        {data.declared.map((row) => {
                            const meta = permMeta(row.token, t);
                            const on = row.grantable && draft.has(row.token);
                            const highRisk = meta.risk === "high";
                            const activeClasses = highRisk ? "bg-rose-50/80 border-rose-200/70 shadow-sm" : meta.risk === "med" ? "bg-amber-50/80 border-amber-200/70 shadow-sm" : "bg-emerald-50/85 border-emerald-200/70 shadow-sm";
                            const knobOn = highRisk ? "bg-rose-500" : meta.risk === "med" ? "bg-amber-500" : "bg-emerald-500";
                            return (
                                <div key={row.token} className={`rounded-2xl border transition-all duration-300 ${on ? activeClasses : "bg-slate-50/50 border-slate-200/60 hover:bg-slate-50"}`}>
                                    <button
                                        type="button"
                                        onClick={() => { if (row.grantable) toggle(row.token); }}
                                        disabled={!row.grantable}
                                        aria-pressed={on}
                                        className={PERMISSION_TOGGLE_CLASS}
                                        data-theme-permission-toggle={row.token}
                                        style={row.grantable ? undefined : { opacity: 0.6, cursor: "not-allowed" }}
                                    >
                                        <span className="flex items-center gap-2 flex-wrap min-w-0">
                                            <i className={`fas ${meta.icon || "fa-key"} text-xs opacity-75`} aria-hidden="true" />
                                            <span className="font-extrabold text-sm text-slate-800">{meta.label}</span>
                                            <RiskBadge risk={meta.risk} adminEquivalent={meta.adminEquivalent} />
                                            <span className={TOKEN_CLASS}><BreakableToken text={row.token} /></span>
                                        </span>
                                        <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-300 shrink-0 mt-0.5 col-start-2 row-start-1 ${on ? knobOn : "bg-slate-300"}`}>
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-300 ${on ? "translate-x-6" : "translate-x-1"} shadow-sm`} />
                                        </span>
                                        <span className={PERMISSION_DETAILS_CLASS}>
                                            {!row.grantable && <span className="block text-xs text-slate-700 font-bold leading-relaxed mt-1.5" data-theme-permission-problem={row.token}>{problemText(row.problem)}</span>}
                                            {meta.description && <span className="block text-xs text-slate-600 font-medium leading-relaxed mt-1.5">{meta.description}</span>}
                                            {row.reason && <span className="block text-xs text-slate-600 font-semibold leading-relaxed mt-1.5 italic"><span className={REASON_LABEL_CLASS}>{t("themes.permissions.themeSays")} </span>{row.reason}</span>}
                                        </span>
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
                <div className="p-8 pt-6 flex justify-end gap-3 flex-shrink-0 border-t border-slate-100 mt-2">
                    <button type="button" onClick={onCancel} className="px-5 py-2.5 text-xs font-extrabold uppercase tracking-widest text-slate-500 hover:text-slate-950 hover:bg-slate-100/80 rounded-xl transition-all">{t("cancel")}</button>
                    <button
                        type="button"
                        onClick={() => onConfirm(Array.from(draft).filter((tok) => data.declared.some((r) => r.token === tok && r.grantable)).sort())}
                        disabled={busy}
                        data-theme-permissions-confirm=""
                        className="px-6 py-3 bg-blue-600 text-white rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-blue-700 disabled:opacity-50 shadow-lg shadow-blue-500/20 transition-all"
                    >
                        {busy ? t("themes.permissions.saving") : mode === "activate" ? t("themes.permissions.activate") : t("themes.permissions.save")}
                    </button>
                </div>
            </div>
        </DialogLayer>
    );
}
