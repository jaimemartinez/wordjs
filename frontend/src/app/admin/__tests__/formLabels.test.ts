/**
 * Every visible <label> on these screens names a control: either it says which one (`htmlFor`) or
 * it wraps it. A label that does neither is only text next to a box — a screen reader announced the
 * placeholder ("Enter username") or nothing at all for /login, Settings → General, the Security
 * Center's port and grace-period fields and the install wizard.
 *
 * No DOM test environment in this project, so this reads the source: a `<label …>` head without
 * htmlFor must contain a form control before its `</label>`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const SCREENS = [
    "app/login/page.tsx",
    "app/install/page.tsx",
    "app/admin/settings/page.tsx",
    "app/admin/security/page.tsx",
    "app/admin/security/AutoRenewalPanel.tsx",
    "app/admin/security/ServerSettingsPanel.tsx",
    "app/admin/users/UserFormModal.tsx",
];

function orphanLabels(src: string): string[] {
    const out: string[] = [];
    const re = /<label\b([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        if (/htmlFor=/.test(m[1])) continue;
        const end = src.indexOf("</label>", m.index);
        const body = end < 0 ? "" : src.slice(m.index, end);
        if (/<(input|select|textarea)\b/.test(body)) continue;
        out.push(body.replace(/\s+/g, " ").slice(0, 90));
    }
    return out;
}

describe("form labels name their control", () => {
    for (const file of SCREENS) {
        it(file, () => {
            expect(orphanLabels(readFileSync(resolve(SRC, file), "utf8"))).toEqual([]);
        });
    }
});
