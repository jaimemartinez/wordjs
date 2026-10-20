// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". The ONLY container block: ChromeRenderer renders its "items" slot recursively and
// passes them as children.

// Static literal maps so Tailwind sees every class (no interpolation). Exported: the admin chrome
// editor applies the SAME classes to Puck's slot wrapper so the canvas flexes like the real row.
export const ALIGN_CLASS: Record<"start" | "center" | "end" | "between", string> = {
    start: "justify-start",
    center: "justify-center",
    end: "justify-end",
    between: "justify-between",
};
export const GAP_CLASS: Record<"sm" | "md" | "lg", string> = {
    sm: "gap-2",
    md: "gap-4",
    lg: "gap-8",
};

// direction "column" stacks the row's blocks vertically (a footer column: heading over links).
// `align` then positions them along the CROSS axis, so it maps to items-*, not justify-*.
export const COLUMN_ALIGN_CLASS: Record<"start" | "center" | "end" | "between", string> = {
    start: "items-start",
    center: "items-center",
    end: "items-end",
    between: "items-stretch",
};
// stack: a horizontal row that becomes a column below a breakpoint (per-breakpoint layout).
export const STACK_CLASS: Record<"never" | "mobile" | "tablet", string> = {
    never: "",
    mobile: " max-md:flex-col max-md:items-start",
    tablet: " max-lg:flex-col max-lg:items-start",
};
// tone: a band with its own surface — what makes a second header row (a top bar) read as one.
export const TONE_CLASS: Record<"none" | "muted" | "primary" | "inverse", string> = {
    none: "",
    muted: " wjs-chrome-tone-muted px-4 py-2 rounded-lg bg-[var(--wjs-bg-muted,#f3f4f6)]",
    primary: " wjs-chrome-tone-primary px-4 py-2 rounded-lg bg-[var(--wjs-color-primary,#2F6D86)] text-[var(--wjs-color-on-primary,#ffffff)]",
    inverse: " wjs-chrome-tone-inverse px-4 py-2 rounded-lg bg-[var(--wjs-color-text-main,#111827)] text-[var(--wjs-bg-surface,#ffffff)]",
};

export interface ChromeRowViewProps {
    align?: "start" | "center" | "end" | "between";
    gap?: "sm" | "md" | "lg";
    wrap?: boolean;
    direction?: "row" | "column";
    stack?: "never" | "mobile" | "tablet";
    tone?: "none" | "muted" | "primary" | "inverse";
    children?: React.ReactNode;
}

/** The row's class list — shared with the editor canvas so what you compose is what ships. */
export function chromeRowClass({ align = "start", gap = "md", wrap = false, direction = "row", stack = "never", tone = "none" }: Omit<ChromeRowViewProps, "children">): string {
    const toneClass = TONE_CLASS[tone] ?? "";
    if (direction === "column") {
        return `wjs-chrome-row wjs-chrome-row--column flex flex-col ${COLUMN_ALIGN_CLASS[align] ?? COLUMN_ALIGN_CLASS.start} ${GAP_CLASS[gap] ?? GAP_CLASS.md}${toneClass}`;
    }
    return `wjs-chrome-row flex items-center w-full ${ALIGN_CLASS[align] ?? ALIGN_CLASS.start} ${GAP_CLASS[gap] ?? GAP_CLASS.md}${wrap ? " flex-wrap" : ""}${STACK_CLASS[stack] ?? ""}${toneClass}`;
}

export default function ChromeRow({ children, ...props }: ChromeRowViewProps) {
    return <div className={chromeRowClass(props)}>{children}</div>;
}
