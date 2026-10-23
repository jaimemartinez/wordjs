# Admin guide

How to run a WordJS site from the admin panel: everything a site owner or an editor does at
`https://<your-site>/admin`, screen by screen. It describes WordJS 2.9 as it is on screen.

Installing, upgrading and operating the server are in the [operator documentation](../README.md#operating-and-deploying);
step-by-step walkthroughs are in the [tutorials](../tutorials/README.md).

## The panel's language

The admin speaks English, Spanish or Portuguese. Pick yours with the language switcher at the bottom of
the sidebar (**EN English**, **ES Español**, **PT Português**). The choice is yours alone; it does not change
the public site's language (that is **Site language** in [Settings](settings.md#general)).

This guide gives each label in English and, the first time it appears, in Spanish too:
**Move to…** («Mover a…»). A few messages that come straight from the server are English in every
language; the guide says so where it matters.

## Who can do what

The default roles, from most to least:

| Role | Can |
|---|---|
| Administrator («Administrador») | Everything: users, plugins, settings, security, menus. |
| Editor («Editor») | Publish and edit anyone's posts and pages, upload and organise media (including renaming and deleting folders), moderate comments, manage categories and tags. |
| Author («Autor») | Write and publish their own posts, upload media and move their own files into folders. |
| Contributor («Colaborador») | Write their own posts and send them for review; no uploads. |
| Subscriber («Suscriptor») | Read, and manage their own account. |

**Users → Roles** («Roles») lets an administrator create roles with their own capabilities. Plugins can add
roles too; those only reach the plugin that declared them.

## Never a browser pop-up

Every confirmation, question and warning opens inside the panel, in your language: WordJS never uses the
browser's own `alert`/`confirm`/`prompt` boxes, and forms check their fields themselves and say what is
wrong under the field. If you ever see a browser pop-up while using the admin, it is a bug: please report it.

## Pages in this guide

| Page | What it covers |
|---|---|
| [Signing in and your account](account.md) | **Remember me**, two-factor, your picture, your email, your password, downloading or deleting your data |
| [Media library](media.md) | Uploading, folders, moving files, the file details, editing images, the editor's media picker |
| [Posts, pages, categories and tags](content.md) | The post settings, the date picker, scheduling, creating tags from the editor, the Categories and Tags screens |
| [Menus](menus.md) | Adding pages, posts, categories, tags and links; submenus; new tab; menu locations |
| [Comments](comments.md) | Moderating, threaded replies on the site, the moderation rules and the notification emails |
| [Users](users.md) | Adding and editing users, bulk role changes and deletions, what happens to a deleted user's content |
| [Settings](settings.md) | General (including **Week starts on**), Reading & Discussion, Writing & comments, Media, Performance & Cache (Redis) |
| [Plugins](plugins.md) | Installing from the Marketplace or a ZIP, permissions, activating, deactivating and deleting |
| [Site address and HTTPS](site-address-and-https.md) | The certificate form, **Automatic Certificate Renewal** for several names, the HTTPS switch, Site address |
| [Conference Manager](conference-manager.md) | The plugin's admin screens: the **Needs lodging** field, fee payments, meals and badges |

The visual editor itself has its own tutorial: [Your first page with the Verso editor](../tutorials/05-your-first-page-with-verso.md).
