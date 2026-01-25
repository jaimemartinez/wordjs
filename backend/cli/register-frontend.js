const http = require('http');

const data = JSON.stringify({
    name: 'frontend',
    url: 'http://localhost:3001',
    routes: ['/']
});

const secret = '8280f373eda00c98d53be3cbb36b14125733120da863cff29e8924bbcdc0fd0e';

console.log('Registering frontend with Gateway...');

const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/register',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'x-gateway-secret': secret
    }
}, (res) => {
    console.log(`Response Status: ${res.statusCode}`);
    res.on('data', (d) => {
        process.stdout.write(d);
        console.log('\nDone.');
    });
});

req.on('error', (error) => {
    console.error('Error:', error);
});

req.write(data);
req.end();
