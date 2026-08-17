"use client";

import React from "react";
import { settingsApi } from "@/lib/api";

/**
 * EDITOR-CANVAS resolver for the SiteLogo block (mirrors useEditorMenu / useEditorPosts).
 *
 * On the public site the SSR pass (resolveDynamicBlocks) injects `resolvedIdentity` — the site's
 * `blogname` + `site_logo` read ONCE, React-cached — before the block renders, so the canvas shows the
 * real brand. The editor canvas has no server pass; without this the block would only ever show its
 * placeholder. This hook reads the same `/settings` store the public resolver reads, ONCE per editor
 * session (one shared promise for every SiteLogo block), so author preview and published page can
 * never drift.
 *
 * Inert outside the editor: when `injected` was supplied (public site) or `editing` is false it returns
 * the injected value untouched and never fetches.
 */

export interface SiteIdentity {
    blogname: string;
    siteLogo: string;
}

// One in-flight/settled promise for the whole session — the identity is the same for every block.
let identityCache: Promise<SiteIdentity> | null = null;

function fetchIdentity(): Promise<SiteIdentity> {
    if (!identityCache) {
        identityCache = settingsApi
            .get()
            .then((s) => ({
                blogname: typeof s?.blogname === "string" ? s.blogname : "",
                siteLogo: typeof s?.site_logo === "string" ? s.site_logo : "",
            }))
            .catch(() => {
                identityCache = null; // a failed fetch may retry on the next mount
                return { blogname: "", siteLogo: "" };
            });
    }
    return identityCache;
}

export function useEditorIdentity(
    editing: boolean,
    injected: SiteIdentity | undefined,
): SiteIdentity | undefined {
    // The public resolver always injects an object; treat any object as "already resolved".
    const hasInjected = !!injected && typeof injected === "object";
    const [identity, setIdentity] = React.useState<SiteIdentity | null>(null);

    React.useEffect(() => {
        if (!editing || hasInjected) return;
        let dead = false;
        fetchIdentity().then((id) => { if (!dead) setIdentity(id); });
        return () => { dead = true; };
    }, [editing, hasInjected]);

    if (hasInjected) return injected;
    if (!editing) return undefined;
    return identity ?? undefined;
}
