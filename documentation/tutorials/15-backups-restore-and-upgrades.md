# Tutorial 15 — Backups, restoring and upgrading

In this tutorial you take a backup of a site, upgrade WordJS to a new release with one command, and
restore the backup to bring back something that was deleted. You go from 2.6.0 to 2.7.0 here, but the
steps are the same for any release.

**Time:** about 20 minutes.
**You need:** a site installed as in [Tutorial 1](01-install-on-a-linux-server.md) (in `/srv/wordjs`,
run by the `wordjs` user as the `wordjs` service), an administrator account, and root access to the
server.

## 1. Take a backup

Open **Admin → Settings → Backups** and click **Create backup**. A new line appears with the file
name (`backup-<date>.zip`), date and size. A backup contains:

- the database: a full export, plus a snapshot of the file for SQLite;
- `uploads/`, `plugins/` and `themes/`.

The files are kept on the server in `/srv/wordjs/backend/backups/`, readable only by the service account
(`0600`). Each line has **Download**, **Restore** and **Delete**.

Copy them to another machine too: a backup on the same disk doesn't survive the loss of that disk.
For example:

```bash
scp root@your-server:/srv/wordjs/backend/backups/backup-*.zip ./site-backups/
```

WordJS can also send every backup to an S3-compatible bucket automatically. See
[database.md §1.5](../database.md#15-backups--retention).

**Automatic backups:** under **Automatic Schedule**, choose how often and at what time. The newest 7
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
4. reinstalls the dependencies;
5. gives the files back to the account that owns the site, so the service can still write its cache.

It ends with:

```
  Gave the upgraded files back to the site's owner (999:996).
✅ Upgraded WordJS: v2.6.0 → v2.7.0.
```

Then restart:

```bash
sudo systemctl restart wordjs
```

Database schema changes are applied automatically when the service starts. Check that it is running
and look at your site: posts, pages and images are all there.

```bash
sudo journalctl -u wordjs -n 30
```

- **A specific version:** add `--version v2.7.0`. The same flag rolls back: run the command with the
  previous tag. Your data is kept.
- **Coming from 2.6.0?** The 2.6.0 release package carried a stray test backup, and upgrading to 2.6.0
  copied it into the site's backups. If the list shows a backup dated **2026-10-15** that you did not
  create, delete it. Don't restore it.
- **Is a new release out?** Releases are listed at
  <https://github.com/jaimemartinez/wordjs/releases>, and the changelog says what changed and whether
  you need to do anything.

## 3. Restore

Say a post was deleted by mistake. It was moved to the trash, and then the trash was emptied:

1. In **Admin → Settings → Backups**, click **Restore** on a backup taken before the deletion.
2. Confirm. The dialog warns that this **overwrites all current data and files** with the backup's.
   When it finishes, the screen says *Backup restored* and asks you to restart the service.
3. Restart, so the restored plugins, themes and settings are loaded and the database is brought up to the
   current version's schema:

   ```bash
   sudo systemctl restart wordjs
   ```

The post is back, with its image. The first visit to the page can still show the cached "not found"
for a moment; reload.

Anything created after that backup is gone after the restore. To avoid losing it, take a new backup
just before you restore, so that you can go back to the present if you need to.

## Good to know

- Only an administrator signed in with their own account can restore; an API token can't.
- A backup taken on an older version restores on a newer one. In this tutorial, a 2.6.0 backup was
  restored on 2.7.0.
- On Postgres or MySQL, back up the database with its own tools as well (`pg_dump`, `mysqldump`).

---
*Tested on 2026-10-17 on a fresh Debian 12 machine:

1. **2.6.0 site:** installed WordJS 2.6.0 with `create-wordjs --systemd`, as in Tutorial 1, added a post
   with an image, and took a backup.
2. **Upgrade:** ran the 2.7.0 release's `create-wordjs upgrade` as root (v2.6.0 → v2.7.0). It gave the
   files back to the site's owner: no file was left owned by root, and there was no `EACCES` after the
   restart. The post and image were intact, and the existing backups were now `0600`.
3. **Restore, in a browser:** with the post deleted permanently, the 2.6.0 backup was restored on
   2.7.0. The *Backup restored* message appeared, and after the restart the post (`200`) and its image
   (`200`) were back.*
