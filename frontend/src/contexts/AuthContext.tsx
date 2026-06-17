"use client";

import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import { useRouter } from "next/navigation";

interface User {
    id: number;
    username: string;
    email: string;
    displayName: string;
    role: string;
    capabilities: string[];
}

interface LoginResult {
    success: boolean;
    error?: string;
}

interface AuthContextType {
    user: User | null;
    login: (username: string, password: string) => Promise<LoginResult>;
    logout: () => void;
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

    const fetchUser = async () => {
        try {
            const res = await fetch(`${API_URL}/auth/me`, {
                credentials: "include", // Send HttpOnly cookie
            });
            if (res.ok) {
                const userData = await res.json();
                setUser(userData);
            } else if (res.status === 401 || res.status === 403) {
                // Genuinely unauthenticated — clear the session.
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
                setUser(data.user);
                return { success: true };
            }

            // Surface the server-provided message (e.g. "account locked") when available.
            let error: string | undefined;
            try {
                const data = await res.json();
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
        () => ({ user, login, logout, isLoading, can }),
        [user, login, logout, isLoading, can]
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

