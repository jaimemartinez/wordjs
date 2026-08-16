/**
 * WordJS Plugin: Table of Contents
 *
 * Blocks-only plugin — the whole feature lives in the Verso block
 * (client/verso/TableOfContentsVerso.tsx), which scans the rendered page's H2/H3
 * headings CLIENT-SIDE and builds an anchored, nested index with smooth scroll
 * and scroll-spy. Nothing to do server-side: no routes, no tables, no options,
 * no assets — hence the empty permissions list in the manifest.
 */

exports.metadata = {
    name: 'Table of Contents',
    version: '1.0.0',
    description: 'Verso block "TableOfContents": anchored nested page index built from the rendered H2/H3 headings, with smooth scroll and scroll-spy',
    author: 'WordJS',
};

exports.init = async function () {
    // Intentionally minimal: the block is registered via manifest.frontend.versoComponents.
    console.log('[table-of-contents] plugin initialized (blocks-only: "TableOfContents" Verso block)');
};

exports.deactivate = function () {
    // Nothing to tear down — no timers, routes or resources were created at init.
};
