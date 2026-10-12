/**
 * The conference team's WordJS role (2.16.0) — pure helpers for «Equipo y permisos» and the no-access screen.
 *
 * The plugin's manifest declares ONE WordJS role, TEAM_ROLE («Equipo de conferencia»), with only this
 * plugin's capability, TEAM_CAPABILITY: an account with that role enters the admin, its own account page and
 * this plugin — no other admin page. An administrator may also give the capability to another role (an
 * editor who also runs registrations). Only accounts whose role gives that access may join the team (the
 * server answers 400 for anyone else, and says so per account as `team_role`); the team role (Roles tab)
 * still decides which sections each member sees. Mirrors index.js (TEAM ROLE).
 */

/** The WordJS role slug the manifest declares (manifest.json › roles). */
export const TEAM_ROLE = 'conference_manager_team';
/** The capability that role grants (the admin menu entry requires it). */
export const TEAM_CAPABILITY = 'conference_manager_access';
/** Where the administrator creates the account / changes its role (core «Usuarios»). */
export const USERS_ADMIN_HREF = '/admin/users';

export type TeamCandidate = { id?: number; role?: string | null; team_role?: boolean | null };

/** Why a user cannot be added: an administrator (needs nothing), or an account whose role does not open the panel. */
export type CandidateBlock = 'admin' | 'not_team_role' | null;

export function candidateBlock(u: TeamCandidate | null | undefined): CandidateBlock {
    const role = String(u?.role || '').toLowerCase();
    if (role === 'administrator') return 'admin';
    // The server's flag wins when it sends one; older answers only carry the role.
    const team = typeof u?.team_role === 'boolean' ? u.team_role : role === TEAM_ROLE;
    return team ? null : 'not_team_role';
}

/** A team member as GET /staff/members lists it: `team_role` false = the account's role no longer opens the panel. */
export type MemberLike = { active?: boolean | number | null; team_role?: boolean | null };

/**
 * The member's account no longer has access to the panel (not the team role, nor a role with the team
 * capability): no section until it is given back. The list flags it, and the server refuses changing their
 * team role or reactivating them (deactivating / removing is fine).
 */
export const memberLacksRole = (m: MemberLike | null | undefined): boolean => !!m && m.team_role === false;

/** The answer of GET /staff/me, as far as the no-access screen cares. */
export type StaffMeLike = {
    isAdmin?: boolean;
    isStaff?: boolean;
    teamRole?: boolean;
    member?: boolean;
};

/** Why a signed-in user sees «Sin acceso» (null = they get the panel). `hasSections` = their team role opens something. */
export type NoAccessReason = 'not_team_role' | 'not_member' | 'inactive' | 'no_sections' | null;

export function noAccessReason(me: StaffMeLike | null | undefined, hasSections: boolean): NoAccessReason {
    if (!me || me.isAdmin) return null;
    if (me.isStaff) return hasSections ? null : 'no_sections';
    // A backend older than 2.16.0 sends neither flag: say what it always said (not on the team).
    if (me.teamRole === false) return 'not_team_role';
    if (me.member) return 'inactive';
    return 'not_member';
}

/** Translation key + Spanish fallback of each reason (the screen's sentence). */
export const NO_ACCESS_TEXT: Record<Exclude<NoAccessReason, null>, { key: string; fallback: string }> = {
    not_team_role: { key: 'perm.noaccess.role', fallback: 'Tu cuenta no tiene acceso a este módulo: lo da el rol «Equipo de conferencia» (o un rol con el permiso «conference_manager_access»). Pide a un administrador de WordJS que te lo asigne en Usuarios.' },
    not_member: { key: 'perm.noaccess', fallback: 'No tienes acceso a este módulo. Pide al administrador que te añada al equipo.' },
    inactive: { key: 'perm.noaccess.inactive', fallback: 'Tu acceso al equipo está desactivado. Pide al administrador que lo reactive.' },
    no_sections: { key: 'perm.noaccess.sections', fallback: 'Tu rol en el equipo no abre ninguna sección. Pide al administrador que te dé acceso a alguna.' },
};

/** Translation key + Spanish fallback of a WordJS role slug (custom roles show their slug). */
export function wordjsRoleText(role: string | null | undefined): { key: string | null; fallback: string } {
    const r = String(role || '').trim();
    switch (r) {
        case 'administrator': return { key: 'staff.wprole.administrator', fallback: 'Administrador' };
        case 'editor': return { key: 'staff.wprole.editor', fallback: 'Editor' };
        case 'author': return { key: 'staff.wprole.author', fallback: 'Autor' };
        case 'contributor': return { key: 'staff.wprole.contributor', fallback: 'Colaborador' };
        case 'subscriber': return { key: 'staff.wprole.subscriber', fallback: 'Suscriptor' };
        case TEAM_ROLE: return { key: 'staff.wprole.team', fallback: 'Equipo de conferencia' };
        default: return { key: null, fallback: r || '—' };
    }
}
