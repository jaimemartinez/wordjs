# Users

[Admin guide](README.md) › Users

The **Users** group of the sidebar is for administrators:

- **Users** («Usuarios»): the **Team Members** («Miembros del Equipo») list, every role except subscribers.
- **Subscribers** («Suscriptores»): the same list for subscribers.
- **Roles**: the roles and their capabilities.
- **Account** («Cuenta»): your own account, see [Signing in and your account](account.md).

## The list

Search by name, username or email, and filter by role (**All roles** or one role). Each row shows the user,
their **Email** and their **Role**. The edit and delete buttons appear at the end of the row; there is no
delete button on your own row.

## Adding and editing a user

**New User** («Nuevo Usuario»; **New subscriber** on the Subscribers list) and the edit button open the same
form:

1. **Username** («Nombre de usuario»): required, and cannot be changed later.
2. **Email** («Correo electrónico»): required.
3. **Personal / Recovery Email**: where password-recovery mail and notifications go, if different.
4. **Display Name** («Nombre visible»).
5. **Role** («Rol»): **Core roles** (Administrator, Editor, Author, Contributor, Subscriber), your **Custom roles**,
   and **Plugin roles**.
6. **Password** for a new user; when editing, **New Password (leave blank to keep current)**. At least 8
   characters.

Plugins can add switches under **Plugin access for this account**. With the Mail Server plugin, for example,
**Professional mail account** gives the user a mailbox: their email becomes `<username>@<your mail domain>` and
only an administrator can change it. Turning it off gives the email field back.

Press **Save User** («Guardar usuario»).

When editing another user who has two-factor authentication, **Reset two-factor** («Restablecer dos pasos»)
turns it off for them (after a confirmation), for example when they lost their phone. It acts at once.

### Editing your own row

When you edit **your own** user from this list and change your email, your recovery email or your password, or
turn on a switch that changes your email (such as **Professional mail account**), the form adds a **Current
Password** field: type your password to save. A wrong one says **Current password is incorrect.** Editing other
users never asks for it.

## Bulk actions

Tick the users you want (or **Select all**); your own row cannot be ticked. A bar appears with the number
selected:

- **Change role to…** («Cambiar rol a…»): pick a role and press **Apply** («Aplicar»). The message says how many
  accounts changed, and why any could not.
- **Delete** («Eliminar»): opens the delete dialog for all of them (**Delete N users**), listing the accounts.
- **Clear** («Limpiar») clears the selection.

## Deleting a user

The delete dialog says the account will be deleted: they can no longer sign in, and their sessions and tokens
stop working. It cannot be undone.

If they wrote posts or pages, it asks **What should happen to them?** («¿Qué hacemos con ellas?»):

- **Attribute them to <name>** («Atribuirlas a <name>»), you by default, or any other team member. Everything they
  authored, of every type, goes to that person.
- **Keep them without an author** («Dejarlas sin autor»).

Nothing but the account is deleted. Press **Delete account** («Eliminar cuenta»).

## Roles

**Roles** lists every role with its capabilities. **Add New Role** («Agregar nuevo rol») creates one: give it a
**Display Name** and tick its **Capabilities** (**Select All** / **Deselect All** help). Editing a role offers
**Save Changes** and **Delete Role**.
