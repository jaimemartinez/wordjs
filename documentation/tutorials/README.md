# Tutorials

These are step-by-step walkthroughs, each with a concrete goal. Every tutorial was followed on fresh
machines in a test lab before it was published. Its footer says what was tested and on which version.

The examples follow one small site, **Corner Roasters**, a coffee roastery. You can do the tutorials in
any order once you have a site; links point back to earlier ones where they build on them.

## Install and run

| # | Tutorial | You end up with |
|---|---|---|
| 1 | [Install WordJS on a Linux server](01-install-on-a-linux-server.md) | A site running as a systemd service, installed through the browser |
| 2 | [Put nginx and HTTPS in front](02-nginx-and-https.md) | Your own domain with a certificate, nginx as the reverse proxy, real visitor IPs |
| 3 | [Split mode on one server](03-split-mode-on-one-server.md) | Gateway, frontend and backend as three services on one machine |
| 4 | [Separate mode on three machines](04-separate-mode-three-machines.md) | A cluster joined with tokens and mutual TLS |
| 12 | [Run several sites from one install](12-run-several-sites.md) | A network with a second, fully separate site |
| 15 | [Backups, restoring and upgrading](15-backups-restore-and-upgrades.md) | A backup, an upgrade to a new release, and a restore |

## Build the site

| # | Tutorial | You end up with |
|---|---|---|
| 5 | [Your first page with the Verso editor](05-your-first-page-with-verso.md) | A published page built from blocks |
| 6 | [Move a WordPress site to WordJS](06-import-a-wordpress-site.md) | Posts, pages, terms, comments, images and menus imported from a WordPress export |
| 8 | [Create a theme](08-create-a-theme.md) | Your own theme from four colors, checked by the theme doctor and installed |
| 17 | [Design your header and footer](17-design-your-header-and-footer.md) | A two-row header and a four-column footer from templates, checked at three widths, and the old footer settings converted |
| 11 | [Store your media in an S3-compatible bucket](11-media-in-an-s3-bucket.md) | Uploads served from a bucket or CDN, with the existing library moved |

## Extend and connect

| # | Tutorial | You end up with |
|---|---|---|
| 7 | [Build your first plugin](07-build-your-first-plugin.md) | A sandboxed plugin with an admin page, an API and a Verso block |
| 9 | [Connect an AI agent to your site](09-connect-an-ai-agent.md) | An MCP connection that can read and draft but not publish |
| 10 | [AI suggestions with a model on your own server](10-ai-suggestions-with-a-local-model.md) | Excerpt and meta-description suggestions from a local Ollama model |
| 13 | [React to site changes with webhooks](13-webhooks.md) | A receiver that verifies signed deliveries |
| 14 | [Read your content with GraphQL](14-read-your-content-with-graphql.md) | Queries from the command line and a script that builds a static page |
| 16 | [Send email from your site](16-send-email-from-your-site.md) | The Mail Server plugin sending through an SMTP relay, password recovery working |

Files used by the tutorials are in [`files/`](files/).

The reference documentation is in the [documentation index](../README.md).
