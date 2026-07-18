// @ts-nocheck
"use client";

/**
 * Admin page for the Image Lightbox plugin (/admin/plugin/lightbox).
 * Toggle the lightbox, toggle captions, adjust the content scope selector, and try a
 * two-thumbnail demo that reproduces the public overlay with equivalent Tailwind styles.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";

const MAX_SCOPE_LEN = 100;
const DEFAULT_SCOPE = ".wjs-content";

// Self-contained demo images (SVG data URIs — no network, no uploads needed).
function demoSvg(from, to, label) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='500'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs><rect width='800' height='500' fill='url(#g)'/><circle cx='650' cy='105' r='58' fill='rgba(255,255,255,0.35)'/><path d='M0 380 L180 250 L340 360 L520 220 L800 400 L800 500 L0 500 Z' fill='rgba(0,0,0,0.18)'/><text x='40' y='450' font-family='sans-serif' font-size='40' font-weight='bold' fill='white'>${label}</text></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
}

const DEMO_IMAGES = [
    { src: demoSvg("#6366f1", "#0ea5e9", "Costa al atardecer"), alt: "Costa al atardecer — imagen de demostración" },
    { src: demoSvg("#f59e0b", "#ef4444", "Montañas al amanecer"), alt: "Montañas al amanecer — imagen de demostración" },
];

// Module-level toggle row (never define a component inside a component).
function ToggleRow({ label, help, checked, onChange }) {
    return (
        <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
            <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-800">{label}</span>
                {help && <span className="block text-[11px] text-gray-400 mt-0.5 leading-relaxed">{help}</span>}
            </span>
            <span className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-gray-900" : "bg-gray-200"}`}>
                <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
            </span>
        </label>
    );
}

export default function ImageLightboxAdminPage() {
    const [enabled, setEnabled] = useState(true);
    const [captions, setCaptions] = useState(true);
    const [scope, setScope] = useState(DEFAULT_SCOPE);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [demoIndex, setDemoIndex] = useState(null); // null = demo overlay closed

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const cfg = await api("/plugin/image-lightbox/config");
                if (!alive || !cfg) return;
                setEnabled(cfg.enabled !== false);
                setCaptions(cfg.captions !== false);
                setScope(typeof cfg.scope === "string" && cfg.scope ? cfg.scope : DEFAULT_SCOPE);
            } catch {
                // Plugin inactive or request failed — keep the defaults visible.
            } finally {
                if (alive) setLoaded(true);
            }
        })();
        return () => { alive = false; };
    }, []);

    // Demo overlay: keyboard navigation + body scroll lock (mirrors the public behavior).
    useEffect(() => {
        if (demoIndex === null) return;
        const onKey = (e) => {
            if (e.key === "Escape") setDemoIndex(null);
            else if (e.key === "ArrowRight") setDemoIndex((i) => ((i ?? 0) + 1) % DEMO_IMAGES.length);
            else if (e.key === "ArrowLeft") setDemoIndex((i) => ((i ?? 0) - 1 + DEMO_IMAGES.length) % DEMO_IMAGES.length);
        };
        window.addEventListener("keydown", onKey);
        const saved = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            window.removeEventListener("keydown", onKey);
            document.body.style.overflow = saved;
        };
    }, [demoIndex]);

    const save = async (e) => {
        e.preventDefault();
        const s = scope.trim();
        if (!s) { setMessage("Error: el selector de ámbito no puede estar vacío."); return; }
        if (s.length > MAX_SCOPE_LEN) { setMessage(`Error: el selector de ámbito no puede superar los ${MAX_SCOPE_LEN} caracteres.`); return; }
        if (s.includes("<")) { setMessage('Error: el selector de ámbito no puede contener el carácter "<".'); return; }
        setBusy(true); setMessage("");
        try {
            const cfg = await apiPost("/plugin/image-lightbox/config", { enabled, captions, scope: s });
            setEnabled(cfg.enabled !== false);
            setCaptions(cfg.captions !== false);
            setScope(cfg.scope || DEFAULT_SCOPE);
            setMessage("Guardado — los cambios se aplican en la próxima carga de las páginas públicas.");
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const demo = demoIndex === null ? null : DEMO_IMAGES[demoIndex];

    return (
        <div className="max-w-3xl mx-auto p-4 sm:p-8">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Lightbox de imágenes</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        Clic para ampliar las imágenes del contenido en todo el sitio
                    </p>
                </div>
                <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full ${enabled ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                    {enabled ? "Activado" : "Desactivado"}
                </span>
            </div>

            <form onSubmit={save} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 mb-8 space-y-6">
                <ToggleRow
                    label="Activar el lightbox"
                    help="Al hacer clic en una imagen del contenido se abre ampliada sobre un fondo oscuro, con flechas y teclado (← → Esc)."
                    checked={enabled}
                    onChange={setEnabled}
                />
                <ToggleRow
                    label="Mostrar leyendas"
                    help="Usa el texto alternativo (alt) de la imagen como leyenda debajo de la vista ampliada."
                    checked={captions}
                    onChange={setCaptions}
                />
                <div>
                    <label className={labelCls}>Selector de ámbito (CSS)</label>
                    <input
                        type="text"
                        value={scope}
                        onChange={(e) => setScope(e.target.value)}
                        placeholder={DEFAULT_SCOPE}
                        maxLength={MAX_SCOPE_LEN}
                        className={inputCls}
                        disabled={!loaded}
                    />
                    <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                        Solo las imágenes dentro de elementos que coincidan con este selector abren el lightbox
                        (se admiten varios selectores separados por comas). El tema envuelve el contenido público
                        en <code className="px-1 py-0.5 bg-gray-100 rounded text-gray-600">.wjs-content</code>, el valor por defecto.
                        Si el selector no coincide con nada en la página, el script usa <code className="px-1 py-0.5 bg-gray-100 rounded text-gray-600">main</code> como respaldo.
                        Se ignoran las imágenes pequeñas (&lt;100px), las de la cabecera/menú/pie y las que enlazan a otras páginas.
                    </p>
                </div>
                <div className="flex items-center justify-end">
                    <button type="submit" disabled={busy || !loaded} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
                {message && (
                    <div className={`text-sm px-4 py-3 rounded-xl ${/^Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>{message}</div>
                )}
            </form>

            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                <h2 className="font-bold text-gray-800 mb-1">Demostración</h2>
                <p className="text-[11px] text-gray-400 mb-4 leading-relaxed">
                    Haz clic en una miniatura para ver el efecto tal y como se comporta en el sitio público
                    (flechas, teclado ← → Esc, clic en el fondo para cerrar).
                </p>
                <div className="grid grid-cols-2 gap-3 max-w-md">
                    {DEMO_IMAGES.map((img, i) => (
                        <button key={i} type="button" onClick={() => setDemoIndex(i)} className="group block text-left">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img.src} alt={img.alt} decoding="async" className="w-full aspect-video object-cover rounded-xl border border-gray-100 cursor-zoom-in group-hover:opacity-80 transition" />
                            <span className="block text-[11px] text-gray-500 mt-1 line-clamp-1">{img.alt}</span>
                        </button>
                    ))}
                </div>
            </div>

            {demo && (
                <div
                    className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Visor de imagen (demostración)"
                    onClick={() => setDemoIndex(null)}
                >
                    <figure className="m-0 flex flex-col items-center gap-3 max-w-[94vw]" onClick={(e) => e.stopPropagation()}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={demo.src} alt="" decoding="async" className="max-w-[94vw] max-h-[78vh] object-contain rounded-xl shadow-2xl" />
                        {captions && <figcaption className="text-white/85 text-sm text-center max-w-[80vw]">{demo.alt}</figcaption>}
                    </figure>
                    <button
                        type="button"
                        aria-label="Imagen anterior"
                        onClick={(e) => { e.stopPropagation(); setDemoIndex((i) => ((i ?? 0) - 1 + DEMO_IMAGES.length) % DEMO_IMAGES.length); }}
                        className="absolute left-4 top-1/2 -mt-6 w-12 h-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/25 text-white text-2xl transition"
                    >‹</button>
                    <button
                        type="button"
                        aria-label="Imagen siguiente"
                        onClick={(e) => { e.stopPropagation(); setDemoIndex((i) => ((i ?? 0) + 1) % DEMO_IMAGES.length); }}
                        className="absolute right-4 top-1/2 -mt-6 w-12 h-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/25 text-white text-2xl transition"
                    >›</button>
                    <button
                        type="button"
                        aria-label="Cerrar"
                        onClick={() => setDemoIndex(null)}
                        className="absolute top-4 right-4 w-12 h-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/25 text-white text-xl transition"
                    >×</button>
                    <div className="absolute top-6 left-6 text-white/60 text-xs font-bold tracking-widest">{(demoIndex ?? 0) + 1} / {DEMO_IMAGES.length}</div>
                </div>
            )}
        </div>
    );
}
