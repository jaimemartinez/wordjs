import { inter } from "../fonts";

// Re-applies Inter to this standalone (non-public, non-admin) tree: the root <body> carries only
// inter.variable, so without this wrapper the page would fall back to the browser default font.
// Covers every portal (conference, client portals) without touching their own pages.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
    return <div className={inter.className}>{children}</div>;
}
