/**
 * A link that opens ONE plugin's permissions dialog on the admin plugins screen.
 *
 * Used where a plugin's UI is withheld because the administrator has not granted it `browser:script`
 * (lib/pluginBundleLoader → components/PluginScriptNotGranted): the notice links straight to the switch
 * instead of sending the administrator to look for the plugin in the list. The plugins screen reads the
 * parameter back with deepLinkedPlugin once its first list has loaded, opens the dialog of the plugin it
 * names (and nothing, for a name it does not list), and then takes the parameter out of the address bar
 * (withoutPermissionsDeepLink + history.replaceState): the link is consumed, so neither a later reload
 * of the list nor a reload of the page opens the dialog again.
 */

/** The query parameter the admin plugins screen reads. */
export const PERMISSIONS_PARAM = 'permissions';

/** `/admin/plugins?permissions=<pluginId>` — pluginId is the plugin's FOLDER id (its slug in the list). */
export function pluginPermissionsHref(pluginId: string): string {
    return `/admin/plugins?${PERMISSIONS_PARAM}=${encodeURIComponent(pluginId)}`;
}

/**
 * The plugin id a `location.search` string asks to open the permissions of, or null. Only a well-formed
 * plugin slug is returned: the value comes from the URL, and the screen compares it against its own list.
 */
export function permissionsDeepLinkTarget(search: string): string | null {
    let value: string | null;
    try {
        value = new URLSearchParams(search).get(PERMISSIONS_PARAM);
    } catch {
        return null;
    }
    return value && /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

/**
 * The plugin of `plugins` whose permissions dialog `search` asks the plugins screen to open: an
 * installed (not broken) entry whose slug is exactly the one named, else null.
 */
export function deepLinkedPlugin<T extends { slug: string; broken?: boolean }>(plugins: readonly T[], search: string): T | null {
    const target = permissionsDeepLinkTarget(search);
    if (!target) return null;
    return plugins.find((p) => p.slug === target && !p.broken) ?? null;
}

/**
 * The address to hand to `history.replaceState` once the plugins screen has consumed the link: the same
 * `pathname` + `search` + `hash` with every `permissions` parameter removed — however it is spelled, since
 * URLSearchParams reads `permiss%69ons` back as `permissions` too — and every other parameter kept exactly
 * as written, in order. null when `search` carries no such parameter, so there is nothing to rewrite.
 */
export function withoutPermissionsDeepLink(pathname: string, search: string, hash: string): string | null {
    const pairs = (search.startsWith('?') ? search.slice(1) : search).split('&').filter(Boolean);
    const kept = pairs.filter((pair) => {
        let key: string | undefined;
        try {
            key = new URLSearchParams(pair).keys().next().value;
        } catch {
            return true;
        }
        return key !== PERMISSIONS_PARAM;
    });
    if (kept.length === pairs.length) return null;
    return `${pathname}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}
