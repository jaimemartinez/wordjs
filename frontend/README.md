# WordJS Frontend

The WordJS frontend package: a [Next.js](https://nextjs.org) (App Router) app that serves **both** the public site and the admin dashboard.

- **Public site** — server-rendered (SSR/RSC) routes under `src/app/(public)/` (home, posts, pages, search).
- **Admin dashboard** — management UI under `src/app/admin/`.
- **Visual editor** — **Verso**, WordJS's own page builder, with no third-party editor package behind it (`src/components/verso/` for the editor UI and `src/lib/verso/` for the store/registry/commands; `src/components/versoConfig.tsx` holds the block config and custom field pickers). Plugins can inject custom Verso components.

## Documentation

The canonical reference for this package is [`../documentation/frontend.md`](../documentation/frontend.md) — it covers the structure, gateway self-registration (`src/instrumentation.ts`), the SSR data layer, Verso, and ports. For running/deploying the whole stack, see [`../documentation/deployment.md`](../documentation/deployment.md).

## Run model

This is **not** a standalone `localhost:3000` Next.js app. The frontend is one of WordJS's services:

- It listens on internal port **`3001`** by default and is reached through the WordJS **gateway** on port `3000` (or `80`/`443` in production).
- It can also run inside the **monolith** (a single process on `:3000`).
- In the browser the frontend calls a **relative** `/api/v1` path (see `src/lib/api.ts`), so it reaches the backend through the gateway automatically — there is no client-side API-URL env var to set. For SSR fetches the backend base is resolved server-side from `WORDJS_MONO_ORIGIN` (monolith) or `wordjs-config.json` (split), with an optional `INTERNAL_API_URL` override; see [`../documentation/frontend.md`](../documentation/frontend.md).

See [`../documentation/frontend.md`](../documentation/frontend.md) and [`../documentation/deployment.md`](../documentation/deployment.md) for the full setup; this is a beta, self-hosted project, so prefer those docs over duplicating details here.
