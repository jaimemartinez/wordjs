import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PostContent from "@/components/public/PostContent";
import { getPostBySlug, getSettings, buildPostMetadata } from "@/lib/server-api";

interface RouteParams {
    slug: string;
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
    const { slug } = await params;
    const post = await getPostBySlug(slug);
    if (!post) return { title: "Not found", robots: { index: false } };
    const settings = await getSettings();
    return buildPostMetadata(post, {
        siteName: settings?.blogname,
        canonicalPath: `/${post.slug || post.id}`,
    });
}

export default async function SinglePostPage({ params }: { params: Promise<RouteParams> }) {
    const { slug } = await params;
    const [post, settings] = await Promise.all([getPostBySlug(slug), getSettings()]);
    if (!post) notFound();
    return <PostContent post={post} settings={settings} showComments />;
}
