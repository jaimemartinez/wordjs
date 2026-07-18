// @ts-nocheck
"use client";

/**
 * Admin page for the Notification Bar plugin (/admin/plugin/announcement).
 * One form over the single 'notification_bar_config' option: message + CTA, colors,
 * position, dismissal, schedule window, and a "reprompt" checkbox that bumps the config
 * version so visitors who dismissed the bar see it again. Includes a live inline preview.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const checkCls = "w-4 h-4 rounded accent-gray-900";

const DEFAULT_CONFIG = {
    enabled: false,
    message: "",
    linkLabel: "",
    linkUrl: "",
    bgColor: "#111827",
    textColor: "#ffffff",
    position: "top",
    dismissible: true,
    starts_at: "",
    ends_at: "",
    version: 1,
};

export default function NotificationBarAdminPage() {
    const [cfg, setCfg] = useState(DEFAULT_CONFIG);
    const [reprompt, setReprompt] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [message, setMessage] = useState("");

    const set = (patch) => setCfg((c) => ({ ...c, ...patch }));

    useEffect(() => {
        (async () => {
            try {
                const c = await api("/plugin/notification-bar/config");
                setCfg({ ...DEFAULT_CONFIG, ...c });
            } catch {
                setMessage("Error: no se pudo cargar la configuración. ¿Está activo el plugin?");
            } finally {
                setLoaded(true);
            }
        })();
    }, []);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            const saved = await apiPost("/plugin/notification-bar/config", { ...cfg, reprompt });
            setCfg({ ...DEFAULT_CONFIG, ...saved });
            const bumped = reprompt;
            setReprompt(false);
            setMessage(bumped
                ? `Guardado — la barra se volverá a mostrar a todos (versión ${saved.version}).`
                : "Guardado — la configuración de la barra se actualizó.");
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="max-w-3xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Barra de Anuncios</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Aviso fijo en todo el sitio — mensaje, enlace, colores y programación
                </p>
            </div>

            {/* Live preview reflecting the current (unsaved) form values */}
            <div className="mb-8">
                <div className="flex items-center justify-between mb-2">
                    <span className={labelCls + " mb-0"}>Vista previa ({cfg.position === "bottom" ? "abajo del sitio" : "arriba del sitio"})</span>
                    <span className={`text-[10px] font-black uppercase tracking-widest ${cfg.enabled ? "text-green-600" : "text-gray-300"}`}>
                        {cfg.enabled ? "Activa" : "Desactivada"}
                    </span>
                </div>
                <div className="rounded-2xl overflow-hidden border border-gray-100 shadow-lg shadow-gray-200/40">
                    <div
                        className="relative flex items-center justify-center gap-3 px-12 py-3 text-sm"
                        style={{ backgroundColor: cfg.bgColor, color: cfg.textColor }}
                    >
                        <span className="text-center">
                            {cfg.message || "(escribe un mensaje abajo)"}
                            {cfg.linkUrl && cfg.linkLabel ? (
                                <span className="underline underline-offset-2 font-bold ml-3 whitespace-nowrap">{cfg.linkLabel}</span>
                            ) : null}
                        </span>
                        {cfg.dismissible ? (
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-lg leading-none opacity-75">×</span>
                        ) : null}
                    </div>
                </div>
            </div>

            <form onSubmit={save} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 space-y-5">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} className={checkCls} />
                    <span className="text-sm font-bold text-gray-800">Mostrar la barra en el sitio</span>
                </label>

                <div>
                    <label className={labelCls}>Mensaje</label>
                    <textarea
                        value={cfg.message}
                        onChange={(e) => set({ message: e.target.value })}
                        maxLength={300}
                        rows={2}
                        placeholder="Ej.: Envío gratis en pedidos superiores a 50 € hasta el domingo"
                        className={inputCls + " resize-y"}
                    />
                    <p className="text-[11px] text-gray-400 mt-1 text-right">{(cfg.message || "").length}/300</p>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Etiqueta del enlace (opcional)</label>
                        <input type="text" value={cfg.linkLabel} onChange={(e) => set({ linkLabel: e.target.value })} maxLength={60} placeholder="Ver ofertas" className={inputCls} />
                    </div>
                    <div>
                        <label className={labelCls}>URL del enlace (opcional)</label>
                        <input type="text" value={cfg.linkUrl} onChange={(e) => set({ linkUrl: e.target.value })} placeholder="https://… o /pagina" className={inputCls} />
                    </div>
                </div>

                <div className="grid sm:grid-cols-3 gap-4">
                    <div>
                        <label className={labelCls}>Color de fondo</label>
                        <div className="flex items-center gap-3">
                            <input type="color" value={cfg.bgColor} onChange={(e) => set({ bgColor: e.target.value })} className="w-12 h-12 rounded-xl border border-gray-200 cursor-pointer bg-transparent p-1" />
                            <span className="text-xs font-mono text-gray-500">{cfg.bgColor}</span>
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>Color del texto</label>
                        <div className="flex items-center gap-3">
                            <input type="color" value={cfg.textColor} onChange={(e) => set({ textColor: e.target.value })} className="w-12 h-12 rounded-xl border border-gray-200 cursor-pointer bg-transparent p-1" />
                            <span className="text-xs font-mono text-gray-500">{cfg.textColor}</span>
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>Posición</label>
                        <select value={cfg.position} onChange={(e) => set({ position: e.target.value })} className={inputCls}>
                            <option value="top">Superior (arriba)</option>
                            <option value="bottom">Inferior (abajo)</option>
                        </select>
                    </div>
                </div>

                <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input type="checkbox" checked={cfg.dismissible} onChange={(e) => set({ dismissible: e.target.checked })} className={checkCls} />
                    <span className="text-sm font-medium text-gray-700">Permitir cerrar la barra (botón ×)</span>
                </label>

                <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Mostrar desde (opcional)</label>
                        <input type="datetime-local" value={cfg.starts_at} onChange={(e) => set({ starts_at: e.target.value })} className={inputCls} />
                    </div>
                    <div>
                        <label className={labelCls}>Mostrar hasta (opcional)</label>
                        <input type="datetime-local" value={cfg.ends_at} onChange={(e) => set({ ends_at: e.target.value })} className={inputCls} />
                    </div>
                </div>
                {(cfg.starts_at || cfg.ends_at) ? (
                    <div className="flex justify-end -mt-2">
                        <button type="button" onClick={() => set({ starts_at: "", ends_at: "" })} className="text-[11px] font-bold uppercase tracking-widest text-gray-400 hover:text-red-500 transition-colors">
                            Quitar programación
                        </button>
                    </div>
                ) : null}

                <div className="bg-gray-50/80 rounded-2xl p-4">
                    <label className="flex items-start gap-3 cursor-pointer select-none">
                        <input type="checkbox" checked={reprompt} onChange={(e) => setReprompt(e.target.checked)} className={checkCls + " mt-0.5"} />
                        <span>
                            <span className="text-sm font-bold text-gray-800 block">Volver a mostrar a quienes la cerraron</span>
                            <span className="text-[11px] text-gray-400 leading-relaxed block mt-0.5">
                                Al guardar se incrementa la versión del aviso (actual: v{cfg.version}), así la barra reaparece para
                                los visitantes que ya la habían cerrado. Úsalo cuando cambies el mensaje.
                            </span>
                        </span>
                    </label>
                </div>

                <div className="flex items-center justify-end gap-3">
                    <button type="submit" disabled={busy || !loaded} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>

                {message && (
                    <div className={`text-sm px-4 py-3 rounded-xl ${/^Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                        {message}
                    </div>
                )}
            </form>

            <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                La barra se muestra en todas las páginas públicas mientras el plugin esté activo y "Mostrar la barra" esté
                marcado. Si defines un rango de fechas, solo aparece dentro de ese rango. El cierre se recuerda en el
                navegador del visitante hasta que incrementes la versión.
            </p>
        </div>
    );
}
