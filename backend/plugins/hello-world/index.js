/**
 * Hello World Plugin for WordJS
 * Example plugin demonstrating the plugin test framework
 */

// Plugin metadata
exports.metadata = {
    name: 'Hello World',
    version: '1.0.0',
    description: 'A sample plugin that adds a greeting filter',
    author: 'WordJS'
};

// Called when plugin is activated. Receives the WordJS capability bridge (`wordjs`).
// Isolated plugins run in their own OS process and reach core ONLY through the injected `wordjs`
// bridge — never require() core modules directly (the sandbox blocks that). See
// documentation/plugin-isolation-proposal.md.
exports.init = function (wordjs) {
    // Add a filter to post content via the capability bridge.
    wordjs.hooks.addFilter('the_content', (content) => {
        return '<p><em>Hello from the Hello World plugin!</em></p>' + content;
    });

    console.log('✅ Hello World plugin initialized (via capability bridge)!');
};

// Called when plugin is deactivated
exports.deactivate = function () {
    console.log('👋 Hello World plugin deactivated!');
};
