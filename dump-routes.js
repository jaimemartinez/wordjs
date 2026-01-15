const app = require('./backend/src/index');
const listEndpoints = require('express-list-endpoints');

// Wait for a bit to ensure plugins are loaded if they were async
setTimeout(() => {
    console.log('--- Registered Endpoints ---');
    const endpoints = listEndpoints(app);
    endpoints.forEach(end => {
        console.log(`${end.methods.join(',')} ${end.path}`);
    });
    console.log('--- End of Endpoints ---');
    process.exit(0);
}, 5000);
