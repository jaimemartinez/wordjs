// @ts-nocheck
"use client";

import React, { useState, useEffect } from "react";
import { ConferenceProvider, useConference } from "../contexts/ConferenceContext";
// Import from GLOBAL context/lib
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { registerTranslations } from "../../../../../frontend/src/lib/i18n";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
// Import local translations data
import { translations } from "../lib/i18n";
import { conferenceApi, Conference, Inscription, Hotel, Room, Location, ConferenceField, Payment } from "../lib/conference";
import { useModal } from "@/contexts/ModalContext";
import { StatCard } from "../../../../../frontend/src/components/ui/StatCard";
import { ActionCard } from "../../../../../frontend/src/components/ui/ActionCard";

// Register plugin translations
registerTranslations(translations);

type View = 'list' | 'dashboard' | 'inscriptions' | 'lodging' | 'locations' | 'reports' | 'assignment' | 'fields';

function ConferenceManagerContent() {
    const { currentConference, conferences, setCurrentConference, refreshConferences, loading } = useConference();
    // useI18n from global context
    const { t, language } = useI18n();
    const [view, setViewState] = useState<View>('list');
    const [selectedConferenceId, setSelectedConferenceId] = useState<number | null>(null);

    // Initialize state from local storage
    useEffect(() => {
        const savedView = localStorage.getItem('conference-manager:view') as View;
        if (savedView && ['list', 'dashboard', 'inscriptions', 'lodging', 'locations', 'reports'].includes(savedView)) {
            setViewState(savedView);
        }
    }, []);

    const setView = (newView: View) => {
        setViewState(newView);
        localStorage.setItem('conference-manager:view', newView);
    };

    // Cuando se selecciona una conferencia, cambiar a dashboard
    const handleManageConference = (conference: Conference) => {
        setCurrentConference(conference);
        setSelectedConferenceId(conference.id);
        setView('dashboard');
    };

    // Cuando se cambia de vista, asegurar que hay una conferencia seleccionada
    useEffect(() => {
        if (!loading && view !== 'list' && !currentConference) {
            setView('list');
        }
    }, [view, currentConference, loading]);

    if (view === 'list') {
        return <ConferenceList onManage={handleManageConference} />;
    }

    if (!currentConference) {
        return <ConferenceList onManage={handleManageConference} />;
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-shrink-0 p-6 pb-0">
                <div className="mb-8">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <div className="flex items-center gap-3 mb-2">
                                <button
                                    onClick={() => setView('list')}
                                    className="text-gray-400 hover:text-gray-600 transition-colors"
                                >
                                    <i className="fa-solid fa-arrow-left"></i>
                                </button>
                                <h1 className="text-2xl font-bold text-gray-900">{t('conference.manager')}</h1>
                            </div>
                            <p className="text-gray-500">{t('conference.manager.description')}</p>
                        </div>
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
                                <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">{t('conference')}:</span>
                                <span className="text-sm font-bold text-gray-900">{currentConference.name}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex border-b border-gray-200 mb-6 overflow-x-auto">
                    {[
                        { name: t('dashboard'), view: 'dashboard' as View, icon: 'fa-chart-pie' },
                        { name: t('inscriptions'), view: 'inscriptions' as View, icon: 'fa-users' },
                        { name: t('lodging'), view: 'lodging' as View, icon: 'fa-bed' },
                        { name: t('locations'), view: 'locations' as View, icon: 'fa-map-marker-alt' },
                        { name: t('assignment'), view: 'assignment' as View, icon: 'fa-wand-magic-sparkles' },
                        { name: t('fields'), view: 'fields' as View, icon: 'fa-list-check' },
                        { name: t('reports'), view: 'reports' as View, icon: 'fa-file-lines' },
                    ].map((tab) => {
                        const isActive = view === tab.view;
                        return (
                            <button
                                key={tab.name}
                                onClick={() => setView(tab.view)}
                                className={`flex items-center gap-2 px-6 py-3 border-b-2 font-medium text-sm transition-colors whitespace-nowrap
                                    ${isActive
                                        ? 'border-blue-600 text-blue-600'
                                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                                    }`}
                            >
                                <i className={`fa-solid ${tab.icon}`}></i>
                                {tab.name}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex-1 px-6 pb-6 overflow-hidden min-h-0">
                <div className="h-full bg-white rounded-xl shadow-sm border border-gray-200 p-6 overflow-auto flex flex-col">
                    {view === 'dashboard' && <ConferenceDashboard conferenceId={currentConference.id} onNavigate={setView} />}
                    {view === 'inscriptions' && <InscriptionsPage conferenceId={currentConference.id} />}
                    {view === 'lodging' && <LodgingPage conferenceId={currentConference.id} />}
                    {view === 'locations' && <LocationsPage conferenceId={currentConference.id} />}
                    {view === 'assignment' && <AssignmentPage conferenceId={currentConference.id} />}
                    {view === 'fields' && <FieldsPage conferenceId={currentConference.id} />}
                    {view === 'reports' && <ReportsPage conferenceId={currentConference.id} />}
                </div>
            </div>
        </div>
    );
}

// Conference List Component
function ConferenceList({ onManage }: { onManage: (conf: Conference) => void }) {
    const { conferences, refreshConferences } = useConference();
    const { t } = useI18n();
    const { addToast } = useToast();
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newConference, setNewConference] = useState({
        name: '',
        slug: '',
        date_start: '',
        date_end: '',
        fee_default: 0
    });
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<number | null>(null);
    const [conferenceStats, setConferenceStats] = useState<Record<number, {
        inscriptions: number;
        hotels: number;
        rooms: number;
    }>>({});

    useEffect(() => {
        const loadStats = async () => {
            const stats: Record<number, { inscriptions: number; hotels: number; rooms: number }> = {};

            for (const conf of conferences) {
                try {
                    const [inscriptions, hotels] = await Promise.all([
                        conferenceApi.getInscriptions(conf.id).catch(() => []),
                        conferenceApi.getHotels(conf.id).catch(() => [])
                    ]);

                    stats[conf.id] = {
                        inscriptions: inscriptions.length,
                        hotels: hotels.length,
                        rooms: hotels.reduce((sum, h) => sum + (h.rooms?.length || 0), 0)
                    };
                } catch (error) {
                    stats[conf.id] = { inscriptions: 0, hotels: 0, rooms: 0 };
                }
            }

            setConferenceStats(stats);
            setLoading(false);
        };

        if (conferences.length > 0) {
            loadStats();
        } else {
            setLoading(false);
        }
    }, [conferences]);

    const generateSlug = (name: string) => {
        return name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    };

    const { confirm } = useModal();

    const handleCreateConference = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreating(true);
        try {
            await conferenceApi.createConference(newConference);
            await refreshConferences();
            setShowCreateModal(false);
            setNewConference({ name: '', slug: '', date_start: '', date_end: '', fee_default: 0 });
            addToast(t('conference.created') || 'Conferencia creada', 'success');
        } catch (error: any) {
            addToast(error.message || 'Error creating conference', 'error');
        } finally {
            setCreating(false);
        }
    };

    const handleDeleteConference = async (id: number) => {
        if (!await confirm(t('confirm.delete.conference'), t('delete'), true)) {
            return;
        }

        setDeleting(id);
        try {
            await conferenceApi.deleteConference(id);
            await refreshConferences();
            addToast(t('conference.deleted') || 'Conferencia eliminada', 'success');
        } catch (error: any) {
            addToast(error.message || 'Error deleting conference', 'error');
        } finally {
            setDeleting(null);
        }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500">{t('loading')}</p>
            </div>
        );
    }

    return (
        <div className="p-10 space-y-10 animate-in fade-in duration-500">
            <div className="flex justify-between items-end mb-8">
                <div>
                    <h2 className="text-4xl font-black text-gray-900 italic tracking-tighter mb-2">{t('conference.list')}</h2>
                    <p className="text-sm font-bold text-gray-400 uppercase tracking-widest">{t('conference.manager.description')}</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {/* Nueva Conferencia Card - Premium */}
                <div
                    onClick={() => setShowCreateModal(true)}
                    className="group bg-gradient-to-br from-blue-600 to-indigo-700 rounded-[40px] p-8 flex flex-col items-center justify-center text-white hover:shadow-2xl hover:shadow-blue-500/40 hover:-translate-y-2 transition-all duration-500 cursor-pointer min-h-[320px] relative overflow-hidden ring-4 ring-white ring-offset-4 ring-offset-gray-50"
                >
                    <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20"></div>
                    <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-5 rounded-full blur-[80px] group-hover:blur-[60px] transition-all duration-700"></div>
                    <div className="absolute bottom-0 left-0 w-48 h-48 bg-purple-500 opacity-20 rounded-full blur-[60px]"></div>

                    <div className="relative z-10 flex flex-col items-center">
                        <div className="w-20 h-20 rounded-3xl bg-white/10 backdrop-blur-md flex items-center justify-center mb-6 shadow-inner border border-white/20 group-hover:scale-110 group-hover:bg-white/20 transition-all duration-500">
                            <i className="fa-solid fa-plus text-3xl"></i>
                        </div>
                        <span className="font-black text-2xl italic tracking-tight">{t('create.conference')}</span>
                        <span className="mt-2 text-xs font-bold uppercase tracking-widest text-blue-200 group-hover:text-white transition-colors">Comenzar nuevo evento</span>
                    </div>
                </div>

                {/* Conference Cards */}
                {conferences.map(conf => {
                    const stats = conferenceStats[conf.id] || { inscriptions: 0, hotels: 0, rooms: 0 };
                    const isDeleting = deleting === conf.id;

                    return (
                        <div
                            key={conf.id}
                            className={`
                                group bg-white rounded-[40px] p-8 shadow-sm hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 relative flex flex-col justify-between min-h-[320px] overflow-hidden border-2
                                ${conf.status === 'active' ? 'border-emerald-100 hover:border-emerald-500 shadow-emerald-100/50' :
                                    conf.status === 'draft' ? 'border-gray-100 hover:border-gray-400 shadow-gray-100/50' :
                                        'border-orange-100 hover:border-orange-500 shadow-orange-100/50'}
                            `}
                        >
                            {/* Decorative background element - Status Based */}
                            <div className={`absolute top-0 right-0 -mr-16 -mt-16 w-48 h-48 rounded-full opacity-0 group-hover:opacity-100 transition-opacity blur-[60px] duration-700
                                ${conf.status === 'active' ? 'bg-emerald-100' :
                                    conf.status === 'draft' ? 'bg-gray-100' :
                                        'bg-orange-100'}
                            `}></div>

                            <div>
                                <div className="flex items-start justify-between mb-8 relative z-10">
                                    <div className={`w-16 h-16 rounded-3xl flex items-center justify-center text-2xl shrink-0 transition-all duration-500 shadow-inner group-hover:scale-110
                                        ${conf.status === 'active' ? 'bg-emerald-50 text-emerald-600' :
                                            conf.status === 'draft' ? 'bg-gray-50 text-gray-500' :
                                                'bg-orange-50 text-orange-600'}
                                    `}>
                                        <i className={`fa-solid ${conf.status === 'active' ? 'fa-satellite-dish' : 'fa-box-archive'}`}></i>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteConference(conf.id); }}
                                            className="w-10 h-10 flex items-center justify-center rounded-2xl text-gray-300 hover:bg-rose-50 hover:text-rose-600 transition-all duration-300 opacity-0 group-hover:opacity-100 transform translate-x-4 group-hover:translate-x-0"
                                            disabled={isDeleting}
                                        >
                                            {isDeleting ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-trash-can"></i>}
                                        </button>
                                    </div>
                                </div>

                                <div className="relative z-10">
                                    <h3 className="font-black text-3xl text-gray-900 leading-tight mb-3 italic tracking-tighter group-hover:underline decoration-4 underline-offset-4 decoration-transparent group-hover:decoration-current transition-all">
                                        {conf.name}
                                    </h3>

                                    <div className="flex flex-wrap gap-2 mb-6">
                                        <span className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border ${conf.status === 'active' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                                            conf.status === 'draft' ? 'bg-gray-50 text-gray-600 border-gray-100' :
                                                'bg-orange-50 text-orange-700 border-orange-100'
                                            }`}>
                                            {t(conf.status)}
                                        </span>
                                        {conf.date_start && (
                                            <span className="bg-white border border-gray-100 text-gray-500 px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase flex items-center gap-1.5">
                                                <i className="fa-solid fa-calendar-day text-gray-300"></i>
                                                {new Date(conf.date_start).toLocaleDateString()}
                                            </span>
                                        )}
                                    </div>

                                    {conf.description && (
                                        <p className="text-sm text-gray-400 font-medium line-clamp-2 mb-4 leading-relaxed">{conf.description}</p>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-end justify-between mt-auto relative z-10 pt-6 border-t border-gray-50">
                                <div className="space-y-1.5">
                                    <div className="text-gray-300 text-[9px] font-black uppercase tracking-[0.2em]">{t('stats') || 'ESTADISTICAS'}</div>
                                    <div className="flex items-center gap-4 text-xs font-bold text-gray-600">
                                        <span className="flex items-center gap-1.5" title={t('inscription.plural')}>
                                            <i className="fa-solid fa-users text-blue-400"></i>
                                            {stats.inscriptions}
                                        </span>
                                        <span className="flex items-center gap-1.5" title={t('hotels')}>
                                            <i className="fa-solid fa-bed text-indigo-400"></i>
                                            {stats.hotels}
                                        </span>
                                    </div>
                                </div>

                                <button
                                    onClick={() => onManage(conf)}
                                    className="px-6 py-3 bg-gray-900 text-white text-[10px] font-black uppercase tracking-widest rounded-2xl hover:bg-blue-600 hover:shadow-xl hover:shadow-blue-500/30 transition-all duration-300 flex items-center gap-2 transform active:scale-95"
                                >
                                    {t('manage')} <i className="fa-solid fa-arrow-right-long text-[10px]"></i>
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Create Conference Modal */}
            {showCreateModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-10 py-8 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter">{t('create.conference')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Configura tu nuevo evento</p>
                            </div>
                            <button
                                onClick={() => setShowCreateModal(false)}
                                className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl"
                            >
                                <i className="fa-solid fa-xmark text-xl"></i>
                            </button>
                        </div>
                        <form onSubmit={handleCreateConference} className="p-10 space-y-6">
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">
                                    {t('conference.name')} *
                                </label>
                                <input
                                    required
                                    type="text"
                                    className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-300"
                                    value={newConference.name}
                                    onChange={(e) => {
                                        const name = e.target.value;
                                        setNewConference({
                                            ...newConference,
                                            name,
                                            slug: generateSlug(name)
                                        });
                                    }}
                                    placeholder="e.g. Conferencia Anual 2024"
                                    autoFocus
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.slug')} *</label>
                                <div className="relative">
                                    <input
                                        required
                                        type="text"
                                        className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-mono text-sm pl-4"
                                        value={newConference.slug}
                                        onChange={(e) => setNewConference({ ...newConference, slug: e.target.value })}
                                        placeholder="conferencia-anual-2024"
                                    />
                                    <i className="fa-solid fa-link absolute right-4 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                </div>
                                <p className="text-[10px] text-gray-400 italic ml-1">{t('slug.help')}</p>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.start.date')}</label>
                                    <div className="relative">
                                        <input
                                            type="datetime-local"
                                            className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold text-sm"
                                            value={newConference.date_start}
                                            onChange={(e) => setNewConference({ ...newConference, date_start: e.target.value })}
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.end.date')}</label>
                                    <div className="relative">
                                        <input
                                            type="datetime-local"
                                            className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold text-sm"
                                            value={newConference.date_end}
                                            onChange={(e) => setNewConference({ ...newConference, date_end: e.target.value })}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.default.fee')}</label>
                                <div className="relative">
                                    <span className="absolute left-6 top-1/2 -translate-y-1/2 text-gray-400 font-black text-lg">$</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        className="w-full border-2 border-gray-100 rounded-2xl px-12 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-black text-lg"
                                        value={newConference.fee_default}
                                        onChange={(e) => setNewConference({ ...newConference, fee_default: Number(e.target.value) })}
                                        placeholder="0.00"
                                    />
                                </div>
                            </div>
                            <div className="pt-6 flex gap-4 border-t border-gray-50">
                                <button
                                    type="button"
                                    onClick={() => setShowCreateModal(false)}
                                    className="flex-1 px-6 py-4 text-gray-400 font-black text-[10px] uppercase tracking-widest hover:bg-gray-100 rounded-xl transition-all"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    type="submit"
                                    disabled={creating}
                                    className="flex-[2] px-8 py-4 bg-gray-900 text-white font-black text-[10px] uppercase tracking-widest rounded-xl shadow-xl shadow-gray-200 hover:shadow-blue-500/30 hover:bg-blue-600 transition-all transform active:scale-95 disabled:opacity-50"
                                >
                                    {creating ? t('creating') : t('create.conference')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

// Dashboard Component
function ConferenceDashboard({ conferenceId, onNavigate }: { conferenceId: number, onNavigate: (view: View) => void }) {
    const { currentConference } = useConference();
    const { t } = useI18n(); // Get t() function
    const [stats, setStats] = useState({
        inscriptions: 0,
        hotels: 0,
        rooms: 0,
        paid: 0,
        unpaid: 0
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!conferenceId) return;

        const loadStats = async () => {
            try {
                const [inscriptions, hotels] = await Promise.all([
                    conferenceApi.getInscriptions(conferenceId).catch(() => []),
                    conferenceApi.getHotels(conferenceId).catch(() => [])
                ]);

                const paid = inscriptions.filter(i => i.payment_status === 'paid').length;
                const unpaid = inscriptions.filter(i => i.payment_status !== 'paid').length;
                const totalRooms = hotels.reduce((sum, h) => sum + (h.rooms?.length || 0), 0);

                setStats({
                    inscriptions: inscriptions.length,
                    hotels: hotels.length,
                    rooms: totalRooms,
                    paid,
                    unpaid
                });
            } catch (error) {
                console.error('Failed to load stats:', error);
            } finally {
                setLoading(false);
            }
        };

        loadStats();
    }, [conferenceId]);

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500">{t('loading.stats')}</p>
            </div>
        );
    }

    if (!currentConference) return null;

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Premium Header Banner */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-blue-50/50 rounded-full blur-3xl"></div>
                <div className="absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 bg-indigo-50/50 rounded-full blur-3xl"></div>

                <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div>
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200">
                                <i className="fa-solid fa-gauge-high"></i>
                            </div>
                            <span className="text-[10px] font-bold text-blue-600 uppercase tracking-[0.2em]">{t('dashboard')}</span>
                        </div>
                        <h2 className="text-4xl font-black text-gray-900 italic tracking-tighter mb-2">{currentConference.name}</h2>

                        <div className="flex flex-wrap items-center gap-4">
                            {currentConference.date_start && (
                                <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">
                                    <i className="fa-solid fa-calendar text-blue-500 text-xs text-center w-4"></i>
                                    <span className="text-xs font-bold text-gray-600">
                                        {new Date(currentConference.date_start).toLocaleDateString()}
                                        {currentConference.date_end && ` - ${new Date(currentConference.date_end).toLocaleDateString()}`}
                                    </span>
                                </div>
                            )}
                            <div className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border-2 shadow-sm ${currentConference.status === 'active' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                                currentConference.status === 'draft' ? 'bg-gray-50 text-gray-500 border-gray-100' :
                                    'bg-amber-50 text-amber-600 border-amber-100'
                                }`}>
                                {currentConference.status}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => onNavigate('fields')}
                            className="px-6 py-3 bg-white border-2 border-gray-100 hover:border-blue-500 hover:text-blue-600 transition-all rounded-2xl text-xs font-black uppercase tracking-widest flex items-center gap-2 group"
                        >
                            <i className="fa-solid fa-pen-to-square group-hover:scale-110 transition-transform"></i>
                            Configurar Registro
                        </button>
                    </div>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6">
                <StatCard icon="fa-users" label={t('inscriptions')} value={stats.inscriptions} color="blue" />
                <StatCard icon="fa-bed" label={t('hotels')} value={stats.hotels} color="purple" />
                <StatCard icon="fa-door-open" label={t('rooms')} value={stats.rooms} color="indigo" />
                <StatCard icon="fa-circle-check" label={t('paid')} value={stats.paid} color="green" />
                <StatCard icon="fa-circle-xmark" label={t('unpaid')} value={stats.unpaid} color="red" />
            </div>

            {/* Actions Grid */}
            <div className="space-y-6 pt-2">
                <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-200 to-transparent"></div>
                    <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] whitespace-nowrap">{t('quick.actions')}</h3>
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-200 to-transparent"></div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <ActionCard
                        icon="fa-user-plus"
                        title={t('register.participant')}
                        description={t('new.inscription.desc')}
                        onClick={() => onNavigate('inscriptions')}
                        color="blue"
                    />
                    <ActionCard
                        icon="fa-bed"
                        title={t('manage.lodging')}
                        description={t('manage.lodging.desc')}
                        onClick={() => onNavigate('lodging')}
                        color="purple"
                    />
                    <ActionCard
                        icon="fa-file-lines"
                        title={t('view.reports')}
                        description={t('view.reports.desc')}
                        onClick={() => onNavigate('reports')}
                        color="green"
                    />
                </div>
            </div>
        </div>
    );
}

// StatCard is imported from global ui components

// ActionCard is imported from global ui components


// Inscriptions Component
function InscriptionsPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [inscriptions, setInscriptions] = useState<Inscription[]>([]);
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedLocations, setSelectedLocations] = useState<Set<string>>(new Set());
    const [showLocationDropdown, setShowLocationDropdown] = useState(false);
    const [collapsedLocations, setCollapsedLocations] = useState<Set<string>>(new Set());
    const [formData, setFormData] = useState<any>({
        custom_data: {}
    });

    const [selectedInscription, setSelectedInscription] = useState<Inscription | null>(null);
    const [payments, setPayments] = useState<Payment[]>([]);
    const [loadingPayments, setLoadingPayments] = useState(false);

    const loadData = async () => {
        if (!conferenceId) return;
        setLoading(true);
        try {
            const [inscriptionsData, fieldsData] = await Promise.all([
                conferenceApi.getInscriptions(conferenceId),
                conferenceApi.getFields(conferenceId)
            ]);
            setInscriptions(inscriptionsData);
            setFields(fieldsData);
        } catch (e) {
            addToast('Error loading inscriptions', 'error');
        } finally {
            setLoading(false);
        }
    };

    const fetchInscriptions = async () => {
        if (!conferenceId) return;
        setLoading(true);
        try {
            const params: any = { search: searchTerm };
            // If specific locations are selected, filter by them
            // Note: The API currently supports single location filter, so we'll filter client-side if multiple
            const data = await conferenceApi.getInscriptions(conferenceId, params);

            // Filter by selected locations if any are selected
            let filteredData = data;
            if (selectedLocations.size > 0) {
                filteredData = data.filter(inscription => {
                    const loc = inscription.location || t('no.location');
                    return selectedLocations.has(loc);
                });
            }

            setInscriptions(filteredData);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    // Get unique locations from all inscriptions (before filtering)
    const fetchAllInscriptions = async () => {
        if (!conferenceId) return;
        try {
            const data = await conferenceApi.getInscriptions(conferenceId, { search: searchTerm });
            return data;
        } catch (e) {
            return [];
        }
    };

    const [allLocations, setAllLocations] = useState<string[]>([]);

    useEffect(() => {
        const loadLocations = async () => {
            const allData = await fetchAllInscriptions();
            const uniqueLocations = Array.from(new Set(allData.map(i => i.location).filter(Boolean))).sort();
            setAllLocations(uniqueLocations);
        };
        loadLocations();
    }, [conferenceId]);

    // Group inscriptions by location
    const groupedByLocation = inscriptions.reduce((acc, inscription) => {
        const loc = inscription.location || t('no.location');
        if (!acc[loc]) {
            acc[loc] = [];
        }
        acc[loc].push(inscription);
        return acc;
    }, {} as Record<string, Inscription[]>);

    // Sort locations alphabetically, with "Sin localidad" at the end
    const sortedLocations = Object.keys(groupedByLocation).sort((a, b) => {
        if (a === t('no.location')) return 1;
        if (b === t('no.location')) return -1;
        return a.localeCompare(b);
    });

    // Location selection handlers
    const toggleLocation = (location: string) => {
        const newSelected = new Set(selectedLocations);
        if (newSelected.has(location)) {
            newSelected.delete(location);
        } else {
            newSelected.add(location);
        }
        setSelectedLocations(newSelected);
    };

    const selectAllLocations = () => {
        const allLocs = new Set(allLocations);
        setSelectedLocations(allLocs);
    };

    const deselectAllLocations = () => {
        setSelectedLocations(new Set());
    };

    useEffect(() => {
        loadData(); // Initial load of inscriptions and fields
    }, [conferenceId]);

    useEffect(() => {
        fetchInscriptions(); // Filter inscriptions based on search/location
    }, [searchTerm, selectedLocations, conferenceId]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!conferenceId) return;
        try {
            await conferenceApi.createInscription({ ...formData, conference_id: conferenceId });
            setShowAddModal(false);
            setFormData({
                custom_data: {}
            });
            loadData(); // Refresh all data including fields
            addToast(t('inscription.created') || 'Inscripción creada', 'success');
        } catch (error) {
            addToast('Error creating inscription', 'error');
        }
    };

    const handleFormChange = (name: string, value: any) => {
        setFormData((prev: any) => ({
            ...prev,
            [name]: value
        }));
    };

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6 flex-shrink-0 px-1">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 flex-1 w-full">
                    {/* Premium Search */}
                    <div className="relative flex-1 max-w-md">
                        <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
                        <input
                            type="text"
                            placeholder={t('search.participants')}
                            className="w-full pl-12 pr-4 py-3.5 bg-gray-50/50 border-2 border-transparent focus:border-blue-500 focus:bg-white rounded-2xl transition-all outline-none text-sm font-medium text-gray-900 placeholder:text-gray-400 shadow-inner"
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                    </div>

                    {/* Premium Location Filter */}
                    <div className="flex items-center gap-3 relative">
                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setShowLocationDropdown(!showLocationDropdown)}
                                className={`px-5 py-3.5 rounded-2xl border-2 transition-all flex items-center justify-between min-w-[240px] group ${showLocationDropdown
                                    ? 'bg-blue-50 border-blue-500 text-blue-700 shadow-lg shadow-blue-500/10'
                                    : 'bg-white border-gray-100 text-gray-700 hover:border-gray-200 shadow-sm'
                                    }`}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${selectedLocations.size > 0 ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'
                                        }`}>
                                        <i className="fa-solid fa-location-dot text-xs"></i>
                                    </div>
                                    <div className="flex flex-col items-start leading-none">
                                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 group-hover:text-gray-500 transition-colors">{t('location')}</span>
                                        <span className="text-sm font-bold truncate">
                                            {selectedLocations.size === 0
                                                ? t('all.locations')
                                                : selectedLocations.size === 1
                                                    ? Array.from(selectedLocations)[0]
                                                    : `${selectedLocations.size} ${t('locations.selected')}`}
                                        </span>
                                    </div>
                                </div>
                                <i className={`fa-solid fa-chevron-${showLocationDropdown ? 'up' : 'down'} text-[10px] ml-4 ${showLocationDropdown ? 'text-blue-500' : 'text-gray-400'}`}></i>
                            </button>

                            {showLocationDropdown && (
                                <>
                                    <div
                                        className="fixed inset-0 z-[60]"
                                        onClick={() => setShowLocationDropdown(false)}
                                    ></div>
                                    <div className="absolute z-[70] mt-3 bg-white border border-gray-100 rounded-3xl shadow-2xl overflow-hidden min-w-[320px] animate-in slide-in-from-top-2 duration-200">
                                        <div className="p-4 border-b border-gray-50 flex items-center justify-between gap-3 bg-gray-50/50">
                                            <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('filter.by.location')}</div>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={selectAllLocations}
                                                    className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-blue-600 hover:bg-white rounded-lg transition-all"
                                                >
                                                    {t('select.all')}
                                                </button>
                                                <button
                                                    onClick={deselectAllLocations}
                                                    className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-gray-400 hover:bg-white rounded-lg transition-all"
                                                >
                                                    {t('deselect.all')}
                                                </button>
                                            </div>
                                        </div>
                                        <div className="max-h-[300px] overflow-y-auto p-2 scrollbar-thin">
                                            {allLocations.length === 0 ? (
                                                <div className="px-4 py-8 text-center">
                                                    <div className="w-12 h-12 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-3">
                                                        <i className="fa-solid fa-map-pin text-gray-300"></i>
                                                    </div>
                                                    <div className="text-xs font-bold text-gray-400 italic">{t('no.locations')}</div>
                                                </div>
                                            ) : (
                                                allLocations.map(location => (
                                                    <label
                                                        key={location}
                                                        className={`flex items-center gap-4 px-4 py-3 hover:bg-blue-50 rounded-2xl cursor-pointer group transition-all ${selectedLocations.has(location) ? 'bg-blue-50/50' : ''
                                                            }`}
                                                    >
                                                        <div className="relative flex items-center justify-center">
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedLocations.has(location)}
                                                                onChange={() => toggleLocation(location)}
                                                                className="peer appearance-none w-5 h-5 border-2 border-gray-200 checked:border-blue-600 rounded-lg transition-all"
                                                            />
                                                            <i className="fa-solid fa-check absolute text-[10px] text-blue-600 opacity-0 peer-checked:opacity-100 transition-opacity"></i>
                                                        </div>
                                                        <span className={`text-sm font-bold transition-colors ${selectedLocations.has(location) ? 'text-blue-700' : 'text-gray-600 group-hover:text-gray-900'
                                                            }`}>
                                                            {location}
                                                        </span>
                                                    </label>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                <button
                    onClick={() => setShowAddModal(true)}
                    className="flex-shrink-0 bg-blue-600 text-white px-8 py-4 rounded-2xl hover:bg-blue-700 active:scale-95 transition-all shadow-xl shadow-blue-500/30 flex items-center justify-center gap-3 w-full md:w-auto font-black italic tracking-tighter"
                >
                    <i className="fa-solid fa-plus text-sm"></i>
                    <span>{t('new.inscription')}</span>
                </button>
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-auto modern-scrollbar min-h-0">
                {loading ? (
                    <div className="text-center py-20">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-500">{t('loading.inscriptions')}</p>
                    </div>
                ) : inscriptions.length === 0 ? (
                    <div className="text-center py-20 text-gray-400">
                        <i className="fa-solid fa-users text-4xl mb-4 opacity-50"></i>
                        <p>{t('no.inscriptions')}</p>
                    </div>
                ) : (
                    <div className="space-y-12">
                        {sortedLocations.map((location) => {
                            const locationInscriptions = groupedByLocation[location];
                            const isCollapsed = collapsedLocations.has(location);

                            // Show location if no filter is applied or if it's selected
                            if (selectedLocations.size > 0 && !selectedLocations.has(location)) {
                                return null;
                            }

                            const toggleCollapse = () => {
                                const newCollapsed = new Set(collapsedLocations);
                                if (newCollapsed.has(location)) {
                                    newCollapsed.delete(location);
                                } else {
                                    newCollapsed.add(location);
                                }
                                setCollapsedLocations(newCollapsed);
                            };

                            return (
                                <div key={location} className="bg-white rounded-3xl border border-gray-100 overflow-hidden shadow-xl shadow-gray-100/30 animate-in slide-in-from-bottom-4 duration-500">
                                    <div className="bg-white border-b border-gray-50 px-8 py-6">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-5 flex-1">
                                                <button
                                                    onClick={toggleCollapse}
                                                    className="group/btn w-10 h-10 rounded-xl bg-gray-50 hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-all flex items-center justify-center border border-transparent hover:border-blue-100"
                                                >
                                                    <i className={`fa-solid fa-chevron-${isCollapsed ? 'down' : 'up'} text-[10px] group-hover/btn:scale-125 transition-transform`}></i>
                                                </button>
                                                <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-100">
                                                    <i className="fa-solid fa-map-marker-alt"></i>
                                                </div>
                                                <div>
                                                    <h3 className="text-xl font-black text-gray-900 italic tracking-tighter">{location}</h3>
                                                    <div className="flex items-center gap-3 mt-1">
                                                        <span className="text-[10px] text-gray-400 font-bold uppercase tracking-[0.2em]">
                                                            {locationInscriptions.length} {locationInscriptions.length === 1 ? t('participant.singular') : t('participant.plural')}
                                                        </span>
                                                        <div className="w-1 h-1 rounded-full bg-gray-200"></div>
                                                        <span className="text-[10px] text-blue-500 font-black uppercase tracking-[0.2em]">
                                                            {locationInscriptions.filter(i => i.payment_status === 'paid').length} {t('paid').toLowerCase()}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    {!isCollapsed && (
                                        <div className="overflow-x-auto modern-scrollbar">
                                            <table className="w-full text-sm text-left border-collapse">
                                                <thead>
                                                    <tr className="bg-gray-50/50">
                                                        <th className="px-8 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">{t('first.name')} / {t('last.name')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">{t('email')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">{t('phone')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('document')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('gender')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('age')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('blood.type')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('family')}</th>
                                                        {fields.map(field => (
                                                            <th key={field.id} className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">{field.label}</th>
                                                        ))}
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('payment')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('lodging')}</th>
                                                        <th className="px-8 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-right whitespace-nowrap">{t('actions')}</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-50">
                                                    {locationInscriptions.map((person) => (
                                                        <tr key={person.id} className="hover:bg-blue-50/30 transition-colors group/row">
                                                            <td className="px-8 py-5">
                                                                <div className="font-bold text-gray-900 group-hover/row:text-blue-700 transition-colors">{person.first_name} {person.last_name}</div>
                                                            </td>
                                                            <td className="px-6 py-5">
                                                                <div className="text-gray-500 font-medium truncate max-w-[180px]">{person.email || <span className="text-gray-300 italic">No email</span>}</div>
                                                            </td>
                                                            <td className="px-6 py-5">
                                                                <div className="text-gray-500 font-medium whitespace-nowrap">{person.phone || <span className="text-gray-300 italic">-</span>}</div>
                                                            </td>
                                                            <td className="px-6 py-5 text-center">
                                                                <div className="flex flex-col items-center">
                                                                    <div className="text-[8px] font-black text-gray-400 uppercase bg-gray-100 px-1.5 py-0.5 rounded mb-1">{person.document_type || '-'}</div>
                                                                    <div className="text-gray-500 font-mono text-xs">{person.document_number || '-'}</div>
                                                                </div>
                                                            </td>
                                                            <td className="px-6 py-5 text-center">
                                                                <div className="flex justify-center">
                                                                    <span className={`w-8 h-8 flex items-center justify-center rounded-xl text-[10px] font-black text-white shadow-lg ${person.gender === 'M' ? 'bg-blue-500 shadow-blue-100' : 'bg-pink-500 shadow-pink-100'}`}>
                                                                        {person.gender}
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td className="px-6 py-5 text-center text-gray-500 font-bold">{person.age || '-'}</td>
                                                            <td className="px-6 py-5 text-center text-gray-500 font-bold font-mono text-xs">{person.blood_type || '-'}</td>
                                                            <td className="px-6 py-5 text-center">
                                                                {person.family_group ? (
                                                                    <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[10px] font-black uppercase">
                                                                        <i className="fa-solid fa-users text-[8px]"></i>
                                                                        {person.family_group}
                                                                    </div>
                                                                ) : <span className="text-gray-300">-</span>}
                                                            </td>
                                                            {fields.map(field => (
                                                                <td key={field.id} className="px-6 py-5">
                                                                    <div className="text-xs text-gray-600 font-medium truncate max-w-[150px]">
                                                                        {person.custom_data?.[field.name] || '-'}
                                                                    </div>
                                                                </td>
                                                            ))}
                                                            <td className="px-6 py-5">
                                                                <div className="flex flex-col items-center gap-1">
                                                                    <button
                                                                        onClick={() => {
                                                                            setSelectedInscription(person);
                                                                            setLoadingPayments(true);
                                                                            conferenceApi.getPayments(person.id)
                                                                                .then(setPayments)
                                                                                .finally(() => setLoadingPayments(false));
                                                                        }}
                                                                        className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all ${person.payment_status === 'paid'
                                                                            ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                                                                            : person.payment_status === 'partial'
                                                                                ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                                                                                : 'bg-rose-50 text-rose-600 hover:bg-rose-100'
                                                                            }`}
                                                                    >
                                                                        {person.payment_status}
                                                                    </button>
                                                                    <div className="text-[10px] text-gray-400 font-bold">${person.amount_paid} / ${person.total_due}</div>
                                                                </div>
                                                            </td>
                                                            <td className="px-6 py-5">
                                                                <div className="flex justify-center">
                                                                    {person.room_id ? (
                                                                        <div className="flex flex-col items-center">
                                                                            <span className="text-blue-600 font-black text-[10px] uppercase tracking-tighter">Hab: {person.room_number}</span>
                                                                            <span className="text-[8px] text-gray-400 font-bold truncate max-w-[100px] text-center">{person.hotel_name}</span>
                                                                        </div>
                                                                    ) : (
                                                                        <div className="text-amber-500 font-black text-[10px] uppercase flex items-center gap-1 bg-amber-50 px-2 py-1 rounded-lg">
                                                                            <i className="fa-solid fa-hotel text-[8px]"></i>
                                                                            N/A
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td className="px-8 py-5 text-right">
                                                                <div className="flex justify-end gap-2 opacity-0 group-hover/row:opacity-100 transition-opacity">
                                                                    <button
                                                                        className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition-all shadow-sm border border-transparent hover:border-blue-400"
                                                                        title={t('edit')}
                                                                    >
                                                                        <i className="fa-solid fa-pen text-xs"></i>
                                                                    </button>
                                                                    <button
                                                                        className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition-all shadow-sm border border-transparent hover:border-rose-400"
                                                                        title={t('delete')}
                                                                    >
                                                                        <i className="fa-solid fa-trash text-xs"></i>
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {showAddModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <h3 className="font-bold text-xl text-gray-900 italic">{t('new.inscription')}</h3>
                            <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-8 space-y-6">
                            {fields.length === 0 ? (
                                <div className="text-center py-10 bg-orange-50 rounded-2xl border-2 border-dashed border-orange-100 p-6">
                                    <i className="fa-solid fa-triangle-exclamation text-orange-400 text-3xl mb-4"></i>
                                    <p className="text-orange-900 font-black italic tracking-tight mb-1">Formulario no configurado</p>
                                    <p className="text-xs text-orange-700 leading-relaxed max-w-[280px] mx-auto">Debes crear campos en la pestaña "Campos" antes de poder registrar participantes.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                    {fields.map(field => (
                                        <div key={field.id} className={field.type === 'notes' || field.type === 'textarea' ? 'col-span-2' : ''}>
                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1.5">
                                                {field.label} {field.is_required ? <span className="text-rose-500">*</span> : ''}
                                            </label>
                                            {field.type === 'select' ? (
                                                <select
                                                    required={!!field.is_required}
                                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                                    value={formData[field.name] || ''}
                                                    onChange={e => handleFormChange(field.name, e.target.value)}
                                                >
                                                    <option value="">{t('select.option') || 'Seleccionar...'}</option>
                                                    {field.options?.split(',').map(opt => (
                                                        <option key={opt.trim()} value={opt.trim()}>{opt.trim()}</option>
                                                    ))}
                                                </select>
                                            ) : field.type === 'date' ? (
                                                <input
                                                    type="date"
                                                    required={!!field.is_required}
                                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                                    value={formData[field.name] || ''}
                                                    onChange={e => handleFormChange(field.name, e.target.value)}
                                                />
                                            ) : field.type === 'textarea' || field.type === 'notes' ? (
                                                <textarea
                                                    rows={3}
                                                    placeholder={field.label}
                                                    required={!!field.is_required}
                                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm resize-none"
                                                    value={formData[field.name] || ''}
                                                    onChange={e => handleFormChange(field.name, e.target.value)}
                                                />
                                            ) : (
                                                <input
                                                    type={field.type === 'number' ? 'number' : 'text'}
                                                    placeholder={field.label}
                                                    required={!!field.is_required}
                                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                                    value={formData[field.name] || ''}
                                                    onChange={e => handleFormChange(field.name, e.target.value)}
                                                />
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="pt-6 flex justify-end gap-3 border-t border-gray-50">
                                <button type="button" onClick={() => setShowAddModal(false)} className="px-6 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition">{t('cancel')}</button>
                                {fields.length > 0 && (
                                    <button type="submit" className="px-8 py-2.5 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition">{t('save')}</button>
                                )}
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Payments Modal */}
            {selectedInscription && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-bold text-xl text-gray-900 italic">Pagos de {selectedInscription.first_name} {selectedInscription.last_name}</h3>
                                <p className="text-xs text-gray-500 mt-0.5">Historial de abonos y comprobantes</p>
                            </div>
                            <button onClick={() => setSelectedInscription(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>

                        <div className="p-8">
                            {loadingPayments ? (
                                <div className="text-center py-10">
                                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                                </div>
                            ) : payments.length === 0 ? (
                                <div className="text-center py-10 text-gray-400 bg-gray-50 rounded-xl border border-dashed">
                                    <i className="fa-solid fa-receipt text-3xl mb-3 opacity-30"></i>
                                    <p className="font-medium text-sm">No se han registrado pagos para esta persona.</p>
                                </div>
                            ) : (
                                <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2 modern-scrollbar">
                                    {payments.map(payment => (
                                        <div key={payment.id} className="bg-gray-50 rounded-xl border border-gray-100 overflow-hidden">
                                            <div className="p-4 flex items-start justify-between gap-4">
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="font-bold text-gray-900">${payment.amount.toLocaleString()}</span>
                                                        <span className="text-[10px] font-bold uppercase bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{payment.method}</span>
                                                    </div>
                                                    <div className="text-xs text-gray-500 flex items-center gap-3">
                                                        <span><i className="fa-solid fa-calendar text-[10px] mr-1"></i> {new Date(payment.date).toLocaleDateString()}</span>
                                                        {payment.reference && <span><i className="fa-solid fa-hashtag text-[10px] mr-1"></i> {payment.reference}</span>}
                                                    </div>
                                                </div>

                                                {payment.proof && (
                                                    <div className="shrink-0 group relative">
                                                        <img
                                                            src={payment.proof}
                                                            className="w-16 h-16 rounded-lg object-cover border border-gray-200 cursor-pointer hover:opacity-80 transition"
                                                            onClick={() => window.open(payment.proof, '_blank')}
                                                        />
                                                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity text-white bg-black/40 rounded-lg">
                                                            <i className="fa-solid fa-magnifying-glass-plus"></i>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="flex items-center justify-end pt-6 mt-4 border-t">
                                <button
                                    type="button"
                                    onClick={() => setSelectedInscription(null)}
                                    className="px-6 py-2.5 bg-gray-900 text-white font-bold rounded-xl hover:bg-black transition"
                                >
                                    Cerrar
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Lodging Component
function LodgingPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n(); // Get t() function
    const { addToast } = useToast();
    const [hotels, setHotels] = useState<Hotel[]>([]);
    const [loading, setLoading] = useState(true);
    const [showHotelModal, setShowHotelModal] = useState(false);
    const [showRoomModal, setShowRoomModal] = useState<number | null>(null);
    const [hotelForm, setHotelForm] = useState<Partial<Hotel>>({ name: '', address: '' });
    const [roomForm, setRoomForm] = useState<Partial<Room>>({ room_number: '', capacity: 2, notes: '' });
    const [isBulk, setIsBulk] = useState(false);
    const [bulkConfig, setBulkConfig] = useState({ start: 1, end: 10, prefix: '' });

    const fetchHotels = async () => {
        if (!conferenceId) return;
        setLoading(true);
        try {
            const data = await conferenceApi.getHotels(conferenceId);
            setHotels(data);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchHotels();
    }, [conferenceId]);

    const handleHotelSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!conferenceId) return;
        try {
            await conferenceApi.createHotel(conferenceId, hotelForm);
            setShowHotelModal(false);
            setHotelForm({ name: '', address: '' });
            fetchHotels();
            addToast(t('hotel.created'), 'success');
        } catch (error: any) {
            addToast(error.message || 'Error creating hotel', 'error');
        }
    };

    const handleRoomSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!showRoomModal) return;
        try {
            if (isBulk) {
                const start = Number(bulkConfig.start);
                const end = Number(bulkConfig.end);

                if (start > end) throw new Error('Start number cannot be greater than end number');
                if (end - start > 100) throw new Error('Maximum 100 rooms at once');

                for (let i = start; i <= end; i++) {
                    const roomNumber = `${bulkConfig.prefix}${i}`;
                    await conferenceApi.createRoom({
                        ...roomForm,
                        hotel_id: showRoomModal,
                        room_number: roomNumber
                    });
                }
                addToast(t('rooms.created'), 'success');
            } else {
                await conferenceApi.createRoom({ ...roomForm, hotel_id: showRoomModal });
                addToast(t('room.created'), 'success');
            }

            setShowRoomModal(null);
            setRoomForm({ room_number: '', capacity: 2, notes: '' });
            setIsBulk(false);
            fetchHotels();
        } catch (error: any) {
            addToast(error.message || 'Error creating room', 'error');
        }
    };

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            <div className="flex justify-between items-center bg-gray-50/50 p-8 rounded-[32px] border-2 border-white shadow-sm">
                <div>
                    <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{t('hotels.and.rooms')}</h2>
                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Gestión de alojamiento y disponibilidad</p>
                </div>
                <button
                    onClick={() => setShowHotelModal(true)}
                    className="bg-gray-900 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 transition-all duration-500 shadow-xl hover:shadow-blue-500/30 flex items-center gap-3 transform active:scale-95 translate-y-0 hover:-translate-y-1"
                >
                    <i className="fa-solid fa-plus text-[8px]"></i> {t('add.hotel')}
                </button>
            </div>

            {loading ? (
                <div className="flex-1 flex flex-col justify-center items-center py-20 bg-white rounded-3xl border border-gray-100">
                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-gray-400 mt-4 text-xs font-bold uppercase tracking-widest">{t('loading.lodging')}</p>
                </div>
            ) : hotels.map(hotel => (
                <div key={hotel.id} className="group bg-white rounded-[40px] border-2 border-gray-50 overflow-hidden shadow-sm hover:border-blue-500 hover:shadow-2xl transition-all duration-500 relative">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-blue-50 to-transparent rounded-bl-[100px] opacity-50 pointer-events-none"></div>

                    <div className="relative p-8 border-b border-gray-50 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                        <div className="flex items-center gap-6">
                            <div className="w-20 h-20 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl shadow-inner flex items-center justify-center text-blue-600 text-3xl group-hover:scale-110 transition-transform duration-500">
                                <i className="fa-solid fa-hotel"></i>
                            </div>
                            <div>
                                <h3 className="text-3xl font-black text-gray-900 italic tracking-tighter leading-none mb-2">{hotel.name}</h3>
                                <div className="flex flex-wrap items-center gap-4">
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-100">
                                        <i className="fa-solid fa-location-dot text-[10px] text-gray-400"></i>
                                        <span className="text-xs font-bold text-gray-600 uppercase tracking-widest">{hotel.address}</span>
                                    </div>
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 rounded-lg border border-blue-100 text-blue-600">
                                        <i className="fa-solid fa-users text-[10px]"></i>
                                        <span className="text-xs font-black uppercase tracking-widest">
                                            {t('capacity')}: {hotel.rooms?.reduce((acc, r) => acc + (r.capacity || 0), 0) || 0}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={() => setShowRoomModal(hotel.id)}
                            className="bg-white border-2 border-gray-100 px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-500 hover:border-blue-500 hover:text-white hover:bg-blue-600 transition-all flex items-center gap-2 shadow-sm"
                        >
                            <i className="fa-solid fa-plus text-[8px]"></i> {t('add.room')}
                        </button>
                    </div>

                    <div className="p-8 bg-gray-50/30">
                        {(!hotel.rooms || hotel.rooms.length === 0) ? (
                            <div className="flex flex-col items-center justify-center py-16 text-gray-300 border-2 border-dashed border-gray-200 rounded-3xl bg-white/50">
                                <i className="fa-solid fa-door-closed text-4xl mb-4 opacity-30"></i>
                                <p className="text-xs font-black uppercase tracking-widest opacity-60">{t('no.rooms')}</p>
                                <p className="text-[10px] uppercase tracking-widest opacity-40 mt-1">Añade habitaciones para comenzar</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                {hotel.rooms.map(room => {
                                    const isFull = room.capacity === (room.occupied || 0);
                                    const occupancyPercent = ((room.occupied || 0) / room.capacity) * 100;

                                    return (
                                        <div key={room.id} className={`
                                            group/room p-5 rounded-3xl border-2 transition-all duration-300 relative overflow-hidden flex flex-col justify-between h-32
                                            ${isFull
                                                ? 'bg-white border-rose-100 shadow-sm opacity-80'
                                                : 'bg-white border-white shadow-sm hover:border-blue-400 hover:shadow-xl hover:-translate-y-1'}
                                        `}>
                                            <div className="flex justify-between items-start z-10">
                                                <span className="font-black text-xl text-gray-900 italic tracking-tighter">{room.room_number}</span>
                                                {room.notes && (
                                                    <div className="w-5 h-5 rounded-full bg-blue-50 flex items-center justify-center text-blue-400 group-hover/room:bg-blue-100 transition-colors" title={room.notes}>
                                                        <i className="fa-solid fa-info text-[8px]"></i>
                                                    </div>
                                                )}
                                            </div>

                                            <div className="space-y-3 z-10">
                                                <div className="flex justify-between items-end">
                                                    <span className={`text-[10px] font-black uppercase tracking-widest ${isFull ? 'text-rose-500' : 'text-gray-400'}`}>
                                                        {isFull ? 'Completa' : 'Libre'}
                                                    </span>
                                                    <span className="text-xs font-bold text-gray-900">
                                                        {room.occupied || 0}<span className="text-gray-300">/</span>{room.capacity}
                                                    </span>
                                                </div>

                                                <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full rounded-full transition-all duration-500 ${isFull ? 'bg-rose-500' : 'bg-blue-500'}`}
                                                        style={{ width: `${occupancyPercent}%` }}
                                                    ></div>
                                                </div>
                                            </div>

                                            {/* Decor */}
                                            {isFull && <div className="absolute inset-0 bg-rose-50/10 pointer-events-none"></div>}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            ))}

            {showHotelModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-10 py-8 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter">{t('add.hotel')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Registra un nuevo alojamiento</p>
                            </div>
                            <button onClick={() => setShowHotelModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl">
                                <i className="fa-solid fa-xmark text-xl"></i>
                            </button>
                        </div>
                        <form onSubmit={handleHotelSubmit} className="p-10 space-y-6">
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('hotel.name')}</label>
                                <input
                                    required
                                    placeholder="Ej. Hotel Central"
                                    className="w-full border-2 border-gray-100 rounded-2xl px-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                    value={hotelForm.name}
                                    onChange={e => setHotelForm({ ...hotelForm, name: e.target.value })}
                                    autoFocus
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('hotel.address')}</label>
                                <div className="relative">
                                    <i className="fa-solid fa-location-dot absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                    <input
                                        placeholder="Dirección completa"
                                        className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                        value={hotelForm.address}
                                        onChange={e => setHotelForm({ ...hotelForm, address: e.target.value })}
                                    />
                                </div>
                            </div>
                            <div className="flex gap-4 pt-6">
                                <button
                                    type="button"
                                    onClick={() => setShowHotelModal(false)}
                                    className="flex-1 px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest text-gray-400 hover:bg-gray-100 transition-all"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    type="submit"
                                    className="flex-[2] bg-gray-900 text-white px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transition-all transform active:scale-95"
                                >
                                    {t('save') || 'Crear Hotel'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {showRoomModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-10 py-8 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter">{t('add.room')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Configura nuevas habitaciones</p>
                            </div>
                            <button onClick={() => setShowRoomModal(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl">
                                <i className="fa-solid fa-xmark text-xl"></i>
                            </button>
                        </div>

                        <div className="px-10 pt-8">
                            <div className="flex bg-gray-50 p-1.5 rounded-xl border border-gray-100">
                                <button
                                    type="button"
                                    onClick={() => setIsBulk(false)}
                                    className={`flex-1 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${!isBulk
                                        ? 'bg-white shadow-md text-blue-600 ring-1 ring-black/5'
                                        : 'text-gray-400 hover:text-gray-600'
                                        }`}
                                >
                                    {t('room.individual.mode')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsBulk(true)}
                                    className={`flex-1 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isBulk
                                        ? 'bg-white shadow-md text-blue-600 ring-1 ring-black/5'
                                        : 'text-gray-400 hover:text-gray-600'
                                        }`}
                                >
                                    {t('room.bulk.mode')}
                                </button>
                            </div>
                        </div>

                        <form onSubmit={handleRoomSubmit} className="p-10 space-y-6">
                            {isBulk ? (
                                <div className="space-y-6">
                                    <div className="grid grid-cols-3 gap-4">
                                        <div className="col-span-1 space-y-2">
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.prefix')}</label>
                                            <input
                                                placeholder="Ej: A-"
                                                className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-300 text-center"
                                                value={bulkConfig.prefix}
                                                onChange={e => setBulkConfig({ ...bulkConfig, prefix: e.target.value })}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.range.start')}</label>
                                            <input
                                                type="number"
                                                required
                                                className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold text-center"
                                                value={bulkConfig.start}
                                                onChange={e => setBulkConfig({ ...bulkConfig, start: Number(e.target.value) })}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.range.end')}</label>
                                            <input
                                                type="number"
                                                required
                                                className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold text-center"
                                                value={bulkConfig.end}
                                                onChange={e => setBulkConfig({ ...bulkConfig, end: Number(e.target.value) })}
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.capacity')}</label>
                                        <div className="relative">
                                            <i className="fa-solid fa-users absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                            <input
                                                type="number"
                                                placeholder={t('room.capacity')}
                                                className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                                value={roomForm.capacity}
                                                onChange={e => setRoomForm({ ...roomForm, capacity: Number(e.target.value) })}
                                            />
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.number')}</label>
                                        <div className="relative">
                                            <i className="fa-solid fa-tag absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                            <input
                                                required
                                                placeholder="Ej. 101"
                                                className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                                value={roomForm.room_number}
                                                onChange={e => setRoomForm({ ...roomForm, room_number: e.target.value })}
                                                autoFocus
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.capacity')}</label>
                                        <div className="relative">
                                            <i className="fa-solid fa-users absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                            <input
                                                type="number"
                                                placeholder="2"
                                                className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                                value={roomForm.capacity}
                                                onChange={e => setRoomForm({ ...roomForm, capacity: Number(e.target.value) })}
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.notes')}</label>
                                <textarea
                                    className="w-full border-2 border-gray-100 rounded-2xl px-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200 text-sm resize-none"
                                    rows={2}
                                    placeholder="Ej: Camas dobles, aire acondicionado..."
                                    value={roomForm.notes || ''}
                                    onChange={e => setRoomForm({ ...roomForm, notes: e.target.value })}
                                />
                            </div>
                            <div className="flex gap-4 pt-6">
                                <button
                                    type="button"
                                    onClick={() => setShowRoomModal(null)}
                                    className="flex-1 px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest text-gray-400 hover:bg-gray-100 transition-all"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    type="submit"
                                    className="flex-[2] bg-gray-900 text-white px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transition-all transform active:scale-95"
                                >
                                    {t('add.room')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

// Reports Component
function ReportsPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] animate-in fade-in zoom-in-95 duration-700">
            <div className="relative group">
                {/* Decorative background blur */}
                <div className="absolute inset-0 bg-blue-500/20 blur-[60px] rounded-full group-hover:bg-indigo-500/30 transition-all duration-1000"></div>

                <div className="relative bg-white p-12 rounded-[40px] shadow-2xl shadow-blue-100/50 border border-gray-100 text-center max-w-sm">
                    <div className="w-24 h-24 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-3xl flex items-center justify-center text-white text-4xl shadow-xl shadow-blue-200 mx-auto mb-8 transform -rotate-6 hover:rotate-0 transition-all duration-500">
                        <i className="fa-solid fa-chart-line"></i>
                    </div>

                    <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter mb-4">{t('reports.title') || 'Informes Avanzados'}</h2>

                    <p className="text-gray-400 font-medium leading-relaxed mb-8">
                        {t('reports.coming.soon.desc') || 'Estamos preparando un motor de reportes potente para que puedas exportar y analizar toda tu información.'}
                    </p>

                    <div className="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-50 rounded-2xl border border-gray-100">
                        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                        <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{t('coming.soon') || 'Próximamente'}</span>
                    </div>

                    <div className="mt-10 grid grid-cols-3 gap-4 opacity-30 grayscale pointer-events-none">
                        <div className="h-2 bg-gray-200 rounded-full"></div>
                        <div className="h-2 bg-gray-200 rounded-full"></div>
                        <div className="h-2 bg-gray-200 rounded-full"></div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Fields Component
function FieldsPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [conference, setConference] = useState<Conference | null>(null);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [formData, setFormData] = useState<Partial<ConferenceField>>({
        name: '', label: '', type: 'text', options: '', is_required: 0, sort_order: 0, width: 100
    });
    const [openSelect, setOpenSelect] = useState<'type' | 'required' | null>(null);

    const FIELD_TYPES = [
        { value: 'text', label: t('type.text'), icon: 'fa-font', color: 'text-blue-500', bg: 'bg-blue-50' },
        { value: 'number', label: t('type.number'), icon: 'fa-hashtag', color: 'text-indigo-500', bg: 'bg-indigo-50' },
        { value: 'select', label: t('type.select'), icon: 'fa-list-ul', color: 'text-purple-500', bg: 'bg-purple-50' },
        { value: 'date', label: t('type.date'), icon: 'fa-calendar-day', color: 'text-orange-500', bg: 'bg-orange-50' }
    ];

    const loadData = async () => {
        setLoading(true);
        try {
            const [fieldsData, locData] = await Promise.all([
                conferenceApi.getFields(conferenceId),
                conferenceApi.getLocations(conferenceId)
            ]);
            setFields(fieldsData);
            setConference(locData.conference);
        } catch (e) {
            addToast('Error loading fields', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadData(); }, [conferenceId]);

    const { confirm } = useModal();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const dataToSave = { ...formData, conference_id: conferenceId };
            // Generate a unique key if it's a new field
            if (!dataToSave.id && !dataToSave.name) {
                const randomPart = Math.random().toString(36).substring(2, 7);
                dataToSave.name = `f_${Date.now().toString().slice(-6)}_${randomPart}`;
            }
            await conferenceApi.saveField(dataToSave);
            addToast('Field saved', 'success');
            setShowModal(false);
            setFormData({ name: '', label: '', type: 'text', options: '', is_required: 0, sort_order: 0, width: 100 });
            loadData();
        } catch (e: any) {
            addToast(e.error || 'Error saving field', 'error');
        }
    };

    const handleDelete = async (id: number) => {
        if (!await confirm('Delete this field?', 'Delete Field', true)) return;
        try {
            await conferenceApi.deleteField(id);
            addToast('Field deleted', 'success');
            loadData();
        } catch (e: any) {
            addToast(e.error || 'Error deleting field', 'error');
        }
    };

    const handleMove = async (field: ConferenceField, direction: 'up' | 'down') => {
        const index = fields.findIndex(f => f.id === field.id);
        if (direction === 'up' && index === 0) return;
        if (direction === 'down' && index === fields.length - 1) return;

        const newFields = [...fields];
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        [newFields[index], newFields[swapIndex]] = [newFields[swapIndex], newFields[index]];

        // Update sort orders and save all
        try {
            await Promise.all(newFields.map((f, i) =>
                conferenceApi.saveField({ ...f, sort_order: i, conference_id: conferenceId })
            ));
            loadData();
        } catch (e) {
            addToast('Error reordering fields', 'error');
        }
    };

    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

    const handleDragStart = (idx: number) => {
        if (isPublished) return;
        setDraggedIndex(idx);
    };

    const handleDragOver = (e: React.DragEvent, idx: number) => {
        e.preventDefault();
        if (isPublished || draggedIndex === null || draggedIndex === idx) return;

        const newFields = [...fields];
        const draggedItem = newFields[draggedIndex];
        newFields.splice(draggedIndex, 1);
        newFields.splice(idx, 0, draggedItem);
        setFields(newFields);
        setDraggedIndex(idx);
    };

    const handleDragEnd = async () => {
        if (isPublished) return;
        setDraggedIndex(null);
        try {
            await Promise.all(fields.map((f, i) =>
                conferenceApi.saveField({ ...f, sort_order: i, conference_id: conferenceId })
            ));
            addToast('Orden actualizado', 'success');
        } catch (e) {
            addToast('Error al guardar el nuevo orden', 'error');
            loadData();
        }
    };

    const handlePublish = async () => {
        { /* ... existing logic ... */ }
        const isPublished = !!conference?.is_form_published;
        if (!isPublished && fields.length === 0) {
            addToast("No puedes publicar un formulario sin campos.", "error");
            return;
        }

        const msg = isPublished
            ? "¿Seguro que quieres despublicar el formulario?"
            : "¿Seguro que quieres publicar el formulario? Los campos no se podrán añadir ni eliminar después.";

        if (await confirm(msg, isPublished ? 'Despublicar Formulario' : 'Publicar Formulario', isPublished)) {
            try {
                await conferenceApi.publishForm(conferenceId, !isPublished);
                addToast(isPublished ? "Formulario despublicado" : "Formulario publicado", "success");
                loadData();
            } catch (e) {
                addToast("Error al cambiar el estado de publicación", "error");
            }
        }
    };

    const isPublished = !!conference?.is_form_published;

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            {/* Premium Publisher Card */}
            <div className={`group relative overflow-hidden rounded-[40px] p-10 border-2 transition-all duration-500 shadow-2xl ${isPublished
                ? 'bg-emerald-50/50 border-emerald-100 shadow-emerald-100/30'
                : 'bg-white border-gray-100 shadow-gray-200/50'
                }`}>
                <div className={`absolute -right-20 -top-20 w-80 h-80 rounded-full blur-[100px] opacity-30 transition-all duration-1000 group-hover:scale-125 ${isPublished ? 'bg-emerald-400' : 'bg-blue-400'
                    }`}></div>
                <div className={`absolute -left-20 -bottom-20 w-64 h-64 rounded-full blur-[100px] opacity-20 ${isPublished ? 'bg-teal-300' : 'bg-indigo-300'
                    }`}></div>

                <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-10">
                    <div className="flex-1">
                        <div className="flex items-center gap-4 mb-5">
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-xl transition-transform duration-500 group-hover:scale-110 ${isPublished ? 'bg-emerald-500 text-white shadow-emerald-200' : 'bg-blue-600 text-white shadow-blue-200'
                                }`}>
                                <i className={`fa-solid ${isPublished ? 'fa-check-double' : 'fa-wand-magic-sparkles'}`}></i>
                            </div>
                            <div>
                                <h3 className={`font-black text-3xl italic tracking-tighter ${isPublished ? 'text-emerald-900' : 'text-gray-900'}`}>
                                    {t('visual.form.builder') || 'Visual Form Builder'}
                                </h3>
                                {isPublished && (
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                        <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">
                                            {t('form.live') || 'Formulario en Vivo'}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <p className={`text-base font-medium leading-relaxed max-w-xl ${isPublished ? 'text-emerald-800/70' : 'text-gray-500'}`}>
                            {isPublished
                                ? 'El formulario está activo y recibiendo inscripciones. Los campos están bloqueados para mantener la integridad de los datos.'
                                : 'Crea una experiencia de registro única. Diseña el formulario y observa los cambios instantáneamente en el simulador a la derecha.'}
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        <button
                            onClick={handlePublish}
                            className={`px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all duration-500 flex items-center gap-3 shadow-xl transform active:scale-95 ${isPublished
                                ? 'bg-white text-orange-600 hover:bg-orange-50 border-2 border-orange-100 hover:border-orange-200 shadow-orange-100/50'
                                : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-500/30'
                                }`}
                        >
                            <i className={`fa-solid ${isPublished ? 'fa-eye-slash' : 'fa-paper-plane'} text-[8px]`}></i>
                            {isPublished ? 'Despublicar' : 'Publicar'}
                        </button>
                        {!isPublished && (
                            <button
                                onClick={() => setShowModal(true)}
                                className="bg-gray-900 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 transition-all duration-500 shadow-xl hover:shadow-blue-500/30 flex items-center gap-3 transform active:scale-95 translate-y-0 hover:-translate-y-1"
                            >
                                <i className="fa-solid fa-plus text-[8px]"></i> {t('add.field')}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                {/* Left: Management List */}
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h4 className="font-bold text-gray-700 text-sm uppercase tracking-wider">Estructura de Campos</h4>
                        <span className="text-xs text-gray-400">{fields.length} campos definidos</span>
                    </div>

                    <div className="space-y-3">
                        {loading ? (
                            <div className="p-20 text-center bg-white border border-gray-100 rounded-3xl">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                                <p className="text-gray-400 mt-4 text-xs font-bold uppercase tracking-widest">Cargando campos...</p>
                            </div>
                        ) : fields.length === 0 ? (
                            <div className="p-20 text-center bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl">
                                <i className="fa-solid fa-layer-group text-4xl text-gray-200 mb-4"></i>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">No hay campos configurados</p>
                                <p className="text-[10px] text-gray-400 mt-2">Los campos que añadas aparecerán aquí.</p>
                            </div>
                        ) : fields.map((field, idx) => (
                            <div
                                key={field.id}
                                draggable={!isPublished}
                                onDragStart={() => handleDragStart(idx)}
                                onDragOver={(e) => handleDragOver(e, idx)}
                                onDragEnd={handleDragEnd}
                                className={`bg-white border-2 rounded-2xl p-4 flex items-center justify-between group transition-all duration-300 shadow-sm ${draggedIndex === idx ? 'opacity-50 border-blue-500 scale-95 shadow-inner' : 'border-gray-50 hover:border-blue-500 hover:shadow-xl hover:-translate-y-1'} ${!isPublished ? 'cursor-grab active:cursor-grabbing' : ''}`}
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-xl bg-gray-50 text-gray-300 group-hover:bg-blue-50 group-hover:text-blue-500 flex items-center justify-center transition-colors">
                                        <i className="fa-solid fa-grip-vertical"></i>
                                    </div>
                                    <div>
                                        <div className="font-black text-gray-900 italic tracking-tight">{field.label}</div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <span className="text-[10px] text-blue-600 font-bold uppercase bg-blue-50 px-2 py-0.5 rounded shadow-sm">{field.type}</span>
                                            {field.is_required ? (
                                                <span className="text-[10px] text-rose-500 font-bold uppercase bg-rose-50 px-2 py-0.5 rounded shadow-sm">Obligatorio</span>
                                            ) : (
                                                <span className="text-[10px] text-gray-400 font-bold uppercase bg-gray-50 px-2 py-0.5 rounded">Opcional</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-x-2 group-hover:translate-x-0">
                                    <button onClick={() => { setFormData(field); setShowModal(true); }} className="w-9 h-9 flex items-center justify-center bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white rounded-xl transition-all shadow-sm" title="Editar"><i className="fa-solid fa-pen text-xs"></i></button>
                                    {!isPublished && !['first_name', 'last_name', 'email', 'phone', 'gender', 'location', 'family_group'].includes(field.name) && (
                                        <button onClick={() => handleDelete(field.id)} className="w-9 h-9 flex items-center justify-center bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white rounded-xl transition-all shadow-sm" title="Eliminar"><i className="fa-solid fa-trash text-xs"></i></button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="sticky top-6">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                            <h4 className="font-black text-gray-900 italic tracking-tight">{t('live.preview')}</h4>
                        </div>
                        <div className="flex gap-1.5 p-1 bg-gray-100 rounded-lg">
                            <div className="w-2.5 h-2.5 rounded-full bg-gray-300"></div>
                            <div className="w-2.5 h-2.5 rounded-full bg-gray-300"></div>
                            <div className="w-2.5 h-2.5 rounded-full bg-gray-300"></div>
                        </div>
                    </div>

                    <div className="bg-white border-8 border-gray-900 rounded-[3rem] shadow-2xl overflow-hidden min-h-[600px] flex flex-col relative">
                        {/* Notch decoration */}
                        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-gray-900 rounded-b-2xl z-20"></div>

                        <div className="bg-gradient-to-br from-blue-600 to-indigo-700 p-8 pt-12 text-white text-center relative overflow-hidden">
                            <div className="absolute -right-10 -top-10 w-32 h-32 bg-white/10 rounded-full blur-2xl"></div>
                            <h5 className="font-black text-2xl italic tracking-tight relative z-10">Inscripción</h5>
                            <p className="text-xs font-bold uppercase tracking-widest opacity-60 mt-1 relative z-10">{conference?.name || 'Nombre de la Conferencia'}</p>
                        </div>

                        <div className="p-8 space-y-6 flex-1 bg-white relative">
                            {fields.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-gray-300 text-center p-10 mt-12 bg-gray-50/50 rounded-3xl border-2 border-dashed border-gray-100 mx-4">
                                    <i className="fa-solid fa-wand-sparkles text-5xl mb-4 opacity-10"></i>
                                    <p className="text-xs font-bold uppercase tracking-widest leading-relaxed">El formulario está desierto.<br /><span className="opacity-50 font-medium lowercase italic">Añade campos para empezar</span></p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-x-5 gap-y-5">
                                    {fields.map(f => (
                                        <div key={f.id} className={`space-y-1.5 ${f.width === 50 ? 'col-span-1' : 'col-span-2'}`}>
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">
                                                {f.label} {f.is_required ? <span className="text-rose-500">*</span> : ''}
                                            </label>
                                            {f.type === 'select' ? (
                                                <div className="relative">
                                                    <div className="w-full border-2 border-gray-100 rounded-2xl p-3 bg-gray-50/30 text-xs font-medium text-gray-400 flex justify-between items-center italic">
                                                        {f.options?.split(',')[0].trim() || 'Seleccione...'}
                                                        <i className="fa-solid fa-chevron-down text-[10px]"></i>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="w-full border-2 border-gray-100 rounded-2xl p-3 bg-gray-50/30 text-xs font-medium text-gray-400 italic">
                                                    {f.type === 'date' ? 'AAAA-MM-DD' : `Ingrese ${f.label.toLowerCase()}...`}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                    <div className="col-span-2 pt-4">
                                        <div className="w-full bg-blue-600 text-white font-black text-xs uppercase tracking-widest py-4 rounded-2xl shadow-lg shadow-blue-500/30 text-center">
                                            Enviar Inscripción
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="p-6 bg-gray-50/50 border-t border-gray-50 text-[10px] text-center text-gray-400 font-bold uppercase tracking-widest">
                            WordJS Preview System
                        </div>
                    </div>
                </div>
            </div>

            {
                showModal && (
                    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-[100] flex items-start justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
                        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-gray-100 animate-in zoom-in-95 duration-200 relative my-auto overflow-visible">
                            <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                                <div>
                                    <h3 className="font-bold text-xl text-gray-900">{formData.id ? 'Editar Campo' : 'Nuevo Campo'}</h3>
                                    <p className="text-xs text-gray-500 mt-0.5">Configura las propiedades de este campo personalizado</p>
                                </div>
                                <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                    <i className="fa-solid fa-xmark text-lg"></i>
                                </button>
                            </div>

                            <form onSubmit={handleSubmit} className="p-8 space-y-5 overflow-visible pb-20">
                                <div className="space-y-1.5">
                                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">{t('field.label')}</label>
                                    <div className="relative group">
                                        <input
                                            required
                                            className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all outline-none text-gray-900 placeholder:text-gray-300 font-medium"
                                            value={formData.label}
                                            onChange={e => setFormData({ ...formData, label: e.target.value })}
                                            placeholder="Ej: ¿Cuál es su talle de camisa?"
                                        />
                                    </div>
                                </div>

                                {formData.id && (
                                    <div className="space-y-1.5 opacity-60">
                                        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">ID del Sistema</label>
                                        <div className="flex items-center gap-2 bg-gray-50 px-4 py-2 rounded-xl border border-gray-100">
                                            <i className="fa-solid fa-code text-xs text-gray-400"></i>
                                            <span className="text-xs font-mono text-gray-500">{formData.name}</span>
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-2 gap-5">
                                    <div className="space-y-1.5 relative">
                                        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">{t('field.type')}</label>
                                        <button
                                            type="button"
                                            onClick={() => setOpenSelect(openSelect === 'type' ? null : 'type')}
                                            className={`w-full flex items-center justify-between border-2 rounded-xl px-4 py-3 transition-all outline-none font-medium ${openSelect === 'type' ? 'bg-white border-blue-500 ring-4 ring-blue-500/10' : 'bg-gray-50/30 border-gray-100 hover:border-gray-200'}`}
                                        >
                                            <div className="flex items-center gap-3">
                                                {(() => {
                                                    const current = FIELD_TYPES.find(t => t.value === formData.type);
                                                    return (
                                                        <>
                                                            <div className={`w-6 h-6 rounded-lg ${current?.bg} flex items-center justify-center`}>
                                                                <i className={`fa-solid ${current?.icon} text-xs ${current?.color}`}></i>
                                                            </div>
                                                            <span className="text-gray-900">{current?.label}</span>
                                                        </>
                                                    )
                                                })()}
                                            </div>
                                            <i className={`fa-solid fa-chevron-down text-xs text-gray-400 transition-transform ${openSelect === 'type' ? 'rotate-180' : ''}`}></i>
                                        </button>

                                        {openSelect === 'type' && (
                                            <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-100 rounded-2xl shadow-xl z-50 p-2 animate-in slide-in-from-top-2 duration-200 overflow-hidden">
                                                {FIELD_TYPES.map(type => (
                                                    <button
                                                        key={type.value}
                                                        type="button"
                                                        onClick={() => { setFormData({ ...formData, type: type.value as any }); setOpenSelect(null); }}
                                                        className={`w-full flex items-center gap-4 p-3 rounded-xl transition-colors ${formData.type === type.value ? 'bg-blue-50/50 text-blue-700' : 'hover:bg-gray-50 text-gray-600'}`}
                                                    >
                                                        <div className={`w-8 h-8 rounded-xl ${type.bg} flex items-center justify-center group-hover:scale-110 transition-transform`}>
                                                            <i className={`fa-solid ${type.icon} text-sm ${type.color}`}></i>
                                                        </div>
                                                        <div className="text-left">
                                                            <div className="font-bold text-sm leading-none">{type.label}</div>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="space-y-1.5 relative">
                                        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">{t('field.required')}</label>
                                        <button
                                            type="button"
                                            onClick={() => setOpenSelect(openSelect === 'required' ? null : 'required')}
                                            className={`w-full flex items-center justify-between border-2 rounded-xl px-4 py-3 transition-all outline-none font-medium ${openSelect === 'required' ? 'bg-white border-blue-500 ring-4 ring-blue-500/10' : 'bg-gray-50/30 border-gray-100 hover:border-gray-200'}`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-6 h-6 rounded-lg ${formData.is_required ? 'bg-rose-50' : 'bg-emerald-50'} flex items-center justify-center`}>
                                                    <i className={`fa-solid ${formData.is_required ? 'fa-asterisk text-rose-500' : 'fa-check text-emerald-500'} text-[10px]`}></i>
                                                </div>
                                                <span className="text-gray-900">{formData.is_required ? 'Obligatorio' : 'Opcional'}</span>
                                            </div>
                                            <i className={`fa-solid fa-chevron-down text-xs text-gray-400 transition-transform ${openSelect === 'required' ? 'rotate-180' : ''}`}></i>
                                        </button>

                                        {openSelect === 'required' && (
                                            <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-100 rounded-2xl shadow-xl z-50 p-2 animate-in slide-in-from-top-2 duration-200">
                                                <button
                                                    type="button"
                                                    onClick={() => { setFormData({ ...formData, is_required: 1 }); setOpenSelect(null); }}
                                                    className={`w-full flex items-center gap-4 p-3 rounded-xl transition-colors ${formData.is_required === 1 ? 'bg-rose-50/50 text-rose-700' : 'hover:bg-gray-50 text-gray-600'}`}
                                                >
                                                    <div className="w-8 h-8 rounded-xl bg-rose-50 flex items-center justify-center">
                                                        <i className="fa-solid fa-asterisk text-xs text-rose-500"></i>
                                                    </div>
                                                    <div className="font-bold text-sm">Obligatorio</div>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setFormData({ ...formData, is_required: 0 }); setOpenSelect(null); }}
                                                    className={`w-full flex items-center gap-4 p-3 rounded-xl transition-colors ${formData.is_required === 0 ? 'bg-emerald-50/50 text-emerald-700' : 'hover:bg-gray-50 text-gray-600'}`}
                                                >
                                                    <div className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center">
                                                        <i className="fa-solid fa-check text-xs text-emerald-500"></i>
                                                    </div>
                                                    <div className="font-bold text-sm">Opcional</div>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-1.5 overflow-visible">
                                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Ancho del Campo</label>
                                    <div className="grid grid-cols-2 gap-3">
                                        <button
                                            type="button"
                                            onClick={() => setFormData({ ...formData, width: 100 })}
                                            className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all ${formData.width === 100 ? 'border-blue-500 bg-blue-50/30' : 'border-gray-100 bg-gray-50/30 hover:border-gray-200'}`}
                                        >
                                            <div className="w-full h-8 bg-gray-200 rounded flex items-center px-1">
                                                <div className="w-full h-4 bg-blue-400 rounded"></div>
                                            </div>
                                            <span className={`text-xs font-bold ${formData.width === 100 ? 'text-blue-700' : 'text-gray-500'}`}>100% Ancho</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setFormData({ ...formData, width: 50 })}
                                            className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all ${formData.width === 50 ? 'border-blue-500 bg-blue-50/30' : 'border-gray-100 bg-gray-50/30 hover:border-gray-200'}`}
                                        >
                                            <div className="w-full h-8 bg-gray-200 rounded flex items-center px-1 gap-1">
                                                <div className="w-1/2 h-4 bg-blue-400 rounded"></div>
                                                <div className="w-1/2 h-4 bg-gray-300 rounded opacity-30"></div>
                                            </div>
                                            <span className={`text-xs font-bold ${formData.width === 50 ? 'text-blue-700' : 'text-gray-500'}`}>50% Ancho</span>
                                        </button>
                                    </div>
                                </div>

                                {formData.type === 'select' && (
                                    <div className="space-y-1.5 animate-in slide-in-from-top-2 duration-300">
                                        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">{t('field.options')}</label>
                                        <input
                                            className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 placeholder:text-gray-300 font-medium"
                                            value={formData.options}
                                            onChange={e => setFormData({ ...formData, options: e.target.value })}
                                            placeholder="Pequeña, Mediana, Grande"
                                        />
                                        <p className="text-[10px] text-gray-400 px-1 italic">* Separa las opciones por comas</p>
                                    </div>
                                )}

                                <div className="flex items-center justify-end gap-3 pt-6">
                                    <button
                                        type="button"
                                        onClick={() => setShowModal(false)}
                                        className="px-6 py-3 text-gray-500 font-bold hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-all"
                                    >
                                        {t('cancel')}
                                    </button>
                                    <button
                                        type="submit"
                                        className="px-8 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold shadow-lg shadow-blue-500/20 active:scale-95 transition-all flex items-center gap-2"
                                    >
                                        <span>{t('save')}</span>
                                        <i className="fa-solid fa-check text-sm opacity-50"></i>
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )
            }
        </div >
    );
}

const INSCRIPTION_FIELDS: string[] = [];

// Assignment Component
function AssignmentPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [rules, setRules] = useState<AssignmentRule[]>([]);
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [stats, setStats] = useState({ total: 0, assigned: 0, unassigned: 0 });
    const [running, setRunning] = useState(false);
    const [loading, setLoading] = useState(true);
    const [showRuleModal, setShowRuleModal] = useState(false);
    const [ruleForm, setRuleForm] = useState<Partial<AssignmentRule>>({
        name: '', type: 'group_together', enabled: 1, priority: 50, config: 'family_group'
    });

    const loadData = async () => {
        setLoading(true);
        try {
            const [rulesData, inscriptions, fieldsData] = await Promise.all([
                conferenceApi.getAssignmentRules(conferenceId),
                conferenceApi.getInscriptions(conferenceId),
                conferenceApi.getFields(conferenceId)
            ]);

            setFields(fieldsData);

            // If no rules exist, initialize default ones
            if (rulesData.length === 0) {
                const defaults: Partial<AssignmentRule>[] = [
                    { conference_id: conferenceId, name: t('rule.family'), type: 'group_together', enabled: 1, priority: 90, config: 'family_group' },
                    { conference_id: conferenceId, name: t('rule.gender'), type: 'exclusive', enabled: 1, priority: 80, config: 'gender' },
                ];
                for (const d of defaults) {
                    await conferenceApi.saveAssignmentRule(d);
                }
                const newRules = await conferenceApi.getAssignmentRules(conferenceId);
                setRules(newRules);
            } else {
                setRules(rulesData);
            }

            const assigned = inscriptions.filter(i => i.room_id).length;
            setStats({
                total: inscriptions.length,
                assigned,
                unassigned: inscriptions.length - assigned
            });
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, [conferenceId]);

    const handleSaveRule = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await conferenceApi.saveAssignmentRule({ ...ruleForm, conference_id: conferenceId });
            setShowRuleModal(false);
            setRuleForm({ name: '', type: 'group_together', enabled: 1, priority: 50, config: 'family_group' });
            loadData();
        } catch (e) {
            addToast('Error saving rule', 'error');
        }
    };

    const handleToggleRule = async (rule: AssignmentRule) => {
        try {
            await conferenceApi.saveAssignmentRule({ ...rule, enabled: rule.enabled ? 0 : 1 });
            loadData();
        } catch (e) {
            addToast('Error updating rule', 'error');
        }
    };

    const { confirm } = useModal();

    const handleRun = async () => {
        setRunning(true);
        addToast(t('assignment.started'), 'info');
        try {
            const result = await conferenceApi.runAssignment(conferenceId);
            addToast(`${t('assignment.completed')}: ${result.assignedCount} ${t('participant.plural')}`, 'success');
            loadData();
        } catch (e: any) {
            addToast(e.message || 'Error running assignment', 'error');
        } finally {
            setRunning(false);
        }
    };

    const handleReset = async () => {
        if (!await confirm(t('confirm.reset.assignments') || 'Reset all assignments?', t('reset.assignments') || "Reset Assignments", true)) return;
        try {
            await conferenceApi.resetAssignments(conferenceId);
            addToast(t('assignment.reset.done'), 'success');
            loadData();
        } catch (e) {
            addToast('Error resetting assignments', 'error');
        }
    };

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            {/* Premium Header & Summary */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-indigo-50/50 rounded-full blur-3xl"></div>

                <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-8">
                    <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-200">
                                <i className="fa-solid fa-wand-magic-sparkles"></i>
                            </div>
                            <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-[0.2em]">{t('assignment')}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter mb-4">{t('auto.assignment.title') || 'Asignación Automática'}</h2>

                        <div className="flex flex-wrap items-center gap-6">
                            <div className="bg-gray-50/80 px-5 py-3 rounded-2xl border border-gray-100 flex items-center gap-4">
                                <div className="text-center">
                                    <div className="text-sm font-black text-gray-900 leading-none">{stats.total}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">Total</div>
                                </div>
                                <div className="w-px h-6 bg-gray-200"></div>
                                <div className="text-center">
                                    <div className="text-sm font-black text-emerald-600 leading-none">{stats.assigned}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">Asignados</div>
                                </div>
                                <div className="w-px h-6 bg-gray-200"></div>
                                <div className="text-center">
                                    <div className="text-sm font-black text-amber-600 leading-none">{stats.unassigned}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">Pendientes</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        <button
                            onClick={handleReset}
                            className="px-6 py-4 text-rose-600 font-black text-[10px] uppercase tracking-widest hover:bg-rose-50 rounded-2xl transition-all border-2 border-transparent hover:border-rose-100 flex items-center gap-2 group"
                        >
                            <i className="fa-solid fa-trash-can group-hover:scale-110 transition-transform"></i>
                            {t('reset.all.assignments')}
                        </button>
                        <button
                            onClick={handleRun}
                            disabled={running || stats.unassigned === 0}
                            className={`px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-3 transition-all active:scale-95 shadow-xl ${running || stats.unassigned === 0
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed shadow-none'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-500/30'
                                }`}
                        >
                            {running ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-play text-[8px]"></i>}
                            {t('run.auto.assignment')}
                        </button>
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-3xl border border-gray-100 overflow-hidden shadow-xl shadow-gray-100/30">
                <div className="bg-gray-50/50 border-b border-gray-100 px-8 py-6 flex justify-between items-center">
                    <div>
                        <h3 className="text-sm font-black text-gray-900 uppercase tracking-widest leading-none">{t('assignment.rules')}</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-2">{t('assignment.rules.desc') || 'Criterios para la distribución de habitaciones'}</p>
                    </div>
                    <button
                        onClick={() => setShowRuleModal(true)}
                        className="px-5 py-2.5 bg-white border border-gray-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:bg-indigo-50 hover:border-indigo-200 transition-all flex items-center gap-2"
                    >
                        <i className="fa-solid fa-plus"></i>
                        {t('add.rule')}
                    </button>
                </div>
                <div className="divide-y divide-gray-50">
                    {loading ? (
                        <div className="p-20 text-center">
                            <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('loading')}</p>
                        </div>
                    ) : rules.length === 0 ? (
                        <div className="p-20 text-center">
                            <div className="w-16 h-16 rounded-3xl bg-gray-50 flex items-center justify-center text-gray-300 mx-auto mb-4">
                                <i className="fa-solid fa-list-check text-2xl"></i>
                            </div>
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">No hay reglas configuradas</p>
                        </div>
                    ) : rules.map(rule => (
                        <div key={rule.id} className="group p-6 flex items-center justify-between hover:bg-indigo-50/30 transition-all">
                            <div className="flex items-center gap-5">
                                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-xl shadow-lg transition-all ${rule.enabled
                                    ? 'bg-indigo-600 text-white shadow-indigo-100'
                                    : 'bg-white text-gray-300 border border-gray-100 shadow-none'
                                    }`}>
                                    <i className={`fa-solid ${rule.type === 'group_together' ? 'fa-people-group' : 'fa-shield-halved'} ${!rule.enabled && 'opacity-30'}`}></i>
                                </div>
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-1">
                                        <h4 className={`font-black italic tracking-tighter text-lg ${rule.enabled ? 'text-gray-900' : 'text-gray-400'}`}>{rule.name}</h4>
                                        <div className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest ${rule.type === 'group_together' ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-600'
                                            }`}>
                                            {rule.type === 'group_together' ? 'Agrupar' : 'Excluir'}
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-lg text-[9px] font-bold text-gray-500 uppercase tracking-tight">
                                            <i className="fa-solid fa-bolt text-amber-500"></i>
                                            {t('priority')}: {rule.priority}
                                        </div>
                                        <div className="w-1 h-1 rounded-full bg-gray-200"></div>
                                        <div className="text-[10px] text-gray-500 font-medium whitespace-nowrap overflow-hidden text-ellipsis max-w-[300px]">
                                            {rule.type === 'group_together' ? t('rule.description.group_together') : t('rule.description.exclusive')}
                                            <span className="ml-1 font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded uppercase text-[8px] tracking-widest">
                                                [{t(rule.config) || rule.config}]
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <button
                                    onClick={() => handleToggleRule(rule)}
                                    className={`w-12 h-6 rounded-full transition-all relative ${rule.enabled ? 'bg-emerald-500 shadow-lg shadow-emerald-100' : 'bg-gray-200'}`}
                                >
                                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm ${rule.enabled ? 'left-7' : 'left-1'}`}></div>
                                </button>
                                <button className="w-10 h-10 rounded-xl bg-white border border-gray-100 text-gray-400 hover:text-rose-600 hover:border-rose-100 hover:bg-rose-50 transition-all flex items-center justify-center group/del">
                                    <i className="fa-solid fa-trash-can text-sm group-hover/del:scale-110 transition-transform"></i>
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {showRuleModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-black text-xl text-gray-900 italic tracking-tighter">{t('add.rule')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Configura un nuevo criterio</p>
                            </div>
                            <button onClick={() => setShowRuleModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-xl">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>
                        <form onSubmit={handleSaveRule} className="p-8 space-y-6">
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.name')}</label>
                                <input
                                    required
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm placeholder:text-gray-300"
                                    value={ruleForm.name}
                                    onChange={e => setRuleForm({ ...ruleForm, name: e.target.value })}
                                    placeholder="Ej: Mismo Género"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.action')}</label>
                                    <select
                                        className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                        value={ruleForm.type}
                                        onChange={e => setRuleForm({ ...ruleForm, type: e.target.value as any })}
                                    >
                                        <option value="group_together">{t('action.group_together')}</option>
                                        <option value="exclusive">{t('action.exclusive')}</option>
                                    </select>
                                </div>
                                <div className="space-y-1.5">
                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.field')}</label>
                                    <select
                                        className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                        value={ruleForm.config}
                                        onChange={e => setRuleForm({ ...ruleForm, config: e.target.value })}
                                    >
                                        <option value="">{t('select.field') || 'Seleccionar...'}</option>
                                        {fields.map(f => (
                                            <option key={f.name} value={f.name}>{f.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.priority')} (1-100)</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="100"
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                    value={ruleForm.priority}
                                    onChange={e => setRuleForm({ ...ruleForm, priority: Number(e.target.value) })}
                                />
                                <div className="mt-2 text-[10px] text-gray-400 italic px-1">
                                    * Prioridades más altas se procesan primero.
                                </div>
                            </div>

                            <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100">
                                <div className="flex gap-3">
                                    <i className="fa-solid fa-circle-info text-indigo-400 text-sm mt-0.5"></i>
                                    <p className="text-xs text-indigo-700 font-medium leading-relaxed">
                                        {ruleForm.type === 'group_together' ? t('rule.description.group_together') : t('rule.description.exclusive')}
                                    </p>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 pt-6 border-t border-gray-50">
                                <button type="button" onClick={() => setShowRuleModal(false)} className="px-6 py-3 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:bg-gray-100 rounded-xl transition-all">{t('cancel')}</button>
                                <button type="submit" className="px-8 py-3 bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-indigo-200 hover:bg-indigo-700 active:scale-95 transition-all">{t('save')}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

// Main Export
export default function ConferenceManagerAdmin() {
    return (
        <ConferenceProvider>
            <ConferenceManagerContent />
        </ConferenceProvider>
    );
}


// Locations Page Component
function LocationsPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const { conferences } = useConference();
    const currentConference = conferences.find(c => c.id === conferenceId);

    const [locations, setLocations] = useState<Location[]>([]);
    const [conference, setConference] = useState<Conference | null>(null);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [newLocation, setNewLocation] = useState({ name: '', responsible_name: '', responsible_phone: '' });

    const loadLocations = async () => {
        setLoading(true);
        try {
            const data = await conferenceApi.getLocations(conferenceId);
            setLocations(data.locations);
            setConference(data.conference);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadLocations();
    }, [conferenceId]);

    const { confirm } = useModal();

    const handleCreate = async () => {
        if (!newLocation.name) return;
        try {
            await conferenceApi.createLocation(conferenceId, newLocation);
            setShowModal(false);
            setNewLocation({ name: '', responsible_name: '', responsible_phone: '' });
            loadLocations();
            addToast(t('location.created'), 'success');
        } catch (error: any) {
            addToast(error.message || 'Error', 'error');
        }
    };

    const handleDelete = async (id: number) => {
        if (!await confirm(t('confirm.delete.location'), t('delete.location') || "Delete Location", true)) return;
        try {
            await conferenceApi.deleteLocation(id);
            loadLocations();
            addToast(t('location.deleted') || 'Localidad eliminada', 'success');
        } catch (error: any) {
            addToast(error.message, 'error');
        }
    };

    const handleCopyLink = () => {
        if (!currentConference?.slug) return;
        if (!conference?.is_form_published) {
            addToast('El formulario no está publicado. El enlace no funcionará para el público.', 'warning');
        }
        const url = `${window.location.host}/portal/conference?slug=${currentConference.slug}`;
        const fullUrl = `${window.location.protocol}//${url}`;
        navigator.clipboard.writeText(fullUrl);
        addToast('Enlace copiado al portapapeles', 'success');
    };

    const isPublished = !!conference?.is_form_published;

    const [copiedId, setCopiedId] = useState<number | null>(null);

    const handleCopyCode = (code: string, id: number) => {
        navigator.clipboard.writeText(code);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            {/* Premium Public Link Card */}
            <div className={`group relative overflow-hidden rounded-[40px] p-10 border-2 transition-all duration-500 shadow-2xl ${isPublished
                ? 'bg-emerald-50/50 border-emerald-100 shadow-emerald-100/30'
                : 'bg-white border-gray-100 shadow-gray-100/50'
                }`}>
                <div className={`absolute -right-20 -top-20 w-80 h-80 rounded-full blur-[100px] opacity-30 transition-all duration-1000 group-hover:scale-125 ${isPublished ? 'bg-emerald-400' : 'bg-orange-400'
                    }`}></div>
                <div className={`absolute -left-20 -bottom-20 w-64 h-64 rounded-full blur-[100px] opacity-20 ${isPublished ? 'bg-teal-300' : 'bg-amber-100'
                    }`}></div>

                <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-10">
                    <div className="flex-1">
                        <div className="flex items-center gap-4 mb-5">
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-xl transition-transform duration-500 group-hover:scale-110 ${isPublished ? 'bg-emerald-500 text-white shadow-emerald-200' : 'bg-orange-500 text-white shadow-orange-200/50'
                                }`}>
                                <i className={`fa-solid ${isPublished ? 'fa-link' : 'fa-link-slash'}`}></i>
                            </div>
                            <div>
                                <h3 className={`font-black text-3xl italic tracking-tighter ${isPublished ? 'text-emerald-900' : 'text-gray-900'}`}>
                                    {t('public.portal.link') || 'Link del Portal Público'}
                                </h3>
                                {isPublished ? (
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                        <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Activo</span>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="w-2 h-2 rounded-full bg-orange-400"></div>
                                        <span className="text-[10px] font-black text-orange-600 uppercase tracking-widest">Borrador</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <p className={`text-base font-medium leading-relaxed max-w-xl ${isPublished ? 'text-emerald-800/70' : 'text-gray-500'}`}>
                            {isPublished
                                ? 'El portal está listo para recibir inscripciones. Comparte este enlace exclusivo con tus coordinadores y responsables de cada zona para iniciar el proceso.'
                                : 'Tu portal aún está en modo borrador. El enlace no funcionará correctamente hasta que publiques el formulario desde la pestaña de campos.'}
                        </p>
                    </div>
                    <button
                        onClick={handleCopyLink}
                        className={`px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all duration-500 flex items-center gap-3 shadow-xl transform active:scale-95 ${isPublished
                            ? 'bg-white text-emerald-600 hover:bg-emerald-50 border-2 border-emerald-100 shadow-emerald-100/50'
                            : 'bg-white text-orange-600 hover:bg-orange-50 border-2 border-orange-100 shadow-orange-100/50'
                            }`}
                    >
                        <i className="fa-solid fa-copy text-[8px]"></i> Copiar Enlace
                    </button>
                </div>
            </div>

            <div className="flex justify-between items-center bg-gray-50/50 p-8 rounded-[32px] border-2 border-white shadow-sm">
                <div>
                    <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{t('locations')}</h2>
                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Sedes regionales y grupos locales</p>
                </div>
                <button
                    onClick={() => setShowModal(true)}
                    className="bg-gray-900 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 transition-all duration-500 shadow-xl hover:shadow-blue-500/30 flex items-center gap-3 transform active:scale-95 translate-y-0 hover:-translate-y-1"
                >
                    <i className="fa-solid fa-plus text-[8px]"></i> {t('new.location')}
                </button>
            </div>

            {loading ? (
                <div className="flex-1 flex flex-col justify-center items-center py-20 bg-white rounded-3xl border border-gray-100">
                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-gray-400 mt-4 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                </div>
            ) : locations.length === 0 ? (
                <div className="flex-1 flex flex-col justify-center items-center py-20 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl">
                    <div className="w-20 h-20 bg-white rounded-3xl shadow-sm flex items-center justify-center text-gray-200 text-3xl mb-4">
                        <i className="fa-solid fa-map-location-dot"></i>
                    </div>
                    <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('no.locations.list')}</p>
                    <p className="text-[10px] text-gray-400 mt-2">Crea tu primera localidad para empezar a recibir inscripciones regionales.</p>
                </div>
            ) : (
                <div className="flex-1">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {locations.map(loc => (
                            <div key={loc.id} className="group bg-white p-8 rounded-[32px] border-2 border-gray-50 shadow-sm hover:border-blue-500 hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 relative overflow-hidden">
                                <div className="absolute -right-10 -bottom-10 w-32 h-32 bg-blue-600 opacity-[0.03] rounded-full group-hover:scale-150 transition-transform duration-700"></div>
                                <div className="absolute -left-10 -top-10 w-24 h-24 bg-indigo-600 opacity-[0.02] rounded-full group-hover:scale-150 transition-transform duration-700"></div>

                                <div className="flex justify-between items-start mb-8 relative z-10">
                                    <div className="flex items-center gap-4">
                                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 flex items-center justify-center text-xl shadow-inner group-hover:scale-110 transition-transform duration-500">
                                            <i className="fa-solid fa-map-location-dot"></i>
                                        </div>
                                        <div>
                                            <h3 className="text-2xl font-black text-gray-900 italic tracking-tighter leading-tight">{loc.name}</h3>
                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
                                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('active') || 'Activo'}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleDelete(loc.id)}
                                        className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-50 text-gray-300 hover:bg-rose-50 hover:text-rose-600 transition-all duration-300 opacity-0 group-hover:opacity-100 transform translate-x-4 group-hover:translate-x-0"
                                    >
                                        <i className="fa-solid fa-trash-can text-sm"></i>
                                    </button>
                                </div>

                                <div className="space-y-6 relative z-10">
                                    <div className="p-4 bg-gray-50/50 rounded-2xl border-2 border-white shadow-inner group/code">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2 bg-white rounded-lg shadow-sm">
                                                    <i className="fa-solid fa-fingerprint text-xs text-blue-500"></i>
                                                </div>
                                                <span className="font-mono text-sm font-black text-gray-600 tracking-tighter uppercase">{loc.code}</span>
                                            </div>
                                            <button
                                                onClick={() => handleCopyCode(loc.code, loc.id)}
                                                className={`text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-xl transition-all duration-300 shadow-sm ${copiedId === loc.id ? 'bg-emerald-500 text-white' : 'bg-white text-blue-600 hover:bg-blue-600 hover:text-white'}`}
                                            >
                                                {copiedId === loc.id ? t('copied') || '¡Copiado!' : t('copy') || 'Copiar'}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3 px-1">
                                        <div className="flex items-center gap-4 p-3 bg-white rounded-xl border border-gray-50 shadow-sm group-hover:border-blue-100 transition-colors">
                                            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-400 flex items-center justify-center text-sm">
                                                <i className="fa-solid fa-user-tie"></i>
                                            </div>
                                            <div>
                                                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('responsible') || 'Responsable'}</div>
                                                <div className="text-xs font-black text-gray-700 truncate">{loc.responsible_name || 'Sin asignar'}</div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-4 p-3 bg-white rounded-xl border border-gray-50 shadow-sm group-hover:border-blue-100 transition-colors">
                                            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-400 flex items-center justify-center text-sm">
                                                <i className="fa-solid fa-phone"></i>
                                            </div>
                                            <div>
                                                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('phone') || 'Teléfono'}</div>
                                                <div className="text-xs font-black text-gray-700">{loc.responsible_phone || 'N/A'}</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Create Location Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <h3 className="font-bold text-xl text-gray-900 italic">{t('new.location')}</h3>
                            <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>

                        <div className="p-8 space-y-6">
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('location.name')}</label>
                                <input
                                    type="text"
                                    value={newLocation.name}
                                    onChange={e => setNewLocation({ ...newLocation, name: e.target.value })}
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium"
                                    placeholder="Ej. Zona Norte"
                                    autoFocus
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('responsible.person')}</label>
                                <input
                                    type="text"
                                    value={newLocation.responsible_name}
                                    onChange={e => setNewLocation({ ...newLocation, responsible_name: e.target.value })}
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium"
                                    placeholder={t('responsible.person.description')}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('responsible.phone')}</label>
                                <input
                                    type="text"
                                    value={newLocation.responsible_phone}
                                    onChange={e => setNewLocation({ ...newLocation, responsible_phone: e.target.value })}
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium"
                                    placeholder="Ej. +1 555-123-4567"
                                />
                            </div>

                            <div className="bg-blue-50/50 p-4 rounded-2xl flex items-start gap-4 border border-blue-50">
                                <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                                    <i className="fa-solid fa-info-circle"></i>
                                </div>
                                <p className="text-xs text-blue-700/80 font-medium leading-relaxed">{t('location.code')} {t('slug.help')}</p>
                            </div>

                            <div className="flex justify-end gap-3 pt-4 border-t border-gray-50">
                                <button
                                    onClick={() => setShowModal(false)}
                                    className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-all"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    onClick={handleCreate}
                                    disabled={!newLocation.name}
                                    className="px-8 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold shadow-lg shadow-blue-500/30 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {t('create')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
