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
| **OpenAI-compatible** | the base URL ending in `/v1` (OpenAI, an OpenAI-compatible gateway, Ollama, LM Studio, vLLM…), the model name, and the key if the server needs one. https is required unless the host is loopback (`localhost`, `127.0.0.1`, `::1`) |

**Test connection** sends one tiny request. Choosing **Off** disables every AI feature.

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
| `POST` | `/ai/suggest` | edit rights (see §3) | `{ task, title?, content?, mediaId?, language? }` → `{ suggestion, model }`; `409 ai_not_configured`, `422 ai_refused`, `429 ai_rate_limited`, or a provider error (below) |

### Errors

Every error has the usual `{ code, message, data: { status } }` shape; the message never carries the key
or the request.

| Status | Code | When |
|---|---|---|
| `400` | `rest_invalid_param` | Saving settings: an unknown provider or Claude model, an OpenAI-compatible provider without a model, a base URL that is not a valid http(s) URL, carries credentials or uses plain http to a host that is not loopback, or a key that is too long or contains whitespace. Also a bad `task`, `title`/`content` or a missing `mediaId` on `/ai/suggest`, and a plugin's malformed `wordjs.ai.complete(...)` input |
| `409` | `ai_not_configured` | No provider, no stored key (Anthropic), or no base URL or model (OpenAI-compatible) |
| `422` | `ai_refused` | The model declined to answer (`stop_reason: "refusal"`) |
| `429` | `ai_rate_limited` | This site's own limit: 20 suggestions per minute per user, 30 calls per minute per plugin |
| `429` | `ai_provider_rate_limited` | The provider is rate limiting the site's account |
| `502` | `ai_provider_auth` | The provider rejected the key, or the key may not use this model |
| `502` | `ai_provider_model` | The configured model was not found (Anthropic) |
| `502` | `ai_provider_bad_request` | The provider refused the request as invalid (Anthropic) |
| `502` | `ai_provider_unreachable` | The provider could not be reached (network error or timeout) |
| `502` | `ai_empty` | The model returned no text |
| `502` | `ai_provider_error` | Any other provider error, or a response that is not JSON |
