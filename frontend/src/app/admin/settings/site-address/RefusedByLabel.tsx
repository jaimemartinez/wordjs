import { refusedByKey, type RefusalSource } from "@/lib/siteAddress";

/**
 * Who refused a host in «Recently refused»: the public listener's edge, the backend's own gate, or each
 * of them (lab R2-X2-tag). Nothing when the backend did not say (an older version). Its own component so
 * a test can render it (review UX-2); the page renders it in every refused row.
 */
export function RefusedByLabel({ source, t }: { source: RefusalSource | null; t: (key: string) => string }) {
    const key = refusedByKey(source);
    if (!key) return null;
    return (
        <span className="ml-2 rounded-md bg-gray-100 px-1.5 py-0.5 font-sans text-[10px] font-bold uppercase tracking-wider text-gray-500" title={t("siteAddress.refusedBy.help")}>
            {t(key)}
        </span>
    );
}
