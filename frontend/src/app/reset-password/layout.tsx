import { rootMetadata } from "../_root/RootDocument";
import { authDocument } from "../_root/AuthScreen";

// A root layout (there is no app/layout.tsx — see _root/RootDocument.tsx): the document and its metadata.
export const generateMetadata = rootMetadata;

// The sign-in screens' shared shell (_root/AuthScreen.tsx): Inter and the admin language provider. It
// reads the request's language cookie, so the screen renders per request in the visitor's language.
export const dynamic = "force-dynamic";

export default async function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
    return authDocument(children);
}
