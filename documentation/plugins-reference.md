# Plugins Reference 🔌

This document lists the official plugins available in the WordJS ecosystem and their capabilities.

> **Every plugin runs isolated.** All feature plugins below run in a `worker_threads` isolate and reach
> core only through the `wordjs` capability bridge. See **[Plugin Isolation](plugin-isolation-proposal.md)**.
> A plugin is either **untrusted** (sandboxed — own DB tables, non-secret options, namespaced routes,
> no outbound network) or **operator-trusted** (privileged — unscoped DB, secret options, absolute
> routes, mail provider, raw sockets). Trust is server-side only: it comes from `config.trustedSystemPlugins`
> (shipped defaults: `conference-manager`, `mail-server`) **or** an admin toggle in the Plugins UI
> (persisted in the `trusted_plugins` option). A plugin can never self-declare trust.

## 1. Photo Carousel 📸
**ID:** `photo-carousel` | **Version:** 2.0.0

Manages image carousels for Hero sections or content sliders.

*   **Shortcode:** `[carousel id="123"]` (async — expanded via `doShortcodeAsync`)
*   **Puck Component:** `HeroCarousel`
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Tier:** Untrusted (isolated). Routes namespaced under `/api/v1/plugin/photo-carousel/*`.

---

## 2. Card Gallery 🃏
**ID:** `card-gallery` | **Version:** 1.0.0

Displays event or promo cards in a zigzag or grid layout.

*   **Shortcode:** `[cards]`
*   **Puck Component:** `CardGalleryPuck` (PromoCards)
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Tier:** Untrusted (isolated). Routes namespaced under `/api/v1/plugin/card-gallery/*`.

---

## 3. Video Gallery 🎬
**ID:** `video-gallery` | **Version:** 1.0.0

Manages YouTube video carousels.

*   **Shortcode:** `[vgallery]`
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Tier:** Untrusted (isolated). Routes namespaced under `/api/v1/plugin/video-gallery/*`.

---

## 4. Mail Server 📧
**ID:** `mail-server` | **Version:** 1.0.0

A complete SMTP server and email manager. Allows sending and receiving emails directly within WordJS.

*   **Features:**
    *   SMTP Server on port 25 + direct-MX outbound delivery (runs inside the worker)
    *   Attachment handling (multipart upload parsed by the host, forwarded to the isolate)
    *   DKIM signing (private key read from a secret-named option)
    *   Registers the host-wide mail sender (`provideMail`) and a notification transport
*   **Permissions:** `email` (admin), `filesystem` (read/write), `notifications` (send).
*   **Tier:** Operator-trusted (shipped default in `config.trustedSystemPlugins`). Isolated, but the trusted
    bridge tier grants it raw sockets, secret options, `provideMail`, `notify.registerTransport`, and absolute routes.

---

## 5. Conference Manager 🎟️
**ID:** `conference-manager` | **Version:** 1.0.0

Complex business logic for managing church conferences.

*   **Features:**
    *   Inscription/Registration management
    *   Hotel & Room assignment
    *   Payment tracking
*   **Permissions:** `database` (read/write), `express` (register_route).
*   **Tier:** Operator-trusted (shipped default in `config.trustedSystemPlugins`). Isolated, with the trusted
    bridge tier for unscoped DB access, `db.getType()`, and absolute routes (portal cookies). Listing in
    `trustedSystemPlugins` is what authorizes its `system:admin` AST-scan skip — declaring `system:admin`
    alone is never sufficient for an uploaded plugin.

---

## 6. Database Migration 🚚 — now in core (no longer a plugin)
**Location:** `backend/src/core/db-admin/` | Admin UI: `/admin/db-migration` (permanent core Sidebar item)

Database administration (migrate data between SQLite and PostgreSQL, manage the embedded PostgreSQL
server process, run schema migrations at boot) is **no longer a plugin**. It was de-pluginized because
it is database infrastructure, not a feature plugin: it manages the database server itself (via
`child_process`) and must run at boot. It moved into core (`backend/src/core/db-admin/`, routes still
`/api/v1/db-migration/*`) and its admin UI is a native frontend route reached from a permanent **core**
Sidebar item — not a toggleable plugin. It is gone from `plugins/` and all generated registries, and is
**not** in `config.trustedSystemPlugins`. See **[Database](database.md)**.

---

## 7. Hello World 👋
**ID:** `hello-world` | **Version:** 1.0.0

A reference implementation for developers. Hooks-only (registers an `the_content` filter via the
bridge) and demonstrates the plugin test framework.

*   **Purpose:** Development / Education.
*   **Tier:** Untrusted (isolated).

---

## 8. Test Schema 🧪
**ID:** `test-schema` | **Version:** 1.0.0

Reference plugin for hooks + DB access through the bridge (`wordjs.db.createTable` / `db.run`).

*   **Purpose:** Development / Education.
*   **Tier:** Untrusted (isolated).
