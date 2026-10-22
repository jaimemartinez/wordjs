/**
 * Follow-up of the three-mode QA pass: the pure pieces behind bulk user actions, the account
 * self-service, the reading/permalink settings, menus and image editing.
 */
import { describe, it, expect } from "vitest";
import { runEach } from "@/lib/bulkRun";

describe("bulk actions run one write per row and report what failed", () => {
    it("keeps going past a failure and names the first reason", async () => {
        const seen: number[] = [];
        const result = await runEach([1, 2, 3], async (id) => {
            seen.push(id);
            if (id === 2) throw new Error("You cannot delete yourself.");
        });
        expect(seen).toEqual([1, 2, 3]);
        expect(result.done).toEqual([1, 3]);
        expect(result.failed).toEqual([{ id: 2, reason: "You cannot delete yourself." }]);
    });

    it("an empty selection does nothing", async () => {
        expect(await runEach([], async () => { throw new Error("never"); })).toEqual({ done: [], failed: [] });
    });
});
