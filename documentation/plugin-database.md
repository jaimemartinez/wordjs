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

Métodos del bridge: `wordjs.db.all/get/run`, `wordjs.db.batch(statements)`, `wordjs.db.createTable(name, columns)`, `wordjs.db.getType()`, más la propiedad `wordjs.db.tablePrefix` (el prefijo `wjp_<slug>_` de tus tablas). Cada **método** exige el permiso correspondiente del manifest (`database:read` / `database:write`); `tablePrefix` es una propiedad estática (no exige grant para leerla).

`db.batch(statements)` corre **varias sentencias en un solo round-trip** al host: un array **no vacío** de pares `[sql, params]`, **máximo 200**. Es puramente una optimización de transporte — cada sentencia pasa por el **mismo** `verifyPermission` y el **mismo** `assertSqlAllowed` que su equivalente suelta (`select`/`with` como lectura, `insert`/`update`/`delete`/`replace` como escritura), y **todo el lote se valida antes** de ejecutar nada, así que una sentencia ilegal en medio no deja aplicadas las legales que la preceden. **No acepta DDL** (`CREATE`/`ALTER`/`DROP` → usa `db.run` o `db.createTable`, que son los que registran la propiedad de la tabla). **No es atómico**: si una sentencia falla, las anteriores ya se aplicaron.

### Aislamiento de tablas: prefijo por plugin + el core fuera de límites

Cada plugin tiene un **namespace de tablas propio** — el prefijo `wjp_<slug>_` (como `$wpdb->prefix` en WordPress), expuesto en `wordjs.db.tablePrefix` y derivado en `createPluginApi()` (`'wjp_' + slug + '_'`, normalizado a minúsculas/`[A-Za-z0-9]`).

**Todo** plugin está **table-scoped por defecto-deny** — no existe un contraparte "confiable" (la tier *trusted* fue eliminada; `plugin-trust.ts` ya no existe). El host (`assertSqlAllowed` en `plugin-api.ts`) exige que **toda** tabla que la query toque pertenezca al plugin (esté bajo su prefijo), y `assertSqlAllowed(tablePrefix)` se invoca **siempre** en `db.all/get/run` (y por sentencia en `db.batch`), sin ninguna ruta de código que levante el scoping. `createTable` no pasa por `assertSqlAllowed`, pero impone el mismo confinamiento por prefijo con un chequeo directo del nombre de la tabla (debe empezar por `tablePrefix`) y delega en `createPluginTable`, que valida el identificador y rechaza sentencias apiladas. Un token no atribuible o sin prefijo se **rechaza** (fail-closed), no se ignora — así un plugin no puede leer tablas de otro plugin (p.ej. `received_emails` de mail-server) ni del core, incluso una que no esté en la denylist explícita.

**Por debajo del guard de texto hay una segunda capa: la propia base de datos** (`backend/src/core/plugin-db-isolation.ts`). Las lecturas y el DML de cada plugin corren bajo un **principal de BD propio** con permisos solo sobre su prefijo — un `ROLE` `NOLOGIN` por plugin en Postgres (vía `SET ROLE` sobre un cliente fijado) y un usuario de login por plugin en MySQL/MariaDB (contraseña generada en cada arranque y solo en memoria) —, de modo que el motor deniega el acceso cruzado **aunque `assertSqlAllowed` fuese esquivado**. Degrada con elegancia: bajo SQLite, o si el usuario del pool no puede aprovisionar el principal, no se provisiona nada y queda solo el guard de texto. El **DDL** siempre corre como el usuario admin (un principal restringido no tiene `CREATE`), scopeado al prefijo por el guard de texto, y cada tabla nueva se le concede al principal después.

| Tipo de plugin                  | Acceso a BD                                                                 |
| :------------------------------ | :------------------------------------------------------------------------- |
| **Cualquier plugin** (sandboxed) | Solo sus propias tablas `wjp_<slug>_*`. SQL que toque cualquier otra tabla (incluidas las del core `users`, `user_meta`, `options`, `roles`, `sessions`) es **denegado**. No hay tier privilegiada que levante este scoping. |

#### Usuarios: vía el bridge `wordjs.users`, nunca la tabla del core

Un plugin **no puede** (ni debe) consultar la tabla `users` del core directamente — `assertSqlAllowed` la rechaza. Para lookups de usuario usa el bridge seguro `wordjs.users` (`findByEmail` / `findByLogin` / `findById` / `search`), que devuelve **solo una proyección** (`id`, `userLogin`/`username`, `userEmail`, `displayName`, `role`, más el booleano `hasProfessionalMailbox`, derivado del grant `user_meta.professional_mailbox` y fail-closed a `false`) y **nunca** `user_pass`, tokens ni el resto del meta. Exige el grant `users:read`. Este es el camino sancionado que reemplazó a un plugin haciendo `SELECT * FROM users` (que filtraba los hashes de contraseña).

Además del default-deny por prefijo, `assertSqlAllowed` rechaza (defensa en profundidad):

- **SQL demasiado largo**: la cadena **cruda** se corta en **20 000 caracteres** — el chequeo va **antes** que nada (ni siquiera el lexer corre sobre una cadena ilimitada), porque el guard corre en el proceso **host** y una entrada sin tope es un DoS del event loop.
- **Caracteres que hacen divergir el lexado entre motores** — denegados en la cadena cruda, estructuralmente, en vez de intentar reconciliar semánticas por driver:
  - **`/*! … */`** (comentarios ejecutables de MySQL/MariaDB, con o sin versión: `/*!50000 … */`).
  - **`\` (barra invertida)**: MySQL la trata como escape de comilla y SQLite/Postgres no, así que un `'\''` empareja las comillas distinto en el guard que en el motor. Los datos literales van siempre por parámetros ligados (`?`).
  - **`$`**: cierra la clase entera del dollar-quoting de Postgres (`$$ … $$`, `$tag$ … $tag$`, incluidas etiquetas no-ASCII). El guard corre sobre SQL con `?`, antes de la traducción a `$N`, así que un `$` nunca es legítimo.
  - **`[` / `]`**: en Postgres son subíndice de array cuyo índice es una **expresión completa** (p.ej. una subquery escalar), no un identificador entrecomillado. Para citar un identificador usa `"…"`.
- **`ATTACH` / `DETACH` / `PRAGMA` / `VACUUM`**: montar archivos del host como BD, leer settings/metadatos, o (`VACUUM INTO '<archivo>'`) escribir una copia entera de la BD en una ruta elegida por el plugin.
- **Catálogos de esquema**: `sqlite_master`/`sqlite_schema`/`sqlite_temp_master`/`sqlite_temp_schema`/`information_schema`/`pg_catalog` (enumerar/leer el esquema del core).
- **Funciones SQL de archivo/extensión/programa**: `readfile`/`writefile`/`load_extension`/`fsdir`/`zipfile`/`sqlite3_*`/`lo_import`/`lo_export`/`pg_read_file`/`pg_read_binary_file`/`pg_ls_dir`/`pg_stat_file`/`dblink`/`dblink_exec` — denegadas textualmente: no llevan `FROM` (esquivan la atribución por prefijo) y abrirían un canal de lectura/escritura de archivos o RCE si se cambia de driver o se habilita una extensión.
- **Familia `*_to_xml` de Postgres** (`query_to_xml`, `query_to_xmlschema`, `query_to_xml_and_xmlschema`, y las variantes `table_`/`schema_`/`database_`/`cursor_`): toman una **query como argumento de tipo string** y la ejecutan. Eso rompe la premisa que sostiene todo el guard — el lexer blanquea los literales precisamente para que su contenido nunca se lea como estructura —, así que `SELECT query_to_xml('select user_pass from users', …)` no produce **ningún** token de tabla y tanto el allowlist por prefijo como la denylist del core pasarían **en vacío**. Denegadas textualmente en todos los drivers.
- **Sentencias apiladas** (`SELECT 1; DROP TABLE x`) — una sola sentencia por llamada (se tolera un único `;` final).
- **Verbo no permitido**: la sentencia debe empezar por un verbo del allowlist según el método — `all/get` solo `SELECT`/`WITH`; `run` solo `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/REPLACE`; `batch` clasifica cada sentencia y usa `SELECT`/`WITH` para lecturas y `INSERT/UPDATE/DELETE/REPLACE` para escrituras (sin DDL).
- **CTE que modifica datos**: `WITH t AS (INSERT INTO … ) SELECT 1` empieza por `with`, que está en la lista de verbos de **lectura** — pero en Postgres el CTE se ejecuta entero lea o no su salida la query externa. Un `WITH` que contenga `insert`/`update`/`delete`/`replace`/`merge` en la rama de lectura se rechaza: **es una escritura y exige `database:write`**.
- **Comma-joins** (`FROM a, b`, incluidos los escondidos tras una subquery, un `JOIN … ON` o dentro de paréntesis) — **no** se deniegan como construcción: el walker de tokens los reconoce y **atribuye cada tabla de la lista**, así que las dos (o las N) tienen que llevar tu prefijo `wjp_<slug>_`. La que no lo lleve se rechaza como "not owned".
- **`USING`** (el `DELETE ... USING <tabla>` de Postgres) y el `STRAIGHT_JOIN` de MySQL: se incluyen en la atribución por prefijo para que una tabla referida ahí no escape el scoping.
- **`RETURNING`**: canal de exfiltración escalar — denegado; usa un `SELECT` aparte (el `lastID` de inserciones ya está disponible).
- **`ON CONFLICT ... DO UPDATE SET` (upsert) — permitido, no denegado**: el token-walker trata `SET` como frontera de cláusula (está en el conjunto `ENDERS`), así que el destino del `SET` no se lee como tabla. Tanto `DO NOTHING` como `DO UPDATE` pasan, siempre que **toda** tabla que la sentencia referencie (incluidas las de subqueries) use el prefijo `wjp_<slug>_` del plugin. (`RETURNING` sigue denegado; el patrón **UPDATE-then-INSERT** sigue siendo una alternativa válida pero ya **no** es necesario.)
- **Tablas del core como denylist explícita** (`PROTECTED_TABLES`: `users`, `user_meta`, `usermeta`, `options`, `user_roles`, `roles`, `sessions`) — redundante con el prefijo, como segunda barrera. El match se ancla a una palabra clave que **introduce** una tabla (`from`/`join`/`into`/`update`/`using`/`table`), para que una **columna** tuya llamada `options` o `status` no sea un falso positivo.
- **Clase de objeto en DDL (allowlist positiva)**: si la sentencia empieza por `CREATE`/`ALTER`/`DROP`, su objeto solo puede ser **`TABLE`, `INDEX`, `VIEW` o `TRIGGER`** (admitiendo `OR REPLACE`, `TEMP`/`TEMPORARY` y `UNIQUE`). Cualquier otra clase — `SCHEMA`, `DATABASE`, `ROLE`, `FUNCTION`, `EXTENSION`, `SYSTEM`… — se deniega: esas sentencias **no nombran ninguna tabla**, así que el walker no emitía ningún token y la regla por prefijo pasaba **en vacío** (`DROP SCHEMA public CASCADE`, `CREATE ROLE … SUPERUSER` o una función `SECURITY DEFINER` cuyo cuerpo es un literal — invisible al guard por diseño — quedaban permitidas). Nunca se infiere seguridad de la **ausencia** de tokens: solo se admiten las clases que el guard sabe scopear.
- **`ALTER … RENAME TO <destino>`**: el destino también tiene que llevar tu prefijo. El token **previo** al rename sí lo lleva (el walker lo acepta) y no dice nada de dónde aterriza: `ALTER TABLE wjp_x_notes RENAME TO users` shadowearía una tabla del core.
- **Tabla de otro plugin aunque el prefijo encaje**: además del `startsWith(tablePrefix)`, el guard consulta el **registro autoritativo de creador** (`TABLE_CREATORS`, persistido en `data/wjp-prefix-registry.json`) — si la tabla tiene creador grabado, solo ese slug puede tocarla — y la **coincidencia de prefijo más larga** entre todos los prefijos reclamados: si un plugin hermano con prefijo más largo es el dueño, se deniega aunque el tuyo también encaje (defensa contra el squat por extensión de prefijo, p.ej. slug `events-ticket` sobre las tablas de `events`).
- **DDL de índices** (`CREATE [UNIQUE] INDEX … ON <tabla>` / `DROP INDEX <nombre>`): tanto la tabla destino del `ON` **como el nombre del índice** deben empezar por el prefijo `wjp_<slug>_` del plugin; si no, la query se deniega (el matcher genérico de tablas no ve el destino del `ON` ni el nombre del índice, así que se scopean aparte).
- **DDL de vistas/triggers** (`CREATE [TEMP] VIEW/TRIGGER <nombre>` / `DROP VIEW/TRIGGER <nombre>`): el **nombre del objeto** también debe empezar por el prefijo `wjp_<slug>_` del plugin (el matcher genérico de tablas no lo ve), o la sentencia se deniega — igual que la regla de índices, para que un plugin no squattee ni shadowee un objeto en el namespace compartido.

Todo esto se decide sobre la salida de **un solo lexer** (`lexSql`), que recorre la cadena **una vez** reconociendo comentarios, literales de string e identificadores entrecomillados **en contexto** — un `/*` dentro de un literal es texto, una `'` dentro de un comentario es comentario —, para que el contenido de ninguno pueda leerse jamás como estructura. Los comentarios SQL (`/* */` y `--`) se blanquean **antes** de evaluar para que no sirvan de espacio en blanco que evada los chequeos (el `--` solo abre comentario si le sigue espacio/fin de línea, la regla más estricta —la de MySQL—, y se cierra tanto en `\n` como en un `\r` suelto, la de Postgres: así el texto que cualquier motor ejecutaría sigue siendo visible para el guard). Los identificadores entrecomillados (`"comillas"`, `` `backticks` ``) se emiten como **un único token opaco marcado como nombre**, así que un alias como `AS "order"` no se confunde con la palabra clave `ORDER` ni inyecta un paréntesis fantasma; los `[corchetes]` no se normalizan: se **deniegan** (ver arriba). `createTable` aplica el mismo principio: un plugin solo puede crear tablas bajo su propio prefijo (no puede crear ni shadowear tablas del core o de otros plugins).

#### Ciclo de vida: desinstalar y `dropData`

Al desinstalar un plugin, `uninstallPluginData(slug, { dropTables })` (`backend/src/core/plugins.ts`) **siempre** limpia sus grants (`removeGrants`), strikes de crash y assets encolados — así un slug re-subido no hereda permisos viejos. Las tablas `wjp_<slug>_*` del plugin se **conservan por defecto** (paridad con WordPress) y solo se **dropean** cuando el admin marca la casilla `dropData` en el borrado (`DELETE`, `routes/plugins.ts` → `dropTables: !!dropData`). El drop se limita a tablas bajo el prefijo `wjp_<slug>_` del plugin: nunca toca tablas del core ni de otro plugin.

El scoping es **incondicional**: no hay forma de que un plugin lo levante. `verifyPermission('database', …)` solo decide si el plugin **puede** acceder a la BD; `assertSqlAllowed(tablePrefix)` siempre impone el confinamiento por prefijo. Un plugin puede pedir `database:admin` (o cualquier scope) en su manifest cuanto quiera — ninguna ruta de código lee ese `access` para saltarse `assertSqlAllowed`, así que sigue table-scoped a su prefijo igualmente.

Como los plugins ya no pueden leer tablas del core, la info **no secreta** del sitio (`url`/`domain`/`adminEmail`) se obtiene vía el bridge `wordjs.site` (grant `settings:read`). Las opciones secretas o críticas para la seguridad (las que matchean patrones `secret`/`passw…`/`…key…`/`token`/`credential`/`encryption`, más nombres como `wordjs_user_roles`, `active_plugins`, `siteurl`) están bloqueadas para **todo** plugin a través de `wordjs.options` — sin bypass de confianza.

> **Defensa en profundidad (en el hijo):** el proceso aislado también corre `secure-require.ts` (bloquea `worker_threads`/`vm`/`child_process`/módulos de red, `process.binding`, addons nativos). Si cualquier código de plugin/tema hiciera `require('../config/database')`, `secure-require` no le devuelve el `dbAsync` real sino un `dbAsync` **con scope** (un Proxy `guardedDb`): en `run/get/all/exec/each` corre `guardPluginSql`, que **delega en el mismo `assertSqlAllowed`** del bridge (con `allowedVerbs=[]`, dejando la mezcla de verbos al método que llama, y derivando el prefijo `wjp_<slug>_` del plugin activo con `getEffectivePlugin()`). Es deliberadamente la **misma** implementación y no una copia: la comprobación por regex que había antes aquí divergía del bridge y se esquivaba con `FROM/**/users` o `FROM"users"`, y encima no tenía restricción por prefijo, así que un tema o un plugin in-process podía leer las tablas de cualquier otro. Ahora las dos superficies de BD comparten denials estructurales, denylist de catálogos/funciones de archivo, sentencia única, denylist de tablas del core **y** el allowlist positivo por prefijo. También corre `io-guard.ts`, que confina el `fs` al **propio dir** del plugin: bloquea escrituras a su código y lecturas de `.env`/secretos; el bloqueo de los **archivos de BD** (`data/wordjs.db` + sidecars) actúa dentro del hijo aislado (`__WORDJS_ISOLATED__`), no en el host (donde el driver del bridge abre legítimamente `data/wordjs.db`), de modo que un plugin no puede leer la BD por fuera del bridge tocando el archivo directamente. Además, `io-guard` **deniega leer el dir de un plugin hermano** — su `package.json`, su `node_modules` o cualquier archivo (solo resuelve el propio árbol del plugin + ancestros compartidos), así que un plugin no puede exfiltrar archivos/secretos de otro plugin ni siquiera fuera de la BD (IO-1).

> **Nota histórica:** `db-migration` ya **no** es un plugin (migraba/tocaba tablas del core y gestionaba procesos del servidor). Ahora es infraestructura del core en `backend/src/core/db-admin/`. Ver [database.md §1.4](./database.md).

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

| Tipo Plugin | SQLite                              | PostgreSQL           | MySQL / MariaDB                        |
| ----------- | ----------------------------------- | -------------------- | -------------------------------------- |
| `INT_PK`    | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` | `INTEGER AUTO_INCREMENT PRIMARY KEY`   |
| `INT`       | `INTEGER`                           | `INTEGER`            | `INTEGER`                              |
| `TEXT`      | `TEXT`                              | `TEXT`               | `LONGTEXT` (o `VARCHAR(255)` **solo** si el DDL hace la columna parte de una clave) |
| `REAL`      | `REAL`                              | `REAL`               | `REAL`                                 |
| `DATETIME`  | `DATETIME`                          | `TIMESTAMP`          | `DATETIME`                             |
| `TIMESTAMP` | `DATETIME`                          | `TIMESTAMP`          | `DATETIME`                             |

> El driver **MySQL** (`backend/src/drivers/mysql.ts`, `mysql2`, MySQL 8.0+/MariaDB) traduce el dialecto SQLite en el borde del driver (`translateSql`): `INTEGER PRIMARY KEY AUTOINCREMENT`/`SERIAL` → `INTEGER AUTO_INCREMENT PRIMARY KEY`, `TEXT` → `LONGTEXT`, `INSERT OR IGNORE`/`ON CONFLICT` → `INSERT IGNORE`/`ON DUPLICATE KEY UPDATE`, y `RETURNING` → `insertId`. El plugin no escribe nada distinto: sigue usando sintaxis SQLite.

> **El tipo de una columna `TEXT` ya no depende de su NOMBRE** (`backend/src/drivers/mysql-text-rule.ts`). Antes el defecto era `VARCHAR(255)` salvo que el nombre de la columna figurase en una lista fija de ~20 columnas del núcleo. Esa lista no puede conocer las columnas de un plugin ni las de un bundle importado, así que **toda** columna `TEXT` de plugin (un cuerpo de correo, la descripción de una subasta, el payload de un formulario) se creaba de 255 caracteres; y como la sesión además renunciaba a `STRICT_TRANS_TABLES`, un valor demasiado largo se **truncaba con un aviso en vez de rechazarse** — `POST /api/v1/import` mutilaba el contenido mientras contaba las filas como importadas. Ahora la regla se deriva del propio `CREATE TABLE`: `TEXT` → `LONGTEXT` salvo que la columna forme parte de una clave (`PRIMARY KEY`/`UNIQUE` en línea, o un `PRIMARY KEY (…)`/`UNIQUE (…)`/`KEY (…)`/`INDEX (…)`/`FOREIGN KEY (…)` que la nombre), en cuyo caso es `VARCHAR(255)` porque MySQL no indexa un `TEXT` sin longitud de prefijo. `STRICT_TRANS_TABLES` vuelve a estar activo: lo que no cabe es un **error**, no una pérdida silenciosa.

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
2. **Normalización automática**: el driver de Postgres convierte `?` a `$1, $2` (e inyecta `RETURNING` en INSERTs); el driver WASM legacy quita `RETURNING`; el driver MySQL reescribe el dialecto (`translateSql`) y mapea `RETURNING` a `insertId`. El plugin no nota nada.
3. **Compatibilidad total**: Funciona con SQLite Native (default), SQLite Legacy (WASM), PostgreSQL y MySQL/MariaDB
4. **Sin cambios al migrar**: Si cambias de driver, el plugin sigue funcionando sin modificaciones
5. **Código más limpio**: No necesitas detectar el driver manualmente
6. **Transparente**: Los plugins no saben qué driver están usando

## Detectar el dialecto: `wordjs.db.getType()`

Si necesitas información sobre el driver activo (para lógica condicional, rara vez necesaria):

```javascript
const { isPostgres, isMySQL, isSQLite, driver } = wordjs.db.getType();

if (isPostgres) {
    // Lógica específica para PostgreSQL (raro, pero posible)
}
```

> `getType()` devuelve `{ isPostgres, isMySQL, isSQLite, driver }` (`driver` es el nombre completo del driver configurado: `'sqlite-native'`, `'sqlite-legacy'`, `'postgres'`, `'mysql'` o `'mariadb'`). Ojo: `isSQLite` es `true` para **todo lo que no sea Postgres**, incluido MySQL (para que las ramas binarias `isPostgres ? pg : sqlite` sigan tomando el camino SQLite, que el driver MySQL traduce) — así que `isSQLite && isMySQL` es un estado normal, y para "SQLite de verdad" la condición es `isSQLite && !isMySQL`.

## Migraciones

**Un plugin no puede introspeccionar el esquema.** `PRAGMA` e `information_schema` (igual que `sqlite_master`/`pg_catalog`) están **denegados por `assertSqlAllowed` para todos los plugins**, y además los verbos de lectura son solo `select`/`with`, así que un `PRAGMA table_info(...)` ni siquiera pasa el allowlist de verbos. No hay forma de preguntar "¿existe esta columna?" desde el bridge.

El patrón es hacer las migraciones **idempotentes** en vez de condicionales:

- **Tablas**: `db.createTable()` emite `CREATE TABLE IF NOT EXISTS`, así que volver a llamarlo en cada `init()` con el juego completo de columnas es seguro.
- **Columnas nuevas**: `ALTER TABLE <tabla propia> ADD COLUMN …` sí está permitido (`alter` está en los verbos de `db.run`, `TABLE` es una clase de objeto DDL admitida, y la tabla se atribuye por tu prefijo). SQLite no tiene `ADD COLUMN IF NOT EXISTS`, así que la forma idempotente es **tragarse el error de columna duplicada**:

```javascript
async function addColumnIfMissing(wordjs, table, col, type) {
    // Solo un identificador SQL seguro puede ir concatenado en el DDL.
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(col)) return false;
    try { await wordjs.db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); return true; }
    catch (e) { return false; /* ya existía (o el tipo era inválido) — ignorar es seguro */ }
}

async function migrate(wordjs) {
    const T = wordjs.db.tablePrefix + 'data';
    await addColumnIfMissing(wordjs, T, 'new_col', "TEXT DEFAULT ''");
}
```

> Es exactamente lo que hace `conference-manager` (`marketplace/plugins/conference-manager/index.js`), que documenta el mismo motivo en su propio código.
>
> Ojo con el `DEFAULT` de un `ADD COLUMN`: solo rellena las filas existentes en el arranque en que la columna se crea por primera vez. Las filas nuevas llegan con el valor que inserte tu `INSERT`.

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

- ✅ `card-gallery` - Persiste sus datos vía el bridge `wordjs.options` (clave/valor), no en tablas SQL
- ✅ `video-gallery` - Persiste sus datos vía el bridge `wordjs.options` (clave/valor), no en tablas SQL
- ✅ `mail-server` - Plugin **totalmente untrusted** (sandboxed): usa los grants `database:read` + `database:write` (entre otros que pide su manifest) y guarda **todos** sus datos en la BD — incluidas claves DKIM y secretos SMTP del relay — en sus propias tablas `wjp_mail_server_*` (`_received_emails` / `_email_attachments` / `_secrets`), precisamente porque `assertSqlAllowed` deniega cualquier tabla fuera de su prefijo
- ✅ `youtube-videos` - Guarda la clave de la YouTube Data API en su **propia tabla** `wjp_youtube_videos_*` (no en options, que otros plugins pueden leer); su "upsert" de settings usa el patrón **UPDATE-then-INSERT** (elección del propio plugin; el guard actual ya permite `ON CONFLICT ... DO UPDATE SET` sobre tablas propias)
- ✅ `conference-manager` - Tablas propias `wjp_conference_manager_*` vía `db.tablePrefix` + `db.createTable`; ojo: el bridge de BD **no expone transacciones** (`db.batch` agrupa el **transporte**, no es una transacción), así que las actualizaciones que dependen de otra fila se hacen con un solo `UPDATE` con subquery
- ✅ Todos los plugins existentes (incluidos los 31 del marketplace) - Sintaxis SQLite estándar; todos table-scoped a su propio prefijo (sin acceso a tablas del core)
