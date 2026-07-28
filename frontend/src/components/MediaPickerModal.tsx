"use client";

import { useEffect, useRef } from "react";
import { MediaItem } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import MediaLibrarySelector from "./MediaLibrarySelector";

interface MediaPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (item: MediaItem) => void;
}

// Focusable descendants for the Tab trap (standard dialog set; -1 tabindex is skipped).
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function MediaPickerModal({ isOpen, onClose, onSelect }: MediaPickerModalProps) {
    const { t } = useI18n();
    const panelRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);

    // Dialog a11y: on open, remember the invoking element and move focus into the panel; a
    // capture-phase keydown closes on Escape and traps Tab inside the panel (capture so the picker's
    // own inputs can't swallow the keys first); on close, focus returns to the invoker.
    // Hooks run unconditionally — the `!isOpen` early return stays BELOW them.
    useEffect(() => {
        if (!isOpen) return;
        previousFocusRef.current = document.activeElement as HTMLElement | null;
        panelRef.current?.focus();

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
            }
            if (e.key !== "Tab") return;
            const panel = panelRef.current;
            if (!panel) return;
            const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
                .filter((el) => !el.hasAttribute("disabled"));
            if (focusables.length === 0) {
                e.preventDefault();
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey) {
                // Wrap backwards from the first focusable (or from the panel itself / outside).
                if (active === first || !panel.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else if (active === last || !panel.contains(active)) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            previousFocusRef.current?.focus();
            previousFocusRef.current = null;
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
            {/* Backdrop — a soft dark blur instead of a flat gray fill, matching the app's other modals. */}
            <div
                className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
                aria-hidden="true"
                onClick={onClose}
            ></div>

            {/* Modal Panel */}
            <div
                ref={panelRef}
                tabIndex={-1}
                className="relative bg-white rounded-2xl text-left overflow-hidden shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col outline-none"
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-headline"
            >
                <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
                    <h3 className="text-lg font-bold text-gray-900" id="modal-headline">
                        {t('media.picker.title')}
                    </h3>
                    <button onClick={onClose} aria-label={t('common.close')} className="w-9 h-9 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-900 flex items-center justify-center transition-colors">
                        <i className="fa-solid fa-xmark"></i>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4">
                    <MediaLibrarySelector
                        onSelect={(item) => {
                            onSelect(item);
                            onClose();
                        }}
                    />
                </div>

                <div className="px-6 py-3 border-t border-gray-100 flex justify-end">
                    <button
                        type="button"
                        className="inline-flex justify-center rounded-xl border border-gray-200 px-5 py-2 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                        onClick={onClose}
                    >
                        {t('common.cancel')}
                    </button>
                </div>
            </div>
        </div>
    );
}
