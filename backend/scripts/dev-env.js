/**
 * Dev preload: force NODE_ENV=development for the split-mode backend dev server.
 *
 * config/app.ts now fail-safes nodeEnv to 'production' (so a misconfigured deploy never accidentally
 * runs in the relaxed development mode). The split-mode dev script (`npm run dev` -> node --watch
 * src/index.ts) sets no environment, so without this preload the dev backend would boot in production
 * mode and reject the localhost frontend's credentialed CORS requests. Preloaded via `node -r` so it
 * runs before config/app.ts is evaluated. Does not override an explicit NODE_ENV the operator set.
 */
if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
}
