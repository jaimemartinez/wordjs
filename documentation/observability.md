# Observability

How to see what a WordJS backend is doing: structured logs, request correlation, and Prometheus
metrics. Everything here is on by default except the metrics endpoint, which stays disabled until you
give it a scrape token.

- **Logs** — JSON on stdout, one object per line, with levels and a correlation id.
- **Request ids** — `X-Request-Id` on every response; an incoming one is honoured only when a proxy is
  trusted **and** the value is sane.
- **Metrics** — `GET /metrics`, token-gated, Prometheus text format.

> **Bootstrap secrets are not printed to a non-terminal.** Because everything below is about shipping
> stdout to a log store, the one-time install token and the generated administrator password are
> printed in the boot banner **only when stdout is a TTY** — otherwise the banner names the `0600` file
> to read them from. Set `WORDJS_PRINT_INSTALL_TOKEN=1` to print them anyway.

Key files: `backend/src/core/logger.ts`, `backend/src/middleware/request-context.ts`,
`backend/src/core/metrics.ts`, `backend/src/core/install-token.ts`. The behaviour below is pinned by
`backend/src/tests-integration/health.integration.test.ts`, and the banner rule by
`backend/src/tests/install-state.test.ts`.

---

## Logging

### Format

Every line is a JSON object on **stdout**. Nothing is written to a log file: the process logs to
stdout and the supervisor (systemd, Docker, Kubernetes, PM2) owns rotation and shipping.

```json
{"level":"info","time":"2026-09-05T00:27:38.261Z","service":"wordjs-backend","pid":424,
 "requestId":"7f1c...","method":"GET","path":"/api/v1/posts","status":200,"durationMs":12,
 "ip":"203.0.113.7","userId":4,"msg":"request"}
```

| Field | Always present | Meaning |
| --- | --- | --- |
| `level` | yes | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`, as a **name**, not a number |
| `time` | yes | ISO-8601 UTC |
| `service` | yes | `wordjs-backend` |
| `pid` | yes | process id — the discriminator between replicas on one host |
| `msg` | yes | the message |
| `requestId` | inside a request | correlation id, see below |
| `legacy` | on bridged lines | `true` when the line came from a not-yet-migrated `console.*` call |

### Levels

Resolved once, at boot, in this order:

1. the `LOG_LEVEL` environment variable;
2. `logging.level` in `wordjs-config.json`;
3. `info`.

An unrecognised value is **ignored**, not passed through: a typo in an environment variable must not
be able to stop the process from starting, and it falls through to the next source rather than
resetting the level to `info`.

`config.logging.level` — the field the rest of the process reads back — resolves with the **same**
order. It used to let the file win over the environment, so with `logging.level: "warn"` in the file
and `LOG_LEVEL=debug` in the environment the logger ran at `debug` while that field reported `warn`.

```jsonc
// wordjs-config.json
{
  "logging": {
    "level": "info",      // trace | debug | info | warn | error | fatal | silent
    "accessLog": true     // false silences the per-request access line only
  }
}
```

```bash
LOG_LEVEL=debug node dist/index.js
```

### Development pretty-printing

If `NODE_ENV=development` **and** `pino-pretty` resolves, output is colourised and human-readable
instead of JSON. `pino-pretty` is not a declared dependency — install it yourself when you want it:

```bash
cd backend && npm install --save-dev pino-pretty
```

It is loaded **in-process as a stream**, never through pino's `transport` option: a transport spawns a
worker thread, and this process installs an IO guard, a secure-require hook and the plugin sandbox at
boot. Production never depends on the package being present.

### Redaction

**Redaction applies to structured FIELDS. It does not, and cannot, apply to a message.** pino's
`redact` rewrites property values before the line is serialized; `msg` is not one of them. That
distinction is the whole reason the console bridge below has a second, separate mechanism — read both
halves before concluding that a credential is safe.

#### Fields

These paths have their **value** replaced with `[redacted]`, so an object logged whole cannot leak a
credential through a caller who forgot to strip it. Paths are exact **property names**, not
substrings — which is why every compound name the codebase actually uses is listed:

```
headers (both under `req.headers.*` and bare `headers.*`)
  authorization    cookie    x-csrf-token    x-install-token

credential property names, at the root, `*.name` and `*.*.name`
  password       token          secret        jwtSecret      dbPassword
  accessToken    refreshToken   apiKey        privateKey     password_hash
  secret_enc     totpSecret
```

The `*.name` forms match one level below the root of the logged object, which is where a serialized
row, request body or config slice puts them; `*.*.name` covers one level deeper
(`{ user: { credentials: { password } } }`); the bare names cover the same field logged at the top
level. `jwtSecret` and `dbPassword` are on the list because they sit at the **root** of the object
`config/app.ts` exports, so `logger.info({ config })` used to print both in the clear while a list
containing `secret` and `password` looked complete.

#### Messages

Free text gets a much smaller, textual scrub, applied to every bridged `console.*` line. The value
after a credential-ish key becomes `[redacted]`, whether it is bare (`token=abc`, `#token=`,
`password=`, `secret:`, `api_key=`, `x-install-token: `, `wordjs_token=`, `wjs_csrf=`) or **quoted**
(`password: 'abc'`, `"token":"abc"`, `jwtSecret: "abc"`) — the quoted form is what `util.inspect` and
`JSON.stringify` produce, so it is what the bridge itself makes out of `console.log('body', req.body)`.
The quotes are kept and only the value is replaced, so the line stays parseable. The key list is
generated from the same `CREDENTIAL_KEYS` the field paths above come from, plus the spellings that
only appear as text (`passwd`, `csrf`, `api_key`/`api-key`, `authorization`), so a name added for one
is covered by both.

Three more shapes: an `Authorization:`/`Proxy-Authorization:` header with **any** scheme — `Bearer`,
`Basic`, `Digest`, `Negotiate`, `AWS4-HMAC-SHA256`, or none at all — of which only a recognised scheme
NAME is kept and everything after it is masked; a bare `Bearer …`; and WordJS's own `wjt_…` token
prefix. A quoted `Cookie:`/`Set-Cookie:` value is masked whole, because a session cookie's name is not
required to look like a credential; an unquoted jar is masked cookie by cookie, so
`Cookie: wjs_csrf=…; wordjs_token=…` stays readable.

Treat that as a backstop, not a control. It only knows the shapes listed above, so **the rule is still
"do not log the secret"** — which is why the boot banners gate the value itself (see the note at the
top of this page). It also cuts both ways: a quoted value after a credential word is masked even when
it is a diagnostic rather than a secret (`token: "unexpected end of input"` becomes
`token: "[redacted]"`), and a multi-parameter header value (`Digest username="u", response=…`) has its
first parameter masked, not the whole list.

### The console bridge, and the migration plan

The backend has ~800 `console.*` calls across ~100 files. Rewriting them is a separate change, so
until then `consoleBridge()` — installed from `index.ts` immediately after the config loads — replaces
`console.log/info/warn/error/debug` with functions that emit through the logger:

- `console.log` and `console.info` → `info`, `console.warn` → `warn`, `console.error` → `error`,
  `console.debug` → `debug`.
- The message is built with `util.format`, exactly as `console` does, so `%s`/`%d` formatting and
  object inspection are unchanged. **Emoji prefixes are preserved** — they are the message, and the
  greps operators already have keep working.
- The message is then run through the textual scrub described under **Redaction → Messages**. The
  bridge collapses its arguments into `msg`, and `redact` never touches `msg`, so for these lines the
  structured redaction above is not weak — it is inapplicable.
- Each bridged line carries `legacy: true`, so `count_over_time({legacy="true"})` measures how much of
  the migration is left.
- Inside a request the bridged line goes through the request-bound logger, so it carries `requestId`
  like everything else — without touching the call site.
- `console.table`, `console.dir` and `console.trace` are left alone; they are developer-console
  shapes, not log records.

The bridge is **not** installed under the test runner (`NODE_TEST_CONTEXT` set, or `NODE_ENV=test`):
the suites read `node:test`'s own output off the same stream, and JSON-ifying it would make a failing
assertion unreadable. Under the same condition the logger's **destination** is silenced too — gating
only the bridge left the access-log middleware writing a JSON object to fd 1 for every request a
supertest case made, which is the same readability problem arriving by the other door. Tests that
assert on emitted lines read the in-process sink, not stdout, so they are unaffected.

**Migration plan.** The follow-up change replaces call sites module by module with
`logger.child({ module: '<name>' })` (or `getRequestLogger()` inside a request), moving the variable
parts of the message into fields. `legacy: true` disappears from a module's lines as it is converted,
which is the completion signal. The bridge stays until the count reaches zero, then is removed.

### Logging from your own code

```ts
const { logger, getRequestLogger } = require('./core/logger');

const log = logger.child({ module: 'wxr-import' });   // module-scoped, outside a request
log.info({ posts: 412 }, 'import finished');

getRequestLogger().warn({ slug }, 'theme has no template for this post type'); // inside a request
```

`getRequestLogger()` returns the request-bound child when called anywhere inside a request — including
from a core module far from the route handler, which is exactly the code that cannot be handed a
logger through its arguments — and the root logger otherwise.

---

## Request ids

`middleware/request-context.ts` is the **first middleware on the app**, ahead of helmet, CORS, the
cookie parser and every rate limiter. That is deliberate: the id it mints is what every later line is
correlated by, so mounting it any later would leave exactly the early lines — a helmet rejection, a
CORS denial, a 429 — with no id.

For each request it:

1. reads an incoming `X-Request-Id` and **honours it only when a proxy is trusted and it matches
   `^[A-Za-z0-9._-]{8,128}$`**, otherwise mints a UUID v4;
2. sets `X-Request-Id` on the response;
3. opens an `AsyncLocalStorage` holding `{ requestId, startedAt }` for the whole request;
4. on `finish` **or** `close`, emits one access line.

Two independent questions, and both have to be answered:

- **The bytes.** The grammar is narrow on purpose. `X-Request-Id` is client-controlled; echoing it
  unvalidated puts arbitrary bytes into a JSON field and a response header, which is log injection
  with extra steps. A UUID, a ULID, a W3C trace id and nginx's `$request_id` all satisfy it.
- **The provenance.** A well-formed id from a *direct* client is still an id the *client* chose. On an
  instance with nothing trusted in front of it, honouring the header lets anyone stamp a whole campaign
  with one id so it collapses into a single "trace", splice lines into an incident you are following,
  or adopt an id a real session is emitting so the attack is attributed to that user — and the response
  header echoes the value back, confirming the graft landed. So the header is honoured only when
  `trust proxy` is configured, the same decision `core/client-ip` uses to decide whether
  `X-Forwarded-For` may be believed.

### Propagating from a reverse proxy

**`trust proxy` must be set, or the header is ignored.** Set `trustProxy` in `wordjs-config.json` (or
`WORDJS_TRUST_PROXY`) to a hop count, a subnet list or `true` that describes your edge — see
[deployment.md](deployment.md). Behind the WordJS gateway (split/separate mode) one hop is trusted by
default; a direct monolith trusts nothing, and mints its own id.

**nginx** — generate an id at the edge, pass it upstream, and log it on the edge too so the proxy's
access log and the app's logs join on one key:

```nginx
proxy_set_header X-Request-Id $request_id;
log_format wordjs '$remote_addr $request_id "$request" $status $request_time';
access_log /var/log/nginx/access.log wordjs;
```

**Traefik** — `X-Request-Id` is forwarded as-is; add a plugin or an upstream generator if you want one
minted at the edge.

**Kubernetes ingress-nginx** — set `generate-request-id: "true"` (the default) in the controller
ConfigMap.

If nothing upstream sets the header, the backend mints the id itself; correlation still works, it just
starts at the app instead of the edge.

### The access line

One line per request, `msg: "request"`:

| Field | Value |
| --- | --- |
| `requestId` | the correlation id |
| `method` | HTTP method |
| `path` | request path **without the query string** (the query is unbounded and routinely carries tokens), capped at **200 characters** — the path is attacker-controlled and unbounded too |
| `pathTruncated` | `true` only when the cap bit, so a prefix is never mistaken for the whole path |
| `status` | response status code |
| `durationMs` | wall-clock milliseconds from the first middleware to the end of the response |
| `aborted` | `true` when the client went away before the response was sent |
| `ip` | client IP, resolved through `core/client-ip` (honours the configured `trust proxy`) |
| `userId` | numeric user id, only when the request was authenticated |

The **level carries the outcome**: `info` for < 400, `warn` for 4xx, `error` for 5xx — so an error
budget can be read straight off `level` without parsing `status`. An abort is `warn` whatever `status`
says, because nothing was delivered and the default `200` on an unanswered response is not a success.
Set `logging.accessLog: false` to turn the line off; the rest of the application's logging is
unaffected.

The line is emitted on **`finish` or `close`, whichever comes first**. `finish` never fires for a
request whose socket dies before the handler responds, so hooking it alone meant a hung endpoint, a
client timeout, an upstream read-timeout and every aborted upload produced no line at all — grepping
the request id an operator was handed returned nothing, precisely in the incidents worth tracing.

---

## Metrics

`GET /metrics`, Prometheus text format (`prom-client`).

### The token gate — unchanged

The endpoint returns **404 unless `metrics.token` is configured** (`wordjs-config.json`, or the
`METRICS_TOKEN` environment variable), so metrics are never public by default. When a token is set:

- `Authorization: Bearer <token>` → **200**;
- no header, or a wrong token → **401** (compared in constant time);
- `?token=<token>` in the query string → **401**. Header-only, on purpose: a query string leaks a
  long-lived secret into access logs, `Referer` and browser history.

The route is mounted at the root, so it is CSRF-free, not rate-limited and not blocked by the
install/setup guard.

### Series

`app="wordjs"` is attached to every series as a default label.

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `wordjs_http_requests_total` | counter | `method`, `route`, `status` | requests served |
| `wordjs_http_request_duration_seconds` | histogram | `method`, `route` | latency; buckets 5ms, 10, 25, 50, 100, 250, 500ms, 1, 2.5, 5, 10s |
| `wordjs_http_errors_total` | counter | `status` | responses with status ≥ 400 |
| `wordjs_ready` | gauge | — | 1 when installed, booted and serving |
| `wordjs_sse_clients` | gauge | — | active SSE clients on **this** node |
| `wordjs_db_pool` | gauge | `state` = `total` \| `idle` \| `waiting` | connection pool; Postgres and MySQL only |
| `wordjs_sandbox_state` | gauge | `status` = `active` \| `degraded` \| `disabled` \| `unsupported` \| `unknown` | 1 on the current plugin-sandbox confinement state, 0 on the others |
| `wordjs_process_*`, `wordjs_nodejs_*` | various | — | CPU, RSS/heap, event-loop lag, GC, handles (prom-client defaults) |

Notes on the ones with conditions attached:

- **`route` is a route PATTERN, never a URL.** `/api/v1/posts/:id`, not `/api/v1/posts/1234`. The
  number of distinct patterns is capped at 400; anything past that collapses into `other`. This is the
  one thing that can take a metrics endpoint down: a label taken from the path turns every id, slug
  and cache-buster into its own time series.
- **`unmatched` is not "the 404 surface".** It is every response produced without an Express route
  handler ever being reached, which on a real install is a large share of *successful* traffic:
  `express.static` hits (`/themes`, `/plugins`, `/uploads`), anything the frontend proxy answers, and
  every request short-circuited by a rate limiter (429), by CORS, by CSRF or by the install/setup
  guard (503) — as well as genuine 404s. So `sum by (route) (rate(...))` shows one large mixed bucket,
  and a per-endpoint drill-down should filter `route!="unmatched"`. Split it by `status` if you want
  the 404s specifically.
- **`status="499"` means the client went away**, borrowing nginx's convention. An aborted request
  never fires `finish`, so it used to be counted nowhere at all: an endpoint that had started timing
  out *all* of its callers showed a **falling** request rate and a healthy p95, because only the fast
  survivors were sampled — and `wordjs_http_requests_total` could not honestly be the denominator of
  an error ratio. It is counted now, under its own status so it cannot inflate the 2xx bucket, and
  `wordjs_http_errors_total` includes it.
- **`wordjs_db_pool` is absent on SQLite**, which has no pool. On Postgres it comes from `pg`'s
  public pool counters; on MySQL from `mysql2`'s internal queues, read defensively — if the shape is
  not what is expected the gauge is simply not exported, because a metric that guesses is worse than
  one that is missing.
- **`wordjs_process_*` is not hand-rolled.** It is `collectDefaultMetrics` with the `wordjs_` prefix,
  reading `process.cpuUsage()` / `process.memoryUsage()`. Re-deriving those numbers here would produce
  a second set of answers for the same facts.
- **There are no cache hit/miss counters yet.** `core/cache.ts` keeps none; when it grows them,
  `wordjs_cache_hits_total` / `wordjs_cache_misses_total` are two lines in `core/metrics.ts`.
- **There is no tracing yet.** `requestId` is the correlation primitive today. OpenTelemetry spans
  (and honouring an inbound `traceparent`) are the next step; the request-context middleware is where
  they would be started.

### Scraping

```yaml
# prometheus.yml
scrape_configs:
  - job_name: wordjs
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/wordjs-metrics-token   # not `credentials:` — keep it off disk in plain config
    static_configs:
      - targets: ['wordjs-1.internal:3001', 'wordjs-2.internal:3001']
        labels:
          env: production
```

Every node exports **its own** counters and gauges (`wordjs_sse_clients`, `wordjs_db_pool` and the
process family are per-process), so scrape each backend directly rather than through the load
balancer — going through the LB samples a random node each interval and produces a graph that means
nothing. See [multi-node.md](multi-node.md).

### Useful queries

```promql
# request rate by route — `unmatched` is excluded because it is a mixed bucket, see the note above
sum by (route) (rate(wordjs_http_requests_total{route!="unmatched"}[5m]))

# error ratio
sum(rate(wordjs_http_errors_total[5m])) / sum(rate(wordjs_http_requests_total[5m]))

# p95 latency by route
histogram_quantile(0.95, sum by (le, route) (rate(wordjs_http_request_duration_seconds_bucket[5m])))

# a node whose plugin sandbox is claimed but not actually in force
max by (instance) (wordjs_sandbox_state{status="degraded"}) > 0

# saturating connection pool
wordjs_db_pool{state="waiting"} > 0
```

### Alerting starters

```yaml
groups:
  - name: wordjs
    rules:
      - alert: WordJSNotReady
        expr: wordjs_ready == 0
        for: 5m
        annotations:
          summary: "{{ $labels.instance }} has not been ready for 5 minutes"

      - alert: WordJSErrorRate
        expr: sum(rate(wordjs_http_errors_total{status=~"5.."}[5m]))
              / sum(rate(wordjs_http_requests_total[5m])) > 0.05
        for: 10m
        annotations:
          summary: "5xx rate above 5%"

      - alert: WordJSSandboxDegraded
        expr: wordjs_sandbox_state{status="degraded"} == 1
        for: 15m
        annotations:
          summary: "Plugin sandbox confinement is configured but not active"
```

### Grafana

Import the Prometheus data source and start from the queries above; a `route` variable defined as
`label_values(wordjs_http_requests_total{route!="unmatched"}, route)` gives a per-endpoint drill-down
(without the exclusion the list is led by a bucket that mixes static assets, proxied responses, guard
rejections and 404s). To jump from a
latency spike to the requests behind it, add a Loki data source over the same stdout stream and a
derived field on `requestId` — the metric and the log line are produced from the **same** `startedAt`,
so `durationMs` in the log and the histogram sample always agree.
