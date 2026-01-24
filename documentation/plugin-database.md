# Plugin Database Compatibility Guide

**Los plugins de WordJS usan UNA SOLA sintaxis (SQLite-style) para TODAS las interacciones con la base de datos.** El core se encarga automáticamente de la compatibilidad con diferentes drivers.

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

```javascript
const { createPluginTable } = require('../../src/config/database');

async function initSchema() {
    await createPluginTable('my_table', [
        'id INT_PK',
        'name TEXT NOT NULL',
        'email TEXT UNIQUE',
        'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        'balance REAL DEFAULT 0',
        'status INT DEFAULT 0',
        'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'
    ]);
}
```

### Ventajas

1. **Una sola sintaxis global**: Los plugins escriben SQLite-style para TODO
2. **Normalización automática**: El core convierte `?` a `$1, $2` automáticamente
3. **Compatibilidad total**: Funciona con SQLite Legacy, SQLite Native y PostgreSQL
4. **Sin cambios al migrar**: Si cambias de driver, el plugin sigue funcionando sin modificaciones
5. **Código más limpio**: No necesitas detectar el driver manualmente
6. **Transparente**: Los plugins no saben qué driver están usando

## Función `getDbType()`

Si necesitas información sobre el driver actual (para lógica condicional):

```javascript
const { getDbType } = require('../../src/config/database');

const { isPostgres, isSQLite, driver } = getDbType();

if (isPostgres) {
    // Lógica específica para PostgreSQL (raro, pero posible)
}
```

## Migraciones

Para migraciones que verifican si columnas existen, usa `getDbType()`:

```javascript
const { dbAsync, getDbType } = require('../../src/config/database');

async function migrate() {
    const { isPostgres } = getDbType();
    
    if (isPostgres) {
        const result = await dbAsync.get(
            `SELECT COUNT(*) as count FROM information_schema.columns 
             WHERE table_name = ? AND column_name = ?`,
            [tableName, columnName]
        );
        return result.count > 0;
    } else {
        const result = await dbAsync.all(`PRAGMA table_info(${tableName})`);
        return result.some(col => col.name === columnName);
    }
}
```

## Ejemplos Completos

### Plugin Completo con Tablas y Queries

```javascript
const { dbAsync, createPluginTable, getDbType } = require('../../src/config/database');

async function initSchema() {
    // Crear tabla con sintaxis unificada
    await createPluginTable('my_plugin_data', [
        'id INT_PK',
        'name TEXT NOT NULL',
        'value REAL DEFAULT 0',
        'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ]);
}

async function getData(id) {
    // Query estándar - sintaxis SQLite, funciona en todos los drivers
    return await dbAsync.get('SELECT * FROM my_plugin_data WHERE id = ?', [id]);
}

async function getAllData(limit = 10, offset = 0) {
    // Query con LIMIT/OFFSET - funciona igual en todos los drivers
    return await dbAsync.all(
        'SELECT * FROM my_plugin_data ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [limit, offset]
    );
}

async function createData(name, value) {
    // INSERT estándar - sintaxis SQLite
    const result = await dbAsync.run(
        'INSERT INTO my_plugin_data (name, value) VALUES (?, ?)',
        [name, value]
    );
    return result.lastID;
}

async function updateData(id, name, value) {
    // UPDATE estándar
    await dbAsync.run(
        'UPDATE my_plugin_data SET name = ?, value = ? WHERE id = ?',
        [name, value, id]
    );
}

async function deleteData(id) {
    // DELETE estándar
    await dbAsync.run('DELETE FROM my_plugin_data WHERE id = ?', [id]);
}
```

## Plugins Actualizados

- ✅ `card-gallery` - Usa `createPluginTable()` y queries estándar
- ✅ `video-gallery` - Usa `createPluginTable()` y queries estándar
- ✅ `mail-server` - Usa `createPluginTable()` y queries estándar
- ✅ Todos los plugins existentes - Ya usan sintaxis SQLite estándar automáticamente
