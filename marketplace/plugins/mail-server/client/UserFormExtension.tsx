// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the
// frontend tsc (react/deps resolve at bundle time, not in the frontend-only CI). Matches every other
// plugin's client components (card-gallery, photo-carousel, video-gallery).
"use client";

import React, { useState, useEffect } from 'react';
import { pluginHooks } from '../../../../frontend/src/lib/plugin-hooks';
import { api } from '../../../../frontend/src/lib/api';

/**
 * UserFormExtension — the "Professional Mail Account" toggle on the core User Form.
 *
 * THIS TOGGLE IS THE GRANT. It writes `formData.professionalMailbox`, which the admin-only user
 * routes (POST /api/v1/users, PUT /api/v1/users/:id — the latter requiring `edit_users`) persist as
 * `user_meta.professional_mailbox`. That stored flag is the ONE fact the whole mail surface is gated
 * on (backend/src/core/mailbox.ts, and hasCorporateMailbox in the plugin's index.js).
 *
 * It used to grant the mailbox purely as a SIDE EFFECT of rewriting the account email to
 * `<username>@<domain>`, because the gate derived "has a mailbox" from that address. That made the
 * grant self-issuable by any user through PUT /users/me, so the fact is now explicit and this
 * component states it explicitly. The email rewrite stays — the address is still what the mailbox
 * receives at — but it is a consequence of the grant, not the grant itself.
 */
// Module-level LIVE MIRROR of the currently-mounted form's toggle. It exists only so the email-input
// filter below (registered once at module load, so it can't read React state) can see the toggle. It
// is written by the mounted component's effect and is NOT used to seed any form's initial state — so
// toggle state no longer leaks across separate form instances.
let isAutoEmailActive = true;

const UserFormExtension = ({ data }: { data: any }) => {
    const { formData, setFormData, isNew } = data || {};
    // The MAIL domain (mail_security_dkim_domain || site hostname) as the server itself resolves it —
    // asked of the mail plugin rather than guessed from window.location.hostname, which is the ADMIN
    // UI's host and is simply a different name on any install with a `www.` site or a DKIM-domain
    // override. Generating an address on the wrong domain would provision a mailbox nothing delivers to.
    const [domain, setDomain] = useState('');

    useEffect(() => {
        let alive = true;
        (async () => {
            let resolved = '';
            try {
                const probe = await api('/plugin/mail-server/mailbox');
                resolved = String((probe && probe.siteDomain) || '');
            } catch {
                /* plugin route unavailable (inactive / offline) — fall back below */
            }
            if (!resolved && typeof window !== 'undefined') resolved = window.location.hostname;
            if (alive) setDomain(resolved.toLowerCase());
        })();
        return () => { alive = false; };
    }, []);

    // Guard every field this component dereferences so it renders safely when mail data is missing.
    const username = (formData?.username || '');
    const currentEmail = (formData?.email || '');

    // The toggle is CONTROLLED BY THE FORM's own data — the grant lives in `formData.professionalMailbox`
    // (seeded from the saved user by the core form), so what is on screen is what will be submitted.
    const autoEmail = !!formData?.professionalMailbox;

    // A NEW user defaults to having a mailbox provisioned, which is what this plugin's operators expect
    // from "add user" today. Still an explicit, admin-only grant: it is written into the form data, shown
    // in the toggle, and can be turned off before saving.
    useEffect(() => {
        if (isNew && formData && formData.professionalMailbox === undefined) {
            setFormData?.((prev: any) => ({ ...prev, professionalMailbox: true }));
        }
    }, [isNew, formData, setFormData]);

    // One-way live mirror into the module bridge consumed by the email-input filter. Overwritten by
    // whichever form is currently mounted, so it no longer carries state between form instances.
    useEffect(() => {
        isAutoEmailActive = autoEmail;
        pluginHooks.notify();
    }, [autoEmail]);

    // Keep the mailbox ADDRESS in step with the grant: while the toggle is on, the account email is the
    // corporate address `<username>@<mailDomain>`.
    useEffect(() => {
        if (autoEmail && username && domain) {
            const nextEmail = `${username.toLowerCase()}@${domain}`;
            if (currentEmail.toLowerCase() !== nextEmail) {
                setFormData?.((prev: any) => ({ ...prev, email: nextEmail }));
            }
        }
    }, [username, autoEmail, domain, setFormData, currentEmail]);

    const toggle = () => setFormData?.((prev: any) => ({ ...prev, professionalMailbox: !prev?.professionalMailbox }));

    return (
        <div className="flex items-center justify-between p-4 bg-purple-50 rounded-xl border border-purple-100 mb-2">
            <div>
                <h3 className="text-sm font-bold text-purple-900 uppercase tracking-tight">Professional Mail Account</h3>
                <p className="text-xs text-purple-600">
                    Give this user a mailbox <strong>@{domain || '…'}</strong> — they can then read and send mail from this server
                </p>
            </div>
            <button
                type="button"
                onClick={toggle}
                aria-pressed={autoEmail}
                className={`w-12 h-6 rounded-full transition-all relative ${autoEmail ? 'bg-purple-600 shadow-inner' : 'bg-gray-200'}`}
            >
                <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm ${autoEmail ? 'translate-x-6' : 'translate-x-0'}`}></div>
            </button>
        </div>
    );
};

// Register the hooks. The stable `key` (4th arg) makes this idempotent: if register() runs more than once
// (layout remount, StrictMode), the toggle/filter is REPLACED, not stacked — no more duplicate switches.
export const registerUserFormExtension = () => {
    // 1. Add the toggle UI
    pluginHooks.addAction('user_form_before_email', (data) => <UserFormExtension data={data} />, 10, 'mail-server:user-form-toggle');

    // 2. Filter the core email input properties
    pluginHooks.addFilter('user_form_email_input_props', (props = {}, _data = {}) => {
        if (!isAutoEmailActive) return props;

        return {
            ...props,
            readOnly: true,
            className: (props.className || '') + " bg-gray-100 text-gray-400 border-dashed cursor-not-allowed font-mono",
            placeholder: "Generated automatically..."
        };
    }, 10, 'mail-server:email-input-props');
};
