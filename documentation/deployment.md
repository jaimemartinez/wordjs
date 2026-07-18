# Production Deployment Guide 🚀

WordJS is designed to be easy to deploy. It defaults to a file-based **SQLite** database for zero-config startups, but fully supports **PostgreSQL** for high-scale external database needs.

---

## 🧭 Deployment Modes: Split, Monolith & Separate

The **same codebase** runs as **two mutually-exclusive process models** — **Split** and **Monolith** — and you can switch between them **at any time** with **no migration**. Both share the same `backend/wordjs-config.json`, the same database, the same `uploads`/`themes`/`plugins`, the same secrets, and the same public origin (default `https://localhost:3000`). They are **mutually exclusive** because both bind the public port (default `3000`), so run one or the other. A third topology, **Separate**, is Split spread across **different machines** (joined by gateway-minted join tokens — see below).

In **both** modes, plugins marked `"isolated": true` run **in a separate OS process** (`child_process.fork`) behind the `wordjs` capability bridge — that behavior is identical. See **[Plugin Sandbox & Memory Caps](#-plugin-sandbox--memory-caps)** for the operator-facing knobs.

### Split (default — 3 processes)

The gateway (`:3000`, public) + backend (`:4000`) + frontend (`:3001`). The gateway is a Node `cluster` reverse-proxy that provides clustering, health-checks, load-balancing, an mTLS internal channel, and SSE-aware proxying.

- **Dev:** `npm run dev`
- **Prod:** `npm start`

### Monolith (1 process, 1 port `:3000`)

A single artifact via the repo-root entrypoint `monolith.js`. It mounts the **backend Express app** (with its isolated plugins, each running in its own forked OS process) **and** the **Next.js request handler** **in-process** — no loopback proxy, no Node `cluster`, no gateway `/register`. The gateway's still-needed cross-cutting concerns are re-implemented as **local middleware**: `helmet`, `compression` (skipping SSE), SEO rewrites (`/sitemap.xml` → `/api/v1/seo/sitemap.xml`, `/robots.txt` → `.../robots.txt`), and `X-Forwarded-Host` pinning for CSRF. It serves **one HTTPS port** reusing the gateway's certificate (HTTP fallback), plus a loopback-only HTTP listener for the frontend's server-side (SSR) API calls.

- **Dev:** `npm run dev:mono` (Next dev HMR + `ts-node` backend)
- **Build:** `npm run build:mono` (compiles backend to `dist/` + runs `next build`)
- **Prod:** `npm run start:mono` (runs the compiled build)

> **How it works internally:** `monolith.js` sets `WORDJS_EMBEDDED=1` (and `WORDJS_MODE=mono`); the backend's `src/index.ts` detects this, skips its own self-listen and gateway self-register, and exposes `initialize()` for in-process mounting.

### Separate (split across different machines)

**Split** can also run with the three services on **different hosts** — a gateway box, a backend box, and a frontend box — joined into one cluster. Because the tiers talk over **mutual TLS**, each node needs a cert signed by a shared cluster CA; WordJS bootstraps that trust with **single-use join tokens** (like `kubeadm join`) instead of hand-copying certs:

1. **Gateway (the cluster CA):** `node scripts/cluster.js init --host <gateway-ip>` mints the CA (CA key kept `0600` on the gateway), issues the gateway's identity + a cluster-CA-signed public cert, writes a multi-node `gateway/gateway-config.json` (`gatewayInternalBind`, `gatewayEnrollPort` default **3101**), and clears the registry.
2. **Mint a token per node:** `node scripts/cluster.js token backend` / `… token frontend` prints the exact `node-join` command (with the gateway address, enroll port, token, and CA fingerprint).
3. **On each node:** `node scripts/node-join.js --role … --gateway … --token … --ca-hash … --advertise …` makes one `POST /enroll` call, receives a signed `CN=<role>` cert + the cluster CA + bootstrap config, writes `<role>/certs/*` and `<role>/wordjs-config.json`, and starts the service, which registers over mTLS.

One backend + one frontend per gateway needs **no** shared database or filesystem — SQLite stays on the single backend and the frontend reaches uploads through the gateway. Scaling a role to **N** replicas is a further step (Postgres + Redis + shared FS). Full step-by-step: **[separate-mode.md](separate-mode.md)**; horizontal scaling: **[multi-node.md](multi-node.md)**.

- **Dev/Prod:** the same `npm start` (split) on each machine — `node-join --start` launches it for you.

### Which one should I pick?

| | **Monolith** | **Split** |
|---|---|---|
| **Best for** | Simplest single-artifact deploy: one VM/container | Scaling services independently |
| **Processes / ports** | 1 process, 1 public port (`:3000`) | 3 processes (`:3000` / `:4000` / `:3001`) |
| **TLS** | Built-in HTTPS, or a single reverse proxy in front | Reverse proxy / Cloudflare in front of the gateway |
| **You get** | Minimal footprint, fewer moving parts | Gateway clustering, health-checks, load-balancing, mTLS internal channel |

> Steps **1–4** below (clone, build, plugin frontends, configure) apply to both modes. The split-specific PM2 layout is in **[Run in Production](#-run-in-production)**; for monolith you run a single process (`npm run start:mono`, e.g. under PM2 as `pm2 start npm --name wordjs -- run start:mono`).

---

## 📦 Releases & Distribution

WordJS ships **downloadable, pre-compiled bundles** so an operator can deploy without cloning the repo or building anything locally. If you just want to run WordJS, grab a release ZIP instead of following the from-source installation steps below.

> **First release:** [v1.0.0](https://github.com/jaimemartinez/wordjs/releases) at `github.com/jaimemartinez/wordjs/releases`.

### How a release is cut (maintainers)

Push a version tag and the release pipeline does the rest:

```bash
git tag v1.0.0
git push origin v1.0.0
```

A `v*` tag triggers **`.github/workflows/release.yml`**, which runs `npm run install:all` then `npm run bundle-release` (root `scripts/make-release.js`). The packager:

1. Builds the **frontend** (`next build` → `.next`).
2. Compiles the **backend** to `dist/` (`tsc`), so the bundle runs without `ts-node`.
3. Builds the **plugin frontend bundles** (`backend/scripts/build-plugin.js --all`).
4. Writes a self-contained `INSTALL.md` and writes the ZIP as `release/wordjs-compiled-release.zip`, zipping everything **except** `node_modules`, `.git`/`.github`, the `release/` folder, local config (`wordjs-config.json`, `gateway-config.json`), `.env`, logs, debug/CLI scripts, and the `marketplace/` tree (marketplace plugins ship as separate release assets, never inside the core bundle).

Beyond those, the packager applies a **security-anchored secret filter** so no credentials or runtime state can leak into a bundle:

- **Any** `*.db` / `*.sqlite` / `*.sqlite3` / `*.key` / `*.pem` / `*.mailenc` file, wherever it sits.
- The runtime DB/cert/TLS directories: `data/`, `backend/data/`, `certs/`, `backend/certs/`, `gateway/certs/`, `gateway/ssl/`.
- **Each plugin's own `plugins/<slug>/data/` directory** — e.g. `mail-server`'s AES-GCM root key (`.mailenc`).
- Any **config backup** carrying `jwtSecret`/`gatewaySecret`/`dbPassword` — both `*-config.json` and any basename containing `wordjs-config` / `gateway-config` (so `wordjs-config.backup.json` is caught, not just `wordjs-config.json`).

After the core bundle, the workflow runs `npm run build:marketplace` (`backend/scripts/build-marketplace.js`), which packs every plugin under `marketplace/plugins/` into per-plugin zips plus a `marketplace-index.json` catalog (sha256 per entry) in `marketplace/dist/`.

The workflow then publishes a **GitHub Release** with the versioned `wordjs-<tag>.zip` (copied from `wordjs-compiled-release.zip` on tag pushes) attached **plus the marketplace assets** (`marketplace/dist/*`), with auto-generated release notes. A manual **`workflow_dispatch`** run builds the same bundles but uploads them only as **workflow artifacts** (`wordjs-compiled-release` — the un-versioned `wordjs-compiled-release.zip` — and `wordjs-marketplace`) — no Release is created — which is handy for testing the packaging.

### What the bundle contains

- **Pre-compiled** frontend (`.next`), backend (`dist/`), and plugin bundles — recipients **do not build or compile anything**.
- **No secrets.** `jwtSecret`, `gatewaySecret`, and the DB password are **generated locally during install** and written to `backend/wordjs-config.json` — they never ship and are never committed. The packager's secret filter (above) additionally strips any `*.key`/`*.pem`/`*.mailenc`, the cert/TLS dirs, each plugin's `plugins/<slug>/data/`, and config backups so even a stray local secret can't be bundled.
- **No data.** The database is created fresh by the install wizard; no `database.sqlite` (or any `*.db`/`*.sqlite`/`*.sqlite3`) is included.
- **No marketplace plugins.** Optional plugins are installed post-deploy from the admin **Marketplace** tab (see below), not shipped in the bundle.

> **Plugin marketplace at runtime.** The admin **Plugins → Marketplace** tab lists a catalog the backend fetches **server-side** (`backend/src/routes/marketplace.ts`). With no configuration it uses the committed catalog at `https://raw.githubusercontent.com/jaimemartinez/wordjs/main/marketplace/dist` — so the server needs outbound HTTPS to `raw.githubusercontent.com` for the tab to work (a dev/full checkout with a local `marketplace/dist/` uses that instead). The `marketplace_source` option (admin-configurable) overrides the source: an `https://` URL — e.g. pin a fixed catalog snapshot at `https://github.com/jaimemartinez/wordjs/releases/download/vX.Y.Z`, since tagged releases attach the same assets — or a **local directory** for air-gapped installs. Downloads are **sha256-verified** against the catalog entry and installed through the **same pipeline as manual zip uploads** (size cap, Zip-Slip/zip-bomb guards, manifest + AST scan), so the marketplace adds no new install surface beyond the catalog fetch itself.

### How an operator deploys a release

> **Fastest path — `npx create-wordjs`.** The `create-wordjs` bootstrapper (`packages/create-wordjs`, published to npm by the same release pipeline) downloads and unpacks the latest release ZIP for you:
> ```bash
> npx create-wordjs my-site
> ```
> Then `cd my-site`, `npm run release:install`, and `npm run start:mono` (or `npm start`). The manual download below is the equivalent, step-by-step alternative.

1. Download `wordjs-<tag>.zip` from the GitHub Release and unzip it.
2. Install **runtime deps only** (no build/compile step — prebuilt native binaries are downloaded):
   ```bash
   npm run release:install
   ```
3. Start in either mode:
   ```bash
   npm run start:mono     # single process, one port (simplest), default https://localhost:3000
   # or
   npm start              # 3-service split: gateway + backend + frontend
   ```
4. **Read the one-time install token from the server console.** On a not-yet-installed instance the boot path mints a random token and prints it in a banner:
   ```
   🔑 WordJS install token:
      <token>
   ```
   The pre-install endpoints (`POST /setup/install`, `POST /setup/test-db`) reject any request whose token is missing or mismatched (constant-time), so this gates a pre-install takeover. The install wizard prompts for it; supply it via the `x-install-token` header or an `installToken` body field. For headless/Docker deploys the same token is **also** mirrored to a `0600` file in the runtime data dir (`backend/data/install-token`, never shipped, removed once installed) and can be **overridden** out-of-band via the `WORDJS_INSTALL_TOKEN` env var — but an operator-supplied env token **must be ≥ 16 chars** or it is ignored (a warning is logged) and a random token is used instead. The token is in-memory only: a fresh one is minted on each restart while uninstalled, and it becomes irrelevant once the instance is installed.
5. Finish in the **browser install wizard**: pick **SQLite** (zero-config) or **PostgreSQL**, then create your admin account. See `INSTALL.md` inside the bundle for the same steps.

> **LAN / remote access & TLS.** In monolith mode the process binds **`0.0.0.0`** on the public port, so it is reachable from other machines. The backend's **Site-URL guard rejects host mismatches**, so set the site host / `siteUrl` (in the install wizard or `backend/wordjs-config.json`) to the **IP or domain you will actually use** — not `localhost`. For a public deployment, terminate **TLS at a reverse proxy** (Nginx/Caddy/Cloudflare) in front of the bundle, or use the built-in HTTPS. (Behind a TLS-terminating proxy you can force the monolith to serve **plain HTTP** by setting `WORDJS_HTTP=1`, which skips the self-signed/gateway-cert resolution entirely.) CORS needs **no per-deployment config**: it allows the configured origins (`siteUrl`, `frontendUrl`, `gatewayUrl`) **plus any same-origin request** — detected by matching the request's `Origin` hostname to the `Host` header it arrived on (`Host` is browser-set and unforgeable by cross-origin JS). Because the monolith (and a reverse proxy that forwards `Host`) serves the app and API from one origin, this same-origin match covers `npx create-wordjs` + nginx with zero CORS tuning. Only an explicit `nodeEnv: "development"` additionally reflects `localhost`/`127.0.0.1`/`::1`; an arbitrary origin is never reflected (since `credentials: true` is set).

> The remaining sections describe installing **from source** (clone + build) and running under **PM2**. The release bundle skips the build steps — go straight from `npm run release:install` to `npm run start:mono` / `npm start`.

---

## 📋 Prerequisites

- **Node.js:** v20.9 or higher (the `engines` field requires `>=20.9.0`; CI builds and tests on Node 22).
- **PM2:** (Recommended) A process manager for Node.js to keep your app alive.
  ```bash
  npm install -g pm2
  ```

---

## 🛠️ Installation Steps

### 1. Clone & Install
```bash
git clone <your-repo-url>
cd wordjs
# Installs root + backend + frontend + gateway + setup deps in one shot
npm run install:all
```

### 2. Build the Backend & Frontend
Both the backend and the frontend are **compiled** for production.

```bash
# Backend: strict typecheck + emit dist/ (prod runs node dist/index.js, no ts-node)
cd backend
npm run build      # tsc -p tsconfig.build.json (cleans dist/ first)
cd ..

# Frontend: Next.js production build
cd frontend
npm run build
cd ..
```

> The backend `server.js` supervisor automatically runs the compiled `dist/index.js` when it exists, and only falls back to `ts-node` when no build is present. Always run `npm run build` for production. See **[development.md](development.md)** for the full dev vs prod workflow.

### 3. Build Plugin Frontends (NEW)
WordJS uses a hybrid system. In production, plugins load frontend code from pre-compiled bundles. You must compile them once before starting.
```bash
cd backend
node scripts/build-plugin.js --all
cd ..
```

### 4. Configure the Site
You have two options for production:

**A. Using the Interactive Installer (Default)**
1. Start the app (see "Run in Production").
2. The server will detect that `wordjs-config.json` is missing and start in **Setup Mode**.
3. Visit your server's IP/Domain (e.g., `http://localhost:3000`).
4. You will be redirected to the installation screen to set up your admin account and site details.

**B. Using Configuration File (Recommended)**
All configuration is handled via `wordjs-config.json` in the `backend` directory.

Example `backend/wordjs-config.json`:
```json
{
  "siteUrl": "https://my-site.com",
  "frontendUrl": "https://my-site.com",
  "port": 4000,
  "gatewayPort": 3000,
  "jwtSecret": "auto-generated-secure-secret",
  "gatewaySecret": "auto-generated-secure-secret",
  "nodeEnv": "production"
}
```

> The **gateway has its own config file** at `gateway/gateway-config.json` (`gatewaySecret`, `gatewayPort`, `gatewayInternalPort`, `ssl`, `mtls`). The setup orchestrator (`npm run setup`) writes the matching secret into both files and generates the mTLS cluster CA + per-service certs. Keep the two `gatewaySecret` values in sync.

> **Database choice:** SQLite is the zero-config default — the canonical driver is `sqlite-native` (better-sqlite3); `sqlite-legacy` (pure-JS WASM) is an automatic fallback. For Postgres set the `db` block to use the `postgres` driver (the `pg` client) pointed at an external Postgres server.

---

## 🏃 Run in Production

> **Deploying a release bundle?** You can skip the build steps entirely — see **[Releases & Distribution](#-releases--distribution)**. After `npm run release:install`, run `npm run start:mono` (or `npm start`) and the PM2 patterns below apply unchanged.

> **Monolith mode?** Skip the three-process layout below and run a single process: `npm run start:mono` (after `npm run build:mono`), e.g. `pm2 start npm --name wordjs -- run start:mono`. See **[Deployment Modes](#-deployment-modes-split-vs-monolith)**. The rest of this section covers the default **split** deployment.

We recommend using **PM2** to manage the three components (Gateway, Backend, Frontend).

### A. Automatic (using concurrently)
You can use the root script but it's less granular for logs:
```bash
pm2 start "npm start" --name wordjs
```

### B. Granular (Recommended)
This allows you to restart individual services if needed.

```bash
# Start Gateway
pm2 start gateway/src/index.js --name "wordjs-gateway"

# Start Backend (server.js supervisor runs the compiled dist/index.js)
cd backend
pm2 start npm --name "wordjs-backend" -- start

# Start Frontend
cd ../frontend
pm2 start npm --name "wordjs-frontend" -- start
```

> Make sure `cd backend && npm run build` has run first, otherwise the backend falls back to slower `ts-node`.

---

## 🧱 Plugin Sandbox & Memory Caps

Plugins marked `"isolated": true` run in a **separate OS process** (`child_process.fork` of `backend/src/core/plugin-worker.js`), each with its **own heap, event loop, and OS memory budget**. They reach core only through the permission-checked `wordjs` bridge (RPC over IPC); the host's secrets, DB handle, and other plugins are unreachable from a child. A crash, OOM, or heap escape is therefore **contained to the child — the host process always survives, on every platform.** (Earlier versions ran plugins in `worker_threads`, which shared the host heap/RSS; that model is gone.)

**Every** plugin runs in this isolated child — there is **no "trusted" tier** and no plugin bypasses the sandbox. Each gets a scoped DB (`wjp_<slug>_` tables only), namespaced routes under `/api/v1/plugin/<slug>`, fs confined to its own directory, and **no outbound network** unless an admin grants the `network` capability (public-IP-only egress when granted). Capabilities are **granted per plugin by an admin** (Android-style, default-deny) in **Admin → Plugins**; a bridge call works only if the capability is both **declared** in the manifest AND **granted**. First-party plugins (`mail-server`, `conference-manager`) are pre-granted only their **declared** capabilities and are **not** privileged. Grants are server-side and **never self-declarable** by a plugin.

### Memory caps (per child, layered)

Each isolated child is held to a **768 MB resident budget** plus a 256 MB JS heap (`--max-old-space-size=256`). How the resident budget is enforced depends on the platform and one opt-in config flag:

| Layer | How | Platform | Default |
|---|---|---|---|
| **Preventive** | cgroup v2 `MemoryMax` via `systemd-run --user --scope` — the kernel OOM-kills only the offending child the instant it exceeds budget | **Linux** (systemd, user scopes) | **OFF** (opt-in) |
| **Reactive** | host-side RSS poll that `SIGKILL`s a child over budget (`/proc` on Linux, `tasklist` on Windows, `ps` on macOS) | **Linux / Windows / macOS** | ON (used when the cgroup cap is not active) |
| **Loose backstop** | kernel `RLIMIT_AS` virtual ceiling (`ulimit -v`) + the 256 MB JS-heap flag | **Linux / macOS** (POSIX; not Windows) | ON |

Because each plugin is a **separate process**, an OOM or crash never takes down the host on *any* platform — even with no cap configured.

### `config.sandbox.useKernelHardening` — opt-in kernel hardening (Linux)

Beyond the memory caps, an **opt-in** layer runs each isolated plugin child through [bubblewrap](https://github.com/containers/bubblewrap) so it executes as an **unprivileged uid (`nobody`) in a rootless user namespace, with all Linux capabilities dropped, `no-new-privs`, PID/IPC/UTS namespaces, and a read-only filesystem** (the app root stays writable so plugin storage — `uploads/`, `data/`, `plugins/<slug>/` — keeps working; network is preserved and still egress-guarded). It is **OFF by default**, **Linux-only** (a no-op on Windows/macOS), and **probe-validated on the host before activating** — if `bwrap` is missing or rootless user namespaces are unavailable it logs a warning and falls back to the standard isolated launch (**zero regression**). It composes with the memory caps above (the resident RSS poll sums the bwrap subtree so the cap keeps biting). Requires the `bubblewrap` package (`sudo apt-get install -y bubblewrap`); validate it on the host with `node backend/scripts/verify-sandbox-hardening.js`.

```json
{ "sandbox": { "useKernelHardening": true } }
```

It also applies a **`seccomp`-bpf syscall denylist** (`ptrace`/`mount`/`kexec`/`*_module`/`bpf`/`keyctl`/`userfaultfd`/`setns`/`process_vm_*`/… → `EPERM`), assembled in pure JS and applied via `bwrap --seccomp`. (The `Landlock` LSM is **not** used — the read-only mount namespace already provides the filesystem confinement it would, and the LSM needs a native dependency.)

> **Trade-off:** dropping capabilities + the unprivileged uid means a plugin **cannot bind a privileged port (`<1024`)** under hardening — e.g. the mail-server on port 25 (its default `2525` is unaffected; for port 25 use a high port + a redirect/reverse-proxy, or leave hardening off for that deployment).

### `config.sandbox.useCgroupMemoryCap` — opt-in preventive cgroup cap (Linux)

The RSS poll is *reactive* (a fast off-heap allocation loop can spike the box within a poll window) and `RLIMIT_AS` can only be a *loose virtual* backstop (V8's ~4 GB pointer-compression cage forces it generous). A cgroup v2 `memory.max` is the only **preventive resident cap**: the kernel kills the child by construction the moment its resident set crosses the budget, with the blast radius contained to that child.

It is **OFF by default** because auto-detecting usable cgroup/systemd support across hosts and CI is unreliable — a host can have `systemd-run` yet no working `--user` bus. Enable it explicitly only on a systemd Linux host where you have confirmed user scopes work:

```json
{
  "sandbox": {
    "useCgroupMemoryCap": true
  }
}
```

(Add the `sandbox` block to `backend/wordjs-config.json`.) No root is required — `systemd-run --user --scope` runs `node` as a **direct child** of `systemd-run`, inheriting the IPC fd. Even when the flag is set, WordJS runs a **probe first** (validates spawn + IPC round-trip + clean teardown on this host) and only activates the cap if the probe passes; any failure falls back cleanly to the fork + `RLIMIT_AS` + RSS-poll path with **zero regression**.

**Sanity-check the host before enabling.** A user manager must be running for your account (enable lingering so it survives logout), and a `--user --scope` unit with a memory cap must actually run:

```bash
# Ensure the per-user systemd manager persists (run once, as the service account)
loginctl enable-linger <user>

# Confirm a memory-capped user scope works (should print: ok)
systemd-run --user --scope -p MemoryMax=64M -- echo ok
```

If that prints `ok`, the cap will activate. On startup with the cap active you will see this in the backend log:

```
[Sandbox] preventive cgroup memory cap ACTIVE (systemd-run --user --scope, MemoryMax=768 MB per child).
```

If the flag is set but the probe fails (e.g. "Failed to connect to bus"), the log instead warns and falls back to the RSS poll:

```
[Sandbox] sandbox.useCgroupMemoryCap is set but the cgroup probe failed (no usable --user scope) — falling back to the RSS poll.
```

> On **Windows** and **macOS** there is no cgroup option. On **Windows** a preventive cap now ships as a **Job Object** (`ProcessMemoryLimit` = 768 MB, default-on, probe-gated, pure-JS via PowerShell P/Invoke; opt out with `sandbox.useJobObjectMemoryCap=false`), with the reactive RSS poll as a backstop. On **macOS** the reactive RSS poll provides the resident cap, and process separation provides crash containment either way.

### `config.sandbox.addressSpaceCapMb` — RLIMIT_AS override (POSIX)

On Linux/macOS the child is also launched under a kernel `RLIMIT_AS` (virtual address-space) ceiling — a coarse backstop that holds even if the host event loop is wedged and is the only cap on `/proc`-less platforms. It defaults to **16384 MB** and is deliberately loose: V8 reserves a ~4 GB pointer-compression cage, and in dev the `ts-node` compiler needs several GB of virtual space, so a tighter ceiling crashes legitimate plugin loads. Override it only on a **compiled (non-`ts-node`) production build with ample RAM headroom**:

```json
{
  "sandbox": {
    "addressSpaceCapMb": 16384
  }
}
```

The value is floored at 6144 MB and validated by a boot probe (using the same `execArgv` the real child uses); if even the floor won't boot on this host, WordJS falls back to a plain fork plus the RSS poll. When the cap is active you'll see:

```
[Sandbox] kernel memory cap active: RLIMIT_AS <N> MB per isolated child.
```

> `RLIMIT_AS` is not available on **Windows** (no POSIX `ulimit`); there WordJS relies on process separation + the `tasklist` RSS poll. The precise resident cap is always the RSS poll or the cgroup cap — not `RLIMIT_AS`.

---

## 🔒 Security Checklist

1.  **Firewall:** Only open port `3000` (Gateway) to the public. Ports `4000` (Backend) and `3001` (Frontend) should stay internal.
2.  **HTTPS:** Use a service like **Cloudflare** or a simple **Nginx Reverse Proxy** on top of the Gateway to handle SSL (Certbot).
3.  **Secrets:** Ensure your `gatewaySecret` and `jwtSecret` in `wordjs-config.json` are cryptographically secure (auto-generated by the installer).
4.  **Install token:** On a fresh, not-yet-installed instance the pre-install endpoints (`POST /setup/install`, `POST /setup/test-db`) are gated by a **one-time install token** printed to the server console (also mirrored to `backend/data/install-token`, `0600`, and overridable via `WORDJS_INSTALL_TOKEN` ≥ 16 chars). Read it from the console to complete the wizard; it is cleared once installed. See **[How an operator deploys a release](#how-an-operator-deploys-a-release)**.
5.  **Metrics:** The Prometheus `/metrics` endpoint is **disabled (returns 404) by default** — it only serves once a scrape token is set via `config.metrics.token` (`wordjs-config.json`) or the `METRICS_TOKEN` env var. Once set, scrape with `Authorization: Bearer <token>` (or `?token=`); a wrong token returns 401. So metrics are never exposed publicly unless you opt in.
6.  **CORS:** No extra config is needed — in production CORS allows the configured origins (`siteUrl`, `frontendUrl`, `gatewayUrl`) **plus any same-origin request** (`Origin` host matching the `Host` header it arrived on), which covers the monolith and a reverse proxy that forwards `Host`; only an explicit `nodeEnv: "development"` additionally reflects `localhost`/`127.0.0.1`/`::1`.
7.  **Private keys 0600:** Auto-generated private keys (`ssl-auto.key`, `gateway-internal.key`, ACME `privkey.pem`) are written owner-only (`0600`) on POSIX (`chmod` is a no-op on Windows), so the self-signed/auto keys are not world-readable.

### Production Checklist

Before going live, confirm:

1. [ ] **Real `gatewaySecret`** — do not ship the public default. If unset, the gateway warns at startup and falls back to a public secret that anyone could use against authenticated endpoints. Rotate this away from any value committed during development, and keep `backend/wordjs-config.json` and `gateway/gateway-config.json` in sync.
2. [ ] **Real `jwtSecret`** — a cryptographically secure value, not a placeholder. JWTs are revocable via `token_valid_after` (logout and password change invalidate older tokens).
3. [ ] **Real `dbPassword`** — rotate any password committed during development.
4. [ ] **Proper mTLS certificates** — the gateway verifies upstream (backend/frontend) certificates against the cluster CA and requires an allowed internal CN. Provide real certs rather than relying on insecure defaults.
5. [ ] **CSP follow-up** — a strict Content-Security-Policy is still disabled in the gateway Helmet config; track this as a hardening item.

> **Status:** WordJS is pre-production and primarily solo-maintained. An **independent security audit is recommended before production**. See `POSITIONING.md` for the sandbox-as-thesis product direction.

---

## 📄 Licensing

WordJS is **MIT-licensed** consistently across every package (root, `backend`, `frontend`, `gateway`, `setup`), with the root `LICENSE` being MIT. Third-party / dual-licensed dependencies are documented in `THIRD-PARTY-NOTICES.md`. CI enforces a **license gate** that fails the build on network-copyleft licenses (`AGPL`, `SSPL`) in production dependencies, so the distribution stays cleanly MIT-compatible.

---

## 🤖 Continuous Integration

CI runs on every push and pull request via `.github/workflows/ci.yml`, on **Node 22**, with three parallel jobs:

- **Backend:** **audit gate** (`npm audit --omit=dev --audit-level=high`, blocks high/critical prod vulns) → strict type check (`npx tsc --noEmit`) → **build** (`npm run build`, compile to `dist/`) → **license gate** (`license-checker --production --failOn 'AGPL;SSPL'`, blocks network-copyleft deps) → unit tests (`npm test`) → **integration tests** (`npm run test:integration`). The integration tests run against real **`postgres:16`** and **`redis:7`** service containers and exercise the multi-node coordination paths — distributed-lock lease CAS against Postgres, Redis pub/sub cache/role coherence — plus the health and `/metrics` endpoints (`backend/src/tests-integration/`). The job ends with a **marketplace catalog freshness** gate: it re-runs `node backend/scripts/build-marketplace.js` (deterministic output) and fails if the committed `marketplace/dist/` differs — run `npm run build:marketplace` and commit the result to fix.
- **Gateway:** audit gate → tests (`npm test`), including the proxy/mTLS integration test.
- **Frontend:** audit gate → plugin-registry regeneration → type check → lint (`npm run lint`) → **unit tests** (`npm run test`, vitest — e.g. the XSS sanitizer) → production build (`npm run build`).

> **Note:** Production runs the **compiled** backend — the `server.js` supervisor launches `node dist/index.js` when `dist/` exists, and only falls back to `ts-node` in development or when no build is present. Run `npm run build` before deploying.

---

## 🔄 Updates

To update the CMS:
```bash
git pull
npm run install:all
cd frontend && npm run build
cd ../backend && npm run build && node scripts/build-plugin.js --all
pm2 restart all
```

---

## 🌐 Domain Migration

When migrating WordJS to a new domain, keep these important considerations in mind:

### SSL Certificates (Self-Signed)

If you are using **self-signed certificates** (`ssl-auto.crt` and `ssl-auto.key`), you **must regenerate** them for the new domain. Self-signed certificates are bound to the domain they were created for, and the browser will reject connections if there's a mismatch.

To regenerate a self-signed certificate:
```bash
# Generate new self-signed certificate for new domain
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout ssl-auto.key \
  -out ssl-auto.crt \
  -subj "/CN=your-new-domain.com"
```

Alternatively, use the **Admin Panel → Security → SSL Certificate Manager** to provision a new Let's Encrypt certificate for the new domain.

### Media URLs (Important!)

WordJS stores media URLs as **relative paths** (e.g., `/uploads/image.jpg`) rather than absolute URLs (e.g., `https://old-domain.com/uploads/image.jpg`). This is by design to ensure:

- ✅ **Seamless migration** — No database updates needed when changing domains
- ✅ **Multi-environment support** — Same database works in dev/staging/production
- ✅ **CDN flexibility** — Easy to add or change CDN prefixes

If you have legacy content with absolute URLs, you may need to run a migration script to convert them to relative paths.

### Migration Checklist

1. [ ] Update `siteUrl` and `frontendUrl` in `wordjs-config.json`
2. [ ] Regenerate SSL certificate if using self-signed
3. [ ] Update DNS records to point to the new server (if applicable)
4. [ ] Verify media URLs are relative (not absolute)
5. [ ] Clear any CDN or browser caches
6. [ ] Test all functionality on the new domain
