"use client";

import React from "react";

import { useState, useEffect } from "react";
import MediaPickerModal from "./MediaPickerModal";
import ModernSelect from "./ModernSelect";
import { categoriesApi, themesApi, Category, apiGet } from "@/lib/api";
import { t as translate, getStoredLanguage } from "@/lib/i18n";
import { buildSrcSet, sizesForWidth, srcSetBelongsTo, rememberPickedMedia, getPickedMedia } from "@/lib/imageSrcset";


// Plugin Puck Components
import { puckPluginComponents } from "../lib/puckPluginRegistry";
import { CSSPropertiesControl } from "./puck/CSSControls";
import { blockVars, cx, unit } from "./puck/blockVars";
import SearchBarBlockIsland from "./content/SearchBarBlock";
import AccordionBlockIsland from "./content/AccordionBlock";
import TabsBlockIsland from "./content/TabsBlock";
import { HeadingBlock, TextBlock, ImageBlock, DividerBlock, ButtonBlock, SpacerBlock, SectionBlock, GridBlock, FlexRowBlock, ColumnsBlock, CardBlock, QuoteBlock, TableBlock, IconListBlock, SocialLinksBlock, StatsBlock, HTMLEmbedBlock, PricingTableBlock, TestimonialBlock, CTABannerBlock, VideoEmbedBlock, HeroBlock, PostsGridBlock, CategoryPostsBlock, AudioPlayerBlock } from "./content/blocks";
import LinkField from "./puck/LinkField";
import { withSharedBlockFields } from "./puck/VisibilityField";
import { sanitizeHTML } from "@/lib/sanitize";
import { useEditorPosts } from "@/lib/useEditorPosts";
import { formBlockFields, formBlockDefaults, FormBlockRender } from "./puck/FormBlock";
import { symbolBlockFields, symbolBlockDefaults, SymbolRender } from "./puck/SymbolBlock";

// Custom Category Field component
// Exported (junto a TemplateField/ColumnStyleAccordion/ColumnDistributionControl) para que el
// registro Verso (lib/verso/coreBlocks.tsx) reutilice EXACTAMENTE los mismos controles — una sola
// implementación, dos registros de bloques durante la convivencia Puck↔Verso.
export const CategoryField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
    const [categories, setCategories] = useState<Category[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        categoriesApi.list().then((cats) => {
            setCategories(cats);
            setLoading(false);
        }).catch(() => setLoading(false));
    }, []);

    return (
        <ModernSelect
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={loading}
            options={[
                { value: "", label: "Select Category" },
                ...categories.map((cat) => ({
                    value: cat.name,
                    label: cat.name
                }))
            ]}
            className="!py-2 !px-3 font-normal"
        />
    );
};

// Custom per-page theme-template field (the post's `_wjs_template` meta). Mirrors CategoryField:
// fetch-own-options custom root field. Options are the templates the ACTIVE theme actually ships
// (GET /themes/:slug/templates); '' = no assignment, i.e. the normal route hierarchy. A saved
// assignment naming a template the active theme no longer ships stays VISIBLE as a synthesized
// option instead of silently vanishing from the select — the author sees what's stored (the public
// route already degrades it to the hierarchy, fail-closed), and can clear it deliberately.
export const TemplateField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
    const [templates, setTemplates] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const lang = getStoredLanguage();

    useEffect(() => {
        let dead = false;
        (async () => {
            try {
                const list = await themesApi.list();
                const active = (list.find((t: any) => t.active) || list.find((t: any) => t.slug === "default"))?.slug || "default";
                const res = await themesApi.listTemplates(active);
                if (!dead) setTemplates(Array.isArray(res?.templates) ? res.templates : []);
            } catch {
                // Endpoint unreachable (or the user lacks the admin scope it requires): the select
                // degrades to just the default-hierarchy option — never blocks editing.
            }
            if (!dead) setLoading(false);
        })();
        return () => { dead = true; };
    }, []);

    const current = typeof value === "string" ? value : "";
    return (
        <ModernSelect
            value={current}
            onChange={(e) => onChange(e.target.value)}
            disabled={loading}
            options={[
                { value: "", label: translate('editor.templateField.default', lang) },
                ...templates.map((name) => ({ value: name, label: name })),
                ...(current && !templates.includes(current)
                    ? [{ value: current, label: `${current} — ${translate('editor.templateField.missing', lang)}` }]
                    : []),
            ]}
            className="!py-2 !px-3 font-normal"
        />
    );
};

// Column Style Interface
export interface ColumnStyle {
    backgroundColor?: string;
    padding?: string;
    borderWidth?: string;
    borderColor?: string;
    borderRadius?: string;
}

// Column Style Accordion - for per-column styling
export const ColumnStyleAccordion = ({ value, onChange, columnCount }: {
    value: ColumnStyle[];
    onChange: (styles: ColumnStyle[]) => void;
    columnCount: number;
}) => {
    const [openAccordion, setOpenAccordion] = useState<number | null>(null);

    // Initialize styles array based on column count
    const styles = value || Array(columnCount).fill({}).map(() => ({
        backgroundColor: 'transparent',
        padding: '16px',
        borderWidth: '0px',
        borderColor: '#e5e7eb',
        borderRadius: '0px'
    }));

    const updateColumnStyle = (index: number, property: keyof ColumnStyle, val: string) => {
        const newStyles = [...styles];
        if (!newStyles[index]) {
            newStyles[index] = {};
        }
        newStyles[index] = { ...newStyles[index], [property]: val };
        onChange(newStyles);
    };

    return (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
            {Array.from({ length: columnCount }).map((_, index) => (
                <div key={index} className="border-b border-gray-200 last:border-b-0">
                    <button
                        type="button"
                        className="w-full px-4 py-3 flex justify-between items-center bg-gray-50 hover:bg-gray-100 transition-colors"
                        onClick={() => setOpenAccordion(openAccordion === index ? null : index)}
                    >
                        <span className="font-medium text-sm">Columna {index + 1}</span>
                        <span className="text-gray-500">{openAccordion === index ? '▲' : '▼'}</span>
                    </button>
                    {openAccordion === index && (
                        <div className="p-4 space-y-3 bg-[var(--wjs-bg-surface,white)]">
                            <div>
                                <label className="block text-xs text-[var(--wjs-color-text-dim,gray)] mb-1">Color de fondo</label>
                                <div className="flex gap-2">
                                    <input
                                        type="color"
                                        value={styles[index]?.backgroundColor || '#ffffff'}
                                        onChange={(e) => updateColumnStyle(index, 'backgroundColor', e.target.value)}
                                        className="w-10 h-8 border rounded cursor-pointer"
                                    />
                                    <input
                                        type="text"
                                        value={styles[index]?.backgroundColor || 'transparent'}
                                        onChange={(e) => updateColumnStyle(index, 'backgroundColor', e.target.value)}
                                        placeholder="transparent"
                                        className="flex-1 px-2 py-1 text-sm border rounded"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs text-[var(--wjs-color-text-dim,gray)] mb-1">Padding</label>
                                <input
                                    type="text"
                                    value={styles[index]?.padding || '16px'}
                                    onChange={(e) => updateColumnStyle(index, 'padding', e.target.value)}
                                    placeholder="16px"
                                    className="w-full px-2 py-1 text-sm border rounded"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-[var(--wjs-color-text-dim,gray)] mb-1">Borde (ancho)</label>
                                <input
                                    type="text"
                                    value={styles[index]?.borderWidth || '0px'}
                                    onChange={(e) => updateColumnStyle(index, 'borderWidth', e.target.value)}
                                    placeholder="0px"
                                    className="w-full px-2 py-1 text-sm border rounded"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-[var(--wjs-color-text-dim,gray)] mb-1">Color de borde</label>
                                <div className="flex gap-2">
                                    <input
                                        type="color"
                                        value={styles[index]?.borderColor || '#e5e7eb'}
                                        onChange={(e) => updateColumnStyle(index, 'borderColor', e.target.value)}
                                        className="w-10 h-8 border rounded cursor-pointer"
                                    />
                                    <input
                                        type="text"
                                        value={styles[index]?.borderColor || '#e5e7eb'}
                                        onChange={(e) => updateColumnStyle(index, 'borderColor', e.target.value)}
                                        className="flex-1 px-2 py-1 text-sm border rounded"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs text-[var(--wjs-color-text-dim,gray)] mb-1">Radio de borde</label>
                                <input
                                    type="text"
                                    value={styles[index]?.borderRadius || '0px'}
                                    onChange={(e) => updateColumnStyle(index, 'borderRadius', e.target.value)}
                                    placeholder="0px"
                                    className="w-full px-2 py-1 text-sm border rounded"
                                />
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};

// Column Distribution Control - buttons for count + slider for widths
export interface ColumnDistribution {
    columnCount: number;
    widths: number[]; // percentages that sum to 100
}

export const ColumnDistributionControl = ({ value, onChange }: {
    value: ColumnDistribution;
    onChange: (distribution: ColumnDistribution) => void;
}) => {
    const distribution = value || { columnCount: 2, widths: [50, 50] };
    const { columnCount, widths } = distribution;

    // Colors for each column section
    const colors = ['#f97316', '#22c55e', '#3b82f6']; // orange, green, blue

    // Handle column count change
    const handleColumnCountChange = (newCount: number) => {
        let newWidths: number[];
        if (newCount === 1) {
            newWidths = [100];
        } else if (newCount === 2) {
            newWidths = [50, 50];
        } else {
            newWidths = [35, 30, 35];
        }
        onChange({ columnCount: newCount, widths: newWidths });
    };

    // Snap to increments of 5
    const snapToStep = (value: number) => Math.round(value / 5) * 5;

    // Handle slider drag - calculate new widths based on handle positions
    const handleSliderChange = (handleIndex: number, newPosition: number) => {
        const newWidths = [...widths];
        const snappedPosition = snapToStep(newPosition);

        if (columnCount === 2) {
            // Single handle - position is the first column width (min 10%, max 90%)
            newWidths[0] = Math.max(10, Math.min(90, snappedPosition));
            newWidths[1] = 100 - newWidths[0];
        } else if (columnCount === 3) {
            // Two handles - each column must be at least 10%
            if (handleIndex === 0) {
                // First handle - can't go past (second handle position - 10%)
                const maxPos = (widths[0] + widths[1]) - 10;
                newWidths[0] = Math.max(10, Math.min(snapToStep(maxPos), snappedPosition));
                newWidths[1] = (widths[0] + widths[1]) - newWidths[0];
                // Ensure middle column is at least 10%
                if (newWidths[1] < 10) {
                    newWidths[1] = 10;
                    newWidths[0] = (widths[0] + widths[1]) - 10;
                }
            } else {
                // Second handle - position from start
                const minPos = widths[0] + 10;
                const adjustedPos = Math.max(snapToStep(minPos), Math.min(90, snappedPosition));
                newWidths[1] = adjustedPos - widths[0];
                newWidths[2] = 100 - adjustedPos;
                // Ensure last column is at least 10%
                if (newWidths[2] < 10) {
                    newWidths[2] = 10;
                    newWidths[1] = 90 - widths[0];
                }
            }
        }

        onChange({ columnCount, widths: newWidths });
    };

    // Calculate handle positions for rendering
    const getHandlePositions = () => {
        if (columnCount === 2) {
            return [widths[0]];
        } else if (columnCount === 3) {
            return [widths[0], widths[0] + widths[1]];
        }
        return [];
    };

    const handlePositions = getHandlePositions();

    return (
        <div className="space-y-4">
            {/* Column count buttons */}
            <div className="flex gap-2">
                {[1, 2, 3].map((count) => (
                    <button
                        key={count}
                        type="button"
                        onClick={() => handleColumnCountChange(count)}
                        className={`flex-1 py-2 px-4 rounded-md font-medium transition-colors ${columnCount === count
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                    >
                        {count}
                    </button>
                ))}
            </div>

            {/* Distribution slider */}
            {columnCount > 1 && (
                <div className="space-y-2">
                    <div className="text-xs text-gray-500 flex justify-between">
                        {widths.map((w, i) => (
                            <span key={i}>Col {i + 1}: {Math.round(w)}%</span>
                        ))}
                    </div>

                    {/* Slider track */}
                    <div
                        className="relative h-8 rounded-full overflow-hidden cursor-pointer"
                        onMouseDown={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const position = ((e.clientX - rect.left) / rect.width) * 100;

                            // Find closest handle
                            let closestHandle = 0;
                            let minDistance = Math.abs(handlePositions[0] - position);
                            handlePositions.forEach((pos, i) => {
                                const distance = Math.abs(pos - position);
                                if (distance < minDistance) {
                                    minDistance = distance;
                                    closestHandle = i;
                                }
                            });

                            handleSliderChange(closestHandle, position);

                            // Setup drag
                            const handleDrag = (moveEvent: MouseEvent) => {
                                const newPos = ((moveEvent.clientX - rect.left) / rect.width) * 100;
                                handleSliderChange(closestHandle, newPos);
                            };

                            const handleUp = () => {
                                document.removeEventListener('mousemove', handleDrag);
                                document.removeEventListener('mouseup', handleUp);
                            };

                            document.addEventListener('mousemove', handleDrag);
                            document.addEventListener('mouseup', handleUp);
                        }}
                    >
                        {/* Colored sections */}
                        <div className="absolute inset-0 flex">
                            {widths.map((width, i) => (
                                <div
                                    key={i}
                                    style={{
                                        width: `${width}%`,
                                        backgroundColor: colors[i],
                                        opacity: 0.7
                                    }}
                                />
                            ))}
                        </div>

                        {/* Handles */}
                        {handlePositions.map((pos, i) => (
                            <div
                                key={i}
                                className="absolute top-1/2 -translate-y-1/2 w-6 h-6 bg-white border-2 border-gray-800 rounded-full shadow-md cursor-grab active:cursor-grabbing z-10"
                                style={{ left: `calc(${pos}% - 12px)` }}
                            >
                                <div className="absolute inset-2 bg-gray-800 rounded-full" />
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// Memoized Rich Text Editor - prevents re-renders when parent state changes
export const RichTextEditor = React.memo(({ value, onChange, onSave, onCancel, transparent = false, surfaceBg, surfaceColor }: {
    value: string;
    onChange: (html: string) => void;
    onSave?: (html: string) => void;
    onCancel?: () => void;
    transparent?: boolean;
    // Real backdrop + text color of the block on the canvas, so the editable area is WYSIWYG
    // (e.g. white text edits on a dark surface, not white-on-white). Read by InlineText.
    surfaceBg?: string;
    surfaceColor?: string;
}) => {
    const editorRef = React.useRef<HTMLDivElement>(null);
    const savedSelectionRef = React.useRef<Range | null>(null);
    const editorBg = surfaceBg || (transparent ? 'transparent' : '#ffffff');
    const [availableFonts, setAvailableFonts] = React.useState<any[]>([]);

    useEffect(() => {
        // Fetch fonts for the selector
        apiGet<any[]>('/fonts')
            .then(data => {
                if (Array.isArray(data)) {
                    setAvailableFonts(data);
                }
            })
            .catch(err => console.error("Failed to load fonts for Editor", err));
    }, []);

    // ... (rest of logic is same, hook deps might change)

    // Set content on mount AND when value changes if not focused
    useEffect(() => {
        if (editorRef.current && document.activeElement !== editorRef.current) {
            if (editorRef.current.innerHTML !== value) {
                editorRef.current.innerHTML = value || '';
            }
        }
    }, [value]);

    useEffect(() => {
        if (editorRef.current) {
            // Emit CSS styles (<span style="...">) instead of legacy elements: with styleWithCSS off,
            // execCommand('foreColor')/('fontName') produce <font> tags, which sanitizeHTML strips on
            // render (the allowlist has <span style> but NOT <font>) — so applied colors/fonts would
            // silently vanish on save. CSS spans survive the sanitizer.
            try {
                document.execCommand('styleWithCSS', false, 'true');
            } catch { }

            // Auto-focus on mount
            setTimeout(() => {
                editorRef.current?.focus();
            }, 50);
        }
    }, []);

    const saveSelection = () => {
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;
        const sel = win.getSelection();

        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            if (editorRef.current?.contains(range.commonAncestorContainer)) {
                savedSelectionRef.current = range.cloneRange();
            }
        }
    };

    const restoreSelection = () => {
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;

        if (savedSelectionRef.current && editorRef.current) {
            editorRef.current.focus();
            const sel = win.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(savedSelectionRef.current);
            }
        }
    };

    const execCmd = (command: string, cmdValue?: string) => {
        const doc = editorRef.current?.ownerDocument || document;

        // Ensure editor is focused first
        if (editorRef.current) {
            editorRef.current.focus();
        }

        // Restore selection if we have one
        restoreSelection();

        // Check if command is enabled
        try {
            doc.execCommand(command, false, cmdValue);

            if (editorRef.current) {
                onChange(editorRef.current.innerHTML);
            }
        } catch (err) {
            console.error(`[RichText] ERROR executing ${command}:`, err);
        }

        saveSelection();
    };

    const [fontSize, setFontSize] = React.useState(16);

    const updateFontSizeFromSelection = React.useCallback(() => {
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;
        const sel = win.getSelection();

        if (sel && sel.rangeCount > 0) {
            const node = sel.anchorNode;
            const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
            if (element) {
                const style = win.getComputedStyle(element);
                const size = parseInt(style.fontSize);
                if (size) setFontSize(size);
            }
        }
    }, []);

    const changeFontSize = (delta: number) => {
        restoreSelection();
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;
        const sel = win.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
            try {
                const anchorEl = sel.anchorNode?.parentElement;
                const computedStyle = anchorEl ? win.getComputedStyle(anchorEl) : null;
                const currentSize = parseInt(computedStyle?.fontSize || fontSize.toString()) || 16;
                const newSize = Math.max(8, currentSize + delta);

                setFontSize(newSize);

                const range = sel.getRangeAt(0);
                const contents = range.extractContents();
                const wrapper = doc.createElement('span');
                wrapper.style.fontSize = `${newSize}px`;
                wrapper.appendChild(contents);
                range.insertNode(wrapper);

                sel.removeAllRanges();
                const newRange = doc.createRange();
                newRange.selectNodeContents(wrapper);
                sel.addRange(newRange);

                if (editorRef.current) {
                    editorRef.current.focus();
                    onChange(editorRef.current.innerHTML);
                }
            } catch (e) {
                console.warn("Font size change failed", e);
            }
        }
        saveSelection();
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        // Crucial: prevent focus loss from the editor
        e.preventDefault();
        e.stopPropagation();
    };

    const ToolbarButton = ({ icon, onClick, title, active = false }: any) => (
        <button
            type="button"
            onMouseDownCapture={(e) => {
                // Stop Puck from seeing this immediately
                e.stopPropagation();
                handleMouseDown(e);
                onClick(e);
            }}
            className={`w-8 h-8 flex items-center justify-center rounded-md transition-all duration-200 ${active
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
            title={title}
        >
            <i className={`fa-solid ${icon} text-sm`}></i>
        </button>
    );

    return (
        <div
            className={`rich-text-editor-wrapper ${transparent ? 'relative' : 'border border-gray-200 rounded-xl overflow-hidden shadow-sm bg-white group focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-blue-400 transition-all duration-300'}`}
            data-editor-id="rich-text-main"
        >
            {/* Modern Toolbar */}
            <div className={`
                rich-text-toolbar flex flex-wrap items-center gap-1 p-2 border-gray-100
                ${transparent ? 'absolute -top-14 left-0 z-[100000] !pointer-events-auto bg-white backdrop-blur-md shadow-[0_10px_40px_-10px_rgba(0,0,0,0.3)] rounded-2xl border border-gray-100 w-max min-w-max whitespace-nowrap animate-in fade-in slide-in-from-bottom-2 duration-300' : 'bg-gray-50/50 border-b'}
            `}>
                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm">
                    <ToolbarButton icon="fa-bold" onClick={() => execCmd('bold')} title="Negrita" />
                    <ToolbarButton icon="fa-italic" onClick={() => execCmd('italic')} title="Cursiva" />
                    <ToolbarButton icon="fa-underline" onClick={() => execCmd('underline')} title="Subrayado" />
                </div>

                <div className="w-px h-6 bg-gray-200 mx-1"></div>

                {/* Font Family Selector */}
                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm">
                    <select
                        className="h-8 max-w-[100px] text-xs border-none bg-transparent focus:ring-0 cursor-pointer text-gray-700 font-medium"
                        onChange={(e) => execCmd('fontName', e.target.value)}
                        onMouseDown={(e) => e.stopPropagation()}
                        title="Fuente"
                        defaultValue="inherit"
                    >
                        <option value="inherit">Default</option>
                        <option value="Arial">Arial</option>
                        <option value="Times New Roman">Times</option>
                        {/* Dynamic fonts injected via state (deduped) */}
                        {Array.from(new Set(availableFonts.map((f: any) => f.family))).sort().map((family: any) => (
                            <option key={family} value={family}>{family}</option>
                        ))}
                    </select>
                </div>

                <div className="w-px h-6 bg-gray-200 mx-1"></div>

                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm items-center gap-0.5">
                    <ToolbarButton icon="fa-minus" onClick={() => changeFontSize(-2)} title="Reducir" />
                    <div className="flex items-center px-1 min-w-[32px] justify-center">
                        <span className="text-[11px] font-bold text-gray-600 leading-none">{fontSize}</span>
                        <span className="text-[9px] font-medium text-gray-400 ml-0.5 leading-none">px</span>
                    </div>
                    <ToolbarButton icon="fa-plus" onClick={() => changeFontSize(2)} title="Aumentar" />
                </div>

                <div className="w-px h-6 bg-gray-200 mx-1"></div>

                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm">
                    <div
                        className="relative w-8 h-8 flex items-center justify-center hover:bg-gray-50 rounded cursor-pointer group/color"
                        onMouseDown={(e) => {
                            // Don't preventDefault here as we need the color picker to open
                            // but do stop propagation to keep Puck away
                            e.stopPropagation();
                        }}
                    >
                        <i className="fa-solid fa-palette text-gray-500 group-hover/color:text-purple-500 transition-colors text-sm"></i>
                        <input
                            type="color"
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                            onChange={(e) => {
                                // Important: ensure the editor is focused before running the command
                                execCmd('foreColor', e.target.value);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            title="Color de texto"
                        />
                    </div>
                </div>

                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm">
                    <ToolbarButton icon="fa-align-left" onClick={() => execCmd('justifyLeft')} title="Izquierda" />
                    <ToolbarButton icon="fa-align-center" onClick={() => execCmd('justifyCenter')} title="Centro" />
                    <ToolbarButton icon="fa-align-right" onClick={() => execCmd('justifyRight')} title="Derecha" />
                </div>

                <div className="flex-1"></div>

                <div className="flex items-center gap-1 ml-2 editor-action-buttons">
                    {onCancel && (
                        <button
                            type="button"
                            onMouseDownCapture={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onCancel();
                            }}
                            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md text-xs font-semibold transition-all border border-gray-200"
                        >
                            Cancelar
                        </button>
                    )}
                    {onSave && (
                        <button
                            type="button"
                            onMouseDownCapture={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                // Read the live DOM innerHTML at save time. onInput-driven state can be
                                // stale (the editor is portaled out of React's root container, so input
                                // events bubbling through document.body never reach React's delegated
                                // listener), and preventDefault() above suppresses the onBlur flush.
                                onSave(editorRef.current ? editorRef.current.innerHTML : value);
                            }}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold shadow-sm flex items-center gap-1.5 transition-all"
                        >
                            <i className="fa-solid fa-check text-[10px]"></i>
                            Guardar
                        </button>
                    )}
                </div>
            </div>

            {/* Editor Area */}
            <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                className="rich-text-content p-4 min-h-[160px] max-h-[400px] overflow-y-auto focus:outline-none text-gray-700 leading-relaxed text-sm selection:bg-blue-100 transition-colors duration-200 !select-text cursor-text"
                style={{ backgroundColor: editorBg, color: surfaceColor }}
                onSelect={() => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onMouseUp={() => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onKeyUp={() => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onInput={(e) => {
                    saveSelection();
                    onChange(e.currentTarget.innerHTML);
                }}
                onMouseDownCapture={(e) => {
                    // Block Puck's drag/click while selecting
                    e.stopPropagation();
                }}
                onPointerDownCapture={(e) => {
                    e.stopPropagation();
                }}
                onClickCapture={(e) => {
                    e.stopPropagation();
                }}
                onBlur={(e) => {
                    saveSelection();
                    onChange(e.currentTarget.innerHTML);
                }}
                onKeyDown={(e) => {
                    e.stopPropagation();
                }}
            />
        </div>
    );
});
RichTextEditor.displayName = 'RichTextEditor';

/**
 * Post date for the dynamic blocks.
 *
 * Deliberately NOT `toLocaleDateString`: that reads the runtime's locale and timezone, which differ
 * between the server that renders the HTML and the browser that hydrates it — the classic source of
 * a hydration mismatch on any date. A fixed `DD MMM YYYY` built from the UTC parts is identical in
 * both places.
 */
const MESES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtPostDate = (raw: string): string => {
    const d = new Date(String(raw).replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? "" : "Z"));
    if (isNaN(d.getTime())) return "";
    return `${d.getUTCDate()} ${MESES_ES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** mm:ss, and a stable placeholder before metadata has loaded (SSR renders the placeholder). */
const fmtTime = (s: number): string => {
    if (!isFinite(s) || s < 0) return '--:--';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/**
 * The audio transport, drawn by US rather than by the browser.
 *
 * `<audio controls>` renders the browser's own chrome — a grey bar no stylesheet can reach — so a
 * themed player is impossible while it is in charge. The <audio> element stays (it IS the media
 * engine, and the fallback link for no-JS), but `controls` is off and every visible part is our own
 * markup behind `--wjs-audio-*` tokens.
 *
 * ACCESSIBILITY is why the scrubber is a real `<input type="range">` and not a styled div: it brings
 * keyboard seeking (arrows, Home/End, PageUp/Down) and correct screen-reader semantics for free.
 * Hand-rolled slider divs are where most custom players quietly become unusable.
 */
// AudioTransport moved to components/content/AudioTransport.tsx (the AudioPlayer block island).

/**
 * A self-hosted video that shows a POSTER first and only reveals the player on demand.
 *
 * Two reasons, one shape. Visually it matches the reference, whose video block is a poster under a
 * scrim with a play affordance and a duration chip. Practically, `preload="metadata"` fetches only
 * the container header — a few KB, enough for the duration the chip shows — so a page with three
 * videos costs three posters and three headers, not three multi-megabyte downloads.
 *
 * Once started, playback hands over to the browser's own controls: a full custom video transport
 * (fullscreen, captions, PiP, volume, keyboard) is a much larger surface to get right than an audio
 * scrubber, and the native one is already correct and accessible.
 */
// SelfHostedVideo moved to components/content/SelfHostedVideo.tsx (the VideoEmbed block's one
// client island; the block render itself lives in components/content/blocks.tsx).

// `: any` breaks the type-level self-reference introduced by the Symbol block's late-binding
// getter (`() => baseConfig.components`) — the VALUE cycle is fine (resolved lazily at render).
const baseConfig: any = {
    categories: {
        layout: translate('editor.category.layout', getStoredLanguage()),
        content: translate('editor.category.content', getStoredLanguage()),
        'Card Gallery': translate('editor.category.cardGallery', getStoredLanguage()),
        'Video Gallery': translate('editor.category.videoGallery', getStoredLanguage()),
        'Photo Carousel': translate('editor.category.photoCarousel', getStoredLanguage()),
    },
    components: {
        Heading: {
            label: translate('editor.block.heading', getStoredLanguage()),
            category: "content",
            fields: {
                title: { type: "text" },
                level: {
                    type: "select",
                    options: [
                        { label: "H1", value: "h1" },
                        { label: "H2", value: "h2" },
                        { label: "H3", value: "h3" },
                    ],
                },
                // Block-specific overrides. Left EMPTY they emit nothing, so the active theme's
                // --wjs-heading-* values apply; set them and this one heading wins. Same pattern
                // in every block below.
                color: { type: "text", label: "Color del título (vacío = tema)" },
                size: { type: "text", label: "Tamaño (p. ej. 48 o 3rem)" },
                weight: {
                    type: "select",
                    label: "Grosor",
                    options: [
                        { label: "Del tema", value: "" },
                        { label: "Normal", value: "400" },
                        { label: "Media", value: "500" },
                        { label: "Seminegrita", value: "600" },
                        { label: "Negrita", value: "700" },
                        { label: "Extranegrita", value: "800" },
                        { label: "Black", value: "900" },
                    ],
                },
                tracking: { type: "text", label: "Espaciado entre letras (p. ej. -1)" },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                title: "Heading",
                level: "h2",
                color: "",
                size: "",
                weight: "",
                tracking: "",
                elementId: "",
                css: {}
            },
            // Render lives in components/content/blocks.tsx (server-compatible, shared with the
            // public ContentRenderer) — editor and live site can never drift.
            render: (props: any) => <HeadingBlock {...props} />,
        },
        Text: {
            label: translate('editor.block.text', getStoredLanguage()),
            category: "content",
            fields: {
                color: { type: "text", label: "Color del texto (vacío = tema)" },
                size: { type: "text", label: "Tamaño (p. ej. 18 o 1.125rem)" },
                leading: { type: "text", label: "Interlineado (p. ej. 1.8)" },
                measure: { type: "text", label: "Ancho de línea máx. (p. ej. 680)" },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                content: "Escribe aquí...",
                color: "",
                size: "",
                leading: "",
                measure: "",
                elementId: "",
                css: {}
            },
            render: (props: any) => <TextBlock {...props} />,
        },
        Image: {
            label: translate('editor.block.image', getStoredLanguage()),
            category: "content",
            fields: {
                src: {
                    type: "custom",
                    render: ({ onChange, value }: any) => {
                        const [isModalOpen, setIsModalOpen] = useState(false);
                        return (
                            <div className="flex flex-col gap-2">
                                <input
                                    className="p-2 border rounded text-sm w-full"
                                    value={value || ""}
                                    onChange={(e) => onChange(e.target.value)}
                                    placeholder={translate('editor.field.imageUrl', getStoredLanguage())}
                                />
                                <button
                                    type="button"
                                    className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-sm text-gray-700 border"
                                    onClick={() => setIsModalOpen(true)}
                                >
                                    {translate('editor.field.selectFromMedia', getStoredLanguage())}
                                </button>
                                <MediaPickerModal
                                    isOpen={isModalOpen}
                                    onClose={() => setIsModalOpen(false)}
                                    onSelect={(item) => {
                                        // Register the FULL MediaItem so resolveData (which runs right after
                                        // this onChange dispatch) can persist srcSet/imgWidth/imgHeight from
                                        // the real backend variants — see lib/imageSrcset.ts header.
                                        rememberPickedMedia(item);
                                        // Store the RELATIVE sourceUrl, not guid (guid embeds the upload-time
                                        // host/IP and breaks when served from another origin).
                                        onChange(item.sourceUrl || item.guid);
                                        setIsModalOpen(false);
                                    }}
                                />
                            </div>
                        );
                    }
                },
                alt: { type: "text", label: "Texto alternativo (SEO / accesibilidad)" },
                radius: { type: "text", label: "Redondeo (p. ej. 16)" },
                shadow: { type: "text", label: "Sombra CSS (vacío = tema)" },
                width: { type: "text", label: "Ancho (p. ej. 480 o 60%)" },
                fit: {
                    type: "select",
                    label: "Ajuste",
                    options: [
                        { label: "Del tema", value: "" },
                        { label: "Cubrir", value: "cover" },
                        { label: "Contener", value: "contain" },
                    ],
                },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            resolveData: async ({ props }: any) => {
                const css = { ...props.css };
                // Migration: borderRadius -> css.borderRadius
                if (props.borderRadius) {
                    css.borderRadius = `${props.borderRadius}px`;
                }
                // Responsive images: when this src was just picked from the media
                // library, build srcSet + intrinsic dims from the backend-reported
                // variants (registry populated by the picker's onSelect — no network,
                // no URL guessing). Legacy pages without srcSet pass through untouched.
                let { srcSet, imgWidth, imgHeight } = props;
                const picked = getPickedMedia(props.src);
                if (picked) {
                    srcSet = buildSrcSet(props.src, picked).srcSet;
                    imgWidth = picked.width || undefined;
                    imgHeight = picked.height || undefined;
                } else if (srcSet && !srcSetBelongsTo(props.src, srcSet)) {
                    // src was hand-edited to another URL — the stored variants would 404.
                    srcSet = undefined;
                    imgWidth = undefined;
                    imgHeight = undefined;
                }
                return {
                    props: {
                        ...props,
                        css,
                        srcSet,
                        imgWidth,
                        imgHeight,
                        // Clear legacy prop to avoid confusion (optional, but cleaner)
                        borderRadius: undefined
                    }
                };
            },
            defaultProps: {
                // Local asset — the old via.placeholder.com default broke offline and leaked a
                // third-party request from every fresh Image block.
                src: "/placeholder-image.svg",
                alt: "",
                borderRadius: 0,
                radius: "",
                shadow: "",
                width: "",
                fit: "",
                elementId: "",
                css: {}
            },
            render: (props: any) => <ImageBlock {...props} />
        },
        Columns: {
            label: translate('editor.block.columns', getStoredLanguage()),
            category: "layout",
            fields: {
                distribution: {
                    type: "custom",
                    label: "Distribución de columnas",
                    render: ({ value, onChange }: any) => {
                        return (
                            <ColumnDistributionControl
                                value={value}
                                onChange={onChange}
                            />
                        );
                    }
                },
                columnStyles: {
                    type: "custom",
                    label: "Estilos de columnas",
                    render: ({ value, onChange }: any) => {
                        // Get column count from distribution
                        const currentStyles = value || [];
                        return (
                            <ColumnStyleAccordion
                                value={currentStyles}
                                onChange={onChange}
                                columnCount={currentStyles.length || 2}
                            />
                        );
                    }
                },
                "col-0": { type: "slot" },
                "col-1": { type: "slot" },
                "col-2": { type: "slot" },
                gap: { type: "text", label: "Separación (p. ej. 24)" },
                minHeight: { type: "text", label: "Altura mínima (p. ej. 320)" },
                bg: { type: "text", label: "Fondo (vacío = tema)" },
                radius: { type: "text", label: "Redondeo (p. ej. 16)" },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            // Use resolveData to sync columnStyles array with distribution column count
            resolveData: async ({ props }: any) => {
                const distribution = props.distribution || { columnCount: 2, widths: [50, 50] };
                const columnCount = distribution.columnCount || 2;

                // Ensure columnStyles array has correct length
                let columnStyles = props.columnStyles || [];
                const defaultStyle = {
                    backgroundColor: 'transparent',
                    padding: '16px',
                    borderWidth: '0px',
                    borderColor: '#e5e7eb',
                    borderRadius: '0px'
                };

                // Add missing styles
                while (columnStyles.length < columnCount) {
                    columnStyles.push({ ...defaultStyle });
                }
                // Remove extra styles
                columnStyles = columnStyles.slice(0, columnCount);

                // Migration, in the direction the contract needs: the legacy container props AND
                // the inline `css` this block used to rewrite them into both become token FIELDS.
                // `css.gap` / `css.minHeight` / `css.backgroundColor` / `css.borderRadius` are
                // exactly what this contract removes — an inline style beats any stylesheet, so
                // while they lived there no theme could restyle a Columns block at all.
                const css = { ...props.css };
                const pick = (v: any, fallback: any, ignore?: string) => {
                    if (v !== undefined && v !== null && v !== "") return String(v);
                    if (fallback === undefined || fallback === null || fallback === "") return "";
                    return String(fallback) === ignore ? "" : String(fallback);
                };
                const gap = props.gap !== undefined ? props.gap : pick(undefined, css.gap);
                const minHeight = pick(props.minHeight, css.minHeight, "auto");
                const bg = pick(props.bg || props.backgroundColor, css.backgroundColor, "transparent");
                const radius = pick(props.radius ?? props.borderRadius, css.borderRadius, "0px");
                delete css.gap;
                delete css.minHeight;
                delete css.backgroundColor;
                delete css.borderRadius;

                return {
                    props: {
                        ...props,
                        columnStyles,
                        gap,
                        minHeight,
                        bg,
                        radius,
                        css,
                        // Clear the pre-contract prop names now that their values live in fields.
                        backgroundColor: undefined,
                        borderRadius: undefined
                    }
                };
            },
            defaultProps: {
                distribution: { columnCount: 2, widths: [50, 50] },
                "col-2": [],
                gap: "",
                minHeight: "",
                bg: "",
                radius: "",
                elementId: "",
                css: {}
            },
            render: ({ "col-0": Col0, "col-1": Col1, "col-2": Col2, ...props }: any) => (
                <ColumnsBlock
                    {...props}
                    slots={[Col0, Col1, Col2].map((Col: any) => (Col ? () => <Col /> : null))}
                />
            ),
        },
        Card: {
            label: translate('editor.block.card', getStoredLanguage()),
            category: "content",
            fields: {
                title: { type: "text" },
                description: { type: "textarea" },
                icon: { type: "text", label: "FontAwesome Icon (e.g. fa-star)" },
                theme: {
                    type: "select",
                    options: [
                        { label: "Light", value: "light" },
                        { label: "Dark", value: "dark" },
                        { label: "Accent", value: "accent" }
                    ]
                },
                bg: { type: "text", label: "Fondo (vacío = tema)" },
                color: { type: "text", label: "Color del texto (vacío = tema)" },
                borderColor: { type: "text", label: "Color del borde" },
                radius: { type: "text", label: "Redondeo (p. ej. 24)" },
                pad: { type: "text", label: "Relleno (p. ej. 40)" },
                shadow: { type: "text", label: "Sombra CSS" },
                iconSize: { type: "text", label: "Tamaño del icono (p. ej. 64)" },
                iconBg: { type: "text", label: "Fondo del icono" },
                iconColor: { type: "text", label: "Color del icono" },
                titleSize: { type: "text", label: "Tamaño del título (p. ej. 28)" },
                titleWeight: {
                    type: "select",
                    label: "Grosor del título",
                    options: [
                        { label: "Del tema", value: "" },
                        { label: "Seminegrita", value: "600" },
                        { label: "Negrita", value: "700" },
                        { label: "Extranegrita", value: "800" },
                        { label: "Black", value: "900" },
                    ],
                },
                titleTransform: {
                    type: "select",
                    label: "Título en mayúsculas",
                    options: [
                        { label: "Del tema", value: "" },
                        { label: "MAYÚSCULAS", value: "uppercase" },
                        { label: "Normal", value: "none" },
                    ],
                },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                title: "Card Title",
                description: "This is a card description. You can use it to highlight features or services.",
                icon: "fa-rocket",
                theme: "light",
                bg: "", color: "", borderColor: "", radius: "", pad: "", shadow: "",
                iconSize: "", iconBg: "", iconColor: "",
                titleSize: "", titleWeight: "", titleTransform: "",
                css: {}
            },
            render: (props: any) => <CardBlock {...props} />
        },
        Divider: {
            label: translate('editor.block.divider', getStoredLanguage()),
            category: "layout",
            fields: {
                type: {
                    type: "select",
                    options: [
                        { label: "Solid", value: "solid" },
                        { label: "Dashed", value: "dashed" },
                        { label: "Gradient", value: "gradient" }
                    ]
                },
                color: { type: "text", label: "Color (vacío = tema)" },
                width: { type: "text", label: "Grosor (p. ej. 2)" },
                length: { type: "text", label: "Ancho (p. ej. 120 o 40%)" },
                gap: { type: "text", label: "Separación vertical (p. ej. 64)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                type: "solid",
                color: "",
                width: "",
                length: "",
                gap: "",
                // No inline margins: the spacing default now lives in --wjs-divider-mt/-mb, so a
                // theme can set the page's vertical rhythm. `gap` overrides it per block.
                css: {}
            },
            render: (props: any) => <DividerBlock {...props} />
        },
        Button: {
            label: translate('editor.block.button', getStoredLanguage()),
            category: "content",
            fields: {
                label: { type: "text" },
                href: {
                    type: "custom",
                    label: "Enlace",
                    render: ({ value, onChange }: any) => <LinkField value={value} onChange={onChange} />
                },
                variant: {
                    type: "radio",
                    options: [
                        { label: "Primary", value: "primary" },
                        { label: "Secondary", value: "secondary" },
                        { label: "Outline", value: "outline" }
                    ]
                },
                align: {
                    type: "radio",
                    options: [
                        { label: "Left", value: "left" },
                        { label: "Center", value: "center" },
                        { label: "Right", value: "right" }
                    ]
                },
                bg: { type: "text", label: "Fondo (vacío = tema)" },
                color: { type: "text", label: "Color del texto (vacío = tema)" },
                radius: { type: "text", label: "Redondeo (p. ej. 999 para píldora)" },
                padY: { type: "text", label: "Relleno vertical (p. ej. 14)" },
                padX: { type: "text", label: "Relleno horizontal (p. ej. 32)" },
                size: { type: "text", label: "Tamaño de letra (p. ej. 15)" },
                weight: {
                    type: "select",
                    label: "Grosor",
                    options: [
                        { label: "Del tema", value: "" },
                        { label: "Media", value: "500" },
                        { label: "Seminegrita", value: "600" },
                        { label: "Negrita", value: "700" },
                        { label: "Extranegrita", value: "800" },
                    ],
                },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                label: "Click Me",
                href: "#",
                variant: "primary",
                align: "left",
                bg: "",
                color: "",
                radius: "",
                padY: "",
                padX: "",
                size: "",
                weight: "",
                css: {}
            },
            render: ({ puck, ...props }: any) => <ButtonBlock {...props} isEditing={puck?.isEditing} />
        },
        Spacer: {
            label: translate('editor.block.spacer', getStoredLanguage()),
            category: "layout",
            fields: {
                height: { type: "text", label: "Altura (p. ej. 48 o 4rem)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            // The old resolveData rewrote `height` into an INLINE css.height and blanked the prop —
            // the exact move this contract undoes, since an inline height locks the theme out. It is
            // gone: `unit()` accepts the legacy bare number (24 → "24px") so pre-contract data keeps
            // rendering, and pages already rewritten still carry their css.height through `...css`.
            defaultProps: {
                height: "",
                css: {}
            },
            render: (props: any) => <SpacerBlock {...props} />
        },

        // ==========================================
        // NEW COMPONENTS - Layout
        // ==========================================

        Section: {
            label: translate('editor.block.section', getStoredLanguage()),
            category: "layout",
            fields: {
                children: { type: "slot" },
                maxWidth: {
                    type: "select",
                    label: "Max Width",
                    options: [
                        { label: "Full", value: "100%" },
                        { label: "Large (1280px)", value: "1280px" },
                        { label: "Medium (1024px)", value: "1024px" },
                        { label: "Small (768px)", value: "768px" },
                    ]
                },
                pad: { type: "text", label: "Relleno (p. ej. 96 o 96px 24px)" },
                bg: { type: "text", label: "Fondo (vacío = tema)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                maxWidth: "1280px",
                pad: "",
                bg: "",
                // Padding/background moved out of inline css into --wjs-section-pad/-bg so a theme
                // can own the page's vertical rhythm; `pad`/`bg` override it for one section.
                css: {}
            },
            render: ({ children: Children, ...props }: any) => (
                <SectionBlock {...props} slot={(cls?: string) => <Children className={cls} />} />
            )
        },

        Grid: {
            label: translate('editor.block.grid', getStoredLanguage()),
            category: "layout",
            fields: {
                children: { type: "slot" },
                columns: {
                    type: "select",
                    label: "Columns",
                    options: [
                        { label: "2 Columns", value: "2" },
                        { label: "3 Columns", value: "3" },
                        { label: "4 Columns", value: "4" },
                        { label: "5 Columns", value: "5" },
                        { label: "6 Columns", value: "6" },
                    ]
                },
                gap: { type: "text", label: "Gap (e.g. 20px)" },
                columnsTablet: {
                    type: "select",
                    label: "Columnas en tablet",
                    options: [
                        { label: "Del tema (2)", value: "" },
                        { label: "1", value: "1" },
                        { label: "2", value: "2" },
                        { label: "3", value: "3" },
                    ]
                },
                columnsMobile: {
                    type: "select",
                    label: "Columnas en móvil",
                    options: [
                        { label: "Del tema (1)", value: "" },
                        { label: "1", value: "1" },
                        { label: "2", value: "2" },
                    ]
                },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            // `gap` ships EMPTY on purpose. A default that is always present is emitted as an inline
            // custom property on every new Grid, which outranks the theme's --wjs-grid-gap forever —
            // the exact lock-out blockVars() exists to avoid. Empty means "whatever the theme says".
            defaultProps: {
                columns: "3",
                gap: "",
                columnsTablet: "",
                columnsMobile: "",
                css: {}
            },
            render: ({ children: Children, ...props }: any) => (
                <GridBlock {...props} slot={(cls?: string) => <Children className={cls} />} />
            )
        },

        FlexRow: {
            label: translate('editor.block.flexRow', getStoredLanguage()),
            category: "layout",
            fields: {
                children: { type: "slot" },
                justify: {
                    type: "select",
                    label: "Justify Content",
                    options: [
                        { label: "Start", value: "flex-start" },
                        { label: "Center", value: "center" },
                        { label: "End", value: "flex-end" },
                        { label: "Space Between", value: "space-between" },
                        { label: "Space Around", value: "space-around" },
                    ]
                },
                align: {
                    type: "select",
                    label: "Align Items",
                    options: [
                        { label: "Start", value: "flex-start" },
                        { label: "Center", value: "center" },
                        { label: "End", value: "flex-end" },
                        { label: "Stretch", value: "stretch" },
                    ]
                },
                gap: { type: "text", label: "Gap (e.g. 16px)" },
                wrap: {
                    type: "radio",
                    label: "Wrap",
                    options: [
                        { label: "Yes", value: "wrap" },
                        { label: "No", value: "nowrap" },
                    ]
                },
                direction: {
                    type: "select",
                    label: "Dirección",
                    options: [
                        { label: "Fila", value: "row" },
                        { label: "Fila invertida", value: "row-reverse" },
                        { label: "Columna", value: "column" },
                        { label: "Columna invertida", value: "column-reverse" },
                    ]
                },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            // `gap` empty for the same reason as Grid: a shipped default pins every new row and
            // locks --wjs-flex-gap out of the cascade.
            defaultProps: {
                justify: "flex-start",
                align: "center",
                gap: "",
                wrap: "wrap",
                direction: "row",
                css: {}
            },
            render: ({ children: Children, ...props }: any) => (
                <FlexRowBlock {...props} slot={(cls?: string) => <Children className={cls} />} />
            )
        },

        Accordion: {
            label: translate('editor.block.accordion', getStoredLanguage()),
            category: "layout",
            fields: {
                items: {
                    type: "array",
                    label: "Accordion Items",
                    arrayFields: {
                        title: { type: "text" },
                        content: { type: "textarea" }
                    }
                },
                bg: { type: "text", label: "Fondo (vacío = tema)" },
                borderColor: { type: "text", label: "Color del borde" },
                radius: { type: "text", label: "Redondeo (p. ej. 12)" },
                pad: { type: "text", label: "Relleno de la cabecera (p. ej. 16px 20px)" },
                headerBg: { type: "text", label: "Fondo de la cabecera" },
                headerColor: { type: "text", label: "Color de la cabecera" },
                activeColor: { type: "text", label: "Color al abrir" },
                panelBg: { type: "text", label: "Fondo del contenido" },
                panelColor: { type: "text", label: "Color del contenido" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                items: [
                    { title: "Section 1", content: "Content for section 1" },
                    { title: "Section 2", content: "Content for section 2" },
                ],
                bg: "", borderColor: "", radius: "", pad: "",
                headerBg: "", headerColor: "", activeColor: "", panelBg: "", panelColor: "",
                css: {}
            },
            render: (props: any) => <AccordionBlockIsland {...props} />
        },

        Tabs: {
            label: translate('editor.block.tabs', getStoredLanguage()),
            category: "layout",
            fields: {
                tabs: {
                    type: "array",
                    label: "Tabs",
                    arrayFields: {
                        label: { type: "text" },
                        content: { type: "textarea" }
                    }
                },
                color: { type: "text", label: "Color de las pestañas (vacío = tema)" },
                activeColor: { type: "text", label: "Color de la pestaña activa" },
                borderColor: { type: "text", label: "Color de la línea" },
                borderWidth: { type: "text", label: "Grosor de la línea (p. ej. 2)" },
                tabPad: { type: "text", label: "Relleno de la pestaña (p. ej. 12px 24px)" },
                panelBg: { type: "text", label: "Fondo del panel" },
                panelPad: { type: "text", label: "Relleno del panel (p. ej. 24)" },
                panelRadius: { type: "text", label: "Redondeo del panel (p. ej. 12)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                tabs: [
                    { label: "Tab 1", content: "Content for Tab 1" },
                    { label: "Tab 2", content: "Content for Tab 2" },
                    { label: "Tab 3", content: "Content for Tab 3" },
                ],
                color: "", activeColor: "", borderColor: "", borderWidth: "", tabPad: "",
                panelBg: "", panelPad: "", panelRadius: "",
                css: {}
            },
            render: (props: any) => <TabsBlockIsland {...props} />
        },

        // ==========================================
        // NEW COMPONENTS - Media
        // ==========================================

        VideoEmbed: {
            label: translate('editor.block.videoEmbed', getStoredLanguage()),
            category: "content",
            fields: {
                url: { type: "text", label: "Video URL (YouTube, Vimeo, o un archivo propio: /public/media/x.mp4)" },
                poster: { type: "text", label: "Póster (solo archivos propios)" },
                aspectRatio: {
                    type: "select",
                    label: "Aspect Ratio",
                    options: [
                        { label: "16:9", value: "56.25%" },
                        { label: "4:3", value: "75%" },
                        { label: "1:1", value: "100%" },
                    ]
                },
                radius: { type: "text", label: "Redondeo (p. ej. 12)" },
                bg: { type: "text", label: "Fondo mientras carga (vacío = tema)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            // The radius/overflow that used to be forced through inline `css` now live in
            // --wjs-video-radius, so a theme can round (or square off) every video at once.
            defaultProps: {
                url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
                poster: "",
                aspectRatio: "56.25%",
                radius: "",
                bg: "",
                css: {}
            },
            render: (props: any) => <VideoEmbedBlock {...props} />
        },

        AudioPlayer: {
            label: translate('editor.block.audioPlayer', getStoredLanguage()),
            category: "content",
            fields: {
                src: { type: "text", label: "Audio URL" },
                title: { type: "text", label: "Track Title" },
                bg: { type: "text", label: "Fondo (vacío = tema)" },
                borderColor: { type: "text", label: "Color del borde" },
                radius: { type: "text", label: "Redondeo (p. ej. 12)" },
                pad: { type: "text", label: "Relleno (p. ej. 24)" },
                iconSize: { type: "text", label: "Tamaño del icono (p. ej. 48)" },
                iconBg: { type: "text", label: "Fondo del icono" },
                iconColor: { type: "text", label: "Color del icono" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                src: "",
                title: "Audio Track",
                bg: "", borderColor: "", radius: "", pad: "",
                iconSize: "", iconBg: "", iconColor: "",
                css: {}
            },
            render: (props: any) => <AudioPlayerBlock {...props} />
        },

        // ==========================================
        // NEW COMPONENTS - Marketing
        // ==========================================

        PricingTable: {
            label: translate('editor.block.pricingTable', getStoredLanguage()),
            category: "content",
            fields: {
                plans: {
                    type: "array",
                    label: "Plans",
                    arrayFields: {
                        name: { type: "text" },
                        price: { type: "text" },
                        period: { type: "text" },
                        features: { type: "textarea" },
                        highlighted: { type: "radio", options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] },
                        buttonText: { type: "text" },
                        buttonLink: { type: "text" }
                    }
                },
                accent: { type: "text", label: "Color de acento (plan destacado)" },
                bg: { type: "text", label: "Fondo de los planes" },
                pad: { type: "text", label: "Relleno (p. ej. 48)" },
                radius: { type: "text", label: "Redondeo (p. ej. 24)" },
                gap: { type: "text", label: "Separación (p. ej. 32)" },
                priceSize: { type: "text", label: "Tamaño del precio (p. ej. 56)" },
                highlightScale: { type: "text", label: "Escala del destacado (p. ej. 1.08; 1 = sin escalar)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                plans: [
                    { name: "Basic", price: "$9", period: "/month", features: "Feature 1\nFeature 2\nFeature 3", highlighted: "false", buttonText: "Get Started", buttonLink: "#" },
                    { name: "Pro", price: "$29", period: "/month", features: "Everything in Basic\nFeature 4\nFeature 5\nPriority Support", highlighted: "true", buttonText: "Get Started", buttonLink: "#" },
                    { name: "Enterprise", price: "$99", period: "/month", features: "Everything in Pro\nCustom Features\nDedicated Support\nSLA", highlighted: "false", buttonText: "Contact Us", buttonLink: "#" },
                ],
                accent: "", bg: "", pad: "", radius: "", gap: "", priceSize: "", highlightScale: "",
                css: {}
            },
            render: ({ puck, ...props }: any) => <PricingTableBlock {...props} isEditing={puck?.isEditing} />
        },

        Testimonial: {
            label: translate('editor.block.testimonial', getStoredLanguage()),
            category: "content",
            fields: {
                quote: { type: "textarea", label: "Quote" },
                author: { type: "text", label: "Author Name" },
                role: { type: "text", label: "Role / Company" },
                avatar: { type: "text", label: "Avatar URL" },
                bg: { type: "text", label: "Fondo (vacío = tema)" },
                pad: { type: "text", label: "Relleno (p. ej. 48)" },
                radius: { type: "text", label: "Redondeo (p. ej. 24)" },
                quoteSize: { type: "text", label: "Tamaño de la cita (p. ej. 24)" },
                accent: { type: "text", label: "Color de acento (comillas y avatar)" },
                avatarSize: { type: "text", label: "Tamaño del avatar (p. ej. 72)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                quote: "This product has completely transformed how we work. I can't imagine going back to the old way.",
                author: "Jane Doe",
                role: "CEO, Acme Inc.",
                avatar: "",
                bg: "", pad: "", radius: "", quoteSize: "", accent: "", avatarSize: "",
                css: {}
            },
            render: (props: any) => <TestimonialBlock {...props} />
        },

        CTABanner: {
            label: translate('editor.block.ctaBanner', getStoredLanguage()),
            category: "content",
            fields: {
                title: { type: "text", label: "Title" },
                subtitle: { type: "text", label: "Subtitle" },
                buttonText: { type: "text", label: "Button Text" },
                buttonLink: {
                    type: "custom",
                    label: "Button Link",
                    render: ({ value, onChange }: any) => <LinkField value={value} onChange={onChange} />
                },
                variant: {
                    type: "select",
                    label: "Style",
                    options: [
                        { label: "Primary", value: "primary" },
                        { label: "Dark", value: "dark" },
                        { label: "Gradient", value: "gradient" },
                    ]
                },
                bg: { type: "text", label: "Fondo o degradado (vacío = variante)" },
                color: { type: "text", label: "Color del texto" },
                pad: { type: "text", label: "Relleno (p. ej. 80px 40px)" },
                radius: { type: "text", label: "Redondeo (p. ej. 32)" },
                titleSize: { type: "text", label: "Tamaño del título (p. ej. 48)" },
                buttonBg: { type: "text", label: "Fondo del botón" },
                buttonColor: { type: "text", label: "Color del botón" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                title: "Ready to get started?",
                subtitle: "Join thousands of satisfied customers today.",
                buttonText: "Get Started Free",
                buttonLink: "#",
                variant: "gradient",
                bg: "", color: "", pad: "", radius: "", titleSize: "", buttonBg: "", buttonColor: "",
                css: {}
            },
            render: ({ puck, ...props }: any) => <CTABannerBlock {...props} isEditing={puck?.isEditing} />
        },

        // ==========================================
        // NEW COMPONENTS - Dynamic Content
        // ==========================================

        PostsGrid: {
            label: translate('editor.block.postsGrid', getStoredLanguage()),
            category: "content",
            fields: {
                count: { type: "number", label: "Number of Posts", min: 1, max: 12 },
                columns: {
                    type: "select",
                    label: "Columns",
                    options: [
                        { label: "2", value: "2" },
                        { label: "3", value: "3" },
                        { label: "4", value: "4" },
                    ]
                },
                gap: { type: "text", label: "Separación (p. ej. 24)" },
                bg: { type: "text", label: "Fondo de las tarjetas (vacío = tema)" },
                borderColor: { type: "text", label: "Color del borde" },
                radius: { type: "text", label: "Redondeo (p. ej. 12)" },
                pad: { type: "text", label: "Relleno (p. ej. 24)" },
                thumbHeight: { type: "text", label: "Alto de la miniatura (p. ej. 160)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                count: 6,
                columns: "3",
                gap: "", bg: "", borderColor: "", radius: "", pad: "", thumbHeight: "",
                css: {}
            },
            render: ({ count, resolvedPosts, puck, ...props }: any) => {
                // REAL posts everywhere: injected server-side by resolveDynamicBlocks on the public
                // site, fetched client-side by useEditorPosts inside the editor canvas (same mapper,
                // shared in lib/resolvedPost.ts). Markup lives in content/blocks.tsx (shared with
                // the public server renderer, which passes resolvedPosts straight through).
                const editing = !!puck?.isEditing;
                const posts: any[] = useEditorPosts(editing, resolvedPosts, undefined, count);
                return <PostsGridBlock {...props} posts={posts} isEditing={editing} />;
            }
        },

        Form: {
            // Real forms with stored submissions (backend /api/v1/forms) — Webflow parity. All the
            // block's UI lives in puck/FormBlock.tsx; this entry only registers it.
            label: "Formulario",
            category: "content",
            fields: { ...formBlockFields },
            defaultProps: { ...formBlockDefaults },
            render: (props: any) => <FormBlockRender {...props} />,
        },

        Symbol: {
            // Synced reusable block groups ("editas uno, cambian todos") — puck/SymbolBlock.tsx.
            // El subárbol lo pinta la ÚNICA implementación de Symbol (VersoSymbolBlock, vía
            // RenderSubtree) — ya no hay config anidado ni mapa de componentes que enlazar.
            label: "Símbolo",
            category: "content",
            fields: { ...symbolBlockFields },
            defaultProps: { ...symbolBlockDefaults },
            render: (props: any) => <SymbolRender {...props} />,
        },

        CategoryPosts: {
            label: translate('editor.block.categoryPosts', getStoredLanguage()),
            category: "content",
            fields: {
                categorySlug: { type: "text", label: "Category Slug" },
                count: { type: "number", label: "Number of Posts", min: 1, max: 10 },
                layout: {
                    type: "select",
                    label: "Layout",
                    options: [
                        { label: "List", value: "list" },
                        { label: "Grid", value: "grid" },
                    ]
                },
                columns: {
                    type: "select",
                    label: "Columnas (rejilla)",
                    options: [
                        { label: "Del tema (2)", value: "" },
                        { label: "1", value: "1" },
                        { label: "2", value: "2" },
                        { label: "3", value: "3" },
                    ]
                },
                gap: { type: "text", label: "Separación (p. ej. 20)" },
                bg: { type: "text", label: "Fondo de las tarjetas (vacío = tema)" },
                borderColor: { type: "text", label: "Color de las líneas" },
                radius: { type: "text", label: "Redondeo (p. ej. 12)" },
                linkColor: { type: "text", label: "Color de los enlaces" },
                headingColor: { type: "text", label: "Color del título" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                categorySlug: "news",
                count: 5,
                layout: "list",
                columns: "", gap: "", bg: "", borderColor: "", radius: "", linkColor: "", headingColor: "",
                css: {}
            },
            render: ({ categorySlug, count, resolvedPosts, puck, ...props }: any) => {
                // Same contract as PostsGrid: real posts from the server resolver on the public
                // site, from useEditorPosts (client fetch, same mapper) inside the editor canvas.
                // Markup shared in content/blocks.tsx with the public server renderer.
                const editing = !!puck?.isEditing;
                const posts: any[] = useEditorPosts(editing, resolvedPosts, categorySlug, count);
                return <CategoryPostsBlock {...props} posts={posts} categorySlug={categorySlug} isEditing={editing} />;
            }
        },

        SearchBar: {
            label: translate('editor.block.searchBar', getStoredLanguage()),
            category: "content",
            fields: {
                placeholder: { type: "text", label: "Placeholder Text" },
                buttonText: { type: "text", label: "Button Text (leave empty for icon only)" },
                searchPage: { type: "text", label: "Search Results Page URL" },
                align: {
                    type: "select",
                    label: "Alignment",
                    options: [
                        { label: "Left", value: "flex-start" },
                        { label: "Center", value: "center" },
                        { label: "Right", value: "flex-end" },
                    ]
                },
                width: {
                    type: "select",
                    label: "Width",
                    options: [
                        { label: "Small (300px)", value: "300px" },
                        { label: "Medium (500px)", value: "500px" },
                        { label: "Large (700px)", value: "700px" },
                        { label: "Full Width", value: "100%" },
                    ]
                },
                inputBg: { type: "text", label: "Fondo del campo (vacío = tema)" },
                inputBorderColor: { type: "text", label: "Color del borde del campo" },
                inputRadius: { type: "text", label: "Redondeo del campo (p. ej. 8)" },
                buttonBg: { type: "text", label: "Fondo del botón" },
                buttonColor: { type: "text", label: "Color del botón" },
                buttonRadius: { type: "text", label: "Redondeo del botón (p. ej. 8)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                placeholder: "Search...",
                buttonText: "Search",
                searchPage: "/search",
                align: "flex-start",
                width: "500px",
                inputBg: "", inputBorderColor: "", inputRadius: "",
                buttonBg: "", buttonColor: "", buttonRadius: "",
                css: {}
            },
            render: (props: any) => <SearchBarBlockIsland {...props} />
        },

        // ==========================================
        // NEW COMPONENTS - Editor overhaul 2026-07
        // ==========================================

        Hero: {
            label: "Hero",
            category: "layout",
            fields: {
                title: { type: "text", label: "Título" },
                subtitle: { type: "textarea", label: "Subtítulo" },
                bgImage: {
                    type: "custom",
                    label: "Imagen de fondo",
                    render: ({ onChange, value }: any) => {
                        const [isModalOpen, setIsModalOpen] = useState(false);
                        return (
                            <div className="flex flex-col gap-2">
                                <input
                                    className="p-2 border rounded text-sm w-full"
                                    value={value || ""}
                                    onChange={(e) => onChange(e.target.value)}
                                    placeholder="URL de la imagen"
                                />
                                <button
                                    type="button"
                                    className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-sm text-gray-700 border"
                                    onClick={() => setIsModalOpen(true)}
                                >
                                    {translate('editor.field.selectFromMedia', getStoredLanguage())}
                                </button>
                                <MediaPickerModal
                                    isOpen={isModalOpen}
                                    onClose={() => setIsModalOpen(false)}
                                    onSelect={(item) => {
                                        onChange(item.sourceUrl || item.guid);
                                        setIsModalOpen(false);
                                    }}
                                />
                            </div>
                        );
                    }
                },
                overlay: {
                    type: "select",
                    label: "Oscurecer fondo",
                    options: [
                        { label: "Sin capa", value: "0" },
                        { label: "Suave (30%)", value: "0.3" },
                        { label: "Media (50%)", value: "0.5" },
                        { label: "Fuerte (70%)", value: "0.7" },
                    ]
                },
                height: {
                    type: "select",
                    label: "Altura",
                    options: [
                        { label: "Compacto (40vh)", value: "40vh" },
                        { label: "Medio (60vh)", value: "60vh" },
                        { label: "Grande (80vh)", value: "80vh" },
                        { label: "Pantalla completa", value: "100vh" },
                    ]
                },
                align: {
                    type: "radio",
                    label: "Alineación",
                    options: [
                        { label: "Izquierda", value: "flex-start" },
                        { label: "Centro", value: "center" },
                    ]
                },
                buttons: {
                    type: "array",
                    label: "Botones",
                    arrayFields: {
                        label: { type: "text", label: "Texto" },
                        href: {
                            type: "custom",
                            label: "Enlace",
                            render: ({ value, onChange }: any) => <LinkField value={value} onChange={onChange} />
                        },
                        variant: {
                            type: "radio",
                            options: [
                                { label: "Primario", value: "primary" },
                                { label: "Contorno", value: "outline" },
                            ]
                        }
                    }
                },
                overlayColor: { type: "text", label: "Color de la capa (vacío = negro)" },
                gradientFrom: { type: "text", label: "Degradado — desde (sin imagen)" },
                gradientTo: { type: "text", label: "Degradado — hasta" },
                gradientAngle: { type: "text", label: "Degradado — ángulo (p. ej. 135)" },
                titleSize: { type: "text", label: "Tamaño del titular (p. ej. 72)" },
                titleWeight: {
                    type: "select",
                    label: "Grosor del titular",
                    options: [
                        { label: "Del tema", value: "" },
                        { label: "Negrita", value: "700" },
                        { label: "Extranegrita", value: "800" },
                        { label: "Black", value: "900" },
                    ],
                },
                titleTracking: { type: "text", label: "Espaciado del titular (p. ej. -2)" },
                subtitleSize: { type: "text", label: "Tamaño del subtítulo (p. ej. 22)" },
                color: { type: "text", label: "Color del texto (vacío = blanco)" },
                pad: { type: "text", label: "Relleno (p. ej. 96 o 96px 24px)" },
                measure: { type: "text", label: "Ancho del contenido (p. ej. 900)" },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                title: "Un titular que atrapa",
                subtitle: "Explica en una frase el valor de tu sitio. Cambia la imagen, la altura y la capa oscura desde el panel.",
                bgImage: "",
                overlay: "0.5",
                overlayColor: "",
                height: "60vh",
                align: "center",
                buttons: [{ label: "Empezar", href: "#", variant: "primary" }],
                gradientFrom: "", gradientTo: "", gradientAngle: "",
                titleSize: "", titleWeight: "", titleTracking: "", subtitleSize: "",
                color: "", pad: "", measure: "",
                elementId: "",
                css: {}
            },
            render: ({ puck, ...props }: any) => <HeroBlock {...props} isEditing={puck?.isEditing} />
        },

        Quote: {
            label: "Cita",
            category: "content",
            fields: {
                text: { type: "textarea", label: "Cita" },
                cite: { type: "text", label: "Autor / fuente" },
                style: {
                    type: "radio",
                    label: "Estilo",
                    options: [
                        { label: "Barra lateral", value: "bar" },
                        { label: "Grande centrada", value: "large" },
                    ]
                },
                accent: { type: "text", label: "Color de acento (barra / comillas)" },
                size: { type: "text", label: "Tamaño del texto (p. ej. 24)" },
                color: { type: "text", label: "Color del texto" },
                quoteStyle: {
                    type: "select",
                    label: "Cursiva",
                    options: [
                        { label: "Del tema (cursiva)", value: "" },
                        { label: "Cursiva", value: "italic" },
                        { label: "Normal", value: "normal" },
                    ]
                },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                text: "El mejor momento para plantar un árbol fue hace veinte años. El segundo mejor momento es ahora.",
                cite: "Proverbio",
                style: "bar",
                accent: "", size: "", color: "", quoteStyle: "",
                css: {}
            },
            render: (props: any) => <QuoteBlock {...props} />
        },

        Table: {
            label: "Tabla",
            category: "content",
            fields: {
                header: { type: "text", label: "Cabecera (columnas separadas por | )" },
                rows: {
                    type: "array",
                    label: "Filas",
                    arrayFields: {
                        cells: { type: "text", label: "Celdas (separadas por | )" }
                    }
                },
                striped: {
                    type: "radio",
                    label: "Filas alternas",
                    options: [
                        { label: "Sí", value: "true" },
                        { label: "No", value: "false" },
                    ]
                },
                stripeBg: { type: "text", label: "Color de las filas alternas" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                header: "Plan | Precio | Soporte",
                rows: [
                    { cells: "Básico | 9 € | Email" },
                    { cells: "Pro | 29 € | Prioritario" },
                ],
                striped: "true",
                stripeBg: "",
                css: {}
            },
            render: (props: any) => <TableBlock {...props} />
        },

        IconList: {
            label: "Lista con iconos",
            category: "content",
            fields: {
                items: {
                    type: "array",
                    label: "Elementos",
                    arrayFields: {
                        icon: { type: "text", label: "Icono FontAwesome (fa-check)" },
                        title: { type: "text", label: "Título" },
                        text: { type: "textarea", label: "Descripción" }
                    }
                },
                columns: {
                    type: "select",
                    label: "Columnas",
                    options: [
                        { label: "1", value: "1" },
                        { label: "2", value: "2" },
                        { label: "3", value: "3" },
                    ]
                },
                gap: { type: "text", label: "Separación (p. ej. 40)" },
                iconSize: { type: "text", label: "Tamaño del icono (p. ej. 56)" },
                iconBg: { type: "text", label: "Fondo del icono" },
                iconColor: { type: "text", label: "Color del icono" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                items: [
                    { icon: "fa-bolt", title: "Rápido", text: "Describe una ventaja clave en una frase." },
                    { icon: "fa-shield", title: "Seguro", text: "Describe una ventaja clave en una frase." },
                    { icon: "fa-heart", title: "Cuidado", text: "Describe una ventaja clave en una frase." },
                ],
                columns: "3",
                gap: "", iconSize: "", iconBg: "", iconColor: "",
                css: {}
            },
            render: (props: any) => <IconListBlock {...props} />
        },

        SocialLinks: {
            label: "Redes sociales",
            category: "content",
            fields: {
                items: {
                    type: "array",
                    label: "Redes",
                    arrayFields: {
                        network: {
                            type: "select",
                            label: "Red",
                            options: [
                                { label: "Facebook", value: "facebook" },
                                { label: "Instagram", value: "instagram" },
                                { label: "X (Twitter)", value: "x-twitter" },
                                { label: "LinkedIn", value: "linkedin" },
                                { label: "YouTube", value: "youtube" },
                                { label: "TikTok", value: "tiktok" },
                                { label: "GitHub", value: "github" },
                                { label: "WhatsApp", value: "whatsapp" },
                            ]
                        },
                        url: { type: "text", label: "URL del perfil" }
                    }
                },
                align: {
                    type: "radio",
                    label: "Alineación",
                    options: [
                        { label: "Izquierda", value: "flex-start" },
                        { label: "Centro", value: "center" },
                        { label: "Derecha", value: "flex-end" },
                    ]
                },
                size: { type: "text", label: "Tamaño (p. ej. 52)" },
                radius: { type: "text", label: "Redondeo (p. ej. 12; vacío = círculo)" },
                bg: { type: "text", label: "Fondo" },
                color: { type: "text", label: "Color del icono" },
                hoverBg: { type: "text", label: "Fondo al pasar el ratón" },
                gap: { type: "text", label: "Separación (p. ej. 16)" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                items: [
                    { network: "instagram", url: "#" },
                    { network: "facebook", url: "#" },
                    { network: "x-twitter", url: "#" },
                ],
                align: "flex-start",
                size: "", radius: "", bg: "", color: "", hoverBg: "", gap: "",
                css: {}
            },
            render: ({ puck, ...props }: any) => <SocialLinksBlock {...props} isEditing={puck?.isEditing} />
        },

        Stats: {
            label: "Cifras",
            category: "content",
            fields: {
                items: {
                    type: "array",
                    label: "Cifras",
                    arrayFields: {
                        value: { type: "text", label: "Valor (ej. 1.200+)" },
                        label: { type: "text", label: "Etiqueta" }
                    }
                },
                gap: { type: "text", label: "Separación (p. ej. 40)" },
                valueSize: { type: "text", label: "Tamaño de la cifra (p. ej. 56)" },
                valueColor: { type: "text", label: "Color de la cifra" },
                labelColor: { type: "text", label: "Color de la etiqueta" },
                labelTransform: {
                    type: "select",
                    label: "Etiqueta en mayúsculas",
                    options: [
                        { label: "Del tema", value: "" },
                        { label: "MAYÚSCULAS", value: "uppercase" },
                        { label: "Normal", value: "none" },
                    ]
                },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                items: [
                    { value: "1.200+", label: "Clientes" },
                    { value: "98%", label: "Satisfacción" },
                    { value: "24/7", label: "Soporte" },
                ],
                gap: "", valueSize: "", valueColor: "", labelColor: "", labelTransform: "",
                css: {}
            },
            render: (props: any) => <StatsBlock {...props} />
        },

        HTMLEmbed: {
            label: "HTML personalizado",
            category: "content",
            fields: {
                html: { type: "textarea", label: "Código HTML" },
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                html: "<p>Pega aquí tu HTML. Se limpia automáticamente (sin scripts).</p>",
                css: {}
            },
            render: (props: any) => <HTMLEmbedBlock {...props} />
        },

        ...puckPluginComponents,
    }
};

// Every block (core + plugin) gains the shared fields: per-device visibility + entrance animation.
(baseConfig as any).components = withSharedBlockFields(baseConfig.components);

export const postConfig: any = {
    ...baseConfig,
    root: {
        fields: {
            title: { type: "text", label: "Title" },
            slug: { type: "text", label: "Slug (Permalink)" },
            category: {
                type: "custom",
                label: "Category",
                render: ({ value, onChange }: any) => <CategoryField value={value} onChange={onChange} />
            },
            allowComments: {
                type: "radio",
                label: "Allow Comments",
                options: [
                    { label: "Yes", value: "open" },
                    { label: "No", value: "closed" }
                ]
            },
            // Per-page theme template (persisted as the post's `_wjs_template` meta; '' = hierarchy).
            _wjs_template: {
                type: "custom",
                label: "Theme template",
                render: ({ value, onChange }: any) => <TemplateField value={value} onChange={onChange} />
            },
            // SEO Fields
            seo_title: {
                type: "text",
                label: "🔍 SEO Title (60 chars max)"
            },
            seo_description: {
                type: "textarea",
                label: "🔍 Meta Description (160 chars max)"
            },
            og_image: {
                type: "text",
                label: "🔍 Social Image URL"
            },
            noindex: {
                type: "radio",
                label: "🔍 Hide from Search Engines",
                options: [
                    { label: "No (Indexable)", value: "false" },
                    { label: "Yes (Hidden)", value: "true" }
                ]
            }
        },
        render: ({ children, title }: any) => {
            return (
                <article className="max-w-4xl mx-auto py-12 px-4">
                    <div className="mb-12 text-center">
                        {title && (
                            <h1 className="text-4xl md:text-5xl font-bold text-[var(--wjs-color-text-heading,black)] leading-tight mb-6">
                                {title}
                            </h1>
                        )}
                    </div>
                    <div className="bg-[var(--wjs-bg-surface,white)] p-8 md:p-12 rounded-2xl shadow-sm border border-[var(--wjs-border-subtle,transparent)]">
                        <div className="puck-children">
                            {children}
                        </div>
                    </div>
                </article>
            );
        }
    }
};

export const pageConfig: any = {
    ...baseConfig,
    root: {
        fields: {
            title: { type: "text", label: "Title" },
            slug: { type: "text", label: "Slug (Permalink)" },
            // Per-page theme template (persisted as the page's `_wjs_template` meta; '' = hierarchy).
            _wjs_template: {
                type: "custom",
                label: "Theme template",
                render: ({ value, onChange }: any) => <TemplateField value={value} onChange={onChange} />
            },
        },
        render: ({ children }: any) => {
            return (
                <div className="container mx-auto px-4">
                    {/* Full width within container, components can break out if needed */}
                    <div className="puck-children w-full">
                        {children}
                    </div>
                </div>
            );
        }
    }
};

// Default export for backward compatibility if needed, though mostly used named imports now
export const puckConfig = postConfig;
