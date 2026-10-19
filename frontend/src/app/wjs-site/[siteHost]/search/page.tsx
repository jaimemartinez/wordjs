// Multisite: `/search` of another site of the network (see lib/multisiteRoute).
import Base, { generateMetadata as baseMetadata } from "@/app/(public)/search/page";
import { sitePage, siteMetadata } from "@/lib/multisiteRoute";

export const generateMetadata = siteMetadata(baseMetadata);
export default sitePage(Base);
