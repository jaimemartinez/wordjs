# create-wordjs

Bootstrap a [WordJS](https://github.com/jaimemartinez/wordjs) site with one command:

```bash
npx create-wordjs my-site
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
  `npx create-wordjs my-site --zip ./wordjs-v1.0.0.zip`.
- **Existing directories**: the target directory must not exist (or must be empty) — the tool
  refuses to overwrite anything.

## What gets created

A ready-to-run WordJS bundle: backend (pre-compiled to `dist/`), frontend (pre-built `.next`),
gateway, bundled plugins and themes. Secrets (JWT, DB password, install token) are generated
locally during install — nothing sensitive ships in the bundle. See `INSTALL.md` inside the
scaffolded directory for the manual steps and `documentation/deployment.md` for production
deployment.
