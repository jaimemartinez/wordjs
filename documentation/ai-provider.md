# AI provider layer 🧠

WordJS has one place that holds the site's AI provider credentials and talks to the provider
(`backend/src/core/ai-provider.ts`), in the spirit of WordPress's AI Client. Everything else asks it for
text and gets text back:

- the **editor** — "Suggest with AI" for a post's or page's excerpt and meta description, and for an
  image's alt text in the media library — always as a suggestion the user accepts;
- **plugins** an administrator granted the `ai:use` permission, through `wordjs.ai.complete(...)`.

Nobody else ever sees the key: not the browser, not plugins, not the logs.

## 1. Configure

**Settings → AI** (`/admin/settings/ai`, administrators, interactive session only):

| Provider | What to enter |
|---|---|
| **Anthropic (Claude)** | the model — `claude-sonnet-5-5` (default, balanced), `claude-haiku-5-5` (cheapest) or `claude-opus-5-5` (most capable) — and the API key |
| **OpenAI-compatible** | the base URL ending in `/v1` (OpenAI, an OpenAI-compatible gateway, Ollama, LM Studio, vLLM…), the model name, and the key if the server needs one. https is required unless the host is loopback (`localhost`, any `*.localhost` name, `127.0.0.1`, `::1`). No query string or fragment |

**Which addresses.** The base URL goes through the same egress guard as webhooks, at save time and again
before every request, and the request connects to the address that was checked (no DNS rebinding in
between). A server on this machine or on a private network (Ollama, LM Studio, an internal gateway) is
accepted on a single-site install and on the primary site of a network; a secondary site of a network
can only use a public endpoint unless the operator sets `WORDJS_AI_ALLOW_PRIVATE_PROVIDER=1` on the
backend. Link-local and cloud-metadata addresses are never accepted. A refused address answers
`ai_provider_address_blocked` (400).

**Test connection** sends one tiny request. Choosing **Off** disables every AI feature.

**Timeout.** One provider request may take 60 s for a remote provider and **300 s for a loopback one** —
a model on the same machine (Ollama, LM Studio on a CPU) can need minutes on its first load, behind a
queue, or for an image. `WORDJS_AI_TIMEOUT_MS` on the backend overrides both (clamped to 1 s – 30 min).
In split and separate mode the gateway sits between the browser and the backend and gives `/api/v1/ai/`
requests `WORDJS_AI_TIMEOUT_MS` + 30 s, read from **its own** environment (see gateway.md, "Upstream
timeout"): when you raise the value, set it for the gateway as well as the backend.

**Errors.** A provider failure answers a distinct code with a message that says what to do; the editor
shows its own wording for each (anything else falls back to "the AI provider did not answer correctly"):

| Code | HTTP | When |
|---|---|---|
| `ai_provider_timeout` | 504 | no answer within the timeout (or the server answered 408/504) |
| `ai_provider_no_vision` | 422 | alt text was asked of a model that does not accept images (the OpenAI-compatible server refused the image) |
| `ai_provider_model` | 502 | the server does not know the configured model (404, or "model not found") |
| `ai_provider_auth` | 502 | the key was refused (401/403) |
| `ai_provider_rate_limited` | 429 | the provider is rate limiting the site |
| `ai_provider_unreachable` | 502 | the server could not be reached at all |
| `ai_provider_address_blocked` | 400 | the base URL points at an address this site may not reach (see *Which addresses*) |
| `ai_provider_unavailable` | 502 | the server answered 502/503 |
| `ai_provider_bad_request` | 502 | any other refusal of the request (400/413/422) |
| `ai_provider_bad_response` | 502 | the answer was not JSON |
| `ai_provider_error` | 502 | any other error status |
| `ai_empty` | 502 | the model answered with no text |
| `ai_nothing_to_summarise` | 400 | the title and body are too short to suggest anything from |
| `ai_unsupported_media` | 400 | alt text was asked for something that is not a public PNG, JPEG, WebP, GIF or AVIF image, or the image could not be read |

`/ai/suggest` also answers `403 rest_forbidden` without the task's capability (or edit rights on the image), and `404 rest_post_invalid_id` for an unknown `mediaId`.

The provider's own error body is only inspected to classify the failure; it is never echoed back.

## 2. The key

- Stored as the option `ai_provider_api_key`. It is **write-only**: `GET /api/v1/ai/settings` answers
  `hasKey` and the last four characters, an empty key field keeps the stored one, and **Remove the stored
  key** clears it. It is in neither the public settings nor `GET /settings/all`.
- The options layer redacts secret-named options from hook payloads; the plugin bridge refuses to read or
  write it, and also refuses `ai_provider` (provider, model, base URL), so a plugin cannot redirect the
  site's requests — and its key — to a server of its choosing. A site import never writes either.
- It is **not encrypted at rest**, for the reason `core/crypto-utils.ts` documents (an encryption key
  derived from the JWT secret broke every stored secret on rotation). It is in database backups, which
  only an interactive administrator can create or download.
- Provider errors are reduced to a status and a short, key-free message; nothing about the request is logged.

Saving the settings is audited as `ai.settings.update` with `{provider, model, baseUrlHost,
previousProvider, keyChanged, keyCleared}` — never the key.

## 3. Editor suggestions

`POST /api/v1/ai/suggest` returns `{ suggestion, model }` and **saves nothing**. The UI shows the
suggestion under the field with **Use / Try again / Dismiss**; **Use** goes through the field's own change
handler, so undo, autosave and the normal save path apply.

| Task | Input | Who | Output |
|---|---|---|---|
| `excerpt` | the draft's title and body (HTML or editor JSON, read from the live canvas) | `edit_posts` or `edit_pages` | 1–2 sentences, ≤ ~400 characters |
| `seo_description` | same | same | one sentence, ≤ 160 characters |
| `alt_text` | `mediaId` | `upload_files` **and** the right to edit that image | ≤ 125 characters |

- The image for `alt_text` is read on the server behind the same rule as editing it, downscaled to at most
  1280 px and re-encoded as JPEG before it leaves the site; private media is not sent.
- **Prompt injection:** the material is wrapped in tags and the system prompt says to ignore instructions
  inside it; the answer is reduced to one line of plain text with a hard length cap. The worst a hostile
  draft can do is produce a bad suggestion the user discards.
- 20 suggestions per minute per user. The buttons appear only when a provider is configured
  (`GET /api/v1/ai/status`).
- Anthropic requests use low effort (short suggestions), opt into the server-side fallback on models that
  support it, and treat `stop_reason: "refusal"` as an error (`422 ai_refused`), never as text.

## 4. Plugins: `ai:use`

```json
{ "permissions": [{ "scope": "ai", "access": "use", "reason": "Summarise form submissions" }] }
```

```js
const { text, model } = await wordjs.ai.complete({
  system: 'You summarise customer messages in one sentence.',
  prompt: `<message>${userMessage}</message>`,
  maxTokens: 256,
});
```

- The manifest **requests** `ai:use`; an administrator **grants** it in the activation dialog, like every
  other permission (`admin` never implies it). Without the grant the call throws.
- Text in, text out: `prompt` ≤ 20,000 characters, optional `system` ≤ 4,000, `maxTokens` 64–2048. No
  images, no provider choice, no key, no raw response. 30 calls per minute per plugin.
- Every call is billed to the site's provider account — grant it to plugins you trust with that.

## 5. API

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/ai/status` | signed in | `{ enabled, tasks }` |
| `GET` | `/ai/settings` | administrator, session | settings without the key (`hasKey`, `keyHint`) |
| `PUT` | `/ai/settings` | administrator, session | `{ provider, model?, baseUrl?, apiKey?, clearKey? }`; `400 rest_invalid_param` on an unknown provider/model or a bad base URL or key |
| `POST` | `/ai/test` | administrator, session | `{ ok, provider, model, ms }` or the provider error |
| `POST` | `/ai/suggest` | edit rights (see §3) | `{ task, title?, content?, mediaId?, language? }` → `{ suggestion, model }`; `409 ai_not_configured`, `422 ai_refused`, `429 ai_rate_limited`, and the provider codes of §1 |

### Errors

Every error has the usual `{ code, message, data: { status } }` shape; the message never carries the key
or the request.

The provider's own failures (`ai_provider_*`, timeouts, a model that does not accept images) are listed in
[§1](#1-configure). The site's own errors:

| Status | Code | When |
|---|---|---|
| `400` | `rest_invalid_param` | Saving settings: an unknown provider or Claude model, an OpenAI-compatible provider without a model, a base URL that is not a valid http(s) URL, carries credentials or uses plain http to a host that is not loopback, or a key that is too long or contains whitespace. Also a bad `task`, `title`/`content` or a missing `mediaId` on `/ai/suggest`, and a plugin's malformed `wordjs.ai.complete(...)` input |
| `409` | `ai_not_configured` | No provider, no stored key (Anthropic), or no base URL or model (OpenAI-compatible) |
| `422` | `ai_refused` | The model declined to answer (`stop_reason: "refusal"`) |
| `429` | `ai_rate_limited` | This site's own limit: 20 suggestions per minute per user, 30 calls per minute per plugin |
