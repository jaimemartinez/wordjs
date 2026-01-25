const theme = `
  /* Fonts */
  @import url('https://fonts.googleapis.com/css2?family=Oswald:ital,wght@0,400;0,500;0,700;1,400;1,500;1,700&display=swap');
  @import url('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css');

  :root {
      --color-sidebar-bg: #0f172a;
      --color-brand-blue: #306E88;
      --color-brand-cyan: #00A9CE;
      --color-bg-base: #f9fafb; /* gray-50 equivalent */
      --color-card-bg: #ffffff;
      --radius-card: 40px;
      --radius-badge: 12px;
      --shadow-premium: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
      --font-display: 'Oswald', sans-serif;
      --font-body: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }

  body {
      font-family: var(--font-body) !important;
      background-color: var(--color-bg-base) !important;
      color: #111827 !important; /* gray-900 */
      margin: 0;
      -webkit-font-smoothing: antialiased;
  }

  /* --- STRUCTURE --- */

  /* Topbar: Mimics Sidebar Style */
  .swagger-ui .topbar {
      background-color: var(--color-sidebar-bg) !important;
      padding: 1rem 2rem !important;
      border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .swagger-ui .topbar .link { display: none; }
  .swagger-ui .topbar-wrapper { justify-content: flex-start; }
  .swagger-ui .topbar-wrapper::before {
      content: 'WordJS Docs';
      font-family: var(--font-display);
      font-weight: 900;
      font-style: italic;
      font-size: 24px;
      color: #fff;
      letter-spacing: -0.05em;
      padding-left: 10px;
  }

  /* Main Wrapper */
  .swagger-ui .wrapper {
      max-width: 1400px !important;
      margin: 0 auto;
      padding: 40px 20px;
  }

  /* Info Section (The "Header" Card) */
  .swagger-ui .info {
      background: #fff;
      border-radius: var(--radius-card);
      padding: 40px !important;
      border: 2px solid #f9fafb; /* border-gray-50 */
      box-shadow: var(--shadow-premium);
      margin-bottom: 40px !important;
  }
  .swagger-ui .info .title {
      font-family: var(--font-display) !important;
      font-weight: 900 !important;
      font-style: italic;
      letter-spacing: -0.05em !important;
      font-size: 48px !important;
      color: #111827 !important;
  }
  .swagger-ui .info .title small {
      background: var(--color-brand-blue) !important;
      border-radius: 20px !important;
      padding: 4px 12px !important;
      font-family: var(--font-body) !important;
      font-weight: 700 !important;
      font-size: 12px !important;
      letter-spacing: 0.1em !important;
      text-transform: uppercase;
      top: -10px !important;
  }
  .swagger-ui .info p {
      font-size: 16px !important;
      color: #4b5563 !important; /* gray-600 */
      line-height: 1.6;
      max-width: 800px;
  }

  /* Schemes (HTTP/HTTPS) */
  .swagger-ui .scheme-container {
      background: transparent !important;
      box-shadow: none !important;
      padding: 0 !important;
      margin-bottom: 20px !important;
  }

  /* --- OPERATIONS (Endpoints) --- */

  /* Operation Block (The Card) */
  .swagger-ui .opblock {
      background: #fff !important;
      border: 2px solid #f9fafb !important; /* border-gray-50 */
      border-radius: 32px !important;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05) !important;
      margin-bottom: 24px !important;
      overflow: hidden;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .swagger-ui .opblock:hover {
      box-shadow: var(--shadow-premium) !important;
      transform: translateY(-2px);
      border-color: #e5e7eb !important;
  }
  .swagger-ui .opblock.is-open {
      box-shadow: var(--shadow-premium) !important;
  }

  /* Summary Row */
  .swagger-ui .opblock .opblock-summary {
      padding: 20px 24px !important;
      border-bottom: 1px solid transparent;
  }
  .swagger-ui .opblock.is-open .opblock-summary {
      border-bottom: 1px solid #f3f4f6 !important;
  }

  /* Method Badge */
  .swagger-ui .opblock .opblock-summary-method {
      border-radius: 12px !important;
      font-family: var(--font-display) !important;
      font-weight: 800 !important;
      font-style: italic;
      min-width: 90px !important;
      padding: 8px 0 !important;
      text-shadow: none !important;
  }
  /* Color Overrides for Badges */
  .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #2563eb !important; } /* blue-600 */
  .swagger-ui .opblock.opblock-get .opblock-summary-method { background: var(--color-brand-cyan) !important; }
  .swagger-ui .opblock.opblock-put .opblock-summary-method { background: #f59e0b !important; } /* amber-500 */
  .swagger-ui .opblock.opblock-delete .opblock-summary-method { background: #ef4444 !important; } /* red-500 */

  /* Path */
  .swagger-ui .opblock .opblock-summary-path {
      font-family: var(--font-body) !important;
      font-weight: 600 !important;
      color: #374151 !important; /* gray-700 */
      font-size: 16px !important;
  }
  .swagger-ui .opblock .opblock-summary-description {
      color: #9ca3af !important; /* gray-400 */
      font-weight: 500;
  }

  /* Authorize Button */
  .swagger-ui .btn.authorize {
      color: var(--color-brand-blue) !important;
      border: 2px solid var(--color-brand-blue) !important;
      border-radius: 16px !important;
      font-family: var(--font-display) !important;
      font-weight: 800 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.05em !important;
      padding: 10px 24px !important;
      transition: all 0.2s;
  }
  .swagger-ui .btn.authorize:hover {
      background: var(--color-brand-blue) !important;
      color: #fff !important;
  }
  .swagger-ui .btn.authorize svg { fill: currentColor !important; }

  /* --- MODELS SECTION --- */
  .swagger-ui section.models {
      background: #fff !important;
      border-radius: var(--radius-card) !important;
      border: 2px solid #f9fafb !important;
      box-shadow: var(--shadow-premium) !important;
      padding: 40px !important;
      margin-top: 60px !important;
  }
  .swagger-ui section.models h4 {
      font-family: var(--font-display) !important;
      font-weight: 900 !important;
      font-style: italic;
      font-size: 32px !important;
      color: #111827 !important;
      border-bottom: none !important;
      margin-bottom: 30px !important;
  }
  .swagger-ui .model-box {
      border-radius: 20px !important;
      background: #f8fafc !important; /* slate-50 */
      padding: 24px !important;
  }
`;

module.exports = theme;
