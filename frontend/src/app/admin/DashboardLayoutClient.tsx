"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import Sidebar from "@/components/Sidebar";
import NotificationCenter from "@/components/NotificationCenter";
import MfaSetup from "@/components/MfaSetup";
import { UnsavedChangesProvider } from "@/contexts/UnsavedChangesContext";
import { initPlugins } from "@/lib/plugins";

function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
    const { user, isLoading, logout, can, refreshUser } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);

    const [logoUrl, setLogoUrl] = useState<string | null>(null);
    const [siteTitle, setSiteTitle] = useState("WordJS");

    // Initialize frontend plugins
    useEffect(() => {
        initPlugins();

        const fetchSettings = async () => {
            try {
                const { settingsApi } = await import("@/lib/api");
                const settings = await settingsApi.get();
                if (settings.site_logo) setLogoUrl(settings.site_logo);
                if (settings.blogname) setSiteTitle(settings.blogname);
            } catch (error) {
                console.error("Failed to load header settings:", error);
            }
        };
        fetchSettings();
    }, []);

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
    }, [user, isLoading, router, logout, can]);

    if (isLoading) {
        return (
            <div className="flex h-screen items-center justify-center bg-gray-100">
                <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div>
            </div>
        );
    }

    if (!user) return null;

    // Admin-enforced MFA: a required-role user past their grace window is hard-blocked from the whole admin
    // until they enrol. We render ONLY the enrolment flow (the backend also 403s every non-exempt API call,
    // so this isn't merely cosmetic). onEnabled → refreshUser() clears user.mfa.enforced and lifts the block.
    if (user.mfa?.enforced && !user.mfa?.enabled) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50 flex items-center justify-center p-4">
                <div className="w-full max-w-lg">
                    <div className="text-center mb-6">
                        <div className="inline-flex w-14 h-14 rounded-2xl bg-blue-600 text-white items-center justify-center mb-4 shadow-lg shadow-blue-500/30">
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

    // The Puck editor routes render a FULLSCREEN workspace (fixed inset-0; its own rail + breadcrumb
    // replace the admin chrome, Gutenberg-style). Skip the admin shell there: rendering it is wasted
    // work, and the Sidebar (z-5002) would sit ON TOP of the editor. All auth/MFA gates above still
    // ran; the contexts wrap this component, so children keep every provider.
    if (/^\/admin\/(pages|posts)\/[^/]+$/.test(pathname ?? "")) {
        return <>{children}</>;
    }

    // Nudge: required-role user still inside the grace window — a slim persistent bar with the deadline.
    const graceDaysLeft = user.mfa?.withinGrace && user.mfa.graceDeadline != null
        ? Math.max(0, Math.ceil((user.mfa.graceDeadline * 1000 - Date.now()) / 86400000))
        : null;

    return (
        <div className="flex h-screen bg-gray-100 overflow-hidden relative">
            <Sidebar
                isOpen={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                isCollapsed={isCollapsed}
            />

            {/* Collapse Toggle Button (Desktop) */}
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className={`
                    hidden md:flex absolute top-10 z-[5003] w-8 h-8 bg-white border border-gray-200 rounded-full items-center justify-center text-gray-500 hover:text-blue-500 hover:border-blue-200 shadow-lg transition-all duration-500 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)]
                    ${isCollapsed ? 'left-[96px]' : 'left-[304px]'}
                `}
                title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
                <i className={`fa-solid fa-chevron-${isCollapsed ? 'right' : 'left'} text-xs`}></i>
            </button>

            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
                {/* Mobile Header */}
                <header className="md:hidden bg-white border-b p-4 flex items-center justify-between sticky top-0 z-[5000] flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => setSidebarOpen(true)}
                            className="text-gray-600 hover:text-gray-900 focus:outline-none"
                        >
                            <i className="fa-solid fa-bars text-xl"></i>
                        </button>
                        <span className="font-bold text-gray-800 flex items-center gap-2">
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

                {graceDaysLeft !== null && (
                    <div className="flex-shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-center gap-3 text-sm">
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

                <main className="flex-1 relative bg-white flex flex-col h-full overflow-hidden">
                    {children}
                </main>

                {/* Floating Notification Center */}
            </div>
        </div >
    );
}

import { MenuProvider } from "@/contexts/MenuContext";
import { ToastProvider } from "@/contexts/ToastContext";
import { I18nProvider } from "@/contexts/I18nContext";

export default function DashboardLayoutClient({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
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
    );
}
