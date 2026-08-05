// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". SECURITY: the text renders as a normal React text node — ALWAYS escaped, never
// dangerouslySetInnerHTML. Color inherits from the surrounding chrome (header/footer) by design.
export interface ChromeTextViewProps {
    text: string;
}

export default function ChromeText({ text }: ChromeTextViewProps) {
    return <span className="wjs-chrome-text break-words">{text}</span>;
}
