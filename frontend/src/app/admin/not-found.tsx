"use client";

import Link from "next/link";
import { useI18n } from "@/contexts/I18nContext";
import { EmptyState } from "@/components/ui";

/** The admin's own 404: inside the panel (sidebar and all), in the admin's language. */
export default function AdminNotFound() {
    const { t } = useI18n();
    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto">
            <EmptyState
                icon="fa-compass"
                title={t("admin.notFound.title")}
                description={t("admin.notFound.body")}
                action={
                    <Link href="/admin" className="inline-flex items-center gap-2 min-h-11 px-5 rounded-xl bg-gray-900 text-white text-sm font-bold hover:bg-gray-800">
                        <i className="fa-solid fa-arrow-left" aria-hidden="true"></i>
                        {t("admin.notFound.back")}
                    </Link>
                }
            />
        </div>
    );
}
