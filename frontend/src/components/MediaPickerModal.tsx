"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { MediaItem } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import MSym from "./editor/MSym";

// The plugin host exposes this modal from pluginBundleLoader. Keep the media grid in its own client
// chunk so importing the host surface does not eagerly evaluate next/image on SSR, workers or the
// Node-only plugin contract tests. The modal itself remains immediately available and the selector is
// loaded only when an open modal actually renders it.
const MediaLibrarySelector = dynamic(() => import("./MediaLibrarySelector"), {
    ssr: false,
    loading: () => (
        <div className="flex min-h-48 items-center justify-center text-sm text-[var(--ed-on-surface-variant)]">
            Loading media…
        </div>
    ),
});

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
        <div className="verso-editor-ui verso-dialog-layer fixed inset-0 flex items-center justify-center p-0 sm:p-4">
            {/* Backdrop isolates the foreground without becoming an extra stop in the tab order. */}
            <div
                className="absolute inset-0 bg-black/55 backdrop-blur-sm"
                aria-hidden="true"
                onClick={onClose}
            ></div>

            {/* Modal Panel */}
            <div
                ref={panelRef}
                tabIndex={-1}
                className="verso-dialog-surface relative h-dvh sm:h-auto w-full max-w-5xl max-h-dvh sm:max-h-[90dvh] rounded-none sm:rounded-[20px] text-left overflow-hidden border border-[var(--ed-outline-variant)] flex flex-col outline-none"
                role="dialog"
                aria-modal="true"
                aria-labelledby="media-picker-title"
            >
                <div className="min-h-16 flex justify-between items-center gap-3 px-4 sm:px-6 py-3 border-b border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]">
                    <div className="min-w-0">
                    <h3 className="text-base sm:text-lg font-semibold text-[var(--ed-on-surface)] truncate" id="media-picker-title">
                        {t('media.picker.title')}
                    </h3>
                    <p className="text-xs text-[var(--ed-on-surface-variant)]">{t('media.select')}</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label={t('common.close')} className="verso-icon-button w-11 h-11 rounded-xl text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] flex items-center justify-center transition-colors">
                        <MSym name="close" size={20} />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-hidden p-0 sm:p-4">
                    <MediaLibrarySelector
                        onSelect={(item) => {
                            onSelect(item);
                            onClose();
                        }}
                    />
                </div>

                <div className="px-4 sm:px-6 py-3 pb-[max(12px,env(safe-area-inset-bottom))] border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] flex justify-end">
                    <button
                        type="button"
                        className="min-h-11 inline-flex items-center justify-center rounded-xl border border-[var(--ed-outline-variant)] px-5 bg-[var(--ed-surface-container-lowest)] text-sm font-semibold text-[var(--ed-on-surface)] hover:bg-[var(--ed-surface-container)] transition-colors"
                        onClick={onClose}
                    >
                        {t('common.cancel')}
                    </button>
                </div>
            </div>
        </div>
    );
}
