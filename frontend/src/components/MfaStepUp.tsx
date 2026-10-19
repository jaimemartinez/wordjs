"use client";

import { useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { Input } from "@/components/ui";

/**
 * The second factor the backend may ask for in the MIDDLE of an action, and the one place the admin turns
 * those answers into fields (backend routes/auth.ts requireMfaForMachineCredential / verifyManagedMfaCode):
 *
 *   • 403 `rest_mfa_step_up_required` — the caller's role requires 2FA and this session did not sign in
 *     with it: minting a token or an agent connection (or granting one) needs a fresh code (`mfaCode`).
 *   • 403 `rest_mfa_password_required` — the account has collected too many invalid codes: the code alone
 *     is no longer enough, the account password goes with it (`currentPassword`).
 *
 * Neither is a failure the user caused, so `absorb` reports them as "ask for more" instead of an error,
 * and the next submit carries what was asked for (`payload`).
 */
/** What a refused request asked for: more input ("code" / "password"), or nothing (a real failure). */
export type StepUpAsk = "code" | "password" | null;
export function stepUpAsk(code: unknown): StepUpAsk {
    if (code === "rest_mfa_step_up_required") return "code";
    if (code === "rest_mfa_password_required") return "password";
    return null;
}

/** The step-up fields to merge into a request body — only what the server asked for, never empty strings. */
export function stepUpPayload(s: { needsCode: boolean; needsPassword: boolean; code: string; password: string }): { mfaCode?: string; currentPassword?: string } {
    return {
        ...(s.needsCode && s.code.trim() ? { mfaCode: s.code.trim() } : {}),
        ...(s.needsPassword && s.password ? { currentPassword: s.password } : {}),
    };
}

export function useMfaStepUp() {
    const [needsCode, setNeedsCode] = useState(false);
    const [needsPassword, setNeedsPassword] = useState(false);
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");

    /** True when the error only asked for more input; it clears a field the server just rejected. */
    const absorb = (e: any): boolean => {
        const ask = stepUpAsk(e?.code);
        if (ask === "code") { setNeedsCode(true); return true; }
        if (ask === "password") { setNeedsPassword(true); return true; }
        if (e?.code === "rest_mfa_invalid") setCode("");
        if (e?.code === "rest_bad_current_password") setPassword("");
        return false;
    };

    const payload = () => stepUpPayload({ needsCode, needsPassword, code, password });

    const reset = () => { setNeedsCode(false); setNeedsPassword(false); setCode(""); setPassword(""); };

    return { needsCode, needsPassword, code, setCode, password, setPassword, absorb, payload, reset };
}

export type MfaStepUp = ReturnType<typeof useMfaStepUp>;

/** The fields for whatever `useMfaStepUp` was asked for; nothing at all until it was asked. */
export function MfaStepUpFields({ stepUp, codeHelp, withCode = true }: { stepUp: MfaStepUp; codeHelp?: string; withCode?: boolean }) {
    const { t } = useI18n();
    const showCode = withCode && stepUp.needsCode;
    if (!showCode && !stepUp.needsPassword) return null;
    return (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3 space-y-2" data-testid="mfa-step-up">
            {showCode && (
                <>
                    {codeHelp && (
                        <p className="text-[11px] text-amber-800 leading-relaxed flex items-start gap-2">
                            <i className="fa-solid fa-shield-halved mt-0.5"></i>
                            <span>{codeHelp}</span>
                        </p>
                    )}
                    <Input
                        label={t("tokens.stepUpLabel")}
                        icon="fa-mobile-screen"
                        value={stepUp.code}
                        onChange={(e) => stepUp.setCode(e.target.value)}
                        placeholder={t("tokens.stepUpPlaceholder")}
                        autoComplete="one-time-code"
                        inputMode="text"
                        required
                    />
                </>
            )}
            {stepUp.needsPassword && (
                <>
                    <p className="text-[11px] text-amber-800 leading-relaxed flex items-start gap-2">
                        <i className="fa-solid fa-key mt-0.5"></i>
                        <span>{t("stepUp.passwordHelp")}</span>
                    </p>
                    <Input
                        label={t("stepUp.passwordLabel")}
                        icon="fa-lock"
                        type="password"
                        value={stepUp.password}
                        onChange={(e) => stepUp.setPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                    />
                </>
            )}
        </div>
    );
}
