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
   no TypeScript compilation on your machine.
2. Extracts it into `my-site/` and installs the runtime dependencies (`npm run release:install`).
3. Generates a one-time install token and starts the server (`npm run start:mono`), printing a
   clickable URL:

   ```
   → https://localhost:3000/install?token=…
   ```

Open the URL, pick your database (SQLite — zero config — or PostgreSQL), create your admin
account, and you're in.

## Requirements

- Node.js **>= 20.9** (Node 20 or 22 LTS recommended) with npm on your PATH.

## Options

| Option | Description |
| --- | --- |
| `--zip <path-or-url>` | Use a local release ZIP (or a direct ZIP URL) instead of querying the GitHub API. Handy offline or when rate-limited. |
| `--version <tag>` | Install a specific release (e.g. `--version v1.0.0`) instead of the latest. |
| `--http` | Serve plain HTTP instead of self-signed HTTPS (sets `WORDJS_HTTP=1`). |
| `--no-start` | Scaffold and install dependencies only — start the server yourself later. |
| `-h`, `--help` | Show usage. |

Separate-mode options:

| Option | Description |
| --- | --- |
| `--host <ip/dns>` | (`gateway`) The address the other machines dial to reach this gateway. |
| `--gateway <ip/dns>` | (`join`) The gateway's address. |
| `--token <join-token>` | (`join`) A single-use token minted on the gateway. |
| `--ca-hash <sha256>` | (`join`) Pin the cluster-CA fingerprint the gateway printed (MITM guard). |
| `--advertise <ip/dns>` | (`join`) This node's routable address the gateway will proxy to. |
| `--enroll-port <port>` | (`join`) Gateway token-enrollment port (default `3101`). |

## Upgrade an existing site

```bash
cd .. && npx create-wordjs@latest upgrade my-site      # or run it from inside: npx create-wordjs@latest upgrade .
```

Downloads the newest release and replaces the app code while **preserving your data**: the SQLite
database, `uploads/`, `wordjs-config.json`, gateway secrets and any user-installed plugins survive.
Restart the server afterwards (schema migrations run automatically on the next start).

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

Each `join` downloads the release, enrolls against the gateway (the token authorizes exactly one
certificate signing; it is burned afterwards), then starts the service, which registers with the
gateway over mTLS. Browse `https://<gateway>:3000` when all three are up. `join` machines need
`openssl` on the PATH. Full details, port matrix and the manual (source-checkout) procedure:
[documentation/separate-mode.md](https://github.com/jaimemartinez/wordjs/blob/main/documentation/separate-mode.md).

## Good to know

- **Self-signed HTTPS**: by default the site serves HTTPS on `:3000` with a locally generated
  self-signed certificate. Your browser will warn once ("Your connection is not private") —
  click *Advanced → Proceed*. That is expected for localhost. Prefer plain HTTP? Use `--http`.
- **Stop / restart**: press `Ctrl+C` to stop. Start again any time with
  `cd my-site && npm run start:mono`. Until setup is finished, every start prints a fresh
  one-time install URL, so you never need to keep the original token around.
- **GitHub rate limit / offline**: the release lookup uses the unauthenticated GitHub API. If it
  is rate-limited or you're offline, download `wordjs-v*.zip` from the
  [releases page](https://github.com/jaimemartinez/wordjs/releases) and run
  `npx create-wordjs@latest my-site --zip ./wordjs-v1.0.0.zip`.
- **Existing directories**: the target directory must not exist (or must be empty) — the tool
  refuses to overwrite anything.

## What gets created

A ready-to-run WordJS bundle: backend (pre-compiled to `dist/`), frontend (pre-built `.next`),
gateway, bundled plugins and themes. Secrets (JWT, DB password, install token) are generated
locally during install — nothing sensitive ships in the bundle. See `INSTALL.md` inside the
scaffolded directory for the manual steps and `documentation/deployment.md` for production
deployment.
