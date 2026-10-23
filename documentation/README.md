# WordJS documentation

Every guide in this folder, grouped by what you are trying to do. The project overview and quick start
are in the [repository README](../README.md); security reports go through [SECURITY.md](../SECURITY.md).

## Tutorials

- [Tutorials](tutorials/README.md) — step-by-step walkthroughs.

## Using the admin

- [Admin guide](admin-guide/README.md) — running a site from the admin panel, screen by screen: your account, media and
  folders, posts and tags, menus, comments, users, settings, plugins, and the site address and HTTPS.

## Getting started

- [development.md](development.md) — installing dependencies, the compiled build, the strict typecheck, and running the services in development or production.
- [architecture.md](architecture.md) — the high-level picture: run modes, request flow, plugin sandbox, themes, editor and file layout.

## Operating and deploying

- [deployment.md](deployment.md) — production deployment: deployment modes, releases, running as a service, containers, sandbox memory caps and the configuration reference.
- [gateway.md](gateway.md) — the gateway: reverse proxy, service registry, health checks and its internal mTLS API.
- [separate-mode.md](separate-mode.md) — running the gateway, backend and frontend on different machines, joined by join tokens.
- [multi-node.md](multi-node.md) — horizontal scaling: N backend replicas on shared Postgres/MySQL, Redis and storage.
- [site-address.md](site-address.md) — the main address, the other addresses, and which hosts the site answers.
- [observability.md](observability.md) — structured logs, request ids and Prometheus metrics.
- [cli.md](cli.md) — the CLI toolkit and the npm scripts for building, running and maintaining the backend.

## Building on WordJS

- [plugins.md](plugins.md) — the plugin development guide: manifest, capability bridge, grants, admin UI, Verso blocks, portals.
- [plugins-reference.md](plugins-reference.md) — the official plugins and their capabilities.
- [plugin-database.md](plugin-database.md) — writing plugin SQL that runs on every supported database.
- [api.md](api.md) — the REST API: authentication, middleware, endpoints and extensibility points.
- [themes.md](themes.md) — the theme contract: `theme.json`, templates, chrome, slots and limits.
- [theming.md](theming.md) — the token-driven WordJS UI framework (`wordjs-ui.css`) and the `--wjs-*` tokens.
- [block-class-identity.md](block-class-identity.md) — the `wjs-block-*` classes every block emits, and the deprecated `wp-block-*` alias.
- [stitch-brief.md](stitch-brief.md) — a generated brief for designing a WordJS theme in Stitch.
- [generated/plugin-visual-contract.md](generated/plugin-visual-contract.md) — the visual contract for plugins, generated from `contracts/visual-contract.v1.json`.

## Features

- [multisite.md](multisite.md) — several sites, each with its own address, database, users and settings, from one install.
- [ai-agents.md](ai-agents.md) — the MCP server: AI assistants read and draft content through capabilities an administrator grants.
- [ai-provider.md](ai-provider.md) — the AI provider layer behind the editor's suggestions and plugins granted `ai:use`.
- [graphql.md](graphql.md) — the GraphQL endpoint: queries, mutations, uploads, SSE subscriptions, limits and extension seam.
- [webhooks.md](webhooks.md) — outgoing webhooks: the event catalogue, payloads and signatures.
- [media-storage.md](media-storage.md) — serving the media library from local disk or an S3-compatible bucket + CDN.
- [notifications.md](notifications.md) — the real-time, multi-transport notification system.
- [wordpress-import.md](wordpress-import.md) — migrating a WordPress site from its WXR export.
- [mail-server.md](mail-server.md) — the mail-server plugin: inbound SMTP, direct-to-MX delivery and webmail.

## Architecture and internals

- [core-modules.md](core-modules.md) — reference for the backend's core modules.
- [database.md](database.md) — drivers, fallback, migrations, the core schema, full-text search and multisite storage.
- [frontend.md](frontend.md) — the Next.js app: public SSR, multisite routing, the admin, Verso and the UI library.
- [security.md](security.md) — the security architecture: plugin sandbox, grants, mTLS, CSRF, headers and the production checklist.
- [multisite-design.md](multisite-design.md) — the multisite design, its isolation guarantees and what each phase built.

## Design records

- [adr/](adr/) — architecture decision records for the content program:
  [0001 F0 foundation contract](adr/0001-f0-foundation-contract.md),
  [0002 F1 declarative content schema](adr/0002-f1-declarative-content-schema.md),
  [0003 F2 generated content contracts](adr/0003-f2-generated-content-contracts.md),
  [0004 F3 transactional content and outbox](adr/0004-f3-transactional-content-outbox.md),
  [0005 F4 versioned revisions](adr/0005-f4-versioned-extensible-revisions.md),
  [0006 F5 unified visual contract](adr/0006-f5-unified-visual-contract.md),
  [0007 F6 migration and certification](adr/0007-f6-migration-certification.md).
- [verso/](verso/README.md) — the Verso editor's live specs and the historical records of how it replaced the previous editor.
- [archive/](archive/README.md) — historical records kept for their reasoning, not as descriptions of current code.
