# WordJS — one-click Docker deploy

One container, one port, an embedded SQLite database, and two volumes. This is the shortest path from
nothing to a running, installable WordJS.

## Zero to the wizard, in three commands

```bash
cd deploy/compose

# 1. Mint the one-time install token (>= 16 chars, or the app ignores it and generates its own).
printf 'WORDJS_INSTALL_TOKEN=%s\n' "$(openssl rand -hex 24)" > .env

# 2. Build the image and start the site (first build compiles the whole app — expect several minutes).
docker compose up -d --build

# 3. Open the wizard and paste the token from .env.
#    http://localhost:3000/install
```

Pick a database (SQLite is the default and needs nothing), create the administrator, and you are done.

Step 1 is the **recommended path** precisely because it means you never have to go looking for the
token: you minted it, it is in `.env`, you paste it.

Watch the boot with `docker compose logs -f wordjs`. If you skipped the `.env` step, the token is **not**
in those logs. The boot banner prints the token only when stdout is a TTY, and a detached container's
stdout is a log stream that gets shipped and indexed — so the banner shows `http://localhost:3000/install`
with **no** `#token=…` fragment and names the file to read instead. Read it from the `wordjs-data` volume:

```bash
docker compose exec wordjs cat /app/backend/data/install-token
```

That file is mode `0600` and is removed once the site is installed. Two alternatives: set
`WORDJS_PRINT_INSTALL_TOKEN=1` in the environment to have the banner print the token — with a
ready-to-click `http://localhost:3000/install#token=…` URL — in the logs anyway, or pre-set
`WORDJS_INSTALL_TOKEN` in `.env`, which is what step 1 does. When the token *is* printed as a URL it
rides in the URL **fragment**, which a browser never sends to a server, so it stays out of access and
proxy logs.

## What you get

| | |
|---|---|
| **Mode** | Monolith — one process serving gateway concerns, the backend API and the Next.js frontend on a single HTTP port (`node monolith.js prod`) |
| **Database** | SQLite inside the `wordjs-data` volume (choose PostgreSQL or MySQL in the wizard instead if you have one) |
| **TLS** | **None.** The container serves plain HTTP (`WORDJS_HTTP=1`). Put a reverse proxy in front for anything public — see below |
| **User** | Non-root (`wordjs`, uid 1001), `tini` as PID 1 for clean shutdown |
| **Health** | `GET /healthz` (liveness). `GET /readyz` additionally requires installed + booted + database answering |

## Configuration

Both variables live in `.env`:

| Variable | Default | Notes |
|---|---|---|
| `WORDJS_INSTALL_TOKEN` | *(empty)* | Must be **≥ 16 characters** or it is ignored with a warning and a random token is minted. Setting it here (step 1) is the recommended path. Empty is fine — the app mints one and writes it to `backend/data/install-token` (`0600`) in the `wordjs-data` volume; read it with `docker compose exec wordjs cat /app/backend/data/install-token`, **not** from the logs, where it appears only under `WORDJS_PRINT_INSTALL_TOKEN=1` (or on a TTY) |
| `WORDJS_SITE_URL` | `http://localhost:3000` | **A suggestion for the install wizard, not the site's address.** The wizard prefills its *Site address* field with the address you are browsing and, when this value is not a loopback address, offers it as "the server's suggested address". It never overrides an installed main address. It is written into the config only under `WORDJS_PRESEED_CONFIG=1`, which this stack does not set, and it also labels the entrypoint's "finish setup at …" log line |

Serving on a real domain? **Set the wizard's *Site address* to that domain** (`https://example.com`):
the main address is the base of every link and email the site sends. Set `WORDJS_SITE_URL` to it as well
and the wizard offers it with one click, even when you run the wizard through `http://localhost:3000`.
The site then answers that domain, any other address you add later (Settings → Site address, or
`docker compose exec wordjs npm run site -- add https://www.example.com`), `localhost` and, by default,
IP addresses; any other name gets `421`.

Terminate TLS in your proxy and **forward the browser's `Host`** (nginx: `proxy_set_header Host $host`).
A proxy that sends its upstream name instead (`wordjs:3000`, nginx's default `$proxy_host`) gets `421`,
and the log says the proxy is not forwarding `Host`. To let addresses other than the main one sign in
over https, also add `WORDJS_TRUST_PROXY` under the service's `environment:` in `docker-compose.yml`,
set to the proxy's address or network (e.g. `172.16.0.0/12` for a proxy container on a compose
network); otherwise the app sees plain http inside the container and only the main address can sign in. See [`documentation/site-address.md`](../../documentation/site-address.md).

## Data and backups

| Volume | Holds |
|---|---|
| `wordjs-data` → `/app/backend/data` | The SQLite database, the install-token mirror, and `wordjs-config.json` |
| `wordjs-uploads` → `/app/backend/uploads` | The media library |

`wordjs-config.json` normally lives at `backend/wordjs-config.json`, next to code, where a container
recreate would lose it. The entrypoint therefore anchors it into the data volume with a symlink, so
**install state persists**: `docker compose down && docker compose up -d` comes back as an installed
site rather than re-offering the wizard on top of a populated database. Back up both volumes together —
the config carries the `jwtSecret`, and restoring a database without it invalidates every session.

```bash
docker compose down                 # stop, keep the data
docker compose down -v              # stop and DELETE both volumes — the site is gone
```

This stack uses the compose project name `wordjs-site`, deliberately different from the root demo's
`wordjs`: compose keys containers and volumes by project name, so a shared name would make `up` here
tear the other stack down as a stale definition of the same project.

## Not this template's job

- **No TLS, no reverse proxy.** Deliberate: certificate management belongs to your ingress.
- **Single node.** No Postgres, no Redis, no second replica, so nothing here exercises cross-node
  coherence. The compose file at the repository root does exactly that — and, because it must come up
  pre-installed for a second replica to join, it is not a stack you can log into. The two files answer
  different questions on purpose.
- **No horizontal scaling.** SQLite plus a local volume is single-writer. Scaling out means an external
  database and the shared mounts described in `documentation/multi-node.md`.
- **Kubernetes** is next door in [`../helm/wordjs`](../helm/wordjs).
