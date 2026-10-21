"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import type { ConnectionIssue } from "@/contexts/AuthContext";
import Sidebar from "@/components/Sidebar";
import NotificationCenter from "@/components/NotificationCenter";
import MfaSetup from "@/components/MfaSetup";
import { UnsavedChangesProvider } from "@/contexts/UnsavedChangesContext";
import { DialogDirectionContext } from "@/components/DialogLayer";
import { initPlugins } from "@/lib/plugins";
import { decideAdminRoute, type AdminMenuItem, type AdminRouteDecision } from "@/lib/adminAccess";
import { isMfaBlocked, type MenuLoadUser } from "@/lib/adminMenuLoad";
import { useI18n } from "@/contexts/I18nContext";
import {
    SITE_ADDRESS_SETTINGS_PATH,
    canManageSiteAddress,
    dashboardBanners,
    fillTemplate,
    siteAddressApi,
    type DashboardBanner,
    type SiteAddressState,
} from "@/lib/siteAddress";

// Per tab and per address: an admin who deliberately works on another address dismisses the reminder
// once, and sees it again in a new session or on yet another address.
const LINK_BASE_DISMISS_KEY = (hostname: string) => `wjs-link-base-banner-dismissed:${hostname}`;

/**
 * The site-address banners of the admin shell (see dashboardBanners for which ones and when). Every
 * value is rendered as text; the only action is a link to the settings screen, offered to administrators.
 */
export function SiteAddressBannerList({ banners, host, isAdmin, onDismissLinkBase }: {
    banners: DashboardBanner[];
    host: string;
    isAdmin: boolean;
    onDismissLinkBase: () => void;
}) {
    const { t } = useI18n();
    if (banners.length === 0) return null;
    const text = (banner: DashboardBanner): string => {
        switch (banner.kind) {
            case "link-base": return fillTemplate(t("siteBanner.linkBase"), { host, linkBase: banner.linkBase });
            case "conflict": return fillTemplate(t("siteBanner.conflict"), { config: banner.config, db: banner.db });
            case "gateway-drift": return fillTemplate(t("siteBanner.drift"), { gateway: banner.gateway, config: banner.config });
            case "proxy-collapse": return t("siteBanner.proxyCollapse");
            case "missing-canonical": return t("siteBanner.missingCanonical");
        }
    };
    return (
        <div className="flex-shrink-0" data-wjs-site-address-banners="" data-wjs-host-ui="">
            {banners.map((banner) => (
                <div
                    key={banner.kind}
                    className={`border-b px-4 py-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-center ${banner.kind === "link-base" ? "bg-sky-50 border-sky-200 text-sky-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}
                >
                    <i className={`fa-solid ${banner.kind === "link-base" ? "fa-link text-sky-500" : "fa-triangle-exclamation text-amber-500"}`} aria-hidden="true"></i>
                    <span className="font-medium">{text(banner)}</span>
                    {isAdmin && (
                        <Link href={SITE_ADDRESS_SETTINGS_PATH} className="font-bold underline underline-offset-2 whitespace-nowrap">
                            {t("siteBanner.review")}
                        </Link>
                    )}
                    {banner.kind === "link-base" && (
                        <button type="button" onClick={onDismissLinkBase} className="ml-1 w-11 h-11 shrink-0 -my-2 inline-flex items-center justify-center text-sky-700 hover:text-sky-950" aria-label={t("siteBanner.dismiss")} title={t("siteBanner.dismiss")}>
                            <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}

/**
 * The layout's route-guard decision (lib/adminAccess.ts decideAdminRoute), with the two cases the layout
 * itself owns: nothing is decided for a signed-out user, nor for one held at the two-factor enrolment
 * screen — that screen is all they get whatever the path, and their plugin menu is only loaded once they
 * have enrolled, so a decision taken now would send them away from a page they may open.
 */
export function layoutRouteDecision(args: {
    user: (MenuLoadUser & { capabilities?: string[]; role?: string }) | null | undefined;
    pathname: string;
    pluginMenus: AdminMenuItem[];
    menusLoading: boolean;
}): AdminRouteDecision {
    const { user, pathname, pluginMenus, menusLoading } = args;
    if (!user || isMfaBlocked(user)) return { kind: "allow" };
    return decideAdminRoute({ pathname, user: { role: user.role ?? undefined, capabilities: user.capabilities }, pluginMenus, menusLoaded: !menusLoading });
}

function AdminLoadingScreen() {
    return (
        <div className="flex h-dvh items-center justify-center bg-gray-100">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div>
        </div>
    );
}

/**
 * The session could not be checked (rate limited, server or network down) and no user is known: not a
 * sign-out, so no redirect to /login (M1-05 / S2-04). AuthProvider retries on its own; the countdown is
 * informational and "Try now" re-checks at once.
 */
function AdminConnectionIssueScreen({ issue, onRetry }: { issue: ConnectionIssue; onRetry: () => void }) {
    const { t } = useI18n();
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    const seconds = Math.max(0, Math.ceil((issue.retryAt - now) / 1000));
    const limited = issue.reason === "rate-limited";
    return (
        <div className="flex h-dvh items-center justify-center bg-gray-100 p-4">
            <div role="alert" aria-live="polite" className="max-w-md w-full bg-white rounded-3xl border border-gray-100 shadow-xl p-8 text-center" data-testid="admin-connection-issue">
                <div className="inline-flex w-14 h-14 shrink-0 rounded-2xl bg-amber-100 text-amber-600 items-center justify-center mb-4">
                    <i className={`fa-solid ${limited ? "fa-clock" : "fa-triangle-exclamation"} text-2xl`} aria-hidden="true"></i>
                </div>
                <h1 className="text-xl font-black text-gray-900">{t(limited ? "admin.connection.limited.title" : "admin.connection.down.title")}</h1>
                <p className="text-sm text-gray-500 mt-2">{t(limited ? "admin.connection.limited.body" : "admin.connection.down.body")}</p>
                <p className="text-xs text-gray-400 mt-4">{t("admin.connection.retrying").replace("{s}", String(seconds))}</p>
                <button type="button" onClick={onRetry} className="mt-6 min-h-11 px-6 rounded-2xl bg-gray-900 hover:bg-blue-600 text-white text-xs font-black uppercase tracking-widest">
                    {t("admin.connection.retryNow")}
                </button>
            </div>
        </div>
    );
}

export function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
    const { user, isLoading, logout, can, refreshUser, connectionIssue, retrySession } = useAuth();
    const { t, language } = useI18n();
    const { pluginMenus, isLoading: menusLoading } = useMenu();
    const router = useRouter();
    const pathname = usePathname();
    // The admin is read in the ADMIN's language, not the site's: <html lang> said en-US while every
    // label was Spanish, so a screen reader spoke Spanish with an English voice. The canvas frame keeps
    // the site's (it renders site content).
    useEffect(() => {
        if ((pathname ?? "").startsWith("/admin/canvas-frame")) return;
        document.documentElement.lang = language;
    }, [language, pathname]);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);
    // The header & footer editor needs the width: with the full sidebar its 1280px preview was drawn
    // at 41% on a 1440px screen, the menu ~5px tall (QA M1-17). There the sidebar starts collapsed; the
    // toggle still expands it, without touching the preference saved for every other screen.
    const onWideEditor = (pathname ?? "").startsWith("/admin/chrome");
    const [editorExpanded, setEditorExpanded] = useState(false);
    const collapsed = onWideEditor ? !editorExpanded : isCollapsed;
    const toggleCollapsed = () => (onWideEditor ? setEditorExpanded((v) => !v) : setIsCollapsed(!isCollapsed));

    const [logoUrl, setLogoUrl] = useState<string | null>(null);
    const [siteTitle, setSiteTitle] = useState("WordJS");
    // The address links and emails really use (the public `siteurl` option) and, for administrators,
    // the site-address state behind the conflict/drift/proxy banners.
    const [linkBase, setLinkBase] = useState<string | null>(null);
    const [siteAddress, setSiteAddress] = useState<SiteAddressState | null>(null);
    // Read once, on the client: this component renders nothing that depends on them before the auth
    // probe resolves, so the server render (no window) and hydration cannot disagree.
    const [pageAddress] = useState<{ host: string; hostname: string } | null>(() =>
        typeof window === "undefined" ? null : { host: window.location.host, hostname: window.location.hostname });
    const [linkBaseDismissed, setLinkBaseDismissed] = useState(() => {
        try {
            return typeof window !== "undefined" && window.sessionStorage.getItem(LINK_BASE_DISMISS_KEY(window.location.hostname)) === "1";
        } catch {
            // No session storage (privacy mode): the reminder simply cannot be dismissed for long.
            return false;
        }
    });

    // Initialize frontend plugins
    useEffect(() => {
        initPlugins();

        const fetchSettings = async () => {
            try {
                const { settingsApi } = await import("@/lib/api");
                const settings = await settingsApi.get();
                if (settings.site_logo) setLogoUrl(settings.site_logo);
                if (settings.blogname) setSiteTitle(settings.blogname);
                setLinkBase(settings.siteurl || settings.home || null);
            } catch (error) {
                console.error("Failed to load header settings:", error);
            }
        };
        fetchSettings();
    }, []);

    // GET /site-address is administrator-only (it lists the server's own addresses), so nobody else
    // asks. A failure only means no admin banners: the settings screen reports errors properly.
    const isAdmin = canManageSiteAddress(user);
    useEffect(() => {
        if (!isAdmin) return;
        let active = true;
        siteAddressApi.get()
            .then((state) => { if (active) setSiteAddress(state); })
            .catch(() => { /* no banners */ });
        return () => { active = false; };
    }, [isAdmin, user?.id]);

    const dismissLinkBase = () => {
        setLinkBaseDismissed(true);
        try {
            if (pageAddress) window.sessionStorage.setItem(LINK_BASE_DISMISS_KEY(pageAddress.hostname), "1");
        } catch {
            // Dismissed for this page view only.
        }
    };

    // Persist sidebar state
    useEffect(() => {
        const stored = localStorage.getItem("sidebar_collapsed");
        if (stored) {
            setIsCollapsed(stored === "true");
        }
    }, []);

    useEffect(() => {
        localStorage.setItem("sidebar_collapsed", String(isCollapsed));
    }, [isCollapsed]);

    useEffect(() => {
        if (!isLoading) {
            if (!user) {
                // Could not check the session (429 / server down): that is not a sign-out.
                if (connectionIssue) return;
                router.push("/login");
            } else if (!can("access_admin_panel")) {
                // Use the role-aware can() helper, NOT a raw user.capabilities check: an
                // administrator can legitimately arrive with an empty capabilities array (the
                // role→cap map may not be seeded), and can() returns true for the admin role. The
                // old raw check logged admins straight back out ("login works, then kicked out").
                console.warn("User does not have admin access");
                logout(); // Logout if they managed to get a token but shouldn't be here
            }
        }
    }, [user, isLoading, router, logout, can, connectionIssue]);

    // ROUTE GUARD — "a page you cannot see in the menu is a page you cannot open" (lib/adminAccess.ts).
    // A NAVIGATION guard in the browser, not access control: every API still enforces its own capability.
    // It decides nothing for a signed-out user, nor for a user held at the two-factor enrolment screen
    // (that screen is all they get, whatever the path; their plugin menu is loaded once they have
    // enrolled — contexts/MenuContext.tsx). `wait` while the plugin menu loads (a plugin page, or where to
    // send someone who may not stay); a redirect lands on the first admin page the user's sidebar offers
    // — for /admin without the dashboard capability that is how a plugin team member lands straight on
    // the plugin's screen after signing in. (The decision is computed up here only because the redirect
    // is an effect, and hooks may not follow the early returns.)
    const routeDecision = layoutRouteDecision({
        user,
        pathname: pathname ?? "",
        pluginMenus: pluginMenus as unknown as AdminMenuItem[],
        menusLoading,
    });
    const redirectTo = routeDecision.kind === "redirect" ? routeDecision.to : null;
    useEffect(() => {
        if (!isLoading && redirectTo) router.replace(redirectTo);
    }, [isLoading, redirectTo, router, pathname]);

    if (isLoading) return <AdminLoadingScreen />;

    if (!user && connectionIssue) return <AdminConnectionIssueScreen issue={connectionIssue} onRetry={() => { void retrySession(); }} />;

    if (!user) return null;

    // Admin-enforced MFA: a required-role user past their grace window is hard-blocked from the whole admin
    // until they enrol. We render ONLY the enrolment flow (the backend also 403s every non-exempt API call,
    // so this isn't merely cosmetic). onEnabled → refreshUser() clears user.mfa.enforced and lifts the block.
    if (user.mfa?.enforced && !user.mfa?.enabled) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50 flex items-center justify-center p-4">
                <div className="w-full max-w-lg">
                    <div className="text-center mb-6">
                        <div className="inline-flex w-14 h-14 shrink-0 rounded-2xl bg-blue-600 text-white items-center justify-center mb-4 shadow-lg shadow-blue-500/30">
                            <i className="fa-solid fa-shield-halved text-2xl"></i>
                        </div>
                        <h1 className="text-2xl font-black italic tracking-tight text-gray-900">Two-factor authentication required</h1>
                        <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
                            Your role requires 2FA and the grace period has ended. Set it up now to regain access to the dashboard.
                        </p>
                    </div>
                    <MfaSetup onEnabled={refreshUser} />
                    <div className="text-center mt-6">
                        <button onClick={logout} className="text-sm text-gray-400 hover:text-blue-600 font-medium">
                            <i className="fa-solid fa-arrow-right-from-bracket mr-1"></i> Sign out
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Not a page this user may open (or not decided yet): never render it, not even for a frame.
    if (routeDecision.kind !== "allow") return <AdminLoadingScreen />;

    // The Puck editor routes render a FULLSCREEN workspace (fixed inset-0; its own rail + breadcrumb
    // replace the admin chrome, Gutenberg-style). Skip the admin shell there: rendering it is wasted
    // work, and the Sidebar (z-5002) would sit ON TOP of the editor. All auth/MFA gates above still
    // ran, and so did the route guard; the contexts wrap this component, so children keep every provider.
    // Same bypass for the Verso editor surfaces (F2): /admin/canvas-frame is the MINIMAL document a
    // canvas iframe loads (the sidebar inside the iframe would corrupt the page being edited), and
    // /admin/verso-lab is the fullscreen editor harness. Auth/MFA gates above still ran for both.
    if (
        /^\/admin\/(pages|posts)\/[^/]+$/.test(pathname ?? "") ||
        /^\/admin\/(canvas-frame|verso-lab)$/.test(pathname ?? "")
    ) {
        return <>{children}</>;
    }

    // Nudge: required-role user still inside the grace window — a slim persistent bar with the deadline.
    const graceDaysLeft = user.mfa?.withinGrace && user.mfa.graceDeadline != null
        ? Math.max(0, Math.ceil((user.mfa.graceDeadline * 1000 - Date.now()) / 86400000))
        : null;

    // The settings screen shows the conflict/drift/proxy state in full, so the shell does not repeat it there.
    const siteBanners = pageAddress
        ? dashboardBanners({
            locationHostname: pageAddress.hostname,
            linkBase,
            admin: pathname === SITE_ADDRESS_SETTINGS_PATH ? null : siteAddress,
        }).filter((banner) => !(banner.kind === "link-base" && linkBaseDismissed))
        : [];

    // THE SHELL IS EXACTLY THE VISIBLE VIEWPORT. `h-screen` is 100vh, which iOS resolves to the LARGE
    // viewport (toolbars hidden) while html/body are 100% of the small one: the document came out taller
    // than the screen by the toolbar's height, so a drag scrolled and rubber-banded the whole document —
    // header included — instead of the page's own scroller. `h-dvh` follows the toolbar. The horizontal
    // safe-area padding keeps the shell out of the notch in landscape now that the admin viewport is
    // `viewport-fit=cover` (app/admin/layout.tsx); env() is 0 everywhere else, so desktop is unchanged.
    return (
        <div data-wjs-admin-shell="" className="flex h-dvh bg-gray-100 overflow-hidden relative pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
            <Sidebar
                isOpen={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                isCollapsed={collapsed}
            />

            {/* Collapse Toggle Button (Desktop) */}
            <button
                data-wjs-host-ui=""
                onClick={toggleCollapsed}
                className={`
                    hidden lg:flex absolute top-10 z-[5003] w-8 h-8 bg-white border border-gray-200 rounded-full items-center justify-center text-gray-500 hover:text-blue-500 hover:border-blue-200 shadow-lg transition-all duration-500 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)]
                    ${collapsed ? 'left-[calc(96px+env(safe-area-inset-left))]' : 'left-[calc(304px+env(safe-area-inset-left))]'}
                `}
                title={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
                aria-label={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
            >
                <i className={`fa-solid fa-chevron-${collapsed ? 'right' : 'left'} text-xs`}></i>
            </button>

            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
                {/* Mobile Header. `relative`, not `sticky`: the nearest scroller is this overflow-hidden
                    column, so sticky never stuck — it only made the header look pinned while the whole
                    document moved under the finger. Same stacking (positioned, z-5000). The top padding
                    clears the status bar when the admin runs full-screen (viewport-fit=cover). */}
                {/* border-gray-100: a bare `border-b` is currentColor in Tailwind v4 — a black rule under the bar that
                    also showed, sharp, through the edge of every dialog's blurred backdrop. */}
                <header className="lg:hidden bg-white border-b border-gray-100 px-2 sm:px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] flex items-center justify-between gap-2 relative z-[5000] flex-shrink-0" data-wjs-host-ui="">
                    <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                        <button
                            type="button"
                            onClick={() => setSidebarOpen(true)}
                            aria-label={t("nav.openMenu")}
                            aria-expanded={sidebarOpen}
                            aria-controls="wjs-admin-sidebar"
                            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                        >
                            <i className="fa-solid fa-bars text-xl" aria-hidden="true"></i>
                        </button>
                        <span className="font-bold text-gray-800 flex items-center gap-2 min-w-0 truncate">
                            {logoUrl ? (
                                <img src={logoUrl} alt={siteTitle} className="h-8 w-8 object-contain" />
                            ) : (
                                <i className="fa-solid fa-rocket text-blue-500"></i>
                            )}
                            {siteTitle}
                        </span>
                    </div>
                    <NotificationCenter variant="inline" />
                </header>

                {user.handoff && (
                    // Multisite: a network administrator's handoff session (backend core/network-handoff) —
                    // who is in, from which site, and until when, on every screen for as long as it lasts.
                    <div data-wjs-host-ui="" data-wjs-handoff-banner="" role="status" className="flex-shrink-0 bg-violet-50 border-b border-violet-200 px-4 py-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-center">
                        <i className="fa-solid fa-sitemap text-violet-500" aria-hidden="true"></i>
                        <span className="text-violet-900 font-medium">
                            {fillTemplate(t("handoff.banner"), {
                                admin: user.handoff.networkAdmin,
                                from: user.handoff.from || "?",
                                time: new Date(user.handoff.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                            })}
                        </span>
                        <button type="button" onClick={logout} className="text-violet-900 font-bold underline underline-offset-2 hover:text-violet-950 whitespace-nowrap">
                            {t("handoff.bannerEnd")}
                        </button>
                    </div>
                )}

                {graceDaysLeft !== null && (
                    <div data-wjs-host-ui="" className="flex-shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-center">
                        <i className="fa-solid fa-shield-halved text-amber-500"></i>
                        <span className="text-amber-800 font-medium">
                            Two-factor authentication is required for your role
                            {graceDaysLeft > 0 ? ` within ${graceDaysLeft} day${graceDaysLeft === 1 ? "" : "s"}` : " — enrol today"}.
                        </span>
                        <Link href="/admin/account" className="text-amber-900 font-bold underline underline-offset-2 hover:text-amber-950 whitespace-nowrap">
                            Set it up
                        </Link>
                    </div>
                )}

                <SiteAddressBannerList
                    banners={siteBanners}
                    host={pageAddress?.host ?? ""}
                    isAdmin={isAdmin}
                    onDismissLinkBase={dismissLinkBase}
                />

                <main {...(/^\/admin\/plugin\//.test(pathname ?? "") ? {} : { "data-wjs-core-screen": "" })} className="flex-1 relative bg-white flex flex-col h-full overflow-hidden">
                    {children}
                </main>

                {/* Floating Notification Center */}
            </div>
        </div >
    );
}

import { MenuProvider, useMenu } from "@/contexts/MenuContext";
import { ToastProvider } from "@/contexts/ToastContext";
import { I18nProvider } from "@/contexts/I18nContext";

export default function DashboardLayoutClient({
    children,
}: {
    children: React.ReactNode;
}) {
    // Dialogs portal out of app/admin/layout.tsx's `<div dir="ltr">`: they keep the admin's direction
    // (components/DialogLayer.tsx). Same value as that wrapper — change both together.
    return (
        <DialogDirectionContext.Provider value="ltr">
            <I18nProvider>
                <AuthProvider>
                    <UnsavedChangesProvider>
                        <ToastProvider>
                            <MenuProvider>
                                <DashboardLayoutContent>{children}</DashboardLayoutContent>
                            </MenuProvider>
                        </ToastProvider>
                    </UnsavedChangesProvider>
                </AuthProvider>
            </I18nProvider>
        </DialogDirectionContext.Provider>
    );
}
