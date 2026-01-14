"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import Sidebar from "@/components/Sidebar";
import { UnsavedChangesProvider } from "@/contexts/UnsavedChangesContext";

function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
    const { user, isLoading } = useAuth();
    const router = useRouter();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);

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
        if (!isLoading && !user) {
            router.push("/login");
        }
    }, [user, isLoading, router]);

    if (isLoading) {
        return (
            <div className="min-h-screen bg-gray-100 flex items-center justify-center">
                <div className="text-xl text-gray-500">Loading...</div>
            </div>
        );
    }

    if (!user) {
        return null;
    }

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
                    hidden md:flex absolute top-10 z-50 w-8 h-8 bg-white border border-gray-200 rounded-full items-center justify-center text-gray-500 hover:text-blue-500 hover:border-blue-200 shadow-lg transition-all duration-300
                    ${isCollapsed ? 'left-[80px]' : 'left-[304px]'}
                `}
                title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
                <i className={`fa-solid fa-chevron-${isCollapsed ? 'right' : 'left'} text-xs`}></i>
            </button>

            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
                {/* Mobile Header */}
                <header className="md:hidden bg-white border-b p-4 flex items-center justify-between sticky top-0 z-20 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => setSidebarOpen(true)}
                            className="text-gray-600 hover:text-gray-900 focus:outline-none"
                        >
                            <i className="fa-solid fa-bars text-xl"></i>
                        </button>
                        <span className="font-bold text-gray-800 flex items-center gap-2">
                            <i className="fa-solid fa-rocket text-blue-500"></i> WordJS
                        </span>
                    </div>
                </header>

                <main className="flex-1 relative bg-white flex flex-col h-full overflow-hidden">
                    {children}
                </main>
            </div>
        </div>
    );
}

import { MenuProvider } from "@/contexts/MenuContext";
import { ToastProvider } from "@/contexts/ToastContext";

export default function DashboardLayoutClient({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <AuthProvider>
            <UnsavedChangesProvider>
                <ToastProvider>
                    <MenuProvider>
                        <DashboardLayoutContent>{children}</DashboardLayoutContent>
                    </MenuProvider>
                </ToastProvider>
            </UnsavedChangesProvider>
        </AuthProvider>
    );
}
