# Emails

[Admin guide](README.md) › Emails

**Settings → Emails** («Correos») holds every message the site sends by email: the subject and the words of
each one, in each language, and the layout they are all sent in. It is for administrators. Open it from the
**Emails** card at the top of [Settings](settings.md).

How the messages are delivered is a different screen: password-reset and verification email goes through
[Settings → Account email](settings.md#account-email); comment notices and the site-address notice go through
the site's mail plugin.

## The messages

The list on the left groups the messages:

| Group | Message | Sent |
|---|---|---|
| Accounts | **Email verification** | To someone who signs up, with the link that creates the account. |
| Accounts | **Sign-up with an existing address** | To the owner of an address when someone tries to create a second account with it. |
| Accounts | **Password reset** | When someone asks to reset a password, with the single-use reset link. |
| Accounts | **Account email test** | By **Send test** in Settings → Account email. |
| Site | **Site address changed** | To the **Admin Email** when the site's address changes. It never carries a link. |
| Comments | **Comment awaiting moderation** | To the **Admin Email** when a comment is held (see [Comments](comments.md#notification-emails)). |
| Comments | **New comment on your entry** | To an entry's author when a comment on it is published. |

A lock next to a message marks a **security message** (sign-in mail and the site-address notice): saving or
resetting its text asks for **Your current password**. **Edited** marks a message you changed in at least one
language. Plugins can add their own messages here; they appear under **Plugins**.

## Editing a message

Pick the message, then its language: **Spanish**, **English** or **Portuguese** (a dot marks the languages you
edited). Each language has its own text; a language you never edited keeps the default text.

- **Subject** («Asunto»): one line of plain text.
- **Message** («Mensaje»): the body. Write as in the editor: **Enter** starts a new paragraph, and selecting text
  shows a small toolbar for **bold**, *italic*, a link, bulleted and numbered lists, and clearing the format.
  There is no HTML to write. Images, colours and scripts are not kept: when you save, the text is reduced to
  paragraphs, emphasis, lists and links (http, https and mailto). The **Site address changed** message keeps no
  link at all, because a notice like that is exactly what a phishing email would copy.
- **Values you can insert** («Datos que puedes insertar»): click one to put it where the cursor is, in the subject
  or the message. `{site_name}` becomes the site title, `{user_name}` the account's username, `{expires}` how
  long the link lasts («30 minutes»), and so on; each message lists its own. A value is always shown as text,
  never as formatting or a link, whoever chose it. A `{word}` that is not in the list stays as it is.
- **Button text** («Texto del botón»), for messages that have a button. The button's **link** is not part of the
  text: the site adds it when it sends the message (for a password reset, the single-use reset link), together
  with a line saying «If the button does not work, copy this address into your browser:» and the address. You
  cannot remove it or change where it points, and no other part of the message can contain it.

**Save** («Guardar») stores this language's text. **Send a test to me** («Enviarme una prueba») sends the text
you see, saved or not, to your own account's email, with sample values and a harmless sample link, through the
same transport the real message uses: Account email for the account messages, the site's mail plugin for the
others (without one, the test says so). **Reset to default** («Restablecer el texto original») asks first, then
goes back to the default text of this language.

The messages are written in the reader's language when the site knows it: the account messages follow the
language of the person who filled the sign-up or reset form; the others use the **Site language** of
[Settings → General](settings.md#general).

Every change and reset is written to the audit log (the message and the language, never the text).

## The preview

**Preview** («Vista previa») shows the message as it will arrive, with the text you are writing (before you
save it) and sample values. **Desktop** / **Mobile** changes the width, **Light** / **Dark** shows it in a mail
app set to a dark theme, and **Plain text** shows the text-only version that is sent with every message (mail
apps that do not show HTML display that one). Both versions always say the same thing: the text one is made from
the same message.

## The layout

**Email layout** («Diseño de los correos») is the same for every message: the site logo (or the site title) at
the top, the message on a white card, the button, and at the bottom «This message was sent by …» with the site
address (as text, not a link).

- **Button colour** («Color del botón»): the button and the links. Left at the theme's colour, it follows the
  primary colour of the active theme.
- **Background colour** («Color de fondo»): behind the card. Light grey by default.
- **Footer line** («Línea al pie»): one optional line of text under the site address, such as your postal address.
- **Show the site logo** («Mostrar el logo del sitio»): uses the **Site Logo** of Settings → General; without a
  logo, or with this off, the header shows the site title.

**Save the layout** («Guardar el diseño») applies it to every message. **Use the theme colours** clears both
colours. The preview shows layout changes before you save them.
