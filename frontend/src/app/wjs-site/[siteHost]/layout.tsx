/**
 * Multisite: the ROOT LAYOUT of another site of the network. src/proxy.ts has next.config's rewrite send
 * that site's public pages and sign-in screens to this tree (`/wjs-site/<host>/…`, never visible in the
 * browser), and this layout declares the site (lib/server-api setRequestSite) from its route param before
 * it reads anything — so the document itself is that site's: `<html lang dir>` from its locale options,
 * the @font-face rules of its fonts, its name and title template, its icon and canonical base. There is
 * no app/layout.tsx above it (see _root/RootDocument.tsx), so nothing of the main site's reaches it.
 *
 * Below it, `(public)/layout.tsx` adds the public chrome; `login`, `register`, `reset-password` and
 * `verify-email` are the site's sign-in screens (the main ones' pages, in this site's document).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import RootDocument, { rootMetadata } from "@/app/_root/RootDocument";
import { setRequestSite } from "@/lib/server-api";

type Params = { params: Promise<{ siteHost: string }> };

// No site is known at build time: every site's pages render on their first request and are then cached
// under their own path (ISR), like the main site's.
export async function generateStaticParams() {
    return [];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    if (!setRequestSite((await params).siteHost)) notFound();
    return rootMetadata();
}

export default async function SiteRootLayout({ children, params }: Params & { children: React.ReactNode }) {
    if (!setRequestSite((await params).siteHost)) notFound();
    return RootDocument({ children: <div data-wjs-site="" className="contents">{children}</div> });
}
