/**
 * Hello World Plugin for WordJS
 *
 * The smallest useful isolated plugin: it registers a [hello] shortcode. Put `[hello]` or
 * `[hello name="Ada"]` in a post or page and the public site renders a greeting in its place.
 *
 * Isolated plugins run in their own OS process and reach core ONLY through the injected `wordjs`
 * bridge — never require() core modules directly (the sandbox blocks that). Shortcodes need no
 * permission. See documentation/plugins.md.
 */

// Plugin metadata
exports.metadata = {
    name: 'Hello World',
    version: '1.1.0',
    description: 'A sample plugin that adds a [hello] shortcode',
    author: 'WordJS'
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The shortcode handler — exported so the plugin's own tests can call it without a site. */
exports.renderHello = function (attrs) {
    const name = attrs && typeof attrs.name === 'string' && attrs.name.trim() ? attrs.name.trim().slice(0, 80) : 'world';
    return `<p class="hello-world-greeting">Hello, ${escapeHtml(name)}!</p>`;
};

// Called when the plugin is activated. Receives the WordJS capability bridge (`wordjs`).
exports.init = function (wordjs) {
    wordjs.shortcodes.add('hello', (attrs) => exports.renderHello(attrs));
    console.log('✅ Hello World plugin initialized: [hello] shortcode registered.');
};

// Called when the plugin is deactivated
exports.deactivate = function () {
    console.log('👋 Hello World plugin deactivated!');
};
