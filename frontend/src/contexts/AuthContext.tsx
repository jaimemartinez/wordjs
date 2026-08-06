"use client";

import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { SESSION_ENDED_EVENT } from "@/lib/api";

interface MfaStatus {
    required: boolean;      // the user's role is subject to the enforced-MFA policy
    enabled: boolean;       // the user has TOTP enabled
    enforced: boolean;      // required && !enabled && past the grace window → hard block
    withinGrace: boolean;   // required && !enabled but still inside the grace window → nudge only
    graceDeadline: number | null; // epoch seconds the grace window ends
}

interface User {
    id: number;
    username: string;
    email: string;
    displayName: string;
    role: string;
    capabilities: string[];
    personalEmail?: string | null;
    mfa?: MfaStatus;
}

interface LoginResult {
    success: boolean;
    error?: string;
    mfaRequired?: boolean; // password OK, but a second factor is needed
    mfaToken?: string;     // short-lived challenge to pass to verifyMfa()
}

interface AuthContextType {
    user: User | null;
    login: (username: string, password: string) => Promise<LoginResult>;
    verifyMfa: (mfaToken: string, code: string) => Promise<LoginResult>;
    logout: () => void;
    refreshUser: () => Promise<void>;
    isLoading: boolean;
    can: (capability: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_URL = '/api/v1';

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();

    useEffect(() => {
        // Check for existing session via HttpOnly cookie
        // The cookie is sent automatically with credentials: include
        fetchUser();
    }, []);

    // Sliding Window Session Logic
    useEffect(() => {
        if (!user) return; // Only track if logged in

        let lastActivity = Date.now();
        const ACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
        const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes checking cycle

        const updateActivity = () => {
            // Throttling could be added here if needed, but simple assignment is cheap
            lastActivity = Date.now();
        };

        // Listeners for activity
        const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
        events.forEach(event => window.addEventListener(event, updateActivity));

        const checkActivity = async () => {
            const now = Date.now();
            // If active within the last 30 minutes
            if (now - lastActivity < ACTIVITY_TIMEOUT) {
                try {
                    // Refresh token to extend session
                    await fetch(`${API_URL}/auth/refresh`, {
                        method: "POST",
                        credentials: "include",
                    });
                    console.debug("Session extended via Sliding Window");
                } catch (err) {
                    console.warn("Failed to extend session", err);
                }
            }
        };

        const intervalId = setInterval(checkActivity, REFRESH_INTERVAL);

        return () => {
            events.forEach(event => window.removeEventListener(event, updateActivity));
            clearInterval(intervalId);
        };
    }, [user?.id]);

    // Any request may be the one that discovers the session is over — it is not always this context's
    // own /auth/me poll. api() announces that centrally, and the response is exactly what fetchUser
    // already does for a 401: clear the user. Without this the app kept rendering as if signed in until
    // the next poll, and every caller was left to interpret the failure on its own.
    useEffect(() => {
        const onSessionEnded = () => setUser(null);
        window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
        return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    }, []);

    const fetchUser = async () => {
        try {
            const res = await fetch(`${API_URL}/auth/me`, {
                credentials: "include", // Send HttpOnly cookie
            });
            if (res.ok) {
                const userData = await res.json();
                setUser(userData);
            } else if (res.status === 401) {
                // Genuinely unauthenticated — clear the session. A 403 means authenticated-but-
                // forbidden (not a session problem), so it must NOT clear the user / force logout.
                setUser(null);
            }
            // On 5xx / other transient errors, keep the previous user to avoid a spurious logout.
        } catch (error) {
            // Network error — keep the previous user rather than forcing a logout.
            console.error("Auth error:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
        try {
            const res = await fetch(`${API_URL}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
                credentials: "include", // Receive and store HttpOnly cookie
            });

            if (res.ok) {
                const data = await res.json();
                if (data.mfaRequired) {
                    // Password verified, but the account needs a second factor. Do NOT set the user yet;
                    // the caller must collect a code and call verifyMfa(mfaToken, code).
                    return { success: false, mfaRequired: true, mfaToken: data.mfaToken };
                }
                // `mfa` is a SIBLING of `user` in the login/mfa response (not on data.user) — merge it so the
                // policy status travels with the user object the app reads.
                setUser({ ...data.user, mfa: data.mfa });
                return { success: true };
            }

            // Surface the server-provided message (e.g. "account locked") when available.
            let error: string | undefined;
            try {
                const data = await res.json();
                // Fresh install: every API call answers 503 setup_required — take the user to the
                // wizard instead of showing "invalid credentials" on a site that has no users yet.
                if (res.status === 503 && data?.error === "setup_required") {
                    window.location.href = "/install";
                    return { success: false };
                }
                error = data?.message || data?.error;
            } catch {
                // Non-JSON error body — fall back to the generic message in the caller.
            }
            return { success: false, error };
        } catch (error) {
            console.error("Login error:", error);
            return { success: false };
        }
    }, []);

    const verifyMfa = useCallback(async (mfaToken: string, code: string): Promise<LoginResult> => {
        try {
            const res = await fetch(`${API_URL}/auth/mfa`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mfaToken, code }),
                credentials: "include",
            });
            if (res.ok) {
                const data = await res.json();
                setUser({ ...data.user, mfa: data.mfa });
                return { success: true };
            }
            let error: string | undefined;
            try { const d = await res.json(); error = d?.message || d?.error; } catch { /* non-JSON */ }
            return { success: false, error };
        } catch (error) {
            console.error("MFA verify error:", error);
            return { success: false };
        }
    }, []);

    // Re-fetch /auth/me and update the user in place (used by the forced-enroll gate to lift the block once
    // MFA is enabled, without a full page reload).
    const refreshUser = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
            if (res.ok) setUser(await res.json());
        } catch (err) {
            console.error("refreshUser error:", err);
        }
    }, []);

    const logout = useCallback(async () => {
        try {
            // Call logout endpoint to clear HttpOnly cookie on server
            await fetch(`${API_URL}/auth/logout`, {
                method: "POST",
                credentials: "include",
            });
        } catch (error) {
            console.error("Logout error:", error);
        }
        // Clean up legacy tokens
        localStorage.removeItem("wordjs_token");
        setUser(null);
        router.push("/login");
    }, [router]);

    const can = useCallback((capability: string): boolean => {
        if (!user) return false;
        if (user.role === 'administrator' || user.capabilities.includes('*')) return true;
        return user.capabilities.includes(capability);
    }, [user]);

    const value = useMemo(
        () => ({ user, login, verifyMfa, logout, refreshUser, isLoading, can }),
        [user, login, verifyMfa, logout, refreshUser, isLoading, can]
    );

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}

