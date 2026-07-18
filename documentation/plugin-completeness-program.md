# Plugin Completeness Program

Goal: move marketplace plugins from **v1 (WordPress-parity scope)** to **complete products** — installing
`online-store` should turn a WordJS site into a real online store; `restaurant-menu` into a real
restaurant, each with its own end-to-end public experience. This document freezes what "complete"
means, the per-flagship gap analysis, and the execution model.

All work stays inside the extension model: plugins remain **isolated** (own OS process, capability
bridge, default-deny permissions) and **no core edits** beyond explicitly listed core capabilities.

## Definition of done (per plugin)

1. **Public experience** — the plugin owns its public pages end-to-end (Puck blocks + its routes),
   responsive, with its **own visual identity** (scoped CSS, same pattern as the premium admin.css).
2. **Admin** — full lifecycle management: CRUD, states, search/filters, reports, CSV export.
3. **Money paths** (where applicable) — real payments (Stripe + manual/transfer), server-side price
   validation, atomic stock, refunds.
4. **Notifications** — transactional emails to customer and admin through the mail provider.
5. **Data** — `wjp_` tables with idempotent migrations, optional demo/seed content, exports.
6. **Verification** — an E2E checklist exercised against a running site (real order, real payment in
   test mode) before the catalog ships it.

## "Each plugin ships its own theme" — architecture

Themes and plugins are separate systems today. Three options, in order of invasiveness:

- **A. Scoped public design (available NOW, zero core work)** — the plugin ships its complete public
  look inside its own blocks/components with plugin-scoped CSS. The site keeps its active theme;
  the store/restaurant pages still look fully branded. This is the default for the program.
- **B. Companion theme (small core capability, recommended next)** — the plugin zip includes a
  `theme/` folder; on activation the admin sees "Install this plugin's theme" (one click copies it
  to `backend/themes/<slug>-theme` and optionally switches). Requires one host-side, permission-gated
  bridge (`theme:install`) reusable by every plugin. Estimated: one focused day, includes security
  review (theme code runs isolated already post theme-isolation).
- **C. Virtual theme takeover** — plugin registers itself as the active theme. Most invasive,
  not planned.

## Flagship gap analysis

### online-store v1 → v2 "tienda completa"

Has today: product catalog, client cart, checkout with server-side price validation, coupons,
orders admin, optional Stripe Checkout, manual payment.

| Gap | Notes |
|---|---|
| Product variants (size/color) + per-variant SKU & stock | atomic stock decrement at order time |
| Multiple images per product + gallery | media picker reuse |
| Shipping: zones/rates + pickup, computed at checkout | flat/by-zone v2; carriers later |
| Simple taxes (% by region) | shown in cart + orders |
| Customer accounts: order history in `/portal` | subscriber dashboard exists in core v1.5.0 |
| Transactional emails (confirmation, shipped, cancelled) | via `email:admin` + customer email |
| Refunds/returns | order state + Stripe refund call |
| Product page with SEO (og tags) + catalog search/filters/categories | public routes |
| Reports: sales by day/month, top products, CSV | admin tab |
| Stripe webhooks (`payment_intent.succeeded`) | today the redirect is the only confirmation |

### restaurant-menu v1 → v2 "restaurante completo"

Has today: sections/dishes with prices, photos, diet tags; elegant Puck block; simple online
ordering with client cart; WhatsApp handoff; order board (Nuevo/Preparando/Listo) + config.

| Gap | Notes |
|---|---|
| Dish modifiers (size, extras with price) | per-line-item options |
| Opening hours + accept-orders window + prep times | reject orders when closed |
| Table QR: per-table menu link + order-from-table | QR generator in admin |
| Table reservations | native or integrate `bookings` |
| Online payment (reuse online-store's Stripe pattern) | in addition to WhatsApp/cash |
| Live kitchen view | SSE already exists in core |
| Menu i18n (es/en) + standard allergens | per-dish fields |
| Reports: sales, top dishes, peak hours | admin tab |

## Tiers for the rest

- **T1 — full product**: online-store, restaurant-menu, bookings, event-tickets, newsletter.
- **T2 — solid feature (polish + emails + reports)**: donations, digital-downloads, invoices,
  job-board, auctions, vendor-marketplace, events-calendar, polls, testimonials, contact-forms.
- **T3 — utilities (already near-complete)**: faq, social-share, cookie-consent, notification-bar,
  popup-builder, analytics-tag, image-lightbox, breadcrumbs, related-posts, table-of-contents,
  youtube-videos.

## Execution model

One plugin per cycle: freeze spec → build workflow (one builder per module → adversarial reviewer →
fixer) → **real E2E on a running site** (a real order, a real test-mode payment) → gates (backend
tests, tsc, AST scan, catalog rebuild) → ship to catalog. Order: online-store → restaurant-menu →
bookings → event-tickets → newsletter → T2 sweep.

Sandbox cookbook every builder must respect: SQL guard (upsert = UPDATE-then-INSERT, never
`ON CONFLICT`), no transactions on the db bridge, `res.json` (never `res.send(string)`), no
`globalThis`, fs writes only under the plugin's `data/`, `network` permission declared for Stripe,
permission-gated everything (default-deny).
