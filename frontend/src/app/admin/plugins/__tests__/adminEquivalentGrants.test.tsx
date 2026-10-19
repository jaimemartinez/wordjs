import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/contexts/I18nContext";
import { PermissionRow, RiskBadge } from "../PermissionRow";
import { permMeta, PERMISSION_META } from "@/lib/permissionMeta";
import { translations } from "@/lib/i18n";

/**
 * A MAIL OR NOTIFICATIONS PROVIDER IS AN ADMINISTRATOR-LEVEL GRANT, AND EVERY GRANT SCREEN SAYS SO.
 *
 * `email:provider` sees every message it sends — reset and verification links included once an
 * administrator lets it carry them — and `notifications:provider` receives every notification unredacted.
 * The dialog used to say "it can send mail on your behalf". Pinned through the real PermissionRow (the
 * activation dialog) and the real permMeta every other grant screen reads (the permissions dialog, the
 * plugin details, the marketplace chips and install confirmation), in every shipped language.
 */

const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const ADMIN_LEVEL = ["email:provider", "notifications:provider"];

describe("administrator-equivalent grants", () => {
    it("are flagged in the platform metadata, high risk", () => {
        for (const token of ADMIN_LEVEL) {
            expect(PERMISSION_META[token].adminEquivalent).toBe(true);
            expect(PERMISSION_META[token].risk).toBe("high");
        }
        expect(PERMISSION_META["database:read"].adminEquivalent).toBeFalsy();
    });

    it("say so in the label and the description, in every language — never just 'send mail on your behalf'", () => {
        for (const lang of ["en", "es", "pt"] as const) {
            const t = (k: string) => translations[lang][k] ?? k;
            for (const token of ADMIN_LEVEL) {
                const meta = permMeta(token, t);
                expect(meta.label).toMatch(/administra/i);
                expect(meta.description || "").toMatch(/administra/i);
            }
            expect(permMeta("email:provider", t).description || "").not.toMatch(/on your behalf|en tu nombre|em seu nome/i);
        }
    });

    it("the activation dialog row carries an explicit administrator-level badge", () => {
        const html = render(<PermissionRow token="email:provider" rolesHeld="granted" />);
        expect(html).toContain("data-admin-equivalent");
        const plain = render(<PermissionRow token="database:read" rolesHeld="granted" />);
        expect(plain).not.toContain("data-admin-equivalent");
    });

    it("RiskBadge only adds the badge when asked", () => {
        expect(render(<RiskBadge risk="high" adminEquivalent />)).toContain("data-admin-equivalent");
        expect(render(<RiskBadge risk="high" />)).not.toContain("data-admin-equivalent");
    });
});
