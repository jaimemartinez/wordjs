"use client";

import type { ReactNode } from "react";
import { pluginPermissionsHref } from "@/lib/pluginPermissionsLink";
import { useOptionalAuth } from "@/contexts/AuthContext";
import { useOptionalI18n } from "@/contexts/I18nContext";
import { t as translate } from "@/lib/i18n";
import { canOpenAdminPath, type AdminAccessUser } from "@/lib/adminAccess";

/** The screen the notice's link leads to — the plugins list, which opens that plugin's permissions. */
const PLUGINS_SCREEN = "/admin/plugins";

/**
 * May `viewer` act on the notice — open the plugins screen it links to? The same rule the admin route guard
 * applies to that screen (lib/adminAccess.ts: `activate_plugins`, or an administrator / '*' holder). Anyone
 * else — a plugin team member opening their plugin's page — would be sent straight back by the guard.
 */
export function viewerCanOpenPluginPermissions(viewer: AdminAccessUser | null | undefined): boolean {
    return canOpenAdminPath(PLUGINS_SCREEN, viewer ?? null, []);
}

/** `text` with `{name}` replaced by `node` (the first occurrence; the rest of the text is kept as is). */
function withNode(text: string, name: string, node: ReactNode): ReactNode {
    const at = text.indexOf(`{${name}}`);
    if (at < 0) return text;
    return <>{text.slice(0, at)}{node}{text.slice(at + name.length + 2)}</>;
}

/**
 * What a plugin's admin page shows when its interface is WITHHELD: the plugin is active, but the
 * administrator has not granted it `browser:script`, so the host does not serve its pre-compiled UI
 * (routes/plugin-bundles.ts answers the bundle request with a 404). The page used to render nothing at
 * all in that state — no message, no way to tell a refused plugin from a broken one.
 *
 * Who reads it decides what it says. A viewer who can open the plugins screen
 * (viewerCanOpenPluginPermissions) is told which switch decides it and why the switch matters, with a link
 * to that plugin's permissions. Anyone else — a plugin's team member, whose role opens the plugin's page and
 * not the plugins screen — is told the screen is unavailable and to ask an administrator: a link to a screen
 * the admin guard sends them back from would be a dead end. Outside the auth provider the viewer is unknown
 * and gets the second notice. The text follows the admin's language (lib/i18n.ts `plugins.notGranted.*`).
 *
 * Rendered by lib/pluginBundleLoader (createRemotePluginComponent), which decides the cause from
 * GET /api/v1/plugins/registry.
 */
export default function PluginScriptNotGranted({ pluginId }: { pluginId: string }) {
    const auth = useOptionalAuth();
    const i18n = useOptionalI18n();
    const tr = (key: string) => (i18n ? i18n.t(key) : translate(key));

    if (!viewerCanOpenPluginPermissions(auth?.user)) {
        return (
            <div className="p-8 flex justify-center" data-wjs-plugin-script-not-granted={pluginId}>
                <div role="status" className="max-w-xl w-full rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm">
                    <h1 className="text-lg font-extrabold mb-2">{tr("plugins.notGranted.unavailable.title")}</h1>
                    <p className="text-sm leading-relaxed">{tr("plugins.notGranted.unavailable.body")}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="p-8 flex justify-center" data-wjs-plugin-script-not-granted={pluginId}>
            <div role="status" className="max-w-xl w-full rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm">
                <h1 className="text-lg font-extrabold mb-2">{tr("plugins.notGranted.title")}</h1>
                <p className="text-sm leading-relaxed mb-3">
                    {withNode(tr("plugins.notGranted.body"), "permission",
                        <code className="rounded bg-amber-100 px-1 font-mono text-xs">browser:script</code>)}
                </p>
                <p className="text-xs leading-relaxed text-amber-900/80 mb-4">
                    {withNode(tr("plugins.notGranted.trust"), "plugin",
                        <code className="rounded bg-amber-100 px-1 font-mono">{pluginId}</code>)}
                </p>
                <a
                    href={pluginPermissionsHref(pluginId)}
                    className="inline-block rounded-xl bg-amber-600 px-4 py-2 text-xs font-extrabold uppercase tracking-widest text-white hover:bg-amber-700"
                >
                    {tr("plugins.notGranted.open").replace("{plugin}", pluginId)}
                </a>
            </div>
        </div>
    );
}
