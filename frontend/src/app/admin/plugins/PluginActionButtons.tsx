"use client";

/**
 * The lifecycle buttons of Admin → Plugins and their PENDING state.
 *
 * Activating a plugin starts its sandboxed process and can take several seconds; deactivating and
 * deleting stop it. The buttons used to give no sign of that: no spinner, still enabled — the click
 * looked lost and invited a second one, i.e. a double activation. While an action runs, its button now
 * shows a spinner and "Activating…" / "Deactivating…" / "Deleting…", and every lifecycle button of that
 * plugin is disabled until the server has answered.
 */
import { FaCheck, FaPowerOff, FaSyncAlt } from "react-icons/fa";
import { UnstyledButton } from "@/components/ui";

export type PluginPendingAction = "activating" | "deactivating" | "deleting";

/** The catalogue key of the label a pending action shows. */
export const PENDING_LABEL_KEY: Record<PluginPendingAction, string> = {
    activating: "plugins.activating",
    deactivating: "plugins.deactivating",
    deleting: "plugins.deleting",
};

/** The card's Activate / Deactivate button. */
export function PluginToggleButton({ active, pending, onClick, t }: {
    active: boolean;
    /** What is running for this plugin, if anything. Any pending action disables the button. */
    pending?: PluginPendingAction;
    onClick: () => void;
    t: (key: string) => string;
}) {
    const busy = !!pending;
    // Bespoke on purpose: green to activate, red to deactivate, with the pending label (UnstyledButton keeps type, focus ring).
    return (
        <UnstyledButton
            onClick={onClick}
            disabled={busy}
            aria-busy={busy || undefined}
            data-plugin-pending={pending}
            className={`
                ml-auto shrink-0 px-4 py-2 rounded-xl font-extrabold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all duration-300 shadow-sm hover:scale-105 active:scale-95
                disabled:cursor-wait disabled:opacity-70 disabled:hover:scale-100
                ${active
                    ? 'bg-rose-50 text-rose-600 border border-rose-200/40 hover:bg-rose-600 hover:text-white hover:shadow-lg hover:shadow-rose-500/20 disabled:hover:bg-rose-50 disabled:hover:text-rose-600'
                    : 'bg-emerald-50 text-emerald-600 border border-emerald-200/40 hover:bg-emerald-600 hover:text-white hover:shadow-lg hover:shadow-emerald-500/20 disabled:hover:bg-emerald-50 disabled:hover:text-emerald-600'}
            `}
        >
            {pending ? (
                <>
                    <FaSyncAlt className="text-[11px] animate-spin" aria-hidden="true" /> {t(PENDING_LABEL_KEY[pending])}
                </>
            ) : active ? (
                <>
                    <FaPowerOff className="text-[11px]" /> {t('plugins.deactivate')}
                </>
            ) : (
                <>
                    <FaCheck className="text-[11px]" /> {t('plugins.activate')}
                </>
            )}
        </UnstyledButton>
    );
}

/** The content of a dialog's confirm button: its label, or a spinner and the pending label. */
export function PendingLabel({ pending, label, t }: { pending?: PluginPendingAction; label: string; t: (key: string) => string }) {
    if (!pending) return <>{label}</>;
    return (
        <span className="inline-flex items-center gap-2">
            <FaSyncAlt className="text-[11px] animate-spin" aria-hidden="true" /> {t(PENDING_LABEL_KEY[pending])}
        </span>
    );
}
