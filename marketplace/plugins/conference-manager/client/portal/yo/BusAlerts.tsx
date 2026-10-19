// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Mi transporte» on «Mi inscripción» (conference-manager 2.27.0): the person's buses with their boarding state
 * («Programado», «Embarcando ahora», «Salió») and the transport team's notices, kept fresh while the page is open
 * (it asks every 30 s while visible, and at once when a notice arrives), plus the switch for the bus notices as
 * browser notifications (Web Push): this page registers its own service worker (/portal/conference/sw.js, scope
 * = this page) and hands the plugin the phone's push subscription, tied to this page's session.
 *
 * iPhone / iPad: Safari only delivers web notifications to a page added to the home screen (iOS 16.4+), so there
 * the switch explains how to do that instead.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";

export type BusNotice = { kind: "boarding" | "departed" | "message"; text: string | null; at: string | null };
export type Bus = {
    id: number; name: string; origin: string | null; destination: string | null; departure: string | null;
    status: "scheduled" | "boarding" | "departed"; boarding_at: string | null; departed_at: string | null;
    notices: BusNotice[];
};
type Post = (path: string, body: unknown) => Promise<{ status: number; body: any }>;

const SW_URL = "/portal/conference/sw.js";
const SW_SCOPE = "/portal/conference/yo";
const POLL_MS = 30000;

const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1));
const isStandalone = () => typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true);
const keyBytes = (b64u: string) => {
    const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64u.length % 4)) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
};
async function registration(): Promise<ServiceWorkerRegistration | null> {
    if (!pushSupported()) return null;
    const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    // 2.30.0: the worker moved from /portal/conference/yo-sw.js (a core file then) to the portal's own sw.js.
    // Registering the new script for the same scope updates that registration in place — its push
    // subscription, and so the notices this phone turned on, stay.
    const current = existing && (existing.active || existing.waiting || existing.installing);
    if (existing && current && new URL(current.scriptURL).pathname === SW_URL) return existing;
    return navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
}

/** Leaving the page on this phone: its push subscription goes too (the plugin drops it with the session). */
export async function dropPushSubscription() {
    try {
        const reg = pushSupported() ? await navigator.serviceWorker.getRegistration(SW_SCOPE) : null;
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (sub) await sub.unsubscribe();
    } catch { /* nothing to drop */ }
}

const clock = (iso: string | null) => {
    if (!iso) return "";
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return "";
    try { return new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit" }).format(t); } catch { return t.toLocaleTimeString(); }
};
const departureLabel = (v: string | null) => {
    if (!v) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v);
    if (!m) return v;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    try { return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(d); } catch { return v; }
};
const noticeText = (n: BusNotice) => (n.kind === "boarding" ? "Empezó el embarque." : n.kind === "departed" ? "El bus salió." : n.text || "");

type PushState = "unsupported" | "ios-home" | "denied" | "off" | "on" | "busy";

export function BusAlerts({ session, initial, pushKey, post, code }: { session: string; initial: Bus[]; pushKey: string | null; post: Post; code?: string }) {
    const [buses, setBuses] = useState<Bus[]>(initial);
    const [push, setPush] = useState<PushState>("busy");
    const [note, setNote] = useState("");
    const [fresh, setFresh] = useState<Set<number>>(new Set());
    const prev = useRef<Map<number, string>>(new Map(initial.map((b) => [b.id, b.status])));

    const refresh = useCallback(async () => {
        try {
            const r = await post("transport", { session });
            if (r.status !== 200 || !Array.isArray(r.body.transport)) return;
            const next: Bus[] = r.body.transport;
            // A bus whose state just changed is highlighted until the person looks at it.
            const changed = new Set<number>();
            for (const b of next) {
                const before = prev.current.get(b.id);
                if (before && before !== b.status && b.status !== "scheduled") changed.add(b.id);
            }
            prev.current = new Map(next.map((b) => [b.id, b.status]));
            if (changed.size) setFresh((f) => new Set([...f, ...changed]));
            setBuses(next);
        } catch { /* the next tick tries again */ }
    }, [post, session]);

    // Fresh while open: every 30 s while visible, at once on coming back and when a notice arrives.
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const start = () => { if (!timer) timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS); };
        const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
        const onMessage = (e: MessageEvent) => { if (e.data && e.data.type === "cm-bus-notice") refresh(); };
        start();
        document.addEventListener("visibilitychange", onVisible);
        if (pushSupported()) navigator.serviceWorker.addEventListener("message", onMessage);
        return () => {
            if (timer) clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
            if (pushSupported()) navigator.serviceWorker.removeEventListener("message", onMessage);
        };
    }, [refresh]);

    // Where the notices stand on this phone; a granted phone re-sends its subscription (the session may be new).
    useEffect(() => {
        let gone = false;
        (async () => {
            if (!pushKey) { setPush("unsupported"); return; }
            if (!pushSupported()) { setPush(isIos() && !isStandalone() ? "ios-home" : "unsupported"); return; }
            if (Notification.permission === "denied") { setPush("denied"); return; }
            if (Notification.permission !== "granted") { setPush("off"); return; }
            try {
                const reg = await registration();
                const sub = reg ? await reg.pushManager.getSubscription() : null;
                if (sub) {
                    const r = await post("push/subscribe", { session, subscription: sub.toJSON() });
                    if (!gone) setPush(r.status === 200 ? "on" : "off");
                } else if (!gone) setPush("off");
            } catch { if (!gone) setPush("off"); }
        })();
        return () => { gone = true; };
    }, [pushKey, post, session]);

    // iPhone outside Safari: the page's own address (with the code) to open in Safari.
    const selfUrl = code && typeof window !== "undefined" ? `${window.location.origin}/portal/conference/yo#c=${code}` : "";
    const copySelf = async () => {
        try { await navigator.clipboard.writeText(selfUrl); setNote("Enlace copiado: pégalo en Safari."); } catch { setNote(selfUrl); }
    };
    const enable = async () => {
        if (!pushKey) return;
        setPush("busy"); setNote("");
        try {
            const perm = await Notification.requestPermission();
            if (perm !== "granted") { setPush(perm === "denied" ? "denied" : "off"); return; }
            const reg = await registration();
            if (!reg) { setPush("unsupported"); return; }
            await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey) });
            const r = await post("push/subscribe", { session, subscription: sub.toJSON() });
            if (r.status === 200) { setPush("on"); setNote("Listo: te avisaremos cuando tu bus empiece a embarcar."); }
            else { setPush("off"); setNote(r.body.error || "No se pudieron activar los avisos."); }
        } catch { setPush("off"); setNote("No se pudieron activar los avisos en este navegador."); }
    };
    const disable = async () => {
        setPush("busy"); setNote("");
        try {
            const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
            const sub = reg ? await reg.pushManager.getSubscription() : null;
            if (sub) {
                await post("push/unsubscribe", { session, endpoint: sub.endpoint }).catch(() => undefined);
                await sub.unsubscribe();
            }
        } catch { /* off anyway */ }
        setPush("off");
    };

    if (!buses.length) return null;
    const section = "bg-white rounded-3xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-3";
    const h2 = "text-[11px] font-black uppercase tracking-widest text-gray-500 flex items-center gap-2";
    return (
        <section className={section} data-self-transport="">
            <h2 className={h2}><i className="fa-solid fa-bus" aria-hidden="true"></i>Mi transporte</h2>
            <ul className="space-y-3">
                {buses.map((b) => {
                    const route = [b.origin, b.destination].filter(Boolean).join(" → ");
                    const hot = fresh.has(b.id);
                    const tone = b.status === "boarding" ? "border-amber-300 bg-amber-50" : b.status === "departed" ? "border-gray-200 bg-gray-50" : "border-gray-100 bg-white";
                    return (
                        <li key={b.id} className={`rounded-2xl border-2 px-4 py-3 space-y-2 ${tone} ${hot ? "ring-4 ring-amber-200" : ""}`} data-bus-status={b.status}
                            onClick={() => hot && setFresh((f) => { const n = new Set(f); n.delete(b.id); return n; })}>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-base font-black text-gray-900" style={{ overflowWrap: "anywhere" }}>{b.name}</p>
                                    {route && <p className="text-sm text-gray-600" style={{ overflowWrap: "anywhere" }}>{route}</p>}
                                    {b.departure && <p className="text-xs text-gray-500"><i className="fa-regular fa-clock mr-1" aria-hidden="true"></i>{departureLabel(b.departure)}</p>}
                                </div>
                                {b.status === "boarding" ? (
                                    <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-amber-500 text-white px-3 py-1 text-[10px] font-black uppercase tracking-widest" role="status">
                                        <span className="w-2 h-2 rounded-full bg-white animate-pulse" aria-hidden="true"></span>Embarcando
                                    </span>
                                ) : b.status === "departed" ? (
                                    <span className="shrink-0 rounded-full bg-gray-800 text-white px-3 py-1 text-[10px] font-black uppercase tracking-widest">Salió</span>
                                ) : (
                                    <span className="shrink-0 rounded-full bg-gray-100 text-gray-600 px-3 py-1 text-[10px] font-black uppercase tracking-widest">Programado</span>
                                )}
                            </div>
                            {b.status === "boarding" && <p className="text-sm font-black text-amber-900">Tu bus está embarcando{b.boarding_at ? ` desde las ${clock(b.boarding_at)}` : ""}. Acércate al punto de salida con tu escarapela.</p>}
                            {b.status === "departed" && <p className="text-sm font-bold text-gray-700">El bus salió{b.departed_at ? ` a las ${clock(b.departed_at)}` : ""}.</p>}
                            {b.notices.some((n) => n.kind === "message") && (
                                <ul className="space-y-1.5" aria-label="Mensajes del bus">
                                    {b.notices.filter((n) => n.kind === "message").map((n, i) => (
                                        <li key={i} className="flex items-start gap-2 rounded-xl bg-white border border-gray-100 px-3 py-2 text-sm text-gray-800" data-bus-message="">
                                            <i className="fa-solid fa-bullhorn text-blue-600 mt-0.5" aria-hidden="true"></i>
                                            <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{noticeText(n)}{n.at && <span className="block text-[11px] text-gray-500">{clock(n.at)}</span>}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ul>

            <div className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-3 space-y-2" data-push-state={push}>
                {push === "on" ? (
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-bold text-emerald-800"><i className="fa-solid fa-bell mr-1.5" aria-hidden="true"></i>Avisos del bus activados en este teléfono.</p>
                        <button type="button" onClick={disable} className="shrink-0 min-h-[36px] px-3 rounded-xl bg-white border-2 border-gray-200 text-gray-700 font-black text-[10px] uppercase tracking-widest">Desactivar</button>
                    </div>
                ) : push === "off" || push === "busy" ? (
                    <>
                        <p className="text-sm text-gray-700">Recibe un aviso en este teléfono cuando tu bus empiece a embarcar, cuando salga o si hay un mensaje, aunque tengas la página cerrada.</p>
                        <button type="button" onClick={enable} disabled={push === "busy"} className="w-full min-h-[44px] rounded-2xl bg-gray-900 text-white font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-60" data-push-enable="">
                            <i className={`fa-solid ${push === "busy" ? "fa-spinner animate-spin" : "fa-bell"}`} aria-hidden="true"></i>Activar avisos del bus
                        </button>
                    </>
                ) : push === "denied" ? (
                    <p className="text-sm text-gray-700"><i className="fa-solid fa-bell-slash mr-1.5 text-gray-400" aria-hidden="true"></i>Los avisos están bloqueados en este navegador. Para recibirlos, permite las notificaciones de este sitio en los ajustes del navegador.</p>
                ) : push === "ios-home" ? (
                    <div className="space-y-2" data-push-ios="">
                        <p className="text-sm text-gray-700"><i className="fa-solid fa-mobile-screen mr-1.5 text-gray-400" aria-hidden="true"></i>En iPhone los avisos llegan solo si agregas esta página a tu pantalla de inicio <span className="font-black">desde Safari</span> (otros navegadores, como Brave o Chrome, no siempre lo permiten):</p>
                        <ol className="list-decimal pl-5 text-sm text-gray-700 space-y-0.5">
                            <li>Copia el enlace y ábrelo en <span className="font-black">Safari</span>.</li>
                            <li>Toca <span className="font-black">Compartir</span> › <span className="font-black">Agregar a inicio</span>.</li>
                            <li>Abre «Mi inscripción» desde el ícono, escribe tu documento y toca «Activar avisos del bus».</li>
                        </ol>
                        {selfUrl && (
                            <button type="button" onClick={copySelf} className="w-full min-h-[44px] rounded-2xl bg-white border-2 border-gray-200 text-gray-800 font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2" data-push-copy="">
                                <i className="fa-solid fa-link" aria-hidden="true"></i>Copiar enlace para Safari
                            </button>
                        )}
                    </div>
                ) : (
                    <p className="text-sm text-gray-600">Este navegador no recibe avisos: mantén esta página abierta para ver el estado de tu bus.</p>
                )}
                {note && <p className="text-xs font-bold text-gray-600" role="status">{note}</p>}
            </div>
        </section>
    );
}
