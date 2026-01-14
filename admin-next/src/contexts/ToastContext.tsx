"use client";

import React, { createContext, useContext, useState, useCallback } from "react";

type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
    id: number;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    addToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const addToast = useCallback((message: string, type: ToastType = "info") => {
        const id = Date.now();
        setToasts((prev) => [...prev, { id, message, type }]);

        // Auto remove after 3 seconds
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 3000);
    }, []);

    const removeToast = (id: number) => {
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
                        onClick={() => removeToast(toast.id)}
                        className={`
                            min-w-[300px] p-4 rounded-xl shadow-lg border border-white/20 backdrop-blur-md cursor-pointer
                            transform transition-all duration-300 animate-in slide-in-from-right-full
                            flex items-center gap-3
                            ${toast.type === 'success' ? 'bg-green-600/90 text-white' : ''}
                            ${toast.type === 'error' ? 'bg-red-600/90 text-white' : ''}
                            ${toast.type === 'info' ? 'bg-blue-600/90 text-white' : ''}
                            ${toast.type === 'warning' ? 'bg-orange-600/90 text-white' : ''}
                        `}
                    >
                        <div className="text-xl">
                            {toast.type === 'success' && <i className="fa-solid fa-circle-check"></i>}
                            {toast.type === 'error' && <i className="fa-solid fa-circle-exclamation"></i>}
                            {toast.type === 'info' && <i className="fa-solid fa-circle-info"></i>}
                            {toast.type === 'warning' && <i className="fa-solid fa-triangle-exclamation"></i>}
                        </div>
                        <p className="font-medium text-sm">{toast.message}</p>
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
