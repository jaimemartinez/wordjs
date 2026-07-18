"use client";

/**
 * Marketplace tab for /admin/plugins — browse the plugin catalog and install with one click.
 * Installs go through POST /api/v1/marketplace/install, which downloads the zip server-side,
 * sha256-verifies it and runs the exact same security pipeline as a manual upload. After a
 * successful install the plugin appears in the "Instalados" tab (inactive, permissions
 * default-deny) where the admin activates it and grants its capabilities.
 */

import { useEffect, useMemo, useState } from "react";
import { marketplaceApi, MarketplaceEntry } from "@/lib/api";
import { permMeta } from "@/lib/permissionMeta";
import { useToast } from "@/contexts/ToastContext";
import { FaSearch, FaSyncAlt, FaDownload, FaCheck, FaThLarge, FaStore } from "react-icons/fa";
import { Button, EmptyState } from "@/components/ui";

const permToken = (p: { scope: string; access?: string }) =>
    p.scope === 'network' ? 'network' : `${p.scope}:${p.access || 'read'}`;

function fmtKB(bytes: number) {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function MarketplaceTab({ onInstalled }: { onInstalled: () => void }) {
    const { addToast } = useToast();
    const [entries, setEntries] = useState<MarketplaceEntry[]>([]);
    const [source, setSource] = useState<string>("");
    const [isLocal, setIsLocal] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>("");
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<string>("all");
    const [installing, setInstalling] = useState<Record<string, boolean>>({});
    const [confirmEntry, setConfirmEntry] = useState<MarketplaceEntry | null>(null);

    const load = async (refresh = false) => {
        setLoading(true);
        setError("");
        try {
            const data = await marketplaceApi.catalog(refresh);
            setEntries(data.plugins || []);
            setSource(data.source);
            setIsLocal(data.isLocal);
        } catch (e: any) {
            setError(e?.message || "No se pudo cargar el catálogo.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const categories = useMemo(() => {
        const set = new Set(entries.map((e) => e.category || "General"));
        return ["all", ...Array.from(set).sort()];
    }, [entries]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return entries.filter((e) => {
            if (category !== "all" && (e.category || "General") !== category) return false;
            if (!q) return true;
            return `${e.name} ${e.id} ${e.description}`.toLowerCase().includes(q);
        });
    }, [entries, search, category]);

    const doInstall = async (entry: MarketplaceEntry) => {
        setConfirmEntry(null);
        setInstalling((m) => ({ ...m, [entry.id]: true }));
        try {
            await marketplaceApi.install(entry.id);
            addToast(`"${entry.name}" instalado. Actívalo y otorga sus permisos en Instalados.`, "success");
            setEntries((list) => list.map((e) => (e.id === entry.id ? { ...e, installed: true, installedVersion: e.version, updateAvailable: false } : e)));
            onInstalled();
        } catch (e: any) {
            addToast(e?.message || "No se pudo instalar el plugin.", "error");
        } finally {
            setInstalling((m) => ({ ...m, [entry.id]: false }));
        }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500 text-sm">Cargando el catálogo…</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="max-w-xl mx-auto text-center py-16">
                <div className="w-16 h-16 bg-amber-50 text-amber-500 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-4">
                    <FaStore />
                </div>
                <h3 className="font-bold text-gray-900 mb-2">No se pudo cargar el marketplace</h3>
                <p className="text-sm text-gray-500 mb-6">{error}</p>
                <Button onClick={() => load(true)}><FaSyncAlt className="mr-2" /> Reintentar</Button>
            </div>
        );
    }

    return (
        <div>
            {/* Toolbar */}
            <div className="flex flex-col md:flex-row md:items-center gap-4 mb-8">
                <div className="relative flex-1 max-w-md">
                    <FaSearch className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Buscar plugins…"
                        className="w-full pl-10 pr-4 py-3 rounded-2xl border border-slate-200/60 bg-white/50 backdrop-blur-md focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all text-xs font-semibold placeholder-slate-400 shadow-sm"
                    />
                </div>
                <div className="flex p-1 bg-slate-200/40 backdrop-blur-md rounded-2xl border border-slate-200/30 shadow-sm items-center gap-1 flex-wrap">
                    {categories.map((c) => (
                        <button
                            key={c}
                            onClick={() => setCategory(c)}
                            className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-300 ${category === c ? "bg-white text-slate-900 shadow-sm border border-slate-100/50" : "text-slate-500 hover:text-slate-800"}`}
                        >
                            {c === "all" ? "Todos" : c}
                        </button>
                    ))}
                </div>
                <button
                    onClick={() => load(true)}
                    title="Actualizar catálogo"
                    className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white border border-slate-200/60 text-slate-500 hover:text-slate-850 hover:border-slate-300 hover:scale-105 active:scale-95 transition-all shadow-sm ml-auto"
                >
                    <FaSyncAlt className="text-xs" />
                </button>
            </div>

            <p className="text-[10px] font-semibold text-slate-450/80 mb-6 bg-slate-50 border border-slate-150/60 px-4 py-2.5 rounded-xl inline-block shadow-[inset_0_2px_4px_rgba(0,0,0,0.015)]">
                Fuente: <span className="font-mono text-slate-650 bg-slate-100 px-1.5 py-0.5 rounded">{isLocal ? "catálogo local" : source}</span> · {entries.length} plugins ·
                Los plugins se instalan desactivados y con permisos denegados por defecto.
            </p>

            {filtered.length === 0 ? (
                <EmptyState icon="fa-puzzle-piece" title="Sin resultados" description="Ningún plugin coincide con la búsqueda." />
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    {filtered.map((e) => {
                        const busy = !!installing[e.id];
                        return (
                            <div key={e.id} className="group bg-gradient-to-b from-white/60 to-white/30 border border-slate-200/50 rounded-[24px] p-6 flex flex-col shadow-[0_10px_20px_-10px_rgba(0,0,0,0.02)] hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.08)] hover:-translate-y-1.5 hover:border-slate-300/80 transition-all duration-500 backdrop-blur-xl">
                                <div className="flex items-start justify-between gap-3 mb-4">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/15 text-blue-600 flex items-center justify-center shrink-0 shadow-sm group-hover:scale-105 transition-transform duration-300">
                                            <i className={`fas ${e.adminMenu?.icon || "fa-puzzle-piece"} text-lg`} />
                                        </div>
                                        <div className="min-w-0">
                                            <h3 className="font-extrabold text-slate-900 group-hover:text-blue-600 transition-colors duration-300 truncate">{e.name}</h3>
                                            <div className="text-[10px] text-slate-400 font-mono mt-0.5">v{e.version} · {fmtKB(e.size)}</div>
                                        </div>
                                    </div>
                                    <span className="text-[8px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full bg-slate-50 border border-slate-200/40 text-slate-500 shrink-0 shadow-sm">{e.category}</span>
                                </div>

                                <p className="text-slate-500 text-xs mb-4 line-clamp-3 flex-1 font-medium leading-relaxed">{e.description}</p>

                                <div className="flex items-center gap-2 flex-wrap mb-5">
                                    {e.hasPuckBlock && (
                                        <span className="inline-flex items-center gap-1 text-[8px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full bg-indigo-50 border border-indigo-100/50 text-indigo-650 shadow-sm">
                                            <FaThLarge className="text-[7px]" /> Bloque {e.blockName}
                                        </span>
                                    )}
                                    {(e.permissions || []).map((p) => {
                                        const token = permToken(p);
                                        const meta = permMeta(token);
                                        return (
                                            <span key={token} title={meta.label} className={`text-[8px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full border shadow-sm ${meta.risk === "high" ? "bg-rose-50 text-rose-600 border-rose-100/50" : meta.risk === "med" ? "bg-amber-50 text-amber-600 border-amber-100/50" : "bg-slate-50 text-slate-550 border-slate-100"}`}>
                                                {token.split(':')[0]}
                                            </span>
                                        );
                                    })}
                                </div>

                                {e.installed && !e.updateAvailable ? (
                                    <div className="flex items-center gap-2 text-emerald-600 text-xs font-black uppercase tracking-wider bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3 justify-center w-full shadow-sm">
                                        <FaCheck className="text-[10px]" /> Instalado {e.active ? "(activo)" : "(inactivo)"}
                                    </div>
                                ) : (
                                    <Button onClick={() => setConfirmEntry(e)} disabled={busy} className="w-full justify-center shadow-lg shadow-gray-200/50">
                                        {busy ? (
                                            <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        ) : (
                                            <>
                                                <FaDownload className="mr-2 text-xs" />
                                                {e.updateAvailable ? `Actualizar a v${e.version}` : "Instalar"}
                                            </>
                                        )}
                                    </Button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Install confirm modal — surfaces the permissions the plugin will REQUEST (grants stay
                default-deny; the admin approves each one after activation, same as uploads). */}
            {confirmEntry && (
                <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4" onClick={() => setConfirmEntry(null)}>
                    <div className="bg-white/95 backdrop-blur-lg rounded-[32px] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 w-full max-w-md p-8 animate-in fade-in zoom-in-95 duration-200" onClick={(ev) => ev.stopPropagation()}>
                        <h3 className="font-extrabold text-lg text-slate-900 mb-1">Instalar {confirmEntry.name}</h3>
                        <p className="text-xs font-medium text-slate-500 mb-5 leading-relaxed">
                            v{confirmEntry.version} · {fmtKB(confirmEntry.size)} · el paquete se verifica con sha256 y pasa el mismo escaneo de seguridad que una subida manual.
                        </p>
                        {(confirmEntry.permissions || []).length > 0 && (
                            <>
                                <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-3">Permisos que solicitará</div>
                                <div className="space-y-2 mb-5 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                                    {confirmEntry.permissions.map((p) => {
                                        const token = permToken(p);
                                        const meta = permMeta(token);
                                        return (
                                            <div key={token} className="flex items-center gap-2.5 text-xs font-medium bg-slate-50 border border-slate-100 rounded-xl p-2.5 shadow-[inset_0_2px_4px_rgba(0,0,0,0.015)]">
                                                <span className={`w-2 h-2 rounded-full shrink-0 relative flex ${meta.risk === "high" ? "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.4)]" : meta.risk === "med" ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.4)]" : "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]"}`} />
                                                <span className="font-mono text-slate-650 text-[11px] font-semibold">{token}</span>
                                                <span className="text-slate-400 text-[10px] truncate ml-auto">{meta.label}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                                <p className="text-[10px] text-slate-400 mb-5 italic bg-blue-50/50 border border-blue-100/50 rounded-xl p-3 leading-relaxed">Nada se otorga automáticamente: tras activar el plugin, apruebas cada permiso en su panel.</p>
                            </>
                        )}
                        <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100">
                            <button onClick={() => setConfirmEntry(null)} className="px-5 py-2.5 text-xs font-extrabold uppercase tracking-widest text-slate-500 hover:text-slate-950 hover:bg-slate-100/80 rounded-xl transition-all">Cancelar</button>
                            <Button onClick={() => doInstall(confirmEntry)}><FaDownload className="mr-2 text-xs" /> Instalar</Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
