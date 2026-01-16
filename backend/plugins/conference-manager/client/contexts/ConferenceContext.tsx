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

export function ConferenceProvider({ children }: { children: ReactNode }) {
    const [currentConference, setCurrentConferenceState] = useState<Conference | null>(null);
    const [conferences, setConferences] = useState<Conference[]>([]);
    const [loading, setLoading] = useState(true);

    const refreshConferences = async () => {
        try {
            const data = await conferenceApi.getConferences();
            setConferences(data);
            
            // Si no hay conferencia actual pero hay conferencias disponibles, seleccionar la primera activa o la primera
            if (!currentConference && data.length > 0) {
                const active = data.find(c => c.status === 'active') || data[0];
                setCurrentConferenceState(active);
                localStorage.setItem('conference-manager:current', String(active.id));
            }
        } catch (error) {
            console.error('Failed to load conferences:', error);
        } finally {
            setLoading(false);
        }
    };

    const setCurrentConference = (conference: Conference | null) => {
        setCurrentConferenceState(conference);
        if (conference) {
            localStorage.setItem('conference-manager:current', String(conference.id));
        } else {
            localStorage.removeItem('conference-manager:current');
        }
    };

    useEffect(() => {
        refreshConferences();
    }, []);

    // Restaurar conferencia seleccionada desde localStorage
    useEffect(() => {
        if (conferences.length > 0 && !currentConference) {
            const savedId = localStorage.getItem('conference-manager:current');
            if (savedId) {
                const saved = conferences.find(c => c.id === Number(savedId));
                if (saved) {
                    setCurrentConferenceState(saved);
                } else {
                    // Si la conferencia guardada no existe, usar la primera activa o la primera
                    const active = conferences.find(c => c.status === 'active') || conferences[0];
                    setCurrentConferenceState(active);
                }
            } else {
                // Si no hay guardada, usar la primera activa o la primera
                const active = conferences.find(c => c.status === 'active') || conferences[0];
                setCurrentConferenceState(active);
            }
        }
    }, [conferences]);

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
