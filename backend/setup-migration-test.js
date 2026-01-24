const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, 'data');
const target = path.join(dataDir, 'postgres-embed');

console.log('🧪 Setting up test environment for DB Migration cleanup...');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

if (!fs.existsSync(target)) {
    console.log(`📁 Creating dummy folder: ${target}`);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'test-file.txt'), 'This is dummy data representing a leftover DB.');
    fs.writeFileSync(path.join(target, 'postgresql.conf'), 'dummy config');
    console.log('✅ Dummy \'postgres-embed\' folder created.');
} else {
    console.log('ℹ️  Folder already exists.');
}

console.log('\n👉 Go to the Admin Panel -> Tools -> DB Migration');
console.log('👉 You should now see \'postgres-embed\' in the "Legacy/Unused Files" list.');
console.log('👉 Click "Clean Up" to test the deletion logic.');
