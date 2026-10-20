"use client";
/**
 * Ajustes ▸ MOVIMIENTOS — the site's motion library (presets in `wjs_ix_presets`, F9-E).
 *
 * A preset is a named motion a block in Verso can be LINKED to: the block stores the preset's id, not
 * a copy, so editing it here changes every page that uses it at once (its `rev` enters each page's CSS
 * hash, the next visit recompiles, and no page's `_puck_data` changes). That contract is unchanged;
 * this screen is the author-facing side of it:
 *
 *  - what a preset is and how to use one, in three steps;
 *  - the site's motions as cards with a LIVE preview (the real compiler, played on a sample card),
 *    a plain-language description and where each is used, with links to those pages;
 *  - templates and the motions WordJS ships, as starting points;
 *  - an editor in simple mode by default (MotionEditor), the full step/track editor behind
 *    «Advanced»;
 *  - the site-wide motion settings (policy, page transitions, the inventory of what moves).
 *
 * THE SETTING IS HOSTILE DATA, BOTH WAYS. Reading: everything goes through `parseSiteIxPresets` →
 * `normalizeIxPreset` (a corrupt catalogue is an empty list, never a broken screen). Writing: every
 * save goes through `ixPresetSave`, which normalizes again and reserves `sys:`; behind it the backend
 * validator (`SETTING_VALIDATORS.wjs_ix_presets`) is the real boundary. Only the setting's own key is
 * sent: the backend merges by key, so sending the rest would overwrite another tab's changes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, Button, EmptyState, DataTable } from "@/components/ui";
import { MotionPreview } from "@/components/motion/MotionPreview";
import { useI18n } from "@/contexts/I18nContext";
import { postsApi, settingsApi } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import {
    ixPresetDelete,
    ixPresetDuplicate,
    ixPresetSave,
    ixPresetToSpec,
    ixSpecToBody,
    parseSiteIxPresets,
    serializeSiteIxPresets,
    IX_MAX_SITE_PRESETS,
    IX_PRESETS_SETTING,
    SYS_IX_PRESETS,
    type IxCatalog,
    type IxPreset,
    type IxSpec,
} from "@/lib/verso/interactions";
import { normalizeVtStyle, type IxVtStyle } from "@/lib/verso/interactions/viewTransitions";
import { normalizeIxMotion, type IxMotionPolicy } from "@/lib/verso/interactions";
import { ixInventoryOf, type IxInventory, type IxInventoryEntry } from "@/lib/verso/interactions/inventory";
import {
    DEFAULT_SIMPLE,
    MOTION_TEMPLATES,
    describeMotion,
    editorHref,
    presetUsageByPage,
    simpleToSpec,
    type UsagePage,
} from "@/lib/motionLibrary";
import MotionEditor from "./MotionEditor";

/** Form state. `null` = no editor open. */
type Editing = { id: string | null; name: string; draft: IxSpec } | null;

const VT_SETTING = "wjs_view_transitions";
const VT_VALUES: readonly IxVtStyle[] = ["off", "fade", "slide"];
const MOTION_SETTING = "wjs_motion";
const MOTION_VALUES: readonly IxMotionPolicy[] = ["full", "calm", "off"];

const fill = (s: string, vars: Record<string, string | number>): string =>
    s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export default function InteractionPresetsPage() {
    const { t } = useI18n();
    const { confirm, alert } = useModal();
    const { addToast } = useToast();

    const [catalog, setCatalog] = useState<IxCatalog>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState<Editing>(null);
    const [error, setError] = useState<string | null>(null);
    /** The site's content (pages + posts with a layout), read once: usage and the inventory come from it. */
    const [entries, setEntries] = useState<IxInventoryEntry[] | null>(null);
    const [showSystem, setShowSystem] = useState(false);
    const editorRef = useRef<HTMLDivElement | null>(null);

    const [vt, setVt] = useState<IxVtStyle>("off");
    const [vtSaving, setVtSaving] = useState(false);
    const [motion, setMotion] = useState<IxMotionPolicy>("full");
    const [motionSaving, setMotionSaving] = useState(false);

    // Read once on mount. (The toast text is the only use of t/addToast here; re-reading the settings
    // when the language changes would only repeat the request.)
    useEffect(() => {
        const load = async () => {
            try {
                const data = (await settingsApi.get()) as Record<string, unknown> | null;
                setCatalog(parseSiteIxPresets(data?.[IX_PRESETS_SETTING]));
                setVt(normalizeVtStyle(data?.[VT_SETTING]));
                setMotion(normalizeIxMotion(data?.[MOTION_SETTING]));
            } catch (e) {
                console.error("Could not read the motion presets:", e);
                addToast(t("motion.toast.loadFailed"), "error");
            } finally {
                setLoading(false);
            }
        };
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * One pass over the content (pages and posts, the admin's own listings). Its two consumers are the
     * usage on each card and the inventory; the delete confirmation re-reads it, because another tab
     * may have linked the preset since. `null` = could not tell (a failed read, or nothing carried its
     * content): the cards then show «—», never an invented 0.
     */
    const scanContent = useCallback(async (): Promise<IxInventoryEntry[] | null> => {
        try {
            const [pages, posts] = await Promise.all([postsApi.list("page", "any"), postsApi.list("post", "any")]);
            const out: IxInventoryEntry[] = [];
            let saw = false;
            for (const post of [...pages, ...posts]) {
                const raw = post.meta?._puck_data;
                if (raw === undefined || raw === null) continue;
                saw = true;
                let data: unknown = raw;
                if (typeof raw === "string") {
                    try { data = JSON.parse(raw); } catch { continue; }
                }
                out.push({
                    id: post.id,
                    title: typeof post.title === "string" && post.title ? post.title : `#${post.id}`,
                    slug: typeof post.slug === "string" ? post.slug : "",
                    type: typeof post.type === "string" ? post.type : "page",
                    data,
                });
            }
            return saw ? out : null;
        } catch {
            return null;
        }
    }, []);

    useEffect(() => {
        let alive = true;
        void scanContent().then((e) => { if (alive) setEntries(e); });
        return () => { alive = false; };
    }, [scanContent]);

    const usage = useMemo(() => (entries ? presetUsageByPage(entries) : null), [entries]);
    // The inventory is what pages really EMIT (the real compiler, the site policy included).
    const inventory: IxInventory | null = useMemo(
        () => (entries ? ixInventoryOf(entries, { presets: { ...SYS_IX_PRESETS, ...catalog }, motion }) : null),
        [entries, catalog, motion],
    );

    const saveSiteSetting = async <V extends string>(key: string, next: V, prev: V, set: (v: V) => void, setBusy: (b: boolean) => void, ok: string) => {
        if (next === prev) return;
        set(next);
        setBusy(true);
        try {
            await settingsApi.update({ [key]: next });
            addToast(ok, "success");
        } catch (e) {
            set(prev);
            await alert(fill(t("motion.toast.saveFailed"), { message: e instanceof Error ? e.message : String(e) }));
        } finally {
            setBusy(false);
        }
    };

    const list = useMemo(
        () => Object.values(catalog).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        [catalog],
    );
    const systemList = useMemo(() => Object.values(SYS_IX_PRESETS), []);

    const persist = async (next: IxCatalog): Promise<boolean> => {
        setSaving(true);
        try {
            await settingsApi.update({ [IX_PRESETS_SETTING]: serializeSiteIxPresets(next) });
            setCatalog(next);
            return true;
        } catch (e) {
            await alert(fill(t("motion.toast.saveFailed"), { message: e instanceof Error ? e.message : String(e) }));
            return false;
        } finally {
            setSaving(false);
        }
    };

    const open = (next: Editing) => {
        setError(null);
        setEditing(next);
        // Bring the editor into view (it opens above the gallery).
        requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "start" }));
    };
    const startNew = () => open({ id: null, name: "", draft: simpleToSpec(DEFAULT_SIMPLE)! });
    const startFrom = (name: string, draft: IxSpec | undefined) => { if (draft) open({ id: null, name, draft }); };
    const startEdit = (preset: IxPreset) => open({ id: preset.id, name: preset.name, draft: ixPresetToSpec(preset) });

    const save = async () => {
        if (!editing) return;
        const body = ixSpecToBody(editing.draft);
        if (!body) {
            setError(t("motion.error.nothingAnimates"));
            return;
        }
        const result = ixPresetSave(catalog, { id: editing.id ?? undefined, name: editing.name, trigger: body.trigger, tracks: body.tracks });
        if (!result.ok) {
            setError(result.error);
            return;
        }
        if (await persist(result.catalog)) {
            const wasEdit = editing.id !== null;
            setEditing(null);
            setError(null);
            addToast(wasEdit ? t("motion.toast.saved") : t("motion.toast.created"), "success");
        }
    };

    const remove = async (preset: IxPreset) => {
        // FRESH usage at the moment of deleting (and the cards are refreshed with it).
        const fresh = await scanContent();
        if (fresh) setEntries(fresh);
        const pages = fresh ? (presetUsageByPage(fresh).get(preset.id) ?? []) : null;
        const blocks = pages ? pages.reduce((n, p) => n + p.blocks, 0) : null;
        const detail =
            pages === null
                ? t("motion.delete.unknownUse")
                : blocks === 0
                    ? t("motion.delete.unused")
                    : fill(t("motion.delete.used"), { blocks: blocks ?? 0, pages: pages.length, list: pages.slice(0, 5).map((p) => `«${p.title}»`).join(", ") + (pages.length > 5 ? "…" : "") });
        const ok = await confirm(fill(t("motion.delete.message"), { name: preset.name, detail }), t("motion.delete.title"), true);
        if (!ok) return;
        if (await persist(ixPresetDelete(catalog, preset.id))) {
            if (editing?.id === preset.id) setEditing(null);
            addToast(t("motion.toast.deleted"), "success");
        }
    };

    const duplicate = async (preset: IxPreset) => {
        const result = ixPresetDuplicate(catalog, preset.id);
        if (!result.ok) {
            await alert(result.error);
            return;
        }
        if (await persist(result.catalog)) addToast(t("motion.toast.duplicated"), "success");
    };

    const full = Object.keys(catalog).length >= IX_MAX_SITE_PRESETS;
    const segBtn = (active: boolean) =>
        `min-h-11 rounded-lg px-3 text-xs font-semibold transition-colors disabled:opacity-50 ${active ? "bg-gray-900 text-white" : "border border-gray-200 text-gray-600 hover:border-gray-400 hover:text-gray-900"}`;

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50">
            <div className="max-w-5xl mx-auto">
                <PageHeader
                    title={t("motion.title")}
                    subtitle={t("motion.subtitle")}
                    icon="fa-wand-magic-sparkles"
                    actions={<Button icon="fa-plus" disabled={full || editing !== null} onClick={startNew}>{t("motion.new")}</Button>}
                />

                {/* ── What a motion is, and how to use one — three steps ── */}
                <Card className="mb-8">
                    <h2 className="text-base font-black text-gray-900">{t("motion.intro.title")}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">{t("motion.intro.body")}</p>
                    <ol className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
                        {[1, 2, 3].map((n) => (
                            <li key={n} className="flex gap-3 rounded-2xl bg-gray-50 p-4">
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-black text-white" aria-hidden="true">{n}</span>
                                <div className="min-w-0">
                                    <p className="text-sm font-bold text-gray-900">{t(`motion.intro.step${n}.title`)}</p>
                                    <p className="mt-1 text-sm text-gray-600">{t(`motion.intro.step${n}.body`)}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                    <p className="mt-4 text-xs text-gray-500"><i className="fa-solid fa-universal-access mr-1.5" aria-hidden="true"></i>{t("motion.intro.reduced")}</p>
                </Card>

                {editing && (
                    <div ref={editorRef} className="mb-8 scroll-mt-4">
                        <MotionEditor
                            id={editing.id}
                            name={editing.name}
                            draft={editing.draft}
                            error={error}
                            saving={saving}
                            onName={(name) => setEditing({ ...editing, name })}
                            onDraft={(draft) => setEditing({ ...editing, draft })}
                            onSave={save}
                            onCancel={() => { setEditing(null); setError(null); }}
                        />
                    </div>
                )}

                {/* ── The site's motions ── */}
                <section aria-labelledby="motion-mine" className="mb-10">
                    <h2 id="motion-mine" className="mb-4 text-lg font-black text-gray-900">{t("motion.mine.title")}</h2>
                    {loading ? (
                        <Card><p className="text-sm text-gray-500" role="status">{t("loading")}</p></Card>
                    ) : list.length === 0 ? (
                        <Card padding="none">
                            <EmptyState
                                icon="fa-wand-magic-sparkles"
                                title={t("motion.empty.title")}
                                description={t("motion.empty.body")}
                                action={editing ? undefined : <Button icon="fa-plus" onClick={startNew}>{t("motion.new")}</Button>}
                            />
                        </Card>
                    ) : (
                        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {list.map((preset) => (
                                <li key={preset.id}>
                                    <PresetCard
                                        preset={preset}
                                        usage={usage === null ? null : usage.get(preset.id) ?? []}
                                        busy={saving}
                                        canDuplicate={!full}
                                        onEdit={() => startEdit(preset)}
                                        onDuplicate={() => void duplicate(preset)}
                                        onDelete={() => void remove(preset)}
                                    />
                                </li>
                            ))}
                        </ul>
                    )}
                    {full && <p className="mt-4 text-sm text-gray-500">{fill(t("motion.full"), { max: IX_MAX_SITE_PRESETS })}</p>}
                </section>

                {/* ── Start from a template ── */}
                <section aria-labelledby="motion-templates" className="mb-10">
                    <h2 id="motion-templates" className="text-lg font-black text-gray-900">{t("motion.templates.title")}</h2>
                    <p className="mt-1 mb-4 text-sm text-gray-600">{t("motion.templates.body")}</p>
                    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        {MOTION_TEMPLATES.map((tpl) => {
                            const spec = simpleToSpec(tpl.motion);
                            const label = t(tpl.labelKey);
                            return (
                                <li key={tpl.id} className="flex flex-col rounded-3xl border-2 border-gray-50 bg-white p-4 shadow-sm">
                                    <MotionPreview spec={spec} size="sm" replayLabel={fill(t("motion.preview.replayOf"), { name: label })} replayText={t("motion.preview.replayShort")} />
                                    <h3 className="mt-3 text-sm font-bold text-gray-900">{label}</h3>
                                    <p className="mt-1 flex-1 text-xs text-gray-600">{describeMotion(spec, t)}</p>
                                    <Button size="sm" variant="secondary" icon="fa-plus" className="mt-3 self-start" disabled={full || editing !== null} onClick={() => startFrom(label, spec)}>
                                        {t("motion.templates.use")}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>

                    <div className="mt-6">
                        <button
                            type="button"
                            aria-expanded={showSystem}
                            aria-controls="motion-system-list"
                            onClick={() => setShowSystem((s) => !s)}
                            className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-800"
                        >
                            <i className={`fa-solid fa-chevron-${showSystem ? "up" : "down"} text-xs`} aria-hidden="true"></i>
                            {fill(t("motion.system.toggle"), { n: systemList.length })}
                        </button>
                        {showSystem && (
                            <>
                                <p className="mt-1 mb-4 text-sm text-gray-600">{t("motion.system.body")}</p>
                                <ul id="motion-system-list" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                    {systemList.map((p) => {
                                        const spec = ixPresetToSpec(p);
                                        return (
                                            <li key={p.id} className="flex flex-col rounded-3xl border-2 border-gray-50 bg-white p-4 shadow-sm">
                                                <MotionPreview spec={spec} size="sm" replayLabel={fill(t("motion.preview.replayOf"), { name: p.name })} replayText={t("motion.preview.replayShort")} />
                                                <h3 className="mt-3 text-sm font-bold text-gray-900">{p.name}</h3>
                                                <p className="mt-1 flex-1 text-xs text-gray-600">{describeMotion(p, t)}</p>
                                                <Button size="sm" variant="secondary" icon="fa-copy" className="mt-3 self-start" disabled={full || editing !== null} onClick={() => startFrom(fill(t("motion.system.copyName"), { name: p.name }), spec)}>
                                                    {t("motion.system.copy")}
                                                </Button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </>
                        )}
                    </div>
                </section>

                {/* ── Site-wide motion settings ── */}
                <section aria-labelledby="motion-site" className="space-y-6">
                    <h2 id="motion-site" className="text-lg font-black text-gray-900">{t("motion.site.title")}</h2>

                    <Card>
                        <h3 className="text-sm font-bold text-gray-900">{t("motion.policy.title")}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-gray-600">{t("motion.policy.body")}</p>
                        <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("motion.policy.title")}>
                            {MOTION_VALUES.map((v) => (
                                <button key={v} type="button" aria-pressed={motion === v} disabled={motionSaving}
                                    onClick={() => void saveSiteSetting(MOTION_SETTING, v, motion, setMotion, setMotionSaving, t("motion.toast.policySaved"))}
                                    className={segBtn(motion === v)}>
                                    {t(`motion.policy.${v}`)}
                                </button>
                            ))}
                            {motionSaving && <span className="text-xs text-gray-500">{t("motion.saving")}</span>}
                        </div>
                        <p className="mt-3 text-sm leading-relaxed text-gray-500">{t(`motion.policy.${motion}.hint`)}</p>
                    </Card>

                    <Card>
                        <h3 className="text-sm font-bold text-gray-900">{t("motion.vt.title")}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-gray-600">{t("motion.vt.body")}</p>
                        <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("motion.vt.title")}>
                            {VT_VALUES.map((v) => (
                                <button key={v} type="button" aria-pressed={vt === v} disabled={vtSaving}
                                    onClick={() => void saveSiteSetting(VT_SETTING, v, vt, setVt, setVtSaving, v === "off" ? t("motion.toast.vtOff") : t("motion.toast.vtSaved"))}
                                    className={segBtn(vt === v)}>
                                    {t(`motion.vt.${v}`)}
                                </button>
                            ))}
                            {vtSaving && <span className="text-xs text-gray-500">{t("motion.saving")}</span>}
                        </div>
                    </Card>

                    <Card>
                        <h3 className="text-sm font-bold text-gray-900">{t("motion.inventory.title")}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-gray-600">{t("motion.inventory.body")}</p>
                        {inventory === null ? (
                            <p className="mt-4 text-sm text-gray-500" role="status">{t("motion.inventory.loading")}</p>
                        ) : inventory.rows.length === 0 ? (
                            <p className="mt-4 text-sm text-gray-500">
                                {motion === "off" ? t("motion.inventory.off") : fill(t("motion.inventory.still"), { n: inventory.totals.pages })}
                            </p>
                        ) : (
                            <>
                                <p className="mt-4 text-xs text-gray-500">
                                    {fill(t("motion.inventory.totals"), {
                                        moving: inventory.totals.moving,
                                        pages: inventory.totals.pages,
                                        blocks: inventory.totals.blocks,
                                        loops: inventory.totals.infinite,
                                        runtime: inventory.totals.runtime,
                                        entrances: inventory.totals.entrances,
                                        kb: (inventory.totals.cssBytes / 1024).toFixed(1),
                                    })}
                                </p>
                                <DataTable
                                    className="mt-3 -mx-1"
                                    rows={inventory.rows}
                                    rowKey={(row) => `${row.type}-${row.id}`}
                                    caption={t("motion.inventory.title")}
                                    rowLabel={(row) => row.title}
                                    density="compact"
                                    stackBelow="lg"
                                    columns={[
                                        {
                                            key: "page",
                                            header: t("motion.inventory.col.page"),
                                            primary: true,
                                            cell: (row) => (
                                                <span className="text-sm">
                                                    <Link href={editorHref(row)} className="inline-flex items-center pointer-coarse:min-h-11 font-medium text-gray-900 hover:underline break-words">{row.title}</Link>
                                                    <span className="ml-1 text-gray-500 break-all">/{row.slug}</span>
                                                </span>
                                            ),
                                        },
                                        {
                                            key: "blocks",
                                            header: t("motion.inventory.col.blocks"),
                                            cell: (row) => (
                                                <span className="text-xs text-gray-700">
                                                    {row.blocks}
                                                    {row.units !== row.blocks && <span className="text-gray-500"> {fill(t("motion.inventory.distinct"), { n: row.units })}</span>}
                                                </span>
                                            ),
                                        },
                                        { key: "infinite", header: t("motion.inventory.col.loops"), cell: (row) => <span className={`text-xs ${row.infinite > 0 ? "font-semibold text-gray-900" : "text-gray-400"}`}>{row.infinite || "—"}</span> },
                                        { key: "runtime", header: t("motion.inventory.col.runtime"), cell: (row) => <span className={`text-xs ${row.runtime > 0 ? "text-gray-900" : "text-gray-400"}`}>{row.runtime || "—"}</span> },
                                        // The CLASSIC entrance (`anim`) is what almost every published page
                                        // carries: without this column the inventory would call them still.
                                        { key: "entrances", header: t("motion.inventory.col.entrances"), cell: (row) => <span className={`text-xs ${row.entrances > 0 ? "text-gray-900" : "text-gray-400"}`}>{row.entrances || "—"}</span> },
                                        { key: "presets", header: t("motion.inventory.col.presets"), cell: (row) => <span className="text-xs text-gray-500 break-words">{row.presets.length > 0 ? row.presets.join(", ") : "—"}</span> },
                                        { key: "css", header: "CSS", cell: (row) => <span className="text-xs text-gray-500 whitespace-nowrap">{(row.cssBytes / 1024).toFixed(1)} KB</span> },
                                    ]}
                                />
                            </>
                        )}
                    </Card>
                </section>
            </div>
        </div>
    );
}

/** One of the site's motions: live preview, what it does, where it is used, and its actions. */
function PresetCard({ preset, usage, busy, canDuplicate, onEdit, onDuplicate, onDelete }: {
    preset: IxPreset;
    /** Pages using it; `null` = not known (the content could not be read). */
    usage: UsagePage[] | null;
    busy: boolean;
    canDuplicate: boolean;
    onEdit: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
}) {
    const { t } = useI18n();
    const [showPages, setShowPages] = useState(false);
    const spec = useMemo(() => ixPresetToSpec(preset), [preset]);
    const blocks = usage ? usage.reduce((n, p) => n + p.blocks, 0) : 0;
    const listId = `motion-usage-${preset.id}`;
    return (
        <article className="flex h-full flex-col rounded-3xl border-2 border-gray-50 bg-white p-4 shadow-xl shadow-gray-100/50">
            <MotionPreview spec={spec} replayLabel={fill(t("motion.preview.replayOf"), { name: preset.name })} replayText={t("motion.preview.replayShort")} />
            <h3 className="mt-3 text-base font-black text-gray-900 break-words">{preset.name}</h3>
            <p className="mt-1 text-sm text-gray-600">{describeMotion(preset, t)}</p>
            <div className="mt-3 text-xs text-gray-500">
                {usage === null ? (
                    <span>{t("motion.usage.unknown")}</span>
                ) : usage.length === 0 ? (
                    <span>{t("motion.usage.none")}</span>
                ) : (
                    <>
                        <button type="button" aria-expanded={showPages} aria-controls={listId} onClick={() => setShowPages((s) => !s)}
                            className="inline-flex min-h-11 sm:min-h-0 items-center gap-1.5 font-bold text-blue-600 hover:text-blue-800">
                            <i className="fa-solid fa-link text-[10px]" aria-hidden="true"></i>
                            {fill(t(blocks === 1 ? "motion.usage.oneBlock" : usage.length === 1 ? "motion.usage.onePage" : "motion.usage.pages"), { blocks, pages: usage.length })}
                            <i className={`fa-solid fa-chevron-${showPages ? "up" : "down"} text-[10px]`} aria-hidden="true"></i>
                        </button>
                        {showPages && (
                            <ul id={listId} className="mt-2 space-y-1">
                                {usage.map((p) => (
                                    <li key={`${p.type}-${p.id}`}>
                                        <Link href={editorHref(p)} className="inline-flex min-h-11 sm:min-h-0 items-center gap-1.5 text-gray-700 hover:text-blue-600 hover:underline">
                                            <i className="fa-solid fa-pen-to-square text-[10px]" aria-hidden="true"></i>
                                            {p.title} <span className="text-gray-400">({p.blocks})</span>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
                <Button size="sm" variant="primary" icon="fa-pen" disabled={busy} onClick={onEdit}>{t("motion.card.edit")}</Button>
                <Button size="sm" variant="ghost" icon="fa-copy" disabled={busy || !canDuplicate} onClick={onDuplicate} aria-label={fill(t("motion.card.duplicateOf"), { name: preset.name })}>{t("motion.card.duplicate")}</Button>
                <Button size="sm" variant="danger" icon="fa-trash" disabled={busy} onClick={onDelete} aria-label={fill(t("motion.card.deleteOf"), { name: preset.name })}>{t("motion.card.delete")}</Button>
            </div>
        </article>
    );
}
