/**
 * WordJS - App Registry
 * Provides a way for plugins to access the Express app instance
 * for dynamic route registration
 */

let appInstance = null;

module.exports = {
    /**
     * Set the Express app instance (called from index.js)
     */
    setApp(app) {
        appInstance = app;
    },

    /**
     * Get the Express app instance
     * @returns {import('express').Express | null}
     */
    getApp() {
        return appInstance;
    }
};
