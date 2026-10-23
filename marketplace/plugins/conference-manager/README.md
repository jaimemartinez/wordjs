# Conference Manager — notes for site operators

## «Autorización de datos» (2.33.0)

Each registrant authorizes the processing of their personal data on a single-use page and signs with a 6-digit
code sent to their e-mail. Everything is set in **Conference › Autorizaciones**; nothing needs editing on the
server.

### What each signature proves

Every signature is a row of an append-only log (`wjp_conference_manager_consent_events`): no update and no delete,
a revocation is a new row, and each person's rows form a SHA-256 chain that **Exportar evidencia** checks. A
signature holds:

- the person (name, ID document, registration code, location) and the verified e-mail;
- the server's UTC time and time zone, the browser's time zone and user agent, and the network key (below);
- `text_sha256`: the SHA-256 of the exact text the page showed (conference, policy address and version, the
  representative of a minor, the three authorization texts), with that text;
- `policy_version` and `policy_sha256`: the policy version in force. The settings the page is built from (policy
  address and version, controller, contact e-mail, the three texts) are kept as an append-only snapshot
  (`wjp_conference_manager_consent_policies`), and the export includes each snapshot a person signed so its
  SHA-256 can be recomputed;
- each box (general, health, image), the code's sent and verified times, and the representative of a minor.

**Policy versions are closed once signed.** After anyone signs version `1.0`, its texts, address, controller and
contact cannot change under `1.0`; the panel asks for a new version number. When you edit the policy page itself
(the document at the policy address), give it a new version in the settings too, so later signatures name it.

### The network key must stay stable

An isolated plugin never receives the caller's IP address. The host gives it `clientKey`: an HMAC of the address
(an IPv6 caller's /64) keyed with the install's secret (`jwt.secret` in `backend/wordjs-config.json`, written by
the installer). The log keeps that key. Given an address from another record (a provider's log, an authority's
request), the site's operator can recompute the key and show whether that address produced the signature.

That only works while the secret stays the same. **Do not rotate `jwt.secret`** on a site that holds consent
evidence. If it must be rotated, keep the old value with the evidence export, or the keys recorded before the
rotation can no longer be matched to an address. (Rotating it also signs everyone out.)

### Health data

While the setting is on, health answers exist only for people who ticked the health box, and they write them
themselves. A health revocation deletes them. They are deleted for the whole conference a set number of days after
it ends (30 by default); the evidence stays.

### Mail

Links, codes and confirmations go out through the site's mail plugin (`wordjs.mail`); Conference Manager needs
the **email** permission. Without it registrations still work, the coordinator sees «No se pudo enviar el
correo», and the link can be shared by hand (it is useless without the code sent to the e-mail).
