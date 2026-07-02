/**
 * Platform-authored metadata for plugin permission tokens.
 *
 * A permission token is either "scope:access" (e.g. "database:write") or the scope-only
 * "network". This map mirrors the canonical KNOWN_PERMISSIONS list in
 * backend/src/core/plugins.ts. The `description` here is PLATFORM-authored plain language —
 * it explains what the capability grants the plugin, NOT the plugin's own self-declared reason
 * (which comes from its manifest and is shown separately). Risk drives the badge colour on the
 * grant screens so an admin can weigh a request at a glance.
 */

export type PermissionRisk = 'low' | 'med' | 'high';

export interface PermissionMeta {
    /** Neutral, human-readable name (never the plugin's own copy). */
    label: string;
    /** Platform-authored explanation of what granting this lets the plugin do. */
    description?: string;
    risk: PermissionRisk;
    /** Font Awesome class (e.g. "fa-database"). */
    icon?: string;
}

/**
 * Every KNOWN_PERMISSIONS token. Risk guidance: any write / network / filesystem write /
 * email:provider / database:write is HIGH; reads, route registration and menu registration are
 * LOW–MED. email:admin and settings:write also touch sensitive config → high.
 */
export const PERMISSION_META: Record<string, PermissionMeta> = {
    'database:read': {
        label: 'Read database',
        description: 'Query your site\'s content and settings tables. Cannot change data.',
        risk: 'low',
        icon: 'fa-database',
    },
    'database:write': {
        label: 'Write database',
        description: 'Insert, update or delete rows in your database. Can modify or destroy site data.',
        risk: 'high',
        icon: 'fa-database',
    },
    'filesystem:read': {
        label: 'Read files',
        description: 'Read files inside its sandboxed plugin directory.',
        risk: 'med',
        icon: 'fa-folder-open',
    },
    'filesystem:write': {
        label: 'Write files',
        description: 'Create or overwrite files inside its sandboxed plugin directory.',
        risk: 'high',
        icon: 'fa-folder-open',
    },
    'settings:read': {
        label: 'Read settings',
        description: 'Read site options and configuration values.',
        risk: 'low',
        icon: 'fa-sliders-h',
    },
    'settings:write': {
        label: 'Change settings',
        description: 'Modify site options and configuration. Can alter how your site behaves.',
        risk: 'high',
        icon: 'fa-sliders-h',
    },
    'users:read': {
        label: 'Read users',
        description: 'See a limited projection of user accounts (no passwords or secrets).',
        risk: 'med',
        icon: 'fa-users',
    },
    'email:admin': {
        label: 'Manage email',
        description: 'Configure and administer the email/mail-server subsystem.',
        risk: 'high',
        icon: 'fa-envelope',
    },
    'email:provider': {
        label: 'Send email as provider',
        description: 'Act as the site\'s outbound email provider — it can send mail on your behalf.',
        risk: 'high',
        icon: 'fa-paper-plane',
    },
    'notifications:send': {
        label: 'Send notifications',
        description: 'Emit in-app notifications to admins.',
        risk: 'med',
        icon: 'fa-bell',
    },
    'notifications:provider': {
        label: 'Notifications provider',
        description: 'Act as the site\'s notification delivery backend.',
        risk: 'high',
        icon: 'fa-bell',
    },
    'express:register_route': {
        label: 'Register API routes',
        description: 'Add its own HTTP endpoints under the API. Runs in the plugin sandbox.',
        risk: 'low',
        icon: 'fa-route',
    },
    'admin_menu:register': {
        label: 'Add admin menu',
        description: 'Add its own item(s) to the admin sidebar.',
        risk: 'low',
        icon: 'fa-bars',
    },
    'network': {
        label: 'Outbound network',
        description: 'Make outbound network calls (fetch / raw sockets). This is an exfiltration risk — data can leave your server. Grant only if you trust this plugin.',
        risk: 'high',
        icon: 'fa-globe',
    },
};

/**
 * Look up platform metadata for a permission token, falling back to a neutral med-risk entry so
 * an unrecognised token still renders sensibly rather than crashing the grant screen.
 */
export function permMeta(token: string): PermissionMeta {
    return PERMISSION_META[token] || { label: token, risk: 'med' };
}
