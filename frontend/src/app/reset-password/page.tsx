"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";

// Public, unauthenticated. Two modes on one page:
//   • No token in the URL  → "request a reset link" form (enter username/email → POST forgot-password).
//   • uid + token present  → "set a new password" form (the link delivered by email → POST reset-password).
function ResetPasswordInner() {
    const router = useRouter();
    const params = useSearchParams();
    const uid = params.get("uid");
    const token = params.get("token");
    const hasToken = !!uid && !!token;

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);

    // Request mode
    const [login, setLogin] = useState("");
    // Set-new-password mode
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [showPassword, setShowPassword] = useState(false);

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
        if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
        if (password !== confirm) { setError("The passwords do not match."); return; }
        setLoading(true);
        try {
            await authApi.resetPassword({ uid: Number(uid), token: token as string, password });
            setDone(true);
        } catch (err: any) {
            setError(err?.message || "This reset link is invalid or has expired. Please request a new one.");
        } finally {
            setLoading(false);
        }
    };

    const shell = (children: React.ReactNode) => (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-800 flex items-center justify-center gap-3">
                        <i className="fa-solid fa-rocket text-blue-600"></i>
                        WordJS
                    </h1>
                    <p className="text-gray-500 mt-2">Password Recovery</p>
                </div>
                {children}
                <div className="mt-6 text-center">
                    <a href="/login" className="text-sm text-gray-500 hover:text-blue-600">
                        &larr; Back to Login
                    </a>
                </div>
            </div>
        </div>
    );

    // ---- Success states -------------------------------------------------------------------------
    if (done && hasToken) {
        return shell(
            <div className="text-center space-y-4">
                <i className="fa-solid fa-circle-check text-green-500 text-4xl"></i>
                <p className="text-gray-700">Your password has been reset.</p>
                <button
                    onClick={() => router.push("/login")}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg font-medium transition-colors"
                >
                    Go to Login
                </button>
            </div>
        );
    }
    if (done) {
        return shell(
            <div className="text-center space-y-4">
                <i className="fa-solid fa-envelope-circle-check text-blue-500 text-4xl"></i>
                <p className="text-gray-700">
                    If an account with a recovery email exists, we&apos;ve sent a password reset link.
                    Please check your inbox.
                </p>
                <p className="text-sm text-gray-500">The link is valid for 30 minutes.</p>
            </div>
        );
    }

    // ---- Set-new-password mode ------------------------------------------------------------------
    if (hasToken) {
        return shell(
            <form onSubmit={handleReset} className="space-y-6">
                <p className="text-sm text-gray-500 text-center">Choose a new password for your account.</p>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">New Password</label>
                    <div className="relative">
                        <input
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900 pr-10"
                            placeholder="At least 8 characters"
                            required
                            minLength={8}
                        />
                        <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 focus:outline-none"
                        >
                            <i className={`fa-solid ${showPassword ? "fa-eye-slash" : "fa-eye"}`}></i>
                        </button>
                    </div>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Confirm New Password</label>
                    <input
                        type={showPassword ? "text" : "password"}
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900"
                        placeholder="Re-enter your new password"
                        required
                        minLength={8}
                    />
                </div>
                {error && <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}
                <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 px-4 rounded-lg font-medium transition-colors"
                >
                    {loading ? "Resetting…" : "Reset Password"}
                </button>
            </form>
        );
    }

    // ---- Request-a-link mode --------------------------------------------------------------------
    return shell(
        <form onSubmit={handleRequest} className="space-y-6">
            <p className="text-sm text-gray-500 text-center">
                Enter your username or account email and we&apos;ll send a reset link to your recovery address.
            </p>
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Username or Email</label>
                <input
                    type="text"
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900"
                    placeholder="Enter username or email"
                    required
                />
            </div>
            {error && <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}
            <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 px-4 rounded-lg font-medium transition-colors"
            >
                {loading ? "Sending…" : "Send Reset Link"}
            </button>
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
