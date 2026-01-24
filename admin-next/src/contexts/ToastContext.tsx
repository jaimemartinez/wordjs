"use client";

import React, { createContext, useContext, useState, useCallback } from "react";

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

export function ToastProvider({ children }: { children: React.ReactNode }) {
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
            {/* Toast Container */}
            <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        className={`
                            min-w-[300px] max-w-[400px] p-4 rounded-xl shadow-lg border border-white/20 backdrop-blur-md
                            transform transition-all duration-300 animate-in slide-in-from-right-full
                            flex items-start gap-3 relative overflow-hidden
                            ${toast.type === 'success' ? 'bg-green-600/95 text-white' : ''}
                            ${toast.type === 'error' ? 'bg-red-600/95 text-white' : ''}
                            ${toast.type === 'info' ? 'bg-blue-600/95 text-white' : ''}
                            ${toast.type === 'warning' ? 'bg-orange-600/95 text-white' : ''}
                        `}
                    >
                        <div className="text-xl mt-0.5 shrink-0">
                            {toast.type === 'success' && <i className="fa-solid fa-circle-check"></i>}
                            {toast.type === 'error' && <i className="fa-solid fa-circle-exclamation"></i>}
                            {toast.type === 'info' && <i className="fa-solid fa-circle-info"></i>}
                            {toast.type === 'warning' && <i className="fa-solid fa-triangle-exclamation"></i>}
                        </div>

                        <div className="flex-1 mr-2">
                            <p className="font-medium text-sm leading-snug break-words">{toast.message}</p>
                        </div>

                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                removeToast(toast.id);
                            }}
                            className="shrink-0 p-1 -mt-1 -mr-1 rounded-full hover:bg-white/20 transition-colors"
                        >
                            <i className="fa-solid fa-xmark text-sm"></i>
                        </button>
                    </div>
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
