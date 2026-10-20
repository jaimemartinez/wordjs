// Multisite: `/sitemap.xml` of another site of the network; the handler reads the `siteHost` param.
export { GET } from "@/app/(public)/sitemap.xml/route";

export const revalidate = 3600;
export async function generateStaticParams() { return []; }
