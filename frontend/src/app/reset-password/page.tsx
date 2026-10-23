"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { apiErrorText } from "@/lib/apiErrorText";
import { Button, IconButton, Input } from "@/components/ui";

// Public, unauthenticated. Two modes on one page:
//   • No token in the URL  → "request a reset link" form (enter username/email → POST forgot-password).
//   • uid + token present  → "set a new password" form (the link delivered by email → POST reset-password).
// Its copy is in the visitor's language: the provider comes from the sign-in shell (layout.tsx).
function ResetPasswordInner() {
    const router = useRouter();
    const params = useSearchParams();
    const { t } = useI18n();
    const uid = params.get("uid");
    const token = params.get("token");
    const hasToken = !!uid && !!token;

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);

    // Request mode
    const [login, setLogin] = useState("");
    // null = probing; false = no mail provider can deliver → self-service reset cannot work, so tell the
    // user to contact an administrator instead of silently accepting a request that goes nowhere.
    const [resetAvailable, setResetAvailable] = useState<boolean | null>(null);
    // Set-new-password mode
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [showPassword, setShowPassword] = useState(false);

    // Only probe in request mode (a valid uid+token link should always render the set-password form).
    useEffect(() => {
        if (hasToken) return;
        let active = true;
        authApi.passwordResetAvailable()
            .then((r) => { if (active) setResetAvailable(!!r?.available); })
            .catch(() => { if (active) setResetAvailable(true); /* probe failed — don't block the form */ });
        return () => { active = false; };
    }, [hasToken]);

    const handleRequest = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            await authApi.forgotPassword(login);
            // Always report success (the server never reveals whether the account exists).
            setDone(true);
        } catch {
            // Even on a transport error, avoid leaking state — show the same neutral confirmation.
            setDone(true);
        } finally {
            setLoading(false);
        }
    };

    const handleReset = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        if (password.length < 8) { setError(t("apiError.msg.passwordTooShort")); return; }
        if (password !== confirm) { setError(t("reset.mismatch")); return; }
        setLoading(true);
        try {
            await authApi.resetPassword({ uid: Number(uid), token: token as string, password });
            setDone(true);
        } catch (err: unknown) {
            setError(apiErrorText(t, err, "apiError.rest_invalid_reset"));
        } finally {
            setLoading(false);
        }
    };

    // `backLink`: off on the final screen, whose own button already leads to sign-in — two links to the
    // same place, one of them a button, read as two different next steps.
    const shell = (children: React.ReactNode, backLink = true) => (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-800 flex items-center justify-center gap-3">
                        <i className="fa-solid fa-rocket text-blue-600"></i>
                        WordJS
                    </h1>
                    <p className="text-gray-500 mt-2">{t("reset.subtitle")}</p>
                </div>
                {children}
                {backLink && (
                    <div className="mt-6 text-center">
                        <a href="/login" className="text-sm text-gray-500 hover:text-blue-600">
                            &larr; {t("auth.backToLogin")}
                        </a>
                    </div>
                )}
            </div>
        </div>
    );

    // ---- Success states -------------------------------------------------------------------------
    if (done && hasToken) {
        return shell(
            <div className="text-center space-y-4">
                <i className="fa-solid fa-circle-check text-green-500 text-4xl"></i>
                <p className="text-gray-700">{t("reset.doneTitle")}</p>
                <Button size="md" className="w-full" onClick={() => router.push("/login")}>
                    {t("auth.goToLogin")}
                </Button>
            </div>,
            false,
        );
    }
    if (done) {
        return shell(
            <div className="text-center space-y-4">
                <i className="fa-solid fa-envelope-circle-check text-blue-500 text-4xl"></i>
                <p className="text-gray-700">{t("reset.sentBody")}</p>
                <p className="text-sm text-gray-500">{t("reset.sentExpiry")}</p>
            </div>
        );
    }

    // ---- Set-new-password mode ------------------------------------------------------------------
    if (hasToken) {
        return shell(
            <form onSubmit={handleReset} className="space-y-6">
                <p className="text-sm text-gray-500 text-center">{t("reset.chooseNew")}</p>
                <Input
                    id="reset-password"
                    size="md"
                    type={showPassword ? "text" : "password"}
                    label={t("reset.newPassword")}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("reset.newPasswordPlaceholder")}
                    required
                    minLength={8}
                    // One eye shows / hides both passwords, so the two can be compared.
                    trailing={
                        <IconButton
                            size="sm"
                            icon={showPassword ? "fa-eye-slash" : "fa-eye"}
                            label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                            aria-pressed={showPassword}
                            onClick={() => setShowPassword(!showPassword)}
                        />
                    }
                />
                <Input
                    id="reset-confirm"
                    size="md"
                    type={showPassword ? "text" : "password"}
                    label={t("reset.confirmNew")}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder={t("reset.confirmPlaceholder")}
                    required
                    minLength={8}
                />
                {error && <div role="alert" className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}
                <Button type="submit" size="md" className="w-full" pending={loading} pendingLabel={t("reset.resetting")}>
                    {t("reset.submit")}
                </Button>
            </form>
        );
    }

    // ---- Recovery unavailable (no mail provider) ------------------------------------------------
    // The site cannot send email, so a reset link would never arrive. Say so honestly instead of
    // showing a form whose neutral "check your inbox" confirmation would be a lie.
    if (resetAvailable === false) {
        return shell(
            <div className="text-center space-y-4">
                <i className="fa-solid fa-envelope-open-text text-amber-500 text-4xl"></i>
                <p className="text-gray-700">{t("reset.unavailable")}</p>
                <p className="text-sm text-gray-500">{t("reset.unavailableHelp")}</p>
            </div>
        );
    }

    // ---- Request-a-link mode --------------------------------------------------------------------
    return shell(
        <form onSubmit={handleRequest} className="space-y-6">
            <p className="text-sm text-gray-500 text-center">{t("reset.requestIntro")}</p>
            <Input
                id="reset-login"
                size="md"
                label={t("reset.login")}
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder={t("reset.loginPlaceholder")}
                required
            />
            {error && <div role="alert" className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}
            <Button type="submit" size="md" className="w-full" pending={loading} pendingLabel={t("reset.sending")}>
                {t("reset.send")}
            </Button>
        </form>
    );
}

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800" />}>
            <ResetPasswordInner />
        </Suspense>
    );
}
