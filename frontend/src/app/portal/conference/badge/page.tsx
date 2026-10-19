"use client";

/**
 * A badge link (conference-manager 2.19.0) — /portal/conference/badge#t=<token>, the link the administration or a
 * coordinator shares. 2.28.0: the link no longer shows the badge — it carried no check at all. The token (read
 * from the FRAGMENT, never sent by any request but this one) is posted to the plugin, which answers only where the
 * person confirms their identity document: «Mi inscripción», /portal/conference/yo#c=<code>, where the badge, its
 * PDF and the rest of their registration show after the document. This page goes there; with that page off, the
 * link says so and shows nothing.
 *
 * Nothing personal is rendered on the server; the layout marks the page noindex / no-referrer.
 */
import React, { useCallback, useEffect, useState } from "react";
import { csrfHeaders } from "@/lib/csrf";

type State = { kind: "loading" } | { kind: "error"; code: string };

const API = "/api/v1/plugin/conference-manager/public/badge";
const SELF = /^\/portal\/conference\/yo#c=[A-Z0-9]{10}$/;
const ERRORS: Record<string, [string, string]> = {
    not_found: ["Este enlace no es válido", "Revisa que lo hayas copiado completo, o pide uno nuevo a quien te lo envió."],
    inactive: ["Esta escarapela ya no está activa", "La inscripción fue cancelada. Si es un error, comunícate con los organizadores."],
    expired: ["Esta escarapela venció", "El evento ya terminó o el enlace llegó a su fecha límite."],
    disabled: ["Escarapelas no disponibles", "Los organizadores todavía no las han activado."],
    self_off: ["Este enlace ya no muestra la escarapela", "Escanea el código QR de tu escarapela impresa, o pide ayuda a los organizadores."],
    throttled: ["Demasiados intentos", "Espera unos minutos y vuelve a abrir el enlace."],
    network: ["No se pudo cargar", "Revisa tu conexión e inténtalo de nuevo."],
};

const tokenFromHash = (): string => {
    if (typeof window === "undefined") return "";
    const m = /(?:^#|&)t=([0-9a-f]{32})(?:&|$)/.exec(window.location.hash || "");
    return m ? m[1] : "";
};

export default function BadgeLinkPage() {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [token, setToken] = useState("");

    const load = useCallback(async (t: string) => {
        if (!t) { setState({ kind: "error", code: "not_found" }); return; }
        setState({ kind: "loading" });
        try {
            const res = await fetch(`${API}/view`, {
                method: "POST", credentials: "include", cache: "no-store",
                headers: { "Content-Type": "application/json", ...csrfHeaders() },
                body: JSON.stringify({ token: t }),
            });
            const body = await res.json().catch(() => ({}));
            // Only ever to «Mi inscripción» — never to an address the answer could carry otherwise.
            if (res.ok && body && typeof body.self === "string" && SELF.test(body.self)) { window.location.replace(body.self); return; }
            // A server error is «try again» (never «invalid link»); 429 only ever answers a link that does not exist.
            if (res.status >= 500) setState({ kind: "error", code: "network" });
            else setState({ kind: "error", code: res.status === 429 ? "throttled" : (body && body.code) || "not_found" });
        } catch {
            setState({ kind: "error", code: "network" });
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

    if (state.kind === "loading") {
        return (
            <main className="min-h-dvh bg-gray-50 flex items-center justify-center p-6" data-badge-page="loading">
                <div className="text-gray-400 text-xs font-black uppercase tracking-widest"><i className="fa-solid fa-spinner animate-spin mr-2" aria-hidden="true"></i>Cargando…</div>
            </main>
        );
    }
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
