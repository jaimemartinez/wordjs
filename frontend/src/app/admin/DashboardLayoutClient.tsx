"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import Sidebar from "@/components/Sidebar";
import NotificationCenter from "@/components/NotificationCenter";
import { UnsavedChangesProvider } from "@/contexts/UnsavedChangesContext";
import { initPlugins } from "@/lib/plugins";

function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
    const { user, isLoading, logout } = useAuth();
    const router = useRouter();
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
        console.log('DashboardLayoutContent State:', { isLoading, user, hasChildren: !!children });
        if (!isLoading) {
            if (!user) {
                router.push("/login");
            } else if (user.capabilities && !user.capabilities.includes("access_admin_panel") && !user.capabilities.includes("*")) {
                console.warn("User does not have admin access");
                logout(); // Logout if they managed to get a token but shouldn't be here
            }
        }
    }, [user, isLoading, router, children]);

    if (isLoading) {
        return <div className="p-10 font-mono">DEBUG: Loading...</div>;
    }

    if (!user) return null;

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
