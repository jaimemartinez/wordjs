/**
 * VERSO F2 harness — behavior tests for the wrapper's autosave contract (PuckEditor.tsx), extracted
 * to ../autosavePolicy.ts so this survives the Puck→motor-nuevo rewrite. See
 * documentation/verso/f0-audit-core.md, wrapper-integration "Contratos duros":
 *   "piso de 8000ms tras el primer cambio, piso de 30000ms entre ejecuciones, guard
 *    status!=='draft'||!onSave||!hasChanges||saving, marca {autosave:true}, aborta si ok===false"
 *
 * PuckEditor.tsx imports these exact functions (see its autosave useEffect) — this is the same unit
 * production runs, not a parallel reimplementation of the rule.
 */
import { describe, it, expect } from "vitest";
import {
    AUTOSAVE_DEBOUNCE_FLOOR_MS,
    AUTOSAVE_REPEAT_FLOOR_MS,
    shouldRunAutosave,
    computeAutosaveWaitMs,
    buildAutosaveSaveOptions,
    didSaveSucceed,
} from "../autosavePolicy";

describe("autosave floors — exact contract numbers", () => {
    it("debounce floor is 8000ms and repeat floor is 30000ms", () => {
        expect(AUTOSAVE_DEBOUNCE_FLOOR_MS).toBe(8000);
        expect(AUTOSAVE_REPEAT_FLOOR_MS).toBe(30000);
    });
});

describe("shouldRunAutosave — guard status!=='draft'||!onSave||!hasChanges||saving", () => {
    const armed = { status: "draft", hasOnSave: true, hasChanges: true, saving: false };

    it("arms when status=draft, onSave present, hasChanges=true, not saving", () => {
        expect(shouldRunAutosave(armed)).toBe(true);
    });

    it("never arms for a published record — the exact 'must never go live in the background' rule", () => {
        expect(shouldRunAutosave({ ...armed, status: "published" })).toBe(false);
    });

    it("does not arm for ANY non-draft status (private, trash, pending — not just 'published')", () => {
        for (const status of ["published", "private", "trash", "pending", ""]) {
            expect(shouldRunAutosave({ ...armed, status })).toBe(false);
        }
    });

    it("never arms without an onSave handler", () => {
        expect(shouldRunAutosave({ ...armed, hasOnSave: false })).toBe(false);
    });

    it("never arms when there are no changes to save", () => {
        expect(shouldRunAutosave({ ...armed, hasChanges: false })).toBe(false);
    });

    it("never arms while a save is already in flight (no overlapping autosaves)", () => {
        expect(shouldRunAutosave({ ...armed, saving: true })).toBe(false);
    });

    it("full 2^4 matrix — arms iff ALL FOUR conditions hold simultaneously", () => {
        const statuses = ["draft", "published"];
        const bools = [true, false];
        let armedCount = 0;
        for (const status of statuses) {
            for (const hasOnSave of bools) {
                for (const hasChanges of bools) {
                    for (const saving of bools) {
                        const expected = status === "draft" && hasOnSave && hasChanges && !saving;
                        const actual = shouldRunAutosave({ status, hasOnSave, hasChanges, saving });
                        expect(actual).toBe(expected);
                        if (actual) armedCount++;
                    }
                }
            }
        }
        // Exactly one combination out of 16 satisfies all four conditions at once.
        expect(armedCount).toBe(1);
    });
});

describe("computeAutosaveWaitMs — 8s debounce floor, 30s floor between runs", () => {
    it("waits exactly 8000ms the first time ever (lastAutosaveAt=0, real epoch `now`)", () => {
        // lastAutosaveRef starts at 0 (useRef(0)); `now` is a real Date.now()-scale epoch, so
        // 30000 - now is deeply negative and the 8s debounce floor wins.
        const now = 1_755_000_000_000;
        expect(computeAutosaveWaitMs(now, 0)).toBe(AUTOSAVE_DEBOUNCE_FLOOR_MS);
    });

    it("enforces the 30s floor when the previous autosave just happened (now == lastAutosaveAt)", () => {
        const t = 1_755_000_000_000;
        expect(computeAutosaveWaitMs(t, t)).toBe(AUTOSAVE_REPEAT_FLOOR_MS);
    });

    it("still enforces the 8s debounce floor even when the 30s-since-last-run math would allow less", () => {
        // 25s have passed since the last autosave -> naive `30000 - 25000` = 5000, but the 8s floor wins.
        const lastAutosaveAt = 1_755_000_000_000;
        const now = lastAutosaveAt + 25_000;
        expect(computeAutosaveWaitMs(now, lastAutosaveAt)).toBe(AUTOSAVE_DEBOUNCE_FLOOR_MS);
    });

    it("waits exactly the remaining time when it's between the two floors (29s since a change made it dirty again is not modeled here — this is time-since-LAST-RUN, so pick a gap where 30000-elapsed sits above 8000)", () => {
        const lastAutosaveAt = 1_755_000_000_000;
        const now = lastAutosaveAt + 1_000; // only 1s since last run -> 30000-1000=29000, above the 8s floor
        expect(computeAutosaveWaitMs(now, lastAutosaveAt)).toBe(29_000);
    });

    it("still floors at 8000ms long after the repeat window has fully elapsed", () => {
        const lastAutosaveAt = 1_755_000_000_000;
        const now = lastAutosaveAt + 120_000; // 2 minutes idle
        expect(computeAutosaveWaitMs(now, lastAutosaveAt)).toBe(AUTOSAVE_DEBOUNCE_FLOOR_MS);
    });
});

describe("buildAutosaveSaveOptions — marks the save {autosave:true} literal", () => {
    it("returns exactly {autosave: true} — the flag routes/posts.ts reads to skip the revision snapshot", () => {
        expect(buildAutosaveSaveOptions()).toEqual({ autosave: true });
    });

    it("has no OTHER keys — the backend gate is `body.autosave === true`, not truthy-object", () => {
        expect(Object.keys(buildAutosaveSaveOptions())).toEqual(["autosave"]);
    });

    it("returns a fresh object each call (no shared mutable reference leaking across autosave runs)", () => {
        const a = buildAutosaveSaveOptions();
        const b = buildAutosaveSaveOptions();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});

describe("didSaveSucceed — aborts (does not stamp saved) if onSave resolves to exactly false", () => {
    it("false means blocked/failed — must not be treated as success", () => {
        expect(didSaveSucceed(false)).toBe(false);
    });

    it("true means success", () => {
        expect(didSaveSucceed(true)).toBe(true);
    });

    it("undefined/void means success (the onSave contract: only `false` is a failure signal)", () => {
        expect(didSaveSucceed(undefined)).toBe(true);
    });

    it("does not treat other falsy-ish values as the false sentinel (only strict `false` aborts)", () => {
        // Defensive: the contract is `result !== false`, not `!result` — 0/''/null must NOT abort a save
        // if some future onSave implementation returns them by mistake instead of void.
        expect(didSaveSucceed(0)).toBe(true);
        expect(didSaveSucceed("")).toBe(true);
        expect(didSaveSucceed(null)).toBe(true);
    });
});
