/**
 * The host QR helper ('lib/qr', exposed to plugin bundles). Pinned: it produces an <img>-ready data URL and
 * an <svg> for the same text, grows with the content, refuses empty / oversized input instead of drawing an
 * unreadable code, and encodes accented text as UTF-8 bytes WITHOUT swapping the library's global byte
 * converter (the MFA enrolment screen shares the module).
 */
import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { QR_MAX_LENGTH, qrDataUrl, qrModuleCount, qrSvg } from "../qr";

describe("lib/qr", () => {
    it("draws a data URL and a scalable SVG", () => {
        const url = qrDataUrl("https://example.org/portal/field-portal?code=123456");
        expect(url.startsWith("data:image/gif;base64,")).toBe(true);
        const svg = qrSvg("https://example.org/portal/field-portal?code=123456");
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).toContain("viewBox");
    });

    it("grows with the content and honours the error-correction level", () => {
        expect(qrModuleCount("a")).toBeLessThan(qrModuleCount("a".repeat(300)));
        expect(qrModuleCount("x".repeat(100), "L")).toBeLessThanOrEqual(qrModuleCount("x".repeat(100), "H"));
    });

    it("refuses empty and oversized text", () => {
        expect(() => qrDataUrl("")).toThrow(/empty/);
        expect(() => qrSvg("x".repeat(QR_MAX_LENGTH + 1))).toThrow(/too long/);
    });

    it("encodes UTF-8 without touching the shared converter", () => {
        const before = qrcode.stringToBytes;
        const accented = qrModuleCount("Señor, ¿oramos por ti? ñandú");
        expect(accented).toBeGreaterThan(0);
        expect(qrcode.stringToBytes).toBe(before);
        // Same byte length as its UTF-8 form → same size as the equivalent ASCII payload of that length.
        const bytes = new TextEncoder().encode("ñ").length;
        expect(bytes).toBe(2);
        expect(qrModuleCount("ñ".repeat(60))).toBe(qrModuleCount("n".repeat(120)));
    });

    it("clamps silly cell sizes and margins instead of failing", () => {
        expect(qrDataUrl("x", { cell: 0, margin: -5 }).startsWith("data:image/gif")).toBe(true);
        expect(qrSvg("x", { cell: 999, margin: 999 })).toContain("<svg");
    });
});
