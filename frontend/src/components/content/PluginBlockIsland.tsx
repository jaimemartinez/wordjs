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

const Heavy = React.lazy(() => import("./PluginBlockHeavy"));

export default function PluginBlockIsland({ item }: { item: any }) {
    return (
        <React.Suspense fallback={null}>
            <Heavy item={item} />
        </React.Suspense>
    );
}
