/**
 * Loading the plugin menu (GET /plugins/menus) for the admin shell — pure logic, no React.
 *
 * The admin layout's route guard (lib/adminAccess.ts) opens /admin/plugin/<slug> only through a menu item
 * of the signed-in user, so the plugin menu is no longer cosmetic: a STALE or FAILED load would send a
 * plugin team member away from their own screen. Two rules follow:
 *
 *   · The menu belongs to an IDENTITY — who is signed in, with which role, and whether they are blocked
 *     by enforced two-factor enrolment (the API answers 403 to everything but enrolment then). It is
 *     loaded for that identity and loaded AGAIN whenever it changes: after enrolling, after a role change,
 *     after signing in as someone else (menuLoadKey).
 *   · A failed load is not an empty menu. It is retried a couple of times; only then does the guard decide
 *     with what it has (MenuLoader).
 */

export interface MenuLoadUser {
    id?: number | string | null;
    role?: string | null;
    mfa?: { enforced?: boolean | null; enabled?: boolean | null } | null;
}

/** Is this user held at the two-factor enrolment screen (the backend refuses every other call)? */
export const isMfaBlocked = (user: MenuLoadUser | null | undefined): boolean =>
    !!(user && user.mfa && user.mfa.enforced && !user.mfa.enabled);

/**
 * The identity the plugin menu is loaded for, or null when it must not be loaded: while the session is
 * still being resolved, when nobody is signed in, and while the user is held at enrolment (the request
 * would only answer 403). A new key means a new load.
 */
export function menuLoadKey(user: MenuLoadUser | null | undefined, authLoading: boolean): string | null {
    if (authLoading || !user || user.id == null) return null;
    if (isMfaBlocked(user)) return null;
    return `${user.id}|${user.role ?? ""}`;
}

/** Delays before each retry of a failed load; after the last one the menu counts as loaded (empty). */
export const MENU_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1000, 3000]);

export interface MenuLoadState<T> {
    /** The identity these menus were loaded for (null = none). */
    key: string | null;
    menus: T[];
    /** The load for `key` is over — it succeeded, or every retry failed. */
    loaded: boolean;
    /** Every attempt failed (the guard then decides with an empty menu: the account page is the floor). */
    failed: boolean;
}

export interface MenuLoaderOptions<T> {
    fetchMenus: () => Promise<T[] | null | undefined>;
    onChange: (state: MenuLoadState<T>) => void;
    /** A failure that is an expected end state (the session ended): no retry, no report. */
    isTerminal?: (error: unknown) => boolean;
    onError?: (error: unknown) => void;
    retryDelaysMs?: readonly number[];
    schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
};

/**
 * Loads the menu for the current key; a key change abandons whatever was in flight for the old one (its
 * answer is ignored) and starts again. `refresh()` reloads for the current key (after a plugin was
 * activated, say).
 */
export class MenuLoader<T> {
    private key: string | null = null;
    private started = false;
    private generation = 0;
    private pendingRetry: { cancel: () => void; resolve: () => void } | null = null;
    private state: MenuLoadState<T> = { key: null, menus: [], loaded: false, failed: false };

    constructor(private readonly opts: MenuLoaderOptions<T>) {}

    getState(): MenuLoadState<T> {
        return this.state;
    }

    /** Load for this identity — unless it is the one already loaded / loading. */
    setKey(key: string | null): Promise<void> {
        if (this.started && key === this.key) return Promise.resolve();
        this.started = true;
        this.key = key;
        return this.load();
    }

    /** Load again for the current identity. */
    refresh(): Promise<void> {
        this.started = true;
        return this.load();
    }

    /** Abandon whatever is in flight (its answer is ignored) and any pending retry. */
    dispose(): void {
        this.generation++;
        const pending = this.pendingRetry;
        this.pendingRetry = null;
        if (pending) { pending.cancel(); pending.resolve(); }
    }

    private emit(next: MenuLoadState<T>): void {
        this.state = next;
        this.opts.onChange(next);
    }

    private load(): Promise<void> {
        this.dispose();
        const generation = this.generation;
        const key = this.key;
        if (key === null) {
            this.emit({ key: null, menus: [], loaded: false, failed: false });
            return Promise.resolve();
        }
        // Keep showing what we have while reloading for the SAME identity; a new identity starts empty.
        const same = this.state.key === key;
        this.emit({ key, menus: same ? this.state.menus : [], loaded: same && this.state.loaded, failed: false });
        return this.attempt(generation, key, 0);
    }

    private async attempt(generation: number, key: string, tries: number): Promise<void> {
        let menus: T[] | null | undefined;
        try {
            menus = await this.opts.fetchMenus();
        } catch (error) {
            if (generation !== this.generation) return;
            const delays = this.opts.retryDelaysMs ?? MENU_RETRY_DELAYS_MS;
            const terminal = this.opts.isTerminal ? this.opts.isTerminal(error) : false;
            if (!terminal && this.opts.onError) this.opts.onError(error);
            if (terminal || tries >= delays.length) {
                this.emit({ key, menus: [], loaded: true, failed: true });
                return;
            }
            await new Promise<void>((resolve) => {
                const schedule = this.opts.schedule ?? defaultSchedule;
                const cancel = schedule(() => { this.pendingRetry = null; resolve(); }, delays[tries]);
                this.pendingRetry = { cancel, resolve };
            });
            if (generation !== this.generation) return;
            return this.attempt(generation, key, tries + 1);
        }
        if (generation !== this.generation) return; // a newer load (or a new identity) took over
        this.emit({ key, menus: Array.isArray(menus) ? menus : [], loaded: true, failed: false });
    }
}
