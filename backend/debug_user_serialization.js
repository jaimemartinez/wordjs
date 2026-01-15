const { init } = require('./src/config/database');
const User = require('./src/models/User');
const { getRoles } = require('./src/core/roles');

async function debugUser() {
    try {
        console.log('Initializing DB...');
        await init();

        console.log('Roles structure check:');
        const roles = getRoles();
        console.log('Roles:', JSON.stringify(roles, null, 2));

        console.log('Creating/Fetching Admin User...');
        let user = User.findByLogin('admin');
        if (!user) {
            console.log('Admin not found, finding by first ID...');
            user = User.findById(1);
        }

        if (user) {
            console.log('User found:', user.userLogin);
            const json = user.toJSON();
            console.log('User.toJSON() output:');
            console.log(JSON.stringify(json, null, 2));

            console.log('Type of capabilities:', typeof json.capabilities);
            console.log('Is Array?', Array.isArray(json.capabilities));
        } else {
            console.log('No user found to test.');
        }

    } catch (e) {
        console.error(e);
    }
}

debugUser();
