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
// Phase-1 adoption pattern: use the injected API instead of require()ing core modules directly
// (see documentation/plugin-isolation-proposal.md). Falls back to a direct require if loaded
// without the API, so it stays compatible.
exports.init = function (wordjs) {
    const addFilter = wordjs
        ? wordjs.hooks.addFilter
        : require('../../src/core/hooks').addFilter;

    // Add a filter to post content
    addFilter('the_content', (content) => {
        return '<p><em>Hello from the Hello World plugin!</em></p>' + content;
    });

    console.log('✅ Hello World plugin initialized (via capability bridge)!');
};

// Called when plugin is deactivated
exports.deactivate = function () {
    console.log('👋 Hello World plugin deactivated!');
};
