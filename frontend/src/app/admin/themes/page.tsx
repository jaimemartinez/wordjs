"use client";

import { useEffect, useState, useRef } from "react";
import { themesApi, themesMarketplaceApi, settingsApi, Theme, ThemeMarketplaceEntry } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, EmptyState } from "@/components/ui";

export default function ThemesPage() {
    const { t } = useI18n();
    const [themes, setThemes] = useState<Theme[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Theme health. The `template` option can name a theme that is no longer on disk (deleted or
    // renamed outside the app). The public site degrades correctly — it falls back to the framework's
    // own :root tokens — but that degradation used to be invisible here: the list simply showed no
    // "Active" badge and the site "looked wrong". The backend reports it as a derived boolean in the
    // public settings payload (active_theme_missing); this banner is its consumer.
    const [missingSlug, setMissingSlug] = useState<string | null>(null);

    // Theme marketplace (same catalog system as plugins, with its OWN configurable sources)
    const [tab, setTab] = useState<"installed" | "market">("installed");
    const [market, setMarket] = useState<ThemeMarketplaceEntry[] | null>(null);
    const [marketLoading, setMarketLoading] = useState(false);
    const [installingId, setInstallingId] = useState<string | null>(null);
    const [showSources, setShowSources] = useState(false);
    const [srcList, setSrcList] = useState<string[]>([]);
    const [defaultSrc, setDefaultSrc] = useState("");
    const [newSrc, setNewSrc] = useState("");
    const [savingSrc, setSavingSrc] = useState(false);

    const { confirm } = useModal();

    useEffect(() => {
        loadThemes();
    }, []);

    useEffect(() => {
        if (tab === "market" && market === null) loadMarket();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab]);

    const loadMarket = async (refresh = false) => {
        setMarketLoading(true);
        try {
            const data = await themesMarketplaceApi.catalog(refresh);
            setMarket(data.themes || []);
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || t('themes.market.loadError') });
            setMarket([]);
        } finally {
            setMarketLoading(false);
        }
    };

    const openSources = async () => {
        setShowSources((v) => !v);
        try {
            const s = await themesMarketplaceApi.getSources();
            setDefaultSrc(s.default);
            setSrcList(s.usingDefault ? [s.default] : s.configured);
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || t('themes.sources.loadError') });
        }
    };

    const addSource = () => {
        const v = newSrc.trim().replace(/\/+$/, "");
        if (!v) return;
        if (!/^https:\/\//i.test(v) && !/^http:\/\/localhost/i.test(v)) {
            setMessage({ type: "error", text: t('themes.sources.invalidUrl') });
            return;
        }
        setNewSrc("");
        if (!srcList.includes(v)) setSrcList((l) => [...l, v]);
    };

    const saveSources = async () => {
        setSavingSrc(true);
        try {
            const res = await themesMarketplaceApi.setSources(srcList);
            setSrcList(res.configured);
            setMessage({ type: "success", text: srcList.length ? t('themes.sources.saved') : t('themes.sources.savedEmpty') });
            setShowSources(false);
            await loadMarket(true);
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || t('themes.sources.saveError') });
        } finally {
            setSavingSrc(false);
        }
    };

    const resetSources = async () => {
        setSavingSrc(true);
        try {
            const res = await themesMarketplaceApi.resetSources();
            setSrcList([res.default]);
            setMessage({ type: "success", text: t('themes.sources.reset') });
            setShowSources(false);
            await loadMarket(true);
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || t('themes.sources.resetError') });
        } finally {
            setSavingSrc(false);
        }
    };

    const installFromMarket = async (entry: ThemeMarketplaceEntry) => {
        setInstallingId(entry.id);
        setMessage(null);
        try {
            const res = await themesMarketplaceApi.install(entry.id);
            setMessage({ type: "success", text: res.message || `${t('themes.market.installedPrefix')}"${entry.name}"${t('themes.market.installedSuffix')}` });
            await loadThemes();
            await loadMarket(true);
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || t('themes.market.installError') });
        } finally {
            setInstallingId(null);
        }
    };

    const loadThemes = async () => {
        try {
            const data = await themesApi.list();
            setThemes(data);
        } catch (error) {
            console.error("Failed to load themes:", error);
        } finally {
            setLoading(false);
        }
        // Re-read after every list refresh: activating or restoring a theme is exactly what CLEARS
        // this, so the banner has to be able to go away on its own. Never blocks the list.
        try {
            const health = await settingsApi.getPublicHealth();
            setMissingSlug(health.active_theme_missing === true ? (health.template || "?") : null);
        } catch {
            /* health is advisory — a failed read must not hide the themes */
        }
    };

    const activateTheme = async (slug: string) => {
        try {
            await themesApi.activate(slug);
            loadThemes();
            setMessage({ type: "success", text: t('themes.activateSuccess') });
        } catch (error) {
            console.error("Failed to activate theme:", error);
            setMessage({ type: "error", text: t('themes.activateError') });
        }
    };

    const handleDownload = (slug: string) => {
        themesApi.download(slug);
    };

    const handleDelete = async (slug: string) => {
        if (!await confirm(t('themes.deleteConfirm'), t('themes.deleteTitle'), true)) return;

        try {
            await themesApi.delete(slug);
            setMessage({ type: "success", text: t('themes.deleteSuccess') });
            loadThemes();
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || t('themes.deleteError') });
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        setUploadProgress(0);
        setMessage(null);

        try {
            const result = await themesApi.upload(file, (progress) => {
                setUploadProgress(progress);
            });
            setMessage({ type: "success", text: result.message });
            loadThemes();
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || t('themes.uploadError') });
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50">
            {/* Header Section */}
            <div className="max-w-7xl mx-auto">
                <PageHeader
                    title={t('themes.title')}
                    subtitle={t('themes.subtitle')}
                    actions={
                        <>
                            <a
                                href="/admin/themes/customize"
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 font-medium text-sm transition-colors"
                            >
                                <i className="fa-solid fa-sliders"></i> {t('themes.customize')}
                            </a>
                            <Button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading}
                                loading={uploading}
                                icon={uploading ? undefined : "fa-plus-circle"}
                            >
                                {uploading ? `${Math.round(uploadProgress)}%` : t('themes.install')}
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".zip"
                                onChange={handleUpload}
                                className="hidden"
                            />
                        </>
                    }
                />

                {/* Tabs: Instalados | Marketplace */}
                <div className="max-w-7xl mx-auto mb-8 flex gap-2">
                    <button
                        type="button"
                        onClick={() => setTab("installed")}
                        className={`px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 ${tab === "installed" ? "bg-gray-900 text-white" : "bg-white text-gray-500 hover:bg-gray-100 border border-gray-200"}`}
                    >
                        <i className="fa-solid fa-palette"></i> {t('themes.tab.installed')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab("market")}
                        className={`px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 ${tab === "market" ? "bg-gray-900 text-white" : "bg-white text-gray-500 hover:bg-gray-100 border border-gray-200"}`}
                    >
                        <i className="fa-solid fa-store"></i> {t('themes.tab.market')}
                    </button>
                    {tab === "market" && (
                        <div className="ml-auto flex gap-2">
                            <button
                                type="button"
                                onClick={openSources}
                                title={t('themes.sources.title')}
                                className={`px-4 py-3 rounded-2xl border transition-all ${showSources ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-500 hover:bg-gray-100 border-gray-200"}`}
                            >
                                <i className="fa-solid fa-gear"></i>
                            </button>
                            <button
                                type="button"
                                onClick={() => loadMarket(true)}
                                disabled={marketLoading}
                                title={t('themes.market.refresh')}
                                className="px-4 py-3 rounded-2xl bg-white text-gray-500 hover:bg-gray-100 border border-gray-200 transition-all disabled:opacity-50"
                            >
                                <i className={`fa-solid fa-rotate ${marketLoading ? "fa-spin" : ""}`}></i>
                            </button>
                        </div>
                    )}
                </div>

                {/* Theme sources manager — OWN list, independent from the plugin marketplace */}
                {tab === "market" && showSources && (
                    <div className="max-w-7xl mx-auto mb-8 bg-white rounded-3xl border border-gray-200 p-6 animate-in fade-in slide-in-from-top-4 duration-300">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="font-black text-gray-900 flex items-center gap-2"><i className="fa-solid fa-gear text-gray-400"></i> {t('themes.sources.title')}</h3>
                            <button type="button" onClick={() => setShowSources(false)} className="text-xs font-bold text-gray-400 hover:text-gray-700 uppercase tracking-widest">{t('common.close')}</button>
                        </div>
                        <p className="text-xs text-gray-400 mb-4">
                            {t('themes.sources.description')}
                        </p>
                        <div className="space-y-2 mb-4">
                            {srcList.map((u, i) => (
                                <div key={u} className="flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
                                    <span className="text-[10px] font-mono text-gray-400 w-4 shrink-0">{i + 1}</span>
                                    <span className="flex-1 font-mono text-[11px] text-gray-700 truncate" title={u}>{u}</span>
                                    {u === defaultSrc && <span className="text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100 shrink-0">default</span>}
                                    <button type="button" onClick={() => setSrcList((l) => l.filter((x) => x !== u))} aria-label={t('themes.sources.remove')} className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-400 hover:text-rose-500 hover:border-rose-200 transition-colors shrink-0"><i className="fa-solid fa-trash-can text-[10px]"></i></button>
                                </div>
                            ))}
                            {srcList.length === 0 && <div className="text-[11px] text-gray-400 italic px-1">{t('themes.sources.empty')}</div>}
                        </div>
                        <div className="flex items-center gap-2 mb-4">
                            <input
                                type="text"
                                value={newSrc}
                                onChange={(e) => setNewSrc(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSource(); } }}
                                placeholder={t('themes.sources.placeholder')}
                                className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl outline-none font-mono text-xs focus:border-gray-400 transition-colors"
                            />
                            <Button onClick={addSource}><i className="fa-solid fa-plus mr-1.5 text-[10px]"></i> {t('common.add')}</Button>
                        </div>
                        <div className="flex items-center justify-between gap-2 pt-3 border-t border-gray-100">
                            <button type="button" onClick={resetSources} disabled={savingSrc} className="text-[11px] font-bold text-gray-500 hover:text-gray-800 disabled:opacity-50 uppercase tracking-widest">{t('themes.sources.resetDefault')}</button>
                            <Button onClick={saveSources} disabled={savingSrc}>{savingSrc ? t('common.saving') : t('themes.sources.save')}</Button>
                        </div>
                    </div>
                )}

                {missingSlug && (
                    <div className="max-w-7xl mx-auto mb-8 p-5 rounded-2xl flex items-start gap-4 bg-amber-50 border border-amber-200 text-amber-800">
                        <i className="fa-solid fa-triangle-exclamation text-xl mt-0.5"></i>
                        <div>
                            <p className="font-bold">{t('themes.missingActiveTitle')} <code className="font-mono bg-amber-100 px-1.5 py-0.5 rounded">{missingSlug}</code></p>
                            <p className="text-sm mt-1">{t('themes.missingActiveHelp')}</p>
                        </div>
                    </div>
                )}

                {message && (
                    <div className={`
                    max-w-7xl mx-auto mb-8 p-5 rounded-2xl flex items-center gap-4 animate-in fade-in slide-in-from-top-4 duration-300
                    ${message.type === "success"
                            ? "bg-emerald-50 border border-emerald-100 text-emerald-700"
                            : "bg-rose-50 border border-rose-100 text-rose-700"
                        }
                `}>
                        <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'} text-xl`}></i>
                        <p className="font-bold">{message.text}</p>
                    </div>
                )}

                {tab === "installed" && (
                <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-10 pb-20">
                    {loading ? (
                        Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="bg-gray-100 rounded-[32px] h-[420px] animate-pulse"></div>
                        ))
                    ) : themes.length === 0 ? (
                        <div className="col-span-full">
                            <EmptyState
                                icon="fa-palette"
                                title={t('themes.emptyTitle')}
                                description={t('themes.emptyDescription')}
                            />
                        </div>
                    ) : (
                        themes.map((theme, index) => (
                            <div
                                key={theme.slug}
                                className={`
                                group bg-white rounded-[40px] border transition-all duration-500 relative flex flex-col h-full overflow-hidden
                                animate-in fade-in slide-in-from-bottom-8 fill-mode-both
                                ${theme.active
                                        ? "border-blue-500/50 shadow-[0_25px_60px_-15px_rgba(59,130,246,0.15)] ring-1 ring-blue-500/20"
                                        : "border-gray-200 shadow-[0_15px_40px_-15px_rgba(0,0,0,0.04)] hover:shadow-[0_30px_70px_-15px_rgba(0,0,0,0.08)] hover:-translate-y-2"
                                    }
                            `}
                                style={{ animationDelay: `${index * 100}ms` }}
                            >
                                {/* Theme Preview */}
                                <div className="aspect-[4/3] overflow-hidden relative">
                                    {theme.screenshot ? (
                                        <img
                                            src={theme.screenshot}
                                            alt={theme.name}
                                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                                        />
                                    ) : (
                                        <div className="w-full h-full bg-gradient-to-br from-indigo-50 via-white to-blue-50 flex items-center justify-center relative">
                                            <div className="absolute inset-0 opacity-[0.03] pattern-grid-lg"></div>
                                            <div className="w-20 h-20 rounded-3xl bg-white shadow-xl flex items-center justify-center text-3xl text-blue-500 relative z-10 border border-blue-50 hover:rotate-12 transition-transform duration-500">
                                                <i className="fa-solid fa-palette"></i>
                                            </div>
                                        </div>
                                    )}

                                    {theme.active && (
                                        <div className="absolute top-6 right-6">
                                            <div className="bg-blue-600 text-white px-5 py-2.5 rounded-full text-xs font-black uppercase tracking-widest flex items-center gap-2 shadow-lg shadow-blue-500/50 border border-blue-400/30 backdrop-blur-md">
                                                <span className="flex h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>
                                                {t('themes.active')}
                                            </div>
                                        </div>
                                    )}

                                    {/* Overlay Gradient */}
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                                </div>

                                {/* Theme Info */}
                                <div className="p-8 flex-1 flex flex-col">
                                    <div className="mb-4">
                                        <div className="flex items-center justify-between gap-4 mb-2">
                                            <h3 className="text-2xl font-black text-gray-900 group-hover:text-blue-600 transition-colors truncate">
                                                {theme.name}
                                            </h3>
                                            <span className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] bg-gray-50 px-2 py-1 rounded-md">
                                                v{theme.version}
                                            </span>
                                        </div>
                                        <p className="text-gray-500 font-medium text-sm leading-relaxed line-clamp-2">
                                            {theme.description || t('themes.defaultDescription')}
                                        </p>
                                    </div>

                                    <div className="mt-auto pt-6 flex flex-col gap-3">
                                        <div className="flex items-center justify-between text-xs font-bold text-gray-400 mb-2">
                                            <span>{t('themes.by')} <span className="text-gray-900">{theme.author || 'WordJS'}</span></span>
                                        </div>

                                        {!theme.active ? (
                                            <button
                                                onClick={() => activateTheme(theme.slug)}
                                                className="w-full bg-gray-900 text-white font-black py-4 rounded-2xl transition-all duration-300 hover:bg-blue-600 hover:shadow-xl hover:shadow-blue-500/30 active:scale-95 flex items-center justify-center gap-2"
                                            >
                                                {t('themes.activate')}
                                                <i className="fa-solid fa-arrow-right text-xs opacity-50 group-hover:translate-x-1 transition-transform"></i>
                                            </button>
                                        ) : (
                                            <button
                                                className="w-full bg-blue-50 text-blue-600 font-black py-4 rounded-2xl flex items-center justify-center gap-2 border border-blue-100 cursor-default"
                                            >
                                                {t('themes.inUse')}
                                            </button>
                                        )}

                                        {!theme.active && (
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => handleDownload(theme.slug)}
                                                    className="flex-1 bg-gray-50 text-gray-600 font-bold py-3 rounded-xl hover:bg-gray-100 transition-all flex items-center justify-center gap-2 text-sm"
                                                    title={t('themes.downloadZip')}
                                                >
                                                    <i className="fa-solid fa-download text-xs opacity-50"></i>
                                                    {t('themes.download')}
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(theme.slug)}
                                                    className="aspect-square bg-rose-50 text-rose-500 font-bold p-3 rounded-xl hover:bg-rose-500 hover:text-white transition-all flex items-center justify-center"
                                                    title={t('themes.deleteTitle')}
                                                >
                                                    <i className="fa-solid fa-trash-can text-sm"></i>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
                )}

                {/* ============================== THEME MARKETPLACE ============================== */}
                {tab === "market" && (
                <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-10 pb-20">
                    {marketLoading && market === null ? (
                        Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="bg-gray-100 rounded-[32px] h-[320px] animate-pulse"></div>
                        ))
                    ) : !market || market.length === 0 ? (
                        <div className="col-span-full">
                            <EmptyState
                                icon="fa-store-slash"
                                title={t('themes.market.emptyTitle')}
                                description={t('themes.market.emptyDescription')}
                            />
                        </div>
                    ) : (
                        market.map((entry, index) => (
                            <div
                                key={entry.id}
                                className="group bg-white rounded-[40px] border border-gray-200 shadow-[0_15px_40px_-15px_rgba(0,0,0,0.04)] hover:shadow-[0_30px_70px_-15px_rgba(0,0,0,0.08)] hover:-translate-y-2 transition-all duration-500 relative flex flex-col h-full overflow-hidden animate-in fade-in slide-in-from-bottom-8 fill-mode-both"
                                style={{ animationDelay: `${index * 80}ms` }}
                            >
                                <div className="aspect-[4/3] overflow-hidden relative">
                                    <div className="w-full h-full bg-gradient-to-br from-indigo-50 via-white to-blue-50 flex items-center justify-center relative">
                                        <div className="w-20 h-20 rounded-3xl bg-white shadow-xl flex items-center justify-center text-3xl text-blue-500 relative z-10 border border-blue-50 group-hover:rotate-12 transition-transform duration-500">
                                            <i className="fa-solid fa-palette"></i>
                                        </div>
                                    </div>
                                    {entry.active && (
                                        <div className="absolute top-6 right-6 bg-blue-600 text-white px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest shadow-lg shadow-blue-500/50">
                                            {t('themes.active')}
                                        </div>
                                    )}
                                    {!entry.active && entry.installed && (
                                        <div className="absolute top-6 right-6 bg-emerald-500 text-white px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest shadow-lg shadow-emerald-500/40">
                                            {t('themes.installedBadge')}
                                        </div>
                                    )}
                                </div>
                                <div className="p-8 flex-1 flex flex-col">
                                    <div className="mb-4">
                                        <div className="flex items-center justify-between gap-4 mb-2">
                                            <h3 className="text-2xl font-black text-gray-900 group-hover:text-blue-600 transition-colors truncate">{entry.name}</h3>
                                            <span className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] bg-gray-50 px-2 py-1 rounded-md">v{entry.version}</span>
                                        </div>
                                        <p className="text-gray-500 font-medium text-sm leading-relaxed line-clamp-2">{entry.description || t('themes.defaultDescription')}</p>
                                    </div>
                                    <div className="mt-auto pt-6 flex flex-col gap-3">
                                        <div className="flex items-center justify-between text-xs font-bold text-gray-400 mb-2">
                                            <span>{t('themes.by')} <span className="text-gray-900">{entry.author || 'WordJS'}</span></span>
                                            {entry.updateAvailable && (
                                                <span className="text-amber-600 bg-amber-50 border border-amber-100 px-2 py-1 rounded-md uppercase tracking-wider text-[10px]">v{entry.installedVersion} instalada</span>
                                            )}
                                        </div>
                                        {entry.installed ? (
                                            <button
                                                type="button"
                                                onClick={() => setTab("installed")}
                                                className="w-full bg-gray-50 text-gray-600 font-black py-4 rounded-2xl border border-gray-100 hover:bg-gray-100 transition-all"
                                            >
                                                {t('themes.viewInstalled')}
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={installingId !== null}
                                                onClick={() => installFromMarket(entry)}
                                                className="w-full bg-gray-900 text-white font-black py-4 rounded-2xl transition-all duration-300 hover:bg-blue-600 hover:shadow-xl hover:shadow-blue-500/30 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50"
                                            >
                                                {installingId === entry.id ? (
                                                    <><i className="fa-solid fa-circle-notch fa-spin"></i> {t('themes.installing')}</>
                                                ) : (
                                                    <><i className="fa-solid fa-download text-xs opacity-60"></i> {t('themes.installAction')}</>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
                )}
            </div>
        </div>
    );
}

