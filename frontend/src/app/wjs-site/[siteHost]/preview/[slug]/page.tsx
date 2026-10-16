// Multisite: `/preview/[slug]` of another site of the network (see lib/multisiteRoute).
import Base, { generateMetadata as baseMetadata } from "@/app/(public)/preview/[slug]/page";
import { sitePage, siteMetadata } from "@/lib/multisiteRoute";

export const dynamic = "force-dynamic";

export const generateMetadata = siteMetadata(baseMetadata);
export default sitePage(Base);
