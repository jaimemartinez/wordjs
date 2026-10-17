/**
 * WordJS — AI provider layer (in the spirit of WordPress's AI Client).
 *
 * ONE place that holds the site's AI provider credentials and talks to the provider. Everything else —
 * the editor's suggestions (routes/ai.ts) and plugins granted `ai:use` (core/plugin-api `wordjs.ai`) —
 * asks this module for a completion and gets TEXT back. Nobody else ever sees the key:
 *   • it is stored as the option `ai_provider_api_key`, a secret-shaped name, so the options layer
 *     redacts it from hook payloads and the plugin bridge refuses to read or write it (PROTECTED_OPTION_RE);
 *   • it is in neither PUBLIC_SETTINGS nor ALL_SETTINGS (routes/settings.ts), so no settings route
 *     returns it; the admin route that writes it answers only `hasKey` and the last four characters;
 *   • it is never logged — provider errors are reduced to a status and a short, key-free message.
 * It is NOT encrypted at rest, deliberately and for the same reason webhook secrets are not
 * (core/crypto-utils explains it: a key derived from the JWT secret broke every stored secret on
 * rotation). It lives in the database, so it is in database backups, which only an interactive
 * administrator can create or download.
 *
 * Providers:
 *   • `anthropic` — the official @anthropic-ai/sdk. Default model claude-sonnet-5-5; claude-haiku-5-5
 *     (cheapest) and claude-opus-5-5 are offered. Requests use low effort (short suggestions do not
 *     need deep reasoning), check `stop_reason === "refusal"` before reading content, and opt into the
 *     server-side fallback where the model supports it.
 *   • `openai-compatible` — any server speaking POST {baseUrl}/chat/completions (OpenAI, Azure OpenAI
 *     gateways, Ollama, LM Studio, vLLM…). https is required unless the host is loopback.
 */

const { getOption, updateOption } = require('./options');

const SETTINGS_OPTION = 'ai_provider';
const KEY_OPTION = 'ai_provider_api_key';

const PROVIDERS = ['anthropic', 'openai-compatible'] as const;
type AiProviderId = typeof PROVIDERS[number];

const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'] as const;
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
/** Models that accept `fallbacks: "default"` (Claude Haiku 5.5 has no server-side fallback). */
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

/**
 * How long one provider request may take. A hosted API answers in seconds; a model on this machine
 * (Ollama, LM Studio on a CPU) can need minutes on its first load, behind a queue, or for an image. So
 * a loopback provider gets a longer default, and `WORDJS_AI_TIMEOUT_MS` overrides both (1 s–30 min).
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOCAL_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

function requestTimeoutMs(baseUrl = ''): number {
    const raw = Number(process.env.WORDJS_AI_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) return Math.min(Math.max(Math.round(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
    let host: string;
    try { host = baseUrl ? new URL(baseUrl).hostname : ''; } catch { host = ''; }
    return host && isLoopbackHost(host) ? DEFAULT_LOCAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function timeoutError(ms: number): AiError {
    return new AiError(
        `The AI provider took too long to answer (more than ${Math.round(ms / 1000)} s). A local model may still be loading; try again, or raise WORDJS_AI_TIMEOUT_MS.`,
        504,
        'ai_provider_timeout',
    );
}

interface AiSettings {
    provider: AiProviderId | '';
    model: string;
    baseUrl: string;
}

interface AiImage {
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    /** base64, no data: prefix */
    data: string;
}

interface AiCompleteRequest {
    system: string;
    prompt: string;
    image?: AiImage;
    maxTokens?: number;
}

/** An error whose message is safe to show to the caller (never contains the key or a raw body). */
class AiError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 502, code = 'ai_provider_error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function parseSettings(raw: unknown): AiSettings {
    let v: any = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    const provider = v && (PROVIDERS as readonly string[]).includes(v.provider) ? v.provider : '';
    return {
        provider,
        model: v && typeof v.model === 'string' ? v.model.slice(0, 120) : '',
        baseUrl: v && typeof v.baseUrl === 'string' ? v.baseUrl.slice(0, 500) : '',
    };
}

async function readSettings(): Promise<AiSettings> {
    return parseSettings(await getOption(SETTINGS_OPTION, null));
}

async function readKey(): Promise<string> {
    const k = await getOption(KEY_OPTION, '');
    return typeof k === 'string' ? k : '';
}

function effectiveModel(s: AiSettings): string {
    if (s.provider === 'anthropic') return s.model || DEFAULT_ANTHROPIC_MODEL;
    return s.model;
}

/** What the admin screen may see: everything except the key, which is reduced to a hint. */
async function getPublicSettings() {
    const s = await readSettings();
    const key = await readKey();
    return {
        provider: s.provider,
        model: effectiveModel(s),
        baseUrl: s.baseUrl,
        hasKey: !!key,
        keyHint: key ? `…${key.slice(-4)}` : '',
        providers: PROVIDERS,
        anthropicModels: ANTHROPIC_MODELS,
    };
}

function isLoopbackHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/** Validate an OpenAI-compatible base URL: http(s), no credentials, https unless loopback. */
function validateBaseUrl(raw: unknown): string {
    let u: URL;
    try { u = new URL(String(raw || '')); } catch { throw new AiError('The base URL is not a valid URL.', 400, 'rest_invalid_param'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AiError('The base URL must be http(s).', 400, 'rest_invalid_param');
    if (u.username || u.password) throw new AiError('Put the API key in its own field, not in the URL.', 400, 'rest_invalid_param');
    if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
        throw new AiError('Use https for a remote provider (plain http is only accepted for a server on this machine).', 400, 'rest_invalid_param');
    }
    return u.toString().replace(/\/+$/, '');
}

/**
 * Save the provider settings. `apiKey` is only touched when a non-empty value is sent (or `clearKey`):
 * the admin form never receives the stored key, so an empty field means "keep it".
 * Returns what changed, for the audit row (never the key).
 */
async function saveSettings(input: { provider?: unknown; model?: unknown; baseUrl?: unknown; apiKey?: unknown; clearKey?: unknown }) {
    const provider = input.provider === '' || input.provider == null ? '' : String(input.provider);
    if (provider && !(PROVIDERS as readonly string[]).includes(provider)) {
        throw new AiError(`Unknown provider. Use one of: ${PROVIDERS.join(', ')}.`, 400, 'rest_invalid_param');
    }
    let model = typeof input.model === 'string' ? input.model.trim().slice(0, 120) : '';
    let baseUrl = '';
    if (provider === 'anthropic') {
        if (model && !(ANTHROPIC_MODELS as readonly string[]).includes(model)) {
            throw new AiError(`Unknown Claude model. Use one of: ${ANTHROPIC_MODELS.join(', ')}.`, 400, 'rest_invalid_param');
        }
        model = model || DEFAULT_ANTHROPIC_MODEL;
    } else if (provider === 'openai-compatible') {
        baseUrl = validateBaseUrl(input.baseUrl);
        if (!model || !/^[A-Za-z0-9._:/@-]+$/.test(model)) {
            throw new AiError('Name the model the server should use (e.g. gpt-5-mini, llama3.2).', 400, 'rest_invalid_param');
        }
    }
    const before = await readSettings();
    await updateOption(SETTINGS_OPTION, JSON.stringify({ provider, model, baseUrl }));

    let keyChanged = false;
    let keyCleared = false;
    if (input.clearKey === true) {
        await updateOption(KEY_OPTION, '');
        keyCleared = true;
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
        const key = input.apiKey.trim();
        if (key.length > 500 || /\s/.test(key)) throw new AiError('That does not look like an API key.', 400, 'rest_invalid_param');
        await updateOption(KEY_OPTION, key);
        keyChanged = true;
    }
    return {
        provider,
        model,
        baseUrlHost: baseUrl ? new URL(baseUrl).host : '',
        previousProvider: before.provider,
        keyChanged,
        keyCleared,
    };
}

/** Is a provider configured well enough to be called? (Anthropic needs a key; a local server may not.) */
async function isConfigured(): Promise<boolean> {
    const s = await readSettings();
    if (s.provider === 'anthropic') return !!(await readKey());
    if (s.provider === 'openai-compatible') return !!(s.baseUrl && s.model);
    return false;
}

// ─── Providers ──────────────────────────────────────────────────────────────────────────────────────

function anthropicClient(apiKey: string): any {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic || mod;
    return new Anthropic({ apiKey, maxRetries: 1, timeout: requestTimeoutMs() });
}

function mapAnthropicError(e: any): AiError {
    const mod = require('@anthropic-ai/sdk');
    const A = mod.default || mod.Anthropic || mod;
    if (A && e instanceof A.AuthenticationError) return new AiError('The AI provider rejected the API key.', 502, 'ai_provider_auth');
    if (A && e instanceof A.PermissionDeniedError) return new AiError('The API key is not allowed to use this model.', 502, 'ai_provider_auth');
    if (A && e instanceof A.NotFoundError) return new AiError('The configured model was not found.', 502, 'ai_provider_model');
    if (A && A.APIConnectionTimeoutError && e instanceof A.APIConnectionTimeoutError) return timeoutError(requestTimeoutMs());
    if (A && e instanceof A.RateLimitError) return new AiError('The AI provider is rate limiting this site. Try again shortly.', 429, 'ai_provider_rate_limited');
    if (A && e instanceof A.BadRequestError) return new AiError('The AI provider refused the request as invalid.', 502, 'ai_provider_bad_request');
    if (A && e instanceof A.APIConnectionError) return new AiError('Could not reach the AI provider.', 502, 'ai_provider_unreachable');
    if (A && e instanceof A.APIError) return new AiError(`The AI provider answered with an error (HTTP ${e.status || '?'}).`, 502);
    return new AiError('The AI provider could not be reached.', 502);
}

async function completeAnthropic(model: string, apiKey: string, req: AiCompleteRequest): Promise<string> {
    const client = anthropicClient(apiKey);
    const content: any[] = [];
    if (req.image) content.push({ type: 'image', source: { type: 'base64', media_type: req.image.mediaType, data: req.image.data } });
    content.push({ type: 'text', text: req.prompt });
    const params: any = {
        model,
        // Short suggestions: a hard reason to stay low, with room for the model's (low-effort) thinking.
        max_tokens: Math.min(Math.max(req.maxTokens || 2048, 256), 4096),
        system: req.system,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content }],
    };
    let response: any;
    try {
        response = ANTHROPIC_FALLBACK_MODELS.has(model)
            ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
            : await client.messages.create(params);
    } catch (e) {
        throw mapAnthropicError(e);
    }
    if (response.stop_reason === 'refusal') {
        throw new AiError('The model declined to answer this request.', 422, 'ai_refused');
    }
    const text = (response.content || [])
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('');
    if (!text.trim()) throw new AiError('The model returned no text.', 502, 'ai_empty');
    return text;
}

/** Words a server uses when the model it runs cannot read images (Ollama, vLLM, LM Studio, OpenAI). */
const NO_VISION_RE = /\b(image|images|vision|multimodal|multi-modal|image_url)\b/i;

/**
 * Turn a non-2xx answer into an error that says what to do. The provider's body is only inspected
 * (first 2 KB) to classify it, never echoed: it can quote the request.
 */
async function mapOpenAiCompatibleStatus(res: any, sentImage: boolean): Promise<AiError> {
    const status = Number(res.status) || 0;
    if (status === 401 || status === 403) return new AiError('The AI provider rejected the API key.', 502, 'ai_provider_auth');
    if (status === 429) return new AiError('The AI provider is rate limiting this site. Try again shortly.', 429, 'ai_provider_rate_limited');
    let detail: string;
    try { detail = String(await res.text()).slice(0, 2048); } catch { detail = ''; }
    if (status === 404 || (/\bmodel\b/i.test(detail) && /not (be )?found|does not exist|unknown model|no such model/i.test(detail))) {
        return new AiError('The configured model was not found on the AI server. Check the model name under Settings → AI.', 502, 'ai_provider_model');
    }
    if (sentImage && status >= 400 && status <= 500 && (NO_VISION_RE.test(detail) || (status === 400 && !detail.trim()))) {
        return new AiError('The configured model does not accept images. Choose a vision-capable model under Settings → AI to suggest alt text.', 422, 'ai_provider_no_vision');
    }
    if (status === 400 || status === 413 || status === 422) {
        return new AiError(`The AI provider refused the request as invalid (HTTP ${status}).`, 502, 'ai_provider_bad_request');
    }
    if (status === 408 || status === 504) return timeoutError(requestTimeoutMs());
    if (status === 502 || status === 503) {
        return new AiError(`The AI provider is unavailable right now (HTTP ${status}). Try again shortly.`, 502, 'ai_provider_unavailable');
    }
    return new AiError(`The AI provider answered with an error (HTTP ${status}).`, 502, 'ai_provider_error');
}

async function completeOpenAiCompatible(s: AiSettings, apiKey: string, req: AiCompleteRequest): Promise<string> {
    const userContent: any = req.image
        ? [
            { type: 'image_url', image_url: { url: `data:${req.image.mediaType};base64,${req.image.data}` } },
            { type: 'text', text: req.prompt },
        ]
        : req.prompt;
    const timeoutMs = requestTimeoutMs(s.baseUrl);
    let res: any;
    try {
        res = await fetch(`${s.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: s.model,
                max_tokens: Math.min(Math.max(req.maxTokens || 1024, 64), 4096),
                messages: [{ role: 'system', content: req.system }, { role: 'user', content: userContent }],
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e: any) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw timeoutError(timeoutMs);
        throw new AiError('Could not reach the AI provider.', 502, 'ai_provider_unreachable');
    }
    if (!res.ok) throw await mapOpenAiCompatibleStatus(res, !!req.image);
    let body: any;
    try { body = await res.json(); } catch (e: any) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw timeoutError(timeoutMs);
        throw new AiError('The AI provider answered with something that is not JSON.', 502, 'ai_provider_bad_response');
    }
    const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
    const msg = choice && choice.message ? choice.message.content : '';
    const text = typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.map((p: any) => (p && p.text) || '').join('') : '';
    if (!text.trim()) throw new AiError('The model returned no text.', 502, 'ai_empty');
    return text;
}

/**
 * Run one completion with the configured provider. Returns plain text (trimmed, at most 20k chars).
 * Throws AiError (safe message, HTTP status) on every failure.
 */
async function complete(req: AiCompleteRequest): Promise<{ text: string; provider: string; model: string }> {
    const s = await readSettings();
    if (!s.provider) throw new AiError('No AI provider is configured. An administrator can set one up under Settings → AI.', 409, 'ai_not_configured');
    const key = await readKey();
    const model = effectiveModel(s);
    let text: string;
    if (s.provider === 'anthropic') {
        if (!key) throw new AiError('The AI provider has no API key.', 409, 'ai_not_configured');
        text = await completeAnthropic(model, key, req);
    } else {
        if (!s.baseUrl || !model) throw new AiError('The AI provider is not fully configured.', 409, 'ai_not_configured');
        text = await completeOpenAiCompatible(s, key, req);
    }
    return { text: text.trim().slice(0, 20_000), provider: s.provider, model };
}

// ─── Plugins (`ai:use`) ─────────────────────────────────────────────────────────────────────────────

const PLUGIN_CALLS_PER_MINUTE = 30;
const pluginWindows = new Map<string, number[]>();

/**
 * The bridge entry for a plugin granted `ai:use` (core/plugin-api checks the grant first). Text in,
 * text out: the plugin never sees the key, the provider or a raw response, and cannot attach images.
 */
async function completeForPlugin(slug: string, input: unknown): Promise<{ text: string; model: string }> {
    const req: any = input && typeof input === 'object' ? input : {};
    if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new AiError('ai.complete needs a non-empty `prompt` string.', 400, 'rest_invalid_param');
    if (req.prompt.length > 20_000) throw new AiError('`prompt` is limited to 20,000 characters.', 400, 'rest_invalid_param');
    if (req.system !== undefined && (typeof req.system !== 'string' || req.system.length > 4000)) {
        throw new AiError('`system` must be a string of at most 4,000 characters.', 400, 'rest_invalid_param');
    }
    const now = Date.now();
    const recent = (pluginWindows.get(slug) || []).filter((t) => now - t < 60_000);
    if (recent.length >= PLUGIN_CALLS_PER_MINUTE) {
        pluginWindows.set(slug, recent);
        throw new AiError('This plugin reached its AI request limit. Try again in a minute.', 429, 'ai_rate_limited');
    }
    recent.push(now);
    pluginWindows.set(slug, recent);
    const maxTokens = Number.isInteger(req.maxTokens) ? Math.min(Math.max(req.maxTokens, 64), 2048) : 1024;
    const out = await complete({
        system: req.system || 'You are a helpful assistant inside a website content management system.',
        prompt: req.prompt,
        maxTokens,
    });
    return { text: out.text, model: out.model };
}

module.exports = {
    AiError,
    PROVIDERS,
    ANTHROPIC_MODELS,
    DEFAULT_ANTHROPIC_MODEL,
    getPublicSettings,
    saveSettings,
    isConfigured,
    complete,
    completeForPlugin,
    validateBaseUrl,
    requestTimeoutMs,
    SETTINGS_OPTION,
    KEY_OPTION,
    _resetPluginAiLimits: () => pluginWindows.clear(),
};
