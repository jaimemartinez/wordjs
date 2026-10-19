"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { getStoredLanguage, t } from "@/lib/i18n";

type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
    id: string;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    addToast: (message: string, type?: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

/**
 * Where the toast stack sits on a PHONE. A desktop keeps it at the bottom right (the container's classes). Below
 * 640 px — and on a short touch screen, a phone held sideways (667–932 × ~390 px, past every width rule) — it sits
 * at the TOP, below the safe area: at the bottom (z 9999) it covered for three seconds the pinned action row of the
 * sheet or dialog open under it — the admin person sheet's «Editar · Cancelar inscripción · Eliminar», a payment's
 * «Devolver / Rechazar / Validar», the portal's «Enviar pago». Its right edge keeps 3.25rem free, so the ✕ of a
 * sheet's pinned header stays reachable under a long message. Unlayered on purpose: it wins over the Tailwind
 * utilities of the container (which sit in a cascade layer), and nothing changes from 640 px on a mouse screen.
 */
export const TOAST_PHONE_CSS = `@media (max-width: 639.98px), (max-height: 500px) and (pointer: coarse) {
  [data-wjs-toasts] { top: max(1rem, env(safe-area-inset-top)); bottom: auto; left: max(1rem, env(safe-area-inset-left)); right: calc(max(1rem, env(safe-area-inset-right)) + 3.25rem); }
}`;

const TONE: Record<ToastType, string> = {
    success: "bg-green-600/95 text-white",
    error: "bg-red-600/95 text-white",
    info: "bg-blue-600/95 text-white",
    warning: "bg-orange-600/95 text-white",
};
const ICON: Record<ToastType, string> = {
    success: "fa-circle-check",
    error: "fa-circle-exclamation",
    info: "fa-circle-info",
    warning: "fa-triangle-exclamation",
};

/**
 * One toast. Its ✕ has a name (`closeLabel`: «Cerrar» / «Close» / «Fechar») and a 44 × 44 px target: on a phone the
 * stack sits at the top of the screen, over a sheet's title, and an icon-only 22 px button read «botón» to a
 * screen reader and was hard to hit (2.18.0 review UX6-10). The negative margin keeps the toast's own size.
 */
export function ToastItem({ toast, onClose, closeLabel }: { toast: Toast; onClose: () => void; closeLabel: string }) {
    return (
        <div
            className={`
                sm:min-w-[300px] max-w-[400px] p-4 rounded-xl shadow-lg border border-white/20 backdrop-blur-md
                transform transition-all duration-300 animate-in slide-in-from-right-full
                flex items-start gap-3 relative overflow-hidden
                ${TONE[toast.type] || ''}
            `}
            data-toast={toast.type}
        >
            <div className="text-xl mt-0.5 shrink-0">
                <i className={`fa-solid ${ICON[toast.type] || ICON.info}`} aria-hidden="true"></i>
            </div>

            <div className="flex-1 mr-2">
                <p className="font-medium text-sm leading-snug break-words">{toast.message}</p>
            </div>

            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                }}
                aria-label={closeLabel}
                className="shrink-0 min-w-11 min-h-11 -m-3 flex items-center justify-center rounded-full hover:bg-white/20 transition-colors"
                data-toast-close=""
            >
                <i className="fa-solid fa-xmark text-sm" aria-hidden="true"></i>
            </button>
        </div>
    );
}

/**
 * The ✕'s name in the language the admin uses (the one I18nProvider applies, stored per browser), «Cerrar» when it
 * cannot be read. Only called while a toast is shown (in the browser).
 */
export function toastCloseLabel(): string {
    try { return t("common.close", getStoredLanguage()) || "Cerrar"; } catch { return "Cerrar"; }
}

/** `closeLabel`: the ✕'s name where the page has its own language (the Spanish coordinator portal); else toastCloseLabel. */
export function ToastProvider({ children, closeLabel }: { children: React.ReactNode; closeLabel?: string }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const addToast = useCallback((message: string, type: ToastType = "info", duration: number = 3000) => {
        const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        setToasts((prev) => [...prev, { id, message, type }]);

        // Auto remove if duration > 0
        if (duration > 0) {
            setTimeout(() => {
                setToasts((prev) => prev.filter((t) => t.id !== id));
            }, duration);
        }
    }, []);

    const removeToast = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };

    return (
        <ToastContext.Provider value={{ addToast }}>
            {children}
            {/* Toast Container. 1rem from the edges, or the safe area: the admin viewport is
                viewport-fit=cover, so a fixed stack at bottom-4/left-4/right-4 sat under the home indicator,
                and in landscape under the notch / rounded corner (env() is 0 everywhere else). */}
            {/* On a phone the stack moves to the top (TOAST_PHONE_CSS): never over a sheet's bottom action row.
                A polite live region: a screen reader says what happened (an error toast was silent). */}
            <style>{TOAST_PHONE_CSS}</style>
            <div data-wjs-toasts="" data-wjs-host-ui="" role="status" aria-live="polite" className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] sm:left-auto z-[9999] flex flex-col gap-2">
                {toasts.map((toast) => (
                    <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} closeLabel={closeLabel ?? toastCloseLabel()} />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error("useToast must be used within a ToastProvider");
    }
    return context;
}
