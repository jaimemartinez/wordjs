# Site address and HTTPS

[Admin guide](README.md) › Site address and HTTPS

Your site's address, its certificate and whether it serves HTTPS are all set from the panel, by an
administrator. On a network of sites, only a network administrator on the main site sees these screens.

The operator's reference, with every rule, the command line and proxies, is [site-address.md](../site-address.md).

## Security Center

**Security** («Seguridad») in the sidebar opens the **Security Center** («Centro de seguridad»). Its cards, in
order: **SSL / HTTPS Configuration**, **Automatic Certificate Renewal**, **Gateway Configuration**, **Server** and
**Two-Factor Enforcement**.

### A certificate for one name

The **SSL / HTTPS Configuration** card orders or installs a certificate for **one** domain name:

1. **Domain Name** («Nombre de dominio»): one name, such as `example.com`.
2. **Email (for Let's Encrypt)**: filled in with the **Admin Email** of Settings when there is one.
3. **Validation Method** («Método de validación»):
   - **HTTP-01 (Auto)**: the fastest; port 80 must be reachable from the internet.
   - **DNS-01 (Manual)**: for a server behind a firewall, or a wildcard name (`*.example.com`). WordJS shows a TXT
     record (**DNS Action Required**) to add at your DNS provider; then press **Check Propagation** until it is
     found, and the certificate is finished by itself.
   - **Custom Upload**: your own **Private Key** and **Certificate** files (PEM). The Domain Name and Email still
     have to be filled in.
4. Press **Start Provisioning** («Iniciar aprovisionamiento»). The black box below shows each step.

The form checks the name before sending anything. A red box titled **Check the domain name** («Revisa el nombre
de dominio») explains the problem:

- **Several names** (`example.com, www.example.com`): **This form orders a certificate for one name. To cover
  several names (such as example.com and www.example.com) with one certificate, list them, separated by commas,
  in Automatic Certificate Renewal below.** The link **Go to Automatic Certificate Renewal** takes you there.
- **A wildcard with HTTP-01**: **A wildcard name (`*.example.com`) can only be validated over DNS: choose the
  DNS-01 method.**
- **Not a domain**: **"…" is not a domain name. Enter one such as "example.com".**

The certificate in use is shown in the **Gateway Configuration** card, under **Current Active Certificate**.

### Automatic Certificate Renewal: one certificate for several names

The **Automatic Certificate Renewal** («Renovación automática de certificados») card keeps a Let's Encrypt
certificate renewed by itself, and is the place to cover several names with one certificate:

- **Automatic renewal**: the on/off switch.
- **Account email**: Let's Encrypt sends expiry notices there.
- **Renew before expiry (days)**: 30 by default. WordJS checks twice a day.
- **Domain(s)** («Dominio(s)»): the names, separated by commas, such as `example.com, www.example.com`. They all go
  into one certificate; the first is its primary name. Empty uses the host of the site's main address.
- **Port 80 listener**: usually `80`. WordJS answers the Let's Encrypt challenge there and redirects everything else
  to HTTPS. Empty = off. It applies within seconds, with no restart.
- **Use Let's Encrypt staging**: for testing only; it issues certificates browsers do not trust.

Press **Save auto-renewal** («Guardar renovación automática»). Turning it on asks for an account email and at least
one domain. With the switch on, a check starts at once; adding a name the current certificate does not cover
renews it straight away.

**Next scheduled check** and **Last renewal** say when it runs and how the last attempt went. **Renew now** renews
immediately with the saved settings, even when the switch is off.

Renewal validates over HTTP-01, so `http://<domain>/.well-known/acme-challenge/` must be reachable on port 80
(set **Port 80 listener**, or put a reverse proxy in front). Otherwise use the DNS-01 or custom upload flows of
the card above.

### Turning HTTPS on or off

The **Gateway Configuration** card holds the port and the **Enable SSL / HTTPS** switch. Saving a change of
protocol asks first, because a proxy or tunnel in front of the site that speaks the other protocol stops reaching
it. After saving, a message says what happened to the main address: when the same host moves from `http` to
`https` the main address follows by itself; otherwise WordJS suggests a change in Site address.

On a single-process install (**Monolith mode**), the card shows the **Public Port** and the switch, and saving
restarts WordJS by itself within a few seconds; open the panel at the new address afterwards if it changed. A
port or HTTPS setting fixed by the service's `PORT` or `WORDJS_HTTP=1` variables is shown read-only, and is
changed where the service is started.

If HTTPS is on but there is no certificate yet, the card says so and offers **Generate a self-signed certificate**.

### Server

**Reverse proxy in front of WordJS** tells WordJS to trust a proxy (nginx, Caddy, Apache…) so that sign-in lockouts,
rate limits and the audit log see each visitor's real address; **Log level** sets how much the server log says.
**Save and restart** asks for **Your current password** and restarts WordJS by itself.

### Two-Factor Enforcement

Tick the roles that must use two-factor authentication. Their members get a **Grace period (days)** to turn it on
in [My Account](account.md#two-factor-authentication), and after that cannot open the admin until they do (0 =
right away). **Also enforce for personal API tokens** extends the rule to their tokens. Press **Save policy**.

## Site address

**Settings → Site address → Manage addresses** opens **Site address** («Dirección del sitio»). The top line says
which address you are connected through.

Every change on this screen asks you to **Confirm with your password** («Confirma con tu contraseña»), is recorded
in the audit trail, and is announced to every administrator.

### Main address

The **Main address** («Dirección principal») is used in every link, email, feed and sitemap, and by plugins.
**Change…** opens **Change the main address**:

1. Pick one of the other addresses, or type a new one (`https://www.example.com`, no path).
2. If the host name changes, choose **What happens to the current address**: **Keep answering on it
   (recommended)**, **Redirect it to the new address** or **Stop answering on it**.
3. Read **Before you continue**: links already emailed keep the old address; the new address needs a valid
   certificate; and, in red, a move from HTTPS to plain HTTP, or dropping the address you are using now.
4. Press **Change main address** and confirm with your password.

### Other addresses

**Other addresses** («Otras direcciones») are addresses the site also answers on; they are never used in links.
**Add address** («Añadir dirección») asks for:

- **Address**: `http(s)://name[:port]`, no path.
- **Label (optional)**.
- **Behaviour**: **Serve** the site there, or **Redirect to the main address**.
- **Expires** («Caduca»): a date in the [date picker](content.md#the-date-picker), or **No expiry**. The address stops
  working at the end of that day. Tunnel names (ngrok, trycloudflare…) expire after a week by default.
- **Allow signing in on this address**, shown only for risky addresses (an IP, a tunnel name, a `.local` name, or
  plain `http` on an HTTPS site), with the risk explained.

Each row offers **Make main**, **Edit** and **Remove**. Removing the address you are using right now warns that
you will lose access through it.

### Always accepted and Recently refused

**Always accepted** lists what the site answers on anyway: `localhost` from the server itself, the server's own
addresses, and the **IP addresses** policy (**Any IP address**, **Only this server's addresses**, **None (names
only)**).

**Recently refused** lists addresses the site turned away, with a hint for each. **Add as address…** adds one
in a click; add only names whose DNS you control.

A visitor who reaches the site at an address it does not answer sees a bar: **This site doesn't answer at …**, with
a link to the main address.
