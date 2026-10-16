// Multisite: `/sitemap/[chunk]` of another site of the network; the handler reads the `siteHost` param.
export { GET } from "@/app/(public)/sitemap/[chunk]/route";

export const revalidate = 3600;
export async function generateStaticParams() { return []; }
