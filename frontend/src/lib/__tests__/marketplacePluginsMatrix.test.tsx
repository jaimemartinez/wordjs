import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/contexts/I18nContext";
import { translations } from "@/lib/i18n";
import { menuLabel } from "@/lib/menuLabel";
import { paletteGroupOf, paletteIconOf, FALLBACK_GROUP } from "@/lib/blockCatalog";
import { PluginBundleError, remotePluginFailureComponent } from "@/lib/pluginBundleLoader";
import { PermissionRow } from "@/app/admin/plugins/PermissionRow";
import { membersGateStrings } from "@/lib/public/uiStrings";
import MembersOnlyGate from "@/components/public/MembersOnlyGate";

/**
 * The marketplace-plugin pass, admin and editor side:
 *  · plugin sidebar entries follow the admin's language (per-language `labels`);
 *  · plugin blocks land in a real palette group with that group's icon, not all in "More";
 *  · a plugin screen whose bundle could not be fetched (5xx / no answer) says "temporarily unavailable",
 *    never "not installed";
 *  · the activation dialog lets the administrator switch a requested permission off before activating;
 *  · unconfigured plugin blocks show their setup hint in the editor only — visitors get nothing.
 */

const REPO = path.resolve(__dirname, "../../../..");
const PLUGINS = path.join(REPO, "marketplace/plugins");
const ES = translations.es;
const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

describe("menuLabel", () => {
    const t = (k: string) => `T(${k})`;
    it("core catalogue keys are translated", () => {
        expect(menuLabel({ label: "nav.tags" }, "en", t)).toBe("T(nav.tags)");
    });
    it("a plugin entry uses its label for the admin's language, then the base language, then label", () => {
        const item = { label: "Reservas", labels: { en: "Bookings", pt: "Reservas PT" } };
        expect(menuLabel(item, "en", t)).toBe("Bookings");
        expect(menuLabel(item, "pt-BR", t)).toBe("Reservas PT");
        expect(menuLabel(item, "fr", t)).toBe("Reservas");
        expect(menuLabel({ label: "Reservas", labels: { en: "  " } }, "en", t)).toBe("Reservas");
        expect(menuLabel({ label: "Reservas", labels: ["en"] }, "en", t)).toBe("Reservas");
    });
    it("core entries use catalogue keys, and the two «Forms» differ", () => {
        const src = fs.readFileSync(path.join(REPO, "frontend/src/lib/adminAccess.ts"), "utf8");
        for (const key of ["nav.tags", "nav.tools", "nav.audit"]) {
            expect(src).toContain(`label: "${key}"`);
            for (const lang of ["es", "en", "pt"] as const) expect((translations as any)[lang][key]).toBeTruthy();
        }
        expect(translations.en["nav.forms"]).toBe("Form submissions");
    });
});

describe("palette groups for plugin blocks", () => {
    it("known plugin categories map to real groups with that group's icon", () => {
        expect(paletteGroupOf("X", "Formularios")).toBe("Marketing");
        expect(paletteGroupOf("X", "Video Gallery")).toBe("Medios");
        expect(paletteGroupOf("X", "Membresías")).toBe("Dinámicos");
        expect(paletteGroupOf("X", "something unknown")).toBe(FALLBACK_GROUP);
        expect(paletteIconOf("X", "Video Gallery")).not.toBe("widgets");
    });
    it("every marketplace Verso block lands outside «Más»", () => {
        const stray: string[] = [];
        for (const slug of fs.readdirSync(PLUGINS)) {
            const dir = path.join(PLUGINS, slug, "client/verso");
            if (!fs.existsSync(dir)) continue;
            for (const f of fs.readdirSync(dir).filter((n) => /\.tsx$/.test(n))) {
                const src = fs.readFileSync(path.join(dir, f), "utf8");
                for (const m of src.matchAll(/\bcategory:\s*"([^"]+)"/g)) {
                    if (paletteGroupOf("__plugin__", m[1]) === FALLBACK_GROUP) stray.push(`${slug}: ${m[1]}`);
                }
            }
        }
        expect(stray).toEqual([]);
    });
});

describe("a plugin screen that could not be fetched", () => {
    const Fallback = () => <p>not installed</p>;
    it("5xx / no answer on the admin bundle → temporarily unavailable, with a retry", () => {
        const err = new PluginBundleError({ slug: "bookings", bundleType: "admin", reason: "failed", status: 503, message: "x" });
        const C = remotePluginFailureComponent(err, Fallback);
        const html = render(<C />);
        expect(html).toContain('data-wjs-plugin-unavailable="bookings"');
        expect(html).toContain(ES["plugins.unavailable.title"]);
        expect(html).not.toContain("not installed");
    });
    it("a real 404 still falls back", () => {
        const err = new PluginBundleError({ slug: "bookings", bundleType: "admin", reason: "missing" as any, status: 404, message: "x" });
        expect(remotePluginFailureComponent(err, Fallback)).toBe(Fallback);
    });
});

describe("activation dialog: decline a requested permission", () => {
    it("a row activation would grant has a switch; a declined row says it will not be granted", () => {
        const on = render(<PermissionRow token="database:write" rolesHeld="granted" activation="grants" onToggleDeclined={() => {}} />);
        expect(on).toContain('role="switch"');
        expect(on).toContain('aria-checked="true"');
        const off = render(<PermissionRow token="database:write" rolesHeld="granted" activation="grants" declined onToggleDeclined={() => {}} />);
        expect(off).toContain('aria-checked="false"');
        expect(off).toContain(ES["plugins.activation.declined"]);
    });
    it("no switch where the caller does not offer one (kept / stays-off rows)", () => {
        const html = render(<PermissionRow token="database:write" rolesHeld="granted" activation="kept" />);
        expect(html).not.toContain('role="switch"');
    });
});

describe("unconfigured plugin blocks: editor hint only", () => {
    // Each block's setup hint must be gated on the editor flag (isEditing / puck.isEditing).
    const BLOCKS = [
        "card-gallery/client/verso/CardGalleryVerso.tsx",
        "contact-forms/client/verso/ContactFormsVerso.tsx",
        "digital-downloads/client/verso/DigitalDownloadsVerso.tsx",
        "event-tickets/client/verso/EventTicketsVerso.tsx",
        "photo-carousel/client/verso/PhotoCarouselVerso.tsx",
        "polls/client/verso/PollsVerso.tsx",
        "social-share/client/verso/SocialShareVerso.tsx",
        "video-gallery/client/verso/VideoGalleryVerso.tsx",
        "youtube-videos/client/verso/YoutubeVideosVerso.tsx",
    ];
    for (const rel of BLOCKS) {
        it(rel.split("/")[0], () => {
            const src = fs.readFileSync(path.join(PLUGINS, rel), "utf8");
            expect(src).toContain("const editing = !!(isEditing || (puck && puck.isEditing));");
            expect(src).toMatch(/!editing[^\n]*\) return null;|if \(!editing\) return null;/);
        });
    }

    it("rendered without the editor flag, an unconfigured form/poll/share block is empty", async () => {
        const ContactForms: any = (await import("../../../../marketplace/plugins/contact-forms/client/verso/ContactFormsVerso")).default;
        const Polls: any = (await import("../../../../marketplace/plugins/polls/client/verso/PollsVerso")).default;
        const Share: any = (await import("../../../../marketplace/plugins/social-share/client/verso/SocialShareVerso")).default;
        // Server render shows the initial state: the share block with no network picked is unconfigured
        // from the first render; the editor still gets its hint.
        const none = { facebook: false, x: false, whatsapp: false, linkedin: false, telegram: false, email: false, copyLink: false };
        expect(renderToStaticMarkup(<Share title="Compartir:" {...none} />)).toBe("");
        expect(renderToStaticMarkup(<Share title="Compartir:" {...none} isEditing />)).toContain("Selecciona al menos una red social");
        expect(renderToStaticMarkup(<Share title="Compartir:" />)).toContain('class="wjss-root"');
        // Form / poll start "loading": no admin text either way on the first render.
        expect(renderToStaticMarkup(<ContactForms formId="" title="" elementId="" />)).not.toContain("Admin → Formularios");
        expect(renderToStaticMarkup(<Polls pollId="" accentColor="" elementId="" />)).not.toContain("Admin → Encuestas");
    });
});

describe("the core members-only notice with registration closed", () => {
    const gate = (settings: Record<string, unknown>) => renderToStaticMarkup(
        <MembersOnlyGate postId={1} mode="html" strings={membersGateStrings(settings)} showNotice commentsWhenGranted={false}>{null}</MembersOnlyGate>,
    );
    it("offers no «Create an account» that ends on «Registration closed»", () => {
        expect(membersGateStrings({ users_can_register: 0 }).signupOpen).toBe(false);
        expect(membersGateStrings({ users_can_register: "0" }).signupOpen).toBe(false);
        expect(gate({ users_can_register: 0 })).not.toContain('href="/register');
        expect(gate({ users_can_register: 0 })).toContain('href="/login');
    });
    it("open registration, or settings that do not say, keep the link", () => {
        expect(gate({ users_can_register: 1 })).toContain('href="/register');
        expect(membersGateStrings({}).signupOpen).toBe(true);
    });
});

describe("mail-server: the mailbox toggle gives the address field back (M2-24)", () => {
    const load = async () => (await import("../../../../marketplace/plugins/mail-server/client/UserFormExtension")) as any;
    it("on fills <username>@<mail domain>; off restores what the administrator had", async () => {
        const { mailboxEmailStep } = await load();
        let memo = { generated: null, before: null };
        let r = mailboxEmailStep(memo, { granted: true, username: "Ana", domain: "example.org", currentEmail: "ana@personal.test" });
        expect(r.email).toBe("ana@example.org");
        memo = r.memo;
        r = mailboxEmailStep(memo, { granted: false, username: "Ana", domain: "example.org", currentEmail: "ana@example.org" });
        expect(r.email).toBe("ana@personal.test");
        // Then typing works on a clean field: nothing more is written.
        expect(mailboxEmailStep(r.memo, { granted: false, username: "Ana", domain: "example.org", currentEmail: "x" }).email).toBeUndefined();
    });
    it("a username change while on keeps the original value to restore", async () => {
        const { mailboxEmailStep } = await load();
        let r = mailboxEmailStep({ generated: null, before: null }, { granted: true, username: "an", domain: "d.test", currentEmail: "" });
        r = mailboxEmailStep(r.memo, { granted: true, username: "ana", domain: "d.test", currentEmail: "an@d.test" });
        expect(r.email).toBe("ana@d.test");
        r = mailboxEmailStep(r.memo, { granted: false, username: "ana", domain: "d.test", currentEmail: "ana@d.test" });
        expect(r.email).toBe("");
    });
    it("an existing account's mailbox address goes with the mailbox: off leaves no email", async () => {
        const { mailboxEmailStep } = await load();
        // Loaded with the grant on and the mailbox address already stored: nothing to write yet.
        let r = mailboxEmailStep({ generated: null, before: null }, { granted: true, username: "ana", domain: "d.test", currentEmail: "ana@d.test" });
        expect(r.email).toBeUndefined();
        r = mailboxEmailStep(r.memo, { granted: false, username: "ana", domain: "d.test", currentEmail: "ana@d.test" });
        expect(r.email).toBe("");
    });
    it("an account loaded with the grant off keeps the address it has", async () => {
        const { mailboxEmailStep } = await load();
        const r = mailboxEmailStep({ generated: null, before: null }, { granted: false, username: "ana", domain: "d.test", currentEmail: "ana@d.test" });
        expect(r.email).toBeUndefined();
    });
    it("an address the administrator edited after switching on is left alone", async () => {
        const { mailboxEmailStep } = await load();
        const on = mailboxEmailStep({ generated: null, before: null }, { granted: true, username: "ana", domain: "d.test", currentEmail: "old@x.test" });
        expect(mailboxEmailStep(on.memo, { granted: false, username: "ana", domain: "d.test", currentEmail: "other@x.test" }).email).toBeUndefined();
    });
});

describe("mail-server: the message body does not creep down after opening (FALLOS 126)", () => {
    const src = fs.readFileSync(path.join(PLUGINS, "mail-server/client/admin/ui.tsx"), "utf8");
    it("measures the message's own wrapper, not the frame's document", () => {
        expect(src).toContain('<div id="wjs-mail-body">');
        expect(src).toContain("#wjs-mail-body{display:flow-root}");
        expect(src).toMatch(/getElementById\('wjs-mail-body'\)/);
        // The document is at least as tall as the frame: measuring it (+ a margin) grew the frame every tick.
        expect(src).not.toMatch(/documentElement\.scrollHeight/);
        expect(src).not.toMatch(/body\.scrollHeight/);
    });
    it("compares with the current height through a ref, not a stale closure", () => {
        expect(src).toMatch(/heightRef\.current = next;/);
    });
});
