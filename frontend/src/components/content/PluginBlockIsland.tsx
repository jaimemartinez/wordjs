"use client";
/**
 * Catch-all client island for block types the server renderer does not own: marketplace-plugin
 * blocks (merged into the config at runtime) and Symbol (whose render binds to the full component
 * map). Renders the single item through the SAME client machinery the whole page used before F3
 * (<Render> + runtime config), so behavior is identical — but the cost is now paid ONLY by pages
 * that actually contain such a block, as its chunk code-splits away from the base page bundle.
 */
import { Render } from "@wordjs/puck";
import { pageConfig } from "@/components/puckConfig";
import { useRuntimePuckConfig } from "@/lib/useRuntimePuckConfig";

export default function PluginBlockIsland({ item }: { item: any }) {
    const config = useRuntimePuckConfig(pageConfig);
    const data = { content: [item], root: { props: {} } };
    return <Render config={config} data={data as any} />;
}
