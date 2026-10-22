/**
 * WordJS Plugin: Auctions — ISOLATED, sandboxed.
 *
 * Auction listings with a starting price, a minimum increment and an end time. Public bidding is
 * validated server-side (never trusting client-sent prices beyond the bid amount itself, which is
 * checked against the DB-derived current price), rate-limited in-memory, and protected against
 * sniping: a bid landing within the last `anti_snipe_min` minutes extends `ends_at` by that many
 * minutes via a SINGLE-STATEMENT SQLite datetime() update (the db bridge has no transactions).
 *
 * Money is stored as INTEGER CENTS everywhere (start_price_cents, min_increment_cents,
 * amount_cents). The currency symbol is display-only config kept in the plugin's own settings
 * table (it is not a secret, but this plugin has no settings/options grant, so the wjp_ table is
 * the natural home).
 *
 * Dates: starts_at/ends_at are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings so SQLite's
 * datetime(ends_at, '+N minutes') math works and plain string comparison against "now" is valid.
 * Responses also carry epoch-ms fields (endsAtMs/startsAtMs/serverNowMs) so clients never have to
 * parse the SQL string (JS would read it as LOCAL time).
 *
 * Who may bid is a setting (bid_verification): a bidder proves the address once per browser with a
 * mailed code ('email', the default), signs in ('login') or nobody is checked ('none'). One bid may
 * raise the price by at most max_bid_jump_percent of it.
 *
 * Derived state (never stored): currentPrice = MAX(bids.amount_cents) or start_price_cents;
 * winner = the top bid once ended. Routes lazily flip status 'active' -> 'ended' when
 * now > ends_at, so no cron is needed.
 */

exports.metadata = {
    name: 'Auctions',
    version: '1.1.3',
    description: 'Auction listings with public bidding, minimum increments, anti-snipe extension and winner reporting.',
    author: 'WordJS',
};

exports.init = async function (wordjs) {
    const { db, http, adminMenu, mail } = wordjs;

    console.log('[auctions] initializing plugin...');

    // Every table MUST live under the plugin prefix (host default-deny). 'auctions' -> 'wjp_auctions_'.
    const P = db.tablePrefix;
    const T = {
        auctions: P + 'auctions',
        bids: P + 'bids',
        settings: P + 'settings',
        bidders: P + 'bidders',
    };

    // ---- limits & constants ----------------------------------------------------------------------
    const MAX_MONEY_CENTS = 1000000000000;      // 10^12 cents sanity cap (10 billion units)
    const BID_WINDOW_MS = 60 * 1000;            // rolling rate window
    const BID_MAX_PER_AUCTION = 60;             // INSERTED bids/min per auction (all clients)
    const BID_MAX_PER_CLIENT_AUCTION = 10;      // INSERTED bids/min per client on one auction
    const BID_MAX_PER_EMAIL = 10;               // secondary cap: inserted bids/min per bidder email
    const BID_MAX_CLIENT_ATTEMPTS = 30;         // ALL attempts/min per client (only throttles that client)
    const BID_MAX_GLOBAL = 300;                 // safety net across all auctions (INSERTED bids only)
    const MIN_FORM_ELAPSED_MS = 3000;           // anti-bot: form must be open at least this long
    // A bid may raise the price by at most max_bid_jump_percent (setting; 0 = no cap) of the current
    // price, and always by at least BID_JUMP_MIN_INCREMENTS increments — so one bid can no longer jump
    // to an amount nobody can top.
    const BID_JUMP_PERCENT_DEFAULT = 100;
    const BID_JUMP_PERCENT_MAX = 10000;
    const BID_JUMP_MIN_INCREMENTS = 10;
    // Who may bid (setting bid_verification): 'email' — a bidder proves the address with a code mailed
    // to it (once per browser); 'login' — signed-in accounts only, as their account address; 'none' —
    // anyone (the pre-1.1.0 behaviour). 'email' falls back to 'none' on a site that cannot send mail.
    const BID_VERIFICATION_MODES = ['email', 'login', 'none'];
    const VERIFY_CODE_TTL_MS = 30 * 60 * 1000;
    const VERIFY_CODE_MAX_TRIES = 5;            // wrong codes before a new code must be requested
    const VERIFY_MAIL_PER_HOUR = 3;             // verification codes mailed to one address per hour
    const VERIFY_MAIL_CLIENT_PER_HOUR = 10;     // verification codes one client can have mailed per hour
    const VERIFY_MAIL_SITE_PER_HOUR = 200;      // verification codes the whole site mails per hour
    const VERIFY_CLIENT_ATTEMPTS = 20;          // code checks per client per BID_WINDOW_MS
    const OUTBID_MAIL_PER_HOUR = 10;            // outbid notices mailed to one address per hour
    // The host's own refusals when this site cannot send mail at all (same list as bookings).
    const NO_MAIL_TRANSPORT_RE = [/^Mail server not available$/, /tried to access 'email' \(admin\) without permission/];
    const PUBLIC_LIST_DEFAULT = 12;
    const PUBLIC_LIST_MAX = 50;

    // ---- schema (idempotent — full column set from day 1, ALTER is unavailable) --------------------
    // Portable DDL via the bridge's createTable (INT_PK/INT aliases are translated per driver —
    // raw `INTEGER PRIMARY KEY AUTOINCREMENT` / `TEXT DEFAULT CURRENT_TIMESTAMP` DDL throws on
    // Postgres). Date columns stay TEXT ('YYYY-MM-DD HH:MM:SS' UTC) so string comparison and
    // parseSqlMs work identically on both dialects; created_at is always set explicitly via
    // nowSql() in the INSERTs, so no DB-side default is needed.
    async function initSchema() {
        await db.createTable(T.auctions, [
            'id INT_PK',
            'title TEXT NOT NULL',
            'slug TEXT UNIQUE',
            'description TEXT',
            'image_url TEXT',
            'start_price_cents INT NOT NULL',
            'min_increment_cents INT NOT NULL DEFAULT 100',
            'starts_at TEXT',
            'ends_at TEXT NOT NULL',
            'anti_snipe_min INT DEFAULT 2',
            "status TEXT DEFAULT 'active'",
            'is_published INT DEFAULT 1',
            'created_at TEXT'
        ]);

        await db.createTable(T.bids, [
            'id INT_PK',
            'auction_id INT NOT NULL',
            'token TEXT',
            'bidder_name TEXT NOT NULL',
            'bidder_email TEXT NOT NULL',
            'amount_cents INT NOT NULL',
            'created_at TEXT'
        ]);

        await db.createTable(T.settings, [
            'name TEXT PRIMARY KEY',
            'value TEXT'
        ]);

        // Bidder addresses proven with a mailed code (bid_verification = 'email'). `bidder_key` is the
        // secret the verifying browser keeps and sends with each bid. VARCHAR so the unique index is
        // valid on MySQL.
        await db.createTable(T.bidders, [
            'id INT_PK',
            'email VARCHAR(200) NOT NULL',
            'bidder_key TEXT',
            'code TEXT',
            'code_expires_at TEXT',
            'code_tries INT DEFAULT 0',
            'verified_at TEXT',
            'created_at TEXT'
        ]);
        try {
            await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${P}uidx_bidders_email ON ${T.bidders} (email)`);
        } catch (e) { console.error('[auctions] could not create the bidder index:', e.message); }

        // Index names must also carry the plugin prefix.
        try {
            await db.run(`CREATE INDEX IF NOT EXISTS ${P}idx_bids_auction ON ${T.bids} (auction_id, amount_cents)`);
        } catch (e) { /* already exists / unsupported — non-fatal */ }
    }
    await initSchema();

    // ---- plugin-private settings (currency symbol — display-only, not a secret) -------------------
    async function getSetting(name, fallback) {
        const row = await db.get(`SELECT value FROM ${T.settings} WHERE name = ?`, [name]);
        return row && row.value ? row.value : fallback;
    }
    async function setSetting(name, value) {
        // No `ON CONFLICT ... DO UPDATE` here: the host SQL guard's table-attribution regex
        // misreads the `UPDATE` inside the conflict clause and captures `set` as a table name,
        // denying the statement at runtime. UPDATE-then-INSERT instead; on the (admin-rare) PK
        // race the INSERT throws and we simply retry the UPDATE.
        const val = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [val, name]);
        if (!r || r.changes === 0) {
            try {
                await db.run(`INSERT INTO ${T.settings} (name, value) VALUES (?, ?)`, [name, val]);
            } catch (e) {
                // Concurrent insert won the PK — the row exists now, so the UPDATE sticks.
                await db.run(`UPDATE ${T.settings} SET value = ? WHERE name = ?`, [val, name]);
            }
        }
    }
    const getCurrencySymbol = () => getSetting('currency_symbol', '$');
    const getBidVerification = async () => {
        const v = await getSetting('bid_verification', 'email');
        return BID_VERIFICATION_MODES.includes(v) ? v : 'email';
    };
    const getBidJumpPercent = async () => {
        const n = Number(await getSetting('max_bid_jump_percent', String(BID_JUMP_PERCENT_DEFAULT)));
        return Number.isInteger(n) && n >= 0 && n <= BID_JUMP_PERCENT_MAX ? n : BID_JUMP_PERCENT_DEFAULT;
    };
    /** Highest bid accepted over `currentPriceCents` (null = no cap). */
    const maxBidFor = (currentPriceCents, incCents, jumpPercent) => (jumpPercent > 0
        ? Math.min(MAX_MONEY_CENTS, Math.max(
            currentPriceCents + incCents * (BID_JUMP_MIN_INCREMENTS + 1),
            currentPriceCents + Math.floor(currentPriceCents * jumpPercent / 100)))
        : null);

    // ---- date helpers (UTC 'YYYY-MM-DD HH:MM:SS' everywhere in the DB) ----------------------------
    const SQL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

    /** Parse a stored SQL date string to epoch ms (treated as UTC). NaN when unparseable. */
    function parseSqlMs(s) {
        // NOTE: String.match, NOT regex.exec — the host static validator flags any `.exec()` call
        // whose callee is not a regex literal as a dangerous call and refuses to load the plugin.
        const m = String(s || '').match(SQL_DATE_RE);
        if (!m) return NaN;
        return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    }

    /** Current UTC time in the storage format. */
    function nowSql() {
        return new Date().toISOString().slice(0, 19).replace('T', ' ');
    }

    /**
     * Normalize an incoming date ('YYYY-MM-DDTHH:MM', ISO with Z/ms, or already-SQL) to the storage
     * format. Empty/null -> null. Throws a Spanish error on garbage.
     */
    function toSqlDate(v, label) {
        if (v === undefined || v === null || String(v).trim() === '') return null;
        let raw = String(v).trim().replace('T', ' ');
        raw = raw.replace(/[zZ]$/, '').replace(/\.\d+$/, '').trim();
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) raw = raw + ':00';
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) || isNaN(parseSqlMs(raw))) {
            throw new Error(`Fecha inválida (${label}).`);
        }
        return raw;
    }

    // ---- misc helpers ------------------------------------------------------------------------------
    // No crypto API exists in the sandbox — Math.random tokens; the rate limiter below is the real
    // defense. The token only lets a bidder later reference their own bid, it grants no privileges.
    const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
    function randomToken(len) {
        let out = '';
        for (let i = 0; i < len; i++) out += TOKEN_ALPHABET.charAt(Math.floor(Math.random() * TOKEN_ALPHABET.length));
        return out;
    }

    /** 'Juan Pérez López' -> 'Juan P.' — public bid history never leaks full identity or emails. */
    function truncName(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return 'Anónimo';
        if (parts.length === 1) return parts[0];
        return parts[0] + ' ' + parts[1].charAt(0).toUpperCase() + '.';
    }

    // Bidder- and admin-controlled values (a bidder's name, an auction title, the currency symbol) must
    // be HTML-escaped before they are interpolated into an email body — otherwise any bidder can put
    // markup (a phishing link) into the mail this plugin sends to the bidder they outbid.
    const escHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function fmtMoney(cents, symbol) {
        return (symbol || '$') + ((Number(cents) || 0) / 100).toFixed(2);
    }

    function slugify(s) {
        return String(s || '').trim().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    async function uniqueSlug(base, excludeId) {
        let candidate = base || ('subasta-' + Date.now().toString(36));
        for (let i = 0; i < 6; i++) {
            const clash = excludeId
                ? await db.get(`SELECT id FROM ${T.auctions} WHERE slug = ? AND id != ?`, [candidate, excludeId])
                : await db.get(`SELECT id FROM ${T.auctions} WHERE slug = ?`, [candidate]);
            if (!clash) return candidate;
            candidate = (base || 'subasta') + '-' + randomToken(4);
        }
        return (base || 'subasta') + '-' + Date.now().toString(36);
    }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    /** Integer cents in (0, MAX]; returns the number or null when invalid. */
    function centsOrNull(v, allowZero) {
        const n = Number(v);
        if (!Number.isSafeInteger(n)) return null;
        if (allowZero ? n < 0 : n <= 0) return null;
        if (n > MAX_MONEY_CENTS) return null;
        return n;
    }

    // ---- derived state ------------------------------------------------------------------------------
    /** Lazy auto-transition: active auctions whose end time passed become 'ended'. */
    function endExpired() {
        return db.run(`UPDATE ${T.auctions} SET status = 'ended' WHERE status = 'active' AND ends_at <= ?`, [nowSql()]);
    }

    /** Top bid row (ties resolved to the EARLIER bid) or undefined. */
    function topBid(auctionId) {
        return db.get(
            `SELECT id, bidder_name, bidder_email, amount_cents, created_at
             FROM ${T.bids} WHERE auction_id = ? ORDER BY amount_cents DESC, id ASC LIMIT 1`,
            [auctionId]
        );
    }

    /** Public projection of an auction row + derived pricing/time fields. Never includes emails. */
    function publicView(a, bidCount, topAmount, jumpPercent) {
        const nowMs = Date.now();
        const endsAtMs = parseSqlMs(a.ends_at);
        const startsAtMs = a.starts_at ? parseSqlMs(a.starts_at) : null;
        const start = Number(a.start_price_cents) || 0;
        const inc = Number(a.min_increment_cents) || 0;
        const currentPriceCents = Math.max(start, Number(topAmount) || 0);
        return {
            id: a.id,
            title: a.title,
            slug: a.slug,
            image_url: a.image_url || '',
            start_price_cents: start,
            min_increment_cents: inc,
            currentPriceCents,
            minNextBidCents: currentPriceCents + inc,
            maxNextBidCents: maxBidFor(currentPriceCents, inc, jumpPercent),
            bidCount: Number(bidCount) || 0,
            starts_at: a.starts_at || null,
            startsAtMs: Number.isFinite(startsAtMs) ? startsAtMs : null,
            ends_at: a.ends_at,
            endsAtMs: Number.isFinite(endsAtMs) ? endsAtMs : null,
            anti_snipe_min: Number(a.anti_snipe_min) || 0,
            status: a.status,
            ended: a.status === 'ended' || a.status === 'cancelled' || (Number.isFinite(endsAtMs) && nowMs > endsAtMs),
            timeLeftSec: Number.isFinite(endsAtMs) ? Math.max(0, Math.floor((endsAtMs - nowMs) / 1000)) : 0,
        };
    }

    // ---- in-memory rate limiting (single sandbox child — a Map is sufficient; no req.ip exists) ----
    // key ('c:<clientKey>' attempts | 'ca:<id>:<clientKey>' | 'a:<id>' | 'e:<email>' | 'all') -> { count, first }
    const bidHits = new Map();

    /** Count a hit AND report whether the key exceeded its cap (per-client attempt guard only). */
    function rateLimited(key, max) {
        const now = Date.now();
        const rec = bidHits.get(key);
        if (!rec || now - rec.first >= BID_WINDOW_MS) {
            bidHits.set(key, { count: 1, first: now });
            return false;
        }
        rec.count += 1;
        return rec.count > max;
    }

    /**
     * Claim one unit on every [key, max] window, all or nothing, in ONE synchronous step. Returns a
     * release() that refunds the claim (idempotent), or null when any window is already full.
     * Route handlers run concurrently in the isolate: checking a window first and counting it only
     * after the INSERT let a burst of concurrent bids from one client all pass the check before any
     * was counted, so one client could exceed its per-auction cap and fill the auction's window.
     * A claimed unit is refunded when the bid does not insert, so the shared windows still count
     * only bids that actually landed.
     */
    function claimHits(specs) {
        const now = Date.now();
        const live = [];
        for (const [key, max] of specs) {
            const rec = bidHits.get(key);
            const cur = rec && now - rec.first < BID_WINDOW_MS ? rec : null;
            if (cur && cur.count >= max) return null;
            live.push([key, cur]);
        }
        const held = live.map(([key, cur]) => {
            const rec = cur || { count: 0, first: now };
            if (!cur) bidHits.set(key, rec);
            rec.count += 1;
            return rec;
        });
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const rec of held) rec.count = Math.max(0, rec.count - 1);
        };
    }
    function pruneRate() {
        if (bidHits.size < 500) return;
        const now = Date.now();
        for (const entry of bidHits) {
            if (now - entry[1].first >= BID_WINDOW_MS) bidHits.delete(entry[0]);
        }
        // Per-client keys make the map grow with distinct callers; bound it even when every
        // entry is still fresh (Map iterates in insertion order, so the oldest go first).
        if (bidHits.size > 20000) {
            let excess = bidHits.size - 20000;
            for (const k of bidHits.keys()) { bidHits.delete(k); if (--excess <= 0) break; }
        }
    }

    // =================================================================================================
    // PUBLIC ROUTES
    // =================================================================================================

    // Public callers never see an error's text: a driver's message names tables, columns and
    // constraints. The details go to the server log.
    // ---- mail budgets & bidder verification ---------------------------------------------------------
    // Mails to one address are bounded whatever clients ask (rotating clients defeat a per-client
    // limit). key -> timestamps[] over the last hour; the map is bounded like bidHits.
    const MAIL_WINDOW_MS = 60 * 60 * 1000;
    const mailSentTo = new Map();
    function mailBudget(key, max, peek) {
        const now = Date.now();
        if (!mailSentTo.has(key) && mailSentTo.size >= 20000) {
            for (const [k, ts] of mailSentTo) if (!ts.length || now - ts[ts.length - 1] >= MAIL_WINDOW_MS) mailSentTo.delete(k);
            while (mailSentTo.size >= 20000) mailSentTo.delete(mailSentTo.keys().next().value);
        }
        const ts = (mailSentTo.get(key) || []).filter((t) => now - t < MAIL_WINDOW_MS);
        if (ts.length >= max) { mailSentTo.set(key, ts); return false; }
        if (peek) return true;
        ts.push(now);
        mailSentTo.set(key, ts);
        return true;
    }

    /** Length-independent string comparison for secrets. */
    function safeEqual(a, b) {
        const x = String(a || ''), y = String(b || '');
        let diff = x.length ^ y.length;
        for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
        return diff === 0;
    }

    /** True when `email` was verified and `key` is the bidder key its verification handed out. */
    async function bidderProven(email, key) {
        if (typeof key !== 'string' || key.length < 16 || key.length > 128) return false;
        const row = await db.get(`SELECT bidder_key, verified_at FROM ${T.bidders} WHERE email = ?`, [email]);
        return !!(row && row.verified_at && row.bidder_key && safeEqual(row.bidder_key, key));
    }

    /**
     * Mail a fresh verification code to `email`. Returns 'sent', 'throttled' (the address, the
     * requesting client or the whole site had its share this hour — nothing rotated, nothing sent),
     * 'no-transport' (this site cannot send mail at all) or 'failed'. The mail carries only the
     * site's own text and the code. Codes go to addresses nobody has proven yet, so besides the
     * per-address budget the whole site mails at most VERIFY_MAIL_SITE_PER_HOUR of them.
     */
    async function sendVerifyCode(email, auctionTitle, clientKey) {
        const budgets = [['verify:' + email, VERIFY_MAIL_PER_HOUR], ['verify-site', VERIFY_MAIL_SITE_PER_HOUR]];
        if (clientKey) budgets.push(['verify-client:' + clientKey, VERIFY_MAIL_CLIENT_PER_HOUR]);
        // Check every budget before spending any, so a refusal by one does not use up the others.
        if (!budgets.every(([k, max]) => mailBudget(k, max, true))) return 'throttled';
        for (const [k, max] of budgets) mailBudget(k, max);
        const code = String(await wordjs.crypto.randomInt(0, 100000000)).padStart(8, '0');
        const expires = new Date(Date.now() + VERIFY_CODE_TTL_MS).toISOString().slice(0, 19).replace('T', ' ');
        const setCode = () => db.run(
            `UPDATE ${T.bidders} SET code = ?, code_expires_at = ?, code_tries = 0 WHERE email = ?`,
            [code, expires, email]
        );
        const up = await setCode();
        if (!up || !up.changes) {
            try {
                await db.run(
                    `INSERT INTO ${T.bidders} (email, code, code_expires_at, code_tries, created_at) VALUES (?, ?, ?, 0, ?)`,
                    [email, code, expires, nowSql()]
                );
            } catch (e) { await setCode(); } // inserted concurrently: the unique email decided
        }
        const minutes = Math.round(VERIFY_CODE_TTL_MS / 60000);
        try {
            await mail({
                to: email,
                subject: `Tu código para pujar: ${code}`,
                text: `Tu código para pujar en "${auctionTitle}" es ${code}. Escríbelo en la subasta para confirmar tu correo; caduca en ${minutes} minutos.\n\nSi no intentaste pujar, ignora este correo.`,
                html: `<p>Tu código para pujar en <strong>"${escHtml(auctionTitle)}"</strong> es:</p><p style="font-size:26px;font-weight:bold;letter-spacing:4px">${code}</p><p>Escríbelo en la subasta para confirmar tu correo; caduca en ${minutes} minutos.</p><p style="color:#6b7280;font-size:12px">Si no intentaste pujar, ignora este correo.</p>`,
            });
            return 'sent';
        } catch (e) {
            const msg = String((e && e.message) || e || '');
            if (NO_MAIL_TRANSPORT_RE.some((re) => re.test(msg))) return 'no-transport';
            console.warn('[auctions] verification code not sent:', msg);
            return 'failed';
        }
    }

    const failQuietly = (res, e, what) => {
        console.error(`[auctions] ${what} failed:`, e && e.message ? e.message : e);
        res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
    };

    // Grid data: published active/ended auctions with derived price, bid count and time left.
    http.route('get', '/public/auctions', async (req, res) => {
        try {
            await endExpired();
            let limit = parseInt((req.query && req.query.limit) || PUBLIC_LIST_DEFAULT, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = PUBLIC_LIST_DEFAULT;
            limit = Math.min(limit, PUBLIC_LIST_MAX);

            const rows = await db.all(
                `SELECT a.*,
                    (SELECT COUNT(*) FROM ${T.bids} b WHERE b.auction_id = a.id) AS bid_count,
                    (SELECT MAX(b.amount_cents) FROM ${T.bids} b WHERE b.auction_id = a.id) AS top_amount
                 FROM ${T.auctions} a
                 WHERE a.is_published = 1 AND a.status IN ('active', 'ended')`
            );
            const jumpPercent = await getBidJumpPercent();
            const items = rows.map((a) => publicView(a, a.bid_count, a.top_amount, jumpPercent));
            // Active first (soonest ending on top), then ended (most recent first).
            items.sort((x, y) => {
                const xa = x.status === 'active' ? 0 : 1;
                const ya = y.status === 'active' ? 0 : 1;
                if (xa !== ya) return xa - ya;
                if (xa === 0) return (x.endsAtMs || 0) - (y.endsAtMs || 0);
                return (y.endsAtMs || 0) - (x.endsAtMs || 0);
            });
            res.json({
                auctions: items.slice(0, limit),
                currencySymbol: await getCurrencySymbol(),
                serverNowMs: Date.now(),
            });
        } catch (e) { failQuietly(res, e, 'auction list'); }
    });

    // Detail: one auction + top 10 bid history (names truncated, NEVER emails) + winner when ended.
    http.route('get', '/public/auction', async (req, res) => {
        const slug = String((req.query && req.query.slug) || '').trim();
        if (!slug) return res.status(400).json({ error: 'Falta el parámetro slug.' });
        try {
            await endExpired();
            const a = await db.get(
                `SELECT * FROM ${T.auctions} WHERE slug = ? AND is_published = 1 AND status != 'draft'`,
                [slug]
            );
            if (!a) return res.status(404).json({ error: 'Subasta no encontrada.' });

            const countRow = await db.get(`SELECT COUNT(*) AS c FROM ${T.bids} WHERE auction_id = ?`, [a.id]);
            const top = await topBid(a.id);
            const view = publicView(a, countRow ? countRow.c : 0, top ? top.amount_cents : 0, await getBidJumpPercent());

            const history = await db.all(
                `SELECT bidder_name, amount_cents, created_at
                 FROM ${T.bids} WHERE auction_id = ? ORDER BY amount_cents DESC, id ASC LIMIT 10`,
                [a.id]
            );
            const winner = (a.status === 'ended' && top)
                ? { name: truncName(top.bidder_name), amountCents: top.amount_cents }
                : null;

            res.json({
                auction: { ...view, description: a.description || '' },
                bids: history.map((b) => ({
                    name: truncName(b.bidder_name),
                    amount_cents: b.amount_cents,
                    created_at: b.created_at,
                    createdAtMs: parseSqlMs(b.created_at) || null,
                })),
                winner,
                currencySymbol: await getCurrencySymbol(),
                bidVerification: await getBidVerification(),
                serverNowMs: Date.now(),
            });
        } catch (e) { failQuietly(res, e, 'auction detail'); }
    });

    // Place a bid. Anti-spam (honeypot + min elapsed) -> rate cap -> full server-side validation.
    // Amount must be >= currentPrice + min_increment where currentPrice is re-read from the DB, and
    // within the jump cap. `account` is the signed-in bidder ('/bid-user'), null on the public route.
    http.route('post', '/public/bid', (req, res) => placeBid(req, res, null));
    http.route('post', '/bid-user', { auth: true }, (req, res) => placeBid(req, res, req.user || null));

    async function placeBid(req, res, account) {
        const body = req.body || {};
        let releaseHits = null; // refunded in `finally` unless the bid inserted
        let inserted = false;
        try {
            // --- anti-spam: honeypot must stay empty; the form must have been open a few seconds ---
            if (body.hp) return res.status(400).json({ error: 'No se pudo procesar la solicitud.' });
            const elapsed = Number(body.elapsed);
            if (!Number.isFinite(elapsed) || elapsed < MIN_FORM_ELAPSED_MS) {
                return res.status(400).json({ error: 'Verificación anti-spam: espera unos segundos e inténtalo de nuevo.' });
            }

            const auctionId = parseInt(body.auction_id, 10);
            if (!Number.isFinite(auctionId) || auctionId < 1) {
                return res.status(400).json({ error: 'Subasta inválida.' });
            }

            // --- rate caps. The ONLY counter that sees every attempt is keyed on the caller's
            //     clientKey (an HMAC of the IP forwarded by the host), so a flood of malformed
            //     requests only throttles the client sending it. Every shared bucket (per auction,
            //     per bidder email, site-wide) counts bids that actually INSERTED: it is claimed below
            //     (after validation, before the first await) and refunded if the bid does not land —
            //     otherwise one client could fire cheap invalid requests, 429-lock every legitimate
            //     outbid and win at its own price. ---
            pruneRate();
            const clientKey = String(req.clientKey || '').slice(0, 64);
            if (clientKey && rateLimited('c:' + clientKey, BID_MAX_CLIENT_ATTEMPTS)) {
                return res.status(429).json({ error: 'Demasiadas pujas en este momento. Espera un minuto e inténtalo de nuevo.' });
            }

            // --- input validation ---
            const name = String(body.bidder_name || '').trim();
            // A signed-in bidder bids as the account's own address. The host hands a route the
            // account's address only while this plugin holds users:read; until the administrator
            // grants it, a signed-in bidder types an address and proves it like a guest does.
            const accountEmail = account && typeof account.userEmail === 'string' && account.userEmail.trim()
                ? account.userEmail : null;
            const email = String((accountEmail || body.bidder_email) || '').trim().toLowerCase();
            const amountCents = centsOrNull(body.amount_cents, false);
            if (name.length < 2 || name.length > 120) {
                return res.status(400).json({ error: 'Escribe tu nombre (2 a 120 caracteres).' });
            }
            if (!email || email.length > 200 || !EMAIL_RE.test(email)) {
                // needsEmail: a signed-in bidder whose account address this plugin cannot read yet.
                return res.status(400).json({ error: 'Escribe un correo electrónico válido.', ...(account && !accountEmail ? { needsEmail: true } : {}) });
            }
            if (amountCents === null) {
                return res.status(400).json({ error: 'El monto de la puja es inválido.' });
            }
            // Claim the shared windows and the per-client / per-email ones in one synchronous step
            // (no await since the top of the handler), so concurrent bids see each other's claims.
            // Every bid is held to the shared windows; they count only bids that land, so invalid
            // requests cannot fill them.
            const releaseShared = claimHits([['all', BID_MAX_GLOBAL], ['a:' + auctionId, BID_MAX_PER_AUCTION]]);
            if (!releaseShared) {
                return res.status(429).json({ error: 'Demasiadas pujas en este momento. Espera un minuto e inténtalo de nuevo.' });
            }
            releaseHits = releaseShared;
            const releaseClient = clientKey
                ? claimHits([['ca:' + auctionId + ':' + clientKey, BID_MAX_PER_CLIENT_AUCTION]])
                : () => {};
            if (!releaseClient) {
                return res.status(429).json({ error: 'Demasiadas pujas en este momento. Espera un minuto e inténtalo de nuevo.' });
            }
            releaseHits = () => { releaseShared(); releaseClient(); };
            // Secondary cap keyed on the (validated) bidder email.
            const releaseEmail = claimHits([['e:' + email, BID_MAX_PER_EMAIL]]);
            if (!releaseEmail) {
                return res.status(429).json({ error: 'Has pujado demasiadas veces en un minuto. Espera un momento e inténtalo de nuevo.' });
            }
            releaseHits = () => { releaseShared(); releaseClient(); releaseEmail(); };

            // --- auction state (lazy end first so 'active' below is trustworthy) ---
            await db.run(
                `UPDATE ${T.auctions} SET status = 'ended' WHERE id = ? AND status = 'active' AND ends_at <= ?`,
                [auctionId, nowSql()]
            );
            const a = await db.get(`SELECT * FROM ${T.auctions} WHERE id = ? AND is_published = 1`, [auctionId]);
            if (!a) return res.status(404).json({ error: 'Subasta no encontrada.' });
            if (a.status === 'ended') return res.status(409).json({ error: 'La subasta ya finalizó.' });
            if (a.status !== 'active') return res.status(409).json({ error: 'La subasta no está activa.' });
            const startsAtMs = a.starts_at ? parseSqlMs(a.starts_at) : null;
            if (Number.isFinite(startsAtMs) && startsAtMs !== null && Date.now() < startsAtMs) {
                return res.status(409).json({ error: 'La subasta aún no comienza.' });
            }

            // --- price validation against DB-derived current price ---
            const prevTop = await topBid(a.id);
            const startPrice = Number(a.start_price_cents) || 0;
            const inc = Number(a.min_increment_cents) || 0;
            const currentPriceCents = Math.max(startPrice, prevTop ? Number(prevTop.amount_cents) || 0 : 0);
            const minBidCents = currentPriceCents + inc;
            const symbol = await getCurrencySymbol();
            if (amountCents < minBidCents) {
                return res.status(400).json({
                    error: `La puja mínima es ${fmtMoney(minBidCents, symbol)} (precio actual ${fmtMoney(currentPriceCents, symbol)} + incremento ${fmtMoney(inc, symbol)}).`,
                    currentPriceCents,
                    minBidCents,
                });
            }
            const maxBidCents = maxBidFor(currentPriceCents, inc, await getBidJumpPercent());
            if (maxBidCents !== null && amountCents > maxBidCents) {
                return res.status(400).json({
                    error: `La puja máxima en este momento es ${fmtMoney(maxBidCents, symbol)}.`,
                    currentPriceCents,
                    minBidCents,
                    maxBidCents,
                });
            }

            // --- who may bid (see BID_VERIFICATION_MODES) ---
            const mode = await getBidVerification();
            if (mode === 'login' && !account) {
                return res.status(401).json({ error: 'Inicia sesión para pujar en esta subasta.', loginRequired: true });
            }
            // A typed address must be proven in 'email' and 'login' mode; an account's own address
            // (accountEmail) already is.
            if ((mode === 'email' || mode === 'login') && !accountEmail) {
                const proven = await bidderProven(email, body.bidder_key);
                if (!proven) {
                    const sent = await sendVerifyCode(email, a.title, clientKey);
                    if (sent === 'failed') {
                        return res.status(503).json({ error: 'No se pudo enviar el código de verificación. Inténtalo de nuevo en unos minutos.' });
                    }
                    if (sent === 'sent') {
                        // A mailed code stays charged to this client's own window (only the shared
                        // and per-address windows are refunded), so repeating it is not free.
                        releaseShared();
                        releaseEmail();
                        releaseHits = null;
                    }
                    if (sent !== 'no-transport') {
                        // Same reply whether a code went out or this address already had its share.
                        return res.status(202).json({
                            needsVerification: true,
                            message: 'Para pujar, confirma tu correo: te enviamos un código de 8 dígitos. Si no llega, revisa el spam o espera unos minutos.',
                        });
                    }
                    // This site cannot send mail at all: bidding stays open, as in 'none'.
                }
            }

            // --- guarded single-statement insert: the bid only lands while the auction is still
            //     active, published and before its end time, closing the read-then-write race with
            //     a concurrent endExpired()/end-now (the db bridge has no transactions). Then verify
            //     it is still the MAX (a concurrent higher bid may have landed — in that case ours
            //     simply is not the top, which is acceptable). ---
            const token = randomToken(32);
            const bidNow = nowSql();
            const result = await db.run(
                `INSERT INTO ${T.bids} (auction_id, token, bidder_name, bidder_email, amount_cents, created_at)
                 SELECT ?, ?, ?, ?, ?, ?
                 WHERE EXISTS (SELECT 1 FROM ${T.auctions} WHERE id = ? AND status = 'active' AND is_published = 1 AND ends_at > ?)`,
                [a.id, token, name, email, amountCents, bidNow, a.id, bidNow]
            );
            if (!result || result.changes === 0) {
                return res.status(409).json({ error: 'La subasta ya finalizó.' });
            }
            // A real bid landed: the units claimed on the per-auction / per-bidder windows stay spent.
            inserted = true;
            const newTop = await topBid(a.id);
            const isTop = !!(newTop && result && newTop.id === result.lastID);
            const newPriceCents = Math.max(startPrice, newTop ? Number(newTop.amount_cents) || 0 : 0);

            // --- anti-snipe: extend ends_at when the bid lands inside the final window. Single
            //     guarded statement (SQLite datetime math on the stored 'YYYY-MM-DD HH:MM:SS'). ---
            if (Number(a.anti_snipe_min) > 0) {
                try {
                    const now = nowSql();
                    await db.run(
                        `UPDATE ${T.auctions}
                         SET ends_at = datetime(ends_at, '+' || anti_snipe_min || ' minutes')
                         WHERE id = ? AND status = 'active' AND anti_snipe_min > 0
                           AND ends_at > ?
                           AND datetime(ends_at, '-' || anti_snipe_min || ' minutes') <= ?`,
                        [a.id, now, now]
                    );
                } catch (e) { /* non-SQLite dialect: skip the extension rather than fail the bid */ }
            }
            const fresh = await db.get(`SELECT ends_at FROM ${T.auctions} WHERE id = ?`, [a.id]);
            const endsAt = fresh ? fresh.ends_at : a.ends_at;

            // --- best-effort outbid notice to the PREVIOUS top bidder (bid stands even if mail fails) ---
            // It carries only the site's own text: the stored name was typed by whoever placed that bid.
            if (isTop && prevTop && prevTop.bidder_email && prevTop.bidder_email !== email
                && mailBudget('outbid:' + prevTop.bidder_email, OUTBID_MAIL_PER_HOUR)) {
                try {
                    await mail({
                        to: prevTop.bidder_email,
                        subject: `Te han superado en la subasta "${a.title}"`,
                        text: `Hola,\n\nAlguien superó tu puja en la subasta "${a.title}". El precio actual es ${fmtMoney(newPriceCents, symbol)}. Si quieres seguir participando, vuelve a pujar antes de que termine.\n\n— Subastas`,
                        html: `<p>Hola,</p><p>Alguien superó tu puja en la subasta <strong>"${escHtml(a.title)}"</strong>. El precio actual es <strong>${escHtml(fmtMoney(newPriceCents, symbol))}</strong>.</p><p>Si quieres seguir participando, vuelve a pujar antes de que termine.</p>`,
                    });
                } catch (e) { /* mail provider missing/failing — silently degrade */ }
            }

            res.json({
                success: true,
                isTop,
                currentPriceCents: newPriceCents,
                minNextBidCents: newPriceCents + inc,
                endsAt,
                endsAtMs: parseSqlMs(endsAt) || null,
                token,
            });
        } catch (e) {
            failQuietly(res, e, 'bid');
        } finally {
            if (!inserted && releaseHits) releaseHits();
        }
    }

    // Prove a bidder address with the code mailed to it; the reply carries the bidder key this
    // browser sends with its bids from now on (the same key for every browser the address verifies).
    http.route('post', '/public/verify-bidder', async (req, res) => {
        try {
            const body = req.body || {};
            const clientKey = String(req.clientKey || '').slice(0, 64);
            if (clientKey && rateLimited('v:' + clientKey, VERIFY_CLIENT_ATTEMPTS)) {
                return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.' });
            }
            const email = String(body.bidder_email || '').trim().toLowerCase();
            const code = String(body.code || '').replace(/\s+/g, '');
            if (!email || email.length > 200 || !EMAIL_RE.test(email) || !/^\d{8}$/.test(code)) {
                return res.status(400).json({ error: 'Código no válido.' });
            }
            const row = await db.get(`SELECT * FROM ${T.bidders} WHERE email = ?`, [email]);
            const expired = !row || !row.code || !(parseSqlMs(row.code_expires_at) > Date.now());
            if (expired) return res.status(400).json({ error: 'El código caducó. Vuelve a pujar para recibir uno nuevo.' });
            // Count the try first, in one conditional statement, so concurrent guesses share the budget.
            const tried = await db.run(
                `UPDATE ${T.bidders} SET code_tries = code_tries + 1 WHERE id = ? AND code = ? AND code_tries < ?`,
                [row.id, row.code, VERIFY_CODE_MAX_TRIES]
            );
            if (!tried || tried.changes !== 1) {
                return res.status(400).json({ error: 'Demasiados intentos con este código. Vuelve a pujar para recibir uno nuevo.' });
            }
            if (!safeEqual(code, String(row.code))) return res.status(400).json({ error: 'Código incorrecto.' });
            const key = row.bidder_key || await wordjs.crypto.randomToken(24);
            await db.run(
                `UPDATE ${T.bidders} SET bidder_key = COALESCE(bidder_key, ?), verified_at = ?, code = NULL, code_tries = 0 WHERE id = ? AND code = ?`,
                [key, nowSql(), row.id, row.code]
            );
            const fresh = await db.get(`SELECT bidder_key, verified_at FROM ${T.bidders} WHERE id = ?`, [row.id]);
            if (!fresh || !fresh.verified_at || !fresh.bidder_key) return res.status(409).json({ error: 'Inténtalo de nuevo.' });
            res.json({ success: true, bidder_key: fresh.bidder_key });
        } catch (e) { failQuietly(res, e, 'bidder verification'); }
    });

    // =================================================================================================
    // ADMIN ROUTES
    // =================================================================================================

    /** Validate + normalize an incoming auction payload. `existing` = row being updated (or null). */
    function validateAuctionBody(body, existing) {
        const out = {};
        if (body.title !== undefined || !existing) {
            const title = String(body.title || '').trim();
            if (!title) throw new Error('El título es obligatorio.');
            if (title.length > 200) throw new Error('El título es demasiado largo (máximo 200 caracteres).');
            out.title = title;
        }
        if (body.description !== undefined) out.description = String(body.description || '');
        if (body.image_url !== undefined) {
            const img = String(body.image_url || '').trim();
            if (img.length > 1000) throw new Error('La URL de la imagen es demasiado larga.');
            out.image_url = img;
        }
        if (body.start_price_cents !== undefined || !existing) {
            const v = centsOrNull(body.start_price_cents, true);
            if (v === null) throw new Error('El precio inicial es inválido (usa un número mayor o igual a 0).');
            out.start_price_cents = v;
        }
        if (body.min_increment_cents !== undefined) {
            const v = centsOrNull(body.min_increment_cents, false);
            if (v === null) throw new Error('El incremento mínimo debe ser mayor que 0.');
            out.min_increment_cents = v;
        }
        if (body.starts_at !== undefined) out.starts_at = toSqlDate(body.starts_at, 'inicio');
        if (body.ends_at !== undefined || !existing) {
            const v = toSqlDate(body.ends_at, 'fin');
            if (!v) throw new Error('La fecha de fin es obligatoria.');
            out.ends_at = v;
        }
        if (body.anti_snipe_min !== undefined) {
            const v = parseInt(body.anti_snipe_min, 10);
            if (!Number.isFinite(v) || v < 0 || v > 120) throw new Error('Los minutos anti-sniping deben estar entre 0 y 120.');
            out.anti_snipe_min = v;
        }
        if (body.is_published !== undefined) out.is_published = body.is_published ? 1 : 0;
        if (body.status !== undefined) {
            const s = String(body.status);
            if (s !== 'draft' && s !== 'active') throw new Error('Estado inválido (usa borrador o activa; finalizar/cancelar tienen su propio botón).');
            out.status = s;
        }
        // Cross-field: end must come after start.
        const nextStart = out.starts_at !== undefined ? out.starts_at : (existing ? existing.starts_at : null);
        const nextEnd = out.ends_at !== undefined ? out.ends_at : (existing ? existing.ends_at : null);
        if (nextStart && nextEnd && parseSqlMs(nextEnd) <= parseSqlMs(nextStart)) {
            throw new Error('La fecha de fin debe ser posterior a la de inicio.');
        }
        return out;
    }

    // List all auctions with derived price/bid data (admin cards).
    http.route('get', '/auctions', { auth: true, admin: true }, async (req, res) => {
        try {
            await endExpired();
            const rows = await db.all(
                `SELECT a.*,
                    (SELECT COUNT(*) FROM ${T.bids} b WHERE b.auction_id = a.id) AS bid_count,
                    (SELECT MAX(b.amount_cents) FROM ${T.bids} b WHERE b.auction_id = a.id) AS top_amount
                 FROM ${T.auctions} a ORDER BY a.id DESC`
            );
            const items = rows.map((a) => ({
                ...publicView(a, a.bid_count, a.top_amount),
                description: a.description || '',
                is_published: a.is_published ? 1 : 0,
                created_at: a.created_at,
            }));
            res.json({ auctions: items, currencySymbol: await getCurrencySymbol(), serverNowMs: Date.now() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Create an auction. Slug is derived from the title (unique).
    http.route('post', '/auctions', { auth: true, admin: true }, async (req, res) => {
        try {
            const v = validateAuctionBody(req.body || {}, null);
            // A brand-new ACTIVE auction ending in the past is a mistake, not a backfill.
            if ((v.status || 'active') === 'active' && parseSqlMs(v.ends_at) <= Date.now()) {
                throw new Error('La fecha de fin debe ser futura.');
            }
            const slug = await uniqueSlug(slugify(v.title));
            const result = await db.run(
                `INSERT INTO ${T.auctions}
                    (title, slug, description, image_url, start_price_cents, min_increment_cents,
                     starts_at, ends_at, anti_snipe_min, status, is_published, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    v.title, slug, v.description || '', v.image_url || '',
                    v.start_price_cents, v.min_increment_cents === undefined ? 100 : v.min_increment_cents,
                    v.starts_at === undefined ? null : v.starts_at, v.ends_at,
                    v.anti_snipe_min === undefined ? 2 : v.anti_snipe_min,
                    v.status || 'active',
                    v.is_published === undefined ? 1 : v.is_published,
                    nowSql(),
                ]
            );
            res.json({ success: true, id: result.lastID, slug });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Update an auction (partial — only fields present in the body change).
    http.route('put', '/auctions/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const existing = await db.get(`SELECT * FROM ${T.auctions} WHERE id = ?`, [req.params.id]);
            if (!existing) return res.status(404).json({ error: 'Subasta no encontrada.' });
            const v = validateAuctionBody(req.body || {}, existing);

            const sets = [];
            const params = [];
            for (const key of Object.keys(v)) {
                sets.push(`${key} = ?`);
                params.push(v[key]);
            }
            // Explicit slug regeneration request (slug stays stable on plain edits).
            if (req.body && req.body.regenerate_slug && v.title) {
                const slug = await uniqueSlug(slugify(v.title), existing.id);
                sets.push('slug = ?');
                params.push(slug);
            }
            if (!sets.length) return res.json({ success: true });
            params.push(existing.id);
            await db.run(`UPDATE ${T.auctions} SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Delete an auction and its bids (no FK cascade reliance).
    http.route('delete', '/auctions/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            await db.run(`DELETE FROM ${T.bids} WHERE auction_id = ?`, [req.params.id]);
            await db.run(`DELETE FROM ${T.auctions} WHERE id = ?`, [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Force-end an active auction right now.
    http.route('post', '/auctions/:id/end-now', { auth: true, admin: true }, async (req, res) => {
        try {
            const result = await db.run(
                `UPDATE ${T.auctions} SET status = 'ended', ends_at = ? WHERE id = ? AND status = 'active'`,
                [nowSql(), req.params.id]
            );
            if (!result || result.changes === 0) return res.status(409).json({ error: 'La subasta no está activa.' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Cancel an auction (draft or active). Cancelled auctions have no winner.
    http.route('post', '/auctions/:id/cancel', { auth: true, admin: true }, async (req, res) => {
        try {
            const result = await db.run(
                `UPDATE ${T.auctions} SET status = 'cancelled' WHERE id = ? AND status IN ('draft', 'active')`,
                [req.params.id]
            );
            if (!result || result.changes === 0) return res.status(409).json({ error: 'La subasta ya finalizó o ya está cancelada.' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Full bid list for one auction — emails included (admin only).
    http.route('get', '/bids', { auth: true, admin: true }, async (req, res) => {
        const auctionId = parseInt((req.query && req.query.auction_id) || '', 10);
        if (!Number.isFinite(auctionId)) return res.status(400).json({ error: 'Falta auction_id.' });
        try {
            const bids = await db.all(
                `SELECT id, auction_id, token, bidder_name, bidder_email, amount_cents, created_at
                 FROM ${T.bids} WHERE auction_id = ? ORDER BY amount_cents DESC, id ASC`,
                [auctionId]
            );
            res.json({ bids: bids.map((b) => ({ ...b, createdAtMs: parseSqlMs(b.created_at) || null })) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Remove a bid (fraud/typo cleanup). Price is derived, so nothing else to recompute.
    http.route('delete', '/bids/:id', { auth: true, admin: true }, async (req, res) => {
        try {
            const bid = await db.get(`SELECT id, auction_id FROM ${T.bids} WHERE id = ?`, [req.params.id]);
            if (!bid) return res.status(404).json({ error: 'Puja no encontrada.' });
            await db.run(`DELETE FROM ${T.bids} WHERE id = ?`, [bid.id]);
            const a = await db.get(`SELECT start_price_cents FROM ${T.auctions} WHERE id = ?`, [bid.auction_id]);
            const top = await topBid(bid.auction_id);
            const currentPriceCents = Math.max(a ? Number(a.start_price_cents) || 0 : 0, top ? Number(top.amount_cents) || 0 : 0);
            res.json({ success: true, currentPriceCents });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Fulfillment report: per auction — bid count, top amount and the winner's contact (admin only;
    // the winner email is NEVER exposed on any public route).
    http.route('get', '/report', { auth: true, admin: true }, async (req, res) => {
        try {
            await endExpired();
            const rows = await db.all(
                `SELECT a.id, a.title, a.slug, a.status, a.start_price_cents, a.ends_at,
                    (SELECT COUNT(*) FROM ${T.bids} b WHERE b.auction_id = a.id) AS bid_count,
                    (SELECT b.bidder_name FROM ${T.bids} b WHERE b.auction_id = a.id ORDER BY b.amount_cents DESC, b.id ASC LIMIT 1) AS top_name,
                    (SELECT b.bidder_email FROM ${T.bids} b WHERE b.auction_id = a.id ORDER BY b.amount_cents DESC, b.id ASC LIMIT 1) AS top_email,
                    (SELECT MAX(b.amount_cents) FROM ${T.bids} b WHERE b.auction_id = a.id) AS top_amount
                 FROM ${T.auctions} a ORDER BY a.ends_at DESC`
            );
            res.json({
                report: rows.map((r) => ({
                    id: r.id,
                    title: r.title,
                    slug: r.slug,
                    status: r.status,
                    ends_at: r.ends_at,
                    endsAtMs: parseSqlMs(r.ends_at) || null,
                    bidCount: Number(r.bid_count) || 0,
                    finalPriceCents: Math.max(Number(r.start_price_cents) || 0, Number(r.top_amount) || 0),
                    hasBids: (Number(r.bid_count) || 0) > 0,
                    // Winner exists only for ENDED auctions with at least one bid.
                    winnerName: r.status === 'ended' && r.top_name ? r.top_name : null,
                    winnerEmail: r.status === 'ended' && r.top_email ? r.top_email : null,
                    winnerAmountCents: r.status === 'ended' && r.top_amount ? Number(r.top_amount) : null,
                    // Current leader (useful while active).
                    leaderName: r.top_name || null,
                    leaderEmail: r.top_email || null,
                })),
                currencySymbol: await getCurrencySymbol(),
                serverNowMs: Date.now(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Display settings (currency symbol — not a secret).
    http.route('get', '/settings', { auth: true, admin: true }, async (req, res) => {
        try {
            res.json({
                currencySymbol: await getCurrencySymbol(),
                bidVerification: await getBidVerification(),
                maxBidJumpPercent: await getBidJumpPercent(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    http.route('post', '/settings', { auth: true, admin: true }, async (req, res) => {
        try {
            const body = req.body || {};
            // Each field is optional (absent = keep), so an older admin screen saving only the symbol
            // does not reset the bidding rules.
            if (body.bidVerification !== undefined) {
                if (!BID_VERIFICATION_MODES.includes(body.bidVerification)) return res.status(400).json({ error: 'Modo de verificación no válido.' });
                await setSetting('bid_verification', body.bidVerification);
            }
            if (body.maxBidJumpPercent !== undefined) {
                const n = Number(body.maxBidJumpPercent);
                if (!Number.isInteger(n) || n < 0 || n > BID_JUMP_PERCENT_MAX) {
                    return res.status(400).json({ error: `El salto máximo debe ser un entero entre 0 y ${BID_JUMP_PERCENT_MAX}.` });
                }
                await setSetting('max_bid_jump_percent', String(n));
            }
            if (body.currencySymbol !== undefined) {
                const sym = String(body.currencySymbol || '').trim().slice(0, 8);
                await setSetting('currency_symbol', sym || '$');
            }
            res.json({
                success: true,
                currencySymbol: await getCurrencySymbol(),
                bidVerification: await getBidVerification(),
                maxBidJumpPercent: await getBidJumpPercent(),
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ---- admin menu ---------------------------------------------------------------------------------
    adminMenu.add({
        href: '/admin/plugin/auctions',
        label: 'Subastas',
        // Shown in the admin's language (sidebar); `label` stays for cores without per-language labels.
        labels: { en: 'Auctions', es: 'Subastas', pt: 'Leilões' },
        icon: 'fa-gavel',
        order: 78,
        cap: 'manage_options',
    });

    console.log('[auctions] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — status transitions are lazy, per-request.
    console.log('[auctions] plugin deactivated');
};
