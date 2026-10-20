// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". A short heading — a footer column title. SECURITY: plain text, rendered as a React
// text node (always escaped). h3 by default: themes colour chrome headings through
// `footer h3, footer h4` (their global h1–h6 rule paints the dark body ink), the levels Footer.tsx
// always used, so an h2 would come out dark-on-dark in most footers.
export interface ChromeHeadingViewProps {
    text: string;
    level?: "h2" | "h3" | "h4";
}

export default function ChromeHeading({ text, level = "h3" }: ChromeHeadingViewProps) {
    const Tag = level === "h2" || level === "h4" ? level : "h3";
    return <Tag className="wjs-chrome-heading wjs-chrome-block-title font-bold m-0">{text}</Tag>;
}
