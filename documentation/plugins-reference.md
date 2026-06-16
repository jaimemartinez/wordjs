# Plugins Reference 🔌

This document lists the official plugins available in the WordJS ecosystem and their capabilities.

## 1. Photo Carousel 📸
**ID:** `photo-carousel` | **Version:** 2.0.0

Manages image carousels for Hero sections or content sliders.

*   **Shortcode:** `[carousel id="123"]`
*   **Puck Component:** `HeroCarousel`
*   **Permissions:** `settings` (read/write), `database` (write).

---

## 2. Card Gallery 🃏
**ID:** `card-gallery` | **Version:** 1.0.0

Displays event or promo cards in a zigzag or grid layout.

*   **Shortcode:** `[cards]`
*   **Puck Component:** `CardGalleryPuck` (PromoCards)
*   **Permissions:** `settings` (read/write), `database` (write).

---

## 3. Video Gallery 🎬
**ID:** `video-gallery` | **Version:** 1.0.0

Manages YouTube video carousels.

*   **Shortcode:** `[videos]`
*   **Permissions:** `settings` (read/write), `database` (write).

---

## 4. Mail Server 📧
**ID:** `mail-server` | **Version:** 1.0.0

A complete SMTP server and email manager. Allows sending and receiving emails directly within WordJS.

*   **Features:**
    *   SMTP Server (receives mail)
    *   Nodemailer integration (sends mail)
    *   Attachment handling (saved to filesystem)
*   **Permissions:** `email` (admin), `filesystem` (read/write), `notifications` (send).

---

## 5. Conference Manager 🎟️
**ID:** `conference-manager` | **Version:** 1.0.0

Complex business logic for managing church conferences.

*   **Features:**
    *   Inscription/Registration management
    *   Hotel & Room assignment
    *   Payment tracking
*   **Permissions:** `database` (read/write), `express` (register_route).
*   **Trusted:** Bundled first-party plugin; listed in `config.trustedSystemPlugins`.

---

## 6. Database Migration 🚚
**ID:** `db-migration` | **Version:** 1.0.0

System utility to migrate data between SQLite and PostgreSQL.

*   **Capabilities:**
    *   Export data from one driver
    *   Import to another
    *   Clean up legacy database files
*   **Permissions:** `system` (admin), `database` (admin), `filesystem` (read/write).
*   **Trusted:** Bundled first-party plugin; listed in `config.trustedSystemPlugins`, which is what authorizes its `system:admin` AST-scan skip — declaring `system:admin` alone is not sufficient for third-party plugins.

---

## 7. Hello World 👋
**ID:** `hello-world` | **Version:** 1.0.0

A reference implementation for developers demonstrating testing patterns.

*   **Purpose:** Development / Education.
