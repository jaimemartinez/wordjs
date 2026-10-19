import { describe, it, expect } from "vitest";
import { MB, fmtBytes, fromMbField, toMbField } from "../networkQuota";

/**
 * The network screen's media quota fields (admin/network): MB on screen, bytes on the wire
 * (PUT /network/sites/:id/quota, PUT /network/quotas/default). An empty field is "no limit" (null), and
 * anything that is not a number of megabytes is refused before a request is made.
 */
describe("network quota fields", () => {
    it("turns typed megabytes into the bytes the server stores", () => {
        expect(fromMbField("500")).toBe(500 * MB);
        expect(fromMbField(" 1.5 ")).toBe(Math.round(1.5 * MB));
        expect(fromMbField("0")).toBe(0);
    });
    it("an empty field means no limit", () => {
        expect(fromMbField("")).toBeNull();
        expect(fromMbField("   ")).toBeNull();
    });
    it("refuses what is not a number of megabytes", () => {
        for (const bad of ["-1", "abc", "1e3", "1.234", "1,5", "Infinity"]) expect(fromMbField(bad), bad).toBeUndefined();
    });
    it("shows stored bytes back as megabytes, and nothing for no quota", () => {
        expect(toMbField(500 * MB)).toBe("500");
        expect(toMbField(Math.round(1.5 * MB))).toBe("1.5");
        expect(toMbField(null)).toBe("");
        expect(toMbField(undefined)).toBe("");
        expect(fromMbField(toMbField(250 * MB))).toBe(250 * MB);
    });
    it("formats usage for people", () => {
        expect(fmtBytes(512)).toBe("512 B");
        expect(fmtBytes(2048)).toBe("2.0 KB");
        expect(fmtBytes(5 * MB)).toBe("5.0 MB");
        expect(fmtBytes(3 * 1024 * MB)).toBe("3.00 GB");
    });
});
