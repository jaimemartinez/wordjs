// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". A fixed square gap usable in both row and column flows.

// Static literal map so Tailwind sees every class (no interpolation).
const SIZE_CLASS: Record<"sm" | "md" | "lg", string> = {
    sm: "w-2 h-2",
    md: "w-4 h-4",
    lg: "w-8 h-8",
};

export interface ChromeSpacerViewProps {
    size?: "sm" | "md" | "lg";
}

export default function ChromeSpacer({ size = "md" }: ChromeSpacerViewProps) {
    return <span aria-hidden="true" className={`wjs-chrome-spacer inline-block shrink-0 ${SIZE_CLASS[size]}`} />;
}
