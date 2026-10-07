# create-wordjs

Bootstrap a [WordJS](https://github.com/jaimemartinez/wordjs) site with one command:

```bash
npx create-wordjs@latest my-site
```

> **Always include `@latest`.** `npx` caches downloaded packages, so a bare `npx create-wordjs`
> can silently re-run an **old cached copy**. An old copy won't recognize newer subcommands — e.g.
> `npx create-wordjs upgrade my-site` on a stale cache fails with `✖ Unexpected extra argument:
> my-site`, because that version predates the `upgrade` command. `@latest` always fetches the
> current release. (If it still runs an old copy, clear the cache: `rm -rf ~/.npm/_npx`.)

It also **upgrades** an existing site and sets up **separate mode** (gateway + backend + frontend
on different machines) — see below:

```bash
npx create-wordjs@latest upgrade [dir]              # upgrade an existing install in place
npx create-wordjs@latest gateway --host <ip>        # machine 1: cluster gateway (CA + join tokens)
npx create-wordjs@latest join backend  --gateway <ip> --token <t> --ca-hash <fp> --advertise <ip>
npx create-wordjs@latest join frontend --gateway <ip> --token <t> --ca-hash <fp> --advertise <ip>
```

That single command takes you from nothing to the browser install wizard:

1. Downloads the latest **pre-compiled** WordJS release ZIP from GitHub — no build step,
   no TypeScript compilation on your machine — and verifies its **SHA-256** against the
   `wordjs-<tag>.zip.sha256` asset published with the release before extracting anything
   (see [Integrity](#integrity)).
2. Extracts it into `my-site/` and installs the runtime dependencies (`npm run release:install`).
3. Generates a one-time install token and starts the server (`npm run start:mono`), printing a
   clickable URL:

   ```
   → https://localhost:3000/install#token=…
   ```

Open the URL, pick your database, create your admin account, and you're in. The wizard offers
**SQLite** (zero config, the default), **PostgreSQL** and **MySQL/MariaDB** — all three are certified
in CI — plus a pure-JS *SQLite (legacy / WASM)* fallback for hosts where the native binary can't load.

## Requirements

- Node.js **>= 20.9** (Node 20 or 22 LTS recommended) with npm on your PATH.

## Options

| Option | Description |
| --- | --- |
| `--zip <path-or-url>` | Use a local release ZIP (or a direct **`https://`** ZIP URL — plain `http://` is refused) instead of querying the GitHub API. Handy offline or when rate-limited. |
| `--sha256 <hex>` | Refuse the ZIP unless its SHA-256 is exactly this (the value in the release's `.sha256` asset). Use it to pin a `--zip` file or URL; with a GitHub download it is checked on top of the release checksum. |
| `--version <tag>` | Install a specific release (e.g. `--version v2.1.0`) instead of the latest. |
| `--http` | Serve plain HTTP instead of self-signed HTTPS (sets `WORDJS_HTTP=1`). |
| `--no-start` | Scaffold and install dependencies only — start the server yourself later. |
| `--yes`, `-y` | Skip the confirmation prompt (required when `upgrade` runs non-interactively). |
| `--force` | (`upgrade`) Re-apply even if the site is already on the target version. |
| `--no-install` | (`upgrade`) Swap the code only; skip `npm run release:install`. |
| `--systemd` | (create, `upgrade`; Linux) Also write a systemd unit, `wordjs.service`, to a private staging directory outside the site and print how to install it. The unit runs WordJS as a dedicated non-root account with **no Linux capabilities**. With create it implies `--no-start`. See [Run it as a service](#run-it-as-a-service-linux). |
| `--port <n>` | (with `--systemd`) Public port written into the unit (`PORT=<n>`); default: the site's configured port, else `3000`. Below 1024 it also stages `60-wordjs-ports.conf`. |
| `--service-user <name>` | (with `--systemd`) The account the service runs as (default `wordjs`; `root` is refused). |
| `-h`, `--help` | Show usage. |

Separate-mode options:

| Option | Description |
| --- | --- |
| `--host <ip/dns>` | (`gateway`) The address the other machines dial to reach this gateway. |
| `--gateway <ip/dns>` | (`join`) The gateway's address. |
| `--token <join-token>` | (`join`) A single-use token minted on the gateway. |
| `--ca-hash <sha256>` | (`join`) **Required.** The cluster-CA fingerprint the gateway printed. The gateway's TLS certificate must chain to exactly that CA before the join token is sent (MITM guard). |
| `--advertise <ip/dns>` | (`join`) This node's routable address the gateway will proxy to. |
| `--enroll-port <port>` | (`join`) Gateway token-enrollment port (default `3101`). |

## Upgrade an existing site

```bash
cd .. && npx create-wordjs@latest upgrade my-site      # or run it from inside: npx create-wordjs@latest upgrade .
```

Downloads the newest release and replaces the app code while **preserving your data**: the database
directory (`backend/data`), `backend/uploads/`, `wordjs-config.json`, `.env`, gateway secrets
(`gateway/gateway-config.json`) and any user-installed plugins survive. It asks for confirmation
before touching an existing install — on a non-interactive shell it refuses unless you pass `--yes`.
Restart the server afterwards (schema migrations run automatically on the next start).

## Run it as a service (Linux)

```bash
npx create-wordjs@latest /srv/wordjs --systemd --port 443          # new site
npx create-wordjs@latest upgrade /srv/wordjs --systemd              # existing site, even if already up to date
```

`--systemd` writes `wordjs.service` — `User=wordjs`, `NoNewPrivileges=yes`, an **empty**
`CapabilityBoundingSet=`, `ProtectSystem=strict` with the site directory as the only writable path,
`PrivateTmp=yes`, `ProtectHome=yes`, `Restart=on-failure`, `ExecStart` pointing at the node that ran the
command — to a fresh private staging directory (mode `0700`, **outside** the site, which the service
account will own: a file root installs into `/etc` must not be one the service can rewrite first), and
prints the steps to install it (create the account, `chown` the site to it, `install -o root -g root -m
0644` the unit into `/etc/systemd/system/`, `systemctl enable --now wordjs`, read
`backend/data/install-token`; on `upgrade`, `enable` plus `restart`, after stopping whatever served the
site before). It does not run anything as root itself, refuses to run as the service account, checks the
site and node paths before downloading anything, and with create it does not start the server: the first
boot must run as the service account so that account owns the database and certificates it creates.

**Ports below 1024 (80/443).** The unit never grants `CAP_NET_BIND_SERVICE`. For a port below 1024,
`--systemd` also stages `60-wordjs-ports.conf`, a `sysctl.d` drop-in that sets
`net.ipv4.ip_unprivileged_port_start` to that port. Read its trade-off before installing it: it lets
**every** unprivileged process on the host bind ports from that value up to 1023, not just WordJS. On a
shared host, prefer a reverse proxy (nginx, Caddy) on 80/443 forwarding to WordJS on a high port.

**Do not `setcap` node or add `AmbientCapabilities=`.** Earlier versions of this tool printed a `setcap`
command for port 25; it is withdrawn. An ambient capability is inherited by the plugin sandbox, which has to
strip it (a non-root service with `AmbientCapabilities=CAP_NET_BIND_SERVICE` once left every plugin
refused); a file capability on node applies to every node script on the machine, runs node in
secure-execution mode, and disappears silently on the next node upgrade. Details, measurements and how to
remove an existing grant: [documentation/deployment.md](https://github.com/jaimemartinez/wordjs/blob/main/documentation/deployment.md#-running-as-a-service-systemd-non-root).

## Separate mode (multi-machine)

Run the gateway, backend and frontend on **different machines**, joined into one mTLS cluster with
single-use join tokens (kubeadm/swarm style — no certificate is ever hand-copied). One command per
machine:

```bash
# Machine 1 — the gateway (mints the cluster CA and one token per role):
npx create-wordjs@latest gateway --host 10.0.0.1
```

It downloads the release, initializes the cluster CA, starts the gateway, and prints the exact
**ready-to-paste** `join` commands for the other machines — token and CA fingerprint included:

```bash
# Machine 2 — backend (paste what the gateway printed):
npx create-wordjs@latest join backend  --gateway 10.0.0.1 --token <t> --ca-hash <fp> --advertise 10.0.0.2

# Machine 3 — frontend:
npx create-wordjs@latest join frontend --gateway 10.0.0.1 --token <t> --ca-hash <fp> --advertise 10.0.0.3
```

`--ca-hash` is required: `join` refuses to enroll without it, and there is no trust-on-first-use
opt-out. Each `join` downloads the release, enrolls against the gateway (the token authorizes exactly one
certificate signing; it is burned afterwards, and the ones `gateway` printed also expire after 120
minutes — mint more on the gateway with `node scripts/cluster.js token <backend|frontend>`, which
defaults to a 60-minute TTL and takes `--ttl <minutes>`), then starts the service, which registers
with the gateway over mTLS. Browse `https://<gateway>:3000` when all three are up. `join` machines
need `openssl` on the PATH. Full details, port matrix and the manual (source-checkout) procedure:
[documentation/separate-mode.md](https://github.com/jaimemartinez/wordjs/blob/main/documentation/separate-mode.md).

## Good to know

- **Self-signed HTTPS**: by default the site serves HTTPS on `:3000` with a locally generated
  self-signed certificate. Your browser will warn once ("Your connection is not private") —
  click *Advanced → Proceed*. That is expected for localhost. Prefer plain HTTP? Use `--http`.
- **Stop / restart**: press `Ctrl+C` to stop. Start again any time with
  `cd my-site && npm run start:mono`. Until setup is finished, every start mints a fresh one-time
  install token, so you never need to keep the original around. The server prints it in its boot
  banner — as a clickable `/install#token=…` URL — only when its stdout is a terminal, which it is
  when you run that command yourself; off a TTY (systemd, Docker, a pipe) the banner shows the URL
  without the token. Either way the token is written to `my-site/backend/data/install-token`
  (mode `0600`), and `WORDJS_PRINT_INSTALL_TOKEN=1` prints it in the banner regardless.
- **GitHub rate limit / offline**: the release lookup uses the unauthenticated GitHub API. If it
  is rate-limited or you're offline, download `wordjs-v*.zip` from the
  [releases page](https://github.com/jaimemartinez/wordjs/releases) and run
  `npx create-wordjs@latest my-site --zip ./wordjs-v2.1.0.zip` — add
  `--sha256 <hex>` with the value from `wordjs-v2.1.0.zip.sha256` to have it verified.
- **Existing directories**: the target directory must not exist (or must be empty) — the tool
  refuses to overwrite anything.

## Integrity

- **GitHub downloads are verified.** Every release publishes `wordjs-<tag>.zip.sha256`
  (`sha256sum` format) next to the bundle. `create-wordjs` — including `upgrade`, `gateway` and
  `join` — downloads it and refuses to extract a ZIP whose SHA-256 differs. Releases published
  **before** the checksum asset was introduced have nothing to verify against: they still install
  (so `--version <old-tag>` rollbacks keep working) but with a clear warning that the download was
  not verified. The checksum is fetched from the same GitHub release over HTTPS, so it catches a
  corrupted or swapped download, not a compromised release.
- **`--zip` sources**: a URL must be `https://` (plain `http://` and other schemes are refused); a
  local path is accepted as is. Neither is verified unless you pass `--sha256 <hex>` (a URL
  without it prints a warning).
- **Extraction is contained**: every ZIP entry is checked before anything is written. An archive
  with an absolute path, a `..` segment, an entry resolving outside the target directory, or a
  symbolic-link entry is refused as a whole.

## What gets created

A ready-to-run WordJS bundle: backend (pre-compiled to `dist/`), frontend (pre-built `.next`),
gateway, the bundled plugins and the four bundled themes (`circuito`, `default`, `gaceta`,
`vergel`). Marketplace plugins are **not** in the bundle — they ship as separate release assets and
are installed from the admin. Secrets (JWT, DB password, install token) are generated
locally during install — nothing sensitive ships in the bundle. See `INSTALL.md` inside the
scaffolded directory for the manual steps and `documentation/deployment.md` for production
deployment.
