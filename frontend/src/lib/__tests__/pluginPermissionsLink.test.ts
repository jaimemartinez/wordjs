import { describe, it, expect } from "vitest";
import { pluginPermissionsHref, permissionsDeepLinkTarget, deepLinkedPlugin, withoutPermissionsDeepLink } from "../pluginPermissionsLink";

/**
 * The link from a withheld plugin page (browser:script not granted — components/PluginScriptNotGranted)
 * to that plugin's permissions dialog on /admin/plugins. The screen opens the dialog of the plugin the
 * parameter names, so what it reads back must be exactly what the notice wrote — and nothing that is not
 * a plugin slug.
 */
describe("plugin permissions deep link", () => {
    it("round-trips a plugin folder id", () => {
        const href = pluginPermissionsHref("conference-manager");
        expect(href).toBe("/admin/plugins?permissions=conference-manager");
        expect(permissionsDeepLinkTarget(href.slice(href.indexOf("?")))).toBe("conference-manager");
    });

    it("reads nothing when the parameter is absent or empty", () => {
        expect(permissionsDeepLinkTarget("")).toBeNull();
        expect(permissionsDeepLinkTarget("?tab=marketplace")).toBeNull();
        expect(permissionsDeepLinkTarget("?permissions=")).toBeNull();
    });

    it("refuses anything that is not a plugin slug", () => {
        for (const bad of ["../x", "a b", "<script>", "mail-server/../core", "%2e%2e"]) {
            expect(permissionsDeepLinkTarget(`?permissions=${encodeURIComponent(bad)}`)).toBeNull();
        }
    });

    it("picks the installed plugin the link names — the one whose dialog the plugins screen opens", () => {
        const plugins = [
            { slug: "faq" },
            { slug: "conference-manager" },
            { slug: "orphan", broken: true },
        ];
        expect(deepLinkedPlugin(plugins, "?permissions=conference-manager")).toBe(plugins[1]);
        expect(deepLinkedPlugin(plugins, "?permissions=orphan")).toBeNull();      // no dialog for a broken entry
        expect(deepLinkedPlugin(plugins, "?permissions=not-listed")).toBeNull();
        expect(deepLinkedPlugin(plugins, "")).toBeNull();
    });

    it("is consumed: the address the screen replaces its entry with has no permissions parameter left", () => {
        expect(withoutPermissionsDeepLink("/admin/plugins", "?permissions=mail-server", "")).toBe("/admin/plugins");
        // Everything else is kept exactly as written and in order, fragment included.
        expect(withoutPermissionsDeepLink("/admin/plugins", "?a=1&permissions=x&b=c%20d+e", "#top"))
            .toBe("/admin/plugins?a=1&b=c%20d+e#top");
        // Every spelling the reader would accept goes, so what remains cannot open a dialog again.
        const rest = withoutPermissionsDeepLink("/admin/plugins", "?permiss%69ons=faq&permissions=x&q=1", "");
        expect(rest).toBe("/admin/plugins?q=1");
        expect(permissionsDeepLinkTarget(rest!.slice(rest!.indexOf("?")))).toBeNull();
    });

    it("rewrites nothing when there is no permissions parameter", () => {
        expect(withoutPermissionsDeepLink("/admin/plugins", "", "")).toBeNull();
        expect(withoutPermissionsDeepLink("/admin/plugins", "?tab=marketplace", "#x")).toBeNull();
        expect(withoutPermissionsDeepLink("/admin/plugins", "?permissionsx=1", "")).toBeNull();
    });
});
