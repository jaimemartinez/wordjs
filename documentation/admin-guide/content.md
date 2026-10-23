# Posts, pages, categories and tags

[Admin guide](README.md) › Posts, pages, categories and tags

Posts and pages are written in **Verso**, the visual editor. How to build a page from blocks and edit text on
the canvas is in [Tutorial 5](../tutorials/05-your-first-page-with-verso.md); this page covers the settings
around the content.

## The post settings

Open a post (**Posts** → a title, or **New Post**). With no block selected (press **Esc** until nothing is
selected, or click outside the blocks), the panel on the right is titled **Post** («Entrada») and shows:

| Field | What it does |
|---|---|
| **Title** («Título») | Required before saving. |
| **Slug (Permalink)** («Slug (Enlace permanente)») | The address. It follows the title until the post is first published or scheduled; after that, changing the title no longer changes the address. |
| **Featured image** («Imagen destacada») | **Select…** opens the media picker; the × removes the image. |
| **Excerpt** («Extracto») | A short summary for listings and the search-engine description. |
| **Category** («Categoría») | One category, or **Default category** («Categoría por defecto»). Categories are created in [Categories](#categories). |
| **Tags** («Etiquetas») | See [Tags in the editor](#tags-in-the-editor). |
| **Allow Comments** («Permitir comentarios») | **Yes** / **No** for this post. |
| **Password (empty = public)** | Readers must type it to see the post. |
| **Stick to the top of the blog** | Keeps the post first in the list of posts. |
| Theme template | The list that reads **Default (theme hierarchy)**: which of your theme's templates shows this post. |
| SEO (🔍) | **SEO title (60 characters max)**, **Meta description (160 characters max)**, **Social image URL** and **Hide from search engines** (**No (indexable)** / **Yes (hidden)**). |

A page has the same settings except **Category**, **Tags**, **Allow Comments** and **Stick to the top of the blog**.

## Status, date and publishing

The editor's top bar holds the status, the date and the main button. On a narrower screen the status and the
date move into **More options** («Más opciones»).

**Status** («Estado de publicación»): **Draft** («Borrador»), **Publish** («Publicar»), **Pending**
(«Pendiente», waiting for review) or **Scheduled** («Programada»).

The main button follows the status: **Save** for a draft, **Publish** for Publish or Pending, **Schedule** for
Scheduled; once there is nothing left to save it reads **Published** or **Scheduled** with a tick. Drafts are
also saved automatically as you work.

Authors' and contributors' limits apply: someone who cannot publish gets **Pending** when they choose Publish
or Scheduled.

### The date picker

The date shows in the top bar for a post that already has a date, or as soon as you choose **Scheduled**.
Click it to open the calendar:

- The arrows move by month (**Previous month** / **Next month**) and the double arrows by year.
- The week starts on the day set in [Settings → General → Week starts on](settings.md#general) (Monday by default).
- Click a day, then set the **Time** («Hora»): hours (0–23) and minutes (0–59).
- **Today** («Hoy») jumps to today; **Done** («Listo») closes the calendar.
- From the keyboard: the arrow keys move between days, **Enter** or **Space** picks one, **Page Up** / **Page
  Down** change the month (with **Shift**, the year), and **Esc** closes. On a phone the calendar opens as a
  sheet from the bottom of the screen.

The same calendar is used everywhere the admin asks for a date (for example the expiry of an address in
[Site address](site-address-and-https.md#other-addresses)); there it also has **Clear** («Borrar») to leave the
date empty.

### Scheduling a post

1. Set the status to **Scheduled**. If the post had no future date, it gets one an hour from now.
2. Pick the day and time in the calendar. Days before today cannot be chosen.
3. Press **Schedule**.

The post is published by itself at that time. If the time you chose has already passed when you save, it is
published at once. Without a date, saving says **Pick a date and time to schedule publishing.** To publish a
scheduled post now, set the status to **Publish** and press **Publish**.

## Tags in the editor

The **Tags** field lists the post's tags as chips; the × on a chip removes it.

- **Choose a tag** («Elige una etiqueta») adds an existing tag.
- To create one, type its name in **New tag** («Nueva etiqueta») and press **Enter** or **Add** («Añadir»). If a
  tag with that name already exists (in any capitalisation), it is used instead of creating a twin. A comma does
  not split names: add one tag at a time.

Creating tags here is for administrators and editors (anyone who can manage categories); authors and
contributors can only choose existing tags. A new tag is created as soon as you add it, even if you do not save
the post.

## Categories

**Categories** («Categorías») in the sidebar, for administrators and editors.

- **Add Category** («Añadir categoría»): **Category name**, **Slug** (generated from the name if empty),
  **Parent category** («Categoría superior», or **None (top level)**) and **Description**.
- The list shows each category's slug and **Count** of posts; a subcategory says **Under <parent>**. The row
  buttons edit or delete it. Deleting asks **Delete this category?** first.

## Tags

**Tags** («Etiquetas») in the sidebar, for administrators and editors (others see the list read-only).

- **New tag** («Nueva etiqueta»): **Name**, **Slug (optional)**, which shows the **Expected slug** as you type, and
  **Description (optional)**; then **Create tag** («Crear etiqueta»). A slug takes lowercase letters, digits and
  hyphens only.
- **Search tags** filters the list. Each row has **Rename** and **Delete tag**. Deleting asks first: the posts
  are not deleted, they just stop having that tag.
