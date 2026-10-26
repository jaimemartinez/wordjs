"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Button, Checkbox, Input, Radio, RadioGroup } from "@/components/ui";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import {
    formFromView,
    mediaStorageApi,
    progressPercent,
    type MediaStorageForm,
    type MediaStorageTestResult,
    type MediaStorageView,
} from "@/lib/mediaStorage";
import { useMfaStepUp, MfaStepUpFields } from "@/components/MfaStepUp";

/**
 * Settings → Media storage. Where public media is stored and served from: this server's disk (the
 * default) or an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Backblaze B2…) behind an optional
 * CDN. The credentials are write-only — the screen only ever learns whether a secret is set and its last
 * four characters. Moving the EXISTING library is a separate, explicit step (offload / restore), with its
 * progress shown here; the database keeps relative /uploads paths throughout.
 */

const card = "bg-white rounded-3xl md:rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 overflow-hidden";
const cardHead = "px-5 sm:px-8 py-5 sm:py-6 border-b border-gray-50 bg-gray-50/30";

const TEXT_FIELDS = [
    { key: "bucket", placeholder: "my-site-media" },
    { key: "region", placeholder: "us-east-1 · auto (R2)" },
    { key: "endpoint", placeholder: "https://<account>.r2.cloudflarestorage.com" },
    { key: "prefix", placeholder: "uploads" },
    { key: "publicUrl", placeholder: "https://cdn.example.com" },
] as const;

export default function MediaStoragePage() {
    const { t } = useI18n();
    const { confirm } = useModal();
    const { addToast } = useToast();
    const [view, setView] = useState<MediaStorageView | null>(null);
    const [form, setForm] = useState<MediaStorageForm | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [test, setTest] = useState<MediaStorageTestResult | null>(null);
    // Testing another endpoint, region or bucket with the SAVED secret: the server asks for your password.
    const testStepUp = useMfaStepUp();
    const [deleteLocal, setDeleteLocal] = useState(false);

    const load = useCallback(async (resetForm: boolean) => {
        try {
            const v = await mediaStorageApi.get();
            setView(v);
            if (resetForm) setForm(formFromView(v));
            setLoadError(null);
            return v;
        } catch (e: any) {
            setLoadError(e?.message || String(e));
            return null;
        }
    }, []);

    useEffect(() => { void load(true); }, [load]);

    // While a migration runs (here or from the CLI), refresh its progress every 2 s.
    const active = !!view && (view.running || view.migration?.status === "running");
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => { void load(false); }, 2000);
        return () => clearInterval(timer);
    }, [active, load]);

    if (loadError && !view) {
        return (
            <div className="p-8">
                <PageHeader title={t("mediaStorage.title")} subtitle={t("mediaStorage.subtitle")} />
                <p className="text-red-600" role="alert">{loadError}</p>
            </div>
        );
    }
    if (!view || !form) {
        return <div className="p-8 text-gray-500">{t("mediaStorage.loading")}</div>;
    }

    const set = <K extends keyof MediaStorageForm>(k: K, v: MediaStorageForm[K]) => setForm({ ...form, [k]: v });
    const fromEnv = (k: string) => view.sources?.[k] === "env";
    const s3 = form.driver === "s3";

    const save = async () => {
        setSaving(true);
        try {
            const v = await mediaStorageApi.save(form);
            setView(v);
            setForm(formFromView(v));
            addToast(t("mediaStorage.toast.saved"), "success");
        } catch (e: any) {
            addToast(e?.message || t("mediaStorage.toast.saveFailed"), "error");
        } finally {
            setSaving(false);
        }
    };

    const runTest = async () => {
        setTesting(true);
        setTest(null);
        try {
            setTest(await mediaStorageApi.test(form, testStepUp.payload()));
            testStepUp.reset();
        } catch (e: any) {
            if (testStepUp.absorb(e)) return;
            setTest({ ok: false, steps: [{ step: "write", ok: false, detail: e?.message || String(e) }] });
        } finally {
            setTesting(false);
        }
    };

    const migrate = async (direction: "offload" | "restore") => {
        const ok = await confirm(
            t(direction === "offload" ? "mediaStorage.migrate.offloadConfirm" : "mediaStorage.migrate.restoreConfirm"),
            t(direction === "offload" ? "mediaStorage.migrate.offload" : "mediaStorage.migrate.restore"),
            false
        );
        if (!ok) return;
        try {
            setView(await mediaStorageApi.migrate(direction, { deleteLocal: direction === "offload" && deleteLocal }));
        } catch (e: any) {
            addToast(e?.message || t("mediaStorage.toast.migrateFailed"), "error");
        }
    };

    const p = view.migration;
    const pct = progressPercent(p);
    const effectiveS3 = view.effective.driver === "s3";

    return (
        <div className="p-8 max-w-5xl mx-auto">
            <PageHeader title={t("mediaStorage.title")} subtitle={t("mediaStorage.subtitle")} />
            <p className="mb-6 text-sm">
                <Link href="/admin/settings" className="text-blue-600 hover:underline">← {t("mediaStorage.back")}</Link>
            </p>

            <div className="mb-8 rounded-3xl border-2 border-gray-50 bg-white px-6 py-5 shadow-xl shadow-gray-100/50" data-testid="media-storage-status">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-bold text-gray-900">{t("mediaStorage.status.label")}</span>
                    <span className={`rounded-full px-3 py-1 font-semibold ${effectiveS3 ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-700"}`}>
                        {effectiveS3 ? t("mediaStorage.driver.s3") : t("mediaStorage.driver.local")}
                    </span>
                    <span className="rounded-full bg-gray-100 px-3 py-1 font-semibold text-gray-700">{t(`mediaStorage.state.${view.state}`)}</span>
                </div>
                {view.effective.publicBase && (
                    <p className="mt-2 text-sm text-gray-500 break-all">{t("mediaStorage.status.base")} <code>{view.effective.publicBase}</code></p>
                )}
                {view.effective.incomplete && (
                    <p className="mt-2 text-sm text-amber-700" role="status">{t("mediaStorage.status.incomplete")} {view.effective.incomplete.join(", ")}</p>
                )}
                {view.sites && view.sites.length > 0 && (
                    <div className="mt-4 border-t border-gray-100 pt-4" data-testid="media-storage-sites">
                        <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">{t("mediaStorage.sites.title")}</p>
                        <ul className="space-y-1 text-sm">
                            {view.sites.map((s) => (
                                <li key={s.siteId} className="flex flex-wrap items-center gap-2" data-media-site={s.siteId}>
                                    <span className="font-semibold text-gray-700 break-all">{s.host || `#${s.siteId}`}</span>
                                    {s.state ? (
                                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">{t(`mediaStorage.state.${s.state}`)}</span>
                                    ) : (
                                        <span className="text-xs text-amber-700">{t("mediaStorage.sites.unreadable")}</span>
                                    )}
                                    {s.inBucket !== null && (
                                        <span className="text-xs text-gray-500">{t("mediaStorage.sites.inBucket").replace("{count}", String(s.inBucket))}</span>
                                    )}
                                    {s.migration?.status === "running" && (
                                        <span className="text-xs text-blue-600">{s.migration.processed}/{s.migration.total}</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                        <p className="mt-2 text-xs text-gray-500">{t("mediaStorage.sites.hint")}</p>
                    </div>
                )}
            </div>

            <div className={`${card} mb-8`}>
                <div className={cardHead}>
                    <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                        <i className="fa-solid fa-cloud-arrow-up text-blue-500" aria-hidden="true"></i> {t("mediaStorage.config.title")}
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">{t("mediaStorage.config.help")}</p>
                </div>
                <div className="p-8 space-y-6">
                    <fieldset>
                        <RadioGroup
                            label={t("mediaStorage.driver.label")}
                            name="driver"
                            orientation="horizontal"
                            value={form.driver}
                            onChange={(v) => set("driver", v as "local" | "s3")}
                            disabled={fromEnv("driver")}
                        >
                            {(["local", "s3"] as const).map((d) => (
                                <Radio key={d} value={d} label={t(`mediaStorage.driver.${d}`)} />
                            ))}
                        </RadioGroup>
                    </fieldset>

                    {s3 && (
                        <>
                            <div className="grid gap-6 md:grid-cols-2">
                                {TEXT_FIELDS.map((f) => (
                                    <Input
                                        key={f.key}
                                        label={t(`mediaStorage.field.${f.key}`) + (fromEnv(f.key) ? ` (${t("mediaStorage.fromEnv")})` : "")}
                                        value={form[f.key]}
                                        placeholder={f.placeholder}
                                        disabled={fromEnv(f.key)}
                                        onChange={(e) => set(f.key, e.target.value)}
                                        size="md"
                                    />
                                ))}
                                <Input
                                    label={t("mediaStorage.field.accessKeyId") + (fromEnv("accessKeyId") ? ` (${t("mediaStorage.fromEnv")})` : "")}
                                    value={form.accessKeyId}
                                    placeholder={view.accessKeyIdHint ? `${t("mediaStorage.stored")} ${view.accessKeyIdHint}` : ""}
                                    disabled={fromEnv("accessKeyId")}
                                    autoComplete="off"
                                    onChange={(e) => set("accessKeyId", e.target.value)}
                                    size="md"
                                />
                                <Input
                                    type="password"
                                    label={t("mediaStorage.field.secretAccessKey") + (fromEnv("secretAccessKey") ? ` (${t("mediaStorage.fromEnv")})` : "")}
                                    value={form.secretAccessKey}
                                    placeholder={view.secretAccessKeySet ? `${t("mediaStorage.stored")} ${view.secretAccessKeyHint || ""}` : ""}
                                    disabled={fromEnv("secretAccessKey")}
                                    autoComplete="new-password"
                                    onChange={(e) => set("secretAccessKey", e.target.value)}
                                    size="md"
                                />
                            </div>
                            {s3 && view.warnings && view.warnings.length > 0 && (
                                // Advice from the server about the SAVED values (never blocking), e.g. a public
                                // URL that repeats the key prefix or would be mixed content on this admin.
                                <ul className="space-y-1 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status" data-testid="media-storage-warnings">
                                    {view.warnings.map((w) => (
                                        <li key={w.code}>
                                            <i className="fa-solid fa-triangle-exclamation mr-2" aria-hidden="true"></i>
                                            {w.field === "publicUrl" && <strong>{t("mediaStorage.field.publicUrl")}: </strong>}{w.message}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <p className="text-xs text-gray-500">{t("mediaStorage.field.help")}</p>
                            <Checkbox label={t("mediaStorage.field.keepLocalCopy")} checked={form.keepLocalCopy} disabled={fromEnv("keepLocalCopy")} onChange={(e) => set("keepLocalCopy", e.target.checked)} />
                        </>
                    )}

                    <div className="flex flex-wrap gap-3">
                        <Button onClick={save} loading={saving} icon="fa-floppy-disk">{t("mediaStorage.save")}</Button>
                        {s3 && (
                            <Button variant="secondary" onClick={runTest} loading={testing} icon="fa-plug-circle-check">{t("mediaStorage.test")}</Button>
                        )}
                    </div>
                    {s3 && <MfaStepUpFields stepUp={testStepUp} withCode={false} />}

                    {test && (
                        <ul className="space-y-1 text-sm" aria-live="polite" data-testid="media-storage-test">
                            {test.steps.map((s) => (
                                <li key={s.step} className={s.ok ? "text-green-700" : "text-red-700"}>
                                    <i className={`fa-solid ${s.ok ? "fa-circle-check" : "fa-circle-xmark"} mr-2`} aria-hidden="true"></i>
                                    <strong>{t(`mediaStorage.testStep.${s.step}`)}</strong> — <span className="break-all">{s.detail}</span>
                                </li>
                            ))}
                            <li className={`font-bold ${test.ok ? "text-green-700" : "text-red-700"}`}>{test.ok ? t("mediaStorage.test.ok") : t("mediaStorage.test.failed")}</li>
                            {test.steps.some((s) => s.step === "public" && !s.ok) && (
                                <li className="text-amber-800">{t("mediaStorage.test.publicHint")}</li>
                            )}
                        </ul>
                    )}
                </div>
            </div>

            <div className={card}>
                <div className={cardHead}>
                    <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                        <i className="fa-solid fa-right-left text-blue-500" aria-hidden="true"></i> {t("mediaStorage.migrate.title")}
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">{t("mediaStorage.migrate.help")}</p>
                </div>
                <div className="p-8 space-y-6">
                    {p && (
                        <div data-testid="media-storage-progress">
                            <div className="flex justify-between text-sm text-gray-700 mb-2">
                                <span>{t(`mediaStorage.migrate.${p.direction}`)} · {t(`mediaStorage.progress.${p.status}`)}</span>
                                <span>{p.processed}/{p.total} · {p.moved} {t("mediaStorage.progress.moved")} · {p.skipped} {t("mediaStorage.progress.skipped")} · {p.failed} {t("mediaStorage.progress.failed")}</span>
                            </div>
                            <div className="h-2 rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                                <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
                            </div>
                            {p.failures?.length > 0 && (
                                <ul className="mt-3 text-xs text-red-700 space-y-1">
                                    {p.failures.slice(0, 10).map((f) => <li key={f.id}>#{f.id}: {f.error}</li>)}
                                </ul>
                            )}
                        </div>
                    )}
                    {!effectiveS3 && <p className="text-sm text-gray-500">{t("mediaStorage.migrate.needsS3")}</p>}
                    <Checkbox label={t("mediaStorage.migrate.deleteLocal")} checked={deleteLocal} disabled={!effectiveS3 || view.running} onChange={(e) => setDeleteLocal(e.target.checked)} />
                    <div className="flex flex-wrap gap-3">
                        <Button onClick={() => migrate("offload")} disabled={!effectiveS3 || view.running} icon="fa-cloud-arrow-up">{t("mediaStorage.migrate.offload")}</Button>
                        <Button variant="secondary" onClick={() => migrate("restore")} disabled={!effectiveS3 || view.running} icon="fa-hard-drive">{t("mediaStorage.migrate.restore")}</Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
