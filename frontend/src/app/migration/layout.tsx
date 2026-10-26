import { inter } from "../fonts";
import RootDocument, { rootMetadata } from "../_root/RootDocument";

// A root layout (there is no app/layout.tsx — see _root/RootDocument.tsx): the document and its metadata.
export const generateMetadata = rootMetadata;

// Rendered per request: its scripts carry the nonce src/proxy.ts puts in this document's Content-Security-Policy
// (lib/contentSecurityPolicy.ts DYNAMIC_DOCUMENT). A prerendered copy would carry none, and its scripts would not run.
export const dynamic = "force-dynamic";

// Re-applies Inter to this standalone (non-public, non-admin) tree: the root <body> carries only
// inter.variable, so without this wrapper the page would fall back to the browser default font.
export default async function MigrationLayout({ children }: { children: React.ReactNode }) {
    return RootDocument({ children: <div className={inter.className} data-wjs-system-screen="">{children}</div> });
}
