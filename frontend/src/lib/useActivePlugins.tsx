"use client";

import { useState, useEffect, createContext, useContext, ReactNode } from "react";

/**
 * Dynamic Active Plugins Hook
 * 
 * NO HARDCODED PLUGIN REFERENCES - fetches active plugins from API.
 * If API fails, returns empty array (graceful degradation).
 */

interface ActivePluginsContextType {
    activePlugins: string[];
    loading: boolean;
    isPluginActive: (slug: string) => boolean;
    refresh: () => Promise<void>;
}

const ActivePluginsContext = createContext<ActivePluginsContextType>({
    activePlugins: [],
    loading: true,
    isPluginActive: () => false, // Default to false for safety
    refresh: async () => { },
});

/**
 * Hook to access active plugins state
 */
export function useActivePlugins(): ActivePluginsContextType {
    return useContext(ActivePluginsContext);
}

/**
 * Provider component that fetches and provides active plugin status
 */
export function ActivePluginsProvider({ children }: { children: ReactNode }) {
    const [activePlugins, setActivePlugins] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchActivePlugins = async () => {
        try {
            // Use relative URL for production compatibility
            const res = await fetch("/api/v1/plugins/active");
            if (res.ok) {
                const activeSlugs = await res.json();
                setActivePlugins(activeSlugs);
            } else {
                console.warn("Failed to fetch active plugins, defaulting to empty");
                setActivePlugins([]);
            }
        } catch (err) {
            console.warn("Failed to fetch active plugins:", err);
            // Empty array - no plugins assumed active if API fails
            setActivePlugins([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchActivePlugins();
    }, []);

    const isPluginActive = (slug: string): boolean => {
        // Direct check - slug should match plugin ID exactly
        return activePlugins.includes(slug);
    };

    return (
        <ActivePluginsContext.Provider
            value={{
                activePlugins,
                loading,
                isPluginActive,
                refresh: fetchActivePlugins,
            }}
        >
            {children}
        </ActivePluginsContext.Provider>
    );
}

