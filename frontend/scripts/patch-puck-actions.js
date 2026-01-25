const fs = require('fs');
const path = require('path');

const filesToPatch = [
    path.join(__dirname, '../node_modules/@measured/puck/dist/index.js'),
    path.join(__dirname, '../node_modules/@measured/puck/dist/chunk-QIGVND56.mjs')
];

filesToPatch.forEach(filePath => {
    if (!fs.existsSync(filePath)) {
        console.warn('Puck file not found at:', filePath);
        return;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let patchCode = '';
    let match = null;

    // Pattern 1: CJS / Webpack (sequence expression)
    // Matches: (0, import_jsx_runtime20.jsx)(ActionBar.Action, {
    const cjsRegex = /permissions\.duplicate\s*&&\s*(\/\*.*?\*\/\s*)?\(\s*0\s*,\s*([a-zA-Z0-9_]+)\.jsx\s*\)\s*\(\s*([a-zA-Z0-9_]+)\.Action\s*,\s*\{/;

    // Pattern 2: ESM / Vite (direct call)
    // Matches: jsx20(ActionBar.Action, {
    const esmRegex = /permissions\.duplicate\s*&&\s*(\/\*.*?\*\/\s*)?([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\.Action\s*,\s*\{/;

    let usedRegex = null;

    if (cjsRegex.test(content)) {
        console.log(`Detected CJS pattern in ${path.basename(filePath)}`);
        match = content.match(cjsRegex);
        usedRegex = cjsRegex;
        const jsxRuntime = match[2];
        const actionBarName = match[3];
        // CJS Patch: (0, runtime.jsx)(ActionBar.Action, ...)
        patchCode = `(componentType === "Text" || componentType === "Heading") && /* @__PURE__ */ (0, ${jsxRuntime}.jsx)(${actionBarName}.Action, { 
            label: "Edit", 
            onClick: function(e) { 
                e.preventDefault(); 
                e.stopPropagation(); 
                if (typeof window !== 'undefined' && window.puckSetActiveEditorId) {
                    window.puckSetActiveEditorId(id);
                }
            }, 
            children: /* @__PURE__ */ (0, ${jsxRuntime}.jsx)("i", { className: "fa-solid fa-pencil" }) 
        }), `;
    } else if (esmRegex.test(content)) {
        console.log(`Detected ESM pattern in ${path.basename(filePath)}`);
        match = content.match(esmRegex);
        usedRegex = esmRegex;
        const jsxFunc = match[2];
        const actionBarName = match[3];
        // ESM Patch: jsx20(ActionBar.Action, ...)
        patchCode = `(componentType === "Text" || componentType === "Heading") && /* @__PURE__ */ ${jsxFunc}(${actionBarName}.Action, { 
            label: "Edit", 
            onClick: function(e) { 
                e.preventDefault(); 
                e.stopPropagation(); 
                if (typeof window !== 'undefined' && window.puckSetActiveEditorId) {
                    window.puckSetActiveEditorId(id);
                }
            }, 
            children: /* @__PURE__ */ ${jsxFunc}("i", { className: "fa-solid fa-pencil" }) 
        }), `;
    } else {
        console.error(`Could not find Duplicate action pattern in ${path.basename(filePath)}`);
        return;
    }

    // Check if already patched to avoid double patching
    if (content.includes('window.puckSetActiveEditorId(id)')) {
        console.log(`File ${path.basename(filePath)} already patched.`);
        return;
    }

    const newContent = content.replace(usedRegex, (m) => patchCode + m);

    if (content.length === newContent.length) {
        console.log(`Replacement failed for ${path.basename(filePath)}`);
    } else {
        fs.writeFileSync(filePath, newContent, 'utf8');
        console.log(`Successfully patched ${path.basename(filePath)}`);
    }
});
