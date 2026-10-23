# Plugins

[Admin guide](README.md) › Plugins

**Plugins** in the sidebar is for administrators. It has two tabs, **Installed** («Instalados») and
**Marketplace**, and an **Upload Plugin** («Subir Plugin») button.

Every plugin runs in its own sandbox and can use only what you grant it. **Installing grants nothing**: a new
plugin is installed inactive, with its permissions off, and you decide what it may do when you activate it.

## Installing from the Marketplace

The **Marketplace** tab lists the plugins of the official catalog. Search with **Search plugins…** or pick a
category (**Commerce**, **Content**, **Email**, **Events**, **Forms**…). The line above the list names the catalog
and repeats: **Plugins are installed deactivated, with their permissions denied by default.**

Each card shows the plugin's version and size, a trust badge (**First-party**, **Reviewed** or **Unreviewed**; every
plugin runs in the same sandbox, badge or not), a **Block …** badge when it adds an editor block, and the
permissions it will ask for, coloured by risk.

Press **Install** («Instalar»). The confirmation lists **Permissions it will request**, and reminds you that
installing grants nothing. When it is done: **"Name" installed. Activate it and grant its permissions in
Installed.** The card then reads **Installed (inactive)**.

When the catalog has a newer version of an installed plugin, its card offers **Update to vX**. Updating keeps
what you granted; permissions that are new in that version stay off until you grant them.

The gear button (**Configure marketplace sources**) adds other catalogs (https addresses), and the arrows
button refreshes the catalog.

## Uploading a ZIP

**Upload Plugin** takes a `.zip` file. If that plugin is already installed, WordJS asks **Update the plugin?**:
its data, its tables and the permissions you granted are kept, and any new permission is asked about separately.

## The Installed list

Search, and filter with **All**, **Active** and **Inactive**. Each card shows:

- the name and description, and the permissions it requested;
- for an active plugin, a health line: **Running** with its memory use, or **Restarting**, **Crashed**, **Stopped**…
  with the last error and a restart button;
- the version, **Permissions** («Permisos») and the **Activate** or **Deactivate** button;
- on hover (always visible on a touch screen): **Details**, and for an inactive plugin **Download Source** and the
  bin to delete it.

## Permissions

**Permissions** opens the plugin's permissions: one switch per permission it requested, with its risk (**Low
risk**, **Medium risk**, **High risk**), what it allows, and the plugin's own reason (**Plugin says: …**). Turn on
only what you want it to have, then press **Save permissions** («Guardar permisos»).

Anything left off is denied: a plugin can use a capability only if it asked for it **and** you granted it.
Revoking a permission takes effect at once; the plugin is restarted, or deactivated if it cannot work without it.

Some permissions deserve a second look:

- **Run code in your browser** (`browser:script`) is marked **High risk** and comes with a red warning: the
  plugin's admin page and editor blocks run in your browser with your administrator session, outside the
  sandbox. Grant it only to a plugin you trust as much as an administrator. Without it, the plugin's admin screen
  is not loaded and shows **This plugin's interface is not loaded**, with a button to its permissions.
- **Outbound network** (`network`) lets a plugin reach public internet addresses only. A plugin that needs a
  server on your private network (a mail relay on your LAN, for example) asks for that exact address in its own
  settings.
- **Register its own user roles** (`roles:declare`) lists the roles the plugin will add; they only reach that plugin.

## Activating

Press **Activate** («Activar»). The **Required Permissions** dialog always opens first and lists what the plugin
asks for:

- Each permission that activating will grant has a switch. Turn one off and the plugin starts without it (**Will
  not be granted: you switched it off.**); you can grant it later in Permissions.
- A permission you revoked before, or a new one from an update, is grey and says **Stays off**: activating never
  grants it.

Press **Confirm and Activate** («Confirmar y activar»). Starting the plugin's sandbox can take several seconds:
the button shows a spinner and **Activating…** («Activando…»), and the plugin's buttons stay disabled until the
server answers. Then **Plugin activated**, and the card shows **Running**. Plugins that add screens appear in the
sidebar.

If the plugin needs a permission you did not grant, activation stops with **Activation blocked** and lists what to
grant. If the server's sandbox is not available, a dialog explains that this is a server problem for the operator,
not a problem with the plugin.

## Deactivating

**Deactivate** («Desactivar») asks first: everything the plugin runs stops (its pages, its blocks, its services; a
mail server stops receiving mail), and its data is kept. While it works the button reads **Deactivating…**.

## Deleting

The bin appears only on an inactive plugin. **Delete Plugin** asks for your **Password** («Contraseña»), and the
**Delete** button stays disabled until you type it.

**Also delete this plugin's data / tables** («Eliminar también los datos / tablas de este plugin») is off by
default: the plugin's tables, settings and files are kept for a future reinstall. Tick it to delete them too;
that cannot be undone. While it works the button reads **Deleting…** («Eliminando…»).

A plugin whose files went missing or are damaged is listed first as **Broken**, with **Reinstall from the
Marketplace** and **Remove leftovers**.

## On a network of sites

On a site of a network, the network administrator installs plugins; each site activates the ones the network
offers and grants permissions up to the limit the network sets. See [Multisite](../multisite.md#plugins-on-the-sites).

What each official plugin does is in the [plugins reference](../plugins-reference.md).
