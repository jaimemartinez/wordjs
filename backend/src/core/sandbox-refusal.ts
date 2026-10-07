/**
 * WordJS - the plugin sandbox's REFUSAL, as a typed error a route can answer truthfully.
 *
 * WHY THIS EXISTS. When the fail-closed policy (`sandbox.requireHardening`, on by default) refuses to
 * start an isolated plugin because the native sandbox is not there, the refusal is CORRECT - and it
 * used to reach the administrator as `500 rest_internal_error`, "The server encountered an internal
 * error". That is the incident this module answers: a Linux host whose service ran as an unprivileged
 * user with `AmbientCapabilities=CAP_NET_BIND_SERVICE` had its Landlock/seccomp shim die on
 * `SHIM-FAIL: setgroups(clear): Operation not permitted`; the probe went 'degraded'; every activation was
 * refused; and the admin screen said "failed" with nothing to act on. The diagnosis existed - in the
 * server log and in GET /health/details - and the one surface the admin was looking at withheld it.
 *
 * So a refusal is a 409 (the request is fine; the SERVER is in a state that cannot honour it) with a
 * STABLE machine-readable code, `sandbox_unavailable`, and a human reason that says which sandbox, what
 * failed, and what the operator should do. The admin UI keys on the code, never on the wording.
 *
 * WHAT THE REASON MAY CONTAIN. Exactly what an administrator already sees on GET /health/details: the
 * mechanism, its state, and the probe's one-line verdict. Never a filesystem path: a SHIM-FAIL line
 * can name the zone or read root that would not grant (an install path), an AppContainer grant failure
 * names the directories it tried, and those belong in the server log, which keeps the full text.
 * operatorSafeText() is the one place that rule is applied.
 *
 * NOT FORGEABLE BY A PLUGIN. Everything that becomes a SandboxUnavailableError is decided host-side,
 * from the launcher's own state or from output produced BEFORE the plugin could have run (see
 * classifyShimLaunchFailure in core/sandbox-linux.ts). A plugin's own init error crosses IPC as a
 * string and becomes a plain Error, so no plugin can make its failure render as "the sandbox is broken"
 * - the one message that would invite an administrator to switch the sandbox off.
 */

const SANDBOX_UNAVAILABLE = 'sandbox_unavailable';

export type SandboxRefusalDetails = {
    /** 'landlock' | 'appcontainer' | 'seatbelt' | 'none' — the native mechanism of this platform. */
    mechanism: string;
    /** The probe state the launcher acted on ('degraded', 'unsupported', 'disabled', … or 'active' when a certified launch itself failed). */
    state: string;
    /** One sentence: what failed. Path-free. */
    reason: string;
    /** The launcher's own failure line (e.g. `SHIM-FAIL: …`), path-free, when there is one. */
    failure: string | null;
    /** What the operator can do about it. */
    action: string;
};

class SandboxUnavailableError extends Error {
    code: string;
    /** Read by middleware/errorHandler when the error is thrown raw: a deliberate status renders as the contract. */
    status: number;
    sandbox: SandboxRefusalDetails;
    /**
     * What middleware/errorHandler forwards of a deliberate error it renders - it passes `err.details`
     * through and nothing else. Without this, a route that let the refusal propagate (POST /:slug/reload
     * did) answered 409 `sandbox_unavailable` with NO `details.sandbox`: no failure line, no action, and
     * the admin UI fell back to "unknown". The routes answer it themselves with sandboxRefusalBody();
     * this keeps any path that does not on the same contract.
     */
    details: { sandbox: SandboxRefusalDetails };
    constructor(slug: string, details: SandboxRefusalDetails, opts?: { cause?: unknown }) {
        super(`Plugin '${slug}' was not started: the plugin sandbox could not confine it. ${details.reason}`, opts && opts.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = 'SandboxUnavailableError';
        this.code = SANDBOX_UNAVAILABLE;
        this.status = 409;
        this.sandbox = details;
        this.details = { sandbox: details };
    }
}

/**
 * The ONE 409 body for a refusal, for every route that answers it: activation, reload, the grant and
 * egress changes that restart the plugin, and the marketplace update's reactivation. `extra` carries
 * what that route must add (what was saved, what is now stopped) - never a different shape for the
 * refusal itself, which the admin UI reads by `code` and `details.sandbox`.
 */
function sandboxRefusalBody(refusal: SandboxUnavailableError, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const message = typeof extra.message === 'string' ? extra.message : refusal.message;
    return {
        ...extra,
        code: refusal.code,
        message,
        error: message,
        data: { status: 409 },
        details: { sandbox: refusal.sandbox },
    };
}

/**
 * Make a launcher message safe to put in front of a client: control characters become spaces, and every
 * absolute filesystem path (POSIX, drive-letter or UNC) becomes `<path>`. The full, unredacted text
 * stays in the server log at the site that wrote it.
 *
 * A code-point scan instead of a control-character regex, for the reason sandbox-linux.ts gives: the
 * lint bans control characters in a regex literal, and an editor silently mangles them.
 */
function operatorSafeText(raw: unknown, max = 240, opts: { keepPaths?: boolean } = {}): string {
    let s = '';
    for (const ch of String(raw == null ? '' : raw)) {
        const c = ch.charCodeAt(0);
        s += (c < 0x20 || c === 0x7f) ? ' ' : ch;
    }
    if (!opts.keepPaths) s = redactPaths(s);
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Replace every absolute path with `<path>`.
 *
 * A PATH RUNS TO A DELIMITER, NOT TO THE NEXT SPACE. Paths contain spaces - `C:\Program Files\nodejs`,
 * `C:\Users\Jane Doe\sites\acme`, `/srv/My Site/backend` - and stopping at the first one handed the rest
 * to the client (`<path> Doe\sites\acme`), which is the part that names a person or a site. So a path
 * ends only at `,` `;` a quote or backtick, a bracket, `: ` (`/usr/bin/perl: not found`), `. ` (the end
 * of a sentence) or the end of the text; trailing spaces and a final full stop are given back. The cost
 * runs in the safe direction: a word that follows a path with no delimiter in between (`spawn /x
 * ENOENT`) is redacted with it.
 *
 * A path STARTS only after a separator (start of text, space, quote, backtick, `(`, `[`, `=`, `,`, `:`),
 * so ratios and option values that merely contain a slash (`landlock=abi8/19`) are left alone; a lone
 * `/` is not a path worth hiding.
 */
function redactPaths(s: string): string {
    const PREFIX = ' \'"`([=,:';
    const STOP = ',;\'"`()[]';
    const startsPath = (i: number): boolean => {
        if (i > 0 && !PREFIX.includes(s[i - 1])) return false;
        if (s[i] === '/') return i + 1 < s.length && s[i + 1] !== ' ' && s[i + 1] !== '/';
        if (s[i] === '\\') return s[i + 1] === '\\';
        return /[A-Za-z]/.test(s[i]) && s[i + 1] === ':' && (s[i + 2] === '\\' || s[i + 2] === '/');
    };
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (!startsPath(i)) { out += s[i++]; continue; }
        let j = i + 1;
        while (j < s.length && !STOP.includes(s[j])
            && !((s[j] === ':' || s[j] === '.') && (j + 1 === s.length || s[j + 1] === ' '))) j++;
        let k = j;
        while (k > i + 1 && (s[k - 1] === ' ' || s[k - 1] === '.')) k--;
        out += `<path>${s.slice(k, j)}`;
        i = j;
    }
    return out;
}

/**
 * The failed steps that mean "the shim could not shed the service's own privilege". Matching is on the
 * shim's fixed wording (backend/scripts/landlock-seccomp-shim.pl), which is why it lives beside the
 * code that reports it rather than being re-derived by every reader.
 */
const PRIVILEGE_DROP_STEP = /setgroups\(clear\)|SECUREBITS|CAPBSET_DROP|AMBIENT_CLEAR_ALL|capset\(clear\)|setresuid\(|privilege drop|did not collapse onto the effective uid/;
function isPrivilegeDropFailure(line: unknown): boolean {
    return typeof line === 'string' && PRIVILEGE_DROP_STEP.test(line);
}

/** What to do about it — one paragraph, per mechanism and state, never "turn the sandbox off" first. */
function sandboxOperatorAction(mechanism: string, state: string, failure?: string | null): string {
    const health = 'The current state and the probe\'s verdict are on GET /api/v1/health/details (the `sandbox` section, administrators only); the server log has the full launcher output.';
    if (mechanism === 'landlock') {
        if (failure && isPrivilegeDropFailure(failure)) {
            // Not "remove the capability" alone: the step also fails for root WITHOUT the authority to
            // finish it. What avoids it in every case is a service holding nothing, which never runs it.
            return 'The shim failed in the step that sheds the privilege the WordJS service itself was started with (root, or capabilities such as systemd AmbientCapabilities=). '
                + 'Run the service as an unprivileged user holding no capabilities - that step is then never taken. Check what it holds (GET /api/v1/health/details → `sandbox.hostPrivilege`): '
                + 'set User= in the systemd unit and drop AmbientCapabilities= / extra capabilities from it. '
                + 'To listen on 80/443 without a capability, set net.ipv4.ip_unprivileged_port_start=80 in /etc/sysctl.d/ or put a reverse proxy in front. ' + health;
        }
        if (state === 'active') {
            // The probe CERTIFIED this host; it is this launch that was refused (a read root or zone that
            // would not grant, the launcher missing, the argv not buildable). Pointing at "the probe could
            // not certify" would send the operator after a failure GET /health/details does not show.
            return 'The sandbox is certified on this server; it refused THIS plugin\'s launch at the step named in the failure line. '
                + 'The server log line "[Sandbox] the Linux shim refused to launch isolated plugin …" (or "[Sandbox] refusing to launch isolated plugin …") has the unredacted path: '
                + 'usually a plugin directory, read root or writable zone that is missing or unreadable to the service account. ' + health;
        }
        if (state === 'unsupported') {
            return 'Run WordJS on a Linux kernel with Landlock enabled (5.13 or newer, `landlock` in /sys/kernel/security/lsm) on x86_64 or aarch64, with /usr/bin/perl installed (perl-base). ' + health;
        }
        if (state === 'disabled') {
            return 'The Linux kernel floor is switched off (sandbox.useKernelHardening=false) while sandbox.requireHardening is on. Turn the floor back on. ' + health;
        }
        return 'The Landlock/seccomp probe could not certify confinement on this host. ' + health;
    }
    if (mechanism === 'appcontainer' || mechanism === 'seatbelt') {
        const name = mechanism === 'appcontainer' ? 'AppContainer' : 'Seatbelt';
        if (state === 'active') {
            return `The ${name} sandbox is certified on this server; it could not be set up for THIS plugin. The server log line "[Sandbox] refusing to launch isolated plugin …" names the step and the path. ` + health;
        }
        return `Check the [Sandbox] ${name} warning in the server log for the check that failed (sandbox.${mechanism === 'appcontainer' ? 'useAppContainer' : 'useSeatbelt'} must be on). ` + health;
    }
    return 'This platform has no native plugin sandbox, and sandbox.requireHardening refuses to start plugins without one. Run WordJS on Linux, Windows or macOS. ' + health;
}

/**
 * Build the refusal. Both texts are sanitised HERE, so no caller can forget to:
 *   . `failure` is a launcher's or an exception's own words, which can name any path it touched - every
 *     absolute path is redacted.
 *   . `reason` is a sentence THIS codebase wrote, from the same probe notes GET /health/details already
 *     shows an administrator verbatim (`sandbox.kernel.note`), so it keeps fixed system paths such as
 *     /usr/bin/perl; it is still stripped of control characters and bounded. Never put an exception's
 *     message in `reason` - that is what `failure` is for.
 */
function sandboxUnavailable(slug: string, o: { mechanism: string; state: string; reason: string; failure?: string | null; cause?: unknown }): SandboxUnavailableError {
    const failure = o.failure ? operatorSafeText(o.failure) : null;
    return new SandboxUnavailableError(slug, {
        mechanism: String(o.mechanism || 'none'),
        state: String(o.state || 'unknown'),
        reason: operatorSafeText(o.reason, 600, { keepPaths: true }),
        failure,
        action: sandboxOperatorAction(String(o.mechanism || 'none'), String(o.state || 'unknown'), failure),
    }, { cause: o.cause });
}

/**
 * Find a sandbox refusal in an error's cause chain. core/plugins.ts wraps every activation failure in
 * `Failed to activate plugin <slug>: …` with the original as `cause`, so the refusal is rarely the
 * outermost error. Bounded, so a cyclic `cause` cannot hang a request.
 */
function findSandboxUnavailable(err: unknown): SandboxUnavailableError | null {
    let cur: any = err;
    for (let depth = 0; cur && depth < 8; depth++) {
        if (cur instanceof SandboxUnavailableError) return cur;
        if (cur.code === SANDBOX_UNAVAILABLE && cur.sandbox && typeof cur.sandbox === 'object') return cur as SandboxUnavailableError;
        cur = cur.cause;
    }
    return null;
}

module.exports = {
    SANDBOX_UNAVAILABLE,
    SandboxUnavailableError,
    sandboxUnavailable,
    sandboxRefusalBody,
    findSandboxUnavailable,
    operatorSafeText,
    sandboxOperatorAction,
    isPrivilegeDropFailure,
};
