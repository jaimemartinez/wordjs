"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { MenuLoader, menuLoadKey, type MenuLoadState } from "@/lib/adminMenuLoad";

interface MenuItem {
    href: string;
    label: string;
    icon: string;
    order: number;
    plugin: string;
    cap?: string;
}

interface MenuContextType {
    pluginMenus: MenuItem[];
    refreshMenus: () => Promise<void>;
    /** True until the menu of the CURRENT signed-in identity has loaded (or every retry failed). */
    isLoading: boolean;
}

const MenuContext = createContext<MenuContextType | undefined>(undefined);

/** The fetch ended because the session did (lib/api isSessionEnded): an expected end state, not an error. */
class SessionEndedError extends Error {}

/**
 * The plugin menu of the signed-in user. The admin layout's route guard opens a plugin's page only
 * through one of these items (lib/adminAccess.ts), so the menu follows the IDENTITY (lib/adminMenuLoad.ts):
 * it is loaded again when the user, their role or their two-factor block changes — the user who just
 * finished enrolling gets their plugin screens without reloading the page — and a failed load is retried
 * instead of being taken for an empty menu.
 */
export function MenuProvider({ children }: { children: React.ReactNode }) {
    const { user, isLoading: authLoading } = useAuth();
    const key = menuLoadKey(user, authLoading);
    const [state, setState] = useState<MenuLoadState<MenuItem>>({ key: null, menus: [], loaded: false, failed: false });

    const loaderRef = useRef<MenuLoader<MenuItem> | null>(null);
    if (loaderRef.current == null) {
        loaderRef.current = new MenuLoader<MenuItem>({
            fetchMenus: async () => {
                const { apiGet, isSessionEnded } = await import("@/lib/api");
                try {
                    return await apiGet<MenuItem[]>("/plugins/menus");
                } catch (error) {
                    throw isSessionEnded(error) ? new SessionEndedError() : error;
                }
            },
            onChange: setState,
            // An expired or revoked session is an EXPECTED end state, not a failure of this fetch: api()
            // has already announced it so AuthContext can sign the user out. Stay quiet, do not retry.
            isTerminal: (error) => error instanceof SessionEndedError,
            onError: (error) => console.error("Error refreshing menus:", error),
        });
    }

    useEffect(() => {
        loaderRef.current!.setKey(key);
    }, [key]);

    useEffect(() => () => loaderRef.current?.dispose(), []);

    const refreshMenus = useCallback(() => loaderRef.current!.refresh(), []);

    // No one signed in (and the session resolved): nothing to wait for.
    const settledEmpty = !authLoading && !user;
    const isLoading = settledEmpty ? false : !(state.loaded && state.key !== null && state.key === key);
    const pluginMenus = state.key !== null && state.key === key ? state.menus : [];

    return (
        <MenuContext.Provider value={{ pluginMenus, refreshMenus, isLoading }}>
            {children}
        </MenuContext.Provider>
    );
}

export function useMenu() {
    const context = useContext(MenuContext);
    if (context === undefined) {
        throw new Error("useMenu must be used within a MenuProvider");
    }
    return context;
}
