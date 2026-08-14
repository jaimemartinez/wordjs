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

// Typed API calls
export interface Post {
    id: number;
    title: string;
    slug: string;
    content: string;
    excerpt: string;
    status: string;
    type: string;
    date: string;
    author: { id: number; displayName: string };
    commentStatus: string;
    meta?: Record<string, any>;
    /** Set when the post has a featured image (backend Post.toJSON serializes it with an absolute URL). */
    featuredMedia?: { id: number; url: string; title?: string };
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
}

// API endpoints
export const postsApi = {
    /** Paged list with totals (backend caps per_page at 100; status 'any' is privilege-scoped server-side). */
    listPaged: (opts: { type?: string; status?: string; page?: number; perPage?: number; search?: string } = {}) => {
        const params = new URLSearchParams({ type: opts.type || "post" });
        if (opts.status) params.append("status", opts.status);
        params.append("page", String(opts.page || 1));
        params.append("per_page", String(opts.perPage || 20));
        if (opts.search) params.append("search", opts.search);
        return apiGetPaged<Post[]>(`/posts?${params.toString()}`);
    },
    list: (type = "post", status?: string) => {
        const params = new URLSearchParams({ type });
        if (status) params.append("status", status);
        return apiGet<Post[]>(`/posts?${params.toString()}`);
    },
    get: (id: number) => apiGet<Post>(`/posts/${id}`),
    getBySlug: (slug: string) => apiGet<Post>(`/posts/slug/${slug}`), // New method
    create: (data: Partial<Post>) => apiPost<Post>("/posts", data),
    update: (id: number, data: Partial<Post>) => apiPut<Post>(`/posts/${id}`, data),
    delete: (id: number) => apiDelete(`/posts/${id}`),
};

export const categoriesApi = {
    list: () => apiGet<Category[]>("/categories"),
    create: (data: { name: string; slug?: string }) => apiPost<Category>("/categories", data),
    delete: (id: number) => apiDelete(`/categories/${id}`),
};

export const usersApi = {
    list: () => apiGet<User[]>("/users"),
    get: (id: number) => apiGet<User>(`/users/${id}`),
    create: (data: Partial<User> & { password: string }) => apiPost<User>("/users", data),
    update: (id: number, data: Partial<User>) => apiPut<User>(`/users/${id}`, data),
    // Self-service update for the logged-in user (any role). Changing the password requires currentPassword.
    updateMe: (data: { displayName?: string; personalEmail?: string; password?: string; currentPassword?: string }) =>
        apiPut<User>("/users/me", data),
    delete: (id: number) => apiDelete(`/users/${id}`),
};

// Public password-recovery endpoints (unauthenticated). Available only when the mail server is active
// and its DNS is fully verified — the login page probes `passwordResetAvailable` before offering it.
export const authApi = {
    passwordResetAvailable: () => apiGet<{ available: boolean }>("/auth/password-reset-available"),
    forgotPassword: (login: string) => apiPost<{ ok: boolean; message: string }>("/auth/forgot-password", { login }),
    resetPassword: (data: { uid: number; token: string; password: string }) =>
        apiPost<{ ok: boolean; message: string }>("/auth/reset-password", data),
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
    hasPuckBlock: boolean;
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

export const settingsApi = {
    get: () => apiGet<Record<string, string>>("/settings"),
    getPublicHealth: () => apiGet<PublicSettingsHealth>("/settings"),
    getAll: () => apiGet<Record<string, string>>("/settings/all"),
    update: (data: Record<string, string>) => apiPut("/settings", data),
};

// Composable chrome (contract v1): the DEDICATED write API — the generic settings writers reject
// site_chrome_* so nothing bypasses the backend validator. Reads travel via settingsApi.get()
// (site_chrome_header / site_chrome_footer are PUBLIC_SETTINGS). A 400 carries the validator's
// errors[] — api() preserves them on the thrown Error for field-level display.
export type ChromePart = "header" | "footer";
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

export const mediaApi = {
    list: () => apiGet<MediaItem[]>("/media"),
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
export const mfaApi = {
    status: () => apiGet<MfaStatus>("/auth/mfa/status"),
    setup: () => apiPost<{ secret: string; otpauthUri: string }>("/auth/mfa/setup", {}),
    enable: (code: string) => apiPost<{ enabled: boolean; backupCodes: string[]; message: string }>("/auth/mfa/enable", { code }),
    disable: (code: string) => apiPost<{ disabled: boolean }>("/auth/mfa/disable", { code }),
    regenerateBackupCodes: (code: string) => apiPost<{ backupCodes: string[]; message: string }>("/auth/mfa/backup-codes", { code }),
    getPolicy: () => apiGet<{ policy: MfaPolicy }>("/auth/mfa/policy"),
    savePolicy: (policy: { requiredRoles: string[]; graceDays: number }) => apiPut<{ policy: MfaPolicy }>("/auth/mfa/policy", policy),
};
