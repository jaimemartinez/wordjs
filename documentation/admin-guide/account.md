# Signing in and your account

[Admin guide](README.md) › Signing in and your account

## Signing in

Open `https://<your-site>/login`. The page asks for:

- **Username** («Nombre de Usuario») and **Password** («Contraseña»). The eye button shows or hides what you typed.
- **Remember me** («Recordarme»), ticked by default.
  - **Ticked:** you stay signed in on this browser even after closing it, for up to 7 days. The session
    is renewed while you use the panel; after about 2 hours without using it you sign in again.
  - **Unticked:** the session ends when you close the browser. Use this on a shared or public computer.
- **Login** («Iniciar sesión»).

Below the button you may see:

- **Forgot your password?** («¿Olvidaste tu contraseña?»). It appears only when the site can actually send the
  reset email (see [Account email](settings.md#account-email)). Until then, an administrator resets a forgotten
  password from [Users](users.md#adding-and-editing-a-user).
- **Don't have an account? Create an account** («¿No tienes cuenta? Crear una cuenta»), only when
  **Membership** is on in [Settings](settings.md#reading--discussion).

A wrong name or password says **Invalid username or password** («Usuario o contraseña incorrectos»). After
several failures the account is locked for a few minutes from your location: **Too many failed attempts for
this account from your location. Try again in N minutes.**

If two-factor authentication is on for your account, a second step asks for the **Authentication code**
(«Código de autenticación»): the 6 digits from your authenticator app, or one of your backup codes. Your
**Remember me** choice carries over to that step.

## My Account

Every signed-in user, subscribers included, has **Account** («Cuenta») in the sidebar. The page is titled
**My Account** («Mi Cuenta»).

### Your picture

The card on the left shows your picture, or your initial if you have none.

- **Change picture** («Cambiar foto») opens a file picker: JPEG, PNG, WebP, GIF or AVIF, up to 5 MB. The picture
  is cropped to a square and stored without its metadata (location, camera); your previous picture is deleted.
- **Remove** («Quitar») appears while you have a picture and removes it at once.

### Profile

- **Display Name** («Nombre visible»): the name shown on your posts and comments.
- **Email** («Correo electrónico»): your account's primary address.
- **Personal / Recovery Email** («Correo personal / de recuperación»): where WordJS sends password-recovery mail
  and notifications. It can be different from the primary address.

Change what you need and press **Save Profile** («Guardar Perfil»).

When you change your **Email** or your **Recovery Email**, a **Current Password** («Contraseña Actual») field
appears: type your password to confirm. Changing only your display name never asks for it. A wrong password
says **Current password is incorrect.** («La contraseña actual no es correcta.»)

Things that can stop an email change:

- **This email address cannot be used.** («Esta dirección de correo no se puede usar.»): another account uses it,
  or it is not a valid address.
- An address on the site's own mail domain can only be given by an administrator.
- If an administrator gave your account a service that sets your email (a plugin's switch under **Plugin access
  for this account**, such as a mailbox on the site's domain), only an administrator can change that address.

Changing the recovery address cancels any password-reset link already sent to the old one.

### Change Password

Type your **Current Password**, a **New Password** of at least 8 characters, and **Confirm New Password**, then
press **Change Password** («Cambiar Contraseña»). Every session of your account is then closed, this one
included: sign in again with the new password.

### Two-Factor Authentication

Type **Your current password** and press **Enable two-factor authentication** («Activar autenticación de dos
factores»). Scan the QR code with your authenticator app (Google Authenticator, 1Password, Authy…), or type the
**Manual entry key**, then enter the **6-digit code** it shows and press **Verify & enable**. WordJS then shows
**Your backup codes**: each works once if you lose your authenticator. Keep them somewhere safe.

While two-factor is on, the card offers **Regenerate backup codes** and **Disable 2FA**; both ask for a current
code first.

An administrator can require two-factor for whole roles in [Security](site-address-and-https.md#two-factor-enforcement).

### Sessions

**Sign out** in the sidebar ends this browser's session only. To end every session of your account (another
device you left signed in, or one you think someone else is using), type your **Current Password** and press
**Sign out of all sessions** («Cerrar todas las sesiones»). API tokens are not affected.

### Your data

**Download my data** («Descargar mis datos») saves a JSON file with your profile, your entries, your comments and
the list of your uploads (title, type and date of each file, not the files themselves).

### Delete my account

To delete your account for good, type your **Current Password**, tick **I understand this cannot be undone.**
(«Entiendo que no se puede deshacer.») and press **Delete my account** («Eliminar mi cuenta»). You are signed out
at once. Your posts and pages stay on the site without an author; an administrator can give them to someone else.

The only administrator of a site cannot delete their account: **You are the only administrator: make someone
else an administrator before deleting your account.**
