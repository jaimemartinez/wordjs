const nodemailer = require('nodemailer');

async function sendExternalTest() {
    console.log('--- External SMTP Delivery Test ---');

    // Connect to the local WordJS SMTP Server
    const transporter = nodemailer.createTransport({
        host: 'localhost',
        port: 2525,
        secure: false, // Port 2525 is usually plain or STARTTLS
        tls: {
            rejectUnauthorized: false // Allow self-signed or no cert for local test
        }
    });

    const mailOptions = {
        from: '"External Sender" <someone@external.com>',
        to: 'admin@localhost', // Assuming 'admin' is the login and localhost is the domain
        subject: 'External SMTP Test',
        text: 'This email was sent via SMTP to port 2525, bypassing internal delivery logic.',
        html: '<p>This email was sent via <strong>SMTP to port 2525</strong>, bypassing internal delivery logic.</p>'
    };

    console.log(`Sending email to ${mailOptions.to}...`);
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully!');
        console.log('Message ID:', info.messageId);
        console.log('Response:', info.response);
        console.log('\nCheck the WordJS Admin Panel for the real-time notification!');
    } catch (error) {
        console.error('❌ Failed to send email via SMTP:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error('   Hint: Is the WordJS server running and the Mail Server plugin active?');
        }
    }
}

sendExternalTest();
