// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the
// frontend tsc (react/deps resolve at bundle time, not in the frontend-only CI). Matches every other
// plugin's client components (card-gallery, photo-carousel, video-gallery).
"use client";

import React, { useState, useEffect } from 'react';
import { pluginHooks } from '../../../../frontend/src/lib/plugin-hooks';

/**
 * UserFormExtension
 * This component is registered via the Hook system.
 * It adds the "Professional Mail Account" toggle to the core User Form.
 */
// Module-level LIVE MIRROR of the currently-mounted form's "auto professional email" toggle.
// It exists only so the email-input filter below (registered once at module load, so it can't read
// React state) can see the toggle. It is written by the mounted component's effect and is NOT used
// to seed any form's initial state — so toggle state no longer leaks across separate form instances.
let isAutoEmailActive = true;

const UserFormExtension = ({ data }: { data: any }) => {
    const { formData, setFormData, isNew } = data || {};
    const [domain, setDomain] = useState("wordjs.com");

    // Determine handled domain
    useEffect(() => {
        if (typeof window !== 'undefined') {
            setDomain(window.location.hostname);
        }
    }, []);

    // Guard every field this component dereferences so it renders safely when mail data is missing.
    const username = (formData?.username || '');
    const currentEmail = (formData?.email || '');

    // Initial check: if editing, is the current email already professional?
    const professionalEmail = `${username.toLowerCase()}@${domain.toLowerCase()}`;

    // Seed the toggle from THIS form's own data — never from the module-global mirror. Reading the
    // global to seed a NEW form was the leak (a fresh "Add user" inherited the last form's toggle).
    const [autoEmail, setAutoEmail] = useState(
        isNew ? true : (currentEmail.toLowerCase() === professionalEmail)
    );

    // One-way live mirror into the module bridge consumed by the email-input filter. Overwritten by
    // whichever form is currently mounted, so it no longer carries state between form instances.
    useEffect(() => {
        isAutoEmailActive = autoEmail;
        pluginHooks.notify();
    }, [autoEmail]);

    // Sync email when username changes and autoEmail is on
    useEffect(() => {
        if (autoEmail && username) {
            const nextEmail = `${username.toLowerCase()}@${domain}`;
            if (currentEmail !== nextEmail) {
                setFormData?.((prev: any) => ({
                    ...prev,
                    email: nextEmail
                }));
            }
        }
    }, [username, autoEmail, domain, setFormData, currentEmail]);

    return (
        <div className="flex items-center justify-between p-4 bg-purple-50 rounded-xl border border-purple-100 mb-2">
            <div>
                <h3 className="text-sm font-bold text-purple-900 uppercase tracking-tight">Professional Mail Account</h3>
                <p className="text-xs text-purple-600">Generate a professional <strong>@{domain}</strong> box for this user</p>
            </div>
            <button
                type="button"
                onClick={() => setAutoEmail(!autoEmail)}
                className={`w-12 h-6 rounded-full transition-all relative ${autoEmail ? 'bg-purple-600 shadow-inner' : 'bg-gray-200'}`}
            >
                <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm ${autoEmail ? 'translate-x-6' : 'translate-x-0'}`}></div>
            </button>
        </div>
    );
};

// Register the hooks
export const registerUserFormExtension = () => {
    // 1. Add the toggle UI
    pluginHooks.addAction('user_form_before_email', (data) => <UserFormExtension data={data} />);

    // 2. Filter the core email input properties
    pluginHooks.addFilter('user_form_email_input_props', (props = {}, _data = {}) => {
        if (!isAutoEmailActive) return props;

        return {
            ...props,
            readOnly: true,
            className: (props.className || '') + " bg-gray-100 text-gray-400 border-dashed cursor-not-allowed font-mono",
            placeholder: "Generated automatically..."
        };
    });
};
