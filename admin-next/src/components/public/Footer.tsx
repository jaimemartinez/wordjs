"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { settingsApi, menusApi } from "@/lib/api";
import { sanitizeHTML } from "@/lib/sanitize";

interface FooterProps {
    previewSettings?: any;
    previewMenu?: any[];
    previewSocials?: any[];
}

export default function Footer({ previewSettings, previewMenu, previewSocials }: FooterProps = {}) {
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
            console.log("Loading Footer Data...");
            try {
                const settingsData = await settingsApi.get().catch(err => {
                    console.error("Settings API failed", err);
                    return {};
                });

                const menuData = await menusApi.getByLocation('footer').catch(err => {
                    console.error("Menus API failed", err);
                    return null;
                });

                console.log("Footer Menu Data:", menuData);

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
                    console.log("Setting footer menu items:", menuData.items);
                    setFooterMenu(menuData.items);
                } else {
                    console.log("No menu items found for footer");
                }
            } catch (err) {
                console.error("Critical error loading footer:", err);
            }
        };

        loadFooterData();
    }, [previewSettings, previewMenu, previewSocials]);

    return (
        <footer className="bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12 mt-auto border-t border-[var(--wjs-border-subtle,transparent)]">
            <div className="container mx-auto px-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
                    {/* Column 1: About / Brand */}
                    <div className="col-span-1 md:col-span-2">
                        {settings.site_logo || settings.blogname ? (
                            <h3 className="text-2xl font-bold mb-4 flex items-center gap-2">
                                {settings.site_logo && <img src={settings.site_logo} alt="Logo" className="h-8 w-auto" />}
                                {settings.blogname}
                            </h3>
                        ) : null}

                        {settings.footer_text && (
                            <div
                                className="text-[var(--wjs-color-text-footer-dim,gray)] max-w-sm whitespace-pre-line prose prose-invert prose-sm"
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
                                <div className="flex gap-4 flex-wrap">
                                    {socialLinks.map((link, idx) => (
                                        <a
                                            key={idx}
                                            href={link.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="w-10 h-10 rounded-full bg-[var(--wjs-bg-surface-hover,rgb(31,41,55))] flex items-center justify-center hover:bg-[var(--wjs-color-primary,blue)] text-[var(--wjs-color-text-footer-main,white)] transition-colors tooltip-trigger"
                                            title={link.platform}
                                        >
                                            <i className={link.icon}></i>
                                        </a>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Copyright Line */}
                {settings.footer_copyright && (
                    <div
                        className="border-t border-[var(--wjs-border-subtle,rgb(31,41,55))] pt-8 text-center text-[var(--wjs-color-text-footer-dim,gray)] text-sm [&>a]:text-[var(--wjs-color-primary,blue)] [&>a:hover]:underline"
                        dangerouslySetInnerHTML={{ __html: sanitizeHTML(settings.footer_copyright) }}
                    />
                )}
            </div>
        </footer>
    );
}
