"use client";

import { useEffect, useState } from "react";
import {
    DndContext,
    DragOverlay,
    closestCenter,
    KeyboardSensor,

    useSensor,
    useSensors,
    DragStartEvent,
    DragEndEvent,
    useDroppable,
    MouseSensor,
    TouchSensor
} from "@dnd-kit/core";
import {
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { widgetsApi, Widget, Sidebar, WidgetField } from "@/lib/api";
import { widgetIdFromInstanceKey } from "@/lib/widgetInstanceKey";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader } from "@/components/ui";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";

/*
 * The CORE sidebars and widget types (backend core/widgets registers them with English names) in the
 * panel's language, keyed by their id — never by the English text. Plugin-registered ones are shown as
 * they come. The English entries are the backend's own words, so English reads exactly as before.
 */
registerTranslations({
    es: {
        "widgets.core.sidebar.sidebar-1.name": "Barra lateral principal",
        "widgets.core.sidebar.sidebar-1.description": "Barra lateral principal que aparece a la derecha",
        "widgets.core.sidebar.footer-1.name": "Zona de widgets del pie",
        "widgets.core.sidebar.footer-1.description": "Widgets del pie de página",
        "widgets.core.widget.text.name": "Texto",
        "widgets.core.widget.text.description": "Texto o HTML libre",
        "widgets.core.widget.text.instance": "Widget de texto",
        "widgets.core.widget.recent_posts.name": "Entradas recientes",
        "widgets.core.widget.recent_posts.description": "Tus entradas más recientes",
        "widgets.core.widget.recent_posts.instance": "Widget de entradas recientes",
        "widgets.core.widget.categories.name": "Categorías",
        "widgets.core.widget.categories.description": "Una lista de categorías",
        "widgets.core.widget.categories.instance": "Widget de categorías",
        "widgets.core.widget.search.name": "Buscar",
        "widgets.core.widget.search.description": "Un formulario de búsqueda",
        "widgets.core.widget.search.instance": "Widget de búsqueda",
        "widgets.core.widget.custom_html.name": "HTML personalizado",
        "widgets.core.widget.custom_html.description": "Añade código HTML personalizado",
        "widgets.core.widget.custom_html.instance": "Widget de HTML personalizado",
        "widgets.toggleSettings": "Mostrar u ocultar los ajustes del widget",
    },
    en: {
        "widgets.core.sidebar.sidebar-1.name": "Primary Sidebar",
        "widgets.core.sidebar.sidebar-1.description": "Main sidebar that appears on the right",
        "widgets.core.sidebar.footer-1.name": "Footer Widget Area",
        "widgets.core.sidebar.footer-1.description": "Widgets in the footer",
        "widgets.core.widget.text.name": "Text",
        "widgets.core.widget.text.description": "Arbitrary text or HTML",
        "widgets.core.widget.text.instance": "Text Widget",
        "widgets.core.widget.recent_posts.name": "Recent Posts",
        "widgets.core.widget.recent_posts.description": "Your most recent posts",
        "widgets.core.widget.recent_posts.instance": "Recent_posts Widget",
        "widgets.core.widget.categories.name": "Categories",
        "widgets.core.widget.categories.description": "A list of categories",
        "widgets.core.widget.categories.instance": "Categories Widget",
        "widgets.core.widget.search.name": "Search",
        "widgets.core.widget.search.description": "A search form",
        "widgets.core.widget.search.instance": "Search Widget",
        "widgets.core.widget.custom_html.name": "Custom HTML",
        "widgets.core.widget.custom_html.description": "Add custom HTML code",
        "widgets.core.widget.custom_html.instance": "Custom_html Widget",
        "widgets.toggleSettings": "Show or hide the widget settings",
    },
    pt: {
        "widgets.core.sidebar.sidebar-1.name": "Barra lateral principal",
        "widgets.core.sidebar.sidebar-1.description": "Barra lateral principal que aparece à direita",
        "widgets.core.sidebar.footer-1.name": "Área de widgets do rodapé",
        "widgets.core.sidebar.footer-1.description": "Widgets no rodapé",
        "widgets.core.widget.text.name": "Texto",
        "widgets.core.widget.text.description": "Texto ou HTML livre",
        "widgets.core.widget.text.instance": "Widget de texto",
        "widgets.core.widget.recent_posts.name": "Posts recentes",
        "widgets.core.widget.recent_posts.description": "Seus posts mais recentes",
        "widgets.core.widget.recent_posts.instance": "Widget de posts recentes",
        "widgets.core.widget.categories.name": "Categorias",
        "widgets.core.widget.categories.description": "Uma lista de categorias",
        "widgets.core.widget.categories.instance": "Widget de categorias",
        "widgets.core.widget.search.name": "Pesquisa",
        "widgets.core.widget.search.description": "Um formulário de pesquisa",
        "widgets.core.widget.search.instance": "Widget de pesquisa",
        "widgets.core.widget.custom_html.name": "HTML personalizado",
        "widgets.core.widget.custom_html.description": "Adicione código HTML personalizado",
        "widgets.core.widget.custom_html.instance": "Widget de HTML personalizado",
        "widgets.toggleSettings": "Mostrar ou ocultar as configurações do widget",
    },
});

/** The ids backend core/widgets registers itself; anything else came from a plugin. */
const CORE_SIDEBARS = new Set(["sidebar-1", "footer-1"]);
const CORE_WIDGETS = new Set(["text", "recent_posts", "categories", "search", "custom_html"]);

/** A core sidebar's/widget's text in the panel's language; a plugin's (or an unknown key) as it came. */
function coreText(t: (key: string) => string, kind: "sidebar" | "widget", id: string, field: "name" | "description" | "instance", fallback: string): string {
    if (!(kind === "sidebar" ? CORE_SIDEBARS : CORE_WIDGETS).has(id)) return fallback;
    const key = `widgets.core.${kind}.${id}.${field}`;
    const s = t(key);
    return s === key ? fallback : s;
}

// --- Components ---

function DraggableWidget({ widget }: { widget: Widget }) {
    const { t } = useI18n();
    const { attributes, listeners, setNodeRef, transform } = useSortable({
        id: `available-${widget.id}`,
        data: { type: 'available-widget', widget }
    });

    const style = {
        transform: CSS.Translate.toString(transform),
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...listeners}
            {...attributes}
            className="p-4 bg-white border-2 border-gray-50 rounded-2xl shadow-sm mb-3 cursor-grab hover:bg-blue-50/30 hover:border-blue-100 flex justify-between items-center transition-all group"
        >
            <div>
                <span className="font-bold text-gray-900 block">{coreText(t, "widget", widget.id, "name", widget.name)}</span>
                <span className="text-xs text-gray-400 font-medium">{coreText(t, "widget", widget.id, "description", widget.description)}</span>
            </div>
            <i className="fa-solid fa-grip-vertical text-gray-300 group-hover:text-blue-400 transition-colors"></i>
        </div>
    );
}

/**
 * The settings form of one widget instance, drawn from the fields the widget declares (backend
 * core/widgets `fields`). Loads the stored settings when opened and saves them with
 * PUT /widgets/:widgetId/instances/:instanceId, which keeps only those fields, coerced and bounded.
 */
function WidgetSettingsForm({ widgetId, instanceId, fields }: { widgetId: string; instanceId: string; fields: WidgetField[] | null | undefined }) {
    const { t } = useI18n();
    const [values, setValues] = useState<Record<string, unknown> | null>(null);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<"" | "saved" | "error">("");

    useEffect(() => {
        let alive = true;
        widgetsApi.getInstance(widgetId, instanceId)
            .then((r) => { if (alive) setValues(r.settings || {}); })
            .catch(() => { if (alive) { setValues({}); setStatus("error"); } });
        return () => { alive = false; };
    }, [widgetId, instanceId]);

    if (!fields || fields.length === 0) {
        return <p className="text-sm text-gray-500" data-widget-settings="none">{t('widgets.settings.none')}</p>;
    }
    if (values === null) return <p className="text-sm text-gray-500">{t('widgets.loading')}</p>;

    const label = (f: WidgetField) => {
        const key = `widgets.field.${f.name}`;
        const translated = t(key);
        return translated === key ? f.label : translated;
    };
    const set = (name: string, v: unknown) => { setStatus(""); setValues((prev) => ({ ...(prev || {}), [name]: v })); };
    const save = async () => {
        setSaving(true);
        try {
            const r = await widgetsApi.updateInstance(widgetId, instanceId, values);
            setValues(r.settings || values);
            setStatus("saved");
        } catch {
            setStatus("error");
        } finally {
            setSaving(false);
        }
    };
    const inputClass = "w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100";

    return (
        <form className="space-y-3" data-widget-settings={widgetId} onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {fields.map((f) => {
                const id = `w-${instanceId}-${f.name}`;
                const v = values[f.name] ?? f.default;
                if (f.type === "checkbox") {
                    return (
                        <label key={f.name} htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-gray-700">
                            <input id={id} type="checkbox" checked={v === true} onChange={(e) => set(f.name, e.target.checked)} />
                            {label(f)}
                        </label>
                    );
                }
                return (
                    <div key={f.name}>
                        <label htmlFor={id} className="block text-xs font-bold text-gray-600 mb-1">{label(f)}</label>
                        {f.type === "textarea" || f.type === "html" ? (
                            <textarea id={id} rows={f.type === "html" ? 6 : 4} className={`${inputClass} ${f.type === "html" ? "font-mono text-xs" : ""}`}
                                value={v == null ? "" : String(v)} maxLength={f.max} onChange={(e) => set(f.name, e.target.value)} />
                        ) : (
                            <input id={id} type={f.type === "number" ? "number" : "text"} className={inputClass}
                                value={v == null ? "" : String(v)} min={f.min} max={f.type === "number" ? f.max : undefined}
                                maxLength={f.type === "text" ? f.max : undefined}
                                onChange={(e) => set(f.name, f.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} />
                        )}
                    </div>
                );
            })}
            <div className="flex items-center gap-3">
                <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 disabled:opacity-50">
                    {saving ? t('widgets.settings.saving') : t('widgets.settings.save')}
                </button>
                {status === "saved" && <span className="text-xs font-semibold text-emerald-700" role="status">{t('widgets.settings.saved')}</span>}
                {status === "error" && <span className="text-xs font-semibold text-rose-700" role="alert">{t('widgets.settings.saveError')}</span>}
            </div>
        </form>
    );
}

function SidebarItem({
    instanceKey,
    widgetId,
    sidebarId,
    fields,
    onRemove
}: {
    instanceKey: string,
    widgetId: string,
    sidebarId: string,
    fields: WidgetField[] | null | undefined,
    onRemove: (id: string, key: string) => void
}) {
    const { t } = useI18n();
    const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
        id: instanceKey,
        data: { type: 'sidebar-item', instanceKey, sidebarId, widgetId }
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const [isExpanded, setIsExpanded] = useState(false);
    // "<widgetId>-<instanceId>" (lib/widgetInstanceKey resolved widgetId against the registered ids).
    const instanceId = instanceKey.startsWith(`${widgetId}-`) ? instanceKey.slice(widgetId.length + 1) : instanceKey;

    // Parse widget name from ID for display (simplified)
    const displayId = widgetId.charAt(0).toUpperCase() + widgetId.slice(1);

    return (
        <div ref={setNodeRef} style={style} className="mb-3 bg-white border-2 border-gray-50 rounded-2xl shadow-sm overflow-hidden hover:border-blue-100 transition-all">
            <div className="p-4 flex justify-between items-center bg-gray-50/30 border-b border-gray-100">
                <div className="flex items-center gap-2">
                    <button type="button" className="cursor-grab w-11 h-11 shrink-0 -ml-2 flex items-center justify-center text-gray-400 hover:text-gray-600" {...listeners} {...attributes} aria-label={t('common.dragToReorder')}>
                        <i className="fa-solid fa-grip-vertical" aria-hidden="true"></i>
                    </button>
                    <span className="font-medium select-none">{coreText(t, "widget", widgetId, "instance", `${displayId} ${t('widgets.widget')}`)}</span>
                </div>
                <div className="flex gap-2">
                    <button
                        className="text-gray-500 hover:text-blue-600"
                        aria-label={t('widgets.toggleSettings')}
                        aria-expanded={isExpanded}
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsExpanded(!isExpanded);
                        }}
                    >
                        <i className={`fa-solid fa-chevron-${isExpanded ? 'up' : 'down'}`}></i>
                    </button>
                    <button
                        className="text-gray-500 hover:text-red-600"
                        aria-label={t('widgets.removeWidget')}
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove(sidebarId, instanceKey);
                        }}
                    >
                        <i className="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>

            {isExpanded && (
                <div className="p-4">
                    <WidgetSettingsForm widgetId={widgetId} instanceId={instanceId} fields={fields} />
                </div>
            )}
        </div>
    );
}

function SidebarContainer({ sidebar, widgets, onRemove }: { sidebar: Sidebar, widgets: Widget[], onRemove: (sid: string, key: string) => void }) {
    const widgetIds = widgets.map((w) => w.id);
    const { t } = useI18n();
    const { setNodeRef } = useDroppable({
        id: sidebar.id,
        data: { type: 'sidebar-container', sidebarId: sidebar.id }
    });

    return (
        <div ref={setNodeRef} className="bg-white border-2 border-gray-50 rounded-3xl md:rounded-[40px] p-6 shadow-xl shadow-gray-100/50 min-h-[100px]">
            <h3 className="font-black text-xl text-gray-900 italic tracking-tight mb-1">{coreText(t, "sidebar", sidebar.id, "name", sidebar.name)}</h3>
            <p className="text-xs text-gray-400 font-medium mb-6">{coreText(t, "sidebar", sidebar.id, "description", sidebar.description)}</p>

            <SortableContext
                items={sidebar.widgets}
                strategy={verticalListSortingStrategy}
                id={sidebar.id} // Important: Context ID matches Sidebar ID for dropping
            >
                <div className="min-h-[50px]">
                    {sidebar.widgets.length === 0 && (
                        <div className="text-center text-gray-400 py-8 border-2 border-dashed border-gray-200 rounded-2xl text-sm font-medium">
                            <i className="fa-solid fa-arrows-up-down-left-right text-2xl mb-2 block text-gray-300"></i>
                            {t('widgets.dragWidgetsHere')}
                        </div>
                    )}
                    {sidebar.widgets.map(key => {
                        // Keys are "<widgetId>-<uuid>" and widget ids may contain '-': resolve against the
                        // registered ids, as the backend's renderer does.
                        const wId = widgetIdFromInstanceKey(key, widgetIds);
                        return (
                            <SidebarItem
                                key={key}
                                instanceKey={key}
                                widgetId={wId}
                                sidebarId={sidebar.id}
                                fields={widgets.find((w) => w.id === wId)?.fields}
                                onRemove={onRemove}
                            />
                        );
                    })}
                </div>
            </SortableContext>
        </div>
    );
}

// --- Main Page ---

export default function WidgetsPage() {
    const [widgets, setWidgets] = useState<Widget[]>([]);
    const [sidebars, setSidebars] = useState<Sidebar[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const { alert, confirm } = useModal();
    const { t } = useI18n();

    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: {
                distance: 10,
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 250,
                tolerance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const [wData, sData] = await Promise.all([
                widgetsApi.listWidgets(),
                widgetsApi.listSidebars()
            ]);
            setWidgets(wData);
            setSidebars(sData);
        } catch (e) {
            console.error(e);
            await alert(t('widgets.loadError'), t('widgets.errorTitle'));
        } finally {
            setLoading(false);
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);

        if (!over) return;

        // Dropping an available widget onto a sidebar
        if (String(active.id).startsWith("available-") && !String(over.id).startsWith("available-")) {
            const widgetId = active.data.current?.widget.id;

            // Find target sidebar
            // over.id could be a sidebar ID (if empty) or an item ID instanceKey
            let targetSidebarId: string | undefined;

            // Check if over is a sidebar container
            const sidebar = sidebars.find(s => s.id === over.id);
            if (sidebar) {
                targetSidebarId = sidebar.id;
            } else {
                // Or it's over an item in the sidebar
                const overKey = String(over.id);
                // Need to find which sidebar contains this key
                targetSidebarId = sidebars.find(s => s.widgets.includes(overKey))?.id;
            }

            if (targetSidebarId && widgetId) {
                // Optimistic UI Update (or simply reload)
                // Since valid instanceKeys are generated by backend, we must call API then reload
                // Or create temp key.

                try {
                    setLoading(true); // crude flicker prevention
                    await widgetsApi.addToSidebar(targetSidebarId, widgetId);
                    await loadData(); // Reload everything to get clean new state
                } catch (e) {
                    console.error("Add failed", e);
                } finally {
                    setLoading(false);
                }
            }
        }
    };

    const handleRemove = async (sidebarId: string, instanceKey: string) => {
        if (await confirm(t('widgets.removeConfirm'), t('widgets.removeWidget'), true)) {
            try {
                await widgetsApi.removeFromSidebar(sidebarId, instanceKey);
                // Optimistic update
                setSidebars(prev => prev.map(s => {
                    if (s.id === sidebarId) {
                        return { ...s, widgets: s.widgets.filter(w => w !== instanceKey) };
                    }
                    return s;
                }));
            } catch (e) {
                console.error("Remove failed", e);
                loadData(); // Revert on error
            }
        }
    };

    if (loading && sidebars.length === 0) return <div className="p-8">{t('widgets.loading')}</div>;

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 animate-in fade-in duration-500">
            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
            >
                <PageHeader
                    title={t('widgets.title')}
                    subtitle={t('widgets.subtitle')}
                />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {/* Available Widgets Column */}
                    <div className="bg-white rounded-3xl md:rounded-[40px] p-6 border-2 border-gray-50 shadow-xl shadow-gray-100/50 h-fit">
                        <h2 className="font-black text-xl text-gray-900 italic tracking-tight mb-2">{t('widgets.availableWidgets')}</h2>
                        <p className="text-xs text-gray-400 font-medium border-b border-gray-100 pb-4 mb-4">{t('widgets.dragToAdd')}</p>
                        <div className="space-y-2">
                            {/* We treat this list as separate Draggables, NOT a SortableContext because we clone them */}
                            {widgets.map(w => (
                                <DraggableWidget key={w.id} widget={w} />
                            ))}
                        </div>
                    </div>

                    {/* Sidebars Column */}
                    <div className="md:col-span-2 space-y-6">
                        {sidebars.map(sidebar => (
                            <SidebarContainer
                                key={sidebar.id}
                                sidebar={sidebar}
                                widgets={widgets}
                                onRemove={(sid, key) => handleRemove(sid, key)}
                            />
                        ))}
                    </div>
                </div>

                <DragOverlay>
                    {activeId ? (
                        <div className="p-4 bg-white border-2 border-blue-500 rounded-2xl shadow-xl shadow-blue-200 opacity-90 w-[200px]">
                            <i className="fa-solid fa-grip-vertical text-blue-400 mr-2"></i>
                            {t('widgets.dragging')}
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
}
