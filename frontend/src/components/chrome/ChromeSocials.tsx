// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". Links arrive RESOLVED by ChromeRenderer (settings.footer_socials via
// parseChromeSocials); markup and classes mirror today's Footer social icons — including the
// existing .wjs-footer-social hook so current theme CSS keeps applying.
import { safeChromeHref, type ChromeSocialLink } from "@/lib/chromeData";

export interface ChromeSocialsViewProps {
    // Resolved bindings
    links: ChromeSocialLink[];
}

export default function ChromeSocials({ links }: ChromeSocialsViewProps) {
    // Estas URLs vienen de un ajuste del sitio, no de la composicion validada, asi que este bloque es
    // el unico sitio donde un enlace del chrome llega al DOM sin comprobar — ChromeButton revalida su
    // propio href. Misma allowlist, asi que una entrada 'javascript:' guardada tampoco puede volverse
    // un enlace vivo aqui.
    //
    // Se pinta el href RESUELTO, no `link.url`: el navegador borra tabuladores, saltos de linea y
    // retornos de carro antes de parsear, asi que filtrar por la cadena cruda y pintar esa misma cruda
    // dejaba pasar "/\t/evil.example" -> https://evil.example/ (open redirect almacenado).
    const safe = links
        .map((link) => ({ link, href: safeChromeHref(link.url) }))
        .filter((entry): entry is { link: ChromeSocialLink; href: string } => entry.href !== undefined);
    if (safe.length === 0) return null;
    return (
        <div className="wjs-chrome-socials wjs-footer-social flex gap-4 flex-wrap">
            {safe.map(({ link, href }, idx) => (
                <a
                    key={idx}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-10 h-10 rounded-full bg-[var(--wjs-bg-surface-hover,rgb(31,41,55))] flex items-center justify-center hover:bg-[var(--wjs-color-primary,blue)] text-[var(--wjs-color-text-footer-main,white)] transition-colors tooltip-trigger"
                    title={link.platform || undefined}
                    // An entry saved without a platform label would otherwise be an icon-only link with
                    // no accessible name at all — a screen reader announces just "link".
                    aria-label={link.platform || "Perfil social"}
                >
                    <i className={link.icon} aria-hidden="true"></i>
                </a>
            ))}
        </div>
    );
}
