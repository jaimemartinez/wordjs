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
    /**
     * The ACTIVE CORPORATE MAILBOX grant (`user_meta.professional_mailbox`), projected as a plain
     * boolean. It is ADMIN-OWNED: read this field, never re-derive it from `userEmail` (the account
     * itself can write its own email, which would make the grant self-issuable). A row loaded
     * without meta projects `false` (fail-closed).
     */
    hasProfessionalMailbox: boolean;
}

/** Metadata for a file uploaded through a `{ multipart: '<field>' }` route. */
export interface WordJSUploadedFile {
    /** Absolute path of the host's temp file. It is unlinked once the response completes — read it inside your handler. */
    path: string;
    originalname: string;
    mimetype: string;
    size: number;
    filename: string;
}

/** The authenticated identity forwarded to a `{ auth: true }` route. Rebuilt per request. */
export interface WordJSRouteUser {
    id: number | string;
    role: string;
    userEmail: string;
    userLogin: string;
    /** Same admin-owned grant as {@link WordJSSafeUser.hasProfessionalMailbox} — gate on this, don't re-derive it. */
    hasProfessionalMailbox: boolean;
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
    /**
     * A stable, privacy-preserving per-client key (HMAC of the caller's IP with a per-install secret)
     * so you can rate-limit or dedup by caller WITHOUT ever seeing the raw IP. `''` when no IP.
     */
    clientKey: string;
    /** Request cookies, with the host's auth/session cookies (e.g. `wordjs_token`) always stripped. */
    cookies: Record<string, string>;
    /** Only selected non-sensitive headers are forwarded — today that is `x-portal-token` alone. */
    headers: { 'x-portal-token'?: string };
    /** The authenticated user for a `{ auth: true }` route; `null` when the request is anonymous. */
    user: WordJSRouteUser | null;
    /** Present when the route was registered with `{ multipart: '<field>' }` — saved file metadata. */
    file?: WordJSUploadedFile;
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
     * Which sidebar block the item lands in: 'management' puts it in the lower (Settings/Users…)
     * group, anything else — the default 'core' — puts it in the upper one.
     */
    section?: 'core' | 'management';
    /**
     * When true, core hides this item from any user who does not hold the professional-mailbox
     * grant. Use it for per-user features that are empty without one — e.g. a webmail inbox.
     * Administrators always see it.
     *
     * The grant is the ADMIN-OWNED `user_meta.professional_mailbox` flag, the same one a mail
     * plugin's route gate reads, so the menu can never show a page that will only 403. It is
     * deliberately NOT derived from the account's email domain: the account writes its own email,
     * which made the old rule self-grantable. Slug-agnostic — any plugin may set it.
     */
    requiresProfessionalMailbox?: boolean;
    [key: string]: any;
}

/** Active SQL dialect info so a plugin can branch its DDL. */
export interface WordJSDbType {
    isPostgres: boolean;
    /** True for both the 'mysql' and 'mariadb' drivers. */
    isMySQL: boolean;
    /**
     * True for everything that is NOT Postgres — including MySQL, whose driver translates the
     * SQLite dialect at the boundary. Gate genuinely SQLite-only queries (`PRAGMA`, `sqlite_master`)
     * on `isMySQL` being false, not on this flag alone.
     */
    isSQLite: boolean;
    /** Full driver name: 'sqlite-native' | 'sqlite-legacy' | 'postgres' | 'mysql' | 'mariadb'. */
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
     * (run/createTable); `batch` needs whichever of the two each of its statements implies.
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
        /**
         * Run up to 200 statements — each a bare `sql` string or an `[sql, params]` pair — in ONE
         * host round-trip, returning one result per statement in order (a SELECT/WITH yields the
         * `all()` row array).
         *
         * A transport optimisation, NOT a new capability: every statement is re-checked with the
         * same permission (`database:read` for select/with, `database:write` otherwise) and the same
         * SQL guard its single-statement counterpart would use. DDL (CREATE/ALTER/DROP) is refused —
         * use `run`/`createTable`, which record table ownership and grant the new table.
         *
         * The whole array is validated before anything runs, but it is NOT a transaction: if a
         * statement throws, the ones ahead of it have already applied.
         */
        batch(statements: (string | [string, any[]?])[]): Promise<any[]>;
        /** Create a table named with `tablePrefix`. Permission: `database:write`. */
        createTable(name: string, columns: string[]): Promise<any>;
        /** Which SQL dialect is active. Permission: `database:read`. */
        getType(): Promise<WordJSDbType>;
    };

    /**
     * CSPRNG bridge. The static validator blocks `crypto` / `globalThis` in plugin CODE, so this is
     * where a plugin gets UNGUESSABLE tokens and codes — never `Math.random`, whose state is
     * reconstructable from a few outputs. No permission required (no data access).
     */
    crypto: {
        /** Hex token of `bytes` random bytes; `bytes` is clamped to 8..64 (default 16). */
        randomToken(bytes?: number): Promise<string>;
        /** Uniform integer in `[min, max)`. Throws on a non-finite, empty or >1e9-wide range. */
        randomInt(min: number, max: number): Promise<number>;
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
     * Schedule a cron event; the host fires the hook back into this child process (only YOUR
     * callbacks, never core's). No permission required.
     *
     * `recurrence` is one of the registered schedules — 'hourly', 'twicedaily', 'daily', 'weekly',
     * 'off' — and an unregistered name is stored with a 0 interval, i.e. it never repeats. Pass a
     * falsy `recurrence` (`false`) for a one-off event at `timestamp`.
     */
    cron: {
        schedule(timestamp: number, recurrence: string | false, hook: string, args?: any[]): Promise<any>;
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
     * Host-mediated DNS record lookups. Gated on the `network` grant — the same grant that opens the
     * socket modules, not a separate scope.
     *
     * The raw c-ares resolver (`dns.resolve*` / `Resolver` / `setServers`) is DENIED inside the
     * isolate because it bypasses egress filtering, and the one resolver left (`dns.lookup`) can only
     * do A/AAAA — so MX (direct-to-MX delivery) and TXT (SPF/DKIM/DMARC) queries come through here.
     * The host runs them with the system resolver and STRIPS every address answer pointing at a
     * private/internal/special IP, so `resolve4`/`resolve6`/`resolve` return PUBLIC addresses only
     * and a host that resolves solely to internal IPs comes back as an empty array.
     */
    dns: {
        resolveMx(domain: string): Promise<{ priority: number; exchange: string }[]>;
        resolveTxt(name: string): Promise<string[][]>;
        resolve4(host: string): Promise<string[]>;
        resolve6(host: string): Promise<string[]>;
        /** Like Node's `dns.promises.resolve()` with no rrtype: A records (string IPs). */
        resolve(host: string): Promise<string[]>;
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
