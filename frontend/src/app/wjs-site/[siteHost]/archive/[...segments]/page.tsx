// Multisite: `/archive/[...segments]` of another site of the network (see lib/multisiteRoute).
import Base, { generateMetadata as baseMetadata } from "@/app/(public)/archive/[...segments]/page";
import { sitePage, siteMetadata } from "@/lib/multisiteRoute";

export const revalidate = 60;
// Rendered on first request, then cached and revalidated like the main site's pages (ISR).
export async function generateStaticParams() { return []; }

export const generateMetadata = siteMetadata(baseMetadata);
export default sitePage(Base);
