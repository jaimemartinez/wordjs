"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { authApi, settingsApi } from "@/lib/api";
import { currentReturnPath } from "@/lib/safeReturnPath";
import { useI18n } from "@/contexts/I18nContext";
import { apiErrorText } from "@/lib/apiErrorText";
import { Button, Checkbox, IconButton, Input } from "@/components/ui";

function LoginForm() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    // «Remember me»: unticked, the session ends when the browser closes.
    const [remember, setRemember] = useState(true);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    // "Forgot password?" is only offered when self-service reset can actually deliver mail (probe below).
    const [resetAvailable, setResetAvailable] = useState(false);
    // Same rule for sign-up: only offer /register when the operator has actually turned
    // `users_can_register` on. It is a PUBLIC setting, so this reads without a session, and a failed
    // probe leaves the link hidden rather than advertising a form that would answer 403.
    const [registerAvailable, setRegisterAvailable] = useState(false);
    // Sign-up keeps the visitor's `?redirect=` (set after mount: the server render has no query).
    const [registerHref, setRegisterHref] = useState("/register");
    const { login, verifyMfa } = useAuth();
    const { t } = useI18n();
    const router = useRouter();
    // When the account has MFA on, the password step returns a challenge token and we switch to a
    // second view asking for the authenticator (or backup) code.
    const [mfaToken, setMfaToken] = useState<string | null>(null);
    const [mfaCode, setMfaCode] = useState("");

    useEffect(() => {
        const back = currentReturnPath();
        if (back) setRegisterHref(`/register?redirect=${encodeURIComponent(back)}`);
    }, []);

    useEffect(() => {
        let active = true;
        authApi.passwordResetAvailable()
            .then((r) => { if (active) setResetAvailable(!!r?.available); })
            .catch(() => { /* probe failed — leave the link hidden */ });
        settingsApi.get()
            .then((s) => { if (active) setRegisterAvailable(String(s?.users_can_register ?? "") === "1"); })
            .catch(() => { /* probe failed — leave the link hidden */ });
        return () => { active = false; };
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        const result = await login(username, password, remember);

        if (result.mfaRequired && result.mfaToken) {
            setMfaToken(result.mfaToken); // password OK → ask for the second factor
        } else if (result.success) {
            router.push(currentReturnPath() || "/admin");
        } else {
            setError(apiErrorText(t, result.apiError ?? result.error, 'login.invalidCredentials'));
        }

        setLoading(false);
    };

    const handleMfaSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!mfaToken) return;
        setError("");
        setLoading(true);
        const result = await verifyMfa(mfaToken, mfaCode.trim());
        if (result.success) {
            router.push(currentReturnPath() || "/admin");
        } else {
            setError(apiErrorText(t, result.apiError ?? result.error, 'mfa.invalidCode'));
        }
        setLoading(false);
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-800 flex items-center justify-center gap-3">
                        <i className="fa-solid fa-rocket text-blue-600"></i>
                        WordJS
                    </h1>
                    <p className="text-gray-500 mt-2">{t('login.subtitle')}</p>
                </div>

                {mfaToken ? (
                    <form onSubmit={handleMfaSubmit} className="space-y-6">
                        <div className="text-center">
                            <i className="fa-solid fa-shield-halved text-blue-600 text-2xl mb-2"></i>
                            <p className="text-sm text-gray-500">{t('login.mfaPrompt')}</p>
                        </div>
                        <Input
                            id="login-mfa-code"
                            size="md"
                            label={t('login.mfaCode')}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            autoFocus
                            value={mfaCode}
                            onChange={(e) => setMfaCode(e.target.value)}
                            className="tracking-widest text-center text-lg"
                            placeholder="123456"
                            required
                        />
                        {error && (
                            <div role="alert" className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>
                        )}
                        <Button type="submit" size="md" className="w-full" pending={loading} pendingLabel={t('login.verifying')}>
                            {t('login.verify')}
                        </Button>
                        <Button variant="link" className="w-full justify-center" onClick={() => { setMfaToken(null); setMfaCode(""); setError(""); }}>
                            &larr; {t('login.backToSignIn')}
                        </Button>
                    </form>
                ) : (
                <form onSubmit={handleSubmit} className="space-y-6">
                    <Input
                        id="login-username"
                        size="md"
                        label={t('users.username')}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder={t('login.usernamePlaceholder')}
                        required
                    />

                    <Input
                        id="login-password"
                        size="md"
                        type={showPassword ? "text" : "password"}
                        label={t('users.password')}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t('login.passwordPlaceholder')}
                        required
                        trailing={
                            <IconButton
                                size="sm"
                                icon={showPassword ? 'fa-eye-slash' : 'fa-eye'}
                                label={t(showPassword ? 'login.hidePassword' : 'login.showPassword')}
                                aria-pressed={showPassword}
                                onClick={() => setShowPassword(!showPassword)}
                            />
                        }
                    />

                    <Checkbox
                        label={t('login.rememberMe')}
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        containerClassName="min-h-11 flex items-center"
                    />

                    {error && (
                        <div role="alert" className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">
                            {error}
                        </div>
                    )}

                    <Button type="submit" size="md" className="w-full" pending={loading} pendingLabel={t('login.signingIn')}>
                        {t('login.signIn')}
                    </Button>

                    {resetAvailable && (
                        <div className="text-center">
                            <a href="/reset-password" className="text-sm text-blue-600 hover:text-blue-700 font-medium">
                                {t('login.forgotPassword')}
                            </a>
                        </div>
                    )}

                    {registerAvailable && (
                        <div className="text-center">
                            <span className="text-sm text-gray-500">{t('login.noAccount')} </span>
                            <a href={registerHref} className="text-sm text-blue-600 hover:text-blue-700 font-medium">
                                {t('login.createAccount')}
                            </a>
                        </div>
                    )}
                </form>
                )}

                <div className="mt-6 text-center">
                    <a href="/" className="inline-flex items-center min-h-11 text-sm text-gray-500 hover:text-blue-600">
                        &larr; {t('login.backToHome')}
                    </a>
                </div>
            </div>
        </div>
    );
}

// The language provider comes from the sign-in shell (layout.tsx → _root/AuthScreen.tsx), seeded with
// the language the server rendered in.
export default function LoginPage() {
    return (
        <AuthProvider>
            <LoginForm />
        </AuthProvider>
    );
}
