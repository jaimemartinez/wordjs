# Auditoría completa de WordJS en Proxmox LXC

Fecha: 2026-08-01 America/Bogota (2026-08-02 UTC)

## Resumen ejecutivo

WordJS quedó instalado y operativo en el laboratorio Proxmox que corre dentro de VMware. La instancia responde por HTTP, como se solicitó exclusivamente para el lab, y queda en estado `ready` con SQLite.

El aislamiento de kernel sí funciona en este host cuando el proceso logra arrancar: Bubblewrap, namespaces, raíz de solo lectura, usuario sin privilegios, seccomp y cgroup v2 fueron verificados sobre procesos reales. Sin embargo, el código auditado todavía no está listo para considerarse una frontera segura frente a plugins hostiles. Se confirmaron cuatro defectos principales con pruebas ejecutables o integración en vivo:

1. Un bundle frontend no declarado puede ejecutarse en el origen privilegiado de WordJS.
2. Un plugin aislado con cero permisos puede observar hooks globales y publicar una ruta sin autenticación.
3. Restore incluye un snapshot SQLite físico en el ZIP, pero no lo restaura.
4. El probe de cgroup puede aprobar mientras el lanzamiento real falla porque usa un entorno diferente.

También se observó un proceso Bubblewrap huérfano en una ruta de fallo, una política de allowlist de egress que falla abierta y deuda de dependencias/lint.

La corrección del bus/cgroup se aplicó **solo dentro del LXC** para terminar las pruebas. El árbol local del usuario no fue modificado por esa corrección.

## Estado de remediación (2026-08-03, código WordJS)

Se corrigieron los hallazgos que atañen al **código de WordJS**; los de infraestructura del laboratorio (F-08 credencial en artefacto OneDrive, F-10 host/LXC) quedan **fuera de alcance** por decisión del usuario. Verificación: backend `tsc` limpio · suite backend 577 pass / 0 fail / 7 skipped (584) · build frontend OK · tests gateway 4/4 · `npm audit` root y gateway **0 vulnerabilidades**.

| # | Estado | Corrección |
|---|---|---|
| F-01 | Informativo (no es vuln) | Verificado en el código actual: el frontend nunca estuvo aislado y los bundles solo cargan para plugins **activos** (admin-gated); declarar o no en el manifest da acceso idéntico, así que la declaración no es una frontera de autorización. No se cambia el serving (el "fix" propuesto haría 404 a plugins activos cuyo `dist/` y manifest divergen). Path traversal ya cerrado por slug-regex + `safeJoin` + allow-list de tipos. |
| F-02 | Corregido (capa-1) | `core/options.ts`: `updateOption` **redacta el VALOR** de opciones con nombre-secreto en el hook `updated_option` (`SECRET_OPTION_NAME_RE`); el valor almacenado queda intacto y el único listener core (cron/`backup_*`) no se afecta. Capa-2 (grant `http:public` para rutas sin auth) **diferida**: requiere auditar/otorgar a los plugins bundled con rutas públicas (mail-server, online-store) para no romperlos. Test: `audit-2026-08-remediation.test.ts`. |
| F-03 | Corregido | `core/backup.ts` `restoreBackup`: restaura el snapshot **físico** `database/wordjs.db` para SQLite (close → borra WAL/SHM → swap atómico → reopen) con fallback al import lógico; el path lógico ahora hace `clearDatabase()` también en SQLite, así las filas borradas tras el backup se propagan (defecto #1). Mecanismo close→swap→reopen validado por round-trip. |
| F-04 | Corregido | `core/plugin-isolate.ts`: el cliente `systemd-run --user` recibe `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` (conecta al bus) y `env -u …` los **quita dentro del scope** (el proceso plugin conserva exactamente `workerEnv`). Probe y launch comparten la forma de comando (parity #192). |
| F-05 | Corregido (mitigación) | `core/plugin-isolate.ts` `terminate()`: en la ruta hardened-sin-cgroup **enumera el subárbol `/proc` ANTES** de matar el bwrap externo y hace sweeps cortos — cierra la ventana de huérfano por reparent (la ruta cgroup ya lo cubría del todo). Linux-only y guardado: Windows/cgroup/fork quedan byte-idénticos. |
| F-06 | Corregido | Egress **falla-CERRADO**: `plugin-permissions` distingue política *cargada* vs *no-disponible* (`isEgressPolicyLoaded`); si no cargó, el spawn señala deny-all y `egress-guard.setDenyAllEgress()` bloquea todo host público (privados/loopback ya bloqueados). "Sin política configurada" sigue siendo allow-all (sin regresión). Test incluido. |
| F-07 | Corregido (parcial) | `npm audit fix` (no-mayor) parchó **sanitize-html** (`javascript:` URI), **postcss** (path-traversal), brace-expansion, shell-quote, body-parser, concurrently. uuid → 11.1.1 en root/gateway (**0 vulns**; WordJS usa solo `v4` sin `buf`, no era explotable). **Diferidos** (bump mayor ESM-only, requieren testing dedicado): `file-type`→22 (backend, DoS moderado en upload) y uuid transitivo del frontend. |
| F-09 | Corregido | `next.config.ts`: `poweredByHeader:false` (elimina `X-Powered-By: Next.js`, que el gateway proxyaba) + cabecera `Permissions-Policy`. `TRACE`/`TRACK` → **405** en gateway y monolito. El CSP `unsafe-inline`/`unsafe-eval` se **mantiene** (intencional y documentado: `blob:` para bundles de plugin, `eval` para Puck; el sanitizer server-side es la defensa XSS). favicon 404: cosmético, no de seguridad. |
| F-08, F-10 | Fuera de alcance (lab) | Credencial en artefacto OneDrive / firewall-keyctl-thinpool-kernel del host — infra, no código WordJS. |

## Alcance y entorno

| Componente | Estado auditado |
|---|---|
| Host | Proxmox VE 9.2.2, kernel 7.0.2-6-pve, dentro de VMware Workstation |
| Contenedor | CT 216, `wjs-sandbox-audit`, Debian 12, no privilegiado |
| Red del lab | `192.168.182.149:3000`, HTTP aceptado para este entorno |
| Recursos | 3 vCPU, 4096 MiB RAM, 1024 MiB swap, rootfs 12 GiB |
| LXC | `unprivileged=1`, `nesting=1`, `keyctl=1` |
| Runtime | Node 22.23.2, npm 10.9.8, Bubblewrap 0.8.0 |
| Aplicación | WordJS 1.12.11, monolito, SQLite native |
| Servicio | systemd de usuario `wordjs.service`, habilitado y activo |
| Credenciales | Administrador `qaadmin`; contraseña aleatoria guardada solo dentro del CT en `/root/wordjs-lab-admin-password` con modo 0600 |

Se transfirió el árbol de trabajo actual, incluidas las modificaciones no confirmadas del usuario, excluyendo secretos, datos, certificados, caches y `node_modules`. El archivo transferido fue idéntico en Windows, Proxmox y el LXC:

```text
SHA-256 5e808fecc69d453cfcd515d346879cfa666a99049003949049342af6969b2e9c
1124 archivos
```

El tar oficial de Node quedó verificado antes de instalarlo:

```text
SHA-256 d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
```

## Evidencia de pruebas

| Prueba | Resultado |
|---|---|
| Build backend TypeScript | Aprobado |
| Build monolito + Next.js producción | Aprobado |
| Typecheck backend | Aprobado |
| Suite backend completa | 573 total: 566 aprobadas, 7 omitidas, 0 fallidas |
| Suite frontend completa | 51/51 aprobadas |
| Suite gateway | 4/4 aprobadas |
| Verificador de hardening | 11/11 aprobadas |
| Pruebas dirigidas backend | 17/17 aprobadas |
| Pruebas dirigidas frontend/bundles | 41/41 aprobadas |
| Plugin sintético en ejecución | Activación, hook, ruta, bundle, reinicio y cgroup comprobados |
| Backup/restore destructivo | Ejecutado bajo snapshot temporal de Proxmox; defecto reproducido y datos de prueba limpiados |
| HTTP externo | Health, readiness, setup, portada, login, admin y 20/20 assets aprobados |
| Auditoría npm producción | 5 lockfiles; 0 críticas, 4 altas, 5 moderadas, 2 bajas |
| Lint backend | Falló: 59 errores y 120 warnings |
| Lint frontend | Aprobó con 157 warnings y 0 errores |

Las tres pruebas de caracterización agregadas vivieron solo en el LXC:

```text
/opt/wordjs/backend/src/tests/audit-zero-permission-capabilities.test.ts
/opt/wordjs/backend/src/tests/audit-egress-policy-fail-open.test.ts
/opt/wordjs/frontend/src/lib/__tests__/audit-plugin-bundle-boundary.test.ts
```

## Hallazgos

### F-01 — Crítico — Bundle frontend no declarado cruza la frontera del sandbox

El runtime enumera todos los plugins activos, pide `?type=hooks`, convierte la respuesta en un módulo `blob:` y ejecuta cada export `register*`. El endpoint sirve cualquier `dist/hooks.bundle.js` que exista, sin exigir que `manifest.frontend.hooks` lo declare. Además, el loader entrega módulos privilegiados del host como `lib/api` y `contexts/AuthContext` al código del bundle.

Evidencia de código:

- `backend/src/routes/plugin-bundles.ts`: el endpoint valida slug y tipo, pero no la declaración del manifest antes de servir el archivo.
- `frontend/src/lib/pluginBundleLoader.ts`: `fetchAndRegisterPluginHooks()` importa y ejecuta el bundle de cada plugin activo.
- `frontend/src/lib/pluginBundleLoader.ts`: `HOST_MODULES` expone API, contexto de autenticación y otros singletons del host.

Prueba en vivo:

- Manifest con `permissions: []` y sin propiedad `frontend`.
- `GET /api/v1/plugins/audit-live-sandbox/bundle?type=hooks` respondió 200.
- La prueba frontend confirmó que el código se evalúa en el realm del host y accede a los módulos inyectados.
- Tras la auditoría, el plugin sintético fue desactivado y eliminado; ruta, bundle, directorio y scope quedaron ausentes.

Impacto: un plugin que parece exclusivamente backend/aislado puede ejecutar JavaScript same-origin en la sesión del administrador o de usuarios, invocar APIs con sus credenciales y saltarse la separación del proceso backend.

Remediación:

1. Servir y cargar bundles únicamente cuando el manifest activo declara exactamente el entry correspondiente.
2. Vincular el bundle a un hash calculado/validado durante la instalación.
3. No exponer `AuthContext` ni una API genérica al bundle; usar una fachada de capacidades frontend.
4. Considerar iframe/origen separado con `sandbox` para UI de terceros.

### F-02 — Alto — Cero permisos todavía permite observar hooks y exfiltrar por una ruta pública

Las llamadas normales del bridge sí ejecutan `verifyPermission`, pero los mensajes IPC de registro de hooks y rutas no exigen un grant equivalente. `register` conecta el callback al hook real y `register-route` solo añade autenticación cuando el propio plugin lo solicita.

Prueba en vivo:

- Plugin aislado con `permissions: []`.
- Se suscribió a `updated_option`.
- Registró una ruta GET sin autenticación.
- La ruta observó primero el cambio de `active_plugins` y después el marcador seguro enviado a `blogdescription`.
- El marcador fue restaurado y el plugin de prueba eliminado.

Impacto: un plugin sin permisos puede observar valores enviados por hooks globales y publicarlos por una ruta de entrada. Si un hook transporta un secreto o dato privado, el modelo default-deny deja de ser efectivo aunque el plugin no tenga `network`.

Remediación:

1. Crear permisos explícitos para hooks y rutas (`hooks:read`, `http:public`, `http:authenticated`, etc.).
2. Mantener una allowlist de hooks seguros; denegar por defecto hooks con valores sensibles.
3. Hacer que las rutas sean autenticadas por defecto y exigir un grant separado para hacerlas públicas.

### F-03 — Alto — Restore ignora el snapshot físico de SQLite

`createBackup()` hace checkpoint del WAL y agrega `database/wordjs.db`. `restoreBackup()` solo extrae `uploads/`, `plugins/` y `themes/`, omite `database/wordjs.db` y luego ejecuta un import lógico. Para SQLite tampoco limpia primero la base.

Prueba destructiva controlada:

1. Se creó un snapshot temporal del CT en Proxmox.
2. Un setting exportable quedó en estado `before`.
3. Una fila de `notifications`, excluida del JSON lógico, quedó en estado `PHYSICAL_BEFORE`.
4. El ZIP contenía una sola copia de `wordjs-content.json` y `database/wordjs.db`.
5. La fila no aparecía en el JSON y sí aparecía como `PHYSICAL_BEFORE` en la DB física del ZIP.
6. Ambos valores se cambiaron a `after` y se restauró el ZIP.
7. El setting volvió a `before`, demostrando que el import lógico sí corrió.
8. La fila quedó en `PHYSICAL_AFTER`, demostrando que el snapshot físico fue ignorado.

La API devolvió HTTP 200, `success: true`, `errors: []`, y readiness siguió en 200. Luego se revirtieron el setting y la fila, se borró el backup de prueba y se eliminó el snapshot temporal.

Remediación: para SQLite, restaurar atómicamente la DB física con el servicio detenido y validación previa, o dejar de prometerla como parte del backup. La operación debe incluir rollback y comprobación de integridad antes de reiniciar.

### F-04 — Alto — El probe de cgroup no replica el entorno del lanzamiento real

El probe de `systemd-run --user` hereda el entorno completo del servicio. El lanzamiento real reemplaza `env` con `workerEnv`, una allowlist que elimina `XDG_RUNTIME_DIR` y `DBUS_SESSION_BUS_ADDRESS`. En el LXC, el probe anunció cgroups activos, pero el tema y el plugin real fallaron con `Failed to connect to bus: No medium found`.

La corrección candidata aplicada solo en el LXC:

- Entregar las variables de bus únicamente al cliente `systemd-run`.
- Anteponer `env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS` al comando dentro del scope.
- Mantener las variables fuera del proceso plugin.

Después de recompilar y reiniciar, el tema y el plugin cargaron y se verificó que el entorno del plugin no contenía esas variables.

Remediación: llevar la corrección al repositorio y agregar una prueba sobre systemd real que compare el entorno del probe con el del lanzamiento. El probe debe probar el mismo `env` y argv exactos que se usan en producción.

### F-05 — Medio — Un fallo de inicio dejó un Bubblewrap huérfano

Después de la suite apareció el PID 5993, `test-isolate-failing-init`, con PPID 1. No tenía hijos, seguía bloqueado en un eventfd y estaba fuera de un scope `wjp-*`; por tanto solo heredaba el límite exterior de 4 GiB del CT. La ruta más probable es el test `an unload that lands MID-LOAD…` de `backend/src/tests/plugin-isolate-failed-load.test.ts`: mata inmediatamente el PID directo, `livePids` lo olvida al recibir `exit`, y `pidsGone()` solo consulta ese registro. Un Bubblewrap todavía en bootstrap puede ser reparentado antes de instalar `PR_SET_PDEATHSIG`, que no es retroactivo. La prueba queda verde porque no busca descendientes/wrappers reparentados en `/proc`.

El proceso se comprobó por comando exacto antes de terminarlo y ya no existe.

Remediación: matar y esperar el árbol/cgroup completo en cada rama `failLoad`, no solo el PID manejado; añadir una aserción posterior que busque procesos por cgroup o identidad del fixture tras finalizar la prueba.

### F-06 — Medio — La allowlist de egress falla abierta al no poder cargar la política

`loadEgressHosts()` registra el error y continúa. Una lista vacía o ausente significa `allow-all-public`; `getEgressAllowlistFor()` también devuelve `[]` ante cualquier excepción. El plugin aún necesita el grant `network` y las IP privadas/loopback siguen bloqueadas, pero un fallo de DB/política amplía silenciosamente el acceso desde hosts permitidos a cualquier host público.

La prueba dirigida simuló el fallo y confirmó el comportamiento allow-all.

Remediación: distinguir `sin política configurada` de `política no disponible`. Si existía o se requiere una allowlist y no puede cargarse, denegar egress o negar el arranque del plugin.

### F-07 — Alto — Dependencias de producción con advisories abiertos

`npm audit --omit=dev --json` se ejecutó en los cinco lockfiles. Ningún lockfile cambió.

| Workspace | Críticas | Altas | Moderadas | Bajas | Principales |
|---|---:|---:|---:|---:|---|
| root | 0 | 2 | 1 | 1 | `shell-quote`, `uuid`, `body-parser` |
| backend | 0 | 2 | 2 | 0 | `brace-expansion`, `postcss`, `file-type`, `sanitize-html` |
| frontend | 0 | 0 | 1 | 0 | `uuid` |
| gateway | 0 | 0 | 1 | 1 | `uuid`, `body-parser` |
| setup | 0 | 0 | 0 | 0 | limpio |

El agregado por lockfile es 0 críticas, 4 altas, 5 moderadas y 2 bajas; existen duplicados entre workspaces. Varias correcciones sugeridas implican salto de versión mayor, por lo que deben probarse y no aplicarse automáticamente.

### F-08 — Alto — Credencial histórica en texto plano

Durante el inventario se detectó un artefacto histórico de OneDrive que contenía una contraseña de Proxmox en texto plano. El valor no se copió ni se incluye en este informe.

Remediación inmediata: rotar la contraseña de `root` de Proxmox, revisar sesiones/claves autorizadas y eliminar o cifrar el artefacto histórico y sus copias/versiones.

### F-09 — Bajo/medio — Hardening web y calidad

- `TRACE /` respondió 200 con HTML. No reflejó el header/body sintético, por lo que no se observó XST clásico, pero conviene responder 405.
- CSP permite `unsafe-inline` y `unsafe-eval`; esto debilita la defensa frente a XSS y facilita el modelo de bundles dinámicos.
- Se expone `X-Powered-By: Next.js` y falta `Permissions-Policy`.
- `/favicon.ico` responde 404.
- Lint backend falla con 59 errores; frontend termina con 157 warnings.

HTTP en el lab no se considera defecto: el usuario confirmó que producción opera con HTTPS. HSTS está presente, pero naturalmente no protege una conexión HTTP de laboratorio.

### F-10 — Operacional — Riesgos del host/LXC de laboratorio

- Firewall de Proxmox deshabilitado y egress del CT sin restricción.
- `keyctl=1` parece innecesario para Bubblewrap y aumenta superficie.
- El thinpool estaba aproximadamente al 74% y está sobreaprovisionado.
- LXC y Bubblewrap comparten el kernel de Proxmox; una vulnerabilidad del kernel sigue siendo una vía de escape.
- El proceso principal depende del límite exterior de 4 GiB del CT; los workers sí tienen cgroup propio.
- Bubblewrap deja escribibles `uploads`, `data`, `logs`, `os-tmp` y `themes`; la separación fina de esas zonas depende además de los guards JS.

## Controles comprobados en procesos reales

Para plugin y tema se observaron scopes `wjp-*.scope` activos con:

```text
memory.max        805306368       # 768 MiB
memory.swap.max   0
pids.max          512
cpu.max           100000 100000   # 100% de un núcleo
```

Dentro del sandbox efectivo:

```text
UID/GID interno   65534
CapEff/CapBnd     0
NoNewPrivs        1
Seccomp           modo filtro, 2 filtros apilados
Namespaces        user, pid, mount, net, cgroup, UTS e IPC separados
Filesystem raíz  ro,nosuid,nodev
Red               solo loopback, tabla de rutas vacía
Variables DBus    ausentes en el proceso plugin
```

También se comprobó:

- `requireHardening=true` y red sin grant usando `--unshare-net`.
- Config, DB y contraseña administrativa en modo 0600.
- Instalación sin `Origin` rechazada con 403; con origen same-origin aceptada.
- CORS no entrega `Access-Control-Allow-Origin` a `http://evil.example`.
- `/healthz` y `/readyz` correctos después de reinicios y restore.
- Portada y los 20 assets referenciados responden 200 desde Windows.
- El plugin sintético, sus marcadores y todos los temporales de restore fueron retirados.

## Limitaciones explícitas

No se probó todo escenario posible. Quedaron fuera:

- TLS/HTTPS de producción, certificados, proxy inverso y renovación; el lab fue HTTP por decisión explícita.
- PostgreSQL y MySQL reales; sus tests de integración fueron omitidos por no haber motores configurados.
- Windows Job Objects, porque la ejecución real fue Linux/LXC.
- OOM/fork-bomb destructivos contra el lab compartido; se verificaron propiedades de cgroup, no se agotaron recursos a propósito.
- QA visual, consola y árbol accesible en un navegador real; no había un navegador conectado. El HTML sí fue inspeccionado y contiene landmarks, skip link y atributos ARIA razonables.
- Pentest remoto desde una red externa o revisión de la terminación TLS de producción.

## Estado de entrega

- CT 216 sigue `running`.
- WordJS queda instalado, habilitado y `ready` en `http://192.168.182.149:3000`.
- El servicio no conserva el plugin sintético de auditoría.
- No quedan snapshots temporales de la prueba ni marcadores `restore-audit`.
- El árbol local mantiene intactas las modificaciones previas del usuario; solo se añadió este informe.
