"use client";

import { useEffect, useState } from "react";
import { usersApi, AccountCapabilityDeclaration } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";

/**
 * The per-account capabilities active plugins declare (manifest `accountCapabilities`), one toggle each,
 * rendered from the declarations GET /users/account-capabilities returns — the core knows nothing about
 * what any of them means. The endpoint needs `edit_users`, the same capability the backend requires to
 * change a grant, so a viewer without it (a self-edit) simply sees no toggles; their form still resends
 * the loaded state unchanged, which the backend treats as a no-op.
 *
 * The form keeps a map of capability → on/off, seeded from the user's granted capabilities (grantedMap).
 */
export type CapabilityMap = Record<string, boolean>;

/** The form state for a loaded user: every granted capability on. */
export function grantedMap(granted: string[] | undefined | null): CapabilityMap {
    const out: CapabilityMap = {};
    for (const slug of granted || []) out[slug] = true;
    return out;
}

/**
 * A NEW account starts with the capabilities their plugin asks to be on by default — still an explicit,
 * visible choice the administrator can turn off before saving. Returns null when nothing changes.
 */
export function withNewAccountDefaults(declared: AccountCapabilityDeclaration[], value: CapabilityMap | undefined): CapabilityMap | null {
    const current = value || {};
    const defaults = declared.filter((d) => d.defaultForNewAccounts && current[d.slug] === undefined);
    if (!defaults.length) return null;
    const next = { ...current };
    for (const d of defaults) next[d.slug] = true;
    return next;
}

/** The toggles themselves (pure: the declarations and the state come in). */
export function AccountCapabilityList({ declared, value, onChange, legend }: {
    declared: AccountCapabilityDeclaration[];
    value: CapabilityMap | undefined;
    onChange: (next: CapabilityMap) => void;
    legend: string;
}) {
    if (!declared.length) return null;
    const current = value || {};
    return (
        <fieldset className="space-y-2" data-account-capabilities="">
            <legend className="block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">{legend}</legend>
            {declared.map((d) => {
                const on = !!current[d.slug];
                const id = `account-capability-${d.slug}`;
                return (
                    <div key={d.slug} className="flex items-center justify-between gap-4 p-4 bg-gray-50/50 rounded-2xl border-2 border-gray-100">
                        <div className="min-w-0">
                            <label htmlFor={id} className="block text-sm font-bold text-gray-900">{d.name}</label>
                            {d.description && <p className="text-[11px] text-gray-600 mt-1 leading-relaxed">{d.description}</p>}
                        </div>
                        <button
                            id={id}
                            type="button"
                            role="switch"
                            aria-checked={on}
                            data-account-capability={d.slug}
                            onClick={() => onChange({ ...current, [d.slug]: !on })}
                            className={`w-12 h-6 shrink-0 rounded-full transition-all relative ${on ? "bg-blue-600 shadow-inner" : "bg-gray-300"}`}
                        >
                            <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm ${on ? "translate-x-6" : "translate-x-0"}`}></span>
                        </button>
                    </div>
                );
            })}
        </fieldset>
    );
}

export default function AccountCapabilityToggles({ value, onChange, isNew }: {
    value: CapabilityMap | undefined;
    onChange: (next: CapabilityMap) => void;
    isNew: boolean;
}) {
    const { t } = useI18n();
    const [declared, setDeclared] = useState<AccountCapabilityDeclaration[]>([]);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const list = await usersApi.accountCapabilities();
                if (alive) setDeclared(Array.isArray(list) ? list : []);
            } catch {
                if (alive) setDeclared([]); // no edit_users, or nothing declared — nothing to render
            }
        })();
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!isNew) return;
        const next = withNewAccountDefaults(declared, value);
        if (next) onChange(next);
    }, [isNew, declared]); // eslint-disable-line react-hooks/exhaustive-deps

    return <AccountCapabilityList declared={declared} value={value} onChange={onChange} legend={t('user.edit.accountCapabilities')} />;
}
