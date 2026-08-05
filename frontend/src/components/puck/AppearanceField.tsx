"use client";

import React from "react";
import { AccordionItem, ControlGroup, Input, Select, ColorPicker } from "./CSSControls";
import MSym from "../editor/MSym";

/**
 * SHARED APPEARANCE SYSTEM — the "nothing is hardcoded" layer.
 *
 * Every block in the editor (core AND marketplace-plugin blocks) is wrapped by
 * withSharedBlockFields, which gives it this `look` field. So instead of each block baking in its
 * own colours, radii, shadows and spacing, the author drives all of it from the properties panel:
 * background (solid / gradient / image / glass), border, layered shadow, spacing, typography and
 * hover motion. A block's own fields then only cover what is genuinely block-specific (a pricing
 * tier's price, a testimonial's author…), not its looks.
 *
 * WHY A CSS-VARIABLE + CLASS SPLIT, not pure inline styles:
 * inline styles cannot express `:hover`, `::after` or keyframes. So the numeric knobs travel as
 * CSS custom properties on the element (inline, fully dynamic) while the BEHAVIOUR lives in static
 * classes in wordjs-ui.css that read those variables. That keeps hover/motion working identically
 * in the editor canvas and on the SSR public site, with no runtime style injection.
 *
 * Everything degrades to "unset": an empty spec produces no style and no class, so a block that
 * the author never touched renders exactly as its own render() intends.
 */

// The PURE half (types + appearanceToStyle + friends) lives in blockShell.ts so the public
// server renderer can use it without this "use client" module. Re-exported here so every
// existing import keeps working; the UI below imports the same single implementation.
import { appearanceToStyle, SHADOWS, isSet, RESP_PROPS, fmtResp } from "./blockShell";
import type { Appearance, ResponsiveLook } from "./blockShell";
export { appearanceToStyle, SHADOWS, isSet };

const HOVERS: { value: string; label: string }[] = [
    { value: "", label: "Ninguno" },
    { value: "lift", label: "Elevar" },
    { value: "sink", label: "Hundir" },
    { value: "scale", label: "Ampliar" },
    { value: "glow", label: "Resplandor" },
    { value: "border", label: "Borde vivo" },
    { value: "shine", label: "Destello" },
    { value: "tilt", label: "Inclinar 3D" },
];
export type { Appearance, ResponsiveLook };

// ─────────────────────────────────────────────────────────────────────────
// Properties-panel control
// ─────────────────────────────────────────────────────────────────────────

const Num = ({ value, onChange, min = 0, max = 100, step = 1, suffix = "px" }: any) => (
    <div className="flex items-center gap-2">
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={Number(value) || 0}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1 h-1 accent-[#1f108e] bg-[var(--ed-surface-container-highest)] rounded-full"
        />
        <span className="text-[11px] text-[var(--ed-primary)] w-12 text-right tabular-nums" style={{ fontFamily: "var(--puck-font-family-monospaced)" }}>
            {Number(value) || 0}
            {suffix}
        </span>
    </div>
);

const Segmented = ({ value, onChange, options }: any) => (
    <div className="flex gap-0.5 bg-[var(--ed-surface-container-high)] p-0.5 rounded border border-[var(--ed-outline-variant)]">
        {options.map((o: any) => (
            <button
                key={o.value}
                type="button"
                onClick={() => onChange(o.value)}
                title={o.label}
                className={`flex-1 py-1 rounded text-[10px] font-bold transition-all flex items-center justify-center ${
                    (value || "") === o.value
                        ? "bg-[var(--ed-primary)] text-white shadow-sm"
                        : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                }`}
            >
                {o.icon ? (
                    o.icon.startsWith("fa-") ? <i className={`fa-solid ${o.icon}`}></i> : <MSym name={o.icon} size={14} />
                ) : (
                    o.label
                )}
            </button>
        ))}
    </div>
);

/**
 * One responsive-override row: the shared Num slider + an "heredado" indicator + a small undo
 * button that removes the override for that prop on that breakpoint. Module-level on purpose —
 * a component type recreated inside every render would remount the range input mid-drag.
 */
const RespNum = ({ label, value, has, inherited, onChange, onClear, min = 0, max = 100, step = 1, suffix = "px" }: any) => (
    <ControlGroup label={label}>
        <div className="flex items-center gap-1.5">
            <div className="flex-1">
                <Num value={value} onChange={onChange} min={min} max={max} step={step} suffix={suffix} />
            </div>
            <button
                type="button"
                onClick={onClear}
                disabled={!has}
                title="Quitar el ajuste de este dispositivo (volver al heredado)"
                className={`p-1 rounded transition-colors ${
                    has
                        ? "text-[var(--ed-primary)] hover:bg-[var(--ed-surface-container-high)]"
                        : "text-[var(--ed-outline-variant)] cursor-default"
                }`}
            >
                <MSym name="undo" size={13} />
            </button>
        </div>
        <p className="text-[10px] text-[var(--ed-outline)]">
            {has
                ? "Ajuste propio de este dispositivo"
                : isSet(inherited)
                  ? `Heredado: ${inherited}${suffix}`
                  : "Heredado (sin valor propio)"}
        </p>
    </ControlGroup>
);

export function AppearanceControl({
    value,
    onChange,
}: {
    value: Appearance;
    onChange: (v: Appearance) => void;
}) {
    const a = value || {};
    const set = (patch: Partial<Appearance>) => onChange({ ...a, ...patch });
    const touched = Object.values(a).some((v) => isSet(v) && v !== false);

    // ── Edit-buffer per breakpoint ──────────────────────────────────────
    // `bp` picks which bucket the CAJA and TIPOGRAFÍA sections edit: the base Appearance
    // ("Escritorio"), a.tb or a.mo. It is pure UI state — nothing of it is stored in the page.
    const [bp, setBp] = React.useState<"base" | "tb" | "mo">("base");
    const isBase = bp === "base";
    const rl: ResponsiveLook = (isBase ? {} : bp === "tb" ? a.tb : a.mo) || {};
    const putResp = (next: ResponsiveLook | undefined) => {
        if (bp === "tb") set({ tb: next });
        else if (bp === "mo") set({ mo: next });
    };
    const setResp = (p: keyof ResponsiveLook, v: number | string) => putResp({ ...rl, [p]: v });
    const clearResp = (p: keyof ResponsiveLook) => {
        const next: ResponsiveLook = { ...rl };
        delete next[p];
        putResp(Object.keys(next).length ? next : undefined);
    };
    /** Value the current breakpoint inherits when it has no override (mobile falls to tablet first). */
    const inh = (p: keyof ResponsiveLook): number | string | undefined =>
        bp === "mo" && fmtResp(p, a.tb?.[p]) !== undefined ? a.tb?.[p] : a[p];
    /** Slider position: the override if present, otherwise the inherited value (drag = override it). */
    const respVal = (p: keyof ResponsiveLook): number => (isSet(rl[p]) ? Number(rl[p]) : Number(inh(p)) || 0);
    const respRow = (p: keyof ResponsiveLook, label: string, extra?: { min?: number; max?: number; step?: number; suffix?: string }) => (
        <RespNum
            label={label}
            value={respVal(p)}
            has={isSet(rl[p])}
            inherited={inh(p)}
            onChange={(v: number) => setResp(p, v)}
            onClear={() => clearResp(p)}
            {...extra}
        />
    );

    return (
        // wjs-f-look — marker class: the properties panel's tab CSS (:has) files this field under
        // ESTILO. Purely a hook, no styles of its own.
        <div className="wjs-f-look border border-[var(--ed-outline-variant)] rounded-lg overflow-hidden bg-white">
            {touched && (
                <button
                    type="button"
                    onClick={() => onChange({})}
                    className="w-full px-3 py-1.5 text-[10px] font-bold text-[var(--ed-outline)] hover:text-[var(--ed-error)] hover:bg-[var(--ed-error-container)] transition-colors border-b border-[var(--ed-outline-variant)] flex items-center justify-center gap-1.5"
                >
                    <MSym name="undo" size={12} />
                    Restablecer apariencia
                </button>
            )}

            {/* Breakpoint edit-buffer switcher (M3 segmented) — desktop is the base spec; tableta
                and móvil only expose the ResponsiveLook subset (caja + tipografía). */}
            <div className="px-2 py-1.5 border-b border-[var(--ed-outline-variant)]">
                <Segmented
                    value={isBase ? "" : bp}
                    onChange={(v: string) => setBp((v || "base") as "base" | "tb" | "mo")}
                    options={[
                        { value: "", label: "Escritorio", icon: "desktop_windows" },
                        { value: "tb", label: "Tableta", icon: "tablet_mac" },
                        { value: "mo", label: "Móvil", icon: "smartphone" },
                    ]}
                />
            </div>

            {isBase ? (
                <>
            <AccordionItem title="Fondo">
                <Segmented
                    value={a.bg}
                    onChange={(v: string) => set({ bg: v as Appearance["bg"] })}
                    options={[
                        { value: "", label: "—", icon: "close" },
                        { value: "color", label: "Color", icon: "palette" },
                        { value: "gradient", label: "Degradado", icon: "layers" },
                        { value: "image", label: "Imagen", icon: "image" },
                        { value: "glass", label: "Cristal", icon: "fa-wine-glass" },
                    ]}
                />

                {a.bg === "color" && (
                    <ControlGroup label="Color">
                        <ColorPicker value={a.bgColor} onChange={(v: string) => set({ bgColor: v })} />
                    </ControlGroup>
                )}

                {a.bg === "gradient" && (
                    <>
                        <ControlGroup label="Desde">
                            <ColorPicker value={a.gradFrom} onChange={(v: string) => set({ gradFrom: v })} />
                        </ControlGroup>
                        <ControlGroup label="Intermedio (opcional)">
                            <ColorPicker value={a.gradVia} onChange={(v: string) => set({ gradVia: v })} />
                        </ControlGroup>
                        <ControlGroup label="Hasta">
                            <ColorPicker value={a.gradTo} onChange={(v: string) => set({ gradTo: v })} />
                        </ControlGroup>
                        <ControlGroup label="Ángulo">
                            <Num value={a.gradAngle ?? 135} onChange={(v: number) => set({ gradAngle: v })} max={360} suffix="°" />
                        </ControlGroup>
                        <label className="flex items-center gap-2 text-[11px] text-[var(--ed-on-surface-variant)] cursor-pointer">
                            <input
                                type="checkbox"
                                checked={!!a.gradAnimate}
                                onChange={(e) => set({ gradAnimate: e.target.checked })}
                                className="accent-[#1f108e]"
                            />
                            Degradado en movimiento
                        </label>
                    </>
                )}

                {a.bg === "image" && (
                    <>
                        <ControlGroup label="URL de la imagen">
                            <Input value={a.bgImage} onChange={(v: string) => set({ bgImage: v })} placeholder="/uploads/foto.jpg" />
                        </ControlGroup>
                        <ControlGroup label="Ajuste">
                            <Select
                                value={a.bgSize}
                                onChange={(v: string) => set({ bgSize: v })}
                                options={[
                                    { value: "cover", label: "Cubrir" },
                                    { value: "contain", label: "Contener" },
                                    { value: "auto", label: "Tamaño real" },
                                ]}
                            />
                        </ControlGroup>
                        <ControlGroup label="Posición">
                            <Select
                                value={a.bgPos}
                                onChange={(v: string) => set({ bgPos: v })}
                                options={[
                                    { value: "center", label: "Centro" },
                                    { value: "top", label: "Arriba" },
                                    { value: "bottom", label: "Abajo" },
                                    { value: "left", label: "Izquierda" },
                                    { value: "right", label: "Derecha" },
                                ]}
                            />
                        </ControlGroup>
                        <label className="flex items-center gap-2 text-[11px] text-[var(--ed-on-surface-variant)] cursor-pointer">
                            <input
                                type="checkbox"
                                checked={!!a.bgFixed}
                                onChange={(e) => set({ bgFixed: e.target.checked })}
                                className="accent-[#1f108e]"
                            />
                            Efecto parallax al hacer scroll
                        </label>
                    </>
                )}

                {a.bg === "glass" && (
                    <>
                        <ControlGroup label="Desenfoque">
                            <Num value={a.glassBlur ?? 12} onChange={(v: number) => set({ glassBlur: v })} max={40} />
                        </ControlGroup>
                        <ControlGroup label="Tinte">
                            <Input value={a.glassTint} onChange={(v: string) => set({ glassTint: v })} placeholder="rgb(255 255 255 / .08)" />
                        </ControlGroup>
                    </>
                )}

                {(a.bg === "image" || a.bg === "gradient") && (
                    <>
                        <ControlGroup label="Capa de oscurecimiento">
                            <Num value={a.overlay ?? 0} onChange={(v: number) => set({ overlay: v })} max={1} step={0.05} suffix="" />
                        </ControlGroup>
                        {Number(a.overlay) > 0 && (
                            <ControlGroup label="Color de la capa">
                                <ColorPicker value={a.overlayColor} onChange={(v: string) => set({ overlayColor: v })} />
                            </ControlGroup>
                        )}
                    </>
                )}
            </AccordionItem>

            <AccordionItem title="Borde y sombra">
                <ControlGroup label="Grosor del borde">
                    <Num value={a.borderWidth ?? 0} onChange={(v: number) => set({ borderWidth: v })} max={12} />
                </ControlGroup>
                {Number(a.borderWidth) > 0 && (
                    <>
                        <ControlGroup label="Estilo">
                            <Select
                                value={a.borderStyle}
                                onChange={(v: string) => set({ borderStyle: v })}
                                options={[
                                    { value: "solid", label: "Sólido" },
                                    { value: "dashed", label: "Discontinuo" },
                                    { value: "dotted", label: "Punteado" },
                                ]}
                            />
                        </ControlGroup>
                        <ControlGroup label="Color del borde">
                            <ColorPicker value={a.borderColor} onChange={(v: string) => set({ borderColor: v })} />
                        </ControlGroup>
                    </>
                )}
                <ControlGroup label="Redondeo">
                    <Num value={a.radius ?? 0} onChange={(v: number) => set({ radius: v })} max={64} />
                </ControlGroup>
                <ControlGroup label="Sombra">
                    <Select
                        value={a.shadow}
                        onChange={(v: string) => set({ shadow: v })}
                        options={[
                            { value: "sm", label: "Sutil" },
                            { value: "md", label: "Media" },
                            { value: "lg", label: "Amplia" },
                            { value: "xl", label: "Muy amplia" },
                            { value: "2xl", label: "Dramática" },
                            { value: "soft", label: "Difusa (premium)" },
                            { value: "inner", label: "Interior" },
                            { value: "custom", label: "Personalizada…" },
                        ]}
                    />
                </ControlGroup>
                {a.shadow === "custom" && (
                    <>
                        <ControlGroup label="Desplazamiento X">
                            <Num value={a.shadowX ?? 0} onChange={(v: number) => set({ shadowX: v })} min={-60} max={60} />
                        </ControlGroup>
                        <ControlGroup label="Desplazamiento Y">
                            <Num value={a.shadowY ?? 12} onChange={(v: number) => set({ shadowY: v })} min={-60} max={60} />
                        </ControlGroup>
                        <ControlGroup label="Desenfoque">
                            <Num value={a.shadowBlur ?? 32} onChange={(v: number) => set({ shadowBlur: v })} max={120} />
                        </ControlGroup>
                        <ControlGroup label="Expansión">
                            <Num value={a.shadowSpread ?? -8} onChange={(v: number) => set({ shadowSpread: v })} min={-40} max={40} />
                        </ControlGroup>
                        <ControlGroup label="Color de la sombra">
                            <ColorPicker value={a.shadowColor} onChange={(v: string) => set({ shadowColor: v })} />
                        </ControlGroup>
                    </>
                )}
            </AccordionItem>

            <AccordionItem title="Espaciado y tamaño">
                <ControlGroup label="Relleno vertical">
                    <Num value={a.padY ?? 0} onChange={(v: number) => set({ padY: v })} max={160} />
                </ControlGroup>
                <ControlGroup label="Relleno horizontal">
                    <Num value={a.padX ?? 0} onChange={(v: number) => set({ padX: v })} max={160} />
                </ControlGroup>
                <ControlGroup label="Margen superior">
                    <Num value={a.mt ?? 0} onChange={(v: number) => set({ mt: v })} min={-80} max={160} />
                </ControlGroup>
                <ControlGroup label="Margen inferior">
                    <Num value={a.mb ?? 0} onChange={(v: number) => set({ mb: v })} min={-80} max={160} />
                </ControlGroup>
                <ControlGroup label="Ancho máximo (0 = sin límite)">
                    <Num value={a.maxWidth ?? 0} onChange={(v: number) => set({ maxWidth: v })} max={1600} step={20} />
                </ControlGroup>
                <ControlGroup label="Altura mínima (0 = automática)">
                    <Num value={a.minHeight ?? 0} onChange={(v: number) => set({ minHeight: v })} max={900} step={10} />
                </ControlGroup>
            </AccordionItem>

            <AccordionItem title="Tipografía">
                <ControlGroup label="Color del texto">
                    <ColorPicker value={a.color} onChange={(v: string) => set({ color: v })} />
                </ControlGroup>
                <ControlGroup label="Tamaño (0 = heredado)">
                    <Num value={a.fontSize ?? 0} onChange={(v: number) => set({ fontSize: v })} max={120} />
                </ControlGroup>
                <ControlGroup label="Grosor">
                    <Select
                        value={a.fontWeight}
                        onChange={(v: string) => set({ fontWeight: v })}
                        options={[
                            { value: "300", label: "Ligera" },
                            { value: "400", label: "Normal" },
                            { value: "500", label: "Media" },
                            { value: "600", label: "Seminegrita" },
                            { value: "700", label: "Negrita" },
                            { value: "800", label: "Extranegrita" },
                            { value: "900", label: "Black" },
                        ]}
                    />
                </ControlGroup>
                <ControlGroup label="Familia tipográfica">
                    <Input value={a.fontFamily} onChange={(v: string) => set({ fontFamily: v })} placeholder="var(--wjs-font-family)" />
                </ControlGroup>
                <ControlGroup label="Interlineado (0 = heredado)">
                    <Num value={a.lineHeight ?? 0} onChange={(v: number) => set({ lineHeight: v })} max={3} step={0.05} suffix="" />
                </ControlGroup>
                <ControlGroup label="Espaciado entre letras">
                    <Num value={a.letterSpacing ?? 0} onChange={(v: number) => set({ letterSpacing: v })} min={-4} max={16} step={0.5} />
                </ControlGroup>
                <ControlGroup label="Alineación">
                    <Segmented
                        value={a.align}
                        onChange={(v: string) => set({ align: v })}
                        options={[
                            { value: "", label: "—", icon: "close" },
                            { value: "left", label: "Izquierda", icon: "format_align_left" },
                            { value: "center", label: "Centro", icon: "format_align_center" },
                            { value: "right", label: "Derecha", icon: "format_align_right" },
                            { value: "justify", label: "Justificado", icon: "format_align_justify" },
                        ]}
                    />
                </ControlGroup>
                <ControlGroup label="Mayúsculas / minúsculas">
                    <Select
                        value={a.transform}
                        onChange={(v: string) => set({ transform: v })}
                        options={[
                            { value: "uppercase", label: "MAYÚSCULAS" },
                            { value: "lowercase", label: "minúsculas" },
                            { value: "capitalize", label: "Capitalizado" },
                        ]}
                    />
                </ControlGroup>
            </AccordionItem>

            <AccordionItem title="Movimiento al pasar el ratón">
                <ControlGroup label="Efecto">
                    <Select value={a.hover} onChange={(v: string) => set({ hover: v })} options={HOVERS.filter((h) => h.value)} />
                </ControlGroup>
                {isSet(a.hover) && (
                    <>
                        <ControlGroup label="Intensidad">
                            <Num value={a.hoverAmount ?? 6} onChange={(v: number) => set({ hoverAmount: v })} max={30} suffix="" />
                        </ControlGroup>
                        <ControlGroup label="Velocidad">
                            <Num value={a.hoverSpeed ?? 300} onChange={(v: number) => set({ hoverSpeed: v })} min={80} max={1200} step={20} suffix="ms" />
                        </ControlGroup>
                        {(a.hover === "glow" || a.hover === "border" || a.hover === "shine") && (
                            <ControlGroup label="Color del efecto">
                                <ColorPicker value={a.hoverColor} onChange={(v: string) => set({ hoverColor: v })} />
                            </ControlGroup>
                        )}
                    </>
                )}
                <p className="text-[10px] text-[var(--ed-outline)] leading-relaxed">
                    Los efectos se desactivan solos para quien tenga activado &ldquo;reducir movimiento&rdquo; en su
                    sistema.
                </p>
            </AccordionItem>
                </>
            ) : (
                <>
                    {/* The rest of the appearance (fondo/borde/sombra/movimiento) is desktop-only by
                        design — one look per block, only sizes adapt — so those sections are hidden
                        here with this short note instead of shown greyed-out. */}
                    <p className="px-3 py-2 text-[10px] text-[var(--ed-outline)] leading-relaxed border-b border-[var(--ed-outline-variant)]">
                        Editando {bp === "tb" ? "tableta (768–1023 px)" : "móvil (menos de 768 px)"}. Solo caja y
                        tipografía varían por dispositivo; fondo, borde, sombra y movimiento se ajustan en
                        Escritorio. Sin ajuste propio se hereda: escritorio → tableta → móvil.
                    </p>

                    <AccordionItem title="Espaciado y tamaño">
                        {respRow("padY", "Relleno vertical", { max: 160 })}
                        {respRow("padX", "Relleno horizontal", { max: 160 })}
                        {respRow("mt", "Margen superior", { min: -80, max: 160 })}
                        {respRow("mb", "Margen inferior", { min: -80, max: 160 })}
                        {respRow("maxWidth", "Ancho máximo (0 = quitar límite)", { max: 1600, step: 20 })}
                        {respRow("minHeight", "Altura mínima (0 = automática)", { max: 900, step: 10 })}
                        {/* radius is responsive-capable too; its base control lives under "Borde y
                            sombra", but that section is desktop-only, so the override edits here. */}
                        {respRow("radius", "Redondeo", { max: 64 })}
                    </AccordionItem>

                    <AccordionItem title="Tipografía">
                        {respRow("fontSize", "Tamaño (0 = heredado)", { max: 120 })}
                        {respRow("lineHeight", "Interlineado (0 = heredado)", { max: 3, step: 0.05, suffix: "" })}
                        {respRow("letterSpacing", "Espaciado entre letras", { min: -4, max: 16, step: 0.5 })}
                        <ControlGroup label="Alineación">
                            <Segmented
                                value={rl.align || ""}
                                onChange={(v: string) => (v ? setResp("align", v) : clearResp("align"))}
                                options={[
                                    { value: "", label: "Heredada", icon: "undo" },
                                    { value: "left", label: "Izquierda", icon: "format_align_left" },
                                    { value: "center", label: "Centro", icon: "format_align_center" },
                                    { value: "right", label: "Derecha", icon: "format_align_right" },
                                    { value: "justify", label: "Justificado", icon: "format_align_justify" },
                                ]}
                            />
                            <p className="text-[10px] text-[var(--ed-outline)]">
                                {isSet(rl.align)
                                    ? "Ajuste propio de este dispositivo"
                                    : isSet(inh("align"))
                                      ? `Heredada: ${inh("align")}`
                                      : "Heredada (sin valor propio)"}
                            </p>
                        </ControlGroup>
                    </AccordionItem>
                </>
            )}
        </div>
    );
}

