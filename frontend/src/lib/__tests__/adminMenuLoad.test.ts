import { describe, it, expect } from "vitest";
import { MenuLoader, isMfaBlocked, menuLoadKey, type MenuLoadState } from "../adminMenuLoad";
import { decideAdminRoute, type AdminMenuItem } from "../adminAccess";

/**
 * THE PLUGIN MENU FOLLOWS THE SIGNED-IN IDENTITY (lib/adminMenuLoad.ts, used by contexts/MenuContext.tsx).
 *
 * The admin route guard opens /admin/plugin/<slug> only through a menu item of the user's own, so a stale
 * or failed GET /plugins/menus is no longer cosmetic: it sends a plugin team member away from their screen.
 * The case that broke: a team member under enforced two-factor signs in — the API answers 403 to the menu
 * while they are held at enrolment — enrols, and was then stuck on their account page (no Conference
 * entry, no landing) until a full reload, because the menu had been fetched exactly once, at mount.
 */

const CM_ITEM: AdminMenuItem = {
    href: "/admin/plugin/conference-manager", label: "Conference", icon: "fa-calendar",
    cap: "conference_manager_access", plugin: "conference-manager", section: "core",
};
const TEAM_CAPS = ["read", "access_admin_panel", "conference_manager_access"];

/** A manual scheduler: retries run only when the test says so. */
function manualSchedule() {
    const queue: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    return {
        queue,
        schedule: (fn: () => void, ms: number) => {
            const entry = { fn, ms, cancelled: false };
            queue.push(entry);
            return () => { entry.cancelled = true; };
        },
        runNext: () => {
            const next = queue.shift();
            if (next && !next.cancelled) next.fn();
        },
    };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("menuLoadKey: which identity the menu is loaded for", () => {
    it("loads nothing while the session resolves, for nobody, or for a user held at two-factor enrolment", () => {
        expect(menuLoadKey({ id: 1, role: "subscriber" }, true)).toBeNull();
        expect(menuLoadKey(null, false)).toBeNull();
        expect(menuLoadKey({ id: 1, role: "conference_manager_team", mfa: { enforced: true, enabled: false } }, false)).toBeNull();
        expect(isMfaBlocked({ mfa: { enforced: true, enabled: false } })).toBe(true);
        expect(isMfaBlocked({ mfa: { enforced: true, enabled: true } })).toBe(false);
    });

    it("enrolling, a role change or another account is a NEW identity — the menu loads again", () => {
        const blocked = menuLoadKey({ id: 7, role: "conference_manager_team", mfa: { enforced: true, enabled: false } }, false);
        const enrolled = menuLoadKey({ id: 7, role: "conference_manager_team", mfa: { enforced: true, enabled: true } }, false);
        const otherRole = menuLoadKey({ id: 7, role: "subscriber", mfa: { enforced: true, enabled: true } }, false);
        const otherUser = menuLoadKey({ id: 8, role: "conference_manager_team" }, false);
        expect(blocked).toBeNull();
        expect(enrolled).not.toBeNull();
        expect(new Set([enrolled, otherRole, otherUser]).size).toBe(3);
        // The same identity keeps its key (no reload on every render).
        expect(menuLoadKey({ id: 7, role: "conference_manager_team", mfa: { enforced: true, enabled: true } }, false)).toBe(enrolled);
    });
});

describe("MenuLoader", () => {
    const make = (fetchMenus: () => Promise<AdminMenuItem[]>, extra: Partial<ConstructorParameters<typeof MenuLoader<AdminMenuItem>>[0]> = {}) => {
        const states: MenuLoadState<AdminMenuItem>[] = [];
        const sched = manualSchedule();
        const loader = new MenuLoader<AdminMenuItem>({ fetchMenus, onChange: (s) => states.push(s), schedule: sched.schedule, retryDelaysMs: [10, 20], ...extra });
        return { loader, states, sched };
    };

    it("the two-factor case: nothing while blocked; after enrolling the menu loads and the plugin page opens", async () => {
        let calls = 0;
        const { loader } = make(async () => { calls++; return [CM_ITEM]; });
        const team = { id: 7, role: "conference_manager_team", capabilities: TEAM_CAPS };
        await loader.setKey(menuLoadKey({ ...team, mfa: { enforced: true, enabled: false } }, false));
        expect(calls).toBe(0);
        expect(loader.getState().loaded).toBe(false);
        // Held at enrolment the guard never decides, so nothing redirects; once enrolled:
        await loader.setKey(menuLoadKey({ ...team, mfa: { enforced: true, enabled: true } }, false));
        expect(calls).toBe(1);
        const st = loader.getState();
        expect(st.loaded).toBe(true);
        expect(decideAdminRoute({ pathname: "/admin/plugin/conference-manager", user: team, pluginMenus: st.menus, menusLoaded: st.loaded })).toEqual({ kind: "allow" });
        expect(decideAdminRoute({ pathname: "/admin", user: team, pluginMenus: st.menus, menusLoaded: st.loaded }))
            .toEqual({ kind: "redirect", to: "/admin/plugin/conference-manager" });
    });

    it("a failed load is retried, not taken for an empty menu", async () => {
        let calls = 0;
        const { loader, sched } = make(async () => { calls++; if (calls < 3) throw new Error("503"); return [CM_ITEM]; });
        const done = loader.setKey("7|team");
        await flush();
        expect(loader.getState()).toMatchObject({ loaded: false, failed: false });
        sched.runNext(); await flush();
        expect(loader.getState().loaded).toBe(false);
        sched.runNext(); await done;
        expect(loader.getState()).toMatchObject({ loaded: true, failed: false, menus: [CM_ITEM] });
        expect(sched.queue.length).toBe(0);
        expect(calls).toBe(3);
    });

    it("after the last retry the menu counts as loaded and failed (the guard then falls back to the account page)", async () => {
        const { loader, sched } = make(async () => { throw new Error("down"); });
        const done = loader.setKey("7|team");
        await flush(); sched.runNext(); await flush(); sched.runNext(); await done;
        expect(loader.getState()).toMatchObject({ key: "7|team", loaded: true, failed: true, menus: [] });
    });

    it("an ended session is not retried", async () => {
        class Ended extends Error {}
        let calls = 0;
        const { loader, sched } = make(async () => { calls++; throw new Ended(); }, { isTerminal: (e) => e instanceof Ended });
        await loader.setKey("7|team");
        expect(calls).toBe(1);
        expect(sched.queue.length).toBe(0);
        expect(loader.getState()).toMatchObject({ loaded: true, failed: true });
    });

    it("an answer for an identity that is no longer signed in is ignored", async () => {
        let resolveFirst: (v: AdminMenuItem[]) => void = () => undefined;
        let call = 0;
        const { loader } = make(() => {
            call++;
            return call === 1 ? new Promise<AdminMenuItem[]>((r) => { resolveFirst = r; }) : Promise.resolve([]);
        });
        const first = loader.setKey("7|conference_manager_team");
        await loader.setKey("8|subscriber");
        resolveFirst([CM_ITEM]);
        await first;
        expect(loader.getState()).toMatchObject({ key: "8|subscriber", loaded: true, menus: [] });
    });

    it("the same identity is not reloaded on every render; refresh() reloads it (a plugin was activated)", async () => {
        let calls = 0;
        const { loader } = make(async () => { calls++; return calls === 1 ? [] : [CM_ITEM]; });
        await loader.setKey("1|administrator");
        await loader.setKey("1|administrator");
        expect(calls).toBe(1);
        await loader.refresh();
        expect(calls).toBe(2);
        expect(loader.getState().menus).toEqual([CM_ITEM]);
    });

    it("signing out empties the menu", async () => {
        const { loader } = make(async () => [CM_ITEM]);
        await loader.setKey("7|team");
        await loader.setKey(null);
        expect(loader.getState()).toMatchObject({ key: null, menus: [], loaded: false });
    });
});
