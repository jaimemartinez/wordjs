/**
 * breadcrumbs — blocks-only plugin (WordPress parity: Breadcrumb NavXT / Yoast Breadcrumbs).
 *
 * Everything lives in the Puck block (client/puck/BreadcrumbsPuck.tsx), registered via
 * manifest.frontend.puckComponents. The backend side is intentionally empty: no routes,
 * no tables, no options, no assets — permissions: [].
 */
"use strict";

exports.metadata = {
    name: "Breadcrumbs",
    version: "1.0.0",
    description: "Puck block that renders the navigation trail of the current page with BreadcrumbList JSON-LD.",
    author: "WordJS"
};

exports.init = async function (wordjs) {
    // Blocks-only plugin: nothing to wire on the backend. The Puck block resolves the
    // trail client-side from location.pathname and the public posts API.
    console.log("[breadcrumbs] plugin initialized (blocks-only, no backend surface)");
};

exports.deactivate = function () {
    // Nothing to tear down.
};
