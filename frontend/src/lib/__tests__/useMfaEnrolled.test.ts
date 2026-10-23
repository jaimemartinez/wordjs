import { describe, it, expect } from "vitest";
import { needsStepUpCode } from "../useMfaEnrolled";

describe("the step-up code is asked only when the server says so", () => {
    it("recognises the server's 'a code is needed' answer, and nothing else", () => {
        expect(needsStepUpCode({ code: "rest_mfa_step_up_required" })).toBe(true);
        for (const other of [{ code: "rest_bad_current_password" }, { code: "network_mfa_enrollment_required" }, new Error("x"), null, undefined, "rest_mfa_step_up_required"]) {
            expect(needsStepUpCode(other)).toBe(false);
        }
    });
});
