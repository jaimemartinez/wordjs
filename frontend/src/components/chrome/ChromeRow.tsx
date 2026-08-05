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

export interface ChromeRowViewProps {
    align?: "start" | "center" | "end" | "between";
    gap?: "sm" | "md" | "lg";
    wrap?: boolean;
    children?: React.ReactNode;
}

export default function ChromeRow({ align = "start", gap = "md", wrap = false, children }: ChromeRowViewProps) {
    return (
        <div className={`wjs-chrome-row flex items-center w-full ${ALIGN_CLASS[align]} ${GAP_CLASS[gap]}${wrap ? " flex-wrap" : ""}`}>
            {children}
        </div>
    );
}
