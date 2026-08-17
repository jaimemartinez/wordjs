"use client";

// Client island for a page-content NavMenu whose mobile behaviour is "collapse": a hamburger that,
// below md, toggles the ALREADY-SERVER-RENDERED nav open and closed. The links live in `children`
// (rendered on the server by NavMenuBlock), so they are in the initial HTML for crawlers and no-JS
// visitors exactly as when expanded — this island only shows/hides them and flips aria-expanded. At
// md and up the panel is always visible and the button is hidden, so the desktop nav is untouched.
//
// Deliberately NOT the header's ChromeNavMobile: that one portals a full-height drawer into
// document.body and locks page scroll (a document-scoped global). In page content a menu is just
// another block and must own no document-level state, so the disclosure stays inline.
import { useId, useState } from "react";

export default function NavMenuMobile({ label, children }: { label: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    return (
        <div className="wjs-nav-menu-collapse">
            <button
                type="button"
                className="md:hidden inline-flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-main,#374151)] font-medium"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen((o) => !o)}
            >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
                {label}
            </button>
            {/* hidden on mobile until toggled; always shown from md up (the desktop nav) */}
            <div id={panelId} className={`${open ? "block" : "hidden"} md:block mt-2 md:mt-0`}>
                {children}
            </div>
        </div>
    );
}
