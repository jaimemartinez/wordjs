// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Autorizaciones» (conference-manager 2.33.0) — the admin's tab for each registrant's data processing consent:
 *   - Configuración (settings:manage): ask for it or not, the policy's address and version, the controller and
 *     its e-mail, the three authorization texts, the link's validity and the health purge delay;
 *   - Personas (inscriptions:view): each person's state, what they authorized and when; «Enviar / Reenviar
 *     enlace» and «Registrar revocación» (inscriptions:manage, a NEW log row); «Exportar evidencia» (WordJS
 *     administrators: the person's whole log, chain-checked, as a JSON file for a data protection request);
 *   - verbal health authorizations (2.34.0): the count of those still waiting for their written confirmation, a
 *     filter to list them, a marker on each (late after «Días para confirmar», which is a setting);
 *   - «Consentimiento en papel» (2.34.0, lib/PaperConsent): for any locality, the printable sheet, the signed pages'
 *     upload and the checklist of who signed (inscriptions:manage), next to the code signature;
 *   - «Copiar mensaje» (2.33.2): a new link and the request as a message in the admin's language, for WhatsApp —
 *     copied with the Clipboard API (toast «Mensaje copiado»), always shown in a dialog to select by hand when the
 *     clipboard is unavailable, with «Abrir en WhatsApp». No e-mail is sent; the log records «link_shared».
 * Every message is in place (a notice or a field error) or a host toast; the revocation is an in-app dialog.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { apiGet, apiPost, apiPut } from "../../../../../frontend/src/lib/api";
import { usePerms } from "./perms";
import { Overlay } from "./Overlay";
import { consentT } from "../lib/consentI18n";
import { consentMessage, copyLangOf, copyText, rememberCopyLang, whatsappUrl } from "../lib/consentMessage";
import { CopyLangPicker } from "../lib/CopyLangPicker";
import { Select } from "../lib/Select";
import { PaperConsent } from "../lib/PaperConsent";

const BASE = "/plugin/conference-manager";
const LANG_NAMES: Record<string, string> = { es: "Español", en: "English", pt: "Português" };
const STATE_TONE: Record<string, string> = { pending: "bg-amber-50 text-amber-800 border-amber-200", granted: "bg-emerald-50 text-emerald-800 border-emerald-200", revoked: "bg-rose-50 text-rose-800 border-rose-200" };

/** The admin's dialog for the paper panel: the plugin's Overlay, with a title, a body and a footer. */
function AdminDialog({ title, onClose, children, footer, testId, closeLabel }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; testId?: string; closeLabel?: string }) {
    return (
        <Overlay layer={2} onBackdrop={onClose} onEscape={onClose}>
            <div role="dialog" aria-modal="true" aria-label={title} className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 space-y-4" data-testid={testId}>
                <div className="flex items-start justify-between gap-3">
                    <h3 className="text-lg font-bold text-gray-900">{title}</h3>
                    <button type="button" onClick={onClose} aria-label={closeLabel || "Cerrar"} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto">{children}</div>
                {footer}
            </div>
        </Overlay>
    );
}

export default function ConsentAdmin({ conferenceId }: { conferenceId: number }) {
    const { language } = useI18n();
    const t = useMemo(() => consentT(language), [language]);
    const { addToast } = useToast();
    const perms = usePerms();
    const canSettings = perms.can("settings", "manage");
    const canManage = perms.can("inscriptions", "manage");
    const [settings, setSettings] = useState<any>(null);
    const [draft, setDraft] = useState<any>(null);
    const [defaults, setDefaults] = useState<any>(null);
    const [people, setPeople] = useState<any[]>([]);
    const [states, setStates] = useState<Record<string, any>>({});
    const [enabled, setEnabled] = useState(false);
    const [q, setQ] = useState("");
    const [onlyVerbal, setOnlyVerbal] = useState(false);
    const [saving, setSaving] = useState(false);
    const [fieldErr, setFieldErr] = useState<string | null>(null);
    const [revoke, setRevoke] = useState<any>(null);
    const [busyId, setBusyId] = useState<number | null>(null);

    const when = (iso: string | null) => {
        if (!iso) return "";
        try { return new Intl.DateTimeFormat(language || "es", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; }
    };
    // The plugin-wide default e-mail language (2.33.4): '' = the site's.
    const [pluginLang, setPluginLang] = useState<{ email_lang: string; site_lang: string; effective: string } | null>(null);
    const savePluginLang = async (v: string) => {
        try {
            const r = await apiPut<any>(`${BASE}/consent/defaults`, { email_lang: v });
            setPluginLang(r);
            addToast(t("admin.plugin.lang.saved"), "success");
            load();
        } catch (e: any) { addToast(e?.message || "Error", "error"); }
    };
    const load = useCallback(async () => {
        try {
            if (perms.can("settings")) apiGet<any>(`${BASE}/consent/defaults`).then(setPluginLang).catch(() => {});
            const [s, st, list] = await Promise.all([
                perms.can("settings") ? apiGet<any>(`${BASE}/consent/settings?conference_id=${conferenceId}`) : Promise.resolve(null),
                apiGet<any>(`${BASE}/consent/states?conference_id=${conferenceId}`),
                apiGet<any[]>(`${BASE}/inscriptions?conference_id=${conferenceId}`),
            ]);
            if (s) { setSettings(s.settings); setDraft({ ...s.settings, policy_url: s.settings.policy_url_custom }); setDefaults(s.defaults); }
            setStates(st.states || {});
            setEnabled(!!st.enabled);
            setPeople(Array.isArray(list) ? list : []);
        } catch (e: any) { addToast(e?.message || "Error", "error"); }
    }, [conferenceId]);
    useEffect(() => { load(); }, [load]);

    const save = async () => {
        setSaving(true); setFieldErr(null);
        try {
            const body = { conference_id: conferenceId, enabled: !!draft.enabled, policy_url: draft.policy_url || "", policy_version: draft.policy_version, responsible: draft.responsible,
                contact_email: draft.contact_email, text_general: draft.text_general, text_health: draft.text_health, text_image: draft.text_image,
                purge_days: Number(draft.purge_days), link_days: Number(draft.link_days), verbal_days: Number(draft.verbal_days), email_lang: draft.email_lang || '' };
            const r = await apiPut<any>(`${BASE}/consent/settings`, body);
            setSettings(r.settings); setDraft({ ...r.settings, policy_url: r.settings.policy_url_custom });
            addToast(t("admin.saved"), "success");
            load();
        } catch (e: any) { setFieldErr(e?.message || "Error"); }
        finally { setSaving(false); }
    };
    // 2.33.4: the message in the e-mail language (or the last one chosen here), switchable in the dialog.
    const [share, setShare] = useState<{ name: string; info: any; lang: string; phone: string; copied: boolean } | null>(null);
    const shareText = share ? consentMessage(share.lang, share.info) : '';
    const shareMessage = async (p: any) => {
        setBusyId(p.id);
        try {
            const info = await apiPost<any>(`${BASE}/consent/share`, { inscription_id: p.id });
            const lang = copyLangOf(info.email_lang);
            const copied = await copyText(consentMessage(lang, info));
            if (copied) addToast(t("copy.done"), "success");
            setShare({ name: nameOf(p), info, lang, phone: info.phone_wa || "", copied });
            load();
        } catch (e: any) { addToast(e?.message || "Error", "error"); }
        finally { setBusyId(null); }
    };
    const copyAgain = async () => {
        if (!share) return;
        const copied = await copyText(shareText);
        if (copied) addToast(t("copy.done"), "success");
        setShare({ ...share, copied });
    };
    const send = async (id: number) => {
        setBusyId(id);
        try {
            const r = await apiPost<any>(`${BASE}/consent/send`, { inscription_id: id });
            addToast(r.sent ? t("portal.resent", { email: r.email_masked }) : t("portal.resent.failed"), r.sent ? "success" : "warning");
            load();
        } catch (e: any) { addToast(e?.message || "Error", "error"); }
        finally { setBusyId(null); }
    };
    const exportOne = async (p: any) => {
        setBusyId(p.id);
        try {
            const r = await apiGet<any>(`${BASE}/consent/evidence/${p.id}`);
            const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `autorizacion-${p.id}-${String(nameOf(p)).normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "persona"}.json`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } catch (e: any) { addToast(e?.message || "Error", "error"); }
        finally { setBusyId(null); }
    };
    const nameOf = (p: any) => [p.first_name, p.last_name].filter((x) => x && String(x).trim()).join(" ") || `#${p.id}`;

    // «Consentimiento en papel» (2.34.0): the admin picks the locality.
    const [locations, setLocations] = useState<any[]>([]);
    const [paperLoc, setPaperLoc] = useState<string>("");
    useEffect(() => {
        apiGet<any>(`${BASE}/locations?conference_id=${conferenceId}`)
            .then((r) => { const l = Array.isArray(r) ? r : (r && r.locations) || []; setLocations(l); if (l.length === 1) setPaperLoc(String(l[0].id)); })
            .catch(() => setLocations([]));
    }, [conferenceId]);
    const paperRequest = useCallback(async (method: "get" | "post", params: Record<string, any> = {}) => {
        const scope = { conference_id: conferenceId, location_id: Number(paperLoc) };
        if (method === "get") return apiGet<any>(`${BASE}/consent/paper?${new URLSearchParams(Object.entries({ ...scope, ...params }).map(([k, v]) => [k, String(v)]))}`);
        const r = await apiPost<any>(`${BASE}/consent/paper`, { ...scope, ...params });
        if (params.action === "marks" || params.action === "unmark") load();
        return r;
    }, [conferenceId, paperLoc]);

    const rows = useMemo(() => {
        const n = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        const needle = n(q.trim());
        return people.filter((p) => p.status !== "cancelled" && (!needle || n(nameOf(p)).includes(needle)) && (!onlyVerbal || (states[p.id] && states[p.id].verbal_health)));
    }, [people, q, onlyVerbal, states]);
    const counts = useMemo(() => {
        const c = { pending: 0, granted: 0, revoked: 0, failed: 0, verbal: 0 };
        for (const p of people) {
            if (p.status === "cancelled") continue;
            const st = states[p.id];
            const k = st ? st.state : "pending";
            c[k] = (c[k] || 0) + 1;
            if (st && st.mail_failed && k === "pending") c.failed++;
            if (st && st.verbal_health) c.verbal++;
        }
        return c;
    }, [people, states]);

    const input = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500 outline-none";
    const label = "block text-xs font-bold text-gray-600 mb-1";

    return (
        <div className="space-y-6" data-consent-admin="">
            {pluginLang && (
                <section className="rounded-xl border border-gray-200 p-5 flex flex-wrap items-center gap-4" data-consent-plugin-lang="">
                    <div className="min-w-0" style={{ flex: '1 1 16rem' }}>
                        <label className="block text-sm font-bold text-gray-900" htmlFor="cs-plugin-lang">{t("admin.plugin.lang")}</label>
                        <p className="text-xs text-gray-500 mt-1">{t("admin.plugin.lang.hint")}</p>
                    </div>
                    <div style={{ flex: '0 1 16rem' }}>
                        <Select id="cs-plugin-lang" className={input} value={pluginLang.email_lang || ""} disabled={!canSettings} onChange={(e) => savePluginLang(e.target.value)}>
                            <option value="">{t("admin.email.lang.site", { lang: LANG_NAMES[pluginLang.site_lang] || pluginLang.site_lang })}</option>
                            <option value="es">Español</option>
                            <option value="en">English</option>
                            <option value="pt">Português</option>
                        </Select>
                    </div>
                </section>
            )}

            {draft && (
                <section className="rounded-xl border border-gray-200 p-5 space-y-4" data-consent-settings="">
                    <h2 className="text-lg font-bold text-gray-900">{t("admin.settings")}</h2>
                    <label className="flex items-start gap-3 cursor-pointer">
                        <input type="checkbox" className="mt-1 w-5 h-5 accent-blue-600" checked={!!draft.enabled} disabled={!canSettings} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} data-consent-enabled="" />
                        <span>
                            <span className="block text-sm font-bold text-gray-900">{t("admin.enabled")}</span>
                            <span className="block text-xs text-gray-500">{t("admin.enabled.hint")}</span>
                        </span>
                    </label>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div>
                            <label className={label} htmlFor="cs-url">{t("admin.policy.url")}</label>
                            <input id="cs-url" className={input} value={draft.policy_url || ""} disabled={!canSettings} placeholder={settings.policy_url} onChange={(e) => setDraft({ ...draft, policy_url: e.target.value })} />
                            {!draft.policy_url && <p className="text-[11px] text-gray-400 mt-1">{t("admin.policy.url.hint", { url: settings.policy_url_custom ? (defaults?.policy_path || "/politica-de-datos") : settings.policy_url })}</p>}
                        </div>
                        <div>
                            <label className={label} htmlFor="cs-ver">{t("admin.policy.version")}</label>
                            <input id="cs-ver" className={input} value={draft.policy_version || ""} disabled={!canSettings} maxLength={40} onChange={(e) => setDraft({ ...draft, policy_version: e.target.value })} />
                        </div>
                        <div>
                            <label className={label} htmlFor="cs-resp">{t("admin.responsible")}</label>
                            <input id="cs-resp" className={input} value={draft.responsible || ""} disabled={!canSettings} maxLength={200} onChange={(e) => setDraft({ ...draft, responsible: e.target.value })} />
                        </div>
                        <div>
                            <label className={label} htmlFor="cs-mail">{t("admin.contact")}</label>
                            <input id="cs-mail" type="text" inputMode="email" className={input} value={draft.contact_email || ""} disabled={!canSettings} maxLength={254} onChange={(e) => setDraft({ ...draft, contact_email: e.target.value })} />
                        </div>
                    </div>
                    {(["general", "health", "image"] as const).map((k) => (
                        <div key={k}>
                            <label className={label} htmlFor={`cs-${k}`}>{t(`admin.text.${k}`)}</label>
                            <textarea id={`cs-${k}`} rows={3} className={input} value={draft[`text_${k}`] || ""} disabled={!canSettings} maxLength={4000} onChange={(e) => setDraft({ ...draft, [`text_${k}`]: e.target.value })} />
                        </div>
                    ))}
                    <p className="text-[11px] text-gray-500">{t("admin.text.hint")}</p>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div>
                            <label className={label} htmlFor="cs-purge">{t("admin.purge")}</label>
                            <input id="cs-purge" type="number" min={0} max={3650} className={input} value={draft.purge_days} disabled={!canSettings} onChange={(e) => setDraft({ ...draft, purge_days: e.target.value })} />
                            {settings.health_purged_at && <p className="text-[11px] text-emerald-700 mt-1">{t("admin.purge.done", { when: when(settings.health_purged_at) })}</p>}
                        </div>
                        <div>
                            <label className={label} htmlFor="cs-mail-lang">{t("admin.email.lang")}</label>
                            <Select id="cs-mail-lang" className={input} value={draft.email_lang || ""} disabled={!canSettings} onChange={(e) => setDraft({ ...draft, email_lang: e.target.value })}>
                                <option value="">{t("admin.email.lang.plugin", { lang: LANG_NAMES[settings.plugin_email_lang] || settings.plugin_email_lang })}</option>
                                <option value="es">Español</option>
                                <option value="en">English</option>
                                <option value="pt">Português</option>
                            </Select>
                            <p className="text-[11px] text-gray-400 mt-1">{t("admin.email.lang.hint")}</p>
                        </div>
                        <div>
                            <label className={label} htmlFor="cs-verbal-days">{t("admin.verbal.days")}</label>
                            <input id="cs-verbal-days" type="number" min={1} max={365} className={input} value={draft.verbal_days} disabled={!canSettings} onChange={(e) => setDraft({ ...draft, verbal_days: e.target.value })} />
                            <p className="text-[11px] text-gray-400 mt-1">{t("admin.verbal.days.hint")}</p>
                        </div>
                        <div>
                            <label className={label} htmlFor="cs-days">{t("admin.link.days")}</label>
                            <input id="cs-days" type="number" min={1} max={90} className={input} value={draft.link_days} disabled={!canSettings} onChange={(e) => setDraft({ ...draft, link_days: e.target.value })} />
                        </div>
                    </div>
                    {fieldErr && <p className="text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2" role="alert">{fieldErr}</p>}
                    <div className="text-[11px] text-gray-500 space-y-1">
                        <p><i className="fa-solid fa-envelope mr-1" aria-hidden="true"></i>{t("admin.mail.note")}</p>
                        <p><i className="fa-solid fa-network-wired mr-1" aria-hidden="true"></i>{t("admin.ip.note")}</p>
                    </div>
                    {canSettings && (
                        <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={save} disabled={saving} className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold disabled:opacity-60" data-consent-save="">{saving ? "…" : t("admin.save")}</button>
                            <button type="button" onClick={async () => { try { await apiPost(`${BASE}/consent/purge`, {}); addToast(t("admin.purge.ran"), "success"); load(); } catch (e: any) { addToast(e?.message || "Error", "error"); } }}
                                className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 text-sm font-semibold">{t("admin.purge.now")}</button>
                        </div>
                    )}
                </section>
            )}

            <section className="space-y-3" data-consent-people="">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-lg font-bold text-gray-900">{t("admin.people")}</h2>
                    <input className={`${input} max-w-xs`} placeholder={t("admin.search")} aria-label={t("admin.search")} value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                {!enabled && <p className="text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">{t("admin.off")}</p>}
                {enabled && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        {(["pending", "granted", "revoked", "failed", "verbal"] as const).map((k) => (
                            <div key={k} className="rounded-xl border border-gray-100 bg-gray-50/50 px-4 py-3" data-consent-kpi={k}>
                                <div className="text-[10px] font-black uppercase tracking-widest text-gray-500">{t(`admin.kpi.${k}`)}</div>
                                <div className="text-2xl font-black text-gray-900 tabular-nums">{counts[k]}</div>
                            </div>
                        ))}
                    </div>
                )}
                {enabled && (
                    <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input type="checkbox" className="w-4 h-4 accent-amber-600" checked={onlyVerbal} onChange={(e) => setOnlyVerbal(e.target.checked)} data-consent-filter-verbal="" />
                        {t("admin.filter.verbal")} ({counts.verbal})
                    </label>
                )}
                <div className="overflow-x-auto border border-gray-100 rounded-xl">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-gray-50 text-[10px] font-black uppercase tracking-widest text-gray-500">
                            <tr><th className="px-4 py-3">{t("admin.col.person")}</th><th className="px-4 py-3">{t("admin.col.state")}</th><th className="px-4 py-3">{t("admin.col.choices")}</th><th className="px-4 py-3">{t("admin.col.email")}</th><th className="px-4 py-3 text-right">{t("admin.col.actions")}</th></tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">{t("admin.empty")}</td></tr>}
                            {rows.map((p) => {
                                const st = states[p.id];
                                const state = st ? st.state : "pending";
                                return (
                                    <tr key={p.id} data-consent-row={p.id}>
                                        <td className="px-4 py-3 font-semibold text-gray-900">{nameOf(p)}</td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-block border rounded-full px-2 py-0.5 text-[11px] font-bold ${STATE_TONE[state]}`} data-consent-state={state}>
                                                {state === "granted" ? t("portal.state.granted") : state === "revoked" ? t("portal.state.revoked") : t("portal.state.pending")}
                                            </span>
                                            <div className="text-[11px] text-gray-500 mt-1">
                                                {state === "granted" ? when(st.granted_at) : state === "revoked" ? when(st.revoked_at) : !st ? t("portal.never.sent") : st.mail_failed ? t("portal.mail.failed") : st.link_expired ? t("portal.link.expired") : ""}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-xs text-gray-600">
                                            {st && state !== "pending" ? [st.general && t("page.done.general"), st.health && t("page.done.health"), st.image && t("page.done.image")].filter(Boolean).join(" · ") || "—" : "—"}
                                            {st && st.verbal_health && (
                                                <span className={`ml-2 inline-block border rounded-full px-2 py-0.5 text-[10px] font-bold ${st.verbal_overdue ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800"}`} data-consent-verbal={st.verbal_overdue ? "overdue" : "pending"}>
                                                    <i className="fa-solid fa-comment-dots mr-1" aria-hidden="true"></i>{st.verbal_overdue ? t("verbal.overdue") : t("verbal.pending")}
                                                </span>
                                            )}
                                            {st && st.method === "paper" && <span className="ml-2 inline-block border border-gray-200 rounded-full px-2 py-0.5 text-[10px] font-bold text-gray-600" data-consent-method="paper"><i className="fa-solid fa-file-signature mr-1" aria-hidden="true"></i>{t("paper.method")}</span>}
                                        </td>
                                        <td className="px-4 py-3 text-xs text-gray-500">{st ? st.email_masked : ""}</td>
                                        <td className="px-4 py-3">
                                            <div className="flex flex-wrap justify-end gap-2">
                                                {enabled && canManage && state !== "granted" && (
                                                    <button type="button" disabled={busyId === p.id} onClick={() => send(p.id)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-gray-700 hover:bg-gray-50" data-consent-send={p.id}>
                                                        {st ? t("portal.resend") : t("portal.send")}
                                                    </button>
                                                )}
                                                {enabled && canManage && state !== "granted" && (
                                                    <button type="button" disabled={busyId === p.id} onClick={() => shareMessage(p)} className="px-3 py-1.5 rounded-lg border border-emerald-200 text-xs font-semibold text-emerald-800 hover:bg-emerald-50" data-consent-copy={p.id}>
                                                        <i className="fa-regular fa-copy mr-1" aria-hidden="true"></i>{t("copy.button")}
                                                    </button>
                                                )}
                                                {canManage && state === "granted" && (
                                                    <button type="button" onClick={() => setRevoke({ p, general: false, health: false, image: false, note: "", err: {} })} className="px-3 py-1.5 rounded-lg border border-rose-200 text-xs font-semibold text-rose-700 hover:bg-rose-50" data-consent-revoke={p.id}>{t("admin.revoke")}</button>
                                                )}
                                                {st ? (
                                                    <button type="button" disabled={!perms.isAdmin || busyId === p.id} title={perms.isAdmin ? undefined : t("admin.export.only")} onClick={() => exportOne(p)}
                                                        className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50" data-consent-export={p.id}>
                                                        <i className="fa-solid fa-file-export mr-1" aria-hidden="true"></i>{t("admin.export")}
                                                    </button>
                                                ) : null}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>

            {enabled && (
                <div data-consent-paper-admin="">
                    {paperLoc ? (
                        <PaperConsent key={paperLoc} t={t} request={paperRequest} Dialog={AdminDialog} addToast={addToast} canManage={canManage} dateLang={language || "es"}
                            locationPicker={(
                                <div style={{ maxWidth: "20rem" }}>
                                    <label className={label} htmlFor="cp-loc">{t("paper.location")}</label>
                                    <Select id="cp-loc" className={input} value={paperLoc} onChange={(e) => setPaperLoc(e.target.value)}>
                                        {locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                    </Select>
                                </div>
                            )} />
                    ) : (
                        <section className="rounded-xl border border-gray-200 p-5 space-y-3">
                            <h2 className="text-lg font-bold text-gray-900"><i className="fa-solid fa-file-signature mr-2 text-gray-400" aria-hidden="true"></i>{t("paper.title")}</h2>
                            <p className="text-xs text-gray-500">{t("paper.hint")}</p>
                            <div style={{ maxWidth: "20rem" }}>
                                <label className={label} htmlFor="cp-loc">{t("paper.location")}</label>
                                <Select id="cp-loc" className={input} value="" onChange={(e) => setPaperLoc(e.target.value)}>
                                    <option value="">{t("paper.location.choose")}</option>
                                    {locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                </Select>
                            </div>
                        </section>
                    )}
                </div>
            )}

            {share && (
                <Overlay layer={2} onBackdrop={() => setShare(null)} onEscape={() => setShare(null)}>
                    <div role="dialog" aria-modal="true" aria-labelledby="cm-share-title" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4" data-consent-share-dialog="">
                        <h3 id="cm-share-title" className="text-lg font-bold text-gray-900">{share.copied ? t("copy.done") : t("copy.fallback.title")} · {share.name}</h3>
                        <CopyLangPicker label={t("copy.lang")} value={share.lang} onChange={(l) => { rememberCopyLang(l); setShare({ ...share, lang: l }); }} />
                        {!share.copied && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2" role="status">{t("copy.fallback.hint")}</p>}
                        <textarea readOnly rows={9} value={shareText} aria-label={t("copy.fallback.title")} onFocus={(e) => e.currentTarget.select()}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 font-sans" data-consent-share-text="" />
                        <p className="text-[11px] text-gray-500">{t("copy.replaces")}</p>
                        <div className="flex flex-wrap justify-end gap-2">
                            <button type="button" onClick={(e) => { const box = (e.currentTarget.closest('[role="dialog"]') as HTMLElement)?.querySelector('textarea'); if (box) { box.focus(); box.select(); } }}
                                className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-700">{t("copy.select")}</button>
                            <button type="button" onClick={copyAgain} className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-700" data-consent-copy-again="">
                                <i className="fa-regular fa-copy mr-1" aria-hidden="true"></i>{t("copy.again")}
                            </button>
                            <a href={whatsappUrl(shareText, share.phone)} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold" data-consent-whatsapp="">
                                <i className="fa-brands fa-whatsapp mr-1" aria-hidden="true"></i>{t("copy.whatsapp")}
                            </a>
                            <button type="button" onClick={() => setShare(null)} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-bold">{t("copy.close")}</button>
                        </div>
                    </div>
                </Overlay>
            )}

            {revoke && (
                <Overlay layer={2} onBackdrop={() => setRevoke(null)} onEscape={() => setRevoke(null)}>
                    <div role="dialog" aria-modal="true" aria-labelledby="cr-title" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4" data-consent-revoke-dialog="">
                        <h3 id="cr-title" className="text-lg font-bold text-gray-900">{t("admin.revoke.title", { name: nameOf(revoke.p) })}</h3>
                        <p className="text-xs text-gray-500">{t("admin.revoke.hint")}</p>
                        <div className="space-y-2">
                            {(["general", "health", "image"] as const).map((k) => (
                                <label key={k} className="flex items-start gap-2 text-sm text-gray-800">
                                    <input type="checkbox" className="mt-1 w-4 h-4 accent-rose-600" checked={revoke[k] || (k !== "general" && revoke.general)} disabled={k !== "general" && revoke.general}
                                        onChange={(e) => setRevoke({ ...revoke, [k]: e.target.checked, err: { ...revoke.err, scope: "" } })} />
                                    <span>{t(`admin.revoke.${k}`)}</span>
                                </label>
                            ))}
                            {revoke.err.scope && <p className="text-xs font-semibold text-rose-600" role="alert">{revoke.err.scope}</p>}
                        </div>
                        <div>
                            <label className={label} htmlFor="cr-note">{t("admin.revoke.note")}</label>
                            <textarea id="cr-note" rows={2} className={`${input} ${revoke.err.note ? "border-rose-300" : ""}`} placeholder={t("admin.revoke.note.ph")} value={revoke.note} maxLength={500}
                                onChange={(e) => setRevoke({ ...revoke, note: e.target.value, err: { ...revoke.err, note: "" } })} />
                            {revoke.err.note && <p className="text-xs font-semibold text-rose-600 mt-1" role="alert">{revoke.err.note}</p>}
                        </div>
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setRevoke(null)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-700">{t("admin.cancel")}</button>
                            <button type="button" disabled={revoke.busy} className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-bold disabled:opacity-60" data-consent-revoke-confirm=""
                                onClick={async () => {
                                    const err: any = {};
                                    if (!revoke.general && !revoke.health && !revoke.image) err.scope = t("admin.revoke.scope.missing");
                                    if (!revoke.note.trim()) err.note = t("admin.revoke.note.missing");
                                    if (Object.keys(err).length) { setRevoke({ ...revoke, err }); return; }
                                    setRevoke({ ...revoke, busy: true });
                                    try {
                                        await apiPost(`${BASE}/consent/revoke`, { inscription_id: revoke.p.id, general: revoke.general, health: revoke.health, image: revoke.image, note: revoke.note });
                                        addToast(t("admin.revoked"), "success");
                                        setRevoke(null); load();
                                    } catch (e: any) { setRevoke({ ...revoke, busy: false, err: { note: e?.message || "Error" } }); }
                                }}>{t("admin.revoke.confirm")}</button>
                        </div>
                    </div>
                </Overlay>
            )}
        </div>
    );
}
