/**
 * Which admin pages a user may open — one map, used by the sidebar AND by the admin layout's route guard.
 *
 * The rule: A PAGE YOU CANNOT SEE IN THE MENU IS A PAGE YOU CANNOT OPEN. Before this, the sidebar hid the
 * entries a user lacked the capability for, but the layout only checked `access_admin_panel` — so anyone
 * signed in to the admin could type /admin/users or /admin/settings and get the screen (the API then
 * answered 403 or public data). That mattered once roles could be NARROW: a plugin-declared role (e.g.
 * conference-manager's team role, see backend/src/core/plugin-roles.ts) carries only `read`,
 * `access_admin_panel` and the plugin's own capabilities, and its holders must be able to reach the
 * plugin's page and their own account — nothing else.
 *
 *   · Core pages: ADMIN_ROUTE_RULES maps each route to the capability (any of) it needs. The sidebar's
 *     core entries (CORE_MENU_ITEMS) carry the same capabilities, and a test keeps every admin page of
 *     the app covered by a rule.
 *   · Plugin pages (/admin/plugin/<slug>): allowed only when the user has a menu item pointing there —
 *     the server already filters plugin menu items by capability (GET /plugins/menus). A plugin menu item
 *     NEVER opens a core page: a core path is decided by its core rule only.
 *   · /admin/account is always allowed (MFA enrolment and the user's own profile live there).
 *   · Administrators (and any '*' holder) open everything, exactly as before.
 *
 * Landing: a user who opens /admin without the dashboard capability, or any page they may not use, is
 * sent to the FIRST admin page their sidebar offers (firstAllowedAdminPath) — a conference team member
 * lands straight on the conference screen; a user whose sidebar offers nothing else, on their account
 * page.
 *
 * THIS IS A NAVIGATION GUARD IN THE BROWSER, NOT ACCESS CONTROL. It keeps people out of screens they
 * cannot use; every API still enforces its own capability, and that remains the security boundary.
 */

export interface AdminAccessUser {
    role?: string;
    capabilities?: string[];
    /** Multisite only (GET /auth/me). Absent on a single site, where every rule below is as before. */
    network?: { mainSite: boolean; networkAdmin: boolean };
}

export interface AdminMenuItem {
    href: string;
    label: string;
    icon: string;
    cap?: string | null;
    section?: string;
    plugin?: string;
    order?: number;
    /** Multisite: only on the network's main site (plugins, backups, the hooks registry…). */
    mainSiteOnly?: boolean;
    /** Multisite: only for network administrators (and only on the main site). */
    networkAdminOnly?: boolean;
    /** Network-wide tools: everyone who holds `cap` on a single site, network administrators only in a network. */
    networkWide?: boolean;
    /** On every site, but on the MAIN site of a network for network administrators only (backups). */
    networkAdminOnMainSite?: boolean;
}

export const ACCOUNT_PATH = "/admin/account";
const ADMIN_ROOT = "/admin";
const PLUGIN_PAGE_RE = /^\/admin\/plugin\/([^/?#]+)/;

// Core menu items - labels will be translated in the Sidebar (keys starting with "nav.").
// The first CORE_SECTION_SIZE entries form the sidebar's core section; the rest its management section.
export const CORE_MENU_ITEMS: AdminMenuItem[] = [
    { href: "/admin", label: "nav.dashboard", icon: "fa-chart-pie", cap: "edit_posts" },
    { href: "/admin/posts", label: "nav.posts", icon: "fa-pen-to-square", cap: "edit_posts" },
    { href: "/admin/pages", label: "nav.pages", icon: "fa-file-lines", cap: "edit_pages" },
    { href: "/admin/media", label: "nav.media", icon: "fa-images", cap: "upload_files" },
    { href: "/admin/menus", label: "nav.menus", icon: "fa-bars", cap: "edit_theme_options" },
    // Header & footer editor. It replaced the legacy /admin/footer page (which now redirects here,
    // to the footer part): its settings were converted into the footer composition.
    { href: "/admin/chrome", label: "nav.chrome", icon: "fa-window-maximize", cap: "edit_theme_options" },
    { href: "/admin/widgets", label: "nav.widgets", icon: "fa-shapes", cap: "edit_theme_options" },
    { href: "/admin/comments", label: "nav.comments", icon: "fa-comments", cap: "moderate_comments" },
    // Form submissions viewer — literal label (its page registers forms.* i18n keys at runtime, which
    // cannot cover this pre-navigation render); manage_options mirrors the backend gate on /forms/*.
    { href: "/admin/forms", label: "Formularios", icon: "fa-envelope-open-text", cap: "manage_options" },
    { href: "/admin/users", label: "nav.users", icon: "fa-users", cap: "list_users" },
    { href: "/admin/users?type=subscribers", label: "nav.subscribers", icon: "fa-user-group", cap: "list_users" },
    { href: "/admin/users/roles", label: "nav.roles", icon: "fa-shield-halved", cap: "manage_options" },
    { href: "/admin/categories", label: "nav.categories", icon: "fa-folder", cap: "manage_categories" },
    // Etiquetas (taxonomía post_tag). Literal en vez de clave i18n, como el resto de las entradas
    // añadidas después del corte de traducciones; mismo permiso que el router (manage_categories),
    // que es también el que gatea POST/PUT/DELETE en backend/src/routes/tags.ts.
    { href: "/admin/tags", label: "Etiquetas", icon: "fa-tags", cap: "manage_categories" },
    { href: "/admin/plugins", label: "nav.plugins", icon: "fa-plug", cap: "activate_plugins", mainSiteOnly: true },
    { href: "/admin/themes", label: "nav.themes", icon: "fa-palette", cap: "switch_themes" },
    { href: "/admin/fonts", label: "nav.fonts", icon: "fa-font", cap: "manage_options" },
    { href: "/admin/settings", label: "nav.settings", icon: "fa-gear", cap: "manage_options" },
    // Preajustes de interacción del sitio (motor F9). Literal en vez de clave i18n, como el resto de
    // las entradas añadidas después del corte de traducciones. Va DESPUÉS del índice 7, así que cae
    // en la sección de gestión junto a Ajustes — no mueve el reparto de secciones.
    { href: "/admin/settings/interactions", label: "Interacciones", icon: "fa-wand-magic-sparkles", cap: "manage_options" },
    // Proveedor de IA (backend routes/ai.ts): el backend lo gatea con isAdmin + sesión interactiva.
    { href: "/admin/settings/ai", label: "nav.ai", icon: "fa-brain", cap: "manage_options" },
    // Herramientas: exportación JSON/WXR (la mitad que faltaba de importar/exportar). El backend la
    // gatea con isAdmin, que mira el ROL; `manage_options` es lo más cerca que la barra puede afinar
    // con capabilities, y la propia página vuelve a comprobar el rol antes de ofrecer nada.
    { href: "/admin/tools", label: "Herramientas", icon: "fa-screwdriver-wrench", cap: "manage_options" },
    { href: "/admin/import", label: "nav.import", icon: "fa-file-import", cap: "manage_options" },
    // Every site has its own backups; the main site's (which carry the network's code) are the network administrators'.
    { href: "/admin/settings/backups", label: "nav.backups", icon: "fa-box-archive", cap: "manage_options", networkAdminOnMainSite: true },
    { href: "/admin/security", label: "nav.security", icon: "fa-lock", cap: "manage_options" },
    // Site Health (backend core/site-health, GET /health/site): the install's diagnostics with fix links.
    // The main site's on a network, like the certificates and server settings it points at.
    { href: "/admin/site-health", label: "nav.siteHealth", icon: "fa-heart-pulse", cap: "manage_options", mainSiteOnly: true },
    // Servers (backend routes/cluster.ts): the nodes the gateway knows, join tokens, removal: the network's.
    { href: "/admin/cluster", label: "nav.cluster", icon: "fa-server", cap: "manage_options", mainSiteOnly: true, networkWide: true },
    // Registro de auditoría (solo lectura). Igual que Herramientas: el backend lo gatea con isAdmin
    // (rol), y la pantalla repite esa comprobación — aquí `manage_options` solo evita enseñar la
    // entrada a quien seguro no la puede usar.
    { href: "/admin/audit", label: "Auditoría", icon: "fa-clipboard-list", cap: "manage_options" },
    { href: "/admin/hooks", label: "nav.hooks", icon: "fa-microscope", cap: "manage_options", mainSiteOnly: true, networkWide: true },
    { href: "/admin/db-migration", label: "nav.dbMigration", icon: "fa-database", cap: "manage_options", mainSiteOnly: true, networkWide: true },
    // Outgoing webhooks — admin only (they can exfiltrate content changes), mirrors the backend isAdmin gate.
    { href: "/admin/webhooks", label: "nav.webhooks", icon: "fa-bolt", cap: "manage_options" },
    // Multisite: the network screen (the sites of the network) — network administrators, main site only.
    { href: "/admin/network", label: "nav.network", icon: "fa-sitemap", cap: "manage_options", mainSiteOnly: true, networkAdminOnly: true },
    // API tokens are gated on `manage_api_tokens` (admins hold it via '*'), NOT shown to every user —
    // minting a token is a privileged action even though the token inherits the owner's own permissions.
    // Account self-service stays at 'read' (every logged-in user manages their own profile/password).
    { href: "/admin/tokens", label: "nav.apiTokens", icon: "fa-key", cap: "manage_api_tokens" },
    // AI agent connections (MCP): same gate as API tokens — creating one mints a credential. Granting is
    // administrator-only and enforced by the backend; the page hides the grant controls from everyone else.
    { href: "/admin/agents", label: "nav.aiAgents", icon: "fa-robot", cap: "manage_api_tokens" },
    { href: ACCOUNT_PATH, label: "nav.account", icon: "fa-user-gear", cap: "read" },
];

/** Entries [0, CORE_SECTION_SIZE) of CORE_MENU_ITEMS form the sidebar's core section (up to the chrome editor). */
export const CORE_SECTION_SIZE = 6;

export interface AdminRouteRule {
    /** The route; it also covers every sub-path (`/admin/posts` covers `/admin/posts/12`). */
    path: string;
    /** The capabilities that open it — any one of them. */
    anyOf: string[];
    /** Only the path itself, not its sub-paths (the dashboard is `/admin`, not "everything"). */
    exact?: boolean;
    /** Multisite: see AdminMenuItem. */
    mainSiteOnly?: boolean;
    networkAdminOnly?: boolean;
    networkWide?: boolean;
    networkAdminOnMainSite?: boolean;
}

/**
 * Every core admin route and the capability it needs. Derived from the sidebar entries (so the menu and
 * the guard cannot disagree), plus the pages that have no sidebar entry of their own. The most specific
 * (longest) matching path wins. A test asserts every app/admin page is covered.
 */
export const ADMIN_ROUTE_RULES: AdminRouteRule[] = (() => {
    const rules = new Map<string, AdminRouteRule>();
    for (const item of CORE_MENU_ITEMS) {
        const path = item.href.split("?")[0];
        if (rules.has(path)) continue; // `/admin/users?type=subscribers` is the same route as `/admin/users`
        rules.set(path, { path, anyOf: [item.cap || "read"], exact: path === ADMIN_ROOT, mainSiteOnly: item.mainSiteOnly, networkAdminOnly: item.networkAdminOnly, networkWide: item.networkWide, networkAdminOnMainSite: item.networkAdminOnMainSite });
    }
    const extra: AdminRouteRule[] = [
        // The editor's canvas document: an empty shell loaded in an iframe by every Verso editor (posts,
        // pages, the chrome editor, a plugin screen that embeds the editor). It shows no data of its own.
        { path: "/admin/canvas-frame", anyOf: ["access_admin_panel"] },
        // The editor's test bench (dev, or ?lab=1): synthetic documents only.
        { path: "/admin/verso-lab", anyOf: ["edit_posts", "edit_pages"] },
        // The retired footer settings page — now only a redirect to the footer in the header & footer
        // editor, gated like the editor so the redirect never reveals more than its target would.
        { path: "/admin/footer", anyOf: ["edit_theme_options"] },
        // The theme customizer, reached from the Themes screen.
        { path: "/admin/themes/customize", anyOf: ["edit_theme_options"] },
        // Site notices — the screen itself is administrators-only; the guard keeps it to option managers.
        { path: "/admin/notices", anyOf: ["manage_options"] },
        // The main site's addresses (Settings → Site address): another site's address is the network's.
        { path: "/admin/settings/site-address", anyOf: ["manage_options"], mainSiteOnly: true, networkWide: true },
        { path: "/admin/settings/media-storage", anyOf: ["manage_options"], mainSiteOnly: true, networkWide: true },
        // Settings → Network (turning the network on and off): the main site's; another site never has it.
        { path: "/admin/settings/network", anyOf: ["manage_options"], mainSiteOnly: true },
    ];
    for (const rule of extra) rules.set(rule.path, rule);
    return Array.from(rules.values());
})();

/** Holds every capability: the administrator role or the '*' wildcard (same rule as AuthContext.can). */
export function isWildcardUser(user: AdminAccessUser | null | undefined): boolean {
    return !!user && (user.role === "administrator" || (user.capabilities || []).includes("*"));
}

/**
 * Multisite: does this site, and this user's place in the network, have the page at all? Always true
 * on a single site (no `network` on the user). Checked before any capability — an administrator of
 * another site holds every capability, and still has no plugin screen there.
 */
export function siteOffers(user: AdminAccessUser | null | undefined, entry: { mainSiteOnly?: boolean; networkAdminOnly?: boolean; networkWide?: boolean; networkAdminOnMainSite?: boolean } | null | undefined): boolean {
    const network = user && user.network;
    if (!entry) return true;
    if (entry.networkAdminOnly && !(network && network.mainSite && network.networkAdmin)) return false;
    if (!network) return true;
    if (entry.networkWide && !network.networkAdmin) return false;
    if (entry.networkAdminOnMainSite && network.mainSite && !network.networkAdmin) return false;
    return !(entry.mainSiteOnly && !network.mainSite);
}

/** Does the user hold `cap`? A missing cap means "any signed-in user" (same rule as the old sidebar). */
export function userCan(user: AdminAccessUser | null | undefined, cap: string | null | undefined): boolean {
    if (!cap) return true;
    if (!user) return false;
    if (isWildcardUser(user)) return true;
    return (user.capabilities || []).includes(cap);
}

/** The path part of an href (no query, no hash). */
function pathOf(href: string): string {
    return href.split(/[?#]/)[0] || "";
}

/** The core rule for a path, or null when it is not a core admin route. */
export function ruleFor(pathname: string): AdminRouteRule | null {
    let best: AdminRouteRule | null = null;
    for (const rule of ADMIN_ROUTE_RULES) {
        const hit = rule.exact
            ? pathname === rule.path
            : pathname === rule.path || pathname.startsWith(rule.path + "/");
        if (hit && (!best || rule.path.length > best.path.length)) best = rule;
    }
    return best;
}

/** `/admin/plugin/<slug>…` → slug, otherwise null. */
export function pluginPageSlug(pathname: string): string | null {
    const m = PLUGIN_PAGE_RE.exec(pathname);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function isAdminPath(pathname: string): boolean {
    return pathname === ADMIN_ROOT || pathname.startsWith(ADMIN_ROOT + "/");
}

/** The plugin menu items the sidebar shows — never one that duplicates a core entry. */
export function visiblePluginMenuItems(user: AdminAccessUser | null | undefined, pluginMenus: AdminMenuItem[]): AdminMenuItem[] {
    return (pluginMenus || [])
        .filter((item) => item && typeof item.href === "string")
        .filter((item) => item.plugin !== "core")
        .filter((item) => !CORE_MENU_ITEMS.some((core) => core.href === item.href))
        .filter((item) => userCan(user, item.cap))
        // A plugin item pointing at a page the guard would refuse is not shown either (a plugin menu
        // item can never open a core page — see canOpenAdminPath).
        .filter((item) => canOpenAdminPath(item.href, user, pluginMenus));
}

/**
 * May `user` open `href`? Pure: the sidebar filter, the layout guard and the landing all ask this.
 * Paths outside /admin are not this guard's business (allowed).
 */
export function canOpenAdminPath(href: string, user: AdminAccessUser | null | undefined, pluginMenus: AdminMenuItem[]): boolean {
    const pathname = pathOf(href);
    if (!isAdminPath(pathname)) return true;
    if (!user) return false;
    if (!siteOffers(user, ruleFor(pathname))) return false;
    if (isWildcardUser(user)) return true;
    if (pathname === ACCOUNT_PATH || pathname.startsWith(ACCOUNT_PATH + "/")) return true;
    const slug = pluginPageSlug(pathname);
    if (slug !== null) {
        // Allowed only through a menu item of the user's own (already capability-filtered by the server).
        return (pluginMenus || []).some((item) =>
            item && typeof item.href === "string" && item.plugin !== "core"
            && userCan(user, item.cap) && pluginPageSlug(pathOf(item.href)) === slug);
    }
    const rule = ruleFor(pathname);
    if (!rule) return false; // not a page this admin knows: nothing to open
    return rule.anyOf.some((cap) => userCan(user, cap));
}

/**
 * The sidebar, in display order: core section (core entries up to the chrome editor + the plugins'
 * core-section items) then management section (the plugins' management items + the remaining core
 * entries). Exactly what the user may open.
 */
export function sidebarSections(user: AdminAccessUser | null | undefined, pluginMenus: AdminMenuItem[]): { core: AdminMenuItem[]; management: AdminMenuItem[] } {
    const plugins = visiblePluginMenuItems(user, pluginMenus);
    const coreAllowed = (item: AdminMenuItem) => siteOffers(user, item) && userCan(user, item.cap);
    return {
        core: [
            ...CORE_MENU_ITEMS.slice(0, CORE_SECTION_SIZE).filter(coreAllowed),
            ...plugins.filter((p) => p.section !== "management"),
        ],
        management: [
            ...plugins.filter((p) => p.section === "management"),
            ...CORE_MENU_ITEMS.slice(CORE_SECTION_SIZE).filter(coreAllowed),
        ],
    };
}

/** One titled group of the sidebar (desktop sidebar and phone menu alike). */
export interface SidebarSection {
    key: "core" | "management";
    /** i18n key of the section's heading. */
    labelKey: string;
    items: AdminMenuItem[];
}

/**
 * The sidebar's sections, in display order, WITHOUT the empty ones: a heading is only drawn above at
 * least one entry. A plugin team member whose plugin lost its grant (no plugin entry, no core entry in
 * the first section) used to see a bare «PRINCIPAL» heading above «SISTEMA › Cuenta».
 */
export function visibleSidebarSections(user: AdminAccessUser | null | undefined, pluginMenus: AdminMenuItem[]): SidebarSection[] {
    const { core, management } = sidebarSections(user, pluginMenus);
    const all: SidebarSection[] = [
        { key: "core", labelKey: "nav.sectionCore", items: core },
        { key: "management", labelKey: "nav.sectionSystem", items: management },
    ];
    return all.filter((section) => section.items.length > 0);
}

/**
 * The first ADMIN page the user's sidebar offers that they may open; their account page as the floor.
 * A plugin's menu item may link outside the admin (any same-origin path is accepted by the backend): it
 * stays a sidebar link, but it is never where signing in or a refused page lands someone.
 */
export function firstAllowedAdminPath(user: AdminAccessUser | null | undefined, pluginMenus: AdminMenuItem[]): string {
    const { core, management } = sidebarSections(user, pluginMenus);
    for (const item of [...core, ...management]) {
        if (isAdminPath(pathOf(item.href)) && canOpenAdminPath(item.href, user, pluginMenus)) return item.href;
    }
    return ACCOUNT_PATH;
}

export type AdminRouteDecision =
    | { kind: "allow" }
    | { kind: "wait" }
    | { kind: "redirect"; to: string };

/**
 * The layout guard's decision for the current path. `wait` while the plugin menu is still loading and
 * the answer depends on it (a plugin page, or where to send someone who may not stay). A redirect target
 * is always a page `canOpenAdminPath` allows, so the guard can never bounce between two pages.
 */
export function decideAdminRoute(args: {
    pathname: string;
    user: AdminAccessUser | null | undefined;
    pluginMenus: AdminMenuItem[];
    menusLoaded: boolean;
}): AdminRouteDecision {
    const { pathname, user, pluginMenus, menusLoaded } = args;
    if (!isAdminPath(pathname) || isWildcardUser(user)) return { kind: "allow" };
    const isPluginPage = pluginPageSlug(pathname) !== null;
    // A core page decides without the plugin menu; a plugin page needs it.
    if (!isPluginPage && canOpenAdminPath(pathname, user, [])) return { kind: "allow" };
    if (!menusLoaded) return { kind: "wait" };
    if (canOpenAdminPath(pathname, user, pluginMenus)) return { kind: "allow" };
    const to = firstAllowedAdminPath(user, pluginMenus);
    return to === pathname ? { kind: "allow" } : { kind: "redirect", to };
}
