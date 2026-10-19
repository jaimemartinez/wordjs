"use client";

/**
 * A registrant's badge (conference-manager 2.19.0) — the page their private link opens:
 * /portal/conference/badge#t=<token>. The token is read from the FRAGMENT (no request ever carries it) and
 * posted to the plugin, which answers the badge's display list and the static layer's image; the page draws it
 * (BadgeCard), offers the PDF (a short-lived ticket, then the file route), sharing, and a SCAN MODE: the code's
 * QR large (2.22.0; Code 128 bars before), the screen kept on, for the meal scanner.
 *
 * Nothing personal is rendered on the server; the layout marks the page noindex / no-referrer.
 */
import React, { useCallback, useEffect, useState } from "react";
import { csrfHeaders } from "@/lib/csrf";
import { BadgeCard, ScanQr, type DisplayList } from "./BadgeCard";

type View = { badge: DisplayList; plate: string | null; name: string; conference: string; code: string; expires_on: string | null };
type State = { kind: "loading" } | { kind: "ok"; view: View } | { kind: "error"; code: string; message: string };

const API = "/api/v1/plugin/conference-manager/public/badge";
const ERRORS: Record<string, [string, string]> = {
    not_found: ["Este enlace no es válido", "Revisa que lo hayas copiado completo, o pide uno nuevo a quien te lo envió."],
    inactive: ["Esta escarapela ya no está activa", "La inscripción fue cancelada. Si es un error, comunícate con los organizadores."],
    expired: ["Esta escarapela venció", "El evento ya terminó o el enlace llegó a su fecha límite."],
    disabled: ["Escarapelas no disponibles", "Los organizadores todavía no las han activado."],
    throttled: ["Demasiados intentos", "Espera unos minutos y vuelve a abrir el enlace."],
    network: ["No se pudo cargar", "Revisa tu conexión e inténtalo de nuevo."],
};

const tokenFromHash = (): string => {
    if (typeof window === "undefined") return "";
    const m = /(?:^#|&)t=([0-9a-f]{32})(?:&|$)/.exec(window.location.hash || "");
    return m ? m[1] : "";
};
const fmtDate = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    try { return new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" }).format(new Date(y, m - 1, day)); } catch { return d; }
};

export default function BadgePage() {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [token, setToken] = useState("");
    const [scan, setScan] = useState(false);
    const [busy, setBusy] = useState("");
    const [note, setNote] = useState("");

    const load = useCallback(async (t: string) => {
        if (!t) { setState({ kind: "error", code: "not_found", message: "" }); return; }
        setState({ kind: "loading" });
        try {
            const res = await fetch(`${API}/view`, {
                method: "POST", credentials: "include", cache: "no-store",
                headers: { "Content-Type": "application/json", ...csrfHeaders() },
                body: JSON.stringify({ token: t }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body && body.badge) setState({ kind: "ok", view: body as View });
            // A server error is «try again» (never «invalid link»); 429 only ever answers a link that does not exist.
            else if (res.status >= 500) setState({ kind: "error", code: "network", message: "" });
            else setState({ kind: "error", code: res.status === 429 ? "throttled" : (body && body.code) || "not_found", message: (body && body.error) || "" });
        } catch {
            setState({ kind: "error", code: "network", message: "" });
        }
    }, []);
    useEffect(() => {
        const t = tokenFromHash();
        setToken(t);
        load(t);
        const onHash = () => { const n = tokenFromHash(); setToken(n); load(n); };
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, [load]);

    // Scan mode keeps the screen on while it is open (where the browser allows it). The browser drops the lock
    // when the page is hidden, so it is asked for again on coming back; a lock that arrives after the mode closed
    // is released at once.
    useEffect(() => {
        if (!scan) return undefined;
        let lock: { release?: () => Promise<void> } | null = null;
        let open = true;
        const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
        const request = () => {
            nav.wakeLock?.request("screen").then((l) => {
                if (open) lock = l; else l.release().catch(() => { /* ignore */ });
            }).catch(() => { /* not supported, or the page is hidden */ });
        };
        request();
        const onVisible = () => { if (document.visibilityState === "visible") request(); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setScan(false); };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("keydown", onKey);
        return () => {
            open = false;
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("keydown", onKey);
            lock?.release?.().catch(() => { /* ignore */ });
        };
    }, [scan]);

    const downloadPdf = async () => {
        if (busy || !token) return;
        setBusy("pdf"); setNote("");
        try {
            const res = await fetch(`${API}/ticket`, {
                method: "POST", credentials: "include", cache: "no-store",
                headers: { "Content-Type": "application/json", ...csrfHeaders() },
                body: JSON.stringify({ token }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.d) { setNote(body.error || "No se pudo preparar el PDF."); return; }
            window.location.href = `/portal/conference/badge/file?d=${encodeURIComponent(body.d)}`;
        } catch { setNote("No se pudo preparar el PDF. Revisa tu conexión."); }
        finally { setBusy(""); }
    };
    const share = async (view: View) => {
        const url = window.location.href;
        const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
        try {
            if (nav.share) { await nav.share({ title: `Escarapela · ${view.conference}`, url }); return; }
        } catch (e) { if ((e as Error)?.name === "AbortError") return; }
        try { await navigator.clipboard.writeText(url); setNote("Enlace copiado."); } catch { setNote(url); }
    };

    if (state.kind === "loading") {
        return (
            <main className="min-h-dvh bg-gray-50 flex items-center justify-center p-6" data-badge-page="loading">
                <div className="text-gray-400 text-xs font-black uppercase tracking-widest"><i className="fa-solid fa-spinner animate-spin mr-2" aria-hidden="true"></i>Cargando escarapela…</div>
            </main>
        );
    }
    if (state.kind === "error") {
        const [title, text] = ERRORS[state.code] || ERRORS.not_found;
        return (
            <main className="min-h-dvh bg-gray-50 flex items-center justify-center p-6" data-badge-page="error" data-badge-error={state.code}>
                <div className="max-w-sm w-full bg-white rounded-3xl border border-gray-100 shadow-sm p-8 text-center space-y-3">
                    <div className="w-14 h-14 shrink-0 mx-auto rounded-2xl bg-gray-100 text-gray-400 flex items-center justify-center text-2xl"><i className="fa-solid fa-id-badge" aria-hidden="true"></i></div>
                    <h1 className="text-xl font-black text-gray-900">{title}</h1>
                    <p className="text-sm text-gray-600">{text}</p>
                    {state.code === "network" && <button type="button" onClick={() => load(token)} className="min-h-[44px] px-5 rounded-2xl bg-gray-900 text-white font-black text-[11px] uppercase tracking-widest">Reintentar</button>}
                </div>
            </main>
        );
    }

    const { view } = state;
    const vertical = view.badge.layout === "vertical";
    return (
        <main className="min-h-dvh bg-gray-100 px-4 py-6 sm:py-10" data-badge-page="ok">
            <div className="mx-auto w-full max-w-md space-y-5">
                <p className="text-center text-[11px] font-black uppercase tracking-widest text-gray-500">{view.conference}</p>
                <div className={`mx-auto ${vertical ? "max-w-[300px]" : ""} rounded-[18px] overflow-hidden shadow-2xl ring-1 ring-black/5 bg-white`} data-badge-card="">
                    <BadgeCard badge={view.badge} plate={view.plate} title={`Escarapela de ${view.name}`} />
                </div>
                {view.expires_on && <p className="text-center text-[11px] text-gray-500">Válida hasta el {fmtDate(view.expires_on)}.</p>}
                <div className="grid grid-cols-1 gap-2.5">
                    <button type="button" onClick={() => setScan(true)} data-badge-act="scan"
                        className="min-h-[52px] rounded-2xl bg-gray-900 text-white font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2">
                        <i className="fa-solid fa-qrcode" aria-hidden="true"></i>Mostrar para escanear
                    </button>
                    <div className="grid grid-cols-2 gap-2.5">
                        <button type="button" onClick={downloadPdf} disabled={busy === "pdf"} data-badge-act="pdf"
                            className="min-h-[48px] rounded-2xl bg-white border-2 border-gray-200 text-gray-800 font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-60">
                            <i className={`fa-solid ${busy === "pdf" ? "fa-spinner animate-spin" : "fa-file-pdf"}`} aria-hidden="true"></i>PDF
                        </button>
                        <button type="button" onClick={() => share(view)} data-badge-act="share"
                            className="min-h-[48px] rounded-2xl bg-white border-2 border-gray-200 text-gray-800 font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2">
                            <i className="fa-solid fa-share-nodes" aria-hidden="true"></i>Compartir
                        </button>
                    </div>
                </div>
                {note && <p className="text-center text-xs font-bold text-gray-600 break-all" role="status">{note}</p>}
                <p className="text-center text-[10px] text-gray-400">Este enlace es personal: no lo publiques.</p>
            </div>

            {scan && (
                <div role="dialog" aria-modal="true" aria-label="Código para escanear" data-badge-scan=""
                    className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center gap-5 p-6"
                    style={{ paddingTop: "max(24px, env(safe-area-inset-top))", paddingBottom: "max(24px, env(safe-area-inset-bottom))" }}
                    onClick={() => setScan(false)}>
                    <p className="text-lg font-black text-gray-900 text-center">{view.name}</p>
                    <ScanQr badge={view.badge} px={scanPx()} />
                    <p className="font-mono text-2xl font-black tracking-[0.3em] text-gray-900">{view.code}</p>
                    <p className="text-xs text-gray-500 text-center max-w-xs">Sube el brillo de la pantalla y muestra el código a la cámara de quien entrega. Toca para cerrar.</p>
                </div>
            )}
        </main>
    );
}

// Whole pixels per module that fit the screen (a camera reads crisp, equal modules best): a version-1 QR is
// 21 modules plus 4 light ones each side, and at most ~70% of the screen height is left for it.
function scanPx(): number {
    if (typeof window === "undefined") return 8;
    const side = Math.min(window.innerWidth - 48, window.innerHeight * 0.7, 560);
    return Math.max(4, Math.min(16, Math.floor(side / 29)));
}
