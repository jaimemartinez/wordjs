// Multisite: `/feed.atom` of another site of the network; the handler reads the `siteHost` param.
export { GET } from "@/app/(public)/feed.atom/route";

export const revalidate = 900;
export async function generateStaticParams() { return []; }
