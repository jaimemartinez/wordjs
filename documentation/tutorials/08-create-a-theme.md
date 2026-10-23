# Tutorial 8 — Create a theme

A WordJS theme decides how the public site looks: colors, fonts, corner radius, and the styling of
blocks like the hero. In this tutorial you create a "Corner Roasters" theme from four colors, adjust
it, check it with the theme doctor, and install it on your site from the admin.

**Time:** about 15 minutes.
**You need:** a WordJS site with an administrator account, and on your computer Git and Node.js 22
or newer. If you did [Tutorial 7](07-build-your-first-plugin.md) you already have
the repository; otherwise:

```bash
git clone --depth 1 --branch v2.9.0 https://github.com/jaimemartinez/wordjs.git
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
    "--wjs-hero-radius": "6px"
  },
  "styles": {
    "hero": {
      "bg": "#2b211c",
      "button": {
        "bg": "#8a4b2a",
        "letter-spacing": "0.04em",
        "hover": { "background": "#2f6f5e" }
      }
    }
  }
```

- **`tokens`** set `--wjs-*` design tokens directly. Here they set a serif for headings and tighter
  corners. The full list of tokens is in `backend/public/theme-tokens.json`, and
  [theming.md](../theming.md) explains them.
- **`styles`** style a block by its parts:
  - `hero.bg` becomes `--wjs-hero-bg`, the dark roasted background behind the hero;
  - `hero.button.bg` becomes `--wjs-hero-button-bg`;
  - `letter-spacing` has no token, so it becomes a CSS rule on the hero button;
  - `hover` becomes a `:hover` rule.

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
and background pair. WordJS darkens or lightens the muted text it derives until it reaches WCAG AA
(4.5:1), so with these values the doctor ends with `0 error(s), 0 warning(s), 1 info.` If a color you
set in `tokens` falls below that, the doctor names the pair and its ratio (`LOW_CONTRAST`).

## 4. Package it

```bash
node backend/cli/wordjs.js pack theme corner-roasters
```

This writes `corner-roasters.zip` to the current folder, with the single `corner-roasters/` folder
that an upload expects.

## 5. Install and activate

On your site, open **Admin → Themes**, click **Install Theme** and choose `corner-roasters.zip`. The
message *Theme "corner-roasters" installed successfully* appears, and **Corner Roasters** joins the
list next to the bundled themes. Click **Activate Theme** on its card. It now shows **Currently In
Use**.

Open any page of your site, for example the `/our-story` page from
[Tutorial 5](05-your-first-page-with-verso.md). It now has:

- the warm paper background;
- Georgia headings;
- the dark brown hero (`#2b211c`);
- the roasted-brown button that turns green on hover;
- links in the primary color.

Activating a theme expires the cached pages, so the very next visit already shows it.

## 6. Ship a new version

Edit `theme.json`, run `build theme` and the doctor, and pack it again. Then, on the site, click
**Install Theme** and choose the new zip. WordJS asks *Update the theme?*; click **Update**. The new
version replaces the old one in place:

- an active theme stays active and keeps its **Customize** settings;
- the cached pages are expired at once;
- the card shows the new version.

On WordJS 2.6.0 and earlier there is no update in place: activate another theme, delete this one and
install the new zip.

## Where next

- [themes.md](../themes.md): every `theme.json` key, page templates, header and footer composition
  (`chrome/*.json`), self-hosted web fonts, and the doctor's full list of checks.
- [Tutorial 17](17-design-your-header-and-footer.md): how a site owner composes the header and footer
  in the admin — what your `chrome/*.json` files are the starting point for.
- [theming.md](../theming.md): the token system and the **Customize** screen, where an
  administrator can override tokens without editing the theme.

---
*Tested on 2026-10-17 with a WordJS 2.7.0 release build.

- **Clean Debian 12 checkout of the release source:** `create theme` with the four seeds above, the
  `tokens` and `styles` from step 2, `build theme`, the doctor (no warnings) and `pack theme`.
- **Fresh site, in a browser:**
  - **Install and activate:** the first public visit already used the new theme.
  - **Computed styles:** page background `#fbf7f2`, Georgia headings, links `#8a4b2a`, and a hero on
    `#2b211c` with its button on `#8a4b2a`.
  - **Update in step 6:** with a new hero color, 1.0.1 became 1.0.2 while active, and the new color was
    served.*
