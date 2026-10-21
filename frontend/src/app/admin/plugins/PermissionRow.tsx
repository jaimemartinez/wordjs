"use client";

import type { DeclaredPluginRole } from "@/lib/api";
import { permMeta, type PermissionRisk } from "@/lib/permissionMeta";
import { useI18n } from "@/contexts/I18nContext";
import DeclaredRolesList, { ROLES_TOKEN, type HeldState } from "./DeclaredRolesList";
import BreakableToken, { TOKEN_WRAP_CLASS } from "./BreakableToken";
import type { ActivationGrant } from "./grantState";

export const RISK_CLASSES: Record<PermissionRisk, string> = {
    low: 'bg-emerald-50/60 text-emerald-700 border-emerald-200/50 hover:bg-emerald-50 transition-colors',
    med: 'bg-amber-50/60 text-amber-700 border-amber-200/50 hover:bg-amber-50 transition-colors',
    high: 'bg-rose-50/60 text-rose-700 border-rose-200/50 hover:bg-rose-50 transition-colors',
};

/** A row the activation leaves OFF (grantState.ts "stays-off"): neutral, not the risk tint of a grant. */
export const STAYS_OFF_CLASSES = 'bg-slate-50 text-slate-700 border-slate-200';

/**
 * The risk badge of a permission token, in the admin's language — followed by an explicit
 * "administrator-level" badge for a grant that is as good as making the plugin an administrator
 * (permissionMeta adminEquivalent: it can take over accounts).
 */
export function RiskBadge({ risk, adminEquivalent = false }: { risk: PermissionRisk; adminEquivalent?: boolean }) {
    const { t } = useI18n();
    return (
        <>
            <span className={`text-[8px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded-full border shadow-sm ${RISK_CLASSES[risk]}`}>
                {t(`plugins.risk.${risk}`)}
            </span>
            {adminEquivalent && (
                <span data-admin-equivalent="" className="text-[8px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded-full border shadow-sm bg-rose-600 text-white border-rose-700">
                    <i className="fas fa-user-shield mr-1" aria-hidden="true" />{t('plugins.risk.adminEquivalent')}
                </span>
            )}
        </>
    );
}

/**
 * The token itself (`roles:declare`), next to its label. slate-600: it was slate-400 at 80 %, 2.1:1 on the
 * row's tint, under WCAG AA. It wraps only between its parts (render it through BreakableToken): it was
 * `break-all`, cut at any letter on a phone.
 */
export const TOKEN_CLASS = `text-[11px] font-mono text-slate-600 font-semibold ${TOKEN_WRAP_CLASS}`;
/**
 * A permission of the PERMISSIONS dialog (a toggle <button>): a grid of the title line and the switch on its
 * first row, the details (description, the plugin's reason, the declared roles) under them. Below 640 px the
 * details span both columns — the whole width of the card; in one column beside the switch they stopped
 * ~75 px short of the card's edge on an iPhone. From 640 px they stay in the first column, as before.
 */
export const PERMISSION_TOGGLE_CLASS = 'w-full grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 p-4 text-left cursor-pointer';
export const PERMISSION_DETAILS_CLASS = 'block min-w-0 col-span-2 sm:col-span-1';

/** "Plugin says:" / "WordJS note:" in front of a permission's reason (was slate-400, 2.6:1). */
export const REASON_LABEL_CLASS = 'not-italic font-bold text-slate-600';

/**
 * One permission of the ACTIVATION dialog: platform label, risk, platform description, the plugin's
 * reason and, for `roles:declare`, the roles the manifest declares.
 *
 * `activation` is what confirming does to it (grantState.ts activationGrant). A permission the plugin
 * had revoked ("stays-off") is drawn neutral and says so, with where to grant it: the dialog listed it
 * like every other one, under "By activating this plugin, you are granting it…", while the server left it
 * off. `rolesHeld` words the note under a declared role users already hold (grantState.ts rolesHeldState).
 */
export function PermissionRow({ token, reason, platformNote = false, roles, rolesHeld, activation = "grants" }: {
    token: string;
    reason?: string;
    platformNote?: boolean;
    roles?: DeclaredPluginRole[];
    rolesHeld: HeldState;
    activation?: ActivationGrant;
}) {
    const { t } = useI18n();
    const meta = permMeta(token, t);
    const staysOff = activation === "stays-off";
    return (
        <div
            className={`flex gap-3 p-4 rounded-2xl border backdrop-blur-sm transition-all duration-300 hover:shadow-sm ${staysOff ? STAYS_OFF_CLASSES : RISK_CLASSES[meta.risk]}`}
            data-permission-row={token}
            data-activation-grant={activation}
        >
            <div className="mt-0.5 shrink-0">
                <i className={`fas ${meta.icon || 'fa-key'} text-sm opacity-70`} />
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-extrabold text-sm text-slate-800">{meta.label}</span>
                    <RiskBadge risk={meta.risk} adminEquivalent={meta.adminEquivalent} />
                    <span className={TOKEN_CLASS}><BreakableToken text={token} /></span>
                </div>
                {meta.description && <p className="text-xs text-slate-600 font-medium leading-relaxed">{meta.description}</p>}
                {reason && (
                    <p className="text-xs text-slate-600 leading-relaxed mt-1.5 italic">
                        <span className={REASON_LABEL_CLASS}>{platformNote ? t('plugins.permission.wordjsNote') : t('plugins.permission.pluginSays')} </span>{reason}
                    </p>
                )}
                {token === ROLES_TOKEN && (
                    <DeclaredRolesList
                        roles={roles}
                        heading={t('plugins.declaredRoles')}
                        state={rolesHeld}
                        capabilitiesLabel={t('plugins.declaredRoles.capabilities')}
                        heldTemplate={t('plugins.declaredRoles.held')}
                        heldGrantedTemplate={t('plugins.declaredRoles.heldGranted')}
                        heldStaysOffTemplate={t('plugins.declaredRoles.heldStaysOff')}
                    />
                )}
                {staysOff && (
                    <p className="mt-2 text-[11px] font-bold text-slate-700 leading-relaxed" data-activation-stays-off="" role="note">
                        <i className="fas fa-ban mr-1.5" aria-hidden="true" />{t('plugins.activation.staysOff')}
                    </p>
                )}
            </div>
        </div>
    );
}
