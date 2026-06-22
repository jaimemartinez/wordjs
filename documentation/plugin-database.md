# Plugin Database Compatibility Guide

**Los plugins de WordJS usan UNA SOLA sintaxis (SQLite-style) para TODAS las interacciones con la base de datos.** El core se encarga automáticamente de la compatibilidad con diferentes drivers (ver [database.md](./database.md) para el modelo de drivers).

## Acceso a la BD: el bridge `wordjs` (plugins aislados)

Los plugins marcados `"isolated": true` corren **aislados** en un **proceso del SO separado** (`child_process.fork` de `backend/src/core/plugin-worker.js`, orquestado por `backend/src/core/plugin-isolate.ts`) — heap, event loop y tope de memoria propios, así que un crash/OOM/escape de heap queda contenido en el hijo y nunca alcanza al host. NO hacen `require()` de módulos del core. Acceden a la base de datos a través del **capability bridge** `wordjs`, que el host les pasa en `init(wordjs)` por RPC sobre el canal IPC y que verifica permisos y restringe argumentos **en el host** (`backend/src/core/plugin-api.ts`), dentro del contexto del plugin (`plugin-context.ts`):

```javascript
module.exports = {
  async init(wordjs) {
    // Crear una tabla propia (driver-agnóstica)
    await wordjs.db.createTable('my_plugin_data', [
      'id INT_PK',
      'name TEXT NOT NULL',
      'value REAL DEFAULT 0',
      'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ]);

    // Queries (sintaxis SQLite estándar en cualquier driver)
    const rows = await wordjs.db.all('SELECT * FROM my_plugin_data WHERE value > ?', [0]);
    const one  = await wordjs.db.get('SELECT * FROM my_plugin_data WHERE id = ?', [1]);
    const res  = await wordjs.db.run('INSERT INTO my_plugin_data (name, value) VALUES (?, ?)', ['a', 1]);

    // ¿Qué dialecto está activo? (raras veces necesario)
    const { isPostgres } = wordjs.db.getType();
  }
};
```

Métodos del bridge: `wordjs.db.all/get/run`, `wordjs.db.createTable(name, columns)`, `wordjs.db.getType()`, y la propiedad `wordjs.db.tablePrefix` (el prefijo `wjp_<slug>_` de tus tablas). Cada uno exige el permiso correspondiente del manifest (`database:read` / `database:write`).

### Aislamiento de tablas: prefijo por plugin + el core fuera de límites

Cada plugin tiene un **namespace de tablas propio** — el prefijo `wjp_<slug>_` (como `$wpdb->prefix` en WordPress), expuesto en `wordjs.db.tablePrefix` y derivado en `createPluginApi()` (`'wjp_' + slug + '_'`, normalizado a minúsculas/`[A-Za-z0-9]`).

**Todo** plugin está **table-scoped por defecto-deny** — no existe un contraparte "confiable" (la tier *trusted* fue eliminada; `plugin-trust.ts` ya no existe). El host (`assertSqlAllowed` en `plugin-api.ts`) exige que **toda** tabla que la query toque pertenezca al plugin (esté bajo su prefijo), y `assertSqlAllowed(tablePrefix)` se invoca **siempre**, en `db.all/get/run` y `createTable`, sin ninguna ruta de código que levante el scoping. Un token no atribuible o sin prefijo se **rechaza** (fail-closed), no se ignora — así un plugin no puede leer tablas de otro plugin (p.ej. `received_emails` de mail-server) ni del core, incluso una que no esté en la denylist explícita.

| Tipo de plugin                  | Acceso a BD                                                                 |
| :------------------------------ | :------------------------------------------------------------------------- |
| **Cualquier plugin** (sandboxed) | Solo sus propias tablas `wjp_<slug>_*`. SQL que toque cualquier otra tabla (incluidas las del core `users`, `user_meta`, `options`, `roles`, `sessions`) es **denegado**. No hay tier privilegiada que levante este scoping. |

#### Usuarios: vía el bridge `wordjs.users`, nunca la tabla del core

Un plugin **no puede** (ni debe) consultar la tabla `users` del core directamente — `assertSqlAllowed` la rechaza. Para lookups de usuario usa el bridge seguro `wordjs.users` (`findByEmail` / `findByLogin` / `findById` / `search`), que devuelve **solo una proyección** (`id`, `userLogin`/`username`, `userEmail`, `displayName`, `role`) y **nunca** `user_pass`, tokens ni meta. Exige el grant `users:read`. Este es el camino sancionado que reemplazó a un plugin haciendo `SELECT * FROM users` (que filtraba los hashes de contraseña).

Además del default-deny por prefijo, `assertSqlAllowed` rechaza (defensa en profundidad):

- **Verbo no permitido**: la sentencia debe empezar por un verbo del allowlist según el método — `all/get` solo `SELECT`/`WITH`; `run` solo `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/REPLACE`.
- **`ATTACH` / `DETACH` / `PRAGMA`**: montar archivos del host como BD o leer settings/metadatos.
- **Funciones SQL de archivo/extensión/programa**: `readfile`/`writefile`/`load_extension`/`fsdir`/`zipfile`/`sqlite3_*`/`lo_import`/`lo_export`/`pg_read_file`/`pg_read_binary_file`/`pg_ls_dir`/`pg_stat_file`/`dblink`/`dblink_exec` — denegadas textualmente: no llevan `FROM` (esquivan la atribución por prefijo) y abrirían un canal de lectura/escritura de archivos o RCE si se cambia de driver o se habilita una extensión.
- **Catálogos de esquema**: `sqlite_master`/`sqlite_schema`/`information_schema`/`pg_catalog` (enumerar/leer el esquema del core).
- **Sentencias apiladas** (`SELECT 1; DROP TABLE x`) — una sola sentencia por llamada.
- **Comma-joins** (`FROM a, b`): cross-join implícito que cuela una segunda tabla — usa `JOIN` explícito.
- **`USING`** (el `DELETE ... USING <tabla>` de Postgres): se incluye en la atribución por prefijo para que una tabla referida ahí no escape el scoping.
- **`RETURNING`**: canal de exfiltración escalar — denegado; usa un `SELECT` aparte (el `lastID` de inserciones ya está disponible).
- **Tablas del core como denylist explícita** (`PROTECTED_TABLES`: `users`, `user_meta`, `options`, `roles`, `sessions`, …) — redundante con el prefijo, como segunda barrera.
- **DDL de índices** (`CREATE [UNIQUE] INDEX … ON <tabla>` / `DROP INDEX <nombre>`): tanto la tabla destino del `ON` **como el nombre del índice** deben empezar por el prefijo `wjp_<slug>_` del plugin; si no, la query se deniega (el matcher genérico de tablas no ve el destino del `ON` ni el nombre del índice, así que se scopean aparte).

Los comentarios SQL (`/* */` y `--`) se eliminan **antes** de evaluar para que no sirvan de espacio en blanco que evada los chequeos; los delimitadores de identificador (`[corchetes]`, `"comillas"`, `` `backticks` ``) se normalizan para que un nombre entrecomillado no se cuele. `createTable` aplica el mismo principio: un plugin solo puede crear tablas bajo su propio prefijo (no puede crear ni shadowear tablas del core o de otros plugins).

El scoping es **incondicional**: no hay forma de que un plugin lo levante. `verifyPermission('database', …)` solo decide si el plugin **puede** acceder a la BD; `assertSqlAllowed(tablePrefix)` siempre impone el confinamiento por prefijo. Un plugin puede pedir `database:admin` (o cualquier scope) en su manifest cuanto quiera — ninguna ruta de código lee ese `access` para saltarse `assertSqlAllowed`, así que sigue table-scoped a su prefijo igualmente.

Como los plugins ya no pueden leer tablas del core, la info **no secreta** del sitio (`url`/`domain`/`adminEmail`) se obtiene vía el bridge `wordjs.site` (grant `settings:read`). Las opciones secretas o críticas para la seguridad (las que matchean patrones `secret`/`passw…`/`…key…`/`token`/`credential`/`encryption`, más nombres como `wordjs_user_roles`, `active_plugins`, `siteurl`) están bloqueadas para **todo** plugin a través de `wordjs.options` — sin bypass de confianza.

> **Defensa en profundidad (en el hijo):** el proceso aislado también corre `secure-require.ts` (bloquea `worker_threads`/`vm`/`child_process`/módulos de red, `process.binding`, addons nativos) e `io-guard.ts`, que confina el `fs` al **propio dir** del plugin: bloquea escrituras a su código y lecturas de `.env`/secretos; el bloqueo de los **archivos de BD** (`data/wordjs.db` + sidecars) actúa dentro del hijo aislado (`__WORDJS_ISOLATED__`), no en el host (donde el driver del bridge abre legítimamente `data/wordjs.db`), de modo que un plugin no puede leer la BD por fuera del bridge tocando el archivo directamente. Además, `io-guard` **deniega leer el dir de un plugin hermano** — su `package.json`, su `node_modules` o cualquier archivo (solo resuelve el propio árbol del plugin + ancestros compartidos), así que un plugin no puede exfiltrar archivos/secretos de otro plugin ni siquiera fuera de la BD (IO-1).

> **Nota histórica:** `db-migration` ya **no** es un plugin (migraba/tocaba tablas del core y gestionaba procesos del servidor). Ahora es infraestructura del core en `backend/src/core/db-admin/`. Ver [database.md §1.5](./database.md).

## Principio: Sintaxis Única Global

**Todos los plugins escriben SQL usando sintaxis SQLite, y el core normaliza automáticamente para PostgreSQL.**

Esto aplica a:
- ✅ CREATE TABLE
- ✅ SELECT queries
- ✅ INSERT statements
- ✅ UPDATE statements
- ✅ DELETE statements
- ✅ JOINs, subqueries, etc.

### Sintaxis Unificada

Los plugins usan sintaxis SQLite estándar, y el core la traduce automáticamente:

| Tipo Plugin | SQLite                              | PostgreSQL           |
| ----------- | ----------------------------------- | -------------------- |
| `INT_PK`    | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| `INT`       | `INTEGER`                           | `INTEGER`            |
| `TEXT`      | `TEXT`                              | `TEXT`               |
| `REAL`      | `REAL`                              | `REAL`               |
| `DATETIME`  | `DATETIME`                          | `TIMESTAMP`          |
| `TIMESTAMP` | `DATETIME`                          | `TIMESTAMP`          |

### Ejemplo de Uso

Vía el bridge (camino canónico para plugins aislados):

```javascript
async function initSchema(wordjs) {
    await wordjs.db.createTable('my_table', [
        'id INT_PK',
        'name TEXT NOT NULL',
        'email TEXT UNIQUE',
        'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        'balance REAL DEFAULT 0',
        'status INT DEFAULT 0'
    ]);
}
```

> Una `FOREIGN KEY (...) REFERENCES users(id)` apunta a una tabla del core (`users`) — fuera de alcance para cualquier plugin. Referencia solo a tus propias tablas; para datos de usuario usa el bridge `wordjs.users` (proyección).

### Ventajas

1. **Una sola sintaxis global**: Los plugins escriben SQLite-style para TODO
2. **Normalización automática**: el driver de Postgres convierte `?` a `$1, $2` (e inyecta `RETURNING` en INSERTs); el driver WASM legacy quita `RETURNING`. El plugin no nota nada.
3. **Compatibilidad total**: Funciona con SQLite Legacy, SQLite Native y PostgreSQL
4. **Sin cambios al migrar**: Si cambias de driver, el plugin sigue funcionando sin modificaciones
5. **Código más limpio**: No necesitas detectar el driver manualmente
6. **Transparente**: Los plugins no saben qué driver están usando

## Detectar el dialecto: `wordjs.db.getType()`

Si necesitas información sobre el driver activo (para lógica condicional, rara vez necesaria):

```javascript
const { isPostgres, isSQLite, driver } = wordjs.db.getType();

if (isPostgres) {
    // Lógica específica para PostgreSQL (raro, pero posible)
}
```

## Migraciones

Para migraciones que verifican si una columna existe, ramifica sobre el dialecto:

```javascript
async function migrate(wordjs) {
    const { isPostgres } = wordjs.db.getType();

    if (isPostgres) {
        const result = await wordjs.db.get(
            `SELECT COUNT(*) as count FROM information_schema.columns
             WHERE table_name = ? AND column_name = ?`,
            ['my_plugin_data', 'new_col']
        );
        return result.count > 0;
    } else {
        const result = await wordjs.db.all(`PRAGMA table_info(my_plugin_data)`);
        return result.some(col => col.name === 'new_col');
    }
}
```

## Ejemplos Completos

### Plugin Completo con Tablas y Queries

```javascript
module.exports = {
  async init(wordjs) {
    // Crear tabla con sintaxis unificada
    await wordjs.db.createTable('my_plugin_data', [
      'id INT_PK',
      'name TEXT NOT NULL',
      'value REAL DEFAULT 0',
      'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ]);

    // Exponer helpers que usan el bridge
    this.getData = (id) =>
      wordjs.db.get('SELECT * FROM my_plugin_data WHERE id = ?', [id]);

    // Query con LIMIT/OFFSET - funciona igual en todos los drivers
    this.getAllData = (limit = 10, offset = 0) =>
      wordjs.db.all(
        'SELECT * FROM my_plugin_data ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [limit, offset]
      );

    // INSERT - run() devuelve { lastID, changes } en todos los drivers
    this.createData = async (name, value) => {
      const res = await wordjs.db.run(
        'INSERT INTO my_plugin_data (name, value) VALUES (?, ?)',
        [name, value]
      );
      return res.lastID;
    };

    this.updateData = (id, name, value) =>
      wordjs.db.run('UPDATE my_plugin_data SET name = ?, value = ? WHERE id = ?', [name, value, id]);

    this.deleteData = (id) =>
      wordjs.db.run('DELETE FROM my_plugin_data WHERE id = ?', [id]);
  }
};
```

> **API in-process (avanzado / core):** el bridge se apoya en helpers de `backend/src/config/database.ts` (`dbAsync`, `createPluginTable`, `getDbType`). Código del **core** (modelos, `db-admin`) los importa directamente; los plugins aislados **no** — pasan siempre por `wordjs.db.*`.

## Plugins Actualizados

- ✅ `card-gallery` - Usa el bridge `wordjs.db` y queries estándar
- ✅ `video-gallery` - Usa el bridge `wordjs.db` y queries estándar
- ✅ `mail-server` - Plugin **totalmente untrusted** (sandboxed): declara solo `database:read` + `database:write` y guarda **todos** sus datos — incluidas claves DKIM y secretos SMTP del relay — en sus propias tablas `wjp_mail_server_*` (`_received_emails` / `_email_attachments` / `_secrets`), precisamente porque `assertSqlAllowed` deniega cualquier tabla fuera de su prefijo
- ✅ Todos los plugins existentes - Sintaxis SQLite estándar; todos table-scoped a su propio prefijo (sin acceso a tablas del core)
