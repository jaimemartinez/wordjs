"use client";

import { useEffect, useId, useRef } from "react";

interface ConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDanger?: boolean;
}

export default function ConfirmationModal({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = "Confirm",
    cancelText = "Cancel",
    isDanger = false
}: ConfirmationModalProps) {
    const titleId = useId();
    const cancelRef = useRef<HTMLButtonElement>(null);

    // Escape-to-close (mirrors CommandPalette's keyboard contract).
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [isOpen, onClose]);

    // Initial focus to Cancel (the non-destructive default) when it opens.
    useEffect(() => {
        if (!isOpen) return;
        const t = setTimeout(() => cancelRef.current?.focus(), 20);
        return () => clearTimeout(t);
    }, [isOpen]);

    // Lock body scroll while open; restore the prior value on close/unmount.
    useEffect(() => {
        if (!isOpen) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => { document.body.style.overflow = prev; };
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in duration-200"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6">
                    <div className="flex items-center gap-3 mb-4">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDanger ? "bg-red-100 text-red-600" : "bg-blue-100 text-blue-600"}`}>
                            <i className={`fa-solid ${isDanger ? "fa-triangle-exclamation" : "fa-circle-info"} text-lg`}></i>
                        </div>
                        <h3 id={titleId} className="text-xl font-bold text-gray-900">{title}</h3>
                    </div>
                    {/* pre-line: callers pass multi-paragraph disclosures (\n\n) — collapsing them into one
                        run-on paragraph buries safety-critical lines (e.g. the port-25 "CAREFUL" warning). */}
                    <p className="text-gray-600 mb-6 leading-relaxed whitespace-pre-line break-words">
                        {message}
                    </p>
                    <div className="flex justify-end gap-3">
                        <button
                            ref={cancelRef}
                            onClick={onClose}
                            className="px-5 py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
                        >
                            {cancelText}
                        </button>
                        <button
                            onClick={() => {
                                onConfirm();
                                onClose();
                            }}
                            className={`px-5 py-2.5 rounded-lg text-white font-medium shadow-sm transition-colors ${isDanger
                                    ? "bg-red-600 hover:bg-red-700"
                                    : "bg-blue-600 hover:bg-blue-700"
                                }`}
                        >
                            {confirmText}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
