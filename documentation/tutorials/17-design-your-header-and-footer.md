# Tutorial 17 — Design your header and footer

Every public page of your site shares one header and one footer. In this tutorial you build both for
Corner Roasters in **Admin → Header & footer**: a two-row header with a call-to-action that collapses
into a menu button on phones, and a four-column footer with your menu, social links and a copyright
line that updates itself every January. You check them at desktop, tablet and phone widths, and — if
your site still has text from the old **Footer** settings page — you convert it.

**Time:** about 15 minutes.
**You need:** a WordJS site and an administrator account (any account that can edit theme options),
from [Tutorial 1](01-install-on-a-linux-server.md) or any other install. A menu assigned to the
**header** and **footer** locations in **Admin → Menus** makes the result look like a real site.

## 1. Open the editor and read the badge

Open **Admin → Header & footer**. Three buttons at the top choose what you edit: **Header**,
**Footer** and **Announcement** (an optional bar above the header). Next to them a badge says where
what you see comes from:

- **From the theme** — the active theme ships its own header or footer.
- **Built-in (previous settings)** — nothing is composed yet; you see the built-in header or footer
  your site shows today, converted into blocks.
- **Customized on this site** — you saved your own; it wins over the theme.
- **Starter template** — not on your site yet (the announcement bar starts here).

The blue line under the toolbar says the same in a sentence. Nothing you do in the editor reaches the
site until you click **Save**.

The editor has three panes: **Blocks** and **Outline** on the left, the canvas in the middle, and
**Properties** on the right. With no block selected, **Properties** shows the part's own settings. On a
tablet or phone the panes open from a tab bar at the bottom — **Blocks**, **Outline**, **Properties**
and **Settings** — and close with **Esc** or by tapping the canvas.

## 2. Start the header from a template

With **Header** selected, click **Templates** and pick **Two rows**. The canvas now shows a top bar
(a short text, a language switcher and your social links) above the main row (logo, menu, and a
**Contact** button). Applying a template is one step: **Ctrl+Z** (or the undo arrow above the canvas)
takes it back.

Change the top bar's text: click it on the canvas, and in **Properties** type
`Fresh roast every Friday`. Then click the **Contact** button and set its **Link** to `/contact`.

> The link must be a page of your site (`/…`) or a full `https://` address. Anything else is refused
> when you save, with a message that names the block — for example *"Button (Row 2 › block 2 ›
> block 2): The link must start with / (a page on your site) or https://."*

## 3. Decide what phones see

Click the device buttons above the canvas: **Desktop**, **Tablet** and **Phone**. The canvas is drawn
at 1280, 768 and 375 pixels wide and scaled to fit, so you see the real layout for each: on **Phone**
the menu becomes a round menu button. (On a phone or tablet the preview opens at your own device's
size.)

The template hides the top bar and the **Contact** button on phones. Select the button and look at
**Visibility** in **Properties**: **Hide on phones** is **Yes** (set any block's three switches the same
way). On the **Phone** preview the button is drawn faded — hidden on the site, still there for you to
select.

Click an empty area of the canvas to deselect, and look at **Header settings**:

- **Stays on top when scrolling** — the header sticks to the top of the window.
- **Transparent over the hero** — the header sits over a page's opening hero image and turns solid
  once the visitor scrolls. Pages that don't start with a hero keep room for it. **Text over the
  hero** picks light text for a dark image.
- **Width** — **Centered** keeps the header in the page column; **Full width** spans the window.

Leave **Stays on top** on **Yes** and click **Save**. The badge changes to **Customized on this site**.

## 4. Build the footer

Click **Footer**, then **Templates** → **Four columns**. The footer gets a grid: your logo with a
sentence about the site, your footer menu under **Links**, your social links under **Follow us**, and
a widget area; below it, a copyright line and the language switcher.

- Click the sentence and write `Small-batch coffee from the corner of 5th and Main.`
- Click the copyright line. Its text is `© {year} {site}`: `{year}` is always the current year and
  `{site}` your site name, so it never needs editing on January 1st.

To set the social links, click **Social profiles** in the toolbar, add each profile (for example
Instagram, `https://instagram.com/cornerroasters`) and click **Save** in the panel. Every **Social
networks** block shows that one list.

Click **Save**.

## 5. Check it on the site

Open your site in a new tab. On a wide window you see both header rows and the four-column footer. Make
the window narrower (or open the site on a phone):

- **Tablet width** (768–1023 px): the footer becomes two columns.
- **Phone width** (under 768 px): the top bar and the **Contact** button disappear, the menu button
  opens the menu as a side panel (**Esc** closes it), and the footer is a single column.

The language switcher only appears on pages that have translations; on a single-language site it stays
hidden.

## 6. Convert the old footer settings (if you had them)

Sites that used the old **Footer** settings page (footer text, copyright, social links) keep that
content. The old page's address now opens this editor on the footer.

- If the badge says **Built-in (previous settings)**, a yellow line says the footer was built from
  your previous settings. Click **Convert**: the editor saves it as this site's footer, exactly as it
  looked, and you can edit it like the one above. Your old settings are kept, so **Restore built-in**
  brings the previous footer back.
- If the badge says **From the theme**, your theme's own footer was showing instead of the old text.
  The yellow line offers **Add them**: it appends your old footer text and copyright as blocks, which
  you can move or delete before saving.

## Good to know

- **Restore built-in** (in the toolbar once you have saved) deletes this site's version: the site goes back to
  the theme's header or footer, or to the built-in one.
- Saved changes reach the public site in about two seconds.
- In a network of sites, each site has its own header, footer and social profiles.
- Themes can ship their own header and footer files; see
  [themes.md](../themes.md#composable-chrome-chromejson) for the blocks and settings they can use.

---
*Tested on 2026-10-20 on a fresh install of the development branch that introduced this editor, released
in WordJS 2.8.0 (Windows 11, monolith dev mode), in a browser at 1440, 820 and 390 pixels wide. Covered: the Two rows
header and Four columns footer applied from Templates and saved; the device previews; undo and redo;
the public site at the three widths (top bar hidden on phones, menu button and side panel with Esc,
footer in four, two and one columns); a legacy footer (text, copyright, two social links) converted
with Convert and shown on the site with the same content, and the theme-footer case offering Add
them; Restore built-in; a `javascript:` link refused with the plain-language message above; a transparent
header with light text over a page opening with a Hero block, turning solid on scroll; the editor
itself at 375, 768, 1024 and 1440 pixels (tab bar and sheets, templates and social profiles dialogs).
The labels, badges, templates and messages were checked again on 2026-10-23 with WordJS 2.9.*
