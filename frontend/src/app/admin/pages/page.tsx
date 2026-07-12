"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/contexts/I18nContext";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Button } from "@/components/ui";
import ContentTable from "@/components/ContentTable";

export default function PagesPage() {
    const { t } = useI18n();
    const { can, isLoading } = useAuth();
    const router = useRouter();

    // Access gate: block subscribers (no edit_posts) from reaching the pages list by direct URL.
    const allowed = can('edit_posts');
    useEffect(() => {
        if (!isLoading && !allowed) router.replace('/admin/account');
    }, [isLoading, allowed, router]);
    if (!allowed) return null;

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t('pages.title')}
                subtitle={t('pages.subtitle')}
                actions={
                    <Link href="/admin/pages/new">
                        <Button icon="fa-plus">{t('pages.new')}</Button>
                    </Link>
                }
            />
            <ContentTable
                type="page"
                basePath="/admin/pages"
                emptyIcon="fa-file-lines"
                emptyTitle={t('pages.not.found')}
                newLabel={t('pages.new')}
            />
        </div>
    );
}
