import NotFoundState from "@/components/NotFoundState";
import { inter } from "./fonts";

export default function NotFound() {
    // Root-level 404 renders outside the (public) tree (no wordjs-ui.css) and outside admin —
    // re-apply Inter here since the root <body> now carries only inter.variable.
    return (
        <div className={`${inter.className} min-h-screen flex items-center justify-center`}>
            <NotFoundState />
        </div>
    );
}
