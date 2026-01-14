"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface MenuItem {
    href: string;
    label: string;
    icon: string;
    order: number;
    plugin: string;
}

interface MenuContextType {
    pluginMenus: MenuItem[];
    refreshMenus: () => Promise<void>;
    isLoading: boolean;
}

const MenuContext = createContext<MenuContextType | undefined>(undefined);

export function MenuProvider({ children }: { children: React.ReactNode }) {
    const [pluginMenus, setPluginMenus] = useState<MenuItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const refreshMenus = useCallback(async () => {
        try {
            // Use relative path for client-side fetch (handled by next.config.js or direct relative path)
            // or use specific API URL if needed. Assuming relative path works as per previous tasks.
            const res = await fetch("/api/v1/plugins/menus");
            if (res.ok) {
                const data = await res.json();
                setPluginMenus(data || []);
            } else {
                console.error("Failed to fetch menus");
                setPluginMenus([]);
            }
        } catch (error) {
            console.error("Error refreshing menus:", error);
            setPluginMenus([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Initial load
    useEffect(() => {
        refreshMenus();
    }, [refreshMenus]);

    return (
        <MenuContext.Provider value={{ pluginMenus, refreshMenus, isLoading }}>
            {children}
        </MenuContext.Provider>
    );
}

export function useMenu() {
    const context = useContext(MenuContext);
    if (context === undefined) {
        throw new Error("useMenu must be used within a MenuProvider");
    }
    return context;
}
