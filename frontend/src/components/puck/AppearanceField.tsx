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

export type Appearance = {
    // ── Fondo ───────────────────────────────────────────────────────────
    bg?: "" | "color" | "gradient" | "image" | "glass";
    bgColor?: string;
    gradFrom?: string;
    gradVia?: string;
    gradTo?: string;
    gradAngle?: number;
    gradAnimate?: boolean;
    bgImage?: string;
    bgSize?: string;
    bgPos?: string;
    bgFixed?: boolean;
    overlay?: number;
    overlayColor?: string;
    glassBlur?: number;
    glassTint?: string;
    // ── Borde ───────────────────────────────────────────────────────────
    borderWidth?: number;
    borderStyle?: string;
    borderColor?: string;
    radius?: number;
    // ── Sombra ──────────────────────────────────────────────────────────
    shadow?: string;
    shadowColor?: string;
    shadowX?: number;
    shadowY?: number;
    shadowBlur?: number;
    shadowSpread?: number;
    // ── Caja ────────────────────────────────────────────────────────────
    padY?: number;
    padX?: number;
    mt?: number;
    mb?: number;
    maxWidth?: number;
    minHeight?: number;
    // ── Tipografía ──────────────────────────────────────────────────────
    color?: string;
    fontSize?: number;
    fontWeight?: string;
    fontFamily?: string;
    lineHeight?: number;
    letterSpacing?: number;
    align?: string;
    transform?: string;
    // ── Movimiento ──────────────────────────────────────────────────────
    hover?: string;
    hoverAmount?: number;
    hoverSpeed?: number;
    hoverColor?: string;
    // ── Responsive (overrides por dispositivo) ──────────────────────────
    // Webflow-style breakpoint values, restricted to the numeric/textual box+type subset in
    // ResponsiveLook. Desktop is the base spec above; `tb` overrides 768–1023px and cascades DOWN
    // to mobile; `mo` refines <768px. NAMING: the mobile bucket is `mo`, NOT `mb` — `mb` has been
    // margin-bottom (a number) since v1 and lives in saved pages, so it can never be reused. The
    // CSS custom properties still use the -tb/-mb suffixes (see wordjs-ui.css "RESPONSIVE
    // OVERRIDES"), where no collision exists.
    tb?: ResponsiveLook;
    mo?: ResponsiveLook;
};

/**
 * The subset of Appearance that may vary per breakpoint. Deliberately NOT Partial<Appearance>:
 * colours, backgrounds, shadows and motion stay desktop-only (one look per block, sizes adapt),
 * and a nested `tb` inside `tb` must be unrepresentable.
 */
export type ResponsiveLook = Pick<
    Appearance,
    | "padY"
    | "padX"
    | "mt"
    | "mb"
    | "maxWidth"
    | "minHeight"
    | "fontSize"
    | "lineHeight"
    | "letterSpacing"
    | "align"
    | "radius"
>;

const RESP_PROPS: (keyof ResponsiveLook)[] = [
    "padY", "padX", "mt", "mb", "maxWidth", "minHeight",
    "fontSize", "lineHeight", "letterSpacing", "align", "radius",
];

/**
 * Format one responsive override value for its CSS variable. Prop-aware because the subset mixes
 * units and "zero" semantics: 0 is a real value for spacing/radius (0px), "inherit from desktop"
 * for fontSize/lineHeight (mirrors the base UI's "0 = heredado"), and an explicit REMOVAL of the
 * desktop constraint for maxWidth/minHeight (`none`/`auto` travel through the var just fine).
 */
const fmtResp = (prop: keyof ResponsiveLook, v: any): string | undefined => {
    if (!isSet(v)) return undefined;
    if (prop === "align") return String(v);
    const n = Number(v);
    if (prop === "lineHeight") return n > 0 ? String(n) : undefined;
    if (prop === "fontSize") return n > 0 ? `${n}px` : undefined;
    if (prop === "maxWidth") return n > 0 ? `${n}px` : "none";
    if (prop === "minHeight") return n > 0 ? `${n}px` : "auto";
    return `${n}px`; // padY/padX/mt/mb/radius/letterSpacing — 0px is meaningful
};

/**
 * Effective DESKTOP value of a responsive prop — exactly what the base branch of appearanceToStyle
 * applies for it. When desktop never set the prop, a responsive override still needs something to
 * cascade from, so this returns the NEUTRAL value that leaves the element as it was: 0px for
 * spacing/radius, none/auto for the size caps, 1em (= the inherited size) for fontSize, normal for
 * lineHeight/letterSpacing, start for align. Documented consequence: a responsive override of a
 * prop with no desktop value starts from that neutral, not from "whatever the theme did".
 */
const dtResp = (a: Appearance, p: keyof ResponsiveLook): string => {
    switch (p) {
        case "padY": return isSet(a.padY) || isSet(a.padX) ? `${a.padY ?? 0}px` : "0px";
        case "padX": return isSet(a.padY) || isSet(a.padX) ? `${a.padX ?? 0}px` : "0px";
        case "mt": return isSet(a.mt) ? `${a.mt}px` : "0px";
        case "mb": return isSet(a.mb) ? `${a.mb}px` : "0px";
        case "maxWidth": return isSet(a.maxWidth) && Number(a.maxWidth) > 0 ? `${a.maxWidth}px` : "none";
        case "minHeight": return isSet(a.minHeight) && Number(a.minHeight) > 0 ? `${a.minHeight}px` : "auto";
        case "fontSize": return isSet(a.fontSize) ? `${a.fontSize}px` : "1em";
        case "lineHeight": return isSet(a.lineHeight) ? String(a.lineHeight) : "normal";
        case "letterSpacing": return isSet(a.letterSpacing) ? `${a.letterSpacing}px` : "normal";
        case "align": return isSet(a.align) ? String(a.align) : "start";
        case "radius": return isSet(a.radius) ? `${a.radius}px` : "0px";
    }
};

/** Layered shadows — two-stop, the way design systems do it (never a single flat blur). */
const SHADOWS: Record<string, string> = {
    sm: "0 1px 2px rgb(0 0 0 / .06), 0 1px 3px rgb(0 0 0 / .10)",
    md: "0 4px 6px -1px rgb(0 0 0 / .10), 0 2px 4px -2px rgb(0 0 0 / .10)",
    lg: "0 10px 15px -3px rgb(0 0 0 / .10), 0 4px 6px -4px rgb(0 0 0 / .10)",
    xl: "0 20px 25px -5px rgb(0 0 0 / .12), 0 8px 10px -6px rgb(0 0 0 / .10)",
    "2xl": "0 25px 50px -12px rgb(0 0 0 / .25)",
    soft: "0 2px 8px rgb(0 0 0 / .04), 0 12px 32px -8px rgb(0 0 0 / .12)",
    inner: "inset 0 2px 4px 0 rgb(0 0 0 / .06)",
};

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

const isSet = (v: any) => v !== undefined && v !== null && v !== "";

/**
 * Translate a spec into what the wrapper element needs. Returns BOTH halves of the split described
 * in the file header: `style` (inline custom properties + static declarations) and `className`
 * (behaviour that inline styles cannot express).
 *
 * `hasBox` reports whether anything at all was set — the wrapper stays `display: contents`
 * (zero layout footprint) when it is false, so untouched blocks are unaffected.
 */
export function appearanceToStyle(look?: Appearance): {
    style: React.CSSProperties;
    className: string;
    hasBox: boolean;
    overlay: React.CSSProperties | null;
} {
    const a = look || {};
    const s: any = {};
    const cls: string[] = [];

    // ── Responsive (valores por breakpoint) — JS-RESOLVED CASCADE ───────
    // A media query cannot know whether THIS element has a -tb/-mb override, so the fallback logic
    // ("tablet inherits desktop, mobile inherits tablet") is resolved HERE, never in CSS. For every
    // prop with any override we emit the COMPLETE inline chain
    //     --wjs-r-<prop>      = effective desktop value (what the base branch below applies)
    //     --wjs-r-<prop>-tb   = tb ?? desktop
    //     --wjs-r-<prop>-mb   = mo ?? tb ?? desktop     (CSS suffix is -mb; the FIELD is `mo`)
    // and REPLACE the prop's direct inline declaration with `var(--wjs-r-<prop>)` — a direct value
    // in the style attribute would beat everything, so it must be the var() version. The stylesheet
    // side (wordjs-ui.css "RESPONSIVE OVERRIDES") then only re-points the base var per breakpoint
    // under `.wjs-resp`. Inline chains also shadow inherited --wjs-r-* from nested styled parents.
    // When `tb`/`mo` are empty this whole pass is inert: the output is byte-identical to before
    // (saved pages must never re-render differently).
    const tbOv: Partial<Record<keyof ResponsiveLook, string>> = {};
    const moOv: Partial<Record<keyof ResponsiveLook, string>> = {};
    for (const p of RESP_PROPS) {
        const t = fmtResp(p, a.tb?.[p]);
        const m = fmtResp(p, a.mo?.[p]);
        if (t !== undefined) tbOv[p] = t;
        if (m !== undefined) moOv[p] = m;
    }
    const respActive = Object.keys(tbOv).length > 0 || Object.keys(moOv).length > 0;
    const hasResp = (p: keyof ResponsiveLook) => respActive && (p in tbOv || p in moOv);
    // padding is ONE declaration for two props — if either side varies, both travel through vars.
    const respPad = hasResp("padY") || hasResp("padX");

    // ── Fondo ───────────────────────────────────────────────────────────
    if (a.bg === "color" && isSet(a.bgColor)) {
        s.background = a.bgColor;
    } else if (a.bg === "gradient") {
        const from = a.gradFrom || "var(--wjs-color-primary, #2563eb)";
        const to = a.gradTo || "#111827";
        const stops = isSet(a.gradVia) ? `${from}, ${a.gradVia}, ${to}` : `${from}, ${to}`;
        s.backgroundImage = `linear-gradient(${a.gradAngle ?? 135}deg, ${stops})`;
        if (a.gradAnimate) cls.push("wjs-grad-animate");
    } else if (a.bg === "image" && isSet(a.bgImage)) {
        s.backgroundImage = `url(${a.bgImage})`;
        s.backgroundSize = a.bgSize || "cover";
        s.backgroundPosition = a.bgPos || "center";
        s.backgroundRepeat = "no-repeat";
        // Parallax-ish: cheap, GPU-friendly, and ignored on touch platforms by design.
        if (a.bgFixed) s.backgroundAttachment = "fixed";
    } else if (a.bg === "glass") {
        s.background = a.glassTint || "rgb(255 255 255 / .08)";
        s["--wjs-glass-blur"] = `${a.glassBlur ?? 12}px`;
        cls.push("wjs-glass");
    }

    // ── Borde ───────────────────────────────────────────────────────────
    if (isSet(a.borderWidth) && Number(a.borderWidth) > 0) {
        s.borderWidth = `${a.borderWidth}px`;
        s.borderStyle = a.borderStyle || "solid";
        s.borderColor = a.borderColor || "rgb(0 0 0 / .10)";
    }
    if (hasResp("radius")) s.borderRadius = "var(--wjs-r-radius)";
    else if (isSet(a.radius)) s.borderRadius = `${a.radius}px`;

    // ── Sombra ──────────────────────────────────────────────────────────
    if (a.shadow === "custom") {
        const c = a.shadowColor || "rgb(0 0 0 / .18)";
        s.boxShadow = `${a.shadowX ?? 0}px ${a.shadowY ?? 12}px ${a.shadowBlur ?? 32}px ${a.shadowSpread ?? -8}px ${c}`;
    } else if (isSet(a.shadow) && SHADOWS[a.shadow!]) {
        s.boxShadow = SHADOWS[a.shadow!];
    }

    // ── Caja ────────────────────────────────────────────────────────────
    if (respPad) s.padding = "var(--wjs-r-padY) var(--wjs-r-padX)";
    else if (isSet(a.padY) || isSet(a.padX)) s.padding = `${a.padY ?? 0}px ${a.padX ?? 0}px`;
    if (hasResp("mt")) s.marginTop = "var(--wjs-r-mt)";
    else if (isSet(a.mt)) s.marginTop = `${a.mt}px`;
    if (hasResp("mb")) s.marginBottom = "var(--wjs-r-mb)";
    else if (isSet(a.mb)) s.marginBottom = `${a.mb}px`;
    if (hasResp("maxWidth")) {
        s.maxWidth = "var(--wjs-r-maxWidth)";
        // Same lateral centring the base applies. Kept unconditional across breakpoints: where the
        // var resolves to `none` the block is full-width, so `auto` margins compute to 0 anyway.
        s.marginLeft = "auto";
        s.marginRight = "auto";
    } else if (isSet(a.maxWidth) && Number(a.maxWidth) > 0) {
        s.maxWidth = `${a.maxWidth}px`;
        s.marginLeft = "auto";
        s.marginRight = "auto";
    }
    if (hasResp("minHeight")) s.minHeight = "var(--wjs-r-minHeight)";
    else if (isSet(a.minHeight) && Number(a.minHeight) > 0) s.minHeight = `${a.minHeight}px`;

    // ── Tipografía (inherits into the block's own markup) ────────────────
    if (isSet(a.color)) s.color = a.color;
    if (hasResp("fontSize")) s.fontSize = "var(--wjs-r-fontSize)";
    else if (isSet(a.fontSize)) s.fontSize = `${a.fontSize}px`;
    if (isSet(a.fontWeight)) s.fontWeight = a.fontWeight;
    if (isSet(a.fontFamily)) s.fontFamily = a.fontFamily;
    if (hasResp("lineHeight")) s.lineHeight = "var(--wjs-r-lineHeight)";
    else if (isSet(a.lineHeight)) s.lineHeight = a.lineHeight;
    if (hasResp("letterSpacing")) s.letterSpacing = "var(--wjs-r-letterSpacing)";
    else if (isSet(a.letterSpacing)) s.letterSpacing = `${a.letterSpacing}px`;
    if (hasResp("align")) s.textAlign = "var(--wjs-r-align)";
    else if (isSet(a.align)) s.textAlign = a.align;
    if (isSet(a.transform)) s.textTransform = a.transform;

    // ── Movimiento ──────────────────────────────────────────────────────
    if (isSet(a.hover)) {
        cls.push("wjs-fx", `wjs-hover-${a.hover}`);
        s["--wjs-hover-amt"] = `${a.hoverAmount ?? 6}`;
        s["--wjs-hover-speed"] = `${a.hoverSpeed ?? 300}ms`;
        s["--wjs-hover-color"] = a.hoverColor || "var(--wjs-color-primary, #2563eb)";
    }

    // ── Responsive: emit the resolved var chains (see cascade note above) ─
    if (respActive) {
        cls.push("wjs-resp");
        const emit = (p: keyof ResponsiveLook) => {
            const base = dtResp(a, p);
            s[`--wjs-r-${p}`] = base;
            s[`--wjs-r-${p}-tb`] = tbOv[p] ?? base;
            s[`--wjs-r-${p}-mb`] = moOv[p] ?? tbOv[p] ?? base;
        };
        for (const p of RESP_PROPS) {
            if (p === "padY" || p === "padX" ? respPad : hasResp(p)) emit(p);
        }
    }

    // A background image/gradient needs its own dimming layer; doing it with a nested absolute
    // element (rather than stacked background-images) keeps the author's image untouched and lets
    // the overlay colour be any value, including a semi-transparent brand tint.
    const overlay =
        isSet(a.overlay) && Number(a.overlay) > 0
            ? {
                  position: "absolute" as const,
                  inset: 0,
                  borderRadius: "inherit",
                  pointerEvents: "none" as const,
                  background: a.overlayColor || "#000",
                  opacity: Math.min(Math.max(Number(a.overlay), 0), 1),
              }
            : null;

    const hasBox = Object.keys(s).length > 0 || cls.length > 0;
    if (overlay) s.position = s.position || "relative";
    // A radius only clips if the box actually hides the overflow.
    if (isSet(a.radius) && (a.bg === "image" || a.bg === "gradient" || overlay)) s.overflow = "hidden";

    return { style: s, className: cls.join(" "), hasBox, overlay };
}

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

