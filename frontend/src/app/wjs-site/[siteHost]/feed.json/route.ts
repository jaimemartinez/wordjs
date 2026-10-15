// Multisite: `/feed.json` of another site of the network; the handler reads the `siteHost` param.
export { GET } from "@/app/(public)/feed.json/route";

export const revalidate = 900;
export async function generateStaticParams() { return []; }
