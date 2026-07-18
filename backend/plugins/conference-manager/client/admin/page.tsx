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

type View = 'list' | 'dashboard' | 'inscriptions' | 'lodging' | 'locations' | 'reports' | 'assignment' | 'fields' | 'pricing';

function ConferenceManagerContent() {
    const { currentConference, conferences, setCurrentConference, refreshConferences, loading } = useConference();
    // useI18n from global context
    const { t, language } = useI18n();
    const [view, setViewState] = useState<View>('list');
    const [selectedConferenceId, setSelectedConferenceId] = useState<number | null>(null);

    // Initialize state from local storage
    useEffect(() => {
        const savedView = localStorage.getItem('conference-manager:view') as View;
        if (savedView && ['list', 'dashboard', 'inscriptions', 'lodging', 'locations', 'assignment', 'fields', 'pricing', 'reports'].includes(savedView)) {
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
                    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
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
                        { name: t('pricing') || 'Precios', view: 'pricing' as View, icon: 'fa-tags' },
                        { name: t('reports'), view: 'reports' as View, icon: 'fa-file-lines' },
                    ].map((tab) => {
                        const isActive = view === tab.view;
                        return (
                            <button
                                key={tab.view}
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
                    {view === 'pricing' && <PricingPage conferenceId={currentConference.id} />}
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
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
// The registration form is the source of truth: attendee data lives in real columns named after each
// field (with a custom_data fallback for legacy rows). These read a field's value + build a display name.
const fieldVal = (person: any, field: any) => {
    const v = person?.[field.name];
    if (v !== undefined && v !== null && v !== '') return v;
    const cd = person?.custom_data?.[field.name];
    return (cd !== undefined && cd !== null && cd !== '') ? cd : '';
};
const personDisplayName = (person: any, fields: any[]) => {
    const fl = fields || [];
    // Prefer the fields tagged with the name roles; fall back to the first 1-2 form fields.
    const named = ['first_name', 'last_name']
        .map(role => fl.find((f: any) => f.role === role))
        .filter(Boolean)
        .map((f: any) => fieldVal(person, f))
        .filter(v => v !== '' && v != null);
    const parts = named.length ? named : fl.map((f: any) => fieldVal(person, f)).filter(v => v !== '' && v != null).slice(0, 2);
    const name = parts.join(' ').trim();
    return name || `#${person?.id ?? ''}`;
};

function InscriptionsPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [inscriptions, setInscriptions] = useState<Inscription[]>([]);
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [confLocations, setConfLocations] = useState<Location[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedLocations, setSelectedLocations] = useState<Set<string>>(new Set());
    const [showLocationDropdown, setShowLocationDropdown] = useState(false);
    const [collapsedLocations, setCollapsedLocations] = useState<Set<string>>(new Set());
    const [formData, setFormData] = useState<any>({
        custom_data: {}
    });

    const [editId, setEditId] = useState<number | null>(null); // null = create, id = editing
    const [saving, setSaving] = useState(false);

    const [selectedInscription, setSelectedInscription] = useState<Inscription | null>(null);
    const [payments, setPayments] = useState<Payment[]>([]);
    const [loadingPayments, setLoadingPayments] = useState(false);
    const [paymentForm, setPaymentForm] = useState({ amount: '', method: 'Efectivo', reference: '', proof: '' });
    const [proofViewer, setProofViewer] = useState<string | null>(null); // comprobante lightbox (data: URLs can't open in a new tab)
    // In-app confirm that renders ABOVE the plugin's own z-[100] modals — the shared useModal dialog is
    // z-50, so it'd be hidden BEHIND the payments modal. Same (message, label, danger) signature so the
    // call sites are unchanged; the returned promise resolves to the user's choice. Never a window.confirm.
    const [confirmState, setConfirmState] = useState<{ message: string; label: string; danger: boolean; resolve: (v: boolean) => void } | null>(null);
    const confirm = (message: string, label = 'Confirmar', danger = false) =>
        new Promise<boolean>(resolve => setConfirmState({ message, label, danger, resolve }));
    const [addingPayment, setAddingPayment] = useState(false);

    // Manual room-assignment modal state.
    const [assignTarget, setAssignTarget] = useState<Inscription | null>(null);
    const [assignHotels, setAssignHotels] = useState<Hotel[]>([]);
    const [assignLoading, setAssignLoading] = useState(false);

    // Fields own their own load (they change rarely); the inscriptions list is owned solely by
    // fetchInscriptions so the two no longer race to setInscriptions on mount.
    const loadFields = async () => {
        if (!conferenceId) return;
        try {
            const [fieldsData, locData] = await Promise.all([
                conferenceApi.getFields(conferenceId),
                conferenceApi.getLocations(conferenceId),
            ]);
            setFields(fieldsData);
            setConfLocations(locData?.locations || []);
        } catch (e) {
            console.error(e);
        }
    };

    const fetchInscriptions = async () => {
        if (!conferenceId) return;
        setLoading(true);
        try {
            const data = await conferenceApi.getInscriptions(conferenceId, { search: searchTerm });

            // The API filters by a single location; multi-select is applied client-side.
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
            addToast(t('error.loading.inscriptions') || 'Error al cargar inscripciones', 'error');
        } finally {
            setLoading(false);
        }
    };

    // Unique locations for the filter dropdown — always the full set, independent of the search box.
    const fetchAllInscriptions = async () => {
        if (!conferenceId) return [];
        try {
            return await conferenceApi.getInscriptions(conferenceId, {});
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
        loadFields();
    }, [conferenceId]);

    // Debounce so each keystroke in the search box does not fire a request.
    useEffect(() => {
        const h = setTimeout(() => { fetchInscriptions(); }, 250);
        return () => clearTimeout(h);
    }, [searchTerm, selectedLocations, conferenceId]);

    // Open the modal for a NEW inscription.
    const openCreate = () => {
        setEditId(null);
        setFormData({ custom_data: {} });
        setShowAddModal(true);
    };

    // Open the modal pre-filled to EDIT an existing inscription. Dynamic (custom) field values are
    // flattened onto formData so the same form renders them.
    const openEdit = (person: Inscription) => {
        setEditId(person.id);
        setFormData({ ...person, ...(person.custom_data || {}) });
        setShowAddModal(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!conferenceId) return;
        setSaving(true);
        try {
            if (editId) {
                await conferenceApi.updateInscription(editId, formData);
                addToast(t('inscription.updated') || 'Inscripción actualizada', 'success');
            } else {
                await conferenceApi.createInscription(conferenceId, formData);
                addToast(t('inscription.created') || 'Inscripción creada', 'success');
            }
            setShowAddModal(false);
            setEditId(null);
            setFormData({ custom_data: {} });
            fetchInscriptions();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (person: Inscription) => {
        if (!await confirm(`${t('confirm.delete.inscription') || '¿Eliminar la inscripción de'} ${personDisplayName(person, fields)}?`, t('delete') || 'Eliminar', true)) return;
        try {
            await conferenceApi.deleteInscription(person.id);
            addToast(t('inscription.deleted') || 'Inscripción eliminada', 'success');
            fetchInscriptions();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
    };

    // Reset + reload the payment list for a person (no stale rows on a slow/failed fetch).
    const openPayments = (person: Inscription) => {
        setSelectedInscription(person);
        setPayments([]);
        setPaymentForm({ amount: '', method: 'Efectivo', reference: '' });
        setLoadingPayments(true);
        conferenceApi.getPayments(person.id)
            .then(setPayments)
            .catch(() => addToast(t('error.loading.payments') || 'Error al cargar pagos', 'error'))
            .finally(() => setLoadingPayments(false));
    };

    // Refresh the payments list + the selected row's totals after any payment action (add/validate/reject).
    const refreshAfterPaymentAction = async () => {
        if (!selectedInscription) return;
        const [fresh, list] = await Promise.all([
            conferenceApi.getPayments(selectedInscription.id),
            conferenceApi.getInscriptions(conferenceId, {}),
        ]);
        setPayments(fresh);
        const updated = list.find(i => i.id === selectedInscription.id);
        if (updated) setSelectedInscription(updated);
        fetchInscriptions();
    };

    const handleAddPayment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedInscription) return;
        const amt = Number(paymentForm.amount);
        if (!Number.isFinite(amt) || amt <= 0) { addToast(t('payment.invalid.amount') || 'El monto debe ser mayor que cero.', 'error'); return; }
        if (!paymentForm.proof) { addToast('El comprobante es obligatorio.', 'error'); return; }
        setAddingPayment(true);
        try {
            await conferenceApi.addPayment(selectedInscription.id, { amount: amt, method: paymentForm.method, reference: paymentForm.reference, proof: paymentForm.proof });
            addToast('Pago registrado — queda pendiente de validación.', 'success');
            setPaymentForm({ amount: '', method: 'Efectivo', reference: '', proof: '' });
            await refreshAfterPaymentAction();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setAddingPayment(false);
        }
    };

    const handleValidatePayment = async (payment: Payment) => {
        try { await conferenceApi.validatePayment(payment.id); addToast('Pago validado.', 'success'); await refreshAfterPaymentAction(); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };
    const handleRejectPayment = async (payment: Payment) => {
        if (!await confirm('¿Rechazar este pago? No contará para el saldo.', 'Rechazar pago', true)) return;
        try { await conferenceApi.rejectPayment(payment.id); addToast('Pago rechazado.', 'info'); await refreshAfterPaymentAction(); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    const handleVoidPayment = async (payment: Payment) => {
        if (!selectedInscription) return;
        if (!await confirm(t('confirm.void.payment') || '¿Anular este pago?', t('void.payment') || 'Anular pago', true)) return;
        try {
            await conferenceApi.voidPayment(payment.id);
            const fresh = await conferenceApi.getPayments(selectedInscription.id);
            setPayments(fresh);
            fetchInscriptions();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
    };

    // Manual room assignment.
    const openAssign = async (person: Inscription) => {
        setAssignTarget(person);
        setAssignLoading(true);
        try {
            setAssignHotels(await conferenceApi.getHotels(conferenceId));
        } catch (e) {
            addToast(t('error.loading.hotels') || 'Error al cargar hoteles', 'error');
        } finally {
            setAssignLoading(false);
        }
    };

    const doAssign = async (roomId: number | null) => {
        if (!assignTarget) return;
        try {
            await conferenceApi.assignRoom(assignTarget.id, roomId);
            addToast(roomId ? (t('room.assigned') || 'Habitación asignada') : (t('room.unassigned') || 'Asignación removida'), 'success');
            setAssignTarget(null);
            fetchInscriptions();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
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
                                    <div className="absolute z-[70] mt-3 bg-white border border-gray-100 rounded-3xl shadow-2xl overflow-hidden min-w-[240px] sm:min-w-[320px] animate-in slide-in-from-top-2 duration-200">
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
                    onClick={openCreate}
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
                                                        {/* Columns follow the registration form — one per defined field. */}
                                                        {fields.length === 0 && (
                                                            <th className="px-8 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">{t('participant.singular')}</th>
                                                        )}
                                                        {fields.map((field, idx) => (
                                                            <th key={field.id} className={`${idx === 0 ? 'px-8' : 'px-6'} py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap`}>{field.label}</th>
                                                        ))}
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('payment')}</th>
                                                        <th className="px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-center whitespace-nowrap">{t('lodging')}</th>
                                                        <th className="px-8 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest text-right whitespace-nowrap">{t('actions')}</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-50">
                                                    {locationInscriptions.map((person) => (
                                                        <tr key={person.id} className="hover:bg-blue-50/30 transition-colors group/row">
                                                            {fields.length === 0 && (
                                                                <td className="px-8 py-5">
                                                                    <div className="font-bold text-gray-900 group-hover/row:text-blue-700 transition-colors">{personDisplayName(person, fields)}</div>
                                                                </td>
                                                            )}
                                                            {fields.map((field, idx) => {
                                                                const val = fieldVal(person, field);
                                                                return (
                                                                    <td key={field.id} className={`${idx === 0 ? 'px-8' : 'px-6'} py-5`}>
                                                                        <div className={idx === 0
                                                                            ? 'font-bold text-gray-900 group-hover/row:text-blue-700 transition-colors'
                                                                            : 'text-gray-600 text-xs font-medium truncate max-w-[180px]'}>
                                                                            {val !== '' ? String(val) : <span className="text-gray-300 italic">-</span>}
                                                                        </div>
                                                                    </td>
                                                                );
                                                            })}
                                                            <td className="px-6 py-5">
                                                                <div className="flex flex-col items-center gap-1">
                                                                    <button
                                                                        onClick={() => openPayments(person)}
                                                                        className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all ${person.payment_status === 'paid'
                                                                            ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                                                                            : person.payment_status === 'partial'
                                                                                ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                                                                                : 'bg-rose-50 text-rose-600 hover:bg-rose-100'
                                                                            }`}
                                                                    >
                                                                        {t(person.payment_status) || person.payment_status}
                                                                    </button>
                                                                    <div className="text-[10px] text-gray-400 font-bold">${person.amount_paid} / ${person.total_due}</div>
                                                                    {(person as any).pending_amount > 0 && (
                                                                        <div className="text-[9px] font-black uppercase tracking-widest text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full whitespace-nowrap"><i className="fa-solid fa-clock mr-1"></i>${(person as any).pending_amount} por validar</div>
                                                                    )}
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
                                                                <div className="flex justify-end gap-2 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                                                                    <button
                                                                        onClick={() => openAssign(person)}
                                                                        className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-emerald-600 hover:text-white transition-all shadow-sm border border-transparent hover:border-emerald-400"
                                                                        title={t('assign.room') || 'Asignar habitación'}
                                                                    >
                                                                        <i className="fa-solid fa-bed text-xs"></i>
                                                                    </button>
                                                                    <button
                                                                        onClick={() => openEdit(person)}
                                                                        className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition-all shadow-sm border border-transparent hover:border-blue-400"
                                                                        title={t('edit')}
                                                                    >
                                                                        <i className="fa-solid fa-pen text-xs"></i>
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleDelete(person)}
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
                            <h3 className="font-bold text-xl text-gray-900 italic">{editId ? (t('edit.inscription') || 'Editar Inscripción') : t('new.inscription')}</h3>
                            <button onClick={() => { setShowAddModal(false); setEditId(null); }} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-8 space-y-6">
                            {/* Location — the admin picks it explicitly (the portal auto-sets it). */}
                            {confLocations.length > 0 ? (
                                <div>
                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1.5">
                                        {t('location') || 'Localidad'} <span className="text-rose-500">*</span>
                                    </label>
                                    <select
                                        required
                                        className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                        value={formData.location || ''}
                                        onChange={e => handleFormChange('location', e.target.value)}
                                    >
                                        <option value="">Seleccionar localidad...</option>
                                        {confLocations.map((loc: any) => (
                                            <option key={loc.id} value={loc.name}>{loc.name}</option>
                                        ))}
                                    </select>
                                </div>
                            ) : (
                                <p className="text-[10px] text-gray-400 italic px-1">Sin localidades configuradas. Créalas en la pestaña «Localidades» para poder asignarlas aquí.</p>
                            )}
                            {fields.length === 0 ? (
                                <div className="text-center py-10 bg-orange-50 rounded-2xl border-2 border-dashed border-orange-100 p-6">
                                    <i className="fa-solid fa-triangle-exclamation text-orange-400 text-3xl mb-4"></i>
                                    <p className="text-orange-900 font-black italic tracking-tight mb-1">Formulario no configurado</p>
                                    <p className="text-xs text-orange-700 leading-relaxed max-w-[280px] mx-auto">Debes crear campos en la pestaña "Campos" antes de poder registrar participantes.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                    {fields.map(field => (
                                        <div key={field.id} className={field.type === 'notes' || field.type === 'textarea' ? 'md:col-span-2' : ''}>
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
                                <button type="button" onClick={() => { setShowAddModal(false); setEditId(null); }} className="px-6 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition">{t('cancel')}</button>
                                {fields.length > 0 && (
                                    <button type="submit" disabled={saving} className="px-8 py-2.5 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition disabled:opacity-50">{saving ? (t('saving') || 'Guardando…') : t('save')}</button>
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
                                <h3 className="font-bold text-xl text-gray-900 italic">Pagos de {personDisplayName(selectedInscription, fields)}</h3>
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
                                                        {payment.status === 'validated' ? (
                                                            <span className="text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded"><i className="fa-solid fa-check mr-1"></i>Validado</span>
                                                        ) : payment.status === 'rejected' ? (
                                                            <span className="text-[10px] font-bold uppercase bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded"><i className="fa-solid fa-ban mr-1"></i>Rechazado</span>
                                                        ) : (
                                                            <span className="text-[10px] font-bold uppercase bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded"><i className="fa-solid fa-clock mr-1"></i>Pendiente</span>
                                                        )}
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
                                                            onClick={() => setProofViewer(payment.proof || null)}
                                                        />
                                                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity text-white bg-black/40 rounded-lg">
                                                            <i className="fa-solid fa-magnifying-glass-plus"></i>
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="shrink-0 flex items-center gap-1">
                                                    {payment.status === 'pending' && (
                                                        <>
                                                            <button type="button" onClick={() => handleValidatePayment(payment)} title="Validar pago" className="w-8 h-8 flex items-center justify-center rounded-lg text-emerald-600 hover:text-white hover:bg-emerald-600 border border-emerald-100 transition">
                                                                <i className="fa-solid fa-check text-xs"></i>
                                                            </button>
                                                            <button type="button" onClick={() => handleRejectPayment(payment)} title="Rechazar pago" className="w-8 h-8 flex items-center justify-center rounded-lg text-amber-600 hover:text-white hover:bg-amber-600 border border-amber-100 transition">
                                                                <i className="fa-solid fa-ban text-xs"></i>
                                                            </button>
                                                        </>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => handleVoidPayment(payment)}
                                                        title={t('void.payment') || 'Anular pago'}
                                                        className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-300 hover:text-rose-600 hover:bg-rose-50 transition"
                                                    >
                                                        <i className="fa-solid fa-trash-can text-xs"></i>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Register a new payment */}
                            <form onSubmit={handleAddPayment} className="pt-6 mt-4 border-t border-gray-100">
                                <div className="flex items-center justify-between mb-3">
                                    <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400">{t('register.payment') || 'Registrar pago'}</h4>
                                    <span className="text-xs font-bold text-gray-500">
                                        {t('paid')}: <span className="text-emerald-600">${selectedInscription.amount_paid}</span> / ${selectedInscription.total_due}
                                    </span>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-sm">$</span>
                                        <input
                                            type="number" min="0" step="any" required
                                            placeholder={t('amount') || 'Monto'}
                                            className="w-full border-2 border-gray-100 rounded-xl pl-7 pr-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-sm font-bold text-gray-900"
                                            value={paymentForm.amount}
                                            onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                                        />
                                    </div>
                                    <select
                                        className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-sm font-medium"
                                        value={paymentForm.method}
                                        onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })}
                                    >
                                        <option>Efectivo</option>
                                        <option>Transferencia</option>
                                        <option>Consignación</option>
                                    </select>
                                    <input
                                        type="text"
                                        placeholder={t('reference') || 'Referencia (opcional)'}
                                        className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-sm font-medium"
                                        value={paymentForm.reference}
                                        onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })}
                                    />
                                </div>
                                <div className="mt-3">
                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1.5">Comprobante <span className="text-rose-500">*</span></label>
                                    <div className="flex items-center gap-3">
                                        <label className="flex-1 cursor-pointer border-2 border-dashed border-gray-200 rounded-xl px-4 py-3 text-center text-xs font-bold text-gray-400 hover:border-blue-400 hover:text-blue-500 transition">
                                            <i className="fa-solid fa-cloud-arrow-up mr-2"></i>
                                            {paymentForm.proof ? 'Comprobante cargado — clic para cambiar' : 'Sube una imagen del comprobante'}
                                            <input type="file" accept="image/*" className="hidden" onChange={e => {
                                                const file = e.target.files?.[0]; if (!file) return;
                                                if (file.size > 1024 * 1024) { addToast('El comprobante no puede superar 1 MB.', 'error'); return; }
                                                const reader = new FileReader();
                                                reader.onload = () => setPaymentForm(pf => ({ ...pf, proof: String(reader.result || '') }));
                                                reader.readAsDataURL(file);
                                            }} />
                                        </label>
                                        {paymentForm.proof && (
                                            <img src={paymentForm.proof} className="w-14 h-14 rounded-lg object-cover border border-gray-200" alt="comprobante" />
                                        )}
                                    </div>
                                    <p className="text-[10px] text-gray-400 italic mt-1 px-1">Obligatorio. El pago quedará <b>pendiente de validación</b> hasta que un administrador lo apruebe.</p>
                                </div>
                                <div className="flex items-center justify-end gap-3 pt-5">
                                    <button
                                        type="button"
                                        onClick={() => setSelectedInscription(null)}
                                        className="px-6 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition"
                                    >
                                        {t('close') || 'Cerrar'}
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={addingPayment}
                                        className="px-8 py-2.5 bg-emerald-600 text-white font-bold rounded-xl shadow-lg shadow-emerald-500/30 hover:bg-emerald-700 transition disabled:opacity-50 flex items-center gap-2"
                                    >
                                        <i className="fa-solid fa-plus text-xs"></i>
                                        {addingPayment ? (t('saving') || 'Guardando…') : (t('register.payment') || 'Registrar pago')}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {/* In-app confirm dialog — z-[120], above the payments modal (z-100) + lightbox (z-110). */}
            {confirmState && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[120] flex items-center justify-center p-4 animate-in fade-in duration-150">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-150">
                        <div className="p-6">
                            <p className="text-gray-800 font-medium leading-relaxed">{confirmState.message}</p>
                        </div>
                        <div className="px-6 py-4 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => { confirmState.resolve(false); setConfirmState(null); }}
                                className="px-5 py-2 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition"
                            >
                                {t('cancel') || 'Cancelar'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { confirmState.resolve(true); setConfirmState(null); }}
                                className={`px-5 py-2 text-white font-bold rounded-xl shadow-lg transition ${confirmState.danger ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-500/30' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30'}`}
                            >
                                {confirmState.label}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Comprobante lightbox — a data: URL is blocked from opening in a new tab, so view it in-app. */}
            {proofViewer && (
                <div
                    className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[110] flex items-center justify-center p-6 animate-in fade-in duration-200"
                    onClick={() => setProofViewer(null)}
                >
                    <button
                        type="button"
                        onClick={() => setProofViewer(null)}
                        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
                    >
                        <i className="fa-solid fa-xmark text-lg"></i>
                    </button>
                    <img
                        src={proofViewer}
                        alt="Comprobante"
                        className="max-w-full max-h-[90vh] rounded-xl shadow-2xl object-contain bg-white"
                        onClick={e => e.stopPropagation()}
                    />
                </div>
            )}

            {/* Manual room-assignment modal */}
            {assignTarget && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-bold text-xl text-gray-900 italic">{t('assign.room') || 'Asignar habitación'}</h3>
                                <p className="text-xs text-gray-500 mt-0.5">{personDisplayName(assignTarget, fields)}</p>
                            </div>
                            <button onClick={() => setAssignTarget(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>
                        <div className="p-8 max-h-[65vh] overflow-y-auto modern-scrollbar">
                            {assignTarget.room_id && (
                                <button
                                    onClick={() => doAssign(null)}
                                    className="w-full mb-4 px-4 py-3 rounded-xl border-2 border-dashed border-rose-200 text-rose-600 font-bold text-sm hover:bg-rose-50 transition flex items-center justify-center gap-2"
                                >
                                    <i className="fa-solid fa-xmark"></i> {t('unassign.room') || 'Quitar asignación actual'}
                                </button>
                            )}
                            {assignLoading ? (
                                <div className="text-center py-10"><div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div></div>
                            ) : assignHotels.length === 0 ? (
                                <div className="text-center py-10 text-gray-400 bg-gray-50 rounded-xl border border-dashed">
                                    <i className="fa-solid fa-hotel text-3xl mb-3 opacity-30"></i>
                                    <p className="font-medium text-sm">{t('no.hotels') || 'No hay hoteles configurados.'}</p>
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    {assignHotels.map(hotel => (
                                        <div key={hotel.id}>
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{hotel.name}</h4>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                                {(hotel.rooms || []).map(room => {
                                                    const full = (room.occupied || 0) >= room.capacity && assignTarget.room_id !== room.id;
                                                    const current = assignTarget.room_id === room.id;
                                                    return (
                                                        <button
                                                            key={room.id}
                                                            disabled={full}
                                                            onClick={() => doAssign(room.id)}
                                                            className={`px-3 py-2.5 rounded-xl border-2 text-left transition-all ${current
                                                                ? 'border-blue-500 bg-blue-50'
                                                                : full
                                                                    ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                                                                    : 'border-gray-100 hover:border-emerald-400 hover:bg-emerald-50'}`}
                                                        >
                                                            <div className="font-black text-sm text-gray-900">{room.room_number}</div>
                                                            <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">
                                                                {(room.occupied || 0)}/{room.capacity} · {room.gender}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                                {(hotel.rooms || []).length === 0 && (
                                                    <div className="col-span-full text-xs text-gray-300 italic">{t('no.rooms') || 'Sin habitaciones'}</div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
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
    const { confirm } = useModal();
    const [hotels, setHotels] = useState<Hotel[]>([]);
    const [loading, setLoading] = useState(true);
    const [showHotelModal, setShowHotelModal] = useState(false);
    const [showRoomModal, setShowRoomModal] = useState<number | null>(null);
    const [hotelForm, setHotelForm] = useState<Partial<Hotel>>({ name: '', address: '', capacity: 0 });
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
            setHotelForm({ name: '', address: '', capacity: 0 });
            fetchHotels();
            addToast(t('hotel.created'), 'success');
        } catch (error: any) {
            addToast(error.message || 'Error creating hotel', 'error');
        }
    };

    const handleDeleteHotel = async (hotel: Hotel) => {
        if (!await confirm(`${t('confirm.delete.hotel') || '¿Eliminar el hotel'} "${hotel.name}"? ${t('delete.hotel.warning') || 'Se eliminarán sus habitaciones y se liberarán los huéspedes.'}`, t('delete.hotel') || 'Eliminar hotel', true)) return;
        try {
            await conferenceApi.deleteHotel(hotel.id);
            addToast(t('hotel.deleted') || 'Hotel eliminado', 'success');
            fetchHotels();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
    };

    const handleDeleteRoom = async (room: Room) => {
        if (!await confirm(`${t('confirm.delete.room') || '¿Eliminar la habitación'} ${room.room_number}?`, t('delete.room') || 'Eliminar habitación', true)) return;
        try {
            await conferenceApi.deleteRoom(room.id);
            addToast(t('room.deleted') || 'Habitación eliminada', 'success');
            fetchHotels();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
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
                if (end - start + 1 > 100) throw new Error('Maximum 100 rooms at once');

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
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center justify-between bg-gray-50/50 p-8 rounded-[32px] border-2 border-white shadow-sm">
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
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setShowRoomModal(hotel.id)}
                                className="bg-white border-2 border-gray-100 px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-500 hover:border-blue-500 hover:text-white hover:bg-blue-600 transition-all flex items-center gap-2 shadow-sm"
                            >
                                <i className="fa-solid fa-plus text-[8px]"></i> {t('add.room')}
                            </button>
                            <button
                                onClick={() => handleDeleteHotel(hotel)}
                                title={t('delete.hotel') || 'Eliminar hotel'}
                                className="w-11 h-11 flex items-center justify-center rounded-xl bg-white border-2 border-gray-100 text-gray-400 hover:border-rose-400 hover:bg-rose-600 hover:text-white transition-all shadow-sm"
                            >
                                <i className="fa-solid fa-trash-can text-xs"></i>
                            </button>
                        </div>
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
                                    const cap = room.capacity || 0;
                                    const occ = room.occupied || 0;
                                    const isFull = cap > 0 && occ >= cap;
                                    const occupancyPercent = cap > 0 ? Math.min(100, (occ / cap) * 100) : 0;

                                    return (
                                        <div key={room.id} className={`
                                            group/room p-5 rounded-3xl border-2 transition-all duration-300 relative overflow-hidden flex flex-col justify-between h-32
                                            ${isFull
                                                ? 'bg-white border-rose-100 shadow-sm opacity-80'
                                                : 'bg-white border-white shadow-sm hover:border-blue-400 hover:shadow-xl hover:-translate-y-1'}
                                        `}>
                                            <div className="flex justify-between items-start z-10">
                                                <span className="font-black text-xl text-gray-900 italic tracking-tighter">{room.room_number}</span>
                                                <div className="flex items-center gap-1.5">
                                                    {room.notes && (
                                                        <div className="w-5 h-5 rounded-full bg-blue-50 flex items-center justify-center text-blue-400 group-hover/room:bg-blue-100 transition-colors" title={room.notes}>
                                                            <i className="fa-solid fa-info text-[8px]"></i>
                                                        </div>
                                                    )}
                                                    <button
                                                        onClick={() => handleDeleteRoom(room)}
                                                        title={t('delete.room') || 'Eliminar habitación'}
                                                        className="w-5 h-5 rounded-full flex items-center justify-center text-gray-300 hover:text-rose-600 hover:bg-rose-50 transition-colors opacity-0 group-hover/room:opacity-100 [@media(hover:none)]:opacity-100"
                                                    >
                                                        <i className="fa-solid fa-trash-can text-[8px]"></i>
                                                    </button>
                                                </div>
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
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('capacity') || 'Capacidad'}</label>
                                <input
                                    type="number" min="0"
                                    placeholder="0"
                                    className="w-full border-2 border-gray-100 rounded-2xl px-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                    value={hotelForm.capacity ?? 0}
                                    onChange={e => setHotelForm({ ...hotelForm, capacity: Number(e.target.value) })}
                                />
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

// Pricing Component — base fee + field-driven pricing rules (each rule 'set's or 'add's an amount
// when the attendee's field value matches a condition). Evaluated server-side on registration.
const FEE_OPERATORS = [
    { value: 'eq', label: 'es igual a', needsValue: true },
    { value: 'neq', label: 'no es igual a', needsValue: true },
    { value: 'contains', label: 'contiene', needsValue: true },
    { value: 'gt', label: 'mayor que', needsValue: true },
    { value: 'gte', label: 'mayor o igual que', needsValue: true },
    { value: 'lt', label: 'menor que', needsValue: true },
    { value: 'lte', label: 'menor o igual que', needsValue: true },
    { value: 'filled', label: 'tiene valor', needsValue: false },
    { value: 'empty', label: 'está vacío', needsValue: false },
    { value: 'any', label: 'siempre (sin condición)', needsValue: false },
];

function PricingPage({ conferenceId }: { conferenceId: number }) {
    const { addToast } = useToast();
    const { confirm } = useModal();
    const [fields, setFields] = useState<any[]>([]);
    const [rules, setRules] = useState<any[]>([]);
    const [baseFee, setBaseFee] = useState<string>('0');
    const [loading, setLoading] = useState(true);
    const [savingBase, setSavingBase] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [form, setForm] = useState<any>(null);
    const [repricing, setRepricing] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            const [flds, rls, confs] = await Promise.all([
                conferenceApi.getFields(conferenceId),
                conferenceApi.getFeeRules(conferenceId),
                conferenceApi.getConferences(),
            ]);
            setFields(flds || []);
            setRules(rls || []);
            const conf = (confs || []).find((c: any) => c.id === conferenceId);
            setBaseFee(String(conf?.fee_default ?? 0));
        } catch (e: any) { addToast(e?.message || 'Error al cargar precios', 'error'); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); }, [conferenceId]);

    const saveBase = async () => {
        setSavingBase(true);
        try { await conferenceApi.updateConference(conferenceId, { fee_default: Number(baseFee) || 0 } as any); addToast('Cuota base guardada', 'success'); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setSavingBase(false); }
    };

    const openNew = () => { setForm({ label: '', field_name: '', operator: 'any', value: '', action: 'set', amount: '', priority: (rules.length + 1) * 10, enabled: 1 }); setShowModal(true); };
    const openEdit = (r: any) => { setForm({ ...r, amount: String(r.amount) }); setShowModal(true); };

    const saveRule = async (e: any) => {
        e.preventDefault();
        try {
            await conferenceApi.saveFeeRule({ ...form, conference_id: conferenceId, amount: Number(form.amount) || 0 });
            setShowModal(false); setForm(null); addToast('Regla guardada', 'success'); load();
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };
    const toggleRule = async (r: any) => { try { await conferenceApi.saveFeeRule({ ...r, conference_id: conferenceId, enabled: r.enabled ? 0 : 1 }); load(); } catch (e: any) { addToast(e?.message || 'Error', 'error'); } };
    const delRule = async (r: any) => { if (!await confirm(`¿Eliminar la regla "${r.label || 'sin nombre'}"?`, 'Eliminar', true)) return; try { await conferenceApi.deleteFeeRule(r.id); load(); } catch (e: any) { addToast(e?.message || 'Error', 'error'); } };

    const repriceAll = async () => {
        if (!await confirm('Se recalcularán las cuotas de TODOS los inscritos con las reglas y la cuota base actuales. Los pagos ya registrados no se tocan. ¿Continuar?', 'Recalcular precios', false)) return;
        setRepricing(true);
        try {
            const r = await conferenceApi.repriceAll(conferenceId);
            addToast(`Precios recalculados: ${r.updated} de ${r.total} inscritos actualizados.`, 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setRepricing(false); }
    };

    const fieldLabel = (name: string) => fields.find(f => f.name === name)?.label || name;
    const opLabel = (op: string) => FEE_OPERATORS.find(o => o.value === op)?.label || op;
    const money = (n: any) => '$' + (Number(n) || 0).toLocaleString();
    const opNeedsValue = (op: string) => FEE_OPERATORS.find(o => o.value === op)?.needsValue;

    if (loading) return <div className="text-center py-20"><div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div></div>;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6 flex-shrink-0">
                <div>
                    <h2 className="text-2xl font-black text-gray-900 italic tracking-tighter">Precios</h2>
                    <p className="text-sm text-gray-400 font-medium">Cuota base + reglas según los campos del formulario</p>
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={repriceAll} disabled={repricing} className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 disabled:opacity-50" title="Aplica las reglas actuales a los inscritos existentes">
                        <i className={`fa-solid ${repricing ? 'fa-spinner animate-spin' : 'fa-arrows-rotate'}`}></i> Recalcular todos
                    </button>
                    <button onClick={openNew} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg">
                        <i className="fa-solid fa-plus"></i> Nueva regla
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto modern-scrollbar min-h-0 space-y-6">
                {/* Base fee */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Cuota base (por defecto)</label>
                    <div className="flex items-center gap-3">
                        <div className="relative flex-1 max-w-xs">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold">$</span>
                            <input type="number" min="0" value={baseFee} onChange={e => setBaseFee(e.target.value)}
                                className="w-full border-2 border-gray-100 rounded-xl pl-8 pr-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none font-bold text-gray-900" />
                        </div>
                        <button onClick={saveBase} disabled={savingBase} className="px-6 py-3 bg-gray-900 hover:bg-black text-white rounded-xl font-black text-xs uppercase tracking-widest transition disabled:opacity-50">{savingBase ? 'Guardando…' : 'Guardar'}</button>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">Se aplica a todos; luego las reglas la fijan o la ajustan según los campos.</p>
                </div>

                {/* Rules */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                        <h3 className="font-bold text-gray-800">Reglas de precio</h3>
                        <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{rules.length} reglas · orden por prioridad</span>
                    </div>
                    {rules.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                            <i className="fa-solid fa-tags text-3xl mb-3 opacity-30"></i>
                            <p className="text-sm">Sin reglas — todos pagan la cuota base. Crea una con "Nueva regla".</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-gray-50">
                            {rules.map(r => (
                                <div key={r.id} className={`p-5 flex items-center justify-between gap-4 ${r.enabled ? '' : 'opacity-50'}`}>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-black text-gray-900">{r.label || 'Regla'}</span>
                                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${r.action === 'add' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                                                {r.action === 'add' ? 'Suma' : 'Fija'} {money(r.amount)}
                                            </span>
                                        </div>
                                        <div className="text-xs text-gray-500">
                                            {r.operator === 'any' || !r.field_name
                                                ? 'Siempre'
                                                : <>Si <span className="font-bold text-gray-700">{fieldLabel(r.field_name)}</span> {opLabel(r.operator)} {opNeedsValue(r.operator) && <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">{r.value}</span>}</>}
                                            <span className="ml-2 text-gray-300">· prioridad {r.priority}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button onClick={() => toggleRule(r)} title={r.enabled ? 'Desactivar' : 'Activar'} className={`w-11 h-6 rounded-full relative transition ${r.enabled ? 'bg-emerald-500' : 'bg-gray-200'}`}>
                                            <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition ${r.enabled ? 'left-6' : 'left-1'}`}></span>
                                        </button>
                                        <button onClick={() => openEdit(r)} title="Editar" className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition"><i className="fa-solid fa-pen text-xs"></i></button>
                                        <button onClick={() => delRule(r)} title="Eliminar" className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition"><i className="fa-solid fa-trash text-xs"></i></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Rule modal */}
            {showModal && form && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <h3 className="font-bold text-xl text-gray-900 italic">{form.id ? 'Editar regla' : 'Nueva regla de precio'}</h3>
                            <button onClick={() => { setShowModal(false); setForm(null); }} className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-lg"><i className="fa-solid fa-xmark text-lg"></i></button>
                        </div>
                        <form onSubmit={saveRule} className="p-8 space-y-5">
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Nombre de la regla</label>
                                <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Ej. Estudiantes" className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium" />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                                <div className="sm:col-span-1">
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Campo</label>
                                    <select value={form.field_name} onChange={e => setForm({ ...form, field_name: e.target.value, operator: e.target.value ? (form.operator === 'any' ? 'eq' : form.operator) : 'any' })} className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-sm">
                                        <option value="">(Siempre)</option>
                                        {fields.map(f => <option key={f.id} value={f.name}>{f.label}</option>)}
                                    </select>
                                </div>
                                <div className="sm:col-span-1">
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Condición</label>
                                    <select value={form.operator} onChange={e => setForm({ ...form, operator: e.target.value })} disabled={!form.field_name} className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-sm disabled:opacity-50">
                                        {FEE_OPERATORS.filter(o => form.field_name ? o.value !== 'any' : o.value === 'any').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                </div>
                                <div className="sm:col-span-1">
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Valor</label>
                                    <input value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} disabled={!opNeedsValue(form.operator)} placeholder="—" className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-sm disabled:opacity-40" />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Acción</label>
                                    <div className="flex gap-2">
                                        <button type="button" onClick={() => setForm({ ...form, action: 'set' })} className={`flex-1 py-2.5 rounded-xl text-xs font-bold border-2 transition ${form.action === 'set' ? 'border-blue-500 bg-blue-50/50 text-blue-700' : 'border-gray-100 text-gray-500'}`}>Fijar en</button>
                                        <button type="button" onClick={() => setForm({ ...form, action: 'add' })} className={`flex-1 py-2.5 rounded-xl text-xs font-bold border-2 transition ${form.action === 'add' ? 'border-amber-500 bg-amber-50/50 text-amber-700' : 'border-gray-100 text-gray-500'}`}>Sumar/restar</button>
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Monto</label>
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-sm">$</span>
                                        <input type="number" step="any" required value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" className="w-full border-2 border-gray-100 rounded-xl pl-7 pr-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-bold" />
                                    </div>
                                </div>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Prioridad (menor = primero)</label>
                                <input type="number" value={form.priority} onChange={e => setForm({ ...form, priority: Number(e.target.value) || 0 })} className="w-32 border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium" />
                            </div>
                            <div className="flex justify-end gap-3 pt-4 border-t border-gray-50">
                                <button type="button" onClick={() => { setShowModal(false); setForm(null); }} className="px-6 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition">Cancelar</button>
                                <button type="submit" className="px-8 py-2.5 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition">Guardar regla</button>
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
    const { addToast } = useToast();
    const [summary, setSummary] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        conferenceApi.getReportSummary(conferenceId)
            .then(s => { if (alive) setSummary(s); })
            .catch(() => { if (alive) addToast(t('error.loading.reports') || 'Error al cargar el reporte', 'error'); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [conferenceId]);

    const money = (n: number) => '$' + (Number(n) || 0).toLocaleString();

    const [exporting, setExporting] = useState(false);
    const downloadCsv = async () => {
        setExporting(true);
        try {
            // The sandbox can only return JSON, so fetch the CSV string and build the file locally.
            const data = await conferenceApi.exportCsv(conferenceId);
            const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = data.filename || `inscripciones-${conferenceId}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            addToast(e?.message || t('error.loading.reports') || 'Error', 'error');
        } finally {
            setExporting(false);
        }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500">{t('loading') || 'Cargando…'}</p>
            </div>
        );
    }

    const totals = summary?.totals || {};
    const pending = (Number(totals.due) || 0) - (Number(totals.paid) || 0);
    const paidPct = totals.total ? Math.round((totals.paid_count / totals.total) * 100) : 0;

    const statCards = [
        { label: t('total.registered') || 'Inscritos', value: totals.total || 0, icon: 'fa-users', color: 'text-blue-600', bg: 'bg-blue-50' },
        { label: t('collected') || 'Recaudado', value: money(totals.paid), icon: 'fa-sack-dollar', color: 'text-emerald-600', bg: 'bg-emerald-50' },
        { label: t('pending.balance') || 'Saldo pendiente', value: money(pending), icon: 'fa-clock', color: 'text-rose-500', bg: 'bg-rose-50' },
        { label: t('assigned') || 'Alojados', value: `${totals.assigned_count || 0}/${totals.total || 0}`, icon: 'fa-bed', color: 'text-indigo-600', bg: 'bg-indigo-50' },
    ];

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-8 flex-shrink-0">
                <div>
                    <h2 className="text-2xl font-black text-gray-900 italic tracking-tighter">{t('reports.title') || 'Reportes'}</h2>
                    <p className="text-sm text-gray-400 font-medium">{t('reports.subtitle') || 'Resumen de inscripciones y pagos'}</p>
                </div>
                <button
                    onClick={downloadCsv}
                    disabled={exporting}
                    className="bg-gray-900 hover:bg-black text-white px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg disabled:opacity-50"
                >
                    <i className={`fa-solid ${exporting ? 'fa-spinner animate-spin' : 'fa-file-csv'}`}></i> {t('export.csv') || 'Exportar CSV'}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto modern-scrollbar min-h-0 space-y-8">
                {/* Stat cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    {statCards.map((c) => (
                        <div key={c.label} className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm">
                            <div className={`w-10 h-10 rounded-xl ${c.bg} ${c.color} flex items-center justify-center mb-3`}>
                                <i className={`fa-solid ${c.icon}`}></i>
                            </div>
                            <div className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">{c.label}</div>
                            <div className={`text-2xl font-black ${c.color}`}>{c.value}</div>
                        </div>
                    ))}
                </div>

                {/* Payment progress */}
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="font-bold text-gray-800">{t('payment.status') || 'Estado de pagos'}</h3>
                        <span className="text-xs font-black text-emerald-600">{paidPct}% {t('paid').toLowerCase()}</span>
                    </div>
                    <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden flex">
                        <div className="bg-emerald-500 h-full" style={{ width: `${totals.total ? (totals.paid_count / totals.total) * 100 : 0}%` }}></div>
                        <div className="bg-amber-400 h-full" style={{ width: `${totals.total ? (totals.partial_count / totals.total) * 100 : 0}%` }}></div>
                    </div>
                    <div className="flex flex-wrap gap-4 mt-3 text-xs font-bold">
                        <span className="text-emerald-600"><i className="fa-solid fa-circle text-[8px] mr-1"></i>{t('paid')}: {totals.paid_count || 0}</span>
                        <span className="text-amber-500"><i className="fa-solid fa-circle text-[8px] mr-1"></i>{t('partial')}: {totals.partial_count || 0}</span>
                        <span className="text-rose-500"><i className="fa-solid fa-circle text-[8px] mr-1"></i>{t('unpaid')}: {totals.unpaid_count || 0}</span>
                    </div>
                </div>

                {/* By location */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-50">
                        <h3 className="font-bold text-gray-800">{t('by.location') || 'Por localidad'}</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-gray-50/50 text-[10px] uppercase tracking-widest text-gray-400 font-black">
                                <tr>
                                    <th className="px-6 py-3">{t('location')}</th>
                                    <th className="px-6 py-3 text-right">{t('inscriptions')}</th>
                                    <th className="px-6 py-3 text-right">{t('collected') || 'Recaudado'}</th>
                                    <th className="px-6 py-3 text-right">{t('pending.balance') || 'Pendiente'}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {(summary?.byLocation || []).length === 0 ? (
                                    <tr><td colSpan={4} className="px-6 py-8 text-center text-gray-400">{t('no.inscriptions')}</td></tr>
                                ) : (summary.byLocation.map((row: any) => (
                                    <tr key={row.location} className="hover:bg-gray-50/50">
                                        <td className="px-6 py-3 font-bold text-gray-900">{row.location}</td>
                                        <td className="px-6 py-3 text-right font-medium text-gray-600">{row.count}</td>
                                        <td className="px-6 py-3 text-right font-bold text-emerald-600">{money(row.paid)}</td>
                                        <td className="px-6 py-3 text-right font-bold text-rose-500">{money((Number(row.due) || 0) - (Number(row.paid) || 0))}</td>
                                    </tr>
                                )))}
                            </tbody>
                        </table>
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
        name: '', label: '', type: 'text', options: '', is_required: 0, sort_order: 0, width: 100, is_group: 0, is_unique: 0
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
            setFormData({ name: '', label: '', type: 'text', options: '', is_required: 0, sort_order: 0, width: 100, is_group: 0, is_unique: 0 });
            loadData();
        } catch (e: any) {
            addToast(e?.message || 'Error saving field', 'error');
        }
    };

    const handleDelete = async (id: number) => {
        if (!await confirm('Delete this field?', 'Delete Field', true)) return;
        try {
            await conferenceApi.deleteField(id);
            addToast('Field deleted', 'success');
            loadData();
        } catch (e: any) {
            addToast(e?.message || 'Error deleting field', 'error');
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

    const isPublished = !!conference?.is_form_published;

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
        const currentlyPublished = !!conference?.is_form_published;
        if (!currentlyPublished && fields.length === 0) {
            addToast("No puedes publicar un formulario sin campos.", "error");
            return;
        }

        const msg = currentlyPublished
            ? "¿Seguro que quieres despublicar el formulario?"
            : "¿Seguro que quieres publicar el formulario? Los campos no se podrán añadir ni eliminar después.";

        if (await confirm(msg, currentlyPublished ? 'Despublicar Formulario' : 'Publicar Formulario', currentlyPublished)) {
            try {
                await conferenceApi.publishForm(conferenceId, !currentlyPublished);
                addToast(currentlyPublished ? "Formulario despublicado" : "Formulario publicado", "success");
                loadData();
            } catch (e) {
                addToast("Error al cambiar el estado de publicación", "error");
            }
        }
    };

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
                                            {field.is_group ? (
                                                <span className="text-[10px] text-indigo-600 font-bold uppercase bg-indigo-50 px-2 py-0.5 rounded shadow-sm"><i className="fa-solid fa-people-group mr-1"></i>Agrupación</span>
                                            ) : null}
                                            {field.is_unique ? (
                                                <span className="text-[10px] text-amber-600 font-bold uppercase bg-amber-50 px-2 py-0.5 rounded shadow-sm"><i className="fa-solid fa-fingerprint mr-1"></i>Único</span>
                                            ) : null}
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

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
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

                                {/* Generic per-field behaviours — ANY field can carry these; nothing is tied to a
                                    fixed person attribute. Editable anytime (they don't alter the column). Separate
                                    "by gender / by any field" for lodging lives in the Assignment tab as a rule. */}
                                <div className="space-y-2.5">
                                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Comportamiento del campo</label>
                                    <label className="flex items-start gap-3 p-3 rounded-xl border-2 border-gray-100 bg-gray-50/30 cursor-pointer hover:border-blue-200 transition-all">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                            checked={!!formData.is_group}
                                            onChange={e => setFormData({ ...formData, is_group: e.target.checked ? 1 : 0 })}
                                        />
                                        <span>
                                            <span className="block text-sm font-semibold text-gray-800">Agrupar inscritos por este campo</span>
                                            <span className="block text-[11px] text-gray-400">Activa los grupos en el portal (p. ej. grupo familiar, delegación). Solo un campo puede agrupar.</span>
                                        </span>
                                    </label>
                                    <label className="flex items-start gap-3 p-3 rounded-xl border-2 border-gray-100 bg-gray-50/30 cursor-pointer hover:border-blue-200 transition-all">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                            checked={!!formData.is_unique}
                                            onChange={e => setFormData({ ...formData, is_unique: e.target.checked ? 1 : 0 })}
                                        />
                                        <span>
                                            <span className="block text-sm font-semibold text-gray-800">No permitir valores duplicados</span>
                                            <span className="block text-[11px] text-gray-400">Rechaza la inscripción si otro inscrito ya tiene el mismo valor (p. ej. documento, email).</span>
                                        </span>
                                    </label>
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
// The four composable assignment-rule primitives (must match the backend engine's rule types).
const RULE_TYPES = [
    { v: 'keep_together', label: 'Mantener juntos', icon: 'fa-people-group', desc: 'Los inscritos con el mismo valor del campo van a la misma habitación (con tamaño mínimo).' },
    { v: 'separate_by', label: 'Separar por', icon: 'fa-shield-halved', desc: 'Una habitación admite un solo valor de este campo (p. ej. género estricto).' },
    { v: 'split_by', label: 'Al dividir, agrupar por', icon: 'fa-arrows-split-up-and-left', desc: 'Cuando un grupo no cabe entero, se divide siguiendo este campo.' },
    { v: 'require_companion', label: 'Requiere acompañante', icon: 'fa-user-shield', desc: 'Una habitación con alguien que cumple una condición exige N que cumplen otra (p. ej. un niño necesita un adulto).' },
];
const ruleTypeMeta = (t: string) => RULE_TYPES.find(r => r.v === t) || RULE_TYPES[0];

// Editor for a CONDITION = a list of { field, op, value } predicates AND-ed together. Same vocabulary
// as the pricing rules, reused so the whole plugin speaks one predicate language.
const PRED_OPS = [
    { v: 'eq', l: '=' }, { v: 'neq', l: '≠' }, { v: 'gt', l: '>' }, { v: 'gte', l: '≥' },
    { v: 'lt', l: '<' }, { v: 'lte', l: '≤' }, { v: 'contains', l: 'contiene' },
    { v: 'filled', l: 'tiene valor' }, { v: 'empty', l: 'vacío' },
];
const opNeedsNoValue = (op: string) => op === 'filled' || op === 'empty';
function PredicateEditor({ fields, value, onChange, label }: any) {
    const preds = Array.isArray(value) ? value : [];
    const set = (i: number, patch: any) => onChange(preds.map((p: any, idx: number) => idx === i ? { ...p, ...patch } : p));
    const add = () => onChange([...preds, { field: fields[0]?.name || '', op: 'eq', value: '' }]);
    const remove = (i: number) => onChange(preds.filter((_: any, idx: number) => idx !== i));
    return (
        <div className="space-y-2">
            {label && <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{label}</label>}
            {preds.length === 0 && <p className="text-[10px] text-gray-400 italic px-1">Sin condición (aplica a todos).</p>}
            {preds.map((p: any, i: number) => (
                <div key={i} className="flex items-center gap-2">
                    <select className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-2 text-xs bg-white" value={p.field} onChange={e => set(i, { field: e.target.value })}>
                        {fields.map((f: any) => <option key={f.name} value={f.name}>{f.label}</option>)}
                    </select>
                    <select className="border border-gray-200 rounded-lg px-2 py-2 text-xs bg-white" value={p.op} onChange={e => set(i, { op: e.target.value })}>
                        {PRED_OPS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                    {!opNeedsNoValue(p.op) && <input className="w-20 border border-gray-200 rounded-lg px-2 py-2 text-xs" value={p.value || ''} onChange={e => set(i, { value: e.target.value })} placeholder="valor" />}
                    <button type="button" onClick={() => remove(i)} className="text-gray-300 hover:text-rose-500 px-1"><i className="fa-solid fa-xmark"></i></button>
                </div>
            ))}
            <button type="button" onClick={add} className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800"><i className="fa-solid fa-plus mr-1"></i>Añadir condición</button>
        </div>
    );
}

function AssignmentPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [rules, setRules] = useState<AssignmentRule[]>([]);
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [stats, setStats] = useState({ total: 0, assigned: 0, unassigned: 0 });
    const [running, setRunning] = useState(false);
    const [loading, setLoading] = useState(true);
    const [showRuleModal, setShowRuleModal] = useState(false);
    const [runReport, setRunReport] = useState<any>(null);
    const [ruleForm, setRuleForm] = useState<Partial<AssignmentRule>>({
        name: '', type: 'keep_together', enabled: 1, priority: 50, config: '', hard: 0, params: {}
    });
    // params arrives from the API as a JSON string; parse it into the form for editing.
    const openNewRule = () => { setRuleForm({ name: '', type: 'keep_together', enabled: 1, priority: 50, config: '', hard: 0, params: {} }); setShowRuleModal(true); };
    const openEditRule = (rule: any) => {
        let params: any = {};
        try { params = typeof rule.params === 'string' ? JSON.parse(rule.params || '{}') : (rule.params || {}); } catch { params = {}; }
        setRuleForm({ ...rule, params }); setShowRuleModal(true);
    };

    const loadData = async () => {
        setLoading(true);
        try {
            const [rulesData, inscriptions, fieldsData] = await Promise.all([
                conferenceApi.getAssignmentRules(conferenceId),
                conferenceApi.getInscriptions(conferenceId),
                conferenceApi.getFields(conferenceId)
            ]);

            setFields(fieldsData);

            // Default rules are seeded ONCE at conference-creation time (backend), NOT here — seeding
            // on "0 rules" would resurrect them every time the admin deletes them all and reloads.
            setRules(rulesData);

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
            setRuleForm({ name: '', type: 'keep_together', enabled: 1, priority: 50, config: '', hard: 0, params: {} });
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

    const handleDeleteRule = async (rule: AssignmentRule) => {
        if (!await confirm(`${t('confirm.delete.rule') || '¿Eliminar la regla'} "${rule.name}"?`, t('delete') || 'Eliminar', true)) return;
        try {
            await conferenceApi.deleteAssignmentRule(rule.id);
            addToast(t('rule.deleted') || 'Regla eliminada', 'success');
            loadData();
        } catch (e: any) {
            addToast(e?.message || 'Error deleting rule', 'error');
        }
    };

    const handleRun = async () => {
        setRunning(true);
        setRunReport(null);
        addToast(t('assignment.started'), 'info');
        try {
            const result: any = await conferenceApi.runAssignment(conferenceId);
            setRunReport(result);
            const nv = (result.violations || []).length;
            if (nv > 0) addToast(`Asignados: ${result.assignedCount}. ${nv} punto(s) no se pudieron cumplir del todo — revisa el reporte.`, 'error');
            else addToast(`${t('assignment.completed')}: ${result.assignedCount} ${t('participant.plural')}`, 'success');
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

    // Convenience accessors for the current rule's type-specific params blob.
    const rParams: any = ruleForm.params || {};
    const setRParam = (patch: any) => setRuleForm({ ...ruleForm, params: { ...(ruleForm.params || {}), ...patch } });
    const fieldSelect = (
        <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.field') || 'Campo'}</label>
            <select
                className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                value={ruleForm.config}
                onChange={e => setRuleForm({ ...ruleForm, config: e.target.value })}
            >
                <option value="">{t('select.field') || 'Seleccionar...'}</option>
                {fields.map(f => (<option key={f.name} value={f.name}>{f.label}</option>))}
            </select>
        </div>
    );

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
                        onClick={openNewRule}
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
                                    <i className={`fa-solid ${ruleTypeMeta(rule.type).icon} ${!rule.enabled && 'opacity-30'}`}></i>
                                </div>
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                        <h4 className={`font-black italic tracking-tighter text-lg ${rule.enabled ? 'text-gray-900' : 'text-gray-400'}`}>{rule.name}</h4>
                                        <div className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-600">{ruleTypeMeta(rule.type).label}</div>
                                        {rule.hard
                                            ? <div className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-rose-50 text-rose-600">Obligatoria</div>
                                            : <div className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-gray-100 text-gray-400">Preferente</div>}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-lg text-[9px] font-bold text-gray-500 uppercase tracking-tight">
                                            <i className="fa-solid fa-bolt text-amber-500"></i>
                                            {t('priority')}: {rule.priority}
                                        </div>
                                        {rule.config && (rule.type === 'keep_together' || rule.type === 'separate_by' || rule.type === 'split_by') && (
                                            <span className="font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded uppercase text-[8px] tracking-widest">
                                                {fields.find(f => f.name === rule.config)?.label || rule.config}
                                            </span>
                                        )}
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
                                <button onClick={() => openEditRule(rule)} title={t('edit') || 'Editar'} className="w-10 h-10 rounded-xl bg-white border border-gray-100 text-gray-400 hover:text-indigo-600 hover:border-indigo-100 hover:bg-indigo-50 transition-all flex items-center justify-center">
                                    <i className="fa-solid fa-pen text-sm"></i>
                                </button>
                                <button onClick={() => handleDeleteRule(rule)} title={t('delete')} className="w-10 h-10 rounded-xl bg-white border border-gray-100 text-gray-400 hover:text-rose-600 hover:border-rose-100 hover:bg-rose-50 transition-all flex items-center justify-center group/del">
                                    <i className="fa-solid fa-trash-can text-sm group-hover/del:scale-110 transition-transform"></i>
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {runReport && (
                <div className={`rounded-3xl border p-6 shadow-xl ${(runReport.violations || []).length ? 'bg-amber-50/40 border-amber-200' : 'bg-emerald-50/40 border-emerald-200'}`}>
                    <div className="flex items-center gap-3 mb-3">
                        <i className={`fa-solid ${(runReport.violations || []).length ? 'fa-triangle-exclamation text-amber-500' : 'fa-circle-check text-emerald-500'} text-lg`}></i>
                        <h3 className="text-sm font-black text-gray-900 uppercase tracking-widest">Resultado de la asignación</h3>
                        <button onClick={() => setRunReport(null)} className="ml-auto text-gray-300 hover:text-gray-500"><i className="fa-solid fa-xmark"></i></button>
                    </div>
                    <p className="text-xs text-gray-600 mb-3">Asignados <b>{runReport.assignedCount}</b>{runReport.remaining ? <> · <span className="text-amber-700 font-bold">{runReport.remaining} sin cupo</span></> : null}.</p>
                    {(runReport.violations || []).length === 0 ? (
                        <p className="text-xs text-emerald-700 font-medium">Todas las reglas se cumplieron. ✓</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {runReport.violations.map((v: any, i: number) => (
                                <li key={i} className="flex items-start gap-2 text-xs text-gray-700">
                                    <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest whitespace-nowrap ${v.hard ? 'bg-rose-100 text-rose-600' : 'bg-gray-200 text-gray-500'}`}>{v.hard ? 'Obligatoria' : 'Preferente'}</span>
                                    <span><b>{v.rule}</b> — {v.detail}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {showRuleModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg border border-gray-100 max-h-[92vh] overflow-y-auto animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between sticky top-0 z-10">
                            <div>
                                <h3 className="font-black text-xl text-gray-900 italic tracking-tighter">{ruleForm.id ? 'Editar regla' : t('add.rule')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Criterio de asignación de habitaciones</p>
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
                                    placeholder="Ej: Familias juntas"
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Tipo de regla</label>
                                <select
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                    value={ruleForm.type}
                                    onChange={e => setRuleForm({ ...ruleForm, type: e.target.value as any })}
                                >
                                    {RULE_TYPES.map(rt => <option key={rt.v} value={rt.v}>{rt.label}</option>)}
                                </select>
                                <p className="text-[10px] text-gray-400 italic px-1">{ruleTypeMeta(ruleForm.type as string).desc}</p>
                            </div>

                            {/* Type-specific configuration */}
                            {ruleForm.type === 'keep_together' && (
                                <>
                                    {fieldSelect}
                                    <div className="space-y-1.5">
                                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Tamaño mínimo del grupo</label>
                                        <input type="number" min="1" className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                            value={rParams.min_size || 1} onChange={e => setRParam({ min_size: Number(e.target.value) })} />
                                        <p className="text-[10px] text-gray-400 italic px-1">Solo se mantienen juntos los grupos de este tamaño o más (p. ej. 3 → una pareja de 2 puede separarse).</p>
                                    </div>
                                    <PredicateEditor fields={fields} label="Solo aplica si (opcional)" value={rParams.when} onChange={(v: any) => setRParam({ when: v })} />
                                </>
                            )}

                            {(ruleForm.type === 'separate_by' || ruleForm.type === 'split_by') && fieldSelect}

                            {ruleForm.type === 'require_companion' && (
                                <>
                                    <PredicateEditor fields={fields} label="Si en la habitación hay alguien que cumple" value={rParams.subject} onChange={(v: any) => setRParam({ subject: v })} />
                                    <div className="space-y-1.5">
                                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Debe haber al menos</label>
                                        <input type="number" min="1" className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                            value={rParams.min || 1} onChange={e => setRParam({ min: Number(e.target.value) })} />
                                    </div>
                                    <PredicateEditor fields={fields} label="…que cumplan" value={rParams.needs} onChange={(v: any) => setRParam({ needs: v })} />
                                </>
                            )}

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.priority')} (1-100)</label>
                                    <input type="number" min="1" max="100" className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                        value={ruleForm.priority} onChange={e => setRuleForm({ ...ruleForm, priority: Number(e.target.value) })} />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Cumplimiento</label>
                                    <select className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                        value={ruleForm.hard ? '1' : '0'} onChange={e => setRuleForm({ ...ruleForm, hard: e.target.value === '1' ? 1 : 0 })}>
                                        <option value="0">Preferente</option>
                                        <option value="1">Obligatoria</option>
                                    </select>
                                </div>
                            </div>
                            <p className="text-[10px] text-gray-400 italic px-1">Prioridad alta se procesa primero. «Obligatoria» nunca se viola; «preferente» se intenta y, si no se logra, se reporta.</p>

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

    // Clipboard access throws on non-secure origins (LAN-IP HTTP deployments this repo has hit).
    // Feature-check + fall back to a hidden-textarea copy; only report success when it worked.
    const copyToClipboard = async (text: string): Promise<boolean> => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    };

    const handleCopyLink = async () => {
        if (!currentConference?.slug) return;
        if (!conference?.is_form_published) {
            addToast('El formulario no está publicado. El enlace no funcionará para el público.', 'warning');
        }
        const fullUrl = `${window.location.protocol}//${window.location.host}/portal/conference?slug=${currentConference.slug}`;
        if (await copyToClipboard(fullUrl)) addToast('Enlace copiado al portapapeles', 'success');
        else addToast(fullUrl, 'info'); // fallback: show the link so it can be copied manually
    };

    const isPublished = !!conference?.is_form_published;

    const [copiedId, setCopiedId] = useState<number | null>(null);

    const handleCopyCode = async (code: string, id: number) => {
        if (await copyToClipboard(code)) {
            setCopiedId(id);
            setTimeout(() => setCopiedId(null), 2000);
        } else {
            addToast(`${t('code') || 'Código'}: ${code}`, 'info');
        }
    };

    const handleRotateCode = async (loc: Location) => {
        if (!await confirm(t('confirm.rotate.code') || '¿Generar un código nuevo? El código actual dejará de funcionar.', t('rotate.code') || 'Rotar código', false)) return;
        try {
            await conferenceApi.updateLocation(loc.id, { rotate_code: true });
            addToast(t('code.rotated') || 'Código actualizado', 'success');
            loadLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
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

            <div className="flex flex-col gap-4 sm:flex-row sm:items-center justify-between bg-gray-50/50 p-8 rounded-[32px] border-2 border-white shadow-sm">
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
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => handleCopyCode(loc.code, loc.id)}
                                                    className={`text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-xl transition-all duration-300 shadow-sm ${copiedId === loc.id ? 'bg-emerald-500 text-white' : 'bg-white text-blue-600 hover:bg-blue-600 hover:text-white'}`}
                                                >
                                                    {copiedId === loc.id ? t('copied') || '¡Copiado!' : t('copy') || 'Copiar'}
                                                </button>
                                                <button
                                                    onClick={() => handleRotateCode(loc)}
                                                    title={t('rotate.code') || 'Rotar código'}
                                                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-white text-gray-400 hover:bg-amber-500 hover:text-white transition-all shadow-sm"
                                                >
                                                    <i className="fa-solid fa-rotate text-xs"></i>
                                                </button>
                                            </div>
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
