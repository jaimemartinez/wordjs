/**
 * Multisite: the pages of the `wjs-site/[siteHost]` route tree are the (public) pages, rendered for
 * another site of the network. src/proxy.ts rewrites that site's requests here; each page, layout and
 * metadata function first declares the site (setRequestSite), so every data read below it is that
 * site's (lib/server-api). A `siteHost` that is not a hostname is a 404, never the main site's page.
 *
 * Server-only: imported by the route files of app/wjs-site.
 */
import type { ComponentType } from "react";
import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import { setRequestSite } from "@/lib/server-api";

// The (public) components each take their own params shape; the site tree hands them the same props,
// with `siteHost` alongside, which they ignore.
type AnyProps = any;
type SiteProps = { params: Promise<Record<string, string | string[] | undefined>>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

async function declareSite(props: SiteProps): Promise<void> {
    const params = props && props.params ? await props.params : {};
    if (!setRequestSite(params.siteHost)) notFound();
}

/** The site tree's page for one (public) page component. */
export function sitePage(Base: ComponentType<AnyProps>) {
    return async function SitePage(props: SiteProps) {
        await declareSite(props);
        return <Base {...props} />;
    };
}

/** The site tree's generateMetadata for one (public) page's generateMetadata. */
export function siteMetadata(base: (props: AnyProps, parent: ResolvingMetadata) => Promise<Metadata> | Metadata) {
    return async function generateMetadata(props: SiteProps, parent: ResolvingMetadata): Promise<Metadata> {
        await declareSite(props);
        return base(props, parent);
    };
}
