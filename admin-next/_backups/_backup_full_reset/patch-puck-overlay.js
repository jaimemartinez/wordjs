/**
 * Patch Puck Editor to disable overlays during inline text editing.
 * 
 * This script modifies the Puck chunk file to check for window.puckActiveEditorId
 * and skip rendering overlays when an editor is active.
 * 
 * IMPORTANT: Puck uses iframes, so we check BOTH window and window.parent
 * 
 * Run this after npm install: npm run patch-puck
 */

const fs = require('fs');
const path = require('path');

const PUCK_DIST = path.join(__dirname, '..', 'node_modules', '@measured', 'puck', 'dist');

// Find all chunk files
const files = fs.readdirSync(PUCK_DIST).filter(f => f.startsWith('chunk-') && f.endsWith('.mjs'));

let patched = false;

// The condition we want to inject - checks both iframe window and parent window
const OVERLAY_CONDITION = '(typeof window === "undefined" || (!(window.puckActiveEditorId) && !(window.parent && window.parent.puckActiveEditorId)))';

for (const file of files) {
    const filePath = path.join(PUCK_DIST, file);
    let content = fs.readFileSync(filePath, 'utf-8');

    // Check if this file has the overlay code we need to patch
    if (content.includes('createPortal2') && content.includes('data-puck-overlay')) {
        console.log(`Found overlay code in: ${file}`);

        // Check if already patched with parent check
        if (content.includes('window.parent.puckActiveEditorId')) {
            console.log('  ✅ Already patched with parent window check');
            patched = true;
            continue;
        }

        let modified = false;

        // Pattern 1: Already has old patch (window.puckActiveEditorId only) - upgrade it
        const oldPatchPattern = /\(typeof window === "undefined" \|\| !window\.puckActiveEditorId\)/g;
        if (oldPatchPattern.test(content)) {
            content = content.replace(oldPatchPattern, OVERLAY_CONDITION);
            modified = true;
            console.log('  📝 Upgraded existing patch to include parent window check');
        }

        // Pattern 2: Fresh file - dragFinished && isVisible && createPortal2(
        if (!modified) {
            const freshPattern = /dragFinished\s*&&\s*isVisible\s*&&\s*createPortal2\s*\(/g;
            if (freshPattern.test(content)) {
                content = content.replace(freshPattern, `dragFinished && isVisible && ${OVERLAY_CONDITION} && createPortal2(`);
                modified = true;
                console.log('  📝 Applied fresh overlay suppression patch');
            }
        }

        if (modified) {
            fs.writeFileSync(filePath, content, 'utf-8');
            console.log('  ✅ Saved patched file');
            patched = true;
        } else {
            console.log('  ⚠️ Could not find pattern to patch');
        }
    }
}

if (patched) {
    console.log('\n✅ Puck overlay patch applied successfully!');
    console.log('   Overlays will be hidden when window.puckActiveEditorId or window.parent.puckActiveEditorId is set');
} else {
    console.log('\n⚠️ No files were patched. The pattern may have changed in this Puck version.');
}
