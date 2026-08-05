"use client";

import { useState } from "react";
import PublicSidebar from "./PublicSidebar";
import type { SidebarPosition } from "@/lib/themeLayout";

/**
 * Optional two-column content layout with the `sidebar-1` widget area, opt-in via the active theme's
 * theme.json `layout.sidebar` (boolean legacy or `{ position: "left" | "right" }`). When disabled (the
 * default for all themes that don't set it), it renders `children` unchanged — byte-identical to the
 * single-column layout, so there is zero regression. When enabled but the sidebar has no widgets, it
 * collapses back to full-width content (no empty column). `position` only reorders the desktop columns
 * (order utility, same DOM order) — mobile always stacks content first.
 */
export default function SidebarLayout({ enabled, position = "right", children }: { enabled: boolean; position?: SidebarPosition; children: React.ReactNode }) {
    const [hasWidgets, setHasWidgets] = useState(true);

    if (!enabled) return <>{children}</>;

    return (
        <div className={hasWidgets ? "flex flex-col lg:flex-row gap-[var(--wjs-sidebar-gap,2.5rem)]" : ""}>
            <div className="flex-1 min-w-0">{children}</div>
            {hasWidgets && (
                <aside className={`lg:w-[var(--wjs-sidebar-width,20rem)] shrink-0${position === "left" ? " lg:order-first" : ""}`}>
                    <PublicSidebar id="sidebar-1" onEmpty={() => setHasWidgets(false)} />
                </aside>
            )}
        </div>
    );
}
