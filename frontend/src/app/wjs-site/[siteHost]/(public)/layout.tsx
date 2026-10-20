// Multisite: the public chrome of another site of the network — the same layout as the main site's
// (public) tree, rendered for the site the root layout above declared. Every layout, page and metadata
// function of this tree declares the site itself (they render concurrently, so none can rely on another).
import { notFound } from "next/navigation";
import PublicLayout from "@/app/(public)/_chrome/PublicLayout";
import { setRequestSite } from "@/lib/server-api";

export default async function SitePublicLayout({ children, params }: { children: React.ReactNode; params: Promise<{ siteHost: string }> }) {
    if (!setRequestSite((await params).siteHost)) notFound();
    return <PublicLayout>{children}</PublicLayout>;
}
