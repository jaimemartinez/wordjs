import { describe, it, expect, vi } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * «NUEVO USUARIO» IS IN THE ADMIN'S LANGUAGE AND READABLE.
 *
 * Live review: in the Spanish admin the dialog said «New User», «Create a new user account», «Role»,
 * «Cancel», «Save User»; its field labels and helper text were gray-400 on white, 2.6:1 (WCAG AA asks
 * 4.5:1). The full-page user editor (users/[id]) had the same grey labels.
 */

vi.mock("@/lib/api", () => ({ usersApi: {}, rolesApi: { list: async () => ({}) } }));

import { I18nProvider } from "@/contexts/I18nContext";
import { ModalProvider } from "@/contexts/ModalContext";
import { translations } from "@/lib/i18n";
import UserFormModal, { FIELD_LABEL, HELP_TEXT } from "../UserFormModal";
import { AA, contrastOf, textClassOf } from "@/lib/__tests__/helpers/tailwindContrast";

const ES = translations.es;
const render = (user: "new") => renderToStaticMarkup(
    <I18nProvider><ModalProvider><UserFormModal user={user} onClose={() => undefined} onSuccess={() => undefined} /></ModalProvider></I18nProvider>,
);

describe("UserFormModal", () => {
    it("is in the admin's language (es on the server render)", () => {
        const html = render("new");
        for (const key of ["user.edit.titleNew", "user.edit.subtitleNew", "user.edit.username", "user.edit.email", "user.edit.personalEmail",
            "user.edit.displayName", "user.edit.role", "user.edit.password", "user.edit.cancel", "user.edit.save"]) {
            expect(html, key).toContain(ES[key]);
        }
        for (const english of ["New User", "Create a new user account", ">Role<", ">Cancel<", "Save User", "Display Name", "External address"]) {
            expect(html, english).not.toContain(english);
        }
        expect(html).toContain(`aria-label="${ES["common.close"]}"`);
    });

    it("an existing user's subtitle names them, in every language", () => {
        for (const lang of ["es", "en", "pt"] as const) {
            expect(translations[lang]["user.edit.subtitleEditing"], lang).toContain("@{username}");
        }
    });

    it("its labels and helper text meet WCAG AA on the white card", () => {
        expect(contrastOf(textClassOf(FIELD_LABEL))).toBeGreaterThanOrEqual(AA);
        expect(contrastOf(textClassOf(HELP_TEXT))).toBeGreaterThanOrEqual(AA);
        const html = render("new");
        expect(html).not.toMatch(/<label class="[^"]*text-gray-400/);
    });

    it("the full-page user editor (users/[id]) has no gray-400 labels or helper text either", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../[id]/page.tsx"), "utf8");
        expect(src).not.toMatch(/<label className="[^"]*text-gray-400/);
        expect(src).not.toMatch(/<p className="text-\[11px\] text-gray-400/);
    });

    it("the full-page editor's «back» link meets AA too (it was gray-400, ~2.6:1)", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../[id]/page.tsx"), "utf8");
        const m = /className="([^"]*)" data-user-edit-back=""/.exec(src);
        expect(m).toBeTruthy();
        const text = m![1].split(/\s+/).filter((k) => /^text-gray-\d+$/.test(k));
        expect(text).toHaveLength(1);
        expect(contrastOf(text[0], "white")).toBeGreaterThanOrEqual(AA);
        expect(contrastOf(text[0], "gray-50")).toBeGreaterThanOrEqual(AA);
    });
});
