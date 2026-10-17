# Tutorial 15 — Backups, restoring and upgrading

In this tutorial you take a backup of a site, upgrade WordJS to a new release with one command, and
restore the backup to bring back something that was deleted. You go from 2.5.0 to 2.6.0 here, but the
steps are the same for any release.

**Time:** about 20 minutes.
**You need:** a site installed as in [Tutorial 1](01-install-on-a-linux-server.md) (in `/srv/wordjs`,
run by the `wordjs` user as the `wordjs` service), an administrator account, and root access to the
server.

## 1. Take a backup

Open **Admin → Settings → Backups** and click **Create backup**. (In 2.6.0 this screen is not
translated yet and shows its labels in Spanish: **Crear copia de seguridad**, **Programación
automática**, and **Descargar / Restaurar / Eliminar** on each line.) A new line appears with the file
name (`backup-<date>.zip`), date and size. A backup contains:

- the database: a full export, plus a snapshot of the file for SQLite;
- `uploads/`, `plugins/` and `themes/`.

The files are kept on the server in `/srv/wordjs/backend/backups/`. Each line has **Download**,
**Restore** and **Delete**.

Copy them to another machine too: a backup on the same disk doesn't survive the loss of that disk.
For example:

```bash
scp root@your-server:/srv/wordjs/backend/backups/backup-*.zip ./site-backups/
```

WordJS can also send every backup to an S3-compatible bucket automatically. See
[database.md §1.5](../database.md#15-backups--retention).

**Automatic backups:** under **Automatic schedule**, choose how often and at what time. The newest 7
backups are kept and older ones are deleted. The `backup_retention` option changes that number.

## 2. Upgrade

Take a backup first (step 1). Then, on the server:

```bash
sudo npx -y create-wordjs@latest upgrade /srv/wordjs --yes
```

The command:

1. downloads the latest release and checks its SHA-256;
2. backs up the config;
3. replaces the code. Your database, uploads, `wordjs-config.json` and installed plugins are kept;
4. reinstalls the dependencies.

It ends with:

```
✅ Upgraded WordJS: v2.5.0 → v2.6.0.
```

The new code was written by root. Give the folder back to the service account, as during the install,
then restart:

```bash
sudo chown -R wordjs: /srv/wordjs
```

```bash
sudo systemctl restart wordjs
```

Without the `chown`, the site still answers, but it can't write its page cache. The log shows
`EACCES: permission denied, mkdir '/srv/wordjs/frontend/.next/cache'`.

Database schema changes are applied automatically when the service starts. Check that it is running
and look at your site: posts, pages and images are all there.

```bash
sudo journalctl -u wordjs -n 30
```

- **A specific version:** add `--version v2.6.0`. The same flag rolls back: run the command with the
  previous tag. Your data is kept.
- **Is a new release out?** Releases are listed at
  <https://github.com/jaimemartinez/wordjs/releases>, and the changelog says what changed and whether
  you need to do anything.

## 3. Restore

Say a post was deleted by mistake. It was moved to the trash, and then the trash was emptied:

1. In **Admin → Settings → Backups**, click **Restore** on a backup taken before the deletion.
2. Confirm. The dialog warns that this **overwrites all current data and files** with the backup's.
3. Restart once, so the database is brought up to the current version's schema:

   ```bash
   sudo systemctl restart wordjs
   ```

The post is back, with its image. The first visit to the page can still show the cached "not found"
for a moment; reload.

Anything created after that backup is gone after the restore. To avoid losing it, take a new backup
just before you restore, so that you can go back to the present if you need to.

## Good to know

- Only an administrator signed in with their own account can restore; an API token can't.
- A backup taken on an older version restores on a newer one. In this tutorial, a 2.5.0 backup was
  restored on 2.6.0.
- On Postgres or MySQL, back up the database with its own tools as well (`pg_dump`, `mysqldump`).

---
*Tested on 2026-10-17 on a fresh Debian 12 machine:

1. **2.5.0 site:** installed WordJS 2.5.0 with `create-wordjs --systemd`, as in Tutorial 1. In a
   browser, added a post with an image, then clicked **Create backup**.
2. **Upgrade:** ran `create-wordjs upgrade` (v2.5.0 → v2.6.0). The site worked, but the page cache
   failed with `EACCES` until the `chown`, hence step 2's extra command. After the restart the post and
   image were intact.
3. **Restore:** deleted the post permanently, then restored the 2.5.0 backup from the browser on
   2.6.0. After the restart, the post (`200`) and its image (`200`) were back.*
