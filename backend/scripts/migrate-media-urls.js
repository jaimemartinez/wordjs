/**
 * Migration Script: Convert absolute media URLs to relative paths
 * 
 * This script updates all attachment GUIDs and site options in the database
 * from absolute URLs (e.g., https://old-domain.com/uploads/image.jpg) to
 * relative paths (e.g., /uploads/image.jpg) to ensure portability across domains.
 * 
 * Usage (from anywhere; it switches to backend/): node scripts/migrate-media-urls.js [--dry-run]
 * 
 * Options:
 *   --dry-run    Show what would be changed without making actual updates
 */

const path = require('path');
const fs = require('fs');

// Like scripts/migrate.js: run from backend/ (config and data resolve there, as on a normal boot), use
// the compiled dist/ when it exists, otherwise register ts-node to load the TypeScript sources — so a
// plain `node scripts/migrate-media-urls.js` works without `-r ts-node/register`.
const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
const distDb = path.join(BACKEND, 'dist', 'config', 'database.js');
if (!fs.existsSync(distDb)) {
    require(require.resolve('ts-node/register', { paths: [BACKEND] }));
}
const database = fs.existsSync(distDb) ? require(distDb) : require('../src/config/database');

const isDryRun = process.argv.includes('--dry-run');

async function migrateMediaUrls() {
    console.log('📦 Media URL Migration Script');
    console.log('==============================');
    console.log(`Mode: ${isDryRun ? '🔍 DRY RUN (no changes will be made)' : '⚡ LIVE (changes will be applied)'}\n`);

    // Initialize database connection
    console.log('Connecting to database...');
    await database.init();
    const dbAsync = database.getDbAsync();

    if (!dbAsync) {
        throw new Error('Failed to get database connection');
    }

    let totalUpdated = 0;

    // ===== PART 1: Migrate Attachments =====
    console.log('\n📎 Checking attachment GUIDs...');

    const attachments = await dbAsync.all(`
        SELECT id, guid, post_title 
        FROM posts 
        WHERE post_type = 'attachment' 
        AND (guid LIKE 'http://%' OR guid LIKE 'https://%')
    `);

    if (attachments.length === 0) {
        console.log('✅ All attachments already using relative paths!');
    } else {
        console.log(`Found ${attachments.length} attachment(s) with absolute URLs:\n`);

        for (const attachment of attachments) {
            const { id, guid, post_title } = attachment;
            const match = guid.match(/\/uploads\/.+$/);

            if (match) {
                const relativePath = match[0];
                console.log(`[ID: ${id}] "${post_title || 'Untitled'}"`);
                console.log(`   Old: ${guid}`);
                console.log(`   New: ${relativePath}`);

                if (!isDryRun) {
                    await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [relativePath, id]);
                    console.log('   ✅ Updated\n');
                } else {
                    console.log('   🔍 Would update (dry run)\n');
                }
                totalUpdated++;
            } else {
                console.log(`[ID: ${id}] "${post_title || 'Untitled'}"`);
                console.log(`   ⚠️  Skipped - Cannot extract /uploads/ path from: ${guid}\n`);
            }
        }
    }

    // ===== PART 2: Migrate Options (site_logo, site_icon, etc.) =====
    console.log('\n📋 Checking site options with image URLs...');

    const imageOptions = ['site_logo', 'site_icon'];

    for (const optionName of imageOptions) {
        const result = await dbAsync.get(
            `SELECT option_value FROM options WHERE option_name = ?`,
            [optionName]
        );

        if (result && result.option_value) {
            const value = result.option_value;

            // Check if it's an absolute URL
            if (value.startsWith('http://') || value.startsWith('https://')) {
                const match = value.match(/\/uploads\/.+$/);
                if (match) {
                    const relativePath = match[0];
                    console.log(`[Option: ${optionName}]`);
                    console.log(`   Old: ${value}`);
                    console.log(`   New: ${relativePath}`);

                    if (!isDryRun) {
                        await dbAsync.run(
                            `UPDATE options SET option_value = ? WHERE option_name = ?`,
                            [relativePath, optionName]
                        );
                        console.log('   ✅ Updated\n');
                    } else {
                        console.log('   🔍 Would update (dry run)\n');
                    }
                    totalUpdated++;
                }
            } else if (value.startsWith('/uploads')) {
                console.log(`[Option: ${optionName}] Already relative ✅`);
            } else if (value) {
                console.log(`[Option: ${optionName}] Not an uploads URL, skipping`);
            }
        } else {
            console.log(`[Option: ${optionName}] Not set`);
        }
    }

    // ===== Summary =====
    console.log('\n==============================');
    console.log(`Total ${isDryRun ? 'would update' : 'updated'}: ${totalUpdated}`);

    if (isDryRun && totalUpdated > 0) {
        console.log('\n💡 Run without --dry-run to apply changes:');
        console.log('   node scripts/migrate-media-urls.js');
    }
}

migrateMediaUrls().then(() => {
    console.log('\n✅ Migration complete!');
    process.exit(0);
}).catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
