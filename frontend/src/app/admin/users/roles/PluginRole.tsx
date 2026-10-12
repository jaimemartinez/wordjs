"use client";

import type { Role } from "@/lib/api";

/**
 * How the Roles screen shows a role a PLUGIN declared (backend core/plugin-roles.ts): labelled with the
 * plugin that provides it, read-only, and not deletable while that plugin is installed — the backend
 * refuses those writes anyway (409 rest_role_plugin_managed / 400 rest_role_plugin_capability); the
 * screen simply does not offer them.
 */

/** A role a plugin declared. */
export const isPluginRole = (role: Role | undefined | null): boolean => !!role && role.source === "plugin" && !!role.plugin;

/** May the administrator delete this role from the Roles screen? Not a plugin's role while it is installed. */
export const canDeleteRole = (role: Role | undefined | null): boolean => !(isPluginRole(role) && role!.pluginInstalled);

const fill = (template: string, plugin: string) => template.replace("{plugin}", plugin);

/** "From plugin X" (+ "Orphaned") badges under a role's name in the list. */
export function PluginRoleBadges({ role, t }: { role: Role; t: (key: string) => string }) {
    if (!isPluginRole(role)) return null;
    return (
        <p className="mt-2 flex flex-wrap gap-1" data-plugin-role={role.plugin}>
            <span className="text-[10px] px-2 py-0.5 bg-violet-50 text-violet-700 border border-violet-100 rounded-full font-bold">
                <i className="fa-solid fa-plug mr-1" aria-hidden="true"></i>
                {fill(t("roles.providedByPlugin"), role.plugin || "")}
            </span>
            {role.orphaned && (
                <span className="text-[10px] px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-100 rounded-full font-bold">
                    {t("roles.orphanedBadge")}
                </span>
            )}
        </p>
    );
}

/** The read-only panel shown instead of the edit form when a plugin's role is selected. */
export function PluginRolePanel({ slug, role, t, onClose }: { slug: string; role: Role; t: (key: string) => string; onClose: () => void }) {
    return (
        <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 p-8 sticky top-8" data-plugin-role-panel={role.plugin}>
            <div className="flex flex-wrap justify-between items-start gap-3 mb-6">
                <div>
                    <h2 className="text-xl font-bold text-gray-900">{role.name}</h2>
                    <p className="text-xs text-gray-400 mt-1 uppercase tracking-widest font-black">{slug}</p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-gray-500 hover:text-gray-700 font-bold"
                >
                    {t("roles.cancel")}
                </button>
            </div>
            {role.description && (
                <p className="text-sm text-gray-600 mb-4">{role.description}</p>
            )}
            <p className={`text-sm rounded-2xl px-4 py-3 mb-6 border ${role.orphaned ? "bg-amber-50 border-amber-100 text-amber-800" : "bg-violet-50 border-violet-100 text-violet-800"}`}>
                <i className="fa-solid fa-plug mr-2" aria-hidden="true"></i>
                {fill(t(role.orphaned ? "roles.pluginRoleOrphaned" : "roles.pluginRoleReadOnly"), role.plugin || "")}
            </p>
            <p className="block text-sm font-bold text-gray-700 mb-3">{t("roles.pluginRoleCapabilities")}</p>
            <ul className="flex flex-wrap gap-2">
                {role.capabilities.map((cap) => (
                    <li key={cap} className="text-xs px-3 py-1.5 bg-gray-50 border border-gray-100 rounded-xl font-medium text-gray-600">
                        {cap.replace(/_/g, " ")}
                    </li>
                ))}
            </ul>
        </div>
    );
}
