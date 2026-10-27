"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { plural, registerTranslations } from "@/lib/i18n";
import { PageHeader, Button, Card } from "@/components/ui";

/**
 * Admin → Site Health: the installation's diagnostics (backend core/site-health, GET /health/site) — the
 * versions, folders and disk, database engine, mail and its DNS, HTTPS, reverse proxy, scheduled tasks and
 * plugin isolation — each in plain words with a link to the screen that fixes it. Read-only; runs again on
 * demand.
 */

type Status = "ok" | "warn" | "fail" | "info";
interface Check {
    id: string; group: string; status: Status; title: string; message: string;
    fix?: { href: string; label: string; labelKey?: string };
    /** A one-click fix: POST `endpoint` with `body`, then run the checks again. */
    action?: { endpoint: string; label: string; labelKey?: string; body?: Record<string, string> };
    /** Catalogue keys from core/site-health; absent (older backend, plugin-added check) → the English text. */
    titleKey?: string; messageKey?: string; vars?: Record<string, string>;
}
interface Report { checks: Check[]; summary: Record<Status, number>; at: string; host: string }

/*
 * The checks' own words, by the keys core/site-health sends (titleKey, messageKey, fix.labelKey) with
 * their {placeholders} filled from `vars`. The English entries reproduce the backend's text exactly, so a
 * key missing here (or a check without keys) falls back to the same English sentence.
 */
registerTranslations({
    es: {
        "siteHealth.check.error": "Esta comprobación no se ha podido ejecutar aquí ({error}).",
        "siteHealth.check.versions.node.title": "WordJS y Node.js",
        "siteHealth.check.versions.node.ok": "WordJS {version} sobre Node.js {node}.",
        "siteHealth.check.versions.node.old": "Node.js {node} es anterior a la {min}, que es la que necesita WordJS. Pide a tu proveedor de hosting que instale Node.js {min} o 24 LTS.",
        "siteHealth.check.versions.update.title": "Actualizaciones",
        "siteHealth.check.versions.update.offline": "No se ha podido comprobar desde aquí si hay un WordJS más reciente (no hay conexión con GitHub).",
        "siteHealth.check.versions.update.latest": "WordJS {current} es la última versión.",
        "siteHealth.check.versions.update.available": "Hay disponible WordJS {latest} (este sitio usa {current}).",
        "siteHealth.check.storage.folders.title": "Carpetas en las que escribe WordJS",
        "siteHealth.check.storage.folders.notWritable": "WordJS no puede escribir en: {folders}. Las subidas, los plugins o los temas fallarán hasta que la carpeta pertenezca a la cuenta con la que se ejecuta WordJS.",
        "siteHealth.check.storage.folders.ok": "Se puede escribir en las carpetas de subidas, datos, plugins y temas.",
        "siteHealth.check.storage.config.title": "Archivo de configuración",
        "siteHealth.check.storage.config.ok": "WordJS puede guardar los ajustes que viven en wordjs-config.json.",
        "siteHealth.check.storage.config.readOnly": "wordjs-config.json es de solo lectura para WordJS, así que los cambios hechos en el panel (dirección del sitio, red, ajustes del servidor) no se pueden guardar.",
        "siteHealth.check.storage.root.title": "Cuenta con la que se ejecuta WordJS",
        "siteHealth.check.storage.root.root": "WordJS se está ejecutando como root. Los archivos que crea pertenecen a root; ejecútalo con su propia cuenta de servicio (create-wordjs --systemd lo hace).",
        "siteHealth.check.storage.disk.title": "Espacio libre en disco",
        "siteHealth.check.storage.disk.unsupported": "Esta versión de Node.js no puede informar del espacio libre en disco.",
        "siteHealth.check.storage.disk.critical": "{free} libres de {total}. Las subidas, las copias de seguridad y la base de datos pueden fallar. Borra copias antiguas o mueve los medios a un bucket.",
        "siteHealth.check.storage.disk.low": "{free} libres de {total}. Queda poco espacio.",
        "siteHealth.check.storage.disk.ok": "{free} libres de {total}.",
        "siteHealth.check.database.reachable.title": "Base de datos",
        "siteHealth.check.database.reachable.ok": "La base de datos responde ({driver}).",
        "siteHealth.check.database.reachable.down": "La base de datos no responde: {error}.",
        "siteHealth.check.database.pluginIsolation.title": "Aislamiento de los plugins en la base de datos",
        "siteHealth.check.database.pluginIsolation.missing": "Estos plugins funcionan sin su propio usuario de base de datos, así que solo las comprobaciones SQL de WordJS los limitan a sus propias tablas: {plugins}. Da al usuario de base de datos con el que conecta WordJS permiso para crear usuarios (Postgres: CREATEROLE; MySQL/MariaDB: CREATE USER y GRANT OPTION) y reinicia WordJS.",
        "siteHealth.check.database.driver.title": "Motor de base de datos",
        "siteHealth.check.database.driver.legacy": "Este sitio usa el motor SQLite antiguo y más lento (sqlite-legacy), que mantiene toda la base de datos en memoria y no admite una red de sitios. Pásalo al motor actual: tarda un minuto y WordJS se reinicia solo.",
        "siteHealth.check.mail.transport.title": "Envío de correo",
        "siteHealth.check.mail.transport.ok": "El sitio puede enviar restablecimientos de contraseña y notificaciones.",
        "siteHealth.check.mail.transport.none": "El sitio todavía no puede enviar correo, así que «¿Has olvidado tu contraseña?» no funciona y nadie recibe avisos. Configura el correo de cuentas.",
        "siteHealth.check.mail.dns.title": "Dominio de correo (SPF, DMARC)",
        "siteHealth.check.mail.dns.local": "{domain} es un nombre local o reservado; no hay registros DNS que comprobar.",
        "siteHealth.check.mail.dns.noEmail": "Indica el correo del sitio en Configuración → General para comprobar su dominio.",
        "siteHealth.check.mail.dns.ok": "{domain} publica SPF y DMARC.",
        "siteHealth.check.mail.dns.missingBoth": "A {domain} le faltan un registro SPF y un registro DMARC: es probable que el correo del sitio acabe en spam. Añádelos donde se gestiona el DNS del dominio; tu proveedor de correo te da los valores exactos.",
        "siteHealth.check.mail.dns.missingSpf": "A {domain} le falta un registro SPF: es probable que el correo del sitio acabe en spam. Añádelo donde se gestiona el DNS del dominio; tu proveedor de correo te da los valores exactos.",
        "siteHealth.check.mail.dns.missingDmarc": "A {domain} le falta un registro DMARC: es probable que el correo del sitio acabe en spam. Añádelo donde se gestiona el DNS del dominio; tu proveedor de correo te da los valores exactos.",
        "siteHealth.check.security.tls.title": "HTTPS",
        "siteHealth.check.security.tls.local": "Una instalación local: HTTP sin cifrar está bien en este equipo.",
        "siteHealth.check.security.tls.http": "La dirección principal ({url}) no es HTTPS: las contraseñas viajan sin cifrar. Consigue un certificado y después cambia la dirección a https.",
        "siteHealth.check.security.tls.noAddress": "La dirección principal (sin configurar) no es HTTPS: las contraseñas viajan sin cifrar. Consigue un certificado y después cambia la dirección a https.",
        "siteHealth.check.security.tls.unreadable": "HTTPS está configurado; el certificado en uso no se ha podido leer desde aquí (puede que lo tenga un proxy).",
        "siteHealth.check.security.tls.expired": "El certificado caducó hace {days} día(s): los navegadores rechazan el sitio.",
        "siteHealth.check.security.tls.selfSigned": "El certificado es autofirmado: los visitantes ven un aviso de seguridad. Consigue un certificado gratuito de Let’s Encrypt.",
        "siteHealth.check.security.tls.expiring": "El certificado caduca dentro de {days} día(s). Activa la renovación automática o renuévalo ahora.",
        "siteHealth.check.security.tls.ok": "El certificado es válido durante {days} día(s) más.",
        "siteHealth.check.security.proxy.title": "Proxy inverso",
        "siteHealth.check.security.proxy.untrusted": "Esta petición llegó a través de un proxy de este equipo en el que WordJS no confía: todos los visitantes se ven como 127.0.0.1, así que el bloqueo de inicio de sesión y los límites de peticiones tratan a todo el sitio como una sola persona.",
        "siteHealth.check.security.proxy.none": "No se confía en ningún proxy y no se ha visto ninguno: los visitantes se cuentan por su propia dirección.",
        "siteHealth.check.security.proxy.trusted": "Proxy de confianza: {proxy}.",
        "siteHealth.check.background.cron.title": "Tareas programadas",
        "siteHealth.check.background.cron.ok": "La publicación programada, las copias de seguridad y las renovaciones se ejecutan.",
        "siteHealth.check.background.cron.stopped": "El planificador no se está ejecutando en este proceso: las entradas programadas, las copias de seguridad y las renovaciones de certificados esperan. Reinicia WordJS; si continúa, revisa el registro.",
        "siteHealth.check.background.plugins.title": "Aislamiento de plugins",
        "siteHealth.check.background.plugins.degraded": "Los plugins funcionan, pero sin el confinamiento adicional del sistema operativo en este servidor. Puede que tu hosting necesite un kernel más reciente o activar el sandbox de la plataforma.",
        "siteHealth.check.background.plugins.ok": "Los plugins se ejecutan aislados del sitio y entre sí.",
        "siteHealth.check.security.pluginNetwork.title": "Plugins y redes privadas",
        "siteHealth.check.security.pluginNetwork.ok": "Los plugins no pueden llegar a redes privadas (locales, VPN, metadatos de la nube) salvo a un destino que hayas aprobado.",
        "siteHealth.check.security.pluginNetwork.missing": "Windows trata algunas redes privadas (una VPN, una LAN enrutada, los metadatos de la nube en 169.254.169.254) como Internet, así que un plugin con acceso a la red podría llegar a ellas sin pasar por el sandbox del sistema. Aplica los rangos de red privada una vez; Windows pedirá un administrador en este servidor.",
        "siteHealth.check.security.pluginSecrets.title": "Acceso de los plugins a secretos",
        "siteHealth.check.security.pluginSecrets.exposed": "Todos los sandbox de plugins de este servidor pueden leer {count} carpeta(s) o archivo(s) con secretos por cómo están los permisos de la carpeta de instalación, y WordJS no ha podido cambiarlos. Los plugins no se inician hasta que se corrija: ejecuta como administrador icacls <ruta> /inheritance:d y después icacls <ruta> /remove:g *S-1-15-2-1 *S-1-15-2-2 en cada una, o mueve WordJS fuera de C:\\Program Files.",
        "siteHealth.check.background.pluginFiles.title": "Archivos de plugins",
        "siteHealth.check.background.pluginFiles.changed": "Los archivos del plugin {slug} han cambiado desde que WordJS lo instaló, así que no se ha iniciado. Actualízalo o reinstálalo desde Plugins; si los cambiaste tú, acéptalos.",
        "siteHealth.check.security.pluginPorts.title": "Puertos de red de los plugins",
        "siteHealth.check.security.pluginPorts.unavailable": "Este kernel de Linux no puede limitar a qué puertos se conecta un plugin con acceso a la red (hace falta el kernel 6.7 o posterior), así que solo los limita WordJS.",
        "siteHealth.action.applyWindowsNetwork": "Aplicar (administrador)",
        "siteHealth.action.acceptPluginFiles": "Aceptar estos archivos",
        "siteHealth.check.background.outbox.title": "Eventos de contenido",
        "siteHealth.check.background.outbox.dead": "{count} evento(s) de contenido no se han podido entregar (webhooks, búsqueda, caché).",
        "siteHealth.check.background.outbox.ok": "Los webhooks y las actualizaciones de caché se entregan.",
        "siteHealth.check.background.purge.title": "Caché de páginas",
        "siteHealth.check.background.purge.broken": "Los cambios publicados solo llegan a los visitantes cuando caduca la caché de páginas: las actualizaciones de caché bajo demanda han fallado en este proceso.",
        "siteHealth.check.background.restart.title": "Reinicio automático",
        "siteHealth.check.background.restart.manual": "Nada reinicia WordJS aquí: tras mover la base de datos, restaurar una copia o cambiar de red tendrás que reiniciarlo a mano. Arráncalo con npm start, el monolito, Docker o systemd.",
        "siteHealth.check.background.restart.ok": "WordJS se reinicia solo cuando un cambio lo necesita ({mode}).",
        "siteHealth.fixLabel.updates": "Actualizaciones",
        "siteHealth.fixLabel.backups": "Copias de seguridad",
        "siteHealth.fixLabel.mediaStorage": "Almacenamiento de medios",
        "siteHealth.fixLabel.migrateEngine": "Pasar a sqlite-native",
        "siteHealth.fixLabel.accountEmail": "Correo de cuentas",
        "siteHealth.fixLabel.certificates": "Certificados",
        "siteHealth.fixLabel.securityServer": "Seguridad → Servidor",
        "siteHealth.fixLabel.webhooks": "Webhooks",
    },
    en: {
        "siteHealth.check.error": "This check could not run here ({error}).",
        "siteHealth.check.versions.node.title": "WordJS and Node.js",
        "siteHealth.check.versions.node.ok": "WordJS {version} on Node.js {node}.",
        "siteHealth.check.versions.node.old": "Node.js {node} is older than {min}, which WordJS needs. Ask your host to install Node.js {min} or 24 LTS.",
        "siteHealth.check.versions.update.title": "Updates",
        "siteHealth.check.versions.update.offline": "Could not check for a newer WordJS from here (no connection to GitHub).",
        "siteHealth.check.versions.update.latest": "WordJS {current} is the latest release.",
        "siteHealth.check.versions.update.available": "WordJS {latest} is available (this site runs {current}).",
        "siteHealth.check.storage.folders.title": "Folders WordJS writes to",
        "siteHealth.check.storage.folders.notWritable": "WordJS cannot write to: {folders}. Uploads, plugins or themes fail until the folder belongs to the account WordJS runs as.",
        "siteHealth.check.storage.folders.ok": "Uploads, data, plugins and themes are writable.",
        "siteHealth.check.storage.config.title": "Configuration file",
        "siteHealth.check.storage.config.ok": "WordJS can save the settings that live in wordjs-config.json.",
        "siteHealth.check.storage.config.readOnly": "wordjs-config.json is read-only for WordJS, so changes made in the panel (site address, network, server settings) cannot be saved.",
        "siteHealth.check.storage.root.title": "Account WordJS runs as",
        "siteHealth.check.storage.root.root": "WordJS is running as root. Files it creates belong to root; run it as its own service account (create-wordjs --systemd does).",
        "siteHealth.check.storage.disk.title": "Free disk space",
        "siteHealth.check.storage.disk.unsupported": "This Node.js cannot report free disk space.",
        "siteHealth.check.storage.disk.critical": "{free} free of {total}. Uploads, backups and the database can fail. Delete old backups or move media to a bucket.",
        "siteHealth.check.storage.disk.low": "{free} free of {total}. Running low.",
        "siteHealth.check.storage.disk.ok": "{free} free of {total}.",
        "siteHealth.check.database.reachable.title": "Database",
        "siteHealth.check.database.reachable.ok": "The database answers ({driver}).",
        "siteHealth.check.database.reachable.down": "The database does not answer: {error}.",
        "siteHealth.check.database.pluginIsolation.title": "Plugin database isolation",
        "siteHealth.check.database.pluginIsolation.missing": "These plugins run without their own database user, so only WordJS's SQL checks keep them to their own tables: {plugins}. Give the database user WordJS connects with the right to create users (Postgres: CREATEROLE; MySQL/MariaDB: CREATE USER and GRANT OPTION) and restart WordJS.",
        "siteHealth.check.database.driver.title": "Database engine",
        "siteHealth.check.database.driver.legacy": "This site runs on the older, slower SQLite engine (sqlite-legacy), which keeps the whole database in memory and cannot hold a network of sites. Move it to the current engine: it takes a minute and restarts WordJS by itself.",
        "siteHealth.check.mail.transport.title": "Sending email",
        "siteHealth.check.mail.transport.ok": "The site can send password resets and notifications.",
        "siteHealth.check.mail.transport.none": "The site cannot send email yet, so \"Forgot password?\" does not work and nobody is notified. Set up account email.",
        "siteHealth.check.mail.dns.title": "Mail domain (SPF, DMARC)",
        "siteHealth.check.mail.dns.local": "{domain} is a local or reserved name; there are no DNS records to check.",
        "siteHealth.check.mail.dns.noEmail": "Set the site email in Settings → General to check its domain.",
        "siteHealth.check.mail.dns.ok": "{domain} publishes SPF and DMARC.",
        "siteHealth.check.mail.dns.missingBoth": "{domain} is missing an SPF record and a DMARC record: mail from the site is likely to land in spam. Add them where the domain's DNS is managed; your mail provider gives the exact values.",
        "siteHealth.check.mail.dns.missingSpf": "{domain} is missing an SPF record: mail from the site is likely to land in spam. Add them where the domain's DNS is managed; your mail provider gives the exact values.",
        "siteHealth.check.mail.dns.missingDmarc": "{domain} is missing a DMARC record: mail from the site is likely to land in spam. Add them where the domain's DNS is managed; your mail provider gives the exact values.",
        "siteHealth.check.security.tls.title": "HTTPS",
        "siteHealth.check.security.tls.local": "A local install: plain HTTP is fine on this computer.",
        "siteHealth.check.security.tls.http": "The main address ({url}) is not HTTPS: passwords travel unencrypted. Get a certificate, then switch the address to https.",
        "siteHealth.check.security.tls.noAddress": "The main address (not set) is not HTTPS: passwords travel unencrypted. Get a certificate, then switch the address to https.",
        "siteHealth.check.security.tls.unreadable": "HTTPS is configured; the certificate in use could not be read from here (a proxy may hold it).",
        "siteHealth.check.security.tls.expired": "The certificate expired {days} day(s) ago: browsers refuse the site.",
        "siteHealth.check.security.tls.selfSigned": "The certificate is self-signed: visitors see a security warning. Get a free Let’s Encrypt certificate.",
        "siteHealth.check.security.tls.expiring": "The certificate expires in {days} day(s). Turn on automatic renewal or renew it now.",
        "siteHealth.check.security.tls.ok": "The certificate is valid for {days} more day(s).",
        "siteHealth.check.security.proxy.title": "Reverse proxy",
        "siteHealth.check.security.proxy.untrusted": "This request came through a proxy on this computer that WordJS does not trust: every visitor is seen as 127.0.0.1, so login lockout and rate limits treat the whole site as one person.",
        "siteHealth.check.security.proxy.none": "No proxy is trusted, and none was seen: visitors are counted by their own address.",
        "siteHealth.check.security.proxy.trusted": "Trusted proxy: {proxy}.",
        "siteHealth.check.background.cron.title": "Scheduled tasks",
        "siteHealth.check.background.cron.ok": "Scheduled publishing, backups and renewals run.",
        "siteHealth.check.background.cron.stopped": "The scheduler is not running in this process: scheduled posts, backups and certificate renewals wait. Restart WordJS; if it persists, check the log.",
        "siteHealth.check.background.plugins.title": "Plugin isolation",
        "siteHealth.check.background.plugins.degraded": "Plugins run, but without the operating system’s extra confinement on this host. Your host may need a newer kernel or the platform’s sandbox enabled.",
        "siteHealth.check.background.plugins.ok": "Plugins run isolated from the site and from each other.",
        "siteHealth.check.security.pluginNetwork.title": "Plugins and private networks",
        "siteHealth.check.security.pluginNetwork.ok": "Plugins cannot reach private networks (local, VPN, cloud metadata) unless you approved a destination for them.",
        "siteHealth.check.security.pluginNetwork.missing": "Windows treats some private networks (a VPN, a routed LAN, cloud metadata at 169.254.169.254) as the Internet, so a plugin with network access could reach them past the system sandbox. Apply the private network ranges once; Windows asks for an administrator on this server.",
        "siteHealth.check.security.pluginSecrets.title": "Plugin access to secrets",
        "siteHealth.check.security.pluginSecrets.exposed": "Every plugin sandbox on this server can read {count} folder(s) or file(s) that hold secrets, because of how the install folder's permissions are set, and WordJS could not change them. Plugins are not started until this is fixed: run, as an administrator, icacls <path> /inheritance:d and then icacls <path> /remove:g *S-1-15-2-1 *S-1-15-2-2 for each one, or move WordJS out of C:\\Program Files.",
        "siteHealth.check.background.pluginFiles.title": "Plugin files",
        "siteHealth.check.background.pluginFiles.changed": "The files of the plugin {slug} changed since WordJS installed it, so it was not started. Update or reinstall it from Plugins; if you changed them yourself, accept them.",
        "siteHealth.check.security.pluginPorts.title": "Plugin network ports",
        "siteHealth.check.security.pluginPorts.unavailable": "This Linux kernel cannot limit which ports a plugin with network access connects to (that needs kernel 6.7 or later), so only WordJS itself limits them.",
        "siteHealth.action.applyWindowsNetwork": "Apply (administrator)",
        "siteHealth.action.acceptPluginFiles": "Accept these files",
        "siteHealth.check.background.outbox.title": "Content events",
        "siteHealth.check.background.outbox.dead": "{count} content event(s) could not be delivered (webhooks, search, cache).",
        "siteHealth.check.background.outbox.ok": "Webhooks and cache updates are delivered.",
        "siteHealth.check.background.purge.title": "Page cache",
        "siteHealth.check.background.purge.broken": "Published changes reach visitors only when the page cache expires: on-demand cache updates failed in this process.",
        "siteHealth.check.background.restart.title": "Restarting by itself",
        "siteHealth.check.background.restart.manual": "Nothing here restarts WordJS: after a database move, a restore or a network switch you will have to restart it by hand. Start it with npm start, the monolith, Docker or systemd.",
        "siteHealth.check.background.restart.ok": "WordJS restarts itself when a change needs it ({mode}).",
        "siteHealth.fixLabel.updates": "Updates",
        "siteHealth.fixLabel.backups": "Backups",
        "siteHealth.fixLabel.mediaStorage": "Media storage",
        "siteHealth.fixLabel.migrateEngine": "Move to sqlite-native",
        "siteHealth.fixLabel.accountEmail": "Account email",
        "siteHealth.fixLabel.certificates": "Certificates",
        "siteHealth.fixLabel.securityServer": "Security → Server",
        "siteHealth.fixLabel.webhooks": "Webhooks",
    },
    pt: {
        "siteHealth.check.error": "Esta verificação não pôde ser executada aqui ({error}).",
        "siteHealth.check.versions.node.title": "WordJS e Node.js",
        "siteHealth.check.versions.node.ok": "WordJS {version} no Node.js {node}.",
        "siteHealth.check.versions.node.old": "O Node.js {node} é anterior ao {min}, que o WordJS exige. Peça à sua hospedagem para instalar o Node.js {min} ou 24 LTS.",
        "siteHealth.check.versions.update.title": "Atualizações",
        "siteHealth.check.versions.update.offline": "Não foi possível verificar daqui se há um WordJS mais recente (sem conexão com o GitHub).",
        "siteHealth.check.versions.update.latest": "O WordJS {current} é a versão mais recente.",
        "siteHealth.check.versions.update.available": "O WordJS {latest} está disponível (este site usa o {current}).",
        "siteHealth.check.storage.folders.title": "Pastas em que o WordJS grava",
        "siteHealth.check.storage.folders.notWritable": "O WordJS não consegue gravar em: {folders}. Uploads, plugins ou temas falham até que a pasta pertença à conta com que o WordJS é executado.",
        "siteHealth.check.storage.folders.ok": "As pastas de uploads, dados, plugins e temas são graváveis.",
        "siteHealth.check.storage.config.title": "Arquivo de configuração",
        "siteHealth.check.storage.config.ok": "O WordJS consegue salvar as configurações que ficam em wordjs-config.json.",
        "siteHealth.check.storage.config.readOnly": "O wordjs-config.json é somente leitura para o WordJS, então as alterações feitas no painel (endereço do site, rede, configurações do servidor) não podem ser salvas.",
        "siteHealth.check.storage.root.title": "Conta com que o WordJS é executado",
        "siteHealth.check.storage.root.root": "O WordJS está sendo executado como root. Os arquivos que ele cria pertencem ao root; execute-o com uma conta de serviço própria (o create-wordjs --systemd faz isso).",
        "siteHealth.check.storage.disk.title": "Espaço livre em disco",
        "siteHealth.check.storage.disk.unsupported": "Esta versão do Node.js não consegue informar o espaço livre em disco.",
        "siteHealth.check.storage.disk.critical": "{free} livres de {total}. Uploads, backups e o banco de dados podem falhar. Apague backups antigos ou mova as mídias para um bucket.",
        "siteHealth.check.storage.disk.low": "{free} livres de {total}. O espaço está acabando.",
        "siteHealth.check.storage.disk.ok": "{free} livres de {total}.",
        "siteHealth.check.database.reachable.title": "Banco de dados",
        "siteHealth.check.database.reachable.ok": "O banco de dados responde ({driver}).",
        "siteHealth.check.database.reachable.down": "O banco de dados não responde: {error}.",
        "siteHealth.check.database.pluginIsolation.title": "Isolamento dos plugins no banco de dados",
        "siteHealth.check.database.pluginIsolation.missing": "Estes plugins funcionam sem o seu próprio usuário de banco de dados, então só as verificações SQL do WordJS os limitam às suas próprias tabelas: {plugins}. Dê ao usuário de banco de dados com que o WordJS se conecta o direito de criar usuários (Postgres: CREATEROLE; MySQL/MariaDB: CREATE USER e GRANT OPTION) e reinicie o WordJS.",
        "siteHealth.check.database.driver.title": "Mecanismo do banco de dados",
        "siteHealth.check.database.driver.legacy": "Este site usa o mecanismo SQLite antigo e mais lento (sqlite-legacy), que mantém todo o banco de dados na memória e não comporta uma rede de sites. Mude para o mecanismo atual: leva um minuto e o WordJS reinicia sozinho.",
        "siteHealth.check.mail.transport.title": "Envio de e-mail",
        "siteHealth.check.mail.transport.ok": "O site consegue enviar redefinições de senha e notificações.",
        "siteHealth.check.mail.transport.none": "O site ainda não consegue enviar e-mail, então \"Esqueceu a senha?\" não funciona e ninguém é notificado. Configure o e-mail de contas.",
        "siteHealth.check.mail.dns.title": "Domínio de e-mail (SPF, DMARC)",
        "siteHealth.check.mail.dns.local": "{domain} é um nome local ou reservado; não há registros DNS para verificar.",
        "siteHealth.check.mail.dns.noEmail": "Defina o e-mail do site em Configurações → Geral para verificar o domínio dele.",
        "siteHealth.check.mail.dns.ok": "{domain} publica SPF e DMARC.",
        "siteHealth.check.mail.dns.missingBoth": "Faltam em {domain} um registro SPF e um registro DMARC: o e-mail do site provavelmente vai cair no spam. Adicione-os onde o DNS do domínio é gerenciado; seu provedor de e-mail fornece os valores exatos.",
        "siteHealth.check.mail.dns.missingSpf": "Falta em {domain} um registro SPF: o e-mail do site provavelmente vai cair no spam. Adicione-o onde o DNS do domínio é gerenciado; seu provedor de e-mail fornece os valores exatos.",
        "siteHealth.check.mail.dns.missingDmarc": "Falta em {domain} um registro DMARC: o e-mail do site provavelmente vai cair no spam. Adicione-o onde o DNS do domínio é gerenciado; seu provedor de e-mail fornece os valores exatos.",
        "siteHealth.check.security.tls.title": "HTTPS",
        "siteHealth.check.security.tls.local": "Uma instalação local: HTTP simples não tem problema neste computador.",
        "siteHealth.check.security.tls.http": "O endereço principal ({url}) não é HTTPS: as senhas trafegam sem criptografia. Obtenha um certificado e depois mude o endereço para https.",
        "siteHealth.check.security.tls.noAddress": "O endereço principal (não definido) não é HTTPS: as senhas trafegam sem criptografia. Obtenha um certificado e depois mude o endereço para https.",
        "siteHealth.check.security.tls.unreadable": "O HTTPS está configurado; o certificado em uso não pôde ser lido daqui (talvez um proxy o detenha).",
        "siteHealth.check.security.tls.expired": "O certificado expirou há {days} dia(s): os navegadores recusam o site.",
        "siteHealth.check.security.tls.selfSigned": "O certificado é autoassinado: os visitantes veem um aviso de segurança. Obtenha um certificado gratuito do Let’s Encrypt.",
        "siteHealth.check.security.tls.expiring": "O certificado expira em {days} dia(s). Ative a renovação automática ou renove agora.",
        "siteHealth.check.security.tls.ok": "O certificado é válido por mais {days} dia(s).",
        "siteHealth.check.security.proxy.title": "Proxy reverso",
        "siteHealth.check.security.proxy.untrusted": "Esta requisição passou por um proxy neste computador em que o WordJS não confia: todo visitante aparece como 127.0.0.1, então o bloqueio de login e os limites de requisições tratam o site inteiro como uma só pessoa.",
        "siteHealth.check.security.proxy.none": "Nenhum proxy é confiável e nenhum foi visto: os visitantes são contados pelo próprio endereço.",
        "siteHealth.check.security.proxy.trusted": "Proxy confiável: {proxy}.",
        "siteHealth.check.background.cron.title": "Tarefas agendadas",
        "siteHealth.check.background.cron.ok": "A publicação agendada, os backups e as renovações estão rodando.",
        "siteHealth.check.background.cron.stopped": "O agendador não está rodando neste processo: posts agendados, backups e renovações de certificados ficam esperando. Reinicie o WordJS; se continuar, verifique o log.",
        "siteHealth.check.background.plugins.title": "Isolamento de plugins",
        "siteHealth.check.background.plugins.degraded": "Os plugins funcionam, mas sem o confinamento extra do sistema operacional neste servidor. Sua hospedagem pode precisar de um kernel mais novo ou ativar o sandbox da plataforma.",
        "siteHealth.check.background.plugins.ok": "Os plugins rodam isolados do site e uns dos outros.",
        "siteHealth.check.security.pluginNetwork.title": "Plugins e redes privadas",
        "siteHealth.check.security.pluginNetwork.ok": "Os plugins não conseguem alcançar redes privadas (locais, VPN, metadados da nuvem), exceto um destino que você aprovou.",
        "siteHealth.check.security.pluginNetwork.missing": "O Windows trata algumas redes privadas (uma VPN, uma LAN roteada, os metadados da nuvem em 169.254.169.254) como Internet, então um plugin com acesso à rede poderia alcançá-las sem passar pelo sandbox do sistema. Aplique os intervalos de rede privada uma vez; o Windows pedirá um administrador neste servidor.",
        "siteHealth.check.security.pluginSecrets.title": "Acesso dos plugins a segredos",
        "siteHealth.check.security.pluginSecrets.exposed": "Todos os sandboxes de plugins deste servidor podem ler {count} pasta(s) ou arquivo(s) com segredos por causa das permissões da pasta de instalação, e o WordJS não conseguiu alterá-las. Os plugins não são iniciados até que isso seja corrigido: execute como administrador icacls <caminho> /inheritance:d e depois icacls <caminho> /remove:g *S-1-15-2-1 *S-1-15-2-2 em cada um, ou mova o WordJS para fora de C:\\Program Files.",
        "siteHealth.check.background.pluginFiles.title": "Arquivos de plugins",
        "siteHealth.check.background.pluginFiles.changed": "Os arquivos do plugin {slug} mudaram desde que o WordJS o instalou, então ele não foi iniciado. Atualize ou reinstale-o em Plugins; se você mesmo os alterou, aceite-os.",
        "siteHealth.check.security.pluginPorts.title": "Portas de rede dos plugins",
        "siteHealth.check.security.pluginPorts.unavailable": "Este kernel Linux não consegue limitar a quais portas um plugin com acesso à rede se conecta (isso exige o kernel 6.7 ou posterior), então só o WordJS as limita.",
        "siteHealth.action.applyWindowsNetwork": "Aplicar (administrador)",
        "siteHealth.action.acceptPluginFiles": "Aceitar estes arquivos",
        "siteHealth.check.background.outbox.title": "Eventos de conteúdo",
        "siteHealth.check.background.outbox.dead": "{count} evento(s) de conteúdo não puderam ser entregues (webhooks, busca, cache).",
        "siteHealth.check.background.outbox.ok": "Os webhooks e as atualizações de cache são entregues.",
        "siteHealth.check.background.purge.title": "Cache de páginas",
        "siteHealth.check.background.purge.broken": "As alterações publicadas só chegam aos visitantes quando o cache de páginas expira: as atualizações de cache sob demanda falharam neste processo.",
        "siteHealth.check.background.restart.title": "Reinício automático",
        "siteHealth.check.background.restart.manual": "Nada aqui reinicia o WordJS: depois de mover o banco de dados, restaurar um backup ou trocar de rede, você terá que reiniciá-lo manualmente. Inicie-o com npm start, o monólito, Docker ou systemd.",
        "siteHealth.check.background.restart.ok": "O WordJS reinicia sozinho quando uma alteração exige ({mode}).",
        "siteHealth.fixLabel.updates": "Atualizações",
        "siteHealth.fixLabel.backups": "Backups",
        "siteHealth.fixLabel.mediaStorage": "Armazenamento de mídia",
        "siteHealth.fixLabel.migrateEngine": "Mudar para sqlite-native",
        "siteHealth.fixLabel.accountEmail": "E-mail de contas",
        "siteHealth.fixLabel.certificates": "Certificados",
        "siteHealth.fixLabel.securityServer": "Segurança → Servidor",
        "siteHealth.fixLabel.webhooks": "Webhooks",
    },
});

const GROUPS = ["versions", "storage", "database", "mail", "security", "background"] as const;
const ICON: Record<Status, string> = { ok: "fa-circle-check text-emerald-500", warn: "fa-triangle-exclamation text-amber-500", fail: "fa-circle-xmark text-red-500", info: "fa-circle-info text-gray-400" };

export default function SiteHealthPage() {
    const { t } = useI18n();
    const [report, setReport] = useState<Report | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [acting, setActing] = useState<string | null>(null);

    const run = async () => {
        setRunning(true);
        setError(null);
        try { setReport(await apiGet<Report>("/health/site")); }
        catch (e: any) { setError(e?.message || t("siteHealth.failed")); }
        finally { setRunning(false); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { run(); }, []);

    /** A check's one-click fix, then the report again so the result shows. */
    const act = async (c: Check, key: string) => {
        if (!c.action) return;
        setActing(key);
        setError(null);
        try { await apiPost(c.action.endpoint, c.action.body || {}); }
        catch (e: any) { setError(e?.message || t("siteHealth.failed")); }
        finally { setActing(null); }
        await run();
    };

    /** The check's text in the panel's language when the catalogue has its key, else the backend's English. */
    const tr = (key: string | undefined, fallback: string, vars?: Record<string, string>): string => {
        if (!key) return fallback;
        const s = t(key);
        if (s === key) return fallback;
        return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
    };

    const verdict = !report ? null : report.summary.fail ? "fail" : report.summary.warn ? "warn" : "ok";

    return (
        <div className="p-4 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full">
            <PageHeader title={t("siteHealth.title")} subtitle={t("siteHealth.subtitle")} icon="fa-heart-pulse"
                actions={<Button onClick={run} loading={running} icon="fa-rotate">{t("siteHealth.rerun")}</Button>} />
            <div className="max-w-4xl space-y-6">
                {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
                {verdict && (
                    <Card variant="default" padding="lg">
                        <div className="flex items-center gap-4" data-testid="site-health-verdict" data-verdict={verdict}>
                            <i className={`fa-solid ${ICON[verdict as Status]} text-3xl`} aria-hidden="true"></i>
                            <div>
                                <p className="font-bold text-gray-900">{t(`siteHealth.verdict.${verdict}`)}</p>
                                <p className="text-sm text-gray-500">{t("siteHealth.counts")
                                    .replace("{fail}", plural(t, "siteHealth.count.fail", report!.summary.fail).replace("{n}", String(report!.summary.fail)))
                                    .replace("{warn}", plural(t, "siteHealth.count.warn", report!.summary.warn).replace("{n}", String(report!.summary.warn)))
                                    .replace("{ok}", plural(t, "siteHealth.count.ok", report!.summary.ok).replace("{n}", String(report!.summary.ok)))}</p>
                            </div>
                        </div>
                    </Card>
                )}
                {report && GROUPS.map((g) => {
                    const items = report.checks.filter((c) => c.group === g);
                    if (!items.length) return null;
                    return (
                        <Card key={g} variant="default" padding="lg">
                            <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-2">{t(`siteHealth.group.${g}`)}</h2>
                            <ul className="divide-y divide-gray-100">
                                {items.map((c, i) => (
                                    <li key={`${c.id}-${i}`} data-check={c.id} data-status={c.status} className="flex items-start gap-3 py-4">
                                        <i className={`fa-solid ${ICON[c.status]} mt-0.5`} aria-hidden="true"></i>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-bold text-gray-900">{tr(c.titleKey, c.title, c.vars)}</p>
                                            <p className="text-sm text-gray-600 break-words">{tr(c.messageKey, c.message, c.vars)}</p>
                                            {c.fix && c.status !== "ok" && (
                                                <Link href={c.fix.href} className="mt-1 inline-flex items-center gap-2 text-sm font-bold text-blue-600 underline">
                                                    {t("siteHealth.fix").replace("{where}", tr(c.fix.labelKey, c.fix.label))} <i className="fa-solid fa-arrow-right" aria-hidden="true"></i>
                                                </Link>
                                            )}
                                            {c.action && c.status !== "ok" && (
                                                <div className="mt-2">
                                                    <Button size="sm" onClick={() => act(c, `${c.id}-${i}`)} pending={acting === `${c.id}-${i}`} disabled={acting !== null} data-testid={`site-health-action-${c.id}`}>
                                                        {tr(c.action.labelKey, c.action.label)}
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    );
                })}
                {report && <p className="text-xs text-gray-400">{t("siteHealth.checkedAt").replace("{at}", new Date(report.at).toLocaleString()).replace("{host}", report.host)}</p>}
            </div>
        </div>
    );
}
