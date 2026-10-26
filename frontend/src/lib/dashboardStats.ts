/**
 * What the admin dashboard shows to whom.
 *
 * Every number and panel on the dashboard is fed by an API the viewer may or may not be allowed to read.
 * The page used to draw them all and leave the ones it could not load at their initial 0: an editor saw
 * «0 USUARIOS» (GET /users needs `list_users`), a contributor «0 COMENTARIOS» and an empty «Comentarios
 * recientes» panel (the dashboard only loads comments for `moderate_comments`), and every non-administrator
 * an empty activity chart (GET /analytics/stats is administrators-only, backend routes/analytics.ts
 * `isAdmin`, which checks the ROLE). The system-health panel asked GET /health/details (also `isAdmin`)
 * for any `manage_options` holder: for a non-administrator role with that capability the 403 rejected
 * the whole dashboard load and EVERY count stayed 0. A number the viewer cannot read is not shown at all;
 * neither is a panel that could only ever be empty for them.
 *
 * Below dashboardSections: the class names of the dashboard's grids and of a health indicator's label.
 */

export type DashboardStatKey = "posts" | "pages" | "comments" | "users";

export interface DashboardViewer {
    role?: string;
    /** Multisite only (absent on a single site): the viewer's place in the network. */
    network?: { mainSite: boolean; networkAdmin: boolean };
}

export interface DashboardSections {
    /** The stat cards, in display order. */
    stats: DashboardStatKey[];
    /** The «Comentarios recientes» panel (and the comments count's data). */
    recentComments: boolean;
    /** The activity chart (GET /analytics/stats). */
    activityChart: boolean;
    /** The system-health panel (GET /health/details). */
    systemHealth: boolean;
}

/**
 * The dashboard's parts this viewer may read. `can` is AuthContext.can (administrators and `*` hold
 * everything). Posts and pages are listed for every dashboard viewer (the page itself requires
 * `edit_posts`; GET /posts answers them).
 */
export function dashboardSections(viewer: DashboardViewer | null | undefined, can: (capability: string) => boolean): DashboardSections {
    const stats: DashboardStatKey[] = ["posts", "pages"];
    const moderates = can("moderate_comments");
    if (moderates) stats.push("comments");
    if (can("list_users")) stats.push("users");
    // Both endpoints gate on the administrator ROLE, not on a capability: mirror that exactly.
    const administrator = viewer?.role === "administrator";
    return {
        stats,
        recentComments: moderates,
        activityChart: administrator,
        // In a network GET /health/details is the main site's, for network administrators only.
        systemHealth: administrator && (!viewer?.network || (viewer.network.mainSite && viewer.network.networkAdmin)),
    };
}

/*
 * THE DASHBOARD'S GRIDS ARE SIZED BY THEIR OWN WIDTH, AND NO LABEL BREAKS INSIDE A WORD.
 *
 * Every grid below sits in a `@container` wrapper and picks its columns by the room IT has (container
 * queries), not by the window's width — the window said nothing about that room. Beside the 320 px
 * sidebar and the «Comentarios recientes» column the system-health panel at 1280 px is ~565 px wide, and
 * its `sm:grid-cols-3` made three ~178 px cards whose label line (~72 px) was narrower than
 * «ALMACENAMIENTO»: `break-words` cut it «ALMACENAM» / «IENTO» and the status dot touched it. At 1024 px
 * the four `lg:grid-cols-4` stat cards (~134 px) and the two quick actions (~189 px) did the same to
 * «PUBLICACIONES» and «Publicación».
 *
 * Each threshold is the narrowest container in which every card still holds the widest single word it
 * shows in es/en/pt (DASHBOARD_LAYOUT = the cards' fixed parts; dashboardStats.test.ts recomputes the
 * thresholds from the translations), so a label wraps BETWEEN words and never inside one.
 */

/** The fixed parts of the dashboard cards, in px (Tailwind spacing: p-8 = 32 px, gap-4 = 16 px …). */
export const DASHBOARD_LAYOUT = {
    /** StatCard: p-8 and border-2 on both sides. */
    statChrome: 2 * 32 + 2 * 2,
    statGap: 24,
    /** HealthIndicator: border and p-4 on both sides, the 40 px icon + gap-4, the 8 px status dot + gap-2. */
    healthChrome: 2 * 1 + 2 * 16 + 40 + 16 + 8 + 8,
    healthGap: 16,
    /** QuickAction: border-2 and p-6 on both sides, the 48 px icon + gap-6. */
    quickChrome: 2 * 2 + 2 * 24 + 48 + 24,
    quickGap: 16,
    /** «Comentarios recientes» panel: border-2 and p-8 on both sides, its 40 px icon + gap-3 beside the title. */
    commentsChrome: 2 * 2 + 2 * 32 + 40 + 12,
    columnsGap: 32,
} as const;

/**
 * The page's two columns — the main one and «Comentarios recientes» beside it, a third of the width — from
 * 50rem of the PAGE's own content width (the dashboard root is the `@container`). They were
 * `lg:grid-cols-3` by the window: at 1024 px the content is ~608 px, the side panel ~181 px, and its title
 * «Comentarios» (~100 px, 20 px black italic) had ~61 px beside its icon — the card cut it. From 50rem
 * (800 px: still the case at 1280 px with the sidebar open, with or without a scrollbar, and at 1024 px with
 * it collapsed) the panel keeps ≥ 125 px for its title; below that it goes under the main column, full width.
 */
export const DASHBOARD_COLUMNS_CLASS = "grid grid-cols-1 @min-[50rem]:grid-cols-3 gap-8 items-start";
export const dashboardMainSpanClass = (recentComments: boolean) => recentComments ? "@min-[50rem]:col-span-2" : "@min-[50rem]:col-span-3";

/**
 * Column classes for N stat cards (the grid's wrapper is the `@container`): two columns from 25rem, then
 * all of them in one row once every card keeps ≥ 186 px (a 118 px label line; «PUBLICACIONES» is ~95 px).
 * Four cards never go three-and-one. Literal class names, so Tailwind compiles every one.
 */
export const STAT_GRID_COLS: Record<number, string> = {
    1: "grid-cols-1",
    2: "grid-cols-1 @min-[25rem]:grid-cols-2",
    3: "grid-cols-1 @min-[25rem]:grid-cols-2 @min-[38rem]:grid-cols-3",
    4: "grid-cols-1 @min-[25rem]:grid-cols-2 @min-[51rem]:grid-cols-4",
};

/**
 * The three system-health indicators: one per row, side by side only from 48rem (768 px: three 245 px
 * cards, a 139 px label line; «ALMACENAMIENTO» is ~121 px). Never two-and-one.
 */
export const HEALTH_GRID_CLASS = "grid gap-4 grid-cols-1 @min-[48rem]:grid-cols-3";

/** The quick actions: two columns from 30rem (cards ≥ 232 px, a 108 px text line; «Publicación» ~82 px). */
export const QUICK_ACTIONS_GRID_CLASS = "grid gap-4 grid-cols-1 @min-[30rem]:grid-cols-2";

/**
 * A health indicator's label row: the label wraps only between words (`break-normal` — never
 * `break-words`, whose fallback is exactly the mid-word cut), and the status dot keeps its own room beside
 * it (`gap-2`, `shrink-0`) instead of touching the last letter.
 */
export const HEALTH_LABEL_ROW_CLASS = "flex items-start justify-between gap-2";
export const HEALTH_LABEL_CLASS = "min-w-0 text-[11px] font-black uppercase tracking-widest text-gray-500 break-normal";
export const HEALTH_DOT_CLASS = "mt-1 flex h-2 w-2 shrink-0 rounded-full";
