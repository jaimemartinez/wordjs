"use client";
/**
 * Catch-all client island for block types the server renderer does not own: marketplace-plugin
 * blocks and Symbol. A TINY stub on purpose: the actual machinery (<Render> + runtime config,
 * i.e. the whole editor config graph) lives in PluginBlockHeavy behind React.lazy, so its chunk
 * is fetched only when a page actually mounts one of these blocks — pages without them ship none
 * of it. Trade-off (documented): these blocks now paint on the client after hydration instead of
 * in the SSR HTML; core blocks are unaffected (they render on the server).
 */
import React from "react";
import type { IxMotionPolicy, IxPreset } from "@/lib/verso/interactions";

const Heavy = React.lazy(() => import("./PluginBlockHeavy"));

export default function PluginBlockIsland({ item, ixPresets, motion }: { item: any; ixPresets?: Record<string, IxPreset>; motion?: IxMotionPolicy }) {
    return (
        <React.Suspense fallback={null}>
            <Heavy item={item} ixPresets={ixPresets} motion={motion} />
        </React.Suspense>
    );
}
