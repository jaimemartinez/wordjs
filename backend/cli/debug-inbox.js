const { init, dbAsync } = require('../src/config/database');
const User = require('../src/models/User');
const Email = require('../src/models/Email');
const config = require('../src/config/app');

async function debugInbox() {
    await init();

    console.log('--- Debug Inbox State ---');

    // 1. Check Site Domain
    const siteUrl = new URL(config.site.url);
    const siteDomain = siteUrl.hostname;
    console.log('Site Domain:', siteDomain);

    // 2. Check User existence
    const admi = await User.findByLogin('admi');
    const admin = await User.findByLogin('admin');

    if (admi) {
        console.log('User "admi" found. Email:', admi.userEmail);
    } else {
        console.log('User "admi" NOT found.');
    }

    if (admin) {
        console.log('User "admin" found. Email:', admin.userEmail);
    }

    // 3. Check for the email in DB
    const recentEmails = await dbAsync.all('SELECT * FROM received_emails ORDER BY id DESC LIMIT 5');
    console.log('\nLast 5 emails in DB:');
    recentEmails.forEach(e => {
        console.log(`- ID: ${e.id}, To: ${e.to_address}, Subj: ${e.subject}, isSent: ${e.is_sent}`);
    });

    process.exit(0);
}

debugInbox();
