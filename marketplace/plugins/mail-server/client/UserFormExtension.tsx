// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the
// frontend tsc (react/deps resolve at bundle time, not in the frontend-only CI). Matches every other
// plugin's client components (card-gallery, photo-carousel, video-gallery).
"use client";

import React, { useState, useEffect } from 'react';
import { pluginHooks } from '../../../../frontend/src/lib/plugin-hooks';
import { api } from '../../../../frontend/src/lib/api';

/**
 * UserFormExtension — keeps the mailbox ADDRESS in step with the mailbox GRANT on the core User Form.
 *
 * THE GRANT IS NOT HERE. "Professional mail account" is this plugin's account capability
 * `mail_server_mailbox`, declared in manifest.json `accountCapabilities`. The core user form renders its
 * toggle from that declaration (for `edit_users` administrators only), stores it and enforces it
 * (backend/src/core/account-capabilities.ts); the form state is `formData.accountCapabilities`, a map of
 * capability → on/off. hasCorporateMailbox in the plugin's index.js reads the same grant back.
 *
 * What remains here is the address: while the grant is on, the account email is the corporate address
 * `<username>@<mailDomain>` — the address the mailbox receives at — and the email input is read-only.
 */
const MAILBOX_CAPABILITY = 'mail_server_mailbox';

// Module-level LIVE MIRROR of the currently-mounted form's grant. It exists only so the email-input
// filter below (registered once at module load, so it can't read React state) can see it. It is written
// by the mounted component's effect and is NOT used to seed any form's initial state.
let isAutoEmailActive = false;

const UserFormExtension = ({ data }: { data: any }) => {
    const { formData, setFormData } = data || {};
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

    const username = (formData?.username || '');
    const currentEmail = (formData?.email || '');
    const granted = !!(formData?.accountCapabilities && formData.accountCapabilities[MAILBOX_CAPABILITY]);

    useEffect(() => {
        isAutoEmailActive = granted;
        pluginHooks.notify();
    }, [granted]);

    useEffect(() => {
        if (granted && username && domain) {
            const nextEmail = `${username.toLowerCase()}@${domain}`;
            if (currentEmail.toLowerCase() !== nextEmail) {
                setFormData?.((prev: any) => ({ ...prev, email: nextEmail }));
            }
        }
    }, [username, granted, domain, setFormData, currentEmail]);

    if (!granted) return null;
    return (
        <p className="text-xs text-purple-700 -mt-2 mb-2">
            Mailbox address: <strong className="font-mono">{username ? `${username.toLowerCase()}@${domain || '…'}` : `…@${domain || '…'}`}</strong>
        </p>
    );
};

// Register the hooks. The stable `key` (4th arg) makes this idempotent: if register() runs more than once
// (layout remount, StrictMode), the hook is REPLACED, not stacked.
export const registerUserFormExtension = () => {
    // 1. Keep the address in step with the grant
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
