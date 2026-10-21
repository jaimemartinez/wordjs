import type { Metadata } from "next";
import NotFoundState from "@/components/NotFoundState";
import { inter } from "./fonts";
import RootDocument, { rootMetadata } from "./_root/RootDocument";
import { notFoundStrings } from "@/lib/public/uiStrings";
import { getSettings } from "@/lib/server-api";

// A URL no route matches. There is no app/layout.tsx to render it inside (every tree has its own root
// layout — see _root/RootDocument.tsx), so this page renders the document itself: the main site's, as
// the 404 always was.
export async function generateMetadata(): Promise<Metadata> {
    return rootMetadata();
}

export default async function GlobalNotFound() {
    const strings = notFoundStrings(await getSettings().catch(() => null));
    // Rendered outside the (public) tree (no wordjs-ui.css) and outside admin — re-apply Inter here
    // since the document's <body> carries only inter.variable.
    return RootDocument({
        children: (
            <div className={`${inter.className} min-h-screen flex items-center justify-center`}>
                <NotFoundState title={strings.title} message={strings.message} backLabel={strings.back} />
            </div>
        ),
    });
}
