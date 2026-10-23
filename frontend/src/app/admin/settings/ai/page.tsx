"use client";
/**
 * Ajustes → IA: el proveedor que usan las sugerencias del editor y los plugins con «ai:use»
 * (backend routes/ai.ts, core/ai-provider.ts).
 *
 * La clave es de SOLO ESCRITURA: el backend nunca la devuelve (solo `hasKey` y los cuatro últimos
 * caracteres), así que el campo nace vacío y vacío significa «conservar la guardada».
 */
import { useEffect, useState } from "react";
import { aiApi, AiProviderId, AiSettings } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, Card, Checkbox, Input, Select } from "@/components/ui";
import { resetAiStatusCache } from "@/components/AiSuggest";

export default function AiSettingsPage() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [settings, setSettings] = useState<AiSettings | null>(null);
    const [provider, setProvider] = useState<AiProviderId>("");
    const [model, setModel] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [clearKey, setClearKey] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

    const apply = (s: AiSettings) => {
        setSettings(s);
        setProvider(s.provider);
        setModel(s.model);
        setBaseUrl(s.baseUrl);
        setApiKey("");
        setClearKey(false);
    };

    useEffect(() => {
        aiApi.getSettings().then(apply).catch((e: any) => addToast(e?.message || t("ai.settings.loadFailed"), "error"));
    }, []);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setTestResult(null);
        try {
            const s = await aiApi.saveSettings({
                provider,
                model: provider ? model : "",
                baseUrl: provider === "openai-compatible" ? baseUrl : "",
                apiKey: apiKey.trim() || undefined,
                clearKey: clearKey || undefined,
            });
            apply(s);
            resetAiStatusCache();
            addToast(t("ai.settings.saved"), "success");
        } catch (err: any) {
            addToast(err?.message || t("ai.settings.saveFailed"), "error");
        } finally {
            setSaving(false);
        }
    };

    const test = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const r = await aiApi.test();
            setTestResult({ ok: true, text: t("ai.settings.testOk").replace("{model}", r.model).replace("{ms}", String(r.ms)) });
        } catch (err: any) {
            setTestResult({ ok: false, text: err?.message || "Error" });
        } finally {
            setTesting(false);
        }
    };

    const label = "block text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2";

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader title={t("ai.settings.title")} subtitle={t("ai.settings.subtitle")} icon="fa-brain" />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <Card variant="default" padding="lg" className="lg:col-span-2">
                    {!settings ? (
                        <div className="p-10 text-center text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</div>
                    ) : (
                        <form onSubmit={save} className="space-y-6">
                            <div>
                                <label className={label}>{t("ai.settings.provider")}</label>
                                <Select
                                    value={provider}
                                    onChange={(v) => {
                                        const next = v as AiProviderId;
                                        setProvider(next);
                                        if (next === "anthropic" && !settings.anthropicModels.includes(model)) setModel(settings.anthropicModels[0]);
                                        if (next === "openai-compatible" && settings.anthropicModels.includes(model)) setModel("");
                                    }}
                                    options={[
                                        { value: "", label: t("ai.settings.providerOff") },
                                        { value: "anthropic", label: t("ai.settings.providerAnthropic") },
                                        { value: "openai-compatible", label: t("ai.settings.providerOpenAi") },
                                    ]}
                                />
                            </div>

                            {provider === "anthropic" && (
                                <div>
                                    <label className={label}>{t("ai.settings.model")}</label>
                                    <Select value={model} onChange={setModel} options={settings.anthropicModels.map((m) => ({ value: m, label: m }))} />
                                    <p className="text-[11px] text-gray-400 mt-1.5">{t("ai.settings.modelHelpAnthropic")}</p>
                                </div>
                            )}

                            {provider === "openai-compatible" && (
                                <>
                                    <div>
                                        <Input label={t("ai.settings.baseUrl")} icon="fa-link" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
                                        <p className="text-[11px] text-gray-400 mt-1.5">{t("ai.settings.baseUrlHelp")}</p>
                                    </div>
                                    <Input label={t("ai.settings.model")} icon="fa-microchip" value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("ai.settings.modelPlaceholder")} />
                                </>
                            )}

                            {provider && (
                                <div>
                                    <Input
                                        label={t("ai.settings.apiKey")}
                                        icon="fa-key"
                                        type="password"
                                        autoComplete="off"
                                        value={apiKey}
                                        onChange={(e) => setApiKey(e.target.value)}
                                        placeholder={settings.hasKey ? settings.keyHint : ""}
                                    />
                                    <p className="text-[11px] text-gray-400 mt-1.5">
                                        {settings.hasKey ? t("ai.settings.apiKeyStored").replace("{hint}", settings.keyHint) : t("ai.settings.apiKeyNone")}
                                    </p>
                                    {settings.hasKey && (
                                        <Checkbox containerClassName="mt-2" label={t("ai.settings.clearKey")} checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
                                    )}
                                </div>
                            )}

                            <div className="flex flex-wrap gap-3 items-center">
                                <Button type="submit" icon="fa-floppy-disk" loading={saving}>{t("ai.settings.save")}</Button>
                                {settings.provider && (
                                    <Button type="button" variant="secondary" icon="fa-plug-circle-check" loading={testing} onClick={test}>{t("ai.settings.test")}</Button>
                                )}
                            </div>
                            {testResult && (
                                <p role="status" className={`text-sm font-medium ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>
                                    <i className={`fa-solid ${testResult.ok ? "fa-circle-check" : "fa-circle-exclamation"} mr-1.5`}></i>{testResult.text}
                                </p>
                            )}
                        </form>
                    )}
                </Card>

                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                        <i className="fa-solid fa-circle-info text-violet-500"></i>{t("ai.settings.usesTitle")}
                    </h2>
                    <ul className="space-y-3 text-sm text-gray-600 leading-relaxed">
                        <li><i className="fa-solid fa-pen-nib text-gray-300 mr-2"></i>{t("ai.settings.usesEditor")}</li>
                        <li><i className="fa-solid fa-puzzle-piece text-gray-300 mr-2"></i>{t("ai.settings.usesPlugins")}</li>
                    </ul>
                </Card>
            </div>
        </div>
    );
}
