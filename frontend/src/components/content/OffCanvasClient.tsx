"use client";

/**
 * ── OffCanvas (client toggle island) ───────────────────────────────────────────────────────────────
 *
 * The interactive HALF of the OffCanvas block: a trigger button + overlay + slide-in panel. The panel
 * CHILDREN are rendered on the SERVER by OffCanvasBlock and handed in as `children`, so the drawer's
 * real content (typically a NavMenu) is already in the SSR HTML — this island only flips the open
 * state, class and `aria-expanded`, optionally locks body scroll and closes on Escape. It is
 * DELIBERATELY NOT portaled to document.body (unlike the header's ChromeNavMobile): a page-content
 * drawer owns no document-level DOM, so the panel stays block-scoped and `position:fixed` covers the
 * viewport from where it sits.
 *
 * Reuses the header's `.wjs-header-mobile-overlay` / `.wjs-header-mobile-panel` hook classes so a theme
 * styles this drawer with the rules it already ships. Logical `start`/`end` + rtl variants keep the
 * side correct under RTL. When `breakpoint` is md/lg the panel becomes static, inline content at and
 * above that width (and the trigger/overlay hide), so the block is a drawer only on small screens.
 *
 * Focus is MANAGED, not trapped: opening moves focus into the panel, closing returns it to the trigger
 * — no Tab cycle that could strand a keyboard user if the contract were wrong.
 */
import { useEffect, useId, useRef, useState } from "react";
import { cx } from "@/components/blocks/blockVars";

// Panel side: where it docks and which way it slides off when closed (rtl mirrors the axis).
const SIDE: Record<string, { pos: string; closed: string }> = {
    left: { pos: "start-0", closed: "-translate-x-full rtl:translate-x-full" },
    right: { pos: "end-0", closed: "translate-x-full rtl:-translate-x-full" },
};

// At/above the breakpoint the panel stops being a drawer and shows inline; the trigger + overlay hide.
// Literal class strings so Tailwind's scanner sees every variant.
const PANEL_BP: Record<string, string> = {
    always: "",
    md: "md:static md:h-auto md:w-full md:max-w-none md:translate-x-0 md:visible md:opacity-100 md:shadow-none md:z-auto md:bg-transparent md:p-0",
    lg: "lg:static lg:h-auto lg:w-full lg:max-w-none lg:translate-x-0 lg:visible lg:opacity-100 lg:shadow-none lg:z-auto lg:bg-transparent lg:p-0",
};
const HIDE_ABOVE_BP: Record<string, string> = { always: "", md: "md:hidden", lg: "lg:hidden" };

export default function OffCanvasClient({
    triggerLabel = "Menú",
    triggerIcon = "fa-bars",
    side = "left",
    breakpoint = "always",
    closeOnEsc = true,
    scrollLock = true,
    children,
}: {
    triggerLabel?: string;
    triggerIcon?: string;
    side?: string;
    breakpoint?: string;
    closeOnEsc?: boolean;
    scrollLock?: boolean;
    children?: React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const panelRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    // Escape-to-close + optional body-scroll-lock while open. Both are opt-out via the fields; the
    // cleanup restores the previous overflow so a second drawer on the page can't strand it hidden.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (closeOnEsc && e.key === "Escape") setOpen(false);
        };
        document.addEventListener("keydown", onKey);
        const previousOverflow = document.body.style.overflow;
        if (scrollLock) document.body.style.overflow = "hidden";
        // Move focus into the panel; hand it back to the trigger on close (managed, not trapped).
        const trigger = triggerRef.current;
        panelRef.current?.querySelector<HTMLElement>('button, a[href], [tabindex]')?.focus();
        return () => {
            document.removeEventListener("keydown", onKey);
            if (scrollLock) document.body.style.overflow = previousOverflow;
            trigger?.focus();
        };
    }, [open, closeOnEsc, scrollLock]);

    const sideKey = side === "right" ? "right" : "left";
    const s = SIDE[sideKey];
    const bp = breakpoint === "md" || breakpoint === "lg" ? breakpoint : "always";
    const iconClass = typeof triggerIcon === "string" && /^[a-z0-9-]+$/.test(triggerIcon.trim())
        ? triggerIcon.trim()
        : "fa-bars";
    const buttonLabel = typeof triggerLabel === "string" && triggerLabel.trim() ? triggerLabel : "Menú";

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={cx(
                    "wjs-offcanvas__trigger inline-flex items-center gap-2 px-4 py-2 rounded-md font-medium",
                    "bg-[var(--wjs-color-primary,#2F6D86)] text-[var(--wjs-color-on-primary,#ffffff)] hover:bg-[var(--wjs-color-primary-dark,#266073)] transition-colors",
                    HIDE_ABOVE_BP[bp],
                )}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen(true)}
            >
                <i className={`fa-solid ${iconClass}`} aria-hidden="true"></i>
                {buttonLabel}
            </button>

            {/* Overlay — click to dismiss; hidden at/above the breakpoint and when closed. */}
            <div
                className={cx(
                    "wjs-header-mobile-overlay wjs-offcanvas__overlay fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300",
                    HIDE_ABOVE_BP[bp],
                    open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
                )}
                onClick={() => setOpen(false)}
                aria-hidden="true"
            />

            {/* Panel — server-rendered children live here (crawlable). `invisible` when closed also
                removes it from the a11y + tab order; `aria-expanded` on the trigger conveys state. */}
            <div
                ref={panelRef}
                id={panelId}
                role="dialog"
                aria-modal="true"
                aria-label={buttonLabel}
                className={cx(
                    "wjs-header-mobile-panel wjs-offcanvas__panel fixed top-0 z-50 h-full w-80 max-w-[85vw] p-6 overflow-y-auto",
                    "bg-[var(--wjs-bg-surface,white)] shadow-2xl transition-all duration-300 ease-out",
                    s.pos,
                    open ? "translate-x-0 visible opacity-100" : cx(s.closed, "invisible opacity-0"),
                    PANEL_BP[bp],
                )}
            >
                <button
                    type="button"
                    className={cx(
                        "wjs-offcanvas__close absolute top-4 end-4 w-9 h-9 rounded-full flex items-center justify-center",
                        "bg-[var(--wjs-bg-muted,#f3f4f6)] text-[var(--wjs-color-text-muted,#4b5563)] hover:bg-[var(--wjs-border-subtle,#e5e7eb)] transition-colors",
                        HIDE_ABOVE_BP[bp],
                    )}
                    onClick={() => setOpen(false)}
                    aria-label="Cerrar"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
                {children}
            </div>
        </>
    );
}
