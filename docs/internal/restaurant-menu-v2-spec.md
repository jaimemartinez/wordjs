# restaurant-menu v2 — frozen spec (Plugin Completeness Program cycle)

Closes every v1→v2 gap in `plugin-completeness-program.md` for `restaurant-menu`, inside the
sandbox cookbook: **no ALTER** (all new data in additive tables), UPDATE-then-INSERT upserts,
no db-bridge transactions, `res.json` everywhere, no `globalThis`, all money in integer cents,
tokens from the `wordjs.crypto` CSPRNG bridge, Stripe via `fetch` under the `network` permission.

## Schema (additive only — v1 tables `sections`, `items`, `orders` are untouched)

| Table (`wjp_restaurant_menu_` prefix) | Purpose |
|---|---|
| `settings` (name PK, value) | plugin-private secrets — Stripe secret key (write-only) |
| `modifier_groups` (id, name, name_en, min_select, max_select, is_active, sort_order) | e.g. "Tamaño" (1..1), "Extras" (0..N) |
| `modifier_options` (id, group_id, name, name_en, price_delta_cents, is_available, sort_order) | options with price deltas (cents, may be 0) |
| `item_modifier_groups` (id, item_id, group_id, sort_order) | attach groups to dishes (reusable groups) |
| `item_meta` (id, item_id, name_en, description_en, allergens, prep_minutes) | v2 per-dish fields (i18n EN, EU-14 allergen keys CSV, prep time) |
| `section_meta` (id, section_id, name_en) | section i18n |
| `tables` (id, label, token, is_active, sort_order, created_at) | restaurant tables; token feeds the QR link |
| `reservations` (id, token, customer_name, customer_phone, customer_email, party_size, reserved_date, reserved_time, notes, status, created_at) | native reservations: pending → confirmed → completed / cancelled / no_show |
| `order_meta` (id, order_id, table_id, table_label, payment_method, payment_status, stripe_session_id, paid_at, source, eta_minutes) | v2 order facts: table orders, payments (whatsapp / cash / stripe · none / pending / paid) |

Order line snapshots (`orders.items` JSON) gain `options:[{id,name,price_delta_cents}]`,
`unit_cents` and `line_cents`; the server re-reads every price and delta from the DB.

## Config (options blob) — new fields

`currencyCode` (ISO for Stripe, default `usd`), `timezone` (IANA, default server), `hoursEnabled` +
`weekHours` (`{"0".."6": [["HH:MM","HH:MM"], …]}`, Sun=0, max 2 ranges/day, overnight ranges
supported), `closedMessage`, `prepMinutesDefault`, `tableOrderingEnabled`, `menuPageUrl` (page that
hosts the block — QR links point there), `reservationsEnabled`, `reservationPartyMax`,
`payOnlineEnabled`, `i18nEnabled`. Stripe secret key is NOT here — write-only in `settings` table.

## Endpoints

Public (all rate-limited, tokens never sequential ids):
- `GET /public/menu?lang=es|en` — + modifiers, allergens, prep_minutes, EN substitution.
- `GET /public/config` — + `isOpen`, `weekHours` display, table/reservation/payment toggles.
- `GET /public/table?token=` — table label for QR mode banner.
- `POST /public/order` — + `option_ids` per line (validated vs group min/max/membership),
  `table_token` (table orders skip delivery legs), `payment_method` (`whatsapp|cash|stripe`),
  rejects when closed (`hoursEnabled`); Stripe leg mirrors online-store (Checkout Session,
  metadata token, degrade-to-whatsapp on failure); answers `etaMinutes`; SSE-notifies kitchen.
- `GET /public/confirm-stripe?token&session_id` — verify against Stripe, mark paid (idempotent).
- `GET /public/order-status?token=` — customer progress view (status, payment, eta).
- `POST /public/reservation` + `GET /public/reservation?token=` — create/lookup; validates window
  vs `weekHours`, party size, future date; emails restaurant; SSE-notifies.

Admin (auth+admin):
- Modifiers: `GET /modifier-groups`, `POST|PUT|DELETE /modifier-groups(/:id)`, `POST /modifier-groups/:id/move`,
  `POST|PUT|DELETE /modifier-options(/:id)`, `POST /modifier-options/:id/move`, `PUT /items/:id/modifier-groups`.
- Menu i18n/meta: `PUT /items/:id` + `PUT /sections/:id` accept the new fields (meta upserted
  UPDATE-then-INSERT); `GET /admin/menu` returns merged meta + attached group ids.
- Tables: `GET|POST /tables`, `PUT|DELETE /tables/:id`, `POST /tables/:id/move` (QR SVG built client-side).
- Reservations: `GET /reservations?date&status`, `POST /reservations` (manual), `POST /reservations/:id/status`
  (confirm emails the customer), `DELETE /reservations/:id`.
- Kitchen: `GET /kitchen` — active board (age, table, payment); UI pairs it with the core
  notifications SSE stream (`restaurant_order` broadcasts carry zero PII) + poll fallback.
- Reports: `GET /reports?from&to` (JS-aggregated in restaurant tz: revenue/day, top dishes,
  peak hours, payment & source split), `GET /reports/csv?from&to` → `{csv}`.
- Stripe: `GET /stripe-status`, `POST /stripe-key` (write-only, never echoed).

## Manifest 2.0.0
Adds `{scope:"network"}` (api.stripe.com) and `{scope:"notifications", access:"send"}` (kitchen SSE).

## Client
- **Puck block**: modifier picker modal (radio/checkbox per group, min/max enforced), es/en toggle
  (+ allergen chips), closed banner + weekly hours, table mode via `?rm_table=` (banner, no delivery
  form, pay at table/online), Stripe checkout redirect + `rm_order/rm_session` return confirmation,
  reservation form (optional per-block), ETA on success. All prices re-computed server-side.
- **Admin**: new tabs — Modificadores, Cocina (live SSE board with elapsed timers), Mesas (QR
  generator: embedded pure-TS QR encoder → SVG + print sheet), Reservas (day board + manual add),
  Informes (range tiles, top dishes, peak hours, CSV); Menú item modal gains EN/allergens/prep/groups;
  Config gains hours editor, timezone, table/reservation/payment toggles, Stripe key, menu URL.

## E2E gate (before catalog rebuild)
Real order with modifiers on a running site; table-QR order; kitchen SSE tick; reservation;
closed-window rejection; reports reflect the orders; backend tests + frontend tsc green.
