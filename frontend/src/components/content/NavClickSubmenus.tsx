"use client";

/**
 * NavMenu — the CLICK-trigger disclosure island (submenuTrigger="click").
 *
 * The CSS-only :focus-within reveal cannot implement a click mode: the only clickable element used
 * to be the parent <a href> itself, so a mouse click NAVIGATED before the panel was usable — and
 * Safari (macOS) never focuses links on click, so the dropdown never opened there at all. The fix is
 * a REAL toggle: the server renders the caret as a <button class="wjs-submenu-toggle" aria-expanded
 * aria-haspopup> (blocks.tsx, click mode only) and this island — ONE delegated listener set on the
 * wrapper, no per-item handlers, no re-render of the server markup — flips `data-open` on the
 * button's parent `li.wjs-has-submenu`. wordjs-ui.css opens
 * `.wjs-has-submenu[data-open="true"] > .wjs-chrome-submenu`.
 *
 * Close paths: Escape closes every open branch; a click outside the nav closes them; opening one
 * branch closes its non-ancestor siblings (ancestors stay open so a nested submenu can be walked).
 * Hover mode mounts NO island — it stays the zero-JS CSS reveal.
 *
 * `display: contents` keeps this wrapper out of layout: the server-rendered nav (and its md:hidden /
 * hidden md:block mobile split) renders exactly as it does without the island.
 */
import { useEffect, useRef } from "react";

export default function NavClickSubmenus({ children }: { children: React.ReactNode }) {
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const setOpen = (li: Element, open: boolean) => {
            if (open) li.setAttribute("data-open", "true");
            else li.removeAttribute("data-open");
            // The li's OWN toggle (`:scope >` — never a nested submenu's button).
            const btn = li.querySelector<HTMLElement>(":scope > span > .wjs-submenu-toggle");
            btn?.setAttribute("aria-expanded", open ? "true" : "false");
        };
        const closeAll = (except?: Element | null) => {
            for (const li of root.querySelectorAll('li.wjs-has-submenu[data-open="true"]')) {
                // Keep the ancestors of the branch being opened; close everything else.
                if (except && li.contains(except)) continue;
                setOpen(li, false);
            }
        };
        const onRootClick = (e: MouseEvent) => {
            const btn = (e.target as Element | null)?.closest?.(".wjs-submenu-toggle");
            if (!btn || !root.contains(btn)) return;
            e.preventDefault();
            const li = btn.closest("li.wjs-has-submenu");
            if (!li) return;
            const willOpen = li.getAttribute("data-open") !== "true";
            if (willOpen) {
                closeAll(li);
                setOpen(li, true);
            } else {
                // Closing a branch also closes anything open underneath it.
                for (const nested of li.querySelectorAll('li.wjs-has-submenu[data-open="true"]')) setOpen(nested, false);
                setOpen(li, false);
            }
        };
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node | null;
            if (t && root.contains(t)) return;
            closeAll();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeAll();
        };

        root.addEventListener("click", onRootClick);
        document.addEventListener("click", onDocClick);
        document.addEventListener("keydown", onKey);
        return () => {
            root.removeEventListener("click", onRootClick);
            document.removeEventListener("click", onDocClick);
            document.removeEventListener("keydown", onKey);
        };
    }, []);

    return (
        <div ref={rootRef} style={{ display: "contents" }}>
            {children}
        </div>
    );
}
