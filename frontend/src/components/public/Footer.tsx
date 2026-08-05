"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { settingsApi, menusApi } from "@/lib/api";
import { sanitizeHTML } from "@/lib/sanitize";
import PublicSidebar from "./PublicSidebar";
import type { FooterColumns, FooterVariant } from "@/lib/themeLayout";

// Static literal maps so Tailwind can see every class (no interpolation).
const GRID_COLS: Record<FooterColumns, string> = {
    1: "md:grid-cols-1",
    2: "md:grid-cols-2",
    3: "md:grid-cols-3",
    4: "md:grid-cols-4",
};
// The brand column spans 2 tracks only when the grid actually has ≥2 of them (span 2 inside a
// 1-column grid would create an implicit second track and break columns:1).
const BRAND_SPAN: Record<FooterColumns, string> = {
    1: "col-span-1 md:col-span-1",
    2: "col-span-1 md:col-span-2",
    3: "col-span-1 md:col-span-2",
    4: "col-span-1 md:col-span-2",
};

interface FooterProps {
    previewSettings?: any;
    previewMenu?: any[];
    previewSocials?: any[];
    // Structure config from theme.json `layout` v2 (normalized upstream by PublicLayoutShell). The
    // defaults reproduce today's markup exactly, so a theme without `layout` renders unchanged.
    variant?: FooterVariant;
    columns?: FooterColumns;
}

export default function Footer({ previewSettings, previewMenu, previewSocials, variant = "columns", columns = 4 }: FooterProps = {}) {
    const [settings, setSettings] = useState<any>(previewSettings || {});
    const [footerMenu, setFooterMenu] = useState<any[]>(previewMenu || []);
    const [socialLinks, setSocialLinks] = useState<any[]>(previewSocials || []);

    useEffect(() => {
        if (previewSettings) {
            setSettings(previewSettings);
            if (previewSocials) setSocialLinks(previewSocials);
            if (previewMenu) setFooterMenu(previewMenu);
            return;
        }

        const loadFooterData = async () => {
            try {
                const settingsData = await settingsApi.get().catch(() => ({}));
                const menuData = await menusApi.getByLocation('footer').catch(() => null);

                if (settingsData) {
                    setSettings(settingsData);
                    // Parse social links
                    try {
                        if ((settingsData as any).footer_socials) {
                            let parsed = (settingsData as any).footer_socials;
                            if (typeof parsed === 'string') {
                                parsed = JSON.parse(parsed);
                            }
                            if (Array.isArray(parsed)) setSocialLinks(parsed);
                        }
                    } catch (e) {
                        console.error("Failed to parse social links", e);
                    }
                }

                if (menuData && menuData.items) {
                    setFooterMenu(menuData.items);
                }
            } catch (err) {
                console.error("Critical error loading footer:", err);
            }
        };

        loadFooterData();
    }, [previewSettings, previewMenu, previewSocials]);

    const socialIcons = socialLinks.map((link, idx) => (
        <a
            key={idx}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="w-10 h-10 rounded-full bg-[var(--wjs-bg-surface-hover,rgb(31,41,55))] flex items-center justify-center hover:bg-[var(--wjs-color-primary,blue)] text-[var(--wjs-color-text-footer-main,white)] transition-colors tooltip-trigger"
            title={link.platform}
            aria-label={link.platform}
        >
            <i className={link.icon} aria-hidden="true"></i>
        </a>
    ));

    return (
        <footer className="bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12 mt-auto border-t border-[var(--wjs-border-subtle,transparent)]">
            <div className="container mx-auto px-4">
                {/* Footer widget area (honors the admin widget editor; renders nothing when empty) */}
                <PublicSidebar id="footer-1" />
                {variant === "minimal" ? (
                    /* minimal: a single row — copyright + socials, no column grid */
                    <div className="wjs-footer-minimal flex flex-col sm:flex-row items-center justify-between gap-4">
                        {settings.footer_copyright ? (
                            <div
                                className="text-[var(--wjs-color-text-footer-dim,gray)] text-sm break-words [&>a]:text-[var(--wjs-color-primary,blue)] [&>a:hover]:underline"
                                suppressHydrationWarning
                                dangerouslySetInnerHTML={{ __html: sanitizeHTML(settings.footer_copyright) }}
                            />
                        ) : null}
                        {socialLinks.length > 0 && (
                            <div className="wjs-footer-social flex gap-4 flex-wrap">{socialIcons}</div>
                        )}
                    </div>
                ) : (
                    <>
                        <div className={`wjs-footer-grid grid grid-cols-1 ${GRID_COLS[columns]} gap-8 mb-8`}>
                            {/* Column 1: About / Brand */}
                            <div className={BRAND_SPAN[columns]}>
                                {settings.site_logo || settings.blogname ? (
                                    <h3 className="text-2xl font-bold mb-4 flex items-center gap-2">
                                        {settings.site_logo && <img src={settings.site_logo} alt="Logo" width={128} height={32} className="h-8 w-auto" />}
                                        {settings.blogname}
                                    </h3>
                                ) : null}

                                {settings.footer_text && (
                                    <div
                                        className="text-[var(--wjs-color-text-footer-dim,gray)] max-w-sm whitespace-pre-line break-words prose prose-invert prose-sm"
                                        suppressHydrationWarning
                                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(settings.footer_text) }}
                                    />
                                )}
                            </div>

                            {/* Column 2: Footer Menu (Quick Links) */}
                            <div>
                                {footerMenu.length > 0 && (
                                    <>
                                        <h4 className="font-bold mb-4">Quick Links</h4>
                                        <ul className="space-y-2 text-[var(--wjs-color-text-footer-dim,gray)]">
                                            {footerMenu.map((item) => (
                                                <li key={item.id}>
                                                    <Link href={item.url || '#'} className="hover:text-[var(--wjs-color-primary,white)] transition-colors">
                                                        {item.title}
                                                    </Link>
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                            </div>

                            {/* Column 3: Connect / Social */}
                            <div>
                                {socialLinks.length > 0 && (
                                    <>
                                        <h4 className="font-bold mb-4">Connect</h4>
                                        <div className="wjs-footer-social flex gap-4 flex-wrap">
                                            {socialIcons}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Copyright Line */}
                        {settings.footer_copyright && (
                            <div
                                className="border-t border-[var(--wjs-border-subtle,rgb(31,41,55))] pt-8 text-center text-[var(--wjs-color-text-footer-dim,gray)] text-sm break-words [&>a]:text-[var(--wjs-color-primary,blue)] [&>a:hover]:underline"
                                suppressHydrationWarning
                                dangerouslySetInnerHTML={{ __html: sanitizeHTML(settings.footer_copyright) }}
                            />
                        )}
                    </>
                )}
            </div>
        </footer>
    );
}
