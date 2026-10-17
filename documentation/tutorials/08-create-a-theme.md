# Tutorial 8 — Create a theme

A WordJS theme decides how the public site looks: colors, fonts, corner radius, and the styling of
blocks like the hero. In this tutorial you create a "Corner Roasters" theme from four colors, adjust
it, check it with the theme doctor, and install it on your site from the admin.

**Time:** about 15 minutes.
**You need:** a WordJS site with an administrator account, and on your computer Git, Node.js 22 or
newer and the `zip` command. If you did [Tutorial 7](07-build-your-first-plugin.md) you already have
the repository; otherwise:

```bash
git clone --depth 1 --branch v2.6.0 https://github.com/jaimemartinez/wordjs.git
```

```bash
cd wordjs/backend && npm install && cd ..
```

## 1. Generate the theme from four colors

```bash
node backend/cli/wordjs.js create theme corner-roasters --primary "#8a4b2a" --secondary "#2f6f5e" --bg "#fbf7f2" --text "#2b211c" --name "Corner Roasters" --author "Corner Roasters" --description "Warm paper and roasted brown."
```

The four colors are the **seeds**: `primary` for buttons and links, `secondary` for accents and
hover states, `bg` for the page background, and `text` for body text. WordJS derives the rest of the
palette from them, including surfaces, borders, muted text, focus ring, and the text color that sits
on top of each fill.

You get `backend/themes/corner-roasters/` with three files:

| File | What it is |
|---|---|
| `theme.json` | The source of the theme: metadata, the seeds and a `layout` block. **This is the file you edit.** |
| `style.css` | Compiled from `theme.json`. Don't edit inside the `@wjs-generated` markers; CSS you write outside them is kept. |
| `functions.js` | An empty hook file. A theme does not need it. |

## 2. Adjust it

Open `theme.json` and add a `tokens` section and a `styles` section after `layout`:

```json
  "tokens": {
    "--wjs-font-family-heading": "Georgia, \"Times New Roman\", serif",
    "--wjs-radius-lg": "6px",
    "--wjs-hero-radius": "6px",
    "--wjs-hero-gradient-from": "#2b211c",
    "--wjs-hero-gradient-to": "#5a3a28"
  },
  "styles": {
    "hero": {
      "button": {
        "bg": "#8a4b2a",
        "letter-spacing": "0.04em",
        "hover": { "background": "#2f6f5e" }
      }
    }
  }
```

- **`tokens`** set `--wjs-*` design tokens directly. Here they set a serif for headings, tighter
  corners, and a dark roasted gradient behind the hero. The full list of tokens is in
  `backend/public/theme-tokens.json`, and [theming.md](../theming.md) explains them.
- **`styles`** style a block by its parts. `hero.button.bg` becomes the token
  `--wjs-hero-button-bg`. `letter-spacing` has no token, so it becomes a CSS rule on the hero button.
  `hover` becomes a `:hover` rule.

Compile it:

```bash
node backend/cli/wordjs.js build theme corner-roasters
```

The output reports how many tokens and rules were written. The build also **raises the patch
version** in `theme.json` (`1.0.0` → `1.0.1`), so visitors' browsers fetch the new stylesheet
instead of a cached one.

## 3. Check it with the doctor

```bash
node backend/cli/wordjs.js doctor theme corner-roasters
```

The doctor checks the theme against the token contract and checks the color contrast of every text
and background pair. With these seeds it reports one warning:

```
⚠️  [LOW_CONTRAST] muted text on the page: --wjs-color-text-muted on --wjs-bg-canvas is 4.42:1 (needs 4.5:1)
```

The derived gray for secondary text is a little too light on this paper background. Fix it with
one more token in `tokens`:

```json
    "--wjs-color-text-muted": "#6b625c",
```

Then build again and run the doctor once more. It should end with
`0 error(s), 0 warning(s), 1 info.`

## 4. Package it

A theme zip contains one folder named after the theme:

```bash
cd backend/themes && zip -r ../../corner-roasters.zip corner-roasters && cd ../..
```

## 5. Install and activate

On your site, open **Admin → Themes**, click **Install Theme** and choose `corner-roasters.zip`. The
message *Theme "corner-roasters" installed successfully* appears, and **Corner Roasters** joins the
list next to the bundled themes. Click **Activate Theme** on its card. It now shows **Currently In
Use**.

Open any page of your site, for example the `/our-story` page from
[Tutorial 5](05-your-first-page-with-verso.md). It now has:

- the warm paper background;
- Georgia headings;
- the dark brown hero;
- the roasted-brown button that turns green on hover;
- links in the primary color.

Pages are cached, so for a few seconds after you activate a theme, the first visit to a page can
still show the previous theme. Reload once.

## 6. Ship a new version

Edit `theme.json`, run `build theme` and the doctor, and zip it again. Then, on the site:

1. Activate another theme for a moment, for example **WordJS**. The active theme can't be deleted.
2. On the **Corner Roasters** card, click the bin icon and confirm. Uploading over an installed theme is
   refused (*Theme "corner-roasters" already exists*), so the old copy has to go first.
3. Install the new zip and activate it.

The card shows the new version number.

> **After 2.6.0:** releases after 2.6.0 update in place. Package the theme with
> `node backend/cli/wordjs.js pack theme corner-roasters` and install the newer zip; WordJS offers to
> update the installed theme, even while it is active. See
> [themes.md → Updating a theme](../themes.md#updating-a-theme-upload-a-newer-zip).

## Where next

- [themes.md](../themes.md): every `theme.json` key, page templates, header and footer composition
  (`chrome/*.json`), self-hosted web fonts, and the doctor's full list of checks.
- [theming.md](../theming.md): the token system and the **Customize** screen, where an
  administrator can override tokens without editing the theme.

---
*Tested on 2026-10-17 with WordJS 2.6.0. On a clean Debian 12 machine: clone at `v2.6.0`,
`npm install` in `backend/`, `create theme` with the four seeds above, the `tokens` and `styles`
from step 2, `build theme`, and the doctor (which reported the contrast warning in step 3, then
nothing once fixed). On a fresh site, in a browser: install from the zip, activate, and the update in
step 6 (1.0.2 → 1.0.3). The computed styles on `/our-story` were checked: page background `#fbf7f2`,
Georgia headings, hero gradient `#2b211c` → `#5a3a28`, hero button `#8a4b2a` with 0.04em letter
spacing.*
