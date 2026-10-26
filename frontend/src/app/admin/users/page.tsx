"use client";

import { useEffect, useRef, useState } from "react";
import { usersApi, User, withSudoProof } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/contexts/I18nContext";
import { plural } from "@/lib/i18n";
import { PageHeader, Button, EmptyState, StatusBadge, DataTable, Pagination } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import UserFormModal from "./UserFormModal";
import DeleteUserDialog from "./DeleteUserDialog";
import { runEach } from "@/lib/bulkRun";
import { useRolesMap } from "@/lib/useRoleOptions";
import { avatarInitial } from "@/lib/avatarInitial";
import { roleDisplayName, roleNameFrom } from "@/lib/roleOptions";
import { useMfaStepUp, MfaStepUpFields } from "@/components/MfaStepUp";

const PER_PAGE = 20;

export default function UsersPage() {
    const { t } = useI18n();
    const searchParams = useSearchParams();
    const type = searchParams.get("type"); // subscribers
    const isSubscribers = type === "subscribers";
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedUser, setSelectedUser] = useState<User | "new" | null>(null);
    const [deleting, setDeleting] = useState<User | null>(null);
    const { user: me, can } = useAuth();
    // BULK ACTIONS: select rows (never your own account), then change their role or delete them.
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [bulkRole, setBulkRole] = useState("");
    const [bulkBusy, setBulkBusy] = useState(false);
    const [bulkMessage, setBulkMessage] = useState("");
    const [bulkDeleting, setBulkDeleting] = useState<User[] | null>(null);
    // Promoting accounts into a privileged role asks the administrator to confirm (password, and a code
    // with 2FA). One confirmation covers the whole batch: the server holds it briefly for this session.
    const bulkStepUp = useMfaStepUp();
    const selectable = (u: User) => !(me && me.id === u.id);
    const toggleRow = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const toggleAllRows = () => setSelected((s) => {
        const ids = users.filter(selectable).map((u) => u.id);
        return ids.every((id) => s.has(id)) ? new Set<number>() : new Set(ids);
    });
    const selectedUsers = users.filter((u) => selected.has(u.id));
    const applyBulkRole = async () => {
        if (!bulkRole || selectedUsers.length === 0) return;
        setBulkBusy(true);
        setBulkMessage("");
        // A role is not a self-service sudo field (and your own role cannot be changed at all), so the
        // self-edit proof is never added — withSudoProof states that. A PRIVILEGED role is confirmed by the
        // administrator instead: the first row tells whether the server asks for it, before the rest run.
        const stepUp = bulkStepUp.payload();
        const [firstId, ...restIds] = selectedUsers.map((u) => u.id);
        let firstFailed: { id: number; reason: string } | null = null;
        try {
            await usersApi.update(firstId, { ...withSudoProof({}, { role: bulkRole, email: undefined }, null), ...stepUp });
        } catch (e) {
            if (bulkStepUp.absorb(e)) { setBulkBusy(false); return; }
            firstFailed = { id: firstId, reason: e instanceof Error && e.message ? e.message : String(e) };
        }
        const result = await runEach(restIds, (id) => usersApi.update(id, { ...withSudoProof({}, { role: bulkRole, email: undefined }, null), ...stepUp }));
        if (firstFailed) result.failed.unshift(firstFailed); else result.done.unshift(firstId);
        bulkStepUp.reset();
        setBulkBusy(false);
        setBulkMessage(result.failed.length
            ? `${t("users.bulk.roleFailed").replace("{n}", String(result.failed.length))} ${result.failed[0].reason}`
            : t("users.bulk.roleDone").replace("{n}", String(result.done.length)));
        setSelected(new Set());
        loadUsers();
    };
    // PAGED, SEARCHED AND FILTERED ON THE SERVER. The list used to be usersApi.list() — the server's
    // first page of 10 — filtered in the browser, so every account past the tenth was unreachable and
    // the count said "10" on a site with hundreds of subscribers.
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [roleFilter, setRoleFilter] = useState("");
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Role names for the Role column (GET /roles; null for a non-administrator, who sees core names / slugs).
    const roles = useRolesMap();

    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 400);
        return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [searchInput]);

    // Switching between Team and Subscribers starts over.
    useEffect(() => { setPage(1); setRoleFilter(""); setSearchInput(""); setSearch(""); }, [type]);

    useEffect(() => {
        loadUsers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, page, search, roleFilter]);

    const loadUsers = async () => {
        setLoading(true);
        setSelected(new Set());
        try {
            const res = await usersApi.listPaged(type === "subscribers"
                ? { page, perPage: PER_PAGE, search: search || undefined, role: "subscriber" }
                : { page, perPage: PER_PAGE, search: search || undefined, ...(roleFilter ? { role: roleFilter } : { excludeRole: "subscriber" }) });
            setUsers(res.data);
            setTotal(res.total);
            setTotalPages(res.totalPages || 1);
            if (res.totalPages && page > res.totalPages) setPage(res.totalPages);
        } catch (error) {
            console.error("Failed to load users:", error);
        } finally {
            setLoading(false);
        }
    };

    // Team roles to filter by: every role the site has except "subscriber" (that list is its own screen).
    const roleOptions = roles ? Object.entries(roles).filter(([slug]) => slug !== "subscriber") : [];
    const filtered = !!search || !!roleFilter;

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">

            <PageHeader
                title={type === "subscribers" ? t('users.subscribers') : t('users.team.members')}
                subtitle={plural(t, type === "subscribers" ? "users.count.subscribers" : "users.count.team", total).replace("{n}", String(total))}
                actions={
                    <Button icon="fa-plus" onClick={() => setSelectedUser("new")}>{t(isSubscribers ? 'users.newSubscriber' : 'users.new')}</Button>
                }
            />

            <div className="bg-white rounded-3xl md:rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                <div className="px-4 sm:px-8 pt-5 pb-4 flex flex-wrap items-center gap-3 border-b border-gray-100/50 bg-gray-50/30">
                    <div className="relative w-full sm:w-auto sm:flex-1 sm:min-w-[220px] sm:max-w-sm">
                        <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                        <input
                            type="search"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            placeholder={t('users.search')}
                            aria-label={t('users.search')}
                            className="w-full h-11 pl-10 pr-4 rounded-xl border border-gray-200 bg-white text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                        />
                    </div>
                    {type !== "subscribers" && roleOptions.length > 0 && (
                        <select
                            value={roleFilter}
                            onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
                            aria-label={t('users.filter.role')}
                            className="h-11 px-3 rounded-xl border border-gray-200 bg-white text-sm"
                        >
                            <option value="">{t('users.filter.allRoles')}</option>
                            {roleOptions.map(([slug]) => (
                                <option key={slug} value={slug}>{roleDisplayName({ role: slug, roleName: roleNameFrom(roles, slug) }, t)}</option>
                            ))}
                        </select>
                    )}
                    <span className="ml-auto text-[11px] font-black text-gray-500 uppercase tracking-widest" aria-live="polite">{total} {t('table.total')}</span>
                </div>
                {selected.size > 0 && can('edit_users') && (
                    <div className="px-4 sm:px-8 py-3 bg-blue-50/60 border-b border-blue-100 flex flex-wrap items-center gap-3" data-testid="users-bulk-bar">
                        <span className="text-xs font-bold text-blue-700">{selected.size} {t('table.selected')}</span>
                        {roles && (
                            <>
                                <label htmlFor="users-bulk-role" className="sr-only">{t("users.bulk.changeRole")}</label>
                                <select id="users-bulk-role" value={bulkRole} onChange={(e) => setBulkRole(e.target.value)}
                                    className="min-h-11 px-3 rounded-lg border border-gray-200 bg-white text-xs font-bold text-gray-700">
                                    <option value="">{t("users.bulk.changeRole")}</option>
                                    {Object.keys(roles).map((slug) => (
                                        <option key={slug} value={slug}>{roleDisplayName({ role: slug, roleName: roleNameFrom(roles, slug) }, t)}</option>
                                    ))}
                                </select>
                                <button type="button" onClick={applyBulkRole} disabled={!bulkRole || bulkBusy}
                                    className="min-h-11 px-4 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 disabled:opacity-50">
                                    {t("users.bulk.apply")}
                                </button>
                                {(bulkStepUp.needsPassword || bulkStepUp.needsCode) && (
                                    <div className="w-full max-w-sm"><MfaStepUpFields stepUp={bulkStepUp} /></div>
                                )}
                            </>
                        )}
                        {can('delete_users') && (
                            <button type="button" onClick={() => setBulkDeleting(selectedUsers)} disabled={bulkBusy}
                                className="min-h-11 px-4 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-50">
                                <i className="fa-solid fa-trash mr-1.5" aria-hidden="true"></i>{t("delete")}
                            </button>
                        )}
                        <button type="button" onClick={() => setSelected(new Set())} className="min-h-11 px-3 text-xs font-bold text-gray-500 hover:text-gray-700">{t('table.clear')}</button>
                    </div>
                )}
                {bulkMessage && <p role="status" className="px-4 sm:px-8 py-2 text-xs text-gray-600 border-b border-gray-100">{bulkMessage}</p>}
                {loading ? (
                    <div className="p-20 text-center" role="status">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" aria-hidden="true"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                    </div>
                ) : users.length === 0 ? (
                    <EmptyState
                        icon={filtered ? "fa-filter" : (isSubscribers ? "fa-user-group" : "fa-users")}
                        title={filtered ? (t('no.results') || 'Nothing matches your filters.') : (isSubscribers ? t('users.subscribers.empty.title') : (t('users.not.found') || "No users found"))}
                        description={filtered ? '' : t(isSubscribers ? 'users.subscribers.empty.description' : 'users.empty.description')}
                        action={filtered ? (
                            <Button variant="secondary" icon="fa-filter-circle-xmark" onClick={() => { setSearchInput(''); setSearch(''); setRoleFilter(''); setPage(1); }}>
                                {t('table.clearFilters')}
                            </Button>
                        ) : (
                            <Button icon="fa-plus" onClick={() => setSelectedUser("new")}>{t(isSubscribers ? 'users.newSubscriber' : 'users.new')}</Button>
                        )}
                    />
                ) : (
                    <DataTable
                        rows={users}
                        rowKey={(u) => u.id}
                        selection={can('edit_users') || can('delete_users') ? { selected, onToggle: (id: number) => { const row = users.find((u) => u.id === id); if (row && selectable(row)) toggleRow(id); }, onToggleAll: toggleAllRows, allLabel: t('table.selectAll') } : undefined}
                        caption={type === "subscribers" ? t('users.subscribers') : t('users.team.members')}
                        rowLabel={(u) => u.displayName || u.username}
                        actionsLabel={t('actions')}
                        columns={[
                            {
                                key: "user",
                                header: t('users.title'),
                                primary: true,
                                cell: (user) => (
                                    <div className="flex items-center gap-4">
                                        {user.avatarUrl ? (
                                            // eslint-disable-next-line @next/next/no-img-element -- the user's 256px WebP
                                            <img src={user.avatarUrl} alt="" aria-hidden="true" className="w-11 h-11 md:w-12 md:h-12 shrink-0 rounded-2xl object-cover shadow-lg shadow-indigo-200" />
                                        ) : (
                                            <div className="w-11 h-11 md:w-12 md:h-12 shrink-0 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-indigo-200" aria-hidden="true">
                                                {avatarInitial(user.displayName, user.username)}
                                            </div>
                                        )}
                                        <div className="min-w-0">
                                            <button type="button" onClick={() => setSelectedUser(user)} className="text-left pointer-coarse:min-h-11">
                                                <span className="text-base md:text-lg font-bold text-gray-700 hover:text-blue-600 transition-colors italic tracking-tight break-words">
                                                    {user.displayName || user.username}
                                                </span>
                                            </button>
                                            <span className="text-[11px] font-bold text-gray-400 tracking-wider block break-words">
                                                @{user.username}
                                            </span>
                                        </div>
                                    </div>
                                ),
                            },
                            {
                                key: "email",
                                header: t('users.email'),
                                cell: (user) => <span className="text-sm font-bold text-gray-500 break-words">{user.email}</span>,
                            },
                            {
                                key: "role",
                                header: t('users.role'),
                                // The role's name (lib/roleOptions.ts roleDisplayName), not its slug:
                                // «conference_manager_team» for a plugin team member.
                                cell: (user) => (
                                    <StatusBadge
                                        status={user.role === "administrator" ? "success" : user.role === "editor" ? "info" : "neutral"}
                                        label={roleDisplayName({ role: user.role, roleName: roleNameFrom(roles, user.role) }, t)}
                                    />
                                ),
                            },
                        ]}
                        actions={(user) => [
                            { key: "edit", label: t('users.edit'), icon: "fa-pen", onClick: () => setSelectedUser(user), tone: "primary" },
                            // Never offered on your own row: the server refuses it ("You cannot delete yourself").
                            ...(me && me.id === user.id ? [] : [{ key: "delete", label: t('delete'), icon: "fa-trash", onClick: () => setDeleting(user), tone: "danger" as const }]),
                        ]}
                    />
                )}
                {!loading && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
            </div>

            {bulkDeleting && (
                <DeleteUserDialog
                    users={bulkDeleting}
                    currentUserId={me?.id}
                    onClose={() => setBulkDeleting(null)}
                    onDeleted={loadUsers}
                />
            )}

            {deleting && (
                <DeleteUserDialog
                    user={deleting}
                    currentUserId={me?.id}
                    onClose={() => setDeleting(null)}
                    onDeleted={loadUsers}
                />
            )}

            {selectedUser && (
                <UserFormModal
                    user={selectedUser}
                    onClose={() => setSelectedUser(null)}
                    onSuccess={loadUsers}
                />
            )}
        </div>
    );
}
