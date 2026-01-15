const path = require('path');
const fs = require('fs');

const cwd = process.cwd();
const pluginsDir = path.resolve('./plugins');

console.log('Current Working Directory:', cwd);
console.log('Resolved Plugins Directory:', pluginsDir);

if (fs.existsSync(pluginsDir)) {
    console.log('Plugins directory exists!');
    const entries = fs.readdirSync(pluginsDir);
    console.log('Entries:', entries);
} else {
    console.log('Plugins directory DOES NOT exist at this path.');
}
