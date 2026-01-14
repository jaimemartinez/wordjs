"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { settingsApi, menusApi } from "@/lib/api";

export default function Footer() {
    const [settings, setSettings] = useState<any>({});
    const [footerMenu, setFooterMenu] = useState<any[]>([]);
    const [socialLinks, setSocialLinks] = useState<any[]>([]);

    useEffect(() => {
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
    }, []);

    // Conditional check removed for debugging


    return (
        <footer className="bg-gray-900 text-white py-12 mt-20">
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
                                className="text-gray-400 max-w-sm whitespace-pre-line prose prose-invert prose-sm"
                                dangerouslySetInnerHTML={{ __html: settings.footer_text }}
                            />
                        )}
                    </div>

                    {/* Column 2: Footer Menu (Quick Links) */}
                    <div>
                        {footerMenu.length > 0 && (
                            <>
                                <h4 className="font-bold mb-4">Quick Links</h4>
                                <ul className="space-y-2 text-gray-400">
                                    {footerMenu.map((item) => (
                                        <li key={item.id}>
                                            <Link href={item.url} className="hover:text-white transition-colors">
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
                                            className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center hover:bg-blue-600 transition-colors tooltip-trigger"
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
                        className="border-t border-gray-800 pt-8 text-center text-gray-500 text-sm [&>a]:text-blue-400 [&>a:hover]:underline"
                        dangerouslySetInnerHTML={{ __html: settings.footer_copyright }}
                    />
                )}
            </div>
        </footer>
    );
}
