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
  // eslint-disable-next-line no-var
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
  }
}

export {};
