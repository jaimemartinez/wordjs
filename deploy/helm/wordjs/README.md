# WordJS Helm chart (monolith only)

A minimal chart for the **monolith**: one pod running `node monolith.js prod` — gateway concerns, the
backend API and the Next.js frontend on a single HTTP port — with persistent volumes for the database
and the media library.

It is deliberately small. Read [Limits](#limits) before you plan a deployment around it.

## Install

No WordJS image is published to a public registry, so build and push the repository's root `Dockerfile`
first. There is no default `image.repository`; the chart refuses to render without one rather than
emit a reference that cannot pull.

```bash
# 1. Build and push the image.
docker build -t <registry>/wordjs:2.0.0 .
docker push <registry>/wordjs:2.0.0

# 2. Install.
helm install wordjs deploy/helm/wordjs \
  --namespace wordjs --create-namespace \
  --set image.repository=<registry>/wordjs \
  --set image.tag=2.0.0 \
  --set siteUrl=https://cms.example.com \
  --set installToken.value="$(openssl rand -hex 24)"

# 3. Finish the wizard. Readiness gates the Service, so port-forward to the pod.
kubectl -n wordjs port-forward deployment/wordjs 3000:3000
# browse http://localhost:3000/install and paste the token
```

Render it without installing anything:

```bash
helm template wordjs deploy/helm/wordjs --set image.repository=example/wordjs
```

## What it creates

| Resource | Notes |
|---|---|
| `Deployment` | 1 replica, `strategy: Recreate`, non-root (uid/gid 1001, `fsGroup: 1001`) |
| `Service` | ClusterIP :80 → container :3000 |
| `PersistentVolumeClaim` ×2 | `-data` (8Gi) and `-uploads` (20Gi), both annotated `helm.sh/resource-policy: keep` |
| `Secret` | only when `installToken.value` is set and no `existingSecret` is given |
| `Ingress` | only when `ingress.enabled=true` |

### Probes

| Probe | Path | Why |
|---|---|---|
| `startupProbe` | `/healthz` | Up to 5 minutes for the first-boot schema migration and plugin isolate startup, so a slow first boot is not killed and restarted forever |
| `livenessProbe` | `/healthz` | Answered by the monolith dispatcher before the backend app, so it means "this process is serving" — an uninstalled site is alive, and restarting it would be wrong |
| `readinessProbe` | `/readyz` | 200 only when installed **and** booted **and** the database answers. The Service therefore carries no traffic until the site can serve it — including while the install wizard is still outstanding, which is why step 3 above uses `port-forward` |

### Storage

Both volumes are `ReadWriteOnce`.

- `-data` → `/app/backend/data`: the SQLite database, the install-token mirror, and `wordjs-config.json`.
  That last one normally lives beside the code at `backend/wordjs-config.json`, where a pod restart
  would lose it; the container entrypoint anchors it into this volume with a symlink so a replaced pod
  comes back **installed** rather than re-offering the wizard on top of a populated database.
- `-uploads` → `/app/backend/uploads`: the media library.

Both PVCs survive `helm uninstall` on purpose — the data volume carries the database and the
`jwtSecret`, and losing it silently would destroy the site. Delete them explicitly when you mean to.

## Limits

This chart models the simplest working WordJS and nothing more.

- **`replicaCount` is pinned to 1**, and rendering fails if you raise it. The pod owns a ReadWriteOnce
  volume and, by default, an embedded SQLite database: single writer, single node. Horizontal scaling
  needs an external database *and* the shared `themes/`, `plugins/`, `backups/`, `public/`, `ssl/`
  mounts described in `documentation/multi-node.md`, plus Redis for the coherence bus. None of that is
  modelled here.
- **`strategy: Recreate`**, so every upgrade has a few seconds of downtime. A rolling update would
  deadlock on the RWO volume.
- **Plain HTTP inside the pod** (`WORDJS_HTTP=1`). Terminate TLS at your ingress. The container never
  generates or renews a certificate.
- **No bundled PostgreSQL or Redis.** Choose PostgreSQL or MySQL in the setup wizard if you have one, or
  point at it with `extraEnv` — but note that env-wiring the database also requires
  `WORDJS_PRESEED_CONFIG=1`, which makes the pod come up **already installed** and skips the wizard
  entirely. No administrator is created in that case (the bootstrap deliberately seeds none), so only
  do it for a replica joining a site that is already installed.
- **No HorizontalPodAutoscaler, PodDisruptionBudget, NetworkPolicy, ServiceMonitor or ServiceAccount**
  customisation. Add them alongside the release if you need them.
- **No backup automation.** Snapshot the `-data` PVC; the database and the `jwtSecret` must be restored
  together or every session is invalidated.

## Values

See [`values.yaml`](values.yaml) — every key is commented there. The ones you will actually set:

| Key | Default | |
|---|---|---|
| `image.repository` | `""` | **Required.** Rendering fails without it |
| `image.tag` | `""` | Falls back to `.Chart.AppVersion` |
| `siteUrl` | `""` | The public origin. Derived from `ingress.host` when unset. Must match the URL that reaches the pod, or admin POSTs fail the CSRF origin check |
| `installToken.value` | `""` | Must be ≥ 16 characters; rendering fails on a shorter one, because the app would silently ignore it and mint its own. Empty means the app mints its own and writes it to `backend/data/install-token` (`0600`) in the data volume — read it with `kubectl exec`, not from the pod logs, where the banner omits it because a pod's stdout is not a TTY (set `WORDJS_PRINT_INSTALL_TOKEN=1` via `extraEnv` to print it there anyway) |
| `installToken.existingSecret` | `""` | Use a Secret you manage; takes precedence over `value` |
| `ingress.enabled` | `false` | |
| `persistence.data.size` | `8Gi` | |
| `persistence.uploads.size` | `20Gi` | |
