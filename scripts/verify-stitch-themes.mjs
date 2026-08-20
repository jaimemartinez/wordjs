#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  CHROME_SELECTORS,
  CHROME_STRUCTURAL_SELECTORS,
  PUCK_SELECTORS,
  REQUIRED_SELECTORS,
  STRUCTURAL_SELECTORS,
} from "./wordjs-theme-contract.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const postcss = (() => {
  try { return require("postcss"); }
  catch { return require(path.join(rootDir, "frontend/node_modules/postcss")); }
})();

const roots = [path.join(rootDir, "backend/themes"), path.join(rootDir, "marketplace/themes")];
const verified = [];

for (const themesRoot of roots) {
  if (!fs.existsSync(themesRoot)) continue;
  for (const entry of fs.readdirSync(themesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const themeDir = path.join(themesRoot, entry.name);
    const manifestPath = path.join(themeDir, "theme.json");
    const cssPath = path.join(themeDir, "style.css");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(cssPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest.stitch) continue;

    const css = fs.readFileSync(cssPath, "utf8");
    const hash = crypto.createHash("sha256").update(css).digest("hex");
    if (hash !== manifest.stitch.cssSha256) throw new Error(`${entry.name}: CSS hash does not match theme.json`);
    if (manifest.stitch.domContractVersion !== 3) throw new Error(`${entry.name}: unsupported DOM contract version`);
    if (manifest.stitch.converter !== "stitch-to-wordjs-theme@4") throw new Error(`${entry.name}: unsupported Stitch converter`);
    if (manifest.stitch.puckCoverage !== PUCK_SELECTORS.length) throw new Error(`${entry.name}: stale Puck root coverage`);
    if (manifest.stitch.chromeCoverage !== CHROME_SELECTORS.length) throw new Error(`${entry.name}: stale public chrome coverage`);
    if (manifest.stitch.chromeStructuralCoverage !== CHROME_STRUCTURAL_SELECTORS.length) throw new Error(`${entry.name}: stale chrome structure coverage`);
    if (!Array.isArray(manifest.stitch.sourceStructuralHooks)) throw new Error(`${entry.name}: missing authored structural coverage`);
    if (manifest.stitch.sourceStructuralCoverage !== manifest.stitch.sourceStructuralHooks.length) throw new Error(`${entry.name}: inconsistent authored structural coverage`);
    if (!Array.isArray(manifest.stitch.missingStructuralHooks) ||
        manifest.stitch.sourceStructuralCoverage + manifest.stitch.missingStructuralHooks.length !== STRUCTURAL_SELECTORS.length) {
      throw new Error(`${entry.name}: incomplete structural coverage report`);
    }
    if (!Number.isInteger(manifest.stitch.inlineStyleCount) || manifest.stitch.inlineStyleCount < 0) throw new Error(`${entry.name}: missing inline-style audit`);
    if (manifest.stitch.parityStatus !== undefined) {
      if (!(["exact", "partial"].includes(manifest.stitch.parityStatus))) throw new Error(`${entry.name}: invalid parity status`);
      for (const field of [
        "inlineStyleDeclarationCount", "resolvedInlineStyleCount", "unresolvedInlineStyleCount",
        "resolvedInlineDeclarationCount", "unresolvedInlineDeclarationCount",
      ]) {
        if (!Number.isInteger(manifest.stitch[field]) || manifest.stitch[field] < 0) throw new Error(`${entry.name}: invalid ${field}`);
      }
      if (manifest.stitch.resolvedInlineStyleCount + manifest.stitch.unresolvedInlineStyleCount !== manifest.stitch.inlineStyleCount) {
        throw new Error(`${entry.name}: inconsistent inline-style attribute accounting`);
      }
      if (manifest.stitch.resolvedInlineDeclarationCount + manifest.stitch.unresolvedInlineDeclarationCount !== manifest.stitch.inlineStyleDeclarationCount) {
        throw new Error(`${entry.name}: inconsistent inline-style declaration accounting`);
      }
      if (!Array.isArray(manifest.stitch.resolvedInlineStyles) ||
          manifest.stitch.resolvedInlineStyles.length !== manifest.stitch.resolvedInlineDeclarationCount) {
        throw new Error(`${entry.name}: incomplete resolved inline-style provenance`);
      }
      if (manifest.stitch.parityStatus === "exact" &&
          (manifest.stitch.unresolvedInlineStyleCount !== 0 || manifest.stitch.unresolvedInlineDeclarationCount !== 0)) {
        throw new Error(`${entry.name}: theme claims exact parity with unresolved inline styles`);
      }
      const expectedIsolationMode = manifest.stitch.parityStatus === "exact" ? "isolated" : "safe-overlay";
      if (manifest.stitch.isolationMode !== expectedIsolationMode) {
        throw new Error(`${entry.name}: ${manifest.stitch.parityStatus} theme must use ${expectedIsolationMode} isolation mode`);
      }
    }
    if ((manifest.stitch.optionalSpecimenClasses || []).length) throw new Error(`${entry.name}: unresolved specimen classes remain`);

    const cssRoot = postcss.parse(css, { from: cssPath });
    if (manifest.stitch.parityStatus === "partial") {
      const partialResetRules = [];
      cssRoot.walkRules((rule) => {
        const hasReset = (rule.nodes || []).some((node) => node.type === "decl" &&
          node.prop === "all" && node.value === "revert" && node.important);
        if (hasReset) partialResetRules.push(rule);
      });
      if (!partialResetRules.length) {
        throw new Error(`${entry.name}: partial conversion is missing selective component-root isolation`);
      }
      if (partialResetRules.some((rule) => !rule.selector.includes(".wjs-public-site :where(") ||
          rule.selector.includes(":where(:not(i):not(svg))") || rule.selector.trim() === ".wjs-public-site")) {
        throw new Error(`${entry.name}: partial conversion resets unresolved descendant presentation`);
      }
    }
    if (/\.cols-\d+[^{}]*\{[^{}]*grid-template-columns\s*:/s.test(css.slice(0, 12000))) {
      throw new Error(`${entry.name}: converter baseline must not override theme grid topology`);
    }
    const missing = REQUIRED_SELECTORS.filter((required) => {
      let found = false;
      cssRoot.walkRules((rule) => {
        const escaped = required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const boundary = new RegExp(`${escaped}(?![\\w-])`);
        if ((rule.selectors || []).some((selector) => required === ".wjs-public-site"
          ? selector.trim() === required
          : selector.includes(".wjs-public-site") && boundary.test(selector))) found = true;
      });
      return !found;
    });
    if (missing.length) throw new Error(`${entry.name}: installed CSS misses scoped selectors: ${missing.join(", ")}`);

    verified.push({
      theme: entry.name,
      puck: manifest.stitch.puckCoverage,
      chrome: manifest.stitch.chromeCoverage,
      tokens: manifest.stitch.tokenCount,
      rewrites: manifest.stitch.selectorRewrites,
      authoredStructure: manifest.stitch.sourceStructuralCoverage,
      inlineStylesAudited: manifest.stitch.inlineStyleCount,
      parityStatus: manifest.stitch.parityStatus || "legacy-unreported",
    });
  }
}

process.stdout.write(JSON.stringify({ verified: verified.length, themes: verified }, null, 2) + "\n");
