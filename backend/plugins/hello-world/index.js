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

// Called when plugin is activated
exports.init = function () {
    const { addFilter } = require('../../src/core/hooks');

    // Add a filter to post content
    addFilter('the_content', (content) => {
        return '<p><em>Hello from the Hello World plugin!</em></p>' + content;
    });

    console.log('✅ Hello World plugin initialized!');
};

// Called when plugin is deactivated
exports.deactivate = function () {
    console.log('👋 Hello World plugin deactivated!');
};
