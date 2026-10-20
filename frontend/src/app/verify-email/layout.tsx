import { inter } from "../fonts";
import RootDocument, { rootMetadata } from "../_root/RootDocument";

// A root layout (there is no app/layout.tsx — see _root/RootDocument.tsx): the document and its metadata.
export const generateMetadata = rootMetadata;

// Re-applies Inter to this standalone (non-public, non-admin) tree: the root <body> carries only
// inter.variable, so without this wrapper the page would fall back to the browser default font.
// Same wrapper as /login and /reset-password — the public auth screens share one shell.
export default async function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
    return RootDocument({ children: <div className={inter.className}>{children}</div> });
}
