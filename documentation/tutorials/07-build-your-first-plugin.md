# Tutorial 7 — Build your first plugin

In this tutorial you build a **Reading List** plugin: an admin page where you add book titles, a small
API that stores them, and a Verso block that shows the list on any page. You build it on your own
computer, pack it into a zip, and install it on your site from the admin.

**Time:** about 20 minutes.
**You need:**

- A WordJS site and an administrator account (for example from [Tutorial 1](01-install-on-a-linux-server.md)).
- On your computer: Git and Node.js 22 or newer.

## 1. Get the developer tools

Plugins are built with the WordJS command line tool, which is in the WordJS repository. The build
needs the backend's development dependencies, which a production install leaves out, so build on your
computer (or any development machine), not on the server:

```bash
git clone --depth 1 --branch v2.6.0 https://github.com/jaimemartinez/wordjs.git
```

```bash
cd wordjs/backend && npm install && cd ..
```

Use the tag of the WordJS version your site runs.

## 2. Scaffold the plugin

```bash
node backend/cli/wordjs.js create plugin reading-list
```

This creates `backend/plugins/reading-list/`:

| File | What it is |
|---|---|
| `manifest.json` | The plugin's name, version, the **permissions** it asks for, and its admin page and Verso block |
| `index.js` | The server side. It runs in its own sandboxed process and reaches the site only through the `wordjs` object passed to `init(wordjs)` |
| `client/admin/page.tsx` | The admin page, at `/admin/plugin/reading-list` |
| `client/verso/ReadingListVerso.tsx` | The Verso block |

The scaffold already works as a reading list. `index.js` registers three routes, served under
`/api/v1/plugin/reading-list`:

- `GET /` lists the items (public);
- `POST /` adds one (administrators only);
- `DELETE /:id` removes one (administrators only).

It keeps the items in a site option called `reading-list_items`. Options are shared by the whole
site, so always prefix your keys with the plugin's slug. The admin page calls those routes.

The manifest asks for five permissions. Each comes with a reason, which the administrator reads before
activating:

| Permission | Why the plugin needs it |
|---|---|
| `browser:script` | To load its admin page and its block in the browser |
| `settings:read`, `settings:write` | To read and save its items |
| `express:register_route` | To serve its routes |
| `admin_menu:register` | To add **Reading List** to the admin sidebar |

A plugin can only do what it declares **and** the administrator grants. Anything else is refused.

## 3. Make the block show the list

Out of the box the block shows only a title and a text. Change it to load the items from the plugin's
API. In `client/verso/ReadingListVerso.tsx`:

1. Add the import below the `"use client";` line:

   ```tsx
   import { useEffect, useState } from "react";
   ```

2. Add a style for the list inside the `STYLES` string:

   ```css
   .reading-list-block ul {
       margin: 1rem 0 0;
       padding-left: 1.25rem;
   }
   ```

3. Replace the default-exported component with:

   ```tsx
   export default function ReadingListVerso({ title = "", body = "", elementId = "" }: ReadingListVersoProps) {
       const [items, setItems] = useState<{ id: string; title: string }[]>([]);

       useEffect(() => {
           fetch("/api/v1/plugin/reading-list")
               .then((res) => (res.ok ? res.json() : []))
               .then((data) => setItems(Array.isArray(data) ? data : []))
               .catch(() => setItems([]));
       }, []);

       return (
           <section id={elementId || undefined} className="reading-list-block">
               <style dangerouslySetInnerHTML={{ __html: STYLES }} />
               <h2>{title}</h2>
               <p>{body}</p>
               {items.length > 0 && (
                   <ul>
                       {items.map((item) => (
                           <li key={item.id}>{item.title}</li>
                       ))}
                   </ul>
               )}
           </section>
       );
   }
   ```

Leave `versoComponentDef` as it is: it declares the block's fields (**Title**, **Body**,
**ID / anchor**) and their defaults. The block uses the theme's `--wjs-*` tokens, so it follows the
active theme's colors, radius and fonts.

Optionally, give the plugin a real description in `manifest.json` (it shows on the Plugins screen).

## 4. Build and pack

```bash
node backend/cli/wordjs.js pack reading-list --build
```

`--build` compiles the admin page and the block into `dist/`, then the plugin is zipped to
`reading-list.zip` in the current folder (without `node_modules/` or `data/`).

## 5. Install and activate

On your site, open **Admin → Plugins**, click **Upload Plugin** and choose `reading-list.zip`.
WordJS checks the zip before accepting it: the manifest, the permissions and a scan of the code for
forbidden calls. **Reading List** then appears in the list, inactive, with its permissions shown as
badges.

Click **Activate**. A dialog lists every permission with its risk and the plugin's reason.
`browser:script` is marked **high risk** because the plugin's admin page runs with your administrator
session: install plugins only from people you trust. Click **Confirm and Activate**. The card shows
**Running**, and **Reading List** appears in the sidebar.

## 6. Use it

1. Open **Reading List** in the sidebar, type `The Coffee Roaster's Companion` and press **Enter**. Add
   `Water for Coffee` the same way.
2. Open **Pages → New Page**. In the **Blocks** panel, find the **Reading List** group and click
   **ReadingList**. (Plugin blocks are named after the plugin's id in PascalCase.)
3. In **Properties**, set **Title** to `On our shelf` and **Body** to
   `Books the roasting team recommends this month.`
4. In the page settings, set the title `Reading list`, set the status to **Publish** and click **Save**.

Open `/reading-list` on your site. It shows "On our shelf", the text, and both books. Anyone can see the
list, because `GET /` is public; adding or deleting an item needs an administrator:

```bash
curl -s https://<your-site>/api/v1/plugin/reading-list
```

## 7. Ship a new version

To change the plugin, edit it, raise `version` in `manifest.json` and pack again. Then, on the site:

1. **Deactivate** the plugin. Uploading over an active plugin is refused.
2. **Delete** it (the bin icon on its card), confirming with your password. Leave **Also delete this
   plugin's data / tables** unticked. Uploading over an installed plugin is refused too, so the old
   copy has to go first.
3. Upload the new zip and activate it again.

Your items survive. Options and the plugin's tables are kept unless you tick the data box. The
permission grants are always removed with the plugin, so you confirm them again on activation.

## Where next

- [plugins.md](../plugins.md): the full guide, covering hooks, shortcodes, the plugin's own database
  tables, scheduled jobs, email, portal pages and the development loop with hot reload.
- [plugins-reference.md](../plugins-reference.md): every bridge call and permission.
- [cli.md](../cli.md): `create`, `pack` and the other commands.

---
*Tested on 2026-10-17 with WordJS 2.6.0. On a clean Debian 12 machine: clone at `v2.6.0`,
`npm install` in `backend/`, `create plugin`, the block change from step 3, and `pack --build`. On a
fresh site, in a browser: upload, the permission dialog, activation, the sidebar entry, two items
added from the admin page, the block placed and published, and `/reading-list` listing both books. The
public `GET` answered 200 and an anonymous `POST` 401. The update in step 7 (0.1.0 → 0.2.0) kept the
items.*
