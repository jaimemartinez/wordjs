// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Conference, conferenceApi } from '../lib/conference';

interface ConferenceContextType {
    currentConference: Conference | null;
    conferences: Conference[];
    setCurrentConference: (conference: Conference | null) => void;
    refreshConferences: () => Promise<void>;
    loading: boolean;
}

const ConferenceContext = createContext<ConferenceContextType | undefined>(undefined);

export const CURRENT_KEY = 'conference-manager:current';

/**
 * The conference to open when none is selected: the one saved under CURRENT_KEY when it still exists,
 * otherwise the first active one, otherwise the first. Exported for the unit test.
 *
 * refreshConferences used to pick "the first active" on load and write it over the saved id BEFORE the
 * restore effect read it, so after a reload the plugin reopened the newest conference, not the one the
 * user was working on.
 */
export function pickConference(conferences: Conference[], savedId: string | null): Conference | null {
    if (!Array.isArray(conferences) || conferences.length === 0) return null;
    const saved = savedId ? conferences.find((c) => String(c.id) === String(savedId)) : undefined;
    return saved || conferences.find((c) => c.status === 'active') || conferences[0];
}

const readSaved = (): string | null => { try { return localStorage.getItem(CURRENT_KEY); } catch { return null; } };
const writeSaved = (id: number | null) => {
    try { if (id == null) localStorage.removeItem(CURRENT_KEY); else localStorage.setItem(CURRENT_KEY, String(id)); } catch { /* private mode */ }
};

export function ConferenceProvider({ children }: { children: ReactNode }) {
    const [currentConference, setCurrentConferenceState] = useState<Conference | null>(null);
    const [conferences, setConferences] = useState<Conference[]>([]);
    const [loading, setLoading] = useState(true);

    const refreshConferences = async () => {
        try {
            const data = await conferenceApi.getConferences();
            setConferences(data);
            
            // No conference selected yet: the saved one when it still exists (pickConference).
            if (!currentConference && data.length > 0) {
                const pick = pickConference(data, readSaved());
                setCurrentConferenceState(pick);
                if (pick) writeSaved(pick.id);
            }
        } catch (error) {
            console.error('Failed to load conferences:', error);
        } finally {
            setLoading(false);
        }
    };

    const setCurrentConference = (conference: Conference | null) => {
        setCurrentConferenceState(conference);
        writeSaved(conference ? conference.id : null);
    };

    useEffect(() => {
        refreshConferences();
    }, []);

    return (
        <ConferenceContext.Provider
            value={{
                currentConference,
                conferences,
                setCurrentConference,
                refreshConferences,
                loading,
            }}
        >
            {children}
        </ConferenceContext.Provider>
    );
}

export function useConference() {
    const context = useContext(ConferenceContext);
    if (context === undefined) {
        throw new Error('useConference must be used within a ConferenceProvider');
    }
    return context;
}
