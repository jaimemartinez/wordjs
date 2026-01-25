"use client";

import React, { useState, useEffect } from 'react';
import { pluginHooks } from '../../../../frontend/src/lib/plugin-hooks';

/**
 * UserFormExtension
 * This component is registered via the Hook system.
 * It adds the "Professional Mail Account" toggle to the core User Form.
 */
// Internal state for the plugin to track if autoEmail is active
let isAutoEmailActive = true;

const UserFormExtension = ({ data }: { data: any }) => {
    const { formData, setFormData, isNew } = data;
    const [domain, setDomain] = useState("wordjs.com");

    // Determine handled domain
    useEffect(() => {
        if (typeof window !== 'undefined') {
            setDomain(window.location.hostname);
        }
    }, []);

    // Initial check: if editing, is the current email already professional?
    const professionalEmail = `${formData.username.toLowerCase()}@${domain.toLowerCase()}`;
    const initialAutoValue = isNew ? isAutoEmailActive : (formData.email.toLowerCase() === professionalEmail);

    const [autoEmail, setAutoEmail] = useState(initialAutoValue);

    // Sync internal static state for filters
    useEffect(() => {
        isAutoEmailActive = autoEmail;
        pluginHooks.notify();
    }, [autoEmail]);

    // Sync email when username changes and autoEmail is on
    useEffect(() => {
        if (autoEmail && formData.username) {
            const nextEmail = `${formData.username.toLowerCase()}@${domain}`;
            if (formData.email !== nextEmail) {
                setFormData((prev: any) => ({
                    ...prev,
                    email: nextEmail
                }));
            }
        }
    }, [formData.username, autoEmail, domain, setFormData, formData.email]);

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
    pluginHooks.addFilter('user_form_email_input_props', (props, { isNew }) => {
        if (!isAutoEmailActive) return props;

        return {
            ...props,
            readOnly: true,
            className: props.className + " bg-gray-100 text-gray-400 border-dashed cursor-not-allowed font-mono",
            placeholder: "Generated automatically..."
        };
    });
};
