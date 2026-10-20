/**
 * Multisite: the network-wide tools of the admin (the hooks registry, the database migration tool, the
 * site's addresses, the media storage) are offered to a NETWORK administrator on the main site — the
 * server refuses an administrator of the main site who is not one — and, on a single site, to every
 * administrator exactly as before. Backups are every site's own: the main site's for its network
 * administrators, another site's for that site's administrators.
 *
 * MUTATION PROOF (verified once): drop the `networkWide` line from siteOffers, or the network clause from
 * canManageSiteAddress → this file fails.
 */
import { describe, it, expect } from "vitest";
import { canOpenAdminPath, sidebarSections } from "../adminAccess";
import { canManageSiteAddress } from "../siteAddress";

const admin = (network?: { mainSite: boolean; networkAdmin: boolean }) => ({ role: "administrator", capabilities: ["*"], network });
const SINGLE = admin();
const NETWORK_ADMIN = admin({ mainSite: true, networkAdmin: true });
const MAIN_ONLY = admin({ mainSite: true, networkAdmin: false });
const OTHER_SITE = admin({ mainSite: false, networkAdmin: false });

const NETWORK_WIDE = ["/admin/hooks", "/admin/db-migration", "/admin/settings/site-address", "/admin/settings/media-storage"];
const hrefs = (user: any) => {
    const { core, management } = sidebarSections(user, []);
    return [...core, ...management].map((i) => i.href);
};

describe("network-wide admin tools", () => {
    it("a single site's administrator and a network administrator open every one of them", () => {
        for (const user of [SINGLE, NETWORK_ADMIN]) {
            for (const p of NETWORK_WIDE) expect(canOpenAdminPath(p, user, []), `${p}`).toBe(true);
        }
        expect(hrefs(SINGLE)).toEqual(expect.arrayContaining(["/admin/settings/backups", "/admin/hooks", "/admin/db-migration"]));
        expect(hrefs(NETWORK_ADMIN)).toEqual(expect.arrayContaining(["/admin/settings/backups", "/admin/hooks", "/admin/db-migration"]));
    });

    it("an administrator of the main site who is not a network administrator, or of another site, is not offered them", () => {
        for (const user of [MAIN_ONLY, OTHER_SITE]) {
            for (const p of NETWORK_WIDE) expect(canOpenAdminPath(p, user, []), `${p}`).toBe(false);
            for (const p of ["/admin/hooks", "/admin/db-migration"]) expect(hrefs(user)).not.toContain(p);
        }
    });

    it("backups: the main site's for its network administrators, every other site's for its own administrators", () => {
        for (const user of [SINGLE, NETWORK_ADMIN, OTHER_SITE]) {
            expect(canOpenAdminPath("/admin/settings/backups", user, [])).toBe(true);
            expect(hrefs(user)).toContain("/admin/settings/backups");
        }
        expect(canOpenAdminPath("/admin/settings/backups", MAIN_ONLY, [])).toBe(false);
        expect(hrefs(MAIN_ONLY)).not.toContain("/admin/settings/backups");
    });

    it("what is the site's own stays (plugins on the main site, settings, users)", () => {
        expect(canOpenAdminPath("/admin/plugins", MAIN_ONLY, [])).toBe(true);
        expect(canOpenAdminPath("/admin/settings", MAIN_ONLY, [])).toBe(true);
        expect(canOpenAdminPath("/admin/users", MAIN_ONLY, [])).toBe(true);
    });

    it("the site-address banners follow the same rule", () => {
        expect(canManageSiteAddress(SINGLE)).toBe(true);
        expect(canManageSiteAddress(NETWORK_ADMIN)).toBe(true);
        expect(canManageSiteAddress(MAIN_ONLY)).toBe(false);
        expect(canManageSiteAddress(OTHER_SITE)).toBe(false);
    });
});
