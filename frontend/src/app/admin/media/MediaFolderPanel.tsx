"use client";

/**
 * The folder side of Admin → Media: «All files», «Not in a folder» and the folder tree with counts. Each
 * entry is a drop target for media cards (MEDIA_DRAG_TYPE — never a file upload), and folders can be
 * created (anyone who uploads), renamed, moved inside another folder and deleted (editors: the server asks
 * edit_others_posts). Deleting asks where its contents go; no file is ever deleted with a folder.
 * Folders are organisation only: moving a file never changes its URL.
 */
import { useMemo, useState } from "react";
import type { MediaFolder } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import DialogLayer from "@/components/DialogLayer";
import { Button } from "@/components/ui";
import {
    MEDIA_DRAG_TYPE, decodeDraggedIds, flattenFolders, folderSubtree, folderTree, indentedLabel,
    type FolderNode, type FolderSelection,
} from "@/lib/mediaFolders";

const fieldClass = "w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl text-sm font-medium text-gray-800 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10";
const labelClass = "text-[11px] font-black uppercase tracking-widest text-gray-500 block mb-1.5";

interface Props {
    folders: MediaFolder[];
    unfiled: number;
    total: number;
    selected: FolderSelection;
    onSelect: (s: FolderSelection) => void;
    canManage: boolean;
    onCreate: (name: string, parent: number) => Promise<void>;
    onUpdate: (id: number, data: { name?: string; parent?: number }) => Promise<void>;
    onDelete: (id: number, moveTo: number) => Promise<void>;
    onDropItems: (ids: number[], folder: number) => void;
}

type Editing =
    | { kind: "create"; parent: number }
    | { kind: "edit"; folder: MediaFolder }
    | { kind: "delete"; folder: MediaFolder }
    | null;

export default function MediaFolderPanel(props: Props) {
    const { t } = useI18n();
    const { folders, selected, onSelect, canManage } = props;
    const tree = useMemo(() => folderTree(folders), [folders]);
    const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
    const [dropTarget, setDropTarget] = useState<FolderSelection | null>(null);
    const [editing, setEditing] = useState<Editing>(null);

    const dropProps = (target: number) => ({
        onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(target);
        },
        onDragLeave: () => setDropTarget((cur) => (cur === target ? null : cur)),
        onDrop: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            const ids = decodeDraggedIds(e.dataTransfer.getData(MEDIA_DRAG_TYPE));
            if (ids.length) props.onDropItems(ids, target);
        },
    });

    const rowClass = (active: boolean, dropping: boolean) =>
        `group flex items-center gap-2 min-h-11 rounded-xl px-2 transition-colors ${dropping ? "bg-blue-100 ring-2 ring-blue-400" : active ? "bg-blue-50 text-blue-700" : "hover:bg-gray-50 text-gray-700"}`;

    const toggle = (id: number) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    const renderNode = (node: FolderNode): React.ReactNode => {
        const open = !collapsed.has(node.id);
        const active = selected === node.id;
        return (
            <li key={node.id} role="treeitem" aria-selected={active} aria-expanded={node.children.length ? open : undefined}>
                <div className={rowClass(active, dropTarget === node.id)} style={{ paddingInlineStart: `${0.5 + node.depth * 1}rem` }} {...dropProps(node.id)} data-folder-id={node.id}>
                    {node.children.length > 0 ? (
                        <button type="button" onClick={() => toggle(node.id)} className="w-6 h-6 shrink-0 flex items-center justify-center text-gray-400 hover:text-gray-700"
                            aria-label={`${open ? t("media.folders.collapse") : t("media.folders.expand")}: ${node.name}`}>
                            <i className={`fa-solid fa-chevron-${open ? "down" : "right"} text-[10px]`} aria-hidden="true"></i>
                        </button>
                    ) : <span className="w-6 shrink-0" aria-hidden="true"></span>}
                    <button type="button" onClick={() => onSelect(node.id)} className="flex-1 min-w-0 flex items-center gap-2 text-left text-sm font-bold py-2">
                        <i className={`fa-solid ${active ? "fa-folder-open" : "fa-folder"} text-amber-500`} aria-hidden="true"></i>
                        <span className="truncate" title={node.name}>{node.name}</span>
                        <span className="ml-auto text-[11px] font-black text-gray-400 tabular-nums">{node.count}</span>
                    </button>
                </div>
                {/* The selected folder's actions: under its row, so the name keeps the full width (and touch can reach them). */}
                {active && (
                    <div className="flex flex-wrap gap-1 pb-1" style={{ paddingInlineStart: `${2.25 + node.depth * 1}rem` }} data-testid="media-folder-actions">
                            <button type="button" onClick={() => setEditing({ kind: "create", parent: node.id })} className="min-h-9 px-2 rounded-lg text-xs font-bold flex items-center gap-1.5 text-gray-600 hover:text-blue-600 hover:bg-white"
                                aria-label={t("media.folders.newInside").replace("{name}", node.name)} title={t("media.folders.newInside").replace("{name}", node.name)}>
                                <i className="fa-solid fa-folder-plus text-xs" aria-hidden="true"></i>{t("media.folders.subfolder")}
                            </button>
                            {canManage && (
                                <>
                                    <button type="button" onClick={() => setEditing({ kind: "edit", folder: node })} className="min-h-9 px-2 rounded-lg text-xs font-bold flex items-center gap-1.5 text-gray-600 hover:text-blue-600 hover:bg-white"
                                        aria-label={`${t("media.folders.rename")}: ${node.name}`} title={t("media.folders.rename")}>
                                        <i className="fa-solid fa-pen text-xs" aria-hidden="true"></i>{t("media.folders.edit")}
                                    </button>
                                    <button type="button" onClick={() => setEditing({ kind: "delete", folder: node })} className="min-h-9 px-2 rounded-lg text-xs font-bold flex items-center gap-1.5 text-gray-600 hover:text-red-600 hover:bg-white"
                                        aria-label={`${t("media.folders.delete")}: ${node.name}`} title={t("media.folders.delete")}>
                                        <i className="fa-solid fa-trash-can text-xs" aria-hidden="true"></i>{t("media.folders.remove")}
                                    </button>
                                </>
                            )}
                    </div>
                )}
                {node.children.length > 0 && open && <ul role="group">{node.children.map(renderNode)}</ul>}
            </li>
        );
    };

    return (
        <nav aria-label={t("media.folders.title")} className="bg-white rounded-3xl border-2 border-gray-50 shadow-sm p-3" data-testid="media-folders">
            <div className="flex items-center justify-between px-2 pb-2">
                <h2 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{t("media.folders.title")}</h2>
                <button type="button" onClick={() => setEditing({ kind: "create", parent: 0 })} className="min-h-9 px-3 rounded-xl text-xs font-bold text-blue-600 hover:bg-blue-50 flex items-center gap-1.5">
                    <i className="fa-solid fa-folder-plus" aria-hidden="true"></i>{t("media.folders.new")}
                </button>
            </div>
            <ul role="tree" aria-label={t("media.folders.title")} className="space-y-0.5">
                <li role="treeitem" aria-selected={selected === "all"}>
                    <button type="button" onClick={() => onSelect("all")} className={`${rowClass(selected === "all", false)} w-full text-left text-sm font-bold py-2`}>
                        <i className="fa-solid fa-photo-film text-gray-400 w-6 text-center" aria-hidden="true"></i>
                        <span className="flex-1">{t("media.folders.all")}</span>
                        <span className="text-[11px] font-black text-gray-400 tabular-nums">{props.total}</span>
                    </button>
                </li>
                <li role="treeitem" aria-selected={selected === 0}>
                    <div {...dropProps(0)} className={rowClass(selected === 0, dropTarget === 0)} data-folder-id="0">
                        <button type="button" onClick={() => onSelect(0)} className="flex-1 flex items-center gap-2 text-left text-sm font-bold py-2">
                            <i className="fa-regular fa-folder text-gray-400 w-6 text-center" aria-hidden="true"></i>
                            <span className="flex-1">{t("media.folders.unfiled")}</span>
                            <span className="text-[11px] font-black text-gray-400 tabular-nums">{props.unfiled}</span>
                        </button>
                    </div>
                </li>
                {tree.map(renderNode)}
            </ul>
            {folders.length === 0 && <p className="px-2 pt-2 text-xs text-gray-500">{t("media.folders.empty")}</p>}
            <p className="px-2 pt-3 text-[11px] text-gray-500 leading-snug">{t("media.folders.urlNote")}</p>

            {editing && editing.kind !== "delete" && (
                <FolderNameDialog
                    folders={folders}
                    editing={editing}
                    canManage={canManage}
                    onClose={() => setEditing(null)}
                    onSubmit={async (name, parent) => {
                        if (editing.kind === "create") await props.onCreate(name, parent);
                        else await props.onUpdate(editing.folder.id, { name, parent });
                        setEditing(null);
                    }}
                />
            )}
            {editing && editing.kind === "delete" && (
                <DeleteFolderDialog
                    folders={folders}
                    folder={editing.folder}
                    onClose={() => setEditing(null)}
                    onConfirm={async (moveTo) => { await props.onDelete(editing.folder.id, moveTo); setEditing(null); }}
                />
            )}
        </nav>
    );
}

/** A folder picker: «no folder / top level» and every folder indented, minus the ones in `exclude`. */
export function FolderSelect({ id, folders, value, onChange, exclude, noneLabel }: {
    id: string; folders: MediaFolder[]; value: number; onChange: (v: number) => void; exclude?: Set<number>; noneLabel: string;
}) {
    const options = flattenFolders(folders).filter((f) => !exclude || !exclude.has(f.id));
    return (
        <select id={id} className={fieldClass} value={value} onChange={(e) => onChange(Number(e.target.value))}>
            <option value={0}>{noneLabel}</option>
            {options.map((f) => <option key={f.id} value={f.id}>{indentedLabel(f)}</option>)}
        </select>
    );
}

function FolderNameDialog({ folders, editing, canManage, onClose, onSubmit }: {
    folders: MediaFolder[]; editing: { kind: "create"; parent: number } | { kind: "edit"; folder: MediaFolder };
    canManage: boolean; onClose: () => void; onSubmit: (name: string, parent: number) => Promise<void>;
}) {
    const { t } = useI18n();
    const [name, setName] = useState(editing.kind === "edit" ? editing.folder.name : "");
    const [parent, setParent] = useState(editing.kind === "edit" ? editing.folder.parent : editing.parent);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const exclude = editing.kind === "edit" ? folderSubtree(folders, editing.folder.id) : undefined;
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try { await onSubmit(name.trim(), parent); }
        catch (err) { setError(err instanceof Error && err.message ? err.message : t("common.error")); }
        finally { setBusy(false); }
    };
    return (
        <DialogLayer className="flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="absolute inset-0" onClick={onClose}></div>
            <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="media-folder-dialog-title" className="relative bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 space-y-4">
                <h3 id="media-folder-dialog-title" className="text-xl font-black text-gray-900">
                    {editing.kind === "create" ? t("media.folders.new") : t("media.folders.rename")}
                </h3>
                <div>
                    <label htmlFor="media-folder-name" className={labelClass}>{t("media.folders.name")}</label>
                    <input id="media-folder-name" className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
                </div>
                {(editing.kind === "create" || canManage) && (
                    <div>
                        <label htmlFor="media-folder-parent" className={labelClass}>{t("media.folders.inside")}</label>
                        <FolderSelect id="media-folder-parent" folders={folders} value={parent} onChange={setParent} exclude={exclude} noneLabel={t("media.folders.topLevel")} />
                    </div>
                )}
                {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="submit" loading={busy} disabled={busy || !name.trim()}>{editing.kind === "create" ? t("media.folders.create") : t("media.folders.save")}</Button>
                </div>
            </form>
        </DialogLayer>
    );
}

function DeleteFolderDialog({ folders, folder, onClose, onConfirm }: {
    folders: MediaFolder[]; folder: MediaFolder; onClose: () => void; onConfirm: (moveTo: number) => Promise<void>;
}) {
    const { t } = useI18n();
    const [moveTo, setMoveTo] = useState(folder.parent);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const exclude = folderSubtree(folders, folder.id);
    const hasSubfolders = folders.some((f) => f.parent === folder.id);
    const confirm = async () => {
        setBusy(true);
        setError("");
        try { await onConfirm(moveTo); }
        catch (err) { setError(err instanceof Error && err.message ? err.message : t("common.error")); }
        finally { setBusy(false); }
    };
    return (
        <DialogLayer className="flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="absolute inset-0" onClick={onClose}></div>
            <div role="alertdialog" aria-modal="true" aria-labelledby="media-folder-delete-title" aria-describedby="media-folder-delete-help" className="relative bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 space-y-4">
                <h3 id="media-folder-delete-title" className="text-xl font-black text-gray-900">{t("media.folders.deleteTitle").replace("{name}", folder.name)}</h3>
                <p id="media-folder-delete-help" className="text-sm text-gray-600">
                    {(folder.count || hasSubfolders) ? t("media.folders.deleteHelp") : t("media.folders.deleteEmpty")}
                </p>
                {(folder.count > 0 || hasSubfolders) && (
                    <div>
                        <label htmlFor="media-folder-move-to" className={labelClass}>{t("media.folders.deleteMoveTo")}</label>
                        <FolderSelect id="media-folder-move-to" folders={folders} value={moveTo} onChange={setMoveTo} exclude={exclude} noneLabel={t("media.folders.unfiled")} />
                    </div>
                )}
                {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button variant="danger" loading={busy} disabled={busy} onClick={confirm}>{t("media.folders.delete")}</Button>
                </div>
            </div>
        </DialogLayer>
    );
}

/** «Move to…» for one or more files (the bulk bar and a file's details). */
export function MoveToFolderDialog({ folders, count, initial, onClose, onMove }: {
    folders: MediaFolder[]; count: number; initial: number; onClose: () => void; onMove: (folder: number) => Promise<void>;
}) {
    const { t } = useI18n();
    const [folder, setFolder] = useState(initial);
    const [busy, setBusy] = useState(false);
    return (
        <DialogLayer className="flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="absolute inset-0" onClick={onClose}></div>
            <div role="dialog" aria-modal="true" aria-labelledby="media-move-title" className="relative bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 space-y-4">
                <h3 id="media-move-title" className="text-xl font-black text-gray-900">{t("media.folders.moveTitle").replace("{n}", String(count))}</h3>
                <div>
                    <label htmlFor="media-move-target" className={labelClass}>{t("media.folders.folder")}</label>
                    <FolderSelect id="media-move-target" folders={folders} value={folder} onChange={setFolder} noneLabel={t("media.folders.unfiled")} />
                </div>
                <p className="text-xs text-gray-500">{t("media.folders.urlNote")}</p>
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button icon="fa-folder-tree" loading={busy} disabled={busy} onClick={async () => { setBusy(true); try { await onMove(folder); } finally { setBusy(false); } }}>
                        {t("media.folders.move")}
                    </Button>
                </div>
            </div>
        </DialogLayer>
    );
}
