// Multisite: `/robots.txt` of another site of the network; the handler reads the `siteHost` param.
export { GET } from "@/app/(public)/robots.txt/route";

export const revalidate = 86400;
export async function generateStaticParams() { return []; }
