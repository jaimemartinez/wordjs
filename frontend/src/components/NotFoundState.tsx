import Link from "next/link";
import { FC } from "react";

interface NotFoundStateProps {
    /** Already localised by the caller (lib/public/uiStrings notFoundStrings — the SITE language). */
    title?: string;
    message?: string;
    backLink?: string;
    backLabel?: string;
}

/* Corner glows. Each is a radial gradient that fades to transparent INSIDE its own box, anchored in a
 * corner of the (overflow-hidden) state. The previous blurred circles were pushed half outside and
 * their blur halo was cut by the container's edges — inside a theme template's card that read as two
 * hard-edged rectangles. --wjs-404-blob-a/-b stay the theme hooks for the glow colour. */
const glow = (corner: string, color: string) =>
    `radial-gradient(circle at ${corner}, ${color} 0%, transparent 70%)`;

const NotFoundState: FC<NotFoundStateProps> = ({
    title = "Page not found",
    message = "The page you are looking for does not exist or has been moved.",
    backLink = "/",
    backLabel = "Back to home"
}) => {
    return (
        <div className="min-h-[60vh] w-full flex flex-col items-center justify-center bg-[var(--wjs-bg-canvas,transparent)] text-[var(--wjs-color-text-main,gray)] relative overflow-hidden py-20">
            <div
                aria-hidden="true"
                className="absolute top-0 left-0 w-[28rem] h-[28rem] max-w-full pointer-events-none"
                style={{ background: glow("0 0", "var(--wjs-404-blob-a, color-mix(in oklab, oklch(71.5% 0.143 215.221) 16%, transparent))") }}
            />
            <div
                aria-hidden="true"
                className="absolute bottom-0 right-0 w-[28rem] h-[28rem] max-w-full pointer-events-none"
                style={{ background: glow("100% 100%", "var(--wjs-404-blob-b, color-mix(in oklab, oklch(54.6% 0.245 262.881) 16%, transparent))") }}
            />

            <div className="z-10 text-center px-4 animate-in fade-in zoom-in duration-500">
                <p aria-hidden="true" className="text-[8rem] md:text-[12rem] font-bold leading-none text-transparent bg-clip-text bg-gradient-to-br from-[var(--wjs-color-primary,blue)] to-[var(--wjs-color-secondary,cyan)] opacity-80 select-none m-0">
                    404
                </p>

                <h1 className="text-2xl md:text-3xl font-bold mb-4 -mt-4 md:-mt-8 text-[var(--wjs-color-text-heading,black)]">
                    {title}
                </h1>

                <p className="text-base md:text-lg text-[var(--wjs-color-text-muted,gray)] max-w-lg mx-auto mb-8 leading-relaxed">
                    {message}
                </p>

                {/* colour + decoration INLINE: wordjs-ui.css's unlayered `a { color: var(--wjs-color-link) }`
                    beats any Tailwind utility (those live in @layer utilities), which painted the label in
                    the link colour — the same as the primary background — and left an empty pill. */}
                <Link
                    href={backLink}
                    className="inline-flex items-center gap-2 px-6 py-3 bg-[var(--wjs-color-primary,blue)] hover:bg-[var(--wjs-color-primary-dark,darkblue)] font-medium rounded-full transform hover:-translate-y-1 transition-all duration-300"
                    style={{
                        color: "var(--wjs-color-primary-text, #ffffff)",
                        textDecoration: "none",
                        boxShadow: "var(--wjs-404-glow, 0 10px 15px -3px color-mix(in oklab, oklch(54.6% 0.245 262.881) 20%, transparent), 0 4px 6px -4px color-mix(in oklab, oklch(54.6% 0.245 262.881) 20%, transparent))",
                    }}
                >
                    <span className="tracking-wide uppercase text-sm">{backLabel}</span>
                    <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                </Link>
            </div>
        </div>
    );
}

export default NotFoundState;
