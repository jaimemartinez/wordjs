/**
 * WordJS Plugin: Social Share
 *
 * Share buttons for the current page — WordPress parity with AddToAny / Shareaholic / Monarch.
 *
 * Everything happens client-side inside the Puck block "SocialShare" (share intents are plain
 * URLs opened with window.open; copy-link uses the Clipboard API). The backend therefore has
 * nothing to do beyond registering the admin menu entry: no database, no options, no routes,
 * no grants. The admin page is a static usage guide with a visual preview of the buttons.
 */

exports.metadata = {
    name: 'Social Share',
    version: '1.0.2',
    description: 'Botones para compartir la página actual (Facebook, X, WhatsApp, LinkedIn, Telegram, Email, Copiar enlace) vía el bloque "SocialShare"',
    author: 'WordJS',
};

exports.init = async function (wordjs) {
    const { adminMenu } = wordjs;

    await adminMenu.add({
        href: '/admin/plugin/share',
        label: 'Compartir Social',
        // Shown in the admin's language (sidebar); `label` stays for cores without per-language labels.
        labels: { en: 'Social Share', es: 'Compartir en redes', pt: 'Compartilhar' },
        icon: 'fa-share-nodes',
        order: 61,
        cap: 'manage_options',
    });

    console.log('[social-share] plugin initialized');
};

exports.deactivate = function () {
    // Nothing to tear down — the plugin registers no routes, timers or servers.
};
