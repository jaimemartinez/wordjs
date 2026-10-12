"use client";

import { useEffect, useState } from "react";
import { rolesApi, type Role } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { buildRoleOptions, type RoleOption } from "@/lib/roleOptions";

/**
 * The role choices for a user form: every role from GET /roles, grouped (lib/roleOptions.ts). When the
 * list cannot be read (GET /roles is administrator-only) the form keeps the four core roles it always had.
 */
export function useRoleOptions(currentRole?: string): RoleOption[] {
    const { t } = useI18n();
    const roles = useRolesMap();
    return buildRoleOptions(roles, t, currentRole);
}

/** GET /roles, or null while it loads or when this user may not read it (it is administrator-only). */
export function useRolesMap(): Record<string, Role> | null {
    const [roles, setRoles] = useState<Record<string, Role> | null>(null);
    useEffect(() => {
        let active = true;
        rolesApi.list()
            .then((data) => { if (active) setRoles(data); })
            .catch(() => { /* not readable for this user: callers fall back (core roles, slugs) */ });
        return () => { active = false; };
    }, []);
    return roles;
}
