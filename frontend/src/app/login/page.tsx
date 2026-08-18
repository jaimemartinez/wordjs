"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { authApi, settingsApi } from "@/lib/api";

function LoginForm() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    // "Forgot password?" is only offered when self-service reset can actually deliver mail (probe below).
    const [resetAvailable, setResetAvailable] = useState(false);
    // Same rule for sign-up: only offer /register when the operator has actually turned
    // `users_can_register` on. It is a PUBLIC setting, so this reads without a session, and a failed
    // probe leaves the link hidden rather than advertising a form that would answer 403.
    const [registerAvailable, setRegisterAvailable] = useState(false);
    const { login, verifyMfa } = useAuth();
    const router = useRouter();
    // When the account has MFA on, the password step returns a challenge token and we switch to a
    // second view asking for the authenticator (or backup) code.
    const [mfaToken, setMfaToken] = useState<string | null>(null);
    const [mfaCode, setMfaCode] = useState("");

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

        const result = await login(username, password);

        if (result.mfaRequired && result.mfaToken) {
            setMfaToken(result.mfaToken); // password OK → ask for the second factor
        } else if (result.success) {
            router.push("/admin");
        } else {
            setError(result.error || "Invalid username or password");
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
            router.push("/admin");
        } else {
            setError(result.error || "Invalid authentication code");
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
                    <p className="text-gray-500 mt-2">Admin Dashboard</p>
                </div>

                {mfaToken ? (
                    <form onSubmit={handleMfaSubmit} className="space-y-6">
                        <div className="text-center">
                            <i className="fa-solid fa-shield-halved text-blue-600 text-2xl mb-2"></i>
                            <p className="text-sm text-gray-500">Enter the 6-digit code from your authenticator app, or a backup code.</p>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Authentication code</label>
                            <input
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                autoFocus
                                value={mfaCode}
                                onChange={(e) => setMfaCode(e.target.value)}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900 tracking-widest text-center text-lg"
                                placeholder="123456"
                                required
                            />
                        </div>
                        {error && (
                            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>
                        )}
                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 px-4 rounded-lg font-medium transition-colors"
                        >
                            {loading ? "Verifying..." : "Verify"}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setMfaToken(null); setMfaCode(""); setError(""); }}
                            className="w-full text-sm text-gray-500 hover:text-blue-600"
                        >
                            &larr; Back to sign in
                        </button>
                    </form>
                ) : (
                <form onSubmit={handleSubmit} className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Username
                        </label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900"
                            placeholder="Enter username"
                            required
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Password
                        </label>
                        <div className="relative">
                            <input
                                type={showPassword ? "text" : "password"}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900 pr-10"
                                placeholder="Enter password"
                                required
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 focus:outline-none"
                            >
                                <i className={`fa-solid ${showPassword ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 px-4 rounded-lg font-medium transition-colors"
                    >
                        {loading ? "Logging in..." : "Login"}
                    </button>

                    {resetAvailable && (
                        <div className="text-center">
                            <a href="/reset-password" className="text-sm text-blue-600 hover:text-blue-700 font-medium">
                                Forgot your password?
                            </a>
                        </div>
                    )}

                    {registerAvailable && (
                        <div className="text-center">
                            <span className="text-sm text-gray-500">¿No tienes cuenta? </span>
                            <a href="/register" className="text-sm text-blue-600 hover:text-blue-700 font-medium">
                                Crear una cuenta
                            </a>
                        </div>
                    )}
                </form>
                )}

                <div className="mt-6 text-center">
                    <a href="/" className="text-sm text-gray-500 hover:text-blue-600">
                        &larr; Back to Home
                    </a>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <AuthProvider>
            <LoginForm />
        </AuthProvider>
    );
}
