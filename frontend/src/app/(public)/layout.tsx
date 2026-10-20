// The public site's root layout (there is no app/layout.tsx — see _root/RootDocument.tsx): the document,
// then the site's chrome (_chrome/PublicLayout, shared with the multisite `wjs-site/[siteHost]` tree).
import RootDocument, { rootMetadata } from "../_root/RootDocument";
import PublicLayout from "./_chrome/PublicLayout";

export const generateMetadata = rootMetadata;

export default async function PublicRootLayout({ children }: { children: React.ReactNode }) {
    return RootDocument({ children: <PublicLayout>{children}</PublicLayout> });
}
