import { pluginPermissionsHref } from "@/lib/pluginPermissionsLink";

/**
 * What a plugin's admin page shows when its interface is WITHHELD: the plugin is active, but the
 * administrator has not granted it `browser:script`, so the host does not serve its pre-compiled UI
 * (routes/plugin-bundles.ts answers the bundle request with a 404). The page used to render nothing at
 * all in that state — no message, no way to tell a refused plugin from a broken one. This says which
 * switch decides it, links to that plugin's permissions, and repeats why the switch matters.
 *
 * Rendered by lib/pluginBundleLoader (createRemotePluginComponent), which decides the cause from
 * GET /api/v1/plugins/registry. Plain markup and a plain link: no hooks, no context.
 */
export default function PluginScriptNotGranted({ pluginId }: { pluginId: string }) {
    return (
        <div className="p-8 flex justify-center" data-wjs-plugin-script-not-granted={pluginId}>
            <div role="status" className="max-w-xl w-full rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm">
                <h1 className="text-lg font-extrabold mb-2">This plugin&apos;s interface is not loaded</h1>
                <p className="text-sm leading-relaxed mb-3">
                    This plugin&apos;s interface is not served until you grant &apos;Run code in your browser&apos;
                    (<code className="rounded bg-amber-100 px-1 font-mono text-xs">browser:script</code>) in
                    Admin → Plugins → Permissions.
                </p>
                <p className="text-xs leading-relaxed text-amber-900/80 mb-4">
                    That permission runs the plugin&apos;s code in this admin app with the session of whoever opens
                    it. Grant it only if you trust <code className="rounded bg-amber-100 px-1 font-mono">{pluginId}</code> as
                    much as an administrator account. Only an administrator can grant it.
                </p>
                <a
                    href={pluginPermissionsHref(pluginId)}
                    className="inline-block rounded-xl bg-amber-600 px-4 py-2 text-xs font-extrabold uppercase tracking-widest text-white hover:bg-amber-700"
                >
                    Open the permissions of {pluginId}
                </a>
            </div>
        </div>
    );
}
