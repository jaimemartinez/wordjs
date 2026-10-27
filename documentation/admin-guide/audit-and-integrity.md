# Audit log and duplicate records

Two screens that keep the site's own records trustworthy. Both are for administrators.

## Audit (Auditoría)

**Admin → Audit** lists every security-relevant change: who did what, to what, and when. Nobody can edit
or delete an entry from the panel.

### Integrity («Integridad»)

Each entry is sealed into a chain: it carries a fingerprint (hash) of itself and of the entry before it.
The card checks the whole chain when the screen opens; **Check again** («Comprobar de nuevo») runs it again.

- **Chain intact** — every entry matches its fingerprint.
- **The chain breaks at entry N** — entry N was changed, or the one before it was removed, outside WordJS
  (directly in the database). Compare with the external copy below. Site Health shows the same warning.

### Keep events for («Conservar registros»)

Entries older than the chosen period are removed once a day: 90 days, 6 months, 1 year (the default),
2 years or **Forever**. Choosing a **shorter** period removes evidence, so the panel asks for your password
(and a code from your authenticator app if you use two-factor) before saving it. A longer period or
**Forever** saves at once.

### External copy («Copia externa»)

Sends every entry, as it is written, outside the site — so whatever the log records cannot be erased from
here, even by an administrator.

- **Syslog**: the server's name or address, the port (514; 6514 for TLS) and the transport: **TLS
  (encrypted)**, **TCP** or **UDP**.
- **HTTPS webhook**: the address, and optionally a **signing secret**: each delivery then carries an
  `X-WordJS-Signature-256` header (HMAC-SHA256 of `timestamp.body`, timestamp in `X-WordJS-Timestamp`).
- **The receiver is on a private network**: tick it when the receiver has an internal address
  (10.x, 192.168.x, a name that resolves to one). Unticked, only public addresses are used.

**Send a test** («Enviar una prueba») sends one test event without saving. **Save the copy** asks for your
password. The copy starts with the entries written from then on. If the receiver is down, entries wait and
are sent when it answers again (**Send now** sends them at once); the card and Site Health say how many
are waiting and why the last delivery failed. Each event includes its number in the chain (`seq`) and its
fingerprints (`prevHash`, `rowHash`), so the receiver can spot a missing or repeated one.

## Duplicate records («Registros duplicados»)

The database itself makes sure that two accounts never share a login or an email address, that two pages
(or two posts) never share an address, and that two categories or tags never share a slug. On a site that
already stored such duplicates before, it cannot do that until they are resolved. **Site Health** then
shows *Unique logins, emails and slugs* as a warning with a link here.

Each repeated value is listed with its records. Choose the one that **keeps the value**, enter your
password, and click **Resolve** («Resolver»). The others get a new value, and nothing is deleted:

| Repeated | The others become | Kept |
|---|---|---|
| Login | `login-<id>` | the previous login, on the account; they can still sign in with their email |
| Email address | `name+dup<id>@domain` — the same mailbox | the previous address, on the account |
| Page or post address | the slug with a number (`about-2`) | — |
| Category or tag slug | the slug with a number (`news-2`) | — |

Every change is listed under **Changes made** and written to the audit log. As soon as nothing repeats, the
rule is enforced again — no restart needed. While two accounts share a login or an email, neither of them
can sign in (or reset a password) with it; each can still use what is unique to it.
