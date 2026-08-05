"use client";
/**
 * The HEAVY half of PluginBlockIsland — <Render> + the full runtime config (editor config with
 * plugin blocks merged). Loaded via React.lazy from the island stub, so this chunk is fetched
 * ONLY when a page actually mounts a plugin/Symbol block.
 */
import { Render } from "@wordjs/puck";
import "@wordjs/puck/puck.css";
import { pageConfig } from "@/components/puckConfig";
import { useRuntimePuckConfig } from "@/lib/useRuntimePuckConfig";

export default function PluginBlockHeavy({ item }: { item: any }) {
    const config = useRuntimePuckConfig(pageConfig);
    const data = { content: [item], root: { props: {} } };
    return <Render config={config} data={data as any} />;
}
