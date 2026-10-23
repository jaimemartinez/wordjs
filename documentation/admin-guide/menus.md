# Menus

[Admin guide](README.md) › Menus

**Menus** («Menús») in the sidebar is for administrators. The header and footer show the menus you assign
to them here; how the menu looks is designed in **Header & footer** (see
[Tutorial 17](../tutorials/17-design-your-header-and-footer.md)).

**Everything on this screen is saved the moment you click it**: adding, moving, nesting and assigning. The
only **Save Changes** button is in an item's edit panel. Changes reach the public site at once.

## Creating a menu

Under **Select Menu** («Seleccionar menú»), the list shows the menu you are working on; the red bin deletes it
(after a confirmation).

To create one, type a name in **Create New Menu** («Crear nuevo menú»; placeholder **Menu Name...**) and press
**Enter** or the **+** button. Two menus can have the same name.

## Adding items

The **Add Items** («Añadir elementos») card has one section per kind of item:

- **Custom Link** («Enlace personalizado»): type the URL and the **Link Text**, then **Add to Menu** («Añadir al
  menú»).
- **Pages** («Páginas»), **Posts** («Entradas»), **Categories** («Categorías») and **Tags** («Etiquetas»): tick one
  or more and press **Add to Menu** (or **Add N to menu** when several are ticked). A **Filter…** box appears
  when a list has more than 8 entries. Pages include drafts; posts are the published ones.
- **System Pages** («Páginas del sistema»): **Login / Access** and the portals of your active plugins. Pick one and
  press **Add System Page**.

New items are added at the end of the menu, at the top level.

## Arranging items and submenus

Each item in the menu has these buttons:

- The up and down arrows (**Move up** / **Move down**) swap it with the item above or below at the same level.
- **Make it a sub-item of the one above** («Convertir en subelemento del anterior») nests it under the item
  above, as its last sub-item. The item is drawn indented.
- **Move up one level** («Subir un nivel») takes a sub-item back out, right after its old parent.
- The pencil (**Edit**) opens the item's panel; the bin (**Delete**) removes it after a confirmation.

The message **Order updated** («Orden actualizado») confirms each move. Moving an item moves its sub-items with
it.

## Editing an item

The pencil opens:

- **Navigation Label** («Etiqueta de navegación»): the text shown in the menu.
- **URL**, for custom links only (pages, posts, categories and tags keep their own address).
- **Open in a new tab** («Abrir en una pestaña nueva»).
- **Parent item** («Elemento superior»): **None (top level)** or any other item, except the item itself and its
  own sub-items. This is another way to build a submenu.

Press **Save Changes** («Guardar cambios»), or **Cancel**.

## Menu locations

At the top of the menu are two boxes: **Main Menu** («Menú principal», the header) and **Footer Menu** («Menú de
pie de página»). Ticking one shows this menu there at once, and takes that place from whichever menu had it.
Unticking does nothing: to change the menu of a location, open the other menu and tick the box there.
