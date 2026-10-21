"use client";

/**
 * ── BackToTop ────────────────────────────────────────────────────────────────────────────────────
 *
 * A floating "scroll to top" control. The WHOLE block is a client island (the AccordionBlock pattern):
 * there is no SSR content to render — it is a fixed-position affordance that only becomes useful once
 * the visitor has scrolled, so a crawler / no-JS visitor loses nothing by not seeing it. The button is
 * still emitted in the initial HTML (hidden, `pointer-events:none`) and only reveals itself once
 * `scrollY` passes `showAfter`.
 *
 * Motion respects `prefers-reduced-motion`: the smooth-scroll animation is used ONLY when the author
 * opted in (`smoothScroll`) AND the visitor has not asked to reduce motion; otherwise it jumps.
 *
 * SECURITY: `icon` and `label` are author data. `label` is the accessible name (React-escaped as an
 * attribute). `icon` is coerced to a safe Font Awesome class token — anything else falls back to the
 * default — so a hand-edited value can never inject additional classes or markup.
 */
import { useEffect, useState } from "react";
import { bc, cx, safeCss } from "@/components/blocks/blockVars";
import type { PublicUiStrings } from "@/lib/public/uiStrings";

// Fixed offset from the block's chosen corner, as literal classes so Tailwind sees them. Logical
// `start`/`end` keep the corner correct under RTL.
const POSITION_CLASS: Record<string, string> = {
    br: "bottom-6 end-6",
    bl: "bottom-6 start-6",
};

// A Font Awesome icon token: `fa-arrow-up`, optionally a style prefix word. Reject anything else.
const ICON_TOKEN = /^[a-z0-9-]+(?: [a-z0-9-]+)?$/;

export default function BackToTopBlock({
    showAfter = 400,
    position = "br",
    smoothScroll = true,
    label,
    icon = "fa-arrow-up",
    css,
    ui,
}: {
    showAfter?: number;
    position?: string;
    smoothScroll?: boolean;
    label?: string;
    icon?: string;
    css?: React.CSSProperties;
    /** Site-language strings (lib/public/uiStrings), for the default accessible name. */
    ui?: Pick<PublicUiStrings, "backToTop">;
}) {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const threshold = Math.max(0, Number(showAfter) || 0);
        // On a phone the button sits ON the text column (there is no margin beside it), so it shows
        // only while the visitor scrolls back UP — when they are looking for the top — and steps aside
        // while they read down. Wider screens keep it whenever they are past the threshold.
        const narrow = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767.98px)") : null;
        let lastY = window.scrollY;
        const onScroll = () => {
            const y = window.scrollY;
            const past = y > threshold;
            if (!narrow?.matches) setVisible(past);
            else if (!past) setVisible(false);
            else if (Math.abs(y - lastY) > 4) setVisible(y < lastY);
            lastY = y;
        };
        setVisible(window.scrollY > threshold && !narrow?.matches); // deep-linked / restored scroll
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, [showAfter]);

    const toTop = () => {
        const reduce =
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: smoothScroll && !reduce ? "smooth" : "auto" });
    };

    const posClass = POSITION_CLASS[position === "bl" ? "bl" : "br"];
    const iconClass = typeof icon === "string" && ICON_TOKEN.test(icon.trim()) ? icon.trim() : "fa-arrow-up";
    const accessibleLabel = typeof label === "string" && label.trim() ? label : (ui?.backToTop || "Back to top");

    return (
        <button
            type="button"
            onClick={toTop}
            aria-label={accessibleLabel}
            className={cx(
                bc("back-to-top"),
                "fixed z-50 w-11 h-11 rounded-full flex items-center justify-center shadow-lg transition-all duration-300",
                "bg-[var(--wjs-color-primary,#2F6D86)] text-[var(--wjs-color-on-primary,#ffffff)] hover:bg-[var(--wjs-color-primary-dark,#266073)]",
                posClass,
                visible ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-2 pointer-events-none",
            )}
            style={safeCss(css)}
        >
            <i className={`fa-solid ${iconClass}`} aria-hidden="true"></i>
        </button>
    );
}
