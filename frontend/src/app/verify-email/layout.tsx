import { inter } from "../fonts";

// Re-applies Inter to this standalone (non-public, non-admin) tree: the root <body> carries only
// inter.variable, so without this wrapper the page would fall back to the browser default font.
// Same wrapper as /login and /reset-password — the public auth screens share one shell.
export default function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
    return <div className={inter.className}>{children}</div>;
}
