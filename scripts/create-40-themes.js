const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const THEMES_DIR = path.resolve(__dirname, '../marketplace/themes');

// ── WordJS token-contract aliases ─────────────────────────────────────────────
// Derived deterministically from the theme's palette entry. wordjs-ui.css block
// defaults (forms, search, cards…) resolve through these, so every generated
// theme styles ALL blocks — present and future — in its own palette without
// per-block CSS. Mirrors the migration applied to the existing 40 themes.
const hex2rgb = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgb2hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(...A.map((v, i) => v + (B[i] - v) * t)); };
const lum = (h) => { const [r, g, b] = hex2rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
// Real WCAG luminance/contrast. `lum` stays as it was (other call sites depend on it); these are for
// the two decisions where the number has to be right rather than merely monotonic.
const relLum = (h) => { const c = hex2rgb(h).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
// Text on a fill: measured, not guessed at a 0.55 luma threshold. White on #ec4899 is 3.53:1.
const onColor = (h) => (contrast('#ffffff', h) >= contrast('#111111', h) ? '#ffffff' : '#111111');
// A link is TEXT on the page, not a fill: `primary` used raw gave link text at 1.72:1 on some
// palettes. Keep the hue, move the level until it clears AA. Mirrors readableOn() in
// backend/src/core/theme-derive.ts — the parity suite compares the two.
const readableOn = (colour, bg, min = 4.5) => {
    if (contrast(colour, bg) >= min) return colour;
    const toward = relLum(bg) > 0.5 ? '#000000' : '#ffffff';
    for (let t = 0.08; t <= 0.92; t += 0.08) {
        const c = mix(colour, toward, t);
        if (contrast(c, bg) >= min) return c;
    }
    return toward === '#000000' ? '#111111' : '#ffffff';
};

function canonicalAliases(t) {
    const dark = lum(t.bgColor) < 0.35;
    const toward = dark ? '#ffffff' : '#000000';
    return `/* ── WordJS token contract — canonical palette ─────────────────────────────
 * Derived from this theme's own generator colors. These aliases are what
 * wordjs-ui.css block defaults (forms, search, cards…) read; the archetype
 * rules below still own the distinctive look. */
:root {
  --wjs-bg-canvas: ${t.bgColor};
  --wjs-bg-surface: ${mix(t.bgColor, toward, dark ? 0.06 : 0.03)};
  --wjs-bg-surface-raised: ${mix(t.bgColor, toward, dark ? 0.11 : 0.06)};
  --wjs-color-primary: ${t.primaryColor};
  --wjs-color-primary-dark: ${t.secondaryColor};
  --wjs-color-on-primary: ${onColor(t.primaryColor)};
  --wjs-color-accent: ${t.secondaryColor};
  --wjs-color-on-accent: ${onColor(t.secondaryColor)};
  --wjs-color-text-main: ${t.textColor};
  --wjs-color-text-muted: ${mix(t.textColor, t.bgColor, 0.38)};
  --wjs-color-heading: ${t.textColor};
  --wjs-color-link: ${readableOn(t.primaryColor, t.bgColor)};
  --wjs-color-link-hover: ${readableOn(t.secondaryColor, t.bgColor)};
  --wjs-border-subtle: ${mix(t.textColor, t.bgColor, 0.82)};
  --wjs-outline: ${mix(t.textColor, t.bgColor, 0.62)};
  --wjs-outline-variant: ${mix(t.textColor, t.bgColor, 0.85)};
  --wjs-focus-ring: ${t.primaryColor};
}

`;
}

// Archetype CSS Generators for radically distinct visual styles
const ARCHETYPES = {
    // 1. Cyber / Gaming / Tech RGB (Angled clip-paths, scanlines, neon glow)
    cyber: (t) => `/* Theme: ${t.name} (Cyber Archetype) */
@import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=JetBrains+Mono:wght@400;700&display=swap');

:root {
    --cyber-primary: ${t.primaryColor};
    --cyber-secondary: ${t.secondaryColor};
    --cyber-bg: ${t.bgColor};
    --cyber-text: ${t.textColor};
}

body {
    background-color: var(--cyber-bg);
    color: var(--cyber-text);
    font-family: 'JetBrains Mono', monospace;
    background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 30px 30px;
    margin: 0;
    line-height: 1.5;
}

h1, h2, h3, .brand {
    font-family: 'Chakra Petch', sans-serif;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--cyber-primary);
    text-shadow: 0 0 10px var(--cyber-primary);
}

.theme-container {
    max-width: 1300px;
    margin: 0 auto;
    padding: 2rem;
}

.theme-hero {
    background: rgba(0,0,0,0.8);
    border: 2px solid var(--cyber-primary);
    box-shadow: 0 0 20px var(--cyber-primary);
    clip-path: polygon(0 0, calc(100% - 30px) 0, 100% 30px, 100% 100%, 30px 100%, 0 calc(100% - 30px));
    padding: 4rem 2rem;
    text-align: center;
    margin-bottom: 3rem;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 2rem;
}

.theme-card {
    background: #0d1117;
    border: 1px solid var(--cyber-secondary);
    clip-path: polygon(15px 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%, 0 15px);
    padding: 2rem;
    position: relative;
    transition: all 0.3s ease;
}

.theme-card:hover {
    border-color: var(--cyber-primary);
    box-shadow: 0 0 15px var(--cyber-primary);
    transform: translateY(-5px);
}

.theme-badge {
    background: var(--cyber-primary);
    color: #000;
    font-weight: bold;
    padding: 4px 10px;
    font-size: 0.75rem;
    display: inline-block;
    clip-path: polygon(5px 0, 100% 0, 95% 100%, 0 100%);
}

button.theme-btn {
    background: transparent;
    color: var(--cyber-primary);
    border: 2px solid var(--cyber-primary);
    padding: 12px 24px;
    font-family: 'Chakra Petch', sans-serif;
    font-weight: bold;
    cursor: pointer;
    clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
    transition: all 0.2s;
}

button.theme-btn:hover {
    background: var(--cyber-primary);
    color: #000;
    box-shadow: 0 0 15px var(--cyber-primary);
}
`,

    // 2. Brutalist / Neo-Brutalist (Hard black borders, stark offsets, mono fonts, zero border-radius)
    brutalist: (t) => `/* Theme: ${t.name} (Brutalist Archetype) */
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Public+Sans:wght@400;700&display=swap');

:root {
    --brutal-primary: ${t.primaryColor};
    --brutal-secondary: ${t.secondaryColor};
    --brutal-bg: ${t.bgColor};
    --brutal-text: ${t.textColor};
}

body {
    background-color: var(--brutal-bg);
    color: var(--brutal-text);
    font-family: 'Public Sans', sans-serif;
    margin: 0;
    padding: 0;
}

h1, h2, h3 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 3rem;
    text-transform: uppercase;
    letter-spacing: -1px;
    margin: 0 0 1rem 0;
}

.theme-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 3rem 1.5rem;
}

.theme-hero {
    background: var(--brutal-primary);
    color: #000;
    border: 4px solid #000;
    box-shadow: 8px 8px 0px #000;
    padding: 4rem 2rem;
    margin-bottom: 4rem;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2.5rem;
}

.theme-card {
    background: #ffffff;
    color: #000;
    border: 4px solid #000;
    box-shadow: 6px 6px 0px #000;
    padding: 2rem;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.theme-card:hover {
    transform: translate(-4px, -4px);
    box-shadow: 10px 10px 0px #000;
}

.theme-badge {
    background: var(--brutal-secondary);
    color: #fff;
    border: 2px solid #000;
    padding: 6px 12px;
    font-weight: 800;
    text-transform: uppercase;
    font-size: 0.8rem;
}

button.theme-btn {
    background: #000;
    color: #fff;
    border: 3px solid #000;
    box-shadow: 4px 4px 0px var(--brutal-primary);
    padding: 14px 28px;
    font-weight: 800;
    font-size: 1rem;
    cursor: pointer;
}

button.theme-btn:hover {
    background: var(--brutal-primary);
    color: #000;
}
`,

    // 3. Editorial / High Luxury Serif (Warm cream paper, Playfair Display fonts, gold borders, column layouts)
    editorial: (t) => `/* Theme: ${t.name} (Editorial Luxury Archetype) */
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,800;1,400&family=Lora:ital,wght@0,400;0,500;1,400&display=swap');

:root {
    --edit-primary: ${t.primaryColor};
    --edit-secondary: ${t.secondaryColor};
    --edit-bg: ${t.bgColor};
    --edit-text: ${t.textColor};
}

body {
    background-color: var(--edit-bg);
    color: var(--edit-text);
    font-family: 'Lora', serif;
    font-size: 1.1rem;
    line-height: 1.8;
    margin: 0;
}

h1, h2, h3 {
    font-family: 'Playfair Display', serif;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: var(--edit-primary);
}

.theme-container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 4rem 2rem;
}

.theme-hero {
    border-top: 3px double var(--edit-primary);
    border-bottom: 1px solid var(--edit-secondary);
    padding: 5rem 1rem;
    text-align: center;
    margin-bottom: 4rem;
}

.theme-hero h1 {
    font-size: 4rem;
    font-style: italic;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 3rem;
}

.theme-card {
    border-left: 2px solid var(--edit-primary);
    padding-left: 1.5rem;
    transition: border-color 0.3s ease;
}

.theme-card:hover {
    border-left-color: var(--edit-secondary);
}

.theme-badge {
    font-family: 'Playfair Display', serif;
    font-style: italic;
    color: var(--edit-secondary);
    font-size: 0.9rem;
    border-bottom: 1px solid var(--edit-secondary);
}

button.theme-btn {
    background: transparent;
    color: var(--edit-primary);
    border: 1px solid var(--edit-primary);
    padding: 10px 24px;
    font-family: 'Playfair Display', serif;
    font-style: italic;
    cursor: pointer;
    transition: all 0.3s ease;
}

button.theme-btn:hover {
    background: var(--edit-primary);
    color: var(--edit-bg);
}
`,

    // 4. Glassmorphism / Modern SaaS Aurora (Glowing blur cards, pill badges, gradient text)
    glassmorphism: (t) => `/* Theme: ${t.name} (Glassmorphism Aurora Archetype) */
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap');

:root {
    --glass-primary: ${t.primaryColor};
    --glass-secondary: ${t.secondaryColor};
    --glass-bg: ${t.bgColor};
    --glass-text: ${t.textColor};
}

body {
    background-color: var(--glass-bg);
    color: var(--glass-text);
    font-family: 'Plus Jakarta Sans', sans-serif;
    margin: 0;
    background-image: radial-gradient(at 10% 10%, var(--glass-primary) 0px, transparent 50%),
                      radial-gradient(at 90% 90%, var(--glass-secondary) 0px, transparent 50%);
    background-attachment: fixed;
}

h1, h2, h3 {
    font-weight: 800;
    letter-spacing: -0.03em;
}

.theme-container {
    max-width: 1240px;
    margin: 0 auto;
    padding: 3rem 2rem;
}

.theme-hero {
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 24px;
    padding: 5rem 2rem;
    text-align: center;
    box-shadow: 0 30px 60px rgba(0,0,0,0.3);
    margin-bottom: 3rem;
}

.theme-hero h1 {
    font-size: 3.8rem;
    background: linear-gradient(135deg, #ffffff 0%, var(--glass-primary) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 2rem;
}

.theme-card {
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    padding: 2rem;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.theme-card:hover {
    transform: translateY(-6px);
    border-color: var(--glass-primary);
    box-shadow: 0 20px 40px rgba(0,0,0,0.4);
}

.theme-badge {
    background: rgba(255, 255, 255, 0.1);
    color: var(--glass-primary);
    border: 1px solid var(--glass-primary);
    border-radius: 9999px;
    padding: 4px 14px;
    font-size: 0.75rem;
    font-weight: 600;
}

button.theme-btn {
    background: linear-gradient(135deg, var(--glass-primary), var(--glass-secondary));
    color: #fff;
    border: none;
    border-radius: 9999px;
    padding: 12px 28px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 10px 25px rgba(0,0,0,0.3);
    transition: transform 0.2s, box-shadow 0.2s;
}

button.theme-btn:hover {
    transform: scale(1.04);
    box-shadow: 0 15px 30px rgba(0,0,0,0.4);
}
`,

    // 5. Organic / Soft Pastel Minimalist (Rounded 32px borders, soft shadows, warm natural tones)
    organic: (t) => `/* Theme: ${t.name} (Organic Pastel Archetype) */
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700&display=swap');

:root {
    --org-primary: ${t.primaryColor};
    --org-secondary: ${t.secondaryColor};
    --org-bg: ${t.bgColor};
    --org-text: ${t.textColor};
}

body {
    background-color: var(--org-bg);
    color: var(--org-text);
    font-family: 'Outfit', sans-serif;
    margin: 0;
    line-height: 1.6;
}

.theme-container {
    max-width: 1180px;
    margin: 0 auto;
    padding: 3rem 2rem;
}

.theme-hero {
    background: var(--org-secondary);
    border-radius: 36px;
    padding: 5rem 3rem;
    text-align: center;
    margin-bottom: 3rem;
}

.theme-hero h1 {
    font-size: 3.5rem;
    color: var(--org-primary);
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
}

.theme-card {
    background: rgba(255, 255, 255, 0.06);
    border-radius: 28px;
    padding: 2rem;
    box-shadow: 0 10px 30px rgba(0,0,0,0.05);
    transition: transform 0.3s ease;
}

.theme-card:hover {
    transform: translateY(-4px);
}

.theme-badge {
    background: var(--org-primary);
    color: #fff;
    border-radius: 20px;
    padding: 4px 12px;
    font-size: 0.8rem;
    font-weight: 500;
}

button.theme-btn {
    background: var(--org-primary);
    color: #fff;
    border: none;
    border-radius: 24px;
    padding: 12px 26px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
}
`,

    // 6. Dark Obsidian & Gold Luxury (Brushed metal dark backgrounds, gold foil badges, sleek layout)
    obsidian: (t) => `/* Theme: ${t.name} (Obsidian Luxury Archetype) */
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;800&family=Montserrat:wght@300;400;600&display=swap');

:root {
    --obs-primary: ${t.primaryColor};
    --obs-secondary: ${t.secondaryColor};
    --obs-bg: ${t.bgColor};
    --obs-text: ${t.textColor};
}

body {
    background-color: var(--obs-bg);
    color: var(--obs-text);
    font-family: 'Montserrat', sans-serif;
    margin: 0;
    letter-spacing: 0.5px;
}

h1, h2, h3 {
    font-family: 'Cinzel', serif;
    font-weight: 800;
    color: var(--obs-primary);
    text-transform: uppercase;
}

.theme-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 4rem 2rem;
}

.theme-hero {
    background: linear-gradient(180deg, #111111 0%, #050505 100%);
    border: 1px solid var(--obs-primary);
    border-radius: 4px;
    padding: 6rem 2rem;
    text-align: center;
    margin-bottom: 4rem;
}

.theme-hero h1 {
    font-size: 3.5rem;
    letter-spacing: 4px;
}

.theme-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 2.5rem;
}

.theme-card {
    background: #0a0a0a;
    border: 1px solid #222222;
    padding: 2.5rem;
    transition: all 0.4s ease;
}

.theme-card:hover {
    border-color: var(--obs-primary);
    box-shadow: 0 0 25px rgba(234, 179, 8, 0.15);
}

.theme-badge {
    color: var(--obs-primary);
    border-bottom: 1px solid var(--obs-primary);
    font-size: 0.75rem;
    letter-spacing: 2px;
    text-transform: uppercase;
}

button.theme-btn {
    background: linear-gradient(135deg, var(--obs-primary), var(--obs-secondary));
    color: #000000;
    border: none;
    padding: 14px 32px;
    font-family: 'Cinzel', serif;
    font-weight: 800;
    letter-spacing: 2px;
    cursor: pointer;
    transition: opacity 0.2s;
}

button.theme-btn:hover {
    opacity: 0.9;
}
`
};

const themes = [
    // 💼 Corporate & SaaS (1-10)
    { slug: 'apex-enterprise', name: 'Apex Enterprise', description: 'Corporate SaaS template with glassmorphism cards, glowing metrics, and dark mode hero banners.', author: 'WordJS Premium Studio', category: 'Corporate', primaryColor: '#6366f1', secondaryColor: '#4f46e5', bgColor: '#0f172a', textColor: '#f8fafc', archetype: 'glassmorphism' },
    { slug: 'nexus-cloud', name: 'Nexus Cloud', description: 'Clean tech & cloud infrastructure theme with futuristic grid lines and interactive code preview styling.', author: 'WordJS Premium Studio', category: 'Tech', primaryColor: '#0ea5e9', secondaryColor: '#0284c7', bgColor: '#090d16', textColor: '#f0f9ff', archetype: 'cyber' },
    { slug: 'quantum-fintech', name: 'Quantum Fintech', description: 'Sleek obsidian & gold theme designed for financial technologies, crypto platforms, and hedge funds.', author: 'WordJS Premium Studio', category: 'Finance', primaryColor: '#eab308', secondaryColor: '#ca8a04', bgColor: '#0c0a09', textColor: '#fef08a', archetype: 'obsidian' },
    { slug: 'velocity-agency', name: 'Velocity Agency', description: 'High-converting agency theme featuring bold typography, dynamic hover cards, and marquee tickers.', author: 'WordJS Premium Studio', category: 'Agency', primaryColor: '#f43f5e', secondaryColor: '#e11d48', bgColor: '#18181b', textColor: '#fff1f2', archetype: 'brutalist' },
    { slug: 'synergy-workspace', name: 'Synergy Workspace', description: 'Clean, minimalist B2B SaaS theme with subtle border gradients and tabbed feature showcases.', author: 'WordJS Premium Studio', category: 'Corporate', primaryColor: '#10b981', secondaryColor: '#059669', bgColor: '#064e3b', textColor: '#ecfdf5', archetype: 'glassmorphism' },
    { slug: 'vanguard-consulting', name: 'Vanguard Consulting', description: 'Executive advisory theme with serif headers, rich navy palette, and elegant testimonial carousels.', author: 'WordJS Premium Studio', category: 'Corporate', primaryColor: '#1e3a8a', secondaryColor: '#1d4ed8', bgColor: '#0f172a', textColor: '#eff6ff', archetype: 'editorial' },
    { slug: 'hyperion-ai', name: 'Hyperion AI', description: 'AI & Machine Learning theme with cyan/purple aurora glows, neural network background motifs, and prompt cards.', author: 'WordJS Premium Studio', category: 'Tech', primaryColor: '#a855f7', secondaryColor: '#9333ea', bgColor: '#130e2a', textColor: '#faf5ff', archetype: 'cyber' },
    { slug: 'strata-venture', name: 'Strata Venture', description: 'Venture capital & startup accelerator theme with sleek timeline views and dealflow portfolio grids.', author: 'WordJS Premium Studio', category: 'Finance', primaryColor: '#3b82f6', secondaryColor: '#2563eb', bgColor: '#0b1329', textColor: '#f0f6ff', archetype: 'glassmorphism' },
    { slug: 'omni-stack', name: 'Omni Stack', description: 'Modern developer-first documentation and product landing page with syntax-highlighted code cards.', author: 'WordJS Premium Studio', category: 'Tech', primaryColor: '#14b8a6', secondaryColor: '#0d9488', bgColor: '#042f2e', textColor: '#ccfbf1', archetype: 'cyber' },
    { slug: 'zenith-holdings', name: 'Zenith Holdings', description: 'Ultra-luxury private equity theme with deep emerald green, warm cream, and gold accents.', author: 'WordJS Premium Studio', category: 'Finance', primaryColor: '#047857', secondaryColor: '#065f46', bgColor: '#022c22', textColor: '#d1fae5', archetype: 'obsidian' },

    // 🎨 Creative & Portfolio (11-20)
    { slug: 'prism-studio', name: 'Prism Studio', description: 'Creative agency portfolio with dynamic color shifts, kinetic typography, and masonry image galleries.', author: 'WordJS Premium Studio', category: 'Portfolio', primaryColor: '#ec4899', secondaryColor: '#db2777', bgColor: '#111827', textColor: '#fdf2f8', archetype: 'glassmorphism' },
    { slug: 'monochrome-gallery', name: 'Monochrome Gallery', description: 'Minimalist black & white photography portfolio with high-contrast typography and fullscreen viewports.', author: 'WordJS Premium Studio', category: 'Portfolio', primaryColor: '#ffffff', secondaryColor: '#a1a1aa', bgColor: '#000000', textColor: '#ffffff', archetype: 'brutalist' },
    { slug: 'chroma-visuals', name: 'Chroma Visuals', description: 'Vibrant 3D digital artist portfolio featuring dark mode neon accents and video background frames.', author: 'WordJS Premium Studio', category: 'Creative', primaryColor: '#8b5cf6', secondaryColor: '#7c3aed', bgColor: '#090514', textColor: '#f5f3ff', archetype: 'cyber' },
    { slug: 'atelier-design', name: 'Atelier Design', description: 'European architectural design studio theme with grid overlays, editorial typography, and floating caption boxes.', author: 'WordJS Premium Studio', category: 'Creative', primaryColor: '#78716c', secondaryColor: '#57534e', bgColor: '#1c1917', textColor: '#f5f5f4', archetype: 'editorial' },
    { slug: 'kinetic-motion', name: 'Kinetic Motion', description: 'Animator and video producer portfolio with dark cinematic tone, video reels, and custom play controls.', author: 'WordJS Premium Studio', category: 'Creative', primaryColor: '#ef4444', secondaryColor: '#dc2626', bgColor: '#0a0a0a', textColor: '#fef2f2', archetype: 'brutalist' },
    { slug: 'velvet-fashion', name: 'Velvet Fashion', description: 'High-fashion lookbook theme with tall aspect ratios, subtle page slide transitions, and serif titles.', author: 'WordJS Premium Studio', category: 'Fashion', primaryColor: '#f472b6', secondaryColor: '#e11d48', bgColor: '#12050a', textColor: '#fff1f2', archetype: 'editorial' },
    { slug: 'artisan-craft', name: 'Artisan Craft', description: 'Fine art & studio pottery theme featuring organic stone textures, warm earth tones, and story-driven layouts.', author: 'WordJS Premium Studio', category: 'Craft', primaryColor: '#d97706', secondaryColor: '#b45309', bgColor: '#1c130b', textColor: '#fef3c7', archetype: 'organic' },
    { slug: 'hologram-3d', name: 'Hologram 3D', description: 'Interactive 3D web graphics portfolio with dark ambient glows and floating card physics.', author: 'WordJS Premium Studio', category: 'Creative', primaryColor: '#06b6d4', secondaryColor: '#0891b2', bgColor: '#04151f', textColor: '#cffaff', archetype: 'cyber' },
    { slug: 'editorial-vogue', name: 'Editorial Vogue', description: 'Luxury magazine theme with drop caps, multi-column editorial spreads, and quote highlights.', author: 'WordJS Premium Studio', category: 'Editorial', primaryColor: '#fb7185', secondaryColor: '#e11d48', bgColor: '#17080c', textColor: '#ffe4e6', archetype: 'editorial' },
    { slug: 'minimal-canvas', name: 'Minimal Canvas', description: 'Ultra-clean Scandinavian design portfolio with spacious white space and sharp micro-interactions.', author: 'WordJS Premium Studio', category: 'Portfolio', primaryColor: '#64748b', secondaryColor: '#475569', bgColor: '#0f172a', textColor: '#f8fafc', archetype: 'organic' },

    // 🛍️ E-Commerce & Luxury Retail (21-30)
    { slug: 'luxe-boutique', name: 'Luxe Boutique', description: 'Premium fashion boutique e-commerce theme with gold accents, sticky quick-view bar, and size guide drawer.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#fbbf24', secondaryColor: '#d97706', bgColor: '#181204', textColor: '#fef3c7', archetype: 'obsidian' },
    { slug: 'chronos-watches', name: 'Chronos Watches', description: 'Ultra-luxury timepiece storefront featuring dark brushed metal aesthetics and 360 showcase cards.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#94a3b8', secondaryColor: '#64748b', bgColor: '#0b0f19', textColor: '#f1f5f9', archetype: 'obsidian' },
    { slug: 'sole-vault', name: 'Sole Vault', description: 'Hypebeast & sneaker marketplace theme with bold street-style typography, countdown drop banners, and filter drawers.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#f97316', secondaryColor: '#ea580c', bgColor: '#140902', textColor: '#ffedd5', archetype: 'brutalist' },
    { slug: 'botanica-organics', name: 'Botanica Organics', description: 'Clean skincare & wellness e-commerce theme with pastel sage hues, ingredient highlight badges, and eco labels.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#34d399', secondaryColor: '#059669', bgColor: '#022319', textColor: '#d1fae5', archetype: 'organic' },
    { slug: 'gourmet-cellar', name: 'Gourmet Cellar', description: 'Fine wine & artisan spirits storefront theme with deep burgundy palette and vintage typography.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#9f1239', secondaryColor: '#881337', bgColor: '#1a040a', textColor: '#ffe4e6', archetype: 'editorial' },
    { slug: 'cyber-hardware', name: 'Cyber Hardware', description: 'Gaming hardware & peripheral shop theme with RGB neon glow effects and spec comparison tables.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#22c55e', secondaryColor: '#16a34a', bgColor: '#031409', textColor: '#dcfce7', archetype: 'cyber' },
    { slug: 'haute-jewelry', name: 'Haute Jewelry', description: 'Luxury jewelry & diamond studio with dark slate background, sparkling particle effects, and appointment drawer.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#38bdf8', secondaryColor: '#0284c7', bgColor: '#06131d', textColor: '#e0f2fe', archetype: 'obsidian' },
    { slug: 'nordic-living', name: 'Nordic Living', description: 'Minimalist Scandinavian home decor shop with natural wood tones, sticky cart drawer, and lookbooks.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#a8a29e', secondaryColor: '#78716c', bgColor: '#1c1917', textColor: '#f5f5f4', archetype: 'organic' },
    { slug: 'audio-phile', name: 'Audio Phile', description: 'High-end audiophile acoustic gear storefront with dark matte finish, frequency curve widgets, and star reviews.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#f43f5e', secondaryColor: '#e11d48', bgColor: '#140306', textColor: '#ffe4e6', archetype: 'cyber' },
    { slug: 'patisserie-delight', name: 'Patisserie Delight', description: 'Artisanal bakery & confectionery theme with warm pastel colors, custom order forms, and gallery grids.', author: 'WordJS Premium Studio', category: 'Commerce', primaryColor: '#f472b6', secondaryColor: '#db2777', bgColor: '#1f0914', textColor: '#fdf2f8', archetype: 'organic' },

    // 📰 Media, News & Content Platforms (31-40)
    { slug: 'metro-journal', name: 'Metro Journal', description: 'High-density digital newspaper theme with ticker bars, trending widgets, and multi-column article grids.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#ef4444', secondaryColor: '#b91c1c', bgColor: '#0f0f0f', textColor: '#ffffff', archetype: 'brutalist' },
    { slug: 'silicon-digest', name: 'Silicon Digest', description: 'Tech news & startup blog theme with dark mode toggle, reading progress indicators, and code snippet blocks.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#3b82f6', secondaryColor: '#1d4ed8', bgColor: '#0a0f1d', textColor: '#eff6ff', archetype: 'glassmorphism' },
    { slug: 'gourmet-epicure', name: 'Gourmet Epicure', description: 'Culinary magazine & recipe blog theme with nutrition info cards, print recipe buttons, and step-by-step galleries.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#eab308', secondaryColor: '#ca8a04', bgColor: '#1c1604', textColor: '#fef9c3', archetype: 'editorial' },
    { slug: 'wanderlust-journal', name: 'Wanderlust Journal', description: 'Travel & adventure blog theme with immersive map cards, location tags, and photo narrative layouts.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#14b8a6', secondaryColor: '#0f766e', bgColor: '#041f1e', textColor: '#ccfbf1', archetype: 'organic' },
    { slug: 'podcast-pulse', name: 'Podcast Pulse', description: 'Media & podcasting platform theme with embedded audio wave players, episode playlists, and transcripts.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#a855f7', secondaryColor: '#7e22ce', bgColor: '#160926', textColor: '#f3e8ff', archetype: 'glassmorphism' },
    { slug: 'horizon-opinion', name: 'Horizon Opinion', description: 'Thought leadership & essay publication theme with focused reader mode, clean serif body fonts, and subscribe cards.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#6366f1', secondaryColor: '#4338ca', bgColor: '#0c0e1a', textColor: '#e0e7ff', archetype: 'editorial' },
    { slug: 'crypto-chronicle', name: 'Crypto Chronicle', description: 'Web3, blockchain, and finance news portal with live market price ticker styling and multi-category tabs.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#10b981', secondaryColor: '#047857', bgColor: '#041c14', textColor: '#d1fae5', archetype: 'cyber' },
    { slug: 'esports-arena', name: 'Esports Arena', description: 'Gaming news & tournament portal with dark neon theme, team roster cards, and live stream embed containers.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#f97316', secondaryColor: '#c2410c', bgColor: '#1a0b02', textColor: '#ffedd5', archetype: 'cyber' },
    { slug: 'wellness-mind', name: 'Wellness Mind', description: 'Health, yoga, and mindfulness publication with calming gradient palette, daily quote widgets, and audio embeds.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#06b6d4', secondaryColor: '#0e7490', bgColor: '#031b21', textColor: '#cffaff', archetype: 'organic' },
    { slug: 'cinema-reel', name: 'Cinema Reel', description: 'Movie reviews, film criticism, and entertainment portal with dark theater background, rating meters, and trailer modals.', author: 'WordJS Premium Studio', category: 'Media', primaryColor: '#e11d48', secondaryColor: '#9f1239', bgColor: '#170308', textColor: '#ffe4e6', archetype: 'obsidian' }
];

// CLI behavior only when executed directly — core (backend/src/core/theme-derive.ts and
// its parity tests) requires this file as a module for the helpers below without
// regenerating the marketplace catalog.
//
// The catalog is emitted in the HYBRID declarative format: theme.json carries the
// compiler contract (generator/seeds/archetype) and style.css = manual CSS (theme header
// + the Google Fonts @imports each archetype has always shipped, now in the spec-valid
// position before any rule) followed by the @wjs-generated block that theme-compile
// produces from theme.json. deriveTokens() has byte parity with canonicalAliases() and
// the compiler appends the archetype CSS verbatim, so the rendered catalog is unchanged.
// Font vendoring is a separate program — the @import stays manual ON PURPOSE (the theme
// doctor reports it as EXTERNAL_REF, which is honest).
if (require.main === module) {
    // Prefer the compiled build (what prod runs); fall back to transpiling src via ts-node.
    const BACKEND_DIR = path.join(__dirname, '../backend');
    const MANIFEST_PATH = path.join(BACKEND_DIR, 'public', 'theme-tokens.json');
    const distCompile = path.join(BACKEND_DIR, 'dist', 'core', 'theme-compile.js');
    let themeCompile;
    if (fs.existsSync(distCompile)) {
        themeCompile = require(distCompile);
    } else {
        require('ts-node').register({ project: path.join(BACKEND_DIR, 'tsconfig.json'), transpileOnly: true });
        themeCompile = require(path.join(BACKEND_DIR, 'src', 'core', 'theme-compile.ts'));
    }
    const { compileTheme, writeCompiled } = themeCompile;

    console.log(`Generating ${themes.length} Distinct Ultra-Premium Themes (hybrid declarative format)...`);

    for (const t of themes) {
        const dir = path.join(THEMES_DIR, t.slug);
        fs.mkdirSync(dir, { recursive: true });

        // 1. theme.json — the entry's palette becomes compiler seeds. Patch-bump against
        // whatever version the catalog already carries (fresh checkout → 1.0.0) and keep
        // any layout key the theme may have gained since generation.
        let version = '1.0.0';
        let layout;
        try {
            const prev = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));
            const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(prev.version || ''));
            if (m) version = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
            if (prev.layout !== undefined) layout = prev.layout;
        } catch { /* no previous theme.json — first generation */ }

        const themeJson = {
            name: t.name,
            version,
            description: t.description,
            author: t.author,
            category: t.category,
            generator: "wordjs",
            seeds: { primary: t.primaryColor, secondary: t.secondaryColor, bg: t.bgColor, text: t.textColor },
            archetype: t.archetype,
            tags: ["premium", t.category.toLowerCase(), t.archetype, "responsive"]
        };
        if (layout !== undefined) themeJson.layout = layout;
        fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(themeJson, null, 2));

        // 2. style.css — manual CSS first (the archetype's own header comment + the
        // @import lines it has always emitted), then an empty marker pair for the
        // compiler to fill. theme-compile never emits @import (core CSS must not reach
        // the network), so the fonts live OUTSIDE the markers and survive recompiles.
        const archetypeSrc = (ARCHETYPES[t.archetype] || ARCHETYPES.glassmorphism)(t);
        const headerComment = archetypeSrc.split('\n', 1)[0];
        const fontImports = archetypeSrc.match(/^@import .*$/gm) || [];
        fs.writeFileSync(
            path.join(dir, 'style.css'),
            `${headerComment}\n${fontImports.join('\n')}\n\n/* @wjs-generated:start */\n/* @wjs-generated:end */\n`
        );

        // dryRun first (diagnose without touching the file), then swap only the marked
        // block — same sequence as backend/cli/wordjs.js build theme.
        const result = compileTheme(dir, { slug: t.slug, manifestPath: MANIFEST_PATH, dryRun: true });
        for (const d of result.diagnostics) {
            console.error(`  ${d.level === 'error' ? '❌' : '⚠️'} [${d.code}] ${t.slug} ${d.path}: ${d.message}`);
        }
        if (result.stats.errors > 0) {
            console.error(`❌ ${t.slug}: compile failed with ${result.stats.errors} error(s) — catalog left half-regenerated, fix and re-run.`);
            process.exit(1);
        }
        writeCompiled(dir, result.css);

        // 3. functions.js
        const js = `/**
 * ${t.name} Theme Hooks & Dynamic Functions (${t.archetype.toUpperCase()} Archetype)
 */

module.exports = function registerThemeHooks(wp) {
    console.log('[Theme: ${t.name}] (${t.archetype}) Registered successfully.');
};
`;
        fs.writeFileSync(path.join(dir, 'functions.js'), js);
    }

    console.log('✅ Successfully generated 40 radically distinct premium themes!');

    // Rebuild marketplace catalog
    console.log('Building Marketplace Dist Catalog...');
    const res = spawnSync(process.execPath, [path.join(__dirname, '../backend/scripts/build-marketplace.js')], {
        encoding: 'utf8'
    });
    console.log(res.stdout || '');
    if (res.stderr) console.error(res.stderr);

    console.log('✅ Marketplace Catalog Build Finished!');
}

module.exports = { hex2rgb, rgb2hex, mix, lum, onColor, canonicalAliases, ARCHETYPES, themes };
