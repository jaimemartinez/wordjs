/**
 * WordJS Plugin Bundle Loader
 * 
 * Loads pre-compiled plugin bundles dynamically at runtime.
 * CRITICAL: Injects React singleton to prevent "Invalid Hook Call" errors.
 * 
 * The bundles are compiled with externals (react, react-dom) which
 * reference global WordJS.* objects that we inject here.
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import dynamic from 'next/dynamic';
import { ComponentType } from 'react';

// ============================================
// React Singleton Injection
// ============================================

/**
 * Expose React to the global scope for plugin bundles.
 * This MUST match the externals configuration in build-plugin.js
 */
if (typeof window !== 'undefined') {
    // Create WordJS namespace for plugin runtime
    (window as any).WordJS = {
        React: React,
        ReactDOM: ReactDOM,
        ReactDOMClient: ReactDOMClient,
        JSXRuntime: JSXRuntime,
    };

    // Also expose directly for UMD-style bundles
    (window as any).React = React;
    (window as any).ReactDOM = ReactDOM;
}

// ============================================
// Bundle Cache
// ============================================

const bundleCache: Map<string, React.ComponentType<any>> = new Map();
const loadingPromises: Map<string, Promise<React.ComponentType<any>>> = new Map();

// ============================================
// Bundle Loader
// ============================================

/**
 * Load a pre-compiled plugin bundle from the API
 * 
 * @param slug - Plugin slug
 * @param bundleType - Type of bundle (admin, component, hooks)
 * @returns Promise resolving to a React component
 */
export async function loadPluginBundle(
    slug: string,
    bundleType: 'admin' | 'component' | 'hooks' = 'admin'
): Promise<React.ComponentType<any>> {
    const cacheKey = `${slug}:${bundleType}`;

    // Return cached component
    if (bundleCache.has(cacheKey)) {
        return bundleCache.get(cacheKey)!;
    }

    // Return in-flight promise if already loading
    if (loadingPromises.has(cacheKey)) {
        return loadingPromises.get(cacheKey)!;
    }

    // Start loading
    const loadPromise = (async () => {
        try {
            // Fetch the bundle
            const response = await fetch(`/api/v1/plugins/${slug}/bundle?type=${bundleType}`);

            if (!response.ok) {
                console.warn(`[PluginLoader] Bundle not found for ${slug}/${bundleType}`);
                return () => null; // Return empty component
            }

            const bundleCode = await response.text();

            // Create a blob URL for the module
            const blob = new Blob([bundleCode], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);

            try {
                // Dynamic import the blob URL
                const module = await import(/* webpackIgnore: true */ blobUrl);

                // Clean up blob URL
                URL.revokeObjectURL(blobUrl);

                // Get the default export (the React component)
                const Component = module.default || module;

                // Cache and return
                bundleCache.set(cacheKey, Component);
                return Component;

            } catch (evalError) {
                console.error(`[PluginLoader] Failed to evaluate bundle for ${slug}:`, evalError);
                URL.revokeObjectURL(blobUrl);
                return () => null;
            }

        } catch (fetchError) {
            console.error(`[PluginLoader] Failed to fetch bundle for ${slug}:`, fetchError);
            return () => null;
        } finally {
            // Clean up loading promise
            loadingPromises.delete(cacheKey);
        }
    })();

    loadingPromises.set(cacheKey, loadPromise);
    return loadPromise;
}

/**
 * Create a dynamic component that loads from a plugin bundle
 * Use this in place of static imports for plugin components
 */
export function createRemotePluginComponent(
    slug: string,
    bundleType: 'admin' | 'component' | 'hooks' = 'admin',
    fallback: ComponentType<any> = () => null
): ComponentType<any> {
    return dynamic(
        () => loadPluginBundle(slug, bundleType).catch((err) => {
            console.warn(`[PluginLoader] Error loading ${slug}:`, err);
            return { default: fallback };
        }),
        {
            loading: () => null,
            ssr: false, // Bundles are client-only
        }
    );
}

/**
 * Check if a plugin has a pre-compiled bundle available
 */
export async function hasPluginBundle(slug: string): Promise<boolean> {
    try {
        const response = await fetch(`/api/v1/plugins/${slug}/bundle/manifest`);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Clear the bundle cache (call after plugin updates)
 */
export function clearBundleCache(slug?: string): void {
    if (slug) {
        // Clear specific plugin
        for (const key of bundleCache.keys()) {
            if (key.startsWith(`${slug}:`)) {
                bundleCache.delete(key);
            }
        }
    } else {
        // Clear all
        bundleCache.clear();
    }
}

/**
 * Preload plugin bundles for faster subsequent loads
 */
export async function preloadPluginBundles(slugs: string[]): Promise<void> {
    await Promise.all(
        slugs.map(slug => loadPluginBundle(slug).catch(() => null))
    );
}
