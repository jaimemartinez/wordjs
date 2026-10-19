/**
 * Multisite: the layout of every page of another site of the network. src/proxy.ts rewrites that
 * site's public requests to this tree (`/wjs-site/<host>/…`, never visible in the browser), and this
 * layout declares the site for everything it renders (lib/server-api setRequestSite) before handing over
 * to the (public) layout — the same chrome, the same theme, that site's settings and menus.
 *
 * The root layout above it (app/layout.tsx) is shared with the main site and takes no params, so the
 * head it builds is the main site's; the metadata here replaces every field of it that names a site (the
 * title, the description, the icon and the base canonical URLs resolve against). The document's lang /
 * dir are set on this tree's wrapper from this site's own settings.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PublicLayout from "@/app/(public)/layout";
import { getSettings, setRequestSite } from "@/lib/server-api";
import { resolveDocumentLanguage } from "@/lib/documentLanguage";

type Params = { params: Promise<{ siteHost: string }> };

// No site is known at build time: every site's pages render on their first request and are then cached
// under their own path (ISR), like the main site's.
export async function generateStaticParams() {
    return [];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
    if (!setRequestSite((await params).siteHost)) notFound();
    const settings = await getSettings();
    const title = settings?.blogname || "WordJS";
    const meta: Metadata = {
        title: { default: title, template: `%s | ${title}` },
        description: settings?.blogdescription || "",
        icons: { icon: settings?.site_icon || "/favicon.ico", apple: settings?.site_icon || "/favicon.ico" },
    };
    const configuredUrl = settings?.siteurl || settings?.home;
    if (configuredUrl && /^https?:\/\//i.test(configuredUrl)) {
        try { meta.metadataBase = new URL(configuredUrl); } catch { /* malformed: relative URLs stay relative */ }
    }
    return meta;
}

export default async function SiteLayout({ children, params }: Params & { children: React.ReactNode }) {
    if (!setRequestSite((await params).siteHost)) notFound();
    const settings = await getSettings();
    const { lang, dir } = resolveDocumentLanguage(settings);
    return (
        <div lang={lang} dir={dir} data-wjs-site="" className="contents">
            <PublicLayout>{children}</PublicLayout>
        </div>
    );
}
