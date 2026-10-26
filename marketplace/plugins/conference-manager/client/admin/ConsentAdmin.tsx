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
 *
 * 2.36.16 (owner: «la página de Autorizaciones es pésima»): three tabs — «Personas» first, «Hoja en papel»,
 * «Configuración». A status per person in plain words with a color and an icon (lib/consentStatus: Sin autorización,
 * Autorizado (verbal), Vencido, Confirmado (código / papel), Retirado), a summary whose counts filter the list,
 * search by name, document or locality, the list as table and cards (ConsentPeopleList — nothing scrolls sideways), selection
 * with «Enviar solicitud» and «Hoja en papel» for the chosen people, and each person in a sheet with their timeline
 * (ConsentPersonSheet). Permissions, the consent rules and the evidence are untouched.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { apiGet, apiPost, apiPut } from "../../../../../frontend/src/lib/api";
import { usePerms } from "./perms";
import { Overlay } from "./Overlay";
import { consentT } from "../lib/consentI18n";
import { consentMessage, copyLangOf, copyText, rememberCopyLang, whatsappUrl } from "../lib/consentMessage";
import { copyLater } from "../lib/clipboard";
import { CopyLangPicker } from "../lib/CopyLangPicker";
import { Select } from "../lib/Select";
import { PaperConsent } from "../lib/PaperConsent";
import { ConsentPeopleList } from "./ConsentPeopleList";
import { STATUS_LOOK, STATUS_ORDER, canRequest, countsOf, filterPeople, oneLocation, sendable, statusOf, type ConsentStatus } from "../lib/consentStatus";
import { ConsentPersonSheet } from "./ConsentPersonSheet";

const BASE = "/plugin/conference-manager";
const LANG_NAMES: Record<string, string> = { es: "Español", en: "English", pt: "Português" };

/** The admin's dialog for the paper panel: the plugin's Overlay, with a title, a body and a footer. */
function AdminDialog({ title, onClose, children, footer, testId, closeLabel, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; testId?: string; closeLabel?: string; wide?: boolean }) {
    return (
        <Overlay layer={2} onBackdrop={onClose} onEscape={onClose}>
            <div role="dialog" aria-modal="true" aria-label={title} className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? "max-w-5xl" : "max-w-2xl"} p-4 sm:p-6 space-y-4`} data-testid={testId}>
                <div className="flex items-start justify-between gap-3">
                    <h3 className="text-lg font-bold text-gray-900">{title}</h3>
                    <button type="button" onClick={onClose} aria-label={closeLabel || "Cerrar"} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
                </div>
                <div className={`${wide ? "max-h-[70vh]" : "max-h-[60vh]"} overflow-y-auto`}>{children}</div>
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
    // 2.35.0: the people without an e-mail on file («Sin correo»): no link to e-mail them, «Copiar mensaje» or paper.
    const [noEmail, setNoEmail] = useState<Set<number>>(new Set());
    const [enabled, setEnabled] = useState(false);
    const [q, setQ] = useState("");
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
            setNoEmail(new Set((st.no_email || []).map(Number)));
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
        // 2.36.8: the copy starts IN the tap with the message still on its way (lib/clipboard copyLater) — a phone
        // only lets a page copy during the tap, and the new link takes a round trip.
        const pending = apiPost<any>(`${BASE}/consent/share`, { inscription_id: p.id });
        const copying = copyLater(pending.then((info) => consentMessage(copyLangOf(info.email_lang), info)));
        try {
            const info = await pending;
            const lang = copyLangOf(info.email_lang);
            const copied = await copying;
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

    // ── 2.36.16: the list — a status per person, the summary that filters, search, locality, selection ──────────────
    const [tab, setTab] = useState<"people" | "paper" | "settings">("people");
    const [statusFilter, setStatusFilter] = useState<ConsentStatus | "all">("all");
    const [locFilter, setLocFilter] = useState("");
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [openId, setOpenId] = useState<number | null>(null);
    const [paperOnly, setPaperOnly] = useState<number[] | null>(null);
    const [bulkBusy, setBulkBusy] = useState(false);
    const rows = useMemo(() => filterPeople(people, states, { q, status: statusFilter, location: locFilter }), [people, states, q, statusFilter, locFilter]);
    const counts = useMemo(() => countsOf(people, states), [people, states]);
    const selectedIds = useMemo(() => [...selected], [selected]);
    const toSend = useMemo(() => (enabled && canManage ? sendable(selectedIds, states, noEmail) : []), [enabled, canManage, selectedIds, states, noEmail]);
    const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const toggleAll = () => setSelected((s) => {
        const ids = rows.map((p) => Number(p.id));
        return ids.every((id) => s.has(id)) ? new Set([...s].filter((id) => !ids.includes(id))) : new Set([...s, ...ids]);
    });
    // «Enviar solicitud» to the selection: one by one (the server's per-person pause still applies), then the summary.
    const sendSelected = async () => {
        if (!toSend.length || bulkBusy) return;
        setBulkBusy(true);
        let ok = 0;
        for (const id of toSend) {
            try { const r = await apiPost<any>(`${BASE}/consent/send`, { inscription_id: id }); if (r.sent) ok++; } catch { /* counted as not sent */ }
        }
        addToast(t("ux.bulk.sent", { ok, total: toSend.length }), ok === toSend.length ? "success" : "warning");
        setBulkBusy(false); setSelected(new Set());
        load();
    };
    // «Hoja en papel» for a selection or one person: the sheet is per locality.
    const paperFor = (ids: number[]) => {
        const askable = ids.filter((id) => canRequest(statusOf(states[id])));
        const loc = oneLocation(askable, people);
        if (!askable.length) { addToast(t("ux.bulk.paper.none"), "warning"); return; }
        if (!loc) { addToast(t("ux.bulk.paper.one"), "warning"); return; }
        setPaperLoc(loc); setPaperOnly(askable); setOpenId(null); setTab("paper");
    };
    const openPerson = openId != null ? people.find((p) => Number(p.id) === openId) : null;

    const input = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500 outline-none";
    const label = "block text-xs font-bold text-gray-600 mb-1";
    const btn = "min-h-[44px] px-4 rounded-xl text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50";
    const showSettings = perms.can("settings");
    const tabs = [["people", "fa-users", t("ux.tab.people")], ["paper", "fa-file-signature", t("ux.tab.paper")], ...(showSettings ? [["settings", "fa-gear", t("ux.tab.settings")]] : [])];

    return (
        <div className="space-y-5" data-consent-admin="">
            <div>
                <h2 className="text-xl font-black text-gray-900">{t("ux.title")}</h2>
                <p className="text-sm text-gray-500 mt-1 max-w-3xl">{t("ux.intro")}</p>
            </div>
            <div className="flex flex-wrap gap-1 border-b-2 border-gray-100" role="tablist" aria-label={t("ux.title")}>
                {tabs.map(([k, icon, name]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k as any)} data-consent-tab={k}
                        className={`min-h-[44px] px-4 -mb-[2px] border-b-2 text-sm font-bold inline-flex items-center gap-2 ${tab === k ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
                        <i className={`fa-solid ${icon}`} aria-hidden="true"></i>{name}
                    </button>
                ))}
            </div>

            {tab === "people" && (
                <section className="space-y-4" data-consent-people="">
                    {!enabled && (
                        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3">
                            <span className="flex-1 min-w-[12rem]">{t("admin.off")}</span>
                            {showSettings && <button type="button" onClick={() => setTab("settings")} className={`${btn} border-2 border-gray-200 bg-white text-gray-800`}>{t("ux.turn.on")}</button>}
                        </div>
                    )}
                    {enabled && (
                        <div className="flex flex-wrap gap-2" role="group" aria-label={t("ux.summary")} data-consent-summary="">
                            {(["all", ...STATUS_ORDER] as const).map((k) => {
                                const look = k === "all" ? { tone: "bg-white text-gray-800 border-gray-200", icon: "fa-users" } : STATUS_LOOK[k];
                                const on = statusFilter === k;
                                return (
                                    <button key={k} type="button" aria-pressed={on} onClick={() => setStatusFilter(k)} data-consent-filter={k}
                                        className={`min-h-[44px] px-3 rounded-xl border-2 text-sm font-bold inline-flex items-center gap-2 min-w-0 text-left ${look.tone} ${on ? "ring-2 ring-blue-500 ring-offset-1" : "opacity-90 hover:opacity-100"}`}>
                                        <i className={`fa-solid ${look.icon}`} aria-hidden="true"></i>
                                        <span className="min-w-0 leading-tight">{k === "all" ? t("ux.status.all") : t(`ux.status.${k}`)}</span>
                                        <span className="tabular-nums bg-white/70 rounded-md px-1.5">{counts[k]}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {enabled && statusFilter === "overdue" && <p className="text-xs text-gray-500">{t("ux.overdue.hint", { days: (settings && settings.verbal_days) || 15 })}</p>}
                    <div className="flex flex-wrap gap-2">
                        <div className="relative flex-1 min-w-[14rem]">
                            <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm" aria-hidden="true"></i>
                            <input type="search" className={`${input} pl-9 min-h-[44px]`} placeholder={t("ux.search")} aria-label={t("ux.search")} value={q} onChange={(e) => setQ(e.target.value)} data-consent-search="" />
                        </div>
                        {locations.length > 1 && (
                            <div className="min-w-[12rem]" style={{ flex: "0 1 16rem" }}>
                                <Select className={`${input} min-h-[44px]`} value={locFilter} onChange={(e) => setLocFilter(e.target.value)} aria-label={t("paper.location")} data-consent-location="">
                                    <option value="">{t("ux.all.locations")}</option>
                                    {locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                </Select>
                            </div>
                        )}
                    </div>
                    {selected.size > 0 && (
                        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border-2 border-blue-100 bg-blue-50/95 backdrop-blur px-3 py-2" data-consent-bulk="">
                            <span className="text-sm font-bold text-blue-900 mr-auto">{t("ux.bulk.selected", { n: selected.size })}</span>
                            {enabled && canManage && (
                                <button type="button" disabled={!toSend.length || bulkBusy} onClick={sendSelected} className={`${btn} bg-blue-600 text-white`} data-consent-bulk-send="">
                                    <i className={`fa-solid ${bulkBusy ? "fa-spinner animate-spin" : "fa-paper-plane"}`} aria-hidden="true"></i>{t("ux.bulk.send", { n: toSend.length })}
                                </button>
                            )}
                            {enabled && canManage && (
                                <button type="button" onClick={() => paperFor(selectedIds)} className={`${btn} border-2 border-gray-200 bg-white text-gray-800`} data-consent-bulk-paper="">
                                    <i className="fa-solid fa-file-signature" aria-hidden="true"></i>{t("ux.bulk.paper")}
                                </button>
                            )}
                            <button type="button" onClick={() => setSelected(new Set())} className={`${btn} text-gray-600 hover:bg-white`}>{t("ux.bulk.clear")}</button>
                        </div>
                    )}
                    <ConsentPeopleList rows={rows} states={states} noEmail={noEmail} t={t} nameOf={nameOf} enabled={enabled} canManage={canManage}
                        selectable={enabled && canManage} selected={selected} onToggle={toggle} onToggleAll={toggleAll} busyId={busyId}
                        onOpen={(p: any) => setOpenId(Number(p.id))} onSend={(p: any) => send(p.id)} onCopy={(p: any) => shareMessage(p)} />
                    {rows.length === 0 && <p className="text-center text-sm text-gray-500 py-6" data-consent-empty="">{people.length ? t("ux.empty.filter") : t("admin.empty")}</p>}
                </section>
            )}

            {tab === "paper" && (
                <div data-consent-paper-admin="">
                    {!enabled ? (
                        <p className="text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3">{t("admin.off")}</p>
                    ) : paperLoc ? (
                        <PaperConsent key={`${paperLoc}-${paperOnly ? paperOnly.join(",") : "all"}`} t={t} request={paperRequest} Dialog={AdminDialog} addToast={addToast} canManage={canManage} dateLang={language || "es"}
                            onlyIds={paperOnly} onClearOnly={() => setPaperOnly(null)}
                            locationPicker={(
                                <div style={{ maxWidth: "20rem" }}>
                                    <label className={label} htmlFor="cp-loc">{t("paper.location")}</label>
                                    <Select id="cp-loc" className={input} value={paperLoc} onChange={(e) => { setPaperLoc(e.target.value); setPaperOnly(null); }}>
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

            {tab === "settings" && showSettings && (
                <div className="space-y-6" data-consent-settings-tab="">
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
                </div>
            )}

            {openPerson && (
                <ConsentPersonSheet p={openPerson} st={states[openPerson.id]} name={nameOf(openPerson)} t={t} lang={language} when={when}
                    enabled={enabled} canManage={canManage} isAdmin={perms.isAdmin} noEmail={noEmail.has(Number(openPerson.id))} busy={busyId === openPerson.id}
                    onClose={() => setOpenId(null)} onSend={() => send(openPerson.id)} onCopy={() => shareMessage(openPerson)}
                    onPaper={() => paperFor([Number(openPerson.id)])} onExport={() => exportOne(openPerson)}
                    onRevoke={() => { setRevoke({ p: openPerson, general: false, health: false, image: false, note: "", err: {} }); }} />
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
