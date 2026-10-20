// Multisite: `/author/[slug]/feed.xml` of another site of the network; the handler reads the `siteHost` param.
export { GET } from "@/app/(public)/author/[slug]/feed.xml/route";

export const revalidate = 900;
export async function generateStaticParams() { return []; }
