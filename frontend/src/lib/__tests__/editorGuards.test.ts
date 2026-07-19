import { describe, it, expect } from "vitest";
import { unhydratedSaveBlocked } from "../editorGuards";

describe("unhydratedSaveBlocked — never overwrite an unhydrated existing record", () => {
    it("BLOCKS saving an existing record whose content has not loaded yet", () => {
        // The data-loss case: a failed/pending load leaves the editor empty; a save (manual or the
        // 8s autosave) would PUT empty content over the real post. Must be blocked.
        expect(unhydratedSaveBlocked({ isNew: false, loaded: false })).toBe(true);
    });

    it("ALLOWS saving an existing record once it has hydrated", () => {
        expect(unhydratedSaveBlocked({ isNew: false, loaded: true })).toBe(false);
    });

    it("ALLOWS saving a NEW record regardless of the loaded flag (nothing to hydrate)", () => {
        expect(unhydratedSaveBlocked({ isNew: true, loaded: false })).toBe(false);
        expect(unhydratedSaveBlocked({ isNew: true, loaded: true })).toBe(false);
    });
});
