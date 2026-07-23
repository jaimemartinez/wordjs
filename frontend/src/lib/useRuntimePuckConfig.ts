"use client";

import { useState, useEffect } from "react";
import { fetchActivePluginIds, loadActivePluginBlocks } from "./pluginBundleLoader";

/**
 * Merge marketplace plugins' Puck blocks into a base Puck config AT RUNTIME.
 *
 * Marketplace plugins are installed after the frontend is built, so their blocks are not compiled into
 * the config. This hook loads the active plugins' pre-built `component` bundles client-side and merges
 * their block configs in.
 *
 * HYDRATION SAFETY: the first render (server SSR + the client's initial hydration render) returns the
 * BASE config unchanged — the blocks load in an effect, which never runs during SSR and has not resolved
 * at hydration time. So server HTML and client hydration match (Puck's render path already skips unknown
 * component types, rendering nothing). Once the bundles load, a re-render adds the blocks. On the public
 * page the plugin block therefore appears just after hydration; built-in blocks still render server-side.
 */
export function useRuntimePuckConfig<T extends { components: Record<string, any> }>(baseConfig: T): T {
    const [blocks, setBlocks] = useState<Record<string, any>>({});

    useEffect(() => {
        let alive = true;
        fetchActivePluginIds()
            .then((ids) => loadActivePluginBlocks(ids))
            .then((b) => {
                if (alive && b && Object.keys(b).length) setBlocks(b);
            })
            .catch(() => { /* a plugin's block bundle failed to load — its block just stays absent */ });
        return () => { alive = false; };
    }, []);

    if (!Object.keys(blocks).length) return baseConfig;
    return { ...baseConfig, components: { ...baseConfig.components, ...blocks } };
}
