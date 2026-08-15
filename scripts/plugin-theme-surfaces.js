#!/usr/bin/env node
/* =============================================================================
 * plugin-theme-surfaces.js — the plugin → theme-manifest trust edge (OLA 6 / F5)
 * -----------------------------------------------------------------------------
 * A plugin's Puck block emits its own markup with its own classes, styled by an
 * in-body <style>. Until now a theme had NO NAME for those surfaces: the manifest
 * (backend/public/theme-tokens.json) is scraped only from wordjs-ui.css + the
 * hardcoded chrome seed table, so no plugin class was ever a themable element.
 *
 * A plugin may now DECLARE its themable surfaces in its own manifest.json under
 * `themeSurfaces`, a closed shape mirroring a manifest element:
 *
 *   "themeSurfaces": [
 *     { "element": "item", "selector": ".wjs-p-faq-item",
 *       "children": { "icon": { "selector": ".wjs-p-faq-item .wjs-p-faq-icon" } } }
 *   ]
 *
 * generate-token-manifest.js merges each VALIDATED surface into the manifest under
 * the element key `plugin:<slug>:<element>`, which theme-compile's existing
 * element→selector lookup reaches with NO compiler change.
 *
 * ── THE SAFETY PROPERTY: NAMESPACE OWNERSHIP ─────────────────────────────────
 * This is a trust edge: a plugin now contributes to the manifest a theme trusts.
 * A plugin must be unable to claim a surface it does not own. The load-bearing
 * control is that EVERY class a plugin names must live under a prefix DERIVED from
 * its slug — `.wjs-p-<slug>-` — and nothing else. Ownership is therefore provable
 * by string derivation: only slug "faq" yields `.wjs-p-faq-`, so slug "faq" cannot
 * name `.wp-block-heading`, `.wjs-header`, a bare tag, an id/attribute selector, or
 * another plugin's `.wjs-p-<other>-` classes. Every such attempt is REJECTED here.
 *
 * WHY a derived prefix and NOT an allow-list-map of the ad-hoc prefixes the shipped
 * plugins use today (wjbk/wjtm/wjfq/…): an allow-list is a hand-maintained trust
 * table with no structural tie to the slug — two plugins already share `wjbk`, and
 * nothing stops a hostile plugin from claiming another's ad-hoc prefix, because the
 * generator cannot PROVE who owns `wjfq`. `.wjs-p-<slug>-` is enforceable because it
 * is computed from the slug, not asserted by the plugin. The cost is that a plugin
 * becomes themable only when it MIGRATES its block classes to the namespaced prefix
 * AND declares them — opt-in, and un-migrated plugins keep working unchanged (their
 * ad-hoc classes are simply not themable). That is the safe, enforceable trade.
 *
 * A malformed or hostile declaration is a HARD build failure (the generator throws),
 * never a silent skip — a manifest that quietly dropped a bad surface would let a
 * plugin probe the validator for what slips through.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

// Slug shape: lowercase folder-name segments joined by single hyphens (matches the
// marketplace builder's folder==id rule). The prefix is derived from THIS, so its
// grammar is part of the security boundary.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Element and child KEY shape: a plain identifier. Deliberately NOT allowing the
// compiler's reserved nesting names as CHILD keys (theme-compile checks the
// state/position/pseudo/breakpoint maps BEFORE the children map, so a colliding
// child key would be silently unreachable — same rule the block-child seeds obey).
const NAME_RE = /^[a-z][A-Za-z0-9]*$/;
const RESERVED_CHILD_KEYS = new Set([
    'hover', 'focus', 'active', 'disabled',
    'before', 'after', 'placeholder',
    'first', 'last',
    'mobile', 'tablet', 'desktop', 'belowDesktop',
    'motionOk', 'reducedMotion', 'dark',
]);

function requiredPrefix(slug) { return `.wjs-p-${slug}-`; }
function pluginElementKey(slug, element) { return `plugin:${slug}:${element}`; }

// Validate ONE selector string against the namespace rule for `slug`.
// Returns an array of human-readable error strings (empty === valid).
function validateSelector(slug, selector, where) {
    const errs = [];
    const prefix = requiredPrefix(slug);           // ".wjs-p-<slug>-"
    const bareClassPrefix = prefix.slice(1);       //  "wjs-p-<slug>-"

    if (typeof selector !== 'string' || !selector.trim()) {
        errs.push(`${where}: "selector" must be a non-empty string`);
        return errs;
    }
    const sel = selector.trim();

    // Structural rejects — the shapes a plugin may NEVER name. Ids, attribute
    // selectors, the universal selector and pseudo-classes/elements are all off the
    // table: a plugin names its own classes and nothing else. Pseudo-classes/states,
    // breakpoints and positions are expressed by NESTING in theme.json, never in the
    // base selector, so a ":" here is always an over-reach.
    if (sel.includes('#')) errs.push(`${where}: selector "${sel}" must not use an id (#) selector`);
    if (sel.includes('[') || sel.includes(']')) errs.push(`${where}: selector "${sel}" must not use an attribute ([]) selector`);
    if (sel.includes('*')) errs.push(`${where}: selector "${sel}" must not use the universal (*) selector`);
    if (sel.includes(':')) errs.push(`${where}: selector "${sel}" must not use a pseudo-class/element (:) — express states/breakpoints by nesting in theme.json`);
    if (sel.includes(',')) errs.push(`${where}: selector "${sel}" must not be a selector list (comma)`);
    if (errs.length) return errs;

    // Split on combinators (descendant/child/adjacent/general-sibling) into compound
    // segments. Every segment must be one-or-more CLASS selectors concatenated with
    // nothing else — no leading tag name, which is what a bare `.startsWith('.')`
    // check would miss (`a.wjs-p-faq-x` has a tag but the class passes the prefix).
    const segments = sel.split(/\s*[>+~]\s*|\s+/).filter((s) => s.length);
    if (!segments.length) { errs.push(`${where}: selector "${sel}" is empty`); return errs; }

    const COMPOUND_RE = /^(?:\.[A-Za-z0-9_-]+)+$/;   // only class tokens, back-to-back
    const CLASS_RE = /\.[A-Za-z0-9_-]+/g;
    let classCount = 0;

    for (const seg of segments) {
        if (!COMPOUND_RE.test(seg)) {
            errs.push(`${where}: segment "${seg}" in selector "${sel}" must be composed only of class selectors under ${prefix} (no tag, id, attribute or universal selector)`);
            continue;
        }
        for (const m of seg.match(CLASS_RE) || []) {
            classCount++;
            const cls = m.slice(1); // drop the dot
            if (!(cls.startsWith(bareClassPrefix) && cls.length > bareClassPrefix.length)) {
                errs.push(`${where}: class "${m}" in selector "${sel}" is not under this plugin's namespace ${prefix} — a plugin may only name its own classes`);
            }
        }
    }
    if (classCount === 0) errs.push(`${where}: selector "${sel}" names no class under ${prefix}`);
    return errs;
}

// Validate a plugin's full `themeSurfaces` declaration. Returns { elements, errors }.
// `elements` is keyed by `plugin:<slug>:<element>` with the SAME { selector, children }
// shape a manifest element uses, so the generator can splice it straight in.
function validateThemeSurfaces(slug, surfaces) {
    const errors = [];
    const elements = {};

    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
        errors.push(`plugin slug "${slug}" is not a valid namespace slug (${SLUG_RE})`);
        return { elements, errors };
    }
    if (surfaces === undefined) return { elements, errors }; // opting out is fine
    if (!Array.isArray(surfaces)) {
        errors.push(`[${slug}] "themeSurfaces" must be an array`);
        return { elements, errors };
    }

    const seenElements = new Set();
    for (let i = 0; i < surfaces.length; i++) {
        const s = surfaces[i];
        const at = `[${slug}] themeSurfaces[${i}]`;
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
            errors.push(`${at}: must be an object { element, selector, children? }`);
            continue;
        }
        // Reject unknown keys loudly — a typo like "selctor" must not pass silently.
        for (const k of Object.keys(s)) {
            if (!['element', 'selector', 'children', 'tokens'].includes(k)) {
                errors.push(`${at}: unknown key "${k}" (allowed: element, selector, children, tokens)`);
            }
        }
        const element = s.element;
        if (typeof element !== 'string' || !NAME_RE.test(element)) {
            errors.push(`${at}: "element" must match ${NAME_RE} (a plain identifier)`);
            continue;
        }
        if (seenElements.has(element)) { errors.push(`${at}: duplicate element "${element}"`); continue; }
        seenElements.add(element);

        const selErrs = validateSelector(slug, s.selector, `${at}.selector`);
        errors.push(...selErrs);

        const entry = { selector: typeof s.selector === 'string' ? s.selector.trim() : s.selector };

        if (s.children !== undefined) {
            if (!s.children || typeof s.children !== 'object' || Array.isArray(s.children)) {
                errors.push(`${at}: "children" must be an object keyed by child name`);
            } else {
                const outChildren = {};
                for (const [childKey, cdef] of Object.entries(s.children)) {
                    const cat = `${at}.children.${childKey}`;
                    if (!NAME_RE.test(childKey)) { errors.push(`${cat}: child key must match ${NAME_RE}`); continue; }
                    if (RESERVED_CHILD_KEYS.has(childKey)) { errors.push(`${cat}: child key "${childKey}" collides with a compiler reserved nesting name and would be unreachable`); continue; }
                    if (!cdef || typeof cdef !== 'object' || Array.isArray(cdef)) { errors.push(`${cat}: must be an object { selector }`); continue; }
                    for (const k of Object.keys(cdef)) {
                        if (k !== 'selector') errors.push(`${cat}: unknown key "${k}" (allowed: selector)`);
                    }
                    errors.push(...validateSelector(slug, cdef.selector, `${cat}.selector`));
                    outChildren[childKey] = { selector: typeof cdef.selector === 'string' ? cdef.selector.trim() : cdef.selector };
                }
                if (Object.keys(outChildren).length) entry.children = outChildren;
            }
        }

        // `tokens` is accepted (a theme-author hint of which tokens the surface
        // consumes) but must, if present, stay inside the plugin's OWN token
        // namespace --wjs-p-<slug>-*. It is validated, not merged into the global
        // token map: token registration stays a framework concern for now, and a
        // plugin naming a framework token would be exactly the over-reach this file
        // exists to stop. Kept in the grammar so the field is reserved, not silently
        // ignored (an unknown key is rejected above; a mis-namespaced token here).
        if (s.tokens !== undefined) {
            if (!Array.isArray(s.tokens)) errors.push(`${at}: "tokens" must be an array of token names`);
            else for (const t of s.tokens) {
                if (typeof t !== 'string' || !t.startsWith(`--wjs-p-${slug}-`)) {
                    errors.push(`${at}: token "${t}" must be under this plugin's namespace --wjs-p-${slug}-`);
                }
            }
        }

        if (selErrs.length === 0) elements[pluginElementKey(slug, element)] = entry;
    }

    return { elements, errors };
}

// Scan `<pluginsDir>/<slug>/manifest.json` for every plugin, validate each one's
// themeSurfaces, and return the merged, DETERMINISTIC element map plus every error.
// Determinism: plugin dirs sorted, element keys sorted by the generator's own sort,
// children sorted there too. This scans the COMMITTED catalog on disk — the same
// deterministic source build-marketplace.js packs — NOT a runtime DB, so the output
// is reproducible for the CI drift gate. (Timing: a newly-INSTALLED plugin's surfaces
// become themable only after the manifest is regenerated, which the dev boot/build
// already does; see generate-token-manifest.js.)
function collectPluginThemeElements(pluginsDir) {
    const elements = {};
    const errors = [];
    let dirents = [];
    try {
        dirents = fs.readdirSync(pluginsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
    } catch {
        return { elements, errors }; // no catalog on disk → no plugin surfaces
    }
    for (const slug of dirents) {
        const manifestPath = path.join(pluginsDir, slug, 'manifest.json');
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
        catch { continue; } // not a plugin dir (no readable manifest) — skip quietly
        if (manifest.themeSurfaces === undefined) continue;
        // The declared id and the folder must agree, or the derived prefix would be
        // computed from a slug the plugin does not actually load under.
        const declaredSlug = typeof manifest.id === 'string' ? manifest.id : slug;
        if (declaredSlug !== slug) {
            errors.push(`[${slug}] manifest id "${manifest.id}" != folder name — refusing to derive a namespace from a mismatched slug`);
            continue;
        }
        const { elements: pe, errors: perr } = validateThemeSurfaces(slug, manifest.themeSurfaces);
        errors.push(...perr);
        for (const [k, v] of Object.entries(pe)) {
            if (elements[k]) { errors.push(`[${slug}] duplicate manifest element key ${k}`); continue; }
            elements[k] = v;
        }
    }
    return { elements, errors };
}

module.exports = {
    SLUG_RE,
    NAME_RE,
    RESERVED_CHILD_KEYS,
    requiredPrefix,
    pluginElementKey,
    validateSelector,
    validateThemeSurfaces,
    collectPluginThemeElements,
};
