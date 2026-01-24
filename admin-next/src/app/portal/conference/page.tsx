"use client";

import React, { useState, useEffect } from "react";
import { ToastProvider, useToast } from "@/contexts/ToastContext";
// Import global API helper specifically suitable for handling custom headers or URLs if needed,
// but basically we can reuse the generic apiGet/Post if we can override headers or just use fetch for the auth ones.
// We'll create a simple local fetcher for the portal to manage the custom token auth simpler.
// import { apiGet } from "../../src/lib/api"; // Unused

// Reusing types from plugin (re-defined here to avoid complex relative imports or just hardcode generic)
interface Conference {
    id: number;
    name: string;
    slug: string;
    date_start?: string;
    date_end?: string;
    description?: string;
    status?: string;
}

interface Location {
    id: number;
    name: string;
    responsible_name: string;
    conference_id?: number;
}

interface Inscription {
    id: number;
    first_name: string;
    last_name: string;
    gender: string;
    email: string;
    phone: string;
    status: string;
    payment_status: string;
    total_due: number;
    amount_paid: number;
}

function LocationPortalContent() {
    const { addToast } = useToast();
    // Auth State
    const [token, setToken] = useState<string | null>(null);
    const [myLocation, setMyLocation] = useState<Location | null>(null);
    const [step, setStep] = useState<'login' | 'dashboard'>('login');
    const [loading, setLoading] = useState(false);

    // Login State
    const [conferences, setConferences] = useState<Conference[]>([]);
    const [selectedConference, setSelectedConference] = useState<string>('');
    const [isConferenceLocked, setIsConferenceLocked] = useState(false);
    const [locations, setLocations] = useState<Location[]>([]);
    const [selectedLocation, setSelectedLocation] = useState<string>('');
    const [code, setCode] = useState('');

    // Dashboard State
    const [inscriptions, setInscriptions] = useState<Inscription[]>([]);
    const [view, setView] = useState<'list' | 'add'>('list');
    const [error, setError] = useState<string | null>(null);

    // Dynamic Form Data
    const [formData, setFormData] = useState<Record<string, any>>({});
    const [fields, setFields] = useState<any[]>([]);

    // Payment State
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const [paymentForm, setPaymentForm] = useState({
        amount_per_person: '',
        method: 'Efectivo',
        reference: '',
        proof: ''
    });

    // 1. Initial Load: Check token (via cookie) & Load Conferences
    useEffect(() => {
        // We no longer check localStorage for portal_token.
        // Instead, we just try to verify our session with the server.
        verifyToken();
    }, []);

    // 2. Load Locations when Conference Selected
    useEffect(() => {
        if (selectedConference) {
            loadLocations(selectedConference);
        } else {
            setLocations([]);
        }
    }, [selectedConference]);

    const verifyToken = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/v1/conference/portal/me', {
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                setMyLocation(data);
                setStep('dashboard');
                loadInscriptions();
            } else {
                // If not logged in, load the conferences for the login screen
                loadConferences();
            }
        } catch (e) {
            loadConferences();
        } finally {
            setLoading(false);
        }
    };

    const loadConferences = async () => {
        try {
            const res = await fetch('/api/v1/conference/public/list');
            if (res.ok) {
                const data = await res.json();
                setConferences(data);

                if (typeof window !== 'undefined') {
                    const params = new URLSearchParams(window.location.search);
                    const slug = params.get('slug');
                    if (slug) {
                        const found = data.find((c: Conference) => c.slug === slug);
                        if (found) {
                            setSelectedConference(found.id.toString());
                            setIsConferenceLocked(true);
                        } else {
                            setError('La conferencia solicitada no está disponible o el formulario no ha sido publicado.');
                        }
                    } else if (data.length === 0) {
                        setError('No hay conferencias disponibles en este momento.');
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }
    };

    const loadLocations = async (confId: string) => {
        try {
            const res = await fetch(`/api/v1/conference/public/locations?conference_id=${confId}`);
            if (res.ok) {
                setLocations(await res.json());
                // Also load fields
                const fieldsRes = await fetch(`/api/v1/conference/public/fields?conference_id=${confId}`);
                if (fieldsRes.ok) {
                    const fieldsData = await fieldsRes.json();
                    setFields(fieldsData);
                    // Initialize formData
                    const initial: any = {};
                    fieldsData.forEach((f: any) => {
                        initial[f.name] = f.type === 'number' ? 0 : (f.type === 'select' ? f.options.split(',')[0].trim() : '');
                    });
                    setFormData(initial);
                }
            } else if (res.status === 403) {
                const err = await res.json();
                addToast(err.error, 'error');
                setSelectedConference('');
            }
        } catch (e) { console.error(e); }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/v1/conference/portal/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ location_id: selectedLocation, code }),
                credentials: 'include'
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setToken(data.token);
                setMyLocation(data.location);
                setStep('dashboard');
                loadInscriptions();
            } else {
                addToast(data.error || 'Login failed', 'error');
            }
        } catch (e) {
            addToast('Connection error', 'error');
        } finally {
            setLoading(false);
        }
    };

    const logout = () => {
        // Since we are using HttpOnly cookies, we should ideally have a logout endpoint 
        // to clear the cookie. For now, we'll just clear the state.
        setToken(null);
        setMyLocation(null);
        setStep('login');
        loadConferences();
    };

    const loadInscriptions = async () => {
        try {
            const res = await fetch('/api/v1/conference/portal/inscriptions', {
                credentials: 'include'
            });
            if (res.ok) setInscriptions(await res.json());
        } catch (e) { console.error(e); }
    };

    const handleCreateInscription = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/v1/conference/portal/inscriptions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData),
                credentials: 'include'
            });
            if (res.ok) {
                addToast('Inscripción creada correctamente', 'success');
                setView('list');
                // Reset form with initials
                const initial: any = {};
                fields.forEach(f => {
                    initial[f.name] = f.type === 'number' ? 0 : (f.type === 'select' ? f.options.split(',')[0].trim() : '');
                });
                setFormData(initial);
                loadInscriptions();
            } else {
                const err = await res.json();
                addToast(err.error || 'Error', 'error');
            }
        } catch (e) {
            addToast('Connection error', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleBulkPayment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (selectedIds.length === 0) return;
        setLoading(true);
        try {
            const res = await fetch('/api/v1/conference/portal/payments/bulk', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    inscription_ids: selectedIds,
                    amount_per_person: Number(paymentForm.amount_per_person),
                    method: paymentForm.method,
                    reference: paymentForm.reference,
                    proof: paymentForm.proof
                }),
                credentials: 'include'
            });

            if (res.ok) {
                addToast('Pagos registrados correctamente', 'success');
                setShowPaymentModal(false);
                setSelectedIds([]);
                setPaymentForm({ amount_per_person: '', method: 'Efectivo', reference: '', proof: '' });
                loadInscriptions();
            } else {
                const err = await res.json();
                addToast(err.error || 'Error al procesar pagos', 'error');
            }
        } catch (e) {
            addToast('Error de conexión', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onloadend = () => {
            setPaymentForm({ ...paymentForm, proof: reader.result as string });
        };
        reader.readAsDataURL(file);
    };

    if (loading && !myLocation && step === 'dashboard') {
        return <div className="flex h-screen items-center justify-center">Cargando...</div>;
    }

    // === ERROR VIEW ===
    if (error) {
        return (
            <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
                <div className="bg-white p-8 rounded-xl shadow-lg w-full max-w-md text-center">
                    <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center text-3xl mx-auto mb-4">
                        <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <h1 className="text-xl font-bold text-gray-900 mb-2">Acceso No Disponible</h1>
                    <p className="text-gray-500 mb-6">{error}</p>
                    <button
                        onClick={() => { setError(null); window.history.pushState({}, '', window.location.pathname); loadConferences(); }}
                        className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition"
                    >
                        Ver otras conferencias
                    </button>
                </div>
            </div>
        );
    }

    // === LOGIN VIEW ===
    if (step === 'login') {
        return (
            <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
                <div className="bg-white p-8 rounded-xl shadow-lg w-full max-w-md">
                    <div className="text-center mb-6">
                        <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center text-white text-3xl mx-auto mb-4">
                            <i className="fa-solid fa-map-marker-alt"></i>
                        </div>
                        <h1 className="text-2xl font-bold text-gray-900">Portal de Localidades</h1>
                        <p className="text-gray-500">Gestión de inscripciones</p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Conferencia
                                {isConferenceLocked && <i className="fa-solid fa-lock text-xs text-gray-400 ml-2" title="Conferencia pre-seleccionada"></i>}
                            </label>
                            <select
                                className={`w-full border rounded-lg p-3 text-gray-900 ${isConferenceLocked ? 'bg-gray-200 cursor-not-allowed opacity-75' : 'bg-gray-50'}`}
                                value={selectedConference}
                                onChange={e => setSelectedConference(e.target.value)}
                                disabled={isConferenceLocked}
                                required
                            >
                                <option value="">Seleccione una conferencia</option>
                                {conferences.map(c => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Localidad</label>
                            <select
                                className="w-full border rounded-lg p-3 bg-gray-50 text-gray-900 disabled:opacity-50"
                                value={selectedLocation}
                                onChange={e => setSelectedLocation(e.target.value)}
                                disabled={!selectedConference}
                                required
                            >
                                <option value="">Seleccione su localidad</option>
                                {locations.map(l => (
                                    <option key={l.id} value={l.id}>{l.name} ({l.responsible_name})</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Código de Acceso</label>
                            <div className="relative">
                                <input
                                    type="password"
                                    className="w-full border rounded-lg p-3 pl-10 bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                    placeholder="••••••"
                                    maxLength={6}
                                    value={code}
                                    onChange={e => setCode(e.target.value)}
                                    required
                                />
                                <i className="fa-solid fa-lock absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading || !selectedLocation || !code}
                            className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                        >
                            {loading ? 'Verificando...' : 'Ingresar'}
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    // === DASHBOARD VIEW ===
    return (
        <div className="min-h-screen bg-gray-50">
            {/* Header */}
            <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
                <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between items-center h-16">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center">
                                <i className="fa-solid fa-map-marker-alt"></i>
                            </div>
                            <div>
                                <h1 className="text-xl font-bold text-gray-900">{myLocation?.name}</h1>
                                <p className="text-xs text-gray-500">{myLocation?.responsible_name}</p>
                            </div>
                        </div>
                        <button
                            onClick={logout}
                            className="text-gray-500 hover:text-red-600 transition"
                            title="Cerrar Sessión"
                        >
                            <i className="fa-solid fa-right-from-bracket text-lg"></i>
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                        <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-2">Total Inscritos</div>
                        <div className="flex items-end gap-2">
                            <div className="text-3xl font-black text-blue-600">{inscriptions.length}</div>
                            <div className="text-gray-400 text-xs mb-1 font-medium italic">personas</div>
                        </div>
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                        <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-2">Total Recaudado</div>
                        <div className="flex items-end gap-1">
                            <div className="text-3xl font-black text-emerald-600">
                                ${inscriptions.reduce((sum, i) => sum + (i.amount_paid || 0), 0).toLocaleString()}
                            </div>
                        </div>
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                        <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-2">Saldo Pendiente</div>
                        <div className="flex items-end gap-1">
                            <div className="text-3xl font-black text-rose-500">
                                ${inscriptions.reduce((sum, i) => sum + ((i.total_due || 0) - (i.amount_paid || 0)), 0).toLocaleString()}
                            </div>
                        </div>
                    </div>
                </div>

                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50/50">
                        <h2 className="font-bold text-gray-800">
                            {view === 'list' ? 'Participantes' : 'Nueva Inscripción'}
                        </h2>
                        {view === 'list' ? (
                            <div className="flex items-center gap-2">
                                {selectedIds.length > 0 && (
                                    <button
                                        onClick={() => {
                                            // Pre-fill amount if only one selected or just leave blank
                                            const defaultAmount = selectedIds.length === 1 ? (inscriptions.find(i => i.id === selectedIds[0])?.total_due || 0) - (inscriptions.find(i => i.id === selectedIds[0])?.amount_paid || 0) : '';
                                            setPaymentForm(prev => ({ ...prev, amount_per_person: String(defaultAmount) }));
                                            setShowPaymentModal(true);
                                        }}
                                        className="bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 transition flex items-center gap-2 text-sm font-medium animate-in zoom-in duration-200 shadow-lg"
                                    >
                                        <i className="fa-solid fa-file-invoice-dollar"></i> Registrar Pago ({selectedIds.length})
                                    </button>
                                )}
                                <button
                                    onClick={() => setView('add')}
                                    className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition flex items-center gap-2 text-sm font-medium"
                                >
                                    <i className="fa-solid fa-plus"></i> Registrar Nuevo
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => setView('list')}
                                className="text-gray-600 hover:bg-gray-100 px-4 py-2 rounded-lg transition flex items-center gap-2 text-sm font-medium"
                            >
                                <i className="fa-solid fa-arrow-left"></i> Volver a la lista
                            </button>
                        )}
                    </div>

                    {view === 'list' ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="text-xs text-gray-500 uppercase bg-gray-50 border-b">
                                    <tr>
                                        <th className="px-6 py-3 w-10 text-center">
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.length === inscriptions.length && inscriptions.length > 0}
                                                onChange={(e) => {
                                                    if (e.target.checked) setSelectedIds(inscriptions.map(i => i.id));
                                                    else setSelectedIds([]);
                                                }}
                                                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                            />
                                        </th>
                                        <th className="px-6 py-3">Nombre</th>
                                        <th className="px-6 py-3">Contacto</th>
                                        <th className="px-6 py-3">Estado</th>
                                        <th className="px-6 py-3">Pago</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {inscriptions.length === 0 ? (
                                        <tr>
                                            <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                                                No hay participantes registrados en esta localidad.
                                            </td>
                                        </tr>
                                    ) : (
                                        inscriptions.map(i => (
                                            <tr key={i.id} className={`border-b hover:bg-gray-50 transition-colors ${selectedIds.includes(i.id) ? 'bg-blue-50/50' : ''}`}>
                                                <td className="px-6 py-4 text-center">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedIds.includes(i.id)}
                                                        onChange={(e) => {
                                                            if (e.target.checked) setSelectedIds([...selectedIds, i.id]);
                                                            else setSelectedIds(selectedIds.filter(id => id !== i.id));
                                                        }}
                                                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                    />
                                                </td>
                                                <td className="px-6 py-4 font-medium text-gray-900">
                                                    {i.first_name} {i.last_name}
                                                    <div className="text-xs text-gray-400 font-normal">{i.gender === 'M' ? 'Hombre' : 'Mujer'} • {i.email}</div>
                                                </td>
                                                <td className="px-6 py-4 text-gray-500">
                                                    {i.phone || '-'}
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                                        {i.status}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex flex-col">
                                                        <span className={`px-2 py-1 rounded-full text-xs font-medium w-fit ${i.payment_status === 'paid' ? 'bg-green-100 text-green-800' :
                                                            i.payment_status === 'partial' ? 'bg-orange-100 text-orange-800' : 'bg-red-100 text-red-800'
                                                            }`}>
                                                            {i.payment_status === 'unpaid' ? 'Sin Pagar' : (i.payment_status === 'paid' ? 'Pagado' : 'Abono')}
                                                        </span>
                                                        <div className="text-[11px] text-gray-500 mt-1 font-medium">
                                                            PAGADO: <span className="text-gray-900">${i.amount_paid}</span> / <span className="text-gray-400">${i.total_due}</span>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="p-6">
                            <form onSubmit={handleCreateInscription} className="max-w-2xl mx-auto space-y-6">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    {fields.length === 0 ? (
                                        <div className="col-span-2 text-center p-10 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                                            <i className="fa-solid fa-triangle-exclamation text-yellow-500 text-3xl mb-3"></i>
                                            <p className="text-gray-600 font-medium">No hay campos configurados para este formulario.</p>
                                        </div>
                                    ) : (
                                        fields.map((field) => (
                                            <div key={field.name} className={field.width === 50 ? 'col-span-1' : 'col-span-2'}>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                                    {field.label} {field.is_required ? '*' : ''}
                                                </label>
                                                {field.type === 'select' ? (
                                                    <select
                                                        required={!!field.is_required}
                                                        className="w-full border rounded-lg p-2.5 bg-white"
                                                        value={formData[field.name] || ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                                                    >
                                                        {field.options.split(',').map((opt: string) => (
                                                            <option key={opt.trim()} value={opt.trim()}>{opt.trim()}</option>
                                                        ))}
                                                    </select>
                                                ) : field.type === 'textarea' ? (
                                                    <textarea
                                                        required={!!field.is_required}
                                                        className="w-full border rounded-lg p-2.5"
                                                        rows={3}
                                                        value={formData[field.name] || ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                                                    />
                                                ) : (
                                                    <input
                                                        type={field.type}
                                                        required={!!field.is_required}
                                                        className="w-full border rounded-lg p-2.5"
                                                        value={formData[field.name] || ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: field.type === 'number' ? Number(e.target.value) : e.target.value })}
                                                    />
                                                )}
                                            </div>
                                        ))
                                    )}
                                </div>

                                <div className="flex justify-end gap-3 pt-6 border-t mt-4">
                                    <button
                                        type="button"
                                        onClick={() => setView('list')}
                                        className="px-6 py-2.5 text-gray-700 hover:bg-gray-100 rounded-lg transition"
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={loading || fields.length === 0}
                                        className="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                                    >
                                        Guardar Inscripción
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}
                </div>
            </main>
            {showPaymentModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-bold text-xl text-gray-900 italic">Registrar Pago Grupal</h3>
                                <p className="text-xs text-gray-500 mt-0.5">Se aplicará a {selectedIds.length} personas seleccionadas</p>
                            </div>
                            <button onClick={() => setShowPaymentModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>

                        <form onSubmit={handleBulkPayment} className="p-8 space-y-5">
                            <div className="space-y-1.5">
                                <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Monto por Persona</label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold">$</span>
                                    <input
                                        required
                                        type="number"
                                        className="w-full border-2 border-gray-100 rounded-xl px-10 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold"
                                        value={paymentForm.amount_per_person}
                                        onChange={e => setPaymentForm({ ...paymentForm, amount_per_person: e.target.value })}
                                        placeholder="0.00"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Método</label>
                                    <select
                                        className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 font-medium outline-none"
                                        value={paymentForm.method}
                                        onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })}
                                    >
                                        <option>Efectivo</option>
                                        <option>Transferencia</option>
                                        <option>Consignación</option>
                                    </select>
                                </div>
                                <div className="space-y-1.5">
                                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Referencia (Opcional)</label>
                                    <input
                                        className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 font-medium outline-none"
                                        value={paymentForm.reference}
                                        onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })}
                                        placeholder="# Recibo / Trans"
                                    />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Comprobante de Pago</label>
                                <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 transition-colors hover:border-blue-400 relative overflow-hidden group">
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={handleFileChange}
                                        className="absolute inset-0 opacity-0 cursor-pointer z-10"
                                    />
                                    {paymentForm.proof ? (
                                        <div className="flex items-center gap-3">
                                            <img src={paymentForm.proof} className="w-12 h-12 rounded-lg object-cover border border-gray-200" />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-bold text-blue-600 truncate">Imagen cargada correctamente</p>
                                                <p className="text-[10px] text-gray-400 italic">Haz clic para cambiar</p>
                                            </div>
                                            <button type="button" onClick={() => setPaymentForm({ ...paymentForm, proof: '' })} className="relative z-20 text-red-500 hover:text-red-700 p-2">
                                                <i className="fa-solid fa-trash-can"></i>
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="text-center py-2">
                                            <i className="fa-solid fa-cloud-arrow-up text-gray-300 text-2xl mb-2 group-hover:text-blue-400 transition-colors"></i>
                                            <p className="text-xs text-gray-500 font-medium">Adjuntar foto del comprobante</p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-3 pt-6">
                                <button
                                    type="button"
                                    onClick={() => setShowPaymentModal(false)}
                                    className="px-6 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition"
                                >
                                    Cancelar
                                </button>
                                <button
                                    type="submit"
                                    disabled={loading || !paymentForm.amount_per_person}
                                    className="px-8 py-2.5 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition disabled:opacity-50"
                                >
                                    {loading ? 'Procesando...' : 'Confirmar Pago'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function LocationPortalPage() {
    return (
        <ToastProvider>
            <LocationPortalContent />
        </ToastProvider>
    );
}
