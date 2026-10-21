"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { plural } from "@/lib/i18n";
import { PageHeader, Button, Card } from "@/components/ui";

/**
 * Admin → Site Health: the installation's diagnostics (backend core/site-health, GET /health/site) — the
 * versions, folders and disk, database engine, mail and its DNS, HTTPS, reverse proxy, scheduled tasks and
 * plugin isolation — each in plain words with a link to the screen that fixes it. Read-only; runs again on
 * demand.
 */

type Status = "ok" | "warn" | "fail" | "info";
interface Check { id: string; group: string; status: Status; title: string; message: string; fix?: { href: string; label: string } }
interface Report { checks: Check[]; summary: Record<Status, number>; at: string; host: string }

const GROUPS = ["versions", "storage", "database", "mail", "security", "background"] as const;
const ICON: Record<Status, string> = { ok: "fa-circle-check text-emerald-500", warn: "fa-triangle-exclamation text-amber-500", fail: "fa-circle-xmark text-red-500", info: "fa-circle-info text-gray-400" };

export default function SiteHealthPage() {
    const { t } = useI18n();
    const [report, setReport] = useState<Report | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);

    const run = async () => {
        setRunning(true);
        setError(null);
        try { setReport(await apiGet<Report>("/health/site")); }
        catch (e: any) { setError(e?.message || t("siteHealth.failed")); }
        finally { setRunning(false); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { run(); }, []);

    const verdict = !report ? null : report.summary.fail ? "fail" : report.summary.warn ? "warn" : "ok";

    return (
        <div className="p-4 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full">
            <PageHeader title={t("siteHealth.title")} subtitle={t("siteHealth.subtitle")} icon="fa-heart-pulse"
                actions={<Button onClick={run} loading={running} icon="fa-rotate">{t("siteHealth.rerun")}</Button>} />
            <div className="max-w-4xl space-y-6">
                {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
                {verdict && (
                    <Card variant="default" padding="lg">
                        <div className="flex items-center gap-4" data-testid="site-health-verdict" data-verdict={verdict}>
                            <i className={`fa-solid ${ICON[verdict as Status]} text-3xl`} aria-hidden="true"></i>
                            <div>
                                <p className="font-bold text-gray-900">{t(`siteHealth.verdict.${verdict}`)}</p>
                                <p className="text-sm text-gray-500">{t("siteHealth.counts")
                                    .replace("{fail}", plural(t, "siteHealth.count.fail", report!.summary.fail).replace("{n}", String(report!.summary.fail)))
                                    .replace("{warn}", plural(t, "siteHealth.count.warn", report!.summary.warn).replace("{n}", String(report!.summary.warn)))
                                    .replace("{ok}", plural(t, "siteHealth.count.ok", report!.summary.ok).replace("{n}", String(report!.summary.ok)))}</p>
                            </div>
                        </div>
                    </Card>
                )}
                {report && GROUPS.map((g) => {
                    const items = report.checks.filter((c) => c.group === g);
                    if (!items.length) return null;
                    return (
                        <Card key={g} variant="default" padding="lg">
                            <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-2">{t(`siteHealth.group.${g}`)}</h2>
                            <ul className="divide-y divide-gray-100">
                                {items.map((c) => (
                                    <li key={c.id} data-check={c.id} data-status={c.status} className="flex items-start gap-3 py-4">
                                        <i className={`fa-solid ${ICON[c.status]} mt-0.5`} aria-hidden="true"></i>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-bold text-gray-900">{c.title}</p>
                                            <p className="text-sm text-gray-600 break-words">{c.message}</p>
                                            {c.fix && c.status !== "ok" && (
                                                <Link href={c.fix.href} className="mt-1 inline-flex items-center gap-2 text-sm font-bold text-blue-600 underline">
                                                    {t("siteHealth.fix").replace("{where}", c.fix.label)} <i className="fa-solid fa-arrow-right" aria-hidden="true"></i>
                                                </Link>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    );
                })}
                {report && <p className="text-xs text-gray-400">{t("siteHealth.checkedAt").replace("{at}", new Date(report.at).toLocaleString()).replace("{host}", report.host)}</p>}
            </div>
        </div>
    );
}
