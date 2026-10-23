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

## «Consentimiento en papel» (2.34.0)

For people who sign by hand. It sits alongside the e-mailed code and does not replace it. Coordinators use it in
the portal, for their own locality. Administrators use it in **Conference › Autorizaciones**, for any locality.

1. **Abrir hoja para imprimir o guardar como PDF** makes a sheet for the locality, on Letter («carta», the default) or A4, landscape. Every
   page has:
   - a compact header: the controller, the contact, the purpose, the rights, the policy in force (version, address
     and SHA-256), and ONE authorization, the three configured texts in a single block, which says that health and
     image are voluntary;
   - the people without an authorization yet, then blank rows, as many as fit under the header;
   - the sheet id, the page number and a QR code at the bottom.

   Print it, and have each person write their document and sign once. Whoever does not authorize health data or
   the use of their image marks that box («No autorizo datos de salud» / «No autorizo uso de imagen»); the
   registration goes ahead either way. A minor's parent or legal representative signs for them.
2. **Subir hoja firmada**: upload a photo of each page, or one PDF. Files are kept in the plugin's own table, never
   at a public address, each with the SHA-256 of its bytes. They cannot be replaced or deleted.
3. **Marcar quién firmó**: tick each person who signed. Health and image start authorized; tick the opt-out a
   person marked. Each tick is a signature in the evidence log with `method: 'paper'` and its `opt_outs`, naming
   the sheet, the row, the policy version, the files' hashes, and who uploaded and who ticked. **Deshacer** undoes a wrong tick with a reason. It is a new row; nothing
   is edited.

**Keep the paper originals.** The upload is a copy, and its SHA-256 proves the copy has not changed since. It does
not replace the signed paper. Store the sheets for as long as you keep the evidence.

**Legal basis.** The sheet shows the same authorization texts, policy version and rights as the consent page. It
tells each person that health and image are voluntary, and the separate opt-out boxes let them refuse either one
without affecting their registration. Whether a
handwritten signature on this sheet, plus the uploaded copy, meets your obligations depends on your jurisdiction
and your own policy, so consult your lawyer before relying on it.

## Verbal health authorization (2.34.0)

While a conference asks for «Autorización de datos», coordinators and administrators may enter a person's
«Condiciones de salud» at registration. Administrators also need *Datos de salud › gestionar*. Each entry
requires ticking «La persona me autorizó verbalmente el tratamiento de sus datos de salud, tras informarle que es
voluntario». Without the tick the answer is not saved.

- **What is recorded.**
  - A `verbal_granted` row in the person's evidence log: method `verbal`, scope health, the staff member, the time
    and the policy version, pending written confirmation.
  - Every later entry or change is logged as `health_entered`, with who made it. The answer itself is never in
    the log.
- **It is used at once.** «Datos de salud» holders see it, and meal turns and priority groups use it.
- **Written confirmation.** The person's later signature confirms it: the code, or a paper sheet without the health
  opt-out. This adds a `verbal_confirmed` row linked to the signature. If they sign without health, the answer is
  deleted at once (`health_deleted`), and no later verbal tick can override that written «no».
- **Never confirmed.**
  - Past **Días para confirmar por escrito** (Autorizaciones › Configuración, 15 by default), the person is flagged
    «Autorización verbal sin confirmar por escrito» (in Autorizaciones and in the portal). Nothing is deleted.
  - Autorizaciones counts these and can list only them, so you can follow up.
  - The health purge after the conference still deletes every answer.
- **What the person writes wins.** An answer the person writes on their own consent page replaces the one entered
  for them.

A verbal authorization has to be provable. The written confirmation is that proof, so ask for it promptly.
Whether a verbal authorization meets your obligations is for your own policy and your lawyer to decide.

## Registering without an e-mail (2.35.0)

A conference that asks for «Autorización de datos» no longer needs an e-mail to register someone. A written e-mail
must still be valid, and a field you marked as required stays required.

- **Nothing is sent.** Without an e-mail the person shows «Sin correo» and «Reenviar enlace» is hidden for them. Ask
  for the authorization with «Copiar mensaje» (the person types their e-mail on the consent page) or on the paper
  sheet.
- **Duplicates.** Without an e-mail, the same name plus the same ID document number or phone is refused as a
  duplicate. Write the person's e-mail to tell two people apart.

## Printable stickers (2.36.0)

*Escarapelas › Diseño › Sticker para imprimir* designs the label a sticker printer prints for the physical badge.
Print it from *Personas* (one person, the search shown, a locality or everyone). The PDF has one label per page,
each exactly the label's size.

In the print window:
- choose the sticker printer;
- choose the label size it has loaded (the same as the design);
- set **Márgenes: ninguno** and **Escala: 100 %** (or «Tamaño real»).

Label printers print in black, so design in black and white. The meal group letter appears once «Turnos de
comida» is on and groups are assigned; a person without a group shows nothing there.
