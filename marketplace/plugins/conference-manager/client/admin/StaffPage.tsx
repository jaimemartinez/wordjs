// @ts-nocheck
"use client";

/**
 * «Equipo y permisos» (2.15.0) — administrators only.
 *
 * - Roles: customizable roles («Cocina», «Tesorería», «Recepción»…) with one level per section, edited as a
 *   sections × levels matrix (one radio group per section, only the levels that section accepts).
 * - Miembros: WordJS users added to the team with a role — searched by name / e-mail / login through the
 *   plugin's users:read grant — whose role can be changed, who can be deactivated / reactivated or removed.
 *
 * People sign in with their own WordJS account at /admin and find «Congresos» in the menu; every section
 * they open is filtered by their role (see perms.tsx) and re-checked by the server on every request.
 *
 * Confirmations are inline two-step buttons (like MealsPage / MealScanner): the shared useModal dialog
 * renders at z-50, under the plugin's own overlays.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi, STAFF_SECTIONS } from "../lib/conference";
import type { StaffLevel, StaffMember, StaffRole, StaffSection, StaffUser } from "../lib/conference";
import { useTx, makeTxn } from "./MealScanner";
import { normalizePermissions, levelRank } from "./perms";

type Tab = 'roles' | 'members';
const TAB_KEY = 'conference-manager:staff.tab';

const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm';
const labelCls = 'block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1';
const btnGhost = 'px-4 py-2.5 rounded-xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = 'px-6 py-3 rounded-2xl bg-blue-600 text-white hover:bg-blue-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-500/30 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed';
const btnDanger = 'px-4 py-2.5 rounded-xl bg-rose-600 text-white hover:bg-rose-700 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50';
const card = 'bg-white rounded-3xl border border-gray-100 shadow-sm';

/** Section names and one-line descriptions (static keys so the i18n checks can see them). */
export const sectionMeta = (tx): Record<StaffSection, { name: string; desc: string; icon: string }> => ({
    dashboard: { name: tx('staff.section.dashboard', 'Resumen'), desc: tx('staff.section.dashboard.desc', 'Las cifras generales del congreso.'), icon: 'fa-chart-pie' },
    inscriptions: { name: tx('staff.section.inscriptions', 'Inscripciones'), desc: tx('staff.section.inscriptions.desc', 'Lista de participantes, alta y edición, y sus códigos de barras.'), icon: 'fa-users' },
    payments: { name: tx('staff.section.payments', 'Pagos'), desc: tx('staff.section.payments.desc', 'Pagos de las cuotas: ver, registrar, validar y rechazar.'), icon: 'fa-money-bill-wave' },
    locations: { name: tx('staff.section.locations', 'Localidades'), desc: tx('staff.section.locations.desc', 'Códigos de los encargados, cupos, plazos y revisión de su hospedaje.'), icon: 'fa-map-marker-alt' },
    lodging: { name: tx('staff.section.lodging', 'Hospedaje'), desc: tx('staff.section.lodging.desc', 'Hoteles y habitaciones, y la asignación de quién duerme dónde.'), icon: 'fa-bed' },
    transport: { name: tx('staff.section.transport', 'Transporte'), desc: tx('staff.section.transport.desc', 'Buses, pasajeros y pagos de los pasajes.'), icon: 'fa-bus' },
    accounting: { name: tx('staff.section.accounting', 'Contabilidad'), desc: tx('staff.section.accounting.desc', 'Ingresos y egresos del congreso.'), icon: 'fa-scale-balanced' },
    meals: { name: tx('staff.section.meals', 'Alimentación'), desc: tx('staff.section.meals.desc', 'Plan de comidas por localidad, ajustes por persona y reporte.'), icon: 'fa-utensils' },
    meals_delivery: { name: tx('staff.section.meals_delivery', 'Entrega de comidas'), desc: tx('staff.section.meals_delivery.desc', 'Registrar entregas con el escáner o por nombre (la cocina).'), icon: 'fa-barcode' },
    reports: { name: tx('staff.section.reports', 'Reportes'), desc: tx('staff.section.reports.desc', 'Reportes y exportaciones a Excel y CSV.'), icon: 'fa-file-lines' },
    settings: { name: tx('staff.section.settings', 'Configuración'), desc: tx('staff.section.settings.desc', 'Congresos, formulario de inscripción, precios y reglas de cuota.'), icon: 'fa-gear' },
});

/** «Sin acceso» / «Ver» / «Gestionar» — «Operar» for the kitchen's delivery section. */
export const levelName = (tx, level: string, section?: string) =>
    level === 'manage'
        ? (section === 'meals_delivery' ? tx('staff.level.operate', 'Operar') : tx('staff.level.manage', 'Gestionar'))
        : level === 'view' ? tx('staff.level.view', 'Ver') : tx('staff.level.none', 'Sin acceso');

const fmtStamp = (v?: string | null) => {
    const s = String(v || '').trim();
    if (!s) return '';
    const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
    const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : s);
    return isNaN(d.getTime()) ? s : d.toLocaleDateString();
};

const Spinner = ({ label }: any) => (
    <div className="text-center py-16">
        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{label}</p>
    </div>
);

export default function StaffPage() {
    const tx = useTx();
    const [tab, setTabState] = useState<Tab>(() => {
        try { const v = localStorage.getItem(TAB_KEY); return v === 'members' ? 'members' : 'roles'; } catch { return 'roles'; }
    });
    const setTab = (v: Tab) => { setTabState(v); try { localStorage.setItem(TAB_KEY, v); } catch { /* blocked storage */ } };
    // Roles are shared by both tabs (the members' role select, the members count of each role).
    const [roles, setRoles] = useState<StaffRole[] | null>(null);
    const [sections, setSections] = useState(STAFF_SECTIONS);
    const [rolesError, setRolesError] = useState('');
    const loadRoles = useCallback(async () => {
        try {
            const r = await conferenceApi.getStaffRoles();
            setRoles(r?.roles || []);
            // The server's list wins when it sends one (same keys / levels as STAFF_SECTIONS).
            if (Array.isArray(r?.sections) && r.sections.length) {
                const known = new Map(STAFF_SECTIONS.map(s => [s.key, s]));
                setSections(r.sections.filter((s: any) => known.has(s.key)).map((s: any) => ({ key: s.key, levels: (s.levels || []).filter((l: string) => ['none', 'view', 'manage'].includes(l)) })));
            }
            setRolesError('');
        } catch (e: any) { setRolesError(e?.message || 'Error'); }
    }, []);
    useEffect(() => { loadRoles(); }, [loadRoles]);

    const tabs: [Tab, string, string][] = [
        ['roles', tx('staff.tab.roles', 'Roles'), 'fa-id-badge'],
        ['members', tx('staff.tab.members', 'Miembros'), 'fa-users'],
    ];
    return (
        <div className="space-y-6 animate-in fade-in duration-500" data-staff-page="">
            {/* Header */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-indigo-50/70 rounded-full blur-3xl pointer-events-none"></div>
                <div className="relative">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-200"><i className="fa-solid fa-user-shield" aria-hidden="true"></i></div>
                        <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-[0.2em]">{tx('staff', 'Equipo y permisos')}</span>
                    </div>
                    <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{tx('staff.title', 'Quién entra y qué puede hacer')}</h2>
                    <p className="text-xs text-gray-500 mt-1 max-w-2xl">{tx('staff.subtitle', 'Añade al equipo a usuarios de WordJS y dales un rol: cada rol dice, sección por sección, si la persona no la ve, solo la ve o puede gestionarla.')}</p>
                </div>
                <div className="relative mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/50 px-4 py-3 flex items-start gap-3" role="note">
                    <i className="fa-solid fa-circle-info text-indigo-500 mt-0.5" aria-hidden="true"></i>
                    <div className="text-xs text-indigo-900 space-y-1">
                        <p className="font-bold">{tx('staff.help.title', 'Cómo entran las personas del equipo')}</p>
                        <p>{tx('staff.help.login', 'Cada persona entra con su propia cuenta de WordJS en /admin y encuentra «Conference» en el menú.')}</p>
                        <p>{tx('staff.help.scope', 'Solo verá las secciones que permita su rol, en todos los congresos. Los administradores de WordJS siempre tienen acceso total y no necesitan estar en el equipo.')}</p>
                    </div>
                </div>
            </div>

            {/* Sub-tabs */}
            <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={tx('staff', 'Equipo y permisos')}>
                {tabs.map(([k, label, icon]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                        className={`flex items-center gap-2 px-5 py-3 rounded-2xl border-2 font-black text-[11px] uppercase tracking-widest whitespace-nowrap transition-all ${tab === k ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-100 bg-white text-gray-500 hover:border-gray-300'}`}>
                        <i className={`fa-solid ${icon}`} aria-hidden="true"></i>{label}
                    </button>
                ))}
            </div>

            {rolesError && !roles ? (
                <div className={`${card} p-8 text-center space-y-3`} role="alert">
                    <p className="text-sm font-bold text-rose-700">{rolesError}</p>
                    <button type="button" className={btnGhost} onClick={loadRoles}>{tx('staff.retry', 'Reintentar')}</button>
                </div>
            ) : !roles ? (
                <Spinner label={tx('loading', 'Cargando…')} />
            ) : tab === 'roles' ? (
                <RolesTab roles={roles} sections={sections} reload={loadRoles} onGoMembers={() => setTab('members')} />
            ) : (
                <MembersTab roles={roles} reloadRoles={loadRoles} onGoRoles={() => setTab('roles')} />
            )}
        </div>
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// ROLES
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
function RolesTab({ roles, sections, reload, onGoMembers }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const { addToast } = useToast();
    const meta = sectionMeta(tx);
    // null = closed; {} = new role; a role = editing it.
    const [editing, setEditing] = useState<any>(null);
    const [deleteAsk, setDeleteAsk] = useState<number | null>(null);
    const [deleteError, setDeleteError] = useState<{ id: number; message: string } | null>(null);
    const [busy, setBusy] = useState<number | null>(null);

    const remove = async (role: StaffRole) => {
        setBusy(role.id); setDeleteError(null);
        try {
            await conferenceApi.deleteStaffRole(role.id);
            addToast(tx('staff.role.deleted', 'Rol eliminado'), 'success');
            setDeleteAsk(null);
            reload();
        } catch (e: any) {
            // 409 while the role has members: the server's message says how many.
            setDeleteError({ id: role.id, message: e?.message || 'Error' });
            setDeleteAsk(null);
            if (e?.status === 404) reload();
        } finally { setBusy(null); }
    };

    return (
        <div className="space-y-5">
            <div className={`${card} p-5 sm:p-6 space-y-5`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h3 className="text-lg font-black text-gray-900">{tx('staff.roles.title', 'Roles del equipo')}</h3>
                        <p className="text-xs text-gray-500">{tx('staff.roles.hint', 'Un rol se aplica a todos los congresos y a todas las localidades.')}</p>
                    </div>
                    <button type="button" className={btnPrimary} onClick={() => setEditing({})} data-new-role="">
                        <i className="fa-solid fa-plus mr-1.5" aria-hidden="true"></i>{tx('staff.role.new', 'Nuevo rol')}
                    </button>
                </div>
                {roles.length === 0 ? (
                    <div className="text-center py-10 border-2 border-dashed border-gray-100 rounded-3xl">
                        <i className="fa-solid fa-id-badge text-3xl text-gray-300 mb-3" aria-hidden="true"></i>
                        <p className="text-sm font-bold text-gray-500">{tx('staff.roles.none', 'Todavía no hay roles. Crea uno para poder añadir personas al equipo.')}</p>
                    </div>
                ) : (
                    <ul className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {roles.map((role: StaffRole) => {
                            const perms = normalizePermissions(role.permissions);
                            const granted = sections.filter((s: any) => levelRank(perms[s.key]) > 0);
                            const members = Number(role.members) || 0;
                            return (
                                <li key={role.id} className="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 space-y-3" data-role-id={role.id}>
                                    <div className="flex items-start gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-white border border-gray-100 text-indigo-500 flex items-center justify-center shrink-0"><i className="fa-solid fa-id-badge" aria-hidden="true"></i></div>
                                        <div className="min-w-0 flex-1">
                                            <div className="text-base font-black text-gray-900 break-words">{role.name}</div>
                                            <button type="button" onClick={onGoMembers} className="text-[11px] font-bold text-indigo-600 hover:underline">
                                                {txn('staff.role.members', '{n} miembros', '{n} miembro', members)}
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                            <button type="button" onClick={() => { setEditing(role); setDeleteAsk(null); setDeleteError(null); }} className="p-2 text-gray-400 hover:text-blue-600" aria-label={tx('staff.role.edit.aria', 'Editar el rol {name}', { name: role.name })} title={tx('staff.role.edit', 'Editar rol')}>
                                                <i className="fa-solid fa-pen" aria-hidden="true"></i>
                                            </button>
                                            {deleteAsk !== role.id && (
                                                <button type="button" onClick={() => { setDeleteAsk(role.id); setDeleteError(null); }} className="p-2 text-gray-400 hover:text-rose-600" aria-label={tx('staff.role.delete.aria', 'Eliminar el rol {name}', { name: role.name })} title={tx('staff.role.delete', 'Eliminar rol')}>
                                                    <i className="fa-solid fa-trash" aria-hidden="true"></i>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {granted.length === 0 ? (
                                        <p className="text-xs font-semibold text-gray-400">{tx('staff.role.nothing', 'No da acceso a ninguna sección.')}</p>
                                    ) : (
                                        <div className="flex flex-wrap gap-1.5">
                                            {granted.map((s: any) => (
                                                <span key={s.key} className={`px-2 py-1 rounded-lg border text-[10px] font-black uppercase tracking-widest ${perms[s.key] === 'manage' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
                                                    <i className={`fa-solid ${meta[s.key]?.icon || 'fa-circle'} mr-1`} aria-hidden="true"></i>{meta[s.key]?.name || s.key}: {levelName(tx, perms[s.key], s.key)}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    {deleteAsk === role.id && (
                                        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-rose-50 border border-rose-100 px-3 py-2" role="alertdialog" aria-label={tx('staff.role.delete.confirm', '¿Eliminar el rol «{name}»?', { name: role.name })}>
                                            <span className="text-xs font-bold text-rose-800 flex-1">{tx('staff.role.delete.confirm', '¿Eliminar el rol «{name}»?', { name: role.name })}</span>
                                            <button type="button" disabled={busy === role.id} onClick={() => remove(role)} className={btnDanger} autoFocus>{tx('staff.role.delete', 'Eliminar rol')}</button>
                                            <button type="button" onClick={() => setDeleteAsk(null)} className={btnGhost}>{tx('cancel', 'Cancelar')}</button>
                                        </div>
                                    )}
                                    {deleteError?.id === role.id && (
                                        <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700 flex items-start gap-2" role="alert">
                                            <i className="fa-solid fa-triangle-exclamation mt-0.5" aria-hidden="true"></i>
                                            <span className="flex-1">{deleteError.message}</span>
                                            <button type="button" onClick={() => setDeleteError(null)} className="text-rose-400 hover:text-rose-700" aria-label={tx('close', 'Cerrar')}><i className="fa-solid fa-xmark" aria-hidden="true"></i></button>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
            {editing && (
                <RoleEditor role={editing.id ? editing : null} sections={sections} existing={roles}
                    onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
            )}
        </div>
    );
}

function RoleEditor({ role, sections, existing, onClose, onSaved }: any) {
    const tx = useTx();
    const { addToast } = useToast();
    const meta = sectionMeta(tx);
    const [name, setName] = useState(role?.name || '');
    const [perms, setPerms] = useState(() => normalizePermissions(role?.permissions));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    const trimmed = name.trim();
    const duplicate = !!trimmed && (existing || []).some((r: StaffRole) => r.id !== role?.id && String(r.name).trim().toLowerCase() === trimmed.toLowerCase());
    // «Gestionar todo» = each section's highest level; «Ver todo» = 'view' where it exists and 'none'
    // elsewhere (the kitchen's delivery has no read-only level, and viewing never grants operating).
    const setAll = (level: StaffLevel) => setPerms(() => {
        const next: any = {};
        for (const s of sections) next[s.key] = level === 'manage' ? s.levels[s.levels.length - 1] : (s.levels.includes(level) ? level : 'none');
        return next;
    });
    const save = async () => {
        if (!trimmed) { setError(tx('staff.role.name.required', 'Escribe un nombre para el rol.')); nameRef.current?.focus(); return; }
        if (duplicate) { setError(tx('staff.role.name.duplicate', 'Ya existe un rol con ese nombre.')); nameRef.current?.focus(); return; }
        setBusy(true); setError('');
        try {
            const body = { name: trimmed, permissions: Object.fromEntries(sections.map((s: any) => [s.key, perms[s.key] || 'none'])) };
            if (role?.id) await conferenceApi.updateStaffRole(role.id, body);
            else await conferenceApi.createStaffRole(body);
            addToast(role?.id ? tx('staff.role.saved', 'Rol actualizado') : tx('staff.role.created', 'Rol creado'), 'success');
            onSaved();
        } catch (e: any) {
            // 409 duplicate name / 400 unknown section or level / 404 deleted meanwhile: the server's words.
            setError(e?.message || 'Error');
        } finally { setBusy(false); }
    };
    const title = role?.id ? tx('staff.role.edit', 'Editar rol') : tx('staff.role.new', 'Nuevo rol');
    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onClose}>
            <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-3xl border border-gray-100 overflow-hidden max-h-[92vh] flex flex-col" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} data-role-editor="">
                <div className="bg-gray-50/50 px-6 sm:px-8 py-5 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
                    <div className="min-w-0">
                        <h3 className="font-black text-2xl italic tracking-tighter text-gray-900 break-words">{title}</h3>
                        <p className="text-xs font-semibold text-gray-500 mt-1">{tx('staff.role.editor.subtitle', 'Elige, para cada sección, si este rol no la ve, solo la ve o puede gestionarla.')}</p>
                    </div>
                    <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-2xl" aria-label={tx('close', 'Cerrar')}><i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i></button>
                </div>
                <div className="p-6 sm:p-8 space-y-5 overflow-y-auto">
                    <div className="space-y-1.5">
                        <label htmlFor="staff-role-name" className={labelCls}>{tx('staff.role.name', 'Nombre del rol')} *</label>
                        <input id="staff-role-name" ref={nameRef} className={inputCls} value={name} maxLength={80} autoFocus
                            onChange={(e) => { setName(e.target.value); setError(''); }} placeholder={tx('staff.role.name.placeholder', 'Ej.: Cocina, Tesorería, Recepción')} />
                        {duplicate && <p className="text-xs font-bold text-rose-600">{tx('staff.role.name.duplicate', 'Ya existe un rol con ese nombre.')}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest">
                        <span className="text-gray-400">{tx('staff.role.quick', 'Rápido:')}</span>
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setAll('view')}>{tx('staff.role.all.view', 'Ver todo')}</button>
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setAll('manage')}>{tx('staff.role.all.manage', 'Gestionar todo')}</button>
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setAll('none')}>{tx('staff.role.all.none', 'Quitar todo')}</button>
                    </div>
                    <div className="overflow-x-auto border border-gray-100 rounded-2xl" data-perm-matrix="">
                        <table className="w-full text-sm min-w-[560px]">
                            <thead className="bg-gray-50 text-[10px] font-black uppercase tracking-widest text-gray-500">
                                <tr>
                                    <th scope="col" className="text-left px-4 py-2.5">{tx('staff.matrix.section', 'Sección')}</th>
                                    {(['none', 'view', 'manage'] as StaffLevel[]).map((l) => (
                                        <th key={l} scope="col" className="text-center px-3 py-2.5 w-28">{levelName(tx, l)}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {sections.map((s: any) => {
                                    const m = meta[s.key] || { name: s.key, desc: '', icon: 'fa-circle' };
                                    const groupName = `staff-perm-${s.key}`;
                                    return (
                                        <tr key={s.key} data-perm-row={s.key} className={levelRank(perms[s.key]) > 0 ? 'bg-emerald-50/20' : ''}>
                                            <th scope="row" className="text-left px-4 py-3 font-normal align-top">
                                                <div id={`${groupName}-label`} className="text-sm font-black text-gray-900"><i className={`fa-solid ${m.icon} mr-1.5 text-gray-400 w-4 text-center`} aria-hidden="true"></i>{m.name}</div>
                                                <div className="text-[11px] text-gray-500 mt-0.5 leading-snug">{m.desc}</div>
                                            </th>
                                            {(['none', 'view', 'manage'] as StaffLevel[]).map((l) => (
                                                <td key={l} className="text-center px-3 py-3 align-middle">
                                                    {s.levels.includes(l) ? (
                                                        <label className="inline-flex flex-col items-center gap-1 cursor-pointer">
                                                            <input type="radio" name={groupName} value={l} checked={(perms[s.key] || 'none') === l}
                                                                onChange={() => setPerms((p) => ({ ...p, [s.key]: l }))}
                                                                className="w-5 h-5 accent-indigo-600" aria-label={`${m.name}: ${levelName(tx, l, s.key)}`} />
                                                            {l === 'manage' && s.key === 'meals_delivery' && <span className="text-[9px] font-black uppercase tracking-widest text-gray-400">{levelName(tx, l, s.key)}</span>}
                                                        </label>
                                                    ) : (
                                                        <span className="text-gray-200" aria-hidden="true">—</span>
                                                    )}
                                                </td>
                                            ))}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-[11px] text-gray-400">{tx('staff.matrix.hint', '«Ver» muestra la sección sin poder cambiar nada; «Gestionar» permite crear, editar, mover y validar. El servidor comprueba cada acción.')}</p>
                    {error && <div className="rounded-2xl border-2 border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700" role="alert">{error}</div>}
                </div>
                <div className="px-6 sm:px-8 py-4 border-t border-gray-50 bg-gray-50/30 flex flex-wrap justify-end gap-3 shrink-0">
                    <button type="button" onClick={onClose} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tx('cancel', 'Cancelar')}</button>
                    <button type="button" onClick={save} disabled={busy || !trimmed || duplicate} className={btnPrimary} data-save-role="">{busy ? tx('saving', 'Guardando…') : tx('save', 'Guardar')}</button>
                </div>
            </div>
        </div>
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// MEMBERS
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const GRANT_MESSAGE_FALLBACK = 'Para buscar usuarios, concede al plugin el permiso «users:read» en Plugins.';

function MembersTab({ roles, reloadRoles, onGoRoles }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const { addToast } = useToast();
    const [members, setMembers] = useState<StaffMember[] | null>(null);
    const [usersRead, setUsersRead] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [busy, setBusy] = useState<number | null>(null);
    const [removeAsk, setRemoveAsk] = useState<number | null>(null);
    const [filter, setFilter] = useState('');

    const load = useCallback(async () => {
        try { const r: any = await conferenceApi.getStaffMembers(); setMembers(r?.members || []); setUsersRead(r?.users_read !== false); setLoadError(''); }
        catch (e: any) { setLoadError(e?.message || 'Error'); }
    }, []);
    useEffect(() => { load(); }, [load]);
    const afterChange = () => { load(); reloadRoles(); };

    const memberIds = useMemo(() => new Set((members || []).map((m) => Number(m.user_id))), [members]);

    const update = async (m: StaffMember, data: { role_id?: number; active?: boolean }, ok: string) => {
        setBusy(m.id);
        try { await conferenceApi.updateStaffMember(m.id, data); addToast(ok, 'success'); afterChange(); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); if (e?.status === 404) afterChange(); }
        finally { setBusy(null); }
    };
    const remove = async (m: StaffMember) => {
        setBusy(m.id);
        try { await conferenceApi.removeStaffMember(m.id); addToast(tx('staff.member.removed', 'Persona quitada del equipo'), 'success'); setRemoveAsk(null); afterChange(); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); if (e?.status === 404) afterChange(); }
        finally { setBusy(null); }
    };

    const shown = useMemo(() => {
        const q = filter.trim().toLowerCase();
        const list = [...(members || [])].sort((a, b) => String(a.user?.name || '').localeCompare(String(b.user?.name || ''), undefined, { sensitivity: 'base' }));
        if (!q) return list;
        return list.filter((m) => [m.user?.name, m.user?.login, m.user?.email, m.role_name].some((v) => String(v || '').toLowerCase().includes(q)));
    }, [members, filter]);
    const memberName = (m: StaffMember) => m.user?.name || m.user?.login || tx('staff.member.unknown', 'Usuario #{id} (no disponible)', { id: m.user_id });

    return (
        <div className="space-y-5">
            <AddMember roles={roles} memberIds={memberIds} onAdded={afterChange} onGoRoles={onGoRoles} />

            <div className={`${card} p-5 sm:p-6 space-y-4`}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h3 className="text-lg font-black text-gray-900">{tx('staff.members.title', 'Personas del equipo')}</h3>
                        <p className="text-xs text-gray-500">{members ? txn('staff.members.count', '{n} personas', '{n} persona', members.length) : ''}</p>
                    </div>
                    {members && members.length > 5 && (
                        <input type="search" className={`${inputCls} md:max-w-xs`} value={filter} onChange={(e) => setFilter(e.target.value)}
                            placeholder={tx('staff.members.filter', 'Filtrar por nombre, correo o rol…')} aria-label={tx('staff.members.filter', 'Filtrar por nombre, correo o rol…')} />
                    )}
                </div>
                {members && !usersRead && (
                    <p className="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" role="note">
                        <i className="fa-solid fa-key mr-1.5" aria-hidden="true"></i>{tx('staff.members.no.users.read', 'Sin el permiso «users:read» no se pueden mostrar los nombres ni los correos de las cuentas.')}
                    </p>
                )}
                {loadError && !members ? (
                    <div className="text-center py-8 space-y-3" role="alert">
                        <p className="text-sm font-bold text-rose-700">{loadError}</p>
                        <button type="button" className={btnGhost} onClick={load}>{tx('staff.retry', 'Reintentar')}</button>
                    </div>
                ) : !members ? (
                    <Spinner label={tx('loading', 'Cargando…')} />
                ) : members.length === 0 ? (
                    <div className="text-center py-10 border-2 border-dashed border-gray-100 rounded-3xl">
                        <i className="fa-solid fa-user-group text-3xl text-gray-300 mb-3" aria-hidden="true"></i>
                        <p className="text-sm font-bold text-gray-500">{tx('staff.members.none', 'Todavía no hay nadie en el equipo. Busca un usuario arriba para añadirlo.')}</p>
                    </div>
                ) : (
                    <ul className="divide-y divide-gray-50 border border-gray-100 rounded-2xl overflow-hidden">
                        {shown.map((m) => {
                            const active = !!m.active;
                            return (
                                <li key={m.id} className={`px-4 py-3 space-y-2 ${active ? 'bg-white' : 'bg-gray-50'}`} data-member-id={m.id}>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${active ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-400'}`}><i className="fa-solid fa-user" aria-hidden="true"></i></div>
                                        <div className="min-w-[12rem] flex-1">
                                            <div className={`text-sm font-black break-words ${active ? 'text-gray-900' : 'text-gray-500'}`}>
                                                {memberName(m)}
                                                {!active && <span className="ml-2 px-2 py-0.5 rounded-lg bg-gray-200 text-gray-600 text-[9px] font-black uppercase tracking-widest align-middle">{tx('staff.member.inactive', 'Desactivado')}</span>}
                                            </div>
                                            <div className="text-xs font-semibold text-gray-500 break-all">{[m.user?.login ? `@${m.user.login}` : '', m.user?.email || ''].filter(Boolean).join(' · ')}</div>
                                            {(m.added_by || m.created_at) && (
                                                <div className="text-[10px] text-gray-400 font-semibold">
                                                    {m.added_by
                                                        ? tx('staff.member.added.by', 'Añadido por {who} el {date}', { who: m.added_by, date: fmtStamp(m.created_at) })
                                                        : tx('staff.member.added.on', 'Añadido el {date}', { date: fmtStamp(m.created_at) })}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <label className="sr-only" htmlFor={`staff-member-role-${m.id}`}>{tx('staff.member.role', 'Rol')}</label>
                                            <select id={`staff-member-role-${m.id}`} className="border-2 border-gray-100 rounded-xl px-3 py-2 bg-white focus:border-indigo-500 outline-none text-sm font-bold text-gray-800 disabled:opacity-50"
                                                value={String(m.role_id)} disabled={busy === m.id}
                                                onChange={(e) => update(m, { role_id: Number(e.target.value) }, tx('staff.member.role.changed', 'Rol cambiado'))}>
                                                {!roles.some((r: StaffRole) => Number(r.id) === Number(m.role_id)) && <option value={String(m.role_id)}>{m.role_name || `#${m.role_id}`}</option>}
                                                {roles.map((r: StaffRole) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
                                            </select>
                                            <button type="button" className={btnGhost} disabled={busy === m.id}
                                                onClick={() => update(m, { active: !active }, active ? tx('staff.member.deactivated', 'Acceso desactivado') : tx('staff.member.reactivated', 'Acceso reactivado'))}>
                                                <i className={`fa-solid ${active ? 'fa-user-slash' : 'fa-user-check'} mr-1`} aria-hidden="true"></i>
                                                {active ? tx('staff.member.deactivate', 'Desactivar') : tx('staff.member.reactivate', 'Reactivar')}
                                            </button>
                                            {removeAsk !== m.id && (
                                                <button type="button" className="p-2 text-gray-400 hover:text-rose-600 disabled:opacity-40" disabled={busy === m.id}
                                                    onClick={() => setRemoveAsk(m.id)} aria-label={tx('staff.member.remove.aria', 'Quitar a {name} del equipo', { name: memberName(m) })} title={tx('staff.member.remove', 'Quitar del equipo')}>
                                                    <i className="fa-solid fa-trash" aria-hidden="true"></i>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {removeAsk === m.id && (
                                        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-rose-50 border border-rose-100 px-3 py-2" role="alertdialog" aria-label={tx('staff.member.remove.confirm', '¿Quitar a {name} del equipo? Ya no podrá usar «Conference».', { name: memberName(m) })}>
                                            <span className="text-xs font-bold text-rose-800 flex-1">{tx('staff.member.remove.confirm', '¿Quitar a {name} del equipo? Ya no podrá usar «Conference».', { name: memberName(m) })}</span>
                                            <button type="button" disabled={busy === m.id} onClick={() => remove(m)} className={btnDanger} autoFocus>{tx('staff.member.remove', 'Quitar del equipo')}</button>
                                            <button type="button" onClick={() => setRemoveAsk(null)} className={btnGhost}>{tx('cancel', 'Cancelar')}</button>
                                        </div>
                                    )}
                                    {!active && <p className="text-[11px] font-semibold text-gray-500 pl-[3.25rem]">{tx('staff.member.inactive.hint', 'No podrá usar «Conference» hasta que lo reactives. Conserva su rol.')}</p>}
                                </li>
                            );
                        })}
                        {shown.length === 0 && <li className="px-4 py-6 text-center text-sm font-bold text-gray-500">{tx('staff.members.no.match', 'Nadie coincide con el filtro.')}</li>}
                    </ul>
                )}
            </div>
        </div>
    );
}

function AddMember({ roles, memberIds, onAdded, onGoRoles }: any) {
    const tx = useTx();
    const { addToast } = useToast();
    const [q, setQ] = useState('');
    const [roleId, setRoleId] = useState<string>('');
    const [res, setRes] = useState<StaffUser[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState('');
    // 503 = the users:read grant is missing: a standing notice, not a transient error.
    const [grantMissing, setGrantMissing] = useState('');
    const [adding, setAdding] = useState<number | null>(null);
    const [addError, setAddError] = useState('');
    const seq = useRef(0);

    // Default role: the first one (kept while it exists).
    useEffect(() => {
        if (!roles.length) { setRoleId(''); return; }
        if (!roles.some((r: StaffRole) => String(r.id) === roleId)) setRoleId(String(roles[0].id));
    }, [roles]);

    const search = useCallback(async (term: string) => {
        const my = ++seq.current;
        setLoading(true);
        try {
            const r = await conferenceApi.searchStaffUsers(term);
            if (my !== seq.current) return;
            setRes(r?.users || []); setErr(''); setGrantMissing('');
        } catch (e: any) {
            if (my !== seq.current) return;
            setRes(null);
            if (Number(e?.status) === 503) { setGrantMissing(!e?.message || e.message === GRANT_MESSAGE_FALLBACK ? tx('staff.grant.missing', GRANT_MESSAGE_FALLBACK) : e.message); setErr(''); }
            else setErr(e?.message || 'Error');
        } finally { if (my === seq.current) setLoading(false); }
    }, []);
    // Debounced: one request after typing pauses, never one per keystroke. An empty box lists the first
    // users (the server's default), which also reveals a missing users:read grant before anyone types.
    useEffect(() => {
        if (!roles.length) return;
        const term = q.trim();
        setAddError('');
        const h = setTimeout(() => search(term), term ? 300 : 0);
        return () => clearTimeout(h);
    }, [q, search, roles.length > 0]);

    const add = async (u: StaffUser) => {
        if (!roleId) return;
        setAdding(u.id); setAddError('');
        try {
            await conferenceApi.addStaffMember({ user_id: u.id, role_id: Number(roleId) });
            addToast(tx('staff.member.added', '{name} ya forma parte del equipo', { name: u.name || u.login }), 'success');
            onAdded();
        } catch (e: any) {
            // 409 already a member / 400 an administrator or an unknown role / 404 unknown user / 503 no grant.
            if (Number(e?.status) === 503) setGrantMissing(!e?.message || e.message === GRANT_MESSAGE_FALLBACK ? tx('staff.grant.missing', GRANT_MESSAGE_FALLBACK) : e.message);
            else setAddError(e?.message || 'Error');
            if (Number(e?.status) === 409) onAdded();
        } finally { setAdding(null); }
    };

    const isAdminUser = (u: StaffUser) => String(u.role || '').toLowerCase() === 'administrator';
    return (
        <div className={`${card} p-5 sm:p-6 space-y-4`} data-add-member="">
            <div>
                <h3 className="text-lg font-black text-gray-900">{tx('staff.add.title', 'Añadir una persona al equipo')}</h3>
                <p className="text-xs text-gray-500">{tx('staff.add.hint', 'Busca a un usuario de WordJS por su nombre, correo o usuario y elige su rol. Si aún no tiene cuenta, créala primero en Usuarios.')}</p>
            </div>
            {grantMissing && (
                <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800 flex items-start gap-3" role="alert" data-grant-missing="">
                    <i className="fa-solid fa-key mt-0.5" aria-hidden="true"></i>
                    <div className="space-y-1">
                        <p>{grantMissing}</p>
                        <p className="text-xs font-semibold text-amber-700">{tx('staff.grant.help', 'En Plugins › Conference Manager › Permisos, concede «users:read» (leer usuarios) y vuelve a buscar.')}</p>
                    </div>
                </div>
            )}
            {!roles.length ? (
                <div className="rounded-2xl border-2 border-dashed border-gray-100 px-4 py-6 text-center space-y-3">
                    <p className="text-sm font-bold text-gray-500">{tx('staff.add.no.roles', 'Primero crea un rol: cada persona del equipo necesita uno.')}</p>
                    <button type="button" className={btnGhost} onClick={onGoRoles}>{tx('staff.add.go.roles', 'Ir a Roles')}</button>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="md:col-span-2 space-y-1">
                            <label htmlFor="staff-user-q" className={labelCls}>{tx('staff.add.search', 'Buscar usuario')}</label>
                            <input id="staff-user-q" type="search" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
                                placeholder={tx('staff.add.search.placeholder', 'Nombre, correo o usuario…')} />
                        </div>
                        <div className="space-y-1">
                            <label htmlFor="staff-add-role" className={labelCls}>{tx('staff.add.role', 'Con el rol')}</label>
                            <select id="staff-add-role" className={inputCls} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                                {roles.map((r: StaffRole) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
                            </select>
                        </div>
                    </div>
                    {loading && <p className="text-xs font-bold text-gray-400">{tx('loading', 'Cargando…')}</p>}
                    {err && !loading && <p className="text-sm font-bold text-rose-600" role="alert">{err}</p>}
                    {addError && <p className="text-sm font-bold text-rose-600" role="alert">{addError}</p>}
                    {res && !loading && res.length === 0 && <p className="text-sm font-bold text-gray-500">{tx('staff.add.none', 'Ningún usuario coincide con la búsqueda.')}</p>}
                    {res && res.length > 0 && (
                        <ul className="divide-y divide-gray-50 border border-gray-100 rounded-2xl overflow-hidden" data-user-results="">
                            {res.map((u) => {
                                const already = memberIds.has(Number(u.id));
                                const admin = isAdminUser(u);
                                return (
                                    <li key={u.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-black text-gray-900 break-words">{u.name || u.login}</span>
                                            <span className="block text-xs font-semibold text-gray-500 break-all">{[u.login ? `@${u.login}` : '', u.email || ''].filter(Boolean).join(' · ')}</span>
                                        </span>
                                        {admin ? (
                                            <span className="text-[10px] font-black uppercase tracking-widest text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg">{tx('staff.add.is.admin', 'Administrador: ya tiene acceso total')}</span>
                                        ) : already ? (
                                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 bg-gray-100 px-2 py-1 rounded-lg">{tx('staff.add.already', 'Ya está en el equipo')}</span>
                                        ) : (
                                            <button type="button" className={btnPrimary} disabled={adding != null || !roleId} onClick={() => add(u)}
                                                aria-label={tx('staff.add.button.aria', 'Añadir a {name} con el rol {role}', { name: u.name || u.login, role: roles.find((r: StaffRole) => String(r.id) === roleId)?.name || '' })}>
                                                <i className="fa-solid fa-user-plus mr-1.5" aria-hidden="true"></i>{adding === u.id ? tx('saving', 'Guardando…') : tx('staff.add.button', 'Añadir')}
                                            </button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}
