// @ts-nocheck
"use client";

/**
 * Admin page for the Cookie Consent plugin (/admin/plugin/cookie-consent).
 * Left: banner configuration with a live inline preview (the real public banner uses
 * public/banner.css — the preview mirrors it with Tailwind). Right: anonymous compliance stats.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-red-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8";

const DEFAULT_FORM = {
    enabled: false,
    message: "Usamos cookies para mejorar tu experiencia. Puedes aceptarlas o rechazarlas.",
    acceptLabel: "Aceptar",
    rejectLabel: "Rechazar",
    policyUrl: "",
    position: "bottom",
    theme: "dark",
    version: 1,
};

/** Inline mock of the public banner reflecting the current form state (module level — never nest). */
function BannerPreview({ form }) {
    const dark = form.theme !== "light";
    const corner = form.position === "corner";
    const boxCls = [
        "absolute flex flex-col gap-2 p-4 shadow-2xl",
        corner ? "right-3 bottom-3 left-auto max-w-[280px] rounded-2xl" : "left-0 right-0 bottom-0",
        dark ? "bg-gray-900 text-gray-50" : "bg-white text-gray-800 border border-gray-200",
    ].join(" ");
    return (
        <div className="relative h-64 rounded-2xl overflow-hidden border-2 border-dashed border-gray-200 bg-gray-50">
            {/* Fake page content behind the banner */}
            <div className="p-5 space-y-3 opacity-40 select-none" aria-hidden="true">
                <div className="h-4 w-1/3 bg-gray-300 rounded" />
                <div className="h-3 w-full bg-gray-200 rounded" />
                <div className="h-3 w-5/6 bg-gray-200 rounded" />
                <div className="h-3 w-2/3 bg-gray-200 rounded" />
                <div className="h-24 w-full bg-gray-200 rounded-xl" />
            </div>
            <div className={boxCls}>
                <p className="text-xs leading-relaxed m-0">{form.message || " "}</p>
                {form.policyUrl ? (
                    <span className={`text-[11px] underline ${dark ? "text-gray-300" : "text-gray-500"}`}>
                        Política de cookies
                    </span>
                ) : null}
                <div className="flex gap-2 justify-end flex-wrap">
                    <span className={`px-4 py-2 rounded-full text-[11px] font-bold cursor-default ${dark ? "bg-white/15 text-gray-50" : "bg-gray-100 text-gray-800"}`}>
                        {form.rejectLabel || "Rechazar"}
                    </span>
                    <span className={`px-4 py-2 rounded-full text-[11px] font-bold cursor-default ${dark ? "bg-gray-50 text-gray-900" : "bg-gray-900 text-white"}`}>
                        {form.acceptLabel || "Aceptar"}
                    </span>
                </div>
            </div>
        </div>
    );
}

/** One stat tile (module level — never nest components). */
function StatTile({ label, value, accent }) {
    return (
        <div className="bg-gray-50/80 rounded-2xl p-4 text-center">
            <p className={`text-2xl font-black tracking-tighter ${accent || "text-gray-900"}`}>{value}</p>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mt-1">{label}</p>
        </div>
    );
}

export default function CookieConsentAdminPage() {
    const [form, setForm] = useState(DEFAULT_FORM);
    const [reprompt, setReprompt] = useState(false);
    const [stats, setStats] = useState(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const loadConfig = async () => {
        try {
            const cfg = await api("/plugin/cookie-consent/config");
            setForm({ ...DEFAULT_FORM, ...cfg });
        } catch {
            // Keep defaults — the form is still editable and Save will surface any real error.
        }
    };
    const loadStats = async () => {
        try {
            setStats(await api("/plugin/cookie-consent/stats"));
        } catch {
            setStats(null);
        }
    };

    useEffect(() => { loadConfig(); loadStats(); }, []);

    const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            const wasReprompt = reprompt;
            const saved = await apiPost("/plugin/cookie-consent/config", { ...form, reprompt });
            setForm({ ...DEFAULT_FORM, ...saved });
            setReprompt(false);
            setMessage(
                wasReprompt
                    ? `Guardado — el banner volverá a mostrarse a todos los visitantes (versión ${saved.version}).`
                    : "Configuración guardada."
            );
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const total = stats?.total || 0;
    const accepted = stats?.accepted || 0;
    const rejected = stats?.rejected || 0;
    const acceptPct = total > 0 ? Math.round((accepted / total) * 100) : null;
    const last30 = stats?.last30 || [];
    const maxDay = Math.max(1, ...last30.map((d) => (d.accepted || 0) + (d.rejected || 0)));

    return (
        <div className="max-w-4xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Cookie Consent</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Banner de cookies (RGPD) en todo el sitio público + estadísticas anónimas
                </p>
            </div>

            {/* --- Configuration ------------------------------------------------------------------ */}
            <form onSubmit={save} className={`${cardCls} mb-8 space-y-5`}>
                <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={!!form.enabled}
                        onChange={(e) => setField("enabled", e.target.checked)}
                        className="w-5 h-5 accent-gray-900"
                    />
                    <span className="text-sm font-bold text-gray-800">Mostrar el banner en el sitio público</span>
                </label>

                <div>
                    <label className={labelCls}>Mensaje (máx. 500 caracteres)</label>
                    <textarea
                        value={form.message}
                        onChange={(e) => setField("message", e.target.value)}
                        maxLength={500}
                        rows={3}
                        className={inputCls}
                        required
                    />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Botón aceptar (máx. 40)</label>
                        <input type="text" value={form.acceptLabel} onChange={(e) => setField("acceptLabel", e.target.value)} maxLength={40} className={inputCls} />
                    </div>
                    <div>
                        <label className={labelCls}>Botón rechazar (máx. 40)</label>
                        <input type="text" value={form.rejectLabel} onChange={(e) => setField("rejectLabel", e.target.value)} maxLength={40} className={inputCls} />
                    </div>
                </div>

                <div>
                    <label className={labelCls}>URL de la política de cookies (opcional)</label>
                    <input
                        type="url"
                        value={form.policyUrl}
                        onChange={(e) => setField("policyUrl", e.target.value)}
                        maxLength={300}
                        placeholder="https://misitio.com/politica-de-cookies"
                        className={inputCls}
                    />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Posición</label>
                        <select value={form.position} onChange={(e) => setField("position", e.target.value)} className={inputCls}>
                            <option value="bottom">Barra inferior (todo el ancho)</option>
                            <option value="corner">Tarjeta en la esquina</option>
                        </select>
                    </div>
                    <div>
                        <label className={labelCls}>Tema</label>
                        <select value={form.theme} onChange={(e) => setField("theme", e.target.value)} className={inputCls}>
                            <option value="dark">Oscuro</option>
                            <option value="light">Claro</option>
                        </select>
                    </div>
                </div>

                <label className="flex items-start gap-3 cursor-pointer select-none bg-amber-50/60 border border-amber-100 rounded-2xl p-4">
                    <input
                        type="checkbox"
                        checked={reprompt}
                        onChange={(e) => setReprompt(e.target.checked)}
                        className="w-5 h-5 mt-0.5 accent-amber-600"
                    />
                    <span>
                        <span className="block text-sm font-bold text-gray-800">Volver a preguntar a todos</span>
                        <span className="block text-[11px] text-gray-500 mt-0.5">
                            Al guardar se invalida el consentimiento guardado de cada visitante y el banner se muestra de
                            nuevo (versión actual: {form.version}).
                        </span>
                    </span>
                </label>

                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[11px] text-gray-400">
                        El banner aparece en el sitio público cuando el plugin está activo y habilitado.
                    </p>
                    <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>

                {message && (
                    <div className={`text-sm px-4 py-3 rounded-xl ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                        {message}
                    </div>
                )}
            </form>

            {/* --- Live preview ------------------------------------------------------------------- */}
            <div className={`${cardCls} mb-8`}>
                <h2 className="font-bold text-gray-800 mb-4">Vista previa</h2>
                <BannerPreview form={form} />
                <p className="text-[11px] text-gray-400 mt-4 leading-relaxed">
                    Vista aproximada — en el sitio público el banner usa su propia hoja de estilos y se adapta al ancho
                    real de la página.
                </p>
            </div>

            {/* --- Stats ---------------------------------------------------------------------------- */}
            <div className={cardCls}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <h2 className="font-bold text-gray-800">Estadísticas de consentimiento</h2>
                    <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
                        Registro anónimo — sin datos personales
                    </span>
                </div>

                {stats === null ? (
                    <p className="text-sm text-gray-400">Sin datos todavía — las elecciones de los visitantes aparecerán aquí.</p>
                ) : (
                    <>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                            <StatTile label="Total" value={total} />
                            <StatTile label="Aceptados" value={accepted} accent="text-green-600" />
                            <StatTile label="Rechazados" value={rejected} accent="text-red-500" />
                            <StatTile label="% aceptación" value={acceptPct === null ? "—" : `${acceptPct}%`} accent="text-blue-600" />
                        </div>

                        {last30.length === 0 ? (
                            <p className="text-sm text-gray-400">Aún no hay elecciones registradas.</p>
                        ) : (
                            <div className="space-y-2">
                                <p className={labelCls}>Últimos 30 días con actividad</p>
                                {last30.map((d) => {
                                    const dayTotal = (d.accepted || 0) + (d.rejected || 0);
                                    const accW = Math.round(((d.accepted || 0) / maxDay) * 100);
                                    const rejW = Math.round(((d.rejected || 0) / maxDay) * 100);
                                    return (
                                        <div key={d.day} className="flex items-center gap-3 text-xs">
                                            <span className="w-24 shrink-0 font-mono text-gray-500">{d.day}</span>
                                            <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden flex">
                                                <div className="h-full bg-green-500" style={{ width: `${accW}%` }} />
                                                <div className="h-full bg-red-400" style={{ width: `${rejW}%` }} />
                                            </div>
                                            <span className="w-28 shrink-0 text-right text-gray-500">
                                                <span className="text-green-600 font-bold">{d.accepted || 0}</span>
                                                {" · "}
                                                <span className="text-red-500 font-bold">{d.rejected || 0}</span>
                                                {" / "}{dayTotal}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
