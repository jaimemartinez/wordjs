/**
 * PURE helpers behind the shared block wrapper (withSharedBlockFields) — extracted so the PUBLIC
 * server renderer can compute the same wrapper (visibility classes, appearance box, animation
 * classes) without importing the "use client" field modules. The field modules re-export from
 * here, so every existing import path keeps working and there is exactly ONE implementation.
 *
 * NO "use client", no hooks, no React runtime — types only.
 */
import type { CSSProperties } from "react";

// ── Visibility (VisibilityField) ──────────────────────────────────────────
export type Hide = { mobile?: boolean; tablet?: boolean; desktop?: boolean };

export const hideClasses = (hide?: Hide): string =>
    [hide?.mobile && "wjs-hide-mobile", hide?.tablet && "wjs-hide-tablet", hide?.desktop && "wjs-hide-desktop"]
        .filter(Boolean)
        .join(" ");

// ── Animation (AnimationField) ────────────────────────────────────────────
export type AnimSpec = {
    type?:
        | ""
        | "fade"
        | "fade-up"
        | "fade-down"
        | "fade-left"
        | "fade-right"
        | "zoom"
        | "zoom-out"
        | "blur"
        | "rise"
        | "flip"
        | "reveal"
        | "swing";
    duration?: number;
    delay?: number;
    // ── Interacción de scroll (independiente de la entrada) ─────────────
    // Scroll-driven effect via CSS `animation-timeline: view()`: progress follows the element's own
    // journey through the viewport, forwards AND backwards, with no JS and no observer. Browsers
    // without support simply skip it (@supports-gated in wordjs-ui.css).
    scroll?: "" | "parallax" | "fade" | "scale" | "rotate";
    /** Intensity 0–100 (default 30). Quantised to steps of ten — see animClasses. */
    scrollAmount?: number;
};

/**
 * Classes the shared wrapper puts on the block for its animations.
 *
 * The scroll intensity travels as a DISCRETE class (`wjs-scroll-amt-10` … `-100`, steps of ten,
 * round(scrollAmount/10)*10 clamped to 10..100) rather than a CSS variable: the
 * withSharedBlockFields wrapper only applies this function's output as className — it has no
 * per-var style channel for this field — so each step class pins `--wjs-scroll-amt` in
 * wordjs-ui.css and the keyframes calc() from it.
 */
export const animClasses = (anim?: AnimSpec): string => {
    const cls: string[] = [];
    if (anim?.type) cls.push("wjs-anim", `wjs-anim-${anim.type}`);
    if (anim?.scroll) {
        const amt = Math.min(100, Math.max(10, Math.round((Number(anim.scrollAmount ?? 30) || 0) / 10) * 10));
        cls.push("wjs-scroll", `wjs-scroll-${anim.scroll}`, `wjs-scroll-amt-${amt}`);
    }
    return cls.join(" ");
};

// ── Appearance (AppearanceField) ──────────────────────────────────────────
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

export const RESP_PROPS: (keyof ResponsiveLook)[] = [
    "padY", "padX", "mt", "mb", "maxWidth", "minHeight",
    "fontSize", "lineHeight", "letterSpacing", "align", "radius",
];

/**
 * Format one responsive override value for its CSS variable. Prop-aware because the subset mixes
 * units and "zero" semantics: 0 is a real value for spacing/radius (0px), "inherit from desktop"
 * for fontSize/lineHeight (mirrors the base UI's "0 = heredado"), and an explicit REMOVAL of the
 * desktop constraint for maxWidth/minHeight (`none`/`auto` travel through the var just fine).
 */
export const fmtResp = (prop: keyof ResponsiveLook, v: any): string | undefined => {
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

/**
 * Layered shadows — two-stop, the way design systems do it (never a single flat blur).
 *
 * sm/md/lg route through the framework's elevation tokens (declared in wordjs-ui.css `:root`,
 * overridable per theme) so a preset picked by the author still follows the theme's elevation
 * design — a literal here was a lock no theme could open. The old literals stay as the var()
 * FALLBACK, byte-identical, so any context without ui.css renders exactly as before.
 * xl/2xl/soft/inner stay literal on purpose: the token family has no --wjs-shadow-xl/…, and
 * inventing tokens the manifest (generated from ui.css) cannot see would be unpromised surface.
 */
export const SHADOWS: Record<string, string> = {
    sm: "var(--wjs-shadow-sm, 0 1px 2px rgb(0 0 0 / .06), 0 1px 3px rgb(0 0 0 / .10))",
    md: "var(--wjs-shadow-md, 0 4px 6px -1px rgb(0 0 0 / .10), 0 2px 4px -2px rgb(0 0 0 / .10))",
    lg: "var(--wjs-shadow-lg, 0 10px 15px -3px rgb(0 0 0 / .10), 0 4px 6px -4px rgb(0 0 0 / .10))",
    xl: "0 20px 25px -5px rgb(0 0 0 / .12), 0 8px 10px -6px rgb(0 0 0 / .10)",
    "2xl": "0 25px 50px -12px rgb(0 0 0 / .25)",
    soft: "0 2px 8px rgb(0 0 0 / .04), 0 12px 32px -8px rgb(0 0 0 / .12)",
    inner: "inset 0 2px 4px 0 rgb(0 0 0 / .06)",
};

export const isSet = (v: any) => v !== undefined && v !== null && v !== "";

/**
 * Translate a spec into what the wrapper element needs. Returns BOTH halves of the split described
 * in AppearanceField's header: `style` (inline custom properties + static declarations) and
 * `className` (behaviour that inline styles cannot express).
 *
 * `hasBox` reports whether anything at all was set — the wrapper stays `display: contents`
 * (zero layout footprint) when it is false, so untouched blocks are unaffected.
 */
export function appearanceToStyle(look?: Appearance): {
    style: CSSProperties;
    className: string;
    hasBox: boolean;
    overlay: CSSProperties | null;
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
