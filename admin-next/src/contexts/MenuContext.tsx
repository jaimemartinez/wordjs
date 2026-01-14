"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface MenuItem {
    href: string;
    label: string;
    icon: string;
    order: number;
    plugin: string;
    cap?: string;
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
            const { apiGet } = await import("@/lib/api");
            const data = await apiGet<MenuItem[]>("/plugins/menus");
            setPluginMenus(data || []);
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
