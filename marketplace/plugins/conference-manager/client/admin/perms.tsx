// @ts-nocheck
"use client";

/**
 * Staff permissions (2.15.0) for the admin UI.
 *
 * `PermsProvider` reads GET /staff/me ONCE when the admin page mounts; `usePerms()` answers
 * `can(section, level)` from it so every view hides (or disables, with a reason) what the person's role
 * does not allow. The server is the real gate — it re-checks every request — this only keeps the UI from
 * offering actions that would answer 403.
 *
 * WordJS administrators always get everything. Without a provider (a page rendered on its own, e.g. in a
 * harness) `usePerms()` behaves as an administrator, which is what every view did before 2.15.0.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { conferenceApi, STAFF_SECTIONS } from "../lib/conference";
import type { StaffLevel, StaffPermissions, StaffSection } from "../lib/conference";
import { useTx } from "./MealScanner";

const RANK: Record<string, number> = { none: 0, view: 1, manage: 2 };
export const levelRank = (level?: string | null): number => RANK[String(level || 'none')] ?? 0;

/** Every section at its highest level (what an administrator has). */
export const fullPermissions = (): StaffPermissions =>
    Object.fromEntries(STAFF_SECTIONS.map(s => [s.key, s.levels[s.levels.length - 1]])) as StaffPermissions;

/** Unknown sections / levels are dropped; a missing section reads as 'none'. */
export const normalizePermissions = (raw: any): StaffPermissions => {
    const out: any = {};
    for (const s of STAFF_SECTIONS) {
        const v = raw && typeof raw === 'object' ? String(raw[s.key] || 'none') : 'none';
        out[s.key] = (s.levels as string[]).includes(v) ? v : 'none';
    }
    return out;
};

export type Perms = {
    loading: boolean;
    /** GET /staff/me failed (network / server): the page offers a retry instead of guessing. */
    error: string | null;
    isAdmin: boolean;
    isStaff: boolean;
    permissions: StaffPermissions;
    user: { id: number; name: string } | null;
    /** `level` defaults to 'view'. Administrators can everything. */
    can: (section: StaffSection, level?: StaffLevel) => boolean;
    reload: () => void;
};

const ADMIN_PERMS: Perms = {
    loading: false, error: null, isAdmin: true, isStaff: false, permissions: fullPermissions(), user: null,
    can: () => true, reload: () => { },
};

const PermsContext = createContext<Perms | null>(null);

export function PermsProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<{ loading: boolean; error: string | null; isAdmin: boolean; isStaff: boolean; permissions: StaffPermissions; user: any }>(
        { loading: true, error: null, isAdmin: false, isStaff: false, permissions: normalizePermissions(null), user: null },
    );
    const [seq, setSeq] = useState(0);
    useEffect(() => {
        let alive = true;
        setState(s => ({ ...s, loading: true, error: null }));
        conferenceApi.getStaffMe()
            .then((me: any) => {
                if (!alive) return;
                const isAdmin = !!me?.isAdmin;
                setState({
                    loading: false, error: null, isAdmin, isStaff: !!me?.isStaff,
                    permissions: isAdmin ? fullPermissions() : normalizePermissions(me?.permissions),
                    user: me?.user || null,
                });
            })
            .catch((e: any) => {
                if (!alive) return;
                // A backend older than 2.15.0 has no /staff/me: there every route was administrators-only,
                // so whoever reaches this page with it is an administrator — keep the full UI.
                if (Number(e?.status) === 404) {
                    setState({ loading: false, error: null, isAdmin: true, isStaff: false, permissions: fullPermissions(), user: null });
                    return;
                }
                setState(s => ({ ...s, loading: false, error: e?.message || 'Error' }));
            });
        return () => { alive = false; };
    }, [seq]);
    const reload = useCallback(() => setSeq(n => n + 1), []);
    const value = useMemo<Perms>(() => ({
        ...state,
        can: (section: StaffSection, level: StaffLevel = 'view') =>
            state.isAdmin || levelRank(state.permissions[section]) >= levelRank(level),
        reload,
    }), [state, reload]);
    return <PermsContext.Provider value={value}>{children}</PermsContext.Provider>;
}

export const usePerms = (): Perms => useContext(PermsContext) || ADMIN_PERMS;

/**
 * GET /inscriptions (the roster other views name people from) and GET /hotels answer for any of these
 * sections — mirrors the server's route table, so the UI only asks for what it will be given.
 */
export const canReadRoster = (p: Perms) =>
    p.can('inscriptions') || p.can('payments') || p.can('lodging') || p.can('transport') || p.can('accounting') || p.can('dashboard') || p.can('reports');
export const canReadHotels = (p: Perms) => p.can('lodging') || p.can('inscriptions') || p.can('dashboard') || p.can('reports');

/** Does the role open at least one section (is there anything to show)? */
export const hasAnySection = (p: Perms) => p.isAdmin || STAFF_SECTIONS.some(s => levelRank(p.permissions[s.key]) > 0);

/**
 * The short reason shown at the top of a section the role may only VIEW: its create / edit / delete /
 * move / validate controls are hidden or disabled below it. Never shown to administrators.
 */
/**
 * «Solo lectura» for a view whose own section is view-only. `alsoManage`: other sections whose actions live
 * in the same view (payments and room assignment inside Inscripciones, the deadline inside Localidades…) —
 * when the role may manage one of them the view is not read-only, and the banner would contradict it.
 */
export function ReadOnlyNotice({ section, alsoManage = [], className = '' }: { section: StaffSection; alsoManage?: StaffSection[]; className?: string }) {
    const p = usePerms();
    const tx = useTx();
    if (p.isAdmin || !p.can(section, 'view') || p.can(section, 'manage') || alsoManage.some((s) => p.can(s, 'manage'))) return null;
    return (
        <div className={`rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-xs font-bold text-sky-800 flex items-center gap-2 ${className}`} role="note" data-readonly-notice={section}>
            <i className="fa-solid fa-eye" aria-hidden="true"></i>
            <span>{tx('perm.readonly', 'Solo lectura: tu rol te deja ver esta sección, pero no modificarla.')}</span>
        </div>
    );
}
