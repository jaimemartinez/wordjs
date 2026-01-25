"use client";

import React from "react";

import { Config, DropZone, PuckComponent } from "@measured/puck";
import { useState, useEffect } from "react";
import MediaPickerModal from "./MediaPickerModal";
import ModernSelect from "./ModernSelect";
import { categoriesApi, Category, apiGet } from "@/lib/api";


// Plugin Puck Components
// Plugin Puck Components
import { puckPluginComponents } from "../lib/puckPluginRegistry";
import { CSSPropertiesControl } from "./puck/CSSControls";

// Custom Category Field component
const CategoryField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
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

// Column Style Interface
interface ColumnStyle {
    backgroundColor?: string;
    padding?: string;
    borderWidth?: string;
    borderColor?: string;
    borderRadius?: string;
}

// Column Style Accordion - for per-column styling
const ColumnStyleAccordion = ({ value, onChange, columnCount }: {
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
interface ColumnDistribution {
    columnCount: number;
    widths: number[]; // percentages that sum to 100
}

const ColumnDistributionControl = ({ value, onChange }: {
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
export const RichTextEditor = React.memo(({ value, onChange, onSave, onCancel, transparent = false }: {
    value: string;
    onChange: (html: string) => void;
    onSave?: () => void;
    onCancel?: () => void;
    transparent?: boolean;
}) => {
    const editorRef = React.useRef<HTMLDivElement>(null);
    const savedSelectionRef = React.useRef<Range | null>(null);
    const [editorBg, setEditorBg] = React.useState(transparent ? 'transparent' : '#ffffff');
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

    const cycleEditorBg = () => {
        const bgs = ['#ffffff', '#1f2937', '#000000', '#f3f4f6'];
        const currentIdx = bgs.indexOf(editorBg);
        setEditorBg(bgs[(currentIdx + 1) % bgs.length]);
    };

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
            // Prefer semantic tags (<b>, <i>) over inline styles
            try {
                document.execCommand('styleWithCSS', false, 'false');
            } catch (e) { }

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
        const win = doc.defaultView || window;

        // Ensure editor is focused first
        if (editorRef.current) {
            editorRef.current.focus();
        }

        // Restore selection if we have one
        restoreSelection();

        // Check if command is enabled
        try {
            const result = doc.execCommand(command, false, cmdValue);

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
                ${transparent ? 'absolute -top-14 left-0 z-50 bg-white/95 backdrop-blur shadow-xl rounded-lg border w-max' : 'bg-gray-50/50 border-b'}
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
                                console.log("[RichText] Cancel clicked");
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
                                console.log("[RichText] Save clicked");
                                onSave();
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
                style={{ backgroundColor: transparent ? 'transparent' : editorBg }}
                onSelect={() => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onMouseUp={() => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onKeyUp={(e) => {
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


const baseConfig = {
    categories: {
        layout: "Layout",
        content: "Content",
        'Card Gallery': "Card Gallery",
        'Video Gallery': "Video Gallery",
        'Photo Carousel': "Photo Carousel",
    },
    components: {
        Heading: {
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
                elementId: "",
                css: {}
            },
            render: ({ title, level, elementId, css }: any) => {
                const Tag = level as any;
                return (
                    <Tag
                        id={elementId || undefined}
                        className={`wp-block-heading heading-${level}`}
                        style={{
                            color: `var(--puck-heading-color, var(--wjs-color-text-heading, #000))`,
                            fontFamily: 'var(--wjs-font-family, inherit)',
                            paddingBottom: level === 'h1' ? '0' : '0.5rem',
                            marginTop: '1.5rem',
                            marginBottom: '1rem',
                            fontWeight: `var(--wjs-${level}-weight, 700)`,
                            fontSize: `var(--wjs-${level}-size)`,
                            ...css
                        }}
                    >
                        {title}
                    </Tag>
                );
            },
        },
        Text: {
            category: "content",
            fields: {
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
                elementId: "",
                css: {}
            },
            render: ({ content, elementId, css }: any) => (
                <div
                    id={elementId || undefined}
                    className="wp-block-text prose max-w-none"
                    style={{
                        color: 'var(--wjs-color-text-main, var(--wjs-foreground, #374151))',
                        lineHeight: 'var(--wjs-line-height-base, 1.6)',
                        fontSize: 'var(--wjs-font-size-base, 1rem)',
                        fontFamily: 'var(--wjs-font-family, inherit)',
                        ...css
                    }}
                    dangerouslySetInnerHTML={{ __html: content }}
                />
            ),
        },
        Image: {
            category: "content",
            fields: {
                src: {
                    type: "custom",
                    render: ({ name, onChange, value }: any) => {
                        const [isModalOpen, setIsModalOpen] = useState(false);
                        return (
                            <div className="flex flex-col gap-2">
                                <input
                                    className="p-2 border rounded text-sm w-full"
                                    value={value || ""}
                                    onChange={(e) => onChange(e.target.value)}
                                    placeholder="Image URL"
                                />
                                <button
                                    type="button"
                                    className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-sm text-gray-700 border"
                                    onClick={() => setIsModalOpen(true)}
                                >
                                    Select from Media
                                </button>
                                <MediaPickerModal
                                    isOpen={isModalOpen}
                                    onClose={() => setIsModalOpen(false)}
                                    onSelect={(item) => {
                                        onChange(item.guid);
                                        setIsModalOpen(false);
                                    }}
                                />
                            </div>
                        );
                    }
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
                return {
                    props: {
                        ...props,
                        css,
                        // Clear legacy prop to avoid confusion (optional, but cleaner)
                        borderRadius: undefined
                    }
                };
            },
            defaultProps: {
                src: "https://via.placeholder.com/600x400",
                alt: "Image",
                borderRadius: 0,
                elementId: "",
                css: {}
            },
            render: ({ src, alt, borderRadius, elementId, css }: any) => (
                <img
                    id={elementId || undefined}
                    src={src}
                    alt={alt}
                    style={{ borderRadius: borderRadius ? `${borderRadius}px` : undefined, ...css }}
                    className="max-w-full h-auto shadow-sm"
                />
            )
        },
        Columns: {
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

                // Migration: Legacy container props -> css
                const css = { ...props.css };
                if (props.gap !== undefined) css.gap = `${props.gap}px`;
                if (props.minHeight) css.minHeight = props.minHeight;
                if (props.backgroundColor) css.backgroundColor = props.backgroundColor;
                if (props.borderRadius) css.borderRadius = `${props.borderRadius}px`;

                return {
                    props: {
                        ...props,
                        columnStyles,
                        css,
                        // Clear legacy props
                        gap: undefined,
                        minHeight: undefined,
                        backgroundColor: undefined,
                        borderRadius: undefined
                    }
                };
            },
            defaultProps: {
                distribution: { columnCount: 2, widths: [50, 50] },
                "col-2": [],
                elementId: "",
                css: {
                    gap: '24px',
                    minHeight: 'auto',
                    backgroundColor: 'transparent',
                    borderRadius: '0px'
                }
            },
            render: ({ distribution, columnStyles, elementId, css, "col-0": Col0, "col-1": Col1, "col-2": Col2 }: any) => {
                // ... same logic
                const Slots = [Col0, Col1, Col2];
                // Convert percentages to grid template columns
                const dist = distribution || { columnCount: 2, widths: [50, 50] };
                const columnCount = dist.columnCount || 2;
                const widths = dist.widths || [50, 50];
                const gridTemplateColumns = widths.slice(0, columnCount).map((w: number) => `${w}%`).join(' ');
                const styles = columnStyles || [];

                // Generate unique ID for responsive styles
                const gridId = `columns-grid-${Math.random().toString(36).substr(2, 9)}`;

                return (
                    <>
                        {/* Responsive CSS - stack columns on mobile */}
                        <style>{`
                            @media (max-width: 768px) {
                                .${gridId} {
                                    grid-template-columns: 1fr !important;
                                }
                            }
                        `}</style>
                        <div
                            id={elementId || undefined}
                            className={gridId}
                            style={{
                                display: "grid",
                                gridTemplateColumns: gridTemplateColumns,
                                alignItems: "stretch",
                                width: '100%',
                                margin: 0,
                                ...css // Apply migrated CSS
                            }}
                        >
                            {Array.from({ length: columnCount }).map((_, i) => {
                                const colStyle = styles[i] || {};
                                const Slot = Slots[i];
                                return (
                                    <div
                                        key={i}
                                        className="flex flex-col"
                                        style={{
                                            height: "100%",
                                            minHeight: "100px",
                                            padding: colStyle.padding || '16px',
                                            backgroundColor: colStyle.backgroundColor || 'transparent',
                                            borderWidth: colStyle.borderWidth || '0px',
                                            borderColor: colStyle.borderColor || 'var(--wjs-border-subtle, #e5e7eb)',
                                            borderStyle: colStyle.borderWidth && colStyle.borderWidth !== '0px' ? 'solid' : 'none',
                                            borderRadius: colStyle.borderRadius || '0px',
                                            overflow: "hidden"
                                        }}
                                    >
                                        <Slot />
                                    </div>
                                );
                            })}
                        </div>
                    </>
                );
            },
        },
        Card: {
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
                css: {}
            },
            render: ({ title, description, icon, theme, css }: any) => {
                return (
                    <div
                        className={`wp-block-card card-theme-${theme} transition-all duration-300`}
                        style={{
                            backgroundColor: `var(--puck-card-${theme}-bg, var(--puck-card-bg, var(--wjs-bg-surface, #ffffff)))`,
                            color: `var(--puck-card-${theme}-color, var(--puck-card-color, var(--wjs-color-text-main, #1a1a1a)))`,
                            borderColor: `var(--puck-card-${theme}-border, var(--puck-card-border, var(--wjs-border-subtle, #e5e7eb)))`,
                            borderRadius: `var(--puck-card-radius, var(--wjs-border-radius, 0px))`,
                            padding: `var(--puck-card-padding, var(--wjs-space-md, 2rem))`,
                            borderWidth: '1px',
                            borderStyle: 'solid',
                            ...css
                        }}
                    >
                        {icon && (
                            <div
                                className="wp-block-card-icon flex items-center justify-center"
                                style={{
                                    width: '3.5rem',
                                    height: '3.5rem',
                                    borderRadius: `var(--puck-card-icon-radius, var(--wjs-border-radius, 0px))`,
                                    marginBottom: '1.5rem',
                                    fontSize: '1.5rem',
                                    backgroundColor: `var(--puck-card-${theme}-icon-bg, var(--wjs-bg-surface-hover, rgba(0,0,0,0.05)))`,
                                    color: `var(--puck-card-${theme}-icon-color, var(--wjs-color-primary, #3b82f6))`
                                }}
                            >
                                <i className={`fa-solid ${icon}`}></i>
                            </div>
                        )}
                        <h3
                            className="wp-block-card-title mb-4 uppercase tracking-tight"
                            style={{ fontSize: 'var(--wjs-h3-size, 1.5rem)', fontWeight: 'var(--wjs-h3-weight, 900)', lineHeight: '1.2' }}
                        >
                            {title}
                        </h3>
                        <p
                            className="wp-block-card-description text-base leading-relaxed opacity-80"
                            style={{ fontSize: 'var(--wjs-font-size-base, 1rem)' }}
                        >
                            {description}
                        </p>
                    </div>
                );
            }
        },
        Divider: {
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
                css: { marginTop: '40px', marginBottom: '40px' }
            },
            render: ({ type, css }: any) => {
                if (type === 'gradient') {
                    return <div className="h-px w-full bg-gradient-to-r from-transparent via-gray-200 to-transparent" style={css} />;
                }
                return <hr className={`w-full ${type === 'dashed' ? 'border-dashed' : 'border-solid'} border-gray-100`} style={css} />;
            }
        },
        Button: {
            category: "content",
            fields: {
                label: { type: "text" },
                href: { type: "text" },
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
                css: {}
            },
            render: ({ label, href, variant, align, css }: any) => {
                const alignments = {
                    left: "text-left",
                    center: "text-center",
                    right: "text-right"
                };

                return (
                    <div className={`wp-block-button my-4 ${alignments[align as keyof typeof alignments]}`}>
                        <a
                            href={href}
                            className={`button-variant-${variant} transition-all duration-200`}
                            onClick={(e) => e.preventDefault()}
                            style={{
                                display: 'inline-block',
                                textDecoration: 'none',
                                fontWeight: 'var(--wjs-h3-weight, 600)',
                                borderRadius: 'var(--puck-btn-radius, var(--wjs-border-radius, 0px))',
                                padding: 'var(--wjs-space-sm, 0.8rem) var(--wjs-space-md, 2rem)',
                                backgroundColor: `var(--puck-btn-${variant}-bg, var(--wjs-color-primary, #2563eb))`,
                                color: `var(--puck-btn-${variant}-color, var(--wjs-color-primary-text, #ffffff))`,
                                border: variant === 'outline'
                                    ? `2px solid var(--puck-btn-outline-border, var(--wjs-color-primary, #2563eb))`
                                    : 'none',
                                ...css
                            }}
                        >
                            {label}
                        </a>
                    </div>
                );
            }
        },
        Spacer: {
            category: "layout",
            fields: {
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
                // Migration: height -> css.height
                if (props.height) {
                    css.height = `${props.height}px`;
                }
                return { props: { ...props, css, height: undefined } };
            },
            defaultProps: {
                css: { height: '24px' }
            },
            render: ({ css }: any) => (
                <div style={css} />
            )
        },

        // ==========================================
        // NEW COMPONENTS - Layout
        // ==========================================

        Section: {
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
                css: {
                    padding: "60px 20px",
                    backgroundColor: "transparent"
                }
            },
            render: ({ children: Children, maxWidth, css }: any) => (
                <section
                    className="wp-block-section"
                    style={{
                        width: "100%",
                        ...css
                    }}
                >
                    <div style={{ maxWidth, margin: "0 auto" }}>
                        <Children />
                    </div>
                </section>
            )
        },

        Grid: {
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
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                columns: "3",
                gap: "24px",
                css: {}
            },
            render: ({ children: Children, columns, gap, css }: any) => (
                <div
                    className="wp-block-grid"
                    style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${columns}, 1fr)`,
                        gap,
                        ...css
                    }}
                >
                    <Children />
                </div>
            )
        },

        FlexRow: {
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
                css: {
                    type: "custom",
                    label: "Estilos CSS",
                    render: ({ value, onChange }: any) => (
                        <CSSPropertiesControl value={value} onChange={onChange} />
                    )
                }
            },
            defaultProps: {
                justify: "flex-start",
                align: "center",
                gap: "16px",
                wrap: "wrap",
                css: {}
            },
            render: ({ children: Children, justify, align, gap, wrap, css }: any) => (
                <div
                    className="wp-block-flex-row"
                    style={{
                        display: "flex",
                        flexDirection: "row",
                        justifyContent: justify,
                        alignItems: align,
                        gap,
                        flexWrap: wrap,
                        ...css
                    }}
                >
                    <Children />
                </div>
            )
        },

        Accordion: {
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
                css: {}
            },
            render: ({ items, css }: any) => {
                const [openIndex, setOpenIndex] = React.useState<number | null>(0);
                return (
                    <div className="wp-block-accordion" style={{ borderRadius: "8px", overflow: "hidden", border: "1px solid var(--wjs-border-subtle, #e5e7eb)", ...css }}>
                        {items?.map((item: any, index: number) => (
                            <div key={index} className="accordion-item" style={{ borderBottom: index < items.length - 1 ? "1px solid var(--wjs-border-subtle, #e5e7eb)" : "none" }}>
                                <button
                                    onClick={() => setOpenIndex(openIndex === index ? null : index)}
                                    style={{
                                        width: "100%",
                                        padding: "16px 20px",
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        background: "var(--wjs-bg-surface, #fff)",
                                        border: "none",
                                        cursor: "pointer",
                                        fontWeight: 600,
                                        fontSize: "1rem",
                                        color: "var(--wjs-color-text-main, #1a1a1a)",
                                        textAlign: "left"
                                    }}
                                >
                                    {item.title}
                                    <i className={`fa-solid fa-chevron-down transition-transform ${openIndex === index ? "rotate-180" : ""}`} style={{ transition: "transform 0.2s" }}></i>
                                </button>
                                {openIndex === index && (
                                    <div style={{ padding: "16px 20px", background: "var(--wjs-bg-canvas, #f9fafb)", color: "var(--wjs-color-text-muted, #6b7280)" }}>
                                        {item.content}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                );
            }
        },

        Tabs: {
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
                css: {}
            },
            render: ({ tabs, css }: any) => {
                const [activeTab, setActiveTab] = React.useState(0);
                return (
                    <div className="wp-block-tabs" style={css}>
                        <div style={{ display: "flex", borderBottom: "2px solid var(--wjs-border-subtle, #e5e7eb)", marginBottom: "20px" }}>
                            {tabs?.map((tab: any, index: number) => (
                                <button
                                    key={index}
                                    onClick={() => setActiveTab(index)}
                                    style={{
                                        padding: "12px 24px",
                                        border: "none",
                                        background: "transparent",
                                        cursor: "pointer",
                                        fontWeight: activeTab === index ? 600 : 400,
                                        color: activeTab === index ? "var(--wjs-color-primary, #2563eb)" : "var(--wjs-color-text-muted, #6b7280)",
                                        borderBottom: activeTab === index ? "2px solid var(--wjs-color-primary, #2563eb)" : "2px solid transparent",
                                        marginBottom: "-2px",
                                        transition: "all 0.2s"
                                    }}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                        <div style={{ padding: "20px", background: "var(--wjs-bg-surface, #fff)", borderRadius: "8px" }}>
                            {tabs?.[activeTab]?.content}
                        </div>
                    </div>
                );
            }
        },

        // ==========================================
        // NEW COMPONENTS - Media
        // ==========================================

        VideoEmbed: {
            category: "content",
            fields: {
                url: { type: "text", label: "Video URL (YouTube, Vimeo, or direct)" },
                aspectRatio: {
                    type: "select",
                    label: "Aspect Ratio",
                    options: [
                        { label: "16:9", value: "56.25%" },
                        { label: "4:3", value: "75%" },
                        { label: "1:1", value: "100%" },
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
                url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
                aspectRatio: "56.25%",
                css: { borderRadius: "12px", overflow: "hidden" }
            },
            render: ({ url, aspectRatio, css }: any) => {
                // Convert regular YouTube URLs to embed format
                let embedUrl = url;
                let isYouTube = false;

                if (url?.includes("youtube.com/watch")) {
                    const videoId = url.split("v=")[1]?.split("&")[0];
                    embedUrl = `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1`;
                    isYouTube = true;
                } else if (url?.includes("youtu.be/")) {
                    const videoId = url.split("youtu.be/")[1]?.split("?")[0];
                    embedUrl = `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1`;
                    isYouTube = true;
                } else if (url?.includes("youtube.com/embed/")) {
                    // Already embed URL, just add params if not present
                    embedUrl = url.includes("?") ? url : `${url}?rel=0&modestbranding=1`;
                    isYouTube = true;
                } else if (url?.includes("vimeo.com/") && !url?.includes("player.vimeo.com")) {
                    const videoId = url.split("vimeo.com/")[1]?.split("?")[0];
                    embedUrl = `https://player.vimeo.com/video/${videoId}`;
                }

                // Show placeholder if no URL
                if (!url) {
                    return (
                        <div className="wp-block-video-embed" style={{
                            position: "relative",
                            paddingBottom: aspectRatio,
                            height: 0,
                            background: "var(--wjs-bg-surface, #f3f4f6)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            ...css
                        }}>
                            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", textAlign: "center", color: "var(--wjs-color-text-muted, #9ca3af)" }}>
                                <i className="fa-solid fa-video" style={{ fontSize: "2rem", marginBottom: "8px" }}></i>
                                <p style={{ margin: 0 }}>Enter a video URL</p>
                            </div>
                        </div>
                    );
                }

                return (
                    <div className="wp-block-video-embed" style={{ position: "relative", paddingBottom: aspectRatio, height: 0, ...css }}>
                        <iframe
                            src={embedUrl}
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" }}
                            allowFullScreen
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                            referrerPolicy="strict-origin-when-cross-origin"
                            loading="lazy"
                        />
                    </div>
                );
            }
        },

        AudioPlayer: {
            category: "content",
            fields: {
                src: { type: "text", label: "Audio URL" },
                title: { type: "text", label: "Track Title" },
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
                css: {}
            },
            render: ({ src, title, css }: any) => (
                <div className="wp-block-audio-player" style={{ padding: "20px", background: "var(--wjs-bg-surface, #fff)", borderRadius: "12px", border: "1px solid var(--wjs-border-subtle, #e5e7eb)", ...css }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                        <div style={{ width: "48px", height: "48px", borderRadius: "8px", background: "var(--wjs-color-primary, #2563eb)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                            <i className="fa-solid fa-music"></i>
                        </div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, marginBottom: "8px", color: "var(--wjs-color-text-main, #1a1a1a)" }}>{title}</div>
                            <audio controls style={{ width: "100%" }} src={src}>
                                Your browser does not support the audio element.
                            </audio>
                        </div>
                    </div>
                </div>
            )
        },

        // ==========================================
        // NEW COMPONENTS - Marketing
        // ==========================================

        PricingTable: {
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
                css: {}
            },
            render: ({ plans, css }: any) => (
                <div className="wp-block-pricing" style={{ display: "grid", gridTemplateColumns: `repeat(${plans?.length || 3}, 1fr)`, gap: "24px", ...css }}>
                    {plans?.map((plan: any, index: number) => (
                        <div
                            key={index}
                            style={{
                                padding: "32px",
                                borderRadius: "16px",
                                border: plan.highlighted === "true" ? "2px solid var(--wjs-color-primary, #2563eb)" : "1px solid var(--wjs-border-subtle, #e5e7eb)",
                                background: plan.highlighted === "true" ? "var(--wjs-color-primary, #2563eb)" : "var(--wjs-bg-surface, #fff)",
                                color: plan.highlighted === "true" ? "#fff" : "var(--wjs-color-text-main, #1a1a1a)",
                                transform: plan.highlighted === "true" ? "scale(1.05)" : "none",
                                boxShadow: plan.highlighted === "true" ? "0 20px 40px rgba(0,0,0,0.15)" : "none",
                                textAlign: "center"
                            }}
                        >
                            <h3 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "8px" }}>{plan.name}</h3>
                            <div style={{ fontSize: "3rem", fontWeight: 800, marginBottom: "4px" }}>{plan.price}<span style={{ fontSize: "1rem", fontWeight: 400, opacity: 0.7 }}>{plan.period}</span></div>
                            <ul style={{ listStyle: "none", padding: 0, margin: "24px 0", textAlign: "left" }}>
                                {plan.features?.split("\n").map((feature: string, i: number) => (
                                    <li key={i} style={{ padding: "8px 0", display: "flex", alignItems: "center", gap: "8px" }}>
                                        <i className="fa-solid fa-check" style={{ color: plan.highlighted === "true" ? "#fff" : "var(--wjs-color-primary, #2563eb)" }}></i>
                                        {feature}
                                    </li>
                                ))}
                            </ul>
                            <a href={plan.buttonLink} style={{
                                display: "block",
                                padding: "12px 24px",
                                borderRadius: "8px",
                                background: plan.highlighted === "true" ? "#fff" : "var(--wjs-color-primary, #2563eb)",
                                color: plan.highlighted === "true" ? "var(--wjs-color-primary, #2563eb)" : "#fff",
                                textDecoration: "none",
                                fontWeight: 600
                            }}>{plan.buttonText}</a>
                        </div>
                    ))}
                </div>
            )
        },

        Testimonial: {
            category: "content",
            fields: {
                quote: { type: "textarea", label: "Quote" },
                author: { type: "text", label: "Author Name" },
                role: { type: "text", label: "Role / Company" },
                avatar: { type: "text", label: "Avatar URL" },
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
                avatar: "https://i.pravatar.cc/100",
                css: {}
            },
            render: ({ quote, author, role, avatar, css }: any) => (
                <div className="wp-block-testimonial" style={{ padding: "32px", background: "var(--wjs-bg-surface, #fff)", borderRadius: "16px", border: "1px solid var(--wjs-border-subtle, #e5e7eb)", ...css }}>
                    <div style={{ fontSize: "3rem", color: "var(--wjs-color-primary, #2563eb)", marginBottom: "16px", lineHeight: 1 }}>"</div>
                    <p style={{ fontSize: "1.25rem", fontStyle: "italic", color: "var(--wjs-color-text-main, #1a1a1a)", marginBottom: "24px", lineHeight: 1.6 }}>{quote}</p>
                    <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                        {avatar && <img src={avatar} alt={author} style={{ width: "56px", height: "56px", borderRadius: "50%", objectFit: "cover" }} />}
                        <div>
                            <div style={{ fontWeight: 600, color: "var(--wjs-color-text-main, #1a1a1a)" }}>{author}</div>
                            <div style={{ fontSize: "0.875rem", color: "var(--wjs-color-text-muted, #6b7280)" }}>{role}</div>
                        </div>
                    </div>
                </div>
            )
        },

        CTABanner: {
            category: "content",
            fields: {
                title: { type: "text", label: "Title" },
                subtitle: { type: "text", label: "Subtitle" },
                buttonText: { type: "text", label: "Button Text" },
                buttonLink: { type: "text", label: "Button Link" },
                variant: {
                    type: "select",
                    label: "Style",
                    options: [
                        { label: "Primary", value: "primary" },
                        { label: "Dark", value: "dark" },
                        { label: "Gradient", value: "gradient" },
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
                title: "Ready to get started?",
                subtitle: "Join thousands of satisfied customers today.",
                buttonText: "Get Started Free",
                buttonLink: "#",
                variant: "gradient",
                css: {}
            },
            render: ({ title, subtitle, buttonText, buttonLink, variant, css }: any) => {
                const backgrounds: any = {
                    primary: "var(--wjs-color-primary, #2563eb)",
                    dark: "#1a1a2e",
                    gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
                };
                return (
                    <div className="wp-block-cta-banner" style={{
                        padding: "60px 40px",
                        borderRadius: "24px",
                        background: backgrounds[variant] || backgrounds.gradient,
                        color: "#fff",
                        textAlign: "center",
                        ...css
                    }}>
                        <h2 style={{ fontSize: "2.5rem", fontWeight: 800, marginBottom: "12px" }}>{title}</h2>
                        <p style={{ fontSize: "1.25rem", opacity: 0.9, marginBottom: "32px" }}>{subtitle}</p>
                        <a href={buttonLink} style={{
                            display: "inline-block",
                            padding: "16px 32px",
                            background: "#fff",
                            color: variant === "dark" ? "#1a1a2e" : "var(--wjs-color-primary, #2563eb)",
                            borderRadius: "12px",
                            textDecoration: "none",
                            fontWeight: 700,
                            fontSize: "1.1rem",
                            boxShadow: "0 4px 14px rgba(0,0,0,0.2)"
                        }}>{buttonText}</a>
                    </div>
                );
            }
        },

        // ==========================================
        // NEW COMPONENTS - Dynamic Content
        // ==========================================

        PostsGrid: {
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
                css: {}
            },
            render: ({ count, columns, css }: any) => {
                // Placeholder for dynamic content - in production, this would fetch real posts
                const placeholderPosts = Array.from({ length: count }, (_, i) => ({
                    title: `Post Title ${i + 1}`,
                    excerpt: "This is a brief excerpt from the post content...",
                    date: "Jan 15, 2024"
                }));

                return (
                    <div className="wp-block-posts-grid" style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: "24px", ...css }}>
                        {placeholderPosts.map((post, index) => (
                            <article key={index} style={{
                                padding: "24px",
                                background: "var(--wjs-bg-surface, #fff)",
                                borderRadius: "12px",
                                border: "1px solid var(--wjs-border-subtle, #e5e7eb)"
                            }}>
                                <div style={{ height: "160px", background: "linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)", borderRadius: "8px", marginBottom: "16px" }}></div>
                                <div style={{ fontSize: "0.75rem", color: "var(--wjs-color-text-muted, #6b7280)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{post.date}</div>
                                <h3 style={{ fontSize: "1.125rem", fontWeight: 600, marginBottom: "8px", color: "var(--wjs-color-text-main, #1a1a1a)" }}>{post.title}</h3>
                                <p style={{ fontSize: "0.875rem", color: "var(--wjs-color-text-muted, #6b7280)" }}>{post.excerpt}</p>
                            </article>
                        ))}
                    </div>
                );
            }
        },

        CategoryPosts: {
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
                css: {}
            },
            render: ({ categorySlug, count, layout, css }: any) => {
                const placeholderPosts = Array.from({ length: count }, (_, i) => ({
                    title: `${categorySlug} Post ${i + 1}`,
                    excerpt: "Brief description of the post content...",
                }));

                if (layout === "grid") {
                    return (
                        <div className="wp-block-category-posts" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "20px", ...css }}>
                            {placeholderPosts.map((post, index) => (
                                <div key={index} style={{ padding: "20px", background: "var(--wjs-bg-surface, #fff)", borderRadius: "8px", border: "1px solid var(--wjs-border-subtle, #e5e7eb)" }}>
                                    <h4 style={{ fontWeight: 600, marginBottom: "8px" }}>{post.title}</h4>
                                    <p style={{ fontSize: "0.875rem", color: "var(--wjs-color-text-muted, #6b7280)" }}>{post.excerpt}</p>
                                </div>
                            ))}
                        </div>
                    );
                }

                return (
                    <div className="wp-block-category-posts" style={css}>
                        <h3 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "20px", textTransform: "capitalize", color: "var(--wjs-color-text-main, #1a1a1a)" }}>
                            <i className="fa-solid fa-folder mr-2"></i> {categorySlug}
                        </h3>
                        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                            {placeholderPosts.map((post, index) => (
                                <li key={index} style={{ padding: "16px 0", borderBottom: "1px solid var(--wjs-border-subtle, #e5e7eb)" }}>
                                    <a href="#" style={{ fontWeight: 500, color: "var(--wjs-color-text-main, #1a1a1a)", textDecoration: "none" }}>{post.title}</a>
                                </li>
                            ))}
                        </ul>
                    </div>
                );
            }
        },

        SearchBar: {
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
                css: {}
            },
            render: ({ placeholder, buttonText, searchPage, align, width, css }: any) => {
                const [query, setQuery] = React.useState("");

                const handleSubmit = (e: React.FormEvent) => {
                    e.preventDefault();
                    if (query.trim()) {
                        // In production, redirect to search page
                        const searchUrl = `${searchPage || '/search'}?q=${encodeURIComponent(query.trim())}`;
                        window.location.href = searchUrl;
                    }
                };

                return (
                    <div style={{ display: "flex", justifyContent: align || "flex-start", width: "100%" }}>
                        <form className="wp-block-search" style={{ display: "flex", gap: "8px", maxWidth: width || "500px", width: "100%", ...css }} onSubmit={handleSubmit}>
                            <input
                                type="search"
                                placeholder={placeholder}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                style={{
                                    flex: 1,
                                    padding: "12px 16px",
                                    border: "1px solid var(--wjs-border-subtle, #e5e7eb)",
                                    borderRadius: "8px",
                                    fontSize: "1rem",
                                    background: "var(--wjs-bg-surface, #fff)",
                                    color: "var(--wjs-color-text-main, #1a1a1a)"
                                }}
                            />
                            <button type="submit" style={{
                                padding: "12px 20px",
                                background: "var(--wjs-color-primary, #2563eb)",
                                color: "#fff",
                                border: "none",
                                borderRadius: "8px",
                                cursor: "pointer",
                                fontWeight: 600,
                                display: "flex",
                                alignItems: "center",
                                gap: "8px"
                            }}>
                                <i className="fa-solid fa-search"></i>
                                {buttonText && <span>{buttonText}</span>}
                            </button>
                        </form>
                    </div>
                );
            }
        },

        ...puckPluginComponents,
    }
};

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
        },
        render: ({ children, title }: any) => {
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
