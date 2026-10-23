# Settings

[Admin guide](README.md) › Settings

**Settings** («Configuración») in the sidebar is for administrators. It is one page of cards with a single
**Save Settings** («Guardar Configuración») button at the bottom, which saves every card at once (**Changes saved
successfully!**). Every value is checked when you save, and the public site follows the new values at once.

The **Performance & Cache** card's Redis server has its own buttons: see [Redis](#performance--cache).

## Links at the top

Five cards open screens of their own:

- **Account email** («Correo de la cuenta») → how password-reset and verification email is sent. See [below](#account-email).
- **Emails** («Correos») → the words and the look of every message the site sends. See [Emails](emails.md).
- **Site address** («Dirección del sitio») → **Manage addresses**. See [Site address and HTTPS](site-address-and-https.md#site-address).
- **Media storage** («Almacenamiento de medios») → **Configure storage**: this server's disk or an S3-compatible
  bucket. See [Media storage](../media-storage.md).
- **Network of sites** («Red de sitios») → **Network**: run several sites from one install. See [Multisite](../multisite.md).

When the site cannot send password-reset email yet, a banner says **Password recovery is unavailable** and
points to Account email.

## General

- **Site Logo** and **Site Icon** (the favicon): **Select Logo** / **Select Icon** opens the media picker.
- **Site Title** («Título del Sitio») and **Tagline** («Descripción corta»).
- **Admin Email** («Correo del Administrador»): where site notices go, including the
  [comment moderation emails](comments.md#notification-emails). It changes as soon as you save, so check it.
- **Site language** («Idioma del sitio»): the language of the public site (the admin's own language is chosen in
  the sidebar).
- **Time zone** («Zona horaria»): dates of posts and comments on the site are shown in it.
- **Date format** («Formato de fecha»): **The site language's own** or a fixed format, shown with today's date.
- **Time format** («Formato de hora»): **No time**, **5:30 pm** or **17:30**, shown next to comment dates.
- **Week starts on** («La semana empieza el»): the first day of the week in the admin's calendars, such as the
  [date picker](content.md#the-date-picker). Monday by default.
- **Text direction** («Dirección del texto»): **From the language (recommended)**, left to right, right to left,
  or detected per content.

## Reading & Discussion

«Lectura y discusión»:

- **Homepage Display** («Mostrar página de inicio»): **Default (Latest Posts)**, or one of your pages for a static
  front page.
- **Posts per Page**: 1 to 1000.
- **Posts page** («Página de entradas»): with a static front page, the page that lists the latest posts.
- **Posts in the RSS feed**: 1 to 100.
- **Discourage search engines from indexing this site** («Pedir a los buscadores que no indexen el sitio»): the
  site's `robots.txt` then disallows everything and every page says `noindex`. Search engines usually honour it,
  but they do not have to.
- **Membership**: anyone can register. When on, **New User Default Role** sets their role (only roles that cannot
  run the site are offered), and **Verify email on sign-up** makes new users confirm their address first.
- **Enable Comments Globally**: off, nobody can comment anywhere.
- **Registered Comments**: only signed-in users can comment.
- **Comment notifications by email**: the two switches described in [Comments](comments.md#notification-emails).
- **Keep old author URLs working**: keeps author addresses from before an earlier upgrade. Leave it off unless old
  links matter; the card explains why.

## Writing & comments

«Escritura y comentarios»:

- **Default post category**: the category a post gets when none is chosen.
- **Comments on new entries**: **Open** or **Closed** for new posts.
- **Comment authors without an account must give a name and email.**
- **Hold every comment for moderation** («Retener todos los comentarios para moderación»). When this is **off**, two
  more rules appear, and a comment is published at once unless one of them holds it:
  - **The author must have a previously approved comment.** A first-time commenter waits for approval.
  - **Hold a comment with this many links or more** (0 = no link limit).

Administrators' and editors' own comments are always published at once.

## Media

- **Maximum upload size (MB)**: 1 to 2048; empty uses the default. It applies when you save, with no restart.
- **Image sizes** («Tamaños de imagen»): the maximum width and height of the **Thumbnail**, **Medium** and
  **Large** copies made of each uploaded image. They apply to new uploads.

## Performance & Cache

«Rendimiento y caché»:

- **Redis Object Cache**: caches database objects in Redis. Saved with **Save Settings**.

Below it, the **Redis server** box says what is going on:

- **Connected to Redis at host:port** when it works;
- **Redis is set to …, but it is not answering** when the server is set but not reachable;
- **No Redis server: the cache uses this server's memory and the database. Several servers need Redis.** when
  none is set.

To connect one:

1. Tick **Use a Redis server** («Usar un servidor Redis»).
2. Fill in **Host**, **Port** (6379), **DB** (0) and, if it has one, **Redis password**. An existing password is
   kept if you leave the box empty; **Remove the stored password** deletes it.
3. Press **Test connection** («Probar conexión»). **Redis answers. Save to start using it.**, or the reason it does
   not: nothing listening at that host and port, no answer in time, password refused, unknown host name.
4. Type **Your current password** and press **Save and restart** («Guardar y reiniciar»). WordJS restarts by itself
   to connect (a few seconds) and the page reloads. If WordJS was not started by something that restarts it, the
   message asks you to restart it once.

This box is shown to administrators of the main site only.

## Other settings screens

These have their own sidebar entries:

- **AI**: the AI provider for the editor's suggestions; see [AI provider](../ai-provider.md).
- **Backups** («Copias de seguridad»): **Create Backup**, an **Automatic Schedule** and how many to keep; see
  [Tutorial 15](../tutorials/15-backups-restore-and-upgrades.md).
- **Motions** («Movimientos»): the site's motion library.
- **Security**: certificates, HTTPS and two-factor rules; see [Site address and HTTPS](site-address-and-https.md).

## Account email

**Settings → Account email** decides how password-reset and verification links are sent:

- **Built-in transport (SMTP relay)**: **Mail server**, **Port**, **Security** (STARTTLS, TLS or None), **Username**,
  **Password**, **From address** and **From name**. Saving asks for **Your password**. **Send test** sends a test
  message to the address you type.
- **Mail provider plugin**: a plugin that sends mail can send these links only if you press **Allow for
  account email**.

The words of these messages, and the layout they are sent in, are edited in [Settings → Emails](emails.md).
