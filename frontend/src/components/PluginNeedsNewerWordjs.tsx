"use client";

import { useOptionalAuth } from "@/contexts/AuthContext";
import { useOptionalI18n } from "@/contexts/I18nContext";
import { t as translate } from "@/lib/i18n";
import { canOpenAdminPath } from "@/lib/adminAccess";
import { ButtonLink } from "@/components/ui/ButtonLink";

/** Where WordJS itself is updated (Admin → Updates). */
const UPDATES_SCREEN = "/admin/update";

/** `{version}` in `text` replaced by `version`. */
const fill = (text: string, version: string) => text.replace("{version}", version);

/**
 * What a plugin's admin page shows when its interface was built for a newer WordJS than this one: the
 * bundle imports a host module this core does not provide ("WordJS host did not provide …"), so it cannot
 * run here. The page used to be blank, or say "temporarily unavailable" — neither tells anyone to update
 * WordJS, which is the fix. With the version the plugin declares (`requires.wordjs`, through the plugin
 * registry) it names it; without one it says a newer WordJS is needed. A viewer who can open the Updates
 * screen gets a link to it; anyone else is told to ask an administrator.
 *
 * Rendered by lib/pluginBundleLoader (remotePluginFailureComponent) for a `core-too-old` load.
 */
export default function PluginNeedsNewerWordjs({ pluginId, minWordjs }: { pluginId: string; minWordjs: string | null }) {
    const auth = useOptionalAuth();
    const i18n = useOptionalI18n();
    const tr = (key: string) => (i18n ? i18n.t(key) : translate(key));
    const canUpdate = canOpenAdminPath(UPDATES_SCREEN, auth?.user ?? null, []);
    return (
        <div className="p-8 flex justify-center" data-wjs-plugin-needs-newer-core={pluginId}>
            <div role="status" className="max-w-xl w-full rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm">
                <h1 className="text-lg font-extrabold mb-2">
                    {minWordjs ? fill(tr("plugins.needsNewerCore.title"), minWordjs) : tr("plugins.needsNewerCore.titleUnknown")}
                </h1>
                <p className="text-sm leading-relaxed">{tr(canUpdate ? "plugins.needsNewerCore.body" : "plugins.needsNewerCore.bodyAskAdmin")}</p>
                {canUpdate && (
                    <ButtonLink href={UPDATES_SCREEN} size="sm" icon="fa-cloud-arrow-down" className="mt-4 inline-flex">
                        {tr("plugins.needsNewerCore.link")}
                    </ButtonLink>
                )}
            </div>
        </div>
    );
}
