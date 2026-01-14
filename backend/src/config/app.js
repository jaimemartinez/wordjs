/**
 * WordJS - Application Configuration
 * Equivalent to wp-includes/default-constants.php
 */

require('dotenv').config();
const { getConfig } = require('../core/configManager');

// Load file-based config (if exists)
const fileConfig = getConfig() || {};

const config = {
  // Server settings
  port: parseInt(process.env.PORT || fileConfig.port, 10) || 4000,
  host: process.env.HOST || fileConfig.host || 'localhost',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  dbPath: process.env.DB_PATH || './data/wordjs.db',

  // JWT Authentication
  jwt: {
    secret: process.env.JWT_SECRET || 'wordjs-default-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  // Site settings
  site: {
    url: process.env.SITE_URL || fileConfig.siteUrl || `http://${process.env.HOST || fileConfig.host || 'localhost'}:${process.env.PORT || fileConfig.port || 3000}`,
    frontendUrl: process.env.FRONTEND_URL || fileConfig.frontendUrl || `http://${process.env.HOST || fileConfig.host || 'localhost'}:3001`,
    name: process.env.SITE_NAME || 'WordJS',
    description: process.env.SITE_DESCRIPTION || 'A WordPress-like CMS'
  },

  // Uploads
  uploads: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024 // 10MB
  },

  // API settings
  api: {
    prefix: '/api/v1',
    version: '1.0.0'
  },

  // User roles (equivalent to WordPress roles)
  roles: {
    administrator: {
      name: 'Administrator',
      capabilities: ['*', 'access_admin_panel'] // All capabilities + explicit dash access
    },
    editor: {
      name: 'Editor',
      capabilities: [
        'access_admin_panel',
        'edit_posts', 'edit_others_posts', 'publish_posts', 'delete_posts',
        'edit_pages', 'edit_others_pages', 'publish_pages', 'delete_pages',
        'manage_categories', 'moderate_comments', 'upload_files', 'edit_comments'
      ]
    },
    author: {
      name: 'Author',
      capabilities: [
        'access_admin_panel',
        'edit_posts', 'publish_posts', 'delete_posts', 'upload_files'
      ]
    },
    contributor: {
      name: 'Contributor',
      capabilities: ['access_admin_panel', 'edit_posts', 'delete_posts']
    },
    subscriber: {
      name: 'Subscriber',
      capabilities: ['read', 'access_admin_panel']
    }
  },

  // Post types (equivalent to register_post_type)
  postTypes: {
    post: {
      name: 'Posts',
      singular: 'Post',
      showInRest: true,
      supportsRevisions: true
    },
    page: {
      name: 'Pages',
      singular: 'Page',
      showInRest: true,
      hierarchical: true
    },
    attachment: {
      name: 'Media',
      singular: 'Media',
      showInRest: true
    }
  },

  // Post statuses
  postStatuses: ['publish', 'draft', 'pending', 'private', 'trash', 'auto-draft', 'inherit'],

  // Comment statuses
  commentStatuses: ['approved', 'pending', 'spam', 'trash']
};

module.exports = config;
