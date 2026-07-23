/**
 * WordJS - Plugin Capability Bridge (Phase 1 of the isolation proposal)
 *
 * A single, permission-checked facade that plugins use INSTEAD of require()ing core modules
 * directly. Today it runs in-process (a thin facade over the core modules); under the isolation
 * proposal the SAME surface is served over message-passing to an isolate, so plugin code never
 * touches raw fs/child_process/dbAsync/secrets. Adopting it now is non-breaking: it is passed as
 * the argument to a plugin's init(api) — existing plugins that ignore the arg keep working.
 *
 * Every method enforces the plugin's manifest permissions (via verifyPermission, which resolves
 * the effective plugin) and constrains arguments host-side (key allowlists, table scoping, path
 * confinement) — the plugin is untrusted input.
 *
 * See documentation/plugin-isolation-proposal.md.
 */

const path = require('path');
const fs = require('fs');
const { verifyPermission } = require('./plugin-context');

// NO plugin bypasses the sandbox anymore — there is no "trusted" tier. Every capability is gated by an
// admin GRANT (Android-style, default-deny). Privileged things that used to need trust are now either a
// SAFE host-mediated bridge (users projection, site info, mail provider) gated by a grant, or removed.
// Safe projection for the `users` bridge — NEVER includes user_pass / tokens / meta. Accepts either a
// core User instance (camelCase) or a raw row (snake_case).
function projectUser(u: any): any {
    if (!u) return null;
    return {
        id: u.id,
        userLogin: u.userLogin || u.user_login,
        username: u.userLogin || u.user_login,
        userEmail: u.userEmail || u.user_email,
        displayName: u.displayName || u.display_name,
        role: u.role,
    };
}

const ROOT_DIR = path.resolve(__dirname, '../../');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');

// Option keys a plugin may never read/write through the bridge (secrets / security-critical).
// Deliberately broad (matches getProtectedEnv): the previous narrow list let an untrusted plugin
// read options like `stripe_key`, `api_key`, `*_credential`, `encryption_key`, certs, etc.
const PROTECTED_OPTION_RE = /secret|passw(or)?d|pwd|priv(ate)?[_-]?key|privatekey|dkim|\bkey\b|[_-]key\b|key$|api[_-]?key|token|\bsalt\b|jwt|credential|encryption|signing|certificate|\.pem|access[_-]?key/i;
// Security-critical option NAMES that PROTECTED_OPTION_RE misses (no secret-ish word) but control
// authorization / site integrity. Writing 'wordjs_user_roles' rewrites the role->capability map =
// full privilege escalation; 'active_plugins' enables/disables plugins; 'siteurl' can break the
// migration/host guard. Off-limits (read AND write) to untrusted plugins.
const PROTECTED_OPTION_NAMES = new Set([
    'wordjs_user_roles', 'user_roles', 'roles', 'active_plugins', 'default_role',
    'users_can_register', 'admin_email', 'siteurl', 'site_url', 'home',
    // 'trusted_plugins' drives the trust system — writing it self-promotes a plugin to the privileged
    // tier on next boot (full sandbox escape). Off-limits to untrusted plugins.
    'trusted_plugins', 'trusted_plugin', 'trustedsystemplugins',
    // 'plugin_grants' IS the permission-grant store (plugin-permissions.loadGrants reads it verbatim at
    // boot). A plugin with settings:write could otherwise options.set('plugin_grants', {self:[...all...]})
    // and self-escalate to every capability the admin never approved — a full default-deny escape.
    'plugin_grants',
    // 'plugin_egress_hosts' IS the per-plugin egress-allowlist store (plugin-permissions.loadEgressHosts
    // reads it verbatim at boot). A network+settings:write plugin could otherwise options.set it to widen
    // its OWN egress (or tamper with other plugins' entries), routing around the setEgressAllowlist
    // no-self-grant guard — same self-escalation class as plugin_grants. Off-limits to untrusted plugins.
    'plugin_egress_hosts',
    // 'plugin_origins' records WHICH marketplace source each installed plugin came from, and is the
    // only thing that authorizes a catalog entry to replace an installed plugin's code — an update
    // replays the admin's grants (network + egress included) onto the new code and hands it the
    // preserved data/ dir. A settings:write plugin could otherwise rewrite its OWN origin to a source
    // it controls and then push itself an "update" with any payload: a self-service supply-chain
    // escape. Off-limits (read AND write) to untrusted plugins.
    'plugin_origins',
    // 'cron' is the scheduled-events blob. Writing it raw injects hook callbacks (spoofed/omitted
    // pluginSlug runs core & cross-plugin handlers) and bypasses the capacity caps that only sit on the
    // scheduleEvent API. 'plugin_strikes'/'plugin_health' let a plugin clear its own crash record to
    // dodge the supervisor. All off-limits to untrusted plugins.
    'cron', 'plugin_strikes', 'plugin_health',
    // The marketplace source lists are the URLs the HOST fetches the plugin/theme catalog + zips from. A
    // plugin with settings:write could point them at http://127.0.0.1:… / cloud-metadata and drive host-side
    // SSRF that bypasses the plugin egress guard (options are global, not namespaced), OR swap in a catalog
    // whose sha256 it also controls → admin-assisted supply-chain RCE (audit MEDIUM). The ACTIVE option keys
    // are the PLURAL `marketplace_sources` / `marketplace_theme_sources` (routes/marketplace.ts); the earlier
    // singular-only list left the real keys writable. Cover both singular and plural, plugins and themes.
    'marketplace_source', 'marketplace_sources', 'marketplace_url', 'marketplace_catalog_url',
    'marketplace_theme_source', 'marketplace_theme_sources', 'marketplace_themes_source', 'marketplace_themes_sources',
    // 'template'/'stylesheet' select the ACTIVE THEME. A settings:write plugin could otherwise point them
    // at '../plugins/<own-slug>' and, because theme-engine.init() require()s the selected dir's
    // functions.js IN-PROCESS on the host, re-introduce in-process execution (DoS / prototype pollution /
    // mail-provider hijack) that OS isolation exists to prevent (#16). Off-limits to plugins.
    'template', 'stylesheet', 'active_theme_layout', 'active_theme_mods', 'theme_mods'
]);
// Protected for EVERY plugin now (no trusted bypass). Secret/security-critical options are never
// readable/writable through the generic options bridge; safe non-secret reads go via the `site` bridge.
const isProtectedOption = (key: string, _slug?: string): boolean =>
    (PROTECTED_OPTION_RE.test(String(key)) || PROTECTED_OPTION_NAMES.has(String(key).toLowerCase()));

// Core DB tables a plugin may never touch (mirrors the dbAsync scoping in secure-require).
const PROTECTED_TABLES = new Set(['users', 'user_meta', 'usermeta', 'options', 'user_roles', 'roles', 'sessions']);

// Constrain untrusted-plugin SQL. Beyond the core-table denylist, REJECT dangerous constructs that a
// table-name denylist misses: ATTACH/DETACH (mounts arbitrary host files as a DB -> file read/write),
// PRAGMA (info disclosure / settings), schema catalogs (enumerate/read core schema), and stacked
// statements ('SELECT 1; DROP TABLE x'). Then require the statement to START with one of the caller's
// allowed verbs (positive allowlist). Comments are stripped first so they can't act as whitespace to
// evade. Trusted plugins skip this entirely (see callers).
// Single-pass SQL lexer: walk the raw string ONCE, recognizing `--`/`/* */` comments and `'…'` string
// literals IN CONTEXT — so their contents can NEVER be seen as SQL structure (a `/*` inside a literal is
// literal text; a `'` inside a comment is comment text; earlier sequential regex passes let one splice the
// other, #2), and emitting `"…"`/`[…]`/`` `…` `` quoted identifiers as ONE opaque WORD token (so a quoted
// `")"` alias can't inject a phantom `)` that underflows the walker's scope stack, #1). Returns { toks,
// cleaned }: toks = [{k:'p'|'w', v}] for the table walker; cleaned = lowercased text with comments + string
// literals blanked to a space (for the keyword denylists + multi-statement/verb checks). Bounded O(n).
type SqlTok = { k: string; v: string; q?: boolean };
function lexSql(sql: string): { toks: SqlTok[]; cleaned: string } {
    const s = String(sql || '');
    const toks: SqlTok[] = [];
    let cleaned = '';
    const n = s.length;
    let i = 0;
    const isWord = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$' || c === '.';
    while (i < n) {
        const c = s[i];
        // `--` line comment — but ONLY when the next char is whitespace/control or EOL, matching MySQL/
        // MariaDB (SQLite/Postgres treat any `--` as a comment; MySQL treats `--0` as arithmetic `- -0`).
        // Taking the STRICTEST rule here means `--x` is NOT swallowed, so a `WHERE 2=1--0 UNION SELECT
        // user_pass FROM users` stays fully visible to the table-scoping walker on every driver — closing
        // the MySQL-only comment-divergence scoping bypass.
        if (c === '-' && s[i + 1] === '-' && (i + 2 >= n || s[i + 2] === ' ' || s[i + 2] === '\t' || s[i + 2] === '\n' || s[i + 2] === '\r' || s[i + 2] === '\v' || s[i + 2] === '\f')) {
            // Terminate the comment body at `\n` OR a bare `\r`. Postgres' scanner defines newline as
            // `[\n\r]`, so a lone carriage return ENDS a `--` comment there and the text after it runs as
            // live SQL. Stopping only at `\n` (as before) let a plugin write `SELECT 1 -- x\rUNION SELECT
            // user_pass FROM users`: the guard swallowed the whole tail (no `\n`) and saw only `SELECT 1`,
            // while Postgres executed the UNION. Stopping at the STRICTEST terminator (`\r` too) keeps the
            // tail visible to the table-scoping walker on every driver — SQLite/MySQL end `--` only at `\n`,
            // so stopping earlier there just makes the guard see MORE structure (fail-safe).
            i += 2; while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; cleaned += ' '; continue;
        }
        if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; cleaned += ' '; continue; } // /* block */
        if (c === "'") { // string literal ('' escapes a quote) — content is NEVER structure/keywords/tables
            i++;
            while (i < n) { if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
            cleaned += ' '; continue;
        }
        if (c === '"' || c === '`' || c === '[') { // quoted identifier → ONE opaque word token, TAGGED q:true
            const close = c === '[' ? ']' : c;
            i++; let id = '';
            while (i < n) { if (s[i] === close) { if (close !== ']' && s[i + 1] === close) { id += close; i += 2; continue; } i++; break; } id += s[i]; i++; }
            const lid = id.toLowerCase();
            // q:true marks this as a QUOTED identifier — it is ALWAYS a name (table / alias / column), NEVER a
            // keyword. Without the tag, `... AS "order"` collapses to the token `order` and the walker treats
            // it as the ENDER keyword ORDER, disarming a following comma cross-join (#1 round-7).
            toks.push({ k: 'w', v: lid, q: true });
            cleaned += ' ' + lid + ' ';
            continue;
        }
        if (c === '(' || c === ')' || c === ',') { toks.push({ k: 'p', v: c }); cleaned += c; i++; continue; }
        if (isWord(c)) { let w = ''; while (i < n && isWord(s[i])) { w += s[i]; i++; } const lw = w.toLowerCase(); toks.push({ k: 'w', v: lw }); cleaned += lw; continue; }
        cleaned += c; i++; // operators / whitespace / ';' preserved for the denylist + multi-statement check
    }
    return { toks, cleaned };
}

// Extract every TABLE reference by WALKING the lexed token stream. A table token sits right after
// FROM/JOIN/INTO/UPDATE/USING/TABLE, or after a comma while still inside a FROM/USING table-list — at ANY
// paren depth (a subquery/derived table has its own from-list, via the paren stack). CAPTURE EVERY table-slot
// identifier and let the caller prefix-check it — there is NO name-based exemption to poison. (Earlier a CTE
// exemption existed so an unprefixed `FROM cte` wouldn't be flagged; but every attempt to identify "a real
// CTE" was defeated — a WITH inside a derived-table/WHERE subquery is out of scope, and a `<ident> AS (`
// detector also matched WINDOW clauses and aliased-subquery column lists (#1/#2, rounds 5-7). So instead a
// CTE reference must simply use the plugin's own wjp_<slug>_ prefix like any table — then it passes the
// prefix check with no exemption at all.) Quoted-identifier tokens (q) are ALWAYS names, never keywords.
function collectTableTokens(toks: SqlTok[]): string[] {
    // `straight_join` is MySQL/MariaDB's single-token inner-join operator — it introduces a table exactly
    // like JOIN, but lexes as ONE word (the `_` is a word char), so it MUST be an opener or the right-hand
    // table (a core `users` or another plugin's table) is never captured/prefix-checked (adversarial pass 7).
    const OPENERS_FROM = new Set(['from', 'join', 'using', 'straight_join']); // starts/continues a FROM table-list (comma → new table)
    const OPENERS_ONE = new Set(['into', 'update', 'table']); // single-table target (INSERT INTO / UPDATE / *TABLE)
    const ENDERS = new Set(['where', 'group', 'having', 'order', 'limit', 'offset', 'window', 'returning', 'values', 'set', 'union', 'intersect', 'except', 'select', 'with']);
    const out: string[] = [];
    const stack: { fromClause: boolean; expectTable: boolean }[] = [];
    let fromClause = false, expectTable = false;
    for (const tk of toks) {
        if (tk.k === 'p') {
            // A paren opened in a table slot / FROM list is itself a table-or-subquery: propagate fromClause
            // in so an intra-paren comma cross-join `FROM (a , b)` re-arms expectTable; restore on `)`.
            if (tk.v === '(') { const innerFrom: boolean = expectTable || fromClause; stack.push({ fromClause, expectTable: false }); fromClause = innerFrom; continue; }
            if (tk.v === ')') { const st = stack.pop() || { fromClause: false, expectTable: false }; fromClause = st.fromClause; expectTable = st.expectTable; continue; }
            if (tk.v === ',') { if (fromClause) expectTable = true; continue; }
            continue;
        }
        const quoted = tk.q === true; // a quoted identifier is a NAME, never a keyword/opener/ENDER
        const t = tk.v;
        if (expectTable) {
            if (!quoted && (t === 'if' || t === 'not' || t === 'exists')) continue;           // CREATE/DROP TABLE IF [NOT] EXISTS <name>
            if (!quoted && ENDERS.has(t)) { expectTable = false; fromClause = false; continue; } // `(SELECT…/VALUES…)` = subquery, not a table
            out.push(t);                                                                       // CAPTURE — no exemption; the caller prefix-checks it
            expectTable = false;
            continue;
        }
        if (!quoted && OPENERS_FROM.has(t)) { fromClause = true; expectTable = true; }
        else if (!quoted && OPENERS_ONE.has(t)) { expectTable = true; }
        else if (!quoted && t === 'on') { expectTable = false; }                              // keep fromClause: `JOIN y ON a=b , z` — z is still a cross-join
        else if (!quoted && t === 'as') { /* alias marker — ignore */ }
        else if (!quoted && ENDERS.has(t)) { fromClause = false; expectTable = false; }
        // else (incl. ANY quoted token in a non-table slot = alias/column): ignore, and do NOT disarm fromClause
    }
    return out;
}

function assertSqlAllowed(sql: string, allowedVerbs: string[], tablePrefix?: string, slug?: string) {
    const raw = String(sql || '');
    // Bound the RAW input BEFORE ANY processing: legitimate plugin SQL is small, and an unbounded string is
    // a cheap way to force super-linear work in the HOST process (the guard runs host-side for isolated
    // plugins too) — an event-loop DoS (#23). Cap FIRST so nothing (not even the lexer or a regex on the
    // comment/literal text) ever runs on an unbounded string.
    if (raw.length > 20000) {
        throw new Error(`🛡️ Plugin DB access denied: SQL statement too long.`);
    }
    // MySQL/MariaDB "executable comments" (`/*! … */`, optionally version-gated `/*!50000 … */`) run the
    // wrapped SQL on those engines while the generic `/* */` lexer below blanks it — the same comment-
    // divergence class as `--0`. Checked on the RAW string BEFORE the lexer strips it. A plugin never needs
    // version-gated SQL, so deny the marker outright rather than trying to reconcile per-engine semantics.
    if (raw.includes('/*!')) {
        throw new Error(`🛡️ Plugin DB access denied: MySQL executable comments (/*! ... */) are not permitted.`);
    }
    // Backslash-escape divergence (adversarial re-verify): MySQL/MariaDB (unless NO_BACKSLASH_ESCAPES is set)
    // treat `\'` as an ESCAPED quote, while this lexer + SQLite/Postgres treat `\` literally. A `'\''`
    // sentinel therefore pairs the quotes differently in the guard vs MySQL, letting a `UNION`/stacked
    // statement hide INSIDE what the guard scans as a string literal. Plugins pass literal data via BOUND
    // params (?), never inline, so a backslash in untrusted SQL is never legitimate — deny it. This closes
    // the whole class on every engine (belt-and-suspenders with NO_BACKSLASH_ESCAPES on the MySQL pool).
    if (raw.includes('\\')) {
        throw new Error(`🛡️ Plugin DB access denied: backslashes are not permitted in plugin SQL; pass literal data via bound parameters (?).`);
    }
    // Postgres dollar-quoting (`$$ … $$` / `$tag$ … $tag$`, where the tag may include NON-ASCII letters such
    // as `$café$`) is an OPAQUE string form this lexer does not recognize: it treats `$` as an ordinary word
    // char and only `'` as a string delimiter, so a `'` INSIDE a dollar-quote opens a PHANTOM guard-string
    // that swallows a following `UNION SELECT … FROM users` / stacked `; …` from the table walker + multi-
    // statement check while Postgres executes it (same divergence class as backslash / `--0` / `/*!`, with
    // NO backslash needed). Per-engine reconciliation is impossible (`$$` is not a delimiter on SQLite/MySQL,
    // where a `;` between `$$…$$` is a real separator). The guard runs on ?-placeholder SQL BEFORE $N
    // translation, so untrusted plugin SQL never legitimately contains ANY `$` — deny it OUTRIGHT. This
    // closes the entire dollar-quote class (incl. non-ASCII tags) structurally, instead of chasing the
    // Postgres tag charset with regexes (two prior ASCII-only regexes here each missed `$café$`).
    if (raw.includes('$')) {
        throw new Error(`🛡️ Plugin DB access denied: '$' is not permitted in plugin SQL (dollar-quoting / dollar params); pass literal data via bound parameters (?).`);
    }
    // Square brackets: SQLite treats `[...]` as identifier quoting and MySQL as a syntax error, but Postgres
    // parses `[...]` as ARRAY SUBSCRIPTING whose index is a FULL expression — including a scalar subquery.
    // lexSql collapses `[...]` to ONE opaque identifier token on every engine, so `v[(SELECT total FROM
    // wjp_other_plugin_orders)]` launders a cross-plugin table reference past the toks-based prefix allowlist
    // (the sole general table-attribution check) and Postgres then executes the subquery — a cross-plugin
    // confidentiality break. Plugins never need bracket-quoted identifiers (the wjp_<slug>_ prefix + column
    // names are [a-z0-9_]; use "…" for a reserved word). Deny `[`/`]` outright — same structural approach as
    // `\` / `$` / `/*!`, and immune to the per-engine lexing divergence that opaque-token handling can't close.
    if (raw.includes('[') || raw.includes(']')) {
        throw new Error(`🛡️ Plugin DB access denied: square brackets [ ] are not permitted in plugin SQL; use "…" to quote an identifier, and bound parameters (?) for data.`);
    }
    // ONE lexer pass recognizes comments + string literals + quoted identifiers TOGETHER, so attacker text
    // inside any of them can't splice out structure (the comment-vs-literal ordering bug #2 and the
    // quoted-identifier phantom-paren #1). `cleaned` = lowercased, comments/literals blanked; `toks` feeds
    // the table walker. Everything below runs on this clean output, never the raw string.
    const { toks, cleaned } = lexSql(raw);
    const lower = cleaned.trim();

    if (/\battach\b/.test(lower) || /\bdetach\b/.test(lower) || /\bpragma\b/.test(lower)) {
        throw new Error(`🛡️ Plugin DB access denied: ATTACH/DETACH/PRAGMA are not permitted.`);
    }
    if (/\bsqlite_(master|schema|temp_master|temp_schema)\b/.test(lower) ||
        /\binformation_schema\b/.test(lower) || /\bpg_catalog\b/.test(lower)) {
        throw new Error(`🛡️ Plugin DB access denied: querying the schema catalog is not permitted.`);
    }
    // File / extension / program SQL functions never belong in plugin SQL, and (taking no FROM) they
    // bypass the table-prefix attribution below. Inert on the default better-sqlite3 driver (no such
    // functions / load_extension SQL not authorized), but deny TEXTUALLY so a driver swap or an enabled
    // extension can never open a file-read / file-write / RCE channel from a scoped query.
    if (/\b(?:readfile|writefile|load_extension|fsdir|zipfile|sqlite3_\w+|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink|dblink_exec)\s*\(/.test(lower)) {
        throw new Error(`🛡️ Plugin DB access denied: file/extension/program SQL functions are not permitted.`);
    }
    // Single statement only — strip a single trailing ';' then reject any remaining one.
    if (lower.replace(/;\s*$/, '').includes(';')) {
        throw new Error(`🛡️ Plugin DB access denied: multiple statements are not permitted.`);
    }
    // Positive leading-verb allowlist (e.g. read = SELECT/WITH; write = INSERT/UPDATE/DELETE/...).
    const verb = (lower.match(/^([a-z]+)/) || [])[1] || '';
    if (allowedVerbs.length && !allowedVerbs.includes(verb)) {
        throw new Error(`🛡️ Plugin DB access denied: '${verb || '(empty)'}' statements are not permitted here.`);
    }
    // Core-table denylist (defense in depth alongside the prefix allowlist below). Anchor the match to a
    // table-INTRODUCING keyword (from/join/into/update/using/table) + optional SQL delimiter, so a
    // legitimate COLUMN named like a core table (e.g. a plugin's own `options`/`status`/`type` column in
    // an INSERT column list or UPDATE SET) is NOT a false positive — only an actual table REFERENCE to a
    // core table is blocked. (The prefix allowlist below is the real enforcement.)
    for (const t of PROTECTED_TABLES) {
        // Allow the table-introducing keyword to be glued to a preceding `_` (e.g. MySQL `straight_join`),
        // not just a word boundary — otherwise `\bjoin` never matches inside `straight_join users` and the
        // core-table backstop misses it (adversarial pass 7).
        if (new RegExp(`(?:\\b|_)(?:from|join|into|update|using|table)\\s+["\\[\`]?${t}\\b`).test(lower)) {
            throw new Error(`🛡️ Plugin DB access denied: query references core table '${t}', which is off-limits to plugins.`);
        }
    }
    // Allow-by-PREFIX (default-deny): every table the query touches must be one the plugin OWNS
    // (created via createTable under its wjp_<slug>_ prefix). This replaces the leaky denylist with
    // default-deny — a plugin can't read another plugin's tables (e.g. mail-server's received_emails)
    // or any core table, even one not in PROTECTED_TABLES.
    if (tablePrefix) {
        // RETURNING is the scalar-exfil channel for a DELETE/UPDATE...USING that joins another table (and
        // an untrusted plugin gets inserted ids via lastID anyway) — deny it outright for untrusted SQL.
        if (/\breturning\b/.test(lower)) {
            throw new Error(`🛡️ Plugin DB access denied: RETURNING is not permitted; use a separate SELECT.`);
        }
        // Every TABLE the query references (at any depth, in any clause, via any keyword/comma) must be a
        // table this plugin OWNS. The lexed token-walker catches the comma-join / subquery / UNION / FROM(x)
        // / quoted-alias evasions. FAIL-CLOSED: any non-prefixed table token is denied.
        ensureAllPrefixesClaimed(); // complete the CLAIMED_PREFIXES set so longest-prefix ownership is load-order-independent
        for (const tok of collectTableTokens(toks)) {
            if (!/^[a-z_][a-z0-9_$.]*$/.test(tok) || !tok.startsWith(tablePrefix)) {
                throw new Error(`🛡️ Plugin DB access denied: table '${tok}' is not owned by this plugin — use the '${tablePrefix}' prefix (wordjs.db.tablePrefix).`);
            }
            // AUTHORITATIVE creator check (#12): if this exact table has a RECORDED creator, only that
            // creator may touch it — defeating a prefix-extension squat (attacker slug 'events-ticket'
            // whose prefix is a longer match for the victim 'events' table wjp_events_ticket_types).
            const creator = TABLE_CREATORS.get(tok);
            if (slug && creator && creator !== slug) {
                throw new Error(`🛡️ Plugin DB access denied: table '${tok}' was created by plugin '${creator}', not this plugin.`);
            }
            // startsWith is ambiguous when one plugin's prefix is a prefix of another's (wjp_event_ ⊂
            // wjp_event_tickets_orders): the real owner is the plugin whose CLAIMED prefix is the LONGEST
            // match. If a longer-prefixed sibling owns this table, deny even though our own prefix matches.
            for (const [p, s] of CLAIMED_PREFIXES) {
                if (p.length > tablePrefix.length && tok.startsWith(p)) {
                    throw new Error(`🛡️ Plugin DB access denied: table '${tok}' belongs to plugin '${s}', not this plugin.`);
                }
            }
        }
        // INDEX DDL: CREATE [UNIQUE] INDEX <name> ON <table> (...) / DROP INDEX <name>. The generic
        // table matcher above misses the `ON <table>` target and the index name, so scope them too.
        if (/\bindex\b/.test(lower)) {
            const onTbl = lower.match(/\bon\s+([^\s(;]+)/);
            if (onTbl && (!/^[a-z_][a-z0-9_$.]*$/.test(onTbl[1]) || !onTbl[1].startsWith(tablePrefix))) {
                throw new Error(`🛡️ Plugin DB access denied: index target '${onTbl[1]}' is not owned by this plugin.`);
            }
            const idxName = lower.match(/\b(?:create(?:\s+unique)?\s+index|drop\s+index)(?:\s+if\s+(?:not\s+)?exists)?\s+([^\s(;]+)/);
            if (idxName && (!/^[a-z_][a-z0-9_$.]*$/.test(idxName[1]) || !idxName[1].startsWith(tablePrefix))) {
                throw new Error(`🛡️ Plugin DB access denied: index name '${idxName[1]}' must use the '${tablePrefix}' prefix.`);
            }
        }
        // VIEW / TRIGGER object names (missed by the table matcher + the INDEX case) must be prefixed too,
        // else a plugin squats an unprefixed object in the shared namespace or shadows another's.
        if (/\b(?:view|trigger)\b/.test(lower)) {
            const obj = lower.match(/\b(?:create(?:\s+temp(?:orary)?)?\s+(?:view|trigger)|drop\s+(?:view|trigger))(?:\s+if\s+(?:not\s+)?exists)?\s+([^\s(;]+)/);
            if (obj && (!/^[a-z_][a-z0-9_$.]*$/.test(obj[1]) || !obj[1].startsWith(tablePrefix))) {
                throw new Error(`🛡️ Plugin DB access denied: view/trigger name '${obj[1]}' must use the '${tablePrefix}' prefix.`);
            }
        }
    }
}

// Confine a plugin-supplied relative path to its own dir or the uploads dir; realpath-checked.
function resolvePluginPath(slug: string, relPath: string, mustExist: boolean, allowUploads = true): string {
    const base = slug.startsWith('theme:') ? path.join(ROOT_DIR, 'themes', slug.slice(6)) : path.join(PLUGINS_DIR, slug);
    const candidate = path.resolve(base, String(relPath || ''));
    const real = (() => {
        try { return fs.realpathSync(candidate); } catch { return candidate; }
    })();
    const ok = (dir: string) => real === dir || real.startsWith(dir + path.sep);
    if (!ok(base) && !(allowUploads && ok(UPLOADS_DIR))) {
        throw new Error(`🛡️ Plugin path denied: '${relPath}' is outside the plugin dir${allowUploads ? ' and uploads' : ''}.`);
    }
    if (mustExist && !fs.existsSync(real)) throw new Error(`File not found: ${relPath}`);
    return real;
}

/**
 * Build the `wordjs` capability object for a plugin. `slug` is the plugin (or `theme:<slug>`).
 */
// A normalized table prefix -> the slug that first claimed it. Two DIFFERENT slugs that normalize to the
// same prefix would share physical tables; the second one is refused (see below).
const CLAIMED_PREFIXES = new Map<string, string>();

// Longest-prefix table ownership needs EVERY installed plugin/theme prefix known — but per-plugin claims
// happen lazily as each loads, so a plugin querying during boot (before a nested-prefix sibling has
// claimed) could read the sibling's tables (audit HIGH #12). Eagerly seed the full set from disk ONCE at
// module load (no plugin context is active here, so fs is unrestricted → load-order-independent).
// Ownership must survive UNINSTALL-with-keep-data: WordJS deletes a plugin's DIRECTORY on uninstall but
// KEEPS its wjp_<slug>_ tables unless the admin opts to drop them (WordPress parity). A dir-only prefix
// seed would then forget the orphan's prefix, so a still-installed sibling whose prefix NESTS under it
// (wjp_event_ ⊂ wjp_event_tickets_) could read the orphan's tables (#12). Persist every claimed prefix to
// a plugin-untouchable on-disk registry (its basename is in io-guard's BLOCKED_FILES → no plugin can
// read/overwrite it) that is NEVER pruned on uninstall, and seed CLAIMED_PREFIXES from it too. Sync fs in
// host context (no plugin on the stack here) → unrestricted, and no async/query race.
const PREFIX_REGISTRY_FILE = path.join(ROOT_DIR, 'data', 'wjp-prefix-registry.json');
// AUTHORITATIVE table ownership: prefix-longest-match is squattable — a plugin whose slug is a prefix-
// EXTENSION of a victim's table (victim 'events' owns wjp_events_ticket_types; attacker slug 'events-ticket'
// → prefix wjp_events_ticket_ is a LONGER match) would be handed ownership it never created (#12). Record
// the EXACT creator of every table the moment it's created; on access, a table with a recorded creator is
// readable ONLY by that creator, regardless of prefix math. Stored in the same plugin-untouchable registry
// under '@<table>' keys (a real prefix starts with 'wjp_', never '@', so the two namespaces never collide).
const TABLE_CREATORS = new Map<string, string>();
function loadPersistedPrefixes(): void {
    try {
        const obj = JSON.parse(require('fs').readFileSync(PREFIX_REGISTRY_FILE, 'utf8'));
        if (obj && typeof obj === 'object') {
            for (const [k, slug] of Object.entries(obj)) {
                if (typeof k !== 'string') continue;
                if (k[0] === '@') { if (!TABLE_CREATORS.has(k.slice(1))) TABLE_CREATORS.set(k.slice(1), String(slug)); }
                else if (k.startsWith('wjp_') && !CLAIMED_PREFIXES.has(k)) CLAIMED_PREFIXES.set(k, String(slug));
            }
        }
    } catch { /* registry absent/unreadable — the dir seed still applies */ }
}
function persistRegistry(key: string, slug: string): void {
    try {
        const fsm = require('fs');
        let obj: any = {};
        try { obj = JSON.parse(fsm.readFileSync(PREFIX_REGISTRY_FILE, 'utf8')) || {}; } catch { obj = {}; }
        if (obj[key] === slug) return; // already recorded
        obj[key] = slug;
        try { fsm.mkdirSync(path.dirname(PREFIX_REGISTRY_FILE), { recursive: true }); } catch { /* dir may exist */ }
        fsm.writeFileSync(PREFIX_REGISTRY_FILE, JSON.stringify(obj));
    } catch { /* best effort — in-memory + dir seed remain the fallback */ }
}
function persistPrefix(prefix: string, slug: string): void { persistRegistry(prefix, slug); }
// Record `table` as created by `slug` (idempotent, in-memory + on disk). First-creator wins.
function recordTableCreator(table: string, slug: string): void {
    const t = String(table).toLowerCase();
    if (TABLE_CREATORS.has(t)) return;
    TABLE_CREATORS.set(t, slug);
    persistRegistry('@' + t, slug);
}

let _allPrefixesClaimed = false;
function ensureAllPrefixesClaimed() {
    if (_allPrefixesClaimed) return;
    _allPrefixesClaimed = true;
    try {
        const fs = require('fs');
        const toPrefix = (slug: string) => ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();
        for (const dir of [PLUGINS_DIR, path.join(ROOT_DIR, 'themes')]) {
            let names: string[];
            try { names = fs.readdirSync(dir); } catch { continue; }
            for (const name of names) {
                if (typeof name !== 'string' || name.startsWith('.')) continue;
                try { if (!fs.statSync(path.join(dir, name)).isDirectory()) continue; } catch { continue; }
                const pfx = toPrefix(name);
                if (!CLAIMED_PREFIXES.has(pfx)) CLAIMED_PREFIXES.set(pfx, name);
            }
        }
        loadPersistedPrefixes(); // + orphan prefixes whose dir was removed but whose tables persist
    } catch { /* best effort — the per-createPluginApi claims below still populate it */ }
}
ensureAllPrefixesClaimed();

function createPluginApi(slug: string) {
    // Per-plugin table namespace (like WordPress $wpdb->prefix). Untrusted plugins may only create
    // and query tables under this prefix (enforced in createTable + assertSqlAllowed).
    const tablePrefix = ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();
    // Reject a slug whose prefix a DIFFERENT slug already claimed (acme-shop / acme_shop / acme.shop all
    // normalize to wjp_acme_shop_) — otherwise the two plugins silently share each other's tables.
    const claimant = CLAIMED_PREFIXES.get(tablePrefix);
    if (claimant && claimant !== slug) {
        throw new Error(`🛡️ Plugin '${slug}' table prefix '${tablePrefix}' collides with already-loaded plugin '${claimant}'. Rename the plugin slug.`);
    }
    CLAIMED_PREFIXES.set(tablePrefix, slug);
    persistPrefix(tablePrefix, slug); // survive this plugin's later uninstall-with-keep-data (#12)
    return {
        slug,

        options: {
            async get(key: string, def: any = null) {
                verifyPermission('settings', 'read');
                // Secret-named options are off-limits to EVERY plugin (no trusted bypass). A plugin
                // keeps its own secrets in its own wjp_<slug>_ table; non-secret site info via `site`.
                if (isProtectedOption(key, slug)) {
                    throw new Error(`🛡️ Option '${key}' is not readable by plugins.`);
                }
                const { getOption } = require('./options');
                return getOption(key, def);
            },
            async set(key: string, value: any) {
                verifyPermission('settings', 'write');
                if (isProtectedOption(key, slug)) {
                    throw new Error(`🛡️ Option '${key}' is not writable by plugins.`);
                }
                const { updateOption } = require('./options');
                return updateOption(key, value);
            }
        },

        db: {
            // Per-plugin table prefix the plugin must use for its own tables (like $wpdb->prefix).
            tablePrefix,
            // Read-only query (SELECT) — ALWAYS scoped to the plugin's own wjp_<slug>_ tables (no
            // trusted bypass exists anymore); core tables (users/options/…) are unreachable. For user
            // lookups use the safe `users` bridge (projection only, never user_pass).
            async all(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                assertSqlAllowed(sql, ['select', 'with'], tablePrefix, slug);
                // Run under the plugin's DB role (Postgres) so the database itself denies any cross-plugin/
                // core read even if the text-guard above is bypassed. Falls back to the shared connection
                // (text-guard only) on SQLite/MySQL or when a role couldn't be provisioned.
                return require('./plugin-db-isolation').runScoped(slug, 'all', sql, params);
            },
            async get(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                assertSqlAllowed(sql, ['select', 'with'], tablePrefix, slug);
                return require('./plugin-db-isolation').runScoped(slug, 'get', sql, params);
            },
            // Mutating query (INSERT/UPDATE/DELETE/CREATE/ALTER) — always scoped to own tables.
            async run(sql: string, params: any[] = []) {
                verifyPermission('database', 'write');
                assertSqlAllowed(sql, ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'], tablePrefix, slug);
                const iso = require('./plugin-db-isolation');
                // DDL (CREATE/ALTER/DROP) runs as the ADMIN user — a plugin's NOLOGIN role has no CREATE, and
                // the text-guard above already forced the target under the plugin's own prefix. DML runs under
                // the plugin's role so the database enforces table-level isolation.
                let res;
                if (/^\s*(?:create|alter|drop)\b/i.test(sql)) {
                    const { dbAsync } = require('../config/database');
                    res = await dbAsync.run(sql, params);
                } else {
                    res = await iso.runScoped(slug, 'run', sql, params);
                }
                // Record ownership of any table this CREATE just made (guard forced the prefix), so a later
                // prefix-extension squatter can't claim it (#12), and GRANT the new table to the plugin's role.
                const m = String(sql).toLowerCase().match(/\bcreate\s+(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?["[`]?([a-z_][a-z0-9_$.]*)/);
                if (m) { recordTableCreator(m[1], slug); await iso.grantNewTable(slug, m[1]); }
                return res;
            },
            // Create a table — ALWAYS under the plugin's own prefix (no trusted bypass), so it can't
            // create or shadow core / other plugins' tables.
            async createTable(name: string, columns: string[]) {
                verifyPermission('database', 'write');
                if (!String(name).toLowerCase().startsWith(tablePrefix)) {
                    throw new Error(`🛡️ Plugin tables must be named with the '${tablePrefix}' prefix (use wordjs.db.tablePrefix).`);
                }
                const { createPluginTable } = require('../config/database');
                const r = await createPluginTable(name, columns);
                recordTableCreator(name, slug); // authoritative creator record (#12)
                await require('./plugin-db-isolation').grantNewTable(slug, name); // let the plugin role use it
                return r;
            },
            // Which SQL dialect is active (so a plugin can branch on Postgres vs SQLite DDL).
            getType() {
                verifyPermission('database', 'read');
                const { getDbType } = require('../config/database');
                return getDbType();
            }
        },

        // CSPRNG bridge (SAFE — no data access, no permission gate). Plugins that need unguessable
        // tokens/access codes must use this instead of Math.random (predictable, state-reconstructable).
        crypto: {
            randomToken(bytes = 16) {
                const n = Math.min(Math.max(Math.floor(Number(bytes) || 16), 8), 64);
                return require('crypto').randomBytes(n).toString('hex');
            },
            randomInt(min: number, max: number) {
                const lo = Math.ceil(Number(min)), hi = Math.floor(Number(max));
                if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || (hi - lo) > 1e9) {
                    throw new Error('crypto.randomInt: invalid range');
                }
                return require('crypto').randomInt(lo, hi); // uniform in [lo, hi)
            },
        },

        hooks: {
            addAction(hook: string, cb: (...a: any[]) => any, priority?: number) {
                const { addAction } = require('./hooks');
                return addAction(hook, cb, priority);
            },
            addFilter(hook: string, cb: (...a: any[]) => any, priority?: number) {
                const { addFilter } = require('./hooks');
                return addFilter(hook, cb, priority);
            },
            doAction(hook: string, ...args: any[]) {
                const hooksMod = require('./hooks');
                // A plugin may fire ONLY its OWN registered callbacks (no trusted bypass) — never
                // arbitrary core / other-plugin action handlers with attacker-controlled args.
                return hooksMod.doActionForPlugin(hook, slug, ...args);
            }
        },

        // Safe, read-only USER lookups (grant: users:read) — returns a PROJECTION only
        // (id/login/email/displayName/role), NEVER user_pass / tokens / meta. Replaces a plugin doing
        // raw `SELECT * FROM users` (which leaked password hashes). The host writes the query (core User
        // model); the plugin passes only a key/term.
        users: {
            async findByEmail(email: string) { verifyPermission('users', 'read'); return projectUser(await require('../models/User').findByEmail(email)); },
            async findByLogin(login: string) { verifyPermission('users', 'read'); return projectUser(await require('../models/User').findByLogin(login)); },
            async findById(id: any) { verifyPermission('users', 'read'); return projectUser(await require('../models/User').findById(id)); },
            async search(term: string, limit = 50) {
                verifyPermission('users', 'read');
                const list = await require('../models/User').findAll({ search: String(term || ''), limit: Math.min(Number(limit) || 50, 200) });
                return (Array.isArray(list) ? list : []).map(projectUser);
            },
        },

        // Non-secret site info (grant: settings:read). Avoids needing the (blocked) protected-option
        // reads of siteurl/home/admin_email; never exposes secrets.
        site: {
            async url() { verifyPermission('settings', 'read'); const { getOption } = require('./options'); return getOption('siteurl', await getOption('home', 'http://localhost')); },
            async domain() { verifyPermission('settings', 'read'); const { getOption } = require('./options'); try { return new URL(await getOption('siteurl', await getOption('home', 'http://localhost'))).hostname; } catch { return 'localhost'; } },
            async adminEmail() { verifyPermission('settings', 'read'); const { getOption } = require('./options'); return getOption('admin_email', ''); },
        },

        // Host-mediated DNS record lookups (gated on the `network` grant). The RAW c-ares resolver
        // surface (dns.resolve*/Resolver/setServers) is DENIED inside the isolate by the egress-guard
        // because it bypasses egress filtering and enables internal DNS recon — but getaddrinfo
        // (dns.lookup, the only resolver left) can ONLY do A/AAAA, so a real MTA cannot resolve MX (for
        // direct-to-MX delivery) or TXT (for SPF/DKIM/DMARC verification). The HOST performs those
        // queries with the system resolver and returns ONLY the records, STRIPPING any A/AAAA answer
        // that points at a private/internal/special IP — so this can't be used to discover or reach an
        // internal host (and the actual SMTP connection still goes through the egress-guarded net/tls).
        // resolve4/resolve6 therefore return PUBLIC addresses only; a domain whose MX resolves solely to
        // internal IPs comes back empty (delivery is correctly skipped). Consistent with the same
        // network grant that opens the socket modules — no separate scope.
        dns: (() => {
            const realDns = require('dns').promises;
            // Reuse the egress-guard's blocked-IP policy VERBATIM — the single source of truth the
            // connect/lookup/dgram guards already enforce — instead of a hand-rolled copy that drifted.
            // isBlockedIp classifies by NUMERIC bytes, so it catches EVERY spelling of loopback/metadata
            // (the hex-form IPv4-mapped '::ffff:a9fe:a9fe' and expanded '0:0:0:0:0:0:0:1' that a textual
            // prefix-match misses), plus NAT64 (64:ff9b::/96) and 6to4 (2002::/16) wrapping a private v4,
            // fec0::/10 site-local, and IPv4/IPv6 multicast+reserved. Fail-closed: an unparseable answer
            // is treated as blocked and dropped.
            const { isBlockedIp } = require('./egress-guard');
            const requireNetwork = () => {
                let granted = false;
                try { granted = require('./plugin-permissions').isNetworkGranted(slug); } catch { granted = false; }
                if (!granted) throw new Error(`🛡️ Security Block: plugin '${slug}' needs the 'network' grant for DNS lookups.`);
            };
            const clean = (s: any) => String(s == null ? '' : s).slice(0, 253);
            return {
                async resolveMx(domain: string) { requireNetwork(); return realDns.resolveMx(clean(domain)); },
                async resolveTxt(name: string) { requireNetwork(); return realDns.resolveTxt(clean(name)); },
                async resolve4(host: string) { requireNetwork(); const a = await realDns.resolve4(clean(host)); return (a || []).filter((ip: string) => !isBlockedIp(ip)); },
                async resolve6(host: string) { requireNetwork(); const a = await realDns.resolve6(clean(host)); return (a || []).filter((ip: string) => !isBlockedIp(ip)); },
                // dns.promises.resolve() with no rrtype defaults to A records (string IPs) — mirror that.
                async resolve(host: string) { requireNetwork(); const a = await realDns.resolve4(clean(host)); return (a || []).filter((ip: string) => !isBlockedIp(ip)); },
            };
        })(),

        http: {
            // Register an Express route. Handlers run anchored in the plugin context (appRegistry
            // wraps the Router/app methods). Path is ALWAYS namespaced under the plugin (no absolute bypass).
            route(method: string, routePath: string, ...handlers: any[]) {
                const { getApp } = require('./appRegistry');
                const app = getApp();
                if (!app) throw new Error('App not available');
                const m = String(method).toLowerCase();
                if (!['get', 'post', 'put', 'patch', 'delete', 'use'].includes(m)) throw new Error(`Bad method ${method}`);
                const full = `/api/v1/plugin/${slug.replace('theme:', 'theme-')}${routePath}`;
                return app[m](full, ...handlers);
            }
        },

        fs: {
            async read(relPath: string, encoding: BufferEncoding = 'utf8') {
                verifyPermission('filesystem', 'read');
                // Every plugin reads only inside its OWN dir — never the shared uploads dir (no trusted
                // bypass). Raw fs to a SAFE zone is governed separately by io-guard.
                return fs.promises.readFile(resolvePluginPath(slug, relPath, true, false), encoding);
            },
            async write(relPath: string, data: any) {
                verifyPermission('filesystem', 'write');
                // Every plugin writes only inside its OWN dir — never the shared public uploads dir
                // (where an .html/.svg could be served to other users). No trusted bypass.
                const target = resolvePluginPath(slug, relPath, false, false);
                if (path.basename(target).toLowerCase() === 'manifest.json') throw new Error('🛡️ manifest.json is immutable.');
                // (#6) Bound disk use so a write-permitted plugin can't fill the host disk: reject an
                // oversized single write, and keep the plugin's OWN-dir footprint under a quota so repeated
                // small writes can't either. (Trusted writes to shared uploads keep only the per-write cap.)
                const SINGLE_WRITE_MAX = 16 * 1024 * 1024, PLUGIN_DISK_QUOTA = 100 * 1024 * 1024;
                let writeBytes: number;
                try { writeBytes = Buffer.byteLength(data); } catch { writeBytes = Buffer.byteLength(String(data ?? '')); }
                if (writeBytes > SINGLE_WRITE_MAX) throw new Error(`🛡️ write too large (${writeBytes} > ${SINGLE_WRITE_MAX} bytes).`);
                const baseDir = resolvePluginPath(slug, '.', false, false);
                if (target === baseDir || target.startsWith(baseDir + path.sep)) {
                    const du = async (dir: string, cap: number): Promise<number> => {
                        let total = 0; let entries: any[];
                        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
                        for (const e of entries) {
                            const p = path.join(dir, e.name);
                            try { total += e.isDirectory() ? await du(p, cap - total) : (await fs.promises.stat(p)).size; } catch { /* skip */ }
                            if (total >= cap) break; // early-exit once over budget
                        }
                        return total;
                    };
                    let existing = 0; try { existing = (await fs.promises.stat(target)).size; } catch { /* new file */ }
                    const used = await du(baseDir, PLUGIN_DISK_QUOTA + writeBytes);
                    if (used - existing + writeBytes > PLUGIN_DISK_QUOTA) throw new Error(`🛡️ plugin disk quota exceeded (${PLUGIN_DISK_QUOTA} bytes).`);
                }
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                return fs.promises.writeFile(target, data);
            }
        },

        async mail(msg: any) {
            verifyPermission('email', 'admin');
            const send = (global as any).wordjs_send_mail;
            if (typeof send !== 'function') throw new Error('Mail server not available');
            return send(msg);
        },

        // A mail-PROVIDER plugin (e.g. mail-server) registers the host-wide send function that
        // backs wordjs.mail / global.wordjs_send_mail. In-process this sets the global directly;
        // for isolated providers the worker bridge wires a shim that RPCs the provider's worker.
        provideMail(handler: (msg: any) => any) {
            // Becoming the host-wide mail sender intercepts ALL outbound mail, so it requires the
            // explicit `email:provider` grant (admin-approved, with a loud UI warning). No trusted
            // bypass — re-checked here AND at the register-mail-provider IPC handler.
            verifyPermission('email', 'provider');
            if (typeof handler !== 'function') throw new Error('provideMail requires a function');
            (global as any).wordjs_send_mail = handler;
        },

        async notify(n: any) {
            verifyPermission('notifications', 'send');
            const notificationService = require('./notifications');
            return notificationService.send(n);
        },

        shortcodes: {
            // Register a shortcode. Handler may be async (rendered via doShortcodeAsync). In-process
            // here; for isolated plugins the worker bridge forwards it over RPC (see plugin-isolate).
            add(tag: string, handler: (attrs: any, content: string, tag: string) => any) {
                const { addShortcode } = require('./shortcodes');
                return addShortcode(tag, handler);
            }
        },

        // Structured frontend assets: load a <script>/<style> from a path INSIDE the plugin's own dir
        // onto public pages. NOT raw HTML (those hooks are hard-denied as a stored-XSS primitive) — the
        // host validates the file exists + can't escape the plugin dir and emits sanitized tags.
        assets: {
            async enqueueScript(spec: any) {
                verifyPermission('assets', 'write');
                return require('./plugin-assets').enqueue(slug, 'script', spec);
            },
            async enqueueStyle(spec: any) {
                verifyPermission('assets', 'write');
                return require('./plugin-assets').enqueue(slug, 'style', spec);
            }
        },

        adminMenu: {
            add(item: any) {
                const { registerAdminMenu } = require('./adminMenu');
                return registerAdminMenu(slug, item);
            }
        },

        cron: {
            schedule(timestamp: number, recurrence: string | false, hook: string, args: any[] = []) {
                const cron = require('./cron');
                return recurrence
                    ? cron.scheduleEvent(timestamp, recurrence, hook, args)
                    : cron.scheduleSingleEvent(timestamp, hook, args);
            }
        }
    };
}

module.exports = { createPluginApi, isProtectedOption };
