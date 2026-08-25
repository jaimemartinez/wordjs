/**
 * Global ambient type declarations for the WordJS backend.
 *
 * These keep the runtime's dynamic patterns (global.wordjs, augmented Express
 * Request) type-checkable without changing any behavior. Kept intentionally
 * loose during the JS->TS migration; tightened in the final strict pass.
 */

import 'express';

declare global {
  // Cron/scheduling API exposed to plugins via global.wordjs (set in src/index).
  var wordjs: {
    scheduleEvent?: (...args: any[]) => any;
    scheduleSingleEvent?: (...args: any[]) => any;
    unscheduleEvent?: (...args: any[]) => any;
    nextScheduled?: (...args: any[]) => any;
    [key: string]: any;
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    // Attached by auth middleware (src/middleware/auth). Loose during migration.
    user?: any;
    // Some routes attach the resolved plugin/permission context.
    pluginSlug?: string;

    // ─── The HEADLESS marks, stamped by markHeadless() in src/middleware/auth.ts ─────────────────
    //
    // These live HERE, not beside their writer, because they are read across routers: the
    // anti-persistence gates on /auth/tokens and /auth/mfa/*, on /webhooks, and the credential-class
    // branch in /collab all key off them. Each of those files used to name the field again locally
    // (`Request & { apiToken?: ... }`), and three hand-written copies of one runtime field cannot
    // disagree LOUDLY: every copy is a separate intersection over Request, never a redeclaration of
    // one property, so TypeScript never compares them. collab.ts had already drifted to `unknown`.
    //
    // Declared here, a copy that retypes the mark (say `apiToken?: boolean`, gated with `=== true`,
    // which would silently never fire against an object) becomes a compile error in TWO of the three
    // redeclaration forms: `interface X extends Request` (TS2430 — the form webhooks.ts used) and a
    // second module augmentation (TS2717). It does NOT in the third, `Request & { … }`: an
    // intersection builds a new type rather than redeclaring the property, so TypeScript never
    // compares them. Measured, not assumed. The source-level guard in
    // src/tests/http-request-marks.test.ts is what covers that remaining form.
    //
    // `apiToken` carries the machine token's identity and scopes; `isHeadless` is the boolean the
    // gates assert on. Optional because an interactive cookie session carries neither.
    apiToken?: { id: number; scopes: string[]; name: string };
    isHeadless?: boolean;
  }
}

export {};
