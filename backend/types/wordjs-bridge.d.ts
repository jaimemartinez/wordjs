/**
 * WordJS plugin capability bridge — hand-written type definitions.
 *
 * These types describe the `wordjs` object the sandbox injects into every isolated plugin's
 * `exports.init(wordjs)` (built in backend/src/core/plugin-worker.js). Every data method is
 * ASYNC: it crosses the child→host IPC boundary and is permission-checked on the host against
 * the capabilities your manifest DECLARES **and** the admin has GRANTED (default-deny — see
 * documentation/plugins.md §11–12).
 *
 * Plain-JS plugins get IntelliSense from this file via JSDoc — no TypeScript required.
 * In your plugin's index.js (path is relative to backend/plugins/<slug>/):
 *
 *   // @typedef {import('../../types/wordjs-bridge').WordJS} WordJS   (as a JSDoc typedef)
 *   // @param {WordJS} wordjs                                          (on exports.init)
 */

/**
 * The SAFE user projection returned by the `users` bridge. Never includes `user_pass`
 * or any other credential field — this is the only way plugins can read users.
 */
export interface WordJSSafeUser {
    id: number | string;
    userLogin: string;
    username?: string;
    userEmail: string;
    displayName?: string;
    role: string;
}

/**
 * The request object your route handler receives. It is a plain serialized snapshot
 * forwarded over RPC from the host's real Express request — NOT a live Express `req`.
 */
export interface WordJSRouteRequest {
    method: string;
    path: string;
    query: Record<string, any>;
    params: Record<string, string>;
    body: any;
    /** Present when the route was registered with `{ auth: true }` — the authenticated user. */
    user?: any;
    /** Present when the route was registered with `{ multipart: '<field>' }` — saved file metadata. */
    file?: any;
    [key: string]: any;
}

/**
 * The response mock your route handler receives. Calls are recorded in the child process and
 * replayed on the host's real Express response when you settle with json()/send()/end().
 */
export interface WordJSRouteResponse {
    /** Set the HTTP status code (chainable). */
    status(code: number): this;
    /** Set response headers (chainable, merged). */
    set(headers: Record<string, string>): this;
    /** Record a cookie; the host replays res.cookie() on the real response (chainable). */
    cookie(name: string, value: string, options?: Record<string, any>): this;
    /** Record a cookie removal; replayed as res.clearCookie() on the host (chainable). */
    clearCookie(name: string, options?: Record<string, any>): this;
    /** Send a JSON body and settle the request. */
    json(body: any): this;
    /** Send a body and settle the request. */
    send(body: any): this;
    /** Settle the request with no body. */
    end(): this;
}

export type WordJSRouteHandler = (
    req: WordJSRouteRequest,
    res: WordJSRouteResponse
) => void | Promise<void>;

/** Options for `wordjs.http.route`. The host applies the REAL auth middleware before forwarding. */
export interface WordJSRouteOptions {
    /** Require a valid authenticated session (host-side `authenticate` middleware). */
    auth?: boolean;
    /** Additionally require an administrator (host-side `isAdmin` middleware). */
    admin?: boolean;
    /** Accept a single multipart file upload; the value is the form field name. */
    multipart?: string;
}

/** A sidebar entry for the admin panel (declarative — rendered by the admin frontend). */
export interface WordJSAdminMenuItem {
    /** Admin route to open, e.g. '/admin/plugin/<your-adminPage-slug>'. */
    href: string;
    label: string;
    /** Font Awesome icon class, e.g. 'fa-puzzle-piece'. */
    icon?: string;
    /** Sort order among sidebar items. */
    order?: number;
    /** Capability required to see the item. */
    cap?: string;
    /**
     * When true, core hides this item from any user who does NOT own a professional mailbox on the
     * site domain (their account email is not `@<site-domain>`). Use it for per-user features that are
     * empty/meaningless without such a mailbox — e.g. a webmail inbox. Administrators always see it.
     */
    requiresProfessionalMailbox?: boolean;
    [key: string]: any;
}

/** Active SQL dialect info so a plugin can branch its DDL. */
export interface WordJSDbType {
    isPostgres: boolean;
    isSQLite: boolean;
    /** Full driver name: 'sqlite-native' | 'sqlite-legacy' | 'postgres'. */
    driver: string;
}

export interface WordJSMailMessage {
    to: string;
    subject: string;
    text?: string;
    html?: string;
    [key: string]: any;
}

export interface WordJSNotification {
    type?: string;
    title?: string;
    message?: string;
    [key: string]: any;
}

/** `wordjs.notify` is callable AND carries `registerTransport`. */
export interface WordJSNotify {
    /**
     * Push an admin notification.
     * Permission: `notifications:send`.
     */
    (notification: WordJSNotification): Promise<any>;
    /**
     * Register a notification transport (e.g. 'email') whose handler lives in this isolate.
     * Permission: `notifications:provider`.
     */
    registerTransport(
        name: string,
        handler: (notification: WordJSNotification) => any | Promise<any>
    ): void;
}

/**
 * The injected capability bridge. Destructure what you need in `init`:
 *   `const { options, http, adminMenu } = wordjs;`
 */
export interface WordJS {
    /** Your plugin's slug (the folder / manifest id). */
    slug: string;

    /**
     * Site options (key/value). Keys are GLOBAL — always prefix yours with your slug
     * (e.g. `myplugin_items`) so they can't collide with core or other plugins.
     * Secret-named keys (`*secret*`, `*password*`, `*key*`, `*token*`, `dkim`, certs…)
     * are NEVER readable or writable by any plugin.
     * Permissions: `settings:read` for get, `settings:write` for set.
     */
    options: {
        get<T = any>(key: string, defaultValue?: T): Promise<T>;
        set(key: string, value: any): Promise<any>;
    };

    /**
     * Database access, ALWAYS scoped to your own `wjp_<slug>_` tables (host-enforced).
     * SQL referencing core tables (users/options/sessions/…) is rejected; there is no
     * unscoped mode. Permissions: `database:read` (all/get/getType), `database:write`
     * (run/createTable).
     */
    db: {
        /** The prefix your table names MUST start with, e.g. 'wjp_my_plugin_'. */
        tablePrefix: string;
        /** SELECT/WITH query returning all rows. Permission: `database:read`. */
        all(sql: string, params?: any[]): Promise<any[]>;
        /** SELECT/WITH query returning the first row. Permission: `database:read`. */
        get(sql: string, params?: any[]): Promise<any>;
        /** INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/REPLACE. Permission: `database:write`. */
        run(sql: string, params?: any[]): Promise<any>;
        /** Create a table named with `tablePrefix`. Permission: `database:write`. */
        createTable(name: string, columns: string[]): Promise<any>;
        /** Which SQL dialect is active. Permission: `database:read`. */
        getType(): Promise<WordJSDbType>;
    };

    /**
     * Actions & filters. Your callback runs in THIS child process; the host installs an RPC
     * shim. Raw-HTML hooks (`wordjs_head` / `wordjs_footer`) are denied to every plugin.
     * No permission required to register; `doAction` can only fire your OWN hooks.
     */
    hooks: {
        addAction(hook: string, cb: (...args: any[]) => any, priority?: number): void;
        addFilter(hook: string, cb: (...args: any[]) => any, priority?: number): void;
        doAction(hook: string, ...args: any[]): Promise<any>;
    };

    /**
     * File access confined to your OWN plugin directory only (realpath-checked); the shared
     * `uploads/` dir is unreachable and `manifest.json` is immutable.
     * Permissions: `filesystem:read` / `filesystem:write`.
     */
    fs: {
        read(relPath: string, encoding?: string): Promise<any>;
        write(relPath: string, data: any): Promise<any>;
    };

    /**
     * Send an email via the active mail provider.
     * Permission: `email:admin`.
     */
    mail(msg: WordJSMailMessage): Promise<any>;

    /**
     * Become the host-wide mail sender: the host installs a shim that RPCs back into this
     * isolate whenever anything sends mail.
     * Permission: `email:provider`.
     */
    provideMail(handler: (msg: WordJSMailMessage) => any | Promise<any>): void;

    /** Admin notifications (callable) + transport registration. See {@link WordJSNotify}. */
    notify: WordJSNotify;

    /** Declarative admin sidebar entry. No permission required. */
    adminMenu: {
        add(item: WordJSAdminMenuItem): Promise<any>;
    };

    /**
     * Schedule a cron event; the host fires the hook back into this child process.
     * No permission required.
     */
    cron: {
        schedule(timestamp: number, recurrence: string, hook: string, args?: any[]): Promise<any>;
    };

    /**
     * SAFE user lookups. Return the {@link WordJSSafeUser} projection only — never
     * `user_pass` or other credential fields. The sanctioned way to read users without
     * core-table access. Permission: `users:read`.
     */
    users: {
        findByEmail(email: string): Promise<WordJSSafeUser | null>;
        findByLogin(login: string): Promise<WordJSSafeUser | null>;
        findById(id: number | string): Promise<WordJSSafeUser | null>;
        search(term: string, limit?: number): Promise<WordJSSafeUser[]>;
    };

    /**
     * Read-only site identity. Permission: `settings:read`.
     */
    site: {
        url(): Promise<string>;
        domain(): Promise<string>;
        adminEmail(): Promise<string>;
    };

    /**
     * Register a JSON route, ALWAYS mounted at `/api/v1/plugin/<slug><path>` (namespaced —
     * no absolute mode). With `opts` the host runs the real auth middleware before
     * forwarding; your handler runs HERE with a serialized (req, res) over RPC.
     * No permission required to register.
     */
    http: {
        route(method: string, path: string, handler: WordJSRouteHandler): void;
        route(method: string, path: string, opts: WordJSRouteOptions, handler: WordJSRouteHandler): void;
    };

    /**
     * Register a shortcode. The handler may be async and use the bridge; it returns the HTML
     * string and is expanded host-side via doShortcodeAsync. No permission required.
     */
    shortcodes: {
        add(
            tag: string,
            handler: (attrs: Record<string, any>, content: string, tag: string) => string | Promise<string>
        ): void;
    };

    /**
     * Load a script/style from INSIDE your plugin dir onto public pages. Requires the `assets` grant.
     * `src` is a path relative to your plugin (served from /plugins/<slug>/); external URLs and '..'
     * are rejected. The host emits sanitized <script src>/<link rel=stylesheet> — you never control markup.
     */
    assets: {
        enqueueScript(spec: { handle: string; src: string; inFooter?: boolean; strategy?: 'async' | 'defer' }): Promise<{ success: true; src: string }>;
        enqueueStyle(spec: { handle: string; src: string; media?: string }): Promise<{ success: true; src: string }>;
    };
}

/** The module shape an isolated plugin's index.js must export. */
export interface WordJSPluginModule {
    metadata?: {
        name: string;
        version?: string;
        description?: string;
        author?: string;
        [key: string]: any;
    };
    /** Called when the plugin is (hot-)loaded, with the injected capability bridge. */
    init(wordjs: WordJS): void | Promise<void>;
    /** Called when the plugin is deactivated. */
    deactivate?(): void | Promise<void>;
}
