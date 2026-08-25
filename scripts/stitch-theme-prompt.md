# Google Stitch → WordJS theme — authoring prompt

Paste the prompt below into **Google Stitch** to generate a landing page that the converter turns into a
full-fidelity WordJS theme in one command:

```bash
node scripts/stitch-to-wordjs-theme.mjs --theme backend/themes/<slug> --html <design>.html
```

The converter **renders your design in headless Chrome and measures the computed styles** (colors, fonts,
radii, shadows, spacing) of each region, then maps them to the `--wjs-*` token contract. You do **not**
hand-author any CSS or token block — just design freely with Tailwind. The only thing that matters is that
each region carries the **contract class** below, so the measurer can find it reliably on *any* design.

---

## The prompt (copy/paste into Stitch)

> Design a single, comprehensive **theme showcase** page for **{describe the brand / product}** — a page
> that demonstrates EVERY component of the design system on one screen (like a Storybook/style-guide page),
> not just a marketing landing page. Use Tailwind utility classes for all styling. Commit to ONE cohesive
> visual system: a primary brand color, a light or dark canvas, one display font for headings and one body
> font (load both from Google Fonts), a consistent corner radius, soft shadows, and generous section spacing.
>
> Build the page with EXACTLY these sections, and add the given class to each element (keep your Tailwind
> classes too — just add these alongside). Every section title is an `<h2 class="wp-block-heading heading-h2">`.
>
> - Wrap everything in `<div class="wjs-public-site">`.
> - **Header** `<header class="wjs-site-header">` → `<div class="wjs-header-container">` with a logo
>   `<a class="wjs-header-logo">`, a nav `<nav class="wjs-header-nav">` of 4 links, and
>   `<div class="wjs-header-actions">` with `<a class="wp-block-button button-variant-primary">`.
> - **Hero** `<section class="wp-block-hero">` → `<h1 class="wp-block-hero-title">`,
>   `<p class="wp-block-hero-subtitle">`, and `<div class="wp-block-hero-actions">` with a
>   `button-variant-primary` and a `button-variant-secondary` button.
> - **Stats bar** `<section class="wp-block-section"><div class="wp-block-stats">` → 3–4
>   `<div class="wp-block-stats-item">`, each `<div class="wp-block-stats-value">` (big number, brand color)
>   + `<div class="wp-block-stats-label">`.
> - **Features** `<section class="wp-block-section"><div class="wp-block-grid">` → 3 `<div class="wp-block-card">`,
>   each `<div class="wp-block-card-icon">` (brand-color chip) + `<h3 class="wp-block-card-title">` +
>   `<p class="wp-block-card-description">`.
> - **Feature list** `<section class="wp-block-section"><ul class="wp-block-icon-list">` → 4
>   `<li class="wp-block-icon-list-item">`, each a `<span class="wp-block-icon-list-icon">` (brand check icon)
>   + text.
> - **Tabs** `<section class="wp-block-section"><div class="wp-block-tabs">` → `<div class="wp-block-tabs-nav">`
>   with 3 `<button class="wp-block-tabs-tab">` (mark the first `active`) + `<div class="wp-block-tabs-panel">`.
> - **FAQ / Accordion** `<section class="wp-block-section"><div class="wp-block-accordion">` → 3
>   `<div class="wp-block-accordion-item">`, each `<button class="wp-block-accordion-trigger">` +
>   `<div class="wp-block-accordion-panel">`.
> - **Pricing** `<section class="wp-block-section"><div class="wp-block-pricing">` → 3
>   `<div class="wp-block-pricing-plan">` (`<h3 class="wp-block-pricing-name">`, `<div class="wp-block-pricing-price">`,
>   a feature list, and a `wp-block-button`); mark the middle one `is-highlighted`.
> - **Comparison table** `<section class="wp-block-section"><table class="wp-block-table">` with a real
>   `<thead>`/`<th>` header row and `<td>` cells.
> - **Testimonial** `<section class="wp-block-section"><div class="wp-block-testimonial">` →
>   `<p class="wp-block-testimonial-quote">` + `<div class="wp-block-testimonial-name">` (or use a
>   `<blockquote class="wp-block-quote">`).
> - **Blog / posts** `<section class="wp-block-section"><div class="wp-block-posts-grid">` → 3
>   `<article class="wp-block-posts-grid-item">`, each an image, a `<span class="wp-block-posts-grid-meta">`
>   tag/badge, `<h3 class="wp-block-posts-grid-title">`, and `<p class="wp-block-posts-grid-excerpt">`.
> - **Media** `<section class="wp-block-section">` with a `<div class="wp-block-video-embed">` containing a
>   16:9 `<div class="wp-block-video-embed-frame">` with a round brand play button
>   `<button class="wp-block-video-embed-placeholder">`; AND a `<div class="wp-block-audio-player">` →
>   `<div class="wp-block-audio-player-layout">` with a round play `<button class="wp-block-audio-player-icon">`,
>   a `<div class="wp-block-audio-player-body">` holding `<div class="wp-block-audio-player-title">` and a
>   `<div class="wp-block-audio-player-track">` containing a filled `<div class="wp-block-audio-player-progress">`.
> - **Search** `<section class="wp-block-section"><div class="wp-block-search">` →
>   `<input class="wp-block-search-input">` + `<button class="wp-block-search-button">`.
> - **CTA** `<section class="wp-block-cta-banner">` → `<h2 class="wp-block-cta-banner-title">`, a subtitle,
>   and a primary button.
> - **Footer** `<footer class="wjs-site-footer"><div class="wjs-footer-grid">` → `<div class="wjs-footer-brand">`,
>   two `<div class="wjs-footer-menu">` (each an `<h3>` + links), `<div class="wjs-footer-socials">` (icon
>   links), and `<div class="wjs-footer-copyright">`.
>
> Do NOT add a `<style id="wordjs-theme">` block or any `--wjs-*` variables — the converter derives those by
> measuring your rendered design. Keep the Tailwind/Google-Fonts CDN links in `<head>`. Output one complete,
> self-contained HTML file.

The more of these blocks the design actually renders, the more of them the converter can MEASURE and style
with real values (instead of a token fallback). This showcase covers the full set the WordJS editor exposes.

---

## Why the classes matter

`scripts/stitch-measure.mjs` finds each role by its **contract class first** (`.wp-block-hero`,
`.wp-block-card`, `.button-variant-primary`, `.wjs-site-header`, …), then falls back to structural
heuristics. The contract path is what makes conversion **reliable and universal**: any design authored with
this prompt measures cleanly and captures the *primary brand color, on-primary, radius scale, shadow scale,
header glass/backdrop, footer, hero rhythm, card geometry, and typography* — the things that were previously
lost. A design that omits these classes still converts (heuristic fallback), but the brand color and a few
regions may be guessed less accurately.

## The full contract (reference)

- Chrome: `.wjs-public-site`, `.wjs-site-header`, `.wjs-header-container`, `.wjs-header-logo`,
  `.wjs-header-nav`, `.wjs-header-actions`, `.wjs-site-footer`, `.wjs-footer-grid`, `.wjs-footer-brand`,
  `.wjs-footer-menu`, `.wjs-footer-socials`, `.wjs-footer-copyright`.
- Blocks (any subset you use): `.wp-block-hero` (+ `-title`/`-subtitle`/`-actions`), `.wp-block-section`,
  `.wp-block-grid`, `.wp-block-card` (+ `-icon`/`-title`/`-description`), `.wp-block-button`
  (`.button-variant-primary` / `.button-variant-secondary`), `.wp-block-pricing` (+ `-plan`),
  `.wp-block-quote`, `.wp-block-testimonial`, `.wp-block-cta-banner`, `.wp-block-heading`, `.wp-block-text`.

The authoritative list lives in `scripts/wordjs-theme-contract.mjs`.
