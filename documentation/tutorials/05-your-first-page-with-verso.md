# Tutorial 5 — Your first page with the Verso editor

Verso is WordJS's visual editor: you build a page from blocks on a live canvas that looks like the
public site, and set each block's details in a side panel. In this tutorial you create an "Our Story"
page with a hero, a heading, a paragraph and a button, publish it, and see it on the site.

**Time:** about 10 minutes.
**You need:** a WordJS site and an administrator (or editor) account, from
[Tutorial 1](01-install-on-a-linux-server.md) or any other install.

## 1. Create the page

Sign in and open **Admin → Pages → New Page**. The editor opens on an empty canvas:

- **Left:** the **Blocks** panel. Blocks are grouped as Layout, Content, Media, Marketing, Dynamic and
  Navigation. **Structure** shows the page as a tree, **Templates** offers ready-made sections, and
  **Media library** lets you pick images.
- **Center:** the canvas, with buttons on top to preview it as **Desktop**, **Tablet** or **Mobile**.
- **Right:** **Properties** for the selected block, or the page settings when nothing is selected.
- **Top right:** the status (**Draft**, **Publish**, **Pending**, **Scheduled**) and **Save**.

On a narrow screen the side panels move to tabs at the bottom (**Blocks**, **Structure**,
**Properties**, **Page**).

In the page settings, type the **Title**: `Our Story`. The **Slug** (the URL) is filled in from it
(`our-story`) when you save. The editor saves a draft as you work, so the page already exists
privately.

## 2. Add a hero

Click **Hero** in the Blocks panel (or **Add first block** on the empty canvas). The block appears on
the canvas, selected, and its properties open on the right:

1. **Title:** `Coffee roasted down the street`
2. **Subtitle:** `Small batches, roasted every Friday since 2019.`
3. Under **Buttons**, open **Buttons 1** and set **Text** to `See this week's beans` and **URL** to
   `/about`.

The canvas updates as you type. The same panel sets a background image (**Select from Media**), the
overlay strength and the hero's height.

## 3. Add a heading and a paragraph

Click **Heading** in the Blocks panel. It is added below the selected block; set its **Title** to
`Visit the roastery`.

Click **Text**. A paragraph block is added. Text is written **on the canvas**, not in the panel. With the
block selected, click the **pencil** in its toolbar (or double-click the text), type
`Open Tuesday to Saturday, 8 am to 4 pm. Ask for a cupping on Fridays.`, and press **Esc** when you are
done. The panel keeps the paragraph's style: color, size, line height and maximum width.

Each block's toolbar also has **Move up/down**, **Duplicate** and **Delete**. Undo and redo are
**Ctrl+Z** and **Ctrl+Shift+Z**, and **Ctrl/⌘+K** opens a quick block search.

## 4. Preview and publish

- The **Preview** button (the eye) opens the page on the live site. Drafts stay private to you.
- To publish, set the status to **Publish** and click **Save**.

The page is now public at `/our-story`. From then on, edits show **Unpublished changes**, and the main
button reads **Publish**: your changes go live only when you click it.

## 5. Check it

Open `https://<your-site>/our-story`. You see the hero with your title, subtitle and button (linking to
`/about`), then the heading and the paragraph, inside your theme's header and footer.

The site menu is managed separately, in **Admin → Menus**.

## Good to know

- **Entrance animations:** the **Motion** panel under the canvas sets how the selected block appears
  (fade, slide, zoom…), its speed and delay. **Play the entrance animations** in the top bar replays
  them.
- **Live collaboration** is on by default: two people editing the same page see each other's changes.

---
*Tested on 2026-10-17 with WordJS 2.6.0 on a fresh install (Debian 12), in a browser, following these
exact steps: page created, Hero, Heading and Text blocks added and edited (the text inline on the
canvas), published, then the hero button changed and published again. The public `/our-story` showed
the title, subtitle, heading and paragraph, and a button `See this week's beans` linking to `/about`.*
