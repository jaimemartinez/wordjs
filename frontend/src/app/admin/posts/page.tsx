"use client";

import Link from "next/link";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button } from "@/components/ui";
import ContentTable from "@/components/ContentTable";

export default function PostsPage() {
    const { t } = useI18n();

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t('posts.title')}
                subtitle={t('posts.subtitle')}
                actions={
                    <Link href="/admin/posts/new">
                        <Button icon="fa-plus">{t('posts.new')}</Button>
                    </Link>
                }
            />
            <ContentTable
                type="post"
                basePath="/admin/posts"
                emptyIcon="fa-file-pen"
                emptyTitle={t('posts.not.found')}
                newLabel={t('posts.new')}
            />
        </div>
    );
}
