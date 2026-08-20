import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REQUIRED_SELECTORS } from "./wordjs-theme-contract.mjs";

const converter = path.resolve(import.meta.dirname, "stitch-to-wordjs-theme.mjs");

function fixtureCss({ omit = "", extra = "" } = {}) {
  const selectors = REQUIRED_SELECTORS.filter((selector) => selector !== omit && selector !== ".wjs-public-site");
  const tokens = [
    ...Array.from({ length: 20 }, (_, index) => `--wjs-test-${index}: ${index}px;`),
    "--wjs-text-main: #111;",
    "--wjs-bg: #fff;",
    "--wjs-primary: #06f;",
    "--wjs-font-body: sans-serif;",
  ].join("\n");
  return `
    :root { ${tokens} }
    body { color: #111; background: #fff; }
    ${selectors.join(",\n")} { color: #111; background: #fff; }
    .wp-block-section { max-width: 72rem; margin: 0 auto; padding: 4rem 2rem; }
    .wp-block-text { max-width: 65ch; }
    .wjs-header-actions button { padding: .75rem 1.25rem; }
    .wp-block-search input { border-bottom: 1px solid; }
    .wp-block-button a:hover { color: #222; }
    .wp-block-accordion details[open] summary { padding: 1rem; }
    .wp-block-tabs-content { padding: 1rem; }
    .wp-block-pricing-card { border: 1px solid; }
    .wp-block-stats .stat-value { font-size: 3rem; }
    .wp-block-icon-list li { display: flex; }
    table.wp-block-table { border-collapse: collapse; }
    a { text-decoration: none; }
    ${extra}
    @keyframes fixture-fade { from { opacity: 0; } to { opacity: 1; } }
    @media (max-width: 767.98px) { .wp-block-columns { display: block; } }
    @media (prefers-reduced-motion: reduce) { * { animation: none; } }
  `;
}

function runFixture(css, body = "", head = "") {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wordjs-stitch-converter-"));
  assert.ok(tempRoot.startsWith(os.tmpdir()), "temporary test path must stay inside the OS temp directory");
  const themeDir = path.join(tempRoot, "theme");
  fs.mkdirSync(themeDir);
  fs.writeFileSync(path.join(themeDir, "theme.json"), JSON.stringify({ name: "Fixture", version: "1.0.0" }));
  const htmlPath = path.join(tempRoot, "stitch.html");
  fs.writeFileSync(htmlPath, `<html><head>${head}<style id="wordjs-theme">${css}</style></head><body>${body}</body></html>`);
  const result = spawnSync(process.execPath, [converter,
    "--theme", themeDir,
    "--html", htmlPath,
    "--project-id", "project-test",
    "--screen-id", "screen-test",
  ], { encoding: "utf8" });
  return { tempRoot, themeDir, result };
}

test("converts and scopes a structurally compatible Stitch theme", () => {
  const fixture = runFixture(
    fixtureCss({ extra: ".wp-block-image img { object-fit: cover; } .wp-block-posts-grid article img:hover { opacity: .8; } .wp-block-table { table-layout: fixed; } table.wp-block-table > thead > tr > th { text-align: left; } .wp-block-table td:first-child { font-weight: 700; } .wjs-footer-brand h2 { font-size: 2rem; } .wjs-footer-menu h6 { letter-spacing: .1em; }" }),
    `<div class="wjs-header-actions"><button>Enquire</button></div>
     <form class="wp-block-search"><label>Find</label><input></form>
     <section class="wp-block-section">
       <h2 class="wp-block-heading">Product</h2>
       <div class="wp-block-tabs">
         <div class="wp-block-tabs-nav"><button class="active">Overview</button><button>Details</button></div>
         <div class="wp-block-tabs-content"><p>Overview content</p></div>
       </div>
     </section>
     <div class="wp-block-pricing">
       <div class="wp-block-pricing-plan"><h3>Starter</h3><div class="wp-block-pricing-price">$10</div><a href="#">Buy</a></div>
       <div class="wp-block-pricing-plan"><h3>Pro</h3><div class="wp-block-pricing-price">$20</div><a href="#">Buy</a></div>
     </div>
     <div class="wp-block-posts-grid">
       <article><div class="wp-block-image"><img alt="Architecture diagram" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></div><span class="wp-block-posts-grid-meta">Architecture</span><h4 class="wp-block-heading">Distributed rendering</h4><p>First excerpt</p></article>
       <article><span class="wp-block-posts-grid-meta">Design</span><h4 class="wp-block-heading">Design systems</h4><p>Second excerpt</p></article>
     </div>
     <table class="wp-block-table"><thead><tr><th>Plan</th></tr></thead><tbody><tr><td>Pro</td></tr></tbody></table>
     <section class="wp-block-hero" style="background-image: linear-gradient(#0008,#0008), url(https://example.com/hero.jpg)"></section>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap">',
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.wjs-public-site \.wp-block-accordion \.wp-block-accordion-item\[open\] \.wp-block-accordion-trigger/);
    assert.match(css, /\.wjs-public-site \.wp-block-tabs-panel/);
    assert.match(css, /\.wjs-public-site \.wp-block-pricing-plan/);
    assert.match(css, /\.wjs-public-site \.wp-block-stats-value/);
    assert.match(css, /\.wjs-public-site \.wp-block-icon-list-item/);
    assert.match(css, /\.wjs-public-site \.wp-block-button:hover/);
    assert.match(css, /\.wjs-public-site\s*\{[^}]*background:\s*#fff\s*!important/s);
    assert.match(css, /--wjs-block-bg:\s*transparent/);
    assert.match(css, /--wjs-card-shadow:\s*none/);
    assert.match(css, /--wjs-color-text-main:\s*var\(--wjs-text-main\)/);
    assert.match(css, /all:\s*revert\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-hero:not\(\.has-background-image\)\s*\{\s*background-image:\s*linear-gradient\(#0008,#0008\), url\(https:\/\/example\.com\/hero\.jpg\)\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-hero\.has-background-image\s*\{\s*background-image:\s*var\(--wjs-instance-hero-background\)\s*!important/);
    assert.match(css, /\.wjs-public-site :where\(\.wjs-page-content > \.puck-children > div > \.wp-block-grid\),/);
    assert.match(css, /width:\s*calc\(100% - \(2rem\) - \(2rem\)\)\s*!important;\s*margin-left:\s*auto\s*!important;\s*margin-right:\s*auto\s*!important;\s*max-width:\s*72rem\s*!important/s);
    assert.match(css, /\.wjs-public-site :where\(\.wjs-page-content > \.puck-children > div > \.wp-block-heading\),/);
    assert.match(css, /:where\(\.wjs-page-content > \.puck-children > div > :is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\) > \.wp-block-button-wrap\)\s*\{/);
    assert.match(css, /:where\(\.wjs-page-content > \.puck-children > div > \.wp-block-text\),[^{]+\{\s*max-width:\s*65ch\s*!important;\s*margin-left:\s*max\(2rem, calc\(\(100% - 72rem\) \/ 2\)\)\s*!important;\s*margin-right:\s*auto\s*!important/s);
    assert.doesNotMatch(css, /:where\(\.wjs-page-content > \.puck-children > div > \.wp-block-text\),[^{]+\{[^}]*max-width:\s*72rem/s);
    assert.match(css, /:where\(\.wjs-page-content > \.puck-children > div > \.wp-block-text\.text-center\),[^{]+\{\s*margin-left:\s*auto\s*!important;\s*margin-right:\s*auto\s*!important/s);
    assert.match(css, /> :not\(\.wp-block-divider\):not\(\.wp-block-spacer\):not\(\.wp-block-hero\):not\(:is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\):has\(> \.wp-block-divider\)\):not\(:is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\):has\(> \.wp-block-spacer\)\):not\(:is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\):has\(> \.wp-block-hero\)\) \+ \.wp-block-heading\.heading-h2/);
    assert.match(css, /:where\(\.wjs-page-content > \.puck-children > div > \.wp-block-columns\)/);
    assert.doesNotMatch(css, /:where\(\.wjs-page-content[^{}]+\)\s*\{[^{}]*box-sizing:/s);
    assert.match(css, /margin-top:\s*calc\(\(4rem\) \+ \(4rem\)\)\s*!important/);
    assert.match(css, /\.wjs-public-site \.wjs-page-content > \.puck-children > div > \.wp-block-heading\.heading-h2:first-child,/);
    assert.match(css, /\.wjs-public-site \.wjs-page-content > \.puck-children > div > \.wp-block-hero \+ \.wp-block-heading\.heading-h2,/);
    assert.match(css, /margin-top:\s*4rem\s*!important/);
    assert.doesNotMatch(css, /\.wjs-page-content > \.puck-children > div > \.wp-block-section\s+\.wp-block-heading/);
    assert.doesNotMatch(css, /\.wjs-page-content > \.puck-children > div > \.wp-block-hero\s+\.wp-block-heading/);
    assert.doesNotMatch(css, /margin:\s*4rem auto 4rem/);
    assert.match(css, /\.wjs-public-site a\s*\{\s*text-decoration:\s*none\s*!important/);
    assert.match(css, /\.wjs-public-site \.wjs-header-actions \.wjs-header-action\s*\{\s*padding:\s*\.75rem 1.25rem\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-search \.wp-block-search-input\s*\{\s*border-bottom:\s*1px solid\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-search\.wp-block-search \.wp-block-search-button\s*\{\s*display:\s*none\s*!important/);
    assert.match(css, /\.wp-block-posts-grid-item:nth-child\(1\) \.wp-block-posts-grid-media\.uses-theme-post-image\s*\{[^}]*background-image:\s*url\("data:image\/gif;base64,[^"]+"\)\s*!important[^}]*aspect-ratio:\s*1\s*!important/s);
    assert.match(css, /\.wjs-public-site \.wp-block-image \.wp-block-image-element\s*\{\s*object-fit:\s*cover\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-posts-grid-item \.wp-block-image-element:hover\s*\{\s*opacity:\s*\.8\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-table \.wp-block-table-element\s*\{\s*border-collapse:\s*collapse\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-table \.wp-block-table-element\s*\{\s*table-layout:\s*fixed\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-table \.wp-block-table-element > thead > tr > th\s*\{\s*text-align:\s*left\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-table \.wp-block-table-element td:first-child\s*\{\s*font-weight:\s*700\s*!important/);
    assert.doesNotMatch(css, /\.wjs-public-site \.wp-block-table\s*\{\s*table-layout:/);
    assert.match(css, /\.wjs-public-site \.wjs-footer-brand \.wjs-footer-brand-title\s*\{\s*font-size:\s*2rem\s*!important/);
    assert.match(css, /\.wjs-public-site \.wjs-footer-menu \.wjs-footer-menu-title\s*\{\s*letter-spacing:\s*\.1em\s*!important/);
    assert.match(css, /\.wjs-public-site :where\(\.wjs-page-content > \.puck-children > div > \.wp-block-table\),/);
    assert.doesNotMatch(css, /wp-block-table-wrap/);
    assert.match(css, /@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Inter&display=swap'\)/);
    assert.doesNotMatch(css, /@import url\('https:\/\/fonts\.googleapis\.com'\);/);
    assert.match(css, /@keyframes fixture-fade\s*\{\s*from\s*\{/);
    assert.doesNotMatch(css, /@keyframes fixture-fade\s*\{\s*\.wjs-public-site from/);
    assert.match(css, /!important/);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.themeDir, "theme.json"), "utf8"));
    assert.equal(manifest.stitch.domContractVersion, 3);
    assert.equal(manifest.stitch.converter, "stitch-to-wordjs-theme@4");
    assert.equal(manifest.stitch.isolationMode, "isolated");
    assert.equal(manifest.stitch.puckCoverage, 28);
    assert.equal(manifest.stitch.chromeCoverage, 13);
    assert.equal(manifest.stitch.inlineStyleCount, 1);
    assert.equal(manifest.stitch.inlineStyleDeclarationCount, 1);
    assert.equal(manifest.stitch.resolvedInlineStyleCount, 1);
    assert.equal(manifest.stitch.unresolvedInlineStyleCount, 0);
    assert.equal(manifest.stitch.unresolvedInlineDeclarationCount, 0);
    assert.equal(manifest.stitch.parityStatus, "exact");
    assert.equal(manifest.stitch.resolvedInlineStyles[0].targets[0], "stitch.extractedThemeDefaults.heroBackground");
    assert.ok(manifest.stitch.compositionRecipes.topLevelSectionFrame >= 3);
    assert.equal(manifest.stitch.extractedThemeDefaults.heroBackground.property, "background-image");
    assert.deepEqual(manifest.layout.headerAction, { label: "Enquire", href: "#contact" });
    assert.deepEqual(manifest.stitch.extractedThemeDefaults.headerAction, { label: "Enquire", href: "#contact" });
    assert.deepEqual(manifest.stitch.extractedThemeDefaults.searchStructure, { hasLabel: true, hasButton: false });
    assert.equal(manifest.stitch.extractedThemeDefaults.postImages[0].aspectRatio, 1);
    assert.equal(manifest.layout.componentRecipes.version, 1);
    assert.deepEqual(manifest.layout.componentRecipes.postsGrid, {
      count: 2,
      titleTag: "h4",
      showMeta: true,
      showExcerpt: true,
      items: [
        { image: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", alt: "Architecture diagram", title: "Distributed rendering", meta: "Architecture" },
        { image: null, alt: "", title: "Design systems", meta: "Design" },
      ],
      audit: manifest.layout.componentRecipes.postsGrid.audit,
    });
    assert.equal(manifest.layout.componentRecipes.postsGrid.audit.rootCount, 1);
    assert.equal(manifest.layout.componentRecipes.postsGrid.audit.itemPaths.length, 2);
    assert.ok(Number.isInteger(manifest.layout.componentRecipes.postsGrid.audit.sourceLine));
    assert.equal(manifest.layout.componentRecipes.pricing.planCount, 2);
    assert.equal(manifest.layout.componentRecipes.tabs.count, 2);
    assert.deepEqual(manifest.layout.componentRecipes.tabs.items, [
      { label: "Overview", content: "Overview content" },
      { label: "Details", content: "" },
    ]);
    assert.deepEqual(manifest.layout.componentRecipes.sections[0].childComponentOrder, ["Heading", "Tabs"]);
    assert.ok(manifest.stitch.selectorRewrites >= 7);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("preserves a Stitch table scroll wrapper while mapping its semantic table descendant", () => {
  const fixture = runFixture(
    fixtureCss({ extra: ".wp-block-table { overflow-x: auto; } .wp-block-table table { width: 83%; }" }),
    `<div class="wp-block-table"><table><tbody><tr><td>Pro</td></tr></tbody></table></div>`,
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.wjs-public-site \.wp-block-table\s*\{\s*overflow-x:\s*auto\s*!important/);
    assert.match(css, /\.wjs-public-site \.wp-block-table \.wp-block-table-element\s*\{\s*width:\s*83%\s*!important/);
    assert.doesNotMatch(css, /\.wjs-public-site \.wp-block-table\s*\{\s*width:\s*83%/);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("reports partial parity when visible inline declarations remain unresolved", () => {
  const fixture = runFixture(
    fixtureCss(),
    '<section class="wp-block-hero" style="background-image:url(https://example.com/hero.jpg)"></section><div class="wp-block-card" style="padding:10px;color:red">Card</div><div class="specimen-only" style="transform:rotate(1deg)">Unmapped</div>',
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.themeDir, "theme.json"), "utf8"));
    assert.equal(manifest.stitch.inlineStyleCount, 3);
    assert.equal(manifest.stitch.inlineStyleDeclarationCount, 4);
    assert.equal(manifest.stitch.resolvedInlineStyleCount, 2);
    assert.equal(manifest.stitch.unresolvedInlineStyleCount, 1);
    assert.equal(manifest.stitch.resolvedInlineDeclarationCount, 3);
    assert.equal(manifest.stitch.unresolvedInlineDeclarationCount, 1);
    assert.equal(manifest.stitch.parityStatus, "partial");
    assert.equal(manifest.stitch.isolationMode, "safe-overlay");
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.wjs-public-site :where\([^{}]*\.wp-block-card[^{}]*\)\s*\{\s*all:\s*revert\s*!important/);
    assert.match(css, /\.wjs-public-site :where\([^{}]*\.wp-block-hero[^{}]*\)\s*\{\s*all:\s*revert\s*!important/);
    assert.doesNotMatch(css, /:where\([^)]*\.wp-block-card[^)]*\)\s+:where\(:not\(i\):not\(svg\)\)/);
    assert.doesNotMatch(css, /\.wp-block-grid\.cols-\d+/);
    assert.doesNotMatch(css, /margin-top:\s*calc\(\(4rem\) \+ \(4rem\)\)/);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("adapts numeric Stitch grid tracks with child spans instead of replacing the theme topology", () => {
  const fixture = runFixture(
    fixtureCss({ extra: ".wp-block-grid { grid-template-columns: repeat(12, minmax(0, 1fr)); }" }),
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.wp-block-grid\.cols-3 > \.wp-block-grid-items > \*\s*\{\s*grid-column:\s*span 4\s*!important/);
    assert.match(css, /\.wp-block-grid\.cols-4 > \.wp-block-grid-items > \*\s*\{\s*grid-column:\s*span 3\s*!important/);
    assert.doesNotMatch(css, /\.wp-block-grid\.cols-3[^{}]*\{[^{}]*grid-template-columns:/s);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.themeDir, "theme.json"), "utf8"));
    assert.equal(manifest.stitch.compositionRecipes.gridTrackCount, 12);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("maps flat Stitch accordion rows to the functional summary trigger", () => {
  const fixture = runFixture(
    fixtureCss({ extra: ".wp-block-accordion-item { display:flex; justify-content:space-between; }" }),
    '<div class="wp-block-accordion"><div class="wp-block-accordion-item">Question <span>+</span></div></div>',
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.wp-block-accordion-trigger\s*\{\s*display:\s*flex\s*!important;\s*justify-content:\s*space-between\s*!important/);
    assert.doesNotMatch(css, /\.wp-block-accordion-item\s*\{\s*display:\s*flex/);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.themeDir, "theme.json"), "utf8"));
    assert.equal(manifest.stitch.extractedThemeDefaults.accordionStructure.itemRole, "flat-trigger");
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("materializes consistent semantic inline styles as canonical component CSS", () => {
  const fixture = runFixture(
    fixtureCss(),
    `<section class="wp-block-hero" style="background-image:url(https://example.com/hero.jpg)">
       <div class="wp-block-section"><h1 class="wp-block-heading" style="font-size:clamp(3rem,10vw,6rem)">Hero</h1></div>
     </section>
     <div class="wp-block-grid">
       <div class="wp-block-card"><span class="material-symbols-outlined" style="font-size:2.5rem;color:red">star</span><h3 class="wp-block-heading" style="font-size:1.5rem">One</h3><p class="wp-block-text" style="font-size:.875rem">A</p></div>
       <div class="wp-block-card"><span class="material-symbols-outlined" style="font-size:2.5rem;color:red">star</span><h3 class="wp-block-heading" style="font-size:1.5rem">Two</h3><p class="wp-block-text" style="font-size:.875rem">B</p></div>
     </div>`,
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.wp-block-hero \.wp-block-hero-title\s*\{\s*font-size:\s*clamp\(3rem,10vw,6rem\)\s*!important/);
    assert.match(css, /\.wp-block-card \.wp-block-card-icon\s*\{[^}]*font-size:\s*2\.5rem\s*!important;[^}]*color:\s*red\s*!important/s);
    assert.match(css, /\.wp-block-card \.wp-block-card-title\s*\{\s*font-size:\s*1\.5rem\s*!important/);
    assert.match(css, /\.wp-block-card \.wp-block-card-description\s*\{\s*font-size:\s*\.875rem\s*!important/);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.themeDir, "theme.json"), "utf8"));
    assert.equal(manifest.stitch.parityStatus, "exact");
    assert.ok(manifest.stitch.compositionRecipes.canonicalInlineRuleCount >= 4);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("does not merge hero eyebrow or action-row styles into the runtime subtitle/content roles", () => {
  const fixture = runFixture(
    fixtureCss(),
    `<section class="wp-block-hero">
       <div style="position:relative;z-index:2">
         <p style="font-size:.75rem;text-transform:uppercase">Eyebrow</p>
         <h1 class="wp-block-heading">Hero</h1>
         <p class="wp-block-text" style="font-size:1.125rem;margin:1.5rem auto">Actual subtitle</p>
         <div class="wp-block-flex-row" style="justify-content:center;margin-top:2rem"><a class="wp-block-button" href="#">Go</a></div>
       </div>
     </section>`,
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.wp-block-hero \.wp-block-hero-content\s*\{[^}]*position:\s*relative\s*!important;[^}]*z-index:\s*2\s*!important/s);
    assert.match(css, /\.wp-block-hero \.wp-block-hero-subtitle\s*\{[^}]*font-size:\s*1\.125rem\s*!important;[^}]*margin:\s*1\.5rem auto\s*!important/s);
    assert.match(css, /\.wp-block-hero \.wp-block-hero-actions\s*\{[^}]*justify-content:\s*center\s*!important;[^}]*margin-top:\s*2rem\s*!important/s);
    assert.doesNotMatch(css, /\.wp-block-hero \.wp-block-hero-subtitle\s*\{[^}]*text-transform:\s*uppercase/s);
    assert.doesNotMatch(css, /\.wp-block-hero \.wp-block-hero-content\s*\{[^}]*margin-top:\s*2rem/s);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("targets H2 section rhythm inside the real single-container Puck DOM", () => {
  const fixture = runFixture(
    fixtureCss(),
    `<main class="wjs-public-site"><div class="wjs-page-content"><div class="puck-children"><div>
       <h2 id="first" class="wp-block-heading heading-h2">First section</h2>
       <div class="wp-block-card">Ordinary direct block</div>
       <div class="wjs-anim"><h2 id="after-direct" class="wp-block-heading heading-h2">Wrapped boundary</h2></div>
       <div class="wjs-anim"><div class="wp-block-spacer"></div></div>
       <h2 id="after-spacer" class="wp-block-heading heading-h2">No duplicate boundary</h2>
       <div class="wjs-anim"><section class="wp-block-hero"></section></div>
       <div class="wjs-hide-mobile"><h2 id="after-hero" class="wp-block-heading heading-h2">Hero boundary</h2></div>
     </div></div></div></main>`,
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const css = fs.readFileSync(path.join(fixture.themeDir, "style.css"), "utf8");
    assert.match(css, /\.puck-children > div > :not\(\.wp-block-divider\)[^{]+ \+ :is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\) > \.wp-block-heading\.heading-h2/);
    assert.match(css, /\.puck-children > div > :is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\):first-child > \.wp-block-heading\.heading-h2/);
    assert.match(css, /\.puck-children > div > :is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\):has\(> \.wp-block-hero\) \+ :is\(\.wjs-anim, \.wjs-hide-mobile, \.wjs-hide-tablet, \.wjs-hide-desktop\) > \.wp-block-heading\.heading-h2/);
    assert.doesNotMatch(css, /\.puck-children > div(?::not\([^)]*\))+ \+ div > \.wp-block-heading\.heading-h2/);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("accounts for a post image extracted from inline composition data", () => {
  const image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const fixture = runFixture(
    fixtureCss(),
    `<div class="wp-block-posts-grid"><article><div class="wp-block-posts-grid-media" style="background-image:url('${image}')"></div><h3>Story</h3></article></div>`,
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.themeDir, "theme.json"), "utf8"));
    assert.equal(manifest.layout.componentRecipes.postsGrid.items[0].image, image);
    assert.equal(manifest.stitch.parityStatus, "exact");
    assert.equal(manifest.stitch.unresolvedInlineDeclarationCount, 0);
    assert.deepEqual(manifest.stitch.resolvedInlineStyles[0].targets, ["layout.componentRecipes.postsGrid.items[0].image"]);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("extracts an auditable standalone Card recipe without absorbing pricing or post cards", () => {
  const image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const fixture = runFixture(
    fixtureCss(),
    `<div class="wp-block-grid">
       <div class="wp-block-card"><div class="wp-block-image"><img src="${image}" alt="Ceramic bowl"></div><span class="material-symbols-outlined">palette</span><h4 class="wp-block-heading">Craft</h4><p class="wp-block-text">Made by hand.</p></div>
       <div class="wp-block-card"><span class="wp-block-card-icon">star</span><h4 class="wp-block-heading">Quality</h4><p class="wp-block-text">Built to last.</p></div>
       <div class="wp-block-card"><div class="wp-block-card-media" style="background-image:url('${image}')"></div><h4 class="wp-block-heading">Studio</h4><p class="wp-block-text">Behind the scenes.</p></div>
     </div>
     <div class="wp-block-pricing"><div class="wp-block-card"><h3>Plan</h3><div>$10</div><a href="#">Buy</a></div></div>
     <div class="wp-block-posts-grid"><div class="wp-block-card"><h3>Post card</h3><p>Excerpt</p></div></div>`,
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.themeDir, "theme.json"), "utf8"));
    const card = manifest.layout.componentRecipes.card;
    assert.equal(card.count, 3);
    assert.equal(card.titleTag, "h4");
    assert.equal(card.showMedia, true);
    assert.equal(card.hasMedia, true);
    assert.equal(card.hasIcon, true);
    assert.equal(card.hasText, true);
    assert.equal(card.mediaStructure, "mixed");
    assert.deepEqual(card.childOrder, ["media", "icon", "title", "text"]);
    assert.deepEqual(card.items[0], {
      image,
      alt: "Ceramic bowl",
      title: "Craft",
      titleTag: "h4",
      hasMedia: true,
      hasIcon: true,
      hasText: true,
      childOrder: ["media", "icon", "title", "text"],
      media: { present: true, structure: "wrapper:div>img", containerTag: "div", elementTag: "img", source: "img" },
    });
    assert.deepEqual(card.items[1].media, { present: false, structure: "none", containerTag: null, elementTag: null, source: "none" });
    assert.equal(card.items[2].image, image);
    assert.equal(card.items[2].media.structure, "inline-background:div");
    assert.equal(card.audit.sourceCardCount, 5);
    assert.equal(card.audit.includedCardCount, 3);
    assert.equal(card.audit.excludedCardCount, 2);
    assert.deepEqual(card.audit.excluded.map((entry) => entry.reason).sort(), ["inside-posts-grid", "inside-pricing"]);
    assert.equal(card.audit.itemPaths.length, 3);
    assert.equal(manifest.layout.componentRecipes.postsGrid.count, 1);
    assert.equal(manifest.layout.componentRecipes.pricing.planCount, 1);
    assert.equal(manifest.stitch.parityStatus, "exact");
    assert.deepEqual(manifest.stitch.resolvedInlineStyles[0].targets, ["layout.componentRecipes.card.items[2].image"]);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("rejects a Stitch theme missing a required root hook", () => {
  const fixture = runFixture(fixtureCss({ omit: ".wp-block-html-embed" }));
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /missing selectors: \.wp-block-html-embed/);
    assert.equal(fs.existsSync(path.join(fixture.themeDir, "style.css")), false);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("rejects unknown WordJS-prefixed specimen hooks", () => {
  const fixture = runFixture(fixtureCss({ extra: ".wp-block-card .wp-block-imaginary-part { color: red; }" }));
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stderr, /\.wp-block-imaginary-part/);
    assert.equal(fs.existsSync(path.join(fixture.themeDir, "style.css")), false);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});
