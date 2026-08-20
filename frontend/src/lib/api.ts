import { createContentClient } from './generated/content-client.generated';
export type {
    ContentCreateInput,
    ContentRecord,
    ContentUpdateInput,
    CoreContentFieldMap,
    CoreContentTypeName,
    Post,
    PostTermRef,
} from './generated/content-client.generated';

const getBaseUrl = () => {
    if (typeof window !== 'undefined') {
        // Client-side: Always use relative URL so it works behind Gateway on any port/protocol
        return '/api/v1';
    }
    // Server-side (SSR):
    // Monolith mode: hit the in-process backend over its loopback HTTP listener (plain HTTP, so the
    // public HTTPS self-signed cert never blocks server-side fetches).
    if (process.env.WORDJS_MODE === 'mono') {
        return `${process.env.WORDJS_MONO_ORIGIN || 'http://127.0.0.1:4000'}/api/v1`;
    }
    // Separate-machine override (mirrors lib/server-api.ts so every SSR path agrees): reach a backend on
    // another host via INTERNAL_API_URL (env) or config.internalApiUrl, instead of always localhost.
    if (process.env.INTERNAL_API_URL) {
        return process.env.INTERNAL_API_URL.replace(/\/+$/, '');
    }
    let backendPort = 4000;
    try {
        // Dynamically require fs/path to avoid bundling issues on client
        // Dynamically import fs/path to avoid bundling issues on client
        // This block only runs on server
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');

        // Priority: Local (Distributed) -> Backend (Monolith)
        let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
        if (!fs.existsSync(configPath)) {
            configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
        }

        if (fs.existsSync(configPath)) {
            const fileContent = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(fileContent);
            if (config.internalApiUrl) {
                return String(config.internalApiUrl).replace(/\/+$/, '');
            }
            // LOCAL SPLIT: an installed backend serves HTTPS with mTLS enforced, so the plain-HTTP
            // fallback below can never reach it. Route SSR through the gateway (see lib/server-api.ts,
            // which this deliberately mirrors — every SSR path must agree on the base).
            const backendCert = path.resolve(path.dirname(configPath), 'certs', 'backend.crt');
            if (fs.existsSync(backendCert)) {
                const front = String(config.gatewayUrl || config.siteUrl || '').replace(/\/+$/, '');
                if (front) return `${front}/api/v1`;
            }
            if (config.port) {
                backendPort = config.port;
            }
        }
    } catch {
        // console.warn('Could not load wordjs-config.json, using default port 4000');
    }

    return `http://localhost:${backendPort}/api/v1`;
};

const API_URL = getBaseUrl();

/**
 * Fired once on `window` when a request discovers the session is over, so session state is cleared in
 * ONE place (AuthContext) rather than by whichever request happened to notice first.
 */
export const SESSION_ENDED_EVENT = "wjs:session-ended";

/**
 * The 401 codes that mean THE SESSION IS OVER — the credential is missing, expired, revoked, or its
 * user no longer exists — as opposed to a request that failed while the session is perfectly valid.
 *
 * Deliberately NOT included:
 *   • `rest_csrf_invalid` — a CSRF rejection is a security signal. Quietly logging the user out would
 *     bury it, and the session itself is fine.
 *   • `rest_token_scope_insufficient` — an API token missing a scope; the browser session is unaffected.
 * A 403 is never here either: authenticated-but-forbidden is not a session problem, which is the same
 * distinction AuthContext.fetchUser already documents.
 */
const SESSION_ENDED_CODES = new Set([
    "rest_token_expired",
    "rest_token_revoked",
    "rest_token_invalid",
    "rest_not_logged_in",
    "rest_user_invalid",
]);

/**
 * True when an error thrown by `api()` means the session ended. Callers use this to stay quiet about an
 * expected sign-out instead of reporting it as a failure — an expired session is not a bug in the
 * request that tripped over it.
 */
export function isSessionEnded(error: unknown): boolean {
    return !!error && typeof error === "object"
        && SESSION_ENDED_CODES.has((error as { code?: string }).code ?? "");
}

type RequestMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface ApiOptions {
    method?: RequestMethod;
    body?: unknown;
    headers?: Record<string, string>;
    responseType?: "json" | "text" | "blob";
}

export async function api<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
    // Note: Token is now sent via HttpOnly cookie automatically
    // We no longer read from localStorage for security

    const isFormData = options.body instanceof FormData;
    const headers: Record<string, string> = {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
    };

    const res = await fetch(`${API_URL}${endpoint}`, {
        method: options.method || "GET",
        headers,
        body: options.body ? (isFormData ? (options.body as FormData) : JSON.stringify(options.body)) : undefined,
        cache: "no-store",
        credentials: "include", // SECURITY: Send HttpOnly cookies with requests
    });

    if (!res.ok) {
        let errorMessage = `HTTP ${res.status} ${res.statusText}`;
        // Read the body exactly once, then attempt to parse it as JSON.
        const raw = await res.text().catch(() => "");
        let error: any = null;
        try {
            error = raw ? JSON.parse(raw) : null;
        } catch {
            error = null;
        }

        if (error) {
            // Handle global redirects (Installation/Migration)
            if (typeof window !== 'undefined' && error.redirect) {
                // Prevent infinite redirect loops if already on the page
                if (!window.location.pathname.startsWith(error.redirect)) {
                    window.location.href = error.redirect;
                    // Don't throw, just interrupt flow or throw specific redirect error
                    throw new Error(`Redirecting to ${error.redirect}...`);
                }
            }

            // Enforced MFA: a required-role user past their grace window is blocked from every non-exempt
            // call. Funnel them to the account page, where the layout's forced-enrolment gate takes over.
            if (typeof window !== 'undefined' && res.status === 403 && error.code === 'mfa_enrollment_required') {
                if (!window.location.pathname.startsWith('/admin/account')) {
                    window.location.href = '/admin/account';
                    throw new Error('Two-factor authentication is required. Redirecting…');
                }
            }

            // A DEAD SESSION is a global condition, like the two above — not a failure of whichever
            // request happened to notice it first. Announce it once so the session is cleared centrally
            // (AuthContext owns that state) instead of every caller inventing its own handling, which is
            // how a routine expiry ended up logged as an application error by a background refresh.
            //
            // Deliberately NOT a redirect from here: this fires from background polling too, and yanking
            // the location out from under someone mid-form would be worse than the bug. The admin layout
            // already routes an unauthenticated user to /login once AuthContext clears the user.
            if (typeof window !== 'undefined' && res.status === 401 && SESSION_ENDED_CODES.has(error.code)) {
                window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code: error.code } }));
            }

            errorMessage = error.message || error.error || errorMessage;
        } else if (raw) {
            // Not JSON (e.g. HTML 500 error): include the raw text snippet.
            errorMessage += `: ${raw.slice(0, 100)}`;
        }
        const thrown: Error & { details?: unknown; status?: number; errors?: string[]; code?: string } = new Error(errorMessage);
        // Carry the backend's STABLE error code. Callers that need to tell one 401 from another must key
        // on this, never on the human-readable message (which is copy, and translated).
        if (error && typeof error.code === 'string') thrown.code = error.code;
        // Preserve any structured `details` (e.g. a plugin activation reject's
        // missingPermissions/dangerousCalls) so callers can render more than a flat string.
        if (error && error.details !== undefined) thrown.details = error.details;
        // Preserve a validator's `errors` array (e.g. the chrome contract's 400) the same way.
        if (error && Array.isArray(error.errors)) thrown.errors = error.errors;
        thrown.status = res.status;
        throw thrown;
    }

    if (options.responseType === "text") {
        return res.text() as unknown as T;
    }
    if (options.responseType === "blob") {
        return res.blob() as unknown as T;
    }

    return res.json();
}

// Convenience methods
export const apiGet = <T>(endpoint: string) => api<T>(endpoint);
export const apiPost = <T>(endpoint: string, body: unknown) => api<T>(endpoint, { method: "POST", body });
export const apiPut = <T>(endpoint: string, body: unknown) => api<T>(endpoint, { method: "PUT", body });
export const apiDelete = <T>(endpoint: string) => api<T>(endpoint, { method: "DELETE" });

/**
 * Paged GET: the list endpoints emit X-WP-Total / X-WP-TotalPages headers that `api()`
 * discards. Same cookie/error semantics; also returns the totals so lists can paginate.
 */
export async function apiGetPaged<T>(endpoint: string): Promise<{ data: T; total: number; totalPages: number }> {
    const res = await fetch(`${API_URL}${endpoint}`, { cache: "no-store", credentials: "include" });
    if (!res.ok) {
        let msg = `HTTP ${res.status} ${res.statusText}`;
        try { const e = await res.json(); msg = e?.message || e?.error || msg; } catch { /* non-JSON body */ }
        throw new Error(msg);
    }
    const data = (await res.json()) as T;
    const total = parseInt(res.headers.get("X-WP-Total") || "", 10);
    const totalPages = parseInt(res.headers.get("X-WP-TotalPages") || "", 10);
    return {
        data,
        total: Number.isFinite(total) ? total : (Array.isArray(data) ? (data as unknown[]).length : 0),
        totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1,
    };
}

export interface Category {
    id: number;
    name: string;
    slug: string;
    count: number;
}

export interface User {
    id: number;
    username: string;
    email: string;
    displayName: string;
    role: string;
    capabilities: string[];
    personalEmail?: string | null;
    /**
     * ACTIVE CORPORATE MAILBOX — the admin-owned grant (backend: user_meta.professional_mailbox).
     * Only POST /users and PUT /users/:id accept it, and only from a caller holding `edit_users`; the
     * self-service PUT /users/me ignores it entirely. A mail plugin gates its whole surface on this.
     */
    professionalMailbox?: boolean;
    mfa?: {
        required: boolean;
        enabled: boolean;
        enforced: boolean;
        withinGrace: boolean;
        graceDeadline: number | null;
    };
}

export interface Role {
    name: string;
    capabilities: string[];
}

export interface Plugin {
    name: string;
    slug: string;
    description: string;
    version: string;
    active: boolean;
    permissions?: {
        scope: string;
        access: string;
        reason: string;
    }[];
    requestedPermissions?: string[];  // "scope:access" tokens the manifest requests (the togglable set)
    grantedPermissions?: string[];    // tokens the admin has granted (subset of requested + optional "network")
    author?: string;
    homepage?: string;
    runtime?: PluginRuntime | null;   // live isolate health when active (null if inactive / not an isolate)
    hasTheme?: boolean;               // plugin bundles a companion theme/ folder (installable via installTheme)
    themeInstalled?: boolean;         // themes/<slug>-theme already exists
}

export interface PluginRuntime {
    state: 'running' | 'restarting' | 'crashed' | 'crash-looping' | 'stopped';
    pid?: number | null;
    startedAt?: number;
    uptimeMs?: number;
    restarts?: number;
    lastExitCode?: number | null;
    lastError?: string | null;
    rssBytes?: number | null;
}

// A manifest-claimed port and who (if anyone) is squatting it. `canFree` = WordJS can permanently
// disable the occupant (known system MTA, running as root) after explicit admin confirmation.
export interface PluginPortConflict {
    port: number;
    inUse: boolean;
    canFree: boolean;
    occupant?: {
        process: string;
        pids: number[];
        loopbackOnly: boolean;
        service?: string;
        label?: string;
    };
    reason?: string;
}

export interface Theme {
    name: string;
    slug: string;
    description: string;
    version: string;
    active: boolean;
}

export interface Stats {
    posts: number;
    pages: number;
    comments: number;
    users: number;
}

export interface Comment {
    id: number;
    postId: number;
    author: string;
    authorEmail: string;
    authorUrl: string;
    date: string;
    content: string;
    status: string;
    authorAvatarUrl?: string;
    parent?: number;
    replies?: Comment[];
}

export interface MenuItem {
    id: number;
    title: string;
    url: string;
    type?: string;
    target?: string;
    objectId?: number;
    parent_id: number | null;
    /** Parent item id, 0 = raíz — the name the backend's toJSON actually returns and PUT /menus/items/:id updates. */
    parent?: number;
    order: number;
    children?: MenuItem[];
}

export interface Menu {
    id: number;
    name: string;
    slug: string;
    items: MenuItem[];
}

export interface Revision {
    id: number;
    postId: number;
    authorId: number;
    title: string;
    content: string;
    excerpt: string;
    date: string;
    modified: string;
    meta?: Record<string, any>;
    restore?: RevisionRestoreDescriptor;
}

export interface RevisionRestoreField {
    name: string;
    description: string;
    storage: "column" | "meta";
    present: boolean;
    willClear: boolean;
}

export interface RevisionRestoreDescriptor {
    compatible: boolean;
    legacy: boolean;
    schemaVersion: number;
    codecVersion: number;
    schemaFingerprint: string | null;
    inactivePluginPolicy: "snapshot-authoritative";
    preservesUndeclaredFields: true;
    fields: RevisionRestoreField[];
    errorCode?: string;
}

// F2 client: paths and request DTOs are generated from the F1 content declarations.
export const postsApi = createContentClient({
    get: apiGet,
    getPaged: apiGetPaged,
    post: apiPost,
    put: apiPut,
    delete: apiDelete,
});

// ── Categories (taxonomy `category`) ───────────────────────────────────────────────────────────────
// WHY THERE IS NO PLAIN `list()` ANY MORE: `GET /categories` is PAGED and hard-caps `per_page` at
// 100 (routes/categories.ts), ordered by name. The old `list()` sent no pager at all, so every
// consumer silently saw the first 100 categories and treated that as "all of them" — which on any
// site with more (trivial after a WXR import) meant the post editor could not offer, nor even NAME,
// a category past the cap, and the categories screen could neither show nor delete one. Reading the
// taxonomy therefore goes through the bounded pager below, exactly like `tagsApi`.
/** Page size for the category reads. The router CAPS `per_page` at 100, so asking for more is a lie. */
export const CATEGORY_PAGE_SIZE = 100;
/** Bound on the walk: a pathological taxonomy must not turn opening a screen into dozens of requests. */
export const CATEGORY_MAX_PAGES = 20;

interface CategoryListOptions {
    page?: number;
    perPage?: number;
    search?: string;
    hideEmpty?: boolean;
    orderby?: string;
    order?: "asc" | "desc";
}

function categoryListQuery(opts: CategoryListOptions): URLSearchParams {
    const params = new URLSearchParams();
    params.append("page", String(opts.page || 1));
    params.append("per_page", String(opts.perPage || CATEGORY_PAGE_SIZE));
    if (opts.search) params.append("search", opts.search);
    if (opts.hideEmpty) params.append("hide_empty", "true");
    if (opts.orderby) params.append("orderby", opts.orderby);
    if (opts.order) params.append("order", opts.order);
    return params;
}

/** One page, with the X-WP-Total / X-WP-TotalPages totals the router already emits. */
function listCategoriesPaged(opts: CategoryListOptions = {}) {
    return apiGetPaged<Category[]>(`/categories?${categoryListQuery(opts).toString()}`);
}

/**
 * EVERY category, walking the pager up to `CATEGORY_MAX_PAGES`.
 *
 * `truncated` is part of the contract on purpose: a caller that renders a count (or a picker) must be
 * able to say "there are more" instead of asserting that what it got is the whole taxonomy — the
 * failure this replaces was precisely a UI stating something the database contradicted.
 */
async function listAllCategories(
    opts: { search?: string; hideEmpty?: boolean; maxPages?: number } = {},
): Promise<{ data: Category[]; total: number; truncated: boolean }> {
    const maxPages = Math.max(1, opts.maxPages ?? CATEGORY_MAX_PAGES);
    const collected: Category[] = [];
    let page = 1;
    let totalPages = 1;
    let total = 0;
    do {
        const res = await listCategoriesPaged({
            page,
            perPage: CATEGORY_PAGE_SIZE,
            search: opts.search,
            hideEmpty: opts.hideEmpty,
            orderby: "name",
            order: "asc",
        });
        collected.push(...res.data);
        totalPages = res.totalPages;
        total = res.total;
        page += 1;
    } while (page <= totalPages && page <= maxPages);
    return { data: collected, total, truncated: collected.length < total };
}

export const categoriesApi = {
    listPaged: listCategoriesPaged,
    listAll: listAllCategories,
    create: (data: { name: string; slug?: string }) => apiPost<Category>("/categories", data),
    delete: (id: number) => apiDelete(`/categories/${id}`),
};

// ── Tags (taxonomy `post_tag`) ─────────────────────────────────────────────────────────────────────
// The backend has had a full CRUD router at /api/v1/tags since forever (routes/tags.ts, gated on
// `manage_categories`) with NO client at all, so nothing in the admin could reach it. Mirrors
// categoriesApi above, plus the get/update the tags router exposes and categories does not.
export interface Tag {
    id: number;
    name: string;
    slug: string;
    /** always 'post_tag' from this endpoint — the router pins the taxonomy. */
    taxonomy?: string;
    description?: string;
    parent?: number;
    count: number;
}

export const tagsApi = {
    /** Backend defaults per_page to 100 and caps it at 100; `hide_empty` drops unused tags. */
    list: (opts: { page?: number; perPage?: number; search?: string; hideEmpty?: boolean; orderby?: string; order?: "asc" | "desc" } = {}) => {
        const params = new URLSearchParams();
        if (opts.page) params.append("page", String(opts.page));
        if (opts.perPage) params.append("per_page", String(opts.perPage));
        if (opts.search) params.append("search", opts.search);
        if (opts.hideEmpty) params.append("hide_empty", "true");
        if (opts.orderby) params.append("orderby", opts.orderby);
        if (opts.order) params.append("order", opts.order);
        const qs = params.toString();
        return apiGet<Tag[]>(qs ? `/tags?${qs}` : "/tags");
    },
    /** Same list, with the X-WP-Total / X-WP-TotalPages totals the router already emits. */
    listPaged: (opts: { page?: number; perPage?: number; search?: string; hideEmpty?: boolean; orderby?: string; order?: "asc" | "desc" } = {}) => {
        const params = new URLSearchParams();
        params.append("page", String(opts.page || 1));
        params.append("per_page", String(opts.perPage || 20));
        if (opts.search) params.append("search", opts.search);
        if (opts.hideEmpty) params.append("hide_empty", "true");
        if (opts.orderby) params.append("orderby", opts.orderby);
        if (opts.order) params.append("order", opts.order);
        return apiGetPaged<Tag[]>(`/tags?${params.toString()}`);
    },
    get: (id: number) => apiGet<Tag>(`/tags/${id}`),
    create: (data: { name: string; slug?: string; description?: string }) => apiPost<Tag>("/tags", data),
    update: (id: number, data: { name?: string; slug?: string; description?: string }) => apiPut<Tag>(`/tags/${id}`, data),
    /** DELETE returns `{ deleted, previous }` — the previous term is what a "deshacer" toast would need. */
    remove: (id: number) => apiDelete<{ deleted: boolean; previous: Tag }>(`/tags/${id}`),
};

/**
 * ─── SUDO-GATED SELF-SERVICE FIELDS: the one place the UI learns which edits need a password ───────
 *
 * THE CLASS this closes: the backend hardened a set of SELF-EDIT fields behind a "re-enter your current
 * password" gate (routes/users.ts), and every screen that submits one of them needs to (a) know which
 * fields are gated, (b) ask for the password only when one of them ACTUALLY changed, and (c) read the
 * refusal back as a password problem. One screen got that treatment (MfaSetup) and its twins did not, so
 * the account page could no longer set a recovery email at all and editing your own user record 403'd
 * with a generic "could not save". A rule that lives in N screens is a rule that covers N-1 of them.
 *
 * So the rule lives HERE, next to the call it governs, and every screen consumes it:
 *   • frontend/src/app/admin/account/page.tsx      — the profile form
 *   • frontend/src/app/admin/users/[id]/page.tsx   — the user editor, when the target is yourself
 *   • frontend/src/app/admin/users/UserFormModal.tsx — the same, in modal form
 * A screen that starts submitting one of these fields must call `selfEditNeedsCurrentPassword`; adding a
 * newly gated field to SUDO_GATED_SELF_FIELDS then reaches all of them at once.
 *
 * The predicate MIRRORS the backend by intent, not by copy: an absent or blank address is "not supplied"
 * and never a change (every profile form re-sends its whole object on every save, so presence alone would
 * demand a password for "rename my display name"); comparison is case/whitespace-insensitive because that
 * is how the addresses are normalized before they are stored.
 */
export const SUDO_GATED_SELF_FIELDS = ["password", "email", "personalEmail"] as const;

export interface SelfEditFields {
    email?: string | null;
    personalEmail?: string | null;
    password?: string | null;
}

const normalizeAddress = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** True when this self-edit will be refused unless it carries `currentPassword`. */
export function selfEditNeedsCurrentPassword(current: SelfEditFields, submitted: SelfEditFields): boolean {
    if (submitted.password) return true;
    // Primary email: blank means "left alone" (the backend applies the identical rule).
    if (submitted.email !== undefined) {
        const next = normalizeAddress(submitted.email);
        if (next !== "" && next !== normalizeAddress(current.email)) return true;
    }
    // Recovery email: CLEARING it is a change too — it moves where a reset link would go.
    if (submitted.personalEmail !== undefined
        && normalizeAddress(submitted.personalEmail) !== normalizeAddress(current.personalEmail)) return true;
    return false;
}

/**
 * Build exactly what goes on the wire: the submitted fields, plus `currentPassword` IF AND ONLY IF this
 * save is sudo-gated. Screens call THIS rather than assembling the body themselves — the bug being closed
 * here is precisely a screen that assembled its own body and left the proof out, and a second screen that
 * did the same one directory away. Passing the proof when it is not needed is not harmless either: the
 * backend would then spend a sudo attempt (and answer 403) on a save that required nothing.
 */
export function withSudoProof<T extends SelfEditFields>(
    current: SelfEditFields,
    submitted: T,
    currentPassword: string | null | undefined,
): T & { currentPassword?: string } {
    if (!selfEditNeedsCurrentPassword(current, submitted)) return submitted;
    return { ...submitted, currentPassword: String(currentPassword ?? "") };
}

/** The backend's refusal for a wrong/absent sudo password, so a screen can say so instead of "save failed". */
export function isBadCurrentPassword(error: unknown): boolean {
    return !!error && typeof error === "object"
        && (error as { code?: string }).code === "rest_bad_current_password";
}

export const usersApi = {
    list: () => apiGet<User[]>("/users"),
    get: (id: number) => apiGet<User>(`/users/${id}`),
    create: (data: Partial<User> & { password: string }) => apiPost<User>("/users", data),
    update: (id: number, data: Partial<User> & { currentPassword?: string }) => apiPut<User>(`/users/${id}`, data),
    // Self-service update for the logged-in user (any role). Changing the password OR either recovery
    // address requires currentPassword — ask selfEditNeedsCurrentPassword, do not re-derive the rule.
    updateMe: (data: { displayName?: string; email?: string; personalEmail?: string; password?: string; currentPassword?: string }) =>
        apiPut<User>("/users/me", data),
    /**
     * "Sign me out everywhere" — ends every session of MY account and leaves the API tokens alone.
     *
     * The documented recovery for a leaked machine token is "revoke the token"; on a site upgraded into
     * the headless/session split that does not reach a 7-day cookie minted from the token BEFORE the
     * upgrade, and single-token revocation deliberately does not stamp the JWT epoch (rotating a CI token
     * must not sign the owner out of their browsers). This is the other half of that pair, and until now
     * it had no client at all — a backend route no screen could reach is a capability nobody has.
     * Sudo-gated, and it signs out the CALLING session too: send the user back to /login afterwards.
     */
    revokeSessions: (currentPassword: string) =>
        apiPost<{ signedOut: boolean }>("/users/me/sessions/revoke", { currentPassword }),
    delete: (id: number) => apiDelete(`/users/${id}`),
};

// Public password-recovery endpoints (unauthenticated). Available only when the mail server is active
// and its DNS is fully verified — the login page probes `passwordResetAvailable` before offering it.
export const authApi = {
    passwordResetAvailable: () => apiGet<{ available: boolean }>("/auth/password-reset-available"),
    forgotPassword: (login: string) => apiPost<{ ok: boolean; message: string }>("/auth/forgot-password", { login }),
    resetPassword: (data: { uid: number; token: string; password: string }) =>
        apiPost<{ ok: boolean; message: string }>("/auth/reset-password", data),
    /**
     * Self-registration. 403 `rest_cannot_register` when the `users_can_register` option is off, so a
     * sign-up screen must gate on that setting (it is PUBLIC) instead of assuming this works.
     *
     * TWO OUTCOMES: with email verification off the backend sets the session cookie and the caller is
     * logged in; with `require_email_verification` on it returns `verificationRequired: true` and NO
     * cookie — the account cannot log in until it confirms. Callers MUST branch on that flag rather
     * than navigating straight to the dashboard, which would land on a signed-out redirect.
     */
    register: (data: { username: string; email: string; password: string; displayName?: string }) =>
        apiPost<{ user: User; verificationRequired?: boolean; message?: string }>("/auth/register", data),
    /** Consumes the single-use link from the verification email (/verify-email?uid=…&token=…). */
    verifyEmail: (data: { uid: number; token: string }) =>
        apiPost<{ ok: boolean; message: string }>("/auth/verify-email", data),
};

export const commentsApi = {
    list: (params: { post?: number; status?: string; page?: number; per_page?: number } = {}) => {
        const query = new URLSearchParams();
        if (params.post) query.append('post', String(params.post));
        if (params.status) query.append('status', params.status);
        if (params.page) query.append('page', String(params.page));
        if (params.per_page) query.append('per_page', String(params.per_page));
        return apiGet<Comment[]>(`/comments?${query.toString()}`);
    },
    get: (id: number) => apiGet<Comment>(`/comments/${id}`),
    create: (data: { post: number; content: string; author_name: string; author_email: string; author_url?: string; parent?: number }) => apiPost<Comment>("/comments", data),
    update: (id: number, data: Partial<Comment>) => apiPut<Comment>(`/comments/${id}`, data),
    delete: (id: number, force = false) => apiDelete<{ deleted: boolean }>(`/comments/${id}?force=${force}`),
    approve: (id: number) => apiPost<Comment>(`/comments/${id}/approve`, {}),
    spam: (id: number) => apiPost<Comment>(`/comments/${id}/spam`, {}),
};

export const revisionsApi = {
    list: (postId: number, limit = 10, offset = 0) => apiGet<{ revisions: Revision[]; total: number; postId: number }>(`/revisions/post/${postId}?limit=${limit}&offset=${offset}`),
    get: (id: number) => apiGet<Revision>(`/revisions/${id}`),
    restore: (id: number) => apiPost<{ success: boolean; message: string }>(`/revisions/${id}/restore`, {}),
    compare: (id1: number, id2: number) => apiGet<{ revision1: Revision; revision2: Revision; titleChanged: boolean; contentChanged: boolean; excerptChanged: boolean }>(`/revisions/compare/${id1}/${id2}`),
};

export const pluginsApi = {
    list: () => apiGet<Plugin[]>("/plugins"),
    activate: (slug: string) => apiPost(`/plugins/${slug}/activate`, {}),
    deactivate: (slug: string) => apiPost(`/plugins/${slug}/deactivate`, {}),
    /** Hot-reload a running isolated plugin (re-runs the AST scan, re-registers routes). */
    reload: (slug: string) => apiPost<{ success: boolean; slug: string; message: string }>(`/plugins/${slug}/reload`, {}),
    /** Live runtime health of an isolated plugin. */
    status: (slug: string) => apiGet<PluginRuntime>(`/plugins/${slug}/status`),
    /** Who is squatting the ports this plugin's manifest claims (e.g. the distro MTA on 25)? */
    portConflicts: (slug: string) => apiGet<{ slug: string; conflicts: PluginPortConflict[] }>(`/plugins/${slug}/port-conflicts`),
    /** Admin-confirmed fix: permanently disable the known system MTA holding a claimed port, then reload
     * the plugin. `allowDisable` carries the modal consent — without it the server only reloads (and
     * refuses to disable anything with a 409 CONSENT_REQUIRED). */
    freePort: (slug: string, port: number, allowDisable = false) =>
        apiPost<{ success: boolean; freed: boolean; alreadyFree?: boolean; port: number; service?: string; label?: string; reloaded: boolean }>(`/plugins/${slug}/free-port`, { port, allowDisable }),

    /** Install the companion theme a plugin bundles (its theme/ folder) as themes/<slug>-theme.
     * `activate` = also switch the site to it (one click, plugin-completeness option B). */
    installTheme: (slug: string, activate = false) =>
        apiPost<{ success: boolean; slug: string; activated: boolean; message: string }>(`/plugins/${slug}/install-theme`, { activate }),

    // Android-style per-permission grants (default-deny). `granted` = the "scope:access" tokens the admin
    // approves; `network` = grant outbound network to an untrusted plugin.
    setPermissions: (slug: string, granted: string[], network: boolean) =>
        apiPost<{ success: boolean; granted: string[]; network: boolean; reloaded: boolean; message: string }>(`/plugins/${slug}/permissions`, { granted, network }),
    delete: (slug: string, password?: string, dropData?: boolean) => api<{ success: boolean; message: string; cleanup?: any }>(`/plugins/${slug}`, {
        method: "DELETE",
        body: { password, dropData: !!dropData }
    }),
    download: (slug: string) => {
        // Direct window location change for file download
        // Cookies are sent automatically if SameSite is Lax/None
        const baseUrl = getBaseUrl();
        window.location.href = `${baseUrl}/plugins/${slug}/download`;
    },
    upload: (formData: FormData) => api<{ success: boolean; message: string }>("/plugins/upload", {
        method: "POST",
        body: formData,
        headers: {} // Let browser set boundary
    }),
};

// ---------------------------------------------------------------------------
// Plugin Marketplace (catalog browse + one-click install)
// ---------------------------------------------------------------------------

export interface MarketplaceEntry {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    category: string;
    permissions: { scope: string; access?: string; reason?: string }[];
    hasAdminPage: boolean;
    // "ships an editor block". The catalog is fetched at RUNTIME from the GitHub Release, so this
    // frontend can be reading an index built by an OLDER version that only emits `hasPuckBlock`.
    // Both are optional here and read new-first at the call site; the old name is deprecated and
    // still published by the builder for the mirror-image case (older frontend, newer catalog).
    hasVersoBlock?: boolean;
    /** @deprecated pre-Verso spelling of `hasVersoBlock` — kept so old catalogs still render. */
    hasPuckBlock?: boolean;
    blockName: string | null;
    adminMenu: { label: string; icon?: string } | null;
    file: string;
    size: number;
    sha256: string;
    source?: string; // which configured source (URL) this entry came from
    // Annotations added by the backend against the local install:
    installed: boolean;
    active: boolean;
    installedVersion: string | null;
    updateAvailable: boolean;
    // One-click update is possible only if installed + a newer version + the entry's source MATCHES the
    // source it was installed from. `installedFrom` is that recorded source (null = installed by upload or
    // before origin-binding existed → not one-click updatable; uninstall+reinstall from the catalog first).
    updatable?: boolean;
    installedFrom?: string | null;
}

export interface MarketplaceSourceStatus {
    url: string;
    isLocal: boolean;
    ok: boolean;
    count?: number;
    added?: number;
    error?: string;
}

export type MarketplaceSources = { configured: string[]; default: string; usingDefault: boolean };

export const marketplaceApi = {
    catalog: (refresh = false) =>
        apiGet<{ source: string; isLocal: boolean; sources: MarketplaceSourceStatus[]; count: number; plugins: MarketplaceEntry[] }>(`/marketplace/catalog${refresh ? '?refresh=1' : ''}`),
    install: (id: string) => apiPost<{ success: boolean; message?: string; slug: string; updated?: boolean; newPermissions?: string[]; ungrantedPermissions?: string[] }>(`/marketplace/install`, { id }),
    // In-place update of an already-installed plugin (preserves data + tables + grants; gated to the
    // install origin server-side). /install also updates when installed, so this is the explicit alias.
    update: (id: string) => apiPost<{ success: boolean; slug: string; updated: boolean; fromVersion: string | null; toVersion: string | null; newPermissions: string[]; ungrantedPermissions: string[] }>(`/marketplace/update`, { id }),
    // Configurable catalog sources (managed from the Marketplace UI — no hard-coded URL).
    // Saving an EMPTY list disables the remote marketplace; resetSources returns to the official default.
    getSources: () => apiGet<MarketplaceSources>(`/marketplace/sources`),
    setSources: (sources: string[]) => apiPut<MarketplaceSources>(`/marketplace/sources`, { sources }),
    resetSources: () => apiPut<MarketplaceSources>(`/marketplace/sources`, { reset: true }),
};

// Theme marketplace — same system (and the same configurable sources) as the plugin marketplace.
export interface ThemeMarketplaceEntry {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    file: string;
    size: number;
    sha256: string;
    source?: string;
    installed: boolean;
    active: boolean;
    installedVersion: string | null;
    updateAvailable: boolean;
}

export const themesMarketplaceApi = {
    catalog: (refresh = false) =>
        apiGet<{ source: string; isLocal: boolean; sources: MarketplaceSourceStatus[]; count: number; themes: ThemeMarketplaceEntry[] }>(`/marketplace/themes/catalog${refresh ? '?refresh=1' : ''}`),
    install: (id: string) => apiPost<{ success: boolean; message: string; slug: string }>(`/marketplace/themes/install`, { id }),
    // Own source list, independent from the plugin marketplace (option marketplace_theme_sources).
    getSources: () => apiGet<MarketplaceSources>(`/marketplace/themes/sources`),
    setSources: (sources: string[]) => apiPut<MarketplaceSources>(`/marketplace/themes/sources`, { sources }),
    resetSources: () => apiPut<MarketplaceSources>(`/marketplace/themes/sources`, { reset: true }),
};

export interface Theme {
    slug: string;
    name: string;
    version: string;
    description: string;
    author: string;
    screenshot?: string;
    active: boolean;
}

export const themesApi = {
    list: () => apiGet<Theme[]>("/themes"),
    activate: (slug: string) => apiPost(`/themes/${slug}/activate`, {}),
    /**
     * Rewrite all eight files of `themes/default` (theme.json, functions.js, style.css, the two
     * partials and the three templates) from the literals embedded in backend/src/core/themes.ts,
     * bump its version, and drop the memoized theme scan + the public HTML cache. DESTRUCTIVE: this
     * is the one path that clobbers, and any hand edit to those files is overwritten.
     *
     * This is the site's only recovery path when the active theme is gone from disk — boot no longer
     * re-creates the default (createDefaultTheme runs at install and from here, nowhere else), so
     * without this call the `active_theme_missing` state has no way out inside the product. It is the
     * escape hatch the backend names in its own error messages and boot warnings.
     */
    restoreDefault: () => apiPost<{ success: boolean; message: string }>("/themes/default", {}),
    upload: (file: File, onProgress?: (percent: number) => void) => {
        return new Promise<{ success: boolean; message: string; slug: string }>((resolve, reject) => {
            const formData = new FormData();
            formData.append("theme", file);

            const xhr = new XMLHttpRequest();
            xhr.open("POST", `${API_URL}/themes/upload`);
            xhr.withCredentials = true; // Use HttpOnly cookies

            if (onProgress) {
                xhr.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        onProgress((event.loaded / event.total) * 100);
                    }
                };
            }

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    try {
                        const err = JSON.parse(xhr.responseText);
                        reject(new Error(err.error || err.message || "Upload failed"));
                    } catch {
                        reject(new Error("Upload failed"));
                    }
                }
            };

            xhr.onerror = () => reject(new Error("Network error"));
            xhr.send(formData);
        });
    },
    delete: (slug: string) => apiDelete(`/themes/${slug}`),
    download: (slug: string) => {
        const baseUrl = getBaseUrl();
        window.location.href = `${baseUrl}/themes/${slug}/download`;
    },
    /** The page templates a theme ships (templates/*.json), for the per-page template picker. */
    listTemplates: (slug: string) => apiGet<{ slug: string; templates: string[] }>(`/themes/${slug}/templates`),
    /** Download the active theme's customizer mods as a JSON file. Cookie-auth, like download(). */
    exportMods: () => {
        const baseUrl = getBaseUrl();
        window.location.href = `${baseUrl}/themes/mods/export`;
    },
    /** Apply an uploaded customizer-mods file. The backend validates every key/value before writing. */
    importMods: (data: unknown) => apiPost<{ applied: boolean; count: number }>(`/themes/mods/import`, data),
};

// The public settings payload also carries DERIVED, non-string fields (see DERIVED_PUBLIC_SETTINGS in
// backend/src/routes/settings.ts). `get()` keeps its string typing — every other caller reads stored
// options through it — and `getPublicHealth()` reads the same URL with honest types for those.
// active_theme_missing MUST stay a boolean end to end: as a string, `Boolean("false")` is true.
export interface PublicSettingsHealth {
    /** true when the `template` option names a theme that is not installed on disk. */
    active_theme_missing?: boolean;
    /** active theme.json version, '' when there is no active theme. */
    active_theme_version?: string;
    /** slug of the configured active theme, so a warning can name it. */
    template?: string;
}

// The ADMIN settings payload (/settings/all) also carries DERIVED, non-string flags (see
// DERIVED_ADMIN_SETTINGS in backend/src/routes/settings.ts) that must stay boolean end to end.
export interface AdminSettingsHealth extends Record<string, unknown> {
    /** true only while a mail-provider plugin has registered a host-wide sender; when false the core
     *  cannot send email and self-service password recovery is unavailable. */
    email_provider_available?: boolean;
    /** true when kernel hardening was enabled but the bwrap probe failed (OS backstop off). */
    sandbox_hardening_degraded?: boolean;
}

export const settingsApi = {
    get: () => apiGet<Record<string, string>>("/settings"),
    getPublicHealth: () => apiGet<PublicSettingsHealth>("/settings"),
    getAll: () => apiGet<Record<string, string>>("/settings/all"),
    /** Admin payload read with honest boolean typing for the derived health flags. */
    getAdminHealth: () => apiGet<AdminSettingsHealth>("/settings/all"),
    update: (data: Record<string, string>) => apiPut("/settings", data),
};

// Composable chrome (contract v1): the DEDICATED write API — the generic settings writers reject
// site_chrome_* so nothing bypasses the backend validator. Reads travel via settingsApi.get()
// (site_chrome_header / site_chrome_footer are PUBLIC_SETTINGS). A 400 carries the validator's
// errors[] — api() preserves them on the thrown Error for field-level display.
export type ChromePart = "header" | "footer" | "announcement";
export const chromeApi = {
    save: (part: ChromePart, data: unknown) => apiPut<{ part: string; saved: boolean }>(`/chrome/${part}`, { data }),
    reset: (part: ChromePart) => apiDelete<{ part: string; deleted: boolean }>(`/chrome/${part}`),
};

export const rolesApi = {
    list: () => apiGet<Record<string, Role>>("/roles"),
    getCapabilities: () => apiGet<string[]>("/roles/capabilities"),
    save: (slug: string, data: { name: string; capabilities: string[] }) => apiPost<Role>("/roles", { slug, ...data }),
    delete: (slug: string) => apiDelete(`/roles/${slug}`),
};

// Media API
export interface MediaItem {
    id: number;
    title: string;
    guid: string;
    sourceUrl: string;
    mimeType: string;
    date: string;
    mediaDetails?: {
        width: number;
        height: number;
        file: string;
        filesize: number;
        sizes: Record<string, {
            file: string;
            width: number;
            height: number;
            mimeType: string;
            filesize: number;
        }>;
    };
}

/** The query the media list endpoint understands (backend/src/routes/media.ts GET /). */
export interface MediaListOptions {
    page?: number;
    perPage?: number;
    search?: string;
    /** e.g. "image/" or "image/png" — matched server-side against the attachment's MIME type. */
    mimeType?: string;
    orderby?: "date" | "modified" | "title" | "id";
    order?: "asc" | "desc";
}

const mediaListQuery = (opts: MediaListOptions): URLSearchParams => {
    const params = new URLSearchParams();
    params.append("page", String(opts.page || 1));
    params.append("per_page", String(opts.perPage || 20));
    if (opts.search) params.append("search", opts.search);
    if (opts.mimeType) params.append("mime_type", opts.mimeType);
    if (opts.orderby) params.append("orderby", opts.orderby);
    if (opts.order) params.append("order", opts.order);
    return params;
};

export const mediaApi = {
    /**
     * The endpoint has ALWAYS paged (per_page defaults to 20, capped at 100), so the old no-argument
     * `list()` was silently showing only the first page of a library and calling it the whole thing.
     * Left callable with no arguments so existing callers keep working; pass options to page/search.
     */
    list: (opts: MediaListOptions = {}) => apiGet<MediaItem[]>(`/media?${mediaListQuery(opts).toString()}`),
    /**
     * Same query, plus the X-WP-Total / X-WP-TotalPages totals — which `apiGet` throws away, so a pager
     * built on `list()` alone can never know how many items exist. Same shape as postsApi.listPaged.
     * NOTE the totals are visibility-adjusted server-side (attachments of another author's unpublished
     * post are discounted), so `total` is what THIS caller may see, not the raw table count.
     */
    listPaged: (opts: MediaListOptions = {}) => apiGetPaged<MediaItem[]>(`/media?${mediaListQuery(opts).toString()}`),
    upload: (formData: FormData) => api<MediaItem>("/media", {
        method: "POST",
        body: formData,
        headers: {}
    }),
    uploadWithProgress: (formData: FormData, onProgress: (progress: number) => void): Promise<MediaItem> => {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", `${API_URL}/media`);
            xhr.withCredentials = true; // Use HttpOnly cookies

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const percentComplete = (event.loaded / event.total) * 100;
                    onProgress(percentComplete);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const response = JSON.parse(xhr.responseText);
                        resolve(response);
                    } catch {
                        reject(new Error("Invalid JSON response"));
                    }
                } else {
                    reject(new Error(`Upload failed: ${xhr.statusText}`));
                }
            };

            xhr.onerror = () => reject(new Error("Network error"));

            xhr.send(formData);
        });
    },
    /**
     * Edit an attachment's metadata (the "detalles del archivo" panel). Only these four fields are
     * accepted server-side; `alt` is the accessibility text and is stored as post meta, the other
     * three are the attachment post's title/content/excerpt.
     *
     * Authorization is OWNERSHIP-based, not just `upload_files`: editing someone else's media needs
     * `edit_others_posts`, so a 403 `rest_forbidden` here is expected for an author touching another
     * user's upload and should be surfaced as such, not retried.
     */
    update: (id: number, data: { title?: string; description?: string; caption?: string; alt?: string }) =>
        apiPut<MediaItem>(`/media/${id}`, data),
    delete: (id: number) => apiDelete(`/media/${id}`),
};

export const menusApi = {
    list: () => apiGet<Menu[]>("/menus"),
    get: (id: number) => apiGet<Menu>(`/menus/${id}`),
    getByLocation: (location: string) => apiGet<Menu>(`/menus/location/${location}`),
    getLocations: () => apiGet<Record<string, number>>("/menus/locations"),
    create: (data: { name: string; slug?: string; description?: string }) => apiPost<Menu>("/menus", data),
    update: (id: number, data: Partial<Menu>) => apiPut<Menu>(`/menus/${id}`, data),
    delete: (id: number) => apiDelete(`/menus/${id}`),
    // Locations
    setLocation: (id: number, location: string) => apiPost(`/menus/${id}/location`, { location }),
    // Items
    addItem: (menuId: number, data: Partial<MenuItem>) => apiPost<MenuItem>(`/menus/${menuId}/items`, data),
    updateItem: (itemId: number, data: Partial<MenuItem>) => apiPut<MenuItem>(`/menus/items/${itemId}`, data),
    deleteItem: (itemId: number) => apiDelete(`/menus/items/${itemId}`),
};

export interface Widget {
    id: string;
    name: string;
    description: string;
}

export interface Sidebar {
    id: string;
    name: string;
    description: string;
    widgets: string[]; // List of instance keys like "text-k12345"
}

export const widgetsApi = {
    listWidgets: () => apiGet<Widget[]>("/widgets"),
    listSidebars: () => apiGet<Sidebar[]>("/widgets/sidebars"),
    addToSidebar: (sidebarId: string, widgetId: string, settings: any = {}) => apiPost<{ success: boolean; instanceKey: string }>(`/widgets/sidebars/${sidebarId}`, { widgetId, settings }),
    updateInstance: (widgetId: string, instanceId: string, settings: any) => apiPut<{ success: boolean }>(`/widgets/${widgetId}/instances/${instanceId}`, { settings }),
    removeFromSidebar: (sidebarId: string, instanceKey: string) => apiDelete<{ success: boolean }>(`/widgets/sidebars/${sidebarId}/${instanceKey}`),
    reorderSidebar: (sidebarId: string, widgets: string[]) => apiPost<{ success: boolean }>(`/widgets/sidebars/${sidebarId}/reorder`, { widgets }),
    renderSidebar: (sidebarId: string) => api<string>(`/widgets/sidebars/${sidebarId}/render`, { headers: { Accept: "text/html" }, responseType: "text" }),
};

// =============================================================================
// PLUGIN APIs
// =============================================================================
// Plugin-specific types and APIs have been moved to their respective plugins.
// Each plugin now defines its own types and API helpers locally.
// See: plugins/<plugin-name>/client/components/*.tsx
// =============================================================================

// System Health API
export interface SystemStatus {
    database: { status: string; driver: string; message?: string };
    mtls: {
        status: string;
        enabled: boolean;
        cert: string;
        ca: string;
        expiry: string | null;
    };
    filesystem: Record<string, string>;
    timestamp: string;
}

// Backup API
export interface BackupFile {
    filename: string;
    size: number;
    date: string;
}

export const backupsApi = {
    list: () => apiGet<BackupFile[]>("/backups"),
    create: () => apiPost<{ filename: string; size: number; date: string }>("/backups", {}),
    restore: (filename: string) => apiPost<{ success: boolean; results: any }>(`/backups/${filename}/restore`, {}),
    delete: (filename: string) => apiDelete<{ success: boolean }>(`/backups/${filename}`),
    download: (filename: string) => {
        const baseUrl = getBaseUrl();
        window.location.href = `${baseUrl}/backups/${filename}/download`;
    },
};

export const systemApi = {
    getStatus: () => apiGet<SystemStatus>("/health/details"),
};

// WordPress (WXR) import API
export interface WxrAnalysis {
    wxrVersion: string;
    site: { title: string; link: string; description: string; baseUrl: string };
    counts: {
        authors: number; categories: number; tags: number; customTerms: number;
        posts: number; pages: number; attachments: number; navItems: number; other: number; comments: number;
    };
}

export interface ImportSummary {
    site: { title: string; link: string };
    authors: { created: number; matched: number };
    terms: { categories: number; tags: number; custom: number };
    posts: { created: number; skipped: number };
    pages: { created: number; skipped: number };
    attachments: { created: number; skipped: number };
    comments: { created: number; skipped: number };
    navItems: { skipped: number };
    errors: string[];
}

export const importApi = {
    analyze: (file: File) => {
        const fd = new FormData();
        fd.append("file", file);
        return api<{ success: boolean; analysis: WxrAnalysis }>("/import/wordpress/analyze", {
            method: "POST",
            body: fd,
            headers: {}, // let the browser set the multipart boundary
        });
    },
    wordpress: (
        file: File,
        options: { defaultAuthorId?: number; importComments?: boolean; importAttachments?: boolean } = {}
    ) => {
        const fd = new FormData();
        fd.append("file", file);
        if (options.defaultAuthorId) fd.append("defaultAuthorId", String(options.defaultAuthorId));
        fd.append("importComments", options.importComments === false ? "0" : "1");
        fd.append("importAttachments", options.importAttachments ? "1" : "0");
        return api<{ success: boolean; summary: ImportSummary }>("/import/wordpress", {
            method: "POST",
            body: fd,
            headers: {},
        });
    },
};

// ── Scoped API tokens (personal access tokens for headless clients) ────────────────────────────────
export interface ApiToken {
    id: number;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    lastUsedAt: number | null;
    expiresAt: number | null;
    revoked: boolean;
    createdAt: string;
}
export interface ApiTokenCreated {
    id: number;
    token: string; // plaintext — shown once
    tokenPrefix: string;
    name: string;
    scopes: string[];
    expiresAt: number | null;
}
export const tokensApi = {
    list: () => apiGet<{ tokens: ApiToken[] }>("/auth/tokens"),
    create: (data: { name: string; scopes: string; expiresInDays?: number | null }) =>
        apiPost<ApiTokenCreated>("/auth/tokens", data),
    revoke: (id: number) => apiDelete<{ revoked: boolean; id: number }>(`/auth/tokens/${id}`),
};

// ── Outgoing webhooks ──────────────────────────────────────────────────────────────────────────────
export interface Webhook {
    id: number;
    userId: number;
    name: string;
    url: string;
    events: string[];
    secretPrefix: string;
    active: boolean;
    failureCount: number;
    lastDeliveryAt: number | null;
    createdAt: string;
}
export interface WebhookDelivery {
    id: number;
    webhookId: number;
    event: string;
    status: string;
    attempts: number;
    responseStatus: number | null;
    error: string | null;
    nextAttemptAt: number | null;
    deliveredAt: number | null;
    createdAt: string;
    payload?: string;
}
export const webhooksApi = {
    list: () => apiGet<{ webhooks: Webhook[] }>("/webhooks"),
    events: () => apiGet<{ events: string[] }>("/webhooks/events"),
    create: (data: { name?: string; url: string; events?: string[]; active?: boolean }) =>
        apiPost<Webhook & { secret: string; message: string }>("/webhooks", data),
    update: (id: number, data: { name?: string; url?: string; events?: string[]; active?: boolean }) =>
        api<Webhook>(`/webhooks/${id}`, { method: "PATCH", body: data }),
    rotateSecret: (id: number) =>
        apiPost<{ id: number; secret: string; secretPrefix: string; message: string }>(`/webhooks/${id}/rotate-secret`, {}),
    remove: (id: number) => apiDelete<{ deleted: boolean; id: number }>(`/webhooks/${id}`),
    deliveries: (id: number) => apiGet<{ deliveries: WebhookDelivery[] }>(`/webhooks/${id}/deliveries`),
    redeliver: (deliveryId: number) =>
        apiPost<{ requeued: boolean; id: number }>(`/webhooks/deliveries/${deliveryId}/redeliver`, {}),
};

// ── Form submissions (Webflow "Forms + submissions" parity) ────────────────────────────────────────
export interface FormSubmission {
    id: number;
    formName: string;
    pageId: number | null;
    fields: Record<string, string>;
    ip: string;
    userAgent: string;
    createdAt: string;
}
export interface FormName {
    formName: string;
    count: number;
}
export const formsApi = {
    /** Paged list with totals (backend caps per_page at 100; gated on manage_options). */
    listSubmissions: (opts: { formName?: string; page?: number; perPage?: number } = {}) => {
        const params = new URLSearchParams();
        if (opts.formName !== undefined) params.append("formName", opts.formName);
        params.append("page", String(opts.page || 1));
        params.append("per_page", String(opts.perPage || 20));
        return apiGetPaged<FormSubmission[]>(`/forms/submissions?${params.toString()}`);
    },
    /** DISTINCT form names with submission counts (the admin viewer's form picker). */
    names: () => apiGet<{ names: FormName[] }>("/forms/names"),
    removeSubmission: (id: number) =>
        apiDelete<{ deleted: boolean; previous: FormSubmission }>(`/forms/submissions/${id}`),
};

// ── Site export (admin only) ───────────────────────────────────────────────────────────────────────
// GET /export (JSON) and GET /export/wxr (WordPress XML). Both are `authenticate + isAdmin` and both
// answer with Content-Disposition: attachment, so the browser saves the file itself. Same navigation
// trick as themesApi.download / backupsApi.download / themesApi.exportMods: the HttpOnly session
// cookie rides along on a top-level GET, which is exactly why fetch()+blob is NOT used here (it would
// buffer a whole site export in memory for no gain).

/**
 * What GET /export includes. The backend's defaults are INCLUDE for everything except users
 * (`req.query.X !== 'false'`), so only the toggles that differ from the default are sent — and
 * `users` is opt-IN because an export carrying user rows is a different kind of file to hand around.
 */
export interface ExportOptions {
    media?: boolean;
    posts?: boolean;
    pages?: boolean;
    users?: boolean;
    settings?: boolean;
    menus?: boolean;
}

/**
 * The query string for GET /export. Exported so the caller can render a real link (and so the
 * mapping to the backend's include-by-default semantics is testable without a browser).
 */
export function buildExportQuery(opts: ExportOptions = {}): string {
    const params = new URLSearchParams();
    // Include-by-default keys: only say something when the admin asks to LEAVE ONE OUT.
    for (const key of ["media", "posts", "pages", "settings", "menus"] as const) {
        if (opts[key] === false) params.append(key, "false");
    }
    // Opt-in key: only say something when the admin asks to PUT IT IN.
    if (opts.users === true) params.append("users", "true");
    return params.toString();
}

export const exportApi = {
    /** Full site export as JSON (wordjs-export.json). */
    downloadJson: (opts: ExportOptions = {}) => {
        const qs = buildExportQuery(opts);
        window.location.href = `${getBaseUrl()}/export${qs ? `?${qs}` : ""}`;
    },
    /** WordPress-compatible WXR export (wordjs-export.xml). Takes no options server-side. */
    downloadWxr: () => {
        window.location.href = `${getBaseUrl()}/export/wxr`;
    },
};

// ── Audit trail (admin only, read-only) ────────────────────────────────────────────────────────────
// GET /audit is the ONLY route on the append-only audit_log: there is deliberately no write, update
// or delete. Newest first, and the values of a change are never recorded — only which keys changed.
export interface AuditEntry {
    id: number;
    /** the acting user's id, or null for a system/unauthenticated action. */
    actorId: number | null;
    /** stable dotted action name, e.g. "settings.update". */
    action: string;
    targetType: string;
    targetId: string;
    /** sanitized structured context ({} when the row had none) — never raw option values. */
    detail: Record<string, unknown>;
    createdAt: string;
}

export const auditApi = {
    /**
     * A page of audit entries, newest first. The backend clamps per_page to 1..200 (default 50) and
     * page to >= 1. The JSON body already carries `total`, and the same number rides on X-WP-Total —
     * read through apiGetPaged so a pager gets `totalPages` without recomputing it.
     */
    list: (opts: { page?: number; perPage?: number } = {}) => {
        const params = new URLSearchParams();
        params.append("page", String(opts.page || 1));
        params.append("per_page", String(opts.perPage || 50));
        return apiGetPaged<{ entries: AuditEntry[]; total: number; page: number; perPage: number }>(
            `/audit?${params.toString()}`
        );
    },
};

// ── Multi-factor auth (TOTP) ─────────────────────────────────────────────────────────────────────
export interface MfaStatus {
    enabled: boolean;
    backupCodesRemaining: number;
}
// Admin-enforced MFA-by-role policy.
export interface MfaPolicy {
    requiredRoles: string[];
    graceDays: number;
    enforcedAt: number | null;
}
/**
 * Enrolment is SUDO-GATED on the backend (routes/auth.ts): both /auth/mfa/setup — the call that hands
 * out the TOTP secret — and /auth/mfa/enable — the call that actually locks the account — demand the
 * account password, because a hijacked cookie must never be able to bind its own authenticator and lock
 * the owner out. Calling either without `currentPassword` answers 403 `rest_bad_current_password`.
 *
 * Empty passwords are refused HERE, before the network: the backend proves the password through the SAME
 * per-account lockout bucket as /auth/login, so a screen that fired setup() with a blank field would
 * record a failed login attempt and could throttle the user out of their own account. The password must
 * therefore be collected BEFORE setup() is called, not after the QR is on screen.
 */
function requireCurrentPassword(currentPassword: string): string {
    const pw = String(currentPassword || "");
    if (!pw) throw new Error("Your current password is required to change two-factor authentication.");
    return pw;
}
export const mfaApi = {
    status: () => apiGet<MfaStatus>("/auth/mfa/status"),
    // `async` so the empty-password guard REJECTS like every other failure here: a method that throws
    // synchronously for one input and rejects for the rest breaks any caller holding a bare .catch().
    setup: async (currentPassword: string) =>
        apiPost<{ secret: string; otpauthUri: string }>("/auth/mfa/setup", { currentPassword: requireCurrentPassword(currentPassword) }),
    enable: async (code: string, currentPassword: string) =>
        apiPost<{ enabled: boolean; backupCodes: string[]; message: string }>("/auth/mfa/enable", { code, currentPassword: requireCurrentPassword(currentPassword) }),
    disable: (code: string) => apiPost<{ disabled: boolean }>("/auth/mfa/disable", { code }),
    regenerateBackupCodes: (code: string) => apiPost<{ backupCodes: string[]; message: string }>("/auth/mfa/backup-codes", { code }),
    getPolicy: () => apiGet<{ policy: MfaPolicy }>("/auth/mfa/policy"),
    savePolicy: (policy: { requiredRoles: string[]; graceDays: number }) => apiPut<{ policy: MfaPolicy }>("/auth/mfa/policy", policy),
    /**
     * Administrative two-factor reset — the way OUT of a 2FA lockout, and the reason enrolment above can
     * be password-gated without creating an unrecoverable state. It lives under the USERS router
     * (POST /users/:id/mfa/reset), not /auth/mfa/*, because it is account administration: `edit_users`,
     * session-only, never on yourself, and only an administrator may reset a privileged account.
     * Clears every mfa_* key on the target, so they sign in with their password alone and can re-enrol.
     */
    resetForUser: (userId: number) => apiPost<{ reset: boolean; id: number }>(`/users/${userId}/mfa/reset`, {}),
};
