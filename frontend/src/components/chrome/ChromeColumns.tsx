// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". The multi-column footer: a CSS grid whose cells are the blocks of its "items" slot
// (usually one ChromeRow with direction "column" per cell — heading over links). One column on phones,
// two on tablets, the chosen count from lg up, so a 4-column footer never squeezes onto a phone.
import { GAP_CLASS } from "./ChromeRow";

// Static literal maps so Tailwind sees every class (no interpolation).
export const COLUMNS_CLASS: Record<"2" | "3" | "4" | "5", string> = {
    "2": "grid-cols-1 md:grid-cols-2",
    "3": "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    "4": "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
    "5": "grid-cols-1 md:grid-cols-2 lg:grid-cols-5",
};

export interface ChromeColumnsViewProps {
    columns?: "2" | "3" | "4" | "5";
    gap?: "sm" | "md" | "lg";
    children?: React.ReactNode;
}

export function chromeColumnsClass({ columns = "3", gap = "lg" }: Omit<ChromeColumnsViewProps, "children">): string {
    return `wjs-chrome-columns grid w-full items-start ${COLUMNS_CLASS[columns] ?? COLUMNS_CLASS["3"]} ${GAP_CLASS[gap] ?? GAP_CLASS.lg}`;
}

export default function ChromeColumns({ children, ...props }: ChromeColumnsViewProps) {
    return <div className={chromeColumnsClass(props)}>{children}</div>;
}
