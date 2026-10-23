// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Autorización de datos» (conference-manager 2.33.0) — the page of the single-use link a registrant (or the
 * parent of a minor) receives by e-mail: /portal/conference/autorizacion#t=<token>. The token is read from the
 * FRAGMENT, so no request line or referrer ever carries it.
 *
 * The person reads the policy (its link and version), ticks SEPARATE, unticked boxes — general processing
 * (required), sensitive health data (optional), image use (optional) —, answers «Condiciones de salud» themselves
 * (only with the health box) and, for a minor, names the legal representative. They sign with the 6-digit code
 * sent to the same e-mail. Every error is shown next to its field: no browser `required` bubble, no native
 * dialog. The text shown is the server's own (view.text and the representative's line, built the same way), so
 * the SHA-256 the evidence keeps is the hash of what was on screen.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { csrfHeaders } from "@/lib/csrf";
import { HealthConditionsInput, HEALTH_LABELS_ES } from "../../lib/HealthConditionsInput";
import { healthAnswerError, healthPayload, type HealthAnswer } from "../../lib/health";
import { consentLangOf, consentT } from "../../lib/consentI18n";
import { Select } from "../../lib/Select";

type View = {
    conference: string; first_name: string; email_masked: string; minor: boolean | null;
    policy: { url: string; version: string }; responsible: string; contact_email: string;
    texts: { general: string; health: string; image: string };
    relationships: string[];
    health_field: { name: string; label: string; options: string } | null;
    text: string; state: "pending" | "granted" | "revoked";
};
type State =
    | { kind: "loading" }
    | { kind: "error"; code: string }
    | { kind: "form"; view: View }
    | { kind: "done"; view: View; at: string; choices: { general: boolean; health: boolean; image: boolean } };

const API = "/api/v1/plugin/conference-manager/public/consent";
const tokenFromHash = (): string => {
    if (typeof window === "undefined") return "";
    const m = /(?:^#|&)t=([0-9a-f]{32})(?:&|$)/.exec(window.location.hash || "");
    return m ? m[1] : "";
};
const langNow = () => {
    try { const s = localStorage.getItem("wordjs-lang"); if (s) return consentLangOf(s); } catch { /* private mode */ }
    return consentLangOf(typeof navigator !== "undefined" ? navigator.language : "es");
};
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${API}/${path}`, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}
/** The representative's line, exactly as the server adds it to the signed text (server/consent.js shownText). */
export const repLine = (r: { name: string; document: string; relationship: string }) =>
    `Representante legal: ${r.name} (${r.relationship}), documento ${r.document}. Otorga estas autorizaciones en nombre de la persona inscrita, menor de edad.`;

const HEALTH_LABELS_EN = { consent: "We use this only to look after you better (for example, your meal turn). Only the authorised team sees it. You may leave it unanswered.", other: "Other", otherPlaceholder: "Which one?", none: "None", declined: "I prefer not to answer" };

export default function ConsentPage() {
    const [lang] = useState(langNow);
    const t = useMemo(() => consentT(lang), [lang]);
    const [token] = useState(tokenFromHash);
    const [state, setState] = useState<State>({ kind: "loading" });
    const [busy, setBusy] = useState(false);
    const [who, setWho] = useState<"" | "self" | "rep">("");
    const [rep, setRep] = useState({ name: "", document: "", relationship: "" });
    const [boxes, setBoxes] = useState({ general: false, health: false, image: false });
    const [health, setHealth] = useState<HealthAnswer | null>(null);
    const [code, setCode] = useState("");
    const [codeSent, setCodeSent] = useState(false);
    const [resendIn, setResendIn] = useState(0);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [note, setNote] = useState<{ tone: "rose" | "emerald" | "blue"; text: string } | null>(null);
    const timer = useRef<any>(null);

    const load = useCallback(async () => {
        setState({ kind: "loading" });
        if (!token) { setState({ kind: "error", code: "link" }); return; }
        try {
            const r = await post("open", { token });
            if (r.status === 200 && r.body.view) setState({ kind: "form", view: r.body.view });
            else setState({ kind: "error", code: r.status >= 500 && r.status !== 503 ? "network" : (r.body.code || "link") });
        } catch { setState({ kind: "error", code: "network" }); }
    }, [token]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => () => clearInterval(timer.current), []);
    const countdown = (s: number) => {
        clearInterval(timer.current);
        setResendIn(s);
        timer.current = setInterval(() => setResendIn((x) => { if (x <= 1) { clearInterval(timer.current); return 0; } return x - 1; }), 1000);
    };

    if (state.kind === "loading") {
        return (
            <main className="min-h-dvh bg-gray-50 flex items-center justify-center p-6" data-consent-page="loading">
                <div className="text-gray-400 text-xs font-black uppercase tracking-widest"><i className="fa-solid fa-spinner animate-spin mr-2" aria-hidden="true"></i>{t("page.loading")}</div>
            </main>
        );
    }
    if (state.kind === "error") {
        const c = state.code === "network" ? "network" : ["link", "expired", "off"].includes(state.code) ? state.code : "link";
        return (
            <main className="min-h-dvh bg-gray-50 flex items-center justify-center p-6" data-consent-page="error" data-consent-error={c}>
                <div className="max-w-sm w-full bg-white rounded-3xl border border-gray-100 shadow-sm p-8 text-center space-y-3">
                    <div className="w-14 h-14 shrink-0 mx-auto rounded-2xl bg-gray-100 text-gray-400 flex items-center justify-center text-2xl"><i className="fa-solid fa-file-signature" aria-hidden="true"></i></div>
                    <h1 className="text-xl font-black text-gray-900">{c === "network" ? t("page.title") : t(`page.error.${c}`)}</h1>
                    <p className="text-sm text-gray-600">{c === "network" ? t("page.network") : t(`page.error.${c}.text`)}</p>
                    {c === "network" && <button type="button" onClick={load} className="min-h-[44px] px-5 rounded-2xl bg-gray-900 text-white font-black text-[11px] uppercase tracking-widest">{t("page.retry")}</button>}
                </div>
            </main>
        );
    }

    const { view } = state;
    const whenOf = (iso: string) => { try { return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; } };

    if (state.kind === "done") {
        const row = (k: string, v: boolean) => (
            <li className="flex items-center justify-between gap-3 py-2 border-b border-gray-50 last:border-0">
                <span className="text-sm text-gray-700">{t(k)}</span>
                <span className={`text-xs font-black uppercase tracking-widest ${v ? "text-emerald-700" : "text-gray-400"}`}>{v ? t("page.yes") : t("page.no")}</span>
            </li>
        );
        return (
            <main className="min-h-dvh bg-gray-100 px-4 py-8 sm:py-14" data-consent-page="done">
                <div className="mx-auto w-full max-w-md bg-white rounded-3xl border border-gray-100 shadow-sm p-6 sm:p-8 space-y-4 text-center">
                    <div className="w-14 h-14 shrink-0 mx-auto rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-2xl"><i className="fa-solid fa-circle-check" aria-hidden="true"></i></div>
                    <h1 className="text-xl font-black text-gray-900">{t("page.done.title")}</h1>
                    <p className="text-sm text-gray-600">{t("page.done.text", { when: whenOf(state.at) })}</p>
                    <ul className="text-left">{row("page.done.general", state.choices.general)}{row("page.done.health", state.choices.health)}{row("page.done.image", state.choices.image)}</ul>
                    <a href={view.policy.url} target="_blank" rel="noopener noreferrer" className="inline-block text-sm font-semibold text-blue-700 underline">{t("page.policy")} · {t("page.policy.version", { v: view.policy.version })}</a>
                </div>
            </main>
        );
    }

    const minor = view.minor === true || (view.minor == null && who === "rep");
    const whoNeeded = view.minor == null;
    const repOk = !!(rep.name.trim() && rep.document.trim() && view.relationships.includes(rep.relationship));
    const shown = minor && repOk ? view.text.replace(/\n\[Obligatoria\]/, `\n${repLine({ name: rep.name.trim().replace(/\s+/g, " "), document: rep.document.trim().replace(/\s+/g, " "), relationship: rep.relationship })}\n[Obligatoria]`) : view.text;

    /** The form's own checks (the server repeats them). Returns the errors by field. */
    const check = (forCode: boolean): Record<string, string> => {
        const e: Record<string, string> = {};
        if (whoNeeded && !who) e.who = t("page.who");
        if (minor && !repOk) e.rep = t("page.rep.missing");
        if (!boxes.general) e.general = t("page.general.missing");
        if (boxes.health && view.health_field) {
            const he = healthAnswerError({ is_required: 0 }, health);
            if (he === "other") e.health = lang === "en" ? "Write which other condition." : "Escribe cuál es la otra condición.";
        }
        if (!forCode && !/^\d{6}$/.test(code)) e.code = t("page.code.missing");
        return e;
    };
    const focusFirst = (e: Record<string, string>) => {
        const first = ["who", "rep", "general", "health", "code"].find((k) => e[k]);
        if (first && typeof document !== "undefined") document.querySelector(`[data-consent-field="${first}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    };

    const sendCode = async () => {
        const e = check(true);
        setErrors(e); setNote(null);
        if (Object.keys(e).length) { focusFirst(e); return; }
        setBusy(true);
        try {
            const r = await post("code", { token, user_agent: navigator.userAgent });
            if (r.status === 200) { setCodeSent(true); countdown(r.body.resend_in || 60); setNote({ tone: "blue", text: t("page.code.sent", { email: r.body.email_masked || view.email_masked }) }); }
            else if (r.status === 410) setState({ kind: "error", code: r.body.code || "link" });
            else { if (r.body.resend_in) countdown(r.body.resend_in); setNote({ tone: "rose", text: r.body.error || t("page.network") }); }
        } catch { setNote({ tone: "rose", text: t("page.network") }); }
        finally { setBusy(false); }
    };

    const submit = async (ev: React.FormEvent) => {
        ev.preventDefault();
        const e = check(false);
        setErrors(e); setNote(null);
        if (Object.keys(e).length) { focusFirst(e); return; }
        setBusy(true);
        try {
            let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* none */ }
            const body: any = {
                token, code, general: boxes.general, health: boxes.health, image: boxes.image,
                minor: minor, client_tz: tz, user_agent: navigator.userAgent,
                ...(minor ? { representative: { name: rep.name, document: rep.document, relationship: rep.relationship } } : {}),
                ...(boxes.health && view.health_field ? { health_answer: healthPayload(view.health_field, health) } : {}),
            };
            const r = await post("confirm", body);
            if (r.status === 200) { setState({ kind: "done", view, at: r.body.granted_at, choices: r.body.choices }); return; }
            if (r.status === 410) { setState({ kind: "error", code: r.body.code || "link" }); return; }
            const field = r.body.field === "representative" ? "rep" : r.body.field || "";
            if (field) {
                const msg = r.body.tries_left ? `${r.body.error} ${t("page.code.tries", { n: r.body.tries_left })}` : r.body.error;
                setErrors({ [field]: msg });
                if (r.body.code === "code_burnt" || r.body.code === "code_expired" || r.body.code === "nocode") { setCodeSent(false); setCode(""); }
                focusFirst({ [field]: msg });
            } else setNote({ tone: "rose", text: r.body.error || t("page.network") });
        } catch { setNote({ tone: "rose", text: t("page.network") }); }
        finally { setBusy(false); }
    };

    const card = "bg-white rounded-3xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-4";
    const h2 = "text-[11px] font-black uppercase tracking-widest text-gray-500";
    const input = (bad?: boolean) => `w-full min-h-[48px] rounded-2xl border-2 bg-white px-4 text-base font-semibold text-gray-900 outline-none ${bad ? "border-rose-300 bg-rose-50/40" : "border-gray-200 focus:border-blue-500"}`;
    const err = (k: string) => (errors[k] ? <p className="text-xs font-semibold text-rose-600" role="alert" data-consent-error-for={k}>{errors[k]}</p> : null);
    const box = (k: "general" | "health" | "image", text: string, required: boolean) => (
        <label className={`flex items-start gap-3 rounded-2xl border-2 p-4 cursor-pointer transition ${boxes[k] ? "border-blue-300 bg-blue-50/50" : errors[k] ? "border-rose-300 bg-rose-50/40" : "border-gray-100 hover:border-gray-200"}`} data-consent-field={k}>
            <input type="checkbox" className="mt-1 w-5 h-5 shrink-0 accent-blue-600" checked={boxes[k]} data-consent-box={k}
                onChange={(e) => { setBoxes({ ...boxes, [k]: e.target.checked }); setErrors({ ...errors, [k]: "" }); }} />
            <span className="min-w-0 space-y-1">
                <span className={`inline-block text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${required ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"}`}>{required ? t("page.required") : t("page.optional")}</span>
                <span className="block text-sm text-gray-800 leading-relaxed" style={{ overflowWrap: "anywhere" }}>{text}</span>
            </span>
        </label>
    );

    return (
        <main className="min-h-dvh bg-gray-100 px-4 py-6 sm:py-10" data-consent-page="form">
            <form onSubmit={submit} noValidate className="mx-auto w-full max-w-xl space-y-4">
                <header className="text-center space-y-2 pt-2">
                    <div className="w-14 h-14 shrink-0 mx-auto rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl"><i className="fa-solid fa-file-signature" aria-hidden="true"></i></div>
                    <h1 className="text-2xl font-black text-gray-900">{t("page.title")}</h1>
                    <p className="text-[11px] font-black uppercase tracking-widest text-gray-500">Conferencia: {view.conference}</p>
                </header>

                <section className={card}>
                    {view.first_name && <p className="text-base font-bold text-gray-900">{t("page.hello", { name: view.first_name })}</p>}
                    <p className="text-sm text-gray-700">{t("page.intro")}</p>
                    {view.minor === true && <p className="text-sm font-semibold text-amber-800 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3">{t("page.intro.minor")}</p>}
                    {view.state === "granted" && <p className="text-sm text-blue-800 bg-blue-50 border border-blue-100 rounded-2xl px-4 py-3">{t("page.already")}</p>}
                    <a href={view.policy.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 rounded-2xl border-2 border-gray-100 hover:border-blue-200 px-4 py-3 min-h-[52px]" data-consent-policy="">
                        <span className="min-w-0">
                            <span className="block text-sm font-bold text-blue-700">Política de Tratamiento de Datos</span>
                            <span className="block text-xs text-gray-500">{t("page.policy.version", { v: view.policy.version })} · <span style={{ overflowWrap: "anywhere" }}>{view.policy.url}</span></span>
                        </span>
                        <i className="fa-solid fa-arrow-up-right-from-square text-gray-400" aria-hidden="true"></i>
                    </a>
                </section>

                {whoNeeded && (
                    <section className={card} data-consent-field="who">
                        <h2 className={h2}>{t("page.who")}</h2>
                        <div className="grid gap-2" role="radiogroup" aria-label={t("page.who")}>
                            {(["self", "rep"] as const).map((k) => (
                                <button key={k} type="button" role="radio" aria-checked={who === k} onClick={() => { setWho(k); setErrors({ ...errors, who: "" }); }}
                                    className={`text-left min-h-[48px] rounded-2xl border-2 px-4 py-3 text-sm font-semibold ${who === k ? "border-blue-600 bg-blue-50 text-blue-900" : errors.who ? "border-rose-300" : "border-gray-100 text-gray-700 hover:border-gray-200"}`} data-consent-who={k}>
                                    {t(k === "self" ? "page.who.self" : "page.who.rep")}
                                </button>
                            ))}
                        </div>
                        {err("who")}
                    </section>
                )}

                {minor && (
                    <section className={card} data-consent-field="rep">
                        <h2 className={h2}>{t("page.rep.title")}</h2>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="sm:col-span-2">
                                <label htmlFor="rep-name" className="block text-xs font-bold text-gray-600 mb-1">{t("page.rep.name")}</label>
                                <input id="rep-name" className={input(!!errors.rep && !rep.name.trim())} value={rep.name} maxLength={120} autoComplete="name" onChange={(e) => setRep({ ...rep, name: e.target.value })} />
                            </div>
                            <div>
                                <label htmlFor="rep-doc" className="block text-xs font-bold text-gray-600 mb-1">{t("page.rep.document")}</label>
                                <input id="rep-doc" className={input(!!errors.rep && !rep.document.trim())} value={rep.document} maxLength={60} autoComplete="off" onChange={(e) => setRep({ ...rep, document: e.target.value })} />
                            </div>
                            <div>
                                <label htmlFor="rep-rel" className="block text-xs font-bold text-gray-600 mb-1">{t("page.rep.relationship")}</label>
                                <Select id="rep-rel" className={input(!!errors.rep && !rep.relationship)} value={rep.relationship} onChange={(e) => setRep({ ...rep, relationship: e.target.value })}>
                                    <option value="">{t("page.rep.choose")}</option>
                                    {view.relationships.map((r) => <option key={r} value={r}>{r}</option>)}
                                </Select>
                            </div>
                        </div>
                        {repOk && <p className="text-xs text-gray-600 bg-gray-50 rounded-xl px-3 py-2" data-consent-rep-line="">{repLine({ name: rep.name.trim().replace(/\s+/g, " "), document: rep.document.trim().replace(/\s+/g, " "), relationship: rep.relationship })}</p>}
                        {err("rep")}
                    </section>
                )}

                <section className={card}>
                    <h2 className={h2}>{t("page.boxes")}</h2>
                    {box("general", view.texts.general, true)}
                    {err("general")}
                    {box("health", view.texts.health, false)}
                    {boxes.health && view.health_field && (
                        <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-4 space-y-2" data-consent-field="health">
                            <p className="text-sm font-bold text-gray-900">{view.health_field.label || t("page.health.title")}</p>
                            <p className="text-xs text-gray-500">{t("page.health.hint")}</p>
                            <HealthConditionsInput id="consent-health" field={view.health_field} value={health} onChange={(v) => { setHealth(v); setErrors({ ...errors, health: "" }); }}
                                error={errors.health || null} labels={lang === "en" ? HEALTH_LABELS_EN : HEALTH_LABELS_ES} />
                        </div>
                    )}
                    {box("image", view.texts.image, false)}
                    <details className="text-xs text-gray-600">
                        <summary className="cursor-pointer font-semibold text-gray-700 min-h-[32px] flex items-center">{t("page.exact")}</summary>
                        <pre className="mt-2 whitespace-pre-wrap font-sans bg-gray-50 rounded-xl p-3 text-gray-700" data-consent-text="">{shown}</pre>
                    </details>
                </section>

                <section className={card} data-consent-field="code">
                    <h2 className={h2}>{t("page.sign")}</h2>
                    <p className="text-sm text-gray-700">{t("page.sign.hint", { email: view.email_masked })}</p>
                    {codeSent && (
                        <div>
                            <label htmlFor="consent-code" className="block text-xs font-bold text-gray-600 mb-1">{t("page.code.label")}</label>
                            <input id="consent-code" className={`${input(!!errors.code)} font-mono text-2xl tracking-[0.5em] text-center`} value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                                onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErrors({ ...errors, code: "" }); }} data-consent-code="" />
                        </div>
                    )}
                    {err("code")}
                    {note && <p className={`text-sm font-semibold rounded-xl px-3 py-2 ${note.tone === "rose" ? "text-rose-700 bg-rose-50 border border-rose-100" : note.tone === "emerald" ? "text-emerald-800 bg-emerald-50" : "text-blue-800 bg-blue-50"}`} role={note.tone === "rose" ? "alert" : "status"}>{note.text}</p>}
                    <div className="flex flex-col sm:flex-row gap-2">
                        {codeSent && (
                            <button type="submit" disabled={busy} className="flex-1 min-h-[52px] rounded-2xl bg-gray-900 text-white font-black text-xs uppercase tracking-widest disabled:opacity-60" data-consent-submit="">
                                {busy ? <i className="fa-solid fa-spinner animate-spin" aria-hidden="true"></i> : t("page.submit")}
                            </button>
                        )}
                        <button type="button" onClick={sendCode} disabled={busy || resendIn > 0}
                            className={`${codeSent ? "sm:w-auto px-5 border-2 border-gray-200 text-gray-700" : "flex-1 bg-gray-900 text-white"} min-h-[52px] rounded-2xl font-black text-xs uppercase tracking-widest disabled:opacity-60`} data-consent-send="">
                            {busy && !codeSent ? <i className="fa-solid fa-spinner animate-spin" aria-hidden="true"></i> : resendIn > 0 ? t("page.code.resend.in", { s: resendIn }) : codeSent ? t("page.code.resend") : t("page.code.send")}
                        </button>
                    </div>
                    <p className="text-center text-[11px] text-gray-400">{t("page.footer")}</p>
                </section>
            </form>
        </main>
    );
}
