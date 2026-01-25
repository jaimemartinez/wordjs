import React, { useState } from 'react';

// Types
export interface CSSData {
    // Layout
    display?: string;
    flexDirection?: string;
    justifyContent?: string;
    alignItems?: string;
    gap?: string;
    flexWrap?: string;

    // Dimensions
    width?: string;
    height?: string;
    minHeight?: string;
    padding?: string;
    paddingTop?: string;
    paddingRight?: string;
    paddingBottom?: string;
    paddingLeft?: string;
    margin?: string;
    marginTop?: string;
    marginRight?: string;
    marginBottom?: string;
    marginLeft?: string;

    // Typography
    fontFamily?: string;
    color?: string;
    fontSize?: string;
    fontWeight?: string;
    textAlign?: string;
    lineHeight?: string;
    letterSpacing?: string;
    textTransform?: string;
    textDecoration?: string; // underline, etc.

    // Decoration
    backgroundColor?: string;
    backgroundImage?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    border?: string;
    borderWidth?: string;
    borderColor?: string;
    borderStyle?: string;
    borderRadius?: string;
    boxShadow?: string;
    opacity?: string;
    overflow?: string;
}

const AccordionItem = ({ title, children, defaultOpen = false }: { title: string, children: React.ReactNode, defaultOpen?: boolean }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="border-b border-gray-100 last:border-0 hover:bg-[var(--wjs-bg-surface-hover,white)] transition-colors group">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={`flex items-center justify-between w-full px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-all ${isOpen ? 'text-gray-900' : 'text-gray-500 group-hover:text-gray-700'}`}
            >
                {title}
                <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-[9px] opacity-70`}></i>
            </button>
            {isOpen && <div className="px-3 pb-3 space-y-3">{children}</div>}
        </div>
    );
};

const ControlGroup = ({ label, children }: { label: string, children: React.ReactNode }) => (
    <div className="space-y-1.5 group/control">
        <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide group-hover/control:text-gray-700 transition-colors duration-300">{label}</label>
        {children}
    </div>
);

const Input = ({ value, onChange, placeholder, type = "text" }: any) => (
    <input
        type={type}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2.5 py-1.5 text-xs bg-[var(--wjs-bg-surface,white)] border border-gray-200 rounded-md text-gray-900 placeholder-gray-400 hover:border-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all duration-200 shadow-sm"
    />
);

const Select = ({ value, onChange, options }: any) => (
    <div className="relative">
        <select
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs bg-[var(--wjs-bg-surface,white)] border border-gray-200 rounded-md text-gray-900 appearance-none hover:border-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all duration-200 cursor-pointer shadow-sm"
        >
            <option value="">Default</option>
            {options.map((opt: any) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
        </select>
        <div className="absolute inset-y-0 right-2 flex items-center pointer-events-none opacity-50">
            <i className="fa-solid fa-chevron-down text-[10px] text-gray-500"></i>
        </div>
    </div>
);

const ColorPicker = ({ value, onChange }: any) => (
    <div className="flex gap-2 items-center group/picker">
        <div className="relative w-8 h-8 rounded-md border border-gray-200 overflow-hidden shrink-0 shadow-sm group-hover/picker:shadow transition-all ring-offset-1 group-focus-within/picker:ring-2 ring-blue-500">
            <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxwYXRoIGQ9Ik0wIDBoNHY0SDB6bTQgNGg0djRINHoiIGZpbGw9IiNlN2U3ZTciLz48L3N2Zz4=')] opacity-30"></div>
            <div className="absolute inset-0" style={{ backgroundColor: value || 'transparent' }}></div>
            <input
                type="color"
                value={value || "#ffffff"}
                onChange={(e) => onChange(e.target.value)}
                className="absolute inset-0 w-[150%] h-[150%] -top-1/4 -left-1/4 cursor-pointer opacity-0"
            />
        </div>
        <div className="flex-1">
            <Input value={value} onChange={onChange} placeholder="#000000" />
        </div>
    </div>
);

const shadowPresets = {
    none: 'none',
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    base: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)'
};

import { apiGet } from "@/lib/api";

export const CSSPropertiesControl = ({ value, onChange }: { value: CSSData, onChange: (val: CSSData) => void }) => {
    const data = value || {};
    const [fonts, setFonts] = useState<any[]>([]);

    React.useEffect(() => {
        // Fetch available fonts
        apiGet<any[]>('/fonts')
            .then(data => {
                if (Array.isArray(data)) {
                    setFonts(data);
                    // Inject font styles if not already present
                    data.forEach((font: any) => {
                        const styleId = `font-preview-${font.filename}`;
                        if (!document.getElementById(styleId)) {
                            const style = document.createElement('style');
                            style.id = styleId;
                            style.textContent = `
                                @font-face {
                                    font-family: '${font.family}';
                                    src: url('${font.url}');
                                }
                            `;
                            document.head.appendChild(style);
                        }
                    });
                }
            })
            .catch(err => console.error('Failed to load fonts:', err));
    }, []);

    const update = (key: keyof CSSData, val: string) => {
        const newData = { ...data, [key]: val };
        // Clean up empty keys
        if (!val) {
            // @ts-ignore
            newData[key] = undefined;
        }
        onChange(newData);
    };

    return (
        <div className="flex flex-col bg-[var(--wjs-bg-surface,white)] -mx-4 -my-4 border-t border-b border-gray-100">
            {/* LAYOUT */}
            <AccordionItem title="Layout & Spacing" defaultOpen={true}>
                <div className="grid grid-cols-2 gap-3">
                    <ControlGroup label="Display">
                        <Select
                            value={data.display}
                            onChange={(v: string) => update('display', v)}
                            options={[
                                { value: 'block', label: 'Block' },
                                { value: 'flex', label: 'Flex' },
                                { value: 'grid', label: 'Grid' },
                                { value: 'inline-block', label: 'Inline Block' },
                                { value: 'none', label: 'None' },
                            ]}
                        />
                    </ControlGroup>
                    {data.display === 'flex' && (
                        <ControlGroup label="Direction">
                            <Select
                                value={data.flexDirection}
                                onChange={(v: string) => update('flexDirection', v)}
                                options={[
                                    { value: 'row', label: 'Row' },
                                    { value: 'column', label: 'Column' },
                                    { value: 'row-reverse', label: 'Row Reverse' },
                                    { value: 'column-reverse', label: 'Column Reverse' },
                                ]}
                            />
                        </ControlGroup>
                    )}
                </div>

                {data.display === 'flex' && (
                    <div className="grid grid-cols-2 gap-3 mt-3 p-3 bg-gray-50/50 rounded-lg border border-gray-50">
                        <ControlGroup label="Justify">
                            <Select
                                value={data.justifyContent}
                                onChange={(v: string) => update('justifyContent', v)}
                                options={[
                                    { value: 'flex-start', label: 'Start' },
                                    { value: 'center', label: 'Center' },
                                    { value: 'flex-end', label: 'End' },
                                    { value: 'space-between', label: 'Space Between' },
                                ]}
                            />
                        </ControlGroup>
                        <ControlGroup label="Align">
                            <Select
                                value={data.alignItems}
                                onChange={(v: string) => update('alignItems', v)}
                                options={[
                                    { value: 'flex-start', label: 'Start' },
                                    { value: 'center', label: 'Center' },
                                    { value: 'flex-end', label: 'End' },
                                    { value: 'stretch', label: 'Stretch' },
                                ]}
                            />
                        </ControlGroup>
                        <div className="col-span-2">
                            <ControlGroup label="Gap">
                                <Input value={data.gap} onChange={(v: string) => update('gap', v)} placeholder="16px" />
                            </ControlGroup>
                        </div>
                    </div>
                )}

                <div className="space-y-4 pt-2">
                    <div className="p-3 bg-gray-50/30 rounded-lg border border-gray-50 hover:bg-gray-50/80 transition-colors">
                        <div className="flex items-center gap-2 mb-2">
                            <i className="fa-regular fa-square text-gray-300 text-[10px]"></i>
                            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Spacing</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mb-3">
                            <ControlGroup label="Padding">
                                <Input value={data.padding} onChange={(v: string) => update('padding', v)} placeholder="All sides..." />
                            </ControlGroup>
                            <ControlGroup label="Margin">
                                <Input value={data.margin} onChange={(v: string) => update('margin', v)} placeholder="All sides..." />
                            </ControlGroup>
                        </div>

                        {(data.padding || data.margin) && (
                            <div className="grid grid-cols-4 gap-1.5 mt-2 animate-in fade-in slide-in-from-top-1">
                                <Input value={data.paddingTop} onChange={(v: string) => update('paddingTop', v)} placeholder="PT" />
                                <Input value={data.paddingRight} onChange={(v: string) => update('paddingRight', v)} placeholder="PR" />
                                <Input value={data.paddingBottom} onChange={(v: string) => update('paddingBottom', v)} placeholder="PB" />
                                <Input value={data.paddingLeft} onChange={(v: string) => update('paddingLeft', v)} placeholder="PL" />
                            </div>
                        )}
                    </div>
                </div>
            </AccordionItem>

            {/* DIMENSIONS */}
            <AccordionItem title="Dimensions">
                <div className="grid grid-cols-2 gap-3">
                    <ControlGroup label="Width">
                        <Input value={data.width} onChange={(v: string) => update('width', v)} placeholder="100%, 500px..." />
                    </ControlGroup>
                    <ControlGroup label="Height">
                        <Input value={data.height} onChange={(v: string) => update('height', v)} placeholder="auto, 100vh..." />
                    </ControlGroup>
                    <ControlGroup label="Min Height">
                        <Input value={data.minHeight} onChange={(v: string) => update('minHeight', v)} placeholder="300px..." />
                    </ControlGroup>
                    <ControlGroup label="Overflow">
                        <Select
                            value={data.overflow}
                            onChange={(v: string) => update('overflow', v)}
                            options={[
                                { value: 'visible', label: 'Visible' },
                                { value: 'hidden', label: 'Hidden' },
                                { value: 'scroll', label: 'Scroll' },
                                { value: 'auto', label: 'Auto' },
                            ]}
                        />
                    </ControlGroup>
                </div>
            </AccordionItem>

            {/* TYPOGRAPHY */}
            <AccordionItem title="Typography">
                <ControlGroup label="Font Family">
                    <Select
                        value={data.fontFamily}
                        onChange={(v: string) => update('fontFamily', v)}
                        options={[
                            { value: 'inherit', label: 'Default' },
                            { value: 'Inter, sans-serif', label: 'Inter' },
                            { value: 'sans-serif', label: 'Sans Serif' },
                            { value: 'serif', label: 'Serif' },
                            { value: 'monospace', label: 'Monospace' },
                            ...Array.from(new Set(fonts.map(f => f.family))).map(family => ({
                                value: `'${family}', sans-serif`,
                                label: family
                            }))
                        ]}
                    />
                </ControlGroup>

                <div className="mt-3">
                    <ControlGroup label="Color">
                        <ColorPicker value={data.color} onChange={(v: string) => update('color', v)} />
                    </ControlGroup>

                    <div className="grid grid-cols-2 gap-3 mt-3">
                        <ControlGroup label="Font Size">
                            <Input value={data.fontSize} onChange={(v: string) => update('fontSize', v)} placeholder="16px..." />
                        </ControlGroup>
                        <ControlGroup label="Line Height">
                            <Input value={data.lineHeight} onChange={(v: string) => update('lineHeight', v)} placeholder="1.5..." />
                        </ControlGroup>
                    </div>

                    <div className="grid grid-cols-2 gap-3 mt-3">
                        <ControlGroup label="Weight">
                            <Select
                                value={data.fontWeight}
                                onChange={(v: string) => update('fontWeight', v)}
                                options={[
                                    { value: '300', label: 'Light' },
                                    { value: '400', label: 'Normal' },
                                    { value: '500', label: 'Medium' },
                                    { value: '600', label: 'Semi Bold' },
                                    { value: '700', label: 'Bold' },
                                ]}
                            />
                        </ControlGroup>
                        <ControlGroup label="Align">
                            <Select
                                value={data.textAlign}
                                onChange={(v: string) => update('textAlign', v)}
                                options={[
                                    { value: 'left', label: 'Left' },
                                    { value: 'center', label: 'Center' },
                                    { value: 'right', label: 'Right' },
                                    { value: 'justify', label: 'Justify' },
                                ]}
                            />
                        </ControlGroup>
                    </div>
                    <div className="mt-3">
                        <ControlGroup label="Decoration">
                            <Select
                                value={data.textDecoration}
                                onChange={(v: string) => update('textDecoration', v)}
                                options={[
                                    { value: 'none', label: 'None' },
                                    { value: 'underline', label: 'Underline' },
                                    { value: 'line-through', label: 'Line Through' },
                                ]}
                            />
                        </ControlGroup>
                    </div>
                </div>
            </AccordionItem >

            {/* DECORATION */}
            < AccordionItem title="Decoration" >
                <ControlGroup label="Background Color">
                    <ColorPicker value={data.backgroundColor} onChange={(v: string) => update('backgroundColor', v)} />
                </ControlGroup>

                <div className="mt-3 p-3 bg-gray-50/50 rounded-lg border border-gray-50">
                    <ControlGroup label="Background Image">
                        <Input value={data.backgroundImage} onChange={(v: string) => update('backgroundImage', v ? `url('${v}')` : '')} placeholder="https://..." />
                        {data.backgroundImage && <div className="text-[9px] text-gray-400 mt-1 truncate font-mono">{data.backgroundImage}</div>}
                    </ControlGroup>

                    {data.backgroundImage && (
                        <div className="grid grid-cols-2 gap-3 mt-3 animate-in fade-in slide-in-from-top-2">
                            <ControlGroup label="Size">
                                <Select
                                    value={data.backgroundSize}
                                    onChange={(v: string) => update('backgroundSize', v)}
                                    options={[
                                        { value: 'cover', label: 'Cover' },
                                        { value: 'contain', label: 'Contain' },
                                        { value: 'auto', label: 'Auto' },
                                    ]}
                                />
                            </ControlGroup>
                            <ControlGroup label="Position">
                                <Select
                                    value={data.backgroundPosition}
                                    onChange={(v: string) => update('backgroundPosition', v)}
                                    options={[
                                        { value: 'center', label: 'Center' },
                                        { value: 'top', label: 'Top' },
                                        { value: 'bottom', label: 'Bottom' },
                                    ]}
                                />
                            </ControlGroup>
                        </div>
                    )}
                </div>

                <div className="pt-2 mt-2">
                    <div className="p-3 bg-[var(--wjs-bg-surface,white)] border border-gray-200 rounded-lg shadow-sm hover:border-gray-300 transition-colors">
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                <i className="fa-regular fa-square text-gray-400 text-[10px]"></i>
                                <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wide">Border</span>
                            </div>
                            {data.borderWidth && <div className="w-2 h-2 rounded-full bg-blue-500"></div>}
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <ControlGroup label="Width">
                                <Input
                                    value={data.borderWidth}
                                    onChange={(v: string) => {
                                        const newData = { ...data, borderWidth: v };
                                        if (v && !data.borderStyle) newData.borderStyle = 'solid';
                                        if (v && !data.borderColor) newData.borderColor = '#000000';
                                        if (!v) (newData as any).borderWidth = undefined;
                                        onChange(newData);
                                    }}
                                    placeholder="1px..."
                                />
                            </ControlGroup>
                            <ControlGroup label="Radius">
                                <Input value={data.borderRadius} onChange={(v: string) => update('borderRadius', v)} placeholder="8px..." />
                            </ControlGroup>
                        </div>
                        <div className="mt-3">
                            <ControlGroup label="Color">
                                <ColorPicker
                                    value={data.borderColor}
                                    onChange={(v: string) => {
                                        const newData = { ...data, borderColor: v };
                                        if (v && !data.borderWidth) newData.borderWidth = '1px';
                                        if (v && !data.borderStyle) newData.borderStyle = 'solid';
                                        if (!v) (newData as any).borderColor = undefined;
                                        onChange(newData);
                                    }}
                                />
                            </ControlGroup>
                        </div>
                        <div className="mt-3">
                            <ControlGroup label="Style">
                                <Select
                                    value={data.borderStyle}
                                    onChange={(v: string) => update('borderStyle', v)}
                                    options={[
                                        { value: 'solid', label: 'Solid' },
                                        { value: 'dashed', label: 'Dashed' },
                                        { value: 'dotted', label: 'Dotted' },
                                        { value: 'none', label: 'None' },
                                    ]}
                                />
                            </ControlGroup>
                        </div>
                    </div>
                </div>

                <div className="mt-3">
                    <ControlGroup label="Opacity">
                        <div className="flex items-center gap-2 bg-gray-50 px-2 py-1 rounded-md border border-gray-100">
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.1"
                                value={data.opacity || "1"}
                                onChange={(e) => update('opacity', e.target.value)}
                                className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                            />
                            <span className="text-[10px] font-mono w-6 text-right text-gray-500">{data.opacity || "1"}</span>
                        </div>
                    </ControlGroup>
                </div>
                <div className="mt-4">
                    <ControlGroup label="Box Shadow">
                        <div className="space-y-2">
                            <Select
                                value={Object.entries(shadowPresets).find(([, val]) => val === data.boxShadow)?.[0] || 'custom'}
                                onChange={(v: string) => {
                                    if (v === 'custom') {
                                        return;
                                    };
                                    const presetVal = shadowPresets[v as keyof typeof shadowPresets];
                                    if (presetVal) update('boxShadow', presetVal);
                                }}
                                options={[
                                    { value: 'none', label: 'None' },
                                    { value: 'sm', label: 'Small' },
                                    { value: 'base', label: 'Default' },
                                    { value: 'md', label: 'Medium' },
                                    { value: 'lg', label: 'Large' },
                                    { value: 'xl', label: 'Extra Large' },
                                    { value: 'inner', label: 'Inner' },
                                    { value: 'custom', label: 'Custom / Edit' },
                                ]}
                            />
                            <Input
                                value={data.boxShadow}
                                onChange={(v: string) => update('boxShadow', v)}
                                placeholder="Custom shadow..."
                            />
                        </div>
                    </ControlGroup>
                </div>
            </AccordionItem >
        </div >
    );
};
