/**
 * WordJS - External SMTP Test Script
 * This script simulates an external mail server sending an email to WordJS
 * via the standard SMTP protocol on port 2525.
 */
const nodemailer = require('./backend/node_modules/nodemailer');

async function sendExternalTest() {
    console.log('--- External SMTP Delivery Test ---');

    // 1. Configure transporter to point to the local WordJS SMTP server
    const transporter = nodemailer.createTransport({
        host: 'localhost',
        port: 2525,
        secure: false, // Port 2525 usually doesn't have TLS/SSL in local dev
        tls: {
            rejectUnauthorized: false
        }
    });

    // 2. Prepare the email
    const mailOptions = {
        from: '"External Sender" <someone@external-domain.com>',
        to: 'admin@localhost', // Should match a local user or catch-all
        subject: 'External Delivery Notification Test',
        text: 'This email was sent via SMTP on port 2525. It should trigger a REVERSED delivery flow.',
        html: '<p>This email was sent via <strong>SMTP</strong> on port 2525.</p><p>It should trigger the <code>onData</code> handler and generate a notification.</p>'
    };

    console.log(`Sending email to ${mailOptions.to} via localhost:2525...`);

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Success! Message sent.');
        console.log('Message ID:', info.messageId);
        console.log('Response:', info.response);
        console.log('\nCheck the WordJS Admin Panel for the notification!');
    } catch (error) {
        console.error('❌ Failed to send email via SMTP:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error('   Hint: Is the WordJS backend running? Is the Mail Server plugin enabled?');
        }
    }
}

sendExternalTest();
