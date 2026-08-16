"use client";
/**
 * SearchBar block — client island (input state + same-origin navigation guard). Shared verbatim by
 * the editor canvas (via versoConfig) and the public ContentRenderer.
 */
import React from "react";
import { blockVars, unit } from "@/components/blocks/blockVars";

export default function SearchBarBlock({ placeholder, buttonText, searchPage, align, width, inputBg, inputBorderColor, inputRadius, buttonBg, buttonColor, buttonRadius, css }: any) {
    const [query, setQuery] = React.useState("");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (query.trim()) {
            // Restrict navigation to a same-origin relative path. `searchPage` is
            // editor-controlled, so an absolute/scheme URL (https://evil.com, javascript:)
            // or a protocol-relative //host must never reach window.location — that would be
            // an open redirect / javascript: navigation. Resolve against the current origin
            // and keep only the same-origin pathname; otherwise fall back to '/search'.
            let dest = '/search';
            try {
                const u = new URL(searchPage || '/search', window.location.origin);
                if (u.origin === window.location.origin) dest = u.pathname;
            } catch { /* malformed searchPage → keep default '/search' */ }
            const searchUrl = `${dest}?q=${encodeURIComponent(query.trim())}`;
            window.location.assign(searchUrl);
        }
    };

    return (
        <div
            className="wp-block-search-wrap"
            style={{
                ...blockVars('search', {
                    align,
                    width,
                    'input-bg': inputBg,
                    'input-border-color': inputBorderColor,
                    'input-radius': unit(inputRadius),
                    'button-bg': buttonBg,
                    'button-color': buttonColor,
                    'button-radius': unit(buttonRadius),
                }),
                ...css,
            }}
        >
            <form className="wp-block-search" onSubmit={handleSubmit}>
                <input
                    type="search"
                    className="wp-block-search__input"
                    placeholder={placeholder}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <button type="submit" className="wp-block-search__button">
                    <i className="fa-solid fa-search" aria-hidden="true"></i>
                    {buttonText && <span>{buttonText}</span>}
                </button>
            </form>
        </div>
    );
}
