# Comments

[Admin guide](README.md) › Comments

## On the site

Under a post that allows comments, readers see the approved comments, threaded: a reply is indented under the
comment it answers. Each comment has a **Reply** button that scrolls to the form and shows **Replying to
<name>** with **Cancel reply**.

The form, **Leave a Reply**, asks a visitor for **Name**, **Email**, **Website** and **Comment**; a signed-in
user only writes the comment (**Commenting as <name>**). After **Post Comment**:

- **Your comment is published.** when the comment is approved at once; it appears without reloading.
- **Comment submitted successfully! It awaits moderation.** when it is held for you to review.

The comment section's texts are in English whatever the site's language.

Which comments are held, and whether a visitor must sign in, is set in
[Settings](settings.md#reading--discussion). To close comments on one post, set **Allow Comments** to **No**
in its [post settings](content.md#the-post-settings).

## Moderating

**Comments** («Comentarios») in the sidebar, for administrators and editors. The tabs filter the list: **All**
(«Todos»), **Pending** («Pendientes»), **Approved** («Aprobados»), **Spam** and **Trash** («Papelera»). Pending
comments are tinted yellow.

Each row shows the **Author** (name, email, website), the **Comment**, **In Response To** (the post; a published
one opens on the site) and the **Date**. The actions depend on the comment:

| The comment is | Actions |
|---|---|
| Pending | **Approve** («Aprobar»), **Spam**, **Trash** («Papelera») |
| Approved | **Unapprove** («Desaprobar»), **Spam**, **Trash** |
| Spam | **Not spam** («No es spam»), **Delete Permanently** («Eliminar permanentemente») |
| In the trash | **Restore** («Restaurar»), **Delete Permanently** |

**Unapprove**, **Not spam** and **Restore** all put the comment back in **Pending**. **Delete Permanently** asks
first and cannot be undone.

To answer a comment, use its **Reply** button on the site while signed in. The admin list has no reply or bulk
actions.

## Notification emails

In [Settings → Reading & Discussion](settings.md#reading--discussion), **Comment notifications by email**
(«Avisos de comentarios por correo») has two switches, both on by default:

- **Email me when a comment is held for moderation (to the administration email).** A held comment sends one
  email to the **Admin Email** of [Settings → General](settings.md#general), with a link to review it in the admin.
- **Email the entry's author when a comment is published.** A comment published at once sends one email to the
  author of the post, unless they wrote the comment themselves.

The emails are sent only when the comment arrives: approving a held comment later sends nothing. They need a
mail plugin (such as Mail Server, see [Tutorial 16](../tutorials/16-send-email-from-your-site.md)); without one,
the settings say **No mail plugin is active on this site, so no notification will be sent.**
