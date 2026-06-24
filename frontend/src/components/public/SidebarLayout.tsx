"use client";

import { useState } from "react";
import PublicSidebar from "./PublicSidebar";

/**
 * Optional two-column content layout with the `sidebar-1` widget area, opt-in via the active theme's
 * theme.json `layout.sidebar`. When disabled (the default for all themes that don't set it), it renders
 * `children` unchanged — byte-identical to the single-column layout, so there is zero regression. When
 * enabled but the sidebar has no widgets, it collapses back to full-width content (no empty column).
 */
export default function SidebarLayout({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
    const [hasWidgets, setHasWidgets] = useState(true);

    if (!enabled) return <>{children}</>;

    return (
        <div className={hasWidgets ? "flex flex-col lg:flex-row gap-10" : ""}>
            <div className="flex-1 min-w-0">{children}</div>
            {hasWidgets && (
                <aside className="lg:w-80 shrink-0">
                    <PublicSidebar id="sidebar-1" onEmpty={() => setHasWidgets(false)} />
                </aside>
            )}
        </div>
    );
}
