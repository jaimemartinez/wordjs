const fs = require('fs');
const { init } = require('../src/config/database');
const { getAdminMenuItems } = require('../src/core/adminMenu');
const { getActivePlugins } = require('../src/core/plugins');
const { applyFiltersSync } = require('../src/core/hooks');
const { setApp } = require('../src/core/appRegistry');

async function debugMenus() {
    try {
        console.log('Mocking App...');
        // Mock Express App to preventing plugins from crashing
        const mockApp = {
            use: () => { },
            get: () => { },
            post: () => { },
            put: () => { },
            delete: () => { }
        };
        setApp(mockApp);

        console.log('Initializing DB...');
        await init();

        console.log('Loading active plugins...');
        const { loadActivePlugins } = require('../src/core/plugins');
        await loadActivePlugins();

        console.log('Fetching active plugins list...');
        const activePlugins = await getActivePlugins();
        console.log('Active Plugins:', activePlugins);

        console.log('Fetching all menus...');
        const allMenus = getAdminMenuItems();

        let activeMenus = allMenus.filter(menu => activePlugins.includes(menu.plugin));
        console.log(`Found ${activeMenus.length} active menus.`);

        // Mock user for hooks
        const mockUser = {
            userLogin: 'admin',
            userEmail: 'admin@example.com',
            role: 'administrator',
            capabilities: ['*']
        };

        activeMenus = applyFiltersSync('admin_menu_items', activeMenus, { user: mockUser });

        console.log('Writing dump...');
        fs.writeFileSync('menus_dump.json', JSON.stringify(activeMenus, null, 2), 'utf8');
        console.log('Written detailed dump to menus_dump.json');

    } catch (e) {
        console.error('CRITICAL ERROR:', e);
        process.exit(1);
    }
}

debugMenus();
