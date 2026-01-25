"use client";

import { Suspense } from "react";
import { getPluginComponent, isPluginAvailable } from "@/lib/pluginRegistry";
import { useActivePlugins } from "@/lib/useActivePlugins";

interface PluginLoaderProps {
    /** Plugin slug/shortcode to load */
    slug: string;
    /** Props to pass to the plugin component */
    props?: Record<string, any>;
    /** Fallback content while loading (optional) */
    fallback?: React.ReactNode;
    /** Skip activation check (for essential plugins) */
    skipActiveCheck?: boolean;
}

/**
 * PluginLoader - Dynamically loads and renders plugin components
 * 
 * Features:
 * - Checks if plugin is ACTIVE before rendering
 * - Graceful degradation: If plugin doesn't exist or is inactive, renders nothing
 * - Lazy loading: Components are loaded on demand
 * 
 * Usage:
 * <PluginLoader slug="cards" />
 * <PluginLoader slug="carousel" props={{ location: "hero" }} />
 */
export default function PluginLoader({
    slug,
    props = {},
    fallback = null,
    skipActiveCheck = false
}: PluginLoaderProps) {
    const { isPluginActive, loading } = useActivePlugins();

    // Wait for active plugins to load
    if (loading) {
        return <>{fallback}</>;
    }

    // Check if plugin is active (unless skipped)
    if (!skipActiveCheck && !isPluginActive(slug)) {
        // Plugin is not active - don't render
        return null;
    }

    // Check if plugin is available in registry
    if (!isPluginAvailable(slug)) {
        return null;
    }

    // Get the dynamically loaded component
    const Component = getPluginComponent(slug);

    if (!Component) {
        return null;
    }

    return (
        <Suspense fallback={fallback}>
            <Component {...props} />
        </Suspense>
    );
}
