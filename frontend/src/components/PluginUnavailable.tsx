"use client";

import { useOptionalI18n } from "@/contexts/I18nContext";
import { t as translate } from "@/lib/i18n";

/**
 * What a plugin's admin page shows when its interface could not be fetched for a reason that says nothing
 * about the plugin itself: the server answered 5xx (restarting, plugins still starting) or did not answer.
 * The page used to fall back to "Plugin Not Found — not installed", which sent administrators to reinstall
 * or to change permissions of a plugin that was installed, active and granted all along.
 *
 * Rendered by lib/pluginBundleLoader (remotePluginFailureComponent) for a `failed` load.
 */
export default function PluginUnavailable({ pluginId }: { pluginId: string }) {
    const i18n = useOptionalI18n();
    const tr = (key: string) => (i18n ? i18n.t(key) : translate(key));
    return (
        <div className="p-8 flex justify-center" data-wjs-plugin-unavailable={pluginId}>
            <div role="status" className="max-w-xl w-full rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-sm">
                <h1 className="text-lg font-extrabold mb-2">{tr("plugins.unavailable.title")}</h1>
                <p className="text-sm leading-relaxed text-slate-600">{tr("plugins.unavailable.body")}</p>
                <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-extrabold uppercase tracking-widest text-white hover:bg-slate-700"
                >
                    <i className="fa-solid fa-rotate-right" aria-hidden="true" />{tr("plugins.unavailable.retry")}
                </button>
            </div>
        </div>
    );
}
