try {
    const pkg = require('embedded-postgres');
    console.log('Type:', typeof pkg);
    console.log('Exports:', Object.keys(pkg));
    if (typeof pkg === 'function') console.log('It is a function/class');
    if (pkg.EmbeddedPostgres) console.log('Has EmbeddedPostgres property');
    if (pkg.default) console.log('Has default export');
} catch (e) {
    console.error(e);
}
