/**
 * The site-address strings: every key the screen, the dashboard banners and the notices ask for exists
 * in es/en/pt — including the keys built at runtime from a value (`siteAddress.error.${code}`), which no
 * type checker sees — and every string added for them is actually used.
 *
 * A missing key does not fail anything else: `t()` returns the key itself, so the admin would read
 * "siteAddress.dependent.gatewayUrl" in the one dialog that explains why an address cannot be removed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { translations, type Language } from "@/lib/i18n";
import type { AliasError, CanonicalNote, HostClass, IpLiteralMode, OldAddressAction, RefusalHint, RefusalSource, SignInWarning } from "@/lib/siteAddress";
import type { SignInRefusal } from "@/contexts/AuthContext";

const SRC = path.resolve(import.meta.dirname, "../../../../..");
const CONSUMERS = [
    "app/admin/settings/site-address/page.tsx",
    "app/admin/settings/site-address/RefusedByLabel.tsx",
    "app/admin/DashboardLayoutClient.tsx",
    "app/admin/settings/page.tsx",
    "components/HostNotAllowedNotice.tsx",
    "contexts/AuthContext.tsx",
];
const OWN_PREFIXES = ["siteAddress.", "siteBanner.", "hostNotice.", "settings.siteAddress."];

/** Literal keys passed to t(): `t("x")` / `t('x')`. */
function literalKeys(): Set<string> {
    const keys = new Set<string>();
    for (const file of CONSUMERS) {
        const source = fs.readFileSync(path.join(SRC, file), "utf8");
        for (const m of source.matchAll(/\bt\(\s*["']([A-Za-z0-9_.-]+)["']/g)) keys.add(m[1]);
        // `t(cond ? "a" : "b")`
        for (const m of source.matchAll(/\bt\(\s*[^()]*?\?\s*["']([A-Za-z0-9_.-]+)["']\s*:\s*["']([A-Za-z0-9_.-]+)["']\s*\)/g)) {
            keys.add(m[1]);
            keys.add(m[2]);
        }
        // Any complete key of ours written as a string literal (e.g. picked into a variable first).
        for (const m of source.matchAll(/["'](hostNotice\.[A-Za-z0-9_.-]+|siteBanner\.[A-Za-z0-9_.-]+)["']/g)) keys.add(m[1]);
    }
    return keys;
}

// The value families the screen turns into keys at runtime. Typed against the lib's unions, so adding a
// value there without listing it here is a type error, and listing it here without a string fails below.
const errors: Record<AliasError | "is-canonical" | "invalid" | "localConfirm", true> = {
    invalid: true, "is-canonical": true, duplicate: true, "expiry-past": true, "expiry-invalid": true, localConfirm: true,
};
const classes: Record<HostClass | "unknown", true> = { canonical: true, alias: true, env: true, loopback: true, ip: true, dev: true, unknown: true };
const hints: Record<RefusalHint, true> = { "forward-host": true, tunnel: true, "www-apex": true, local: true };
const refusedBy: Record<RefusalSource, true> = { edge: true, gate: true, both: true };
const notes: Record<CanonicalNote, true> = { links: true, mail: true, tls: true, seo: true, downgrade: true, dropCurrent: true };
const ipModes: Record<IpLiteralMode, true> = { any: true, own: true, none: true };
const oldActions: Record<OldAddressAction, true> = { keep: true, redirect: true, drop: true };
const warnings: Record<Exclude<SignInWarning, null>, true> = { "plain-http": true, ip: true, tunnel: true, local: true };
const refusals: Record<SignInRefusal, true> = { transport: true, address: true };

const DYNAMIC = [
    ...Object.keys(errors).map((k) => `siteAddress.error.${k}`),
    ...Object.keys(classes).map((k) => `siteAddress.cls.${k}`),
    ...Object.keys(hints).map((k) => `siteAddress.hint.${k}`),
    ...Object.keys(refusedBy).map((k) => `siteAddress.refusedBy.${k}`),
    ...Object.keys(notes).map((k) => `siteAddress.consequence.${k}`),
    ...Object.keys(ipModes).map((k) => `siteAddress.ip.${k}`),
    // Chosen by lib/siteAddress ipLiteralsLabelKey / ownAddressesHeadingKey (pinned in siteAddress.test.ts).
    "siteAddress.ip.ownGateway",
    "siteAddress.accepted.own",
    "siteAddress.accepted.ownGateway",
    ...Object.keys(oldActions).map((k) => `siteAddress.old.${k}`),
    ...Object.keys(warnings).map((k) => `siteAddress.signIn.warn.${k}`),
    ...["serve", "redirect"].map((k) => `siteAddress.mode.${k}`),
    ...["admin", "cli", "install", "config"].map((k) => `siteAddress.source.${k}`),
    ...["gatewayUrl", "frontendUrl", "recent-use"].map((k) => `siteAddress.dependent.${k}`),
    ...Object.keys(refusals).map((k) => `hostNotice.signinRefused.${k}`),
    ...["address", "label", "mode", "signIn", "source", "expires", "lastSeen", "count", "hint", "actions"].map((k) => `siteAddress.col.${k}`),
];

describe("site-address strings", () => {
    const used = new Set([...literalKeys(), ...DYNAMIC]);

    for (const lang of Object.keys(translations) as Language[]) {
        it(`every key the screens ask for exists in "${lang}"`, () => {
            const missing = [...used].filter((k) => !(k in translations[lang]));
            expect(missing).toEqual([]);
        });
    }

    it("every site-address string is used", () => {
        const own = Object.keys(translations.en).filter((k) => OWN_PREFIXES.some((p) => k.startsWith(p)));
        expect(own.length).toBeGreaterThan(100);
        expect(own.filter((k) => !used.has(k))).toEqual([]);
    });

    it("the page renders what the helpers decide (review UX-1 / UX-2)", () => {
        // Who refused a host: the row renders the label from the entry's own `source`, unconditionally
        // (the component renders nothing for null). Whose addresses `own` means: the heading, the
        // <option> and the confirmation summary all ask the same helpers, with the state's own answer.
        const page = fs.readFileSync(path.join(SRC, "app/admin/settings/site-address/page.tsx"), "utf8");
        expect(page).toMatch(/^[ \t]*<RefusedByLabel source=\{entry\.source\} t=\{t\} \/>\r?$/m);
        expect(page).toMatch(/\{t\(ownAddressesHeadingKey\(state\.ownAddressesFrom\)\)\}/);
        expect(page).toMatch(/<option key=\{mode\} value=\{mode\}>\{t\(ipLiteralsLabelKey\(mode, state\.ownAddressesFrom\)\)\}<\/option>/);
        expect(page).toMatch(/\$\{t\(ipLiteralsLabelKey\(body\.ipLiterals, state\.ownAddressesFrom\)\)\}/);
        expect(page).not.toMatch(/siteAddress\.(ip|refusedBy)\.\$\{/);
        expect(page).not.toMatch(/siteAddress\.accepted\.own(Gateway)?["']/);
    });

    it("keeps the placeholders the code fills in every language", () => {
        const placeholders: Record<string, string[]> = {
            "siteAddress.connectedVia": ["{host}", "{cls}"],
            "siteAddress.conflict.body": ["{config}", "{db}"],
            "siteAddress.drift.body": ["{gateway}", "{config}"],
            "siteAddress.useAddress": ["{address}"],
            "siteAddress.remove.confirm": ["{host}"],
            "siteAddress.remove.current": ["{host}"],
            "siteAddress.change.old": ["{old}"],
            "siteAddress.savedWithWarning": ["{warning}"],
            "siteAddress.failed": ["{message}"],
            "siteBanner.linkBase": ["{host}", "{linkBase}"],
            "siteBanner.conflict": ["{config}", "{db}"],
            "siteBanner.drift": ["{gateway}", "{config}"],
        };
        for (const lang of Object.keys(translations) as Language[]) {
            for (const [key, names] of Object.entries(placeholders)) {
                for (const name of names) expect(translations[lang][key], `${lang} ${key}`).toContain(name);
            }
        }
    });
});
