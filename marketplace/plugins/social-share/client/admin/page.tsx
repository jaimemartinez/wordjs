// @ts-nocheck
"use client";

/**
 * Admin page for the Social Share plugin (/admin/plugin/share).
 * Pure static guide — the plugin is 100% client-side, so there is nothing to configure and the
 * page makes NO API calls: it explains the Puck block, lists the supported networks, and shows a
 * non-functional visual preview of the buttons in the three sizes and shapes.
 */

import React from "react";

// Same 24x24 brand paths the Puck block draws (duplicated on purpose: each client entry stays
// standalone, matching the youtube-videos template layout).
const ICON_PATHS = {
    facebook: "M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.5 1.5-3.89 3.77-3.89 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.45 2.9h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94z",
    x: "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z",
    whatsapp: "M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.49s1.07 2.89 1.22 3.09c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2-1.41.25-.7.25-1.29.18-1.41-.07-.12-.27-.2-.57-.35zM12.05 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.9-9.88 2.64 0 5.13 1.03 7 2.9a9.82 9.82 0 0 1 2.89 7c0 5.45-4.44 9.88-9.9 9.88zm8.42-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.33.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.9 11.9 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.33 11.89-11.89 0-3.18-1.24-6.16-3.47-8.42z",
    linkedin: "M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z",
    telegram: "M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z",
    email: "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z",
    copyLink: "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
};

const NETWORKS = [
    { key: "facebook", name: "Facebook", color: "#1877f2", desc: "Abre el diálogo para compartir de Facebook" },
    { key: "x", name: "X (Twitter)", color: "#000000", desc: "Publica un post con el enlace y el título" },
    { key: "whatsapp", name: "WhatsApp", color: "#25d366", desc: "Comparte por chat (wa.me)" },
    { key: "linkedin", name: "LinkedIn", color: "#0a66c2", desc: "Comparte en tu red profesional" },
    { key: "telegram", name: "Telegram", color: "#229ed9", desc: "Comparte por Telegram (t.me)" },
    { key: "email", name: "Email", color: "#6b7280", desc: "Abre tu cliente de correo (mailto)" },
    { key: "copyLink", name: "Copiar enlace", color: "#374151", desc: "Copia la URL al portapapeles" },
];

const SIZES = [
    { label: "Pequeño", px: 32, icon: 16 },
    { label: "Mediano", px: 40, icon: 20 },
    { label: "Grande", px: 48, icon: 24 },
];

const SHAPES = [
    { label: "Círculo", radius: "50%" },
    { label: "Redondeado", radius: "12px" },
    { label: "Cuadrado", radius: "0" },
];

// Module-level components (never define a component inside a component).
function NetIcon({ d, px }) {
    return (
        <svg viewBox="0 0 24 24" width={px} height={px} fill="currentColor" aria-hidden="true">
            <path d={d} />
        </svg>
    );
}

// Non-functional preview chip — a span on purpose so nothing is clickable here.
function PreviewButton({ netKey, color, px, radius }) {
    return (
        <span
            className="inline-flex items-center justify-center text-white shrink-0"
            style={{ width: px, height: px, backgroundColor: color, borderRadius: radius }}
        >
            <NetIcon d={ICON_PATHS[netKey]} px={Math.round(px / 2)} />
        </span>
    );
}

const stepCls = "flex gap-3 items-start";
const stepNumCls = "shrink-0 w-6 h-6 rounded-full bg-gray-900 text-white text-[11px] font-black flex items-center justify-center";

export default function SocialShareAdminPage() {
    return (
        <div className="max-w-3xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Compartir Social</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Botones para compartir la página actual en redes sociales
                </p>
            </div>

            {/* How to use */}
            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 mb-8">
                <h2 className="font-bold text-gray-800 mb-4">Cómo usar</h2>
                <p className="text-sm text-gray-600 leading-relaxed mb-5">
                    Agrega el bloque <strong>SocialShare</strong> en el editor visual de cualquier página o entrada.
                    Los botones comparten la URL y el título de la página donde se muestran — no necesitan
                    configuración, claves ni llamadas al servidor.
                </p>
                <div className="space-y-3">
                    <div className={stepCls}>
                        <span className={stepNumCls}>1</span>
                        <p className="text-sm text-gray-600 leading-relaxed">Abre el editor visual de la página o entrada donde quieras los botones.</p>
                    </div>
                    <div className={stepCls}>
                        <span className={stepNumCls}>2</span>
                        <p className="text-sm text-gray-600 leading-relaxed">Arrastra el bloque <strong>SocialShare</strong> (categoría "Social") al contenido.</p>
                    </div>
                    <div className={stepCls}>
                        <span className={stepNumCls}>3</span>
                        <p className="text-sm text-gray-600 leading-relaxed">
                            Elige qué redes mostrar y ajusta el título, el tamaño (pequeño / mediano / grande),
                            la forma (círculo / redondeado / cuadrado), las etiquetas y la alineación.
                        </p>
                    </div>
                </div>
                <p className="text-[11px] text-gray-400 mt-5 leading-relaxed">
                    "Copiar enlace" usa el portapapeles del navegador y confirma con "¡Copiado!" durante 2 segundos.
                    "Email" abre el cliente de correo del visitante.
                </p>
            </div>

            {/* Supported networks */}
            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 mb-8">
                <h2 className="font-bold text-gray-800 mb-4">Redes soportadas</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {NETWORKS.map((n) => (
                        <div key={n.key} className="flex items-center gap-3 p-3 rounded-2xl bg-gray-50/60 border border-gray-100">
                            <PreviewButton netKey={n.key} color={n.color} px={40} radius="50%" />
                            <div className="min-w-0">
                                <p className="text-sm font-bold text-gray-800">{n.name}</p>
                                <p className="text-[11px] text-gray-400 leading-snug">{n.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Visual preview */}
            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                <h2 className="font-bold text-gray-800 mb-1">Vista previa</h2>
                <p className="text-[11px] text-gray-400 mb-5 leading-relaxed">
                    Muestra estática de los tres tamaños y las tres formas — los botones reales se agregan con el
                    bloque en el editor visual.
                </p>

                <div className="space-y-5">
                    {SIZES.map((s) => (
                        <div key={s.label}>
                            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                                {s.label} ({s.px} px)
                            </p>
                            <div className="flex flex-wrap items-center gap-2.5">
                                {NETWORKS.map((n) => (
                                    <PreviewButton key={n.key} netKey={n.key} color={n.color} px={s.px} radius="50%" />
                                ))}
                            </div>
                        </div>
                    ))}

                    <div className="pt-4 border-t border-gray-100">
                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Formas</p>
                        <div className="flex flex-wrap items-center gap-6">
                            {SHAPES.map((sh) => (
                                <div key={sh.label} className="flex flex-col items-center gap-2">
                                    <div className="flex items-center gap-2.5">
                                        {NETWORKS.slice(0, 3).map((n) => (
                                            <PreviewButton key={n.key} netKey={n.key} color={n.color} px={40} radius={sh.radius} />
                                        ))}
                                    </div>
                                    <p className="text-[11px] text-gray-400">{sh.label}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
