import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE USER SCREEN RENDERS PLUGIN ACCOUNT CAPABILITIES GENERICALLY.
 *
 * The core user form used to carry a mail-specific `professionalMailbox` field for one plugin's toggle.
 * It now renders whatever the active plugins declare (GET /users/account-capabilities), one switch each,
 * from the declaration's own name and description, and submits a map of capability → on/off.
 */

import { AccountCapabilityList, grantedMap, withNewAccountDefaults } from "../AccountCapabilityToggles";
import { translations } from "@/lib/i18n";
import { AA, contrastOf, textClassOf } from "@/lib/__tests__/helpers/tailwindContrast";

const decl = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug, plugin: "probe", name: `Name of ${slug}`, description: `About ${slug}`, locksEmail: false, defaultForNewAccounts: false, ...extra,
});
const render = (declared: any[], value: Record<string, boolean>) => renderToStaticMarkup(
    <AccountCapabilityList declared={declared} value={value} onChange={() => undefined} legend="Plugin access" />,
);

describe("AccountCapabilityToggles", () => {
    it("renders one switch per declaration, from the declaration's own name and description, in its true state", () => {
        const html = render([decl("probe_a"), decl("probe_b")], { probe_a: true });
        expect(html).toContain("Plugin access");
        expect(html).toContain("Name of probe_a");
        expect(html).toContain("About probe_b");
        expect(html).toMatch(/role="switch" aria-checked="true" data-account-capability="probe_a"/);
        expect(html).toMatch(/role="switch" aria-checked="false" data-account-capability="probe_b"/);
        expect(html).toContain('for="account-capability-probe_a"');
    });

    it("renders nothing when no active plugin declares one (or the viewer may not grant them)", () => {
        expect(render([], {})).toBe("");
    });

    it("seeds the form from the granted list, and applies a plugin's new-account default only when unset", () => {
        expect(grantedMap(["probe_a"])).toEqual({ probe_a: true });
        expect(grantedMap(undefined)).toEqual({});
        const declared = [decl("probe_a", { defaultForNewAccounts: true }), decl("probe_b")];
        expect(withNewAccountDefaults(declared, {})).toEqual({ probe_a: true });
        expect(withNewAccountDefaults(declared, { probe_a: false }), "an explicit off is kept").toBeNull();
        expect(withNewAccountDefaults([decl("probe_b")], {})).toBeNull();
    });

    it("its text meets WCAG AA on the light card", () => {
        const html = render([decl("probe_a")], {});
        for (const cls of ["text-gray-500", "text-gray-600", "text-gray-900"]) {
            if (html.includes(cls)) expect(contrastOf(textClassOf(cls)), cls).toBeGreaterThanOrEqual(AA);
        }
    });

    it("both user screens use it, and neither knows a plugin-specific field any more", () => {
        for (const file of ["../UserFormModal.tsx", "../[id]/page.tsx"]) {
            const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
            expect(src, file).toContain("<AccountCapabilityToggles");
            expect(src, file).not.toMatch(/professionalMailbox|mailbox/i);
        }
    });

    it("the legend is translated in every language", () => {
        for (const lang of ["es", "en", "pt"] as const) {
            expect(translations[lang]["user.edit.accountCapabilities"], lang).toBeTruthy();
        }
    });
});
