"use client";

import { useEffect, useState } from "react";
import { mfaApi } from "@/lib/api";

/**
 * Does the signed-in account have two-factor authentication? The screens that re-authenticate a
 * sensitive action (Admin → Updates, Admin → Servers) ask for a code only then: an account without 2FA
 * confirms with its password alone (backend routes/network.ts requireStepUp).
 *
 * `null` while it is not known. The setter lets a screen show the code field when the server answers
 * that one is needed after all (`rest_mfa_step_up_required`), instead of leaving the reader stuck.
 */
export function useMfaEnrolled(): [boolean | null, (enrolled: boolean) => void] {
    const [enrolled, setEnrolled] = useState<boolean | null>(null);
    useEffect(() => {
        let alive = true;
        mfaApi.status().then((s) => { if (alive) setEnrolled(!!s.enabled); }).catch(() => { /* unknown: the server decides */ });
        return () => { alive = false; };
    }, []);
    return [enrolled, setEnrolled];
}

/** Did the server refuse because a two-factor code is needed? */
export function needsStepUpCode(err: unknown): boolean {
    return !!err && typeof err === "object" && (err as { code?: unknown }).code === "rest_mfa_step_up_required";
}
