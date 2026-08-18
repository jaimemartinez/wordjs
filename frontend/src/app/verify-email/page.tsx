"use client";

/**
 * /verify-email — el destino del enlace que el registro envía por correo.
 *
 * Pantalla de un solo acto: al montar lee `uid` y `token` de la query, los manda a
 * POST /auth/verify-email y enseña el resultado. Toda la decisión (validar la query, clasificar el
 * fallo, elegir la copia) vive en `./verifyLink`, que es lo que se prueba; aquí solo queda el
 * efecto y el pintado.
 *
 * EL POST SE HACE UNA SOLA VEZ. El token es de un solo uso: si el efecto se disparase dos veces —y
 * en modo estricto de React se dispara dos veces— el primero verificaría y el SEGUNDO recibiría el
 * 400 de «token ya consumido», así que la pantalla acabaría diciendo «enlace inválido» justo
 * después de haber verificado bien. El `startedRef` es lo que impide ese estado imposible.
 */

import { useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";
import {
    VERIFY_COPY,
    classifyVerifyFailure,
    markVerifiedHere,
    parseVerifyLink,
    wasVerifiedHere,
    type VerifyStatus,
    type VerifyTone,
} from "./verifyLink";

/** Color del icono por tono. Mismo lenguaje visual que /reset-password. */
const TONE_CLASS: Record<VerifyTone, string> = {
    busy: "text-blue-500",
    ok: "text-green-500",
    warn: "text-amber-500",
    error: "text-red-500",
};

function VerifyEmailInner() {
    const router = useRouter();
    const params = useSearchParams();
    // La lista blanca se aplica en el render, no en el efecto: un enlace mal formado es un estado
    // INICIAL («enlace incompleto»), no algo que descubramos después de pintar otra cosa.
    const link = useMemo(() => parseVerifyLink(params.get("uid"), params.get("token")), [params]);
    const [status, setStatus] = useState<VerifyStatus>(() => (link ? "verifying" : "missing"));
    // Guarda contra la doble invocación del efecto en modo estricto: el token es de un solo uso.
    const startedRef = useRef(false);

    useEffect(() => {
        if (!link || startedRef.current) return;
        startedRef.current = true;

        const store = typeof window !== "undefined" ? window.sessionStorage : null;
        let active = true;
        // Si este navegador ya confirmó esta cuenta no se vuelve a llamar: el token es de un solo uso
        // y el segundo intento devolvería un 400 que se leería como «tu enlace no vale».
        const settle: Promise<VerifyStatus> = wasVerifiedHere(link.uid, store)
            ? Promise.resolve<VerifyStatus>("already")
            : authApi.verifyEmail(link).then(
                  (): VerifyStatus => {
                      markVerifiedHere(link.uid, store);
                      return "success";
                  },
                  (err): VerifyStatus => classifyVerifyFailure(err)
              );

        settle.then((next) => {
            if (active) setStatus(next);
        });
        return () => {
            active = false;
        };
    }, [link]);

    const copy = VERIFY_COPY[status];

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-800 flex items-center justify-center gap-3">
                        <i className="fa-solid fa-rocket text-blue-600"></i>
                        WordJS
                    </h1>
                    <p className="text-gray-500 mt-2">Confirmación de correo</p>
                </div>

                <div className="text-center space-y-4" role="status" aria-live="polite">
                    <i className={`fa-solid ${copy.icon} ${TONE_CLASS[copy.tone]} text-4xl`}></i>
                    <h2 className="text-lg font-semibold text-gray-800">{copy.title}</h2>
                    <p className="text-sm text-gray-600 leading-relaxed">{copy.body}</p>
                    {copy.action && (
                        <button
                            type="button"
                            onClick={() => router.push("/login")}
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg font-medium transition-colors"
                        >
                            {copy.action}
                        </button>
                    )}
                </div>

                <div className="mt-6 text-center">
                    <a href="/" className="text-sm text-gray-500 hover:text-blue-600">
                        &larr; Volver al inicio
                    </a>
                </div>
            </div>
        </div>
    );
}

export default function VerifyEmailPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800" />}>
            <VerifyEmailInner />
        </Suspense>
    );
}
