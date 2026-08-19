/**
 * THE SUDO PROOF A SELF-EDIT MUST CARRY — the rule, and the screens that must consume it.
 *
 * Two user journeys were BROKEN by the backend fix that gated recovery-bearing fields behind
 * "re-enter your current password": the account page could no longer set a recovery email at all (it
 * sent the field with no password and got a 403), and editing your OWN record from the user editor
 * failed the same way behind a generic "could not save the user". One screen — MfaSetup — had been
 * given its password field; its twins had not.
 *
 * THE CLASS: whenever a field becomes sudo-gated on the backend, EVERY screen that submits it needs the
 * same three things (know which fields are gated, ask for the password only when one really changed, and
 * read the refusal back as a password problem). A rule that lives in N screens covers N-1 of them, so
 * the rule lives once in lib/api and the screens consume it.
 *
 * These tests therefore do two different jobs:
 *   1. drive the RULE over a table of every gated field × every shape a form can submit it in; and
 *   2. discover, from the source tree, every screen that submits a user update and assert it routes
 *      through the rule — so a NEW screen added later is covered by the same gate, not forgotten.
 *
 * (2) is a source-level gate rather than a rendered click-through only because this workspace has no
 * DOM environment for vitest — see the handoff note about adding jsdom and driving the real submit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    SUDO_GATED_SELF_FIELDS,
    selfEditNeedsCurrentPassword,
    withSudoProof,
    isBadCurrentPassword,
} from "@/lib/api";

// ─── 1 · the rule, over the whole class of submissions ────────────────────────────────────────────

/**
 * The stored record every case below is compared against. Deliberately has BOTH addresses populated so
 * that "clear it" is expressible — clearing a recovery address moves where a reset link would go and is
 * every bit as much a change as setting one.
 */
const STORED = { email: "owner@example.com", personalEmail: "owner@personal.test" };

type Case = { why: string; submitted: Record<string, unknown>; needsPassword: boolean };

/**
 * One row per (gated field × shape). The expectation is stated from the RULE — "a save needs the
 * password when it would really move a credential or a recovery address" — not read off the
 * implementation, so a change of behaviour has to argue with the sentence, not just with a number.
 */
const CASES: Case[] = [
    // ── nothing gated ────────────────────────────────────────────────────────────────────────────
    { why: "renaming yourself touches nothing gated", submitted: { displayName: "New Name" }, needsPassword: false },
    { why: "an empty submission", submitted: {}, needsPassword: false },

    // ── the no-op resend every profile form performs on every save ───────────────────────────────
    { why: "both addresses resent unchanged", submitted: { ...STORED }, needsPassword: false },
    { why: "resent with different case", submitted: { email: "OWNER@Example.com", personalEmail: "OWNER@Personal.TEST" }, needsPassword: false },
    { why: "resent with surrounding whitespace", submitted: { email: "  owner@example.com ", personalEmail: "\towner@personal.test\n" }, needsPassword: false },

    // ── the primary email ────────────────────────────────────────────────────────────────────────
    { why: "a different primary email", submitted: { email: "new@example.com" }, needsPassword: true },
    { why: "a blank primary email means 'left alone', never 'cleared'", submitted: { email: "" }, needsPassword: false },
    { why: "a whitespace-only primary email is equally 'left alone'", submitted: { email: "   " }, needsPassword: false },
    { why: "an absent primary email", submitted: { email: undefined }, needsPassword: false },

    // ── the recovery email ───────────────────────────────────────────────────────────────────────
    { why: "a different recovery email", submitted: { personalEmail: "new@personal.test" }, needsPassword: true },
    { why: "CLEARING the recovery email is a change: it moves where a reset link goes", submitted: { personalEmail: "" }, needsPassword: true },
    { why: "clearing it with whitespace is the same clearing", submitted: { personalEmail: "  " }, needsPassword: true },
    { why: "an absent recovery email", submitted: { personalEmail: undefined }, needsPassword: false },

    // ── the password ─────────────────────────────────────────────────────────────────────────────
    { why: "a new password", submitted: { password: "Something-New-1!" }, needsPassword: true },
    { why: "the blank password box every user form carries", submitted: { password: "" }, needsPassword: false },
    { why: "an absent password", submitted: { password: undefined }, needsPassword: false },

    // ── combinations ─────────────────────────────────────────────────────────────────────────────
    { why: "a cosmetic change alongside an unchanged address", submitted: { displayName: "X", ...STORED }, needsPassword: false },
    { why: "a cosmetic change alongside a real address change", submitted: { displayName: "X", personalEmail: "moved@personal.test" }, needsPassword: true },
    { why: "a password change alongside unchanged addresses", submitted: { ...STORED, password: "Another-1!" }, needsPassword: true },
];

describe("selfEditNeedsCurrentPassword", () => {
    it.each(CASES)("$why", ({ submitted, needsPassword }) => {
        expect(selfEditNeedsCurrentPassword(STORED, submitted)).toBe(needsPassword);
    });

    it("covers every field the rule claims to govern", () => {
        // If a NEW gated field is added to SUDO_GATED_SELF_FIELDS, this fails until the table above
        // grows a row for it — which is the whole point of stating the field list as data.
        for (const field of SUDO_GATED_SELF_FIELDS) {
            const mentioned = CASES.some((c) => Object.prototype.hasOwnProperty.call(c.submitted, field));
            expect(mentioned, `no case exercises the gated field "${field}"`).toBe(true);
        }
    });

    it("an empty stored record still sees the FIRST recovery address as a change", () => {
        // The journey that was broken: most accounts have no personal_email, so writing one is already a
        // change, and a screen that omits the password can never set it even once.
        expect(selfEditNeedsCurrentPassword({}, { personalEmail: "first@personal.test" })).toBe(true);
        expect(selfEditNeedsCurrentPassword({ personalEmail: "" }, { personalEmail: "first@personal.test" })).toBe(true);
        expect(selfEditNeedsCurrentPassword({ personalEmail: null }, { personalEmail: "" })).toBe(false);
    });
});

describe("withSudoProof — what actually goes on the wire", () => {
    it.each(CASES)("$why", ({ submitted, needsPassword }) => {
        const body = withSudoProof(STORED, submitted, "hunter2") as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(body, "currentPassword")).toBe(needsPassword);
        if (needsPassword) expect(body.currentPassword).toBe("hunter2");
        // The submitted fields must survive untouched either way.
        for (const [k, v] of Object.entries(submitted)) expect(body[k]).toBe(v);
    });

    it("sends an EMPTY proof rather than dropping it, so the backend answers about the password", () => {
        const body = withSudoProof(STORED, { personalEmail: "moved@personal.test" }, "") as Record<string, unknown>;
        expect(body.currentPassword).toBe("");
    });
});

describe("isBadCurrentPassword", () => {
    it("recognises the backend refusal and nothing else", () => {
        expect(isBadCurrentPassword({ code: "rest_bad_current_password" })).toBe(true);
        expect(isBadCurrentPassword(Object.assign(new Error("nope"), { code: "rest_bad_current_password" }))).toBe(true);
        for (const other of [null, undefined, {}, "rest_bad_current_password", { code: "rest_forbidden" },
            { code: "rest_invalid_personal_email" }, { code: "rest_account_locked" }, new Error("x")]) {
            expect(isBadCurrentPassword(other)).toBe(false);
        }
    });
});

// ─── 2 · every screen that submits a user update must consume the rule ────────────────────────────

const SRC = path.resolve(import.meta.dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "__tests__" || entry.name === "node_modules") continue;
            walk(full, out);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Screens known to still submit a self-edit WITHOUT the proof. This list must only ever shrink; every
 * entry is a live bug, not an exemption. Adding a screen here instead of wiring it re-creates exactly
 * the "the hardened surface got its UI and the twin did not" pattern this file exists to stop.
 *
 *   • UserFormModal.tsx — the users-list modal is the third editor of the same record and posts the whole
 *     form with no password, so an administrator editing their OWN row from the list is still refused.
 *     Handed off: it is outside the files this change owns.
 */
const KNOWN_UNWIRED = ["UserFormModal.tsx"];

describe("the screens that submit a user update", () => {
    const CALL = /usersApi\.(update|updateMe)\s*\(/g;

    it("route every self-edit through withSudoProof (or send the proof outright)", () => {
        const offenders: string[] = [];
        let sawACall = false;

        for (const file of walk(SRC)) {
            const source = fs.readFileSync(file, "utf-8");
            CALL.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = CALL.exec(source)) !== null) {
                sawACall = true;
                // The call's argument text: from the call through the end of the statement that holds it.
                const tail = source.slice(m.index, m.index + 400);
                const args = tail.slice(0, tail.indexOf(";") === -1 ? tail.length : tail.indexOf(";"));
                const wired = args.includes("withSudoProof(") || args.includes("currentPassword");
                if (!wired && !KNOWN_UNWIRED.includes(path.basename(file))) {
                    offenders.push(`${path.relative(SRC, file)} → ${args.split("\n")[0].trim()}`);
                }
            }
        }

        expect(sawACall, "the scan found no usersApi.update call at all — the regex has gone stale").toBe(true);
        expect(offenders, "a screen submits a self-edit without the sudo proof").toEqual([]);
    });

    it("the known-unwired list names files that still exist and still lack the proof", () => {
        // A stale entry would silently exempt a file that was since fixed (or deleted), which is how an
        // allow-list turns into a blindfold.
        for (const name of KNOWN_UNWIRED) {
            const match = walk(SRC).find((f) => path.basename(f) === name);
            expect(match, `${name} is on the known-unwired list but no longer exists — remove the entry`).toBeTruthy();
            const source = fs.readFileSync(match!, "utf-8");
            expect(source.includes("withSudoProof("),
                `${name} now uses withSudoProof — remove it from KNOWN_UNWIRED`).toBe(false);
        }
    });
});
