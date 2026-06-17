"use client";

import Header from "@/components/public/Header";
import Footer from "@/components/public/Footer";
import ThemeLoader from "@/components/public/ThemeLoader";
import { ActivePluginsProvider } from "@/lib/useActivePlugins";

export default function PublicLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <ActivePluginsProvider>
            <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--wjs-bg-canvas, #f8fafc)' }}>
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
