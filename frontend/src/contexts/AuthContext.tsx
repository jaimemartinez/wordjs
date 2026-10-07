"use client";

import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { SESSION_ENDED_EVENT, announceHostNotAllowed, settingsApi } from "@/lib/api";
import { canonicalLink, fillTemplate, noticeLanguage, storedAdminLanguage } from "@/lib/siteAddress";
// This context talks to /auth/* with raw fetch (not the api() client), so it carries the double-submit
// CSRF token itself — see lib/csrf.ts for why every cookie-carrying mutation must.
import { csrfHeaders } from "@/lib/csrf";

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
    /** The backend does not serve this address (421): there is no session to have here, and no form. */
    hostRefused: boolean;
    /** Signed out, and this address may not mint a session (REDTEAM R13): why, or null. */
    signInRefused: SignInRefusal | null;
}

/** Why an accepted address still may not start a session: plain http to an https site, or not enabled. */
export type SignInRefusal = "transport" | "address";

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_URL = '/api/v1';

/** What GET /auth/me says about this tab's session. */
export type SessionProbe =
    | { kind: "user"; user: User }
    | { kind: "signed-out"; signInRefused: SignInRefusal | null }
    | { kind: "host-refused" }
    | { kind: "unknown" };

/**
 * Ask the backend who is signed in, and say what the answer MEANS. The one place that maps statuses:
 *   200 -> the user;
 *   401 -> genuinely unauthenticated, so the session is cleared. Its body says whether this address may
 *          START a session at all (`data.signIn`, REDTEAM R13): when it may not, a sign-in form would make
 *          the visitor send a password the backend is bound to refuse — over plain http, in clear text;
 *   421 -> this address is not served at all (the host gate): no session can exist here, and a sign-in
 *          form would only collect a password on an address the operator never declared;
 *   anything else (403 authenticated-but-forbidden, 5xx, a network error) -> unknown, and the caller
 *          keeps what it had rather than logging someone out over a transient failure.
 */
export async function probeSession(fetchImpl: typeof fetch = fetch): Promise<SessionProbe> {
    try {
        const res = await fetchImpl(`${API_URL}/auth/me`, { credentials: "include" });
        if (res.ok) return { kind: "user", user: await res.json() };
        if (res.status === 401) {
            const body = await res.json().catch(() => null);
            const data = body && typeof body === "object" ? (body as { data?: { signIn?: unknown; signInRefused?: unknown } }).data : undefined;
            if (data?.signIn !== false) return { kind: "signed-out", signInRefused: null };
            // An unrecognised reason still refuses: the backend said no, the wording is ours to choose.
            return { kind: "signed-out", signInRefused: data.signInRefused === "transport" ? "transport" : "address" };
        }
        if (res.status === 421) return { kind: "host-refused" };
        return { kind: "unknown" };
    } catch (error) {
        console.error("Auth error:", error);
        return { kind: "unknown" };
    }
}

/**
 * What renders INSTEAD of the tree under AuthProvider (the login form, the admin) when no session can be
 * had at this address: one line, no form, no button. For a refused address (`host`) the root layout's
 * HostNotAllowedNotice already explains and links to the main address; for an accepted address that may
 * not mint a session (`transport` / `address`) this panel links there itself, from the public `siteurl`.
 * The strings load lazily for the same reason as that notice's.
 */
function AddressRefusedPanel({ reason }: { reason: "host" | SignInRefusal }) {
    const [line, setLine] = useState<string | null>(null);
    const [link, setLink] = useState<{ href: string; label: string } | null>(null);
    useEffect(() => {
        let active = true;
        const lang = noticeLanguage(storedAdminLanguage(() => window.localStorage), document.documentElement.lang || null);
        import("@/lib/i18n").then(({ t }) => {
            if (!active) return;
            setLine(t(reason === "host" ? "hostNotice.signinDisabled" : `hostNotice.signinRefused.${reason}`, lang));
            if (reason === "host") return;
            settingsApi.get()
                .then((settings) => {
                    const target = canonicalLink(settings?.siteurl || settings?.home, window.location);
                    if (active && target) setLink({ href: target.href, label: fillTemplate(t("hostNotice.goTo", lang), { canonical: target.origin }) });
                })
                .catch(() => { /* no link: the line still says what to do */ });
        });
        return () => { active = false; };
    }, [reason]);
    return (
        <main data-wjs-host-refused={reason} className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50 px-4 pt-24">
            <p className="flex max-w-xl items-center gap-3 text-center text-sm font-medium text-gray-600">
                <i className="fa-solid fa-shield-halved text-amber-500" aria-hidden="true"></i>
                {line}
            </p>
            {link && (
                <a href={link.href} rel="nofollow" className="text-sm font-semibold text-blue-600 underline underline-offset-2 hover:text-blue-800">
                    {link.label}
                </a>
            )}
        </main>
    );
}

/**
 * Renders the tree under AuthProvider, unless no session can be had here: the backend refused this
 * address (421), or nobody is signed in and this address may not start a session (R13). A signed-in
 * user is never locked out by the second rule — their session predates the question.
 */
export function AuthGate({ hostRefused, signInRefused, signedIn, children }: {
    hostRefused: boolean;
    signInRefused: SignInRefusal | null;
    signedIn: boolean;
    children: ReactNode;
}) {
    if (hostRefused) return <AddressRefusedPanel reason="host" />;
    if (signInRefused && !signedIn) return <AddressRefusedPanel reason={signInRefused} />;
    return <>{children}</>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [hostRefused, setHostRefused] = useState(false);
    const [signInRefused, setSignInRefused] = useState<SignInRefusal | null>(null);
    const router = useRouter();

    // A 421 seen by one of this context's own raw-fetch calls. Announced the way api() does, so the root
    // layout's notice appears even when this probe is the first request the page makes.
    const refuseHost = useCallback(() => {
        setUser(null);
        setHostRefused(true);
        announceHostNotAllowed();
    }, []);

    const fetchUser = useCallback(async () => {
        const probe = await probeSession();
        if (probe.kind === "user") setUser(probe.user);
        else if (probe.kind === "signed-out") {
            setUser(null);
            setSignInRefused(probe.signInRefused);
        } else if (probe.kind === "host-refused") refuseHost();
        // "unknown": keep the previous user rather than forcing a logout over a transient failure.
        setIsLoading(false);
    }, [refuseHost]);

    useEffect(() => {
        // Check for existing session via HttpOnly cookie
        // The cookie is sent automatically with credentials: include
        fetchUser();
    }, [fetchUser]);

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
                        // Cookie-authenticated mutation → double-submit token (see lib/csrf.ts). The
                        // response ROTATES wjs_csrf; nothing caches the value, so the next request
                        // reads the new one.
                        headers: csrfHeaders(),
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

    const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
        try {
            const res = await fetch(`${API_URL}/auth/login`, {
                method: "POST",
                // A STALE session cookie from a previous sign-in still makes this a cookie-carrying
                // mutation as far as the gate is concerned, so the token travels here too.
                headers: { "Content-Type": "application/json", ...csrfHeaders() },
                body: JSON.stringify({ username, password }),
                credentials: "include", // Receive and store HttpOnly cookie
            });

            if (res.status === 421) {
                // The backend never looked at the credentials: this address is not served.
                refuseHost();
                return { success: false };
            }

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
    }, [refuseHost]);

    const verifyMfa = useCallback(async (mfaToken: string, code: string): Promise<LoginResult> => {
        try {
            const res = await fetch(`${API_URL}/auth/mfa`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...csrfHeaders() },
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
        const probe = await probeSession();
        if (probe.kind === "user") setUser(probe.user);
        else if (probe.kind === "host-refused") refuseHost();
    }, [refuseHost]);

    const logout = useCallback(async () => {
        try {
            // Call logout endpoint to clear HttpOnly cookie on server
            await fetch(`${API_URL}/auth/logout`, {
                method: "POST",
                credentials: "include",
                headers: csrfHeaders(),
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
        () => ({ user, login, verifyMfa, logout, refreshUser, isLoading, can, hostRefused, signInRefused }),
        [user, login, verifyMfa, logout, refreshUser, isLoading, can, hostRefused, signInRefused]
    );

    return (
        <AuthContext.Provider value={value}>
            <AuthGate hostRefused={hostRefused} signInRefused={signInRefused} signedIn={user !== null}>{children}</AuthGate>
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

