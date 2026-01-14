"use client";

import { useState } from "react";
import Header from "@/components/public/Header";
import Footer from "@/components/public/Footer";
import PublicSidebar from "@/components/public/PublicSidebar";
import ThemeLoader from "@/components/public/ThemeLoader";
import { ActivePluginsProvider } from "@/lib/useActivePlugins";

export default function PublicLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const [hasSidebar, setHasSidebar] = useState(true);

    return (
        <ActivePluginsProvider>
            <div className="min-h-screen flex flex-col bg-slate-50">
                <ThemeLoader />
                <Header />
                <main className="flex-1 pt-24 pb-10 container mx-auto px-4">
                    {children}
                </main>
                <Footer />
            </div>
        </ActivePluginsProvider>
    );
}
