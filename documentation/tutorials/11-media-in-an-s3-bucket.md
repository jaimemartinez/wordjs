# Tutorial 11 — Store your media in an S3-compatible bucket

By default WordJS keeps uploads on the server's disk. In this tutorial you move them to an
S3-compatible bucket: new uploads go straight to the bucket, the existing library is copied there,
and pages load images from the bucket's public address (or a CDN in front of it). The database keeps
its relative `/uploads/…` paths, so you can switch back at any time.

Any S3-compatible service works, such as AWS S3, Cloudflare R2, Backblaze B2 or a self-hosted server.
This tutorial uses **SeaweedFS**, a self-hosted, open-source server, so you can follow it without a
cloud account.

**Time:** about 20 minutes.
**You need:** a WordJS site with an administrator account and some media, for example the image
from [Tutorial 6](06-import-a-wordpress-site.md). You also need a second Linux machine for the
storage server; here, a Debian 12 machine at `192.168.182.56`.

## 1. Run an S3 server (skip if you use a cloud bucket)

On the storage machine, install the SeaweedFS binary from its
[releases page](https://github.com/seaweedfs/seaweedfs/releases) (`linux_amd64.tar.gz` contains a
single `weed` file):

```bash
tar xzf linux_amd64.tar.gz -C /usr/local/bin weed
```

Create `/etc/seaweedfs/s3.json` with an access key for WordJS and **anonymous read access to the
`media` bucket**. Visitors' browsers fetch the files directly, so they must be publicly readable;
nobody but WordJS can write. Replace the two keys with long random values:

```json
{ "identities": [
  { "name": "wordjs",
    "credentials": [ { "accessKey": "<ACCESS_KEY_ID>", "secretKey": "<SECRET_ACCESS_KEY>" } ],
    "actions": ["Read", "Write", "List", "Tagging"] },
  { "name": "anonymous", "actions": ["Read:media"] }
] }
```

Run it as a service, with the S3 API on port 8333. Create `/etc/systemd/system/seaweedfs.service`:

```ini
[Unit]
Description=SeaweedFS (S3 gateway)
After=network-online.target

[Service]
ExecStart=/usr/local/bin/weed server -dir=/var/lib/seaweedfs -ip=192.168.182.56 -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
mkdir -p /var/lib/seaweedfs && chmod 600 /etc/seaweedfs/s3.json && systemctl daemon-reload && systemctl enable --now seaweedfs
```

Then create the bucket:

```bash
echo 's3.bucket.create -name media' | weed shell -master=192.168.182.56:9333
```

With a cloud provider, create a bucket instead, make its objects publicly readable (or put a CDN in
front of it), and create an access key that can write to it.

## 2. Point WordJS at the bucket

Open **Admin → Settings → Media storage** and choose **S3-compatible bucket**:

| Field | Value here | Notes |
|---|---|---|
| **Bucket** | `media` | |
| **Region** | `us-east-1` | R2 uses `auto`; B2 a region like `us-west-004` |
| **Endpoint** | `http://192.168.182.56:8333` | Empty for AWS. For R2 `https://<account>.r2.cloudflarestorage.com` |
| **Key prefix** | *(empty)* | Defaults to `uploads` |
| **Public URL / CDN** | `http://192.168.182.56:8333/media` | The address of the **bucket root**. Don't add `/uploads` |
| **Access key ID**, **Secret access key** | the keys from step 1 | The secret is never shown again |

Click **Save**. The status line reads **Now: S3-compatible bucket** and *Media is served from
http://192.168.182.56:8333/media/uploads*. From this moment, new uploads go to the bucket.

For a real site, use **HTTPS** and a public URL on a domain other than the site's own (for example
`https://media.example.com`), so that no cookies are ever sent with media requests.

## 3. Test the connection

Wait a minute, **reload the page**, and click **Test connection**. The server writes a small probe
image to the bucket and reads it back. Then your browser loads it from the public URL, the same way
visitors will, and the server deletes it:

```
Write — HTTP 200
Read — HTTP 200
Public URL — http://192.168.182.56:8333/media/uploads/.wordjs-connection-test-….png
Delete — HTTP 204
Connection works: the bucket accepts writes and the public URL serves the files.
```

If **Public URL** says *not loadable from this browser* right after you saved, the admin page is
still running on its old security policy, which doesn't list the bucket's address yet. It refreshes
within a minute. Reload and test again. If it still fails, open the public URL of any object in a
browser: an access-denied error means the objects aren't publicly readable.

## 4. Move the existing library

Under **Existing library**, click **Move to the bucket** and confirm. Every public file is copied:
the original and every generated size. For the sample site the result reads *1/1 · 1 moved · 0
skipped · 0 with errors*, and the status changes to **Library in the bucket (pages use the CDN)**.

Tick **Delete each local copy once it is verified in the bucket** before moving if you want to free
the disk; otherwise the local copies stay as a fallback. Private media is never moved.

## 5. Check the site

- Open a post with an image, such as `/how-we-brew-a-pour-over`. The image now loads from
  `http://192.168.182.56:8333/media/uploads/2024/03/beans.png`. Pages are cached, so this can take a
  minute and a reload.
- Upload a new image in **Admin → Media**. Its file goes straight to the bucket (`storage: s3`) and
  nothing new appears in `backend/uploads/` on the server.
- Old links keep working. A request for `/uploads/…` that is no longer on the server's disk is
  redirected (`302`) to the bucket:

  ```bash
  curl -sI https://<your-site>/uploads/2026/10/<file>.png
  ```

## Going back

**Move back to local disk** brings every file home, then you can choose **Local disk** and save.
Nothing in the database changes in either direction.

The same operations are available on the server, from the installation folder:

```bash
npm run media -- status
npm run media -- test
npm run media -- offload --delete-local
npm run media -- restore
```

All settings can also come from environment variables (`WORDJS_MEDIA_STORAGE=s3`,
`WORDJS_MEDIA_S3_BUCKET`, …), listed in [media-storage.md](../media-storage.md).

---
*Tested on 2026-10-17 with WordJS 2.6.0 on a fresh install, with SeaweedFS 4.48 on a second Debian 12
machine. The steps were done in a browser:

- the settings were saved;
- **Test connection** passed after a reload (before the reload it reported the public URL as not
  loadable);
- **Move to the bucket** reported 1/1 moved;
- the post's image loaded from the bucket;
- a new upload was stored only in the bucket (`deliveryUrl` on the bucket, nothing on local disk).

`/uploads/…` answered `302` to the bucket, and the object answered `200 image/png` without
credentials.*
