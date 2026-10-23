# Media library

[Admin guide](README.md) › Media library

**Media** («Medios») in the sidebar opens the **Media Library** («Biblioteca de Medios»). Administrators,
editors and authors see it (anyone who can upload files).

## Uploading

- **Upload File** («Subir Archivo») picks one or several images, videos or PDFs. You can also drag files from
  your computer onto the page: **Drop your file here** («Suelta tu archivo aquí»).
- Tick **Upload as private** («Subir como privado») first to store the files outside the public folder (see
  [Private files](#private-files)).
- A file over the size limit is refused before it is sent: **Larger than the maximum upload size (N MB).**
  The limit is set in [Settings → Media](settings.md#media).
- Files that fail are listed under **These files were not uploaded:** («Estos archivos no se subieron:») with the reason.

When a folder is open, uploads go into it: the line above the files says **Uploads go into «Name».** («Lo que
subas irá a «Name».»)

Use the search box (**Search files...**), the type filter (**All types**, **Images**, **Video**, **Audio**,
**PDF**, **Text**) and the visibility filter (**Public and private**, **Public only**, **Private only**) to
narrow the list. The two buttons beside them switch between the grid and the list view.

## Folders

Folders only organise the library. **Moving a file never changes its address**, so pages that use it keep
working; the panel reminds you: **Moving a file does not change its address: pages that use it keep working.**

On a wide screen the **Folders** («Carpetas») panel is on the left of the files. On a phone or tablet it is a
bar above the files, **Folders: <current folder>**; tap it to open the panel.

The panel always starts with:

- **All files** («Todos los archivos»): every file, in any folder or none.
- **Not in a folder** («Sin carpeta»): the files that are in no folder.

Then come your folders, each with the number of files in it. A folder with subfolders has an arrow to open or
close it.

### Creating and nesting folders

1. Press **New folder** («Nueva carpeta»).
2. Type the **Folder name** («Nombre de la carpeta»), up to 100 characters.
3. In **Inside** («Dentro de»), keep **(none: top level)** («(ninguna: nivel superior)») or pick the folder it
   goes in.
4. Press **Create** («Crear»).

To create a folder inside the one you are in, select it and press **Subfolder** («Subcarpeta») under its name.

Two folders in the same place cannot share a name (**A folder with that name is already there.**), and a
library holds up to 2,000 folders.

### Browsing

Click a folder to see its files. A breadcrumb above the files (**All files › Products › Espresso**) takes you
back up. The address in the browser keeps the folder, so reloading the page or sharing the link opens the same
folder.

### Moving files

There are three ways:

- **Drag a file onto a folder.** In the grid view, drag a file's card onto a folder in the panel, or onto
  **Not in a folder**. If the card is part of a selection, the whole selection moves.
- **From the file's details.** Open a file and press **Move to…** («Mover a…»); the button shows the folder it
  is in now.
- **Several at once.** Tick the box in the top-left corner of each file (it shows when you point at a card, and
  is always visible on a touch screen; the list view also has **Select all**). A bar appears with
  **Selected: N**, **Move to…** and **Clear selection** («Quitar selección»).

**Move to…** opens **Move files (N)** («Mover archivos (N)»): pick the **Folder** and press **Move** («Mover»).
The message **Files moved to «Name»: N.** confirms it.

You can move the files you are allowed to edit: authors their own, editors and administrators anyone's. Files
you cannot edit stay where they were: **N were not moved: you cannot edit them.**

### Renaming, moving and deleting folders

Select a folder: under its name appear **Subfolder**, **Edit** («Editar») and **Delete** («Eliminar»). **Edit**
and **Delete** are for editors and administrators; authors can create folders and move files, but not rename
or delete folders.

- **Edit** opens **Rename or move** («Cambiar nombre o ubicación»): change the name, or pick another folder in
  **Inside** to move the folder and everything in it. A folder cannot go inside itself or one of its own
  subfolders.
- **Delete** opens **Delete «Name»** («Eliminar «Name»»). **No file is ever deleted with a folder.** If the folder
  holds files or subfolders, choose where they go in **Move its contents to** («Mover su contenido a»): its parent
  folder is preselected, and **Not in a folder** is always offered. Press **Delete folder** («Eliminar carpeta»).
  The message says how many files moved, and if you were inside the folder you are taken to where its contents
  went.

## File details

Click a file to open its details:

- **Title** («Título»), **Alt text** («Texto alternativo»), **Caption** («Leyenda») and **Description**
  («Descripción»). Press **Save changes** («Guardar cambios») after editing them.
  - The **Alt text** is what screen readers announce. Leave it empty only if the image is decorative; images
    without it carry a **No alt text** badge in the library. When an AI provider is configured
    ([Settings → AI](../ai-provider.md)), a button suggests one.
- **Private file** («Archivo privado»): see below. It applies as soon as you tick it, without **Save changes**.
- **Type**, **Uploaded** date and **URL**.
- **Edit image** («Editar imagen») and, on an edited image, **Restore original** («Restaurar original»).
- **Move to…**, **Copy URL** («Copiar URL»), **Open** («Abrir», in a new tab) and **Delete** («Eliminar»).

**Delete** asks first. If the image is the featured image of some posts, the dialog lists them: deleting it
leaves them without a featured image.

### Private files

A private file is stored outside the public folder: it has no public address and never appears in public
listings. Only editors and administrators, or a plugin you allowed (paid downloads, for example), can deliver
it. If the file was public before, its old address may remain in caches or browsers for a while.

## Editing an image

**Edit image** appears for JPEG, PNG and WebP images stored on the server. (Images kept in an S3 bucket
cannot be edited here yet; the panel says so.) The editor opens with:

- **Rotate left** / **Rotate right** («Girar a la izquierda / a la derecha»): 90° at a time.
- **Flip horizontally** / **Flip vertically** («Voltear en horizontal / en vertical»).
- **Crop ratio** («Proporción del recorte»): **Free** («Libre»), **Original**, **1:1**, **4:3**, **3:2** or **16:9**.
- **Clear crop** («Quitar recorte»): back to the whole image.

Drag inside the crop box to move it, or drag a corner to resize it; it works with a mouse or a finger. From the
keyboard, focus the crop area: the arrow keys move it and **Shift** + arrow keys resize it.

**Final width (px)** («Ancho final (px)») scales the result down; the height keeps the proportions, and an empty
box keeps the size. The image is never enlarged. **Result: W × H px** shows the size you will get.

Press **Save edited image** («Guardar imagen editada»). The edit is saved as **a new file**, with its own sizes;
the earlier file is kept, so pages that already show the image keep showing the earlier version until you insert
it again. The message says so: **Image edited. Pages that already show it keep the earlier version until you
insert it again.**

**Restore original** brings the original image back at any time.

## The media picker in the editor

When you choose a featured image or an image for a block, the **Select media** dialog shows the public images
of the library. If the library has folders, a **Folder** list filters them: **All files**, **Not in a folder**,
or any folder. The picker does not upload: upload in the Media Library first.

## Where files are stored

Files are kept on the server's disk unless the site stores media in an S3-compatible bucket; see
[Media storage](../media-storage.md).
