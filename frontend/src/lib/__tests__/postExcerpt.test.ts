import { describe, expect, it } from "vitest";
import { postCardExcerpt, stripTags, PROTECTED_EXCERPT } from "../postExcerpt";

describe("postCardExcerpt — the public card teaser (home, archive, search)", () => {
    it("shows the protected notice when the API withheld a protected entry's content", () => {
        expect(postCardExcerpt({ protected: true, content: "", excerpt: "" })).toBe(PROTECTED_EXCERPT);
        // The excerpt is withheld together with the content, so a leftover excerpt must not leak through.
        expect(postCardExcerpt({ protected: true, content: null, excerpt: "secret summary" })).toBe(PROTECTED_EXCERPT);
    });

    it("uses the content for a protected entry the reader may see (an editor, or after the password)", () => {
        expect(postCardExcerpt({ protected: true, content: "<p>Unlocked</p>" })).toBe("Unlocked...");
    });

    it("prefers the stored excerpt, else the first 200 characters of content as text", () => {
        expect(postCardExcerpt({ excerpt: "Hand-written", content: "<p>Body</p>" })).toBe("Hand-written");
        const long = `<p>${"a".repeat(300)}</p>`;
        expect(postCardExcerpt({ content: long })).toBe(`${"a".repeat(197)}...`);
    });

    it("never leaves markup behind, including tags spliced together by a single pass", () => {
        for (const html of ["<scr<script>ipt>alert(1)</script>", "<<script>script>x", "<img src=x onerror=alert(1)", "a<b<c>d>e"]) {
            expect(stripTags(html)).not.toMatch(/</);
            expect(postCardExcerpt({ content: html })).not.toMatch(/<\s*\w/);
        }
    });
});
