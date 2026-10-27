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
docker build -t <registry>/wordjs:2.11.17 .
docker push <registry>/wordjs:2.11.17

# 2. Install.
helm install wordjs deploy/helm/wordjs \
  --namespace wordjs --create-namespace \
  --set image.repository=<registry>/wordjs \
  --set image.tag=2.11.17 \
  --set siteUrl=https://cms.example.com \
  --set installToken.value="$(openssl rand -hex 24)"

# 3. Finish the wizard. Readiness gates the Service, so port-forward to the pod.
kubectl -n wordjs port-forward deployment/wordjs 3000:3000
# browse http://localhost:3000/install, paste the token, and set "Site address" to
# https://cms.example.com (the wizard offers it as the server's suggested address)
```

**The site address.** The wizard's *Site address* field is prefilled with the address you opened it on
(`http://localhost:3000` through the port-forward); `siteUrl` reaches it only as a suggestion
(`WORDJS_SITE_URL`). Pick the public one: the main address is the base of every link and email the site
sends. Whatever you pick, the chart exports every address it routes to the pod — `siteUrl`, `ingress.host`,
`ingress.extraHosts` (`https://` when an ingress TLS entry covers the host) and `allowedHosts` — in
`WORDJS_ALLOWED_HOSTS`, so the site answers them; any other name gets `421`. `localhost` is always
answered, so the port-forward keeps working. Change the main address later in Settings → Site address
or with `kubectl exec deployment/wordjs -- npm run site -- canonical <url>`. Behind the TLS-terminating
ingress, set `trustProxy` to the ingress controller's pod network: without it the app does not believe
the ingress's forwarded headers, so rate limits key on the controller's address and, on an https site,
only the main address can sign in. See
[`documentation/site-address.md`](../../../documentation/site-address.md).

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

## Upgrading

On Kubernetes, update WordJS by changing the image tag: what is written to a container's own filesystem
does not outlive the pod. **Admin → Updates** recognises the pod and gives this instruction instead of an
update button. Build and push the new
release's image, then point the release at it:

```bash
docker build -t <registry>/wordjs:2.11.17 . && docker push <registry>/wordjs:2.11.17
helm upgrade wordjs deploy/helm/wordjs --namespace wordjs --reuse-values --set image.tag=2.11.17
```

The two volumes are kept, and database schema migrations run when the new pod starts. Take a backup
first (Settings → Backups). Settings the panel applies by restarting (the database engine, Redis,
trusted proxies, the log level) do not need the pod to be recreated: the image runs `monolith.js`, whose
supervisor starts the app again in the same container.

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
  entirely. Nobody chooses the administrator in that case: on its first boot over an **empty** database
  the backend creates a bootstrap `admin` (email `admin@example.com`) with a random password, written
  (mode `0600`) to `backend/data/initial-admin-password` in the data volume and printed only to a
  terminal. Read it with `kubectl -n wordjs exec deployment/wordjs -- cat
  /app/backend/data/initial-admin-password`, sign in, change the password and delete the file.
  Pre-seeding also requires `WORDJS_JWT_SECRET`; see [`docker/README.md`](../../../docker/README.md).
- **No HorizontalPodAutoscaler, PodDisruptionBudget, NetworkPolicy, ServiceMonitor or ServiceAccount**
  customisation. Add them alongside the release if you need them.
- **No backup automation.** Snapshot the `-data` PVC; the database and the `jwtSecret` must be restored
  together or every session is invalidated.

## Values

See [`values.yaml`](values.yaml) — every key is commented there.

| Key | Default | |
|---|---|---|
| `image.repository` | `""` | **Required.** Rendering fails without it |
| `image.tag` | `""` | Falls back to `.Chart.AppVersion` |
| `image.pullPolicy` / `imagePullSecrets` | `IfNotPresent` / `[]` | |
| `siteUrl` | `""` | The public origin. Derived from `ingress.host` when unset and `ingress.enabled=true`. Exported as `WORDJS_SITE_URL` (the wizard's suggested main address) and in `WORDJS_ALLOWED_HOSTS` (always answered) |
| `allowedHosts` | `[]` | More addresses the site must answer (host names or URLs), exported in `WORDJS_ALLOWED_HOSTS` |
| `trustProxy` | `""` | Exported as `WORDJS_TRUST_PROXY`: the ingress controller's address or pod network (an IP, a CIDR, `uniquelocal`, …). Needed for client-IP rate limits and for https sign-in on addresses other than the main one |
| `ingress.extraHosts` | `[]` | More host names routed to the Service; each gets an ingress rule and is exported in `WORDJS_ALLOWED_HOSTS` |
| `installToken.value` | `""` | Must be ≥ 16 characters; rendering fails on a shorter one, because the app would silently ignore it and mint its own. Empty means the app mints its own and writes it to `backend/data/install-token` (`0600`) in the data volume — read it with `kubectl exec`, not from the pod logs, where the banner omits it because a pod's stdout is not a TTY (set `WORDJS_PRINT_INSTALL_TOKEN=1` via `extraEnv` to print it there anyway) |
| `installToken.existingSecret` | `""` | Use a Secret you manage; takes precedence over `value` |
| `installToken.existingSecretKey` | `install-token` | The key inside that Secret |
| `service.type` / `service.port` | `ClusterIP` / `80` | The Service in front of container port `3000` |
| `ingress.enabled` | `false` | |
| `ingress.className` | `""` | The Ingress's `ingressClassName`; empty leaves it unset (the cluster default) |
| `ingress.host` / `ingress.path` / `ingress.pathType` | `wordjs.example.com` / `/` / `Prefix` | |
| `ingress.annotations` | `{}` | |
| `ingress.tls` | `[]` | `secretName` + `hosts` entries; a host covered here is exported as `https://` in `WORDJS_ALLOWED_HOSTS` |
| `persistence.data.size` | `8Gi` | |
| `persistence.uploads.size` | `20Gi` | |
| `persistence.<data\|uploads>.enabled` | `true` | `false` mounts an `emptyDir` instead, lost whenever the pod is replaced |
| `persistence.<data\|uploads>.storageClass` | `""` | Empty uses the cluster default StorageClass |
| `persistence.<data\|uploads>.accessMode` | `ReadWriteOnce` | |
| `persistence.<data\|uploads>.existingClaim` | `""` | Mount a PVC you created instead of letting the chart create one |
| `resources` | requests `250m` CPU / `512Mi`, limit `2Gi` memory | The Node process plus one forked OS child per isolated plugin; below ~1Gi the first boot is an OOM risk |
| `podSecurityContext` | `runAsNonRoot`, uid/gid `1001`, `fsGroup: 1001` | `fsGroup` is what makes a fresh, root-owned volume writable for the app |
| `securityContext` | `allowPrivilegeEscalation: false`, drop `ALL` capabilities | |
| `extraEnv` | `[]` | More container environment variables, rendered as given (so `valueFrom` works) — see below |
| `podAnnotations` / `nodeSelector` / `tolerations` / `affinity` | empty | |

### Useful `extraEnv` entries

```yaml
extraEnv:
  - name: METRICS_TOKEN          # turns on GET /metrics (Authorization: Bearer <token>); it answers 404 without one
    valueFrom:
      secretKeyRef: { name: wordjs-metrics, key: token }
  - name: LOG_LEVEL              # trace | debug | info | warn | error | fatal | silent (default info)
    value: info
```

**Database TLS** (with `WORDJS_PRESEED_CONFIG=1` and an external database): `WORDJS_DB_SSL=true` connects
over TLS and **verifies** the server certificate. For a private or managed-database CA, mount its PEM from
a Secret and set `WORDJS_DB_SSL_CA` to that path. `WORDJS_DB_SSL_REJECT_UNAUTHORIZED=false` skips
verification (encrypted but unauthenticated, logged as a warning); prefer the CA. The setup wizard offers
the same two settings when you pick PostgreSQL or MySQL there. See
[`documentation/database.md`](../../../documentation/database.md).

**Media offload.** With the `WORDJS_MEDIA_*` variables (`WORDJS_MEDIA_STORAGE=s3`, `WORDJS_MEDIA_S3_BUCKET`,
`WORDJS_MEDIA_S3_REGION`, `WORDJS_MEDIA_S3_ENDPOINT`, `WORDJS_MEDIA_S3_ACCESS_KEY_ID`,
`WORDJS_MEDIA_S3_SECRET_ACCESS_KEY`, `WORDJS_MEDIA_PUBLIC_URL`, …) public media is written to an
S3-compatible bucket and served from its public URL or a CDN, so the `-uploads` volume is no longer where
public media has to live: once the library is offloaded (`kubectl -n wordjs exec deployment/wordjs -- npm
run media -- offload --delete-local`) it can be much smaller. It is not empty: fonts are still stored under
`backend/uploads/`, so keep it persistent rather than an `emptyDir`. Private media is never offloaded and
stays in the data volume (`backend/data/private-uploads/`). Keep the keys in a Secret (`valueFrom`). See
[`documentation/media-storage.md`](../../../documentation/media-storage.md).
