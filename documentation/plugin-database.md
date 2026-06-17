# Plugin Database Compatibility Guide

**Los plugins de WordJS usan UNA SOLA sintaxis (SQLite-style) para TODAS las interacciones con la base de datos.** El core se encarga automáticamente de la compatibilidad con diferentes drivers (ver [database.md](./database.md) para el modelo de drivers).

## Acceso a la BD: el bridge `wordjs` (plugins aislados)

Los plugins corren **aislados** en un worker (`worker_threads`) y NO hacen `require()` de módulos del core. Acceden a la base de datos a través del **capability bridge** `wordjs`, que el host les pasa en `init(wordjs)` y que verifica permisos y restringe argumentos en el host (`backend/src/core/plugin-api.ts`):

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

Métodos del bridge: `wordjs.db.all/get/run`, `wordjs.db.createTable(name, columns)`, `wordjs.db.getType()`. Cada uno exige el permiso correspondiente del manifest (`database:read` / `database:write`).

### Aislamiento de tablas: el core está fuera de límites

Un plugin **no confiable** (sandboxed) está **table-scoped**: el host rechaza cualquier SQL que mencione una tabla del core, y no puede crear una tabla cuyo nombre choque con una del core.

| Tipo de plugin                         | Acceso a BD                                                                 |
| :------------------------------------- | :------------------------------------------------------------------------- |
| **Untrusted** (sandboxed, por defecto) | Solo sus propias tablas. SQL que referencie `users`, `user_meta`, `options`, `roles`, `sessions`, … es **denegado** (`🛡️ query references core table`). |
| **Operator-trusted** (privilegiado)    | BD sin restricción (puede tocar tablas del core). El scoping se levanta.    |

La confianza es **server-side** y nunca auto-declarable: se otorga vía `config.trustedSystemPlugins` (defaults de fábrica) o un toggle de admin en la UI de Plugins. Un plugin puede pedir `database:admin` en su manifest cuanto quiera — sin confianza del operador, sigue sin alcanzar las tablas del core. El guard es un **denylist textual conservador** (quita comentarios SQL y bloquea el nombre de tabla como palabra completa en cualquier parte de la sentencia), no un parser, así que puede sobre-bloquear queries que solo mencionen el nombre de una tabla del core — comportamiento aceptable, un plugin no confiable no tiene por qué nombrarlas.

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

> Una `FOREIGN KEY (...) REFERENCES users(id)` apunta a una tabla del core (`users`) — para un plugin **untrusted** está fuera de alcance. Referencia solo a tus propias tablas.

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
- ✅ `mail-server` - Plugin **operator-trusted** (mail provider): BD sin restricción de tablas
- ✅ Todos los plugins existentes - Sintaxis SQLite estándar; los untrusted, table-scoped al core
