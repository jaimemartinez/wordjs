// @ts-nocheck
"use client";

/**
 * Admin page for the YouTube Videos plugin (/admin/plugin/youtube).
 * Configure the channel (+ optional Data API key for full history), force a refresh, and preview
 * what the carousel will serve. API calls go through the host's api helpers (session cookie).
 */
import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";

const YoutubeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.517 3.545 12 3.545 12 3.545s-7.517 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.871.508 9.388.508 9.388.508s7.517 0 9.388-.508a3.003 3.003 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
  </svg>
);

const SyncIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
  </svg>
);

const SaveIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
    <polyline points="17 21 17 13 7 13 7 21"/>
    <polyline points="7 3 7 8 15 8"/>
  </svg>
);

const ExclamationIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const InfoIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="16" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>
);

const CalendarIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
);

const inputCls = "w-full px-4 py-3.5 bg-slate-50/50 border border-slate-200/70 rounded-2xl focus:ring-4 focus:ring-red-100/50 focus:border-red-500 focus:bg-white transition-all outline-none font-medium text-slate-800 placeholder-slate-400";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2";
const btnCls = "yt-primary-btn px-6 py-3.5 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer";

export default function YoutubeVideosAdminPage() {
    const [status, setStatus] = useState(null);
    const [channel, setChannel] = useState("");
    const [apiKey, setApiKey] = useState("");      // write-only: never echoed back by the server
    const [clearKey, setClearKey] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [preview, setPreview] = useState([]);
    const [cacheTtl, setCacheTtl] = useState(30);

    const handleImageError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
        const img = e.currentTarget;
        if (img.src.includes("maxresdefault.jpg")) {
            img.src = img.src.replace("maxresdefault.jpg", "sddefault.jpg");
        } else if (img.src.includes("sddefault.jpg")) {
            img.src = img.src.replace("sddefault.jpg", "hqdefault.jpg");
        } else {
            img.onerror = null;
        }
    };

    const loadStatus = async () => {
        try {
            const s = await api("/plugin/youtube-videos/status");
            setStatus(s);
            setChannel(s.channel || "");
            setCacheTtl(s.cacheTtl || 30);
        } catch {
            setStatus(null);
        }
    };
    const loadPreview = async () => {
        try {
            const res = await fetch("/api/v1/plugin/youtube-videos/?limit=8");
            const data = res.ok ? await res.json() : null;
            setPreview((data && data.videos) || []);
        } catch {
            setPreview([]);
        }
    };

    useEffect(() => { loadStatus(); loadPreview(); }, []);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage("");
        try {
            const body = { channel, cacheTtl };
            if (clearKey) body.apiKey = "";
            else if (apiKey.trim()) body.apiKey = apiKey.trim();
            const s = await apiPost("/plugin/youtube-videos/settings", body);
            setStatus(s); setApiKey(""); setClearKey(false);
            setMessage(s.error ? `Guardado, pero la carga falló: ${s.error}` : `Guardado — ${s.videoCount} videos (modo ${s.mode === "api" ? "API completa" : (s.mode === "scraper" ? "Scraper" : "RSS")}).`);
            loadPreview();
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const refresh = async () => {
        setBusy(true); setMessage("");
        try {
            const s = await apiPost("/plugin/youtube-videos/refresh", {});
            setStatus(s);
            setMessage(s.error ? `La carga falló: ${s.error}` : `Actualizado — ${s.videoCount} videos.`);
            loadPreview();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto p-4 sm:p-8 space-y-8">
            {/* Elegant Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-slate-100">
                <div>
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center text-white shadow-lg shadow-red-500/20">
                            <YoutubeIcon className="w-5 h-5" />
                        </div>
                        <h1 className="text-2xl sm:text-3xl font-black text-slate-800 tracking-tight">YouTube Videos</h1>
                    </div>
                    <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-2">
                        Configura la sincronización de videos para el editor visual
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {/* Configuration form */}
                <form onSubmit={save} className="yt-card md:col-span-2 rounded-3xl p-6 sm:p-8 space-y-6">
                    <h2 className="font-bold text-slate-800 text-lg flex items-center gap-2 pb-3 border-b border-slate-100/50">
                        Ajustes de Sincronización
                    </h2>
                    
                    <div className="space-y-4">
                        <div>
                            <label className={labelCls}>Canal (UC…, @handle o URL)</label>
                            <input type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="@micanal · UCxxxxxxxx · https://youtube.com/@micanal" className={inputCls} required />
                        </div>
                        <div>
                            <label className={labelCls}>Intervalo de Actualización de Caché (minutos)</label>
                            <input type="number" min="1" value={cacheTtl} onChange={(e) => setCacheTtl(Math.max(1, parseInt(e.target.value, 10) || 1))} placeholder="30" className={inputCls} required />
                            <span className="text-[10px] text-slate-400 mt-1 block">
                                Tiempo que el plugin mantendrá los vídeos guardados localmente antes de consultar a YouTube de nuevo (mínimo 1 minuto).
                            </span>
                        </div>
                        <div>
                            <label className={labelCls}>YouTube Data API v3 key (opcional)</label>
                            <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setClearKey(false); }} placeholder={status?.hasApiKey ? "(configurada — escribe para reemplazar)" : "(sin key: modo RSS, últimos 15 videos)"} className={inputCls} autoComplete="new-password" />
                            
                            <div className="mt-3 flex items-start gap-2 text-[11px] text-slate-400 leading-relaxed bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                                <InfoIcon className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                                <span>
                                    Sin API Key se utiliza el feed RSS público del canal (límite de 15 videos). Para obtener el historial completo (hasta 500 videos) ingresa una API Key válida.
                                </span>
                            </div>
                            
                            {status?.hasApiKey && (
                                <label className="flex items-center gap-2.5 mt-3 text-[11px] text-slate-500 font-semibold cursor-pointer select-none">
                                    <input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setApiKey(""); }} className="rounded border-slate-300 text-red-600 focus:ring-red-500" />
                                    <span>Quitar la API Key guardada (volver a modo RSS)</span>
                                </label>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 justify-end pt-4 border-t border-slate-100/50">
                        <button type="button" onClick={refresh} disabled={busy} className="px-5 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl font-bold text-xs uppercase tracking-widest transition-all disabled:opacity-50 flex items-center gap-2 cursor-pointer">
                            <SyncIcon className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
                            Actualizar
                        </button>
                        <button type="submit" disabled={busy} className={btnCls}>
                            <SaveIcon className="w-3.5 h-3.5" />
                            {busy ? "Guardando…" : "Guardar"}
                        </button>
                    </div>

                    {message && (
                        <div className={`text-xs font-semibold px-4 py-3.5 rounded-xl border flex items-center gap-2.5 ${/falló|Error/i.test(message) ? "bg-red-50/80 border-red-100 text-red-600" : "bg-emerald-50/80 border-emerald-100 text-emerald-700"}`}>
                            {/falló|Error/i.test(message) && <ExclamationIcon className="shrink-0 text-red-500" />}
                            <span>{message}</span>
                        </div>
                    )}
                </form>

                {/* Status card */}
                <div className="space-y-6">
                    <div className="yt-card rounded-3xl p-6">
                        <h3 className="font-bold text-slate-800 text-sm mb-4">Estado del Plugin</h3>
                        {status ? (
                            <div className="space-y-4 text-xs">
                                <div className="flex justify-between items-center py-2 border-b border-slate-100/50">
                                    <span className="text-slate-400 font-medium">Videos importados:</span>
                                    <span className="font-bold text-slate-700 bg-slate-100 px-2 py-1 rounded-lg">{status.videoCount}</span>
                                </div>
                                <div className="flex justify-between items-center py-2 border-b border-slate-100/50">
                                    <span className="text-slate-400 font-medium">Modo de carga:</span>
                                    <span className={`font-bold px-2 py-1 rounded-lg ${status.mode === "api" ? "bg-red-50 text-red-600 border border-red-100/50" : (status.mode === "scraper" ? "bg-amber-50 text-amber-600 border border-amber-100/50" : "bg-slate-100 text-slate-600")}`}>
                                        {status.mode === "api" ? "API v3" : (status.mode === "scraper" ? "Scraper (Sin API Key)" : "RSS Feed")}
                                    </span>
                                </div>
                                <div className="py-2">
                                    <span className="text-slate-400 font-medium block mb-1">Última actualización:</span>
                                    <span className="font-bold text-slate-600 flex items-center gap-1.5 mt-0.5">
                                        <CalendarIcon className="w-3.5 h-3.5 text-slate-400" />
                                        {status.fetchedAt ? new Date(status.fetchedAt).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }) : "Nunca"}
                                    </span>
                                </div>
                            </div>
                        ) : (
                            <div className="text-xs text-slate-400 flex items-center gap-2">
                                <ExclamationIcon className="w-4 h-4 text-slate-400" />
                                Cargando estado...
                            </div>
                        )}
                        {status?.error && (
                            <div className="text-[11px] font-semibold mt-4 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-100 text-amber-700">
                                Último error: {status.error}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Video preview section */}
            <div className="yt-card rounded-3xl p-6 sm:p-8">
                <h3 className="font-bold text-slate-800 text-lg mb-6 flex items-center gap-2">
                    <span>Vista Previa de Videos</span>
                    {preview.length > 0 && <span className="yt-badge text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full">En caché</span>}
                </h3>
                {preview.length === 0 ? (
                    <div className="py-12 text-center text-slate-400 text-xs">
                        Sin videos cargados aún. Configura el canal e importa los videos.
                    </div>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        {preview.map((v) => (
                            <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" className="group block yt-card-hover transition-all duration-300">
                                <div className="relative aspect-video rounded-2xl overflow-hidden border border-slate-100/80 shadow-[0_4px_12px_rgba(0,0,0,0.02)]">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={v.thumb} alt={v.title} className="w-full h-full object-cover group-hover:scale-105 transition duration-500" onError={handleImageError} />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                                <p className="text-[11px] font-medium text-slate-600 mt-2.5 line-clamp-2 group-hover:text-red-500 transition duration-300 leading-snug">{v.title}</p>
                            </a>
                        ))}
                    </div>
                )}
                
                <div className="mt-8 pt-6 border-t border-slate-100/50 flex items-start gap-2.5 text-[11px] text-slate-400 leading-relaxed">
                    <InfoIcon className="w-4.5 h-4.5 text-slate-400 mt-0.5 shrink-0" />
                    <span>
                        Para mostrar estos videos en tu sitio web, agrega el bloque <strong>YoutubeVideos</strong> en el editor visual. Podrás configurar filtros, límites de cantidad, reproducción automática e intervalos.
                    </span>
                </div>
            </div>
        </div>
    );
}
