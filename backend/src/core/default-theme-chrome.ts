/**
 * The default theme's composed footer — the copy createDefaultTheme() (core/themes.ts) writes to
 * themes/default/chrome/footer.json when the admin restores the theme or the file is missing.
 *
 * It must match the shipped file exactly, like the embedded style.css next to it:
 * tests/default-theme-parity.test.ts compares the two and fails on any drift. Edit the shipped
 * file and this object together.
 */
const DEFAULT_THEME_FOOTER = {
    root: { props: {} },
    content: [
        {
            type: 'ChromeRow',
            props: {
                align: 'between',
                gap: 'lg',
                wrap: true,
                items: [
                    { type: 'ChromeSiteTitle', props: { showTagline: true } },
                    { type: 'ChromeNav', props: { location: 'footer', orientation: 'vertical' } },
                    {
                        type: 'ChromeRow',
                        props: {
                            align: 'start',
                            gap: 'md',
                            wrap: true,
                            items: [
                                { type: 'ChromeText', props: { text: "Pages that move, plugins that can't take over." } },
                                { type: 'ChromeSocials', props: { source: 'settings' } },
                            ],
                        },
                    },
                ],
            },
        },
        {
            type: 'ChromeRow',
            props: {
                align: 'center',
                gap: 'sm',
                wrap: true,
                items: [
                    { type: 'ChromeText', props: { text: 'Built with WordJS — the open-source CMS.' } },
                ],
            },
        },
    ],
};

module.exports = { DEFAULT_THEME_FOOTER };
